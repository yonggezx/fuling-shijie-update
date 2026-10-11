// desktopSession.js —— 浮灵饰界 · 桌面分身（RDP Child Session）主进程编排
// -----------------------------------------------------------------------------
// 方案：悬浮预览小窗（进程不分离，桌面分身是主程序的一部分）。
//   1) 由主进程 spawn 统一启停，不占任务栏独立程序位（C# 侧 ShowInTaskbar=false），退出不残留。
//   2) 启动形态 = 悬浮预览小窗（RdpHost --small，内容宽 SMALL_W=280，**无标题栏**）：
//      右对齐贴在主程序输入栏上方（--anchor 传输入栏屏幕矩形），是纯预览（鼠标点不到画面），
//      右上角自绘 ✕ 关闭，单击剥离成独立大窗。
//   3) 单击小窗剥离成独立大窗（自绘标题栏 + 「—」收回小窗 + 「✕」关闭），
//      再双击标题栏/点「—」回到小窗：同一 RdpHost 实例切换尺寸，RDP 连接不断。
//   4) 两种形态的 ✕ 都关闭整个桌面分身（RdpHost 退出 + 子会话注销）。
//   5) 渲染端不再有嵌入画面卡片、不再抓帧预览，只保留轻量状态指示（desktop:state）。
// 机制（BetterGI 同款 Child Session）：
//   - 一次性注册最高权限计划任务 FulingElevated（首次弹一次 UAC，之后静默）
//   - 主进程直接 spawn RdpHost（--small --pos ... --status ... --cmd ...）连接本机 WTS Child Session
//   - 轮询状态文件拿到 HWND；停止时写停止指令文件，等待进程退出，兜底强杀后注销子会话
'use strict';
const { execFile } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
// 打包态需要从 electron 拿到 app（判断 isPackaged / 资源路径）；测试环境用桩件，缺 app 不影响。
const _electron = require('electron');
const { screen, clipboard } = _electron;
const _app = _electron.app || null;
const childSession = require('./childSession');
const ConfigManager = require('./configManager');

const ROOT = path.resolve(__dirname, '..', '..');

// 桌面分身运行时数据文件（状态/HWND/主题/停止/提权指令）落盘目录：
//  - 开发态：项目内 tools/RdpHost（可读写）
//  - 打包态：asar 里的 resources/app 是只读的，不能往里写状态文件；改用系统临时目录
//    （os.tmpdir() === 用户 $env:TEMP，提权计划任务同用户运行也能读到，且一定可写）
const RDP_DIR = (_app && _app.isPackaged)
  ? path.join(os.tmpdir(), 'fuling-rdp-clone')
  : path.join(ROOT, 'tools', 'RdpHost');
// 桌面分身宿主进程：tools/RdpHost.Native 的原生 Win32 构建输出（纯 Win32 + COM，无 .NET 依赖）。
// 进程名就叫「桌面分身」—— 用户在任务管理器里看到的是它，不能出现 RdpHost/rdp 字样。
// （目录名 RdpHost.Native 只是内部实现，用户看不到。）
const HOST_EXE_NAME = '桌面分身.exe';
// 宿主构建产物相对路径（原生可执行文件，必须作为真实文件落在磁盘上，不能塞进 asar）
const HOST_EXE_REL = path.join('tools', 'RdpHost.Native', HOST_EXE_NAME);
// 解析宿主 exe 绝对路径：
//  - 打包态：electron-builder 把宿主经 asarUnpack 解到 resources/app.asar.unpacked/ 下（保持相对路径），
//    即 process.resourcesPath/app.asar.unpacked/...；找不到再兜底 resources/...。
//  - 开发态：项目内 tools/RdpHost.Native/桌面分身.exe
function resolveHostExe() {
  if (_app && _app.isPackaged) {
    const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', HOST_EXE_REL);
    if (fs.existsSync(unpacked)) return unpacked;
    const inResources = path.join(process.resourcesPath, HOST_EXE_REL);
    if (fs.existsSync(inResources)) return inResources;
  }
  return path.join(ROOT, HOST_EXE_REL);
}
const EXE = resolveHostExe();
const ARGS_FILE = path.join(RDP_DIR, '_rdphost_args.txt');
const STATUS_FILE = path.join(RDP_DIR, '_status.txt');
const THEME_FILE = path.join(RDP_DIR, '_theme.txt');
const CMD_FILE = path.join(RDP_DIR, '_elevated_cmd.txt');   // run-elevated.ps1 读的指令
const STOP_FILE = path.join(RDP_DIR, '_rdphost_cmd.txt');   // 分身宿主自身停止轮询文件
const INPUT_PORT_FILE = path.join(RDP_DIR, '_input_port.txt'); // 分身宿主的 AI 输入注入服务端口
const TASK = 'FulingElevated'; // 通用静默提权任务（一次注册，之后所有提权操作都静默）
const REGISTER_PS1 = (_app && _app.isPackaged)
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'tools', 'register-rdp-elevation.ps1')
  : path.join(ROOT, 'tools', 'register-rdp-elevation.ps1');

