/**
 * MCP 管理器 —— 装配 / 生命周期 / 工具桥接
 * ============================================================
 * 职责：
 *   1. 读 mcp-servers.yaml，按「用户目录 > 出厂目录」组装生效配置
 *   2.管理 McpStdioClient 实例（启动/停止/重启/状态）
 *   3. 把 MCP 的 tools/list 转成 OpenAI function schema，**动态**注入 AGENT_TOOLS
 *   4. 把 MCP 的 tools/call 结果转成agent 循环能用的工具消息
 *   5. 工具名脱敏（复用 tool-labels，不让mcp_read_file 这种原始名露给用户）
 *
 * 关键设计：
 *   · **MCP 工具不进 AGENT_SYSTEM_PROMPT 文本** —— 只把 schema 发给模型，
 *     并且在提示词里说明「mcp_ 前缀的工具来自外部服务器」，避免模型以为是内置工具。
 *   · **MCP 工具默认不自动启用**。用户必须在设置里勾选；未启用的 server 连拉起都不拉。
 *   · **命令白名单**：MCP 是「起一个外部进程」，等价于任意代码执行面。
 *     只允许 npx/node/python/py/uvx，其余一律拒绝。
 *   · **密钥不落配置**：${secret:KEY} 从 credentialStore 取，明文永不进 yaml。
 */
const path = require('path');
const fs = require('fs');

const { McpStdioClient } = require('./mcpClient');
const { McpHttpClient } = require('./mcpHttpClient');
const credentialStore = require('../config/credentialStore');

let yaml = null;
try { yaml = require('js-yaml'); } catch (e) { /* healthCheck 会报 */ }

const FACTORY_DIR = path.join(__dirname, '..', 'agent-config');

function userConfigDir() {
  try {
    const { app } = require('electron');
    if (app && app.getPath) return path.join(app.getPath('userData'), 'agent-config');
  } catch (e) { /* node 环境 */ }
  if (_userDataOverride) return path.join(_userDataOverride, 'agent-config');
  return null;
}

/** 测试/嵌入用：显式指定 userData 目录（node 环境无 electron 时生效） */
let _userDataOverride = null;
function setUserDataOverride(dir) { _userDataOverride = dir ? path.resolve(dir) : null; }

function readFirstExisting(name) {
  for (const dir of [userConfigDir(), FACTORY_DIR].filter(Boolean)) {
    const p = path.join(dir, name);
    try { if (fs.existsSync(p)) return { file: p, text: fs.readFileSync(p, 'utf8') }; } catch (e) { /* next */ }
  }
  return null;
}

/** 内置兜底：yaml 缺失或写坏时不至于让 Agent 完全不可用 */
const FALLBACK = {
  defaults: { transport: 'stdio', autoStart: false, startupTimeoutMs: 45000, callTimeoutMs: 60000, exposeToAI: true },
  security: {
    allowedCommands: ['npx', 'node', 'python', 'py', 'uvx'],
    allowedRoots: [], deniedPaths: [],
    maxToolsPerServer: 40, namePrefix: 'mcp_'
  },
  servers: [],
  customServers: [],
  excluded: []
};
// 与 mcp-servers.yaml 保持一致；yaml 缺失时用它兜底
FALLBACK.security.allowedCommands = ['npx', 'node', 'python', 'py', 'uv', 'uvx'];

const state = {
  loaded: false, error: null,
  cfg: null, cfgFile: null,
  clients: new Map(),      // serverId -> McpStdioClient
  enabled: new Set(),      // 用户勾选的 serverId
  toolIndex: new Map(),// 暴露名'xxx' -> {serverId, toolName}
  // 工具表变更的版本号：start/stop/setEnabled 时 +1。
  // aiOps 用它来让自己的缓存失效 —— 否则 TTL 内会继续把已停掉的工具发给模型。
  revision: 0
};

