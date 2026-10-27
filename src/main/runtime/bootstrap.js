'use strict';
/**
 * 主进程优雅接入入口：供 src/main/main.js 在应用启动时安全加载。
 * 任何失败都不影响主应用启动（全程 try/catch + 异步创建）。
 */
const { createRuntime } = require('./index');

let _rt = null;
let _err = null;

/** 返回 createRuntime() 的 Promise；失败仅记录，不抛出到主进程。 */
function runtime() {
  if (_rt) return _rt;
  if (_err) return Promise.reject(_err);
  _rt = createRuntime({}).then((rt) => {
    _rt = rt;
    return rt;
  }).catch((e) => { _err = e; throw e; });
  return _rt;
}

module.exports = { createRuntime, runtime };
