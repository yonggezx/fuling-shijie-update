// 验证「桌面分身小窗跟随主窗口」这条链路。
//
// 复现并锁死三个真实 bug（都是这轮修的）：
//   ① measureInputBarRect() 不返回 right → reanchor 发 right=0 → 宿主退回"贴输入栏右缘"
//      → 拖动后横向对不齐窗口右边框；
//   ② 拖动中每次都 executeJavaScript 重量 → 几十毫秒延迟 → 小窗滞后，"像独立程序"；
//      正确做法是拖动期推**增量**、停手后再重量校正；
//   ③ 增量指令取名 'move' 会和宿主「注入到 RDP 的鼠标移动」指令串台（宿主已有 case "move"）。
//
// 本测试不启动 Electron：把 main.js / desktopSession.js / HostForm.cs 三方的定位算法
// 原样复刻出来喂数据，逐帧检查小窗落点。
// 用法：node scripts/test-clone-follow.js
'use strict';

// ---- 主窗口与输入栏的真实参数（DIP）----
const WIN = { x: 300, y: 60, w: 1100, h: 780 };
// 输入栏在客户区内的位置（相对主窗口原点）
const BAR = { x: 40, y: 620, w: 1020, h: 104 };
const SM = 360, SM_H = 203, GAP = 10, MARGIN = 16;
const WORK = { x: 0, y: 0, w: 1706, h: 1066 };   // 2560×1600 / 1.5

// ---- desktopSession.computeAnchor ----
function computeAnchor(win, bar, withRight) {
  const right = withRight ? Math.round(win.x + win.w) : null;
  return {
    x: Math.round(win.x + bar.x), y: Math.round(win.y + bar.y),
    width: Math.round(bar.w), height: Math.round(bar.h),
    right, source: 'renderer',
  };
}

// ---- HostForm.ApplyAnchorPosition（DIP 空间，150% 缩放已约掉）----
function applyAnchor(a) {
  if (!(a.width > 0) || !(a.height > 0) || a.x < 0) return null;
  let x = (a.right && a.right > 0 ? a.right : a.x + a.width) - SM;
  let y = a.y - GAP - SM_H;
  x = Math.min(Math.max(x, WORK.x + MARGIN), WORK.x + WORK.w - SM - MARGIN);
  y = Math.min(Math.max(y, WORK.y + MARGIN), WORK.y + WORK.h - SM_H - MARGIN);
  return { x: Math.round(x), y: Math.round(y) };
}

// ---- HostForm 的 follow（增量平移 + 工作区夹紧）----
function applyFollow(cur, d) {
  if (d.dw || d.dh) return null;              // 尺寸变了 → 走重量
  let nx = cur.x + d.dx, ny = cur.y + d.dy;
  nx = Math.min(Math.max(nx, WORK.x), WORK.x + WORK.w - SM);
  ny = Math.min(Math.max(ny, WORK.y), WORK.y + WORK.h - SM_H);
  return { x: Math.round(nx), y: Math.round(ny) };
}

let fail = 0;
const ok = (c, m) => { if (!c) { console.log('  ✗ ' + m); fail++; } else console.log('  ✓ ' + m); };

// ================= 场景 1：拖动主窗口（right 缺失 vs 修正） =================
console.log('【场景1】拖动主窗口 300,60 → 700,300，看小窗是否贴着主窗右缘\n');

const moveSteps = [
  { dx: 40, dy: 24 }, { dx: 40, dy: 24 }, { dx: 40, dy: 24 },
  { dx: 40, dy: 24 }, { dx: 40, dy: 24 }, { dx: 40, dy: 24 },
];

for (const withRight of [false, true]) {
  const label = withRight ? '修正后（rect.right 有值）' : '对照组：修正前（right=0）';
  let win = { ...WIN };
  // 首锚
  let anchor = computeAnchor(win, BAR, withRight);
  let pos = applyAnchor(anchor);
  const startRight = win.x + win.w;

  // 拖动：只推增量（正确的低延迟做法）
  let cur = { x: pos.x, y: pos.y };
  for (const s of moveSteps) {
    win = { ...win, x: win.x + s.dx, y: win.y + s.dy };
    cur = applyFollow(cur, s) || cur;
  }
  // 停手后：全量校正（主进程会重新 executeJavaScript 重量）
  win = { ...win, x: win.x + 40, y: win.y + 24 };  // 再来一点，制造"校正滞后"
  cur = applyFollow(cur, { dx: 40, dy: 24 }) || cur;
  const finalWinRight = win.x + win.w;
  const cloneRight = cur.x + SM;
  const diff = cloneRight - finalWinRight;

  console.log(`${label}:`);
  console.log(`  主窗右缘 ${startRight} → ${finalWinRight}（拖了 ${finalWinRight - startRight}px）`);
  console.log(`  小窗右缘 ${cloneRight}   偏差 ${diff >= 0 ? '+' : ''}${diff}px`);
  if (withRight) {
    ok(Math.abs(diff) <= 1, `小窗右缘对齐主窗右缘（偏差 ≤1px）`);
  } else {
    // 对照组：这里**期望**有偏差 —— 它证明"right 缺失会导致永久横向偏移"这个 bug 真实存在。
    const reproduced = Math.abs(diff) > 1;
    ok(reproduced, `对照组成功复现横向偏移 ${diff}px（证明该 bug 真实存在）`);
  }
  console.log('');
}