// 远程桌面分辨率（RDP 连接的源分辨率，小窗/大窗按此比例等比缩放）
const DESKTOP_W = 1280;
const DESKTOP_H = 720;
// 悬浮预览小窗（默认形态）：RdpHost --small，280 内容宽，无标题栏，贴在主程序输入栏上方悬浮
const SMALL_W = 280;
// 大窗（双击小窗剥离出来的独立窗口）：RdpHost 放大到 LARGE_W 内容区宽度，同一实例切换、连接不断
const LARGE_W = 1024;
// 预览小窗与输入栏之间的间距（逻辑像素）
const ANCHOR_GAP = 10;
// 拿不到渲染端实测矩形时的兜底：主程序输入栏（工具行 + 输入框 + 下边距）估算高度（逻辑像素）
const INPUT_BAR_H_FALLBACK = 104;
// 悬浮窗贴屏幕右缘/顶部的安全边距（仅在完全没有锚点时用）
const EDGE_MARGIN = 16;
// running 状态下轮询状态文件的间隔（ms）：感知用户点 × 关闭 / 连接失败
const STATE_POLL_MS = 2500;
// 按主题取 logo 绝对路径（--logo 参数；RdpHost 标题栏左上角 logo）
const LOGO_BY_THEME = {
  dark: path.join(ROOT, 'assets', 'icons', 'logo-pink.png'),
  light: path.join(ROOT, 'assets', 'icons', 'logo.png')
};

let _state = 'idle';
let _hwnd = 0;
let _startedAt = 0;
let _lastPos = null;             // 最近一次给宿主的初始位置 {x,y,winW,winH}
let _pageVisible = true;         // 主程序「AI 对话页」是否可见（预览小窗只在对话页展示）
let _child = null;               // spawn 出的 RdpHost 子进程引用（用于统一启停/兜底强杀）
let _stateTimer = null;          // running 状态轮询 STATUS_FILE 的定时器
let _sendToRenderer = () => {};  // 由 main.js 注入的渲染端发送函数

