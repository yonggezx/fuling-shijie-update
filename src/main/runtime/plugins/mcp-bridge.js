'use strict';
/**
 * MCP 桥接插件：把项目【真实 mcpManager】收集到的 MCP 工具，注册进运行时 tool.registry。
 *
 * 链路：运行时 tool.execute → mcpManager.callTool(name, args) → McpStdioClient → 真实 MCP 服务器。
 * 这样“下载/启用的 MCP 工具”能被运行时当普通工具调用，且同样受钩子（guard/audit）管辖。
 */
const path = require('path');
const mcp = require('../../mcp/mcpManager'); // 项目真实 MCP 管理器（纯 Node，可独立 require）

const mcpBridge = {
  name: 'mcp-bridge',
  version: '0.1.0',
  provides: { services: ['mcp.bridge'] },
  dependencies: ['tool.registry'],
  async setup(ctx) {
    const reg = ctx.resolve('tool.registry');
    const bridge = {
      /** 把 mcpManager 当前启用的工具同步进运行时 tool.registry */
      async refresh() {
        let tools = [];
        try { tools = await mcp.collectTools(); } catch (e) { tools = []; }
        const added = [];
        for (const t of tools) {
          const fn = t && t.function;
          if (!fn || !fn.name) continue;
          if (reg.has(fn.name)) continue;
          reg.register(fn.name, async (input) => {
            const r = await mcp.callTool(fn.name, input || {});
            if (r && r.success) return { ok: true, value: r.content };
            throw new Error((r && r.error) || (`MCP 调用失败: ${fn.name}`));
          }, fn.parameters || {});
          added.push(fn.name);
        }
        return { added, total: tools.length };
      },
      list: () => reg.list().filter((n) => n.startsWith('mcp_')),
    };
    ctx.registerService('mcp.bridge', bridge);
  },
  teardown(ctx) {
    try {
      const reg = ctx.resolve('tool.registry');
      for (const n of reg.list()) if (n.startsWith('mcp_')) reg.unregister(n);
    } catch (_) {}
    ctx.unregisterService('mcp.bridge');
  },
};

module.exports = { mcpBridge };
