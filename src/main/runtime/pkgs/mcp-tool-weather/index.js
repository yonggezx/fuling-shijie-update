'use strict';
/**
 * 已下载插件：MCP 工具 —— weather
 * 通过 tool.registry 注册一个动态工具；注册后 tool.execute 即可分派调用。
 * 这里以模拟的远程返回代替真实 MCP 服务器（真实场景走 mcpManager 协议）。
 */
module.exports = {
  name: 'mcp-tool-weather',
  version: '0.1.0',
  kind: 'tool',
  provides: { services: [] },
  dependencies: ['tool.registry'],
  async setup(ctx) {
    const reg = ctx.resolve('tool.registry');
    reg.register('weather', async (input) => {
      const city = (input && input.city) || '未知城市';
      return { ok: true, value: `天气(${city})：晴 25°C（MCP 模拟数据）` };
    });
  },
  teardown(ctx) {
    try { ctx.resolve('tool.registry').unregister('weather'); } catch (_) {}
  },
};
