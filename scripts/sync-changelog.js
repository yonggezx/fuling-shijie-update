#!/usr/bin/env node
/**
 * 由 src/renderer/data/changelog.json 生成 src/renderer/data/changelog.js。
 *
 * 为什么需要：
 *   关于页「更新公告」优先读 window.CHANGELOG（data/changelog.js，打包后 fetch 文件不保证可用），
 *   其次才读 data/changelog.json。以前只改 json 不改 js，就会出现「发了新版本，
 *   关于页公告还是旧版本」的问题。这里以 json 为唯一数据源，构建前自动同步。
 *
 * 用法：node scripts/sync-changelog.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const jsonPath = path.join(root, 'src', 'renderer', 'data', 'changelog.json');
const jsPath = path.join(root, 'src', 'renderer', 'data', 'changelog.js');

let entries;
try {
  const raw = fs.readFileSync(jsonPath, 'utf8').replace(/^\uFEFF/, '');
  entries = JSON.parse(raw);
} catch (e) {
  console.error('[sync-changelog] 读取 changelog.json 失败: ' + e.message);
  process.exit(1);
}
if (!Array.isArray(entries)) {
  console.error('[sync-changelog] changelog.json 顶层必须是数组');
  process.exit(1);
}

// 版本降序，保证关于页第一条永远是当前最新版本
entries.sort((a, b) => {
  const pa = String(a.version || '').split('.').map(Number);
  const pb = String(b.version || '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d) return d;
  }
  return 0;
});

const banner = [
  '// 更新公告数据（可被补丁热更新）',
  '// ⚠ 本文件由 scripts/sync-changelog.js 从 changelog.json 自动生成，请勿手改；',
  '//   改公告请编辑同目录 changelog.json，构建前会自动同步到这里。',
  'window.CHANGELOG = '
].join('\n');

const content = banner + JSON.stringify(entries, null, 2) + ';\n';
const old = fs.existsSync(jsPath) ? fs.readFileSync(jsPath, 'utf8') : '';
if (old !== content) {
  fs.writeFileSync(jsPath, content, 'utf8');
  console.log(`[sync-changelog] 已同步 ${entries.length} 个版本到 changelog.js（最新 v${entries[0] && entries[0].version}）`);
} else {
  console.log('[sync-changelog] changelog.js 已是最新，无需写入');
}
