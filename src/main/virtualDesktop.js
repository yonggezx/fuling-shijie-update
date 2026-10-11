/**
 * 原生虚拟桌面（Windows Virtual Desktop）控制
 * ------------------------------------------------------------
 * 为什么需要它：AI 要在「干净、可预期」的环境里截屏/验证界面。
 *   走操作系统自带的虚拟桌面 API，就能把被验证的程序挪到一个独立桌面里，
 *   在那儿截屏，既不会把用户当前桌面上的隐私内容一起框进来，
 *   也不会干扰用户正在做的事（窗口真被挪到别的桌面去了）。
 *
 * 实现方式：koffi 直接走 COM vtable，不额外引入 C++ 编译链。
 *   Microsoft 官方只公开了 IVirtualDesktopManager（只能查/挪窗口），
 *   「列出/新建/切换/重命名/删除桌面」在 IVirtualDesktopManagerInternal 上，
 *   后者未文档化但自 Win10 1809 起一直存在，通过 ImmersiveShell 的
 *   IServiceProvider10::QueryService 取。微软随时可能改它的 IID，
 *   所以下面按 build 号做了多套 IID 兜底，取不到就明确报错而不是假装成功。
 *
 * 关键坑（都踩过）：
 *   1) 必须先 CoInitializeEx(COINIT_APARTMENTTHREADED)，否则 CoCreateInstance
 *      直接返回 0x800401F0 CLASS_E_CLASSNOTAVAILABLE（看着像"系统不支持"，其实是没初始化 COM）。
 *   2) vtable 槽位不能乱猜：槽 0/1/2 是 QueryInterface/AddRef/Release，
 *      从槽 3 起才是接口自己的方法，差一格就调到别的函数上直接段错误。
 *   3) 用 koffi.decode(ptr, proto) 把槽位地址还原成 JS 函数再用；
 *      直接 koffi.call(bigint, ...) 在本机稳定段错误，别用。
 *   4) COM 接口方法首参是 this（接口指针），要显式传。
 *
 * 仅 Windows 可用；其它平台 / 接口不可用时统一返回 { success:false, error }。
 */
'use strict';

let koffi = null;
let comReady = false;
let apiError = null;

// 公开且稳定的 CLSID / IID
const CLSID_VirtualDesktopManager = 'AA509086-5CA9-4C25-8F95-589D3C07B48A';
const CLSID_ImmersiveShell = 'C2F03A33-21F5-47FA-B4BB-156362A2F239';
const IID_IVirtualDesktopManager = 'A5CD92FF-29BE-454C-8D04-D82879FB3F1B';
const IID_IVirtualDesktop = 'FF72FFDD-BE7E-43FC-9C03-AD81681E88E4';
const IID_IObjectArray = '92CA9DCD-5622-4BBA-A805-5E9F541BD8C9';
const IID_IServiceProvider10 = '6D5140C1-7436-11CE-8034-00AA006009FA';
const CLSID_VirtualDesktopManagerInternal = 'C5E0CDCA-7B6E-41B2-9FC4-D93975CC467B';

/**
 * 内部接口 IID 候选（按 build 从新到旧试）。
 * ⚠️ 实测记录（本机 Windows 11 build 26200）：
 *   只有 53F5CA0B-158F-4124-900C-057158060B27 返回 S_OK，
 *   其余（22621+ 的 A3175F2D…、19041+ 的 F31574D6…、Win10 基线 AF8DA486…）全是 0x80004002 E_NOINTERFACE。
 *   所以新 build 的 IID 必须排在最前面，否则会误判成"接口不可用"。
 */
const IID_INTERNAL_CANDIDATES = [
  '53F5CA0B-158F-4124-900C-057158060B27', // 26100+（Win11 24H2/25H2 实测有效）
  'A3175F2D-239C-4BD2-8AA0-EEBA8B0B138E', // 22621+（22H2）
  'F31574D6-B682-4CDC-BD56-1827860ABEC6', // 19041+（Win10 2004+）
  'B2F925B9-5A0F-4D2E-9F4D-2B1507593C10', // 22000（Win11 21H2 早期）
  'AF8DA486-95BB-4460-B3B7-6E7A6B2962B5'  // Win10 1809 基线
];

// IVirtualDesktop：槽 3 = GetId（返回 GUID）
// IVirtualDesktopManagerInternal 槽位（Win10 1809 基线）：
//   3 GetCount / 4 GetCurrentDesktop / 5 GetDesktops / 6 GetAdjacentDesktop
//   7 SwitchDesktop / 8 CreateDesktop / 9 RemoveDesktop / 10 FindDesktop
// 22621+ 追加 SetName（在末尾，槽 11）
const SLOT = {
  ifaceGetId: 3,
  intGetCount: 3,
  intGetCurrent: 4,
  intGetDesktops: 5,
  intSwitch: 7,
  intCreate: 8,
  intRemove: 9,
  intFind: 10,
  intSetName: 11
};

const CLSCTX_ALL = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function guidBuf(s) {
  const h = String(s).replace(/-/g, '');
  const b = Buffer.alloc(16);
  b.writeUInt32LE(parseInt(h.slice(0, 8), 16), 0);
  b.writeUInt16LE(parseInt(h.slice(8, 12), 16), 4);
  b.writeUInt16LE(parseInt(h.slice(12, 16), 16), 6);
  Buffer.from(h.slice(16), 'hex').copy(b, 8);
  return b;
}

function guidStr(buf) {
  const d1 = buf.readUInt32LE(0).toString(16).padStart(8, '0');
  const d2 = buf.readUInt16LE(4).toString(16).padStart(4, '0');
  const d3 = buf.readUInt16LE(6).toString(16).padStart(4, '0');
  const d4 = buf.subarray(8, 16).toString('hex').toUpperCase();
  return `${d1.toUpperCase()}-${d2.toUpperCase()}-${d3.toUpperCase()}-${d4.slice(0, 4)}-${d4.slice(4)}`;
}

