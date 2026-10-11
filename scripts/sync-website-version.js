// 自动同步 package.json 版本号到官网
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const pkgPath = path.join(projectRoot, 'package.json');
const websitePath = path.join(projectRoot, 'ai-lobster-website', 'index.html');

if (!fs.existsSync(pkgPath)) {
  console.error('未找到 package.json');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const version = 'v' + pkg.version;

if (!fs.existsSync(websitePath)) {
  console.error('未找到官网 index.html');
  process.exit(1);
}

let html = fs.readFileSync(websitePath, 'utf8');

// 更新 JS 中的版本号
html = html.replace(
  /const APP_VERSION = 'v[\d.]+';/,
  `const APP_VERSION = '${version}';`
);

// 更新 Footer 中的版本号
html = html.replace(
  /<span id="footer-version">v[\d.]+<\/span>/,
  `<span id="footer-version">${version}</span>`
);

// 更新下载区版本信息
html = html.replace(
  /v[\d.]+\s*·\s*约 \d+MB/,
  `${version} · 约 120MB`
);

// 图片加缓存戳：GitHub Pages 的 CDN/浏览器缓存最长约 10 分钟，
// 不带 ?v= 时用户刷新也会看到旧截图（"图片怎么还是之前的"根因之一）。
const stamp = version.replace(/^v/, '') + '.' + new Date().toISOString().slice(0, 10).replace(/-/g, '') +
  new Date().getHours() + String(new Date().getMinutes()).padStart(2, '0');
html = html.replace(/(images\/[A-Za-z0-9_\-.]+\.png)(\?v=[A-Za-z0-9._-]+)?/g, `$1?v=${stamp}`);
console.log('图片缓存戳:', stamp);

fs.writeFileSync(websitePath, html, 'utf8');
console.log(`官网版本号已同步为: ${version}`);
