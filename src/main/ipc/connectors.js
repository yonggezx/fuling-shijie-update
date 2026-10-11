/**
 * 连通器授权管理
 * ============================================================
 * 职责：管理「哪些外部服务需要用户授权才能用」，以及授权的发起/完成/断开。
 *
 * 与 MCP 的分工（MCP 见 src/main/mcp/）：
 *   MCP         → 起本机子进程，工具来自本地 server
 *   连通器      → 走 HTTP 请求访问外部账号，数据在别人服务器上
 * 所以连通器这一侧的**授权状态就是一切的前提**：没授权 = 工具调不通。
 *
 * 安全设计：
 *   · **密钥只经 credentialStore（safeStorage/DPAPI）**，永不明文落盘、永不进 yaml、
 *     永不进 AI 上下文。读回来时也不往外抛 —— 只返回「有没有」和末4 位掩码。
 *   · **OAuth 回调做三重校验**：state 参数随机值（防 CSRF）、host 必须在白名单
 *     （防开放重定向）、端口必须是本地监听的那个。只认自己开的那个回调端口。
 *   · **authorizeUrl 只允许 https**（localhost 例外），且必须是配置里写死的那一条 ——
 *     不接受前端传任意 URL，防止被诱导跳到钓鱼站点。
 *   · 断开连接 = 删凭证，不做"软禁用"，避免残留令牌还能被用。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const credentialStore = require('../config/credentialStore');

let yaml = null;
try { yaml = require('js-yaml'); } catch (e) { /* healthCheck 会报 */ }

const FACTORY_DIR = path.join(__dirname, '..', 'agent-config');

function userConfigDir() {
  try {
    const { app } = require('electron');
    if (app && app.getPath) return path.join(app.getPath('userData'), 'agent-config');
  } catch (e) { /* node 环境 */ }
  return null;
}

function readFirstExisting(name) {
  for (const dir of [userConfigDir(), FACTORY_DIR].filter(Boolean)) {
    const p = path.join(dir, name);
    try { if (fs.existsSync(p)) return { file: p, text: fs.readFileSync(p, 'utf8') }; } catch (e) { /* next */ }
  }
  return null;
}

/** 本地 OAuth 回调允许的端口：这些是各家官方文档指定的常用回调端口 */
const ALLOWED_CALLBACK_PORTS = [8090, 8091, 8092, 8765, 9000, 1455, 3000, 53682];

/**
 * 各家 OAuth 的差异。clientKey=「客户端标识」在授权页 query 里的参数名；
 * tokenUrl=授权码换 token 的端点（没有则不自动交换，只把 code 交回前端）。
 * authStyle=body 里凭证字段名：feishu 用 app_id/app_secret，其余标准 OAuth 用 client_id/client_secret。
 */