function exec(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 确保运行时数据目录存在且可写（打包态落在临时目录，需自建；缺失会导致状态/主题文件写不进去） */
function ensureRdpDir() {
  try { if (!fs.existsSync(RDP_DIR)) fs.mkdirSync(RDP_DIR, { recursive: true }); } catch (e) {}
}

/** 由 main.js 注入渲染端发送通道（desktop:state 广播） */
function configure({ send } = {}) {
  if (typeof send === 'function') _sendToRenderer = send;
}

/** 向渲染端广播一次桌面分身状态 */
function broadcastState(extra = {}) {
  try {
    _sendToRenderer('desktop:state', {
      state: _state,
      hwnd: _hwnd,
      error: extra.error != null ? extra.error : null,
      pos: extra.pos != null ? extra.pos : _lastPos
    });
  } catch (e) { /* 渲染端未就绪，忽略 */ }
}

/** 计划任务是否已注册 */
async function isTaskRegistered() {
  const r = await exec('schtasks', ['/query', '/tn', TASK]);
  return r.ok && new RegExp(TASK).test(r.stdout);
}

/** 确保任务已注册（未注册则提权注册一次，触发一次 UAC） */
async function ensureRegistered() {
  if (await isTaskRegistered()) {
    // dev→打包升级后，计划任务的动作可能仍指向旧安装位置的 run-elevated.ps1（只读/已删），
    // 那时 launchInSession 走提权通道会静默失败。动作路径变了就覆盖重注册。
    const wrapper = REGISTER_PS1.replace(/register-rdp-elevation\.ps1$/i, 'run-elevated.ps1');
    const norm = (s) => String(s || '').replace(/\\/g, '/').toLowerCase();
    const q = await exec('schtasks', ['/query', '/tn', TASK, '/fo', 'LIST', '/v']);
    if (q.ok && norm(q.stdout).includes(norm(wrapper))) {
      return { success: true, registered: true };
    }
    // 落到下面重新注册（Register-ScheduledTask -Force 覆盖）
  }
  const script = REGISTER_PS1;
  const r = await exec('powershell', [
    '-NoProfile', '-Command',
    `Start-Process powershell -Verb RunAs -NoProfile -ExecutionPolicy Bypass -File "${script}"`
  ]);
  // 等 UAC 接受 + 注册完成
  for (let i = 0; i < 20; i++) {
    if (await isTaskRegistered()) return { success: true, registered: true };
    await sleep(500);
  }
  return { success: false, registered: false, note: '授权未完成（可能是 UAC 未确认）' };
}

/**
 * 计算悬浮预览小窗的锚点矩形（屏幕逻辑像素）= 主程序输入栏的位置。
 * 小窗是**浮在消息上层的 overlay**（不参与渲染端布局、不占用任何区域），
 * 落点规则是「底边贴输入栏顶边（隔 ANCHOR_GAP）、右缘紧贴主窗口右边框」——
 * 视觉上"挂在输入框上方"，与 AI 对话页面形成上下关系（用户要的整体感）。
 *
 * 优先用渲染端实测的输入栏矩形（opts.anchorRect，最准）；
 * 没有就按主窗口 bounds 估算 —— 输入栏永远贴窗口底部、横跨整宽，
 * 取底部一条高 INPUT_BAR_H_FALLBACK 的横条就够（AI 侧调用没有渲染端测量值，走这条）。
 *
 * @param {{x,y,width,height}} winBounds 主窗口 bounds（DIP，屏幕坐标）
 * @param {{x,y,width,height}} [anchorRect] 渲染端实测的输入栏屏幕矩形（DIP）
 * @returns {{x,y,width,height,right,source}|null}
 */
function computeAnchor(winBounds, anchorRect) {
  // 主窗口右边缘：小窗"始终最右边紧贴着右边框展示"（用户要求）—— 水平方向以它为准，
  // 而不是输入栏的右缘（输入栏通常还有内边距，贴不到窗口边框）。
  const right = (winBounds && Number.isFinite(winBounds.x) && Number.isFinite(winBounds.width))
    ? Math.round(winBounds.x + winBounds.width)
    : null;
  if (anchorRect
    && Number.isFinite(anchorRect.width) && anchorRect.width > 0
    && Number.isFinite(anchorRect.height) && anchorRect.height > 0) {
    return {
      x: Math.round(anchorRect.x),
      y: Math.round(anchorRect.y),
      width: Math.round(anchorRect.width),
      height: Math.round(anchorRect.height),
      right,
      source: 'renderer'
    };
  }
  if (!winBounds || !Number.isFinite(winBounds.width) || winBounds.width <= 0) return null;
  const h = Math.max(40, Math.min(INPUT_BAR_H_FALLBACK, Math.round(winBounds.height * 0.2)));
  return {
    x: Math.round(winBounds.x),
    y: Math.round(winBounds.y + winBounds.height - h),
    width: Math.round(winBounds.width),
    height: h,
    right,
    source: 'estimate'
  };
}

/**
 * 兜底摆放估算（仅用于状态上报；真正的定位在 RdpHost 侧按 --anchor 算）。
 *
 * 为什么定位不在这里做：只有 RdpHost 知道自己的真实外框尺寸（含 WS_THICKFRAME 边框、
 * DPI 换算），主进程要自己算就得复制一份"边框多宽"的知识，两边一旦不同步，
 * 小窗就会压住输入栏或飘到别处。所以主进程只负责给出锚点矩形。
 *
 * 预览小窗已去掉系统标题栏，高度就是画面高（不再加 CHROME_H）。
 */
function computePos(winBounds, anchorRect) {
  let area;
  try { area = screen.getPrimaryDisplay().workArea; }
  catch (e) { area = { x: 0, y: 0, width: 1920, height: 1080 }; }
  const winW = SMALL_W;
  const winH = Math.round(SMALL_W * DESKTOP_H / DESKTOP_W); // 280 * 720/1280 = 158（无标题栏）
  const anchor = computeAnchor(winBounds, anchorRect);
  let x, y;
  if (anchor) {
    // 底边贴输入栏顶边（隔 ANCHOR_GAP）：悬浮窗**浮在消息上层**，不占用任何布局区域；
    // 水平方向右缘紧贴主窗口右边框（与 RdpHost 的 ApplyAnchorPosition 同规则）
    x = (anchor.right || (anchor.x + anchor.width)) - winW;
    y = anchor.y - ANCHOR_GAP - winH;
  } else {
    // 完全没锚点：退回屏幕右侧垂直居中
    x = area.x + area.width - EDGE_MARGIN - winW;
    y = area.y + area.height / 2 - winH / 2;
  }
  x = Math.round(Math.min(Math.max(x, area.x + EDGE_MARGIN), area.x + area.width - winW - EDGE_MARGIN));
  y = Math.round(Math.min(Math.max(y, area.y + EDGE_MARGIN), area.y + area.height - winH - EDGE_MARGIN));
  return { x, y, winW, winH, anchor };
}

function readStatus() {
  try {
    const s = fs.readFileSync(STATUS_FILE, 'utf8').trim();
    if (!s) return { stage: 'no-status' };
    // ★ 宿主是「追加写」状态机：connecting → connected → HWND n → closing → closed。
    //   必须看最后一行，而不是开头 —— 否则永远停在第一行 "STATE connecting"，
    //   主进程轮询到超时误报「连接失败」，可分身其实早已连上（窗口都出来了）。
    const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const last = lines[lines.length - 1];
    const m = last.match(/^HWND (\d+)/);
    if (m) return { stage: 'connected', hwnd: Number(m[1]) };
    if (/^STATE connecting/.test(last)) return { stage: 'connecting' };
    if (/^STATE failed\|(.*)/.test(last)) return { stage: 'failed', msg: last.replace(/^STATE failed\|/, '') };
    if (/^STATE closed/.test(last)) return { stage: 'closed' };
    return { stage: 'idle', raw: last };
  } catch (e) {
    return { stage: 'no-status' };
  }
}

/**
 * 扫描整个状态文件，返回最近一次出现的 HWND（0 = 从未连上）。
 * 为什么需要它：宿主 RDP 连上（写 HWND n）后，若发生一次瞬时断开重连，onDisconnect
 * 会再**追加**写一行 "STATE failed|RDP 连接断开:..."。此时最后一行是 failed，但会话
 * 其实早已建立、窗口已起来、马上重连成功——只读最后一行会误判「启动失败」。
 * 启动轮询用本函数兜底：只要出现过 HWND，就视为已就绪，不被那行断开盖掉。
 * 注意：运行态轮询（startStatePolling）仍用 readStatus 看最后一行，以便感知 × 关闭。
 */
function readAnyHwnd() {
  try {
    const s = fs.readFileSync(STATUS_FILE, 'utf8').trim();
    if (!s) return 0;
    let hwnd = 0;
    for (const l of s.split(/\r?\n/)) {
      const mm = l.trim().match(/^HWND (\d+)/);
      if (mm) hwnd = Number(mm[1]);
    }
    return hwnd;
  } catch (e) {
    return 0;
  }
}

/** 停止 running 状态轮询定时器 */
function stopStatePolling() {
  if (_stateTimer) {
    clearInterval(_stateTimer);
    _stateTimer = null;
  }
}

/** 启动 running 状态轮询：感知用户点 × 关闭（STATE closed）或连接失败（STATE failed|...） */
function startStatePolling() {
  stopStatePolling();
  _stateTimer = setInterval(() => {
    if (_state !== 'running') { stopStatePolling(); return; }
    let st;
    try { st = readStatus(); } catch (e) { return; /* 文件读异常忽略 */ }
    if (!st) return;
    if (st.stage === 'closed') {
      // 用户点了悬浮窗/大窗的 ×：RdpHost 已退出，界面切回「断开」
      _state = 'idle'; _hwnd = 0;
      stopStatePolling();
      broadcastState();
    } else if (st.stage === 'failed') {
      _state = 'error';
      stopStatePolling();
      broadcastState({ error: st.msg });
    }
  }, STATE_POLL_MS);
}

/**
 * 启动桌面分身（默认形态：贴输入栏上方的悬浮预览小窗，无标题栏）。
 * @param {{winBounds?: {x,y,width,height}, anchorRect?: {x,y,width,height},
 *          ownerHwnd?: (string|number), theme?: string, accent?: string}} opts
 *   anchorRect = 渲染端实测的主程序输入栏屏幕矩形（DIP）。不传则按 winBounds 估算。
 *   ownerHwnd  = 主程序主窗口的原生句柄。传了就把它设成分身窗口的 Win32 owner：
 *                分身恒在主窗口之上，且主窗口销毁/最小化时跟着走（用户要求"和主程序绑定"）。
 */
async function start(opts = {}) {
  if (_state === 'running') {
    broadcastState();
    return { success: true, state: 'running', hwnd: _hwnd };
  }
  // 启动前先清掉可能残留的旧分身进程（主程序上次被强杀等情况），避免多实例
  try { await exec('taskkill', ['/IM', HOST_EXE_NAME, '/F', '/T']); } catch (e) {}
  ensureRdpDir(); // 运行时数据目录（状态/主题/停止文件）需可写
  await sleep(300);
  const pos = computePos(opts.winBounds, opts.anchorRect);
  _lastPos = pos;
  const sys = (ConfigManager.getConfig && ConfigManager.getConfig().system) || {};
  const theme = opts.theme || sys.theme || 'dark';
  const accent = opts.accent || sys.accent || 'red';
  const logoPath = LOGO_BY_THEME[theme] || LOGO_BY_THEME.dark;
  const args = [
    '--server', 'localhost',
    '--desktop', `${DESKTOP_W}x${DESKTOP_H}`,
    '--theme', theme,
    '--accent', accent,
    '--themeFile', THEME_FILE,
    '--small',                         // 启动形态：悬浮预览小窗（无标题栏，贴输入栏上方）
    '--nofocus',                       // 启动不抢焦点
    '--logo', logoPath,                // 按当前主题传 logo 绝对路径
    '--pos', `${pos.x}x${pos.y}`,      // 兜底落点（锚点不可用时用）
    // 绑定主程序：owner 窗口句柄 + 父进程 PID。宿主侧据此把窗口设成 owner 关系，
    // 并用看门狗盯着父进程 —— 主程序一关，分身自己收尾（Close 会注销 RDP 子会话）。
    '--owner', String(opts.ownerHwnd || 0),
    '--parent-pid', String(process.pid),
    // AI 对话页是否可见：不可见就以隐藏态启动（后台跑着，切回对话页才显示出来）
    '--pageVisible', _pageVisible ? '1' : '0'
  ];
  // --anchor：主程序输入栏的屏幕矩形。宿主据此自我定位（贴其上方 + 右缘紧贴窗口右边框），
  // 它自己算才准 —— 只有它知道自己的真实外框尺寸（含边框、DPI 换算）。
  if (pos.anchor) args.push('--anchor', `${pos.anchor.x},${pos.anchor.y},${pos.anchor.width},${pos.anchor.height}`);
  if (pos.anchor && pos.anchor.right) args.push('--anchorRight', String(pos.anchor.right));
  args.push('--status', STATUS_FILE, '--cmd', STOP_FILE);
  // 启动时把当前主题写入 theme 文件（宿主启动即读到，之后主程序改主题再覆盖）
  try { fs.writeFileSync(THEME_FILE, `theme:${theme} accent:${accent}`, { encoding: 'utf8' }); } catch (e) {}
  // 直接非提权启动：子会话已启用时连接不需要提权，窗口必然显示在用户桌面。
  try { if (fs.existsSync(STATUS_FILE)) fs.unlinkSync(STATUS_FILE); } catch (e) {}
  try { if (fs.existsSync(STOP_FILE)) fs.unlinkSync(STOP_FILE); } catch (e) {}
  try {
    const { spawn } = require('child_process');
    // detached + unref：主程序异常退出时宿主不会立刻被带走，改由宿主自己的看门狗
    // （--parent-pid）负责收尾 —— 这样即使主程序被强杀，宿主也能优雅 Close 并注销子会话，
    // 而不是被连带杀死留下一个孤儿子会话。
    _child = spawn(EXE, args, { detached: true, stdio: 'ignore' });
    _child.unref();
  } catch (e) {
    _child = null;
    _state = 'error';
    broadcastState({ error: '启动桌面分身失败: ' + e.message });
    return { success: false, error: '启动桌面分身失败: ' + e.message };
  }

  _state = 'starting';
  _startedAt = Date.now();
  broadcastState({ pos });
  const deadline = Date.now() + 75000; // 最长等 75s
  while (Date.now() < deadline) {
    const st = readStatus();
    // 窗口被 × 关闭 / 宿主退出：直接失败（不再看 HWND 历史行）
    if (st.stage === 'closed') {
      _state = 'idle';
      stopStatePolling();
      broadcastState();
      return { success: false, error: '桌面分身窗口已关闭' };
    }
    // ★ 只要状态文件里出现过任意一行 HWND n，就说明 RDP 已登录成功、分身窗口已起来。
    //   即使最后一行是 "STATE failed|RDP 连接断开"（连上后瞬时断开重连），也不能据此判失败——
    //   否则就是「分身明明打开了，工具却报失败」。连上后断开的那行会被重连后的新 HWND 行覆盖。
    const anyHwnd = st.stage === 'connected' ? st.hwnd : readAnyHwnd();
    if (anyHwnd) {
      _state = 'running'; _hwnd = anyHwnd;
      // 悬浮窗自身直接显示 RDP 画面，渲染端只保留状态指示；启动 running 轮询感知 × 关闭
      startStatePolling();
      broadcastState({ pos });
      return { success: true, state: 'running', hwnd: anyHwnd, pos };
    }
    if (st.stage === 'failed') {
      // 从未出现过 HWND 的真·启动失败（onFatal / onLogonError）
      _state = 'error';
      stopStatePolling();
      broadcastState({ error: st.msg });
      return { success: false, error: st.msg };
    }
    await sleep(1200);
  }
  _state = 'error';
  stopStatePolling();
  broadcastState({ error: '连接超时（子会话未能建立）' });
  return { success: false, error: '连接超时（子会话未能建立）' };
}

/**
 * 主题实时联动：主程序改主题/强调色时调用，把新主题写入 theme 文件，正在运行的 RdpHost 轮询到即重绘。
 */
async function applyTheme(theme = 'dark', accent = 'red') {
  ensureRdpDir();
  try { fs.writeFileSync(THEME_FILE, `theme:${theme} accent:${accent}`, { encoding: 'utf8' }); return { success: true }; }
  catch (e) { return { success: false, error: e.message }; }
}

/**
 * 往隔离桌面（Child Session）静默启动一个程序（BetterGI 同款临时任务+RunEx）。
 * 全程无 UAC：提权动作由通用任务 FulingElevated 完成。
 */
async function launchInSession(program, args = '', workDir = '') {
  ensureRdpDir();
  const g = childSession.getSessionId();
  if (!g.success || g.sessionId == null) return { success: false, error: '无活动子会话（请先启动桌面分身）' };
  if (typeof program !== 'string' || !program.trim()) return { success: false, error: '需要 program 路径' };
  const sid = g.sessionId;
  // 确保已注册通用任务
  const reg = await ensureRegistered();
  if (!reg.success) return { success: false, error: reg.note || '授权注册失败' };
  const cmd = ['launch', String(sid), program.replace(/\|/g, ''), String(args || ''), String(workDir || '')].join('|');
  try { fs.writeFileSync(CMD_FILE, cmd, { encoding: 'utf8' }); } catch (e) { return { success: false, error: '写指令失败: ' + e.message }; }
  const r = await exec('schtasks', ['/run', '/tn', TASK]);
  if (!r.ok) return { success: false, error: r.stderr };
  return { success: true, sessionId: sid };
}

/**
 * 停止桌面分身：写停止指令 → 等进程退出（兜底强杀）→ 注销子会话，确保不残留。
 * @param {{graceMs?: number}} [opts] graceMs = 等宿主自行退出的最长时间（默认 7s）。
 *   退出流程里要短（几百 ms）：主程序都要关了，不能为它卡住退出。
 */
async function stop(opts = {}) {
  const graceMs = Number.isFinite(opts.graceMs) ? Math.max(0, opts.graceMs) : 7000;
  stopStatePolling();
  // 1) 先写停止指令，让宿主自行注销子会话并退出
  try { fs.writeFileSync(STOP_FILE, 'stop', { encoding: 'utf8' }); } catch (e) {}
  // 2) 等待进程退出：轮询 _child.exitCode != null 或 STATUS_FILE 消失
  const deadline = Date.now() + graceMs;
  let exited = false;
  while (Date.now() < deadline) {
    if (_child && _child.exitCode != null) { exited = true; break; }
    let statusGone = false;
    try { statusGone = !fs.existsSync(STATUS_FILE); } catch (e) { statusGone = true; }
    if (statusGone) { exited = true; break; }
    await sleep(120);
  }
  // 3) 超时仍未退出：兜底强杀
  if (!exited && _child) {
    try { _child.kill(); } catch (e) {}
    await sleep(300);
    if (_child.exitCode == null && _child.pid) {
      try { await exec('taskkill', ['/PID', String(_child.pid), '/T', '/F']); } catch (e) {}
    }
  }
  // 3b) 连子进程引用都没有（本次运行没启动过、或引用丢了）也按进程名清一遍：
  //     退出路径必须保证不留孤儿分身进程。
  if (!exited && !_child) {
    try { await exec('taskkill', ['/IM', HOST_EXE_NAME, '/F', '/T']); } catch (e) {}
  }
  // 4) 兜底注销子会话（无论是否正常退出）
  try { childSession.logoff(false); } catch (e) {}
  stopStatePolling();
  _state = 'idle'; _hwnd = 0; _child = null;
  broadcastState();
  return { success: true };
}

// ---- AI 输入注入到悬浮窗桌面分身（不移动/不点击真实桌面鼠标）----
// RdpHost 用 RDP 客户端的 SendMouseEvent/SendKeyboardEvent 把输入直接注入到隔离子会话，
// 真实桌面鼠标不动、前台不切换。坐标 = 悬浮窗客户区像素（与悬浮窗画面一致）。

const KEY_VK = {
  ctrl: 17, control: 17, alt: 18, shift: 16, win: 91, meta: 91, cmd: 91,
  enter: 13, return: 13, '\n': 13, space: 32, ' ': 32, tab: 9, backspace: 8,
  escape: 27, esc: 27, delete: 46, del: 46, insert: 45, ins: 45, home: 36, end: 35,
  pageup: 33, pagedown: 34, up: 38, down: 40, left: 37, right: 39,
  capslock: 20, caps: 20, numlock: 144, scrolllock: 145,
  ';': 186, '=': 187, ',': 188, '-': 189, '.': 190, '/': 191, '`': 192,
  '[': 219, '\\': 220, ']': 221, "'": 222
};

function toVk(key) {
  if (key == null) return 0;
  if (typeof key === 'number') return Math.floor(key);
  const s = String(key).toLowerCase();
  if (KEY_VK[s]) return KEY_VK[s];
  if (/^[a-z]$/.test(s)) return s.charCodeAt(0) - 32 + 64;   // a-z → 65-90
  if (/^[0-9]$/.test(s)) return s.charCodeAt(0);             // 0-9 → 48-57
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(s)) return 112 + (parseInt(s.slice(1), 10) - 1);
  return 0;
}

