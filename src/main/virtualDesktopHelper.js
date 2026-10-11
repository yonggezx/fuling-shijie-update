/**
 * 虚拟桌面 COM 辅助进程（独立 Node 进程）
 * ------------------------------------------------------------
 * 为什么必须有这个进程：
 *   Electron 主线程的 COM apartment 由 Chromium 决定且已被占用，
 *   在主进程里调 CoInitializeEx 恒返回 0x80070057 (E_INVALIDARG)，
 *   CoCreateInstance 直接 0x80040110 (CLASS_E_NO_REGISTRATION)。
 *   独立 Node 进程没有这层限制，COM 完全可用（已实测）。
 *
 * 协议：stdin 收 JSON 行，stdout 回 JSON 行。
 *   → { id, op, args }
 *   ← { id, ok, result } 或 { id, ok:false, error }
 *
 * 只做「查询类」操作（列桌面 / 查当前桌面 / 查窗口桌面）。
 * 改系统状态的操作（切换/新建/删除）由主进程用 SendInput 发系统快捷键完成，
 * 不走这里 —— 快捷键通道稳定，且不需要 COM。
 */
'use strict';

const readline = require('readline');
// 本文件和 virtualDesktop.js 同目录（都在 src/main/），用 './virtualDesktop'
const vd = require('./virtualDesktop');

function send(obj) {
  try {
    process.stdout.write(JSON.stringify(obj) + '\n');
  } catch (e) { /* 主进程可能已断开 */ }
}

const OPS = {
  /** 能力探测 */
  status: async () => vd.isAvailable(),

  /** 列出全部桌面 */
  list: async () => {
    const r = await vd.listDesktops();
    return r;
  },

  /** 当前桌面 */
  current: async () => {
    const r = await vd.currentDesktop();
    return r;
  },

  /** 某个窗口在哪个桌面 */
  windowDesktop: async (args) => vd.desktopOfWindow(args.hwnd),

  /** ping：确认进程活着 */
  ping: async () => ({ pong: true, pid: process.pid })
};

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  const txt = String(line || '').trim();
  if (!txt) return;
  let req;
  try {
    req = JSON.parse(txt);
  } catch (e) {
    send({ id: null, ok: false, error: '请求不是合法 JSON' });
    return;
  }
  const { id, op, args } = req || {};
  const fn = OPS[op];
  if (!fn) {
    send({ id, ok: false, error: '未知操作: ' + op });
    return;
  }
  try {
    const result = await fn(args || {});
    send({ id, ok: true, result });
  } catch (e) {
    send({ id, ok: false, error: (e && e.message) ? e.message : String(e) });
  }
});

rl.on('close', () => {
  try { vd.dispose(); } catch (e) { /* ignore */ }
  process.exit(0);
});

// 启动即初始化一次，把失败原因尽早暴露给主进程
try {
  const av = vd.init();
  process.stderr.write('[vdesk-helper] ready ' + JSON.stringify(av) + '\n');
} catch (e) {
  process.stderr.write('[vdesk-helper] init failed: ' + (e && e.message) + '\n');
}

process.on('uncaughtException', (e) => {
  // 辅助进程崩了不能连累主进程，报告后退出，主进程会按"不可用"降级
  try { process.stderr.write('[vdesk-helper] uncaught: ' + (e && e.stack) + '\n'); } catch (_) {}
  process.exit(3);
});
