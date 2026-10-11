// 连通器 UI 探针：验证「聊天页顶部按钮 → 弹窗 → 列表页 → 详情页 → 返回」的渲染与布局
// 用法: env -u ELECTRON_RUN_AS_NODE electron scripts/probe-connector-ui.js --no-sandbox --disable-gpu
//
// 为什么用程序化断言而不是看截图：本模型读不了图片，
// 而「有没有溢出 / 图标是不是曲线 / 详情页有没有混入别的连通器」用 getBoundingClientRect 验更可靠。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT_DIR = path.join(__dirname, '..', 'out');
const WIDTHS = [1400, 1100, 900];

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

// preload 沙箱里 require('js-yaml') 是 undefined，所以让主进程读真实配置再下发。
// 数据源是真实的 connectors.yaml —— 探针要验的就是真实目录渲染出来对不对。
ipcMain.handle('test:connector-list', () => {
  const fs2 = require('fs');
  const y = require('js-yaml');
  const p = path.join(__dirname, '..', 'src', 'main', 'agent-config', 'connectors.yaml');
  const d = y.load(fs2.readFileSync(p, 'utf8'));
  const M = d.authMethods || {};
  // 故意让两个处于已连接状态，好验证"已连接/待授权"两种配色都出现
  const connected = new Set(['github', 'feishu']);
  return (d.connectors || []).map((c) => {
    const flow = c.authFlow || (c.authMethod === 'none' ? 'none' : 'oauth');
    return {
      id: c.id, name: c.name, officialName: c.officialName || c.name,
      category: c.category || 'other', description: c.description || '',
      brandColor: c.brandColor || '#888',
      authMethod: c.authMethod || 'oauth', authFlow: flow,
      authLabel: (M[flow] || {}).label || '需要授权',
      authDesc: (M[flow] || {}).desc || '',
      scopes: c.scopes || [], note: c.note || '',
      authorizeUrl: c.authorizeUrl || '', docsUrl: c.docsUrl || '',
      callbackPort: (d.callbackPorts || [8090])[0],
      connected: connected.has(c.id),
      credentialHint: connected.has(c.id) ? 'ghp_••••7890' : '',
      secretKey: c.secretKey || '',
      needsCredentialInput: flow === 'console'
    };
  });
});

// ── 通用断言注入片段 ──
const HELPERS = `
  var R = { checks: [], fails: [] };
  var ok = function (name, cond, extra) {
    R.checks.push({ name: name, pass: !!cond, extra: extra === undefined ? '' : String(extra) });
    if (!cond) R.fails.push(name + (extra ? ' — ' + extra : ''));
  };
`;

