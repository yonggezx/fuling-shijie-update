const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { exec } = require('child_process');
const { URL } = require('url');

// Agent 配置：已从 aiOps.js 外置到 src/main/agent-config/（core.md / tools.yaml / policy.yaml ...）
const _agentCfgRaw = require('../config/agentConfig');
const _agentCfg = _agentCfgRaw.load() || { tools: [], toolLabels: {}, presetRoles: [], policy: {}, corePrompt: '' };

// MCP（外部工具服务器）：工具不进 AGENT_TOOLS 常量，而是**运行时动态追加**——
// MCP server 可能随时被用户启停，schema 只有连上之后才知道。
const _mcp = require('../mcp/mcpManager');

// 智能商城：技能能力包索引注入系统提示词（由 main.js 在启动时 init 到 userData）
const _marketplace = require('../marketplace/marketplaceManager');

// ── 增强模块（2026-10 新增） ──────────────────────────────────────────────
// 按「MCP 增强模块清单」补齐的核心能力：
//   · reflector        —— 反思器：工具结果质量自检，防止"错误结果以为成功"
//   · resultValidator  —— 结果校验器：格式/长度/敏感信息硬门禁
//   · toolRouter       —— 工具路由：按用户问题筛选相关工具，省 token
//   · mcpRetryPolicy   —— 失败降级&重试：区分错误类型自动恢复
//   · contextCompressor—— 上下文压缩：长文本自动瘦身，省显存
const _reflector = require('./reflector');
const _resultValidator = require('./resultValidator');
const _toolRouter = require('./toolRouter');
const _mcpRetry = require('./mcpRetryPolicy');
const _contextCompressor = require('./contextCompressor');

/**
 * MCP 生命周期包装：启停/改启用集合后必须让本模块的工具缓存失效，
 * 否则模型会在接下来 5 秒里继续收到已经停掉的工具（然后反复调用一个死服务）。
 */
function _mcpInvalidate(res) { invalidateMcpTools(); return res; }

/**
 * 挑「主窗口」—— 桌面分身小窗定位锚点的基准。
 *
 * ⚠️ **绝对不能**用"标题含『浮灵』的第一个可见窗口"：
 *   宠物窗口的标题是「浮灵饰界 - 灵汐」，同样含"浮灵"，而且它创建得更早，
 *   会被优先选中。实测后果：用**宠物窗**的 bounds（324×466 DIP，右缘 1860 DIP）去定位小窗，
 *   而 2560×1600 物理屏在 150% 缩放下逻辑工作区只有 1706 宽 → 右缘越界被夹到屏幕右边，
 *   表现为"悬浮窗脱离页面浮在屏幕右侧"（用户 09:20 反馈的现象）。
 *
 * 判据：**面积最大的那个**才是主窗口（宠物窗只有几百像素宽，差两个数量级）。
 * 也不要求 isVisible —— 主窗口收进托盘时分身仍要能贴到它原来的位置，
 * 那时它是隐藏的，用可见性过滤会直接挑不到人。
 */
function pickMainWindow() {
  const { BrowserWindow } = require('electron');
  const wins = BrowserWindow.getAllWindows().filter((w) => {
    try { return !w.isDestroyed(); } catch (e) { return false; }
  });
  if (!wins.length) return null;
  const re = /浮灵|desktop|main|助手/i;
  const cands = wins.filter((w) => { try { return re.test(w.getTitle() || ''); } catch (e) { return false; } });
  const pool = cands.length ? cands : wins;
  const area = (w) => { try { const b = w.getBounds(); return b.width * b.height; } catch (e) { return -1; } };
  return pool.reduce((a, b) => (area(b) > area(a) ? b : a));
}

// 取主窗口 bounds（桌面分身小窗的定位锚点基准）
function currentMainWindowBounds() {
  try {
    const w = pickMainWindow();
    if (w) return w.getBounds();
  } catch (e) { /* ignore */ }
  return { x: 0, y: 0, width: 1200, height: 800 };
}

// 取主窗口 bounds + 渲染端实测的输入栏矩形 + 主窗口原生句柄。
// 前两者给桌面分身预览小窗定位（贴输入栏上方），句柄给宿主做 Win32 owner 绑定
// ——分身要跟主程序绑在一起（主窗口关了/收了，分身跟着走）。
// AI 侧（ensure_clone_desktop / launch_in_clone）没有前端测量值可传，所以在主进程里
// 直接问渲染端要一次；量不到就返回 null，desktopSession 会按窗口底部估算兜底。
async function currentCloneAnchor() {
  const winBounds = currentMainWindowBounds();
  let anchorRect = null;
  let ownerHwnd = 0;
  try {
    const target = pickMainWindow();
    if (target && !target.isDestroyed()) {
      try {
        const buf = target.getNativeWindowHandle();
        if (buf && buf.length >= 8) ownerHwnd = buf.readBigUInt64LE(0).toString();
        else if (buf && buf.length >= 4) ownerHwnd = String(buf.readUInt32LE(0));
      } catch (e) { ownerHwnd = 0; }
      if (target.webContents) {
        anchorRect = await target.webContents.executeJavaScript(
          `(() => {
             const el = document.querySelector('.chat-input-area')
                     || document.querySelector('.chat-input-wrapper')
                     || document.getElementById('chat-input');
             if (!el) return null;
             const r = el.getBoundingClientRect();
             if (!r || r.width <= 0 || r.height <= 0) return null;
             return { x: Math.round(window.screenX + r.left), y: Math.round(window.screenY + r.top),
                      width: Math.round(r.width), height: Math.round(r.height) };
           })()`, true);
        if (anchorRect && !(anchorRect.width > 0)) anchorRect = null;
      }
    }
  } catch (e) { anchorRect = null; }
  return { winBounds, anchorRect, ownerHwnd };
}

/**
 * 等一个"正在启动"的桌面分身变为 running（或 error）。
 * 关键：避免 ensure_clone_desktop / launch_in_clone 在 state==='starting' 时再次调用
 * DesktopSession.start() —— start 内部会先 taskkill 掉正在启动的宿主（desktopSession.js:297），
 * 把刚拉起、还没连上的子会话杀掉，结果永远连不上 → 工具卡到超时。正确做法是等它就绪、复用同一次启动。
 * @param {number} timeoutMs 最长等待（与 DesktopSession.start 的 75s 兜底对齐）
 */
async function waitCloneRunning(timeoutMs = 75000) {
  const DesktopSession = require('../desktopSession');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = DesktopSession.status();
    if (s.state === 'running') return { success: true, state: 'running', hwnd: s.hwnd };
    if (s.state === 'error') return { success: false, state: 'error', error: '桌面分身启动后进入错误状态' };
    await new Promise(r => setTimeout(r, 1000));
  }
  return { success: false, state: 'error', error: '等待桌面分身启动超时（子会话未能建立）' };
}

// 工具调用恢复相关纯函数（无 electron 依赖，可独立单测）
const { extractToolCallFromText, getLastUserMessage, normalizeAgentMessages, createInlineThinkSplitter } = require('./agentToolUtils');
// 长期记忆（memory_save / memory_search / memory_list / memory_delete 的存储层）
const MemoryStore = require('./memoryStore');
// 待办事项（todo_write / todo_update / todo_read 的存储层，按会话隔离）
const TodoStore = require('./todoStore');
// 本地 AI 模型推理引擎适配（非 Ollama：llama.cpp / LM Studio / vLLM 等 OpenAI 兼容服务）
const LocalAiEngine = require('./localAiEngine');
const ToolAutoInstall = require('./toolAutoInstall');
// UI 自验证（capture_window / verify_ui 的截图与布局自检实现）
const UiVerify = require('./uiVerify');
// 项目上下文分析（选项目后自动分析，注入系统提示词；分析结果落盘到隐藏工作区供 AI 校验）
const ProjectContext = require('./projectContext');
// 项目隐藏工作区（选项目时创建 .ai_workspace/{memory,context,changes}，记忆与改动按项目隔离）
const ProjectWorkspace = require('./projectWorkspace');
// AI 进化记录（近期习惯/动向，用于个性化注入与「AI 进化训练」面板）
const EvolutionStore = require('./evolutionStore');

// ============================================================
// 个性化（设置 → 功能设置）：回复风格 / 身份人格 / 自定义指令 / 系统提示词 / 近期动向
// 2026-10-03 新增。这些配置统一放在 configManager 的 personalization 段。
// ============================================================

// 回复风格预设：键是配置值，值是要注入提示词的风格说明
const REPLY_STYLES = {
  default: '',
  concise: '回复风格：简洁。能一句说清就不写两句，先给结论再给理由；不要铺垫、不要复述用户的话、不要客套结尾。',
  detailed: '回复风格：细致。重要结论给依据（文件/行号/命令输出），必要时补一句原理；该展开的地方展开，但不灌水。',
  warm: '回复风格：亲切自然。像真人对话一样有温度，但不腻；该说正事说正事。',
  professional: '回复风格：专业严谨。用词准确，不确定就说不确定，不猜、不夸大；先事实后判断。',
  humorous: '回复风格：轻松幽默。可以适当开玩笑活跃气氛，但涉及正事、报错、风险时立刻收住，认真答。'
};

const REPLY_STYLE_KEYS = Object.keys(REPLY_STYLES);

/** 读 personalization 配置（容错：配置被删/损坏时回默认值）。 */
function getPersonalization() {
  const d = {
    memoryEnabled: true,
    autoRecordHabits: true,
    evolveEnabled: true,
    replyStyle: 'default',
    personaName: '灵汐',
    personaRole: '桌面 AI 助手',
    personaDesc: '',
    customInstructions: '',
    systemPrompt: ''
  };
  try {
    // eslint-disable-next-line global-require
    const { getConfig } = require('../configManager');
    const p = (getConfig() || {}).personalization;
    if (!p || typeof p !== 'object') return d;
    for (const k of Object.keys(d)) {
      if (p[k] === undefined || p[k] === null) continue;
      d[k] = typeof d[k] === 'boolean' ? !!p[k] : String(p[k]);
    }
  } catch (e) { /* 用默认值 */ }
  if (!REPLY_STYLES.hasOwnProperty(d.replyStyle)) d.replyStyle = 'default';
  return d;
}

/**
 * 根据中文/英文程序名解析真实可执行路径（Windows）。
 * 搜索顺序：App Paths 注册表 → 开始菜单快捷方式 → 常见安装目录。
 * 找不到时返回原 name，不抛错。
 * @param {string} name
 * @returns {Promise<string>}
 */
async function resolveWindowsProgram(name) {
  return new Promise((resolve) => {
    if (!name || typeof name !== 'string') return resolve(name);
    const trimmed = name.trim();
    if (!trimmed) return resolve(name);
    // 已经是绝对路径或带路径分隔符的命令，保持原样
    if (/^[a-zA-Z]:[\\\/]/.test(trimmed) || trimmed.includes('\\') || trimmed.includes('/')) {
      return resolve(trimmed);
    }
    // 去掉 .exe 后缀用于搜索
    const searchName = trimmed.replace(/\.exe$/i, '');
    const safeName = searchName.replace(/'/g, "''");
    const psScript = [
      '$ErrorActionPreference = "SilentlyContinue"',
      `$name = '${safeName}'`,
      '$found = $null',
      '$regBases = @(',
      '  "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths",',
      '  "HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths",',
      '  "HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths"',
      ')',
      'foreach ($base in $regBases) {',
      '  if (Test-Path $base) {',
      '    Get-ChildItem $base | ForEach-Object {',
      '      $kn = $_.PSChildName',
      '      if ($kn -ieq $name -or $kn -ieq "$name.exe" -or $kn -like "*$name*") {',
      '        $v = (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue)."(default)"',
      '        if ($v) { $p = $v.Trim(\'"\'); if (Test-Path $p) { $found = $p } }',
      '      }',
      '    }',
      '  }',
      '  if ($found) { break }',
      '}',
      'if (-not $found) {',
      '  $wsh = New-Object -ComObject WScript.Shell',
      '  $dirs = @("$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs", "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs")',
      '  foreach ($d in $dirs) {',
      '    if (Test-Path $d) {',
      '      Get-ChildItem $d -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {',
      '        $sc = $wsh.CreateShortcut($_.FullName)',
      '        if ($_.BaseName -ieq $name -or $_.BaseName -like "*$name*" -or $sc.TargetPath -like "*$name*") {',
      '          $found = $sc.TargetPath',
      '        }',
      '      }',
      '    }',
      '    if ($found) { break }',
      '  }',
      '}',
      'if (-not $found) {',
      '  $cpaths = @("$env:LOCALAPPDATA\\Programs", "$env:ProgramFiles", "${env:ProgramFiles(x86)}")',
      '  foreach ($cp in $cpaths) {',
      '    if (Test-Path $cp) {',
      '      $t1 = Join-Path $cp "$name.exe"',
      '      if (Test-Path $t1) { $found = $t1; break }',
      '      $t2 = Join-Path $cp $name',
      '      if (Test-Path $t2) { $found = $t2; break }',
      '    }',
      '  }',
      '}',
      'if ($found) { Write-Output $found }'
    ].join('\n');
    const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    exec(`"${psExe}" -NoProfile -EncodedCommand ${encoded}`, { timeout: 10000, encoding: 'utf8' }, (err, stdout) => {
      if (err || !stdout || !stdout.trim()) return resolve(trimmed);
      resolve(stdout.trim());
    });
  });
}

/**
 * 生成注入系统提示词的「个性化」段。
 * 注意：这里只做**追加**，绝不替换角色/agent 的基础提示词 —— 否则工具调用规范会被冲掉。
 * @param {object} opts { forAgent: boolean }
 */
function buildPersonalizationBlock(opts = {}) {
  const p = getPersonalization();
  const parts = [];

  if (p.personaName || p.personaRole || p.personaDesc) {
    const who = [];
    if (p.personaName) who.push('名字叫「' + p.personaName + '」');
    if (p.personaRole) who.push('身份是' + p.personaRole);
    let s = '## 你的身份人格（用户设定，优先遵守）\n- 你是' + (who.join('，') || '桌面 AI 助手');
    if (p.personaDesc) s += '\n- 用户对你的设定：' + p.personaDesc.replace(/\s+/g, ' ').slice(0, 600);
    parts.push(s);
  }

  const style = REPLY_STYLES[p.replyStyle] || '';
  if (style) parts.push('## 回复风格（用户选定）\n' + style);

  if (p.customInstructions && p.customInstructions.trim()) {
    parts.push('## 用户自定义指令（回答规则，优先级高于你的默认习惯）\n'
      + p.customInstructions.trim().slice(0, 2000));
  }

  if (!p.memoryEnabled) {
    parts.push('## 长期记忆\n- 用户已关闭长期记忆：**不要调用 memory_save / memory_update**，也不要假装记得以前的事。');
  }

  // 近期动向注入只看「进化训练」开关：记录停了但已积累的画像仍可用
  if (p.evolveEnabled) {
    let evo = '';
    try { evo = EvolutionStore.contextBlock(5); } catch (e) { evo = ''; }
    if (evo) parts.push(evo);
  }

  if (!parts.length) return '';
  return (opts.forAgent ? '' : '') + parts.join('\n\n');
}

/** 记录一条「近期动向」，用于 AI 进化训练。永远不抛错、失败不影响对话。 */
function recordEvolution(entry) {
  try {
    const p = getPersonalization();
    if (!p.autoRecordHabits) return false;
    return EvolutionStore.append(entry);
  } catch (e) {
    return false;
  }
}


// 将 API 错误响应简化为用户可读的简短提示，避免展示原始 JSON
function simplifyApiError(statusCode, rawData) {
  const code = parseInt(statusCode, 10);
  let detail = '';
  try {
    const parsed = JSON.parse(rawData);
    const e = parsed.error || parsed;
    detail = (e && (e.message || e.message_zh || e.code)) || parsed.message || parsed.msg || parsed.code || '';
    // 数字型 code（如 {"error":{"code":1211}}）转成字符串，别当空处理
    if (typeof detail !== 'string') detail = typeof detail === 'number' ? String(detail) : '';
  } catch (_) { detail = (rawData || '').toString(); }
  // 提取不到结构化信息时保留原文片段——否则 400/422 只剩「请求失败（400）」，无从排查
  if (!detail && rawData) detail = String(rawData).substring(0, 160);
  // 去掉详情中的 URL、request_id 等技术信息，只保留核心语义
  detail = detail.replace(/https?:\/\/\S+/g, '').replace(/request[_-]?id["':\s]+[a-f0-9-]+/gi, '').trim();
  if (detail.length > 80) detail = detail.substring(0, 80) + '...';
  const map = {
    401: 'API 密钥无效，请检查提供商的 API Key 配置',
    403: '没有访问权限，请检查账户状态或套餐配额',
    404: '请求地址不存在，请检查 API 地址是否正确',
    429: '请求过于频繁或额度已用完，请稍后再试',
    500: '服务器内部错误，请稍后再试',
    502: '服务暂时不可用，请稍后再试',
    503: '服务暂时不可用，请稍后再试',
    504: '服务响应超时，请稍后再试',
  };
  let msg = map[code] || ('请求失败（' + code + '）');
  if (detail && !map[code]) msg += '：' + detail;
  return msg;
}

// 本地模型显存释放：回答结束后空闲 5 分钟自动停止 llama-server，释放 GPU/内存
let localUnloadTimer = null;
let localRequestInFlight = false; // 请求进行中不允许卸载
const LOCAL_UNLOAD_DELAY_MS = 5 * 60 * 1000; // 5分钟无新请求才卸载
function scheduleLocalModelUnload() {
  if (localUnloadTimer) clearTimeout(localUnloadTimer);
  localUnloadTimer = setTimeout(() => {
    localUnloadTimer = null;
    if (localRequestInFlight) { scheduleLocalModelUnload(); return; }
    try {
      const r = LocalAiEngine.stop();
      console.log('[LocalAI] 空闲超时，释放本地模型显存:', r.stopped ? '已停止' : '无托管进程');
    } catch (e) { console.warn('[LocalAI] 释放显存失败:', e.message); }
  }, LOCAL_UNLOAD_DELAY_MS);
}
function cancelLocalModelUnload() {
  if (localUnloadTimer) { clearTimeout(localUnloadTimer); localUnloadTimer = null; }
}
let aiConfig = null;
let toolInstallDir = null;
let statusCache = null;

// 工具调用授权确认
let pendingToolConfirm = null; // { resolve, tool, args }
// 会话内用户点过"允许执行"的工具：本轮 agentChat 内同工具不再弹窗，直接放行
let sessionAllowedTools = new Set();

function requestToolConfirm(tool, args, emitFn, isUserEnabled) {
  // 用户本轮已允许过这个工具 → 直接放行，不再弹窗
  if (sessionAllowedTools.has(tool)) {
    return Promise.resolve({ allowed: true, remembered: true });
  }
  return new Promise((resolve) => {
    pendingToolConfirm = { resolve, tool, args };
    emitFn('agent-tool-confirm', { tool, args });
    // 确认超时（默认 120 秒）：用户"点慢了"不该导致任务失败。
    // 已勾选授权过的工具（isUserEnabled=true）超时后自动放行——用户已经表达信任，
    // 即使因参数被截断等原因需要弹窗核对，不点也不会失败；
    // 未勾选过的工具超时后仍拒绝，保持安全、不静默执行风险操作。
    setTimeout(() => {
      if (pendingToolConfirm) {
        const p = pendingToolConfirm;
        pendingToolConfirm = null;
        if (isUserEnabled) {
          p.resolve({ allowed: true, reason: '已勾选授权，等待确认超时后自动放行' });
        } else {
          p.resolve({ allowed: false, reason: '确认超时（120 秒）' });
        }
      }
    }, 120000);
  });
}
function resolveToolConfirm(allowed) {
  if (pendingToolConfirm) {
    const p = pendingToolConfirm;
    pendingToolConfirm = null;
    if (allowed && p.tool) sessionAllowedTools.add(p.tool);  // 记住本轮已允许
    p.resolve({ allowed: !!allowed });
  }
}

// 【询问用户】（ask_user）：就"这条待办怎么做"向用户出方案选项（用户也可自定义输入）。
// 与 requestToolConfirm 一样是单挂起槽位（agent 串行，同一时刻只会有一个问题在等）。
let pendingUserAsk = null; // { resolve, id }
function requestUserGuidance(args, emitFn) {
  return new Promise((resolve) => {
    const options = Array.isArray(args.options)
      ? args.options.map(o => String(o)).filter(s => s.trim()).slice(0, 6)
      : [];
    const id = 'ask_' + Date.now();
    pendingUserAsk = { resolve, id };
    emitFn('agent-ask-user', {
      id,
      question: String(args.question || '请选择这条任务的做法：'),
      options,
      allowCustom: args.allow_custom !== false
    });
    // 10 分钟无应答 → 按模型最佳判断继续，不要把整个任务卡死在等待上
    setTimeout(() => {
      if (pendingUserAsk && pendingUserAsk.id === id) {
        pendingUserAsk = null;
        resolve({ success: true, answered: false, answer: '（用户长时间未选择，已按你判断的最佳方案继续，请在最终汇报里说明采用的做法）' });
      }
    }, 600000);
  });
}
function resolveUserGuidance(payload) {
  if (pendingUserAsk) {
    const p = pendingUserAsk;
    pendingUserAsk = null;
    const ans = payload && typeof payload.answer === 'string' ? payload.answer.trim() : '';
    p.resolve({ success: true, answered: !!ans, answer: ans || '（用户未填写内容）', source: (payload && payload.source) || 'custom' });
  }
}
// 有操作风险的工具（需要在设置中显式启用，且执行前需要确认）
// 无风险工具（只读/安全）默认启用，不需要用户确认，直接执行
const RISKY_TOOLS = new Set(_agentCfg.policy.riskyTools || []);
const TOOLS_REQUIRE_CONFIRM = RISKY_TOOLS;

// 新增的只读/低风险工具：对**所有角色**默认放开（含用户早先保存的自定义角色）。
// memory_* 只动本应用自己的 memory.json，capture/verify 只读画面与布局，都不碰用户文件。
const TOOLS_ALWAYS_ALLOWED = _agentCfg.policy.alwaysAllowed || [];

// 桌面分身类工具首次启动要走 RDP 子会话建立（DesktopSession.start 自带 75s 兜底循环），
// 通用工具的 60s 超时比它短，会提前把首次启动判成"超时"并断链（模型看到失败就接不上 launch_in_clone）。
// 这类工具单独给更长的执行超时（120s，大于 75s），让子会话有完整时间连上。
const CLONE_DESKTOP_TOOLS = new Set(['ensure_clone_desktop', 'launch_in_clone']);

// 工具前置依赖：允许了 A，就应连带允许 A 必需的前置工具 B。
// 目前只有一组——launch_in_clone / control_computer（对分身桌面操作）都必须先 ensure_clone_desktop
// 把悬浮窗开起来，否则调用只会返回 needLaunch 错误。用依赖表兜底：即使日后有人把
// ensure_clone_desktop 从 TOOLS_ALWAYS_ALLOWED 里挪走，也不会再断链。
const TOOL_DEPENDENCIES = _agentCfg.policy.toolDependencies || {};

// 计算角色最终可用的工具集合：角色自选范围 ∩ 已注册工具 → 并上"强制放开"白名单 → 展开前置依赖。
// 抽成纯函数只为一件事：这条链路曾因白名单漏项（ensure_clone_desktop）而**静默**断链——
// 模型点名工具、提取成功、却被 ensureToolEnabled 拒掉，日志里只留下一行"恢复链路中断"。
// 有了这个纯函数，scripts/test-agent-tool-perm.js 能直接把每个预设角色跑一遍，回归挡住同类问题。
function resolveRoleTools(roleToolsInput, allToolNames) {
  const roleTools = (Array.isArray(roleToolsInput) && roleToolsInput.length > 0 ? roleToolsInput : allToolNames)
    .filter(n => allToolNames.includes(n));
  // 后加的低风险工具（记忆 / 界面自验证 / 桌面分身）对所有角色强制放开：
  // 老版本保存的自定义角色 tools 里没有这些名字，不做并集的话升级后它们永久不可见。
  TOOLS_ALWAYS_ALLOWED.forEach(n => {
    if (allToolNames.includes(n) && !roleTools.includes(n)) roleTools.push(n);
  });
  // 前置依赖展开：角色允许 launch_in_clone / control_computer，就必然需要 ensure_clone_desktop
  // （分身悬浮窗没开，启动程序/操作分身只会返回 needLaunch）。只对已注册工具生效，最多展开 3 层。
  for (let depth = 0; depth < 3; depth++) {
    let added = false;
    for (const n of roleTools.slice()) {
      const deps = TOOL_DEPENDENCIES[n];
      if (!deps) continue;
      for (const d of deps) {
        if (allToolNames.includes(d) && !roleTools.includes(d)) { roleTools.push(d); added = true; }
      }
    }
    if (!added) break;
  }
  return roleTools;
}

// 预设提供商模板
const PROVIDER_PRESETS = {
  ollama: {
    name: 'Ollama (本地)',
    type: 'ollama',
    apiUrl: 'http://localhost:11434',
    apiKey: '',
    model: 'llama3',
    description: 'Ollama 本地大模型服务，无需 API Key'
  },
  bailian: {
    name: '阿里云百炼 (DashScope)',
    type: 'dashscope',
    apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    apiKey: '',
    model: 'qwen-plus',
    description: '阿里云百炼大模型平台，OpenAI 兼容模式'
  },
  openai: {
    name: 'OpenAI',
    type: 'openai',
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    apiKey: '',
    model: 'gpt-4',
    description: 'OpenAI 官方 API'
  },
  deepseek: {
    name: 'DeepSeek',
    type: 'openai',
    apiUrl: 'https://api.deepseek.com/v1/chat/completions',
    apiKey: '',
    model: 'deepseek-chat',
    description: 'DeepSeek API（OpenAI 兼容）'
  },
  tencent: {
    name: '腾讯云混元',
    type: 'openai',
    apiUrl: 'https://api.hunyuan.cloud.tencent.com/v1/chat/completions',
    apiKey: '',
    model: 'hunyuan-pro',
    description: '腾讯云混元大模型（OpenAI 兼容）'
  },
  tencentmaas: {
    name: '腾讯云 TokenHub (MaaS)',
    type: 'openai',
    apiUrl: 'https://tokenhub.tencentmaas.com/v1/chat/completions',
    apiKey: '',
    model: 'hy3',
    description: '腾讯云 TokenHub MaaS 网关（OpenAI 兼容），需填写 TokenHub 的 API Key 与模型名；模型名以 TokenHub 控制台为准（如 hy3）'
  },
  zhipu: {
    name: '智谱 GLM',
    type: 'openai',
    apiUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    apiKey: '',
    model: 'glm-4',
    description: '智谱 AI GLM 系列（OpenAI 兼容）'
  },
  baidu: {
    name: '百度千帆',
    type: 'openai',
    apiUrl: 'https://qianfan.baidubce.com/v2/chat/completions',
    apiKey: '',
    model: 'ernie-4.0-8k',
    description: '百度智能云千帆大模型（OpenAI 兼容）'
  },
  moonshot: {
    name: '月之暗面 Kimi',
    type: 'openai',
    apiUrl: 'https://api.moonshot.cn/v1/chat/completions',
    apiKey: '',
    model: 'moonshot-v1-8k',
    description: 'Kimi 大模型（OpenAI 兼容）'
  },
  anthropic: {
    name: 'Anthropic Claude',
    type: 'openai',
    apiUrl: 'https://api.anthropic.com/v1/chat/completions',
    apiKey: '',
    model: 'claude-3-5-sonnet-20241022',
    description: 'Anthropic Claude 系列（OpenAI 兼容）'
  },
  google: {
    name: 'Google Gemini',
    type: 'openai',
    apiUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    apiKey: '',
    model: 'gemini-1.5-pro',
    description: 'Google Gemini 系列（OpenAI 兼容）'
  },
  bytedance: {
    name: '字节豆包 (火山引擎)',
    type: 'openai',
    apiUrl: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    apiKey: '',
    model: 'doubao-pro-32k',
    description: '字节跳动火山引擎豆包大模型（OpenAI 兼容）'
  },
  minimax: {
    name: 'MiniMax',
    type: 'openai',
    apiUrl: 'https://api.minimax.chat/v1/text/chatcompletion_v2',
    apiKey: '',
    model: 'abab6.5s-chat',
    description: 'MiniMax 大模型（OpenAI 兼容）'
  },
  stepfun: {
    name: '阶跃星辰',
    type: 'openai',
    apiUrl: 'https://api.stepfun.com/v1/chat/completions',
    apiKey: '',
    model: 'step-1-8k',
    description: '阶跃星辰大模型（OpenAI 兼容）'
  }
};

function init(config) {
  aiConfig = config;
  statusCache = { initialized: true, timestamp: Date.now() };
}

function getStatus() {
  const localCount = aiConfig?.localModels?.length || 0;
  const cloudCount = aiConfig?.cloudProviders?.length || 0;

  // 若 activeProvider 未设置或已失效，自动解析到第一个已启用的提供商
  let activeProvider = aiConfig?.activeProvider || null;
  if (activeProvider) {
    const stillExists = aiConfig?.cloudProviders?.some(p => p.id === activeProvider && p.enabled);
    if (!stillExists) activeProvider = null;
  }
  if (!activeProvider && aiConfig?.cloudProviders) {
    const enabled = aiConfig.cloudProviders.find(p => p.enabled);
    if (enabled) activeProvider = enabled.id;
  }

  return {
    initialized: true,
    localModelsCount: localCount,
    cloudProvidersCount: cloudCount,
    activeProvider,
    temperature: aiConfig?.temperature || 0.7,
    maxTokens: aiConfig?.maxTokens || 2048,
    lastChecked: statusCache?.timestamp
  };
}

function getProviderPresets() {
  return PROVIDER_PRESETS;
}

// ==================== Ollama 支持 ====================

async function listOllamaModels(host = 'http://localhost:11434') {
  return new Promise((resolve) => {
    try {
      const url = new URL(host + '/api/tags');
      const client = url.protocol === 'https:' ? https : http;
      const req = client.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const models = (parsed.models || []).map(m => ({
              name: m.name,
              size: m.size,
              sizeFormatted: formatModelSize(m.size || 0),
              modifiedAt: m.modified_at,
              digest: m.digest
            }));
            resolve({ success: true, models, connected: true });
          } catch (e) {
            resolve({ success: false, error: '解析响应失败: ' + e.message, connected: true });
          }
        });
      });
      req.on('error', (err) => {
        resolve({ success: false, error: '无法连接到 Ollama: ' + err.message, connected: false });
      });
      req.setTimeout(5000, () => {
        req.destroy();
        resolve({ success: false, error: '连接超时（5秒），请确认 Ollama 服务正在运行', connected: false });
      });
    } catch (e) {
      resolve({ success: false, error: e.message, connected: false });
    }
  });
}

async function testOllamaConnection(host = 'http://localhost:11434') {
  return new Promise((resolve) => {
    try {
      const url = new URL(host + '/api/tags');
      const client = url.protocol === 'https:' ? https : http;
      const req = client.get(url, (res) => {
        resolve({ success: res.statusCode === 200, connected: res.statusCode === 200 });
      });
      req.on('error', () => {
        resolve({ success: false, connected: false });
      });
      req.setTimeout(3000, () => {
        req.destroy();
        resolve({ success: false, connected: false });
      });
    } catch (e) {
      resolve({ success: false, connected: false });
    }
  });
}


/**
 * 检测 Python 环境（用于 HF → GGUF 转换）
 */

/**
 * 检测所有工具状态
 */
async function testMirrorConnectivity(urls) {
  return ToolAutoInstall.testMirrorConnectivity(urls || []);
}

async function checkTools() {
  const dir = toolInstallDir || path.join(os.homedir(), '.ai-lobster', 'tools');
  return ToolAutoInstall.checkTools(dir);
}

/**
 * 下载指定工具（需用户已确认并选择目录）
 * tool: 'llama-server' | 'convert-script'
 */
async function downloadTool(tool, installDir, onProgress) {
  if (!installDir) throw new Error('未指定安装目录');
  fs.mkdirSync(installDir, { recursive: true });
  toolInstallDir = installDir;

  ToolAutoInstall.setProgressCallback((p) => { if (onProgress) onProgress(p); });

  if (tool === 'llama-server') {
    return await ToolAutoInstall.downloadLlamaServer(installDir, onProgress);
  } else if (tool === 'convert-script') {
    const p = await ToolAutoInstall.downloadConvertScript(installDir, onProgress);
    return { path: p };
  } else {
    throw new Error('未知工具: ' + tool);
  }
}
function detectPythonEnv() {
  return ToolAutoInstall.detectPython();
}

/**
 * 将 HuggingFace 模型目录转换为 GGUF
 * 返回 { success, ggufPath } 或 { success: false, error }
 */
