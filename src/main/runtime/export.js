'use strict';
/**
 * 事件日志导出工具：把事件流导出为 JSON，供回放/调试 UI 等观测层消费。
 * 观测层只消费同一份事件流，不做第二份状态。
 */
const fs = require('fs');

/** 导出为对象：{ exportedAt, sessionId|null, eventCount, events } */
function toJson(log, { sessionId } = {}) {
  const events = sessionId ? log.replayScope({ session: sessionId }) : log.replay();
  return {
    exportedAt: new Date().toISOString(),
    sessionId: sessionId || null,
    eventCount: events.length,
    events,
  };
}

/** 写入文件（UTF-8，可读缩进） */
function writeJson(log, filePath, opts = {}) {
  const data = toJson(log, opts);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  return data;
}

module.exports = { toJson, writeJson };