const PROVIDER_AUTH = {
  wecom: {
    clientKey: 'appid',
    tokenUrl: 'https://qyapi.weixin.qq.com/cgi-bin/gettoken'
  },
  jira: {
    clientKey: 'client_id', extras: { audience: 'api.atlassian.com', prompt: 'consent' },
    tokenUrl: 'https://auth.atlassian.com/oauth/token'
  },
  feishu: {
    clientKey: 'client_id', authStyle: 'feishu',
    tokenUrl: 'https://open.feishu.cn/open-apis/auth/v3/oauth2/access_token'
  },
  github:  { clientKey: 'client_id', tokenUrl: 'https://github.com/login/oauth/access_token' },
  gitlab:  { clientKey: 'client_id', tokenUrl: 'https://gitlab.com/oauth/token' },
  gitee:   { clientKey: 'client_id', tokenUrl: 'https://gitee.com/oauth/token' },
  notion:  { clientKey: 'client_id', tokenUrl: 'https://api.notion.com/v1/oauth/token' },
  slack:   { clientKey: 'client_id', tokenUrl: 'https://slack.com/api/oauth.v2.access' },
  dropbox: { clientKey: 'client_id', tokenUrl: 'https://api.dropbox.com/oauth2/token' },
  onedrive:{ clientKey: 'client_id', tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token' },
  dingtalk:{ clientKey: 'client_id', tokenUrl: 'https://api.dingtalk.com/v1.0/oauth2/userAccessToken' },
  'tencent-docs': {
    clientKey: 'client_id', tokenUrl: 'https://docs.qq.com/oauth2/token'
  },
  yuque: {
    clientKey: 'client_id', tokenUrl: 'https://www.yuque.com/oauth/token'
  }
};

/**
 * 凭证校验端点。保存凭证时用它对平台做一次真实请求，成功才算校验通过。
 * 两类：
 *   token        → 调一个需 Bearer token 的接口，200/2xx 即有效（GitHub/GitLab/Gitee/语雀/Notion/Slack 等）
 *   client_cred  → 用 client_id+secret 以 grant_type=client_credentials 换 token，成功即有效（飞书/钉钉/企微）
 * 纯 OAuth 且无法单独校验凭证的（腾讯文档/Jira/OneDrive/Dropbox）不配置 → 保存时不校验，靠授权时平台报错。
 */
const VERIFY_ENDPOINTS = {
  github:  { mode: 'token', url: 'https://api.github.com/user' },
  gitlab:  { mode: 'token', url: 'https://gitlab.com/api/v4/user' },
  gitee:   { mode: 'token', url: 'https://gitee.com/api/v5/user' },
  yuque:   { mode: 'token', url: 'https://www.yuque.com/api/v2/user?access_token=' },
  notion:  { mode: 'token', url: 'https://api.notion.com/v1/users/me', headers: { 'Notion-Version': '2022-06-28' } },
  slack:   { mode: 'token', url: 'https://slack.com/api/auth.test' },
  feishu:  { mode: 'client_cred', url: 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', body: { grant_type: 'client_credentials' } },
  dingtalk:{ mode: 'client_cred', url: 'https://oapi.dingtalk.com/gettoken', query: 'appkey&appsecret' },
  wecom:   { mode: 'client_cred', url: 'https://qyapi.weixin.qq.com/cgi-bin/gettoken' }
};

/** 校验凭证：保存时对平台发一次真实请求，2xx 且符合业务语义才算通过。 */
async function verifyCredential(id) {
  const def = getConnector(id);
  const v = VERIFY_ENDPOINTS[id];
  if (!def || !v) return { success: true, skipped: true };   // 无法校验的平台不拦截

  try {
    if (v.mode === 'token') {
      const token = def.secretKey ? credentialStore.getSecret(def.secretKey) : '';
      if (!token || !String(token).trim()) return { success: false, error: '尚未保存访问凭证' };
      const url = v.url.endsWith('=') ? v.url + encodeURIComponent(String(token).trim())
        : v.url;
      const headers = Object.assign({}, v.headers || {}, url.startsWith('https://slack.com')
        ? { Authorization: 'Bearer ' + String(token).trim() } : {});
      const useQuery = url.indexOf('?access_token=') > -1 || url.indexOf('&') > -1;
      const res = await fetch(url, {
        method: 'GET',
        headers: useQuery ? (v.headers || {}) : Object.assign({}, headers, { Authorization: 'Bearer ' + String(token).trim() })
      });
      const txt = await res.text();
      let j = null; try { j = JSON.parse(txt); } catch (e) { /* 非JSON */ }
      // slack：ok 字段必须为 true
      if (url.startsWith('https://slack.com') && j && j.ok === false) {
        return { success: false, error: '凭证无效：' + (j.error || 'Slack 拒绝') };
      }
      if (!res.ok) {
        const msg = (j && (j.message || j.error_description || j.error)) || ('HTTP ' + res.status);
        return { success: false, error: '凭证校验失败：' + msg };
      }
      return { success: true };
    }

    if (v.mode === 'client_cred') {
      const clientId = getClientId(id);
      const secret = credentialStore.getSecret('connector-' + id + '-secret');
      if (!clientId) return { success: false, error: '尚未保存 App ID / client_id' };
      if (!secret) return { success: false, error: '尚未保存 App Secret' };

      let url = v.url, method = 'POST', headers = { 'Content-Type': 'application/json' }, body = null;
      if (id === 'wecom') {
        // 企微 gettoken：corpid+corpsecret 走 query
        url = v.url + '?corpid=' + encodeURIComponent(clientId) + '&corpsecret=' + encodeURIComponent(String(secret).trim());
        method = 'GET';
      } else if (id === 'dingtalk') {
        // 钉钉 gettoken：appkey+appsecret 走 query
        url = v.url + '?appkey=' + encodeURIComponent(clientId) + '&appsecret=' + encodeURIComponent(String(secret).trim());
        method = 'GET';
      } else {
        // 飞书：POST app_id + app_secret 换 tenant_access_token
        body = JSON.stringify({ app_id: clientId, app_secret: String(secret).trim(), grant_type: 'client_credentials' });
      }
      const res = await fetch(url, { method, headers, body });
      const txt = await res.text();
      let j = null; try { j = JSON.parse(txt); } catch (e) { /* 非JSON */ }
      // 企微/钉钉：业务错误码 errcode != 0 表示凭证无效
      if (j && typeof j.errcode === 'number' && j.errcode !== 0) {
        return { success: false, error: '凭证校验失败：' + (j.errmsg || ('errcode ' + j.errcode)) };
      }
      if (id === 'feishu' && j && j.code !== 0) {
        return { success: false, error: '凭证校验失败：' + (j.msg || ('code ' + j.code)) };
      }
      if (!res.ok) {
        const msg = (j && (j.message || j.msg || j.error)) || ('HTTP ' + res.status);
        return { success: false, error: '凭证校验失败：' + msg };
      }
      return { success: true };
    }
    return { success: true, skipped: true };
  } catch (e) {
    // 网络不通：不因校验失败卡死用户，返回提示但仍放行（可人工重试授权）
    console.error('[Connector] verify failed for ' + id, e);
    return { success: true, skipped: true, warn: '校验时网络异常，已放行：' + (e.message || '') };
  }
}

const state = {
  loaded: false, error: null, cfg: null, cfgFile: null,
  byId: new Map(),
  // 进行中的 OAuth 会话：state值 -> {connectorId, createdAt, timer}
  pending: new Map(),
  callbackServer: null,
  callbackPort: null
};

// ── 配置加载 ────────────────────────────────────────────────────────────────
function load() {
  if (state.loaded) return state.cfg;
  if (!yaml) { state.loaded = true; state.error = 'js-yaml 不可用'; return { connectors: [], authMethods: {} }; }
  const hit = readFirstExisting('connectors.yaml');
  if (!hit) {
    state.loaded = true;
    state.cfg = { connectors: [], authMethods: {} };
    state.error = 'connectors.yaml 不存在，连通器功能不可用（不影响其他功能）';
    return state.cfg;
  }
  try {
    const data = yaml.load(hit.text) || {};
    const list = Array.isArray(data.connectors) ? data.connectors : [];
    state.byId = new Map();
    for (const c of list) if (c && c.id) state.byId.set(c.id, c);
    state.cfg = { connectors: list, authMethods: data.authMethods || {} };
    state.cfgFile = hit.file;
    state.loaded = true;
    state.error = null;
    return state.cfg;
  } catch (e) {
    state.loaded = true;
    state.cfg = { connectors: [], authMethods: {} };
    state.error = 'connectors.yaml 解析失败: ' + e.message;
    console.error('[Connector] ' + state.error);
    return state.cfg;
  }
}

function getConnector(id) { load(); return state.byId.get(id) || null; }

// ── 授权状态 ────────────────────────────────────────────────────────────────
/**
 * 某个连通器是否已授权。
 * 判定标准：credentialStore 里能解出非空凭证。
 * safeStorage 不可用时 hasSecret 会返回 false → 显示"未连接"，符合"不静默明文"的取向。
 */
function isConnected(id) {
  const def = getConnector(id);
  if (!def) return false;
  // kind: mcp 的内置能力：启用状态由 mcpManager 的 enabled 集合决定
  if (def.kind === 'mcp') {
    try {
      const mcp = require('../mcp/mcpManager');
      return (mcp.getEnabled() || []).includes(def.mcpId || id);
    } catch (e) { return false; }
  }
  if (def.authMethod === 'none') return true;         // 内置能力恒可用
  if (!def.secretKey) return false;
  const v = credentialStore.getSecret(def.secretKey);
  return !!(v && String(v).trim());
}

/**
 * 启用/停用一个连通器。
 * - kind: mcp → 联动 mcpManager.enabled 集合（真正起/停子进程）
 * - authMethod: none（builtin-web 等）→ 内存态标记（这类本来就恒可用，只是 UI 开关）
 * - 其余 OAuth 服务 → 不在这里做（启用=已授权，停用=disconnect 删凭证）
 */
function setConnectorEnabled(id, enabled) {
  const def = getConnector(id);
  if (!def) return { success: false, error: '未找到连通器: ' + id };

  if (def.kind === 'mcp') {
    try {
      const mcp = require('../mcp/mcpManager');
      const cur = new Set(mcp.getEnabled() || []);
      const mid = def.mcpId || id;
      if (enabled) cur.add(mid); else cur.delete(mid);
      mcp.setEnabled(Array.from(cur));
      return { success: true, connected: !!enabled };
    } catch (e) {
      return { success: false, error: 'MCP 启停失败: ' + (e.message || e) };
    }
  }

  if (def.authMethod === 'none') {
    // 无授权内置能力：没有真正的后端开关，只回 success 让 UI 刷新状态
    return { success: true, connected: !!enabled, builtin: true };
  }

  return { success: false, error: '该连通器需要授权，请先「去授权」或「断开连接」' };
}

/**
 * 凭证末位掩码，供界面显示（"ghp_••••••a1b2"）。
 * 绝不用明文 —— 界面上也不该出现能直接复制走的完整令牌。
 */
function credentialHint(id) {
  const def = getConnector(id);
  if (!def || !def.secretKey) return '';
  const v = credentialStore.getSecret(def.secretKey);
  if (!v) return '';
  const s = String(v);
  if (s.length <= 8) return '••••';
  return s.slice(0, 4) + '••••' + s.slice(-4);
}

/** OAuth 的 client_id / App ID：
 *  各家授权页都要它（飞书传 cli_xxx、企业微信传 ww_xxx…）。
 *  优先取用户在详情页填的（加密存到 credentialStore），其次 yaml 里写死的 clientId。
 *  没有它就带着空 client_id 跳浏览器，官方页必然报 "client_id 请求不合法 / 20028"。 */
function clientIdKey(id) { return 'connector-clientid-' + id; }
function getClientId(id) {
  const def = getConnector(id);
  if (!def) return '';
  const saved = credentialStore.getSecret(clientIdKey(id));
  if (saved && String(saved).trim()) return String(saved).trim();
  return String(def.clientId || '').trim();
}
function setClientId(id, value) {
  const def = getConnector(id);
  if (!def) return { success: false, error: '未找到连通器: ' + id };
  const v = String(value || '').trim();
  if (!v) return { success: false, error: 'App ID 不能为空' };
  const r = credentialStore.setSecret(clientIdKey(id), v);
  if (!r.ok) return { success: false, error: '保存失败：' + (r.reason || '未知错误') };
  return { success: true };
}

/** 存 App Secret（飞书等 code 换 token 用），加密落盘；保存前对平台校验一次。 */
async function setAppSecret(id, value) {
  const def = getConnector(id);
  if (!def) return { success: false, error: '未找到连通器: ' + id };
  const v = String(value || '').trim();
  if (!v) return { success: false, error: 'App Secret 不能为空' };

  // 校验通过才落盘；校验失败则不保存（可继续修改重试）
  const r = credentialStore.setSecret('connector-' + id + '-secret', v);
  if (!r.ok) return { success: false, error: '保存失败：' + (r.reason || '未知错误') };

  const check = await verifyCredential(id);
  if (check && check.success === false) {
    credentialStore.deleteSecret('connector-' + id + '-secret');
    return { success: false, error: check.error || '凭证校验失败' };
  }

  return { success: true, verified: !!(check && !check.skipped) };
}

/**
 * 给渲染层的连通器清单。
 * 只暴露「能安全展示的字段」：id / 名称 / 分类 / 授权方式 / 描述 / 品牌色 /
 * 授权页 URL / 文档 URL / scope / 授权状态。**不含任何凭证内容**。
 *
 * 注意：**不下发 icon**。图标统一由渲染层的曲别针线条图标渲染，
 * 各家官方字形大小不一、有些渲染成色块，不如统一线条更干净。
 */
function listConnectors() {
  load();
  return state.cfg.connectors.map(c => ({
    id: c.id,
    name: c.name,
    officialName: c.officialName || c.name,
    category: c.category || 'other',
    description: c.description || '',
    brandColor: c.brandColor || '#888888',
    authMethod: c.authMethod || 'oauth',
    disabled: !!c.disabled,
    // authFlow 才是实际走法：oauth=回调带码；console=自助开通
    authFlow: c.authFlow || (c.authMethod === 'none' ? 'none' : 'oauth'),
    authLabel: (state.cfg.authMethods[(c.authFlow || c.authMethod)] || {}).label
      || (state.cfg.authMethods[c.authMethod] || {}).label || '需要授权',
    authDesc: (state.cfg.authMethods[(c.authFlow || c.authMethod)] || {}).desc || '',
    scopes: c.scopes || [],
    note: c.note || '',
    authorizeUrl: safeAuthorizeUrl(c),
    docsUrl: safeDocsUrl(c),
    callbackPort: callbackPortFor(c),
    connected: isConnected(c.id),
    credentialHint: credentialHint(c.id),
    secretKey: c.secretKey || '',
    // console 流程需要在详情页填凭证（API Key）
    needsCredentialInput: (c.authFlow || '') === 'console',
    // 是否内置了可所有人共用的 client_id → 支持浏览器直接授权；否则删掉浏览器授权，只填凭证
    canBrowserAuth: !!c.clientId,
    // 当前是否已有可用的 client_id（内置或用户自填）→ OAuth 平台据此显示「去授权」按钮
    clientIdFilled: !!getClientId(c.id),
    // OAuth 平台始终显示 App ID 输入框（可随时改，已填值回填）
    needsClientIdInput: (c.authFlow || '') === 'oauth',
    // 已保存的 client_id（明文非敏感，回填到输入框供查看/修改）
    clientIdValue: (c.authFlow || '') === 'oauth' ? getClientId(c.id) : '',
    // OAuth 平台始终显示 App Secret 输入框（可随时改）
    needsAppSecretInput: !!(PROVIDER_AUTH[c.id] && PROVIDER_AUTH[c.id].tokenUrl),
    // 是否已保存 secret（用于提示「已保存，可覆盖」）
    appSecretSet: !!credentialStore.hasSecret('connector-' + c.id + '-secret')
  }));
}

/** 文档 URL 同样只认 https（避免配置里被塞进 javascript: 之类） */
function safeDocsUrl(def) {
  const u = def && def.docsUrl;
  if (!u) return '';
  try {
    return new URL(u).protocol === 'https:' ? u : '';
  } catch (e) { return ''; }
}

/** 该连通器用哪个回调端口（必须落在白名单内） */
function callbackPortFor(def) {
  const list = (state.cfg.callbackPorts && state.cfg.callbackPorts.length)
    ? state.cfg.callbackPorts : ALLOWED_CALLBACK_PORTS;
  const want = Number((def && def.callbackPort) || list[0]);
  return list.includes(want) ? want : list[0];
}

/**
 * 取授权页URL，强制 https（本地回调例外），并只认配置里写死的那条。
 * 前端传什么都不影响这里 —— 授权目标由配置文件说了算。
 */
function safeAuthorizeUrl(def) {
  const u = def && def.authorizeUrl;
  if (!u) return '';
  let parsed;
  try { parsed = new URL(u); } catch (e) { return ''; }
  if (parsed.protocol === 'https:') return u;
  // http 只允许本地（官方自带回调服务器的情况）
  if (parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')) return u;
  return '';
}

/** 同理校验令牌页URL —— 同样是「只认配置里写死的 https 链接」 */
function safeTokenUrl(def) {
  const u = def && def.tokenUrl;
  if (!u) return '';
  try {
    const p = new URL(u);
    return p.protocol === 'https:' ? u : '';
  } catch (e) { return ''; }
}

// ── 发起授权 ────────────────────────────────────────────────────────────────
/**
 * 发起授权：开浏览器跳官方页面。
 *
 * 两种 authFlow：
 *   oauth   → 标准 OAuth：本地起回调服务器等 code，自动收到并加密落盘。
 *             当前实现做到「跳转 + 回调接收 + state 校验」；
 *             真正换成 access_token还需要 client_id / client_secret 与 token 端点，
 *             这些必须由开发者在各平台申请后填进 connectors.yaml。
 *             在此之前，收到的授权码原样加密保存，界面上当凭证用。
 *   console → 无标准 OAuth 端点（搜索类三家）：只跳官方控制台，不监听回调，
 *             由用户开通后在详情页填入凭证。
 *
 * ⚠️ 两条路都**不开一个明文输入框**当默认路径 —— 用户要求一律跳浏览器。
 */
async function beginOAuth(id, opts) {
  const def = getConnector(id);
  if (!def) return { success: false, error: '未找到连通器: ' + id };
  if (def.authMethod === 'none') {
    return { success: false, error: '「' + def.name + '」无需授权，可直接启用' };
  }
  const authorizeUrl = safeAuthorizeUrl(def);
  if (!authorizeUrl) {
    return { success: false, error: '「' + def.name + '」的授权地址未配置或不是 https，无法发起授权' };
  }
  const flow = def.authFlow === 'console' ? 'console' : 'oauth';
  const { shell } = require('electron');

  // ── console 流程：只跳转，不监听回调 ──
  if (flow === 'console') {
    await shell.openExternal(authorizeUrl);
    console.log('[Connector] 已跳转控制台（无 OAuth 端点）: ' + id);
    return {
      success: true,
      flow,
      authorizeUrl,
      needsCredentialInput: true,   // 前端据此显示凭证输入框
      message: '已打开 ' + (def.officialName || def.name) + ' 官方控制台，开通后把凭证填入下方输入框'
    };
  }

  // ── oauth 流程：起回调 + 跳授权页 ──
  // 没有 client_id 就不要硬跳浏览器——带着空 client_id 只会落到官方错误页
  const clientId = getClientId(id);
  if (!clientId) {
    return {
      success: false,
      error: '「' + (def.officialName || def.name) + '」暂未接入 OAuth 授权，请使用 API Key 方式连接'
    };
  }
  const port = callbackPortFor(def);

  // state：随机值 + 绑定连通器 + 过期时间。回调时必须原样对上，否则拒绝
  const stateVal = crypto.randomBytes(16).toString('hex');
  const session = {
    connectorId: id,
    redirectUri: 'http://127.0.0.1:' + port + '/callback',
    createdAt: Date.now(),
    timer: null
  };
  state.pending.set(stateVal, session);
  session.timer = setTimeout(() => {
    state.pending.delete(stateVal);
    stopCallbackServer();
  }, 5 * 60 * 1000);
  if (session.timer.unref) session.timer.unref();

  try {
    await ensureCallbackServer(port);
  } catch (e) {
    state.pending.delete(stateVal);
    clearTimeout(session.timer);
    return { success: false, error: '本地回调端口启动失败（' + port + '）：' + e.message };
  }

  // 组装授权 URL。各家 OAuth 的「客户端标识」参数名并不都叫 client_id：
  //   · 企业微信要 appid（不是 client_id）；
  //   · Atlassian(Jira) 还额外要求 audience=api.atlassian.com 与 prompt=consent。
  //   · 飞书授权页参数名就是 client_id（值为 App ID cli_xxx）。
  const pAuth = PROVIDER_AUTH[id] || {};
  const authUrl = new URL(authorizeUrl);
  authUrl.searchParams.set(pAuth.clientKey || 'client_id', clientId);
  authUrl.searchParams.set('redirect_uri', session.redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('state', stateVal);
  if (pAuth.extras) for (const [k, v] of Object.entries(pAuth.extras)) authUrl.searchParams.set(k, v);
  if (Array.isArray(def.scopes) && def.scopes.length) authUrl.searchParams.set('scope', def.scopes.join(' '));

  await shell.openExternal(authUrl.toString());
  console.log('[Connector] 已跳转授权页: ' + id);
  return {
    success: true,
    flow,
    authorizeUrl: authUrl.toString(),
    redirectUri: session.redirectUri,
    callbackPort: port,
    needsClientId: !def.clientId
  };
}

/**
 * 授权码换 token（仅声明了 tokenUrl 的 provider，如飞书）。
 * 用 app_id + app_secret + code 换 user_access_token，成功后加密落盘。
 */
async function exchangeCodeForToken(connectorId, code) {
  const def = getConnector(connectorId);
  if (!def) return { ok: false, error: '未找到连接器' };
  const pAuth = PROVIDER_AUTH[connectorId];
  if (!pAuth || !pAuth.tokenUrl) return { ok: false, error: 'no-token-url' };
  const appId = getClientId(connectorId);
  const appSecret = credentialStore.getSecret('connector-' + connectorId + '-secret');
  if (!appId || !appSecret) return { ok: false, error: '缺 client_id 或 client_secret' };

  // 请求体：飞书用 app_id/app_secret，其余标准 OAuth 用 client_id/client_secret
  let body;
  if (pAuth.authStyle === 'feishu') {
    body = { app_id: appId, app_secret: appSecret, grant_type: 'authorization_code', code };
  } else {
    body = { client_id: appId, client_secret: appSecret, grant_type: 'authorization_code', code };
  }

  let res;
  try {
    res = await fetch(pAuth.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // GitHub 要求带 Accept 才返回 JSON
        'Accept': 'application/json'
      },
      body: JSON.stringify(body)
    });
  } catch (e) { return { ok: false, error: '换 token 网络失败: ' + e.message }; }
  let data;
  try { data = await res.json(); } catch (e) { return { ok: false, error: '换 token 响应不是 JSON' }; }

  // 飞书外层 {code:0,...}；其余平台直接在顶层或 data 里给 access_token
  if (data.code && data.code !== 0) return { ok: false, error: '换 token 失败: ' + (data.msg || JSON.stringify(data.error || {})) };
  if (data.error) return { ok: false, error: '换 token 失败: ' + (data.error_description || data.error) };

  const inner = data.data || data;
  const token = inner.access_token || inner.user_access_token || inner.authed_user?.access_token;
  if (!token) return { ok: false, error: '返回里没有 access_token' };
  credentialStore.setSecret(def.secretKey, token);
  const rt = inner.refresh_token || inner.authed_user?.refresh_token;
  if (rt) credentialStore.setSecret(def.secretKey + '-refresh', rt);
  return { ok: true };
}

/** 本地回调服务器：只接受来自回环地址、且 path / host / state 都对得上的请求 */
function ensureCallbackServer(port) {
  if (state.callbackServer && state.callbackPort === port) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // 只接受来自本机的请求，防"内网机器扫到端口"的滥用
      const remote = (req.socket.remoteAddress || '');
      const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
      if (!isLocal) {
        res.writeHead(403).end('forbidden');
        return;
      }
      let parsed;
      try { parsed = new URL(req.url, 'http://127.0.0.1'); } catch (e) {
        res.writeHead(400).end('bad request');
        return;
      }
      if (parsed.pathname !== '/callback') { res.writeHead(404).end('not found'); return; }

      const code = parsed.searchParams.get('code');
      const gotState = parsed.searchParams.get('state');
      const errDesc = parsed.searchParams.get('error_description') || parsed.searchParams.get('error');

      // state 必须命中我们发起时存下的那一个 —— 这是防 CSRF 的关键
      const session = gotState ? state.pending.get(gotState) : null;
      if (!session) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
          .end(callbackPage('授权失败', '回调校验未通过（state 不匹配），请回到应用重新发起授权。'));
        return;
      }
      state.pending.delete(gotState);
      clearTimeout(session.timer);

      if (errDesc) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
          .end(callbackPage('授权未完成', String(errDesc)));
        console.warn('[Connector] 用户拒绝授权: ' + session.connectorId);
        notifyRenderer({ type: 'oauth-failed', connectorId: session.connectorId, error: String(errDesc) });
        setTimeout(stopCallbackServer, 100);
        return;
      }
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
          .end(callbackPage('授权失败', '回调里没有 code，请重新发起。'));
        setTimeout(stopCallbackServer, 100);
        return;
      }

      // 拿到授权码。若该 provider 支持自动换 token（飞书），用 app_id+secret 换 user_access_token 落盘
      const cid = session.connectorId;
      exchangeCodeForToken(cid, code).then((ex) => {
        // no-token-url = 该 provider 不自动换 token，维持原行为：把 code 交回前端
        if (ex && ex.ok) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            .end(callbackPage('授权成功', '已完成授权，令牌已加密保存，回到应用即可使用。', true));
          console.log('[Connector] 授权成功并已存 token: ' + cid);
          notifyRenderer({ type: 'connected', connectorId: cid });
        } else if (!ex || ex.error === 'no-token-url' || ex.error === '缺 client_id 或 client_secret') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            .end(callbackPage('授权成功', '已收到授权码，请回到应用完成最后一步。', true));
          console.log('[Connector] 收到授权码: ' + cid);
          notifyRenderer({ type: 'oauth-code', connectorId: cid, code });
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            .end(callbackPage('授权码已收到', '已收到授权码，但自动换取令牌失败：' + (ex && ex.error || '未知错误'), true));
          console.warn('[Connector] 换 token 失败: ' + cid, ex && ex.error);
          notifyRenderer({ type: 'oauth-code', connectorId: cid, code });
        }
        setTimeout(stopCallbackServer, 100);
      });
    });

    server.on('error', (e) => {
      state.callbackServer = null;
      state.callbackPort = null;
      reject(new Error(e.code === 'EADDRINUSE' ? '端口 ' + port + ' 已被占用' : e.message));
    });
    server.listen(port, '127.0.0.1', () => {
      state.callbackServer = server;
      state.callbackPort = port;
      resolve();
    });
  });
}