async function convertLocalModelToGguf(modelId, onProgress) {
  const model = (aiConfig?.localModels || []).find(m => m.id === modelId);
  if (!model) return { success: false, error: '模型不存在' };

  const detected = LocalAiEngine.detectModelFormat(model.path);
  if (detected.runnable) {
    return { success: false, error: '该模型已经是 GGUF 格式，无需转换' };
  }
  if (detected.format !== 'huggingface' && detected.format !== 'safetensors') {
    return { success: false, error: '仅支持 HuggingFace (safetensors) 格式转换为 GGUF' };
  }

  const py = await ToolAutoInstall.detectPython();
  if (!py.available) {
    return { success: false, error: '未检测到 Python 3，无法自动转换。请安装 Python 3.10+ 和 torch/transformers 后重试。' };
  }
  if (!py.hasDeps) {
    return { success: false, error: 'Python 已安装但缺少 torch/transformers。请运行: pip install torch transformers sentencepiece protobuf' };
  }

  // 输出路径：模型同目录下的 .gguf 文件
  const modelDir = model.isDirectory ? model.path : path.dirname(model.path);
  const baseName = model.name || path.basename(modelDir);
  const ggufPath = path.join(modelDir, baseName + '.gguf');

  try {
    ToolAutoInstall.setProgressCallback((p) => {
      if (onProgress) onProgress(p);
    });
    const scriptDir = toolInstallDir || path.join(os.homedir(), '.ai-lobster', 'tools');
    await ToolAutoInstall.convertHfToGguf(modelDir, ggufPath, py.command, scriptDir, onProgress);

    // 验证 GGUF 文件确实生成且非空
    if (!fs.existsSync(ggufPath) || fs.statSync(ggufPath).size === 0) {
      return { success: false, error: '转换完成但输出文件不存在或为空: ' + ggufPath };
    }
    const ggufSize = fs.statSync(ggufPath).size;

    // 转换成功后，更新模型条目指向新的 GGUF 文件（path 也更新，避免目录检测混淆）
    model.path = ggufPath;
    model.entryPath = ggufPath;
    model.format = 'gguf';
    model.runnable = true;
    model.isDirectory = false;
    model.modelType = 'single';
    model.fileCount = 1;
    model.size = ggufSize;
    model.sizeFormatted = formatModelSize(ggufSize);
    model.convertedFrom = detected.format;
    model.description = '已从 ' + detected.format + ' 自动转换为 GGUF（' + formatModelSize(ggufSize) + '）';
    saveAIConfig();

    return { success: true, ggufPath, model };
  } catch (e) {
    return { success: false, error: '转换失败: ' + e.message };
  }
}
// ==================== 本地模型（文件） ====================

function listLocalModels() {
  // 老版本导入的条目没有 runnable 字段 → 按格式回填，界面才能正确提示"能不能本地跑"
  return (aiConfig?.localModels || []).map(m => ({
    ...m,
    runnable: m.runnable !== undefined ? m.runnable : LocalAiEngine.isRunnableFormat(m.format)
  }));
}

function importLocalModel({ path: modelPath, name, description }) {
  try {
    if (!modelPath || !fs.existsSync(modelPath)) {
      return { success: false, error: '模型文件不存在' };
    }

    const stat = fs.statSync(modelPath);
    const isDir = stat.isDirectory();

    // 单文件才校验扩展名；目录用 detectModelFormat 综合判断
    if (!isDir) {
      const ext = path.extname(modelPath).toLowerCase();
      const validExtensions = ['.gguf', '.ggml', '.bin', '.safetensors', '.onnx'];
      if (!validExtensions.includes(ext)) {
        return { success: false, error: '不支持的模型格式: ' + ext };
      }
    }

    // 统一检测格式（单文件 / 分片 GGUF / HuggingFace 目录 / 嵌套目录）
    const detected = LocalAiEngine.detectModelFormat(modelPath);
    const format = detected.format || (isDir ? 'directory' : path.extname(modelPath).toLowerCase().replace('.', ''));
    const runnable = detected.runnable !== undefined ? detected.runnable : LocalAiEngine.isRunnableFormat(format);
    const entryPath = detected.entryPath || modelPath;
    // 分片文件被识别为目录模型时，有效路径是目录而非文件
    const effectivePath = detected.isDirectory ? entryPath : modelPath;
    const effectiveIsDir = detected.isDirectory || isDir;


    // 计算总大小（目录递归统计）
    let totalSize = 0;
    if (effectiveIsDir) {
      const walk = (d) => {
        try {
          const entries = fs.readdirSync(d, { withFileTypes: true });
          for (const e of entries) {
            const fp = path.join(d, e.name);
            if (e.isFile()) { try { totalSize += fs.statSync(fp).size; } catch (_) {} }
            else if (e.isDirectory()) walk(fp);
          }
        } catch (_) {}
      };
      walk(effectivePath);
    } else {
      totalSize = stat.size;
    }

    if (!aiConfig.localModels) aiConfig.localModels = [];

    // 同一个文件/目录重复导入只更新元信息，不产生重复条目
    const resolved = path.resolve(effectivePath);
    const dup = aiConfig.localModels.find(m => path.resolve(m.path) === resolved);

    if (dup) {
      Object.assign(dup, { path: effectivePath, size: totalSize, sizeFormatted: formatModelSize(totalSize), runnable, format, entryPath, fileCount: detected.fileCount || 1, modelType: detected.modelType || 'single', isDirectory: !!detected.isDirectory });
      if (name) dup.name = name;
      if (detected.hint) dup.description = detected.hint;
      saveAIConfig();
      return {
        success: true,
        updated: true,
        data: dup,
        message: runnable ? ('该模型已在列表中，已更新信息' + (detected.hint ? '（' + detected.hint + '）' : '')) : '该模型已在列表中，但当前格式无法本地加载'
      };
    }

    const modelName = name || (effectiveIsDir ? path.basename(effectivePath) : path.basename(modelPath, path.extname(modelPath)));
    const modelInfo = {
      id: crypto.randomUUID(),
      name: modelName,
      path: effectivePath,
      entryPath: entryPath,
      size: totalSize,
      sizeFormatted: formatModelSize(totalSize),
      format,
      runnable,
      fileCount: detected.fileCount || 1,
      modelType: detected.modelType || 'single',
      isDirectory: !!detected.isDirectory,
      description: description || (detected.hint || ''),
      importedAt: new Date().toISOString()
    };

    aiConfig.localModels.push(modelInfo);
    saveAIConfig();

    return {
      success: true,
      data: modelInfo,
      ...(runnable ? {} : {
        warning: detected.hint || (format.toUpperCase() + ' 是训练/通用格式，本机没有能直接加载它的本地运行时。要本地跑请先转成 GGUF，或改用 Ollama。')
      })
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
/**
 * 让某个本地模型真正可用：把推理服务拉起来（或复用已在跑的），
 * 再注册成一个 OpenAI 兼容 provider 并设为当前模型。
 * 这是「导入后无法正常使用」的核心修复点。
 */
async function useLocalModel(modelId) {
  const model = (aiConfig?.localModels || []).find(m => m.id === modelId);
  if (!model) return { success: false, error: '模型不存在，请重新导入' };

  const engineCfg = aiConfig?.localEngine || {};
  const r = await LocalAiEngine.ensureRunning(model, { engineConfig: engineCfg });
  if (!r.success) return { success: false, error: r.error, hint: r.hint };

  if (!aiConfig.cloudProviders) aiConfig.cloudProviders = [];
  const apiUrl = String(r.base || ('http://127.0.0.1:' + r.port)).replace(/\/$/, '') + '/v1/chat/completions';

  let provider = aiConfig.cloudProviders.find(p => p.local && p.modelId === modelId);
  if (!provider) {
    provider = {
      id: 'local-' + crypto.randomUUID(),
      name: '本地模型 · ' + model.name,
      type: 'openai',
      apiKey: '',
      description: r.reused ? '本地推理（复用已在运行的服务）' : '本地推理（由 浮灵饰界 启动）',
      addedAt: new Date().toISOString(),
      enabled: true,
      local: true,
      modelId
    };
    aiConfig.cloudProviders.push(provider);
  }
  provider.apiUrl = apiUrl;
  provider.model = r.modelId || model.name;   // 用服务端真实上报的 model id，猜的名字会被上游拒绝
  provider.enabled = true;
  provider.lastStartedAt = new Date().toISOString();
  aiConfig.activeProvider = provider.id;
  saveAIConfig();

  return {
    success: true,
    provider,
    engine: { port: r.port, reused: r.reused, managed: r.managed, modelId: provider.model, loadMs: r.loadMs || 0 },
    message: (r.reused ? '已复用本机运行中的服务' : '本地服务已启动') + '，当前模型已切换为 ' + provider.model
  };
}

function stopLocalModel() {
  return LocalAiEngine.stop();
}

async function getLocalEngineStatus() {
  const st = LocalAiEngine.status();
  const providers = (aiConfig?.cloudProviders || []).filter(p => p.local);
  return { ...st, providers: providers.map(p => ({ id: p.id, name: p.name, apiUrl: p.apiUrl, model: p.model, modelId: p.modelId })) };
}

async function detectLocalEngine() {
  return LocalAiEngine.detect();
}

/**
 * 对话前确保本地服务在线：模型挂掉/重启后用户直接发消息也能自动拉起，
 * 而不是收到一句 ECONNREFUSED。只在 provider 标记为 local 时生效。
 */
async function ensureLocalProviderReady(provider, onStatus) {
  if (!provider || !provider.local || !provider.modelId) return { ok: true };
  const model = (aiConfig?.localModels || []).find(m => m.id === provider.modelId);
  if (!model) {
    return { ok: false, error: '本地模型已从列表移除，请在「AI模型配置」里重新选择模型' };
  }
  // 先看在用的端口是否还活着（最省事）
  const port = (() => {
    try { return Number(new URL(provider.apiUrl).port) || 0; } catch (e) { return 0; }
  })();
  if (port) {
    const p = await LocalAiEngine.probePort(port, 900);
    if (p.ready && p.openAiCompatible) return { ok: true, port };
  }
  console.log('[AI] 本地服务不可达，尝试自动拉起:', model.name);
  // 加载可能要几十秒：把进度透传给界面，别让用户对着"等待模型响应…"干等
  if (typeof onStatus === 'function') {
    try { onStatus('正在启动本地模型「' + model.name + '」（首次加载可能需要几十秒）…'); } catch (e) { /* 忽略 */ }
  }
  const r = await LocalAiEngine.ensureRunning(model, { engineConfig: aiConfig?.localEngine || {}, onStatus });
  if (!r.success) return { ok: false, error: r.error, hint: r.hint };
  const newUrl = String(r.base || ('http://127.0.0.1:' + r.port)).replace(/\/$/, '') + '/v1/chat/completions';
  if (provider.apiUrl !== newUrl) {
    provider.apiUrl = newUrl;
    saveAIConfig();
  }
  return { ok: true, port: r.port, restarted: true };
}

function deleteLocalModel(modelId) {
  try {
    if (!aiConfig.localModels) return { success: false, error: '模型不存在' };
    const index = aiConfig.localModels.findIndex(m => m.id === modelId);
    if (index === -1) return { success: false, error: '模型不存在' };

    aiConfig.localModels.splice(index, 1);
    saveAIConfig();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ==================== 云端提供商 ====================

function listCloudProviders() {
  return aiConfig?.cloudProviders || [];
}

function normalizeApiUrl(url) {
  if (!url) return url;
  let u = url.trim();
  if (u.startsWith('//')) u = 'https:' + u;
  if (!/^https?:\/\//i.test(u) && !u.startsWith('localhost') && !/^\d+\.\d+\.\d+\.\d+/.test(u)) {
    u = 'https://' + u;
  }
  return u;
}

function addCloudProvider({ name, apiUrl, apiKey, model, description, type = 'openai' }) {
  try {
    if (!name || !apiUrl) {
      return { success: false, error: '名称和API地址不能为空' };
    }
    apiUrl = normalizeApiUrl(apiUrl);

    const provider = {
      id: crypto.randomUUID(),
      name,
      type,
      apiUrl,
      apiKey: apiKey || '',
      model: model || 'gpt-4',
      description: description || '',
      addedAt: new Date().toISOString(),
      enabled: true
    };

    if (!aiConfig.cloudProviders) aiConfig.cloudProviders = [];
    aiConfig.cloudProviders.push(provider);
    saveAIConfig();

    return { success: true, data: provider };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function addProviderByPreset(presetKey, overrides = {}) {
  const preset = PROVIDER_PRESETS[presetKey];
  if (!preset) {
    return { success: false, error: '未知的预设类型' };
  }
  return addCloudProvider({ ...preset, ...overrides });
}

function updateCloudProvider({ id, ...updates }) {
  try {
    if (!aiConfig.cloudProviders) return { success: false, error: '提供商不存在' };
    const index = aiConfig.cloudProviders.findIndex(p => p.id === id);
    if (index === -1) return { success: false, error: '提供商不存在' };

    if (updates.apiUrl) updates.apiUrl = normalizeApiUrl(updates.apiUrl);
    aiConfig.cloudProviders[index] = { ...aiConfig.cloudProviders[index], ...updates };
    saveAIConfig();
    return { success: true, data: aiConfig.cloudProviders[index] };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function deleteCloudProvider(id) {
  try {
    if (!aiConfig.cloudProviders) return { success: false, error: '提供商不存在' };
    const index = aiConfig.cloudProviders.findIndex(p => p.id === id);
    if (index === -1) return { success: false, error: '提供商不存在' };

    aiConfig.cloudProviders.splice(index, 1);
    saveAIConfig();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/** 对话入口统一用这个：本地 provider 未就绪就自动拉起，失败则返回可读错误（含操作建议） */
async function prepareLocalProvider(provider, onStatus) {
  const r = await ensureLocalProviderReady(provider, onStatus);
  if (r.ok) return null;
  return { success: false, error: r.error + (r.hint ? '\n' + r.hint : '') };
}

// ==================== 对话 ====================

async function chat({ messages, providerId, temperature, maxTokens, systemPrompt, silent, workdir, thinkMode }, broadcastFn) {
  const provider = findProvider(providerId);
  if (!provider) {
    return { success: false, error: '未找到AI提供商' };
  }
  cancelOllamaUnload();
  localRequestInFlight = true;
  const notReady = await prepareLocalProvider(provider);
    if (notReady) { localRequestInFlight = false; return notReady; }

  const temp = temperature ?? aiConfig?.temperature ?? 0.7;
  // 思考模式需要额外的输出预算：思考和正文共用 max_tokens，
  // 按非思考模式的额度发请求会把额度全花在思考上、正文输出为空。
  const tokens = maxTokens ?? (thinkMode === true
    ? Math.max(aiConfig?.maxTokens ?? 2048, 8192)
    : (aiConfig?.maxTokens ?? 2048));
  // 系统提示词：用户在「功能设置 → 个性化」里改的那份优先（2026-10-03 从 AI 配置页搬过来）
  const pConfig = getPersonalization();
  let systemPromptFinal = systemPrompt || pConfig.systemPrompt || aiConfig?.systemPrompt || '';
  const personaBlock = buildPersonalizationBlock();
  if (personaBlock) systemPromptFinal += (systemPromptFinal ? '\n\n' : '') + personaBlock;
  if (workdir) {
    systemPromptFinal += '\n\n## 当前项目工作目录\n- 你当前的工作目录（项目根）是：' + workdir + '\n- 所有相对路径都基于此目录解析；执行命令时也默认在此目录下运行。\n- 除非用户明确要求操作其他位置，否则不要把文件写到该目录之外。';
  }

  const formattedMessages = [];
  if (systemPromptFinal) {
    formattedMessages.push({ role: 'system', content: systemPromptFinal });
  }
  // 前端历史里 role 是 'ai'，各家 API 只认 'assistant'：不归一化会直接被上游 400 拒绝
  formattedMessages.push(...normalizeAgentMessages(messages));

  try {
    const result = await callProviderAPI(provider, formattedMessages, temp, tokens, false, null, thinkMode === true);

    // silent（如动作编辑器的 AI 调试）：不把结果作为聊天消息广播到聊天窗口
    if (broadcastFn && result.success && !silent) {
      broadcastFn('ai:response', {
        type: 'complete',
        content: result.content,
        reasoning: result.reasoning || '',
        usage: result.data?.usage,
        providerId: provider.id
      });
      broadcastFn('ai:provider-sync', { activeProvider: provider.id });
    }

    return { ...result, providerId: provider.id };
  } catch (error) {
    return { success: false, error: error.message };
  } finally {
    // 确保请求被销毁，释放网络和GPU资源
    try { if (activeReq) { activeReq.destroy(); activeReq = null; } } catch(e) {}
    // 主动卸载 Ollama 模型，释放 GPU 显存
    if (provider && provider.type === 'ollama') unloadOllamaModel(provider);
    // 本地模型空闲超时后自动释放显存
    localRequestInFlight = false;
    if (provider && provider.local) scheduleLocalModelUnload();
  }
}

async function streamChat({ messages, providerId, temperature, maxTokens, systemPrompt, workdir, thinkMode }, broadcastFn) {
  chatCancelled = false;
  const provider = findProvider(providerId);
  if (!provider) {
    return { success: false, error: '未找到AI提供商' };
  }
  cancelLocalModelUnload();
  cancelOllamaUnload();
  localRequestInFlight = true;
  const notReady = await prepareLocalProvider(provider);
    if (notReady) { localRequestInFlight = false; return notReady; }

  const temp = temperature ?? aiConfig?.temperature ?? 0.7;
  // 与 chat() 一致：思考模式要多留输出预算，否则思考吃满额度、正文为空
  const tokens = maxTokens ?? (thinkMode === true
    ? Math.max(aiConfig?.maxTokens ?? 2048, 8192)
    : (aiConfig?.maxTokens ?? 2048));
  // 系统提示词：用户在「功能设置 → 个性化」里改的那份优先（2026-10-03 从 AI 配置页搬过来）
  const pConfig = getPersonalization();
  let systemPromptFinal = systemPrompt || pConfig.systemPrompt || aiConfig?.systemPrompt || '';
  const personaBlock = buildPersonalizationBlock();
  if (personaBlock) systemPromptFinal += (systemPromptFinal ? '\n\n' : '') + personaBlock;
  if (workdir) {
    systemPromptFinal += '\n\n## 当前项目工作目录\n- 你当前的工作目录（项目根）是：' + workdir + '\n- 所有相对路径都基于此目录解析；执行命令时也默认在此目录下运行。\n- 除非用户明确要求操作其他位置，否则不要把文件写到该目录之外。';
  }

  const formattedMessages = [];
  if (systemPromptFinal) {
    formattedMessages.push({ role: 'system', content: systemPromptFinal });
  }
  // 同 chat()：role 'ai' 必须归一化为 'assistant'，否则上游 400
  formattedMessages.push(...normalizeAgentMessages(messages));

  try {
    let streamReasoningText = '';
    const result = await callProviderAPI(provider, formattedMessages, temp, tokens, true, (delta) => {
      if (chatCancelled) return;
      if (broadcastFn) {
        // 兼容旧格式：delta 可能是字符串或对象 { type, content }
        if (typeof delta === 'string') {
          broadcastFn('ai:response', {
            type: 'stream-chunk',
            content: delta
          });
        } else if (delta && delta.type === 'reasoning') {
          // 思考过程：独立事件流式推送，渲染端放可折叠思考区实时滚动。
          // 不再混进正文气泡（此前用 ▼/▲ 标记拼进正文 = 思考与回答写在一起）
          streamReasoningText += delta.content || '';
          broadcastFn('ai:response', {
            type: 'stream-reasoning',
            content: delta.content || ''
          });
        } else if (delta && delta.type === 'content') {
          // 正式回答
          broadcastFn('ai:response', {
            type: 'stream-chunk',
            content: delta.content
          });
        }
      }
    }, thinkMode === true);

    if (broadcastFn && result.success) {
      // 流式结束但正文为空：混合思考模型偶尔把额度全花在思考上、正文一个字没吐。
      // 这时从思考尾部兜底捞一段当正文，否则用户看到的是"想半天什么都没说"。
      let finalContent = result.content;
      if (!String(finalContent || '').trim() && streamReasoningText.trim().length > 50) {
        const parts = streamReasoningText.split(/\n+/).filter(s => s.trim().length > 10);
        if (parts.length) {
          finalContent = parts[parts.length - 1].trim();
          console.log('[Chat] 正文为空，从思考末尾兜底提取回答(' + finalContent.length + '字符)');
          broadcastFn('ai:response', { type: 'stream-chunk', content: finalContent });
        }
      }
      broadcastFn('ai:response', {
        type: 'stream-complete',
        fullContent: finalContent,
        reasoning: streamReasoningText,
        usage: result.data?.usage
      });
      broadcastFn('ai:provider-sync', { activeProvider: provider.id });
      // 记录一条「近期动向」（普通对话也记，供 AI 进化训练）
      recordEvolution({
        mode: 'chat',
        user: getLastUserMessage(messages),
        project: workdir || '',
        tools: [],
        summary: (finalContent || '').slice(0, 200)
      });
    }

    // 主动卸载 Ollama 模型，释放 GPU 显存
    if (provider.type === 'ollama') unloadOllamaModel(provider);
    localRequestInFlight = false;
    if (provider.local) scheduleLocalModelUnload();
    return { ...result, providerId: provider.id };
  } catch (error) {
    if (provider.type === 'ollama') unloadOllamaModel(provider);
    localRequestInFlight = false;
    if (provider.local) scheduleLocalModelUnload();
    return { success: false, error: error.message };
  }
}

function findProvider(providerId) {
  if (!aiConfig?.cloudProviders) return null;
  if (providerId) {
    const p = aiConfig.cloudProviders.find(p => p.id === providerId && p.enabled);
    if (p) return p;
  }
  if (aiConfig.activeProvider) {
    const p = aiConfig.cloudProviders.find(p => p.id === aiConfig.activeProvider && p.enabled);
    if (p) return p;
  }
  // Fallback: use first enabled provider and sync activeProvider
  const fallback = aiConfig.cloudProviders.find(p => p.enabled);
  if (fallback && fallback.id !== aiConfig.activeProvider) {
    aiConfig.activeProvider = fallback.id;
    saveAIConfig();
  }
  return fallback;
}

// 统一调用入口，根据 type 分发
async function callProviderAPI(provider, messages, temperature, maxTokens, stream = false, onStreamChunk = null, thinkMode = false) {
  const type = provider.type || 'openai';
  // 发送前统一消毒：非字符串 content、半截工具参数、孤立代理项都会让上游直接 400
  const safeMessages = sanitizeOutgoingMessages(messages, type === 'ollama');
  if (type === 'ollama') {
    return callOllamaAPI(provider, safeMessages, temperature, maxTokens, stream, onStreamChunk, thinkMode);
  }
  return callOpenAICompatibleAPI(provider, safeMessages, temperature, maxTokens, stream, onStreamChunk, thinkMode);
}

// Ollama API（不同的请求格式和流式格式）
function callOllamaAPI(provider, messages, temperature, maxTokens, stream = false, onStreamChunk = null, thinkMode = false) {
  return new Promise((resolve) => {
    const baseUrl = provider.apiUrl.replace(/\/$/, '');
    const url = new URL(baseUrl + '/api/chat');
    const client = url.protocol === 'https:' ? https : http;

    const body = JSON.stringify({
      model: provider.model,
      messages,
      stream,
      // 思考开关必须显式下发：Ollama 的混合思考模型（如 qwen3）在 think 缺省时行为随版本变化，
      // 不下发就是"由服务端决定" → 非思考模式下仍在思考 → 思考吃满 num_predict → 正文为空。
      think: !!thinkMode,
      keep_alive: 0,  // 响应完成后立即从GPU显存卸载模型，避免长时间占用导致卡顿
      options: {
        temperature,
        num_predict: maxTokens
      }
    });

    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname.replace(/\/$/, '') + (url.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = client.request(options, (res) => {
      activeReq = req;
      let data = '';
      let fullContent = '';

      if (stream) {
        // Ollama 流式：每行一个 JSON 对象 { message: { content }, done }
        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop(); // 保留最后不完整的一行
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line);
              // 思考过程（think:true 时 Ollama 放在 message.reasoning/thinking）单独转发，不混进正文
              const rDelta = parsed.message?.reasoning || parsed.message?.thinking || parsed.reasoning || parsed.thinking || '';
              if (rDelta && onStreamChunk) onStreamChunk({ type: 'reasoning', content: rDelta });
              const delta = parsed.message?.content || '';
              if (delta) {
                fullContent += delta;
                if (onStreamChunk) onStreamChunk(delta);
              }
            } catch (e) {}
          }
        });

        res.on('end', () => {
          // 处理缓冲区中剩余内容
          if (buffer.trim()) {
            try {
              const parsed = JSON.parse(buffer);
              const rDelta = parsed.message?.reasoning || parsed.message?.thinking || parsed.reasoning || parsed.thinking || '';
              if (rDelta && onStreamChunk) onStreamChunk({ type: 'reasoning', content: rDelta });
              const delta = parsed.message?.content || '';
              if (delta) {
                fullContent += delta;
                if (onStreamChunk) onStreamChunk(delta);
              }
            } catch (e) {}
          }
          resolve({
            success: res.statusCode >= 200 && res.statusCode < 300,
            content: fullContent,
            data: {},
            statusCode: res.statusCode
          });
        });
      } else {
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          // 非 2xx：把错误体转成可读信息（Ollama 常见为纯文本或 JSON）
          if (res.statusCode < 200 || res.statusCode >= 300) {
            let errorMsg = data || ('HTTP ' + res.statusCode);
            try {
              const parsed = JSON.parse(data);
              errorMsg = (parsed.error && (parsed.error.message || parsed.error.code)) || parsed.error || parsed.message || data;
            } catch (_) { /* 保留原始文本 */ }
            if (typeof errorMsg !== 'string') errorMsg = JSON.stringify(errorMsg);
            resolve({
              success: false,
              error: 'Ollama 接口返回 ' + res.statusCode + (errorMsg ? '：' + errorMsg : ''),
              data,
              statusCode: res.statusCode
            });
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const content = parsed.message?.content || '';
            resolve({ success: true, content, data: parsed, statusCode: res.statusCode });
          } catch (e) {
            resolve({ success: true, content: '', data, statusCode: res.statusCode });
          }
        });
      }
    });

    req.on('error', (err) => {
      resolve({ success: false, error: 'Ollama 连接失败: ' + err.message + '（请确认 Ollama 服务已启动）' });
    });

    req.setTimeout(120000, () => {
      req.destroy();
      resolve({ success: false, error: 'Ollama 请求超时' });
    });

    safeWriteRequest(req, body, (e) => resolve({ success: false, error: 'Ollama 请求发送失败: ' + e.message }));
  });
}

// OpenAI 兼容 API（支持 OpenAI、DashScope 百炼、DeepSeek 等）
function callOpenAICompatibleAPI(provider, messages, temperature, maxTokens, stream = false, onStreamChunk = null, thinkMode = false) {
  return new Promise((resolve) => {
    const apiUrl = normalizeApiUrl(provider.apiUrl);
    const url = new URL(apiUrl);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    const bodyObj = {
      model: provider.model,
      messages,
      temperature,
      stream
    };
    if (maxTokens) bodyObj.max_tokens = maxTokens;
    // 流式请求时要求返回 usage，否则 token 统计缺失
    if (stream && supportsStreamOptions(provider)) bodyObj.stream_options = { include_usage: true };
    // 思考开关跟着用户的「思考模式」走：本地模型（Qwen3 等）要 chat_template_kwargs.enable_thinking，
    // 云端按各家协议下发。之前这里写死 true，等于无视开关恒开思考 —— 思考吃满 max_tokens 后正文为空。
    const thinkParams = thinkingParams(provider, thinkMode);
    if (Object.keys(thinkParams).length) Object.assign(bodyObj, thinkParams);
    const body = JSON.stringify(bodyObj);

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    };
    // Ollama 无需 Authorization 头
    if (provider.apiKey) {
      headers['Authorization'] = `Bearer ${provider.apiKey}`;
    }

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname.replace(/\/$/, '') + (url.search || ''),
      method: 'POST',
      headers
    };

    const req = client.request(options, (res) => {
      activeReq = req;
      let data = '';
      let fullContent = '';
      let isStream = stream && (res.headers['content-type']?.includes('text/event-stream'));
      let streamUsage = null;

      if (isStream) {
        // content 里可能混着内联思考（本地 llama.cpp --reasoning-format none 时），
        // 与 Agent 链路同款：用 createInlineThinkSplitter 拆成独立思考流，不进正文
        const thinkSplitter = createInlineThinkSplitter();
        res.on('data', (chunk) => {
          const lines = chunk.toString().split('\n').filter(l => l.trim());
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const jsonStr = line.slice(6);
              if (jsonStr === '[DONE]') continue;
              try {
                const parsed = JSON.parse(jsonStr);
                // 提取 usage 信息（通常在最后一条消息中）
                if (parsed.usage) {
                  streamUsage = parsed.usage;
                } else if (parsed.x_gigacontext?.token_usage) {
                  // 智谱等平台在 x_gigacontext 中返回
                  streamUsage = parsed.x_gigacontext.token_usage;
                }
                const delta = parsed.choices?.[0]?.delta || {};
                const contentDelta = delta.content || '';
                const reasoningDelta = delta.reasoning_content || '';
                if (contentDelta) {
                  const split = thinkSplitter.push(contentDelta);
                  if (split.reasoning) {
                    if (onStreamChunk) onStreamChunk({ type: 'reasoning', content: split.reasoning });
                  }
                  if (split.content) {
                    fullContent += split.content;
                    if (onStreamChunk) onStreamChunk({ type: 'content', content: split.content });
                  }
                }
                if (reasoningDelta) {
                  if (onStreamChunk) onStreamChunk({ type: 'reasoning', content: reasoningDelta });
                }
              } catch (e) {}
            }
          }
        });

        res.on('end', () => {
          resolve({
            success: res.statusCode >= 200 && res.statusCode < 300,
            content: fullContent,
            data: streamUsage ? { usage: streamUsage } : {},
            statusCode: res.statusCode
          });
        });
      } else {
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          // 非 2xx：把服务端返回的错误体转成可读信息，避免"调用无效果且无原因"（如 tokenhub 401/400）
          if (res.statusCode < 200 || res.statusCode >= 300) {
            let err = simplifyApiError(res.statusCode, data);
            if (res.statusCode === 404) err += '（请检查 API 地址是否以 /chat/completions 结尾）';
            resolve({ success: false, error: err, statusCode: res.statusCode });
            return;
          }
          try {
            const parsed = JSON.parse(data);
            let content = parsed.choices?.[0]?.message?.content
              || parsed.output?.choices?.[0]?.message?.content
              || parsed.choices?.[0]?.delta?.content
              || parsed.output?.text
              || '';
            // 思考内容单独放 reasoning 字段，不再往正文里塞 "▼ 思考过程…" 前缀。
            // 旧做法会让非思考模式下的回答变成一大段思考前言（用户看到的"回答异常"）。
            const reasoning = parsed.choices?.[0]?.message?.reasoning_content
              || parsed.choices?.[0]?.message?.reasoning
              || '';
            if (!content && reasoning) {
              // 有些混合模型把回答写在 reasoning 里、正文留空 → 兜底取 reasoning 尾部当正文
              const parts = String(reasoning).split(/\n+/).filter(s => s.trim().length > 10);
              if (parts.length) content = parts[parts.length - 1].trim();
            }
            if (!content && (parsed.error || parsed.code || parsed.message)) {
              const errMsg = parsed.error?.message || parsed.error || parsed.message || parsed.code || 'api error';
              resolve({ success: false, error: typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg), data: parsed, statusCode: res.statusCode });
              return;
            }
            if (!content) {
              const snippet = data.slice(0, 500);
              resolve({ success: false, error: 'empty response (HTTP ' + res.statusCode + '): ' + snippet, data: parsed, statusCode: res.statusCode });
              return;
            }
            resolve({ success: true, content, reasoning, data: parsed, statusCode: res.statusCode });
          } catch (e) {
            resolve({ success: false, error: 'parse failed: ' + e.message + ', raw: ' + data.slice(0, 300), data, statusCode: res.statusCode });
          }
        });
      }
    });

    req.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });

    req.setTimeout(120000, () => {
      req.destroy();
      resolve({ success: false, error: '请求超时' });
    });

    safeWriteRequest(req, body, (e) => resolve({ success: false, error: '请求发送失败: ' + e.message }));
  });
}

// ========== Agent 引擎：工具调用 + 思考过程 + 多轮执行 ==========

// 工具定义（OpenAI function calling 格式）
const AGENT_TOOLS = _agentCfg.tools || [];