function windowsBuild() {
  try {
    // os.release() 形如 "10.0.26300"（三段：major.minor.build），
    // build 是最后一段。之前误取第 0 段（=10，永远命中不到新版 IID 分支）。
    const parts = String(require('os').release()).split('.').map(n => parseInt(n, 10) || 0);
    return parts.length ? parts[parts.length - 1] : 0;
  } catch (e) {
    return 0;
  }
}

let ole32 = null;
let CoCreateInstance = null;
let vdm = null;          // IVirtualDesktopManager（公开接口）
let vdmInternal = null;  // IVirtualDesktopManagerInternal
let supportsName = false;
let internalIid = null;  // 实际生效的内部接口 IID，诊断用
let shellError = null;
let comApartment = -1;   // 实际生效的 apartment（2=STA 0=MTA），诊断用
let lastInitHr = 0;
let comDisabledReason = null; // 一旦判定 COM 不可用就记下来，不再反复试

// ===== 辅助进程（Electron 环境必需）=====
// Electron 主线程的 COM apartment 被 Chromium 占着，主进程里调 COM 必然失败
// （CoInitializeEx → 0x80070057，CoCreateInstance → 0x80040110）。
// 所以在 Electron 里把 COM 查询交给一个独立的 Node 子进程（virtualDesktopHelper.js），
// 通过 stdin/stdout 传 JSON。改状态的操作仍在本进程用 SendInput 发系统快捷键。
let helper = null;         // child_process 子进程句柄
let helperSeq = 0;
const helperPending = new Map();
let helperReady = false;
let helperStatus = null;

/** 是否运行在 Electron 主进程里（需要辅助进程） */
function inElectron() {
  try {
    // Electron 主进程有 process.versions.electron，且能取到 app 模块
    return !!process.versions.electron;
  } catch (e) {
    return false;
  }
}

function startHelper() {
  if (helper) return true;
  if (!inElectron()) return false;   // 独立 node 直接用本进程的 COM
  try {
    const { spawn } = require('child_process');
    const path = require('path');
    const fs = require('fs');
    const script = path.join(__dirname, 'virtualDesktopHelper.js');

    // ⚠️ 关键：不能用 Electron 自带的 node（ELECTRON_RUN_AS_NODE） 跑这个辅助进程。
    //   实测 Electron 内嵌的 Node（v18）在这种模式下 CoInitializeEx 同样返回
    //   0x80070057，COM 一样不可用 —— 那样辅助进程就白起了。
    //   必须用「真正的 node.exe」。按优先级找：
    //     1) 开发期：项目里的 node_modules/electron 旁边的 node（一般没有）
    //     2) PATH 里的 node
    //     3) 常见安装位置
    //   找不到就如实报错，让上层降级到注册表通道。
    const candidates = [];
    if (process.env.VDESK_NODE) candidates.push(process.env.VDESK_NODE);
    candidates.push(path.join(__dirname, '..', '..', 'node.exe'));
    candidates.push('node');

    let execPath = null;
    for (const c of candidates) {
      try {
        if (c === 'node') {
          // 交给 spawn 自己在 PATH 里找
          execPath = 'node';
          break;
        }
        if (fs.existsSync(c)) { execPath = c; break; }
      } catch (e) { /* ignore */ }
    }
    if (!execPath) {
      console.warn('[VirtualDesktop] 找不到可用的 node.exe，虚拟桌面查询将退回注册表通道');
      return false;
    }

    const env = { ...process.env };
    // 明确清掉这个标志，避免误用 Electron 内嵌 node
    delete env.ELECTRON_RUN_AS_NODE;

    helper = spawn(execPath, [script], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    helper.stdout.setEncoding('utf8');
    let buf = '';
    helper.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (e) { continue; }
        const p = helperPending.get(msg.id);
        if (p) {
          helperPending.delete(msg.id);
          clearTimeout(p.timer);
          p.resolve(msg);
        }
      }
    });
    helper.stderr.setEncoding('utf8');
    helper.stderr.on('data', (d) => {
      const s = String(d || '').trim();
      if (s) console.log('[VirtualDesktop/helper] ' + s);
    });
    helper.on('exit', (code) => {
      // 辅助进程没了要把所有等待中的请求判失败，否则调用方会一直挂着
      for (const [, p] of helperPending) {
        clearTimeout(p.timer);
        p.resolve({ ok: false, error: '虚拟桌面辅助进程已退出 (code=' + code + ')' });
      }
      helperPending.clear();
      helper = null;
      helperReady = false;
    });
    helperReady = true;
    return true;
  } catch (e) {
    console.warn('[VirtualDesktop] 辅助进程启动失败:', e.message);
    helper = null;
    return false;
  }
}

/** 向辅助进程发一个请求 */
function callHelper(op, args, timeoutMs) {
  return new Promise((resolve) => {
    if (!startHelper()) {
      resolve({ ok: false, error: '辅助进程不可用' });
      return;
    }
    const id = ++helperSeq;
    const timer = setTimeout(() => {
      helperPending.delete(id);
      resolve({ ok: false, error: '虚拟桌面请求超时（' + op + '）' });
    }, timeoutMs || 8000);
    helperPending.set(id, { resolve, timer });
    try {
      helper.stdin.write(JSON.stringify({ id, op, args: args || {} }) + '\n');
    } catch (e) {
      clearTimeout(timer);
      helperPending.delete(id);
      resolve({ ok: false, error: '写辅助进程失败: ' + e.message });
    }
  });
}

