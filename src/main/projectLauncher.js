/**
 * 项目启动器：让 AI 能自动识别项目类型、按情况配置（安装依赖）、再通过命令拉起或直接打开 exe 来启动被测项目。
 *
 * 设计目标（用户需求）：
 *   根据项目文件判断 → 进行相应的配置 → 通过命令或者直接打开的方式启动。
 *
 * 对外接口：
 *   detectProject(dir)                识别目录里的项目类型，返回启动方案（不启动）
 *   launch(options)                   按 method 启动：auto / command / open / detect
 *   launchProject(action, params)      统一入口，供 agent 工具调用
 *
 * 支持识别：静态网页(html/css/js)、Node(npm/yarn/pnpm/bun)、Python、Rust(cargo)、Go、Java(gradle/maven)。
 *
 * ⚠️ 2026-10-03 修复「明明是网页项目，AI 却老拿 exe 启动、永远跑不起来」：
 *   1. 新增静态网页识别：只有 html/css/js 的项目会自动起本地静态服务 + 浏览器打开（不再报"未能识别"）；
 *   2. package.json 里没有 start/dev/serve 脚本时不再硬编一个必然失败的 npm start，而是退回网页方案；
 *   3. exe 候选做净化：安装器/卸载器/浏览器/运行时(node、python、chrome…)一律排除，只留像"项目产物"的；
 *   4. 网页项目被要求用 exe 启动时直接拒绝并说明正确做法，不再让 AI 反复瞎试；
 *   5. 命令启动不再"spawn 完就报成功"——会等一小段并读日志，命令秒退时如实报错（原来 npm ERR 也返回成功）。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

// 常见的“构建产物目录”，在这些目录里找已编译的可执行文件
const BUILD_DIRS = ['dist', 'build', 'bin', 'out', 'release', 'target/release', 'target/debug', 'publish'];

// 静态网页入口候选（按顺序找）
const HTML_ENTRIES = ['index.html', 'main.html', 'app.html', 'default.html', 'home.html'];

// 明显的非项目产物：安装器/卸载器/更新器/破解/运行时辅助进程
const BAD_EXE_RE = /(unins|uninstall|setup|install(er)?|updater?|crack|patch|keygen|activat|vcredist|redistributable|driver|bootstrap|helper|service|agent|launcher|reporter|sender)/i;

// 浏览器 / 语言运行时 / 系统工具：它们不是「项目产物」，绝不能拿来当被测程序启动
const RUNTIME_EXE_RE = /^(chrome|chromium|msedge|msedgewebview|firefox|iexplore|brave|opera|vivaldi|node|npm|npx|yarn|pnpm|bun|deno|python|pythonw|py|java|javaw|jdk|dotnet|msbuild|gradle|mvnw?|go|cargo|rustc|git|cmd|conhost|powershell|pwsh|wscript|cscript|rundll32|svchost|explorer|notepad|taskmgr|electron|ffmpeg)/i;

const MIME = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.json': 'application/json', '.map': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain', '.md': 'text/markdown',
  '.xml': 'application/xml', '.pdf': 'application/pdf'
};

// ============================================================
// 项目类型识别
// ============================================================

function fileExists(dir, name) {
  try { return fs.existsSync(path.join(dir, name)); } catch (e) { return false; }
}
function dirExists(dir, name) {
  try { return fs.statSync(path.join(dir, name)).isDirectory(); } catch (e) { return false; }
}

/** 从 html 里取 <title>，用作浏览器窗口标题提示（截图要靠它锁定窗口）。 */
function parseHtmlTitle(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8').slice(0, 200000);
    const m = txt.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (m) {
      const t = m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      if (t) return t.slice(0, 60);
    }
    // 没有 title 就退一步用主标题
    const h = txt.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h) {
      const t = h[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      if (t) return t.slice(0, 60);
    }
  } catch (e) { /* 忽略 */ }
  return null;
}