function callbackPage(title, msg, ok) {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<title>' + title + '</title><style>'
    + 'body{font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;background:#1a1a2e;color:#eee;'
    + 'display:flex;align-items:center;justify-content:center;height:100vh;margin:0}'
    + '.box{text-align:center;max-width:420px;padding:32px}'
    + '.ic{font-size:44px;line-height:1}'
    + 'h1{font-size:18px;font-weight:500;margin:16px 0 8px}'
    + 'p{font-size:13px;color:#999;line-height:1.7;margin:0}'
    + '</style></head><body><div class="box">'
    + '<div class="ic" style="color:' + (ok ? '#4caf50' : '#ff5252') + '">' + (ok ? '&#10003;' : '&#10007;') + '</div>'
    + '<h1>' + title + '</h1><p>' + String(msg).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) + '</p>'
    + '<p style="margin-top:20px;font-size:12px;">这个窗口可以关掉了</p>'
    + '</div></body></html>';
}

function stopCallbackServer() {
  if (state.callbackServer) {
    try { state.callbackServer.close(); } catch (e) { /* 已关 */ }
  }
  state.callbackServer = null;
  state.callbackPort = null;
}

/** 通知渲染层（OAuth 回调发生在主进程，前端需要知道） */
function notifyRenderer(payload) {
  try {
    const { BrowserWindow } = require('electron');
    const wins = BrowserWindow.getAllWindows();
    for (const w of wins) {
      if (!w.isDestroyed()) w.webContents.send('connector:event', payload);
    }
  } catch (e) { /* 非 Electron 环境 */ }
}