// MCP 工具缓存：每次 agent 请求前调_mcp.collectTools() 刷新。
// 为什么用缓存而不是每次现取：collectTools 要走 IPC 到子进程，
// 每个 token 轮次都调一遍会让整轮对话慢一个数量级。
// ⚠️ 必须带 revision：服务器被停掉后工具表就变了，但 TTL 还没到，
//    不看 revision 会把已停掉的工具继续发给模型 → 模型反复调用一个不存在的服务。
let _mcpToolCache = { at: 0, revision: -1, tools: [] };
const _MCP_TOOL_TTL = 5000;   // 5 秒

/**
 * 全部可用工具 = 内置 33 个 + 已启用的 MCP 工具。
 * 命中「TTL 未到且 revision 未变」时直接返回缓存。
 */
async function getAllTools() {
  const now = Date.now();
  const rev = _mcp.revision();
  if (now - _mcpToolCache.at < _MCP_TOOL_TTL && _mcpToolCache.revision === rev) {
    return AGENT_TOOLS.concat(_mcpToolCache.tools);
  }
  let mcpTools = [];
  try {
    mcpTools = await _mcp.collectTools();
  } catch (e) {
    console.warn('[MCP] 收集工具失败（不影响内置工具）:', e.message);
  }
  _mcpToolCache = { at: now, revision: _mcp.revision(), tools: mcpTools };
  return AGENT_TOOLS.concat(mcpTools);
}

/** 强制让缓存失效（启停 MCP server / 切换启用集合后调用） */
function invalidateMcpTools() {
  _mcpToolCache = { at: 0, revision: -1, tools: [] };
}

/** MCP 工具名列表（用于权限判定：会话模式必须拦住） */
function getMcpToolNames() {
  return _mcpToolCache.tools.map(t => t.function.name);
}

/** 工具中文名映射（用于界面显示，避免暴露英文命令名）
 *  MCP 工具的展示名优先用 mcp-servers.yaml 里每个 server 声明的 toolLabels，
 *  没登记的退化成「MCP 工具」—— 依旧不露原始英文名。 */
const TOOL_LABELS_CN = _agentCfg.toolLabels || {};
// 兜底用中文占位而不是回退原名 —— 未登记的工具也不许把内部函数名露给用户。
function toolLabelCN(name) {
  if (TOOL_LABELS_CN[name]) return TOOL_LABELS_CN[name];
  if (typeof name === 'string' && name.startsWith('mcp_')) {
    // 归属靠 manager 的 toolIndex 精确查（mcp_echo 这种名字里没有 serverId 分隔符，
    // 靠字符串猜前缀是不可靠的 —— 那次就猜错了）
    const serverId = _mcp.ownerOf(name);
    if (serverId) {
      const def = _mcp.getServerDef(serverId);
      const map = (def && def.toolLabels) || {};
      // toolIndex 里存了「原始工具名」，用它去 yaml 的映射表里精确匹配
      const entry = _mcp._state.toolIndex.get(name);
      if (entry && entry.toolName && map[entry.toolName]) return map[entry.toolName];
      // server 名总比"工具调用"具体
      if (def && (def.name || def.id)) return 'MCP · ' + (def.name || def.id);
    }
    return 'MCP 工具';
  }
  return '工具';
}

// 模型点名了工具、但被权限拦下时给用户的说明：说清「想做什么 / 为什么没做 / 去哪放开」。
// 以前这种情况会退化成空回答，或一句"请在设置中开启思考模式"——两者都和真实原因无关。
function buildBlockedToolHint(name, reason) {
  const label = toolLabelCN(name);
  // 脱敏：只说中文工具名，不夹带 '（' + name + '）' 这类内部函数名
  if (reason === 'conversation') {
    return '我需要调用「' + label + '」来完成这个操作，但当前是「会话模式」，该工具被限制。'
      + '请切换到「工作模式」（打开工具开关）后重试。';
  }
  return '我需要调用「' + label + '」来完成这个操作，但它不在当前角色的可用工具范围内。'
    + '请在「角色设置 → 可用工具」里勾选它，或切换到默认角色后重试。';
}

/**
 * 从模型思考末尾提炼一句「下一步要做什么」的自然语言说明（工具执行前补发给用户看）。
 * 思考模式下模型常把「先定位…/再查看…」写进 reasoning、正文留空；直接执行工具时
 * 用户只能看到折叠的「思考结束」+工具卡片，看不到理由。这里从末尾取一段像「人话」的
 * 叙述，过滤掉工具名/参数/JSON/纯符号等机器痕迹，并把内部工具英文名换成中文。
 * @param {string} reasoning 本轮思考文本
 * @param {string[]} [toolNames] 可用工具英文名，用于替换成中文展示名
 * @returns {string} 提炼出的一句话（无则空串）
 */
function extractNextStepNotice(reasoning, toolNames) {
  if (!reasoning) return '';
  let text = String(reasoning);
  if (Array.isArray(toolNames)) {
    for (const n of toolNames) {
      try {
        const cn = toolLabelCN(n);
        if (cn && cn !== n) text = text.split(n).join(cn);
      } catch (e) { /* 单个替换失败不影响整体 */ }
    }
  }
  const lines = text.split(/\r?\n+/).map(s => s.trim()).filter(Boolean);
  const badRe = /^(run_shell|write_file|read_file|web_search|web_fetch|file_search|directory_list|tool_calls|arguments|命令|参数|调用|正在执行)[：: ]/i;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.length < 6 || l.length > 150) continue;
    if (/^[\[{("']/.test(l) || /^[0-9]{1,3}[.、.)]/.test(l)) continue;
    if (badRe.test(l)) continue;
    return l.replace(/^[*\-\s>]+/, '').replace(/[。；;,.]+$/, '').trim();
  }
  return '';
}

// Agent 系统提示词

// ==================== 多角色智能体管理 ====================
// 预设角色模板：每个角色有独立的系统提示词、工具权限、温度等配置
const PRESET_AGENT_ROLES = _agentCfg.presetRoles || [];

// 自定义角色存储路径
function getCustomRolesPath() {
  const dataDir = path.join(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, 'agent_roles.json');
}

// 加载自定义角色
function loadCustomRoles() {
  try {
    const p = getCustomRolesPath();
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      return Array.isArray(data) ? data : [];
    }
  } catch (e) { console.log('[AgentRoles] 加载自定义角色失败:', e.message); }
  return [];
}

// 保存自定义角色
function saveCustomRoles(roles) {
  try {
    fs.writeFileSync(getCustomRolesPath(), JSON.stringify(roles, null, 2), 'utf8');
    return true;
  } catch (e) { console.log('[AgentRoles] 保存自定义角色失败:', e.message); return false; }
}

// 获取所有角色（预设 + 自定义）
function getAgentRoles() {
  const custom = loadCustomRoles();
  return [...PRESET_AGENT_ROLES, ...custom];
}

// 根据 ID 获取角色
function getAgentRoleById(roleId) {
  if (!roleId) return PRESET_AGENT_ROLES[0]; // 默认通用助手
  return getAgentRoles().find(r => r.id === roleId) || PRESET_AGENT_ROLES[0];
}

// 保存/更新角色（自定义角色）
function saveAgentRole(role) {
  if (!role || !role.id || !role.name) return { success: false, error: '角色ID和名称不能为空' };
  const custom = loadCustomRoles();
  const idx = custom.findIndex(r => r.id === role.id);
  const roleData = { ...role, isPreset: false };
  if (idx >= 0) custom[idx] = roleData; else custom.push(roleData);
  saveCustomRoles(custom);
  return { success: true, role: roleData };
}

// 删除自定义角色
function deleteAgentRole(roleId) {
  const preset = PRESET_AGENT_ROLES.find(r => r.id === roleId);
  if (preset) return { success: false, error: '预设角色不能删除' };
  const custom = loadCustomRoles().filter(r => r.id !== roleId);
  saveCustomRoles(custom);
  return { success: true };
}


const AGENT_SYSTEM_PROMPT = _agentCfg.corePrompt || '';

// 供渲染进程动态渲染"启用工具"/"角色可用工具"列表，避免前端硬编码导致新工具永远不生效
function getAgentTools() {
  // 只返回有风险的工具给前端设置页面（无风险工具默认启用，不需要用户配置）
  const risky = AGENT_TOOLS
    .filter(t => RISKY_TOOLS.has(t.function.name))
    .map(t => ({
      name: t.function.name,
      description: t.function.description || '',
      parameters: t.function.parameters || null
    }));
  // MCP 工具**全部**返回：它们一律要用户在设置页显式勾选（外部进程默认不授权），
  // enabled 由 manager 的 toolIndex 精确给出，不靠字符串猜归属。
  const mcpEnabled = new Set(_mcp.getEnabled());
  const mcp = _mcpToolCache.tools.map(t => ({
    name: t.function.name,
    description: t.function.description || '',
    parameters: t.function.parameters || null,
    isMcp: true,
    serverId: _mcp.ownerOf(t.function.name) || '',
    enabled: mcpEnabled.has(_mcp.ownerOf(t.function.name))
  }));
  return risky.concat(mcp);
}

// 粗略 token 估算（CJK 1 字符 ≈ 1 token，其他字符按 transform.yaml 的 nonCjkRatio 折算）
// 系数外置到 transform.yaml：主进程与渲染层必须用同一个值，否则前端容量条会和后端真实
// prompt_tokens 打架（历史上就是因为两边各写一份 0.26，改一边就漂了）。
function approxTokens(str) {
  const s = typeof str === 'string' ? str : JSON.stringify(str || '');
  if (!s) return 0;
  const te = (_agentCfg.transform && _agentCfg.transform.tokenEstimate) || {};
  const ratio = typeof te.nonCjkRatio === 'number' ? te.nonCjkRatio : 0.26;
  let cjk = 0;
  try {
    const re = new RegExp(te.cjkPattern || '[\\u2E80-\\u9FFF\\uF900-\\uFAFF\\uAC00-\\uD7AF\\uFF00-\\uFFEF]', 'g');
    cjk = (s.match(re) || []).length;
  } catch (e) {
    cjk = (s.match(/[\u2E80-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF\uFF00-\uFFEF]/g) || []).length;
  }
  return Math.ceil(cjk + (s.length - cjk) * ratio);
}

// 供渲染进程估算"上下文占用"：工具定义 + 系统提示词的真实开销（这部分前端拿不到原文）
// transform 一并下发：渲染层的截断预算 / 上下文水位常量全部改从这份配置读，
// 避免同一个数字在三个文件里各写一份。
function getContextMeta() {
  const t = _agentCfg.transform || {};
  const all = AGENT_TOOLS.concat(_mcpToolCache.tools);
  return {
    toolCount: all.length,
    builtinToolCount: AGENT_TOOLS.length,
    mcpToolCount: _mcpToolCache.tools.length,
    toolsTokens: approxTokens(JSON.stringify(all)),
    systemPromptTokens: approxTokens(AGENT_SYSTEM_PROMPT || ''),
    toolNames: all.map(t2 => t2.function.name),
    transform: {
      tokenEstimate: t.tokenEstimate,
      budget: t.budget,
      context: t.context,
      agentOverhead: t.agentOverhead
    }
  };
}


/**
 * 判断模型在思考里提到某工具的那句话**是不是真意图**，返回意图强度分（0 = 不是意图）。
 *
 * 背景：模型做排除推理时会提到一堆它**不打算调用**的工具，例如
 *   "要确保没有其他工具被错误调用，比如 launch_in_clone 或 launch_project"
 *   "如果用户之后有启动程序的需求，应该使用 launch_in_clone 命令"
 * 这些句子里工具名照样出现，但按名字匹配就会误调（launch_in_clone 带 required，
 * 误调会真的去启动程序）。所以必须看**这个词周围那句话的语气**。
 *
 * 规则（就近取工具名前后各 60 字作为句子窗口）：
 *   - 命中排除/假设语气 → 直接判 0（"确保没有其他工具"、"比如"、"如果"、"如果之后"、
 *     "不需要"、"不必"、"而不是"、"不是"、"避免"、"不要"、"无需"、"暂时不"、"非"）
 *   - 命中强意图动词 → 高分（"我需要调用"、"只需要调用"、"直接调用"、"应该调用"、
 *     "要调用"、"让我调用"、"因此调用"、"于是调用"、"决定调用"、"我将调用"）
 *   - 命中普通意图动词 → 中低分（"调用"、"使用"、"执行"、"启动"、"打开"）
 *   - 两者都没有（只是列举/提及）→ 0，不采纳
 *
 * 多个工具名出现在同一句（"比如 A 或 B"）时整句都算排除语境。
 */
function intentScoreOfToolMention(reasoning, toolName) {
  if (!reasoning || !toolName) return 0;
  // 可能被模型写错后缀（如 launch_in_clone 被写成 launch_in_done），用共同前缀兜底匹配
  const idxs = [];
  let from = 0;
  while (true) {
    const i = reasoning.indexOf(toolName, from);
    if (i < 0) break;
    idxs.push(i);
    from = i + toolName.length;
  }
  if (!idxs.length) {
    // 退化匹配：取工具名的前 12 个字符（如 launch_in_clon），容忍模型拼写尾缀错误
    const stem = toolName.slice(0, Math.min(12, toolName.length));
    if (stem.length < 6) return 0;
    let f2 = 0;
    while (true) {
      const i = reasoning.indexOf(stem, f2);
      if (i < 0) break;
      idxs.push(i);
      f2 = i + stem.length;
    }
    if (!idxs.length) return 0;
  }

  let best = 0;
  for (const i of idxs) {
    // ---- 排除语气：紧贴工具名的子句 ----
    // 取工具名前最后一个句读之后的内容。必须回溯到**所在子句的开头**再判假设语气：
    //   "如果用户之后需要启动程序，应该使用 ensure_clone_desktop 命令"
    // 逗号前是"如果…"，只看逗号后就漏判了。所以拿到子句后，再向前扩到最近的强分句符
    // （。！？换行），把"如果…"一起纳入判断。
    const rawPre = reasoning.slice(Math.max(0, i - 60), i);
    const sentenceStart = Math.max(
      rawPre.lastIndexOf('。'), rawPre.lastIndexOf('！'), rawPre.lastIndexOf('？'),
      rawPre.lastIndexOf('\n'), rawPre.lastIndexOf('!'), rawPre.lastIndexOf('?')
    );
    const clause = sentenceStart >= 0 ? rawPre.slice(sentenceStart + 1) : rawPre;
    // 子句内再按最后一个逗号细分（"我需要调用"这部分权重最高）
    const cut = Math.max(clause.lastIndexOf('，'), clause.lastIndexOf('；'), clause.lastIndexOf(','), clause.lastIndexOf(';'));
    const pre = cut >= 0 ? clause.slice(cut + 1) : clause;
    const post = reasoning.slice(i + toolName.length, Math.min(reasoning.length, i + toolName.length + 30));

    // 子句级排除 → 这处提及不是意图
    if (/(确保|避免|防止|不要|不用|不需要|不必|无需|而不是|而非|不是|暂不|暂时不|比如|例如|诸如|其他工具|别的工具|其他命令)/.test(clause)) {
      continue;
    }
    // 假设语气（"如果…，应该用 X"）与真意图（"如果…，我需要调用 X"）的区别在于**逗号后的动词**：
    //   条件从句只是背景，真正决定意图的是主句动词。所以先按逗号切出主句再判。
    //   - 主句是"我需要调用/只需要调用/直接调用…" → 真意图（条件句只是前置背景）
    //   - 主句是"应该使用/可以用/或许用…" 且整句被"如果"引导 → 假设推演，判 0
    const headHasIf = /^\s*(如果|假如|倘若|若是)/.test(clause);
    if (headHasIf) {
      // "如果…" 开头：只有当逗号后主句是明确决心动词时才认，否则是假设
      const afterComma = pre;
      const decisive = /(我需要|我需要调用|需要调用|需要使用|只需要|只需|直接调用|我要|让我|决定)/.test(afterComma);
      const speculative = /(应该|应当|可以|或许|可能|试试|不妨)/.test(afterComma);
      if (!decisive || speculative) continue;
    }
    // 工具名后面紧跟"如果/比如/或 + 另一个工具名" → 列举或假设，不是意图
    if (/^\s*(如果|假如|倘若|若是|比如|例如|诸如)/.test(post)) continue;
    if (/^\s*(或|和|与|、|以及)\s*[a-z_]{4,}/i.test(post)) continue;

    // 意图动词：紧贴工具名的动词权重最高（"我需要调用X"），跨句的次之
    const preStrong = /(我需要调用|我需要使用|需要调用|需要使用|只需要调用|只需调用|直接调用|直接使用|应该调用|应当调用|要调用|我要调用|让我调用|决定调用|我将调用|我会调用|因此调用|于是调用|那就调用|便调用)\s*$/.test(pre);
    const preNormal = /(调用|使用|执行|启动|打开|拉起|运行)\s*$/.test(pre);
    const win = pre + toolName + post;
    const winStrong = /(我需要调用|我需要使用|只需要调用|只需调用|直接调用|应该调用|应当调用|我要调用|让我调用|决定调用|我将调用|我会调用|因此调用|于是调用|那就调用|便调用)/.test(win);
    const winNormal = /(调用|使用|执行|启动|打开|拉起|运行)/.test(win);

    let score = 0;
    if (preStrong) score = 100;
    else if (preNormal) score = 70;
    else if (winStrong) score = 60;
    else if (winNormal) score = 40;
    if (score === 0) continue;
    if (score > best) best = score;
  }
  return best;
}

// 从思考内容中提取工具调用意图（qwen3小模型常只在思考里描述不输出tool_calls，此函数手动提取并执行）
//
// 四级策略，从可靠到兜底：
//   ① 模型在思考里**点名了某个工具**（"直接调用 ensure_clone_desktop 即可"）——信号最强。
//      仅当该工具**没有必填参数**时才自动执行：有必填参数的工具缺参数必然执行失败，
//      宁可退回重试让模型自己把参数补全，也不要瞎跑一次错的。
//   ② web_search：从思考/提问里提取搜索关键词。
//   ③ web_fetch：从思考/提问里提取 URL。
//   ④ 其余复杂工具（write_file / run_shell 等）一律不自动提取，避免误执行。
function extractToolCallFromReasoning(reasoning, userMessage, toolDefs) {
  if (!reasoning) return null;
  const text = reasoning + ' ' + (userMessage || '');

  // ① 模型直接点名工具 → 无必填参数则直接执行（截图里的 ensure_clone_desktop 就走这里）
  //
  // ⚠️ 三条血泪教训，缺一个都会选错工具：
  //   1) 不能按 AGENT_TOOLS 定义顺序取第一个 —— 会选中模型最先提到、往往正是它要排除的那个。
  //   2) 不能按"最后出现的位置"取 —— 模型常在结尾写假设性排除句
  //      （"如果用户之后有启动程序的需求，应该使用 launch_in_clone…"），
  //      位置最靠后 ≠ 意图最强，会选中一句根本没打算执行的工具。
  //   3) 不能只要名字出现就采纳 —— "要确保没有其他工具被错误调用，比如 launch_in_clone"
  //      这种纯提及必须排除。
  // 正确判据是**句子的意图强度**：模型说"我需要调用X / 只需要调用X / 直接调用X"才是真意图；
  // "如果…应该用X / 不需要… / 确保没有其他工具被错误调用，比如X"是排除，一律不算。
  const defs = Array.isArray(toolDefs) ? toolDefs : [];
  const hits = [];
  for (const def of defs) {
    const name = def && def.function && def.function.name;
    // 只在 reasoning 里匹配：用户消息里出现工具名不代表模型决定调用它
    if (!name) continue;
    const score = intentScoreOfToolMention(reasoning, name);
    if (score <= 0) continue;
    const required = def.function.parameters && def.function.parameters.required;
    // 有必填参数的工具不在这里自动执行：缺参数必然失败（launch_in_clone 就属这类，
    // 误调会真的去启动程序）。它们的恢复交给下面的关键词/URL 提取或方案B 重试。
    if (Array.isArray(required) && required.length) continue;
    hits.push({ name, score, pos: reasoning.lastIndexOf(name) });
  }
  if (hits.length) {
    // 意图强度优先；强度相同再取更靠后出现的（更接近模型最终结论）
    hits.sort((a, b) => (b.score - a.score) || (b.pos - a.pos));
    console.log('[Agent] 从思考中识别到工具点名（无必填参数，直接执行）:', hits[0].name,
      '候选:', hits.map(h => h.name + '(强度' + h.score + ')').join(', '));
    return { name: hits[0].name, arguments: {} };
  }

  // web_search：提取搜索关键词
  if (/web_search|搜索|查找|查询|检索|搜一下/i.test(text)) {
    // 尝试提取引号中的关键词
    let query = null;
    // 引号要覆盖中文弯引号 “ ” ‘ ’ 和直角引号——模型最常把关键词用 “xxx” 包起来
    const quoteMatch = text.match(/[""「」『』“”“”‘’]([^""「」『』“”“”‘’]{2,50})[""「」『』“”“”‘’]/);
    if (quoteMatch) query = quoteMatch[1];
    // 尝试提取"搜索xxx"、"查询xxx"模式
    if (!query) {
      const searchMatch = text.match(/(?:搜索|查找|查询|检索|搜一下)[：: ]*([^\n，。；！]{2,50})/);
      if (searchMatch) query = searchMatch[1].trim();
    }
    // 尝试提取"关键词xxx"模式
    if (!query) {
      const kwMatch = text.match(/关键词[为是：: ]*([^\n，。；！]{2,50})/);
      if (kwMatch) query = kwMatch[1].trim();
    }
    if (query && query.length >= 2) {
      console.log('[Agent] 从思考中提取到 web_search 调用，query:', query);
      return { name: 'web_search', arguments: { query, max_results: 5 } };
    }
  }

  // web_fetch：提取URL
  if (/web_fetch|抓取|访问网页|打开链接|读取网页/i.test(text)) {
    const urlMatch = text.match(/https?:\/\/[^\s，。；！"')]+/);
    if (urlMatch) {
      console.log('[Agent] 从思考中提取到 web_fetch 调用，url:', urlMatch[0]);
      return { name: 'web_fetch', arguments: { url: urlMatch[0] } };
    }
  }

  return null; // 复杂工具（write_file/run_shell等）不自动提取，避免误执行
}

// ==================== 搜索引擎解析（web_search 用） ====================
const SEARCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function stripTags(s) {
  return String(s || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').trim();
}

function parseBingResults(html, max) {
  const out = [];
  const blocks = String(html || '').split(/<li class="b_algo/).slice(1);
  for (const b of blocks) {
    const m = b.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!m) continue;
    const url = String(m[1] || '').replace(/&amp;/g, '&');
    const title = stripTags(m[2]);
    if (!title || !/^https?:\/\//i.test(url)) continue;
    const sn = b.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = sn ? stripTags(sn[1]) : '';
    out.push({ title, url, snippet });
    if (out.length >= max) break;
  }
  return out;
}

function parseDuckDuckGoResults(html, max) {
  const out = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/g;
  let m;
  while ((m = re.exec(String(html || ''))) !== null && out.length < max) {
    const title = stripTags(m[2]);
    const url = String(m[1] || '').replace(/&amp;/g, '&');
    if (!title || !url) continue;
    out.push({ title, url, snippet: stripTags(m[3]) });
  }
  return out;
}

function parseSo360Results(html, max) {
  const out = [];
  const blocks = String(html || '').split(/<li class="res-list/).slice(1);
  for (const b of blocks) {
    const m = b.match(/<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!m) continue;
    let url = String(m[1] || '').replace(/&amp;/g, '&');
    const title = stripTags(m[2]);
    if (!title) continue;
    // 360 的跳转链接可能是 /link?url=xxx
    const enc = url.match(/[?&]url=([^&]+)/);
    if (enc) { try { url = decodeURIComponent(enc[1]); } catch (e) {} }
    if (!/^https?:\/\//i.test(url)) continue;
    const sn = b.match(/<p[^>]*class="res-desc"[^>]*>([\s\S]*?)<\/p>/i)
      || b.match(/<p[^>]*class="res-rich"[^>]*>([\s\S]*?)<\/p>/i)
      || b.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    out.push({ title, url, snippet: sn ? stripTags(sn[1]) : '' });
    if (out.length >= max) break;
  }
  return out;
}

// 多引擎搜索：逐个尝试，任一成功即返回（国内网络 DuckDuckGo 基本不可达，Bing 优先）
async function searchWeb(query, maxResults) {
  const q = encodeURIComponent(query || '');
  const engines = [
    { name: 'bing-cn', url: 'https://cn.bing.com/search?q=' + q, parse: parseBingResults },
    { name: 'bing', url: 'https://www.bing.com/search?q=' + q, parse: parseBingResults },
    { name: 'duckduckgo', url: 'https://html.duckduckgo.com/html/?q=' + q, parse: parseDuckDuckGoResults },
    { name: '360so', url: 'https://www.so.com/s?q=' + q, parse: parseSo360Results }
  ];
  const errors = [];
  for (const eng of engines) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const resp = await fetch(eng.url, {
        headers: { 'User-Agent': SEARCH_UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
        signal: controller.signal,
        redirect: 'follow'
      });
      clearTimeout(timer);
      const html = await resp.text();
      const results = eng.parse(html, maxResults);
      if (results.length > 0) {
        console.log('[web_search] 引擎 ' + eng.name + ' 命中 ' + results.length + ' 条');
        return { success: true, query, engine: eng.name, results, count: results.length };
      }
      errors.push(eng.name + ': 未解析到结果');
    } catch (e) {
      clearTimeout(timer);
      errors.push(eng.name + ': ' + (e && e.message ? e.message : String(e)));
    }
  }
  return { success: false, error: '搜索失败（已尝试 ' + engines.map(e => e.name).join(' / ') + '）：' + errors.join('；') };
}

// ==================== 长期记忆 / 视觉复核 的辅助实现 ====================

// 精简记忆条目再回给模型（去掉 createdAt 之类噪音，省 token）
function memoryBrief(it) {
  if (!it) return null;
  return {
    id: it.id,
    text: it.text,
    tags: it.tags || [],
    kind: it.kind,
    pinned: !!it.pinned,
    updatedAt: new Date(it.updatedAt || Date.now()).toLocaleString('zh-CN'),
    ...(Number.isFinite(it.score) ? { score: it.score } : {})
  };
}

// 最近一次截图路径：analyze_screenshot 不带 image_path 时复用
let lastScreenshotPath = null;

// 「当前被测程序」——launch_project 启动成功后记下来，让截图/验证默认指向「被测程序的窗口」
// 而不是本应用自己的窗口（这是「验证外部项目却总截到自己页面」的根因：capture_window 默认 which=main）。
// 结构：{ title, dir, at, url }；title 用 launcher 给的 windowTitleHint
// （网页项目 = 页面 <title>，浏览器窗口标题里就含它，截图才锁得准）。
let currentTestTarget = null;
const TEST_TARGET_TTL = 30 * 60 * 1000; // 30 分钟内视为有效，避免陈旧目标误导

/** launch_project 成功启动后登记被测程序。 */
function setTestTarget(info) {
  if (!info || !info.dir) return;
  const title = info.title || info.windowTitleHint || info.name || '';
  if (!title) return;
  currentTestTarget = { title: String(title), dir: info.dir, at: Date.now(), url: info.url || null };
}

/** 取当前被测程序的窗口标题（同一 workdir、未过期才有效）；没有则 null → 走原默认。 */
function resolveTestTargetTitle(workdir) {
  const t = currentTestTarget;
  if (!t || !t.title) return null;
  if (Date.now() - t.at > TEST_TARGET_TTL) return null;
  if (workdir && t.dir && path.resolve(t.dir) !== path.resolve(workdir)) return null; // 换项目了，别用旧目标
  return t.title;
}

// 常见提供商的视觉模型推断。
// ⚠️ 不能只匹配域名：很多人用的是中转 / 自建网关 / 反代，apiUrl 根本不是官方域名。
// 所以对「提供商名称 + apiUrl + 当前模型名」整串做匹配，顺序从具体到宽泛（openai 放最后兜底）。
const VISION_MODEL_HINTS = [
  [/dashscope|aliyuncs|百炼|通义|qwen/i, 'qwen-vl-max'],
  [/glm|智谱|bigmodel|chatglm/i, 'glm-4v-flash'],
  [/hunyuan|混元|tencent/i, 'hunyuan-vision'],
  [/ernie|qianfan|千帆|文心|baidubce/i, 'ernie-4.5-turbo-vl'],
  [/kimi|moonshot/i, 'moonshot-v1-8k-vision-preview'],
  [/volces|doubao|豆包|火山/i, 'doubao-1.5-vision-pro'],
  [/stepfun|阶跃/i, 'step-1v-8k'],
  [/gemini|generativelanguage|google/i, 'gemini-2.0-flash'],
  [/ollama|llava|localhost:11434|127\.0\.0\.1:11434/i, 'llava'],
  [/minimax|abab/i, 'abab6.5-vl'],
  [/openai|gpt|azure/i, 'gpt-4o']
];

/**
 * 解析用于「看图」的提供商与模型。
 * 优先级：入参指定 model > 提供商自带 visionModel > aiConfig.vision.model >
 *         aiConfig.vision.providerId 指定 > 当前激活提供商 + 模型名推断
 */
function resolveVisionTarget({ providerId, model } = {}) {
  const cfgVision = aiConfig?.vision || {};
  const p = findProvider(providerId || cfgVision.providerId) ||
            (providerId ? null : findProvider(null));
  if (!p) return { error: '当前没有已启用的 AI 提供商，无法看图' };

  let resolved = model || p.visionModel || cfgVision.model;
  if (!resolved) {
    const hay = (p.name || '') + ' ' + (p.apiUrl || '') + ' ' + (p.model || '');
    const hit = VISION_MODEL_HINTS.find(([re]) => re.test(hay));
    resolved = hit ? hit[1] : null;
  }
  if (!resolved) {
    return {
      error: '提供商「' + p.name + '」没有推断出视觉模型，请配置 aiConfig.vision = { providerId, model }，或在调用时显式传 model（如 qwen-vl-max / gpt-4o / glm-4v-flash）'
    };
  }
  return { provider: p, model: resolved };
}

/**
 * 把图片交给视觉模型分析。
 * 注意：这里不能走 callProviderAPI —— 它的 sanitizeOutgoingMessages 会把数组型 content 拍平成字符串，
 * 多模态消息会被破坏，所以单独发一次请求。
 */
async function analyzeImageWithVision({ imagePath, question, providerId, model, maxTokens = 1024 }) {
  const target = resolveVisionTarget({ providerId, model });
  if (target.error) return { success: false, error: target.error };

  if (!imagePath || !fs.existsSync(imagePath)) {
    return { success: false, error: '截图文件不存在: ' + (imagePath || '(空)') };
  }

  // 压一下体积：视觉模型不需要原图，过大反而容易请求超时
  let dataUrl;
  let sentNote;
  try {
    const { nativeImage } = require('electron');
    const img = nativeImage.createFromPath(imagePath);
    const size = img.getSize();
    const resized = size.width > 1440 ? img.resize({ width: 1440 }) : img;
    const pngBuf = resized.toPNG();
    if (pngBuf.length <= 1.2 * 1024 * 1024) {
      dataUrl = 'data:image/png;base64,' + pngBuf.toString('base64');
      sentNote = resized.getSize().width + 'x' + resized.getSize().height + ' PNG';
    } else {
      const jpg = resized.toJPEG(82);
      dataUrl = 'data:image/jpeg;base64,' + jpg.toString('base64');
      sentNote = resized.getSize().width + 'x' + resized.getSize().height + ' JPEG';
    }
  } catch (e) {
    try {
      dataUrl = 'data:image/png;base64,' + fs.readFileSync(imagePath).toString('base64');
      sentNote = '原图 PNG';
    } catch (e2) {
      return { success: false, error: '读取截图失败: ' + e2.message };
    }
  }

  const url = new URL(target.provider.apiUrl);
  const client = url.protocol === 'https:' ? https : http;
  const bodyObj = {
    model: target.model,
    stream: false,
    max_tokens: maxTokens,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: question },
        { type: 'image_url', image_url: { url: dataUrl } }
      ]
    }]
  };
  const body = JSON.stringify(bodyObj);

  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (target.provider.apiKey) headers['Authorization'] = 'Bearer ' + target.provider.apiKey;

    const req = client.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname.replace(/\/$/, '') + (url.search || ''),
      method: 'POST',
      headers
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          done({ success: false, error: simplifyApiError(res.statusCode, data), model: target.model, provider: target.provider.name });
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const content = parsed?.choices?.[0]?.message?.content;
          const text = typeof content === 'string'
            ? content
            : (Array.isArray(content) ? content.map(p => p?.text || '').join('\n') : '');
          if (!text) {
            done({ success: false, error: '视觉模型返回空内容', model: target.model, raw: String(data).slice(0, 300) });
            return;
          }
          done({ success: true, model: target.model, provider: target.provider.name, sentImage: sentNote, analysis: text.trim() });
        } catch (e) {
          done({ success: false, error: '解析视觉模型响应失败: ' + e.message, raw: String(data).slice(0, 300) });
        }
      });
    });
    req.on('error', (e) => done({ success: false, error: '视觉模型请求失败: ' + e.message }));
    req.setTimeout(90000, () => { try { req.destroy(); } catch (e) {} done({ success: false, error: '视觉模型请求超时（90 秒）' }); });
    safeWriteRequest(req, body, (e) => done({ success: false, error: '视觉模型请求发送失败: ' + e.message }));
  });
}

