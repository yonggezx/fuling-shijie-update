# 浮灵饰界 · 插件化运行时（骨架）

面向 AI 智能体的**可调试、可回放插件化运行时**骨架，基于 `docs/浮灵饰界-运行时架构设计.md` 落地。

## 核心概念

- **事件日志（唯一可信源）**：`event-log.js` — 追加式、不可变、原子化；状态一律由日志**折叠重建**；`restore()` 支持从持久化恢复（断点续跑）。
- **内核 Cordis**：`kernel.js` — 只做插件加载 / 依赖解析 / 服务注册 / 事件分发，不写 Agent 业务逻辑。
- **状态模型**：`state.js` — Session → Turn → Step 三层；任何状态转移通过追加事件完成；`foldTurnState` 由日志重建状态；`listTurns/listSessions` 用于恢复定位。
- **ReAct 主循环**：`react-loop.js` — 以 Step 为最小执行单元，主循环纯粹，横切逻辑挂到钩子上。
- **钩子点**：`hooks.js` — turn/step/llm/tool 的 before·after·error 切面点。

## 目录结构

```
src/main/runtime/
├── event-log.js        # 事件日志（唯一可信源，含 restore 恢复）
├── kernel.js           # 内核 Cordis（插件管理/服务注册/事件分发/钩子）
├── hooks.js            # 钩子点清单
├── state.js            # Session/Turn/Step 状态模型 + 折叠/定位函数
├── react-loop.js       # ReAct 主循环插件（带切面钩子）
├── eval.js             # 评估回归框架 EvalSuite（回放断言）
├── export.js           # 事件日志导出为 JSON（供观测层消费）
├── marketplace.js      # 已下载插件加载器（PluginStore：列包 / 装配 / 热卸载）
├── index.js            # 运行时入口 createRuntime()
├── bootstrap.js        # 主进程优雅接入
├── demo.js             # 独立演示脚本（核心能力）
├── demo-download-call.js # 下载后调用 + 符合性验证演示
├── demo-mcp-bridge.js  # 真实 MCP 端到端演示（运行时 ↔ 项目 mcpManager）
├── demo-real-model.js  # 真实模型适配器演示（HTTP function-calling → 真实 MCP）
├── store/
│   └── file-store.js   # 事件日志 JSONL 落盘（append/load/clear）
├── server/
│   ├── sample-mcp-server.js  # 最小 stdio MCP 服务器（真实 MCP 协议）
│   └── fake-chat-server.js   # 最小 OpenAI 兼容 chat/completions 服务器（function-calling）
├── ui/
│   ├── replay-viewer.html   # 回放/调试 UI（浏览器打开，载入事件流）
│   └── sample-events.json   # 演示导出的示例事件流
├── pkgs/               # “已下载”的插件包（Skill / MCP 工具 / 智能体）
│   ├── skill-writer/       # 技能插件：write.summary
│   ├── mcp-tool-weather/   # MCP 工具插件：weather
│   └── agent-reviewer/     # 智能体插件：reviewer
└── plugins/
    ├── tool-basic.js   # 工具注册表 + 分派器（calc/time/echo，可动态注册新工具）
    ├── model-adapter.js# 模型适配器（mock，接口可替换；可调用任意已注册 mcp_ 工具）
    ├── model-adapter-real.js # 真实模型适配器（OpenAI 兼容 function-calling，可替换 mock）
    ├── audit.js        # 审计插件（事件总线旁路）
    ├── guard.js        # 风控插件（钩子 abort 拦截）
    ├── subagent.js     # 子智能体插件（独立 Session 委派 + agent.registry）
    ├── skill.js        # Skill 模板插件（skill.registry，可 remove）
    └── mcp-bridge.js   # 真实 MCP 桥接：mcpManager 工具 → 运行时 tool.registry
```

## 运行演示

```bash
node src/main/runtime/demo.js
```

