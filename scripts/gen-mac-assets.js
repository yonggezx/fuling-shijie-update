/**
 * 生成 macOS 发行素材（构建期一次性产物，产物已提交仓库）：
 *   assets/dmg/background.png     620x400（dmg 窗口背景，分辨率即窗口尺寸）
 *   assets/icons/icon-1024.png    1024x1024
 *   assets/icons/icon.icns        多尺寸 icns
 *
 * 用法：npx electron scripts/gen-mac-assets.js
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ICON_DIR = path.join(ROOT, 'assets', 'icons');
const DMG_DIR = path.join(ROOT, 'assets', 'dmg');

function pngFromDataUrl(dataUrl) {
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

// 由 1024 主图降采样出 icns 需要的各档尺寸
function rendererScript(logoDataUrl, logoSrcSize) {
  const draw = `
    const LOGO = new Image();
    LOGO.src = ${JSON.stringify(logoDataUrl)};

    function foxMask(r, g, b, alphaScale) {
      // logo.png 是黑线稿 + 白底，按明暗提取线条透明度，再染成目标颜色
      const w = LOGO.naturalWidth;
      const h = LOGO.naturalHeight;
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const x = c.getContext('2d');
      x.drawImage(LOGO, 0, 0);
      const data = x.getImageData(0, 0, w, h);
      const px = data.data;
      for (let i = 0; i < px.length; i += 4) {
        const srcAlpha = px[i + 3] / 255;
        const dark = 255 - Math.max(px[i], px[i + 1], px[i + 2]);
        px[i] = r;
        px[i + 1] = g;
        px[i + 2] = b;
        px[i + 3] = Math.round(dark * srcAlpha * alphaScale);
      }
      x.putImageData(data, 0, 0);
      return c;
    }

    function roundedRect(x, left, top, w, h, r) {
      x.beginPath();
      x.moveTo(left + r, top);
      x.arcTo(left + w, top, left + w, top + h, r);
      x.arcTo(left + w, top + h, left, top + h, r);
      x.arcTo(left, top + h, left, top, r);
      x.arcTo(left, top, left + w, top, r);
      x.closePath();
    }

    function drawIcon(size) {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const x = c.getContext('2d');

      const pad = size * 0.08;
      const s = size - pad * 2;
      const g = x.createLinearGradient(pad, pad, pad + s, pad + s);
      g.addColorStop(0, '#FFD9E4');
      g.addColorStop(0.45, '#FB9DBA');
      g.addColorStop(1, '#EF6E97');
      x.save();
      roundedRect(x, pad, pad, s, s, s * 0.225);
      x.fillStyle = g;
      x.fill();
      x.restore();

      // 顶部高光
      const hl = x.createLinearGradient(0, pad, 0, pad + s * 0.55);
      hl.addColorStop(0, 'rgba(255,255,255,0.55)');
      hl.addColorStop(1, 'rgba(255,255,255,0)');
      x.save();
      roundedRect(x, pad, pad, s, s, s * 0.225);
      x.clip();
      x.fillStyle = hl;
      x.fillRect(pad, pad, s, s * 0.55);
      x.restore();

      // 白色狐狸线稿（小尺寸加粗，避免 128px 下笔画消失）
      const fox = foxMask(255, 255, 255, 1);
      const foxSize = s * 0.78;
      const fx = (size - foxSize) / 2;
      const fy = (size - foxSize) / 2 + s * 0.01;
      const passes =
        size <= 256
          ? [[0, 0], [-1.2, 0], [1.2, 0], [0, -1.2], [0, 1.2]]
          : [[0, 0]];
      x.globalAlpha = 0.97;
      for (const [dx, dy] of passes) {
        x.drawImage(fox, fx + dx, fy + dy, foxSize, foxSize);
      }
      x.globalAlpha = 1;
      return c;
    }

    function drawBackground(w, h) {
      const scale = w / 620;
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const x = c.getContext('2d');

      const base = x.createLinearGradient(0, 0, w, h);
      base.addColorStop(0, '#FFFBFC');
      base.addColorStop(0.55, '#FFF3F7');
      base.addColorStop(1, '#FFE6EE');
      x.fillStyle = base;
      x.fillRect(0, 0, w, h);

      // 左右两团品牌光晕，与图标落位对齐
      const glow = (cx, cy, r, alpha) => {
        const rg = x.createRadialGradient(cx, cy, 0, cx, cy, r);
        rg.addColorStop(0, 'rgba(250,150,180,' + alpha + ')');
        rg.addColorStop(1, 'rgba(250,150,180,0)');
        x.fillStyle = rg;
        x.beginPath();
        x.arc(cx, cy, r, 0, Math.PI * 2);
        x.fill();
      };
      glow(160 * scale, 200 * scale, 132 * scale, 0.30);
      glow(460 * scale, 200 * scale, 132 * scale, 0.22);

      // 顶部标题
      x.textAlign = 'center';
      x.fillStyle = '#2B1E24';
      x.font = '600 ' + Math.round(27 * scale) + 'px "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
      x.fillText('浮灵饰界', w / 2, 62 * scale);
      x.fillStyle = 'rgba(74,55,63,0.62)';
      x.font = '400 ' + Math.round(12.5 * scale) + 'px "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
      x.fillText('将应用拖入 Applications 文件夹完成安装', w / 2, 86 * scale);

      // 两个落位提示圈
      const ring = (cx, cy) => {
        x.beginPath();
        x.arc(cx * scale, cy * scale, 66 * scale, 0, Math.PI * 2);
        x.setLineDash([5 * scale, 6 * scale]);
        x.lineWidth = 1.4 * scale;
        x.strokeStyle = 'rgba(239,110,151,0.42)';
        x.stroke();
        x.setLineDash([]);
      };
      ring(160, 200);
      ring(460, 200);

      // 中间箭头
      const y = 200 * scale;
      const grad = x.createLinearGradient(246 * scale, 0, 372 * scale, 0);
      grad.addColorStop(0, 'rgba(239,110,151,0.30)');
      grad.addColorStop(1, 'rgba(239,110,151,0.95)');
      x.strokeStyle = grad;
      x.lineWidth = 3 * scale;
      x.lineCap = 'round';
      x.beginPath();
      x.moveTo(248 * scale, y);
      x.lineTo(352 * scale, y);
      x.stroke();
      x.beginPath();
      x.moveTo(338 * scale, y - 15 * scale);
      x.lineTo(362 * scale, y);
      x.lineTo(338 * scale, y + 15 * scale);
      x.lineWidth = 3 * scale;
      x.strokeStyle = '#EF6E97';
      x.stroke();

      // 左上角品牌水印
      const mark = foxMask(239, 110, 151, 0.10);
      x.drawImage(mark, 26 * scale, 26 * scale, 64 * scale, 64 * scale);

      // 底部提示
      x.textAlign = 'center';
      x.fillStyle = 'rgba(74,55,63,0.40)';
      x.font = '400 ' + Math.round(11 * scale) + 'px "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
      x.fillText('安装完成后可从「应用程序」或启动台打开', w / 2, h - 22 * scale);

      return c;
    }

    function iconData(size) {
      return drawIcon(size).toDataURL('image/png');
    }

    function scaledIcon(size) {
      return drawIcon(size).toDataURL('image/png');
    }

    window.__gen = async () => {
      await LOGO.decode();
      return {
        bg2x: drawBackground(1240, 800).toDataURL('image/png'),
        bg1x: drawBackground(620, 400).toDataURL('image/png'),
        icon1024: iconData(1024),
        icon512: scaledIcon(512),
        icon256: scaledIcon(256),
        icon128: scaledIcon(128)
      };
    };
    true;
  `;
  return draw;
}

function buildIcns(entries) {
  // entries: [{type:'ic09', buf:Buffer}]
  const parts = [];
  let total = 8;
  for (const e of entries) {
    const len = 8 + e.buf.length;
    total += len;
    const head = Buffer.alloc(8);
    head.write(e.type, 0, 4, 'ascii');
    head.writeUInt32BE(len, 4);
    parts.push(head, e.buf);
  }
  const head = Buffer.alloc(8);
  head.write('icns', 0, 4, 'ascii');
  head.writeUInt32BE(total, 4);
  return Buffer.concat([head, ...parts]);
}

app.disableHardwareAcceleration();
app.setPath('userData', path.join(require('os').tmpdir(), 'fuling-gen-mac-assets'));
app.whenReady().then(async () => {
  const logoPath = path.join(ICON_DIR, 'logo.png');
  const logoDataUrl =
    'data:image/png;base64,' + fs.readFileSync(logoPath).toString('base64');

  const win = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    webPreferences: { offscreen: true, contextIsolation: false, nodeIntegration: false }
  });
  await win.loadURL('about:blank');
  await win.webContents.executeJavaScript(rendererScript(logoDataUrl));

  // 通过 JSON 字符串回传，避免结构化克隆对 canvas 派生对象报错
  const res = JSON.parse(
    await win.webContents.executeJavaScript('window.__gen().then((r) => JSON.stringify(r))')
  );

  fs.mkdirSync(DMG_DIR, { recursive: true });
  fs.writeFileSync(path.join(DMG_DIR, 'background@2x.png'), pngFromDataUrl(res.bg2x));
  fs.writeFileSync(path.join(DMG_DIR, 'background.png'), pngFromDataUrl(res.bg1x));
  fs.writeFileSync(path.join(ICON_DIR, 'icon-1024.png'), pngFromDataUrl(res.icon1024));

  const icns = buildIcns([
    { type: 'ic07', buf: pngFromDataUrl(res.icon128) },
    { type: 'ic08', buf: pngFromDataUrl(res.icon256) },
    { type: 'ic09', buf: pngFromDataUrl(res.icon512) },
    { type: 'ic10', buf: pngFromDataUrl(res.icon1024) }
  ]);
  fs.writeFileSync(path.join(ICON_DIR, 'icon.icns'), icns);

  console.log('[gen-mac-assets] done');
  app.quit();
});

app.on('window-all-closed', () => app.quit());

