'use strict';
/**
 * 钩子点（切面点）清单 —— 对应架构设计「附录 B」。
 * 主循环在这些关键节点开放事件钩子；横切逻辑（权限/审计/风控/校验）挂载其上。
 */
const HOOK_POINTS = [
  'turn.before',
  'turn.after',
  'step.before',
  'step.after',
  'step.llm.before',
  'step.llm.after',
  'step.tool.before',
  'step.tool.after',
  'step.tool.error',
];

module.exports = { HOOK_POINTS };
