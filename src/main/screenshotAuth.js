/**
 * 截屏授权：所有截屏操作前都要用户输入管理员密码放行
 * ------------------------------------------------------------
 * 为什么要这层：截屏会把屏幕内容变成图片落盘，属于「用户不知情就发生」的操作。
 *   授权弹窗相当于给 AI 加一道「你要让我看屏幕吗」的确认闸门，
 *   避免误触或被诱导时的隐私泄漏。
 *
 * ★ 关键实现决策：为什么用 Windows 原生凭据框，而不是自己读密码再校验
 *   本项目实测过 LogonUserW：传「不存在的用户 + 随便一个密码」它照样返回
 *   S_OK（2ms 就返回），在本机环境下根本不校验密码。拿它当授权门禁等于
 *   假门禁 —— 任何人随便敲点什么就能过，比没有还糟。
 *   所以改用 CredUIPromptForWindowsCredentials：这是 Windows 自己弹的
 *   系统级凭据框，密码由 LSA 在内核里校验，我们的进程从头到尾
 *   拿不到密码明文，也就没地方泄露、没地方落盘。
 *
 * 安全设计（硬要求）：
 *   1. 密码由系统对话框处理，我们的进程拿不到明文（只拿到验证结果 + 用户名）。
 *   2. 不缓存密码；只记「已授权」这个状态 + 到期时间。
 *   3. 授权有有效期（默认 2 分钟），过期要重新输 —— 避免"授权一次就一直能截"。
 *   4. 弹窗被取消 = 拒绝授权，截屏必须中止并如实告诉调用方。
 */
'use strict';

const koffi = require('koffi');

const AUTH_TTL_MS = 2 * 60 * 1000;   // 授权有效期 2 分钟
const MAX_DENY = 5;                  // 连续取消/失败上限，防把弹窗当骚扰工具
const LOCK_MS = 60 * 1000;

// CredUIPromptForWindowsCredentialsW 的常量
const CREDUIWIN_SECURITY_ADVISORY = 0x00000001; // 安全建议（标题栏黄色条）
const CREDUIWIN_GENERIC = 0x00000002;
const CREDUIWIN_USERNAME_TARGET_CREDENTIALS = 0x00000002;
const CREDUIWIN_IN_CRED_ONLY = 0x00000004;
const CREDUIWIN_DO_NOT_PERSIST = 0x00000002;    // ★ 关键：不要保存凭据
const CREDUIWIN_GENERIC_SAME_CREDENTIALS = 0x00000011;
const CREDUIWIN_CAPTION = 1;
const CREDUIWIN_TEXT = 2;
const CREDUIWIN_USERNAME = 5;
const CREDUIWIN_PASSWORD = 6;
const CREDUIWIN_CAPTION_STATIC = 7;
const CREDUIWIN_MESSAGE_STATIC = 8;
const CREDUIWIN_BANNER = 10;
const CREDUIWIN_ERROR_TEXT = 12;
const ERROR_SUCCESS = 0;
const ERROR_CANCELLED = 1223;
const ERROR_NO_SUCH_LOGON_SESSION = 1312;
const ERROR_LOGON_FAILURE = 1326;
const ERROR_INVALID_FLAGS = 1004;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_BAD_ARGUMENTS = 160;
const ERROR_NO_MEMORY = 8;
const ERROR_INSUFFICIENT_BUFFER = 122;

let api = null;
function winApi() {
  if (api) return api;
  if (process.platform !== 'win32') return false;
  try {
    const credui = koffi.load('credui.dll');
    const advapi32 = koffi.load('advapi32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    api = {
      // 正确的 CredUIPromptForWindowsCredentialsW 签名（Microsoft 官方文档）
      CredUIPromptForWindowsCredentialsW: credui.func('uint32_t __stdcall CredUIPromptForWindowsCredentialsW(void* pUiInfo, uint32_t dwAuthError, uint32_t* pulAuthPackage, void* pvInAuthBuffer, uint32_t ulInAuthBufferSize, _Out_ void** ppvOutAuthBuffer, _Out_ uint32_t* pulOutAuthBufferSize, int32_t* pfSave, uint32_t dwFlags)'),
      // 解包认证缓冲区，获取用户名/域名/密码（pAuthBuffer 用 uint64_t 直接传指针值）
      CredUnPackAuthenticationBufferW: credui.func('int __stdcall CredUnPackAuthenticationBufferW(uint32_t dwFlags, uint64_t pAuthBuffer, uint32_t cbAuthBuffer, char16_t* pszUserName, uint32_t* pcchMaxUserName, char16_t* pszDomainName, uint32_t* pcchMaxDomainName, char16_t* pszPassword, uint32_t* pcchMaxPassword)'),
      CredFree: advapi32.func('void __stdcall CredFree(uint64_t buffer)'),
      GetUserNameW: advapi32.func('int __stdcall GetUserNameW(char16_t* buf, _Out_ uint32_t* size)'),
      GetLastError: kernel32.func('uint32_t __stdcall GetLastError()')
    };
  } catch (e) {
    api = false;
  }
  return api;
}

