'use strict';
/**
 * 真实 MCP 端到端演示：运行时桥接项目【真实 mcpManager】，调用真实 MCP 协议工具。
 *
 * 链路：
 *   运行时 tool.execute → mcp-bridge → mcpManager.callTool → McpStdioClient → 最小真实 MCP 服务器
 *
 * 用临时 userData + 临时 mcp-servers.yaml 指向自带的 sample-mcp-server.js，
 * 不触碰用户真实 MCP 配置；结束后恢复并停止服务器。
 *
 * 运行：node src/main/runtime/demo-mcp-bridge.js
 * 输出：控制台 + runtime-mcp-bridge-report.txt
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { createRuntime, writeJson } = require('./index');
const mcp = require('../mcp/mcpManager'); // 项目真实 MCP 管理器
const state = require('./state');

const OUT = path.join(__dirname, 'runtime-mcp-bridge-report.txt');
const lines = [];
const log = (s) => { lines.push(s); console.log(s); };

(async () => {
  const rt = await createRuntime({});
  const { log: eventLog, kernel } = rt;

  // 加载真实 MCP 桥接插件
  await kernel.loadPlugin(require('./plugins/mcp-bridge').mcpBridge);
  const bridge = kernel.resolve('mcp.bridge');
  const tools = kernel.resolve('tool.registry');
  const loop = kernel.resolve('agent.loop');

  log('================ 浮灵饰界 · 真实 MCP 端到端（运行时 ↔ mcpManager） ================');

  // 1) 临时配置：指向自带的最小真实 MCP 服务器
  //    userConfigDir() 在 node 下返回 _userDataOverride/agent-config，yaml 必须放这里
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fuling-mcp-'));
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
  const startRes = await mcp.startServer('sample');
  log('');
  log('--- [1] 启动真实 MCP 服务器 ---');
  log(`  startServer(sample): ${startRes.ok ? '成功' : ('失败 ' + startRes.error)}`);

  // 2) 桥接：mcpManager 收集到的工具 → 运行时 tool.registry
  const { added, total } = await bridge.refresh();
  log('');
  log('--- [2] mcpManager 收集工具 → 注册进运行时 ---');
  log(`  mcpManager 收集 ${total} 个工具，注册进运行时 ${added.length} 个: ${added.join(', ')}`);
  log(`  运行时 tool.registry: ${tools.list().join(', ')}`);

  // 3) 直接调用真实 MCP 工具（经 tool.execute 分派 → mcpManager.callTool）
  log('');
  log('--- [3] 直接调用真实 MCP 工具 mcp_greet（经 tool.execute） ---');
  const toolExec = kernel.resolve('tool.execute');
  const r = await toolExec.execute({ name: 'mcp_greet', input: { name: '小明' } });
  log(`  结果: ${JSON.stringify(r)}`);

  // 4) 模型驱动调用真实 MCP 工具（经 ReAct 主循环，写事件日志）
  log('');
  log('--- [4] 模型驱动调用 mcp_greet（经 ReAct 主循环，写事件日志） ---');
  const s = state.makeSession(eventLog);
  const t = state.startTurn(eventLog, { session: s.id, goal: 'mcp_greet 小红' });
  const res = await loop.run(t, {});
  log(`  目标「mcp_greet 小红」→ status=${res.status}, result=${res.result}`);
  const folded = state.foldTurnState(eventLog.replay(), t.id);
  log(`  Step 事件: ${folded.steps.map((st) => `${st.status}[calls=${st.tool_calls.map((c) => c.name).join(',')}]`).join(' → ')}`);

  // 5) 钩子可拦截 mcp 工具
  log('');
  log('--- [5] 钩子横切：guard 可拦截 mcp 工具 ---');
  const guard = kernel.resolve('guard.policy');
  guard.add('mcp_capital');
  const hc = await kernel.runHook('step.tool.before', { toolCall: { name: 'mcp_capital', input: {} } });
  log(`  拦截 mcp_capital: ${hc.abort ? '是' : '否'}（${hc.reason}）`);

  // 6) 清理
  log('');
  log('--- [6] 清理与统计 ---');
  try { await mcp.stopServer('sample'); } catch (_) {}
  mcp.setUserDataOverride(null);
  fs.rmSync(tmp, { recursive: true, force: true });
  log(`  已停止服务器并清理临时配置`);
  log(`  总事件 ${eventLog.replay().length} 条，可导出供回放调试台查看`);

  fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
  writeJson(eventLog, path.join(__dirname, 'ui', 'sample-events.json'));
  log('报告已写入: ' + OUT);
})().catch((e) => {
  console.error(e);
  lines.push('ERROR: ' + (e && e.stack ? e.stack : e));
  try { fs.writeFileSync(OUT, lines.join('\n'), 'utf8'); } catch (_) {}
  process.exit(1);
});
