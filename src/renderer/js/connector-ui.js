/**
 * 连通器管理前端模块
 * ============================================================
 * 入口：聊天页顶部工具栏的「连通器」按钮（与「安全中心」按钮并列）。
 *
 * 页面结构（用户要求：连接页只展示所选连通器的详情，其他靠返回查看）：
 *   弹窗 = 标题栏（可返回）+ 内容区
 *   ·列表页：全部连通器（曲别针图标 + 名称），点任一 → 详情页
 *   · 详情页：**只显示这一个连通器**，顶部有返回按钮 → 回列表页
 *
 * 授权方式（用户要求：一律跳浏览器，不在应用里粘密钥）：
 *   ·去授权 → 打开浏览器官方授权页
 *   · oauth 流程由本地回调自动收到授权码，用户什么都不用填
 *   · console 流程（该服务无标准 OAuth 端点）才需要填一次凭证，
 *     且会在页面上写清原因
 *
 * 三条硬约束（对应主进程的安全设计）：
 *   1. 凭证只往主进程送，**不写 localStorage**
 *   2. 跳转 URL 一律来自主进程下发的配置值，前端不接受任何外部传入链接
 *   3. 列表/详情图标优先用各家官方品牌字形（brand-icons.js，按 brandColor 着色），
 *      无官方字形的（builtin-web）才回退到回形针；连接状态靠「已连接」徽标表达。
 */
