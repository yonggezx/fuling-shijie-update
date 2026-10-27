'use strict';
/**
 * 浮灵饰界 · 事件日志（唯一可信源）
 *
 * 三性保证：
 *  - append-only：只追加，永不删除/修改已写入事件
 *  - immutable：事件写入后不可变
 *  - atomic：单条事件要么完整写入要么不写
 *
 * 核心规则：模型所见 = 日志内容。任何状态变更都通过追加事件完成；
 * 状态由事件流「折叠（fold）」重建，不做第二份状态。
 */
const { randomId } = require('./util');

class EventLog {
  constructor({ store = null } = {}) {
    this.events = [];          // 追加式事件流（权威）
    this.seq = 0;              // 单调递增序号
    this.listeners = [];       // 实时订阅（供事件总线消费）
    this.store = store || null; // 可选持久化适配器 { append(ev) }
  }

  _now() {
    return new Date().toISOString();
  }

  nextSeq() {
    return ++this.seq;
  }

  /**
   * 追加一条事件。外部只需给 type / payload / scope；
   * event_id / seq / ts 由日志生成，保证原子与单调。
   */
  append({ type, payload = {}, scope = {} }) {
    const seq = this.nextSeq();
    const ev = {
      event_id: randomId('evt', seq),
      seq,
      ts: this._now(),
      type,
      scope,
      payload,
    };
    this.events.push(ev); // append-only
    this._notify(ev);
    return ev;
  }

  _notify(ev) {
    if (this.store && typeof this.store.append === 'function') {
      try { this.store.append(ev); } catch (_) { /* 持久化失败不阻断执行 */ }
    }
    for (const l of this.listeners) {
      try { l(ev); } catch (_) { /* 订阅者异常不阻断 */ }
    }
  }

  /** 实时订阅（如：事件总线消费同一份日志）。返回退订函数。 */
  onAppend(fn) {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter((x) => x !== fn); };
  }

  /** 回放：返回从 fromSeq 起的完整事件序列。 */
  replay(fromSeq = 0) {
    return this.events.filter((e) => e.seq >= fromSeq);
  }

  /** 按作用域回放（session / turn / step 可省略）。 */
  replayScope({ session, turn, step } = {}) {
    return this.events.filter((e) => {
      if (session && e.scope.session !== session) return false;
      if (turn && e.scope.turn !== turn) return false;
      if (step && e.scope.step !== step) return false;
      return true;
    });
  }

  /** 折叠：由事件流重建状态。状态 = 日志的纯函数。 */
  fold(reducer, seed) {
    return this.events.reduce(reducer, seed);
  }

  /**
   * 恢复：从已持久化的事件重建日志（用于断点续跑 / 崩溃恢复）。
   * 幂等：跳过已存在的 seq；恢复后 this.seq 取最大 seq，后续 append 正确续号。
   * @returns 实际新增条数
   */
  restore(events) {
    if (!Array.isArray(events) || events.length === 0) return 0;
    const sorted = events.slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
    const existing = new Set(this.events.map((e) => e.seq));
    let added = 0;
    for (const ev of sorted) {
      if (ev.seq == null || existing.has(ev.seq)) continue;
      this.events.push(ev);
      existing.add(ev.seq);
      added++;
    }
    this.seq = this.events.reduce((m, e) => Math.max(m, e.seq || 0), 0);
    return added;
  }
}

module.exports = { EventLog };
