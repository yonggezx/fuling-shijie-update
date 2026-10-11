/**
 * MCP 失败降级 & 重试策略
 * ============================================================
 * 职责：
 *   区分不同错误类型，执行对应的降级/重试/恢复策略，
 *   让 MCP 调用更鲁棒，减少「一次网络抖动就整个工具不能用」的情况。
 *
 * 错误分类与策略：
 *   ┌─────────────────────┬──────────────────────────────────────┐
 *   │ 错误类型             │ 策略                                │
 *   ├─────────────────────┼──────────────────────────────────────┤
 *   │ 网络抖动 / 超时      │ 指数退避重试（最多 2 次）            │
 *   │ 服务崩溃 / 进程退出  │ 自动重启 MCP 子进程后重试一次       │
 *   │ 参数错误 / 4xx       │ 不重试，直接返回错误给 AI            │
 *   │ 权限 / 被拒绝        │ 不重试，直接返回                     │
 *   │ 未知错误             │ 重试 1 次，仍失败则返回              │
 *   └─────────────────────┴──────────────────────────────────────┘
 *
 * 心跳检测：
 *   定期 ping MCP 服务器（用 tools/list 做轻量探测），
 *   发现状态不对时提前标记，避免真到调用时才发现 server 死了。
 */

// ── 错误分类规则 ──────────────────────────────────────────────────────────
// 根据错误消息文本判断错误类型
const ERROR_CLASSIFIERS = [
  {
    type: 'timeout',
    match: /超时|timed out|timeout|ETIMEDOUT/gi,
    retryable: true,
    maxRetries: 2,
    backoffMs: [1000, 2000]  // 第1次等1s，第2次等2s
  },
  {
    type: 'network',
    match: /ECONNRESET|ECONNREFUSED|ENOTFOUND|network error|socket hang up|断管|EPIPE/gi,
    retryable: true,
    maxRetries: 2,
    backoffMs: [500, 1500]
  },
  {
    type: 'crashed',
    match: /进程已退出|服务器.*退出|crashed|ECHILD|子进程.*结束|server closed/gi,
    retryable: true,
    maxRetries: 1,
    backoffMs: [2000],
    autoRestart: true   // 崩溃后先重启 server 再重试
  },
  {
    type: 'param_error',
    match: /参数|invalid|bad request|400|missing.*required|unknown.*tool|未找到.*工具/gi,
    retryable: false,    // 参数错误重试也没用，让 AI 自己改参数
    maxRetries: 0
  },
  {
    type: 'permission',
    match: /权限|denied|forbidden|403|unauthorized|拒绝/gi,
    retryable: false,
    maxRetries: 0
  }
];

// 默认分类（未命中上面任何规则时）
const DEFAULT_CLASSIFIER = {
  type: 'unknown',
  retryable: true,
  maxRetries: 1,
  backoffMs: [1000]
};

/**
 * 分类错误类型。
 * @param {Error|string} error 错误对象或错误消息
 * @returns {{ type: string, retryable: boolean, maxRetries: number, backoffMs: number[], autoRestart: boolean }}
 */
function classifyError(error) {
  const msg = (error && error.message) || String(error || '');
  for (const rule of ERROR_CLASSIFIERS) {
    if (rule.match.test(msg)) {
      return {
        type: rule.type,
        retryable: rule.retryable,
        maxRetries: rule.maxRetries,
        backoffMs: rule.backoffMs || [1000],
        autoRestart: !!rule.autoRestart
      };
    }
  }
  return { ...DEFAULT_CLASSIFIER };
}

// ── 带重试的 MCP 工具调用 ─────────────────────────────────────────────────
/**
 * 带重试策略的 MCP 工具调用封装。
 * @param {object} mcpManager mcpManager 实例
 * @param {string} exposedName 暴露的工具名（mcp_xxx）
 * @param {object} args 调用参数
 * @returns {Promise<{success, content, ...}>}
 */
