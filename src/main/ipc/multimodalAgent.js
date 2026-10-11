/**
 * 多模态模型支持 + 多 Agent 协同工作模块
 *
 * 功能：
 * 1. 多模态消息处理：图片 → base64 data URL，构建 OpenAI 兼容多模态 content 数组
 * 2. 多 Agent 编排器：支持顺序管道（sequential）、并行（parallel）、辩论（debate）三种协同模式
 * 3. 子 Agent 执行：复用 aiOps 的 provider 配置、工具调用循环、消息消毒
 *
 * 依赖：aiOps._internal 导出的内部函数
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

let AIOps = null;
let _internal = null;

/**
 * 初始化模块，注入 aiOps 依赖
 * @param {object} aiOpsInstance - require('./aiOps') 的实例
 */
function init(aiOpsInstance) {
  AIOps = aiOpsInstance;
  _internal = aiOpsInstance._internal || {};
  console.log('[MultimodalAgent] 模块已初始化，可用内部接口:', Object.keys(_internal).join(','));
}

// ============================================================
// 第一部分：多模态消息处理
// ============================================================

/**
 * 图片文件转 base64 data URL
 * 自动压缩：宽度超过 maxWidth 时缩放，体积超过 1.2MB 时转 JPEG
 * @param {string} imagePath - 图片绝对路径
 * @param {number} maxWidth - 最大宽度，默认 1440
 * @returns {{success:boolean, dataUrl?:string, error?:string, info?:string}}
 */
function imageToDataUrl(imagePath, maxWidth = 1440) {
  if (!imagePath || !fs.existsSync(imagePath)) {
    return { success: false, error: '图片文件不存在: ' + (imagePath || '(空)') };
  }
  try {
    const { nativeImage } = require('electron');
    const img = nativeImage.createFromPath(imagePath);
    const size = img.getSize();
    if (!size.width || !size.height) {
      return { success: false, error: '无法解析图片尺寸: ' + imagePath };
    }
    const resized = size.width > maxWidth ? img.resize({ width: maxWidth }) : img;
    const pngBuf = resized.toPNG();
    let dataUrl, info;
    if (pngBuf.length <= 1.2 * 1024 * 1024) {
      dataUrl = 'data:image/png;base64,' + pngBuf.toString('base64');
      info = resized.getSize().width + 'x' + resized.getSize().height + ' PNG';
    } else {
      const jpg = resized.toJPEG(82);
      dataUrl = 'data:image/jpeg;base64,' + jpg.toString('base64');
      info = resized.getSize().width + 'x' + resized.getSize().height + ' JPEG';
    }
    return { success: true, dataUrl, info };
  } catch (e) {
    // 回退：直接读原始文件
    try {
      const ext = path.extname(imagePath).toLowerCase();
      const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
        : ext === '.webp' ? 'image/webp'
        : ext === '.gif' ? 'image/gif'
        : 'image/png';
      const dataUrl = 'data:' + mime + ';base64,' + fs.readFileSync(imagePath).toString('base64');
      return { success: true, dataUrl, info: '原图 ' + ext };
    } catch (e2) {
      return { success: false, error: '读取图片失败: ' + e2.message };
    }
  }
}

/**
 * 构建多模态用户消息
 * @param {string} text - 用户文本
 * @param {string[]} imagePaths - 图片绝对路径数组
 * @returns {{success:boolean, message?:object, error?:string, images?:string[]}}
 */
function buildMultimodalUserMessage(text, imagePaths) {
  const content = [];
  if (text && typeof text === 'string' && text.trim()) {
    content.push({ type: 'text', text: text.trim() });
  }
  const converted = [];
  const paths = Array.isArray(imagePaths) ? imagePaths : (imagePaths ? [imagePaths] : []);
  for (const p of paths) {
    if (!p) continue;
    // 已经是 data URL 或 http URL，直接用
    if (typeof p === 'string' && (p.startsWith('data:') || p.startsWith('http://') || p.startsWith('https://'))) {
      content.push({ type: 'image_url', image_url: { url: p } });
      converted.push(p.substring(0, 60) + '...');
      continue;
    }
    const r = imageToDataUrl(p);
    if (!r.success) {
      return { success: false, error: '图片转换失败 [' + p + ']: ' + r.error };
    }
    content.push({ type: 'image_url', image_url: { url: r.dataUrl } });
    converted.push(r.info || path.basename(p));
  }
  if (content.length === 0) {
    return { success: false, error: '消息内容为空（无文本也无图片）' };
  }
  return { success: true, message: { role: 'user', content }, images: converted };
}

/**
 * 检测 provider/模型是否支持视觉（多模态）—— 同步关键词快筛
 * 基于模型名关键词匹配 + 显式配置
 * @param {object} provider - aiOps provider 对象
 * @returns {{supported:boolean, reason:string, visionModel?:string, definitive?:boolean}}
 */