// 从视觉模型回答里抽取「通过 / 不通过」结论
function parseVisionVerdict(text) {
  if (!text) return null;
  const head = String(text).slice(0, 400);
  if (/结论\s*[:：]?\s*不通过|不通过|未通过|仍有问题|依然被裁|存在缺陷/i.test(head)) return 'fail';
  if (/结论\s*[:：]?\s*通过|验证通过|没有问题|未发现(明显)?问题/i.test(head)) return 'pass';
  return null;
}

/**
 * 同步写请求体并结束请求。
 * ⚠️ 对端已断（本地模型被杀/重启、socket 已销毁）时 req.write 会**同步抛 EPIPE**，
 * 不兜住就会变成 uncaughtException（再叠加断管日志就是异常风暴）。
 */
function safeWriteRequest(req, body, onFail) {
  try {
    req.write(body);
    req.end();
    return true;
  } catch (e) {
    if (onFail) { try { onFail(e); } catch (e2) { /* 忽略 */ } }
    return false;
  }
}

// 执行工具
// ctx: { conversationId } —— 待办清单按会话隔离，靠它定位
// ===== 文档文本提取（read_file 扩展支持 PDF / docx）=====
// PDF 文字提取：pdf-parse v2（内置 pdf.js）。懒加载——模块缺失/损坏时不影响其他功能。
let _PDFParse = null;
let _pdfParseTried = false;
async function extractPdfText(filePath) {
  try {
    if (!_pdfParseTried) {
      _pdfParseTried = true;
      // pdf-parse v2：{ PDFParse } 具名导出；v1 的默认函数导出已废弃
      _PDFParse = require('pdf-parse').PDFParse;
    }
  } catch (e) {
    throw new Error('PDF 解析模块未安装（pdf-parse 缺失）');
  }
  if (!_PDFParse) throw new Error('PDF 解析模块不可用（pdf-parse 版本不兼容）');
  const dataBuffer = fs.readFileSync(filePath);
  const parser = new _PDFParse({ data: new Uint8Array(dataBuffer) });
  try {
    const result = await parser.getText();
    return String(result.text || '').replace(/\n{3,}/g, '\n\n').trim();
  } finally {
    try { await parser.destroy(); } catch (e) {}
  }
}

// docx：zip 包 → word/document.xml → 剥标签。用项目里已有的 extract-zip。
// 段落 </w:p> 换行、<w:br/> 换行、<w:tab/> 制表；其余标签删除，XML 实体还原。
async function extractDocxText(filePath) {
  const extract = require('extract-zip');
  const os = require('os');
  const tmpDir = path.join(os.tmpdir(), 'ailobster_docx_' + Date.now());
  try {
    await extract(filePath, { dir: tmpDir });
    const docXmlPath = path.join(tmpDir, 'word', 'document.xml');
    if (!fs.existsSync(docXmlPath)) return null;
    let xml = fs.readFileSync(docXmlPath, 'utf8');
    // 段落与换行先转成标记符，避免剥标签时粘连
    xml = xml.replace(/<\/w:p>/g, '\n').replace(/<w:br\s*\/>/g, '\n').replace(/<w:tab\s*\/>/g, '\t');
    // 剥掉其余所有标签
    let text = xml.replace(/<[^>]+>/g, '');
    // XML 实体还原
    text = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    return text.replace(/\n{3,}/g, '\n\n').trim();
  } catch (e) {
    return null;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

/**
 * 工具参数前置校验（文档 3.1「结构化工具定义 + 前置参数校验」落地）。
 * 在真正执行工具之前，按 schema 检查 required / 类型，不合格直接返回结构化错误，
 * 让模型重传参数——不要等 run_shell 炸了才回滚。
 * 轻量实现：只查 required 是否齐全 + 简单类型匹配，不做完整 JSON Schema 校验（避免引依赖）。
 */
function validateToolArgs(name, args) {
  const def = AGENT_TOOLS.find(t => t.function && t.function.name === name);
  if (!def || !def.function || !def.function.parameters) return null; // 无 schema 不拦
  const schema = def.function.parameters;
  const required = Array.isArray(schema.required) ? schema.required : [];
  const props = schema.properties || {};
  const problems = [];
  // args 兜底：模型有时把对象当字符串传
  let a = args;
  if (typeof a === 'string') {
    try { a = JSON.parse(a); } catch (e) { a = {}; }
  }
  if (!a || typeof a !== 'object' || Array.isArray(a)) a = {};
  // 1) required 必填
  for (const key of required) {
    const v = a[key];
    if (v === undefined || v === null || v === '') {
      problems.push('缺少必填参数：' + key);
    }
  }
  // 2) 简单类型检查（properties 里声明了 type 的字段）
  for (const [key, spec] of Object.entries(props)) {
    const v = a[key];
    if (v === undefined || v === null) continue; // 非 required 缺了不拦
    const t = spec && spec.type;
    let ok = true;
    if (t === 'string') ok = typeof v === 'string';
    else if (t === 'number' || t === 'integer') ok = typeof v === 'number' && !isNaN(v);
    else if (t === 'boolean') ok = typeof v === 'boolean';
    else if (t === 'object') ok = typeof v === 'object' && !Array.isArray(v);
    else if (t === 'array') ok = Array.isArray(v);
    if (!ok) problems.push('参数「' + key + '」类型错误：期望 ' + t + '，实际是 ' + (Array.isArray(v) ? 'array' : typeof v));
  }
  if (problems.length) {
    return {
      success: false,
      error: '参数校验未通过：' + problems.join('；')
        + '。请按工具 schema 修正参数后重新调用。当前收到的参数：'
        + JSON.stringify(a).slice(0, 500)
    };
  }
  return null;
}

async function executeTool(name, args, workdir, ctx) {
  // MCP 工具优先分发：它们是外部进程的能力，和内置工具是两套东西，
  // 放在 switch 之前拦掉，免得 case 列表越加越长。
  // 注意：会话模式的硬阻断必须**先于**这里执行，否则外部工具就成了绕过通道。
  if (ctx && ctx.allowedTools && ctx.allowedTools instanceof Set && !ctx.allowedTools.has(name)) {
    console.warn('[Agent] 会话模式拦截非识别工具调用:', name);
    return {
      success: false,
      error: '当前为「会话模式」，仅允许识别/解读类工具（看图分析 / 界面自验证 / 窗口截图），不允许使用「' + toolLabelCN(name) + '」。如需启动程序、操作电脑、读写文件、执行命令，请切换到「工作模式」。'
    };
  }
  // 前置参数校验（内置工具）：required 缺/类型错直接返回结构化错误，不让模型把坏参数送进 switch。
  // MCP 工具的 schema 在外部 server 手里，不在这里拦（它们自己会返结构化错误）。
  if (typeof name === 'string' && !name.startsWith('mcp_')) {
    const vErr = validateToolArgs(name, args);
    if (vErr) {
      console.log('[Agent] 参数校验未通过:', name, vErr.error);
      return vErr;
    }
  }
  if (typeof name === 'string' && name.startsWith('mcp_')) {
    // MCP 工具调用走带重试策略的封装：网络抖动自动重试、崩溃自动重启
    return _mcpRetry.callToolWithRetry(_mcp, name, args);
  }
  const { exec, execSync } = require('child_process');
  const os = require('os');
  // 相对路径解析到项目工作目录；未选项目或已是绝对路径则原样返回
  const resolveProjPath = (p) => {
    if (!p || typeof p !== 'string') return p;
    if (!workdir) return p;
    return path.isAbsolute(p) ? p : path.resolve(workdir, p);
  };
  try {
    // 记忆按项目隔离：每次工具调用前校准记忆作用域（选项目→项目记忆，否则→全局）
    MemoryStore.ensureScope(MemoryStore.scopePathForWorkdir(workdir));
    switch (name) {
      case 'run_shell': {
        const cmd = args.command;
        // 默认超时 120 秒（docker build / npm install / pip install 等长任务；AI 可自行传更长 timeout）
        const timeout = args.timeout || 120000;
        // 安全限制：禁止危险命令
        const dangerous = /^(del|rmdir|format|diskpart|shutdown.*\/s|reg delete)/i;
        if (dangerous.test(cmd.trim())) {
          return { success: false, error: '命令被安全策略拦截（可能危险）' };
        }
        // 【桌面分身】分身正在运行时，所有命令都在分会话里执行，不在本机跑
        try {
          const DesktopSession = require('../desktopSession');
          const st = DesktopSession.status();
          if (st.state === 'running') {
            const os = require('os');
            const outFile = path.join(os.tmpdir(), 'mcp_cmd_out_' + Date.now() + '.txt');
            // 在分会话里用 cmd.exe 执行命令，stdout+stderr 重定向到临时文件
            const wrappedCmd = 'cmd.exe /c "' + cmd.replace(/"/g, '\\"') + ' > "' + outFile + '" 2>&1"';
            const lr = await DesktopSession.launchInSession('cmd.exe', '/c ' + wrappedCmd, workdir || '');
            if (!lr.success) {
              return { success: false, error: '【桌面分身】命令在分会话执行失败: ' + (lr.error || '未知') };
            }
            // 轮询输出文件直到命令结束（分身里 cmd.exe 退出后文件写完）
            const deadline = Date.now() + timeout;
            let lastSize = -1, stableCount = 0;
            while (Date.now() < deadline) {
              await new Promise(r => setTimeout(r, 300));
              try {
                if (!fs.existsSync(outFile)) continue;
                const stat = fs.statSync(outFile);
                if (stat.size === lastSize) { stableCount++; if (stableCount >= 3) break; }
                else { lastSize = stat.size; stableCount = 0; }
              } catch (e) { /* 忽略 */ }
            }
            let output = '';
            try { output = fs.readFileSync(outFile, 'utf8').slice(0, 5000); } catch (e) {}
            try { fs.unlinkSync(outFile); } catch (e) {}
            return { success: true, output: output || '(命令已在分身里执行，无输出)', ranInClone: true };
          }
        } catch (e) { /* 分身不可用就回落本机 */ }
        const trimmed = cmd.trim();
        // 命令行操作一律本机执行（不自动拉分身）
        // start 命令启动外部程序，不等待退出
        if (/^start\s/i.test(cmd.trim())) {
          try {
            exec(cmd, { windowsHide: true, timeout: 5000, cwd: workdir || undefined });
            return { success: true, output: '已启动: ' + cmd };
          } catch(e) {
            return { success: false, error: e.message };
          }
        }
        // 普通命令用 Promise 包装 exec，避免阻塞
        return new Promise((resolve) => {
          let resolved = false;
          const child = exec(cmd, { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 1024 * 1024, cwd: workdir || undefined }, (error, stdout, stderr) => {
            if (resolved) return;
            resolved = true;
            if (error && error.killed) {
              // 超时：尝试杀死整个进程树
              try {
                execSync(`taskkill /F /T /PID ${child.pid} 2>nul`, { windowsHide: true, timeout: 5000 });
              } catch(e) { /* 进程可能已经退出 */ }
              // 超时但 stdout 已有输出（docker build / npm install 等长任务在正常跑）
              // 不判失败，返回"仍在运行"提示，避免分身已启动却误报失败
              if (stdout && stdout.trim()) {
                resolve({ success: true, output: '命令执行超过 ' + (timeout/1000) + ' 秒仍在运行（进程未被杀，继续在后台）：\n' + stdout.slice(0, 3000), stillRunning: true });
              } else {
                resolve({ success: false, error: '命令执行超时（' + (timeout/1000) + '秒），已终止进程树', output: (stdout || '').slice(0, 3000) });
              }
            } else if (error) {
              resolve({ success: false, error: error.message, output: (stdout + stderr).slice(0, 3000) });
            } else {
              resolve({ success: true, output: (stdout || '').slice(0, 5000) });
            }
          });
          // 额外的超时保护：确保即使 exec 的 timeout 不生效也能 resolve
          setTimeout(() => {
            if (!resolved) {
              resolved = true;
              try {
                execSync(`taskkill /F /T /PID ${child.pid} 2>nul`, { windowsHide: true, timeout: 5000 });
              } catch(e) { /* 忽略 */ }
              resolve({ success: false, error: '命令执行超时（' + (timeout/1000) + '秒），已强制终止', output: '' });
            }
          }, timeout + 2000);
        });
      }
      case 'read_file': {
        const p = resolveProjPath(args.path);
        if (!fs.existsSync(p)) return { success: false, error: '文件不存在: ' + p };
        const stat = fs.statSync(p);
        if (stat.size > 20 * 1024 * 1024) return { success: false, error: '文件过大（>20MB），请用其他方式查看' };
        const ext = path.extname(p).toLowerCase();
        let content;
        if (ext === '.pdf') {
          // PDF：提取文字层（pdf-parse / pdf.js）。扫描件（图片型 PDF）无文字层会返回空，如实告知。
          const text = await extractPdfText(p);
          if (!text || !text.trim()) {
            return { success: false, error: '该 PDF 没有可提取的文字层（可能是扫描件/图片型 PDF）。' };
          }
          content = text;
        } else if (ext === '.docx') {
          // docx 本质是 zip，解包取 word/document.xml 后剥掉 XML 标签
          const text = await extractDocxText(p);
          if (text == null) return { success: false, error: '无法解析该 Word 文档（.docx 格式损坏或不完整）' };
          content = text;
        } else {
          content = fs.readFileSync(p, 'utf8');
        }
        const sliced = String(content).slice(0, 20000);
        return { success: true, content: sliced + (String(content).length > 20000 ? '\n\n[内容过长已截断，原文件共 ' + String(content).length + ' 字符]' : '') };
      }
      case 'write_file': {
        let p = resolveProjPath(args.path);
        try {
          fs.writeFileSync(p, args.content || '', 'utf8');
          return { success: true, message: '已写入: ' + p };
        } catch (e) {
          const isPermError = e.code === 'EPERM' || e.code === 'EACCES' || e.message.includes('permission') || e.message.includes('拒绝');
          if (isPermError) {
            // 尝试用 PowerShell 提权写入（触发 UAC 弹窗）
            // 使用异步 exec + 超时，避免 UAC 弹窗导致永久挂起
            try {
              const tmpFile = path.join(os.tmpdir(), 'ailobster_write_' + Date.now() + '.tmp');
              fs.writeFileSync(tmpFile, args.content || '', 'utf8');
              const destDir = path.dirname(p);
              const psCmd = `Start-Process powershell -Verb RunAs -Wait -ArgumentList '-Command', 'if (!(Test-Path "${destDir}")) { New-Item -ItemType Directory -Path "${destDir}" -Force }; Copy-Item -Path "${tmpFile}" -Destination "${p}" -Force; Remove-Item "${tmpFile}" -Force'`;
              
              // 异步执行，最多等待30秒（UAC弹窗用户确认时间）
              const adminResult = await new Promise((resolve) => {
                let done = false;
                const child = exec(psCmd, { windowsHide: true, timeout: 30000 }, (error) => {
                  if (done) return;
                  done = true;
                  resolve(!error);
                });
                // 额外超时保护
                setTimeout(() => {
                  if (!done) {
                    done = true;
                    try { child.kill(); } catch(e) {}
                    resolve(false);
                  }
                }, 32000);
              });
              
              if (adminResult && fs.existsSync(p)) {
                return { success: true, message: '已通过管理员权限写入: ' + p };
              }
            } catch (eAdmin) {
              console.log('[Agent] 提权写入失败或用户拒绝:', eAdmin.message);
            }
            // 提权失败，如果是 Public 桌面，自动尝试用户桌面
            if (p.includes('Public\\Desktop') || p.includes('Public/Desktop')) {
              const userDesktop = path.join(os.homedir(), 'Desktop');
              const fileName = path.basename(p);
              const newPath = path.join(userDesktop, fileName);
              try {
                if (!fs.existsSync(userDesktop)) fs.mkdirSync(userDesktop, { recursive: true });
                fs.writeFileSync(newPath, args.content || '', 'utf8');
                return { success: true, message: '原路径无权限，已自动写入用户桌面: ' + newPath };
              } catch (e2) {
                return { success: false, error: '写入失败: ' + e.message + '，提权和自动改路径均失败' };
              }
            }
            return { success: false, error: '写入失败（需要管理员权限，已尝试提权）: ' + e.message };
          }
          return { success: false, error: '写入失败: ' + e.message };
        }
      }
      case 'get_system_info': {
        return {
          success: true,
          info: {
            platform: os.platform(),
            release: os.release(),
            arch: os.arch(),
            cpu: os.cpus()[0]?.model,
            cpuCores: os.cpus().length,
            totalMem: Math.round(os.totalmem() / 1024 / 1024) + ' MB',
            freeMem: Math.round(os.freemem() / 1024 / 1024) + ' MB',
            nodeVersion: process.version,
            appVersion: require('electron').app?.getVersion() || 'unknown',
            hostname: os.hostname()
          }
        };
      }
      case 'pet_action': {
        // 通过全局事件通知主进程触发宠物动作
        try {
          const { app } = require('electron');
          app.emit('agent:pet-action', args.action);
        } catch(e) {}
        return { success: true, message: '已触发宠物动作: ' + args.action };
      }
      case 'web_search': {
        const query = args.query;
        const maxResults = Math.min(args.max_results || 8, 20);
        if (!query || !String(query).trim()) {
          return { success: false, error: '搜索关键词为空' };
        }
        // 旧实现里 DuckDuckGo 一旦抛异常就直接失败，Bing 备用形同虚设；
        // 国内网络 DDG 基本不可达 → 搜索 100% 失败。改为多引擎逐个尝试。
        return await searchWeb(query, maxResults);
      }
      case 'web_fetch': {
        const url = args.url;
        const maxLength = args.max_length || 8000;
        const fetchTimeout = 20000;
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), fetchTimeout);
          const response = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            signal: controller.signal
          });
          clearTimeout(timer);
          const contentType = response.headers.get('content-type') || '';
          let text = await response.text();
          // 如果是 HTML，移除标签，只保留文本
          if (contentType.includes('text/html')) {
            // 移除 script 和 style 标签
            text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
            text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
            // 移除 HTML 标签
            text = text.replace(/<[^>]*>/g, ' ');
            // 合并空白
            text = text.replace(/\s+/g, ' ').trim();
          }
          return { success: true, url, status: response.status, content: text.slice(0, maxLength), truncated: text.length > maxLength };
        } catch (e) {
          return { success: false, error: '抓取失败: ' + e.message };
        }
      }
      case 'http_request': {
        const url = args.url;
        const method = (args.method || 'GET').toUpperCase();
        const headers = args.headers || {};
        const body = args.body;
        const timeout = args.timeout || 15000;
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeout);
          const options = { method, headers, signal: controller.signal };
          if (body && method !== 'GET') {
            options.body = body;
          }
          const response = await fetch(url, options);
          clearTimeout(timer);
          const responseText = await response.text();
          const responseHeaders = {};
          response.headers.forEach((value, key) => { responseHeaders[key] = value; });
          return { success: true, url, method, status: response.status, statusText: response.statusText, headers: responseHeaders, body: responseText.slice(0, 10000) };
        } catch (e) {
          return { success: false, error: '请求失败: ' + e.message };
        }
      }
      case 'file_search': {
        const directory = resolveProjPath(args.directory);
        const pattern = args.pattern;
        const maxResults = args.max_results || 50;
        try {
          if (!fs.existsSync(directory)) {
            return { success: false, error: '目录不存在: ' + directory };
          }
          // 将通配符模式转换为正则表达式
          const regexPattern = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
          const regex = new RegExp('^' + regexPattern + '$', 'i');
          const results = [];
          function searchDir(dir) {
            if (results.length >= maxResults) return;
            try {
              const entries = fs.readdirSync(dir, { withFileTypes: true });
              for (const entry of entries) {
                if (results.length >= maxResults) break;
                const fullPath = path.join(dir, entry.name);
                if (entry.isFile() && regex.test(entry.name)) {
                  const stat = fs.statSync(fullPath);
                  results.push({ path: fullPath, name: entry.name, size: stat.size, modified: stat.mtime.toISOString() });
                } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
                  searchDir(fullPath);
                }
              }
            } catch (e) { /* 忽略无权限目录 */ }
          }
          searchDir(directory);
          return { success: true, directory, pattern, results, count: results.length };
        } catch (e) {
          return { success: false, error: '搜索失败: ' + e.message };
        }
      }
      case 'directory_list': {
        const dirPath = resolveProjPath(args.path);
        const showHidden = args.show_hidden || false;
        try {
          if (!fs.existsSync(dirPath)) {
            return { success: false, error: '目录不存在: ' + dirPath };
          }
          const entries = fs.readdirSync(dirPath, { withFileTypes: true });
          const result = [];
          for (const entry of entries) {
            if (!showHidden && entry.name.startsWith('.')) continue;
            const fullPath = path.join(dirPath, entry.name);
            try {
              const stat = fs.statSync(fullPath);
              result.push({
                name: entry.name,
                type: entry.isDirectory() ? 'directory' : 'file',
                size: entry.isFile() ? stat.size : null,
                modified: stat.mtime.toISOString()
              });
            } catch (e) { /* 忽略 */ }
          }
          // 目录在前，文件在后
          result.sort((a, b) => {
            if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
          return { success: true, path: dirPath, entries: result, count: result.length };
        } catch (e) {
          return { success: false, error: '列出目录失败: ' + e.message };
        }
      }
      case 'copy_file': {
        const source = resolveProjPath(args.source);
        const destination = resolveProjPath(args.destination);
        const overwrite = args.overwrite || false;
        try {
          if (!fs.existsSync(source)) {
            return { success: false, error: '源文件不存在: ' + source };
          }
          if (fs.existsSync(destination) && !overwrite) {
            return { success: false, error: '目标文件已存在，设置 overwrite=true 可覆盖' };
          }
          const stat = fs.statSync(source);
          if (stat.isDirectory()) {
            // 复制目录
            function copyDir(src, dest) {
              if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
              const entries = fs.readdirSync(src, { withFileTypes: true });
              for (const entry of entries) {
                const srcPath = path.join(src, entry.name);
                const destPath = path.join(dest, entry.name);
                if (entry.isDirectory()) {
                  copyDir(srcPath, destPath);
                } else {
                  fs.copyFileSync(srcPath, destPath);
                }
              }
            }
            copyDir(source, destination);
          } else {
            // 确保目标目录存在
            const destDir = path.dirname(destination);
            if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
            fs.copyFileSync(source, destination);
          }
          return { success: true, message: '已复制: ' + source + ' -> ' + destination };
        } catch (e) {
          return { success: false, error: '复制失败: ' + e.message };
        }
      }
      case 'move_file': {
        const source = resolveProjPath(args.source);
        const destination = resolveProjPath(args.destination);
        try {
          if (!fs.existsSync(source)) {
            return { success: false, error: '源文件不存在: ' + source };
          }
          // 确保目标目录存在
          const destDir = path.dirname(destination);
          if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
          fs.renameSync(source, destination);
          return { success: true, message: '已移动: ' + source + ' -> ' + destination };
        } catch (e) {
          // 如果跨盘移动失败，尝试复制+删除
          try {
            if (fs.existsSync(source)) {
              const stat = fs.statSync(source);
              if (stat.isDirectory()) {
                function copyDir(src, dest) {
                  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
                  const entries = fs.readdirSync(src, { withFileTypes: true });
                  for (const entry of entries) {
                    const srcPath = path.join(src, entry.name);
                    const destPath = path.join(dest, entry.name);
                    if (entry.isDirectory()) copyDir(srcPath, destPath);
                    else fs.copyFileSync(srcPath, destPath);
                  }
                }
                copyDir(source, destination);
                fs.rmSync(source, { recursive: true, force: true });
              } else {
                fs.copyFileSync(source, destination);
                fs.unlinkSync(source);
              }
              return { success: true, message: '已移动（跨盘）: ' + source + ' -> ' + destination };
            }
          } catch (e2) {
            return { success: false, error: '移动失败: ' + e2.message };
          }
          return { success: false, error: '移动失败: ' + e.message };
        }
      }
      case 'create_directory': {
        const dirPath = resolveProjPath(args.path);
        try {
          if (fs.existsSync(dirPath)) {
            return { success: true, message: '目录已存在: ' + dirPath };
          }
          fs.mkdirSync(dirPath, { recursive: true });
          return { success: true, message: '已创建目录: ' + dirPath };
        } catch (e) {
          return { success: false, error: '创建目录失败: ' + e.message };
        }
      }
      case 'download_file': {
        const url = args.url;
        const destination = resolveProjPath(args.destination);
        const timeout = args.timeout || 60000;
        try {
          // 确保目标目录存在
          const destDir = path.dirname(destination);
          if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeout);
          const response = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
          });
          clearTimeout(timer);
          if (!response.ok) {
            return { success: false, error: '下载失败，HTTP 状态: ' + response.status };
          }
          const buffer = Buffer.from(await response.arrayBuffer());
          fs.writeFileSync(destination, buffer);
          return { success: true, message: '已下载: ' + url + ' -> ' + destination, size: buffer.length, path: destination };
        } catch (e) {
          return { success: false, error: '下载失败: ' + e.message };
        }
      }
      case 'get_current_time': {
        const now = new Date();
        return {
          success: true,
          timestamp: now.getTime(),
          iso: now.toISOString(),
          local: now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
          date: now.toLocaleDateString('zh-CN'),
          time: now.toLocaleTimeString('zh-CN'),
          weekday: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()]
        };
      }
      case 'calculator': {
        const expression = args.expression;
        try {
          // 安全计算：只允许数字、运算符、Math 函数和括号
          const sanitized = expression.replace(/[^0-9+\-*/().,\sMath.PIE.sqrtpowabsceilfloorroundminmaxlogsin cos tan asin acos atan]/g, '');
          if (!sanitized || sanitized.trim() === '') {
            return { success: false, error: '无效的数学表达式' };
          }
          // 使用 Function 构造函数计算（比 eval 稍安全）
          const result = new Function('"use strict"; return (' + sanitized + ')')();
          if (typeof result !== 'number' || !isFinite(result)) {
            return { success: false, error: '计算结果无效' };
          }
          return { success: true, expression, result };
        } catch (e) {
          return { success: false, error: '计算失败: ' + e.message };
        }
      }
      case 'check_url': {
        const url = args.url;
        const timeout = args.timeout || 10000;
        try {
          const startTime = Date.now();
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeout);
          const response = await fetch(url, {
            method: 'HEAD',
            signal: controller.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
          });
          clearTimeout(timer);
          const responseTime = Date.now() - startTime;
          return { success: true, url, status: response.status, statusText: response.statusText, responseTime: responseTime + 'ms', accessible: response.ok };
        } catch (e) {
          return { success: false, url, accessible: false, error: '检查失败: ' + e.message };
        }
      }
      case 'open_url': {
        const url = args.url;
        try {
          const { shell } = require('electron');
          // 为 shell.openExternal 添加超时保护
          const openResult = await Promise.race([
            shell.openExternal(url),
            new Promise((resolve, reject) => setTimeout(() => reject(new Error('打开超时')), 10000))
          ]);
          return { success: true, message: '已在浏览器中打开: ' + url };
        } catch (e) {
          // 备用：使用系统命令打开
          try {
            const { exec } = require('child_process');
            exec('start "" "' + url + '"', { timeout: 5000 });
            return { success: true, message: '已在浏览器中打开: ' + url };
          } catch (e2) {
            return { success: false, error: '打开失败: ' + (e.message || e2.message) };
          }
        }
      }
      // ==================== 待办事项 ====================
      case 'todo_write': {
        const r = TodoStore.write(ctx && ctx.conversationId, args.items, args.title);
        return { ...r, hint: r.progress.completed < r.progress.total
          ? '清单已更新。先把当前这条做完（todo_update 标记），再开始下一条。'
          : '全部完成，可以汇报结果了。' };
      }
      case 'todo_update': {
        const r = TodoStore.update(ctx && ctx.conversationId, {
          id: args.id,
          text: args.text,
          status: args.status,
          note: args.note,
          done_when: args.done_when,
          new_text: args.new_text
        });
        return r;
      }
      case 'todo_read': {
        const r = TodoStore.read(ctx && ctx.conversationId);
        return r.items.length ? r : { ...r, hint: '当前会话还没有待办清单。多步骤需求应当先 todo_write 整理出来。' };
      }

      // ==================== 长期记忆 ====================
      case 'memory_save': {
        const r = MemoryStore.add({
          text: args.text,
          tags: args.tags,
          kind: args.kind,
          pinned: args.pinned,
          id: args.id,
          source: 'agent'
        });
        if (!r.success) return r;
        memoryWrittenThisRound = true; // 收尾时据此判断无需强制补写
        return {
          success: true,
          action: r.updated ? 'updated' : 'added',
          item: memoryBrief(r.item),
          total: r.total,
          message: (r.updated ? '已更新记忆 ' : '已记住 ') + r.item.id + '（记忆库共 ' + r.total + ' 条）'
        };
      }
      case 'memory_search': {
        const items = MemoryStore.search(args.query, args.limit || 10);
        return {
          success: true,
          query: args.query,
          count: items.length,
          items: items.map(memoryBrief),
          stats: MemoryStore.stats(),
          ...(items.length ? {} : { hint: '没有匹配的记忆。若这条信息以后还用得上，用 memory_save 记下来。' })
        };
      }
      case 'memory_list': {
        const items = MemoryStore.list({ tag: args.tag, kind: args.kind, limit: args.limit || 50 });
        return { success: true, count: items.length, items: items.map(memoryBrief), stats: MemoryStore.stats() };
      }
      case 'memory_delete': {
        if (args.id) {
          const r = MemoryStore.remove(args.id);
          if (!r.success) return r;
          return { success: true, removed: [memoryBrief(r.removed)], total: r.total };
        }
        if (args.query) {
          const r = MemoryStore.removeByQuery(args.query, args.limit || 10);
          if (!r.success) return r;
          return { success: true, removed: r.removed.map(memoryBrief), total: r.total };
        }
        return { success: false, error: '需要提供 id 或 query 之一' };
      }

      // ==================== 截图 / 界面自验证 ====================
      case 'capture_window': {
        // 分身（RDP 子会话）正在运行且未显式指定 title/which → 抓分身宿主窗口画面。
        // 这样 AI 操作分身里的程序后截图，看到的就是分身里的内容，不用用户点进/放大小窗。
        const DesktopSession = require('../desktopSession');
        if (!args.title && !args.which && DesktopSession.status().state === 'running') {
          const fr = await DesktopSession.captureFrame({ maxWidth: 1000 });
          if (fr.success) {
            const out = { success: true, target: 'desktop-clone', width: fr.width, height: fr.height, image: fr.png };
            if (args.save_path) {
              try { fs.writeFileSync(args.save_path, Buffer.from(fr.png.split(',')[1], 'base64')); out.path = args.save_path; } catch (e) {}
            }
            return out;
          }
        }
        // 隔离桌面（桌面分身）只用于「不需要看界面」的任务，它的画面用户看不到，
        // 所以这里**不再**抓分身整屏合成图 —— 一律走真实桌面 / 目标程序窗口。
        // 默认目标：已 launch_project 启动被测程序 → 抓「它」的窗口；否则抓本应用窗口。
        // 这样「验证外部项目却总截到自己页面」的根因被去掉。
        const targetTitle = (!args.title && !args.which) ? resolveTestTargetTitle(workdir) : null;
        let res;
        if (args.title) {
          res = await UiVerify.captureProgramWindow({ title: args.title, index: args.index, savePath: args.save_path, workdir });
        } else if (targetTitle) {
          res = await UiVerify.captureProgramWindow({ title: targetTitle, index: args.index, savePath: args.save_path, workdir });
          if (!res.success) {
            // 明确告诉模型「没截到被测程序」，并列出候选窗口；不要偷偷回退截本应用充数
            return {
              success: false,
              error: '未能抓到被测程序窗口（标题含「' + targetTitle + '」）。不要改截本应用窗口充数——请确认被测程序已启动，或用 index / 显式 title 指定窗口。',
              candidates: res.candidates
            };
          }
          res.target = 'test-program';
        } else {
          res = await UiVerify.captureAppWindow({ which: args.which || 'main', savePath: args.save_path, workdir });
          res.target = 'self-app';
        }
        if (res.success) lastScreenshotPath = res.path;
        return res;
      }
      case 'verify_ui': {
        // ② 外部程序窗口（如用户的项目/游戏/浏览器页面）：无法注入布局自检，
        //    走「抓对方窗口画面 + 视觉模型复核」。2026-10-02 修复"验证贪吃蛇却截了自己应用页面"。
        // 默认：若已 launch_project 启动被测程序且没传 title/which → 自动按外部程序（抓目标窗口）走，
        //       避免又落回本应用布局自检（=截自己页面）。
        const verifyTitle = args.title || ((!args.which) ? resolveTestTargetTitle(workdir) : null);
        if (verifyTitle) {
          const shot = await UiVerify.captureProgramWindow({ title: verifyTitle, index: args.index, workdir });
          if (!shot.success) {
            return { success: false, error: shot.error, candidates: shot.candidates,
              hint: '未找到目标窗口：请确认对方程序已打开且窗口标题包含关键字，或换 title 关键字重试。' };
          }
          lastScreenshotPath = shot.path;

          let vision = null;
          if (args.analyze !== false) {
            const question =
              (args.expect ? '本次改动期望达到的效果：' + args.expect + '\n\n' : '') +
              '请只针对界面缺陷做判断：有没有元素被裁掉/被遮挡、内容溢出被藏住、元素跑出窗口、排版错位、文字被截断、元素丢失、渲染异常（如方块化/花屏）？\n' +
              '第一行必须是结论，格式严格为「结论：通过」或「结论：不通过」，第二行起再分点说明你看到的证据（引用具体位置）。';
            vision = await analyzeImageWithVision({ imagePath: shot.path, question });
          }
          const visionVerdict = vision && vision.success ? parseVisionVerdict(vision.analysis) : null;

          // 外部窗口没有布局自检数据，结论只能来自视觉复核；没有视觉复核时如实给 warn
          let verdict = visionVerdict === 'fail' ? 'fail' : visionVerdict === 'pass' ? 'pass' : 'warn';

          const lines = [];
          lines.push('已抓取外部窗口「' + (shot.matched || verifyTitle) + '」画面（' + shot.width + '×' + shot.height + '）' + (args.title ? '' : '（未显式传 title，自动锁定 launch_project 启动的被测程序）'));
          if (vision) {
            if (vision.success) lines.push('视觉复核（' + vision.provider + ' / ' + vision.model + '）：' +
              String(vision.analysis).split('\n').slice(0, 4).join(' / '));
            else lines.push('视觉复核跳过：' + vision.error);
          } else {
            lines.push('视觉复核未执行（analyze=false 或未配置视觉模型）——外部窗口无法做布局自检，请人工确认截图。');
          }
          lines.push('→ 结论：' + (verdict === 'pass' ? '通过（pass）' : verdict === 'warn' ? '基本通过，存在中等问题/未能复核（warn）' : '未通过（fail）'));

          return {
            success: true,   // 注意：这是「工具执行成功」，不是「验证通过」
            verdict,
            passed: verdict === 'pass',
            target: 'external:' + (shot.matched || args.title),
            summary: lines.join('\n'),
            audit: { skipped: '外部窗口无法注入布局自检，仅做视觉复核' },
            screenshot: shot.path,
            vision: vision ? (vision.success
              ? { model: vision.model, provider: vision.provider, verdict: visionVerdict, analysis: vision.analysis }
              : { error: vision.error }) : null,
            next: verdict === 'pass'
              ? '验证通过，可以结束本轮并如实向用户汇报（附上截图路径）。'
              : verdict === 'fail'
                ? '未通过：请按 vision 里的线索继续修改，改完再用相同 title 复验，直到 verdict=pass。'
                : '未能自动复核（无视觉模型或被跳过）：请如实告知用户需人工确认，或配置视觉模型后再验。'
          };
        }

        // ① 本应用窗口：布局自检 + 截图 + 视觉复核
        const which = args.which || 'main';
        const audit = await UiVerify.runUiAudit({
          which,
          selectors: args.selectors,
          checks: args.checks,
          maxIssues: 25
        });

        // 截图留证（workdir：选了项目时落到 <项目>/screenshots/，见 uiVerify.shotsDirFor）
        let shot = null;
        if (args.screenshot !== false) {
          shot = await UiVerify.captureAppWindow({ which, workdir });
          if (shot.success) lastScreenshotPath = shot.path;
        }

        // 视觉复核（配置了视觉模型才有）
        let vision = null;
        if (args.analyze !== false) {
          const question =
            (args.expect ? '本次改动期望达到的效果：' + args.expect + '\n\n' : '') +
            '请只针对界面缺陷做判断：有没有元素被裁掉/被遮挡、内容溢出被藏住、元素跑出窗口、排版错位、文字被截断、元素丢失？\n' +
            '第一行必须是结论，格式严格为「结论：通过」或「结论：不通过」，第二行起再分点说明你看到的证据（引用具体位置）。';
          vision = await analyzeImageWithVision({
            imagePath: shot && shot.success ? shot.path : lastScreenshotPath,
            question
          });
        }

        const issues = audit.success ? (audit.issues || []) : [];
        const highCount = issues.filter(i => i.severity === 'high').length;
        const midCount = issues.filter(i => i.severity === 'medium').length;
        const visionVerdict = vision && vision.success ? parseVisionVerdict(vision.analysis) : null;

        let verdict = 'pass';
        if (highCount > 0 || visionVerdict === 'fail') verdict = 'fail';
        else if (midCount > 0) verdict = 'warn';

        const lines = [];
        if (!audit.success) {
          lines.push('布局自检没能执行：' + audit.error);
        } else if (issues.length === 0) {
          lines.push('布局自检通过：未发现裁切 / 溢出 / 越界问题（扫描 ' + audit.scanned + ' 个可见元素）');
        } else {
          lines.push('布局自检发现 ' + issues.length + ' 个问题（严重 ' + highCount + ' / 中等 ' + midCount + '）');
          issues.slice(0, 6).forEach(i => lines.push('   - [' + i.type + '] ' + i.element + ' ' + i.detail));
        }
        if (vision) {
          if (vision.success) lines.push('视觉复核（' + vision.provider + ' / ' + vision.model + '）：' +
            String(vision.analysis).split('\n').slice(0, 4).join(' / '));
          else lines.push('视觉复核跳过：' + vision.error);
        }
        lines.push('→ 结论：' + (verdict === 'pass' ? '通过（pass）' : verdict === 'warn' ? '基本通过，存在中等问题（warn）' : '未通过（fail）'));

        return {
          success: true,   // 注意：这是「工具执行成功」，不是「验证通过」
          verdict,
          passed: verdict === 'pass',
          summary: lines.join('\n'),
          audit: audit.success ? {
            viewport: audit.viewport,
            scanned: audit.scanned,
            issueCount: audit.issueCount,
            byType: audit.byType,
            issues,
            truncated: audit.truncated,
            focus: audit.focus,
            badSelectors: audit.badSelectors,
            checksUsed: audit.checksUsed
          } : { error: audit.error },
          screenshot: shot && shot.success ? shot.path : null,
          vision: vision ? (vision.success
            ? { model: vision.model, provider: vision.provider, verdict: visionVerdict, analysis: vision.analysis }
            : { error: vision.error }) : null,
          next: verdict === 'pass'
            ? '验证通过，可以结束本轮并如实向用户汇报（附上截图路径）。'
            : '未通过：请按上面 issues/vision 的线索继续修改，改完再调用 verify_ui 复验，直到 verdict=pass。'
        };
      }
      case 'analyze_screenshot': {
        const imgPath = args.image_path || lastScreenshotPath;
        if (!imgPath) return { success: false, error: '没有可分析的截图，请先用 capture_window 或 verify_ui 截图' };
        const res = await analyzeImageWithVision({
          imagePath: imgPath,
          question: String(args.question || '请描述这张界面截图') +
            '\n第一行先给结论（格式：「结论：通过」或「结论：不通过」），第二行起分点说明依据。',
          providerId: args.provider_id,
          model: args.model
        });
        return { ...res, image: imgPath };
      }
      case 'control_computer': {
        // 桌面分身（悬浮预览小窗）优先：如果它正在运行，AI 操作的就是小窗里的程序。
        // 输入经 RDP SendMouseEvent/SendKeyboardEvent 直接注入隔离子会话 —— 不移动/不点击真实桌面鼠标。
        const DesktopSession = require('../desktopSession');
        if (DesktopSession.status().state === 'running') {
          cloneUsedInAgentRun = true;   // 这轮 AI 动了分身 → 收尾时自动收掉
          const actionName = String(args.action || '');
          const INPUT_ACTIONS = ['move', 'click', 'left_click', 'right_click', 'double_click', 'mouse_down', 'mouse_up', 'scroll', 'press', 'hotkey', 'type', 'paste'];
          if (actionName === 'windows') {
            return { success: false, error: '桌面分身（悬浮窗）模式下不支持 windows 窗口枚举（RDP 会话内窗口对主程序不可见）。请在悬浮窗里操作，或用截图确认画面。', mode: 'childSession' };
          }
          if (actionName === 'clipboard_get') {
            const CC = require('../computerControl');
            const c = CC.getClipboard();
            return { success: c.success, text: c.text, error: c.error || undefined, desktopClone: { mode: 'childSession' } };
          }
          if (actionName === 'clipboard_set') {
            const CC = require('../computerControl');
            CC.setClipboard(args.text);
            return { success: true, desktopClone: { mode: 'childSession' } };
          }
          if (!INPUT_ACTIONS.includes(actionName)) {
            return { success: false, error: '该 action（' + actionName + '）在桌面分身（悬浮窗）模式下不支持。支持：' + INPUT_ACTIONS.join('/') + '、clipboard_get/set。坐标=悬浮窗客户区像素，与悬浮窗画面一致。', mode: 'childSession' };
          }
          const r = await DesktopSession.sendInput({ action: actionName, ...args });
          return {
            ...r,
            desktopClone: { mode: 'childSession', note: '桌面分身悬浮窗模式：RDP SendMouseEvent/SendKeyboardEvent 直接注入子会话，不移动/不点击真实桌面鼠标；坐标=悬浮窗客户区像素，与悬浮窗画面一致' }
          };
        }
        // 未打开悬浮窗 → CreateDesktop 无界面隐藏桌面（纯后台，不抢前台）
        const Clone = require('../desktopClone');
        const CC = require('../computerControl');
        const actionName = String(args.action || '');
        const st = Clone.status();
        const running = st.state === 'running';

        // windows：枚举隐藏桌面内可见窗口
        if (actionName === 'windows') {
          if (!running) return { success: false, error: '分身未运行，请先调用 launch_in_clone', needLaunch: true };
          const w = await Clone.windows(args.keyword);
          return {
            success: w.success,
            count: (w.windows || []).length,
            windows: w.windows || [],
            hint: (w.windows || []).length === 0 ? '隐藏桌面暂无可见窗口' : undefined,
            error: w.error || undefined,
            desktopClone: { mode: 'hiddenDesktop', desktop: Clone.DESKTOP_NAME }
          };
        }

        // 以下动作都要求分身运行
        if (!running) {
          return {
            success: false,
            error: '分身未运行。请先调用 launch_in_clone 在隐藏桌面启动程序（如 notepad.exe、chrome.exe）。',
            needLaunch: true,
            mode: 'hiddenDesktop'
          };
        }

        // 剪贴板（同会话系统剪贴板）
        if (actionName === 'clipboard_get') {
          const c = CC.getClipboard();
          return { success: c.success, text: c.text, error: c.error || undefined, desktopClone: { mode: 'hiddenDesktop' } };
        }
        if (actionName === 'clipboard_set') {
          const c = CC.setClipboard(args.text);
          return { success: c.success, error: c.error || undefined, desktopClone: { mode: 'hiddenDesktop' } };
        }
        if (actionName === 'paste') {
          CC.setClipboard(args.text);
          const r = Clone.sendInput({ action: 'hotkey', keys: ['ctrl', 'v'] });
          return { success: r.success, error: r.error || undefined, desktopClone: { mode: 'hiddenDesktop' } };
        }

        // 输入动作：SetThreadDesktop 附加到隐藏桌面后 SendInput 注入
        const INPUT_ACTIONS = ['move', 'click', 'left_click', 'right_click', 'double_click', 'mouse_down', 'mouse_up', 'scroll', 'press', 'hotkey', 'type', 'paste'];
        if (!INPUT_ACTIONS.includes(actionName)) {
          return {
            success: false,
            error: '该 action（' + actionName + '）在隐藏桌面模式下不支持。支持：' + INPUT_ACTIONS.join('/') + '、windows、clipboard_get/set、paste。坐标 = 隐藏桌面屏幕坐标，与预览画面一致。',
            desktopClone: { mode: 'hiddenDesktop' }
          };
        }
        const ev = { action: actionName, ...args };
        if (actionName === 'right_click' && !ev.button) ev.button = 'right';
        const r = Clone.sendInput(ev);
        return {
          ...r,
          desktopClone: { mode: 'hiddenDesktop', desktop: Clone.DESKTOP_NAME, note: 'CreateDesktop 隐藏桌面，SendInput 注入隐藏桌面，不抢前台光标；坐标=隐藏桌面屏幕坐标' }
        };
      }
      case 'ensure_clone_desktop': {
        // ★ 桌面分身 = RDP Child Session 悬浮预览小窗（BetterGI 同款）：输入栏上方实时显示隔离桌面画面。
        //   "打开桌面分身" = 启动这个无标题栏预览小窗（RdpHost），用户能看到；它只是预览
        //   （鼠标点不到里面的画面），双击可剥离成独立大窗（大窗才可交互）。
        //   不是 CreateDesktop 无界面桌面。
        const DesktopSession = require('../desktopSession');
        const st = DesktopSession.status();
        if (st.state === 'running') {
          cloneUsedInAgentRun = true;
          return { success: true, state: 'running', already: true, desktopClone: { mode: 'childSession' } };
        }
        // ★ state==='starting'：已有一次启动正在进行（上一轮工具调用触发、或分身正在自启）。
        //   绝不能再次调用 DesktopSession.start() —— start 会先 taskkill 掉正在启动的宿主
        //   （desktopSession.js:297），把刚拉起、还没连上的子会话杀掉，结果永远连不上 → 卡到超时。
        //   正确做法：等它就绪、复用同一次启动。
        if (st.state === 'starting') {
          const r0 = await waitCloneRunning(75000);
          if (r0.success) cloneUsedInAgentRun = true;
          return {
            success: r0.success,
            state: r0.state || (r0.success ? 'running' : 'error'),
            error: r0.error || undefined,
            note: r0.success
              ? '桌面分身已就绪（复用正在启动的实例）：主程序输入栏上方出现一个无标题栏的预览小窗，实时显示隔离桌面画面，它只是预览（鼠标点不到里面的画面）；右上角 ✕ 关闭，双击它剥离成独立大窗（标题栏 — 收回小窗 / ✕ 关闭）。用户当前桌面不受影响。'
              : undefined,
            desktopClone: { mode: 'childSession' }
          };
        }
        const anchor = await currentCloneAnchor();
        const r0 = await DesktopSession.start({
          winBounds: anchor.winBounds,
          anchorRect: anchor.anchorRect,
          ownerHwnd: anchor.ownerHwnd
        });
        if (r0.success) cloneUsedInAgentRun = true;
        return {
          success: r0.success,
          state: r0.state || (r0.success ? 'running' : 'error'),
          error: r0.error || undefined,
          note: r0.success
            ? '桌面分身已就绪：主程序输入栏上方出现一个无标题栏的预览小窗，实时显示隔离桌面画面，' +
              '它只是预览（鼠标点不到里面的画面）；右上角 ✕ 关闭，双击它剥离成独立大窗（标题栏 — 收回小窗 / ✕ 关闭）。' +
              '用户当前桌面不受影响。可在其中启动程序（launch_in_clone）、操作程序（control_computer）。'
            : undefined,
          desktopClone: { mode: 'childSession' }
        };
      }
      case 'launch_in_clone': {
        // ★ 豆包式桌面分身（BetterGI 同款）：RDP Child Session 隔离桌面 + 小窗预览。
        //   程序启动进隔离子会话，画面实时显示在小窗里（用户能看到）；全程静默提权、不打扰当前桌面。
        const DesktopSession = require('../desktopSession');
        let commandLine = String(args.command || args.cmd || '');
        if (!commandLine) {
          return { success: false, error: '需要 command 参数（要启动的程序命令行，如 "notepad.exe" 或 "chrome.exe https://example.com"）' };
        }
        // 解析中文/口头程序名（如"波点音乐"）为真实 exe 路径；已有路径的命令保持原样
        const firstToken = commandLine.split(/\s+/)[0];
        if (firstToken && !/^[a-zA-Z]:[\\\/]/.test(firstToken) && !firstToken.includes('\\') && !firstToken.includes('/')) {
          const resolved = await resolveWindowsProgram(firstToken);
          if (resolved && resolved !== firstToken) {
            const rest = commandLine.slice(firstToken.length).trim();
            commandLine = rest ? `${resolved} ${rest}` : resolved;
            console.log('[launch_in_clone] 程序名解析:', firstToken, '->', resolved);
          }
        }
        console.log('[launch_in_clone] 开始，command:', commandLine);

        // 拆分 program 与 args：program 为可执行文件，其余为参数
        const toks = commandLine.match(/"[^"]*"|[^\s]+/g) || [];
        const program = toks.shift().replace(/^"|"$/g, '');
        const progArgs = toks.join(' ');

        // 确保桌面分身已在运行（静默启动；首次仅注册时弹一次 UAC）
        const st = DesktopSession.status();
        if (st.state !== 'running') {
          let needStart;
          if (st.state === 'starting') {
            // 正在启动：等它就绪，不要重复 spawn（重复会 taskkill 掉正在启动的宿主导致连接失败）
            needStart = await waitCloneRunning(75000);
          } else {
            const anchor = await currentCloneAnchor();
            needStart = await DesktopSession.start({
              winBounds: anchor.winBounds,
              anchorRect: anchor.anchorRect,
              ownerHwnd: anchor.ownerHwnd
            });
          }
          if (!needStart.success) {
            return { success: false, error: needStart.error || '桌面分身未能启动', needAuth: needStart.needAuth };
          }
        }
        const lr = await DesktopSession.launchInSession(program, progArgs, '');
        if (lr.success) cloneUsedInAgentRun = true;
        return {
          success: lr.success,
          state: lr.success ? 'running' : 'error',
          launch: lr,
          error: lr.error || undefined,
          desktopClone: {
            mode: 'childSession',
            sessionId: lr.sessionId,
            note: lr.success
              ? '已在隔离子会话（桌面分身预览小窗可见）启动程序，画面实时显示在输入栏上方的小窗里（预览，点不到画面；双击可剥离成大窗操作）；全程静默提权，无 UAC'
              : undefined
          }
        };
      }
      case 'launch_project': {
        const ProjectLauncher = require('../projectLauncher');
        // dir 默认用当前工作目录（workdir）
        const dir = args.dir || workdir || '';
        const r = await ProjectLauncher.launchProject(args.action || 'launch', { ...args, dir });
        // 成功启动了被测程序 → 记下它的窗口标题，后续截图/验证默认指向它（而非本应用）
        if (r && r.launched) {
          const t = r.windowTitleHint || r.name;
          setTestTarget({ title: t, dir, url: r.url });
          const note = '已记为当前被测程序：后续 capture_window / verify_ui 不传 title 时会默认抓它的窗口「' +
            t + '」' + (r.url ? '（页面地址 ' + r.url + '）' : '') + '；若标题不匹配，用 index 或显式 title 指定。';
          r.hint = r.hint ? (r.hint + ' ' + note) : note;
        }
        return r;
      }
      case 'ask_user':
        // 正常由 agentChat 循环拦截（在聊天里等用户点选/输入）；走到这里是异常或恢复链路漏出，
        // 直接给可继续的结果，绝不能把任务卡死
        return { success: true, answered: false, answer: '（此处无法向用户弹出选项，请按你判断的最佳方案继续执行，并在汇报里说明做法）' };
      default:
        return { success: false, error: '未知工具: ' + name };
    }
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// 对话取消控制（统一：普通对话 + Agent）
let activeReq = null;
let chatCancelled = false;
function cancelChat() {
  chatCancelled = true;
  // 用户停止任务时，正在等待的"询问用户"也要立即放行，否则循环会一直挂在 await 上
  if (pendingUserAsk) { const p = pendingUserAsk; pendingUserAsk = null; p.resolve({ success: true, answered: false, cancelled: true, answer: '（用户已停止任务）' }); }
  if (activeReq) { try { activeReq.destroy(); } catch(e) {} activeReq = null; }
}
function cancelAgentChat() { cancelChat(); }

