// cloneInputHelper.js —— 隐藏桌面输入注入 + 抓帧助手（ELECTRON_RUN_AS_NODE 子进程）
// -----------------------------------------------------------------------------
// 用途：
//   1. OpenDesktopW 打开目标隐藏桌面，SetThreadDesktop 把【本进程/本线程】附加到该桌面；
//   2. 从命名管道接收命令：输入注入（SendInput）与抓帧（PrintWindow 整屏合成）；
//   3. SendInput / PrintWindow 都作用于调用线程所在的桌面（即隐藏桌面），不干扰用户前台桌面。
// 独立进程运行：不能把 Electron 主线程 SetThreadDesktop 到非前台桌面，否则会破坏 UI。
//
// ★ 为什么抓帧必须在这里做：PrintWindow 要求调用线程已 attach 到目标窗口所在桌面。
//   Electron 主线程在主桌面上，对分身桌面的窗口调 PrintWindow 恒返回全黑。
'use strict';
const koffi = require('koffi');
const net = require('net');
const zlib = require('zlib');
const fs = require('fs');
const dib = require('./dib');

const user32 = koffi.load('user32.dll');
const kern32 = koffi.load('kernel32.dll');
const gdi32 = koffi.load('gdi32.dll');
const F = {};
F.OpenDesktopW = user32.func('void* __stdcall OpenDesktopW(void* lpszDesktop, uint dwFlags, int fInherit, uint dwDesiredAccess)');
F.CloseDesktop = user32.func('int __stdcall CloseDesktop(void* hdesk)');
F.SetThreadDesktop = user32.func('int __stdcall SetThreadDesktop(void* hdesk)');
F.GetLastError = kern32.func('int __stdcall GetLastError()');
F.SendInput = user32.func('uint __stdcall SendInput(uint cInputs, void* pInputs, int cbSize)');
// 抓帧用
F.EnumDesktopWindows = user32.func('int __stdcall EnumDesktopWindows(void* hdesk, void* lpEnumFunc, long lParam)');
F.GetClassNameW = user32.func('int __stdcall GetClassNameW(uint64 hwnd, void* lpString, int nMaxCount)');
F.GetWindowTextW = user32.func('int __stdcall GetWindowTextW(uint64 hwnd, void* lpString, int nMaxCount)');
F.IsWindowVisible = user32.func('int __stdcall IsWindowVisible(uint64 hwnd)');
F.GetWindowRect = user32.func('int __stdcall GetWindowRect(uint64 hwnd, void* rect)');
F.PrintWindow = user32.func('int __stdcall PrintWindow(uint64 hwnd, void* hdcBlt, uint nFlags)');
// ★ 关键：目标位图必须用 CreateDIBSection（DIB），不能用 CreateCompatibleBitmap（DDB）。
//   本机（DWM 合成 + 硬件加速）上 DDB 位图接不到任何像素，BitBlt/PrintWindow 全部返回全 0；
//   换成 DIB 后同一条调用链立刻拿到 99.8% 非黑、14000+ 色彩的真实画面。详见 dib.js。
F.CreateCompatibleDC = gdi32.func('void* __stdcall CreateCompatibleDC(void* hdc)');
F.CreateDIBSection = gdi32.func('void* __stdcall CreateDIBSection(void* hdc, void* pbmi, uint usage, _Out_ void* ppvBits, void* hSection, uint dwOffset)');
F.GetDC = user32.func('void* __stdcall GetDC(void* hwnd)');
F.ReleaseDC = user32.func('int __stdcall ReleaseDC(void* hwnd, void* hdc)');
F.BitBlt = gdi32.func('int __stdcall BitBlt(void* dst, int x, int y, int w, int h, void* src, int sx, int sy, uint rop)');
F.SelectObject = gdi32.func('void* __stdcall SelectObject(void* hdc, void* obj)');
F.GetDIBits = gdi32.func('int __stdcall GetDIBits(void* hdc, void* hbmp, uint start, uint cLines, void* lpvBits, void* lpbmi, uint usage)');
F.DeleteObject = gdi32.func('int __stdcall DeleteObject(void* obj)');
F.DeleteDC = gdi32.func('int __stdcall DeleteDC(void* hdc)');
F.GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int nIndex)');

