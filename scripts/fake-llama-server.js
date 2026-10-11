/**
 * 测试用的假 llama-server：模拟 llama.cpp 服务端的对外行为。
 * 用法：node fake-llama-server.js -m <模型路径> --host <h> --port <p> [选项]
 *   --delay <ms>       启动后延迟这么久才开始响应（模拟加载，用来验证健康检查确实在等）
 *   --model-id <id>    覆盖 /v1/models 上报的 model id（默认取文件名）
 *   --mode plain       （默认）固定回一句 echo
 *   --mode think       流式返回 reasoning_content + content（验证思考过程能不能显示）
 *   --mode todo        脚本化跑一遍"规划→干活→（被收尾提醒后）标记完成"的 Agent 流程
 *
 * 诊断接口：GET /__requests 返回收到的所有请求体（测试用来断言我们到底发出去了什么）。
 */
const http = require('http');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

const modelPath = arg('-m', '');
const host = arg('--host', '127.0.0.1');
const port = Number(arg('--port', '8080'));
const delay = Number(arg('--delay', '900'));
const mode = arg('--mode', 'plain');
let modelId = arg('--model-id', '');
if (!modelId) {
  modelId = String(modelPath).split(/[\\/]/).pop().replace(/\.(gguf|ggml)$/i, '') || 'fake-model';
}

let ready = false;
const requests = [];   // 收到的请求体（诊断用）
const askState = { stage: 0, answer: '' };  // ask 模式的脚本进度

function sse(res, obj) {
  res.write('data: ' + JSON.stringify(obj) + '\n\n');
}
function deltaBody(delta, finish = null) {
  return { id: 'chatcmpl-fake', object: 'chat.completion.chunk', model: modelId, choices: [{ index: 0, delta, finish_reason: finish }] };
}
function textOf(msgs) {
  return (msgs || []).map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''))).join('\n');
}
/** 非流式响应（stream:false 时必须回单条 JSON，回 SSE 会让客户端 JSON.parse 报错） */
function sendJsonCompletion(res, text) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    id: 'chatcmpl-fake', object: 'chat.completion', model: modelId,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 }
  }));
}

