/**
 * 硬件密钥管理 - 基于设备指纹的密钥加密存储
 * 
 * 功能：
 * 1. 获取硬件信息生成设备指纹（CPU、主板、硬盘、MAC）
 * 2. 使用设备指纹加密主密钥并本地存储
 * 3. 支持密钥激活/初始化流程
 * 4. 硬件变更检测（更换单个硬件不影响，更换多个才需要重新激活）
 * 
 * 使用方式：
 *   const { getAESKey, initHardwareKey, isActivated } = require('./hardware-key');
 *   if (!isActivated()) { initHardwareKey(masterKey); }
 *   const key = getAESKey();
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

// ============================================================
// 配置
// ============================================================

// 密钥存储文件名（存储在用户数据目录）
const KEY_FILE_NAME = '.ailobster_secure_key';

// 设备指纹匹配阈值（0-1），低于此值认为硬件变更过大需要重新激活
const MATCH_THRESHOLD = 0.5;

// 盐值（用于密钥派生，固定值即可）
const SALT = Buffer.from('aiLobster_HardwareKey_Salt_2026', 'utf8');

// ============================================================
// 硬件信息获取
// ============================================================

/**
 * 执行系统命令获取硬件信息（带超时和错误处理）
 */
function execHardwareCmd(cmd, timeout = 3000) {
  try {
    const result = execSync(cmd, { 
      timeout, 
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore']
    });
    return result.toString('utf8').trim();
  } catch (e) {
    return '';
  }
}

/**
 * 获取 CPU ID
 */
function getCpuId() {
  if (process.platform === 'win32') {
    const output = execHardwareCmd('wmic cpu get ProcessorId /value');
    const match = output.match(/ProcessorId\s*=\s*(\S+)/);
    if (match) return match[1];
  }
  // 备用：使用 CPU 型号 + 核心数
  const cpus = os.cpus();
  return cpus[0]?.model + '_' + cpus.length + '_' + os.arch();
}

/**
 * 获取主板序列号
 */
function getMotherboardSerial() {
  if (process.platform === 'win32') {
    const output = execHardwareCmd('wmic baseboard get SerialNumber /value');
    const match = output.match(/SerialNumber\s*=\s*(\S+)/);
    if (match && match[1] !== 'None' && match[1] !== 'Default string') {
      return match[1];
    }
  }
  return 'MB_' + os.hostname();
}

/**
 * 获取系统硬盘序列号（取第一个）
 */
function getDiskSerial() {
  if (process.platform === 'win32') {
    const output = execHardwareCmd('wmic diskdrive where "MediaType like \'%Fixed%\'" get SerialNumber /value', 5000);
    const match = output.match(/SerialNumber\s*=\s*(\S+)/);
    if (match && match[1] !== 'None') {
      return match[1].trim();
    }
  }
  // 备用：使用系统盘卷序列号
  if (process.platform === 'win32') {
    const output = execHardwareCmd('vol C:');
    const match = output.match(/序列号是\s*([0-9A-F-]+)/) || output.match(/Volume Serial Number is\s*([0-9A-F-]+)/);
    if (match) return match[1];
  }
  return 'DISK_' + os.hostname();
}

/**
 * 获取物理网卡 MAC 地址（取第一个非虚拟网卡）
 */
function getMacAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    // 跳过虚拟网卡
    if (/virtual|vmware|virtualbox|loopback|tunnel|teredo|isatap/i.test(name)) continue;
    for (const iface of interfaces[name]) {
      if (iface.mac && iface.mac !== '00:00:00:00:00:00' && !iface.internal) {
        return iface.mac;
      }
    }
  }
  return 'MAC_' + os.hostname();
}

/**
 * 获取所有硬件信息
 */
function getHardwareInfo() {
  return {
    cpuId: getCpuId(),
    motherboard: getMotherboardSerial(),
    disk: getDiskSerial(),
    mac: getMacAddress(),
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch()
  };
}

// ============================================================
// 设备指纹生成
// ============================================================

/**
 * 从硬件信息生成设备指纹（SHA-256）
 */
function generateFingerprint(hardwareInfo) {
  const combined = [
    hardwareInfo.cpuId,
    hardwareInfo.motherboard,
    hardwareInfo.disk,
    hardwareInfo.mac,
    hardwareInfo.platform,
    hardwareInfo.arch
  ].join('|');
  return crypto.createHash('sha256').update(combined).digest();
}

/**
 * 计算两个硬件信息的匹配度（0-1）
 */
function calculateMatchRate(info1, info2) {
  const keys = ['cpuId', 'motherboard', 'disk', 'mac'];
  let matches = 0;
  for (const key of keys) {
    if (info1[key] === info2[key]) matches++;
  }
  return matches / keys.length;
}

// ============================================================
// 密钥派生与加密存储
// ============================================================

/**
 * 从设备指纹派生 AES 密钥（PBKDF2）
 */
function deriveKeyFromFingerprint(fingerprint, iterations = 10000) {
  return crypto.pbkdf2Sync(fingerprint, SALT, iterations, 32, 'sha256');
}

/**
 * 加密主密钥
 */
function encryptMasterKey(masterKey, fingerprint) {
  const derivedKey = deriveKeyFromFingerprint(fingerprint);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', derivedKey, iv);
  const encrypted = Buffer.concat([cipher.update(masterKey), cipher.final()]);
  return {
    iv: iv.toString('hex'),
    encrypted: encrypted.toString('hex'),
    version: 1
  };
}