const GENERIC_ALL = 0x10000000;

// 构造一个鼠标 INPUT（MOUSEINPUT）
function mouseInputBuffer(x, y, flags, data) {
  const INPUT_SIZE = 40; // 40 字节对齐，鼠标 INPUT 头 40 字节
  const buf = Buffer.alloc(INPUT_SIZE);
  buf.writeUInt32LE(0, 0);        // type = INPUT_MOUSE
  buf.writeInt32LE(x, 4);         // dx
  buf.writeInt32LE(y, 8);         // dy
  buf.writeUInt32LE(data >>> 0, 12); // mouseData
  buf.writeUInt32LE(flags >>> 0, 16); // dwFlags
  buf.writeUInt32LE(0, 20);       // time
  buf.writeBigUInt64LE(0n, 24);   // dwExtraInfo (8 bytes)
  return buf;
}

// 构造一个键盘 INPUT（KEYBDINPUT）
function keyInputBuffer(vk, scan, flags) {
  const INPUT_SIZE = 40;
  const buf = Buffer.alloc(INPUT_SIZE);
  buf.writeUInt32LE(1, 0);        // type = INPUT_KEYBOARD
  buf.writeUInt16LE(vk, 4);       // wVk
  buf.writeUInt16LE(scan, 6);     // wScan
  buf.writeUInt32LE(flags, 8);    // dwFlags
  buf.writeUInt32LE(0, 12);       // time
  buf.writeBigUInt64LE(0n, 16);   // dwExtraInfo
  return buf;
}

function sendMouse(x, y, flags, data) {
  const inp = mouseInputBuffer(x, y, flags, data);
  return F.SendInput(1, inp, 40) > 0;
}

function sendKey(vk, scan, flags) {
  const inp = keyInputBuffer(vk, scan, flags);
  return F.SendInput(1, inp, 40) > 0;
}

// 用 Unicode 扫描码输入文本（支持中文）
function typeText(text) {
  let sent = 0;
  for (const ch of String(text)) {
    const unit = ch.charCodeAt(0);
    const KEYEVENTF_UNICODE = 0x0004;
    sent += sendKey(0, unit, KEYEVENTF_UNICODE) ? 1 : 0;
    sent += sendKey(0, unit, KEYEVENTF_UNICODE | 0x0002) ? 1 : 0;
  }
  return sent;
}

function resolveVk(key) {
  const map = {
    enter: 0x0D, return: 0x0D, escape: 0x1B, esc: 0x1B, tab: 0x09, space: 0x20,
    backspace: 0x08, delete: 0x2E, up: 0x26, down: 0x28, left: 0x25, right: 0x27,
    home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
    'ctrl': 0x11, 'control': 0x11, 'shift': 0x10, 'alt': 0x12,
    'win': 0x5B, lwin: 0x5B, rwin: 0x5C, capslock: 0x14, f1: 0x70, f2: 0x71,
    f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75, f7: 0x76, f8: 0x77, f9: 0x78,
    f10: 0x79, f11: 0x7A, f12: 0x7B
  };
  const k = String(key).toLowerCase().trim();
  if (map[k]) return map[k];
  if (/^[a-z]$/.test(k)) return k.charCodeAt(0) - 32;
  if (/^[0-9]$/.test(k)) return 0x30 + Number(k);
  return 0;
}

function pressKey(vk) {
  const KEYEVENTF_KEYUP = 0x0002;
  sendKey(vk, 0, 0);
  sendKey(vk, 0, KEYEVENTF_KEYUP);
  return true;
}

