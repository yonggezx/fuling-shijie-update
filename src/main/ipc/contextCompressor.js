/**
 * 上下文压缩器（Context Compressor）
 * ============================================================
 * 职责：
 *   工具返回的长文本自动摘要、精简，压缩后再送入 LLM；
 *   丢弃过期临时资源内容，节省显存和 token。
 *
 * 背景：
 *   5060 显存很吃上下文。MCP 工具动不动返回几万字符的日志/JSON，
 *   一把塞进上下文很快就满了。压缩器就是在结果进 AI 之前先做一轮「瘦身」。
 *
 * 压缩策略（从轻到重）：
 *   1. 行级去重：连续相同的行合并成「...（重复 N 行）」
 *   2. 空行压缩：连续空行合并成一个
 *   3. 格式感知：JSON 压缩空白、目录列表只保留关键部分
 *   4. 智能截断：保留开头和结尾，中间省略（不是一刀切）
 *   5. 临时资源丢弃：标记为临时的工具结果，用过后可以从历史里删掉
 */

// ── 默认配置 ──────────────────────────────────────────────────────────────
const DEFAULTS = {
  // 超过多少字符就开始压缩
  thresholdChars: 8000,
  // 压缩后目标长度
  targetChars: 4000,
  // 保留开头比例（0.7 = 开头留 70%）
  headRatio: 0.7,
  // 连续重复多少行就合并
  dedupConsecutiveLines: 3,
  // 连续空行超过多少就压缩
  compressBlankLines: 3,
  // JSON 压缩时的最大嵌套对象数
  maxJsonObjects: 50,
  // 单行最大长度（超过就截断单行）
  maxLineLength: 500
};

let config = Object.assign({}, DEFAULTS);

function configure(opts = {}) {
  config = Object.assign({}, DEFAULTS, opts);
}

// ── 行级压缩 ──────────────────────────────────────────────────────────────
/**
 * 行级压缩：去重连续重复行、压缩空行、截断超长行。
 */
function compressByLines(text) {
  if (typeof text !== 'string') return text;
  const lines = text.split('\n');
  const out = [];
  let blankRun = 0;
  let repeatLine = null;
  let repeatCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // ── 空行压缩 ──
    if (trimmed === '') {
      blankRun++;
      if (blankRun <= config.compressBlankLines) {
        out.push(line);
      } else if (blankRun === config.compressBlankLines + 1) {
        out.push('……（连续空行已压缩）');
      }
      continue;
    }
    blankRun = 0;

    // ── 超长行截断 ──
    let processed = line;
    if (line.length > config.maxLineLength) {
      processed = line.slice(0, config.maxLineLength) + ' ……（行过长已截断）';
    }

    // ── 连续重复行合并 ──
    if (repeatLine !== null && processed === repeatLine) {
      repeatCount++;
      if (repeatCount === config.dedupConsecutiveLines) {
        out.push('……（上面内容连续重复 ' + config.dedupConsecutiveLines + ' 次，已省略后续重复）');
      } else if (repeatCount > config.dedupConsecutiveLines) {
        continue;  // 超过阈值后直接跳过
      }
    } else {
      repeatLine = processed;
      repeatCount = 1;
    }

    out.push(processed);
  }

  return out.join('\n');
}

// ── JSON 压缩 ─────────────────────────────────────────────────────────────
/**
 * 尝试把文本当 JSON 解析，压缩冗余空白和数组元素。
 * 解析失败就原样返回。
 */
function compressJson(text) {
  if (typeof text !== 'string' || !text.trim().startsWith('{') && !text.trim().startsWith('[')) {
    return { text, compressed: false };
  }
  try {
    const obj = JSON.parse(text);
    // 简单策略：JSON.stringify 紧凑模式（去掉多余空格）
    let compact = JSON.stringify(obj);
    // 如果还是太长，尝试截断数组
    if (compact.length > config.thresholdChars && Array.isArray(obj)) {
      const kept = obj.slice(0, config.maxJsonObjects);
      compact = JSON.stringify({
        _truncated: true,
        _totalItems: obj.length,
        _keptItems: kept.length,
        items: kept
      });
    }
    return { text: compact, compressed: true };
  } catch (e) {
    return { text, compressed: false };
  }
}

