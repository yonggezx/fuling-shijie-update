'use strict';
/**
 * 运行时骨架演示（可独立运行，无需 Electron）
 *   运行：node src/main/runtime/demo.js
 *   输出：控制台 + 同目录 runtime-demo-report.txt
 *
 * 覆盖：内核/插件加载、ReAct 多步执行、暂停/续跑/Fork、横切（审计+风控拦截）、
 *       子智能体 + Skill 模板编排、事件日志落盘 + 崩溃恢复续跑、回放、
 *       日志折叠重建状态、热卸载。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createRuntime, FileStore, EvalSuite, writeJson } = require('./index');
const state = require('./state');

const OUT = path.join(__dirname, 'runtime-demo-report.txt');
const lines = [];
const log = (s) => { lines.push(s); console.log(s); };

(async () => {
  const rt = await createRuntime({ deny: ['delete-everything'] });
  const { log: eventLog, kernel } = rt;

  log('================ 浮灵饰界 · 插件化运行时骨架演示 ================');

  log('');
  log('--- [1] 内核与插件加载 ---');
  log('插件: ' + [...kernel.plugins.keys()].join(', '));
  log('服务: ' + [...kernel.services.keys()].join(', '));
  log('钩子: ' + [...kernel.hookPoints.keys()].join(', '));

  log('');
  log('--- [2] ReAct 多步执行：目标 "3 + 4"（推理→工具→结论） ---');
  const session = state.makeSession(eventLog);
  const turn = state.startTurn(eventLog, { session: session.id, goal: '3 + 4' });
  const loop = kernel.resolve('agent.loop');
  const res1 = await loop.run(turn, {});
  log(`结果: status=${res1.status}, result=${JSON.stringify(res1.result)}`);

  log('');
  log('--- [3] 暂停 / 续跑 / Fork（状态全在日志里） ---');
  const turn2 = state.startTurn(eventLog, { session: session.id, goal: '现在几点' });
  state.pauseTurn(eventLog, turn2);
  log(`暂停后折叠状态: ${state.foldTurnState(eventLog.replay(), turn2.id).status}`);
  state.resumeTurn(eventLog, turn2);
  log(`续跑后折叠状态: ${state.foldTurnState(eventLog.replay(), turn2.id).status}`);
  const fork = state.forkTurn(eventLog, turn2);
  const resFork = await loop.run(fork, {});
  log(`Fork 分支 ${fork.id} 执行: status=${resFork.status}, result=${JSON.stringify(resFork.result)}`);

  log('');
  log('--- [4] 横切：审计（事件总线旁路记录，不改主流程） ---');
  const audit = kernel.resolve('audit');
  log(`审计记录 ${audit.records.length} 条:`);
  audit.records.forEach((r) => log(`    ${r.type} @turn=${r.turn || '-'}`));

  log('');
  log('--- [5] 横切：风控拦截（钩子 abort，主循环无需改动） ---');
  const s3 = state.makeSession(eventLog);
  const turn3 = state.startTurn(eventLog, { session: s3.id, goal: 'delete everything' });
  const res3 = await loop.run(turn3, {});
  const guard = kernel.resolve('guard.policy');
  log(`目标被拦截: status=${res3.status}, error=${res3.error}`);
  log(`guard 策略: 禁用 ${guard.list().join(', ')}`);

  log('');
  log('--- [6] 回放（唯一可信源）：完整事件流 ---');
  eventLog.replay().forEach((e) => {
    log(`  [${String(e.seq).padStart(3)}] ${e.type}${e.scope.turn ? ' @' + e.scope.turn : ''}`);
  });

  log('');
  log('--- [7] 日志折叠 → 重建状态（状态 = 日志的纯函数） ---');
  const st1 = state.foldTurnState(eventLog.replay(), turn.id);
  log(`turn ${turn.id}: status=${st1.status}, result=${JSON.stringify(st1.result)}, steps=${st1.steps.length}`);
  st1.steps.forEach((s) => log(`    step ${s.id}: status=${s.status}, calls=${s.tool_calls.length}, results=${s.tool_results.length}`));

  log('');
  log('--- [8] 任务编排：子智能体（独立 Session）+ Skill 模板 ---');
  const subagent = kernel.resolve('agent.subagent');
  const child = await subagent.spawn({ goal: '7 - 2' });
  log(`子智能体 session=${child.session}：7 - 2 → ${child.result} (status=${child.status})`);
  const skillReg = kernel.resolve('skill.registry');
  log(`Skill 模板: ${skillReg.list().map((s) => s.id).join(', ')}`);
  const out = await skillReg.run('math.multi-compute', { args: { expressions: ['1 + 2', '10 - 4', '7 + 3'] } });
  log(`Skill 汇总: ${out.summary}`);
  log(`Skill 并行委派产生的独立子 Session 数: ${out.results.length}`);
  log(`编排后日志事件总数: ${eventLog.replay().length}`);

  log('');
  log('--- [9] 事件日志落盘 + 崩溃恢复续跑（跨运行时实例） ---');
  const tmpStore = new FileStore(path.join(os.tmpdir(), `fuling-runtime-${Date.now()}.jsonl`));
  {
    const rtA = await createRuntime({ store: tmpStore });
    const sA = rtA.state.makeSession(rtA.log);
    const tA = rtA.state.startTurn(rtA.log, { session: sA.id, goal: '3 + 4' });
    rtA.state.pauseTurn(rtA.log, tA);
    log(`Runtime A：turn ${tA.id} 开始后暂停即退出（模拟崩溃），已落盘 ${tmpStore.load().length} 条事件`);
  }
  {
    const rtB = await createRuntime({ store: tmpStore });
    const turns = rtB.state.listTurns(rtB.log.replay());
    const paused = turns
      .map((t) => ({ ...t, s: rtB.state.foldTurnState(rtB.log.replay(), t.turn) }))
      .find((x) => x.s.status === 'paused');
    log(`Runtime B：从日志恢复，折叠出 turn ${paused.turn} 状态=${paused.s.status}（goal=${paused.s.goal}），开始续跑...`);
    const loopB = rtB.kernel.resolve('agent.loop');
    await loopB.run({ id: paused.turn, session: paused.session, goal: paused.s.goal }, {});
    const after = rtB.state.foldTurnState(rtB.log.replay(), paused.turn);
    log(`续跑完成: status=${after.status}, result=${after.result}, steps=${after.steps.length}`);
    log(`恢复时日志事件总数: ${rtB.log.replay().length}`);
  }
  tmpStore.clear();

  log('');
  log('--- [10] 评估回归（EvalSuite：回放事件日志断言） ---');
  const suite = new EvalSuite(rt);
  await suite.case({ name: '加法', goal: '3 + 4', expectStatus: 'completed', expectResult: '7' });
  await suite.case({ name: '减法', goal: '10 - 4', expectStatus: 'completed', expectResult: '6' });
  await suite.case({ name: '时间', goal: '现在几点', expectStatus: 'completed' });
  await suite.case({ name: '未知目标应完成(容错)', goal: '今天吃什么', expectStatus: 'completed' });
  log(EvalSuite.render(suite.summary()).split('\n').map((s) => '    ' + s).join('\n'));

  log('');
  log('--- [11] 导出事件流供回放/调试 UI（观测层） ---');
  const samplePath = path.join(__dirname, 'ui', 'sample-events.json');
  const exported = writeJson(eventLog, samplePath);
  log(`已导出 ${exported.eventCount} 条事件 → ${path.relative(process.cwd(), samplePath)}`);
  log('用浏览器打开 ui/replay-viewer.html，点「载入示例」或选择该 JSON 即可回放。');

  log('');
  log('--- [12] 热卸载演示：卸载 audit，服务消失 ---');
  await kernel.unloadPlugin('audit');
  log(`卸载后服务含 audit: ${kernel.hasService('audit')}`);

  log('');
  log('================ 演示结束 ================');
  fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
  log('报告已写入: ' + OUT);
})().catch((e) => {
  console.error(e);
  lines.push('\nERROR: ' + (e && e.stack ? e.stack : e));
  try { fs.writeFileSync(OUT, lines.join('\n'), 'utf8'); } catch (_) {}
  process.exit(1);
});
