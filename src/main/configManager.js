const fs = require('fs');
const path = require('path');

const pkg = require('../../package.json');

const defaultConfig = {
  version: pkg.version,
  currentModel: null,
  pet: {
    name: '灵汐',
    size: 1.0,
    opacity: 0,
    frameRate: 60,
    alwaysOnTop: true,
    showIdleAnimation: true,
    idleTimeout: 30,
    draggable: true,
    clickThrough: false,
    position: { x: null, y: null }
  },
  ai: {
    activeProvider: null,
    localModels: [],
    cloudProviders: [],
    temperature: 0.7,
    maxTokens: 2048,
    systemPrompt: '你是浮灵饰界的智能助手灵汐，一个运行在Windows桌面上的智能助手。你可以帮助用户回答问题、编写代码、管理文件、执行系统命令、推荐软件等。你的特点：\n1. 回复简洁友好，像一只灵动的小狐狸\n2. 熟悉Windows系统操作\n3. 支持中英文双语交流\n4. 优先用中文回复，除非用户使用英文提问\n5. 涉及技术问题时给出准确、实用的建议',
    voiceEnabled: false,
    voiceRate: 1.0,
    voicePitch: 1.0,
    // 看图用的视觉模型（verify_ui / analyze_screenshot）：
    // providerId 为空则跟随当前激活提供商，model 为空则按提供商自动推断（如 dashscope → qwen-vl-max）
    vision: { providerId: null, model: '' },
    // 本地模型（非 Ollama）推理引擎：
    // binPath = llama-server(.exe) 完整路径（留空则自动在 PATH / 常见目录里找）；
    // port    = 指定端口（留空则优先复用已在运行的本地服务，否则自动挑空闲端口）；
    // extraArgs/contextSize 会追加到 llama-server 命令行。
    localEngine: { binPath: '', port: 0, contextSize: 0, gpuLayers: 0, kvCacheType: 'q8_0', extraArgs: [] }
  },
  system: {
    confirmDangerOps: true,
    showNotifications: true,
    autoStart: false,
    autoCheckUpdate: true,
    language: 'zh-CN',
    theme: 'dark'
  },
  taskbar: {
    enabled: true,
    effect: 'normal'
  },
  // ===== 个性化 + 记忆（设置 → 功能设置）=====
  // systemPrompt 从原来的 ai.systemPrompt 搬过来（用户 2026-10-03 要求挪到功能设置里统一管理）
  personalization: {
    memoryEnabled: true,        // 长期记忆总开关：关掉后 AI 不再读写长期记忆
    autoRecordHabits: true,     // 自动记录近期习惯与动向
    evolveEnabled: true,        // 把这些记录用于「AI 进化训练」（生成习惯画像并注入提示词）
    replyStyle: 'default',      // 回复风格：default/concise/detailed/warm/professional/humorous
    personaName: '灵汐',
    personaRole: '桌面 AI 助手',
    personaDesc: '',            // 人格描述：性格、边界、说话习惯
    customInstructions: '',     // 自定义指令：给 AI 回答制定规则
    systemPrompt: ''            // AI 系统提示词（留空 = 用应用内置默认）
  },
  disclaimer: {
    accepted: false,
    acceptedAt: null
  }
};

let config = null;
let configFilePath = null;

function init(filePath) {
  configFilePath = filePath;
  if (fs.existsSync(filePath)) {
    try {
      const data = fs.readFileSync(filePath, 'utf-8');
      config = mergeDeep(defaultConfig, JSON.parse(data));
      // 品牌迁移：旧版 AI龙虾 -> 浮灵饰界灵汐
      if (config.ai && config.ai.systemPrompt && config.ai.systemPrompt.includes('AI龙虾')) {
        config.ai.systemPrompt = defaultConfig.ai.systemPrompt;
        save();
        console.log('[ConfigMigration] 系统提示词已从 AI龙虾 迁移为 浮灵饰界灵汐');
      }
      // 2026-10-03：系统提示词从「AI 配置」页搬到「设置 → 功能设置 → 个性化」，这里做一次性迁移
      if (config.personalization && !config.personalization.systemPrompt && config.ai && config.ai.systemPrompt) {
        config.personalization.systemPrompt = config.ai.systemPrompt;
        config.ai.systemPrompt = defaultConfig.ai.systemPrompt; // 旧字段复位，避免两处各存一份
        save();
        console.log('[ConfigMigration] 系统提示词已迁移到「功能 → 个性化」');
      }
    } catch (e) {
      config = JSON.parse(JSON.stringify(defaultConfig));
    }
  } else {
    config = JSON.parse(JSON.stringify(defaultConfig));
    save();
  }
  return config;
}

function getConfig() {
  return config ? JSON.parse(JSON.stringify(config)) : JSON.parse(JSON.stringify(defaultConfig));
}

function setConfig(newConfig) {
  config = mergeDeep(config, newConfig);
  save();
  return config;
}

function resetConfig() {
  config = JSON.parse(JSON.stringify(defaultConfig));
  save();
  return config;
}

function save() {
  if (configFilePath) {
    fs.writeFileSync(configFilePath, JSON.stringify(config, null, 2), 'utf-8');
  }
}

function mergeDeep(target, source) {
  if (!source) return target;
  const output = { ...target };
  if (isObject(target) && isObject(source)) {
    Object.keys(source).forEach(key => {
      if (isObject(source[key])) {
        if (!(key in target)) Object.assign(output, { [key]: source[key] });
        else output[key] = mergeDeep(target[key], source[key]);
      } else {
        Object.assign(output, { [key]: source[key] });
      }
    });
  }
  return output;
}

function isObject(item) {
  return item && typeof item === 'object' && !Array.isArray(item);
}

module.exports = { init, getConfig, setConfig, resetConfig, save };