输出同时写入 `runtime-demo-report.txt`，12 个演示段覆盖：插件/服务/钩子加载、ReAct 多步执行、暂停/续跑/Fork、审计旁路、风控拦截、子智能体 + Skill 编排、日志落盘 + 崩溃恢复续跑、回放、日志折叠重建、**评估回归**、**导出事件流供 UI**、热卸载。

## 回放 / 调试 UI（观测层）

```bash
# 1) 生成示例事件流（demo 末尾会自动写 ui/sample-events.json，也可手动导出）
node src/main/runtime/demo.js
# 2) 用浏览器打开 ui/replay-viewer.html
```

- 载入事件 JSON（`sample-events.json` 或 `export.writeJson()` 导出的文件）后，自动折叠出 Session → Turn 树、当前 Turn 状态与 Step 明细；
- 右侧事件时间线支持 **播放 / 单步 / 跳转 / 速度** 回放，逐事件高亮（llm / tool / turn 全链路）；
- 折叠逻辑在前端重写一遍，可视化「状态 = 日志的纯函数」。

## 评估回归（EvalSuite）

```js
const { createRuntime, EvalSuite } = require('./index');
const rt = await createRuntime();
const suite = new EvalSuite(rt);
await suite.case({ name: '加法', goal: '3 + 4', expectStatus: 'completed', expectResult: '7' });
console.log(EvalSuite.render(suite.summary()));
```

每个用例新建独立 Session/Turn 执行，跑完用 `foldTurnState` 重建状态与期望比对，全程写入同一份事件日志，可回放、可审计。适用于 Agent 回归测试。

## 主进程接入

`src/main/main.js` 顶部已通过 `./runtime/bootstrap` 优雅接入（try/catch + 异步创建），失败不影响应用启动。启动后可经 `global.__runtimeBooted` 访问运行时。

## 契约一览（服务）

| 服务 | 提供插件 | 说明 |
|------|----------|------|
| `agent.loop` | agent-main-loop | `run(turn, opts)` 执行一个 Turn |
| `model.generate` | model-adapter / model-adapter-real | `{ goal, turn, messages } → { content, action }`；真实适配器走 HTTP function-calling |
| `tool.execute` | tool-basic | `execute(toolCall)` 执行工具 |
| `mcp.bridge` | mcp-bridge | `refresh()` 同步项目 mcpManager 工具进运行时；`list()` 列 mcp_ 工具 |
| `agent.subagent` | subagent | `spawn({ goal })` 委派子任务（独立 Session） |
| `skill.registry` | skill-templates | `register/list/get/run(id, opts)` Skill 模板 |
| `audit` | audit | 审计记录 |
| `guard.policy` | guard | 工具禁用策略 |

## 断点续跑 / 崩溃恢复

```js
const { createRuntime, FileStore } = require('./index');
const store = new FileStore('./session.jsonl');

// 实例 A：运行后崩溃（事件已落盘）
const rtA = await createRuntime({ store });
// ...执行任务...

// 实例 B：从同一存储恢复，重建状态并继续
const rtB = await createRuntime({ store });
const turns = rtB.state.listTurns(rtB.log.replay());
const paused = turns.map(t => ({ ...t, s: rtB.state.foldTurnState(rtB.log.replay(), t.turn) }))
                    .find(x => x.s.status === 'paused');
await rtB.kernel.resolve('agent.loop').run({ id: paused.turn, session: paused.session, goal: paused.s.goal }, {});
```

## 下载后调用：Skill / MCP 工具 / 智能体

`demo-download-call.js` 演示「下载下来的插件如何被运行时调用」并对照设计评估符合性：

```bash
node src/main/runtime/demo-download-call.js
```

