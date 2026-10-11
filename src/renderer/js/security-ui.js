/**
 * 安全中心前端模块
 */
(function() {
  'use strict';

  const SecurityUI = {
    config: null,
    status: null,
    currentTab: 'sandbox',
    _initialized: false,

    // 打开安全中心弹窗
    openModal() {
      const overlay = document.getElementById('security-modal-overlay');
      if (overlay) overlay.style.display = 'flex';
      // 首次打开时初始化
      if (!this._initialized) {
        this.init();
      } else {
        // 已初始化则刷新状态
        this.refreshStatus();
      }
      // 连通器管理是**独立弹窗**（聊天页顶部按钮打开），这里不再联动
    },

    // 关闭安全中心弹窗
    closeModal() {
      const overlay = document.getElementById('security-modal-overlay');
      if (overlay) overlay.style.display = 'none';
    },

    // 刷新状态（不重新绑定事件）
    async refreshStatus() {
      try {
        this.status = await window.api.security.getStatus();
        this.renderStatus();
      } catch (e) {}
    },

    async init() {
      try {
        this.config = await window.api.security.getConfig();
        this.status = await window.api.security.getStatus();
        this.enhanceNumberInputs();
        this.bindEvents();
        this.renderConfig();
        this.renderStatus();
        this._initialized = true;
      } catch (e) {
        console.error('[SecurityUI] 初始化失败:', e);
      }
    },

    // 为数字输入框添加自定义加减按钮
    enhanceNumberInputs() {
      const modal = document.getElementById('security-modal');
      if (!modal) return;
      const inputs = modal.querySelectorAll('.setting-item input[type="number"]');
      inputs.forEach(input => {
        if (input.parentElement.classList.contains('sec-number-input')) return;
        
        const wrapper = document.createElement('div');
        wrapper.className = 'sec-number-input';
        wrapper.style.cssText = 'display:flex;align-items:center;border:1px solid var(--border,rgba(255,255,255,0.1));border-radius:6px;overflow:hidden;background:var(--bg-tertiary,#313244);';
        
        const minusBtn = document.createElement('button');
        minusBtn.type = 'button';
        minusBtn.className = 'sec-num-btn sec-num-minus';
        minusBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="5" y1="12" x2="19" y2="12"/></svg>';
        minusBtn.style.cssText = 'width:26px;height:28px;border:none;background:var(--bg-hover,rgba(255,255,255,0.06));color:var(--text-secondary,#999);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.15s;';
        
        const plusBtn = document.createElement('button');
        plusBtn.type = 'button';
        plusBtn.className = 'sec-num-btn sec-num-plus';
        plusBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
        plusBtn.style.cssText = 'width:26px;height:28px;border:none;background:var(--bg-hover,rgba(255,255,255,0.06));color:var(--text-secondary,#999);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.15s;';
        
        input.style.cssText = 'width:50px;height:28px;border:none;border-left:1px solid var(--border,rgba(255,255,255,0.1));border-right:1px solid var(--border,rgba(255,255,255,0.1));background:transparent;color:var(--text-primary,#fff);font-size:12px;text-align:center;outline:none;font-family:inherit;';
        
        input.parentNode.insertBefore(wrapper, input);
        wrapper.appendChild(minusBtn);
        wrapper.appendChild(input);
        wrapper.appendChild(plusBtn);
        
        const step = parseInt(input.step) || 1;
        const min = parseInt(input.min);
        const max = parseInt(input.max);
        
        minusBtn.addEventListener('click', () => {
          let val = parseInt(input.value) || 0;
          val -= step;
          if (!isNaN(min) && val < min) val = min;
          input.value = val;
          input.dispatchEvent(new Event('change'));
        });
        
        plusBtn.addEventListener('click', () => {
          let val = parseInt(input.value) || 0;
          val += step;
          if (!isNaN(max) && val > max) val = max;
          input.value = val;
          input.dispatchEvent(new Event('change'));
        });
        
        // 悬停效果
        [minusBtn, plusBtn].forEach(btn => {
          btn.addEventListener('mouseenter', () => {
            btn.style.background = 'var(--accent,#ee5a24)';
            btn.style.color = '#fff';
          });
          btn.addEventListener('mouseleave', () => {
            btn.style.background = 'var(--bg-hover,rgba(255,255,255,0.06))';
            btn.style.color = 'var(--text-secondary,#999)';
          });
        });
        
        // 聚焦时wrapper边框变色
        input.addEventListener('focus', () => {
          wrapper.style.borderColor = 'var(--accent,#ee5a24)';
          wrapper.style.boxShadow = '0 0 0 2px rgba(238,90,36,0.2)';
        });
        input.addEventListener('blur', () => {
          wrapper.style.borderColor = 'var(--border,rgba(255,255,255,0.1))';
          wrapper.style.boxShadow = 'none';
        });
      });
    },

    bindEvents() {
      // 沙箱安全开关
      this.bindSwitch('sec-file-security', 'sandbox.fileSecurity');
      this.bindSwitch('sec-command-security', 'sandbox.commandSecurity');
      this.bindSwitch('sec-network-security', 'sandbox.networkSecurity');
      this.bindSwitch('sec-auto-backup', 'sandbox.autoBackup');

      // 备份设置
      const backupSize = document.getElementById('sec-backup-size');
      if (backupSize) {
        backupSize.addEventListener('change', async () => {
          await this.updateConfig({ sandbox: { backupMaxSizeMB: parseInt(backupSize.value) || 500 } });
        });
      }
      const backupInterval = document.getElementById('sec-backup-interval');
      if (backupInterval) {
        backupInterval.addEventListener('change', async () => {
          await this.updateConfig({ sandbox: { backupIntervalHours: parseInt(backupInterval.value) || 24 } });
        });
      }

      // 立即备份
      const btnBackup = document.getElementById('sec-btn-backup');
      if (btnBackup) {
        btnBackup.addEventListener('click', () => this.createBackup());
      }

      // 数据安全开关
      this.bindSwitch('sec-delete-protection', 'data.deleteProtection');
      this.bindSwitch('sec-trash-enabled', 'data.trashEnabled');
      this.bindSwitch('sec-sensitive-detection', 'data.sensitiveDetection');
      this.bindSwitch('sec-sensitive-encrypt', 'data.sensitiveAutoEncrypt');

      // 纸篓自动清理天数
      const trashDays = document.getElementById('sec-trash-days');
      if (trashDays) {
        trashDays.addEventListener('change', async () => {
          await this.updateConfig({ data: { trashAutoClearDays: parseInt(trashDays.value) || 30 } });
        });
      }

      // 纸篓操作
      const btnTrashClear = document.getElementById('sec-btn-trash-clear');
      if (btnTrashClear) {
        btnTrashClear.addEventListener('click', () => this.clearTrash());
      }
      const btnTrashRefresh = document.getElementById('sec-btn-trash-refresh');
      if (btnTrashRefresh) {
        btnTrashRefresh.addEventListener('click', () => this.loadTrash());
      }

      // 敏感信息扫描测试
      const btnScan = document.getElementById('sec-btn-scan-test');
      if (btnScan) {
        btnScan.addEventListener('click', () => this.testSensitiveScan());
      }

      // 审计中心
      this.bindSwitch('sec-audit-enabled', 'audit.enabled');
      this.bindSwitch('sec-audit-file', 'audit.logFileOps');
      this.bindSwitch('sec-audit-command', 'audit.logCommandOps');
      this.bindSwitch('sec-audit-network', 'audit.logNetworkOps');

      const auditMax = document.getElementById('sec-audit-max');
      if (auditMax) {
        auditMax.addEventListener('change', async () => {
          await this.updateConfig({ audit: { maxLogs: parseInt(auditMax.value) || 10000 } });
        });
      }
      const auditDays = document.getElementById('sec-audit-days');
      if (auditDays) {
        auditDays.addEventListener('change', async () => {
          await this.updateConfig({ audit: { autoDeleteDays: parseInt(auditDays.value) || 90 } });
        });
      }

      // 审计操作
      const btnAuditExport = document.getElementById('sec-btn-audit-export');
      if (btnAuditExport) {
        btnAuditExport.addEventListener('click', () => this.exportAuditLogs());
      }
      const btnAuditClear = document.getElementById('sec-btn-audit-clear');
      if (btnAuditClear) {
        btnAuditClear.addEventListener('click', () => this.clearAuditLogs());
      }
      const btnAuditRefresh = document.getElementById('sec-btn-audit-refresh');
      if (btnAuditRefresh) {
        btnAuditRefresh.addEventListener('click', () => this.loadAuditLogs());
      }

      // 审计筛选
      const auditFilter = document.getElementById('sec-audit-filter');
      if (auditFilter) {
        auditFilter.addEventListener('change', () => this.loadAuditLogs());
      }
      const auditRisk = document.getElementById('sec-audit-risk');
      if (auditRisk) {
        auditRisk.addEventListener('change', () => this.loadAuditLogs());
      }

      // 帮助提示图标
      this.bindHelpIcons();
      
      // Tab 切换
      document.querySelectorAll('.sec-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          this.currentTab = tab.dataset.tab;
          document.querySelectorAll('.sec-tab').forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          document.querySelectorAll('.sec-panel').forEach(p => p.style.display = 'none');
          const panel = document.getElementById('sec-panel-' + this.currentTab);
          if (panel) panel.style.display = '';
          // 切换时加载对应数据
          if (this.currentTab === 'trash') this.loadTrash();
          if (this.currentTab === 'audit') this.loadAuditLogs();
          if (this.currentTab === 'backup') this.loadBackups();
        });
      });
    },

    bindSwitch(id, configPath) {
      const el = document.getElementById(id);
      if (!el) return;
      const [section, key] = configPath.split('.');
      if (this.config && this.config[section]) {
        el.checked = !!this.config[section][key];
      }
      el.addEventListener('change', async () => {
        const update = {};
        update[section] = {};
        update[section][key] = el.checked;
        await this.updateConfig(update);
      });
    },

    async updateConfig(partial) {
      try {
        this.config = await window.api.security.setConfig(partial);
        this.status = await window.api.security.getStatus();
        this.renderStatus();
        this.showToast('设置已保存');
      } catch (e) {
        console.error('[SecurityUI] 更新配置失败:', e);
        this.showToast('保存失败: ' + e.message, 'error');
      }
    },

    renderConfig() {
      if (!this.config) return;
      // 备份设置
      const backupSize = document.getElementById('sec-backup-size');
      if (backupSize) backupSize.value = this.config.sandbox.backupMaxSizeMB;
      const backupInterval = document.getElementById('sec-backup-interval');
      if (backupInterval) backupInterval.value = this.config.sandbox.backupIntervalHours;
      // 纸篓
      const trashDays = document.getElementById('sec-trash-days');
      if (trashDays) trashDays.value = this.config.data.trashAutoClearDays;
      // 审计
      const auditMax = document.getElementById('sec-audit-max');
      if (auditMax) auditMax.value = this.config.audit.maxLogs;
      const auditDays = document.getElementById('sec-audit-days');
      if (auditDays) auditDays.value = this.config.audit.autoDeleteDays;
    },

    renderStatus() {
      if (!this.status) return;
      // 概览统计
      const backupOverview = document.getElementById('sec-backup-count-overview');
      if (backupOverview) backupOverview.textContent = this.status.backupCount;
      const trashOverview = document.getElementById('sec-trash-count-overview');
      if (trashOverview) trashOverview.textContent = this.status.trashCount;
      const auditOverview = document.getElementById('sec-audit-count-overview');
      if (auditOverview) auditOverview.textContent = this.status.totalAuditLogs;
      // 安全状态文字
      const statusText = document.getElementById('sec-overview-status');
      if (statusText) {
        const allActive = this.status.secureGateway && this.status.transportEncryption && this.status.sandboxActive;
        statusText.textContent = allActive ? '运行中' : '部分关闭';
        statusText.style.color = allActive ? '#52c41a' : '#ffa502';
      }
      // 统计数字（面板内）
      const trashCount = document.getElementById('sec-trash-count');
      if (trashCount) trashCount.textContent = this.status.trashCount;
      const backupCount = document.getElementById('sec-backup-count');
      if (backupCount) backupCount.textContent = this.status.backupCount;
      const auditCount = document.getElementById('sec-audit-count');
      if (auditCount) auditCount.textContent = this.status.totalAuditLogs;
    },

    // ========== 备份 ==========
    async createBackup() {
      const btn = document.getElementById('sec-btn-backup');
      if (btn) { btn.disabled = true; btn.textContent = '备份中...'; }
      try {
        const result = await window.api.security.backupCreate();
        if (result.success) {
          this.showToast('备份成功: ' + result.sizeMB + ' MB');
          this.loadBackups();
          this.status = await window.api.security.getStatus();
          this.renderStatus();
        } else {
          this.showToast('备份失败: ' + result.error, 'error');
        }
      } catch (e) {
        this.showToast('备份异常: ' + e.message, 'error');
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '立即备份'; }
      }
    },

    async loadBackups() {
      try {
        const backups = await window.api.security.backupList();
        const container = document.getElementById('sec-backup-list');
        if (!container) return;
        if (backups.length === 0) {
          container.innerHTML = '<div class="sec-empty">暂无备份记录</div>';
          return;
        }
        container.innerHTML = backups.map(b => `
          <div class="sec-list-item">
            <div class="sec-item-info">
              <span class="sec-item-name">${b.name}</span>
              <span class="sec-item-meta">${b.sizeMB} MB · ${new Date(b.createdAt).toLocaleString('zh-CN')}</span>
            </div>
            <button class="sec-btn sec-btn-danger" onclick="SecurityUI.deleteBackup('${b.name}')">删除</button>
          </div>
        `).join('');
      } catch (e) {
        console.error('[SecurityUI] 加载备份失败:', e);
      }
    },

    async deleteBackup(name) {
      const ok = await window.AppDialog.confirm({
        type: 'warning',
        title: '删除备份',
        message: '确定删除此备份？',
        detail: name ? ('备份文件：' + name) : '',
        buttons: ['删除', '取消']
      });
      if (!ok) return;
      try {
        await window.api.security.backupDelete(name);
        this.showToast('备份已删除');
        this.loadBackups();
        this.status = await window.api.security.getStatus();
        this.renderStatus();
      } catch (e) {
        this.showToast('删除失败: ' + e.message, 'error');
      }
    },

    // ========== 纸篓 ==========
    async loadTrash() {
      try {
        const items = await window.api.security.trashList(null);
        const container = document.getElementById('sec-trash-list');
        if (!container) return;
        if (items.length === 0) {
          container.innerHTML = '<div class="sec-empty">纸篓为空</div>';
          return;
        }
        container.innerHTML = items.map(item => `
          <div class="sec-list-item">
            <div class="sec-item-info">
              <span class="sec-item-name">${this.escapeHtml(item.data.title || item.data.content?.substring(0, 50) || item.type + ' #' + item.originalId)}</span>
              <span class="sec-item-meta">${item.type} · 删除于 ${new Date(item.deletedAt).toLocaleString('zh-CN')} · ${item.expiresAt ? '过期: ' + new Date(item.expiresAt).toLocaleDateString('zh-CN') : ''}</span>
            </div>
            <div style="display:flex;gap:6px;">
              <button class="sec-btn sec-btn-primary" onclick="SecurityUI.restoreTrash('${item.id}')">恢复</button>
              <button class="sec-btn sec-btn-danger" onclick="SecurityUI.deleteTrash('${item.id}')">永久删除</button>
            </div>
          </div>
        `).join('');
      } catch (e) {
        console.error('[SecurityUI] 加载纸篓失败:', e);
      }
    },

    async restoreTrash(id) {
      try {
        const data = await window.api.security.trashRestore(id);
        if (data) {
          this.showToast('已恢复');
          this.loadTrash();
          this.status = await window.api.security.getStatus();
          this.renderStatus();
          // 触发对话列表刷新
          if (window.refreshConversations) window.refreshConversations();
        } else {
          this.showToast('恢复失败', 'error');
        }
      } catch (e) {
        this.showToast('恢复异常: ' + e.message, 'error');
      }
    },

    async deleteTrash(id) {
      const ok = await window.AppDialog.confirm({
        type: 'warning',
        title: '永久删除',
        message: '确定永久删除？此操作不可恢复。',
        buttons: ['永久删除', '取消']
      });
      if (!ok) return;
      try {
        await window.api.security.trashDelete(id);
        this.showToast('已永久删除');
        this.loadTrash();
        this.status = await window.api.security.getStatus();
        this.renderStatus();
      } catch (e) {
        this.showToast('删除失败: ' + e.message, 'error');
      }
    },

    async clearTrash() {
      const ok = await window.AppDialog.confirm({
        type: 'warning',
        title: '清空纸篓',
        message: '确定清空纸篓？所有内容将永久删除。',
        buttons: ['清空', '取消']
      });
      if (!ok) return;
      try {
        const count = await window.api.security.trashClear(null);
        this.showToast('已清空 ' + count + ' 项');
        this.loadTrash();
        this.status = await window.api.security.getStatus();
        this.renderStatus();
      } catch (e) {
        this.showToast('清空失败: ' + e.message, 'error');
      }
    },

    // ========== 敏感信息检测 ==========
    async testSensitiveScan() {
      const testText = `测试文本包含：
      - GitHub Token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456
      - 邮箱: test@example.com
      - 手机号: 13812345678
      - AWS Key: AKIAIOSFODNN7EXAMPLE
      - 密码: password = "mySecretPassword123"
      - IP地址: 192.168.1.1`;
      try {
        const findings = await window.api.security.scanSensitive(testText);
        const container = document.getElementById('sec-scan-result');
        if (!container) return;
        if (findings.length === 0) {
          container.innerHTML = '<div class="sec-empty">未检测到敏感信息</div>';
        } else {
          container.innerHTML = '<div class="sec-scan-header">检测到 ' + findings.length + ' 项敏感信息：</div>' +
            findings.map(f => `
              <div class="sec-scan-item">
                <span class="sec-scan-type sec-risk-${f.type === 'api_key' || f.type === 'secret_key' || f.type === 'private_key' || f.type === 'password' ? 'high' : 'medium'}">${f.name}</span>
                <span class="sec-scan-value">${this.escapeHtml(f.value)}</span>
              </div>
            `).join('');
        }
      } catch (e) {
        this.showToast('扫描失败: ' + e.message, 'error');
      }
    },

    // ========== 审计日志 ==========
    async loadAuditLogs() {
      try {
        const filterEl = document.getElementById('sec-audit-filter');
        const riskEl = document.getElementById('sec-audit-risk');
        const filters = {};
        if (filterEl && filterEl.value) filters.category = filterEl.value;
        if (riskEl && riskEl.value) filters.risk = riskEl.value;
        filters.limit = 200;

        const logs = await window.api.security.auditList(filters);
        const container = document.getElementById('sec-audit-content');
        if (!container) return;
        if (logs.length === 0) {
          container.innerHTML = '<div class="sec-empty">暂无审计日志</div>';
          return;
        }
        const categoryNames = { file: '文件', command: '命令', network: '网络', auth: '认证', config: '配置', data: '数据' };
        const riskColors = { low: 'sec-risk-low', medium: 'sec-risk-medium', high: 'sec-risk-high', critical: 'sec-risk-critical' };
        container.innerHTML = logs.map(log => `
          <div class="sec-audit-item">
            <span class="sec-audit-time">${new Date(log.timestamp).toLocaleString('zh-CN')}</span>
            <span class="sec-audit-cat">${categoryNames[log.category] || log.category}</span>
            <span class="sec-audit-risk ${riskColors[log.risk] || ''}">${log.risk}</span>
            <span class="sec-audit-action">${this.escapeHtml(log.action)}</span>
            <span class="sec-audit-detail">${this.escapeHtml(JSON.stringify(log.details).substring(0, 80))}</span>
          </div>
        `).join('');
      } catch (e) {
        console.error('[SecurityUI] 加载审计日志失败:', e);
      }
    },

    async exportAuditLogs() {
      try {
        const choice = await window.AppDialog.choose({
          type: 'info',
          title: '导出审计日志',
          message: '请选择导出格式。',
          buttons: ['导出 JSON', '导出 CSV', '取消']
        });
        // 点击「取消」或按 ESC（返回 -1）时直接关闭，不导出
        if (choice !== 0 && choice !== 1) return;
        const format = choice === 0 ? 'json' : 'csv';
        const data = await window.api.security.auditExport(format);
        const blob = new Blob([data], { type: format === 'json' ? 'application/json' : 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'audit-log-' + new Date().toISOString().replace(/[:.]/g, '-') + '.' + format;
        a.click();
        URL.revokeObjectURL(url);
        this.showToast('审计日志已导出');
      } catch (e) {
        this.showToast('导出失败: ' + e.message, 'error');
      }
    },

    async clearAuditLogs() {
      const ok = await window.AppDialog.confirm({
        type: 'warning',
        title: '清空审计日志',
        message: '确定清空所有审计日志？此操作不可恢复。',
        buttons: ['清空', '取消']
      });
      if (!ok) return;
      try {
        await window.api.security.auditClear({});
        this.showToast('审计日志已清空');
        this.loadAuditLogs();
        this.status = await window.api.security.getStatus();
        this.renderStatus();
      } catch (e) {
        this.showToast('清空失败: ' + e.message, 'error');
      }
    },

    // ========== 帮助提示 ==========
    helpContents: {
      'sandbox-env': {
        title: '运行环境防护',
        desc: '监控应用运行时的文件操作、命令执行和网络请求，防止恶意操作或误操作损害系统。开启后，危险操作会被拦截或提示确认。'
      },
      'auto-backup': {
        title: '自动备份',
        desc: '定期自动备份应用配置和对话数据，防止数据丢失。可设置备份最大占用空间和备份间隔时间，超出空间会自动清理旧备份。'
      },
      'trash-protect': {
        title: '删除保护（纸篓）',
        desc: '删除的对话和数据不会立即永久删除，而是先放入纸篓。可在纸篓中恢复或永久删除，超过设定天数会自动清理。无法进入系统回收站的内容也会先放到这里。'
      },
      'transport-sec': {
        title: '传输安全',
        desc: '安全网关和传输加密（AES-256）默认开启且不可关闭，确保所有数据传输都经过加密保护，防止数据在传输过程中被窃取或篡改。'
      },
      'sensitive-protect': {
        title: '敏感信息保护',
        desc: '自动检测对话和上传内容中的敏感信息（密码、密钥、账号、Token等），支持关键词、正则、熵值等多种检测方式。检测到后可自动加密存储，防止敏感信息泄露。'
      },
      'audit-setting': {
        title: '审计设置',
        desc: '记录应用的所有操作日志（文件操作、命令执行、网络请求等），可设置日志保留数量和自动删除天数。支持按分类和风险等级筛选，可导出为JSON或CSV格式。'
      }
    },
    
    bindHelpIcons() {
      const modal = document.getElementById('security-modal');
      if (!modal) return;
      const icons = modal.querySelectorAll('.sec-help-icon');
      icons.forEach(icon => {
        icon.addEventListener('click', (e) => {
          e.stopPropagation();
          const helpKey = icon.dataset.help;
          const help = this.helpContents[helpKey];
          if (!help) return;
          this.showHelpTooltip(icon, help);
        });
      });
      // 点击其他地方关闭提示
      document.addEventListener('click', () => {
        const existing = document.querySelector('.sec-help-tooltip');
        if (existing) existing.remove();
      });
    },
    
    showHelpTooltip(anchor, help) {
      // 移除已存在的提示
      const existing = document.querySelector('.sec-help-tooltip');
      if (existing) existing.remove();
      
      const tooltip = document.createElement('div');
      tooltip.className = 'sec-help-tooltip';
      tooltip.innerHTML = '<h4>' + this.escapeHtml(help.title) + '</h4><p>' + this.escapeHtml(help.desc) + '</p>';
      document.body.appendChild(tooltip);
      
      // 定位到图标下方
      const rect = anchor.getBoundingClientRect();
      tooltip.style.left = rect.left + 'px';
      tooltip.style.top = (rect.bottom + 8) + 'px';
      
      // 防止点击提示时关闭
      tooltip.addEventListener('click', (e) => e.stopPropagation());
    },

    // ========== 工具 ==========
    escapeHtml(str) {
      if (!str) return '';
      return String(str).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    },

    showToast(message, type = 'success') {
      // 简单的 toast 提示
      const existing = document.getElementById('sec-toast');
      if (existing) existing.remove();
      const toast = document.createElement('div');
      toast.id = 'sec-toast';
      toast.className = 'sec-toast sec-toast-' + type;
      toast.textContent = message;
      document.body.appendChild(toast);
      setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 2500);
    }
  };

  // 暴露到全局
  window.SecurityUI = SecurityUI;

  // 页面加载完成后绑定弹窗按钮事件
  function bindModalTriggers() {
    const btn = document.getElementById('btn-open-security-center');
    if (btn) {
      btn.addEventListener('click', () => SecurityUI.openModal());
    }
    const closeBtn = document.getElementById('security-modal-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => SecurityUI.closeModal());
    }
    const overlay = document.getElementById('security-modal-overlay');
    if (overlay) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) SecurityUI.closeModal();
      });
    }
    // ESC 键关闭
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const ov = document.getElementById('security-modal-overlay');
        if (ov && ov.style.display !== 'none') SecurityUI.closeModal();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindModalTriggers);
  } else {
    bindModalTriggers();
  }
})();
