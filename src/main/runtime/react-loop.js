'use strict';
/**
 * 浮灵饰界 · Agent 主循环（插件）—— 带切面钩子的 ReAct 循环
 *
 * 设计要点：
 *  - 以 Step 为最小执行单元（一轮 LLM 推理 + 工具调用）
 *  - 主循环保持【纯粹】：只做 推理 → 决定 → 调用 → 观察 的正向推进
 *  - 权限校验 / 审计 / 埋点 / 风险拦截 / 结果校验等横切逻辑全部挂载到钩子上
 *  - 模型所见 = 日志内容：每轮调用模型前，由日志折叠重建 turn 状态（唯一可信源）
 */
const { foldTurnState } = require('./state');

const reactLoop = {
  name: 'agent-main-loop',
  version: '0.1.0',
  provides: { services: ['agent.loop'] },
  dependencies: ['model.generate', 'tool.execute'],
  async setup(ctx) {
    ctx.registerService('agent.loop', {
      run: (turn, opts) => runLoop(ctx, turn, opts),
    });
  },
  teardown(ctx) { ctx.unregisterService('agent.loop'); },
};

async function runLoop(ctx, turn, opts = {}) {
  const maxSteps = opts.maxSteps || 6;
  const model = ctx.resolve('model.generate');
  const tool = ctx.resolve('tool.execute');
  const scope = { session: turn.session, turn: turn.id };

  await ctx.runHook('turn.before', { turn, goal: turn.goal });

  for (let i = 0; i < maxSteps; i++) {
    const stepId = `${turn.id}:st${i + 1}`;
    const stepScope = { ...scope, step: stepId };

    // 唯一可信源：状态由日志折叠重建 —— 模型所见 = 日志内容
    turn.steps = foldTurnState(ctx.log.replayScope(scope), turn.id).steps;
    ctx.log.append({ type: 'step.started', scope: stepScope, payload: { type: 'act', index: i, goal: turn.goal } });
    const stepCtx = { turn, stepId, stepScope };
    await ctx.runHook('step.before', stepCtx);
    if (stepCtx.abort) {
      ctx.log.append({ type: 'step.skipped', scope: stepScope, payload: { reason: stepCtx.reason } });
      break;
    }

    // ---------- LLM 推理 ----------
    const llmCtx = { ...stepCtx };
    await ctx.runHook('step.llm.before', llmCtx);
    if (llmCtx.abort) {
      ctx.log.append({ type: 'step.skipped', scope: stepScope, payload: { reason: llmCtx.reason } });
      break;
    }
    ctx.log.append({ type: 'step.llm.requested', scope: stepScope, payload: { goal: turn.goal } });
    const llmOut = await model.generate({ goal: turn.goal, turn, messages: buildMessages(turn) });
    ctx.log.append({
      type: 'step.llm.completed', scope: stepScope,
      payload: { content: llmOut.content, action: llmOut.action, tokens: llmOut.tokens || 0 },
    });
    await ctx.runHook('step.llm.after', { ...stepCtx, output: llmOut });
    if (stepCtx.abort) {
      ctx.log.append({ type: 'step.skipped', scope: stepScope, payload: { reason: stepCtx.reason } });
      break;
    }

    const action = llmOut.action || { type: 'finish', content: llmOut.content };

    // ---------- 工具调用 / 结束 分发 ----------
    if (action.type === 'tool') {
      const toolCtx = { ...stepCtx, toolCall: action };
      ctx.log.append({ type: 'step.tool.calling', scope: stepScope, payload: action });
      await ctx.runHook('step.tool.before', toolCtx);
      if (toolCtx.abort) {
        ctx.log.append({ type: 'step.tool.failed', scope: stepScope, payload: { error: toolCtx.reason, call: action } });
        await ctx.runHook('step.tool.error', { ...toolCtx, error: toolCtx.reason });
        ctx.log.append({ type: 'turn.failed', scope, payload: { error: `工具被拦截: ${toolCtx.reason}` } });
        await ctx.runHook('turn.after', { turn, error: toolCtx.reason });
        return { status: 'failed', error: toolCtx.reason, steps: i + 1 };
      }
      let result;
      try {
        result = await tool.execute(action);
        ctx.log.append({ type: 'step.tool.completed', scope: stepScope, payload: { call: action, result } });
      } catch (err) {
        ctx.log.append({ type: 'step.tool.failed', scope: stepScope, payload: { error: err.message, call: action } });
        await ctx.runHook('step.tool.error', { ...toolCtx, error: err.message });
        // 给模型一次修正机会：继续下一轮
        ctx.log.append({ type: 'step.completed', scope: stepScope, payload: { outcome: 'tool-failed' } });
        continue;
      }
      await ctx.runHook('step.tool.after', { ...toolCtx, result });
      stepCtx.lastResult = result;
      ctx.log.append({ type: 'step.completed', scope: stepScope, payload: { outcome: 'tool-done' } });
      await ctx.runHook('step.after', stepCtx);
      // 循环继续：下一轮模型会通过日志折叠看到工具结果并给出 finish
    } else {
      // 结束
      ctx.log.append({ type: 'step.completed', scope: stepScope, payload: { outcome: 'finish' } });
      ctx.log.append({ type: 'turn.completed', scope, payload: { result: llmOut.content } });
      await ctx.runHook('turn.after', { turn, result: llmOut.content });
      return { status: 'completed', result: llmOut.content, steps: i + 1 };
    }
  }

  ctx.log.append({ type: 'turn.failed', scope, payload: { error: 'max-steps-exceeded' } });
  await ctx.runHook('turn.after', { turn, error: 'max-steps-exceeded' });
  return { status: 'failed', error: 'max-steps-exceeded', steps: maxSteps };
}

module.exports = { reactLoop };

/**
 * 由「日志折叠重建的 turn 状态」还原完整对话（OpenAI 兼容 messages）。
 * 忠实设计原则：模型所见 = 日志内容 —— messages 不是另存的对话，
 * 而是从唯一可信源（事件日志）纯函数地重建出来，保证可回放、可审计。
 */
function buildMessages(turn) {
  const msgs = [
    { role: 'system', content: '你是浮灵饰界里的 AI 智能体，通过调用可用工具完成用户目标。' },
    { role: 'user', content: turn.goal || '' },
  ];
  for (const st of turn.steps || []) {
    const calls = st.tool_calls || [];
    if (calls.length) {
      // 本步是工具步骤：assistant 带 tool_calls，随后跟 tool 结果
      msgs.push({
        role: 'assistant', content: st.output || '',
        tool_calls: calls.map((c, idx) => ({
          id: c.tool_call_id || (`call_${st.id}_${idx}`),
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.input || {}) },
        })),
      });
      const results = st.tool_results || [];
      calls.forEach((c, idx) => {
        const res = results[idx];
        const text = (typeof res === 'string') ? res : JSON.stringify(res);
        msgs.push({ role: 'tool', tool_call_id: (c.tool_call_id || (`call_${st.id}_${idx}`)), content: text });
      });
    } else if (st.output != null) {
      // 纯文本 / finish 步：对话到此为止
      msgs.push({ role: 'assistant', content: st.output });
      break;
    }
  }
  return msgs;
}