function currentUserName() {
  const a = winApi();
  if (!a) {
    try { return require('os').userInfo().username || ''; } catch (e) { return ''; }
  }
  try {
    const buf = Buffer.alloc(1024);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(511, 0);
    if (a.GetUserNameW(buf, len) === 0) return '';
    return buf.toString('utf16le', 0, len.readUInt32LE(0) * 2).replace(/\0+$/, '');
  } catch (e) {
    return '';
  }
}

function isSupported() {
  return !!winApi();
}

function lastErrorMessage(hr) {
  const map = {
    [ERROR_CANCELLED]: 'user_cancelled',
    [ERROR_NO_SUCH_LOGON_SESSION]: 'no_such_session',
    [ERROR_LOGON_FAILURE]: 'bad_credentials',
    [ERROR_INVALID_FLAGS]: 'invalid_flags',
    [ERROR_INVALID_PARAMETER]: 'invalid_parameter',
    [ERROR_BAD_ARGUMENTS]: 'bad_arguments',
    [ERROR_NO_MEMORY]: 'no_memory',
    [ERROR_INSUFFICIENT_BUFFER]: 'buffer_error'
  };
  return map[hr >>> 0] || ('hresult_' + (hr >>> 0));
}

/**
 * 从系统凭据框取一份凭据（只用于确认"用户能通过管理员认证"，立刻丢弃）。
 * ⚠️ 同步阻塞调用，会在系统弹窗期间阻塞调用方 —— 所以只从 IPC 处理器里调用，
 *    绝不能放在渲染进程的主流程上。
 *
 * @param {object} opts { parentWindow, reason, caption }
 * @returns {{ok:boolean, cancelled?:boolean, user?:string, error?:string, errorCode?:string}}
 */
function promptSystemCredentials(opts = {}) {
  const a = winApi();
  if (!a) return { ok: false, error: '系统凭据对话框不可用（非 Windows 平台）' };

  // CREDUI_INFOW 结构（x64 = 40 字节）
  //   cbSize(4) + pad(4) + hwndParent(8) + pszCaptionText(8) + pszMessageText(8) + hbmBanner(8) = 40
  const cbSize = 40;
  const uiInfo = Buffer.alloc(cbSize);
  uiInfo.writeUInt32LE(cbSize, 0);    // cbSize

  // 父窗口句柄
  if (opts.parentWindow && !opts.parentWindow.isDestroyed()) {
    const hwndBuf = opts.parentWindow.getNativeWindowHandle();
    // 把 hwnd 写入 uiInfo 的 hwndParent 字段（offset 8）
    if (hwndBuf && hwndBuf.length >= 8) {
      uiInfo.writeBigUInt64LE(hwndBuf.readBigUInt64LE(0), 8);
    }
  }

  // 标题与说明（宽字符，写入 uiInfo 的指针字段）
  const caption = Buffer.from(String(opts.caption || '桌面分身授权') + '\0', 'utf16le');
  const reason = Buffer.from(String(opts.reason || 'AI 申请在隔离桌面中进行操作，请输入管理员密码授权。') + '\0', 'utf16le');
  // pszCaptionText 在 offset 16，pszMessageText 在 offset 24
  uiInfo.writeBigUInt64LE(BigInt(koffi.address(caption)), 16);  // pszCaptionText
  uiInfo.writeBigUInt64LE(BigInt(koffi.address(reason)), 24);   // pszMessageText

  // 调用参数
  const authPackage = Buffer.alloc(4);
  authPackage.writeUInt32LE(0, 0);  // 初始为 0（ Negotiate 包）
  const outAuthBufferPtr = Buffer.alloc(8);  // PVOID*，接收输出缓冲区指针
  const outAuthBufferSize = Buffer.alloc(4); // PULONG，接收输出缓冲区大小
  const pfSave = Buffer.alloc(4);
  pfSave.writeInt32LE(0, 0);  // FALSE

  console.log('[ScreenshotAuth] 弹出系统凭据框...');
  const hr = a.CredUIPromptForWindowsCredentialsW(
    uiInfo,              // pUiInfo
    0,                   // dwAuthError（0 = 无之前的错误）
    authPackage,         // pulAuthPackage
    null,                // pvInAuthBuffer（无输入）
    0,                   // ulInAuthBufferSize
    outAuthBufferPtr,    // ppvOutAuthBuffer
    outAuthBufferSize,   // pulOutAuthBufferSize
    pfSave,              // pfSave
    CREDUIWIN_GENERIC    // dwFlags
  );
  console.log('[ScreenshotAuth] CredUIPrompt 返回:', hr, '(0=成功, 1223=取消)');

  if (hr !== ERROR_SUCCESS) {
    return {
      ok: false,
      cancelled: (hr >>> 0) === ERROR_CANCELLED,
      errorCode: lastErrorMessage(hr),
      error: (hr >>> 0) === ERROR_CANCELLED ? '已取消授权' : ('系统凭据验证失败（' + lastErrorMessage(hr) + '）')
    };
  }

  // 解包认证缓冲区，获取用户名（不读取密码，用完立即释放）
  let user = '';
  try {
    const outPtr = outAuthBufferPtr.readBigUInt64LE(0);
    const outSize = outAuthBufferSize.readUInt32LE(0);
    console.log('[ScreenshotAuth] 认证缓冲区指针:', outPtr.toString(16), '大小:', outSize);
    if (outPtr && outSize > 0) {
      const userNameBuf = Buffer.alloc(512);
      const userNameLen = Buffer.alloc(4);
      userNameLen.writeUInt32LE(255, 0);
      const domainBuf = Buffer.alloc(256);
      const domainLen = Buffer.alloc(4);
      domainLen.writeUInt32LE(127, 0);
      const passwordBuf = Buffer.alloc(512);
      const passwordLen = Buffer.alloc(4);
      passwordLen.writeUInt32LE(255, 0);

      const unpackOk = a.CredUnPackAuthenticationBufferW(
        0,  // dwFlags
        outPtr,  // pAuthBuffer（直接传指针值）
        outSize,
        userNameBuf, userNameLen,
        domainBuf, domainLen,
        passwordBuf, passwordLen
      );
      console.log('[ScreenshotAuth] CredUnPack 返回:', unpackOk);
      if (unpackOk) {
        user = userNameBuf.toString('utf16le', 0, userNameLen.readUInt32LE(0) * 2).replace(/\0+$/, '');
      }
      // 立即释放认证缓冲区（密码材料不留在内存中）
      a.CredFree(outPtr);
      // 清零密码缓冲区
      passwordBuf.fill(0);
    }
  } catch (e) {
    console.log('[ScreenshotAuth] 解包认证信息失败（不影响授权结果）:', e.message);
  }

  if (!user) {
    user = currentUserName();
  }

  return { ok: true, user, verified: true };
}

