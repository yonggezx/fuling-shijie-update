/**
 * 智能商城引擎（本地，无服务器）
 * ============================================================
 * 「不需要服务器」的实现：商城目录**内置在应用里**（出厂 marketplace.yaml +
 * 用户可导入的 catalog.yaml），条目通过**公开 URL** 直接拉取：
 *   · source.kind = github → 从 GitHub raw 拉文件（有 git 就从 git 拉）
 *   · source.kind = url   → 从任意公开 https 拉单文件或 zip（git 没有就拉其他社区资源）
 *   · source.kind = inline→ 定义内嵌在目录里，无网络
 *
 * 三类条目：
 *   · skill（能力包）：SKILL.md（+可选资产）装进 data/skills/<id>/，注入 AI
 *   · mcp：MCP 服务器配置装进 data/marketplace/mcp.yaml，并入 mcpManager，一键启用
 *   · agent：智能体角色写入 data/agent_roles.json
 *
 * 安装状态：data/marketplace/installed.yaml（id/type/enabled/installedAt/from/bytes/files）
 * 安装包：data/marketplace/packages/<type>-<id>.zip（含定义 + 关联技能全部文件）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { extractZip } = require('./zipExtract');
const { buildZip } = require('./zipWrite');
const skillsRegistry = require('./skillsRegistry');
const credentialStore = require('../config/credentialStore');

let mcpManager = null;   // 延迟注入，避免模块加载期循环依赖
let userDataDir = null;
let FACTORY_DIR = null;  // src/main/agent-config
let progressCallback = null;
let suppressProgress = false;

function emitProgress(id, phase, percent, detail) {
  if (!progressCallback || suppressProgress) return;
  try {
    progressCallback({
      id: String(id || ''),
      phase: String(phase || ''),
      percent: Math.max(0, Math.min(100, Math.round(Number(percent) || 0))),
      detail: String(detail || '')
    });
  } catch (e) { /* 忽略 */ }
}

const MAX_DOWNLOAD = 64 * 1024 * 1024; // 单次下载上限 64MB
// GitHub 一个技能要拉几十个 raw 文件，复用 TLS 连接能省掉每个文件的握手时间。
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });

function init(opts) {
  userDataDir = opts.userDataDir;
  FACTORY_DIR = opts.factoryDir || path.join(__dirname, '..', 'agent-config');
  mcpManager = opts.mcpManager || null;
  progressCallback = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  skillsRegistry.init(userDataDir);
  ensureDirs();
  seedUserCatalogIfMissing();
  // 老版本安装过的出厂智能体（例如「数据图表师」）只有 1.2KB 空壳：
  // 启动后异步补齐出厂声明的关联技能并重建安装包，不阻塞窗口。
  const repairTimer = setTimeout(() => {
    repairInstalledFactoryAgentPackages().catch(e => console.warn('[Market] 修复智能体安装包失败:', e.message));
  }, 2500);
  if (repairTimer && typeof repairTimer.unref === 'function') repairTimer.unref();
  return api;
}

function marketplaceDir() { return path.join(userDataDir, 'marketplace'); }
function skillsRoot() { return path.join(userDataDir, 'skills'); }
function installedFile() { return path.join(marketplaceDir(), 'installed.yaml'); }
function catalogFile() { return path.join(marketplaceDir(), 'catalog.yaml'); }
function mcpFile() { return path.join(marketplaceDir(), 'mcp.yaml'); }
function agentRolesFile() { return path.join(userDataDir, 'agent_roles.json'); }

// ── 安装包落盘 ───────────────────────────────────────────────────────────────
// 每个下载的智能体 / 技能都会打成一个真实 zip：
//   data/marketplace/packages/agent-<id>.zip
//   data/marketplace/packages/skill-<id>.zip
// 包里含 manifest.json + 智能体定义 + 关联技能的全部文件，
// 这样「下载」有真实体积和文件数，卸载时整包删除。
function packagesDir() { return path.join(marketplaceDir(), 'packages'); }
function packageFile(type, id) {
  return path.join(packagesDir(), String(type || 'item') + '-' + sanitizeId(id) + '.zip');
}

function dirStats(dir) {
  let bytes = 0, files = 0;
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        const sub = dirStats(p);
        bytes += sub.bytes; files += sub.files;
      } else if (ent.isFile()) {
        bytes += fs.statSync(p).size; files += 1;
      }
    }
  } catch (e) { /* 忽略 */ }
  return { bytes, files };
}

function collectDirEntries(dir, prefix, out) {
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      const name = prefix ? prefix + '/' + ent.name : ent.name;
      if (ent.isDirectory()) collectDirEntries(p, name, out);
      else if (ent.isFile()) out.push({ name, data: fs.readFileSync(p) });
    }
  } catch (e) { /* 忽略 */ }
}

async function writeInstallPackage(type, id, manifest, extraEntries, onProgress) {
  try {
    fs.mkdirSync(packagesDir(), { recursive: true });
    // 和常见的技能压缩包一样，最外层只放一个同名文件夹，避免解压出一地散文件。
    const root = sanitizeId(String(id)) || 'package';
    const entries = [
      { name: root + '/manifest.json', data: JSON.stringify(manifest, null, 2) }
    ].concat((extraEntries || []).map(e => ({ name: root + '/' + e.name, data: e.data })));
    const buf = await buildZip(entries, { onProgress });
    const file = packageFile(type, id);
    fs.writeFileSync(file, buf);
    return {
      packageBytes: buf.length,
      packageFiles: entries.length,
      packagePath: path.relative(userDataDir, file).replace(/\\/g, '/'),
      packageRoot: root
    };
  } catch (e) {
    console.warn('[Market] 打包失败:', e.message);
    return { packageBytes: 0, packageFiles: 0, packagePath: '', packageRoot: '' };
  }
}

function ensureDirs() {
  for (const d of [marketplaceDir(), skillsRoot()]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* 忽略 */ }
  }
}

let _yaml = null;
try { _yaml = require('js-yaml'); } catch (e) { /* js-yaml 一定有 */ }

// ── 出厂播种 / 目录升级 ──────────────────────────────────────────────────────
// 打包安装后 userData 是全新的系统目录，若用户目录无 catalog，
// 从打包资源（agent-config/marketplace-catalog.seed.yaml，含魔搭全量目录）复制一份。
// 已有目录（开发模式 / 老版本升级）不整包覆盖，但出厂 seed 更新时要按 id 合并：
// 旧版智能体目录只存 1200 字提示词，合并后才会换成完整系统指令和关联技能。
function seedMetaFile() { return path.join(marketplaceDir(), '.seed-meta.json'); }

function seedFingerprint(seedPath) {
  try {
    const st = fs.statSync(seedPath);
    return st.size + '-' + Math.round(st.mtimeMs);
  } catch (e) { return ''; }
}

function syncInstalledAgentRolesFromSeed(seedAgents) {
  try {
    const roles = loadAgentRoles();
    const byId = new Map(seedAgents.map(a => [a.id, a.role]).filter(x => x[1]));
    let changed = false;
    for (const role of roles) {
      if (!role || role.installedFrom !== 'marketplace') continue;
      const seedRole = byId.get(role.id);
      if (!seedRole) continue;
      // 只修「旧版目录生成」的安装记录：被截断的、或还带着旧版「需自行配置」提示的。
      const oldPrompt = typeof role.systemPrompt === 'string' ? role.systemPrompt : '';
      const isOldBundle = oldPrompt.includes('已截断') || oldPrompt.includes('在本地需自行配置对应工具');
      if (isOldBundle && seedRole.systemPrompt) {
        role.systemPrompt = seedRole.systemPrompt;
        role.tools = seedRole.tools || role.tools;
        role.skills = seedRole.skills || role.skills;
        role.mcps = seedRole.mcps || role.mcps;
        changed = true;
      }
    }
    if (changed) saveAgentRoles(roles);
  } catch (e) { console.warn('[Market] 同步已安装智能体内容失败:', e.message); }
}