/**
 * 静态网页识别：目录里只有 html/css/js 这类前端文件（没有后端/构建标记）时命中。
 * 命中后不找 exe，改为「起本地静态服务 + 默认浏览器打开」。
 */
function detectWeb(dir) {
  let entry = null;
  for (const cand of HTML_ENTRIES) {
    if (fileExists(dir, cand)) { entry = cand; break; }
  }
  if (!entry) {
    // 根目录里随便一个 html 也算（"项目里只有一个网页" 时文件名不一定叫 index）
    try {
      const htmls = fs.readdirSync(dir).filter((f) => /\.html?$/i.test(f));
      if (htmls.length) entry = htmls[0];
    } catch (e) { /* 忽略 */ }
  }
  if (!entry) {
    // 再退一步：常见前端目录里找一层（public/www/web/docs/site/html）
    for (const sub of ['public', 'www', 'web', 'docs', 'site', 'html']) {
      if (!dirExists(dir, sub)) continue;
      for (const cand of HTML_ENTRIES) {
        if (fileExists(dir, sub + '/' + cand)) { entry = sub + '/' + cand; break; }
      }
      if (!entry) {
        try {
          const htmls = fs.readdirSync(path.join(dir, sub)).filter((f) => /\.html?$/i.test(f));
          if (htmls.length) entry = sub + '/' + htmls[0];
        } catch (e) { /* 忽略 */ }
      }
      if (entry) break;
    }
  }
  if (!entry) return null;
  const title = parseHtmlTitle(path.join(dir, entry));
  return {
    type: 'web',
    name: title || path.basename(entry, path.extname(entry)) || path.basename(dir),
    entry,
    startCommand: null,
    installCommand: null,
    needsInstall: false,
    isStaticWeb: true,
    windowTitleHint: title || path.basename(entry, path.extname(entry)) || path.basename(dir)
  };
}

/** exe 是否像"这个项目的产物"：<0 表示明确不是、该排除；分数越高越像。 */
function exeRelevance(base, projectName) {
  if (BAD_EXE_RE.test(base)) return -1;
  if (RUNTIME_EXE_RE.test(base)) return -1;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
  const n = norm(base.replace(/\.exe$/i, ''));
  const p = norm(projectName);
  let score = 1;
  if (p && n && (n === p || n.includes(p) || p.includes(n))) score += 10;
  return score;
}

function detectNode(dir) {
  const pkgPath = path.join(dir, 'package.json');
  if (!fileExists(dir, 'package.json')) return null;
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch (e) { pkg = {}; }
  // 包管理器判定
  let pm = 'npm';
  if (fileExists(dir, 'pnpm-lock.yaml')) pm = 'pnpm';
  else if (fileExists(dir, 'yarn.lock')) pm = 'yarn';
  else if (fileExists(dir, 'bun.lockb')) pm = 'bun';
  const scripts = pkg.scripts || {};
  // 优先 start，其次 dev，再 serve；都没有就用 pm run
  let script = scripts.start ? 'start' : (scripts.dev ? 'dev' : (scripts.serve ? 'serve' : null));
  let startCommand;
  if (script) startCommand = pm + ' run ' + script;
  else if (pm === 'npm') startCommand = 'npm start';
  else startCommand = pm + ' run start';
  const installCommand = pm + ' install';
  const needsInstall = !dirExists(dir, 'node_modules');
  return {
    type: 'node',
    name: pkg.productName || pkg.name || path.basename(dir),
    packageManager: pm,
    startCommand,
    // hasScript=false 意味着 npm start 必然失败（Missing script），调用方要另想办法（如退回静态网页方案）
    hasScript: !!script,
    installCommand,
    needsInstall,
    windowTitleHint: pkg.productName || pkg.name
  };
}