function initCom() {
  if (comReady) return true;
  if (comDisabledReason) {
    apiError = comDisabledReason;
    return false;
  }
  if (process.platform !== 'win32') {
    apiError = '虚拟桌面仅支持 Windows';
    return false;
  }
  try {
    koffi = require('koffi');
    ole32 = koffi.load('ole32.dll');
    const CoInitializeEx = ole32.func('int __stdcall CoInitializeEx(void* pvReserved, uint32_t dwCoInit)');
    // 关键：Electron 主线程的 COM apartment 由 Chromium 占着，
    // CoInitializeEx 恒返回 0x80070057 E_INVALIDARG —— 这时不要硬试，
    // 直接交给辅助进程（调用方会走 helper 通道）。
    let ok = false;
    for (const model of [2 /*COINIT_APARTMENTTHREADED*/, 0 /*COINIT_MULTITHREADED*/]) {
      const hr = CoInitializeEx(Buffer.alloc(0), model);
      if (hr >= 0 || (hr >>> 0) === 0x80010106 /*RPC_E_CHANGED_MODE*/) {
        comApartment = model;
        ok = true;
        break;
      }
      lastInitHr = hr;
    }
    if (!ok) {
      comDisabledReason = 'COM 初始化失败 (0x' + (lastInitHr >>> 0).toString(16) + ')';
      apiError = comDisabledReason;
      return false;
    }
    CoCreateInstance = ole32.func('int __stdcall CoCreateInstance(void* rclsid, void* pUnkOuter, uint32_t dwClsContext, void* riid, _Out_ void** ppv)');
    comReady = true;
    return true;
  } catch (e) {
    comDisabledReason = '加载 ole32/COM 失败: ' + (e && e.message ? e.message : String(e));
    apiError = comDisabledReason;
    return false;
  }
}

/** 读 vtable 第 n 个槽位的函数地址（返回 bigint） */
function slotAddr(iface, index) {
  const vtbl = Buffer.from(koffi.view(iface, 8)).readBigUInt64LE(0);
  return Buffer.from(koffi.view(vtbl, (index + 1) * 8)).readBigUInt64LE(index * 8);
}

/**
 * 把 vtable 槽位地址还原成可调用的 JS 函数。
 * ⚠️ koffi 的 proto 类型名是**全局唯一**的：同名重复定义会抛
 *    "Duplicate type name 'X'"。所以这里按签名缓存 + 自动加后缀生成唯一名，
 *    同一个方法在多处使用（GetWindowDesktopId / FindDesktop 都用了两次）也不会炸。
 */
const protoCache = new Map();
let protoSeq = 0;
function uniqueProto(signature) {
  if (protoCache.has(signature)) return protoCache.get(signature);
  // 从签名里取出函数名，替换成唯一名后重新声明。
  // 形如 "void GetId(uint64 self, _Out_ void* guid)" → 返回类型 void，函数名 GetId。
  const src = String(signature);
  const m = src.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
  let sig = src;
  if (m) {
    sig = m[1] + ' ' + m[2] + '_u' + (++protoSeq) + src.slice(m[0].length - 1);
  }
  const t = koffi.proto(sig);
  protoCache.set(signature, t);
  return t;
}

function slotFn(iface, index, signature) {
  return koffi.decode(slotAddr(iface, index), uniqueProto(signature));
}

function comErr(hr) {
  const map = {
    0x800401f0: 'CLASS_E_CLASSNOTAVAILABLE（虚拟桌面接口在当前系统不可用）',
    0x80040154: 'CLASS_E_CLASSNOTREGISTERED（接口未注册，系统版本可能不支持）',
    0x80070005: 'E_ACCESSDENIED（权限不足）',
    0x80010106: 'RPC_E_CHANGED_MODE'
  };
  return map[hr >>> 0] || ('HRESULT 0x' + (hr >>> 0).toString(16));
}

function createInstance(clsid, iid) {
  const out = Buffer.alloc(8);
  const hr = CoCreateInstance(guidBuf(clsid), Buffer.alloc(0), CLSCTX_ALL, guidBuf(iid), out);
  if (hr < 0) return { error: comErr(hr) };
  return { iface: out.readBigUInt64LE(0) };
}

function queryService(service, serviceId, iid) {
  // ⚠️ out 参数必须声明成 `_Out_ void*` 传 Buffer。
  //    试过 `uint64*` / `void**` 两种写法，都会让进程段错误（EXIT=139），
  //    因为那是按值传递的指针类型，koffi 生成的调用约定对不上。
  const fn = slotFn(service, 3, 'uint32 __stdcall QueryService(uint64 self, void* serviceId, void* iid, _Out_ void* out)');
  const out = Buffer.alloc(8);
  const hr = fn(service, guidBuf(serviceId), guidBuf(iid), out);
  if (hr !== 0) return { error: comErr(hr) };
  const ptr = out.readBigUInt64LE(0);
  if (!ptr) return { error: 'QueryService 返回空接口指针' };
  return { iface: ptr };
}

function release(iface) {
  if (!iface) return;
  try {
    slotFn(iface, 2, 'uint32 __stdcall Release(uint64 self)') (iface);
  } catch (e) { /* ignore */ }
}

// ===== 注册表兜底 =====
// 为什么要有这条：IVirtualDesktopManagerInternal 未文档化，跨进程/跨 apartment 调用
// 会出现 RPC_E_CALL_REJECTED 甚至整进程退出（本项目实测踩过）。而 Windows 自己
// 把桌面清单写在 HKCU\...\Explorer\VirtualDesktops\Desktops\{GUID} 下，
// 纯读注册表稳定可用，用它保证「列出桌面 / 显示名称」这类只读功能不会因 COM 抽风而挂掉。
let reg = null;
function regApi() {
  if (reg) return reg;
  try {
    const advapi32 = koffi.load('advapi32.dll');
    reg = {
      RegOpenKeyExW: advapi32.func('int __stdcall RegOpenKeyExW(void* hKey, const char16_t* subKey, uint32_t ulOptions, uint32_t samDesired, _Out_ void** phkResult)'),
      RegQueryValueExW: advapi32.func('int __stdcall RegQueryValueExW(void* hKey, const char16_t* valueName, void* reserved, _Out_ uint32_t* type, void* data, _Out_ uint32_t* cbData)'),
      RegEnumKeyExW: advapi32.func('int __stdcall RegEnumKeyExW(void* hKey, uint32_t dwIndex, void* lpName, _Out_ uint32_t* lpcchName, void* reserved, void* lpClass, _Out_ uint32_t* lpcchClass, uint32_t* lpftLastWriteTime)'),
      RegQueryInfoKeyW: advapi32.func('int __stdcall RegQueryInfoKeyW(void* hKey, void* cls, _Out_ uint32_t* cch, void* res, _Out_ uint32_t* subkeys, _Out_ uint32_t* maxsub, _Out_ uint32_t* maxcls, uint32_t* values, _Out_ uint32_t* maxval, _Out_ uint32_t* maxdata, void* type)'),
      RegCloseKey: advapi32.func('int __stdcall RegCloseKey(void* hKey)')
    };
  } catch (e) {
    reg = false;
  }
  return reg;
}

