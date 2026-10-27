'use strict';
/**
 * 浮灵饰界 · 插件化运行时入口
 *
 * 核心定位：面向 AI 智能体的可调试、可回放插件化运行时。
 * 内核（Cordis）只做插件管理；主循环 / 模型适配器 / 工具 / 风控 / 审计
 * / 子智能体 / Skill 模板全部是插件。
 *
 * createRuntime(options) → { log, kernel, state }
 *   - options.store   可选持久化适配器 { append(ev), load() }，如 store/file-store 的 FileStore；
 *                     提供 load() 时启动会先恢复已落盘事件（断点续跑 / 崩溃恢复）。
 *   - options.deny    风控默认禁用工具清单（数组）
 */
const { EventLog } = require('./event-log');
const { Kernel } = require('./kernel');
const { FileStore } = require('./store/file-store');
const { EvalSuite } = require('./eval');
const { toJson, writeJson } = require('./export');
const state = require('./state');
const { toolBasic } = require('./plugins/tool-basic');
const { mockModel } = require('./plugins/model-adapter');
const { reactLoop } = require('./react-loop');
const { audit } = require('./plugins/audit');
const { guard } = require('./plugins/guard');
const { subagentPlugin } = require('./plugins/subagent');
const { skillPlugin } = require('./plugins/skill');

async function createRuntime(options = {}) {
  const store = options.store || null;
  const log = new EventLog({ store });

  // 断点续跑：启动时先从持久化存储恢复事件
  if (store && typeof store.load === 'function') {
    log.restore(store.load());
  }

  const kernel = new Kernel({ log });

  // 一等公民：事件日志是唯一事件源；事件总线消费同一份日志（避免第二份状态）
  log.onAppend((ev) => { kernel.emit(ev.type, ev).catch(() => {}); });

  // 加载插件（顺序即依赖解析）：工具 → 模型 → 横切（审计/风控）→ 主循环 → 子智能体 → Skill
  await kernel.loadPlugin(toolBasic);
  await kernel.loadPlugin(mockModel);
  await kernel.loadPlugin(audit);
  await kernel.loadPlugin(guard, { options: { deny: options.deny || ['delete-everything'] } });
  await kernel.loadPlugin(reactLoop);
  await kernel.loadPlugin(subagentPlugin);
  await kernel.loadPlugin(skillPlugin);

  return { log, kernel, state };
}

module.exports = { createRuntime, EventLog, Kernel, FileStore, EvalSuite, toJson, writeJson, state };
