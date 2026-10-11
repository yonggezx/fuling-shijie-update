/**
 * AI龙虾 - Supabase 认证模块（主进程）
 * 处理登录注册、用户资料、修改密码、云端设置同步
 * 配置内置在程序中，正式版用户无需手动填写
 */

const { ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const credentialStore = require('../config/credentialStore');

// 内置默认配置（正式版用户直接使用）
const DEFAULT_CONFIG = {
  url: 'https://fdoxhnfhtdzhefmhlcas.supabase.co',
  key: 'sb_publishable_cj0kw0FQtzNr1CaQP7kCww_ow5AhUqA',
  // 内置兜底反向代理地址（需要自行部署后才能填写，见 supabase-proxy-worker.js）
  // 例：['https://your-worker.xxx.workers.dev']
  proxyUrls: []
};

// ==================== 网络层 ====================
// 背景：部分网络环境下 *.supabase.co 的 TLS 握手会被中途重置（read ECONNRESET），
// supabase-js 内部拿到的就是 "fetch failed"（AuthRetryableFetchError），堆栈没有任何有效信息。
// 处理策略：
//   1) 请求优先走 Electron Chromium 网络栈（net.fetch），自动识别系统代理 / PAC；
//   2) 网络层错误自动重试，并在候选端点之间依次兜底（直连 → 反向代理）；
//   3) 全部失败时抛出可读的中文提示，而不是 "fetch failed"。
const NET_TIMEOUT_MS = 12000;   // 单次请求超时
const NET_RETRY = 2;            // 同一端点的额外重试次数
const NET_RETRY_BASE_MS = 500;  // 重试退避基数
const NET_GOOD_TTL_MS = 10 * 60 * 1000; // 记住可用端点的时长

const NET_ERR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
  'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ECONNABORTED',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
  'UND_ERR_ABORTED', 'UND_ERR_TIMED_OUT'
]);

let candidateBases = [];                  // [{ base, label }]，按优先级
let lastGoodBase = null;                  // { base, ts } 最近一次成功且非首选项的端点
let lastNetFailure = 0;                   // 最近一次整体网络失败时间

function normalizeBase(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 证书类错误：多为安全软件 HTTPS 扫描插入了自签名根证书，重试无用但必须给出针对性提示
function isCertError(e) {
  const msg = String((e && e.message) || e || '');
  return /ERR_CERT_|certificate|tls+|UNABLE_TO_VERIFY_LEAF_SIGNATURE|self.signed/i.test(msg);
}

// Chromium（net.fetch）抛的错误是 net::ERR_XXX 字符串，和 Node 的 code 完全不同，
// 漏判会导致「第一次 QUIC 失败就直接报错、不走重试/兜底」。
function isNetworkError(e) {
  if (!e) return false;
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return true;
  const codes = [e.code, e.cause && e.cause.code, e.errno];
  if (codes.some((c) => c && NET_ERR_CODES.has(String(c)))) return true;
  const msg = String(e.message || '');
  // Chromium 网络栈错误：net::ERR_QUIC_PROTOCOL_ERROR / net::ERR_CONNECTION_RESET …
  if (msg.indexOf('net::ERR_') >= 0) return true;
  return /fetch failed|socket hang up|network|timed out|timeout|aborted|connection[ _]reset|NetworkError|TLS|QUIC/i.test(msg);
}

// 反向代理不可用时的典型状态码（Cloudflare Worker / nginx 回源失败）
function isGatewayStatus(status) {
  return status === 502 || status === 503 || status === 504 || status === 520 || status === 521 || status === 522;
}

function buildCandidateBases(base, config) {
  const list = [];
  const push = (value, label) => {
    const b = normalizeBase(value);
    if (!b) return;
    if (!list.some((x) => x.base === b)) list.push({ base: b, label: label || '未知' });
  };

  push(base, '直连');

  const pushAll = (arr, label) => {
    if (Array.isArray(arr)) arr.forEach((v) => push(v, label));
    else if (typeof arr === 'string') arr.split(',').forEach((v) => push(v, label));
  };
  pushAll(process.env.AIL_SUPABASE_PROXY, '环境变量代理');
  pushAll(config && config.proxyUrls, '配置代理');
  pushAll(config && config.proxyUrl, '配置代理');
  pushAll(DEFAULT_CONFIG.proxyUrls, '内置代理');
  return list;
}

// 按「最近成功端点优先」排序，其余保持原顺序
function orderedCandidates() {
  if (lastGoodBase && Date.now() - lastGoodBase.ts < NET_GOOD_TTL_MS) {
    const hit = candidateBases.find((x) => x.base === lastGoodBase.base);
    if (hit) return [hit, ...candidateBases.filter((x) => x !== hit)];
  }
  return candidateBases.slice();
}

function rewriteTarget(target, base) {
  const b = normalizeBase(base);
  if (!b) return target;
  try {
    const u = new URL(target);
    return b + u.pathname + (u.search || '');
  } catch (e) {
    const idx = String(target).indexOf('/', 8);
    const suffix = idx > 0 ? String(target).slice(idx) : '/';
    return b + suffix;
  }
}

// Electron Chromium 网络栈（自动识别系统代理 / PAC），不可用时回落到 Node fetch
function getElectronNetFetch() {
  try {
    const { net } = require('electron');
    if (net && typeof net.fetch === 'function') return net.fetch;
  } catch (e) {
    /* 非 Electron 环境（脚本自测） */
  }
  return null;
}

let cachedNetFetch;
function rawFetch(url, init) {
  if (cachedNetFetch === undefined) cachedNetFetch = getElectronNetFetch();
  const options = Object.assign({}, init);
  if (options.signal === undefined) {
    try {
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        options.signal = AbortSignal.timeout(NET_TIMEOUT_MS);
      }
    } catch (e) { /* 老版本 Node 无 AbortSignal.timeout */ }
  }
  if (cachedNetFetch) return cachedNetFetch(url, options);
  return fetch(url, options);
}

