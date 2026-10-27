'use strict';
/**
 * 最小 stdio MCP 服务器（真实 MCP 协议，新行分隔 JSON-RPC）。
 * 协议与 src/main/mcp/mcpClient.js 对齐：
 *   initialize → notifications/initialized → tools/list → tools/call
 * 用于端到端验证「运行时 → mcpManager → McpStdioClient → 本服务器」真实链路。
 */
const readline = require('readline');

function send(m) { process.stdout.write(JSON.stringify(m) + '\n'); }

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch (_) { return; }
  if (!msg || typeof msg !== 'object') return;

  const method = msg.method;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: (msg.params && msg.params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'sample-mcp-server', version: '1.0.0' },
      },
    });
  } else if (method === 'notifications/initialized') {
    // 通知，无需应答
  } else if (method === 'tools/list') {
    send({
      jsonrpc: '2.0', id: msg.id,
      result: {
        tools: [
          { name: 'greet', description: '向某个人问候', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
          { name: 'capital', description: '把文本转大写', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
        ],
      },
    });
  } else if (method === 'tools/call') {
    const name = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};
    let text;
    if (name === 'greet') text = `你好，${args.name || '世界'}！来自真实 MCP 服务器。`;
    else if (name === 'capital') text = String(args.text || '').toUpperCase();
    else text = `未知工具: ${name}`;
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } });
  } else if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found: ' + method } });
  }
});