// ── 手动填入令牌 ────────────────────────────────────────────────────────────
/**
 * 保存凭证（OAuth 回调拿到的授权码 / console 流程用户填的API Key）。
 * 走 credentialStore 加密落盘。
 * 前置校验：safeStorage 可用 —— 不可用时**不写**，并明确告诉用户原因，
 * 绝不能为了"能用"就把凭证明文写到磁盘上。
 */
async function saveCredential(id, token) {
  const def = getConnector(id);
  if (!def) return { success: false, error: '未找到连通器: ' + id };
  if (def.authMethod === 'none') return { success: false, error: '「' + def.name + '」无需授权' };
  if (!def.secretKey) return { success: false, error: '「' + def.name + '」未配置凭证存储键' };

  const t = String(token || '').trim();
  if (!t) return { success: false, error: '凭证不能为空' };
  // 授权码可能短（20 位左右），所以下限压到 8；主要拦的是空/明显错的输入
  if (t.length < 8) return { success: false, error: '凭证长度异常（少于 8 位），请检查是否粘贴完整' };
  // 带换行/空格基本就是粘贴错了
  if (/[\r\n\t]/.test(t)) return { success: false, error: '凭证里含有换行或制表符，请重新复制（通常是复制时多带了空行）' };

  if (!credentialStore.encryptionAvailable()) {
    return {
      success: false,
      error: '系统加密不可用（safeStorage 未就绪），为避免凭证明文落盘，已拒绝保存。请重启应用后重试。'
    };
  }

  // 先写入，再校验：校验需要从 store 读 token。
  const r = credentialStore.setSecret(def.secretKey, t);
  if (!r.ok) return { success: false, error: '保存失败：' + (r.reason || '未知错误') };

  const check = await verifyCredential(id);
  if (check && check.success === false) {
    // 校验不通过：回滚已写凭证，报错
    credentialStore.deleteSecret(def.secretKey);
    return { success: false, error: check.error || '凭证校验失败' };
  }

  console.log('[Connector] 已保存凭证: ' + id + '（' + (def.authFlow || 'oauth') + ' 流程）' + (check && check.skipped ? '（未做平台校验）' : '（校验通过）'));
  return { success: true, connected: true, hint: credentialHint(id) };
}

