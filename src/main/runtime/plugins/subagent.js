'use strict';
/**
 * 子智能体插件（任务编排）：大任务委派给子智能体，每个子任务拥有【独立 Session】。
 * 子智能体本身也是插件，可复用、可替换；通过服务契约 agent.subagent 暴露。
 */
const state = require('../state');

const subagentPlugin = {
  name: 'subagent',
  version: '0.1.0',
  provides: { services: ['agent.subagent', 'agent.registry'] },
  dependencies: ['agent.loop'],
  async setup(ctx) {
    ctx.registerService('agent.subagent', {
      /**
       * 委派一个子任务：创建独立 Session + Turn，并用主循环执行。
       * @returns { session, turn, status, result }
       */
      async spawn({ goal, parentSession, parentTurn }) {
        const log = ctx.log;
        const session = state.makeSession(log);
        const turn = state.startTurn(log, { session: session.id, goal });
        const loop = ctx.resolve('agent.loop');
        const res = await loop.run(turn, {});
        return { session: session.id, turn: turn.id, status: res.status, result: res.result };
      },
    });

    // 具名智能体注册表：供“下载的智能体插件”注册可复用的子智能体模板
    const agents = new Map();
    ctx.registerService('agent.registry', {
      register: (name, def) => { agents.set(name, def); return name; },
      unregister: (name) => { agents.delete(name); },
      get: (name) => agents.get(name),
      list: () => [...agents.entries()].map(([name, d]) => ({ name, describe: d.describe })),
      async spawn(name, opts) {
        const def = agents.get(name);
        if (!def) throw new Error(`未知智能体: ${name}`);
        return def.spawn(opts || {});
      },
    });
  },
  teardown(ctx) {
    ctx.unregisterService('agent.subagent');
    ctx.unregisterService('agent.registry');
  },
};

module.exports = { subagentPlugin };
