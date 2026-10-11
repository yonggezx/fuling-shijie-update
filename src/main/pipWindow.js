/**
 * 画中画（PiP）：把主窗口缩到右下角，在小窗口里显示「被 AI 操作的程序」的实时画面
 * ------------------------------------------------------------
 * 解决什么问题：AI 要操作别的程序（点按钮、改界面、跑验证）时，
 *   用户被迫在「自己的桌面」和「AI 正在动的那个程序」之间来回切，
 *   看不到 AI 干了什么，也没法插手。传统做法是切到目标窗口去盯着，
 *   但那样 AI 一动鼠标用户就抢不到窗口。
 *   这里的做法是：主窗口自己缩到右下角当画中画，**里面显示目标程序的画面**，
 *   AI 照常在真实窗口上操作，用户在小窗里看得见；
 *   用户想插手时，在小窗上点一下，坐标会换算成真实屏幕坐标点过去 ——
 *   也就是「AI 主导、用户可在任意时刻辅助点击」。
 *
 * 设计要点：
 *   1. 状态必须能完整还原。进 PiP 前记下窗口 bounds/最大化/全屏状态，
 *      退出时精确恢复，不能把用户原本的窗口布局弄乱。
 *   2. 画面推送要有节流。按屏幕刷新率推会白烧 CPU，这里默认 2 帧/秒，
 *      足够看清 AI 在干什么，又几乎不占资源。
 *   3. 坐标换算必须扣掉窗口边框和标题栏。抓到的是「客户区」画面，
 *      真实点击位置要按 GetWindowRect 换算回去，否则点不准。
 *   4. 退出/崩溃/切回时都要停掉推送定时器，别留孤儿任务。
 */
'use strict';

const { screen, desktopCapturer } = require('electron');
const ComputerControl = require('./computerControl');
const VirtualDesktop = require('./virtualDesktop');

// 画面推送频率（帧/秒）。2 足够看清，又不烧 CPU。
const DEFAULT_FPS = 2;
const PIP_MIN_W = 360;
const PIP_MIN_H = 240;
const PIP_MARGIN = 18;
// 抓帧分辨率上限：画中画最大也就 640 宽，抓 720 足够清晰，体积又小
const PIP_FRAME_W = 720;
const PIP_FRAME_H = 480;

let state = {
  active: false,
  targetTitle: null,     // 目标窗口标题关键字
  targetHwnd: null,
  prev: null,            // 进入 PiP 前的窗口状态
  timer: null,
  lastFrameAt: 0
};

let mainWindow = null;
let getMainWindow = () => null;
let sendToRenderer = () => {};

/** 由 main.js 注入 */
function configure({ getWindow, send }) {
  if (typeof getWindow === 'function') getMainWindow = getWindow;
  if (typeof send === 'function') sendToRenderer = send;
}

function win() {
  const w = getMainWindow();
  return (w && !w.isDestroyed()) ? w : null;
}

/** 记住当前窗口状态，退出 PiP 时照这个还原 */
function snapshot(w) {
  const b = w.getBounds();
  return {
    bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
    maximized: w.isMaximized(),
    fullScreen: w.isFullScreen(),
    visible: w.isVisible()
  };
}

/** 目标窗口在屏幕上的矩形（user32 坐标） */
function targetRect(hwnd) {
  try {
    const koffi = require('koffi');
    if (!ComputerControl.initWinAPI()) return null;
    // ⚠️ 两个实测踩过的点：
    //   1) hwnd 从 computerControl 出来是**字符串**，要先 Number 转换；
    //   2) 传 BigInt 会让 GetWindowRect 直接返回 1(失败) —— 要传**普通 number**。
    //      （koffi 声明的是 uint64，但这里实测 number 才能过，别改回 BigInt）
    const n = Number(hwnd);
    if (!isFinite(n) || n <= 0) return null;
    const user32 = koffi.load('user32.dll');
    const GetWindowRect = user32.func('int __stdcall GetWindowRect(uint64 hwnd, _Out_ void* rect)');
    const buf = Buffer.alloc(16);
    if (!GetWindowRect(n, buf)) return null;
    return {
      x: buf.readInt32LE(0),
      y: buf.readInt32LE(4),
      width: buf.readInt32LE(8) - buf.readInt32LE(0),
      height: buf.readInt32LE(12) - buf.readInt32LE(4)
    };
  } catch (e) {
    return null;
  }
}

