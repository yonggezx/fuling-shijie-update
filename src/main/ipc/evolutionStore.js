/**
 * AI 进化记录（近期习惯 + 近期动向）
 * ------------------------------------------------------------
 * 目的：把「用户最近在做什么、偏好什么」按天记下来，生成一份习惯画像，
 *       用于两件事：
 *         1. 设置 → 功能设置 → 记忆 → 「AI 进化训练」面板里给用户查看/编辑；
 *         2. 注入到 AI 的系统提示词里（受 personalization.evolveEnabled 控制），
 *            让 AI 越用越贴合用户，而不是每次都从零开始。
 *
 * 存储：<userData>/evolution/YYYY-MM-DD.md（一天一个文件，按天分开）
 *       <userData>/evolution/profile.md（自动生成的画像，可手工编辑）
 *
 * 设计要点：
 *   - 纯 Markdown，人类可读可手改（与 .ai_workspace 的思路一致）。
 *   - 写入必须"轻量且永不抛错"：记录失败绝不能影响对话。
 *   - 只记摘要（用户这句话 + 用了哪些工具 + 简短结果），不存整段对话内容。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let baseDir = null;

function dir() {
  if (baseDir) return baseDir;
  try {
    // Electron 主进程可用；测试环境退到临时目录
    // eslint-disable-next-line global-require
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') return app.getPath('userData');
  } catch (e) { /* 非 Electron */ }
  return path.join(os.tmpdir(), 'ail-evolution');
}

/** 显式指定目录（测试 / main 启动时调用）。 */
function init(base) {
  baseDir = base || null;
  return dir();
}

function root() { return path.join(dir(), 'evolution'); }
function dayFile(dateStr) { return path.join(root(), (dateStr || today()) + '.md'); }
function profilePath() { return path.join(root(), 'profile.md'); }

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function timeStamp(d) {
  const x = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return p(x.getHours()) + ':' + p(x.getMinutes());
}

function ensureInit() {
  try {
    const r = root();
    if (!fs.existsSync(r)) fs.mkdirSync(r, { recursive: true });
    const readme = path.join(r, 'README.md');
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(readme,
        '# AI 进化记录\n\n'
        + '- `YYYY-MM-DD.md`：每天一条条记录「用户在做什么」（自动写，可手改）\n'
        + '- `profile.md`：由这些记录汇总出的习惯画像（自动生成，可手改）\n\n'
        + '这些内容用于让 AI 更贴合你的习惯。删掉文件即可清空对应记录。\n', 'utf-8');
    }
    return true;
  } catch (e) { return false; }
}

