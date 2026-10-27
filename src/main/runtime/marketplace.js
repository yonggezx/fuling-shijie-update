'use strict';
/**
 * 已下载插件的加载器（轻量）。
 *
 * 说明：这里不实现“下载/安装”的传输机制——插件包已就位于 pkgs/ 下，
 * 代表“已经下载下来的插件”。本模块负责：列出商店包、把已下载的包
 * 加载进内核（相当于运行时安装/装配），并支持热卸载（走 kernel.unloadPlugin）。
 */
const fs = require('fs');
const path = require('path');

class PluginStore {
  constructor({ storeDir }) {
    this.storeDir = storeDir;
  }

  /** 列出商店里已下载的插件包 */
  list() {
    if (!fs.existsSync(this.storeDir)) return [];
    return fs.readdirSync(this.storeDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const pj = path.join(this.storeDir, e.name, 'plugin.json');
        if (!fs.existsSync(pj)) return null;
        try { return JSON.parse(fs.readFileSync(pj, 'utf8')); } catch (_) { return null; }
      })
      .filter(Boolean);
  }

  get(name) {
    return this.list().find((p) => p.name === name) || null;
  }

  /** 把已下载的插件包装配进内核（模拟“下载后即可用，现被运行时加载”） */
  async load(kernel, name) {
    const pkg = this.get(name);
    if (!pkg) throw new Error(`包不存在: ${name}`);
    const entry = path.join(this.storeDir, name, pkg.entry || 'index.js');
    if (!fs.existsSync(entry)) throw new Error(`包 ${name} 缺少入口: ${entry}`);
    const abs = require.resolve(entry);
    delete require.cache[abs]; // 支持卸载后再加载
    const mod = require(entry);
    await kernel.loadPlugin(mod);
    return mod;
  }
}

module.exports = { PluginStore };