function detectVisionCapability(provider) {
  if (!provider) return { supported: false, reason: '无 provider', definitive: true };
  const visionModel = provider.visionModel || null;
  const hay = ((provider.name || '') + ' ' + (provider.model || '') + ' ' + (provider.apiUrl || '')).toLowerCase();
  // 明确配置了 visionModel 视为支持
  if (visionModel) return { supported: true, reason: 'provider.visionModel 已配置', visionModel, definitive: true };
  // 模型名关键词（覆盖主流视觉模型家族；未命中的走 probeVisionCapability 实测）
  const visionKeywords = [
    'vl', 'vision', '视觉', '看图', '多模态',
    'gpt-4o', 'gpt-4-turbo', 'gpt-4.1', 'gpt-5', 'o1', 'o3', 'o4-mini',
    'claude-3', 'claude-4',
    'gemini',
    'qwen-vl', 'qwen2-vl', 'qwen3-vl', 'qvq',
    'glm-4v', 'glm-5v', 'glm-4.1v', 'glm-4.5v',
    'deepseek-vl', 'janus',
    'hunyuan-vision', 'hunyuan-turbos-vision', '混元视觉',
    'doubao-1.5-vision', 'doubao-vision', 'doubao-1.6', 'doubao-seed',
    'kimi-latest', 'moonshot-vision', 'moonshot-v1-8b-vision', 'moonshot-v1-32k-vision', 'moonshot-v1-128k-vision',
    'ernie-4.5', 'ernie-vl', '文心视觉',
    'step-1v', 'step-1o', 'step-3', 'stepfun',
    'yi-vision', 'yi-vl',
    'grok-vision', 'grok-2-vision', 'grok-3-vision', 'grok-4',
    'pixtral', 'phi-3.5-vision', 'phi-4-multimodal',
    'minicpm-v', 'llava', 'cogvlm', 'internvl', 'moondream', 'paligemma'
  ];
  const hit = visionKeywords.find(k => hay.includes(k));
  if (hit) return { supported: true, reason: '模型名匹配关键词: ' + hit, definitive: true };
  return { supported: false, reason: '模型名未命中视觉关键词，且未配置 visionModel', definitive: false };
}

// ============================================================
// 视觉能力实测探测（关键词未命中时的兜底）
// ============================================================
// 关键词永远列不全（如腾讯混元的文本/视觉模型命名差异很大），所以未命中时
// 直接向该 provider 发一个「1x1 像素图片 + 微 max_tokens」的实测请求：
// 接口接受图片 → 支持视觉；明确报图片相关错误 → 不支持；其他错误（鉴权/
// 404/网络/超时）→ 不下结论，放行给真实请求，由上游报真实错误。
// 结果按 providerId|model|apiUrl 缓存 10 分钟，避免每次发消息都探测。

// 1x1 透明 PNG（约 100B base64），探测成本可忽略
const VISION_PROBE_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const VISION_PROBE_TTL = 10 * 60 * 1000;
const visionProbeCache = new Map();     // key -> { t, result }
const visionProbeInflight = new Map();  // key -> Promise（防并发重复探测）

// 上游明确拒绝图片的报错特征（用于把 4xx 分类为「确定不支持」）
const VISION_REJECT_RE = /image|图片|vision|多模态|multimodal|modality|image_url|输入模态/i;

/**
 * 实测探测 provider 是否接受图片输入。
 * ⚠️ 不能走 callProviderAPI —— sanitizeOutgoingMessages 会把数组型 content 拍平丢图
 * （与 analyzeImageWithVision 同样的约束），这里裸发请求。
 * @returns {Promise<{supported:boolean, definitive:boolean, reason:string}>}
 */
function probeVisionCapability(provider) {
  return new Promise((resolve) => {
    const fallbackAllow = {
      supported: true, definitive: false,
      reason: '关键词未命中且实测未得出结论，放行由实际请求判定（若模型不支持会在上游报错中体现）'
    };
    try {
      if (!provider || !provider.apiUrl || !provider.model) return resolve(fallbackAllow);

      const isOllama = (provider.type || '') === 'ollama';
      let url, bodyObj;
      if (isOllama) {
        // Ollama 原生 /api/chat：图片放 images 数组（base64 裸码，不带 data: 前缀）
        url = new URL(provider.apiUrl.replace(/\/$/, '') + '/api/chat');
        bodyObj = {
          model: provider.model,
          messages: [{ role: 'user', content: '回复ok', images: [VISION_PROBE_PNG.split(',')[1]] }],
          stream: false,
          keep_alive: 0,
          options: { num_predict: 8 }
        };
      } else {
        // OpenAI 兼容端点：content 数组 + image_url
        url = new URL(provider.apiUrl);
        bodyObj = {
          model: provider.model,
          stream: false,
          max_tokens: 8,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: '回复ok' },
              { type: 'image_url', image_url: { url: VISION_PROBE_PNG } }
            ]
          }]
        };
      }
      const body = JSON.stringify(bodyObj);
      const client = url.protocol === 'https:' ? https : http;
      const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
      if (provider.apiKey) headers['Authorization'] = 'Bearer ' + provider.apiKey;

      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };

      const req = client.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname.replace(/\/$/, '') + (url.search || ''),
        method: 'POST',
        headers
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          const sc = res.statusCode;
          if (sc >= 200 && sc < 300) {
            // 接口接受了图片输入 → 支持视觉（内容为空也算通过，探测只看是否收图）
            done({ supported: true, definitive: true, reason: '实测探测通过：接口接受了图片输入' });
            return;
          }
          const errText = String(data || '').slice(0, 500);
          // 4xx 且报错与图片/模态相关 → 确定不支持
          if (sc >= 400 && sc < 500 && VISION_REJECT_RE.test(errText)) {
            done({ supported: false, definitive: true, reason: '实测探测：上游明确拒绝图片输入（' + simplifyProbeError(sc, errText) + '）' });
            return;
          }
          // 鉴权/404/限流/网络等与视觉无关的错误 → 不下结论
          done(fallbackAllow);
        });
      });
      req.on('error', () => done(fallbackAllow));
      // 8s 足够（探测请求只有 1x1 图 + 8 token；此前 20s 会让首次发送多等十几秒）
      req.setTimeout(8000, () => { try { req.destroy(); } catch (e) {} done(fallbackAllow); });
      try {
        req.write(body);
        req.end();
      } catch (e) {
        done(fallbackAllow);
      }
    } catch (e) {
      resolve({ supported: true, definitive: false, reason: '探测异常（' + e.message + '），放行由实际请求判定' });
    }
  });
}