// ── 配置加载 ────────────────────────────────────────────────────────────────
function load() {
  if (state.loaded) return state.cfg;
  if (!yaml) {
    state.loaded = true; state.error = 'js-yaml 不可用';
    return FALLBACK;
  }
  const hit = readFirstExisting('mcp-servers.yaml');
  if (!hit) {
    state.loaded = true; state.cfg = FALLBACK; state.error = 'mcp-servers.yaml 不存在，使用内置兜底（无 MCP 服务器）';
    return state.cfg;
  }
  try {
    const data = yaml.load(hit.text) || {};
    state.cfg = {
      defaults: Object.assign({}, FALLBACK.defaults, data.defaults || {}),
      security: Object.assign({}, FALLBACK.security, data.security || {}),
      servers: Array.isArray(data.servers) ? data.servers : [],
      customServers: Array.isArray(data.customServers) ? data.customServers : [],
      excluded: Array.isArray(data.excluded) ? data.excluded : []
    };
    state.cfgFile = hit.file;
    // autoEnable：yaml 里声明 autoEnable: true 的 server 启动即纳入启用集合。
    // 当前版本还没有 MCP 设置界面，MCP 工具默认全部未启用；autoEnable 是
    // 「用户点名要接入」的 server 的显式开关（配置驱动，不写死 id）。
    if (Array.isArray(data.servers)) {
      for (const s of data.servers) {
        if (s && s.autoEnable === true && s.id) state.enabled.add(s.id);
      }
    }
    state.loaded = true;
    state.error = null;
    return state.cfg;
  } catch (e) {
    state.loaded = true; state.cfg = FALLBACK;
    state.error = 'mcp-servers.yaml 解析失败: ' + e.message;
    console.error('[MCP] ' + state.error);
    return state.cfg;
  }
}

/**
 * 重新加载配置。商城安装/卸载 MCP 后调用，让新 customServers 生效。
 * 保留已启用集合（state.enabled 不动），仅重读 yaml 与工具缓存。
 */
function reload() {
  state.loaded = false;
  state.cfg = null;
  state.cfgFile = null;
  state.error = null;
  state.toolIndex.clear();
  state.revision++;
  return load();
}

/** 商城安装的 MCP：独立于出厂/用户 mcp-servers.yaml，避免互相覆盖。 */
function marketplaceServers() {
  try {
    let base = null;
    try { const { app } = require('electron'); if (app && app.getPath) base = app.getPath('userData'); } catch (e) { /* node */ }
    if (!base && _userDataOverride) base = _userDataOverride;
    if (!base) return [];
    const p = path.join(base, 'marketplace', 'mcp.yaml');
    if (!fs.existsSync(p)) return [];
    const data = yaml ? yaml.load(fs.readFileSync(p, 'utf8')) || {} : {};
    return Array.isArray(data.servers) ? data.servers : [];
  } catch (e) { console.warn('[MCP] 读取商城 MCP 失败:', e.message); return []; }
}

/** 全部生效服务器（出厂 + 用户自填 + 商城安装），后者的id 覆盖前者 */
function allServers() {
  const cfg = load();
  const map = new Map();
  for (const s of cfg.servers) if (s && s.id) map.set(s.id, s);
  for (const s of cfg.customServers) if (s && s.id) map.set(s.id, s);
  for (const s of marketplaceServers()) if (s && s.id) map.set(s.id, s);
  return Array.from(map.values());
}

function getServerDef(id) {
  return allServers().find(s => s.id === id) || null;
}

// ── 安全校验 ────────────────────────────────────────────────────────────────
/**
 * 命令白名单。MCP 会话本质是执行外部进程，只放行这几个解释器。
 *
 * 三个容易漏的点：
 *   1. **参数必须走 args，不能塞进 command** —— 'powershell -enc AAAA' 这种写法
 *      如果只看 basename 就可能被误判成合法。命令字段里出现空白/引号一律拒绝。
 *   2. **绝对路径要按「文件名」比对，且必须真的指向白名单解释器** ——
 *      打包后 process.execPath 就是绝对路径（'C:\\...\\node.exe'），直接拒会让
 *      所有 server 起不来；但 'C:\\Windows\\System32\\cmd.exe' 也叫 cmd.exe 之外的
 *      basename，必须靠 basename 落在白名单里才能放行。
 *      更严的做法（当前采用）：只放行**纯命令名**，绝对路径要走 command白名单里
 *      显式允许的路径前缀。这里保留 basename 归一，但要求路径里不含第二个分隔符
 *      之外的歧义 —— 实际约束是：basename 必须精确命中白名单。
 *   3. **node/python 这类解释器带绝对路径是合法的**，所以不能一刀切禁路径。
 *      真正的防线是 basename 白名单 + args 不含 shell 元字符（见 buildClientArgs）。
 */
