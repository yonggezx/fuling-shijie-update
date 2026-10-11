/**
 * 凭证 / 密钥存储
 * ============================================================
 * 规范：凭证**严禁**写进 yaml / md / json，必须独立加密保管，且永不进 AI 上下文。
 *
 * 实现：Electron safeStorage（Windows 走 DPAPI，按当前用户加密；macOS 走 Keychain）。
 * safeStorage 不可用时不静默明文落盘 —— 返回失败让调用方决定，并打印明确告警。
 * ============================================================
 */
const fs = require('fs');
const path = require('path');

let _safeStorage = null;
let _dir = null;
let _warned = false;

function electronSafeStorage() {
  if (_safeStorage !== null) return _safeStorage;
  try {
    // eslint-disable-next-line global-require
    const electron = require('electron');
    _safeStorage = electron && electron.safeStorage ? electron.safeStorage : false;
  } catch (e) {
    _safeStorage = false;   // 非 Electron 环境（node 脚本）
  }
  return _safeStorage;
}

function secretsDir() {
  if (_dir) return _dir;
  try {
    // eslint-disable-next-line global-require
    const { app } = require('electron');
    _dir = app && app.getPath ? path.join(app.getPath('userData'), 'secrets') : null;
  } catch (e) { _dir = null; }
  if (!_dir) return null;
  if (!fs.existsSync(_dir)) {
    try { fs.mkdirSync(_dir, { recursive: true }); } catch (e) { /* 由写入时报错 */ }
  }
  return _dir;
}

function fileFor(key) {
  const dir = secretsDir();
  if (!dir) return null;
  // key 只允许安全字符，避免路径穿越
  const safe = String(key).replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(dir, safe + '.enc');
}

/** 当前环境是否能真加密 */
function encryptionAvailable() {
  const s = electronSafeStorage();
  return !!(s && typeof s.isEncryptionAvailable === 'function' && s.isEncryptionAvailable());
}

function warnOnce(msg) {
  if (_warned) return;
  _warned = true;
  console.warn('[credentialStore] ' + msg);
}

/** 写入凭证。返回 { ok, reason } */
function setSecret(key, plaintext) {
  const f = fileFor(key);
  if (!f) return { ok: false, reason: '无法定位 userData 目录' };
  const s = electronSafeStorage();
  if (!s || !encryptionAvailable()) {
    warnOnce('safeStorage 不可用，凭证不会以明文落盘（已跳过写入）');
    return { ok: false, reason: 'safeStorage 不可用' };
  }
  try {
    const buf = s.encryptString(String(plaintext));
    fs.writeFileSync(f, buf);
    return { ok: true, file: f };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/** 读取凭证，失败返回 null */
function getSecret(key) {
  const f = fileFor(key);
  if (!f || !fs.existsSync(f)) return null;
  const s = electronSafeStorage();
  if (!s || typeof s.decryptString !== 'function') return null;
  try {
    return s.decryptString(fs.readFileSync(f));
  } catch (e) {
    console.warn('[credentialStore] 解密失败:', e.message);
    return null;
  }
}

function deleteSecret(key) {
  const f = fileFor(key);
  if (!f) return false;
  try { if (fs.existsSync(f)) fs.unlinkSync(f); return true; } catch (e) { return false; }
}

function hasSecret(key) {
  const f = fileFor(key);
  return !!(f && fs.existsSync(f));
}

module.exports = {
  setSecret,
  getSecret,
  deleteSecret,
  hasSecret,
  encryptionAvailable,
  secretsDir
};
