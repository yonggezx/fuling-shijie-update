/**
 * dib.js — 32bpp 可读写 DIB 位图分配器（共享）
 *
 * ★ 为什么必须有这个模块：
 *   本机（DWM 合成 + 硬件加速）上 `CreateCompatibleBitmap` 创建的 DDB（设备相关位图）
 *   接不到任何像素 —— BitBlt / PrintWindow / StretchBlt 一律「返回成功但结果全 0」。
 *   实测对照：
 *     CreateCompatibleBitmap + BitBlt  → 非黑 0.0%，色彩 1
 *     CreateDIBSection     + BitBlt  → 非黑 99.8%，色彩 14000+
 *   所以凡是「往内存 DC 画像素再读回」的路径，都必须用 DIB，不能用 DDB。
 *
 * 用法：
 *   const d = dib.create(w, h);
 *   ... 用 d.dc 作为目标 DC ...
 *   const rgba = dib.read(d);        // RGBA 自上而下，alpha 恒 0xFF
 *   dib.destroy(d);
 */

'use strict';

let koffi = null;
let lib = null;

function ensure() {
  if (lib) return lib;
  koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const gdi32 = koffi.load('gdi32.dll');
  lib = {
    GetDC: user32.func('void* __stdcall GetDC(void* hwnd)'),
    ReleaseDC: user32.func('int __stdcall ReleaseDC(void* hwnd, void* hdc)'),
    CreateCompatibleDC: gdi32.func('void* __stdcall CreateCompatibleDC(void* hdc)'),
    CreateDIBSection: gdi32.func('void* __stdcall CreateDIBSection(void* hdc, void* pbmi, uint usage, _Out_ void* ppvBits, void* hSection, uint dwOffset)'),
    SelectObject: gdi32.func('void* __stdcall SelectObject(void* hdc, void* obj)'),
    GetDIBits: gdi32.func('int __stdcall GetDIBits(void* hdc, void* hbmp, uint start, uint cLines, void* lpvBits, void* lpbmi, uint usage)'),
    DeleteObject: gdi32.func('int __stdcall DeleteObject(void* obj)'),
    DeleteDC: gdi32.func('int __stdcall DeleteDC(void* hdc)'),
    GetSystemMetrics: user32.func('int __stdcall GetSystemMetrics(int nIndex)')
  };
  return lib;
}

/** 40 字节 BITMAPINFOHEADER；topDown=true 时 biHeight 取负（自上而下，省一次翻转） */
function makeBmi(w, h, topDown) {
  const b = Buffer.alloc(40);
  b.writeUInt32LE(40, 0);
  b.writeInt32LE(w, 4);
  b.writeInt32LE(topDown ? -h : h, 8);
  b.writeUInt16LE(1, 12);
  b.writeUInt16LE(32, 14);
  b.writeUInt32LE(w * h * 4, 20);
  return b;
}

/**
 * 创建 32bpp DIB + 内存 DC，并把 DIB 选入 DC。
 * @returns {{dc:*, bmp:*, old:*, w:number, h:number, topDown:boolean}|null}
 */
function create(w, h, topDown) {
  const L = ensure();
  if (!(w > 0) || !(h > 0)) return null;
  const refDc = L.GetDC(null);
  const bitsBox = Buffer.alloc(16);
  const bmp = L.CreateDIBSection(refDc, makeBmi(w, h, topDown), 0, bitsBox, null, 0);
  if (refDc) L.ReleaseDC(null, refDc);
  if (!bmp || Number(bmp) === 0) return null;

  const dc = L.CreateCompatibleDC(null);
  if (!dc || Number(dc) === 0) { L.DeleteObject(bmp); return null; }

  const old = L.SelectObject(dc, bmp);
  return { dc, bmp, old, w, h, topDown: !!topDown };
}

function destroy(d) {
  if (!d) return;
  const L = ensure();
  try { L.SelectObject(d.dc, d.old); } catch (e) { /* ignore */ }
  try { L.DeleteObject(d.bmp); } catch (e) { /* ignore */ }
  try { L.DeleteDC(d.dc); } catch (e) { /* ignore */ }
}

/**
 * 读回像素。
 * @param topDown=true → 直接得到 RGBA 自上而下
 * @param topDown=false → BGRA 自下而上，需调用方翻转（或本函数内部翻转）
 * @returns {Buffer|null} RGBA，alpha 恒 0xFF
 */
function read(d) {
  if (!d) return null;
  const L = ensure();
  const buf = Buffer.alloc(d.w * d.h * 4);
  const lines = L.GetDIBits(d.dc, d.bmp, 0, d.h, buf, makeBmi(d.w, d.h, false), 0);
  if (lines <= 0) return null;
  // 统一成 RGBA 自上而下
  const out = Buffer.alloc(d.w * d.h * 4);
  const rowBytes = d.w * 4;
  for (let y = 0; y < d.h; y++) {
    const src = (d.h - 1 - y) * rowBytes;
    buf.copy(out, y * rowBytes, src, src + rowBytes);
  }
  for (let i = 3; i < out.length; i += 4) out[i] = 0xFF;
  return out;
}

/** 快速判断一块 RGBA 数据是否「有内容」（抽样，非全黑） */
function hasContent(rgba, maxSamples) {
  if (!rgba || !rgba.length) return false;
  const total = Math.floor(rgba.length / 4);
  const step = Math.max(1, Math.floor(total / (maxSamples || 4000)));
  let hits = 0;
  for (let i = 0; i < total; i += step) {
    if ((rgba[i * 4] | rgba[i * 4 + 1] | rgba[i * 4 + 2]) > 8) {
      if (++hits > 24) return true;
    }
  }
  return false;
}

module.exports = { create, destroy, read, hasContent, makeBmi, ensure };