function detectPython(dir) {
  const markers = ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile'];
  if (!markers.some((m) => fileExists(dir, m))) return null;
  // 虚拟环境判定
  let pyBin = 'python';
  const venvCandidates = ['.venv', 'venv', 'env', 'virtualenv'];
  for (const v of venvCandidates) {
    if (dirExists(dir, v)) {
      const exe = process.platform === 'win32' ? path.join(v, 'Scripts', 'python.exe') : path.join(v, 'bin', 'python');
      if (fileExists(dir, exe)) { pyBin = path.join(dir, exe); break; }
    }
  }
  // 入口脚本判定
  let entry = null;
  for (const cand of ['app.py', 'main.py', 'manage.py', 'wsgi.py', 'server.py', 'main.pyw']) {
    if (fileExists(dir, cand)) { entry = cand; break; }
  }
  let startCommand;
  if (entry) startCommand = '"' + pyBin + '" "' + entry + '"';
  else {
    // 退而求其次：尝试 -m 包名（用目录名）或 pytest/unittest
    startCommand = '"' + pyBin + '" -m ' + (path.basename(dir).replace(/[^a-z0-9_]/gi, '_'));
  }
  let installCommand = null;
  if (pyBin === 'python' || pyBin === 'python3') {
    if (fileExists(dir, 'requirements.txt')) installCommand = 'pip install -r requirements.txt';
    else if (fileExists(dir, 'pyproject.toml')) installCommand = 'pip install -e .';
  } else {
    if (fileExists(dir, 'requirements.txt')) installCommand = '"' + pyBin + '" -m pip install -r requirements.txt';
  }
  // 没有 venv 且有 requirements → 视为需要安装
  const needsInstall = !venvCandidates.some((v) => dirExists(dir, v)) && fileExists(dir, 'requirements.txt');
  return {
    type: 'python',
    name: path.basename(dir),
    pythonBinary: pyBin,
    entry,
    startCommand,
    installCommand,
    needsInstall,
    windowTitleHint: path.basename(dir)
  };
}

function detectRust(dir) {
  if (!fileExists(dir, 'Cargo.toml')) return null;
  let pkg = {};
  try {
    const txt = fs.readFileSync(path.join(dir, 'Cargo.toml'), 'utf8');
    const m = txt.match(/name\s*=\s*["']([^"']+)["']/);
    if (m) pkg.name = m[1];
  } catch (e) {}
  return {
    type: 'rust',
    name: pkg.name || path.basename(dir),
    startCommand: 'cargo run',
    installCommand: null,
    needsInstall: false,
    windowTitleHint: pkg.name || path.basename(dir)
  };
}

function detectGo(dir) {
  if (!fileExists(dir, 'go.mod')) return null;
  let mod = '';
  try {
    const txt = fs.readFileSync(path.join(dir, 'go.mod'), 'utf8');
    const m = txt.match(/^module\s+(\S+)/m);
    if (m) mod = m[1];
  } catch (e) {}
  return {
    type: 'go',
    name: mod.split('/').pop() || path.basename(dir),
    startCommand: 'go run .',
    installCommand: null,
    needsInstall: false,
    windowTitleHint: mod.split('/').pop() || path.basename(dir)
  };
}

function detectJava(dir) {
  if (fileExists(dir, 'build.gradle') || fileExists(dir, 'build.gradle.kts')) {
    const gradlew = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
    return {
      type: 'java',
      name: path.basename(dir),
      startCommand: (fileExists(dir, gradlew) ? gradlew : 'gradle') + ' bootRun',
      installCommand: null,
      needsInstall: false,
      windowTitleHint: path.basename(dir)
    };
  }
  if (fileExists(dir, 'pom.xml')) {
    const mvnw = process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw';
    return {
      type: 'java',
      name: path.basename(dir),
      startCommand: (fileExists(dir, mvnw) ? mvnw : 'mvn') + ' spring-boot:run',
      installCommand: null,
      needsInstall: false,
      windowTitleHint: path.basename(dir)
    };
  }
  return null;
}

function detectVisualStudio(dir) {
  let sln = null;
  try { sln = fs.readdirSync(dir).find((f) => /\.sln$/i.test(f)); } catch (e) { return null; }
  if (!sln) return null;
  return {
    type: 'cpp-vs',
    name: path.basename(sln, '.sln'),
    startCommand: 'msbuild "' + sln + '"',
    installCommand: null,
    needsInstall: false,
    windowTitleHint: path.basename(sln, '.sln')
  };
}

