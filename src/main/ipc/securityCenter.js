/**
 * 安全中心模块
 * 包含：沙箱安全、数据安全、审计中心
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { app } = require('electron');

class SecurityCenter {
  constructor() {
    this.dataDir = path.join(app.getPath('userData'), 'security');
    this.trashDir = path.join(this.dataDir, 'trash');
    this.backupDir = path.join(this.dataDir, 'backups');
    this.auditLogFile = path.join(this.dataDir, 'audit-log.json');
    this.configFile = path.join(this.dataDir, 'config.json');

    this.ensureDirs();
    this.config = this.loadConfig();
    this.auditLogs = this.loadAuditLogs();

    // 敏感信息检测规则
    this.sensitivePatterns = [
      { name: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/g, type: 'api_key' },
      { name: 'AWS Secret Key', regex: /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g, type: 'secret_key', minEntropy: 3.5 },
      { name: 'GitHub Token', regex: /gh[pousr]_[A-Za-z0-9]{36}/g, type: 'api_key' },
      { name: 'GitHub PAT (Classic)', regex: /ghp_[A-Za-z0-9]{36}/g, type: 'api_key' },
      { name: 'Slack Token', regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g, type: 'api_key' },
      { name: 'Google API Key', regex: /AIza[0-9A-Za-z\-_]{35}/g, type: 'api_key' },
      { name: 'Private Key', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, type: 'private_key' },
      { name: 'Email', regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, type: 'email' },
      { name: 'Phone (CN)', regex: /1[3-9]\d{9}/g, type: 'phone' },
      { name: 'ID Card (CN)', regex: /[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]/g, type: 'id_card' },
      { name: 'Bank Card', regex: /\b(?:\d[ -]*?){13,16}\b/g, type: 'bank_card' },
      { name: 'IPv4', regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, type: 'ip' },
      { name: 'URL with Credentials', regex: /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\/\s:@]+:[^\/\s:@]+@/g, type: 'url_credentials' },
      { name: 'JWT Token', regex: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, type: 'jwt' },
      { name: 'Password in URL/JSON', regex: /["']?(?:password|passwd|pwd|secret|token|api[_-]?key)["']?\s*[:=]\s*["']([^"']{6,})["']/gi, type: 'password' },
    ];

    // 危险命令黑名单
    this.dangerousCommands = [
      { pattern: /rm\s+-rf\s+\/($|\s)/, risk: 'critical', desc: '删除根目录' },
      { pattern: /mkfs\./, risk: 'critical', desc: '格式化磁盘' },
      { pattern: /dd\s+if=.*of=\/dev\//, risk: 'critical', desc: '直接写入磁盘设备' },
      { pattern: /:\(\)\s*\{.*\}\s*;\s*:/, risk: 'critical', desc: 'fork炸弹' },
      { pattern: /shutdown\s+(-h|-s)/, risk: 'high', desc: '关机命令' },
      { pattern: /reboot/, risk: 'high', desc: '重启命令' },
      { pattern: /curl.*\|.*(sh|bash)/, risk: 'high', desc: '远程脚本执行' },
      { pattern: /wget.*\|.*(sh|bash)/, risk: 'high', desc: '远程脚本执行' },
      { pattern: /chmod\s+777/, risk: 'medium', desc: '过度开放权限' },
      { pattern: /sudo\s+/, risk: 'medium', desc: '提权操作' },
      { pattern: /eval\s*\(/, risk: 'medium', desc: '动态代码执行' },
      { pattern: /nc\s+-l/, risk: 'medium', desc: '反向shell监听' },
    ];

    // 危险文件操作
    this.dangerousFilePatterns = [
      { pattern: /^\/$/, risk: 'critical', desc: '根目录' },
      { pattern: /^\/(etc|bin|sbin|usr|boot|dev|proc|sys)(\/|$)/, risk: 'high', desc: '系统目录' },
      { pattern: /\.ssh\/(id_rsa|id_ed25519|known_hosts)/, risk: 'high', desc: 'SSH密钥' },
      { pattern: /\.aws\/credentials/, risk: 'high', desc: 'AWS凭证' },
      { pattern: /\.env$/, risk: 'medium', desc: '环境变量文件' },
    ];
  }

  ensureDirs() {
    [this.dataDir, this.trashDir, this.backupDir].forEach(dir => {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });
  }

  // ========== 配置管理 ==========
  defaultConfig() {
    return {
      sandbox: {
        fileSecurity: true,
        commandSecurity: true,
        networkSecurity: true,
        autoBackup: true,
        backupMaxSizeMB: 500,
        backupIntervalHours: 24,
        lastBackupTime: null,
      },
      data: {
        deleteProtection: true,
        trashEnabled: true,
        trashAutoClearDays: 30,
        secureGateway: true,
        transportEncryption: true,
        sensitiveDetection: true,
        sensitiveAutoEncrypt: true,
        encryptionKey: null,
      },
      audit: {
        enabled: true,
        maxLogs: 10000,
        autoDeleteDays: 90,
        logFileOps: true,
        logCommandOps: true,
        logNetworkOps: true,
        logLoginOps: true,
      }
    };
  }

  loadConfig() {
    try {
      if (fs.existsSync(this.configFile)) {
        const saved = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
        const def = this.defaultConfig();
        return this.deepMerge(def, saved);
      }
    } catch (e) { console.error('[SecurityCenter] 加载配置失败:', e.message); }
    return this.defaultConfig();
  }

  saveConfig() {
    try {
      fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2), 'utf8');
    } catch (e) { console.error('[SecurityCenter] 保存配置失败:', e.message); }
  }

  deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source || {})) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = this.deepMerge(target[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }
    return result;
  }

  getConfig() { return this.config; }
  setConfig(newConfig) {
    this.config = this.deepMerge(this.config, newConfig);
    this.saveConfig();
    return this.config;
  }

  // ========== 审计日志 ==========
  loadAuditLogs() {
    try {
      if (fs.existsSync(this.auditLogFile)) {
        return JSON.parse(fs.readFileSync(this.auditLogFile, 'utf8'));
      }
    } catch (e) { console.error('[SecurityCenter] 加载审计日志失败:', e.message); }
    return [];
  }

  saveAuditLogs() {
    try {
      // 自动清理超过阈值的日志
      const maxLogs = this.config.audit.maxLogs;
      if (this.auditLogs.length > maxLogs) {
        this.auditLogs = this.auditLogs.slice(-maxLogs);
      }
      // 自动删除超过天数的日志
      const autoDeleteDays = this.config.audit.autoDeleteDays;
      if (autoDeleteDays > 0) {
        const cutoff = Date.now() - autoDeleteDays * 24 * 60 * 60 * 1000;
        this.auditLogs = this.auditLogs.filter(l => l.timestamp >= cutoff);
      }
      fs.writeFileSync(this.auditLogFile, JSON.stringify(this.auditLogs, null, 2), 'utf8');
    } catch (e) { console.error('[SecurityCenter] 保存审计日志失败:', e.message); }
  }

  addAuditLog(category, action, details, risk = 'low') {
    if (!this.config.audit.enabled) return;
    const log = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      category, // file | command | network | auth | config | data
      action,
      details: details || {},
      risk, // low | medium | high | critical
      ip: null,
      userAgent: null,
    };
    this.auditLogs.push(log);
    this.saveAuditLogs();
    return log;
  }

  getAuditLogs(filters = {}) {
    let logs = [...this.auditLogs];
    if (filters.category) logs = logs.filter(l => l.category === filters.category);
    if (filters.risk) logs = logs.filter(l => l.risk === filters.risk);
    if (filters.startTime) logs = logs.filter(l => l.timestamp >= filters.startTime);
    if (filters.endTime) logs = logs.filter(l => l.timestamp <= filters.endTime);
    if (filters.limit) logs = logs.slice(-filters.limit);
    return logs.reverse();
  }

  clearAuditLogs(filters = {}) {
    if (Object.keys(filters).length === 0) {
      this.auditLogs = [];
    } else {
      let logs = [...this.auditLogs];
      if (filters.category) logs = logs.filter(l => l.category !== filters.category);
      if (filters.before) logs = logs.filter(l => l.timestamp >= filters.before);
      this.auditLogs = logs;
    }
    this.saveAuditLogs();
    return true;
  }

  exportAuditLogs(format = 'json') {
    const data = this.auditLogs;
    if (format === 'csv') {
      const headers = ['id', 'timestamp', 'category', 'action', 'risk', 'details'];
      const rows = data.map(l => [
        l.id,
        new Date(l.timestamp).toISOString(),
        l.category,
        l.action,
        l.risk,
        JSON.stringify(l.details).replace(/"/g, '""')
      ].join(','));
      return headers.join(',') + '\n' + rows.join('\n');
    }
    return JSON.stringify(data, null, 2);
  }

  // ========== 沙箱安全 - 命令安全 ==========
  checkCommand(command) {
    if (!this.config.sandbox.commandSecurity) return { allowed: true };
    const findings = [];
    for (const rule of this.dangerousCommands) {
      if (rule.pattern.test(command)) {
        findings.push({ rule: rule.desc, risk: rule.risk });
      }
    }
    if (findings.length > 0) {
      const maxRisk = findings.some(f => f.risk === 'critical') ? 'critical' :
                     findings.some(f => f.risk === 'high') ? 'high' : 'medium';
      this.addAuditLog('command', 'blocked', { command: command.substring(0, 200), findings }, maxRisk);
      return { allowed: false, findings, risk: maxRisk };
    }
    this.addAuditLog('command', 'executed', { command: command.substring(0, 200) }, 'low');
    return { allowed: true };
  }

  // ========== 沙箱安全 - 文件安全 ==========
  checkFileOperation(filePath, operation) {
    if (!this.config.sandbox.fileSecurity) return { allowed: true };
    const normalized = path.normalize(filePath).replace(/\\/g, '/');
    const findings = [];
    for (const rule of this.dangerousFilePatterns) {
      if (rule.pattern.test(normalized)) {
        findings.push({ rule: rule.desc, risk: rule.risk });
      }
    }
    if (findings.length > 0) {
      const maxRisk = findings.some(f => f.risk === 'critical') ? 'critical' :
                     findings.some(f => f.risk === 'high') ? 'high' : 'medium';
      this.addAuditLog('file', 'blocked_' + operation, { path: normalized, findings }, maxRisk);
      return { allowed: false, findings, risk: maxRisk };
    }
    this.addAuditLog('file', operation, { path: normalized }, 'low');
    return { allowed: true };
  }

  // ========== 沙箱安全 - 网络安全 ==========
  checkNetworkRequest(url, method = 'GET') {
    if (!this.config.sandbox.networkSecurity) return { allowed: true };
    const blockedDomains = []; // 可配置恶意域名列表
    try {
      const urlObj = new URL(url);
      for (const domain of blockedDomains) {
        if (urlObj.hostname.endsWith(domain)) {
          this.addAuditLog('network', 'blocked', { url, method, reason: 'blocked_domain' }, 'high');
          return { allowed: false, reason: 'blocked_domain' };
        }
      }
      // 检查是否为HTTP（非HTTPS）
      if (urlObj.protocol === 'http:' && this.config.data.secureGateway) {
        this.addAuditLog('network', 'http_warning', { url, method }, 'medium');
      }
    } catch (e) {}
    this.addAuditLog('network', 'request', { url: url.substring(0, 200), method }, 'low');
    return { allowed: true };
  }

  // ========== 数据安全 - 纸篓功能 ==========
  moveToTrash(item, type = 'conversation') {
    if (!this.config.data.trashEnabled) return null;
    const trashItem = {
      id: crypto.randomUUID(),
      type, // conversation | message | file
      originalId: item.id || null,
      data: item,
      deletedAt: Date.now(),
      expiresAt: Date.now() + this.config.data.trashAutoClearDays * 24 * 60 * 60 * 1000,
    };
    const trashFile = path.join(this.trashDir, trashItem.id + '.json');
    fs.writeFileSync(trashFile, JSON.stringify(trashItem, null, 2), 'utf8');
    this.addAuditLog('data', 'moved_to_trash', { type, originalId: trashItem.originalId }, 'low');
    this.clearExpiredTrash();
    return trashItem;
  }

  getTrashItems(type = null) {
    this.clearExpiredTrash();
    const items = [];
    try {
      const files = fs.readdirSync(this.trashDir).filter(f => f.endsWith('.json'));
      for (const f of files) {
        try {
          const item = JSON.parse(fs.readFileSync(path.join(this.trashDir, f), 'utf8'));
          if (!type || item.type === type) items.push(item);
        } catch (e) {}
      }
    } catch (e) {}
    return items.sort((a, b) => b.deletedAt - a.deletedAt);
  }

  restoreFromTrash(trashId) {
    const trashFile = path.join(this.trashDir, trashId + '.json');
    if (!fs.existsSync(trashFile)) return null;
    try {
      const item = JSON.parse(fs.readFileSync(trashFile, 'utf8'));
      fs.unlinkSync(trashFile);
      this.addAuditLog('data', 'restored_from_trash', { type: item.type, originalId: item.originalId }, 'low');
      return item.data;
    } catch (e) { return null; }
  }

  deleteFromTrash(trashId) {
    const trashFile = path.join(this.trashDir, trashId + '.json');
    if (fs.existsSync(trashFile)) {
      try {
        const item = JSON.parse(fs.readFileSync(trashFile, 'utf8'));
        fs.unlinkSync(trashFile);
        this.addAuditLog('data', 'permanently_deleted', { type: item.type, originalId: item.originalId }, 'medium');
        return true;
      } catch (e) { return false; }
    }
    return false;
  }

  clearTrash(type = null) {
    let count = 0;
    try {
      const files = fs.readdirSync(this.trashDir).filter(f => f.endsWith('.json'));
      for (const f of files) {
        try {
          const item = JSON.parse(fs.readFileSync(path.join(this.trashDir, f), 'utf8'));
          if (!type || item.type === type) {
            fs.unlinkSync(path.join(this.trashDir, f));
            count++;
          }
        } catch (e) {}
      }
    } catch (e) {}
    this.addAuditLog('data', 'trash_cleared', { count, type }, 'medium');
    return count;
  }

  clearExpiredTrash() {
    const now = Date.now();
    let count = 0;
    try {
      const files = fs.readdirSync(this.trashDir).filter(f => f.endsWith('.json'));
      for (const f of files) {
        try {
          const item = JSON.parse(fs.readFileSync(path.join(this.trashDir, f), 'utf8'));
          if (item.expiresAt && item.expiresAt < now) {
            fs.unlinkSync(path.join(this.trashDir, f));
            count++;
          }
        } catch (e) {}
      }
    } catch (e) {}
    return count;
  }

  // ========== 数据安全 - 敏感信息检测 ==========
  calculateEntropy(str) {
    if (!str || str.length === 0) return 0;
    const freq = {};
    for (const c of str) freq[c] = (freq[c] || 0) + 1;
    let entropy = 0;
    const len = str.length;
    for (const c of Object.keys(freq)) {
      const p = freq[c] / len;
      entropy -= p * Math.log2(p);
    }
    return entropy;
  }

  scanSensitive(text) {
    if (!this.config.data.sensitiveDetection || !text) return [];
    const findings = [];
    for (const pattern of this.sensitivePatterns) {
      try {
        const matches = text.match(pattern.regex);
        if (matches) {
          for (const match of matches) {
            // 熵值检测（对于密钥类）
            if (pattern.minEntropy) {
              const entropy = this.calculateEntropy(match);
              if (entropy < pattern.minEntropy) continue;
            }
            findings.push({
              type: pattern.type,
              name: pattern.name,
              value: pattern.type === 'password' ? match.replace(/(["']?[^"']+["']?\s*[:=]\s*["'])([^"']+)(["'])/, '$1***$3') :
                     (pattern.type === 'email' || pattern.type === 'phone' || pattern.type === 'id_card' || pattern.type === 'bank_card' || pattern.type === 'ip' ?
                       this.maskSensitive(match, pattern.type) : match.substring(0, 8) + '...'),
              originalLength: match.length,
              position: text.indexOf(match),
            });
          }
        }
      } catch (e) {}
    }
    // 去重
    const unique = [];
    const seen = new Set();
    for (const f of findings) {
      const key = f.type + ':' + f.value;
      if (!seen.has(key)) { seen.add(key); unique.push(f); }
    }
    return unique;
  }

  maskSensitive(value, type) {
    switch (type) {
      case 'email':
        const [user, domain] = value.split('@');
        return user.substring(0, 2) + '***@' + domain;
      case 'phone':
        return value.substring(0, 3) + '****' + value.substring(7);
      case 'id_card':
        return value.substring(0, 6) + '********' + value.substring(14);
      case 'bank_card':
        return value.replace(/\s/g, '').substring(0, 4) + ' **** **** ' + value.replace(/\s/g, '').substring(12);
      case 'ip':
        const parts = value.split('.');
        return parts[0] + '.' + parts[1] + '.*.*';
      default:
        return value.substring(0, 4) + '***';
    }
  }

  // ========== 数据安全 - 加密 ==========
  getEncryptionKey() {
    if (!this.config.data.encryptionKey) {
      // 生成基于设备的密钥
      const machineId = os.hostname() + os.platform() + os.arch();
      this.config.data.encryptionKey = crypto.createHash('sha256').update(machineId + 'fuling-shijie-salt').digest('hex').substring(0, 32);
      this.saveConfig();
    }
    return this.config.data.encryptionKey;
  }

  encryptText(text) {
    if (!text) return text;
    try {
      const key = this.getEncryptionKey();
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key, 'utf8'), iv);
      let encrypted = cipher.update(text, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      return 'ENC:' + iv.toString('hex') + ':' + encrypted;
    } catch (e) { return text; }
  }

  decryptText(encrypted) {
    if (!encrypted || !encrypted.startsWith('ENC:')) return encrypted;
    try {
      const key = this.getEncryptionKey();
      const parts = encrypted.split(':');
      const iv = Buffer.from(parts[1], 'hex');
      const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key, 'utf8'), iv);
      let decrypted = decipher.update(parts[2], 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (e) { return encrypted; }
  }

  encryptSensitiveInText(text) {
    if (!this.config.data.sensitiveAutoEncrypt) return text;
    const findings = this.scanSensitive(text);
    let result = text;
    for (const f of findings) {
      if (f.type === 'api_key' || f.type === 'secret_key' || f.type === 'private_key' || f.type === 'password' || f.type === 'jwt') {
        // 找到原始值并加密替换
        // 注意：scanSensitive 返回的是脱敏后的值，这里需要重新匹配原始值
      }
    }
    return result;
  }

  // ========== 沙箱安全 - 自动备份 ==========
  createBackup() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `backup-${timestamp}.zip`;
    const backupPath = path.join(this.backupDir, backupName);

    try {
      // 备份用户数据
      const userDataDir = app.getPath('userData');
      const itemsToBackup = [
        'conversations.json',
        'config.json',
        'security',
      ];

      // 简单备份：复制关键文件
      const backupDataDir = path.join(this.backupDir, 'tmp-' + timestamp);
      fs.mkdirSync(backupDataDir, { recursive: true });

      for (const item of itemsToBackup) {
        const src = path.join(userDataDir, item);
        const dst = path.join(backupDataDir, item);
        if (fs.existsSync(src)) {
          if (fs.statSync(src).isDirectory()) {
            this.copyDir(src, dst);
          } else {
            fs.copyFileSync(src, dst);
          }
        }
      }

      // 检查备份大小
      const backupSize = this.getDirSize(backupDataDir);
      const maxSize = this.config.sandbox.backupMaxSizeMB * 1024 * 1024;

      if (backupSize > maxSize) {
        // 清理旧备份
        this.cleanOldBackups();
      }

      // 用系统压缩（这里简化为直接保留目录，实际可用archiver）
      fs.renameSync(backupDataDir, backupPath.replace('.zip', ''));

      this.config.sandbox.lastBackupTime = Date.now();
      this.saveConfig();
      this.addAuditLog('data', 'backup_created', { name: backupName, sizeMB: (backupSize / 1024 / 1024).toFixed(2) }, 'low');

      return { success: true, path: backupPath.replace('.zip', ''), sizeMB: (backupSize / 1024 / 1024).toFixed(2) };
    } catch (e) {
      this.addAuditLog('data', 'backup_failed', { error: e.message }, 'medium');
      return { success: false, error: e.message };
    }
  }

  copyDir(src, dst) {
    if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const dstPath = path.join(dst, entry.name);
      if (entry.isDirectory()) {
        this.copyDir(srcPath, dstPath);
      } else {
        fs.copyFileSync(srcPath, dstPath);
      }
    }
  }

  getDirSize(dir) {
    let size = 0;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          size += this.getDirSize(fullPath);
        } else {
          size += fs.statSync(fullPath).size;
        }
      }
    } catch (e) {}
    return size;
  }

  getBackups() {
    const backups = [];
    try {
      const files = fs.readdirSync(this.backupDir);
      for (const f of files) {
        if (f.startsWith('backup-')) {
          const fullPath = path.join(this.backupDir, f);
          const stat = fs.statSync(fullPath);
          backups.push({
            name: f,
            path: fullPath,
            sizeMB: (this.getDirSize(fullPath) / 1024 / 1024).toFixed(2),
            createdAt: stat.mtimeMs,
          });
        }
      }
    } catch (e) {}
    return backups.sort((a, b) => b.createdAt - a.createdAt);
  }

  deleteBackup(backupName) {
    const backupPath = path.join(this.backupDir, backupName);
    if (fs.existsSync(backupPath)) {
      try {
        fs.rmSync(backupPath, { recursive: true, force: true });
        this.addAuditLog('data', 'backup_deleted', { name: backupName }, 'low');
        return true;
      } catch (e) { return false; }
    }
    return false;
  }

  cleanOldBackups() {
    const backups = this.getBackups();
    const maxSize = this.config.sandbox.backupMaxSizeMB * 1024 * 1024;
    let totalSize = backups.reduce((sum, b) => sum + parseFloat(b.sizeMB) * 1024 * 1024, 0);

    while (totalSize > maxSize && backups.length > 1) {
      const oldest = backups.pop();
      this.deleteBackup(oldest.name);
      totalSize -= parseFloat(oldest.sizeMB) * 1024 * 1024;
    }
  }

  shouldAutoBackup() {
    if (!this.config.sandbox.autoBackup) return false;
    const lastBackup = this.config.sandbox.lastBackupTime;
    if (!lastBackup) return true;
    const interval = this.config.sandbox.backupIntervalHours * 60 * 60 * 1000;
    return Date.now() - lastBackup > interval;
  }

  // ========== 安全网关 & 传输加密（状态查询） ==========
  getSecurityStatus() {
    return {
      secureGateway: this.config.data.secureGateway,
      transportEncryption: this.config.data.transportEncryption,
      sandboxActive: this.config.sandbox.fileSecurity || this.config.sandbox.commandSecurity || this.config.sandbox.networkSecurity,
      auditEnabled: this.config.audit.enabled,
      trashEnabled: this.config.data.trashEnabled,
      trashCount: this.getTrashItems().length,
      backupCount: this.getBackups().length,
      lastBackup: this.config.sandbox.lastBackupTime,
      totalAuditLogs: this.auditLogs.length,
    };
  }
}

module.exports = new SecurityCenter();
