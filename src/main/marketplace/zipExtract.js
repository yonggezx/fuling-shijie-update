/**
 * 轻量 ZIP 解压（仅用 Node 内置 zlib，不引入第三方依赖）。
 * ============================================================
 * 覆盖场景：商城下载的技能包 / 导入包是标准 ZIP（deflate 或 stored）。
 * 实现：定位 EOCD → 中央目录 → 逐条读本地头 → 解压。
 *
 * 安全边界：
 *   · 拒绝路径穿越（../ 或绝对路径）—— 解压目标永远限定在目标目录内
 *   · 限制单文件解压后大小（防 zip bomb）
 *   · 限制总解压大小
 */
'use strict';
const zlib = require('zlib');
const path = require('path');

const MAX_FILE = 64 * 1024 * 1024;   // 单文件 64MB
const MAX_TOTAL = 256 * 1024 * 1024; // 总 256MB

/** 读取 buffer 的小端 uint16/uint32 */
function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

/**
 * 解压 zip 内容到目标目录。
 * @param {Buffer} buf   zip 的完整字节
 * @param {string} dest  目标目录（绝对路径）
 * @returns {Promise<{files:string[], totalBytes:number}>}
 */
async function extractZip(buf, dest) {
  const fs = require('fs');
  const { promisify } = require('util');
  const mkdir = promisify(fs.mkdir);

  if (buf.length < 22) throw new Error('不是有效的 ZIP（文件过小）');
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error('不是有效的 ZIP（缺少本地文件头）');

  // 找 EOCD：从末尾往前扫签名 PK\x05\x06
  let eocd = -1;
  const tail = Math.min(buf.length, 22 + 65535 + 18);
  for (let i = buf.length - 22; i >= buf.length - tail && i >= 0; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP（找不到中央目录结尾）');

  const cdCount = u16(buf, eocd + 10);
  const cdOffset = u32(buf, eocd + 16);

  let offset = cdOffset;
  const files = [];
  let totalBytes = 0;

  // 第一遍：收集所有文件条目（含各自数据区起点），不立即落盘
  const entries = [];
  for (let n = 0; n < cdCount; n++) {
    if (offset + 46 > buf.length) throw new Error('ZIP 中央目录越界');
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP 中央目录签名错误');
    const method = u16(buf, offset + 10);
    const compSize = u32(buf, offset + 20);
    const uncompSize = u32(buf, offset + 24);
    const nameLen = u16(buf, offset + 28);
    const extraLen = u16(buf, offset + 30);
    const commentLen = u16(buf, offset + 32);
    const localOffset = u32(buf, offset + 42);
    const name = buf.slice(offset + 46, offset + 46 + nameLen).toString('utf8');

    offset += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // 目录项，跳过
    if (localOffset + 30 > buf.length) throw new Error('ZIP 本地头越界');
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('ZIP 本地头签名错误');
    const lnameLen = u16(buf, localOffset + 26);
    const lextraLen = u16(buf, localOffset + 28);
    const dataStart = localOffset + 30 + lnameLen + lextraLen;
    entries.push({ name, method, compSize, uncompSize, dataStart });
  }

  // 计算公共顶层目录：仅当所有文件条目的第一段相同才剥掉（兼容 GitHub codeload 的 <repo>-<branch>/ 包裹）
  const firsts = entries.map(e => e.name.replace(/\\/g, '/').split('/')[0]);
  const commonTop = firsts.length && firsts.every(f => f === firsts[0])
    ? firsts[0] : null;

  for (const ent of entries) {
    const { name, method, compSize, uncompSize, dataStart } = ent;
    // 路径穿越防护 + 规整（若存在公共顶层目录则剥掉它）
    const clean = normalizePath(name, dest, commonTop);
    if (!clean) throw new Error('ZIP 条目含非法路径: ' + name);

    if (uncompSize > MAX_FILE) throw new Error('ZIP 单文件过大: ' + name + ' (' + uncompSize + ')');

    const raw = buf.slice(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error('不支持的压缩方式(' + method + ')：' + name);

    if (data.length !== uncompSize) throw new Error('ZIP 解压长度不一致: ' + name);
    totalBytes += data.length;
    if (totalBytes > MAX_TOTAL) throw new Error('ZIP 解压总量超限');

    await mkdir(path.dirname(clean), { recursive: true });
    fs.writeFileSync(clean, data);
    files.push(clean);
  }

  return { files, totalBytes };
}

/** 把 zip 条目名规整为 dest 内的安全绝对路径；非法返回 null */
function normalizePath(entryName, dest, commonTop) {
  let name = entryName.replace(/\\/g, '/');
  let parts = name.split('/').filter(Boolean);
  // 若存在公共顶层目录，剥掉它（GitHub codeload 包裹层）
  if (commonTop && parts.length && parts[0] === commonTop) parts = parts.slice(1);
  const p = path.resolve(dest, parts.join('/'));
  // 必须仍在 dest 内
  if (p !== dest && !p.startsWith(dest + path.sep)) return null;
  return p;
}

module.exports = { extractZip, normalizePath };
