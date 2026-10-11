/**
 * Supabase 网络诊断脚本
 *
 * 用途：定位 "TypeError: fetch failed / read ECONNRESET / net::ERR_QUIC_PROTOCOL_ERROR"
 *       这类账号服务连通问题。
 *
 * 用法：
 *   node scripts/check-supabase-net.js
 *   AIL_SUPABASE_PROXY=https://xxx.workers.dev node scripts/check-supabase-net.js
 *
 * 重要：诊断必须跑在 Electron 里。本机实测——同一台机器、同一个 Supabase 地址：
 *   Node fetch / https 模块 / curl  →  全部 read ECONNRESET（TLS 握手被重置）
 *   Electron net.fetch（Chromium）  →  200 OK（几百毫秒）
 * 所以在纯 Node 里诊断会得到「全部不可达」的假结论。
 * 本脚本检测到自己不在 Electron 中时，会自动用 Electron 重启诊断。
 */

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'src', 'main', 'ipc', 'supabaseAuth.js');
const DIAG_DIR = path.join(os.tmpdir(), 'ail-supabase-diag');
if (!fs.existsSync(DIAG_DIR)) fs.mkdirSync(DIAG_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// 在 Electron 主进程里跑诊断（走 Chromium 网络栈），结果用 JSON 回传
// ---------------------------------------------------------------------------
function runInElectron() {
  return new Promise((resolve, reject) => {
    const boot = path.join(DIAG_DIR, 'boot.js');
    const lines = [
      "const { app } = require('electron');",
      `const MODULE = ${JSON.stringify(MODULE_PATH)};`,
      `const DIR = ${JSON.stringify(DIAG_DIR)};`,
      "app.whenReady().then(async () => {",
      "  const mod = require(MODULE);",
      "  mod.init(DIR);",
      "  try {",
      "    const r = await mod.__net.diagnose();",
      "    console.log('__RESULT__' + JSON.stringify(r));",
      "  } catch (e) { console.log('__ERR__' + (e && e.message)); }",
      "  app.quit();",
      "});"
    ];
    fs.writeFileSync(boot, lines.join('\n'), 'utf-8');

    const env = Object.assign({}, process.env);
    delete env.ELECTRON_RUN_AS_NODE;

    const child = spawn(process.execPath, [
      path.join(ROOT, 'node_modules', 'electron', 'cli.js'), boot,
      '--no-sandbox', '--disable-gpu'
    ], { cwd: ROOT, env, windowsHide: true });

    let acc = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (e) { /* ignore */ }
      reject(new Error('Electron 诊断进程超时（45s），尾部输出: ' + acc.slice(-300)));
    }, 45000);

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };

    child.stdout.on('data', (d) => {
      acc += d.toString();
      const rm = acc.match(/__RESULT__([^\n]*)/);
      const em = acc.match(/__ERR__([^\n]*)/);
      if (em) return finish(reject, new Error(em[1]));
      if (rm) {
        try { return finish(resolve, JSON.parse(rm[1])); } catch (e) { return finish(reject, new Error('结果解析失败: ' + rm[1])); }
      }
    });
    child.stderr.on('data', (d) => { acc += d.toString(); });
    child.on('exit', (code) => {
      finish(reject, new Error(`Electron 进程提前退出 code=${code}，尾部输出: ${acc.slice(-300)}`));
    });
    child.on('error', (e) => finish(reject, e));
  });
}

// ---------------------------------------------------------------------------
function printReport(data, transportLabel) {
  console.log('=== Supabase 网络诊断 ===');
  console.log('时间:', new Date().toLocaleString());
  console.log('诊断通道:', transportLabel);
  if (process.env.AIL_SUPABASE_PROXY) console.log('环境变量 AIL_SUPABASE_PROXY =', process.env.AIL_SUPABASE_PROXY);

  const sp = data.systemProxy || {};
  console.log('\n--- 系统代理 ---');
  console.log('代理开关:', sp.switchOn ? '开启' : '关闭',
    '| 生效代理:', sp.enabled ? '是' : '否',
    '| 服务器:', sp.server || '(无)', '| PAC:', sp.pac || '(无)');

  console.log('\n--- 候选端点连通性（Chromium 网络栈）---');
  for (const r of data.candidates || []) {
    console.log(`[${r.ok ? 'OK ' : 'FAIL'}] ${String(r.label).padEnd(10)} ${r.base}  status=${r.status || '-'} ${r.ms}ms`);
    if (r.body) console.log('        响应体:', String(r.body).replace(/\s+/g, ' ').slice(0, 140));
    if (r.error) console.log('        错误:', r.error);
  }

  const av = data.antivirus || {};
  console.log('\n--- 安全软件 ---');
  if (av.list && av.list.length) {
    av.list.forEach((x) => console.log('  检测到:', x.name, '|', x.path));
    console.log('  处理建议:', av.tip);
  } else {
    console.log('  未检测到已知安全软件安装目录');
  }

  const anyOk = (data.candidates || []).some((r) => r.ok);
  console.log('\n--- 结论 ---');
  if (anyOk) {
    console.log('账号服务可达，注册 / 登录应可正常工作。');
  } else {
    console.log('全部端点不可达。按可能性从高到低排查：');
    console.log('  1) 安全软件 HTTPS 扫描 / 联网控制拦截了 TLS 握手（见上方"安全软件"）；');
    console.log('  2) 本机网络无法直连 *.supabase.co（握手被重置）；');
    console.log('  3) 未开启系统代理，或代理未放行该域名；');
    console.log('  4) Supabase 项目被暂停 / 已删除。');
    console.log('处理方式：把应用加入安全软件信任区后重试；或部署 supabase-proxy-worker.js，');
    console.log('然后在 supabase-config.json 增加 {"proxyUrls":["https://xxx.workers.dev"]}，');
    console.log('也可用环境变量 AIL_SUPABASE_PROXY=... 临时验证。');
  }
  return anyOk;
}

(async () => {
  if (process.versions && process.versions.electron) {
    const mod = require(MODULE_PATH);
    mod.init(DIAG_DIR);
    const r = await mod.__net.diagnose();
    process.exit(printReport(r, 'Electron(Chromium 网络栈)') ? 0 : 2);
    return;
  }

  let data;
  try {
    data = await runInElectron();
  } catch (e) {
    console.error('Electron 诊断失败:', e.message);
    process.exit(1);
    return;
  }
  process.exit(printReport(data, `Electron(Chromium 网络栈) / 传输层=${data.transport}`) ? 0 : 2);
})();
