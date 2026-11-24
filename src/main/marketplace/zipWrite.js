/**
 * 轻量 ZIP 打包（只用 Node 内置 zlib，不引入第三方依赖）。
 * 用于把下载的智能体/技能连同关联资源打成一个真实压缩包落盘，
 * 让「下载」有明确的包体积和文件数量，而不是只写一份 JSON 空壳。
 */
'use strict';
const zlib = require('zlib');
const { promisify } = require('util');
const deflateRaw = promisify(zlib.deflateRaw);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosTime(d) {
  const date = d || new Date();
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)) & 0xFFFF;
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xFFFF;
  return { time, day };
}

/**
 * @param {Array<{name:string, data:Buffer|string}>} entries
 * @param {{onProgress?:function}} [opts]
 * @returns {Promise<Buffer>}
 */
async function buildZip(entries, opts = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const { time, day } = dosTime();
  let done = 0;

  for (const ent of entries) {
    const name = String(ent.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!name) continue;
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(ent.data) ? ent.data : Buffer.from(String(ent.data == null ? '' : ent.data), 'utf8');
    const deflated = await deflateRaw(data, { level: 6 });
    const store = deflated.length >= data.length;
    const method = store ? 0 : 8;
    const payload = store ? data : deflated;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034B50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);       // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014B50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
    done++;
    if (opts.onProgress) {
      try { opts.onProgress({ done, total: entries.length, name }); } catch (e) { /* 忽略 */ }
    }
  }

  const centralBuf = Buffer.concat(centrals);
  const count = centrals.length / 2; // 每项由「中央目录头 + 文件名」两个 Buffer 组成
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054B50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

module.exports = { buildZip, crc32 };