// 处理一条命令
function handle(cmd) {
  const a = cmd.action;
  const MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
  const MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
  const MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040;
  const MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x1000;
  const MOUSEEVENTF_MOVE = 0x0001;
  switch (a) {
    case 'move': return sendMouse(Math.round(cmd.x || 0), Math.round(cmd.y || 0), MOUSEEVENTF_MOVE, 0);
    case 'click':
    case 'left_click':
      sendMouse(cmd.x, cmd.y, MOUSEEVENTF_LEFTDOWN, 0);
      sendMouse(cmd.x, cmd.y, MOUSEEVENTF_LEFTUP, 0);
      return true;
    case 'right_click':
      sendMouse(cmd.x, cmd.y, MOUSEEVENTF_RIGHTDOWN, 0);
      sendMouse(cmd.x, cmd.y, MOUSEEVENTF_RIGHTUP, 0);
      return true;
    case 'double_click':
      sendMouse(cmd.x, cmd.y, MOUSEEVENTF_LEFTDOWN, 0);
      sendMouse(cmd.x, cmd.y, MOUSEEVENTF_LEFTUP, 0);
      sendMouse(cmd.x, cmd.y, MOUSEEVENTF_LEFTDOWN, 0);
      sendMouse(cmd.x, cmd.y, MOUSEEVENTF_LEFTUP, 0);
      return true;
    case 'mouse_down':
    case 'left_down':
      return sendMouse(cmd.x, cmd.y, MOUSEEVENTF_LEFTDOWN, 0);
    case 'mouse_up':
    case 'left_up':
      return sendMouse(cmd.x, cmd.y, MOUSEEVENTF_LEFTUP, 0);
    case 'scroll':
      return sendMouse(0, 0, MOUSEEVENTF_WHEEL, Math.round(cmd.delta || 0));
    case 'press':
    case 'key':
      return pressKey(resolveVk(cmd.key || cmd.vk));
    case 'hotkey':
      {
        const keys = cmd.keys || [];
        const down = keys.map((k) => resolveVk(k)).filter(Boolean);
        for (const v of down) sendKey(v, 0, 0);
        const KEYEVENTF_KEYUP = 0x0002;
        for (const v of down.slice().reverse()) sendKey(v, 0, KEYEVENTF_KEYUP);
        return true;
      }
    case 'type':
    case 'paste':
      return typeText(String(cmd.text || ''));
    default:
      return false;
  }
}

// ============================================================
// 抓帧：整屏真实桌面合成（本线程已 attach 到分身桌面，PrintWindow 才有效）
// ============================================================

/** 构造 40 字节 BITMAPINFOHEADER（biHeight 取负 = 自上而下，省一次翻转） */
function makeBmi(w, h) {
  return dib.makeBmi(w, h, true);
}

/** 创建一块 32bpp 可直接读写的 DIB 位图（关键：不能用 CreateCompatibleBitmap） */
function createDib(w, h) {
  return dib.create(w, h, true);
}

function destroyDib(d) {
  dib.destroy(d);
}

/** 在画布上填一个矩形（RGBA） */
function fillRect(canvas, cw, ch, x0, y0, x1, y1, r, g, b) {
  const ax = Math.max(0, Math.min(cw, x0)), ay = Math.max(0, Math.min(ch, y0));
  const bx = Math.max(0, Math.min(cw, x1)), by = Math.max(0, Math.min(ch, y1));
  for (let y = ay; y < by; y++) {
    let i = (y * cw + ax) * 4;
    for (let x = ax; x < bx; x++) {
      canvas[i] = r; canvas[i + 1] = g; canvas[i + 2] = b; canvas[i + 3] = 0xFF;
      i += 4;
    }
  }
}

/**
 * 画一个窗口占位框：深色填充 + 亮色边框 + 顶部标题条。
 * 用于「抓不到像素但位置真实」的场景，让用户能看清分身桌面上有哪些窗口、分别在哪。
 */
function drawWindowFrame(canvas, cw, ch, w) {
  const x0 = Math.max(0, w.left), y0 = Math.max(0, w.top);
  const x1 = Math.min(cw, w.right), y1 = Math.min(ch, w.bottom);
  const bw = x1 - x0, bh = y1 - y0;
  if (bw <= 2 || bh <= 2) return;
  // 窗口体
  fillRect(canvas, cw, ch, x0, y0, x1, y1, 44, 48, 58);
  // 标题条
  const titleH = Math.min(28, Math.max(16, Math.round(bh * 0.08)));
  fillRect(canvas, cw, ch, x0, y0, x1, y0 + titleH, 62, 68, 82);
  // 外边框
  const B = 2;
  fillRect(canvas, cw, ch, x0, y0, x1, y0 + B, 120, 170, 255);
  fillRect(canvas, cw, ch, x0, y1 - B, x1, y1, 120, 170, 255);
  fillRect(canvas, cw, ch, x0, y0, x0 + B, y1, 120, 170, 255);
  fillRect(canvas, cw, ch, x1 - B, y0, x1, y1, 120, 170, 255);
}