function checkCommandAllowed(def, cfg) {
  const raw = String(def.command || '').trim();
  const allow = (cfg.security && cfg.security.allowedCommands) || FALLBACK.security.allowedCommands;
  if (!raw) return { ok: false, error: '未配置启动命令' };

  // 命令字段里带空白或引号 = 试图把参数混进命令，一律拒绝（参数应走 args）
  if (/[\s"']/.test(raw)) {
    return { ok: false, error: '命令「' + raw + '」含参数或引号，不予放行（参数请写在 args 字段）' };
  }

  // 取文件名部分：兼容 'node' / 'node.exe' / 'C:\\...\\node.exe'
  const segs = raw.split(/[\\/]/);
  const filePart = segs[segs.length - 1];
  const base = filePart.toLowerCase().replace(/\.exe$/, '');
  const normalizedAllow = allow.map(c => String(c).toLowerCase().replace(/\.exe$/, ''));
  if (!normalizedAllow.includes(base)) {
    return { ok: false, error: '命令「' + base + '」不在白名单内（允许: ' + allow.join(', ') + '）。MCP 等于执行外部进程，必须走白名单。' };
  }

  // 带路径时额外要求：路径必须位于 Program Files / 用户程序目录 / nodejs 等
  // 常见安装位置，避免有人用 C:\\Users\\Public\\evil\\node.exe 之类伪装。
  // process.execPath（Electron 自带运行时）也在此放行。
  if (segs.length > 1) {
    const p = raw.replace(/\//g, '\\').toLowerCase();
    const trustedMarkers = [
      '\\program files\\',
      '\\program files (x86)\\',
      '\\app\\local\\',                  // 用户级安装（AppData\Local\Programs）
      '\\nodejs\\',
      '\\.workbuddy\\binaries\\',        // WorkBuddy 自带运行时
      '\\electron\\',
      '\\resources\\app.asar.unpacked\\',
      '\\.local\\bin\\',                // uv / pipx 的默认安装位置
      '\\python',
      '\\uv\\',
      '\\windows-mcp-c\\'               // 自编译 C 版 Windows MCP 原生 exe
    ];
    const trusted = trustedMarkers.some(m => p.includes(m));
    if (!trusted) {
      return { ok: false, error: '命令路径「' + raw + '」不在可信安装位置，拒绝放行（只允许系统/用户程序目录下的 ' + allow.join(', ') + '）' };
    }
  }
  return { ok: true };
}

/** 解析 ${env:NAME} / ${secret:KEY} 占位 */
function resolveValue(v, def) {
  if (typeof v !== 'string') return v;
  const env = (def && def.env) || {};
  // 整串就是一个占位时保持类型友好（数字仍当字符串给子进程，问题不大）
  return v.replace(/\$\{(env|secret):([^}]+)\}/g, (_m, kind, key) => {
    if (kind === 'env') {
      const fromDef = env[key];
      if (typeof fromDef === 'string' && fromDef.startsWith('${')) return '';   // 循环占位，防呆
      return fromDef !== undefined ? String(fromDef) : (process.env[key] || '');
    }
    // secret：只从加密凭证库取，绝不读 env / 明文配置
    const s = credentialStore.getSecret(key);
    return s || '';
  });
}

function buildClientEnv(def) {
  const env = {};
  for (const [k, v] of Object.entries(def.env || {})) {
    const resolved = resolveValue(v, def);
    // 未解析出值的占位直接不传：让 server 自己用默认值，
    // 比传一个空字符串把它的配置搞坏要好
    if (resolved !== '' && resolved !== undefined) env[k] = String(resolved);
  }
  return env;
}

function buildClientArgs(def) {
  return (def.args || []).map(a => resolveValue(a, def));
}

// ── 生命周期 ────────────────────────────────────────────────────────────────
async function startServer(id) {
  const cfg = load();
  const def = getServerDef(id);
  if (!def) return { ok: false, error: '未找到服务器配置: ' + id };

  const isHttp = (def.transport === 'http') || !!def.url;

  if (state.clients.has(id)) {
    const c = state.clients.get(id);
    if (c.status === 'ready') return { ok: true, cached: true, info: c.info() };
    if (c.status === 'starting') return { ok: false, error: '正在启动中' };
    state.clients.delete(id);
  }

  let client;
  if (isHttp) {
    // 远程 Streamable HTTP MCP：不起子进程，不走命令白名单。
    // 鉴权头从 ${secret:}/${env:} 解析，明文 token 永不进 yaml。
    if (!/^https:\/\//i.test(def.url || '')) {
      return { ok: false, error: '远程 MCP 地址必须是 https: ' + (def.url || '(未配置)') };
    }
    const headers = {};
    for (const [k, v] of Object.entries(def.headers || {})) {
      const resolved = resolveValue(v, def);
      if (resolved) headers[k] = String(resolved);
    }
    // URL 里也可能有 ${secret:}（如 Tavily 把 key 拼在 query）
    const url = resolveValue(def.url, def);
    client = new McpHttpClient({
      id,
      url,
      headers,
      allowedTools: def.allowedTools || [],
      startupTimeoutMs: def.startupTimeoutMs || cfg.defaults.startupTimeoutMs,
      callTimeoutMs: def.callTimeoutMs || cfg.defaults.callTimeoutMs
    });
  } else {
    const guard = checkCommandAllowed(def, cfg);
    if (!guard.ok) return { ok: false, error: guard.error };

    client = new McpStdioClient({
      id,
      command: def.command,
      args: buildClientArgs(def),
      env: buildClientEnv(def),
      cwd: def.cwd || null,
      startupTimeoutMs: def.startupTimeoutMs || cfg.defaults.startupTimeoutMs,
      callTimeoutMs: def.callTimeoutMs || cfg.defaults.callTimeoutMs
    });
  }
  state.clients.set(id, client);
  const res = await client.start();
  if (!res.ok) return res;

  // 拉工具清单（失败不阻断：服务器可能只有 resources/prompts）
  try {
    const tools = await client.listTools();
    console.log('[MCP] ' + id + ' 暴露 ' + tools.length + ' 个工具');
    state.revision++;
  } catch (e) {
    console.warn('[MCP] ' + id + ' tools/list失败: ' + e.message);
  }
  return { ok: true, info: client.info() };
}

async function stopServer(id) {
  const c = state.clients.get(id);
  if (!c) return { ok: true, alreadyStopped: true };
  const r = await c.stop();
  state.clients.delete(id);
  state.revision++;      // 工具少了一批，下游缓存必须失效
  return r;
}

async function restartServer(id) {
  await stopServer(id);
  return startServer(id);
}

async function stopAll() {
  const ids = Array.from(state.clients.keys());
  for (const id of ids) {
    try { await stopServer(id); } catch (e) { /* 继续停其他 */ }
  }
  state.toolIndex.clear();
  state.revision++;      // 让下游缓存失效，否则已停工具还会被发给模型
}

/** 拉取所有已启用 server 的工具，组装成 OpenAI function schema */
async function collectTools() {
  const cfg = load();
  const prefix = (cfg.security && cfg.security.namePrefix) || 'mcp_';
  const cap = (cfg.security && cfg.security.maxToolsPerServer) || 40;
  const out = [];
  state.toolIndex.clear();

  for (const id of state.enabled) {
    let client = state.clients.get(id);
    // autoEnable 的 server（用户点名接入、声明了随用随拉）：工具被模型需要时惰性拉起。
    // 首次拉起可能较慢（npx/uvx 要下载），失败只告警不阻断 —— 其余 server 不受影响。
    if ((!client || client.status !== 'ready')) {
      const def0 = getServerDef(id);
      if (def0 && def0.autoEnable === true) {
        console.log('[MCP] 服务器「' + id + '」未运行，按 autoEnable 惰性拉起（首次可能较慢）…');
        try { await startServer(id); } catch (e) { console.warn('[MCP] 惰性拉起失败 ' + id + ': ' + (e.message || e)); }
        client = state.clients.get(id);
      }
    }
    if (!client || client.status !== 'ready') continue;
    let tools = [];
    try { tools = await client.listTools(); } catch (e) {
      console.warn('[MCP] ' + id + ' 取工具失败: ' + e.message);
      continue;
    }
    const def = getServerDef(id);
    const dyn = !!(def && def.dynamic && def.dynamic.labelWildcard);
    let n = 0;
    for (const t of tools) {
      if (n >= cap) {
        console.warn('[MCP] ' + id + ' 工具数超过上限 ' + cap + '，已截断');
        break;
      }
      if (!t || !t.name) continue;
      const exposed = prefix + sanitizeToolName(t.name);
      if (out.some(x => x.function.name === exposed)) continue;   // 防重名
      const schema = {
        type: 'function',
        function: {
          name: exposed,
          description: prefixDesc(t.description, def),
          parameters: normalizeSchema(t.inputSchema)
        }
      };
      out.push(schema);
      state.toolIndex.set(exposed, { serverId: id, toolName: t.name, def: def });
      n++;
    }
  }
  return out;
}

/** MCP 工具名允许 [a-zA-Z0-9_-]，但有些 server 会塞进点号/斜杠，这里统一洗一遍 */
function sanitizeToolName(name) {
  return String(name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function prefixDesc(desc, def) {
  const serverName = (def && (def.name || def.id)) || '外部 MCP 服务器';
  return '【来自 ' + serverName + '】' + String(desc || '未提供描述');
}

/**
 * 归一化 inputSchema：MCP 允许省略 type 或用 anyOf/oneOf，
 * 而 OpenAI function calling 要求 type: object + properties 齐全。
 * 这里补齐缺失字段，非法就退化成"任意 JSON 对象"，总比让请求被上游拒掉好。
 */
function normalizeSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {}, additionalProperties: true };
  }
  const s = Object.assign({}, schema);
  if (s.type !== 'object') s.type = 'object';
  if (!s.properties || typeof s.properties !== 'object' || Array.isArray(s.properties)) s.properties = {};
  if (Array.isArray(s.required)) {
    s.required = s.required.filter(k => typeof k === 'string' && k in s.properties);
  } else {
    s.required = [];
  }
  return s;
}