- `pkgs/` 下为已下载的插件包（Skill / MCP 工具 / 智能体三类），`marketplace.js` 负责装配进内核；
- 通过各自服务契约调用：`skill.registry` / `tool.registry`+`tool.execute` / `agent.registry`；
- 模型动态感知下载工具：mock 模型每次决策读 `tool.registry.list()`，下载的 MCP 工具注册后即可被模型经 ReAct 主循环调用；
- 验证：下载工具同样过 `step.tool.before` 钩子（guard 可动态拦截）、卸载后模型即不再感知、事件可回放；
- 结论：与设计需求（插件化 + 服务契约 + 事件日志 + 钩子 + 编排）一致；真实落地可把 mock 换成支持 function-calling 的真实模型。

## 真实 MCP 端到端（运行时 ↔ 项目 mcpManager）

`demo-mcp-bridge.js` 不模拟、不安装，直接**对接项目真实的 MCP 子系统**跑通真实 MCP 协议：

```bash
node src/main/runtime/demo-mcp-bridge.js
```

链路：`运行时 tool.execute → mcp-bridge → mcpManager.callTool → McpStdioClient → 真实 MCP 服务器`。

- `mcp-bridge` 插件把项目 `src/main/mcp/mcpManager`（纯 Node、可独立 require）收集到的 `mcp_` 工具注册进运行时 `tool.registry`；
- `server/sample-mcp-server.js` 是一个最小 stdio MCP 服务器（新行分隔 JSON-RPC，协议与 `mcpClient.js` 对齐：initialize → initialized → tools/list → tools/call）；
- 演示用 `setUserDataOverride` + 临时 `agent-config/mcp-servers.yaml` 指向该服务器，**不触碰用户真实配置**，结束后停止并恢复；
- 验证：真实服务器启动、工具收集并注册、经 `tool.execute` 直调返回真实结果、模型经 ReAct 主循环调用写事件日志、guard 钩子可拦截 `mcp_` 工具、事件可导出回放。

## 真实模型适配器（HTTP function-calling → 真实 MCP）

`demo-real-model.js` 把 mock 模型替换为**真实 OpenAI 兼容适配器** `model-adapter-real`，让下载的 MCP 工具被「真实模型的 function-calling」调用：

```bash
node src/main/runtime/demo-real-model.js
```

- **主循环传消息历史**：`react-loop.js` 现在调用 `model.generate({ goal, turn, messages })`，`messages` 由折叠后的 turn 状态**纯函数重建**（含 assistant tool_calls + tool 结果）——忠实「模型所见 = 日志内容」，可回放可审计；
- **真实适配器**：`model-adapter-real` 读取 `tool.registry.schemas()` 归一成 OpenAI `tools`，POST 到 `/v1/chat/completions`（默认 `FULING_LLM_URL` 或 `options.endpoint`），解析 `choices[0].message.tool_calls` → action；加载时**替换** mock 的 `model.generate`（先卸载旧服务再注册，体现“插件可替换”）；
- `server/fake-chat-server.js` 是最小 OpenAI 兼容端点（真实 HTTP + function-calling 协议），用于端到端验证适配器代码路径；指向任意真实提供商（DeepSeek/通义/混元/Ollama 等，与项目 `aiOps` 的提供商协议一致）即可换用真模型；
- **无端点回退**：HTTP 失败时回退确定性启发式（仍经 `tool.registry` 决策），循环不空转；
- 验证：真实 HTTP 拿到 `mcp_greet` 的 tool_calls → 循环执行真实 MCP 工具 → 再次 HTTP（带工具结果）→ 完成；停掉端点后回退仍能驱动真实 MCP 工具并正常结束。

## 下一步（按架构设计演进）

1. 把 `model-adapter-real` 的端点指向项目 `aiOps` 已配置的真实提供商（DeepSeek/通义/Ollama 等），并接入凭证/密钥管理
2. 事件日志按 Session 分片 / 多 Session 管理
3. 在 Electron 内嵌回放 UI（把 replay-viewer 接进 renderer）
4. Skill 模板扩展为可持久化注册（入库）
