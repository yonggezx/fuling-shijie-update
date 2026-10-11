/**
 * MCP 客户端核心（stdio 传输 / JSON-RPC 2.0）
 * ============================================================
 * Model Context Protocol 客户端，负责：
 *   1. 以子进程方式拉起 MCP Server（stdio 传输，Windows 下走 npx / node）
 *   2. initialize → initialized 握手，协商 protocolVersion / capabilities
 *   3. tools/list 拿工具清单，tools/call 执行
 *   4. resources/list+read、prompts/list+get（可选能力，server不支持时降级）
 *
 * 设计要点（都是踩过的坑）：
 *   · **stdin/stdout 是二进制分帧的** —— MCP 规范里每条消息是换行分隔的 JSON。
 *     Windows 上 stdout 换行是 \r\n，必须先按 \n 切再逐条 trim，不能整块 JSON.parse。
 *   · **stderr 不是协议通道** —— 很多 server（尤其 python系）把日志往 stderr 写，
 *     绝不能混进 stdout 解析，否则立刻 JSON 解析失败。
 *   · **requestId 单调递增 + 超时清理** —— server 不响应时必须自己超时回收 pending，
 *     否则 promise 永远挂着、调用方（agent 循环）跟着卡死。
 *   · **崩溃要能被发现** —— exit 事件要把该server 所有 pending 全部 reject，
 *     否则界面表现是"工具卡住"，看不出是 server 崩了。
 *   · **不自动重连** —— 频繁重启会拖慢启动且掩盖真实错误。改为标记 crashed，
 *     由用户或调用方显式 restart。
 *
 * 本模块是纯主进程侧，不依赖 Electron，可在 node 下直接跑测试。
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// 客户端实现的协议版本；server 会回一个自己支持的版本，取双方较小值
const CLIENT_PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

let nextRequestId = 1;

class McpStdioClient {
  /**
   * @param {object} cfg
   * @param {string} cfg.id            服务器 id（日志/配置键）
   * @param {string} cfg.command       可执行命令（npx / node / python）
   * @param {string[]} cfg.args        参数
   * @param {object} [cfg.env]         额外环境变量（会并到 process.env）
   * @param {string} [cfg.cwd]         工作目录
   * @param {number} [cfg.startupTimeoutMs] 握手超时
   * @param {number} [cfg.callTimeoutMs]    单次 tools/call 超时
   */
  constructor(cfg) {
    this.id = cfg.id;
    this.command = cfg.command;
    this.args = Array.isArray(cfg.args) ? cfg.args : [];
    this.env = cfg.env || {};
    this.cwd = cfg.cwd || null;
    this.startupTimeoutMs = cfg.startupTimeoutMs || 20000;
    this.callTimeoutMs = cfg.callTimeoutMs || 60000;

    this.proc = null;
    this.pending = new Map();       // requestId -> {resolve, reject, timer}
    this.status = 'stopped';        // stopped | starting | ready | crashed | failed
    this.error = null;
    this.serverInfo = null;
    this.capabilities = {};
    this.protocolVersion = null;
    this.toolsCache = null;         // tools/list 结果缓存
    this._buffer = '';              // stdout 跨 chunk 分片缓冲
    this._stderrTail = [];          // stderr 末尾若干行，用于失败时定位
    this._log('客户端已创建（尚未启动）');
  }

  _log(msg) {
    console.log('[MCP:' + this.id + '] ' + msg);
  }
  _warn(msg) {
    console.warn('[MCP:' + this.id + '] ' + msg);
  }

  /** 启动子进程并完成握手；重复调用是幂等的（已 ready 直接返回） */
  async start() {
    if (this.status === 'ready') return { ok: true, cached: true };
    if (this.status === 'starting') {
      throw new Error('MCP 服务器「' + this.id + '」正在启动中');
    }
    if (!this.command) {
      this.status = 'failed';
      this.error = '未配置启动命令';
      return { ok: false, error: this.error };
    }

    this.status = 'starting';
    this.error = null;
    this._buffer = '';
    this._stderrTail = [];

    let child;
    try {
      child = spawn(this.command, this.args, {
        cwd: this.cwd || undefined,
        env: Object.assign({}, process.env, this.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true      // 别弹出黑框
      });
    } catch (e) {
      this.status = 'failed';
      this.error = '进程拉起失败: ' + e.message;
      return { ok: false, error: this.error };
    }
    this.proc = child;
    this._log('已拉起子进程 pid=' + child.pid + ' cmd=' + this.command + ' ' + this.args.join(' '));

    child.on('error', (e) => {
      // 常见于 npx 不存在 / 权限不足 —— 立刻失败并给出可读原因
      this._rejectAllPending('进程错误: ' + e.message);
      this.status = 'failed';
      this.error = e.message;
      this._warn('进程 error 事件: ' + e.message);
    });

    child.on('exit', (code, signal) => {
      const wasReady = this.status === 'ready';
      this.proc = null;
      this._rejectAllPending('服务器进程已退出（code=' + code + ', signal=' + (signal || 'null') + '）');
      if (wasReady) {
        this.status = 'crashed';
        this.error = '服务器意外退出（code=' + code + '）';
      } else if (this.status !== 'failed') {
        this.status = 'failed';
        this.error = '握手完成前退出（code=' + code + '）' + (this._stderrTail.length ? '：' + this._stderrTail.slice(-3).join(' | ') : '');
      }
      this._log('进程退出 code=' + code + ' signal=' + signal + ' status=' + this.status);
    });

    child.stdout.on('data', (chunk) => this._onStdout(chunk));
    // stderr 只留尾巴，不参与协议解析
    child.stderr.on('data', (chunk) => {
      const lines = String(chunk).split('\n').map(s => s.trim()).filter(Boolean);
      for (const l of lines) {
        this._stderrTail.push(l);
        if (this._stderrTail.length > 20) this._stderrTail.shift();
      }
      if (lines.length) this._log('stderr: ' + lines.slice(-3).join(' | '));
    });

    // 握手
    const timeoutAt = Date.now() + this.startupTimeoutMs;
    try {
      const initRes = await this._request('initialize', {
        protocolVersion: CLIENT_PROTOCOL_VERSION,
        capabilities: { roots: { listChanged: false }, sampling: {} },
        clientInfo: { name: 'fuling-shijie', version: '1.0.7' }
      }, timeoutAt);

      // 协商版本：取 server 返回的（若不识别则退回共同支持的最高版本）
      const sv = initRes && initRes.protocolVersion;
      this.protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(sv) ? sv : CLIENT_PROTOCOL_VERSION;
      this.serverInfo = (initRes && initRes.serverInfo) || null;
      this.capabilities = (initRes && initRes.capabilities) || {};

      // initialized 通知（无 id，不等响应）
      this._notify('notifications/initialized', {});

      this.status = 'ready';
      this.error = null;
      this._log('握手完成 protocolVersion=' + this.protocolVersion
        + ' server=' + ((this.serverInfo && this.serverInfo.name) || '?')
        + ' tools=' + (this.capabilities.tools ? '有' : '无')
        + ' resources=' + (this.capabilities.resources ? '有' : '无')
        + ' prompts=' + (this.capabilities.prompts ? '有' : '无'));
      return { ok: true, serverInfo: this.serverInfo, capabilities: this.capabilities };
    } catch (e) {
      this._rejectAllPending('握手失败: ' + e.message);
      this.status = 'failed';
      this.error = e.message + (this._stderrTail.length ? '（stderr: ' + this._stderrTail.slice(-3).join(' | ') + '）' : '');
      this._warn('握手失败: ' + this.error);
      // 握手失败别留一个孤儿进程
      this._killChild();
      return { ok: false, error: this.error };
    }
  }

  /** stdout 增量解析：按 \n 切行，逐行 JSON.parse；残片留在缓冲区 */
  _onStdout(chunk) {
    this._buffer += chunk.toString('utf8');
    let nl;
    while ((nl = this._buffer.indexOf('\n')) !== -1) {
      const line = this._buffer.slice(0, nl).trim();
      this._buffer = this._buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        // 不是合法 JSON —— 多数情况是 server 往 stdout 打了日志。不中断，记一笔
        this._warn('收到非 JSON 行（已忽略）: ' + line.slice(0, 120));
        continue;
      }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    // 响应：带 id
    if (msg && msg.id !== undefined && msg.id !== null) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;                // 超时后迟到的响应，丢弃
      this.pending.delete(msg.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (msg.error) {
        const e = new Error(msg.error.message || JSON.stringify(msg.error));
        e.code = msg.error.code;
        entry.reject(e);
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    // 请求：server 反向调用我们（如 sampling / roots/list），本客户端一律明确拒绝
    if (msg && msg.method) {
      this._warn('收到 server 反向请求，本客户端不支持: ' + msg.method);
      try {
        this._send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not supported: ' + msg.method } });
      } catch (e) { /* 进程可能已死*/ }
      return;
    }
    // 通知：忽略（日志类）
    if (msg && msg.method) this._log('收到通知: ' + msg.method);
  }

  _send(payload) {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) {
      throw new Error('MCP 进程未运行，无法发送消息');
    }
    this.proc.stdin.write(JSON.stringify(payload) + '\n');
  }

  _notify(method, params) {
    this._send({ jsonrpc: '2.0', method, params: params || {} });
  }

  _request(method, params, deadlineAt) {
    return new Promise((resolve, reject) => {
      const id = nextRequestId++;
      const runAt = deadlineAt || (Date.now() + this.callTimeoutMs);
      const ms = Math.max(1000, runAt - Date.now());
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('调用超时（>' + ms + 'ms）: ' + method));
      }, ms);
      if (timer.unref) timer.unref();
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this._send({ jsonrpc: '2.0', id, method, params: params || {} });
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  _rejectAllPending(reason) {
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      try { entry.reject(new Error(reason)); } catch (e) { /* noop */ }
    }
    this.pending.clear();
  }

  _killChild() {
    const p = this.proc;
    this.proc = null;
    if (!p) return;
    try { p.kill(); } catch (e) { /* 已退出 */ }
    // Windows 下 npx 会再套一层 cmd，kill 父进程可能留孤儿；延迟再kill 一次
    setTimeout(() => { try { if (!p.killed) p.kill('SIGKILL'); } catch (e) { /* noop */ } }, 1500).unref?.();
  }

  /** 列出工具；结果缓存，restart 或 invalidate 后失效 */
  async listTools(force) {
    if (this.toolsCache && !force) return this.toolsCache;
    if (!this.capabilities.tools) return [];
    const res = await this._request('tools/list', {}, Date.now() + this.callTimeoutMs);
    const list = (res && Array.isArray(res.tools)) ? res.tools : [];
    this.toolsCache = list;
    return list;
  }

  /** 调用工具。返回 {isError, content, raw} —— 不做业务解读，交给调用方 */
  async callTool(name, args) {
    const res = await this._request('tools/call', { name, arguments: args || {} }, Date.now() + this.callTimeoutMs);
    return {
      isError: !!(res && res.isError),
      content: (res && res.content) || [],
      structuredContent: res ? res.structuredContent : undefined,
      raw: res
    };
  }

  /** resources/list（server 不支持时返回空数组，不抛错） */
  async listResources() {
    if (!this.capabilities.resources) return [];
    try {
      const res = await this._request('resources/list', {}, Date.now() + this.callTimeoutMs);
      return (res && Array.isArray(res.resources)) ? res.resources : [];
    } catch (e) {
      this._warn('resources/list 失败: ' + e.message);
      return [];
    }
  }

  async readResource(uri) {
    const res = await this._request('resources/read', { uri }, Date.now() + this.callTimeoutMs);
    return res;
  }

  async listPrompts() {
    if (!this.capabilities.prompts) return [];
    try {
      const res = await this._request('prompts/list', {}, Date.now() + this.callTimeoutMs);
      return (res && Array.isArray(res.prompts)) ? res.prompts : [];
    } catch (e) {
      this._warn('prompts/list 失败: ' + e.message);
      return [];
    }
  }

  async getPrompt(name, args) {
    return this._request('prompts/get', { name, arguments: args || {} }, Date.now() + this.callTimeoutMs);
  }

  /** 停止：先reject 所有 pending，再杀进程 */
  async stop() {
    this._rejectAllPending('服务器已手动停止');
    this._killChild();
    this.toolsCache = null;
    if (this.status !== 'crashed' && this.status !== 'failed') this.status = 'stopped';
    this._log('已停止');
    return { ok: true };
  }

  /** 重启：崩溃后的显式恢复入口（刻意不做自动重连） */
  async restart() {
    this._log('手动重启');
    await this.stop();
    this.status = 'stopped';
    this.error = null;
    this.serverInfo = null;
    this.capabilities = {};
    this.protocolVersion = null;
    return this.start();
  }

  /** 供 UI 展示的只读状态 */
  info() {
    return {
      id: this.id,
      command: this.command,
      args: this.args,
      status: this.status,
      error: this.error,
      pid: this.proc ? this.proc.pid : null,
      protocolVersion: this.protocolVersion,
      serverInfo: this.serverInfo,
      capabilities: {
        tools: !!this.capabilities.tools,
        resources: !!this.capabilities.resources,
        prompts: !!this.capabilities.prompts
      },
      toolCount: this.toolsCache ? this.toolsCache.length : null,
      stderrTail: this._stderrTail.slice(-5)
    };
  }
}

module.exports = { McpStdioClient, CLIENT_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS };