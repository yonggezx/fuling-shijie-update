// AI 模型服务「开启即选中」回归测试
//
// 运行： npm run test:active-provider
//   （或 env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron scripts/test-ai-active-provider.js）
// 排障：若报 "Cannot read properties of undefined (reading 'commandLine')"，
//       说明环境里带了 ELECTRON_RUN_AS_NODE（Electron 退化成纯 Node），加 env -u 清除。
//
// 做法：不启动完整应用，而是在隐藏窗口里加载**真实的 js/app.js**，
//       stub 掉 window.api / ElIcons，然后对真实渲染出来的开关做真实点击，
//       断言「活跃模型」是否被自动切换并持久化。
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const url = require('url');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-software-rasterizer');

const RENDERER_DIR = path.join(__dirname, '..', 'src', 'renderer');
const STAGE_LOG = path.join(os.tmpdir(), 'ai-lobster-active-provider-stages.log');
const stages = [];
function stage(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  stages.push(line);
  try { fs.appendFileSync(STAGE_LOG, line + String.fromCharCode(10), 'utf8'); } catch (e) {}
}

function buildPageHtml(baseHref) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<base href="${baseHref}">
<style>body{margin:0}</style>
</head>
<body>
<div id="toast-container"></div>

<div class="config-section" id="ai-params-section">
  <div class="param-item" id="active-provider-item">
    <span id="active-provider-icon"></span>
    <select id="active-provider"><option value="">-- 选择 --</option></select>
  </div>
  <input type="range" id="temperature" min="0" max="2" step="0.1" value="0.7">
  <span id="temperature-value">0.7</span>
  <div id="max-tokens-item">
    <input type="number" id="max-tokens" value="2048">
  </div>
  <input type="text" id="system-prompt" value="">
</div>
<div id="cloud-providers-list"></div>
<div id="local-models-list"></div>
<select id="chat-provider"></select>
<span id="chat-provider-icon"></span>
<div id="ai-status"><span id="ai-status-text"></span></div>

<script>
// ---- stub：IPC API（记录调用，其余调用返回成功，避免 init 抛错） ----
window.__calls = { setConfig: [], updateCloudProvider: [] };
window.__api = new Proxy({}, {
  get(target, prop) {
    if (prop === 'then') return undefined;
    if (prop === 'path') return { basename: (p) => String(p), extname: () => '', join: () => '' };
    return function () {
      const args = Array.prototype.slice.call(arguments);
      if (window.__calls[prop]) window.__calls[prop].push(args);
      return Promise.resolve({ success: true, data: {} });
    };
  }
});
window.api = window.__api;
window.ElIcons = { getIcon: function () { return '<svg></svg>'; } };
window.I18N = { t: (k) => k };
</script>
<script src="js/app.js"><\/script>
<script>
// ---- 测试辅助 ----
window.__getConfig = function () { return state.settings.ai; };
window.__clearToasts = function () { document.getElementById('toast-container').innerHTML = ''; };
window.__seed = function (providers, activeId) {
  // 深拷贝：避免用例之间互相污染（开关处理会原地改 provider.enabled）
  state.settings.ai = {
    cloudProviders: JSON.parse(JSON.stringify(providers)),
    localModels: [],
    activeProvider: activeId,
    temperature: 0.7,
    maxTokens: 2048,
    systemPrompt: ''
  };
  window.__calls.setConfig.length = 0;
  window.__calls.updateCloudProvider.length = 0;
  window.__clearToasts();
  loadCloudProviders();
  renderCloudProviders();
  renderAISettings();
};
window.__mkProvider = function (id, name, enabled) {
  return { id: id, name: name, type: 'openai', apiUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'gpt-4o', enabled: !!enabled };
};
window.__toggleAt = function (i) {
  const toggles = document.querySelectorAll('#cloud-providers-list .config-toggle');
  toggles[i].click();
};
window.__clickInfoAt = function (i) {
  const items = document.querySelectorAll('#cloud-providers-list .config-item');
  items[i].querySelector('.config-item-info').click();
};
window.__listState = function () {
  return Array.prototype.map.call(document.querySelectorAll('#cloud-providers-list .config-item'), el => ({
    name: (el.querySelector('.config-item-name') || {}).textContent || '',
    active: el.classList.contains('provider-active'),
    hasBadge: (el.querySelector('.config-item-name') || {}).textContent.indexOf('当前使用') >= 0,
    enabled: el.querySelector('.config-toggle').classList.contains('active')
  }));
};
window.__lastConfig = function () {
  const arr = window.__calls.setConfig;
  return arr.length ? arr[arr.length - 1][0].ai : null;
};
window.__lastToasts = function () {
  return Array.prototype.map.call(document.querySelectorAll('#toast-container .toast'), el => el.textContent.replace(/\\s+/g, ' ').trim());
};
window.__tick = function (ms) { return new Promise(r => setTimeout(r, ms || 40)); };
window.__domListsReady = function () {
  return !!document.getElementById('cloud-providers-list');
};
<\/script>
</body>
</html>`;
}

app.whenReady().then(async () => {
  try { fs.unlinkSync(STAGE_LOG); } catch (e) {}
  stage('app ready');
  const baseHref = url.pathToFileURL(RENDERER_DIR).href + '/';
  const tmpPage = path.join(os.tmpdir(), 'ai-lobster-active-provider-test.html');
  fs.writeFileSync(tmpPage, buildPageHtml(baseHref), 'utf8');

  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: { webSecurity: false, backgroundThrottling: false }
  });

  const pageErrors = [];
  win.webContents.on('console-message', (_e, level, msg) => {
    const text = String(msg);
    if (level >= 2 && text.indexOf('Electron Security Warning') < 0) pageErrors.push(text);
  });

  const script = `
