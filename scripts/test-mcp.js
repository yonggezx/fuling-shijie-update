'use strict';
/**
 * MCP 接入端到端验证
 *   node scripts/test-mcp.js
 *
 * 用 scripts/fake-mcp-server.js 当真实 server，逐条验证协议实现：
 *   握手 / tools/list / tools/call / 名字清洗 / schema 归一化 / 内容展平
 *   / 命令白名单 / 密钥占位 / 超时回收 / 崩溃感知 / stdout 污染免疫
 *   / 会话模式硬阻断 / 工具名脱敏 / 提示片段
 */
const path = require('path');
const Module = require('module');

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return path.join(__dirname, '_fake-electron-for-tests.js');
  return origResolve.call(this, request, ...rest);
};

const { McpStdioClient } = require('../src/main/mcp/mcpClient.js');
const mcp = require('../src/main/mcp/mcpManager.js');

const FAKE = path.join(__dirname, 'fake-mcp-server.js');
const NODE = process.execPath;

let fail = 0;
const t = (name, cond, extra) => {
  console.log((cond ? '  ✅ ' : '  ❌ ') + name + (extra ? ' — ' + extra : ''));
  if (!cond) fail++;
};

function makeClient(id, serverArgs, over) {
  return new McpStdioClient(Object.assign({
    id, command: NODE, args: [FAKE].concat(serverArgs || []),
    startupTimeoutMs: 15000, callTimeoutMs: 8000
  }, over || {}));
}

