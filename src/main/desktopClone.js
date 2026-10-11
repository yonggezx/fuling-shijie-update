// desktopClone.js —— 隔离桌面（CreateDesktop 独立桌面）编排器
// 规格：CreateDesktopW 独立桌面(不切前台) + STARTUPINFO.lpDesktop 绑定进程
//      + SetThreadDesktop/SendInput 注入
//
// ⚠️ 定位（2026-10-04 起）：**只用于「不需要看界面」的任务** —— 编译、跑脚本、
//    装依赖、长时间构建、只出日志的程序。跑完由 AI 用文本汇报结果。
//    需要看界面 / 操作界面的任务一律在用户真实桌面进行。
//    原因：隐藏桌面的壁纸与桌面背景 Windows 根本不渲染
//    （attach 后 GetDC(NULL) 返回 0xFFFFFFFFFFFFFF75 无效句柄哨兵值），
//    预览只能是「中性底 + 窗口像素」，既不是真实桌面又白占资源 —— 故预览已移除。
'use strict';
const koffi = require('koffi');
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');
const fs = require('fs');
const CC = require('./computerControl');
const dib = require('./dib');

const user32 = koffi.load('user32.dll');
const kern32 = koffi.load('kernel32.dll');
const gdi32 = koffi.load('gdi32.dll');
const IS64 = process.arch === 'x64';
const GENERIC_ALL = 0x10000000;
const STARTUPINFO_SIZE = IS64 ? 104 : 68;
const PROCESS_INFORMATION_SIZE = IS64 ? 24 : 16;

const F = {};
F.GetLastError = kern32.func('int __stdcall GetLastError()');
F.CloneEnumProc = koffi.proto('int __stdcall CloneEnumProc(uint64 hwnd, long lParam)');
F.EnumDesktopWindows = user32.func('int __stdcall EnumDesktopWindows(void* hdesk, CloneEnumProc* lpEnumFunc, long lParam)');
F.GetWindowTextW = user32.func('int __stdcall GetWindowTextW(uint64 hwnd, void* lpString, int nMaxCount)');
F.GetClassNameW = user32.func('int __stdcall GetClassNameW(uint64 hwnd, void* lpString, int nMaxCount)');
F.IsWindowVisible = user32.func('int __stdcall IsWindowVisible(uint64 hwnd)');
F.GetWindowRect = user32.func('int __stdcall GetWindowRect(uint64 hwnd, void* rect)');
F.GetWindowThreadProcessId = user32.func('uint __stdcall GetWindowThreadProcessId(uint64 hwnd, void* pid)');
F.CreateProcessW = kern32.func('int __stdcall CreateProcessW(void* app, void* cmd, void* procAttr, void* thrAttr, int inherit, uint flags, void* env, void* cwd, void* si, void* pi)');
F.LocalAlloc = kern32.func('void* __stdcall LocalAlloc(uint flags, uint bytes)');
F.LocalFree = kern32.func('void* __stdcall LocalFree(void* hMem)');
F.lstrcpyW = kern32.func('void* __stdcall lstrcpyW(void* dst, void* src)');
F.OpenDesktopW = user32.func('void* __stdcall OpenDesktopW(void* lpszDesktop, uint dwFlags, int fInherit, uint dwDesiredAccess)');
F.PrintWindow = user32.func('int __stdcall PrintWindow(uint64 hwnd, void* hdcBlt, uint nFlags)');
F.CreateCompatibleDC = gdi32.func('void* __stdcall CreateCompatibleDC(void* hdc)');
F.CreateCompatibleBitmap = gdi32.func('void* __stdcall CreateCompatibleBitmap(void* hdc, int w, int h)');
// ★ 目标位图必须用 DIB：DDB 在本机接不到像素，BitBlt/PrintWindow 恒全黑
F.CreateDIBSection = gdi32.func('void* __stdcall CreateDIBSection(void* hdc, void* pbmi, uint usage, _Out_ void* ppvBits, void* hSection, uint offset)');
F.SelectObject = gdi32.func('void* __stdcall SelectObject(void* hdc, void* obj)');
F.GetDIBits = gdi32.func('int __stdcall GetDIBits(void* hdc, void* hbmp, uint start, uint cLines, void* lpvBits, void* lpbmi, uint usage)');
F.DeleteObject = gdi32.func('int __stdcall DeleteObject(void* obj)');
F.DeleteDC = gdi32.func('int __stdcall DeleteDC(void* hdc)');
F.GetSysColor = user32.func('uint __stdcall GetSysColor(int nIndex)');
F.GetDC = user32.func('void* __stdcall GetDC(void* hwnd)');
F.ReleaseDC = user32.func('int __stdcall ReleaseDC(void* hwnd, void* hdc)');
F.BitBlt = gdi32.func('int __stdcall BitBlt(void* dst, int x, int y, int w, int h, void* src, int sx, int sy, uint rop)');