const HKEY_CURRENT_USER = 0x80000001;
const KEY_READ = 0x20019;
const VD_BASE = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VirtualDesktops';

function regOpen(pathStr) {
  const a = regApi();
  if (!a) return { error: 'advapi32 不可用' };
  const out = Buffer.alloc(8);
  const hr = a.RegOpenKeyExW(HKEY_CURRENT_USER, pathStr, 0, KEY_READ, out);
  return hr === 0 ? { h: out.readBigUInt64LE(0) } : { error: '0x' + (hr >>> 0).toString(16) };
}

function regReadString(h, name) {
  const a = regApi();
  const typeBuf = Buffer.alloc(4);
  const sizeBuf = Buffer.alloc(4);
  if (a.RegQueryValueExW(h, name, Buffer.alloc(0), typeBuf, Buffer.alloc(0), sizeBuf) !== 0) return null;
  const size = sizeBuf.readUInt32LE(0);
  if (!size) return null;
  const data = Buffer.alloc(size);
  if (a.RegQueryValueExW(h, name, Buffer.alloc(0), typeBuf, data, sizeBuf) !== 0) return null;
  let s = data.toString('utf16le');
  const z = s.indexOf('\0');
  return z >= 0 ? s.slice(0, z) : s;
}

function regEnumKeys(h) {
  const a = regApi();
  const countBuf = Buffer.alloc(4);
  if (a.RegQueryInfoKeyW(h, Buffer.alloc(0), Buffer.alloc(4), Buffer.alloc(0), countBuf, Buffer.alloc(4), Buffer.alloc(4), Buffer.alloc(4), Buffer.alloc(4), Buffer.alloc(4), Buffer.alloc(0), Buffer.alloc(0)) !== 0) return [];
  const n = countBuf.readUInt32LE(0);
  const out = [];
  for (let i = 0; i < n; i++) {
    const nameBuf = Buffer.alloc(1024);
    const nameLen = Buffer.alloc(4);
    nameLen.writeUInt32LE(511, 0);
    if (a.RegEnumKeyExW(h, i, nameBuf, nameLen, Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(4), Buffer.alloc(4)) !== 0) continue;
    let nm = nameBuf.toString('utf16le', 0, nameLen.readUInt32LE(0) * 2);
    const z = nm.indexOf('\0');
    out.push({ raw: nm, name: z >= 0 ? nm.slice(0, z) : nm });
  }
  return out;
}

/**
 * 从注册表读桌面清单（只读，稳定路径）。
 * @returns {{ok:boolean, desktops:Array, current:string|null, error?:string}}
 */
function readDesktopsFromRegistry() {
  if (!koffi) koffi = require('koffi');
  const root = regOpen(VD_BASE);
  if (root.error) return { ok: false, desktops: [], current: null, error: '打开虚拟桌面注册表失败 ' + root.error };
  const defaultId = regReadString(root.h, 'DesktopId');
  reg.RegCloseKey(root.h);

  const dk = regOpen(VD_BASE + '\\Desktops');
  if (dk.error) return { ok: false, desktops: [], current: null, error: '打开桌面清单失败 ' + dk.error };
  const keys = regEnumKeys(dk.h);
  reg.RegCloseKey(dk.h);

  const desktops = keys.map((k, i) => {
    // 键名形如 {1E7D8703-...}，花括号要去掉才是合法 GUID
    let id = k.name.trim();
    if (id.startsWith('{') && id.endsWith('}')) id = id.slice(1, -1);
    let name = null;
    const sub = regOpen(VD_BASE + '\\Desktops\\' + k.raw);
    if (!sub.error) {
      name = regReadString(sub.h, 'Name');
      reg.RegCloseKey(sub.h);
    }
    return {
      id: id.toUpperCase(),
      index: i,
      name: (name && name.trim()) ? name.trim() : ('桌面 ' + (i + 1)),
      current: false
    };
  });

  // 当前桌面：注册表的 DesktopId 实测常为空，改用「窗口属于哪个桌面」判断。
  // ⚠️ 实测坑：当前活动桌面的 GUID 常常**不在**上面枚举出的列表里
  //    （那 9 个是历史挂起桌面，COM 的 GetCount() 也返回 0）。
  //    所以匹配不上时要把它作为当前桌面补进列表，否则界面上会出现
  //    「一个 current 都没有」的情况。
  const currentId = detectCurrentDesktopId();
  if (currentId) {
    const hit = desktops.find(d => d.id === currentId);
    if (hit) {
      hit.current = true;
    } else {
      desktops.push({
        id: currentId,
        index: desktops.length,
        name: '当前桌面',
        current: true
      });
    }
  }

  return {
    ok: true,
    desktops,
    current: currentId || (desktops[0] ? desktops[0].id : null)
  };
}

/**
 * 通过桌面窗口反查当前虚拟桌面 id。
 * ⚠️ 实测：Progman 的 GetWindowDesktopId 恒返回全零 GUID，拿它判断会一直"找不到当前桌面"。
 *    真正有意义的是 SHELLDLL_DefView 的宿主 WorkerW；枚举所有 WorkerW 取第一个有效值。
 *    还可退到前台窗口 —— 它必然在当前桌面上。
 */
