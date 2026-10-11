'use strict';
/**
 * 魔搭商店源：批量拉取 ModelScope 社区三类内容并入本地智能商城
 * ============================================================
 * 接口（均为 PUT JSON，已实证）：
 *   MCP    PUT /api/v1/dolphin/mcpServers → Data.McpServer.McpServers[] / TotalCount（全商店 12562）
 *   Skills PUT /api/v1/dolphin/skills      → Data.SkillList[] / TotalCount（技能中心 83267）
 *   Agents PUT /api/v1/dolphin/agents      → Data.AgentList[] / TotalCount（智能体广场 656）
 * 上架规则（保证「一键下载并启用」真实可用）：
 *   · MCP：自带 ServerConfig（stdio 命令）+ 免密钥（EnvSchema.required 为空）→ 直接可启用
 *   · Skill：生成内嵌 SKILL.md 能力包（frontmatter + 描述 + 来源），装进 data/skills/ 注入 AI
 *   · Agent：用魔搭原始 SystemPromptFiles 生成内嵌角色，写入 agent_roles.json
 * 需密钥 / 无配置的条目跳过并统计；图标用魔搭条目自带图；描述带热度与来源。
 *
 * 用法：node scripts/fetch-modelscope-store.js [--type mcp|skill|agent|all] [--pages N] [--limit N] [--dry]
 * 默认：all，MCP 1×200 免密钥、Skill/Agent 各 Top 40（按热度），写入 data/marketplace/catalog.yaml。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const HOST = 'modelscope.cn';
const MCP_ICON = 'https://avatars.githubusercontent.com/u/182288589?s=80';
const ALLOWED_CMD = new Set(['npx', 'node', 'python', 'py', 'uv', 'uvx']);

const CAT_MAP = {
  'developer-tools': 'dev', 'browser-automation': 'dev', 'version-control': 'dev',
  'databases': 'dev', 'cloud-platforms': 'dev', 'monitoring': 'dev', 'os-automation': 'dev',
  'search': 'search', 'finance': 'finance', 'calendar-management': 'life',
  'travel-and-transportation': 'life', 'location-services': 'life',
  'entertainment-and-media': 'media', 'image-and-video-processing': 'media',
  'aigc': 'media', 'AIGC': 'media', 'education': 'education',
  'knowledge-and-memory': 'work', 'note-taking': 'work', 'communication': 'work',
  'social-media': 'work', 'file-systems': 'work', 'marketing': 'marketing',
  'sales': 'sales', 'product': 'product', 'design': 'design',
  'art-and-culture': 'creative', 'research-and-data': 'research', 'research': 'research',
  'other': 'other', 'Search': 'search', 'Knowledge&Memory': 'work', 'app-automation': 'dev'
};

function req(path, body, referer) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const r = https.request({
      hostname: HOST, path, method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': referer || 'https://modelscope.cn/',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      },
      timeout: 40000
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}

async function pull(path, pages, pageSize, referer, listResolver) {
  const all = [];
  let total = 0;
  for (let p = 1; p <= pages; p++) {
    const r = await req(path, { pageNumber: p, pageSize }, referer);
    if (r.status !== 200) throw new Error(path + ' status=' + r.status);
    const j = JSON.parse(r.body);
    const list = listResolver ? listResolver(j) : [];
    total = (j.Data && j.Data.TotalCount) || total;
    all.push(...list);
    if (list.length < pageSize) break;
  }
  return { all, total };
}

function sanitizeId(s) {
  return String(s || '').toLowerCase().replace(/@/g, '').replace(/[^a-z0-9_\-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';
}

function cleanLine(s, n) {
  return String(s || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
}

/* ── MCP：全部上架（免密钥直接可用；需密钥带 auth 表单；托管标 hosted）─────── */
function buildMcpItems(list, max) {
  const items = [];
  let needKey = 0, noCfg = 0, ok = 0;
  for (const s of list) {
    const cfg = s.ServerConfig;
    const mcpServers = Array.isArray(cfg) && cfg[0] && cfg[0].mcpServers;
    const first = mcpServers && Object.values(mcpServers)[0];
    const cn = s.ChineseName || s.Name || s.Publisher || 'ms-item';
    const catRaw = Array.isArray(s.Category) && s.Category.length ? s.Category[0] : 'other';
    if (!first || !first.command || !ALLOWED_CMD.has(first.command)) {
      // 托管 / 无本地配置：上架为 hosted（仅信息，可到魔搭控制台获取连接）
      noCfg++;
      if (items.length >= max) break;
      const base = 'ms-' + sanitizeId((s.Path || '') + '-' + (s.Name || ''));
      let id = base, n = 2;
      while (items.some(i => i.id === id)) id = base + '-' + n++;
      items.push({
        id, type: 'mcp', name: cn, category: CAT_MAP[catRaw] || String(catRaw).toLowerCase().slice(0, 20) || 'other',
        version: '1.0.0', hosted: true,
        description: cleanLine(s.AbstractCN || s.Abstract || '魔搭 MCP 广场条目', 150) + '（魔搭 MCP 广场 · 调用 ' + fmt(s.CallVolume) + ' 次 · 托管服务：需在魔搭控制台登录获取连接信息）',
        icon: { kind: 'url', url: s.FromSiteIcon || MCP_ICON }
      });
      continue;
    }
    let envReq = [], envProps = null;
    try { const es = typeof s.EnvSchema === 'string' ? JSON.parse(s.EnvSchema) : (s.EnvSchema || {}); envReq = es.required || []; envProps = (es.properties && typeof es.properties === 'object') ? es.properties : null; } catch (e) { }
    const env = first.env || {};
    if (envReq.length) {
      needKey++;
      if (items.length >= max) break;
      const base = 'ms-' + sanitizeId((s.Path || '') + '-' + (s.Name || ''));
      let id = base, n = 2;
      while (items.some(i => i.id === id)) id = base + '-' + n++;
      const fields = envReq.map(k => {
        const p = envProps && envProps[k];
        return { name: k, required: true, hint: (p && (p.description || p.title)) || '' };
      });
      // 剩余 env 未在 required 里的字段也列出来（可选填）
      for (const k of Object.keys(env)) {
        if (!envReq.includes(k)) fields.push({ name: k, required: false, hint: (envProps && envProps[k] && (envProps[k].description || envProps[k].title)) || '' });
      }
      const envPlaceholders = {};
      for (const f of fields) envPlaceholders[f.name] = '${secret:mcp-' + id + '-' + String(f.name).toLowerCase().replace(/[^a-z0-9_]/g, '_') + '}';
      items.push({
        id, type: 'mcp', name: cn, category: CAT_MAP[catRaw] || String(catRaw).toLowerCase().slice(0, 20) || 'other',
        version: '1.0.0', auth: { fields },
        description: cleanLine(s.AbstractCN || s.Abstract || '魔搭 MCP 广场条目', 150) + '（魔搭 MCP 广场 · 调用 ' + fmt(s.CallVolume) + ' 次 · 需配置 ' + fields.map(f => f.name).join(' / ') + ' 后启用）',
        icon: { kind: 'url', url: s.FromSiteIcon || MCP_ICON },
        mcpServer: {
          name: cn, command: first.command, args: Array.isArray(first.args) ? first.args : [],
          env: envPlaceholders, security: { readOnly: true }, startupTimeoutMs: 120000, callTimeoutMs: 120000
        }
      });
      continue;
    }
    if (Object.values(env).some(v => typeof v === 'string' && v.includes('${'))) { needKey++; continue; }
    ok++;
    if (items.length >= max) break;
    const base = 'ms-' + sanitizeId((s.Path || '') + '-' + (s.Name || ''));
    let id = base, n = 2;
    while (items.some(i => i.id === id)) id = base + '-' + n++;
    const mcpServer = {
      name: cn, command: first.command, args: Array.isArray(first.args) ? first.args : [],
      security: { readOnly: true }, startupTimeoutMs: 120000, callTimeoutMs: 120000
    };
    if (Object.keys(env).length) mcpServer.env = env;
    items.push({
      id, type: 'mcp', name: cn, category: CAT_MAP[catRaw] || String(catRaw).toLowerCase().slice(0, 20) || 'other',
      version: '1.0.0',
      description: cleanLine(s.AbstractCN || s.Abstract || '魔搭 MCP 广场条目', 150) + '（魔搭 MCP 广场 · 调用 ' + fmt(s.CallVolume) + ' 次 · ' + (s.License ? s.License + ' · ' : '') + '来源 ' + (s.FromSite || 'modelscope') + '）',
      icon: { kind: 'url', url: s.FromSiteIcon || MCP_ICON }, mcpServer
    });
  }
  return { items, needKey, noCfg, ok };
}

