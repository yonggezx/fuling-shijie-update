/**
 * 反思器（Reflector / Self-critique）
 * ============================================================
 * 职责：
 *   工具调用完成后，在代码层先做一轮「结果质量自检」，
 *   发现异常时在结果里附加明确警告，让模型在下一轮知道
 *   「这个结果可能不可信，要自己再确认或换方案」。
 *
 * 解决的问题：
 *   AI 调用工具拿到错误结果却以为成功（幻觉），
 *   比如 read_file 返回空但 AI 以为文件就是空的、
 *   run_shell 返回 exitCode=0 但实际没执行成功。
 *
 * 设计原则：
 *   · **轻量级代码检查**：不调 LLM，纯规则判断，零额外 token 开销。
 *   · **只报警、不拦截**：反思器不阻止结果进上下文，
 *     只在结果里加一段「自检警告」，最终判断权仍在模型手里。
 *   · **针对性检查**：不同工具类型有不同的异常特征，
 *     通用检查 + 工具专属检查结合。
 */

// ── 异常关键词库 ──────────────────────────────────────────────────────────
// 工具返回结果里出现这些词时，即使 success=true 也要警惕
const ERROR_KEYWORDS = [
  // 通用错误
  'error', 'exception', 'failed', 'failure', 'denied', 'refused',
  'not found', 'no such file', 'cannot find', 'unable to',
  'timed out', 'timeout', 'connection refused', 'network error',
  'permission denied', 'access denied',
  // 中文错误
  '错误', '失败', '异常', '找不到', '无法', '拒绝', '超时',
  '权限不足', '不存在', '未找到',
  // 空结果特征
  'empty response', 'no output', 'no data', 'no result'
];

// 各工具类型的专属异常检查规则
const TOOL_RULES = {
  // 文件读取：成功但内容为空或极短 → 可疑
  read_file: {
    minContentLength: 1,
    emptyWarning: '文件读取返回成功，但内容为空或过短。请确认路径是否正确、文件是否真的有内容。',
    suspiciousLength: 10,
    lengthWarning: '文件内容极短（{len} 字符），请确认是否读对了文件。'
  },
  // 执行命令：成功但 stdout 为空 → 可疑
  run_shell: {
    requireOutput: true,
    emptyOutputWarning: '命令执行成功但没有任何输出。请确认命令是否真的执行了预期操作。',
    checkExitCode: true,
    exitCodeWarning: '命令返回退出码 {code}（非 0），可能执行失败。请检查错误信息。'
  },
  // 网络搜索：成功但结果数为 0 → 可疑
  web_search: {
    minResults: 1,
    noResultsWarning: '搜索成功但没有返回任何结果。请尝试更换关键词或检查网络。'
  },
  // 写文件：成功但写入字节数为 0 → 可疑
  write_file: {
    requireBytesWritten: true,
    zeroBytesWarning: '文件写入成功但写入字节数为 0。请确认内容是否正确传递。'
  },
  // MCP 工具：通用检查（具体按 server 声明的 schema 检查会太复杂，先做通用的）
  _mcp: {
    // MCP 返回 content 数组，flattenContent 已经处理过，这里只检查长度异常
    minContentLength: 0, // MCP 结果可能合法地很短，不设下限
    suspiciousLength: 50000,
    lengthWarning: 'MCP 返回内容极长（约 {len} 字符），可能包含大量无关信息。请提炼关键部分再使用。'
  }
};

/**
 * 对工具执行结果做反思自检。
 * @param {string} toolName 工具名
 * @param {object} result 工具执行结果 { success, content, ... }
 * @param {object} args 工具调用参数
 * @returns {{ warnings: string[], flagged: boolean, modifiedResult: object }}
 *   warnings: 检测到的警告列表
 *   flagged: 是否有可疑之处
 *   modifiedResult: 附加了警告后的结果（如果没警告就原样返回）
 */