function detectCurrentDesktopId() {
  const ZERO = '00000000-0000-0000-0000-000000000000';
  try {
    if (!vdm) return null;
    const user32 = koffi.load('user32.dll');
    const getId = slotFn(vdm, 4, 'void GetWindowDesktopId(uint64 self, uint64 hwnd, _Out_ void* guid)');
    const buf = Buffer.alloc(16);
    const ask = (hwnd) => {
      if (!hwnd) return null;
      buf.fill(0);
      try { getId(vdm, hwnd, buf); } catch (e) { return null; }
      const id = guidStr(buf);
      return (id && id !== ZERO) ? id : null;
    };

    // 1) 前台窗口：必然在当前桌面，最可靠且最便宜
    const GetForegroundWindow = user32.func('uint64 __stdcall GetForegroundWindow()');
    const fg = ask(GetForegroundWindow());
    if (fg) return fg;

    // 2) 枚举所有顶层窗口（Progman 实测恒返回全零 GUID，只能靠枚举）
    //    写法照抄 computerControl.js 里已验证可用的 EnumWindows 模式。
    //    注意 found 要先声明：koffi 回调是同步调用。
    let found = null;
    try {
      const EnumWindowsProc = koffi.proto('int __stdcall EnumWindowsProcVD(uint64 hwnd, long lParam)');
      const EnumWindows = user32.func('int __stdcall EnumWindows(EnumWindowsProcVD* lpEnumFunc, long lParam)');
      const cb = koffi.register((hwnd) => {
        if (found) return 0;
        const id = ask(hwnd);
        if (id) { found = id; return 0; } // 0 = 停止枚举
        return 1;
      }, koffi.pointer(EnumWindowsProc));
      EnumWindows(cb, 0);
      try { koffi.unregister(cb); } catch (e) { /* ignore */ }
    } catch (e) { /* ignore */ }
    if (found) return found;

    // 3) 兜底：Progman
    const FindWindowW = user32.func('uint64 __stdcall FindWindowW(void* cls, void* name)');
    return ask(FindWindowW(Buffer.from('Progman\0', 'utf16le'), Buffer.alloc(0)));
  } catch (e) { /* ignore */ }
  return null;
}

/**
 * 初始化接口。返回 { ok, error }。
 * 必须在 app ready 之后调用（COM 需要主线程 STA）。
 */
function init() {
  if (vdm) return { ok: true };
  if (!initCom()) return { ok: false, error: apiError };

  // 1) 公开接口
  const pub = createInstance(CLSID_VirtualDesktopManager, IID_IVirtualDesktopManager);
  if (pub.error) {
    apiError = '获取虚拟桌面管理器失败: ' + pub.error;
    return { ok: false, error: apiError };
  }
  vdm = pub.iface;

  // 2) 内部接口（拿不到不算致命：仍可查/挪窗口，只是不能列出与切换）
  try {
    const shell = createInstance(CLSID_ImmersiveShell, IID_IServiceProvider10);
    if (!shell.error) {
      for (const iid of IID_INTERNAL_CANDIDATES) {
        const q = queryService(shell.iface, CLSID_VirtualDesktopManagerInternal, iid);
        if (!q.error) {
          vdmInternal = q.iface;
          internalIid = iid;
          break;
        }
      }
      release(shell.iface);
    } else {
      shellError = shell.error;
    }
  } catch (e) {
    // 内部接口拿不到就降级，不抛
    shellError = e && e.message ? e.message : String(e);
  }

  if (!vdmInternal) {
    apiError = 'IVirtualDesktopManagerInternal 不可用'
      + (shellError ? '（ImmersiveShell: ' + shellError + '）' : '')
      + '：只能查询/移动窗口，无法列出与切换虚拟桌面';
  }
  return { ok: true, error: apiError || null, full: !!vdmInternal };
}

function ensure() {
  if (vdm) return null;
  // Electron 环境：本进程 COM 不可用是「预期内」的，不算错误，
  // 交给辅助进程就行，所以这里不返回失败。
  if (comDisabledReason && inElectron()) return null;
  const r = init();
  return r.ok ? null : { success: false, error: r.error || '虚拟桌面接口不可用' };
}

// ===== 对外能力 =====

/** 从 IObjectArray 里取出第 index 个 IVirtualDesktop 指针 */
function arrayGetAt(array, index) {
  // out 指针参数一律用 `_Out_ void*` + Buffer，用 uint64*/void** 会段错误
  const getAt = slotFn(array, 4, 'uint32 GetAt(uint64 self, int32_t index, void* iid, _Out_ void* out)');
  const out = Buffer.alloc(8);
  const hr = getAt(array, index, guidBuf(IID_IVirtualDesktop), out);
  if (hr !== 0) return { error: comErr(hr) };
  const ptr = out.readBigUInt64LE(0);
  if (!ptr) return { error: 'GetAt 返回空指针' };
  return { iface: ptr };
}

function desktopIdOf(desktopIface) {
  const getId = slotFn(desktopIface, SLOT.ifaceGetId, 'void GetId(uint64 self, _Out_ void* guid)');
  const buf = Buffer.alloc(16);
  getId(desktopIface, buf);
  return guidStr(buf);
}

/**
 * 列出所有虚拟桌面。
 * 双通道：COM 内部接口优先（能拿到就用它，因为它最权威），拿不到或出错时
 * 退回注册表（稳定、只读）。这样「显示桌面列表」不会因为未文档化接口抽风就整块失效。
 * @returns {Promise<{success:boolean, desktops?:Array, current?:string, error?:string}>}
 */