function seedUserCatalogIfMissing() {
  try {
    const seed = path.join(FACTORY_DIR, 'marketplace-catalog.seed.yaml');
    if (!fs.existsSync(seed)) return;
    const fp = seedFingerprint(seed);
    const metaPath = seedMetaFile();
    let meta = null;
    try { if (fs.existsSync(metaPath)) meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (e) { meta = null; }

    if (!fs.existsSync(catalogFile())) {
      fs.copyFileSync(seed, catalogFile());
      fs.writeFileSync(metaPath, JSON.stringify({ fingerprint: fp, seededAt: new Date().toISOString() }), 'utf8');
      console.log('[Market] 首次启动：已从出厂 seed 播种商城目录（' + fs.statSync(catalogFile()).size + ' bytes）');
      return;
    }
    if (meta && meta.fingerprint === fp) return;

    // seed 有更新：按 id 合并到用户目录。用户自己导入的条目保留，同 id 的出厂条目升级。
    const seedItems = (_yaml.load(fs.readFileSync(seed, 'utf8'), { json: true }) || {}).marketplace || [];
    const userItems = (_yaml.load(fs.readFileSync(catalogFile(), 'utf8'), { json: true }) || {}).marketplace || [];
    const merged = new Map();
    for (const it of userItems) if (it && it.id) merged.set(it.id, it);
    for (const it of seedItems) if (it && it.id) merged.set(it.id, it);
    fs.writeFileSync(catalogFile(), _yaml.dump({ marketplace: Array.from(merged.values()) }, { lineWidth: -1, noRefs: true }), 'utf8');
    fs.writeFileSync(metaPath, JSON.stringify({ fingerprint: fp, seededAt: new Date().toISOString() }), 'utf8');
    console.log('[Market] 出厂目录已升级：' + seedItems.length + ' 条，合并后 ' + merged.size + ' 条');

    const seedAgents = seedItems.filter(it => it.type === 'agent');
    syncInstalledAgentRolesFromSeed(seedAgents);
  } catch (e) {
    console.warn('[Market] 播种/升级商城目录失败:', e.message);
  }
}

// ── 目录装载 ────────────────────────────────────────────────────────────────
function loadFactoryCatalog() {
  const p = path.join(FACTORY_DIR, 'marketplace.yaml');
  try {
    if (!fs.existsSync(p)) return [];
    const data = _yaml.load(fs.readFileSync(p, 'utf8')) || {};
    return Array.isArray(data.marketplace) ? data.marketplace : [];
  } catch (e) { console.warn('[Market] 出厂目录解析失败:', e.message); return []; }
}

function loadUserCatalog() {
  try {
    if (!fs.existsSync(catalogFile())) return [];
    const data = _yaml.load(fs.readFileSync(catalogFile(), 'utf8')) || {};
    return Array.isArray(data.marketplace) ? data.marketplace : [];
  } catch (e) { console.warn('[Market] 用户目录解析失败:', e.message); return []; }
}

function loadInstalled() {
  try {
    if (!fs.existsSync(installedFile())) return [];
    const data = _yaml.load(fs.readFileSync(installedFile(), 'utf8')) || {};
    return Array.isArray(data.installed) ? data.installed : [];
  } catch (e) { return []; }
}

function saveInstalled(list) {
  fs.writeFileSync(installedFile(), _yaml.dump({ installed: list }), 'utf8');
}

function getInstalled(id) {
  return loadInstalled().find(i => i.id === id) || null;
}

function getCatalogItem(id) {
  return [...loadFactoryCatalog(), ...loadUserCatalog()].find(i => i.id === id) || null;
}

// ── 列表 ─────────────────────────────────────────────────────────────────────
function estimateCatalogBytes(it) {
  try {
    if (it.type === 'agent') {
      const role = it.role || (it.source && it.source.roleJson) || null;
      if (role) return Buffer.byteLength(typeof role === 'string' ? role : JSON.stringify(role), 'utf8');
      return 0;
    }
    if (it.type === 'skill') {
      const md = it.source && it.source.skillMd;
      if (md) return Buffer.byteLength(String(md), 'utf8');
      return 0;
    }
    if (it.type === 'mcp') return Buffer.byteLength(JSON.stringify(it.mcpServer || {}), 'utf8');
  } catch (e) { /* 忽略 */ }
  return 0;
}

function installedPackageStats(it, inst) {
  const catalogDeps = it.type === 'agent' && it.role
    ? ((Array.isArray(it.role.skills) ? it.role.skills.length : 0)
      + (Array.isArray(it.role.mcps) ? it.role.mcps.length : 0))
    : 0;
  // 出厂目录已经声明了技能，但旧安装包只有 1KB 左右：标记为待重建，不把空壳大小当最终大小。
  if (catalogDeps && inst && !inst.repairAttemptedAt && Number(inst.bytes) > 0 && Number(inst.bytes) < 20 * 1024) {
    return { bytes: 0, files: 0, packagePath: '' };
  }
  if (inst && Number(inst.bytes) > 0) {
    return { bytes: Number(inst.bytes), files: Number(inst.files) || 0, packagePath: inst.packagePath || '' };
  }
  // 老版本安装记录没有包信息：现场按目录 / 角色内容补算，保证卡片能显示真实体积。
  if (it.type === 'skill') {
    const st = dirStats(path.join(skillsRoot(), sanitizeId(it.id)));
    return { bytes: st.bytes, files: st.files, packagePath: '' };
  }
  if (it.type === 'agent') {
    const role = loadAgentRoles().find(r => r.id === it.id);
    const hasDeps = role && ((Array.isArray(role.skills) && role.skills.length)
      || (Array.isArray(role.mcps) && role.mcps.length));
    // 老记录已经声明了技能、但安装包还没重建：不要拿「提示词 1.2KB」冒充包大小。
    if (hasDeps && !(inst && inst.packagePath)) {
      return { bytes: 0, files: 0, packagePath: '' };
    }
    let bytes = role ? Buffer.byteLength(JSON.stringify(role), 'utf8') : 0;
    let files = role ? 1 : 0;
    for (const dep of (role && Array.isArray(role.skills) ? role.skills : [])) {
      const depItem = findCatalogDependency('skill', dep);
      if (!depItem) continue;
      const st = dirStats(path.join(skillsRoot(), sanitizeId(depItem.id)));
      bytes += st.bytes; files += st.files;
    }
    return { bytes, files, packagePath: '' };
  }
  return { bytes: 0, files: 0, packagePath: '' };
}

function list() {
  const installed = loadInstalled();
  const items = [...loadFactoryCatalog(), ...loadUserCatalog()];
  const byId = new Map();
  for (const it of items) byId.set(it.id, it); // 后定义覆盖（用户目录覆盖出厂）

  return Array.from(byId.values()).map(it => {
    const inst = installed.find(i => i.id === it.id) || null;
    const pkg = inst ? installedPackageStats(it, inst) : { bytes: 0, files: 0, packagePath: '' };
    return {
      id: it.id,
      type: it.type,
      name: it.name,
      description: it.description || '',
      category: it.category || 'other',
      emoji: it.emoji || (it.type === 'mcp' ? '🔌' : it.type === 'agent' ? '🧭' : '🛠'),
      version: it.version || '1.0.0',
      sourceKind: it.source && it.source.kind ? it.source.kind : 'inline',
      icon: it.icon || null,
      installed: !!inst,
      enabled: inst ? !!inst.enabled : false,
      installedAt: inst ? inst.installedAt : null,
      // 包体积：已安装显示实际 zip 大小，未安装给一个内容估算值
      packageBytes: pkg.bytes || 0,
      packageFiles: pkg.files || 0,
      packagePath: pkg.packagePath || '',
      estimatedBytes: inst ? 0 : estimateCatalogBytes(it),
      // 未安装智能体：告诉用户包里会带几个技能，而不是拿提示词字节数冒充包体积
      skillCount: it.type === 'agent' && it.role && Array.isArray(it.role.skills) ? it.role.skills.length : 0,
      mcpCount: it.type === 'agent' && it.role && Array.isArray(it.role.mcps) ? it.role.mcps.length : 0,
      // MCP 附带当前启用状态（mcpManager 实时），agent/skill 用 installed.enabled
      mcpEnabled: it.type === 'mcp' && mcpManager ? mcpManager.getEnabled().includes(it.id) : null,
      // 授权/托管/启动配置：UI 据此渲染「配置并激活」表单与「查看说明」
      auth: it.auth || null,
      hosted: !!it.hosted,
      mcpServer: it.mcpServer || null,
      from: inst ? inst.from : 'catalog'
    };
  }).sort((a, b) => {
    const typeOrder = { skill: 0, mcp: 1, agent: 2 };
    return (typeOrder[a.type] || 9) - (typeOrder[b.type] || 9) || a.id.localeCompare(b.id);
  });
}

// ── 下载辅助（https，带大小上限与重定向）──────────────────────────────────
let electronNet = null;
try {
  const electron = require('electron');
  if (electron && electron.net && typeof electron.net.fetch === 'function') electronNet = electron.net;
} catch (e) { /* 纯 Node 脚本里没有 Electron，走 https 兜底 */ }

// Electron 的 net.fetch 走 Chromium 网络栈（系统代理 / HTTP2 / 连接复用），
// 比 Node 的 https 在 GitHub 上明显快；纯 Node 测试时仍用 https。
async function fetchBufferNet(url, maxBytes, onProgress, options) {
  const timeoutMs = Number(options.timeoutMs) || 120000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await electronNet.fetch(url, {
      headers: {
        'User-Agent': 'fuling-shijie-marketplace/1.0',
        Accept: '*/*',
        ...(options.headers || {})
      },
      redirect: 'follow',
      signal: controller.signal
    });
    if (!res.ok) throw new Error('下载失败 HTTP ' + res.status + ' : ' + url);
    const total = Number(res.headers.get('content-length')) || 0;
    const chunks = [];
    let size = 0;
    let lastEmit = 0;
    const startedAt = Date.now();
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const readChunk = () => new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('下载超时')), 30000);
        reader.read().then(
          v => { clearTimeout(t); resolve(v); },
          e => { clearTimeout(t); reject(e); }
        );
      });
      while (true) {
        let step;
        try {
          step = await readChunk();
        } catch (e) {
          try { reader.cancel(); } catch (err) { /* 忽略 */ }
          throw e;
        }
        const done = step.done;
        const value = step.value;
        if (done) break;
        size += value.length;
        if (size > maxBytes) { try { reader.cancel(); } catch (e) { /* 忽略 */ } throw new Error('下载超过大小上限'); }
        chunks.push(Buffer.from(value));
        if (onProgress) {
          const now = Date.now();
          if (now - lastEmit > 80 || (total && size >= total)) {
            lastEmit = now;
            const speed = size / Math.max(0.2, (now - startedAt) / 1000);
            try { onProgress({ received: size, total, speed }); } catch (e) { /* 忽略 */ }
          }
        }
      }
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      size = buf.length;
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
  }
}

