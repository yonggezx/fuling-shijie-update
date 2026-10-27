// 全局键盘跟踪（Windows）：使用 koffi 调用 Windows API 定期查询按键状态
// 即使宠物窗口失去焦点，也能检测键盘按下/释放事件，用于 BongoCat 打字响应
// ★ 实现方式：轮询 GetAsyncKeyState（和全局鼠标跟踪一致），不使用低级键盘钩子 WH_KEYBOARD_LL。
// 之前用低级钩子需要 Windows 消息循环 + native 线程回调，容易因 V8 HandleScope 问题
// 导致钩子静默失败，全局键盘完全不响应。轮询方式更简单稳定。
//
// ★ 架构（参考 vladelaina/BongoCat 的设计思想，仅借鉴不移植代码）：
//   1) 有界边缘事件队列：轮询产生的 down/up 边缘事件先入队（带时间戳），按固定节拍批量推送，
//      避免高频打字时逐条 IPC 造成渲染端事件风暴与乱序。
//   2) 按住状态跟踪 + 全局清空：维护当前按住集合；锁屏/安全桌面（前台窗口为空）或
//      应用主动调用 clearAllKeys() 时清空所有按住并推送 {clear:true}，防止"手卡在按下位"。
//   3) 自适应轮询频率：连续无按键活动超过阈值后自动降频（20ms→120ms），检测到活动立即恢复，
//      空闲时大幅降低 CPU 占用，打字时保持响应灵敏。
const koffi = require('koffi');

let user32 = null;
let GetAsyncKeyState = null;
let GetForegroundWindow = null;

let trackingInterval = null;
let flushTimer = null;
let onKeyEvent = null;

// 轮询与推送参数
const THROTTLE_MS = 20;         // 活动期轮询间隔：20ms（约50fps）
const IDLE_THROTTLE_MS = 30;    // 空闲期轮询间隔：30ms（仍比活动期20ms低，略省CPU）
                                // 不能太大（如120ms）：空闲后首次按键最多要等一个间隔才被捕捉，
                                // 导致按键手势"要等一会才出现"。30ms 内捕捉，几乎瞬时显示。
const IDLE_MS = 4000;           // 连续无按键活动多少 ms 后进入空闲降频
const FLUSH_MS = 16;            // 批量推送节拍：16ms（≈60fps，与渲染帧率匹配）
const MAX_QUEUE = 128;          // 有界边缘队列上限（超出丢弃最旧事件，防止内存膨胀）

let currentIntervalMs = THROTTLE_MS; // 当前实际轮询间隔（自适应切换用）
let lastActivity = 0;               // 最近一次按键活动时间（ms）
let edgeQueue = [];                 // 待批量推送的按键边缘事件（带时间戳）
let heldKeys = new Map();           // 当前按住集合 vkCode -> {key, code}
let sessionLocked = false;          // 是否处于锁屏/安全桌面（前台窗口为空）

