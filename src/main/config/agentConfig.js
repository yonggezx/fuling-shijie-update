/**
 * Agent 配置加载器
 * ============================================================
 * 按「文件格式规范」整理后的唯一配置入口。核心原则：
 *
 *   core.md            → LLM 常驻系统提示（Markdown，精简硬性规则）
 *   tools.yaml         → 工具 schema（YAML），只有被当前角色启用的才进 AI 上下文
 *   roles.yaml         → 预设角色 + prompt 模板，按需加载
 *   examples.yaml      → Few-shot 好/坏答案示例，按priority 限量注入
 *   policy.yaml        → 安全策略，**永不进 AI**，主进程权限拦截层专用
 *   tool-labels.yaml   → 工具中文展示名，**永不进 AI**，UI 展示专用
 *   transform.yaml     → 文本加工规则（token估算/截断预算/敏感信息遮蔽），**永不进 AI**
 *   resource_index.yaml→ 配置资源清单，**永不进 AI**，加载器与体检脚本按它遍历
 *
 * 加载优先级：用户目录（可覆盖） > 出厂目录（随包发布）
 * 任何一项缺失都会走 healthCheck 报错，避免"配置悄悄丢了、AI 静默降级"。
 * ============================================================
 */
const fs = require('fs');
const path = require('path');

let yaml = null;
try { yaml = require('js-yaml'); } catch (e) { /* 由 healthCheck 报告 */ }

// 出厂配置目录（随 asar 打包发布）
const FACTORY_DIR = path.join(__dirname, '..', 'agent-config');

/** 用户覆盖目录：放在 userData 下，运行时可改，升级不会被覆盖 */
function userConfigDir() {
  try {
    // eslint-disable-next-line global-require
    const { app } = require('electron');
    if (app && app.getPath) return path.join(app.getPath('userData'), 'agent-config');
  } catch (e) { /* 非 Electron 环境（如 node 跑校验脚本）时用出厂目录 */ }
  return null;
}

function readFirstExisting(name) {
  const candidates = [userConfigDir(), FACTORY_DIR].filter(Boolean);
  for (const dir of candidates) {
    const p = path.join(dir, name);
    try {
      if (fs.existsSync(p)) return { file: p, text: fs.readFileSync(p, 'utf8') };
    } catch (e) { /* 继续尝试下一个 */ }
  }
  return null;
}

function loadYaml(name) {
  const hit = readFirstExisting(name);
  if (!hit) return null;
  if (!yaml) throw new Error('缺少 js-yaml 依赖，无法解析 ' + name);
  return { file: hit.file, data: yaml.load(hit.text) };
}

const state = { loaded: false, error: null, data: null };

/**
 * transform.yaml 的兜底默认值。
 * 缺失/写坏时不阻断启动 —— 加工规则是「优化」，不是「运行前提」。
 * 但两份系数（tokenEstimate）会直接影响上下文容量条的准确性，单独标出来便于体检区分。
 */
const TRANSFORM_DEFAULTS = {
  tokenEstimate: { nonCjkRatio: 0.26, cjkPattern: '[\\u2E80-\\u9FFF\\uF900-\\uFAFF\\uAC00-\\uD7AF\\uFF00-\\uFFEF]' },
  budget: {
    singleMessageTokenCap: 2000,
    ellipsisTemplate: '\n……（历史消息过长，此处省略约 {tokens} tokens）',
    hardCapEllipsisTemplate: '\n……（消息过长，此处省略约 {tokens} tokens）',
    ellipsisOverheadTokens: 40,
    shrinkRatio: 0.92,
    shrinkMaxRounds: 40,
    minKeepChars: 80
  },
  context: {
    autoCompressThreshold: 85,
    keepRecentMessages: 20,
    barWarn: 70,
    barDanger: 90,
    defaultWindow: 32768,
    requestOverhead: 256,
    minBudget: 1000
  },
  agentOverhead: { appendedPromptTokens: 600, fallbackToolsTokens: 3200 },
  redact: { enabled: true, mask: '***', patterns: [] }
};

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 浅合并 + 类型兜底：数字字段被写成字符串时也不至于让容量条算出 NaN */
function normalizeTransform(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const out = {};
  for (const section of Object.keys(TRANSFORM_DEFAULTS)) {
    const def = TRANSFORM_DEFAULTS[section];
    const got = isPlainObject(src[section]) ? src[section] : {};
    const merged = Object.assign({}, def, got);
    // 数值字段强制数值化，非法值回落默认
    for (const k of Object.keys(def)) {
      if (typeof def[k] !== 'number') continue;
      const n = Number(got[k]);
      merged[k] = Number.isFinite(n) ? n : def[k];
    }
    out[section] = merged;
  }
  // redact.patterns 用数组，不能被浅合并吃掉
  if (Array.isArray(src.redact) === false && Array.isArray(src.redact && src.redact.patterns)) {
    out.redact.patterns = src.redact.patterns.filter(p => p && p.name && p.pattern);
  } else if (!Array.isArray(out.redact.patterns)) {
    out.redact.patterns = [];
  }
  // 预编译一次，避免每次 redact 都重新 new RegExp
  out.redact.compiled = [];
  for (const p of out.redact.patterns) {
    try {
      // flags 独立字段：JS 的 RegExp 不支持 (?i) 内联标志，写在 pattern 里会直接失效
      const flags = typeof p.flags === 'string' ? p.flags : 'g';
      out.redact.compiled.push({ name: p.name, re: new RegExp(p.pattern, flags), keepGroup: p.keepGroup });
    } catch (e) {
      console.warn('[agentConfig] redact 规则「' + p.name + '」正则无效，已跳过:', e.message);
    }
  }
  return out;
}