/**
 * 向悬浮窗桌面分身发送一组输入动作（AI 操作悬浮窗里的程序，不移动真实桌面鼠标）。
 * @param {Array|Object} actions 语义动作，与 control_computer 一致：
 *   move/click/left_click/right_click/double_click/mouse_down/mouse_up/scroll/press/hotkey/type/paste
 */
async function sendInput(actions) {
  if (_state !== 'running') {
    return { success: false, error: '桌面分身未运行。请先 ensure_clone_desktop 打开悬浮窗（再 launch_in_clone 启动程序）。', needLaunch: true, mode: 'childSession' };
  }
  let port = 0;
  try { port = Number(String(fs.readFileSync(INPUT_PORT_FILE, 'utf8')).trim()); } catch (e) {}
  if (!port || !Number.isInteger(port) || port <= 0) {
    return { success: false, error: '悬浮窗输入通道未就绪（桌面分身宿主未暴露输入端口）', mode: 'childSession' };
  }
  const list = Array.isArray(actions) ? actions : [actions];
  const lines = [];
  for (const a of list) {
    if (!a || typeof a.action !== 'string') continue;
    const button = a.button || (a.action === 'right_click' ? 'right' : 'left');
    switch (a.action) {
      case 'move':
        lines.push(JSON.stringify({ action: 'move', x: Math.round(a.x ?? 0), y: Math.round(a.y ?? 0) }));
        break;
      case 'click':
      case 'left_click':
        lines.push(JSON.stringify({ action: 'click', x: Math.round(a.x ?? 0), y: Math.round(a.y ?? 0), button: 'left' }));
        break;
      case 'right_click':
        lines.push(JSON.stringify({ action: 'click', x: Math.round(a.x ?? 0), y: Math.round(a.y ?? 0), button: 'right' }));
        break;
      case 'double_click':
        lines.push(JSON.stringify({ action: 'dblclick', x: Math.round(a.x ?? 0), y: Math.round(a.y ?? 0), button }));
        break;
      case 'mouse_down':
        lines.push(JSON.stringify({ action: 'down', x: Math.round(a.x ?? 0), y: Math.round(a.y ?? 0), button }));
        break;
      case 'mouse_up':
        lines.push(JSON.stringify({ action: 'up', x: Math.round(a.x ?? 0), y: Math.round(a.y ?? 0), button }));
        break;
      case 'scroll':
        lines.push(JSON.stringify({ action: 'scroll', x: Math.round(a.x ?? 0), y: Math.round(a.y ?? 0), delta: Math.round(a.delta ?? 0) }));
        break;
      case 'press': {
        const k = toVk(a.key ?? a.code ?? 13) || 13;
        lines.push(JSON.stringify({ action: 'key', code: k, up: false }));
        lines.push(JSON.stringify({ action: 'key', code: k, up: true }));
        break;
      }
      case 'hotkey': {
        const keys = (Array.isArray(a.keys) ? a.keys : []).map(toVk).filter((k) => k > 0);
        if (keys.length) lines.push(JSON.stringify({ action: 'hotkey', keys }));
        break;
      }
      case 'type':
      case 'paste': {
        // 文字输入用剪贴板 + Ctrl+V 注入最稳（RDP 注入逐字转 scan code 对中文易错）
        const text = String(a.text != null ? a.text : '');
        if (text) { try { clipboard.writeText(text); } catch (e) {} }
        lines.push(JSON.stringify({ action: 'hotkey', keys: [17, 86] })); // Ctrl+V
        break;
      }
      default:
        break;
    }
  }
  if (!lines.length) return { success: false, error: '无可发送的输入动作', mode: 'childSession' };
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    let sock;
    try { sock = net.connect({ host: '127.0.0.1', port }); } catch (e) { return finish({ success: false, error: e.message, mode: 'childSession' }); }
    sock.on('connect', () => sock.end(lines.join('\n') + '\n'));
    sock.on('error', (e) => finish({ success: false, error: '悬浮窗输入通道连接失败: ' + e.message, mode: 'childSession' }));
    sock.on('close', () => finish({ success: true, sent: lines.length, mode: 'childSession' }));
    sock.setTimeout(3000, () => { try { sock.destroy(); } catch (e) {} });
  });
}

