'use strict';
/**
 * 已下载插件：智能体（Agent）—— reviewer 审阅子智能体
 * 通过 agent.registry 注册一个具名智能体模板；spawn 时在独立 Session 里执行。
 */
module.exports = {
  name: 'agent-reviewer',
  version: '0.1.0',
  kind: 'agent',
  provides: { services: [] },
  dependencies: ['agent.registry', 'agent.subagent'],
  async setup(ctx) {
    const reg = ctx.resolve('agent.registry');
    const sub = ctx.resolve('agent.subagent');
    reg.register('reviewer', {
      describe: '审阅子智能体：在独立 Session 里对目标做一次复查并给出结论',
      async spawn({ goal }) {
        const res = await sub.spawn({ goal });
        return { ...res, mode: 'reviewer', review: '已完成独立 Session 审阅，结论如上。' };
      },
    });
  },
  teardown(ctx) {
    try { ctx.resolve('agent.registry').unregister('reviewer'); } catch (_) {}
  },
};