(async function () {
  const R = [];
  const ok = (name, cond, extra) => R.push({ name: name, pass: !!cond, extra: extra === undefined ? '' : String(extra) });
  try {
  ok('前置：真实 app.js 已加载并暴露 setActiveProvider', typeof window.setActiveProvider === 'function');

  const P = window.__mkProvider;
  const A = P('pa', '服务A', true);
  const B = P('pb', '服务B', false);

  // ---- 用例 1：已有活跃模型 A 时，开启 B → B 直接成为当前模型 ----
  window.__seed([A, B], 'pa');
  window.__toggleAt(1);                    // 打开 B 的开关
  await window.__tick();
  ok('用例1：开启 B 后活跃模型切换为 B', window.__activeId() === 'pb', window.__activeId());
  ok('用例1：已持久化到配置', (window.__lastConfig() || {}).activeProvider === 'pb', JSON.stringify(window.__lastConfig()));
  ok('用例1：B 被标记为当前使用', window.__listState()[1].active && window.__listState()[1].hasBadge, JSON.stringify(window.__listState()));
  ok('用例1：A 不再是当前使用', !window.__listState()[0].active && !window.__listState()[0].hasBadge, JSON.stringify(window.__listState()[0]));
  ok('用例1：给出切换提示', window.__lastToasts().some(t => t.indexOf('已切换模型') >= 0 && t.indexOf('服务B') >= 0), JSON.stringify(window.__lastToasts()));
  ok('用例1：聊天页选择器已同步', document.getElementById('chat-provider').value === 'pb', document.getElementById('chat-provider').value);
  ok('用例1：设置页活跃模型下拉已同步', document.getElementById('active-provider').value === 'pb', document.getElementById('active-provider').value);

  // ---- 用例 2：关闭当前活跃的 B → 自动切回已启用的 A ----
  window.__toggleAt(1);
  await window.__tick();
  ok('用例2：禁用活跃模型后自动切到 A', window.__activeId() === 'pa', window.__activeId());
  ok('用例2：提示已禁用当前模型', window.__lastToasts().some(t => t.indexOf('当前模型已禁用') >= 0), JSON.stringify(window.__lastToasts()));

  // ---- 用例 3：关闭非活跃的提供商，不影响当前模型 ----
  window.__seed([P('pa', '服务A', true), P('pb', '服务B', true)], 'pa');
  window.__toggleAt(1);                    // 关掉 B（非活跃）
  await window.__tick();
  ok('用例3：关闭非活跃模型不影响当前模型', window.__activeId() === 'pa', window.__activeId());
  ok('用例3：B 的开关确实已关闭', window.__listState()[1].enabled === false, JSON.stringify(window.__listState()));
  ok('用例3：不误报"已切换模型"', window.__lastToasts().every(t => t.indexOf('已切换模型') < 0), JSON.stringify(window.__lastToasts()));
  ok('用例3：没有产生多余的配置写入', window.__calls.setConfig.length === 0, window.__calls.setConfig.length);

  // ---- 用例 4：只剩一个模型时关闭它 → 清空活跃模型 ----
  window.__seed([P('pa', '服务A', true)], 'pa');
  window.__toggleAt(0);
  await window.__tick();
  ok('用例4：无其他可用模型时清空活跃模型', window.__activeId() === null, String(window.__activeId()));
  ok('用例4：已持久化 null', (window.__lastConfig() || {}).activeProvider === null, JSON.stringify(window.__lastConfig()));

  // ---- 用例 5：重复设置同一个模型 → 不重复持久化、不重复提示 ----
  window.__seed([P('pa', '服务A', true), P('pb', '服务B', true)], 'pa');
  const again = await window.setActiveProvider('pa');
  ok('用例5：已是当前模型时返回 false', again === false, String(again));
  ok('用例5：没有产生多余的配置写入', window.__calls.setConfig.length === 0, window.__calls.setConfig.length);
  ok('用例5：没有产生多余的提示', window.__lastToasts().length === 0, JSON.stringify(window.__lastToasts()));

  // ---- 用例 6：目标未启用 / 不存在 → 不切换 ----
  window.__seed([P('pa', '服务A', true), P('pb', '服务B', false)], 'pa');
  const r1 = await window.setActiveProvider('pb');
  ok('用例6：未启用的模型不能被设为当前模型', r1 === false && window.__activeId() === 'pa', r1 + '/' + window.__activeId());
  const r2 = await window.setActiveProvider('not-exist');
  ok('用例6：不存在的模型不能被设为当前模型', r2 === false, String(r2));
  ok('用例6：以上均未写入配置', window.__calls.setConfig.length === 0, window.__calls.setConfig.length);

  // ---- 用例 7：显式清除活跃模型 ----
  window.__seed([P('pa', '服务A', true), P('pb', '服务B', true)], 'pa');
  const r3 = await window.setActiveProvider(null, { toast: null });
  ok('用例7：可显式清除当前模型', r3 === true && window.__activeId() === null, r3 + '/' + String(window.__activeId()));
  ok('用例7：静默模式不弹提示', window.__lastToasts().length === 0, JSON.stringify(window.__lastToasts()));

  // ---- 用例 8：新增提供商（默认启用）→ 静默设为当前模型（4 处新增流程的行为） ----
  window.__seed([P('pa', '服务A', true)], 'pa');
  state.cloudProviders.push(P('pc', '新服务C', true));
  syncAISettings();
  const r4 = await window.setActiveProvider('pc', { toast: null });
  renderCloudProviders();
  renderAISettings();
  ok('用例8：新增的提供商直接成为当前模型', r4 === true && window.__activeId() === 'pc', r4 + '/' + window.__activeId());
  ok('用例8：新增流程静默，提示交给调用方', window.__lastToasts().length === 0, JSON.stringify(window.__lastToasts()));
  ok('用例8：列表已高亮新服务', window.__listState()[1].active && window.__listState()[1].hasBadge, JSON.stringify(window.__listState()));

  // ---- 用例 9：点击列表行切换（与开关同一个入口） ----
  window.__seed([P('pa', '服务A', true), P('pb', '服务B', true)], 'pa');
  window.__clickInfoAt(1);
  await window.__tick();
  ok('用例9：点击已启用模型行即可切换', window.__activeId() === 'pb', window.__activeId());
  ok('用例9：已持久化', (window.__lastConfig() || {}).activeProvider === 'pb', JSON.stringify(window.__lastConfig()));
  ok('用例9：给出切换提示', window.__lastToasts().some(t => t.indexOf('已切换模型') >= 0), JSON.stringify(window.__lastToasts()));

  window.__seed([P('pa', '服务A', true), P('pb', '服务B', false)], 'pa');
  window.__clickInfoAt(1);
  await window.__tick();
  ok('用例9：点击未启用的模型行不会切换', window.__activeId() === 'pa', window.__activeId());
  ok('用例9：也不会误报提示', window.__lastToasts().length === 0, JSON.stringify(window.__lastToasts()));

    return { ok: true, results: R };
  } catch (e) {
    // 关键：只回传字符串。页面里抛出的 Error 跨 realm 时无法被结构化克隆，
    // 直接 return 会让 executeJavaScript 永远不 settle（表现为测试进程卡死）。
    return { ok: false, error: (e && (e.stack || e.message)) || String(e), results: R };
  }
})()
`;

  // 暴露一个读活跃 id 的小工具（避免直接依赖 state 词法作用域）
  stage('loading page: ' + tmpPage);
  await win.loadURL(url.pathToFileURL(tmpPage).href);
  stage('page loaded');
  // 等 init()/loadInitialData 这一轮异步初始化彻底结束，避免它把我们的种子数据覆盖掉
  await new Promise((r) => setTimeout(r, 700));
  stage('settled, injecting helper');
  // 注意：executeJavaScript 会把「最后一条表达式的值」回传给主进程做结构化克隆。
  // 直接写 `window.f = function(){}` 求值结果是函数 → 无法克隆 → 主进程 promise 永不 settle（卡死）。
  // 所以务必用 IIFE 并 return 一个字符串。
  await win.webContents.executeJavaScript(
    '(function(){ window.__activeId = function(){ return state.activeProviderId === undefined ? null : state.activeProviderId; }; return "ok"; })()',
    true
  );
  stage('helper injected');

  let exitCode = 0;
  try {
    stage('running assertions');
    // 加硬超时：一旦页面 promise 不 settle（跨 realm 拒绝等），不允许进程挂死
    const out = await Promise.race([
      win.webContents.executeJavaScript(script, true),
      new Promise((res) => setTimeout(() => res({
        ok: false,
        error: 'TIMEOUT: executeJavaScript 20s 内未返回（页面脚本可能卡住）',
        results: []
      }), 20000))
    ]);
    stage('assertions returned');

    const results = out.results || [];
    console.log('\n=========== AI 模型服务「开启即选中」回归测试 ===========\n');
    let failed = 0;
    for (const r of results) {
      if (!r.pass) failed++;
      console.log(`${r.pass ? '  PASS' : '  FAIL'}  ${r.name}${r.extra ? '   [' + r.extra + ']' : ''}`);
    }
    if (!out.ok) {
      failed++;
      console.error('\n页面脚本异常：\n  ' + String(out.error).split('\n').join('\n  '));
    }
    console.log(`\n合计 ${results.length} 项：通过 ${results.length - failed}，失败 ${failed}`);
    if (pageErrors.length) console.log(`\n页面日志 ${pageErrors.length} 条（含 init 在缺省 DOM 下的预期报错）：\n  ` + pageErrors.slice(0, 8).join('\n  '));
    exitCode = failed === 0 ? 0 : 1;
  } catch (err) {
    console.error('测试执行失败：', (err && err.stack) || err);
    exitCode = 1;
  }

  app.exit(exitCode);
});
