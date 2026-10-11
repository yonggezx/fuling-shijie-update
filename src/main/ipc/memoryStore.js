/**
 * AI 长期记忆存储
 * ------------------------------------------------------------
 * 目的：让 Agent 能把「跨会话仍然成立」的信息记下来（用户偏好、项目约定、踩过的坑），
 *      下次对话自动注入系统提示词，而不是每次重新问用户。
 *
 * 存储：<userData>/memory.md（程序安全目录，全局、跨项目共享）
 *   Markdown 格式，每条记忆一行 + 行尾元数据注释（见 serializeMarkdown）
 *
 * 设计要点：
 * - 文档是人类/AI 可读的 Markdown，不是 JSON；程序仍用内存数组做检索/淘汰。
 * - 双保险限额：条数上限 + 单条长度上限，避免记忆库无限膨胀（注入 prompt 是要花 token 的）。
 * - 写入去重：文本归一化后一致的条目直接合并（更新 tags / updatedAt），不产生重复记忆。
 * - 原子写入：先写临时文件再 rename，避免进程被杀导致 memory.md 变成空文件。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_ITEMS = 200;      // 最多保留多少条
const MAX_TEXT = 500;       // 单条最长字符数
const DEFAULT_BUDGET = 1200; // 注入系统提示词的默认字符预算

// kind 仅用于注入时加个前缀标签，便于模型理解记忆类型
const KINDS = ['fact', 'preference', 'project', 'fix', 'note'];
const KIND_LABEL = {
  fact: '事实',
  preference: '偏好',
  project: '项目',
  fix: '修复经验',
  note: '备注'
};

let storePath = null;
let cache = null;
let globalStorePath = null; // 启动时的全局记忆路径（<userData>/memory.md），作为无项目时的回退

function init(filePath) {
  // 首次（通常是启动时的全局记忆）初始化时记下全局路径，作为无项目选项的回退
  if (globalStorePath === null && filePath) globalStorePath = filePath;
  storePath = filePath;
  cache = null;
  return load();
}

/**
 * 记忆作用域：选了项目 → <workdir>/.ai_workspace/memory/memory.md（与 projectWorkspace.memoryPath 一致）；
 * 未选项目 → 全局 <userData>/memory.md。
 * ★ 之前这里写死返回 globalStorePath，导致「选项目后项目里的记忆永远不被读取」，
 *   Agent 设置面板明明提示"当前作用域：项目 xxx"，列表却始终是全局库（空）。
 */
function scopePathForWorkdir(workdir) {
  if (workdir && typeof workdir === 'string' && workdir.trim()) {
    try {
      return path.join(workdir.trim(), '.ai_workspace', 'memory', 'memory.md');
    } catch (e) { /* 非法 workdir 回退全局 */ }
  }
  return globalStorePath;
}

/** 确保当前记忆库作用域正确（每次记忆操作前调用，避免跨项目/全局串味）。 */
function ensureScope(targetPath) {
  const p = targetPath || globalStorePath;
  if (!p) return;
  if (storePath !== p) init(p);
}

function load() {
  if (cache) return cache;
  cache = { version: 1, items: [] };
  if (!storePath) return cache;
  try {
    if (fs.existsSync(storePath)) {
      cache.items = parseMarkdown(fs.readFileSync(storePath, 'utf-8')).filter(it => it && it.text);
    } else if (migrateLegacyJson()) {
      // 旧版 JSON 记忆库 → 迁移成 Markdown（并回写 .md）
      return load();
    }
  } catch (e) {
    console.warn('[Memory] 读取记忆库失败，按空库处理:', e.message);
    cache = { version: 1, items: [] };
  }
  return cache;
}