// ── 执行 ────────────────────────────────────────────────────────────────────
/**
 * 调用一个 MCP 工具。
 * @returns {{success:boolean, content:string, isError?:boolean, raw?:any}}
 */
async function callTool(exposedName, args) {
  const entry = state.toolIndex.get(exposedName);
  if (!entry) return { success: false, error: '未注册的 MCP 工具: ' + exposedName };
  const client = state.clients.get(entry.serverId);
  if (!client || client.status !== 'ready') {
    return { success: false, error: 'MCP 服务器「' + entry.serverId + '」未运行，无法调用「' + exposedName + '」' };
  }
  try {
    const res = await client.callTool(entry.toolName, args);
    const text = flattenContent(res.content);
    return {
      success: !res.isError,
      content: text,
      isError: !!res.isError,
      raw: res.raw
    };
  } catch (e) {
    return { success: false, error: 'MCP 调用失败: ' + e.message };
  }
}

/** MCP content 是数组，元素可能是 text / resource / image，拼成一段可读文本 */
function flattenContent(content) {
  if (!Array.isArray(content)) return content ? String(content) : '';
  const parts = [];
  for (const c of content) {
    if (!c) continue;
    if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else if (c.type === 'resource' && c.resource) {
      parts.push('[资源 ' + (c.resource.uri || '') + ']\n'
        + (typeof c.resource.text === 'string' ? c.resource.text : '[二进制资源]'));
    } else if (c.type === 'image') parts.push('[图片 ' + (c.mimeType || '') + '，' + ((c.data || '').length / 1024).toFixed(1) + 'KB]');
    else parts.push('[未知内容类型: ' + (c.type || '?') + ']');
  }
  const text = parts.join('\n');
  // 上限保护：个别 server 会返回巨量文本
  const cap = 20000;
  return text.length > cap ? text.slice(0, cap) + '\n……（MCP 返回内容过长，已截断）' : text;
}