// 需要监控的虚拟键码列表（常用键）
// 格式：{ vk: 虚拟键码, key: 键名字符, code: KeyboardEvent.code }
const MONITORED_KEYS = [
  // 字母键 A-Z
  { vk: 0x41, key: 'a', code: 'KeyA' },
  { vk: 0x42, key: 'b', code: 'KeyB' },
  { vk: 0x43, key: 'c', code: 'KeyC' },
  { vk: 0x44, key: 'd', code: 'KeyD' },
  { vk: 0x45, key: 'e', code: 'KeyE' },
  { vk: 0x46, key: 'f', code: 'KeyF' },
  { vk: 0x47, key: 'g', code: 'KeyG' },
  { vk: 0x48, key: 'h', code: 'KeyH' },
  { vk: 0x49, key: 'i', code: 'KeyI' },
  { vk: 0x4A, key: 'j', code: 'KeyJ' },
  { vk: 0x4B, key: 'k', code: 'KeyK' },
  { vk: 0x4C, key: 'l', code: 'KeyL' },
  { vk: 0x4D, key: 'm', code: 'KeyM' },
  { vk: 0x4E, key: 'n', code: 'KeyN' },
  { vk: 0x4F, key: 'o', code: 'KeyO' },
  { vk: 0x50, key: 'p', code: 'KeyP' },
  { vk: 0x51, key: 'q', code: 'KeyQ' },
  { vk: 0x52, key: 'r', code: 'KeyR' },
  { vk: 0x53, key: 's', code: 'KeyS' },
  { vk: 0x54, key: 't', code: 'KeyT' },
  { vk: 0x55, key: 'u', code: 'KeyU' },
  { vk: 0x56, key: 'v', code: 'KeyV' },
  { vk: 0x57, key: 'w', code: 'KeyW' },
  { vk: 0x58, key: 'x', code: 'KeyX' },
  { vk: 0x59, key: 'y', code: 'KeyY' },
  { vk: 0x5A, key: 'z', code: 'KeyZ' },
  // 数字键 0-9
  { vk: 0x30, key: '0', code: 'Digit0' },
  { vk: 0x31, key: '1', code: 'Digit1' },
  { vk: 0x32, key: '2', code: 'Digit2' },
  { vk: 0x33, key: '3', code: 'Digit3' },
  { vk: 0x34, key: '4', code: 'Digit4' },
  { vk: 0x35, key: '5', code: 'Digit5' },
  { vk: 0x36, key: '6', code: 'Digit6' },
  { vk: 0x37, key: '7', code: 'Digit7' },
  { vk: 0x38, key: '8', code: 'Digit8' },
  { vk: 0x39, key: '9', code: 'Digit9' },
  // 小键盘数字 0-9
  { vk: 0x60, key: '0', code: 'Numpad0' },
  { vk: 0x61, key: '1', code: 'Numpad1' },
  { vk: 0x62, key: '2', code: 'Numpad2' },
  { vk: 0x63, key: '3', code: 'Numpad3' },
  { vk: 0x64, key: '4', code: 'Numpad4' },
  { vk: 0x65, key: '5', code: 'Numpad5' },
  { vk: 0x66, key: '6', code: 'Numpad6' },
  { vk: 0x67, key: '7', code: 'Numpad7' },
  { vk: 0x68, key: '8', code: 'Numpad8' },
  { vk: 0x69, key: '9', code: 'Numpad9' },
  // 功能键 F1-F12
  { vk: 0x70, key: 'F1', code: 'F1' },
  { vk: 0x71, key: 'F2', code: 'F2' },
  { vk: 0x72, key: 'F3', code: 'F3' },
  { vk: 0x73, key: 'F4', code: 'F4' },
  { vk: 0x74, key: 'F5', code: 'F5' },
  { vk: 0x75, key: 'F6', code: 'F6' },
  { vk: 0x76, key: 'F7', code: 'F7' },
  { vk: 0x77, key: 'F8', code: 'F8' },
  { vk: 0x78, key: 'F9', code: 'F9' },
  { vk: 0x79, key: 'F10', code: 'F10' },
  { vk: 0x7A, key: 'F11', code: 'F11' },
  { vk: 0x7B, key: 'F12', code: 'F12' },
  // 修饰键
  { vk: 0x10, key: 'Shift', code: 'ShiftLeft' },
  { vk: 0x11, key: 'Control', code: 'ControlLeft' },
  { vk: 0x12, key: 'Alt', code: 'AltLeft' },
  // 常用特殊键
  { vk: 0x08, key: 'Backspace', code: 'Backspace' },
  { vk: 0x09, key: 'Tab', code: 'Tab' },
  { vk: 0x0D, key: 'Enter', code: 'Enter' },
  { vk: 0x1B, key: 'Escape', code: 'Escape' },
  { vk: 0x20, key: ' ', code: 'Space' },
  { vk: 0x2E, key: 'Delete', code: 'Delete' },
  // 方向键
  { vk: 0x25, key: 'ArrowLeft', code: 'ArrowLeft' },
  { vk: 0x26, key: 'ArrowUp', code: 'ArrowUp' },
  { vk: 0x27, key: 'ArrowRight', code: 'ArrowRight' },
  { vk: 0x28, key: 'ArrowDown', code: 'ArrowDown' },
];