/**
 * 抓目标窗口的当前画面。
 *
 * 两条路，按优先级：
 *   ① desktopCapturer（按标题匹配）—— 能拿到 GPU/硬件加速渲染的内容，
 *      但**看不到本进程自己的窗口**（Electron 限制，实测同进程的窗口不在列表里）。
 *   ② PrintWindow（直接按 hwnd 抓）—— 兜底，能抓到本进程窗口，
 *      但对某些 GPU 渲染窗口会抓到黑屏。
 * 两条都不行才算失败，并且把原因如实带回渲染层，不假装"一切正常"。
 */
async function grabFrame(title, hwnd) {
  if (!title && !hwnd) return null;
  try {
    const primary = screen.getPrimaryDisplay();
    const scale = primary.scaleFactor || 1;
    // 小画面不需要大图，按 PiP 实际尺寸抓，省内存和带宽
    const thumbW = Math.min(Math.round(PIP_MIN_W * scale), 1280);

    // ① desktopCapturer
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: thumbW, height: Math.round(thumbW * 0.7) },
      fetchWindowIcons: false
    });
    if (title) {
      const needle = String(title).toLowerCase();
      const hit = sources.find(s => (s.name || '').toLowerCase().includes(needle));
      if (hit && hit.thumbnail && !hit.thumbnail.isEmpty()) {
        const size = hit.thumbnail.getSize();
        return { dataUrl: hit.thumbnail.toDataURL(), width: size.width, height: size.height, via: 'desktopCapturer', name: hit.name };
      }
    }

    // ② PrintWindow 兜底
    if (hwnd) {
      const shot = printWindow(hwnd);
      if (shot && shot.raw) {
        // BMP 原图有 3MB+，塞进 dataURL 每秒传两次会把渲染进程压垮。
        // 缩到画中画实际显示尺寸再转 JPEG，体积能降到几十 KB，肉眼无损。
        const jpeg = bitmapToJpeg(shot.raw, shot.width, shot.height);
        if (jpeg) return { dataUrl: jpeg, width: shot.width, height: shot.height, via: 'printWindow' };
      }
    }

    return {
      missing: true,
      reason: 'no-source',
      candidates: sources.map(s => s.name).filter(Boolean).slice(0, 20)
    };
  } catch (e) {
    return { error: (e && e.message) ? e.message : String(e) };
  }
}

/**
 * 用 PrintWindow 按 hwnd 抓窗口画面。
 * 需要先把 DWM 交给这个窗口（PW_RENDERFULLCONTENT=2），否则很多窗口只能抓到黑屏。
 * 手动构造 BITMAPINFOHEADER + 挑色板，避开 koffi 的 union/struct 限制。
 */
