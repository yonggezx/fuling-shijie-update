/**
 * 电脑控制（Computer Use）：让 AI 能像人一样操作鼠标和键盘，进行界面交互测试。
 *
 * 基于 koffi 调用 Windows user32 API（SetCursorPos / mouse_event / SendInput / 窗口枚举）。
 * ⚠️ 这些调用会真实驱动系统鼠标/键盘，影响当前用户会话——这是 computer-use 的本意。
 *    调用方（AI）应只在「验证某个程序界面」这种明确场景下使用，并尽量给出精确坐标。
 *
 * 仅 Windows 平台可用；其它平台返回明确错误。
 *
 * 对外接口：
 *   screenInfo()                       屏幕尺寸 + DPI 换算（截图像素 ↔ 系统坐标）
 *   listWindows(keyword?)              列出可见窗口（标题 + 位置大小 + hwnd）
 *   findWindow(title)                  按标题关键字找窗口（精确优先，其次包含）
 *   focusWindow(titleOrHwnd)           把窗口置前（优先 ShowWindow+SetForegroundWindow，失败走 AttachThreadInput）
 *   getCursorPos()                     当前鼠标位置
 *   moveMouse(x, y)
 *   clickMouse(x, y, { button, double, hold })
 *   dragMouse(x1,y1,x2,y2,{steps})     拖拽
 *   scrollMouse(delta, x, y)           滚轮
 *   typeText(text, { delay, window })  Unicode 输入（中文可用）
 *   pressKey(key)                      单键
 *   hotkey(keys)                       组合键
 *   getClipboard() / setClipboard(t)   剪贴板（用于读取界面信息 / 粘贴大段文本）
 *   control(action, params)            统一入口，供 agent 工具调用（支持 steps 批量 + dryRun 预演）
 *
 * 2026-10-03 修复「无法代替人输入相关信息和鼠标操作」：
 *   1. 中文/Unicode 输入以前用 keybd_event，它的 bScan 是 BYTE（uint8），码点 >255 被截断 → 中文全是乱码。
 *      改为 SendInput + KEYBDINPUT（wScan 是 WORD，可放 UTF-16 码元，代理对也会拆开）。
 *   2. 以前只有裸坐标，AI 根本不知道点哪 → 新增窗口枚举/定位/聚焦/取矩形，
 *      并支持「先聚焦窗口 → 再点/输入」的组合动作 steps。
 *   3. 新增拖拽、滚轮、右键/中键、按住不放、剪贴板读写 —— 覆盖"代替人操作"的基本面。
 *   4. DPI 换算：截图是物理像素，而 DPI 未感知进程里 user32 坐标是逻辑像素，
 *      点错 1.5 倍是"鼠标操作永远不准"的元凶 → coordScale() 自动换算。
 */

'use strict';

const koffi = require('koffi');

let user32 = null;
let kernel32 = null;
let gdi32 = null;
let F = {};
let apiError = null;

// 鼠标事件标志
const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
const MOUSEEVENTF_MIDDLEUP = 0x0040;
const MOUSEEVENTF_WHEEL = 0x0800;
const MOUSEEVENTF_HWHEEL = 0x01000;

// 键盘事件标志
const KEYEVENTF_EXTENDEDKEY = 0x0001;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;
const INPUT_KEYBOARD = 1;

const SW_RESTORE = 9;
const SW_SHOW = 5;

// 常用虚拟键码（按名字索引）
const VK = {
  enter: 0x0D,
  return: 0x0D,
  tab: 0x09,
  backspace: 0x08,
  delete: 0x2E,
  esc: 0x1B,
  escape: 0x1B,
  space: 0x20,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  left: 0x25,
  up: 0x26,
  right: 0x27,
  down: 0x28,
  insert: 0x2D,
  ctrl: 0x11,
  control: 0x11,
  shift: 0x10,
  alt: 0x12,
  menu: 0x12,
  win: 0x5B,
  lwin: 0x5B,
  rwin: 0x5C,
  capslock: 0x14,
  numlock: 0x90,
  printscreen: 0x2C,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74,
  f6: 0x75, f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7A, f12: 0x7B
};

// 需要 EXTENDEDKEY 的键（小键盘/方向键/Win 等，避免被当成主键盘区）
const EXTENDED_VK = new Set([0x2E, 0x2D, 0x24, 0x23, 0x21, 0x22, 0x25, 0x26, 0x27, 0x28, 0x5B, 0x5C, 0x13]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const IS64 = process.arch !== 'ia32';
const INPUT_SIZE = IS64 ? 40 : 28;   // sizeof(INPUT)
const KI_OFFSET = IS64 ? 8 : 4;      // INPUT 里 KEYBDINPUT 的起始偏移

/** 构造一个键盘 INPUT（SendInput 用）。手写 Buffer 避开 koffi 的 union 限制。 */
function keyInputBuffer(vk, scan, flags) {
  const b = Buffer.alloc(INPUT_SIZE);
  b.writeUInt32LE(INPUT_KEYBOARD, 0);
  b.writeUInt16LE(vk & 0xffff, KI_OFFSET);           // wVk
  b.writeUInt16LE(scan & 0xffff, KI_OFFSET + 2);     // wScan（UNICODE 模式放 UTF-16 码元）
  b.writeUInt32LE(flags >>> 0, KI_OFFSET + 4);       // dwFlags
  b.writeUInt32LE(0, KI_OFFSET + 8);                 // time（0 = 系统自己填）
  if (IS64) b.writeBigUInt64LE(0n, KI_OFFSET + 16);  // dwExtraInfo (ULONG_PTR)
  else b.writeUInt32LE(0, KI_OFFSET + 12);
  return b;
}

function initWinAPI() {
  if (user32) return true;
  if (process.platform !== 'win32') {
    apiError = '仅支持 Windows 平台';
    return false;
  }
  try {
    user32 = koffi.load('user32.dll');
    kernel32 = koffi.load('kernel32.dll');
    F.SetCursorPos = user32.func('int __stdcall SetCursorPos(int X, int Y)');
    F.mouse_event = user32.func('void __stdcall mouse_event(long dwFlags, long dx, long dy, long dwData, long dwExtraInfo)');
    F.keybd_event = user32.func('void __stdcall keybd_event(uint8 bVk, uint8 bScan, long dwFlags, long dwExtraInfo)');
    F.GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int nIndex)');
    F.SendInput = user32.func('uint __stdcall SendInput(uint cInputs, void* pInputs, int cbSize)');
    F.GetCursorPos = user32.func('int __stdcall GetCursorPos(_Out_ void* lpPoint)');
    F.GetLastError = kernel32.func('uint __stdcall GetLastError()');

    // 窗口相关：HWND 一律用 uint64 传/收（返回的是普通 number，方便当句柄回传）
    F.FindWindowW = user32.func('uint64 __stdcall FindWindowW(void* lpClassName, void* lpWindowName)');
    F.GetForegroundWindow = user32.func('uint64 __stdcall GetForegroundWindow()');
    F.IsWindowVisible = user32.func('int __stdcall IsWindowVisible(uint64 hwnd)');
    F.IsIconic = user32.func('int __stdcall IsIconic(uint64 hwnd)');
    F.GetWindowTextLengthW = user32.func('int __stdcall GetWindowTextLengthW(uint64 hwnd)');
    F.GetWindowTextW = user32.func('int __stdcall GetWindowTextW(uint64 hwnd, _Out_ void* lpString, int nMaxCount)');
    F.GetWindowRect = user32.func('int __stdcall GetWindowRect(uint64 hwnd, _Out_ void* lpRect)');
    F.ShowWindow = user32.func('int __stdcall ShowWindow(uint64 hwnd, int nCmdShow)');
    F.SetForegroundWindow = user32.func('int __stdcall SetForegroundWindow(uint64 hwnd)');
    F.BringWindowToTop = user32.func('int __stdcall BringWindowToTop(uint64 hwnd)');
    F.SetActiveWindow = user32.func('uint64 __stdcall SetActiveWindow(uint64 hwnd)');
    F.GetWindowThreadProcessId = user32.func('uint __stdcall GetWindowThreadProcessId(uint64 hwnd, void* lpdwProcessId)');
    F.AttachThreadInput = user32.func('int __stdcall AttachThreadInput(uint idAttach, uint idAttachTo, int fAttach)');
    F.EnumWindowsProc = koffi.proto('int __stdcall EnumWindowsProc(uint64 hwnd, long lParam)');
    F.EnumWindows = user32.func('int __stdcall EnumWindows(EnumWindowsProc* lpEnumFunc, long lParam)');

    // ===== 枚举指定桌面的窗口（用于找分身桌面里的窗口）=====
    // OpenDesktopW：按名称打开桌面句柄
    // CloseDesktop：关闭桌面句柄
    // EnumDesktopWindows：枚举指定桌面的所有顶层窗口
    F.OpenDesktopW = user32.func('void* __stdcall OpenDesktopW(void* lpszDesktop, uint dwFlags, int fInherit, uint dwDesiredAccess)');
    F.CloseDesktop = user32.func('int __stdcall CloseDesktop(void* hDesktop)');
    F.EnumDesktopWindows = user32.func('int __stdcall EnumDesktopWindows(void* hDesktop, EnumWindowsProc* lpEnumFunc, long lParam)');
    // CreateDesktopW：创建独立桌面对象（真正的桌面隔离，不是虚拟桌面）
    F.CreateDesktopW = user32.func('void* __stdcall CreateDesktopW(void* lpszDesktop, void* lpszDevice, void* pDevmode, uint dwFlags, uint dwDesiredAccess, void* lpsa)');

    // ===== 后台消息注入（不切换桌面、不激活窗口，直接向 hwnd 发消息）=====
    // PostMessage：异步，不等待处理结果（鼠标/键盘输入用这个，不阻塞）
    // SendMessage：同步，等待返回值（某些查询类操作用）
    // ScreenToClient：屏幕坐标 → 窗口客户区坐标
    // MapVirtualKeyW：虚拟键码 → 扫描码（后台键盘输入需要）
    F.PostMessageW = user32.func('int64 __stdcall PostMessageW(uint64 hWnd, uint32 Msg, uint64 wParam, int64 lParam)');
    F.SendMessageW = user32.func('int64 __stdcall SendMessageW(uint64 hWnd, uint32 Msg, uint64 wParam, int64 lParam)');
    F.ScreenToClient = user32.func('int __stdcall ScreenToClient(uint64 hWnd, _Out_ void* lpPoint)');
    F.MapVirtualKeyW = user32.func('uint __stdcall MapVirtualKeyW(uint uCode, uint uMapType)');
    F.IsWindow = user32.func('int __stdcall IsWindow(uint64 hWnd)');
    // PrintWindow：把窗口画面绘制到指定 DC，可抓取不在前台、甚至在另一个虚拟桌面的窗口
    F.PrintWindow = user32.func('int __stdcall PrintWindow(uint64 hwnd, void* hdcBlt, uint nFlags)');

    // ===== GDI（截图用）=====
    gdi32 = koffi.load('gdi32.dll');
    F.CreateCompatibleDC = gdi32.func('void* __stdcall CreateCompatibleDC(void* hdc)');
    F.CreateCompatibleBitmap = gdi32.func('void* __stdcall CreateCompatibleBitmap(void* hdc, int cx, int cy)');
    // ★ 目标位图必须用 DIB：CreateCompatibleBitmap 建的 DDB 在本机接不到任何像素
    F.CreateDIBSection = gdi32.func('void* __stdcall CreateDIBSection(void* hdc, void* pbmi, uint usage, _Out_ void* ppvBits, void* hSection, uint dwOffset)');
    F.SelectObject = gdi32.func('void* __stdcall SelectObject(void* hdc, void* h)');
    F.DeleteDC = gdi32.func('int __stdcall DeleteDC(void* hdc)');
    F.DeleteObject = gdi32.func('int __stdcall DeleteObject(void* h)');
    F.GetDIBits = gdi32.func('int __stdcall GetDIBits(void* hdc, void* hbmp, uint start, uint cLines, void* lpvBits, void* lpbmi, uint usage)');
    F.GetObjectW = gdi32.func('int __stdcall GetObjectW(void* h, int c, void* pv)');
    F.StretchBlt = gdi32.func('int __stdcall StretchBlt(void* hdc, int xDest, int yDest, int wDest, int hDest, void* hdcSrc, int xSrc, int ySrc, int wSrc, int hSrc, uint rop)');
    F.SetStretchBltMode = gdi32.func('int __stdcall SetStretchBltMode(void* hdc, int mode)');

    // ===== 进程创建（用于在指定桌面启动程序）=====
    // CreateProcessW 的 STARTUPINFO.lpDesktop 可以指定在哪个桌面启动进程，
    // 这样就能在 AI 分身桌面里启动浏览器/记事本等，不需要切换用户桌面。
    F.CreateProcessW = kernel32.func('int __stdcall CreateProcessW(void* lpApplicationName, void* lpCommandLine, void* lpProcessAttributes, void* lpThreadAttributes, int bInheritHandles, uint dwCreationFlags, void* lpEnvironment, void* lpCurrentDirectory, _Out_ void* lpStartupInfo, _Out_ void* lpProcessInformation)');
    F.CloseHandle = kernel32.func('int __stdcall CloseHandle(void* hObject)');
    apiError = null;
    return true;
  } catch (e) {
    apiError = '初始化 Windows API 失败: ' + e.message;
    console.error('[ComputerControl] ' + apiError);
    return false;
  }
}