/**
 * 带重试 + 多端点兜底的 fetch，直接交给 supabase-js 使用（settings.global.fetch）
 */
async function resilientFetch(input, init) {
  const target = typeof input === 'string' ? input : String(input.url || input);
  const list = orderedCandidates();
  if (!list.length) return rawFetch(target, init);

  const failures = [];
  let certFailure = false;
  for (const cand of list) {
    const url = rewriteTarget(target, cand.base);

    for (let attempt = 0; attempt <= NET_RETRY; attempt++) {
      if (attempt > 0) await sleep(NET_RETRY_BASE_MS * attempt);
      let res;
      try {
        res = await rawFetch(url, init);
      } catch (e) {
        if (!isNetworkError(e)) throw e;
        if (isCertError(e)) certFailure = true;
        failures.push(`${cand.label}(${cand.base}): ${e.message || e}`);
        lastNetFailure = Date.now();
        break; // 换下一个端点
      }
      // 网关错误视为该端点不可用，继续兜底
      if (res && isGatewayStatus(res.status)) {
        failures.push(`${cand.label}(${cand.base}): HTTP ${res.status}`);
        break;
      }
      if (cand.base !== list[0].base) {
        lastGoodBase = { base: cand.base, ts: Date.now() };
      } else if (lastGoodBase && lastGoodBase.base !== cand.base) {
        lastGoodBase = null;
      }
      return res;
    }
  }

  const detail = failures.slice(-3).join(' | ');
  if (certFailure) {
    throw new Error(
      '连接账号服务器时证书校验失败：很可能是本机安全软件（HTTPS 扫描 / SSL 解密）插入了自签名证书。' +
      '请在安全软件里把本应用加入信任区或关闭对该应用的 HTTPS 扫描后重试。\n诊断信息: ' + detail
    );
  }
  const avTip = getAntivirusInfo().tip;
  throw new Error(
    '无法连接到账号服务器：网络请求被中断（多为网络限制或安全软件拦截）。' +
    (avTip ? avTip + ' ' : '') +
    '请检查网络 / 系统代理后重试；若长期失败，可在 %LOCALAPPDATA% 下的 supabase-config.json ' +
    '配置 proxyUrls 使用反向代理。\n诊断信息: ' + detail
  );
}

// Supabase 常见英文报错的中文映射
const SUPABASE_MSG_MAP = [
  [/already registered|already been registered/i, '该邮箱已注册，请直接登录'],
  [/invalid login credentials/i, '邮箱或密码错误'],
  [/email not confirmed/i, '邮箱尚未验证，请先查收验证邮件'],
  [/invalid format|unable to validate email/i, '邮箱格式不正确'],
  [/password should be at least 6/i, '密码至少需要 6 位'],
  [/weak password/i, '密码强度不足，请更换更复杂的密码'],
  [/only request this once every/i, '操作过于频繁，请稍后再试'],
  [/duplicate key value violates unique constraint[\s\S]*(username)/i, '该用户名已被占用'],
  [/duplicate key value/i, '数据重复，可能是用户名已被占用'],
  [/jwt expired|token has expired/i, '登录已过期，请重新登录'],
  [/rate limit/i, '请求过于频繁，请稍后再试']
];

function friendlyError(e) {
  if (!e) return '未知错误';
  const msg = String(e.message || e.msg || e);
  if (isNetworkError(e)) {
    // resilientFetch 已给出完整中文说明，这里只兜底裸调查不到的情况
    if (msg.indexOf('无法连接到账号服务器') === 0 || msg.indexOf('连接账号服务器时证书校验失败') === 0) return msg;
    if (isCertError(e)) {
      return '连接账号服务器时证书校验失败：可能是安全软件的 HTTPS 扫描插入了自签名证书，请把本应用加入信任区后重试';
    }
    return '无法连接到账号服务器：' + msg;
  }
  for (const [re, zh] of SUPABASE_MSG_MAP) {
    if (re.test(msg)) return zh;
  }
  if (/fetch failed|Failed to fetch|NetworkError/i.test(msg)) {
    return '无法连接到账号服务器，请检查网络后重试';
  }
  return msg;
}

function netFail(e) {
  return { success: false, error: friendlyError(e) };
}

// 读取 Windows 系统代理（仅用于诊断展示；Electron 网络栈自身会识别系统代理）
function getSystemProxy() {
  try {
    const base = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const read = (name) => {
      try {
        const out = require('child_process')
          .execSync(`reg query "${base}" /v ${name}`, { encoding: 'utf-8', windowsHide: true, timeout: 3000 });
        const m = out.match(/REG_(?:SZ|DWORD)\s+(.+)$/m);
        return m ? m[1].trim() : '';
      } catch (e) {
        return '';
      }
    };
    const enabledRaw = read('ProxyEnable');
    const server = read('ProxyServer');
    const pac = read('AutoConfigURL');
    const enabled = /^(0x0?1|1)$/.test(String(enabledRaw).trim());
    // 开关打开但没有实际地址时视为无效
    const effective = enabled && !!(server || pac);
    return { enabled: effective, switchOn: enabled, server, pac };
  } catch (e) {
    return { enabled: false, server: '', pac: '', error: e.message };
  }
}

