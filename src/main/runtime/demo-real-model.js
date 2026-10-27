'use strict';
/**
 * 真实模型适配器端到端演示：运行时 model-adapter-real → 真实 HTTP function-calling → 真实 MCP 工具。
 *
 * 复用上一阶段的真实 MCP 桥接（运行时 ↔ mcpManager ↔ 最小真实 MCP 服务器），
 * 再把 mock 模型替换为真实 OpenAI 兼容适配器：
 *   1) 加载 mcp-bridge，启用真实 MCP 服务器（临时配置，不碰用户配置）
 *   2) 加载 model-adapter-real，指向一个最小 OpenAI 兼容 /v1/chat/completions 服务器
 *   3) 运行一个目标 —— 适配器发真实 HTTP，拿到 mcp_greet 的 tool_calls → 循环执行真实 MCP 工具
 *      → 再次 HTTP（带工具结果）→ 得到最终文本 → 完成
 *   4) 停掉 fake 端点，验证无端点时适配器回退启发式仍能驱动真实 MCP 工具（循环不空转）
 *
 * 运行：node src/main/runtime/demo-real-model.js
 * 输出：控制台 + runtime-real-model-report.txt
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { createRuntime, writeJson } = require('./index');
const mcp = require('../mcp/mcpManager');
const state = require('./state');

const OUT = path.join(__dirname, 'runtime-real-model-report.txt');
const lines = [];
const log = (s) => { lines.push(s); console.log(s); };

(async () => {
  const rt = await createRuntime({});
  const { log: eventLog, kernel } = rt;

  // 1) 真实 MCP 桥接 + 临时配置（与 demo-mcp-bridge 一致）
  await kernel.loadPlugin(require('./plugins/mcp-bridge').mcpBridge);
  const bridge = kernel.resolve('mcp.bridge');
  const loop = kernel.resolve('agent.loop');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fuling-real-'));
  const tmpCfg = path.join(tmp, 'agent-config');
  fs.mkdirSync(tmpCfg, { recursive: true });
  const serverScript = path.join(__dirname, 'server', 'sample-mcp-server.js');
  mcp.setUserDataOverride(tmp);
  fs.writeFileSync(path.join(tmpCfg, 'mcp-servers.yaml'), [
    'version: 1',
    'defaults:',
    '  transport: stdio',
    '  startupTimeoutMs: 10000',
    '  callTimeoutMs: 15000',
    'security:',
    '  allowedCommands: [node]',
    '  namePrefix: "mcp_"',
    '  maxToolsPerServer: 40',
    'servers:',
    '  - id: sample',
    '    name: 示例MCP服务器',
    '    enabled: true',
    '    command: node',
    `    args: ["${serverScript.replace(/\\/g, '\\\\')}"]`,
    'customServers: []',
    '',
  ].join('\n'), 'utf8');
  mcp.reload();
  mcp.setEnabled(['sample']);
  await mcp.startServer('sample');
  await bridge.refresh();

  log('================ 浮灵饰界 · 真实模型适配器（HTTP function-calling → 真实 MCP） ================');
  log(`运行时 tool.registry: ${kernel.resolve('tool.registry').list().join(', ')}`);

  // 2) 起一个最小 OpenAI 兼容端点 + 加载真实适配器（覆盖 mock）
  const { createFakeChatServer } = require('./server/fake-chat-server');
  const fakeServer = createFakeChatServer();
  await new Promise((resolve) => fakeServer.listen(0, '127.0.0.1', resolve));
  const port = fakeServer.address().port;
  const endpoint = `http://127.0.0.1:${port}/v1/chat/completions`;
  await kernel.loadPlugin(require('./plugins/model-adapter-real').modelAdapterReal, { options: { endpoint } });
  log(`真实端点: ${endpoint}（最小 OpenAI 兼容服务器）`);

  // 3) 模型驱动调用真实 MCP 工具（真实 HTTP function-calling 路径）
  log('');
  log('--- [1] 真实 HTTP function-calling 驱动 mcp_greet ---');
  const s = state.makeSession(eventLog);
  const t = state.startTurn(eventLog, { session: s.id, goal: 'mcp_greet 小红' });
  const res = await loop.run(t, {});
  const folded = state.foldTurnState(eventLog.replay(), t.id);
  log(`  目标「mcp_greet 小红」→ status=${res.status}`);
  log(`  结果: ${res.result}`);
  const toolSteps = folded.steps.filter((st) => st.tool_calls.length);
  log(`  工具步骤: ${toolSteps.map((st) => st.tool_calls.map((c) => c.name).join(',')).join(' → ')}`);
  const mcpResult = toolSteps[0] && toolSteps[0].tool_results && toolSteps[0].tool_results[0];
  log(`  真实 MCP 返回: ${JSON.stringify(mcpResult)}`);

  // 4) 无端点回退：停掉 fake 服务器，适配器应回退启发式、仍驱动真实 MCP（循环不空转）
  log('');
  log('--- [2] 无端点回退：停掉 HTTP 端点，仍驱动真实 MCP 工具 ---');
  fakeServer.close();
  const s2 = state.makeSession(eventLog);
  const t2 = state.startTurn(eventLog, { session: s2.id, goal: 'mcp_greet 回退' });
  const res2 = await loop.run(t2, {});
  const folded2 = state.foldTurnState(eventLog.replay(), t2.id);
  log(`  目标「mcp_greet 回退」（端点已停）→ status=${res2.status}`);
  log(`  结果: ${res2.result}`);
  log(`  工具步骤: ${folded2.steps.filter((st) => st.tool_calls.length).map((st) => st.tool_calls.map((c) => c.name).join(',')).join(' → ')}`);

  // 5) 清理
  log('');
  log('--- [3] 清理 ---');
  try { await mcp.stopServer('sample'); } catch (_) {}
  mcp.setUserDataOverride(null);
  fs.rmSync(tmp, { recursive: true, force: true });
  log(`  已停止真实 MCP 服务器并清理临时配置`);
  log(`  总事件 ${eventLog.replay().length} 条，可导出供回放`);

  fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
  writeJson(eventLog, path.join(__dirname, 'ui', 'sample-events.json'));
  log('报告已写入: ' + OUT);
})().catch((e) => {
  console.error(e);
  lines.push('ERROR: ' + (e && e.stack ? e.stack : e));
  try { fs.writeFileSync(OUT, lines.join('\n'), 'utf8'); } catch (_) {}
  process.exit(1);
});