const COLOR_DESKTOP = 1;

// ============================================================
// 整屏「真实桌面」合成（降分辨率单图）
// ------------------------------------------------------------
// 为什么不能直接 BitBlt 屏幕：非活动桌面的屏幕 DC 恒为 0，
// 只能靠 EnumDesktopWindows 枚举 → 逐窗口 PrintWindow → 按 z 序合���。
// EnumDesktopWindows 返回「自上而下」= 画家算法顺序（最上面的先返回），
// 合成时必须**倒序绘制**（先画最底下），否则后画的会盖住前面的。
// ============================================================

/** 分身桌面的真实屏幕尺寸（用主显示器的物理分辨率，与桌面对象一致） */
function desktopScreenSize() {
  try {
    const si = CC.screenInfo();
    if (si && si.success && si.pixelWidth > 0) {
      return { width: si.pixelWidth, height: si.pixelHeight };
    }
  } catch (e) { /* ignore */ }
  return { width: 1920, height: 1080 };
}

/** 桌面背景色（没有壁纸时铺底，避免合成出纯黑假画面） */
function desktopBaseColor() {
  try {
    const c = F.GetSysColor(COLOR_DESKTOP);
    // COLORREF 是 0x00BBGGRR
    return { r: c & 0xFF, g: (c >> 8) & 0xFF, b: (c >> 16) & 0xFF };
  } catch (e) { /* ignore */ }
  return { r: 0, g: 0, b: 0 };
}

/**
 * 整屏隔离桌面合成（降分辨率单图）—— 委托给已 attach 的辅助进程。
 * ★ 必须走辅助进程：PrintWindow 要求调用线程已 attach 到目标窗口所在桌面。
 *
 * ⚠️ 预览功能已移除，本函数保留供将来可能的诊断用途，**当前无调用方**。
 *
 * 能力现状（实测，Win11 26200）：
 *   - 窗口内容：✅ 能抓。PrintWindow + CreateDIBSection，记事本/画图等均为真实像素。
 *     （早期「抓不到」是 CreateCompatibleBitmap 的 DDB 缺陷，不是隔离桌面的限制。）
 *   - 桌面壁纸：❌ 抓不到。隔离桌面的屏幕 DC 无效 —— attach 后 GetDC(NULL) 返回
 *     0xFFFFFFFFFFFFFF75（无效句柄哨兵值），Windows 不为非活动桌面渲染壁纸。
 *     DXGI Desktop Duplication 同样不行：它只复制物理输出上 DWM 已合成的帧。
 */

/**
 * 合成用底图。
 * ⚠️ 绝不能借用户真实桌面的整屏截图当底图 —— 那会让用户误以为
 *    「程序是在我本地电脑上打开的」，正是隔离桌面要避免的错觉。
 * 这里只画一层中性渐变底，让窗口位置关系清晰可辨。
 */
let _wallpaperCache = null;
let _wallpaperAt = 0;
const WALLPAPER_TTL = 30000;