// ==================== 安全软件检测 ====================
// 安全软件（360 / 火绒 / 卡巴斯基 …）的 HTTPS 扫描、流量过滤常按 TLS 客户端指纹放行：
// Node/OpenSSL 的握手被中途重置，而 Chromium 网络栈能正常通过。
// 这里只做「检测 + 提示」，不替用户改任何系统/安全软件设置。
const AV_SIGNATURES = [
  { name: '360安全卫士/360杀毒', dir: ['360'] },
  { name: '火绒安全', dir: ['Huorong'] },
  { name: '腾讯电脑管家', dir: ['Tencent'], sub: 'QQPCMgr' },
  { name: '卡巴斯基', dir: ['Kaspersky Lab', 'Kaspersky'] },
  { name: 'Avast', dir: ['Avast Software', 'AVAST Software'] },
  { name: 'AVG', dir: ['AVG'] },
  { name: 'McAfee', dir: ['McAfee'] },
  { name: 'Norton/Symantec', dir: ['Norton', 'NortonInstaller', 'Symantec'] },
  { name: 'ESET', dir: ['ESET', 'ESET NOD32 Antivirus'] },
  { name: 'Bitdefender', dir: ['Bitdefender'] },
  { name: 'Avira', dir: ['Avira'] },
  { name: '趋势科技', dir: ['Trend Micro', 'TrendMicro'] },
  { name: '瑞星', dir: ['Rising'] },
  { name: '江民', dir: ['Jiangmin'] },
  { name: 'Malwarebytes', dir: ['Malwarebytes'] }
];

let avCache = null;
function getAntivirusInfo() {
  if (avCache) return avCache;
  const found = [];
  try {
    const roots = [
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.ProgramW6432
    ].filter(Boolean);
    const listed = roots.map((root) => {
      try { return { root, entries: fs.readdirSync(root) }; } catch (e) { return { root, entries: [] }; }
    });
    for (const sig of AV_SIGNATURES) {
      for (const { root, entries } of listed) {
        const hit = entries.find((n) => sig.dir.some((d) => d.toLowerCase() === n.toLowerCase()));
        if (!hit) continue;
        const base = path.join(root, hit);
        if (sig.sub) {
          if (!fs.existsSync(path.join(base, sig.sub))) continue;
        }
        found.push({ name: sig.name, path: base });
        break;
      }
    }
    // Windows Defender
    try {
      const defenderExe = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Windows Defender', 'MsMpEng.exe');
      if (fs.existsSync(defenderExe)) found.push({ name: 'Windows Defender', path: defenderExe });
    } catch (e) { /* ignore */ }
  } catch (e) {
    return { list: [], tip: '' };
  }
  const tip = found.length
    ? `检测到安全软件：${found.map((f) => f.name).join('、')}。` +
      '部分安全软件的 HTTPS 扫描/流量过滤会拦截应用的 TLS 握手，' +
      '建议在「联网控制 / SSL 扫描 / 信任区」中把本应用放行后重试（不要整体关闭防护）。'
    : '';
  avCache = { list: found, tip };
  return avCache;
}

// ==================== 网络诊断（devtools / 设置页排查用）====================
async function handleDiagnose() {
  const list = candidateBases.length ? candidateBases : buildCandidateBases(DEFAULT_CONFIG.url, null);
  const sysProxy = getSystemProxy();
  const key = (loadConfig() || DEFAULT_CONFIG).key;
  const results = [];

  for (const c of list) {
    const url = c.base + '/auth/v1/settings';
    const t0 = Date.now();
    try {
      const res = await rawFetch(url, { method: 'GET', headers: { apikey: key } });
      const body = await res.text().catch(() => '');
      results.push({
        label: c.label, base: c.base, ok: res.ok, status: res.status,
        ms: Date.now() - t0, body: body.slice(0, 200)
      });
    } catch (e) {
      results.push({
        label: c.label, base: c.base, ok: false, status: 0,
        ms: Date.now() - t0, error: (e && (e.cause && e.cause.code ? e.cause.code + ' ' : '')) + (e && e.message || String(e))
      });
    }
  }

  return {
    candidates: results,
    systemProxy: sysProxy,
    antivirus: getAntivirusInfo(),
    transport: cachedNetFetch === undefined ? (getElectronNetFetch() ? 'electron-net' : 'node-fetch') : (cachedNetFetch ? 'electron-net' : 'node-fetch'),
    lastFailure: lastNetFailure ? new Date(lastNetFailure).toISOString() : null
  };
}

// ==================== 自定义文件存储适配器 ====================
// Supabase 默认使用 localStorage，在 Electron 主进程中不可用
// 使用文件存储来持久化会话
// 会话 token 属于凭证，按规范必须加密保管（safeStorage / DPAPI），不能明文躺 json。
// 读取时仍兼容历史明文文件，保证老用户升级后 session 不丢。
const SESSION_SECRET_KEY = 'supabase-session';

function readPlainAll() {
  try {
    if (SESSION_PATH && fs.existsSync(SESSION_PATH)) {
      return JSON.parse(fs.readFileSync(SESSION_PATH, 'utf-8')) || {};
    }
  } catch (e) { /* 忽略损坏的历史文件 */ }
  return {};
}