const srv = http.createServer((req, res) => {
  if (!ready) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Loading model' }));
    return;
  }
  if (req.url.startsWith('/__requests')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(requests));
    return;
  }
  if (req.url.startsWith('/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: modelId, object: 'model' }] }));
    return;
  }
  if (req.url.startsWith('/v1/chat/completions')) {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch (e) { /* ignore */ }
      requests.push(parsed);
      const msgs = parsed.messages || [];
      const last = msgs[msgs.length - 1] || {};
      const lastText = typeof last.content === 'string' ? last.content : '';
      const streaming = parsed.stream !== false;

      // 非流式：plain 模式直接回单条 JSON（AIOps.chat 走这条）
      if (!streaming && mode === 'plain') {
        sendJsonCompletion(res, '[fake:' + modelId + '] 收到:' + String(lastText).slice(0, 40));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

      // ---- think 模式：先流式吐 reasoning_content，再吐 content ----
      if (mode === 'think' || mode === 'think-inline') {
        sse(res, deltaBody({ role: 'assistant', content: '' }));
        if (mode === 'think') {
          for (const piece of ['用户想要一段', '自我介绍的文案，', '先想清楚结构和语气：', '目标受众是开发者。']) {
            sse(res, deltaBody({ reasoning_content: piece }));
          }
        } else {
          // llama.cpp 用 --reasoning-format none 启动时：思考被内联标签包着混在 content 里。
          // 故意把闭合标签切成两半，模拟真实的流式分块（跨 chunk 的标签最容易拆错）。
          // ⚠️ 标签字面量用拼接构造：直接写尖括号字面量有被序列化链路吞掉的风险（会变成空串）。
          const OPEN = '<' + 'think>';
          const CLOSE_FW = '<' + '\uFF5Cend\u2581of\u2581thinking\uFF5C>';
          const CLOSE_ASCII = '<' + '/think>';
          const close = arg('--closer', 'fw') === 'ascii' ? CLOSE_ASCII : CLOSE_FW;
          const half = Math.ceil(close.length / 2);
          for (const piece of [OPEN.slice(0, 4), OPEN.slice(4) + '用户想要一段', '自我介绍，先想清楚语气', close.slice(0, half), close.slice(half), '你好，', '我是本地模型。']) {
            sse(res, deltaBody({ content: piece }));
          }
        }
        if (mode === 'think') {
          for (const piece of ['你好，', '我是本地模型。']) {
            sse(res, deltaBody({ content: piece }));
          }
        }
        sse(res, deltaBody({}, 'stop'));
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // ---- todo 模式：脚本化跑一遍 Agent 流程 ----
      if (mode === 'todo') {
        const sawReconcile = /收尾检查/.test(lastText);
        const hasToolResult = msgs.some(m => m.role === 'tool');

        // 第 1 轮：规划 + 开始干活（两个工具调用）
        if (!hasToolResult) {
          sse(res, deltaBody({ role: 'assistant', content: '' }));
          const tc1 = {
            index: 0, id: 'call_p1', type: 'function',
            function: {
              name: 'todo_write',
              arguments: JSON.stringify({
                title: '创建测试文件',
                items: [
                  { id: 'task_1', text: '创建文件', status: 'in_progress', done_when: '文件存在' },
                  { id: 'task_2', text: '写入内容', status: 'pending', done_when: '内容非空' }
                ]
              })
            }
          };
          const tc2 = {
            index: 1, id: 'call_p2', type: 'function',
            function: { name: 'write_file', arguments: JSON.stringify({ path: '.fake-out.txt', content: 'hello' }) }
          };
          sse(res, deltaBody({ tool_calls: [tc1] }));
          sse(res, deltaBody({ tool_calls: [tc2] }));
          sse(res, deltaBody({}, 'tool_calls'));
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        // 第 2 轮（收到工具结果但还没被提醒）：直接交答案，**故意不更新待办** —— 复现用户的 bug
        if (!sawReconcile) {
          sse(res, deltaBody({ role: 'assistant', content: '' }));
          sse(res, deltaBody({ content: '文件已创建完成。' }));
          sse(res, deltaBody({}, 'stop'));
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        // 第 3 轮：被"收尾检查"提醒后，按规则把清单逐条落地
        sse(res, deltaBody({ role: 'assistant', content: '' }));
        const tc1 = {
          index: 0, id: 'call_p3', type: 'function',
          function: { name: 'todo_update', arguments: JSON.stringify({ id: 'task_1', status: 'completed', note: '文件已创建：.fake-out.txt' }) }
        };
        const tc2 = {
          index: 1, id: 'call_p4', type: 'function',
          function: { name: 'todo_update', arguments: JSON.stringify({ id: 'task_2', status: 'completed', note: '内容已写入' }) }
        };
        sse(res, deltaBody({ tool_calls: [tc1] }));
        sse(res, deltaBody({ tool_calls: [tc2] }));
        sse(res, deltaBody({}, 'tool_calls'));
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // ---- blindwrite 模式：不看项目就 write_file（复现"AI 不读代码就乱改"）→ 被拦 → 补读 → 再改 ----
      if (mode === 'blindwrite') {
        const toolMsgs = msgs.filter(m => m.role === 'tool');

        // 用「已回灌的工具结果条数」做状态机（tool 结果里不含工具名，不能靠正则判断）：
        //   0 条 → 盲写（应被门禁拦）→ 1 条
        //   1 条 → 补一次 read_file（应放行）→ 2 条
        //   2 条 → 基于已读代码再写（应放行）→ 3 条
        //   3 条 → 收尾给最终答案
        const n = toolMsgs.length;
        if (n === 0 || n === 1 || n === 2) {
          sse(res, deltaBody({ role: 'assistant', content: '' }));
          let tc;
          if (n === 0) {
            tc = { index: 0, id: 'call_b1', type: 'function',
              function: { name: 'write_file', arguments: JSON.stringify({ path: 'blind.txt', content: 'blind write' }) } };
          } else if (n === 1) {
            tc = { index: 0, id: 'call_b2', type: 'function',
              function: { name: 'read_file', arguments: JSON.stringify({ path: 'package.json' }) } };
          } else {
            tc = { index: 0, id: 'call_b3', type: 'function',
              function: { name: 'write_file', arguments: JSON.stringify({ path: 'blind.txt', content: 'informed write' }) } };
          }
          sse(res, deltaBody({ tool_calls: [tc] }));
          sse(res, deltaBody({}, 'tool_calls'));
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        sse(res, deltaBody({ role: 'assistant', content: '已读取项目后完成修改。' }));
        sse(res, deltaBody({}, 'stop'));
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // ---- ask 模式：规划 → ask_user 问做法 →（拿到用户选择）标记完成 → 汇报 ----
      if (mode === 'ask') {
        const toolMsgs = msgs.filter(m => m.role === 'tool');

        // 第 1 轮：建清单 + 询问用户怎么做
        if (!toolMsgs.length) {
          sse(res, deltaBody({ role: 'assistant', content: '' }));
          const tc1 = {
            index: 0, id: 'call_a1', type: 'function',
            function: {
              name: 'todo_write',
              arguments: JSON.stringify({
                title: '创建测试文件',
                items: [{ id: 'task_1', text: '创建文件', status: 'in_progress', done_when: '文件存在' }]
              })
            }
          };
          const tc2 = {
            index: 1, id: 'call_a2', type: 'function',
            function: {
              name: 'ask_user',
              arguments: JSON.stringify({
                question: '创建文件用哪种方式？',
                options: ['用 Node 脚本写', '用 PowerShell 写']
              })
            }
          };
          sse(res, deltaBody({ tool_calls: [tc1] }));
          sse(res, deltaBody({ tool_calls: [tc2] }));
          sse(res, deltaBody({}, 'tool_calls'));
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        // 第 2 轮：从 ask_user 的工具结果里抓出用户的选择，写进待办 note
        if (askState.stage === 0) {
          const askMsg = toolMsgs.map(m => String(m.content || '')).find(c => c.includes('"answered"')) || '';
          let ans = '';
          const mm = askMsg.match(/"answer":"((?:[^"\\]|\\.)*)"/);
          if (mm) { try { ans = JSON.parse('"' + mm[1] + '"'); } catch (e) { ans = mm[1]; } }
          askState.answer = ans;
          askState.stage = 1;
          sse(res, deltaBody({ role: 'assistant', content: '' }));
          const tc = {
            index: 0, id: 'call_a3', type: 'function',
            function: {
              name: 'todo_update',
              arguments: JSON.stringify({ id: 'task_1', status: 'completed', note: '按用户选择执行：' + ans })
            }
          };
          sse(res, deltaBody({ tool_calls: [tc] }));
          sse(res, deltaBody({}, 'tool_calls'));
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        // 第 3 轮：最终汇报（回显用户的选择，测试断言用它验证"答案确实进了对话"）
        sse(res, deltaBody({ role: 'assistant', content: '' }));
        sse(res, deltaBody({ content: '已按你选择的做法执行：' + askState.answer }));
        sse(res, deltaBody({}, 'stop'));
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // ---- plain ----
      sse(res, deltaBody({ role: 'assistant', content: '' }));
      sse(res, deltaBody({ content: '[fake:' + modelId + '] 收到:' + String(lastText).slice(0, 40) }));
      sse(res, deltaBody({}, 'stop'));
      res.write('data: [DONE]\n\n');
      res.end();
    });
    return;
  }
  res.writeHead(404).end();
});

srv.listen(port, host, () => {
  console.log('[fake llama-server] pid=' + process.pid + ' port=' + port + ' model=' + modelId + ' mode=' + mode + ' delay=' + delay);
  if (delay > 0) setTimeout(() => { ready = true; console.log('[fake llama-server] model loaded'); }, delay);
  else ready = true;
});

process.on('SIGTERM', () => { srv.close(); process.exit(0); });
