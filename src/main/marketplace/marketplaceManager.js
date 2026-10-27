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
 * 安装状态：data/marketplace/installed.yaml（id/type/enabled/installedAt/from）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { extractZip } = require('./zipExtract');
const skillsRegistry = require('./skillsRegistry');
const credentialStore = require('../config/credentialStore');

let mcpManager = null;   // 延迟注入，避免模块加载期循环依赖
let userDataDir = null;
let FACTORY_DIR = null;  // src/main/agent-config

const MAX_DOWNLOAD = 64 * 1024 * 1024; // 单次下载上限 64MB

function init(opts) {
  userDataDir = opts.userDataDir;
  FACTORY_DIR = opts.factoryDir || path.join(__dirname, '..', 'agent-config');
  mcpManager = opts.mcpManager || null;
  skillsRegistry.init(userDataDir);
  ensureDirs();
  seedUserCatalogIfMissing();
  return api;
}

function marketplaceDir() { return path.join(userDataDir, 'marketplace'); }
function skillsRoot() { return path.join(userDataDir, 'skills'); }
function installedFile() { return path.join(marketplaceDir(), 'installed.yaml'); }
function catalogFile() { return path.join(marketplaceDir(), 'catalog.yaml'); }
function mcpFile() { return path.join(marketplaceDir(), 'mcp.yaml'); }
function agentRolesFile() { return path.join(userDataDir, 'agent_roles.json'); }

function ensureDirs() {
  for (const d of [marketplaceDir(), skillsRoot()]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* 忽略 */ }
  }
}

let _yaml = null;
try { _yaml = require('js-yaml'); } catch (e) { /* js-yaml 一定有 */ }

// ── 出厂播种 ────────────────────────────────────────────────────────────────
// 打包安装后 userData 是全新的系统目录，若用户目录无 catalog，
// 从打包资源（agent-config/marketplace-catalog.seed.yaml，含魔搭全量目录）复制一份。
// 已有目录（开发模式 / 老版本升级）不覆盖，保留用户数据。
function seedUserCatalogIfMissing() {
  try {
    if (fs.existsSync(catalogFile())) return;
    const seed = path.join(FACTORY_DIR, 'marketplace-catalog.seed.yaml');
    if (!fs.existsSync(seed)) return;
    fs.copyFileSync(seed, catalogFile());
    console.log('[Market] 首次启动：已从出厂 seed 播种商城目录（' + fs.statSync(catalogFile()).size + ' bytes）');
  } catch (e) {
    console.warn('[Market] 播种商城目录失败:', e.message);
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
function list() {
  const installed = loadInstalled();
  const items = [...loadFactoryCatalog(), ...loadUserCatalog()];
  const byId = new Map();
  for (const it of items) byId.set(it.id, it); // 后定义覆盖（用户目录覆盖出厂）

  return Array.from(byId.values()).map(it => {
    const inst = installed.find(i => i.id === it.id) || null;
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
function fetchBuffer(url, maxBytes = MAX_DOWNLOAD) {
  return new Promise((resolve, reject) => {
    const doGet = (u, depth) => {
      let parsed;
      try { parsed = new URL(u); } catch (e) { return reject(new Error('非法 URL: ' + u)); }
      if (parsed.protocol !== 'https:') return reject(new Error('仅支持 https 下载'));
      const req = https.get(u, {
        headers: { 'User-Agent': 'fuling-shijie-marketplace/1.0', Accept: '*/*' }
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
        res.on('data', c => {
          size += c.length;
          if (size > maxBytes) { req.destroy(new Error('下载超过大小上限')); return; }
          chunks.push(c);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(30000, () => req.destroy(new Error('下载超时')));
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
async function install(id) {
  const it = getCatalogItem(id);
  if (!it) return { success: false, error: '商城不存在该条目: ' + id };
  if (it.type === 'mcp' && it.hosted) {
    return { success: false, error: '该 MCP 为托管服务，请到魔搭控制台登录获取连接信息后使用' };
  }
  const inst = getInstalled(id);
  if (inst && inst.enabled) return { success: false, error: '该条目已安装并启用' };

  let res;
  if (it.type === 'skill') res = await installSkill(it);
  else if (it.type === 'mcp') res = await installMcp(it);
  else if (it.type === 'agent') res = await installAgent(it);
  else return { success: false, error: '未知条目类型: ' + it.type };

  if (!res.success) return res;

  // 记录安装状态（skill/agent 记 enabled；mcp 由 mcpManager 管启用）
  const now = new Date().toISOString();
  const listInst = loadInstalled().filter(x => x.id !== id);
  listInst.push({ id, type: it.type, enabled: it.type === 'mcp' ? false : true, installedAt: now, from: res.from || 'catalog' });
  saveInstalled(listInst);

  return { success: true, type: it.type, id, name: it.name, detail: res.detail };
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

async function installSkill(it) {
  const skillId = sanitizeId(it.id);
  const target = path.join(skillsRoot(), skillId);
  const src = it.source || {};
  const from = it.installedFrom === 'user' ? 'user' : 'factory';

  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });

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
        await fetchRepoDir(repo, dirPath, target, branch);
      } catch (e) {
        console.warn('[Market] GitHub 目录拉取失败，回退到 inline 空壳:', e.message);
        fs.writeFileSync(path.join(target, 'SKILL.md'), md, 'utf8');
      }
    } else {
      fs.writeFileSync(path.join(target, 'SKILL.md'), md, 'utf8');
    }
  } else if (src.kind === 'github') {
    // 技能通常是单文件 SKILL.md；若 path 指向目录，尝试 zip 拉整目录。
    if (/\.md$/i.test(src.path)) {
      const text = await fetchGithubRaw(src.repo, src.path, src.branch || 'main');
      fs.writeFileSync(path.join(target, 'SKILL.md'), text, 'utf8');
    } else {
      // 目录：拉仓库 zip（codeload），解压到临时再拷到 target
      await fetchRepoDir(src.repo, src.path, target, src.branch || 'main');
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
  return { success: true, detail: '已装进 data/skills/' + skillId + '（可从智能商城「已安装」停用/卸载）', from };
}

/** 拉 GitHub 仓库的某个子目录（用 codeload 全仓库 zip，再取子目录）。 */
async function fetchRepoDir(repo, dirPath, target, branch) {
  const zipBuf = await fetchBuffer('https://codeload.github.com/' + repo.replace(/^\//, '') + '/zip/refs/heads/' + branch);
  const tmp = path.join(marketplaceDir(), '_repo_' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });
  await extractZip(zipBuf, tmp);
  // 找到 dirPath 对应的本地目录
  const parts = String(dirPath).replace(/\\/g, '/').split('/').filter(Boolean);
  // codeload 会包一层 <repo>-<branch>/，先定位该层
  let base = tmp;
  const top = fs.readdirSync(tmp, { withFileTypes: true }).find(d => d.isDirectory());
  if (top) base = path.join(tmp, top.name);
  let srcDir = base;
  for (const seg of parts) srcDir = path.join(srcDir, seg);
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
  const roleData = { ...role, isPreset: false, installedFrom: 'marketplace' };
  if (idx >= 0) roles[idx] = roleData; else roles.push(roleData);
  saveAgentRoles(roles);
  return { success: true, detail: '智能体「' + role.name + '」已加入角色，可在 Agent 设置中选择', from: 'factory' };
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
  }

  saveInstalled(loadInstalled().filter(x => x.id !== id));
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
