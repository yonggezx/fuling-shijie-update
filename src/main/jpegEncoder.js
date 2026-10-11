/**
 * 纯 JS Baseline JPEG 编码器（无外部依赖）
 * ------------------------------------------------------------
 * 用于桌面分身实时帧编码：比 PNG 快 3~5 倍、体积小 3~5 倍。
 * 输入 top-down RGBA Buffer，输出标准 JPEG Buffer。
 *
 * 算法：AAN 快速 DCT + 标准量化表（按 quality 缩放）+ 标准 Huffman 表（Annex K）。
 * 不做 4:2:0 降采样（编码速度优先，每个分量独立 8x8 块）。
 *
 * 用法：encodeJPEG(rgbaBuffer, width, height, quality) -> Buffer
 */
'use strict';

// ===== 标准量化表（JPEG Annex K，自然序）=====
const STD_LUM_Q = [
  16,11,10,16,24,40,51,61, 12,12,14,19,26,58,60,55,
  14,13,16,24,40,57,69,56, 14,17,22,29,51,87,80,62,
  18,22,37,56,68,109,103,77, 24,35,55,64,81,104,113,92,
  49,64,78,87,103,121,120,101, 72,92,95,98,112,100,103,99
];
const STD_CHROM_Q = [
  17,18,24,47,99,99,99,99, 18,21,26,66,99,99,99,99,
  24,26,56,99,99,99,99,99, 47,66,99,99,99,99,99,99,
  99,99,99,99,99,99,99,99, 99,99,99,99,99,99,99,99,
  99,99,99,99,99,99,99,99, 99,99,99,99,99,99,99,99
];

// Zigzag 扫描顺序
const ZIGZAG = [
   0, 1, 8,16, 9, 2, 3,10, 17,24,32,25,18,11, 4, 5,
  12,19,26,33,40,48,41,34, 27,20,13, 6, 7,14,21,28,
  35,42,49,56,57,50,43,36, 29,22,15,23,30,37,44,51,
  58,59,52,45,38,31,39,46, 53,60,61,54,47,55,62,63
];

// ===== 标准 Huffman 表（JPEG Annex K.3~K.6）=====
const DC_LUM_BITS = [0,1,5,1,1,1,1,1,1,0,0,0,0,0,0,0];
const DC_LUM_VALS = [0,1,2,3,4,5,6,7,8,9,10,11];
const DC_CHR_BITS = [0,3,1,1,1,1,1,1,1,1,1,0,0,0,0,0];
const DC_CHR_VALS = [0,1,2,3,4,5,6,7,8,9,10,11];
const AC_LUM_BITS = [0,2,1,3,3,2,4,3,5,5,4,4,0,0,1,0x7d];
const AC_LUM_VALS = [
  0x01,0x02,0x03,0x00,0x04,0x11,0x05,0x12,0x21,0x31,0x41,0x06,0x13,0x51,0x61,0x07,
  0x22,0x71,0x14,0x32,0x81,0x91,0xa1,0x08,0x23,0x42,0xb1,0xc1,0x15,0x52,0xd1,0xf0,
  0x24,0x33,0x62,0x72,0x82,0x09,0x0a,0x16,0x17,0x18,0x19,0x1a,0x25,0x26,0x27,0x28,
  0x29,0x2a,0x34,0x35,0x36,0x37,0x38,0x39,0x3a,0x43,0x44,0x45,0x46,0x47,0x48,0x49,
  0x4a,0x53,0x54,0x55,0x56,0x57,0x58,0x59,0x5a,0x63,0x64,0x65,0x66,0x67,0x68,0x69,
  0x6a,0x73,0x74,0x75,0x76,0x77,0x78,0x79,0x7a,0x83,0x84,0x85,0x86,0x87,0x88,0x89,
  0x8a,0x92,0x93,0x94,0x95,0x96,0x97,0x98,0x99,0x9a,0xa2,0xa3,0xa4,0xa5,0xa6,0xa7,
  0xa8,0xa9,0xaa,0xb2,0xb3,0xb4,0xb5,0xb6,0xb7,0xb8,0xb9,0xba,0xc2,0xc3,0xc4,0xc5,
  0xc6,0xc7,0xc8,0xc9,0xca,0xd2,0xd3,0xd4,0xd5,0xd6,0xd7,0xd8,0xd9,0xda,0xe1,0xe2,
  0xe3,0xe4,0xe5,0xe6,0xe7,0xe8,0xe9,0xea,0xf1,0xf2,0xf3,0xf4,0xf5,0xf6,0xf7,0xf8,0xf9,0xfa
];
const AC_CHR_BITS = [0,2,1,2,4,4,3,4,7,5,4,4,0,1,2,0x77];
const AC_CHR_VALS = [
  0x00,0x01,0x02,0x03,0x11,0x04,0x05,0x21,0x31,0x06,0x12,0x41,0x51,0x07,0x61,0x71,
  0x13,0x22,0x32,0x81,0x08,0x14,0x42,0x91,0xa1,0xb1,0xc1,0x09,0x23,0x33,0x52,0xf0,
  0x15,0x62,0x72,0xd1,0x0a,0x16,0x24,0x34,0xe1,0x25,0xf1,0x17,0x18,0x19,0x1a,0x26,
  0x27,0x28,0x29,0x2a,0x35,0x36,0x37,0x38,0x39,0x3a,0x43,0x44,0x45,0x46,0x47,0x48,
  0x49,0x4a,0x53,0x54,0x55,0x56,0x57,0x58,0x59,0x5a,0x63,0x64,0x65,0x66,0x67,0x68,
  0x69,0x6a,0x73,0x74,0x75,0x76,0x77,0x78,0x79,0x7a,0x82,0x83,0x84,0x85,0x86,0x87,
  0x88,0x89,0x8a,0x92,0x93,0x94,0x95,0x96,0x97,0x98,0x99,0x9a,0xa2,0xa3,0xa4,0xa5,
  0xa6,0xa7,0xa8,0xa9,0xaa,0xb2,0xb3,0xb4,0xb5,0xb6,0xb7,0xb8,0xb9,0xba,0xc2,0xc3,
  0xc4,0xc5,0xc6,0xc7,0xc8,0xc9,0xca,0xd2,0xd3,0xd4,0xd5,0xd6,0xd7,0xd8,0xd9,0xda,
  0xe2,0xe3,0xe4,0xe5,0xe6,0xe7,0xe8,0xe9,0xea,0xf2,0xf3,0xf4,0xf5,0xf6,0xf7,0xf8,0xf9,0xfa
];