// ── 智能截断（保留头和尾） ────────────────────────────────────────────────
/**
 * 智能截断：不是一刀切砍中间，而是保留开头（结果概要/错误信息）
 * 和结尾（总结/结论），中间大段省略。
 */
function smartTruncate(text, targetLen = config.targetChars) {
  if (typeof text !== 'string' || text.length <= targetLen) {
    return { text, truncated: false, originalLength: text ? text.length : 0 };
  }
  const headLen = Math.floor(targetLen * config.headRatio);
  const tailLen = targetLen - headLen - 80;  // 80 留给省略提示

  const head = text.slice(0, headLen);
  const tail = text.slice(-tailLen);
  const truncated = head
    + '\n\n……（中间省略约 ' + (text.length - headLen - tailLen) + ' 字符，结果过长已自动压缩）……\n\n'
    + tail;

  return { text: truncated, truncated: true, originalLength: text.length };
}

// ── 主压缩函数 ────────────────────────────────────────────────────────────
/**
 * 压缩工具结果文本。
 * @param {string} text 原始文本
 * @param {object} options { toolName: string }
 * @returns {{ text: string, compressed: boolean, beforeChars: number, afterChars: number }}
 */
function compress(text, options = {}) {
  if (typeof text !== 'string' || text.length === 0) {
    return { text, compressed: false, beforeChars: 0, afterChars: 0 };
  }

  const beforeChars = text.length;

  // 不够长，不用压缩
  if (text.length < config.thresholdChars) {
    return { text, compressed: false, beforeChars, afterChars: beforeChars };
  }

  let result = text;
  let didCompress = false;

  // 1. 行级压缩（去重、空行、超长行）
  const lineCompressed = compressByLines(result);
  if (lineCompressed !== result) {
    result = lineCompressed;
    didCompress = true;
  }

  // 2. JSON 压缩（如果看起来像 JSON）
  const jsonResult = compressJson(result);
  if (jsonResult.compressed) {
    result = jsonResult.text;
    didCompress = true;
  }

  // 3. 智能截断（如果还是太长）
  const trunc = smartTruncate(result);
  if (trunc.truncated) {
    result = trunc.text;
    didCompress = true;
  }

  const afterChars = result.length;
  if (didCompress) {
    console.log('[ContextCompressor] ' + (options.toolName || 'tool') +
      ' 结果压缩: ' + beforeChars + ' → ' + afterChars + ' 字符（节省 ' +
      Math.round((1 - afterChars / beforeChars) * 100) + '%）');
  }

  return { text: result, compressed: didCompress, beforeChars, afterChars };
}

// ── 历史消息清理：丢弃过期的临时工具结果 ──────────────────────────────────
/**
 * 从对话历史中清理过期的工具结果。
 * 有些工具的结果用完就没用了（比如截图分析的中间结果、长日志），
 * 保留在历史里只会占 token。这个函数把它们替换成简短占位。
 *
 * @param {Array} messages 对话消息数组
 * @param {object} options { keepRecentRounds: number } 保留最近几轮的完整结果
 * @returns {{ messages: Array, cleanedCount: number }}
 */
function pruneOldToolResults(messages, options = {}) {
  const keepRecent = options.keepRecentRounds || 5;
  if (!Array.isArray(messages)) return { messages, cleanedCount: 0 };

  // 从后往前数，找到最近 N 轮工具调用的 tool_call_id
  const recentToolCallIds = new Set();
  let rounds = 0;
  for (let i = messages.length - 1; i >= 0 && rounds < keepRecent; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc.id) recentToolCallIds.add(tc.id);
      }
      rounds++;
    }
  }

  // 清理旧的 tool 消息
  let cleaned = 0;
  const out = messages.map(msg => {
    if (msg.role !== 'tool' || recentToolCallIds.has(msg.tool_call_id)) return msg;
    // 旧的工具结果：替换成简短占位
    cleaned++;
    const content = typeof msg.content === 'string' ? msg.content : '';
    return {
      ...msg,
      content: '【已过期的工具结果，已清理以节省上下文。原始长度: ' + content.length + ' 字符】'
    };
  });

  if (cleaned > 0) {
    console.log('[ContextCompressor] 清理了 ' + cleaned + ' 条过期工具结果');
  }

  return { messages: out, cleanedCount: cleaned };
}

module.exports = {
  compress,
  compressByLines,
  compressJson,
  smartTruncate,
  pruneOldToolResults,
  configure,
  DEFAULTS
};