function oneLine(s, max) {
  return String(s == null ? '' : s)
    .replace(/\s+/g, ' ')
    .replace(/`/g, '')
    .trim()
    .slice(0, max || 100);
}

/** 记一条近期动向。永远不抛异常。 */
function append(entry) {
  try {
    const e = entry || {};
    if (!e.user && !e.summary) return false;
    ensureInit();
    const file = dayFile();
    const L = [];
    L.push('## ' + timeStamp() + '　' + (e.mode === 'agent' ? '任务处理' : '对话'));
    if (e.user) L.push('- 需求：' + oneLine(e.user, 120));
    if (e.project) L.push('- 项目：' + oneLine(e.project, 80));
    if (e.tools && e.tools.length) L.push('- 用到的工具：' + e.tools.slice(0, 8).join('、'));
    if (e.summary) L.push('- 结果：' + oneLine(e.summary, 160));
    L.push('');
    const sep = fs.existsSync(file) ? '\n' : '# 近期动向 · ' + today() + '\n\n';
    fs.appendFileSync(file, sep + L.join('\n') + '\n', 'utf-8');
    return true;
  } catch (err) {
    return false;
  }
}

function listDays() {
  try {
    const r = root();
    if (!fs.existsSync(r)) return [];
    return fs.readdirSync(r)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse();
  } catch (e) { return []; }
}

function parseDay(file) {
  const out = [];
  let txt = '';
  try { txt = fs.readFileSync(file, 'utf-8'); } catch (e) { return out; }
  const date = path.basename(file, '.md');
  const blocks = txt.split(/^##\s+/m).slice(1);
  for (const b of blocks) {
    const lines = b.split(/\r?\n/);
    const head = (lines[0] || '').trim();
    const rec = { date, time: (head.match(/^\d{2}:\d{2}/) || [''])[0], title: head, user: '', project: '', tools: [], summary: '' };
    for (const l of lines.slice(1)) {
      const m = l.match(/^-\s*([^：]+)[：:]\s*(.*)$/);
      if (!m) continue;
      const k = m[1].trim();
      const v = m[2].trim();
      if (k === '需求') rec.user = v;
      else if (k === '项目') rec.project = v;
      else if (k === '用到的工具') rec.tools = v.split(/[、,]/).map((x) => x.trim()).filter(Boolean);
      else if (k === '结果') rec.summary = v;
    }
    if (rec.user || rec.summary) out.push(rec);
  }
  return out;
}

/** 最近 N 条动向（跨天，新→旧）。 */
function listRecent(limit) {
  const n = Math.max(1, Number(limit) || 20);
  const out = [];
  for (const f of listDays()) {
    for (const r of parseDay(path.join(root(), f))) {
      out.push(r);
      if (out.length >= n) return out;
    }
  }
  return out;
}

function stats(days) {
  const span = Math.max(1, Number(days) || 7);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - span + 1);
  const iso = cutoff.toISOString().slice(0, 10);
  const all = [];
  for (const f of listDays()) {
    if (path.basename(f, '.md') < iso) continue;
    for (const r of parseDay(path.join(root(), f))) all.push(r);
  }
  const projects = {};
  const tools = {};
  const words = {};
  for (const r of all) {
    if (r.project) projects[r.project] = (projects[r.project] || 0) + 1;
    for (const t of r.tools) tools[t] = (tools[t] || 0) + 1;
    for (const w of tokenize(r.user)) words[w] = (words[w] || 0) + 1;
  }
  const top = (obj, k) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, k || 5).map(([name, n]) => ({ name, count: n }));
  return {
    days: span,
    total: all.length,
    daysActive: listDays().filter((f) => path.basename(f, '.md') >= iso).length,
    projects: top(projects, 3),
    tools: top(tools, 5),
    keywords: top(words, 8)
  };
}

const STOP = new Set([
  '这个', '那个', '一下', '怎么', '如何', '为什么', '可以', '需要', '不是', '没有', '还是',
  '就是', '然后', '现在', '因为', '所以', '如果', '但是', '我们', '它们', '问题', '功能',
  '帮我', '我要', '想要', '请把', '这个', '一下', '看看', '修复', '添加', '新增', '优化'
]);

/** 从用户需求里抽关键词：英文词 + 中文 2~4 字（短优先，去掉无信息量词）。 */
function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const out = [];
  for (const w of s.match(/[a-z][a-z0-9_]{2,}/g) || []) {
    if (w.length >= 3 && !STOP.has(w)) out.push(w);
  }
  const cn = s.replace(/[^一-龥]/g, '');
  for (let n = 4; n >= 2; n--) {
    for (let i = 0; i + n <= cn.length; i++) {
      const t = cn.substr(i, n);
      if (!STOP.has(t)) out.push(t);
    }
  }
  return out;
}

/** 生成/刷新习惯画像（profile.md）。永远不抛异常。 */
function buildProfile() {
  try {
    ensureInit();
    const s = stats(14);
    const L = [];
    L.push('# AI 进化画像');
    L.push('');
    L.push('> 由「近期动向」自动汇总，供 AI 参考。你可以直接改写这份文件（下次汇总会覆盖，想保留就改完加个新文件）。');
    L.push('');
    L.push('- 统计范围：最近 ' + s.days + ' 天');
    L.push('- 对话/任务数：' + s.total + '（活跃 ' + s.daysActive + ' 天）');
    if (s.projects.length) L.push('- 常做项目：' + s.projects.map((p) => p.name.split(/[\\/]/).pop() + '×' + p.count).join('、'));
    if (s.keywords.length) L.push('- 高频关注点：' + s.keywords.map((k) => k.name).join('、'));
    if (s.tools.length) L.push('- 常用工具：' + s.tools.map((t) => t.name).join('、'));
    L.push('');
    L.push('## 最近动向');
    L.push('');
    const recent = listRecent(12);
    if (!recent.length) L.push('（还没有记录。跟 AI 聊几句、处理几个任务后这里会自动出现。）');
    for (const r of recent) L.push('- ' + r.date + ' ' + r.time + '　' + (r.user || r.summary));
    L.push('');
    L.push('（生成时间：' + new Date().toLocaleString() + '）');
    const txt = L.join('\n') + '\n';
    fs.writeFileSync(profilePath(), txt, 'utf-8');
    return txt;
  } catch (e) {
    return '';
  }
}

/** 给系统提示词用的简短版画像（没有记录时返回空串，不浪费 token）。 */
function contextBlock(maxItems) {
  try {
    if (!listDays().length) return '';
    const s = stats(14);
    if (!s.total) return '';
    const parts = [];
    parts.push('## 近期动向（用于更贴合用户，别生硬复述）');
    const bits = [];
    if (s.total) bits.push('最近 ' + s.days + ' 天有 ' + s.total + ' 次对话/任务');
    if (s.projects.length) bits.push('常在 ' + s.projects.map((p) => p.name.split(/[\\/]/).pop()).join('、') + ' 上做事');
    if (s.keywords.length) bits.push('用户常关注：' + s.keywords.slice(0, 6).map((k) => k.name).join('、'));
    if (bits.length) parts.push('- ' + bits.join('；'));
    const recent = listRecent(maxItems || 5);
    for (const r of recent) {
      if (!r.user) continue;
      parts.push('- ' + r.date + ' ' + r.time + '：' + oneLine(r.user, 60));
    }
    parts.push('（用这些来调整你的默认做法与称呼，但**不要主动罗列**这份记录，用户没问就别提。）');
    return parts.join('\n');
  } catch (e) { return ''; }
}

/** 清空全部记录（含画像）。 */
function clear() {
  try {
    for (const f of listDays()) {
      try { fs.unlinkSync(path.join(root(), f)); } catch (e) { /* 忽略 */ }
    }
    try { if (fs.existsSync(profilePath())) fs.unlinkSync(profilePath()); } catch (e) { /* 忽略 */ }
    return true;
  } catch (e) { return false; }
}

module.exports = {
  init,
  dir,
  root,
  today,
  ensureInit,
  append,
  listRecent,
  listDays,
  stats,
  buildProfile,
  contextBlock,
  profilePath,
  clear
};
