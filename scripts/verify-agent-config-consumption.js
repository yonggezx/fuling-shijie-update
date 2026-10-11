'use strict';
/**
 * 验证配置文件**真的被代码消费**，而不是躺在磁盘上。
 *   node scripts/verify-agent-config-consumption.js
 *
 * 体检脚本（check-agent-config.js）管的是「文件对不对」，
 * 这个脚本管的是「改了配置，行为会不会跟着变」—— 后者才说明接线成功。
 *
 * 覆盖三条链路：
 *   transform.yaml       → 主进程 approxTokens 系数/ 遮蔽 redactText / 下发给渲染层
 *   examples.yaml        → 主进程 renderExamples() 注入 agent system prompt
 *   resource_index.yaml  → 加载器读到，且体检脚本按它遍历
 *
 * 渲染层部分不用 Electron 起真实窗口（0.6MB 的 app.js 强依赖 DOM），
 * 而是把**改动过的函数原样抽出来**在最小环境里跑 —— 测的是真代码，不是复刻。
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..');
const APP_JS = path.join(ROOT, 'src', 'renderer', 'js', 'app.js');

// ── mock electron，让主进程模块能在纯 node 下加载 ───────────────────────────
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return path.join(__dirname, '_fake-electron-for-tests.js');
  return origResolve.call(this, request, ...rest);
};

const cfg = require(path.join(ROOT, 'src', 'main', 'config', 'agentConfig.js'));
const AIOps = require(path.join(ROOT, 'src', 'main', 'ipc', 'aiOps.js'));
const I = AIOps._internal || AIOps.__test || {};
const transformYaml = yaml.load(fs.readFileSync(path.join(ROOT, 'src', 'main', 'agent-config', 'transform.yaml'), 'utf8'));

let fail = 0;
const t = (name, cond, extra) => {
  console.log((cond ? '  ✅ ' : '  ❌ ') + name + (extra ? ' — ' + extra : ''));
  if (!cond) fail++;
};

console.log('=== 配置消费链路验证 ===\n');

// ══════════════════════════════════════════════════════════════════════════
console.log('[transform.yaml → 主进程]');
const tr = cfg.transformForRenderer();
t('加载器读到 transform', !!tr && !!tr.tokenEstimate);
t('token 系数 = 0.26', tr.tokenEstimate.nonCjkRatio === 0.26, String(tr.tokenEstimate.nonCjkRatio));
t('单条消息上限 = 2000', tr.budget.singleMessageTokenCap === 2000, String(tr.budget.singleMessageTokenCap));
t('压缩阈值 = 85', tr.context.autoCompressThreshold === 85);
t('遮蔽规则已预编译', tr.redact.compiled.length > 0, tr.redact.compiled.length + ' 条');
t('主进程拿到同一份 transform', !!I.transform && I.transform.tokenEstimate.nonCjkRatio === 0.26);

const redacted = I.redactText('我的 key 是 sk-abcdefghijklmnopqrstuvwx 和 Bearer aaaabbbbccccddddeeeeffff');
t('OpenAI key 被擦除', !redacted.includes('sk-abcdefghijklmnop'), redacted);
t('Bearer token 被擦除', !/Bearer\s+aaaabbbb/.test(redacted));
const redacted2 = I.redactText('api_key = "supersecretvalue123"');
t('赋值形式的密钥保留键名、擦掉值', redacted2.includes('api_key') && !redacted2.includes('supersecretvalue'), redacted2);
t('正常文本不被误伤', I.redactText('这段话没有任何密钥，应该原样返回') === '这段话没有任何密钥，应该原样返回');

const meta = AIOps.getContextMeta();
t('context-meta 已下发 transform', !!meta.transform && !!meta.transform.budget);

// ══════════════════════════════════════════════════════════════════════════
console.log('\n[examples.yaml → agent system prompt]');
const ex = I.renderExamples('agent');
t('agent 模式渲染出示例', ex && ex.length > 100, (ex || '').length + ' 字符');
t('示例被 maxInjected 限量', (ex.match(/^### /gm) || []).length === 3, (ex.match(/^### /gm) || []).length + ' 条（上限 3）');
t('示例含好/坏对照', ex.includes('❌ 不要这样答') && ex.includes('✅ 应该这样答'));
const exTitles = (ex.match(/^### .*/gm) || []).join(' / ');
t('按 priority 取前 3（标题正确）',
  exTitles.includes('收尾总结要像人说话') && exTitles.includes('简单任务不要过度规划') && !ex.includes('中文程序名不要猜英文 exe'),
  exTitles);