// 本轮（一次 agentChat）是否已经写过长期记忆。收尾时用来判断要不要强制补写。
let memoryWrittenThisRound = false;

// 本轮 AI 任务有没有动过桌面分身（开了分身 / 在分身里启动程序 / 操作分身）。
// 有的话，agent-done 时自动把分身收掉 —— 用户要求"托盘运行直到 AI 运行完成，或者我点击关闭"。
// 只收"AI 这轮用过的"分身：用户自己从面板手动开的、AI 没碰过的，不动它。
let cloneUsedInAgentRun = false;

/**
 * 收尾强制更新记忆：选项目 且 本轮还没写入过记忆时，把本轮结论 + 改动蒸馏成一条记忆
 * 写进项目 memory.md，然后再结束。确定性执行，不依赖模型自己记得调 memory_save。
 * @returns {object|null} 写入的记忆摘要（未写/失败返回 null）
 */
function finalizeMemoryIfNeeded(workdir, summary, files) {
  if (!workdir || memoryWrittenThisRound) return null;
  const clean = String(summary || '').replace(/\s+/g, ' ').trim();
  const fileList = Array.isArray(files) ? files : [];
  if (!clean && !fileList.length) return null; // 没有任何可记的内容就不硬写
  try {
    MemoryStore.ensureScope(MemoryStore.scopePathForWorkdir(workdir));
    const parts = [];
    if (clean) parts.push(clean.slice(0, 300));
    if (fileList.length) parts.push('（本次涉及文件：' + fileList.slice(0, 8).join('、') + (fileList.length > 8 ? ' 等' : '') + '）');
    const text = '【项目收尾记录】' + parts.join('');
    const r = MemoryStore.add({
      text,
      kind: fileList.length ? 'fix' : 'project',
      tags: ['auto', path.basename(workdir)],
      source: 'auto-finalize'
    });
    memoryWrittenThisRound = true;
    console.log('[Agent] 收尾强制写入项目记忆:', r && r.item ? r.item.id : '(失败)');
    return r;
  } catch (e) {
    console.warn('[Agent] 收尾强制写记忆失败:', e.message);
    return null;
  }
}

/**
 * 生成一次任务的结构化收尾总结（做了什么 / 成果如何 / 注意点）。
 * ★ 用户要求：完成后由 AI 自己总结成果再存入记忆，而不是把聊天记录原文存进项目。
 * 用一次轻量 LLM 调用（不流式、小 maxTokens、20s 超时）生成总结；
 * 失败时退化为确定性的启发式摘要（改动文件 + 最终回答首行要点）。
 */
function heuristicRunSummary(userQuestion, finalAnswer, files, interrupted) {
  const parts = [];
  if (interrupted) parts.push('【未完成】达到最大迭代次数停止，改动可能不完整。');
  if (files && files.length) parts.push('改动 ' + files.length + ' 个文件：' + files.slice(0, 5).join('、') + (files.length > 5 ? ' 等' : '') + '。');
  const firstLine = String(finalAnswer || '').split('\n').map(s => s.trim()).filter(s => s.length > 5 && !s.startsWith('#'))[0] || '';
  if (firstLine) parts.push(firstLine.slice(0, 120));
  return parts.join(' ') || '完成一次对话，无文件改动。';
}

async function generateRunSummary(provider, userQuestion, finalAnswer, files, interrupted) {
  const fallback = heuristicRunSummary(userQuestion, finalAnswer, files, interrupted);
  try {
    if (!provider) return fallback;
    const fileList = (files || []).slice(0, 10).join('、') || '无';
    const msgs = [
      { role: 'system', content: '你是项目助理。把刚完成的任务浓缩成一条长期记忆，供以后的会话快速了解这次改动。要求：\n' +
        '1) 三行以内，依次写【做了什么】【成果如何】【注意点(可选)】；\n' +
        '2) 只写结论性信息，禁止复述对话原文或代码细节；\n' +
        '3) 总共 150 字以内，直接输出内容本身。' },
      { role: 'user', content: '用户问题：' + String(userQuestion || '').slice(0, 300) +
        '\n改动文件：' + fileList +
        '\n最终回答（节选）：' + String(finalAnswer || '').slice(0, 800) +
        (interrupted ? '\n（注意：本次任务因达到最大迭代次数被中断，改动可能未完成）' : '') }
    ];
    const summaryCall = callProviderAPI(provider, msgs, 0.3, 300, false, null, false);
    const timeout = new Promise(resolve => setTimeout(() => resolve(null), 20000));
    const r = await Promise.race([summaryCall, timeout]);
    const text = r && r.success ? String(r.content || '').trim() : '';
    if (!text || text.length < 4) return fallback;
    return text.slice(0, 400);
  } catch (e) {
    console.warn('[Agent] 收尾总结生成失败，用启发式摘要:', e.message);
    return fallback;
  }
}

/**
 * 任务收尾统一入口：生成总结 → 写入项目记忆 + changes/ 改动记录。
 * 替代旧的"直接把最终回答原文塞进记忆/changes"的做法。
 */
async function finalizeRunRecord({ workdir, provider, userQuestion, finalAnswer, files, interrupted, title }) {
  const fileList = Array.isArray(files) ? files : [];
  const summary = await generateRunSummary(provider, userQuestion, finalAnswer, fileList, interrupted);
  finalizeMemoryIfNeeded(workdir, summary, fileList);
  if (workdir && fileList.length) {
    try {
      ProjectWorkspace.appendChange(workdir, {
        title: title || '本次改动',
        question: userQuestion,
        summary,
        files: fileList
      });
    } catch (e) {
      console.warn('[Agent] 写入改动记录失败:', e.message);
    }
  }
  return summary;
}

// Agent 对话（支持工具调用循环 + 思考过程流式输出）

// 会话模式（普通聊天）仅允许「识别/解读类」工具，其它工具一律硬阻断。
// ensure_clone_desktop 是例外：它只开关一个 RDP 悬浮窗，不读写用户文件、不执行命令、
// 不操作别的程序，副作用仅是多一个用户自己看得见的窗口。用户在普通对话里说
// "打开桌面分身"如果被硬阻断，模型就只能反复解释而永远做不了（历史 bug）。
const RECOGNITION_TOOLS = _agentCfg.policy.recognitionTools || [];