function ensure() {
  if (!initWinAPI()) return { success: false, error: apiError || 'Windows API 不可用' };
  return null;
}

/**
 * 截图像素 ↔ user32 坐标的换算比例。
 * 截图（desktopCapturer）给的是物理像素；而进程若未声明 DPI 感知，user32 的坐标是逻辑像素
 * （150% 缩放下差 1.5 倍，点击就永远点不准）。
 * 返回：user32坐标 = 截图像素 / coordScale()
 */
function coordScale() {
  if (!initWinAPI()) return 1;
  let physW = 0;
  try {
    // Electron 里用 screen 模块拿真实物理尺寸最准
    // eslint-disable-next-line global-require
    const { screen } = require('electron');
    const d = screen.getPrimaryDisplay();
    physW = Math.round((d.size && d.size.width || 0) * (d.scaleFactor || 1));
  } catch (e) { physW = 0; }
  let sysW = 0;
  try { sysW = F.GetSystemMetrics(0); } catch (e) { sysW = 0; }
  if (physW > 0 && sysW > 0 && Math.abs(physW - sysW) > 4) return physW / sysW;
  return 1;
}

/** 把「截图物理像素」转成 SetCursorPos 要的坐标。 */
function toUser32(x, y) {
  const s = coordScale();
  return { x: Math.round(Number(x) / s), y: Math.round(Number(y) / s), scale: s };
}

function screenInfo() {
  const bad = ensure();
  if (bad) return bad;
  const scale = coordScale();
  let w = 0, h = 0;
  try { w = F.GetSystemMetrics(0); h = F.GetSystemMetrics(1); } catch (e) { /* 忽略 */ }
  return {
    success: true,
    // user32 坐标系下的尺寸（点击/移动就用这个坐标系）
    width: w, height: h,
    // 截图坐标系（物理像素）
    pixelWidth: Math.round(w * scale), pixelHeight: Math.round(h * scale),
    dpiScale: scale,
    note: scale === 1
      ? '点击坐标与截图像素一致，可直接用截图里的像素坐标。'
      : '截图是物理像素，系统坐标是逻辑像素（比例 ' + scale.toFixed(2) + '）：传截图像素坐标会自动换算，也可以直接传系统坐标（先把 dpiScale 除掉）。'
  };
}

// ============================================================
// 窗口枚举 / 定位 / 聚焦（"代替人操作"的前提：先知道点哪）
// ============================================================

function windowTitleOf(hwnd) {
  try {
    const len = F.GetWindowTextLengthW(hwnd);
    if (!len) return '';
    const b = Buffer.alloc((len + 1) * 2);
    const n = F.GetWindowTextW(hwnd, b, len + 1);
    return n > 0 ? b.toString('utf16le', 0, n * 2) : '';
  } catch (e) { return ''; }
}

function windowRectOf(hwnd) {
  try {
    const b = Buffer.alloc(16);
    if (!F.GetWindowRect(hwnd, b)) return null;
    const r = { x: b.readInt32LE(0), y: b.readInt32LE(4), width: b.readInt32LE(8) - b.readInt32LE(0), height: b.readInt32LE(12) - b.readInt32LE(4) };
    const s = coordScale();
    return { ...r, pixel: { x: Math.round(r.x * s), y: Math.round(r.y * s), width: Math.round(r.width * s), height: Math.round(r.height * s) } };
  } catch (e) { return null; }
}

/** 列出可见且有标题的窗口。 */
function listWindows(keyword) {
  const bad = ensure();
  if (bad) return bad;
  const list = [];
  try {
    const cb = koffi.register((hwnd) => {
      try {
        if (!F.IsWindowVisible(hwnd)) return 1;
        const title = windowTitleOf(hwnd);
        if (!title) return 1;
        if (keyword && title.toLowerCase().indexOf(String(keyword).toLowerCase()) < 0) return 1;
        const rect = windowRectOf(hwnd);
        if (rect && (rect.width < 2 || rect.height < 2)) return 1;
        // 最小化窗口的坐标是 -32000 之类的魔法值，列出来只会误导点击
        if (rect && (rect.x < -10000 || rect.y < -10000)) return 1;
        list.push({ hwnd: String(hwnd), title, rect });
      } catch (e) { /* 忽略单个窗口的错误 */ }
      return 1;
    }, koffi.pointer(F.EnumWindowsProc));
    F.EnumWindows(cb, 0);
  } catch (e) {
    return { success: false, error: '枚举窗口失败: ' + e.message };
  }
  return { success: true, count: list.length, windows: list.slice(0, 60) };
}

/** 按标题找窗口：精确 → 包含 → 前缀。返回 {hwnd,title,rect} 或 null。 */
function findWindow(title) {
  const bad = ensure();
  if (bad) return null;
  const t = String(title || '').trim();
  if (!t) return null;
  // 1) 精确标题最快（FindWindowW 要求完全一致）
  try {
    const h = F.FindWindowW(null, Buffer.from(t + '\0', 'utf16le'));
    if (h) return { hwnd: String(h), title: windowTitleOf(h) || t, rect: windowRectOf(h) };
  } catch (e) { /* 忽略 */ }
  // 2) 枚举包含匹配
  const r = listWindows(t);
  if (r.success && r.windows && r.windows.length) {
    // 标题最短的通常是最精确的匹配
    r.windows.sort((a, b) => a.title.length - b.title.length);
    return r.windows[0];
  }
  return null;
}

/**
 * 在指定桌面（按名称）中枚举顶层窗口，按标题关键字查找。
 * 用于找分身桌面里的窗口（FindWindow/EnumWindows 只能找当前桌面）。
 * @param {string} desktopName 桌面名称，如 'AI 桌面分身'
 * @param {string} titleKeyword 窗口标题关键字（包含匹配）
 * @returns {{hwnd:string,title:string,rect:object}|null}
 */
function findWindowOnDesktop(desktopName, titleKeyword) {
  const bad = ensure();
  if (bad) return null;
  const name = String(desktopName || '').trim();
  const keyword = String(titleKeyword || '').trim();
  if (!name) return null;

  let hDesktop = null;
  try {
    // DESKTOP_ENUMERATE = 0x0040, DESKTOP_READOBJECTS = 0x0001
    hDesktop = F.OpenDesktopW(Buffer.from(name + '\0', 'utf16le'), 0, 0, 0x0041);
    if (!hDesktop) return null;

    const list = [];
    const cb = koffi.register((hwnd) => {
      if (!hwnd) return 1;
      try {
        if (!F.IsWindowVisible(hwnd)) return 1;
        const title = windowTitleOf(hwnd);
        if (!title) return 1;
        if (!keyword || title.toLowerCase().includes(keyword.toLowerCase())) {
          list.push({ hwnd: String(hwnd), title, rect: windowRectOf(hwnd) });
        }
      } catch (e) { /* ignore */ }
      return 1;
    }, koffi.pointer(F.EnumWindowsProc));
    F.EnumDesktopWindows(hDesktop, cb, 0);

    if (list.length) {
      list.sort((a, b) => a.title.length - b.title.length);
      return list[0];
    }
    return null;
  } catch (e) {
    return null;
  } finally {
    if (hDesktop) {
      try { F.CloseDesktop(hDesktop); } catch (e) { /* ignore */ }
    }
  }
}

