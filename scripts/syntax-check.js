// 启动前语法自检：把 src/main + preload 全部 node --check 一遍。
// 为什么需要：多余/缺失的花括号在 JS 里往往不在出错的那行报错 —— 典型案例是
// `agentChat` 里多了一个 `}`，函数体被提前闭合，后面所有 await 变成"模块顶层 await"，
// 而主进程是 CommonJS 加载的 → 整个 Electron 主进程起不来，只弹一个红框。
// 这个脚本在启动前 3 秒就把它拦下来，并直接告诉你是哪个文件哪一行。
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const targets = [];
(function walk(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) targets.push(p);
  }
})(path.join(ROOT, 'src', 'main'));
const preload = path.join(ROOT, 'src', 'preload.js');
if (fs.existsSync(preload)) targets.push(preload);

let bad = 0;
for (const f of targets) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    const msg = (e.stderr ? e.stderr.toString() : '') + (e.message || '');
    // ESM 文件（用 import/export）跳过：node --check 默认按 CommonJS 解析
    if (/Cannot use import statement|Unexpected token 'export'|"type": "module"/.test(msg)) continue;
    bad++;
    console.error('\x1b[31m✖ 语法错误\x1b[0m ' + path.relative(ROOT, f));
    console.error('  ' + msg.split(/\r?\n/).slice(0, 5).join('\n  '));
  }
}

if (bad > 0) {
  console.error(`\x1b[31m[语法自检] ${bad} 个文件没过，主进程无法启动。已中止。\x1b[0m`);
  process.exit(1);
}
console.log(`[语法自检] ${targets.length} 个文件全部通过`);