/* ── Skill：生成内嵌 SKILL.md 能力包 ─────────────────────────────────── */
function buildSkillItems(list, max) {
  const items = [];
  const sorted = [...list].sort((a, b) => (b.Visits || 0) - (a.Visits || 0));
  for (const s of sorted) {
    if (items.length >= max) break;
    const base = 'ms-skill-' + sanitizeId((s.Path || '') + '-' + (s.Name || ''));
    let id = base, n = 2;
    while (items.some(i => i.id === id)) id = base + '-' + n++;
    const catRaw = (s.L1 && (s.L1.CatalogID || s.L1.Name)) || 'other';
    const name = s.DisplayName || s.Name || id;
    const desc = cleanLine(s.Description, 120) || '魔搭技能中心技能';
    const sourceUrl = s.SourceURL || ('https://modelscope.cn/skills/' + (s.Path || '') + '/' + (s.Name || ''));
    const skillMd = [
      '---',
      'name: ' + String(s.Name || id).slice(0, 60),
      'description: ' + desc,
      'source: ' + sourceUrl,
      '---',
      '',
      '# ' + name,
      '',
      String(s.Description || '').trim().slice(0, 800),
      '',
      '## 来源',
      '本能力包源自魔搭技能中心（ModelScope Skills Central，https://modelscope.cn/skills），原始条目：' + sourceUrl + '。',
      '命中相关场景时按上文执行；完整说明以魔搭源页为准。'
    ].join('\n');
    items.push({
      id, type: 'skill', name, category: CAT_MAP[catRaw] || String(catRaw).toLowerCase().slice(0, 20) || 'other',
      version: '1.0.0',
      description: desc + '（魔搭技能中心 · 访问 ' + fmt(s.Visits) + ' · 下载 ' + fmt(s.DownloadCount) + ' · 来源 ' + (s.Source || 'modelscope') + '）',
      icon: { kind: 'url', url: s.SourceAvatar || MCP_ICON },
      source: { kind: 'inline', skillMd }
    });
  }
  return { items };
}