/**
 * 往宿主发一条控制命令（复用本地 TCP 输入通道）。
 * 宿主没在跑 / 通道没就绪就静默跳过 —— 这些是"锦上添花"的同步，不该影响主流程。
 */
async function sendControlLine(obj) {
  if (_state !== 'running') return { success: false, skipped: true };
  let port = 0;
  try { port = Number(String(fs.readFileSync(INPUT_PORT_FILE, 'utf8')).trim()); } catch (e) {}
  if (!port || !Number.isInteger(port) || port <= 0) return { success: false, error: '输入通道未就绪' };
  const line = JSON.stringify(obj);
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    let sock;
    try { sock = net.connect({ host: '127.0.0.1', port }); } catch (e) { return finish({ success: false, error: e.message }); }
    sock.on('connect', () => sock.end(line + '\n'));
    sock.on('error', (e) => finish({ success: false, error: e.message }));
    sock.on('close', () => finish({ success: true }));
    sock.setTimeout(2000, () => { try { sock.destroy(); } catch (e) {} });
  });
}

/**
 * 主程序窗口移动/缩放时，把新的输入栏矩形推给正在运行的宿主，让它重新锚定预览小窗。
 * 这就是"预览窗和聊天界面绑定"：小窗跟着聊天窗口走，而不是钉在屏幕上。
 * 坐标是屏幕 DIP，宿主内部按自己的 DPI 换算。
 */