/** 从 DIB 位图读回像素 → RGBA 自上而下（alpha 恒 0xFF） */
function readDib(d) {
  return dib.read(d);
}

let _crcTable = null;
function crc32(buf) {
  if (!_crcTable) {
    _crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      _crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = _crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return c ^ -1;
}

function encodePng(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 1 });
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))
  ]);
}

/** 盒式降采样 */
function downsampleBox(src, sw, sh, dw, dh) {
  const dst = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy0 = Math.floor(y * sh / dh);
    const sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * sh / dh));
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.floor(x * sw / dw);
      const sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * sw / dw));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = sy0; yy < sy1 && yy < sh; yy++) {
        let o = (yy * sw + sx0) * 4;
        for (let xx = sx0; xx < sx1 && xx < sw; xx++, o += 4) { r += src[o]; g += src[o + 1]; b += src[o + 2]; n++; }
      }
      const d = (y * dw + x) * 4;
      if (n > 0) { dst[d] = r / n; dst[d + 1] = g / n; dst[d + 2] = b / n; }
      dst[d + 3] = 0xFF;
    }
  }
  return dst;
}

/** 枚举本桌面可见窗口（EnumDesktopWindows 自上而下 = 画家顺序）
 *  ⚠️ koffi 的 proto 类型名必须全局唯一，同名重复注册会报 Duplicate type name。
 *  这里用 uniqueProto 缓存，只注册一次。 */
let _enumProto = null;
function enumWindows(hDesk) {
  if (!_enumProto) _enumProto = koffi.proto('int __stdcall CloneEnumProc2(uint64 hwnd, long lParam)');
  const wins = [];
  const cb = koffi.register((hwnd) => {
    try {
      if (!F.IsWindowVisible(hwnd)) return 1;
      const rect = Buffer.alloc(16);
      if (!F.GetWindowRect(hwnd, rect)) return 1;
      const left = rect.readInt32LE(0), top = rect.readInt32LE(4);
      const right = rect.readInt32LE(8), bottom = rect.readInt32LE(12);
      if (right - left <= 0 || bottom - top <= 0) return 1;
      const clsBuf = Buffer.alloc(128);
      const cn = F.GetClassNameW(hwnd, clsBuf, 127);
      const titleBuf = Buffer.alloc(512);
      const tn = F.GetWindowTextW(hwnd, titleBuf, 255);
      wins.push({
        hwnd: String(hwnd),
        cls: cn > 0 ? clsBuf.toString('utf16le', 0, cn * 2) : '',
        title: tn > 0 ? titleBuf.toString('utf16le', 0, tn * 2) : '',
        left, top, right, bottom
      });
    } catch (e) { /* ignore */ }
    return 1;
  }, koffi.pointer(_enumProto));
  F.EnumDesktopWindows(hDesk, cb, 0);
  return wins;
}

/** 抓单个窗口像素（PrintWindow 路线，作为屏幕抓帧不可用时的兜底） */
function grabWindow(w) {
  const hwnd = Number(w.hwnd);
  const ww = w.right - w.left, wh = w.bottom - w.top;
  if (!isFinite(hwnd) || hwnd <= 0 || ww <= 0 || wh <= 0) return null;
  const d = createDib(ww, wh);
  if (!d) return null;
  // flag 2 = PW_RENDERFULLCONTENT，失败退回 flag 0
  let ok = F.PrintWindow(hwnd, d.dc, 2);
  if (!ok) ok = F.PrintWindow(hwnd, d.dc, 0);
  const buf = ok ? readDib(d) : null;
  destroyDib(d);
  if (!buf) return null;
  return { data: buf, w: ww, h: wh };
}