function simplifyProbeError(statusCode, errText) {
  try {
    const parsed = JSON.parse(errText);
    const msg = parsed.error?.message || parsed.error || parsed.message || errText;
    return ('HTTP ' + statusCode + ' ' + (typeof msg === 'string' ? msg : JSON.stringify(msg))).slice(0, 160);
  } catch (e) {
    return ('HTTP ' + statusCode + ' ' + errText).slice(0, 160);
  }
}

/**
 * 视觉能力综合判定（异步）：关键词命中直接放行；未命中走实测探测（带缓存）。
 * @returns {Promise<{supported:boolean, reason:string, visionModel?:string, definitive:boolean, cached?:boolean}>}
 */
async function resolveVisionCapability(provider) {
  const kw = detectVisionCapability(provider);
  if (kw.supported) return kw; // definitive: true
  if (!provider) return { ...kw, definitive: true };

  const cacheKey = [provider.id || '', provider.model || '', provider.apiUrl || ''].join('|');
  const cached = visionProbeCache.get(cacheKey);
  if (cached && Date.now() - cached.t < VISION_PROBE_TTL) {
    return { ...cached.result, cached: true };
  }
  // 防并发：同一 provider 的探测中直接复用在途 Promise
  let inflight = visionProbeInflight.get(cacheKey);
  if (!inflight) {
    inflight = probeVisionCapability(provider).then((result) => {
      visionProbeCache.set(cacheKey, { t: Date.now(), result });
      visionProbeInflight.delete(cacheKey);
      return result;
    }).catch(() => {
      visionProbeInflight.delete(cacheKey);
      return { supported: true, definitive: false, reason: '探测失败，放行由实际请求判定' };
    });
    visionProbeInflight.set(cacheKey, inflight);
  }
  return inflight;
}

/**
 * 视觉能力快速判定（同步，不发网络请求）：关键词/visionModel 命中或缓存命中时给出结论；
 * 都未命中时返回 definitive=false（调用方应放行真实请求，并后台预热探测缓存）。
 * 用于发送路径上零等待——阻塞式探测（最多 8s）是「发送多模态异常缓慢」的元凶之一。
 */
function getCachedVisionCapability(provider) {
  const kw = detectVisionCapability(provider);
  if (kw.supported || kw.definitive) return kw;
  if (!provider) return { ...kw, definitive: true };
  const cacheKey = [provider.id || '', provider.model || '', provider.apiUrl || ''].join('|');
  const cached = visionProbeCache.get(cacheKey);
  if (cached && Date.now() - cached.t < VISION_PROBE_TTL) {
    return { ...cached.result, cached: true };
  }
  return kw; // definitive: false，未定论
}

// ============================================================
// 第二部分：子 Agent 执行引擎
// ============================================================

/**
 * 执行单个子 Agent（带工具调用的 ReAct 循环）
 * 与 aiOps.agentChat 类似但是轻量版，用于多 Agent 协同中的子任务
 *
 * @param {object} config
 * @param {string} config.id - Agent ID
 * @param {string} config.name - Agent 名称
 * @param {string} config.systemPrompt - 系统提示词
 * @param {object} config.provider - aiOps provider 对象
 * @param {object[]} config.tools - 可用工具列表（AGENT_TOOLS 子集）
 * @param {number} config.temperature - 温度
 * @param {number} config.maxTokens - 最大 token
 * @param {number} config.maxIterations - 最大迭代次数
 * @param {string} config.workdir - 工作目录
 * @param {string} config.conversationId - 会话 ID
 * @param {boolean} config.thinkMode - 是否启用思考模式
 * @param {object[]} config.messages - 输入消息（可含多模态 content）
 * @param {function} config.onEvent - 事件回调 (eventType, data)
 * @returns {Promise<{success:boolean, content:string, reasoning?:string, iterations?:number, error?:string}>}
 */