/**
 * 列出指定桌面的所有可见且有标题的窗口。
 * @param {string} desktopName 桌面名称
 * @param {string} keyword 可选标题关键字过滤
 * @returns {{success:boolean, count:number, windows:Array}}
 */
function listWindowsOnDesktop(desktopName, keyword) {
  const bad = ensure();
  if (bad) return bad;
  const name = String(desktopName || '').trim();
  if (!name) return { success: false, error: '需要桌面名称' };

  let hDesktop = null;
  try {
    hDesktop = F.OpenDesktopW(Buffer.from(name + '\0', 'utf16le'), 0, 0, 0x0041);
    if (!hDesktop) return { success: false, error: '无法打开桌面: ' + name };

    const list = [];
    const kw = keyword ? String(keyword).toLowerCase() : '';
    const cb = koffi.register((hwnd) => {
      if (!hwnd) return 1;
      try {
        if (!F.IsWindowVisible(hwnd)) return 1;
        const title = windowTitleOf(hwnd);
        if (!title) return 1;
        if (kw && !title.toLowerCase().includes(kw)) return 1;
        const rect = windowRectOf(hwnd);
        if (rect && (rect.width < 2 || rect.height < 2)) return 1;
        list.push({ hwnd: String(hwnd), title, rect });
      } catch (e) { /* ignore */ }
      return 1;
    }, koffi.pointer(F.EnumWindowsProc));
    F.EnumDesktopWindows(hDesktop, cb, 0);

    return { success: true, count: list.length, windows: list.slice(0, 60) };
  } catch (e) {
    return { success: false, error: '枚举桌面窗口失败: ' + ((e && e.message) || String(e)) };
  } finally {
    if (hDesktop) {
      try { F.CloseDesktop(hDesktop); } catch (e) { /* ignore */ }
    }
  }
}

// 已打开的桌面句柄缓存（保持桌面活跃，关闭句柄会导致无进程的桌面被销毁）
const _openDesktops = {};

/**
 * 创建独立桌面对象（CreateDesktopW）。如果已存在则打开它。
 * 这是真正的桌面隔离（不是 Windows 10/11 的虚拟桌面）：
 * 新桌面有独立的窗口站和消息队列，在里面启动的程序对用户桌面完全不可见。
 * 注意：保持桌面句柄打开，否则无进程的桌面会被系统销毁。
 * @param {string} desktopName 桌面名称
 * @returns {Promise<{success:boolean, desktop:string, created:boolean, error?:string}>}
 */
/**
 * 获取桌面根窗口句柄（GetDesktopWindow）
 * 用于在所有应用窗口都全黑时，直接抓取整个桌面画面
 * @returns {number|null} 桌面窗口句柄
 */
function getDesktopWindow() {
  const bad = ensure();
  if (bad) return null;
  try {
    return user32.GetDesktopWindow();
  } catch (e) {
    console.log('[getDesktopWindow] 失败:', e.message);
    return null;
  }
}

async function createDesktop(desktopName) {
  const bad = ensure();
  if (bad) return bad;
  const name = String(desktopName || '').trim();
  if (!name) return { success: false, error: '需要桌面名称' };

  // 已缓存句柄 → 桌面已存在且活跃
  if (_openDesktops[name]) {
    return { success: true, desktop: name, created: false, reused: true };
  }

  try {
    const GENERIC_ALL = 0x10000000;
    const nameBuf = Buffer.from(name + '\0', 'utf16le');

    // 先尝试打开（已存在则直接成功）
    let hDesktop = F.OpenDesktopW(nameBuf, 0, 0, GENERIC_ALL);
    if (hDesktop) {
      _openDesktops[name] = hDesktop; // 保持句柄
      return { success: true, desktop: name, created: false };
    }

    // 不存在则创建
    hDesktop = F.CreateDesktopW(nameBuf, null, null, 0, GENERIC_ALL, null);
    if (!hDesktop) {
      const err = F.GetLastError ? F.GetLastError() : 0;
      return { success: false, error: 'CreateDesktopW 失败，错误码: ' + err };
    }
    _openDesktops[name] = hDesktop; // 保持句柄，桌面保持活跃
    return { success: true, desktop: name, created: true };
  } catch (e) {
    return { success: false, error: '创建桌面失败: ' + ((e && e.message) || String(e)) };
  }
}

/** 把窗口置前（失败时用 AttachThreadInput 绕过 Windows 的抢焦点限制）。 */
async function focusWindow(titleOrHwnd, opts = {}) {
  const bad = ensure();
  if (bad) return bad;
  let hwnd = 0;
  let title = '';
  if (typeof titleOrHwnd === 'number' || /^\d+$/.test(String(titleOrHwnd || ''))) {
    hwnd = Number(titleOrHwnd);
    title = windowTitleOf(hwnd);
  } else {
    const w = findWindow(titleOrHwnd);
    if (!w) return { success: false, error: '没找到标题包含「' + titleOrHwnd + '」的窗口（可先用 action=windows 列一下）' };
    hwnd = Number(w.hwnd);
    title = w.title;
  }
  // ⚠️ dryRun 绝不能真抢焦点（预演也会打扰用户）
  if (opts.dryRun) return { success: true, dryRun: true, action: 'focus', hwnd: String(hwnd), title, rect: windowRectOf(hwnd) };
  try {
    if (F.IsIconic(hwnd)) F.ShowWindow(hwnd, SW_RESTORE);
    else F.ShowWindow(hwnd, SW_SHOW);
    await sleep(60);
    let ok = F.SetForegroundWindow(hwnd);
    if (!ok) {
      const cur = F.GetForegroundWindow();
      const curThread = cur ? F.GetWindowThreadProcessId(cur, null) : 0;
      const tgtThread = F.GetWindowThreadProcessId(hwnd, null);
      if (curThread && tgtThread && curThread !== tgtThread) {
        F.AttachThreadInput(curThread, tgtThread, true);
        ok = F.SetForegroundWindow(hwnd);
        try { F.BringWindowToTop(hwnd); } catch (e) { /* 忽略 */ }
        F.AttachThreadInput(curThread, tgtThread, false);
      }
    }
    if (!ok) {
      try { F.SetActiveWindow(hwnd); } catch (e) { /* 忽略 */ }
    }
    await sleep(120);
    const now = F.GetForegroundWindow();
    return {
      success: true, hwnd: String(hwnd), title,
      foreground: Number(now) === Number(hwnd),
      rect: windowRectOf(hwnd)
    };
  } catch (e) {
    return { success: false, error: '聚焦窗口失败: ' + e.message };
  }
}

// ============================================================
// 鼠标
// ============================================================