/**
 * 识别一个目录里的项目类型，返回启动方案（不启动）。
 * @param {string} dir
 * @returns {{success:boolean, dir:string, detected:boolean, type?:string, name?:string, startCommand?:string, installCommand?:string, needsInstall?:boolean, windowTitleHint?:string, exeCandidates?:string[], error?:string}}
 */
function detectProject(dir) {
  if (!dir || !fs.existsSync(dir)) {
    return { success: false, detected: false, dir: dir || '', error: '目录不存在: ' + (dir || '') };
  }
  let info = detectNode(dir) || detectPython(dir) || detectRust(dir)
    || detectGo(dir) || detectJava(dir) || detectVisualStudio(dir);

  // 静态网页兜底：没识别到类型，或识别成 node 但没有可用脚本（npm start 必然 Missing script）
  // —— 这两种情况下只要目录里有 html 入口，就按"网页项目"处理，起本地服务打开，别再去找 exe。
  const web = detectWeb(dir);
  if (web && (!info || (info.type === 'node' && !info.hasScript))) info = web;

  if (!info) {
    return { success: true, detected: false, dir, error: '未能识别项目类型（无 package.json/requirements.txt/Cargo.toml/go.mod/build.gradle/pom.xml/*.sln/html 入口）' };
  }

  // 收集已编译的可执行文件候选（Windows 下 .exe；其它平台无后缀）
  // ⚠️ 网页项目不找 exe ——「拿 exe 启网页」就是这里以前放过去的，现在直接清空。
  const scored = [];
  if (info.type !== 'web') {
    const dirsToScan = ['', ...BUILD_DIRS];
    try {
      for (const sub of dirsToScan) {
        const base = sub ? path.join(dir, sub) : dir;
        if (!fs.existsSync(base)) continue;
        for (const e of fs.readdirSync(base)) {
          let isExe = false;
          if (process.platform === 'win32') isExe = e.toLowerCase().endsWith('.exe');
          else { try { isExe = fs.statSync(path.join(base, e)).isFile() && !e.includes('.'); } catch (err) { isExe = false; } }
          if (!isExe) continue;
          // 排除安装器/卸载器、浏览器和语言运行时：它们不是项目产物
          const score = exeRelevance(e, info.name);
          if (score < 0) continue;
          scored.push({ file: path.join(base, e), score });
        }
      }
    } catch (e) { /* 忽略扫描错误 */ }
    scored.sort((a, b) => b.score - a.score);
  }
  const exeCandidates = scored.slice(0, 10).map((s) => s.file);
  return {
    success: true,
    detected: true,
    dir,
    ...info,
    exeCandidates,
    launchAdvice: info.type === 'web'
      ? '这是静态网页项目：启动时会自动起本地静态服务并在默认浏览器打开，不要用 exe 启动。'
      : (exeCandidates.length ? null : '没找到项目自身的可执行产物，用 method=command 跑启动命令（源码项目不要指望 exe）。')
  };
}

// ============================================================
// 命令执行 / 启动
// ============================================================

/**
 * 运行一条命令（带超时），返回输出。用于 install 等需要等待的场景。
 */
function runCommand(cmd, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let child;
    try {
      child = spawn(cmd, { shell: true, cwd, windowsHide: true, env: process.env });
    } catch (e) {
      return resolve({ success: false, error: e.message });
    }
    let out = '';
    if (child.stdout) child.stdout.on('data', (d) => { out += d.toString(); });
    if (child.stderr) child.stderr.on('data', (d) => { out += d.toString(); });
    const finish = (success, error) => {
      if (done) return;
      done = true;
      resolve({ success, output: out.slice(-3000), error });
    };
    child.on('exit', (code) => finish(code === 0, code === 0 ? null : '退出码 ' + code));
    child.on('error', (err) => finish(false, err.message));
    setTimeout(() => {
      if (!done) {
        try { child.kill('SIGKILL'); } catch (e) {}
        finish(false, '执行超时（' + Math.round(timeoutMs / 1000) + 's）');
      }
    }, timeoutMs);
  });
}