async function runSubAgent(config) {
  const {
    id, name, systemPrompt, provider, tools,
    temperature = 0.7, maxTokens = 4096, maxIterations = 6,
    workdir, conversationId = 'sub-agent', thinkMode = false,
    messages = [], onEvent
  } = config;

  if (!provider) return { success: false, error: '[' + name + '] 未指定 provider' };
  if (!_internal.callProviderAPIWithTools) return { success: false, error: 'aiOps._internal.callProviderAPIWithTools 不可用' };

  const emit = (type, data) => { if (onEvent) onEvent(type, { agentId: id, agentName: name, ...data }); };

  // 确保本地 provider 就绪
  if (_internal.prepareLocalProvider) {
    const notReady = await _internal.prepareLocalProvider(provider, (msg) => {
      emit('status', { text: msg });
    });
    if (notReady) return { success: false, error: '[' + name + '] ' + (notReady.error || notReady.message || '本地模型未就绪') };
  }

  const fullMessages = [{ role: 'system', content: systemPrompt || '你是一个有帮助的助手。' }, ...messages];
  const activeTools = tools && tools.length ? tools : (_internal.AGENT_TOOLS || []);
  const ctx = { conversationId };

  let accumulated = '';
  let iteration = 0;

  while (iteration < maxIterations) {
    iteration++;
    emit('iteration', { iteration, maxIterations });

    const result = await _internal.callProviderAPIWithTools(
      provider, fullMessages, temperature, maxTokens, activeTools, thinkMode,
      (delta) => {
        if (delta.reasoning) emit('reasoning', { text: delta.reasoning, iteration });
        if (delta.content) { accumulated += delta.content; emit('content', { text: delta.content, iteration }); }
        if (delta.toolCall) emit('tool-call-start', { tool: delta.toolCall, iteration });
      }
    );

    if (!result.success) {
      return { success: false, error: '[' + name + '] ' + (result.error || 'AI 调用失败'), iterations: iteration };
    }

    // 有工具调用 → 执行工具并继续循环
    if (result.toolCalls && result.toolCalls.length > 0) {
      const assistantMsg = {
        role: 'assistant',
        content: result.content || '',
        tool_calls: result.toolCalls
      };
      fullMessages.push(assistantMsg);

      for (const tc of result.toolCalls) {
        const toolName = tc.function?.name;
        let toolArgs = tc.function?.arguments || {};
        if (typeof toolArgs === 'string') {
          try { toolArgs = JSON.parse(toolArgs); } catch (e) { toolArgs = {}; }
        }
        emit('tool-execute', { tool: toolName, args: toolArgs, iteration });
        let toolResult;
        try {
          if (_internal.executeTool) {
            toolResult = await _internal.executeTool(toolName, toolArgs, workdir, ctx);
          } else {
            toolResult = { success: false, error: 'executeTool 不可用' };
          }
        } catch (e) {
          toolResult = { success: false, error: '工具执行异常: ' + e.message };
        }
        emit('tool-result', { tool: toolName, result: toolResult, iteration });
        fullMessages.push({
          role: 'tool',
          tool_call_id: tc.id || ('call_' + toolName),
          name: toolName,
          content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult)
        });
      }
      continue; // 下一轮迭代
    }

    // 无工具调用 → 最终回答
    if (result.content) accumulated = result.content;
    emit('done', { content: accumulated, iteration, reasoning: result.reasoning });
    return { success: true, content: accumulated, reasoning: result.reasoning, iterations: iteration };
  }

  return { success: true, content: accumulated, iterations: iteration, truncated: true };
}

// ============================================================
// 第三部分：多 Agent 编排器
// ============================================================

/**
 * 顺序管道模式：Agent A 的输出作为 Agent B 的输入，依次执行
 * 适用于：编写→审查→整合、搜索→分析→报告等流水线任务
 *
 * @param {object[]} agents - Agent 配置数组，按执行顺序排列
 * @param {object} input - 初始输入 { text, images?, messages? }
 * @param {object} options
 * @param {function} options.onEvent - 全局事件回调
 * @returns {Promise<{success:boolean, finalOutput:string, results:array, error?:string}>}
 */
async function runSequential(agents, input, options = {}) {
  const { onEvent } = options;
  const results = [];
  let currentText = input.text || '';
  let baseMessages = input.messages || [];

  // 如果有图片，第一条消息用多模态格式
  if (input.images && input.images.length > 0) {
    const mm = buildMultimodalUserMessage(currentText, input.images);
    if (!mm.success) return { success: false, error: mm.error, results };
    baseMessages = [mm.message];
  } else if (currentText) {
    baseMessages = [{ role: 'user', content: currentText }];
  }

  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i];
    const label = '[' + (i + 1) + '/' + agents.length + '] ' + (agent.name || agent.id);
    if (onEvent) onEvent('pipeline-stage', { stage: i + 1, total: agents.length, agentId: agent.id, agentName: agent.name, input: currentText.substring(0, 200) });

    // 构建该 Agent 的输入消息：如果是第一个，用原始输入；否则用前一个 Agent 的输出
    const agentMessages = i === 0
      ? baseMessages
      : [{ role: 'user', content: currentText }];

    const result = await runSubAgent({
      ...agent,
      messages: agentMessages,
      onEvent: (type, data) => { if (onEvent) onEvent(type, { stage: i + 1, ...data }); }
    });

    results.push({ agentId: agent.id, agentName: agent.name, ...result });

    if (!result.success) {
      return { success: false, error: label + ' 执行失败: ' + result.error, results };
    }
    currentText = result.content;
    if (onEvent) onEvent('pipeline-stage-done', { stage: i + 1, agentId: agent.id, output: result.content.substring(0, 200) });
  }

  return { success: true, finalOutput: currentText, results };
}

/**
 * 并行模式：多个 Agent 同时处理同一输入，结果汇总后可选交给整合 Agent
 * 适用于：多视角分析、多方案生成、投票决策
 *
 * @param {object[]} agents - Agent 配置数组（并行执行）
 * @param {object} input - 输入 { text, images? }
 * @param {object} options
 * @param {object} options.aggregator - 可选的整合 Agent 配置（汇总所有结果后给出最终答案）
 * @param {function} options.onEvent - 全局事件回调
 * @returns {Promise<{success:boolean, finalOutput:string, results:array, error?:string}>}
 */
