// 复现验证：关闭主程序窗口时的「创建窗口句柄时出错」崩溃。
//
// 为什么用「父进程看门狗」而不是造假 owner 窗口：
//   崩溃的触发条件是"窗体正在被销毁，而某个定时器回调还在摸 _rdp.Handle"。
//   HostForm.WatchOwner 走的是主窗口被关掉时**完全相同**的那条 Close() 路径
//   （"parent pid gone -> close clone" → Close() → OnFormClosing → OnFormClosed），
//   而造假 owner HWND 需要自己注册窗口类，STATIC 系统类撑不起 WS_OVERLAPPEDWINDOW 顶层窗。
//
// 做法：
//   1) 起一个"假父进程"（本脚本 spawn 的 node，sleep 到被杀）
//   2) 用 --parent-pid <假父进程 pid> 启动宿主，等它连上/至少建好句柄
//   3) 杀掉假父进程 → 宿主 1s 轮询发现 → 自己 Close()
//   4) 反复多轮 + 每轮随机时刻杀，看日志里有没有 [ui-fatal] / FATAL / 未捕获异常
//
// 用法：node scripts/test-close-race.js [轮数]
'use strict';
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE_DIR = path.join(ROOT, 'tools', 'RdpHost.Native');
const EXE = path.join(EXE_DIR, '桌面分身.exe');
const LOG = path.join(EXE_DIR, '_host_log.txt');
const STATUS = path.join(ROOT, 'tools', 'RdpHost', '_status.txt');
const CMD = path.join(ROOT, 'tools', 'RdpHost', '_rdphost_cmd.txt');
const THEME = path.join(ROOT, 'tools', 'RdpHost', '_theme.txt');

const ROUNDS = Number(process.argv[2] || 3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 宿主日志写在 exe 同目录，但被 FileShare 锁着时读不到 —— 先杀掉残留再删。
function killStrays() {
  for (const n of [STATUS, CMD]) { try { if (fs.existsSync(n)) fs.unlinkSync(n); } catch (e) { } }
  spawnSync('taskkill', ['/IM', '桌面分身.exe', '/F', '/T'], { stdio: 'ignore' });
}
function readLog() {
  try { return fs.readFileSync(LOG, 'utf8'); } catch (e) { return ''; }
}

async function waitHostLog(minLines, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const txt = readLog();
    if (txt.split('\n').length >= minLines) return txt;
    await sleep(300);
  }
  return readLog();
}

// 假父进程：等 1 小时，谁也不会真等 —— 用来给宿主一个"活着的 parent pid"。
function startFakeParent() {
  const p = spawn(process.execPath, ['-e', 'setTimeout(()=>{},3600000)'], {
    stdio: 'ignore', detached: false,
  });
  return p;
}

// 把光标移进宿主窗口：直接解析宿主自己写的 "anchor pos: X,Y win=WxH" 日志，
// 目的是让 chrome 显形动画（Reveal 的 16ms 计时器）真正跑起来 —— 否则 Reveal 从没
// Set(true) 过，关闭瞬间就撞不上「Visible=true 重建控件句柄」那条崩溃路径。
let F = null;
const koffi = (() => { try { return require(path.join(ROOT, 'node_modules', 'koffi')); } catch (e) { return null; } })();
function initFfi() {
  if (F) return F;
  if (!koffi) return null;
  try {
    const user32 = koffi.load('user32.dll');
    F = {
      SetCursorPos: user32.func('bool __stdcall SetCursorPos(int x, int y)'),
      SetThreadDpiAwarenessContext: user32.func('intptr __stdcall SetThreadDpiAwarenessContext(intptr ctx)'),
    };
    try { F.SetThreadDpiAwarenessContext(-4); } catch (e) { }
  } catch (e) { F = null; }
  return F;
}

// 把光标移到宿主窗口的指定相对位置（0..1）。
function moveTo(x, y, w, h, rx, ry) {
  if (!initFfi()) return false;
  F.SetCursorPos(Math.round(x + w * rx), Math.round(y + h * ry));
  return true;
}

// 高频跨边界扫掠光标，让 PollHover 的 inside 判定持续翻转 → Reveal 的 16ms 动画
// 一直处在"半路"状态。这才是「关闭主程序窗口」最危险的那 130ms：
// 控件正要 Visible=true 重建句柄，父窗体却已经开始销毁。
// 返回一个 stop 函数；调用后光标停在窗外。
let sweepStop = null;
function startSweep() {
  if (!initFfi()) return;
  let m = null;
  const re = /anchor pos: (-?\d+),(-?\d+) win=(\d+)x(\d+)/g;
  let t; const log = readLog();
  while ((t = re.exec(log)) !== null) m = t;
  if (!m) return;
  const [x, y, w, h] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  // 往复扫：**必须跨窗口边界**，否则 inside 恒为 true、Reveal 只启动一次就停，
  // 撞不上"淡出途中控件要 Visible=false / 淡入途中要 Visible=true"的高危相位。
  // 路径：窗内右上（✕ 区）→ 窗外下方 80px → 窗内正中（胶囊区）→ 窗外 → …
  const path = [
    [0.90, 0.08],   // 窗内 · ✕ 区域
    [0.50, 1.45],   // 窗外 · 下方
    [0.50, 0.50],   // 窗内 · 正中（胶囊）
    [0.50, 1.45],   // 窗外
    [0.10, 0.10],   // 窗内 · 左上
    [-0.35, 0.5],   // 窗外 · 左侧
  ];
  let i = 0;
  const iv = setInterval(() => {
    const p = path[i++ % path.length];
    F.SetCursorPos(Math.round(x + w * p[0]), Math.round(y + h * p[1]));
  }, 25);
  sweepStop = () => {
    clearInterval(iv);
    F.SetCursorPos(Math.round(x + w / 2), Math.round(y + h + 80)); // 移到窗外，停下
  };
}

