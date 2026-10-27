'use strict';
/**
 * 最小 OpenAI 兼容 chat/completions 服务器（真实 HTTP + function-calling 协议）。
 * 用于端到端验证「运行时 model-adapter-real → HTTP POST → 解析 tool_calls → 真实 MCP 工具」。
 *
 * 决策逻辑（模拟一个会 function-calling 的模型）：
 *   · 请求里最后一条是 role=tool（上一轮工具已执行）→ 返回最终文本
 *   · 否则在用户目标里找请求 tools 中 mcp_ 工具名 → 返回对应 tool_calls
 *   · 否则返回纯文本完成
 */
const http = require('http');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function createFakeChatServer() {
  return http.createServer(async (req, res) => {
    if (req.method === 'POST' && (req.url || '').includes('/chat/completions')) {
      try {
        const body = await readBody(req);
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const tools = Array.isArray(body.tools) ? body.tools : [];
        const last = messages[messages.length - 1] || {};
        const userMsg = messages.find((m) => m.role === 'user');
        const goal = (userMsg && userMsg.content) || '';

        let message;
        if (last.role === 'tool') {
          // 工具结果已返回 → 给最终文本
          const tc = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
          message = { role: 'assistant', content: `完成：${goal}（工具结果：${tc}）` };
        } else {
          const toolNames = tools.map((t) => t.function && t.function.name).filter(Boolean);
          const hit = toolNames.find((n) => n.startsWith('mcp_') && goal.includes(n));
          if (hit) {
            const rest = goal.replace(hit, '').replace(/[的用]/g, '').trim();
            const args = (hit === 'mcp_greet') ? { name: rest || '世界' } : {};
            message = {
              role: 'assistant', content: '',
              tool_calls: [{ id: 'call_fake_1', type: 'function', function: { name: hit, arguments: JSON.stringify(args) } }],
            };
          } else {
            message = { role: 'assistant', content: `完成：${goal}` };
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
        }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e && e.message || e) }));
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  });
}

module.exports = { createFakeChatServer };