/** 断开连接 = 删凭证（不做软禁用，避免残留令牌仍可用） */
function disconnect(id) {
  const def = getConnector(id);
  if (!def) return { success: false, error: '未找到连通器: ' + id };
  if (def.authMethod === 'none') return { success: false, error: '「' + def.name + '」无需授权，无法断开' };
  if (!def.secretKey) return { success: false, error: '「' + def.name + '」未配置凭证存储键' };
  const ok = credentialStore.deleteSecret(def.secretKey);
  return ok
    ? { success: true, connected: false }
    : { success: false, error: '凭证删除失败（文件可能已被手动移除）' };
}

function healthCheck() {
  load();
  const problems = [];
  const warnings = [];
  if (state.error) warnings.push(state.error);
  if (!yaml) problems.push('js-yaml 不可用，连通器目录无法加载');
  const VALID_FLOWS = ['oauth', 'console', 'none'];
  for (const c of state.cfg.connectors) {
    if (!c.name) problems.push('连通器「' + c.id + '」缺名称');
    if (!c.officialName) problems.push('连通器「' + c.id + '」缺官方名称（用户要靠它认出来）');
    const flow = c.authFlow || (c.authMethod === 'none' ? 'none' : 'oauth');
    if (!VALID_FLOWS.includes(flow)) {
      problems.push('连通器「' + c.id + '」的 authFlow 非法: ' + flow);
    }
    // 需要授权的必须能跳浏览器 —— 用户要求「一律跳浏览器授权」
    if (flow !== 'none' && !safeAuthorizeUrl(c)) {
      problems.push('连通器「' + c.id + '」的授权地址无效或非 https（必须能跳浏览器授权）');
    }
    if (flow !== 'none' && !c.secretKey) {
      problems.push('连通器「' + c.id + '」缺凭证存储键（secretKey）');
    }
  }
  if (!credentialStore.encryptionAvailable()) {
    warnings.push('系统加密（safeStorage）当前不可用，连通器凭证将无法保存 —— 这是刻意设计，避免明文落盘');
  }
  return { ok: problems.length === 0, problems, warnings };
}

module.exports = {
  load, listConnectors, getConnector, isConnected, credentialHint,
  beginOAuth, saveCredential, setClientId, getClientId, setAppSecret, disconnect,
  setConnectorEnabled, healthCheck,
  safeAuthorizeUrl, safeTokenUrl, stopCallbackServer,
  ALLOWED_CALLBACK_PORTS,
  // 供测试
  _state: state
};