// ── 启用开关 ────────────────────────────────────────────────────────────────
function setEnabled(ids) {
  state.enabled = new Set(Array.isArray(ids) ? ids : []);
  state.toolIndex.clear();     // 启用集合变了，缓存的映射要重建
  state.revision++;
  return { ok: true, enabled: Array.from(state.enabled) };
}
function getEnabled() { return Array.from(state.enabled); }

/** 某个暴露名归属哪个 server（没登记返回 null） */
function ownerOf(exposedName) {
  const e = state.toolIndex.get(exposedName);
  return e ? e.serverId : null;
}

/**
 * 提示词片段：告诉模型 mcp_ 前缀是什么、来自哪、有多少。
 * **刻意做得很短** —— 工具 schema 本身已经发过去了，这里只解释前缀含义。
 */
function buildPromptNotice() {
  const ids = Array.from(state.enabled);
  if (!ids.length) return '';
  const lines = ids.map(id => {
    const def = getServerDef(id);
    return '- mcp_ 前缀的工具来自「' + ((def && (def.name || def.id)) || id) + '」MCP 服务器';
  });
  return '\n\n## 外部工具（MCP）\n'
    + '以下 `mcp_` 前缀的工具由**外部 MCP 服务器**提供，不是本应用内置工具。\n'
    + lines.join('\n')
    + '\n需要它们时正常调用即可；若某个 mcp_ 工具返回「服务器未运行」，'
    + '如实告诉用户该服务未连接，不要反复重试同一个调用。';
}

