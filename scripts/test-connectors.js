'use strict';
/**
 * 连通器授权链路验证
 *   node scripts/test-connectors.js
 *
 * 覆盖：
 *   1. 目录加载（图标/名称/授权方式完整性）
 *   2. 授权 URL 校验（只认 https，拒绝钓鱼/开放重定向）
 *   3. 凭证存取（长度校验、换行检测、掩码不泄明文）
 *   4. safeStorage 不可用时**拒绝明文落盘**
 *   5. OAuth 回调服务器（state 校验、只收本机请求、超时清理）
 *   6. 不泄露：listConnectors 的返回值里不能有任何凭证内容
 */
const path = require('path');
const Module = require('module');
const fs = require('fs');

// ── mock electron：safeStorage 可开关，用来测「不可用时拒绝落盘」──
let _encAvailable = true;
const _store = new Map();
const fakeElectron = path.join(__dirname, '_fake-electron-for-tests.js');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return fakeElectron;
  return origResolve.call(this, request, ...rest);
};
// 覆盖 mock 的 safeStorage，让它可控
const fake = require(fakeElectron);
fake.safeStorage = {
  isEncryptionAvailable: () => _encAvailable,
  encryptString: (s) => Buffer.from('ENC:' + s, 'utf8'),
  decryptString: (b) => Buffer.from(b).toString('utf8').replace(/^ENC:/, '')
};
// 塞一个假窗口，用来验证 OAuth 回调事件确实送到了渲染层
const windows = [fake.addFakeWindow()];
// shell.openExternal 调过的 URL，供断言
const opened = fake.__openedUrls;

const Connectors = require('../src/main/ipc/connectors.js');

let fail = 0;
const t = (name, cond, extra) => {
  console.log((cond ? '  ✅ ' : '  ❌ ') + name + (extra ? ' — ' + extra : ''));
  if (!cond) fail++;
};