const exChat = I.renderExamples('chat');
t('chat 模式过滤掉 agent-only 示例', !exChat.includes('### 改完必须给验证证据') && !exChat.includes('### 简单任务不要过度规划'));
t('chat 模式拿到自己的 2 条', (exChat.match(/^### /gm) || []).length === 2);
t('未知模式返回空串', cfg.renderExamples('nope') === '');

// ══════════════════════════════════════════════════════════════════════════
console.log('\n[resource_index.yaml → 加载器 + 体检脚本]');
const idx = cfg.load().resourceIndex;
t('索引已加载', !!idx && Array.isArray(idx.resources));
// 断言不写死数字：新增配置文件时索引会变，写死就会假报
const declared = idx.resources.map(r => r.file).sort();
// 索引声明的每个文件都必须真实存在（这是索引的核心契约）
const missing = declared.filter(f => !fs.existsSync(path.join(ROOT, 'src', 'main', 'agent-config', f)));
t('索引声明的文件全部存在', missing.length === 0, missing.length ? '缺: ' + missing.join(', ') : declared.length + ' 个文件');
// 反向：目录里的配置文件都应该在索引里（漏登记 = 体检漏检查）
// 索引自己不自指（声明自己会形成循环），故排除
const SELF = ['resource_index.yaml', 'README.md'];
const onDisk = fs.readdirSync(path.join(ROOT, 'src', 'main', 'agent-config'))
  .filter(f => !SELF.includes(f));
const unregistered = onDisk.filter(f => !declared.includes(f));
t('磁盘上的配置文件都已登记进索引', unregistered.length === 0, unregistered.length ? '漏登记: ' + unregistered.join(', ') : onDisk.length + ' 个文件');
t('声明了凭证的外部托管', Array.isArray(idx.externalResources) && idx.externalResources.some(r => r.id === 'credentials'));
t('MCP 运行时也登记为外部资源', idx.externalResources.some(r => r.id === 'mcp-runtime'));
t('登记了未落地项（含 runtime.db）', Array.isArray(idx.notImplemented) && idx.notImplemented.some(n => n.id === 'runtime-db'));
// 注：resource_index.yaml 由 agentConfig 读，mcp-servers.yaml 由 mcpManager 读，
// 后者不在 resourceIndex.resources 里是设计如此（两套加载器），MCP 侧的校验在 test-mcp.js

// ══════════════════════════════════════════════════════════════════════════
console.log('\n[transform.yaml → 渲染层]');
const appSrc = fs.readFileSync(APP_JS, 'utf8');
function extract(startMarker, endMarker) {
  const s = appSrc.indexOf(startMarker);
  const e = appSrc.indexOf(endMarker, s);
  if (s < 0 || e < 0) throw new Error('抽取失败: ' + startMarker);
  return appSrc.slice(s, e);
}
// tf / TRANSFORM / 各常量 / applyTransformRules + estimateTokens + formatTokenCount + 两个截断函数
const block = [
  extract('// ── 加工规则（transform.yaml）', '// 粗略 token 估算'),
  extract('// 粗略 token 估算', 'function getActiveProviderConfig'),
  extract('// 过长的历史消息在发送前截断', '// 按上下文预算挑选要发送的历史消息')
].join('\n');
const factory = new Function(block + `
  return {
    applyTransformRules, estimateTokens, trimHistoryContent, trimTextToTokens,
    get TRANSFORM() { return TRANSFORM; },
    get SINGLE_MESSAGE_TOKEN_CAP() { return SINGLE_MESSAGE_TOKEN_CAP; },
    get AUTO_COMPRESS_THRESHOLD() { return AUTO_COMPRESS_THRESHOLD; },
    get CONTEXT_BAR_WARN() { return CONTEXT_BAR_WARN; },
    get COMPRESS_KEEP_RECENT() { return COMPRESS_KEEP_RECENT; }
  };
`);

// 兜底路径
const bare = factory();
t('拿不到配置时 TRANSFORM 为 null', bare.TRANSFORM === null);
t('兜底单条上限 2000', bare.SINGLE_MESSAGE_TOKEN_CAP === 2000);
t('兜底 token 估算可用', bare.estimateTokens('你好世界') === 4, String(bare.estimateTokens('你好世界')));
t('英文按 0.26 折算', bare.estimateTokens('abcdefgh') === Math.ceil(8 * 0.26), String(bare.estimateTokens('abcdefgh')));

// 配置生效路径（只传主进程实际下发的四个段）
const wired = factory();
wired.applyTransformRules({
  tokenEstimate: transformYaml.tokenEstimate,
  budget: transformYaml.budget,
  context: transformYaml.context,
  agentOverhead: transformYaml.agentOverhead
});
t('配置下发后 TRANSFORM 填充', !!wired.TRANSFORM);
t('单条上限取配置值', wired.SINGLE_MESSAGE_TOKEN_CAP === transformYaml.budget.singleMessageTokenCap);
t('压缩阈值取配置值', wired.AUTO_COMPRESS_THRESHOLD === transformYaml.context.autoCompressThreshold);
t('保留条数取配置值', wired.COMPRESS_KEEP_RECENT === transformYaml.context.keepRecentMessages);
t('告警阈值取配置值', wired.CONTEXT_BAR_WARN === transformYaml.context.barWarn);

// 改配置 → 行为跟着变（这才是"真的被消费"）
wired.applyTransformRules({
  tokenEstimate: { nonCjkRatio: 1.0, cjkPattern: transformYaml.tokenEstimate.cjkPattern },
  budget: transformYaml.budget,
  context: Object.assign({}, transformYaml.context, { autoCompressThreshold: 50, barWarn: 30 }),
  agentOverhead: transformYaml.agentOverhead
});
t('压缩阈值跟着变50', wired.AUTO_COMPRESS_THRESHOLD === 50);
t('告警阈值跟着变 30', wired.CONTEXT_BAR_WARN === 30);
t('token 系数跟着变（英文按 1:1）', wired.estimateTokens('abcdefgh') === 8, String(wired.estimateTokens('abcdefgh')));

// 截断未回归
const w2 = factory();
w2.applyTransformRules({
  tokenEstimate: transformYaml.tokenEstimate, budget: transformYaml.budget,
  context: transformYaml.context, agentOverhead: transformYaml.agentOverhead
});
const long = 'A'.repeat(40000);
const trimmed = w2.trimHistoryContent(long, false);
t('历史长消息被截断到 charCap', trimmed.startsWith(long.slice(0, 8000)) && trimmed.length < long.length, trimmed.length + ' 字符');
t('带省略说明', /此处省略约\s+[\d.]+[KkMm]?\s*tokens/.test(trimmed), (trimmed.match(/此处省略约[^）]*/) || [''])[0]);
t('最新一条不截断', w2.trimHistoryContent(long, true) === long);
const capped = w2.trimTextToTokens(long, 500);
t('硬上限兜底生效且估算 ≤ 预算', w2.estimateTokens(capped) <= 500, w2.estimateTokens(capped) + ' ≤ 500');
t('短文本原样返回', w2.trimTextToTokens('短', 500) === '短');

// ══════════════════════════════════════════════════════════════════════════
console.log('\n[回归：原有功能未被破坏]');
t('getContextMeta 仍可用', meta.toolCount === 33, meta.toolCount + ' 个工具');
t('AGENT_SYSTEM_PROMPT 未变', I.AGENT_SYSTEM_PROMPT.length > 8000, I.AGENT_SYSTEM_PROMPT.length + ' 字符');
t('RISKY_TOOLS 仍为 8', I.RISKY_TOOLS.size === 8);
t('白名单仍为 14', I.TOOLS_ALWAYS_ALLOWED.length === 14);
t('blocked hint 不漏原名', !I.buildBlockedToolHint('run_shell', 'conversation').includes('run_shell'));
t('工具展示名仍脱敏', I.buildBlockedToolHint('ensure_clone_desktop', 'conversation').includes('准备桌面分身'));
const hc = cfg.healthCheck();
t('healthCheck ok', hc.ok, hc.problems.join('; ') || '无问题');
t('healthCheck 无警告', hc.warnings.length === 0, hc.warnings.join('; '));
t('stats 含 examples / redactPatterns', hc.stats.examples > 0 && hc.stats.redactPatterns > 0);

console.log('\n' + (fail === 0 ? '全部通过 ✅' : fail + ' 项失败 ❌'));
process.exit(fail === 0 ? 0 : 1);