(async () => {
  if (!fs.existsSync(EXE)) { console.error('[race] 找不到宿主 exe，请先构建：npm run prebuild（或 tools/RdpHost.Native/build-native-host.ps1）'); process.exit(1); }

  const findings = [];
  for (let round = 1; round <= ROUNDS; round++) {
    killStrays();
    try { if (fs.existsSync(LOG)) fs.unlinkSync(LOG); } catch (e) { }
    const logStartLen = 0;

    const fake = startFakeParent();
    // 给宿主一个真实存在的 anchor（逻辑像素，150% 屏），让定位逻辑也一起跑起来。
    const host = spawn(EXE, [
      '--server', 'localhost', '--desktop', '1280x720',
      '--theme', 'dark', '--accent', 'red',
      '--themeFile', THEME,
      '--small', '--nofocus',
      '--pos', '1400x900',
      '--anchor', '820,900,840,104',
      '--anchorRight', '1680',
      '--parent-pid', String(fake.pid),
      '--status', STATUS, '--cmd', CMD,
    ], { stdio: 'ignore', detached: false });

    console.log(`\n[round ${round}] 宿主 pid=${host.pid} 假父 pid=${fake.pid} — 等 3.5s 让句柄/定时器都跑起来`);
    // 真实场景里主程序窗口是在分身跑起来（hover 抓帧、RDP 重连）之后才被关的，
    // 所以这里必须等足够久，让 PollHover / GetGlassBackdrop 真的抓到过东西。
    await sleep(3500);

    // 扫掠光标（每 25ms 换一次位置，跨窗口边界 → inside 持续翻转 → Reveal 一直半路）
    startSweep();
    await sleep(900);   // 让扫掠充分跑几轮，动画反复起停
    const hovered = !!sweepStop;
    console.log(`[round ${round}] 光标扫掠 = ${hovered ? '活跃（Reveal 动画持续半路）' : '失败（FFI 不可用）'}`);

    // 关键：在扫掠**进行中**立刻关闭。抖动 0~160ms —— 正好覆盖 PollHover 一个 60ms
    // 周期 + Reveal 130ms 全程，撞上"控件正要重建句柄、窗体已开始销毁"的那一瞬。
    const jitter = Math.floor(Math.random() * 160);
    await sleep(jitter);
    console.log(`[round ${round}] 扫掠中杀掉假父进程（+${jitter}ms）→ 触发宿主 Close()`);
    try { process.kill(fake.pid, 'SIGKILL'); } catch (e) { }

    // 等宿主自己退干净
    const exited = await new Promise((resolve) => {
      const to = setTimeout(() => resolve(false), 20000);
      host.on('exit', (code, sig) => { clearTimeout(to); resolve({ code, sig }); });
    });

    const log = readLog().slice(logStartLen);
    const bad = [];
    // 必须真的翻转过 hover 状态，否则这轮没覆盖到显隐动画 → 不算有效样本。
    const inTrue = (log.match(/inside=True/g) || []).length;
    const inFalse = (log.match(/inside=False/g) || []).length;
    const flipped = inTrue > 0 && inFalse > 0;
    if (!flipped) bad.push(`hover-flip-miss(True=${inTrue},False=${inFalse})`);
    if (/\[ui-fatal\]/.test(log)) bad.push('ui-fatal');
    if (/\[fatal\]/.test(log)) bad.push('fatal');
    if (/创建窗口句柄时出错/.test(log)) bad.push('handle-error-text');
    if (/Unhandled exception/.test(log)) bad.push('unhandled');
    if (/FATAL:/.test(log)) bad.push('FATAL:');
    // 正常关闭必须有 form closed；没有说明是崩了（被强杀）
    const closedClean = /form closed/.test(log);
    if (!closedClean) bad.push('no-clean-close');

    console.log(`[round ${round}] 退出=${JSON.stringify(exited)} 干净关闭=${closedClean} hover翻转=${inTrue}/${inFalse} 问题=${bad.length ? bad.join(',') : '无'}`);
    console.log('  --- 日志关键行 ---');
    log.split('\n')
      .filter((l) => /close|closing|OnFormClosed|parent pid|owner|ui-fatal|fatal|FATAL|Unhook|logout|dispose|Dispose|error|Error/.test(l))
      .slice(-25)
      .forEach((l) => console.log('  ' + l));

    findings.push({ round, exited, closedClean, bad });
    try { if (sweepStop) sweepStop(); } catch (e) { }
    try { process.kill(host.pid, 'SIGKILL'); } catch (e) { }
    await sleep(1200);
  }

  console.log('\n================ 结论 ================');
  let fail = 0;
  for (const f of findings) {
    const ok = f.closedClean && f.bad.length === 0;
    if (!ok) fail++;
    console.log(`  round ${f.round}: ${ok ? 'PASS' : 'FAIL (' + f.bad.join(',') + ')'}`);
  }
  console.log(fail === 0
    ? `全部 ${ROUNDS} 轮关闭无崩溃。`
    : `${fail}/${ROUNDS} 轮仍有问题，见上方日志。`);
  process.exit(fail === 0 ? 0 : 1);
})();