function buildHuffmanTable(bits, vals) {
  const table = new Array(256);
  let code = 0, valIdx = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len - 1]; i++) {
      table[vals[valIdx]] = { code, length: len };
      code++; valIdx++;
    }
    code <<= 1;
  }
  return table;
}
const HUFF_DC_LUM = buildHuffmanTable(DC_LUM_BITS, DC_LUM_VALS);
const HUFF_DC_CHR = buildHuffmanTable(DC_CHR_BITS, DC_CHR_VALS);
const HUFF_AC_LUM = buildHuffmanTable(AC_LUM_BITS, AC_LUM_VALS);
const HUFF_AC_CHR = buildHuffmanTable(AC_CHR_BITS, AC_CHR_VALS);

function scaleQuantTable(std, quality) {
  const q = Math.max(1, Math.min(100, quality));
  const scale = q < 50 ? Math.floor(5000 / q) : 200 - q * 2;
  const out = new Float64Array(64);
  for (let i = 0; i < 64; i++) {
    out[i] = Math.max(1, Math.min(255, Math.floor((std[i] * scale + 50) / 100)));
  }
  return out;
}

// ===== AAN 快速 1D DCT（8 点，in-place float，输出缩放 8 倍）=====
function fdct1d(a) {
  const t0 = a[0] + a[7], t7 = a[0] - a[7];
  const t1 = a[1] + a[6], t6 = a[1] - a[6];
  const t2 = a[2] + a[5], t5 = a[2] - a[5];
  const t3 = a[3] + a[4], t4 = a[3] - a[4];
  const t10 = t0 + t3, t13 = t0 - t3;
  const t11 = t1 + t2, t12 = t1 - t2;
  a[0] = t10 + t11; a[4] = t10 - t11;
  const z1 = (t12 + t13) * 0.7071067811865476;
  a[2] = t13 + z1; a[6] = t13 - z1;
  const tt10 = t4 + t5, tt11 = t5 + t6, tt12 = t6 + t7;
  const z5 = (tt10 - tt12) * 0.3826834323650898;
  const z2 = 0.5411961001461970 * tt10 + z5;
  const z4 = 1.3065629648763766 * tt12 + z5;
  const z3 = tt11 * 0.7071067811865476;
  const z11 = t7 + z3, z13 = t7 - z3;
  a[5] = z13 + z2; a[3] = z13 - z2;
  a[1] = z11 + z4; a[7] = z11 - z4;
}

