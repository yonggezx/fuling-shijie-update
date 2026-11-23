// ========== 全局状态 ==========
let currentMode = 'install';   // 'install' | 'uninstall'
let appVersion = '';
let installPath = '';

// ========== 元素缓存 ==========
const $ = (id) => document.getElementById(id);

// ========== 页面导航 ==========
function showPage(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active', 'panel-open'));
  const page = $(pageId);
  if (page) page.classList.add('active');
  closeLicense();
  if (pageId !== 'install-progress') stopFeatureCarousel();
}

// ========== 安装进度页：程序图标 + 功能介绍自动轮播 ==========
const FEATURES = [
  { title: 'Live2D 虚拟桌宠', desc: '灵动的 2D 形象，陪伴你的每一次桌面时光' },
  { title: '本地 AI 推理',   desc: '隐私不出本机，断网也能与智能助手对话' },
  { title: '自然语言操作电脑', desc: '说句话就能打开程序、执行任务、整理文件' },
  { title: '智能商城扩展',   desc: '一键安装技能与智能体，能力持续生长' },
];
let featureTimer = null;

function startFeatureCarousel() {
  stopFeatureCarousel();
  const dots = $('featureDots');
  if (!dots) return;
  dots.innerHTML = FEATURES.map((_, i) => `<span data-i="${i}"></span>`).join('');
  let i = 0;
  const render = () => {
    const slide = $('featureSlide');
    slide.classList.remove('show');
    setTimeout(() => {
      $('featureTitle').textContent = FEATURES[i].title;
      $('featureDesc').textContent = FEATURES[i].desc;
      slide.classList.add('show');
      dots.querySelectorAll('span').forEach((d, j) => d.classList.toggle('on', j === i));
    }, 350);
    i = (i + 1) % FEATURES.length;
  };
  render();
  featureTimer = setInterval(render, 3200);
}

function stopFeatureCarousel() {
  if (featureTimer) { clearInterval(featureTimer); featureTimer = null; }
}

// ========== 初始化 ==========
window.installerAPI.onInit((data) => {
  currentMode = data.mode;
  appVersion = data.version;
  installPath = data.defaultPath || '';

  if (currentMode === 'uninstall') {
    document.title = '浮灵饰界 卸载向导';
    $('uninstallPath').textContent = installPath || '';
    showPage('uninstall-config');
    return;
  }

  document.title = '浮灵饰界 安装向导';
  $('installPath').value = installPath;
  $('subtitle').textContent =
    `智能桌面宠物助手 · Live2D 虚拟形象 · 本地 AI 推理 · v${data.installedVersion || appVersion}`;

  // ★ 覆盖安装不显示任何提示信息：欢迎页与全新安装一致（进度页只显示进度条）

  if (installPath) checkDiskSpace(installPath);
  showPage('install-config');
});

// ========== 窗口控制 ==========
$('btnMinimize').onclick = () => window.installerAPI.minimize();
$('btnClose').onclick = closeWindow;
$('btnFinishClose').onclick = closeWindow;
$('btnUninstallClose').onclick = closeWindow;

function closeWindow() {
  window.installerAPI.close();
}

// ========== 自定义安装展开区 ==========
$('toggleCustom').onclick = (e) => {
  e.stopPropagation();
  const page = $('install-config');
  const opening = !$('customPanel').classList.contains('open');
  $('customPanel').classList.toggle('open', opening);
  page.classList.toggle('panel-open', opening);
  $('toggleCustom').classList.toggle('open', opening);
};

// 点击第一页空白处收起
document.addEventListener('click', (e) => {
  if (currentMode !== 'install') return;
  if (!$('install-config').classList.contains('active')) return;
  const t = e.target;
  if ($('toggleCustom').contains(t) || $('customPanel').contains(t)) return;
  if (t.closest('a, button, input, label')) return;
  $('customPanel').classList.remove('open');
  $('install-config').classList.remove('panel-open');
  $('toggleCustom').classList.remove('open');
});

// ========== 浏览目录 ==========
$('btnBrowse').onclick = async () => {
  const dir = await window.installerAPI.browseDirectory();
  if (!dir) return;
  installPath = dir;
  $('installPath').value = dir;
  checkDiskSpace(dir);
};