function reflect(toolName, result, args = {}) {
  if (!result || typeof result !== 'object') {
    return { warnings: ['结果格式异常'], flagged: true, modifiedResult: result };
  }

  const warnings = [];
  const isMcp = toolName.startsWith('mcp_');
  const ruleKey = isMcp ? '_mcp' : toolName;
  const rule = TOOL_RULES[ruleKey] || {};

  // ── 1. 失败结果：不用反思，已经是失败状态 ──
  if (result.success === false) {
    return { warnings: [], flagged: false, modifiedResult: result };
  }

  // ── 2. 通用检查：结果内容 ──
  const content = typeof result.content === 'string'
    ? result.content
    : (typeof result.output === 'string' ? result.output : JSON.stringify(result));

  if (!content || content.trim().length === 0) {
    warnings.push('工具返回成功，但输出内容为空。请确认操作是否真的产生了预期效果。');
  } else {
    // 检查错误关键词（即使 success=true 也要警惕）
    const lowerContent = content.toLowerCase();
    const hits = ERROR_KEYWORDS.filter(kw => lowerContent.includes(kw.toLowerCase()));
    if (hits.length > 0 && content.length < 5000) {
      // 只在内容不太长时才报，太长的内容里出现 error 一词很正常
      warnings.push('结果中包含疑似错误关键词：「' + hits.slice(0, 3).join('、') +
        '」。即使 success=true，也请仔细核对结果是否符合预期。');
    }
  }

  // ── 3. 工具专属检查 ──
  if (rule.minContentLength && content.length < rule.minContentLength) {
    warnings.push(rule.emptyWarning || '结果内容过短，请确认操作是否成功。');
  }

  if (rule.suspiciousLength && content.length > rule.suspiciousLength) {
    warnings.push(rule.lengthWarning
      ? rule.lengthWarning.replace('{len}', (content.length / 1000).toFixed(0) + 'K')
      : '结果内容极长，请提炼关键信息。');
  }

  if (rule.requireOutput && content.trim().length === 0) {
    warnings.push(rule.emptyOutputWarning);
  }

  if (rule.checkExitCode && typeof result.exitCode === 'number' && result.exitCode !== 0) {
    warnings.push(rule.exitCodeWarning.replace('{code}', result.exitCode));
  }

  if (rule.requireBytesWritten && (result.bytesWritten === 0 || result.bytes_written === 0)) {
    warnings.push(rule.zeroBytesWarning);
  }

  // web_search 专属：检查 results 数组长度
  if (toolName === 'web_search' && Array.isArray(result.results) && result.results.length === 0) {
    warnings.push(rule.noResultsWarning);
  }

  // ── 4. 组装结果 ──
  if (warnings.length === 0) {
    return { warnings: [], flagged: false, modifiedResult: result };
  }

  // 把警告附加到结果里，让模型下一轮能看到
  const modified = Object.assign({}, result, {
    _reflection: {
      flagged: true,
      warnings: warnings,
      note: '【反思器自检】以上结果可能存在问题，请你在下一轮自行核实：1) 结果是否符合工具调用的预期？2) 是否需要换一种方式重试？3) 如果确认结果无误，请继续任务；如果发现问题，请修正后继续。'
    }
  });

  return { warnings, flagged: true, modifiedResult: modified };
}

/**
 * 生成注入系统提示词的反思器说明片段。
 * 让模型知道有反思器这回事，以及如何对待它的警告。
 */
function buildPromptBlock() {
  return [
    '## 结果反思器（自动自检）',
    '每次工具调用完成后，系统会自动对结果做一轮质量自检。',
    '如果结果里出现 `_reflection.flagged: true`，说明自检发现了可疑之处：',
    '- 请你认真阅读 `_reflection.warnings` 里列出的疑点；',
    '- 如果确认结果没问题，继续任务即可（自检是保守策略，可能误报）；',
    '- 如果结果确实有问题，请换一种方式重试或修正后继续；',
    '- 不要因为有警告就终止任务，大部分警告是「请再确认一下」而不是「必须重来」。'
  ].join('\n');
}

module.exports = {
  reflect,
  buildPromptBlock,
  ERROR_KEYWORDS,
  TOOL_RULES
};