function fdct2d(block) {
  const row = _fdctRow;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) row[c] = block[r * 8 + c];
    fdct1d(row);
    for (let c = 0; c < 8; c++) block[r * 8 + c] = row[c];
  }
  for (let c = 0; c < 8; c++) {
    for (let r = 0; r < 8; r++) row[r] = block[r * 8 + c];
    fdct1d(row);
    for (let r = 0; r < 8; r++) block[r * 8 + c] = row[r];
  }
}
const _fdctRow = new Float64Array(8);

// ===== 位写入器（含 0xFF 字节填充）=====
class BitWriter {
  constructor() { this.bytes = []; this.cur = 0; this.pos = 0; }
  write(code, len) {
    for (let i = len - 1; i >= 0; i--) {
      this.cur = (this.cur << 1) | ((code >> i) & 1);
      if (++this.pos === 8) {
        if (this.cur === 0xFF) this.bytes.push(0xFF, 0x00);
        else this.bytes.push(this.cur);
        this.cur = 0; this.pos = 0;
      }
    }
  }
  flush() {
    if (this.pos > 0) {
      this.cur = (this.cur << (8 - this.pos)) | ((1 << (8 - this.pos)) - 1);
      if (this.cur === 0xFF) this.bytes.push(0xFF, 0x00);
      else this.bytes.push(this.cur);
      this.cur = 0; this.pos = 0;
    }
  }
  toBuffer() { return Buffer.from(this.bytes); }
}

// 复用数组（避免每块分配）
const _yBlock = new Float64Array(64);
const _cbBlock = new Float64Array(64);
const _crBlock = new Float64Array(64);
const _zz = new Int32Array(64);

function encodeBlock(block, quant, prevDC, huffDC, huffAC, bw) {
  fdct2d(block);
  for (let i = 0; i < 64; i++) {
    const v = block[ZIGZAG[i]];
    const q = 8 * quant[ZIGZAG[i]];
    _zz[i] = v >= 0 ? Math.floor(v / q + 0.5) : -Math.floor(-v / q + 0.5);
  }
  // DC 差值
  const diff = _zz[0] - prevDC;
  const abs = Math.abs(diff);
  let cat = 0;
  if (abs > 0) { cat = 1; let t = abs; while (t > 1) { t >>= 1; cat++; } }
  const dcH = huffDC[cat];
  bw.write(dcH.code, dcH.length);
  if (cat > 0) bw.write(diff > 0 ? abs : (abs ^ ((1 << cat) - 1)), cat);
  // AC 游程
  let run = 0;
  for (let k = 1; k < 64; k++) {
    const ac = _zz[k];
    if (ac === 0) { run++; continue; }
    while (run > 15) {
      const z = huffAC[0xF0]; bw.write(z.code, z.length); run -= 16;
    }
    const aAbs = Math.abs(ac);
    let sz = 1; let t = aAbs; while (t > 1) { t >>= 1; sz++; }
    const sym = (run << 4) | sz;
    const ah = huffAC[sym];
    bw.write(ah.code, ah.length);
    bw.write(ac > 0 ? aAbs : (aAbs ^ ((1 << sz) - 1)), sz);
    run = 0;
  }
  if (run > 0) { const e = huffAC[0x00]; bw.write(e.code, e.length); }
  return _zz[0];
}

function buildDHT(tcId, bits, vals) {
  const len = 2 + 1 + 16 + vals.length;
  const buf = Buffer.alloc(len + 2);
  buf[0] = 0xFF; buf[1] = 0xC4;
  buf.writeUInt16BE(len, 2);
  buf[4] = tcId;
  for (let i = 0; i < 16; i++) buf[5 + i] = bits[i];
  for (let i = 0; i < vals.length; i++) buf[21 + i] = vals[i];
  return buf;
}

/**
 * 编码一帧为 JPEG。
 * @param {Buffer} rgba - top-down RGBA
 * @param {number} width
 * @param {number} height
 * @param {number} quality - 1~100（默认 70，实时预览兼顾画质与速度）
 */