(async () => {
  console.log('=== MCP 接入验证 ===\n');

  // ═════════════════════════════════════════════════════════════════════════
  console.log('[1] 握手与基础协议');
  const c1 = makeClient('t1');
  const hs = await c1.start();
  t('握手成功', hs.ok, hs.error || '');
  t('protocolVersion 已协商', c1.protocolVersion === '2025-06-18', c1.protocolVersion);
  t('读到 serverInfo', c1.serverInfo && c1.serverInfo.name === 'fake-mcp-test', JSON.stringify(c1.serverInfo));
  t('能力位齐全', c1.capabilities.tools && c1.capabilities.resources && c1.capabilities.prompts);
  t('status = ready', c1.status === 'ready');

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n[2] tools/list与 tools/call');
  const tools = await c1.listTools();
  t('拿到 2 个工具', tools.length === 2, String(tools.length));
  t('工具名正确', tools.map(x => x.name).sort().join(',') === 'add,echo', tools.map(x => x.name).join(','));

  const r1 = await c1.callTool('echo', { text: '你好' });
  t('tools/call 成功', !r1.isError);
  t('返回内容正确', r1.content[0].text === 'echo: 你好', r1.content[0].text);

  const r2 = await c1.callTool('add', { a: 3, b: 4 });
  t('多段内容都返回', r2.content.length === 2, r2.content.length + ' 段');
  t('多段内容可展平', mcp._flattenContent(r2.content).includes('7') && mcp._flattenContent(r2.content).includes('第二段'), mcp._flattenContent(r2.content).replace(/\n/g, ' / '));

  let errCaught = false;
  try { await c1.callTool('nope', {}); } catch (e) { errCaught = true; t('JSON-RPC error 抛为异常', /unknown tool/.test(e.message), e.message); }
  if (!errCaught) t('JSON-RPC error 抛为异常', false, '没有抛');

  t('工具清单被缓存', (await c1.listTools()).length === 2);
  await c1.stop();
  t('停止后 status 正确', c1.status === 'stopped', c1.status);

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n[3] 畸形输入免疫');
  const c2 = makeClient('t2', ['--noise']);
  const hs2 = await c2.start();
  t('stdout 混入非 JSON 行仍握手成功', hs2.ok, hs2.error || '');
  const tools2 = await c2.listTools();
  t('非 JSON 行未污染工具清单', tools2.length === 2, String(tools2.length));
  t('stderr 被单独收集', c2._stderrTail.length > 0, c2._stderrTail.slice(-1)[0]);
  await c2.stop();

  const c3 = makeClient('t3', ['--weird-schema']);
  await c3.start();
  const tools3 = await c3.listTools();
  const weird = tools3.find(x => x.name === 'weird.tool/v2');
  t('拿到畸形 schema 工具', !!weird);
  const norm = mcp._normalizeSchema(weird.inputSchema);
  t('缺 type 自动补 object', norm.type === 'object', norm.type);
  t('required 过滤掉不存在的字段', Array.isArray(norm.required) && !norm.required.includes('notExist'), JSON.stringify(norm.required));
  t('空 schema 兜底成自由对象', mcp._normalizeSchema(null).type === 'object' && mcp._normalizeSchema(undefined).additionalProperties === true);
  t('数组 schema 不被当成对象', mcp._normalizeSchema([1, 2]).type === 'object');
  await c3.stop();

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n[4] 超时与崩溃');
  const c4 = makeClient('t4', ['--slow'], { callTimeoutMs: 1200 });
  await c4.start();
  const slowStart = Date.now();
  let timedOut = false;
  try { await c4.callTool('echo', { text: 'x' }); } catch (e) { timedOut = /超时/.test(e.message); }
  const elapsed = Date.now() - slowStart;
  t('tools/call 超时被回收', timedOut, elapsed + 'ms');
  t('超时时间接近配置值', elapsed >= 1000 && elapsed < 2500, elapsed + 'ms');
  t('超时后 pending 已清空', c4.pending.size === 0, String(c4.pending.size));
  // 超时之后 server 才回的响应不应该崩
  await new Promise(r => setTimeout(r, 2200));
  t('迟到响应被安全丢弃（未崩溃）', c4.status === 'ready', c4.status);
  await c4.stop();

  const c5 = makeClient('t5', ['--crash-after-tools']);
  const hs5 = await c5.start();
  await new Promise(r => setTimeout(r, 400));
  t('握手成功后崩溃 → status = crashed', c5.status === 'crashed', c5.status + ' / ' + (c5.error || ''));
  let crashRejected = false;
  try { await c5.callTool('echo', { text: 'y' }); } catch (e) { crashRejected = /退出|未运行/.test(e.message); }
  t('崩溃后调用立即失败（不挂死）', crashRejected);
  t('崩溃后 pending 全清', c5.pending.size === 0);

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n[5] 命令白名单（安全关键）');
  const cfg = mcp.load();
  const allowOk = mcp.checkCommandAllowed({ command: 'npx' }, cfg);
  const allowBad = mcp.checkCommandAllowed({ command: 'powershell.exe' }, cfg);
  const allowBad2 = mcp.checkCommandAllowed({ command: 'cmd /c calc' }, cfg);
  t('npx 通过', allowOk.ok);
  t('powershell 被拒', !allowBad.ok && /白名单/.test(allowBad.error), allowBad.error);
  t('cmd /c calc 被拒（参数混进 command）', !allowBad2.ok && /参数/.test(allowBad2.error), allowBad2.error);
  // basename 命中白名单但路径不可信 —— 必须拒（伪装绕过）
  const bypass1 = mcp.checkCommandAllowed({ command: 'C:\\Users\\Public\\evil\\node.exe' }, cfg);
  const bypass2 = mcp.checkCommandAllowed({ command: 'C:\\Windows\\System32\\cmd.exe' }, cfg);
  const bypass3 = mcp.checkCommandAllowed({ command: 'powershell -enc AAAA' }, cfg);
  t('伪装路径（Public\\evil）被拒', !bypass1.ok && /可信安装位置/.test(bypass1.error), bypass1.error);
  t('System32\\cmd.exe 被拒（basename 不在白名单）', !bypass2.ok, bypass2.error);
  t('powershell 带参数被拒', !bypass3.ok, bypass3.error);
  // 但真实运行时路径必须放行 —— 打包后 process.execPath 就是绝对路径
  const realNode = mcp.checkCommandAllowed({ command: process.execPath }, cfg);
  t('process.execPath 绝对路径被放行（打包后必需）', realNode.ok, process.execPath + ' → ' + (realNode.error || 'OK'));
  const realUpx = mcp.checkCommandAllowed({ command: 'C:\\Users\\me\\.local\\bin\\uv.exe' }, cfg);
  t('用户级 uv.exe 被放行', realUpx.ok, realUpx.error || 'OK');
  t('空命令被拒', !mcp.checkCommandAllowed({}, cfg).ok);
  t('.exe 后缀能正确归一', mcp.checkCommandAllowed({ command: 'node.exe' }, cfg).ok);
  t('大小写不敏感', mcp.checkCommandAllowed({ command: 'NPX' }, cfg).ok);
  const hc = mcp.healthCheck();
  t('healthCheck 通过（出厂清单命令都合规）', hc.ok, hc.problems.join('; '));
  // 加载失败绝不能被healthCheck 静默放过
  t('mcp-servers.yaml 真的被解析了', mcp._state.error === null && mcp._state.cfgFile !== null, mcp._state.error || '已加载');
  t('出厂 server 清单非空', mcp.allServers().length >= 10, String(mcp.allServers().length));
  t('⚠️ 表格标❌ 的 server 确实不在清单里',
    !mcp.allServers().some(s => ['everything', 'playwright', 'docker', 'kubernetes', 'postgres', 'mysql'].includes(s.id)),
    mcp.allServers().map(s => s.id).join(','));
  t('排除原因有记录', mcp.load().excluded.length === 9, String(mcp.load().excluded.length));

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n[6] 密钥占位解析');
  const def = { env: { TOKEN: '${secret:some-k}', PATHLIKE: '${env:MCP_FS_ROOTS}' } };
  const v1 = mcp._resolveValue('${secret:some-k}', def);
  t('secret 占位解出（凭证库为空时为空串，不报错）', v1 === '', JSON.stringify(v1));
  process.env.__MCP_TEST_ENV = 'E:\\data';
  const v2 = mcp._resolveValue('${env:__MCP_TEST_ENV}', def);
  t('env 占位能从 process.env 解出', v2 === 'E:\\data', v2);
  const v3 = mcp._resolveValue('--root ${env:__MCP_TEST_ENV}', def);
  t('混在字符串里也能替换', v3 === '--root E:\\data', v3);
  const v4 = mcp._resolveValue('${env:NOPE_NOT_SET}', def);
  t('未设置的 env 解为空串', v4 === '');
  // 自引用防呆
  const loopDef = { env: { X: '${env:X}' } };
  t('自引用占位不解成死循环', mcp._resolveValue('${env:X}', loopDef) === '');

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n[7] 工具名清洗与去重');
  t('点号斜杠被洗成下划线', mcp._sanitizeToolName('weird.tool/v2') === 'weird_tool_v2', mcp._sanitizeToolName('weird.tool/v2'));
  t('超长名被截断', mcp._sanitizeToolName('x'.repeat(100)).length === 64);
  t('合法名原样保留', mcp._sanitizeToolName('read_file') === 'read_file');

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n[8] 真实起一个 server 并桥接成工具');
  // 临时把 fake server 塞进 customServers，走完整 manager 链路
  mcp.load();
  const servers = mcp.allServers();
  servers.push({ id: '__test', name: '测试 server', command: NODE, args: [FAKE], enabled: true, toolLabels: { echo: '测试回显', add: '测试相加' } });
  // allServers 走 Map 合并，这里直接改内部 state 保持同一路径
  mcp._state.cfg.customServers.push({ id: '__test', name: '测试 server', command: NODE, args: [FAKE], toolLabels: { echo: '测试回显', add: '测试相加' } });

  t('自定义 server 已在清单里', !!mcp.getServerDef('__test'));
  const started = await mcp.startServer('__test');
  t('startServer 成功', started.ok, started.error || '');
  if (!started.ok) {
    console.log('\n启动失败，后续桥接测试跳过');
    process.exit(1);
  }
  mcp.setEnabled(['__test']);
  const bridged = await mcp.collectTools();
  t('桥接出2 个工具', bridged.length === 2, bridged.map(x => x.function.name).join(','));
  t('工具名带 mcp_ 前缀', bridged.every(x => x.function.name.startsWith('mcp_')), bridged.map(x => x.function.name).join(','));
  t('描述里标了来源 server', bridged[0].function.description.includes('测试 server'), bridged[0].function.description);
  t('schema 是合法 function 格式', bridged.every(x => x.type === 'function' && x.function.parameters && x.function.parameters.type === 'object'));
  t('ownerOf 能查到归属', mcp.ownerOf(bridged[0].function.name) === '__test', String(mcp.ownerOf(bridged[0].function.name)));

  const call = await mcp.callTool(bridged.find(x => x.function.name.endsWith('echo')).function.name, { text: '桥接成功' });
  t('经 manager 调用成功', call.success && call.content.includes('桥接成功'), call.content);

  const unknown = await mcp.callTool('mcp__test__nope', {});
  t('未注册工具被拒', !unknown.success && /未注册/.test(unknown.error), unknown.error);

  const notice = mcp.buildPromptNotice();
  t('提示片段已生成', notice.includes('mcp_') && notice.includes('测试 server'), notice.replace(/\n/g, ' ').slice(0, 90));
  t('未启用时提示片段为空', (mcp.setEnabled([]), mcp.buildPromptNotice() === ''));

  await mcp.stopAll();
  t('stopAll 后无运行中 server', mcp.status().running.length === 0);

  console.log('\n' + (fail === 0 ? '全部通过 ✅' : fail + ' 项失败 ❌'));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('\n验证脚本异常:', e);
  process.exit(1);
});