function writePlainAll(data) {
  try {
    if (SESSION_PATH) fs.writeFileSync(SESSION_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[SupabaseAuth] 明文兜底写入失败:', e.message);
  }
}

/** 读出整份会话表：优先加密区，其次历史明文 */
function readAll() {
  const enc = credentialStore.getSecret(SESSION_SECRET_KEY);
  if (enc) {
    try { return JSON.parse(enc); } catch (e) { /* 加密内容损坏则回落明文 */ }
  }
  return readPlainAll();
}

function writeAll(data) {
  const r = credentialStore.setSecret(SESSION_SECRET_KEY, JSON.stringify(data));
  if (!r.ok) {
    // safeStorage 不可用（如部分环境）时退回明文，保证登录态不丢，但会明确告警
    writePlainAll(data);
  } else {
    // 加密写入成功后，清掉可能残留的明文文件
    try { if (SESSION_PATH && fs.existsSync(SESSION_PATH)) fs.unlinkSync(SESSION_PATH); } catch (e) { /* 忽略 */ }
  }
}

const fileStorage = {
  getItem: (key) => {
    try { return readAll()[key] || null; } catch (e) {
      console.error('[SupabaseAuth] 会话读取失败:', e.message);
      return null;
    }
  },
  setItem: (key, value) => {
    try { const all = readAll(); all[key] = value; writeAll(all); } catch (e) {
      console.error('[SupabaseAuth] 会话写入失败:', e.message);
    }
  },
  removeItem: (key) => {
    try { const all = readAll(); delete all[key]; writeAll(all); } catch (e) {
      console.error('[SupabaseAuth] 会话删除失败:', e.message);
    }
  }
};

// 配置文件路径（用户数据目录，用于自定义配置覆盖）
let CONFIG_PATH = null;
let SESSION_PATH = null;
let USER_MAP_PATH = null;   // 本机「用户名 → 邮箱」映射（解决后端 RPC 不可用/返回固定值的问题）
let AVATAR_DIR = null;      // 本机头像存储目录：头像以本地文件持久化，重启后优先读本地，避免云端列被超长 base64 截断
let supabaseClient = null;
let currentUser = null;

// ==================== 本机用户名→邮箱映射 ====================
// 背景：后端 get_email_by_username 实测对任何输入都返回同一个邮箱（testuser001@example.com），
// 导致「用用户名登录」必然失败。这里在本机落一份映射，登录/注册成功后写入，之后再登录即可命中。
// 说明：这只是本机便利功能，不是跨设备的账号体系；换设备仍需用邮箱登录。
function loadUserMap() {
  try {
    if (USER_MAP_PATH && fs.existsSync(USER_MAP_PATH)) {
      const j = JSON.parse(fs.readFileSync(USER_MAP_PATH, 'utf-8'));
      return (j && j.users) || {};
    }
  } catch (e) {
    console.warn('[SupabaseAuth] 读取用户映射失败:', e.message);
  }
  return {};
}

function recordUserMapping(username, email, nickname) {
  if (!USER_MAP_PATH || !username || !email || email.indexOf('@') < 0) return;
  try {
    const map = loadUserMap();
    map[String(username).toLowerCase()] = {
      email,
      nickname: nickname || '',
      updatedAt: Date.now()
    };
    fs.writeFileSync(USER_MAP_PATH, JSON.stringify({ version: 1, users: map }, null, 2), 'utf-8');
  } catch (e) {
    console.warn('[SupabaseAuth] 写入用户映射失败:', e.message);
  }
}

// ==================== 初始化 ====================
function init(userDataPath) {
  CONFIG_PATH = path.join(userDataPath, 'supabase-config.json');
  SESSION_PATH = path.join(userDataPath, 'supabase-session.json');
  USER_MAP_PATH = path.join(userDataPath, 'supabase-usermap.json');
  AVATAR_DIR = path.join(userDataPath, 'avatars');
  try { fs.mkdirSync(AVATAR_DIR, { recursive: true }); } catch (e) { /* 无权限等场景忽略，头像回退云端 */ }
  
  // 启动时自动初始化（使用内置配置，不需要用户手动配置）
  loadConfigAndInit();
  
  // 注册 IPC 处理函数（防御性：确保 ipcMain 存在）
  try {
    if (ipcMain && typeof ipcMain.handle === 'function') {
      registerIpcHandlers();
      console.log('[SupabaseAuth] IPC 处理函数注册成功');
    } else {
      console.warn('[SupabaseAuth] ipcMain 不可用，跳过 IPC 注册');
    }
  } catch (e) {
    console.error('[SupabaseAuth] IPC 注册失败:', e.message);
  }
}

// ==================== 配置管理 ====================
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = fs.readFileSync(CONFIG_PATH, 'utf-8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('[SupabaseAuth] 读取配置失败:', e.message);
  }
  return null;
}

function saveConfig(config) {
  try {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('[SupabaseAuth] 保存配置失败:', e.message);
    return false;
  }
}

function loadConfigAndInit() {
  // 优先使用本地配置文件（用于自定义配置覆盖），否则使用内置默认配置
  let config = null;
  try {
    config = loadConfig();
  } catch (e) {
    console.error('[SupabaseAuth] 读取本地配置异常:', e.message);
  }
  
  if (!config || !config.url || !config.key) {
    config = DEFAULT_CONFIG;
    console.log('[SupabaseAuth] 使用内置默认配置');
  } else {
    console.log('[SupabaseAuth] 使用本地自定义配置');
  }
  
  console.log('[SupabaseAuth] 正在初始化，URL:', config.url);
  
  try {
    // 动态导入 Supabase
    console.log('[SupabaseAuth] 正在加载 @supabase/supabase-js...');
    const { createClient } = require('@supabase/supabase-js');
    console.log('[SupabaseAuth] @supabase/supabase-js 加载成功');
    
    let candidateList = [];
    try {
      candidateList = buildCandidateBases(config.url, config);
    } catch (e) {
      // 兜底：至少保留直连
      candidateList = [{ base: normalizeBase(config.url), label: '直连' }];
    }
    candidateBases = candidateList.filter((x) => x.base);
    console.log('[SupabaseAuth] 候选端点:', candidateBases.map((c) => `${c.label}=${c.base}`).join(' , '));
    if (lastGoodBase && !candidateBases.some((c) => c.base === lastGoodBase.base)) lastGoodBase = null;

    supabaseClient = createClient(config.url, config.key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        storage: fileStorage
      },
      realtime: {
        enabled: false
      },
      global: {
        // 所有请求（auth / rest / storage）统一走带重试与端点兜底的网络层
        fetch: resilientFetch
      }
    });
    console.log('[SupabaseAuth] 初始化成功！');
    
    // 恢复登录状态
    restoreSession();
  } catch (e) {
    console.error('[SupabaseAuth] 初始化失败:', e.message);
    console.error('[SupabaseAuth] 错误详情:', e);
    console.error('[SupabaseAuth] 堆栈:', e.stack);
  }
}

