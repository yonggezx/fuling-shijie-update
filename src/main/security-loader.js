/**
 * 安全加载器 - asar AES 解密 + 防 dump
 * 
 * 功能：
 * 1. 反调试检测（Windows API）
 * 2. 父进程校验
 * 3. AES 加密文件的运行时解密
 * 4. Module._compile 钩子，自动解密 require 的加密文件
 * 5. 内存保护（解密后数据使用后清除）
 * 6. 关键字符串加密存储
 * 
 * 使用方式：在 main.js 最开头 require('./security-loader')
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');

// ============================================================
// 配置
// ============================================================

/**
 * 密钥管理方案：4段拆分 + 多层混淆
 * 
 * 完整的 AES-256 密钥（32字节）被拆分为4段，每段8字节，
 * 分别使用不同的混淆方式存储，运行时动态组合：
 * 
 * PART1: XOR 0x5A 混淆
 * PART2: 字节+7 混淆
 * PART3: 反转 + XOR 0xA5 混淆
 * PART4: 索引异或 + 字节-3 混淆
 * 
 * 逆向工程需要同时找到4段并理解各自的解混淆方式才能还原密钥。
 */

// PART1: XOR 0x5A 混淆（原始: AILobste）
const OBF_PART1 = Buffer.from([0x1B, 0x13, 0x16, 0x35, 0x38, 0x29, 0x2E, 0x3F]);

// PART2: 字节+7 混淆（原始: r2026Sec）
const OBF_PART2 = Buffer.from([0x79, 0x39, 0x37, 0x39, 0x3D, 0x5A, 0x6C, 0x6A]);

// PART3: 反转 + XOR 0xA5 混淆（原始: ureKey@#，反转后 #@yeKer u）
const OBF_PART3 = Buffer.from([0x86, 0xE5, 0xDC, 0xC0, 0xEE, 0xC0, 0xD7, 0xD0]);

// PART4: 索引异或 + 字节-3 混淆（原始: $%^&*()!）
const OBF_PART4 = Buffer.from([0x21, 0x21, 0x59, 0x22, 0x2B, 0x2A, 0x2C, 0x23]);

// IV（16字节）
const AES_IV = Buffer.from('lobsterIV_2026!!', 'utf8'); // 16 bytes

// 加密文件标记（加密文件开头会有这个标记）
const ENCRYPTED_MAGIC = Buffer.from('AENC', 'utf8'); // 4 bytes

// 需要加密的文件列表（相对 src/main 路径）
// 注意：main.js 不能被加密，因为它是入口文件，必须先明文加载才能 require 本加载器
const ENCRYPTED_FILES = [
  'ipc/aiOps.js',
  'ipc/fileOps.js',
  'ipc/commandOps.js',
  'ipc/installOps.js',
  'ipc/updateOps.js',
  'ipc/electronUpdater.js',
  'configManager.js',
  'patch-loader.js',
];

// ============================================================
// 密钥获取（4段拆分 + 多层混淆）
// ============================================================

let _cachedFullKey = null;

/**
 * 解混淆并组合完整密钥
 */
function deobfuscateFullKey() {
  // PART1: XOR 0x5A
  const part1 = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) part1[i] = OBF_PART1[i] ^ 0x5A;
  
  // PART2: 字节-7
  const part2 = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) part2[i] = (OBF_PART2[i] - 7 + 256) % 256;
  
  // PART3: XOR 0xA5 + 反转
  const part3_rev = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) part3_rev[i] = OBF_PART3[i] ^ 0xA5;
  const part3 = Buffer.from(part3_rev).reverse();
  
  // PART4: 字节+3 + 索引异或
  const part4 = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) part4[i] = ((OBF_PART4[i] + 3) % 256) ^ i;
  
  // 组合
  return Buffer.concat([part1, part2, part3, part4]);
}

/**
 * 获取完整的 AES 密钥（带缓存）
 */
function getFullAESKey() {
  if (_cachedFullKey) return _cachedFullKey;
  _cachedFullKey = deobfuscateFullKey();
  return _cachedFullKey;
}

