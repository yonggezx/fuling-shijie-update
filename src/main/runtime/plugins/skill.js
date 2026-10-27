'use strict';
/**
 * Skill 模板插件（任务编排）：封装可复用任务模板，Agent 按需调用预置工作流。
 * 模板内部同样由 Turn/Step 驱动，享受同等的可观测性。
 * 本骨架内置一个「并行多算式计算」模板：把多个算式分别委派给子智能体（独立 Session）。
 */
const skillPlugin = {
  name: 'skill-templates',
  version: '0.1.0',
  provides: { services: ['skill.registry'] },
  dependencies: ['agent.subagent'],
  async setup(ctx) {
    const skills = new Map();

    skills.set('math.multi-compute', {
      id: 'math.multi-compute',
      describe: '把多个算式分别委派给子智能体计算并汇总',
      async run({ args }) {
        const subagent = ctx.resolve('agent.subagent');
        const expressions = (args && args.expressions) || [];
        const results = [];
        for (const expr of expressions) {
          const child = await subagent.spawn({ goal: expr });
          const value = (String(child.result).match(/(\d+(?:\.\d+)?)\s*$/) || [null, child.result])[1];
          results.push({ expr, result: value, session: child.session });
        }
        const summary = results.map((r) => `${r.expr} = ${r.result}`).join('；');
        return { summary, results };
      },
    });

    ctx.registerService('skill.registry', {
      register: (s) => { skills.set(s.id, s); return s; },
      remove: (id) => { skills.delete(id); },
      list: () => [...skills.values()].map((s) => ({ id: s.id, describe: s.describe })),
      get: (id) => skills.get(id),
      async run(id, opts) {
        const s = skills.get(id);
        if (!s) throw new Error(`未知 Skill: ${id}`);
        return s.run(opts || {});
      },
    });
  },
  teardown(ctx) { ctx.unregisterService('skill.registry'); },
};

module.exports = { skillPlugin };