// ==================== 会话恢复 ====================
async function restoreSession() {
  if (!supabaseClient) return;
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (session) {
      currentUser = session.user;
      console.log('[SupabaseAuth] 已恢复登录状态:', currentUser.email);
    }
  } catch (e) {
    console.error('[SupabaseAuth] 恢复会话失败:', e.message);
  }
}

// ==================== 配置相关 IPC ====================
function handleGetConfig() {
  // 配置已内置，始终返回已配置状态
  return {
    configured: true,
    url: DEFAULT_CONFIG.url,
    hasKey: true
  };
}

function handleSaveConfig(event, { url, key }) {
  if (!url || !key) {
    return { success: false, error: 'URL 和密钥不能为空' };
  }
  
  const result = saveConfig({ url, key });
  if (result) {
    // 重新初始化
    loadConfigAndInit();
    return { success: true, message: '配置已保存' };
  }
  return { success: false, error: '保存配置失败' };
}

// ==================== 用户名 → 邮箱 解析 ====================
// 级联策略（从可靠到兜底）：
//   1) 本机映射（登录/注册成功时写入，最可靠）；
//   2) profiles 表（若表里有 email 列且权限允许）；
//   3) 后端 RPC get_email_by_username —— 但先用「随机探针」自校验：
//      两次随机用户名返回同一个邮箱 ⇒ 该 RPC 是坏的（实测确实恒返回 testuser001@example.com），
//      此时不再信任它，直接让用户用邮箱登录，而不是拿假邮箱去撞别说不说清楚。
let rpcProbe = { checkedAt: 0, trusted: false };
const RPC_PROBE_TTL_MS = 6 * 60 * 60 * 1000;

async function callEmailRpc(name) {
  const { data, error } = await supabaseClient.rpc('get_email_by_username', { username: name });
  if (error) throw error;
  return data;
}

async function emailRpcIsBroken() {
  if (Date.now() - rpcProbe.checkedAt < RPC_PROBE_TTL_MS) return !rpcProbe.trusted;
  try {
    const a = await callEmailRpc('__ail_probe_' + Math.random().toString(36).slice(2, 10));
    const b = await callEmailRpc('__ail_probe_' + Math.random().toString(36).slice(2, 10));
    // 两个不同的随机串：都查不到(null) ⇒ 正常；返回同一个邮箱 ⇒ 恒值，坏的
    const trusted = (a === null || a === undefined) && (b === null || b === undefined) ? true : a !== b;
    rpcProbe = { checkedAt: Date.now(), trusted };
    console.log('[SupabaseAuth] 用户名查邮箱 RPC 自校验:', trusted ? '可用' : '返回恒值，已停用');
  } catch (e) {
    rpcProbe = { checkedAt: Date.now(), trusted: false };
    console.warn('[SupabaseAuth] RPC 自校验失败:', e.message);
  }
  return !rpcProbe.trusted;
}

async function resolveEmailByUsername(rawUsername) {
  const username = String(rawUsername || '').trim();
  if (!username) return { success: false, error: '请输入用户名' };

  // 1) 本机映射（大小写不敏感）
  const map = loadUserMap();
  const local = map[username.toLowerCase()];
  if (local && local.email) {
    return { success: true, email: local.email, source: 'local' };
  }

  // 2) profiles 表（有 email 列时可用）
  try {
    const { data, error } = await supabaseClient
      .from('profiles')
      .select('username,email')
      .ilike('username', username)
      .maybeSingle();
    if (!error && data && data.email) {
      recordUserMapping(data.username || username, data.email, '');
      return { success: true, email: data.email, source: 'profiles' };
    }
  } catch (e) {
    // profiles 无 email 列 / 权限不足等，忽略继续走 RPC
  }

  // 3) RPC（自校验通过才用）
  if (!(await emailRpcIsBroken())) {
    const email = await callEmailRpc(username);
    if (email && typeof email === 'string' && email.indexOf('@') > 0) {
      return { success: true, email, source: 'rpc' };
    }
  }

  return {
    success: false,
    error: '本机没有记录该用户名，服务端也未开启可靠的用户名查询。请改用邮箱登录（用邮箱登录一次后，本机即可记住用户名）'
  };
}

async function handleGetEmailByUsername(event, { username }) {
  if (!supabaseClient) {
    return { success: false, error: 'Supabase 初始化失败，请检查网络连接' };
  }
  try {
    const r = await resolveEmailByUsername(username);
    console.log('[SupabaseAuth] 用户名解析:', username, '->', r.success ? r.email + ' (via ' + r.source + ')' : '失败');
    return r;
  } catch (error) {
    return netFail(error);
  }
}