/**
 * 启动一个“长期运行”的程序（dev server / GUI 应用），不等待退出，立即返回 pid。
 * GUI 程序必须 windowsHide:false 才能显示出来。
 */
function spawnAndForget(cmd, cwd, windowsHide) {
  try {
    const child = spawn(cmd, {
      shell: true,
      cwd,
      windowsHide: !!windowsHide,
      detached: true,   // 独立于父进程，父进程退出后仍能继续运行
      stdio: 'ignore'
    });
    const pid = child.pid;
    // 解除父进程对子进程的引用，让它真正独立
    if (child.unref) child.unref();
    return { success: true, pid, spawned: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * 直接打开一个可执行文件（双击式启动）。
 */
function openExecutable(exePath) {
  try {
    if (!fs.existsSync(exePath)) return { success: false, error: '可执行文件不存在: ' + exePath };
    // 用 start 打开，保持 GUI 显示
    const child = spawn('cmd', ['/c', 'start', '', '"' + exePath + '"'], {
      shell: true, windowsHide: false, detached: true, stdio: 'ignore'
    });
    const pid = child.pid;
    if (child.unref) child.unref();
    return { success: true, pid, exe: exePath };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ============================================================
// 静态网页：本地服务 + 浏览器打开（网页项目不靠 exe）
// ============================================================

const staticServers = new Map(); // dir -> { server, port }

/** 起一个只服务本项目目录的本地静态服务（端口自动分配）。 */
function startStaticServer(dir) {
  return new Promise((resolve) => {
    const root = path.resolve(dir);
    const old = staticServers.get(root);
    if (old && old.server && old.server.listening) {
      return resolve({ success: true, port: old.port, reused: true });
    }
    let server;
    try {
      server = http.createServer((req, res) => {
        let rel = '';
        try { rel = decodeURIComponent((req.url || '/').split('?')[0]); } catch (e) { rel = '/'; }
        rel = rel.replace(/^\/+/, '') || 'index.html';
        const full = path.resolve(root, rel);
        if (full !== root && !full.startsWith(root + path.sep)) {
          res.writeHead(403); return res.end('forbidden');
        }
        const send = (file) => {
          fs.readFile(file, (err, data) => {
            if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 Not Found'); }
            const ext = path.extname(file).toLowerCase();
            let ct = MIME[ext] || 'application/octet-stream';
            if (/^(text|application\/(json|xml|javascript))/.test(ct) || ext === '.svg' || ext === '.md') ct += '; charset=utf-8';
            res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-store' });
            res.end(data);
          });
        };
        fs.stat(full, (err, st) => {
          if (!err && st.isDirectory()) {
            const idx = path.join(full, 'index.html');
            if (fs.existsSync(idx)) return send(idx);
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 Not Found');
          }
          send(full);
        });
      });
    } catch (e) {
      return resolve({ success: false, error: '静态服务创建失败: ' + e.message });
    }
    server.on('error', (e) => resolve({ success: false, error: '静态服务启动失败: ' + e.message }));
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() && server.address().port) || 0;
      staticServers.set(root, { server, port });
      resolve({ success: true, port });
    });
  });
}

/** 关掉某个目录的静态服务（切换项目/退出时用）。 */
function stopStaticServer(dir) {
  const key = path.resolve(dir || '');
  const rec = staticServers.get(key);
  if (!rec) return false;
  try { rec.server.close(); } catch (e) { /* 忽略 */ }
  staticServers.delete(key);
  return true;
}

/** 用系统默认浏览器打开 URL（Electron 里走 shell，普通 Node 下退回 cmd start）。 */
function openExternal(url) {
  try {
    // eslint-disable-next-line global-require
    const { shell } = require('electron');
    if (shell && shell.openExternal) { shell.openExternal(url); return { success: true, method: 'shell' }; }
  } catch (e) { /* 非 Electron 环境 */ }
  try {
    const child = spawn('cmd', ['/c', 'start', '', '"' + url + '"'], { shell: true, windowsHide: false, detached: true, stdio: 'ignore' });
    if (child.unref) child.unref();
    return { success: true, method: 'cmd' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/** GET 一个 URL 拿文本（用来探测页面 <title>，当作浏览器窗口标题线索）。 */
function httpGetText(url, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    let req;
    try {
      req = http.get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          let next = res.headers.location;
          try { next = new URL(res.headers.location, url).toString(); } catch (e) { /* 保持原样 */ }
          return httpGetText(next, timeoutMs).then(finish);
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { if (body.length < 200000) body += d; });
        res.on('end', () => finish({ success: true, status: res.statusCode, body }));
      });
    } catch (e) { return finish({ success: false, error: e.message }); }
    req.on('error', (e) => finish({ success: false, error: e.message }));
    req.setTimeout(timeoutMs || 4000, () => { try { req.destroy(); } catch (e) {} finish({ success: false, error: '请求超时' }); });
  });
}