async function listDesktops() {
  const bad = ensure();
  if (bad) return bad;

  // 通道 1：本进程 COM（独立 node 下直接可用）
  let viaCom = { success: false, error: comDisabledReason || 'COM 未初始化' };
  if (vdm) {
    viaCom = listDesktopsViaCom();
    if (viaCom.success) return viaCom;
  }

  // 通道 2：辅助进程（Electron 环境的唯一可靠 COM 通道）
  if (inElectron()) {
    const h = await callHelper('list', {}, 8000);
    if (h && h.ok && h.result && h.result.success) {
      return { ...h.result, source: (h.result.source || 'com') + '+helper' };
    }
    const helperErr = (h && h.error) || (h && h.result && h.result.error) || '辅助进程无响应';
    viaCom = { success: false, error: viaCom.error + '；辅助进程: ' + helperErr };
  }

  // 通道 3：注册表兜底（稳定、只读）
  let regRes;
  try {
    regRes = readDesktopsFromRegistry();
  } catch (e) {
    regRes = { ok: false, desktops: [], current: null, error: e && e.message ? e.message : String(e) };
  }
  if (regRes.ok) {
    return {
      success: true,
      desktops: regRes.desktops,
      current: regRes.current,
      count: regRes.desktops.length,
      canRename: false,
      source: 'registry',
      note: '系统虚拟桌面接口不可用（' + viaCom.error + '），已改用注册表读取桌面清单'
    };
  }
  return {
    success: false,
    error: (viaCom.error || '') + '；注册表兜底也失败：' + (regRes.error || '未知'),
    desktops: [],
    current: null
  };
}

/**
 * COM 通道：内部接口列出桌面。
 * ⚠️ 实测（Win11 build 26300）：QueryService 能拿到接口，但 GetCount() 恒返回 0，
 *    紧接着再调 GetDesktops/GetCurrentDesktop 会让整个进程段错误（EXIT=139）。
 *    也就是说这套未文档化接口在「非 Explorer 进程里直接调」是不可靠的。
 *    因此这里做一次性探测：GetCount 拿不到有效值就把 COM 通道永久标记为不可用，
 *    全程走注册表。宁可少一条通道，也不能让界面一点就崩。
 */
let comChannelDisabled = false;
let comChannelReason = '';

function listDesktopsViaCom() {
  if (comChannelDisabled) {
    return { success: false, error: comChannelReason || 'COM 通道已禁用' };
  }
  if (!vdmInternal) {
    return { success: false, error: apiError || 'IVirtualDesktopManagerInternal 不可用' };
  }
  try {
    const getCount = slotFn(vdmInternal, SLOT.intGetCount, 'int32_t GetCount(uint64 self)');
    const count = getCount(vdmInternal);
    if (!count || count < 0) {
      comChannelDisabled = true;
      comChannelReason = 'GetCount 返回 ' + count + '（未文档化接口在当前进程不可求值）';
      return { success: false, error: comChannelReason };
    }
    const getDesktops = slotFn(vdmInternal, SLOT.intGetDesktops, 'uint32 GetDesktops(uint64 self, _Out_ void* out)');
    const getCurrent = slotFn(vdmInternal, SLOT.intGetCurrent, 'uint64 GetCurrentDesktop(uint64 self)');

    const arrOut = Buffer.alloc(8);
    if (getDesktops(vdmInternal, arrOut) !== 0) {
      return { success: false, error: 'GetDesktops 失败 ' + comErr(getDesktops(vdmInternal, arrOut)) };
    }
    const array = arrOut.readBigUInt64LE(0);
    if (!array) return { success: false, error: 'GetDesktops 返回空数组' };
    const currentIface = getCurrent(vdmInternal);
    const currentId = currentIface ? desktopIdOf(currentIface) : null;

    const desktops = [];
    for (let i = 0; i < count; i++) {
      const item = arrayGetAt(array, i);
      if (item.error) continue;
      const id = desktopIdOf(item.iface);
      desktops.push({ id, index: i, name: '桌面 ' + (i + 1), current: id === currentId });
      release(item.iface);
    }
    release(array);
    if (currentIface) release(currentIface);

    // 补上注册表里的真实名称，并统一用「窗口归属」判定 current
    // （COM 的 GetCurrentDesktop 在本机实测返回 0/null，不可靠）
    try {
      const named = readDesktopsFromRegistry();
      if (named.ok) {
        for (const d of desktops) {
          const hit = named.desktops.find(x => x.id === d.id);
          if (hit) { d.name = hit.name; d.index = hit.index; }
        }
      }
    } catch (e) { /* 名称是锦上添花，失败无所谓 */ }

    const real = detectCurrentDesktopId();
    if (real) {
      for (const d of desktops) d.current = (d.id === real);
      if (!desktops.some(d => d.current)) {
        desktops.push({ id: real, index: desktops.length, name: '当前桌面', current: true });
      }
    }

    return {
      success: true,
      desktops,
      current: desktops.find(d => d.current)?.id || null,
      count: desktops.length,
      canRename: supportsName,
      source: 'com'
    };
  } catch (e) {
    return { success: false, error: 'COM 枚举失败: ' + (e && e.message ? e.message : String(e)) };
  }
}

/** 当前所在虚拟桌面 */
async function currentDesktop() {
  let r = await listDesktops();
  if (!r.success) return r;
  let cur = (r.desktops || []).find(d => d.current) || null;

  // 兜底：列表里没标出当前桌面时（COM 的 GetCurrentDesktop 在本机返回 0/null，
  // 注册表 DesktopId 也常为空），直接问一次「我现在在哪个桌面」。
  if (!cur) {
    const direct = detectCurrentDesktopId();
    if (direct) {
      const hit = (r.desktops || []).find(d => d.id === direct);
      if (hit) {
        for (const d of r.desktops) d.current = (d.id === direct);
        cur = hit;
      } else {
        // 当前桌面不在枚举列表里（历史挂起桌面的常见情况），补进去
        r.desktops = (r.desktops || []).concat([{ id: direct, index: r.desktops.length, name: '当前桌面', current: true }]);
        cur = r.desktops[r.desktops.length - 1];
      }
    }
  }

  if (!cur) {
    // 实在查不到：把第一个当作当前，保证调用方（切换/删除的相对定位）还能算。
    // 明确标出是兜底值，不静默假装知道。
    const first = (r.desktops || [])[0];
    if (first) {
      first.current = true;
      first.inferred = true;
      cur = first;
    }
  }
  return {
    success: true,
    current: cur ? cur.id : null,
    index: cur ? cur.index : -1,
    name: cur ? cur.name : null,
    // true = 这是兜底推出来的，不是真查到的；调用方要如实展示，别当成确定信息
    inferred: !!(cur && cur.inferred)
  };
}