// ==================== 认证相关 IPC ====================
async function handleLogin(event, { email, password }) {
  if (!supabaseClient) {
    return { success: false, error: 'Supabase 初始化失败，请检查网络连接' };
  }
  
  try {
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) throw error;
    
    currentUser = data.user;
    const view = await getUserView();
    
    return {
      success: true,
      user: {
        id: currentUser.id,
        email: currentUser.email,
        username: view.username,
        nickname: view.nickname,
        avatar_url: view.avatar_url
      }
    };
  } catch (error) {
    return netFail(error);
  }
}

// ==================== GitHub 登录 ====================
async function handleGitHubLogin() {
  if (!supabaseClient) {
    return { success: false, error: 'Supabase 初始化失败，请检查网络连接' };
  }
  
  try {
    const { data, error } = await supabaseClient.auth.signInWithOAuth({
      provider: 'github',
      options: {
        redirectTo: 'ailobster://auth/callback'
      }
    });
    if (error) throw error;
    
    // 在系统浏览器中打开 GitHub 授权页面
    if (data.url) {
      shell.openExternal(data.url);
    }
    
    return { success: true, url: data.url };
  } catch (error) {
    return netFail(error);
  }
}

// ==================== 注册 ====================
async function handleRegister(event, { nickname, username, email, password }) {
  if (!supabaseClient) {
    return { success: false, error: 'Supabase 初始化失败，请检查网络连接' };
  }
  
  try {
    const { data, error } = await supabaseClient.auth.signUp({
      email,
      password,
      options: { data: { username, nickname } }
    });
    if (error) throw error;
    
    currentUser = data.user;
    
    // 本机记住 用户名→邮箱，下次即可用用户名登录（不依赖后端 RPC）
    try { recordUserMapping(username, email, nickname); } catch (e) { /* ignore */ }
    
    // 创建用户资料（网络波动导致写入失败不应让注册失败，否则用户再次注册会被提示“已注册”）
    if (currentUser) {
      try {
        await supabaseClient.from('profiles').upsert({
          id: currentUser.id,
          username,
          nickname: nickname || username
        });
      } catch (e) {
        console.warn('[SupabaseAuth] 注册后写入 profiles 失败（忽略）:', e.message);
      }
      try {
        await supabaseClient.from('user_settings').upsert({
          id: currentUser.id,
          merit_count: 0,
          tap_count: 0,
          theme: 'default',
          sound_enabled: true,
          auto_combo: false
        });
      } catch (e) {
        console.warn('[SupabaseAuth] 注册后写入 user_settings 失败（忽略）:', e.message);
      }
    }
    
    return {
      success: true,
      user: {
        id: currentUser.id,
        email: currentUser.email,
        username,
        nickname: nickname || username
      }
    };
  } catch (error) {
    return netFail(error);
  }
}

// ==================== 登出 ====================
async function handleLogout() {
  if (!supabaseClient || !currentUser) {
    return { success: false, error: '未登录' };
  }
  
  try {
    await supabaseClient.auth.signOut();
    currentUser = null;
    return { success: true };
  } catch (e) {
    return netFail(e);
  }
}

// 清除会话存储（不清除 currentUser，用于不自动登录的情况）
async function handleClearSession() {
  try {
    // 直接删除会话文件，不调用 signOut（这样 currentUser 不会被清除）
    if (SESSION_PATH && fs.existsSync(SESSION_PATH)) {
      fs.unlinkSync(SESSION_PATH);
      console.log('[SupabaseAuth] 会话存储已清除（不自动登录模式）');
    }
    return { success: true };
  } catch (e) {
    console.error('[SupabaseAuth] 清除会话存储失败:', e.message);
    return netFail(e);
  }
}

// ==================== 修改邮箱 ====================
async function handleUpdateEmail(event, { email }) {
  if (!supabaseClient || !currentUser) {
    return { success: false, error: '未登录' };
  }
  
  try {
    const { data, error } = await supabaseClient.auth.updateUser({ email });
    if (error) throw error;
    
    return { success: true, message: '邮箱修改成功，请查收验证邮件' };
  } catch (error) {
    return netFail(error);
  }
}

// ==================== 密码找回（发送重置密码邮件）====================
async function handleResetPassword(event, { email }) {
  if (!supabaseClient) {
    return { success: false, error: 'Supabase 初始化失败，请检查网络连接' };
  }
  
  try {
    const { data, error } = await supabaseClient.auth.resetPasswordForEmail(email, {
      redirectTo: 'ailobster://reset-password'
    });
    if (error) throw error;
    
    return { success: true, message: '重置密码邮件已发送，请查收' };
  } catch (error) {
    return netFail(error);
  }
}

// ==================== 当前用户视图（带兜底） ====================
// profiles 行可能不存在（注册时被 RLS 拦截、写入断网、老账号等），
// 以前这种情况会让 username/nickname 全空 → UI 显示「用户」且邮箱昵称识别失败。
// 现在按 profiles → user_metadata → email 前缀 逐级兜底，并后台补建 profiles 行。
async function getUserView() {
  const profile = await loadUserProfile();
  const meta = (currentUser && currentUser.user_metadata) || {};
  const emailLocal = currentUser && currentUser.email ? String(currentUser.email).split('@')[0] : '';
  const username = (profile && profile.username) || meta.username || emailLocal || '';
  const nickname = (profile && profile.nickname) || meta.nickname || meta.name || meta.full_name || username || emailLocal || '';
  // 头像：优先读本机持久化的头像文件（重启后仍能读到），否则用云端 profiles/user_metadata 兜底
  const cloudAvatar = (profile && profile.avatar_url) || meta.avatar_url || '';
  const avatar_url = loadLocalAvatar(currentUser && currentUser.id) || cloudAvatar;

  // 仅在「确认行不存在」(loadUserProfile 返回 null，而非 undefined=查询失败) 时才补建，
  // 避免网络抖动时误判缺失、upsert 覆盖掉云端已有资料
  if (currentUser && profile === null && username) {
    maybeHealProfile(username, nickname);
  }
  if (currentUser) {
    recordUserMapping(username, currentUser.email, nickname);
  }
  return { username, nickname, avatar_url, hasProfile: !!profile };
}

