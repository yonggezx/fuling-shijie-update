/**
 * 项目隐藏工作区（AI 工作模式"选项目/创建项目"时初始化）
 * ------------------------------------------------------------
 * 在选中的项目根目录创建隐藏文件夹 <dir>/.ai_workspace/，并至少包含三个子文件夹，
 * 用于给 AI 投喂与思考校验，且不污染用户的真实项目源码（全部为 Markdown 文档）：
 *
 *   memory/     AI 长期记忆（memory.md）——「记忆」最后加
 *   context/    项目详细信息 / 分析（project-profile.md），AI 投喂用
 *   changes/    项目改动，精确到天（changes/YYYY-MM-DD.md；当天「问的」+「改的」记在一起）
 *
 * 选项目时由 agentChat 调用 ensureInit 一次性建好。
 * 注意：不用 .workbuddy（那是助理自身的记忆目录），本工作区独立命名避免冲突。
 */
const fs = require('fs');
const path = require('path');

const HIDDEN = '.ai_workspace';
const SUB = { memory: 'memory', context: 'context', changes: 'changes' };

function root(dir) { return path.join(dir, HIDDEN); }
function memoryDir(dir) { return path.join(root(dir), SUB.memory); }
function contextDir(dir) { return path.join(root(dir), SUB.context); }
function changesDir(dir) { return path.join(root(dir), SUB.changes); }

function memoryPath(dir) { return path.join(memoryDir(dir), 'memory.md'); }
function contextPath(dir) { return path.join(contextDir(dir), 'project-profile.md'); }

function todayLocal() {
  const d = new Date();
  const off = d.getTimezoneOffset() * 60000; // 转本地日期，避免跨时区把当天改动算到昨天
  return new Date(d.getTime() - off).toISOString().slice(0, 10);
}

// 改动精确到天：changes/YYYY-MM-DD.md —— 一天一个文档；当天「问的问题」与「改动的文件」记在一起
function changesPath(dir, date) {
  return path.join(changesDir(dir), (date || todayLocal()) + '.md');
}
function timeStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/** 列出改动文档：指定日期则返回该天文件，否则返回全部（新的在前）。 */
function listChanges(dir, date) {
  const base = changesDir(dir);
  let files = [];
  if (date) {
    const f = changesPath(dir, date);
    if (fs.existsSync(f)) files = [f];
  } else if (fs.existsSync(base)) {
    files = fs.readdirSync(base).filter(f => f.endsWith('.md')).map(f => path.join(base, f));
  }
  files.sort((a, b) => (a < b ? 1 : -1));
  return files;
}

/**
 * 初始化隐藏工作区：确保隐藏文件夹 + 三个子文件夹存在（幂等）。
 * 选项目时调用一次即可；返回是否成功。
 */
function ensureInit(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  try {
    for (const d of [root(dir), memoryDir(dir), contextDir(dir), changesDir(dir)]) {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    }
    const readme = path.join(root(dir), 'README.md');
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(readme,
        '# 项目 AI 工作区（隐藏文件夹）\n\n' +
        '本文件夹由 AI 工作模式自动创建，存放给 AI 投喂与思考校验的资料，**不会污染你的项目源码**。全部为 Markdown 文档。\n\n' +
        '- `memory/memory.md`  AI 长期记忆，跨会话保留\n' +
        '- `context/project-profile.md` 项目详细信息 / 分析，AI 理解项目用\n' +
        '- `changes/YYYY-MM-DD.md` 当天的改动记录（问了什么 + 改了哪些文件，按天一个文档）\n', 'utf-8');
    }
    return true;
  } catch (e) {
    console.warn('[Workspace] 初始化隐藏工作区失败:', e.message);
    return false;
  }
}

/**
 * 记录一次项目改动：追加到「当天」的 changes/YYYY-MM-DD.md（一天一个文档，多次追加）。
 * 当天每次问答都会追加一条：问的问题 + AI 概要 + 改动的文件（合在一起）。
 * entry: { title?, question?, summary?, files?: string[] }
 * 返回写入的文件绝对路径（失败返回 null）。
 */
function appendChange(dir, entry) {
  if (!dir) return null;
  ensureInit(dir);
  try {
    const file = changesPath(dir);
    const L = [];
    L.push('## ' + timeStamp(new Date()) + '　' + ((entry && entry.title) ? entry.title : '改动'));
    if (entry && entry.question) {
      L.push('');
      L.push('**问：** ' + String(entry.question).replace(/\s+/g, ' ').slice(0, 500));
    }
    if (entry && entry.summary) {
      L.push('');
      L.push('**概要：**');
      L.push('');
      L.push(String(entry.summary).slice(0, 2000));
    }
    if (entry && entry.files && entry.files.length) {
      L.push('');
      L.push('**改动的文件：**');
      for (const f of entry.files.slice(0, 80)) L.push('- `' + String(f).replace(/`/g, '') + '`');
    }
    L.push('');
    const sep = fs.existsSync(file) ? '\n' : '# 项目改动记录（' + todayLocal() + '）\n\n';
    fs.appendFileSync(file, sep + L.join('\n') + '\n', 'utf-8');
    return file;
  } catch (e) {
    console.warn('[Workspace] 写入改动记录失败:', e.message);
    return null;
  }
}

module.exports = {
  HIDDEN, SUB,
  root, memoryDir, contextDir, changesDir,
  memoryPath, contextPath, changesPath, todayLocal,
  ensureInit, appendChange, listChanges
};
