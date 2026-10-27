'use strict';
/**
 * 模型适配器插件（示例 / mock）—— 动态感知当前已注册的工具。
 *
 * 关键改进：模型不再是死策略，而是每次决策都读 tool.registry 的当前工具集合，
 * 因此【下载的 MCP 工具插件一旦注册，模型就能调用它】——闭合“模型感知下载工具”缺口。
 * 真实实现可替换为接入任意模型 / function-calling，接口不变（服务契约）。
 */
const mockModel = {
  name: 'model-adapter',
  version: '0.1.0',
  provides: { services: ['model.generate'] },
  dependencies: ['tool.registry'],
  async setup(ctx) {
    const registry = ctx.resolve('tool.registry');
    ctx.registerService('model.generate', {
      generate: (args) => mockGenerate(args, registry),
    });
    ctx.registerService('model.adapter.info', {
      info: () => ({ type: 'mock', tools: registry.list() }),
    });
  },
  teardown(ctx) {
    ctx.unregisterService('model.generate');
    ctx.unregisterService('model.adapter.info');
  },
};

function mockGenerate({ goal, turn }, registry) {
  const tools = registry ? registry.list() : [];
  const g = (goal || '').trim();
  const steps = (turn && turn.steps) || [];

  // 已有工具结果 → 生成结论（finish）
  const lastWithResult = [...steps].reverse().find((s) => s.tool_results && s.tool_results.length);
  if (lastWithResult && lastWithResult.tool_results.length) {
    const r = lastWithResult.tool_results[0];
    if (r && r.ok) return { content: `计算完成：${r.value}`, action: { type: 'finish' }, tokens: 12 };
    return { content: `工具返回：${JSON.stringify(r)}`, action: { type: 'finish' }, tokens: 8 };
  }

  // 首次：按当前工具集合动态决策（含下载的工具）
  const calc = g.match(/^(?:(?:计算|add|sum)\s+)?(-?\d+)\s*([+\-])\s*(-?\d+)$/i);
  if (calc && tools.includes('calc')) {
    const op = calc[2] === '-' ? 'sub' : 'add';
    return { content: `调用 calc(${op})`, action: { type: 'tool', name: 'calc', input: { op, a: Number(calc[1]), b: Number(calc[3]) } }, tokens: 10 };
  }
  if (/time|现在几点|现在时间/i.test(g) && tools.includes('time')) {
    return { content: '调用 time', action: { type: 'tool', name: 'time', input: {} }, tokens: 5 };
  }
  if (/(天气|weather)/i.test(g) && tools.includes('weather')) {
    const city = g.replace(/天气|weather/gi, '').replace(/[的在哪]/g, '').trim() || '未知城市';
    return { content: `调用 weather(${city})`, action: { type: 'tool', name: 'weather', input: { city } }, tokens: 5 };
  }
  // 通用：模型能调用任意已注册的 mcp_ 工具（真实实现用 function-calling，这里按名匹配）
  for (const t of tools) {
    if (t.startsWith('mcp_') && g.includes(t)) {
      const rest = g.replace(t, '').replace(/[的用]/g, '').trim();
      return { content: `调用 ${t}`, action: { type: 'tool', name: t, input: rest ? { name: rest } : {} }, tokens: 5 };
    }
  }
  if (/delete/i.test(g)) {
    return { content: '调用 delete-everything（演示拦截）', action: { type: 'tool', name: 'delete-everything', input: {} }, tokens: 5 };
  }
  return { content: `（mock 模型）无法处理目标：${g}（当前可用工具：${tools.join(', ') || '无'}）`, action: { type: 'finish' }, tokens: 3 };
}

module.exports = { mockModel };