function printWindow(hwnd) {
  try {
    const koffi = require('koffi');
    const n = Number(hwnd);
    if (!isFinite(n) || n <= 0) return null;
    const user32 = koffi.load('user32.dll');
    const gdi32 = koffi.load('gdi32.dll');

    const GetWindowRect = user32.func('int __stdcall GetWindowRect(uint64 hwnd, _Out_ void* rect)');
    const PrintWindow = user32.func('int __stdcall PrintWindow(uint64 hwnd, void* hdc, uint32 flags)');
    const GetWindowDC = user32.func('void* __stdcall GetWindowDC(uint64 hwnd)');
    const ReleaseDC = user32.func('int __stdcall ReleaseDC(uint64 hwnd, void* hdc)');
    const CreateCompatibleDC = gdi32.func('void* __stdcall CreateCompatibleDC(void* hdc)');
    // ★ 目标位图必须用 DIB：CreateCompatibleBitmap 建的 DDB 在本机接不到任何像素
    const CreateDIBSection = gdi32.func('void* __stdcall CreateDIBSection(void* hdc, void* pbmi, uint32 usage, _Out_ void* ppvBits, void* hSection, uint32 offset)');
    const SelectObject = gdi32.func('void* __stdcall SelectObject(void* hdc, void* obj)');
    const DeleteObject = gdi32.func('int __stdcall DeleteObject(void* obj)');
    const DeleteDC = gdi32.func('int __stdcall DeleteDC(void* hdc)');
    const GetDIBits = gdi32.func('int __stdcall GetDIBits(void* hdc, void* hbm, uint32 start, uint32 cLines, void* lpvBits, void* lpbmi, uint32 usage)');

    const rect = Buffer.alloc(16);
    if (!GetWindowRect(n, rect)) return null;
    const W = rect.readInt32LE(8) - rect.readInt32LE(0);
    const H = rect.readInt32LE(12) - rect.readInt32LE(4);
    if (W <= 0 || H <= 0) return null;
    // ⚠️ 位图必须按窗口**原始尺寸**建：PrintWindow 是按窗口真实大小渲染的，
    //    画布开小了就只渲染出左上角一块（画面被"裁"掉，不是"缩"）。
    //    缩放放到拿到像素之后再做（bitmapToJpeg 里等比缩），
    //    这样画面完整、比例不变，点击坐标换算才准。
    //    内存上限兜底：超大窗口（4K 以上）按比例整体缩小，保持宽高比。
    let capW = W, capH = H;
    const MAX_PIXELS = 4 * 1000 * 1000;   // 约 1600x2500，够用且不吃内存
    if (W * H > MAX_PIXELS) {
      const k = Math.sqrt(MAX_PIXELS / (W * H));
      capW = Math.max(1, Math.round(W * k));
      capH = Math.max(1, Math.round(H * k));
    }
    const w = capW;
    const h = capH;

    const hdcWin = GetWindowDC(n);
    if (!hdcWin) return null;
    const hdcMem = CreateCompatibleDC(hdcWin);
    // BITMAPINFOHEADER（40 字节，32bpp BI_RGB）
    const bmi = Buffer.alloc(40);
    bmi.writeUInt32LE(40, 0);
    bmi.writeInt32LE(w, 4);
    bmi.writeInt32LE(-h, 8);         // 负数 = 自上而下
    bmi.writeUInt16LE(1, 12);
    bmi.writeUInt16LE(32, 14);
    bmi.writeUInt32LE(0, 16);
    const bmp = CreateDIBSection(hdcWin, bmi, 0, Buffer.alloc(16), null, 0);
    if (!hdcMem || !bmp) {
      if (hdcMem) DeleteDC(hdcMem);
      ReleaseDC(n, hdcWin);
      return null;
    }
    const old = SelectObject(hdcMem, bmp);
    // 2 = PW_RENDERFULLCONTENT，让 DWM 把合成后的内容给我们
    // 画布尺寸与窗口不同时，PrintWindow 会左上对齐渲染；
    // 所以上面已经保证 (w,h) 与 (W,H) 同比例，缩放后视觉一致。
    PrintWindow(n, hdcMem, 2);

    const bits = Buffer.alloc(w * h * 4);
    const got = GetDIBits(hdcMem, bmp, 0, h, bits, bmi, 0);

    SelectObject(hdcMem, old);
    DeleteObject(bmp);
    DeleteDC(hdcMem);
    ReleaseDC(n, hdcWin);
    if (got === 0) return null;

    // BGRA → RGBA，交给上层转 JPEG
    for (let i = 0; i < bits.length; i += 4) {
      const b = bits[i];
      bits[i] = bits[i + 2];
      bits[i + 2] = b;
      bits[i + 3] = 255;
    }
    return { raw: bits, width: w, height: h };
  } catch (e) {
    return null;
  }
}

/**
 * 原始 RGBA 像素 → JPEG dataURL（等比缩放到 PIP_FRAME_W 以内）。
 *
 * 为什么用等比缩放而不是直接压到固定尺寸：
 *   画中画那边是按「画面内相对坐标」换算点击位置的。
 *   一旦宽高比被改掉，用户点画面右侧 80% 处，换算出来的实际位置就偏了。
 *   所以这里保持原始宽高比，只按最大边等比缩小 —— 缩放不改变比例，换算才准。
 *
 * 用 Electron 自带的 nativeImage 做缩放和编码，不引第三方图像库。
 * 画质 80 对小画面肉眼无损，体积比 BMP 小两个数量级。
 */
function bitmapToJpeg(rgba, w, h) {
  try {
    const { nativeImage } = require('electron');
    const img = nativeImage.createFromBitmap(rgba, { width: w, height: h });
    if (!img || img.isEmpty()) return null;
    // 等比缩放到最长边 PIP_FRAME_W
    const longest = Math.max(w, h);
    if (longest > PIP_FRAME_W) {
      const k = PIP_FRAME_W / longest;
      const nw = Math.max(1, Math.round(w * k));
      const nh = Math.max(1, Math.round(h * k));
      const small = img.resize({ width: nw, height: nh, quality: 'good' });
      return small.toJPEG(80);
    }
    return img.toJPEG(80);
  } catch (e) {
    return null;
  }
}

