const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

const APP_NAME = '浮灵饰界';
const APP_EXE = '浮灵饰界.exe';
const UNINSTALLER_EXE = 'uninstaller.exe';
const REG_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Fuling_Shijie';

// 版本号改为运行时从 package.json 读取，避免硬编码导致“内部版本号仍是旧值”。
// uninstaller-app/package.json 的 version 由 scripts/build-web-installer.js 同步自根 package.json。
function getAppVersion() {
  try {
    return require('./package.json').version;
  } catch (e) {
    return '1.0.3';
  }
}
const APP_VERSION = getAppVersion();

let mainWindow;

function getDefaultInstallPath() {
  const regPath = regQueryValue(REG_KEY, 'InstallLocation');
  if (regPath && fs.existsSync(regPath)) return regPath;
  // Fallback: the uninstaller.exe lives inside the install directory
  const originalExe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  if (originalExe) {
    const dir = path.dirname(originalExe);
    if (fs.existsSync(dir)) return dir;
  }
  return '';
}

function detectExistingInstall() {
  const installPath = regQueryValue(REG_KEY, 'InstallLocation') || '';
  const displayVersion = regQueryValue(REG_KEY, 'DisplayVersion') || '';
  return {
    installed: !!installPath && fs.existsSync(installPath),
    installPath,
    displayVersion
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 520,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();

  const existing = detectExistingInstall();
  const defaultPath = existing.installPath || getDefaultInstallPath();

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('init', {
      mode: 'uninstall',
      version: APP_VERSION,
      installedVersion: existing.displayVersion || APP_VERSION,
      defaultPath,
      appName: APP_NAME,
      isInstalled: existing.installed,
      existingInstallPath: existing.installPath
    });
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

// ========== IPC: Window Controls ==========
ipcMain.handle('minimize-window', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.handle('close-window', () => {
  app.quit();
});

// ========== IPC: Start Uninstall ==========
ipcMain.handle('start-uninstall', async (event, opts) => {
  const { installPath, keepUserData, keepConfig } = opts;

  const sendProgress = (pct, status, logType, logMsg) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('uninstall-progress', { pct, status, logType, logMsg });
    }
  };

  try {
    // Step 1: Kill ALL processes from the install directory
    sendProgress(5, '正在停止运行中的进程...', 'info', '检查并停止 浮灵饰界 及相关进程');
    killAppProcesses(installPath);
    waitForProcessExit(APP_EXE, 5000);
    sendProgress(10, '进程已停止', 'success', '所有相关进程已停止');

    // Step 2: Remove shortcuts
    sendProgress(15, '正在移除快捷方式...', 'info', '移除桌面和开始菜单快捷方式');
    const desktopLnk = path.join(process.env.USERPROFILE, 'Desktop', `${APP_NAME}.lnk`);
    try { if (fs.existsSync(desktopLnk)) fs.unlinkSync(desktopLnk); } catch (e) {}

    const startMenuLnk = path.join(
      process.env.APPDATA,
      'Microsoft', 'Windows', 'Start Menu', 'Programs',
      `${APP_NAME}.lnk`
    );
    try { if (fs.existsSync(startMenuLnk)) fs.unlinkSync(startMenuLnk); } catch (e) {}
    sendProgress(20, '快捷方式已移除', 'success', '快捷方式移除完成');

    // Step 3: Delete app files (only skip the running uninstaller itself;
    // the whole install directory is removed later by scheduleSelfDeletion)
    sendProgress(25, '正在删除程序文件...', 'info', '开始删除程序文件');

    if (fs.existsSync(installPath)) {
      const entries = fs.readdirSync(installPath);
      const skipFiles = [UNINSTALLER_EXE];
      const toDelete = entries.filter(f => !skipFiles.includes(f));
      let deletedCount = 0;
      const totalCount = toDelete.length;

      for (const entry of toDelete) {
        const entryPath = path.join(installPath, entry);
        try {
          fs.rmSync(entryPath, { recursive: true, force: true });
        } catch (e) {
          // 个别文件可能被占用，稍后由 scheduleSelfDeletion 兜底删除
        }
        deletedCount++;
        const pct = 25 + Math.round((deletedCount / Math.max(totalCount, 1)) * 55);
        sendProgress(pct, '正在删除程序文件...', 'info', `已删除: ${entry}`);
      }
    }

    sendProgress(80, '程序文件已删除', 'success', '所有程序文件已删除');

    // Step 4: Remove registry
    sendProgress(85, '正在清理注册表信息...', 'info', '移除系统注册表项');
    regDeleteKey(REG_KEY);
    // Also clean up legacy HKLM keys written by the installer
    regDeleteKeyHKLM('Software\\Fuling_Shijie');
    sendProgress(90, '注册表已清理', 'success', '注册表清理完成');

    // Step 5: Optionally remove user data
    if (!keepUserData) {
      sendProgress(92, '正在清理用户数据...', 'info', '删除用户数据目录');
      const appDataPath = path.join(process.env.APPDATA, 'fuling-shijie');
      try { if (fs.existsSync(appDataPath)) fs.rmSync(appDataPath, { recursive: true, force: true }); } catch (e) {}
      sendProgress(95, '用户数据已清理', 'success', '用户数据已删除');
    }

    if (!keepConfig) {
      const configPath = path.join(process.env.APPDATA, 'fuling-shijie', 'config');
      try { if (fs.existsSync(configPath)) fs.rmSync(configPath, { recursive: true, force: true }); } catch (e) {}
    }

    sendProgress(100, '卸载完成', 'success', `${APP_NAME} 已成功卸载`);

    // 安排卸载程序退出后静默删除整个安装目录（含子文件/子文件夹）
    scheduleSelfDeletion(installPath);

    return { success: true };
  } catch (error) {
    sendProgress(-1, '卸载失败', 'error', `错误: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// ========== Helper Functions ==========

/**
 * Escape a string for use inside a single-quoted PowerShell string.
 */
function psEscape(str) {
  return String(str).replace(/'/g, "''");
}

/**
 * Read a registry value from HKCU using PowerShell.
 * Uses base64 encoding to bypass all console/pipe encoding issues.
 */
function regQueryValue(keyPath, valueName) {
  try {
    const psPath = `Registry::HKCU\\${psEscape(keyPath)}`;
    const psName = psEscape(valueName);
    const psCommand = `$v = Get-ItemProperty -Path '${psPath}' -Name '${psName}' -ErrorAction SilentlyContinue; if ($v -and $v.PSObject.Properties.Name -contains '${psName}') { [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$v.${psName})) }`;
    const result = spawnSync('powershell', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCommand
    ], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    const b64 = result.stdout ? result.stdout.trim() : '';
    if (!b64) return '';
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch (e) {
    return '';
  }
}

/**
 * Delete a registry key from HKCU using PowerShell.
 */
function regDeleteKey(keyPath) {
  try {
    const psPath = `Registry::HKCU\\${psEscape(keyPath)}`;
    const psCommand = `if (Test-Path '${psPath}') { Remove-Item -Path '${psPath}' -Recurse -Force }`;
    spawnSync('powershell', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCommand
    ], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  } catch (e) {
    // Best-effort cleanup
  }
}

/**
 * Delete a registry key from HKLM using PowerShell.
 */
function regDeleteKeyHKLM(keyPath) {
  try {
    const psPath = `Registry::HKLM\\${psEscape(keyPath)}`;
    const psCommand = `if (Test-Path '${psPath}') { Remove-Item -Path '${psPath}' -Recurse -Force }`;
    spawnSync('powershell', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCommand
    ], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  } catch (e) {
    // Best-effort cleanup
  }
}

/**
 * Kill all processes related to the app.
 */
function killAppProcesses(installPath) {
  const targets = [APP_EXE, '浮灵饰界 Helper.exe', '浮灵饰界 Helper (Renderer).exe', '浮灵饰界 Helper (GPU).exe'];

  for (const target of targets) {
    spawnSync('taskkill', ['/IM', target, '/F', '/T'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  }

  // Kill any process running from the install directory (PowerShell = Unicode-safe)
  try {
    const escapedPath = psEscape(installPath);
    const psCommand = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${escapedPath}', [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    spawnSync('powershell', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCommand
    ], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  } catch (e) {
    // Best-effort — taskkill by name should be sufficient
  }
}

/**
 * Wait for a process (by image name) to fully exit.
 */
function waitForProcessExit(exeName, timeoutMs = 5000) {
  const start = Date.now();
  const procName = exeName.replace(/\.exe$/i, '');
  const escapedName = psEscape(procName);
  while (Date.now() - start < timeoutMs) {
    const psCommand = `if (Get-Process -Name '${escapedName}' -ErrorAction SilentlyContinue) { 'RUNNING' } else { 'EXITED' }`;
    const result = spawnSync('powershell', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCommand
    ], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (result.stdout && result.stdout.trim() === 'EXITED') return true;
    spawnSync('cmd', ['/c', 'timeout /t 1 /nobreak >nul'], { stdio: 'ignore', timeout: 3000, windowsHide: true });
  }
  return false;
}

/**
 * Schedule silent self-deletion of the entire install directory.
 *
 * A hidden, detached PowerShell process is launched that:
 * 1. Waits for uninstaller.exe (this process) to fully exit
 * 2. Recursively deletes the whole install directory (including the
 *    uninstaller itself and every sub-file/sub-folder) with retries
 *
 * The script is passed inline via -EncodedCommand so no temporary file is
 * left on disk, and -WindowStyle Hidden guarantees no command window appears.
 * This runs in the background without any user confirmation or intervention.
 */
function scheduleSelfDeletion(installPath) {
  try {
    const normInstallPath = installPath.replace(/\//g, '\\');
    // Escape single quotes for safe use inside a PowerShell single-quoted string
    const safePath = normInstallPath.replace(/'/g, "''");

    const psScript = `
$ErrorActionPreference = 'Stop'
$installPath = '${safePath}'

# 等待卸载程序自身完全退出（最多约 30 秒）
$waited = 0
while ($waited -lt 30) {
    $proc = Get-Process -Name 'uninstaller' -ErrorAction SilentlyContinue
    if (-not $proc) { break }
    Start-Sleep -Seconds 1
    $waited++
}
Start-Sleep -Seconds 2

# 静默递归删除整个安装目录（含所有子文件与子文件夹），带重试以应对文件被短暂占用
$maxRetry = 20
$retry = 0
while ($retry -lt $maxRetry) {
    try {
        if (Test-Path $installPath) {
            Remove-Item -Path $installPath -Recurse -Force -ErrorAction Stop
        }
        break
    } catch {
        $retry++
        Start-Sleep -Seconds 1
    }
}
`;

    const psExe = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
    );
    // 使用 -EncodedCommand 内联脚本（UTF-16LE Base64），不在磁盘留下临时文件
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    spawn(psExe, [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle', 'Hidden',
      '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encoded
    ], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (e) {
    // 最佳努力清理：若此处异常，安装目录可能残留，但已尽量在后台静默处理
  }
}

