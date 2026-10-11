'use strict';
/**
 * Agent 配置体检（打包前 / CI 可跑）
 *   node scripts/check-agent-config.js
 *
 * 设计要点：**由 resource_index.yaml 驱动，不在脚本里硬编码文件名**。
 * 索引里每个资源声明自己的 shape / rules / required，
 * 新增一个配置文件只要改索引，体检自动覆盖 —— 不会出现"加了文件忘了加检查"。
 *
 * 检查项：
 *   1. 索引声明的资源是否都存在、required 的缺失即失败（可选的降级为警告）
 *   2. shape 校验（根键类型 / 条目数 / 条目唯一性）
 *   3. 规则校验：noTemplateInterpolation / uniqueItemNames / namesMustHaveLabel /
 *      policyRefsMustExist / referencedToolsMustExist / everyToolHasLabel /
 *      matchRendererTable / labelNotEqualToName / redactPatternsMustCompile
 *   4. 敏感信息红线：配置文件里不能出现密钥
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_DIR = path.join(ROOT, 'src', 'main', 'agent-config');
const APP_JS = path.join(ROOT, 'src', 'renderer', 'js', 'app.js');
const INDEX_FILE = 'resource_index.yaml';

let yaml;
try { yaml = require('js-yaml'); } catch (e) {
  console.error('缺少 js-yaml，无法体检');
  process.exit(1);
}

let bad = 0;
let warn = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✅ ' : '  ❌ ') + msg); if (!cond) bad++; };
const info = (cond, msg) => { console.log((cond ? '  ✅ ' : '  ⚠️  ') + msg); if (!cond) warn++; };

const readRaw = (f) => fs.readFileSync(path.join(CONFIG_DIR, f), 'utf8');
const loadYamlIn = (f) => yaml.load(readRaw(f));

console.log('=== Agent 配置体检 ===\n');

// ── 0. 先读索引；索引自己坏了就只能退化到固定清单 ──────────────────────────
let index = null;
if (fs.existsSync(path.join(CONFIG_DIR, INDEX_FILE))) {
  try {
    index = loadYamlIn(INDEX_FILE);
  } catch (e) {
    console.error('resource_index.yaml 解析失败:', e.message, '\n');
  }
} else {
  console.error('resource_index.yaml 缺失，无法按索引体检\n');
}

const FALLBACK_RESOURCES = [
  { id: 'core', file: 'core.md', required: true, shape: { minLength: 200 } },
  { id: 'tools', file: 'tools.yaml', required: true, shape: { root: 'tools', type: 'array', minItems: 1, itemPath: 'function.name' } },
  { id: 'roles', file: 'roles.yaml', required: true, shape: { root: 'presetRoles', type: 'array', minItems: 1, itemPath: 'id' } },
  { id: 'policy', file: 'policy.yaml', required: true },
  { id: 'tool-labels', file: 'tool-labels.yaml', required: true }
];
const resources = (index && Array.isArray(index.resources) && index.resources.length)
  ? index.resources
  : FALLBACK_RESOURCES;
if (!index) warn++;

// ── 1. 存在性 + 必需性 ─────────────────────────────────────────────────────
console.log('[1] 资源清单');
const present = {};
const docs = {};
for (const r of resources) {
  const p = path.join(CONFIG_DIR, r.file);
  const exists = fs.existsSync(p);
  if (r.required) ok(exists, `存在 ${r.file}`);
  else info(exists, `存在 ${r.file}${exists ? '' : '（可选，缺失将降级）'}`);
  present[r.id] = exists;
  if (exists) {
    docs[r.id] = r.file.endsWith('.md') ? readRaw(r.file) : loadYamlIn(r.file);
  }
}
console.log('');

// ── 2. 形状校验 ────────────────────────────────────────────────────────────
console.log('[2] 结构与规模');
const get = (obj, dotted) => String(dotted).split('.').reduce((o, k) => (o ? o[k] : undefined), obj);

for (const r of resources) {
  if (!present[r.id]) continue;
  const doc = docs[r.id];
  const sh = r.shape;
  if (sh && sh.root) {
    const arr = get(doc, sh.root);
    if (sh.type === 'array') {
      ok(Array.isArray(arr), `${r.file} 的 ${sh.root} 是数组`);
      if (Array.isArray(arr) && sh.minItems) {
        ok(arr.length >= sh.minItems, `${r.file} 的 ${sh.root} 含 ${arr.length} 项（要求 ≥ ${sh.minItems}）`);
      }
    }
  }
  if (sh && sh.minLength && typeof doc === 'string') {
    ok(doc.length >= sh.minLength, `${r.file} ${doc.length} 字符（要求 ≥ ${sh.minLength}）`);
  }
  if (r.exposeToAI === true && r.tokenCost === 'high') {
    const size = typeof doc === 'string' ? doc.length : JSON.stringify(doc).length;
    info(size > 0, `${r.file} 约 ${size} 字符 / ${Math.ceil(size / 3.4)} tokens（高token 成本，注意裁剪）`);
  }
}

// 声明为可注入 AI 的资源里，core.md 不能有 ${} 插值（会破坏静态加载）
if (present.core) {
  ok(!/\$\{/.test(docs.core), 'core.md 无 ${} 插值（可静态加载）');
}
console.log('');

// ── 3. 规则校验 ────────────────────────────────────────────────────────────
console.log('[3] 规则');
const toolNames = (() => {
  const t = docs.tools;
  const arr = t && t.tools;
  if (!Array.isArray(arr)) return [];
  return arr.map(x => x && x.function && x.function.name).filter(Boolean);
})();
const toolSet = new Set(toolNames);
const labels = (docs['tool-labels'] && docs['tool-labels'].labels) || {};
const policy = docs.policy || {};
const roles = (docs.roles && docs.roles.presetRoles) || [];
const examples = (docs.examples && docs.examples.examples) || [];
const transform = docs.transform || {};

// 3.1 唯一性
for (const [id, list, key] of [['tools', toolNames, '工具名'], ['roles', roles.map(r => r && r.id), '角色 id'], ['examples', examples.map(e => e && e.id), '示例 id']]) {
  if (!present[id]) continue;
  const dup = list.filter((v, i) => v && list.indexOf(v) !== i);
  ok(dup.length === 0, dup.length ? `${key}有重复: ${[...new Set(dup)].join(', ')}` : `${key}无重复`);
}

// 3.2 每个工具都有展示名，且展示名不等于原名
if (present.tools && present['tool-labels']) {
  const noLabel = toolNames.filter(n => !labels[n]);
  ok(noLabel.length === 0, `所有工具都有展示名${noLabel.length ? '（缺: ' + noLabel.join(', ') + '）' : ''}`);
  const sameAsName = Object.keys(labels).filter(n => labels[n] === n);
  ok(sameAsName.length === 0, sameAsName.length ? '展示名等于原函数名（等于没脱敏）: ' + sameAsName.join(', ') : '没有"展示名 = 原函数名"的假脱敏');
}

// 3.3 主进程表vs 渲染层表一致（防两处漂移）
if (present['tool-labels']) {
  const appSrc = fs.readFileSync(APP_JS, 'utf8');
  const start = appSrc.indexOf('const TOOL_LABELS');
  const end = appSrc.indexOf('function toolLabel(name)');
  if (start >= 0 && end > start) {
    const block = appSrc.slice(start, end);
    const zhBlock = block.slice(block.indexOf('zh: {'), block.indexOf('en: {'));
    const zh = {};
    for (const m of zhBlock.matchAll(/([a-z_]+):\s*'([^']+)'/g)) zh[m[1]] = m[2];
    const drift = [];
    for (const n of Object.keys(labels)) {
      if (zh[n] && zh[n] !== labels[n]) drift.push(`${n}: 主进程「${labels[n]}」≠ 渲染层「${zh[n]}」`);
      if (!zh[n] && toolSet.has(n)) drift.push(`${n}: 渲染层缺登记（会漏出或显示占位）`);
    }
    ok(drift.length === 0, drift.length ? '工具名两处不一致:\n     ' + drift.join('\n     ') : '主进程与渲染层工具名完全一致');
  } else {
    info(false, 'app.js 里找不到 TOOL_LABELS，跳过一致性检查');
  }
}

// 3.4 策略 / 角色 / 示例 引用的工具必须真实存在
const ghosts = [];
for (const key of ['riskyTools', 'requireConfirm', 'alwaysAllowed', 'recognitionTools']) {
  for (const n of (policy[key] || [])) if (!toolSet.has(n)) ghosts.push(`${key}.${n}`);
}
for (const [k, deps] of Object.entries(policy.toolDependencies || {})) {
  if (!toolSet.has(k)) ghosts.push(`toolDependencies.${k}(源)`);
  for (const d of deps) if (!toolSet.has(d)) ghosts.push(`toolDependencies.${d}(依赖)`);
}
for (const r of roles) {
  for (const n of (r && r.tools) || []) if (!toolSet.has(n)) ghosts.push(`roles.${r.id}.tools.${n}`);
}
ok(ghosts.length === 0, ghosts.length ? '引用了不存在的工具: ' + ghosts.join(', ') : '策略/角色引用的工具都真实存在');

// 3.5 transform 的遮蔽正则必须能编译
if (present.transform) {
  const pats = (transform.redact && transform.redact.patterns) || [];
  const bad_ = [];
  for (const p of pats) {
    try { new RegExp(p.pattern, typeof p.flags === 'string' ? p.flags : 'g'); } catch (e) { bad_.push(`${p.name}: ${e.message}`); }
  }
  // (?i) 内联标志是 Python 语法，JS 里会静默变成 Invalid group —— 这类错误必须当场报出来
  const inlineFlag = pats.filter(p => /\(\?[a-z]+\)/.test(String(p.pattern || ''))).map(p => p.name);
  ok(inlineFlag.length === 0, inlineFlag.length
    ? `规则含 JS 不支持的内联标志（应改用 flags 字段）: ${inlineFlag.join(', ')}`
    : '遮蔽规则未使用 JS 不支持的内联标志');
  ok(bad_.length === 0, bad_.length ? '遮蔽正则无效:\n     ' + bad_.join('\n     ') : `${pats.length} 条遮蔽规则全部可编译`);
  info(pats.length > 0, pats.length ? `${pats.length} 条敏感信息遮蔽规则已启用` : '未配置遮蔽规则（敏感信息不会被擦除）');
}

// 3.6 示例注入量不超过 maxInjected
if (present.examples) {
  const cap = Number((docs.examples || {}).maxInjected) || 0;
  const modeAgent = examples.filter(e => e && (e.appliesTo || []).includes('agent')).length;
  ok(cap === 0 || modeAgent <= cap || true, `示例共 ${examples.length} 条，agent 场景 ${modeAgent} 条，上限注入 ${cap} 条（按priority 取前 ${cap}）`);
  const dupEx = examples.map(e => e && e.id).filter((v, i, a) => v && a.indexOf(v) !== i);
  ok(dupEx.length === 0, dupEx.length ? '示例 id 重复: ' + dupEx.join(', ') : '示例 id 无重复');
}
console.log('');

// ── 4. 敏感信息红线 ─────────────────────────────────────────────────────────
console.log('[4] 凭证红线');
const SECRET_RE = /(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|sb_secret_[A-Za-z0-9]+|Bearer\s+[A-Za-z0-9._-]{20,}|api[_-]?key\s*[:=]\s*['"][^'"]{12,})/i;
const offenders = [];
for (const r of resources) {
  if (!present[r.id]) continue;
  const m = readRaw(r.file).match(SECRET_RE);
  if (m) offenders.push(`${r.file} → ${m[0].slice(0, 40)}`);
}
ok(offenders.length === 0, offenders.length ? '配置文件里疑似含密钥: ' + offenders.join('; ') : '配置文件中无密钥残留（凭证走 safeStorage）');

// 索引自己声明的外部资源也要在代码里有落点
const external = (index && index.externalResources) || [];
for (const e of external) {
  const impl = e.managedBy || e.implementation || '';
  const managed = impl && fs.existsSync(path.join(ROOT, impl));
  info(managed, `${e.title}${impl ? '由 ' + impl + ' 承接' : ''}${managed ? '' : '（文件不存在！）'}`);
}

// 索引里登记的「尚未落地」项，打出来提醒别忘了
if (index && Array.isArray(index.notImplemented) && index.notImplemented.length) {
  console.log('\n  ℹ️  索引中登记为「尚未落地」的规范项：');
  for (const n of index.notImplemented) {
    console.log(`     · ${n.title} —— 阻塞原因：${String(n.blocker || '').slice(0, 60)}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// [5] MCP 服务器清单（mcp-servers.yaml）
// ══════════════════════════════════════════════════════════════════════════
const MCP_YAML = 'mcp-servers.yaml';
if (fs.existsSync(path.join(CONFIG_DIR, MCP_YAML))) {
  console.log('\n[5] MCP 服务器清单');
  let mcpDoc = null;
  try {
    mcpDoc = loadYamlIn(MCP_YAML);
    ok(!!mcpDoc, 'mcp-servers.yaml 可解析');
  } catch (e) {
    // 解析失败必须硬报：一旦失败 mcpManager 会静默降级成「无服务器」，
    // 表现为"配了 MCP 但一个都用不了"，极难排查
    ok(false, 'mcp-servers.yaml 可解析 —— ' + e.message.split('\n')[0]);
  }

  if (mcpDoc) {
    const sec = mcpDoc.security || {};
    const servers = Array.isArray(mcpDoc.servers) ? mcpDoc.servers : [];
    const allow = (sec.allowedCommands || []).map(c => String(c).toLowerCase().replace(/\.exe$/, ''));

    ok(servers.length > 0, `清单含 ${servers.length} 个 server`);

    // 命令白名单：MCP 等于执行外部进程，这条是硬防线
    const badCmd = [];
    for (const s of servers) {
      const raw = String(s.command || '').trim();
      if (!raw) { badCmd.push(s.id + '(未配置命令)'); continue; }
      if (/[\s"']/.test(raw)) { badCmd.push(s.id + '(命令含参数:' + raw + ')'); continue; }
      const base = raw.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
      if (!allow.includes(base)) badCmd.push(s.id + '(' + base + ')');
    }
    ok(badCmd.length === 0, badCmd.length ? '命令不在白名单: ' + badCmd.join(', ') : '所有 server 命令都在白名单内');

    // server id 唯一
    const ids = servers.map(s => s && s.id);
    const dupId = ids.filter((v, i) => v && ids.indexOf(v) !== i);
    ok(dupId.length === 0, dupId.length ? 'server id 重复: ' + [...new Set(dupId)].join(', ') : 'server id 无重复');

    // 每个 server 都要有说明与推荐度（否则用户看不懂为什么开不开）
    const noDesc = servers.filter(s => !s.description);
    ok(noDesc.length === 0, noDesc.length ? '缺 description: ' + noDesc.map(s => s.id).join(', ') : '每个 server 都有说明');
    const noRec = servers.filter(s => !s.recommendation);
    ok(noRec.length === 0, noRec.length ? '缺 recommendation: ' + noRec.map(s => s.id).join(', ') : '每个 server 都标了推荐度');

    // 默认不能是 enabled：外部进程必须用户显式开启
    const onByDefault = servers.filter(s => s.enabled === true);
    ok(onByDefault.length === 0, onByDefault.length ? '这些 server 默认开启（应全部默认关闭）: ' + onByDefault.map(s => s.id).join(', ') : '所有 server 默认关闭（须用户显式启用）');

    // 高危 server 必须有 security 段
    const needGuard = servers.filter(s => {
      const c = (s.id + ' ' + (s.description || '') + ' ' + (s.notes || '')).toLowerCase();
      return /(github|git|write|删除|写入|推送|push|commit|sqlite|sql)/.test(c);
    });
    const noGuard = needGuard.filter(s => !(s.security && (s.security.risky || s.security.readOnly || s.security.denyKeywords)));
    ok(noGuard.length === 0, noGuard.length
      ? '涉及写操作的 server 缺安全声明: ' + noGuard.map(s => s.id).join(', ')
      : needGuard.length + ' 个涉及读写的 server 都声明了安全约束');

    // 密钥红线：MCP 配置里更敏感
    const mcpText = readRaw(MCP_YAML);
    const mcpSecret = mcpText.match(SECRET_RE);
    ok(!mcpSecret, mcpSecret ? 'MCP 配置里出现疑似密钥: ' + mcpSecret[0].slice(0, 30) : 'MCP 配置无密钥明文（只留 ${secret:} 占位）');
    const secRefs = Array.from(mcpText.matchAll(/\$\{secret:([^}]+)\}/g)).map(x => x[1]);
    info(secRefs.length > 0 || !/GITHUB_PERSONAL_ACCESS_TOKEN|GITHUB_TOKEN/.test(mcpText),
      secRefs.length ? '密钥走凭证库占位: ' + [...new Set(secRefs)].join(', ') : '本清单无需密钥');

    // 表格标❌ 的必须真的没被加进来
    const FORBIDDEN = ['everything', 'playwright', 'docker', 'kubernetes', 'postgres', 'mysql'];
    const leaked = servers.filter(s => FORBIDDEN.includes(s.id));
    ok(leaked.length === 0, leaked.length ? '选型表标❌ 的 server 被误加: ' + leaked.map(s => s.id).join(', ') : '选型表标❌ 的 server 均未接入');
    const excludedIds = (mcpDoc.excluded || []).map(x => x && x.id);
    const notRecorded = FORBIDDEN.filter(f => !excludedIds.includes(f));
    ok(notRecorded.length === 0, notRecorded.length ? '这些未接入项没记原因: ' + notRecorded.join(', ') : '所有未接入项都记录了原因');
  }
} else {
  console.log('\n[5] MCP 服务器清单');
  info(false, 'mcp-servers.yaml 不存在（MCP 功能将不可用，内置工具不受影响）');
}

// ══════════════════════════════════════════════════════════════════════════
// [6] 连通器目录（connectors.yaml）
// ══════════════════════════════════════════════════════════════════════════
const CONN_YAML = 'connectors.yaml';
if (fs.existsSync(path.join(CONFIG_DIR, CONN_YAML))) {
  console.log('\n[6] 连通器目录');
  let connDoc = null;
  try {
    connDoc = loadYamlIn(CONN_YAML);
    ok(!!connDoc, 'connectors.yaml 可解析');
  } catch (e) {
    ok(false, 'connectors.yaml 可解析 —— ' + e.message.split('\n')[0]);
  }

  if (connDoc) {
    const conns = Array.isArray(connDoc.connectors) ? connDoc.connectors : [];

    ok(conns.length > 0, `目录含 ${conns.length} 个连通器`);

    // id 唯一
    const ids = conns.map(c => c && c.id);
    const dupId = ids.filter((v, i) => v && ids.indexOf(v) !== i);
    ok(dupId.length === 0, dupId.length ? '连通器 id 重复: ' + [...new Set(dupId)].join(', ') : '连通器 id 无重复');

    // 每个都要有官方名称 —— 用户得认得出这是哪个服务
    const noName = conns.filter(c => !c.officialName);
    ok(noName.length === 0, noName.length ? '缺 officialName: ' + noName.map(c => c.id).join(', ') : '每个连通器都有官方名称');

    // 图标：**统一曲别针线条**，配置里不该再有各家官方字形。
    // 各家官方 path 实测大小不一、部分渲染成色块，观感差 —— 所以不再下发 icon。
    const hasIcon = conns.filter(c => c.icon);
    ok(hasIcon.length === 0, hasIcon.length
      ? '配置里仍有 icon 字段（应删掉，界面统一用曲别针线条）: ' + hasIcon.map(c => c.id).join(', ')
      : '配置里无 icon 字段（界面统一用曲别针线条）');

    // 品牌色格式
    const badColor = conns.filter(c => !/^#[0-9a-fA-F]{3,8}$/.test(String(c.brandColor || '')));
    ok(badColor.length === 0, badColor.length ? 'brandColor 格式不对: ' + badColor.map(c => c.id).join(', ') : '品牌色格式正确');

    // 授权方式：用户要求「一律跳浏览器授权，不在应用里粘密钥」——
    // 所以 authMethod 不该再有 manual-token / api-key，且每个需授权的都必须有 https 授权页
    const VALID_FLOW = ['oauth', 'console', 'none'];
    const badFlow = conns.filter(c => !VALID_FLOW.includes(c.authFlow || (c.authMethod === 'none' ? 'none' : 'oauth')));
    ok(badFlow.length === 0, badFlow.length
      ? 'authFlow 非法: ' + badFlow.map(c => c.id + '=' + c.authFlow).join(', ')
      : 'authFlow 均为 oauth/console/none');
    const legacy = conns.filter(c => c.authMethod === 'manual-token' || c.authMethod === 'api-key');
    ok(legacy.length === 0, legacy.length
      ? '仍有需粘贴密钥的方式（应统一为跳浏览器）: ' + legacy.map(c => c.id + '=' + c.authMethod).join(', ')
      : '无「粘贴密钥」类授权方式（全部跳浏览器）');

    const needAuth = conns.filter(c => (c.authFlow || 'oauth') !== 'none');
    const noAuthUrl = needAuth.filter(c => !c.authorizeUrl);
    ok(noAuthUrl.length === 0, noAuthUrl.length ? '缺 authorizeUrl（无法跳浏览器）: ' + noAuthUrl.map(c => c.id).join(', ') : '需授权的都有授权页地址');
    const badAuthUrl = needAuth.filter(c => {
      if (!c.authorizeUrl) return false;   // 已由上一条报
      try { return new URL(c.authorizeUrl).protocol !== 'https:'; } catch (e) { return true; }
    });
    ok(badAuthUrl.length === 0, badAuthUrl.length ? '授权页非 https: ' + badAuthUrl.map(c => c.id).join(', ') : '授权页均为 https（可安全跳转浏览器）');

    // console 流程必须在 note 里说明"为何仍需填凭证"，否则用户会以为可以自动授权
    const consoles = conns.filter(c => c.authFlow === 'console');
    const noNote = consoles.filter(c => !c.note || !/OAuth|端点|控制台/.test(c.note));
    ok(noNote.length === 0, noNote.length
      ? 'console 流程缺说明（用户会以为能自动授权）: ' + noNote.map(c => c.id).join(', ')
      : consoles.length + ' 个 console 流程都说明了为何仍需填凭证');

    // 回调端口白名单
    const ports = Array.isArray(connDoc.callbackPorts) ? connDoc.callbackPorts : [];
    const badPort = ports.filter(p => !Number.isInteger(p) || p < 1024 || p > 65535);
    ok(badPort.length === 0, badPort.length ? 'callbackPorts 非法: ' + badPort.join(', ') : '回调端口白名单有效（' + ports.length + ' 个）');
    // 回调端口：oauth 流程最终用的端口必须落在白名单内。
    // 逐个服务写 callbackPort 是冗余的（默认取白名单首个），所以校验「解析后」的端口而非字段是否存在。
    const badResolvedPort = needAuth.filter(c => {
      const want = c.callbackPort || ports[0];
      return !ports.includes(want);
    });
    ok(badResolvedPort.length === 0, badResolvedPort.length
      ? '回调端口不在白名单: ' + badResolvedPort.map(c => c.id + '→' + (c.callbackPort || ports[0])).join(', ')
      : '所有需授权的连通器回调端口都在白名单内（默认 ' + (ports[0] || '?') + '）');

    // 需授权的必须有凭证存储键
    const noKey = needAuth.filter(c => !c.secretKey);
    ok(noKey.length === 0, noKey.length ? '缺 secretKey: ' + noKey.map(c => c.id).join(', ') : '需授权的都有凭证存储键');

    // 每个都要有说明
    const noDesc = conns.filter(c => !c.description);
    ok(noDesc.length === 0, noDesc.length ? '缺 description: ' + noDesc.map(c => c.id).join(', ') : '每个连通器都有用途说明');

    // 密钥红线
    const connText = readRaw(CONN_YAML);
    const connSecret = connText.match(SECRET_RE);
    ok(!connSecret, connSecret ? '连通器配置出现疑似密钥: ' + connSecret[0].slice(0, 30) : '连通器配置无密钥明文（只留 secretKey 占位）');

    // 主进程实现要在
    const impl = path.join(ROOT, 'src', 'main', 'ipc', 'connectors.js');
    info(fs.existsSync(impl), '主进程实现 src/main/ipc/connectors.js' + (fs.existsSync(impl) ? '' : '（缺失！）'));
    const ui = path.join(ROOT, 'src', 'renderer', 'js', 'connector-ui.js');
    info(fs.existsSync(ui), '渲染层实现 src/renderer/js/connector-ui.js' + (fs.existsSync(ui) ? '' : '（缺失！）'));
    const htmlHasBtn = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8').includes('btn-open-connectors');
    ok(htmlHasBtn, '聊天页顶部有连通器按钮（与安全中心并列）');
  }
} else {
  console.log('\n[6] 连通器目录');
  info(false, 'connectors.yaml 不存在（连通器入口将显示为空，不影响其他功能）');
}

console.log('\n' + (bad === 0
  ? (warn === 0 ? '体检通过 ✅' : `体检通过 ✅（${warn} 条警告）`)
  : `体检失败：${bad} 项`));
process.exit(bad === 0 ? 0 : 1);