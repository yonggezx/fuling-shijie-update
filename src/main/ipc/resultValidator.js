/**
 * 结果校验器（输出校验）
 * ============================================================
 * 职责：
 *   在 MCP / 工具返回结果送入 AI 上下文之前，
 *   在代码层做硬校验：格式、长度、范围、权限。
 *   不合格的结果直接拦截或截断，不脏了 AI 的上下文。
 *
 * 和反思器的分工：
 *   · 结果校验器 = 硬门禁：格式不对、超长、越界 → 直接截断/拦截
 *   · 反思器     = 软提醒：结果可疑但格式没问题 → 附加警告让 AI 自己判断
 *
 * 解决的问题：
 *   · 脏数据直接丢给 AI，导致后续推理全错
 *   · 超长文本（几万行日志）一把塞进上下文，直接炸显存
 *   · MCP 返回格式不规范（有的返数组、有的返字符串），AI 解析失败
 */

// ── 默认阈值 ──────────────────────────────────────────────────────────────
const DEFAULTS = {
  // 单个工具返回的文本最大字符数（超过就截断）
  maxContentChars: 20000,
  // 截断后保留多少字符
  truncateKeepChars: 15000,
  // 单个工具返回的最大体积（字节，用于二进制内容估算）
  maxContentBytes: 50000,
  // 结果中允许的最大嵌套深度（JSON 对象）
  maxJsonDepth: 10,
  // 危险内容检测开关
  detectSensitive: true,
  // 敏感内容打码后替换成这个
  mask: '***[已脱敏]***'
};

let config = Object.assign({}, DEFAULTS);

function configure(opts = {}) {
  config = Object.assign({}, DEFAULTS, opts);
  return config;
}

