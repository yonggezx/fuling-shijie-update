/**
 * 智能商城前端模块（本地，无服务器）
 * ============================================================
 * 入口：聊天页顶部工具栏的「智能商城」按钮（与「连通器」「安全中心」并列）。
 *
 * 形态参考：ModelScope 智能工坊（卡片式分类商城，点击下载并启用）。
 * 三类条目：技能（能力包）/ MCP / 智能体。
 *
 * 图标规则：**一律用条目真实来源图标**，不自己编造——
 *   · 技能/MCP：用来源的真实 logo（url 图片，加载失败才回退到中性类型图标）
 *   · 智能体：用角色本身的 emoji（与 roles.yaml 预设角色一致）
 *
 * 交互：
 *   · 顶部 Tab：全部 / 技能 / MCP / 智能体；搜索框过滤
 *   · 卡片：未安装 →「下载并启用」；已安装 →「启用/停用」+「卸载」
 *   · 导入：本地文件（zip/SKILL.md/yaml/json 清单）或 URL
 * 安全：所有动作走主进程 IPC，前端不直接触碰文件系统；下载一律主进程 https。
 */
(function () {
  'use strict';

  const TYPE_LABEL = { skill: '技能', mcp: 'MCP', agent: '智能体' };
  const CAT_LABEL = {
    office: '办公', dev: '开发', work: '工作', life: '生活',
    search: '搜索', storage: '存储', other: '其他',
    media: '媒体/AIGC', finance: '金融', research: '研究', design: '设计',
    marketing: '营销', sales: '销售', product: '产品', education: '教育', creative: '创作'
  };

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 中性类型图标：仅当条目没有真实图标 / 真实图标加载失败时兜底，不代替真实来源图标
  function typeGlyph(type) {
    const common = 'width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
    if (type === 'mcp') {
      return '<svg ' + common + '><path d="M12 3v4"/><path d="M6.5 11h11"/><path d="M4 15h16"/><rect x="6" y="3" width="12" height="4" rx="1"/></svg>';
    }
    if (type === 'agent') {
      return '<svg ' + common + '><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
    }
    // skill
    return '<svg ' + common + '><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>';
  }

  // 条目图标 HTML：真实来源图标优先（url 图片 / emoji），缺失或加载失败才用类型图标
  function iconHtml(it) {
    const ic = it.icon;
    const type = it.type || 'skill';
    if (ic && ic.kind === 'url' && ic.url) {
      return '<img class="market-card-ico-img" src="' + esc(ic.url) + '" loading="lazy" alt="" '
        + 'onerror="window.__mktFallback&&window.__mktFallback(this,\'' + esc(type) + '\')">';
    }
    if (ic && ic.kind === 'emoji' && ic.value) {
      return '<span class="market-card-ico-text">' + esc(ic.value) + '</span>';
    }
    return typeGlyph(type);
  }
  // 真实图标（远程头像/logo）加载失败时：替换为中性类型图标
  window.__mktFallback = function (img, type) {
    try {
      const box = img.closest('.market-card-ico');
      if (box) box.innerHTML = typeGlyph(type);
    } catch (e) { /* 忽略 */ }
  };

  // 自包含样式（注入一次）
  // 毛玻璃（glassmorphism）：参照魔搭社区（ModelScope）智能工坊的轻透玻璃质感。
  // 全部引用 style.css 的玻璃变量组（--glass-*），随深浅主题自动切换（参考连通器）。
  const CSS = `
  .market-overlay{position:fixed;inset:0;background:var(--glass-overlay-bg);backdrop-filter:blur(var(--glass-overlay-blur)) saturate(130%);display:flex;align-items:center;justify-content:center;z-index:9990;}
  .market-modal{width:860px;height:640px;max-width:96vw;max-height:92vh;background:var(--glass-panel-bg);backdrop-filter:blur(var(--glass-panel-blur)) saturate(170%);border:1px solid var(--glass-panel-border);border-radius:16px;display:flex;flex-direction:column;overflow:hidden;box-shadow:var(--glass-panel-shadow);color:var(--glass-text);}
  .market-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--glass-head-border);flex:none;}
  .market-head-title{font-size:16px;font-weight:600;text-shadow:var(--glass-title-shadow);}
  .market-tabs{display:flex;gap:6px;padding:10px 18px 0;flex-wrap:wrap;flex:none;}
  .market-tab{padding:6px 14px;border-radius:8px;background:var(--glass-surface);border:1px solid var(--glass-surface-border);color:var(--glass-muted);cursor:pointer;font-size:13px;transition:all .15s;}
  .market-tab:hover{background:var(--glass-surface-hover);}
  .market-tab.active{background:linear-gradient(135deg,#5b7cfa,#8b5cf6);border-color:transparent;color:#fff;box-shadow:0 4px 14px rgba(91,124,250,.4);}
  .market-toolbar{display:flex;align-items:center;gap:8px;padding:10px 18px;flex-wrap:wrap;flex:none;}
  .market-cat select{background:var(--glass-input-bg);border:1px solid var(--glass-input-border);color:var(--glass-text);border-radius:8px;padding:7px 10px;font-size:13px;outline:none;}
  .market-cat select option{background:var(--bg-secondary);color:var(--glass-text);}
  .market-search{flex:1;min-width:160px;}
  .market-search input{width:100%;background:var(--glass-input-bg);border:1px solid var(--glass-input-border);color:var(--glass-text);border-radius:8px;padding:7px 10px;font-size:13px;}
  .market-search input::placeholder{color:var(--glass-muted);}
  .market-actions{display:flex;gap:8px;}
  .market-body{flex:1;overflow:auto;padding:6px 18px 18px;}
  .market-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(215px,1fr));gap:12px;}
  .market-card{background:var(--glass-surface);border:1px solid var(--glass-surface-border);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:8px;transition:border-color .15s,background .15s,transform .15s;box-shadow:var(--glass-card-shadow);}
  .market-card:hover{border-color:rgba(130,155,255,.7);background:var(--glass-surface-hover);transform:translateY(-1px);}
  .market-card-top{display:flex;align-items:flex-start;gap:10px;}
  .market-card-ico{width:40px;height:40px;border-radius:10px;background:var(--glass-ico-bg);display:flex;align-items:center;justify-content:center;font-size:20px;flex:none;overflow:hidden;box-shadow:inset 0 1px 0 rgba(255,255,255,.18);}
  .market-card-ico-img{width:100%;height:100%;object-fit:cover;display:block;}
  .market-card-ico-text{line-height:1;}
  .market-card-info{flex:1;min-width:0;}
  .market-card-name{font-weight:600;font-size:14px;line-height:1.3;word-break:break-all;}
  .market-card-meta{display:flex;gap:6px;margin-top:4px;flex-wrap:wrap;}
  .market-badge{font-size:11px;padding:1px 7px;border-radius:10px;background:var(--glass-surface);color:var(--glass-muted);}
  .market-badge.type{background:var(--badge-type-bg);color:var(--badge-type-fg);}
  .market-badge.ok{background:var(--badge-ok-bg);color:var(--badge-ok-fg);}
  .market-badge.off{background:var(--badge-off-bg);color:var(--badge-off-fg);}
  .market-badge.auth{background:var(--badge-auth-bg);color:var(--badge-auth-fg);}
  .market-badge.hosted{background:var(--badge-hosted-bg);color:var(--badge-hosted-fg);}
  .market-card-desc{font-size:12px;color:var(--glass-muted);line-height:1.5;min-height:34px;overflow:hidden;}
  .market-card-actions{display:flex;gap:8px;margin-top:auto;}
  .market-card-actions .btn{flex:1;justify-content:center;}
  .market-btn-primary{background:linear-gradient(135deg,#5b7cfa,#8b5cf6);border:1px solid transparent;color:#fff;box-shadow:0 4px 12px rgba(91,124,250,.35);}
  .market-btn-ghost{background:var(--glass-surface);border:1px solid var(--glass-surface-border);color:var(--glass-muted);}
  .market-empty{text-align:center;color:var(--glass-muted);padding:40px 0;font-size:13px;}
  .market-pager{display:flex;align-items:center;justify-content:center;gap:12px;padding:14px 0 4px;flex:none;}
  .market-pager .btn[disabled]{opacity:.4;cursor:not-allowed;pointer-events:none;}
  .market-pager-info{font-size:12px;color:var(--glass-muted);}
  .market-url-input-overlay{position:fixed;inset:0;background:var(--glass-overlay-bg);backdrop-filter:blur(var(--glass-overlay-blur)) saturate(130%);display:flex;align-items:center;justify-content:center;z-index:9995;}
  .market-url-input-box{background:var(--glass-panel-bg);backdrop-filter:blur(var(--glass-panel-blur)) saturate(160%);border:1px solid var(--glass-panel-border);border-radius:14px;padding:18px;width:460px;max-width:92vw;display:flex;flex-direction:column;gap:12px;color:var(--glass-text);box-shadow:var(--glass-panel-shadow);}
  .market-url-input-box input{background:var(--glass-input-bg);border:1px solid var(--glass-input-border);color:var(--glass-text);border-radius:8px;padding:9px 11px;font-size:13px;}
  .market-url-actions{display:flex;gap:8px;justify-content:flex-end;}
  /* 配置弹窗字段（颜色全部变量化，随主题） */
  .market-req{color:var(--badge-req-fg);}
  .market-field-label{font-size:12px;color:var(--label-fg);}
  .market-config-input{background:var(--glass-input-bg);border:1px solid var(--glass-input-border);color:var(--glass-text);}
  .market-link{color:var(--link-fg);}
  .market-config-hint{font-size:12px;color:var(--hint-fg);line-height:1.6;}
  .market-config-secure{font-size:11px;color:var(--secure-fg);}
  `;

  const MarketplaceUI = {
    list: [],
    filter: 'all',   // all | skill | mcp | agent
    cat: 'all',      // 分类筛选
    keyword: '',
    _inited: false,
    _loaded: false,
    _busy: new Set(),
    // 分页渲染：避免一次性渲染上千张卡片导致卡顿
    PAGE_SIZE: 60,
    _page: 1,
    _catDirty: true,
    _searchTimer: null,

    open() {
      const overlay = document.getElementById('market-overlay');
      if (overlay) overlay.style.display = 'flex';
      this.load(false);
    },
    close() {
      const overlay = document.getElementById('market-overlay');
      if (overlay) overlay.style.display = 'none';
    },

    async load(force) {
      const body = document.getElementById('market-body');
      if (!this._loaded || force) {
        body.innerHTML = '<div class="sec-conn-empty">加载中…</div>';
        try {
          this.list = (await window.api.marketplace.list()) || [];
          this._loaded = true;
          this._page = 1;
          this._catDirty = true;
        } catch (e) {
          console.error('[Marketplace] 加载失败:', e);
          this._loaded = true;
          this.list = [];
          body.innerHTML = '<div class="market-empty">商城加载失败<br><span style="opacity:.7">' + esc(e.message || e) + '</span></div>';
          return;
        }
      }
      this.render();
    },

    render() {
      this.renderTabs();
      const body = document.getElementById('market-body');
      const kw = this.keyword.trim().toLowerCase();
      const filtered = this.list.filter(i => {
        if (this.filter === 'installed') {
          if (!i.installed) return false;
        } else if (this.filter !== 'all' && i.type !== this.filter) return false;
        if (this.cat !== 'all' && i.category !== this.cat) return false;
        if (kw) {
          const hay = (i.name + ' ' + (i.description || '') + ' ' + i.id).toLowerCase();
          if (!hay.includes(kw)) return false;
        }
        return true;
      });
      // 分类下拉仅在来源可能变化时重建（Tab/刷新），避免每次渲染全量遍历
      if (this._catDirty) {
        this.renderCatOptions(this.list.filter(i => {
          if (this.filter === 'installed') return i.installed;
          return this.filter === 'all' || i.type === this.filter;
        }));
        this._catDirty = false;
      }
      if (!filtered.length) {
        body.innerHTML = this.filter === 'installed'
          ? '<div class="market-empty">还没有已安装的条目<br><span style="opacity:.7">切到「全部」Tab 逛逛，点「下载并启用」即可安装</span></div>'
          : '<div class="market-empty">没有匹配的条目。</div>';
        return;
      }
      // 分页渲染
      const total = filtered.length;
      const pages = Math.max(1, Math.ceil(total / this.PAGE_SIZE));
      if (this._page > pages) this._page = pages;
      const start = (this._page - 1) * this.PAGE_SIZE;
      const pageItems = filtered.slice(start, start + this.PAGE_SIZE);
      let html = '<div class="market-grid">';
      for (const it of pageItems) {
        html += this.cardHtml(it);
      }
      html += '</div>';
      html += '<div class="market-pager">'
        + '<button class="btn btn-sm market-btn-ghost" data-pager="prev"' + (this._page <= 1 ? ' disabled' : '') + '>‹ 上一页</button>'
        + '<span class="market-pager-info">第 ' + this._page + ' / ' + pages + ' 页 · 共 ' + total + ' 条</span>'
        + '<button class="btn btn-sm market-btn-ghost" data-pager="next"' + (this._page >= pages ? ' disabled' : '') + '>下一页 ›</button>'
        + '</div>';
      body.innerHTML = html;
    },

    cardHtml(it) {
      const enabled = it.type === 'mcp' ? !!it.mcpEnabled : it.enabled;
      const stateTxt = it.installed ? (enabled ? '已启用' : '已停用') : '未安装';
      const stateCls = it.installed ? (enabled ? 'ok' : 'off') : '';
      const needsAuth = !!(it.auth && it.auth.fields && it.auth.fields.length);
      let actions = '';
      if (it.hosted) {
        actions = '<button class="btn btn-sm market-btn-ghost" data-act="info" data-id="' + esc(it.id) + '">查看说明</button>';
      } else if (needsAuth) {
        if (!it.installed) {
          actions = '<button class="btn btn-sm market-btn-primary" data-act="config" data-id="' + esc(it.id) + '">配置并激活</button>';
        } else if (enabled) {
          actions = '<button class="btn btn-sm market-btn-ghost" data-act="config" data-id="' + esc(it.id) + '">配置密钥</button>'
            + '<button class="btn btn-sm market-btn-ghost" data-act="uninstall" data-id="' + esc(it.id) + '">卸载</button>';
        } else {
          actions = '<button class="btn btn-sm market-btn-primary" data-act="config" data-id="' + esc(it.id) + '">配置并启用</button>'
            + '<button class="btn btn-sm market-btn-ghost" data-act="uninstall" data-id="' + esc(it.id) + '">卸载</button>';
        }
      } else if (!it.installed) {
        actions = '<button class="btn btn-sm market-btn-primary" data-act="install" data-id="' + esc(it.id) + '">下载并启用</button>';
      } else if (enabled) {
        actions = '<button class="btn btn-sm market-btn-ghost" data-act="disable" data-id="' + esc(it.id) + '">停用</button>'
          + '<button class="btn btn-sm market-btn-ghost" data-act="uninstall" data-id="' + esc(it.id) + '">卸载</button>';
      } else {
        actions = '<button class="btn btn-sm market-btn-primary" data-act="enable" data-id="' + esc(it.id) + '">启用</button>'
          + '<button class="btn btn-sm market-btn-ghost" data-act="uninstall" data-id="' + esc(it.id) + '">卸载</button>';
      }
      return '<div class="market-card">'
        + '<div class="market-card-top">'
        + '<div class="market-card-ico">' + iconHtml(it) + '</div>'
        + '<div class="market-card-info">'
        + '<div class="market-card-name">' + esc(it.name) + '</div>'
        + '<div class="market-card-meta">'
        + '<span class="market-badge type">' + (TYPE_LABEL[it.type] || it.type) + '</span>'
        + '<span class="market-badge">' + esc(CAT_LABEL[it.category] || it.category || '其他') + '</span>'
        + (it.hosted ? '<span class="market-badge hosted">托管</span>' : '')
        + (needsAuth ? '<span class="market-badge auth">需授权</span>' : '')
        + '<span class="market-badge">v' + esc(it.version || '1.0') + '</span>'
        + '<span class="market-badge ' + stateCls + '">' + stateTxt + '</span>'
        + '</div></div></div>'
        + '<div class="market-card-desc">' + esc(it.description || '') + '</div>'
        + '<div class="market-card-actions">' + actions + '</div>'
        + '</div>';
    },

    renderTabs() {
      const tabEl = document.getElementById('market-tabs');
      const installedCount = this.list.filter(i => i.installed).length;
      const tabs = [
        ['all', '全部'],
        ['installed', '已安装' + (installedCount ? ' (' + installedCount + ')' : '')],
        ['skill', '技能'],
        ['mcp', 'MCP'],
        ['agent', '智能体']
      ];
      tabEl.innerHTML = tabs.map(([k, label]) =>
        '<button class="market-tab' + (this.filter === k ? ' active' : '') + '" data-tab="' + k + '">' + label + '</button>'
      ).join('');
    },

    // 分类下拉：选项来自当前 Tab 下条目的真实分类（不编造）
    renderCatOptions(source) {
      const sel = document.getElementById('market-cat-filter');
      if (!sel) return;
      const cats = [];
      const seen = {};
      for (const it of source) {
        const c = it.category || 'other';
        if (!seen[c]) { seen[c] = 1; cats.push(c); }
      }
      cats.sort();
      let html = '<option value="all">全部分类</option>';
      for (const c of cats) {
        const lab = CAT_LABEL[c] || c;
        html += '<option value="' + esc(c) + '"' + (this.cat === c ? ' selected' : '') + '>' + esc(lab) + '</option>';
      }
      if (this.cat !== 'all' && !seen[this.cat]) this.cat = 'all';
      sel.innerHTML = html;
    },

    async act(act, id) {
      if (this._busy.has(id)) return;
      this._busy.add(id);
      try {
        let res;
        if (act === 'install') res = await window.api.marketplace.install(id);
        else if (act === 'enable') res = await window.api.marketplace.setEnabled(id, true);
        else if (act === 'disable') res = await window.api.marketplace.setEnabled(id, false);
        else if (act === 'uninstall') res = await window.api.marketplace.uninstall(id);
        else if (act === 'config') { this.openConfig(id); return; }
        else if (act === 'info') { this.openInfo(id); return; }
        if (res && res.success) {
          this.toast(res.detail || '操作成功', true);
          await this.load(true);
        } else {
          this.toast((res && res.error) || '操作失败', false);
        }
      } catch (e) {
        this.toast('操作失败：' + (e.message || e), false);
      } finally {
        this._busy.delete(id);
      }
    },

    // ── 需授权条目：密钥配置弹窗 ──────────────────────────────────────
    openConfig(id) {
      const it = this.list.find(x => x.id === id);
      if (!it) return;
      this._configId = id;
      const title = document.getElementById('market-config-title');
      if (title) title.textContent = '配置密钥 · ' + it.name;
      const hint = document.getElementById('market-config-hint');
      if (hint) {
        hint.innerHTML = '该 MCP 需要以下授权信息才能启动。填写后保存到系统加密凭证库，启动时自动注入，不会明文写入配置。<br>'
          + '（配置来源：魔搭 MCP 广场 · <code style="opacity:.7">' + esc((it.mcpServer && it.mcpServer.command) || '') + '</code>）';
      }
      const fields = document.getElementById('market-config-fields');
      if (fields) {
        const fl = it.auth.fields || [];
        fields.innerHTML = fl.map(f => {
          const req = f.required ? ' <span class="market-req">*必填</span>' : ' <span style="opacity:.5">（可选）</span>';
          const hintHtml = f.hint ? '<div style="font-size:11px;opacity:.6;margin-top:2px;">' + esc(f.hint) + '</div>' : '';
          return '<div>'
            + '<label class="market-field-label">' + esc(f.name) + req + '</label>'
            + '<input type="password" class="market-config-input" data-field="' + esc(f.name) + '" placeholder="' + esc(f.name) + '" autocomplete="off" style="width:100%;border-radius:8px;padding:8px 10px;font-size:13px;margin-top:4px;">'
            + hintHtml
            + '</div>';
        }).join('');
      }
      const ov = document.getElementById('market-config-overlay');
      if (ov) ov.style.display = 'flex';
      const first = fields && fields.querySelector('input');
      if (first) first.focus();
    },
    closeConfig() {
      const ov = document.getElementById('market-config-overlay');
      if (ov) ov.style.display = 'none';
      this._configId = null;
    },
    async saveConfig() {
      const id = this._configId;
      if (!id) return;
      const values = {};
      const inputs = document.querySelectorAll('#market-config-fields .market-config-input');
      for (const inp of inputs) values[inp.dataset.field] = inp.value.trim();
      this.closeConfig();
      this.toast('正在保存并激活…', true);
      try {
        const res = await window.api.marketplace.installWithEnv(id, values);
        if (res && res.success) {
          this.toast(res.detail || '已配置并激活', true);
          await this.load(true);
        } else {
          this.toast((res && res.error) || '激活失败', false);
        }
      } catch (e) {
        this.toast('激活失败：' + (e.message || e), false);
      }
    },

    // ── 托管 / 说明弹窗 ───────────────────────────────────────────────
    openInfo(id) {
      const it = this.list.find(x => x.id === id);
      if (!it) return;
      const title = document.getElementById('market-info-title');
      if (title) title.textContent = it.name;
      const body = document.getElementById('market-info-body');
      if (body) {
        const isHosted = it.hosted;
        const lines = isHosted ? [
          '<b>托管服务（Hosted）</b>：该 MCP 由魔搭社区托管运行，不提供本地 stdio 启动配置。',
          '使用方式：登录 <a href="https://modelscope.cn/mcp" target="_blank" rel="noopener" class="market-link">魔搭 MCP 广场</a>，打开该服务的详情页获取专属连接信息（连接地址由平台按账号分配、有时效），再到应用「连通器」中手动添加。',
          '为什么不在商店直接启用：托管连接地址为登录后动态分配且 24 小时有效，官方标注请勿泄漏，不适合写死在本地配置。'
        ] : [
          '<b>授权说明</b>：该条目来自魔搭 MCP 广场，需要 API 密钥等授权信息才能启动。',
          '· 密钥请在其提供方控制台（如高德开放平台、天眼查、AI 订阅服务等）申请；',
          '· 在「配置并激活」弹窗中填写后保存，密钥经系统加密凭证库存储，启动时自动注入，绝不落明文。'
        ];
        body.innerHTML = lines.join('<br><br>');
      }
      const ov = document.getElementById('market-info-overlay');
      if (ov) ov.style.display = 'flex';
    },
    closeInfo() {
      const ov = document.getElementById('market-info-overlay');
      if (ov) ov.style.display = 'none';
    },

    async importFile() {
      const res = await window.api.marketplace.importFile();
      if (res && res.success) {
        this.toast(res.names ? ('已导入：' + res.names.join('、')) : '导入成功', true);
        await this.load(true);
      } else {
        this.toast((res && res.error) || '导入失败', false);
      }
    },

    openUrlInput() {
      const ov = document.getElementById('market-url-input-overlay');
      if (ov) ov.style.display = 'flex';
      const inp = document.getElementById('market-url-input');
      if (inp) { inp.value = ''; inp.focus(); }
    },
    closeUrlInput() {
      const ov = document.getElementById('market-url-input-overlay');
      if (ov) ov.style.display = 'none';
    },

    async importUrl() {
      const inp = document.getElementById('market-url-input');
      const url = (inp && inp.value || '').trim();
      if (!url) { this.toast('请输入 URL', false); return; }
      this.closeUrlInput();
      this.toast('正在导入…', true);
      try {
        const res = await window.api.marketplace.importUrl(url);
        if (res && res.success) {
          this.toast(res.names ? ('已导入：' + res.names.join('、')) : '导入成功', true);
          await this.load(true);
        } else {
          this.toast((res && res.error) || '导入失败', false);
        }
      } catch (e) {
        this.toast('导入失败：' + (e.message || e), false);
      }
    },

    toast(msg, ok) {
      try {
        let el = document.getElementById('market-ui-toast');
        if (!el) {
          el = document.createElement('div');
          el.id = 'market-ui-toast';
          el.style.cssText = 'position:fixed;left:50%;bottom:40px;transform:translateX(-50%);'
            + 'padding:9px 18px;border-radius:8px;font-size:13px;z-index:10005;'
            + 'pointer-events:none;transition:opacity .2s;max-width:70vw;text-align:center;';
          document.body.appendChild(el);
        }
        el.textContent = msg;
        el.style.background = ok ? 'rgba(76,175,80,.95)' : 'rgba(239,83,80,.95)';
        el.style.color = '#fff';
        el.style.opacity = '1';
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 2600);
      } catch (e) { /* 忽略 */ }
    },

    _esc(s) { return esc(s); },

    initOnce() {
      if (this._inited) return;
      this._inited = true;

      // 注入样式
      const st = document.createElement('style');
      st.id = 'marketplace-ui-css';
      st.textContent = CSS;
      document.head.appendChild(st);

      const topBtn = document.getElementById('btn-open-marketplace');
      if (topBtn) topBtn.addEventListener('click', () => this.open());

      const close = document.getElementById('market-modal-close');
      if (close) close.addEventListener('click', () => this.close());

      const overlay = document.getElementById('market-overlay');
      if (overlay) overlay.addEventListener('click', e => { if (e.target === overlay) this.close(); });

      const tabs = document.getElementById('market-tabs');
      if (tabs) tabs.addEventListener('click', e => {
        const b = e.target.closest('.market-tab');
        if (!b) return;
        this.filter = b.dataset.tab;
        this.cat = 'all';
        this._page = 1;
        this._catDirty = true;
        this.render();
      });

      const catSel = document.getElementById('market-cat-filter');
      if (catSel) catSel.addEventListener('change', () => {
        this.cat = catSel.value;
        this._page = 1;
        this.render();
      });

      const body = document.getElementById('market-body');
      if (body) body.addEventListener('click', e => {
        const pg = e.target.closest('[data-pager]');
        if (pg) {
          if (pg.disabled) return;
          if (pg.dataset.pager === 'prev') this._page = Math.max(1, this._page - 1);
          else this._page += 1;
          this.render();
          body.scrollTop = 0;
          return;
        }
        const b = e.target.closest('[data-act]');
        if (!b) return;
        this.act(b.dataset.act, b.dataset.id);
      });

      const search = document.getElementById('market-search-input');
      if (search) search.addEventListener('input', () => {
        clearTimeout(this._searchTimer);
        this._searchTimer = setTimeout(() => {
          this.keyword = search.value;
          this._page = 1;
          this.render();
        }, 200); // 防抖：避免输入时全量重渲染
      });

      const impFile = document.getElementById('market-btn-import-file');
      if (impFile) impFile.addEventListener('click', () => this.importFile());
      const impUrl = document.getElementById('market-btn-import-url');
      if (impUrl) impUrl.addEventListener('click', () => this.openUrlInput());
      const refresh = document.getElementById('market-btn-refresh');
      if (refresh) refresh.addEventListener('click', () => { this._loaded = false; this.load(true); });

      const urlOk = document.getElementById('market-url-ok');
      if (urlOk) urlOk.addEventListener('click', () => this.importUrl());
      const urlCancel = document.getElementById('market-url-cancel');
      if (urlCancel) urlCancel.addEventListener('click', () => this.closeUrlInput());
      const urlInput = document.getElementById('market-url-input');
      if (urlInput) urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') this.importUrl(); });

      const cfgOk = document.getElementById('market-config-ok');
      if (cfgOk) cfgOk.addEventListener('click', () => this.saveConfig());
      const cfgCancel = document.getElementById('market-config-cancel');
      if (cfgCancel) cfgCancel.addEventListener('click', () => this.closeConfig());
      const cfgOv = document.getElementById('market-config-overlay');
      if (cfgOv) cfgOv.addEventListener('click', e => { if (e.target === cfgOv) this.closeConfig(); });
      const cfgFields = document.getElementById('market-config-fields');
      if (cfgFields) cfgFields.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.classList.contains('market-config-input')) this.saveConfig(); });

      const infoOk = document.getElementById('market-info-ok');
      if (infoOk) infoOk.addEventListener('click', () => this.closeInfo());
      const infoOv = document.getElementById('market-info-overlay');
      if (infoOv) infoOv.addEventListener('click', e => { if (e.target === infoOv) this.closeInfo(); });
    }
  };

  window.MarketplaceUI = MarketplaceUI;
  document.addEventListener('DOMContentLoaded', () => MarketplaceUI.initOnce());
})();
