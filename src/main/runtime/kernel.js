'use strict';
/**
 * 浮灵饰界 · 内核（Cordis）
 *
 * 内核哲学：一切皆插件，内核只做插件管理。
 * 内核【不写 Agent 业务逻辑】，仅负责四件事：
 *   1. 插件加载（loadPlugin / unloadPlugin）
 *   2. 依赖解析（manifest.dependencies）
 *   3. 服务注册（registerService / resolve / unregisterService）
 *   4. 事件分发（on / emit —— 事件总线）+ 钩子管理（addHook / runHook）
 *
 * Agent 主循环、模型适配器、工具、沙箱、工作流、子智能体全部是插件，
 * 可替换、可热卸载；插件之间通过「服务契约 + 事件总线」通信，避免紧耦合。
 */
const { HOOK_POINTS } = require('./hooks');

class Kernel {
  constructor({ log = null, hookPoints = HOOK_POINTS } = {}) {
    this.log = log;                  // 可选事件日志（插件生命周期事件写入）
    this.plugins = new Map();        // name -> { manifest, state, options }
    this.services = new Map();       // name -> impl
    this.handlers = new Map();       // eventName -> [fn]
    this.hookPoints = new Map();     // point -> [{ name, fn, order }]
    this.hookPointsDef = hookPoints;
  }

  // ---------------- 服务注册表 ----------------
  registerService(name, impl) {
    if (this.services.has(name)) throw new Error(`[kernel] 服务已注册: ${name}`);
    this.services.set(name, impl);
    return this;
  }
  unregisterService(name) { this.services.delete(name); return this; }
  hasService(name) { return this.services.has(name); }
  resolve(name) {
    if (!this.services.has(name)) throw new Error(`[kernel] 服务未注册: ${name}`);
    return this.services.get(name);
  }

  // ---------------- 事件总线（发布/订阅） ----------------
  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(fn);
    return () => this.off(event, fn);
  }
  off(event, fn) {
    const arr = this.handlers.get(event);
    if (arr) this.handlers.set(event, arr.filter((x) => x !== fn));
  }
  /** 分发事件：先精确订阅者，再通配 '*' 订阅者；按序 await。 */
  async emit(event, payload = {}) {
    const exact = this.handlers.get(event) || [];
    const wild = this.handlers.get('*') || [];
    for (const fn of [...exact, ...wild]) await fn(payload);
    return payload;
  }

  // ---------------- 钩子（切面点，有序，可中断） ----------------
  addHook(point, fn, opts = {}) {
    if (this.hookPointsDef && !this.hookPointsDef.includes(point)) {
      throw new Error(`[kernel] 未知钩子点: ${point}`);
    }
    if (!this.hookPoints.has(point)) this.hookPoints.set(point, []);
    this.hookPoints.get(point).push({ name: opts.name || 'anon', fn, order: opts.order || 0 });
    this.hookPoints.get(point).sort((a, b) => a.order - b.order);
  }
  removeHook(point, fn) {
    const arr = this.hookPoints.get(point);
    if (arr) this.hookPoints.set(point, arr.filter((x) => x.fn !== fn));
  }
  hasHook(point) { return (this.hookPoints.get(point) || []).length > 0; }
  /**
   * 依次执行钩子。handler 返回 { abort:true, reason } 时中断后续钩子，
   * 并在 ctx 上标记 abort/reason，供主循环决定是否阻断。
   */
  async runHook(point, ctx = {}) {
    const arr = this.hookPoints.get(point) || [];
    for (const h of arr) {
      const r = await h.fn(ctx);
      if (r && r.abort) {
        ctx.abort = true;
        ctx.reason = r.reason || 'hook-aborted';
        break;
      }
    }
    return ctx;
  }

  // ---------------- 插件生命周期 ----------------
  /**
   * 加载插件：依赖解析 → setup（注册服务/订阅事件/挂钩子）→ loaded。
   * @param {object} plugin  插件定义 { name, version, dependencies, provides, setup, teardown }
   * @param {object} [opts]  加载选项 { options } —— options 透传给插件 ctx（如风控策略）
   */
  async loadPlugin(plugin, { options = {} } = {}) {
    const { name, version = '0.0.0' } = plugin;
    if (this.plugins.has(name)) throw new Error(`[kernel] 插件已存在: ${name}`);

    // 依赖解析：按服务契约校验依赖是否已注册
    for (const dep of plugin.dependencies || []) {
      if (!this.hasService(dep)) throw new Error(`[kernel] 插件 ${name} 依赖缺失: ${dep}`);
    }

    this.plugins.set(name, { manifest: plugin, state: 'loading', options });
    const ctx = this._ctxFor(name, options);
    if (plugin.setup) await plugin.setup(ctx);
    this.plugins.set(name, { manifest: plugin, state: 'loaded', options });
    if (this.log) this.log.append({ type: 'plugin.loaded', scope: { plugin: name }, payload: { name, version } });
    return ctx;
  }

  /** 热卸载：teardown → 注销提供的服务 → 移除插件记录。 */
  async unloadPlugin(name) {
    const rec = this.plugins.get(name);
    if (!rec) throw new Error(`[kernel] 插件不存在: ${name}`);
    if (rec.manifest.teardown) await rec.manifest.teardown(this._ctxFor(name, rec.options));
    for (const svc of (rec.manifest.provides && rec.manifest.provides.services) || []) {
      this.unregisterService(svc);
    }
    this.plugins.delete(name);
    if (this.log) this.log.append({ type: 'plugin.unloaded', scope: { plugin: name }, payload: { name } });
  }

  _ctxFor(name, options = {}) {
    const self = this;
    return {
      kernel: self,
      log: self.log,
      pluginName: name,
      options,
      registerService: (n, i) => self.registerService(n, i),
      unregisterService: (n) => self.unregisterService(n),
      resolve: (n) => self.resolve(n),
      hasService: (n) => self.hasService(n),
      on: (e, f) => self.on(e, f),
      off: (e, f) => self.off(e, f),
      emit: (e, p) => self.emit(e, p),
      addHook: (p, f, o) => self.addHook(p, f, o),
      removeHook: (p, f) => self.removeHook(p, f),
      runHook: (p, c) => self.runHook(p, c),
      hasHook: (p) => self.hasHook(p),
    };
  }
}

module.exports = { Kernel };
