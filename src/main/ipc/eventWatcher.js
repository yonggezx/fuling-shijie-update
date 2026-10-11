/**
 * 事件触发器（File Watcher / Event Trigger）
 * ============================================================
 * 职责：
 *   监听资源文件变更（yaml 配置修改、新连接器导入），
 *   自动触发动作：重新加载 MCP 工具列表、刷新配置索引、
 *   推送通知给前端。
 *
 * 解决的问题：
 *   开发阶段改了 mcp-servers.yaml 后，不用手动重启应用，
 *   保存文件就自动生效；用户在设置里改了配置也能即时反映。
 *
 * 设计：
 *   · **防抖**：文件保存过程中会连续触发多次 change 事件，
 *     加 500ms 防抖，避免频繁重载。
 *   · **只监听配置文件**：不监听整个项目目录，只盯 agent-config 下的 yaml。
 *   · **可开关**：开发阶段方便，生产环境可以关掉。
 */

const fs = require('fs');
const path = require('path');

// ── 默认配置 ──────────────────────────────────────────────────────────────
const DEFAULTS = {
  // 防抖延迟（ms）：文件最后一次变化后多久触发重载
  debounceMs: 500,
  // 监听的文件扩展名
  watchExtensions: ['.yaml', '.yml', '.json'],
  // 是否启用（默认开启）
  enabled: true,
  // 监听的文件名模式（匹配则触发对应事件）
  watchFiles: {
    'mcp-servers.yaml': 'mcp-reload',      // MCP 服务器配置变化 → 重载 MCP
    'policy.yaml': 'policy-reload',         // 权限策略变化 → 重载策略
    'transform.yaml': 'transform-reload',  // 文本加工规则变化 → 重载配置
    'tool-labels.yaml': 'labels-reload',   // 工具标签变化 → 重载标签
    'tools.yaml': 'tools-reload',           // 工具定义变化 → 重载工具
    'roles.yaml': 'roles-reload',           // 角色配置变化 → 重载角色
    'connectors.yaml': 'connectors-reload'  // 连接器变化 → 重载连接器
  }
};

let config = Object.assign({}, DEFAULTS);

function configure(opts = {}) {
  config = Object.assign({}, DEFAULTS, opts);
}

class EventWatcher {
  /**
   * @param {object} options
   * @param {string} options.configDir 要监听的配置目录（agent-config）
   * @param {function} options.onEvent 事件回调 (eventName: string, filePath: string) => void
   */
  constructor(options = {}) {
    this.configDir = options.configDir;
    this.onEvent = options.onEvent || (() => {});
    this.watchers = [];       // fs.FSWatcher 列表
    this.debounceTimers = new Map();  // filename -> timer
    this.running = false;
  }

  /** 启动监听 */
  start() {
    if (!config.enabled) {
      console.log('[EventWatcher] 已禁用');
      return { ok: false, reason: 'disabled' };
    }
    if (this.running) return { ok: true, alreadyRunning: true };
    if (!this.configDir || !fs.existsSync(this.configDir)) {
      console.warn('[EventWatcher] 配置目录不存在:', this.configDir);
      return { ok: false, reason: 'dir_not_found' };
    }

    try {
      const watcher = fs.watch(this.configDir, (eventType, filename) => {
        this._onFileChange(eventType, filename);
      });
      this.watchers.push(watcher);
      this.running = true;
      console.log('[EventWatcher] 已监听配置目录:', this.configDir);
      return { ok: true, dir: this.configDir };
    } catch (e) {
      console.warn('[EventWatcher] 启动失败:', e.message);
      return { ok: false, error: e.message };
    }
  }

  /** 停止监听 */
  stop() {
    for (const w of this.watchers) {
      try { w.close(); } catch (e) { /* 忽略 */ }
    }
    this.watchers = [];
    this.running = false;
    // 清理防抖定时器
    for (const [, timer] of this.debounceTimers) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    console.log('[EventWatcher] 已停止监听');
  }

  /** 文件变化回调（带防抖） */
  _onFileChange(eventType, filename) {
    if (!filename) return;

    // 检查是否是我们关心的文件
    const ext = path.extname(filename).toLowerCase();
    if (!config.watchExtensions.includes(ext)) return;

    const eventName = config.watchFiles[filename];
    if (!eventName) return;  // 不是配置文件，忽略

    // 防抖：500ms 内的多次变化合并成一次
    if (this.debounceTimers.has(filename)) {
      clearTimeout(this.debounceTimers.get(filename));
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(filename);
      const filePath = path.join(this.configDir, filename);
      console.log('[EventWatcher] 检测到配置变化:', filename, '→ 触发', eventName);
      try {
        this.onEvent(eventName, filePath);
      } catch (e) {
        console.warn('[EventWatcher] 事件回调执行失败:', e.message);
      }
    }, config.debounceMs);

    if (timer.unref) timer.unref();
    this.debounceTimers.set(filename, timer);
  }

  /** 当前状态 */
  status() {
    return {
      running: this.running,
      configDir: this.configDir,
      watchedFiles: Object.keys(config.watchFiles),
      pendingDebounces: this.debounceTimers.size
    };
  }
}

/**
 * 创建一个默认的事件监听器，绑定到 mcpManager 和 agentConfig。
 * 这是工厂函数，方便主进程启动时一键装好。
 */
function createDefaultWatcher({ configDir, mcpManager, agentConfig, broadcastFn }) {
  const watcher = new EventWatcher({
    configDir,
    onEvent: (eventName, filePath) => {
      // 根据事件类型执行对应动作
      switch (eventName) {
        case 'mcp-reload':
          // MCP 配置变化：重载配置，不自动重启 server（让用户自己决定）
          try {
            mcpManager.load();  // 重新加载配置
            mcpManager._state.revision++;  // 触发版本号变化，让下游缓存失效
            console.log('[EventWatcher] MCP 配置已重载');
            broadcastFn && broadcastFn('config-changed', { type: 'mcp', file: filePath });
          } catch (e) {
            console.warn('[EventWatcher] MCP 重载失败:', e.message);
          }
          break;

        case 'policy-reload':
        case 'transform-reload':
        case 'tool-labels-reload':
        case 'tools-reload':
        case 'roles-reload':
          // 其他配置变化：通知前端刷新
          console.log('[EventWatcher] 配置已更新:', eventName);
          broadcastFn && broadcastFn('config-changed', { type: eventName.replace('-reload', ''), file: filePath });
          break;

        case 'connectors-reload':
          console.log('[EventWatcher] 连接器配置已更新');
          broadcastFn && broadcastFn('config-changed', { type: 'connectors', file: filePath });
          break;
      }
    }
  });

  return watcher;
}

module.exports = {
  EventWatcher,
  createDefaultWatcher,
  configure,
  DEFAULTS
};