async function runParallel(agents, input, options = {}) {
  const { aggregator, onEvent } = options;

  // 构建共享输入消息
  let sharedMessages;
  if (input.images && input.images.length > 0) {
    const mm = buildMultimodalUserMessage(input.text || '', input.images);
    if (!mm.success) return { success: false, error: mm.error, results: [] };
    sharedMessages = [mm.message];
  } else {
    sharedMessages = [{ role: 'user', content: input.text || '' }];
  }

  if (onEvent) onEvent('parallel-start', { count: agents.length });

  // 并行执行所有 Agent
  const promises = agents.map((agent, idx) =>
    runSubAgent({
      ...agent,
      messages: JSON.parse(JSON.stringify(sharedMessages)),
      onEvent: (type, data) => { if (onEvent) onEvent(type, { parallelIndex: idx, ...data }); }
    }).then(r => ({ agentId: agent.id, agentName: agent.name, index: idx, ...r }))
      .catch(e => ({ agentId: agent.id, agentName: agent.name, index: idx, success: false, error: e.message }))
  );

  const results = await Promise.all(promises);

  if (onEvent) onEvent('parallel-done', { count: results.length, successes: results.filter(r => r.success).length });

  // 没有整合 Agent → 直接拼接所有结果
  if (!aggregator) {
    const finalOutput = results
      .filter(r => r.success)
      .map(r => '### ' + (r.agentName || r.agentId) + '\n' + r.content)
      .join('\n\n');
    return { success: results.some(r => r.success), finalOutput, results };
  }

  // 有整合 Agent → 把所有结果交给它汇总
  const aggregatedInput = results.map((r, i) => {
    const header = '【方案 ' + (i + 1) + '：' + (r.agentName || r.agentId) + '】';
    return r.success ? header + '\n' + r.content : header + '\n（执行失败：' + r.error + '）';
  }).join('\n\n---\n\n');

  const aggMessages = [{
    role: 'user',
    content: '以下是多个 Agent 对同一问题的独立回答，请综合分析、去重补全，给出最终答案：\n\n' + aggregatedInput + '\n\n原始问题：' + (input.text || '')
  }];

  if (onEvent) onEvent('aggregator-start', { agentId: aggregator.id, agentName: aggregator.name });

  const aggResult = await runSubAgent({
    ...aggregator,
    messages: aggMessages,
    onEvent: (type, data) => { if (onEvent) onEvent(type, { isAggregator: true, ...data }); }
  });

  return {
    success: aggResult.success,
    finalOutput: aggResult.content || '',
    results,
    aggregatorResult: aggResult,
    error: aggResult.success ? undefined : aggResult.error
  };
}

/**
 * 辩论模式：多个 Agent 轮流发表观点，最后由裁判总结
 * 适用于：决策讨论、方案评审、利弊分析
 *
 * @param {object[]} agents - 参与辩论的 Agent（每个有自己的立场）
 * @param {object} input - 辩论主题 { text, images? }
 * @param {object} options
 * @param {object} options.judge - 裁判 Agent 配置（负责总结）
 * @param {number} options.rounds - 辩论轮数，默认 2
 * @param {function} options.onEvent - 全局事件回调
 * @returns {Promise<{success:boolean, finalOutput:string, debateLog:array, results:array, error?:string}>}
 */
async function runDebate(agents, input, options = {}) {
  const { judge, rounds = 2, onEvent } = options;
  const debateLog = [];
  const results = [];

  // 初始立场陈述
  let historyText = '辩论主题：' + (input.text || '') + '\n\n';
  let sharedMessages;
  if (input.images && input.images.length > 0) {
    const mm = buildMultimodalUserMessage(input.text || '请针对以下图片内容发表你的观点', input.images);
    if (!mm.success) return { success: false, error: mm.error, results: [] };
    sharedMessages = [mm.message];
  } else {
    sharedMessages = [{ role: 'user', content: input.text || '' }];
  }

  for (let round = 1; round <= rounds; round++) {
    if (onEvent) onEvent('debate-round', { round, total: rounds });

    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i];
      // 每个 Agent 能看到之前的辩论历史
      const contextMsg = round === 1 && i === 0
        ? sharedMessages
        : [{ role: 'user', content: historyText + '\n\n请针对以上讨论，发表你的观点（' + (agent.stance || '中立') + '立场）：' }];

      if (onEvent) onEvent('debate-speaker', { round, agentId: agent.id, agentName: agent.name });

      const result = await runSubAgent({
        ...agent,
        messages: contextMsg,
        onEvent: (type, data) => { if (onEvent) onEvent(type, { round, debateIndex: i, ...data }); }
      });

      results.push({ round, agentId: agent.id, agentName: agent.name, ...result });
      const speech = result.success ? result.content : '（发言失败：' + result.error + '）';
      debateLog.push({ round, agentId: agent.id, agentName: agent.name, content: speech });
      historyText += '\n\n【' + (agent.name || agent.id) + '（第' + round + '轮）】\n' + speech;
    }
  }

  // 裁判总结
  if (judge) {
    if (onEvent) onEvent('debate-judge-start', { agentId: judge.id, agentName: judge.name });
    const judgeMessages = [{
      role: 'user',
      content: '以下是一场关于「' + (input.text || '').substring(0, 100) + '」的辩论记录，请你作为裁判，综合各方观点，给出公正的总结和最终结论：\n\n' + historyText
    }];
    const judgeResult = await runSubAgent({
      ...judge,
      messages: judgeMessages,
      onEvent: (type, data) => { if (onEvent) onEvent(type, { isJudge: true, ...data }); }
    });
    return {
      success: judgeResult.success,
      finalOutput: judgeResult.content || '',
      debateLog,
      results,
      judgeResult,
      error: judgeResult.success ? undefined : judgeResult.error
    };
  }

  // 无裁判 → 返回完整辩论记录
  return { success: true, finalOutput: historyText, debateLog, results };
}