function encodeJPEG(rgba, width, height, quality = 70) {
  const lumQ = scaleQuantTable(STD_LUM_Q, quality);
  const chrQ = scaleQuantTable(STD_CHROM_Q, quality);
  const bw = new BitWriter();

  const mcuCols = Math.ceil(width / 8);
  const mcuRows = Math.ceil(height / 8);
  let prevY = 0, prevCb = 0, prevCr = 0;

  for (let by = 0; by < mcuRows; by++) {
    for (let bx = 0; bx < mcuCols; bx++) {
      // 收集 8x8 块并 RGB→YCbCr（边缘补 0）
      for (let r = 0; r < 8; r++) {
        const py = by * 8 + r;
        const rowValid = py < height;
        for (let c = 0; c < 8; c++) {
          const px = bx * 8 + c;
          const i = r * 8 + c;
          if (rowValid && px < width) {
            const idx = (py * width + px) * 4;
            const R = rgba[idx], G = rgba[idx + 1], B = rgba[idx + 2];
            _yBlock[i]  =  0.299 * R + 0.587 * G + 0.114 * B - 128;
            _cbBlock[i] = -0.168736 * R - 0.331264 * G + 0.5 * B;
            _crBlock[i] =  0.5 * R - 0.418688 * G - 0.081312 * B;
          } else {
            _yBlock[i] = -128; _cbBlock[i] = 128; _crBlock[i] = 128;
          }
        }
      }
      prevY  = encodeBlock(_yBlock,  lumQ, prevY,  HUFF_DC_LUM, HUFF_AC_LUM, bw);
      prevCb = encodeBlock(_cbBlock, chrQ, prevCb, HUFF_DC_CHR, HUFF_AC_CHR, bw);
      prevCr = encodeBlock(_crBlock, chrQ, prevCr, HUFF_DC_CHR, HUFF_AC_CHR, bw);
    }
  }
  bw.flush();
  const scanData = bw.toBuffer();

  // ===== 组装 JPEG =====
  const parts = [];
  parts.push(Buffer.from([0xFF, 0xD8])); // SOI
  // APP0 JFIF
  parts.push(Buffer.from([0xFF,0xE0,0x00,0x10,0x4A,0x46,0x49,0x46,0x00,0x01,0x01,0x00,0x00,0x01,0x00,0x01,0x00,0x00]));
  // DQT 亮度
  const dqtL = Buffer.alloc(67);
  dqtL[0]=0xFF; dqtL[1]=0xDB; dqtL.writeUInt16BE(67,2); dqtL[4]=0x00;
  for (let i=0;i<64;i++) dqtL[5+i]=lumQ[ZIGZAG[i]];
  parts.push(dqtL);
  // DQT 色度
  const dqtC = Buffer.alloc(67);
  dqtC[0]=0xFF; dqtC[1]=0xDB; dqtC.writeUInt16BE(67,2); dqtC[4]=0x01;
  for (let i=0;i<64;i++) dqtC[5+i]=chrQ[ZIGZAG[i]];
  parts.push(dqtC);
  // SOF0
  const sof = Buffer.alloc(17);
  sof[0]=0xFF; sof[1]=0xC0; sof.writeUInt16BE(17,2); sof[4]=8;
  sof.writeUInt16BE(height,5); sof.writeUInt16BE(width,7); sof[9]=3;
  sof[10]=1; sof[11]=0x11; sof[12]=0;
  sof[13]=2; sof[14]=0x11; sof[15]=1;
  sof[16]=3;
  parts.push(sof);
  // DHT x4
  parts.push(buildDHT(0x00, DC_LUM_BITS, DC_LUM_VALS));
  parts.push(buildDHT(0x10, AC_LUM_BITS, AC_LUM_VALS));
  parts.push(buildDHT(0x01, DC_CHR_BITS, DC_CHR_VALS));
  parts.push(buildDHT(0x11, AC_CHR_BITS, AC_CHR_VALS));
  // SOS
  const sos = Buffer.alloc(14);
  sos[0]=0xFF; sos[1]=0xDA; sos.writeUInt16BE(12,2); sos[4]=3;
  sos[5]=1; sos[6]=0x00;
  sos[7]=2; sos[8]=0x11;
  sos[9]=3; sos[10]=0x11;
  sos[11]=0; sos[12]=63; sos[13]=0;
  parts.push(sos);
  parts.push(scanData);
  parts.push(Buffer.from([0xFF, 0xD9])); // EOI
  return Buffer.concat(parts);
}

module.exports = { encodeJPEG };
