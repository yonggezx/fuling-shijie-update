// 语音录制 worker 宿主（主进程侧）
// 主进程只做消息转发，绝不在主线程碰 MCI/koffi 同步调用。
// - 懒启动：第一次用到才 spawn worker（约几十 ms，异步无感）
// - request id 配对 + 超时：worker 卡死时兜底 reject 并重建
// - available 结果缓存 60s（原来每次点击都同步 open/close 测一遍设备）
// - 崩溃自愈：worker 意外退出 → 清空状态，下次调用自动重建

const { Worker } = require('worker_threads');
const path = require('path');

const START_TIMEOUT = 8000;   // MCI open+record 最长容忍
const STOP_TIMEOUT = 10000;   // stop+save+读盘+转换 最长容忍
const AVAIL_TIMEOUT = 5000;
const AVAIL_CACHE_TTL = 60 * 1000;

class VoiceRecorderHost {
  constructor() {
    this.worker = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, timer }
    this.recording = false;
    this.availCache = { value: null, at: 0 };
    this.spawnPromise = null;
  }

  _spawn() {
    if (this.worker && this._workerAlive()) return this.worker;
    this._rejectAll('语音录制线程异常退出，请重试');
    this.recording = false;
    const w = new Worker(path.join(__dirname, 'voiceRecorderWorker.js'));
    w.on('message', (msg) => this._onMessage(msg));
    w.on('error', (e) => {
      console.error('[VoiceHost] worker error:', e.message);
      this._rejectAll('语音录制线程错误: ' + e.message);
      this.recording = false;
    });
    w.on('exit', () => {
      if (this.worker === w) this.worker = null;
      this._rejectAll('语音录制线程已退出');
      this.recording = false;
    });
    this.worker = w;
    return w;
  }

  _workerAlive() {
    return this.worker && !this.worker._shuttingDown;
  }

  _onMessage(msg) {
    const { id, ok, result, error } = msg || {};
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    if (ok) entry.resolve(result);
    else entry.reject(new Error(error || 'worker 调用失败'));
  }

  _rejectAll(reason) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  _call(cmd, payload, timeout, options) {
    const w = this._spawn();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // 超时说明 worker 里 MCI 调用卡死，重建线程自愈
        this._terminateWorker(`语音录制线程无响应（${cmd} 超时 ${timeout}ms）`);
        reject(new Error(`语音录制线程无响应（${cmd}）`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        w.postMessage({ id, cmd, options });
        void payload;
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  _terminateWorker(reason) {
    console.warn('[VoiceHost]', reason);
    if (this.worker) {
      try { this.worker.terminate(); } catch (_) {}
      this.worker = null;
    }
    this._rejectAll(reason);
    this.recording = false;
  }

  async isAvailable() {
    const now = Date.now();
    if (this.availCache.value !== null && now - this.availCache.at < AVAIL_CACHE_TTL) {
      return this.availCache.value;
    }
    try {
      const ok = await this._call('available', null, AVAIL_TIMEOUT);
      this.availCache = { value: !!ok, at: now };
      return this.availCache.value;
    } catch (e) {
      console.error('[VoiceHost] 设备可用性检查失败:', e.message);
      return false;
    }
  }

  async start(options) {
    // 旧语义：已有录制则先丢弃旧录制再开新的
    if (this.recording) {
      try { await this._call('stop', null, STOP_TIMEOUT); } catch (_) {}
      this.recording = false;
    }
    const r = await this._call('start', null, START_TIMEOUT, options);
    this.recording = !!(r && r.success);
    return r;
  }

  async stop() {
    if (!this.recording) {
      return { success: false, error: '未在录制中' };
    }
    const r = await this._call('stop', null, STOP_TIMEOUT);
    this.recording = false;
    return r;
  }

  // 加载 ASR 模块（SenseVoice int8），首次加载约数秒，之后进程内缓存
  async initAsr(modelDir) {
    const r = await this._call('init-asr', null, 120000, { modelDir });
    if (!r || !r.success) throw new Error('语音识别模块加载失败');
    return r;
  }

  // 识别 WAV（16k/16bit/mono ArrayBuffer），长音频解码可能数十秒
  async recognize(wavBuffer) {
    return await this._call('recognize', null, 120000, { wav: wavBuffer });
  }

  dispose() {
    this._terminateWorker('应用退出');
  }
}

module.exports = { VoiceRecorderHost };
