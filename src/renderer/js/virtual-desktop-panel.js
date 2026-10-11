/**
 * 隔离桌面控制器（前端）
 * ------------------------------------------------------------
 * 形态：
 *   未连接：面板内显示 图标 + 状态说明 + 状态卡片 + 「启动并连接」按钮
 *   已连接：原地切换为已连接状态视图（**不提供画面预览**）。
 *
 * ⚠️ 预览功能已移除：隔离桌面的壁纸/桌面背景 Windows 不渲染，
 *    预览只能是「中性底 + 窗口像素」，既不是真实桌面又占资源。
 *    隔离桌面只用于「不需要看界面」的任务（编译/跑脚本/后台程序），
 *    跑完由 AI 用文本汇报结果；需要看/操作界面的任务在用户真实桌面进行。
 *
 * 后端对应：clone:ensure / clone:input / clone:exit / clone:status。
 */
'use strict';

(function () {
  const state = {
    // 分身会话（连接）状态
    clone: {
      state: 'idle',          // 新接口主状态：'idle' | 'starting' | 'running' | 'error'
      connected: false,       // 由 state==='running' 推导，旧逻辑保留
      connecting: false,       // 由 state==='starting' 推导
      available: true,        // 旧字段兜底（s.available）
      authorized: false,      // 旧字段（s.auth.authorized）
      remaining: 0,           // 旧字段（s.auth.remaining）
      error: null
    },
    // 已连接状态视图（无画面预览）
    live: {
      on: false,
      fetching: false,
      frameTimer: null,
      offFrame: null,
      errorCount: 0,
      dragging: false
    },
    // 拖动
    drag: {
      dragging: false,
      startX: 0,
      startY: 0,
      origX: 0,
      origY: 0
    },
    // 画中画
    pip: { active: false, target: null, lastFrameAt: 0 },
    // 状态胶囊
    expanded: false,
    busy: false,
    loaded: false
  };

  const $ = (id) => document.getElementById(id);
  let el = {};
  let statusPollTimer = null;

  // 注：实时画面轮询常量（LIVE_POLL_MS / LIVE_RETRY_MS）已随预览功能一并移除。

  function t(key, fallback, arg) {
    let s = null;
    try {
      if (window.I18N && typeof window.I18N.t === 'function') s = window.I18N.t(key);
      else if (window.I18N && window.I18N.translations) {
        const cur = (typeof window.I18N.getCurrentLang === 'function')
          ? window.I18N.getCurrentLang() : 'zh-CN';
        s = (window.I18N.translations[cur] || {})[key];
      }
    } catch (e) { /* ignore */ }
    if (!s) s = fallback;
    if (arg !== undefined) s = String(s).replace('{0}', arg);
    return s;
  }

  function cloneApi() {
    return (window.api && window.api.cloneDesktop) ? window.api.cloneDesktop : null;
  }
  function pipApi() {
    return (window.api && window.api.pip) ? window.api.pip : null;
  }

  function setBusy(on) {
    state.busy = !!on;
    if (el.widget) el.widget.classList.toggle('busy', state.busy);
  }

  // ============================================================
  // 状态解析（新主状态 s.state + 旧字段兜底）
  // ============================================================
  /**
   * 统一把主进程返回的 status 对象写入本地 state。
   * 新接口：s.state = 'idle' | 'starting' | 'running' | 'error'
   * 旧接口（兜底）：s.available / s.auth.{authorized,remaining}
   * 字段缺失时跳过对应分支，不抛错。
   */
  function applyStatus(s) {
    if (!s) return;
    // 旧字段兜底
    if (s.available !== undefined && s.available !== null) {
      state.clone.available = !!s.available;
    }
    if (s.auth && typeof s.auth === 'object') {
      state.clone.authorized = !!s.auth.authorized;
      state.clone.remaining = s.auth.remaining || 0;
    }
    // 新主状态：s.state
    if (typeof s.state === 'string' && s.state) {
      state.clone.state = s.state;
      switch (s.state) {
        case 'running':
          state.clone.connected = true;
          state.clone.connecting = false;
          state.clone.error = null;
          break;
        case 'starting':
          // 启动中：connected 不立即翻 true，等 running 再切 live
          state.clone.connecting = true;
          state.clone.error = null;
          break;
        case 'error':
          state.clone.connecting = false;
          state.clone.error = s.purposeNote
            || (typeof s.error === 'string' ? s.error : null)
            || '桌面分身连接异常';
          break;
        case 'idle':
        default:
          state.clone.connected = false;
          state.clone.connecting = false;
          state.clone.error = null;
          break;
      }
    }
  }

  /** 根据 connected/connecting 切换 gate / live 面板形态 */
  function syncMode() {
    if (state.clone.connected) {
      if (!state.live.on) setMode('live');
    } else if (state.live.on) {
      setMode('gate');
    }
  }

  // ============================================================
  // 状态轮询
  // ============================================================
  async function pollStatus() {
    const api = cloneApi();
    if (!api) return;
    try {
      const s = await api.status();
      applyStatus(s);
      state.loaded = true;
      syncMode();
      renderGate();
      renderMini();
      renderCloneStatus();
    } catch (e) { /* 轮询失败静默，下一次再试 */ }
  }

  function startStatusPoll() {
    if (statusPollTimer) return;
    statusPollTimer = setInterval(pollStatus, 1500);
    pollStatus(); // 立即查一次
  }

  // ============================================================
  // 启动并连接 / 断开
  // ============================================================
  async function startClone() {
    if (state.busy || state.clone.connecting) return;
    const api = cloneApi();
    if (!api) { state.clone.error = '桌面分身接口不可用'; renderGate(); return; }
    if (!state.clone.available) {
      state.clone.error = '当前系统不支持桌面分身（仅 Windows）';
      renderGate();
      return;
    }
    state.clone.connecting = true;
    state.clone.error = null;
    setSub('正在拉起输入栏上方的桌面分身预览小窗…');
    renderGate();
    try {
      const r = await api.ensure();
      if (r && r.success) {
        // 不立即置 connected=true：等主进程广播/running 轮询回来再切 live
        setSub('启动请求已受理，悬浮窗正在打开…');
      } else {
        state.clone.connecting = false;
        state.clone.error = (r && r.error) || '启动失败';
        setSub(state.clone.error, true);
        setMode('gate');
      }
    } catch (e) {
      state.clone.connecting = false;
      state.clone.error = '启动异常: ' + ((e && e.message) || e);
      setSub(state.clone.error, true);
      setMode('gate');
    } finally {
      renderGate();
      renderCloneStatus();
      renderMini();
    }
  }

  async function disconnectClone() {
    if (state.busy) return;
    const api = cloneApi();
    if (!api) return;
    setBusy(true);
    setSub('正在关闭桌面分身悬浮窗…');
    try {
      if (api.exit) await api.exit();
      state.clone.connected = false;
      state.clone.state = 'idle';
      stopLiveLoop();
      setMode('gate');
      setSub('已断开，桌面分身悬浮窗已关闭');
    } catch (e) {
      setSub('断开异常: ' + ((e && e.message) || e), true);
    } finally {
      setBusy(false);
      renderGate();
      renderCloneStatus();
      renderMini();
    }
  }

  /** 切换面板形态：gate（未连接引导） / live（已连接状态视图，无画面） */
  function setMode(mode) {
    const live = mode === 'live';
    state.live.on = live;
    if (el.gate) el.gate.style.display = live ? 'none' : 'flex';
    if (el.live) el.live.style.display = live ? 'flex' : 'none';
    if (!live) stopLiveLoop();
    renderGate();
    renderCloneStatus();
  }

  // ============================================================
  // 隔离桌面连接状态（不提供画面预览）
  // ============================================================

  function startLiveLoop() {
    stopLiveLoop();
    state.live.errorCount = 0;
    // 预览功能已移除：隔离桌面（桌面分身）只用于「不需要看界面」的任务，
    // 它的画面用户看不到，因此这里不再订阅任何帧。
    if (el.liveEmpty) {
      el.liveEmpty.textContent = '隔离桌面不提供画面预览';
      el.liveEmpty.style.display = 'flex';
    }
  }

  function stopLiveLoop() {
    if (state.live.frameTimer) {
      clearInterval(state.live.frameTimer);
      state.live.frameTimer = null;
    }
    if (state.live.offFrame) {
      try { state.live.offFrame(); } catch (e) { /* ignore */ }
      state.live.offFrame = null;
    }
  }

  // 注：预览画布的缩放/坐标换算/点击转发逻辑已随预览功能一并移除。
  // 隔离桌面只用于「不需要看界面」的任务，用户不在画面上点击操作。

  // ============================================================
  // 状态胶囊（右下角，默认隐藏，手动调出）
  // ============================================================
  function renderMini() {
    if (!el.miniStatus) return;
    const c = state.clone;
    let statusText = t('clone.status.idle', '待命');
    let statusClass = 'idle';
    if (c.state === 'running' || c.connected) {
      statusText = t('clone.status.active', '已连接');
      statusClass = 'active';
    } else if (c.state === 'starting' || c.connecting) {
      statusText = t('clone.status.connecting', '连接中');
      statusClass = 'connecting';
    } else if (c.state === 'error') {
      statusText = t('clone.status.error', '连接异常');
      statusClass = 'error';
    }
    el.miniStatus.textContent = statusText;
    el.miniStatus.className = 'vdesk-mini-status ' + statusClass;
    if (el.widget) {
      el.widget.classList.toggle('clone-active', !!c.connected);
      el.widget.classList.toggle('clone-connecting', !c.connected && (c.state === 'starting' || c.connecting));
      el.widget.classList.toggle('clone-error', c.state === 'error');
    }
  }

  /** 未连接引导态：标题 / 说明 / 状态卡片 / 按钮文案 */
  function renderGate() {
    const c = state.clone;
    if (el.gate) el.gate.classList.toggle('on', !!c.connected);

    if (el.gateTitle) {
      if (c.state === 'error') el.gateTitle.textContent = '桌面分身连接异常';
      else if (c.connecting) el.gateTitle.textContent = '正在启动桌面分身…';
      else if (c.connected) el.gateTitle.textContent = '桌面分身已连接';
      else if (!c.available) el.gateTitle.textContent = '桌面分身不可用';
      else el.gateTitle.textContent = '桌面分身尚未启动';
    }
    if (el.gateDesc) {
      if (c.connecting) el.gateDesc.textContent = '正在输入栏上方拉起悬浮预览小窗，请稍候…';
      else if (c.connected) el.gateDesc.textContent = '预览小窗已在输入栏上方打开，AI 的操作都在其中执行';
      else if (c.error) el.gateDesc.textContent = c.error;
      else el.gateDesc.textContent = '点击「启动并连接」，将在输入栏上方打开桌面分身预览小窗';
    }

    // 状态卡片
    if (el.cloneConn) {
      const txt = c.connected ? '已连接（悬浮窗运行中）'
        : c.state === 'starting' ? '连接中…'
        : c.state === 'error' ? '连接异常'
        : '未连接';
      el.cloneConn.textContent = txt;
      el.cloneConn.className = 'vdesk-clone-line' + (c.connected ? ' ok' : '');
    }
    if (el.cloneAuthLine) {
      el.cloneAuthLine.textContent = c.authorized
        ? '操作授权：已授权（剩余 ' + Math.max(0, c.remaining || 0) + ' 秒）'
        : '操作授权：未授权（连接后可手动授权）';
    }
    if (el.cloneMeta) {
      el.cloneMeta.textContent = '状态：' + (c.state || 'idle')
        + ' | 连接：' + (c.connected ? '已连接' : '未连接')
        + ' | 授权：' + (c.authorized ? '已授权' : '未授权')
        + ' | 功能可用：' + (c.available ? '是' : '否');
    }

    // 按钮
    if (el.startLabel) {
      el.startLabel.textContent = c.connecting ? '启动中…'
        : c.connected ? '重启悬浮窗'
        : '启动并连接';
    }
    if (el.startBtn) {
      el.startBtn.disabled = !!c.connecting || !c.available;
    }
  }

  function renderCloneStatus() {
    const c = state.clone;
    // 旧节点（可能已不在 DOM 中）保留兼容，避免 null 报错
    if (el.cloneActive) {
      el.cloneActive.textContent = c.connected ? '已连接' : '未连接';
      el.cloneActive.className = 'vdesk-clone-value ' + (c.connected ? 'active' : 'inactive');
    }
    if (el.cloneAuth) {
      el.cloneAuth.textContent = c.authorized
        ? t('clone.authAuthorized', '已授权，剩余 {0} 秒', Math.max(0, c.remaining || 0))
        : t('clone.authNotAuthorized', '未授权（AI 操作时会弹窗申请）');
      el.cloneAuth.className = 'vdesk-clone-value' + (c.authorized ? ' authorized' : '');
    }
    if (el.authLabel) {
      el.authLabel.textContent = c.authorized
        ? t('clone.authRevoke', '取消授权')
        : t('clone.authorize', '授权操作');
    }
    if (el.exitBtn) {
      el.exitBtn.style.display = c.connected ? 'flex' : 'none';
    }
  }

  function setSub(text, warn) {
    if (!el.sub) return;
    el.sub.textContent = text;
    el.sub.classList.toggle('warn', !!warn);
  }

  async function requestAuth() {
    if (state.busy) return;
    const api = cloneApi();
    if (!api) return;
    if (state.clone.authorized) {
      setBusy(true);
      try {
        await api.revokeAuth();
        state.clone.authorized = false;
        state.clone.remaining = 0;
        setSub('已取消操作授权');
        renderMini();
        renderCloneStatus();
      } catch (e) {
        setSub('取消授权异常: ' + (e && e.message ? e.message : e), true);
      } finally {
        setBusy(false);
      }
      return;
    }
    setBusy(true);
    setSub('等待管理员密码授权…');
    try {
      const r = await api.requestAuth('AI 申请在隔离桌面中进行鼠标点击和键盘输入操作，请输入管理员密码授权。');
      if (r && r.ok) {
        setSub('已授权，有效期 ' + (r.remaining || 0) + ' 秒');
        state.clone.authorized = true;
        state.clone.remaining = r.remaining || 0;
      } else if (r && r.cancelled) {
        setSub('已取消授权');
      } else {
        setSub('授权失败: ' + ((r && r.error) || '未知原因'), true);
      }
      renderMini();
      renderCloneStatus();
    } catch (e) {
      setSub('授权异常: ' + (e && e.message ? e.message : e), true);
    } finally {
      setBusy(false);
    }
  }

  async function exitClone() {
    if (state.busy) return;
    await disconnectClone();
  }

  function setExpanded(on) {
    state.expanded = !!on;
    if (!el.widget) return;
    el.widget.style.display = state.expanded ? 'block' : 'none';
    el.widget.classList.toggle('expanded', state.expanded);
    if (el.panel) el.panel.style.display = state.expanded ? 'flex' : 'none';
    if (state.expanded) {
      renderMini();
      renderGate();
      renderCloneStatus();
      loadTargets();
    } else {
      // 收起时停掉帧循环，避免后台空转
      stopLiveLoop();
    }
  }

  // ============================================================
  // 画中画（PiP）：保留原有功能
  // ============================================================
  async function loadTargets() {
    if (!el.targetSelect) return;
    let list = [];
    try {
      if (window.api && window.api.ui && window.api.ui.listWindows) {
        const r = await window.api.ui.listWindows({ all: true });
        if (r && r.success && Array.isArray(r.windows)) list = r.windows;
        else if (Array.isArray(r)) list = r;
      }
    } catch (e) { /* ignore */ }
    const cur = el.targetSelect.value;
    el.targetSelect.innerHTML = '';
    const opt0 = document.createElement('option');
    opt0.value = '';
    opt0.textContent = list.length ? t('pip.pickTarget', '选择要观察的程序…') : t('pip.noWindows', '没有可观察的窗口');
    el.targetSelect.appendChild(opt0);
    for (const w of list) {
      if (!w || !w.title) continue;
      const o = document.createElement('option');
      o.value = w.title;
      o.textContent = w.title.length > 42 ? (w.title.slice(0, 42) + '…') : w.title;
      el.targetSelect.appendChild(o);
    }
    if (cur) el.targetSelect.value = cur;
    if (el.targetRow) el.targetRow.style.display = 'flex';
  }

  async function togglePip() {
    const a = pipApi();
    if (!a) { setSub('画中画功能不可用', true); return; }
    if (state.busy) return;
    if (state.pip.active) {
      setBusy(true);
      try {
        const r = await a.exit();
        if (r && r.success) {
          state.pip.active = false;
          setSub('已退出画中画，窗口已还原');
          renderPip();
        } else {
          setSub('退出失败: ' + ((r && r.error) || '未知'), true);
        }
      } finally { setBusy(false); }
      return;
    }
    const title = el.targetSelect ? el.targetSelect.value.trim() : '';
    if (!title) { setSub('请先选择要观察的程序', true); return; }
    setBusy(true);
    setSub('正在进入画中画…');
    try {
      const r = await a.enter(title);
      if (r && r.success) {
        state.pip.active = true;
        state.pip.target = title;
        setSub('画中画已开启，AI 正在「' + title + '」上操作');
        renderPip();
      } else {
        setSub('进入失败: ' + ((r && r.error) || '未知原因'), true);
      }
    } catch (e) {
      setSub('进入异常: ' + (e && e.message ? e.message : e), true);
    } finally { setBusy(false); }
  }

  function renderPip() {
    const on = !!state.pip.active;
    if (el.pip) el.pip.style.display = on ? 'flex' : 'none';
    if (el.pipBtn) el.pipBtn.classList.toggle('on', on);
    if (el.pipBtnLabel) {
      el.pipBtnLabel.textContent = on ? t('pip.exit', '退出画中画') : t('pip.enter', '进入画中画');
    }
    if (el.pipTitle && on) el.pipTitle.textContent = state.pip.target || t('pip.noTarget', '未选择目标');
    if (el.pipBadge) {
      el.pipBadge.classList.toggle('off', !on);
      el.pipBadge.textContent = on ? t('pip.aiWorking', 'AI 操作中') : t('pip.idle', '待命');
    }
  }

  function onFrame(f) {
    if (!f || !el.pipImg) return;
    state.pip.lastFrameAt = Date.now();
    if (f.dataUrl) {
      el.pipImg.src = f.dataUrl;
      el.pipImg.style.display = 'block';
      if (el.pipEmpty) el.pipEmpty.style.display = 'none';
    } else {
      el.pipImg.style.display = 'none';
      if (el.pipEmpty) {
        el.pipEmpty.style.display = 'block';
        el.pipEmpty.textContent = f.error
          ? (f.error === '目标窗口不在当前桌面/已最小化'
            ? t('pip.notOnDesktop', '目标窗口已最小化或不在当前桌面')
            : t('pip.noFrame', '暂时抓不到画面') + '：' + f.error)
          : t('pip.waiting', '正在等待画面…');
      }
    }
  }

  async function onStageClick(ev) {
    const a = pipApi();
    if (!a || !state.pip.active) return;
    if (!el.stage) return;
    const r = el.stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const img = el.pipImg;
    if (img && img.naturalWidth && img.naturalHeight) {
      const boxAR = r.width / r.height;
      const imgAR = img.naturalWidth / img.naturalHeight;
      let vw = r.width, vh = r.height, ox = 0, oy = 0;
      if (imgAR > boxAR) { vh = r.width / imgAR; oy = (r.height - vh) / 2; }
      else { vw = r.height * imgAR; ox = (r.width - vw) / 2; }
      const cx = (ev.clientX - r.left - ox) / vw;
      const cy = (ev.clientY - r.top - oy) / vh;
      const res = await a.forwardClick(cx, cy, { button: ev.button === 2 ? 'right' : 'left', double: ev.detail >= 2 });
      handleForwardResult(res);
      return;
    }
    const rx = (ev.clientX - r.left) / r.width;
    const ry = (ev.clientY - r.top) / r.height;
    const res = await a.forwardClick(rx, ry, { button: ev.button === 2 ? 'right' : 'left' });
    handleForwardResult(res);
  }

  function handleForwardResult(res) {
    if (res && res.success) {
      flashStage(t('pip.clicked', '已把你的点击发过去'));
    } else {
      setSub('点击未送达: ' + ((res && res.error) || '未知原因'), true);
    }
  }

  function flashStage(text) {
    if (!el.stage) return;
    const prev = el.stage.style.boxShadow;
    el.stage.style.boxShadow = '0 0 0 2px rgba(52,211,153,.7)';
    setTimeout(() => { el.stage.style.boxShadow = prev; }, 220);
    if (el.pipHint) {
      const old = el.pipHint.textContent;
      el.pipHint.textContent = text;
      setTimeout(() => { el.pipHint.textContent = old; }, 1400);
    }
  }

  function refreshIconsIn(root) {
    if (!window.ElIcons || !window.ElIcons.getIcon) return;
    const nodes = (root || document).querySelectorAll('[data-icon]');
    nodes.forEach((n) => {
      const name = n.getAttribute('data-icon');
      if (!name) return;
      const svg = window.ElIcons.ICONS[name];
      if (!svg) return;
      n.innerHTML = svg;
    });
  }

  // ============================================================
  // 初始化
  // ============================================================
  function init() {
    el = {
      // 状态胶囊
      widget: $('vdesk-widget'),
      mini: $('vdesk-mini'),
      panel: $('vdesk-panel'),
      sub: $('vdesk-panel-sub'),
      miniName: $('vdesk-mini-name'),
      miniStatus: $('vdesk-mini-status'),
      // 未连接引导态
      gate: $('vdesk-gate'),
      gateTitle: $('vdesk-gate-title'),
      gateDesc: $('vdesk-gate-desc'),
      cloneStatus: $('vdesk-clone-status'),
      cloneConn: $('vdesk-clone-conn'),
      cloneAuthLine: $('vdesk-clone-auth-line'),
      cloneMeta: $('vdesk-clone-meta'),
      startBtn: $('vdesk-btn-start'),
      startLabel: $('vdesk-start-label'),
      helpBtn: $('vdesk-btn-help'),
      // 隔离桌面已连接状态（无画面预览）
      live: $('vdesk-live'),
      liveBadge: $('vdesk-live-badge'),
      liveStage: $('vdesk-live-stage'),
      liveEmpty: $('vdesk-live-empty'),
      liveDisconnect: $('vdesk-live-disconnect'),
      // 旧状态节点（兼容，可能已不在 DOM）
      cloneActive: $('vdesk-clone-active'),
      cloneAuth: $('vdesk-clone-auth'),
      auth: $('vdesk-btn-auth'),
      authLabel: $('vdesk-auth-label'),
      exitBtn: $('vdesk-btn-exit'),
      refresh: $('vdesk-btn-refresh'),
      collapse: $('vdesk-btn-collapse'),
      // 画中画
      pip: $('vdesk-pip'),
      pipTitle: $('vdesk-pip-title'),
      pipBadge: $('vdesk-pip-badge'),
      stage: $('vdesk-pip-stage'),
      pipImg: $('vdesk-pip-img'),
      pipEmpty: $('vdesk-pip-empty'),
      pipHint: $('vdesk-pip-hint'),
      targetRow: $('vdesk-target-row'),
      targetSelect: $('vdesk-target-select'),
      pipBtn: $('vdesk-btn-pip'),
      pipBtnLabel: $('vdesk-pip-btn-label')
    };

    // ===== 状态胶囊事件 =====
    if (el.mini) el.mini.addEventListener('click', () => setExpanded(true));
    if (el.collapse) el.collapse.addEventListener('click', () => setExpanded(false));
    if (el.refresh) el.refresh.addEventListener('click', () => { pollStatus(); renderGate(); renderMini(); renderCloneStatus(); });
    if (el.auth) el.auth.addEventListener('click', requestAuth);
    if (el.exitBtn) el.exitBtn.addEventListener('click', exitClone);

    // ===== 启动并连接 =====
    if (el.startBtn) el.startBtn.addEventListener('click', startClone);
    if (el.helpBtn) {
      el.helpBtn.addEventListener('click', () => {
        setSub('隔离桌面用于跑编译、脚本、安装依赖等不需要看界面的任务，跑完 AI 会用文字汇报结果。'
          + '需要看界面或操作界面的任务，会在你的真实桌面上进行。');
      });
    }
    if (el.liveDisconnect) el.liveDisconnect.addEventListener('click', disconnectClone);

    // 画中画
    if (el.pipBtn) el.pipBtn.addEventListener('click', togglePip);
    if (el.stage) {
      el.stage.addEventListener('click', onStageClick);
      el.stage.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    if (el.targetSelect) {
      el.targetSelect.addEventListener('change', async () => {
        const title = el.targetSelect.value.trim();
        if (!title) return;
        if (state.pip.active) {
          const a = pipApi();
          const r = await a.setTarget(title);
          if (r && r.success) {
            state.pip.target = title;
            setSub('已切换观察目标为「' + title + '」');
            renderPip();
          } else {
            setSub('切换目标失败: ' + ((r && r.error) || '未知'), true);
          }
        }
      });
    }

    // 订阅画中画画帧与状态
    if (window.api && window.api.pip) {
      if (window.api.pip.onFrame) window.api.pip.onFrame(onFrame);
      if (window.api.pip.onState) {
        window.api.pip.onState((s) => {
          if (!s) return;
          state.pip.active = !!s.active;
          if (s.targetTitle) state.pip.target = s.targetTitle;
          renderPip();
        });
      }
    }

    // 点面板外面收起状态胶囊
    document.addEventListener('click', (e) => {
      if (!state.expanded || !el.widget) return;
      if (el.widget.contains(e.target)) return;
      setExpanded(false);
    });

    // Esc 收起
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.expanded) setExpanded(false);
    });

    // 模态弹窗遮挡时禁用状态胶囊交互
    const MODAL_IDS = [
      'disclaimer-modal-overlay', 'modal-overlay', 'memory-modal-overlay',
      'personalization-modal-overlay', 'small-text-editor-overlay',
      'changelog-modal-overlay', 'update-modal-overlay', 'security-modal-overlay'
    ];
    const syncModal = () => {
      const modalOpen = MODAL_IDS.some((id) => {
        const n = document.getElementById(id);
        if (!n) return false;
        const cs = getComputedStyle(n);
        return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0;
      });
      if (modalOpen && el.widget) {
        if (state.expanded) setExpanded(false);
        el.widget.classList.add('modal-blocked');
      } else if (el.widget) {
        el.widget.classList.remove('modal-blocked');
      }
    };
    setInterval(syncModal, 700);
    syncModal();

    // 图标渲染
    if (el.widget) refreshIconsIn(el.widget);

    // 启动状态轮询
    startStatusPoll();

    // 订阅主进程 desktop:state 广播（与轮询双通道）：
    // 用户点悬浮窗 × 关闭时，主进程会立刻推 idle/error，不用等下一次轮询。
    const cApi = cloneApi();
    if (cApi && typeof cApi.onState === 'function') {
      try {
        cApi.onState((s) => {
          if (!s) return;
          applyStatus(s);
          state.loaded = true;
          syncMode();
          renderGate();
          renderMini();
          renderCloneStatus();
        });
      } catch (e) { /* 订阅失败不影响轮询 */ }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 暴露给调试/其它模块
  window.VirtualDesktopWidget = {
    refresh: pollStatus,
    expand: () => setExpanded(true),
    collapse: () => setExpanded(false),
    // 启动并连接 / 断开
    start: startClone,
    disconnect: disconnectClone,
    getState: () => ({ ...state })
  };
})();