// ===== 切换 / 新建 / 删除 =====
// 这三个是真正要改系统状态的操作，只走「内部 COM 接口」不可靠（见上）。
// 这里改用 Windows 自带的全局快捷键通道：
//   新建 = Ctrl+Win+D，切换 = Ctrl+Win+←/→，关闭当前 = Ctrl+Win+F4
// 它们由 shell 自己处理，不依赖任何未文档化 IID，跨进程稳定。
// 切换按「相对位移」做：先算出目标在当前桌面的左边还是右边，再按对应方向键。

const VK_CONTROL = 0x11;
const VK_LWIN = 0x5B;
const VK_D = 0x44;
const VK_F4 = 0x73;
const VK_LEFT = 0x25;
const VK_RIGHT = 0x27;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_EXTENDEDKEY = 0x0001;

let inputKb = null;
function keyboard() {
  if (inputKb) return inputKb;
  try {
    const user32 = koffi.load('user32.dll');
    inputKb = {
      SendInput: user32.func('uint __stdcall SendInput(uint cInputs, void* pInputs, int cbSize)'),
      keybd_event: user32.func('void __stdcall keybd_event(uint8 bVk, uint8 bScan, uint dwFlags, uint dwExtraInfo)')
    };
  } catch (e) {
    inputKb = false;
  }
  return inputKb;
}

const IS64 = process.arch !== 'ia32';
const INPUT_SIZE = IS64 ? 40 : 28;
const KI_OFFSET = IS64 ? 8 : 4;

function kbInput(vk) {
  const b = Buffer.alloc(INPUT_SIZE);
  b.writeUInt32LE(1 /*INPUT_KEYBOARD*/, 0);
  b.writeUInt16LE(vk & 0xffff, KI_OFFSET);
  b.writeUInt16LE(0, KI_OFFSET + 2);
  b.writeUInt32LE(KEYEVENTF_EXTENDEDKEY, KI_OFFSET + 4);
  if (IS64) b.writeBigUInt64LE(0n, KI_OFFSET + 16); else b.writeUInt32LE(0, KI_OFFSET + 12);
  return b;
}