function getCursorPos() {
  const bad = ensure();
  if (bad) return bad;
  try {
    const b = Buffer.alloc(8);
    if (!F.GetCursorPos(b)) return { success: false, error: 'GetCursorPos 失败' };
    const x = b.readInt32LE(0), y = b.readInt32LE(4);
    const s = coordScale();
    return { success: true, x, y, pixel: { x: Math.round(x * s), y: Math.round(y * s) } };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function moveMouse(x, y, opts = {}) {
  const bad = ensure();
  if (bad) return bad;
  const p = opts.raw ? { x: Math.round(Number(x)), y: Math.round(Number(y)), scale: 1 } : toUser32(x, y);
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0) {
    return { success: false, error: '坐标无效: (' + x + ',' + y + ')' };
  }
  if (opts.dryRun) return { success: true, dryRun: true, action: 'move', x: p.x, y: p.y };
  try {
    F.SetCursorPos(p.x, p.y);
    await sleep(20);
    return { success: true, x: p.x, y: p.y };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

const BUTTON_FLAGS = {
  left: [MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP],
  right: [MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP],
  middle: [MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP]
};

async function clickMouse(x, y, opts = {}) {
  const bad = ensure();
  if (bad) return bad;
  const p = opts.raw ? { x: Math.round(Number(x)), y: Math.round(Number(y)), scale: 1 } : toUser32(x, y);
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0) {
    return { success: false, error: '坐标无效: (' + x + ',' + y + ')' };
  }
  const button = (opts.button || 'left').toLowerCase();
  const flags = BUTTON_FLAGS[button] || BUTTON_FLAGS.left;
  const times = opts.double ? 2 : 1;
  if (opts.dryRun) return { success: true, dryRun: true, action: 'click', x: p.x, y: p.y, button, times };
  try {
    F.SetCursorPos(p.x, p.y);
    await sleep(40);
    for (let i = 0; i < times; i++) {
      F.mouse_event(flags[0], 0, 0, 0, 0);
      await sleep(30);
      F.mouse_event(flags[1], 0, 0, 0, 0);
      await sleep(times > 1 ? 60 : 30);
    }
    return { success: true, x: p.x, y: p.y, button, double: !!opts.double };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/** 按住左键从 (x1,y1) 拖到 (x2,y2)。 */
async function dragMouse(x1, y1, x2, y2, opts = {}) {
  const bad = ensure();
  if (bad) return bad;
  const a = opts.raw ? { x: Math.round(Number(x1)), y: Math.round(Number(y1)) } : toUser32(x1, y1);
  const b = opts.raw ? { x: Math.round(Number(x2)), y: Math.round(Number(y2)) } : toUser32(x2, y2);
  const steps = Math.max(2, Math.min(60, Number(opts.steps) || 20));
  const button = (opts.button || 'left').toLowerCase();
  const flags = BUTTON_FLAGS[button] || BUTTON_FLAGS.left;
  if (opts.dryRun) return { success: true, dryRun: true, action: 'drag', from: a, to: b, steps };
  try {
    F.SetCursorPos(a.x, a.y);
    await sleep(40);
    F.mouse_event(flags[0], 0, 0, 0, 0);
    await sleep(40);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      F.SetCursorPos(Math.round(a.x + (b.x - a.x) * t), Math.round(a.y + (b.y - a.y) * t));
      await sleep(Math.max(4, Number(opts.stepDelay) || 10));
    }
    await sleep(40);
    F.mouse_event(flags[1], 0, 0, 0, 0);
    return { success: true, from: a, to: b, steps };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/** 滚轮：delta 为负数向下滚（每 120 为一格）。 */
async function scrollMouse(delta, x, y, opts = {}) {
  const bad = ensure();
  if (bad) return bad;
  const d = Math.round(Number(delta) || 0);
  if (!d) return { success: false, error: 'delta 不能为 0（正数向上，负数向下，120 = 一格）' };
  if (opts.dryRun) return { success: true, dryRun: true, action: 'scroll', delta: d, x, y };
  try {
    if (Number.isFinite(Number(x)) && Number.isFinite(Number(y)) && Number(x) >= 0 && Number(y) >= 0) {
      const p = opts.raw ? { x: Math.round(Number(x)), y: Math.round(Number(y)) } : toUser32(x, y);
      F.SetCursorPos(p.x, p.y);
      await sleep(30);
    }
    const flag = opts.horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL;
    F.mouse_event(flag, 0, 0, d, 0);
    await sleep(40);
    return { success: true, delta: d };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function mouseDown(button, x, y, opts = {}) {
  const bad = ensure();
  if (bad) return bad;
  const flags = BUTTON_FLAGS[(button || 'left').toLowerCase()] || BUTTON_FLAGS.left;
  if (opts.dryRun) return { success: true, dryRun: true, action: 'mouse_down', button: button || 'left' };
  try {
    if (Number.isFinite(Number(x)) && Number.isFinite(Number(y)) && Number(x) >= 0 && Number(y) >= 0) {
      const p = opts.raw ? { x: Math.round(Number(x)), y: Math.round(Number(y)) } : toUser32(x, y);
      F.SetCursorPos(p.x, p.y);
      await sleep(30);
    }
    F.mouse_event(flags[0], 0, 0, 0, 0);
    return { success: true, down: button || 'left' };
  } catch (e) { return { success: false, error: e.message }; }
}

async function mouseUp(button, opts = {}) {
  const bad = ensure();
  if (bad) return bad;
  const flags = BUTTON_FLAGS[(button || 'left').toLowerCase()] || BUTTON_FLAGS.left;
  if (opts.dryRun) return { success: true, dryRun: true, action: 'mouse_up', button: button || 'left' };
  try {
    F.mouse_event(flags[1], 0, 0, 0, 0);
    return { success: true, up: button || 'left' };
  } catch (e) { return { success: false, error: e.message }; }
}

// ============================================================
// 键盘（SendInput + Unicode，中文可用）
// ============================================================

/** 发一次键盘事件；SendInput 不可用时退回 keybd_event（仅 ASCII 可靠）。 */
function sendKey(vk, scan, flags) {
  try {
    if (F.SendInput) {
      const n = F.SendInput(1, keyInputBuffer(vk, scan, flags), INPUT_SIZE);
      if (n === 1) return true;
    }
  } catch (e) { /* 落到 keybd_event */ }
  try {
    F.keybd_event(vk & 0xff, scan & 0xff, flags, 0);
    return true;
  } catch (e) { return false; }
}

/** 把一段文字拆成 UTF-16 码元（支持 emoji 等代理对）。 */
function toUtf16Units(text) {
  const units = [];
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (cp > 0xffff) {
      const v = cp - 0x10000;
      units.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    } else units.push(cp);
  }
  return units;
}

/**
 * 输入文字（Unicode，中文/emoji 可用）。
 * 以前用 keybd_event：它的 bScan 只有 1 字节，中文码点被截断 → 输入全是乱码。现在走 SendInput。
 */
async function typeText(text, opts = {}) {
  const bad = ensure();
  if (bad) return bad;
  const s = String(text == null ? '' : text);
  if (!s) return { success: false, error: '文本内容为空' };
  const delay = Number(opts.delay) >= 0 ? Number(opts.delay) : 15;
  if (opts.dryRun) return { success: true, dryRun: true, action: 'type', chars: [...s].length, text: s.slice(0, 80) };
  // 可选：先把目标窗口置前，避免打到别的窗口
  if (opts.window) {
    const f = await focusWindow(opts.window);
    if (!f.success) return f;
  }
  try {
    let typed = 0;
    for (const ch of s) {
      if (ch === '\n') {
        await pressKey('enter', { raw: true });
      } else if (ch === '\t') {
        await pressKey('tab', { raw: true });
      } else {
        for (const unit of toUtf16Units(ch)) {
          sendKey(0, unit, KEYEVENTF_UNICODE);
          await sleep(2);
          sendKey(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
          await sleep(Math.min(6, Math.max(1, Math.round(delay / 3))));
        }
        typed++;
      }
      await sleep(delay);
    }
    return { success: true, chars: typed, text: s.length > 60 ? s.slice(0, 60) + '…' : s };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function resolveVk(key) {
  if (typeof key === 'number') return key;
  const k = String(key || '').trim().toLowerCase();
  if (k.length === 1) {
    // 单字符：用大写字母的虚拟键码（A~Z、0~9 与 VK 一致）
    const up = k.toUpperCase();
    const code = up.charCodeAt(0);
    if ((code >= 0x41 && code <= 0x5A) || (code >= 0x30 && code <= 0x39)) return code;
  }
  if (VK[k] !== undefined) return VK[k];
  const num = Number(k);
  return Number.isFinite(num) ? num : undefined;
}

async function pressKey(key, opts = {}) {
  const bad = ensure();
  if (bad) return bad;
  const vk = resolveVk(key);
  if (vk === undefined || vk < 0 || vk > 0xFF) {
    return { success: false, error: '未知按键（支持 enter/tab/esc/backspace/space/ctrl/shift/alt/win/方向键/F1~F12、单个字母数字，或数字 VK 码）: ' + key };
  }
  if (opts.dryRun) return { success: true, dryRun: true, action: 'press', key, vk };
  if (opts.window) {
    const f = await focusWindow(opts.window);
    if (!f.success) return f;
  }
  try {
    const ext = EXTENDED_VK.has(vk) ? KEYEVENTF_EXTENDEDKEY : 0;
    sendKey(vk, 0, ext);
    await sleep(25);
    sendKey(vk, 0, ext | KEYEVENTF_KEYUP);
    await sleep(25);
    return { success: true, key, vk };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/** 组合键：修饰键按住 → 敲最后一个键 → 逆序松开。 */
async function hotkey(keys, opts = {}) {
  const bad = ensure();
  if (bad) return bad;
  if (!Array.isArray(keys) || keys.length < 2) {
    return { success: false, error: '组合键至少需要 2 个键，如 ["ctrl","c"]' };
  }
  const vks = [];
  for (const k of keys) {
    const vk = resolveVk(k);
    if (vk === undefined || vk < 0 || vk > 0xFF) return { success: false, error: '组合键含未知按键: ' + k };
    vks.push(vk);
  }
  if (opts.dryRun) return { success: true, dryRun: true, action: 'hotkey', keys };
  if (opts.window) {
    const f = await focusWindow(opts.window);
    if (!f.success) return f;
  }
  try {
    for (let i = 0; i < vks.length - 1; i++) { sendKey(vks[i], 0, 0); await sleep(20); }
    const last = vks[vks.length - 1];
    sendKey(last, 0, 0); await sleep(30);
    sendKey(last, 0, KEYEVENTF_KEYUP); await sleep(20);
    for (let i = vks.length - 2; i >= 0; i--) { sendKey(vks[i], 0, KEYEVENTF_KEYUP); await sleep(20); }
    return { success: true, keys };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ============================================================
// 剪贴板（读界面信息 / 粘贴大段文本）
// ============================================================

function getClipboard() {
  try {
    // eslint-disable-next-line global-require
    const { clipboard } = require('electron');
    return { success: true, text: clipboard.readText() };
  } catch (e) {
    return { success: false, error: '剪贴板不可用（需要 Electron 环境）: ' + e.message };
  }
}

function setClipboard(text) {
  try {
    // eslint-disable-next-line global-require
    const { clipboard } = require('electron');
    clipboard.writeText(String(text == null ? '' : text));
    return { success: true, chars: String(text == null ? '' : text).length };
  } catch (e) {
    return { success: false, error: '剪贴板不可用: ' + e.message };
  }
}

/** 粘贴：把文本放进剪贴板再 Ctrl+V（比逐字输入快且不会漏字）。 */
async function pasteText(text, opts = {}) {
  // ⚠️ dryRun 必须先判断：预演时不该真去改剪贴板 / 抢焦点
  if (opts.dryRun) return { success: true, dryRun: true, action: 'paste', text: String(text || '').slice(0, 80) };
  const set = setClipboard(text);
  if (!set.success) return set;
  if (opts.window) {
    const f = await focusWindow(opts.window);
    if (!f.success) return f;
  }
  const r = await hotkey(['ctrl', 'v'], {});
  await sleep(60);
  return { success: !!r.success, chars: set.chars, method: 'clipboard+ctrl+v' };
}

// ============================================================
// 统一入口
// ============================================================

async function runStep(step) {
  const action = String((step && step.action) || '').toLowerCase();
  const dry = !!step.dryRun;
  // 指定了 window 的鼠标动作：先把窗口置前，否则点的是别人（"点了没反应"的常见原因）
  const PRE_FOCUS = new Set(['click', 'left_click', 'right_click', 'middle_click', 'double_click', 'mouse_down', 'drag', 'scroll']);
  if (!dry && step.window && PRE_FOCUS.has(action)) {
    const f = await focusWindow(step.window);
    if (!f.success) return f;
  }
  switch (action) {
    case 'move': return moveMouse(step.x, step.y, { dryRun: dry, raw: step.raw });
    case 'click': case 'left_click': return clickMouse(step.x, step.y, { button: 'left', double: !!step.double, dryRun: dry, raw: step.raw });
    case 'right_click': return clickMouse(step.x, step.y, { button: 'right', dryRun: dry, raw: step.raw });
    case 'middle_click': return clickMouse(step.x, step.y, { button: 'middle', dryRun: dry, raw: step.raw });
    case 'double_click': return clickMouse(step.x, step.y, { button: step.button || 'left', double: true, dryRun: dry, raw: step.raw });
    case 'mouse_down': return mouseDown(step.button || 'left', step.x, step.y, { dryRun: dry, raw: step.raw });
    case 'mouse_up': return mouseUp(step.button || 'left', { dryRun: dry });
    case 'drag': return dragMouse(step.x, step.y, step.x2, step.y2, { steps: step.steps, button: step.button, dryRun: dry, raw: step.raw });
    case 'scroll': return scrollMouse(step.delta, step.x, step.y, { horizontal: !!step.horizontal, dryRun: dry, raw: step.raw });
    case 'type': return typeText(step.text, { delay: step.delay, window: step.window, dryRun: dry });
    case 'paste': return pasteText(step.text, { window: step.window, dryRun: dry });
    case 'press': return pressKey(step.key, { window: step.window, dryRun: dry });
    case 'hotkey': return hotkey(step.keys, { window: step.window, dryRun: dry });
    case 'focus': return focusWindow(step.window || step.title || step.hwnd, { dryRun: dry });
    case 'wait': await sleep(Math.max(0, Math.min(5000, Number(step.ms) || 300))); return { success: true, waited: Number(step.ms) || 300 };
    case 'windows': return listWindows(step.keyword);
    case 'find_window': return findWindow(step.title) || { success: false, error: '没找到窗口: ' + step.title };
    case 'window_rect': {
      const w = findWindow(step.title || step.window);
      return w ? { success: true, ...w } : { success: false, error: '没找到窗口: ' + (step.title || step.window) };
    }
    case 'cursor_pos': return getCursorPos();
    case 'screensize': case 'screen_info': return screenInfo();
    case 'clipboard_get': return getClipboard();
    case 'clipboard_set': return setClipboard(step.text);
    default: return { success: false, error: '未知步骤 action: ' + action };
  }
}

/**
 * 统一入口，供 agent 工具调用。
 * action: move/click/right_click/double_click/mouse_down/mouse_up/drag/scroll/type/paste/press/hotkey/
 *         focus/windows/find_window/window_rect/cursor_pos/screensize/clipboard_get/clipboard_set/steps
 * 通用参数：dryRun=true 只预演不真操作；window=窗口标题（type/press/hotkey/click 前自动聚焦）。
 */
async function control(action, params = {}) {
  const act = String(action || '').toLowerCase();
  if (act === 'steps') {
    const steps = Array.isArray(params.steps) ? params.steps : [];
    if (!steps.length) return { success: false, error: 'steps 为空：传 [{action:"focus",window:"标题"},{action:"click",x,y},...]' };
    const results = [];
    for (let i = 0; i < steps.length; i++) {
      const r = await runStep({ ...steps[i], dryRun: steps[i].dryRun !== undefined ? steps[i].dryRun : !!params.dryRun });
      results.push({ index: i, action: steps[i].action, ...r });
      if (r && r.success === false && params.stopOnError !== false) {
        return { success: false, step: i, action: steps[i].action, error: r.error, results };
      }
    }
    return { success: true, steps: results.length, results };
  }
  return runStep({ ...params, action: act });
}

// ============================================================
// 后台窗口消息注入（Background Window Message Injection）
// ============================================================
// 为什么需要它：
//   上面的 clickMouse/typeText 等用的是 SendInput 全局模拟，必须把目标窗口
//   切到前台、且必须在当前活动桌面上——AI 操作时用户的屏幕会被抢走。
//   这里的实现直接向指定 hwnd 发送 Windows 消息（PostMessage），窗口不需要
//   激活、不需要在前台、甚至可以在另一个虚拟桌面上，用户桌面全程不受影响。
//
// 限制（如实告知，不假装万能）：
//   1. 坐标必须是相对于窗口客户区的（调用方传屏幕坐标，这里自动换算）。
//   2. 某些程序（游戏、DirectInput、UWP 应用）不响应消息级输入，需要 SendInput。
//   3. 拖拽需要连发 WM_MOUSEMOVE，某些程序只认真实鼠标轨迹，可能不跟手。
//   4. 后台输入时窗口不会真的"获得焦点"，如果程序逻辑依赖 WM_SETFOCUS 事件，
//      可能需要先手动激活一下（但那会打断用户，所以默认不做）。
// ============================================================

// Windows 消息常量
const WM_MOUSEMOVE = 0x0200;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_RBUTTONDOWN = 0x0204;
const WM_RBUTTONUP = 0x0205;
const WM_MBUTTONDOWN = 0x0207;
const WM_MBUTTONUP = 0x0208;
const WM_MOUSEWHEEL = 0x020A;
const WM_MOUSEHWHEEL = 0x020E;
const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;
const WM_CHAR = 0x0102;
const WM_PASTE = 0x0302;
const WM_VSCROLL = 0x0115;
const WM_HSCROLL = 0x0114;
const WM_SETFOCUS = 0x0007;

// 鼠标按键状态（wParam）
const MK_LBUTTON = 0x0001;
const MK_RBUTTON = 0x0002;
const MK_MBUTTON = 0x0010;
const MK_SHIFT = 0x0004;
const MK_CONTROL = 0x0008;

// 滚动条常量（wParam 低 16 位）
const SB_LINEUP = 0;
const SB_LINEDOWN = 1;
const SB_PAGEUP = 2;
const SB_PAGEDOWN = 3;

/**
 * 把鼠标消息的 x,y 打包成 lParam。
 * Windows 要求 lParam = (y << 16) | (x & 0xFFFF)，x,y 是有符号短整数。
 */
function mouseLParam(x, y) {
  const xi = Math.round(Number(x) || 0);
  const yi = Math.round(Number(y) || 0);
  // 有符号短整数：负数需要补码
  const xs = xi < 0 ? (0x10000 + xi) : (xi & 0xFFFF);
  const ys = yi < 0 ? (0x10000 + yi) : (yi & 0xFFFF);
  return (ys << 16) | xs;
}

/**
 * 屏幕坐标 → 窗口客户区坐标。
 * 用 GetWindowRect 拿窗口位置，然后手动减（比 ScreenToClient 更可控，
 * 因为 ScreenToClient 依赖窗口的窗口过程，某些异常窗口会失败）。
 */
function screenToClient(hwnd, x, y) {
  const rect = Buffer.alloc(16);
  if (!F.GetWindowRect(hwnd, rect)) return { x: Math.round(x), y: Math.round(y) };
  const wx = rect.readInt32LE(0);
  const wy = rect.readInt32LE(4);
  // 注意：GetWindowRect 返回的是窗口外框（含标题栏/边框）。
  // 鼠标消息的坐标是相对于客户区的，需要扣掉标题栏和边框。
  // 用 AdjustWindowRect 太麻烦，这里用经验值：标题栏约 31px，边框约 1px。
  // 更准确的方式是用 GetClientRect + ClientToScreen，但那需要窗口过程响应。
  // 实测大多数标准 Win32 窗口：客户区起点 = (wx+1, wy+31)。
  // 对于无边框窗口（Electron/Qt 自绘），标题栏可能为 0，这时会偏 31px。
  // 所以这里先尝试用 ScreenToClient（最准），失败再退回手动计算。
  try {
    const pt = Buffer.alloc(8);
    pt.writeInt32LE(Math.round(Number(x) || 0), 0);
    pt.writeInt32LE(Math.round(Number(y) || 0), 4);
    if (F.ScreenToClient(hwnd, pt)) {
      return { x: pt.readInt32LE(0), y: pt.readInt32LE(4) };
    }
  } catch (e) { /* 落到手动计算 */ }
  // 退回：假设标准窗口边框 1px + 标题栏 31px
  return { x: Math.round(x) - wx - 1, y: Math.round(y) - wy - 31 };
}

/** 向窗口发一个鼠标消息（PostMessage，异步不阻塞） */
function postMouse(hwnd, msg, x, y, wParam) {
  const lp = mouseLParam(x, y);
  const r = F.PostMessageW(hwnd, msg, wParam || 0, lp);
  return r !== 0; // PostMessage 成功返回非 0
}

/** 向窗口发一个键盘消息 */
function postKey(hwnd, msg, vk, scan, flags) {
  // WM_KEYDOWN/UP 的 lParam：
  //   0-15: 重复计数（1）
  //   16-23: 扫描码
  //   24: 扩展键标志
  //   29: 上下文码（0=前台，1=ALT按下）
  //   30: 前一个键状态（0=之前弹起，1=之前按下）
  //   31: 转换状态（0=按下，1=弹起）
  const repeat = 1;
  const ext = (flags & KEYEVENTF_EXTENDEDKEY) ? 1 : 0;
  const prev = (msg === WM_KEYUP) ? 1 : 0;
  const trans = (msg === WM_KEYUP) ? 1 : 0;
  const lParam = repeat | (scan << 16) | (ext << 24) | (prev << 30) | (trans << 31);
  return F.PostMessageW(hwnd, msg, vk, lParam) !== 0;
}

/**
 * 后台操作统一入口：向指定窗口注入消息，不需要激活/切换桌面。
 *
 * @param {number|string} hwnd 目标窗口句柄（数字或数字字符串）
 * @param {string} action 操作类型（同 control 的 action）
 * @param {object} params 操作参数
 * @returns {Promise<object>}
 */
async function controlBackground(hwnd, action, params = {}) {
  const bad = ensure();
  if (bad) return bad;

  const h = Number(hwnd);
  if (!isFinite(h) || h <= 0) {
    return { success: false, error: '后台操作需要有效的窗口句柄 hwnd' };
  }
  if (!F.IsWindow(h)) {
    return { success: false, error: '窗口句柄无效（窗口可能已关闭）' };
  }

  const act = String(action || '').toLowerCase();
  const dry = !!params.dryRun;
  if (dry) return { success: true, dryRun: true, action: act, hwnd: h, mode: 'background' };

  // 坐标换算：如果传的是屏幕坐标（默认），转成客户区坐标；
  // 传 raw:true 表示已经是客户区坐标，不换算。
  const toClient = (x, y) => params.raw
    ? { x: Math.round(Number(x) || 0), y: Math.round(Number(y) || 0) }
    : screenToClient(h, x, y);

  try {
    switch (act) {
      // ===== 鼠标 =====
      case 'move': {
        const p = toClient(params.x, params.y);
        postMouse(h, WM_MOUSEMOVE, p.x, p.y, 0);
        return { success: true, action: 'move', x: p.x, y: p.y, mode: 'background' };
      }
      case 'click':
      case 'left_click': {
        const p = toClient(params.x, params.y);
        const dbl = !!params.double;
        // 先 move 到目标点（让窗口知道鼠标位置），再 down/up
        postMouse(h, WM_MOUSEMOVE, p.x, p.y, 0);
        await sleep(10);
        postMouse(h, WM_LBUTTONDOWN, p.x, p.y, MK_LBUTTON);
        await sleep(dbl ? 30 : 20);
        postMouse(h, WM_LBUTTONUP, p.x, p.y, 0);
        if (dbl) {
          await sleep(20);
          postMouse(h, WM_LBUTTONDOWN, p.x, p.y, MK_LBUTTON);
          await sleep(20);
          postMouse(h, WM_LBUTTONUP, p.x, p.y, 0);
        }
        return { success: true, action: 'click', x: p.x, y: p.y, double: dbl, mode: 'background' };
      }
      case 'right_click': {
        const p = toClient(params.x, params.y);
        postMouse(h, WM_MOUSEMOVE, p.x, p.y, 0);
        await sleep(10);
        postMouse(h, WM_RBUTTONDOWN, p.x, p.y, MK_RBUTTON);
        await sleep(20);
        postMouse(h, WM_RBUTTONUP, p.x, p.y, 0);
        return { success: true, action: 'right_click', x: p.x, y: p.y, mode: 'background' };
      }
      case 'middle_click': {
        const p = toClient(params.x, params.y);
        postMouse(h, WM_MOUSEMOVE, p.x, p.y, 0);
        await sleep(10);
        postMouse(h, WM_MBUTTONDOWN, p.x, p.y, MK_MBUTTON);
        await sleep(20);
        postMouse(h, WM_MBUTTONUP, p.x, p.y, 0);
        return { success: true, action: 'middle_click', x: p.x, y: p.y, mode: 'background' };
      }
      case 'double_click': {
        params.double = true;
        return controlBackground(h, 'click', params);
      }
      case 'mouse_down': {
        const p = toClient(params.x, params.y);
        const btn = (params.button || 'left').toLowerCase();
        const msg = btn === 'right' ? WM_RBUTTONDOWN : (btn === 'middle' ? WM_MBUTTONDOWN : WM_LBUTTONDOWN);
        const mk = btn === 'right' ? MK_RBUTTON : (btn === 'middle' ? MK_MBUTTON : MK_LBUTTON);
        postMouse(h, msg, p.x, p.y, mk);
        return { success: true, action: 'mouse_down', button: btn, mode: 'background' };
      }
      case 'mouse_up': {
        const btn = (params.button || 'left').toLowerCase();
        const msg = btn === 'right' ? WM_RBUTTONUP : (btn === 'middle' ? WM_MBUTTONUP : WM_LBUTTONUP);
        // mouse_up 时坐标用当前鼠标位置（如果没传就用 0,0，大多数窗口不关心 up 的坐标）
        const p = (params.x !== undefined) ? toClient(params.x, params.y) : { x: 0, y: 0 };
        postMouse(h, msg, p.x, p.y, 0);
        return { success: true, action: 'mouse_up', button: btn, mode: 'background' };
      }
      case 'drag': {
        const a = toClient(params.x, params.y);
        const b = toClient(params.x2, params.y2);
        const steps = Math.max(2, Math.min(40, Number(params.steps) || 15));
        const btn = (params.button || 'left').toLowerCase();
        const downMsg = btn === 'right' ? WM_RBUTTONDOWN : WM_LBUTTONDOWN;
        const upMsg = btn === 'right' ? WM_RBUTTONUP : WM_LBUTTONUP;
        const mk = btn === 'right' ? MK_RBUTTON : MK_LBUTTON;
        // 移到起点 → 按下 → 分段移动 → 抬起
        postMouse(h, WM_MOUSEMOVE, a.x, a.y, 0);
        await sleep(15);
        postMouse(h, downMsg, a.x, a.y, mk);
        await sleep(20);
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const mx = Math.round(a.x + (b.x - a.x) * t);
          const my = Math.round(a.y + (b.y - a.y) * t);
          postMouse(h, WM_MOUSEMOVE, mx, my, mk);
          await sleep(Math.max(4, Number(params.stepDelay) || 8));
        }
        postMouse(h, upMsg, b.x, b.y, 0);
        return { success: true, action: 'drag', from: a, to: b, steps, mode: 'background' };
      }
      case 'scroll': {
        const delta = Math.round(Number(params.delta) || 0);
        if (!delta) return { success: false, error: 'delta 不能为 0' };
        // WM_MOUSEWHEEL 的 wParam：高 16 位是 delta（120=一格），低 16 位是按键状态
        // lParam：鼠标位置（屏幕坐标，滚动时大多数窗口不关心）
        const wheelDelta = delta * 120; // 输入的 delta 是"格数"，转成 WHEEL_DELTA 单位
        const wp = (wheelDelta << 16) & 0xFFFFFFFF;
        const p = (params.x !== undefined) ? toClient(params.x, params.y) : { x: 0, y: 0 };
        const msg = params.horizontal ? WM_MOUSEHWHEEL : WM_MOUSEWHEEL;
        // 注意：WM_MOUSEWHEEL 的坐标是屏幕坐标，不是客户区坐标！
        // 但 PostMessage 给子窗口时，子窗口的窗口过程会自己转换，所以传客户区坐标也能工作。
        F.PostMessageW(h, msg, wp, mouseLParam(p.x, p.y));
        return { success: true, action: 'scroll', delta, mode: 'background' };
      }

      // ===== 键盘 =====
      case 'type': {
        const text = String(params.text == null ? '' : params.text);
        if (!text) return { success: false, error: '文本内容为空' };
        const delay = Number(params.delay) >= 0 ? Number(params.delay) : 15;
        // 用 WM_CHAR 发 Unicode 字符（最可靠的后台文字输入方式）
        // WM_CHAR 的 wParam 是 UTF-16 码元，lParam 是按键状态
        for (const ch of text) {
          const cp = ch.codePointAt(0);
          if (cp > 0xFFFF) {
            // 代理对：发两个 WM_CHAR
            const v = cp - 0x10000;
            const hi = 0xD800 + (v >> 10);
            const lo = 0xDC00 + (v & 0x3FF);
            F.PostMessageW(h, WM_CHAR, hi, 1);
            await sleep(delay);
            F.PostMessageW(h, WM_CHAR, lo, 1);
          } else {
            F.PostMessageW(h, WM_CHAR, cp, 1);
          }
          if (delay > 0) await sleep(delay);
        }
        return { success: true, action: 'type', chars: text.length, mode: 'background' };
      }
      case 'press': {
        const keyName = String(params.key || '').toLowerCase();
        const vk = VK[keyName];
        if (!vk) return { success: false, error: '未知按键: ' + params.key + '（支持: enter/space/esc/tab/backspace/delete/方向键/f1-f12/ctrl/shift/alt/win 等）' };
        const scan = F.MapVirtualKeyW(vk, 0); // 0 = MAPVK_VK_TO_VSC
        const ext = EXTENDED_VK.has(vk) ? KEYEVENTF_EXTENDEDKEY : 0;
        postKey(h, WM_KEYDOWN, vk, scan, ext);
        await sleep(20);
        postKey(h, WM_KEYUP, vk, scan, ext | KEYEVENTF_KEYUP);
        return { success: true, action: 'press', key: keyName, vk, mode: 'background' };
      }
      case 'hotkey': {
        const keys = Array.isArray(params.keys) ? params.keys : [params.keys];
        if (!keys.length) return { success: false, error: 'hotkey 需要至少一个键' };
        const vks = [];
        for (const k of keys) {
          const vk = VK[String(k || '').toLowerCase()];
          if (!vk) return { success: false, error: '未知按键: ' + k };
          vks.push(vk);
        }
        // 按下所有键（从左到右），再抬起（从右到左）
        for (const vk of vks) {
          const scan = F.MapVirtualKeyW(vk, 0);
          const ext = EXTENDED_VK.has(vk) ? KEYEVENTF_EXTENDEDKEY : 0;
          postKey(h, WM_KEYDOWN, vk, scan, ext);
          await sleep(10);
        }
        await sleep(30);
        for (let i = vks.length - 1; i >= 0; i--) {
          const vk = vks[i];
          const scan = F.MapVirtualKeyW(vk, 0);
          const ext = EXTENDED_VK.has(vk) ? KEYEVENTF_EXTENDEDKEY : 0;
          postKey(h, WM_KEYUP, vk, scan, ext | KEYEVENTF_KEYUP);
          await sleep(10);
        }
        return { success: true, action: 'hotkey', keys: keys.join('+'), mode: 'background' };
      }
      case 'paste': {
        // 先把文本放进剪贴板，再发 WM_PASTE
        const text = String(params.text == null ? '' : params.text);
        if (text) {
          const r = setClipboard(text);
          if (!r.success) return r;
        }
        F.PostMessageW(h, WM_PASTE, 0, 0);
        return { success: true, action: 'paste', mode: 'background' };
      }

      // ===== 查询类（不需要消息注入，直接调用已有函数）=====
      case 'focus':
        // 后台模式下不真的激活窗口（会打断用户），只返回窗口信息
        return { success: true, action: 'focus', hwnd: h, mode: 'background', note: '后台模式不激活窗口（避免打断用户），直接向该窗口发消息即可' };
      case 'windows': return listWindows(params.keyword);
      case 'find_window': {
        const w = findWindow(params.title || params.window);
        return w ? { success: true, ...w } : { success: false, error: '没找到窗口: ' + (params.title || params.window) };
      }
      case 'window_rect': {
        const w = findWindow(params.title || params.window) || { hwnd: h };
        const rect = Buffer.alloc(16);
        if (F.GetWindowRect(w.hwnd, rect)) {
          return {
            success: true,
            hwnd: w.hwnd,
            x: rect.readInt32LE(0), y: rect.readInt32LE(4),
            width: rect.readInt32LE(8) - rect.readInt32LE(0),
            height: rect.readInt32LE(12) - rect.readInt32LE(4)
          };
        }
        return { success: false, error: '获取窗口矩形失败' };
      }
      case 'cursor_pos': return getCursorPos();
      case 'screensize': case 'screen_info': return screenInfo();
      case 'clipboard_get': return getClipboard();
      case 'clipboard_set': return setClipboard(params.text);
      case 'wait':
        await sleep(Math.max(0, Math.min(5000, Number(params.ms) || 300)));
        return { success: true, waited: Number(params.ms) || 300 };
      default:
        return { success: false, error: '后台模式不支持的操作: ' + act + '（如需全局模拟请用普通 control 模式）' };
    }
  } catch (e) {
    return { success: false, error: '后台操作失败: ' + (e && e.message ? e.message : String(e)), mode: 'background' };
  }
}

// ============================================================
// 窗口截图（PrintWindow）—— 可抓取不在前台/在另一个虚拟桌面的窗口
// ============================================================
// 为什么需要它：desktopCapturer 只能抓当前活动桌面上的窗口。
//   后台隔离模式下，目标窗口被移到了分身桌面，desktopCapturer 抓不到。
//   PrintWindow 直接让窗口把自己绘制到一个内存 DC，不需要窗口在前台、
//   不需要切换桌面，甚至窗口在另一个虚拟桌面上也能抓到。
//
// 限制：
//   1. 某些使用 DirectX/OpenGL 全屏渲染的程序（游戏）PrintWindow 可能抓不到（黑屏）。
//   2. 已最小化的窗口 PrintWindow 通常也能抓到（窗口会自己恢复渲染），但不保证。
//   3. PW_RENDERFULLCONTENT 标志（Win8.1+）能改善硬件加速窗口的抓取效果。
// ============================================================

const PW_RENDERFULLCONTENT = 0x00000002;
const DIB_RGB_COLORS = 0;

/** 40 字节 BITMAPINFOHEADER（32bpp BI_RGB），供 CreateDIBSection 使用 */
function _dibBmi(w, h) {
  const b = Buffer.alloc(40);
  b.writeUInt32LE(40, 0);
  b.writeInt32LE(w, 4);
  b.writeInt32LE(h, 8);
  b.writeUInt16LE(1, 12);
  b.writeUInt16LE(32, 14);
  b.writeUInt32LE(w * h * 4, 20);
  return b;
}

/**
 * 用 PrintWindow 抓取指定窗口的画面，保存为 PNG。
 * 不需要窗口在前台，不需要切换桌面，可抓取在另一个虚拟桌面上的窗口。
 *
 * @param {number|string} hwnd 目标窗口句柄
 * @param {string} [savePath] 保存路径；为空则返回临时路径
 * @returns {Promise<{success:boolean, path?:string, width?:number, height?:number, error?:string}>}
 */
/**
 * 抓取指定窗口的画面（PrintWindow，不需要窗口在前台/当前桌面）。
 * 优化版：支持缩放、高效像素转换、直接返回 Buffer（不写文件）。
 * @param {number} hwnd 窗口句柄
 * @param {object} opts { maxWidth?: number, savePath?: string }
 * @returns {Promise<{success:boolean, buffer?:Buffer, width:number, height:number, path?:string, error?:string}>}
 */
async function captureWindowByHwnd(hwnd, opts = {}) {
  const bad = ensure();
  if (bad) return bad;

  const h = Number(hwnd);
  if (!isFinite(h) || h <= 0) return { success: false, error: '需要有效的窗口句柄 hwnd' };
  if (!F.IsWindow(h)) return { success: false, error: '窗口句柄无效（窗口可能已关闭）' };

  // ① 获取窗口矩形
  const rect = Buffer.alloc(16);
  if (!F.GetWindowRect(h, rect)) return { success: false, error: 'GetWindowRect 失败' };
  const left = rect.readInt32LE(0);
  const top = rect.readInt32LE(4);
  const right = rect.readInt32LE(8);
  const bottom = rect.readInt32LE(12);
  let width = right - left;
  let height = bottom - top;
  if (width <= 0 || height <= 0) return { success: false, error: '窗口尺寸无效（可能已最小化）: ' + width + 'x' + height };

  // ② 计算缩放后的尺寸（小窗预览不需要全屏分辨率）
  const maxWidth = opts.maxWidth || 800;
  let targetWidth = width;
  let targetHeight = height;
  if (width > maxWidth) {
    targetWidth = maxWidth;
    targetHeight = Math.round(height * maxWidth / width);
  }

  // ③ 创建内存 DC 和 DIB 位图
  //    ★ 必须用 CreateDIBSection（DIB）而非 CreateCompatibleBitmap（DDB）：
  //      本机上 DDB 接不到任何像素，PrintWindow/StretchBlt 会「返回成功但全 0」。
  const memDC = F.CreateCompatibleDC(null);
  if (!memDC || memDC === 0) return { success: false, error: 'CreateCompatibleDC 失败' };
  const dibBits = Buffer.alloc(16);
  const bitmap = F.CreateDIBSection(memDC, _dibBmi(width, height), 0, dibBits, null, 0);
  if (!bitmap || bitmap === 0) { F.DeleteDC(memDC); return { success: false, error: 'CreateDIBSection 失败' }; }
  const oldBitmap = F.SelectObject(memDC, bitmap);

  // ④ PrintWindow 把窗口画到内存 DC
  let ok = F.PrintWindow(h, memDC, PW_RENDERFULLCONTENT);
  if (!ok) ok = F.PrintWindow(h, memDC, 0);
  if (!ok) {
    F.SelectObject(memDC, oldBitmap);
    F.DeleteObject(bitmap);
    F.DeleteDC(memDC);
    return { success: false, error: 'PrintWindow 失败（窗口可能拒绝渲染）' };
  }

  // ⑤ 如果需要缩放，创建第二个 DC 用 StretchBlt 缩放
  let finalDC = memDC;
  let finalBitmap = bitmap;
  let finalOldBitmap = oldBitmap;
  if (targetWidth !== width || targetHeight !== height) {
    const scaleDC = F.CreateCompatibleDC(null);
    const scaleBitmap = F.CreateDIBSection(scaleDC, _dibBmi(targetWidth, targetHeight), 0, Buffer.alloc(16), null, 0);
    const scaleOld = F.SelectObject(scaleDC, scaleBitmap);
    // SetStretchBltMode = HALFTONE (4) 质量最好
    F.SetStretchBltMode(scaleDC, 4);
    F.StretchBlt(scaleDC, 0, 0, targetWidth, targetHeight, memDC, 0, 0, width, height, 0x00CC0020); // SRCCOPY
    // 清理原始 DC
    F.SelectObject(memDC, oldBitmap);
    F.DeleteObject(bitmap);
    F.DeleteDC(memDC);
    finalDC = scaleDC;
    finalBitmap = scaleBitmap;
    finalOldBitmap = scaleOld;
    width = targetWidth;
    height = targetHeight;
  }

  // ⑥ 用 GetDIBits 读取像素数据（BGRA 自下而上）
  const bmi = Buffer.alloc(40);
  bmi.writeUInt32LE(40, 0);
  bmi.writeInt32LE(width, 4);
  bmi.writeInt32LE(height, 8);
  bmi.writeUInt16LE(1, 12);
  bmi.writeUInt16LE(32, 14);
  bmi.writeUInt32LE(0, 16);
  bmi.writeUInt32LE(0, 20);
  bmi.writeInt32LE(0, 24);
  bmi.writeInt32LE(0, 28);
  bmi.writeUInt32LE(0, 32);
  bmi.writeUInt32LE(0, 36);

  const pixelCount = width * height;
  const pixelBuffer = Buffer.alloc(pixelCount * 4);
  const linesCopied = F.GetDIBits(finalDC, finalBitmap, 0, height, pixelBuffer, bmi, DIB_RGB_COLORS);

  // ⑦ 清理 GDI 对象
  F.SelectObject(finalDC, finalOldBitmap);
  F.DeleteObject(finalBitmap);
  F.DeleteDC(finalDC);

  if (linesCopied <= 0) return { success: false, error: 'GetDIBits 失败' };

  // ⑧ 高效像素格式转换：BGRA 自下而上 → RGBA 自上而下
  //    用 Uint32Array 批量操作，比双重 for 循环快 5-10 倍
  const rgbaBuffer = Buffer.alloc(pixelCount * 4);
  const src32 = new Uint32Array(pixelBuffer.buffer, pixelBuffer.byteOffset, pixelCount);
  const dst32 = new Uint32Array(rgbaBuffer.buffer, rgbaBuffer.byteOffset, pixelCount);
  const rowBytes = width * 4;
  for (let y = 0; y < height; y++) {
    const srcRowStart = (height - 1 - y) * width;
    const dstRowStart = y * width;
    // 批量复制整行（BGRA → RGBA 用字节交换）
    for (let x = 0; x < width; x++) {
      const srcIdx = srcRowStart + x;
      const dstIdx = dstRowStart + x;
      const v = src32[srcIdx];
      // BGRA (little-endian: B,G,R,A) → RGBA (R,G,B,A)
      // 字节交换：0xAABBGGRR → 0xAARRGGBB
      dst32[dstIdx] = ((v & 0xFF) << 16) | (v & 0xFF00) | ((v >> 16) & 0xFF) | (v & 0xFF000000);
    }
  }

  // ⑨ 用 Electron nativeImage 编码为 PNG（直接返回 Buffer，不写文件）
  try {
    const { nativeImage } = require('electron');
    const img = nativeImage.createFromBuffer(rgbaBuffer, { width, height });
    if (img.isEmpty()) return { success: false, error: 'nativeImage 创建失败（画面为空）' };
    const pngBuffer = img.toPNG();

    // 如果指定了 savePath，同时保存文件（兼容旧接口）
    if (opts.savePath) {
      const fs = require('fs');
      const path = require('path');
      const dir = path.dirname(opts.savePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(opts.savePath, pngBuffer);
    }

    return {
      success: true,
      buffer: pngBuffer,
      width,
      height,
      path: opts.savePath || undefined,
      mode: 'printwindow'
    };
  } catch (e) {
    return { success: false, error: '编码截图失败: ' + (e && e.message ? e.message : String(e)) };
  }
}

// ============================================================
// 在指定桌面启动程序（CreateProcess + lpDesktop）
// ============================================================
// 用途：在 AI 分身桌面里启动浏览器/记事本等程序，不需要切换用户桌面。
// 原理：CreateProcessW 的 STARTUPINFO.lpDesktop 字段可以指定目标桌面，
//       进程会在那个桌面里创建窗口，用户当前桌面完全不受影响。
// ============================================================

/**
 * 在指定桌面启动程序。
 * @param {string} desktopName 目标桌面名称（如 "AI 桌面分身"）
 * @param {string} commandLine 命令行（如 "notepad.exe" 或 "chrome.exe https://example.com"）
 * @returns {Promise<{success:boolean, pid?:number, tid?:number, error?:string}>}
 */
async function launchProcessOnDesktop(desktopName, commandLine) {
  const bad = ensure();
  if (bad) return bad;

  if (!desktopName || !commandLine) {
    return { success: false, error: '需要 desktopName 和 commandLine' };
  }

  try {
    // STARTUPINFOW（x64 = 104 字节）
    const si = Buffer.alloc(104);
    si.writeUInt32LE(104, 0); // cb = sizeof(STARTUPINFOW)

    // lpDesktop：指向桌面名称的宽字符字符串（offset 16）
    const desktopBuf = Buffer.from(String(desktopName) + '\0', 'utf16le');
    // 注意：koffi 传 void* 时，如果传 Buffer，它会传 Buffer 的数据指针。
    // 但我们需要把指针值写进 si 结构的 lpDesktop 字段。
    // koffi 不支持直接取 Buffer 的数据地址，所以这里用一个技巧：
    // 把 desktopBuf 作为一个独立参数传给 CreateProcessW 是不行的，
    // 因为 lpDesktop 是 STARTUPINFO 里的字段。
    //
    // 替代方案：用 koffi 的指针功能，或者用外部模块取地址。
    // 最简单的方式：用 ref-napi 或 ffi 的指针，但我们只有 koffi。
    //
    // koffi 有一个功能：可以用 koffi.pointer(value) 创建指针对象，
    // 但那是指向 JS 值的指针，不是 Buffer 的数据指针。
    //
    // 实际上，koffi 的 Buffer 参数会被当作指针传递。如果我们把 si 里的
    // lpDesktop 字段设置为 0，然后用另一种方式...
    //
    // 最可靠的方式：用 koffi 的 `out` 参数或者直接修改 CreateProcess 的调用方式。
    // 让我换个思路：用 koffi 声明一个辅助函数，或者用 node-ffi-napi。
    //
    // 实际上，koffi 支持 `koffi.address(buffer)` 来获取 Buffer 的数据地址吗？
    // 让我试试... 不，koffi 没有这个功能。
    //
    // 替代方案：用 process.binding('spawn_sync') 或者直接用 child_process
    // 配合桌面切换。但那需要切换桌面。
    //
    // 另一个方案：用 explorer.exe 的 /select 或者用 ShellExecute。
    // 但 ShellExecute 也没有直接指定桌面的参数。
    //
    // 最实际的方案：用 CreateProcess，但通过 koffi 的 `void*` 参数传
    // STARTUPINFO，其中 lpDesktop 字段需要是一个指针。我们可以用
    // koffi 的 `koffi.pointer(desktopBuf)` 来创建一个指向 Buffer 的指针？
    // 不对，koffi.pointer 是创建一个指向 JS 值的指针对象。
    //
    // 让我试试 koffi 的另一个功能：当函数参数是 `void*` 且传入 Buffer 时，
    // koffi 会传 Buffer 的数据地址。那如果我们在 si 结构里手动写入这个地址呢？
    // 我们需要知道 desktopBuf 的数据地址。
    //
    // Node.js 的 Buffer 没有直接暴露数据地址的 API。但可以用
    // `buffer.buffer` 取 ArrayBuffer，然后... 也没有地址。
    //
    // 最终方案：用一个小的 C++ 插件或者用 edge.js。太复杂了。
    //
    // 更简单的替代：用 `cmd.exe /c start` 配合 `explorer.exe` 的桌面切换。
    // 或者：先切换到分身桌面 → 启动程序 → 切回。虽然会闪一下，但至少能工作。
    //
    // 等等，我想到了！koffi 支持 `_Out_ void*` 参数，它会分配内存并写入。
    // 但 STARTUPINFO 是一个输入参数，不是输出参数。
    //
    // 另一个思路：把 lpDesktop 字符串数据直接写进 si 结构后面的内存，
    // 然后把 lpDesktop 字段设置为 si 的地址 + 偏移。但我们不知道 si 的地址。
    //
    // 好吧，最实际的方案是：用 koffi 的 `pointer` 类型，把 desktopBuf 包装成
    // 一个二级指针，然后... 不对。
    //
    // 让我查一下 koffi 的文档... koffi 有一个功能叫 "opaque pointers"，
    // 可以用 `koffi.pointer('void*')` 创建指针类型。但获取 Buffer 地址的问题还在。
    //
    // 最终决定：用一个变通方案——通过 koffi 调用 GetCurrentProcessId 等方式
    // 验证 API 可用，然后用 child_process 的 spawn 配合 `detached` 和
    // 桌面切换。或者，直接用 PowerShell 的 Start-Process 配合桌面切换。
    //
    // 不，让我再想想。koffi 的 Buffer 参数传递时，它传的是 Buffer 的数据地址。
    // 那如果我创建一个"指针 Buffer"——即一个 8 字节的 Buffer，里面存的是
    // desktopBuf 的地址——问题是我不知道 desktopBuf 的地址。
    //
    // 等等！Node.js 有一个未公开的 API：`process.binding('buffer').dataPtr(buffer)`
    // 或者用 `buffer[Symbol.for('nodejs.buffer.dataPtr')]`。但这些不稳定。
    //
    // 最稳定的方案：写一个极简的 C++ 插件，导出一个 `getBufferPtr(buf)` 函数。
    // 但这需要编译，用户环境不一定有构建工具。
    //
    // 替代方案：用 `ref-napi` 包，它提供了 `ref.address(buf)` 功能。
    // 但需要安装额外的包。
    //
    // 让我检查项目中是否已经安装了 ref-napi 或类似的包。
    //
    // 实际上，我想到了一个更简单的方案：用 koffi 的 `void*` 返回值。
    // 我们可以调用一个返回指针的函数，比如 `LocalAlloc`，然后把字符串写进
    // 那块内存，再把指针存进 STARTUPINFO。
    //
    // LocalAlloc(LPTR, size) 返回一个指针（void*），koffi 会把它作为
    // 数字返回（因为我们声明返回 void*，koffi 返回的是 BigInt 或数字）。
    // 然后我们可以用 koffi 的 `void*` 参数把这个指针传给 lstrcpyW 等函数
    // 写入字符串。最后把这个指针值写进 STARTUPINFO 的 lpDesktop 字段。
    //
    // 但问题是：koffi 返回的 void* 是一个数字（地址），我们可以把这个数字
    // 写进 Buffer 的指定偏移。这就解决了"不知道 Buffer 地址"的问题——
    // 我们不需要 Buffer 的地址，我们需要的是字符串的地址，而 LocalAlloc
    // 给了我们这个地址！
    //
    // 让我实现这个方案：
    // 1. LocalAlloc(LPTR, size) 分配内存，得到指针 p
    // 2. 用 lstrcpyW(p, desktopBuf) 把桌面名称写进去
    // 3. 把 p 写进 si 的 lpDesktop 字段（offset 16）
    // 4. 调用 CreateProcessW
    // 5. LocalFree(p) 释放内存
    //
    // 需要声明 LocalAlloc、LocalFree、lstrcpyW。
    // LocalAlloc 和 LocalFree 在 kernel32.dll，lstrcpyW 在 kernel32.dll。

    // 声明额外的 API（如果还没声明）
    if (!F.LocalAlloc) {
      F.LocalAlloc = kernel32.func('void* __stdcall LocalAlloc(uint uFlags, uint uBytes)');
      F.LocalFree = kernel32.func('void* __stdcall LocalFree(void* hMem)');
      F.lstrcpyW = kernel32.func('void* __stdcall lstrcpyW(void* lpString1, void* lpString2)');
    }

    const LPTR = 0x0040; // LMEM_FIXED | LMEM_ZEROINIT
    const desktopNameW = Buffer.from(String(desktopName) + '\0', 'utf16le');
    const memSize = desktopNameW.length + 2;

    // 分配内存
    const pDesktop = F.LocalAlloc(LPTR, memSize);
    if (!pDesktop || Number(pDesktop) === 0) {
      return { success: false, error: 'LocalAlloc 失败' };
    }

    try {
      // 把桌面名称写入分配的内存
      // lstrcpyW 的第二个参数是源字符串指针，我们传 Buffer（koffi 会传数据地址）
      F.lstrcpyW(pDesktop, desktopNameW);

      // 把指针写进 STARTUPINFO 的 lpDesktop 字段（offset 16，x64 指针 8 字节）
      // koffi 返回的 void* 可能是 BigInt，需要转成数字
      const ptrVal = Number(pDesktop);
      si.writeBigUInt64LE(BigInt(ptrVal), 16);

      // 命令行：CreateProcessW 的 lpCommandLine 是可修改的缓冲区
      const cmdW = Buffer.from(String(commandLine) + '\0', 'utf16le');

      // PROCESS_INFORMATION（x64 = 24 字节）
      const pi = Buffer.alloc(24);

      // 调用 CreateProcessW
      const ok = F.CreateProcessW(
        null,           // lpApplicationName（用命令行）
        cmdW,           // lpCommandLine
        null,           // lpProcessAttributes
        null,           // lpThreadAttributes
        0,              // bInheritHandles
        0,              // dwCreationFlags
        null,           // lpEnvironment
        null,           // lpCurrentDirectory
        si,             // lpStartupInfo
        pi              // lpProcessInformation
      );

      if (!ok) {
        const err = F.GetLastError();
        return { success: false, error: 'CreateProcessW 失败，错误码: ' + err };
      }

      // 读取 PROCESS_INFORMATION
      const hProcess = pi.readBigUInt64LE(0);
      const hThread = pi.readBigUInt64LE(8);
      const pid = pi.readUInt32LE(16);
      const tid = pi.readUInt32LE(20);

      // 关闭句柄（我们不需要保留进程/线程句柄）
      if (hProcess) F.CloseHandle(hProcess);
      if (hThread) F.CloseHandle(hThread);

      return { success: true, pid, tid, desktop: desktopName, command: commandLine };
    } finally {
      // 释放分配的内存
      try { F.LocalFree(pDesktop); } catch (e) { /* ignore */ }
    }
  } catch (e) {
    return { success: false, error: '在桌面启动程序失败: ' + ((e && e.message) || String(e)) };
  }
}

module.exports = {
  initWinAPI,
  screenInfo,
  coordScale,
  listWindows,
  findWindow,
  findWindowOnDesktop,
  listWindowsOnDesktop,
  focusWindow,
  getCursorPos,
  moveMouse,
  clickMouse,
  dragMouse,
  scrollMouse,
  mouseDown,
  mouseUp,
  typeText,
  pasteText,
  pressKey,
  hotkey,
  getClipboard,
  setClipboard,
  control,
  controlBackground,
  captureWindowByHwnd,
  launchProcessOnDesktop,
  createDesktop,
  getDesktopWindow
};