/** 从文本里取 <title>。 */
function titleFromHtml(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  const t = m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 60) : null;
}

// ============================================================
// 命令启动的健康检查：不再"spawn 完就算成功"
// ============================================================

function readLogTail(logPath) {
  try {
    const txt = fs.readFileSync(logPath, 'utf8');
    return txt.length > 4000 ? txt.slice(-4000) : txt;
  } catch (e) { return ''; }
}

/** 从 dev server 输出里抓本地访问地址（vite/webpack/http.server 等都会打印）。 */
function pickUrl(text) {
  const s = String(text || '');
  const clean = (u) => u.replace(/0\.0\.0\.0|\[::1\]/g, '127.0.0.1').replace(/[\s),.;]+$/, '');
  let m = s.match(/Local[:：]\s*(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+[^\s'"<>)]*)/i);
  if (!m) m = s.match(/listening on\s*(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+[^\s'"<>)]*)/i);
  if (!m) m = s.match(/(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+[^\s'"<>)]*)/i);
  return m ? clean(m[1]) : null;
}

/**
 * 启动长期运行的进程，并做一小段健康检查：
 * - 输出落日志文件（原来 stdio:'ignore'，npm ERR 也看不见，导致"永远都不执行"却一直报成功）
 * - 进程秒退 → 如实报失败并带回日志
 * - 日志里出现本地地址 → 返回 url（调用方据此在浏览器打开）
 */
function spawnLongRunning(cmd, cwd, opts = {}) {
  const waitMs = opts.waitMs || 6000;
  return new Promise((resolve) => {
    const logPath = path.join(os.tmpdir(), 'ail-launch-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '.log');
    let fd = null;
    try { fd = fs.openSync(logPath, 'a'); } catch (e) { fd = null; }
    let child;
    try {
      child = spawn(cmd, {
        shell: true,
        cwd,
        windowsHide: false, // GUI 程序必须可见
        // ⚠️ 这里不能用 detached:true —— Windows 下 detached 会让子进程另开控制台，
        // stdout/stderr 就不会写进我们的日志文件（实测拿到的永远是空字符串），
        // 于是「命令秒退」也检测不出来。不 detached 也能独立存活（父进程退出不会带走它）。
        stdio: fd != null ? ['ignore', fd, fd] : 'ignore'
      });
    } catch (e) {
      return resolve({ success: false, error: e.message });
    }
    let exited = null;
    child.on('exit', (code) => { exited = { code }; });
    child.on('error', (e) => { exited = { code: -1, error: e.message }; });
    const pid = child.pid;
    if (child.unref) child.unref();
    const t0 = Date.now();
    const timer = setInterval(() => {
      const out = readLogTail(logPath);
      if (exited) {
        clearInterval(timer);
        return resolve({
          success: false, pid, logPath, spawned: true,
          error: '启动命令执行后立刻退出了（退出码 ' + exited.code + '）',
          output: out.slice(-1500)
        });
      }
      const url = pickUrl(out);
      if (url) {
        clearInterval(timer);
        return resolve({ success: true, pid, logPath, spawned: true, url, output: out.slice(-1500) });
      }
      if (Date.now() - t0 >= waitMs) {
        clearInterval(timer);
        return resolve({ success: true, pid, logPath, spawned: true, output: out.slice(-1500) });
      }
    }, 250);
  });
}

/**
 * 启动项目。
 * @param {object} options
 *   dir?      项目目录（默认用调用方传入的 workdir）
 *   method?   'auto'(默认) | 'command' | 'open' | 'detect'
 *   install?  true 时在命令启动前先装依赖（仅依赖缺失时）
 *   preferExe? 自动模式下优先直接打开 exe（默认 false，优先跑命令）
 * @returns {Promise<object>}
 */
async function launch(options = {}) {
  const dir = options.dir;
  if (!dir) return { success: false, error: '未指定项目目录（请在 AI 工作模式中先选择项目，或传 dir）' };
  const method = (options.method || 'auto').toLowerCase();

  const detected = detectProject(dir);
  if (!detected.success) return detected;

  if (method === 'detect') {
    return detected;
  }
  if (!detected.detected) {
    return { success: false, detected: false, dir, error: detected.error };
  }

  // ---- 网页项目：起本地静态服务 + 浏览器打开（绝不碰 exe） ----
  if (detected.type === 'web') {
    if (method === 'open' || options.preferExe) {
      return {
        success: false, detected: true, dir, type: 'web', name: detected.name,
        error: '这是网页项目（入口 ' + detected.entry + '），不能用 exe 启动。',
        hint: '网页项目请用 method=auto：会自动起本地静态服务并在默认浏览器打开，之后再用 capture_window / verify_ui 验证页面。'
      };
    }
    return serveWeb(dir, detected, { openBrowser: options.openBrowser !== false });
  }

  // 需要装依赖且要求安装
  if (options.install && detected.installCommand && detected.needsInstall) {
    const r = await runCommand(detected.installCommand, dir, 180000);
    if (!r.success) {
      return {
        success: false, detected: true, dir, type: detected.type, name: detected.name,
        error: '依赖安装失败: ' + (r.error || '') + '；命令: ' + detected.installCommand,
        installOutput: r.output
      };
    }
  }

  if (method === 'open') {
    if (!detected.exeCandidates || !detected.exeCandidates.length) {
      return {
        success: false, detected: true, dir, type: detected.type, name: detected.name,
        error: '没找到这个项目自己的可执行文件（已排除安装器/卸载器/浏览器/运行时等无关 exe）。',
        hint: '源码项目要先 build 出 exe 才能用 method=open；现在请用 method=command 跑启动命令。'
      };
    }
    const r = openExecutable(detected.exeCandidates[0]);
    return { ...detected, launched: r.success, method: 'open', ...r };
  }

  if (method === 'command') {
    if (!detected.startCommand) {
      return { success: false, detected: true, dir, type: detected.type, name: detected.name, error: '这个项目没有可用的启动命令（package.json 里没有 start/dev/serve 脚本）' };
    }
    return finishCommandLaunch(detected, dir, detected.startCommand);
  }

  // auto：默认优先命令；要求优先 exe 或没有命令时才打开
  if (options.preferExe && detected.exeCandidates && detected.exeCandidates.length) {
    const r = openExecutable(detected.exeCandidates[0]);
    return { ...detected, launched: r.success, method: 'open', ...r };
  }
  if (detected.startCommand) {
    return finishCommandLaunch(detected, dir, detected.startCommand);
  }
  if (detected.exeCandidates && detected.exeCandidates.length) {
    const r = openExecutable(detected.exeCandidates[0]);
    return { ...detected, launched: r.success, method: 'open', ...r };
  }
  return {
    success: false, detected: true, dir, type: detected.type, name: detected.name,
    error: '无法确定启动方式（没有启动命令，也没找到项目自身的可执行产物）',
    hint: '先看看项目怎么跑（README / package.json 的 scripts），或先用 run_shell 手动确认启动方式。'
  };
}

/**
 * 命令启动的收尾：健康检查 → 若日志里出现本地地址就在浏览器打开 → 探测页面标题当窗口线索。
 */
async function finishCommandLaunch(detected, dir, cmd) {
  const r = await spawnLongRunning(cmd, dir, { waitMs: 6000 });
  if (!r.success) {
    return {
      success: false, detected: true, dir, type: detected.type, name: detected.name,
      method: 'command', command: cmd, logPath: r.logPath,
      error: r.error,
      output: r.output,
      hint: '启动命令跑起来就退出了，说明这条命令不对（常见：package.json 没有 start 脚本、依赖没装、命令不存在）。看上面的输出定位，或换 README/ scripts 里真实存在的命令。'
    };
  }
  const out = { ...detected, launched: true, method: 'command', pid: r.pid, logPath: r.logPath, command: cmd };
  if (r.url) {
    out.url = r.url;
    const opened = openExternal(r.url);
    out.openedInBrowser = !!opened.success;
    const probe = await httpGetText(r.url, 4000);
    if (probe.success) {
      const t = titleFromHtml(probe.body);
      if (t) { out.windowTitleHint = t; out.name = t; }
    }
    out.hint = '服务已起来：' + r.url + '（已在默认浏览器打开）；后续 capture_window / verify_ui 不传 title 时会抓这个页面窗口。';
  } else {
    out.hint = '进程已拉起（pid ' + r.pid + '），日志：' + r.logPath + '。若它其实没跑起来，去读这个日志看报错。';
  }
  return out;
}

/**
 * 启动静态网页项目：本地服务 + 浏览器打开 + 探测页面标题（供截图锁定窗口）。
 */
async function serveWeb(dir, detected, opts = {}) {
  const started = await startStaticServer(dir);
  if (!started.success) {
    return { success: false, detected: true, dir, type: 'web', name: detected.name, error: started.error };
  }
  const entry = detected.entry || 'index.html';
  const url = 'http://127.0.0.1:' + started.port + '/' + entry.split(/[\\/]/).join('/');
  // openBrowser:false 用于只想拿到地址、不想弹浏览器窗口的场景（自检 / 测试）
  const opened = opts.openBrowser === false ? { success: false, skipped: true } : openExternal(url);
  let title = null;
  const probe = await httpGetText(url, 4000);
  if (probe.success) title = titleFromHtml(probe.body);
  return {
    success: true,
    detected: true,
    launched: true,
    method: 'serve',
    dir,
    type: 'web',
    name: title || detected.name,
    entry,
    url,
    port: started.port,
    openedInBrowser: !!opened.success,
    windowTitleHint: title || detected.windowTitleHint || detected.name,
    hint: '网页项目已用本地静态服务打开：' + url + '（不要用 exe 启动网页）。后续 capture_window / verify_ui 不传 title 时会按标题「' + (title || detected.windowTitleHint || detected.name) + '」抓浏览器里的页面窗口。'
  };
}

/**
 * 统一入口，供 agent 工具调用。
 * @param {string} action 'detect' | 'launch'
 * @param {object} params
 */
async function launchProject(action, params = {}) {
  switch ((action || '').toLowerCase()) {
    case 'detect':
      return detectProject(params.dir || params.path);
    case 'launch':
      return launch({ dir: params.dir || params.path, method: params.method, install: params.install, preferExe: params.preferExe });
    default:
      return { success: false, error: '未知操作 action（支持 detect/launch）' };
  }
}

module.exports = {
  detectProject,
  launch,
  launchProject,
  // 以下供测试 / 复用
  detectWeb,
  exeRelevance,
  startStaticServer,
  stopStaticServer,
  serveWeb,
  spawnLongRunning,
  pickUrl,
  titleFromHtml
};