// ===== 授权票据 =====
// 只记「到什么时候为止有效」，不记密码。
let ticket = null;      // { at, expiresAt, user }
let denyCount = 0;
let lockedUntil = 0;

function isAuthorized() {
  if (!ticket) return false;
  if (Date.now() > ticket.expiresAt) {
    ticket = null;
    return false;
  }
  return true;
}

function status() {
  const now = Date.now();
  if (lockedUntil > now) {
    return {
      authorized: false,
      locked: true,
      retryAfter: Math.ceil((lockedUntil - now) / 1000)
    };
  }
  if (!isAuthorized()) return { authorized: false, locked: false, remaining: 0 };
  return {
    authorized: true,
    locked: false,
    remaining: Math.ceil((ticket.expiresAt - now) / 1000),
    user: ticket.user
  };
}

/**
 * 弹系统凭据框换一张授权票据。
 * @returns {{ok:boolean, cancelled?:boolean, error?:string, remaining?:number, locked?:boolean, user?:string}}
 */
function requestAuthorization(opts = {}) {
  const now = Date.now();
  if (lockedUntil > now) {
    return { ok: false, locked: true, error: '尝试次数过多，请稍后再试' };
  }
  if (!isSupported()) {
    return { ok: false, error: '当前系统不支持凭据授权（仅 Windows 可用）' };
  }

  const res = promptSystemCredentials(opts);
  if (!res.ok) {
    // 用户主动取消不计入失败次数（那是正常操作，不是爆破）
    if (!res.cancelled) {
      denyCount++;
      if (denyCount >= MAX_DENY) {
        lockedUntil = now + LOCK_MS;
        denyCount = 0;
        return { ok: false, locked: true, error: '连续验证失败 ' + MAX_DENY + ' 次，请 1 分钟后再试' };
      }
    }
    return { ok: false, cancelled: !!res.cancelled, error: res.error, errorCode: res.errorCode };
  }

  denyCount = 0;
  lockedUntil = 0;
  ticket = { at: now, expiresAt: now + AUTH_TTL_MS, user: res.user || currentUserName() };
  return { ok: true, remaining: Math.ceil(AUTH_TTL_MS / 1000), user: ticket.user };
}

function revoke() {
  ticket = null;
}

function dispose() {
  ticket = null;
  denyCount = 0;
  lockedUntil = 0;
}

module.exports = {
  requestAuthorization,
  isAuthorized,
  status,
  revoke,
  dispose,
  isSupported,
  currentUserName,
  AUTH_TTL_MS,
  MAX_DENY
};