async function agentChat({ messages, providerId, temperature, maxTokens, thinkMode, enabledTools, autoAuthorize, roleId, systemPrompt: customSystemPrompt, contextWindow, workdir, conversationId, interactive, source }, broadcastFn) {
  // 新对话：清空"本轮已允许工具"集合，每次任务开头重新确认一次敏感工具
  sessionAllowedTools = new Set();
  chatCancelled = false;
  memoryWrittenThisRound = false; // 每轮重置：收尾时判断本轮有没有写过记忆
  cloneUsedInAgentRun = false;    // 每轮重置：收尾时判断要不要自动收掉桌面分身
  // 告诉分身宿主"有 AI 任务在跑"：任务期间主程序被关掉也**不销毁**分身，只在后台继续跑
  // （用户要求："目前主程序点击 x 会直接关闭销毁，但是当有任务运行时不会关闭，会在后台运行"）。
  try { require('../desktopSession').setTaskRunning(true); } catch (e) { /* 忽略 */ }
  // 待办清单按会话隔离；前端没传时退化为 'default'（旧版本前端也能跑）
  // source: 'work'(工作模式) / 'pet'(宠物输入框) / 'conversation'(会话模式)。后两者之外的未知值按工作模式处理。
  const conversationMode = source === 'conversation';
  const convCtx = { conversationId: conversationId || 'default', allowedTools: conversationMode ? new Set(RECOGNITION_TOOLS) : null };
  // ask_user（询问用户）只有在支持选项卡 UI 的窗口（主窗口聊天传 interactive:true）才真正等待；
  // 桌宠等环境没有选项卡，直接按模型最佳判断继续，避免干等卡死
  const canAskUser = interactive === true;
  const provider = findProvider(providerId);
  if (!provider) return { success: false, error: '未找到 AI 提供商配置' };
  cancelLocalModelUnload();
  cancelOllamaUnload();
  localRequestInFlight = true;
  // 本地模型启动/加载要几十秒：把进度推进对话气泡，替代干等的"等待模型响应…"
  const notReady = await prepareLocalProvider(provider, (msg) => {
    try { emit('agent-content', { text: '\n> ' + msg, iteration: 0 }); } catch (e) { /* 忽略 */ }
  });
    if (notReady) { localRequestInFlight = false; return notReady; }
  // 确保函数结束时清理活动请求，释放网络和GPU资源
  const cleanup = () => {
    try { if (activeReq) { activeReq.destroy(); activeReq = null; } } catch(e) {}
    localRequestInFlight = false;
    if (provider && provider.local) scheduleLocalModelUnload();
  };

  // 加载角色配置（多角色智能体）
  const role = getAgentRoleById(roleId);
  // 关键：在角色 systemPrompt 后追加通用工具调用强制要求，确保所有角色（含自定义角色）都能正确输出 tool_calls
  const basePrompt = customSystemPrompt || role.systemPrompt || AGENT_SYSTEM_PROMPT;
  const roleSystemPrompt = basePrompt + `

## 工具调用强制要求（所有角色必须遵守）
- 当你决定需要使用工具时，**必须实际输出 tool_calls 结构化数据**，绝对不能只在思考（reasoning）中描述"我要调用xx工具"而不实际输出
- 思考（reasoning）只是你的内部规划过程，不是工具调用本身。只在思考中描述工具调用不会执行任何工具
- 如果你在思考中决定要调用某个工具，就必须在回答中实际输出该工具的 tool_calls 结构化数据（包含 name 和 arguments）
- 工具调用格式：输出包含 function.name 和 function.arguments 的 tool_calls 数组，不要用文本描述代替

## 边做边说（实时进度叙述，所有角色必须遵守）
- 每次调用工具之前，先用一句简短的正文说明你接下来要做什么（例如："先定位会话列表的渲染代码"、"再查看删除按钮的绑定逻辑"），然后立刻发起工具调用
- 多步任务中每完成一步、准备下一步时，也用一行正文说明进展和发现
- 这些正文会实时流式展示给用户，让用户看到"做到哪一步了"；不要攒到最后一次性总结
- 叙述必须简短（一句话），不要长篇大论，不要在叙述里编造工具结果`;
  let finalSystemPrompt = roleSystemPrompt;
  // Few-shot 示例注入（examples.yaml）：core.md 讲的是"规则"，这里补"示范答案长什么样"。
  // 放在强制要求之后 —— 放前面会被后面那段"必须输出 tool_calls"冲淡。
  try {
    const exBlock = _agentCfgRaw.renderExamples('agent');
    if (exBlock) finalSystemPrompt += exBlock;
  } catch (e) {
    console.warn('[Agent] 注入示例失败:', e.message);
  }
  // MCP 提示片段：只解释 mcp_ 前缀的来源与失败处理，工具 schema 本身已随请求发出。
  // 刻意写得很短 —— 这里是每轮都带的常驻开销。
  try {
    const mcpNotice = _mcp.buildPromptNotice();
    if (mcpNotice) finalSystemPrompt += mcpNotice;
  } catch (e) {
    console.warn('[Agent] 注入 MCP 提示失败:', e.message);
  }
  // 技能（能力包）索引：只列「名字 + 触发场景 + 读取路径」，全文让 AI 按需 read_file。
  try {
    const skillNotice = _marketplace.skillsNotice();
    if (skillNotice) finalSystemPrompt += skillNotice;
  } catch (e) {
    console.warn('[Agent] 注入技能提示失败:', e.message);
  }
  // 项目工作目录：若用户选择了项目，在 system prompt 末尾告知 AI 所有相对路径/命令都在此目录内进行
  // 个性化（人格 / 回复风格 / 自定义指令 / 近期动向）：追加在角色提示词之后，
  // ⚠️ 只能追加不能替换 —— 上面那段「工具调用强制要求」被冲掉的话 agent 就不调工具了。
  try {
    const pb = buildPersonalizationBlock({ forAgent: true });
    if (pb) finalSystemPrompt += '\n\n' + pb;
  } catch (e) { /* 个性化注入失败不影响主流程 */ }
  if (workdir) {
    finalSystemPrompt += `

## 当前项目工作目录
- 你当前的工作目录（项目根）是：${workdir}
- 所有相对路径（如 src/xxx.js、./data）都基于此目录解析；读写文件、列目录、搜索文件时，未给绝对路径的一律相对于该目录。
- 执行命令（run_shell）时也默认在此目录下运行。
- 除非用户明确要求操作其他位置，否则不要把文件写到该目录之外。
- 你的长期记忆与项目分析都保存在该项目的隐藏文件夹 .ai_workspace/ 下（memory/ 记忆、context/ 分析、changes/ 按天改动），跨会话保留，可随时用 read_file 查看核对。`;
  }
  // 选项目后：先初始化隐藏工作区（含三个子文件夹），并自动分析项目上下文——在理解用户问题之前注入
  if (workdir) {
    try {
      ProjectWorkspace.ensureInit(workdir);
      const pcBlock = ProjectContext.buildContextBlock(workdir, getLastUserMessage(messages));
      if (pcBlock) finalSystemPrompt += '\n\n' + pcBlock;
    } catch (e) {
      console.warn('[Agent] 生成项目上下文/初始化工作区失败:', e.message);
    }
  }
  // 长期记忆按项目隔离：选项目时存到 <项目>/.ai_workspace/memory/memory.json，否则用全局
  try {
    MemoryStore.ensureScope(MemoryStore.scopePathForWorkdir(workdir));
  } catch (e) {
    console.warn('[Agent] 切换记忆作用域失败:', e.message);
  }
  // 长期记忆注入：按当前问题的相关度挑若干条塞进系统提示词，让 AI 不用每次重新问用户
  try {
    const memBlock = MemoryStore.buildPromptBlock(getLastUserMessage(messages));
    if (memBlock) {
      finalSystemPrompt += '\n\n' + memBlock;
      console.log('[Agent] 已注入长期记忆（' + MemoryStore.stats().total + ' 条中挑选）');
    }
  } catch (e) {
    console.warn('[Agent] 注入长期记忆失败:', e.message);
  }
  // windows-mcp 已启用时：告诉 AI 本机界面操作优先用它的工具（比内置 control_computer 更准）
  try {
    const mcpTools = getMcpToolNames();
    const hasWinMcp = mcpTools.some(n => /snapshot|click|move|type|shortcut|screenshot|waitfor|clipboard/i.test(n));
    if (hasWinMcp) {
      finalSystemPrompt += '\n\n## 本机界面操作优先级\n'
        + '当前已启用 Windows MCP（截图/UIA元素树/鼠标键盘/剪贴板/文件注册表）。'
        + '需要操作用户本机程序界面时，**优先用 MCP 工具**（Snapshot 拿元素树、Click/Type 操作、Screenshot 截图、WaitFor 等待），'
        + '不要用内置 control_computer 纯坐标注入——MCP 的 UIA 语义定位更准、不依赖坐标猜测。';
    }
  } catch (e) { /* 忽略 */ }
  // 待办清单注入：让模型每一轮都能看到「整体目标 + 现在做到哪一步」，这是"保留实现过程"的关键
  try {
    const todoBlock = TodoStore.buildPromptBlock(convCtx.conversationId);
    if (todoBlock) {
      finalSystemPrompt += '\n\n' + todoBlock;
      console.log('[Agent] 已注入待办清单:', TodoStore.read(convCtx.conversationId).progress);
    }
  } catch (e) {
    console.warn('[Agent] 注入待办清单失败:', e.message);
  }
  // 会话模式约束：只允许识别/解读类工具，禁止启动程序/操作电脑/文件读写/命令执行等
  if (conversationMode) {
    finalSystemPrompt += `

## 当前为「会话模式」（普通对话）
- 你**只允许使用识别/解读类工具**来识别图片、截图、界面：analyze_screenshot（看图分析）、verify_ui（界面自验证）、capture_window（截取窗口画面）。
- **唯一例外的动作工具**：ensure_clone_desktop（打开桌面分身悬浮窗）。用户说"打开桌面分身"/"启动分身"时直接调用它，它只是开关一个用户可见的悬浮窗口，不读写文件、不执行命令。
- **禁止使用**其余动作类工具，即使用户明确要求也不行：launch_in_clone（启动程序）、control_computer（操作电脑）、run_shell、read_file、write_file、file_search、directory_list、web_search、web_fetch、memory_save 等。
- 如果用户想启动程序、操作电脑、读写文件、执行命令，请告诉用户：「这些操作请在『工作模式』（打开 Agent/工具开关）下进行，会话模式只支持看图识别。」`;
  }
  // 每次请求刷新一次 MCP 工具（内部有 5 秒 TTL，不会每次真去问子进程）
  const ALL_TOOLS = await getAllTools();
  const ALL_TOOL_NAMES = ALL_TOOLS.map(t => t.function.name);
  const roleTools = resolveRoleTools(role.tools, ALL_TOOL_NAMES);

  const temp = typeof temperature === 'number' ? temperature : (role.temperature || 0.7);
  const isOllama = provider.type === 'ollama';
  // token 上限：
  // - Ollama 模式：不自动提升，直接使用用户设置或默认值（Ollama 本地模型有自己的 token 管理，num_predict 默认 2048）
  // - 其他模式（API）：思考模式需要预留足够空间输出 tool_calls，默认提高到 8192；用户设置过低时强制提升
  let tokens;
  if (isOllama) {
    // Ollama 模式：不需要设置 max_tokens，不传递 num_predict，让 Ollama 使用自己的默认值
    // 用户显式设置了才传递，否则传 null 表示不设置
    tokens = maxTokens || null;
    console.log('[Agent] Ollama 模式，不设置 max_tokens，使用 Ollama 默认 num_predict');
  } else {
    // 其他模式：思考模式默认提高到 8192，预留足够空间输出思考和工具调用
    tokens = maxTokens || (thinkMode ? 8192 : 4096);
    // 安全兜底：思考模式下若用户设置过低（<2048），强制提升，避免思考耗尽 token 导致工具调用被截断
    if (thinkMode && tokens < 2048) tokens = 8192;
  }
  let accumulatedContent = '';
  // ── 闲聊/寒暄判定（提前到工具筛选之前，供"最小化工具"和"关思考"共用）──
  // ⚠️ 严格防误判：除了消息本身像闲聊，还要求"本轮对话还没走过工具/助手回合"——
  //    否则用户在任务中途说"好的/继续"也会被当成闲聊，导致工具被砍掉、任务答非所问。
  const lastUserMsgForChat = getLastUserMessage(messages) || '';
  const priorAssistantTurnsForChat = (messages || []).filter(m => m && m.role === 'assistant').length;
  const priorToolCallsForChat = (messages || []).some(m => m && Array.isArray(m.tool_calls) && m.tool_calls.length);
  const looksLikeChattyMsg = ProjectContext.isChattyMessage(lastUserMsgForChat);
  const skipThinkForChat = looksLikeChattyMsg && priorAssistantTurnsForChat <= 1 && !priorToolCallsForChat;
  if (looksLikeChattyMsg && !skipThinkForChat) {
    console.log('[Agent] 消息像闲聊但对话已在进行中（assistantTurns=' + priorAssistantTurnsForChat + ', priorToolCalls=' + priorToolCallsForChat + '），按任务处理');
  }
  // 根据设置过滤工具：优先用用户指定的 enabledTools，否则用角色配置的工具。
  // 注意：早期前端只暴露了 5 个工具，enabledTools 一旦非空就会把 web_search 等关键工具
  // 静默屏蔽掉，模型"有想法没工具"→ 反复重试 → 空输出。这里做三层兜底：
  // ① 过滤掉不存在的工具名；② 过滤后为空则回退角色工具；③ 运行时模型点名了已注册但未启用的工具，自动放行。
  // 工具权限策略：
  // - 无风险工具（只读/安全）：始终默认启用，不需要用户在设置中勾选
  // - 有风险工具：需要用户在设置中显式启用（enabledTools），且执行前需要确认
  const requestedTools = Array.isArray(enabledTools)
    ? enabledTools.filter(n => ALL_TOOL_NAMES.includes(n))
    : [];
  // MCP 工具的启用由 mcpManager 的 enabled 集合决定（用户在设置页勾选），
  // 不走「安全工具默认全开」那套 —— 外部进程默认不该被自动授权。
  const mcpToolNames = getMcpToolNames();
  // 无风险工具 = 全部工具 - 有风险工具 - MCP 工具（MCP 一律要显式勾选）
  const safeToolNames = ALL_TOOL_NAMES.filter(n => !RISKY_TOOLS.has(n) && !mcpToolNames.includes(n));
  // 有风险工具 = 用户显式启用的 ∩ 角色允许的
  const enabledRiskyTools = requestedTools.filter(n => RISKY_TOOLS.has(n) && roleTools.includes(n));
  // MCP 工具 = mcpManager 已启用的全部工具（用户在连通器/MCP 商城里手动启停，
  // 不受角色 tools 列表限制——角色里列不全 mcp_xxx 这种动态名字）
  const enabledMcpTools = mcpToolNames.slice();
  // 最终启用的工具 = 无风险工具（角色允许的）+ 用户显式启用的有风险工具 + 已启用的 MCP 工具
  const activeToolNames = [
    ...safeToolNames.filter(n => roleTools.includes(n)),
    ...enabledRiskyTools,
    ...enabledMcpTools
  ];
  let activeTools = ALL_TOOLS.filter(t => activeToolNames.includes(t.function.name));
  if (conversationMode) {
    // 会话模式：仅暴露识别/解读类工具，其余硬屏蔽（含MCP 工具与回退逻辑）
    activeToolNames.length = 0;
    RECOGNITION_TOOLS.forEach(n => { if (ALL_TOOL_NAMES.includes(n)) activeToolNames.push(n); });
    activeTools = ALL_TOOLS.filter(t => activeToolNames.includes(t.function.name));
    console.log('[Agent] 会话模式：工具已限制为识别/解读类:', activeToolNames.join(','));
  } else if (activeTools.length === 0) {
    console.log('[Agent] 工具过滤后无可用工具，回退为角色工具:', roleTools.join(','));
    activeToolNames.length = 0;
    roleTools.forEach(n => activeToolNames.push(n));
    activeTools = ALL_TOOLS.filter(t => activeToolNames.includes(t.function.name));
  }
  if (mcpToolNames.length) {
    console.log('[Agent] MCP 工具已注入(' + enabledMcpTools.length + '/' + mcpToolNames.length + '):', enabledMcpTools.join(','));
  }
  console.log('[Agent] 本次会话可用工具(' + activeTools.length + '):', activeToolNames.join(','));

  // ── 闲聊/寒暄：工具列表最小化 ──
  // "你好"这种消息根本不需要 run_shell / read_file / web_search，全量 schema 灌进去
  // 既费 token 又容易让模型手痒调工具。只留 memory/todo 这类非侵入性工具，其他全砍。
  if (skipThinkForChat && !conversationMode) {
    const CHAT_KEEP_TOOLS = new Set(['memory_save', 'memory_search', 'memory_list', 'memory_delete', 'todo_write', 'todo_update', 'todo_read']);
    const kept = activeTools.filter(t => CHAT_KEEP_TOOLS.has(t.function.name));
    if (kept.length < activeTools.length) {
      activeTools = kept;
      activeToolNames.length = 0;
      activeTools.forEach(t => activeToolNames.push(t.function.name));
      console.log('[Agent] 闲聊消息：工具最小化，仅保留', activeToolNames.join(',') || '（空）');
    }
  }

  // ── 工具路由：按用户问题筛选相关工具，减少 token ──
  // 工具总数多的时候，只露相关的工具给模型，省显存。
  // 工具少时自动跳过（router 内部判断阈值），不会影响体验。
  if (!conversationMode && activeTools.length >= 15) {
    const lastUserMsg = getLastUserMessage(messages) || '';
    const routeResult = _toolRouter.route(activeTools, lastUserMsg, {
      mcpToolIndex: _mcp._state.toolIndex
    });
    if (routeResult.filtered) {
      activeTools = routeResult.tools;
      activeToolNames.length = 0;
      activeTools.forEach(t => activeToolNames.push(t.function.name));
      console.log('[Agent] 工具路由生效: ' + routeResult.reason);
    }
  }

  // 模型点名了已注册但当前未启用的工具 → 自动放行，避免"想用却用不了"的死循环
  const ensureToolEnabled = (name) => {
    if (!name || !ALL_TOOL_NAMES.includes(name)) return false;
    // 会话模式：非识别/解读类工具一律拒绝自动启用（硬阻断）
    if (conversationMode && !RECOGNITION_TOOLS.includes(name)) {
      console.log('[Agent] 会话模式拒绝自动启用非识别工具:', name);
      return false;
    }
    if (activeToolNames.includes(name)) return true;
    // 角色的工具范围仍然生效：角色明确排除的工具不自动放行
    if (!roleTools.includes(name)) {
      console.log('[Agent] 工具 ' + name + ' 不在当前角色允许范围内，拒绝自动启用');
      return false;
    }
    console.log('[Agent] 工具 ' + name + ' 未在启用列表中，按模型请求自动放行');
    // MCP 工具不走「模型点名就自动放行」：外部进程的工具必须用户在设置里显式启用。
    // 否则模型只要猜到mcp_xxx 名字就能让本应用去起子进程。
    if (getMcpToolNames().includes(name)) {
      console.warn('[Agent] MCP 工具未在 mcpManager 中启用，拒绝自动放行:', name);
      return false;
    }
    activeToolNames.push(name);
    const def = ALL_TOOLS.find(t => t.function.name === name);
    if (def) activeTools.push(def);
    emit('agent-content', { text: '\n> 自动启用「' + toolLabelCN(name) + '」（模型请求）', iteration });
    return true;
  };

  // 构建消息：角色系统提示词 + 历史（历史里 role=ai 需归一化为 assistant）
  const fullMessages = [{ role: 'system', content: finalSystemPrompt }, ...normalizeAgentMessages(messages)];

  const emit = (type, data) => {
    if (broadcastFn) broadcastFn('ai:response', { type, ...data, roleId: role.id });
    // 任务收尾：本轮 AI 动过桌面分身 → 自动收掉。
    // 用户要求"托盘运行直到 AI 运行完成，或者我点击关闭"——AI 跑完就是其中一条结束条件。
    // 用户自己从面板手动开、AI 没碰过的分身不受影响（cloneUsedInAgentRun 只在本轮被工具置位）。
    if (type === 'agent-done' && cloneUsedInAgentRun) {
      cloneUsedInAgentRun = false;
      console.log('[Agent] 本轮任务结束，自动收掉桌面分身');
      try { require('../desktopSession').stop({ graceMs: 1500 }); } catch (e) { /* 忽略 */ }
    } else if (type === 'agent-done') {
      // 本轮没动过分身：也要把"任务在跑"标记清掉，否则主窗口关掉后分身会一直挂着
      try { require('../desktopSession').setTaskRunning(false); } catch (e) { /* 忽略 */ }
    }
  };

  let iteration = 0;
  let emptyRetryUsed = false;  // 模型空内容自动重试（只重试一次）
  // 用户要求无硬上限：高强度多步任务不强制中断。
  // role.maxIterations 缺失或 <= 0 都视为不限；正数才作为硬上限。
  // 仍有两道软刹车防死循环：模型连续"只说不做"重试上限、400 错误重试上限。
  const configuredMax = Number(role.maxIterations);
  const maxIterations = (!configuredMax || configuredMax <= 0) ? Number.POSITIVE_INFINITY : configuredMax;
  let hasRetriedNoToolCalls = false; // 防止"只说不做"无限重试
  let hasRetriedMalformed = false;   // 防止"请求体不合法(400)"重试死循环
  let currentThinkMode = thinkMode; // 重试时可关闭 think 模式，强制模型直接输出 tool_calls
  // 闲聊/寒暄（"你好"、"谢谢"）：强制关闭思考模式（skipThinkForChat 在上面工具筛选前已算好）
  if (skipThinkForChat) {
    currentThinkMode = false;
    console.log('[Agent] 闲聊消息（"' + lastUserMsgForChat.slice(0, 20) + '"），本轮强制关闭思考模式');
  }
  // 待办收尾对账：本轮碰过待办清单（规划或推进过），交答案前必须让清单落地，
  // 否则模型干完活直接回答、清单停在 0/3 —— 用户看到的现象就是"做完了但不会画线结束"。
  let todoTouched = false;
  let todoReconciled = false;
  let toolExecutedLastIteration = false; // 上一轮是否执行了工具（用于判断模型回答是中间步骤还是最终答案）
  // 模型点名了某工具、但被权限拦下时记下来：收尾要用它给出"该去哪放开"的明确提示，
  // 而不是把模型的推脱（"我无法打开"）或一句驴唇不对马嘴的"请开启思考模式"丢给用户。
  let blockedToolName = '';
  let blockedToolReason = '';

  // 「先检查项目再解析需求」门禁：选了项目时，模型在给出最终答案前必须真的读过一次项目代码
  // （read_file / file_search / directory_list）。只给它一份静态项目摘要它仍会凭空猜，
  // 所以这里在代码层卡一道：没检查过就退回一轮，要求先检查项目再作答（只退一次，避免死循环）。
  let projectInspected = false;
  let projectInspectNudged = false;
  const INSPECT_TOOLS = new Set(['read_file', 'file_search', 'directory_list']);

  // 「先检查项目再动手（改代码）」门禁：选了项目、模型还没读过任何项目代码就想写文件 → 拦截，
  // 强制它先 read_file 看真实代码再改。解决"AI 不看项目就乱改"。
  // 最多拦 WRITE_GATE_MAX 次后放行（附警告），避免模型反复硬闯导致死循环。
  const WRITE_GATE_MAX = 2;
  let writeGateBlocks = 0;
  const shouldBlockWrite = (toolName) => {
    if (!workdir) return false;               // 没选项目 → 不拦
    if (!WRITE_TOOLS.has(toolName)) return false; // 只拦写类工具
    if (projectInspected) return false;       // 已检查过 → 放行
    return true;
  };
  const writeGateResult = (toolName) => ({
    success: false,
    error: '已拦截：还没检查过项目代码，不能直接' + toolLabelCN(toolName) + '。',
    hint: '先检查项目再动手：用 file_search / directory_list 定位相关文件，用 read_file 读关键文件，' +
      '确认现状与调用链后，再基于你实际看到的代码来改。不要凭项目摘要或猜测盲改。'
  });

  // 本轮「写过/改过」的文件清单 → 收尾时随 agent-done 发出，渲染端做成可点击的列表。
  // 用途：AI 的收尾总结里要列「改了哪些文件」，这里给的是**系统实际记录**，
  // 比让模型自己回忆可靠；渲染端把路径做成可点击打开。
  const changedFiles = new Map(); // 绝对路径 → 相对项目根的展示路径
  // 本轮用过的工具名（记进「近期动向」，用于 AI 进化训练）
  const usedToolNames = new Set();
  const WRITE_TOOLS = new Set(['write_file', 'create_directory', 'copy_file', 'move_file', 'download_file']);
  const recordChangedFile = (rawPath) => {
    try {
      if (!rawPath || typeof rawPath !== 'string') return;
      const abs = path.isAbsolute(rawPath) ? rawPath : path.resolve(workdir || process.cwd(), rawPath);
      if (changedFiles.has(abs)) return;
      let rel = abs;
      if (workdir) {
        const base = path.resolve(workdir);
        if (abs === base || abs.startsWith(base + path.sep)) rel = abs.slice(base.length + 1) || path.basename(abs);
      }
      changedFiles.set(abs, rel.replace(/\\/g, '/'));
    } catch (e) { /* 路径解析失败就不记，不影响任务 */ }
  };

  // 工具结果 → tool 消息内容。失败/被拒时附加 hint，把"换思路继续"落到代码层——
  // 提示词规范只是兜底，模型每轮真正读到的是这条回灌的 tool 消息。
  // 这正是"部分工具不可用时自己想办法，而不是一报错就结束"的机制保障。
  const toolMsgContent = (r, denied) => {
    if (r && r.success === false) {
      return JSON.stringify({
        ...r,
        hint: denied
          ? '用户拒绝了此操作：不要绕过用户意愿，改用更安全的方式达成目标；确有必要时向用户说明原因请求允许，然后继续任务。'
          : '此工具调用失败不代表任务失败。请阅读 error 分析原因，然后换一种可行方式继续：修正参数重试、改用其他可用工具或方法、或把步骤拆细。不要因此终止任务，也不要编造已成功。'
      });
    }
    return JSON.stringify(r);
  };

  while (iteration < maxIterations) {
    if (chatCancelled) { emit('agent-done', { content: '(已停止)', iteration }); cleanup(); if (provider.type === 'ollama') unloadOllamaModel(provider); return { success: true, content: accumulatedContent, cancelled: true }; }
    iteration++;
    emit('agent-iteration', { iteration, maxIterations });

    // —— 上下文护栏：请求体估算超过窗口时，从最旧开始精简工具轮次，避免"越过限制思考回答" ——
    // 窗口由渲染层按模型识别/用户覆盖后传入；本进程看不到完整历史外的固定开销，预留输出 token 后
    // 以「窗口 − 输出预留 − 512」为输入上限。精简后仍放不下 → 明确报错，不再发必然被上游拒绝的请求。
    const ctxWindow = (typeof contextWindow === 'number' && contextWindow > 0) ? contextWindow : 0;
    if (ctxWindow > 0) {
      const outputReserve = provider.type === 'ollama' ? 0 : (tokens || 4096);
      const maxInputTokens = Math.max(512, ctxWindow - outputReserve - 512);
      let est = estimateMessagesTokens(fullMessages);
      // 主进程不做静默 prune：压缩完全交给前端按 95% 阈值触发，
      // 避免前端显示 22% 但主进程已经偷偷删了历史
      if (est > maxInputTokens) {
        console.log('[Agent] 上下文真超窗口：估算', est, 'tokens / 上限', maxInputTokens, '，停止执行');
        emit('agent-done', { content: '上下文已超出模型窗口上限，无法继续执行。请新建会话或手动压缩上下文后重试。', iteration, error: true });
        cleanup();
        if (provider.type === 'ollama') unloadOllamaModel(provider);
        return { success: false, error: '上下文超出模型窗口上限' };
      }
    }

    // 调用 API（带 tools）
    const result = await callProviderAPIWithTools(provider, fullMessages, temp, tokens, activeTools, currentThinkMode, (delta) => {
      if (chatCancelled) return;
      // 流式推送：思考过程 / 正文 / 工具调用
      if (delta.reasoning) emit('agent-reasoning', { text: delta.reasoning, iteration });
      if (delta.content) { accumulatedContent += delta.content; emit('agent-content', { text: delta.content, iteration }); }
      if (delta.toolCall) emit('agent-tool-call-start', { tool: delta.toolCall, iteration });
    });

    if (!result.success) {
      // 关键修复：错误/截断时必须广播结束事件，否则前端一直显示"等待模型响应..."
      const errMsg = result.error || 'AI 调用失败';
      console.log('[Agent] 调用失败:', errMsg);
      // 偶发 400（上游解析请求体失败，多为流式输出被截断后残留的半截工具参数）：
      // 丢弃最近一轮工具调用相关消息后重试一次，避免整段对话直接失败
      if (!hasRetriedMalformed && isMalformedRequestError(errMsg)) {
        hasRetriedMalformed = true;
        const removed = dropTailToolRound(fullMessages);
        if (removed > 0) {
          console.log('[Agent] 检测到请求体不合法(400)，已清理异常上下文消息数=' + removed + '，重试一次');
          emit('agent-content', { text: '\n> 上游拒绝了本次请求（上下文里存在不完整的工具参数），已清理异常上下文并自动重试...', iteration });
          iteration--; // 重试不占用迭代次数
          continue;
        }
      }
      emit('agent-content', { text: '\n\n> ⚠️ ' + errMsg, iteration });
      emit('agent-done', { content: errMsg, iteration, error: true });
      cleanup();
      if (provider.type === 'ollama') unloadOllamaModel(provider);
      return { success: false, error: errMsg };
    }

    // 把助手回复加入消息
    const assistantMsg = { role: 'assistant', content: result.content || '' };
    if (result.toolCalls && result.toolCalls.length > 0) {
      assistantMsg.tool_calls = result.toolCalls;
    }
    fullMessages.push(assistantMsg);

    // 没有工具调用
    if (!result.toolCalls || result.toolCalls.length === 0) {
      const reasoningText = result.reasoning || '';
      const contentText = result.content || '';
      // rawContent 是模型真正输出的正文；content 可能是"从思考末尾兜底提取"的、
      // 判断"模型有没有给出回答"必须用 rawContent，否则兜底文本会掩盖"没输出"的事实
      const realContent = (result.rawContent !== undefined ? result.rawContent : result.content) || '';
      // 关键修复：不能取数组末尾（那里是刚 push 的 assistant 消息），必须从后往前找真正的 user 消息
      const lastUserMsg = getLastUserMessage(fullMessages);

      // 手动执行一次"被识别出来的"工具调用：伪造 tool_calls 消息 → 执行 → 回灌结果
      const runExtractedTool = async (extracted, source) => {
        if (!extracted) return false;
        if (!ensureToolEnabled(extracted.name)) {
          // 提取到了但被权限/模式拦下 —— 与"根本没提取到"是两回事，必须分开记日志，
          // 否则两者都表现为"方案A 无效"，排查时完全看不出卡在哪一环。
          blockedToolName = extracted.name;
          blockedToolReason = conversationMode ? 'conversation' : 'role';
          console.log('[Agent-诊断] 恢复链路中断：已提取 ' + extracted.name + '（来源：' + source
            + '）但被 ensureToolEnabled 拒绝（会话模式=' + conversationMode
            + ' / 角色允许=' + roleTools.includes(extracted.name) + '）');
          return false;
        }
        fullMessages.pop(); // 移除刚 push 的 assistantMsg
        const fakeToolCallId = 'extracted_' + Date.now();
        // 关键：Ollama 的历史里 arguments 必须是对象（传字符串会导致下一次请求 400
        // "Value looks like object, but can't find closing '}'"），OpenAI 兼容接口则要求字符串
        const argsForHistory = provider.type === 'ollama' ? extracted.arguments : JSON.stringify(extracted.arguments);
        fullMessages.push({
          role: 'assistant',
          content: '',
          tool_calls: [{ id: fakeToolCallId, type: 'function', function: { name: extracted.name, arguments: argsForHistory } }]
        });
        emit('agent-tool-exec', { tool: extracted.name, args: extracted.arguments, iteration });
        emit('agent-content', { text: '\n> ' + source + '，正在执行 ' + toolLabelCN(extracted.name) + '...', iteration });
        let toolResult;
        // 【询问用户】在恢复链路里同样直接等用户选择（不走 60s 工具超时）
        if (extracted.name === 'ask_user') {
          if (!canAskUser) {
            toolResult = { success: true, answered: false, answer: '（当前环境无法向用户弹出选项，请按你判断的最佳方案继续执行，并在最终汇报里说明做法）' };
          } else {
            try { toolResult = await requestUserGuidance(extracted.arguments || {}, emit); }
            catch (e) { toolResult = { success: false, error: e.message || '询问用户失败' }; }
          }
          emit('agent-tool-result', { tool: extracted.name, result: toolResult, iteration });
          fullMessages.push({ role: 'tool', tool_call_id: fakeToolCallId, content: toolMsgContent(toolResult, false) });
          return true;
        }
        // 安全：走恢复链路执行的敏感工具（run_shell / write_file）同样要过用户确认，
        // 不能因为"是从文本里解析出来的"就绕过确认弹窗
        // 优化：用户显式勾选启用的风险工具（enabledRiskyTools）自动执行不弹窗，
        // 只有模型请求的未启用工具才需要确认
        const isUserEnabledRiskyTool = enabledRiskyTools.includes(extracted.name) || activeToolNames.includes(extracted.name);
        if (!autoAuthorize && !isUserEnabledRiskyTool && TOOLS_REQUIRE_CONFIRM.has(extracted.name)) {
          const confirm = await requestToolConfirm(extracted.name, extracted.arguments, emit, isUserEnabledRiskyTool);
          if (!confirm.allowed) {
            toolResult = { success: false, error: '用户拒绝执行' + (confirm.reason ? '（' + confirm.reason + '）' : '') };
            emit('agent-tool-result', { tool: extracted.name, result: toolResult, iteration, denied: true });
            fullMessages.push({ role: 'tool', tool_call_id: fakeToolCallId, content: toolMsgContent(toolResult, true) });
            return true;
          }
        }
        // 「先检查项目再动手」门禁：未检查项目就想写文件 → 拦截（与 function-call 路径同一判定）
        if (shouldBlockWrite(extracted.name) && writeGateBlocks < WRITE_GATE_MAX) {
          writeGateBlocks++;
          console.log('[Agent] 写入门禁(文本恢复路径)：未检查项目，拦截 ' + extracted.name + '（第 ' + writeGateBlocks + ' 次）');
          toolResult = writeGateResult(extracted.name);
          emit('agent-content', { text: '\n> 还没检查过项目代码，先读相关文件再改（已拦截 ' + toolLabelCN(extracted.name) + '）', iteration });
          fullMessages.push({ role: 'tool', tool_call_id: fakeToolCallId, content: toolMsgContent(toolResult, false) });
          emit('agent-tool-result', { tool: extracted.name, result: toolResult, iteration, blocked: true });
          return true;
        }
        try {
          const toolPromise = executeTool(extracted.name, extracted.arguments, workdir, convCtx);
          const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('工具执行超时(60s)')), 60000));
          toolResult = await Promise.race([toolPromise, timeoutPromise]);
        } catch (toolErr) {
          toolResult = { success: false, error: toolErr.message || '工具执行失败' };
        }
        console.log('[Agent] 手动执行工具结果:', extracted.name, 'success=', toolResult.success, (toolResult.error || '').substring(0, 100));
        if (toolResult && toolResult.success && WRITE_TOOLS.has(extracted.name)) {
          recordChangedFile((extracted.arguments || {}).path || (extracted.arguments || {}).source || (extracted.arguments || {}).dest);
        }
        // 读过一次项目代码 → 视为已"检查项目"（与下面 function-call 路径同一判定）
        if (INSPECT_TOOLS.has(extracted.name)) projectInspected = true;
        fullMessages.push({ role: 'tool', tool_call_id: fakeToolCallId, content: toolMsgContent(toolResult, false) });
        emit('agent-tool-result', { tool: extracted.name, result: toolResult, iteration });
        return true;
      };

      // 方案A0：模型把 tool_calls 当普通文本写进了正文（提示词强制输出时最常见）→ 直接解析执行
      // 不限制迭代次数：只要模型确实写出了合法调用就应该执行
      let extracted = extractToolCallFromText(contentText, ALL_TOOL_NAMES);
      if (extracted && await runExtractedTool(extracted, '从回答中识别到工具调用')) continue;

      // 方案A：模型只在思考里说要调用但没输出（"只说不做"）→ 从思考/用户问题里推断
      // mentionedTools 用 ALL_TOOL_NAMES 而非 activeToolNames：
      // 模型点名了某个"当前未启用"的工具时也要能进入恢复链路，
      // 由 ensureToolEnabled 按角色范围决定是否放行，而不是在门禁这一步就被悄悄跳过。
      const mentionedTools = ALL_TOOL_NAMES.filter(name => reasoningText.includes(name));
      const actionWords = ['搜索', '查找', '查询', '抓取', '写入', '执行', '调用', '下载', '打开', '计算', '列出', '复制', '移动', '创建', '读取', '检查', '获取'];
      const mentionedAction = actionWords.some(w => reasoningText.includes(w));
      const mentionedCallIntent = /调用|执行|使用|search|fetch|write|read|shell|tool/i.test(reasoningText);
      // ⚠️ inferredTool 与 extractToolCallFromReasoning 必须用**同一套意图强度规则**选，
      //   否则会出现"提示里说调 A、实际执行 B"的错位（两者都只用于拼重试示例/执行决策）。
      //   这里取"意图分最高"的那个，而不是首个或最后一个出现的。
      const scoredTools = mentionedTools
        .map(name => ({ name, score: intentScoreOfToolMention(reasoningText, name) }))
        .filter(t => t.score > 0)
        .sort((a, b) => b.score - a.score);
      // 诊断日志：这轮"只说不做"的完整判定链，之前这条链路静默失败过多次，必须可观测
      console.log('[Agent-诊断] mentionedTools=' + JSON.stringify(mentionedTools)
        + ' 意图分=' + JSON.stringify(scoredTools.map(t => t.name + ':' + t.score))
        + ' mentionedAction=' + mentionedAction
        + ' mentionedCallIntent=' + mentionedCallIntent
        + ' realContent长度=' + String(realContent || '').length
        + ' iteration=' + iteration
        + ' 角色允许工具=' + JSON.stringify(roleTools));
      let inferredTool = scoredTools.length ? scoredTools[0].name : '';
      if (!inferredTool) {
        if (/搜索|查找|查询|最新|资讯|百科/i.test(reasoningText) || /搜索|查找|查询|最新|资讯|百科/i.test(lastUserMsg)) inferredTool = 'web_search';
        else if (/抓取|网页|链接|url|http/i.test(reasoningText)) inferredTool = 'web_fetch';
        else if (/写入|文件|代码|脚本|保存/i.test(reasoningText)) inferredTool = 'write_file';
        else if (/执行|命令|运行|shell|cmd/i.test(reasoningText)) inferredTool = 'run_shell';
        else if (/读取|查看|内容|文件/i.test(reasoningText)) inferredTool = 'read_file';
      }
      // 只有在模型确实"没给出可用回答"时才去推断工具：
      // ① 正文为空；② 正文是推脱/表示做不到（此时手里明明有工具，应该代替它执行）。
      // 否则模型已经给出了正式回答，不该再强行插一次工具调用。
      const looksLikeInability = /无法(直接)?(访问|搜索|获取|打开|联网|读取)|不能(直接)?(访问|搜索|获取)|没法|抱歉|请自行|建议您|建议通过|自己(搜索|查(找|询)?)|没有权限|不支持|暂不|没有相关工具/.test(contentText);
      const noUsableAnswer = !realContent.trim() || looksLikeInability;
      const shouldRetryNoToolCalls = noUsableAnswer && !hasRetriedNoToolCalls && iteration <= 2
        && (mentionedTools.length > 0 || mentionedAction || mentionedCallIntent) && inferredTool;

      if (shouldRetryNoToolCalls) {
        let inferred = null;
        // 通用提取：优先命中"模型点名了某个无必填参数的工具"（如 ensure_clone_desktop），
        // 其次才是 web_search / web_fetch 的关键词/URL 提取。
        inferred = extractToolCallFromReasoning(reasoningText, lastUserMsg, ALL_TOOLS);
        if (inferred) console.log('[Agent] 从思考中提取到工具调用:', inferred.name, JSON.stringify(inferred.arguments).substring(0, 200));
        else console.log('[Agent-诊断] 方案A 未能从思考中提取到任何可执行工具（思考长度=' + reasoningText.length
          + '，无必填参数的工具全都没被"意图句"点名命中）');
        // 兜底：拿用户原始问题当搜索词（这一步过去因为 lastUserMsg 取错而一直失效）
        if (!inferred && inferredTool === 'web_search' && lastUserMsg && lastUserMsg.length >= 2) {
          // 只去掉首尾的客套词，保留核心关键词（过度清洗会把"影视飓风的官网"洗成"影视飓风出来"）
          let searchQuery = lastUserMsg
            .replace(/^(帮我|请|麻烦|我想|我想要|请问|能不能|可以)+/i, '')
            .replace(/(给我|一下|呢|吧|啊|谢谢| thanks)+$/i, '')
            .replace(/[？?。.！!~～,，、\s]+$/, '')
            .trim();
          if (searchQuery.length < 2) searchQuery = lastUserMsg;
          if (searchQuery.length > 50) searchQuery = searchQuery.substring(0, 50);
          inferred = { name: 'web_search', arguments: { query: searchQuery, max_results: 5 } };
          console.log('[Agent] 直接用用户问题构造 web_search：', lastUserMsg.substring(0, 100), '→', searchQuery);
        }
        if (!inferred && inferredTool !== 'web_search') {
          inferred = extractToolCallFromReasoning(reasoningText, lastUserMsg, ALL_TOOLS);
          if (inferred) console.log('[Agent] 从思考中提取到工具调用:', inferred.name, JSON.stringify(inferred.arguments).substring(0, 200));
        }
        if (inferred && await runExtractedTool(inferred, '从思考中识别到工具调用')) continue;
      }

      // 方案B：仍拿不到可执行的调用 → 退回到重试（关闭思考模式 + 强制要求输出 tool_calls）
      // ⚠️ 前提是"模型点名的工具确实在当前可用列表里"。若它被权限拦下（角色没放开 / 会话模式），
      //    还把工具名硬塞进"唯一正确的响应格式"里，模型只会回一个空响应 ——
      //    用户看到的就是"既没启动、也没回答"。这种情况不重试，改由下面的明确提示收尾。
      const canForceTool = activeToolNames.includes(inferredTool);
      if (shouldRetryNoToolCalls && !canForceTool) {
        console.log('[Agent] 推断工具 ' + inferredTool + ' 不在当前可用范围（' + activeToolNames.length
          + ' 个工具中），跳过 tool_calls 重试，将由明确提示收尾');
      }
      if (shouldRetryNoToolCalls && canForceTool) {
        hasRetriedNoToolCalls = true;
        console.log('[Agent] 检测到模型"只说不做"：推断工具=' + inferredTool + ' content=' + contentText.length + '字符 reasoning=' + reasoningText.length + '字符，自动重试一次');
        fullMessages.pop();
        const toolExample = inferredTool === 'web_search'
          ? '{"name":"web_search","arguments":{"query":"搜索关键词"}}'
          : inferredTool === 'web_fetch'
          ? '{"name":"web_fetch","arguments":{"url":"https://example.com"}}'
          : inferredTool === 'write_file'
          ? '{"name":"write_file","arguments":{"path":"C:\\\\Users\\\\用户名\\\\Desktop\\\\file.txt","content":"文件内容"}}'
          : inferredTool === 'run_shell'
          ? '{"name":"run_shell","arguments":{"command":"dir"}}'
          : '{"name":"' + inferredTool + '","arguments":{}}';
        fullMessages.push({
          role: 'user',
          content: '【强制要求】你刚才只在思考中描述了要执行操作，但没有实际输出 tool_calls！\n\n现在思考模式已关闭，你必须直接输出 tool_calls 结构化数据，不要输出任何文本描述，不要输出思考摘要，不要说"我要调用xx工具"。\n\n立即输出以下格式的 tool_calls（这是唯一正确的响应方式）：\n' + toolExample
        });
        // 关键：重试时关闭 think 模式，强制模型直接输出 tool_calls（qwen3小模型在think模式下倾向于只描述不输出）
        if (currentThinkMode) {
          currentThinkMode = false;
          console.log('[Agent] 重试时已关闭 think 模式，强制模型直接输出 tool_calls');
        }
        emit('agent-content', { text: '\n> 检测到模型未实际调用工具，自动重试（已关闭思考模式，强制输出 tool_calls）...', iteration });
        continue;
      }

      // 模型点名了工具、但被权限拦下（且它没能给出可用回答）→ 直接给出"该去哪放开"的说明收尾。
      // 这条分支就是"用户说打开桌面分身，结果既没启动、回答还是驴唇不对马嘴"的收口点。
      if (blockedToolName && noUsableAnswer) {
        const blockedHint = buildBlockedToolHint(blockedToolName, blockedToolReason);
        console.log('[Agent] 工具被权限拦下（' + blockedToolName + '），改用明确提示收尾');
        emit('agent-content', { text: '\n\n> ' + blockedHint, iteration });
        emit('agent-done', { content: blockedHint, iteration, usage: result.usage });
        cleanup();
        if (provider.type === 'ollama') unloadOllamaModel(provider);
        return { success: true, content: blockedHint, iterations: iteration, empty: true };
      }

      // 边界情况：有思考过程但没有正文也没有工具调用（模型"想了但没做"）
      // 注意：callProviderAPIWithTools 已尝试从 thinking 末尾兜底提取回答到 result.content
      if (!result.content || !result.content.trim()) {
        // 自动重试一次：长工具循环后模型偶发返回空内容，重发请求通常能拿到正文
        if (!emptyRetryUsed) {
          emptyRetryUsed = true;
          console.log('[Agent] 模型返回空内容，自动重试一次（iteration=' + iteration + '）');
          continue;
        }
        const noToolHint = activeTools.length === 0
          ? '当前没有任何可用工具（设置里的「启用工具」为空），请在对话设置中至少启用 web_search 等工具后重试。'
          : '';
        const hint = noToolHint
          || (result.reasoning && result.reasoning.length > 50
            ? '模型完成思考但未输出回答或工具调用（finishReason=' + (result.finishReason || 'unknown') + '）。常见原因：所需工具未启用、token 上限不足或模型不支持工具调用。可在设置中开启「思考模式」、启用 web_search 等工具后重试。'
            : '模型未返回有效内容（finishReason=' + (result.finishReason || 'unknown') + '）。请重试；若频繁出现，请在设置中开启「思考模式」或增大最大 Token。');
        console.log('[Agent] 无正文无工具调用，finishReason=' + result.finishReason + ' reasoning=' + (result.reasoning || '').length + '字符 totalLines=' + result.totalLines + ' 可用工具=' + activeTools.length);
        emit('agent-content', { text: '\n\n> ' + hint, iteration });
        emit('agent-done', { content: hint, iteration, usage: result.usage });
        cleanup();
        if (provider.type === 'ollama') unloadOllamaModel(provider);
        return { success: true, content: hint, iterations: iteration, empty: true };
      }
      // ---- 待办收尾对账（"做完了但清单不会画线结束"的根治点）----
      // 模型很容易规划完就闷头干活、干完直接给答案而忘了更新清单；不能指望它记得，交答案前卡一道：
      // 本轮碰过待办且还有未完成项 → 退回一轮，要求它先按事实把清单落地（完成 / 或说明为什么没做）。
      if (todoTouched && !todoReconciled) {
        const pending = TodoStore.read(convCtx.conversationId).items.filter(i => i.status !== 'completed');
        if (pending.length) {
          todoReconciled = true;
          const listText = pending.map(i => '- ' + i.id + ' ' + i.text).join('\n');
          console.log('[Agent] 待办收尾对账：还有', pending.length, '条未完成，要求模型先更新清单');
          emit('agent-content', { text: '\n> 待办清单还有 ' + pending.length + ' 条未标记完成，先对账再收尾...', iteration });
          // 把"已经说出口的答案"补成 assistant 消息，保持对话结构正常（避免连续两条 user）
          fullMessages.push({ role: 'assistant', content: result.content || '（继续）' });
          fullMessages.push({
            role: 'user',
            content: '【收尾检查】你还没更新待办清单，下面这些条目的状态与事实不符：\n' + listText +
              '\n\n请立刻用 todo_update 逐条处理：真的做完了就标记 status=completed 并在 note 写清结果/证据；' +
              '没做或没做完的保持 pending 并在 note 写明原因，不要谎报完成。' +
              '处理完（可以一次调多个 todo_update）再给最终答复。'
          });
          continue;
        }
      }
      // —— 工具执行后模型只输出文本没有 tool_calls：判断是中间步骤还是最终答案 ——
      // 本地模型/Ollama 常把"下一步要做什么"写成文本而不是结构化 tool_calls，
      // 如果刚执行过工具且回答较短/含继续意图，注入提示要求继续输出工具调用。
      if (toolExecutedLastIteration && iteration < maxIterations - 1) {
        const intermediatePatterns = /(接下来|下一步|然后|现在|让我|我需要|我将|需要继续|还需要|再|接着|随后|首先|其次|最后|let me|next|then|now|i need|i will|continue|further|also|additionally)/i;
        const isIntermediate = intermediatePatterns.test(contentText) && contentText.length < 500;
        const hasNoFinalAnswer = !/(总结|综上|因此|所以|最终|完成|好了|以上就是|希望|in summary|to summarize|therefore|finally|done|complete)/i.test(contentText);
        if (isIntermediate && hasNoFinalAnswer) {
          console.log('[Agent] 检测到工具执行后的中间步骤回答（' + contentText.length + '字符），注入继续提示');
          fullMessages.push({
            role: 'user',
            content: '你刚才执行了工具并得到了结果。如果任务还未完成，请直接输出下一个 tool_calls 结构化数据（包含 name 和 arguments），不要只输出文本描述。如果任务已经完成，请给出最终答案。'
          });
          emit('agent-content', { text: '\n> 检测到中间步骤，要求模型继续执行...', iteration });
          continue;
        }
      }
      // ---- 「先检查项目再解析需求」门禁 ----
      // 选了项目、但模型还没读过任何项目代码就想给最终答案 → 退回一轮，要求先检查项目。
      // 只退回一次（projectInspectNudged），避免模型 stubborn 死循环；第二次仍不检查就放行。
      // 「好的/谢谢」这类极短回复不触发（>25 字才算实质回答），避免无意义读文件。
      // ⚠️ 闲聊/寒暄（"你好"、"谢谢"）即使回复超 25 字也不触发门禁——那不是项目任务，没必要读代码。
      //    判定复用开头的 skipThinkForChat（含上下文感知：对话已在进行中就不判闲聊）。
      if (skipThinkForChat && workdir && !projectInspected && !projectInspectNudged) {
        console.log('[Agent] 门禁跳过：闲聊/寒暄，不强制检查项目代码');
      }
      if (workdir && !projectInspected && !projectInspectNudged && (result.content || '').trim().length > 25 && !skipThinkForChat) {
        projectInspectNudged = true;
        console.log('[Agent] 门禁：本轮尚未检查项目代码，要求模型先检查再作答（iteration=' + iteration + '）');
        emit('agent-content', { text: '\n> 尚未检查项目代码，先检查相关文件再回答...', iteration });
        // 把已说出口的答案补成 assistant 消息，保持对话结构（避免连续两条 user）
        fullMessages.push({ role: 'assistant', content: result.content || '（继续）' });
        fullMessages.push({
          role: 'user',
          content: '【检查项目】在给出最终回答前，你还没有读过本项目的任何代码。请先用工具检查项目，把用户的问题对应到真实文件上：\n' +
            '1) 用 file_search / directory_list 定位与问题相关的文件；\n' +
            '2) 用 read_file 读关键文件，确认现状与调用链；\n' +
            '3) 再基于你实际看到的代码，解析用户需求并回答。\n' +
            '不要只凭项目摘要凭空猜测。如果确实与代码无关（如纯概念问题），明确说明理由后再回答。'
        });
        continue;
      }
      // 收尾：AI 自己总结"做了什么/成果如何"后写入项目记忆与 changes/，不再存聊天原文
      try {
        await finalizeRunRecord({
          workdir,
          provider,
          userQuestion: getLastUserMessage(messages),
          finalAnswer: result.content,
          files: Array.from(changedFiles.values())
        });
      } catch (e) {
        console.warn('[Agent] 收尾记录失败(忽略):', e.message);
      }
      emit('agent-done', { content: result.content, iteration, usage: result.usage, changedFiles: Array.from(changedFiles.values()) });
      // 记录一条「近期动向」：用户最近在做什么、用了哪些工具（供 AI 进化训练与个性化）
      recordEvolution({
        mode: 'agent',
        user: getLastUserMessage(messages),
        project: workdir || '',
        tools: Array.from(usedToolNames),
        summary: (result.content || '').slice(0, 300)
      });
      cleanup();
      if (provider.type === 'ollama') unloadOllamaModel(provider);
      // reasoning 随返回值带回渲染端，作为思考过程持久化的兜底
      return { success: true, content: result.content, reasoning: result.reasoning, iterations: iteration, changedFiles: Array.from(changedFiles.values()) };
    }

    toolExecutedLastIteration = false;
    // ★ 工具前的「为什么做这一步」：思考模式下模型常把「下一步要做什么」写进 reasoning、正文留空。
    // 直接执行工具的话，用户只能看到折叠的「思考结束」+工具卡片，看不到理由。这里从本轮思考末尾
    // 提炼一句自然语言说明，作为正文在首个工具执行前补发，让「思考到哪、正文写到哪」。
    let nextStepNotice = '';
    if (result.toolCalls && result.toolCalls.length && !(result.content || '').trim() && result.reasoning) {
      nextStepNotice = extractNextStepNotice(result.reasoning, activeToolNames);
    }
    // 执行工具调用
    // ── 保守并行：同一批 tool_calls 里 >=2 个只读工具时，预执行并行跑 executeTool ──
    // 只读工具无副作用（read_file / directory_list / file_search / web_search / web_fetch / check_url / get_system_info），
    // 并行跑省 IO 等待（文档 3.2 PASTE 思路）。写类/确认类/ask_user/MCP 仍串行，避免顺序错乱。
    const READ_ONLY_PARALLEL = new Set(['read_file', 'directory_list', 'file_search', 'web_search', 'web_fetch', 'check_url', 'get_system_info']);
    const preExecResults = new Map(); // tc.id -> { fnArgs, toolResult }
    if (result.toolCalls && result.toolCalls.length >= 2) {
      const roCalls = result.toolCalls.filter(tc => {
        const name = (tc.function?.name || '').trim();
        if (!READ_ONLY_PARALLEL.has(name)) return false;
        if (mcpToolNames.includes(name)) return false; // MCP 不并行
        if (!ALL_TOOL_NAMES.includes(name)) return false;
        return true;
      });
      if (roCalls.length >= 2) {
        console.log('[Agent] 并行预执行只读工具(' + roCalls.length + '):', roCalls.map(tc => tc.function.name).join(','));
        await Promise.all(roCalls.map(async (tc) => {
          const name = tc.function.name.trim();
          let fnArgs = {};
          try {
            fnArgs = typeof tc.function.arguments === 'object' && tc.function.arguments
              ? tc.function.arguments
              : (typeof tc.function.arguments === 'string' && tc.function.arguments.trim()
                ? JSON.parse(tc.function.arguments) : {});
          } catch (e) { fnArgs = {}; }
          try {
            const toolResult = await Promise.race([
              executeTool(name, fnArgs, workdir, convCtx),
              new Promise(resolve => setTimeout(() => resolve({
                success: false, error: '工具执行超时（60秒），已自动终止。'
              }), 60000))
            ]);
            preExecResults.set(tc.id, { fnArgs, toolResult });
          } catch (toolErr) {
            preExecResults.set(tc.id, { fnArgs, toolResult: { success: false, error: '工具执行异常: ' + (toolErr.message || String(toolErr)) } });
          }
        }));
      }
    }
    for (const tc of result.toolCalls) {
      const fnName = (tc.function?.name || '').trim();
      if (fnName) usedToolNames.add(fnName);
      // 工具名校验：必须是已注册的工具，避免模型输出多个工具名拼接等异常。
      // 已注册但未启用的工具按模型请求自动放行，避免"模型想用、列表里没有"直接失败。
      if (fnName && ALL_TOOL_NAMES.includes(fnName) && !activeToolNames.includes(fnName)) ensureToolEnabled(fnName);
      const validToolNames = activeTools.map(t => t.function.name);
      if (!fnName || !validToolNames.includes(fnName)) {
        console.log('[Agent] 跳过无效工具调用:', fnName, '，可用:', validToolNames.join(','));
        fullMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          // 脱敏：不再回显 'fnName + 可用工具全列表'（那会把整套内部函数名发给模型并可能显示在工具结果里）
          content: toolMsgContent({ success: false, error: '未知工具「' + toolLabelCN(fnName) + '」，它不在当前可用工具列表中，请换用其它方式完成。' }, false)
        });
        continue;
      }
      // 本轮动过待办清单 → 收尾时要对账（见下面"待办收尾对账"）
      if (fnName === 'todo_write' || fnName === 'todo_update') todoTouched = true;
      // 读过一次项目代码 → 视为已"检查项目"
      if (INSPECT_TOOLS.has(fnName)) projectInspected = true;
      let fnArgs = {};
      const rawArgs = tc.function?.arguments;
      if (rawArgs && typeof rawArgs === 'object') {
        // Ollama 格式：arguments 已经是对象
        fnArgs = rawArgs;
      } else if (typeof rawArgs === 'string' && rawArgs.trim()) {
        // OpenAI 格式：arguments 是 JSON 字符串
        try { 
          fnArgs = JSON.parse(rawArgs); 
        } catch(e) { 
          console.log('[Agent] arguments JSON 解析失败，尝试修复:', rawArgs.substring(0, 100));
          // 先按"半截 JSON"修复（补未闭合引号/括号），再退回常见的引号、多余逗号修复
          let fixed = repairTruncatedJson(rawArgs);
          if (!fixed) fixed = rawArgs.replace(/'/g, '"').replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
          try {
            fnArgs = JSON.parse(fixed);
            tc._argsIncomplete = true;
          } catch(e2) {
            fnArgs = {};
            tc._argsIncomplete = true;
            emit('agent-tool-result', { tool: fnName, result: { success: false, error: '工具参数解析失败: ' + rawArgs.substring(0,200) }, iteration });
          }
        }
        // ⚠️ 此处曾有一句错位的 toolExecutedLastIteration=true + continue（2026-10-02 修复）：
        // 它写在"字符串参数解析"分支内部，导致 OpenAI 格式（绝大多数云端模型）的工具调用
        // 解析完参数就被 continue 跳过、从不执行也不回灌结果 → 模型拿不到工具结果，
        // 反复重试或 400，最终"部分工具无法使用→错误导致结束"。已删除。
      }
      if (tc._argsIncomplete) {
        // 参数被截断/修复过：必须让用户知道，风险工具一律重新确认，避免拿残缺参数执行写文件/跑命令
        console.log('[Agent] 警告: 工具参数不完整（已尽力修复）:', fnName, JSON.stringify(fnArgs).substring(0, 120));
        emit('agent-content', { text: '\n> 模型输出被截断，' + toolLabelCN(fnName) + ' 的参数不完整（已自动补全），请核对后再执行。', iteration });
      }
      console.log('[Agent] 工具调用:', fnName, '参数:', JSON.stringify(fnArgs).substring(0, 200));

      // 「先检查项目再动手」门禁：未检查项目就想写文件 → 拦截（最多 2 次后放行，避免死循环）
      if (shouldBlockWrite(fnName) && writeGateBlocks < WRITE_GATE_MAX) {
        writeGateBlocks++;
        console.log('[Agent] 写入门禁：未检查项目，拦截 ' + fnName + '（第 ' + writeGateBlocks + ' 次）');
        const gateResult = writeGateResult(fnName);
        emit('agent-content', { text: '\n> 还没检查过项目代码，先读相关文件再改（已拦截 ' + toolLabelCN(fnName) + '）', iteration });
        emit('agent-tool-result', { tool: fnName, result: gateResult, iteration, blocked: true });
        fullMessages.push({ role: 'tool', tool_call_id: tc.id, content: toolMsgContent(gateResult, false) });
        continue;
      }
      if (shouldBlockWrite(fnName)) {
        // 已被拦截多次仍不检查 → 放行但明确警告，让它知道违反了流程
        console.log('[Agent] 写入门禁：已拦截 ' + writeGateBlocks + ' 次仍坚持写，放行并警告（iteration=' + iteration + '）');
        emit('agent-content', { text: '\n> 警告：你还没检查项目代码就要改文件，本次已放行，但很可能改错地方。', iteration });
      }

      // nextStepNotice 不再作为正文补发：reasoning 已在思考块里流式显示，
      // 重复发送会导致同一句话出现在思考块和正文两处。用户想看"为什么执行这个工具"展开思考块即可。
      // if (nextStepNotice) {
      //   emit('agent-content', { text: nextStepNotice, iteration });
      //   nextStepNotice = '';
      // }
      emit('agent-tool-exec', { tool: fnName, args: fnArgs, iteration });

      // 需要用户确认的工具
      let toolResult;
      // 优化：用户显式勾选启用的风险工具自动执行不弹窗——包括参数被截断的情况。
      // 用户已勾选即表达信任，参数即便不完整也按自动补全后的值放行执行，
      // 不再强制弹窗核对（避免"写文件内容一长就弹窗、点慢了还失败"）。
      const isUserEnabledRiskyTool2 = enabledRiskyTools.includes(fnName) || activeToolNames.includes(fnName);
      // MCP 工具**一律弹窗**，不受"用户勾选过就免确认"的优化影响：
      // 外部 server 的工具用户没直接经手，参数也可能超出预期（如 openapi 导入的任意 API）。
      const isMcpTool = mcpToolNames.includes(fnName);
      const needConfirm = isMcpTool
        ? _mcp.needConfirm(fnName)
        : (TOOLS_REQUIRE_CONFIRM.has(fnName)
          && (!autoAuthorize && !isUserEnabledRiskyTool2));
      if (needConfirm) {
        const confirm = await requestToolConfirm(fnName, fnArgs, emit, isUserEnabledRiskyTool2);
        if (!confirm.allowed) {
          toolResult = { success: false, error: '用户拒绝执行' + (confirm.reason ? '（' + confirm.reason + '）' : '') };
          emit('agent-tool-result', { tool: fnName, result: toolResult, iteration, denied: true });
          fullMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: toolMsgContent(toolResult, true)
          });
          continue;
        }
      }

      // 【询问用户】特殊工具：不走 60s 工具超时，直接在聊天里等用户点选/自定义输入（上限 10 分钟）。
      // 仅在支持交互的主窗口等待；桌宠等无选项卡 UI 的环境按模型最佳判断继续，避免干等卡死。
      if (fnName === 'ask_user') {
        let askResult;
        if (!canAskUser) {
          askResult = { success: true, answered: false, answer: '（当前环境无法向用户弹出选项，请按你判断的最佳方案继续执行，并在最终汇报里说明做法）' };
        } else {
          try { askResult = await requestUserGuidance(fnArgs, emit); }
          catch (e) { askResult = { success: false, error: e.message || '询问用户失败' }; }
        }
        emit('agent-tool-result', { tool: fnName, result: askResult, iteration });
        fullMessages.push({ role: 'tool', tool_call_id: tc.id, content: toolMsgContent(askResult, false) });
        continue;
      }

      // 为工具执行添加超时保护，避免工具挂起导致整个对话卡死。
      // 桌面分身类工具首次启动要建 RDP 子会话（DesktopSession.start 自带 75s 兜底），给 120s；
      // 其余工具保持 60s，既防挂死又不至于让普通工具卡太久。
      const toolTimeoutMs = CLONE_DESKTOP_TOOLS.has(fnName) ? 120000 : (mcpToolNames.includes(fnName) ? 150000 : 60000);
      const toolStartTime = Date.now();
      // 心跳：每5秒推送一次工具执行状态，避免前端显示"暂停"
      const heartbeatInterval = setInterval(() => {
        emit('agent-tool-progress', { tool: fnName, elapsed: Date.now() - toolStartTime, iteration });
      }, 5000);

      // 并行预执行命中：直接用缓存结果，不再重新跑 executeTool
      const preHit = preExecResults.get(tc.id);
      if (preHit) {
        clearInterval(heartbeatInterval); // 工具已跑完，心跳不需要了
        toolResult = preHit.toolResult;
        if (preHit.fnArgs && Object.keys(preHit.fnArgs).length) fnArgs = preHit.fnArgs;
        console.log('[Agent] 命中并行预执行缓存:', fnName);
      } else {
      try {
        toolResult = await Promise.race([
          executeTool(fnName, fnArgs, workdir, convCtx),
          new Promise(resolve => setTimeout(() => resolve({
            success: false,
            error: `工具执行超时（${toolTimeoutMs/1000}秒），已自动终止。请检查命令是否需要交互输入、网络连接或文件权限。`
          }), toolTimeoutMs))
        ]);
      } catch (toolErr) {
        toolResult = { success: false, error: '工具执行异常: ' + (toolErr.message || String(toolErr)) };
      } finally {
        clearInterval(heartbeatInterval);
      }
      }
      
      const toolDuration = Date.now() - toolStartTime;
      console.log('[Agent] 工具执行完成:', fnName, '耗时:', toolDuration + 'ms', '成功:', toolResult.success);
      if (toolResult && toolResult.success && WRITE_TOOLS.has(fnName)) {
        recordChangedFile(fnArgs.path || fnArgs.source || fnArgs.dest);
      }
      emit('agent-tool-result', { tool: fnName, result: toolResult, iteration, duration: toolDuration });

      // ── 结果校验 → 压缩 → 反思：工具结果进上下文之前的三道处理 ──
      // 顺序：先硬校验（格式/脱敏/截断），再压缩（长文本瘦身），最后软反思（质量自检警告）
      const isMcpCall = mcpToolNames.includes(fnName);
      // 1. 结果校验器：格式清洗 + 敏感信息脱敏 + 超长截断
      const validation = _resultValidator.validate(fnName, toolResult, { isMcp: isMcpCall });
      toolResult = validation.result;
      // 2. 上下文压缩器：长文本自动瘦身（行级去重 + 智能截断）
      if (toolResult && typeof toolResult.content === 'string') {
        const compressed = _contextCompressor.compress(toolResult.content, { toolName: fnName });
        if (compressed.compressed) {
          toolResult.content = compressed.text;
        }
      }
      // 3. 反思器：结果质量自检，发现可疑之处附加警告
      const reflection = _reflector.reflect(fnName, toolResult, fnArgs);
      if (reflection.flagged) {
        toolResult = reflection.modifiedResult;
      }

      // 工具结果加入消息（失败时附"换思路继续"提示，避免模型一遇错就放弃）
      fullMessages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: toolMsgContent(toolResult, false)
      });
    }
    // 本轮处理过工具调用（执行/被拒/无效/解析失败都会回灌 tool 消息）→ 标记，
    // 供下一轮"模型只输出中间步骤文本时注入继续提示"的逻辑使用
    toolExecutedLastIteration = true;
  }

  // 收尾（中断也要留痕）：同样走"AI 总结 → 记忆/改动记录"，标注未完成
  try {
    await finalizeRunRecord({
      workdir,
      provider,
      userQuestion: getLastUserMessage(messages),
      finalAnswer: '达到最大迭代次数后停止，部分改动可能未最终完成。',
      files: Array.from(changedFiles.values()),
      interrupted: true,
      title: '已达最大迭代次数（中断）'
    });
  } catch (e) {
    console.warn('[Agent] 中断收尾记录失败(忽略):', e.message);
  }
  emit('agent-done', { content: '（已达到最大迭代次数，停止执行）', iteration, changedFiles: Array.from(changedFiles.values()) });
  cleanup();
  // 主动卸载 Ollama 模型，释放 GPU 显存
  if (provider.type === 'ollama') unloadOllamaModel(provider);
  return { success: true, content: fullMessages[fullMessages.length - 1]?.content || '', iterations: iteration, truncated: true };
}