// 记录每个按键的上一个状态（用于检测状态变化）
let keyStates = new Uint8Array(256); // 0=释放, 1=按下

function initWinAPI() {
  if (user32) return true;
  try {
    user32 = koffi.load('user32.dll');
    // GetAsyncKeyState：返回值最高位(0x8000)表示按键是否按下
    GetAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int vKey)');
    // GetForegroundWindow：返回前台窗口句柄；锁屏/安全桌面时为 0/null
    GetForegroundWindow = user32.func('void* __stdcall GetForegroundWindow()');
    return true;
  } catch (e) {
    console.error('[GlobalKeyboard] 初始化 Windows API 失败:', e.message);
    return false;
  }
}

// 查询按键状态：高位(0x8000)=当前是否按下；低位(0x0001)=自上次调用以来是否被按下过。
// ★ 低位用于补抓"两次轮询之间按下又抬起"的极快击键，避免漏键（对齐 vladelaina/BongoCat
// 用 Raw Input 离散边沿不丢键的设计思想）。
function queryKeyState(vkCode) {
  if (!GetAsyncKeyState) return { down: false, tapped: false };
  try {
    const state = GetAsyncKeyState(vkCode);
    return { down: (state & 0x8000) !== 0, tapped: (state & 0x0001) !== 0 };
  } catch (e) {
    return { down: false, tapped: false };
  }
}

// 进入/处于锁屏状态：前台窗口为空（锁屏、安全桌面、UAC 弹层等）
function isSessionLocked() {
  if (!GetForegroundWindow) return false;
  try {
    const hwnd = GetForegroundWindow();
    return !hwnd;
  } catch (e) {
    return false;
  }
}

// 清空所有按住状态：返回被清空（释放）的按键边缘事件列表
// 同步把 keyStates 归零，避免下一次轮询把"还按着的物理键"误判成新按下
function clearAllHeld() {
  if (!heldKeys.size) return [];
  const now = Date.now();
  const released = [];
  for (const [vk, info] of heldKeys) {
    released.push({ key: info.key, code: info.code, vkCode: vk, type: 'up', t: now });
    keyStates[vk] = 0;
  }
  heldKeys.clear();
  lastActivity = now;
  return released;
}

// 主动清空所有按住（窗口隐藏/最小化、关闭 BongoCat 时由主进程调用）：
// 立即推送一条 {clear:true} 事件，渲染端据此复位手部状态与按键图
function clearAllKeys() {
  const released = clearAllHeld();
  if (released.length && onKeyEvent) {
    onKeyEvent({ clear: true, events: released });
  }
  return released;
}

// 批量推送节拍：把队列中的边缘事件合并成一条 IPC
function startFlusher() {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    if (!edgeQueue.length || !onKeyEvent) return;
    const batch = edgeQueue;
    edgeQueue = [];
    onKeyEvent({ batch: true, events: batch });
  }, FLUSH_MS);
}

// 自适应轮询频率：空闲降频省 CPU，活动立即恢复灵敏
function adaptInterval(now) {
  const wantMs = (now - lastActivity > IDLE_MS) ? IDLE_THROTTLE_MS : THROTTLE_MS;
  if (wantMs === currentIntervalMs) return;
  currentIntervalMs = wantMs;
  clearInterval(trackingInterval);
  trackingInterval = setInterval(pollTick, wantMs);
  console.log('[GlobalKeyboard] 轮询频率已切换: ' + wantMs + 'ms' + (wantMs === IDLE_THROTTLE_MS ? '（空闲降频，省 CPU）' : '（活动恢复灵敏）'));
}

