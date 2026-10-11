/**
 * MCP 客户端 —— 远程 Streamable HTTP 传输
 * ============================================================
 * 与 McpStdioClient 接口对齐（start / listTools / callTool / stop / info），
 * 区别在于：不起子进程，而是向一个远程 URL 反复 POST JSON-RPC 2.0。
 *
 * 适配飞书官方远程 MCP（https://mcp.feishu.cn/mcp）这类端点：
 *   · 每次请求都是 POST 同一个 URL，请求体是完整 JSON-RPC 信封；
 *   · 鉴权走自定义请求头（飞书用 X-Lark-MCP-TAT / X-Lark-MCP-UAT）；
 *   · 必须带 X-Lark-MCP-Allowed-Tools，否则服务端不暴露任何工具。
 *
 * 这是 Streamable HTTP 的「无状态 POST」变体：不维护长连接/SSE，
 * initialize 握手后，tools/list、tools/call 各自是一次独立 POST。
 */

let nextRequestId = 1;

class McpHttpClient {
  /**
   * @param {object} cfg
   * @param {string} cfg.id
   * @param {string} cfg.url           远程 MCP 端点（https）
   * @param {object} [cfg.headers]     已解析好的请求头（鉴权等），值不再含占位符
   * @param {string[]} [cfg.allowedTools] 允许暴露的工具名清单
   * @param {number} [cfg.startupTimeoutMs]
   * @param {number} [cfg.callTimeoutMs]
   */
  constructor(cfg) {
    this.id = cfg.id;
    this.url = cfg.url;
    this.headers = cfg.headers || {};
    this.allowedTools = Array.isArray(cfg.allowedTools) ? cfg.allowedTools : [];
    this.startupTimeoutMs = cfg.startupTimeoutMs || 30000;
    this.callTimeoutMs = cfg.callTimeoutMs || 60000;

    this.status = 'stopped';        // stopped | starting | ready | crashed | failed
    this.error = null;
    this.serverInfo = null;
    this.capabilities = {};
    this.protocolVersion = null;
    this.sessionId = null;          // 标准 Streamable HTTP：initialize 后服务端下发
    this.toolsCache = null;
    this._log('HTTP 客户端已创建（尚未连接）');
  }

  _log(msg) { console.log('[MCP:' + this.id + '] ' + msg); }
  _warn(msg) { console.warn('[MCP:' + this.id + '] ' + msg); }

  /** 拼装请求头：固定 JSON 内容类型 + 鉴权头 + 允许工具清单 + 会话 id */
  _headers() {
    const h = Object.assign({
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    }, this.headers);
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    if (this.allowedTools.length) {
      h['X-Lark-MCP-Allowed-Tools'] = this.allowedTools.join(',');
    }
    return h;
  }

  /** 把响应体解析成 JSON-RPC 结果。兼容两种返回：
   *  · 直接 application/json；
   *  · text/event-stream（SSE）：逐条 data: 行，取带 id/result 的那条。 */
  async _parseResponse(res) {
    const ctype = res.headers.get('content-type') || '';
    // 记录会话 id（initialize 时服务端下发）
    const sid = res.headers.get('mcp-session-id');
    if (sid && !this.sessionId) { this.sessionId = sid; this._log('获得会话 id: ' + sid); }
    const text = await res.text();
    if (ctype.includes('text/event-stream')) {
      // SSE：逐行找 data: 后的 JSON
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const msg = JSON.parse(payload);
          if (msg.error) { const e = new Error(msg.error.message || JSON.stringify(msg.error)); e.code = msg.error.code; throw e; }
          return msg.result;
        } catch (e) { if (e instanceof Error && e.code) throw e; /* 非 JSON 行跳过 */ }
      }
      throw new Error('SSE 响应中未找到 JSON-RPC 消息');
    }
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('响应不是合法 JSON'); }
    if (data.error) {
      const e = new Error(data.error.message || JSON.stringify(data.error));
      e.code = data.error.code;
      throw e;
    }
    return data.result;
  }

  async _post(method, params, timeoutMs, withId) {
    let body;
    if (withId === false) {
      // 通知类（notifications/initialized）：无 id，不等响应
      body = { jsonrpc: '2.0', method, params: params || {} };
    } else {
      body = { jsonrpc: '2.0', id: nextRequestId++, method, params: params || {} };
    }
    let res;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (e) {
      throw new Error('网络请求失败: ' + e.message);
    }
    if (!res.ok) {
      let detail = '';
      try { detail = await res.text(); } catch (e) { /* ignore */ }
      throw new Error('HTTP ' + res.status + (detail ? '：' + detail.slice(0, 200) : ''));
    }
    if (withId === false) return null;
    return this._parseResponse(res);
  }

  /** initialize 握手；重复调用幂等 */
  async start() {
    if (this.status === 'ready') return { ok: true, cached: true };
    if (this.status === 'starting') throw new Error('MCP 服务器「' + this.id + '」正在连接中');
    if (!this.url) {
      this.status = 'failed';
      this.error = '未配置远程地址 url';
      return { ok: false, error: this.error };
    }

    this.status = 'starting';
    this.error = null;
    try {
      const initRes = await this._post('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: { roots: { listChanged: false }, sampling: {} },
        clientInfo: { name: 'fuling-shijie', version: '1.0.7' }
      }, this.startupTimeoutMs);

      this.protocolVersion = (initRes && initRes.protocolVersion) || '2025-06-18';
      this.serverInfo = (initRes && initRes.serverInfo) || null;
      this.capabilities = (initRes && initRes.capabilities) || { tools: {} };

      // initialized 通知（无 id，不等响应）
      try { await this._post('notifications/initialized', {}, this.startupTimeoutMs, false); }
      catch (e) { /* 通知失败不阻断握手 */ }

      this.status = 'ready';
      this.error = null;
      this._log('远程 MCP 握手完成 server=' + ((this.serverInfo && this.serverInfo.name) || this.url));
      return { ok: true, serverInfo: this.serverInfo, capabilities: this.capabilities };
    } catch (e) {
      this.status = 'failed';
      this.error = e.message;
      this._warn('握手失败: ' + this.error);
      return { ok: false, error: this.error };
    }
  }

  async listTools(force) {
    if (this.toolsCache && !force) return this.toolsCache;
    const res = await this._post('tools/list', {}, this.callTimeoutMs);
    const list = (res && Array.isArray(res.tools)) ? res.tools : [];
    this.toolsCache = list;
    return list;
  }

  async callTool(name, args) {
    const res = await this._post('tools/call', { name, arguments: args || {} }, this.callTimeoutMs);
    return {
      isError: !!(res && res.isError),
      content: (res && res.content) || [],
      structuredContent: res ? res.structuredContent : undefined,
      raw: res
    };
  }

  async stop() {
    this.toolsCache = null;
    this.status = 'stopped';
    this._log('已断开远程连接');
    return { ok: true };
  }

  async restart() {
    this.status = 'stopped';
    this.error = null;
    this.toolsCache = null;
    return this.start();
  }

  info() {
    return {
      id: this.id,
      url: this.url,
      status: this.status,
      error: this.error,
      protocolVersion: this.protocolVersion,
      serverInfo: this.serverInfo,
      capabilities: {
        tools: !!this.capabilities.tools,
        resources: !!this.capabilities.resources,
        prompts: !!this.capabilities.prompts
      },
      toolCount: this.toolsCache ? this.toolsCache.length : null,
      stderrTail: []
    };
  }
}

module.exports = { McpHttpClient };