async function callToolWithRetry(mcpManager, exposedName, args) {
  const classify = classifyError;
  let lastError = null;
  let retryCount = 0;

  while (true) {
    try {
      const result = await mcpManager.callTool(exposedName, args);
      // 调用成功（即使工具返回 isError，也不是调用层错误）
      // 工具返回的业务错误由 AI 自己处理，不在这层重试
      return result;
    } catch (e) {
      lastError = e;
      const cls = classify(e);

      // 不可重试的错误：直接返回失败
      if (!cls.retryable || retryCount >= cls.maxRetries) {
        return {
          success: false,
          error: 'MCP 调用失败: ' + (e.message || String(e)),
          errorType: cls.type,
          retried: retryCount > 0,
          hint: cls.type === 'param_error'
            ? '参数可能有误，请检查工具参数格式后重试。'
            : (cls.type === 'permission'
              ? '权限不足，请检查 MCP 服务器的权限配置。'
              : 'MCP 服务暂时不可用，请稍后重试或重启 MCP 服务器。')
        };
      }

      // 需要自动重启 server 的情况
      if (cls.autoRestart) {
        console.log('[MCPRetry] 检测到服务崩溃，尝试自动重启:', exposedName);
        try {
          const serverId = mcpManager.ownerOf(exposedName);
          if (serverId) {
            await mcpManager.restartServer(serverId);
            console.log('[MCPRetry] 自动重启成功，准备重试');
          }
        } catch (restartErr) {
          console.warn('[MCPRetry] 自动重启失败:', restartErr.message);
          return {
            success: false,
            error: 'MCP 服务崩溃且自动重启失败: ' + (restartErr.message || restartErr),
            errorType: 'crashed',
            retried: retryCount > 0
          };
        }
      }

      // 指数退避等待
      const waitMs = cls.backoffMs[retryCount] || 1000;
      console.log('[MCPRetry] 第 ' + (retryCount + 1) + ' 次重试 ' + exposedName +
        '（错误类型: ' + cls.type + '，等待 ' + waitMs + 'ms）');
      await sleep(waitMs);
      retryCount++;
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── 心跳检测 ──────────────────────────────────────────────────────────────
/**
 * MCP 心跳检测器：定期探测 server 是否还活着。
 * 用 tools/list 做轻量探测（比 tools/call 便宜，不会有副作用）。
 */
class McpHeartbeat {
  /**
   * @param {object} mcpManager mcpManager 实例
   * @param {object} options { intervalMs, timeoutMs }
   */
  constructor(mcpManager, options = {}) {
    this.mcpManager = mcpManager;
    this.intervalMs = options.intervalMs || 60000;  // 默认 60 秒一次
    this.timeoutMs = options.timeoutMs || 10000;
    this.timer = null;
    this.lastCheck = new Map();   // serverId -> { ok, at, error }
    this.onStatusChange = null;   // 状态变化回调
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.checkAll(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    console.log('[MCPHeartbeat] 心跳检测已启动，间隔 ' + this.intervalMs / 1000 + 's');
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 检查所有正在运行的 server */
  async checkAll() {
    const status = this.mcpManager.status();
    const runningServers = (status.running || []);
    for (const s of runningServers) {
      try {
        await this.pingServer(s.id);
      } catch (e) {
        this.recordResult(s.id, false, e.message);
        console.warn('[MCPHeartbeat] ' + s.id + ' 心跳失败: ' + e.message);
      }
    }
  }

  /** 探测单个 server 是否存活 */
  async pingServer(serverId) {
    // 简单做法：调用 listTools（轻量，只读）
    // mcpManager 没有暴露单 server 的 listTools，这里用 ownerOf + state 访问
    // 为了不侵入 mcpManager 的内部结构，我们用一个更轻量的方式：
    // 检查 client.status === 'ready'，以及进程是否还在
    const state = this.mcpManager._state;
    const client = state.clients.get(serverId);
    if (!client) {
      throw new Error('客户端不存在');
    }
    if (client.status !== 'ready') {
      throw new Error('状态异常: ' + client.status);
    }
    if (!client.proc || client.proc.killed) {
      throw new Error('进程已退出');
    }
    this.recordResult(serverId, true, null);
  }

  recordResult(serverId, ok, error) {
    const prev = this.lastCheck.get(serverId);
    const now = Date.now();
    this.lastCheck.set(serverId, { ok, at: now, error });

    // 状态变化时触发回调
    if (this.onStatusChange && (!prev || prev.ok !== ok)) {
      try {
        this.onStatusChange({ serverId, ok, error, at: now, prevOk: prev ? prev.ok : null });
      } catch (e) { /* 回调异常不影响心跳 */ }
    }
  }

  getStatus() {
    const out = {};
    for (const [id, r] of this.lastCheck) {
      out[id] = { ...r, ageMs: Date.now() - r.at };
    }
    return out;
  }
}

module.exports = {
  classifyError,
  callToolWithRetry,
  McpHeartbeat,
  ERROR_CLASSIFIERS
};
