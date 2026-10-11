// childSession.js —— 浮灵饰界 · WTS Child Session 管理（BetterGI 桌面分身同款机制）
// -----------------------------------------------------------------------------
// 用 wtsapi32.dll 原生 API 管理「RDP 子会话」：
//   WTSEnableChildSessions  开启本机 RDP 子会话能力
//   WTSIsChildSessionsEnabled 查询是否已启用
//   WTSGetChildSessionId    获取当前子会话 ID（无则 ERROR_NOT_FOUND=1168）
//   WTSLogoffSession        注销/销毁子会话（释放终端服务资源）
// 已验证：本机家庭版 WTSIsChildSessionsEnabled=true，WTSEnableChildSessions(1) 成功。
'use strict';
const koffi = require('koffi');

const wts = koffi.load('wtsapi32.dll');
const k32 = koffi.load('kernel32.dll');
const F = {};
F.WTSEnableChildSessions = wts.func('int __stdcall WTSEnableChildSessions(int enable)');
F.WTSIsChildSessionsEnabled = wts.func('int __stdcall WTSIsChildSessionsEnabled(_Out_ int* enabled)');
F.WTSGetChildSessionId = wts.func('int __stdcall WTSGetChildSessionId(_Out_ uint* sessionId)');
F.WTSLogoffSession = wts.func('int __stdcall WTSLogoffSession(void* server, uint sessionId, int wait)');
F.GetLastError = k32.func('int __stdcall GetLastError()');

const ERROR_NOT_FOUND = 1168;
const NO_SESSION_ID = 0xFFFFFFFF;

/** 查询子会话功能是否已启用 */
function isEnabled() {
  const p = Buffer.alloc(4);
  const r = F.WTSIsChildSessionsEnabled(p);
  return { success: !!r, enabled: r ? (p.readUInt32LE(0) === 1) : false, error: r ? undefined : ('WTSIsChildSessionsEnabled err=' + F.GetLastError()) };
}

/** 获取当前子会话 ID；无活动子会话返回 null */
function getSessionId() {
  const p = Buffer.alloc(4);
  const r = F.WTSGetChildSessionId(p);
  if (!r) {
    const err = F.GetLastError();
    if (err === ERROR_NOT_FOUND) return { success: true, sessionId: null };
    return { success: false, error: 'WTSGetChildSessionId err=' + err };
  }
  const id = p.readUInt32LE(0);
  return { success: true, sessionId: id === NO_SESSION_ID ? null : id };
}

/** 开启 RDP 子会话能力 */
function enable() {
  const r = F.WTSEnableChildSessions(1);
  return { success: !!r, error: r ? undefined : ('WTSEnableChildSessions err=' + F.GetLastError()) };
}

/** 注销子会话（销毁，释放资源） */
function logoff(wait = true) {
  const g = getSessionId();
  if (!g.success) return { success: false, error: g.error };
  if (g.sessionId == null) return { success: true, sessionId: null, note: '无活动子会话' };
  const r = F.WTSLogoffSession(null, g.sessionId, wait ? 1 : 0);
  if (!r) return { success: false, error: 'WTSLogoffSession err=' + F.GetLastError() };
  return { success: true, sessionId: g.sessionId };
}

/** 确保子会话能力开启并返回当前会话 ID（无则仅启用能力，不自动建会话） */
async function ensureEnabled() {
  const en = isEnabled();
  if (!en.enabled) {
    const e = enable();
    if (!e.success) return { success: false, error: e.error };
  }
  const g = getSessionId();
  return { success: true, enabled: true, sessionId: g.success ? g.sessionId : null };
}

function status() {
  const en = isEnabled();
  const g = getSessionId();
  return {
    supported: true,
    enabled: en.success ? en.enabled : false,
    sessionId: g.success ? g.sessionId : null,
    note: 'WTS Child Session（BetterGI 桌面分身同款），家庭版原生可用',
    error: !en.success ? en.error : (!g.success ? g.error : undefined)
  };
}

module.exports = { isEnabled, getSessionId, enable, logoff, ensureEnabled, status, ERROR_NOT_FOUND };