function save() {
  if (!storePath) return false;
  try {
    const dir = path.dirname(storePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = storePath + '.tmp';
    fs.writeFileSync(tmp, serializeMarkdown(cache), 'utf-8');
    fs.renameSync(tmp, storePath);
    return true;
  } catch (e) {
    console.warn('[Memory] 写入记忆库失败:', e.message);
    return false;
  }
}

// ============================================================
// Markdown 存储格式
// ------------------------------------------------------------
// 记忆是「给人看、也给 AI 读」的文档，不是机器配置，所以用 Markdown 而非 JSON。
// 每条记忆一行，机器元数据放在行尾 HTML 注释里（渲染时不可见，但能完整往返解析）：
//   - [项目] 这个项目用 electron 打包 <!-- ailobster:id=m_xxx;tags=proj;hits=2;... -->
// 这样即使 AI/程序没写注释，手工编辑也能正常读取（缺失字段用默认值）。
// ============================================================

const META_RE = /\s*<!--\s*ailobster:(.*?)\s*-->\s*$/;

function serializeMarkdown(data) {
  const lines = [
    '# AI 长期记忆',
    '',
    '> 本文件由 AI 龙虾自动维护，记录跨会话仍然成立的信息。每条记忆一行，行尾注释内为元数据（id/标签/命中/时间），可手工编辑。',
    ''
  ];
  for (const it of (data && data.items) || []) {
    const label = KIND_LABEL[it.kind] || KIND_LABEL.note;
    const meta = [
      'id=' + it.id,
      'tags=' + (it.tags || []).join(','),
      'pinned=' + (it.pinned ? 1 : 0),
      'hits=' + (it.hits || 0),
      'created=' + it.createdAt,
      'updated=' + it.updatedAt,
      'source=' + (it.source || 'agent')
    ].join(';');
    lines.push('- [' + label + '] ' + it.text + ' <!-- ailobster:' + meta + ' -->');
  }
  if (lines.length === 4) lines.push('（暂无记忆）');
  return lines.join('\n') + '\n';
}

function parseMarkdown(text) {
  const items = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('- ')) continue;
    const m = line.match(/^-\s*\[(.*?)\]\s*([\s\S]*?)\s*$/);
    if (!m) continue;
    const label = m[1].trim();
    let rest = m[2];
    let metaStr = '';
    const mm = rest.match(META_RE);
    if (mm) { metaStr = mm[1]; rest = rest.slice(0, mm.index); }
    const meta = {};
    for (const kv of metaStr.split(';')) {
      const i = kv.indexOf('=');
      if (i > 0) meta[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    }
    // 反查 kind：既支持中文标签也支持英文 kind
    let kind = 'note';
    if (KINDS.includes(label)) kind = label;
    else {
      for (const k of KINDS) if (KIND_LABEL[k] === label) { kind = k; break; }
    }
    items.push({
      id: meta.id || '',
      text: rest,
      tags: meta.tags ? meta.tags.split(',').filter(Boolean) : [],
      kind,
      pinned: meta.pinned === '1',
      hits: Number(meta.hits) || 0,
      createdAt: Number(meta.created) || Date.now(),
      updatedAt: Number(meta.updated) || Date.now(),
      source: meta.source || 'agent'
    });
  }
  return items.map(normalizeItem).filter(it => it && it.text);
}

/** 兼容旧版：若同目录存在 memory.json 而 .md 还没有，则读入并迁移成 Markdown。 */
function migrateLegacyJson() {
  try {
    const legacy = storePath.replace(/\.md$/i, '.json');
    if (!fs.existsSync(legacy)) return false;
    const raw = JSON.parse(fs.readFileSync(legacy, 'utf-8'));
    const items = Array.isArray(raw && raw.items) ? raw.items : [];
    if (!items.length) return false;
    cache = { version: 1, items: items.map(normalizeItem).filter(it => it && it.text) };
    save();
    console.log('[Memory] 已把旧版 memory.json 迁移为 Markdown:', storePath, '(' + cache.items.length + ' 条)');
    return true;
  } catch (e) {
    return false;
  }
}

