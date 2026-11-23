#!/usr/bin/env node
/**
 * 导出本次版本的更新公告（Release Notes）。
 *
 * 用途：流水线发布时把 src/renderer/data/changelog.json 里当前版本的公告
 * 转成 markdown，交给 scripts/sync-update-manifest.js --notes-file，
 * 让 update/latest.json / full-install.json 的 releaseNotes、以及应用内
 * 「更新公告」弹窗和安装包安装页展示的是同一份更新记录。
 *
 * 用法：
 *   node scripts/export-release-notes.js --version=v1.0.12 --out=.release-notes.md
 */
'use strict';
const fs = require('fs');
const path = require('path');

function arg(name, def) {
  const hit = process.argv.slice(2).find(a => a.startsWith('--' + name + '='));
  return hit ? hit.slice(('--' + name + '=').length) : def;
}

const root = path.resolve(__dirname, '..');
const tag = (arg('version', '') || '').trim();
if (!tag) {
  console.error('[release-notes] 缺少 --version（例如 --version=v1.0.12）');
  process.exit(1);
}
const version = tag.replace(/^v/, '');
const outFile = path.resolve(root, arg('out', '.release-notes.md'));

const TYPE_LABEL = { feature: '新功能', fix: '修复', improvement: '优化', notice: '公告' };

let entries = [];
try {
  const parsed = JSON.parse(fs.readFileSync(path.join(root, 'src', 'renderer', 'data', 'changelog.json'), 'utf8').replace(/^\uFEFF/, ''));
  if (Array.isArray(parsed)) entries = parsed;
} catch (e) {
  console.error('[release-notes] 读取 changelog.json 失败: ' + e.message);
  process.exit(1);
}

const entry = entries.find(e => e && String(e.version) === version);
let text;
if (entry) {
  const lines = [`## v${version} 更新`];
  if (entry.title && entry.title !== `v${version} 更新`) lines.push('', entry.title);
  lines.push('');
  for (const c of (entry.changes || [])) {
    const label = TYPE_LABEL[c.type] || '更新';
    const desc = c.desc && c.desc !== c.title ? `：${c.desc}` : '';
    lines.push(`- 【${label}】${c.title || ''}${desc}`);
  }
  text = lines.join('\n').trim();
} else {
  text = `## v${version} 更新\n\n- 本次发布包含体验优化与问题修复`;
  console.warn(`[release-notes] ⚠ changelog.json 没有 v${version} 的条目，已使用兜底公告`);
}

fs.writeFileSync(outFile, text + '\n', 'utf8');
console.log(`[release-notes] 已导出 ${path.relative(root, outFile)}（v${version}，${(entry && entry.changes || []).length} 条）`);
