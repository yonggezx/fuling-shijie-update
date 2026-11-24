// 自动同步 package.json 版本号到官网（含下载链接里的版本号）
//
// 用法（本地，默认读项目 package.json、更新 ai-lobster-website/index.html）：
//   node scripts/sync-website-version.js
//
// 用法（GitHub Actions，版本号与路径由外部传入）：
//   node scripts/sync-website-version.js --version=v1.0.12 --path=website/index.html
//   --version：本次发布版本号（带 v 前缀，如 v1.0.12），不传则从 package.json 读取
//   --path   ：官网 index.html 的路径，相对于当前工作目录；不传则默认 ai-lobster-website/index.html
//
// ★ 下载链接改为「按真实 release 资产名生成」：
//   安装包名曾经带中文产品名（浮灵饰界_Setup_v1.0.12.exe），但构建/上传环节会把非 ASCII
//   字符剥掉，实际资产变成 _Setup_v1.0.12.exe，官网链接因此 404。
//   现在统一走 ASCII 产物名（见 package.json build.*.artifactName），并且本脚本会先向
//   GitHub API 查询 release 里真实存在的资产名，按扩展名回填链接，避免版本号猜错再 404。
const fs = require('fs');
const path = require('path');
const https = require('https');

const OWNER = 'yonggezx';
const REPO = 'fuling-shijie-update';

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

// ---- 兜底用的规范资产名（与 package.json 的 artifactName 保持一致）----
const FALLBACK = {
  '.exe': `FulingShijie-Installer-Setup-v${NUM}.exe`,
  '.dmg': `FulingShijie-v${NUM}-x64.dmg`,
  '.AppImage': `FulingShijie-v${NUM}.AppImage`,
};