// 导出密钥获取函数（供 encrypt-asar.js 使用）
function getAESKeyForEncryption() {
  return deobfuscateFullKey();
}

// ============================================================
// 工具函数
// ============================================================

/**
 * AES-256-CBC 加密
 */
function encrypt(buffer) {
  const key = getFullAESKey();
  if (!key) throw new Error('无法获取加密密钥（未激活硬件绑定）');
  const cipher = crypto.createCipheriv('aes-256-cbc', key, AES_IV);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  // 添加标记头：MAGIC(4) + 原始长度(4) + 加密数据
  const header = Buffer.alloc(8);
  ENCRYPTED_MAGIC.copy(header, 0);
  header.writeUInt32LE(buffer.length, 4);
  return Buffer.concat([header, encrypted]);
}

/**
 * AES-256-CBC 解密
 */
function decrypt(buffer) {
  // 检查标记头
  if (buffer.length < 8 || !buffer.slice(0, 4).equals(ENCRYPTED_MAGIC)) {
    return null; // 不是加密文件
  }
  const key = getFullAESKey();
  if (!key) {
    console.error('[SecurityLoader] ✗ 解密失败：无法获取密钥');
    return null;
  }
  const originalLength = buffer.readUInt32LE(4);
  const encryptedData = buffer.slice(8);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, AES_IV);
  const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
  return decrypted.slice(0, originalLength);
}

/**
 * 检查文件是否是加密文件
 */
function isEncryptedFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(4);
    fs.readSync(fd, header, 0, 4, 0);
    fs.closeSync(fd);
    return header.equals(ENCRYPTED_MAGIC);
  } catch (e) {
    return false;
  }
}

// ============================================================
// 防 dump / 反调试
// ============================================================

let koffi = null;
try {
  koffi = require('koffi');
} catch (e) {
  // koffi 不可用时跳过反调试
}

/**
 * Windows 反调试检测
 */
function checkDebugger() {
  if (!koffi || process.platform !== 'win32') return false;
  
  try {
    // 方法1: IsDebuggerPresent
    const kernel32 = koffi.load('kernel32.dll');
    const IsDebuggerPresent = kernel32.func('IsDebuggerPresent', 'int', []);
    if (IsDebuggerPresent() !== 0) return true;
    
    // 方法2: CheckRemoteDebuggerPresent
    const CheckRemoteDebuggerPresent = kernel32.func('CheckRemoteDebuggerPresent', 'int', ['void*', 'int*']);
    const processHandle = process.handle;
    const debugFlag = [0];
    if (CheckRemoteDebuggerPresent(processHandle, debugFlag) !== 0 && debugFlag[0] !== 0) {
      return true;
    }
    
    // 方法3: NtQueryInformationProcess (ProcessDebugPort = 0x7)
    try {
      const ntdll = koffi.load('ntdll.dll');
      const NtQueryInformationProcess = ntdll.func('NtQueryInformationProcess', 'long', ['void*', 'int', 'void*', 'int', 'int*']);
      const debugPort = Buffer.alloc(8);
      const returnLength = [0];
      const status = NtQueryInformationProcess(processHandle, 0x7, debugPort, 8, returnLength);
      if (status === 0 && debugPort.readUInt32LE() !== 0) {
        return true;
      }
    } catch (e) {
      // NtQueryInformationProcess 可能不可用，忽略
    }
    
    return false;
  } catch (e) {
    return false;
  }
}

/**
 * 父进程校验（确保是正常启动，而不是被调试器/注入器启动）
 */