function grabWallpaper() {
  const now = Date.now();
  if (_wallpaperCache && now - _wallpaperAt < WALLPAPER_TTL) return _wallpaperCache;
  let out = null;
  try {
    const si = CC.screenInfo();
    const w = (si && si.success && si.pixelWidth) || 1920;
    const h = (si && si.success && si.pixelHeight) || 1080;
    const d = dib.create(w, h, false);
    if (d) {
      const buf = dib.read(d);
      if (buf) {
        // 中性深色渐变底：上浅下深。只为让窗口位置可辨，不冒充任何真实桌面。
        for (let y = 0; y < h; y++) {
          const t = y / h;
          const r = Math.round(26 + t * 8);
          const g = Math.round(30 + t * 10);
          const b = Math.round(38 + t * 14);
          for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 0xFF;
          }
        }
        out = { data: buf, width: w, height: h, neutral: true };
      }
      dib.destroy(d);
    }
  } catch (e) { /* ignore */ }
  _wallpaperCache = out;
  _wallpaperAt = now;
  return out;
}
/**
 * 把底图写到临时 PNG 文件，辅助进程按路径自己读。
 * 为什么不走管道内联 base64：1707x1067 的 RGBA 有 7.3MB，base64 后 9.7MB，
 * 单行 JSON 过一次命名管道会把辅助进程打挂（表现为抓帧超时、无任何报错）。
 */
function wallpaperFile() {
  const wp = grabWallpaper();
  if (!wp) return null;
  try {
    const os = require('os');
    const dir = path.join(os.tmpdir(), 'fuling-clone');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'wallpaper.png');
    // 底图直接存原始 RGBA，辅助进程按尺寸读回，省一次 PNG 编解码
    fs.writeFileSync(file, wp.data);
    return { path: file, width: wp.width, height: wp.height, bytes: wp.data.length };
  } catch (e) {
    return null;
  }
}

async function captureDesktop(opts = {}) {
  if (!_helperPipe) {
    return { success: false, error: '抓帧助手未就绪（分身桌面未启动）' };
  }
  const maxWidth = Number(opts.maxWidth) || 1280;
  let res;
  try {
    res = await requestHelper({
      action: 'capture_desktop',
      maxWidth,
      // 底图：主进程在用户真实桌面上抓的整屏画面（非活动桌面拿不到壁纸）
      wallpaper: wallpaperFile() || undefined
    }, 20000);
  } catch (e) {
    return { success: false, error: '抓帧请求失败: ' + (e && e.message || e) };
  }
  if (!res || !res.ok) {
    return { success: false, error: (res && res.error) || '辅助进程返回失败' };
  }
  const r = res.result || res;
  if (!r.png) return { success: false, error: '辅助进程未返回图像' };
  return {
    success: true,
    width: r.width, height: r.height,
    screenWidth: r.screenWidth, screenHeight: r.screenHeight,
    windowsDrawn: r.windowsDrawn,
    // 'screen' = 屏幕 DC 整屏 BitBlt（完整真实画面）；'windows' = 逐窗口 PrintWindow 合成（兜底）
    mode: r.mode || 'windows',
    png: 'data:image/png;base64,' + r.png
  };
}

/**
 * 向已 attach 到分身桌面的辅助进程发一条请求并等它的 JSON 响应。
 * 辅助进程每条命令都会回一行 { ok, seq, result? }，按 seq 配对。
 */
function requestHelper(payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!_helperPipe) { reject(new Error('抓帧助手未就绪')); return; }
    const seq = ++_seq;
    const timer = setTimeout(() => {
      _pending.delete(seq);
      reject(new Error('辅助进程响应超时'));
    }, timeoutMs || 8000);
    _pending.set(seq, { resolve, reject, timer });
    try {
      _helperPipe.write(JSON.stringify(Object.assign({ seq }, payload)) + '\n');
    } catch (e) {
      clearTimeout(timer);
      _pending.delete(seq);
      reject(e);
    }
  });
}

const DESKTOP_NAME = 'FulingClone';

let _state = 'idle';
let _helper = null;
let _helperPipe = null;
let _server = null;
let _seq = 0;
// seq → { resolve, reject, timer }：辅助进程命令的待决响应
const _pending = new Map();