// ── 1. 聊天页顶部按钮（与安全中心并列）──
const PROBE_TOP = `(function () {
  ${HELPERS}
  var btn = document.getElementById('btn-open-connectors');
  ok('顶部有连通器按钮', !!btn);
  if (btn) {
    var r = btn.getBoundingClientRect();
    ok('按钮可见', r.width > 0 && r.height > 0, Math.round(r.width) + '×' + Math.round(r.height));
var icon = btn.querySelector('.el-icon');
  ok('按钮内有图标元素', !!icon);
  ok('图标标记为线稿型（line-icon）', !!(icon && icon.classList.contains('line-icon')),
    icon ? icon.className : '');
  var svg = icon ? icon.querySelector('svg') : null;
  ok('图标已渲染成 svg', !!svg, svg ? svg.getAttribute('viewBox') : '');
  // ★ 本次 bug 的核心断言：线稿图标不能被全局 .el-icon svg 的 fill:currentColor 填实
  if (svg) {
    var cs = getComputedStyle(svg);
    ok('顶部按钮图标计算后 fill=none（未被填实）', cs.fill === 'none', cs.fill);
    ok('有描边色', !!svg.getAttribute('stroke') || !!cs.stroke, cs.stroke);
    // 倾斜 45° 的双回形针：两个 path（笔画的两段）
    ok('双回形针=两个 path', svg.querySelectorAll('path').length === 2,
      svg.querySelectorAll('path').length + ' 个');
    // 45° 倾斜：解析出所有 L/l 线段，要求至少一条 x、y 同时变化（即斜线段）
    var d = Array.from(svg.querySelectorAll('path')).map(function (p) { return p.getAttribute('d') || ''; }).join(' ');
    var segs = [];
    var re = /([ml])\\s*(-?[\\d.]+)[\\s,]+(-?[\\d.]+)/gi, m;
    while ((m = re.exec(d)) !== null) {
      segs.push({ rel: m[1].toLowerCase() === 'l', x: parseFloat(m[2]), y: parseFloat(m[3]) });
    }
    var diagonal = segs.filter(function (s) { return Math.abs(s.x) > 0.5 && Math.abs(s.y) > 0.5; });
    ok('路径含 45° 斜线段', diagonal.length >= 2, diagonal.length + ' 条斜段 / 共 ' + segs.length + ' 段');
    // 圆弧也应存在（回形针的钩是圆弧）
    ok('路径含圆弧（回形针钩）', /a\\s*[-\\d.]/i.test(d), (d.match(/a[-\\d.]+/i) || [''])[0]);
    ok('路径总长度合理（不是退化的一条线）', d.length > 60, d.length + ' 字符');
  }
  ok('按钮标题正确', (btn.getAttribute('title') || '').indexOf('连通器') >= 0, btn.getAttribute('title'));
  }
  var secBtn = document.getElementById('btn-open-security-center');
  if (btn && secBtn) {
    var a = btn.getBoundingClientRect(), b = secBtn.getBoundingClientRect();
    ok('与安全中心按钮同高', Math.abs(a.height - b.height) < 2, Math.round(a.height) + ' vs ' + Math.round(b.height));
    ok('与安全中心按钮垂直对齐', Math.abs(a.top - b.top) < 3, 'Δtop=' + Math.round(Math.abs(a.top - b.top)));
    ok('紧邻安全中心右侧', a.left >= b.right - 1 && (a.left - b.right) < 16, '间距 ' + Math.round(a.left - b.right) + 'px');
    ok('未溢出视口右边界', a.right <= window.innerWidth, Math.round(a.right) + ' / ' + window.innerWidth);
  }
  if (btn) btn.click();
  return R;
})()`;

// ── 2. 列表页 ──
const PROBE_LIST = `(function () {
  ${HELPERS}
  var ov = document.getElementById('conn-modal-overlay');
  ok('弹窗已显示', ov && ov.style.display !== 'none', ov ? ov.style.display : 'missing');
  var modal = document.getElementById('conn-modal');
  ok('弹窗主体存在', !!modal);
  if (modal) {
    var r = modal.getBoundingClientRect();
    ok('弹窗在视口内', r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight,
      Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + '×' + Math.round(r.height));
  }

  // 列表页不应有返回按钮
  var back = document.getElementById('conn-back-btn');
  ok('列表页隐藏返回按钮', back && back.style.display === 'none', back ? back.style.display : 'missing');
  // 旧图标栏应已移除
  ok('顶部图标栏已移除', !document.getElementById('conn-icon-bar'));

  var body = document.getElementById('conn-modal-body');
  var rows = body ? body.querySelectorAll('.conn-pick-row') : [];
  ok('列表渲染出全部连通器', rows.length === 17, rows.length + ' 行');
  var cats = body ? body.querySelectorAll('.conn-picker-cat') : [];
  ok('按分类分组', cats.length >= 5, cats.length + ' 组');

  // ── 曲别针图标：纯线条、无填充 ──
  var clips = body ? Array.from(body.querySelectorAll('.conn-pick-ico svg')) : [];
  ok('每行都有曲别针图标', clips.length === 17, clips.length + ' 个');
  var paths = clips.filter(s => s.querySelector('path'));
  ok('曲别针用 path 勾勒', paths.length === clips.length, paths.length + '/' + clips.length);
  // 「只能用简单的线条勾勒」→ fill 必须是 none，且 stroke 有值。
  // ★ 用 **computedStyle** 而不是 getAttribute：本次 bug 正是属性写了 none
  //   却被全局 CSS 覆盖，属性检查会误判为通过。
  var noFill = clips.filter(s => getComputedStyle(s).fill === 'none');
  ok('曲别针计算后无填充（fill=none）', noFill.length === clips.length, noFill.length + '/' + clips.length);
  var stroked = clips.filter(s => s.getAttribute('stroke') && s.getAttribute('stroke') !== 'none');
  ok('曲别针有描边', stroked.length === clips.length, stroked.length + '/' + clips.length);
  var sw = clips.map(s => parseFloat(s.getAttribute('stroke-width')));
  ok('描边宽度统一且偏细（简单线条感）', new Set(sw).size === 1 && sw[0] <= 2, sw[0]);
  // 双回形针 = 两个 path；单path 的是上���版的旧图形
  var twoPath = clips.filter(s => s.querySelectorAll('path').length === 2);
  ok('每个曲别针是双回形针（2 个 path）', twoPath.length === clips.length, twoPath.length + '/' + clips.length);
  // 尺寸一致
  var sizes = clips.map(s => Math.round(s.getBoundingClientRect().width));
  ok('图标尺寸一致', new Set(sizes).size === 1, sizes[0] + 'px');
  ok('图标尺寸合理', sizes[0] >= 16 && sizes[0] <= 24, sizes[0] + 'px');
  // 颜色区分状态：已连接为绿、待授权为品牌色
  var colors = clips.map(s => s.getAttribute('stroke'));
  ok('已连接用绿色', colors.filter(c => c === '#4caf50').length === 2, colors.filter(c => c === '#4caf50').length + ' 个');
  ok('待授权用各自品牌色', new Set(colors).size >= 8, new Set(colors).size + ' 种不同颜色');

  // 无旧的官方字形（应该有 svg 但不含多段 path）
  var multiPath = clips.filter(s => s.querySelectorAll('path').length > 2);
  ok('曲别针只有一条路径（不是各家字形）', multiPath.length === 0, multiPath.length + ' 个多路径');

  var badges = body ? body.querySelectorAll('.conn-pick-badge.ok') : [];
  ok('已连接的带「已连接」徽标', badges.length === 2, badges.length + ' 个');
  if (body) ok('内容区无横向溢出', body.scrollWidth <= body.clientWidth + 2, body.scrollWidth + ' / ' + body.clientWidth);
  return R;
})()`;