function fetchBuffer(url, maxBytes = MAX_DOWNLOAD, onProgress, options = {}) {
  if (electronNet) {
    return fetchBufferNet(url, maxBytes, onProgress, options);
  }
  return new Promise((resolve, reject) => {
    const doGet = (u, depth) => {
      let parsed;
      try { parsed = new URL(u); } catch (e) { return reject(new Error('非法 URL: ' + u)); }
      if (parsed.protocol !== 'https:') return reject(new Error('仅支持 https 下载'));
      const headers = {
        'User-Agent': 'fuling-shijie-marketplace/1.0',
        Accept: '*/*',
        ...(options.headers || {})
      };
      const req = https.get(u, {
        headers,
        agent: httpsAgent
      }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (depth >= 5) return reject(new Error('重定向过多'));
          return doGet(new URL(res.headers.location, u).href, depth + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('下载失败 HTTP ' + res.statusCode + ' : ' + u));
        }
        const chunks = [];
        let size = 0;
        let lastEmit = 0;
        const startedAt = Date.now();
        const total = Number(res.headers['content-length']) || 0;
        res.on('data', c => {
          size += c.length;
          if (size > maxBytes) { req.destroy(new Error('下载超过大小上限')); return; }
          chunks.push(c);
          if (onProgress) {
            const now = Date.now();
            if (now - lastEmit > 80 || (total && size >= total)) {
              lastEmit = now;
              const speed = size / Math.max(0.2, (now - startedAt) / 1000);
              try { onProgress({ received: size, total, speed }); } catch (e) { /* 忽略 */ }
            }
          }
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(Number(options.timeoutMs) || 30000, () => req.destroy(new Error('下载超时')));
    };
    doGet(url, 0);
  });
}

/** GitHub raw 单文件（有 git 就从 git 拉） */
async function fetchGithubRaw(repo, filePath, branch = 'main') {
  const url = 'https://raw.githubusercontent.com/' + repo.replace(/^\//, '')
    + '/' + branch + '/' + filePath.replace(/^\//, '');
  const buf = await fetchBuffer(url);
  return buf.toString('utf8');
}

// ── 安装：分派 ───────────────────────────────────────────────────────────────
async function install(id, progressCtx) {
  const it = getCatalogItem(id);
  if (!it) return { success: false, error: '商城不存在该条目: ' + id };
  if (it.type === 'mcp' && it.hosted) {
    return { success: false, error: '该 MCP 为托管服务，请到魔搭控制台登录获取连接信息后使用' };
  }
  const inst = getInstalled(id);
  if (inst && inst.enabled) return { success: false, error: '该条目已安装并启用' };

  let res;
  if (it.type === 'skill') res = await installSkill(it, progressCtx);
  else if (it.type === 'mcp') res = await installMcp(it);
  else if (it.type === 'agent') res = await installAgent(it);
  else return { success: false, error: '未知条目类型: ' + it.type };

  if (!res.success) return res;

  // 记录安装状态（skill/agent 记 enabled；mcp 由 mcpManager 管启用）
  const now = new Date().toISOString();
  const listInst = loadInstalled().filter(x => x.id !== id);
  listInst.push({
    id, type: it.type, enabled: it.type === 'mcp' ? false : true,
    installedAt: now, from: res.from || 'catalog',
    bytes: res.packageBytes || 0,
    files: res.packageFiles || 0,
    packagePath: res.packagePath || ''
  });
  saveInstalled(listInst);

  return {
    success: true, type: it.type, id, name: it.name, detail: res.detail,
    packageBytes: res.packageBytes || 0,
    packageFiles: res.packageFiles || 0,
    packagePath: res.packagePath || ''
  };
}

/**
 * 需授权 MCP：填写密钥并激活。
 * 1) 校验必填项；2) 密钥经 credentialStore 加密存储（明文永不落配置）；
 * 3) 重装条目（catalog 中 env 已是 ${secret:...} 占位，mcpManager 启动时解析）；
 * 4) 自动启用。
 */
async function installWithEnv(id, envValues) {
  const it = getCatalogItem(id);
  if (!it) return { success: false, error: '商城不存在该条目: ' + id };
  if (it.type !== 'mcp' || !Array.isArray(it.auth && it.auth.fields) || !it.auth.fields.length) {
    return { success: false, error: '该条目不需要密钥配置，直接下载启用即可' };
  }
  const values = envValues || {};
  for (const f of it.auth.fields) {
    if (f.required && !values[f.name]) return { success: false, error: '缺少必填配置项：' + f.name };
  }
  // 1) 写入加密凭证库
  for (const f of it.auth.fields) {
    const v = values[f.name];
    if (!v) continue;
    const key = 'mcp-' + sanitizeId(it.id) + '-' + String(f.name).toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const r = credentialStore.setSecret(key, v);
    if (!r.ok) return { success: false, error: '凭证写入失败：' + (r.reason || 'safeStorage 不可用') };
  }
  // 2) 重装（先卸载旧状态，避免"已安装并启用"拦截）
  const inst = getInstalled(id);
  if (inst) {
    const u = uninstall(id);
    if (!u.success) return u;
  }
  // 3) 安装
  const res = await install(id);
  if (!res.success) return res;
  // 4) 启用（installMcp 已把 server 加入 enabled 并尝试启动，此处幂等确认）
  return { success: true, type: 'mcp', id, name: it.name, detail: '密钥已加密保存，MCP「' + it.name + '」已启用' };
}

async function installSkill(it, progressCtx) {
  const skillId = sanitizeId(it.id);
  const target = path.join(skillsRoot(), skillId);
  const src = it.source || {};
  const from = it.installedFrom === 'user' ? 'user' : 'factory';
  const pid = (progressCtx && progressCtx.progressId) || it.id;
  const base = progressCtx && Number.isFinite(progressCtx.base) ? progressCtx.base : 0;
  const span = progressCtx && Number.isFinite(progressCtx.span) ? progressCtx.span : 100;
  const mapPct = p => Math.max(0, Math.min(100, Math.round(base + (Number(p) || 0) * span / 100)));
  const detailPrefix = progressCtx ? '「' + it.name + '」' : '';

  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  emitProgress(pid, '准备下载', mapPct(1), detailPrefix + '正在准备');
  const skillProgress = {
    download: p => {
      const speedTxt = p.speed ? ' · ' + formatSpeed(p.speed) : '';
      if (p.total) {
        const pct = 4 + Math.round((p.received / p.total) * 56);
        const mb = (p.received / 1024 / 1024).toFixed(1);
        const totalMb = (p.total / 1024 / 1024).toFixed(1);
        const fileTxt = p.filesTotal ? p.filesDone + ' / ' + p.filesTotal + ' 个文件 · ' : '';
        emitProgress(pid, p.cached ? '读取缓存' : (p.filesTotal ? '下载技能文件' : '下载技能包'), mapPct(pct),
          detailPrefix + fileTxt + mb + ' / ' + totalMb + ' MB' + speedTxt);
        return;
      }
      if (p.filesTotal) {
        const pct = 4 + Math.round((Number(p.filesDone || 0) / p.filesTotal) * 56);
        emitProgress(pid, p.cached ? '读取缓存' : '下载技能文件', mapPct(pct),
          detailPrefix + p.filesDone + ' / ' + p.filesTotal + ' 个文件 · ' + formatBytes(p.received) + speedTxt);
        return;
      }
      const mb = (p.received / 1024 / 1024).toFixed(1);
      emitProgress(pid, p.cached ? '读取缓存' : '下载技能包', mapPct(20), detailPrefix + mb + ' MB' + speedTxt);
    },
    extract: p => {
      const pct = p.total ? 60 + Math.round((p.done / p.total) * 16) : 65;
      emitProgress(pid, '解压技能包', mapPct(pct), detailPrefix + p.done + ' / ' + p.total + ' 个文件');
    }
  };

  if (src.kind === 'inline') {
    const md = src.skillMd || ('# ' + it.name + '\n\n' + (it.description || ''));
    // ★ 魔搭 catalog 的 inline 通常只是空壳描述，frontmatter 里 source 指向 GitHub 仓库。
    //   如果能解析出 GitHub tree URL，自动从仓库拉完整目录（含所有脚本/资源）。
    const ghMatch = md.match(/github\.com\/([^/\s]+)\/([^/\s]+)\/tree\/([^/\s]+)\/(.+)/);
    if (ghMatch) {
      const repo = ghMatch[1] + '/' + ghMatch[2];
      const branch = ghMatch[3];
      const dirPath = ghMatch[4].trim().replace(/[)\s]+$/, '');
      try {
        console.log('[Market] inline 技能检测到 GitHub 来源，拉取完整目录:', repo, dirPath);
        await fetchRepoDir(repo, dirPath, target, branch, skillProgress);
      } catch (e) {
        console.warn('[Market] GitHub 目录拉取失败，回退到 inline 空壳:', e.message);
        fs.writeFileSync(path.join(target, 'SKILL.md'), md, 'utf8');
      }
    } else {
      fs.writeFileSync(path.join(target, 'SKILL.md'), md, 'utf8');
    }
  } else if (src.kind === 'github') {
    // 技能不是单个 SKILL.md：path 指向 skills/xlsx/SKILL.md 时，改成拉 skills/xlsx 整个目录，
    // 把脚本、模板、参考文件一起装进来。整包失败才退回只拉 SKILL.md。
    const mdPath = String(src.path || '');
    const dirPath = mdPath.replace(/\/?SKILL\.md$/i, '').replace(/\/+$/, '');
    if (dirPath) {
      try {
        await fetchRepoDir(src.repo, dirPath, target, src.branch || 'main', skillProgress);
      } catch (e) {
        console.warn('[Market] 技能整包拉取失败，退回单文件:', e.message);
        if (!/\.md$/i.test(mdPath)) throw e;
        const text = await fetchGithubRaw(src.repo, mdPath, src.branch || 'main');
        fs.writeFileSync(path.join(target, 'SKILL.md'), text, 'utf8');
      }
    } else {
      const text = await fetchGithubRaw(src.repo, mdPath, src.branch || 'main');
      fs.writeFileSync(path.join(target, 'SKILL.md'), text, 'utf8');
    }
  } else if (src.kind === 'url') {
    const buf = await fetchBuffer(src.url);
    if (looksLikeZip(buf)) {
      const tmp = path.join(marketplaceDir(), '_tmp_' + Date.now());
      fs.mkdirSync(tmp, { recursive: true });
      await extractZip(buf, tmp);
      copyTree(tmp, target);
      fs.rmSync(tmp, { recursive: true, force: true });
    } else {
      // 单文件：若以 SKILL.md 命名则直接存；否则存为 SKILL.md
      fs.writeFileSync(path.join(target, 'SKILL.md'), buf.toString('utf8'), 'utf8');
    }
  } else {
    throw new Error('技能条目缺少有效来源');
  }

  // 校验 SKILL.md 已生成
  if (!fs.existsSync(path.join(target, 'SKILL.md'))) {
    fs.rmSync(target, { recursive: true, force: true });
    return { success: false, error: '下载的技能缺少 SKILL.md' };
  }
  const stats = dirStats(target);
  emitProgress(pid, '整理文件', mapPct(77), detailPrefix + stats.files + ' 个文件');
  const entries = [];
  collectDirEntries(target, '', entries);
  const pkg = await writeInstallPackage('skill', skillId, {
    kind: 'skill',
    id: skillId,
    name: it.name,
    version: it.version || '1.0.0',
    installedAt: new Date().toISOString(),
    contentType: 'skill-package',
    archive: skillId + '/',
    bytes: stats.bytes,
    files: stats.files
  }, entries, p => {
    const pct = p.total ? 78 + Math.round((p.done / p.total) * 20) : 85;
    emitProgress(pid, '打包安装包', mapPct(pct), detailPrefix + p.done + ' / ' + p.total + ' 个文件');
  });
  emitProgress(pid, progressCtx ? '关联组件完成' : '完成', mapPct(100),
    detailPrefix + '安装包 ' + formatBytes(pkg.packageBytes) + ' / ' + pkg.packageFiles + ' 个文件');
  const detail = '已下载技能包「' + it.name + '」' + (pkg.packageBytes
    ? '：' + formatBytes(pkg.packageBytes) + ' / ' + pkg.packageFiles + ' 个文件'
    : '') + '（data/skills/' + skillId + '，可在智能商城「已安装」停用/卸载）';
  return { success: true, detail, from, ...pkg };
}

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(v < 10 * 1024 ? 1 : 0) + ' KB';
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(v < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
  return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function formatSpeed(bytesPerSec) {
  const v = Number(bytesPerSec) || 0;
  if (v <= 0) return '';
  if (v < 1024) return Math.round(v) + ' B/s';
  if (v < 1024 * 1024) return (v / 1024).toFixed(0) + ' KB/s';
  return (v / 1024 / 1024).toFixed(1) + ' MB/s';
}

/** 拉 GitHub 仓库的某个子目录（用 codeload 全仓库 zip，再取子目录）。 */
// 同一仓库的多个技能共用一次 zip 下载：装「数据图表师」要拉 xlsx + 多个 office 技能时，
// 避免每个技能都重新下 4MB 全仓库包。
const repoZipCache = new Map();

function githubTreeCacheFile(repo, branch) {
  return path.join(marketplaceDir(), '_cache', 'github-trees',
    sanitizeId(repo + '_' + branch) + '.json');
}

function flattenJsdelivrFiles(list, base, out) {
  for (const f of (Array.isArray(list) ? list : [])) {
    if (!f || !f.name) continue;
    const p = base ? base + '/' + f.name : f.name;
    if (f.type === 'directory') flattenJsdelivrFiles(f.files, p, out);
    else if (f.type === 'file') out.push({ type: 'blob', path: p, size: Number(f.size) || 0 });
  }
}

const githubTreeLoading = new Map();

async function loadGithubTree(repo, branch, timeoutMs) {
  const key = String(repo || '') + '#' + String(branch || '');
  if (githubTreeLoading.has(key)) return githubTreeLoading.get(key);
  const task = loadGithubTreeUncached(repo, branch, timeoutMs);
  githubTreeLoading.set(key, task);
  try {
    return await task;
  } finally {
    githubTreeLoading.delete(key);
  }
}

async function loadGithubTreeUncached(repo, branch, timeoutMs) {
  const cleanRepo = String(repo || '').replace(/^\/|\/$/g, '');
  const cacheFile = githubTreeCacheFile(cleanRepo, branch);
  try {
    if (fs.existsSync(cacheFile)) {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (cached && Array.isArray(cached.tree) && Date.now() - Number(cached.at || 0) < 6 * 3600 * 1000) {
        return cached.tree;
      }
    }
  } catch (e) { /* 缓存损坏就走网络 */ }

  let tree = null;
  // 先用 GitHub 官方 tree：路径和文件大小最准，下载阶段才能按真实字节算进度。
  try {
    const apiUrl = 'https://api.github.com/repos/' + cleanRepo + '/git/trees/'
      + encodeURIComponent(branch) + '?recursive=1';
    const buf = await fetchBuffer(apiUrl, 8 * 1024 * 1024, null, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'fuling-shijie-marketplace/1.0' },
      timeoutMs: timeoutMs || 20000
    });
    const data = JSON.parse(buf.toString('utf8'));
    if (!data || !Array.isArray(data.tree)) throw new Error('GitHub tree 返回缺少 tree');
    if (data.truncated) throw new Error('GitHub tree 过大被截断');
    tree = data.tree.map(e => ({ type: e.type, path: e.path, size: Number(e.size) || 0 }));
  } catch (e) {
    // API 可能被限流（403/429），记录后仍继续走 jsDelivr 清单兜底。
    console.warn('[Market] GitHub tree 失败，改用 jsDelivr 清单:', e.message);
  }

  if (!tree) {
    // 兜底：jsDelivr 的包清单，国内 CDN 快；极少数仓库目录可能与主分支最新提交有偏差，
    // 如果后续某个文件 404，会继续回退整包 zip。
    const listUrl = 'https://data.jsdelivr.com/v1/packages/gh/' + cleanRepo + '@' + encodeURIComponent(branch);
    const buf = await fetchBuffer(listUrl, 16 * 1024 * 1024, null, {
      headers: { Accept: 'application/json' },
      timeoutMs: timeoutMs || 12000
    });
    const data = JSON.parse(buf.toString('utf8'));
    if (data && Array.isArray(data.files)) {
      const flat = [];
      flattenJsdelivrFiles(data.files, '', flat);
      if (flat.length) tree = flat;
    }
  }
  if (!tree || !tree.length) throw new Error('无法读取仓库文件列表');

  try {
    const text = JSON.stringify({ at: Date.now(), tree });
    if (text.length < 8 * 1024 * 1024) {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, text, 'utf8');
    }
  } catch (e) { /* 缓存失败不影响安装 */ }
  return tree;
}

async function githubDirStats(repo, dirPath, branch) {
  const cleanRepo = String(repo || '').replace(/^\/|\/$/g, '');
  const cleanDir = String(dirPath || '').replace(/^\/|\/$/g, '');
  if (!cleanRepo || !cleanDir) return null;
  const tree = await loadGithubTree(cleanRepo, branch, 12000);
  const prefix = cleanDir + '/';
  const files = tree.filter(e => e && e.type === 'blob'
    && typeof e.path === 'string' && e.path.startsWith(prefix));
  return {
    count: files.length,
    bytes: files.reduce((sum, f) => sum + (Number(f.size) || 0), 0)
  };
}

// 快路径：GitHub tree API 列目录 + jsDelivr 并发下文件。
// 很多技能仓库的 zip 有几 MB，而真正属于该技能的文件只有几百 KB；
// 只下需要的文件，比每次拉整仓库快得多。API 被限流 / 目录过大时自动回退整包 zip。
async function fetchGithubDirDirect(repo, dirPath, target, branch, progress = {}) {
  const cleanRepo = String(repo || '').replace(/^\/|\/$/g, '');
  const cleanDir = String(dirPath || '').replace(/^\/|\/$/g, '');
  if (!cleanRepo || !cleanDir) return false;

  const tree = await loadGithubTree(cleanRepo, branch, 20000);

  const prefix = cleanDir + '/';
  const files = tree.filter(e => e && e.type === 'blob'
    && typeof e.path === 'string' && e.path.startsWith(prefix));
  if (!files.length) throw new Error('仓库中找不到目录: ' + cleanDir);
  // 文件太多时逐个请求反而不如整包 zip，直接回退。
  if (files.length > 600) throw new Error('目录文件过多（' + files.length + '），回退整包下载');

  const total = files.length;
  const totalBytes = files.reduce((sum, f) => sum + (Number(f.size) || 0), 0);
  const startedAt = Date.now();
  let next = 0;
  let done = 0;
  let bytes = 0;

  async function worker() {
    while (true) {
      const index = next++;
      if (index >= total) return;
      const file = files[index];
      const rel = file.path.slice(prefix.length);
      const dest = path.join(target, ...rel.split('/'));
      // raw.githubusercontent 在部分网络会被重置；jsDelivr 直接镜像同一个 GitHub 文件，国内更稳。
      const rawUrl = 'https://cdn.jsdelivr.net/gh/' + cleanRepo + '@'
        + encodeURIComponent(branch) + '/' + file.path.split('/').map(encodeURIComponent).join('/');
      let buf = null;
      // raw.githubusercontent 偶发 ECONNRESET；单个文件重试，避免一个文件失败就退回整仓库 4MB。
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          buf = await fetchBuffer(rawUrl, MAX_DOWNLOAD, null);
          break;
        } catch (e) {
          if (attempt >= 2) throw e;
          await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
        }
      }
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.writeFile(dest, buf);
      done++;
      bytes += buf.length;
      if (progress.download) {
        const speed = bytes / Math.max(0.2, (Date.now() - startedAt) / 1000);
        try {
          progress.download({ received: bytes, total: totalBytes, speed, filesDone: done, filesTotal: total });
        } catch (e) { /* 忽略 */ }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(8, total) }, () => worker()));
  return true;
}