function launchProcessOnDesktop(commandLine) {
  try {
    const cmd = String(commandLine || '').trim();
    if (!cmd) return { success: false, error: '需要 commandLine' };
    const desktop = 'winsta0\\' + DESKTOP_NAME;
    const desktopBuf = Buffer.from(desktop + '\0', 'utf16le');
    const LPTR = 0x0040;
    const pDesktop = F.LocalAlloc(LPTR, desktopBuf.length + 2);
    if (!pDesktop || Number(pDesktop) === 0) return { success: false, error: 'LocalAlloc 失败' };
    F.lstrcpyW(pDesktop, desktopBuf);
    const si = Buffer.alloc(STARTUPINFO_SIZE);
    si.writeUInt32LE(STARTUPINFO_SIZE, 0);
    const ptrVal = Number(pDesktop);
    if (IS64) si.writeBigUInt64LE(BigInt(ptrVal), 16); else si.writeUInt32LE(ptrVal, 12);
    const cmdBuf = Buffer.from(cmd + '\0', 'utf16le');
    const pi = Buffer.alloc(PROCESS_INFORMATION_SIZE);
    const ok = F.CreateProcessW(null, cmdBuf, null, null, 0, 0, null, null, si, pi);
    try { F.LocalFree(pDesktop); } catch (e) { /* ignore */ }
    if (!ok) return { success: false, error: 'CreateProcessW 失败，错误码=' + F.GetLastError() };
    const pid = pi.readUInt32LE(IS64 ? 16 : 8);
    return { success: true, pid, hProcess: String(pi.readBigUInt64LE(0)), desktop: DESKTOP_NAME };
  } catch (e) {
    return { success: false, error: 'launchProcessOnDesktop 异常: ' + e.message };
  }
}

// ---- 原始像素抓取（不依赖 Electron nativeImage，供独立测试验证抓帧非黑） ----
function rawCapture(hwnd) {
  try {
    const h = Number(hwnd);
    const rect = Buffer.alloc(16);
    if (!F.GetWindowRect(h, rect)) return { success: false, error: 'GetWindowRect 失败' };
    const w = rect.readInt32LE(8) - rect.readInt32LE(0);
    const ht = rect.readInt32LE(12) - rect.readInt32LE(4);
    if (w <= 0 || ht <= 0) return { success: false, error: '尺寸无效 ' + w + 'x' + ht };
    const memDC = F.CreateCompatibleDC(null);
    if (!memDC) return { success: false, error: 'CreateCompatibleDC 失败' };
    // ★ 必须用 DIB：DDB（CreateCompatibleBitmap）在本机接不到像素，恒全黑
    const bmi = Buffer.alloc(40);
    bmi.writeUInt32LE(40, 0); bmi.writeInt32LE(w, 4); bmi.writeInt32LE(ht, 8);
    bmi.writeUInt16LE(1, 12); bmi.writeUInt16LE(32, 14);
    bmi.writeUInt32LE(w * ht * 4, 20);
    const bmp = F.CreateDIBSection(memDC, bmi, 0, Buffer.alloc(16), null, 0);
    if (!bmp) { F.DeleteDC(memDC); return { success: false, error: 'CreateDIBSection 失败' }; }
    const old = F.SelectObject(memDC, bmp);
    let ok = F.PrintWindow(h, memDC, 2); // PW_RENDERFULLCONTENT
    if (!ok) ok = F.PrintWindow(h, memDC, 0);
    const pixels = Buffer.alloc(w * ht * 4);
    const lines = F.GetDIBits(memDC, bmp, 0, ht, pixels, bmi, 0);
    F.SelectObject(memDC, old); F.DeleteObject(bmp); F.DeleteDC(memDC);
    if (lines <= 0) return { success: false, error: 'GetDIBits 失败' };
    // 统计非黑像素比例 + 校验和（BGRA 小端：0x00BGR）
    let nonBlack = 0; let sum = 0;
    for (let i = 0; i < w * ht; i++) {
      const b = pixels[i * 4], g = pixels[i * 4 + 1], r = pixels[i * 4 + 2];
      if (r > 8 || g > 8 || b > 8) nonBlack++;
      sum = (sum + r + g + b) % 1000000;
    }
    return { success: true, width: w, height: ht, printOk: !!ok, nonBlackRatio: nonBlack / (w * ht), sum, buf: pixels };
  } catch (e) {
    return { success: false, error: 'rawCapture 异常: ' + e.message };
  }
}