async function checkDiskSpace(dirPath) {
  const hint = $('diskHint');
  const result = await window.installerAPI.getDiskSpace(dirPath);
  if (!result || !(result.freeSpace > 0)) return;
  const freeGB = (result.freeSpace / 1024 / 1024 / 1024).toFixed(1);
  if (result.ok) {
    hint.textContent = `可用空间 ${freeGB} GB · 建议 ≥ 2GB`;
    hint.className = 'panel-hint ok';
  } else {
    hint.textContent = `可用空间不足：${freeGB} GB · 建议释放后继续`;
    hint.className = 'panel-hint warn';
  }
}

// ========== 用户许可协议（独立弹层，不撑破单页） ==========
$('licenseLink').onclick = (e) => {
  e.preventDefault();
  e.stopPropagation();
  $('licenseOverlay').classList.add('show');
};

$('licenseClose').onclick = () => {
  closeLicense();
  $('agreeLicense').checked = true;
};

$('licenseOverlay').onclick = (e) => {
  if (e.target === $('licenseOverlay')) closeLicense();
};

function closeLicense() {
  const ov = $('licenseOverlay');
  if (ov) ov.classList.remove('show');
}

// ========== 安装 ==========
$('btnStartInstall').onclick = async () => {
  const agree = $('agreeLicense');
  if (!agree.checked) {
    const row = agree.closest('.install-footer-row');
    row.classList.remove('shake');
    void row.offsetWidth;           // 重排以重启动画
    row.classList.add('shake');
    setTimeout(() => row.classList.remove('shake'), 400);
    return;
  }
  if (!installPath) return;

  const tipEl = $('installTip');
  tipEl.style.display = 'none';
  tipEl.textContent = '';
  setProgress('install', 0);
  showPage('install-progress');
  startFeatureCarousel();

  const result = await window.installerAPI.startInstall({
    installPath,
    createDesktopShortcut: $('chkDesktop').checked,
    createStartMenuShortcut: $('chkStartMenu').checked
  });

  if (!result || !result.success) {
    showTip('install', `安装失败：${(result && result.error) || '未知错误'}`);
    showRetry('install');
    return;
  }

  $('installPathDisplay').textContent = installPath;
  showPage('install-finish');
};

$('btnLaunch').onclick = async () => {
  await window.installerAPI.launchApp(installPath);
  closeWindow();
};

// ========== 卸载 ==========
$('btnUninstall').onclick = async () => {
  setProgress('uninstall', 0, '正在准备卸载...');
  showPage('uninstall-progress');

  const result = await window.installerAPI.startUninstall({
    installPath,
    keepUserData: $('chkKeepUserData').checked,
    keepConfig: $('chkKeepConfig').checked
  });

  if (!result || !result.success) {
    $('uninstallStatus').textContent = '卸载失败';
    showTip('uninstall', `卸载失败：${(result && result.error) || '未知错误'}`);
    showRetry('uninstall');
    return;
  }
  showPage('uninstall-finish');
};

// 失败时在进度页下方补一个重试按钮
function showRetry(type) {
  const box = $(`${type}Tip`);
  if (!box || box.parentElement.querySelector('.retry-btn')) return;
  const btn = document.createElement('button');
  btn.className = 'btn-ghost retry-btn';
  btn.style.marginTop = '12px';
  btn.textContent = '重试';
  btn.onclick = () => window.location.reload();
  box.parentElement.appendChild(btn);
}

// ========== 进度回调 ==========
// ★ 安装过程只显示进度条：不渲染状态文字与过程日志（失败时的错误提示走 showTip）
window.installerAPI.onInstallProgress((data) => {
  if (data.pct >= 0) setProgress('install', data.pct);
});

window.installerAPI.onUninstallProgress((data) => {
  if (data.pct >= 0) setProgress('uninstall', data.pct, data.status);
  if (data.logMsg) showTip('uninstall', data.logMsg);
});

function setProgress(type, pct, status) {
  const bar = $(`${type}Bar`);
  const pctEl = $(`${type}Pct`);
  const statusEl = $(`${type}Status`);
  if (bar) bar.style.width = `${pct}%`;
  if (pctEl) pctEl.textContent = `${pct}%`;
  if (statusEl && status) statusEl.textContent = status;
}

// 只保留一行最新动态，不再展开完整日志列表（正常安装过程不调用，仅失败时显示错误）
function showTip(type, msg) {
  const tip = $(`${type}Tip`);
  if (!tip) return;
  tip.style.display = '';
  tip.textContent = String(msg || '').slice(0, 90);
}
