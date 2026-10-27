// 自动同步 package.json 版本号到官网（含下载链接里的版本号）
//
// 用法（本地，默认读项目 package.json、更新 ai-lobster-website/index.html）：
//   node scripts/sync-website-version.js
//
// 用法（GitHub Actions，版本号与路径由外部传入）：
//   node scripts/sync-website-version.js --version=v1.0.12 --path=website/index.html
//   --version：本次发布版本号（带 v 前缀，如 v1.0.12），不传则从 package.json 读取
//   --path   ：官网 index.html 的路径，相对于当前工作目录；不传则默认 ai-lobster-website/index.html
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const pkgPath = path.join(projectRoot, 'package.json');

// ---- 解析命令行参数 ----
const args = process.argv.slice(2);
function getArg(name) {
  const prefix = `--${name}=`;
  const hit = args.find(a => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}
const explicitVersion = getArg('version');
const explicitPath = getArg('path');

// ---- 确定版本号 ----
let version;
if (explicitVersion) {
  version = /^v/.test(explicitVersion) ? explicitVersion : 'v' + explicitVersion;
} else {
  if (!fs.existsSync(pkgPath)) {
    console.error('未找到 package.json（且未通过 --version 指定版本号）');
    process.exit(1);
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  version = 'v' + pkg.version;
}
const NUM = version.replace(/^v/, ''); // 不带 v 的数字版本

// ---- 确定官网 index.html 路径 ----
const websitePath = explicitPath
  ? path.resolve(process.cwd(), explicitPath)
  : path.join(projectRoot, 'ai-lobster-website', 'index.html');

if (!fs.existsSync(websitePath)) {
  console.error(`未找到官网 index.html: ${websitePath}`);
  process.exit(1);
}

let html = fs.readFileSync(websitePath, 'utf8');
const before = html;

// 1) 更新下载链接里的版本号（重点：最新版本的下载连接）
//    注意：exe 链接是 _Setup_v1.0.8.exe，v 已包含在 _Setup_v 前缀里，因此用不带 v 的 NUM；
//    dmg/AppImage 链接是 -1.0.8.dmg，同样用不带 v 的 NUM。
html = html.replace(/_Setup_v[0-9.]+\.exe/g, `_Setup_v${NUM}.exe`);
html = html.replace(/download\/-[0-9.]+\.dmg/g, `download/-${NUM}.dmg`);
html = html.replace(/download\/-[0-9.]+\.AppImage/g, `download/-${NUM}.AppImage`);

// 2) 更新 JS 中的版本号
html = html.replace(
  /const APP_VERSION = 'v[\d.]+';/,
  `const APP_VERSION = '${version}';`
);

// 3) 更新 Footer 中的版本号
html = html.replace(
  /<span id="footer-version">v[\d.]+<\/span>/,
  `<span id="footer-version">${version}</span>`
);

// 4) 更新下载区版本信息
html = html.replace(
  /v[\d.]+\s*·\s*约 \d+MB/,
  `${version} · 约 120MB`
);

// 5) 图片加缓存戳：GitHub Pages 的 CDN/浏览器缓存最长约 10 分钟，
//    不带 ?v= 时用户刷新也会看到旧截图（"图片怎么还是之前的"根因之一）。
const stamp = NUM + '.' + new Date().toISOString().slice(0, 10).replace(/-/g, '') +
  new Date().getHours() + String(new Date().getMinutes()).padStart(2, '0');
html = html.replace(/(images\/[A-Za-z0-9_\-.]+\.png)(\?v=[A-Za-z0-9._-]+)?/g, `$1?v=${stamp}`);

if (html === before) {
  console.log(`官网 ${websitePath} 无变更（版本号已是最新 ${version}）。`);
  process.exit(0);
}

fs.writeFileSync(websitePath, html, 'utf8');
console.log(`官网版本号与下载链接已同步为: ${version}`);
console.log('图片缓存戳:', stamp);
console.log('文件:', websitePath);