// 后台补建 profiles / user_settings，并回写 user_metadata（失败一律忽略）
async function maybeHealProfile(username, nickname) {
  if (!supabaseClient || !currentUser) return;
  try {
    // ⚠️ 不写 avatar_url：upsert 只更新给出的列，带 avatar_url:null 会把
    // 已有行的云端头像抹掉（此处本意只是补建缺失行）。
    await supabaseClient.from('profiles').upsert({
      id: currentUser.id,
      username,
      nickname: nickname || username
    });
    console.log('[SupabaseAuth] 已补齐缺失的 profiles 行:', username);
  } catch (e) {
    console.warn('[SupabaseAuth] 补齐 profiles 失败（忽略）:', e.message);
  }
  try {
    await supabaseClient.from('user_settings').upsert({
      id: currentUser.id,
      merit_count: 0,
      tap_count: 0,
      theme: 'default',
      sound_enabled: true,
      auto_combo: false
    });
  } catch (e) {
    // 已存在或权限不足都无妨
  }
  try {
    await supabaseClient.auth.updateUser({ data: { username, nickname } });
  } catch (e) {
    // metadata 回写失败不影响使用
  }
}

// ==================== 获取当前用户 ====================
async function handleGetCurrentUser() {
  if (!currentUser) return { loggedIn: false };
  
  const view = await getUserView();
  
  return {
    loggedIn: true,
    user: {
      id: currentUser.id,
      email: currentUser.email,
      username: view.username,
      nickname: view.nickname,
      avatar_url: view.avatar_url
    }
  };
}

// ==================== 加载用户资料 ====================
// 注意：单行查询「查不到」会返回 PGRST116，这不是异常，别打成 error 唬人
async function loadUserProfile() {
  if (!supabaseClient || !currentUser) return null;
  
  try {
    const { data, error } = await supabaseClient
      .from('profiles')
      .select('*')
      .eq('id', currentUser.id)
      .maybeSingle();
    
    if (error) {
      if (error.code === 'PGRST116') return null; // 没有资料行
      throw error;
    }
    return data || null;
  } catch (e) {
    // ⚠️ 必须区分「行不存在」(null) 与「查询失败」(undefined)：
    // 网络抖动时若也返回 null，getUserView 会误判为行缺失并触发 maybeHealProfile，
    // 其 upsert 会把云端已有的 avatar_url 覆盖为 null → 头像被抹掉变默认头像。
    console.warn('[SupabaseAuth] 加载用户资料失败（不视为行缺失）:', e.message);
    return undefined;
  }
}

// ==================== 本地头像持久化 ====================
// 背景：上传头像被存成 base64 data URL（20KB 图片约 27KB 字符串）写入云端 profiles.avatar_url，
// 该列无法可靠容纳超长值，重启后读回的头像损坏/截断，`<img>` 加载失败即回落到默认头像。
// 方案：头像按用户以本地文件持久化，重启后优先读本地（转 data URL），云端 avatar_url 仅作跨设备兜底。
function avatarFilePrefix(userId) {
  return String(userId || '').replace(/[^a-zA-Z0-9_-]/g, '_') + '.avatar';
}