/** 推一帧给渲染层 */
async function pushFrame() {
  if (!state.active) return;
  const w = win();
  if (!w) { stop(); return; }

  const frame = await grabFrame(state.targetTitle, state.targetHwnd);
  const rect = state.targetHwnd ? targetRect(state.targetHwnd) : null;

  state.lastFrameAt = Date.now();
  try {
    sendToRenderer('pip:frame', {
      ok: !!(frame && frame.dataUrl),
      dataUrl: frame && frame.dataUrl ? frame.dataUrl : null,
      width: frame ? (frame.width || 0) : 0,
      height: frame ? (frame.height || 0) : 0,
      targetRect: rect,
      targetTitle: state.targetTitle,
      matched: frame && frame.name ? frame.name : null,
      via: frame ? (frame.via || null) : null,
      error: frame ? (frame.error || (frame.missing ? '目标窗口已最小化，或不在当前桌面' : null)) : null
    });
  } catch (e) { /* 渲染层已销毁，忽略 */ }
}

function startTimer(fps) {
  stopTimer();
  const interval = Math.max(200, Math.round(1000 / (fps || DEFAULT_FPS)));
  state.timer = setInterval(() => { pushFrame(); }, interval);
}

function stopTimer() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

/**
 * 进入画中画。
 * @param {object} opts { title } 目标窗口标题关键字
 */
async function enter(opts = {}) {
  const w = win();
  if (!w) return { success: false, error: '主窗口不可用' };
  if (state.active) return { success: true, already: true };

  const title = String(opts.title || '').trim();
  if (!title) return { success: false, error: '需要指定要观察的目标窗口（title）' };

  // 先确认目标窗口存在，别把主窗口缩下去之后才发现抓不到画面
  const found = ComputerControl.findWindow(title);
  if (!found) {
    return { success: false, error: '没找到标题包含「' + title + '」的窗口' };
  }

  state.prev = snapshot(w);
  state.targetTitle = title;
  state.targetHwnd = found.hwnd;
  state.active = true;

  // 先离开全屏/最大化再改尺寸，否则 setBounds 会被忽略
  try { if (w.isFullScreen()) w.setFullScreen(false); } catch (e) { /* ignore */ }
  try { if (w.isMaximized()) w.unmaximize(); } catch (e) { /* ignore */ }

  const area = screen.getPrimaryDisplay().workArea;
  const pw = Math.max(PIP_MIN_W, Math.min(640, Math.round(area.width * 0.34)));
  const ph = Math.max(PIP_MIN_H, Math.min(480, Math.round(area.height * 0.36)));
  const px = area.x + area.width - pw - PIP_MARGIN;
  const py = area.y + area.height - ph - PIP_MARGIN;

  try {
    w.setBounds({ x: Math.round(px), y: Math.round(py), width: pw, height: ph });
    w.show();
    w.focus();
  } catch (e) {
    return { success: false, error: '切换到画中画尺寸失败: ' + (e && e.message ? e.message : String(e)) };
  }

  startTimer(opts.fps);
  // 立刻推一帧，别让用户对着空窗等一个周期
  await pushFrame();

  return { success: true, bounds: { x: Math.round(px), y: Math.round(py), width: pw, height: ph }, target: found };
}

/** 退出画中画，还原用户原本的窗口状态 */
function exit() {
  if (!state.active) return { success: true, already: true };
  const w = win();
  stopTimer();
  state.active = false;

  const prev = state.prev;
  state.prev = null;
  const title = state.targetTitle;
  state.targetTitle = null;
  state.targetHwnd = null;

  if (w && prev) {
    try {
      if (prev.visible) w.show();
      // 先设尺寸再置前/最大化，否则某些状态下 setBounds 会被最大化态吃掉
      w.setBounds(prev.bounds);
      if (prev.maximized) w.maximize();
      if (prev.fullScreen) w.setFullScreen(true);
    } catch (e) { /* 窗口可能已销毁 */ }
  }
  try { sendToRenderer('pip:state', { active: false, target: title }); } catch (e) { /* ignore */ }
  return { success: true, restored: prev };
}