async function fetchRepoDir(repo, dirPath, target, branch, progress = {}) {
  // 先试「只下目标目录里的文件」。失败（限流、路径不存在、网络）再回退整仓库 zip。
  try {
    const direct = await fetchGithubDirDirect(repo, dirPath, target, branch, progress);
    if (direct) return;
  } catch (e) {
    console.warn('[Market] 目录直连失败，回退整包:', e.message);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
  }
  const key = repo.replace(/^\//, '') + '#' + branch;
  let zipBuf = repoZipCache.get(key);
  if (!zipBuf) {
    zipBuf = await fetchBuffer(
      'https://codeload.github.com/' + repo.replace(/^\//, '') + '/zip/refs/heads/' + branch,
      MAX_DOWNLOAD,
      p => { if (progress.download) progress.download(p); }
    );
    if (repoZipCache.size >= 8) repoZipCache.delete(repoZipCache.keys().next().value);
    repoZipCache.set(key, zipBuf);
  } else if (progress.download) {
    progress.download({ received: zipBuf.length, total: zipBuf.length, cached: true });
  }
  const tmp = path.join(marketplaceDir(), '_repo_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
  fs.mkdirSync(tmp, { recursive: true });
  // 只解压目标子目录：整仓库 zip 可能有上千个文件，全解压会明显卡主进程。
  await extractZip(zipBuf, tmp, {
    only: dirPath,
    onProgress: p => { if (progress.extract) progress.extract(p); }
  });
  // 找到 dirPath 对应的本地目录。
  // codeload 的 zip 有可能带 <repo>-<branch>/ 顶层目录，也可能已被解压器剥掉，
  // 两种布局都要兼容，不能只认顶层目录，否则会把真实存在的 skills/xlsx 判成缺失。
  const parts = String(dirPath).replace(/\\/g, '/').split('/').filter(Boolean);
  let base = tmp;
  const direct = path.join(tmp, ...parts);
  if (!fs.existsSync(direct)) {
    const top = fs.readdirSync(tmp, { withFileTypes: true }).find(d => d.isDirectory());
    if (top) {
      const nested = path.join(tmp, top.name, ...parts);
      if (fs.existsSync(nested)) base = path.join(tmp, top.name);
    }
  }
  let srcDir = path.join(base, ...parts);
  if (!fs.existsSync(srcDir)) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error('仓库中找不到目录: ' + dirPath); }
  copyTree(srcDir, target);
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function installMcp(it) {
  const def = it.mcpServer;
  if (!def || !def.command) return { success: false, error: 'MCP 条目缺少 mcpServer 配置' };
  const id = sanitizeId(it.id);
  const serverDef = {
    id,
    name: def.name || it.name,
    description: it.description || '',
    command: def.command,
    args: def.args || [],
    env: def.env || {},
    security: def.security || { readOnly: true },
    startupTimeoutMs: def.startupTimeoutMs || 120000,
    callTimeoutMs: def.callTimeoutMs || 120000
  };
  // 读现有商城 mcp.yaml，写入/覆盖该 server
  let servers = [];
  try {
    if (fs.existsSync(mcpFile())) {
      const data = _yaml.load(fs.readFileSync(mcpFile(), 'utf8')) || {};
      servers = Array.isArray(data.servers) ? data.servers : [];
    }
  } catch (e) { servers = []; }
  const idx = servers.findIndex(s => s.id === id);
  if (idx >= 0) servers[idx] = serverDef; else servers.push(serverDef);
  fs.writeFileSync(mcpFile(), _yaml.dump({ servers }), 'utf8');

  // 让 mcpManager 感知新 server，并启用 + 启动
  if (mcpManager) {
    mcpManager.reload();
    const enabled = mcpManager.getEnabled();
    if (!enabled.includes(id)) mcpManager.setEnabled([...enabled, id]);
    try { await mcpManager.startServer(id); } catch (e) { console.warn('[Market] 启动 MCP 失败:', e.message); }
  }
  return { success: true, detail: 'MCP「' + (def.name || it.name) + '」已登记并启用', from: 'factory' };
}

function normDepName(s) {
  return String(s || '').toLowerCase().replace(/@/g, '').replace(/[\s_]+/g, '-').replace(/[^a-z0-9\-]+/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

// 在本地目录里找智能体关联的技能 / MCP：按名称、ID、SKILL.md frontmatter 名称匹配
function findCatalogDependency(type, name) {
  const target = normDepName(name);
  if (!target) return null;
  const items = [...loadFactoryCatalog(), ...loadUserCatalog()].filter(i => i && i.type === type);
  const exact = items.find(it => normDepName(it.name) === target || normDepName(it.id) === target);
  if (exact) return exact;
  return items.find(it => {
    if (type === 'skill' && it.source && typeof it.source.skillMd === 'string') {
      const m = it.source.skillMd.match(/^---[\s\S]*?\bname:\s*([^\n]+)/);
      if (m && normDepName(m[1]) === target) return true;
    }
    const id = normDepName(it.id);
    return id.includes(target) || target.includes(id);
  }) || null;
}

function githubRefForItem(item) {
  const src = (item && item.source) || {};
  if (src.kind === 'github' && src.repo) {
    const mdPath = String(src.path || '');
    const dirPath = mdPath.replace(/\/?SKILL\.md$/i, '').replace(/\/+$/, '');
    if (!dirPath) return null;
    return { repo: src.repo, branch: src.branch || 'main', dirPath };
  }
  if (src.kind === 'inline' && typeof src.skillMd === 'string') {
    const m = src.skillMd.match(/github\.com\/([^/\s]+)\/([^/\s]+)\/tree\/([^/\s]+)\/(.+)/);
    if (m) return { repo: m[1] + '/' + m[2], branch: m[3], dirPath: m[4].trim().replace(/[)\s]+$/, '') };
  }
  return null;
}

// 按「目录里有多少文件」给关联组件分权重：xlsx 有 53 个文件，echarts 只有 1 个，
// 进度条不能两者各占三分之一，否则第一个组件下完 1MB 才走到 27%。
async function estimateDependencyWeight(dep) {
  if (!dep) return 8 * 1024;
  if (dep.type === 'mcp') return 24 * 1024; // MCP 没有文件下载，但要留一段可见的安装区间
  const ref = githubRefForItem(dep);
  if (ref) {
    try {
      const stats = await githubDirStats(ref.repo, ref.dirPath, ref.branch);
      if (stats && stats.count > 0) {
        // 按真实字节数 + 每个文件的连接开销 + 固定组件开销估权重，
        // 下载 1MB 的 xlsx 不会和 4KB 的 echarts 各占一半。
        return Math.max(24 * 1024, stats.bytes + stats.count * 2048 + 24 * 1024);
      }
    } catch (e) { /* 数不出来就按普通技能算 */ }
    return 64 * 1024;
  }
  return 24 * 1024;
}

// 魔搭「智能体广场」列表接口只返回技能名字和描述，技能正文在详情接口里。
// 安装时必须补拉一次详情，否则这类智能体就只能得到主提示词，看起来像 3.8KB 空壳。
const modelscopeAgentCache = new Map();
async function fetchModelscopeAgentSkills(it) {
  if (!it || !it.modelscope || !it.modelscope.path || !it.modelscope.name) return [];
  const key = it.modelscope.path + '/' + it.modelscope.name;
  if (modelscopeAgentCache.has(key)) return modelscopeAgentCache.get(key);
  const task = (async () => {
    const url = 'https://modelscope.cn/api/v1/agents/'
      + encodeURIComponent(it.modelscope.path) + '/' + encodeURIComponent(it.modelscope.name);
    const buf = await fetchBuffer(url, 8 * 1024 * 1024, null, {
      headers: { Accept: 'application/json', Referer: 'https://modelscope.cn/agents' },
      timeoutMs: 20000
    });
    const data = JSON.parse(buf.toString('utf8'));
    const root = data && (data.Data || data.data) || {};
    const skills = Array.isArray(root.skills) ? root.skills : [];
    return skills.filter(s => s && (s.name || s.dir_name) && s.content).map(s => ({
      name: String(s.name || s.dir_name),
      dirName: String(s.dir_name || s.name),
      description: String(s.description || ''),
      content: String(s.content || '')
    }));
  })();
  modelscopeAgentCache.set(key, task);
  try {
    return await task;
  } finally {
    // 正文不大，但避免把整份详情常驻内存；失败也不长期缓存。
    // 保留 5 分钟便于同一次安装的重建流程复用。
    setTimeout(() => modelscopeAgentCache.delete(key), 5 * 60 * 1000).unref?.();
  }
}

async function installEmbeddedAgentSkill(agentItem, skill) {
  const id = sanitizeId(skill.dirName || skill.name);
  const target = path.join(skillsRoot(), id);
  const desc = skill.description || '';
  if (!skill.content || !String(skill.content).trim()) return null;

  // 已经装过同 id 的真实技能就不覆盖。
  const existing = getInstalled(id);
  if (existing && fs.existsSync(path.join(target, 'SKILL.md'))) {
    return { id, name: skill.name || id, bytes: Number(existing.bytes) || 0, files: Number(existing.files) || 0 };
  }

  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  const content = String(skill.content);
  const md = /^---\s*\n/.test(content)
    ? content
    : '---\nname: ' + id + '\ndescription: ' + JSON.stringify(desc) + '\n---\n\n' + content;
  fs.writeFileSync(path.join(target, 'SKILL.md'), md, 'utf8');
  const stats = dirStats(target);

  const list = loadInstalled().filter(x => x.id !== id);
  list.push({
    id, type: 'skill', enabled: true,
    installedAt: new Date().toISOString(),
    from: 'agent-embedded',
    embeddedFor: agentItem && agentItem.id ? agentItem.id : '',
    name: skill.name || id,
    bytes: stats.bytes, files: stats.files, packagePath: ''
  });
  saveInstalled(list);
  return { id, name: skill.name || id, bytes: stats.bytes, files: stats.files };
}

async function installAgentDependencies(role, it) {
  const skillNames = Array.isArray(role.skills) ? role.skills : (Array.isArray(it.skills) ? it.skills.map(x => (x && x.name) || x) : []);
  const mcpNames = Array.isArray(role.mcps) ? role.mcps : (Array.isArray(it.mcps) ? it.mcps.map(x => (x && x.name) || x) : []);
  const installedDeps = [];
  const installedItems = [];
  const missingDeps = [];
  const plan = [];
  for (const [type, names] of [['skill', skillNames], ['mcp', mcpNames]]) {
    for (const name of names) {
      if (!name) continue;
      plan.push({ type, name, dep: findCatalogDependency(type, name) });
    }
  }
  if (!plan.length) return { installedDeps, installedItems, missingDeps };

  // 目录里找不到的技能，先回源站详情接口取全文；这类「智能体自带技能」只在详情里有正文。
  const missingSkills = plan.filter(p => p.type === 'skill' && !p.dep);
  if (missingSkills.length && it.modelscope) {
    emitProgress(it.id, '读取源站技能', 6, '正在获取 ' + missingSkills.map(p => p.name).join('、'));
    try {
      const sourceSkills = await fetchModelscopeAgentSkills(it);
      for (const p of missingSkills) {
        const hit = sourceSkills.find(s => normDepName(s.name) === normDepName(p.name)
          || normDepName(s.dirName) === normDepName(p.name));
        if (hit) {
          p.embedded = hit;
          p.weight = Math.max(24 * 1024, Buffer.byteLength(hit.content, 'utf8') + 24 * 1024);
        }
      }
      if (missingSkills.some(p => p.embedded)) {
        emitProgress(it.id, '读取源站技能', 9,
          '已获取 ' + missingSkills.filter(p => p.embedded).map(p => p.name).join('、'));
      }
    } catch (e) {
      console.warn('[Market] 读取智能体技能正文失败:', e.message);
    }
  }

  // 先把每个组件的文件规模数出来（tree 结果会被安装阶段复用，不会重复请求）。
  emitProgress(it.id, '分析关联组件', 6, '0 / ' + plan.length + ' 个组件');
  let analyzed = 0;
  await Promise.all(plan.map(async p => {
    if (!p.embedded) p.weight = await estimateDependencyWeight(p.dep);
    analyzed++;
    emitProgress(it.id, '分析关联组件', 6 + Math.round((analyzed / plan.length) * 6),
      analyzed + ' / ' + plan.length + ' 个组件');
  }));

  const totalWeight = Math.max(1, plan.reduce((sum, p) => sum + (p.weight || 1), 0));
  let weightDone = 0;
  for (const p of plan) {
    const base = 12 + Math.round((weightDone / totalWeight) * 61);
    const end = 12 + Math.round(((weightDone + (p.weight || 1)) / totalWeight) * 61);
    weightDone += (p.weight || 1);
    const { type, name, dep } = p;
    if (!dep && p.embedded) {
      try {
        const rec = await installEmbeddedAgentSkill(it, p.embedded);
        if (rec) {
          installedDeps.push(name);
          installedItems.push({ type: 'skill', id: rec.id, name: rec.name || name });
          emitProgress(it.id, '内置技能已就绪', end, name + ' · ' + formatBytes(rec.bytes));
        } else {
          missingDeps.push(name);
          emitProgress(it.id, '跳过缺失组件', end, name + '（源站没有正文）');
        }
      } catch (e) {
        missingDeps.push(name);
        emitProgress(it.id, '跳过缺失组件', end, name + '（写入失败）');
      }
      continue;
    }
    if (!dep) {
      missingDeps.push(name);
      emitProgress(it.id, '跳过缺失组件', end, name + '（本地目录暂缺）');
      continue;
    }
    const inst = getInstalled(dep.id);
    if (inst && inst.enabled) {
      installedDeps.push(name);
      installedItems.push({ type, id: dep.id, name: dep.name });
      emitProgress(it.id, '关联组件已就绪', end, name);
      continue;
    }
    try {
      const r = type === 'skill'
        ? await install(dep.id, { progressId: it.id, base, span: end - base })
        : await (async () => {
          emitProgress(it.id, '安装关联 MCP', base, name);
          const rr = await install(dep.id);
          emitProgress(it.id, '关联 MCP 就绪', end, name);
          return rr;
        })();
      if (r && r.success) {
        installedDeps.push(name);
        installedItems.push({ type, id: dep.id, name: dep.name });
      } else missingDeps.push(name);
    } catch (e) {
      missingDeps.push(name);
    }
  }
  return { installedDeps, installedItems, missingDeps };
}

async function installAgent(it) {
  let role;
  if (it.role) {
    role = it.role;
  } else {
    const src = it.source || {};
    if (src.kind === 'inline' && src.roleJson) {
      role = typeof src.roleJson === 'string' ? JSON.parse(src.roleJson) : src.roleJson;
    } else if (src.kind === 'url') {
      const buf = await fetchBuffer(src.url);
      role = JSON.parse(buf.toString('utf8'));
    } else if (src.kind === 'github') {
      const text = await fetchGithubRaw(src.repo, src.path, src.branch || 'main');
      role = JSON.parse(text);
    } else {
      return { success: false, error: '智能体条目缺少 role 定义或来源' };
    }
  }
  if (!role || !role.id || !role.name) return { success: false, error: '智能体定义缺少 id/name' };

  // 写入自定义角色（与 aiOps saveAgentRole 同文件、同结构）
  const roles = loadAgentRoles();
  const idx = roles.findIndex(r => r.id === role.id);
  const iconEmoji = it && it.icon && it.icon.kind === 'emoji' ? String(it.icon.value || '') : '';
  const roleData = {
    ...role,
    isPreset: false,
    installedFrom: 'marketplace',
    // 图标跟商城卡片保持一致：角色没写 emoji 时，用条目图标（emoji）兜底
    emoji: role.emoji || iconEmoji
  };
  if (idx >= 0) roles[idx] = roleData; else roles.push(roleData);
  saveAgentRoles(roles);

  // 关联技能 / MCP 一起装：不再只写一份角色提示词当外壳。
  emitProgress(it.id, '准备安装', 2, '正在写入角色「' + role.name + '」');
  const deps = await installAgentDependencies(roleData, it);
  let detail = '智能体「' + role.name + '」已加入角色，可在 Agent 设置中选择';
  if (deps.installedDeps.length) detail += '；已同步关联组件：' + deps.installedDeps.join('、');
  if (deps.missingDeps.length) detail += '；本地目录暂缺：' + deps.missingDeps.slice(0, 6).join('、') + (deps.missingDeps.length > 6 ? ' 等' : '');

  const pkg = await buildAgentPackage(it, roleData, deps);
  emitProgress(it.id, '完成', 100, '安装包 ' + formatBytes(pkg.packageBytes) + ' / ' + pkg.packageFiles + ' 个文件');
  if (pkg.packageBytes) {
    detail += '；安装包 ' + formatBytes(pkg.packageBytes) + ' / ' + pkg.packageFiles + ' 个文件';
  }
  return { success: true, detail, from: 'factory', ...pkg };
}

// 把智能体定义 + 已装好的关联技能全部文件打成真实安装包。
async function buildAgentPackage(it, roleData, deps) {
  emitProgress(it.id, '整理智能体包', 78, '正在收集关联技能文件');
  const promptBytes = Buffer.byteLength(String(roleData.systemPrompt || ''), 'utf8');
  const entries = [{ name: 'agent.json', data: JSON.stringify(roleData, null, 2) }];
  const bundledSkills = [];
  const bundledMcps = [];
  for (const dep of deps.installedItems) {
    if (dep.type === 'skill') {
      const dir = path.join(skillsRoot(), sanitizeId(dep.id));
      if (fs.existsSync(dir)) {
        const before = entries.length;
        collectDirEntries(dir, 'skills/' + sanitizeId(dep.id), entries);
        if (entries.length > before) bundledSkills.push({ id: dep.id, name: dep.name, files: entries.length - before });
      }
    } else {
      const mcpItem = getCatalogItem(dep.id);
      if (mcpItem && mcpItem.mcpServer) {
        entries.push({ name: 'mcps/' + sanitizeId(dep.id) + '.json', data: JSON.stringify(mcpItem.mcpServer, null, 2) });
        bundledMcps.push({ id: dep.id, name: dep.name });
      }
    }
  }
  const manifest = {
    kind: 'agent',
    id: it.id,
    name: it.name,
    version: it.version || '1.0.0',
    installedAt: new Date().toISOString(),
    contentType: 'agent-package',
    roleFile: 'agent.json',
    promptBytes,
    skills: bundledSkills,
    mcps: bundledMcps,
    missing: deps.missingDeps
  };
  return writeInstallPackage('agent', it.id, manifest, entries, p => {
    const pct = p.total ? 80 + Math.round((p.done / p.total) * 18) : 85;
    emitProgress(it.id, '打包智能体', pct, p.done + ' / ' + p.total + ' 个文件');
  });
}

// 修复旧安装记录：出厂目录后来补了 skills/mcps 时，把已安装角色补齐并重建包。
async function repairInstalledFactoryAgentPackages() {
  const installed = loadInstalled().filter(x => x && x.type === 'agent');
  if (!installed.length) return;
  const factoryAgents = loadFactoryCatalog().filter(x => x && x.type === 'agent');
  if (!factoryAgents.length) return;
  const roles = loadAgentRoles();
  let rolesChanged = false;
  let rebuilt = 0;

  suppressProgress = true;
  try {
  for (const inst of installed) {
    const item = factoryAgents.find(x => x.id === inst.id);
    if (!item || !item.role) continue;
    // 24 小时内只尝试一次，避免每次启动都重复联网下载 / 启动 MCP。
    // 例外：智能体声明了关联技能，但旧包只有 2 个文件（主提示词空壳），必须重试补正文。
    const declaredSkills = Array.isArray(item.role.skills) ? item.role.skills.length : 0;
    const tinyShell = declaredSkills > 0 && (Number(inst.files) || 0) <= 2;
    if (inst.repairAttemptedAt && !tinyShell
      && Date.now() - Date.parse(inst.repairAttemptedAt) < 24 * 3600 * 1000) continue;
    const role = roles.find(r => r.id === inst.id);
    if (!role) continue;

    for (const field of ['skills', 'mcps', 'tools']) {
      if (Array.isArray(item.role[field]) && item.role[field].length
        && (!Array.isArray(role[field]) || !role[field].length)) {
        role[field] = JSON.parse(JSON.stringify(item.role[field]));
        rolesChanged = true;
      }
    }
    if (rolesChanged) saveAgentRoles(roles);

    const deps = await installAgentDependencies(role, item);
    const pkg = await buildAgentPackage(item, role, deps);

    // installAgentDependencies 内部会写 installed.yaml，必须重新读取后再更新本条，
    // 否则会把刚装好的关联技能记录覆盖掉。
    const latest = loadInstalled();
    const target = latest.find(x => x.id === inst.id);
    if (target) {
      target.bytes = pkg.packageBytes || 0;
      target.files = pkg.packageFiles || 0;
      target.packagePath = pkg.packagePath || '';
      target.repairAttemptedAt = new Date().toISOString();
      saveInstalled(latest);
    }
    rebuilt++;
    console.log('[Market] 已重建智能体安装包:', item.name, formatBytes(pkg.packageBytes), pkg.packageFiles + ' 个文件');
  }
  } finally {
    suppressProgress = false;
  }
  if (rebuilt && progressCallback) {
    progressCallback({ id: '__refresh__', phase: '安装包已重建', percent: 100, detail: '' });
  }
}

function loadAgentRoles() {
  try {
    if (fs.existsSync(agentRolesFile())) {
      const d = JSON.parse(fs.readFileSync(agentRolesFile(), 'utf8'));
      return Array.isArray(d) ? d : [];
    }
  } catch (e) { /* 忽略 */ }
  return [];
}
function saveAgentRoles(roles) {
  fs.writeFileSync(agentRolesFile(), JSON.stringify(roles, null, 2), 'utf8');
}

// ── 卸载 / 启用 ──────────────────────────────────────────────────────────────
function uninstall(id) {
  const it = getCatalogItem(id);
  const inst = getInstalled(id);
  if (!it) return { success: false, error: '商城不存在该条目: ' + id };
  if (!inst) return { success: false, error: '该条目未安装' };

  if (it.type === 'skill') {
    const p = path.join(skillsRoot(), sanitizeId(id));
    fs.rmSync(p, { recursive: true, force: true });
  } else if (it.type === 'mcp') {
    if (mcpManager) {
      const enabled = mcpManager.getEnabled().filter(x => x !== id);
      mcpManager.setEnabled(enabled);
      try { mcpManager.stopServer(id); } catch (e) { /* 忽略 */ }
      mcpManager.reload();
    }
    // 从商城 mcp.yaml 移除
    try {
      if (fs.existsSync(mcpFile())) {
        const data = _yaml.load(fs.readFileSync(mcpFile(), 'utf8')) || {};
        const servers = (Array.isArray(data.servers) ? data.servers : []).filter(s => s.id !== id);
        fs.writeFileSync(mcpFile(), _yaml.dump({ servers }), 'utf8');
      }
    } catch (e) { /* 忽略 */ }
  } else if (it.type === 'agent') {
    const roles = loadAgentRoles().filter(r => r.id !== id);
    saveAgentRoles(roles);
    // 清理只为这个智能体生成的内置技能；仍被其他角色引用就保留。
    const keep = new Set();
    for (const role of roles) {
      for (const s of (Array.isArray(role.skills) ? role.skills : [])) keep.add(normDepName(s));
    }
    const listInst = loadInstalled().filter(x => x.id !== id);
    for (const rec of listInst.filter(x => x.from === 'agent-embedded')) {
      if (keep.has(normDepName(rec.name)) || keep.has(normDepName(rec.id))) continue;
      try { fs.rmSync(path.join(skillsRoot(), sanitizeId(rec.id)), { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
      const idx = listInst.indexOf(rec);
      if (idx >= 0) listInst.splice(idx, 1);
    }
    saveInstalled(listInst);
    try { fs.rmSync(packageFile(it.type, id), { force: true }); } catch (e) { /* 忽略 */ }
    return { success: true, id, name: it.name };
  }

  saveInstalled(loadInstalled().filter(x => x.id !== id));
  try { fs.rmSync(packageFile(it.type, id), { force: true }); } catch (e) { /* 忽略 */ }
  return { success: true, id, name: it.name };
}

function setEnabled(id, enabled) {
  const it = getCatalogItem(id);
  if (!it) return { success: false, error: '商城不存在该条目: ' + id };

  if (it.type === 'mcp' && mcpManager) {
    const cur = mcpManager.getEnabled();
    const next = enabled ? (cur.includes(id) ? cur : [...cur, id]) : cur.filter(x => x !== id);
    mcpManager.setEnabled(next);
    if (enabled) { try { mcpManager.startServer(id); } catch (e) { console.warn('[Market] 启动 MCP 失败:', e.message); } }
    else { try { mcpManager.stopServer(id); } catch (e) { /* 忽略 */ } }
    return { success: true, enabled };
  }

  const inst = getInstalled(id);
  if (!inst) return { success: false, error: '该条目未安装，请先下载' };
  inst.enabled = !!enabled;
  const rest = loadInstalled().filter(x => x.id !== id);
  rest.push(inst);
  saveInstalled(rest);
  return { success: true, enabled: !!enabled };
}

// ── 导入 ─────────────────────────────────────────────────────────────────────
/**
 * 导入：本地文件或 URL。支持三种载体：
 *   1. 商城清单（yaml/json，含 marketplace 列表）→ 并入用户目录 catalog.yaml
 *   2. 技能包 zip / SKILL.md → 直接装成一个技能
 *   3. 单个条目定义（含 id/type）→ 并入用户目录
 * @param {string} source  文件绝对路径 或 https URL
 */
async function importPackage(source) {
  const isUrl = /^https?:\/\//i.test(source);
  const buf = isUrl ? await fetchBuffer(source) : fs.readFileSync(source);

  // 先试当作清单/条目（yaml 或 json）
  const asText = buf.toString('utf8');
  let parsed = null;
  try {
    parsed = asText.trim().startsWith('{') || asText.trim().startsWith('[') ? JSON.parse(asText) : _yaml.load(asText);
  } catch (e) { parsed = null; }

  if (parsed && parsed.marketplace && Array.isArray(parsed.marketplace)) {
    const added = appendUserCatalog(parsed.marketplace);
    return { success: true, kind: 'catalog', added: added.map(i => i.id), names: added.map(i => i.name) };
  }
  if (parsed && parsed.id && parsed.type) {
    const added = appendUserCatalog([parsed]);
    return { success: true, kind: 'item', added: added.map(i => i.id), names: added.map(i => i.name) };
  }
  if (parsed && Array.isArray(parsed) && parsed.length && parsed[0].id && parsed[0].type) {
    const added = appendUserCatalog(parsed);
    return { success: true, kind: 'items', added: added.map(i => i.id), names: added.map(i => i.name) };
  }

  // 不是清单 → 当作技能包（zip 或单文件 SKILL.md）
  if (looksLikeZip(buf)) {
    const name = deriveName(source, 'imported-skill');
    return installSkillFromBuffer(buf, name);
  }
  // 单文本：存成技能 SKILL.md
  const name = deriveName(source, 'imported-skill');
  fs.mkdirSync(path.join(skillsRoot(), sanitizeId(name)), { recursive: true });
  fs.writeFileSync(path.join(skillsRoot(), sanitizeId(name), 'SKILL.md'), asText, 'utf8');
  const id = sanitizeId(name);
  const list = loadInstalled().filter(x => x.id !== id);
  list.push({ id, type: 'skill', enabled: true, installedAt: new Date().toISOString(), from: 'user' });
  saveInstalled(list);
  return { success: true, kind: 'skill', id, name };
}

async function installSkillFromBuffer(buf, name) {
  const id = sanitizeId(name);
  const target = path.join(skillsRoot(), id);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  if (looksLikeZip(buf)) {
    const tmp = path.join(marketplaceDir(), '_tmp_' + Date.now());
    fs.mkdirSync(tmp, { recursive: true });
    await extractZip(buf, tmp);
    copyTree(tmp, target);
    fs.rmSync(tmp, { recursive: true, force: true });
  } else {
    fs.writeFileSync(path.join(target, 'SKILL.md'), buf.toString('utf8'), 'utf8');
  }
  const list = loadInstalled().filter(x => x.id !== id);
  list.push({ id, type: 'skill', enabled: true, installedAt: new Date().toISOString(), from: 'user' });
  saveInstalled(list);
  return { success: true, kind: 'skill', id, name };
}

function appendUserCatalog(items) {
  const user = loadUserCatalog();
  const byId = new Map(user.map(i => [i.id, i]));
  const added = [];
  for (const it of items) {
    if (!it.id || !it.type) continue;
    const norm = { ...it, installedFrom: 'user' };
    if (!byId.has(it.id)) { added.push(norm); }
    byId.set(it.id, norm);
  }
  fs.writeFileSync(catalogFile(), _yaml.dump({ marketplace: Array.from(byId.values()) }), 'utf8');
  return Array.from(byId.values()).filter(i => added.some(a => a.id === i.id));
}

// ── 工具函数 ────────────────────────────────────────────────────────────────
function sanitizeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 64) || 'item';
}
function looksLikeZip(buf) {
  return buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50;
}
function deriveName(source, fallback) {
  const m = String(source).split(/[\\/]/).pop().replace(/\.(zip|md|yaml|yml|json)$/i, '');
  return m ? m : fallback;
}
function copyTree(src, dest) {
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyTree(s, d); }
    else fs.copyFileSync(s, d);
  }
}

// 供 aiOps 注入技能索引
function listEnabledSkills() {
  return skillsRegistry.listSkills(id => {
    const inst = getInstalled(id);
    return inst ? !!inst.enabled : false;
  }).filter(s => s.enabled);
}
function skillsNotice() {
  return skillsRegistry.buildNotice(listEnabledSkills());
}

// 状态汇总（给 IPC / UI）
function status() {
  const installed = loadInstalled();
  const mcpEnabled = mcpManager ? mcpManager.getEnabled() : [];
  const skills = skillsRegistry.listSkills(id => {
    const inst = getInstalled(id);
    return inst ? !!inst.enabled : false;
  });
  return {
    installedCount: installed.length,
    enabledMcpCount: mcpEnabled.length,
    skills: skills.map(s => ({ id: s.id, name: s.name, enabled: s.enabled }))
  };
}

const api = {
  init, list, install, installWithEnv, uninstall, setEnabled, importPackage,
  listEnabledSkills, skillsNotice, status,
  _paths: { marketplaceDir, skillsRoot, installedFile, catalogFile, mcpFile, agentRolesFile }
};

module.exports = api;
