/**
 * 工具路由 / 选择器（Tool Router / Selector）
 * ============================================================
 * 职责：
 *   根据用户当前问题，自动筛选相关工具，只把相关工具的
 *   schema 注入 AI 上下文，屏蔽无关工具，减少 token 消耗。
 *
 * 背景：
 *   当 MCP 服务器多了之后（比如挂了 5 个 server、30+ 工具），
 *   每次对话都把全部工具 schema 发给模型，光工具描述就要占几千 token。
 *   工具路由就是「按需加载」：用户问搜索相关的问题，只把搜索类工具露出来；
 *   用户问数据库的问题，再把数据库工具露出来。
 *
 * 设计：
 *   · **工具少时不筛选**：工具总数 < 15 个时全部注入，避免过度筛选反而漏工具。
 *   · **关键词粗筛 + 描述精排**：先用工具名/标签做粗筛，再用描述相似度排序。
 *   · **保留兜底**：筛选后如果剩的工具太少（< 5 个），回退到全量注入，
 *     防止「用户明明要做 A，但筛选把 A 的工具也筛掉了」。
 *   · **MCP 工具按 server 分组**：同一个 server 的工具要么全留要么全不留，
 *     避免半个 server 露出来模型困惑。
 */

// ── 内置工具的分类标签 ────────────────────────────────────────────────────
// 格式：toolName -> [categories]
const BUILTIN_TOOL_CATEGORIES = {
  // 文件操作类
  read_file: ['file', 'read'],
  write_file: ['file', 'write'],
  copy_file: ['file', 'write'],
  move_file: ['file', 'write'],
  create_directory: ['file', 'write'],
  file_search: ['file', 'search'],
  directory_list: ['file', 'read'],
  download_file: ['file', 'network', 'write'],

  // 命令执行类
  run_shell: ['shell', 'command', 'system'],
  get_system_info: ['system', 'info'],

  // 网络类
  web_search: ['network', 'search'],
  web_fetch: ['network', 'fetch'],
  http_request: ['network', 'api'],
  open_url: ['network', 'browser'],
  check_url: ['network', 'check'],

  // 记忆类
  memory_save: ['memory'],
  memory_search: ['memory', 'search'],
  memory_list: ['memory'],
  memory_delete: ['memory'],

  // 待办类
  todo_write: ['todo', 'planning'],
  todo_update: ['todo', 'planning'],
  todo_read: ['todo'],

  // 桌面控制类
  capture_window: ['desktop', 'screenshot'],
  analyze_screenshot: ['desktop', 'vision'],
  verify_ui: ['desktop', 'vision', 'verify'],
  control_computer: ['desktop', 'control'],
  launch_in_clone: ['desktop', 'clone'],
  ensure_clone_desktop: ['desktop', 'clone'],

  // 其他
  get_current_time: ['utility'],
  calculator: ['utility'],
  ask_user: ['interaction'],
  pet_action: ['pet'],
  launch_project: ['project']
};

// ── 问题关键词 → 分类标签的映射 ────────────────────────────────────────────
// 用户问这些词时，对应的分类工具会优先保留
const KEYWORD_TO_CATEGORY = [
  // 文件类
  { keywords: ['文件', 'file', '读', '写', '查看', '打开', '目录', 'folder', 'path', '路径'], categories: ['file'] },
  { keywords: ['删除', 'delete', '移动', 'move', '复制', 'copy', '新建', 'create'], categories: ['file', 'write'] },

  // 命令/系统类
  { keywords: ['命令', 'cmd', 'shell', '终端', '执行', 'run', 'system', '系统', '进程'], categories: ['shell', 'system'] },

  // 网络类
  { keywords: ['搜索', 'search', '查一下', '网上', '网页', 'web', 'google', '百度'], categories: ['network', 'search'] },
  { keywords: ['抓取', 'fetch', '爬', '网页内容', 'url', '链接', 'api', '接口'], categories: ['network', 'fetch', 'api'] },

  // 记忆类
  { keywords: ['记住', '记得', 'memory', '记忆', '偏好', '上次', '之前'], categories: ['memory'] },

  // 待办/规划类
  { keywords: ['任务', '计划', '待办', 'todo', '步骤', '规划', '拆解'], categories: ['todo', 'planning'] },

  // 桌面控制类
  { keywords: ['截图', 'screenshot', '窗口', '界面', 'ui', '按钮', '点击', '鼠标'], categories: ['desktop', 'vision', 'control'] },
  { keywords: ['分身', 'clone', '虚拟桌面'], categories: ['desktop', 'clone'] },

  // 项目类
  { keywords: ['项目', 'project', '代码', 'code', '仓库', 'repo', 'git'], categories: ['project', 'file'] }
];

// ── 配置 ──────────────────────────────────────────────────────────────────
const CONFIG = {
  // 工具总数少于这个数时不筛选，全部注入
  minToolsToFilter: 15,
  // 筛选后至少保留多少个工具，太少就回退全量
  minRetainedTools: 5,
  // MCP 工具按 server 分组：同一个 server 的工具要么全留要么全不留
  groupByServer: true,
  // 每个分类最少保留多少个工具（即使不匹配也留几个，兜底）
  keepFallbackPerCategory: 2
};