// ================= 场景 2：横向位置（right 缺失的实际后果） =================
console.log('【场景2】量化「right 缺失」造成的横向漂移\n');
{
  // 输入栏比主窗口窄（左右有内边距），输入栏右缘 ≠ 主窗口右缘
  const win = { x: 300, y: 60, w: 1100, h: 780 };
  const bar = { x: 40, y: 620, w: 1020, h: 104 };
  const aNo = applyAnchor(computeAnchor(win, bar, false));
  const aYes = applyAnchor(computeAnchor(win, bar, true));
  const mainRight = win.x + win.w;
  console.log(`  主窗右缘 = ${mainRight}，输入栏右缘 = ${win.x + bar.x + bar.w}`);
  console.log(`  right=0   → 小窗右缘 ${aNo.x + SM}  偏差 ${aNo.x + SM - mainRight}`);
  console.log(`  right 正确 → 小窗右缘 ${aYes.x + SM}  偏差 ${aYes.x + SM - mainRight}`);
  ok(Math.abs(aYes.x + SM - mainRight) <= 1, 'right 正确时右缘精确贴合');
}

// ================= 场景 3：指令命名冲突 =================
console.log('\n【场景3】增量指令命名 —— 宿主已有 move 分支\n');
{
  const fs = require('fs'), path = require('path');
  const host = fs.readFileSync(path.join(__dirname, '..', 'tools', 'RdpHost.Native', 'RdpHostNative.cpp'), 'utf8');
  const ds = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'desktopSession.js'), 'utf8');
  const hasMouseMoveBranch = /act=="move"[\s\S]{0,120}?g_rdp\.SendMouse/.test(host);
  const noFollowBranch = !/act\s*==\s*"follow"/i.test(host);
  const sendsFollow = /action:\s*'follow'/.test(ds);
  ok(hasMouseMoveBranch, '宿主 move 分支仍是注入 RDP 的鼠标移动（未被占用）');
  ok(noFollowBranch, '宿主没有 follow 注入分支（窗口跟随指令不会串台成远程鼠标移动）');
  ok(sendsFollow, '主进程增量指令发的是 follow');
}

// ================= 场景 4：measureInputBarRect 必须补 right =================
console.log('\n【场景4】measureInputBarRect 是否补了 right\n');
{
  const fs = require('fs'), path = require('path');
  const m = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  const fn = m.slice(m.indexOf('async function measureInputBarRect'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  ok(/rect\.right\s*=/.test(body), 'measureInputBarRect 补上了 rect.right');
  ok(/getBounds\(\)/.test(body), 'right 来自主窗口 getBounds');
}

// ================= 场景 5：拖动链路完整性 =================
console.log('\n【场景5】拖动跟随链路（增量 + 校正）\n');
{
  const fs = require('fs'), path = require('path');
  const m = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  const ds = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'desktopSession.js'), 'utf8');
  ok(/DesktopSession\.moveClone/.test(m), 'main.js 调用 moveClone（拖动期增量）');
  ok(/await measureInputBarRect\(\)[\s\S]*?DesktopSession\.reanchor/.test(m), 'main.js 也做重量校正（停手后）');
  ok(/moveClone/.test(ds) && /action: 'follow'/.test(ds), 'desktopSession 提供 moveClone');
  ok(/, 16\)/.test(m), '增量节流在 ~16ms（拖动跟手）');
  ok(/, 200\)/.test(m), '重量校正防抖 200ms（停手后校正）');
}

// ================= 场景 6：owner 归属三件套 =================
console.log('\n【场景6】owner 绑定 —— 别被当成独立程序\n');
{
  const fs = require('fs'), path = require('path');
  const h = fs.readFileSync(path.join(__dirname, '..', 'tools', 'RdpHost.Native', 'RdpHostNative.cpp'), 'utf8');
  ok(/GWLP_HWNDPARENT/.test(h), '设了 GWLP_HWNDPARENT（置顶/最小化跟随）');
  ok(/WS_EX_TOOLWINDOW/.test(h), '设了 WS_EX_TOOLWINDOW（不进任务栏/Alt+Tab）');
  ok(/ex\s*&=\s*~\(LONG\)WS_EX_APPWINDOW/.test(h), '小窗清掉 WS_EX_APPWINDOW（否则自成一体）');
  ok(/SWP_FRAMECHANGED/.test(h), '改完样式重算（任务栏/Alt+Tab 立即生效）');
}

console.log('\n================ 结论 ================');
console.log(fail === 0 ? 'PASS —— 跟随链路 4 个 bug 均已修复。' : `FAIL（${fail} 项）`);
process.exit(fail === 0 ? 0 : 1);