/**
 * 统一编排入口
 * @param {object} config
 * @param {string} config.mode - 'sequential' | 'parallel' | 'debate'
 * @param {object[]} config.agents - Agent 配置数组
 * @param {object} config.input - 输入 { text, images? }
 * @param {object} config.options - 模式特定选项
 * @param {function} config.onEvent - 事件回调
 * @returns {Promise<object>}
 */
async function orchestrate(config) {
  const { mode, agents, input, options = {}, onEvent } = config;
  if (!Array.isArray(agents) || agents.length === 0) {
    return { success: false, error: 'agents 数组为空' };
  }
  // 校验每个 Agent 都有 provider
  for (const a of agents) {
    if (!a.provider) {
      // 尝试用 providerId 解析
      if (a.providerId && _internal.findProvider) {
        a.provider = _internal.findProvider(a.providerId);
      }
      if (!a.provider) return { success: false, error: 'Agent [' + (a.name || a.id) + '] 未指定有效 provider' };
    }
    // 解析角色
    if (a.roleId && _internal.getAgentRoleById) {
      const role = _internal.getAgentRoleById(a.roleId);
      if (role) {
        if (!a.systemPrompt) a.systemPrompt = role.systemPrompt;
        if (!a.tools && role.tools) {
          const allTools = _internal.AGENT_TOOLS || [];
          a.tools = allTools.filter(t => role.tools.includes(t.function.name));
        }
        if (a.temperature === undefined && role.temperature !== undefined) a.temperature = role.temperature;
      }
    }
  }
  // 解析 options 中的 aggregator/judge 的 provider
  for (const key of ['aggregator', 'judge']) {
    const special = options[key];
    if (special && !special.provider) {
      if (special.providerId && _internal.findProvider) special.provider = _internal.findProvider(special.providerId);
      if (special.roleId && _internal.getAgentRoleById) {
        const role = _internal.getAgentRoleById(special.roleId);
        if (role && !special.systemPrompt) special.systemPrompt = role.systemPrompt;
      }
    }
  }

  if (onEvent) onEvent('orchestrate-start', { mode, agentCount: agents.length });

  switch (mode) {
    case 'sequential':
      return runSequential(agents, input, { onEvent, ...options });
    case 'parallel':
      return runParallel(agents, input, { onEvent, ...options });
    case 'debate':
      return runDebate(agents, input, { onEvent, ...options });
    default:
      return { success: false, error: '未知协同模式: ' + mode + '（支持 sequential / parallel / debate）' };
  }
}

// ============================================================
// 第四部分：预设协同方案
// ============================================================

/**
 * 获取内置的多 Agent 协同预设方案
 * @returns {object[]} 预设列表
 */
function getPresets() {
  return [
    {
      id: 'code-review',
      name: '代码审查流水线',
      description: '编写者生成代码 → 审查者找问题 → 整合者输出最终版本',
      mode: 'sequential',
      agents: [
        { id: 'coder', name: '编写者', systemPrompt: '你是资深程序员，请根据需求编写高质量、可运行的代码。直接输出代码，不要过多解释。' },
        { id: 'reviewer', name: '审查者', systemPrompt: '你是严格的代码审查专家。请审查以下代码，找出 bug、安全漏洞、性能问题和代码规范问题。按严重程度列出问题，并给出修复建议。' },
        { id: 'integrator', name: '整合者', systemPrompt: '你是技术负责人。根据审查意见，修复代码中的问题，输出最终的高质量代码版本。保留原代码的正确部分，只修改有问题的地方。' }
      ]
    },
    {
      id: 'research-report',
      name: '研究报告流水线',
      description: '搜索者收集资料 → 分析者提炼观点 → 报告者撰写成文',
      mode: 'sequential',
      agents: [
        { id: 'searcher', name: '搜索者', systemPrompt: '你是研究助理。请围绕主题收集关键信息、数据和事实，列出要点和来源线索。' },
        { id: 'analyst', name: '分析者', systemPrompt: '你是行业分析师。根据以下收集到的信息，进行深度分析，提炼核心观点、趋势和洞察。' },
        { id: 'writer', name: '报告者', systemPrompt: '你是技术写作者。根据分析结果，撰写一篇结构清晰、逻辑严谨的研究报告。包含摘要、正文、结论。' }
      ]
    },
    {
      id: 'multi-perspective',
      name: '多视角并行分析',
      description: '多个专家从不同角度同时分析，最后由整合者汇总',
      mode: 'parallel',
      agents: [
        { id: 'tech', name: '技术视角', systemPrompt: '你是技术专家。请从技术可行性、架构设计、实现难度的角度分析以下问题。' },
        { id: 'business', name: '商业视角', systemPrompt: '你是商业分析师。请从市场需求、商业模式、盈利潜力、竞争格局的角度分析以下问题。' },
        { id: 'risk', name: '风险视角', systemPrompt: '你是风险评估专家。请从法律合规、安全风险、技术债务、失败可能性的角度分析以下问题。' }
      ],
      hasAggregator: true
    },
    {
      id: 'debate-decision',
      name: '辩论决策',
      description: '正反双方辩论，裁判给出最终结论',
      mode: 'debate',
      agents: [
        { id: 'pro', name: '正方', stance: '支持', systemPrompt: '你是正方辩手。请全力论证以下观点/方案的优势和可行性，用数据和逻辑支撑你的论点。' },
        { id: 'con', name: '反方', stance: '反对', systemPrompt: '你是反方辩手。请全力指出以下观点/方案的问题、风险和不可行之处，用数据和逻辑支撑你的论点。' }
      ],
      hasJudge: true,
      rounds: 2
    },
    {
      id: 'creative-writing',
      name: '创意写作流水线',
      description: '策划者定大纲 → 写作者初稿 → 润色者精修',
      mode: 'sequential',
      agents: [
        { id: 'planner', name: '策划者', systemPrompt: '你是创意策划。请根据主题拟定写作大纲、核心观点和结构安排。' },
        { id: 'drafter', name: '写作者', systemPrompt: '请根据以下大纲撰写完整的初稿，内容充实、表达流畅。' },
        { id: 'polisher', name: '润色者', systemPrompt: '你是文字编辑。请对以下初稿进行润色：优化语言表达、修正语法错误、提升文采，保持原意不变。' }
      ]
    }
  ];
}