let config = Object.assign({}, CONFIG);

function configure(opts = {}) {
  config = Object.assign({}, CONFIG, opts);
}

/**
 * 从用户问题中提取相关分类。
 * @param {string} userMessage 用户最后一条消息
 * @returns {Set<string>} 匹配到的分类标签集合
 */
function extractCategories(userMessage) {
  const msg = String(userMessage || '').toLowerCase();
  const matched = new Set();
  for (const rule of KEYWORD_TO_CATEGORY) {
    for (const kw of rule.keywords) {
      if (msg.includes(kw.toLowerCase())) {
        rule.categories.forEach(c => matched.add(c));
        break;
      }
    }
  }
  return matched;
}

/**
 * 给工具列表做路由筛选。
 * @param {Array} tools 全部工具 schema（OpenAI function 格式）
 * @param {string} userMessage 当前用户消息
 * @param {object} options { mcpToolIndex: Map<exposedName, {serverId, ...}> }
 * @returns {{ tools: Array, filtered: boolean, droppedCount: number, reason: string }}
 */
function route(tools, userMessage, options = {}) {
  const allTools = Array.isArray(tools) ? tools : [];

  // 工具太少：不筛选，直接全量返回
  if (allTools.length < config.minToolsToFilter) {
    return {
      tools: allTools,
      filtered: false,
      droppedCount: 0,
      reason: '工具总数 ' + allTools.length + ' < 阈值 ' + config.minToolsToFilter + '，全量注入'
    };
  }

  const categories = extractCategories(userMessage);

  // 没匹配到任何分类：不筛选（保守策略，宁多勿少）
  if (categories.size === 0) {
    return {
      tools: allTools,
      filtered: false,
      droppedCount: 0,
      reason: '用户问题未匹配到任何分类标签，保守全量注入'
    };
  }

  // ── 给每个工具打分 ──
  const scored = allTools.map(tool => {
    const name = tool.function?.name || '';
    let score = 0;

    // 内置工具：按分类标签打分
    const cats = BUILTIN_TOOL_CATEGORIES[name] || [];
    for (const c of cats) {
      if (categories.has(c)) score += 10;
    }

    // MCP 工具：按 server 分组打分
    // mcpToolIndex 从 mcpManager 传入，格式：exposedName -> { serverId, ... }
    if (options.mcpToolIndex && options.mcpToolIndex.has(name)) {
      const entry = options.mcpToolIndex.get(name);
      const serverId = entry.serverId || '';
      // serverId 本身可能包含分类信息（如 filesystem、github、postgres）
      const serverLower = serverId.toLowerCase();
      for (const c of categories) {
        if (serverLower.includes(c)) score += 10;
      }
      // MCP 工具默认加一点基础分（不筛得太狠）
      score += 2;
    }

    // 描述关键词匹配：工具描述里出现用户问题的词也加分
    const desc = (tool.function?.description || '').toLowerCase();
    const msg = String(userMessage || '').toLowerCase();
    for (const rule of KEYWORD_TO_CATEGORY) {
      for (const kw of rule.keywords) {
        if (desc.includes(kw.toLowerCase()) && msg.includes(kw.toLowerCase())) {
          score += 3;
          break;
        }
      }
    }

    return { tool, score, name };
  });

  // ── 筛选：分数 > 0 的保留 ──
  const retained = scored.filter(s => s.score > 0);

  // 兜底：保留的工具太少，回退全量
  if (retained.length < config.minRetainedTools) {
    return {
      tools: allTools,
      filtered: false,
      droppedCount: 0,
      reason: '筛选后只剩 ' + retained.length + ' 个工具，少于最低保留数 ' + config.minRetainedTools + '，回退全量注入'
    };
  }

  const retainedTools = retained.map(s => s.tool);
  const droppedCount = allTools.length - retainedTools.length;

  console.log('[ToolRouter] 用户问题匹配分类:', Array.from(categories).join(', '),
    '→ 保留', retainedTools.length + '/' + allTools.length, '个工具');

  return {
    tools: retainedTools,
    filtered: true,
    droppedCount,
    reason: '按分类「' + Array.from(categories).join('、') + '」筛选，保留 ' + retainedTools.length + ' 个工具，屏蔽 ' + droppedCount + ' 个无关工具'
  };
}

/**
 * 生成注入系统提示词的工具路由说明。
 */
function buildPromptBlock() {
  return [
    '## 工具路由（自动筛选）',
    '系统会根据你的问题自动筛选最相关的工具，只把相关工具的 schema 发给你。',
    '如果发现某个需要的工具不在可用列表里，可能是路由筛选把它暂时屏蔽了：',
    '- 你可以直接说明需要哪个工具，系统会自动放行；',
    '- 不要因为工具列表短就认为自己只能做这些事。'
  ].join('\n');
}

module.exports = {
  route,
  extractCategories,
  configure,
  BUILTIN_TOOL_CATEGORIES,
  KEYWORD_TO_CATEGORY,
  CONFIG
};