// ── 敏感信息脱敏（复用 transform.yaml 的思路，但这里是代码层兜底） ──────
const SENSITIVE_PATTERNS = [
  // API Key
  { name: 'openai_key', pattern: /sk-[A-Za-z0-9]{20,}/g },
  { name: 'anthropic_key', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'github_token', pattern: /gh[pousr]_[A-Za-z0-9]{36}/g },
  // 私钥
  { name: 'private_key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  // JWT
  { name: 'jwt', pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  // 密码赋值
  { name: 'password_assignment', pattern: /((?:password|passwd|pwd|secret|api[_-]?key|token)\s*[=:]\s*["']?)([^\s"']{8,})/gi, keepGroup: 1 }
];

/**
 * 脱敏：把文本里的敏感信息打码。
 * 在结果进 AI 上下文之前先跑一遍，双保险（transform.yaml 是配置层，这里是代码层）。
 */
function redactSensitive(text) {
  if (!config.detectSensitive || typeof text !== 'string') return text;
  let out = text;
  for (const p of SENSITIVE_PATTERNS) {
    if (p.keepGroup) {
      out = out.replace(p.pattern, (m, g1, g2) => g1 + config.mask);
    } else {
      out = out.replace(p.pattern, config.mask);
    }
  }
  return out;
}

// ── 长度校验与截断 ────────────────────────────────────────────────────────
/**
 * 截断超长文本。保留开头和结尾各一部分，中间省略。
 * 开头通常是最重要的（错误信息、结果摘要），结尾可能有总结。
 */
function truncateText(text, maxChars = config.maxContentChars) {
  if (typeof text !== 'string') return { text, truncated: false, originalLength: 0 };
  if (text.length <= maxChars) {
    return { text, truncated: false, originalLength: text.length };
  }
  const keep = Math.min(config.truncateKeepChars, maxChars - 50);
  const head = Math.floor(keep * 0.7);
  const tail = keep - head;
  const truncated = text.slice(0, head)
    + '\n\n……（中间省略约 ' + (text.length - keep) + ' 字符，结果过长已自动截断）……\n\n'
    + text.slice(-tail);
  return { text: truncated, truncated: true, originalLength: text.length };
}

// ── JSON 深度检查 ─────────────────────────────────────────────────────────
/**
 * 检查 JSON 对象的嵌套深度，防止 MCP 返回一个深度嵌套的怪物对象
 * 导致 JSON.stringify 后体积爆炸。
 */
function checkJsonDepth(obj, maxDepth = config.maxJsonDepth, currentDepth = 0) {
  if (currentDepth > maxDepth) return { ok: false, depth: currentDepth, reason: 'JSON 嵌套过深' };
  if (!obj || typeof obj !== 'object') return { ok: true, depth: currentDepth };
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const r = checkJsonDepth(item, maxDepth, currentDepth + 1);
      if (!r.ok) return r;
    }
  } else {
    for (const key of Object.keys(obj)) {
      const r = checkJsonDepth(obj[key], maxDepth, currentDepth + 1);
      if (!r.ok) return r;
    }
  }
  return { ok: true, depth: currentDepth };
}

// ── 主校验函数 ────────────────────────────────────────────────────────────
/**
 * 校验工具执行结果。
 * @param {string} toolName 工具名
 * @param {object} result 原始结果
 * @param {object} options { isMcp: boolean }
 * @returns {{
 *   ok: boolean,
 *   result: object,       // 校验/清洗后的结果
 *   issues: string[],    // 发现的问题列表
 *   truncated: boolean,  // 是否被截断过
 *   redacted: boolean    // 是否做过敏感信息脱敏
 * }}
 */
function validate(toolName, result, options = {}) {
  const issues = [];
  let truncated = false;
  let redacted = false;

  // ── 1. 基本格式检查 ──
  if (!result || typeof result !== 'object') {
    return {
      ok: false,
      result: { success: false, error: '工具返回结果格式异常：不是对象', raw: result },
      issues: ['结果不是对象'],
      truncated: false,
      redacted: false
    };
  }

  // 确保有 success 字段
  if (typeof result.success !== 'boolean') {
    issues.push('结果缺少 success 布尔字段');
    result.success = result.success === true || (typeof result.content === 'string' && result.content.length > 0);
  }

  // ── 2. 文本内容校验 ──
  let content = result.content !== undefined
    ? result.content
    : (result.output !== undefined ? result.output : JSON.stringify(result));

  if (typeof content === 'string') {
    // 2a. 敏感信息脱敏
    const before = content;
    content = redactSensitive(content);
    if (content !== before) redacted = true;

    // 2b. 超长截断
    const trunc = truncateText(content);
    content = trunc.text;
    truncated = trunc.truncated;
    if (trunc.truncated) {
      issues.push('结果过长（' + trunc.originalLength + ' 字符），已自动截断到 ' + config.truncateKeepChars + ' 字符');
    }

    result.content = content;
  }

  // ── 3. JSON 结构校验 ──
  // MCP 工具可能返回 raw 字段，检查它的嵌套深度
  if (result.raw && typeof result.raw === 'object') {
    const depthCheck = checkJsonDepth(result.raw);
    if (!depthCheck.ok) {
      issues.push('返回数据嵌套过深（' + depthCheck.depth + ' 层），已剥离 raw 字段');
      delete result.raw;
    }
  }

  // ── 4. MCP 专属校验 ──
  if (options.isMcp || toolName.startsWith('mcp_')) {
    // MCP 结果必须有 content 字符串
    if (typeof result.content !== 'string' && typeof result.text !== 'string') {
      issues.push('MCP 结果缺少文本内容，已尝试序列化');
      result.content = JSON.stringify(result).slice(0, config.maxContentChars);
    }
  }

  // ── 5. 组装返回 ──
  if (issues.length > 0) {
    result._validation = {
      flagged: true,
      issues: issues,
      note: '【结果校验器】以上结果已自动做过格式清洗/截断/脱敏，可能不完整，请按需重新获取关键信息。'
    };
  }

  return {
    ok: true,  // 校验器不拦截，只清洗；拦截由权限/安全中心负责
    result,
    issues,
    truncated,
    redacted
  };
}

module.exports = {
  validate,
  truncateText,
  redactSensitive,
  checkJsonDepth,
  configure,
  DEFAULTS
};