(async () => {
  console.log('=== 连通器授权链路验证 ===\n');

  console.log('[1] 目录加载');
  Connectors.load();
  const list = Connectors.listConnectors();
  t('目录已加载', list.length > 0, list.length + ' 个连通器');
  t('解析无错误', Connectors._state.error === null, Connectors._state.error || '无');
  t('每个都有官方名称', list.every(c => c.officialName && c.officialName.length));
  // 图标已统一为曲别针线条，不再由配置下发 icon —— 断言"不下发"才是关键
  t('不下发 icon（统一用曲别针线条）', list.every(c => c.icon === undefined),
    list.filter(c => c.icon !== undefined).map(c => c.id).join(',') || '无');
  t('每个都有品牌色', list.every(c => /^#[0-9a-fA-F]{3,8}$/.test(c.brandColor)),
    list.filter(c => !/^#[0-9a-fA-F]{3,8}$/.test(c.brandColor)).map(c => c.id).join(','));
  t('id 无重复', new Set(list.map(c => c.id)).size === list.length);
  t('需授权的都有 secretKey', list.filter(c => c.authFlow !== 'none').every(c => c.secretKey));

  console.log('\n[1b] 授权方式：全部跳浏览器（用户要求）');
  t('没有 manual-token / api-key 残留', !list.some(c => c.authMethod === 'manual-token' || c.authMethod === 'api-key'),
    [...new Set(list.map(c => c.authMethod))].join(','));
  const flows = {};
  for (const c of list) flows[c.authFlow] = (flows[c.authFlow] || 0) + 1;
  t('authFlow 只有 oauth/console/none', Object.keys(flows).every(k => ['oauth', 'console', 'none'].includes(k)),
    JSON.stringify(flows));
  const needJump = list.filter(c => c.authFlow !== 'none');
  t('需授权的都有授权页 URL（可跳浏览器）', needJump.every(c => !!c.authorizeUrl),
    needJump.filter(c => !c.authorizeUrl).map(c => c.id).join(','));
  const badUrl = needJump.filter(c => {
    try { return new URL(c.authorizeUrl).protocol !== 'https:'; } catch (e) { return true; }
  });
  t('授权页都是 https', badUrl.length === 0, badUrl.map(c => c.id).join(','));
  t('oauth 流程带回调端口', list.filter(c => c.authFlow === 'oauth').every(c => c.callbackPort > 0),
    String((list.find(c => c.authFlow === 'oauth') || {}).callbackPort));
  t('console 流程标记需填凭证', list.filter(c => c.authFlow === 'console').every(c => c.needsCredentialInput === true),
    list.filter(c => c.authFlow === 'console').map(c => c.id).join(','));
  t('oauth 流程不标记需填凭证', list.filter(c => c.authFlow === 'oauth').every(c => !c.needsCredentialInput));
  t('每个都有授权方式说明', list.every(c => !!c.authLabel && !!c.authDesc));
  t('内置能力标为 none', list.filter(c => c.authFlow === 'none').length === 1);
  t('分类覆盖到 dev/办公/搜索/存储', new Set(list.map(c => c.category)).size >= 5,
    [...new Set(list.map(c => c.category))].join(','));

  console.log('\n[2] 授权 URL 校验（安全关键）');
  const httpsDef = { authorizeUrl: 'https://github.com/login/oauth/authorize' };
  const httpDef = { authorizeUrl: 'http://evil.com/steal' };
  const localhostDef = { authorizeUrl: 'http://localhost:8080/cb' };
  const jsDef = { authorizeUrl: 'javascript:alert(1)' };
  const fileDef = { authorizeUrl: 'file:///C:/secret' };
  const badDef = { authorizeUrl: 'not a url' };
  const noDef = {};
  t('https 通过', Connectors.safeAuthorizeUrl(httpsDef) === httpsDef.authorizeUrl);
  t('外站 http 被拒', Connectors.safeAuthorizeUrl(httpDef) === '');
  t('localhost http 放行（官方自带回调服务器）', Connectors.safeAuthorizeUrl(localhostDef) === localhostDef.authorizeUrl);
  t('javascript: 被拒', Connectors.safeAuthorizeUrl(jsDef) === '');
  t('file: 被拒', Connectors.safeAuthorizeUrl(fileDef) === '');
  t('非法 URL 被拒', Connectors.safeAuthorizeUrl(badDef) === '');
  t('无地址返回空', Connectors.safeAuthorizeUrl(noDef) === '');
  t('令牌页同样只认 https', Connectors.safeTokenUrl({ tokenUrl: 'http://x.com' }) === '');

  console.log('\n[3] 凭证存取');
  const gh = list.find(c => c.id === 'github');
  t('初始未连接', !Connectors.isConnected('github'));
  t('未连接时掩码为空', Connectors.credentialHint('github') === '');

  let r = Connectors.saveCredential('github', '');
  t('空令牌被拒', !r.success && /不能为空/.test(r.error), r.error);
  r = Connectors.saveCredential('github', 'short');
  t('过短令牌被拒', !r.success && /长度异常/.test(r.error), r.error);
  r = Connectors.saveCredential('github', 'ghp_abc\ndef123456');
  t('带换行的令牌被拒（粘贴事故）', !r.success && /换行/.test(r.error), r.error);
  r = Connectors.saveCredential('nonexistent-connector', 'abcdefgh123');
  t('未知连通器被拒', !r.success && /未找到/.test(r.error));

  const TOKEN = 'ghp_realTokenValue1234567890';
  r = Connectors.saveCredential('github', TOKEN);
  t('合法令牌保存成功', r.success, r.error || '');
  t('已连接', Connectors.isConnected('github'));
  const hint = Connectors.credentialHint('github');
  t('掩码含首尾 4 位', hint.includes(TOKEN.slice(0, 4)) && hint.includes(TOKEN.slice(-4)), hint);
  t('掩码不含完整令牌', !hint.includes(TOKEN) && hint.includes('••••'), hint);

  console.log('\n[4] 不泄露');
  const dumped = JSON.stringify(list);
  t('清单里没有令牌明文', !dumped.includes(TOKEN));
  t('清单里没有真实凭证内容', !dumped.includes('realTokenValue'));
  // 重新拉一次（已连接状态下）再查一遍 —— connected=true 时最容易漏
  const listAfter = Connectors.listConnectors();
  t('已连接状态下清单仍无明文', !JSON.stringify(listAfter).includes(TOKEN));
  t('connected 标记正确', listAfter.find(c => c.id === 'github').connected === true);

  console.log('\n[5] safeStorage 不可用时拒绝落盘');
  _encAvailable = false;
  r = Connectors.saveCredential('gitlab', 'glpat-xxxxxxxxxxxx');
  t('加密不可用时保存被拒', !r.success, r.error || '');
  t('拒绝原因说明白了', /加密不可用|明文/.test(r.error || ''), r.error);
  t('确实没写进去', !Connectors.isConnected('gitlab'));
  const hcWarn = Connectors.healthCheck();
  t('healthCheck 给出警告', hcWarn.warnings.some(w => /safeStorage|加密/.test(w)), hcWarn.warnings.join('; '));
  _encAvailable = true;
  r = Connectors.saveCredential('gitlab', 'glpat-validtoken123');
  t('恢复后能正常保存', r.success, r.error || '');

  console.log('\n[6] 断开连接');
  r = Connectors.disconnect('github');
  t('断开成功', r.success, r.error || '');
  t('断开后未连接', !Connectors.isConnected('github'));
  t('断开后掩码清空', Connectors.credentialHint('github') === '');
  r = Connectors.disconnect('builtin-web');
  t('内置能力不能断开', !r.success && /无需授权/.test(r.error), r.error);

console.log('\n[7] 授权发起（两种流程）');
  const builtin = list.find(c => c.authFlow === 'none');
  const rb = await Connectors.beginOAuth(builtin.id);
  t('内置能力发起授权被拒', !rb.success && /无需授权/.test(rb.error), rb.error);
  const r3 = await Connectors.beginOAuth('nope');
  t('未知 id 被拒', !r3.success, r3.error);

  // ── console 流程：无 OAuth 端点，只跳控制台，不监听回调 ──
  const consoleOne = list.find(c => c.authFlow === 'console');
  opened.length = 0;
  const rc = await Connectors.beginOAuth(consoleOne.id);
  t('console 流程发起成功', rc.success, rc.error || '');
  t('console 标记了 flow', rc.flow === 'console', rc.flow);
  t('console 要求填凭证', rc.needsCredentialInput === true);
  t('console 跳的是 https 地址', (() => { try { return new URL(rc.authorizeUrl).protocol === 'https:'; } catch (e) { return false; } })(), rc.authorizeUrl);
  t('console 流程不监听回调', Connectors._state.callbackServer === null && Connectors._state.pending.size === 0,
    'server=' + (Connectors._state.callbackServer ? '已起' : '未起'));
  t('console 确实调了 openExternal', opened.length === 1, opened[opened.length - 1]);

  // ── oauth 流程：起回调 + 跳授权页 + state 校验 ──
  const opened2 = opened.length;

  // 先验证守卫：没有 client_id 时不应硬跳浏览器，而是提示先填 App ID
  // （github 在 yaml 里已配真实 clientId，测试前先清空以复现"未配置"场景）
  Connectors._state.byId.get('github').clientId = '';
  const rGuard = await Connectors.beginOAuth('github');
  t('未配 client_id 时拒绝跳转', rGuard.success === false && rGuard.needsClientIdInput === true,
    rGuard.error || '');
  t('未配 client_id 时没起回调服务器', Connectors._state.callbackServer === null);

  // 注入测试 clientId（测试环境 safeStorage 不可用，走 yaml def.clientId 兜底）
  Connectors._state.byId.get('github').clientId = 'fake-github-client';
  const r5 = await Connectors.beginOAuth('github');
  t('oauth 发起成功', r5.success, r5.error || '');
  if (r5.success) {
    const authUrl = new URL(opened[opened.length - 1]);
    t('跳转的是 github 官方域名', authUrl.hostname === 'github.com', authUrl.hostname);
    t('用的是 https', authUrl.protocol === 'https:', authUrl.protocol);
    t('client_id 带上了配置的 App ID', authUrl.searchParams.get('client_id') === 'fake-github-client',
      authUrl.searchParams.get('client_id') || '(空)');
    t('response_type=code', authUrl.searchParams.get('response_type') === 'code');
    t('带 state 随机值', /^[0-9a-f]{32}$/.test(authUrl.searchParams.get('state') || ''), authUrl.searchParams.get('state'));
    t('带 redirect_uri 指向本地回调', (authUrl.searchParams.get('redirect_uri') || '').startsWith('http://127.0.0.1:'), authUrl.searchParams.get('redirect_uri'));
    t('带 scope', (authUrl.searchParams.get('scope') || '').includes('repo'), authUrl.searchParams.get('scope'));

    // 回调服务器起来了吗
    t('本地回调服务器已启动', Connectors._state.callbackServer !== null);
    t('回调端口在白名单内', Connectors.ALLOWED_CALLBACK_PORTS.includes(Connectors._state.callbackPort), String(Connectors._state.callbackPort));
    t('pending 里有本次会话', Connectors._state.pending.size === 1);

    // 真实发一个 state 不匹配的回调 → 应被拒（防 CSRF）
    const port = Connectors._state.callbackPort;
    const bad = await new Promise((resolve) => {
      require('http').get({
        host: '127.0.0.1', port,
        path: '/callback?code=STOLEN&state=deadbeefdeadbeefdeadbeefdeadbeef'
      }, (res) => {
        let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ status: res.statusCode, body: b }));
      }).on('error', (e) => resolve({ error: e.message }));
    });
    t('state 不匹配的回调被拒', bad.status === 400, 'HTTP ' + bad.status);
    t('拒绝页面说明是 state 问题', /state/.test(bad.body || ''), (bad.body || '').match(/<p>([^<]*)<\/p>/)?.[1] || '');

    // 正确的 state → 应通过并把 code 送回渲染层
    const realState = authUrl.searchParams.get('state');
    const good = await new Promise((resolve) => {
      require('http').get({
        host: '127.0.0.1', port,
        path: '/callback?code=REAL_AUTH_CODE&state=' + encodeURIComponent(realState)
      }, (res) => {
        let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ status: res.statusCode, body: b }));
      }).on('error', (e) => resolve({ error: e.message }));
    });
    t('state 正确的回调被接受', good.status === 200, 'HTTP ' + good.status);
    t('成功页面含「授权成功」', /授权成功/.test(good.body || ''));
    t('会话已从 pending 移除', Connectors._state.pending.size === 0);
    t('授权码已通知渲染层', windows.some(w => (w.__sent || []).some(m => m && m.channel === 'connector:event' && m.payload && m.payload.code === 'REAL_AUTH_CODE')));

    Connectors.stopCallbackServer();
    t('回调服务器已关闭', Connectors._state.callbackServer === null);
  }

  console.log('\n[8] healthCheck');
  const hc = Connectors.healthCheck();
  t('健康检查通过', hc.ok, hc.problems.join('; '));

  console.log('\n' + (fail === 0 ? '全部通过 ✅' : fail + ' 项失败 ❌'));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('\n验证脚本异常:', e);
  process.exit(1);
});