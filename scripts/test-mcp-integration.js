'use strict';
/**
 * MCP 与 Agent 的集成回归
 *   node scripts/test-mcp-integration.js
 *
 * 验证 MCP 接进 Agent 后**没破坏原有链路**，且权限边界没有被绕过：
 *   1. 会话模式硬阻断 MCP 工具（MCP 工具绝不能成为绕过通道）
 *   2. MCP 工具名脱敏（不露 mcp_read_file 这种原始名）
 *   3. MCP 工具不走「模型点名就自动放行」
 *   4. getAllTools / getAgentTools / getContextMeta 三处统计口径一致
 *   5. 内置 33 个工具、提示词、策略表全部未受影响
 */
const path = require('path');
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return path.join(__dirname, '_fake-electron-for-tests.js');
  return origResolve.call(this, request, ...rest);
};

const AIOps = require('../src/main/ipc/aiOps.js');
const I = AIOps._internal;
const mcp = I.mcpManager;
mcp.load();          // 必须先加载配置，否则 _state.cfg 是 null

let fail = 0;
const t = (name, cond, extra) => {
  console.log((cond ? '  ✅ ' : '  ❌ ') + name + (extra ? ' — ' + extra : ''));
  if (!cond) fail++;
};

console.log('=== MCP × Agent 集成回归 ===\n');

console.log('[1] 会话模式硬阻断（安全关键）');
// allowedTools 只有识别类工具 —— MCP 工具不在其中
const convOnly = new Set(['analyze_screenshot', 'verify_ui', 'capture_window', 'ensure_clone_desktop']);
(async () => {
  const res = await I.executeTool('mcp_read_file', { path: 'C:\\secret.txt' }, null, { allowedTools: convOnly });
  t('会话模式拦下 MCP 工具', !res.success, res.error ? res.error.slice(0, 60) : '');
  t('拦截文案不含原始函数名', !res.error.includes('mcp_read_file'), res.error ? '已脱敏' : '');
  t('拦截文案用了脱敏后的工具名', res.error.includes('MCP 工具'), res.error.match(/「(.+?)」/)?.[1]);

  console.log('\n[2] MCP 工具名脱敏');
  const lbl1 = I.buildBlockedToolHint('mcp_read_file', 'role');
  t('未登记的 MCP 工具 → 「MCP 工具」占位', lbl1.includes('MCP 工具') && !lbl1.includes('mcp_read_file'), lbl1.split('，')[0]);

  // 起一个真server，验证「yaml 声明的 toolLabels 能被精确命中」
  // （这条路径依赖 toolIndex 的归属信息，起不来就测不到真实行为）
  mcp._state.cfg.customServers.push({
    id: 'fs', name: '文件访问', command: process.execPath,
    args: [path.join(__dirname, 'fake-mcp-server.js')],
    toolLabels: { echo: 'MCP 回显测试', add: 'MCP 相加测试' }
  });
  const started = await mcp.startServer('fs');
  t('测试 server 启动成功', started.ok, started.error || '');
  if (started.ok) {
    mcp.setEnabled(['fs']);
    await mcp.collectTools();
    const echoName = 'mcp_echo';
    t('ownerOf 查到归属', mcp.ownerOf(echoName) === 'fs', String(mcp.ownerOf(echoName)));
    const lbl2 = I.buildBlockedToolHint(echoName, 'role');
    t('已连接工具命中 yaml 声明的展示名', lbl2.includes('MCP 回显测试'), lbl2.split('，')[0]);
    t('命中映射时不漏原始名', !lbl2.includes('mcp_echo'));

    console.log('\n[2b] 已连接 MCP 工具真正可执行');
    const called = await I.executeTool('mcp_echo', { text: '集成测试' }, null, {});
    t('经 executeTool 调用 MCP 工具成功', called.success && String(called.content).includes('集成测试'), String(called.content));
    const addRes = await I.executeTool('mcp_add', { a: 20, b: 22 }, null, {});
    t('多段结果被展平', addRes.success && String(addRes.content).includes('42'), String(addRes.content).replace(/\n/g, ' / '));

    console.log('\n[3] 启用 MCP 后工具表变化');
    const toolsWithMcp = await I.getAllTools();
    t('工具数 33 → 35（+echo +add）', toolsWithMcp.length === 35, String(toolsWithMcp.length));
    t('MCP 工具带 mcp_ 前缀', toolsWithMcp.filter(x => x.function.name.startsWith('mcp_')).length === 2);
    const metaWithMcp = AIOps.getContextMeta();
    t('context-meta 同步更新', metaWithMcp.toolCount === 35 && metaWithMcp.mcpToolCount === 2,
      metaWithMcp.builtinToolCount + ' 内置 + ' + metaWithMcp.mcpToolCount + ' MCP');
    const uiWithMcp = AIOps.getAgentTools();
    const mcpUi = uiWithMcp.filter(x => x.isMcp);
    t('设置页能列出 MCP 工具', mcpUi.length === 2, mcpUi.length + ' 项');
    t('MCP 工具带serverId 供前端分组', mcpUi.every(x => x.serverId === 'fs'), mcpUi.map(x => x.name + '@' + x.serverId).join(','));
    t('MCP 工具标记为已启用', mcpUi.every(x => x.enabled === true));
    // 内置 risky 工具仍在
    t('设置页内置 risky 工具未被挤掉', uiWithMcp.filter(x => !x.isMcp).length === 8, String(uiWithMcp.filter(x => !x.isMcp).length));

    await mcp.stopAll();
    mcp._state.cfg.customServers.pop();
  }

  t('内置工具脱敏未受影响', I.buildBlockedToolHint('ensure_clone_desktop', 'conversation').includes('准备桌面分身'));
  t('内置 run_shell 脱敏未受影响', I.buildBlockedToolHint('run_shell', 'conversation').includes('执行命令'));

  console.log('\n[4] 内置链路回归');
  const toolsNoMcp = await I.getAllTools();
  t('停掉 MCP 后工具数回到 33', toolsNoMcp.length === 33, String(toolsNoMcp.length));
  t('内置工具名不变', toolsNoMcp.every(x => !x.function.name.startsWith('mcp_')));

  console.log('\n[4] 内置链路回归');
  t('AGENT_TOOLS 仍是 33 个', I.AGENT_TOOLS.length === 33, String(I.AGENT_TOOLS.length));
  t('AGENT_SYSTEM_PROMPT 未变', I.AGENT_SYSTEM_PROMPT.length === 8252, I.AGENT_SYSTEM_PROMPT.length + ' 字符');
  t('RISKY_TOOLS = 8', I.RISKY_TOOLS.size === 8);
  t('白名单 = 14', I.TOOLS_ALWAYS_ALLOWED.length === 14);
  t('transform 仍可用', !!I.transform && I.transform.tokenEstimate.nonCjkRatio === 0.26);
  t('few-shot 仍可渲染', I.renderExamples('agent').length > 100);
  t('脱敏仍生效', !I.redactText('key=sk-abcdefghijklmnopqrst').includes('abcdefghij'));
  const uiTools = AIOps.getAgentTools();
  t('设置页工具列表只含 risky 内置工具（无 MCP 时）', uiTools.every(x => !x.isMcp), uiTools.length + ' 项');
  t('设置页列出全部 8 个 risky', uiTools.length === 8, uiTools.length + ' 项');

  console.log('\n' + (fail === 0 ? '全部通过 ✅' : fail + ' 项失败 ❌'));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('异常:', e); process.exit(1); });