async function listWindows() {
  const opened = await CC.createDesktop(DESKTOP_NAME);
  if (!opened.success) return { success: false, error: opened.error };
  try {
    const hOpen = F.OpenDesktopW(Buffer.from(DESKTOP_NAME + '\0', 'utf16le'), 0, 0, GENERIC_ALL);
    if (!hOpen) return { success: false, error: 'OpenDesktopW 失败 err=' + F.GetLastError() };
    const results = [];
    const cb = koffi.register((hwnd) => {
      try {
        if (!F.IsWindowVisible(hwnd)) return 1;
        const titleBuf = Buffer.alloc(512);
        const n = F.GetWindowTextW(hwnd, titleBuf, 255);
        const title = n > 0 ? titleBuf.toString('utf16le', 0, n * 2) : '';
        const clsBuf = Buffer.alloc(128);
        const cn = F.GetClassNameW(hwnd, clsBuf, 127);
        const cls = cn > 0 ? clsBuf.toString('utf16le', 0, cn * 2) : '';
        const rect = Buffer.alloc(16);
        F.GetWindowRect(hwnd, rect);
        const left = rect.readInt32LE(0), top = rect.readInt32LE(4);
        const right = rect.readInt32LE(8), bottom = rect.readInt32LE(12);
        const pidBuf = Buffer.alloc(4);
        F.GetWindowThreadProcessId(hwnd, pidBuf);
        results.push({
          hwnd: String(hwnd), title, className: cls,
          rect: { left, top, right, bottom },
          width: right - left, height: bottom - top,
          pid: pidBuf.readUInt32LE(0)
        });
      } catch (e) { /* ignore single window */ }
      return 1;
    }, koffi.pointer(F.CloneEnumProc));
    F.EnumDesktopWindows(hOpen, cb, 0);
    const vis = results.filter((w) => (w.title && w.title.length > 0) || (w.width > 0 && w.height > 0));
    return { success: true, windows: vis, count: vis.length };
  } catch (e) {
    return { success: false, error: 'listWindows 异常: ' + e.message };
  }
}

async function captureFrame(opts = {}) {
  const lst = await listWindows();
  if (!lst.success) return { success: false, error: lst.error };
  const frames = [];
  for (const w of lst.windows) {
    if (w.width <= 0 || w.height <= 0) continue;
    const shot = await CC.captureWindowByHwnd(w.hwnd, { maxWidth: opts.maxWidth || 900 });
    if (shot && shot.success) {
      frames.push({
        hwnd: w.hwnd, title: w.title,
        x: w.rect.left, y: w.rect.top,
        width: shot.width, height: shot.height,
        png: 'data:image/png;base64,' + shot.buffer.toString('base64')
      });
    }
  }
  return { success: true, frames, count: frames.length, desktop: DESKTOP_NAME };
}

