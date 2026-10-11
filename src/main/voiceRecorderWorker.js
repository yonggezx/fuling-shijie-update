// 语音录制 worker 线程（worker_threads）
// 把 MCI 音频采集 + WAV 重采样整段搬出主进程：MCI 设备 open/record/save 是
// 慢同步调用（winmm koffi），WAV 16k 转换又是纯 JS 重循环，原先直接跑在
// Electron 主线程上，点一次语音按钮全应用冻结几百 ms～数秒（用户反馈
// 「点击语音识别会异常卡顿」）。worker 里跑多慢都不影响 UI。
// 协议：main → { id, cmd: 'available'|'start'|'stop', options? }
//       worker → { id, ok, result?, error? }

const { parentPort } = require('worker_threads');
const koffi = require('koffi');
const fs = require('fs');
const path = require('path');
const os = require('os');

let winmm = null;
let mciSendString = null;
try {
  winmm = koffi.load('winmm.dll');
  mciSendString = winmm.func('uint32_t mciSendStringA(const char *lpszCommand, char *lpszReturnString, uint32_t cchReturn, void *hwndCallback)');
} catch (e) {
  console.error('[VoiceWorker] winmm.dll 加载失败:', e.message);
}

function mciExec(command) {
  if (!mciSendString) throw new Error('mciSendString 不可用');
  const retBuf = Buffer.alloc(256);
  const ret = mciSendString(command, retBuf, 256, null);
  const retStr = retBuf.toString().trim();
  if (ret !== 0) {
    console.warn(`[VoiceWorker] 命令失败 (${ret}): ${command} -> ${retStr}`);
  }
  return { code: ret, text: retStr };
}

// 8/16bit 任意采样率 WAV → 16bit/16000Hz/单声道（类型化数组版，避免逐样本 push）
function convertWavTo16k16bit(inputBuffer) {
  try {
    const inputSampleRate = inputBuffer.readUInt32LE(24);
    const inputBitsPerSample = inputBuffer.readUInt16LE(34);
    const inputChannels = inputBuffer.readUInt16LE(22);

    let dataOffset = -1;
    let dataSize = 0;
    let offset = 12;
    while (offset < inputBuffer.length - 8) {
      const chunkId = inputBuffer.toString('ascii', offset, offset + 4);
      const chunkSize = inputBuffer.readUInt32LE(offset + 4);
      if (chunkId === 'data') {
        dataOffset = offset + 8;
        dataSize = chunkSize;
        break;
      }
      offset += 8 + chunkSize;
    }
    if (dataOffset < 0 || dataSize === 0) return inputBuffer;

    const pcmData = inputBuffer.slice(dataOffset, dataOffset + dataSize);

    // 一步到位：解出单声道 Int16Array
    let mono;
    if (inputBitsPerSample === 8) {
      const n = Math.floor(pcmData.length / inputChannels);
      mono = new Int16Array(n);
      for (let i = 0; i < n; i++) {
        mono[i] = (pcmData[i * inputChannels] - 128) * 256;
      }
    } else if (inputBitsPerSample === 16) {
      const frames = Math.floor(pcmData.length / 2 / inputChannels);
      mono = new Int16Array(frames);
      for (let i = 0; i < frames; i++) {
        mono[i] = pcmData.readInt16LE(i * 2 * inputChannels);
      }
    } else {
      return inputBuffer;
    }

    const TARGET = 16000;
    let resampled;
    if (inputSampleRate !== TARGET) {
      const ratio = inputSampleRate / TARGET;
      const targetLength = Math.floor(mono.length / ratio);
      resampled = new Int16Array(targetLength);
      for (let i = 0; i < targetLength; i++) {
        const srcIndex = i * ratio;
        const i0 = Math.floor(srcIndex);
        const i1 = Math.min(i0 + 1, mono.length - 1);
        const frac = srcIndex - i0;
        let s = Math.round(mono[i0] * (1 - frac) + mono[i1] * frac);
        resampled[i] = s < -32768 ? -32768 : (s > 32767 ? 32767 : s);
      }
    } else {
      resampled = mono;
    }

    const dataSize16 = resampled.length * 2;
    const out = Buffer.alloc(44 + dataSize16);
    out.write('RIFF', 0);
    out.writeUInt32LE(36 + dataSize16, 4);
    out.write('WAVE', 8);
    out.write('fmt ', 12);
    out.writeUInt32LE(16, 16);
    out.writeUInt16LE(1, 20);
    out.writeUInt16LE(1, 22);
    out.writeUInt32LE(TARGET, 24);
    out.writeUInt32LE(TARGET * 2, 28);
    out.writeUInt16LE(2, 32);
    out.writeUInt16LE(16, 34);
    out.write('data', 36);
    out.writeUInt32LE(dataSize16, 40);
    // Int16Array 直接整块拷进 Buffer（替代逐样本 writeInt16LE）
    Buffer.from(resampled.buffer, 0, dataSize16).copy(out, 44);

    return out;
  } catch (e) {
    console.error('[VoiceWorker] 格式转换失败:', e.message);
    return inputBuffer;
  }
}

