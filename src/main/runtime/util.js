'use strict';
/** 通用工具 */
function randomId(prefix = 'x', seed = null) {
  const s = seed != null ? seed : Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return `${prefix}_${s}`;
}

module.exports = { randomId };