// 单次轮询：检测按键变化 + 锁屏/解锁检测
function pollTick() {
  const now = Date.now();
  let changed = false;

  // 锁屏/安全桌面检测：进入锁屏时清空按住（防"手卡在按下位"），解锁后恢复灵敏
  const locked = isSessionLocked();
  if (locked !== sessionLocked) {
    sessionLocked = locked;
    if (locked) {
      const released = clearAllHeld();
      if (released.length && onKeyEvent) {
        onKeyEvent({ clear: true, events: released });
      }
      console.log('[GlobalKeyboard] 检测到锁屏/安全桌面，已清空按住状态(' + released.length + '个键)');
    } else {
      lastActivity = now;
    }
  }

  for (const k of MONITORED_KEYS) {
    const { down, tapped } = queryKeyState(k.vk);
    const nowDown = down ? 1 : 0;
    const prevDown = keyStates[k.vk];

    // 判定需要入队的边沿：真实按下 / 真实抬起 / 合成点按（漏抓的极快击键）
    let emit = null;
    if (nowDown && !prevDown) {
      emit = 'down';          // 真实按下
    } else if (!nowDown && prevDown) {
      emit = 'up';            // 真实抬起
    } else if (!nowDown && !prevDown && tapped) {
      // ★ 修复：两次轮询之间"按下又抬起"的极快击键（如快速连打），GetAsyncKeyState
      // 高位已归零，但低位记录了"自上次调用后被按下过"，据此补发一次 down，
      // 否则高速打字会丢键、猫不响应。下一拍真实轮询会产出对应的 up 收尾。
      emit = 'down';
    }

    if (emit) {
      keyStates[k.vk] = (emit === 'down') ? 1 : 0;
      changed = true;
      const ev = {
        key: k.key,
        code: k.code,
        vkCode: k.vk,
        type: emit,
        t: now
      };
      if (edgeQueue.length < MAX_QUEUE) edgeQueue.push(ev);
      if (emit === 'down') heldKeys.set(k.vk, { key: k.key, code: k.code });
      else heldKeys.delete(k.vk);
    }
  }

  if (changed) lastActivity = now;
  adaptInterval(now);
}

// 启动全局键盘跟踪
function startGlobalKeyboardHook(callback) {
  if (process.platform !== 'win32') {
    console.warn('[GlobalKeyboard] 仅支持 Windows 平台');
    return false;
  }
  if (trackingInterval) {
    console.warn('[GlobalKeyboard] 键盘跟踪已在运行');
    return false;
  }
  if (!initWinAPI()) return false;

  onKeyEvent = callback;
  // 初始化按键状态与按住集合（启动时物理上按住的键视为已按下，不补发 down）
  for (const k of MONITORED_KEYS) {
    const st = queryKeyState(k.vk);
    const down = st.down ? 1 : 0;
    keyStates[k.vk] = down;
    if (down === 1) heldKeys.set(k.vk, { key: k.key, code: k.code });
  }
  sessionLocked = isSessionLocked();
  lastActivity = Date.now();
  currentIntervalMs = THROTTLE_MS;

  trackingInterval = setInterval(pollTick, THROTTLE_MS);
  startFlusher();

  console.log('[GlobalKeyboard] 全局键盘跟踪已启动（轮询 ' + THROTTLE_MS + 'ms / 空闲降频 ' + IDLE_THROTTLE_MS + 'ms，批量推送 ' + FLUSH_MS + 'ms，监控 ' + MONITORED_KEYS.length + ' 个键）');
  return true;
}

// 停止全局键盘跟踪
function stopGlobalKeyboardHook() {
  if (trackingInterval) {
    clearInterval(trackingInterval);
    trackingInterval = null;
  }
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  edgeQueue = [];
  heldKeys.clear();
  keyStates.fill(0);
  sessionLocked = false;
  lastActivity = 0;
  currentIntervalMs = THROTTLE_MS;
  onKeyEvent = null;
  console.log('[GlobalKeyboard] 全局键盘跟踪已停止');
}

module.exports = {
  startGlobalKeyboardHook,
  stopGlobalKeyboardHook,
  clearAllKeys
};