async function reanchor(anchorRect) {
  if (!anchorRect) return { success: false, skipped: true };
  return sendControlLine({
    action: 'anchor',
    x: Math.round(anchorRect.x), y: Math.round(anchorRect.y),
    w: Math.round(anchorRect.width), h: Math.round(anchorRect.height),
    right: anchorRect.right ? Math.round(anchorRect.right) : 0
  });
}

/**
 * 主窗口**拖动过程中**的快速跟随：只推位移增量，让小窗严丝合缝地贴着走。
 *
 * 为什么不复用 reanchor：
 *   reanchor 要主进程先 executeJavaScript 问渲染端量输入栏矩形（IPC 往返 + 页面求值），
 *   拖动时这个延迟有几十毫秒 → 小窗明显滞后，看着就像"两个独立程序各走各的"。
 *   而拖动时**输入栏相对主窗口的位置根本不变**，变的只有主窗口原点 ——
 *   所以增量平移就够了，不用重量。
 *
 * dw/dh 同样要传：缩放时输入栏宽度会变，只传 dx/dy 会导致右缘对不齐。
 * 增量之后宿主会 clamp 到工作区，越界时最多丢一点位移，不会飞出屏幕。
 */
async function moveClone(dx, dy, dw, dh) {
  if (_state !== 'running') return { success: false, skipped: true };
  if (!dx && !dy && !dw && !dh) return { success: true, skipped: true };
  return sendControlLine({
    // ⚠️ 动作名必须叫 'follow'，不能叫 'move' —— 宿主那边 'move' 是「注入到 RDP 会话的
    // 鼠标移动」指令（case "move" → SendMouseEvent）。同名会让窗口跟随和远程鼠标移动串台。
    action: 'follow',
    x: Math.round(dx), y: Math.round(dy),
    w: Math.round(dw), h: Math.round(dh)
  });
}