const state = {
  recording: false,
  alias: null,
  tempWavPath: null
};

// ---- Sherpa-ONNX 离线识别（SenseVoice int8）----
// 模型加载与解码都是秒级 CPU 密集操作，必须留在 worker 线程里。
let asr = null; // { recognizer, modelDir }

function cmdInitAsr({ modelDir }) {
  if (asr && asr.modelDir === modelDir) return { success: true, cached: true };
  const sherpa = require('sherpa-onnx-node');
  const recognizer = new sherpa.OfflineRecognizer({
    modelConfig: {
      provider: 'cpu',
      debug: 0,
      numThreads: 2,
      tokens: path.join(modelDir, 'tokens.txt'),
      senseVoice: {
        model: path.join(modelDir, 'model.int8.onnx'),
        language: '', // 空 = 自动检测 zh/en/ja/ko/yue
        useInverseTextNormalization: 1
      }
    }
  });
  asr = { recognizer, modelDir };
  console.log('[VoiceWorker] ASR 模块已加载:', modelDir);
  return { success: true };
}

// 解析 WAV（16bit PCM）→ data 块 → Int16 → Float32 [-1,1]
function wavToFloat32(wavBuffer) {
  const buf = Buffer.isBuffer(wavBuffer) ? wavBuffer : Buffer.from(wavBuffer);
  let dataOffset = -1;
  let dataSize = 0;
  let offset = 12;
  while (offset < buf.length - 8) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === 'data') {
      dataOffset = offset + 8;
      dataSize = chunkSize;
      break;
    }
    offset += 8 + chunkSize;
  }
  if (dataOffset < 0) {
    // 没找到 data 块，按标准 44 字节头兜底
    dataOffset = 44;
    dataSize = buf.length - 44;
  }
  const sampleRate = buf.readUInt32LE(24);
  const n = Math.floor(dataSize / 2);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    samples[i] = buf.readInt16LE(dataOffset + i * 2) / 32768;
  }
  return { sampleRate, samples };
}

function cmdRecognize({ wav }) {
  if (!asr) return { success: false, error: 'ASR 模块未初始化' };
  const { sampleRate, samples } = wavToFloat32(wav);
  if (!samples.length || samples.length < sampleRate / 10) {
    return { success: false, error: '音频太短' };
  }
  const stream = asr.recognizer.createStream();
  stream.acceptWaveform({ sampleRate, samples });
  asr.recognizer.decode(stream);
  const result = asr.recognizer.getResult(stream);
  const text = ((result && result.text) || '').trim();
  return { success: true, text };
}