function blitBuffer(canvas, cw, ch, shot, r) {
  const x0 = Math.max(0, r.left), y0 = Math.max(0, r.top);
  const x1 = Math.min(cw, r.right), y1 = Math.min(ch, r.bottom);
  if (x1 <= x0 || y1 <= y0) return false;
  for (let y = y0; y < y1; y++) {
    const sy = y - r.top;
    if (sy < 0 || sy >= shot.h) continue;
    const copyX0 = Math.max(x0, r.left);
    const sw = Math.min(x1, r.left + shot.w) - copyX0;
    if (sw <= 0) continue;
    shot.data.copy(canvas, y * cw * 4 + copyX0 * 4,
      sy * shot.w * 4 + (copyX0 - r.left) * 4,
      sy * shot.w * 4 + (copyX0 - r.left) * 4 + sw * 4);
  }
  return true;
}

/** 屏幕 DC 整屏 BitBlt —— 唯一能拿到「完整真实桌面画面」的路径 */
function grabScreenFrame() {
  const fullW = F.GetSystemMetrics(0) || 1920;
  const fullH = F.GetSystemMetrics(1) || 1080;
  const d = createDib(fullW, fullH);
  if (!d) return null;
  const src = F.GetDC(null);
  if (!src) { destroyDib(d); return null; }
  // SRCCOPY(0x00CC0020) | CAPTUREBLT(0x40000000)：后者才包含 DWM 合成层
  const rc = F.BitBlt(d.dc, 0, 0, fullW, fullH, src, 0, 0, 0x00CC0020 | 0x40000000);
  F.ReleaseDC(null, src);
  if (!rc) { destroyDib(d); return null; }
  const buf = readDib(d);
  destroyDib(d);
  if (!buf) return null;
  // 全黑兜底判定：防住「返回成功但像素全 0」的异常
  if (!dib.hasContent(buf)) return null;
  return { data: buf, w: fullW, h: fullH };
}

/**
 * 整屏真实桌面合成 → { png(base64), width, height, screenWidth, screenHeight, windowsDrawn }
 * 主路径：屏幕 DC 整屏 BitBlt（完整真实画面，含壁纸/任务栏/所有窗口）
 * 兜底：铺壁纸底图 + 枚举窗口逐个 PrintWindow 拼接
 */
/** 读取主进程写好的底图（原始 RGBA），按 mtime 缓存，避免每帧读 7MB */
let _wpCache = { mtime: 0, buf: null };
function loadWallpaper(spec) {
  if (!spec || !spec.path) return null;
  try {
    const st = fs.statSync(spec.path);
    if (_wpCache.mtime === st.mtimeMs && _wpCache.buf) return _wpCache.buf;
    const buf = fs.readFileSync(spec.path);
    if (buf.length < 4) return null;
    _wpCache = { mtime: st.mtimeMs, buf };
    return buf;
  } catch (e) {
    return null;
  }
}

function captureDesktopFrame(hDesk, maxWidth, wallpaperSpec) {
  const fullW = F.GetSystemMetrics(0) || 1920;
  const fullH = F.GetSystemMetrics(1) || 1080;

  let canvas = null;
  let drawn = 0;
  let mode = 'screen';

  const screenShot = grabScreenFrame();
  if (screenShot) {
    canvas = screenShot.data;
    drawn = 1;
  } else {
    // 兜底：铺壁纸底图 + 窗口枚举合成
    mode = 'windows';
    canvas = Buffer.alloc(fullW * fullH * 4);
    for (let i = 3; i < canvas.length; i += 4) canvas[i] = 0xFF;
    // 底图：主进程给的中性渐变底（**不是**用户真实桌面截图，避免误导）
    const wp = loadWallpaper(wallpaperSpec);
    if (wp) wp.copy(canvas, 0, 0, Math.min(wp.length, canvas.length));
    const wins = enumWindows(hDesk);
    const ordered = wins.slice().reverse();
    for (const w of ordered) {
      if (w.right <= 0 || w.bottom <= 0 || w.left >= fullW || w.top >= fullH) continue;
      const shot = grabWindow(w);
      if (shot) {
        if (blitBuffer(canvas, fullW, fullH, shot, w)) { drawn++; continue; }
      }
      // 抓不到像素（非活动桌面无 DWM 表面）→ 画占位框，位置/尺寸是真实的
      drawWindowFrame(canvas, fullW, fullH, w);
      drawn++;
    }
  }

  const mw = Number(maxWidth) || 1280;
  let outW = fullW, outH = fullH;
  if (fullW > mw) { outW = mw; outH = Math.max(1, Math.round(fullH * mw / fullW)); }
  const rgba = outW === fullW ? canvas : downsampleBox(canvas, fullW, fullH, outW, outH);
  const png = encodePng(rgba, outW, outH);
  return {
    ok: true,
    png: png.toString('base64'),
    width: outW, height: outH,
    screenWidth: fullW, screenHeight: fullH,
    windowsDrawn: drawn,
    mode
  };
}

