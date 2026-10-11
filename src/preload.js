const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');
const os = require('os');

contextBridge.exposeInMainWorld('api', {
  // Window control
  // ★ openMain 支持传入 tab 参数，打开主窗口后自动切换到指定页面（如 'models' 模型管理）
  openMain: (tab) => ipcRenderer.invoke('window:open-main', tab || null),
  closeMain: () => ipcRenderer.invoke('window:close-main'),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  // 真全屏：无参数则切换；传 true/false 可强制指定
  toggleFullscreen: (force) => ipcRenderer.invoke('window:fullscreen', force),
  isFullscreen: () => ipcRenderer.invoke('window:is-fullscreen'),
  // 窗口磨砂（系统 Acrylic）：状态变化时主进程会重建主窗口
  setWindowTransparency: (enabled) => ipcRenderer.invoke('window:set-transparency', !!enabled),
  togglePet: (show) => ipcRenderer.invoke('window:toggle-pet', show),
  disclaimerAccepted: () => ipcRenderer.invoke('disclaimer:accepted'),
  petDrag: (x, y) => ipcRenderer.send('pet:drag', { screenX: x, screenY: y }),
  dragMove: (dx, dy) => ipcRenderer.send('window:drag-move', { dx, dy }),
  dragStart: () => ipcRenderer.send('window:drag-start'), // 拖拽开始：setResizable(false)，防止误触发边缘缩放
  dragEnd: () => ipcRenderer.send('window:drag-end'),     // 拖拽结束：恢复可缩放
  setWindowPosition: (x, y) => ipcRenderer.send('window:set-position', { x, y }),
  getWindowPosition: () => ipcRenderer.invoke('window:get-position'),
  getRestoreBounds: () => ipcRenderer.invoke('window:get-restore-bounds'),
  setWindowBounds: (b) => ipcRenderer.send('window:set-bounds', b),
  getPetPosition: () => ipcRenderer.invoke('pet:get-position'),
  savePetPosition: () => ipcRenderer.invoke('pet:save-position'),
  setPetIgnoreMouseEvents: (ignore, forward) => ipcRenderer.send('pet:set-ignore-mouse-events', { ignore, forward }),
  focusPetWindow: () => ipcRenderer.send('pet:focus'),
  petMoveTo: (x, y, duration) => ipcRenderer.invoke('pet:move-to', { x, y, duration }),
  petExecuteAction: (action) => ipcRenderer.invoke('pet:execute-action', action),
  petDoAction: (name) => ipcRenderer.invoke('pet:do-action', name),
  petChat: (params) => ipcRenderer.invoke('pet:chat', params),
  petAgentChat: (params) => ipcRenderer.invoke('pet:agent-chat', params),
  onPetAgentEvent: (cb) => ipcRenderer.on('pet:agent-event', (_e, data) => cb(data)),
  applyPetSettings: (settings) => ipcRenderer.invoke('pet:apply-settings', settings),
  setPetRenderScale: (scale) => ipcRenderer.send('pet:set-render-scale', scale),
  setAutoStart: (enable) => ipcRenderer.invoke('app:set-auto-start', enable),

  // Config
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (config) => ipcRenderer.invoke('config:set', config),
  saveConfig: (config) => ipcRenderer.invoke('config:set', config),
  resetConfig: () => ipcRenderer.invoke('config:reset'),

  // Taskbar transparency (Windows only)
  // 任务栏外观：只暴露实测安全可用的能力（进程内改写 accent 会让 explorer 崩溃，已禁用）
  taskbarGetState: () => ipcRenderer.invoke('taskbar:get-state'),
  taskbarSetSystemTransparency: (enabled) => ipcRenderer.invoke('taskbar:set-system-transparency', enabled),
  // Phase B / XAML TAP 任务栏外观
  taskbarApplyEffect: (effect) => ipcRenderer.invoke('taskbar:apply-effect', effect),
  taskbarSetFlyoutSync: (key, enabled) => ipcRenderer.invoke('taskbar:set-flyout-sync', key, enabled),
  taskbarTapStatus: () => ipcRenderer.invoke('taskbar:tap-status'),
  // 开始菜单外观（独立开关）
  startMenuApplyEffect: (effect) => ipcRenderer.invoke('startmenu:apply-effect', effect),

  // Model management
  listModels: () => ipcRenderer.invoke('model:list'),
  importModel: (sourcePath) => ipcRenderer.invoke('model:import', sourcePath),
  deleteModel: (modelId) => ipcRenderer.invoke('model:delete', modelId),
  renameModel: (modelId, newName) => ipcRenderer.invoke('model:rename', modelId, newName),
  updateModel: (modelId, updates) => ipcRenderer.invoke('model:update', modelId, updates),
  rescanThumbnail: (modelId) => ipcRenderer.invoke('model:rescan-thumbnail', modelId),
  getActions: (modelId) => ipcRenderer.invoke('model:get-actions', modelId),
  getModel: (modelId) => ipcRenderer.invoke('model:get', modelId),
  saveActions: (modelId, data) => ipcRenderer.invoke('model:save-actions', modelId, data),
  previewActionInPet: (def) => ipcRenderer.invoke('pet:preview-action', def),
  setActionsInPet: (data) => ipcRenderer.invoke('pet:set-actions', data),
  setCurrentModel: (modelId) => ipcRenderer.invoke('model:set-current', modelId),
  validateModel: (modelPath) => ipcRenderer.invoke('model:validate', modelPath),
  scanLive2DDir: (dirPath) => ipcRenderer.invoke('model:scan-live2d-dir', dirPath),
  healLive2DModelJson: (modelPath) => ipcRenderer.invoke('model:heal-live2d-json', modelPath),

  // File operations
  listFiles: (params) => ipcRenderer.invoke('fs:list', params),
  readFile: (params) => ipcRenderer.invoke('fs:read', params),
  writeFile: (params) => ipcRenderer.invoke('fs:write', params),
  copyFile: (params) => ipcRenderer.invoke('fs:copy', params),
  moveFile: (params) => ipcRenderer.invoke('fs:move', params),
  deleteFile: (params) => ipcRenderer.invoke('fs:delete', params),
  createDir: (params) => ipcRenderer.invoke('fs:create-dir', params),
  rename: (params) => ipcRenderer.invoke('fs:rename', params),
  searchFiles: (params) => ipcRenderer.invoke('fs:search', params),
  getFileInfo: (params) => ipcRenderer.invoke('fs:get-info', params),
  openPath: (filePath) => ipcRenderer.invoke('fs:open-path', filePath),
  openInFolder: (filePath) => ipcRenderer.invoke('fs:open-in-folder', filePath),
  selectDirectory: () => ipcRenderer.invoke('fs:select-directory'),
  selectFiles: (options) => ipcRenderer.invoke('fs:select-files', options),
  saveFile: (options) => ipcRenderer.invoke('fs:save-file', options),

  // Command operations
  executeCommand: (params) => ipcRenderer.invoke('cmd:execute', params),
  listTerminals: () => ipcRenderer.invoke('cmd:list-terminals'),
  killProcess: (pid) => ipcRenderer.invoke('cmd:kill', pid),

  // Software management
  listInstalled: () => ipcRenderer.invoke('sw:list-installed'),
  installSoftware: (params) => ipcRenderer.invoke('sw:install', params),
  uninstallSoftware: (params) => ipcRenderer.invoke('sw:uninstall', params),
  getInstallInfo: (name) => ipcRenderer.invoke('sw:get-install-info', name),

  // AI operations
  listLocalModels: () => ipcRenderer.invoke('ai:list-local-models'),
  importLocalModel: (params) => ipcRenderer.invoke('ai:import-local-model', params),
  deleteLocalModel: (modelId) => ipcRenderer.invoke('ai:delete-local-model', modelId),
  // 本地模型（非 Ollama）：拉起/复用本地推理服务并切换为当前模型
  useLocalModel: (modelId) => ipcRenderer.invoke('ai:use-local-model', modelId),
  stopLocalModel: () => ipcRenderer.invoke('ai:stop-local-model'),
  getLocalEngineStatus: () => ipcRenderer.invoke('ai:local-engine-status'),
  detectLocalEngine: () => ipcRenderer.invoke('ai:detect-local-engine'),
  detectPython: () => ipcRenderer.invoke('ai:detect-python'),
  convertModelToGguf: (modelId) => ipcRenderer.invoke('ai:convert-model-to-gguf', modelId),
  checkTools: () => ipcRenderer.invoke('ai:check-tools'),
  downloadTool: (tool, installDir) => ipcRenderer.invoke('ai:download-tool', tool, installDir),
  testMirrors: (urls) => ipcRenderer.invoke('ai:test-mirrors', urls),
  onToolDownloadProgress: (cb) => ipcRenderer.on('ai:tool-download-progress', (_e, p) => cb(p)),
  listCloudProviders: () => ipcRenderer.invoke('ai:list-cloud-providers'),
  addCloudProvider: (params) => ipcRenderer.invoke('ai:add-cloud-provider', params),
  addProviderByPreset: (presetKey, overrides) => ipcRenderer.invoke('ai:add-provider-by-preset', presetKey, overrides),
  getProviderPresets: () => ipcRenderer.invoke('ai:get-provider-presets'),
  updateCloudProvider: (params) => ipcRenderer.invoke('ai:update-cloud-provider', params),
  deleteCloudProvider: (id) => ipcRenderer.invoke('ai:delete-cloud-provider', id),
  fetchProviderModels: (provider) => ipcRenderer.invoke('ai:fetch-provider-models', provider),
  chat: (params) => ipcRenderer.invoke('ai:chat', params),
  streamChat: (params) => ipcRenderer.invoke('ai:stream-chat', params),
  agentChat: (params) => ipcRenderer.invoke('ai:agent-chat', params),
  getAgentTools: () => ipcRenderer.invoke('ai:get-agent-tools'),
  getContextMeta: () => ipcRenderer.invoke('ai:get-context-meta'),

  // ===== MCP（外部工具服务器）=====
  mcpStart: (id) => ipcRenderer.invoke('mcp:start', id),
  mcpStop: (id) => ipcRenderer.invoke('mcp:stop', id),
  mcpRestart: (id) => ipcRenderer.invoke('mcp:restart', id),
  mcpStatus: () => ipcRenderer.invoke('mcp:status'),
  mcpSetEnabled: (ids) => ipcRenderer.invoke('mcp:set-enabled', ids),
  mcpHealthCheck: () => ipcRenderer.invoke('mcp:health-check'),
  cancelChat: () => ipcRenderer.invoke('ai:cancel'),
  confirmToolResponse: (allowed) => ipcRenderer.invoke('ai:tool-confirm-response', allowed),
  answerUserGuidance: (id, answer, source) => ipcRenderer.invoke('ai:ask-user-response', { id, answer, source }),
  getAgentRoles: () => ipcRenderer.invoke('agent:roles'),
  saveAgentRole: (role) => ipcRenderer.invoke('agent:role-save', role),
  deleteAgentRole: (roleId) => ipcRenderer.invoke('agent:role-delete', roleId),
  getAIStatus: () => ipcRenderer.invoke('ai:get-status'),
  ollamaListModels: (host) => ipcRenderer.invoke('ai:ollama-list-models', host),
  ollamaTest: (host) => ipcRenderer.invoke('ai:ollama-test', host),

  // ===== 多模态模型支持 =====
  visionDetect: (providerId) => ipcRenderer.invoke('ai:vision-detect', providerId),
  imageToDataUrl: (imagePath, maxWidth) => ipcRenderer.invoke('ai:image-to-dataurl', imagePath, maxWidth),
  multimodalChat: (params) => ipcRenderer.invoke('ai:multimodal-chat', params),

  // ===== 多 Agent 协同工作 =====
  multiAgentPresets: () => ipcRenderer.invoke('ai:multi-agent-presets'),
  multiAgentBuildPreset: (presetId, providerId, overrides) => ipcRenderer.invoke('ai:multi-agent-build-preset', presetId, providerId, overrides),
  multiAgentOrchestrate: (config) => ipcRenderer.invoke('ai:multi-agent-orchestrate', config),
  onMultiAgentEvent: (cb) => {
    const wrapper = (_e, data) => cb(data);
    ipcRenderer.on('ai:multi-agent-event', wrapper);
    return () => ipcRenderer.removeListener('ai:multi-agent-event', wrapper);
  },

  // ===== AI 长期记忆（设置面板「AI 记忆」）=====
  memory: {
    list: (opts) => ipcRenderer.invoke('memory:list', opts),
    search: (query, limit, workdir) => ipcRenderer.invoke('memory:search', query, limit, workdir),
    save: (payload) => ipcRenderer.invoke('memory:save', payload),
    update: (id, patch) => ipcRenderer.invoke('memory:update', id, patch),
    remove: (id) => ipcRenderer.invoke('memory:delete', id),
    clear: (workdir) => ipcRenderer.invoke('memory:clear', workdir),
    stats: () => ipcRenderer.invoke('memory:stats')
  },

  // ===== AI 进化记录（近期动向 / 习惯画像，用于 AI 进化训练）=====
  evolution: {
    list: (limit) => ipcRenderer.invoke('evolution:list', limit),
    stats: (days) => ipcRenderer.invoke('evolution:stats', days),
    profile: () => ipcRenderer.invoke('evolution:profile'),
    clear: () => ipcRenderer.invoke('evolution:clear')
  },

  // ===== 待办事项（当前会话的任务清单）=====
  todo: {
    read: (conversationId) => ipcRenderer.invoke('todo:read', conversationId),
    write: (conversationId, items, title) => ipcRenderer.invoke('todo:write', conversationId, items, title),
    update: (conversationId, patch) => ipcRenderer.invoke('todo:update', conversationId, patch),
    clear: (conversationId) => ipcRenderer.invoke('todo:clear', conversationId),
    stats: () => ipcRenderer.invoke('todo:stats')
  },

  // ===== UI 自验证（截图 / 布局自检）=====
  ui: {
    capture: (opts) => ipcRenderer.invoke('ui:capture', opts),
    listWindows: () => ipcRenderer.invoke('ui:list-windows'),
    audit: (opts) => ipcRenderer.invoke('ui:audit', opts),
    shotsDir: () => ipcRenderer.invoke('ui:shots-dir')
  },

  // ===== 原生虚拟桌面（Windows Virtual Desktop）=====
  // 让截屏在独立桌面环境里进行，不打扰用户当前桌面。
  vdesktop: {
    status: () => ipcRenderer.invoke('vdesktop:status'),
    list: () => ipcRenderer.invoke('vdesktop:list'),
    current: () => ipcRenderer.invoke('vdesktop:current'),
    switchTo: (id) => ipcRenderer.invoke('vdesktop:switch', id),
    create: () => ipcRenderer.invoke('vdesktop:create'),
    remove: (id, fallbackId) => ipcRenderer.invoke('vdesktop:remove', { id, fallbackId }),
    windowDesktop: (hwnd) => ipcRenderer.invoke('vdesktop:window-desktop', hwnd),
    moveWindow: (hwnd, id) => ipcRenderer.invoke('vdesktop:move-window', { hwnd, id })
  },

  // ===== 截屏授权（管理员密码，票据只存内存）=====
  screenshotAuth: {
    status: () => ipcRenderer.invoke('screenshot-auth:status'),
    request: (reason) => ipcRenderer.invoke('screenshot-auth:request', { reason }),
    revoke: () => ipcRenderer.invoke('screenshot-auth:revoke')
  },

  // ===== 隔离桌面（桌面分身）：CreateDesktop 独立桌面 =====
  // ⚠️ 只用于「不需要看界面」的任务（编译/跑脚本/后台程序），跑完汇报文本结果。
  //    预览相关接口（openPreview / closePreview / onFrame）已移除 ——
  //    隔离桌面的画面用户看不到，做预览没有意义。需要看界面的任务在真实桌面做。
  cloneDesktop: {
    status: () => ipcRenderer.invoke('clone:status'),
    ensure: (opts) => ipcRenderer.invoke('clone:ensure', opts),
    exit: () => ipcRenderer.invoke('clone:exit'),
    childSession: () => ipcRenderer.invoke('clone:child-session'),
    // AI 对话页是否可见：预览小窗只在对话页展示。隐藏**不销毁**，后台继续跑，
    // 直到 AI 任务跑完或用户点 ✕（渲染端切页/窗口显示隐藏时上报）。
    setPageVisible: (on) => ipcRenderer.send('clone:page-visible', !!on),
    // 监听桌面分身状态广播（starting/running/error/idle）
    // 悬浮窗方案：宿主自己就是可见窗口，渲染端只保留轻量状态指示，不再有抓帧/前置聚焦接口
    onState: (cb) => {
      const w = (_e, data) => cb(data);
      ipcRenderer.on('desktop:state', w);
      return () => ipcRenderer.removeListener('desktop:state', w);
    }
  },

  // ===== 画中画（PiP）：主窗口缩到右下角显示被 AI 操作的程序 =====
  // 用户能在小窗里看 AI 干了什么，点一下画面即可接管（坐标换算由主进程做）。
  pip: {
    enter: (title, fps) => ipcRenderer.invoke('pip:enter', { title, fps }),
    exit: () => ipcRenderer.invoke('pip:exit'),
    status: () => ipcRenderer.invoke('pip:status'),
    setTarget: (title) => ipcRenderer.invoke('pip:set-target', title),
    // 用户在画面上点击 → 转发到真实窗口。rx/ry 是画面内相对坐标(0~1)
    forwardClick: (rx, ry, opts) => ipcRenderer.invoke('pip:forward-click', { rx, ry, ...(opts || {}) }),
    refresh: () => ipcRenderer.invoke('pip:refresh'),
    onFrame: (cb) => {
      const w = (_e, data) => cb(data);
      ipcRenderer.on('pip:frame', w);
      return () => ipcRenderer.removeListener('pip:frame', w);
    },
    onState: (cb) => {
      const w = (_e, data) => cb(data);
      ipcRenderer.on('pip:state', w);
      return () => ipcRenderer.removeListener('pip:state', w);
    }
  },

  // System
  getSystemInfo: () => ipcRenderer.invoke('sys:get-info'),
  browseUrl: (url) => ipcRenderer.invoke('sys:browse-url', url),

  // Notifications
  notify: (title, body) => ipcRenderer.invoke('notify:show', { title, body }),

  // Dialogs
  confirm: (options) => ipcRenderer.invoke('dialog:confirm', options),
  showError: (title, message, detail) => ipcRenderer.invoke('dialog:error', { title, message, detail }),

  // Event listeners
  on: (channel, callback) => {
    const wrapper = (_e, data) => callback(data);
    ipcRenderer.on(channel, wrapper);
    return () => ipcRenderer.removeListener(channel, wrapper);
  },

  // BongoCat：启动/停止全局键盘钩子（与 window.isBongocatMode 同步）
  setBongocatActive: (active) => ipcRenderer.invoke('bongocat:set-active', !!active),
  // BongoCat：获取模型目录中的键盘叠加层图片列表（resources/left-keys 和 right-keys）
  bongocatGetKeyImages: (modelDir) => ipcRenderer.invoke('bongocat:get-key-images', modelDir),

  // ★ 右键菜单（独立窗口，不遮挡模型，样式与退出弹窗一致）
  showContextMenu: (x, y, items) => ipcRenderer.invoke('pet:show-context-menu', { x, y, items }),
  onContextMenuAction: (callback) => {
    const wrapper = (_e, action) => callback(action);
    ipcRenderer.on('pet:context-menu-action', wrapper);
    return () => ipcRenderer.removeListener('pet:context-menu-action', wrapper);
  },

  // ★ 动作模组面板（独立窗口）
  showActionPanel: (x, y, actions) => ipcRenderer.invoke("pet:show-action-panel", { x, y, actions }),
  hideActionPanel: () => ipcRenderer.invoke("pet:hide-action-panel"),
  onActionPanelTrigger: (callback) => {
    const wrapper = (_e, data) => callback(data);
    ipcRenderer.on("action-panel:trigger", wrapper);
    return () => ipcRenderer.removeListener("action-panel:trigger", wrapper);
  },
  onActionPanelClosed: (callback) => {
    const wrapper = () => callback();
    ipcRenderer.on("action-panel:closed", wrapper);
    return () => ipcRenderer.removeListener("action-panel:closed", wrapper);
  },

  // ★ 输入框（独立窗口）
  showInputBar: (x, y) => ipcRenderer.invoke("pet:show-input-bar", { x, y }),
  hideInputBar: () => ipcRenderer.invoke("pet:hide-input-bar"),
  onInputBarSend: (callback) => {
    const wrapper = (_e, text) => callback(text);
    ipcRenderer.on("input-bar:send", wrapper);
    return () => ipcRenderer.removeListener("input-bar:send", wrapper);
  },
  onInputBarFocus: (callback) => {
    const wrapper = (_e, focused) => callback(focused);
    ipcRenderer.on("input-bar:focus-change", wrapper);
    return () => ipcRenderer.removeListener("input-bar:focus-change", wrapper);
  },

  // ★ 右键菜单（独立窗口）- 设置中关闭时调用，释放资源
  closeContextMenu: () => ipcRenderer.invoke("pet:close-context-menu"),

  // ★ 宠物窗口边界调整：按模型实际渲染边界包裹窗口（去除多余空白区域）
  // 渲染进程在模型加载完成后计算实际边界，通知主进程调整窗口大小并保持居中
  setPetWindowBounds: (width, height, centerX, centerY) =>
    ipcRenderer.invoke('pet:set-window-bounds', {
      width: Math.round(width),
      height: Math.round(height),
      centerX: typeof centerX === 'number' ? centerX : null,
      centerY: typeof centerY === 'number' ? centerY : null
    }),

  // Utilities
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  getChangelog: () => ipcRenderer.invoke('changelog:get'),
  checkUpdate: () => ipcRenderer.invoke('changelog:check-update'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateGetVersion: () => ipcRenderer.invoke('update:get-version'),
  getFullInstall: () => ipcRenderer.invoke('update:get-full-install'),
  updateDownload: (patchInfo) => ipcRenderer.invoke('update:download', patchInfo),
  updateVerify: (data) => ipcRenderer.invoke('update:verify', data),
  updateApply: (data) => ipcRenderer.invoke('update:apply', data),
  updateRunInstaller: (data) => ipcRenderer.invoke('update:run-installer', data),
  updateRollback: (version) => ipcRenderer.invoke('update:rollback', version),
  updateIgnore: (data) => ipcRenderer.invoke('update:ignore', data),
  updateGetBackups: () => ipcRenderer.invoke('update:get-backups'),
  relaunchApp: () => ipcRenderer.invoke('app:relaunch'),
  onUpdateDownloadProgress: (callback) => { ipcRenderer.on('update:download-progress', (_e, data) => callback(data)); },
  onWindowStateChanged: (callback) => { ipcRenderer.on('window:state-changed', (_e, data) => callback(data)); },
  // 完整包下载中心
  updateDownloadFull: (fullInstall) => ipcRenderer.invoke('update:download-full', fullInstall),
  updateGetDownloads: () => ipcRenderer.invoke('update:get-downloads'),
  updateDeleteDownload: (data) => ipcRenderer.invoke('update:delete-download', data),
  updateShowInFolder: (data) => ipcRenderer.invoke('update:show-in-folder', data),
  updateGetFileIcon: (data) => ipcRenderer.invoke('update:get-file-icon', data),
  updateGetDownloadDir: () => ipcRenderer.invoke('update:get-download-dir'),
  updateSetDownloadDir: (data) => ipcRenderer.invoke('update:set-download-dir', data),
  updateResetDownloadDir: () => ipcRenderer.invoke('update:reset-download-dir'),
  updateChooseDownloadDir: () => ipcRenderer.invoke('update:choose-download-dir'),
  onFullDownloadProgress: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on('update:full-progress', handler);
    return () => ipcRenderer.removeListener('update:full-progress', handler);
  },

  // 崩溃/异常上报：渲染进程把 window.error / 未捕获 Promise / WebGL 上下文丢失等
  // 上报到主进程写入 crash.log，避免“闪退无日志”无法定位。
  logCrash: (msg) => ipcRenderer.invoke('app:log-crash', String(msg || '')),
  getCrashLog: () => ipcRenderer.invoke('app:get-crash-log'),

  // 动作编辑器独立窗口控制
  editor: {
    open: (params) => ipcRenderer.invoke('editor:open', params),
    minimize: () => ipcRenderer.invoke('editor:minimize'),
    maximize: () => ipcRenderer.invoke('editor:maximize'),
    isMaximized: () => ipcRenderer.invoke('editor:is-maximized'),
    close: () => ipcRenderer.invoke('editor:close'),
    saved: (modelId) => ipcRenderer.invoke('editor:saved', modelId)
  },

  // Chat History
  saveChatHistory: (history) => ipcRenderer.invoke('chat:save', history),
  loadChatHistory: () => ipcRenderer.invoke('chat:load'),
  clearChatHistory: () => ipcRenderer.invoke('chat:clear'),
  // 检查项目工作目录是否仍存在
  checkProjectExists: (p) => ipcRenderer.invoke('project:exists', p),

  // Speech Recognition (Windows SAPI via IPC)
  speechRecognize: () => ipcRenderer.invoke('speech:recognize'),
  speechStop: () => ipcRenderer.invoke('speech:stop'),
  speechRecognizeWav: (wavBuffer) => ipcRenderer.invoke('speech:recognize-wav', wavBuffer),
  // WaveIn 音频录制（主进程采集，避免渲染进程崩溃）
  speechRecordStart: () => ipcRenderer.invoke('speech:record-start'),
  speechRecordStop: () => ipcRenderer.invoke('speech:record-stop'),
  // ASR 模块（Sherpa-ONNX + SenseVoice int8）模块式下载
  asrStatus: () => ipcRenderer.invoke('voice:asr-status'),
  asrDownload: () => ipcRenderer.invoke('voice:asr-download'),
  asrCancelDownload: () => ipcRenderer.invoke('voice:asr-download-cancel'),
  onAsrProgress: (cb) => ipcRenderer.on('voice:asr-progress', (_e, data) => cb(data)),

  // Path utilities (safe for renderer)
  path: {
    join: (...args) => path.join(...args),
    dirname: (p) => path.dirname(p),
    basename: (p, ext) => path.basename(p, ext),
    extname: (p) => path.extname(p),
    resolve: (...args) => path.resolve(...args)
  },
  os: {
    homedir: () => os.homedir(),
    platform: () => os.platform(),
    arch: () => os.arch()
  },

  // 系统工具
  openExternal: (url) => ipcRenderer.invoke('sys:browse-url', url),
  openHtml: (html) => ipcRenderer.invoke('shell:open-html', html),
  saveCodeFile: (code, lang) => ipcRenderer.invoke('code:save-file', code, lang),

  // ===== BongoCat 键盘猫专用 =====
  getBongocatModel: () => ipcRenderer.invoke('bongocat:get-model'),
  setBongocatModel: (modelPath) => ipcRenderer.invoke('bongocat:set-model', modelPath),
  launchBongocat: (modelPath) => ipcRenderer.invoke('bongocat:launch', modelPath),
  closeBongocat: () => ipcRenderer.invoke('bongocat:close'),
  fileExists: (filePath) => ipcRenderer.invoke('bongocat:file-exists', filePath),

  // ===== 独立调试日志窗口 =====
  toggleDebugLog: () => ipcRenderer.invoke('debug-log:toggle'),
  sendDebugLog: (type, msg) => ipcRenderer.send('debug-log:send', type, msg)
,

  // ===== Supabase 账号系统 =====
  supabase: {
    getConfig: () => ipcRenderer.invoke('supabase:get-config'),
    saveConfig: (config) => ipcRenderer.invoke('supabase:save-config', config),
    login: (data) => ipcRenderer.invoke('supabase:login', data),
    getEmailByUsername: (username) => ipcRenderer.invoke('supabase:get-email-by-username', { username }),
    githubLogin: () => ipcRenderer.invoke('supabase:github-login'),
    register: (data) => ipcRenderer.invoke('supabase:register', data),
    logout: () => ipcRenderer.invoke('supabase:logout'),
    clearSession: () => ipcRenderer.invoke('supabase:clearSession'),
    updateEmail: (data) => ipcRenderer.invoke('supabase:update-email', data),
    resetPassword: (data) => ipcRenderer.invoke('supabase:reset-password', data),
    getCurrentUser: () => ipcRenderer.invoke('supabase:get-current-user'),
    updateProfile: (data) => ipcRenderer.invoke('supabase:update-profile', data),
    changePassword: (data) => ipcRenderer.invoke('supabase:change-password', data),
    loadSettings: () => ipcRenderer.invoke('supabase:load-settings'),
    syncSettings: (settings) => ipcRenderer.invoke('supabase:sync-settings', settings),
    // 网络诊断：返回各候选端点连通性 + 系统代理信息
    diagnose: () => ipcRenderer.invoke('supabase:diagnose')
  },

  // ===== 安全中心 =====
  security: {
    getConfig: () => ipcRenderer.invoke('security:get-config'),
    setConfig: (config) => ipcRenderer.invoke('security:set-config', config),
    getStatus: () => ipcRenderer.invoke('security:get-status'),
    checkCommand: (command) => ipcRenderer.invoke('security:check-command', command),
    checkFile: (filePath, operation) => ipcRenderer.invoke('security:check-file', filePath, operation),
    checkNetwork: (url, method) => ipcRenderer.invoke('security:check-network', url, method),
    scanSensitive: (text) => ipcRenderer.invoke('security:scan-sensitive', text),
    encrypt: (text) => ipcRenderer.invoke('security:encrypt', text),
    decrypt: (text) => ipcRenderer.invoke('security:decrypt', text),
    // 纸篓
    trashList: (type) => ipcRenderer.invoke('security:trash-list', type),
    trashAdd: (item, type) => ipcRenderer.invoke('security:trash-add', item, type),
    trashRestore: (id) => ipcRenderer.invoke('security:trash-restore', id),
    trashDelete: (id) => ipcRenderer.invoke('security:trash-delete', id),
    trashClear: (type) => ipcRenderer.invoke('security:trash-clear', type),
    // 审计日志
    auditList: (filters) => ipcRenderer.invoke('security:audit-list', filters),
    auditExport: (format) => ipcRenderer.invoke('security:audit-export', format),
    auditClear: (filters) => ipcRenderer.invoke('security:audit-clear', filters),
    auditAdd: (category, action, details, risk) => ipcRenderer.invoke('security:audit-add', category, action, details, risk),
    // 备份
    backupCreate: () => ipcRenderer.invoke('security:backup-create'),
    backupList: () => ipcRenderer.invoke('security:backup-list'),
    backupDelete: (name) => ipcRenderer.invoke('security:backup-delete', name)
  },

  // ===== 连通器（需要授权的外部服务）=====
  connector: {
    list: () => ipcRenderer.invoke('connector:list'),
    authorize: (id, opts) => ipcRenderer.invoke('connector:authorize', id, opts || {}),
    saveCredential: (id, token) => ipcRenderer.invoke('connector:save-credential', id, token),
    setClientId: (id, clientId) => ipcRenderer.invoke('connector:set-client-id', id, clientId),
    setAppSecret: (id, secret) => ipcRenderer.invoke('connector:set-app-secret', id, secret),
    disconnect: (id) => ipcRenderer.invoke('connector:disconnect', id),
    setEnabled: (id, enabled) => ipcRenderer.invoke('connector:set-enabled', id, enabled),
    healthCheck: () => ipcRenderer.invoke('connector:health-check'),
    // OAuth 回调发生在主进程，通过事件通知渲染层
    onEvent: (cb) => {
      const listener = (_e, payload) => { try { cb(payload); } catch (err) { /* 回调异常不崩主进程 */ } };
      ipcRenderer.on('connector:event', listener);
      return () => ipcRenderer.removeListener('connector:event', listener);
    }
  },

  // ===== 智能商城（本地，无服务器）=====
  marketplace: {
    list: () => ipcRenderer.invoke('marketplace:list'),
    install: (id) => ipcRenderer.invoke('marketplace:install', id),
    installWithEnv: (id, envValues) => ipcRenderer.invoke('marketplace:install-with-env', id, envValues),
    uninstall: (id) => ipcRenderer.invoke('marketplace:uninstall', id),
    setEnabled: (id, enabled) => ipcRenderer.invoke('marketplace:set-enabled', id, enabled),
    status: () => ipcRenderer.invoke('marketplace:status'),
    importFile: () => ipcRenderer.invoke('marketplace:import-file'),
    importUrl: (url) => ipcRenderer.invoke('marketplace:import-url', url)
  }
});

