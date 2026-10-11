'use strict';
/**
 * 测试用 MCP Server（stdio / JSON-RPC 2.0）
 *   node scripts/fake-mcp-server.js [--crash-after-tools] [--slow] [--noise] [--weird-schema]
 *
 * 存在的意义：mcpClient 的解析/超时/崩溃分支必须能被真实测到，
 * 而不是只靠"读代码觉得对"。下面每个开关对应一类边界情况：
 *   --crash-after-tools  握手成功后立刻退出 → 验退出时pending 全部reject
 *   --slow               tools/call 故意慢 3 秒 → 验超时回收
 *   --noise              往 stdout 混非 JSON 行 + 往 stderr 写日志 → 验解析不被污染
 *   --weird-schema       工具 schema 缺 type / required 指向不存在的字段 → 验归一化
 */
const args = process.argv.slice(2);
const has = (f) => args.includes(f);

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

let initialized = false;
let buffer = '';

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { continue; }
    handle(msg);
  }
});

process.stdin.on('end', () => process.exit(0));

function handle(msg) {
  if (has('--noise')) {
    //模拟真实 server 那样往 stdout 打日志（非 JSON）
    process.stdout.write('INFO  starting fake-mcp-server\n');
    process.stderr.write('DEBUG this goes to stderr only\n');
  }

  const { id, method, params } = msg;

  switch (method) {
    case 'initialize': {
      send({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: 'fake-mcp-test', version: '0.0.1' }
        }
      });
      if (has('--crash-after-tools')) {
        // 握手回完就退：客户端应把所有 pending reject，并标记 crashed
        setTimeout(() => process.exit(3), 50);
      }
      return;
    }

    case 'notifications/initialized':
      initialized = true;
      process.stderr.write('initialized handshake done\n');
      return;    // 通知无响应

    case 'tools/list': {
      const tools = [
        {
          name: 'echo',
          description: '回显传入的文字',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string', description: '要回显的内容' } },
            required: ['text']
          }
        },
        {
          name: 'add',
          description: '两数相加',
          inputSchema: {
            type: 'object',
            properties: { a: { type: 'number' }, b: { type: 'number' } },
            required: ['a', 'b']
          }
        }
      ];
      if (has('--weird-schema')) {
        // 畸形 schema：缺 type、required 指向不存在的字段、type 不是 object
        tools.push({
          name: 'weird.tool/v2',
          description: '故意畸形的 schema，用来验归一化',
          inputSchema: { properties: { x: { type: 'string' } }, required: ['x', 'notExist'] }
        });
      }
      send({ jsonrpc: '2.0', id, result: { tools } });
      return;
    }

    case 'tools/call': {
      const name = params && params.name;
      const a = (params && params.arguments) || {};
      if (has('--slow')) {
        setTimeout(() => {
          send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'slow done' }], isError: false } });
        }, 3000);
        return;
      }
      if (name === 'echo') {
        send({
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: 'echo: ' + a.text }], isError: false }
        });
        return;
      }
      if (name === 'add') {
        send({
          jsonrpc: '2.0', id,
          result: {
            content: [{ type: 'text', text: String((Number(a.a) || 0) + (Number(a.b) || 0)) },
                      { type: 'text', text: '（第二段内容）' }],
            isError: false
          }
        });
        return;
      }
      if (name === 'weird.tool/v2') {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'weird ok' }] } });
        return;
      }
      // 未知工具 → MCP 规范的错误形态
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool: ' + name } });
      return;
    }

    case 'resources/list':
      send({
        jsonrpc: '2.0', id,
        result: { resources: [{ uri: 'fake://info', name: '测试资源', mimeType: 'text/plain' }] }
      });
      return;

    case 'prompts/list':
      send({ jsonrpc: '2.0', id, result: { prompts: [{ name: 'demo', description: '演示提示词' }] } });
      return;

    case 'ping':
      send({ jsonrpc: '2.0', id, result: {} });
      return;

    default:
      if (id !== undefined && id !== null) {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
      }
  }
}