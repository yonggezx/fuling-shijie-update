const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const APP_NAME = '浮灵饰界';
// 版本号改为运行时从 package.json 读取，避免硬编码导致“安装器版本变了但内部版本仍是旧值”。
// installer-app/package.json 的 version 由 scripts/build-web-installer.js 同步自根 package.json，
// 因此这里是单一真相来源，无需手动在多处维护版本字符串。
function getAppVersion() {
  try {
    return require('./package.json').version;
  } catch (e) {
    return '1.0.3';
  }
}
const APP_VERSION = getAppVersion();
const APP_EXE = '浮灵饰界.exe';
const UNINSTALLER_EXE = 'uninstaller.exe';
const REG_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Fuling_Shijie';

const isDev = !app.isPackaged;
const resourcesPath = isDev
  ? path.join(__dirname, 'resources')
  : process.resourcesPath;
// ★ 改用 zip 格式 + PowerShell Expand-Archive 解压，完全不依赖外部 7z.exe
const appZipPath = path.join(resourcesPath, 'app.zip');
const rceditPath = path.join(resourcesPath, 'rcedit.exe');

let mainWindow;

// ========== Mode Detection ==========
// Detect uninstall mode using multiple layered signals for robustness:
//   Signal 1: --uninstall command-line flag (set by Add/Remove Programs UninstallString)
//   Signal 2: PORTABLE_EXECUTABLE_FILE filename contains "uninstall"/"uninst" (double-click)
//   Signal 3: .uninstaller marker file exists next to the original exe (written during install)
//   Signal 4: 浮灵饰界.exe exists in the same directory (heuristic: running from install dir)
//
// CRITICAL: process.execPath in a portable Electron app points to the TEMP extraction
// directory and keeps the build-time name (e.g. "浮灵饰界_Setup_v1.0.3.exe"), NOT the
// original file the user double-clicked. We must use PORTABLE_EXECUTABLE_FILE to get
// the actual exe path the user ran. If PORTABLE_EXECUTABLE_FILE is unavailable, signals
// 3 and 4 provide fallback detection.
const MARKER_FILE = '.uninstaller';
const explicitUninstall = process.argv.includes('--uninstall');
const explicitInstall = process.argv.includes('--install');
let isUninstallMode = explicitUninstall;

if (!isDev && !explicitUninstall && !explicitInstall) {
  const originalExePath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const exeName = path.basename(originalExePath).toLowerCase();
  const exeDir = path.dirname(originalExePath);

  // Debug log for troubleshooting mode detection issues
  try {
    const debugPath = path.join(process.env.TEMP || process.env.TMP || '.', 'fuling_shijie_installer_debug.log');
    const debugInfo = JSON.stringify({
      time: new Date().toISOString(),
      argv: process.argv,
      PORTABLE_EXECUTABLE_FILE: process.env.PORTABLE_EXECUTABLE_FILE || '(not set)',
      execPath: process.execPath,
      exeName, exeDir, isDev
    }, null, 2);
    fs.appendFileSync(debugPath, debugInfo + '\n---\n', 'utf8');
  } catch (e) { /* best-effort logging */ }

  // Signal 2: Filename contains "uninstall"
  if (exeName.includes('uninstall') || exeName.includes('uninst')) {
    isUninstallMode = true;
  }
  // Signal 3: Marker file written during install exists next to the exe
  else if (fs.existsSync(path.join(exeDir, MARKER_FILE))) {
    isUninstallMode = true;
  }
  // Signal 4: 浮灵饰界.exe in the same directory → running from install directory
  else if (fs.existsSync(path.join(exeDir, APP_EXE))) {
    isUninstallMode = true;
  }
}