// 主动从 GPU 显存卸载 Ollama 模型（keep_alive:0 有时不会立即生效，主动调用更保险）
// Ollama 延迟卸载：回答结束后 5 分钟无新请求才卸载，避免持续对话反复加载
let ollamaUnloadTimer = null;
const OLLAMA_UNLOAD_DELAY_MS = 5 * 60 * 1000;
function cancelOllamaUnload() {
  if (ollamaUnloadTimer) { clearTimeout(ollamaUnloadTimer); ollamaUnloadTimer = null; }
}
function unloadOllamaModelImmediate(provider) {
  try {
    const baseUrl = (provider.apiUrl || 'http://localhost:11434').replace(/\/$/, '');
    const body = JSON.stringify({ model: provider.model, keep_alive: 0, stream: false });
    const url = new URL(baseUrl + '/api/generate');
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, () => {});
    req.on('error', () => {});
    req.setTimeout(3000, () => { try { req.destroy(); } catch(e) {} });
    safeWriteRequest(req, body);
    console.log('[Agent] 已请求卸载 Ollama 模型:', provider.model);
  } catch (e) {
    console.log('[Agent] 卸载模型失败:', e.message);
  }
}
function unloadOllamaModel(provider) {
  cancelOllamaUnload();
  ollamaUnloadTimer = setTimeout(() => {
    ollamaUnloadTimer = null;
    if (localRequestInFlight) { unloadOllamaModel(provider); return; }
    unloadOllamaModelImmediate(provider);
  }, OLLAMA_UNLOAD_DELAY_MS);
}

// 手动释放 GPU 显存：卸载所有已配置的 Ollama 模型（用户可在设置中点击触发）
function releaseGPUMemory() {
  let count = 0;
  if (aiConfig?.cloudProviders) {
    for (const p of aiConfig.cloudProviders) {
      if (p.type === 'ollama' && p.model) {
        unloadOllamaModelImmediate(p);
        count++;
      }
    }
  }
  console.log('[Agent] 手动释放 GPU 显存，已请求卸载', count, '个 Ollama 模型');
  return { success: true, unloaded: count };
}

// ==================== 请求体健壮性（防"Unterminated string"类 400） ====================
// 背景：模型流式输出被 token 上限截断或连接中断时，累积到的 tool_calls.arguments 可能是半截
// JSON（如 '{"query":"影视飓风 2025'）。这些残缺参数会被原样写回对话历史，下一次请求上游
// 解析该字符串就会失败 → HTTP 400 "Unterminated string starting at: line 1 column 65 (char 64)"
// （偶现：只在特定截断轮次出现）。因此：① 修复半截 JSON；② 每次请求前统一消毒 messages；
// ③ 无法修复的参数降级为空对象，绝不让非法 JSON 进入请求体。

// 补全未闭合的引号/括号（不保证语义正确，只保证结果是合法 JSON）
function closeOpenStructures(str) {
  let out = '';
  const stack = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (esc) { out += ch; esc = false; continue; }
    if (ch === '\\') { out += ch; if (inStr) esc = true; continue; }
    if (ch === '"') { out += ch; inStr = !inStr; continue; }
    out += ch;
    if (inStr) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (esc) out = out.slice(0, -1);                                  // 末尾孤立的反斜杠
  if (inStr) out += '"';                                            // 未闭合的字符串
  out = out.replace(/[,\s]+$/, '');                                 // 悬挂的逗号
  if (/:\s*$/.test(out)) out = out.replace(/:\s*$/, ':null');       // 悬挂的冒号
  while (stack.length) out += (stack.pop() === '{' ? '}' : ']');     // 补齐括号
  return out;
}

