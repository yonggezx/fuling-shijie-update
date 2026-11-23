// ========== 全局状态 ==========
let installPath = '';

const $ = (id) => document.getElementById(id);

// ========== 页面导航 ==========
function showPage(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active', 'panel-open'));
  const page = $(pageId);
  if (page) page.classList.add('active');
}

// ========== 初始化 ==========
window.installerAPI.onInit((data) => {
  installPath = data.defaultPath || '';
  $('uninstallPath').textContent = installPath;
  showPage('uninstall-config');
});

// ========== 窗口控制 ==========
$('btnMinimize').onclick = () => window.installerAPI.minimize();
$('btnClose').onclick = closeWindow;
$('btnUninstallClose').onclick = closeWindow;

function closeWindow() {
  window.installerAPI.close();
}

// ========== 卸载 ==========
$('btnUninstall').onclick = async () => {
  setProgress(0, '正在准备卸载...');
  showPage('uninstall-progress');

  const result = await window.installerAPI.startUninstall({
    installPath,
    keepUserData: $('chkKeepUserData').checked,
    keepConfig: $('chkKeepConfig').checked
  });

  if (!result || !result.success) {
    $('uninstallStatus').textContent = '卸载失败';
    showTip(`卸载失败：${(result && result.error) || '未知错误'}`);
    showRetry();
    return;
  }

  showPage('uninstall-finish');
  showTip('正在后台清理程序目录，窗口将自动关闭...');
  // 卸载程序退出后由主进程静默删除整个程序目录
  setTimeout(closeWindow, 1600);
};

// 失败时在进度页下方补一个重试按钮
function showRetry() {
  const box = $('uninstallTip');
  if (!box || box.parentElement.querySelector('.retry-btn')) return;
  const btn = document.createElement('button');
  btn.className = 'btn-ghost retry-btn';
  btn.style.marginTop = '12px';
  btn.textContent = '重试';
  btn.onclick = () => window.location.reload();
  box.parentElement.appendChild(btn);
}

// ========== 进度回调 ==========
window.installerAPI.onUninstallProgress((data) => {
  if (data.pct >= 0) setProgress(data.pct, data.status);
  if (data.logMsg) showTip(data.logMsg);
});

function setProgress(pct, status) {
  $('uninstallBar').style.width = `${pct}%`;
  $('uninstallPct').textContent = `${pct}%`;
  if (status) $('uninstallStatus').textContent = status;
}

// 只保留一行最新动态，不再展开完整日志列表
function showTip(msg) {
  $('uninstallTip').textContent = String(msg || '').slice(0, 90);
}
