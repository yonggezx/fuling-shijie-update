#!/usr/bin/env node
/**
 * 发布后同步 update/ 下的更新清单。
 *
 * 目的：客户端读的 update/latest.json、update/full-install.json 必须始终指向
 * 本次 Release 里**真实存在**的安装包文件名，否则会出现「检查更新说有新版本、
 * 点下载 404」或「下到的不是可安装的安装器」。
 *
 * 用法：
 *   node scripts/sync-update-manifest.js --version=v1.0.12 --installer=dist/FulingShijie-Setup-v1.0.12.exe
 * 可选参数：
 *   --repo=yonggezx/fuling-shijie-update   Release 所属仓库（默认本仓库）
 *   --out=update                           清单输出目录
 *   --release-date=YYYY-MM-DD              默认取今天（UTC+8）
 *   --notes-file=path                      发布说明文本，写入 releaseNotes / changes
 *
 * 输出：
 *   update/latest.json        稳定通道清单
 *   update/beta.json          测试通道清单
 *   update/full-install.json  完整安装包信息（含 url / size / checksum / fileName）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function arg(name, def) {
  const hit = process.argv.slice(2).find(a => a.startsWith('--' + name + '='));
  return hit ? hit.slice(('--' + name + '=').length) : def;
}

const root = path.resolve(__dirname, '..');
const tag = (arg('version', '') || '').trim();
if (!tag) {
  console.error('[sync-update-manifest] 缺少 --version（例如 --version=v1.0.12）');
  process.exit(1);
}
const version = tag.replace(/^v/, '');
const repo = arg('repo', 'yonggezx/fuling-shijie-update');
const outDir = path.resolve(root, arg('out', 'update'));
const installerArg = arg('installer', '');
const releaseDate = arg('release-date', new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10));

if (!installerArg) {
  console.error('[sync-update-manifest] 缺少 --installer（指向本次构建出的安装包，如 dist/FulingShijie-Setup-v1.0.12.exe）');
  process.exit(1);
}
const installer = path.resolve(root, installerArg);
if (!fs.existsSync(installer)) {
  console.error('[sync-update-manifest] ✗ 找不到安装包：' + installer);
  process.exit(1);
}

const fileName = path.basename(installer);
if (!/\.exe$/i.test(fileName)) {
  console.error('[sync-update-manifest] ✗ 安装包必须是 .exe：' + fileName);
  process.exit(1);
}
// 资产名必须是 ASCII，否则上传到 GitHub 会被剥成残名（历史上 404 的根因）
if (!/^[\x20-\x7e]+$/.test(fileName)) {
  console.error('[sync-update-manifest] ✗ 安装包文件名含非 ASCII 字符，请检查 package.json 的 win.artifactName：' + fileName);
  process.exit(1);
}

const stat = fs.statSync(installer);
const sha512 = crypto.createHash('sha512').update(fs.readFileSync(installer)).digest('base64');
const url = 'https://github.com/' + repo + '/releases/download/v' + version + '/' + encodeURIComponent(fileName);

let notes = '';
const notesFile = arg('notes-file', '');
if (notesFile) {
  const p = path.resolve(root, notesFile);
  if (fs.existsSync(p)) notes = fs.readFileSync(p, 'utf-8').trim();
}

const latest = {
  version,
  releaseDate,
  releaseNotes: notes,
  tag: 'v' + version,
  changes: notes
};
const beta = { version, releaseDate, releaseNotes: notes, tag: 'v' + version };
const fullInstall = {
  fullInstall: {
    version,
    releaseDate,
    changes: notes,
    url,
    checksum: sha512,
    size: stat.size,
    fileName,
    tag: 'v' + version,
    isFullPackage: true
  }
};

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const write = (name, obj) => {
  const p = path.join(outDir, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
  console.log('  ✓ ' + path.relative(root, p));
};
write('latest.json', latest);
write('beta.json', beta);
write('full-install.json', fullInstall);

console.log('[sync-update-manifest] 完成：v' + version + ' -> ' + fileName + ' (' + (stat.size / 1048576).toFixed(1) + ' MB)');
console.log('[sync-update-manifest] 下载地址：' + url);