// 把半截 JSON 字符串修复成合法 JSON 字符串；无法修复返回 null
function repairTruncatedJson(src) {
  const raw = String(src == null ? '' : src).trim();
  if (!raw) return null;
  try { JSON.parse(raw); return raw; } catch (_) { /* 继续修复 */ }
  // 先只补全结构；仍失败则逐个裁掉尾部字符重试（应对 '...{"a":tru' 这类半截字面量）
  for (let i = 0; i < 80 && raw.length - i > 1; i++) {
    const cand = closeOpenStructures(i === 0 ? raw : raw.slice(0, raw.length - i));
    try { JSON.parse(cand); return cand; } catch (_) { /* 再裁一个字符 */ }
  }
  return null;
}

// 统一工具调用 arguments 形态：OpenAI 兼容=合法 JSON 字符串；Ollama=对象
// 返回 'ok' | 'repaired' | 'broken'；非 ok 时打上 _argsIncomplete 标记供上层提醒用户
function normalizeToolCallArgs(tc, isOllama) {
  if (!tc || !tc.function) return 'broken';
  const args = tc.function.arguments;
  if (args && typeof args === 'object') {
    tc.function.arguments = isOllama ? args : JSON.stringify(args);
    return 'ok';
  }
  if (typeof args !== 'string' || !args.trim()) {
    tc.function.arguments = isOllama ? {} : '{}';
    return 'ok';
  }
  try {
    const obj = JSON.parse(args);
    // Ollama 的历史要求 arguments 是对象，传 JSON 字符串同样会 400
    if (isOllama && obj && typeof obj === 'object') tc.function.arguments = obj;
    return 'ok';
  } catch (_) { /* 半截 JSON，走修复 */ }
  const fixed = repairTruncatedJson(args);
  if (fixed) {
    tc.function.arguments = isOllama ? JSON.parse(fixed) : fixed;
    tc._argsIncomplete = true;
    return 'repaired';
  }
  tc.function.arguments = isOllama ? {} : '{}';
  tc._argsIncomplete = true;
  return 'broken';
}

// 判断 content 是否为有效的多模态内容数组（OpenAI 兼容格式）
// 有效格式：[{ type: 'text', text: '...' }, { type: 'image_url', image_url: { url: 'data:...' } }]
function isValidMultimodalContent(content) {
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every(part => {
    if (!part || typeof part !== 'object') return false;
    const t = part.type;
    if (t === 'text') return typeof part.text === 'string';
    if (t === 'image_url') return part.image_url && typeof part.image_url.url === 'string';
    if (t === 'input_image') return typeof part.url === 'string' || (part.image && typeof part.image === 'string');
    return false; // 未知类型不认为是有效多模态
  });
}

// 消毒多模态 content 数组：清理 text 中的非法字符，校验 image_url 格式
function sanitizeMultimodalContent(content) {
  return content.map(part => {
    if (part.type === 'text' && typeof part.text === 'string') {
      return {
        type: 'text',
        text: part.text
          .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
          .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
          .replace(/\u0000/g, '')
      };
    }
    if (part.type === 'image_url' && part.image_url) {
      return { type: 'image_url', image_url: { url: String(part.image_url.url) } };
    }
    return part;
  });
}
// 发送前消毒 messages：半截工具参数、孤立代理项、缺失/孤立的工具响应都会让上游 400
function sanitizeOutgoingMessages(messages, isOllama) {
  if (!Array.isArray(messages)) return messages;
  const notes = [];
  const cleaned = [];
  let remap = null; // 仅在"重命名了重复 id"后，用于同步改写紧随其后的 tool 消息
  for (const m of messages) {
    if (!m || typeof m !== 'object' || typeof m.role !== 'string') continue;
    const msg = { ...m };
    // content 必须是字符串（对象会被上游拒绝）；顺带剔除孤立代理项与 NUL
    if (msg.content !== null && msg.content !== undefined && typeof msg.content !== 'string') {
      if (isValidMultimodalContent(msg.content)) {
        msg.content = sanitizeMultimodalContent(msg.content);
        notes.push('multimodal-content-kept');
      } else {
        msg.content = typeof msg.content === 'object' ? JSON.stringify(msg.content) : String(msg.content);
      }
    }
    if (typeof msg.content === 'string') {
      const before = msg.content;
      msg.content = msg.content
        .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
        .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
        .replace(/\u0000/g, '');
      if (before !== msg.content) notes.push('content-sanitized');
    }
    if (msg.role === 'tool' && remap && msg.tool_call_id && remap.has(msg.tool_call_id)) {
      msg.tool_call_id = remap.get(msg.tool_call_id);
    } else if (msg.role !== 'tool') {
      remap = null;
    }
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      const kept = [];
      // 注意：id 只在"同一条消息内"去重。不同轮次复用 'call_0' 这类回退 id 是正常现象，
      // 跨消息去重会打断 id 与工具结果的配对，反而制造孤立 tool 消息。
      const seenIds = new Set();
      for (const tc of msg.tool_calls) {
        if (!tc || !tc.function || !tc.function.name) { notes.push('drop-empty-toolcall'); continue; }
        let id = (typeof tc.id === 'string' && tc.id.trim()) ? tc.id : 'call_' + kept.length;
        if (seenIds.has(id)) {
          const newId = id + '_' + seenIds.size;
          remap = remap || new Map();
          remap.set(id, newId);
          notes.push('dup-toolcall-id');
          id = newId;
        }
        tc.id = id;
        tc.type = 'function';
        seenIds.add(id);
        const st = normalizeToolCallArgs(tc, isOllama);
        if (st !== 'ok') notes.push('args-' + st + ':' + tc.function.name);
        kept.push(tc);
      }
      if (kept.length) msg.tool_calls = kept;
      else { delete msg.tool_calls; remap = null; }
    }
    cleaned.push(msg);
  }
  // 上游要求：assistant 的每个 tool_call_id 后面必须跟一条对应 tool 消息，缺了就补，否则 400
  const out = [];
  for (let i = 0; i < cleaned.length; i++) {
    out.push(cleaned[i]);
    const ids = (cleaned[i].tool_calls || []).map(tc => tc.id).filter(Boolean);
    if (!ids.length) continue;
    const answered = new Set();
    for (let j = i + 1; j < cleaned.length && cleaned[j].role === 'tool'; j++) {
      if (cleaned[j].tool_call_id) answered.add(cleaned[j].tool_call_id);
    }
    for (const id of ids) {
      if (answered.has(id)) continue;
      out.push({ role: 'tool', tool_call_id: id, content: JSON.stringify({ success: false, error: '（该工具调用未返回结果，已自动补齐占位）' }) });
      notes.push('fill-tool-result');
    }
  }
  // 丢弃找不到对应工具调用的孤立 tool 消息（上游同样会 400）
  const finalMsgs = out.filter((m, idx) => {
    if (m.role !== 'tool') return true;
    for (let j = idx - 1; j >= 0; j--) {
      const tcs = out[j].tool_calls;
      if (tcs && tcs.length) return tcs.some(tc => tc.id === m.tool_call_id);
      if (out[j].role === 'user') break;
    }
    notes.push('drop-orphan-tool-msg');
    return false;
  });
  if (notes.length) console.log('[Agent] 请求体消毒:', notes.slice(0, 8).join(','), '(共' + notes.length + '处)');
  return finalMsgs;
}

// 判断是否为"请求体不合法"类 400（上游/中转解析请求 JSON 失败）
function isMalformedRequestError(errMsg) {
  if (!errMsg) return false;
  return /Unterminated string|BadRequestError|forward bad request|invoke model error|invalid_request_error|HTTP 400/i.test(String(errMsg));
}

// 估算一组消息的 token（与 approxTokens 同一口径，含角色/字段开销）
function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let t = 0;
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    t += approxTokens(m.content || '') + 8;
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        t += approxTokens(tc?.function?.arguments || '') + 12;
      }
    }
  }
  return t;
}

// 从消息数组头部丢弃"assistant(带 tool_calls) + 其后 tool 结果"整轮，直到估算 ≤ maxTokens。
// 用于 Agent 循环内上下文护栏：历史（含工具结果）逼近窗口上限时，较早的工具轮次已无保留价值，
// 整轮删除（assistant + tool 成对）不会破坏后续 tool_call_id 的配对关系。
// 返回实际移除的消息条数；0 表示没有可清理的工具轮次。
function pruneHeadToolRounds(messages, maxTokens) {
  if (!Array.isArray(messages) || messages.length <= 2) return 0;
  let removed = 0;
  let guard = 0;
  while (messages.length > 2 && estimateMessagesTokens(messages) > maxTokens && guard++ < 20) {
    // 找第一处"assistant 带 tool_calls"（跳过首条 system 与最新的对话，从头部开始）
    let start = -1;
    for (let i = 1; i < messages.length; i++) {
      const m = messages[i];
      if (m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) { start = i; break; }
    }
    if (start < 0) break; // 没有可丢弃的工具轮次
    let end = start + 1;
    while (end < messages.length && messages[end] && messages[end].role === 'tool') end++;
    const n = Math.max(1, end - start);
    messages.splice(start, n);
    removed += n;
  }
  return removed;
}

// 从历史尾部丢弃"最近一轮工具调用"相关消息（tool 结果 + 带 tool_calls 的 assistant 消息），
// 返回实际移除的消息数；返回 0 表示当前上下文里没有可清理的工具调用轮次
function dropTailToolRound(messages) {
  if (!Array.isArray(messages) || !messages.length) return 0;
  let removed = 0;
  while (messages.length && messages[messages.length - 1].role === 'tool') {
    messages.pop();
    removed++;
  }
  const tail = messages[messages.length - 1];
  if (tail && tail.role === 'assistant' && Array.isArray(tail.tool_calls) && tail.tool_calls.length) {
    messages.pop();
    removed++;
  }
  return removed;
}

// 混合思考模型（默认会/可以输出思考过程的那些）
const HYBRID_THINK_MODEL_RE = /qwen3|qwq|deepseek-r1|deepseek-v3\.1|glm-z1|glm-4\.5|hunyuan-t1|kimi-k2|minimax-m1|step-3/i;

function isLocalEndpoint(provider) {
  if (provider && provider.local) return true;
  try {
    const h = new URL(provider?.apiUrl || '').hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0' ||
      /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /\.local$/.test(h);
  } catch (e) { return false; }
}

/**
 * 思考模式的请求参数。
 * ⚠️ 各家**默认几乎都是关思考**，不显式打开就永远看不到思考过程（"本地 llama.cpp 不显示思考过程"的根因就在这）：
 * - llama.cpp / vLLM / SGLang：`chat_template_kwargs.enable_thinking = true`（llama-server 服务 Qwen3 时默认 false）
 * - 阿里云百炼 / DashScope 兼容模式：顶层 `enable_thinking = true`
 * 只对「本地端点」或「已知混合思考模型」下发，避免给严格的云端接口塞未知字段导致 400。
 *
 * ⚠️ thinkMode=false 时**必须显式下发关闭**（本地端点），不能只是"不发参数"：
 *   llama.cpp / vLLM 的 Qwen3 模板在部分部署下默认开启思考，
 *   "不发"≠"关闭" → 模型照样思考 → 思考吃掉 max_tokens → 正文输出为空（回答异常）。
 *   云端接口对未知字段敏感，仍然只在确认支持时下发 false。
 */
// 哪些提供商支持 stream_options.include_usage（不支持的发了会 400）
function supportsStreamOptions(provider) {
  const t = String(provider?.type || '').toLowerCase();
  // OpenAI 原生、DeepSeek、智谱、月之暗面、OpenAI 兼容自定义 通常支持；
  // 百炼 DashScope、腾讯混元、百度千帆、火山引擎 等兼容层不一定支持，不发
  return ['openai', 'deepseek', 'zhipu', 'moonshot', 'anthropic'].includes(t);
}

function thinkingParams(provider, thinkMode) {
  const local = isLocalEndpoint(provider);
  const t = String(provider?.type || '').toLowerCase();
  const model = String(provider?.model || '');

  if (!thinkMode) {
    // 关闭思考：只对「本地端点」和「已确认支持该字段的云端」显式下发 false。
    // 少了这一步，本地混合思考模型仍会思考 → 思考吃满 max_tokens → 正文为空。
    if (local) return { chat_template_kwargs: { enable_thinking: false } };
    if (t === 'dashscope') return { enable_thinking: false };
    if (/glm-(4\.5|4\.6|[5-9]|z[0-9])/i.test(model) || /zhipu|chatglm/i.test(String(provider?.name || ''))) {
      return { thinking: { type: 'disabled' } };
    }
    return {};
  }

  if (local) {
    // llama.cpp / llama-server：只通过 chat_template_kwargs 控制思考，顶层字段会被忽略或报错
    return { chat_template_kwargs: { enable_thinking: true } };
  }
  // 云端：只有百炼 DashScope 明确支持顶层 enable_thinking；
  // 其他厂商（火山引擎、腾讯混元、百度等）发了会 400，即使模型名匹配也不发
  if (t === 'dashscope' && HYBRID_THINK_MODEL_RE.test(model)) {
    return { enable_thinking: true };
  }
  // 智谱 GLM 混合思考模型（glm-4.5/4.6/5/z1 系列）：顶层 thinking.type 参数，
  // 不发则模型不输出 reasoning_content，前端思考面板全程空白（只能等执行完看总结）
  if (/glm-(4\.5|4\.6|[5-9]|z[0-9])/i.test(model) || /zhipu|chatglm/i.test(String(provider?.name || ''))) {
    return { thinking: { type: 'enabled' } };
  }
  return {};
}

// 带 tools 的 API 调用（流式，支持 reasoning_content 和 tool_calls）
function callProviderAPIWithTools(provider, messages, temperature, maxTokens, tools, thinkMode, onStreamChunk) {
  return new Promise((resolve) => {
    const isOllama = provider.type === 'ollama';
    messages = sanitizeOutgoingMessages(messages, isOllama);
    const apiUrl = isOllama ? provider.apiUrl.replace(/\/$/, '') + '/api/chat' : provider.apiUrl;
    const url = new URL(apiUrl);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    // tools 为空时兜底成"内置 + 已启用的 MCP 工具"。
    // 这里**同步读缓存**而不是 await getAllTools()：本函数是 Promise 构造器不是 async，
    // 且调用方（agentChat）已在进请求前刷新过缓存，不会拿到过期数据。
    const useTools = tools && tools.length > 0 ? tools : AGENT_TOOLS.concat(_mcpToolCache.tools);
    console.log('[Agent] callProviderAPIWithTools - isOllama:', isOllama, 'thinkMode:', thinkMode, 'tools count:', useTools.length);
    // Ollama：显式设置足够大的上下文窗口（默认仅2048~4096，装不下19个工具定义+系统提示词，会导致模型看不到工具而不调用）
    // keep_alive: 0 表示响应完成后立即从GPU显存卸载模型，避免长时间占用导致卡顿
    // Ollama 模式：只有显式设置了 maxTokens 才传递 num_predict，否则让 Ollama 使用默认值
    const ollamaOptions = { temperature, num_ctx: 32768 };
    if (maxTokens != null) ollamaOptions.num_predict = maxTokens;
    const thinkParams = thinkingParams(provider, thinkMode);
    const bodyObj = isOllama
      ? { model: provider.model, messages, tools: useTools, stream: true, think: !!thinkMode, keep_alive: 0, options: ollamaOptions }
      : (() => {
          const b = { model: provider.model, messages, tools: useTools, temperature, stream: true, ...thinkParams };
          if (maxTokens != null) b.max_tokens = maxTokens;
          // tool_choice 仅在有工具时发送，部分 API（火山引擎等）不支持该字段会 400
          if (useTools && useTools.length > 0) b.tool_choice = 'auto';
          // stream_options 仅发给支持的提供商
          if (supportsStreamOptions(provider)) b.stream_options = { include_usage: true };
          return b;
        })();
    if (!isOllama && thinkMode) {
      console.log('[Agent] 思考模式请求参数:', JSON.stringify(thinkParams), '（本地端点=' + isLocalEndpoint(provider) + '）');
    }
    const body = JSON.stringify(bodyObj);

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    };
    if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname.replace(/\/$/, '') + (url.search || ''),
      method: 'POST',
      headers
    };

    const req = client.request(options, (res) => {
      activeReq = req;
      let fullContent = '';
      let fullReasoning = '';
      let toolCalls = [];
      let buffer = '';
      let finishReason = null;
      let totalLines = 0;
      // content 里可能混着内联思考（llama.cpp --reasoning-format none 启动时）。
      // 拆标签的逻辑抽到 agentToolUtils.createInlineThinkSplitter —— 可单测：
      // 跨 chunk 的标签、多种闭合标签（ASCII / 全角）、以及"尾巴长度为 0 时不能重复吐字"。
      const thinkSplitter = createInlineThinkSplitter();
      const lastRawLines = [];
      let streamUsage = null; // 保留最后12行原始内容，用于诊断"思考完无输出"问题

      if (res.statusCode < 200 || res.statusCode >= 300) {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve({ success: false, error: simplifyApiError(res.statusCode, data), statusCode: res.statusCode }));
        return;
      }

      // 处理单行响应（提取为函数，data 和 end 时复用，避免最后一行残留丢失 tool_calls）
      const processLine = (line) => {
        if (!line || !line.trim()) return;
        totalLines++;
        lastRawLines.push(line.substring(0, 400));
        if (lastRawLines.length > 12) lastRawLines.shift();
        try {
          let parsed, delta;
          if (isOllama) {
            // Ollama 格式：每行一个 JSON { message: { content, tool_calls, reasoning/thinking }, done, done_reason }
            parsed = JSON.parse(line);
            if (parsed.usage) streamUsage = parsed.usage;
            delta = parsed.message || {};
            // 记录结束原因（length=被token上限截断，stop=正常结束）
            if (parsed.done_reason) finishReason = parsed.done_reason;
            // 兼容 reasoning 在顶层或 message 中的各种字段名
            if (!delta.reasoning && parsed.reasoning) delta.reasoning = parsed.reasoning;
            if (!delta.reasoning_content && parsed.reasoning_content) delta.reasoning_content = parsed.reasoning_content;
            if (!delta.reasoning && delta.thinking) delta.reasoning = delta.thinking;
            if (!delta.reasoning && parsed.thinking) delta.reasoning = parsed.thinking;
          } else {
            // OpenAI SSE 格式：data: {...}
            if (!line.startsWith('data: ')) return;
            const jsonStr = line.slice(6).trim();
            if (jsonStr === '[DONE]') return;
            parsed = JSON.parse(jsonStr);
            if (parsed.usage) streamUsage = parsed.usage;
            delta = parsed.choices?.[0]?.delta;
            if (parsed.choices?.[0]?.finish_reason) finishReason = parsed.choices[0].finish_reason;
          }
          if (!delta) return;

          // 思考过程（Ollama 用 reasoning/thinking，OpenAI 用 reasoning_content）
          const reasoningText = delta.reasoning_content || delta.reasoning;
          if (reasoningText) {
            fullReasoning += reasoningText;
            if (onStreamChunk) onStreamChunk({ reasoning: reasoningText });
          }
          // 正文（顺手把混在里面的内联思考拆到 reasoning）
          if (delta.content) {
            const split = thinkSplitter.push(delta.content);
            if (split.reasoning) {
              fullReasoning += split.reasoning;
              if (onStreamChunk) onStreamChunk({ reasoning: split.reasoning });
            }
            if (split.content) {
              fullContent += split.content;
              if (onStreamChunk) onStreamChunk({ content: split.content });
            }
          }
          // 工具调用
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              // Ollama 的 index 在 function.index 内，OpenAI 在 tc.index；都做兼容
              const idx = (typeof tc.index === 'number' ? tc.index : (typeof tc.function?.index === 'number' ? tc.function.index : 0));
              if (!toolCalls[idx]) {
                toolCalls[idx] = { id: tc.id || 'call_' + idx, type: 'function', function: { name: '', arguments: '' } };
              }
              if (tc.id) toolCalls[idx].id = tc.id;
              if (tc.function?.name) {
                // Ollama 完整返回，直接赋值；OpenAI 增量返回，累加
                toolCalls[idx].function.name = isOllama ? tc.function.name : toolCalls[idx].function.name + tc.function.name;
              }
              if (tc.function?.arguments !== undefined && tc.function?.arguments !== null) {
                const argsVal = tc.function.arguments;
                if (isOllama) {
                  // Ollama：arguments 通常是对象，直接赋值；个别版本返回字符串
                  toolCalls[idx].function.arguments = argsVal;
                } else {
                  // OpenAI：arguments 是增量字符串，累加
                  toolCalls[idx].function.arguments = (toolCalls[idx].function.arguments || '') + (typeof argsVal === 'string' ? argsVal : JSON.stringify(argsVal));
                }
              }
              if (tc.function?.name && onStreamChunk) {
                onStreamChunk({ toolCall: { name: tc.function.name, index: idx } });
              }
            }
          }
        } catch (e) { 
          console.log('[Agent] 流式行解析错误:', e.message, '| 行内容:', line.substring(0, 150));
        }
      };

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) processLine(line);
      });

      res.on('end', () => {
        // 关键修复：处理 buffer 中残留的最后一行（tool_calls 可能就在这一行）
        if (buffer.trim()) processLine(buffer);
        buffer = '';
        // 冲刷内联思考拆分的尾巴缓冲（不能丢字）
        const thinkTail = thinkSplitter.flush();
        if (thinkTail.reasoning) {
          fullReasoning += thinkTail.reasoning;
          if (onStreamChunk) onStreamChunk({ reasoning: thinkTail.reasoning });
        }
        if (thinkTail.content) {
          fullContent += thinkTail.content;
          if (onStreamChunk) onStreamChunk({ content: thinkTail.content });
        }
        // 归一化工具调用参数：半截 JSON 必须在这里修复，否则残缺参数会被写回历史 → 下一轮 400
        const finalToolCalls = toolCalls
          .filter(tc => tc && tc.function && tc.function.name)
          .map(tc => {
            const st = normalizeToolCallArgs(tc, isOllama);
            if (st !== 'ok') {
              console.log('[Agent] 工具参数不完整(' + st + '):', tc.function.name,
                JSON.stringify(tc.function.arguments).substring(0, 120));
            }
            return tc;
          });
        // 截断检测：思考/输出被 token 上限截断，导致没生成 tool_calls
        const truncated = finishReason === 'length';
        if (truncated && finalToolCalls.length === 0 && !fullContent.trim()) {
          console.log('[Agent] 诊断-截断: 最后12行原始内容:');
          lastRawLines.forEach((l, i) => console.log('  [' + (i+1) + '] ' + l));
          resolve({ 
            success: false, 
            error: '输出被 token 上限截断（done_reason=length），模型还没来得及调用工具。请在设置中增大 max_tokens 后重试。',
            truncated: true
          });
          return;
        }
        // 兜底：模型思考后异常停止（finishReason=stop 但 content 为空、toolCalls 为空）
        // 尝试从 reasoning 末尾提取最终回答（qwen3 偶发把回答写在 thinking 末尾而不输出 content）
        let effectiveContent = fullContent;
        if (!fullContent.trim() && finalToolCalls.length === 0 && fullReasoning.length > 50) {
          console.log('[Agent] 诊断-空输出: totalLines=' + totalLines + ' finishReason=' + finishReason + ' reasoning=' + fullReasoning.length + '字符');
          console.log('[Agent] 诊断-空输出: 最后12行原始内容:');
          lastRawLines.forEach((l, i) => console.log('  [' + (i+1) + '] ' + l));
          // 从 reasoning 末尾提取：找"最终回答"/"总结"/"因此"/"所以"等标记后的内容
          const markers = ['最终回答', '最终答案', '总结一下', '综上所述', '因此，', '所以，', '我的回答是', '简单来说'];
          let extracted = '';
          for (const m of markers) {
            const idx = fullReasoning.lastIndexOf(m);
            if (idx >= 0) {
              extracted = fullReasoning.substring(idx + m.length).trim();
              break;
            }
          }
          // 如果没找到标记，取 reasoning 最后一段（最后一个换行后的内容）
          if (!extracted) {
            const parts = fullReasoning.split(/\n+/).filter(s => s.trim().length > 20);
            if (parts.length > 0) extracted = parts[parts.length - 1].trim();
          }
          // 提取的内容如果看起来像回答（长度>10，不是纯思考标记），作为备选 content
          if (extracted && extracted.length > 10 && extracted.length < 2000) {
            effectiveContent = extracted;
            console.log('[Agent] 兜底: 从思考末尾提取到回答(' + extracted.length + '字符):', extracted.substring(0, 100));
          }
        }
        console.log('[Agent] 流式结束: content=' + fullContent.length + '字符 effectiveContent=' + effectiveContent.length + '字符 reasoning=' + fullReasoning.length + '字符 toolCalls=' + finalToolCalls.length + ' finishReason=' + finishReason + ' totalLines=' + totalLines);
        resolve({
          success: true,
          content: effectiveContent,
          rawContent: fullContent,
          reasoning: fullReasoning,
          toolCalls: finalToolCalls,
          finishReason,
          totalLines,
          usage: streamUsage
        });
      });
    });

    req.on('error', (err) => resolve({ success: false, error: err.message }));
    req.setTimeout(300000, () => { req.destroy(); resolve({ success: false, error: '请求超时（5分钟），请检查网络连接或稍后重试' }); });
    // 本地模型被杀/重启时 socket 已销毁，这里必须兜住，否则同步 EPIPE 会打进全局异常处理器
    safeWriteRequest(req, body, (e) => resolve({
      success: false,
      error: '请求发送失败（连接已断开，本地模型可能正在重启）: ' + e.message
    }));
  });
}

function formatModelSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + units[i];
}

function saveAIConfig() {
  if (!aiConfig) return;
  const { setConfig } = require('../configManager');
  setConfig({ ai: aiConfig });
}


// 从提供商 API 获取可用模型列表（调用 /v1/models）
function fetchProviderModels(provider) {
  return new Promise((resolve) => {
    try {
      const apiUrl = normalizeApiUrl(provider.apiUrl);
      // 从 chat completions 地址推导 models 地址
      const modelsUrl = apiUrl.replace(/\/chat\/completions\/?$/, '/models');
      if (modelsUrl === apiUrl) {
        resolve({ success: false, error: '无法从 API 地址推导 models 端点' });
        return;
      }
      const url = new URL(modelsUrl);
      const isHttps = url.protocol === 'https:';
      const client = isHttps ? https : http;

      const headers = {};
      if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname.replace(/\/$/, '') + (url.search || ''),
        method: 'GET',
        headers
      };

      const req = client.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(data);
              const models = (parsed.data || []).map(m => m.id).filter(Boolean);
              resolve({ success: true, models });
            } catch (e) {
              resolve({ success: false, error: '响应解析失败: ' + e.message });
            }
          } else {
            resolve({ success: false, error: `HTTP ${res.statusCode}` });
          }
        });
      });
      req.on('error', (err) => resolve({ success: false, error: err.message }));
      req.setTimeout(10000, () => { req.destroy(); resolve({ success: false, error: '请求超时' }); });
      req.end();
    } catch (e) {
      resolve({ success: false, error: e.message });
    }
  });
}

// 注：分身预览窗打开器已随预览功能一并移除（原 setClonePreviewOpen）。

module.exports = {
  init, getStatus,
  getAgentTools,
  getContextMeta,
  getProviderPresets,
  listOllamaModels, testOllamaConnection,
  listLocalModels, importLocalModel, deleteLocalModel,
  useLocalModel, stopLocalModel, getLocalEngineStatus, detectLocalEngine, convertLocalModelToGguf, detectPythonEnv, checkTools, downloadTool, testMirrorConnectivity,
  initLocalEngine: (logFile, installDir) => { toolInstallDir = installDir; return LocalAiEngine.init({ logFile, installDir }); },
  listCloudProviders, addCloudProvider, addProviderByPreset, updateCloudProvider, deleteCloudProvider, fetchProviderModels,
  chat, streamChat, agentChat, cancelChat, cancelAgentChat,
  resolveToolConfirm,
  resolveUserGuidance,
  getAgentRoles, saveAgentRole, deleteAgentRole,
  releaseGPUMemory,
  // 长期记忆（供渲染层的「AI 记忆」面板读写）
  // opts.workdir 用来切作用域：设置页要看「当前项目」的记忆时传 workdir，不传=全局
  initMemory: (filePath) => MemoryStore.init(filePath),
  memory: {
    list: (opts) => { MemoryStore.ensureScope(MemoryStore.scopePathForWorkdir(opts && opts.workdir)); return MemoryStore.list(opts).map(memoryBrief); },
    search: (query, limit, workdir) => { MemoryStore.ensureScope(MemoryStore.scopePathForWorkdir(workdir)); return MemoryStore.search(query, limit).map(memoryBrief); },
    save: (payload) => MemoryStore.add(payload),
    update: (id, patch) => MemoryStore.update(id, patch),
    remove: (id) => MemoryStore.remove(id),
    clear: (workdir) => { MemoryStore.ensureScope(MemoryStore.scopePathForWorkdir(workdir)); return MemoryStore.clear(); },
    stats: () => MemoryStore.stats(),
    scopeFor: (workdir) => MemoryStore.scopePathForWorkdir(workdir)
  },
  // 待办事项（供渲染层读取/清理当前会话的清单）
  initTodo: (filePath) => TodoStore.init(filePath),
  todo: {
    read: (conversationId) => TodoStore.read(conversationId),
    write: (conversationId, items, title) => TodoStore.write(conversationId, items, title),
    update: (conversationId, patch) => TodoStore.update(conversationId, patch),
    clear: (conversationId) => TodoStore.clear(conversationId),
    stats: () => TodoStore.stats()
  },
  // 上下文护栏（纯函数，供单测）
  estimateMessagesTokens,
  pruneHeadToolRounds,
  // ===== 多模态 / 多 Agent 协同模块复用的内部接口 =====
  _internal: {
    // 个性化（设置 → 功能设置）：供单测与将来「预览提示词」功能使用
    getPersonalization,
    buildPersonalizationBlock,
    recordEvolution,
    REPLY_STYLES,
    callProviderAPI,
    callProviderAPIWithTools,
    executeTool,
    findProvider,
    getAgentRoleById,
    getAgentRoles,
    prepareLocalProvider,
    sanitizeOutgoingMessages,
    isValidMultimodalContent,
    sanitizeMultimodalContent,
    normalizeToolCallArgs,
    estimateMessagesTokens,
    pruneHeadToolRounds,
    finalizeMemoryIfNeeded,
    getMemoryWrittenThisRound: () => memoryWrittenThisRound,
    setMemoryWrittenThisRound: (v) => { memoryWrittenThisRound = !!v; },
    setTestTarget,
    resolveTestTargetTitle,
    getTestTarget: () => currentTestTarget,
    clearTestTarget: () => { currentTestTarget = null; },
    AGENT_TOOLS,
    RISKY_TOOLS,
    TOOLS_ALWAYS_ALLOWED,
    TOOL_DEPENDENCIES,
    resolveRoleTools,
    extractToolCallFromReasoning,
    buildBlockedToolHint,
    AGENT_SYSTEM_PROMPT,
    VISION_MODEL_HINTS,
    redactText: _agentCfgRaw.redactText,
    renderExamples: _agentCfgRaw.renderExamples,
    transform: _agentCfg.transform,
    // MCP（外部工具服务器）：供 IPC 层调用与测试
    mcpStart: async (id) => _mcpInvalidate(await _mcp.startServer(id)),
    mcpStop: async (id) => _mcpInvalidate(await _mcp.stopServer(id)),
    mcpRestart: async (id) => _mcpInvalidate(await _mcp.restartServer(id)),
    mcpStatus: _mcp.status,
    mcpSetEnabled: (ids) => _mcpInvalidate(_mcp.setEnabled(ids)),
    mcpStopAll: async () => _mcpInvalidate(await _mcp.stopAll()),
    mcpHealthCheck: _mcp.healthCheck,
    mcpManager: _mcp,
    getAllTools,
    invalidateMcpTools
  },
    // 仅给测试脚本用（scripts/test-vision-analyze.js 等）：把内部实现暴露出来做端到端校验
  __test: {
    analyzeImageWithVision,
    parseVisionVerdict,
    resolveVisionTarget,
    memoryBrief,
    thinkingParams,
    AGENT_TOOLS,
    RISKY_TOOLS,
    TOOLS_ALWAYS_ALLOWED,
    TOOL_DEPENDENCIES,
    resolveRoleTools,
    extractToolCallFromReasoning,
    buildBlockedToolHint,
    AGENT_SYSTEM_PROMPT,
    redactText: _agentCfgRaw.redactText,
    renderExamples: _agentCfgRaw.renderExamples,
    transform: _agentCfg.transform,
    getAllTools,
    mcpManager: _mcp
  }
};