// ── 3. 点某行 → 详情页（只展示这一个）──
const PROBE_DETAIL = `(function () {
  ${HELPERS}
  var body = document.getElementById('conn-modal-body');
  var row = body.querySelector('.conn-pick-row:not(.connected)');   // 取一个待授权的（token/console 型）
  ok('列表里有待授权项可点', !!row);
  if (row) row.click();

  var auth = document.querySelector('.conn-auth');
  ok('详情页渲染成功', !!auth);
  if (!auth) return R;

  // ── 核心要求：详情页只展示所选的那一个，不能混入其他连通器 ──
  var text = auth.textContent || '';
  var allRows = window.ConnectorUI ? window.ConnectorUI.list : [];
  var leaked = allRows.filter(function (c) {
    return c.id !== window.ConnectorUI.currentId && text.indexOf(c.name) >= 0;
  });
  ok('详情页不含其他连通器', leaked.length === 0,
    leaked.length ? '混入了: ' + leaked.map(c => c.name).join(', ') : '仅当前一个');
  ok('详情页内没有列表行', auth.querySelectorAll('.conn-pick-row').length === 0);
  ok('详情页内没有分类标题', auth.querySelectorAll('.conn-picker-cat').length === 0);

  // 返回按钮
  var back = document.getElementById('conn-back-btn');
  ok('详情页显示返回按钮', back && back.style.display !== 'none', back ? back.style.display : 'missing');
  ok('返回按钮有文字', back && /返回/.test(back.textContent || ''), back ? (back.textContent || '').trim() : '');

  // 标题变成连通器名
  var title = (document.getElementById('conn-modal-title') || {}).textContent || '';
  var cur = window.ConnectorUI ? (window.ConnectorUI.list.find(c => c.id === window.ConnectorUI.currentId) || {}) : {};
  ok('标题显示当前连通器名', title.trim() === (cur.name || '').trim(), title.trim() + ' / 期望 ' + (cur.name || ''));

  // 曲别针（大号）
  var clip = auth.querySelector('.conn-auth-clip svg');
  ok('详情页有曲别针图标', !!clip);
  if (clip) {
    ok('详情页曲别针也是线条', getComputedStyle(clip).fill === 'none' && !!clip.getAttribute('stroke'),
      'fill=' + getComputedStyle(clip).fill);
    ok('详情页曲别针也是双回形针', clip.querySelectorAll('path').length === 2,
      clip.querySelectorAll('path').length + ' 个 path');
    var cw = Math.round(clip.getBoundingClientRect().width);
    ok('详情页曲别针比列表大', cw >= 20, cw + 'px');
  }
  ok('显示官方名称', ((auth.querySelector('.conn-auth-official') || {}).textContent || '').trim().length > 0,
    (auth.querySelector('.conn-auth-official') || {}).textContent);
  ok('有描述', ((auth.querySelector('.conn-auth-desc') || {}).textContent || '').trim().length > 10);
  ok('明示授权方式', /授权/.test(text), (cur.authLabel || ''));

  // ── 授权方式：必须有「跳浏览器」按钮 ──
  var btns = Array.from(auth.querySelectorAll('.conn-auth-actions button'));
  var labels = btns.map(b => b.textContent.trim());
  ok('有「去授权」按钮（跳浏览器）', labels.some(l => /去授权/.test(l)), labels.join(' / '));
  ok('按钮文案含跳转提示', /跳转浏览器/.test(labels.join(' ')), labels.join(' / '));

  // ── 关键：oauth 流程不该有令牌输入框 ──
  if (cur.authFlow === 'oauth') {
    ok('oauth 流程无凭证输入框（自动回调）', !document.getElementById('conn-token-input'),
      cur.authFlow + ' 不需要手填');
  }
  if (cur.connected) {
    ok('已连接的有「断开连接」', labels.some(l => /断开/.test(l)), labels.join(' / '));
  }
  ok('明示加密存储', /DPAPI|加密保存在本机/.test(text));
  return R;
})()`;

