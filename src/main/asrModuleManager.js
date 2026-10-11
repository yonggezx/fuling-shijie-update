// ASR 模块管理器（主进程）
// 管理 Sherpa-ONNX + SenseVoiceSmall int8 语音识别模块的下载/解压/状态。
// 模块存放：<userData>/voice-module/models/<MODEL_DIR_NAME>/
//   - model.int8.onnx (~229MB)
//   - tokens.txt
// 下载源：sherpa-onnx 官方 GitHub Release（仅 int8 包，不含 895MB fp32 模型）。
// 下载用 Electron net（Chromium 网络栈），解压用系统自带 tar.exe（Win10+ 的
// bsdtar 原生支持 bz2），全程异步，不阻塞主线程。

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MODEL_DIR_NAME = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17';
const MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL_DIR_NAME}.tar.bz2`;
const MODEL_FILES = ['model.int8.onnx', 'tokens.txt'];
const APPROX_SIZE_MB = 230; // 展示用（压缩包约 230MB）

// 多源下载（按速度排序，依次尝试；成功端点记住优先复用）：
//   1/2. GitHub Release 加速代理（实测 ghfast 230MB/133s ≈ 1.7MB/s，直连仅 60KB/s）
//   3. hf-mirror.com（HuggingFace 国内镜像，散文件 model.int8.onnx + tokens.txt）
//   4. GitHub 直连兜底
// 15 秒无进度视为端点失效自动切换。
// 注：ModelScope 上的 ZhaoChaoqun/sherpa-onnx-asr-models 仓库已无 2024-07-17 int8
// tar 包（404），不再列入。
const DOWNLOAD_ENDPOINTS = [
  { name: 'ghfast(加速)', type: 'tarball', url: 'https://ghfast.top/' + MODEL_URL },
  { name: 'gh-proxy(加速)', type: 'tarball', url: 'https://gh-proxy.com/' + MODEL_URL },
  { name: 'hf-mirror(HF镜像)', type: 'hf', files: [
    { url: 'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx', dest: 'model.int8.onnx' },
    { url: 'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt', dest: 'tokens.txt' }
  ] },
  { name: 'GitHub直连', type: 'tarball', url: MODEL_URL }
];
const STALL_TIMEOUT_MS = 15 * 1000;

class AsrModuleManager extends EventEmitter {
  constructor({ userDataDir }) {
    super();
    this.baseDir = path.join(userDataDir, 'voice-module');
    this.modelsDir = path.join(this.baseDir, 'models');
    this.modelDir = path.join(this.modelsDir, MODEL_DIR_NAME);
    this.modelPath = path.join(this.modelDir, 'model.int8.onnx');
    this.tokensPath = path.join(this.modelDir, 'tokens.txt');
    this.archivePath = path.join(this.baseDir, `${MODEL_DIR_NAME}.tar.bz2`);

    this.phase = 'idle'; // idle | downloading | extracting | error
    this.progress = { received: 0, total: 0, percent: 0 };
    this._abortCtrl = null;
    this._downloadPromise = null;
    this._lastEmit = 0;
    this._preferredEndpoint = null; // 上次成功的镜像端点
  }

  isInstalled() {
    try {
      return MODEL_FILES.every(f => {
        const st = fs.statSync(path.join(this.modelDir, f));
        return st.isFile() && st.size > 1000;
      });
    } catch (_) {
      return false;
    }
  }

  getStatus() {
    let sizeMB = 0;
    try {
      sizeMB = Math.round(fs.statSync(this.modelPath).size / 1024 / 1024);
    } catch (_) {}
    return {
      installed: this.isInstalled(),
      downloading: this.phase === 'downloading' || this.phase === 'extracting',
      phase: this.phase,
      progress: { ...this.progress },
      modelDir: this.modelDir,
      sizeMB,
      approxDownloadMB: APPROX_SIZE_MB,
      url: MODEL_URL
    };
  }

  _emitProgress(force) {
    const now = Date.now();
    if (!force && now - this._lastEmit < 300) return; // 节流 300ms
    this._lastEmit = now;
    this.emit('progress', this.getStatus());
  }

  async download() {
    if (this.phase === 'downloading' || this.phase === 'extracting') {
      return { success: false, error: '下载正在进行中' };
    }
    if (this.isInstalled()) {
      return { success: true, already: true };
    }
    if (this._downloadPromise) return this._downloadPromise;
    this._downloadPromise = this._doDownload().finally(() => { this._downloadPromise = null; });
    return this._downloadPromise;
  }

  async _doDownload() {
    fs.mkdirSync(this.baseDir, { recursive: true });
    this.phase = 'downloading';
    this.progress = { received: 0, total: 0, percent: 0 };
    this._emitProgress(true);

    const partPath = this.archivePath + '.part';
    // 候选端点：上次成功的优先，其余按列表顺序
    const candidates = [];
    if (this._preferredEndpoint) candidates.push(this._preferredEndpoint);
    for (const ep of DOWNLOAD_ENDPOINTS) {
      if (!candidates.includes(ep)) candidates.push(ep);
    }

    try {
      let lastErr = null;
      for (const ep of candidates) {
        try {
          if (ep.type === 'hf') {
            await this._downloadHfFiles(ep, partPath);
          } else {
            await this._downloadTo(ep.url, partPath);
            // 解压（系统 tar 支持 bz2）
            this.phase = 'extracting';
            this._emitProgress(true);
            fs.mkdirSync(this.modelsDir, { recursive: true });
            await this._extract(partPath, this.modelsDir);
          }
          // 校验产物
          if (!this.isInstalled()) {
            throw new Error('下载后未找到模型文件（model.int8.onnx / tokens.txt）');
          }
          this._preferredEndpoint = ep;
          try { fs.unlinkSync(partPath); } catch (_) {}
          this.phase = 'idle';
          this.progress.percent = 100;
          this._emitProgress(true);
          console.log('[AsrModule] 模块下载成功，来源:', ep.name);
          return { success: true, source: ep.name };
        } catch (e) {
          if (e.name === 'AbortError') throw e; // 用户取消，不再换源
          lastErr = e;
          console.warn(`[AsrModule] 下载源失败(${ep.name}): ${e.message}，切换下一个`);
          this.phase = 'downloading';
          this.progress = { received: 0, total: 0, percent: 0 };
          this._emitProgress(true);
        }
      }
      throw lastErr || new Error('所有下载源均失败');
    } catch (e) {
      this.phase = e.name === 'AbortError' ? 'idle' : 'error';
      this._emitProgress(true);
      try { fs.unlinkSync(partPath); } catch (_) {}
      try { fs.rmSync(this.modelDir, { recursive: true, force: true }); } catch (_) {} // hf 散文件半成品清理
      const msg = e.name === 'AbortError' ? '已取消' : (e.message || '下载失败');
      if (e.name !== 'AbortError') console.error('[AsrModule] 下载失败:', msg);
      return { success: false, cancelled: e.name === 'AbortError', error: msg };
    } finally {
      this._abortCtrl = null;
    }
  }

  // hf 散文件模式：直接把 model.int8.onnx / tokens.txt 下到 modelDir（无需解压）
  async _downloadHfFiles(ep, unusedPartPath) {
    fs.mkdirSync(this.modelDir, { recursive: true });
    const totalPlanned = ep.files.length;
    let doneCount = 0;
    for (const f of ep.files) {
      const dest = path.join(this.modelDir, f.dest);
      const tmp = dest + '.part';
      await this._downloadTo(f.url, tmp);
      fs.renameSync(tmp, dest);
      doneCount++;
      this.progress = {
        received: this.progress.received,
        total: 0,
        percent: Math.round(doneCount / totalPlanned * 100)
      };
      this._emitProgress(true);
    }
  }

  // 通用单文件流式下载（带 15s 无进度卡死检测）
  async _downloadTo(url, destPath) {
    const { net } = require('electron');
    this._abortCtrl = new AbortController();
    const resp = await net.fetch(url, {
      redirect: 'follow',
      signal: this._abortCtrl.signal,
      headers: { 'User-Agent': 'fuling-shijie-voice-module' }
    });
    if (!resp.ok) throw new Error(`下载源返回 ${resp.status}`);

    const total = Number(resp.headers.get('content-length') || 0);
    if (total > 0) this.progress.total = total;

    const out = fs.createWriteStream(destPath);
    const reader = resp.body.getReader();
    let lastDataAt = Date.now();
    let stalled = false;
    const stallTimer = setInterval(() => {
      if (Date.now() - lastDataAt > STALL_TIMEOUT_MS) {
        stalled = true;
        try { this._abortCtrl.abort(); } catch (_) {}
      }
    }, 1000);

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        lastDataAt = Date.now();
        out.write(Buffer.from(value));
        this.progress.received += value.byteLength;
        if (this.progress.total > 0) {
          this.progress.percent = Math.min(99, Math.round(this.progress.received / this.progress.total * 100));
        }
        this._emitProgress(false);
      }
      await new Promise((resolve, reject) => {
        out.end(resolve);
        out.on('error', reject);
      });
      if (stalled) throw new Error('下载卡死（15 秒无进度）');
      if (this.progress.total > 0 && this.progress.received < this.progress.total * 0.95) {
        throw new Error('下载不完整，请重试');
      }
    } finally {
      clearInterval(stallTimer);
      try { out.close(); } catch (_) {}
    }
  }

  _extract(archivePath, destDir) {
    return new Promise((resolve, reject) => {
      // Win10+ 自带 bsdtar（C:\Windows\System32\tar.exe），原生支持 -j (bzip2)
      const tarExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
      const child = spawn(tarExe, ['-xjf', archivePath, '-C', destDir], { windowsHide: true });
      let stderr = '';
      child.stderr.on('data', d => { stderr += d; });
      const timer = setTimeout(() => {
        try { child.kill(); } catch (_) {}
        reject(new Error('解压超时'));
      }, 10 * 60 * 1000);
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error('解压失败 (tar exit ' + code + '): ' + stderr.slice(0, 200)));
      });
    });
  }

  cancelDownload() {
    if (this._abortCtrl) {
      try { this._abortCtrl.abort(); } catch (_) {}
      return { success: true };
    }
    return { success: false, error: '没有进行中的下载' };
  }

  deleteModule() {
    if (this.phase === 'downloading' || this.phase === 'extracting') {
      return { success: false, error: '下载进行中，无法删除' };
    }
    try {
      fs.rmSync(this.modelDir, { recursive: true, force: true });
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
}

module.exports = { AsrModuleManager, MODEL_DIR_NAME, MODEL_URL };