/**
 * 通知宿主"AI 任务是否在跑"。
 * 用户要求："目前主程序点击 x 会直接关闭销毁，但是当有任务运行时不会关闭，会在后台运行" ——
 * 宿主收到 taskRunning=true 后，即使主窗口被销毁也只隐藏、不销毁，等任务结束（agent-done → stop）
 * 或主程序整个退出（--parent-pid 看门狗）才收尾。
 */
async function setTaskRunning(on) {
  return sendControlLine({ action: 'taskRunning', on: !!on });
}

/**
 * 主程序「AI 对话页」是否可见：预览小窗**只在对话页展示**。
 * 传 false 只是隐藏（Hide）—— RDP 会话、子窗口、进程全都保留，连接不断，
 * 切回对话页立刻能再看到画面；真正结束只有两条路：AI 任务跑完（主进程发 stop）或用户点 ✕。
 * 用户明确要求："关闭页面不销毁，托盘运行直到 AI 跑完或我点关闭"。
 */
async function setVisible(on) {
  _pageVisible = !!on;
  return sendControlLine({ action: 'visible', on: _pageVisible });
}

/**
 * 抓分身宿主窗口的画面（PrintWindow 抓 RdpHost 窗口 = 隔离子会话实时画面）。
 * 分身运行中、AI 需要"看到"自己在分身里做了什么时用；不需要用户点进/放大小窗。
 */