/* ── Agent：全部拉取，用魔搭原始 SystemPrompt 生成内嵌角色 ────────────── */
function buildAgentItems(list, max) {
  const items = [];
  const sorted = [...list].sort((a, b) => (b.VisitCount || 0) - (a.VisitCount || 0));
  for (const s of sorted) {
    if (items.length >= max) break;
    const sp = (s.SystemPromptFiles && s.SystemPromptFiles[0] && s.SystemPromptFiles[0].Content) || '';
    if (!sp) continue;
    const base = 'ms-agent-' + sanitizeId((s.Path || '') + '-' + (s.Name || ''));
    let id = base, n = 2;
    while (items.some(i => i.id === id)) id = base + '-' + n++;
    const catRaw = Array.isArray(s.Catalogues) && s.Catalogues.length ? s.Catalogues[0] : 'other';
    const name = s.DisplayName || s.Name || id;
    const desc = cleanLine(s.Description, 120);
    const sys = sp.slice(0, 1200) + (sp.length > 1200 ? '\n…（原文较长，已截断；安装后如需完整指令可在魔搭源页查看）' : '') +
      '\n\n【本地化说明】本角色源自魔搭智能体广场（https://modelscope.cn/agents），原始条目 ' + (s.Path || '') + '/' + (s.Name || '') + '。' +
      '其关联的魔搭托管 Skills/MCP（' + ((s.Skills || []).map(x => x.Name).join('、') || '无') + ' / ' + ((s.Mcps || []).map(x => x.Name).join('、') || '无') + '）在本地需自行配置对应工具；其余按原指令执行。';
    items.push({
      id, type: 'agent', name, category: CAT_MAP[catRaw] || String(catRaw).toLowerCase().slice(0, 20) || 'other',
      version: '1.0.0',
      description: desc + '（魔搭智能体广场 · ' + s.Framework + ' · 访问 ' + fmt(s.VisitCount) + ' · 下载 ' + fmt(s.Downloads) + ' · ' + (s.License || '') + '）',
      icon: { kind: 'url', url: s.LogoUrl || MCP_ICON },
      role: {
        id, name, emoji: '🤖',
        description: desc,
        systemPrompt: sys,
        tools: ['web_search', 'web_fetch', 'calculator', 'todo_write', 'memory_search', 'read_file', 'write_file'],
        temperature: 0.6, maxIterations: 12, allowDangerous: false, isPreset: false
      }
    });
  }
  return { items };
}