/** 按下组合键再抬起（走 SendInput，稳定性优于 keybd_event） */
function pressCombo(keys) {
  const kb = keyboard();
  if (!kb) return false;
  try {
    const down = Buffer.concat(keys.map(kbInput));
    const up = Buffer.concat(keys.slice().reverse().map(v => {
      const b = kbInput(v);
      b.writeUInt32LE(KEYEVENTF_KEYUP, KI_OFFSET + 4);
      return b;
    }));
    kb.SendInput(keys.length, down, INPUT_SIZE);
    kb.SendInput(keys.length, up, INPUT_SIZE);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 切到指定虚拟桌面。
 * 用相对位移实现：算出目标相对当前是左还是右，按对应次数的 Ctrl+Win+方向键。
 * @returns {Promise<{success:boolean, error?:string, steps?:number}>}
 */
async function switchDesktop(id) {
  const bad = ensure();
  if (bad) return bad;

  const before = await currentDesktop();
  if (!before.success) return before;
  if (before.current === id) return { success: true, id, steps: 0, already: true };

  const list = await listDesktops();
  if (!list.success) return list;
  const all = list.desktops || [];

  const fromIdx = all.findIndex(d => d.id === before.current);
  const toIdx = all.findIndex(d => d.id === id);
  if (toIdx < 0) return { success: false, error: '找不到目标虚拟桌面' };
  if (fromIdx < 0) return { success: false, error: '无法确定当前桌面位置' };

  const delta = toIdx - fromIdx;
  if (delta === 0) return { success: true, id, steps: 0, already: true };

  const vk = delta > 0 ? VK_RIGHT : VK_LEFT;
  for (let i = 0; i < Math.abs(delta); i++) {
    if (!pressCombo([VK_CONTROL, VK_LWIN, vk])) {
      return { success: false, error: '发送切换快捷键失败（SendInput 不可用）' };
    }
    // 逐次切换之间要给 shell 响应时间，连按会被合并成一次
    await sleep(260);
  }
  await sleep(300);

  const after = await currentDesktop();
  return { success: true, id, steps: Math.abs(delta), landed: after.current === id };
}

/** 新建虚拟桌面（Ctrl+Win+D），返回新桌面 id */
async function createDesktop() {
  const bad = ensure();
  if (bad) return bad;
  const before = await listDesktops();
  const prevCount = before.success ? (before.desktops || []).length : 0;
  if (!pressCombo([VK_CONTROL, VK_LWIN, VK_D])) {
    return { success: false, error: '发送新建桌面快捷键失败' };
  }
  // 等 shell 建好（新桌面会立刻成为当前桌面）
  for (let i = 0; i < 12; i++) {
    await sleep(200);
    const now = await currentDesktop();
    if (now.success && now.current && now.current !== (before.success ? before.current : null)) {
      return { success: true, id: now.current, created: true };
    }
  }
  const now = await listDesktops();
  if (now.success && (now.desktops || []).length > prevCount) {
    const fresh = (now.desktops || []).find(d => d.current);
    return { success: true, id: fresh ? fresh.id : null, created: true };
  }
  return { success: false, error: '新建虚拟桌面后未能确认新桌面（系统未响应 Ctrl+Win+D）' };
}

/** 删除虚拟桌面（Ctrl+Win+F4 关闭当前桌面） */
async function removeDesktop(id, fallbackId) {
  const bad = ensure();
  if (bad) return bad;

  const list = await listDesktops();
  if (!list.success) return list;
  const target = (list.desktops || []).find(d => d.id === id);
  if (!target) return { success: false, error: '找不到要删除的虚拟桌面' };

  // Ctrl+Win+F4 只能关掉「当前」桌面，所以先切过去
  const sw = await switchDesktop(id);
  if (!sw.success) return sw;

  if (!pressCombo([VK_CONTROL, VK_LWIN, VK_F4])) {
    return { success: false, error: '发送关闭桌面快捷键失败' };
  }
  await sleep(600);

  if (fallbackId) {
    const back = await switchDesktop(fallbackId);
    if (!back.success) return { success: false, error: '桌面已关闭，但切回原桌面失败: ' + back.error };
  }
  return { success: true, removed: id };
}

/** 查询某个窗口（hwnd）在哪个虚拟桌面（异步：Electron 下走辅助进程） */
async function desktopOfWindow(hwnd) {
  const bad = ensure();
  if (bad) return bad;
  if (vdm) {
    try {
      const fn = slotFn(vdm, 4, 'void GetWindowDesktopId(uint64 self, uint64 hwnd, _Out_ void* guid)');
      const buf = Buffer.alloc(16);
      fn(vdm, BigInt(hwnd), buf);
      return { success: true, id: guidStr(buf) };
    } catch (e) {
      // 落到辅助进程
    }
  }
  if (inElectron()) {
    const h = await callHelper('windowDesktop', { hwnd }, 6000);
    if (h && h.ok && h.result) return h.result;
    return { success: false, error: (h && h.error) || '辅助进程无响应' };
  }
  return { success: false, error: comDisabledReason || 'COM 不可用' };
}

/** 把窗口移动到指定虚拟桌面 */
async function moveWindowToDesktop(hwnd, id) {
  const bad = ensure();
  if (bad) return bad;
  if (!vdm) return { success: false, error: comDisabledReason || 'COM 不可用（移动窗口需要 COM）' };
  try {
    const fn = slotFn(vdm, 5, 'void MoveWindowToDesktop(uint64 self, uint64 hwnd, void* desktopId)');
    fn(vdm, BigInt(hwnd), guidBuf(id));
    return { success: true };
  } catch (e) {
    return { success: false, error: '移动窗口到虚拟桌面失败: ' + (e && e.message ? e.message : String(e)) };
  }
}

/**
 * 在指定虚拟桌面里执行一段截屏逻辑，执行完切回原桌面。
 * 这是「所有截屏都在虚拟桌面环境下进行」的统一入口：
 *   记录当前桌面 → 切到目标桌面 → 截图 → 切回（无论成功失败都切回）。
 *
 * @param {string} targetDesktopId 目标桌面；为空则表示用当前桌面
 * @param {Function} fn 截图函数，返回任意可序列化结果
 */
async function withDesktop(targetDesktopId, fn) {
  const bad = ensure();
  if (bad) return bad;

  // 不指定桌面 = 不切，直接执行
  if (!targetDesktopId) {
    try {
      return { success: true, result: await fn(), desktop: null, switched: false };
    } catch (e) {
      return { success: false, error: '截屏失败: ' + (e && e.message ? e.message : String(e)) };
    }
  }

  const before = await currentDesktop();
  const from = before.success ? before.current : null;
  if (from === targetDesktopId) {
    // 已经在目标桌面
    try {
      return { success: true, result: await fn(), desktop: targetDesktopId, switched: false };
    } catch (e) {
      return { success: false, error: '截屏失败: ' + (e && e.message ? e.message : String(e)) };
    }
  }

  const sw = await switchDesktop(targetDesktopId);
  if (!sw.success) return { success: false, error: sw.error, result: null, desktop: targetDesktopId, switched: false };

  let result = null;
  let failed = null;
  try {
    result = await fn();
  } catch (e) {
    failed = e;
  }
  // 一定切回去，否则用户会被留在别的桌面上
  if (from) await switchDesktop(from);

  if (failed) return { success: false, error: '截屏失败: ' + (failed.message || String(failed)) };
  return { success: true, result, desktop: targetDesktopId, switched: true, restored: from };
}

function isAvailable() {
  const bad = ensure();
  // Electron 下本进程 COM 不可用是预期内的，辅助进程接管后整体仍算可用
  const helperMode = inElectron() && !vdm;
  return {
    available: !bad || helperMode,
    // 能力分层：helper=靠辅助进程，com=本进程 COM，none=都没有
    mode: vdm ? 'com' : (helperMode ? 'helper' : 'none'),
    full: !!vdmInternal || helperMode,
    canRename: supportsName,
    build: windowsBuild(),
    apartment: comApartment,
    internalIid,
    error: bad ? (bad.error || apiError || '虚拟桌面接口不可用') : null
  };
}

/** 异步探测：真正问一次辅助进程，确认它活着且 COM 可用 */
async function probe() {
  if (vdm) return { ok: true, mode: 'com', ...isAvailable() };
  if (inElectron()) {
    const h = await callHelper('status', {}, 6000);
    if (h && h.ok && h.result) {
      helperStatus = h.result;
      return {
        ok: !!(h.result.available || h.result.full),
        mode: 'helper',
        helper: h.result,
        ...isAvailable()
      };
    }
    return { ok: false, mode: 'none', error: (h && h.error) || '辅助进程无响应' };
  }
  return { ok: !!(isAvailable().available), mode: isAvailable().mode, ...isAvailable() };
}

function dispose() {
  release(vdmInternal);
  release(vdm);
  vdm = null;
  vdmInternal = null;
  supportsName = false;
  apiError = null;
  // 关掉辅助进程，别留孤儿
  if (helper) {
    try { helper.stdin.end(); } catch (e) { /* ignore */ }
    try { helper.kill(); } catch (e) { /* ignore */ }
    helper = null;
    helperReady = false;
  }
  for (const [, p] of helperPending) clearTimeout(p.timer);
  helperPending.clear();
}

module.exports = {
  init,
  isAvailable,
  probe,
  listDesktops,
  currentDesktop,
  switchDesktop,
  createDesktop,
  removeDesktop,
  desktopOfWindow,
  moveWindowToDesktop,
  withDesktop,
  dispose,
  guidStr,
  guidBuf
};