/**
 * 解密主密钥
 */
function decryptMasterKey(encryptedData, fingerprint) {
  try {
    const derivedKey = deriveKeyFromFingerprint(fingerprint);
    const iv = Buffer.from(encryptedData.iv, 'hex');
    const encrypted = Buffer.from(encryptedData.encrypted, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', derivedKey, iv);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch (e) {
    return null;
  }
}

// ============================================================
// 密钥存储管理
// ============================================================

/**
 * 获取密钥存储文件路径
 */
function getKeyFilePath() {
  // 优先使用 Electron 的 userData 目录
  try {
    const { app } = require('electron');
    if (app && app.getPath) {
      return path.join(app.getPath('userData'), KEY_FILE_NAME);
    }
  } catch (e) { /* 非 Electron 环境 */ }
  // 备用：使用用户主目录
  return path.join(os.homedir(), '.ailobster', KEY_FILE_NAME);
}

/**
 * 检查是否已激活（密钥文件存在）
 */
function isActivated() {
  try {
    return fs.existsSync(getKeyFilePath());
  } catch (e) {
    return false;
  }
}

/**
 * 保存加密后的密钥和硬件信息
 */
function saveKeyData(encryptedKey, hardwareInfo) {
  const keyPath = getKeyFilePath();
  const dir = path.dirname(keyPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const data = {
    version: 1,
    createdAt: new Date().toISOString(),
    hardware: hardwareInfo,
    key: encryptedKey
  };
  // 设置文件为隐藏（Windows）
  fs.writeFileSync(keyPath, JSON.stringify(data, null, 2));
  try {
    if (process.platform === 'win32') {
      execSync(`attrib +h "${keyPath}"`, { windowsHide: true });
    }
  } catch (e) { /* 忽略 */ }
}

/**
 * 读取密钥数据
 */
function loadKeyData() {
  try {
    const keyPath = getKeyFilePath();
    if (!fs.existsSync(keyPath)) return null;
    return JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  } catch (e) {
    return null;
  }
}

// ============================================================
// 主接口
// ============================================================

let cachedKey = null;

/**
 * 初始化硬件密钥（首次运行时调用）
 * @param {Buffer|string} masterKey - 主密钥（32字节）
 * @returns {boolean} 是否成功
 */
function initHardwareKey(masterKey) {
  try {
    const keyBuffer = Buffer.isBuffer(masterKey) ? masterKey : Buffer.from(masterKey, 'utf8');
    if (keyBuffer.length !== 32) {
      console.error('[HardwareKey] 主密钥必须是32字节');
      return false;
    }
    const hardwareInfo = getHardwareInfo();
    const fingerprint = generateFingerprint(hardwareInfo);
    const encrypted = encryptMasterKey(keyBuffer, fingerprint);
    saveKeyData(encrypted, hardwareInfo);
    cachedKey = keyBuffer;
    console.log('[HardwareKey] 密钥初始化成功');
    return true;
  } catch (e) {
    console.error('[HardwareKey] 初始化失败:', e.message);
    return false;
  }
}

/**
 * 获取 AES 密钥（自动解密）
 * @returns {Buffer|null} 密钥，失败返回 null
 */
function getAESKey() {
  // 已缓存直接返回
  if (cachedKey) return cachedKey;
  
  const keyData = loadKeyData();
  if (!keyData) {
    console.error('[HardwareKey] 未找到密钥文件，请先激活');
    return null;
  }
  
  const currentHardware = getHardwareInfo();
  const matchRate = calculateMatchRate(currentHardware, keyData.hardware);
  
  if (matchRate < MATCH_THRESHOLD) {
    console.error(`[HardwareKey] 硬件变更过大（匹配度: ${(matchRate*100).toFixed(0)}%），需要重新激活`);
    return null;
  }
  
  // 尝试用当前硬件指纹解密
  const fingerprint = generateFingerprint(currentHardware);
  const key = decryptMasterKey(keyData.key, fingerprint);
  
  if (!key) {
    // 尝试用存储的硬件信息解密（可能某些硬件信息获取方式不同）
    const storedFingerprint = generateFingerprint(keyData.hardware);
    const key2 = decryptMasterKey(keyData.key, storedFingerprint);
    if (key2) {
      cachedKey = key2;
      console.log('[HardwareKey] 使用存储的硬件信息解密成功（建议重新激活以更新硬件信息）');
      return key2;
    }
    console.error('[HardwareKey] 密钥解密失败');
    return null;
  }
  
  cachedKey = key;
  if (matchRate < 1) {
    console.log(`[HardwareKey] 密钥获取成功（硬件匹配度: ${(matchRate*100).toFixed(0)}%，部分硬件已变更）`);
  }
  return key;
}

/**
 * 获取设备指纹（用于显示给用户，方便激活）
 */
function getDeviceFingerprint() {
  const hardwareInfo = getHardwareInfo();
  const fingerprint = generateFingerprint(hardwareInfo);
  // 返回前16位十六进制作为机器码
  return fingerprint.toString('hex').substring(0, 16).toUpperCase();
}

/**
 * 获取硬件信息详情（用于调试）
 */
function getHardwareDetails() {
  return getHardwareInfo();
}

/**
 * 清除缓存（硬件变更后调用）
 */
function clearCache() {
  cachedKey = null;
}

module.exports = {
  initHardwareKey,
  getAESKey,
  isActivated,
  getDeviceFingerprint,
  getHardwareDetails,
  clearCache,
  MATCH_THRESHOLD
};