function normalizeText(t) {
  return String(t == null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

function normalizeTags(tags) {
  const arr = Array.isArray(tags) ? tags : (typeof tags === 'string' ? tags.split(/[,，;；\s]+/) : []);
  const out = [];
  for (const t of arr) {
    const s = String(t == null ? '' : t).replace(/\s+/g, '').slice(0, 24);
    if (s && !out.includes(s) && out.length < 8) out.push(s);
  }
  return out;
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = normalizeText(raw.text);
  if (!text) return null;
  const kind = KINDS.includes(raw.kind) ? raw.kind : 'note';
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
    text,
    tags: normalizeTags(raw.tags),
    kind,
    source: typeof raw.source === 'string' ? raw.source.slice(0, 40) : 'agent',
    pinned: !!raw.pinned,
    hits: Number.isFinite(raw.hits) ? raw.hits : 0,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now()
  };
}

function newId() {
  return 'm_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

/** 新增或更新一条记忆。传 id 或文本与已有条目完全一致时视为更新（upsert）。 */
function add({ text, tags, kind, pinned, source, id } = {}) {
  const s = load();
  const clean = normalizeText(text);
  if (!clean) return { success: false, error: '记忆内容不能为空' };

  let target = id ? s.items.find(it => it.id === id) : null;
  if (!target) target = s.items.find(it => it.text === clean);
  const now = Date.now();

  if (target) {
    target.text = clean;
    if (tags !== undefined) target.tags = normalizeTags(tags);
    if (kind && KINDS.includes(kind)) target.kind = kind;
    if (pinned !== undefined) target.pinned = !!pinned;
    target.updatedAt = now;
    save();
    return { success: true, updated: true, item: target, total: s.items.length };
  }

  const item = normalizeItem({ text: clean, tags, kind, pinned, source, id: id || newId() });
  item.createdAt = now;
  item.updatedAt = now;
  s.items.push(item);

  // 超限时优先淘汰：未置顶 → 最少命中 → 最久未更新
  let evicted = 0;
  while (s.items.length > MAX_ITEMS) {
    const pool = s.items.filter(it => !it.pinned);
    const cand = (pool.length ? pool : s.items)
      .slice()
      .sort((a, b) => (a.hits - b.hits) || (a.updatedAt - b.updatedAt))[0];
    const idx = s.items.indexOf(cand);
    if (idx < 0) break;
    s.items.splice(idx, 1);
    evicted++;
  }
  save();
  return { success: true, updated: false, item, total: s.items.length, evicted };
}

function update(id, patch = {}) {
  const s = load();
  const it = s.items.find(x => x.id === id);
  if (!it) return { success: false, error: '未找到记忆: ' + id };
  if (patch.text !== undefined) {
    const clean = normalizeText(patch.text);
    if (!clean) return { success: false, error: '记忆内容不能为空' };
    it.text = clean;
  }
  if (patch.tags !== undefined) it.tags = normalizeTags(patch.tags);
  if (patch.kind && KINDS.includes(patch.kind)) it.kind = patch.kind;
  if (patch.pinned !== undefined) it.pinned = !!patch.pinned;
  it.updatedAt = Date.now();
  save();
  return { success: true, item: it };
}

function remove(id) {
  const s = load();
  const idx = s.items.findIndex(x => x.id === id);
  if (idx < 0) return { success: false, error: '未找到记忆: ' + id };
  const [gone] = s.items.splice(idx, 1);
  save();
  return { success: true, removed: gone, total: s.items.length };
}

/** 按关键词删除（支持一次删多条），用于「忘掉关于 X 的记忆」。 */
function removeByQuery(query, limit = 10) {
  const s = load();
  const hits = search(query, limit).filter(h => (h.score || 0) >= 3); // ★ 弱匹配（1~2分）不允许触发删除，防止误删
  if (!hits.length) return { success: false, error: '没有匹配「' + query + '」的记忆' };
  const ids = new Set(hits.map(h => h.id));
  const removed = s.items.filter(it => ids.has(it.id));
  s.items = s.items.filter(it => !ids.has(it.id));
  save();
  return { success: true, removed, total: s.items.length };
}

function clear() {
  const s = load();
  const n = s.items.length;
  s.items = [];
  save();
  return { success: true, removed: n };
}

function list({ tag, kind, limit = 50 } = {}) {
  const s = load();
  let items = s.items.slice();
  if (tag) items = items.filter(it => it.tags.includes(tag));
  if (kind) items = items.filter(it => it.kind === kind);
  items.sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
  return items.slice(0, limit);
}

/**
 * 从用户问题里提取关键词：英文/数字单词 + 中文 3~4 元组。
 * 用于「反向匹配」：问题关键词出现在记忆文本里即算命中，
 * 解决用户换个说法提问（与记忆文本无连续 3 字相同）时检索不到的问题。
 */
/** 反向匹配不参与计分的通用停用词（避免"为什么/关于/记忆"等撞出虚假命中甚至误删） */
const QUERY_STOP2 = new Set([
  '什么', '怎么', '怎样', '如何', '为什么', '这个', '那个', '哪些', '哪个', '可以', '是不是',
  '没有', '不是', '就是', '但是', '然后', '关于', '记忆', '内容', '信息', '东西', '东西',
  '时候', '现在', '自己', '我们', '你们', '他们', '一个', '一下', '一下', '还是', '已经',
  '应该', '需要', '想要', '请问', '帮我', '告诉', '看看', '一下', '刚才', '之前', '以后'
]);

function extractQueryKeywords(q) {
  const words = q.match(/[a-z0-9][a-z0-9_.-]{1,}/g) || []; // electron, win10, api_key…
  const cjk = q.replace(/[^\u4e00-\u9fa5]/g, '');
  const kws = [];
  for (let n = 4; n >= 2; n--) {
    for (let i = 0; i + n <= cjk.length; i++) {
      const g = cjk.substr(i, n);
      if (n === 2 && QUERY_STOP2.has(g)) continue;
      kws.push(g);
    }
  }
  return { words, kws };
}

/**
 * 纯匹配分：0 表示「与关键词无关」。
 * ⚠️ 置顶等权重只能加在排序上，不能加在这里 —— 否则置顶条目会命中任意关键词，
 *    被 memory_search 全部返回，甚至被 memory_delete(query) 误删（踩过）。
 * 双向匹配：
 *   ① 记忆文本 3~4 元组出现在问题里（记忆措辞 → 问题，原方向）
 *   ② 问题关键词出现在记忆文本里（问题 → 记忆措辞，反向，带分值上限防误伤）
 */
function matchScore(item, q) {
  if (!q) return 0;
  let score = 0;
  for (const t of item.tags) if (t && q.includes(t.toLowerCase())) score += 4;
  const textLower = item.text.toLowerCase();
  // 完整查询串整体出现在记忆里
  if (textLower.includes(q)) score += 6;
  // ① 原方向：记忆文本（去标点）的 3~4 字片段出现在问题里
  const clean = item.text.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').slice(0, 160);
  for (let n = 4; n >= 3; n--) {
    for (let i = 0; i + n <= clean.length; i++) {
      if (q.includes(clean.substr(i, n))) score += (n === 4 ? 2 : 1);
    }
  }
  // ② 反向：问题的关键词出现在记忆文本里（上限 8 分，避免长问题撞出虚高匹配）
  let reverse = 0;
  const { words, kws } = extractQueryKeywords(q);
  for (const w of words) if (textLower.includes(w)) reverse += 3;
  for (const k of kws) reverse += (k.length >= 3 ? 2 : 1) * (textLower.includes(k) ? 1 : 0);
  score += Math.min(reverse, 8);
  return score;
}

/** 排序分 = 匹配分 + 置顶权重（只用于排序，不用于判断是否命中） */
function relevance(item, q) {
  return matchScore(item, q) + (item.pinned ? 5 : 0);
}

function search(query, limit = 10) {
  const s = load();
  const q = String(query || '').toLowerCase().trim();
  if (!q) return list({ limit });
  const scored = s.items
    .map(it => ({ it, hit: matchScore(it, q) }))
    .filter(x => x.hit > 0)
    .sort((a, b) => (b.hit + (b.it.pinned ? 5 : 0)) - (a.hit + (a.it.pinned ? 5 : 0)));
  // 命中后累计 hits，用于淘汰策略与排序
  const out = scored.slice(0, limit).map(x => {
    x.it.hits = (x.it.hits || 0) + 1;
    return { ...x.it, score: x.hit };
  });
  if (out.length) save();
  return out;
}

/**
 * 生成注入系统提示词的记忆文本块。
 * ★ 分层选取：先取「与当前问题有匹配」的记忆（按匹配分降序），
 *   匹配的全用完（或超限）后才轮到未匹配的（置顶优先、最近更新优先）。
 *   之前用 relevance()（匹配分+置顶权重）混排，无匹配的置顶记忆（5 分）
 *   会压过真正相关但匹配分低的记忆，把字符预算占满——表现为
 *   「项目里明明有相关记忆，AI 却不知道」。
 */
function buildPromptBlock(userMessage, charBudget = DEFAULT_BUDGET) {
  const s = load();
  if (!s.items.length) return '';

  const q = String(userMessage || '').toLowerCase();
  const scored = s.items.map(it => ({
    it,
    ms: matchScore(it, q),
    ts: it.updatedAt
  }));
  scored.sort((a, b) =>
    ((b.ms > 0) - (a.ms > 0)) ||          // 有匹配的一律排在无匹配之前
    (b.ms - a.ms) ||                      // 匹配分降序
    ((b.it.pinned ? 1 : 0) - (a.it.pinned ? 1 : 0)) || // 同层内置顶优先
    (b.ts - a.ts)                         // 再按最近更新
  );

  const picked = [];
  let used = 0;
  for (const { it } of scored) {
    const line = '- [' + (KIND_LABEL[it.kind] || '备注') + '] ' + it.text +
      (it.tags.length ? '（标签: ' + it.tags.join('/') + '）' : '');
    if (used + line.length + 1 > charBudget) continue;
    picked.push(line);
    used += line.length + 1;
    if (picked.length >= 40) break;
  }
  if (!picked.length) return '';

  return [
    '## 长期记忆（你在以往会话中记录下来的信息，请优先遵守，避免重复询问用户）',
    ...picked,
    '（记忆库共 ' + s.items.length + ' 条，已按当前问题相关度挑选 ' + picked.length + ' 条；' +
    '需要更多可用 memory_search 检索，新增/修正用 memory_save，删除用 memory_delete。）'
  ].join('\n');
}

function stats() {
  const s = load();
  return {
    total: s.items.length,
    pinned: s.items.filter(i => i.pinned).length,
    max: MAX_ITEMS,
    file: storePath || null
  };
}

module.exports = {
  init, stats, list, search, add, update, remove, removeByQuery, clear, buildPromptBlock,
  scopePathForWorkdir, ensureScope,
  KINDS, KIND_LABEL, MAX_ITEMS, MAX_TEXT
};