function checkParentProcess() {
  if (process.platform !== 'win32') return true;
  
  try {
    const { execSync } = require('child_process');
    // 获取父进程 PID
    const parentPid = process.ppid;
    // 查询父进程名称
    const result = execSync(`wmic process where ProcessId=${parentPid} get Name`, { 
      encoding: 'utf8', 
      windowsHide: true,
      timeout: 5000 
    });
    const parentName = result.split('\n')[1]?.trim()?.toLowerCase() || '';
    
    // 允许的父进程：electron、AI龙虾、cmd、powershell、explorer
    const allowedParents = ['electron.exe', 'ai龙虾.exe', 'ailobster.exe', 'cmd.exe', 'powershell.exe', 'explorer.exe'];
    return allowedParents.some(p => parentName.includes(p));
  } catch (e) {
    return true; // 检查失败时放行
  }
}

/**
 * 内存保护：清除 Buffer 内容
 */
function secureZero(buffer) {
  if (!buffer) return;
  for (let i = 0; i < buffer.length; i++) {
    buffer[i] = 0;
  }
}

// ============================================================
// Module._compile 钩子 - 自动解密 require 的加密文件
// ============================================================

const originalCompile = Module.prototype._compile;
let securityInitialized = false;

function initSecurityLoader() {
  if (securityInitialized) return;
  securityInitialized = true;
  
  // 反调试检测（开发模式下跳过）
  const isDev = process.argv.includes('--dev') || process.env.NODE_ENV === 'development';
  if (!isDev) {
    if (checkDebugger()) {
      console.error('[Security] 检测到调试器，程序退出');
      process.exit(1);
    }
    if (!checkParentProcess()) {
      console.error('[Security] 父进程校验失败，程序退出');
      process.exit(1);
    }
  }
  
  // 先保存原始的 fs.readFileSync（必须在钩子安装前保存，且不触发自动解密）
  const originalReadFileSync = fs.readFileSync;
  
  // 安装 Module._compile 钩子
  Module.prototype._compile = function(content, filename) {
    // 直接检查 content 是否是加密内容（支持 asar 包内文件）
    // 注意：不能用 isEncryptedFile()，因为它用 fs.openSync 不支持 asar
    // 注意：不能用 fs.readFileSync，因为它会触发自动解密钩子，导致双重解密
    if (filename && filename.endsWith('.js')) {
      try {
        // 快速检查：content 是否以 AENC 开头
        const contentStr = Buffer.isBuffer(content) ? content.toString('binary') : String(content);
        if (contentStr.slice(0, 4) === 'AENC') {
          // 用原始的 fs.readFileSync 重新读取为 Buffer（不触发自动解密钩子）
          const encryptedBuffer = originalReadFileSync.call(fs, filename);
          if (encryptedBuffer && Buffer.isBuffer(encryptedBuffer) && encryptedBuffer.length >= 8 && encryptedBuffer.slice(0, 4).equals(ENCRYPTED_MAGIC)) {
            const decrypted = decrypt(encryptedBuffer);
            if (decrypted) {
              const result = originalCompile.call(this, decrypted.toString('utf8'), filename);
              secureZero(decrypted); // 清除解密后的内存
              return result;
            }
          }
        }
      } catch (e) {
        console.error('[Security] 解密文件失败:', filename, e.message);
      }
    }
    return originalCompile.call(this, content, filename);
  };
  
  // 也需要拦截 fs.readFileSync，因为有些代码会直接读取文件内容
  fs.readFileSync = function(filePath, options) {
    const result = originalReadFileSync.call(this, filePath, options);
    // 如果是 Buffer 且是加密文件，自动解密
    if (Buffer.isBuffer(result) && result.length >= 8 && result.slice(0, 4).equals(ENCRYPTED_MAGIC)) {
      const decrypted = decrypt(result);
      if (decrypted) {
        if (options && options.encoding) {
          return decrypted.toString(options.encoding);
        }
        return decrypted;
      }
    }
    return result;
  };
}

// ============================================================
// 导出
// ============================================================

module.exports = {
  init: initSecurityLoader,
  encrypt,
  decrypt,
  isEncryptedFile,
  checkDebugger,
  secureZero,
  getFullAESKey,
  getAESKeyForEncryption,
  ENCRYPTED_MAGIC,
  ENCRYPTED_FILES,
};

// 自动初始化（当被 require 时立即生效）
initSecurityLoader();
