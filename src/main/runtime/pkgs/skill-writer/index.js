'use strict';
/**
 * 已下载插件：技能（Skill）—— write.summary
 * 通过 skill.registry 注册一个可复用任务模板；Agent 按需调用。
 */
module.exports = {
  name: 'skill-writer',
  version: '0.1.0',
  kind: 'skill',
  provides: { services: [] },
  dependencies: ['skill.registry'],
  async setup(ctx) {
    const reg = ctx.resolve('skill.registry');
    reg.register({
      id: 'write.summary',
      describe: '把若干要点整理成一段总结',
      async run({ args }) {
        const points = (args && args.points) || [];
        return { summary: '要点总结：' + points.join('、') };
      },
    });
  },
  teardown(ctx) {
    try { ctx.resolve('skill.registry').remove('write.summary'); } catch (_) {}
  },
};