function load() {
  if (state.loaded) return state.data;

  if (!yaml) {
    state.loaded = true;
    state.error = 'js-yaml 不可用';
    return null;
  }

  try {
    const toolsDoc = loadYaml('tools.yaml');
    const labelsDoc = loadYaml('tool-labels.yaml');
    const rolesDoc = loadYaml('roles.yaml');
    const policyDoc = loadYaml('policy.yaml');
    const examplesDoc = loadYaml('examples.yaml');
    const transformDoc = loadYaml('transform.yaml');
    const indexDoc = loadYaml('resource_index.yaml');
    const coreHit = readFirstExisting('core.md');

    if (!toolsDoc || !Array.isArray(toolsDoc.data && toolsDoc.data.tools)) {
      throw new Error('tools.yaml 缺失或格式错误（应为 { tools: [...] }）');
    }
    if (!coreHit || !coreHit.text.trim()) {
      throw new Error('core.md 缺失或为空');
    }

    state.data = {
      // ↓↓↓ 进 AI 上下文的部分
      corePrompt: coreHit.text,
      tools: toolsDoc.data.tools,
      presetRoles: (rolesDoc && rolesDoc.data && rolesDoc.data.presetRoles) || [],
      examples: (examplesDoc && examplesDoc.data && examplesDoc.data.examples) || [],
      examplesMeta: (examplesDoc && examplesDoc.data) || {},
      // ↓↓↓ 永不进 AI，主进程自用
      toolLabels: (labelsDoc && labelsDoc.data && labelsDoc.data.labels) || {},
      policy: (policyDoc && policyDoc.data) || {},
      transform: normalizeTransform((transformDoc && transformDoc.data) || {}),
      resourceIndex: (indexDoc && indexDoc.data) || null,
      // 溯源信息，便于排查
      sources: {
        core: coreHit.file,
        tools: toolsDoc.file,
        roles: rolesDoc && rolesDoc.file,
        policy: policyDoc && policyDoc.file,
        labels: labelsDoc && labelsDoc.file,
        examples: examplesDoc && examplesDoc.file,
        transform: transformDoc && transformDoc.file,
        resourceIndex: indexDoc && indexDoc.file
      }
    };
    state.loaded = true;
    return state.data;
  } catch (e) {
    state.loaded = true;
    state.error = e.message;
    console.error('[agentConfig] 加载失败:', e.message);
    return null;
  }
}

/** 单个工具名 → 中文展示名（永不回退原名，见 toolLabelCN 的兜底） */
function toolLabel(name) {
  const d = load();
  if (d && d.toolLabels && d.toolLabels[name]) return d.toolLabels[name];
  return '工具';
}

/**
 * 按启用名单裁剪工具 schema —— token 管控：
 * 不把 33 个工具的完整 schema 全塞给模型，只给当前角色/用户勾选的那些。
 */
function toolsForAI(enabledNames) {
  const d = load();
  if (!d) return [];
  if (!Array.isArray(enabledNames) || enabledNames.length === 0) return d.tools;
  const set = new Set(enabledNames);
  return d.tools.filter(t => t && t.function && set.has(t.function.name));
}

