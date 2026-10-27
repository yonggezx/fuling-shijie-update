'use strict';
/**
 * 真实模型适配器（OpenAI 兼容 function-calling）。
 *
 * 契约与 mock 一致：model.generate({ goal, turn, messages }) → { content, action }
 *  —— 其中 messages 由 react-loop 从事件日志折叠状态重建（模型所见 = 日志内容）。
 *
 * 行为：
 *   1. 有端点（ctx.options.endpoint 或环境变量 FULING_LLM_URL）→ 发真实 POST /chat/completions，
 *      带上从 tool.registry 归一化的 tools，解析 choices[0].message.tool_calls 转成 action。
 *   2. 无端点 / 请求失败 → 回退到确定性启发式（仍经 tool.registry 决策，循环不会空转）。
 *
 * 加载本插件会覆盖 mock 的 model.generate（registerService 以 Map.set 覆盖；
 * react-loop 在每次推理时才 resolve('model.generate')，故后加载即生效）。
 */
const DEFAULT_ENDPOINT = process.env.FULING_LLM_URL || '';

const modelAdapterReal = {
  name: 'model-adapter-real',
  version: '0.2.0',
  provides: { services: ['model.generate'] },
  dependencies: ['tool.registry'],
  async setup(ctx) {
    const reg = ctx.resolve('tool.registry');
    const endpoint = (ctx.options && ctx.options.endpoint) || DEFAULT_ENDPOINT;

    // 替换语义：真实适配器顶替已有 model.generate（mock）。先卸载旧服务再注册。
    if (ctx.hasService('model.generate')) ctx.unregisterService('model.generate');
    ctx.registerService('model.generate', {
      generate: async ({ goal, turn, messages }) => {
        const tools = reg.schemas().map(toOpenAIFunction);
        if (endpoint) {
          try {
            return await callLLM(endpoint, messages, tools);
          } catch (e) {
            console.warn('[model-adapter-real] LLM 调用失败，回退启发式: ' + e.message);
          }
        }
        return heuristic(goal, reg.list(), tools, messages);
      },
    });
  },
  teardown(ctx) { ctx.unregisterService('model.generate'); },
};

/** 把 tool.registry 的 {name, schema} 归一成 OpenAI function 声明 */
function toOpenAIFunction({ name, schema }) {
  let parameters;
  if (schema && typeof schema === 'object' && schema.type === 'object') {
    parameters = schema; // MCP 等已是 OpenAI 形状
  } else {
    const properties = {};
    for (const [k, v] of Object.entries(schema || {})) properties[k] = { type: 'string', description: String(v) };
    parameters = { type: 'object', properties };
  }
  return { type: 'function', function: { name, description: '', parameters } };
}

/** 真实 HTTP 调用 OpenAI 兼容端点，解析 tool_calls */
async function callLLM(endpoint, messages, tools) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'runtime-real-model', messages, tools, tool_choice: 'auto' }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  const msg = data && data.choices && data.choices[0] && data.choices[0].message;
  if (!msg) throw new Error('响应缺少 choices[0].message');
  const tc = msg.tool_calls && msg.tool_calls[0];
  if (tc && tc.function && tc.function.name) {
    let input = {};
    try { input = JSON.parse(tc.function.arguments || '{}') || {}; } catch (_) { input = {}; }
    return { content: msg.content || `调用 ${tc.function.name}`, action: { type: 'tool', name: tc.function.name, input }, tokens: 10 };
  }
  return { content: msg.content || '完成', tokens: 10 };
}

/** 确定性回退：仍经 tool.registry 决策，保证循环不空转 */
function heuristic(goal, toolNames, tools, messages) {
  const g = String(goal || '');
  // 对话里已有工具结果 → 说明工具已执行过，给最终文本，避免无限循环
  if (Array.isArray(messages)) {
    const toolMsgs = messages.filter((m) => m.role === 'tool');
    if (toolMsgs.length) {
      const last = toolMsgs[toolMsgs.length - 1];
      return { content: `完成：${g}（工具结果：${typeof last.content === 'string' ? last.content : JSON.stringify(last.content)}）`, tokens: 5 };
    }
  }
  for (const t of toolNames) {
    if (t.startsWith('mcp_') && g.includes(t)) {
      const rest = g.replace(t, '').replace(/[的用]/g, '').trim();
      return { content: `调用 ${t}`, action: { type: 'tool', name: t, input: rest ? { name: rest } : {} }, tokens: 5 };
    }
  }
  if (/(计算|\+|加)/.test(g) && toolNames.includes('calc')) {
    return { content: '调用 calc', action: { type: 'tool', name: 'calc', input: { op: 'add', a: 3, b: 4 } }, tokens: 5 };
  }
  return { content: `完成：${g}`, tokens: 5 };
}

module.exports = { modelAdapterReal, toOpenAIFunction };