/**
 * 根据预设 ID 和 provider 构建可执行的编排配置
 * @param {string} presetId - 预设 ID
 * @param {object} provider - 所有 Agent 共用的 provider
 * @param {object} overrides - 覆盖配置 { input, options, agentOverrides? }
 * @returns {{success:boolean, config?:object, error?:string}}
 */
function buildPresetConfig(presetId, provider, overrides = {}) {
  const preset = getPresets().find(p => p.id === presetId);
  if (!preset) return { success: false, error: '未找到预设: ' + presetId };
  if (!provider) return { success: false, error: '未指定 provider' };

  const agents = preset.agents.map(a => ({
    ...a,
    provider,
    temperature: a.temperature || 0.7,
    maxTokens: a.maxTokens || 4096,
    maxIterations: a.maxIterations || 6,
    workdir: overrides.workdir,
    conversationId: 'preset-' + presetId + '-' + a.id,
    ...(overrides.agentOverrides && overrides.agentOverrides[a.id] ? overrides.agentOverrides[a.id] : {})
  }));

  const options = { ...overrides.options };
  if (preset.hasAggregator && !options.aggregator) {
    options.aggregator = {
      id: 'aggregator', name: '整合者', provider,
      systemPrompt: '你是整合专家。请综合以下多个视角的分析，去重补全，给出全面、平衡的最终结论。',
      temperature: 0.5, maxTokens: 4096, maxIterations: 4
    };
  }
  if (preset.hasJudge && !options.judge) {
    options.judge = {
      id: 'judge', name: '裁判', provider,
      systemPrompt: '你是公正的裁判。请综合正反双方的论点，客观评价各方优劣，给出最终结论和建议。',
      temperature: 0.5, maxTokens: 4096, maxIterations: 4
    };
  }
  if (preset.rounds && !options.rounds) options.rounds = preset.rounds;

  return {
    success: true,
    config: {
      mode: preset.mode,
      agents,
      input: overrides.input || { text: '' },
      options
    }
  };
}

// ============================================================
// 第五部分：多模态对话（单 Agent，支持图片输入）
// ============================================================

/**
 * 多模态对话：支持图片输入的 AI 对话（单 Agent，带工具调用）
 * 这是 aiOps.agentChat 的多模态增强版
 *
 * @param {object} params
 * @param {object[]} params.messages - 对话历史（最后一条可含图片）
 * @param {string[]} params.images - 本轮附加的图片路径
 * @param {string} params.providerId - provider ID
 * @param {string} params.roleId - 角色 ID
 * @param {string} params.systemPrompt - 自定义系统提示词
 * @param {number} params.temperature
 * @param {number} params.maxTokens
 * @param {boolean} params.thinkMode
 * @param {string[]} params.enabledTools
 * @param {string} params.workdir
 * @param {string} params.conversationId
 * @param {function} broadcastFn - 事件广播
 * @returns {Promise<object>}
 */