// ── 4. 返回按钮生效 ──
const PROBE_BACK = `(function () {
  ${HELPERS}
  var back = document.getElementById('conn-back-btn');
  ok('返回按钮存在', !!back);
  if (back) back.click();
  var rows = document.querySelectorAll('.conn-pick-row');
  ok('返回后回到列表页', rows.length === 17, rows.length + ' 行');
  var backNow = document.getElementById('conn-back-btn');
  ok('返回后隐藏返回按钮', backNow && backNow.style.display === 'none', backNow ? backNow.style.display : '');
  var title = (document.getElementById('conn-modal-title') || {}).textContent || '';
  ok('返回后标题回到「连通器」', title.trim() === '连通器', title.trim());
  ok('返回后 currentId 清空', !window.ConnectorUI.currentId, String(window.ConnectorUI.currentId));
  return R;
})()`;

// ── 5. console 流程：仍跳浏览器，但要说明为什么还要填 ──
const PROBE_CONSOLE = `(function () {
  ${HELPERS}
  var row = document.querySelector('.conn-pick-row[data-pick="tavily"]');
  ok('列表里有 console 流程的服务', !!row);
  if (row) row.click();
  var auth = document.querySelector('.conn-auth');
  var btns = Array.from(auth.querySelectorAll('.conn-auth-actions button')).map(b => b.textContent.trim());
  ok('console 流程也有「去授权」按钮', btns.some(l => /去授权/.test(l)), btns.join(' / '));
  var input = document.getElementById('conn-token-input');
  ok('console 流程才需要输入框', !!input);
  if (input) ok('输入框是密码类型', input.type === 'password', input.type);
  ok('写明了为何仍需填（无标准 OAuth 端点）', /未开放|未提供|控制台/.test(auth.textContent),
    (auth.querySelector('.conn-auth-note') || {}).textContent || '');

  // 点去授权 → 主进程返回 needsCredentialInput，提示要填
  var authBtn = Array.from(auth.querySelectorAll('[data-act="authorize"]'))[0];
  ok('有 authorize 动作按钮', !!authBtn);
  return R;
})()`;

const STEPS = [
  { name: '聊天页顶部按钮', code: PROBE_TOP, wait: 900 },   // open() 里 await load()，要给足时间
  { name: '列表页（曲别针线条）', code: PROBE_LIST, wait: 400 },
  { name: '详情页（只展示所选 + 返回按钮）', code: PROBE_DETAIL, wait: 400 },
  { name: '返回按钮回到列表', code: PROBE_BACK, wait: 300 },
  { name: 'console 流程说明', code: PROBE_CONSOLE, wait: 300 }
];

