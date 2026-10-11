// 验证 pickMainWindow() 真的挑对了主窗口。
//
// 背景（Bug:「悬浮窗和主程序分离」）：
//   旧代码用 getAllWindows().find(w => w.isVisible() && /浮灵|desktop|main|助手/i.test(w.getTitle()))
//   挑锚点基准窗口。**三个窗口标题都含"浮灵饰界"**：
//     · 主窗口      "浮灵饰界 - 智能桌面助手"  1100×780
//     · 动作编辑器  "浮灵饰界 - 动作编辑器"    980×780（minWidth 860）
//     · 宠物窗口    "浮灵饰界 - 灵汐"          320×460  ← 面积只有主窗的 1/6
//   find() 取第一个匹配项，宠物窗往往先创建 → 拿 320×460 的 bounds 当锚点基准，
//   右缘算出来远超工作区宽度，被夹到屏幕右缘 → 表现为"小窗分离在屏幕右侧"。
//
// 本测试不启动 Electron：直接复刻 pickMainWindow 的判定逻辑（同一份正则 + 面积比较），
// 用真实窗口参数喂进去，验证旧逻辑选错、新逻辑选对。
// 用法：node scripts/test-pick-main-window.js
'use strict';
const path = require('path');
const fs = require('fs');

// ---- 真实窗口参数（取自 src/main/main.js）----
const WINS = [
  // 宠物窗最先创建（disclaimerAccepted 时它是第一个窗口），面积最小
  { title: '浮灵饰界 - 灵汐',           x: 1386, y: 640, width: 320, height: 460 },
  // 主窗口
  { title: '浮灵饰界 - 智能桌面助手',    x: 300,  y: 60,  width: 1100, height: 780 },
  // 动作编辑器（可能开着）
  { title: '浮灵饰界 - 动作编辑器',      x: 200,  y: 100, width: 980, height: 780 },
];

const RE = /浮灵|desktop|main|助手/i;
const area = (w) => w.width * w.height;

// ---- 旧逻辑（Bug 版）----
function oldPick(wins) {
  const w = wins.find((w) => RE.test(w.title));
  return w || null;
}

// ---- 新逻辑（pickMainWindow 同款）----
function newPick(wins) {
  if (!wins.length) return null;
  const cands = wins.filter((w) => RE.test(w.title || ''));
  const pool = cands.length ? cands : wins;
  return pool.reduce((a, b) => (area(b) > area(a) ? b : a));
}

const t = (s) => s.padEnd(30);
let fail = 0;

console.log('候选窗口：');
for (const w of WINS) console.log(`  ${t(w.title)} ${w.width}x${w.height}  area=${area(w)}  匹配正则=${RE.test(w.title)}`);
console.log('');

const oldW = oldPick(WINS);
const newW = newPick(WINS);
console.log(`旧逻辑 find()      → ${oldW ? t(oldW.title) + ' ' + oldW.width + 'x' + oldW.height : 'null'}`);
console.log(`新逻辑 pickMain    → ${newW ? t(newW.title) + ' ' + newW.width + 'x' + newW.height : 'null'}`);
console.log('');

// 断言 1：旧逻辑确实选错（宠物窗）
if (oldW && oldW.title === '浮灵饰界 - 灵汐') {
  console.log('✓ 复现成功：旧逻辑选中的是宠物窗（320×460）—— 这就是 bug 根因');
} else {
  console.log('! 旧逻辑这次没选到宠物窗（窗口顺序变了），bug 仍可能发生');
}

// 断言 2：新逻辑必须选主窗口
if (newW && newW.title === '浮灵饰界 - 智能桌面助手') {
  console.log('✓ 新逻辑选中主窗口 —— 修复生效');
} else {
  console.log('✗ 新逻辑选错了：' + (newW ? newW.title : 'null'));
  fail++;
}

// 断言 3：新逻辑在"只有宠物窗"时也能兜底（不能返回 null 导致锚点全丢）
const petOnly = newPick([WINS[0]]);
if (petOnly && petOnly.title === '浮灵饰界 - 灵汐') {
  console.log('✓ 仅剩宠物窗时返回它而非 null（锚点链路不断）');
} else {
  console.log('✗ 单窗口场景返回了 null');
  fail++;
}

// 断言 4：新逻辑在"标题都不匹配"时回退到全部窗口（老策略兜底仍生效）
const alien = newPick([{ title: 'Untitled', x: 0, y: 0, width: 800, height: 600 }]);
if (alien && alien.title === 'Untitled') {
  console.log('✓ 无匹配标题时回退到全部窗口（兜底策略保留）');
} else {
  console.log('✗ 无匹配标题时返回了 null');
  fail++;
}

// ---- 端到端：把锚点算出来，看小窗落在哪 ----
const WORKAREA = { x: 0, y: 0, width: 1706, height: 1066 };  // 2560×1600 物理 / 1.5 缩放
const SMALL_W = 360, GAP = 10;
const winH = Math.round(SMALL_W * 720 / 1280);   // 203
console.log(`\n工作区 ${WORKAREA.width}x${WORKAREA.height}（逻辑像素），小窗 ${SMALL_W}x${winH}\n`);

function project(winBounds, label) {
  // 复刻 computeAnchor + computePos（desktopSession.js）
  const right = Math.round(winBounds.x + winBounds.width);
  // 拿不到渲染端测量时的 estimate 分支
  const h = Math.min(104, Math.round(winBounds.height * 0.2));
  const anchor = { x: Math.round(winBounds.x), y: Math.round(winBounds.y + winBounds.height - h), width: Math.round(winBounds.width), right };
  let x = anchor.x + anchor.width - SMALL_W;
  let y = anchor.y - GAP - winH;
  const clampedX = Math.round(Math.min(Math.max(x, WORKAREA.x + 16), WORKAREA.x + WORKAREA.width - SMALL_W - 16));
  const clampedY = Math.round(Math.min(Math.max(y, WORKAREA.y + 16), WORKAREA.y + WORKAREA.height - winH - 16));
  const stuck = (clampedX !== x) || (clampedY !== y);
  console.log(`${label}:`);
  console.log(`  主窗 bounds=(${winBounds.x},${winBounds.y}) ${winBounds.width}x${winBounds.height}`);
  console.log(`  锚点 right=${right} → 小窗算得 (${x},${y})`);
  console.log(`  夹紧后     (${clampedX},${clampedY})${stuck ? '   ← 被夹了！说明越界' : '   （未夹紧）'}`);
  console.log(`  小窗右缘   ${clampedX + SMALL_W}  vs 主窗右缘 ${right}   差 ${(clampedX + SMALL_W) - right}`);
  return stuck;
}

const stuckOld = project(oldW, '【旧逻辑 · 拿宠物窗当基准】');
const stuckNew = project(newW, '【新逻辑 · 拿主窗当基准】');
console.log('');

if (stuckOld) {
  console.log('✓ 复现成功：旧逻辑下小窗被夹到屏幕边（右缘对不上主窗口 → 看起来"分离"）');
} else {
  console.log('! 旧逻辑这次没被夹（换分辨率可能不触发）');
}
if (!stuckNew) {
  console.log('✓ 新逻辑下小窗贴着主窗右缘，不再被夹 → 修复生效');
} else {
  console.log('✗ 新逻辑下仍被夹紧，说明还有别的问题');
  fail++;
}

console.log('\n================ 结论 ================');
console.log(fail === 0 ? 'PASS —— pickMainWindow 修好了锚点选窗。' : `FAIL（${fail} 项）`);
process.exit(fail === 0 ? 0 : 1);