function saveLocalAvatar(userId, dataUrl) {
  try {
    if (!AVATAR_DIR || !userId || typeof dataUrl !== 'string' || dataUrl.indexOf('data:') !== 0) return null;
    const comma = dataUrl.indexOf(',');
    if (comma < 0) return null;
    const meta = dataUrl.slice(5, comma);             // 形如 "image/png;base64"
    const mime = (meta.split(';')[0] || 'image/png').toLowerCase();
    const ext = (mime.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
    const buf = Buffer.from(dataUrl.slice(comma + 1), 'base64');
    if (!buf.length) return null;
    const file = path.join(AVATAR_DIR, avatarFilePrefix(userId) + '.' + ext);
    fs.writeFileSync(file, buf);
    return file;
  } catch (e) {
    console.warn('[SupabaseAuth] 保存本地头像失败:', e.message);
    return null;
  }
}

function loadLocalAvatar(userId) {
  try {
    if (!AVATAR_DIR || !userId) return null;
    if (!fs.existsSync(AVATAR_DIR)) return null;
    const prefix = avatarFilePrefix(userId);
    const files = fs.readdirSync(AVATAR_DIR).filter((f) => f.startsWith(prefix + '.'));
    if (!files.length) return null;
    const file = path.join(AVATAR_DIR, files[0]);
    const buf = fs.readFileSync(file);
    const ext = (String(file).split('.').pop() || 'png').toLowerCase();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/' + ext;
    return 'data:' + mime + ';base64,' + buf.toString('base64');
  } catch (e) {
    console.warn('[SupabaseAuth] 读取本地头像失败:', e.message);
    return null;
  }
}

function deleteLocalAvatar(userId) {
  try {
    if (!AVATAR_DIR || !userId) return;
    if (!fs.existsSync(AVATAR_DIR)) return;
    const prefix = avatarFilePrefix(userId);
    fs.readdirSync(AVATAR_DIR)
      .filter((f) => f.startsWith(prefix + '.'))
      .forEach((f) => { try { fs.unlinkSync(path.join(AVATAR_DIR, f)); } catch (e) { /* 忽略 */ } });
  } catch (e) { /* 忽略 */ }
}

// ==================== 更新用户资料 ====================
async function handleUpdateProfile(event, { username, nickname, avatar_url }) {
  if (!supabaseClient || !currentUser) {
    return { success: false, error: '未登录' };
  }
  
  try {
    // 用户名不可修改：始终补齐已有的用户名，避免前端传空把 profiles.username 写成空串
    const profile = await loadUserProfile();
    const meta = currentUser.user_metadata || {};
    const emailLocal = currentUser.email ? String(currentUser.email).split('@')[0] : '';
    const finalUsername = String(username || profile?.username || meta.username || emailLocal || '').trim();

    const updateData = { id: currentUser.id, username: finalUsername };
    if (nickname !== undefined) updateData.nickname = nickname || finalUsername;
    if (avatar_url !== undefined) {
      updateData.avatar_url = avatar_url || null;
      // 本地持久化头像：base64(data:) 写入本地文件（重启后优先读本地，规避云端列超长截断）
      if (avatar_url && String(avatar_url).indexOf('data:') === 0) {
        saveLocalAvatar(currentUser.id, avatar_url);
      } else if (!avatar_url) {
        // 用户主动清空头像 → 同时删除本地文件
        deleteLocalAvatar(currentUser.id);
      }
    }
    
    const { error } = await supabaseClient
      .from('profiles')
      .upsert(updateData);
    
    if (error) throw error;

    // 资料行可能此前不存在，这里同步一次 user_metadata 作为兜底来源
    try {
      await supabaseClient.auth.updateUser({ data: { username: finalUsername, nickname: updateData.nickname } });
    } catch (e) { /* 忽略 */ }
    try { recordUserMapping(finalUsername, currentUser.email, updateData.nickname); } catch (e) { /* 忽略 */ }
    
    return {
      success: true,
      message: '个人信息已更新',
      user: { username: finalUsername, nickname: updateData.nickname || finalUsername, avatar_url: updateData.avatar_url || '' }
    };
  } catch (error) {
    return netFail(error);
  }
}

// ==================== 修改密码 ====================
async function handleChangePassword(event, { oldPassword, newPassword }) {
  if (!supabaseClient || !currentUser) {
    return { success: false, error: '未登录' };
  }
  
  try {
    // 先验证旧密码
    const { error: signInError } = await supabaseClient.auth.signInWithPassword({
      email: currentUser.email,
      password: oldPassword
    });
    
    if (signInError) {
      return { success: false, error: '旧密码不正确' };
    }
    
    // 更新密码
    const { data, error } = await supabaseClient.auth.updateUser({
      password: newPassword
    });
    
    if (error) throw error;
    
    return { success: true, message: '密码修改成功' };
  } catch (error) {
    return netFail(error);
  }
}

// ==================== 云端设置同步 ====================
async function handleLoadSettings() {
  if (!supabaseClient || !currentUser) {
    return { success: false, error: '未登录' };
  }
  
  try {
    const { data, error } = await supabaseClient
      .from('user_settings')
      .select('*')
      .eq('id', currentUser.id)
      .single();
    
    if (error) throw error;
    
    return { success: true, settings: data };
  } catch (error) {
    return netFail(error);
  }
}

async function handleSyncSettings(event, settings) {
  if (!supabaseClient || !currentUser) {
    return { success: false, error: '未登录' };
  }
  
  try {
    const { data, error } = await supabaseClient
      .from('user_settings')
      .upsert({
        id: currentUser.id,
        ...settings,
        updated_at: new Date().toISOString()
      });
    
    if (error) throw error;
    
    return { success: true, message: '设置已同步' };
  } catch (error) {
    return netFail(error);
  }
}

// ==================== 注册 IPC 处理函数 ====================
function registerIpcHandlers() {
  ipcMain.handle('supabase:get-config', handleGetConfig);
  ipcMain.handle('supabase:save-config', handleSaveConfig);
  ipcMain.handle('supabase:login', handleLogin);
  ipcMain.handle('supabase:get-email-by-username', handleGetEmailByUsername);
  ipcMain.handle('supabase:github-login', handleGitHubLogin);
  ipcMain.handle('supabase:register', handleRegister);
  ipcMain.handle('supabase:logout', handleLogout);
  ipcMain.handle('supabase:clearSession', handleClearSession);
  ipcMain.handle('supabase:update-email', handleUpdateEmail);
  ipcMain.handle('supabase:reset-password', handleResetPassword);
  ipcMain.handle('supabase:get-current-user', handleGetCurrentUser);
  ipcMain.handle('supabase:update-profile', handleUpdateProfile);
  ipcMain.handle('supabase:change-password', handleChangePassword);
  ipcMain.handle('supabase:load-settings', handleLoadSettings);
  ipcMain.handle('supabase:sync-settings', handleSyncSettings);
  ipcMain.handle('supabase:diagnose', handleDiagnose);
}

module.exports = {
  init,
  // 供离线诊断脚本使用（scripts/check-supabase-net.js）
  __net: {
    diagnose: handleDiagnose, buildCandidateBases, friendlyError,
    getSystemProxy, resilientFetch, isNetworkError
  },
  // 供联调脚本直接调用 IPC 处理函数（无需渲染进程）
  __handlers: {
    getConfig: handleGetConfig,
    login: handleLogin,
    register: handleRegister,
    getCurrentUser: handleGetCurrentUser,
    updateProfile: handleUpdateProfile,
    getEmailByUsername: handleGetEmailByUsername,
    loadSettings: handleLoadSettings
  }
};



