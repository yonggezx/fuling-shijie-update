'use strict';
/**
 * 事件日志文件持久化适配器（JSONL）。
 *  - append(ev)：追加一行；只持久化【agent 域】事件（含 scope.session），
 *    插件生命周期等运行态事件不入盘，避免每次启动重复。
 *  - load()：读回全部事件，供断点续跑 / 崩溃恢复。
 */
const fs = require('fs');

class FileStore {
  constructor(filePath) {
    this.path = filePath;
  }

  append(ev) {
    if (!ev.scope || !ev.scope.session) return; // 只持久化 agent 域事件
    fs.appendFileSync(this.path, JSON.stringify(ev) + '\n', 'utf8');
  }

  load() {
    if (!fs.existsSync(this.path)) return [];
    const out = [];
    for (const line of fs.readFileSync(this.path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch (_) { /* 跳过坏行 */ }
    }
    return out;
  }

  clear() {
    try { fs.unlinkSync(this.path); } catch (_) {}
  }
}

module.exports = { FileStore };