// 截图前等入场动画结束（overlay 有 0.18s 动画，未结束截图是空弹窗）
async function shoot(win, name) {
  const st = await win.webContents.executeJavaScript(`
    (async function(){
      const ov = document.getElementById('conn-modal-overlay');
      const modal = document.getElementById('conn-modal');
      const anims = (modal.getAnimations ? modal.getAnimations({subtree:true}) : [])
        .concat(ov.getAnimations ? ov.getAnimations({subtree:true}) : []);
      await Promise.all(anims.map(a => a.finished.catch(()=>{})));
      return { opacity: getComputedStyle(ov).opacity, tiles: document.querySelectorAll('.conn-pick-row').length };
    })()
  `);
  console.log('  [截图 ' + name + ' 前状态] ' + JSON.stringify(st));
  const img = await win.webContents.capturePage();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'probe-connector-' + name + '.png'), img.toPNG());
}

let allFails = [];
let totalChecks = 0;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400, height: 800, show: false, frame: false,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, webSecurity: false,
      preload: path.join(__dirname, 'test-settings-preload.js')
    }
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await new Promise(r => setTimeout(r, 2500));

  let step = 0;
  for (const s of STEPS) {
    const res = await win.webContents.executeJavaScript(s.code).catch(e => ({ checks: [], fails: ['执行异常: ' + e.message] }));
    const checks = res.checks || [];
    totalChecks += checks.length;
    allFails = allFails.concat((res.fails || []).map(f => '[' + s.name + '] ' + f));
    console.log('\n===== ' + s.name + '（' + checks.length + ' 项）=====');
    for (const c of checks) console.log((c.pass ? '  ✅ ' : '  ❌ ') + c.name + (c.extra ? ' — ' + c.extra : ''));
    await new Promise(r => setTimeout(r, s.wait));
    // 列表页与详情页各截一张
    if (step === 1) await shoot(win, 'list');
    if (step === 2) await shoot(win, 'detail');
    step++;
  }

  // 多宽度：弹窗与列表都不能溢出
  console.log('\n===== 多宽度检查 =====');
  for (const w of WIDTHS) {
    win.setContentSize(w, 800);
    await new Promise(r => setTimeout(r, 600));
    const r = await win.webContents.executeJavaScript(`
      (function(){
        const modal = document.getElementById('conn-modal');
        const body = document.getElementById('conn-modal-body');
        if(!modal||!body) return {err:'missing'};
        const mr = modal.getBoundingClientRect();
        return {
          w: window.innerWidth,
          modalInView: mr.left >= -1 && mr.right <= window.innerWidth + 1 && mr.top >= -1 && mr.bottom <= window.innerHeight + 1,
          bodyOverflowX: Math.max(0, body.scrollWidth - body.clientWidth),
          rowOverflowX: Math.max(0, ...Array.from(body.querySelectorAll('.conn-pick-row')).map(t => Math.round(t.getBoundingClientRect().right - body.getBoundingClientRect().right))),
          titleClipped: (function(){ const t=document.getElementById('conn-modal-title'); return t.scrollWidth > t.clientWidth + 1; })()
        };
      })()
    `);
    totalChecks += 4;
    const pass = r.modalInView && r.bodyOverflowX <= 2 && r.rowOverflowX <= 1;
    if (!pass) allFails.push('[width ' + w + '] ' + JSON.stringify(r));
    console.log((pass ? '  ✅ ' : '  ❌ ') + 'width ' + r.w
      + ' 弹窗在视口内=' + r.modalInView
      + ' 内容横向溢出=' + r.bodyOverflowX
      + ' 行右溢出=' + r.rowOverflowX);
  }

  console.log('\n================ 汇总 ================');
  console.log('断言总数: ' + totalChecks);
  if (allFails.length === 0) {
    console.log('全部通过 ✅');
  } else {
    console.log('失败 ' + allFails.length + ' 项:');
    allFails.forEach(f => console.log('  ❌ ' + f));
  }
  app.quit();
});

app.on('window-all-closed', () => app.quit());