// 打开并附加到隐藏桌面
function attach(desktopName) {
  const nameBuf = Buffer.from(String(desktopName) + '\0', 'utf16le');
  const hDesk = F.OpenDesktopW(nameBuf, 0, 0, GENERIC_ALL);
  if (!hDesk || Number(hDesk) === 0) {
    const err = F.GetLastError();
    console.error('[cloneInputHelper] OpenDesktopW(' + desktopName + ') 失败, err=', err);
    return { ok: false, error: 'OpenDesktopW err=' + err };
  }
  const ok = F.SetThreadDesktop(hDesk);
  if (!ok) {
    const err = F.GetLastError();
    console.error('[cloneInputHelper] SetThreadDesktop 失败, err=', err);
    F.CloseDesktop(hDesk);
    return { ok: false, error: 'SetThreadDesktop err=' + err };
  }
  return { ok: true, hDesk };
}

// main
const pipeName = process.argv[2];
const desktopName = process.argv[3];
if (!pipeName || !desktopName) {
  console.error('[cloneInputHelper] 需要 pipeName 和 desktopName 参数');
  process.exit(2);
}
const at = attach(desktopName);
if (!at.ok) process.exit(3);

console.log('[cloneInputHelper] 已附加到桌面 [' + desktopName + ']，等待命令...');
const path = '\\\\.\\pipe\\' + pipeName;
const client = net.connect(path, () => {
  console.log('[cloneInputHelper] 已连接管道 ' + path);
});
// ⚠️ 必须按行缓冲：一次 data 事件可能只带半条 JSON，
// 直接 toString().trim().split('\n') 会把跨分片的多条命令粘成一行导致全部解析失败。
let _inBuf = '';
client.on('data', (d) => {
  _inBuf += d.toString('utf8');
  let nl;
  while ((nl = _inBuf.indexOf('\n')) >= 0) {
    const t = _inBuf.slice(0, nl).trim();
    _inBuf = _inBuf.slice(nl + 1);
    if (!t) continue;
    let cmd;
    try { cmd = JSON.parse(t); } catch (e) { continue; }
    // 抓帧命令（同步耗时，直接在数据回调里做；管道是本机回环，不会卡死调用方）
    if (cmd.action === 'capture_desktop') {
      let res;
      try {
        res = captureDesktopFrame(at.hDesk, cmd.maxWidth, cmd.wallpaper);
      } catch (e) {
        res = { ok: false, error: 'captureDesktopFrame 异常: ' + e.message };
      }
      client.write(JSON.stringify({ ok: true, seq: cmd.seq, result: res }) + '\n');
      continue;
    }
    if (cmd.action === 'list_windows') {
      const wins = enumWindows(at.hDesk);
      client.write(JSON.stringify({ ok: true, seq: cmd.seq, result: { windows: wins } }) + '\n');
      continue;
    }
    const ok = handle(cmd);
    client.write(JSON.stringify({ ok, seq: cmd.seq }) + '\n');
  }
});
client.on('error', (e) => { console.error('[cloneInputHelper] 管道错误:', e.message); process.exit(4); });
client.on('close', () => { console.log('[cloneInputHelper] 管道关闭，退出'); process.exit(0); });