function status() {
  return {
    active: state.active,
    targetTitle: state.targetTitle,
    fps: state.timer ? DEFAULT_FPS : 0,
    lastFrameAt: state.lastFrameAt
  };
}

/** 改变观察目标（不改变 PiP 状态） */
async function setTarget(title) {
  const t = String(title || '').trim();
  if (!t) return { success: false, error: '目标窗口标题不能为空' };
  const found = ComputerControl.findWindow(t);
  if (!found) return { success: false, error: '没找到标题包含「' + t + '」的窗口' };
  state.targetTitle = t;
  state.targetHwnd = found.hwnd;
  await pushFrame();
  return { success: true, target: found };
}

/**
 * 用户在画中画画面上点了一下 → 换算成真实屏幕坐标点过去。
 *
 * 换算是这里最容易出错的地方：
 *   画面是「客户区截图」，而真实点击坐标是「屏幕坐标」。
 *   两者差一个窗口边框 + 标题栏。所以必须：
 *     1) 拿窗口在屏幕上的 GetWindowRect；
 *     2) 用画面内的相对比例（0~1）× 客户区尺寸算出客户区内坐标；
 *     3) 加上客户区原点（= 窗口左上 + 边框宽度 / 标题栏高度）。
 *   直接用比例 × 整个窗口矩形会偏下偏右，点不中按钮。
 *
 * @param {object} p { rx, ry } 画面内相对坐标（0~1）
 * @param {object} p { button, double }
 */
async function forwardClick(p = {}) {
  if (!state.active) return { success: false, error: '当前不在画中画模式' };
  if (!state.targetHwnd) return { success: false, error: '没有有效的目标窗口' };

  const rect = targetRect(state.targetHwnd);
  if (!rect) return { success: false, error: '取不到目标窗口位置（可能已关闭）' };

  const rx = Math.max(0, Math.min(1, Number(p.rx)));
  const ry = Math.max(0, Math.min(1, Number(p.ry)));
  if (!isFinite(rx) || !isFinite(ry)) return { success: false, error: '点击坐标无效' };

  // 客户区原点在窗口内的偏移：边框约 8px、标题栏约 31px（Win10/11 默认）。
  // 拿不到精确值时用经验值，偏差在几像素内，配合放大后的画面足够点中。
  const BORDER = 8;
  const TITLEBAR = 31;
  const clientX = rect.x + BORDER + Math.round((rect.width - BORDER * 2) * rx);
  const clientY = rect.y + TITLEBAR + Math.round((rect.height - BORDER - TITLEBAR) * ry);

  // 先把目标窗口置前，否则点击会打到当前前台窗口上
  // dryRun：只算坐标不真的动鼠标/不抢焦点（验证脚本和无头环境用）
  if (!p.dryRun) {
    const focus = ComputerControl.focusWindow(state.targetHwnd);
    if (focus && focus.success === false) {
      return { success: false, error: '无法激活目标窗口: ' + (focus.error || '') };
    }
    await new Promise(r => setTimeout(r, 120));
  }

  const btn = p.button === 'right' ? 'right' : (p.button === 'middle' ? 'middle' : 'left');
  let clicked = { success: true, dryRun: true, x: clientX, y: clientY };
  if (!p.dryRun) {
    clicked = ComputerControl.clickMouse(clientX, clientY, { button: btn, double: !!p.double });
  }

  return {
    success: !!(clicked && clicked.success !== false),
    screenX: clientX,
    screenY: clientY,
    clientX: clientX - rect.x,
    clientY: clientY - rect.y,
    rect,
    dryRun: !!p.dryRun,
    result: clicked
  };
}

/** 目标窗口最小化/移动时，画中画要如实反映 */
function noteTargetGone() {
  stopTimer();
  state.active = false;
  state.targetTitle = null;
  state.targetHwnd = null;
  state.prev = null;
}

function dispose() {
  stopTimer();
  state = { active: false, targetTitle: null, targetHwnd: null, prev: null, timer: null, lastFrameAt: 0 };
}

module.exports = {
  configure,
  enter,
  exit,
  status,
  setTarget,
  forwardClick,
  pushFrame,
  dispose,
  noteTargetGone,
  grabFrame,
  targetRect
};