async function startInputHelper() {
  if (_helper && !_helper.killed) return { success: true, already: true };
  const pipeName = 'fuling-clone-input-' + process.pid + '-' + Date.now();
  // 命名管道服务端：编排器监听，助手作为客户端连接
  _server = net.createServer((sock) => {
    _helperPipe = sock;
    // 助手对每条命令回一行 JSON（{ ok, seq, result? }），按 seq 唤醒对应等待者
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (e) { continue; }
        const waiter = _pending.get(msg.seq);
        if (!waiter) continue;
        _pending.delete(msg.seq);
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      }
    });
    sock.on('close', () => {
      // 助手退出 → 所有等待者立即失败，避免调用方干等超时
      for (const [, waiter] of _pending) { clearTimeout(waiter.timer); waiter.reject(new Error('抓帧助手已断开')); }
      _pending.clear();
      _helperPipe = null;
    });
    sock.on('error', () => { /* ignore */ });
  });
  await new Promise((resolve, reject) => {
    _server.on('error', (e) => reject(e));
    _server.listen('\\\\.\\pipe\\' + pipeName, () => resolve());
  });

  const exe = process.execPath;
  const prev = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ELECTRON_RUN_AS_NODE = '1';
  try {
    _helper = spawn(exe, [path.join(__dirname, 'cloneInputHelper.js'), pipeName, DESKTOP_NAME], {
      windowsHide: true,
      // stdout/stderr 走 pipe：抓帧异常要能落到日志里（stdio:'ignore' 会静默到死）
      stdio: ['ignore', 'pipe', 'pipe']
    });
    if (_helper.stdout) {
      _helper.stdout.on('data', (d) => {
        const s = d.toString();
        if (process.env.FULING_CLONE_DEBUG) console.log('[clone-helper]', s.trim());
      });
    }
    if (_helper.stderr) {
      _helper.stderr.on('data', (d) => {
        console.error('[clone-helper:err]', d.toString().trim());
      });
    }
  } finally {
    if (prev === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = prev;
  }
  _helper.on('error', () => { _helperPipe = null; });
  _helper.on('exit', () => { _helper = null; _helperPipe = null; });

  // 等待助手连接
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (!_helper) return { success: false, error: '助手进程提前退出（可能 SetThreadDesktop 失败）' };
    if (_helperPipe) break;
    await new Promise((r) => setTimeout(r, 120));
  }
  if (!_helperPipe) return { success: false, error: '连接输入助手超时' };
  return { success: true };
}

function sendInput(actions) {
  if (!_helperPipe) return { success: false, error: '输入助手未就绪' };
  const list = Array.isArray(actions) ? actions : [actions];
  for (const a of list) {
    const line = JSON.stringify(Object.assign({ seq: ++_seq }, a)) + '\n';
    _helperPipe.write(line);
  }
  return { success: true, sent: list.length };
}

async function start(opts = {}) {
  if (_state === 'running') return { success: true, state: 'running', desktop: DESKTOP_NAME };
  const ok = await CC.createDesktop(DESKTOP_NAME);
  if (!ok.success) { _state = 'error'; return { success: false, error: ok.error }; }
  const h = await startInputHelper();
  if (!h.success) { _state = 'error'; return { success: false, error: h.error }; }
  _state = 'running';
  return { success: true, state: 'running', desktop: DESKTOP_NAME, desktopActive: false, note: '隐藏桌面已就绪，未切前台、未抢光标' };
}

function status() {
  return {
    state: _state, desktop: DESKTOP_NAME,
    helperRunning: !!(_helper && !_helper.killed),
    helperPipe: !!_helperPipe,
    createDesktopSupported: true,
    // 定位：仅用于「不需要看界面」的任务，跑完用文本汇报结果。
    // 画面预览已移除（隐藏桌面无壁纸/桌面背景渲染，中性底预览不是真实桌面）。
    purpose: 'isolate-no-ui',
    purposeNote: '隔离桌面用于编译/跑脚本/后台程序等不需要看界面的任务；' +
      '需要看或操作界面的任务在用户真实桌面进行。',
    previewAvailable: false,
    captureNote: '隔离桌面不提供画面预览。窗口内容技术上可抓（PrintWindow + CreateDIBSection），' +
      '但桌面壁纸/桌面背景 Windows 不为非活动桌面渲染，所以没有完整桌面画面。'
  };
}

function stop() {
  try { if (_helperPipe) _helperPipe.destroy(); } catch (e) { /* ignore */ }
  try { if (_server) _server.close(); } catch (e) { /* ignore */ }
  try { if (_helper) _helper.kill(); } catch (e) { /* ignore */ }
  _helper = null; _helperPipe = null; _server = null; _state = 'idle';
  return { success: true };
}

module.exports = {
  DESKTOP_NAME,
  start, status, stop,
  launch: launchProcessOnDesktop,
  windows: listWindows,
  captureFrame,
  captureDesktop,
  rawCapture,
  sendInput
};
