#!/usr/bin/env node
/**
 * 构建「桌面分身」宿主（纯 Win32 C++，MSVC 编译，无 .NET 依赖）。
 *
 * 为什么需要这一步：
 *   桌面分身的预览窗由 tools/RdpHost.Native 里的原生 Win32 宿主（进程名 桌面分身.exe）提供。
 *   打包安装包（build:win-dir / build:web-installer）时，package.json 的 build.files
 *   只把 tools/RdpHost.Native/桌面分身.exe 打进 app.asar.unpacked，
 *   并不会自动编译。若宿主没先编译好，打出来的安装包就缺 桌面分身.exe，
 *   运行时 spawn 失败 →「打开桌面分身」在打包版里起不来。
 *
 * 行为：
 *   - 增量：若 桌面分身.exe 已存在且新于 RdpHostNative.cpp / build-native-host.ps1 等源文件，直接跳过（省时）。
 *   - 否则跑 powershell -ExecutionPolicy Bypass -File tools/RdpHost.Native/build-native-host.ps1
 *     （MSVC cl.exe 编译，产物落在 tools/RdpHost.Native/桌面分身.exe）。
 *   - 编译器缺失或编译失败 → exit(1，阻断打包链，避免产出缺宿主的残包）。
 */
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const hostDir = path.join(root, 'tools', 'RdpHost.Native');
const exePath = path.join(hostDir, '桌面分身.exe');
const buildScript = path.join(hostDir, 'build-native-host.ps1');

function log(msg) { console.log('[build-rdp-host] ' + msg); }

/** 取 hostDir 下所有源文件（.cpp/.h/.hpp/.ps1/.rc/.ico）里最新的 mtime（ms）；无源文件返回 0 */
function newestSrcMtime() {
  let latest = 0;
  try {
    const stack = [hostDir];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === 'obj') continue; // 跳过编译中间产物
          stack.push(full);
        } else if (e.isFile() && /\.(cpp|h|hpp|ps1|rc|ico)$/i.test(e.name)) {
          const m = fs.statSync(full).mtimeMs;
          if (m > latest) latest = m;
        }
      }
    }
  } catch (e) { /* 忽略 */ }
  return latest;
}

// 增量跳过
if (fs.existsSync(exePath)) {
  const exeMtime = fs.statSync(exePath).mtimeMs;
  const srcMtime = newestSrcMtime();
  if (exeMtime >= srcMtime) {
    log('宿主已是最新（' + path.relative(root, exePath) + '），跳过编译。');
    process.exit(0);
  }
  log('检测到源文件有更新，重新编译宿主…');
} else {
  log('宿主未编译，开始编译 桌面分身.exe …');
}

// 检查构建脚本存在
if (!fs.existsSync(buildScript)) {
  console.error('\n[build-rdp-host] ✗ 找不到构建脚本 ' + path.relative(root, buildScript) + '，打包链中止。');
  process.exit(1);
}

// 调用 build-native-host.ps1（MSVC 编译，工具链路径见该脚本内硬编码的 VS2022 BuildTools）
const r = spawnSync('powershell.exe', [
  '-NoProfile', '-ExecutionPolicy', 'Bypass',
  '-File', buildScript
], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
});

if (r.error || r.status !== 0) {
  console.error('\n[build-rdp-host] ✗ 桌面分身宿主编译失败，打包链中止（避免产出缺宿主的残包）。');
  console.error('[build-rdp-host]   请确认已安装 VS2022 Build Tools（含 C++ 桌面开发工作负载），或手动执行：');
  console.error('[build-rdp-host]   powershell -ExecutionPolicy Bypass -File tools/RdpHost.Native/build-native-host.ps1');
  process.exit(1);
}

if (!fs.existsSync(exePath)) {
  console.error('[build-rdp-host] ✗ 编译完成但未找到 ' + exePath);
  process.exit(1);
}
log('宿主编译完成：' + path.relative(root, exePath));
