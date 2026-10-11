/**
 * 补丁包打包脚本
 * 用法：
 *   node scripts/build-patch.js --version=1.0.5 --from=1.0.4 --files=renderer/index.html,renderer/js/app.js
 *   node scripts/build-patch.js --version=1.0.5 --from=1.0.4 --files=renderer/ --changes="修复了xxx"
 *
 * 参数：
 *   --version   目标版本号（必填）
 *   --from      适用的起始版本（必填，用于增量补丁链）
 *   --files     变更文件或目录，逗号分隔（必填，相对于项目根目录）
 *   --min       最低兼容版本（默认等于 from）
 *   --changes   更新说明文本
 *   --output    输出目录（默认 ./update/patches）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

// 解析参数（支持 --key=value 和 --flag 两种格式）
function parseArgs() {
  const args = {};
  process.argv.slice(2).forEach(arg => {
    const match = arg.match(/^--(\w+)(?:=(.+))?$/);
    if (match) args[match[1]] = match[2] !== undefined ? match[2] : true;
  });
  return args;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest('hex');
}

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    const destDir = path.dirname(dest);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function collectFiles(dir, baseDir, result = []) {
  if (!fs.existsSync(dir)) return result;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel = path.relative(baseDir, full).replace(/\\/g, '/');
    if (fs.statSync(full).isDirectory()) {
      collectFiles(full, baseDir, result);
    } else {
      result.push(rel);
    }
  }
  return result;
}

// ★ 收集 src/ 与 assets/ 下所有文件的内容哈希（用于差异对比）
function collectSourceHashes(root) {
  const map = {};
  for (const sub of ['src', 'assets']) {
    const base = path.join(root, sub);
    if (!fs.existsSync(base)) continue;
    for (const rel of collectFiles(base, root)) {
      try { map[rel] = sha256File(path.join(root, rel)); } catch (e) {}
    }
  }
  return map;
}

// ★ 自动差异模式：对比参考目录与当前项目 src/ + assets/，
//   只收集「新增或内容变化」的文件。这样补丁必然完整覆盖所有改动，
//   不再依赖手动逐一列举 --files（旧流程极易漏文件，导致大部分功能更新不上）。
function diffChangedFiles(refRoot, curRoot) {
  const ref = collectSourceHashes(refRoot);
  const cur = collectSourceHashes(curRoot);
  const changed = [];
  for (const rel of Object.keys(cur)) {
    // 排除运行时无法补丁的三方 SDK 源码/构建产物，避免补丁虚胖
    if (isExcludedPatchFile(rel)) continue;
    if (!ref[rel] || ref[rel] !== cur[rel]) changed.push(rel);
  }
  return changed.sort();
}

// ★ 补丁排除清单：这些是构建期/第三方源码，打包进 app.asar 但运行时无法被
//   Module._load 钩子或 webRequest 拦截覆盖，打进补丁只会白白增大体积。
function isExcludedPatchFile(rel) {
  return (
    /^src\/main\/taskbar-inject\/Detours-main\//.test(rel) ||
    /^src\/main\/taskbar-inject\/minhook-master\//.test(rel) ||
    /^src\/main\/taskbar-inject\/detours\.zip$/.test(rel) ||
    /^src\/main\/taskbar-inject\/minhook\.zip$/.test(rel) ||
    /^src\/main\/taskbar-inject\/compile_error\.txt$/.test(rel) ||
    // 原生二进制（DLL/静态库）：由 ffi/koffi 等加载，不走 require('src/main/...')，
    // 无法被 Module._load 钩子补丁，打进补丁也无从生效，故排除
    /^src\/main\/taskbar-inject\/.+\.(dll|a|lib|obj|o|exp)$/.test(rel) ||
    /\.(cpp|h|hpp|c|sln|vcxproj|vcxproj\.filters|bat|rc)$/.test(rel) ||
    /\.(log|tmp|bak)$/.test(rel) ||
    /\.(bak-config-extract)$/.test(rel)
  );
}

async function main() {
  const args = parseArgs();
  const version = args.version;
  const fromVersion = args.from;
  const filesArg = args.files;
  const diffRef = args.diff;
  const minVersion = args.min || fromVersion;
  const changes = args.changes || '';
  const outputDir = path.resolve(args.output || './update/patches');

  if (!version || !fromVersion || (!filesArg && !diffRef)) {
    console.error('用法: node scripts/build-patch.js --version=1.0.5 --from=1.0.4 --files=renderer/index.html,renderer/js/app.js');
    console.error('  或（推荐，自动收集全部变更文件）: node scripts/build-patch.js --version=1.0.9 --from=1.0.8 --diff=<参考目录(含 src/ 与 assets/)>');
    process.exit(1);
  }

  const projectRoot = path.resolve(__dirname, '..');
  const tempDir = path.join(outputDir, `_temp_${version}`);
  const zipPath = path.join(outputDir, `patch-${version}.zip`);

  // 清理临时目录
  if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });

  // 复制变更文件
  // ★ 路径映射：将 src/main/ → main/，src/renderer/ → renderer/；assets/ 原样保留
  //   使补丁包内部结构统一为 main/ 和 renderer/（+ assets/），与 patch-loader 和
  //   setupPatchOverride 一致。同时兼容「按完整相对路径存储」的新布局。
  function mapPatchPath(relPath) {
    let p = relPath.replace(/\\/g, '/');
    if (p.startsWith('src/main/')) p = p.substring('src/'.length);      // src/main/xxx → main/xxx
    else if (p.startsWith('src/renderer/')) p = p.substring('src/'.length); // src/renderer/xxx → renderer/xxx
    return p;
  }

  const allFiles = [];

  if (diffRef) {
    // ★ 自动差异模式：只打包 src/ 与 assets/ 下新增/变更的文件
    const refRoot = path.resolve(diffRef);
    if (!fs.existsSync(refRoot)) {
      console.error(`参考目录不存在: ${refRoot}`);
      process.exit(1);
    }
    const changed = diffChangedFiles(refRoot, projectRoot);
    if (changed.length === 0) {
      console.log('未检测到 src/ 与 assets/ 下的文件变更，补丁为空，退出。');
      process.exit(0);
    }
    console.log(`检测到 ${changed.length} 个变更/新增文件：`);
    for (const rel of changed) console.log('  -', rel);
    for (const rel of changed) {
      const src = path.join(projectRoot, rel);
      if (!fs.existsSync(src)) { console.warn(`警告: 文件不存在，跳过: ${rel}`); continue; }
      const mappedFile = mapPatchPath(rel);
      const dest = path.join(tempDir, mappedFile);
      copyRecursive(src, dest);
      allFiles.push(mappedFile);
    }
  } else {
    const files = filesArg.split(',').map(f => f.trim());
    for (const file of files) {
      const src = path.join(projectRoot, file);
      if (!fs.existsSync(src)) {
        console.warn(`警告: 文件不存在，跳过: ${file}`);
        continue;
      }
      const mappedFile = mapPatchPath(file);
      const dest = path.join(tempDir, mappedFile);
      copyRecursive(src, dest);
      if (fs.statSync(src).isDirectory()) {
        collectFiles(dest, tempDir, allFiles);
      } else {
        allFiles.push(mappedFile);
      }
    }
  }

  if (allFiles.length === 0) {
    console.error('没有有效的变更文件');
    process.exit(1);
  }

  // 生成 manifest.json
  // ★ 自动检测是否包含主进程文件（main/ 目录），主进程补丁需要重启才能生效
  const hasMainFiles = allFiles.some(f => f.startsWith('main/') || f === 'main' || f.includes('/main/'));
  const manifest = {
    version,
    from: fromVersion,
    to: version,
    minVersion,
    releaseDate: new Date().toISOString().split('T')[0],
    files: allFiles,
    changes,
    requiresRestart: hasMainFiles
  };
  fs.writeFileSync(path.join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // 打包 ZIP（用 PowerShell Compress-Archive）
  console.log(`正在打包 ${allFiles.length} 个文件...`);
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  const psCmd = `Compress-Archive -Path "${tempDir}\\*" -DestinationPath "${zipPath}" -Force`;
  execSync(`powershell -NoProfile -Command "${psCmd}"`, { stdio: 'inherit' });

  // 计算校验和
  const checksum = sha256File(zipPath);
  const fileSize = fs.statSync(zipPath).size;

  // 清理临时目录
  fs.rmSync(tempDir, { recursive: true, force: true });

  // 输出结果
  console.log('\n========== 补丁包生成成功 ==========');
  console.log(`版本: ${fromVersion} → ${version}`);
  console.log(`文件: ${zipPath}`);
  console.log(`大小: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);
  console.log(`SHA256: ${checksum}`);
  console.log(`变更文件数: ${allFiles.length}`);
  console.log(`包含主进程文件: ${hasMainFiles ? '是（需重启生效）' : '否（渲染进程文件，可热更新）'}`);

  // 输出 latest.json 片段
  // ★ 补丁下载地址：必须指向仓库 update 内的 patches/ 目录（raw 格式），
  //   与 sync-update-to-github.js 的上传位置、以及客户端 buildUrlCandidates
  //   的多源回退（Pages/jsDelivr/镜像/raw）一致。
  //   旧版生成的是指向 GitHub Release 资产的占位符（"你的用户名/你的仓库"），
  //   既不是有效地址，也与实际上传位置不符，导致补丁根本下载不到。
  let owner = 'yonggezx', repo = 'fuling-shijie-update';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
    const pub = (pkg.build && pkg.build.publish) || {};
    if (pub.owner) owner = pub.owner;
    if (pub.repo) repo = pub.repo;
  } catch (e) {}
  const branch = args.branch || 'main';
  const patchUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/patches/patch-${version}.zip`;
  const patchEntry = {
    from: fromVersion,
    to: version,
    url: patchUrl,
    size: fileSize,
    checksum: `sha256:${checksum}`,
    changes
  };

  console.log('\n========== latest.json 片段 ==========');
  console.log(JSON.stringify(patchEntry, null, 2));
  console.log('\n请将以上内容添加到 update/latest.json 的 patches 数组中');
  console.log('再用 node scripts/sync-update-to-github.js --apply 把补丁与清单同步到仓库。');
}

main().catch(e => {
  console.error('执行失败:', e.message);
  process.exit(1);
});