function cmdAvailable() {
  if (!mciSendString) return false;
  try {
    const testAlias = 'test_' + Date.now();
    const ret = mciExec(`open new Type waveaudio Alias ${testAlias}`);
    if (ret.code === 0) {
      mciExec(`close ${testAlias}`);
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

function cmdStart(options = {}) {
  if (state.recording) return { success: false, error: '已在录制中' };
  if (!mciSendString) return { success: false, error: 'mciSendString 不可用' };

  const sampleRate = options.sampleRate || 16000;
  const channels = options.channels || 1;
  const bitsPerSample = options.bitsPerSample || 16;
  const alias = 'lobster_rec_' + Date.now();

  try {
    const openRet = mciExec(`open new Type waveaudio Alias ${alias}`);
    if (openRet.code !== 0) throw new Error(`无法打开音频设备，错误码: ${openRet.code}`);

    let formatSet = true;
    if (mciExec(`set ${alias} bitspersample ${bitsPerSample}`).code !== 0) formatSet = false;
    if (mciExec(`set ${alias} samplespersec ${sampleRate}`).code !== 0) formatSet = false;
    if (mciExec(`set ${alias} channels ${channels}`).code !== 0) formatSet = false;
    if (!formatSet) console.warn('[VoiceWorker] 部分音频格式设置失败，录制后将自动转换');

    // 设置格式后需要关闭再重开才能录制（否则错误码 328）
    mciExec(`close ${alias}`);
    const reopenRet = mciExec(`open new Type waveaudio Alias ${alias}`);
    if (reopenRet.code !== 0) throw new Error(`无法重新打开音频设备，错误码: ${reopenRet.code}`);

    const recordRet = mciExec(`record ${alias}`);
    if (recordRet.code !== 0) {
      mciExec(`close ${alias}`);
      throw new Error(`无法开始录制，错误码: ${recordRet.code}`);
    }

    state.recording = true;
    state.alias = alias;
    return { success: true };
  } catch (e) {
    // 失败兜底清理
    try { mciExec(`close ${alias}`); } catch (_) {}
    state.recording = false;
    state.alias = null;
    throw e;
  }
}

function cmdStop() {
  if (!state.recording || !state.alias) {
    return { success: false, error: '未在录制中' };
  }
  const alias = state.alias;
  state.recording = false;
  state.alias = null;

  let tempWavPath = null;
  try {
    mciExec(`stop ${alias}`);
    tempWavPath = path.join(os.tmpdir(), `lobster_voice_${Date.now()}.wav`);
    const saveRet = mciExec(`save ${alias} "${tempWavPath}"`);
    if (saveRet.code !== 0) throw new Error(`无法保存音频，错误码: ${saveRet.code}`);
    mciExec(`close ${alias}`);

    if (!fs.existsSync(tempWavPath)) throw new Error('WAV 文件未生成');
    let wavBuffer = fs.readFileSync(tempWavPath);
    wavBuffer = convertWavTo16k16bit(wavBuffer);

    if (wavBuffer.length < 100) {
      return { success: false, error: '未采集到音频数据' };
    }
    // 返回底层 ArrayBuffer（structured clone 到主进程，代价很小）
    return { success: true, wav: wavBuffer.buffer.slice(wavBuffer.byteOffset, wavBuffer.byteOffset + wavBuffer.byteLength) };
  } catch (e) {
    try { mciExec(`close ${alias}`); } catch (_) {}
    throw e;
  } finally {
    if (tempWavPath) { try { fs.unlinkSync(tempWavPath); } catch (_) {} }
  }
}

parentPort.on('message', (msg) => {
  const { id, cmd, options } = msg || {};
  if (typeof id !== 'number') return;
  let payload;
  try {
    if (cmd === 'available') payload = cmdAvailable();
    else if (cmd === 'start') payload = cmdStart(options);
    else if (cmd === 'stop') payload = cmdStop();
    else if (cmd === 'init-asr') payload = cmdInitAsr(options);
    else if (cmd === 'recognize') payload = cmdRecognize(options);
    else throw new Error('未知命令: ' + cmd);
    parentPort.postMessage({ id, ok: true, result: payload });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: e.message });
  }
});

console.log('[VoiceWorker] 语音录制 worker 已就绪');