async function multimodalChat(params, broadcastFn) {
  const {
    messages = [], images = [], providerId, roleId,
    systemPrompt: customSystemPrompt, temperature, maxTokens,
    thinkMode = false, enabledTools, workdir, conversationId = 'multimodal'
  } = params;

  const provider = _internal.findProvider ? _internal.findProvider(providerId) : null;
  if (!provider) return { success: false, error: '未找到 AI 提供商配置' };

  // 检测视觉能力：**零阻塞**。同步用关键词/缓存判定，只在「确定不支持」时拦截；
  // 未定论时放行真实请求（真实请求本身就是最权威的判定），并后台预热探测缓存，
  // 供下次发送前快速拦截。此前这里 await 探测（最多 8s），是发送缓慢的元凶。
  if (images.length > 0) {
    const vision = getCachedVisionCapability(provider);
    if (!vision.supported && vision.definitive) {
      return {
        success: false,
        error: '当前模型不支持视觉输入。' + vision.reason + '。请更换支持视觉的模型（如 gpt-4o、qwen-vl-max、glm-4v 等），或在 provider 配置中设置 visionModel。'
      };
    }
    if (!vision.definitive) {
      resolveVisionCapability(provider).catch(() => {}); // 后台预热，不 await
    }
  }

  // 构建系统提示词
  let finalSystemPrompt = customSystemPrompt || (_internal.AGENT_SYSTEM_PROMPT || '你是有帮助的助手。');
  if (roleId && _internal.getAgentRoleById) {
    const role = _internal.getAgentRoleById(roleId);
    if (role) finalSystemPrompt = customSystemPrompt || role.systemPrompt || finalSystemPrompt;
  }
  if (images.length > 0) {
    finalSystemPrompt += '\n\n## 多模态输入说明\n用户可能附带图片，请结合图片内容和文字进行回答。如果图片中有代码、图表、文字等信息，请仔细识别。\n请始终用中文进行思考与回复（代码、标识符、命令本身保持原样）。';
  }
  if (workdir) {
    finalSystemPrompt += '\n\n## 当前项目工作目录\n- 工作目录：' + workdir + '\n- 所有相对路径基于此目录解析。';
  }

  // 处理消息历史：归一化 + 最后一条附加图片
  const { normalizeAgentMessages } = require('./agentToolUtils');
  const normalized = normalizeAgentMessages(messages);
  // 如果有图片，把最后一条 user 消息转成多模态格式
  if (images.length > 0 && normalized.length > 0) {
    const lastUserIdx = -1;
    // 找到最后一条 user 消息
    let idx = -1;
    for (let i = normalized.length - 1; i >= 0; i--) {
      if (normalized[i].role === 'user') { idx = i; break; }
    }
    if (idx >= 0) {
      const lastText = typeof normalized[idx].content === 'string' ? normalized[idx].content : '';
      const mm = buildMultimodalUserMessage(lastText, images);
      if (mm.success) normalized[idx] = mm.message;
    }
  }

  const fullMessages = [{ role: 'system', content: finalSystemPrompt }, ...normalized];

  // 工具过滤
  const allTools = _internal.AGENT_TOOLS || [];
  let activeTools = allTools;
  if (Array.isArray(enabledTools) && enabledTools.length > 0) {
    activeTools = allTools.filter(t => enabledTools.includes(t.function.name));
  }

  const emit = (type, data) => { if (broadcastFn) broadcastFn('ai:response', { type, conversationId, ...data }); };

  const result = await runSubAgent({
    id: 'multimodal-main',
    name: '多模态助手',
    systemPrompt: finalSystemPrompt,
    provider,
    tools: activeTools,
    temperature: typeof temperature === 'number' ? temperature : 0.7,
    maxTokens: maxTokens || (thinkMode ? 8192 : 4096),
    maxIterations: 8,
    workdir,
    conversationId,
    thinkMode,
    messages: normalized,
    onEvent: (type, data) => {
      // 映射到前端已有的事件名
      if (type === 'reasoning') emit('agent-reasoning', { text: data.text, iteration: data.iteration });
      else if (type === 'content') emit('agent-content', { text: data.text, iteration: data.iteration });
      else if (type === 'tool-call-start') emit('agent-tool-call-start', { tool: data.tool, iteration: data.iteration });
      else if (type === 'tool-execute') emit('agent-tool-exec', { tool: data.tool, args: data.args, iteration: data.iteration });
      else if (type === 'tool-result') emit('agent-tool-result', { tool: data.tool, result: data.result, iteration: data.iteration });
      else if (type === 'iteration') emit('agent-iteration', { iteration: data.iteration, maxIterations: 8 });
      else if (type === 'done') emit('agent-done', { content: data.content, iteration: data.iteration });
      else if (type === 'status') emit('agent-content', { text: '\n> ' + data.text, iteration: 0 });
    }
  });

  // 带图请求失败时：用探测结果/错误特征把「模型不支持视觉」翻译成可读提示。
  // 探测在发送时已后台预热（此处多半命中缓存，即时返回）。
  if (!result.success && images.length > 0) {
    const errText = String(result.error || '');
    let visionRejected = false;
    let rejectReason = '';
    if (VISION_REJECT_RE.test(errText)) {
      visionRejected = true;
      rejectReason = '上游拒绝了图片输入';
    } else {
      try {
        const vision = await resolveVisionCapability(provider);
        if (vision && vision.supported === false && vision.definitive) {
          visionRejected = true;
          rejectReason = vision.reason;
        }
      } catch (e) { /* 探测失败不改变原错误 */ }
    }
    if (visionRejected) {
      return {
        success: false,
        error: '当前模型不支持视觉输入（' + rejectReason + '）。请更换支持视觉的模型（如 gpt-4o、qwen-vl-max、glm-4v 等），或在 provider 配置中设置 visionModel。'
      };
    }
  }
  return result;
}

module.exports = {
  init,
  // 多模态
  imageToDataUrl,
  buildMultimodalUserMessage,
  detectVisionCapability,
  probeVisionCapability,
  resolveVisionCapability,
  // 子 Agent
  runSubAgent,
  // 编排器
  orchestrate,
  runSequential,
  runParallel,
  runDebate,
  // 预设
  getPresets,
  buildPresetConfig,
  // 多模态对话
  multimodalChat
};
