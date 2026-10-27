'use strict';
/**
 * 浮灵饰界 · 状态模型（Session / Turn / Step 三层）
 *
 * 原则：状态唯一可信源是事件日志；任何状态转移都通过【追加对应事件】完成。
 * 本模块提供：
 *  - 事件助手：startTurn / pauseTurn / resumeTurn / forkTurn ...（每次变更 = 一条事件）
 *  - 折叠函数：foldTurnState / foldSessionState —— 由事件流重建状态（日志 → 状态）
 */
const { randomId } = require('./util');

// ---------------- 事件助手：状态变更 = 追加事件 ----------------

/** 创建持久会话（Session） */
function makeSession(log, { id = randomId('s') } = {}) {
  log.append({ type: 'session.created', scope: { session: id }, payload: { id } });
  return { id };
}

/** 开启一个任务目标（Turn） */
function startTurn(log, { session, goal, id = randomId('t') } = {}) {
  log.append({ type: 'turn.started', scope: { session, turn: id }, payload: { goal } });
  return { id, session, goal, status: 'running' };
}

function pauseTurn(log, turn) {
  log.append({ type: 'turn.paused', scope: { session: turn.session, turn: turn.id }, payload: {} });
}

function resumeTurn(log, turn) {
  log.append({ type: 'turn.resumed', scope: { session: turn.session, turn: turn.id }, payload: {} });
}

/** 分支 Fork：复制一个 Turn 派生新分支（互不影响） */
function forkTurn(log, turn, { id = randomId('t') } = {}) {
  log.append({ type: 'turn.forked', scope: { session: turn.session, turn: id }, payload: { from: turn.id } });
  return { id, session: turn.session, goal: turn.goal, status: 'running', forkedFrom: turn.id };
}

// ---------------- 折叠：日志 → 状态 ----------------

/** 由事件流重建单个 Turn 的状态（唯一可信源） */
function foldTurnState(events, turnId) {
  const turn = { id: turnId, status: 'pending', goal: null, result: null, error: null, steps: [] };
  let cur = null;
  for (const e of events) {
    if (e.scope.turn !== turnId) continue;
    switch (e.type) {
      case 'turn.started': turn.status = 'running'; turn.goal = e.payload.goal; break;
      case 'turn.paused': turn.status = 'paused'; break;
      case 'turn.resumed': turn.status = 'running'; break;
      case 'turn.forked': turn.forkedFrom = e.payload.from; break;
      case 'turn.completed': turn.status = 'completed'; turn.result = e.payload.result; break;
      case 'turn.failed': turn.status = 'failed'; turn.error = e.payload.error; break;
      case 'turn.cancelled': turn.status = 'cancelled'; break;
      case 'step.started':
        cur = { id: e.scope.step, status: 'running', type: e.payload.type, tool_calls: [], tool_results: [] };
        turn.steps.push(cur); break;
      case 'step.llm.completed': if (cur) cur.output = e.payload.content; break;
      case 'step.tool.calling': if (cur) { cur.tool_calls.push(e.payload); cur.status = 'tool_calling'; } break;
      case 'step.tool.completed': if (cur) { cur.tool_results.push(e.payload.result); cur.status = 'tool_done'; } break;
      case 'step.tool.failed': if (cur) { cur.error = e.payload.error; cur.status = 'tool_failed'; } break;
      case 'step.completed': if (cur) cur.status = 'done'; break;
      case 'step.skipped': if (cur) cur.status = 'skipped'; break;
      case 'step.failed': if (cur) { cur.status = 'failed'; cur.error = e.payload.error; } break;
    }
  }
  return turn;
}

/** 由事件流重建某个 Session 下的全部 Turn */
function foldSessionState(events, sessionId) {
  const seen = new Set();
  const turns = [];
  for (const e of events) {
    if (e.scope.session !== sessionId || !e.scope.turn) continue;
    if (!seen.has(e.scope.turn)) {
      seen.add(e.scope.turn);
      turns.push(foldTurnState(events, e.scope.turn));
    }
  }
  return { id: sessionId, turns };
}

/** 列出事件流中出现过的全部 Session id（用于恢复后定位会话） */
function listSessions(events) {
  const set = new Set();
  for (const e of events) if (e.scope && e.scope.session) set.add(e.scope.session);
  return [...set];
}

/** 列出事件流中出现过的全部 Turn（含其所属 Session，用于恢复后定位任务） */
function listTurns(events) {
  const map = new Map();
  for (const e of events) {
    if (e.scope && e.scope.turn) map.set(e.scope.turn, { turn: e.scope.turn, session: e.scope.session });
  }
  return [...map.values()];
}

module.exports = {
  makeSession, startTurn, pauseTurn, resumeTurn, forkTurn,
  foldTurnState, foldSessionState, listSessions, listTurns,
};
