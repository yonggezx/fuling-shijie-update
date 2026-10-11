/**
 * Copy installer resources to build/ directory.
 *
 * ⚠️ 历史说明：本脚本早年为 NSIS 安装器拷贝 sidebar/header 位图（installer-sidebar.bmp
 * 等），但项目早已改用 Electron 自定义 web-installer（installer-app），NSIS 那套位图
 * 已废弃、源文件也从 assets/ 删除。继续把它们列为"必拷"会导致缺失即 exit(1)，
 * 进而阻断整条安装包构建链路（prebuild 失败 → electron-builder --dir 不跑 → app.zip
 * 打出空包）。现仅保留真正被 web-installer 用到的 icon.ico 与 LICENSE。
 */
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const buildDir = path.join(projectRoot, 'build');
const assetsDir = path.join(projectRoot, 'assets');

// Ensure build directory exists
if (!fs.existsSync(buildDir)) {
  fs.mkdirSync(buildDir, { recursive: true });
}

// Files to copy: [source (relative to project root), dest (relative to build/)]
// 仅保留 web-installer 实际需要的资源；旧的 NSIS 位图不再打包。
const copies = [
  ['assets/icons/icon.ico', 'build/installer-icon.ico'],
  ['LICENSE', 'build/LICENSE.txt'],
];

console.log('Copying installer build resources...\n');

let allOk = true;
for (const [src, dest] of copies) {
  const srcPath = path.join(projectRoot, src);
  const destPath = path.join(projectRoot, dest);

  if (!fs.existsSync(srcPath)) {
    console.error(`  ✗ NOT FOUND: ${src}`);
    allOk = false;
    continue;
  }

  try {
    fs.copyFileSync(srcPath, destPath);
    console.log(`  ✓ ${src} → ${dest}`);
  } catch (err) {
    console.error(`  ✗ ERROR copying ${src}: ${err.message}`);
    allOk = false;
  }
}

if (allOk) {
  console.log('\nAll build resources copied successfully.');
} else {
  console.error('\nSome resources could not be copied. Build may fail.');
  process.exit(1);
}