// ── 状态 / 自检 ─────────────────────────────────────────────────────────────
function status() {
  const cfg = load();
  return {
    enabled: getEnabled(),
    running: Array.from(state.clients.values()).filter(c => c.status === 'ready').map(c => c.info()),
    servers: allServers().map(s => {
      const c = state.clients.get(s.id);
      return {
        id: s.id, name: s.name || s.id, group: s.group || 'custom',
        recommendation: s.recommendation || 'optional',
        description: s.description || '',
        notes: s.notes || '',
        isRunning: !!(c && c.status === 'ready'),
        status: c ? c.status : 'stopped',
        error: c ? c.error : null,
        toolCount: c && c.toolsCache ? c.toolsCache.length : null
      };
    }),
    excluded: cfg.excluded,
    configFile: state.cfgFile,
    error: state.error,
    toolCount: state.toolIndex.size
  };
}

function healthCheck() {
  const cfg = load();
  const problems = [];
  const warnings = [];
  if (state.error) warnings.push(state.error);
  if (!yaml) problems.push('js-yaml 不可用，MCP 无法加载配置');
  for (const s of allServers()) {
    const isHttp = (s.transport === 'http') || !!s.url;
    if (isHttp) {
      if (!/^https:\/\//i.test(s.url || '')) {
        problems.push('MCP 远程服务器「' + s.id + '」地址必须是 https: ' + (s.url || '(未配置)'));
      }
      continue;
    }
    const guard = checkCommandAllowed(s, cfg);
    if (!guard.ok) problems.push('MCP 服务器「' + s.id + '」: ' + guard.error);
  }
  return { ok: problems.length === 0, problems, warnings };
}

/**
 * 同步停止所有 server —— 给 app 'will-quit' 用。
 * 那个钩子是同步的，await 不了，所以这里只做「杀掉进程」这一件确定的事，
 * 不做等待握手、不更新状态机。
 */
function stopAllSync() {
  let n = 0;
  for (const [, c] of state.clients) {
    try { if (typeof c._killChild === 'function') c._killChild(); n++; } catch (e) { /* 已退出 */ }
  }
  state.clients.clear();
  state.toolIndex.clear();
  state.revision++;
  return { ok: true, killed: n };
}

/**
 * 某个 MCP 工具执行前是否需要用户确认。
 * 依据是 mcp-servers.yaml 里每个 server 的 security 声明：
 *   · risky: true                → 该 server 全部工具都需确认（github / gitmcp）
 *   · requireConfirmAll: true    → 同上，且必须逐个确认（openapi-mcp：spec 内容不可预知）
 *   · writeCommands: [名字...]   → 只有这些写类工具需确认，git 的只读命令不受影响
 * 未声明 security 的 server 默认**需确认** —— 外部进程的权限面比内置工具大，
 * 拿不到约束信息时按最保守处理。
 */
function needConfirm(exposedName) {
  const serverId = ownerOf(exposedName);
  if (!serverId) return false;
  const def = getServerDef(serverId);
  const sec = (def && def.security) || {};
  // 声明了全量确认的 → 该 server 全部工具都需确认（github / gitmcp / openapi-mcp）
  if (sec.requireConfirmAll || sec.risky) return true;
  const entry = state.toolIndex.get(exposedName);
  const origin = (entry && entry.toolName) || '';
  // 显式列出的写类工具 → 需确认（即使 server 声明了 readOnly 基线）
  if (Array.isArray(sec.writeCommands) && sec.writeCommands.includes(origin)) return true;
  // 未声明任何 security 约束 → 按最保守处理，全部需确认
  if (!def || !def.security) return true;
  // readOnly 基线（filesystem / sqlite / windows-mcp）→ 未列入 writeCommands 的工具免确认
  if (sec.readOnly) return false;
  return true;
}

/** 该 server 是否声明了只读约束（用于设置页提示） */
function isReadOnlyServer(serverId) {
  const def = getServerDef(serverId);
  return !!(def && def.security && def.security.readOnly);
}

module.exports = {
  load, reload, allServers, getServerDef, status, healthCheck,
  startServer, stopServer, restartServer, stopAll, stopAllSync,
  collectTools, callTool, setEnabled, getEnabled, ownerOf,
  buildPromptNotice, checkCommandAllowed, needConfirm, isReadOnlyServer,
  /** 工具表版本号：变了就说明工具集合变了，下游缓存应失效 */
  revision: () => state.revision,
  // 供测试
  _state: state,
  _resolveValue: resolveValue,
  _sanitizeToolName: sanitizeToolName,
  _normalizeSchema: normalizeSchema,
  _flattenContent: flattenContent,
  setUserDataOverride
};