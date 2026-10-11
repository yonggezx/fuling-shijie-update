#!/usr/bin/env node
/**
 * 硬件密钥激活工具
 * 
 * 功能：
 * 1. 生成设备指纹（机器码）
 * 2. 初始化硬件绑定密钥
 * 3. 查看激活状态
 * 4. 重置激活（清除密钥）
 * 
 * 使用方式：
 *   node scripts/activate-key.js              # 查看激活状态和设备指纹
 *   node scripts/activate-key.js activate     # 激活（使用默认密钥）
 *   node scripts/activate-key.js reset        # 重置激活（清除密钥）
 *   node scripts/activate-key.js hardware     # 查看硬件信息详情
 */

'use strict';

const path = require('path');

// 动态加载 hardware-key 模块（避免 security-loader 自动初始化）
const hardwareKeyPath = path.join(__dirname, '..', 'src', 'main', 'hardware-key.js');
const hardwareKey = require(hardwareKeyPath);

function log(msg) { console.log(`\x1b[36m[activate]\x1b[0m ${msg}`); }
function success(msg) { console.log(`\x1b[32m[success]\x1b[0m ${msg}`); }
function error(msg) { console.error(`\x1b[31m[error]\x1b[0m ${msg}`); }
function info(msg) { console.log(`\x1b[90m[info]\x1b[0m ${msg}`); }

// 默认 PART2（16字节），与 security-loader.js 和 encrypt-asar.js 一致
const DEFAULT_PART2 = Buffer.from('ey2026!@#$%^&*()', 'utf8');

// 生成完整的32字节密钥（前16字节为占位，后16字节为 PART2）
// 注意：实际完整密钥 = PART1（硬编码混淆） + PART2（硬件绑定存储）
// hardware-key 存储的是完整32字节，但运行时只取后16字节作为 PART2
function generateMasterKey() {
  const placeholder = Buffer.alloc(16, 0xAA); // 前16字节占位（运行时由硬编码 PART1 替代）
  return Buffer.concat([placeholder, DEFAULT_PART2]);
}

function showStatus() {
  log('=== 硬件密钥激活状态 ===');
  console.log('');
  
  const activated = hardwareKey.isActivated();
  console.log(`  激活状态: ${activated ? '✅ 已激活' : '❌ 未激活'}`);
  console.log(`  设备指纹: ${hardwareKey.getDeviceFingerprint()}`);
  console.log(`  匹配阈值: ${(hardwareKey.MATCH_THRESHOLD * 100).toFixed(0)}%（更换超过2个硬件需要重新激活）`);
  console.log('');
  
  if (activated) {
    const key = hardwareKey.getAESKey();
    if (key) {
      success('密钥获取成功，可以正常解密加密文件');
      console.log(`  密钥长度: ${key.length} bytes`);
    } else {
      error('密钥获取失败，可能硬件变更过大');
    }
  } else {
    info('未激活时，加密文件无法解密。请运行 "node scripts/activate-key.js activate" 进行激活。');
  }
}

function activate() {
  log('开始激活硬件密钥...');
  console.log('');
  
  const fingerprint = hardwareKey.getDeviceFingerprint();
  console.log(`  设备指纹: ${fingerprint}`);
  console.log('');
  
  const masterKey = generateMasterKey();
  const success_flag = hardwareKey.initHardwareKey(masterKey);
  
  if (success_flag) {
    success('激活成功！硬件绑定密钥已创建');
    console.log('');
    info('密钥已加密存储在用户数据目录，与当前设备硬件信息绑定。');
    info('更换单个硬件（如硬盘、网卡）不影响使用，更换超过2个硬件需要重新激活。');
  } else {
    error('激活失败，请检查错误日志');
    process.exit(1);
  }
}

function reset() {
  log('重置激活状态...');
  
  const keyPath = path.join(require('os').homedir(), '.ailobster', '.ailobster_secure_key');
  const fs = require('fs');
  
  if (fs.existsSync(keyPath)) {
    fs.unlinkSync(keyPath);
    success('已清除密钥文件');
  } else {
    info('未找到密钥文件，无需重置');
  }
  
  hardwareKey.clearCache();
}

function showHardware() {
  log('=== 硬件信息详情 ===');
  console.log('');
  
  const info = hardwareKey.getHardwareDetails();
  console.log(`  CPU ID:      ${info.cpuId}`);
  console.log(`  主板序列号:  ${info.motherboard}`);
  console.log(`  硬盘序列号:  ${info.disk}`);
  console.log(`  MAC 地址:    ${info.mac}`);
  console.log(`  主机名:      ${info.hostname}`);
  console.log(`  平台:        ${info.platform}`);
  console.log(`  架构:        ${info.arch}`);
  console.log('');
  console.log(`  设备指纹:    ${hardwareKey.getDeviceFingerprint()}`);
}

// 主流程
const command = process.argv[2] || 'status';

switch (command) {
  case 'status':
    showStatus();
    break;
  case 'activate':
    activate();
    break;
  case 'reset':
    reset();
    break;
  case 'hardware':
    showHardware();
    break;
  default:
    error(`未知命令: ${command}`);
    console.log('');
    console.log('使用方式:');
    console.log('  node scripts/activate-key.js              查看激活状态');
    console.log('  node scripts/activate-key.js activate     激活硬件密钥');
    console.log('  node scripts/activate-key.js reset        重置激活');
    console.log('  node scripts/activate-key.js hardware     查看硬件信息');
    process.exit(1);
}