(function () {
  'use strict';

  const CATEGORY_LABEL = {
    dev: '开发协作',
    'office-cn': '办公协作（国内）',
    'office-global': '办公协作（海外）',
    search: '搜索与采集',
    storage: '云盘与存储',
    builtin: '内置能力',
    other: '其他'
  };

  /**
   * 链条链接图标（link-2）—— 两个交扣的链环，纯线条勾勒。
   *
   * ⚠️ **style="fill:none" 不能省**：
   *   全局 CSS 有 `.el-icon svg { fill: currentColor; }`，优先级高于 SVG 呈现属性，
   *   不写内联 style 线条会被填实成黑疙瘩。
   */
  function paperclipSvg(color) {
    return '<svg viewBox="0 0 24 24" fill="none" style="fill:none" stroke="' + color + '" '
      + 'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>'
      + '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'
      + '</svg>';
  }

  // 状态色：已连接给品牌绿，待授权用中性灰（靠透明度区分层次），内置能力更淡
  function colorOf(c) {
    if (c.connected) return '#4caf50';
    if (c.authFlow === 'none') return 'var(--text-muted, #888)';
    return c.brandColor || 'var(--text-secondary, #999)';
  }

  // 连通器品牌图标：优先用各家官方品牌字形（brand-icons.js），
  // 没有官方字形的（builtin-web 等）回退到回形针占位。
  function iconFor(c) {
    if (window.BrandIcons) {
      const svg = window.BrandIcons.brandIcon(c);
      if (svg) return svg;
    }
    return paperclipSvg(colorOf(c));
  }

  const ConnectorUI = {
    list: [],
    currentId: '',
    _loaded: false,
    _unsub: null,

    /** 打开弹窗 */
    async open() {
      const overlay = document.getElementById('conn-modal-overlay');
      if (!overlay) return;
      overlay.style.display = 'flex';
      await this.load(true);
      // 默认回列表页：用户要先看到"有哪些能连"
      this.showList();
    },

    close() {
      const overlay = document.getElementById('conn-modal-overlay');
      if (overlay) overlay.style.display = 'none';
      this.currentId = '';
    },

    async load(force) {
      if (this._loaded && !force) return this.list;
      try {
        this.list = (await window.api.connector.list()) || [];
        this._loaded = true;
        this._listenOnce();
      } catch (e) {
        console.error('[ConnectorUI] 加载失败:', e);
        this._loaded = true;
        this.list = [];
        this.setBody('<div class="sec-conn-empty">连通器加载失败<br><span style="opacity:.7">' + this._esc(e.message || e) + '</span></div>');
      }
      return this.list;
    },

    /** OAuth 回调发生在主进程，这里接收通知 */
    _listenOnce() {
      if (this._unsub) return;
      this._unsub = window.api.connector.onEvent(async (payload) => {
        if (!payload || !payload.connectorId) return;
        await this.load(true);
        if (payload.type === 'oauth-code') {
          const res = await window.api.connector.saveCredential(payload.connectorId, payload.code);
          if (res && res.success) {
            this.toast('「' + this.nameOf(payload.connectorId) + '」授权成功', true);
            this.openDetail(payload.connectorId);
          } else {
            this.showError((res && res.error) || '保存授权码失败');
          }
        } else if (payload.type === 'oauth-failed') {
          this.showError(payload.error || '授权未完成');
        }
      });
    },

    nameOf(id) {
      const c = this.list.find(x => x.id === id);
      return c ? c.name : id;
    },

    setBody(html) {
      const body = document.getElementById('conn-modal-body');
      if (body) body.innerHTML = html;
      return body;
    },

    /** 标题栏：详情页显示返回按钮，列表页不显示 */
    setHeader(title, canBack) {
      const t = document.getElementById('conn-modal-title');
      if (t) t.textContent = title;
      const back = document.getElementById('conn-back-btn');
      if (back) back.style.display = canBack ? 'inline-flex' : 'none';
    },

    // ── 列表页 ────────────────────────────────────────────────────────────
    showList() {
      this.currentId = '';
      this.setHeader('连通器', false);

      if (!this.list.length) {
        this.setBody('<div class="sec-conn-empty">没有可用连通器<br><span style="opacity:.7">connectors.yaml 未加载或为空</span></div>');
        return;
      }

      const groups = new Map();
      for (const c of this.list) {
        const k = c.category || 'other';
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(c);
      }

      let html = '<div class="conn-picker">';
      for (const [cat, items] of groups) {
        html += '<div class="conn-picker-cat">' + this._esc(CATEGORY_LABEL[cat] || cat) + '</div>';
        for (const c of items) {
          html += '<div class="conn-pick-row' + (c.connected ? ' connected' : '') + (c.disabled ? ' disabled' : '') + '" data-pick="' + this._esc(c.id) + '" '
            + 'role="button" tabindex="0">'
            + '<div class="conn-pick-ico">' + iconFor(c) + '</div>'
            + '<div class="conn-pick-info">'
            + '<div class="conn-pick-name">' + this._esc(c.name)
            + (c.connected ? '<span class="conn-pick-badge ok">已连接</span>' : '')
            + (c.disabled ? '<span class="conn-pick-badge off">暂不可用</span>' : '')
            + '</div>'
            + '<div class="conn-pick-desc">' + this._esc(c.description) + '</div>'
            + '</div>'
            + '<div class="conn-pick-go"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="var(--text-muted, #888)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></div>'
            + '</div>';
        }
      }
      html += '</div>';
      const body = this.setBody(html);
      body.onclick = (e) => {
        const row = e.target.closest('[data-pick]');
        if (row) this.openDetail(row.getAttribute('data-pick'));
      };
      body.onkeydown = (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const row = e.target.closest('[data-pick]');
        if (row) { e.preventDefault(); this.openDetail(row.getAttribute('data-pick')); }
      };
    },

    // ── 详情页：只展示这一个连通器 ────────────────────────────────────────
    openDetail(id) {
      const c = this.list.find(x => x.id === id);
      if (!c) { this.toast('未找到该连通器', false); return; }
      this.currentId = id;
      this.setHeader(c.name, true);           // ← 详情页才有返回按钮

      const scopeTags = (c.scopes || []).map(s => '<span class="conn-auth-scope-tag">' + this._esc(s) + '</span>').join('');

      // ── 操作区：一律跳浏览器授权 ──
      let actions = '';
      let inputHtml = '<div class="conn-auth-err" id="conn-auth-err"></div>';

      if (c.disabled) {
        // 暂不可用：无授权按钮、无输入框，只显示说明
        actions = '';
      } else if (c.authFlow === 'none') {
        // 内置能力（含 kind:mcp 的 Windows MCP）：根据当前启用状态显示明显的开关
        if (c.connected) {
          actions = '<button class="btn btn-sm conn-toggle-on" data-act="enable" data-on="0">已启用</button>';
        } else {
          actions = '<button class="btn btn-primary btn-sm" data-act="enable" data-on="1">已禁用</button>';
        }
      } else {
        // OAuth 平台：填了 client_id（内置或用户自填）就能浏览器授权 → 显示授权按钮；
        // console 平台：不显示授权按钮，只填 token。
        if (c.authFlow === 'oauth' && (c.clientIdFilled)) {
          actions = '<button class="btn btn-primary btn-sm" data-act="authorize">'
            + '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px;">'
            + '<path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>'
            + '去授权（跳转浏览器）</button>';
        }
        if (c.connected) {
          actions += '<button class="btn btn-default btn-sm" data-act="disconnect">断开连接</button>';
        }

        // 填凭证的输入框 —— 始终显示，已填值回填，可随时修改。
        let extra = '';
        if (c.needsClientIdInput) {
          const ph = c.id === 'feishu' ? '飞书自建应用 App ID，形如 cli_xxxxxxxx'
            : c.id === 'wecom' ? '企业微信 CorpID，形如 ww_xxxxxxxx'
            : '在开放平台创建应用后获取的 client_id';
          extra += '<div class="conn-auth-label">App ID / client_id</div>'
            + '<input class="conn-auth-input" id="conn-clientid-input" type="text" autocomplete="off" spellcheck="false" '
            + 'value="' + this._esc(c.clientIdValue || '') + '" placeholder="' + this._esc(ph) + '">'
            + '<button class="btn btn-default btn-sm" data-act="save-client-id">保存 App ID</button>';
        }
        if (c.needsAppSecretInput) {
          extra += '<div class="conn-auth-label">App Secret</div>'
            + '<input class="conn-auth-input" id="conn-appsecret-input" type="password" autocomplete="off" spellcheck="false" '
            + 'placeholder="' + (c.appSecretSet ? '已保存，可输入新值覆盖' : '在开放平台「凭证与基础信息」点显示后复制') + '">'
            + '<button class="btn btn-default btn-sm" data-act="save-app-secret">保存 App Secret</button>';
        }
        // 只有 console 流程才需要填访问凭证（该服务没有标准 OAuth 端点）
        if (c.needsCredentialInput && !c.connected) {
          extra += '<div class="conn-auth-label">访问凭证</div>'
            + '<input class="conn-auth-input" id="conn-token-input" type="password" autocomplete="off" spellcheck="false" '
            + 'placeholder="在官方控制台开通后，把凭证粘贴到这里">'
            + '<button class="btn btn-default btn-sm" data-act="save">保存凭证</button>';
        }
        if (extra) inputHtml = extra + '<div class="conn-auth-err" id="conn-auth-err"></div>';
      }

      this.setBody(
        '<div class="conn-auth">'
        + '<div class="conn-auth-top">'
        + '<div class="conn-auth-clip">' + iconFor(c) + '</div>'
        + '<div class="conn-auth-titles">'
        + '<div class="conn-auth-name">' + this._esc(c.name)
        + (c.connected ? '<span class="conn-pick-badge ok">已连接</span>' : '')
        + '</div>'
        + '<div class="conn-auth-official">' + this._esc(c.officialName) + '</div>'
        + '</div>'
        + '</div>'
        + '<div class="conn-auth-desc">' + this._esc(c.description) + '</div>'
        + (c.connected && c.credentialHint
          ? '<div class="conn-auth-tip">当前凭证：<span style="font-family:ui-monospace,Consolas,monospace">' + this._esc(c.credentialHint) + '</span></div>'
          : '')
        + (c.note ? '<div class="conn-auth-note">' + this._esc(c.note) + '</div>' : '')
        + (scopeTags ? '<div class="conn-auth-label">授权范围</div><div class="conn-auth-scope">' + scopeTags + '</div>' : '')
        + inputHtml
        + '<div class="conn-auth-actions">' + actions + '</div>'
        + (c.docsUrl ? '<div class="conn-auth-tip">官方文档：<span class="conn-link" data-act="docs">打开</span></div>' : '')
        + '</div>'
      );

      const body = document.getElementById('conn-modal-body');
      body.onclick = (e) => {
        const btn = e.target.closest('[data-act]');
        if (btn) this.handleAction(btn.getAttribute('data-act'), c, btn);
      };
      const input = document.getElementById('conn-token-input');
      if (input) {
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') this.handleAction('save', c);
        });
      }
      const cidInput = document.getElementById('conn-clientid-input');
      if (cidInput) {
        cidInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') this.handleAction('save-client-id', c);
        });
      }
    },

    async handleAction(act, c, btn) {
      const setErr = (m) => this.showError(m || '');
      setErr('');

      try {
        if (act === 'enable') {
        // data-on="1" → 启用；data-on="0" → 停用
        const wantOn = btn ? btn.getAttribute('data-on') === '1' : true;
        setErr(wantOn ? '正在启用…' : '正在停用…');
        const res = await window.api.connector.setEnabled(c.id, wantOn);
        if (!res || !res.success) {
          setErr((res && res.error) || '操作失败');
          return;
        }
        await this.load(true);
        this.toast(wantOn ? '「' + c.name + '」已启用' : '「' + c.name + '」已停用', true);
        this.openDetail(c.id);
        return;
      }

        if (act === 'authorize') {
          setErr('正在打开浏览器…');
          const res = await window.api.connector.authorize(c.id);
          if (!res || !res.success) {
            setErr((res && res.error) || '发起授权失败');
            return;
          }
          if (res.needsCredentialInput) {
            setErr(res.message || '已打开官方控制台，开通后在下方填入凭证');
          } else if (res.needsClientId) {
            setErr('已打开浏览器。完成授权后会自动回调本应用；若官方页面提示缺少 client_id，需先在开放平台申请应用后填入 connectors.yaml。');
          } else {
            setErr('已打开浏览器授权页，完成后会自动回调（本地回调等待 5 分钟）。');
          }
          return;   // 不关弹窗：用户授权完还要回到这里看结果
        }

        if (act === 'save') {
          const input = document.getElementById('conn-token-input');
          const token = input ? input.value : '';
          if (!token.trim()) { setErr('请先填入凭证'); return; }
          setErr('校验中…');
          const res = await window.api.connector.saveCredential(c.id, token);
          if (!res || !res.success) {
            setErr((res && res.error) || '保存失败（凭证校验未通过）');
            return;
          }
          if (input) input.value = '';
          await this.load(true);
          this.toast('「' + c.name + '」已连接（凭证校验通过）', true);
          this.showList();
          return;
        }

        if (act === 'save-client-id') {
          const input = document.getElementById('conn-clientid-input');
          const clientId = input ? input.value : '';
          if (!clientId.trim()) { setErr('请先填入 App ID'); return; }
          setErr('保存中…');
          const res = await window.api.connector.setClientId(c.id, clientId.trim());
          if (!res || !res.success) {
            setErr((res && res.error) || '保存失败');
            return;
          }
          await this.load(true);
          this.toast('App ID 已保存，现在可以点「去授权」', true);
          this.openDetail(c.id);
          return;
        }

        if (act === 'save-app-secret') {
          const input = document.getElementById('conn-appsecret-input');
          const secret = input ? input.value : '';
          if (!secret.trim()) { setErr('请先填入 App Secret'); return; }
          setErr('校验中…');
          const res = await window.api.connector.setAppSecret(c.id, secret.trim());
          if (!res || !res.success) {
            setErr((res && res.error) || '保存失败（凭证校验未通过）');
            return;
          }
          const v = document.getElementById('conn-appsecret-input');
          if (v) v.value = '';
          await this.load(true);
          this.toast(res.verified ? '凭证校验通过，可以授权了' : 'App Secret 已保存（该平台需授权时验证）', true);
          this.openDetail(c.id);
          return;
        }

        if (act === 'disconnect') {
          const res = await window.api.connector.disconnect(c.id);
          if (!res || !res.success) {
            setErr((res && res.error) || '断开失败');
            return;
          }
          await this.load(true);
          this.toast('「' + c.name + '」已断开', true);
          this.showList();
          return;
        }

        if (act === 'docs' && c.docsUrl) {
          await window.api.openExternal(c.docsUrl);
        }
      } catch (e) {
        setErr('操作失败：' + (e && e.message ? e.message : e));
      }
    },

    showError(msg) {
      const el = document.getElementById('conn-auth-err');
      if (el) el.textContent = msg;
    },

    toast(msg, ok) {
      try {
        let el = document.getElementById('conn-ui-toast');
        if (!el) {
          el = document.createElement('div');
          el.id = 'conn-ui-toast';
          el.style.cssText = 'position:fixed;left:50%;bottom:40px;transform:translateX(-50%);'
            + 'padding:9px 18px;border-radius:8px;font-size:13px;z-index:10002;'
            + 'pointer-events:none;transition:opacity .2s;max-width:70vw;text-align:center;';
          document.body.appendChild(el);
        }
        el.textContent = msg;
        el.style.background = ok ? 'rgba(76,175,80,.95)' : 'rgba(239,83,80,.95)';
        el.style.color = '#fff';
        el.style.opacity = '1';
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 2400);
      } catch (e) { /* toast 失败不该影响主流程 */ }
    },

    _esc(s) {
      return String(s === undefined || s === null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },

    initOnce() {
      if (this._inited) return;
      this._inited = true;

      const topBtn = document.getElementById('btn-open-connectors');
      if (topBtn) topBtn.addEventListener('click', () => this.open());

      const close = document.getElementById('conn-modal-close');
      if (close) close.addEventListener('click', () => this.close());
      // 返回按钮：详情页 → 列表页
      const back = document.getElementById('conn-back-btn');
      if (back) back.addEventListener('click', () => this.showList());

      // 注意：**不**绑定"点遮罩空白处关闭"——用户反馈点空白会误关弹窗，
      //       关闭只走右上角 × 或 ESC（详情页 ESC 先回列表）。
      document.addEventListener('keydown', (e) => {
        const ov = document.getElementById('conn-modal-overlay');
        if (ov && ov.style.display === 'none') return;
        if (e.key === 'Escape') {
          // 详情页按 ESC 先回列表，再按才关弹窗 —— 符合"其他靠返回查看"的层级直觉
          if (this.currentId) this.showList();
          else this.close();
        }
      });
    }
  };

  window.ConnectorUI = ConnectorUI;
  document.addEventListener('DOMContentLoaded', () => ConnectorUI.initOnce());
})();