function githubJson(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'fuling-shijie-sync', Accept: 'application/vnd.github+json' },
      timeout: 15000,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch (e) { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

let releaseInfo = null;

// 从 release 资产里挑出各扩展名对应的真实文件名
async function resolveAssetNames() {
  const release = await githubJson(`https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${version}`);
  if (!release || !Array.isArray(release.assets)) return null;
  releaseInfo = release;

  const names = release.assets.map(a => a.name).filter(Boolean);
  const pick = (ext) => {
    const hits = names.filter(n => n.toLowerCase().endsWith(ext.toLowerCase()));
    if (!hits.length) return null;
    // 同一 release 里可能残留旧版本产物（如 -1.0.8.dmg），必须优先本次版本号，
    // 其次优先 ASCII 规范名，最后 macOS 选 Intel(x64) 包（排除 arm64）。
    const score = (n) => {
      let s = 0;
      if (n.includes(`v${NUM}`) || n.includes(`-${NUM}`)) s += 10;
      if (/^FulingShijie-/i.test(n)) s += 5;
      if (!/arm64|aarch64/i.test(n)) s += 2;
      return s;
    };
    return hits.slice().sort((a, b) => score(b) - score(a))[0];
  };

  const result = {};
  for (const ext of Object.keys(FALLBACK)) {
    const hit = pick(ext);
    if (hit) result[ext] = hit;
  }
  return Object.keys(result).length ? result : null;
}

// 像素风格官网（官网仓库 index.html）：版本号、下载链接、包体积都要跟着 release 走。
// 这套页面不用 APP_VERSION / footer-version，直接用文案里的版本号，所以单独处理。
function syncPixelSite(html, version, release) {
  if (!html.includes('DESKTOP PET / LOCAL AGENT')) return html;
  const date = release && release.published_at
    ? release.published_at.slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const assets = (release && release.assets) || [];
  const names = assets.map(a => a.name).filter(Boolean);
  const pick = (re) => names.find(n => re.test(n)) || null;
  const exe = pick(/\.exe$/i) || `FulingShijie-Installer-Setup-v${NUM}.exe`;
  const dmgArm = pick(/arm64.*\.dmg$/i) || `FulingShijie-v${NUM}-arm64.dmg`;
  const dmgX64 = pick(/x64.*\.dmg$/i) || `FulingShijie-v${NUM}-x64.dmg`;
  const appImage = pick(/\.AppImage$/i) || `FulingShijie-v${NUM}.AppImage`;
  const deb = pick(/\.deb$/i) || `FulingShijie-v${NUM}.deb`;
  const sizeOf = (name) => {
    const hit = assets.find(a => a.name === name);
    return hit && typeof hit.size === 'number' ? (hit.size / 1048576).toFixed(1) : null;
  };

  html = html.replace(/<span>BUILD v[\d.]+<\/span>/, `<span>BUILD ${version}</span>`);
  html = html.replace(/(<span class="v">)v[\d.]+(<\/span>)/, `$1${version}$2`);
  html = html.replace(/(<span class="ok">●\s*)v[\d.]+(<\/span>)/, `$1${version}$2`);
  html = html.replace(/按 v[\d.]+ 实际功能整理。/, `按 ${version} 实际功能整理。`);
  html = html.replace(/(<div class="count"><b>)v[\d.]+(<\/b><br>)\d{4}-\d{2}-\d{2}(<\/div>)/, `$1${version}$2${date}$3`);
  html = html.replace(/v[\d.]+ 安装包，按系统选择。/, `${version} 安装包，按系统选择。`);
  html = html.replace(/(<span>)v[\d.]+ · \d{4}-\d{2}-\d{2}(<\/span>)/, `$1${version} · ${date}$2`);
  html = html.replace(/(<span class="green">)v[\d.]+ \/ BUILD OK(<\/span>)/, `$1${version} / BUILD OK$2`);

  html = html.replace(
    /releases\/download\/v[\d.]+\/FulingShijie-Installer-Setup-v[\d.]+\.exe/g,
    `releases/download/${version}/${exe}`
  );
  html = html.replace(
    /releases\/download\/v[\d.]+\/FulingShijie-v[\d.]+-arm64\.dmg/g,
    `releases/download/${version}/${dmgArm}`
  );
  html = html.replace(
    /releases\/download\/v[\d.]+\/FulingShijie-v[\d.]+-x64\.dmg/g,
    `releases/download/${version}/${dmgX64}`
  );
  html = html.replace(
    /releases\/download\/v[\d.]+\/FulingShijie-v[\d.]+\.AppImage/g,
    `releases/download/${version}/${appImage}`
  );
  html = html.replace(
    /releases\/download\/v[\d.]+\/FulingShijie-v[\d.]+\.deb/g,
    `releases/download/${version}/${deb}`
  );

  const exeMB = sizeOf(exe);
  if (exeMB) {
    html = html.replace(/(Windows 安装包 <small>)[\d.]+ MB(<\/small>)/, `$1${exeMB} MB$2`);
    html = html.replace(/(<b>安装包 \.exe<\/b><small>)[\d.]+ MB(<\/small>)/, `$1${exeMB} MB$2`);
  }
  const armMB = sizeOf(dmgArm);
  if (armMB) html = html.replace(/(<b>arm64 \.dmg<\/b><small>)[\d.]+ MB( · M1–M4<\/small>)/, `$1${armMB} MB$2`);
  const x64MB = sizeOf(dmgX64);
  if (x64MB) html = html.replace(/(<b>x64 \.dmg<\/b><small>)[\d.]+ MB( · Intel<\/small>)/, `$1${x64MB} MB$2`);
  const appMB = sizeOf(appImage);
  if (appMB) html = html.replace(/(<b>\.AppImage<\/b><small>)[\d.]+ MB( · chmod \+x 即用<\/small>)/, `$1${appMB} MB$2`);
  const debMB = sizeOf(deb);
  if (debMB) html = html.replace(/(<b>\.deb<\/b><small>)[\d.]+ MB( · Debian \/ Ubuntu<\/small>)/, `$1${debMB} MB$2`);

  return html;
}

(async () => {
  const assets = await resolveAssetNames();
  const names = Object.assign({}, FALLBACK, assets || {});
  if (assets) {
    console.log('已按 release 真实资产名回填:', assets);
  } else {
    console.log('未能从 GitHub API 取到资产名，使用规范默认名（请确认 release 已上传成功）。');
  }

  let html = fs.readFileSync(websitePath, 'utf8');
  const before = html;

  // 1) 下载链接：把 releases/latest/download/<任意文件名>.<ext> 整条替换成真实资产名。
  //    这样无论旧产物名叫 _Setup_v1.0.8.exe / -1.0.8.dmg，都会被纠正为当前版本的正确名字，
  //    不会再出现「版本号更新了但文件名对不上 → 404」。
  const exts = ['.exe', '.dmg', '.AppImage'];
  for (const ext of exts) {
    const re = new RegExp(`releases/latest/download/[^"'#?\\s>]+${ext.replace(/\./g, '\\.')}`, 'g');
    html = html.replace(re, `releases/latest/download/${names[ext]}`);
  }

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

  // 4.5) 像素风格官网单独适配（版本号、下载链接、包体积）
  html = syncPixelSite(html, version, releaseInfo);

  // 5) 图片加缓存戳：GitHub Pages 的 CDN/浏览器缓存最长约 10 分钟，
  //    不带 ?v= 时用户刷新也会看到旧截图（"图片怎么还是之前的"根因之一）。
  const stamp = NUM + '.' + new Date().toISOString().slice(0, 10).replace(/-/g, '') +
    new Date().getHours() + String(new Date().getMinutes()).padStart(2, '0');
  html = html.replace(/((?:images|assets)\/[A-Za-z0-9_\-.]+\.png)(\?v=[A-Za-z0-9._-]+)?/g, `$1?v=${stamp}`);

  if (html === before) {
    console.log(`官网 ${websitePath} 无变更（版本号与下载链接已是最新 ${version}）。`);
    process.exit(0);
  }

  fs.writeFileSync(websitePath, html, 'utf8');
  console.log(`官网版本号与下载链接已同步为: ${version}`);
  console.log('图片缓存戳:', stamp);
  console.log('文件:', websitePath);
})();
