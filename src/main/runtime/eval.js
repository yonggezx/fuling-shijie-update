'use strict';
/**
 * 评估（Eval）回归框架：回放事件日志跑回归测试。
 *
 * 原理：每个用例新建 Session/Turn 执行，跑完后用 foldTurnState 重建状态，
 * 对比预期 status / result。所有过程都写进同一份事件日志，可回放、可审计。
 *
 * 用法：
 *   const rt = await createRuntime();
 *   const suite = new EvalSuite(rt);
 *   await suite.case({ name: '加法', goal: '3 + 4', expectStatus: 'completed', expectResult: '7' });
 *   console.log(suite.summary());
 */
class EvalSuite {
  constructor(rt) {
    this.rt = rt;
    this.results = [];
  }

  /** 执行一个用例并断言 */
  async case({ name, goal, expectStatus = 'completed', expectResult, expectFailed = false }) {
    const { state, log, kernel } = this.rt;
    const session = state.makeSession(log);
    const turn = state.startTurn(log, { session: session.id, goal });
    const loop = kernel.resolve('agent.loop');
    const res = await loop.run(turn, {});
    const folded = state.foldTurnState(log.replay(), turn.id);

    const passStatus = res.status === expectStatus;
    const passResult = expectResult ? new RegExp(expectResult).test(String(res.result || '')) : true;
    const pass = passStatus && passResult;

    this.results.push({
      name, goal, status: res.status, result: res.result,
      steps: folded.steps.length, pass, expectStatus, expectResult,
    });
    return pass;
  }

  summary() {
    const total = this.results.length;
    const passed = this.results.filter((r) => r.pass).length;
    return { total, passed, failed: total - passed, results: this.results.slice() };
  }

  static render(summary) {
    const lines = [`评估回归: ${summary.passed}/${summary.total} 通过`];
    for (const r of summary.results) {
      lines.push(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  [goal=${r.goal}] status=${r.status} result=${JSON.stringify(r.result)}${r.expectResult ? ` (期望 /${r.expectResult}/)` : ''}`);
    }
    return lines.join('\n');
  }
}

module.exports = { EvalSuite };