// Prevent the uninstaller from interacting with the main app's single-instance lock
if (isUninstallMode) {
  app.requestSingleInstanceLock();
  app.on('second-instance', () => {
    // Another instance tried to start - focus our window instead
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function getDefaultInstallPath() {
  if (isUninstallMode) {
    // Try registry first
    const regPath = regQueryValue(REG_KEY, 'InstallLocation');
    if (regPath && fs.existsSync(regPath)) {
      return regPath;
    }
    // Fallback: the uninstaller.exe lives inside the install directory
    const originalExe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    if (originalExe) {
      const dir = path.dirname(originalExe);
      if (fs.existsSync(dir)) {
        return dir;
      }
    }
    return '';
  }
  const existing = regQueryValue(REG_KEY, 'InstallLocation');
  if (existing && fs.existsSync(existing)) {
    return existing;
  }
  return path.join(process.env.LOCALAPPDATA || 'C:\\Program Files', APP_NAME);
}

function getInstalledVersion() {
  return regQueryValue(REG_KEY, 'DisplayVersion') || APP_VERSION;
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
  const defaultPath = isUninstallMode
    ? (existing.installPath || getDefaultInstallPath())
    : (existing.installPath || path.join(process.env.LOCALAPPDATA || 'C:\\Program Files', APP_NAME));

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('init', {
      mode: isUninstallMode ? 'uninstall' : 'install',
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

// ========== IPC: Browse Directory ==========
ipcMain.handle('browse-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择安装目录'
  });
  return result.filePaths[0] || null;
});

// ========== IPC: Get Disk Space ==========
ipcMain.handle('get-disk-space', async (event, dirPath) => {
  try {
    const drive = path.resolve(dirPath).substring(0, 2);
    // ★ 使用 PowerShell Get-CimInstance 替代已弃用的 wmic
    const psCommand = `$d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}'"; if ($d) { Write-Output ($d.FreeSpace + ',' + $d.Size) } else { Write-Output '0,0' }`;
    const result = spawnSync('powershell', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCommand
    ], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    const line = (result.stdout || '').trim().split('\n').filter(l => l.trim())[0] || '0,0';
    const parts = line.split(',');
    const freeSpace = parseInt(parts[0]) || 0;
    const totalSize = parseInt(parts[1]) || 0;
    return { freeSpace, totalSize, ok: freeSpace > 2 * 1024 * 1024 * 1024 };
  } catch (e) {
    return { freeSpace: 0, totalSize: 0, ok: true };
  }
});

// ========== IPC: Start Install ==========
ipcMain.handle('start-install', async (event, opts) => {
  const { installPath: selectedInstallPath, createDesktopShortcut, createStartMenuShortcut } = opts;

  // 在用户所选目录内再生成一个以程序命名的子文件夹（如 "...\浮灵饰界"），
  // 所有解压/写入都落在该子文件夹内，卸载时只删除这个子文件夹。
  const installPath = resolveInstallDir(selectedInstallPath);

  const sendProgress = (pct, status, logType, logMsg) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('install-progress', { pct, status, logType, logMsg });
    }
  };

  try {
    // Step 0: Detect and clean up existing installation if overwriting
    const existing = detectExistingInstall();
    if (existing.installed && pathsEqual(existing.installPath, installPath)) {
      sendProgress(1, '检测到已安装版本', 'info', `发现 ${APP_NAME} ${existing.displayVersion || '旧版本'}，准备覆盖安装`);

      // Aggressively terminate the app and any process running from the install dir.
      // Sometimes the main process keeps handles open even after taskkill returns.
      for (let attempt = 1; attempt <= 3; attempt++) {
        sendProgress(1, '正在停止运行中的进程...', 'info', `第 ${attempt}/3 次尝试停止旧进程`);
        killAppProcesses(installPath);
        const exited = waitForProcessExit(APP_EXE, 4000);
        if (exited) break;
      }

      // If resources/app.asar is still locked, extract to a temp directory first,
      // then use a background batch script to move the new resources folder into place
      // after the old process fully exits (releasing all file handles).
      const resourcesDir = path.join(installPath, 'resources');
      const appAsarPath = path.join(resourcesDir, 'app.asar');
      if (fs.existsSync(appAsarPath)) {
        try {
          const oldResourcesDir = path.join(installPath, `resources.old.${Date.now()}`);
          fs.renameSync(resourcesDir, oldResourcesDir);
          sendProgress(3, '已重命名旧资源目录', 'info', `原 resources 已重命名，避免文件锁定导致解压失败`);
          await new Promise(r => setTimeout(r, 500));
          // If resources dir still exists (e.g. recreated by a lingering process), force-delete it
          if (fs.existsSync(resourcesDir)) {
            try {
              fs.rmSync(resourcesDir, { recursive: true, force: true });
              sendProgress(3, '已强制删除残留 resources 目录', 'info', '');
            } catch (rmErr) {
              sendProgress(3, '无法删除残留目录', 'warn', rmErr.message);
            }
          }
        } catch (renameErr) {
          sendProgress(3, '旧资源目录重命名失败', 'warn', `将尝试直接覆盖: ${renameErr.message}`);
        }
      }

      // Skip removeOldAppFiles for overwrite installs — the background batch script
      // will handle file replacement safely after the old process exits.
      // This prevents the install directory from being left empty if the batch fails.
      const isOverwriteInstall = existing.installed && pathsEqual(existing.installPath, installPath);
      if (!isOverwriteInstall) {
        removeOldAppFiles(installPath);
      }
      sendProgress(4, '旧版本清理完成', 'success', '准备安装新版本');
    }

    // Step 1: Create install directory
    sendProgress(5, '正在创建安装目录...', 'info', `安装路径: ${installPath}`);
    if (!fs.existsSync(installPath)) {
      fs.mkdirSync(installPath, { recursive: true });
    }
    sendProgress(8, '安装目录已就绪', 'success', '安装目录创建成功');

    // Step 2: Extract app.7z using bundled 7z.exe
    // For overwrite installs with locked files: extract to temp dir first, then move.
    sendProgress(10, '正在解压程序文件...', 'info', '开始解压核心文件...');

    // Determine extraction target: if overwriting and resources might be locked,
    // extract to a temp subdirectory instead of directly into installPath.
    // (existing was already detected in Step 0 above)
    const isOverwrite = existing.installed && pathsEqual(existing.installPath, installPath);
    const tempExtractDir = isOverwrite ? path.join(installPath, `_extract_temp_${Date.now()}`) : installPath;

    // Ensure temp dir exists
    if (!fs.existsSync(tempExtractDir)) {
      fs.mkdirSync(tempExtractDir, { recursive: true });
    }

    // ★ 改用 zip 格式 + PowerShell Expand-Archive 解压，完全不依赖外部 7z.exe
    // 避免 7z 版本兼容性和 "Cannot open the file as archive" 问题
    try {
      // 检查归档文件是否存在
      if (!fs.existsSync(appZipPath)) {
        throw new Error(`应用归档不存在: ${appZipPath}（可能被杀毒软件删除，请关闭杀毒软件后重试）`);
      }
      const zipStat = fs.statSync(appZipPath);
      if (zipStat.size < 1024) {
        throw new Error(`归档文件过小 (${zipStat.size} bytes)，可能损坏。`);
      }
      // 验证 zip 文件头（PK\x03\x04）
      const fd = fs.openSync(appZipPath, 'r');
      const headerBuf = Buffer.alloc(4);
      fs.readSync(fd, headerBuf, 0, 4, 0);
      fs.closeSync(fd);
      const isZip = headerBuf[0] === 0x50 && headerBuf[1] === 0x4b; // PK
      if (!isZip) {
        throw new Error(`归档文件头无效，不是有效的 zip 归档。可能被杀毒软件修改。`);
      }
      sendProgress(10, '正在解压程序文件...', 'info',
        `归档大小=${(zipStat.size/1024/1024).toFixed(1)} MB, 有效zip=true`);
    } catch (diagErr) {
      sendProgress(-1, '安装失败', 'error', `解压前诊断失败: ${diagErr.message}`);
      return { success: false, error: diagErr.message };
    }

    // 使用 PowerShell Expand-Archive 解压 zip
    let extractSuccess = false;
    try {
      await new Promise((resolve, reject) => {
        // PowerShell 命令：Expand-Archive -Path <zip> -DestinationPath <dir> -Force
        const psCommand = `Expand-Archive -Path '${appZipPath}' -DestinationPath '${tempExtractDir}' -Force`;
        const child = spawn('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-Command', psCommand
        ], { encoding: 'utf8', windowsHide: true });

        let lastPct = 10;
        let buffer = '';

        child.stdout.on('data', (data) => {
          buffer += data.toString();
        });

        child.stderr.on('data', (data) => {
          const text = data.toString().trim();
          if (text) {
            sendProgress(lastPct, '正在解压程序文件...', 'error', text);
          }
        });

        child.on('close', (code) => {
          if (code === 0) {
            extractSuccess = true;
            sendProgress(88, '程序文件解压完成', 'success', '所有文件解压成功');
            resolve();
          } else {
            reject(new Error(`PowerShell 解压失败，错误码: ${code}`));
          }
        });

        child.on('error', (err) => {
          reject(new Error(`无法启动 PowerShell: ${err.message}`));
        });
      });
    } catch (extractErr) {
      sendProgress(-1, '安装失败', 'error', `解压失败: ${extractErr.message}`);
      return { success: false, error: extractErr.message };
    }

    // 覆盖安装：临时解压目录里的新文件【同步】复制到安装目录，覆盖旧文件。
    // 关键修复：不再依赖后台脚本（易因 wscript/时序问题导致「覆盖后启动的还是旧版本」），
    // 而是安装线程内同步完成 + 校验，保证上报「安装完成」时新程序包已落地。
    if (isOverwrite && tempExtractDir !== installPath) {
      sendProgress(89, '正在替换旧版本文件...', 'info', '同步复制新文件到安装目录');
      const moved = syncMoveExtractedToInstall(installPath, tempExtractDir);
      if (!moved) {
        throw new Error('覆盖安装时新文件复制失败，请先关闭正在运行的程序后重试');
      }
      // 校验：新程序包已就位（resources/app.asar 存在）
      const asarPath = path.join(installPath, 'resources', 'app.asar');
      if (!fs.existsSync(asarPath)) {
        throw new Error('覆盖安装后未找到程序包 resources/app.asar，安装可能不完整');
      }
      sendProgress(89, '旧版本文件已替换', 'success', '新版本文件已写入安装目录');
    }

    // Step 2b: Clean up any renamed old resources folders from a previous overwrite install
    try {
      const entries = fs.readdirSync(installPath);
      for (const entry of entries) {
        if (entry.startsWith('resources.old.')) {
          const oldDir = path.join(installPath, entry);
          fs.rmSync(oldDir, { recursive: true, force: true });
        }
      }
    } catch (e) { /* best-effort cleanup */ }

    // Step 3: Create shortcuts
    const appExePath = path.join(installPath, APP_EXE);

    if (createDesktopShortcut) {
      sendProgress(90, '正在创建桌面快捷方式...', 'info', '创建桌面快捷方式');
      const desktopPath = path.join(process.env.USERPROFILE, 'Desktop', `${APP_NAME}.lnk`);
      createShortcut(desktopPath, appExePath, installPath);
      sendProgress(93, '桌面快捷方式已创建', 'success', '桌面快捷方式创建完成');
    } else {
      sendProgress(93, '跳过桌面快捷方式', 'info', '');
    }

    if (createStartMenuShortcut) {
      sendProgress(94, '正在创建开始菜单快捷方式...', 'info', '创建开始菜单快捷方式');
      const startMenuPath = path.join(
        process.env.APPDATA,
        'Microsoft', 'Windows', 'Start Menu', 'Programs',
        `${APP_NAME}.lnk`
      );
      createShortcut(startMenuPath, appExePath, installPath);
      sendProgress(96, '开始菜单快捷方式已创建', 'success', '开始菜单快捷方式创建完成');
    } else {
      sendProgress(96, '跳过开始菜单快捷方式', 'info', '');
    }

    // Step 4: Copy pre-built uninstaller (separate Electron app with its own PE description)
    sendProgress(97, '正在注册卸载程序...', 'info', '写入卸载程序');
    const uninstallerPath = path.join(installPath, UNINSTALLER_EXE);
    let uninstallerReady = false;

    const bundledUninstaller = path.join(resourcesPath, 'uninstaller.exe');
    if (fs.existsSync(bundledUninstaller)) {
      try {
        fs.copyFileSync(bundledUninstaller, uninstallerPath);
        sendProgress(97, '卸载程序已写入', 'success', '使用独立卸载器（PE描述: 卸载向导）');
        uninstallerReady = true;
      } catch (copyErr) {
        sendProgress(97, '卸载器复制失败', 'warn', copyErr.message);
      }
    }

    if (!uninstallerReady) {
      // Fallback: copy this portable exe as uninstaller
      try {
        const portableExePath = process.env.PORTABLE_EXECUTABLE_FILE;
        if (portableExePath && fs.existsSync(portableExePath)) {
          fs.copyFileSync(portableExePath, uninstallerPath);
          sendProgress(97, '卸载程序已写入', 'info', '使用安装器作为卸载器（回退方案）');
          uninstallerReady = true;
        } else {
          fs.copyFileSync(process.execPath, uninstallerPath);
          uninstallerReady = true;
        }
      } catch (copyErr) {
        sendProgress(97, '使用脚本卸载方案', 'info', '创建批处理卸载器');
        createBatchUninstaller(installPath);
      }
    }

    // Write marker file for reliable uninstall mode detection.
    // When the uninstaller.exe (a copy of this portable exe) is double-clicked without
    // --uninstall flag, the mode detection checks for this marker file as a fallback
    // signal that the exe is running from an install directory (not as a fresh setup).
    try {
      fs.writeFileSync(path.join(installPath, MARKER_FILE), APP_VERSION, { encoding: 'utf8' });
    } catch (e) { /* non-fatal */ }

    // Step 5: Write registry entries (Add/Remove Programs)
    sendProgress(98, '正在写入注册表信息...', 'info', '注册到系统程序列表');
    writeRegistry(installPath, uninstallerPath);
    sendProgress(99, '注册表写入完成', 'success', '系统注册完成');

    sendProgress(100, '安装完成', 'success', `${APP_NAME} v${APP_VERSION} 安装成功！`);

    return { success: true, installPath };
  } catch (error) {
    sendProgress(-1, '安装失败', 'error', `错误: ${error.message}`);
    return { success: false, error: error.message };
  }
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
    // Step 1: Kill ALL processes from the install directory (not just by name)
    sendProgress(5, '正在停止运行中的进程...', 'info', '检查并停止 浮灵饰界 及相关进程');
    killAppProcesses(installPath);
    // Wait for processes to fully exit (file handles need to be released)
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

    // Step 3: Delete app files (skip uninstaller.exe and _cleanup.bat — they'll be handled later)
    sendProgress(25, '正在删除程序文件...', 'info', '开始删除程序文件');

    const failedDeletions = [];
    if (fs.existsSync(installPath)) {
      const entries = fs.readdirSync(installPath);
      const skipFiles = [UNINSTALLER_EXE, '_cleanup.bat', MARKER_FILE];
      const toDelete = entries.filter(f => !skipFiles.includes(f));
      let deletedCount = 0;
      const totalCount = toDelete.length;

      for (const entry of toDelete) {
        const entryPath = path.join(installPath, entry);
        try {
          fs.rmSync(entryPath, { recursive: true, force: true });
        } catch (e) {
          failedDeletions.push(entry);
        }
        deletedCount++;
        const pct = 25 + Math.round((deletedCount / Math.max(totalCount, 1)) * 55);
        sendProgress(pct, '正在删除程序文件...', 'info', `已删除: ${entry}`);
      }

      if (failedDeletions.length > 0) {
        sendProgress(80, `${failedDeletions.length} 个文件待清理`, 'info',
          `将在退出后清理: ${failedDeletions.slice(0, 3).join(', ')}${failedDeletions.length > 3 ? '...' : ''}`);
      }
    }

    sendProgress(80, '程序文件已删除', 'success', '所有程序文件已删除');

    // Step 4: Remove registry
    sendProgress(85, '正在清理注册表信息...', 'info', '移除系统注册表项');
    regDeleteKey(REG_KEY);
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

    // Schedule self-deletion of the entire install directory (the generated subfolder)
    scheduleSelfDeletion(installPath);

    return { success: true };
  } catch (error) {
    sendProgress(-1, '卸载失败', 'error', `错误: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// ========== IPC: Launch App ==========
ipcMain.handle('launch-app', async (event, { installPath }) => {
  const exePath = path.join(installPath, APP_EXE);
  if (fs.existsSync(exePath)) {
    spawn(exePath, [], { detached: true, stdio: 'ignore' }).unref();
    return true;
  }
  return false;
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
 * Uses base64 encoding to bypass all console/pipe encoding issues — the value
 * is encoded as UTF-8 bytes → base64 inside PowerShell, then decoded in Node.js.
 * This is 100% reliable for Chinese paths on Windows PowerShell 5.1.
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
 * Write a registry value to HKCU using PowerShell (UTF-8 safe for Chinese paths).
 */
function regWriteValue(keyPath, valueName, value, type = 'String') {
  try {
    const psPath = `Registry::HKCU\\${psEscape(keyPath)}`;
    const psName = psEscape(valueName);
    const psValue = psEscape(value);
    const psCommand = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
$p = '${psPath}'
if (-not (Test-Path $p)) { New-Item -Path $p -Force | Out-Null }
New-ItemProperty -Path $p -Name '${psName}' -Value '${psValue}' -PropertyType ${type} -Force | Out-Null
`.trim();
    spawnSync('powershell', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCommand
    ], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  } catch (e) {
    // Registry write failures are not fatal for installation itself
  }
}

/**
 * Delete a registry key (and all subkeys/values) from HKCU using PowerShell.
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

function pathsEqual(a, b) {
  if (!a || !b) return false;
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/**
 * 计算实际安装目录：始终在用户所选目录内再生成一个以程序命名的子文件夹
 * （如 "...\浮灵饰界"），解压内容都落在该子文件夹内；卸载时也只删除这个
 * 子文件夹，而不会误删用户所选的上级目录。
 * 若用户已选到程序同名文件夹本身，则避免重复嵌套。
 */
function resolveInstallDir(userPath) {
  if (!userPath) return userPath;
  if (path.basename(userPath) === APP_NAME) return userPath;
  return path.join(userPath, APP_NAME);
}

/**
 * Remove existing application files before overwriting, while preserving
 * user data and the uninstaller files we are about to replace.
 * Also preserves any resources.old.* folders that were renamed because the
 * original resources folder was locked by a running process.
 */
function removeOldAppFiles(installPath) {
  if (!fs.existsSync(installPath)) return;
  const entries = fs.readdirSync(installPath);
  const skipFiles = [UNINSTALLER_EXE, '_cleanup.bat', '_update_resources.bat', '_cleanup.vbs', '_update_resources.vbs', MARKER_FILE];
  for (const entry of entries) {
    if (skipFiles.includes(entry)) continue;
    if (entry.startsWith('resources.old.')) continue;
    if (entry.startsWith('_extract_temp_')) continue;
    const entryPath = path.join(installPath, entry);
    try {
      fs.rmSync(entryPath, { recursive: true, force: true });
    } catch (e) {
      // Files may be locked; the 7z extraction will overwrite them anyway
    }
  }
}

/**
 * Kill all processes related to the app:
 * 1. Kill by known exe name (浮灵饰界.exe) including child processes (/T)
 * 2. Kill any process whose executable path is inside the install directory
 *    Uses PowerShell (Unicode-safe) instead of wmic (ANSI-only, breaks Chinese paths).
 * 3. Also kill common Electron helper processes spawned by the main app.
 */
function killAppProcesses(installPath) {
  const targets = [APP_EXE, '浮灵饰界 Helper.exe', '浮灵饰界 Helper (Renderer).exe', '浮灵饰界 Helper (GPU).exe'];

  for (const target of targets) {
    // /T = terminate process tree, /F = force
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
 * Uses PowerShell Get-Process (Unicode-safe) instead of tasklist (ANSI-only,
 * breaks Chinese exe names like "浮灵饰界.exe").
 * Polls every 500ms up to timeoutMs.
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

function createShortcut(lnkPath, targetPath, workingDir) {
  const escaped = (s) => s.replace(/'/g, "''").replace(/\\/g, '\\\\');
  const psScript = `
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut('${escaped(lnkPath)}')
$sc.TargetPath = '${escaped(targetPath)}'
$sc.WorkingDirectory = '${escaped(workingDir)}'
$sc.IconLocation = '${escaped(targetPath)},0'
$sc.Description = '浮灵饰界 - 智能桌面宠物助手'
$sc.Save()
`.trim();
  spawnSync('powershell', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-Command', psScript
  ], { encoding: 'utf8', timeout: 10000, windowsHide: true });
}

function writeRegistry(installPath, uninstallerPath) {
  const entries = [
    ['DisplayName', 'String', APP_NAME],
    ['DisplayVersion', 'String', APP_VERSION],
    ['InstallLocation', 'String', installPath],
    ['UninstallString', 'String', `"${uninstallerPath}" --uninstall`],
    ['DisplayIcon', 'String', path.join(installPath, APP_EXE)],
    ['Publisher', 'String', '浮灵饰界'],
    ['NoModify', 'DWord', '1'],
    ['NoRepair', 'DWord', '1'],
  ];

  for (const [name, type, value] of entries) {
    regWriteValue(REG_KEY, name, value, type);
  }
}

function createBatchUninstaller(installPath) {
  const batPath = path.join(installPath, 'uninstall.bat');
  const batContent = [
    '@echo off',
    'chcp 65001 >nul',
    `taskkill /IM "${APP_EXE}" /F >nul 2>&1`,
    `del /q "%USERPROFILE%\\Desktop\\${APP_NAME}.lnk" >nul 2>&1`,
    `del /q "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\${APP_NAME}.lnk" >nul 2>&1`,
    `reg delete "HKCU\\${REG_KEY}" /f >nul 2>&1`,
    `cd /d "${installPath}"`,
    'for /f "delims=" %%f in (\'dir /b *.*\') do (',
    '  if /I not "%%f"=="uninstall.bat" (',
    '    del /q /s /f "%%f" >nul 2>&1',
    '  )',
    ')',
    'del /q "%~f0"',
    ''
  ].join('\r\n');
  fs.writeFileSync(batPath, batContent, { encoding: 'utf8' });
}

/**
 * 卸载完成后，在后台静默、递归删除整个安装目录（即安装时生成的以程序命名的
 * 子文件夹，例如 "...\浮灵饰界"），包括 uninstaller.exe 自身及所有子文件/子文件夹。
 *
 * 通过 -EncodedCommand 内联 UTF-16LE Base64 脚本，不在磁盘留下临时文件；
 * -WindowStyle Hidden + windowsHide:true + detached 保证不弹出任何命令窗口，
 * 且无需用户再次确认。带重试以应对个别文件被短暂占用的情况。
 */
function scheduleSelfDeletion(installPath) {
  try {
    const normInstallPath = installPath.replace(/\//g, '\\');
    // 转义单引号，以便在 PowerShell 单引号字符串中安全使用
    const safePath = normInstallPath.replace(/'/g, "''");

    const psScript = `
$ErrorActionPreference = 'Stop'
$installPath = '${safePath}'

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

/**
 * 覆盖安装：把临时解压目录里的新文件【同步】复制到安装目录，覆盖旧文件。
 * 这样不需要后台脚本，安装线程内同步完成 + 校验，保证上报「安装完成」时新程序包已落地，
 * 彻底修复「覆盖安装后启动的还是旧版本」。
 * - 先把 installPath/resources 改名移开，避免仍被旧进程锁定的 app.asar 阻碍覆盖
 *   （前面已 kill 并等待旧进程退出，正常情况下已无锁，这里只是双保险）。
 * - 用 robocopy /E /IS /IT 同步复制（含子目录、按内容强制覆盖），/R:5 /W:2 应对偶发锁。
 * - robocopy 退出码 0-7 均属成功（>=8 为失败）。
 * - 复制完成后清理临时解压目录与历史遗留的 resources.old.*。
 * 返回 true 表示成功。
 */
function syncMoveExtractedToInstall(installPath, tempExtractDir) {
  try {
    const resourcesDir = path.join(installPath, 'resources');
    if (fs.existsSync(resourcesDir)) {
      try {
        const oldRes = path.join(installPath, `resources.old.${Date.now()}`);
        fs.renameSync(resourcesDir, oldRes); // 移到一旁，让 robocopy 能以新 resources 覆盖
      } catch (e) {
        // 极少数仍被锁：交给下方 robocopy /IS /IT 原地覆盖
      }
    }
    const norm = (p) => p.replace(/\//g, '\\');
    const src = norm(tempExtractDir);
    const dst = norm(installPath);
    // 注意：robocopy 的源/目标应放在选项之前，避免被当成文件过滤参数。
    const args = [src, dst, '/E', '/IS', '/IT', '/R:5', '/W:2', '/NFL', '/NDL', '/NJH', '/NJS'];
    const res = spawnSync('robocopy', args, { encoding: 'utf8', timeout: 180000, windowsHide: true });
    const code = (typeof res.status === 'number') ? res.status : 1;
    const ok = code <= 7; // robocopy: 0-7 成功（0=无变化,1=复制成功,2=有额外文件...）

    // 清理临时解压目录
    try { fs.rmSync(tempExtractDir, { recursive: true, force: true }); } catch (e) {}
    // 清理本次及历史遗留的 resources.old.*
    try {
      const entries = fs.readdirSync(installPath);
      for (const entry of entries) {
        if (entry.startsWith('resources.old.')) {
          try { fs.rmSync(path.join(installPath, entry), { recursive: true, force: true }); } catch (e) {}
        }
      }
    } catch (e) {}

    return ok;
  } catch (e) {
    return false;
  }
}