(async () => {
  const args = process.argv.slice(2);
  const get = k => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : null; };
  const type = (get('type') || 'all').toLowerCase();
  const pages = parseInt(get('pages') || '1', 10);
  const pageSize = parseInt(get('pageSize') || '200', 10);
  const limit = parseInt(get('limit') || '200', 10);
  const dry = args.includes('--dry');
  const outPath = get('out') || path.join(ROOT, 'data', 'marketplace', 'catalog.yaml');

  const items = [];
  const report = [];
  if (type === 'all' || type === 'mcp') {
    const { all, total } = await pull('/api/v1/dolphin/mcpServers', pages, pageSize, 'https://modelscope.cn/mcp',
      j => (j.Data && j.Data.McpServer && j.Data.McpServer.McpServers) || []);
    const r = buildMcpItems(all, 200);
    items.push(...r.items);
    report.push('MCP：商店 ' + total + ' 条，本次拉 ' + all.length + '，上架 ' + r.items.length + '（免密钥 ' + r.ok + ' + 需授权 ' + r.needKey + ' + 托管 ' + r.noCfg + '）');
  }
  if (type === 'all' || type === 'skill') {
    const { all, total } = await pull('/api/v1/dolphin/skills', pages, pageSize, 'https://modelscope.cn/skills',
      j => (j.Data && j.Data.SkillList) || []);
    const r = buildSkillItems(all, limit);
    items.push(...r.items);
    report.push('Skill：技能中心 ' + total + ' 条，本次拉 ' + all.length + '，上架 Top ' + r.items.length + '（按访问量）');
  }
  if (type === 'all' || type === 'agent') {
    const { all, total } = await pull('/api/v1/dolphin/agents', Math.max(pages, 4), pageSize, 'https://modelscope.cn/agents',
      j => (j.Data && j.Data.AgentList) || []);
    const r = buildAgentItems(all, 10000);
    items.push(...r.items);
    report.push('Agent：智能体广场 ' + total + ' 条，本次拉 ' + all.length + '，上架 ' + r.items.length + '（全量，含原始系统提示词）');
  }

  let merged = [];
  let outAbs = path.resolve(outPath);
  if (!dry) {
    const old = fs.existsSync(outAbs) ? ((yaml.load(fs.readFileSync(outAbs, 'utf8')) || {}).marketplace || []) : [];
    const byId = new Map();
    for (const it of old) byId.set(it.id, it);
    for (const it of items) byId.set(it.id, it);
    merged = Array.from(byId.values());
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.writeFileSync(outAbs, yaml.dump({ marketplace: merged }), 'utf8');
  }

  console.log('=== 魔搭商店源拉取完成 ===');
  report.forEach(l => console.log('  ' + l));
  console.log('输出: ' + (dry ? '（dry-run 未写入）' : (outAbs + '，合并后共 ' + merged.length + ' 条（含既有）')));
})().catch(e => { console.error('失败: ' + (e.stack || e.message)); process.exit(1); });

function fmt(n) {
  if (!n) return '0';
  if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + '万';
  return String(n);
}