async function captureFrame(opts = {}) {
  if (_state !== 'running' || !_hwnd) return { success: false, error: '桌面分身未运行' };
  const CC = require('./computerControl');
  const r = await CC.captureWindowByHwnd(_hwnd, { maxWidth: opts.maxWidth || 900 });
  if (!r.success) return r;
  const png = 'data:image/png;base64,' + r.buffer.toString('base64');
  return { success: true, png, width: r.width, height: r.height };
}

function status() {
  const cs = childSession.status();
  return {
    state: _state,
    hwnd: _hwnd,
    widget: { width: SMALL_W, desktop: `${DESKTOP_W}x${DESKTOP_H}`, pos: _lastPos },
    childSession: { enabled: cs.enabled, sessionId: cs.sessionId },
    purpose: 'bettergi-child-session-desktop-clone',
    purposeNote: '悬浮预览小窗方案：RDP Child Session 隔离桌面。启动即一个无标题栏的预览小窗，' +
      '右对齐贴在主程序输入栏上方 —— 它只是预览，鼠标点不到里面的画面（输入全部被吞掉，' +
      '不会误操作远端桌面）；双击剥离成独立大窗（自绘标题栏：— 收回小窗 / ✕ 关闭，可缩放、可交互），' +
      '小窗右上角自绘 ✕ 关闭；两种形态共用同一个 RDP 连接、连接不断；' +
      '进程不分离、不占任务栏独立程序位'
  };
}

module.exports = { start, stop, status, sendInput, reanchor, moveClone, setVisible, setTaskRunning, launchInSession, applyTheme, captureFrame, isTaskRegistered, ensureRegistered, computePos, computeAnchor, configure, LARGE_W, SMALL_W, ANCHOR_GAP, HOST_EXE_NAME };