/**
 * 敏感信息遮蔽 —— transform.yaml 的 redact 段。
 * 与 tool-labels.yaml 分工：那边管「把函数名换成人话」，这边管「把密钥擦掉」。
 * 在任何文本进 AI 上下文之前调用。
 */
function redactText(text) {
  const d = load();
  if (!text) return text;
  const r = d && d.transform && d.transform.redact;
  if (!r || !r.enabled || !r.compiled || !r.compiled.length) return text;
  let out = String(text);
  for (const item of r.compiled) {
    item.re.lastIndex = 0;
    out = item.keepGroup
      ? out.replace(item.re, '$' + item.keepGroup + r.mask)
      : out.replace(item.re, r.mask);
  }
  return out;
}

/**
 * 把 examples.yaml 渲染成可注入的提示词片段。
 * 受 maxInjected 限量；注入位置由 injectPosition 决定。
 * @param {'chat'|'agent'} mode 只取该场景适用的示例
 */
function renderExamples(mode) {
  const d = load();
  if (!d || !Array.isArray(d.examples) || !d.examples.length) return '';
  const meta = d.examplesMeta || {};
  const cap = Number(meta.maxInjected) > 0 ? Number(meta.maxInjected) : 3;

  const picked = d.examples
    .filter(e => e && (e.appliesTo || []).includes(mode))
    .sort((a, b) => (a.priority || 99) - (b.priority || 99))
    .slice(0, cap);
  if (!picked.length) return '';

  const blocks = picked.map(e => {
    const lines = [];
    lines.push('### ' + e.title);
    if (Array.isArray(e.bad) && e.bad.length) {
      lines.push('❌ 不要这样答：');
      for (const b of e.bad) lines.push(String(b).trim().replace(/^/gm, '> '));
    }
    if (Array.isArray(e.good) && e.good.length) {
      lines.push('✅ 应该这样答：');
      for (const g of e.good) lines.push(String(g).trim().replace(/^/gm, '> '));
    }
    if (e.note) lines.push('要点：' + String(e.note).trim().replace(/\s*\n\s*/g, ' '));
    return lines.join('\n');
  });

  return '\n\n## 示例（示范答案的样子，不是必须逐字照抄）\n\n'
    + blocks.join('\n\n');
}

/** 下发给渲染层的加工参数（token 估算 + 截断预算 + 上下文水位） */
function transformForRenderer() {
  const d = load();
  if (!d) return TRANSFORM_DEFAULTS;
  return d.transform;
}

/** 启动自检：把配置健康度打进日志，缺失时立刻暴露而不是静默降级 */
function healthCheck() {
  const d = load();
  const problems = [];
  const warnings = [];
  if (state.error) problems.push(state.error);
  if (d) {
    if (!d.tools.length) problems.push('工具表为空');
    if (!d.corePrompt || d.corePrompt.length < 200) problems.push('core.md 过短，疑似未加载完整');
    if (!d.presetRoles.length) problems.push('预设角色为空');
    if (!Object.keys(d.toolLabels).length) problems.push('工具展示名为空');
    if (!Object.keys(d.policy).length) problems.push('安全策略为空');
    // 以下三个是可选资源，缺失只警告不阻断
    if (!d.examples.length) warnings.push('examples.yaml 缺失或为空，将不注入示例');
    if (!d.resourceIndex) warnings.push('resource_index.yaml 缺失，体检脚本将退化为固定检查项');
    if (!d.transform.redact.compiled.length) warnings.push('transform.yaml 未配置有效遮蔽规则，敏感信息不会被擦除');
  }
  return {
    ok: problems.length === 0,
    problems,
    warnings,
    stats: d ? {
      tools: d.tools.length,
      roles: d.presetRoles.length,
      labels: Object.keys(d.toolLabels).length,
      examples: d.examples.length,
      redactPatterns: d.transform.redact.compiled.length,
      riskyTools: (d.policy.riskyTools || []).length,
      alwaysAllowed: (d.policy.alwaysAllowed || []).length,
      coreChars: d.corePrompt.length
    } : null,
    sources: d ? d.sources : null
  };
}

module.exports = {
  load,
  toolLabel,
  toolsForAI,
  redactText,
  renderExamples,
  transformForRenderer,
  healthCheck,
  userConfigDir,
  FACTORY_DIR,
  TRANSFORM_DEFAULTS,
  get raw() { return state; }
};
