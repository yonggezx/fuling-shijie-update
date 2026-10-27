'use strict';
/**
 * 风控 / 权限插件（横切能力）：挂钩 step.tool.before，按策略拦截工具调用。
 * 展示：通过钩子返回 { abort, reason } 中断主流程，主循环代码无需改动。
 * 策略可通过 createRuntime({ deny: [...] }) 配置，也可热加载插件实现完整策略引擎。
 */
const guard = {
  name: 'guard',
  version: '0.1.0',
  provides: { services: ['guard.policy'] },
  dependencies: [],
  async setup(ctx) {
    const denied = new Set(ctx.options && ctx.options.deny ? ctx.options.deny : []);
    ctx.addHook('step.tool.before', (c) => {
      if (c.toolCall && denied.has(c.toolCall.name)) {
        return { abort: true, reason: `策略拦截：工具 "${c.toolCall.name}" 被禁用` };
      }
    }, { name: 'guard.denylist', order: 10 });
    ctx.registerService('guard.policy', {
      denied: (n) => denied.has(n),
      list: () => [...denied],
      add: (n) => denied.add(n),
      remove: (n) => denied.delete(n),
    });
  },
  teardown(ctx) { ctx.unregisterService('guard.policy'); },
};

module.exports = { guard };
