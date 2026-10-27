'use strict';
/**
 * 审计插件（横切能力）：订阅事件总线，旁路记录，不改主流程。
 * 展示：横切逻辑通过事件钩子 / 事件总线实现解耦，主循环完全不感知。
 */
const audit = {
  name: 'audit',
  version: '0.1.0',
  provides: { services: ['audit'] },
  dependencies: [],
  async setup(ctx) {
    const records = [];
    const watch = new Set(['turn.started', 'step.tool.completed', 'step.tool.failed', 'turn.completed', 'turn.failed']);
    ctx.on('*', (ev) => {
      if (watch.has(ev.type)) {
        records.push({ ts: ev.ts, type: ev.type, session: ev.scope.session, turn: ev.scope.turn, step: ev.scope.step });
      }
    });
    ctx.registerService('audit', { records, list: () => records.slice() });
  },
  teardown(ctx) { ctx.unregisterService('audit'); },
};

module.exports = { audit };
