// 内嵌完整包信息（兜底：主进程版本过滤导致 fullInstall 为空时使用）
const EMBEDDED_FULL_INSTALL = {"version":"1.0.7","url":"https://github.com/yonggezx/fuling-shijie-update/releases/download/v1.0.7/AiLobster-Setup-v1.0.7.exe","size":0,"checksum":"","changes":"","releaseDate":"","isFullPackage":true};

// ==================== 全局错误处理（防止白屏） ====================
window.addEventListener('error', (e) => {
  console.error('[Global Error]', e.message, e.filename, e.lineno, e.colno);
  // 阻止错误导致页面崩溃
  e.preventDefault();
  return true;
}, true);

window.addEventListener('unhandledrejection', (e) => {
  console.error('[Unhandled Rejection]', e.reason);
  // 阻止Promise未捕获异常导致页面崩溃
  e.preventDefault();
  return true;
});

// 安全调用函数：包裹try-catch防止白屏
function safeCall(fn, fallback = null) {
  try {
    return fn();
  } catch (e) {
    console.error('[SafeCall Error]', e);
    return fallback;
  }
}

// ==================== 轻量级 Markdown 渲染器 ====================
// 支持表格、代码块、行内代码、粗体、斜体、列表、标题、链接、换行
// 代码块操作全局函数
function toggleCodeBlock(btn) {
  const block = btn.closest('.md-code-block');
  const pre = block.querySelector('.md-pre');
  const isHidden = pre.style.display === 'none';
  pre.style.display = isHidden ? '' : 'none';
  const svg = btn.querySelector('svg');
  if (svg) svg.style.transform = isHidden ? 'rotate(0deg)' : 'rotate(-90deg)';
}

function copyCodeBlock(btn) {
  const code = btn.closest('.md-code-block').querySelector('code').innerText;
  navigator.clipboard.writeText(code).then(() => {
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1500);
  });
}

function editCodeBlock(btn) {
  const block = btn.closest('.md-code-block');
  const code = block.querySelector('code').innerText;
  const lang = block.querySelector('.md-code-lang').textContent;
  const w = window.open('', '_blank', 'width=800,height=600');
  w.document.write('<title>编辑代码 - ' + lang + '</title><textarea style="width:100%;height:100%;background:#1e1e2e;color:#cdd6f4;font-family:Consolas,monospace;font-size:13px;padding:20px;border:none;outline:none;resize:none;">' + code.replace(/</g, '&lt;') + '</textarea>');
  w.document.close();
}

function runCodeBlock(btn) {
  const block = btn.closest('.md-code-block');
  const code = block.querySelector('code').innerText;
  const lang = block.querySelector('.md-code-lang').textContent;
  if (lang === 'javascript' || lang === 'js') {
    try {
      eval(code);
    } catch (e) {
      window.AppDialog.alert({ type: 'error', title: '运行错误', message: e.message });
    }
  } else if (lang === 'html') {
    showHtmlPreview(code, 'HTML 预览');
  } else {
    window.AppDialog.alert({ type: 'warning', title: '暂不支持', message: '暂不支持运行 ' + lang + ' 代码' });
  }
}

// 自定义弹窗（替代系统 alert）
function showCustomModal(title, content, type) {
  const oldModal = document.getElementById('custom-modal-overlay');
  if (oldModal) oldModal.remove();

  const overlay = document.createElement('div');
  overlay.id = 'custom-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:var(--glass-overlay-bg);backdrop-filter:blur(var(--glass-overlay-blur)) saturate(130%);-webkit-backdrop-filter:blur(var(--glass-overlay-blur)) saturate(130%);z-index:99999;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity 0.25s';

  const modal = document.createElement('div');
  modal.style.cssText = 'background:var(--glass-panel-bg);backdrop-filter:blur(var(--glass-panel-blur)) saturate(160%);-webkit-backdrop-filter:blur(var(--glass-panel-blur)) saturate(160%);border:1px solid var(--glass-panel-border);color:var(--glass-text);border-radius:14px;min-width:380px;max-width:560px;width:90%;max-height:75vh;overflow:hidden;box-shadow:var(--glass-panel-shadow);transform:scale(0.92) translateY(10px);transition:transform 0.25s cubic-bezier(0.34,1.56,0.64,1);';

  const iconColor = type === 'error' ? '#f38ba8' : type === 'success' ? '#a6e3a1' : '#89b4fa';
  const iconBg = type === 'error' ? 'rgba(243,139,168,0.12)' : type === 'success' ? 'rgba(166,227,161,0.12)' : 'rgba(137,180,250,0.12)';
  const iconSvg = type === 'error' ? '<svg width=18 height=18 viewBox=0 0 24 24 fill=none stroke=currentColor stroke-width=2.2><path d=M18 6L6 18M6 6l12 12/></svg>' : type === 'success' ? '<svg width=18 height=18 viewBox=0 0 24 24 fill=none stroke=currentColor stroke-width=2.2><path d=M20 6L9 17l-5-5/></svg>' : '<svg width=18 height=18 viewBox=0 0 24 24 fill=none stroke=currentColor stroke-width=2.2><circle cx=12 cy=12 r=10/><path d=M12 16v-4M12 8h.01/></svg>';

  modal.innerHTML = '<div style=display:flex;align-items:center;gap:12px;padding:18px 22px;border-bottom:1px solid var(--glass-head-border,rgba(255,255,255,0.10));>'
    + '<div style=width:32px;height:32px;border-radius:8px;background:' + iconBg + ';display:flex;align-items:center;justify-content:center;color:' + iconColor + ';>' + iconSvg + '</div>'
    + '<span style=font-size:15px;font-weight:600;color:var(--text-primary,#cdd6f4);flex:1;>' + title + '</span>'
    + '<button class=modal-close style=background:transparent;border:none;color:var(--text-muted,rgba(255,255,255,0.35));cursor:pointer;padding:6px;border-radius:6px;>'
    + '<svg width=16 height=16 viewBox=0 0 24 24 fill=none stroke=currentColor stroke-width=2><path d=M18 6L6 18M6 6l12 12/></svg></button>'
    + '</div>'
    + '<div style=padding:20px 22px;max-height:45vh;overflow:auto;font-size:13px;line-height:1.7;color:var(--text-secondary,#bac2de);font-family:Consolas,monospace;white-space:pre-wrap;word-break:break-all;background:var(--bg-tertiary,rgba(0,0,0,0.15));>' + content + '</div>'
    + '<div style=padding:14px 22px;border-top:1px solid var(--glass-head-border,rgba(255,255,255,0.10));display:flex;justify-content:flex-end;>'
    + '<button class=modal-ok style=background:linear-gradient(135deg,#89b4fa,#74c7ec);color:#1e1e2e;border:none;padding:9px 24px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;>确定</button>'
    + '</div>';

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  function closeModal() {
    overlay.style.opacity = '0';
    modal.style.transform = 'scale(0.92) translateY(10px)';
    setTimeout(function() { overlay.remove(); }, 250);
  }

  const closeBtn = overlay.querySelector('.modal-close');
  const okBtn = overlay.querySelector('.modal-ok');
  closeBtn.addEventListener('click', closeModal);
  okBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', function(e) { if (e.target === overlay) closeModal(); });
  document.addEventListener('keydown', function escHandler(e) {
    if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', escHandler); }
  });

  requestAnimationFrame(function() {
    overlay.style.opacity = '1';
    modal.style.transform = 'scale(1) translateY(0)';
  });
}

// HTML 预览弹窗（运行 HTML 时使用）
function showHtmlPreview(htmlCode, title) {
  const oldPreview = document.getElementById('html-preview-overlay');
  if (oldPreview) oldPreview.remove();

  const overlay = document.createElement('div');
  overlay.id = 'html-preview-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:var(--glass-overlay-bg);backdrop-filter:blur(var(--glass-overlay-blur)) saturate(130%);-webkit-backdrop-filter:blur(var(--glass-overlay-blur)) saturate(130%);z-index:99998;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity 0.25s;';

  const preview = document.createElement('div');
  preview.className = 'html-preview-modal';
  preview.style.cssText = 'background:var(--glass-panel-bg);backdrop-filter:blur(var(--glass-panel-blur)) saturate(160%);-webkit-backdrop-filter:blur(var(--glass-panel-blur)) saturate(160%);border:1px solid var(--glass-panel-border);color:var(--glass-text);border-radius:14px;width:90%;max-width:1000px;height:85vh;overflow:hidden;box-shadow:var(--glass-panel-shadow);display:flex;flex-direction:column;transform:scale(0.9) translateY(20px);transition:transform 0.3s cubic-bezier(0.34,1.56,0.64,1);';

  // 标题栏
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;padding:12px 18px;background:var(--bg-tertiary,#313244);border-bottom:1px solid var(--glass-head-border,rgba(255,255,255,0.10));gap:10px;flex-shrink:0;';
  header.innerHTML = '<div style="display:flex;gap:6px;margin-right:8px;">'
    + '<span style="width:12px;height:12px;border-radius:50%;background:#f38ba8;display:inline-block;"></span>'
    + '<span style="width:12px;height:12px;border-radius:50%;background:#f9e2af;display:inline-block;"></span>'
    + '<span style="width:12px;height:12px;border-radius:50%;background:#a6e3a1;display:inline-block;"></span>'
    + '</div>'
    + '<span style="font-size:13px;color:var(--text-muted,rgba(255,255,255,0.6));font-weight:500;flex:1;text-align:center;margin-right:60px;">' + (title || 'HTML 预览') + '</span>'
    + '<button class="pv-refresh" style="background:transparent;border:none;color:var(--text-muted,rgba(255,255,255,0.5));cursor:pointer;padding:6px;border-radius:6px;display:inline-flex;transition:all 0.15s;" title="刷新">'
    + '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>'
    + '<button class="pv-browser" style="background:transparent;border:none;color:var(--text-muted,rgba(255,255,255,0.5));cursor:pointer;padding:6px;border-radius:6px;display:inline-flex;transition:all 0.15s;" title="在浏览器打开">'
    + '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></button>'
    + '<button class="pv-close" style="background:transparent;border:none;color:var(--text-muted,rgba(255,255,255,0.5));cursor:pointer;padding:6px;border-radius:6px;display:inline-flex;transition:all 0.15s;" title="关闭">'
    + '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button>';

  // iframe 容器
  const frameContainer = document.createElement('div');
  frameContainer.style.cssText = 'flex:1;overflow:hidden;background:#fff;position:relative;';
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'width:100%;height:100%;border:none;background:#fff;';
  // 注入自定义滚动条样式到 iframe
  iframe.srcdoc = '<style>::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:rgba(0,0,0,.2);border-radius:4px}::-webkit-scrollbar-thumb:hover{background:rgba(0,0,0,.35)}::-webkit-scrollbar-corner{background:transparent}*{scrollbar-width:thin;scrollbar-color:rgba(0,0,0,.2) transparent}</style>' + htmlCode;
  frameContainer.appendChild(iframe);

  preview.appendChild(header);
  preview.appendChild(frameContainer);
  overlay.appendChild(preview);
  document.body.appendChild(overlay);

  function closePreview() {
    overlay.style.opacity = '0';
    preview.style.transform = 'scale(0.9) translateY(20px)';
    setTimeout(function() { overlay.remove(); }, 250);
    document.removeEventListener('keydown', escHandler);
  }

  function escHandler(e) {
    if (e.key === 'Escape') closePreview();
  }
  document.addEventListener('keydown', escHandler);

  // 按钮事件
  const closeBtn = header.querySelector('.pv-close');
  const refreshBtn = header.querySelector('.pv-refresh');
  const browserBtn = header.querySelector('.pv-browser');

  closeBtn.addEventListener('click', closePreview);
  refreshBtn.addEventListener('click', function() {
    iframe.srcdoc = htmlCode;
  });
  browserBtn.addEventListener('click', function() {
    if (window.api && window.api.openHtml) {
      window.api.openHtml(htmlCode);
    }
  });


  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) closePreview();
  });

  requestAnimationFrame(function() {
    overlay.style.opacity = '1';
    preview.style.transform = 'scale(1) translateY(0)';
  });
}

function fullscreenCodeBlock(btn) {
  const block = btn.closest('.md-code-block');
  let code = block.querySelector('code').innerText;
  const lang = block.querySelector('.md-code-lang') ? block.querySelector('.md-code-lang').textContent : 'code';
  const codeLines = code.split('\n');
  const lineNumbers = codeLines.map(function(_, i) { return i + 1; }).join('\n');
  const escapedCode = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // 根据语言决定是否显示运行和在浏览器中打开按钮
  const isHtml = lang === 'html';
  const isRunnable = lang === 'html' || lang === 'javascript' || lang === 'js';
  const runBtnHtml = isRunnable ? '<button class="cv-btn cv-run" style="background:transparent;border:none;color:var(--text-muted,rgba(255,255,255,0.5));padding:6px;border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;font-size:12px;font-family:inherit;transition:all 0.15s;">'
    + '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="fill:none;"><polygon points="5 3 19 12 5 21 5 3"/></svg></button>' : '';
  const openBtnHtml = isHtml ? '<button class="cv-btn cv-open" style="background:transparent;border:none;color:var(--text-muted,rgba(255,255,255,0.5));padding:6px;border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;font-size:12px;font-family:inherit;transition:all 0.15s;">'
    + '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="fill:none;"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></button>' : '';

  // 找到聊天容器
  const chatContainer = document.querySelector('.chat-container') || document.getElementById('chat-messages').parentElement;
  if (!chatContainer) {
    window.AppDialog.alert({ type: 'error', title: '出错了', message: '找不到聊天容器' });
    return;
  }

  // 确保容器有 position: relative
  const computedPos = getComputedStyle(chatContainer).position;
  if (computedPos === 'static') chatContainer.style.position = 'relative';

  // 移除已有的弹窗
  const oldOverlay = chatContainer.querySelector('.cv-overlay');
  const oldDrawer = chatContainer.querySelector('.cv-drawer');
  if (oldOverlay) oldOverlay.remove();
  if (oldDrawer) oldDrawer.remove();

  // 创建遮罩层（限制在聊天容器内）
  const overlay = document.createElement('div');
  overlay.className = 'cv-overlay';
  overlay.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:100;opacity:0;transition:opacity 0.3s;border-radius:inherit;';
  chatContainer.appendChild(overlay);

  // 创建侧边抽屉（限制在聊天容器内）
  const drawer = document.createElement('div');
  drawer.className = 'cv-drawer';
  drawer.style.cssText = 'position:absolute;top:0;right:0;bottom:0;width:65%;max-width:700px;min-width:300px;background:var(--bg-secondary,#1e1e2e);z-index:101;transform:translateX(100%);transition:transform 0.3s ease;display:flex;flex-direction:column;box-shadow:-4px 0 20px rgba(0,0,0,0.4);border-left:1px solid rgba(255,255,255,0.06);';

  drawer.innerHTML = '<div class="cv-header" style="display:flex;align-items:center;padding:12px 16px;background:var(--bg-tertiary,#313244);border-bottom:1px solid var(--bg-hover,rgba(255,255,255,0.06));gap:8px;">'
    + '<span class="cv-lang" style="font-size:13px;color:var(--text-muted,rgba(255,255,255,0.5));font-weight:500;flex:1;font-family:Consolas,Monaco,Courier New,monospace;">' + lang + '</span>'
    + '<button class="cv-btn cv-edit" style="background:transparent;border:none;color:var(--text-muted,rgba(255,255,255,0.5));padding:6px 8px;border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;font-size:12px;font-family:inherit;transition:all 0.15s;">'
    + '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="fill:none;"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg><span>编辑代码</span></button>'
    + '<button class="cv-btn cv-save-edit" style="background:transparent;border:none;color:var(--accent,#ee5a24);padding:6px 8px;border-radius:6px;cursor:pointer;display:none;align-items:center;gap:6px;font-size:12px;font-family:inherit;transition:all 0.15s;">'
    + '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="fill:none;"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg><span>保存</span></button>'
    + '<button class="cv-btn cv-cancel-edit" style="background:transparent;border:none;color:var(--text-muted,rgba(255,255,255,0.5));padding:6px 8px;border-radius:6px;cursor:pointer;display:none;align-items:center;gap:6px;font-size:12px;font-family:inherit;transition:all 0.15s;">'
    + '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="fill:none;"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg><span>取消</span></button>'
    + '<button class="cv-btn cv-save-file" style="background:transparent;border:none;color:var(--text-muted,rgba(255,255,255,0.5));padding:6px 8px;border-radius:6px;cursor:pointer;display:none;align-items:center;gap:6px;font-size:12px;font-family:inherit;transition:all 0.15s;">'
    + '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="fill:none;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span>存文件</span></button>'
    + runBtnHtml
    + '<button class="cv-btn cv-copy" style="background:transparent;border:none;color:var(--text-muted,rgba(255,255,255,0.5));padding:6px;border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;font-size:12px;font-family:inherit;transition:all 0.15s;">'
    + '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="fill:none;"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>'
    + openBtnHtml
    + '<button class="cv-btn cv-close" style="background:transparent;border:none;color:var(--text-muted,rgba(255,255,255,0.5));padding:6px;border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;font-size:12px;font-family:inherit;transition:all 0.15s;">'
    + '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="fill:none;"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>'
    + '</div>'
    + '<div class="cv-code-container" style="flex:1;overflow:auto;display:flex;">'
    + '<div class="cv-line-numbers" id="cv-line-numbers" style="padding:16px 10px 16px 16px;text-align:right;color:var(--text-muted,rgba(255,255,255,0.2));font-size:12px;line-height:1.7;user-select:none;border-right:1px solid var(--bg-hover,rgba(255,255,255,0.06));min-width:45px;font-family:Consolas,Monaco,Courier New,monospace;">' + lineNumbers + '</div>'
    + '<div class="cv-code-content" id="cv-code-content" contenteditable="false" style="padding:16px;font-size:12px;line-height:1.7;white-space:pre;flex:1;color:var(--text-primary,#cdd6f4);font-family:Consolas,Monaco,Courier New,monospace;">' + escapedCode + '</div>'
    + '</div>'
    + '<div class="cv-footer" style="padding:8px 16px;background:var(--bg-tertiary,#313244);border-top:1px solid var(--bg-hover,rgba(255,255,255,0.06));font-size:11px;color:var(--text-muted,rgba(255,255,255,0.3));display:flex;justify-content:space-between;font-family:Consolas,Monaco,Courier New,monospace;">'
    + '<span>' + codeLines.length + ' 行</span>'
    + '<span>ESC 关闭 | 点击遮罩关闭</span>'
    + '</div>';

  chatContainer.appendChild(drawer);

  // 关闭函数
  function closeViewer() {
    drawer.style.transform = 'translateX(100%)';
    overlay.style.opacity = '0';
    setTimeout(function() {
      overlay.remove();
      drawer.remove();
    }, 300);
    document.removeEventListener('keydown', escHandler);
  }

  // ESC 关闭
  function escHandler(e) {
    if (e.key === 'Escape') closeViewer();
  }
  document.addEventListener('keydown', escHandler);

  // 事件绑定
  overlay.addEventListener('click', closeViewer);
  drawer.querySelector('.cv-close').addEventListener('click', closeViewer);
  drawer.querySelector('.cv-copy').addEventListener('click', function() {
    const copyBtn = this;
    navigator.clipboard.writeText(code).then(function() {
      copyBtn.classList.add('copied');
      setTimeout(function() {
        copyBtn.classList.remove('copied');
      }, 1500);
    });
  });

  // 编辑代码功能（按钮预定义在HTML中，通过显示/隐藏切换）
  const codeContainer = drawer.querySelector('.cv-code-container');
  const lineNumbersEl = drawer.querySelector('.cv-line-numbers');
  const codeContentEl = drawer.querySelector('.cv-code-content');
  const editBtn = drawer.querySelector('.cv-edit');
  const saveBtn = drawer.querySelector('.cv-save-edit');
  const cancelBtn = drawer.querySelector('.cv-cancel-edit');
  const saveFileBtn = drawer.querySelector('.cv-save-file');
  
  // 确保代码区域不可编辑
  if (codeContentEl) {
    codeContentEl.setAttribute('contenteditable', 'false');
    codeContentEl.contentEditable = 'false';
  }
  
  let originalCode = code;
  let editTextarea = null;
  
  function updateDisplay() {
    const codeLines = code.split('\n');
    if (lineNumbersEl) lineNumbersEl.textContent = codeLines.map(function(_, idx) { return idx + 1; }).join('\n');
    if (codeContentEl) {
      codeContentEl.textContent = code;
      codeContentEl.setAttribute('contenteditable', 'false');
      codeContentEl.contentEditable = 'false';
    }
    const footerSpans = drawer.querySelectorAll('.cv-footer span');
    if (footerSpans.length > 0) footerSpans[0].textContent = codeLines.length + ' 行';
  }
  
  function enterEditMode() {
    originalCode = code;
    
    // 切换按钮显示
    if (editBtn) editBtn.style.display = 'none';
    if (saveBtn) saveBtn.style.display = 'inline-flex';
    if (cancelBtn) cancelBtn.style.display = 'inline-flex';
    if (saveFileBtn) saveFileBtn.style.display = 'inline-flex';
    
    // 隐藏行号和代码
    if (lineNumbersEl) lineNumbersEl.style.display = 'none';
    if (codeContentEl) codeContentEl.style.display = 'none';
    
    // 创建 textarea
    editTextarea = document.createElement('textarea');
    editTextarea.value = code;
    editTextarea.spellcheck = false;
    editTextarea.style.cssText = 'flex:1;padding:16px;font-size:12px;line-height:1.7;background:transparent;color:var(--text-primary,#cdd6f4);font-family:Consolas,Monaco,Courier New,monospace;border:none;outline:none;resize:none;white-space:pre;tab-size:4;';
    editTextarea.addEventListener('keydown', function(e) {
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = this.selectionStart;
        const end = this.selectionEnd;
        this.value = this.value.substring(0, start) + '  ' + this.value.substring(end);
        this.selectionStart = this.selectionEnd = start + 2;
      }
    });
    codeContainer.appendChild(editTextarea);
    editTextarea.focus();
    editTextarea.setSelectionRange(editTextarea.value.length, editTextarea.value.length);
  }
  
  function exitEditMode(doSave) {
    if (doSave && editTextarea) {
      code = editTextarea.value;
    } else {
      code = originalCode;
    }
    
    // 移除 textarea
    if (editTextarea && editTextarea.parentNode) {
      editTextarea.parentNode.removeChild(editTextarea);
    }
    editTextarea = null;
    
    // 显示行号和代码
    if (lineNumbersEl) lineNumbersEl.style.display = 'block';
    if (codeContentEl) {
      codeContentEl.style.display = 'block';
      codeContentEl.setAttribute('contenteditable', 'false');
      codeContentEl.contentEditable = 'false';
    }
    
    // 切换按钮显示
    if (editBtn) editBtn.style.display = 'inline-flex';
    if (saveBtn) saveBtn.style.display = 'none';
    if (cancelBtn) cancelBtn.style.display = 'none';
    if (saveFileBtn) saveFileBtn.style.display = 'none';
    
    updateDisplay();
  }
  
  // 绑定事件
  if (editBtn) editBtn.addEventListener('click', enterEditMode);
  if (saveBtn) saveBtn.addEventListener('click', function() { exitEditMode(true); });
  if (cancelBtn) cancelBtn.addEventListener('click', function() { exitEditMode(false); });
  if (saveFileBtn) {
    saveFileBtn.addEventListener('click', async function() {
      try {
        if (editTextarea) {
          code = editTextarea.value;
        }
        if (window.api && window.api.saveCodeFile) {
          const result = await window.api.saveCodeFile(code, lang);
          if (result && result.success) {
            showCustomModal('保存成功', '文件已保存到: ' + result.path, 'success');
          } else if (result && result.error === '用户取消') {
            // 用户取消保存，不显示错误
          } else {
            showCustomModal('保存失败', result && result.error ? result.error : '未知错误', 'error');
          }
        } else {
          const blob = new Blob([code], {type: 'text/plain'});
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'code.' + (lang || 'txt');
          a.click();
          URL.revokeObjectURL(url);
        }
      } catch (e) {
        showCustomModal('保存失败', e.message, 'error');
      }
    });
  }
  
  // 运行代码按钮
  const runBtn = drawer.querySelector('.cv-run');
  if (runBtn) runBtn.addEventListener('click', function() {
    if (lang === 'javascript' || lang === 'js') {
      // 捕获 console 输出
      const logs = [];
      const originalLog = console.log;
      const originalError = console.error;
      const originalWarn = console.warn;
      console.log = function() { logs.push(Array.from(arguments).map(String).join(' ')); };
      console.error = function() { logs.push('[ERROR] ' + Array.from(arguments).map(String).join(' ')); };
      console.warn = function() { logs.push('[WARN] ' + Array.from(arguments).map(String).join(' ')); };
      try {
        const result = eval(code);
        if (result !== undefined) logs.push('返回值: ' + String(result));
      } catch (e) {
        logs.push('[错误] ' + e.message);
      }
      // 恢复 console
      console.log = originalLog;
      console.error = originalError;
      console.warn = originalWarn;
      // 显示结果
      if (logs.length > 0) {
        showCustomModal('运行结果', logs.join('\\n'), 'success');
      } else {
        showCustomModal('运行结果', '代码运行成功，无输出', 'success');
      }
    } else if (lang === 'html') {
      showHtmlPreview(code, 'HTML 预览');
    } else {
      showCustomModal('不支持运行', '暂不支持运行 ' + lang + ' 代码\\n目前支持: javascript, html', 'info');
    }
  });

  // 在浏览器打开按钮
  const openBtn = drawer.querySelector('.cv-open');
  if (openBtn) openBtn.addEventListener('click', function() {
    if (lang === 'html') {
      if (window.api && window.api.openHtml) {
        window.api.openHtml(code);
      } else {
        const w = window.open('', '_blank');
        w.document.write(code);
        w.document.close();
      }
    } else {
      showCustomModal('在浏览器打开', '此功能仅支持 HTML 代码\\n当前语言: ' + lang, 'info');
    }
  });


  // 触发动画
  requestAnimationFrame(function() {
    overlay.style.opacity = '1';
    drawer.style.transform = 'translateX(0)';
  });
}

function renderMarkdown(text) {
  if (!text) return '';
  
  // 1. HTML转义（防止XSS）
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
  
  // 2. 提取代码块（逐行解析，支持 1-4 个及以上反引号，兼容各种不标准格式）
  const codeBlocks = [];
  (function() {
    const srcLines = html.split(/\r?\n/);
    const outLines = [];
    let inBlock = false;
    let blockLang = '';
    let blockContent = [];
    let startBackticks = 0;
    for (let li = 0; li < srcLines.length; li++) {
      const line = srcLines[li];
      if (!inBlock) {
        // 检测代码块开始：行首 1-4 个反引号 + 可选空格 + 语言标识
        const m = line.match(/^\s{0,3}(`{1,4})[ 	]*([a-zA-Z0-9_+-]*)[ 	]*$/);
        if (m && (m[1].length >= 2 || (m[1].length === 1 && m[2]))) {
          inBlock = true;
          blockLang = m[2];
          startBackticks = m[1].length;
          blockContent = [];
          continue;
        }
        outLines.push(line);
      } else {
        // 检测代码块结束：行首相同或更多反引号
        const em = line.match(/^\s{0,3}(`{1,4})[ 	]*$/);
        if (em && em[1].length >= startBackticks) {
          const idx = codeBlocks.length;
          codeBlocks.push((blockLang ? blockLang + '\n' : '') + blockContent.join('\n'));
          outLines.push('\u0000CODEBLOCK' + idx + '\u0000');
          inBlock = false;
          blockLang = '';
          blockContent = [];
          continue;
        }
        blockContent.push(line);
      }
    }
    // 如果代码块没有结束标记，也作为代码块处理
    if (inBlock && blockContent.length > 0) {
      const idx = codeBlocks.length;
      codeBlocks.push((blockLang ? blockLang + '\n' : '') + blockContent.join('\n'));
      outLines.push('\u0000CODEBLOCK' + idx + '\u0000');
    }
    html = outLines.join('\n');
  })();
  
  // 3. 表格渲染（| 分隔的表格）
  const lines = html.split('\n');
  let result = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 检测表格行：包含 | 且不是代码块占位
    if (line.includes('|') && !line.includes('\u0000CODEBLOCK')) {
      // 检查下一行是否是分隔行（|---|---|）
      if (i + 1 < lines.length && /^\s*\|?[\s\-:|]+\|?\s*$/.test(lines[i + 1])) {
        // 开始表格
        const tableRows = [];
        // 表头
        const headerCells = line.split('|').map(c => c.trim()).filter((c, idx, arr) => {
          // 过滤首尾空单元格
          if (idx === 0 && c === '') return false;
          if (idx === arr.length - 1 && c === '') return false;
          return true;
        });
        tableRows.push({ cells: headerCells, isHeader: true });
        i += 2; // 跳过表头和分隔行
        // 数据行
        while (i < lines.length && lines[i].includes('|') && !lines[i].includes('\u0000CODEBLOCK') && lines[i].trim() !== '') {
          const dataCells = lines[i].split('|').map(c => c.trim()).filter((c, idx, arr) => {
            if (idx === 0 && c === '') return false;
            if (idx === arr.length - 1 && c === '') return false;
            return true;
          });
          tableRows.push({ cells: dataCells, isHeader: false });
          i++;
        }
        // 生成表格HTML
        let tableHtml = '<div class="md-table-wrapper"><table class="md-table">';
        tableRows.forEach((row, rowIdx) => {
          const tag = row.isHeader ? 'th' : 'td';
          tableHtml += '<tr>';
          row.cells.forEach(cell => {
            // 单元格内也渲染行内Markdown
            const cellContent = renderInlineMarkdown(cell);
            tableHtml += `<${tag}>${cellContent}</${tag}>`;
          });
          tableHtml += '</tr>';
        });
        tableHtml += '</table></div>';
        result.push(tableHtml);
        continue;
      }
    }
    result.push(line);
    i++;
  }
  html = result.join('\n');
  
  // 4. 标题渲染（# 开头）
  html = html.replace(/^######\s+(.+)$/gm, '<h6 class="md-h6">$1</h6>');
  html = html.replace(/^#####\s+(.+)$/gm, '<h5 class="md-h5">$1</h5>');
  html = html.replace(/^####\s+(.+)$/gm, '<h4 class="md-h4">$1</h4>');
  html = html.replace(/^###\s+(.+)$/gm, '<h3 class="md-h3">$1</h3>');
  html = html.replace(/^##\s+(.+)$/gm, '<h2 class="md-h2">$1</h2>');
  html = html.replace(/^#\s+(.+)$/gm, '<h1 class="md-h1">$1</h1>');
  
  // 5. 无序列表渲染（- 或 * 开头）
  html = html.replace(/^(\s*)[-*+]\s+(.+)$/gm, (match, indent, content) => {
    const level = Math.floor(indent.length / 2);
    return `<li class="md-li md-li-ul" data-level="${level}">${renderInlineMarkdown(content)}</li>`;
  });
  // 包裹连续的列表项：一段连续 li 包进同一个 ul。
  // ⚠️ 旧实现逐条包裹（惰性正则只匹配到单条 li），每条各起一个列表。
  html = html.replace(/(?:<li class="md-li md-li-ul"[^>]*>[\s\S]*?<\/li>\s*)+/g, (m) => `<ul class="md-ul">${m}</ul>`);

  // 6. 有序列表渲染（数字. 开头）——原始编号写进 value 属性，断开续号也不丢
  html = html.replace(/^(\s*)(\d+)\.\s+(.+)$/gm, (match, indent, num, content) => {
    const level = Math.floor(indent.length / 2);
    return `<li class="md-li md-li-ol" data-level="${level}" value="${parseInt(num, 10)}">${renderInlineMarkdown(content)}</li>`;
  });
  html = html.replace(/(?:<li class="md-li md-li-ol"[^>]*>[\s\S]*?<\/li>\s*)+/g, (m) => `<ol class="md-ol">${m}</ol>`);
  
  // 7. 引用块渲染（> 开头）
  html = html.replace(/^>\s+(.+)$/gm, '<blockquote class="md-blockquote">$1</blockquote>');
  
  // 8. 水平线渲染（--- 或 ***）
  html = html.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, '<hr class="md-hr">');
  
  // 9. 行内Markdown渲染（粗体、斜体、行内代码、链接）
  html = renderInlineMarkdown(html);
  
  // 10. 恢复代码块（带语言标识和复制按钮）
  html = html.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (match, idx) => {
    const rawCode = codeBlocks[parseInt(idx)];
    // 提取语言标识（第一行）
    const firstNewline = rawCode.indexOf('\n');
    let lang = '';
    let cleanCode = rawCode;
    if (firstNewline >= 0) {
      const firstLine = rawCode.substring(0, firstNewline).trim();
      if (/^[a-zA-Z0-9+-]+$/.test(firstLine)) {
        lang = firstLine;
        cleanCode = rawCode.substring(firstNewline + 1);
      }
    }
    // 去除末尾多余换行
    cleanCode = cleanCode.replace(/\n+$/, '');
    // HTML 转义代码内容
    // 代码内容已在第1步HTML转义，直接使用（避免双重转义）
    const langLabel = lang ? lang : 'code';
    const blockId = 'mdcb_' + idx;
    const copyIcon = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="fill:none;"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    const expandIcon = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="fill:none;"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>';
    const foldIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="fill:none;transition:transform 0.2s;"><polyline points="6 9 12 15 18 9"/></svg>';
    const editIcon = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="fill:none;"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
    const runIcon = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="fill:none;"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
    return '<div class="md-code-block" id="' + blockId + '">'
      + '<div class="md-code-header">'
      + '<span class="md-code-lang">' + langLabel + '</span>'
      + '<div class="md-code-actions">'
      + '<button class="md-icon-btn" title="复制代码" onclick="copyCodeBlock(this)">' + copyIcon + '</button>'
      + '<button class="md-icon-btn" title="侧边查看" onclick="fullscreenCodeBlock(this)">' + expandIcon + '</button>'
      + '</div>'
      + '</div>'
      + '<pre class="md-pre"><code class="md-code">' + cleanCode.replace(/(https?:\/\/[^\s<>"']+)/g, '<a href="" target="_blank" class="md-code-link" onclick="event.stopPropagation();"></a>').replace(/\n/g, '\u0000NEWLINE\u0000') + '</code></pre>'
      + '</div>';
  });
  
  // 11. 换行渲染（保留换行）
  html = html.replace(/\n/g, '<br>');
  
  // 12. 恢复代码块内的换行符（<pre> 中保留原始换行）
  html = html.replace(/\u0000NEWLINE\u0000/g, '\n');
  
  return html;
}

// 行内Markdown渲染（粗体、斜体、行内代码、链接）
function renderInlineMarkdown(text) {
  if (!text) return '';
  
  let result = text;
  
  // 行内代码（`...`）
  result = result.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');
  
  // 粗体斜体（***...***）
  result = result.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  
  // 粗体（**...**）
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong class="md-strong">$1</strong>');
  
  // 斜体（*...* 或 _..._）
  result = result.replace(/\*([^*]+)\*/g, '<em class="md-em">$1</em>');
  result = result.replace(/_([^_]+)_/g, '<em class="md-em">$1</em>');
  
  // 删除线（~~...~~）
  result = result.replace(/~~([^~]+)~~/g, '<del class="md-del">$1</del>');
  
  // 链接（[text](url)）
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" class="md-link">$1</a>');
  
  // 图片（![alt](url)）
  result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" class="md-img" style="max-width:100%;border-radius:8px;">');
  
  return result;
}

let state = {

  currentTab: 'chat',
  chatHistory: [],           // 兼容旧版：当前活跃会话的消息
  conversations: [],         // 新版：所有会话 [{id, title, messages: [], createdAt, updatedAt}]
  activeConversationId: null,// 当前活跃会话ID
  activeRequestConversationId: null, // 当前正在进行的AI请求所属的会话ID（用于删除会话时取消请求）
  models: [],
  currentModelId: null,
  fileTree: [],
  currentPath: '',
  selectedFiles: new Set(),
  commandHistory: [],
  softwareList: [],
  localModels: [],
  cloudProviders: [],
  activeProviderId: null,
  settings: {},
  systemInfo: {},
  isStreaming: false
};

// 临时变量：用于在 agent-done 事件和消息保存逻辑之间传递 usage 和 elapsedMs
// 因为 agent-done 事件中会把 state.agentState 置为 null，所以需要用独立变量传递
let pendingAgentUsage = null;
// 思考过程/工具记录同理：agent-done 会把 state.agentState 置 null，而
// sendChatMessage 的 await 之后才落库，必须用临时变量接力，否则思考过程
// 无法持久化（用户反馈：切会话/重启后思考面板全空）
let pendingAgentReasoning = null;
let pendingAgentTools = null;
let pendingAgentContent = null;
let pendingAgentElapsedMs = 0;
// ★ 时间顺序步骤流（思考/工具/正文按发生先后逐条）落库用，见 exportAgentSteps
let pendingAgentSteps = null;
// ★ 本轮改动的文件列表（主进程按实际写操作记录，agent-done 接力给落库逻辑）
let pendingAgentChangedFiles = null;

// Agent 设置存档 key：聊天页「Agent 设置」面板与上下文自动压缩开关共用同一份存档
const AGENT_SETTINGS_KEY = 'ai-lobster-agent-settings-v2';

// 记录上次发送给主进程的宠物设置快照，避免重复发送导致窗口位移
let lastSentPetSettings = null;


// ========== 高级信息提示框（300ms 延迟 + 复杂内容 + 智能位置） ==========
const INFO_TIP_CONTENTS = {
  temperature: `<div class="tip-title">温度 (Temperature)</div>
    <div class="tip-desc">控制 AI 输出的随机性。值越低输出越确定、保守；值越高输出越随机、多样。温度为 0 时等价于贪心解码，总是选择概率最高的词。</div>
    <div class="tip-section">推荐值</div>
    <div class="tip-list">
      <div class="tip-item"><span class="tip-tag">代码 / 结构化输出</span><span class="tip-val">0 - 0.3</span></div>
      <div class="tip-item"><span class="tip-tag">事实问答 / 翻译</span><span class="tip-val">0.2 - 0.5</span></div>
      <div class="tip-item"><span class="tip-tag">普通对话</span><span class="tip-val default">0.5 - 1.0（默认 0.7）</span></div>
      <div class="tip-item"><span class="tip-tag">创意写作 / 头脑风暴</span><span class="tip-val">0.7 - 1.2</span></div>
    </div>`,
  maxTokens: `<div class="tip-title">最大Token (Max Tokens)</div>
    <div class="tip-desc">限制 AI 单次回复的最大长度。Token 是模型处理文本的基本单位，1 个 token ≈ 0.5 个中文字或 0.75 个英文单词。达到上限后模型会强制停止，可能导致回复被截断。</div>
    <div class="tip-section">推荐值</div>
    <div class="tip-list">
      <div class="tip-item"><span class="tip-tag">短对话 / 问答</span><span class="tip-val">1024 - 2048</span></div>
      <div class="tip-item"><span class="tip-tag">普通对话</span><span class="tip-val default">2048 - 4096（默认 2048）</span></div>
      <div class="tip-item"><span class="tip-tag">长文本 / 代码生成</span><span class="tip-val">4096 - 8192</span></div>
      <div class="tip-item"><span class="tip-tag">Agent / 思考模式</span><span class="tip-val">建议 8192 或更高</span></div>
    </div>
    <div class="tip-section" style="margin-top:8px;">注意</div>
    <div class="tip-desc" style="margin-bottom:0;">设置过小会导致回复被截断；设置过大会增加响应时间和资源消耗。Ollama 本地模型无需设置，使用默认值即可。</div>`,
  systemPrompt: `<div class="tip-title">系统提示词 (System Prompt)</div>
    <div class="tip-desc">设置 AI 的角色、行为和回答风格。系统提示词会在每次对话开始时发送给模型，影响模型的整体表现。可以用来设定 AI 的身份、语气、知识范围、回答格式等。</div>
    <div class="tip-section">使用示例</div>
    <div class="tip-list">
      <div class="tip-item"><span class="tip-tag">设定角色</span><span class="tip-val">"你是一个专业的编程助手"</span></div>
      <div class="tip-item"><span class="tip-tag">设定风格</span><span class="tip-val">"回答简洁明了，使用中文"</span></div>
      <div class="tip-item"><span class="tip-tag">设定限制</span><span class="tip-val">"只回答技术问题"</span></div>
      <div class="tip-item"><span class="tip-tag">设定格式</span><span class="tip-val">"使用 Markdown 格式回答"</span></div>
    </div>
    <div class="tip-section" style="margin-top:8px;">注意</div>
    <div class="tip-desc" style="margin-bottom:0;">留空则使用 AI 的默认行为。系统提示词会影响所有对话，建议根据使用场景调整。</div>`,
  codeConsole: `<div class="tip-title">代码控制台使用说明</div>
    <div class="tip-desc">在这里输入 JavaScript 代码，可以实时控制模型外观和编辑动作关键帧。代码支持 async/await 语法，按 Ctrl+Enter 快速运行。</div>
    <div class="tip-section">一、控制模型外观 (pet.*)</div>
    <div class="tip-list">
      <div class="tip-item"><span class="tip-tag">pet.size(1.5)</span><span class="tip-val">放大模型 (0.2~4)</span></div>
      <div class="tip-item"><span class="tip-tag">pet.opacity(0.8)</span><span class="tip-val">设置透明度 (0~1)</span></div>
      <div class="tip-item"><span class="tip-tag">pet.rotate({yaw:30})</span><span class="tip-val">左右旋转模型</span></div>
      <div class="tip-item"><span class="tip-tag">pet.rotate({pitch:15})</span><span class="tip-val">上下旋转模型</span></div>
      <div class="tip-item"><span class="tip-tag">pet.zoom(1.2)</span><span class="tip-val">缩放视角 (0.3~3)</span></div>
      <div class="tip-item"><span class="tip-tag">pet.reset()</span><span class="tip-val">重置视角和大小</span></div>
      <div class="tip-item"><span class="tip-tag">pet.action('挥手')</span><span class="tip-val">播放指定动作</span></div>
    </div>
    <div class="tip-section" style="margin-top:8px;">二、编辑动作关键帧 (ae.*)</div>
    <div class="tip-list">
      <div class="tip-item"><span class="tip-tag">ae.getDef()</span><span class="tip-val">查看当前动作完整定义</span></div>
      <div class="tip-item"><span class="tip-tag">ae.boneKeys()</span><span class="tip-val">查看所有可用骨骼名称</span></div>
      <div class="tip-item"><span class="tip-tag">ae.morphKeys()</span><span class="tip-val">查看所有可用表情名称</span></div>
      <div class="tip-item"><span class="tip-tag">ae.setMeta({duration:3})</span><span class="tip-val">设置动作总时长(秒)</span></div>
      <div class="tip-item"><span class="tip-tag">ae.setMeta({loop:true})</span><span class="tip-val">设置是否循环播放</span></div>
      <div class="tip-item"><span class="tip-tag">ae.setMeta({speed:1.5})</span><span class="tip-val">设置播放速度倍率</span></div>
      <div class="tip-item"><span class="tip-tag">ae.addKeyframe({t:0.5, bones:{rArm:{z:-1}}})</span><span class="tip-val">在0.5秒处新增关键帧</span></div>
      <div class="tip-item"><span class="tip-tag">ae.updateKeyframe(0, {bones:{lArm:{z:1}}})</span><span class="tip-val">修改第0个关键帧</span></div>
      <div class="tip-item"><span class="tip-tag">ae.updateKeyframeAt(1.0, {morphs:{眨眼:1}})</span><span class="tip-val">修改1.0秒处的关键帧</span></div>
      <div class="tip-item"><span class="tip-tag">ae.removeKeyframe(2)</span><span class="tip-val">删除第2个关键帧</span></div>
      <div class="tip-item"><span class="tip-tag">ae.render()</span><span class="tip-val">手动刷新预览视图</span></div>
    </div>
    <div class="tip-section" style="margin-top:8px;">三、使用示例</div>
    <div class="tip-desc" style="margin-bottom:0;">
      • 放大模型：await pet.size(1.5)<br>
      • 新增挥手帧：ae.addKeyframe({t:0.5, bones:{rArm:{z:-1}}})<br>
      • 设置循环：ae.setMeta({loop:true, duration:2})<br>
      • 查看骨骼：console.log(ae.boneKeys())
    </div>`,
  aiAssistant: `<div class="tip-title">AI 助手使用说明</div>
    <div class="tip-desc">用自然语言描述你想要的动作效果，AI 会自动思考并生成代码来操控模型和编辑关键帧。AI 具备工具调用能力，可以先查询模型信息，再生成代码，还能根据结果迭代优化。</div>
    <div class="tip-section">一、AI 工作流程</div>
    <div class="tip-list">
      <div class="tip-item"><span class="tip-tag">第1步：查询信息</span><span class="tip-val">AI 先调用工具获取模型骨骼、表情和当前动作信息</span></div>
      <div class="tip-item"><span class="tip-tag">第2步：思考方案</span><span class="tip-val">根据查询到的信息，思考如何实现你描述的效果</span></div>
      <div class="tip-item"><span class="tip-tag">第3步：生成代码</span><span class="tip-val">生成 JavaScript 代码并执行，实时作用于模型</span></div>
      <div class="tip-item"><span class="tip-tag">第4步：检查优化</span><span class="tip-val">检查执行结果，如果不理想会继续调整和优化</span></div>
    </div>
    <div class="tip-section" style="margin-top:8px;">二、AI 可调用的工具</div>
    <div class="tip-list">
      <div class="tip-item"><span class="tip-tag">get_model_bones</span><span class="tip-val">获取模型所有可用骨骼名称和说明</span></div>
      <div class="tip-item"><span class="tip-tag">get_morph_list</span><span class="tip-val">获取模型所有可用表情名称</span></div>
      <div class="tip-item"><span class="tip-tag">get_current_action</span><span class="tip-val">获取当前正在编辑的动作完整定义</span></div>
      <div class="tip-item"><span class="tip-tag">execute_code</span><span class="tip-val">执行 JavaScript 代码操控模型和关键帧</span></div>
    </div>
    <div class="tip-section" style="margin-top:8px;">三、使用示例</div>
    <div class="tip-desc" style="margin-bottom:0;">
      • "让左手举得更高一点"<br>
      • "做一个 3 秒的循环挥手动作"<br>
      • "让模型眨眨眼，然后微笑"<br>
      • "把右手旋转 45 度"<br>
      • "让动作播放速度变慢一点"
    </div>
    <div class="tip-section" style="margin-top:8px;">四、注意事项</div>
    <div class="tip-desc" style="margin-bottom:0;">
      • AI 编辑关键帧时是"累加"进行的，不会重置你已有的动作<br>
      • 最多进行 6 轮工具调用和思考<br>
      • 如果 AI 生成的效果不理想，可以继续用自然语言描述调整方向<br>
      • 需要先在「AI 配置」中设置可用的 AI 服务
    </div>`
};
let infoTipEl = null;
let infoTipTimer = null;
let infoTipCurrentEl = null;


// ==================== 统一自定义 Tooltip 组件 ====================
// 替换浏览器默认 tooltip，使用项目统一的深色/浅色主题样式
function initCustomTooltip() {
  if (document.getElementById('custom-tooltip')) return;

  const tooltipEl = document.createElement('div');
  tooltipEl.id = 'custom-tooltip';
  // 使用与 .info-tip 相同的样式（背景、边框、阴影、圆角），保持项目统一
  tooltipEl.style.cssText = 'position:fixed;z-index:999999;display:none;padding:8px 12px;background:rgba(20,22,30,0.97);color:#eef1f6;border:1px solid rgba(255,255,255,0.1);border-radius:10px;font-size:12px;line-height:1.5;pointer-events:none;box-shadow:0 8px 28px rgba(0,0,0,0.5),0 0 0 1px rgba(255,255,255,0.08);max-width:280px;max-height:120px;overflow-y:auto;word-wrap:break-word;transition:opacity 0.15s ease,transform 0.15s ease;backdrop-filter:blur(8px);opacity:0;transform:translateY(4px);';
  document.body.appendChild(tooltipEl);

  let showTimer = null;
  let activeEl = null;

  function hideTooltip() {
    clearTimeout(showTimer);
    if (activeEl) {
      const saved = activeEl.getAttribute('data-tt-title');
      if (saved) {
        activeEl.setAttribute('title', saved);
        activeEl.removeAttribute('data-tt-title');
      }
      activeEl = null;
    }
    tooltipEl.style.opacity = '0';
    setTimeout(() => { if (tooltipEl.style.opacity === '0') tooltipEl.style.display = 'none'; }, 150);
  }

  document.addEventListener('mouseover', function(e) {
    const target = e.target.closest('[title]');
    if (!target || !target.title) return;
    // 跳过空标题或纯空格，避免显示空黑框
    const titleText = target.title.trim();
    if (!titleText) return;

    activeEl = target;
    clearTimeout(showTimer);
    showTimer = setTimeout(function() {
      if (!activeEl || !activeEl.getAttribute('title')) return;
      const text = activeEl.getAttribute('title');
      // 保存并清空 title，阻止浏览器默认 tooltip
      activeEl.setAttribute('data-tt-title', text);
      activeEl.removeAttribute('title');

      tooltipEl.textContent = text;
      tooltipEl.style.display = 'block';
      tooltipEl.style.opacity = '0';

      // 位置计算：优先显示在元素下方，下方空间不足则显示在上方
      const rect = activeEl.getBoundingClientRect();
      // 先设置位置获取实际尺寸
      tooltipEl.style.left = '0px';
      tooltipEl.style.top = '0px';
      const tw = tooltipEl.offsetWidth;
      const th = tooltipEl.offsetHeight;

      let left = rect.left + rect.width / 2 - tw / 2;
      let top = rect.bottom + 6;

      // 水平边界
      if (left < 6) left = 6;
      if (left + tw > window.innerWidth - 6) left = window.innerWidth - tw - 6;
      // 垂直边界：下方不够则放上方
      if (top + th > window.innerHeight - 6) {
        top = rect.top - th - 6;
        if (top < 6) top = 6; // 上方也不够则贴顶
      }

      tooltipEl.style.left = left + 'px';
      tooltipEl.style.top = top + 'px';
      tooltipEl.style.opacity = '1';
    }, 300);
  });

  // 用 mouseleave 更可靠：鼠标离开文档或进入无title元素时隐藏
  document.addEventListener('mouseout', function(e) {
    if (!activeEl) return;
    // 检查鼠标是否还在 activeEl 或其子元素内
    const related = e.relatedTarget;
    if (related && activeEl.contains(related)) return;
    hideTooltip();
  });

  // 点击时隐藏
  document.addEventListener('click', hideTooltip, true);
  // 滚动时隐藏
  document.addEventListener('scroll', hideTooltip, true);
  // 窗口大小改变时隐藏
  window.addEventListener('resize', hideTooltip);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initCustomTooltip);
} else {
  initCustomTooltip();
}

// 龙虾钳鼠标光标：使用用户提供的PNG图片，正常/等待/点击/拖动四种状态

function ensureInfoTipEl() {
  if (!infoTipEl) {
    infoTipEl = document.createElement('div');
    infoTipEl.className = 'info-tip';
    infoTipEl.setAttribute('role', 'tooltip');
    document.body.appendChild(infoTipEl);
  }
  return infoTipEl;
}

function showInfoTip(targetEl) {
  const tipKey = targetEl.getAttribute('data-info-tip');
  // 优先从 i18n 获取提示内容（支持中英文切换），回退到硬编码的 INFO_TIP_CONTENTS
  // 注意：i18n找不到翻译时会返回key本身，需要检查并回退
  let content = null;
  const i18nKey = 'aiConfig.' + tipKey + 'Tip';
  const i18nResult = window.I18N?.t?.(i18nKey);
  if (i18nResult && i18nResult !== i18nKey && !i18nResult.startsWith('aiConfig.')) {
    content = i18nResult;
  }
  if (!content) content = INFO_TIP_CONTENTS[tipKey];
  if (!content) return;

  const tip = ensureInfoTipEl();
  tip.innerHTML = content;
  infoTipCurrentEl = targetEl;

  // 先显示以获取尺寸
  tip.style.visibility = 'hidden';
  tip.style.display = 'block';
  tip.classList.add('visible');

  // 计算位置
  const rect = targetEl.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  const gap = 8;

  // 优先显示在上方，空间不够则显示在下方
  let top, left;
  const spaceAbove = rect.top;
  const spaceBelow = viewportH - rect.bottom;

  if (spaceAbove >= tipRect.height + gap + 16) {
    top = rect.top - tipRect.height - gap;
  } else if (spaceBelow >= tipRect.height + gap + 16) {
    top = rect.bottom + gap;
  } else {
    top = Math.max(8, rect.top - tipRect.height - gap);
  }

  // 水平居中，确保不超出视口
  left = rect.left + rect.width / 2 - tipRect.width / 2;
  left = Math.max(8, Math.min(left, viewportW - tipRect.width - 8));

  tip.style.top = top + 'px';
  tip.style.left = left + 'px';
  tip.style.visibility = 'visible';
}

function hideInfoTip() {
  if (infoTipEl) {
    infoTipEl.classList.remove('visible');
    infoTipCurrentEl = null;
    setTimeout(() => {
      if (!infoTipCurrentEl && infoTipEl) {
        infoTipEl.style.display = 'none';
      }
    }, 150);
  }
}

function initInfoTips() {
  document.addEventListener('mouseover', (e) => {
    const target = e.target.closest('[data-info-tip]');
    if (!target || target === infoTipCurrentEl) return;
    if (infoTipTimer) {
      clearTimeout(infoTipTimer);
      infoTipTimer = null;
    }
    infoTipTimer = setTimeout(() => {
      showInfoTip(target);
      infoTipTimer = null;
    }, 300);
  });

  document.addEventListener('mouseout', (e) => {
    const target = e.target.closest('[data-info-tip]');
    if (!target) return;
    if (infoTipTimer) {
      clearTimeout(infoTipTimer);
      infoTipTimer = null;
    }
    if (infoTipCurrentEl === target) {
      hideInfoTip();
    }
  });

  window.addEventListener('scroll', () => {
    if (infoTipCurrentEl) hideInfoTip();
  }, true);

;
}

// ==================== 初始化 ====================
// 全局禁用拼写检查，防止输入或修改文本时文字下方出现红色波浪线（^）
function disableSpellCheckGlobally() {
  // 禁用所有现有输入框和文本域的拼写检查
  const disableForElement = (el) => {
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
      el.spellcheck = false;
      el.setAttribute('spellcheck', 'false');
    }
  };

  // 处理现有元素
  document.querySelectorAll('input, textarea, [contenteditable="true"]').forEach(disableForElement);

  // 使用 MutationObserver 监听动态创建的输入框
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          // 检查新增的元素本身
          disableForElement(node);
          // 检查新增元素的子元素
          if (node.querySelectorAll) {
            node.querySelectorAll('input, textarea, [contenteditable="true"]').forEach(disableForElement);
          }
        }
      });
    });
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}


/**
 * 代码块复制按钮：事件委托，点击复制对应代码块内容到剪贴板
 */
/**
 * 全局外部链接处理：点击 http/https 链接时用系统默认浏览器打开
 */
function setupExternalLinks() {
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href]');
    if (!link) return;
    const href = link.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) {
      e.preventDefault();
      e.stopPropagation();
      if (window.api && window.api.openExternal) {
        window.api.openExternal(href);
      } else {
        window.open(href, '_blank');
      }
    }
  });
}

function setupCodeCopyButtons() {
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.md-copy-btn');
    if (!btn) return;
    e.stopPropagation();
    const block = btn.closest('.md-code-block');
    if (!block) return;
    const codeEl = block.querySelector('code.md-code');
    if (!codeEl) return;
    const text = codeEl.textContent;
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      // 降级：用 textarea + execCommand
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (__) {}
      document.body.removeChild(ta);
    }
    const original = btn.textContent;
    btn.textContent = '已复制';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('copied');
    }, 2000);
  });
}
// 开发人员弹窗（滚动字幕）：1s 一行从头播放，播完即停；手动上下滑动时停止自动播放
function setupDevelopers() {
  const btn = document.getElementById('btn-open-developers');
  const ov = document.getElementById('developers-overlay');
  const box = document.getElementById('developers-scroll');
  const inner = document.getElementById('developers-inner');
  const closeBtn = document.getElementById('developers-close');
  if (!btn || !ov || !box || !inner) return;
  let animId = null;
  let autoScroll = false;   // 自动播放中
  let done = false;         // 是否已播完（播完即停，不再自动恢复）
  let resumeTimer = null;   // 用户停止操作后恢复播放的定时器
  let pos = 0;
  let max = 0;
  let speed = 0;

  function cancelResume() {
    if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
  }

  function closeDev() {
    cancelResume();
    stop();
    ov.style.display = 'none';
  }

  function stop() {
    if (animId) { cancelAnimationFrame(animId); animId = null; }
    autoScroll = false;
  }

  // 从头开始播放
  function play() {
    cancelResume();
    stop();
    const rows = inner.querySelectorAll('.dev-title, .dev-sub, .dev-heading, .dev-line, .dev-end');
    const n = rows.length;
    if (!n) return;
    box.scrollTop = 0;
    max = Math.max(0, box.scrollHeight - box.clientHeight);
    if (max <= 0) return;
    speed = (box.scrollHeight / n) / 1000; // px/ms ≈ 1 秒滚动一行
    pos = 0;
    done = false;
    startAnim();
  }

  // 连续匀速向上滚动：每帧按「一行/秒」的速度推进，全程平滑无停顿；到头即停。
  // 位置用累加变量驱动（不依赖 scrollTop 回读，避免缩放取整/事件时序造成误判）。
  function startAnim() {
    if (done || animId || autoScroll) return;
    autoScroll = true;
    let last = performance.now();
    const step = (now) => {
      if (!autoScroll) return;
      const dt = Math.min(64, now - last); // 限制单帧步长，避免后台切回时跳变
      last = now;
      pos = Math.min(max, pos + speed * dt);
      box.scrollTop = pos;
      if (pos >= max) {
        autoScroll = false;
        done = true;
        animId = null;
        return; // 播放到最后一行即停止，不循环
      }
      animId = requestAnimationFrame(step);
    };
    animId = requestAnimationFrame(step);
  }

  // 用户介入：暂停自动播放；停止操作约 700ms 后自动恢复向上滚动（从当前位置继续），播完则不恢复
  function pauseForUser() {
    if (done) { cancelResume(); return; }
    stop();
    pos = box.scrollTop; // 记录当前位置，恢复时从这继续
    cancelResume();
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      if (done) return;
      pos = box.scrollTop;
      startAnim();
    }, 700);
  }

  // 滚轮 / 触摸 / 按住拖动 / 松开 → 暂停并安排恢复；恢复前多次操作会刷新计时
  box.addEventListener('wheel', () => pauseForUser(), { passive: true });
  box.addEventListener('touchstart', () => pauseForUser(), { passive: true });
  box.addEventListener('touchend', () => pauseForUser(), { passive: true });
  box.addEventListener('pointerdown', () => pauseForUser(), { passive: true });
  box.addEventListener('pointerup', () => pauseForUser(), { passive: true });

  // 字幕中的链接：暂停播放并交给系统浏览器打开；700ms 后自动恢复滚动
  box.addEventListener('click', e => {
    const a = e.target.closest('.dev-link');
    if (!a) return;
    e.preventDefault();
    pauseForUser();
    const url = a.getAttribute('data-url') || a.href;
    if (window.api && window.api.openExternal) window.api.openExternal(url);
    else if (window.open) window.open(url, '_blank');
  });

  btn.addEventListener('click', async () => {
    ov.style.display = 'flex';
    box.scrollTop = 0;
    inner.innerHTML = '<div class="dev-line" style="opacity:.6">加载中…</div>';
    try {
      const resp = await fetch('data/developers.json', { cache: 'no-store' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      inner.innerHTML = developersHtml(data);
    } catch (err) {
      inner.innerHTML = '<div class="dev-line" style="opacity:.6">开发人员数据加载失败：' + String(err && err.message || err) + '</div>';
    }
    play();
  });

  ov.addEventListener('click', e => {
    if (e.target === ov) closeDev();
  });
  if (closeBtn) closeBtn.addEventListener('click', closeDev);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && ov.style.display === 'flex') closeDev();
  });
}

function developersHtml(data) {
  if (!data || !data.sections) return '';
  // 内容来自独立数据文件 data/developers.json（静态文本，无用户输入）
  const escH = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  // 把文本中的 URL 变成可点击链接（点击经 openExternal 交给系统浏览器）
  const linkify = (s) => escH(s).replace(/https?:\/\/[^\s"'<>]+/g, '<a class="dev-link" data-url="$&">$&</a>');
  let html = '';
  if (data.title) html += '<div class="dev-title">' + linkify(data.title) + '</div>';
  if (data.subtitle) html += '<div class="dev-sub">' + linkify(data.subtitle) + '</div>';
  for (const sec of data.sections) {
    if (!sec || !sec.lines || !sec.lines.length) continue;
    if (sec.heading) html += '<div class="dev-heading">' + linkify(sec.heading) + '</div>';
    for (const ln of sec.lines) {
      const who = linkify(ln.who || '');
      const why = linkify(ln.why || '');
      if (who && why) html += '<div class="dev-line"><span class="who">' + who + '</span><span class="why">' + why + '</span></div>';
      else html += '<div class="dev-line dev-text">' + (who || why) + '</div>';
    }
  }
  if (data.ending) html += '<div class="dev-end">' + linkify(data.ending) + '</div>';
  return html;
}
async function init() {
  injectIcons();
  // 全局禁用拼写检查，防止输入或修改文本时文字下方出现红色波浪线（^）
  disableSpellCheckGlobally();
  if (IS_EDITOR_WINDOW) {
    // 动作编辑器独立窗口：复用同一 index.html，只初始化编辑器所需部分
    setupEditorWindowControls();
    setupIpcListeners();
    // 初始化高级信息提示框（温度/API说明等悬停提示）
    if (typeof initInfoTips === 'function') initInfoTips();
    await bootstrapEditorWindow();
    return;
  }
  setupNavigation();
  setupUpdateModal();
  setupDownloadCenter();
  setupWindowControls();
  setupEventListeners();
  setupCodeCopyButtons();
  setupExternalLinks();
  setupIpcListeners();
  setupPresetCards();
  initRoleManagement();
  setupDevelopers();

  await loadInitialData();
  // ★ 确保默认对话页面被正确激活和渲染（HTML中默认active但JS的onTabActivated未触发）
  switchTab('chat');
  // 桌面分身预览窗只在对话页显示：窗口显示/隐藏（最小化到托盘）时也要同步一次
  document.addEventListener('visibilitychange', notifyClonePageVisibility);
  notifyClonePageVisibility();
  checkDisclaimer();
  // Delay Ollama connection check to ensure service has time to start
  setTimeout(() => {
    checkOllamaConnection(3);
    updatePresetCardStatus();
  }, 2000);
  setupChangelogModal();
  checkForUpdates();
  // 初始化工具栏图标样式（浅色模式下使用描边式）
  setTimeout(() => updateToolbarIconStyles(), 100);

  // ★ 渲染进程内存优化：定期清理
  startRendererMemoryOptimization();

  // ★ 后台模式处理：主窗口隐藏时暂停不必要的渲染和计算
  if (window.api && window.api.on) {
    window.api.on('app:background-mode', (data) => {
      if (data && data.enabled) {
        console.log('[MemoryOptimizer] 进入后台模式，暂停不必要的渲染和计算');
        enterBackgroundMode();
      } else {
        console.log('[MemoryOptimizer] 退出后台模式，恢复渲染和计算');
        exitBackgroundMode();
      }
    });
  }
}

// ============================================================
// 后台模式管理
// ============================================================
let isBackgroundMode = false;
let backgroundModeTimers = [];

function enterBackgroundMode() {
  if (isBackgroundMode) return;
  isBackgroundMode = true;

  // 1. 暂停动画帧循环（如果有）
  if (window.animationFrameId) {
    cancelAnimationFrame(window.animationFrameId);
    window.animationFrameId = null;
  }

  // 2. 暂停不必要的定时器（记录下来以便恢复）
  // 这里可以根据需要暂停特定的定时器

  // 3. 触发垃圾回收
  if (window.gc) {
    try { window.gc(); } catch (e) {}
  }

  // 4. 通知主进程进行内存优化
  if (window.api && window.api.optimizeMemory) {
    window.api.optimizeMemory().catch(() => {});
  }

  console.log('[MemoryOptimizer] 后台模式已启用');
}

function exitBackgroundMode() {
  if (!isBackgroundMode) return;
  isBackgroundMode = false;

  // 1. 恢复渲染（重新渲染当前界面）
  try {
    renderChat();
    renderConversationList();
  } catch (e) {}

  // 2. 恢复定时器（如果有暂停的）

  console.log('[MemoryOptimizer] 后台模式已退出，渲染已恢复');
}

// ============================================================
// 渲染进程内存优化
// ============================================================
function startRendererMemoryOptimization() {
  // 每10分钟执行一次内存清理
  setInterval(() => {
    try {
      cleanupRendererMemory();
    } catch (e) {
      console.error('[MemoryOptimizer] 渲染进程内存清理失败:', e.message);
    }
  }, 10 * 60 * 1000);

  // 页面隐藏时立即执行内存清理
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      setTimeout(() => cleanupRendererMemory(), 1000);
    }
  });

  console.log('[MemoryOptimizer] 渲染进程内存优化已启动');
}

function cleanupRendererMemory() {
  console.log('[MemoryOptimizer] 开始渲染进程内存清理...');

  // 1. 清理聊天历史记录（通过saveConversations中的限制逻辑）
  if (state.conversations && state.conversations.length > 0) {
    saveConversations();
  }

  // 2. 清理不需要的DOM元素（已关闭的弹窗、临时元素等）
  const tempElements = document.querySelectorAll('.temp-element, .toast-container .toast:not(.show)');
  tempElements.forEach(el => {
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
    }
  });

  // 3. 清理已完成的下载记录（保留最近20条）
  if (state.completedDownloads && state.completedDownloads.length > 20) {
    state.completedDownloads = state.completedDownloads.slice(-20);
  }

  // 4. 触发浏览器垃圾回收（如果可用）
  if (window.gc) {
    try { window.gc(); } catch (e) {}
  }

  // 5. 通知主进程进行内存优化
  if (window.api && window.api.optimizeMemory) {
    window.api.optimizeMemory().catch(() => {});
  }

  console.log('[MemoryOptimizer] 渲染进程内存清理完成');
}

// ========== 应用更新 ==========
const BETA_JSON_URL = 'https://raw.githubusercontent.com/yonggezx/fuling-shijie-update/main/update/beta.json';
let currentUpdateInfo = null;

function isBetaVersion(version) {
  if (!version) return false;
  const v = version.toLowerCase();
  return v.includes('beta') || v.includes('alpha') || v.includes('rc') || v.includes('preview') || v.split('.').length > 3;
}

function compareVer(a, b) {
  const pa = String(a).replace(/[^0-9.]/g, '').split('.').map(Number);
  const pb = String(b).replace(/[^0-9.]/g, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0, db = pb[i] || 0;
    if (da > db) return 1; if (da < db) return -1;
  }
  return 0;
}

async function fetchUpdateFromUrl(url, currentVersion) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return { success: false, error: 'HTTP ' + res.status };
    const meta = await res.json();
    if (compareVer(currentVersion, meta.latestVersion) >= 0)
      return { success: true, hasUpdate: false, currentVersion, latestVersion: meta.latestVersion };
    const direct = (meta.patches || []).find(p => p.from === currentVersion && p.to === meta.latestVersion);
    const patches = direct ? [direct] : (meta.patches || []).filter(p => compareVer(p.from, currentVersion) >= 0 && compareVer(p.to, meta.latestVersion) <= 0);
    return { success: true, hasUpdate: true, currentVersion, latestVersion: meta.latestVersion, releaseDate: meta.releaseDate || '', changes: meta.changes || '', patches, ignored: false, channel: meta.channel || 'beta', requiresFullInstall: patches.some(p => p.requiresFullInstall) };
  } catch (e) { return { success: false, error: e.message }; }
}

async function checkForAppUpdate(manual, forceBeta) {
  const btn = document.getElementById('btn-check-update');
  if (btn) { btn.disabled = true; btn.textContent = I18N.t('update.checking'); }
  try {
    const result = await window.api.updateCheck();
    if (!result || !result.success) {
      if (manual) showToast(I18N.t('update.checkFailed'), (result && result.error) || I18N.t('update.networkError'), 'error');
      return;
    }
    if (result.hasUpdate && !result.ignored) {
      currentUpdateInfo = result;
      showUpdateModal(result);
    } else if (manual) {
      showToast(I18N.t('update.alreadyLatest'), 'v' + result.currentVersion, 'success');
    }
  } catch (err) {
    if (manual) showToast(I18N.t('update.checkFailed'), err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = I18N.t('settings.checkUpdate'); }
  }
}

function showUpdateModal(info) {
  const onlyFull = !info.hasUpdate && info.fullInstall;
  const displayVersion = onlyFull ? info.fullInstall.version : info.latestVersion;
  document.getElementById('update-new-version').textContent = 'v' + displayVersion;
  document.getElementById('update-beta-badge').style.display = info.channel === 'beta' ? 'inline-block' : 'none';
  document.getElementById('update-release-date').textContent = info.fullInstall ? (info.fullInstall.releaseDate || '') : (info.releaseDate || '');
  const stepsInfo = info.multiStep && info.patches ? `（跨 ${info.patches.length} 个版本连续更新）` : '';
  const refreshInfo = info.sameVersionRefresh ? '（内容已更新，建议修复更新）' : '';
  const fullOnlyInfo = onlyFull ? '（完整安装包，含主进程更新）' : '';
  // 完整包的公告：优先取 fullInstall.changes，为空时回退到补丁级 changes，避免公告空白
  const fullChanges = (info.fullInstall && info.fullInstall.changes) ? info.fullInstall.changes : (info.changes || '');
  document.getElementById('update-changes').textContent = fullChanges + stepsInfo + refreshInfo + fullOnlyInfo;
  document.getElementById('update-progress-wrap').style.display = 'none';
  document.getElementById('update-status').textContent = '';
  // 完整包下载按钮：有完整包信息时显示
  const fullBtn = document.getElementById('update-full-package');
  if (fullBtn) {
    if (info.fullInstall && !info.isFullPackage) {
      fullBtn.style.display = 'inline-block';
      fullBtn.disabled = false;
      fullBtn.onclick = () => {
        document.getElementById('update-modal-overlay').classList.remove('show');
        startFullDownload(info.fullInstall);
        switchTab('downloads');
      };
    } else {
      fullBtn.style.display = 'none';
    }
  }
  const confirmBtn = document.getElementById('update-confirm');
  if (onlyFull) {
    confirmBtn.style.display = 'none';
  } else {
    confirmBtn.style.display = 'inline-block';
    confirmBtn.disabled = false;
    confirmBtn.textContent = info.sameVersionRefresh ? I18N.t('update.repairNow') : I18N.t('update.updateNow');
    confirmBtn.onclick = doUpdate;
  }
  document.getElementById('update-modal-overlay').classList.add('show');
}

async function doUpdate() {
  if (!currentUpdateInfo || !currentUpdateInfo.patches.length) return;
  const confirmBtn = document.getElementById('update-confirm');
  confirmBtn.disabled = true;
  confirmBtn.textContent = I18N.t('update.updating');
  document.getElementById('update-progress-wrap').style.display = 'block';
  const progressBar = document.getElementById('update-progress-bar');
  const progressText = document.getElementById('update-progress-percent');
  const statusEl = document.getElementById('update-status');
  const total = currentUpdateInfo.patches.length;
  let completed = 0;

  window.api.onUpdateDownloadProgress(function(data) {
    // 多版本整体进度 = (已完成*100 + 当前补丁进度) / 总数
    const overall = total > 1 ? Math.round((completed * 100 + data.percent) / total) : data.percent;
    progressBar.style.width = overall + '%';
    progressText.textContent = overall + '%';
  });

  let lastApplyResult = null;
  let allSuccess = true;
  for (let i = 0; i < total; i++) {
    const patch = currentUpdateInfo.patches[i];
    statusEl.textContent = I18N.t('update.downloadingPatch').replace('{i}', i + 1).replace('{total}', total).replace('{from}', patch.from).replace('{to}', patch.to);
    const dlResult = await window.api.updateDownload(patch);
    if (!dlResult.success) { statusEl.textContent = I18N.t('update.downloadFailed') + ': ' + dlResult.error; allSuccess = false; break; }
    if (patch.checksum) {
      const v = await window.api.updateVerify({ zipPath: dlResult.zipPath, checksum: patch.checksum });
      if (!v.success) { statusEl.textContent = I18N.t('update.verifyFailed'); allSuccess = false; break; }
    }
    statusEl.textContent = I18N.t('update.applyingPatch').replace('{i}', i + 1).replace('{total}', total).replace('{from}', patch.from).replace('{to}', patch.to);
    const applyResult = await window.api.updateApply({ zipPath: dlResult.zipPath, patchInfo: patch });
    if (!applyResult.success) { statusEl.textContent = I18N.t('update.applyFailed') + ': ' + applyResult.error; allSuccess = false; break; }
    lastApplyResult = applyResult;
    completed++;
  }

  if (allSuccess) {
    progressBar.style.width = '100%';
    progressText.textContent = '100%';
    if (lastApplyResult && lastApplyResult.isFullPackage) {
      statusEl.textContent = I18N.t('update.fullReady');
      confirmBtn.textContent = I18N.t('update.restartInstall');
      confirmBtn.disabled = false;
      const installerPath = lastApplyResult.installerPath;
      confirmBtn.onclick = function() { window.api.updateRunInstaller({ installerPath }); };
    } else {
      statusEl.textContent = total > 1 ? I18N.t('update.multiVersionDone').replace('{total}', total) : I18N.t('update.updateDone');
      confirmBtn.textContent = I18N.t('update.restart');
      confirmBtn.disabled = false;
      confirmBtn.onclick = function() { window.api.relaunchApp(); };
    }
    if (typeof updateVersionDisplay === 'function' && currentUpdateInfo) {
      updateVersionDisplay(currentUpdateInfo.latestVersion);
    }
  } else {
    confirmBtn.disabled = false;
    confirmBtn.textContent = I18N.t('update.retry');
    confirmBtn.onclick = doUpdate;
  }
}

// 完整包下载安装
async function doFullPackageUpdate(fullInfo) {
  const fullBtn = document.getElementById('update-full-package');
  const confirmBtn = document.getElementById('update-confirm');
  const progressWrap = document.getElementById('update-progress-wrap');
  const progressBar = document.getElementById('update-progress-bar');
  const progressText = document.getElementById('update-progress-percent');
  const statusEl = document.getElementById('update-status');

  fullBtn.disabled = true;
  confirmBtn.disabled = true;
  progressWrap.style.display = 'block';
  statusEl.textContent = I18N.t('update.downloadingFull');

  window.api.onUpdateDownloadProgress(function(data) {
    progressBar.style.width = data.percent + '%';
    progressText.textContent = data.percent + '%';
  });

  try {
    const dlResult = await window.api.updateDownload(fullInfo);
    if (!dlResult.success) { statusEl.textContent = '下载失败: ' + dlResult.error; fullBtn.disabled = false; confirmBtn.disabled = false; return; }
    if (fullInfo.checksum) {
      statusEl.textContent = I18N.t('update.verifyingFull');
      const v = await window.api.updateVerify({ zipPath: dlResult.zipPath, checksum: fullInfo.checksum });
      if (!v.success) { statusEl.textContent = '校验失败，文件可能已损坏'; fullBtn.disabled = false; confirmBtn.disabled = false; return; }
    }
    statusEl.textContent = I18N.t('update.preparingInstaller');
    const applyResult = await window.api.updateApply({ zipPath: dlResult.zipPath, patchInfo: fullInfo });
    if (!applyResult.success) { statusEl.textContent = '失败: ' + applyResult.error; fullBtn.disabled = false; confirmBtn.disabled = false; return; }
    progressBar.style.width = '100%';
    progressText.textContent = '100%';
    statusEl.textContent = '完整安装包已就绪，点击下方按钮重启并安装';
    confirmBtn.textContent = '重启并安装';
    confirmBtn.disabled = false;
    confirmBtn.onclick = function() { window.api.updateRunInstaller({ installerPath: applyResult.installerPath }); };
    fullBtn.style.display = 'none';
    if (typeof updateVersionDisplay === 'function') updateVersionDisplay(fullInfo.version);
  } catch (err) {
    statusEl.textContent = I18N.t('update.error') + ': ' + err.message;
    fullBtn.disabled = false;
    confirmBtn.disabled = false;
  }
}

// ========== 下载中心 ==========
const activeDownloads = new Map(); // id -> { fullInstall, phase, percent, message, error }
let downloadIdCounter = 0;

function startFullDownload(fullInstall) {
  if (activeDownloads.size > 0) {
    showToast(I18N.t('download.existingTask'), I18N.t('download.waitExisting'), 'info');
    switchTab('downloads');
    return;
  }
  const id = ++downloadIdCounter;
  const item = {
    id,
    version: fullInstall.version,
    name: `浮灵饰界 v${fullInstall.version} 完整安装包`,
    phase: 'downloading',
    percent: 0,
    message: I18N.t('download.preparing'),
    fullInstall
  };
  activeDownloads.set(id, item);
  renderDownloads();

  // 监听进度
  const offProgress = window.api.onFullDownloadProgress(function(data) {
    item.phase = data.phase;
    item.percent = data.percent;
    item.message = data.message;
    renderDownloads();
  });

  window.api.updateDownloadFull(fullInstall).then(function(result) {
    offProgress();
    if (result.success) {
      item.phase = 'complete';
      item.percent = 100;
      item.message = I18N.t('download.completed');
      item.installerPath = result.installerPath;
      item.size = result.size;
      showToast(I18N.t('download.completed'), item.name + ' ' + I18N.t('download.completedSuffix'), 'success');
    } else {
      item.phase = 'error';
      item.message = I18N.t('download.failed') + ': ' + result.error;
      showToast(I18N.t('download.failed'), result.error, 'error');
    }
    activeDownloads.delete(id);
    renderDownloads();
    loadCompletedDownloads();
  }).catch(function(err) {
    offProgress();
    item.phase = 'error';
    item.message = '错误: ' + err.message;
    activeDownloads.delete(id);
    renderDownloads();
    loadCompletedDownloads();
  });
}

function renderDownloads() {
  const activeEl = document.getElementById('downloads-active');
  const completedEl = document.getElementById('downloads-completed');
  if (!activeEl || !completedEl) return;

  // 正在下载
  if (activeDownloads.size === 0) {
    activeEl.innerHTML = '<div class="downloads-empty">暂无下载任务</div>';
  } else {
    activeEl.innerHTML = '';
    for (const item of activeDownloads.values()) {
      let statusClass = 'status-downloading', statusText = '下载中';
      if (item.phase === 'merging') { statusClass = 'status-merging'; statusText = '合并中'; }
      else if (item.phase === 'verifying') { statusClass = 'status-verifying'; statusText = '校验中'; }
      else if (item.phase === 'error') { statusClass = 'status-error'; statusText = '失败'; }
      activeEl.innerHTML += `
        <div class="download-item">
          <div class="download-item-icon">${window.ElIcons.getIcon('archive')}</div>
          <div class="download-item-info">
            <div class="download-item-name">${item.name}</div>
            <div class="download-item-meta">${item.message}</div>
            <div class="download-item-progress"><div class="download-item-progress-bar" style="width:${item.percent}%"></div></div>
          </div>
          <span class="download-item-status ${statusClass}">${statusText} ${item.phase !== 'error' ? item.percent + '%' : ''}</span>
        </div>`;
    }
  }
}

async function loadCompletedDownloads() {
  const completedEl = document.getElementById('downloads-completed');
  if (!completedEl) return;
  try {
    const result = await window.api.updateGetDownloads();
    const packages = result.packages || [];
    if (packages.length === 0) {
      completedEl.innerHTML = '<div class="downloads-empty">暂无已下载的安装包</div>';
      return;
    }
    completedEl.innerHTML = '';
    for (const pkg of packages) {
      completedEl.innerHTML += `
        <div class="download-item">
          <div class="download-item-icon">${window.ElIcons.getIcon('success')}</div>
          <div class="download-item-info">
            <div class="download-item-name">${pkg.name}</div>
            <div class="download-item-meta">${pkg.sizeMB} MB · ${new Date(pkg.createdAt).toLocaleString('zh-CN')}</div>
            <div class="download-item-meta" style="margin-top:2px;opacity:0.7;font-size:11px;">${pkg.path}</div>
          </div>
          <span class="download-item-status status-complete">已完成</span>
          <div class="download-item-actions">
            <button class="btn btn-sm btn-primary" onclick="installDownloadedPackage('${pkg.path.replace(/\\/g, '\\\\')}')">安装</button>
            <button class="btn btn-sm" onclick="showInFolder('${pkg.path.replace(/\\/g, '\\\\')}')" title="在文件夹中显示">${window.ElIcons.getIcon('folder')}</button>
            <button class="btn btn-sm" onclick="deleteDownloadedPackage('${pkg.path.replace(/\\/g, '\\\\')}')">删除</button>
          </div>
        </div>`;
    }
  } catch (e) {
    completedEl.innerHTML = '<div class="downloads-empty">加载失败: ' + e.message + '</div>';
  }
}

async function installDownloadedPackage(filePath) {
  try {
    await window.api.updateRunInstaller({ installerPath: filePath });
  } catch (e) {
    showToast('安装失败', e.message, 'error');
  }
}

async function deleteDownloadedPackage(filePath) {
  try {
    const result = await window.api.updateDeleteDownload({ filePath });
    if (result.success) {
      showToast('已删除', '安装包已删除', 'success');
      loadCompletedDownloads();
    } else {
      showToast('删除失败', result.error, 'error');
    }
  } catch (e) {
    showToast('删除失败', e.message, 'error');
  }
}

async function showInFolder(filePath) {
  try {
    await window.api.updateShowInFolder({ filePath });
  } catch (e) {
    showToast('打开失败', e.message, 'error');
  }
}

function setupDownloadCenter() {
  // 暴露到 window 供 onclick 调用
  window.installDownloadedPackage = installDownloadedPackage;
  window.deleteDownloadedPackage = deleteDownloadedPackage;
  window.showInFolder = showInFolder;
  // 刷新按钮
  const refreshBtn = document.getElementById('btn-refresh-downloads');
  if (refreshBtn) refreshBtn.onclick = function() { loadCompletedDownloads(); renderDownloads(); };
  // 下载目录设置
  initDownloadDirSetting();
}

async function initDownloadDirSetting() {
  const input = document.getElementById('download-dir');
  if (!input) return;
  try {
    const result = await window.api.updateGetDownloadDir();
    input.value = result.dir || '';
  } catch (e) {}
  const chooseBtn = document.getElementById('btn-choose-download-dir');
  if (chooseBtn) chooseBtn.onclick = async function() {
    try {
      const result = await window.api.updateChooseDownloadDir();
      if (!result.canceled && result.dir) {
        const saveRes = await window.api.updateSetDownloadDir({ dir: result.dir });
        if (saveRes.success) {
          input.value = saveRes.dir || result.dir;
          showToast('已保存', '下载目录已更新', 'success');
        } else {
          showToast('保存失败', saveRes.error, 'error');
        }
      }
    } catch (e) { showToast('选择失败', e.message, 'error'); }
  };
  const resetBtn = document.getElementById('btn-reset-download-dir');
  if (resetBtn) resetBtn.onclick = async function() {
    try {
      const result = await window.api.updateResetDownloadDir();
      if (result.success) {
        input.value = result.dir;
        showToast('已恢复', '下载目录已恢复默认', 'success');
      }
    } catch (e) { showToast('操作失败', e.message, 'error'); }
  };
}

function setupUpdateModal() {
  document.getElementById('update-modal-close').onclick = function() {
    document.getElementById('update-modal-overlay').classList.remove('show');
  };
  document.getElementById('update-ignore-today').onclick = async function() {
    if (currentUpdateInfo) await window.api.updateIgnore({ version: currentUpdateInfo.latestVersion, type: 'today' });
    document.getElementById('update-modal-overlay').classList.remove('show');
  };
  document.getElementById('update-ignore-forever').onclick = async function() {
    if (currentUpdateInfo) await window.api.updateIgnore({ version: currentUpdateInfo.latestVersion, type: 'forever' });
    document.getElementById('update-modal-overlay').classList.remove('show');
  };
  const btn = document.getElementById('btn-check-update');
  if (btn) btn.onclick = function() { checkForAppUpdate(true); };
  const fullBtn = document.getElementById('btn-full-package-download');
  if (fullBtn) fullBtn.onclick = async function() {
    fullBtn.disabled = true;
    fullBtn.textContent = '获取中...';
    try {
      let fullInstallInfo = null;
      try {
        const result = await window.api.getFullInstall();
        if (result && result.success && result.fullInstall) fullInstallInfo = result.fullInstall;
      } catch(e) {}
      // 兜底：网络异常时使用内嵌信息
      if (!fullInstallInfo) fullInstallInfo = EMBEDDED_FULL_INSTALL;
      if (fullInstallInfo) {
        startFullDownload(fullInstallInfo);
        switchTab('downloads');
      } else {
        showToast('暂无完整包', '当前没有可用的完整安装包', 'info');
      }
    } catch (e) {
      showToast('获取失败', e.message, 'error');
    } finally {
      fullBtn.disabled = false;
      fullBtn.innerHTML = '<span class="el-icon" data-icon="download"></span><span>完整包下载</span>';
    }
  };
}

// 注入 Element UI 风格 SVG 图标到 DOM
function injectIcons() {
  const ICONS = window.ElIcons.ICONS;

  // ID-based injection (nav icons, preset icons)
  const iconMap = {
    'nav-icon-chat': 'chat',
    'nav-icon-models': 'models',
    'nav-icon-files': 'files',
    'nav-icon-terminal': 'terminal',
    'nav-icon-software': 'software',
    'nav-icon-downloads': 'download',
    'nav-icon-ai': 'aiConfig',
    'nav-icon-settings': 'settings',
    'nav-icon-about': 'about',
  };
  for (const [id, name] of Object.entries(iconMap)) {
    const el = document.getElementById(id);
    if (el && ICONS[name]) el.innerHTML = ICONS[name];
  }

  // data-icon attribute injection (buttons, etc.)
  document.querySelectorAll('[data-icon]').forEach(el => {
    const name = el.dataset.icon;
    if (ICONS[name]) {
      el.innerHTML = ICONS[name];
    }
  });

  // 一键接入卡片使用 LobeHub 品牌图标
  if (window.ModelIcons) {
    const presetIcons = {
      'preset-ollama-icon': { name: 'Ollama', type: 'ollama', apiUrl: 'http://localhost:11434' },
      'preset-bailian-icon': { name: '阿里云百炼', type: 'dashscope', apiUrl: 'https://dashscope.aliyuncs.com' },
      'preset-deepseek-icon': { name: 'DeepSeek', type: 'deepseek', apiUrl: 'https://api.deepseek.com' },
      'preset-openai-icon': { name: 'OpenAI', type: 'openai', apiUrl: 'https://api.openai.com' },
      'preset-anthropic-icon': { name: 'Anthropic Claude', type: 'openai', apiUrl: 'https://api.anthropic.com' },
      'preset-google-icon': { name: 'Google Gemini', type: 'openai', apiUrl: 'https://generativelanguage.googleapis.com' },
      'preset-zhipu-icon': { name: '智谱 GLM', type: 'openai', apiUrl: 'https://open.bigmodel.cn' },
      'preset-tencent-icon': { name: '腾讯混元', type: 'openai', apiUrl: 'https://api.hunyuan.cloud.tencent.com' },
      'preset-baidu-icon': { name: '百度千帆', type: 'openai', apiUrl: 'https://qianfan.baidubce.com' },
      'preset-moonshot-icon': { name: '月之暗面 Kimi', type: 'openai', apiUrl: 'https://api.moonshot.cn' },
      'preset-bytedance-icon': { name: '字节豆包', type: 'openai', apiUrl: 'https://ark.cn-beijing.volces.com' },
    };
    for (const [id, provider] of Object.entries(presetIcons)) {
      const el = document.getElementById(id);
      if (el) {
        const iconId = window.ModelIcons.detectProviderIcon(provider);
        el.innerHTML = window.ModelIcons.renderIconHtml(iconId, '', '28px');
        el.style.background = 'transparent';
        el.style.color = 'inherit';
        window.ModelIcons.updateIconsInContainer(el);
      }
    }
  }
}

async function loadInitialData() {
  try {
    const [config, models, systemInfo, appVersion] = await Promise.all([
      window.api.getConfig(),
      window.api.listModels(),
      window.api.getSystemInfo(),
      window.api.getAppVersion()
    ]);

    state.settings = config;
    state.models = models;
    state.currentModelId = config.currentModel;
    state.systemInfo = systemInfo;

    // 加载本地保存的聊天记录（兼容旧版格式）
    try {
      const chatResult = await window.api.loadChatHistory();
      if (chatResult.success && chatResult.data) {
        const data = chatResult.data;
        if (Array.isArray(data) && data.length > 0) {
          // 判断是新版格式 [{id, title, messages, ...}] 还是旧版格式 [{role, content, ...}]
          if (data[0].id && data[0].messages) {
            // 新版多会话格式
            state.conversations = data;
            state.activeConversationId = data[0].id;
            state.chatHistory = data[0].messages;
          } else {
            // 旧版单会话格式：转为新格式
            state.conversations = [{
              id: generateId(),
              title: '历史对话',
              messages: data,
              createdAt: data[0]?.time || Date.now(),
              updatedAt: data[data.length - 1]?.time || Date.now()
            }];
            state.activeConversationId = state.conversations[0].id;
            state.chatHistory = data;
            // 自动迁移到新格式
            saveConversations();
          }
        } else {
          // 空数据：创建默认会话
          createNewConversation();
        }
      } else {
        // 无数据：创建默认会话
        createNewConversation();
      }
    } catch (e) {
      console.warn('加载聊天记录失败:', e.message);
      createNewConversation();
    }

    // 确保会话列表已渲染（仅在已有会话数据时，createNewConversation 内部已调用）
    if (state.conversations.length > 0) {
      renderConversationList();
    }
    // 按当前激活会话恢复项目工作目录（各会话独立保存）
    if (typeof window.syncProjectFromActiveConv === 'function') window.syncProjectFromActiveConv();

    updateVersionDisplay(appVersion);
    updateSystemInfoDisplay();
    renderModelList();
    loadCloudProviders();
    loadLocalModels();
    applySettings();
    updateModelStatusBar();

    // 同步关于页面的免责声明复选框状态
    const aboutCheckbox = document.getElementById('agree-disclaimer');
    if (aboutCheckbox) aboutCheckbox.checked = state.settings.disclaimer?.accepted || false;

    // 自动选择已启用的AI提供商（如果没有活跃提供商但有已启用的提供商）
    if (!state.activeProviderId) {
      const enabledProviders = state.cloudProviders.filter(p => p.enabled);
      if (enabledProviders.length > 0) {
        state.activeProviderId = enabledProviders[0].id;
        syncAISettings();
        const ai = buildAIConfig();
        await window.api.setConfig({ ai });
        state.settings.ai = ai;
      }
    }

    updateActiveProviderDisplay();
  } catch (err) {
    console.error('加载初始数据失败:', err);
    showToast('加载失败', err.message, 'error');
  }
}

function checkDisclaimer() {
  const agreed = state.settings.disclaimer?.accepted;
  if (!agreed) {
    showDisclaimerModal(true); // blocking 模式
  }
}

// 显示免责声明弹窗
// blocking=true: 阻断模式（首次未同意/取消同意时），必须勾选才能关闭
// blocking=false: 查看模式（已同意时从关于页面点击链接），可关闭
let disclaimerEventBound = false;
function showDisclaimerModal(blocking = false) {
  const overlay = document.getElementById('disclaimer-modal-overlay');
  const agreeCheckbox = document.getElementById('disclaimer-agree');
  const confirmBtn = document.getElementById('disclaimer-confirm');
  if (!overlay || !agreeCheckbox || !confirmBtn) return;

  // 同步当前同意状态到弹窗中的复选框
  const agreed = state.settings.disclaimer?.accepted;
  agreeCheckbox.checked = agreed || false;
  confirmBtn.disabled = !agreeCheckbox.checked;
  // blocking 模式下按钮文字为"确认并开始使用"，查看模式为"确定"
  confirmBtn.textContent = blocking ? (window.I18N?.t?.('about.confirmStart') || '确认并开始使用') : (window.I18N?.t?.('btn.confirm') || '确定');

  overlay.classList.add('show');
  overlay.dataset.blocking = blocking ? '1' : '0';

  // 仅绑定一次事件，避免重复添加
  if (!disclaimerEventBound) {
    disclaimerEventBound = true;

    // 勾选复选框后启用确认按钮
    agreeCheckbox.addEventListener('change', () => {
      confirmBtn.disabled = !agreeCheckbox.checked;
    });

    // 确认按钮
    confirmBtn.addEventListener('click', async () => {
      if (!agreeCheckbox.checked) return;
      await updateDisclaimerAgreement(true);
      overlay.classList.remove('show');
      // 同步关于页面的复选框
      const aboutCheckbox = document.getElementById('agree-disclaimer');
      if (aboutCheckbox) aboutCheckbox.checked = true;
    });

    // ESC 键：blocking 模式下不关闭，查看模式下关闭
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.classList.contains('show')) {
        if (overlay.dataset.blocking === '0') {
          overlay.classList.remove('show');
        }
      }
    });

    // 点击遮罩：blocking 模式下不关闭，查看模式下关闭
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay && overlay.dataset.blocking === '0') {
        overlay.classList.remove('show');
      }
    });
  }
}

// 动态设置界面版本号（统一从 package.json 读取）
function updateVersionDisplay(version) {
  const sidebarVersion = document.getElementById('sidebar-version');
  const aboutVersion = document.getElementById('about-version');
  if (sidebarVersion) sidebarVersion.textContent = `v${version}`;
  var settingsVer = document.getElementById('settings-current-version');
  if (settingsVer) settingsVer.textContent = 'v' + version;
  if (aboutVersion) aboutVersion.textContent = `${I18N.t('about.versionPrefix')} ${version}`;
}

// ==================== 导航 ====================
function setupNavigation() {
  let lastNavClickTime = 0;
  const NAV_CLICK_COOLDOWN = 300; // 300ms内连续点击视为无效，防止快速切换卡顿

  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const now = Date.now();
      if (now - lastNavClickTime < NAV_CLICK_COOLDOWN) return;
      lastNavClickTime = now;
      const tab = item.dataset.tab;
      switchTab(tab);
    });
  });

  // ★ 监听主进程导航消息（从宠物窗口右键菜单"更换模型"等触发），自动切换到指定页面
  if (window.api && typeof window.api.on === 'function') {
    window.api.on('main:navigate', (tab) => {
      if (tab && typeof tab === 'string') {
        switchTab(tab);
      }
    });
  }
}

function switchTab(tabName) {
  state.currentTab = tabName;
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.tab === tabName));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tabName}`));

  onTabActivated(tabName);
  notifyClonePageVisibility();
}

/**
 * 桌面分身预览小窗只在「AI 对话页」展示（用户要求）。
 * 切到别的页 / 窗口被隐藏/最小化 → 通知主进程把它藏起来；
 * 注意：藏起来**不等于销毁** —— 分身在后台继续跑（托盘/面板里仍是"运行中"），
 * 真正结束只有两条路：AI 任务跑完，或用户点 ✕。
 */
function notifyClonePageVisibility() {
  try {
    const on = state.currentTab === 'chat' && document.visibilityState === 'visible';
    const api = window.api && window.api.cloneDesktop;
    if (api && typeof api.setPageVisible === 'function') api.setPageVisible(on);
    // ⚠️ 不要在这里给 .chat-container 加 padding-right 之类的"让位"样式：
    //   悬浮窗是**浮在消息上层的 overlay**（独立 HWND），不参与渲染端布局、也不占用任何区域。
    //   挤压 chat-messages 只会把聊天气泡挤窄，用户明确要求"内嵌非占用"。
  } catch (e) { /* 忽略 */ }
}

function onTabActivated(tab) {
  switch (tab) {
    case 'chat': renderConversationList(); renderChat(); break;
    case 'models': renderModelList(); break;
    case 'files': loadFileList(); break;
    case 'terminal': break;
    case 'software': loadSoftwareList(); break;
    case 'ai-config': renderAIConfig(); break;
    case 'settings': renderSettings(); break;
    case 'about': renderAboutChangelog(); break;
    case 'downloads': loadCompletedDownloads(); break;
  }
}

// ==================== 窗口控制 ====================
function setupWindowControls() {
  document.getElementById('btn-minimize').addEventListener('click', () => {
    window.api.minimize();
  });

  document.getElementById('btn-maximize').addEventListener('click', async () => {
    const isMaximized = await window.api.maximize();
    updateMaximizeIcon(isMaximized);
  });

  document.getElementById('btn-close').addEventListener('click', () => {
    window.api.closeMain();
  });

  document.getElementById('btn-show-pet').addEventListener('click', async () => {
    const r = await window.api.togglePet(true);
    if (r && r.already === 'visible') showToast('灵汐已显示', '她已经在桌面上了', 'info');
    else showToast('灵汐出现了！', '灵汐来陪你了', 'info');
  });

  document.getElementById('btn-hide-pet').addEventListener('click', async () => {
    const r = await window.api.togglePet(false);
    if (r && r.already === 'hidden') showToast('灵汐已隐藏', '她已经不在桌面上了', 'info');
    else showToast('灵汐躲起来了', '灵汐已隐藏', 'info');
  });

  // 标题栏拖拽（titlebar 已改 no-drag，改用自定义 JS 拖拽）：正常移动窗口；
  // 全屏时拖拽 → 先退出全屏还原到之前的大小，再跟随鼠标移动
  const titlebar = document.querySelector('.titlebar');
  if (titlebar) {
    titlebar.addEventListener('dblclick', (e) => {
      const target = e.target;
      if (target.closest('button, a, input, select, textarea, [role="button"], [data-action], .account-topbar, .account-top-login, .account-top-user, .window-controls')) return;
      e.preventDefault();
      window.api.maximize();
    });
  }
  setupTitlebarDrag();

  // Initialize maximize icon state
  updateMaximizeIcon();
  updateFullscreenIcon();

  // F11 切换真全屏（应用内快捷键；系统级兜底由主进程 enter/leave-full-screen 事件覆盖）
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F11') {
      e.preventDefault();
      window.api.toggleFullscreen().then((isFs) => updateFullscreenIcon(isFs));
    } else if (e.key === 'Escape') {
      // Esc 退出全屏；有弹窗打开时让位给弹窗自己的 Esc（不抢）
      const hasOverlay = document.querySelector('.modal-overlay.show, #custom-modal-overlay, .disclaimer-modal-overlay');
      if (hasOverlay) return;
      if (window.api.isFullscreen) {
        window.api.isFullscreen().then((isFs) => {
          if (isFs) window.api.toggleFullscreen(false).then(() => updateFullscreenIcon(false));
        });
      }
    }
  });
  
  // 监听窗口最大化/还原状态变化（包括拖动边缘调整大小）
  if (window.api && window.api.onWindowStateChanged) {
    window.api.onWindowStateChanged((data) => {
      if (!data) return;
      if (data.fullscreen !== undefined) {
        _mainFullscreen = !!data.fullscreen;
        document.body.classList.toggle('is-fullscreen', _mainFullscreen); // 全屏时标题栏切自定义拖拽（还原）
        updateFullscreenIcon(data.fullscreen);
        // 全屏还原完成：窗口已退出全屏。此刻锁缩放防生长，并强制把窗口设成「进入全屏前的原大小」、
        // 放到鼠标下（抓点对准光标）——纠正退出全屏瞬间可能的边缘缩放撑大
        if (data.fullscreen === false && _fsRestorePendingPlace) {
          const p = _fsRestorePendingPlace;
          _fsRestorePendingPlace = null;
          if (window.api.dragStart) { try { window.api.dragStart(); } catch (err) {} }
          if (p.bounds && window.api.setWindowBounds) {
            try { window.api.setWindowBounds({ x: p.x - p.offX, y: p.y - p.offY, width: p.bounds.width, height: p.bounds.height }); } catch (err) {}
          } else if (window.api.setWindowPosition) {
            try { window.api.setWindowPosition(p.x - p.offX, p.y - p.offY); } catch (err) {}
          }
        }
      }
      if (data.maximized !== undefined || data.fullscreen !== undefined) {
        _convMaximized = !!(data.maximized || data.fullscreen);
        if (data.maximized !== undefined) updateMaximizeIcon(data.maximized);
        // 放大/全屏 → 双侧栏强制默认展开（无论之前是否手动切换过）
        if (_convMaximized) {
          convPanels.left = true;
          convPanels.right = true;
        }
        applyConvPanelState();
      }
    });
  }

  // 手动拉伸窗口放大（非系统最大化/全屏）也视为「放大」：默认展开双侧栏、聊天区固定
  window.addEventListener('resize', () => {
    const big = window.innerWidth >= 1240;
    if (big && !_convMaximized) {
      _convMaximized = true;
      convPanels.left = true;
      convPanels.right = true;
      applyConvPanelState();
    } else if (!big && _convMaximized && !_mainFullscreen) {
      _convMaximized = false;
      applyConvPanelState();
    }
  });
}

// 模块级：主窗口当前是否全屏（onWindowStateChanged 维护，供标题栏拖拽同步判断）
let _mainFullscreen = false;
// 全屏拖拽还原：退出全屏后需等窗口真正还原完成再定位（避免定位与还原互相抢导致生长）。
// 结构 {x, y, offX, offY}：还原完成后把窗口挪到 (x-offX, y-offY)。
let _fsRestorePendingPlace = null;

// 标题栏拖拽：普通（非全屏）用原生 -webkit-app-region: drag 移动，绝不放大；
// 全屏时标题栏切 no-drag，这里处理「拖标题栏 → 退出全屏并还原到之前的大小」，
// 并用绝对定位让窗口跟随鼠标（抓点始终对准鼠标）。
// 关键：先锁缩放（避免退出全屏缩小时光标落到窗口边缘被 OS 误判成边缘缩放而生长），
// 再等窗口还原完成（onWindowStateChanged 触发 _fsRestorePendingPlace）后才开始跟随定位。
function setupTitlebarDrag() {
  const titlebar = document.querySelector('.titlebar');
  if (!titlebar || !window.api || !window.api.toggleFullscreen) return;
  const EXCLUDE = 'button, a, input, select, textarea, [role="button"], [data-action], .account-topbar, .account-top-login, .account-top-user, .window-controls';
  let drag = null;
  // 跟随移动：每一帧都用 setBounds 强制「原大小 + 鼠标位置」，让 OS 根本没机会把窗口撑大
  const placeUnderCursor = (cx, cy) => {
    if (!window.api.setWindowBounds || !drag.origW || !drag.origH) return;
    try { window.api.setWindowBounds({ x: cx - drag.grabOffX, y: cy - drag.grabOffY, width: drag.origW, height: drag.origH }); } catch (err) {}
  };
  titlebar.addEventListener('pointerdown', async (e) => {
    if (e.button !== 0) return;
    if (e.target.closest(EXCLUDE)) return;
    // 普通模式标题栏是原生 drag，pointerdown 会被原生拖拽吞掉、这里不会触发；
    // 只有全屏（no-drag）才会走到这里。
    drag = { startX: e.screenX, startY: e.screenY, moved: false, fsHandled: false, grabOffX: e.screenX, grabOffY: e.screenY };
    // 整个拖拽期间保持标题栏 no-drag（不交回原生拖拽）。注意：此处不锁缩放——
    // setFullScreen(false) 需要可缩放才能正常退出全屏并还原大小。
    document.body.classList.add('titlebar-dragging');
    // 同步记录抓点相对窗口左上角的偏移：clientX/Y 即鼠标相对窗口内容区坐标，
    // 无边框窗口下内容区=窗口，与屏幕位置/DPI/多显示器无关，最精准。
    drag.grabOffX = e.clientX;
    drag.grabOffY = e.clientY;
    // 同时记录按下时的【全屏】窗口尺寸。退出全屏后窗口会缩回进入全屏前的原大小，
    // 抓点偏移必须按「全屏尺寸 → 还原尺寸」等比换算（见下方 pointermove），
    // 否则在屏幕右侧抓取时偏移会大于还原窗口宽度，窗口被放到鼠标左边 → 鼠标脱离界面。
    drag.fsW = document.documentElement.clientWidth || window.innerWidth || 0;
    drag.fsH = document.documentElement.clientHeight || window.innerHeight || 0;
    try { e.target.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
  });
  titlebar.addEventListener('pointermove', async (e) => {
    if (!drag) return;
    const dx = e.screenX - drag.startX;
    const dy = e.screenY - drag.startY;
    if (!drag.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return; // 拖拽阈值，区分点击
    drag.moved = true;
    if (!drag.fsHandled) {
      drag.fsHandled = true;
      // 取进入全屏前的原尺寸，退出全屏后强制设回（纠正退出全屏瞬间的边缘缩放撑大）
      let bounds = null;
      if (window.api.getRestoreBounds) {
        try { bounds = await window.api.getRestoreBounds(); } catch (err) {}
      }
      if (bounds) { drag.origW = bounds.width; drag.origH = bounds.height; }
      else { drag.origW = 1100; drag.origH = 780; } // 兜底：主窗口默认尺寸

      // ★ 把抓点偏移从「全屏窗口」等比换算到「还原后的窗口」，并钳制在窗口内。
      // 全屏时抓点用的是全屏窗口内坐标（例如从顶部右侧抓取 clientX≈2400，屏幕宽 2560），
      // 但退出全屏后窗口只有 1100 宽：若不换算就直接 x = screenX - offX，窗口会被放到
      // 鼠标左侧 2400px 处，而窗口本身只有 1100 宽 → 鼠标落到窗口外面（即「鼠标脱离界面」）。
      // 等比换算可保留「抓点仍对准原来相对位置」的手感，钳制则保证任何抓取位置都不脱手。
      const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
      const EDGE = 16; // 抓点距窗口左右边缘的最小安全距离，避免贴边触发系统边缘吸附/缩放
      const sx = drag.fsW > 0 ? (drag.origW / drag.fsW) : 1;
      const sy = drag.fsH > 0 ? (drag.origH / drag.fsH) : 1;
      drag.grabOffX = clamp(Math.round(drag.grabOffX * sx), EDGE, drag.origW - EDGE);
      drag.grabOffY = clamp(Math.round(drag.grabOffY * sy), 4, drag.origH - 4);

      // 先设待定位：等 fullscreen:false 事件触发「锁缩放 + 强制原大小 + 定位」
      _fsRestorePendingPlace = { x: e.screenX, y: e.screenY, offX: drag.grabOffX, offY: drag.grabOffY, bounds };
      // 保持可缩放退出全屏：系统正常退出并还原（哪怕瞬间被边缘缩放撑大，待定位的 setBounds 会纠正）
      try { await window.api.toggleFullscreen(false); } catch (err) {}
      if (window.api.dragStart) { try { window.api.dragStart(); } catch (err) {} }
      return;
    }
    // 还原未完成前不定位（避免与还原互相抢）；完成后跟随鼠标
    if (_fsRestorePendingPlace) return;
    placeUnderCursor(e.screenX, e.screenY);
  });
  const endDrag = () => {
    if (drag) {
      drag = null;
      _fsRestorePendingPlace = null;
      document.body.classList.remove('titlebar-dragging'); // 拖拽结束，标题栏恢复原生拖拽
      if (window.api.dragEnd) { try { window.api.dragEnd(); } catch (err) {} }
    }
  };
  titlebar.addEventListener('pointerup', endDrag);
  titlebar.addEventListener('pointercancel', endDrag);
}

async function updateMaximizeIcon(isMaximized) {
  const icon = document.getElementById('maximize-icon');
  if (!icon) return;
  if (isMaximized === undefined) {
    isMaximized = await window.api.isMaximized();
  }
  const ICONS = window.ElIcons.ICONS;
  icon.innerHTML = ICONS[isMaximized ? 'restore' : 'maximize'] || ICONS.maximize;
}

async function updateFullscreenIcon(isFullscreen) {
  const icon = document.getElementById('fullscreen-icon');
  if (!icon) return;
  if (isFullscreen === undefined) {
    isFullscreen = await window.api.isFullscreen();
  }
  const ICONS = window.ElIcons.ICONS;
  icon.innerHTML = ICONS[isFullscreen ? 'exitFullscreen' : 'fullscreen'] || ICONS.fullscreen;
  const btn = document.getElementById('btn-fullscreen');
  if (btn) {
    const _t = (k, d) => (window.I18N && window.I18N.t ? window.I18N.t(k) : d);
    btn.title = isFullscreen ? _t('win.exitFullscreen', '退出全屏') : _t('win.fullscreen', '全屏');
  }
}

// ==================== 编辑器独立窗口控制（与主窗口标题栏一致，但操作 editor 窗口）====================
function setupEditorWindowControls() {
  const mini = document.getElementById('btn-minimize');
  if (mini) mini.addEventListener('click', () => window.api.editor.minimize());
  const max = document.getElementById('btn-maximize');
  if (max) max.addEventListener('click', async () => {
    const isMax = await window.api.editor.maximize();
    updateEditorMaximizeIcon(isMax);
  });
  const close = document.getElementById('btn-close');
  if (close) close.addEventListener('click', () => closeActionEditor());
  updateEditorMaximizeIcon();
}

async function updateEditorMaximizeIcon(isMax) {
  const icon = document.getElementById('maximize-icon');
  if (!icon) return;
  if (isMax === undefined) isMax = await window.api.editor.isMaximized();
  const ICONS = window.ElIcons.ICONS;
  icon.innerHTML = ICONS[isMax ? 'restore' : 'maximize'] || ICONS.maximize;
}

// 编辑器窗口引导：加载配置/模型/动作，渲染编辑器（独立窗口，无模态）
async function bootstrapEditorWindow() {
  document.body.classList.add('editor-mode');
  const params = new URLSearchParams(location.search);
  const modelId = params.get('modelId');
  const actionKey = params.get('actionKey') || '';
  const isNew = params.get('isNew') === '1';
  const isBuiltin = params.get('isBuiltin') === '1';
  try {
    const config = await window.api.getConfig();
    state.settings = config || {};
    state.activeProviderId = (config && config.ai && config.ai.activeProvider) || null;
    // 编辑器独立窗口也需同步云端提供商列表，否则下方 updateActiveProviderDisplay 找不到提供商，状态栏永远显示「AI 未连接」
    state.cloudProviders = (config && config.ai && config.ai.cloudProviders) || [];
    const lang = (config && (config.system && config.system.language)) || config.language || 'zh-CN';
    if (window.I18N && window.I18N.applyLanguage) { try { window.I18N.applyLanguage(lang); } catch (e) {} }
    // 应用主题设置（确保编辑器窗口随主程序主题切换）
    const theme = (config && config.system && config.system.theme) || 'dark';
    applyTheme(theme);
    applyAccent(config && config.system && config.system.accent);
  } catch (e) { /* 配置加载失败不影响编辑 */ }
  const model = await window.api.getModel(modelId);
  if (!model) { showToast('模型不存在', '', 'error'); return; }
  // 立即把标题栏中央替换为动作编辑标题，避免在 openActionEditor 异步完成前闪过主窗口的电脑配置
  const tEd = window.I18N?.t || ((k) => k);
  const center = document.getElementById('titlebar-center');
  if (center) {
    const titleText = (isNew ? tEd('actions.editorTitleNew') : tEd('actions.editorTitle')) + (model.name ? ' · ' + model.name : '');
    center.innerHTML = `<span class="editor-title">${escapeHtml(titleText)}</span>`;
    document.title = titleText;
  }
  // 让独立窗口的状态栏（模型名 / AI 连接状态）反映真实配置，而不是默认的占位文案
  state.models = [model];
  state.currentModelId = model.id;
  openActionEditor(model, actionKey, isNew, isBuiltin, { standalone: true });
  updateModelStatusBar();
  updateActiveProviderDisplay();

  // 编辑器窗口已打开时，主进程会发来 editor:load 让本窗口切换到另一个动作（修复「只能打开/切换一个」）
  if (IS_EDITOR_WINDOW) {
    // 监听配置更新（确保主题等设置能随主程序同步切换）
    window.api.on('init:config', (config) => {
      state.settings = config || {};
      const theme = (config && config.system && config.system.theme) || 'dark';
      applyTheme(theme);
      applyAccent(config && config.system && config.system.accent);
      const lang = (config && config.system && config.system.language) || 'zh-CN';
      if (window.I18N && window.I18N.applyLanguage) { try { window.I18N.applyLanguage(lang); } catch (e) {} }
    });
    window.api.on('editor:load', (params) => {
      const p = params || {};
      reloadEditorWindow(p.modelId, p.actionKey || '', !!p.isNew, !!p.isBuiltin);
    });
    // 主进程拦截窗口关闭(X按钮)时发来此消息，检查未保存修改
    window.api.on('editor:beforeclose', () => {
      closeActionEditor().then(() => {
        // closeActionEditor 内部：有脏数据→confirm 弹窗，用户确认才真关；无脏数据→直接关闭
        // 用户取消时 closeActionEditor 提前 return（不调 window.api.editor.close()），窗口保持打开
        // 用户确认或无脏数据时 → 已调 window.api.editor.close() → 主进程执行真正关闭
      });
    });
  }
}

// 在已打开的编辑器独立窗口内，重新载入并渲染另一个动作（新建/编辑切换）
async function reloadEditorWindow(modelId, actionKey, isNew, isBuiltin) {
  const t = window.I18N?.t || ((k) => k);
  const model = await window.api.getModel(modelId);
  if (!model) { showToast('模型不存在', '', 'error'); return; }
  state.models = [model];
  state.currentModelId = model.id;
  // 立即更新标题栏，避免切换瞬间闪过旧标题
  const center = document.getElementById('titlebar-center');
  if (center) {
    const titleText = (isNew ? t('actions.editorTitleNew') : t('actions.editorTitle')) + (model.name ? ' · ' + model.name : '');
    center.innerHTML = `<span class="editor-title">${escapeHtml(titleText)}</span>`;
    document.title = titleText;
  }
  openActionEditor(model, actionKey, isNew, isBuiltin, { standalone: true });
  updateModelStatusBar();
  updateActiveProviderDisplay();
}

// ==================== 事件监听 ====================
function setupEventListeners() {
  // 聊天发送
  // ★ 用箭头函数包一层：直接传 sendChatMessage 会把 Event 当参数传进去
  document.getElementById('btn-send').addEventListener('click', () => sendChatMessage());
  document.getElementById('btn-stop').addEventListener('click', () => {
    stopCurrentRequest();
  });
  // 文件上传入口已删除（与「选择项目」按钮重复），改为在输入框直接粘贴文件（Ctrl+V）
  const pasteInputEl = document.getElementById('chat-input');
  if (pasteInputEl) {
    pasteInputEl.addEventListener('paste', async (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      const files = [];
      for (const item of Array.from(items)) {
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length === 0) return; // 纯文本粘贴，不拦截
      e.preventDefault();
      for (const file of files) {
        await addUploadedFile(file);
      }
    });
  }
  // 拖拽上传
  const chatArea = document.getElementById('chat-messages');
  const inputArea = document.querySelector('.chat-input-area');
  let dragCounter = 0;
  const dragOverlay = document.createElement('div');
  dragOverlay.id = 'drag-overlay';
  dragOverlay.style.cssText = 'display:none;position:absolute;inset:0;background:rgba(99,102,241,0.1);border:2px dashed #6366f1;border-radius:12px;z-index:100;pointer-events:none;align-items:center;justify-content:center;font-size:16px;color:#6366f1;font-weight:600;';
  dragOverlay.textContent = '松开鼠标上传文件';
  document.querySelector('.chat-main').style.position = 'relative';
  document.querySelector('.chat-main').appendChild(dragOverlay);
  // 强制复位：计数清零 + 隐藏遮罩（任何 drop/拖拽异常结束都必须走这里）
  const hideDragOverlay = () => { dragCounter = 0; dragOverlay.style.display = 'none'; };
  // 计数只在 dragenter 上增减；dragover 会连续触发（每秒几十次），参与计数会让
  // 计数迅速膨胀，dragleave 每次只减 1，永远减不回 0 → 遮罩关不掉（旧实现的老毛病）。
  ['dragenter','dragover'].forEach(evt => {
    const isEnter = evt === 'dragenter';
    chatArea.addEventListener(evt, (e) => { e.preventDefault(); if (isEnter) dragCounter++; dragOverlay.style.display='flex'; });
    inputArea.addEventListener(evt, (e) => { e.preventDefault(); if (isEnter) dragCounter++; dragOverlay.style.display='flex'; });
  });
  ['dragleave','drop'].forEach(evt => {
    chatArea.addEventListener(evt, (e) => { e.preventDefault(); dragCounter=Math.max(0,dragCounter-1); if(dragCounter===0) dragOverlay.style.display='none'; });
    inputArea.addEventListener(evt, (e) => { e.preventDefault(); dragCounter=Math.max(0,dragCounter-1); if(dragCounter===0) dragOverlay.style.display='none'; });
  });
  // 兜底：窗口级捕获阶段监听 drop/dragend。拖图片时 multimodal-ui.js 的捕获阶段
  // drop 处理器会 stopPropagation，chatArea/inputArea 上负责复位的冒泡阶段处理器
  // 根本不会执行 → 遮罩残留。窗口捕获先于一切元素级处理运行，任何 drop 都能强制隐藏。
  window.addEventListener('drop', hideDragOverlay, true);
  window.addEventListener('dragend', hideDragOverlay, true);
  // 非图片文件的实际上传：图片拖拽已被 multimodal-ui.js 捕获阶段拦截（stopPropagation，
  // 走多模态附件），这里只会收到非图片文件。遮罩复位由上面的窗口捕获监听负责。
  chatArea.addEventListener('drop', async (e) => {
    e.preventDefault();
    for (const file of Array.from(e.dataTransfer.files)) { await addUploadedFile(file); }
  });
  inputArea.addEventListener('drop', async (e) => {
    e.preventDefault();
    for (const file of Array.from(e.dataTransfer.files)) { await addUploadedFile(file); }
  });
  // 鼠标离开窗口时也隐藏
  document.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget || e.relatedTarget.nodeName === 'HTML') {
      hideDragOverlay();
    }
  });
  // Agent 设置面板
  const settingsPanel = document.getElementById('agent-settings-panel');
  document.getElementById('btn-agent-settings').addEventListener('click', () => {
    const show = settingsPanel.style.display === 'none';
    settingsPanel.style.display = show ? 'block' : 'none';
    // 每次打开都拉一次长期记忆，保证看到的是最新内容
    if (show) loadMemories();
  });
  document.getElementById('btn-close-agent-settings').addEventListener('click', () => {
    settingsPanel.style.display = 'none';
  });
  // 项目工作目录选择：下拉菜单支持最近项目切换、打开已有项目、新建项目
  (function setupProjectPicker() {
    const projectBtn = document.getElementById('btn-select-project');
    const projectText = document.getElementById('project-picker-text');
    if (!projectBtn || !projectText) return;
    function renderProjectLabel() {
      const wd = state.workdir;
      if (wd) {
        const base = wd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || wd;
        projectText.textContent = base;
        projectBtn.title = '项目工作目录：' + wd + '\n（点击切换）';
      } else {
        projectText.textContent = '选择项目';
        projectBtn.title = '选择项目工作目录：AI 的文件读写与命令执行都在此目录内进行';
      }
    }
    function getRecentProjects() {
      try { return JSON.parse(localStorage.getItem('recentProjects')) || []; } catch (e) { return []; }
    }
    function pushRecent(wd) {
      if (!wd) return;
      let list = getRecentProjects().filter(p => p !== wd);
      list.unshift(wd);
      if (list.length > 8) list = list.slice(0, 8);
      localStorage.setItem('recentProjects', JSON.stringify(list));
    }
    function removeRecent(wd) {
      let list = getRecentProjects().filter(p => p !== wd);
      localStorage.setItem('recentProjects', JSON.stringify(list));
    }
    let workdirSetExplicitly = false;
    window.setProjectWorkdir = function (wd) {
      state.workdir = wd || '';
      workdirSetExplicitly = !!wd;
      if (wd) pushRecent(wd);
      const conv = state.conversations.find(c => c.id === state.activeConversationId);
      if (conv) {
        conv.workdir = state.workdir;
        delete state._pendingWorkdir; // conv 已就位，暂存失效（防止旧残留把别的会话“复活”回已清掉的项目）
      } else {
        // conv 暂不可用时暂存，等会话就绪后由 sync 补写
        state._pendingWorkdir = state.workdir;
      }
      saveConversations();
      renderProjectLabel();
    };
    window.syncProjectFromActiveConv = function () {
      // ★ AI 回答进行中禁止清空：流式期间任何意外的 sync 调用都不该把用户选好的
      //   项目抹回「选择项目」（用户实测：第一次选项目后在 AI 回答时自动消失）
      if (state.isStreaming && state.workdir) { renderProjectLabel(); return; }
      const conv = state.conversations.find(c => c.id === state.activeConversationId);
      // 补写暂存的 workdir
      if (conv && state._pendingWorkdir && !conv.workdir) {
        conv.workdir = state._pendingWorkdir;
        delete state._pendingWorkdir;
        saveConversations();
      }
      // 只有当 conv 中有保存的 workdir，或本次不是用户显式设置时，才同步覆盖
      if (conv && conv.workdir) {
        state.workdir = conv.workdir;
        workdirSetExplicitly = true;
      } else if (!workdirSetExplicitly) {
        state.workdir = '';
      }
      renderProjectLabel();
    };
    try { window.syncProjectFromActiveConv(); } catch (e) {}
    let dropdown = null;
    function closeDropdown() {
      if (dropdown) { dropdown.remove(); dropdown = null; }
      document.removeEventListener('click', onDocClick, true);
    }
    function onDocClick(e) {
      if (dropdown && !dropdown.contains(e.target) && e.target !== projectBtn && !projectBtn.contains(e.target)) {
        closeDropdown();
      }
    }
    function shortName(p) {
      return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
    }
    function esc(s) { return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
    function openProject(p) {
      // ★ 切换项目时自动切换到「该项目独有的聊天会话」：
      //   项目已有会话 → 激活其中最近的一个；还没有 → 新建一个会话并绑定该项目。
      //   不再停留在同一个聊天页面（原实现只改 workdir，聊天页一直不变）。
      const norm = (p || '').replace(/[\\/]+$/, '');
      const cur = state.conversations.find(c => c.id === state.activeConversationId);
      const curProject = cur && cur.workdir ? cur.workdir.replace(/[\\/]+$/, '') : '';
      if (norm && curProject !== norm) {
        const matches = state.conversations
          .filter(c => c.workdir && c.workdir.replace(/[\\/]+$/, '') === norm)
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        if (matches.length) {
          switchConversation(matches[0].id); // 内部会同步该项目工作目录并加载其消息
        } else {
          createNewConversation();           // 新建会话（内部把项目重置为未选择）
          window.setProjectWorkdir(p);       // 绑定到新项目
        }
      } else {
        window.setProjectWorkdir(p);
      }
      showToast('已切换项目', p, 'info');
      closeDropdown();
    }
    async function pickExisting() {
      closeDropdown();
      try {
        const dirs = await window.api.selectDirectory();
        if (dirs && dirs[0]) openProject(dirs[0]);
      } catch (e) {
        showToast('选择项目失败', (e && e.message) || String(e), 'error');
      }
    }
    function showNewProjectModal() {
      closeDropdown();
      // 移除旧弹窗
      const old = document.getElementById('new-project-modal');
      if (old) old.remove();
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay show';
      overlay.id = 'new-project-modal';
      overlay.innerHTML = `
        <div class="modal" style="min-width:420px;">
          <div class="modal-header">
            <h3>新建项目</h3>
            <span class="modal-close" id="npm-close">✕</span>
          </div>
          <div class="modal-body" style="padding:16px;">
            <div class="modal-form-group">
              <label>项目名称</label>
              <input type="text" id="npm-name" placeholder="输入项目名称" />
            </div>
            <div class="modal-form-group">
              <label>本地工作目录</label>
              <div style="display:flex;gap:8px;">
                <input type="text" id="npm-path" placeholder="点击右侧选择文件夹…" readonly style="flex:1;background:var(--bg-tertiary);" />
                <button class="btn btn-sm" id="npm-browse">选择…</button>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn" id="npm-cancel">取消</button>
            <button class="btn btn-primary" id="npm-ok">创建并打开</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const nameInput = overlay.querySelector('#npm-name');
      const pathInput = overlay.querySelector('#npm-path');
      nameInput.focus();
      let parentDir = '';
      function close() { overlay.remove(); }
      overlay.querySelector('#npm-close').onclick = close;
      overlay.querySelector('#npm-cancel').onclick = close;
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
      overlay.querySelector('#npm-browse').onclick = async () => {
        try {
          const dirs = await window.api.selectDirectory();
          if (dirs && dirs[0]) { parentDir = dirs[0]; pathInput.value = dirs[0]; }
        } catch (e) {}
      };
      async function submit() {
        const name = nameInput.value.trim();
        if (!name) { showToast('请输入项目名称', '', 'warning'); return; }
        if (!parentDir) { showToast('请选择存放位置', '', 'warning'); return; }
        const target = parentDir.replace(/[\\/]+$/, '') + '\\' + name;
        try {
          await window.api.createDir({ path: target });
          close();
          openProject(target);
        } catch (e) {
          showToast('新建项目失败', (e && e.message) || String(e), 'error');
        }
      }
      overlay.querySelector('#npm-ok').onclick = submit;
      nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    }
    function showDropdown() {
      if (dropdown) { closeDropdown(); return; }
      const recent = getRecentProjects();
      const current = state.workdir || '';
      dropdown = document.createElement('div');
      dropdown.className = 'project-dropdown';
      let html = '';
      if (current) {
        html += '<div class="pd-section">当前项目</div>';
        html += '<div class="pd-item pd-current" data-path="' + esc(current) + '">'
             + '<span class="el-icon">' + window.ElIcons.ICONS.folder + '</span>'
             + '<span class="pd-label">' + esc(shortName(current)) + '</span>'
             + '<span class="pd-clear" data-clear="1" title="移除当前项目">✕</span></div>';
      }
      const others = recent.filter(p => p !== current);
      if (others.length) {
        html += '<div class="pd-section">最近项目</div>';
        others.slice(0, 8).forEach(p => {
          html += '<div class="pd-item" data-path="' + esc(p) + '">'
               + '<span class="el-icon">' + window.ElIcons.ICONS.folder + '</span>'
               + '<span class="pd-label" title="' + esc(p) + '">' + esc(shortName(p)) + '</span></div>';
        });
      }
      if (current || others.length) {
        html += '<div class="pd-divider"></div>';
      }
      html += '<div class="pd-item pd-action" data-act="open"><span class="el-icon">' + window.ElIcons.ICONS.folderPlus + '</span>从本地文件夹创建…</div>';
      html += '<div class="pd-item pd-action" data-act="new"><span class="el-icon">' + window.ElIcons.ICONS.plusSimple + '</span>新建项目…</div>';
      dropdown.innerHTML = html;
      const rect = projectBtn.getBoundingClientRect();
      dropdown.style.position = 'fixed';
      dropdown.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
      dropdown.style.left = Math.min(rect.left, window.innerWidth - 260) + 'px';
      document.body.appendChild(dropdown);
      setTimeout(() => document.addEventListener('click', onDocClick, true), 0);
      dropdown.querySelectorAll('.pd-item').forEach(item => {
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          const clear = item.querySelector('[data-clear="1"]');
          if (clear && clear.contains(e.target)) {
            removeRecent(current);
            window.setProjectWorkdir('');
            showToast('已移除当前项目', '', 'info');
            closeDropdown();
            return;
          }
          const act = item.dataset.act;
          if (act === 'open') return pickExisting();
          if (act === 'new') return showNewProjectModal();
          const p = item.dataset.path;
          if (p) openProject(p);
        });
      });
    }
    projectBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showDropdown();
    });
  })();
  // 工作/聊天模式切换：聊天模式纯对话（隐藏项目选择），工作模式带工具和项目目录
  (function setupModeToggle() {
    const modeBtn = document.getElementById("btn-mode-toggle");
    const modeIcon = document.getElementById("mode-toggle-icon");
    const projBtn = document.getElementById("btn-select-project");
    const agentCheckbox = document.getElementById("agent-mode");
    if (!modeBtn || !modeIcon) return;
    function applyMode() {
      const isWork = agentCheckbox ? agentCheckbox.checked : false;
      // 聊天模式用对话气泡图标，工作模式用机器人图标
      const ICONS = window.ElIcons.ICONS;
      modeIcon.innerHTML = isWork ? ICONS.computer : ICONS.chat;
      modeBtn.classList.toggle("work-mode", isWork);
      modeBtn.title = isWork ? "工作模式：带工具调用和项目目录（点击切换到聊天）" : "聊天模式：纯对话（点击切换到工作）";
      if (projBtn) projBtn.style.display = isWork ? "" : "none";
    }
    modeBtn.addEventListener("click", () => {
      if (agentCheckbox) {
        agentCheckbox.checked = !agentCheckbox.checked;
        agentCheckbox.dispatchEvent(new Event("change"));
      }
      applyMode();
    });
    if (agentCheckbox) agentCheckbox.addEventListener("change", applyMode);
    setTimeout(applyMode, 100);
  })();
  document.addEventListener('click', (e) => {
    const settingsBtn = document.getElementById('btn-agent-settings');
    if (settingsPanel.style.display === 'block'
        && !settingsPanel.contains(e.target)
        && !settingsBtn.contains(e.target)) {
      settingsPanel.style.display = 'none';
    }
  });
  // Agent 设置持久化
  // v2：工具清单改为从主进程动态获取，旧版本只存了 5 个工具，会把 web_search 等关键工具
  // 永久排除在外（表现为"模型想用工具但没有工具可调"）。升 key 让旧存档自然失效，全部工具默认启用。
  function saveAgentSettings() {
    const settings = {
      agentMode: document.getElementById('agent-mode')?.checked || false,
      streamMode: document.getElementById('stream-mode')?.checked || false,
      thinkMode: document.getElementById('agent-think-mode')?.checked || false,
      toolConfirm: document.getElementById('agent-tool-confirm')?.checked !== false, // 默认开启
      autoCompress: document.getElementById('agent-auto-compress')?.checked === true, // 默认关闭
      enabledTools: Array.from(document.querySelectorAll('.agent-tool-check:checked')).map(cb => cb.value)
    };
    localStorage.setItem(AGENT_SETTINGS_KEY, JSON.stringify(settings));
  }
  function loadAgentSettings() {
    try {
      const saved = localStorage.getItem(AGENT_SETTINGS_KEY);
      if (!saved) return;
      const settings = JSON.parse(saved);
      const agentModeEl = document.getElementById('agent-mode');
      const streamModeEl = document.getElementById('stream-mode');
      const thinkModeEl = document.getElementById('agent-think-mode');
      const toolConfirmEl = document.getElementById('agent-tool-confirm');
      const autoCompressEl = document.getElementById('agent-auto-compress');
      if (agentModeEl) agentModeEl.checked = !!settings.agentMode;
      if (streamModeEl) streamModeEl.checked = settings.streamMode !== false;
      if (thinkModeEl) thinkModeEl.checked = !!settings.thinkMode;
      if (toolConfirmEl) toolConfirmEl.checked = settings.toolConfirm !== false;
      if (autoCompressEl) autoCompressEl.checked = settings.autoCompress !== false;
      if (Array.isArray(settings.enabledTools)) {
        document.querySelectorAll('.agent-tool-check').forEach(cb => {
          cb.checked = settings.enabledTools.includes(cb.value);
        });
      }
    } catch(e) { console.warn('加载Agent设置失败:', e); }
  }
  // 暴露给外部：工具清单是异步渲染的，渲染完需要重新套用勾选状态
  applyAgentSettings = loadAgentSettings;
  onAgentToolToggle = saveAgentSettings;
  loadAgentSettings();
  // 监听设置变化自动保存
  ['agent-mode', 'stream-mode', 'agent-think-mode', 'agent-tool-confirm', 'agent-auto-compress'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => {
      saveAgentSettings();
      // Agent 模式会额外占用工具定义等开销；自动压缩开关会影响弹窗里的状态显示
      renderContextBar();
    });
  });
  document.querySelectorAll('.agent-tool-check').forEach(cb => {
    cb.addEventListener('change', saveAgentSettings);
  });
  // 工具执行确认弹窗
  const toolConfirmModal = document.getElementById('tool-confirm-modal');
  document.getElementById('confirm-tool-allow').addEventListener('click', () => {
    toolConfirmModal.style.display = 'none';
    window.api.confirmToolResponse(true);
  });
  document.getElementById('confirm-tool-deny').addEventListener('click', () => {
    toolConfirmModal.style.display = 'none';
    window.api.confirmToolResponse(false);
  });
  document.getElementById('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  // 语音按钮：按住说话，松开识别（渲染进程采集 PCM → WAV，主进程 SAPI 识别）
  const voiceBtn = document.getElementById('btn-voice');
  voiceBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    console.log('[Voice] pointerdown 触发');
    try {
      startVoiceCapture();
    } catch(err) {
      console.error('[Voice] startVoiceCapture异常:', err);
    }
  });
  voiceBtn.addEventListener('pointerup', (e) => {
    e.preventDefault();
    e.stopPropagation();
    try { stopVoiceCapture(); } catch(err) { console.error('[Voice] stopVoiceCapture异常:', err); }
  });
  voiceBtn.addEventListener('pointerleave', () => {
    try { if (voiceRec && voiceRec.recording) stopVoiceCapture(); } catch(e) {}
  });
  voiceBtn.addEventListener('pointercancel', () => {
    try { if (voiceRec && voiceRec.recording) stopVoiceCapture(); } catch(e) {}
  });
  voiceBtn.addEventListener('contextmenu', (e) => e.preventDefault());

  // 清空当前会话
  document.getElementById('btn-clear-chat').addEventListener('click', async () => {
    const conv = getActiveConversation();
    if (!conv) return;
    conv.messages = [];
    state.chatHistory = [];
    setCompressNotice(null);
  state.uploadedFiles = [];
  state.currentRoleId = 'general'; // 当前智能体角色
  state.agentRoles = []; // 角色列表
  state.agentTools = []; // 主进程注册的全部工具（单一数据源，避免前端硬编码遗漏）
    conv.updatedAt = Date.now();
    saveConversations();
    renderChat();
    showToast('会话已清空', '', 'info');
  });

  // 新建会话
  document.getElementById('btn-new-chat').addEventListener('click', () => {
    createNewConversation();
    showToast('已创建新会话', '', 'info');
  });

  // 上下文环形指示：悬停看用量（title），点击看明细（弹窗内含"立即压缩"）
  const ctxBarEl = document.getElementById('ctx-bar');
  if (ctxBarEl) {
    ctxBarEl.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleContextPopup();
    });
    ctxBarEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleContextPopup(); }
    });
  }
  // 点击别处关闭明细弹窗
  document.addEventListener('click', (e) => {
    const popup = document.getElementById('ctx-popup');
    if (!popup || popup.style.display === 'none') return;
    if (popup.contains(e.target)) return;
    if (ctxBarEl && ctxBarEl.contains(e.target)) return;
    popup.style.display = 'none';
  });
  // 输入框内容变化会影响"待发送"的估算，做防抖刷新
  const chatInputEl = document.getElementById('chat-input');
  if (chatInputEl) {
    let ctxRefreshTimer = null;
    chatInputEl.addEventListener('input', () => {
      if (ctxRefreshTimer) clearTimeout(ctxRefreshTimer);
      ctxRefreshTimer = setTimeout(() => renderContextBar(), 300);
    });
  }
  primeContextMeta();
  renderContextBar();

  // 历史会话弹窗
  document.getElementById('btn-history-conv')?.addEventListener('click', () => openHistoryModal());
  document.getElementById('history-modal-close')?.addEventListener('click', closeHistoryModal);
  document.getElementById('history-conv-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'history-conv-modal') closeHistoryModal();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeHistoryModal(); closeArchivedModal(); } });
  // 左右侧栏：初始收起、消息占满；开关按钮独立切换
  applyConvPanelState();
  const _tLeft = document.getElementById('conv-toggle-left');
  const _tRight = document.getElementById('conv-toggle-right');
  if (_tLeft) _tLeft.addEventListener('click', () => toggleConvPanel('left'));
  if (_tRight) _tRight.addEventListener('click', () => { toggleConvPanel('right'); if (convPanels.right) renderConvAssets(); });
  // 已归档内容（系统设置 → 功能）
  document.getElementById('open-archived-detail')?.addEventListener('click', () => openArchivedModal());
  document.getElementById('open-archived-detail')?.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openArchivedModal(); } });
  document.getElementById('btn-archived-close')?.addEventListener('click', closeArchivedModal);
  document.getElementById('archived-modal')?.addEventListener('click', (e) => { if (e.target.id === 'archived-modal') closeArchivedModal(); });
  // 删除历史会话
  document.getElementById('btn-delete-conv').addEventListener('click', async () => {
    const conv = getActiveConversation();
    if (!conv) return;
    const confirmed = await showConfirm({
      type: 'warning',
      title: '删除会话',
      message: `确定要删除会话「${conv.title}」吗？`,
      detail: '此操作不可恢复，会话中的所有消息将被永久删除。'
    });
    if (confirmed) {
      deleteConversation(conv.id);
      showToast('会话已删除', '', 'info');
    }
  });

  // AI模型选择（走统一入口：校验 + 持久化 + 同步各选择器与状态灯）
  document.getElementById('chat-provider').addEventListener('change', async (e) => {
    await setActiveProvider(e.target.value || null, { toast: null });
    // 换模型会改变上下文窗口与预留输出，容量条要跟着刷新
    renderContextBar();
  });

  // 模型管理
  document.getElementById('btn-import-model').addEventListener('click', importModelFile);
  document.getElementById('btn-import-model-dir').addEventListener('click', importModelDirectory);

  // BongoCat 专用
  const btnLaunchBongo = document.getElementById('btn-launch-bongocat');
  const btnBongoPath = document.getElementById('btn-bongocat-path');
  if (btnLaunchBongo) btnLaunchBongo.addEventListener('click', launchBongocatWindow);
  if (btnBongoPath) btnBongoPath.addEventListener('click', setBongocatPath);
  // 加载时更新BongoCat状态
  updateBongocatStatus();

  // 文件管理
  document.getElementById('btn-back').addEventListener('click', () => {
    if (state.currentPath) {
      const parent = window.api.path.dirname(state.currentPath);
      state.currentPath = parent;
      loadFileList();
    }
  });
  document.getElementById('btn-home').addEventListener('click', () => {
    state.currentPath = '';
    loadFileList();
  });
  document.getElementById('btn-new-folder').addEventListener('click', createNewFolder);
  document.getElementById('btn-upload-file').addEventListener('click', uploadFile);
  document.getElementById('file-search').addEventListener('input', debounce(searchFiles, 300));

  // 文件视图切换
  document.getElementById('view-list').addEventListener('click', () => {
    document.getElementById('view-list').classList.add('active');
    document.getElementById('view-grid').classList.remove('active');
    document.getElementById('file-list').classList.remove('grid-view');
    renderFileList(state.fileTree);
  });
  document.getElementById('view-grid').addEventListener('click', () => {
    document.getElementById('view-grid').classList.add('active');
    document.getElementById('view-list').classList.remove('active');
    document.getElementById('file-list').classList.add('grid-view');
    renderFileList(state.fileTree);
  });

  // 终端
  document.getElementById('btn-exec-cmd').addEventListener('click', executeCommand);
  document.getElementById('terminal-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') executeCommand();
  });
  document.getElementById('btn-clear-terminal').addEventListener('click', () => {
    document.getElementById('terminal-output').innerHTML = '';
  });

  // 软件管理
  // ★ 刷新按钮强制重新扫描（绕过缓存），进入页面时使用缓存
  document.getElementById('btn-refresh-software').addEventListener('click', () => loadSoftwareList(true));
  document.getElementById('btn-install-software').addEventListener('click', installSoftware);
  document.getElementById('software-search').addEventListener('input', debounce(filterSoftware, 300));

  // 初始化高级信息提示框
  if (typeof initInfoTips === 'function') initInfoTips();

  // AI配置
  document.getElementById('btn-add-local-model').addEventListener('click', addLocalModel);
  const btnAddLocalModelDir = document.getElementById('btn-add-local-model-dir');
  if (btnAddLocalModelDir) btnAddLocalModelDir.addEventListener('click', addLocalModelDirectory);
  const btnRefreshTools = document.getElementById('btn-refresh-tools');
  if (btnRefreshTools) btnRefreshTools.addEventListener('click', renderTools);
  // 添加提供商按钮已从UI移除，保留函数供其他地方调用
  const btnAddCloud = document.getElementById('btn-add-cloud');
  if (btnAddCloud) btnAddCloud.addEventListener('click', addCloudProvider);
  document.getElementById('temperature').addEventListener('input', (e) => {
    document.getElementById('temperature-value').textContent = e.target.value;
  });
  document.getElementById('max-tokens').addEventListener('change', saveAISettings);
  // 最大Token 自定义步进器
  const maxTokensInput = document.getElementById('max-tokens');
  document.getElementById('max-tokens-increase').addEventListener('click', () => {
    const step = parseInt(maxTokensInput.step) || 128;
    const max = parseInt(maxTokensInput.max) || 128000;
    const val = Math.min(parseInt(maxTokensInput.value) + step, max);
    maxTokensInput.value = val;
    saveAISettings();
  });
  document.getElementById('max-tokens-decrease').addEventListener('click', () => {
    const step = parseInt(maxTokensInput.step) || 128;
    const min = parseInt(maxTokensInput.min) || 1;
    const val = Math.max(parseInt(maxTokensInput.value) - step, min);
    maxTokensInput.value = val;
    saveAISettings();
  });
  // 系统提示词输入框已挪到「设置 → 功能设置 → 个性化」，这里不再绑定
  // 上下文窗口（空/0 = 按模型名自动识别，具体口径见标签的提示气泡）
  const contextWindowInput = document.getElementById('context-window');
  if (contextWindowInput) {
    contextWindowInput.addEventListener('change', () => {
      saveAISettings();
      renderContextBar();
    });
    document.getElementById('context-window-decrease')?.addEventListener('click', () => {
      const step = parseInt(contextWindowInput.step) || 1024;
      const min = parseInt(contextWindowInput.min) || 0;
      const val = Math.max((parseInt(contextWindowInput.value) || 0) - step, min);
      contextWindowInput.value = val > 0 ? val : ''; // 0 显示为 placeholder「自动」
      saveAISettings();
      renderContextBar();
    });
    document.getElementById('context-window-increase')?.addEventListener('click', () => {
      const step = parseInt(contextWindowInput.step) || 1024;
      const max = parseInt(contextWindowInput.max) || 2000000;
      contextWindowInput.value = Math.min((parseInt(contextWindowInput.value) || 0) + step, max);
      saveAISettings();
      renderContextBar();
    });
  }
  document.getElementById('active-provider').addEventListener('change', (e) => {
    state.activeProviderId = e.target.value || null;
    saveAISettings();
    updateMaxTokensVisibility();
    renderContextBar();
    // 切换AI模型服务时，自动刷新下方页面（聊天页面的模型选择器、状态显示、图标等）
    updateActiveProviderDisplay();
    // 刷新提供商列表，确保当前选中状态正确显示
    renderCloudProviders();
  });

  // 设置 - 仅针对设置面板内的开关
  document.getElementById('pet-size').addEventListener('input', (e) => {
    document.getElementById('pet-size-value').textContent = (e.target.value * 100).toFixed(0) + '%';
  });
  document.getElementById('pet-size').addEventListener('change', () => saveSettings());
  document.getElementById('pet-opacity').addEventListener('input', (e) => {
    document.getElementById('pet-opacity-value').textContent = (e.target.value * 100).toFixed(0) + '%';
  });
  document.getElementById('pet-opacity').addEventListener('change', () => saveSettings());
  // ★ 透明度重置按钮：一键恢复默认透明度（0），解决设置后无法回到最初默认值的问题
  const btnResetOpacity = document.getElementById('btn-reset-opacity');
  if (btnResetOpacity) {
    btnResetOpacity.addEventListener('click', async () => {
      const opacityEl = document.getElementById('pet-opacity');
      if (opacityEl) {
        opacityEl.value = 0;
        document.getElementById('pet-opacity-value').textContent = '0%';
      }
      // 重置 lastSentPetSettings，确保新设置被发送到主进程
      lastSentPetSettings = null;
      await saveSettings();
      if (window.showToast) window.showToast('已恢复默认', '透明度已重置为 0%', 'success');
    });
  }

  // 桌宠外观 - 色彩调节（饱和度/亮度/色相）
  const colSatEl = document.getElementById('pet-col-sat');
  const colBriEl = document.getElementById('pet-col-bri');
  const colHueEl = document.getElementById('pet-col-hue');
  if (colSatEl) {
    colSatEl.addEventListener('input', (e) => { document.getElementById('pet-col-sat-value').textContent = parseFloat(e.target.value).toFixed(2); });
    colSatEl.addEventListener('change', () => saveSettings());
  }
  if (colBriEl) {
    colBriEl.addEventListener('input', (e) => { document.getElementById('pet-col-bri-value').textContent = parseFloat(e.target.value).toFixed(2); });
    colBriEl.addEventListener('change', () => saveSettings());
  }
  if (colHueEl) {
    colHueEl.addEventListener('input', (e) => { document.getElementById('pet-col-hue-value').textContent = e.target.value + '°'; });
    colHueEl.addEventListener('change', () => saveSettings());
  }

  document.getElementById('pet-framerate').addEventListener('change', () => saveSettings());

  // 桌宠外观 - 渲染倍率（同时影响模型和键盘叠加层清晰度，立即生效）
  const renderScaleEl = document.getElementById('pet-render-scale');
  if (renderScaleEl) {
    renderScaleEl.addEventListener('input', (e) => {
      document.getElementById('pet-render-scale-value').textContent = parseFloat(e.target.value).toFixed(1) + 'x';
    });
    renderScaleEl.addEventListener('change', () => {
      const scale = parseFloat(renderScaleEl.value);
      if (window.api && typeof window.api.setPetRenderScale === 'function') {
        window.api.setPetRenderScale(scale);
      }
      saveSettings();
    });
  }
  document.getElementById('btn-reset-pet').addEventListener('click', resetPetDisplay);

  // 仅监听设置面板内的开关，避免捕获其他面板（如流式输出）的开关
  const settingsSwitches = document.querySelectorAll('#tab-settings .switch-toggle input');
  settingsSwitches.forEach(input => {
    if (input.dataset.personalize === '1') return; // 个性化/记忆开关走 savePersonalization
    input.addEventListener('change', () => saveSettings());
  });

  // ===== 功能设置：记忆 + 个性化（2026-10-03）=====
  ['memory-enabled', 'memory-auto-record', 'memory-evolve'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', async () => { await savePersonalization(); });
  });
  const styleSel = document.getElementById('reply-style-selector');
  if (styleSel) {
    styleSel.querySelectorAll('.style-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        styleSel.querySelectorAll('.style-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        await savePersonalization();
        showToast('回复风格已切换', '下次对话开始生效', 'success');
      });
    });
  }
  ['persona-name', 'persona-role', 'custom-instructions'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => { savePersonalization(); });
  });
  // 自定义指令（大）：实时字数
  const ciEl = document.getElementById('custom-instructions');
  if (ciEl) ciEl.addEventListener('input', () => updateCharCounter('custom-instructions'));
  // 人格设定 / AI 系统提示词（小）：单行预览，点击弹窗编辑
  ['persona-desc', 'personal-system-prompt'].forEach(id => {
    const row = document.getElementById(id + '-row');
    if (!row) return;
    const open = () => openSmallEditor(id);
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  });
  bindSmallTextEditor();
  const sysRestore = document.getElementById('sysprompt-restore');
  if (sysRestore) {
    sysRestore.addEventListener('click', async () => {
      const ta = document.getElementById('personal-system-prompt');
      if (ta) {
        ta.value = DEFAULT_PERSONA_PROMPT;
        updateSmallPreview('personal-system-prompt');
      }
      await savePersonalization();
      showToast('已恢复默认', '系统提示词已还原为内置默认', 'success');
    });
  }
  const gotoPers = document.getElementById('goto-personalization');
  if (gotoPers) {
    gotoPers.addEventListener('click', () => {
      switchTab ? switchTab('settings') : (document.querySelector('.nav-item[data-tab="settings"]') || {}).click?.();
      setTimeout(() => {
        const ov = document.getElementById('personalization-modal-overlay');
        if (ov) ov.classList.add('show');
      }, 150);
    });
  }

  // 功能：记忆 / 个性化 两个独立弹窗入口
  function bindDetailModal(openBtnId, overlayId, closeBtnId) {
    const overlay = document.getElementById(overlayId);
    if (!overlay) return;
    const openBtn = document.getElementById(openBtnId);
    if (openBtn) {
      const open = () => overlay.classList.add('show');
      openBtn.addEventListener('click', open);
      openBtn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    }
    const closeBtn = document.getElementById(closeBtnId);
    if (closeBtn) {
      closeBtn.addEventListener('click', () => overlay.classList.remove('show'));
    }
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.remove('show');
    });
  }
  bindDetailModal('open-memory-detail', 'memory-modal-overlay', 'memory-modal-close');
  bindDetailModal('open-personalization-detail', 'personalization-modal-overlay', 'personalization-modal-close');
  const memSearch = document.getElementById('memory-search');
  if (memSearch) {
    let t = null;
    memSearch.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => loadMemoryPanel(), 220);
    });
  }
  const memRefresh = document.getElementById('memory-refresh');
  if (memRefresh) memRefresh.addEventListener('click', () => loadMemoryPanel());
  const memClear = document.getElementById('memory-clear-all');
  if (memClear) {
    memClear.addEventListener('click', async () => {
      if (!window.confirm('确定清空当前作用域的全部长期记忆？此操作不可撤销。')) return;
      await window.api.memory.clear(state.workdir || '');
      showToast('已清空', '长期记忆已全部删除', 'success');
      await loadMemoryPanel();
    });
  }
  const evoRefresh = document.getElementById('evolution-refresh');
  if (evoRefresh) {
    evoRefresh.addEventListener('click', async () => {
      const r = await window.api.evolution.profile();
      const box = document.getElementById('evolution-profile');
      if (box && r && r.content) box.textContent = r.content;
      showToast('已生成', '习惯画像已更新', 'success');
      await loadEvolutionPanel();
    });
  }
  const evoClear = document.getElementById('evolution-clear');
  if (evoClear) {
    evoClear.addEventListener('click', async () => {
      if (!window.confirm('确定清空全部近期动向记录？此操作不可撤销。')) return;
      await window.api.evolution.clear();
      showToast('已清空', '近期动向记录已删除', 'success');
      await loadEvolutionPanel();
    });
  }

  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      saveSettings();
    });
  });
  document.querySelectorAll('.accent-dot').forEach(dot => {
    dot.addEventListener('click', () => {
      document.querySelectorAll('.accent-dot').forEach(d => d.classList.remove('active'));
      dot.classList.add('active');
      applyAccent(dot.dataset.accent);
      saveSettings();
    });
  });
  document.getElementById('language').addEventListener('change', async () => {
    await saveSettings();
    // 实时切换语言，无需重启
    const lang = document.getElementById('language').value;
    if (window.I18N && window.I18N.applyLanguage) {
      window.I18N.applyLanguage(lang);
    }
    // 重新渲染依赖语言的动态内容
    renderModelList();
    renderAIConfig();
    updateModelStatusBar();
    const desc = lang === 'en-US' ? 'Switched to English' : '已切换至中文';
    showToast(window.I18N?.t?.('toast.langSaved') || '语言设置已保存', desc, 'info');
  });
  document.getElementById('btn-reset-config').addEventListener('click', resetConfig);
  document.getElementById('btn-export-config').addEventListener('click', exportConfig);
  document.getElementById('btn-import-config').addEventListener('click', importConfig);

  // 系统外观（Windows only）—— 任务栏 + 开始菜单各自独立设置，无总开关
  // XAML TAP 方案：注入 aiLobsterTap.dll，修改 XAML 视觉树元素的 Opacity
  // 可选效果：默认(系统原生) / 透明 / 模糊 / 亚克力 —— 「默认」即把 Opacity 还原为 1.0

  const tbEffectSelect = document.getElementById('taskbar-effect-select');
  const smEffectSelect = document.getElementById('startmenu-effect-select');

  // 任务栏效果选择变化：即选即用，无需总开关
  if (tbEffectSelect) {
    tbEffectSelect.addEventListener('change', async () => {
      if (!window.api || !window.api.taskbarApplyEffect) return;

      const effect = tbEffectSelect.value;
      try {
        const r = await window.api.taskbarApplyEffect(effect);
        if (r && r.ok) {
          const cfg = await window.api.getConfig();
          cfg.taskbar = cfg.taskbar || {};
          cfg.taskbar.effect = effect;
          await window.api.saveConfig(cfg);
          // 任务栏效果为「默认」时，弹层同步开关没有可同步的效果 → 全部置灰
          for (const key of ['notification', 'overflow', 'quicksettings']) {
            const toggle = document.getElementById('flyout-sync-' + key);
            if (toggle) toggle.disabled = (effect === 'normal');
          }
        } else {
          showToast('切换失败', (r && r.error) || '未知错误', 'error');
        }
      } catch (e) {
        showToast('切换失败', e.message, 'error');
      }
    });
  }

  // 开始菜单效果选择变化：即选即用，与任务栏互不影响
  if (smEffectSelect) {
    smEffectSelect.addEventListener('change', async () => {
      if (!window.api || !window.api.startMenuApplyEffect) return;

      const effect = smEffectSelect.value;
      try {
        const r = await window.api.startMenuApplyEffect(effect);
        if (r && r.ok) {
          const cfg = await window.api.getConfig();
          cfg.startMenu = cfg.startMenu || {};
          cfg.startMenu.effect = effect;
          await window.api.saveConfig(cfg);
        } else {
          showToast('切换失败', (r && r.error) || '未知错误', 'error');
        }
      } catch (e) {
        showToast('切换失败', e.message, 'error');
      }
    });
  }

  // 弹出窗口/通知同步任务栏效果开关：只影响弹层（通知中心/托盘溢出/快速设置/跳转列表等），
  // 关闭后弹层立即还原为系统原生外观，任务栏本身的效果不变
  // 弹出窗口/通知同步任务栏效果：二级独立开关（每个弹层目标单独开启/还原）。
  // 右键菜单（任务栏右键）受系统限制不支持透明（SCA 在 26200 上会合成灰底、TAP 不可见），
  // 保持系统原生外观，「托盘弹窗」开关只管托盘溢出面板本体。
  const FLYOUT_SYNC_ITEMS = [
    { key: 'notification', id: 'flyout-sync-notification', name: '通知中心' },
    { key: 'overflow', id: 'flyout-sync-overflow', name: '托盘弹窗' },
    { key: 'quicksettings', id: 'flyout-sync-quicksettings', name: '快速设置' }
  ];
  for (const item of FLYOUT_SYNC_ITEMS) {
    const toggle = document.getElementById(item.id);
    if (!toggle) continue;
    toggle.addEventListener('change', async () => {
      if (!window.api || !window.api.taskbarSetFlyoutSync) return;
      try {
        const r = await window.api.taskbarSetFlyoutSync(item.key, toggle.checked);
        if (r && r.ok) {
          showToast(
            toggle.checked ? `已开启${item.name}同步` : `已关闭${item.name}同步`,
            toggle.checked ? `${item.name}将跟随任务栏效果` : `${item.name}将保持系统原生外观`,
            'success'
          );
        } else {
          toggle.checked = !toggle.checked;   // 失败回滚 UI
          showToast('设置失败', (r && r.error) || '未知错误', 'error');
        }
      } catch (e) {
        toggle.checked = !toggle.checked;
        showToast('设置失败', e.message, 'error');
      }
    });
  }

  // 免责声明：勾选/取消勾选
  document.getElementById('agree-disclaimer').addEventListener('change', async (e) => {
    if (e.target.checked) {
      // 勾选同意
      await updateDisclaimerAgreement(true);
    } else {
      // 取消同意：保存取消状态，弹出阻断弹窗要求重新同意
      await updateDisclaimerAgreement(false);
      e.target.checked = true; // 恢复UI勾选状态，等弹窗中操作
      showDisclaimerModal(true); // blocking 模式
    }
  });

  // 免责声明链接：点击打开弹窗查看
  document.getElementById('disclaimer-link').addEventListener('click', (e) => {
    e.preventDefault();
    const agreed = state.settings.disclaimer?.accepted;
    showDisclaimerModal(!agreed); // 如果未同意则 blocking
  });

  // 模态框关闭：仅通过 × 按钮或页脚按钮关闭；【不响应点击空白处】，
  // 避免误触丢失表单输入（程序规范：弹窗必须显式操作才能关闭）
  document.getElementById('modal-close').addEventListener('click', () => {
    // 动作编辑器模态（带 .ae-modal 标记）：关闭前走脏检查 + 自制确认弹窗；其余模态直接关闭
    const modalEl = document.getElementById('modal');
    if (modalEl && modalEl.classList.contains('ae-modal')) { closeActionEditor(); }
    else { closeModal(); }
  });
}

function setupIpcListeners() {
  // 编辑器独立窗口：不需要主窗口的各类 UI 广播（避免操作不存在的 DOM）
  if (IS_EDITOR_WINDOW) return;
  window.api.on('init:config', (config) => {
    state.settings = config;
    // 同步语言设置
    const lang = config.system?.language || 'zh-CN';
    if (window.I18N && window.I18N.applyLanguage) {
      window.I18N.applyLanguage(lang);
    }
    const langSelect = document.getElementById('language');
    if (langSelect) langSelect.value = lang;
  });

  window.api.on('init:models', (models) => {
    state.models = models;
    renderModelList();
  });

  window.api.on('init:system-info', (info) => {
    state.systemInfo = info;
    updateSystemInfoDisplay();
  });

  window.api.on('model:changed', (modelInfo) => {
    if (modelInfo === null) {
      // 恢复默认模型
      state.currentModelId = null;
      renderModelList();
      updateModelStatusBar();
      showToast('已恢复默认', '灵汐恢复默认造型！', 'success');
    } else {
      // 兼容：modelInfo 可能是完整对象或纯 id 字符串
      const modelId = typeof modelInfo === 'string' ? modelInfo : modelInfo?.id;
      state.currentModelId = modelId;
      renderModelList();
      updateModelStatusBar();
      showToast('模型已切换', '灵汐换装成功！', 'success');
    }
  });

  // 编辑器独立窗口保存后，刷新主窗口当前展示的模型详情（若匹配）
  window.api.on('model:actions-changed', (modelId) => {
    if (currentShownModel && currentShownModel.id === modelId) {
      showModelInfo(currentShownModel);
    }
  });

  window.api.on('ai:response', (data) => {
    // 检查该响应是否属于当前活跃会话，如果不是则忽略（防止删除会话后响应被带到新会话）
    if (state.activeRequestConversationId && state.activeRequestConversationId !== state.activeConversationId) {
      console.log('[AI] 忽略不属于当前会话的AI响应，请求会话:', state.activeRequestConversationId, '当前会话:', state.activeConversationId);
      return;
    }
    // Agent 模式事件处理（仅当元素还在 DOM 中）
    if (state.agentState && state.agentState.currentMsgEl && state.agentState.currentMsgEl.isConnected) {
      const el = state.agentState.currentMsgEl;
      if (data.type === 'agent-reasoning') {
        hideAgentWaiting(el); // 下一轮思考开始 → 撤掉"等待模型响应"占位
        // 脱敏：模型思考里可能直呼内部函数名（ensure_clone_desktop 等），统一换成中文名
        const thinkText = desensitizeToolText(data.text || '');
        state.agentState.reasoning += thinkText;
        // 思考被别的步骤打断过 → 开新思考步（保证时间顺序）
        const rec = ensureAgentStep(el, 'think');
        if (rec) {
          rec.text += thinkText;
          // ★ 思考流同样节流：chunk 只累积，90ms 合并刷新 textContent（原来每 chunk 全量重写）
          if (!rec._thinkTimer) {
            rec._thinkTimer = setTimeout(() => {
              rec._thinkTimer = null;
              const c = rec.el && rec.el.isConnected ? rec.el.querySelector('.agent-reasoning-content') : null;
              if (c) c.textContent = rec.text;
            }, AGENT_TEXT_RENDER_MS);
          }
          const toggle = rec.el.querySelector('.reasoning-toggle');
          if (toggle) toggle.style.transform = 'rotate(90deg)';
        }
        // 思考一开始就把「等待模型响应」占位撤掉（真实内容马上接管）
        dropAgentPlaceholder(el);
        scrollChatToBottomIfNeeded();
      } else if (data.type === 'agent-content') {
        hideAgentWaiting(el); // 下一段正文开始 → 撤掉占位
        // 开始输出内容时显示输入框
        const inputArea = document.querySelector('.chat-input-area');
        if (inputArea) inputArea.style.display = '';
        // 主进程用 "\n> xxx" 发的是**内部状态提示**（自动重试/上下文压缩/要求继续等），
        // 不是 AI 说的话。混进正文会让最终总结里出现「本次未改动任何文件」这类莫名其妙的话。
        // 这里单独识别出来，作为一行灰色提示渲染（可折叠收起，不进最终汇报）。
        const raw = data.text || '';
        if (/^\s*>/.test(raw)) {
          // 双保险：这类状态提示是主进程拼的机器文案，再脱敏一次防止未来新提示漏改。
          // 只作用于灰色提示行，普通正文/代码块不受影响，不会破坏 markdown。
          appendAgentNotice(el, desensitizeToolText(raw.replace(/^\s*>\s?/gm, '').trim()));
          scrollChatToBottomIfNeeded();
          return;
        }
        state.agentState.content += raw;
        // ★ 步骤流：正文被工具/思考打断后再来 → 开新正文步；
        //   否则续写当前正文步。这样「叙述段落」和「工具执行行」在聊天流里按真实发生顺序交错。
        const rec = ensureAgentStep(el, 'text');
        if (rec) {
          rec.text += raw;
          // ★ 节流：chunk 只累积文本，90ms 合并渲染一次（原来每 chunk 全量重渲 Markdown）
          scheduleAgentTextRender(rec);
        }
        scrollChatToBottomIfNeeded();
      } else if (data.type === 'agent-tool-exec') {
        hideAgentWaiting(el); // 新工具开始执行 → 撤掉占位
        state.agentState.tools.push({ tool: data.tool, args: data.args, result: null });
        // 工具是一次性步骤：插入后关闭当前思考/正文步（后续同类事件会另起新步）
        sealAgentThinkStep(state.agentState.stepEls && state.agentState.stepEls.think);
        closeAgentStep('think');
        closeAgentStep('text');
        dropAgentPlaceholder(el);
        if (isTodoTool(data.tool)) {
          // 待办不画通用工具卡片，直接画清单卡片（作为时间序中的一步）
          renderTodoCard(el, null);
        } else if (data.tool === 'ask_user') {
          // 询问用户不画通用卡片：先占位，等 agent-ask-user 事件带来问题与选项
          renderAskUserCard(el, null);
        } else {
          appendAgentToolCard(data.tool, data.args);
        }
      } else if (data.type === 'agent-tool-result') {
        if (isTodoTool(data.tool)) {
          if (data.result?.success) {
            renderTodoCard(el, data.result);
            persistActiveTodos(data.result);
          } else {
            // 失败时退回通用卡片，避免把错误信息藏起来
            renderTodoCard(el, null);
            appendAgentToolCard(data.tool, data.result || {});
          }
        } else if (data.tool === 'ask_user') {
          // 询问用户的最终结果：落实用户选了什么 / 超时未选 / 已停止
          finalizeAskUserCard(el, data.result);
        } else {
          // 找当前消息里最后一个 .agent-tool-card（去重时重复 step 没 DOM，但 DOM 卡片只有一个）
          const cards = el.querySelectorAll('.agent-tool-card');
          const lastCard = cards[cards.length - 1];
          if (lastCard) {
            const statusEl = lastCard.querySelector('.tool-status');
            if (statusEl) {
              statusEl.textContent = data.result && data.result.success ? '✓ 完成' : '✗ 失败';
              statusEl.style.color = data.result && data.result.success ? 'var(--success-color,#4ade80)' : 'var(--error-color,#f87171)';
              statusEl.classList.remove('running');
            }
            if (lastCard._typeTimer) {
              clearInterval(lastCard._typeTimer);
              lastCard._typeTimer = null;
            }
          }
          // 普通工具执行完 → 下一轮模型响应回来之前，挂一个"等待模型响应"占位，
          // 避免工具卡片 ✓ 完成 之后一片空白，用户以为卡住了。
          // ask_user / todo 这类等用户操作的不挂（下一轮不会马上来）。
          showAgentWaiting(el, '等待模型响应');
        }
      } else if (data.type === 'agent-tool-confirm') {
        // 显示工具执行确认弹窗
        const modal = document.getElementById('tool-confirm-modal');
        document.getElementById('confirm-tool-name').textContent = toolLabel(data.tool);
        // 生成友好的中文提示
        let friendlyDesc = '';
        const args = data.args || {};
        if (data.tool === 'write_file') {
          friendlyDesc = '文件路径：' + (args.path || '（未指定）') + '\n';
          if (args.content) friendlyDesc += '内容大小：' + args.content.length + ' 字符';
        } else if (data.tool === 'run_shell') {
          friendlyDesc = '命令：' + (args.command || '（未指定）');
          if (args.timeout) friendlyDesc += '\n超时：' + args.timeout + 'ms';
        } else if (data.tool === 'read_file') {
          friendlyDesc = '文件路径：' + (args.path || '（未指定）');
        } else if (data.tool === 'pet_action') {
          friendlyDesc = '动作：' + (args.action || args.name || '（未指定）');
        } else if (data.tool === 'get_system_info') {
          friendlyDesc = '获取当前系统概况信息';
        } else {
          friendlyDesc = JSON.stringify(args, null, 2);
        }
        document.getElementById('confirm-tool-args').textContent = friendlyDesc;
        modal.style.display = 'flex';
      } else if (data.type === 'agent-ask-user') {
        // 【询问用户】就当前待办"怎么做"出选项卡：用户点选方案或自定义输入
        renderAskUserCard(el, data);
      } else if (data.type === 'agent-done') {
        hideAgentWaiting(el); // 整轮结束 → 清掉残留占位
        state.agentState.done = true;
        state.isStreaming = false;
        state.activeRequestConversationId = null; // 清除请求会话ID
        // ★ 任务执行完毕：清单若已全部完成，稍后自动关闭（不需要用户手动点 ×）
        scheduleAutoCloseTodos();
        const btn = document.getElementById('btn-send');
        if (btn) btn.disabled = false;
        // ★ 流束结束：所有思考步定稿耗时 + 折叠思考内容（工具行/正文保留在时间序里）
        finalizeAgentSteps(el);
        sealAgentThinkStep(state.agentState.stepEls && state.agentState.stepEls.think, true);
        // 确保输入框和内容气泡显示
        const inputArea = document.querySelector('.chat-input-area');
        if (inputArea) inputArea.style.display = '';
        // ★ 先冲刷节流中未渲染的尾部，再走结束补齐逻辑（否则最后 90ms 的内容会丢）
        flushAgentTextRender(state.agentState && state.agentState.stepEls ? state.agentState.stepEls.text : null);
        // 最后一个正文步：结束时补齐可能被截断的尾部（没收到过 agent-content 时新建一步）
        const textSteps = el.querySelectorAll('.agent-step-text');
        let lastTextStep = textSteps[textSteps.length - 1] || null;
        if (!lastTextStep && data.content) {
          const rec = createAgentStep(el, 'text');
          lastTextStep = rec && rec.el;
        }
        if (lastTextStep) {
          const contentBubble = lastTextStep.querySelector('.agent-content-bubble');
          if (contentBubble) {
            contentBubble.style.display = '';
            // 结束时清除"等待模型响应..."占位（截断/出错时可能没收到 agent-content）
            const loadingEl = contentBubble.querySelector('.loading-text');
            const rec = Array.isArray(state.agentState.steps)
              ? state.agentState.steps.find(r => r.el === lastTextStep) : null;
            if (loadingEl) {
              if (data.content) {
                if (rec) rec.text = data.content;
                // 保存原始文本，用于双击编辑
                contentBubble.dataset.originalContent = data.content;
                // 使用Markdown渲染
                contentBubble.innerHTML = renderMarkdown(data.content);
              } else contentBubble.innerHTML = '';
            } else if ((!contentBubble.textContent.trim()) && data.content) {
              if (rec) rec.text = data.content;
              // 保存原始文本，用于双击编辑
              contentBubble.dataset.originalContent = data.content;
              // 使用Markdown渲染
              contentBubble.innerHTML = renderMarkdown(data.content);
            }
          }
        }
        // 渲染 Token 消耗统计栏，并保存到临时变量供后续持久化
        // （因为这里会把 state.agentState 置为 null，所以不能存在 agentState 中）
        const agentUsage = data.usage || null;
        const agentElapsed = state.agentState?.startTime ? (Date.now() - state.agentState.startTime) : 0;
        if (agentUsage || agentElapsed > 0) {
          renderTokenStatsBar(el, agentUsage, agentElapsed);
          pendingAgentUsage = agentUsage;
          pendingAgentElapsedMs = agentElapsed;
        } else {
          pendingAgentUsage = null;
          pendingAgentElapsedMs = 0;
        }
        // ★ 总览行：一轮结束后写入「已完成 · 用时 X 秒」并默认收起，
        //   点它可展开看到完整的思考与处理过程（步骤流本身保持原样，只是容器可见性切换）
        //   changedFiles 是主进程按实际写操作记录的改动清单 → 渲染成可点击文件列表
        finalizeAgentProcess(el, { elapsedMs: agentElapsed });
        renderChangedFiles(el, data.changedFiles);
        // 思考过程/正文/工具记录接力（agentState 即将置空，落库逻辑在 await 之后）
        pendingAgentReasoning = state.agentState?.reasoning || '';
        pendingAgentTools = state.agentState?.tools || [];
        pendingAgentContent = state.agentState?.content || '';
        // ★ 时间顺序步骤流落库：历史消息按 steps[] 复原「一步步」的过程
        pendingAgentSteps = exportAgentSteps(state.agentState?.steps);
        // ★ 改动文件清单接力（落库后历史消息也显示可点击列表）
        pendingAgentChangedFiles = Array.isArray(data.changedFiles) && data.changedFiles.length
          ? data.changedFiles.slice() : null;
        state.agentState = null;
      }
      scrollChatToBottomIfNeeded();
      return;
    }
    // 清理已失效的 agent 状态
    if (state.agentState && (!state.agentState.currentMsgEl || !state.agentState.currentMsgEl.isConnected)) {
      state.agentState = null;
    }
    // 普通模式流式更新
    if (data.type === 'stream-chunk' && state.currentAIMsgEl) {
      state.currentAIContent += data.content || '';
      // 正文开始输出：收起思考区（若有），聚焦回答；用户可点头部再展开
      const rSec = state.currentAIMsgEl.querySelector('.chat-reasoning-section');
      if (rSec) {
        const rBody = rSec.querySelector('.agent-reasoning-content');
        if (rBody && rBody.style.display !== 'none') {
          rBody.style.display = 'none';
          const tg = rSec.querySelector('.reasoning-toggle');
          if (tg) tg.style.transform = 'rotate(0deg)';
          const tm = rSec.querySelector('.reasoning-time');
          if (tm) tm.textContent = '思考结束';
        }
      }
      const bubble = state.currentAIMsgEl.querySelector('.chat-bubble');
      if (bubble.querySelector('span')) bubble.innerHTML = '';
      // 保存原始文本，用于双击编辑
      bubble.dataset.originalContent = state.currentAIContent;
      // 使用Markdown渲染
      bubble.innerHTML = renderMarkdown(state.currentAIContent);
      scrollChatToBottomIfNeeded();
    }
    // 普通模式思考过程：独立折叠区实时滚动渲染（思考与正文分离，不再一股脑写进气泡）
    if (data.type === 'stream-reasoning' && state.currentAIMsgEl) {
      state.currentAIReasoning = (state.currentAIReasoning || '') + desensitizeToolText(data.content || '');
      let section = state.currentAIMsgEl.querySelector('.chat-reasoning-section');
      if (!section) {
        section = document.createElement('div');
        section.className = 'agent-reasoning-section chat-reasoning-section';
        section.style.cssText = 'margin-bottom:6px;';
        section.innerHTML = '<div class="agent-reasoning-header" style="cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px;color:var(--text-muted);font-size:13px;padding:4px 0;">'
          + '<span class="reasoning-toggle" style="transition:transform 0.2s;display:inline-block;">›</span>'
          + '<span class="reasoning-time">思考中...</span></div>'
          + '<div class="agent-reasoning-content" style="padding:8px 0;font-size:13px;color:var(--text-secondary);line-height:1.6;white-space:pre-wrap;word-break:break-word;"></div>';
        const bubble = state.currentAIMsgEl.querySelector('.chat-bubble');
        if (bubble && bubble.parentElement) bubble.parentElement.insertBefore(section, bubble);
        else state.currentAIMsgEl.appendChild(section);
        const hdr = section.querySelector('.agent-reasoning-header');
        const rBody = section.querySelector('.agent-reasoning-content');
        hdr.addEventListener('click', () => {
          const isOpen = rBody.style.display !== 'none';
          rBody.style.display = isOpen ? 'none' : 'block';
          hdr.querySelector('.reasoning-toggle').style.transform = isOpen ? 'rotate(0deg)' : 'rotate(90deg)';
        });
      }
      const rBody = section.querySelector('.agent-reasoning-content');
      rBody.textContent = state.currentAIReasoning;
      // 思考进行中：默认展开实时看，正文开始后自动收起
      rBody.style.display = 'block';
      const tg = section.querySelector('.reasoning-toggle');
      if (tg) tg.style.transform = 'rotate(90deg)';
      scrollChatToBottomIfNeeded();
    }
    if (data.type === 'complete') {
      state.isStreaming = false;
      state.activeRequestConversationId = null; // 清除请求会话ID
      const btn = document.getElementById('btn-send');
      if (btn) btn.disabled = false;
    }
    // 流式完成事件：捕获 usage（部分平台只在流结束时返回 token 统计）+ 持久化思考过程
    if (data.type === 'stream-complete' && state.currentAIMsgEl) {
      const conv = state.conversations?.find(c => c.id === state.activeConversationId);
      const aiMsg = conv?.messages?.[conv.messages.length - 1];
      if (aiMsg && aiMsg.role === 'ai') {
        if (data.usage) {
          aiMsg.usage = data.usage;
          renderTokenStatsBar(state.currentAIMsgEl, data.usage, 0);
        }
        // 思考过程入库（历史渲染走 msg-reasoning-hist 折叠块）
        if (data.reasoning) aiMsg.reasoning = data.reasoning;
        else if (state.currentAIReasoning) aiMsg.reasoning = state.currentAIReasoning;
      }
    }
    if (data.providerId && data.providerId !== state.activeProviderId) {
      state.activeProviderId = data.providerId;
      updateActiveProviderDisplay();
    }
  });

  window.api.on('ai:provider-sync', (data) => {
    if (data.activeProvider && data.activeProvider !== state.activeProviderId) {
      state.activeProviderId = data.activeProvider;
      syncAISettings();
      updateActiveProviderDisplay();
    }
  });
}

// ==================== 系统信息显示 ====================
function updateSystemInfoDisplay() {
  const info = state.systemInfo;
  if (!info) return;

  document.querySelector('#os-info .info-txt').textContent = info.os === 'win32' ? 'Windows' : info.os === 'darwin' ? 'macOS' : 'Linux';
  document.querySelector('#cpu-info .info-txt').textContent = `${info.cpuCount}核`;
  document.querySelector('#mem-info .info-txt').textContent = `${info.totalMem}GB`;
}

// 更新底部状态栏的当前模型名称
function updateModelStatusBar() {
  const txt = document.getElementById('status-model-txt');
  if (!txt) return;
  const t = window.I18N?.t || ((k) => k);
  if (!state.currentModelId) {
    txt.textContent = t('chat.defaultModel');
  } else {
    const model = state.models.find(m => m.id === state.currentModelId);
    txt.textContent = model ? model.name : t('chat.defaultModel');
  }
}

// ==================== 会话管理 ====================

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
}

function getActiveConversation() {
  if (!state.activeConversationId || state.conversations.length === 0) return null;
  return state.conversations.find(c => c.id === state.activeConversationId) || null;
}

function getActiveMessages() {
  const conv = getActiveConversation();
  return conv ? conv.messages : state.chatHistory;
}

function createNewConversation() {
  const id = generateId();
  const conv = {
    id,
    title: '新对话',
    workdir: state.workdir || '',   // 继承当前项目：选择项目时新会话归该项目；无项目则为通用
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  state.conversations.unshift(conv);
  state.activeConversationId = id;
  setCompressNotice(null); // 提示属于单个会话
  saveConversations();
  renderConversationList();
  renderChat();
}

function switchConversation(id) {
  // 如果切换到不同的会话，且当前有正在进行的AI请求属于旧会话，取消请求
  if (state.activeConversationId !== id && state.activeRequestConversationId && state.activeRequestConversationId !== id) {
    console.log('[Session] 切换会话，取消旧会话的AI请求');
    if (window.api.cancelChat) {
      try { window.api.cancelChat(); } catch (e) {}
    }
    state.isStreaming = false;
    state.activeRequestConversationId = null;
    state.currentAIMsgEl = null;
    state.currentAIContent = '';
    state.currentAIReasoning = '';
    state.agentState = null;
    const sendBtn = document.getElementById('btn-send');
    const stopBtn = document.getElementById('btn-stop');
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.style.display = '';
    }
    if (stopBtn) stopBtn.style.display = 'none';
    const inputArea = document.querySelector('.chat-input-area');
    if (inputArea) inputArea.style.display = '';
  }
  // ★ 切换会话：丢弃待发送队列，避免旧会话的「等待发送」残留、或在新会话里被误发
  if (state.activeConversationId !== id) clearPendingQueue();
  state.activeConversationId = id;
  setCompressNotice(null);
  // 同步 chatHistory 到兼容格式
  const conv = state.conversations.find(c => c.id === id);
  if (conv) {
    state.chatHistory = conv.messages;
  }
  // 恢复该会话绑定的项目工作目录（各会话独立，不互相影响）
  if (typeof window.syncProjectFromActiveConv === 'function') window.syncProjectFromActiveConv();
  renderConversationList();
  renderChat();
}

async function deleteConversation(id) {
  const index = state.conversations.findIndex(c => c.id === id);
  if (index === -1) return;

  // 纸篓功能：删除前先放入纸篓（如果启用）
  try {
    const secConfig = await window.api.security.getConfig();
    if (secConfig && secConfig.data && secConfig.data.trashEnabled && secConfig.data.deleteProtection) {
      const conv = state.conversations[index];
      if (conv) {
        await window.api.security.trashAdd({
          id: conv.id,
          title: conv.title,
          messages: conv.messages || conv.chatHistory || [],
          createdAt: conv.createdAt,
          updatedAt: conv.updatedAt
        }, 'conversation');
      }
    }
  } catch (e) { console.log('[Security] 纸篓保存失败:', e.message); }

  // 如果删除的是当前正在进行AI请求的会话，取消请求并清理状态
  if (state.activeRequestConversationId === id) {
    console.log('[Session] 删除正在进行AI请求的会话，取消请求并清理状态');
    // 取消正在进行的AI请求
    if (window.api.cancelChat) {
      try { window.api.cancelChat(); } catch (e) {}
    }
    // 清理AI请求相关状态
    state.isStreaming = false;
    state.activeRequestConversationId = null;
    state.currentAIMsgEl = null;
    state.currentAIContent = '';
    state.currentAIReasoning = '';
    state.agentState = null;
    // 恢复发送按钮显示
    const sendBtn = document.getElementById('btn-send');
    const stopBtn = document.getElementById('btn-stop');
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.style.display = '';
    }
    if (stopBtn) stopBtn.style.display = 'none';
    // 显示输入框
    const inputArea = document.querySelector('.chat-input-area');
    if (inputArea) inputArea.style.display = '';
  }

  state.conversations.splice(index, 1);
  if (state.activeConversationId === id) {
    // 删除当前会话后默认【新建会话】（此前自动切到最近的历史会话，用户实测不符预期）
    createNewConversation();
  }
  saveConversations();
  renderConversationList();
}

function autoTitleConversation(conv, userMessage) {
  if (conv.title === '新对话' && userMessage) {
    conv.title = userMessage.slice(0, 20) + (userMessage.length > 20 ? '...' : '');
  }
}

// 聊天历史记录限制（内存优化）
const MAX_CONVERSATIONS = 50; // 最多保留50个会话
const MAX_MESSAGES_PER_CONVERSATION = 200; // 每个会话最多保留200条消息

function saveConversations() {
  // ★ 内存优化：限制会话数量和每个会话的消息数量
  let cleaned = false;

  // 限制会话数量：超过上限时删除最旧的会话（按updatedAt排序）
  if (state.conversations.length > MAX_CONVERSATIONS) {
    state.conversations.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const removed = state.conversations.splice(MAX_CONVERSATIONS);
    console.log('[MemoryOptimizer] 清理旧会话:', removed.length, '个');
    cleaned = true;
  }

  // 限制每个会话的消息数量：超过上限时删除最旧的消息
  state.conversations.forEach(conv => {
    if (conv.messages && conv.messages.length > MAX_MESSAGES_PER_CONVERSATION) {
      const removeCount = conv.messages.length - MAX_MESSAGES_PER_CONVERSATION;
      conv.messages = conv.messages.slice(removeCount);
      console.log('[MemoryOptimizer] 清理会话', conv.title, '的旧消息:', removeCount, '条');
      cleaned = true;
    }
  });

  // 同步 chatHistory
  const activeConv = state.conversations.find(c => c.id === state.activeConversationId);
  if (activeConv) {
    state.chatHistory = activeConv.messages;
  }

  window.api.saveChatHistory(state.conversations).catch(() => {});

  if (cleaned) {
    // 如果清理了数据，重新渲染会话列表和聊天界面
    renderConversationList();
    renderChat();
  }
}

function renderConversationList() {
  const historyBtn = document.getElementById('btn-history-conv');
  const delBtn = document.getElementById('btn-delete-conv');
  const listEl = document.getElementById('history-conv-list');
  const modalIcon = document.getElementById('history-modal-icon');
  if (!historyBtn || !listEl) return;

  if (modalIcon) modalIcon.innerHTML = window.ElIcons.ICONS.history || '';

  if (state.conversations.length === 0) {
    historyBtn.style.display = 'none';
    if (delBtn) delBtn.style.display = 'none';
    listEl.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text-secondary,#999);font-size:13px;">暂无历史会话</div>';
    return;
  }

  historyBtn.style.display = '';
  if (delBtn) delBtn.style.display = state.activeConversationId ? '' : 'none';

  // ★ 历史会话按当前项目过滤：选了项目就只列出「该项目独有的会话」，未选项目则列出全部；
  //   已归档(archived)的会话不在活跃列表显示，仅出现在「已归档内容」里。
  const curProject = (state.workdir || '').replace(/[\\/]+$/, '');
  const convList = curProject
    ? state.conversations.filter(c => !c.archived && c.workdir && c.workdir.replace(/[\\/]+$/, '') === curProject)
    : state.conversations.filter(c => !c.archived);
  listEl.innerHTML = '';
  if (convList.length === 0) {
    listEl.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text-secondary,#999);font-size:13px;">该项目暂无会话</div>';
    return;
  }
  convList.forEach(conv => {
    const item = document.createElement('div');
    const isActive = conv.id === state.activeConversationId;
    item.dataset.convId = conv.id;
    item.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 14px;margin:2px 0;border-radius:8px;cursor:pointer;transition:background 0.15s;' +
      (isActive ? 'background:rgba(79,70,229,0.12);color:var(--accent,#4f46e5);' : 'color:var(--text-primary,#fff);');
    const left = document.createElement('div');
    left.style.cssText = 'flex:1;min-width:0;display:flex;align-items:center;gap:10px;';
    const title = document.createElement('span');
    title.style.cssText = 'font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;';
    title.textContent = conv.title || '未命名对话';
    const time = document.createElement('span');
    time.style.cssText = 'font-size:11px;color:var(--text-secondary,#888);flex-shrink:0;';
    const d = new Date(conv.updatedAt || conv.createdAt || Date.now());
    time.textContent = (d.getMonth()+1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
    left.appendChild(title);
    left.appendChild(time);
    item.appendChild(left);
    if (isActive) {
      const dot = document.createElement('span');
      dot.style.cssText = 'width:6px;height:6px;border-radius:50%;background:var(--accent,#4f46e5);flex-shrink:0;';
      item.appendChild(dot);
    }
    item.addEventListener('mouseenter', () => { if (!isActive) item.style.background = 'var(--bg-hover,#252532)'; });
    item.addEventListener('mouseleave', () => { if (!isActive) item.style.background = 'transparent'; });
    item.addEventListener('click', () => { switchConversation(conv.id); closeHistoryModal(); });
    listEl.appendChild(item);
  });
  renderSidebarConversations();
  if (convPanels.right) renderConvAssets();
}

function openHistoryModal() {
  const modal = document.getElementById('history-conv-modal');
  const panel = document.getElementById('history-conv-panel');
  const btn = document.getElementById('btn-history-conv');
  if (!modal || !panel || !btn) return;
  const rect = btn.getBoundingClientRect();
  const panelWidth = 280;
  let left = rect.right - panelWidth;
  if (left < 8) left = 8;
  if (left + panelWidth > window.innerWidth - 8) left = window.innerWidth - panelWidth - 8;
  panel.style.top = (rect.bottom + 6) + 'px';
  panel.style.left = left + 'px';
  modal.style.display = 'block';
  renderConversationList();
}
function closeHistoryModal() {
  const modal = document.getElementById('history-conv-modal');
  if (modal) modal.style.display = 'none';
}

// ==================== 左侧项目会话栏 ====================
function projectNameOf(conv) {
  const wd = (conv && conv.workdir) || '';
  if (!wd) return '';
  return wd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
}
function projectGroupKeyOf(conv) {
  return projectNameOf(conv) || '_general';
}
function getGroupOpenState(key) {
  try {
    const s = JSON.parse(localStorage.getItem('convSidebarGroups') || '{}');
    return s[key] !== false; // 默认展开
  } catch (e) { return true; }
}
function setGroupOpenState(key, open) {
  try {
    const s = JSON.parse(localStorage.getItem('convSidebarGroups') || '{}');
    s[key] = open;
    localStorage.setItem('convSidebarGroups', JSON.stringify(s));
  } catch (e) {}
}
function convSummary(conv) {
  let s = (conv && conv.title) || '未命名对话';
  const first = (conv && conv.messages || []).find(m => m && m.role === 'user' && m.content);
  if (first) {
    const t = String(first.content).replace(/\s+/g, ' ').trim();
    if (t) s += '\n' + (t.length > 60 ? t.slice(0, 60) + '…' : t);
  }
  return s;
}
let _convMaximized = false; // 窗口是否最大化/全屏（onWindowStateChanged 维护）
let _convPanelsTouched = false; // 用户是否手动切换过侧栏（此后不再随窗口状态自动覆盖）
const convPanels = { left: false, right: false }; // 左右侧栏展开状态

function applyConvPanelState() {
  const left = document.getElementById('conv-sidebar');
  const right = document.getElementById('conv-assets-sidebar');
  const main = document.getElementById('chat-main');
  const btnL = document.getElementById('conv-toggle-left');
  const btnR = document.getElementById('conv-toggle-right');
  const top = document.getElementById('chat-top');
  const anyOpen = convPanels.left || convPanels.right;
  if (top) top.classList.toggle('conv-maximized', !!_convMaximized);
  if (left) left.style.display = convPanels.left ? '' : 'none';
  if (right) right.style.display = convPanels.right ? '' : 'none';
  // 非全屏打开侧边 → 消息区隐藏；全屏打开侧边 → 消息保留
  if (main) main.style.display = (anyOpen && !_convMaximized) ? 'none' : '';
  if (btnL) btnL.classList.toggle('active', convPanels.left);
  if (btnR) btnR.classList.toggle('active', convPanels.right);
}
function toggleConvPanel(side) {
  const next = !convPanels[side];
  if (!_convMaximized) {
    // 小窗口（未放大/非全屏）：最多展开一边，左右互斥
    convPanels.left = false;
    convPanels.right = false;
    convPanels[side] = next;
  } else {
    // 放大/全屏：左右独立，可同时展开
    convPanels[side] = next;
  }
  _convPanelsTouched = true;
  applyConvPanelState();
}
function renderSidebarConversations() {
  const listEl = document.getElementById('conv-sidebar-list');
  if (!listEl) return;
  const actives = state.conversations.filter(c => !c.archived);
  listEl.innerHTML = '';
  if (actives.length === 0) {
    listEl.innerHTML = '<div class="conv-sidebar-empty">暂无会话<br>点击右上角「+」新建对话</div>';
    return;
  }
  const groups = new Map();
  // 只统计有用户实际消息的会话（系统默认欢迎等不算；用户发送过消息才显示）
  const hasUserMsg = (conv) => (conv.messages || []).some(m => m && m.role === 'user' && m.content && String(m.content).trim());
  for (const conv of actives) {
    if (!hasUserMsg(conv)) continue;
    const key = projectGroupKeyOf(conv);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(conv);
  }
  // 补充：最近项目（即使暂无会话也展示，标注「暂无对话」）
  const recentMap = new Map(); // 项目名 -> 完整路径
  let recent = [];
  try { recent = JSON.parse(localStorage.getItem('recentProjects') || '[]') || []; } catch (e) {}
  for (const p of recent) {
    if (!p) continue;
    const base = p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
    if (base) { recentMap.set(base, p); if (!groups.has(base)) groups.set(base, []); }
  }
  // 通用会话（无项目归属）不显示在左侧
  const keys = Array.from(groups.keys()).filter(k => k !== '_general').sort((a, b) => a.localeCompare(b));
  for (const key of keys) {
    const convs = groups.get(key).slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const group = document.createElement('div');
    group.className = 'conv-group';
    if (!getGroupOpenState(key)) group.classList.add('collapsed');
    const label = key === '_general' ? '通用会话' : key;
    const workdir = convs[0] ? (convs[0].workdir || '') : (recentMap.get(key) || '');
    group.dataset.workdir = workdir;
    const head = document.createElement('div');
    head.className = 'conv-group-head';
    head.innerHTML = '<span class="conv-group-caret">▾</span><span class="conv-group-folder"></span><span class="conv-group-name"></span><span class="conv-group-count"></span>';
    head.querySelector('.conv-group-name').textContent = label;
    head.querySelector('.conv-group-count').textContent = convs.length || '';
    const folder = head.querySelector('.conv-group-folder');
    folder.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>';
    head.addEventListener('click', async (e) => {
      // 项目目录已被本地删除：点击时提示是否移除该项目
      if (group.dataset.missing === '1' && workdir) {
        e.stopPropagation();
        let confirmed = false;
        try {
          confirmed = await showConfirm({
            type: 'warning',
            title: '项目已删除',
            message: `项目「${label}」在本地已被删除`,
            detail: '是否移除此项目及其全部会话？选择「取消」则仅保留记录（聊天仍可查看）。'
          });
        } catch (err) { confirmed = false; }
        if (confirmed) { removeProject(workdir); return; }
      }
      const collapsed = group.classList.toggle('collapsed');
      setGroupOpenState(key, !collapsed);
    });
    // 异步检测本地目录是否已删除
    if (workdir && typeof window.api.checkProjectExists === 'function') {
      window.api.checkProjectExists(workdir).then(r => {
        if (r && r.exists === false && group.isConnected) {
          group.dataset.missing = '1';
          const mark = document.createElement('span');
          mark.style.cssText = 'font-size:11px;color:var(--text-danger,#f87171);flex-shrink:0;margin-left:auto;';
          mark.textContent = '已删除';
          head.appendChild(mark);
        }
      }).catch(() => {});
    }
    const body = document.createElement('div');
    body.className = 'conv-group-body';
    if (convs.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'conv-group-empty';
      empty.textContent = '暂无对话';
      body.appendChild(empty);
    } else {
      for (const conv of convs) {
      const row = document.createElement('div');
      row.className = 'conv-row' + (conv.id === state.activeConversationId ? ' active' : '');
      row.title = convSummary(conv); // 悬停显示会话概括
      const title = document.createElement('span');
      title.className = 'conv-row-title';
      title.textContent = conv.title || '未命名对话';
      const sub = document.createElement('span');
      sub.className = 'conv-row-sub';
      const firstMsg = (conv.messages || []).find(m => m && m.role === 'user' && m.content);
      if (firstMsg) sub.textContent = String(firstMsg.content).replace(/\s+/g, ' ').trim();
      const arch = document.createElement('button');
      arch.className = 'conv-archive-btn';
      arch.title = '归档此会话';
      arch.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16l-1.5 3H5.5L4 4z"/><path d="M5 7h14v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7z"/></svg>';
      arch.addEventListener('click', (e) => { e.stopPropagation(); archiveConversation(conv.id); });
      row.appendChild(title);
      row.appendChild(sub);
      row.appendChild(arch);
      row.addEventListener('click', () => { switchConversation(conv.id); });
      body.appendChild(row);
      }
    }
    group.appendChild(head);
    group.appendChild(body);
    listEl.appendChild(group);
  }
}
function collectConvArtifacts(conv) {
  const images = [], links = [], files = [];
  const seenImg = new Set(), seenLink = new Set(), seenFile = new Set();
  const msgs = (conv.messages || []).slice();
  for (const m of msgs) {
    if (!m) continue;
    if (m.role === 'user') {
      (m.images || []).forEach(src => { if (src && !seenImg.has(src)) { seenImg.add(src); images.push(src); } });
      (m.attachments || []).forEach(f => { const k = f.path || f.name || ''; if (k && !seenFile.has(k)) { seenFile.add(k); files.push({ name: f.name || f.path, path: f.path }); } });
    } else {
      const content = typeof m.content === 'string' ? m.content : (m.aiContent || '');
      let mm;
      const imgRe = /!\[[^\]]*\]\(([^)]+)\)/g;
      while ((mm = imgRe.exec(content))) { const u = mm[1].trim(); if (u && !seenImg.has(u)) { seenImg.add(u); images.push(u); } }
      const linkRe = /\[([^\]]*)\]\(((?:https?:\/\/)[^)\s]+)\)/g;
      while ((mm = linkRe.exec(content))) { const u = mm[2].trim(); if (u && !seenLink.has(u)) { seenLink.add(u); links.push({ text: mm[1] || u, url: u }); } }
    }
  }
  return { images, links, files };
}

function convAssetsEmpty(text) {
  const d = document.createElement('div');
  d.className = 'conv-assets-empty';
  d.textContent = text;
  return d;
}

async function renderConvAssets() {
  const listEl = document.getElementById('conv-assets-list');
  if (!listEl) return;
  const conv = state.conversations.find(c => c.id === state.activeConversationId);
  listEl.innerHTML = '';
  if (!conv) { listEl.appendChild(convAssetsEmpty('暂无对话')); return; }

  // —— 工作进度（agent 自动执行计划） ——
  const todos = conv.activeTodos;
  if (Array.isArray(todos) && todos.length) {
    const secProg = document.createElement('div');
    secProg.className = 'conv-assets-section';
    const hProg = document.createElement('div');
    hProg.className = 'conv-assets-head';
    hProg.textContent = '工作进度';
    secProg.appendChild(hProg);
    const body = document.createElement('div');
    body.className = 'conv-assets-body';
    const p = todoProgressOf(todos);
    todos.forEach(it => {
      const row = document.createElement('div');
      row.className = 'conv-progress-item ' + (it.status || 'pending');
      const mk = document.createElement('span');
      mk.className = 'conv-progress-mark';
      if (it.status === 'completed') {
        mk.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l5 5L20 6"/></svg>';
      } else if (it.status === 'in_progress') {
        const sp = document.createElement('span');
        sp.className = 'conv-progress-spin';
        mk.appendChild(sp);
      }
      row.appendChild(mk);
      const txt = document.createElement('span');
      txt.className = 'conv-progress-text';
      txt.textContent = it.text || '';
      row.appendChild(txt);
      body.appendChild(row);
    });
    const counter = document.createElement('div');
    counter.className = 'conv-progress-counter';
    counter.textContent = '完成 ' + p.completed + '/' + p.total;
    body.appendChild(counter);
    secProg.appendChild(body);
    listEl.appendChild(secProg);
  }

  // —— 对话产物 ——
  const art = collectConvArtifacts(conv);
  const secArt = document.createElement('div');
  secArt.className = 'conv-assets-section';
  const hArt = document.createElement('div');
  hArt.className = 'conv-assets-head';
  hArt.textContent = '对话产物';
  secArt.appendChild(hArt);
  if (art.images.length === 0 && art.links.length === 0 && art.files.length === 0) {
    secArt.appendChild(convAssetsEmpty('暂无产物'));
  } else {
    const body = document.createElement('div');
    body.className = 'conv-assets-body';
    art.images.forEach(src => {
      const a = document.createElement('a');
      a.className = 'conv-asset-img';
      a.href = src; a.target = '_blank'; a.title = src;
      const img = document.createElement('img');
      img.src = src; img.alt = '产物图片'; img.loading = 'lazy';
      a.appendChild(img);
      body.appendChild(a);
    });
    art.links.forEach(l => {
      const a = document.createElement('a');
      a.className = 'conv-asset-link';
      a.href = l.url; a.target = '_blank'; a.title = l.url;
      a.textContent = l.text || l.url;
      body.appendChild(a);
    });
    art.files.forEach(f => {
      const d = document.createElement('div');
      d.className = 'conv-asset-file';
      d.textContent = f.name;
      d.title = f.path || '';
      if (f.path) d.addEventListener('click', () => { if (window.api.openPath) window.api.openPath(f.path); });
      body.appendChild(d);
    });
    secArt.appendChild(body);
  }
  listEl.appendChild(secArt);

  // —— 项目文件资源 ——
  const workdir = conv.workdir || '';
  const secFiles = document.createElement('div');
  secFiles.className = 'conv-assets-section';
  const hFiles = document.createElement('div');
  hFiles.className = 'conv-assets-head';
  hFiles.textContent = '项目资源';
  secFiles.appendChild(hFiles);
  if (!workdir) {
    secFiles.appendChild(convAssetsEmpty('当前会话未绑定项目目录'));
    listEl.appendChild(secFiles);
    return;
  }
  const filesBody = document.createElement('div');
  filesBody.className = 'conv-assets-body';
  try {
    const res = await window.api.listFiles({ path: workdir, recursive: false, showHidden: false });
    const entries = (res && res.success) ? (res.data || []) : [];
    if (entries.length === 0) {
      filesBody.appendChild(convAssetsEmpty('项目目录为空'));
    } else {
      for (const e of entries) {
        const item = document.createElement('div');
        item.className = 'conv-asset-file';
        item.dataset.name = e.name;
        item.textContent = (e.isDirectory ? '▸ ' : '· ') + e.name;
        item.title = e.path;
        if (e.isDirectory) {
          item.classList.add('conv-asset-dir');
          item.addEventListener('click', () => toggleAssetDir(item, e.path));
        } else {
          item.addEventListener('click', () => { if (window.api.openPath) window.api.openPath(e.path); });
        }
        filesBody.appendChild(item);
      }
    }
  } catch (err) {
    filesBody.appendChild(convAssetsEmpty('读取失败'));
  }
  secFiles.appendChild(filesBody);
  listEl.appendChild(secFiles);
}

function refreshConvAssetsIfOpen() {
  if (convPanels.right) renderConvAssets();
}

async function toggleAssetDir(el, dirPath) {
  if (el.classList.contains('expanded')) {
    el.classList.remove('expanded');
    el.textContent = '▸ ' + (el.dataset.name || '');
    const ch = el.querySelector(':scope > .conv-asset-dir-children');
    if (ch) ch.remove();
    return;
  }
  try {
    const res = await window.api.listFiles({ path: dirPath, recursive: false, showHidden: false });
    const entries = (res && res.success) ? (res.data || []) : [];
    const wrap = document.createElement('div');
    wrap.className = 'conv-asset-dir-children';
    if (entries.length === 0) {
      wrap.appendChild(convAssetsEmpty('（空）'));
    } else {
      for (const e of entries) {
        const item = document.createElement('div');
        item.className = 'conv-asset-file conv-asset-nested';
        item.dataset.name = e.name;
        item.textContent = (e.isDirectory ? '▸ ' : '· ') + e.name;
        item.title = e.path;
        if (e.isDirectory) {
          item.classList.add('conv-asset-dir');
          item.addEventListener('click', () => toggleAssetDir(item, e.path));
        } else {
          item.addEventListener('click', () => { if (window.api.openPath) window.api.openPath(e.path); });
        }
        wrap.appendChild(item);
      }
    }
    el.appendChild(wrap);
    el.classList.add('expanded');
    el.textContent = '▾ ' + (el.dataset.name || '');
  } catch (err) {}
}

async function removeProject(workdir) {
  const norm = (workdir || '').replace(/[\\/]+$/, '');
  if (!norm) return;
  // 删除该项目全部会话（含归档）
  for (let i = state.conversations.length - 1; i >= 0; i--) {
    const c = state.conversations[i];
    if (c.workdir && c.workdir.replace(/[\\/]+$/, '') === norm) state.conversations.splice(i, 1);
  }
  // 当前激活会话被删除 → 新建
  if (!state.conversations.find(c => c.id === state.activeConversationId)) {
    createNewConversation();
  }
  // 从最近项目列表移除
  try {
    const recent = JSON.parse(localStorage.getItem('recentProjects') || '[]')
      .filter(p => p.replace(/[\\/]+$/, '') !== norm);
    localStorage.setItem('recentProjects', JSON.stringify(recent));
  } catch (e) {}
  // 若当前工作目录指向该项目，重置为未选择
  if (state.workdir && state.workdir.replace(/[\\/]+$/, '') === norm) {
    window.setProjectWorkdir('');
  }
  saveConversations(); // 主进程物理移除对应会话文件与空目录
  renderConversationList();
  showToast('已移除项目', '', 'info');
}
async function archiveConversation(id) {
  const conv = state.conversations.find(c => c.id === id);
  if (!conv) return;
  conv.archived = true;
  conv.archivedAt = Date.now();
  saveConversations();
  renderConversationList();
  showToast('会话已归档', conv.title || '未命名对话', 'info');
}

// ==================== 已归档内容（系统设置 → 功能 → 已归档内容） ====================
function openArchivedModal() {
  const modal = document.getElementById('archived-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  renderArchivedList();
}
function closeArchivedModal() {
  const modal = document.getElementById('archived-modal');
  if (modal) modal.style.display = 'none';
}
function renderArchivedList() {
  const listEl = document.getElementById('archived-list');
  if (!listEl) return;
  listEl.innerHTML = '';
  const archived = state.conversations.filter(c => c.archived);
  if (archived.length === 0) {
    listEl.innerHTML = '<div style="padding:30px 12px;text-align:center;color:var(--text-secondary,#999);font-size:13px;">暂无归档内容</div>';
    return;
  }
  const groups = new Map();
  for (const conv of archived) {
    const key = projectGroupKeyOf(conv);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(conv);
  }
  const keys = Array.from(groups.keys()).sort((a, b) => {
    const aGen = a === '_general' ? 1 : 0;
    const bGen = b === '_general' ? 1 : 0;
    if (aGen !== bGen) return aGen - bGen;
    return a.localeCompare(b);
  });
  for (const key of keys) {
    const convs = groups.get(key).slice().sort((a, b) => (b.archivedAt || b.updatedAt || 0) - (a.archivedAt || a.updatedAt || 0));
    const label = document.createElement('div');
    label.className = 'archived-group-label';
    label.textContent = key === '_general' ? '通用会话' : key;
    listEl.appendChild(label);
    for (const conv of convs) {
      const item = document.createElement('div');
      item.className = 'archived-item';
      const title = document.createElement('span');
      title.className = 'archived-title';
      title.textContent = conv.title || '未命名对话';
      const meta = document.createElement('span');
      meta.className = 'archived-meta';
      const d = new Date(conv.updatedAt || conv.createdAt || Date.now());
      meta.textContent = (d.getMonth()+1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
      const actions = document.createElement('span');
      actions.className = 'archived-actions';
      const restoreBtn = document.createElement('button');
      restoreBtn.className = 'btn btn-sm';
      restoreBtn.textContent = '还原';
      restoreBtn.addEventListener('click', () => restoreArchived(conv.id));
      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-sm btn-danger';
      delBtn.textContent = '删除';
      delBtn.addEventListener('click', () => deleteArchived(conv.id));
      actions.appendChild(restoreBtn);
      actions.appendChild(delBtn);
      item.appendChild(title);
      item.appendChild(meta);
      item.appendChild(actions);
      listEl.appendChild(item);
    }
  }
}
async function restoreArchived(id) {
  const conv = state.conversations.find(c => c.id === id);
  if (!conv) return;
  conv.archived = false;
  delete conv.archivedAt;
  saveConversations();
  renderConversationList();
  renderArchivedList();
  showToast('会话已还原', conv.title || '未命名对话', 'info');
}
async function deleteArchived(id) {
  const conv = state.conversations.find(c => c.id === id);
  let confirmed = false;
  try {
    confirmed = await showConfirm({
      type: 'warning',
      title: '永久删除归档会话',
      message: `确定永久删除会话「${(conv && conv.title) || '未命名对话'}」吗？`,
      detail: '删除后记录将被真正移除，无法恢复。'
    });
  } catch (e) { confirmed = false; }
  if (!confirmed) return;
  const index = state.conversations.findIndex(c => c.id === id);
  if (index === -1) return;
  state.conversations.splice(index, 1);
  saveConversations(); // 主进程会把对应会话文件物理删除
  renderConversationList();
  renderArchivedList();
  showToast('已永久删除', '', 'info');
}

// ==================== AI 对话 ====================
function renderChat() {
  const messagesContainer = document.getElementById('chat-messages');
  messagesContainer.innerHTML = '';

  const messages = getActiveMessages();
  let lastAiMsgEl = null;
  const streamingToThisConv = state.isStreaming &&
    (!state.activeRequestConversationId || state.activeRequestConversationId === state.activeConversationId);
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    // ★ 流式进行中，最后一条正在生成的 AI 消息：Agent 模式用 appendAgentMessage 重建特殊 DOM 结构
    const isStreamingLastAi = streamingToThisConv &&
      i === messages.length - 1 && msg.role === 'ai' &&
      (state.agentState || state.currentAIMsgEl);
    // ★ 带 steps[] 的历史 Agent 消息也走 appendAgentMessage —— 否则会退化成
    //   appendChatMessage 的「深度思考 details + 单一正文气泡」，时间顺序步骤流全丢
    //   （用户切走再切回来就看不到「一步步」的过程了）。
    const isSteppedAgentMsg = msg.role === 'ai' && Array.isArray(msg.steps) && msg.steps.length > 0;
    const el = ((isStreamingLastAi && state.agentState) || isSteppedAgentMsg)
      ? appendAgentMessage(msg, { live: isStreamingLastAi && !!state.agentState })
      : appendChatMessage(msg);
    if (el && msg.role === 'ai') {
      lastAiMsgEl = el;
    }
  }

  // ★ 恢复当前会话的待办清单卡片（工具卡片本身不落库，只有清单单独恢复 —— 它是"任务目标"，
  //   用户切走再切回来必须还能看到做到哪一步了）
  const activeConv = state.conversations?.find(c => c.id === state.activeConversationId);
  if (activeConv && Array.isArray(activeConv.activeTodos) && activeConv.activeTodos.length) {
    if (activeConv.activeTodos.every(i => i.status === 'completed')) {
      // 全部完成的旧清单不再展示（自动关闭机制的兜底），静默清掉，不打扰用户
      clearActiveTodos(null);
    } else {
      const card = buildTodoCardEl(activeConv.activeTodos, (() => {
        const total = activeConv.activeTodos.length;
        const completed = activeConv.activeTodos.filter(i => i.status === 'completed').length;
        return { total, completed, percent: total ? Math.round(completed / total * 100) : 0 };
      })(), activeConv.activeTodoTitle);
      if (card) messagesContainer.appendChild(card);
    }
  }

  if (messages.length === 0) {
    const welcome = document.createElement('div');
    welcome.className = 'chat-message ai';
    // 欢迎消息不显示头像
    welcome.innerHTML = `
      <div style="flex:1;min-width:0;text-align:left;">
        <div class="chat-bubble" style="display:inline-block;text-align:left;">你好！我是灵汐，浮灵饰界的智能助手，很高兴认识你！我可以帮你：

· 回答问题、聊天解闷
· 管理本地文件
· 执行系统命令
· 安装/卸载软件
· 调用本地或云端AI

请先在"AI配置"页面设置AI模型，然后就可以和我对话啦！</div>
      </div>
    `;
    messagesContainer.appendChild(welcome);
  }

  messagesContainer.scrollTop = messagesContainer.scrollHeight;
  renderCompressNotice(); // 压缩状态提示（若正在/刚完成自动压缩）跟在最后
  renderContextBar();

  // ★ 修复：流式进行中重建 DOM 后，重新绑定正在生成的 AI 消息元素，
  // 避免切到其他功能页再切回 chat 时，正在生成的回复显示为空（用户误以为对话被关闭）。
  if (streamingToThisConv && lastAiMsgEl) {
    if (state.agentState) {
      // Agent 模式：重新绑定元素并按已记录的步骤流重建 DOM（顺序与折叠态都保持）
      state.agentState.currentMsgEl = lastAiMsgEl;
      const steps = state.agentState.steps || [];
      if (steps.length) {
        renderAgentSteps(lastAiMsgEl, steps, { collapsed: false, keepLive: true });
        dropAgentPlaceholder(lastAiMsgEl);
      } else {
        if (state.agentState.reasoning) {
          const rec = createAgentStep(lastAiMsgEl, 'think');
          if (rec) {
            rec.text = state.agentState.reasoning;
            const rContent = rec.el.querySelector('.agent-reasoning-content');
            if (rContent) { rContent.style.display = 'block'; rContent.textContent = rec.text; }
            const tg = rec.el.querySelector('.reasoning-toggle');
            if (tg) tg.style.transform = 'rotate(90deg)';
          }
        }
        if (state.agentState.content) {
          const rec = createAgentStep(lastAiMsgEl, 'text');
          if (rec) {
            rec.text = state.agentState.content;
            const bubble = rec.el.querySelector('.agent-content-bubble');
            if (bubble) {
              bubble.innerHTML = renderMarkdown(rec.text);
              bubble.dataset.originalContent = rec.text;
            }
          }
        }
      }
    } else if (state.currentAIMsgEl) {
      // 普通模式：重新绑定元素并恢复已积累的内容
      state.currentAIMsgEl = lastAiMsgEl;
      const bubble = lastAiMsgEl.querySelector('.chat-bubble');
      if (bubble && state.currentAIContent) {
        bubble.innerHTML = renderMarkdown(state.currentAIContent);
      }
    }
  }
}


// ==================== 上下文容量 & 会话压缩 ====================
// 上下文窗口（token）自动识别表：按模型名/提供商名匹配，用户可在 AI 配置里手动覆盖。
const CONTEXT_WINDOW_TABLE = [
  { re: /gemini/i, size: 1000000 },
  { re: /minimax|abab/i, size: 245000 },
  { re: /claude/i, size: 200000 },
  { re: /grok/i, size: 131072 },
  { re: /glm|chatglm|智谱/i, size: 128000 },
  { re: /moonshot|kimi/i, size: 128000 },
  { re: /gpt-4\.1|gpt-4o|gpt-4-turbo|o1-|o3-|o4-/i, size: 128000 },
  { re: /deepseek/i, size: 64000 },
  { re: /qwen|通义|tongyi/i, size: 32768 },
  { re: /doubao|豆包/i, size: 32768 },
  { re: /hunyuan|混元/i, size: 32768 },
  { re: /step-|阶跃/i, size: 32768 },
  { re: /spark|星火/i, size: 32768 },
  { re: /ernie|文心/i, size: 30000 },
  { re: /gpt-3\.5|gpt-35/i, size: 16384 },
  { re: /llama|mistral|gemma|phi-|qwen2\.5-coder/i, size: 8192 },
];
// ── 加工规则（transform.yaml）──────────────────────────────────────────────
// token 估算系数、截断预算、上下文水位全部由主进程经 ai:get-context-meta 下发，
// 下面的字面量只是「配置拿不到时的兜底」。同一个数字曾在这里和 aiOps.js 各写一份，
// 改一边容量条就漂 —— 现在只有transform.yaml 一个来源。
let TRANSFORM = null;

/** 按点路径读 transform 配置，如 tf('context.defaultWindow', 32768) */
function tf(dottedPath, fallback) {
  if (!TRANSFORM) return fallback;
  const parts = String(dottedPath).split('.');
  let cur = TRANSFORM;
  for (const k of parts) {
    if (!cur || typeof cur !== 'object') return fallback;
    cur = cur[k];
  }
  return cur === undefined || cur === null ? fallback : cur;
}

let DEFAULT_CONTEXT_WINDOW = 32768;   // 无法识别时的保守默认值（与 Ollama num_ctx 一致）
let AUTO_COMPRESS_THRESHOLD = 95;     // 上下文使用率超过该百分比时自动压缩（留足余量，别太早压）
let COMPRESS_KEEP_RECENT = 20;        // 压缩时保留最近的 N 条真实消息，其余压缩为摘要
let SINGLE_MESSAGE_TOKEN_CAP = 2000;  // 单条历史消息进入请求体的 token 上限（超出截断）
let CONTEXT_BAR_WARN = 70;            // 容量条变黄阈值(%)
let CONTEXT_BAR_DANGER = 90;          // 容量条变红阈值(%)
const CONTEXT_REQUEST_OVERHEAD = 256; // 请求体固定开销
const CONTEXT_MIN_BUDGET = 1000;      // 最低预算，防小窗口模型算出负数

/** 拿到主进程下发的加工规则后，用真实值覆盖兜底常量 */
function applyTransformRules(t) {
  if (!t) return;
  TRANSFORM = t;
  DEFAULT_CONTEXT_WINDOW   = tf('context.defaultWindow', DEFAULT_CONTEXT_WINDOW);
  AUTO_COMPRESS_THRESHOLD  = tf('context.autoCompressThreshold', AUTO_COMPRESS_THRESHOLD);
  COMPRESS_KEEP_RECENT     = tf('context.keepRecentMessages', COMPRESS_KEEP_RECENT);
  SINGLE_MESSAGE_TOKEN_CAP = tf('budget.singleMessageTokenCap', SINGLE_MESSAGE_TOKEN_CAP);
  CONTEXT_BAR_WARN         = tf('context.barWarn', CONTEXT_BAR_WARN);
  CONTEXT_BAR_DANGER       = tf('context.barDanger', CONTEXT_BAR_DANGER);
}

// 粗略 token 估算：CJK 约 1 字 1 token，其他按 transform.yaml 的 nonCjkRatio 折算（默认 0.26 ≈ 1/4）
// ⚠️ 系数来自主进程下发的 transform.yaml，不要在这里另写一份 —— 两边不一致会让容量条失真。
function estimateTokens(text) {
  if (!text) return 0;
  const s = typeof text === 'string' ? text : String(text);
  if (!s) return 0;
  const ratio = tf('tokenEstimate.nonCjkRatio', 0.26);
  const pattern = tf('tokenEstimate.cjkPattern', '[\\u2E80-\\u9FFF\\uF900-\\uFAFF\\uAC00-\\uD7AF\\uFF00-\\uFFEF]');
  let cjk = 0;
  try {
    cjk = (s.match(new RegExp(pattern, 'g')) || []).length;
  } catch (e) {
    cjk = (s.match(/[\u2E80-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF\uFF00-\uFFEF]/g) || []).length;
  }
  return Math.ceil(cjk + (s.length - cjk) * ratio);
}

function formatTokenCount(n) {
  const v = Math.max(0, Math.round(n || 0));
  if (v >= 1000000) return (v / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(v);
}

function getActiveProviderConfig() {
  return state.cloudProviders.find(p => p.id === state.activeProviderId) || null;
}

function isAgentModeEnabled() {
  return !!document.getElementById('agent-mode')?.checked;
}

// 上下文窗口：用户手动值优先，其次按模型名自动识别，最后保守默认
function getContextWindow(provider) {
  const override = parseInt(state.settings.ai?.contextWindow, 10);
  if (override > 0) return override;
  const p = provider || getActiveProviderConfig();
  const name = ((p?.model || '') + ' ' + (p?.name || '')).trim();
  if (name) {
    for (const item of CONTEXT_WINDOW_TABLE) if (item.re.test(name)) return item.size;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

function getContextWindowSource() {
  const override = parseInt(state.settings.ai?.contextWindow, 10);
  if (override > 0) return 'manual';
  const p = getActiveProviderConfig();
  const name = ((p?.model || '') + ' ' + (p?.name || '')).trim();
  if (name && CONTEXT_WINDOW_TABLE.some(item => item.re.test(name))) return 'auto';
  return 'default';
}

// 工具定义/系统提示词的真实开销在主进程（前端拿不到原文），启动后取一次缓存
let contextMetaCache = null;

async function primeContextMeta() {
  try {
    if (window.api?.getContextMeta) {
      const meta = await window.api.getContextMeta();
      if (meta && typeof meta.toolsTokens === 'number') {
        contextMetaCache = meta;
        // 加工规则先落地：后面的 token 估算、截断、容量条全都依赖它
        if (meta.transform) applyTransformRules(meta.transform);
        renderContextBar();
      }
    }
  } catch (e) { /* 忽略：拿不到就用兜底估算 */ }
  return contextMetaCache;
}

// 输出 token 预留：与主进程的 max_tokens 决策完全一致，否则"占用估算"会少算一大块，
// 导致上下文满了却不触发自动压缩、请求越过模型窗口上限。
// 主进程 agentChat：渲染层不传 maxTokens → 非 Ollama 时 tokens = thinkMode ? 8192 : 4096
// （思考模式固定预留 8192，保证"思考 + 工具调用"不被输出上限截断）。
function resolveOutputTokens(isAgent, userMaxTokens) {
  const cap = 32768;
  if (!isAgent) return Math.min(userMaxTokens || 2048, cap);
  const thinkMode = !!document.getElementById('agent-think-mode')?.checked;
  return Math.min(thinkMode ? 8192 : 4096, cap);
}

// 请求体的固定开销：系统提示词 + 工具定义 + 预留给模型输出的 token
function estimateBaseCost(isAgent, maxOutput) {
  const ai = state.settings.ai || {};
  let systemTokens = estimateTokens(ai.systemPrompt || '');
  const role = (state.agentRoles || []).find(r => r.id === state.currentRoleId);
  if (role?.systemPrompt) systemTokens = Math.max(systemTokens, estimateTokens(role.systemPrompt));
  if (isAgent) {
    // Agent 模式：主进程用 AGENT_SYSTEM_PROMPT（无自定义角色时）+ 工具调用强制要求 + few-shot 示例
    // 追加段（角色提示/强制要求/个性化/示例）的开销从 transform.agentOverhead 读
    systemTokens = Math.max(systemTokens, contextMetaCache?.systemPromptTokens || 0)
      + tf('agentOverhead.appendedPromptTokens', 600);
  }
  const toolsTokens = isAgent ? (contextMetaCache?.toolsTokens || tf('agentOverhead.fallbackToolsTokens', 3200)) : 0;
  return { systemTokens, toolsTokens, outputTokens: maxOutput, total: systemTokens + toolsTokens + maxOutput };
}

// 过长的历史消息在发送前截断（保留最新一条完整，避免正在回答的问题被切）
function trimHistoryContent(content, isLatest) {
  const text = content || '';
  if (isLatest) return text;
  const charCap = SINGLE_MESSAGE_TOKEN_CAP * 4;
  if (text.length <= charCap) return text;
  const kept = text.slice(0, charCap);
  const tpl = tf('budget.ellipsisTemplate', '\n……（历史消息过长，此处省略约 {tokens} tokens）');
  return kept + tpl.replace('{tokens}', formatTokenCount(estimateTokens(text) - estimateTokens(kept)));
}

// 把单条文本按估算 token 预算截断（从头保留，附省略说明；返回结果的估算 ≤ maxTokens）。
// 用于硬性上限兜底：最新一条消息本身大到放不进窗口时，也按预算截断，绝不发出必然被上游拒绝的请求。
function trimTextToTokens(text, maxTokens) {
  const s = text || '';
  if (!s || maxTokens <= 0) return s;
  if (estimateTokens(s) <= maxTokens) return s;
  // 收缩参数全部来自 transform.yaml：省略后缀预留、收缩比例/轮数、下限长度
  const SUFFIX_OVERHEAD = tf('budget.ellipsisOverheadTokens', 40);
  const SHRINK = tf('budget.shrinkRatio', 0.92);
  const MAX_ROUNDS = tf('budget.shrinkMaxRounds', 40);
  const MIN_KEEP = tf('budget.minKeepChars', 80);
  const tpl = tf('budget.hardCapEllipsisTemplate', '\n……（消息过长，此处省略约 {tokens} tokens）');
  const target = Math.max(MIN_KEEP, maxTokens - SUFFIX_OVERHEAD);
  // 先按"非中文 4 字符 ≈ 1 token"粗切，再按估算精确收缩（中文 1 字符 ≈ 1 token，只会更保守）
  let kept = s.slice(0, Math.max(MIN_KEEP, target * 4));
  let guard = 0;
  while (kept.length > MIN_KEEP && estimateTokens(kept) > target && guard++ < MAX_ROUNDS) {
    kept = kept.slice(0, Math.floor(kept.length * SHRINK));
  }
  let suffix = tpl.replace('{tokens}', formatTokenCount(estimateTokens(s) - estimateTokens(kept)));
  // 后缀可能把总估算带出预算，再收缩一次（正文）
  guard = 0;
  while (kept.length > MIN_KEEP && estimateTokens(kept + suffix) > maxTokens && guard++ < MAX_ROUNDS) {
    kept = kept.slice(0, Math.floor(kept.length * SHRINK));
    suffix = tpl.replace('{tokens}', formatTokenCount(estimateTokens(s) - estimateTokens(kept)));
  }
  return kept + suffix;
}

// 按上下文预算挑选要发送的历史消息：
// 从最新一条往前累积，直到预算用尽；摘要消息始终带上（它覆盖更早的历史）。
// 返回值可同时用于"实际发送"和"容量展示"，保证两者口径一致。
function buildOutgoingMessages(conv, opts = {}) {
  const ai = state.settings.ai || {};
  const provider = getActiveProviderConfig();
  const ctxWindow = getContextWindow(provider);
  const isAgent = opts.agent !== undefined ? !!opts.agent : isAgentModeEnabled();
  const maxOutput = resolveOutputTokens(isAgent, parseInt(ai.maxTokens, 10) || 0);
  const base = estimateBaseCost(isAgent, maxOutput);
  // 用最近一次真实 prompt_tokens 校准估算误差（仅普通模式校准；Agent 模式中间插入的工具消息前端看不到）
  // 校准因子收紧到 [0.9, 1.15]：避免历史校准因子把估算乘太高导致"没用完就提前压缩"
  const calib = Math.min(1.15, Math.max(0.9, Number(conv?.ctxCalib?.factor) || 1));
  const budget = Math.max(CONTEXT_MIN_BUDGET, ctxWindow - base.total - CONTEXT_REQUEST_OVERHEAD);

  const all = (conv?.messages || []).filter(m => m && typeof m.content === 'string' && m.content.trim());
  let summaryIdx = -1;
  for (let i = all.length - 1; i >= 0; i--) { if (all[i].isSummary) { summaryIdx = i; break; } }
  const afterSummary = summaryIdx >= 0 ? all.slice(summaryIdx + 1) : all;

  const kept = [];
  let historyTokens = 0;
  let historyChars = 0;
  let droppedFromWindow = 0;
  for (let i = afterSummary.length - 1; i >= 0; i--) {
    const m = afterSummary[i];
    const isLatest = i === afterSummary.length - 1;
    const content = trimHistoryContent(m.aiContent || m.content, isLatest);
    const cost = Math.ceil((estimateTokens(content) + 4) * calib);
    if (kept.length >= 2 && historyTokens + cost > budget) { droppedFromWindow = i + 1; break; }
    historyTokens += cost;
    historyChars += content.length;
    kept.unshift({ role: m.role, content });
  }

  const messages = [];
  if (summaryIdx >= 0) {
    const summaryContent = all[summaryIdx].content +
      '\n（说明：以上是更早对话的压缩摘要，作为背景信息参考，不是用户的原话。）';
    messages.push({ role: 'assistant', content: summaryContent });
    historyTokens += estimateTokens(summaryContent) + 4;
    historyChars += summaryContent.length;
  }
  messages.push(...kept);

  // —— 硬性上限：请求体（系统+工具+摘要+历史）估算必须 ≤ 上下文窗口，绝不发出会越过限制的请求 ——
  // 选择循环只对"历史"做预算，摘要与无条件保留的最新消息可能把总量顶破窗口，这里统一收口。
  let overLimit = false;
  if (historyTokens > budget && messages.length) {
    // ① 摘要超预算 → 先按预算的 20%（下限 200 token）截断摘要
    if (summaryIdx >= 0) {
      const summaryMax = Math.max(200, Math.floor(budget * 0.2));
      const before = messages[0].content;
      const trimmed = trimTextToTokens(before, summaryMax);
      if (trimmed.length < before.length) {
        historyTokens -= (estimateTokens(before) - estimateTokens(trimmed));
        historyChars -= before.length - trimmed.length;
        messages[0].content = trimmed;
      }
    }
    // ② 仍超 → 从最旧的历史开始丢弃（保留摘要与最新 1 条 = 用户当前消息），直到放得下
    let dropIdx = summaryIdx >= 0 ? 1 : 0;
    while (historyTokens > budget && messages.length > 1) {
      const removed = messages.splice(dropIdx, 1)[0];
      if (!removed) break;
      historyTokens -= estimateTokens(removed.content || '') + 4;
      historyChars -= (removed.content || '').length;
      droppedFromWindow++;
      if (dropIdx > 0 && messages.length <= 2) dropIdx = 1; // 摘要仍在最前
    }
    // ③ 仍超（最新一条本身超大）→ 把最新一条截断到剩余预算（下限 200 token）
    if (historyTokens > budget && messages.length) {
      const last = messages[messages.length - 1];
      const lastCost = estimateTokens(last.content || '') + 4;
      const avail = Math.max(200, budget - (historyTokens - lastCost));
      const before = last.content;
      const trimmed = trimTextToTokens(before, avail);
      historyTokens = historyTokens - lastCost + estimateTokens(trimmed) + 4;
      historyChars -= before.length - trimmed.length;
      last.content = trimmed;
      if (historyTokens > budget) overLimit = true; // 预算 <200 的极端配置才会走到
    }
  }

  // 输入框里还没发出去的内容也计入占用，让"发出去会不会超"一眼可见
  const draftEl = document.getElementById('chat-input');
  const draftText = draftEl ? String(draftEl.value || '').trim() : '';
  const draftTokens = draftText ? Math.ceil(estimateTokens(draftText) * calib) : 0;

  return {
    messages,
    stats: {
      ctxWindow, base, historyTokens, draftTokens,
      used: base.total + historyTokens + draftTokens,
      charCount: historyChars + draftText.length,
      keptCount: kept.length,
      droppedFromWindow,
      overLimit,
      // 摘要覆盖的原始消息条数（取摘要消息自带的元信息，压缩多次时是最新一轮的条数）
      coveredBySummary: summaryIdx >= 0 ? (all[summaryIdx].summaryMeta?.covered || 0) : 0,
      hasSummary: summaryIdx >= 0,
      calib, maxOutput, isAgent, budget
    }
  };
}

// 当前上下文占用（展示用）：单位与 buildOutgoingMessages 完全一致
function computeContextUsage(conv) {
  const built = buildOutgoingMessages(conv);
  const s = built.stats;
  const percent = s.ctxWindow > 0 ? Math.min(100, (s.used / s.ctxWindow) * 100) : 0;
  return { ...s, percent, calibrated: Math.abs(s.calib - 1) > 0.02 };
}

// 可压缩的真实消息条数（保留最近 N 条不动）
function countCompressible(conv) {
  const real = (conv?.messages || []).filter(m => m && typeof m.content === 'string' && m.content.trim() && !m.isSummary);
  return Math.max(0, real.length - COMPRESS_KEEP_RECENT);
}

function isAutoCompressEnabled() {
  // Agent 设置面板里的开关（与其它 Agent 开关同一个 localStorage 存档），默认开启
  try {
    const saved = localStorage.getItem(AGENT_SETTINGS_KEY);
    if (saved) {
      const s = JSON.parse(saved);
      if (typeof s.autoCompress === 'boolean') return s.autoCompress;
    }
  } catch (e) { /* 解析失败按默认值 */ }
  return state.settings.ai?.autoCompress !== false;  // 默认开启
}

const CTX_RING_CIRCUMFERENCE = 100.53; // 2πr, r=16（与 index.html/SVG 中一致）

function renderContextBar() {
  const bar = document.getElementById('ctx-bar');
  if (!bar) return;
  const conv = getActiveConversation();
  const usage = computeContextUsage(conv);
  const ringFill = document.getElementById('ctx-ring-fill');
  const percent = usage.percent;
  let level = 'ok';
  if (percent >= CONTEXT_BAR_DANGER) level = 'danger';
  else if (percent >= CONTEXT_BAR_WARN) level = 'warn';
  bar.dataset.level = level;

  const t = (k, p) => (window.I18N?.t ? window.I18N.t(k, p) : k);
  if (ringFill) {
    ringFill.style.strokeDashoffset = String(CTX_RING_CIRCUMFERENCE * (1 - Math.min(100, percent) / 100));
  }
  // 界面上不显示任何数字：用量只在悬停提示与点击后的明细里出现
  bar.title = t('chat.contextBarTip', {
    p: percent.toFixed(percent < 10 ? 1 : 0),
    used: formatTokenCount(usage.used),
    total: formatTokenCount(usage.ctxWindow),
    chars: usage.charCount.toLocaleString()
  });

  const popup = document.getElementById('ctx-popup');
  if (popup && popup.style.display !== 'none') {
    popup.innerHTML = buildContextPopupHTML(usage, conv);
    bindContextPopup(usage, conv);
    popup.style.display = 'block';
  }
}

function buildContextPopupHTML(usage, conv) {
  const t = (k, p) => (window.I18N?.t ? window.I18N.t(k, p) : k);
  const win = usage.ctxWindow || 1;
  const pctOf = (v) => (v / win) * 100;
  // 分段构成（占比按上下文窗口计算，与总量对齐）
  const segments = [
    { key: 'chat.ctxSystemPrompt', val: usage.base.systemTokens, color: '#8b5cf6' },
    { key: 'chat.ctxTools', val: usage.base.toolsTokens, color: '#22c55e' },
    { key: 'chat.ctxHistory', val: usage.historyTokens, color: '#f59e0b' },
    { key: 'chat.ctxOutput', val: usage.base.outputTokens, color: '#38bdf8' },
    { key: 'chat.ctxDraft', val: usage.draftTokens, color: '#ec4899' }
  ].filter(s => s.val > 0);

  let html = '<div class="ctx-popup-head">';
  html += '<span class="ctx-popup-title">' + t('chat.ctxDetailTitle') + '</span>';
  html += '<button type="button" class="ctx-popup-close" id="ctx-popup-close" aria-label="' + t('chat.ctxClose') + '">×</button>';
  html += '</div>';

  // 大号使用率 + 已使用量 / 窗口
  html += '<div class="ctx-popup-metric">';
  html += '<span class="ctx-popup-percent">' + usage.percent.toFixed(1) + '%</span>';
  html += '<span class="ctx-popup-used">' + t('chat.ctxUsedLabel') + ' ' + formatTokenCount(usage.used) +
    ' / ' + formatTokenCount(usage.ctxWindow) + '</span>';
  html += '</div>';

  // 分段色条 + 图例（每类给百分比）
  if (segments.length) {
    html += '<div class="ctx-seg-bar">';
    for (const s of segments) {
      html += '<span class="ctx-seg" style="width:' + Math.max(0.6, pctOf(s.val)).toFixed(2) +
        '%;background:' + s.color + '"></span>';
    }
    html += '</div>';
    html += '<div class="ctx-legend">';
    for (const s of segments) {
      html += '<div class="ctx-legend-item">' +
        '<span class="ctx-dot" style="background:' + s.color + '"></span>' +
        '<span class="ctx-legend-name">' + t(s.key) + '</span>' +
        '<span class="ctx-legend-val">' + pctOf(s.val).toFixed(1) + '%</span>' +
        '</div>';
    }
    html += '</div>';
  }

  // 一行紧凑统计 + 压缩入口（不再堆说明文字）
  const compressible = countCompressible(conv);
  html += '<div class="ctx-popup-foot">';
  if (compressible > 0) {
    html += '<button type="button" class="ctx-popup-action" id="ctx-compress-now"' +
      (state.isStreaming || state.compressBusy ? ' disabled' : '') + '>' +
      window.ElIcons.ICONS.archive + '<span>' +
      t(state.compressBusy ? 'chat.compressing' : 'chat.compressNow', { n: compressible }) + '</span></button>';
  }
  html += '<span class="ctx-auto-flag' + (isAutoCompressEnabled() ? ' on' : '') + '">' +
    t('chat.autoCompress') + '：' + t(isAutoCompressEnabled() ? 'chat.ctxAutoOnShort' : 'chat.ctxAutoOffShort') + '</span>';
  html += '</div>';
  return html;
}

function bindContextPopup(usage, conv) {
  const closeBtn = document.getElementById('ctx-popup-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const popup = document.getElementById('ctx-popup');
      if (popup) popup.style.display = 'none';
    });
  }
  const btn = document.getElementById('ctx-compress-now');
  if (btn) {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      // 弹窗刚打开的 250ms 内忽略点击：防止"打开弹窗那一下"被算成点了压缩按钮
      if (Date.now() - (state.ctxPopupOpenedAt || 0) < 250) return;
      const popup = document.getElementById('ctx-popup');
      if (popup) popup.style.display = 'none';
      await compressConversation({ auto: false });
    });
  }
}

function toggleContextPopup(force) {
  const popup = document.getElementById('ctx-popup');
  if (!popup) return;
  const show = force !== undefined ? force : popup.style.display === 'none';
  if (!show) { popup.style.display = 'none'; return; }
  state.ctxPopupOpenedAt = Date.now();
  const conv = getActiveConversation();
  const usage = computeContextUsage(conv);
  popup.innerHTML = buildContextPopupHTML(usage, conv);
  bindContextPopup(usage, conv);
  popup.style.display = 'block';
}

// ==================== 会话压缩 ====================
const SUMMARY_SYSTEM_PROMPT = `你是对话压缩助手。把一段正在进行的对话压缩成简洁但信息完整的摘要，供后续对话继续使用。
要求：
1. 保留：用户的目标与需求、已达成的结论与决定、关键事实/数据/文件路径/代码要点、未完成的任务与下一步、用户的偏好与约束、助手已执行的操作及其结果。
2. 舍弃：寒暄客套、重复内容、失败的中间尝试、可以重新推导的细节。
3. 输出中文，用要点列表，按「🎯 目标 / ✅ 已完成 / 📌 关键信息 / ⏭ 待办」四段组织；某段没有内容可省略。
4. 不要编造原文没有的信息，不要输出与摘要无关的解释。`;

function setCompressBusy(busy) {
  state.compressBusy = busy;
  // 界面上唯一的压缩入口在明细弹窗里，交给 renderContextBar 统一刷新（含"压缩中..."状态）
  renderContextBar();
}

// 把较早的历史消息（含旧摘要）交给当前模型压缩成一条摘要消息
async function compressConversation({ auto = false, keepRecent = COMPRESS_KEEP_RECENT } = {}) {
  const conv = getActiveConversation();
  if (!conv) return { success: false, error: 'no_conversation' };
  if (state.isStreaming) {
    if (!auto) showToast('暂时无法压缩', '请等待当前回复结束后再压缩上下文', 'warning');
    return { success: false, error: 'streaming' };
  }
  if (state.compressBusy) return { success: false, error: 'busy' };

  const arr = conv.messages || [];
  const realIdx = [];
  arr.forEach((m, i) => {
    if (m && typeof m.content === 'string' && m.content.trim() && !m.isSummary) realIdx.push(i);
  });
  if (realIdx.length <= keepRecent) {
    if (!auto) showToast('无需压缩', '当前会话消息较少，还不需要压缩上下文', 'warning');
    return { success: false, error: 'too_few_messages' };
  }

  const firstKeptIdx = realIdx[realIdx.length - keepRecent];
  const toCompress = arr.slice(0, firstKeptIdx).filter(m => m && typeof m.content === 'string' && m.content.trim());
  const tail = arr.slice(firstKeptIdx);
  if (!toCompress.length) return { success: false, error: 'too_few_messages' };

  let transcript = toCompress.map(m => {
    const who = m.isSummary ? '【此前摘要】' : (m.role === 'user' ? '用户' : '助手');
    return who + '：' + m.content;
  }).join('\n\n');
  const MAX_TRANSCRIPT_CHARS = 12000; // 控制压缩请求本身的体积（优先保留较新的内容）
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    transcript = '（更早的内容已省略）\n' + transcript.slice(transcript.length - MAX_TRANSCRIPT_CHARS);
  }

  // 压缩一律在聊天流里提示"压缩中 → 已压缩"，不再额外弹 toast；
  // 提示插在"被压缩的那段对话"末尾（firstKeptIdx 之前），作为压缩边界标记
  setCompressNotice('running', 0, firstKeptIdx);
  setCompressBusy(true);
  try {
    const res = await window.api.chat({
      messages: [{ role: 'user', content: '请把下面这段对话压缩成摘要（摘要是给后续对话看的背景资料）：\n\n' + transcript }],
      providerId: state.activeProviderId,
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      temperature: 0.3,
      maxTokens: 1536,
      silent: true
    });
    const summaryText = (res?.content || '').trim();
    if (!res || !res.success || !summaryText) {
      const err = res?.error || '模型未返回摘要内容';
      // 失败：流内显示"压缩失败"；手动压缩再补一个带原因的 toast
      setCompressNotice('failed', 6000);
      if (!auto) showToast('压缩失败', err, 'error');
      return { success: false, error: err };
    }

    const summaryMsg = {
      role: 'ai',
      content: '【历史对话摘要】\n' + summaryText,
      isSummary: true,
      time: Date.now(),
      summaryMeta: {
        covered: toCompress.length,
        kept: tail.length,
        model: getActiveProviderConfig()?.model || '',
        auto: !!auto,
        at: Date.now()
      }
    };
    // 保留全部原始消息，只在压缩边界插入一条摘要标记。
    // 模型侧：buildOutgoingMessages 只取"最后一条摘要 + 其后的最近消息"发给模型（更早的原文不再重发，节省上下文）；
    // 用户侧：完整对话历史一直保留在会话里、界面上照常可翻，不会因为压缩而丢失。
    conv.messages = [...arr.slice(0, firstKeptIdx), summaryMsg, ...tail];
    conv.ctxCalib = null; // 历史变了，之前的校准系数失效
    conv.updatedAt = Date.now();
    saveConversations();
    renderChat();
    renderContextBar();
    // 摘要卡片现在位于 DOM 第 firstKeptIdx 位（前面还压着保留的旧消息），
    // "已压缩"提示落在摘要卡片正下方 → 锚点 = firstKeptIdx + 1
    setCompressNotice('done', 5000, firstKeptIdx + 1);
    console.log('[Context] 压缩完成：压缩', toCompress.length, '条，保留', tail.length, '条，摘要', summaryText.length, '字符');
    return { success: true, covered: toCompress.length, summary: summaryText };
  } catch (e) {
    const err = e?.message || String(e);
    console.log('[Context] 压缩失败:', err);
    setCompressNotice('failed', 6000);
    if (!auto) showToast('压缩失败', err, 'error');
    return { success: false, error: err };
  } finally {
    setCompressBusy(false);
    renderContextBar();
  }
}

function t_(key, params) {
  return window.I18N?.t ? window.I18N.t(key, params) : key;
}

// ==================== 压缩状态提示（聊天流内，作为压缩边界标记） ====================
// 位置：紧跟在"被压缩的那段对话"之后（压缩中=最后一条被压缩消息之后；压缩完成=摘要卡片之后），
// 用一条虚线把它与压缩前的对话隔开，后面继续正常对话。
let compressNoticeSeq = 0;

// anchorIndex：插入位置（相对于 #chat-messages 的子元素下标）。不传就沿用上一次的位置。
function setCompressNotice(status, autoClearMs = 0, anchorIndex = null) {
  const seq = ++compressNoticeSeq;
  if (status) {
    const keepAnchor = anchorIndex !== null ? anchorIndex : (state.compressNotice ? state.compressNotice.anchorIndex : null);
    state.compressNotice = { status, anchorIndex: keepAnchor, at: Date.now() };
  } else {
    state.compressNotice = null;
  }
  renderCompressNotice();
  if (autoClearMs > 0) {
    setTimeout(() => {
      if (compressNoticeSeq !== seq) return; // 期间有新状态/已清理，忽略本次
      state.compressNotice = null;
      renderCompressNotice();
    }, autoClearMs);
  }
}

function renderCompressNotice() {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  container.querySelectorAll('.chat-compress-note').forEach(el => el.remove());
  const notice = state.compressNotice;
  if (!notice) return;
  const textKey = notice.status === 'running' ? 'chat.compressRunning'
    : (notice.status === 'done' ? 'chat.compressDone' : 'chat.compressFailed');
  const div = document.createElement('div');
  div.className = 'chat-compress-note ' + notice.status;
  div.innerHTML = '<span class="ccn-text">' + t_(textKey) + '</span>';
  // 插到压缩边界处（没有锚点时放到末尾）
  const kids = Array.from(container.children);
  const rawIdx = notice.anchorIndex === null || notice.anchorIndex === undefined ? kids.length : notice.anchorIndex;
  const idx = Math.max(0, Math.min(rawIdx, kids.length));
  container.insertBefore(div, kids[idx] || null);
}

// 摘要消息的折叠卡片式渲染
// 摘要消息：内容只作为上下文发给模型，**界面上不显示**。
// 但必须保留一个占位元素——#chat-messages 的元素与 conv.messages 是一条条对应的，
// 少了它会算错压缩提示的插入锚点。
function appendSummaryMessage(msg) {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  const card = document.createElement('div');
  card.className = 'chat-summary-card';
  card.dataset.summaryLength = String((msg.content || '').length);
  container.appendChild(card);
}

// 供自检脚本 / 调试使用（与 window.AccountAPI 同类，只读能力 + 主动压缩）
window.ContextAPI = {
  estimateTokens,
  formatTokenCount,
  getContextWindow,
  getContextWindowSource,
  buildOutgoingMessages,
  computeContextUsage,
  countCompressible,
  compressConversation,
  renderContextBar,
  toggleContextPopup,
  CONTEXT_WINDOW_TABLE
};


// ==================== Token 消耗统计栏 ====================
function renderTokenStatsBar(msgEl, usage, elapsedMs) {
  if (!msgEl) return;
  const bar = msgEl.querySelector('.token-stats-bar');
  if (!bar) return;

  // 兼容多种usage格式：OpenAI(prompt_tokens/completion_tokens)、其他(input_tokens/output_tokens)
  const promptTokensRaw = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
  const completionTokensRaw = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
  const totalTokens = usage?.total_tokens || (promptTokensRaw + completionTokensRaw);
  const seconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = seconds % 60;
  const timeStr = minutes > 0 ? minutes + 'm ' + remainSeconds + 's' : remainSeconds + 's';

  bar.style.display = 'flex';
  bar.style.alignItems = 'center';
  bar.style.gap = '16px';
  bar.style.fontSize = '12px';
  bar.style.color = '#888';
  bar.style.userSelect = 'none';
  bar.style.position = 'relative';

  let html = '';
  // Tokens 统计（可点击/悬停显示明细）
  if (totalTokens > 0) {
    html += '<div class="token-stats-item" style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;padding:2px 8px;border-radius:4px;transition:background 0.2s;">';
    html += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="fill:none;"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6M9 13h6M9 17h4"/></svg>';
    html += '<span>Tokens: <strong>' + totalTokens.toLocaleString() + '</strong></span>';
    html += '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="fill:none;"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>';
    html += '</div>';
  }
  // 耗时已移到思考面板头部（.reasoning-time「共用时」），底部不再重复显示
  bar.innerHTML = html;

  // 明细弹窗容器
  let detailPopup = null;
  let hoverTimer = null;

  const showDetail = function() {
    if (detailPopup) return;
    if (!usage) return;

    const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
    const completionTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
    const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? 0;
    const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens ?? 0;
    const cacheMissTokens = Math.max(0, promptTokens - cachedTokens);
    const replyTokens = Math.max(0, completionTokens - reasoningTokens);
    const cacheHitRate = promptTokens > 0 ? (cachedTokens / promptTokens * 100) : 0;

    // 使用项目统一的 .info-tip 样式（与温度提示相同）
    detailPopup = document.createElement('div');
    detailPopup.className = 'info-tip';
    detailPopup.style.cssText = 'position:absolute;z-index:99999;bottom:100%;left:0;margin-bottom:8px;min-width:260px;max-width:320px;pointer-events:auto;';
    let popupHtml = '<div class="tip-title">Token 消耗明细</div>';
    popupHtml += '<div class="tip-section">总计</div>';
    popupHtml += '<div class="tip-list">';
    popupHtml += '<div class="tip-item"><span class="tip-tag">总 Tokens</span><span class="tip-val default">' + totalTokens.toLocaleString() + '</span></div>';
    popupHtml += '</div>';
    popupHtml += '<div class="tip-section" style="margin-top:8px;">输入</div>';
    popupHtml += '<div class="tip-list">';
    popupHtml += '<div class="tip-item"><span class="tip-tag">输入总量</span><span class="tip-val">' + promptTokens.toLocaleString() + '</span></div>';
    popupHtml += '<div class="tip-item"><span class="tip-tag">缓存命中</span><span class="tip-val">' + cachedTokens.toLocaleString() + '</span></div>';
    popupHtml += '<div class="tip-item"><span class="tip-tag">缓存未命中</span><span class="tip-val">' + cacheMissTokens.toLocaleString() + '</span></div>';
    popupHtml += '</div>';
    popupHtml += '<div class="tip-section" style="margin-top:8px;">输出</div>';
    popupHtml += '<div class="tip-list">';
    popupHtml += '<div class="tip-item"><span class="tip-tag">输出总量</span><span class="tip-val">' + completionTokens.toLocaleString() + '</span></div>';
    popupHtml += '<div class="tip-item"><span class="tip-tag">思考过程</span><span class="tip-val">' + reasoningTokens.toLocaleString() + '</span></div>';
    popupHtml += '<div class="tip-item"><span class="tip-tag">回复内容</span><span class="tip-val">' + replyTokens.toLocaleString() + '</span></div>';
    popupHtml += '</div>';
    popupHtml += '<div class="tip-section" style="margin-top:8px;">缓存命中率</div>';
    popupHtml += '<div class="tip-list">';
    popupHtml += '<div class="tip-item"><span class="tip-tag">命中率</span><span class="tip-val default">' + cacheHitRate.toFixed(1) + '%</span></div>';
    popupHtml += '</div>';
    detailPopup.innerHTML = popupHtml;
    // 手动添加visible类以触发动画
    requestAnimationFrame(() => detailPopup.classList.add('visible'));

    bar.appendChild(detailPopup);
  };

  const hideDetail = function() {
    if (detailPopup) {
      detailPopup.remove();
      detailPopup = null;
    }
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
  };

  // 绑定 Tokens 项的点击和悬停事件
  const tokenItem = bar.querySelector('.token-stats-item');
  if (tokenItem) {
    tokenItem.addEventListener('click', function(e) {
      e.stopPropagation();
      if (detailPopup) {
        hideDetail();
      } else {
        showDetail();
      }
    });
    tokenItem.addEventListener('mouseenter', function() {
      hoverTimer = setTimeout(showDetail, 300);
    });
    tokenItem.addEventListener('mouseleave', function() {
      if (hoverTimer) {
        clearTimeout(hoverTimer);
        hoverTimer = null;
      }
      // 延迟隐藏，方便鼠标移动到弹窗
      setTimeout(function() {
        if (!detailPopup?.matches(':hover')) {
          hideDetail();
        }
      }, 200);
    });
    // 悬停效果
    tokenItem.addEventListener('mouseenter', function() {
      tokenItem.style.background = 'rgba(99,102,241,0.1)';
    });
    tokenItem.addEventListener('mouseleave', function() {
      tokenItem.style.background = 'transparent';
    });
  }

  // 点击其他地方关闭弹窗
  document.addEventListener('click', function(e) {
    if (detailPopup && !bar.contains(e.target)) {
      hideDetail();
    }
  });
}

// ==================== 消息操作栏绑定（共享） ====================
function bindMessageActionBar(messageDiv, msg) {
  const actionBar = messageDiv.querySelector('.msg-action-bar');
  if (!actionBar) return;
  actionBar.querySelectorAll('.ma-btn').forEach(btn => {
    btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--bg-hover)'; btn.style.color = 'var(--text-primary)'; });
    btn.addEventListener('mouseleave', () => {
      if (!btn.dataset.active) { btn.style.background = 'transparent'; btn.style.color = 'var(--text-muted)'; }
    });
  });
  // 复制
  const copyBtn = actionBar.querySelector('.ma-copy');
  if (copyBtn) {
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const text = msg.content || '';
      try { await navigator.clipboard.writeText(text); }
      catch (_) {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch (__) {}
        document.body.removeChild(ta);
      }
      const orig = copyBtn.innerHTML;
      copyBtn.innerHTML = '✓'; copyBtn.style.color = 'var(--accent)';
      setTimeout(() => { copyBtn.innerHTML = orig; copyBtn.style.color = 'var(--text-muted)'; }, 1500);
    });
  }
  // 点赞/点踩（互斥）
  const likeBtn = actionBar.querySelector('.ma-like');
  const dislikeBtn = actionBar.querySelector('.ma-dislike');
  if (likeBtn && dislikeBtn) {
    likeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const active = likeBtn.dataset.active === '1';
      likeBtn.dataset.active = active ? '0' : '1';
      likeBtn.style.color = active ? 'var(--text-muted)' : '#4f46e5';
      likeBtn.style.background = active ? 'transparent' : 'rgba(79,70,229,0.1)';
      dislikeBtn.dataset.active = '0';
      dislikeBtn.style.color = 'var(--text-muted)';
      dislikeBtn.style.background = 'transparent';
    });
    dislikeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const active = dislikeBtn.dataset.active === '1';
      dislikeBtn.dataset.active = active ? '0' : '1';
      dislikeBtn.style.color = active ? 'var(--text-muted)' : '#ef4444';
      dislikeBtn.style.background = active ? 'transparent' : 'rgba(239,68,68,0.1)';
      likeBtn.dataset.active = '0';
      likeBtn.style.color = 'var(--text-muted)';
      likeBtn.style.background = 'transparent';
    });
  }
  // 朗读
  const volumeBtn = actionBar.querySelector('.ma-volume');
  if (volumeBtn) {
    volumeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (window.speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
        volumeBtn.style.color = 'var(--text-muted)';
        volumeBtn.dataset.speaking = '0';
        return;
      }
      const utter = new SpeechSynthesisUtterance(msg.content || '');
      utter.lang = 'zh-CN'; utter.rate = 1;
      utter.onend = () => { volumeBtn.style.color = 'var(--text-muted)'; volumeBtn.dataset.speaking = '0'; };
      volumeBtn.style.color = 'var(--accent)';
      volumeBtn.dataset.speaking = '1';
      window.speechSynthesis.speak(utter);
    });
  }
  // 重新生成
  // ★ 旧实现把提问塞回输入框再 sendChatMessage() —— 那会在会话里再插一条用户消息（等于"重发"），
  //   而且回答进行中会被 state.isStreaming 挡掉、点了没反应。现在走 regenerateFromAi：
  //   删除这条旧回答、基于其上一条提问原地重新生成；回答进行中则排队，结束后自动执行。
  const refreshBtn = actionBar.querySelector('.ma-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      regenerateFromAi(msg);
    });
  }
  // 分享
  const shareBtn = actionBar.querySelector('.ma-share');
  if (shareBtn) {
    shareBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const text = msg.content || '';
      try { await navigator.clipboard.writeText(text); } catch (_) {}
      const orig = shareBtn.innerHTML;
      shareBtn.innerHTML = '✓'; shareBtn.style.color = 'var(--accent)';
      setTimeout(() => { shareBtn.innerHTML = orig; shareBtn.style.color = 'var(--text-muted)'; }, 1500);
    });
  }
  // 更多菜单（AI消息）
  const moreBtn = actionBar.querySelector('.ma-more');
  if (moreBtn) {
    moreBtn.addEventListener('click', (e) => { e.stopPropagation(); showDeleteMenu(e, messageDiv, msg); });
  }
  // 用户消息删除
  const userDelBtn = actionBar.querySelector('.ma-delete');
  if (userDelBtn) {
    userDelBtn.addEventListener('click', (e) => { e.stopPropagation(); showDeleteMenu(e, messageDiv, msg); });
  }
}

function appendChatMessage(msg) {
  // 压缩摘要消息用独立的折叠卡片渲染，不参与普通气泡布局
  if (msg && msg.isSummary) { appendSummaryMessage(msg); return null; }
  const container = document.getElementById('chat-messages');
  const messageDiv = document.createElement('div');
  messageDiv.className = `chat-message ${msg.role}`;
  // 用户消息显示头像，AI消息不显示头像
  // 优先使用登录用户的真实头像，未登录/无头像时回退为默认 user 图标
  let avatarHtml = '';
  if (msg.role === 'user') {
    const curUser = window.AccountAPI?.getCurrentUser?.();
    const avatarUrl = curUser?.avatar_url;
    avatarHtml = avatarUrl
      ? `<div class="chat-avatar"><img src="${avatarUrl}" alt="avatar" onerror="this.remove()"></div>`
      : `<div class="chat-avatar"><span class="el-icon">${window.ElIcons.ICONS.user}</span></div>`;
  }
  // 豆包风格操作栏
  const _I = window.ElIcons.ICONS;
  const _btnStyle = 'display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;background:transparent;border-radius:6px;cursor:pointer;color:var(--text-muted);font-size:16px;transition:background 0.15s,color 0.15s;';
  const _timeHtml = '<span class="message-time" style="margin-right:8px;color:var(--text-muted);font-size:12px;">' + new Date(msg.time).toLocaleTimeString() + '</span>';
  const actionBarHtml = msg.role === 'ai'
    ? '<div class="msg-action-bar" style="display:flex;align-items:center;gap:2px;justify-content:flex-start;margin-top:6px;opacity:1;transition:opacity 0.15s;">'
      + _timeHtml
      + '<button class="ma-btn ma-copy" title="复制" style="' + _btnStyle + '">' + _I.copy + '</button>'
      + '<button class="ma-btn ma-like" title="点赞" style="' + _btnStyle + '">' + _I.like + '</button>'
      + '<button class="ma-btn ma-dislike" title="点踩" style="' + _btnStyle + '">' + _I.dislike + '</button>'
      + '<button class="ma-btn ma-volume" title="朗读" style="' + _btnStyle + '">' + _I.volume + '</button>'
      + '<button class="ma-btn ma-refresh" title="重新生成" style="' + _btnStyle + '">' + _I.refresh + '</button>'
      + '<button class="ma-btn ma-share" title="分享" style="' + _btnStyle + '">' + _I.share + '</button>'
      + '<button class="ma-btn ma-more" title="更多" style="' + _btnStyle + '">' + _I.more + '</button>'
      + '</div>'
    : '<div class="msg-action-bar" style="display:flex;align-items:center;gap:2px;justify-content:flex-end;margin-top:6px;opacity:1;transition:opacity 0.15s;">'
      + _timeHtml
      + '<button class="ma-btn ma-delete" title="删除" style="' + _btnStyle + '">' + _I.delete + '</button>'
      + '</div>';

  messageDiv.innerHTML = `
    ${avatarHtml}
    <div style="flex:1;min-width:0;text-align:${msg.role === 'user' ? 'right' : 'left'};">
      <div class="chat-bubble" style="display:inline-block;text-align:left;"></div>
      <!-- 编辑区域（默认隐藏）- 气泡样式，inline-block与原气泡布局一致 -->
      <div class="message-edit-area" style="display:none;vertical-align:top;">
        <div style="display:inline-block;max-width:100%;text-align:right;">
          <div class="message-edit-bubble" style="display:inline-block;max-width:100%;background:transparent;border:1.5px solid var(--accent);border-radius:18px;border-bottom-right-radius:6px;box-shadow:0 0 12px var(--accent-glow),inset 0 0 8px rgba(79,195,247,0.05);padding:0;vertical-align:top;text-align:left;position:relative;overflow:hidden;">
            <textarea class="message-edit-textarea" style="width:100%;min-height:44px;padding:10px 14px;margin:0;background:transparent;color:var(--text-primary);border:none;outline:none;box-shadow:none;resize:none;font-size:14px;line-height:1.7;font-family:inherit;box-sizing:border-box;overflow:hidden;display:block;"></textarea>
          </div>
          <div style="display:flex;gap:8px;margin-top:8px;justify-content:flex-end;">
            <button class="message-edit-cancel" style="padding:6px 16px;background:var(--bg-tertiary);color:var(--accent);border:1px solid var(--border-color);border-radius:6px;cursor:pointer;font-size:13px;transition:all 0.2s;">取消</button>
            <button class="message-edit-send" style="padding:6px 16px;background:var(--bg-tertiary);color:var(--accent);border:1px solid var(--accent);border-radius:6px;cursor:pointer;font-size:13px;transition:all 0.2s;">发送</button>
          </div>
        </div>
      </div>
      ${actionBarHtml}

      <div class="token-stats-bar" style="display:none;margin-top:6px;"></div>
    </div>
  `;
    const bubble = messageDiv.querySelector('.chat-bubble');
  // 保存原始文本，用于双击编辑
  bubble.dataset.originalContent = msg.content || '';
  // AI消息使用Markdown渲染，用户消息保持纯文本
  if (msg.role === 'ai') {
    // 历史消息带思考过程时（多模态/普通路径持久化的），先渲染折叠思考区
    let reasoningHtml = '';
    if (msg.reasoning) {
      reasoningHtml = '<details class="msg-reasoning-hist" style="border-left:2px solid var(--border-color,#444);padding:2px 0 2px 10px;margin-bottom:8px;">'
        + '<summary style="cursor:pointer;color:var(--text-muted,#888);font-size:12px;user-select:none;">深度思考</summary>'
        + '<div style="color:var(--text-secondary,#a8b0c0);font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word;margin-top:4px;">'
        + escapeHtml(msg.reasoning) + '</div></details>';
    }
    bubble.innerHTML = reasoningHtml + renderMarkdown(msg.content);
  } else {
    bubble.textContent = msg.content;
  }
  // 用户消息有多模态图片时，渲染缩略图（此前 msg.images 从未被渲染，发图后气泡里看不到）
  if (msg.role === 'user' && msg.images && msg.images.length > 0) {
    const imgDiv = document.createElement('div');
    imgDiv.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;justify-content:flex-end;';
    msg.images.forEach(im => {
      if (!im || !im.dataUrl) return;
      const img = document.createElement('img');
      img.src = im.dataUrl;
      img.alt = im.name || '图片';
      img.title = (im.name || '图片') + '（点击放大）';
      img.style.cssText = 'max-width:180px;max-height:140px;border-radius:10px;border:1px solid var(--border-color);object-fit:cover;cursor:zoom-in;';
      img.addEventListener('click', () => {
        // 轻量灯箱：点图放大，点任意处关闭
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:20000;background:rgba(0,0,0,0.82);display:flex;align-items:center;justify-content:center;cursor:zoom-out;';
        const big = document.createElement('img');
        big.src = im.dataUrl;
        big.style.cssText = 'max-width:88vw;max-height:88vh;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,0.6);';
        overlay.appendChild(big);
        overlay.addEventListener('click', () => overlay.remove());
        document.body.appendChild(overlay);
      });
      imgDiv.appendChild(img);
    });
    bubble.appendChild(imgDiv);
  }
  // 用户消息有附件时，显示文件图标标签
  if (msg.role === 'user' && msg.attachments && msg.attachments.length > 0) {
    const attachDiv = document.createElement('div');
    attachDiv.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;';
    msg.attachments.forEach(att => {
      const isDir = att.name && !att.name.includes('.');
      const icon = isDir ? window.ElIcons.ICONS.folder : window.ElIcons.ICONS.document;
      const tag = document.createElement('div');
      tag.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:3px 10px;background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.3);border-radius:12px;font-size:12px;cursor:default;';
      tag.title = att.path || '';
      tag.innerHTML = `<span>${icon}</span><span>${att.name}</span>`;
      attachDiv.appendChild(tag);
    });
    bubble.appendChild(attachDiv);
  }
  if (msg.role === 'user') {
    messageDiv.style.cursor = 'pointer';
    messageDiv.title = '双击编辑重发';
    messageDiv.addEventListener('dblclick', () => {
      const bubble = messageDiv.querySelector('.chat-bubble');
      const editArea = messageDiv.querySelector('.message-edit-area');
      const textarea = messageDiv.querySelector('.message-edit-textarea');
      const cancelBtn = messageDiv.querySelector('.message-edit-cancel');
      const sendBtn = messageDiv.querySelector('.message-edit-send');
      
      if (!editArea || !textarea) return;
      
      // 停止当前生成
      if (state.isStreaming && window.api.cancelChat) window.api.cancelChat();
      
      // 保存原始文本
      const originalText = bubble.dataset.originalContent || bubble.textContent;
      
      // 显示编辑区域，隐藏原消息气泡（使用inline-block保持布局一致）
      bubble.style.display = 'none';
      editArea.style.display = 'inline-block';
      textarea.value = originalText;
      
      // 自动调整高度函数（完全根据内容调整，无最大高度限制）
      const autoResize = () => {
        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 'px';
      };
      
      // 自动调整高度并聚焦
      setTimeout(() => {
        autoResize();
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      }, 0);
      
      // 取消按钮：恢复原消息，不删除任何内容
      const cancelEdit = () => {
        editArea.style.display = 'none';
        bubble.style.display = 'inline-block';
        // 移除事件监听，避免重复绑定
        cancelBtn.removeEventListener('click', cancelEdit);
        sendBtn.removeEventListener('click', sendEdit);
        textarea.removeEventListener('keydown', handleKeydown);
      };
      
      // 发送按钮：删除该消息及之后的消息，重新发送
      const sendEdit = () => {
        const newContent = textarea.value.trim();
        if (!newContent) return;
        
        // 删除该消息及之后的所有消息
        const container = document.getElementById('chat-messages');
        let sibling = messageDiv;
        while (sibling) { const next = sibling.nextSibling; container.removeChild(sibling); sibling = next; }
        
        // 同步会话历史
        const conv = getActiveConversation();
        if (conv) {
          const idx = conv.messages.findIndex(m => m.time === msg.time && m.content === originalText);
          if (idx >= 0) conv.messages = conv.messages.slice(0, idx);
          state.chatHistory = conv.messages;
          saveConversations();
        }
        
        // 发送编辑后的内容
        const input = document.getElementById('chat-input');
        if (input) {
          input.value = newContent;
          sendChatMessage();
        }
      };
      
      // 键盘事件：Ctrl+Enter发送，Esc取消
      const handleKeydown = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          cancelEdit();
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          sendEdit();
        }
      };
      
      // 绑定事件
      cancelBtn.addEventListener('click', cancelEdit);
      sendBtn.addEventListener('click', sendEdit);
      textarea.addEventListener('keydown', handleKeydown);
      
      // 输入时自动调整高度（完全根据内容调整）
      textarea.addEventListener('input', autoResize);
    });
  }

  bindMessageActionBar(messageDiv, msg);

  container.appendChild(messageDiv);
  container.scrollTop = container.scrollHeight;
  // 加载历史消息时恢复 Token 消耗统计栏渲染
  if (msg.role === 'ai' && (msg.usage || msg.elapsedMs > 0)) {
    setTimeout(() => renderTokenStatsBar(messageDiv, msg.usage, msg.elapsedMs), 0);
  }
  // 登记消息对象 ↔ DOM（供待发送提示条 / 重新生成删除旧回答使用）
  setMsgEl(msg, messageDiv);
  if (msg.pending) updatePendingBadge(msg);
  return messageDiv;
}

// ==================== 消息删除功能 ====================
let _deleteMenuEl = null;

function showDeleteMenu(event, messageDiv, msg) {
  closeDeleteMenu();
  const menu = document.createElement('div');
  menu.className = 'msg-delete-menu';
  menu.style.cssText = 'position:fixed;z-index:99999;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,0.3);padding:4px;min-width:160px;';
  const items = [];
  if (msg.role === 'ai') {
    items.push({ label: '回答不对，删除此组', action: 'bad-answer' });
  } else {
    items.push({ label: '提问错误，删除此组', action: 'bad-question' });
  }
  items.push({ label: '仅删除此条消息', action: 'single' });
  items.push({ label: '取消', action: 'cancel' });
  items.forEach(item => {
    const btn = document.createElement('div');
    btn.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:pointer;border-radius:6px;font-size:13px;color:var(--text-primary);transition:background 0.15s;';
    btn.textContent = item.label;
    btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--bg-hover)'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (item.action !== 'cancel') executeDelete(messageDiv, msg, item.action);
      closeDeleteMenu();
    });
    menu.appendChild(btn);
  });
  document.body.appendChild(menu);
  _deleteMenuEl = menu;
  const rect = event.target.getBoundingClientRect();
  let x = rect.left, y = rect.bottom + 4;
  const menuRect = menu.getBoundingClientRect();
  if (x + menuRect.width > window.innerWidth) x = window.innerWidth - menuRect.width - 8;
  if (y + menuRect.height > window.innerHeight) y = rect.top - menuRect.height - 4;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  setTimeout(() => document.addEventListener('click', closeDeleteMenu, { once: true }), 0);
}

function closeDeleteMenu() {
  if (_deleteMenuEl) { _deleteMenuEl.remove(); _deleteMenuEl = null; }
}

function executeDelete(messageDiv, msg, action) {
  const conv = getActiveConversation();
  if (!conv || !conv.messages) return;
  const idx = conv.messages.findIndex(m => m.time === msg.time && m.content === msg.content);
  if (idx < 0) return;
  let indicesToRemove = [idx];
  if (action === 'bad-answer' && msg.role === 'ai') {
    for (let i = idx - 1; i >= 0; i--) {
      if (conv.messages[i].role === 'user') { indicesToRemove.push(i); break; }
    }
  } else if (action === 'bad-question' && msg.role === 'user') {
    for (let i = idx + 1; i < conv.messages.length; i++) {
      if (conv.messages[i].role === 'ai') { indicesToRemove.push(i); break; }
    }
  }
  indicesToRemove.sort((a, b) => b - a).forEach(i => conv.messages.splice(i, 1));
  state.chatHistory = conv.messages;
  saveConversations();
  // ★ 实时更新：数据是唯一真相，整体重渲染。
  //   旧实现按 originalContent+时间文本扫描 DOM 删节点 —— Agent 消息
  //   （.agent-content-bubble）和 Markdown 渲染后的气泡经常匹配不上，
  //   结果数据删了、界面还挂着旧消息，切一次会话才消失（用户反馈
  //   「删除对话不能实时更新」）。renderChat 内含流式元素重绑定逻辑，
  //   正在生成时删除也不会丢流。
  renderChat();
}

// ==================== Agent 步骤流（时间顺序） ====================
// 旧结构把一轮处理的内容按「类型」分堆：思考全在顶部 .agent-reasoning-section、
// 工具全在中段 .agent-tools-section、正文全在底部一个气泡 —— 用户看到的是
// 「思考过程 + 结果」两块，看不出中间发生了什么（用户反馈「没有一步步的过程」）。
// 新结构：一轮处理 = .agent-steps 里的**时间顺序兄弟节点**，每步一个 .agent-step
//   think 思考块（可折叠） / tool 工具执行行 / text 叙述正文块 / todo 清单卡 / ask 询问卡
// 同类步骤被别的步骤打断后再出现 → 开新步（不合并），因此顺序即真实发生顺序。
// 事件实时追加 → 步骤记录（steps[]）落库 → 历史渲染按 steps 复原；老消息无 steps 时
// 回退旧的分组结构（reasoning + tools + content），保证旧会话照样能看。

/** 取（必要时创建）Agent 消息里的步骤流容器 */
function getAgentStepsRoot(msgEl) {
  if (!msgEl) return null;
  let root = msgEl.querySelector(':scope > div > .agent-steps');
  if (!root) {
    root = document.createElement('div');
    root.className = 'agent-steps';
    const body = msgEl.querySelector(':scope > div');
    if (body) body.insertBefore(root, body.firstChild);
    else msgEl.insertBefore(root, msgEl.firstChild);
  }
  return root;
}

/** 关掉某类「当前步」（后续同类事件会开新步），不改变已渲染内容 */
function closeAgentStep(kind) {
  const st = state.agentState;
  if (st && st.stepEls) st.stepEls[kind] = null;
}

// ==================== 正文步流式渲染节流 ====================
// ★ 卡顿根因：agent-content 每个 chunk 都 bubble.innerHTML = renderMarkdown(累计全文)，
//   Markdown 全量重解析随回答变长线性变贵 → 整场流式 O(N²)，长回答/多代码块时页面卡死。
//   改为 90ms 合并渲染：chunk 只追加文本，定时器到点才渲染最新内容一次。
const AGENT_TEXT_RENDER_MS = 90;

function renderAgentTextStep(rec) {
  if (!rec || !rec.el || !rec.el.isConnected) return;
  const bubble = rec.el.querySelector('.agent-content-bubble');
  if (!bubble) return;
  bubble.style.display = '';
  if (bubble.querySelector('.loading-text')) bubble.innerHTML = '';
  bubble.dataset.originalContent = rec.text;
  bubble.innerHTML = renderMarkdown(rec.text);
}

function scheduleAgentTextRender(rec) {
  if (!rec || rec._renderTimer) return;
  rec._renderTimer = setTimeout(() => {
    rec._renderTimer = null;
    renderAgentTextStep(rec);
  }, AGENT_TEXT_RENDER_MS);
}

/** 流结束时冲刷未渲染的尾部，保证最终内容完整（agent-done/取消时调用） */
function flushAgentTextRender(rec) {
  if (rec && rec._renderTimer) {
    clearTimeout(rec._renderTimer);
    rec._renderTimer = null;
    renderAgentTextStep(rec);
  }
}

/** 新建一个步骤节点并挂到步骤流末尾；返回 { rec, el } */
function createAgentStep(msgEl, kind, init) {
  const root = getAgentStepsRoot(msgEl);
  if (!root) return null;
  const step = document.createElement('div');
  step.className = 'agent-step agent-step-' + kind;
  step.dataset.step = kind;
  if (kind === 'think') {
    step.innerHTML = '<div class="agent-reasoning-section" style="margin-bottom:0;">'
      + '<div class="agent-reasoning-header" style="cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px;color:var(--text-muted);font-size:13px;padding:4px 0;">'
      + '<span class="reasoning-toggle" style="transition:transform 0.2s;display:inline-block;">›</span>'
      + '<span class="reasoning-time">思考中...</span></div>'
      + '<div class="agent-reasoning-content" style="display:none;padding:8px 0;font-size:13px;color:var(--text-secondary);line-height:1.6;white-space:pre-wrap;word-break:break-word;"></div>'
      + '</div>';
  } else if (kind === 'text') {
    step.innerHTML = '<div class="chat-bubble agent-content-bubble" style="min-height:24px;display:inline-block;text-align:left;"><span class="loading-text">等待模型响应...</span></div>';
  }
  root.appendChild(step);
  const rec = Object.assign({ kind: kind, text: '' }, init || {});
  rec.t0 = rec.t0 || Date.now();
  rec.el = step;
  if (state.agentState) {
    if (!state.agentState.steps) state.agentState.steps = [];
    state.agentState.steps.push(rec);
    if (!state.agentState.stepEls) state.agentState.stepEls = {};
    state.agentState.stepEls[kind] = rec;
  }
  return rec;
}

/** 拿到（或新建）某类「当前步」——同类连续事件累积到同一步里 */
function ensureAgentStep(msgEl, kind, init) {
  const st = state.agentState;
  if (st && st.stepEls && st.stepEls[kind] && st.stepEls[kind].el && st.stepEls[kind].el.isConnected) {
    return st.stepEls[kind];
  }
  return createAgentStep(msgEl, kind, init);
}

/**
 * 思考步收尾：把头部标题从「思考中...」定稿，**并自动收起内容**。
 * 思考是一次性的：流式时展开让用户看到在想什么，一结束就折叠。
 *
 * @param {object} rec 思考步记录
 * @param {boolean} [final=false] 是否为整轮最终结束。
 *   - false（中间被工具/正文打断）：只折叠内容，头部标题**不写"思考结束"**，
 *     避免多轮 agent 过程中反复出现"思考结束 · 用时 X 秒"。
 *   - true（整轮回答完毕）：才把头部定稿为"思考结束 · 用时 X 秒"。
 *   整轮结束后还会由 finalizeAgentProcess 统一写"已完成 · 用时 X 秒"总览行并折叠全部过程。
 */
function sealAgentThinkStep(rec, final) {
  if (!rec || !rec.el) return;
  // ★ 冲思考流的节流尾巴，再收起（收起时 DOM 里已是完整内容）
  if (rec._thinkTimer) {
    clearTimeout(rec._thinkTimer);
    rec._thinkTimer = null;
    const c0 = rec.el.querySelector('.agent-reasoning-content');
    if (c0) { c0.style.display = 'block'; c0.textContent = rec.text; }
  }
  const c = rec.el.querySelector('.agent-reasoning-content');
  const tg = rec.el.querySelector('.reasoning-toggle');
  // 空思考块（闲聊/强制关思考时模型没输出 reasoning）：不留一个空壳，直接移除
  const textLen = (rec.text || '').trim().length;
  if (textLen === 0) {
    try { rec.el.remove(); } catch (e) { /* 已不在 DOM */ }
    return;
  }
  if (!rec.sealed) {
    rec.sealed = true;
    const timeEl = rec.el.querySelector('.reasoning-time');
    if (timeEl) {
      if (final) {
        const sec = Math.max(0, Date.now() - (rec.t0 || Date.now())) / 1000;
        timeEl.textContent = sec >= 0.5
          ? ('思考结束 · 用时 ' + (sec >= 10 ? sec.toFixed(0) : sec.toFixed(1)) + ' 秒')
          : '思考结束';
      } else {
        // 中间打断：不写"思考结束"，只把"思考中..."收掉，避免刷屏
        timeEl.textContent = '思考';
      }
    }
  }
  // 收起内容（收起时仍在 DOM 里，点头部可再展开）
  if (c && c.style.display !== 'none') c.style.display = 'none';
  if (tg) tg.style.transform = 'rotate(0deg)';
}

/** 「等待模型响应...」占位：一旦有真实内容（思考/工具/正文）就移除 */
function dropAgentPlaceholder(msgEl) {
  if (!msgEl) return;
  msgEl.querySelectorAll('.agent-step-text .loading-text').forEach(n => {
    const step = n.closest('.agent-step-text');
    if (step) step.remove(); else n.remove();
  });
  if (state.agentState && state.agentState.stepEls && state.agentState.stepEls.text) {
    const rec = state.agentState.stepEls.text;
    if (rec && rec.el && !rec.el.isConnected) state.agentState.stepEls.text = null;
    else if (rec && rec.el && rec.el.querySelector('.loading-text')) state.agentState.stepEls.text = null;
  }
}

/**
 * 空窗期占位：工具执行完 → 下一轮模型响应回来之前，UI 上要让人看到"还在跑"。
 * 复用 .agent-step-notice 的灰色小字样式，加一个省略号动画类。
 * 下一次 agent-reasoning / agent-content / agent-tool-exec / agent-done 到来时会被 hideAgentWaiting 撤掉。
 */
function showAgentWaiting(msgEl, text) {
  if (!msgEl) return;
  hideAgentWaiting(msgEl); // 重复调用先清旧的，避免堆积
  const root = getAgentStepsRoot(msgEl);
  if (!root) return;
  const line = document.createElement('div');
  line.className = 'agent-step agent-step-notice agent-step-waiting';
  line.dataset.step = 'waiting';
  const span = document.createElement('span');
  span.className = 'asn-text';
  span.textContent = (text || '等待模型响应') + '…';
  line.appendChild(span);
  root.appendChild(line);
}

/** 撤掉空窗期占位（下一轮真实内容到来时调用） */
function hideAgentWaiting(msgEl) {
  if (!msgEl) return;
  msgEl.querySelectorAll('.agent-step-waiting').forEach(n => n.remove());
}

/** 一轮结束：所有思考步收尾（定稿耗时），并整体折叠思考内容 */
function finalizeAgentSteps(msgEl) {
  if (!msgEl) return;
  const steps = msgEl.querySelectorAll(':scope > div > .agent-steps > .agent-step');
  steps.forEach(step => {
    if (step.dataset.step !== 'think') return;
    const rec = Array.isArray(state.agentState?.steps)
      ? state.agentState.steps.find(r => r.el === step) : null;
    if (rec) sealAgentThinkStep(rec, true);
    // sealAgentThinkStep 已处理空思考块移除；非空块这里再兜一次折叠
    if (rec && rec.el && rec.el.isConnected) {
      const c = step.querySelector('.agent-reasoning-content');
      if (c && c.style.display !== 'none') c.style.display = 'none';
      const tg = step.querySelector('.reasoning-toggle');
      if (tg) tg.style.transform = 'rotate(0deg)';
    }
  });
}

/** 取（必要时创建）Agent 消息顶部的「总体展示」摘要行 */
function getAgentSummaryRow(msgEl) {
  if (!msgEl) return null;
  let row = msgEl.querySelector(':scope > div > .agent-process-summary');
  if (row) return row;
  const body = msgEl.querySelector(':scope > div');
  if (!body) return null;
  row = document.createElement('div');
  row.className = 'agent-process-summary';
  // 图标一律用 icons.js 的内联 SVG（不用 emoji）
  const iconHtml = (window.ElIcons && window.ElIcons.ICONS && window.ElIcons.ICONS.check) || '';
  row.innerHTML = '<span class="aps-caret">›</span>'
    + '<span class="aps-icon">' + iconHtml + '</span>'
    + '<span class="aps-text"></span>';
  // 插在步骤流之前（.agent-steps 永远存在，createAgentStep 会复用它）
  const root = getAgentStepsRoot(msgEl);
  if (root) body.insertBefore(row, root);
  else body.insertBefore(row, body.firstChild);
  return row;
}

/** 摘要文案 → 「已完成 · 用时 1.2 秒」（只要状态和耗时，步数/工具数属于过程细节，展开才看） */
function buildAgentSummaryText(msgEl, opts) {
  const o = opts || {};
  const parts = ['已完成'];
  const ms = o.elapsedMs || 0;
  if (ms > 0) {
    const sec = ms / 1000;
    parts.push('用时 ' + (sec >= 10 ? sec.toFixed(0) : sec.toFixed(1)) + ' 秒');
  }
  return parts.join(' · ');
}

/** 更新总览行文案（不改动展开/收起状态） */
function updateAgentSummaryRow(msgEl, opts) {
  const row = getAgentSummaryRow(msgEl);
  if (!row) return;
  const textEl = row.querySelector('.aps-text');
  if (textEl) textEl.textContent = buildAgentSummaryText(msgEl, opts);
}

/** 点总览行 → 展开/收起过程区（思考 + 工具 + 中间叙述；最终汇报常驻不受影响） */
function toggleAgentProcess(msgEl) {
  if (!msgEl) return;
  const row = msgEl.querySelector(':scope > div > .agent-process-summary');
  if (!row) return;
  const collapsed = msgEl.classList.toggle('agent-process-collapsed');
  row.classList.toggle('is-open', !collapsed);
  const root = msgEl.querySelector('.agent-steps');
  if (root) {
    // 展开时把思考块也一并铺开（收起时恢复折叠态由 finalize 决定，这里只管容器可见性）
    if (!collapsed) {
      root.querySelectorAll('.agent-step-think').forEach(step => {
        const c = step.querySelector('.agent-reasoning-content');
        const tg = step.querySelector('.reasoning-toggle');
        if (c) c.style.display = 'block';
        if (tg) tg.style.transform = 'rotate(90deg)';
      });
    }
  }
  scrollChatToBottomIfNeeded();
}

/**
 * 标记最后一个正文步为「最终汇报」——**只加 class，不移动 DOM**。
 * 汇报始终留在 .agent-steps 里（保持时间序末尾），CSS 负责让它在收起态也可见：
 *   .agent-process-collapsed .agent-steps > .agent-step { display:none }
 *   … > .agent-step.agent-final-report { display:block }
 * 这样展开时汇报自然回到「思考→工具→叙述→汇报」的时间序末尾。
 */
function promoteAgentFinalReport(msgEl) {
  if (!msgEl) return null;
  const root = getAgentStepsRoot(msgEl);
  if (!root) return null;
  const texts = root.querySelectorAll(':scope > .agent-step-text');
  if (!texts.length) return null;
  const last = texts[texts.length - 1];
  const bubble = last.querySelector('.agent-content-bubble');
  // 空正文（只有「等待模型响应...」占位或被清空）不标记，留在过程区里
  if (!bubble || !bubble.textContent.trim()) return null;
  last.classList.add('agent-final-report');
  return last;
}

/**
 * 渲染「本轮改动的文件」列表（收尾总结下方）。
 * 路径来自主进程按**实际写操作**记录（write_file/create_directory/copy_file/move_file/download_file），
 * 比让模型自己回忆可靠。一行一个，点一下用系统默认程序打开。
 */
function renderChangedFiles(msgEl, files) {
  if (!msgEl) return;
  // 先清掉旧列表（重新生成/重新渲染时）
  const old = msgEl.querySelector(':scope > div > .agent-changed-files');
  if (old) old.remove();
  if (!Array.isArray(files) || !files.length) return;

  const box = document.createElement('div');
  box.className = 'agent-changed-files';
  const title = document.createElement('div');
  title.className = 'acf-title';
  title.textContent = '本轮改动的文件（' + files.length + '）';
  box.appendChild(title);

  files.forEach(rel => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'acf-item';
    item.title = '点击打开 ' + rel;
    // 路径走 textContent，不拼 HTML（防止路径里特殊字符被当标签解析）
    const icon = document.createElement('span');
    icon.className = 'acf-icon';
    icon.innerHTML = (window.ElIcons && window.ElIcons.ICONS && window.ElIcons.ICONS.file) || '';
    const text = document.createElement('span');
    text.className = 'acf-path';
    text.textContent = rel;
    item.appendChild(icon);
    item.appendChild(text);
    item.addEventListener('click', () => {
      try {
        if (window.api && window.api.openPath) window.api.openPath(rel);
        else if (window.api && window.api.openExternal) window.api.openExternal(rel);
      } catch (e) { /* 打开失败不打断聊天 */ }
    });
    box.appendChild(item);
  });

  // 挂在过程区之后 —— 汇报是 .agent-steps 的最后一个子节点，所以「过程区之后」= 汇报之后，
  // 且在操作栏/token 栏之前。root 不存在时兜底挂到消息体末尾。
  const root = getAgentStepsRoot(msgEl);
  if (root && root.parentElement) root.parentElement.insertBefore(box, root.nextSibling);
  else msgEl.querySelector(':scope > div').appendChild(box);
}

/**
 * 追加一行「系统状态提示」（内部重试/上下文压缩/要求继续等，不是 AI 说的话）。
 * 独立成 .agent-step-notice 步骤 → 走时间序、跟思考一样在整轮结束时收起，
 * 而且**不会**被当成最终汇报（promoteAgentFinalReport 只认 .agent-step-text）。
 */
function appendAgentNotice(msgEl, text) {
  if (!msgEl || !text) return;
  const root = getAgentStepsRoot(msgEl);
  if (!root) return;
  // 同一条提示可能分多次 emit（流式），已渲染过就跳过
  const line = document.createElement('div');
  line.className = 'agent-step agent-step-notice';
  line.dataset.step = 'notice';
  const span = document.createElement('span');
  span.className = 'asn-text';
  span.textContent = text;
  line.appendChild(span);
  root.appendChild(line);
  // 打断当前思考/正文步，让提示插在正确的时间位置
  closeAgentStep('think');
  closeAgentStep('text');
}

/** 一轮结束：写入总览行、标记最终汇报常驻显示、过程区默认收起 */
function finalizeAgentProcess(msgEl, opts) {
  if (!msgEl) return;
  const row = getAgentSummaryRow(msgEl);
  if (!row) return;
  promoteAgentFinalReport(msgEl);
  // 统计要减去被提走的汇报步，避免「共 N 步」把它算进过程
  updateAgentSummaryRow(msgEl, opts);
  // 默认收起：过程区（思考/工具/中间叙述）藏起来，只留「已完成 · …」+ 汇报
  msgEl.classList.add('agent-process-collapsed');
  row.classList.remove('is-open');
}

/** 把当前步骤记录导出成可落库的纯数据（不含 DOM 引用） */
function exportAgentSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps.map(r => {
    if (r.kind === 'tool') {
      return { kind: 'tool', tool: r.tool, args: r.args || {}, result: r.result || null };
    }
    const ms = r.t0 ? Math.max(0, Date.now() - r.t0) : 0;
    return { kind: r.kind, text: r.text || '', ms: ms };
  }).filter(r => (r.kind === 'tool') || (r.text && r.text.trim()));
}

/** 按 steps[] 复原时间顺序的步骤流（历史消息 / 流式中重建 DOM） */
function renderAgentSteps(msgEl, steps, opts) {
  if (!msgEl || !Array.isArray(steps) || !steps.length) return;
  const o = opts || {};
  const st = { steps: [], stepEls: {} };
  const prevAgentState = state.agentState;
  state.agentState = st;   // createAgentStep 依赖它来登记
  try {
    steps.forEach(raw => {
      if (!raw || !raw.kind) return;
      if (raw.kind === 'think') {
        if (!raw.text || !raw.text.trim()) return;
        const rec = createAgentStep(msgEl, 'think', { t0: Date.now() - (raw.ms || 0), sealed: true });
        if (!rec) return;
        rec.text = raw.text;
        const c = rec.el.querySelector('.agent-reasoning-content');
        if (c) { c.textContent = raw.text; c.style.display = o.collapsed === false ? 'block' : 'none'; }
        const tg = rec.el.querySelector('.reasoning-toggle');
        if (tg) tg.style.transform = o.collapsed === false ? 'rotate(90deg)' : 'rotate(0deg)';
        const tm = rec.el.querySelector('.reasoning-time');
        if (tm) {
          const sec = (raw.ms || 0) / 1000;
          tm.textContent = sec >= 0.5
            ? ('思考结束 · 用时 ' + (sec >= 10 ? sec.toFixed(0) : sec.toFixed(1)) + ' 秒')
            : '思考结束';
        }
      } else if (raw.kind === 'text') {
        if (!raw.text) return;
        const rec = createAgentStep(msgEl, 'text');
        if (!rec) return;
        rec.text = raw.text;
        const b = rec.el.querySelector('.agent-content-bubble');
        if (b) { b.innerHTML = renderMarkdown(raw.text); b.dataset.originalContent = raw.text; }
      } else if (raw.kind === 'tool') {
        const rec = createAgentStep(msgEl, 'tool', { tool: raw.tool, args: raw.args, result: raw.result });
        if (!rec) return;
        const card = buildAgentToolCard(raw.tool, raw.args, raw.result);
        if (card) rec.el.appendChild(card);
      }
    });
  } finally {
    state.agentState = prevAgentState;
  }
  // 回填给仍在流式中的会话（重建后继续往同一步追加）
  if (o.keepLive && prevAgentState) {
    prevAgentState.steps = st.steps;
    prevAgentState.stepEls = st.stepEls;
  }
  return st;
}

// Agent 消息渲染（步骤流：思考/工具/正文按时间顺序 + 操作栏）
// opts.live=true 表示「这是正在流式生成的那条消息」：插入正文占位块并绑定
// state.agentState.currentMsgEl。历史消息（live=false）只按 steps[]/旧字段复原，
// 不能占 currentMsgEl，否则会劫持后续事件（渲染中途 state.agentState 也可能非空）。
function appendAgentMessage(msg, opts) {
  const live = !!(opts && opts.live);
  const container = document.getElementById('chat-messages');
  const messageDiv = document.createElement('div');
  messageDiv.className = 'chat-message ai agent-message';
  // AI消息不显示头像
  // 豆包风格操作栏（Agent消息）
  const _I = window.ElIcons.ICONS;
  const _btnStyle = 'display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;background:transparent;border-radius:6px;cursor:pointer;color:var(--text-muted);font-size:16px;transition:background 0.15s,color 0.15s;';
  const _timeHtml = '<span class="message-time" style="margin-right:8px;color:var(--text-muted);font-size:12px;">' + new Date(msg.time).toLocaleTimeString() + '</span>';
  const actionBarHtml = '<div class="msg-action-bar" style="display:flex;align-items:center;gap:2px;justify-content:flex-start;margin-top:6px;opacity:1;transition:opacity 0.15s;">'
    + _timeHtml
    + '<button class="ma-btn ma-copy" title="复制" style="' + _btnStyle + '">' + _I.copy + '</button>'
    + '<button class="ma-btn ma-like" title="点赞" style="' + _btnStyle + '">' + _I.like + '</button>'
    + '<button class="ma-btn ma-dislike" title="点踩" style="' + _btnStyle + '">' + _I.dislike + '</button>'
    + '<button class="ma-btn ma-volume" title="朗读" style="' + _btnStyle + '">' + _I.volume + '</button>'
    + '<button class="ma-btn ma-refresh" title="重新生成" style="' + _btnStyle + '">' + _I.refresh + '</button>'
    + '<button class="ma-btn ma-share" title="分享" style="' + _btnStyle + '">' + _I.share + '</button>'
    + '<button class="ma-btn ma-more" title="更多" style="' + _btnStyle + '">' + _I.more + '</button>'
    + '</div>';

  // 正文占位块：只有正在流式生成的消息才需要（历史消息直接铺 steps）
  const initialTextStep = live
    ? '<div class="agent-step agent-step-text" data-step="text">'
      + '<div class="chat-bubble agent-content-bubble" style="min-height:24px;display:inline-block;text-align:left;"><span class="loading-text">等待模型响应...</span></div>'
      + '</div>'
    : '';

  messageDiv.innerHTML = `
    <div style="flex:1;min-width:0;text-align:left;">
      <div class="agent-steps">${initialTextStep}</div>
      ${actionBarHtml}

      <div class="token-stats-bar" style="display:none;margin-top:6px;"></div>
    </div>
  `;
  // 总览行点击 → 展开/收起步骤流；思考块折叠也走事件委托
  //（一条消息可能有多个思考步 + 一个总览行，逐个独立切换）
  messageDiv.addEventListener('click', (e) => {
    const summary = e.target.closest ? e.target.closest('.agent-process-summary') : null;
    if (summary) {
      e.stopPropagation();
      toggleAgentProcess(messageDiv);
      return;
    }
    const header = e.target.closest ? e.target.closest('.agent-reasoning-header') : null;
    if (!header) return;
    const section = header.closest('.agent-reasoning-section');
    if (!section) return;
    const c = section.querySelector('.agent-reasoning-content');
    if (!c) return;
    const isOpen = c.style.display !== 'none';
    c.style.display = isOpen ? 'none' : 'block';
    const toggle = header.querySelector('.reasoning-toggle');
    if (toggle) toggle.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(90deg)';
  });
  bindMessageActionBar(messageDiv, msg);
  container.appendChild(messageDiv);
  container.scrollTop = container.scrollHeight;

  // 初始正文占位登记为「当前正文步」，第一个 agent-content 事件直接续上
  if (live && state.agentState) {
    const phRec = {
      kind: 'text', text: '', t0: Date.now(), el: messageDiv.querySelector('.agent-step-text')
    };
    if (!state.agentState.steps) state.agentState.steps = [];
    if (!state.agentState.stepEls) state.agentState.stepEls = {};
    state.agentState.stepEls.text = phRec;
  }

  // —— 历史消息：优先按 steps[] 复原时间顺序；老消息没有 steps 则回退旧分组结构 ——
  if (Array.isArray(msg.steps) && msg.steps.length) {
    renderAgentSteps(messageDiv, msg.steps, { collapsed: true });
  } else if (msg.reasoning || (msg.tools && msg.tools.length > 0)) {
    const legacy = [];
    if (msg.reasoning) legacy.push({ kind: 'think', text: msg.reasoning, ms: 0 });
    (msg.tools || []).forEach(t => legacy.push({ kind: 'tool', tool: t.tool, args: t.args, result: t.result }));
    if (legacy.length) renderAgentSteps(messageDiv, legacy, { collapsed: true });
  }
  // 总览行：历史消息同样只留「已完成 · 思考 N 段 · 工具 M 次 …」摘要，点开看过程。
  // 正在流式生成的消息不能在这里收尾——过程要逐条可见，等 agent-done 才折叠成摘要。
  if (!live) finalizeAgentProcess(messageDiv, { elapsedMs: msg.elapsedMs || 0 });
  // 本轮改动的文件（历史消息同样显示，点击可打开）
  renderChangedFiles(messageDiv, msg.changedFiles);
  // 加载历史 Agent 消息时恢复 Token 消耗统计栏渲染
  if (msg.usage || msg.elapsedMs > 0) {
    setTimeout(() => renderTokenStatsBar(messageDiv, msg.usage, msg.elapsedMs), 0);
  }
  // 只有正在流式生成的新消息才绑定 currentMsgEl（历史渲染绝不能劫持事件流）
  if (live && state.agentState && state.agentState.currentMsgEl === null) {
    state.agentState.currentMsgEl = messageDiv;
  }
  // 登记消息对象 ↔ DOM（Agent 消息的「等待重新生成」提示条要用）
  setMsgEl(msg, messageDiv);
  if (msg.pending) updatePendingBadge(msg);
  return messageDiv;
}

// 追加 Agent 工具调用卡片
// 聊天区域自动滚动：只有用户在底部时才自动滚动，避免用户往上看时被强制拉回
function isChatAtBottom() {
  const el = document.getElementById('chat-messages');
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
}
function scrollChatToBottomIfNeeded() {
  if (isChatAtBottom()) {
    const el = document.getElementById('chat-messages');
    if (el) el.scrollTop = el.scrollHeight;
  }
}

/** 构造一个工具执行行卡片（工具名 + 参数摘要 + 状态），不负责插入位置 */
function buildAgentToolCard(toolName, args, result) {
  const card = document.createElement('div');
  card.className = 'agent-tool-card';
  const header = document.createElement('div');
  header.className = 'tool-header';
  header.style.cssText = 'display:flex;align-items:center;gap:6px;';
  const iconSpan = document.createElement('span');
  iconSpan.className = 'tool-icon';
  iconSpan.innerHTML = getToolIcon(toolName);
  const nameSpan = document.createElement('span');
  nameSpan.className = 'tool-name';
  nameSpan.textContent = toolLabel(toolName);
  const statusSpan = document.createElement('span');
  statusSpan.className = 'tool-status';
  if (result && result.success === false) {
    statusSpan.textContent = '✗ 失败';
    statusSpan.style.color = 'var(--error-color,#f87171)';
  } else if (result) {
    statusSpan.textContent = '✓ 完成';
    statusSpan.style.color = 'var(--success-color,#4ade80)';
  } else {
    statusSpan.textContent = '执行中';
    statusSpan.classList.add('running');
  }
  const desc = toolDescription(toolName, args);
  header.appendChild(iconSpan);
  header.appendChild(nameSpan);
  // 参数摘要在工具名之后（图标 → 名称 → 参数 → 状态，读起来才是一行）
  if (desc) {
    const descSpan = document.createElement('span');
    descSpan.className = 'tool-desc';
    descSpan.style.cssText = 'color:var(--text-muted,#888);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px;flex:0 1 auto;';
    descSpan.textContent = desc;
    descSpan.title = desc;
    header.appendChild(descSpan);
  }
  header.appendChild(statusSpan);
  card.appendChild(header);

  // 写文件 / 改文件时，逐行流式展示写入内容（打字机效果），让用户看到"写到哪"
  if (toolName === 'write_file' && args && args.content) {
    const preview = document.createElement('div');
    preview.className = 'tool-args';
    preview.style.cssText = 'max-height:200px;overflow:auto;font-family:ui-monospace,Consolas,monospace;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all;';
    const allLines = String(args.content).split('\n');
    const MAX_SHOW = 40;
    preview.textContent = '';
    // 逐行追加，每 30ms 加 2 行，模拟流式写入
    let li = 0;
    const timer = setInterval(() => {
      const batch = allLines.slice(li, li + 2);
      preview.textContent += (li > 0 ? '\n' : '') + batch.join('\n');
      li += 2;
      preview.scrollTop = preview.scrollHeight;
      if (li >= allLines.length || li >= MAX_SHOW) {
        clearInterval(timer);
        if (allLines.length > MAX_SHOW) preview.textContent += '\n…（共 ' + allLines.length + ' 行）';
      }
    }, 30);
    card._typeTimer = timer;
    card.appendChild(preview);
  } else if (toolName === 'run_shell' && args && args.command) {
    const preview = document.createElement('div');
    preview.className = 'tool-args';
    preview.textContent = '$ ' + args.command;
    card.appendChild(preview);
  } else if (toolName === 'edit_file' && args) {
    const preview = document.createElement('div');
    preview.className = 'tool-args';
    preview.style.cssText = 'font-family:ui-monospace,Consolas,monospace;font-size:11px;line-height:1.5;';
    preview.textContent = '查找: ' + (args.old_string || '').slice(0, 200) + '\n→ 替换: ' + (args.new_string || '').slice(0, 200);
    card.appendChild(preview);
  }
  return card;
}

/** 生成"同一操作"签名：相同工具 + 相同目标（文件路径/命令/URL/关键词）才算重复，
 *  只有签名一致的调用才去重复用一张卡片；不同目标（如同时用同一工具写多个文件、
 *  跑多条命令）各自叠加显示一张卡片，互不覆盖。
 */
function toolSignature(toolName, args) {
  args = args || {};
  switch (toolName) {
    case 'write_file': case 'read_file': case 'move_file': case 'copy_file':
    case 'create_directory': case 'delete_file': case 'download_file':
      return (args.path || args.source || args.dest || args.url || '');
    case 'run_shell': case 'execute_command': case 'execute_shell':
      return (args.command || '');
    case 'web_fetch': case 'check_url':
      return (args.url || '');
    case 'web_search':
      return (args.query || '');
    default: {
      try {
        // 其余工具按参数全量（键排序）判同，避免键顺序差异误判
        const sortObj = (o) => {
          if (!o || typeof o !== 'object' || Array.isArray(o)) return o;
          const out = {};
          Object.keys(o).sort().forEach(k => { out[k] = sortObj(o[k]); });
          return out;
        };
        return JSON.stringify(sortObj(args));
      } catch (e) { return ''; }
    }
  }
}

function appendAgentToolCard(toolName, args) {
  if (!state.agentState?.currentMsgEl) return null;
  // 去重：仅当"同一工具 + 同一目标（如同一文件/同一命令）"时才复用已有卡片；
  // 不同目标（同时用同一工具写多个文件、跑多条命令）各自叠加显示一张卡片。
  const sig = toolSignature(toolName, args);
  const steps = Array.isArray(state.agentState.steps) ? state.agentState.steps : [];
  let existingCard = null;
  for (let i = steps.length - 1; i >= Math.max(0, steps.length - 80); i--) {
    const s = steps[i];
    if (!s || s.kind !== 'tool') continue;
    if (s.tool === toolName && s.card && s.card.isConnected && toolSignature(s.tool, s.args) === sig) { existingCard = s.card; break; }
  }
  if (existingCard) {
    // 只更新已有卡片的参数摘要和状态，不创建新 DOM
    const desc = toolDescription(toolName, args);
    const descEl = existingCard.querySelector('.tool-desc');
    if (descEl) {
      // 切换动画：先淡出再淡入新文件名
      descEl.style.transition = 'opacity .15s';
      descEl.style.opacity = '0';
      setTimeout(() => { descEl.textContent = desc; descEl.title = desc; descEl.style.opacity = '1'; }, 150);
    }
    const statusEl = existingCard.querySelector('.tool-status');
    if (statusEl) {
      statusEl.textContent = '执行中';
      statusEl.classList.add('running');
      statusEl.style.color = '';
    }
    // 日志里仍记一条（不建 DOM）
    steps.push({ kind: 'tool', tool: toolName, args, result: null, card: existingCard, duplicate: true });
    return existingCard;
  }
  const rec = createAgentStep(state.agentState.currentMsgEl, 'tool', { tool: toolName, args: args, result: null });
  if (!rec) return null;
  const card = buildAgentToolCard(toolName, args, null);
  rec.el.appendChild(card);
  rec.card = card;
  scrollChatToBottomIfNeeded();
  return card;
}

// ==================== 待办清单卡片（需求整理 / 实现过程追踪） ====================
// 模型调 todo_write / todo_update 时不显示原始 JSON，而是画成一份可读的清单：
// 用户一眼能看到"目标是什么、做到第几步、每步的完成判据"，这就是需求确认与过程留痕。
const TODO_TOOLS = ['todo_write', 'todo_update', 'todo_read'];

function isTodoTool(name) { return TODO_TOOLS.includes(name); }

function todoText(key, fallback) {
  const v = window.t ? window.t(key) : null;
  return (v && v !== key) ? v : fallback;
}

/** 构建待办卡片 DOM。items 为空时不显示卡片（返回 null）。 */
function buildTodoCardEl(items, progress, title, opts = {}) {
  if (!Array.isArray(items) || !items.length) return null;
  const card = document.createElement('div');
  card.className = 'agent-todo-card';

  const head = document.createElement('div');
  head.className = 'todo-head';
  const label = document.createElement('span');
  label.className = 'todo-label';
  label.textContent = todoText('chat.todoTitle', '待办清单');
  head.appendChild(label);

  const prog = progress || { completed: 0, total: items.length, percent: 0 };
  const counter = document.createElement('span');
  counter.className = 'todo-counter';
  counter.textContent = prog.completed + '/' + prog.total;
  head.appendChild(counter);

  if (title) {
    const t = document.createElement('span');
    t.className = 'todo-goal';
    t.textContent = title;
    t.title = title;
    head.appendChild(t);
  }
  // 不提供手动关闭按钮：待办是 AI 的执行清单，完成后由 agent-done 自动收起（clearActiveTodos）
  card.appendChild(head);

  const bar = document.createElement('div');
  bar.className = 'todo-bar';
  const fill = document.createElement('i');
  fill.style.width = Math.max(0, Math.min(100, prog.percent || 0)) + '%';
  bar.appendChild(fill);
  card.appendChild(bar);

  const list = document.createElement('ul');
  list.className = 'todo-list';
  for (const it of items) {
    const li = document.createElement('li');
    li.className = 'todo-item ' + (it.status || 'pending');
    const mk = document.createElement('span');
    mk.className = 'todo-mark';
    // 仅完成项画一个纯对勾 SVG，待办/进行中不留任何符号（黑白极简样式）
    if (it.status === 'completed') {
      mk.innerHTML = (window.ElIcons && window.ElIcons.ICONS.check) || '';
    }
    // 手动兜底：AI 忘了标记时，用户点整行即可切换完成状态（状态写回主进程，两处卡片同步）
    li.title = it.status === 'completed' ? '点击改回「待办」' : '点击标记为「已完成」';
    li.addEventListener('click', (e) => { e.stopPropagation(); toggleTodoItem(it); });
    li.appendChild(mk);

    const body = document.createElement('div');
    body.className = 'todo-body';
    const txt = document.createElement('div');
    txt.className = 'todo-text';
    txt.textContent = it.text || '';
    body.appendChild(txt);
    if (it.done_when) {
      const dw = document.createElement('div');
      dw.className = 'todo-done-when';
      dw.textContent = todoText('chat.todoDoneWhen', '完成判据') + '：' + it.done_when;
      body.appendChild(dw);
    }
    if (it.note) {
      const nt = document.createElement('div');
      nt.className = 'todo-note';
      nt.textContent = '→ ' + it.note;
      body.appendChild(nt);
    }
    li.appendChild(body);
    list.appendChild(li);
  }
  card.appendChild(list);
  return card;
}

/** 在消息元素里插入或就地更新待办卡片（作为时间序中的一步；工具卡片是它后面的步骤） */
function renderTodoCard(msgEl, result) {
  if (!msgEl) return null;
  let card = msgEl.querySelector('.agent-todo-card');
  const items = result && Array.isArray(result.items) ? result.items : null;

  // 结果还没回来 → 先占个位，让用户知道"正在整理需求"
  if (!items) {
    if (card) return card;
    card = document.createElement('div');
    card.className = 'agent-todo-card todo-loading';
    card.textContent = todoText('chat.todoPlanning', '正在整理需求…');
    const step = document.createElement('div');
    step.className = 'agent-step agent-step-todo';
    step.dataset.step = 'todo';
    step.appendChild(card);
    const root = getAgentStepsRoot(msgEl);
    if (root) root.appendChild(step); else msgEl.appendChild(step);
    return card;
  }

  const fresh = buildTodoCardEl(items, result.progress, result.title);
  if (!fresh) {
    // 清单被清空了
    if (card) {
      const step = card.closest('.agent-step-todo');
      if (step) step.remove(); else card.remove();
    }
    return null;
  }
  if (card && card.parentElement) {
    // 就地替换（保持在时间序中的原位置）
    card.parentElement.replaceChild(fresh, card);
  } else {
    const step = document.createElement('div');
    step.className = 'agent-step agent-step-todo';
    step.dataset.step = 'todo';
    step.appendChild(fresh);
    const root = getAgentStepsRoot(msgEl);
    if (root) root.appendChild(step); else msgEl.appendChild(step);
  }
  scrollChatToBottomIfNeeded();
  return fresh;
}

/** 把最新清单存到会话对象上，切走再切回来还能看到 */
function persistActiveTodos(result) {
  if (!result || !Array.isArray(result.items)) return;
  const conv = state.conversations?.find(c => c.id === state.activeConversationId);
  if (!conv) return;
  conv.activeTodos = result.items;
  conv.activeTodoTitle = result.title || conv.activeTodoTitle || '';
  saveConversations();
  refreshConvAssetsIfOpen();
}

/** 清除当前会话的待办（卡片上的 × 按钮；任务全部完成后的自动关闭也走这里）。
 *  toastMsg：string=自定义提示；不传=默认"已清除待办清单"；null=静默不打扰 */
async function clearActiveTodos(toastMsg) {
  const conv = state.conversations?.find(c => c.id === state.activeConversationId);
  try {
    await window.api.todo.clear(state.activeConversationId);
  } catch (e) { /* 主进程没起来也不影响前端清理 */ }
  if (conv) {
    conv.activeTodos = [];
    conv.activeTodoTitle = '';
    saveConversations();
    refreshConvAssetsIfOpen();
  }
  document.querySelectorAll('#chat-messages .agent-todo-card').forEach(el => el.remove());
  if (toastMsg !== null) showToast(typeof toastMsg === 'string' ? toastMsg : '已清除待办清单', '', 'success');
}

// —— 待办自动关闭：任务做完后清单不该留着让用户手动点 × ——
// 触发时机：一轮 agent 执行结束（agent-done）或用户手动点掉最后一条后，清单若已全部完成，
// 延迟 1.6 秒（让用户瞥见 100% 状态）自动清除；期间清单被更新（新任务/点回待办）则放弃。
let todoAutoCloseTimer = null;
function scheduleAutoCloseTodos() {
  if (todoAutoCloseTimer) { clearTimeout(todoAutoCloseTimer); todoAutoCloseTimer = null; }
  const conv = state.conversations?.find(c => c.id === state.activeConversationId);
  const items = conv?.activeTodos;
  if (!Array.isArray(items) || !items.length) return;
  if (!items.every(i => i.status === 'completed')) return; // 有未完成项 → 保留给用户看
  todoAutoCloseTimer = setTimeout(async () => {
    todoAutoCloseTimer = null;
    const c2 = state.conversations?.find(c => c.id === state.activeConversationId);
    const items2 = c2?.activeTodos;
    if (!Array.isArray(items2) || !items2.length) return;
    if (!items2.every(i => i.status === 'completed')) return; // 延迟期间清单变了（新任务/手动改回）→ 不关
    await clearActiveTodos('待办已全部完成，清单已自动关闭');
  }, 1600);
}

function todoProgressOf(items) {
  const total = items.length;
  const completed = items.filter(i => i.status === 'completed').length;
  return { total, completed, inProgress: items.filter(i => i.status === 'in_progress').length, percent: total ? Math.round(completed / total * 100) : 0 };
}

/** 用户手动点掉一条（AI 忘了标记时的兜底）：写回主进程，并把聊天里所有卡片同步重画 */
async function toggleTodoItem(item) {
  const next = item.status === 'completed' ? 'pending' : 'completed';
  const conv = state.conversations?.find(c => c.id === state.activeConversationId);
  try {
    const r = await window.api.todo.update(state.activeConversationId, {
      id: item.id,
      status: next,
      ...(next === 'completed' ? { note: item.note || '用户手动标记完成' } : {})
    });
    if (!r || !r.success) {
      showToast('更新待办失败', (r && r.error) || '未知错误', 'error');
      return;
    }
    if (conv) {
      conv.activeTodos = r.items;
      saveConversations();
      refreshConvAssetsIfOpen();
    }
    // 同一份清单可能同时存在于"消息里的卡片"和"会话恢复的卡片"，一起重画
    const title = conv?.activeTodoTitle || '';
    const progress = r.progress || todoProgressOf(r.items);
    document.querySelectorAll('#chat-messages .agent-todo-card').forEach(el => {
      const fresh = buildTodoCardEl(r.items, progress, title);
      if (fresh) el.parentElement.replaceChild(fresh, el);
      else el.remove();
    });
    // 用户手动点掉最后一条 → 全部完成，同样走自动关闭
    scheduleAutoCloseTodos();
  } catch (e) {
    showToast('更新待办失败', String(e && e.message || e), 'error');
  }
}


// ==================== 询问用户卡片（ask_user：这条待办怎么做，由用户挑方案/自定义） ====================

/** 构造「SVG 图标 + 文本」行：图标只用 js/icons.js 的 SVG（不用 emoji），文本走 textContent 防注入 */
function buildAskIconLine(className, iconName, text) {
  const el = document.createElement('div');
  el.className = className;
  const icon = document.createElement('span');
  icon.className = 'ask-icon';
  icon.innerHTML = (window.ElIcons && window.ElIcons.ICONS[iconName]) || '';
  el.appendChild(icon);
  const txt = document.createElement('span');
  txt.className = 'ask-text';
  txt.textContent = text;
  el.appendChild(txt);
  return el;
}

/** 禁用卡片上所有可点控件（已回答/过期后调用） */
function disableAskControls(card) {
  card.querySelectorAll('.ask-option, .ask-custom input, .ask-custom button').forEach(n => { n.disabled = true; });
}

/** 在卡片底部显示用户的最终选择 */
function setAskChoice(card, text) {
  const old = card.querySelector('.ask-choice');
  if (old) old.remove();
  card.appendChild(buildAskIconLine('ask-choice', 'check', text));
}

/** 渲染"询问用户"卡片。req 为 null 时画占位（等 agent-ask-user 事件带来问题与选项） */
function renderAskUserCard(msgEl, req) {
  if (!msgEl) return null;
  // 串行会话：同一条消息里若有未回答的提问卡（异常情况），标记过期并禁用
  msgEl.querySelectorAll('.agent-ask-card:not(.answered)').forEach(c => {
    c.classList.add('answered', 'expired');
    disableAskControls(c);
  });

  if (!req) {
    const exist = msgEl.querySelector('.agent-ask-card.ask-loading');
    if (exist) return exist;
    const ph = document.createElement('div');
    ph.className = 'agent-ask-card ask-loading';
    ph.textContent = '正在向用户确认做法…';
    appendAgentCardStep(msgEl, ph);
    scrollChatToBottomIfNeeded();
    return ph;
  }

  const fresh = document.createElement('div');
  fresh.className = 'agent-ask-card';

  const head = document.createElement('div');
  head.className = 'ask-head';
  head.textContent = '这条怎么做？由你决定';
  fresh.appendChild(head);

  const q = document.createElement('div');
  q.className = 'ask-question';
  q.textContent = req.question || '请选择这条任务的做法：';
  fresh.appendChild(q);

  const opts = Array.isArray(req.options) ? req.options.filter(Boolean) : [];
  if (opts.length) {
    const list = document.createElement('div');
    list.className = 'ask-options';
    opts.forEach((opt, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ask-option';
      btn.textContent = String.fromCharCode(65 + i) + '. ' + opt;
      btn.addEventListener('click', () => {
        if (fresh.classList.contains('answered')) return;
        fresh.classList.add('answered');
        disableAskControls(fresh);
        setAskChoice(fresh, '你的选择：' + opt);
        window.api.answerUserGuidance(req.id, opt, 'option').catch(() => {});
      });
      list.appendChild(btn);
    });
    fresh.appendChild(list);
  }

  if (req.allowCustom !== false) {
    const row = document.createElement('div');
    row.className = 'ask-custom';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ask-custom-input';
    input.placeholder = '都不满意？自己写做法…';
    const send = document.createElement('button');
    send.type = 'button';
    send.className = 'ask-custom-send';
    send.textContent = '发送';
    const submit = () => {
      const val = input.value.trim();
      if (!val || fresh.classList.contains('answered')) return;
      fresh.classList.add('answered');
      disableAskControls(fresh);
      setAskChoice(fresh, '你的选择：' + val);
      window.api.answerUserGuidance(req.id, val, 'custom').catch(() => {});
    };
    send.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    row.appendChild(input);
    row.appendChild(send);
    fresh.appendChild(row);
  }

  // 替换占位卡片
  const ph = msgEl.querySelector('.agent-ask-card.ask-loading');
  if (ph && ph.parentElement) ph.parentElement.replaceChild(fresh, ph);
  else appendAgentCardStep(msgEl, fresh);
  scrollChatToBottomIfNeeded();
  return fresh;
}

/** 把一张卡片（待办/询问）包成时间序中的一步，追加到步骤流末尾 */
function appendAgentCardStep(msgEl, card) {
  if (!msgEl || !card) return;
  const step = document.createElement('div');
  step.className = 'agent-step agent-step-' + (card.classList.contains('agent-ask-card') ? 'ask' : 'todo');
  step.dataset.step = step.classList.contains('agent-ask-card') ? 'ask' : 'todo';
  step.appendChild(card);
  const root = getAgentStepsRoot(msgEl);
  if (root) root.appendChild(step); else msgEl.appendChild(step);
}

/** ask_user 工具结果回来：落实最终状态（用户选了什么 / 超时未选 / 已停止） */
function finalizeAskUserCard(msgEl, result) {
  if (!msgEl) return;
  const card = msgEl.querySelector('.agent-ask-card:not(.answered)');
  if (!card) return;
  card.classList.add('answered');
  disableAskControls(card);
  if (result && result.answered && result.answer) {
    setAskChoice(card, result.answer);
  } else {
    const tip = document.createElement('div');
    tip.className = 'ask-choice';
    tip.textContent = result && result.cancelled ? '已停止任务' : '未选择，AI 已按自己的判断继续';
    card.appendChild(tip);
  }
}


// 指令意图 → 桌宠动作（与宠物的本地指令识别保持一致，统一走通用匹配模块）。
// 当用户的话是在指挥桌宠做动作时，返回对应语义分类名，供 petDoAction 调用，
// 避免龙虾只回一句"搞定"却没有任何实际行动。
// 覆盖文档十大固定分类：greet/dance/sleep/confuse/happy/shy/angry/sad/lazy/idle。
function detectPetAction(text) {
  if (!window.CommandMatch) return null;
  const hits = window.CommandMatch.get_hit_categories(text);
  if (hits.length) {
    // 优先返回非 idle 的分类，纯 idle 意图也允许（如"安静待着"）
    const nonIdle = hits.find(c => c !== 'idle');
    return nonIdle || hits[0];
  }
  // 兼容历史控制指令：醒来（文档十大分类无 wake，但唤醒是必要控制，非情绪分类）
  if (/(起床|醒来|醒醒|wake)/i.test(text || '')) return 'wake';
  return null;
}

// ==================== 「AI 回答中也能发消息」——待发送队列 ====================
// 旧行为：state.isStreaming 时 sendChatMessage 直接 return，回答期间点了发送完全没反应，
// 重新生成也因此失效（它内部就是调用发送）。现在改为：
//   · 回答中发送 → 消息立刻进入会话并显示「等待发送」，本轮回答结束后自动补发（后续等待发送）
//   · 也可点气泡上的「立即发送」→ 打断当前回答马上发出去（立刻发送）
//   · 重新生成同理：回答进行中点击会排队，结束后自动重新生成；完成后是「替换旧回答」而非重发
const _msgElMap = new WeakMap();   // 消息对象 → 其 DOM 元素（renderChat 重建时自动覆盖为最新）
let pendingQueue = [];             // [{ type:'send'|'regenerate', convId, msg, aiMsg, userMsg }]
let _reqSeq = 0;                   // 请求序号：只让「最后一个」请求复位 UI，避免打断时的竞态
let _reqInFlight = false;          // 是否有请求真的在跑（比 state.isStreaming 准：流式 done 事件会提前把它置 false）
let _flushing = false;             // flushPendingQueue 重入保护

function setMsgEl(msg, el) { if (msg && el) _msgElMap.set(msg, el); }
function getMsgEl(msg) { return msg && _msgElMap.get(msg); }

/** 刷新「等待发送 / 等待重新生成」提示条；msg.pending 为空则移除提示条 */
function updatePendingBadge(msg, extraText) {
  const el = getMsgEl(msg);
  if (!el) return;
  let badge = el.querySelector('.pending-badge');
  if (!msg.pending) { if (badge) badge.remove(); return; }
  const isRegen = msg.pending === 'regenerate';
  if (!badge) {
    badge = document.createElement('div');
    badge.className = 'pending-badge';
    badge.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px;color:var(--text-muted);';
    // Agent 消息挂在 .agent-steps 之后（整条步骤流下面），普通消息挂在气泡下面
    const anchor = el.querySelector('.agent-steps') || el.querySelector('.chat-bubble') || el;
    (anchor.parentElement || el).appendChild(badge);
  }
  badge.innerHTML = '<span style="display:inline-flex;align-items:center;gap:5px;">'
    + '<span style="width:6px;height:6px;border-radius:50%;background:var(--accent);opacity:.9;"></span>'
    + (isRegen ? '等待重新生成…' : '等待发送…') + (extraText ? ' ' + extraText : '')
    + '</span>'
    + '<button type="button" class="pb-now" title="' + (isRegen ? '立即重新生成' : '立即发送') + '" aria-label="' + (isRegen ? '立即重新生成' : '立即发送') + '" style="padding:4px 8px;font-size:12px;border:1px solid var(--accent);'
    + 'background:transparent;color:var(--accent);border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;">'
    + '<span class="el-icon">' + (isRegen ? window.ElIcons.getIcon('refreshSolid') : window.ElIcons.getIcon('send')) + '</span></button>';
  const btn = badge.querySelector('.pb-now');
  if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); sendPendingNow(msg); });
}

/** 停止当前生成（不触发补发） */
function stopCurrentRequest() {
  try { if (window.api.cancelChat) window.api.cancelChat(); } catch (e) {}
  state.isStreaming = false;
  _reqInFlight = false;
  const sb = document.getElementById('btn-send');
  const stb = document.getElementById('btn-stop');
  if (sb) { sb.disabled = false; sb.style.display = ''; }
  if (stb) stb.style.display = 'none';
  // 兜底：万一 cancelChat 之后旧请求没有正常收尾，这里延迟再触发一次补发，
  // 避免排队的消息永远卡在「等待发送」
  setTimeout(() => { flushPendingQueue(); }, 400);
}

/** 队列里的消息点「立即发送/立即重新生成」：打断当前回答并马上执行 */
async function sendPendingNow(msg) {
  const i = pendingQueue.findIndex(a => a.msg === msg || a.aiMsg === msg);
  if (i >= 0) pendingQueue.splice(i, 1);
  const conv = getActiveConversation();
  if (!conv) return;
  msg.pending = null;
  updatePendingBadge(msg);
  if (state.isStreaming) stopCurrentRequest();
  if (msg.role === 'ai') {
    // 立即重新生成：先删掉旧回答，再基于其上一条提问重新生成
    let userMsg = null;
    const idx = conv.messages.indexOf(msg);
    for (let k = idx - 1; k >= 0; k--) {
      if (conv.messages[k].role === 'user') { userMsg = conv.messages[k]; break; }
    }
    if (!userMsg) return;
    await doRegenerate(conv, msg, userMsg);
    return;
  }
  await runChatRequest(conv, msg);
  saveConversations();
  renderConversationList();
}

/** 清空待发送队列并移除所有提示条（切换会话时用，避免旧会话的「等待发送」残留/被误发） */
function clearPendingQueue() {
  while (pendingQueue.length) {
    const act = pendingQueue.shift();
    if (act && act.msg) { act.msg.pending = null; updatePendingBadge(act.msg); }
  }
}

/** 本轮回答结束：按先进先出自动补发排队中的消息（"后续等待发送"） */
async function flushPendingQueue() {
  if (_flushing) return;              // runChatRequest 的 finally 会回调这里，防重入
  _flushing = true;
  try {
    while (pendingQueue.length && !state.isStreaming && !_reqInFlight) {
      const act = pendingQueue.shift();
      const conv = getActiveConversation();
      // 会话已切换 / 目标消息已不在会话里 → 丢弃并清掉提示条
      if (!conv || (act.convId && conv.id !== act.convId) ||
          (act.msg && conv.messages.indexOf(act.msg) < 0)) {
        if (act.msg) { act.msg.pending = null; updatePendingBadge(act.msg); }
        continue;
      }
      act.msg.pending = null;
      updatePendingBadge(act.msg);
      if (act.type === 'regenerate') {
        await doRegenerate(conv, act.aiMsg, act.userMsg);
      } else {
        await runChatRequest(conv, act.msg);
      }
    }
  } finally {
    _flushing = false;
  }
}

/**
 * 重新生成：删除这条 AI 回答，基于其上一条用户提问重新生成。
 * 注意——不再把提问塞回输入框再发一遍（那是"重发"，会多出一条重复的用户消息）。
 */
async function regenerateFromAi(aiMsg) {
  const conv = getActiveConversation();
  if (!conv || !conv.messages) return;
  const idx = conv.messages.indexOf(aiMsg);
  if (idx < 0) return;
  let userMsg = null;
  for (let i = idx - 1; i >= 0; i--) {
    if (conv.messages[i].role === 'user') { userMsg = conv.messages[i]; break; }
  }
  if (!userMsg) {
    try { showToast('无法重新生成', '没有找到对应的提问', 'warning'); } catch (e) {}
    return;
  }
  if (state.isStreaming || _reqInFlight) {
    // ★ 回答进行中：排队，本轮结束后自动重新生成（此前点了完全没反应）
    aiMsg.pending = 'regenerate';
    pendingQueue.push({ type: 'regenerate', convId: conv.id, msg: aiMsg, aiMsg, userMsg });
    updatePendingBadge(aiMsg);
    return;
  }
  await doRegenerate(conv, aiMsg, userMsg);
}

/** 删掉旧回答（数据 + DOM）并重新生成 */
async function doRegenerate(conv, aiMsg, userMsg) {
  aiMsg.pending = null;
  updatePendingBadge(aiMsg);
  const idx = conv.messages.indexOf(aiMsg);
  // 记录旧回答在 DOM 中的锚点（用于把新回答插回原位，而不是追加到末尾）
  let anchorEl = null;
  const oldEl = getMsgEl(aiMsg);
  if (oldEl && oldEl.parentElement) anchorEl = oldEl.nextSibling;
  if (idx >= 0) conv.messages.splice(idx, 1);
  if (oldEl) oldEl.remove();
  state.chatHistory = conv.messages;
  await runChatRequest(conv, userMsg);
  // 把刚生成的回答移回原位置（真正「原地替换」：旧回答在哪，新回答就在哪，
  // 而不是因为 runChatRequest 总是 push 到末尾导致顺序错乱、看起来像「又发了一条」）
  const newAi = conv.messages[conv.messages.length - 1];
  if (idx >= 0 && newAi && newAi.role === 'ai' && conv.messages.length - 1 !== idx) {
    conv.messages.splice(conv.messages.length - 1, 1);
    conv.messages.splice(idx, 0, newAi);
    const newEl = getMsgEl(newAi);
    const container = document.getElementById('chat-messages');
    if (newEl && container) {
      if (anchorEl && anchorEl.parentElement === container) container.insertBefore(newEl, anchorEl);
      else container.appendChild(newEl);
    }
  }
  saveConversations();
  renderConversationList();
}

async function sendChatMessage(opts) {
  // 点击监听会把 Event 当第一个参数传进来，忽略掉
  if (opts && typeof Event !== 'undefined' && opts instanceof Event) opts = {};
  opts = opts || {};
  const input = document.getElementById('chat-input');
  const content = (opts.text != null ? String(opts.text) : (input ? input.value : '')).trim();
  // ★ 不再用 state.isStreaming 拦发送：回答中也能发（进队列，结束后自动补发）
  if (!content || state.compressBusy) return; // 压缩进行中不接受新的发送

  // 如果没有活跃会话，自动创建
  if (!getActiveConversation()) {
    createNewConversation();
  }

  if (!state.activeProviderId) {
    const providers = state.cloudProviders.filter(p => p.enabled);
    if (providers.length === 0) {
      showToast('未配置AI模型', '请先在"AI配置"中添加AI模型服务', 'warning');
      switchTab('ai-config');
      return;
    } else {
      state.activeProviderId = providers[0].id;
      document.getElementById('active-provider').value = providers[0].id;
      syncAISettings();
      const ai = buildAIConfig();
      await window.api.setConfig({ ai });
      state.settings.ai = ai;
    }
  }

  // 先把用户消息投进会话并显示出来（压缩期间界面不停滞，压缩完成后自动继续把这轮喂给 AI）
  let aiContent = content;
  if (state.uploadedFiles && state.uploadedFiles.length > 0) {
    const fileList = state.uploadedFiles.map(f => `- ${f.name}（路径：${f.path}）`).join('\n');
    const fileNotice = `[用户上传了以下文件，请使用 read_file 工具读取文件内容后再回答：]\n${fileList}`;
    aiContent = content ? content + '\n\n' + fileNotice : fileNotice;
  }
  const userMsg = { role: 'user', content, time: Date.now(), aiContent, attachments: state.uploadedFiles?.map(f => ({name:f.name,size:f.size,path:f.path})) };
  const conv = getActiveConversation();
  conv.messages.push(userMsg);
  // 清空已上传文件
  state.uploadedFiles = [];
  renderUploadedFiles();
  state.chatHistory = conv.messages; // 保持兼容
  appendChatMessage(userMsg);
  autoTitleConversation(conv, content);
  conv.updatedAt = Date.now();

  if (input) { input.value = ''; input.style.height = 'auto'; }

  // 如果用户的话是在指挥桌宠做动作（如"睡觉""跳舞"），立刻让龙虾执行对应动作，
  // 而不是只在聊天里回一句"搞定"却不操作。
  const petAct = detectPetAction(content);
  if (petAct && window.api.petDoAction) {
    window.api.petDoAction(petAct).catch(() => {});
  }

  // ★ AI 正在回答：消息立刻入列并显示「等待发送」，本轮结束后自动补发（不再"点了没反应"）
  if (state.isStreaming || _reqInFlight) {
    userMsg.pending = 'send';
    pendingQueue.push({ type: 'send', convId: conv.id, msg: userMsg });
    updatePendingBadge(userMsg);
    saveConversations();
    try { scrollChatToBottomIfNeeded(); } catch (e) {}
    return;
  }

  await runChatRequest(conv, userMsg);
}

/**
 * 真正发起一轮 AI 请求。userMsg 必须已经在 conv.messages 里。
 * 普通发送、排队补发、重新生成三条路径共用这里，行为一致。
 */
async function runChatRequest(conv, userMsg) {
  const seq = ++_reqSeq;   // 请求序号：被「立即发送」打断时，旧请求的收尾不能抢新请求的状态

  // 上下文接近上限 → 压缩历史（用户这条消息属于"最近若干条"，不会被压进摘要）
  if (isAutoCompressEnabled()) {
    const preUsage = computeContextUsage(conv);
    if (preUsage.percent >= AUTO_COMPRESS_THRESHOLD && countCompressible(conv) >= 10) {
      const compressRes = await compressConversation({ auto: true });
      // 压缩失败不再静默：提示用户，后续请求仍按预算硬性裁剪（buildOutgoingMessages 保证不越过窗口）
      if (compressRes && !compressRes.success && compressRes.error &&
          compressRes.error !== 'too_few_messages' && compressRes.error !== 'busy') {
        showToast('自动压缩失败', compressRes.error || '未知错误', 'warning');
      }
    }
  }

  state.isStreaming = true;
  _reqInFlight = true;
  state.activeRequestConversationId = conv.id; // 记录当前请求所属的会话ID
  const _sendBtn = document.getElementById('btn-send');
  const _stopBtn = document.getElementById('btn-stop');
  if (_stopBtn) _stopBtn.style.display = '';
      // ★ 回答期间隐藏发送按钮：用户直接按回车即可把消息转为「待发送」（sendChatMessage 会进队列），
      //   右侧只保留停止按钮（btn-stop）。既不另加发送按钮，也避免「点了没反应」的困惑。
      if (_sendBtn) _sendBtn.style.display = 'none';

  try {
    const useAgent = document.getElementById('agent-mode').checked;
    const useStream = document.getElementById('stream-mode').checked;
    // 按上下文预算挑选历史（替代原先写死的"最近 10 条"）；摘要消息始终带上
    const outgoing = buildOutgoingMessages(conv, { agent: useAgent });
    const msgs = outgoing.messages;
    state.lastSentEstimate = {
      convId: conv.id,
      tokens: outgoing.stats.used,
      historyTokens: outgoing.stats.historyTokens,
      isAgent: useAgent,
      at: Date.now()
    };
    if (outgoing.stats.droppedFromWindow > 0) {
      console.log('[Context] 本次请求省略较早消息', outgoing.stats.droppedFromWindow,
        '条；实际发送', msgs.length, '条，估算', outgoing.stats.used, 'tokens');
    }
    if (outgoing.stats.overLimit) {
      // 极端兜底：估算仍超窗口（预算过小），提示用户，避免发送必然失败的请求
      console.warn('[Context] 请求体估算仍超出窗口（overLimit），已按最小预算截断');
      showToast('消息超出上下文窗口', '当前会话内容过多，已截断发送；建议新建会话后重试', 'warning');
    }

    // 非 Agent 模式时清理旧的 agent 状态，避免拦截流式事件
    if (!useAgent) state.agentState = null;

    if (useAgent) {
      // Agent 模式：支持思考过程 + 工具调用
      // steps[]：时间顺序步骤流记录（思考/工具/正文按发生先后逐条），agent-done 导出落库
      state.agentState = { reasoning: '', content: '', tools: [], steps: [], stepEls: {}, currentMsgEl: null, done: false, startTime: Date.now() };
      // 输入框在思考过程中保持可见，不隐藏（用户可能需要随时输入新消息或停止对话）
      // 创建 AI 消息占位
      const aiMsg = { role: 'ai', content: '', time: Date.now(), isAgent: true };
      conv.messages.push(aiMsg);
      state.chatHistory = conv.messages;
      appendAgentMessage(aiMsg, { live: true });
      // 读取 Agent 设置
      const thinkMode = document.getElementById('agent-think-mode')?.checked || false;
      const enabledTools = Array.from(document.querySelectorAll('.agent-tool-check:checked')).map(cb => cb.value);
      const toolConfirm = document.getElementById('agent-tool-confirm')?.checked !== false;
      const result = await window.api.agentChat({
        messages: msgs,
        conversationId: conv.id,   // 待办清单按会话隔离，靠它定位
        providerId: state.activeProviderId,
        thinkMode,
        enabledTools,
        autoAuthorize: !toolConfirm,
        roleId: state.currentRoleId,
        workdir: state.workdir || null,
        interactive: true,   // 主窗口支持 ask_user 选项卡（桌宠等环境不传 → AI 自行判断继续）
        contextWindow: getContextWindow(getActiveProviderConfig()),
        source: 'work'   // 工作模式：工具全部开放
      });
      if (!result || !result.success) {
        showToast('Agent响应失败', result?.error || '未知错误', 'error');
        // 响应失败时显示输入框
        const inputArea = document.querySelector('.chat-input-area');
        if (inputArea) inputArea.style.display = '';
      }
      aiMsg.content = (state.agentState?.content) || pendingAgentContent || result?.content || '（无响应）';
      // 思考过程持久化：agent-done 已把 agentState 置空，优先用接力变量，主进程返回值兜底
      aiMsg.reasoning = (state.agentState?.reasoning) || pendingAgentReasoning || result?.reasoning || '';
      aiMsg.tools = (state.agentState?.tools && state.agentState.tools.length ? state.agentState.tools : pendingAgentTools) || [];
      // ★ 时间顺序步骤流持久化：历史消息按 steps[] 复原「一步步」的过程（无则回退旧分组结构）
      const liveSteps = state.agentState?.steps;
      const finalSteps = (liveSteps && liveSteps.length) ? exportAgentSteps(liveSteps) : pendingAgentSteps;
      if (finalSteps && finalSteps.length) aiMsg.steps = finalSteps;
      // ★ 本轮改动的文件（主进程按实际写操作记录）→ 历史消息也能点开看改了啥
      const liveFiles = state.agentState?.changedFiles;
      const finalFiles = (liveFiles && liveFiles.length) ? liveFiles : pendingAgentChangedFiles;
      if (finalFiles && finalFiles.length) aiMsg.changedFiles = finalFiles;
      pendingAgentReasoning = null;
      pendingAgentTools = null;
      pendingAgentContent = null;
      pendingAgentSteps = null;
      pendingAgentChangedFiles = null;
      // 保存 Token 消耗信息（从 agent-done 事件中保存的临时变量读取）
      if (pendingAgentUsage || pendingAgentElapsedMs > 0) {
        aiMsg.usage = pendingAgentUsage;
        aiMsg.elapsedMs = pendingAgentElapsedMs;
        // 保存后清空临时变量
        pendingAgentUsage = null;
        pendingAgentElapsedMs = 0;
      }
      saveConversations();
      renderConversationList();
    } else {
      // 先创建占位消息，显示等待状态
      const aiMsg = { role: 'ai', content: '', time: Date.now() };
      conv.messages.push(aiMsg);
      state.chatHistory = conv.messages;
      const msgEl = appendChatMessage(aiMsg);
      const bubble = msgEl.querySelector('.chat-bubble');
      bubble.innerHTML = '<span style="color:#888;font-style:italic;">等待模型响应...</span>';
      state.currentAIMsgEl = msgEl;
      state.currentAIContent = '';
      state.currentAIReasoning = '';

      // 记录请求开始时间，用于计算耗时
        const requestStartTime = Date.now();
        // 「思考模式」开关对普通对话同样生效：主进程据此决定是否下发
        // enable_thinking / think，不传就等于恒定按关闭处理（修复非思考模式仍强开思考）。
        const thinkMode = !!document.getElementById('agent-think-mode')?.checked;
        const result = useStream
        ? await window.api.streamChat({
            messages: msgs,
            providerId: state.activeProviderId,
            workdir: state.workdir || null,
            thinkMode,
            source: 'conversation'   // 会话模式：纯对话，无工具能力（识别靠多模态通道）
          })
        : await window.api.chat({
            messages: msgs,
            providerId: state.activeProviderId,
            workdir: state.workdir || null,
            thinkMode,
            source: 'conversation'
          });

      state.currentAIMsgEl = null;
      if (result.success) {
        if (result.providerId && result.providerId !== state.activeProviderId) {
          state.activeProviderId = result.providerId;
          updateActiveProviderDisplay();
        }
        aiMsg.content = state.currentAIContent || result.content || result.data?.choices?.[0]?.message?.content || '（无响应）';
        if (state.currentAIReasoning && !aiMsg.reasoning) aiMsg.reasoning = state.currentAIReasoning;
        if (!aiMsg.reasoning && result.reasoning) aiMsg.reasoning = result.reasoning;
        // 保存原始文本，用于双击编辑
        bubble.dataset.originalContent = aiMsg.content;
        // 使用Markdown渲染
        bubble.innerHTML = renderMarkdown(aiMsg.content);
        // 保存并渲染 Token 消耗统计栏
        const usage = result.usage || result.data?.usage;
        const elapsedMs = Date.now() - requestStartTime;
        if (usage || elapsedMs > 0) {
          aiMsg.usage = usage;
          aiMsg.elapsedMs = elapsedMs;
          renderTokenStatsBar(msgEl, usage, elapsedMs);
        }
        // 用真实 prompt_tokens 校准容量估算（Agent 模式中间插入的工具消息前端看不到，不参与校准）
        updateContextCalibration(conv, usage, useAgent);
        conv.updatedAt = Date.now();
        saveConversations();
        renderConversationList();
      } else {
        bubble.textContent = '响应失败: ' + (result.error || '未知错误');
        bubble.style.color = '#ef4444';
        showToast('AI响应失败', result.error || '未知错误', 'error');
      }
    }
  } catch (err) {
    if (seq === _reqSeq) showToast('请求失败', err.message, 'error');
  } finally {
    // 只有"最后一个"请求才复位 UI —— 被「立即发送」打断时，旧请求的收尾不能覆盖新请求状态
    if (seq === _reqSeq) {
      state.isStreaming = false;
      _reqInFlight = false;
      if (_sendBtn) { _sendBtn.disabled = false; _sendBtn.style.display = ''; }
      if (_stopBtn) _stopBtn.style.display = 'none';
      renderContextBar();
    }
    // 本轮结束 → 自动补发排队中的消息 / 执行排队的重新生成
    flushPendingQueue();
  }
}

// 用上一次请求的真实 prompt_tokens 校准 token 估算偏差，让容量条更接近真实占用
function updateContextCalibration(conv, usage, isAgent) {
  const anchor = state.lastSentEstimate;
  const promptTokens = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
  if (isAgent || !anchor || !conv || anchor.convId !== conv.id || !(promptTokens > 0) || !(anchor.tokens > 0)) return;
  const factor = Math.min(3, Math.max(0.5, promptTokens / anchor.tokens));
  conv.ctxCalib = { factor, promptTokens, at: Date.now() };
  console.log('[Context] 校准系数 =', factor.toFixed(3), '（实际输入', promptTokens, '/ 估算', anchor.tokens, '）');
}

// ==================== 语音识别（按住录音，松开识别） ====================
// 使用主进程 WaveIn API 采集音频（完全避免渲染进程崩溃）
// 渲染进程只负责触发和显示结果，完全不接触音频流
let voiceRec = null; // { recording, startTime, btn }

function startVoiceCapture() {
  console.log('[Voice] === startVoiceCapture 开始 ===');
  try {
    if (voiceRec && voiceRec.recording) {
      console.log('[Voice] 已在录音中，跳过');
      return;
    }
    
    // 检查语音识别接口
    if (!window.api || !window.api.speechRecordStart) {
      console.log('[Voice] 语音录制接口不可用');
      try { showToast('语音不可用', '当前环境不支持语音录制', 'warning'); } catch(e) {}
      return;
    }

    // ASR 模块前置检查：模块没下载就不开录（录了也识别不了，白录）
    getAsrStatusSafe().then((st) => {
      if (voiceRec && voiceRec.recording) return; // 检查期间用户已经开始别的操作
      if (st && !st.installed) {
        handleAsrMissing(true);
        return;
      }
      doStartVoiceCapture();
    }).catch(() => doStartVoiceCapture());
  } catch(err) {
    console.error('[Voice] startVoiceCapture顶层异常:', err);
    voiceRec = null;
  }
}

async function doStartVoiceCapture() {
  try {
    console.log('[Voice] 开始初始化...');

    // 获取按钮元素并添加recording类
    let btn = null;
    try {
      btn = document.getElementById('btn-voice');
      if (btn) btn.classList.add('recording');
      console.log('[Voice] 按钮状态已更新');
    } catch(e) {
      console.error('[Voice] 更新按钮状态失败:', e);
    }

    // 初始化voiceRec
    voiceRec = { recording: true, startTime: Date.now(), btn: btn };
    console.log('[Voice] voiceRec 初始化完成');

    // 调用主进程开始录制（worker 线程采集，渲染进程不接触音频流）
    console.log('[Voice] 调用主进程开始录制...');
    window.api.speechRecordStart()
      .then((result) => {
        console.log('[Voice] 主进程录制启动结果:', result);
        
        if (!result.success) {
          console.log('[Voice] 录制启动失败:', result.error);
          voiceRec.recording = false;
          if (btn) try { btn.classList.remove('recording'); } catch(e) {}
          voiceRec = null;
          try { showToast('录音失败', result.error, 'error'); } catch(e) {}
          return;
        }
        
        console.log('[Voice] 录制已开始');
        try { showToast('开始录音', '按住说话，松开自动识别', 'info'); } catch(e) {}
      })
      .catch((err) => {
        console.error('[Voice] 录制启动异常:', err);
        if (voiceRec) {
          voiceRec.recording = false;
          if (btn) try { btn.classList.remove('recording'); } catch(e) {}
          voiceRec = null;
        }
        try { showToast('录音失败', (err && err.message) ? err.message : '未知错误', 'error'); } catch(e) {}
      });
    
    console.log('[Voice] === doStartVoiceCapture 结束 ===');
  } catch(err) {
    console.error('[Voice] doStartVoiceCapture顶层异常:', err);
    voiceRec = null;
  }
}

function stopVoiceCapture() {
  console.log('[Voice] === stopVoiceCapture 开始 ===');
  if (!voiceRec || !voiceRec.recording) {
    console.log('[Voice] 未在录音中，跳过');
    return;
  }
  
  console.log('[Voice] 停止录音...');
  voiceRec.recording = false;
  
  const btn = voiceRec.btn;
  try { if (btn) btn.classList.remove('recording'); } catch(e) {}
  
  const recData = voiceRec;
  voiceRec = null;
  
  // 调用主进程停止录制并获取WAV数据
  console.log('[Voice] 调用主进程停止录制...');
  window.api.speechRecordStop()
    .then(async (result) => {
      console.log('[Voice] 主进程录制停止结果:', result.success ? '成功，WAV大小: ' + (result.wavBuffer ? result.wavBuffer.byteLength : 0) + ' bytes' : '失败: ' + result.error);
      
      if (!result.success) {
        console.log('[Voice] 录制停止失败:', result.error);
        if (result.error && result.error !== '未采集到音频数据') {
          try { showToast('录音失败', result.error, 'error'); } catch(e) {}
        } else {
          try { showToast('录音结束', '未采集到音频', 'info'); } catch(e) {}
        }
        return;
      }
      
      if (!result.wavBuffer || result.wavBuffer.byteLength === 0) {
        console.log('[Voice] 未录制到音频数据');
        try { showToast('录音结束', '未采集到音频', 'info'); } catch(e) {}
        return;
      }
      
      // 检查语音识别接口
      if (!window.api || !window.api.speechRecognizeWav) {
        console.log('[Voice] 语音识别接口不可用');
        try { showToast('识别失败', '语音识别接口不可用', 'error'); } catch(e) {}
        return;
      }
      
      // 调用主进程 SAPI 识别（WAV文件输入）
      console.log('[Voice] 调用主进程语音识别（WAV）...');
      try { showToast('识别中', '正在识别语音...', 'info'); } catch(e) {}
      
      try {
        const recognizeResult = await window.api.speechRecognizeWav(result.wavBuffer);
        console.log('[Voice] 识别结果:', recognizeResult);
        
        if (recognizeResult.success && recognizeResult.text) {
          console.log('[Voice] 识别成功:', recognizeResult.text);
          try {
            document.getElementById('chat-input').value = recognizeResult.text;
            sendChatMessage();
          } catch(e) {
            console.error('[Voice] 发送消息失败:', e);
          }
        } else if (recognizeResult.error && recognizeResult.error !== 'cancelled') {
          console.log('[Voice] 识别失败:', recognizeResult.error);
          if (recognizeResult.code === 'ASR_NOT_INSTALLED') {
            // 模块在录音期间被删（罕见竞态）→ 引导下载
            handleAsrMissing(true);
          } else {
            try { showToast('识别失败', recognizeResult.error, 'error'); } catch(e) {}
          }
        } else {
          console.log('[Voice] 未识别到语音内容');
          try { showToast('录音结束', '未识别到语音内容', 'info'); } catch(e) {}
        }
      } catch(err) {
        console.error('[Voice] 识别异常:', err);
        try { showToast('识别失败', (err && err.message) ? err.message : '未知错误', 'error'); } catch(e) {}
      }
    })
    .catch((err) => {
      console.error('[Voice] 停止录制异常:', err);
      try { showToast('录音失败', (err && err.message) ? err.message : '未知错误', 'error'); } catch(e) {}
    });
  
  console.log('[Voice] === stopVoiceCapture 结束（等待主进程处理）===');
}

// ==================== ASR 模块（Sherpa-ONNX + SenseVoice int8）下载管理 ====================
// 模块式下载：初次启动/点语音按钮时若模块缺失，弹窗询问下载（约 230MB，
// 中英日韩粤语离线识别）。拒绝后记 localStorage，之后只有点语音按钮才再提示。

let asrProgressUiBound = false;
let asrDlOverlayEl = null;
let asrDownloadActive = false; // 本窗口是否正在等待一次下载（含后台下载），用于完成/失败提示去重
let asrResultHandled = false;  // 进度监听器是否已对本次下载结果弹过提示（防 await 兜底重复 toast）

async function getAsrStatusSafe() {
  try {
    if (!window.api || !window.api.asrStatus) return null;
    return await window.api.asrStatus();
  } catch (e) {
    console.error('[Voice] 获取 ASR 模块状态失败:', e);
    return null;
  }
}

function bindAsrProgressListener() {
  if (asrProgressUiBound || !window.api || !window.api.onAsrProgress) return;
  asrProgressUiBound = true;
  window.api.onAsrProgress((st) => {
    if (!st) return;
    if (asrDlOverlayEl) updateAsrProgressUI(st);
    // 完成/失败提示以此处为唯一来源（弹窗关闭=后台下载时也能收到通知）；
    // startAsrDownload 的 await 结果不再重复弹 toast
    if (!asrDownloadActive) return;
    if (st.phase === 'idle' && st.installed) {
      asrDownloadActive = false;
      asrResultHandled = true;
      closeAsrProgressUI();
      showToast('下载完成', '语音识别模块已就绪，可以使用语音识别了', 'success');
    } else if (st.phase === 'error') {
      asrDownloadActive = false;
      asrResultHandled = true;
      closeAsrProgressUI();
      showToast('下载失败', '请检查网络后点击语音按钮重试', 'error', { duration: 5000 });
    }
  });
}

function showAsrProgressUI() {
  bindAsrProgressListener();
  if (asrDlOverlayEl) return;
  const overlay = document.createElement('div');
  overlay.className = 'asr-dl-overlay';
  overlay.innerHTML = `
    <div class="asr-dl-box">
      <div class="asr-dl-title">正在下载语音识别模块</div>
      <div class="asr-dl-sub">SenseVoice 本地离线识别（中/英/日/韩/粤语），下载后无需联网</div>
      <div class="asr-dl-bar"><div class="asr-dl-fill" style="width:0%"></div></div>
      <div class="asr-dl-info">准备中…</div>
      <div class="asr-dl-actions">
        <button class="asr-dl-bg" type="button">后台下载</button>
        <button class="asr-dl-cancel" type="button">取消下载</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  asrDlOverlayEl = overlay;
  // 后台下载：仅关闭弹窗，不中止下载；完成/失败由进度监听器 toast 通知
  overlay.querySelector('.asr-dl-bg').addEventListener('click', () => {
    closeAsrProgressUI();
    showToast('已转入后台下载', '完成后将自动通知您，期间可正常使用其他功能', 'info');
  });
  overlay.querySelector('.asr-dl-cancel').addEventListener('click', async () => {
    asrDownloadActive = false;
    try { await window.api.asrCancelDownload(); } catch (e) {}
    closeAsrProgressUI();
    showToast('已取消下载', '需要时点击语音按钮重新下载', 'info');
  });
}

function updateAsrProgressUI(st) {
  if (!asrDlOverlayEl) return;
  const fill = asrDlOverlayEl.querySelector('.asr-dl-fill');
  const info = asrDlOverlayEl.querySelector('.asr-dl-info');
  const title = asrDlOverlayEl.querySelector('.asr-dl-title');
  const p = st.progress || {};
  if (st.phase === 'extracting') {
    if (title) title.textContent = '正在解压模块…';
    if (fill) fill.style.width = '100%';
    if (info) info.textContent = '解压中，请稍候';
    return;
  }
  const mb = (n) => (n / 1024 / 1024).toFixed(1);
  const pct = p.total > 0 ? Math.min(99, Math.round(p.received / p.total * 100)) : 0;
  if (fill) fill.style.width = pct + '%';
  if (info) {
    info.textContent = p.total > 0
      ? `${pct}% · ${mb(p.received)}MB / ${mb(p.total)}MB`
      : `${mb(p.received)}MB`;
  }
}

function closeAsrProgressUI() {
  if (asrDlOverlayEl) {
    asrDlOverlayEl.remove();
    asrDlOverlayEl = null;
  }
}

async function startAsrDownload() {
  bindAsrProgressListener();
  showAsrProgressUI();
  asrDownloadActive = true;
  asrResultHandled = false;
  try {
    const res = await window.api.asrDownload();
    // 成功/失败提示由进度监听器统一处理（含后台下载场景），这里只做兜底收尾
    asrDownloadActive = false;
    if (asrDlOverlayEl) closeAsrProgressUI();
    if (res && res.success) return true;
    if (res && !res.cancelled && !asrResultHandled) {
      showToast('下载失败', res.error || '未知错误', 'error', { duration: 5000 });
    }
    return false;
  } catch (e) {
    asrDownloadActive = false;
    if (asrDlOverlayEl) closeAsrProgressUI();
    if (!asrResultHandled) {
      showToast('下载失败', (e && e.message) || '未知错误', 'error');
    }
    return false;
  }
}

// 模块缺失时的统一入口（仅用户主动点语音按钮时触发）：正在下载→恢复进度条；否则弹询问框
async function handleAsrMissing() {
  const st = await getAsrStatusSafe();
  if (st && st.installed) return true;
  if (st && st.downloading) {
    // 下载已在进行（可能处于后台下载中）：恢复弹窗并保持完成/失败通知
    asrDownloadActive = true;
    showAsrProgressUI();
    return false;
  }
  const ok = await showConfirm({
    type: 'info',
    title: '下载语音识别模块',
    message: `语音识别需要本地识别模块（约 ${(st && st.approxDownloadMB) || 230}MB），支持中英日韩粤语离线识别，是否立即下载？`,
    buttons: ['立即下载', '暂不']
  });
  if (!ok) {
    return false;
  }
  startAsrDownload();
  return false;
}

// ==================== 模型管理 ====================
function renderModelList() {
  const listEl = document.getElementById('model-list');
  listEl.innerHTML = '';
  updateModelStatusBar();

  // 默认皮肤条目（始终显示在最前面）
  const defaultItem = document.createElement('div');
  defaultItem.className = 'model-item' + (!state.currentModelId ? ' selected' : '');
  defaultItem.innerHTML = `
    <div class="model-thumbnail">
      <div class="model-thumb-wrap default-lobster-thumb"><img src="../../assets/icons/pet-lingxi-512.png" alt="灵汐" style="width:100%;height:100%;object-fit:contain;"></div>
    </div>
    <div class="model-info">
      <div class="model-name">灵汐</div>
      <div class="model-meta">
        <span>内置形象</span>
        <span>浮灵饰界</span>
      </div>
    </div>
    <div class="model-actions">
      ${state.currentModelId ? `<button class="btn btn-sm btn-primary" data-action="apply-default">应用</button>` : '<span class="status-indicator connected"><span class="indicator-dot"></span>使用中</span>'}
      <button class="btn btn-sm" data-action="info-default">详情</button>
    </div>
  `;
  defaultItem.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'apply-default') {
      restoreDefaultModel();
    } else if (action === 'info-default') {
      showDefaultModelInfo();
    }
  });
  listEl.appendChild(defaultItem);

  if (!state.models || state.models.length === 0) {
    listEl.appendChild(createEmptyState());
    return;
  }

  state.models.forEach(model => {
    const item = document.createElement('div');
    item.className = 'model-item' + (model.id === state.currentModelId ? ' selected' : '');
    const isBongo = model.isBongocat === true;
    item.innerHTML = `
      <div class="model-thumbnail">${getModelIcon(model.format, model.thumbnail)}</div>
      <div class="model-info">
        <div class="model-name">
          ${escapeHtml(model.name)}
          ${isBongo ? '<span class="bongocat-badge">BongoCat</span>' : ''}
        </div>
        <div class="model-meta">
          <span>${model.format || 'Live2D'}</span>
          <span>${formatSize(model.size)}</span>
          <span>${model.importedAt ? new Date(model.importedAt).toLocaleDateString() : ''}</span>
        </div>
      </div>
      <div class="model-actions">
        ${model.id !== state.currentModelId ? `<button class="btn btn-sm btn-primary" data-action="apply">应用</button>` : '<span class="status-indicator connected"><span class="indicator-dot"></span>使用中</span>'}
        <button class="btn btn-sm" data-action="info">详情</button>
        <button class="btn btn-sm btn-danger" data-action="delete">删除</button>
      </div>
    `;

    item.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'apply') {
        applyModel(model.id);
      } else if (action === 'info') {
        showModelInfo(model);
      } else if (action === 'delete') {
        deleteModel(model);
      } else {
        showModelInfo(model);
      }
    });

    listEl.appendChild(item);
  });
  // 异步加载模型图标（替换默认占位为真实 SVG）
  if (window.ModelIcons && window.ModelIcons.updateIconsInContainer) {
    setTimeout(() => window.ModelIcons.updateIconsInContainer(listEl), 50);
  }


  // 刷新BongoCat模型下拉菜单
  refreshBongocatModelSelect();
  // 异步加载模型缩略图（IPC 读取转 base64）
  loadModelThumbnails();
}

async function importModelFile() {
  const paths = await window.api.selectFiles({
    filters: [
      { name: 'Live2D / MMD 模型', extensions: ['json', 'pmx', 'pmd'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (!paths || paths.length === 0) return;

  const path = paths[0];
  showToast('正在导入模型...', path, 'info');

  const result = await window.api.importModel(path);
  if (result.success) {
    state.models = await window.api.listModels();
    renderModelList();
    const count = result.count || 1;
    if (count > 1) {
      showToast('导入成功', `共导入 ${count} 个模型`, 'success');
    } else {
      showToast('导入成功', `${result.data.name} 已导入`, 'success');
    }
  } else {
    showToast('导入失败', result.error, 'error');
  }
}

async function importModelDirectory() {
  const dirs = await window.api.selectDirectory();
  if (!dirs || dirs.length === 0) return;

  const dirPath = dirs[0];
  showToast('正在导入模型目录...', dirPath, 'info');

  const result = await window.api.importModel(dirPath);
  if (result.success) {
    state.models = await window.api.listModels();
    renderModelList();
    const count = result.count || 1;
    if (count > 1) {
      showToast('导入成功', `共从目录导入 ${count} 个模型`, 'success');
    } else {
      showToast('导入成功', `${result.data.name} 已导入`, 'success');
    }
  } else {
    showToast('导入失败', result.error, 'error');
  }
}

// ==================== BongoCat 键盘猫专用 ====================
async function setBongocatPath() {
  const current = await window.api.getBongocatModel();
  const input = await window.AppDialog.prompt({
    title: '设置 BongoCat 模型',
    message: '输入 BongoCat 模型 .model3.json 文件的完整路径：',
    defaultValue: current || ''
  });
  if (input === null) return;
  const result = await window.api.setBongocatModel(input.trim());
  if (result && result.success) {
    showToast('路径已更新', input.trim(), 'success');
    updateBongocatStatus();
  } else {
    showToast('设置失败', result?.error || '路径无效', 'error');
  }
}

async function launchBongocatWindow() {
  // 优先使用下拉菜单中选中的模型
  const selectEl = document.getElementById('bongocat-model-select');
  let modelPath = selectEl && selectEl.value ? selectEl.value : null;

  // 如果下拉菜单没有选中，使用配置的模型路径
  if (!modelPath) {
    modelPath = await window.api.getBongocatModel();
  }

  if (!modelPath) {
    showToast('未选择模型', '请先在下拉菜单中选择已导入的BongoCat模型', 'warning');
    return;
  }
  // 验证文件存在
  const exists = await window.api.fileExists(modelPath);
  if (!exists) {
    showToast('模型文件不存在', modelPath, 'error');
    return;
  }
  // 保存到配置
  await window.api.setBongocatModel(modelPath);
  const result = await window.api.launchBongocat(modelPath);
  if (result && result.success) {
    showToast('BongoCat 已启动', '键盘猫模式已激活，全局键盘响应已开启', 'success');
  } else {
    showToast('启动失败', result?.error || '未知错误', 'error');
  }
}

// 填充BongoCat模型下拉菜单（从已导入模型中筛选isBongocat的模型）
function refreshBongocatModelSelect() {
  const selectEl = document.getElementById('bongocat-model-select');
  if (!selectEl) return;
  // 保留默认选项
  selectEl.innerHTML = '<option value="">-- 请选择已导入的BongoCat模型 --</option>';
  if (!state.models || state.models.length === 0) return;
  let hasBongo = false;
  state.models.forEach(model => {
    if (model.isBongocat === true) {
      hasBongo = true;
      const option = document.createElement('option');
      option.value = model.modelFile || model.path || '';
      option.textContent = model.name + (model.format ? ' (' + model.format + ')' : '');
      selectEl.appendChild(option);
    }
  });
  if (!hasBongo) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '-- 暂无BongoCat模型，请先导入 --';
    option.disabled = true;
    selectEl.appendChild(option);
  }
}

async function updateBongocatStatus() {
  const statusEl = document.getElementById('bongocat-status');
  if (!statusEl) return;
  try {
    const modelPath = await window.api.getBongocatModel();
    if (modelPath) {
      const exists = await window.api.fileExists(modelPath);
      const modelDir = window.api.path.dirname(modelPath);
      const hasKeys = await window.api.fileExists(modelDir + '/resources/left-keys');
      statusEl.innerHTML = `
        <div style="color:#81c784;">✓ 已配置模型路径</div>
        <div style="margin-top:4px; word-break:break-all;">${modelPath}</div>
        <div style="margin-top:4px; font-size:11px;">
          ${exists ? '<span style="color:#81c784;">✓ 文件存在</span>' : '<span style="color:#ef5350;">✗ 文件不存在</span>'}
          ${hasKeys ? ' · <span style="color:#81c784;">✓ 含按键图片</span>' : ' · <span style="color:#ffb74d;">⚠ 无按键图片</span>'}
        </div>`;
    } else {
      statusEl.innerHTML = '未配置 BongoCat 模型路径。支持含 <code style="color:#4fc3f7;">resources/left-keys/</code> 按键图片的 Live2D Cubism3/4 模型。';
    }
  } catch(e) {
    statusEl.textContent = '状态读取失败: ' + e.message;
  }
}

async function applyModel(modelId) {
  const result = await window.api.setCurrentModel(modelId);
  if (result) {
    state.currentModelId = modelId;
    renderModelList();
  }
}

async function restoreDefaultModel() {
  const result = await window.api.setCurrentModel(null);
  if (result) {
    state.currentModelId = null;
    renderModelList();
  }
}

function showDefaultModelInfo() {
  const panel = document.getElementById('model-info-panel');
  panel.innerHTML = `
    <div class="model-detail-section">
      <div class="model-detail-icon default-lobster-detail"><img src="../../assets/icons/pet-lingxi-512.png" alt="灵汐" style="width:100%;height:100%;object-fit:contain;"></div>
      <h3 class="model-detail-title">灵汐</h3>
    </div>
    <div class="model-detail-section">
      <div class="detail-row"><span class="label">类型</span><span>内置形象</span></div>
      <div class="detail-row"><span class="label">来源</span><span>浮灵饰界</span></div>
      <div class="detail-row"><span class="label">描述</span><span>应用内置的默认灵汐形象，无需加载外部模型</span></div>
    </div>
    <div class="model-detail-actions">
      <button class="btn btn-primary" id="btn-apply-default">${!state.currentModelId ? '当前使用中' : '应用此模型'}</button>
    </div>
  `;
  document.getElementById('btn-apply-default')?.addEventListener('click', () => {
    if (state.currentModelId) restoreDefaultModel();
  });
}

async function deleteModel(model) {
  const confirmed = await showConfirm({
    type: 'warning',
    title: '删除模型',
    message: `确定要删除模型「${model.name}」吗？`,
    detail: '此操作不可恢复，模型文件将被永久删除。'
  });

  if (confirmed) {
    const result = await window.api.deleteModel(model.id);
    if (result.success) {
      state.models = await window.api.listModels();
      renderModelList();
      showToast('删除成功', '', 'success');
    } else {
      showToast('删除失败', result.error, 'error');
    }
  }
}

async function showModelInfo(model) {
  currentShownModel = model;
  const panel = document.getElementById('model-info-panel');
  const t = window.I18N?.t || ((k) => k);

  // 自动重新扫描缩略图：优先识别模型目录中的 GIF 动图
  // 这样已导入的旧模型（静态缩略图）也能自动刷新为 GIF 动图预览
  try {
    const res = await window.api.rescanThumbnail(model.id);
    if (res && res.success && res.data && res.data.thumbnail !== model.thumbnail) {
      model.thumbnail = res.data.thumbnail;
      // 同步更新 state.models 中的缓存
      const cached = state.models.find(m => m.id === model.id);
      if (cached) cached.thumbnail = model.thumbnail;
      renderModelList();
    }
  } catch (e) { /* 忽略，回退到原缩略图 */ }

  const thumbHtml = model.thumbnail
    ? `<div id="model-edit-thumb-wrap" data-thumb="${model.thumbnail.replace(/"/g, '&quot;')}">${window.ElIcons.getIcon('model')}</div>`
    : `<div class="model-edit-thumb-placeholder"><span class="el-icon">${window.ElIcons.getIcon('modelFile')}</span></div>`;

  const isCurrent = model.id === state.currentModelId;
  const isMMD = (model.type === 'MMD' || (model.format || '').toUpperCase().includes('MMD'));
  const isBongocat = model.isBongocat === true;

  panel.innerHTML = `
    <div class="model-detail-section model-edit-head">
      <div class="model-edit-thumb" id="model-edit-thumb">
        ${thumbHtml}
      </div>
    </div>

    ${isBongocat ? `
    <div class="bongocat-detail-section">
      <div class="bongocat-detail-title">BongoCat 键盘猫模型</div>
      <div class="bongocat-detail-desc">
        此模型含键盘按键图片和专用参数。点击「应用此模型」后自动启用<strong class="bongocat-highlight">全局键盘响应</strong>（窗口失焦也能打字），模型原地响应键盘和鼠标，无需额外操作。
      </div>
    </div>
    ` : ''}

    <div class="model-detail-section">
      <div class="modal-form-group">
        <label>${t('models.editName')}</label>
        <input type="text" id="input-edit-name" value="${escapeHtml(model.name)}" maxlength="50">
      </div>
      <div class="modal-form-group">
        <label>${t('models.editDesc')}</label>
        <textarea id="input-edit-desc" rows="3" placeholder="${t('models.editDescPlaceholder')}">${escapeHtml(model.description || '')}</textarea>
      </div>
    </div>

    <div class="model-detail-section">
      <div class="detail-row"><span class="label">${t('models.format')}</span><span>${model.format || '-'}</span></div>
      <div class="detail-row"><span class="label">${t('models.type')}</span><span>${model.type || '-'}${isBongocat ? ' BongoCat' : ''}</span></div>
      <div class="detail-row"><span class="label">${t('models.size')}</span><span>${formatSize(model.size)}</span></div>
      <div class="detail-row"><span class="label">${t('models.version')}</span><span>${model.version || '-'}</span></div>
      <div class="detail-row"><span class="label">${t('models.importedAt')}</span><span>${model.importedAt ? new Date(model.importedAt).toLocaleString() : '-'}</span></div>
    </div>

    <div class="model-detail-section" id="model-actions-section">
      ${isMMD
        ? `<div class="detail-loading">${t('models.loading') || '加载动作中...'}</div>`
        : `<div class="ae-note">${t('actions.mmdOnly')}</div>`}
    </div>

    <div class="model-detail-actions model-edit-actions">
      <button class="btn btn-primary" id="btn-save-model">${t('models.save')}</button>
      <button class="btn ${isCurrent ? '' : 'btn-primary'}" id="btn-apply-model" ${isCurrent ? 'disabled' : ''}>${isCurrent ? t('models.inUse') : t('models.apply')}</button>
      <button class="btn btn-danger" id="btn-delete-model">${t('models.delete')}</button>
    </div>
  `;

  document.getElementById('btn-save-model').addEventListener('click', () => saveModelEdits(model));
  if (!isCurrent) {
    document.getElementById('btn-apply-model').addEventListener('click', () => applyModel(model.id));
  }
  document.getElementById('btn-delete-model').addEventListener('click', () => deleteModel(model));

  if (isMMD) loadModelActionsSection(model);
  // 异步加载详情页缩略图
  if (model.thumbnail) {
    (async () => {
      try {
        const result = await window.api.readFile({ path: model.thumbnail, encoding: 'base64' });
        const wrap = document.getElementById('model-edit-thumb-wrap');
        if (!wrap) return;
        if (result && result.success && result.data) {
          const ext = (model.thumbnail.split('.').pop() || 'png').toLowerCase();
          const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
          wrap.innerHTML = `<img class="model-edit-thumb-img" src="data:${mime};base64,${result.data}" alt="">`;
        } else {
          wrap.innerHTML = `<div class="model-edit-thumb-placeholder"><span class="el-icon">${window.ElIcons.getIcon('modelFile')}</span></div>`;
        }
      } catch (e) {}
    })();
  }
}

// ==================== 动作可视化编辑（每模型独立 actions.json）====================
// 显示在「模型管理」详情面板里：列出内置 + 自定义动作，设置待机动作，
// 编辑/新建关键帧动作（含 AI 生成、预览、保存并命名）、设置相关动作。
const BUILTIN_ACTIONS = [
  { key: 'turn', label: '转身' }, { key: 'turn_away', label: '背过身' },
  { key: 'nod', label: '点头' }, { key: 'shake', label: '摇头' }, { key: 'bow', label: '鞠躬' },
  { key: 'wave', label: '招手' }, { key: 'jump', label: '跳跃' }, { key: 'dance', label: '跳舞' },
  { key: 'squat', label: '蹲下' }, { key: 'sit', label: '坐下' }, { key: 'stand', label: '站起来' },
  { key: 'stretch', label: '伸懒腰' }, { key: 'think', label: '思考' }, { key: 'shy', label: '害羞' },
  { key: 'clap', label: '鼓掌' }, { key: 'point', label: '指向' }, { key: 'yawn', label: '打哈欠' },
  { key: 'cross', label: '叉腰' }
];
const ACTION_BONES = [
  ['head', '头'], ['neck', '颈'], ['upperBody', '上半身'], ['upperBody2', '上半身2'], ['lowerBody', '下半身'],
  ['lShoulder', '左肩'], ['lArm', '左大臂'], ['lElbow', '左肘'], ['lWrist', '左手腕'],
  ['rShoulder', '右肩'], ['rArm', '右大臂'], ['rElbow', '右肘'], ['rWrist', '右手腕'],
  ['lLeg', '左腿'], ['lKnee', '左膝'], ['lAnkle', '左踝'],
  ['rLeg', '右腿'], ['rKnee', '右膝'], ['rAnkle', '右踝']
];
const ACTION_MORPHS = [
  ['happy', '开心'], ['sad', '悲伤'], ['angry', '生气'], ['surprise', '惊讶'],
  ['shy', '害羞'], ['think', '思考'], ['confuse', '困惑'], ['greet', '问候'], ['love', '喜爱'], ['sleepy', '困倦']
];
// 中文骨骼名 → 逻辑键（容错 AI 可能用中文命名）
const BONE_ALIAS = {
  '头': 'head', '头部': 'head', '脑袋': 'head', '脖子': 'neck', '颈部': 'neck', '颈': 'neck',
  '上半身': 'upperBody', '上半身2': 'upperBody2', '胸': 'upperBody2', '胸口': 'upperBody2', '躯干': 'upperBody',
  '下半身': 'lowerBody', '腰': 'lowerBody', '腰部': 'lowerBody', '髋': 'lowerBody', '胯': 'lowerBody',
  '左肩': 'lShoulder', '左大臂': 'lArm', '左臂': 'lArm', '左上臂': 'lArm', '左小臂': 'lElbow', '左前臂': 'lElbow', '左肘': 'lElbow', '左手腕': 'lWrist', '左手': 'lWrist',
  '右肩': 'rShoulder', '右大臂': 'rArm', '右臂': 'rArm', '右上臂': 'rArm', '右小臂': 'rElbow', '右前臂': 'rElbow', '右肘': 'rElbow', '右手腕': 'rWrist', '右手': 'rWrist',
  '左腿': 'lLeg', '左大腿': 'lLeg', '左膝': 'lKnee', '左膝盖': 'lKnee', '左小腿': 'lKnee', '左踝': 'lAnkle', '左脚': 'lAnkle', '左脚踝': 'lAnkle',
  '右腿': 'rLeg', '右大腿': 'rLeg', '右膝': 'rKnee', '右膝盖': 'rKnee', '右小腿': 'rKnee', '右踝': 'rAnkle', '右脚': 'rAnkle', '右脚踝': 'rAnkle'
};
// 无法用具体骨骼表达、但可近似到逻辑骨骼的部位
const BODY_PART_TO_BONE = {
  '帽子': 'head', '发饰': 'head', '头发': 'head', '刘海': 'head',
  '手指': 'lWrist', '手掌': 'lWrist', '手腕': 'lWrist',
  '裙摆': 'lowerBody', '裙子': 'lowerBody', '马尾': 'head', '辫子': 'head',
  '呼吸': 'upperBody', '吸气': 'upperBody', '呼气': 'upperBody', '起伏': 'upperBody'
};
// 中文表情名 → 逻辑键（容错 AI 可能用中文命名表情）
const MORPH_ALIAS = {};
for (const [key, label] of ACTION_MORPHS) MORPH_ALIAS[label] = key;
Object.assign(MORPH_ALIAS, {
  '开心': 'happy', '高兴': 'happy', '笑': 'happy', '微笑': 'happy', '笑脸': 'happy',
  '悲伤': 'sad', '伤心': 'sad', '难过': 'sad', '哭': 'sad',
  '生气': 'angry', '愤怒': 'angry', '恼火': 'angry',
  '惊讶': 'surprise', '吃惊': 'surprise', '震惊': 'surprise',
  '害羞': 'shy', '羞涩': 'shy', '脸红': 'shy',
  '思考': 'think', '想': 'think', '冥想': 'think',
  '困惑': 'confuse', '疑惑': 'confuse', '迷糊': 'confuse',
  '问候': 'greet', '打招呼': 'greet', '问好': 'greet',
  '喜爱': 'love', '喜欢': 'love', '爱': 'love', '爱心': 'love',
  '困倦': 'sleepy', '困': 'sleepy', '瞌睡': 'sleepy', '想睡': 'sleepy'
});
// ===== 傻瓜式预设姿势模板（作为复杂动作的"编辑起点"，一键套用整套关键帧）=====
// 角度以"度"书写，运行时乘以 _R 转弧度；数值经人工校验，遵循骨骼链自然姿态约定
// （如肩 z 负/正=外展抬起、肘 z 正=屈肘、膝只取正值屈膝），避免穿模/反关节。
// 注意：这些模板是"起始骨架"，用户可在此基础上继续逐骨微调，满足"复杂修改"需求。
const _R = Math.PI / 180;
const POSE_TEMPLATES = {
  wave: { label: '挥手打招呼', duration: 1.5, loop: true, keyframes: [
    { t: 0,    bones: {}, morphs: { greet: 0.3 } },
    { t: 0.5,  bones: { rShoulder: { z: -35*_R }, rArm: { z: -70*_R }, rElbow: { z: 60*_R }, rWrist: { x: 25*_R, z: 12*_R }, head: { y: 8*_R } }, morphs: { greet: 0.5 } },
    { t: 1,    bones: {}, morphs: {} }
  ]},
  cheer: { label: '欢呼跳跃', duration: 1.2, loop: true, keyframes: [
    { t: 0,    bones: {}, morphs: { happy: 0.3 } },
    { t: 0.3,  bones: { lShoulder: { z: 55*_R }, rShoulder: { z: -55*_R }, lArm: { z: 55*_R }, rArm: { z: -55*_R }, lElbow: { z: 18*_R }, rElbow: { z: 18*_R }, head: { x: -8*_R } }, root: { y: 0.14 }, morphs: { happy: 0.7 } },
    { t: 0.65, bones: { lShoulder: { z: 55*_R }, rShoulder: { z: -55*_R }, lArm: { z: 55*_R }, rArm: { z: -55*_R } }, root: { y: 0 }, morphs: { happy: 0.5 } },
    { t: 1,    bones: {}, morphs: {} }
  ]},
  bow: { label: '鞠躬致谢', duration: 1.4, loop: true, keyframes: [
    { t: 0,    bones: {}, morphs: { greet: 0.3 } },
    { t: 0.5,  bones: { upperBody: { x: 30*_R }, upperBody2: { x: 18*_R }, neck: { x: 12*_R }, head: { x: 18*_R }, lArm: { z: 6*_R }, rArm: { z: -6*_R } }, morphs: { greet: 0.5 } },
    { t: 1,    bones: {}, morphs: {} }
  ]},
  think: { label: '思考托腮', duration: 2.0, loop: true, keyframes: [
    { t: 0,    bones: {}, morphs: { think: 0.3 } },
    { t: 0.5,  bones: { rShoulder: { z: -30*_R }, rArm: { z: -35*_R }, rElbow: { z: 80*_R }, rWrist: { x: 35*_R, z: 18*_R }, head: { x: 10*_R, y: -8*_R } }, morphs: { think: 0.6 } },
    { t: 1,    bones: {}, morphs: {} }
  ]},
  shy: { label: '害羞摆手', duration: 1.8, loop: true, keyframes: [
    { t: 0,    bones: {}, morphs: { shy: 0.3 } },
    { t: 0.5,  bones: { lShoulder: { z: 18*_R }, rShoulder: { z: -18*_R }, lArm: { z: 35*_R }, rArm: { z: -35*_R }, lElbow: { z: 55*_R }, rElbow: { z: 55*_R }, lWrist: { x: 18*_R }, rWrist: { x: 18*_R }, head: { x: 14*_R } }, morphs: { shy: 0.6 } },
    { t: 1,    bones: {}, morphs: {} }
  ]},
  victory: { label: '胜利举臂', duration: 1.5, loop: true, keyframes: [
    { t: 0,    bones: {}, morphs: { happy: 0.3 } },
    { t: 0.4,  bones: { lShoulder: { z: 65*_R }, rShoulder: { z: -65*_R }, lArm: { z: 65*_R }, rArm: { z: -65*_R }, lElbow: { z: 12*_R }, rElbow: { z: 12*_R }, head: { x: -10*_R } }, morphs: { happy: 0.7 } },
    { t: 1,    bones: {}, morphs: {} }
  ]}
};

// 套用预设模板：用整套关键帧覆盖当前动作（作为编辑起点），并刷新编辑器与预览
function applyPoseTemplate(ae, key) {
  const tpl = POSE_TEMPLATES[key];
  if (!tpl) return;
  ae.def.duration = tpl.duration;
  ae.def.loop = !!tpl.loop;
  ae.def.keyframes = tpl.keyframes.map(k => ({
    t: k.t,
    bones: JSON.parse(JSON.stringify(k.bones || {})),
    root: JSON.parse(JSON.stringify(k.root || {})),
    morphs: JSON.parse(JSON.stringify(k.morphs || {}))
  }));
  ae.kfIndex = 0;
  renderKeyframeList(ae); renderKeyframeBody(ae); renderTimelineMarkers(ae);
  _syncPreviewDef(ae); _aeDirty = true;
  if (window.showToast) window.showToast('已套用预设：' + tpl.label + '（可继续微调）', '', 'success');
}

// 镜像当前关键帧的左右姿势到对侧（让"只摆了一侧"的姿势一键变对称，便于复杂姿势快速成型）
// 规则：lX→rX、rX→lX，z 轴取反（左右侧张开的相反符号），x/y 保持不变。
function mirrorKeyframeLR(ae) {
  const kf = ae.def.keyframes[ae.kfIndex];
  if (!kf) return;
  const bones = kf.bones || {};
  const out = Object.assign({}, bones);
  for (const key in bones) {
    let mKey = null;
    if (key.length > 1 && key[0] === 'l' && ACTION_BONES.some(b => b[0] === 'r' + key.slice(1))) mKey = 'r' + key.slice(1);
    else if (key.length > 1 && key[0] === 'r' && ACTION_BONES.some(b => b[0] === 'l' + key.slice(1))) mKey = 'l' + key.slice(1);
    if (mKey) {
      const v = bones[key];
      out[mKey] = { x: v.x || 0, y: v.y || 0, z: -(v.z || 0) };
    }
  }
  kf.bones = out;
  renderKeyframeBody(ae); renderKeyframeList(ae); _syncPreviewDef(ae); _aeDirty = true;
  if (window.showToast) window.showToast('已镜像左右', '', 'success');
}

let _ae = null; // 动作编辑器当前状态 { model, isNew, isBuiltin, key, data, def, kfIndex }
// 编辑器是否以独立窗口（index.html?mode=editor）运行
const IS_EDITOR_WINDOW = (typeof location !== 'undefined') && new URLSearchParams(location.search).get('mode') === 'editor';
let currentShownModel = null; // 主窗口当前展示的模型，用于编辑器保存后刷新
let _actionPreview = null;   // 嵌入式实时 3D 预览实例（MmdPreview）
let _previewPlaying = false;
let _previewU = 0;
let _previewBundleLoading = false;
let _bpIndex = -1;           // 当前被选中的断点（相关动作行高亮）
let _previewResizeObserver = null; // 预览容器尺寸监听，窗口缩放/最大化时同步 WebGL 缓冲
let _previewResizeBound = false;  // 是否已绑定 window resize → 预览重算（只绑一次，避免重复监听）
let _aeDirty = false;             // 编辑器是否有未保存的修改
let _previewResizeScheduled = false; // 帧级防抖：本帧是否已调度过预览重算（防止 rAF + ResizeObserver 双重触发）
// 预览专用「模型组件调整」模式：开启时画布拖拽/滚轮改为移动/缩放当前对象（而非旋转视角）
let _aeAdjustMode = false;
let _aeAdjustDrag = null;   // (dx, dy) => void
let _aeAdjustWheel = null;  // (deltaY) => void
let _aeAdjustClick = null;  // (clientX, clientY) => void  点击模型拾取部件

// 懒加载独立预览 bundle（IIFE 全局 MmdPreview），只加载一次
function ensurePreviewBundle() {
  if (window.MmdPreview) return Promise.resolve(true);
  if (_previewBundleLoading) return _previewBundleLoading;
  _previewBundleLoading = new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'js/mmdPreview.bundle.js';
    s.onload = () => resolve(!!window.MmdPreview);
    s.onerror = () => { _previewBundleLoading = false; resolve(false); };
    document.body.appendChild(s);
  });
  return _previewBundleLoading;
}

// 把当前 def 推给预览，参数改动时实时刷新姿态
function _syncPreviewDef(ae) {
  if (_actionPreview && _actionPreview.ready && ae && ae.def) {
    try { _actionPreview.setDef(ae.def); } catch (e) {}
  }
}

function   _destroyActionPreview() {
  if (_previewResizeObserver) { try { _previewResizeObserver.disconnect(); } catch (e) {} _previewResizeObserver = null; }
  if (_actionPreview) {
    try { _actionPreview.destroy(); } catch (e) {}
    _actionPreview = null;
  }
  window.__aePreview = null; // 清除当前生效的预览，pet.rotate/zoom/reset 不再指向已销毁的实例
  _previewPlaying = false;
  _previewU = 0;
}

// 动作编辑器 3D 预览：自由拖动旋转（环绕相机）+ 滚轮缩放，对应"可视化编辑"的拖拽需求
function wireActionPreviewOrbit(canvas, preview) {
  if (!canvas || !preview) return;
  let dragging = false, lastX = 0, lastY = 0, downX = 0, downY = 0, moved = 0;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    downX = e.clientX; downY = e.clientY; moved = 0;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    // 调整模型模式：按下即拾取光标下的关节（命中才选），随后拖动直接移动该关节——
    // 免去“先点选再拖”两步，让“拖关节”开箱即用（解决“拖动不管用”的困惑）
    if (_aeAdjustMode && typeof _aeAdjustClick === 'function') _aeAdjustClick(downX, downY);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    moved += Math.abs(dx) + Math.abs(dy);
    // 调整模型组件模式：拖拽改为移动/旋转当前对象（而非旋转视角）
    if (_aeAdjustMode && typeof _aeAdjustDrag === 'function') { _aeAdjustDrag(dx, dy); return; }
    const v = preview.getView();
    // 水平拖拽(yaw)取负：向右滑模型向右转（跟随手势），修正此前方向相反的问题
    preview.setView({ yaw: v.yaw - dx * 0.01, pitch: clamp(v.pitch + dy * 0.01, -1.2, 1.2) });
  });
  const end = () => {
    // 调整模式下，几乎未移动 = 视为点击 → 拾取模型部件（参考 Unity 点击选中）
    if (dragging && _aeAdjustMode && typeof _aeAdjustClick === 'function' && moved < 6) {
      _aeAdjustClick(downX, downY);
    }
    dragging = false;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', () => { dragging = false; });
  canvas.addEventListener('pointerleave', () => { dragging = false; });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    // 调整模型组件模式：滚轮改为缩放当前对象（而非缩放视角）
    if (_aeAdjustMode && typeof _aeAdjustWheel === 'function') { _aeAdjustWheel(e.deltaY); return; }
    const v = preview.getView();
    preview.setView({ zoom: clamp(v.zoom * (1 - e.deltaY * 0.001), 0.3, 3) });
  }, { passive: false });
}

// 在编辑器弹窗里初始化嵌入式实时 3D 预览（不依赖龙虾窗口）
// 主动触发预览重算：分隔条拖拽 / 侧栏折叠 / 窗口缩放后，保证 WebGL 缓冲与画布 CSS 尺寸同步
// （解决「调高时间条 / 折叠侧栏后，模型预览窗口大小不变」的问题——仅 ResizeObserver 偶尔滞后，这里主动补一次）
// 主动触发预览重算（分隔条拖拽 / 侧栏折叠 / 窗口缩放）：统一走 rAF + 帧级防抖，
// 保证同一帧内无论 window resize 事件还是 ResizeObserver 都只真正重算一次（避免 fitCamera 每帧被调两次导致模型跳变）
function schedulePreviewResize() {
  const canvas = document.getElementById('ae-preview-canvas');
  if (!canvas || !_actionPreview || _previewResizeScheduled) return;
  _previewResizeScheduled = true;
  requestAnimationFrame(() => {
    _previewResizeScheduled = false;
    if (_actionPreview && canvas.clientWidth && canvas.clientHeight) {
      try { _actionPreview.resize(canvas.clientWidth, canvas.clientHeight); } catch (_) {}
    }
  });
}

async function initActionPreview(ae) {
  const t = window.I18N?.t || ((k) => k);
  const canvas = document.getElementById('ae-preview-canvas');
  const statusEl = document.getElementById('ae-preview-status');
  if (!canvas) return;
  if (!ae.model || !ae.model.modelFile) { if (statusEl) statusEl.textContent = t('actions.mmdOnly'); return; }
  if (statusEl) statusEl.textContent = t('actions.previewLoading');

  const ok = await ensurePreviewBundle();
  if (!ok || !window.MmdPreview) { if (statusEl) statusEl.textContent = t('actions.previewFailed'); return; }
  _destroyActionPreview();
  try {
    _actionPreview = window.MmdPreview.createMmdPreview(canvas);
  } catch (e) {
    if (statusEl) statusEl.textContent = t('actions.previewFailed');
    return;
  }
  // 注册当前预览，供宠物控制面板的 pet.rotate/zoom/reset 驱动；并启用自由拖动旋转 / 滚轮缩放
  window.__aePreview = _actionPreview;
  wireActionPreviewOrbit(canvas, _actionPreview);

  const pmxUrl = 'live2d:///' + encodeURI((ae.model.modelFile || '').replace(/\\/g, '/'));
  let loaded = false;
  try { loaded = await _actionPreview.load(pmxUrl); } catch (e) { loaded = false; }
  if (!loaded) { if (statusEl) statusEl.textContent = t('actions.previewFailed'); return; }

  try { _actionPreview.setDef(ae.def); } catch (e) {}
  const w = canvas.clientWidth || 300, h = canvas.clientHeight || 320;
  try { _actionPreview.resize(w, h); } catch (e) {}
  if (statusEl) statusEl.textContent = '';

  // 监听预览容器尺寸变化（窗口最大化/缩放/分屏），实时同步 WebGL 缓冲，避免画面被 CSS 拉伸变形
  if (window.ResizeObserver) {
    if (_previewResizeObserver) { try { _previewResizeObserver.disconnect(); } catch (_) {} }
    _previewResizeObserver = new ResizeObserver(() => {
      // 统一走 schedulePreviewResize（帧级防抖），与 window 'resize' 共享，避免同帧重复 resize
      schedulePreviewResize();
    });
    _previewResizeObserver.observe(canvas);
  }
  // 已有的 window.dispatchEvent(new Event('resize'))（分隔条 / 折叠处调用）统一在此驱动预览重算，只绑一次
  if (!_previewResizeBound) {
    _previewResizeBound = true;
    window.addEventListener('resize', schedulePreviewResize);
  }

  const playBtn = document.getElementById('ae-play');
  const pauseBtn = document.getElementById('ae-pause');
  const ruler = document.getElementById('ae-timeline-ruler');

  // 初始化时间轴（刻度、关键帧标记、播放头、编辑竖线、断点）
  buildTimelineTicks();
  renderTimelineMarkers(_ae);
  updatePlayhead(_previewU || 0);
  updateEditLine(_previewU || 0);

  // 标尺点击/拖动 → 定位「编辑竖线」（选择位置、调试姿态），而非播放头
  if (ruler) {
    const scrub = (clientX) => {
      const rect = ruler.getBoundingClientRect();
      let u = (clientX - rect.left) / rect.width;
      u = Math.max(0, Math.min(1, u));
      seekPreview(u);
    };
    let dragging = false;
    ruler.addEventListener('pointerdown', (e) => {
      if (e.target.classList.contains('ae-kf-marker')) return; // 标记自行处理拖动
      if (e.target.classList.contains('ae-bp')) return;        // 断点自行处理拖动/选择
      dragging = true;
      try { ruler.setPointerCapture(e.pointerId); } catch (_) {}
      scrub(e.clientX);
    });
    ruler.addEventListener('pointermove', (e) => { if (dragging) scrub(e.clientX); });
    ruler.addEventListener('pointerup', (e) => { dragging = false; try { ruler.releasePointerCapture(e.pointerId); } catch (_) {} });

  }

  // 「编辑竖线」独立拖动（选择位置调试模型姿态）
  const editLine = document.getElementById('ae-editline');
  if (editLine && ruler) {
    let edragging = false;
    const moveEdit = (clientX) => {
      const rect = ruler.getBoundingClientRect();
      let u = (clientX - rect.left) / rect.width; u = Math.max(0, Math.min(1, u));
      seekPreview(u);
    };
    editLine.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      edragging = true;
      try { editLine.setPointerCapture(e.pointerId); } catch (_) {}
      moveEdit(e.clientX);
    });
    editLine.addEventListener('pointermove', (e) => { if (edragging) moveEdit(e.clientX); });
    editLine.addEventListener('pointerup', (e) => { edragging = false; try { editLine.releasePointerCapture(e.pointerId); } catch (_) {} });
  }

  if (playBtn) playBtn.addEventListener('click', () => {
    if (!_actionPreview) return;
    _previewPlaying = true;
    _actionPreview.play((u) => { _previewU = u; updatePlayhead(u); });
  });
  if (pauseBtn) pauseBtn.addEventListener('click', () => {
    if (!_actionPreview) return;
    _previewPlaying = false;
    _actionPreview.pause();
  });
}

// 时间轴：绘制刻度（每 0.1 一档，整 0.5 加粗）
function buildTimelineTicks() {
  const ticks = document.getElementById('ae-tl-ticks');
  if (!ticks) return;
  ticks.innerHTML = '';
  const N = 10;
  for (let i = 0; i <= N; i++) {
    const tick = document.createElement('div');
    tick.className = 'ae-tl-tick' + (i % 5 === 0 ? ' major' : '');
    tick.style.left = (i / N * 100) + '%';
    ticks.appendChild(tick);
  }
}

// 时间轴：根据当前 def.keyframes 渲染关键帧菱形标记
function renderTimelineMarkers(ae) {
  const ruler = document.getElementById('ae-timeline-ruler');
  if (!ruler || !ae) return;
  ruler.querySelectorAll('.ae-kf-marker').forEach(el => el.remove());
  (ae.def.keyframes || []).forEach((kf, i) => {
    const m = document.createElement('div');
    m.className = 'ae-kf-marker' + (i === ae.kfIndex ? ' active' : '');
    m.style.left = (clampNum(kf.t, 0, 1, 0) * 100) + '%';
    m.title = '关键帧 ' + (i + 1) + '/' + ae.def.keyframes.length + ' · t=' + (+kf.t).toFixed(2) + ' · ' + summarizeKeyframe(kf);
    m.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      ae.kfIndex = i;
      renderKeyframeList(ae); renderKeyframeBody(ae); renderTimelineMarkers(ae);
      seekPreview(kf.t);
      // renderTimelineMarkers 会重建标记元素，需重新取当前激活的标记传给拖拽逻辑
      const fresh = ruler.querySelectorAll('.ae-kf-marker')[ae.kfIndex];
      startMarkerDrag(ae, kf, fresh || m);
    });
    ruler.appendChild(m);
  });

  // 断点：渲染相关动作沿时间轴的触发节点
  const bpLayer = document.getElementById('ae-bp-layer');
  if (bpLayer) {
    bpLayer.innerHTML = '';
    const dur = (ae.def.duration || 2);
    (ae.def.related || []).forEach((r, i) => {
      if (typeof r.t !== 'number') return;
      const label = (BUILTIN_ACTIONS.find(a => a.key === r.key) || {}).label || (ae.data.actions[r.key] && ae.data.actions[r.key].label) || r.key;
      const bp = document.createElement('div');
      bp.className = 'ae-bp';
      bp.style.left = (clampNum(r.t, 0, 1, 0) * 100) + '%';
      bp.title = label + ' @ ' + (r.t * dur).toFixed(2) + 's';
      bp.dataset.relIndex = i;
      bp.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        selectBreakpoint(ae, i);
        startBpDrag(ae, r, bp);
      });
      bpLayer.appendChild(bp);
    });
  }
}

// 拖动关键帧标记 → 修改其 t（实时重排、重绘、刷新预览）
function startMarkerDrag(ae, kf, markerEl) {
  const ruler = document.getElementById('ae-timeline-ruler');
  if (!ruler) return;
  let moved = false;
  const move = (clientX) => {
    const rect = ruler.getBoundingClientRect();
    let u = (clientX - rect.left) / rect.width;
    u = Math.max(0, Math.min(1, u));
    kf.t = +u.toFixed(3);
    moved = true;
    ae.def.keyframes.sort((a, b) => a.t - b.t);
    ae.kfIndex = ae.def.keyframes.indexOf(kf);
    markerEl.style.left = (u * 100) + '%';
    markerEl.title = 't=' + (+kf.t).toFixed(2);
    _syncPreviewDef(ae);
    seekPreview(kf.t);
    const items = document.querySelectorAll('#ae-kf-list .ae-kf-item');
    if (items[ae.kfIndex]) items[ae.kfIndex].querySelector('.ae-kf-t').textContent = (+kf.t).toFixed(2);
    const tv = document.getElementById('ae-kf-t-val'); if (tv) tv.textContent = (+kf.t).toFixed(2);
    const timeInput = document.getElementById('ae-kf-time'); if (timeInput) timeInput.value = (+kf.t).toFixed(2);
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    if (moved) { renderKeyframeList(ae); renderKeyframeBody(ae); renderTimelineMarkers(ae); }
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

// 定位「编辑竖线」并刷新预览姿态（拖动标尺、拖动标记、拖动编辑竖线、点击断点共用）
function seekPreview(u) {
  _previewU = u;
  if (_actionPreview) { try { _actionPreview.pause(); } catch (_) {} try { _actionPreview.seek(u); } catch (_) {} }
  _previewPlaying = false;
  updateEditLine(u);
}

// 移动播放头 + 更新时间读数（u 为 0..1，真实秒数 = u * duration）
function updatePlayhead(u) {
  const playhead = document.getElementById('ae-playhead');
  if (playhead) playhead.style.left = (clampNum(u, 0, 1, 0) * 100) + '%';
  const ro = document.getElementById('ae-time-readout');
  if (ro && _ae && _ae.def) {
    const dur = (_ae.def.duration || 2);
    ro.textContent = (u * dur).toFixed(2) + 's / ' + dur.toFixed(2) + 's';
  }
}

// 移动「编辑/选择竖线」（青色，用于定位与调试姿态）
function updateEditLine(u) {
  const el = document.getElementById('ae-editline');
  if (el) el.style.left = (clampNum(u, 0, 1, 0) * 100) + '%';
}

// 点击断点：定位编辑竖线（调试该姿态）+ 高亮对应相关动作行
function selectBreakpoint(ae, i) {
  const r = (ae.def.related || [])[i];
  if (!r) return;
  _bpIndex = i;
  seekPreview(r.t);
  const rows = document.querySelectorAll('#ae-related-list .ae-related-row');
  rows.forEach((row, idx) => row.classList.toggle('ae-rel-active', idx === i));
  const active = rows[i];
  if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
}

// 拖动断点节点：沿时间轴改变其触发时间点 t
function startBpDrag(ae, r, bp) {
  const ruler = document.getElementById('ae-timeline-ruler');
  if (!ruler) return;
  bp.classList.add('dragging');
  let moved = false;
  const move = (clientX) => {
    const rect = ruler.getBoundingClientRect();
    let u = (clientX - rect.left) / rect.width; u = Math.max(0, Math.min(1, u));
    r.t = +u.toFixed(3); moved = true;
    bp.style.left = (u * 100) + '%';
    const dur = (ae.def.duration || 2);
    const label = (BUILTIN_ACTIONS.find(a => a.key === r.key) || {}).label || (ae.data.actions[r.key] && ae.data.actions[r.key].label) || r.key;
    bp.title = label + ' @ ' + (r.t * dur).toFixed(2) + 's';
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    bp.classList.remove('dragging');
    if (moved) { renderRelatedList(ae); renderTimelineMarkers(ae); }
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

function degToRad(d) { return (d || 0) * Math.PI / 180; }
function radToDeg(r) { return (r || 0) * 180 / Math.PI; }
function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
function clampNum(v, lo, hi, def) { const n = num(v); if (!isFinite(n)) return def; return Math.max(lo, Math.min(hi, n)); }
function normalizeBoneKey(raw) {
  if (!raw) return null;
  if (ACTION_BONES.some(b => b[0] === raw)) return raw;
  const a = BONE_ALIAS[raw] || BONE_ALIAS[raw.toLowerCase()];
  if (a) return a;
  const b = BODY_PART_TO_BONE[raw] || BODY_PART_TO_BONE[raw.toLowerCase()];
  if (b) return b;
  return null;
}
function normalizeKeyframe(kf) {
  const out = { t: clampNum(kf.t, 0, 1, 0), bones: {}, root: {}, morphs: {} };
  if (kf.bones && typeof kf.bones === 'object') {
    for (const raw in kf.bones) {
      const bk = normalizeBoneKey(raw);
      if (!bk) continue;
      const v = kf.bones[raw] || {};
      out.bones[bk] = { x: num(v.x), y: num(v.y), z: num(v.z) };
    }
  }
  if (kf.root) {
    out.root = { y: num(kf.root.y), rotY: num(kf.root.rotY), rotX: num(kf.root.rotX), rotZ: num(kf.root.rotZ) };
  }
  if (kf.morphs && typeof kf.morphs === 'object') {
    for (const m in kf.morphs) {
      const w = num(kf.morphs[m]);
      if (w <= 0) continue;
      let mk = null;
      if (ACTION_MORPHS.some(x => x[0] === m)) mk = m;
      else mk = MORPH_ALIAS[m] || MORPH_ALIAS[m.toLowerCase()] || null;
      if (mk) out.morphs[mk] = w;
    }
  }
  return out;
}
function generateActionKey(data, label) {
  let base = 'act_' + (label || 'action').trim().replace(/[^\w一-龥]/g, '_').slice(0, 24);
  if (!base || base === 'act_') base = 'act_' + Date.now().toString(36);
  let key = base, i = 2;
  while (data.actions && data.actions[key]) { key = base + '_' + i; i++; }
  return key;
}
async function persistActions(model, data) {
  const r = await window.api.saveActions(model.id, data);
  if (r && r.success) {
    try { await window.api.setActionsInPet(data); } catch (e) { /* 龙虾未开时忽略，载入时仍生效 */ }
  }
  return r;
}

// 按内置动作类型生成「自然起手式」关键帧种子（BONE_KEYS 与 mmdPet 一致：
// head/upperBody/lowerBody/lArm/rArm/lLeg/rLeg 等；关键帧间已 easeInOut 缓动，无需手写插值）
function buildSeedKeyframes(builtinKey) {
  if (builtinKey === 'dance') {
    // 自然舞动：左右摆臂 + 髋/躯干随动 + 头部微摆 + 抬腿点地，幅度克制不扭曲
    return {
      duration: 2.4, loop: true,
      keyframes: [
        { t: 0,    bones: { lArm: { z: -0.2 }, rArm: { z: 0.2 }, upperBody: { z: 0 }, lowerBody: { x: 0 }, head: { z: 0 }, lLeg: { x: 0 }, rLeg: { x: 0 } }, root: {}, morphs: {} },
        { t: 0.25, bones: { lArm: { z: -0.8, y: 0.2 }, rArm: { z: 0.4, y: -0.2 }, upperBody: { z: 0.2 }, lowerBody: { x: -0.12 }, head: { z: 0.12 }, lLeg: { x: -0.15 }, rLeg: { x: 0 } }, root: {}, morphs: {} },
        { t: 0.5,  bones: { lArm: { z: 0.4, y: -0.2 }, rArm: { z: -0.8, y: 0.2 }, upperBody: { z: -0.2 }, lowerBody: { x: 0.12 }, head: { z: -0.12 }, lLeg: { x: 0 }, rLeg: { x: -0.15 } }, root: {}, morphs: {} },
        { t: 0.75, bones: { lArm: { z: -1.0 }, rArm: { z: 1.0 }, upperBody: { z: 0 }, lowerBody: { x: 0 }, head: { z: 0 }, lLeg: { x: 0 }, rLeg: { x: 0 } }, root: {}, morphs: {} },
        { t: 1,    bones: { lArm: { z: -0.2 }, rArm: { z: 0.2 }, upperBody: { z: 0 }, lowerBody: { x: 0 }, head: { z: 0 }, lLeg: { x: 0 }, rLeg: { x: 0 } }, root: {}, morphs: {} }
      ]
    };
  }
  // 其它内置动作：中性站姿 + 轻微呼吸/起伏，作为可编辑基线（避免从空白起步）
  return {
    duration: 2, loop: true,
    keyframes: [
      { t: 0,   bones: { upperBody: { z: 0 }, head: { z: 0 }, lArm: { z: 0 }, rArm: { z: 0 } }, root: {}, morphs: {} },
      { t: 0.5, bones: { upperBody: { z: 0.08 }, head: { z: 0.04 }, lArm: { z: -0.1 }, rArm: { z: 0.1 } }, root: {}, morphs: {} },
      { t: 1,   bones: { upperBody: { z: 0 }, head: { z: 0 }, lArm: { z: 0 }, rArm: { z: 0 } }, root: {}, morphs: {} }
    ]
  };
}

// 内置动作 → 可编辑自定义动作：派生副本并写入关键帧种子，重新以「非内置」方式打开，便于 AI / 代码优化
async function deriveBuiltinToEditable(ae) {
  if (!ae.isBuiltin) return;
  const t = window.I18N?.t || ((k) => k);
  const baseLabel = (ae.def.label || '动作');
  const newLabel = baseLabel + '·可编辑';
  const newKey = generateActionKey(ae.data, newLabel);
  const seed = buildSeedKeyframes(ae.key);
  ae.data.actions[newKey] = {
    key: newKey, label: newLabel, duration: seed.duration, loop: seed.loop, speed: 1,
    keyframes: seed.keyframes, related: []
  };
  const r = await persistActions(ae.model, ae.data);
  if (!r || !r.success) { showToast(t('actions.deriveFailed') || '复制失败', '', 'error'); return; }
  showToast(t('actions.deriveOk') || '已生成可编辑副本', newLabel, 'success');
  // 重新以非内置方式打开副本（动作编辑器左侧即出现关键帧编辑 + 代码/AI 面板操作的是这个新副本）
  window.api.editor.open({ modelId: ae.model.id, actionKey: newKey, isNew: false, isBuiltin: false });
}

async function loadModelActionsSection(model) {
  const t = window.I18N?.t || ((k) => k);
  const wrap = document.getElementById('model-actions-section');
  if (!wrap) return;
  let data = { idle: null, actions: {} };
  try {
    const res = await window.api.getActions(model.id);
    if (res && res.success && res.data) data = res.data;
  } catch (e) { /* 忽略，回退空配置 */ }
  renderActionsSection(model, data);
}

function renderActionsSection(model, data) {
  const t = window.I18N?.t || ((k) => k);
  const wrap = document.getElementById('model-actions-section');
  if (!wrap) return;
  data.actions = data.actions || {};
  data.deletedBuiltins = Array.isArray(data.deletedBuiltins) ? data.deletedBuiltins : [];
  const deletedBuiltinSet = new Set(data.deletedBuiltins);

  // 自定义列表排除内置动作键（内置动作的 related/idle 覆盖也存于 data.actions，但属于覆盖而非自定义动作）
  const customKeys = Object.keys(data.actions).filter(k => !BUILTIN_ACTIONS.some(a => a.key === k));

  // 默认(内置)动作：支持删除（除导入模型自带的原生动作外——模型自带动作不在本列表、不受影响）。
  // 被删除的内置动作进入"已隐藏"区，可一键恢复；同时会从待机组合候选中移除。
  const visibleBuiltins = BUILTIN_ACTIONS.filter(a => !deletedBuiltinSet.has(a.key));
  const hiddenBuiltins = BUILTIN_ACTIONS.filter(a => deletedBuiltinSet.has(a.key));
  const builtinRows = visibleBuiltins.map(a => `
    <div class="action-row">
      <span class="action-name">${a.label}</span>
      <span class="action-tags"></span>
      <span class="action-btns">
        <button class="btn btn-sm" data-edit="${a.key}" data-builtin="1">${t('actions.edit')}</button>
        <button class="btn btn-sm btn-danger" data-del-builtin="${a.key}">${t('actions.delete')}</button>
      </span>
    </div>`).join('');
  const hiddenBuiltinRows = hiddenBuiltins.length ? hiddenBuiltins.map(a => `
    <div class="action-row action-row-hidden">
      <span class="action-name">${a.label}</span>
      <span class="action-tags"><span class="tag">已隐藏</span></span>
      <span class="action-btns">
        <button class="btn btn-sm" data-restore-builtin="${a.key}">${t('actions.restore') || '恢复'}</button>
      </span>
    </div>`).join('') : '';

  const customRows = customKeys.length ? customKeys.map(k => `
    <div class="action-row">
      <span class="action-name">${escapeHtml(data.actions[k].label || k)}</span>
      <span class="action-tags">${data.actions[k].loop ? `<span class="tag">循环</span>` : ''}</span>
      <span class="action-btns">
        <button class="btn btn-sm" data-edit="${k}">${t('actions.edit')}</button>
        <button class="btn btn-sm btn-danger" data-del="${k}">${t('actions.delete')}</button>
      </span>
    </div>`).join('') : `<div class="ae-note">${t('actions.noCustom')}</div>`;

  wrap.innerHTML = `
    <div class="detail-row"><span class="label">${t('actions.title')}</span></div>
    <div class="action-idle-combo">
      <div class="action-idle-row">
        <label>${t('actions.idleCombo')} <span class="ae-hint">${t('actions.idleComboHint')}</span></label>
      </div>
      <div class="ae-combo-pool" id="ae-combo-pool"></div>
      <div class="ae-combo-seq" id="ae-combo-seq"></div>
      <div class="ae-combo-empty" id="ae-combo-empty">${t('actions.idleComboEmpty')}</div>
      <button class="btn btn-sm" id="ae-combo-clear">${t('actions.idleComboClear')}</button>
    </div>
    <div class="action-group-title">${t('actions.builtin')} <span class="ae-hint">${t('actions.builtinHint') || '导入模型自带动作不受影响'}</span></div>
    <div class="action-list">${builtinRows}</div>
    ${hiddenBuiltinRows ? `<div class="action-group-title action-group-title-sub">${t('actions.hiddenBuiltin') || '已隐藏的默认动作'}</div><div class="action-list">${hiddenBuiltinRows}</div>` : ''}
    <div class="action-group-title">${t('actions.custom')}</div>
    <div class="action-list">${customRows}</div>
    <button class="btn btn-sm btn-primary" id="btn-new-action">+ ${t('actions.new')}</button>
  `;

  wrap.querySelectorAll('[data-edit]').forEach(btn => btn.addEventListener('click', () => {
    window.api.editor.open({ modelId: model.id, actionKey: btn.dataset.edit, isNew: false, isBuiltin: btn.dataset.builtin === '1' });
  }));

  wrap.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', async () => {
    const confirmed = await showConfirm({ type: 'warning', title: t('models.delete'), message: t('actions.deleteConfirm') });
    if (!confirmed) return;
    delete data.actions[btn.dataset.del];
    const r = await persistActions(model, data);
    if (r && r.success) { showToast(t('actions.delete'), '', 'success'); renderActionsSection(model, data); }
  }));

  // 删除默认(内置)动作：记录到 data.deletedBuiltins（按模型隔离，不影响其他模型），
  // 并自动从待机组合候选中移除；导入模型自带的原生动作不在本列表，不受影响。
  wrap.querySelectorAll('[data-del-builtin]').forEach(btn => btn.addEventListener('click', async () => {
    const k = btn.dataset.delBuiltin;
    const confirmed = await showConfirm({
      type: 'warning',
      title: t('actions.delete'),
      message: t('actions.deleteBuiltinConfirm') || '确定要隐藏该默认动作吗？隐藏后将从动作列表与待机组合中移除，可随时恢复。'
    });
    if (!confirmed) return;
    if (!data.deletedBuiltins.includes(k)) data.deletedBuiltins.push(k);
    const r = await persistActions(model, data);
    if (r && r.success) { showToast(t('actions.delete'), '', 'success'); renderActionsSection(model, data); }
  }));

  // 恢复已隐藏的默认动作
  wrap.querySelectorAll('[data-restore-builtin]').forEach(btn => btn.addEventListener('click', async () => {
    const k = btn.dataset.restoreBuiltin;
    data.deletedBuiltins = data.deletedBuiltins.filter(x => x !== k);
    const r = await persistActions(model, data);
    if (r && r.success) { showToast(t('actions.restore') || '已恢复', '', 'success'); renderActionsSection(model, data); }
  }));

  // ===== 待机组合动作（有序多选，待机时循环播放）=====
  const COMBO_BASIC = [
    { key: 'tap', label: '轻点' }, { key: 'flick', label: '甩动' },
    { key: 'flickup', label: '上扬' }, { key: 'happy', label: '开心' }, { key: 'greet', label: '问候' }
  ];
  const comboLabelMap = { idle: t('actions.idleComboSway') };
  COMBO_BASIC.forEach(a => { comboLabelMap[a.key] = a.label; });
  BUILTIN_ACTIONS.forEach(a => { comboLabelMap[a.key] = a.label; });
  Object.keys(data.actions).forEach(k => { if (!comboLabelMap[k]) comboLabelMap[k] = data.actions[k].label || k; });
  data.idleCombo = Array.isArray(data.idleCombo) ? data.idleCombo.slice() : [];

  const poolEl = document.getElementById('ae-combo-pool');
  const seqEl = document.getElementById('ae-combo-seq');
  const emptyEl = document.getElementById('ae-combo-empty');

  const renderComboPool = () => {
    const delSet = new Set(data.deletedBuiltins || []);
    const poolKeys = ['idle'].concat(COMBO_BASIC.map(a => a.key), BUILTIN_ACTIONS.filter(a => !delSet.has(a.key)).map(a => a.key), Object.keys(data.actions));
    poolEl.innerHTML = poolKeys.map(k =>
      `<button type="button" class="ae-combo-chip${data.idleCombo.includes(k) ? ' active' : ''}" data-combo-key="${k}">${escapeHtml(comboLabelMap[k] || k)}</button>`
    ).join('');
  };
  const renderComboSeq = () => {
    if (!data.idleCombo.length) { seqEl.innerHTML = ''; emptyEl.style.display = ''; return; }
    emptyEl.style.display = 'none';
    seqEl.innerHTML = data.idleCombo.map((k, i) => `
      <span class="ae-combo-step">
        <span class="ae-combo-step-idx">${i + 1}</span>
        <span class="ae-combo-step-name">${escapeHtml(comboLabelMap[k] || k)}</span>
        <button type="button" class="ae-combo-step-btn" data-combo-move-idx="${i}" data-dir="-1" title="${t('actions.idleComboMoveLeft')}">◀</button>
        <button type="button" class="ae-combo-step-btn" data-combo-move-idx="${i}" data-dir="1" title="${t('actions.idleComboMoveRight')}">▶</button>
        <button type="button" class="ae-combo-step-btn ae-combo-step-del" data-combo-remove-idx="${i}" title="${t('actions.idleComboRemove')}">✕</button>
      </span>`).join('');
  };
  const persistCombo = async () => {
    const r = await persistActions(model, data);
    if (r && r.success) showToast(t('actions.idleComboUpdated'), '', 'success');
  };
  const toggleComboKey = async (k) => {
    const idx = data.idleCombo.indexOf(k);
    if (idx >= 0) data.idleCombo.splice(idx, 1);
    else data.idleCombo.push(k);
    renderComboPool();
    renderComboSeq();
    await persistCombo();
  };

  renderComboPool();
  renderComboSeq();

  poolEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-combo-key]');
    if (!btn) return;
    await toggleComboKey(btn.dataset.comboKey);
  });
  seqEl.addEventListener('click', async (e) => {
    const moveBtn = e.target.closest('[data-combo-move-idx]');
    if (moveBtn) {
      const i = parseInt(moveBtn.dataset.comboMoveIdx, 10);
      const dir = parseInt(moveBtn.dataset.dir, 10) || 0;
      const ni = i + dir;
      if (ni >= 0 && ni < data.idleCombo.length) {
        const arr = data.idleCombo;
        const tmp = arr[i]; arr[i] = arr[ni]; arr[ni] = tmp;
        renderComboPool();
        renderComboSeq();
        await persistCombo();
      }
      return;
    }
    const delBtn = e.target.closest('[data-combo-remove-idx]');
    if (delBtn) {
      const i = parseInt(delBtn.dataset.comboRemoveIdx, 10);
      if (i >= 0 && i < data.idleCombo.length) {
        data.idleCombo.splice(i, 1);
        renderComboPool();
        renderComboSeq();
        await persistCombo();
      }
    }
  });
  document.getElementById('ae-combo-clear').addEventListener('click', async () => {
    data.idleCombo = [];
    renderComboPool();
    renderComboSeq();
    await persistCombo();
  });

  document.getElementById('btn-new-action').addEventListener('click', () => window.api.editor.open({ modelId: model.id, actionKey: '', isNew: true, isBuiltin: false }));
}

async function openActionEditor(model, actionKey, isNew, isBuiltin, opts = {}) {
  const t = window.I18N?.t || ((k) => k);
  let res;
  try { res = await window.api.getActions(model.id); } catch (e) { res = null; }
  const data = (res && res.success && res.data) ? res.data : { idle: null, actions: {} };
  data.actions = data.actions || {};

  let def;
  if (isNew) {
    def = { key: '', label: '', duration: 2, loop: false, speed: 1,
      keyframes: [ { t: 0, bones: {}, root: {}, morphs: {} }, { t: 1, bones: {}, root: {}, morphs: {} } ],
      related: [] };
  } else {
    const src = data.actions[actionKey] || { key: actionKey, label: actionKey, duration: 2, loop: false, speed: 1, related: [] };
    def = JSON.parse(JSON.stringify(src));
    def.key = actionKey;
    def.keyframes = Array.isArray(def.keyframes) ? def.keyframes : (isBuiltin ? null : []);
    if (!Array.isArray(def.related)) def.related = [];
    if (typeof def.speed !== 'number' || def.speed <= 0) def.speed = 1;
  }

  _ae = { model, isNew, isBuiltin: !!isBuiltin, key: isNew ? null : actionKey, data, def, kfIndex: 0 };
  _aeDirty = false; // 打开编辑器时重置脏标记

  const standalone = IS_EDITOR_WINDOW || opts.standalone;
  if (standalone) {
    const root = document.getElementById('action-editor-root');
    if (root) {
      root.innerHTML = buildActionEditorBody(_ae, t);
      root.classList.add('show');
      const center = document.getElementById('titlebar-center');
      if (center) center.innerHTML = `<span class="editor-title">${(isNew ? t('actions.editorTitleNew') : t('actions.editorTitle')) + (def.label ? ' · ' + escapeHtml(def.label) : '')}</span>`;
      document.title = (isNew ? t('actions.editorTitleNew') : t('actions.editorTitle')) + (def.label ? ' · ' + def.label : '');
    }
    wireActionEditor(_ae);
    if (!isBuiltin) { renderKeyframeList(_ae); renderKeyframeBody(_ae); }
    renderRelatedList(_ae);
    initActionPreview(_ae);
    if (root) wrapNumberSteppers(root);
  } else {
    showModal({
      title: isNew ? t('actions.editorTitleNew') : t('actions.editorTitle'),
      body: buildActionEditorBody(_ae, t),
      footer: ''
    });
    const modalEl = document.getElementById('modal');
    if (modalEl) modalEl.classList.add('ae-modal');
    wireActionEditor(_ae);
    if (!isBuiltin) { renderKeyframeList(_ae); renderKeyframeBody(_ae); }
    renderRelatedList(_ae);
    initActionPreview(_ae);
    wrapNumberSteppers(document.getElementById('modal'));
  }
}

// 预览框左上角悬浮控件：复位视角 + 色彩设置（含饱和度/亮度/色相滑块）
function aePreviewOverlay(t) {
  // 预览专用「模型组件调整」：选中身体部件以「位移」方式移动关节（拖拽 → 关节随手势平移，
  // 下游子骨骼刚性跟随；整体模型仍可位移/缩放/旋转取景），绝不做缩放以免骨骼粗细/大小被拉伸扭曲；
  // 仅作用于预览，永不写入关键帧
  const AE_ADJUST_PARTS = [
    ['head', 'actions.adjustHead'], ['neck', 'actions.adjustNeck'],
    ['upperBody', 'actions.adjustUpper'], ['lowerBody', 'actions.adjustLower'],
    ['lArm', 'actions.adjustLArm'], ['rArm', 'actions.adjustRArm'],
    ['lWrist', 'actions.adjustLWrist'], ['rWrist', 'actions.adjustRWrist'],
    ['lLeg', 'actions.adjustLLeg'], ['rLeg', 'actions.adjustRLeg']
  ];
  const partOpts = AE_ADJUST_PARTS.map(([k, lk]) => `<option value="${k}">${t(lk)}</option>`).join('');
  return `<div class="ae-preview-overlay">
      <button class="ae-ov-btn" id="ae-reset-view" title="${t('actions.resetView') || '复位视角'}">${window.ElIcons.getIcon('refresh')}</button>
      <button class="ae-ov-btn" id="ae-color-btn" title="${t('color.settings') || '色彩设置'}">${window.ElIcons.getIcon('palette')}</button>
      <button class="ae-ov-btn" id="ae-adjust-btn" title="${t('actions.adjustTip') || '调整模型：开启后点击部件选中、拖拽变换、滚轮缩放'}">${window.ElIcons.getIcon('edit')}</button>
      <div class="ae-color-pop" id="ae-color-pop">
        <div class="ae-color-row"><label>${t('color.saturation') || '饱和度'}</label><input type="range" id="ae-col-sat" min="0.3" max="2.5" step="0.01"><span class="ae-col-val" id="ae-col-sat-v"></span></div>
        <div class="ae-color-row"><label>${t('color.brightness') || '亮度'}</label><input type="range" id="ae-col-bri" min="0.5" max="1.8" step="0.01"><span class="ae-col-val" id="ae-col-bri-v"></span></div>
        <div class="ae-color-row"><label>${t('color.hue') || '色相'}</label><input type="range" id="ae-col-hue" min="-180" max="180" step="1"><span class="ae-col-val" id="ae-col-hue-v"></span></div>
        <button class="btn btn-sm" id="ae-col-reset">${t('color.reset') || '恢复默认'}</button>
      </div>
    </div>
    <div class="ae-adjust-bar" id="ae-adjust-bar">
      <div class="ae-adj-modes">
        <button class="ae-adj-mode active" data-mode="move">${t('actions.adjustMove') || '移动'}</button>
      </div>
      <div class="ae-adj-target-row">
        <select id="ae-adj-target" class="ae-adj-select" title="${t('actions.adjustTarget') || '调整对象'}">
          <option value="">${t('actions.adjustWhole') || '整体模型'}</option>
          ${partOpts}
        </select>
      </div>
      <button class="btn btn-sm ae-adj-reset" id="ae-adj-reset">${t('actions.adjustReset') || '重置'}</button>
      <div class="ae-adj-note">${t('actions.adjustNote') || '点击模型选中部件 · 拖拽移动关节位置（仅预览，不影响保存）'}</div>
    </div>`;
}

function buildActionEditorBody(ae, t) {
  const def = ae.def;
  let html = `<div class="action-editor">`;

  // 顶部工具栏：保存（图标）+ 预览到宠物（非内置）
  html += `<div class="ae-toolbar">
      ${!ae.isBuiltin ? `<button class="btn" id="ae-preview">${t('actions.previewInPet')}</button>` : ''}
      <button class="btn btn-primary ae-icon-btn" id="ae-save" title="${t('actions.saveName')}">${window.ElIcons.getIcon('save')}</button>
    </div>`;

  if (ae.isBuiltin) {
    // 内置动作：关键帧为系统预设（不可编辑），但仍提供预览 + 时间轴以便观看；属性/相关可改
    html += `<div class="ae-grid">
      <aside class="ae-side ae-side-left" id="ae-side-left">
        <div class="ae-side-body ae-col-left">
          <div class="ae-section">
            <div class="ae-subhead ae-sec-head" data-collapse>内置动作（预览）<span class="ae-sec-caret">▾</span></div>
            <div class="ae-section-body">
              <div class="ae-note">${t('actions.builtinNote')}</div>
              <button class="btn btn-sm btn-primary" id="ae-derive" style="margin-top:8px">复制为可编辑动作</button>
              <div class="ae-note" style="margin-top:6px">复制后生成一份可编辑副本（内置「跳舞」会带自然舞动起手式），可在此基础上让 AI / 代码优化。</div>
            </div>
          </div>
          <div class="ae-section">
            <div class="ae-subhead ae-sec-head" data-collapse>${t('actions.petDisplay')}<span class="ae-sec-caret">▾</span></div>
            <div class="ae-section-body">
              <div class="ae-visual-panel" id="ae-visual-panel"></div>
            </div>
          </div>
        </div>
      </aside>
      <section class="ae-col ae-col-center">
        <div class="ae-stage">
          <div class="ae-subhead">${t('actions.previewTitle')}</div>
          <div class="ae-preview-canvas-wrap">
            <canvas id="ae-preview-canvas" data-tip="${t('actions.previewHint')}"></canvas>
            <div class="ae-preview-status" id="ae-preview-status">${t('actions.previewLoading')}</div>
            ${aePreviewOverlay(t)}
          </div>
        </div>
      </section>
      <aside class="ae-side ae-side-right" id="ae-side-right">
        <div class="ae-side-body ae-col-right">
          <div class="ae-section">
            <div class="ae-subhead ae-sec-head" data-collapse>${t('actions.properties')}<span class="ae-sec-caret">▾</span></div>
            <div class="ae-section-body">
              <div class="ae-prop">
                <div class="ae-field"><label>${t('actions.name')}</label><input type="text" id="ae-label" value="${escapeHtml(def.label || '')}" maxlength="30" placeholder="如：挥手打招呼"></div>
                <div class="ae-field"><label>${t('actions.duration')}</label><input type="number" id="ae-duration" min="0.2" max="30" step="0.1" value="${def.duration != null ? def.duration : 2}"></div>
                <div class="ae-field"><label>${t('actions.speed')}</label><input type="number" id="ae-speed" min="0.1" max="3" step="0.05" value="${def.speed != null ? def.speed : 1}"></div>
                <label class="ae-check"><input type="checkbox" id="ae-loop" ${def.loop ? 'checked' : ''}> ${t('actions.loop')}</label>
              </div>
            </div>
          </div>
          <div class="ae-section">
            <div class="ae-subhead ae-sec-head" data-collapse>${t('actions.related')}<span class="ae-sec-caret">▾</span></div>
            <div class="ae-section-body">
              <div class="ae-related-list" id="ae-related-list"></div>
            </div>
          </div>
        </div>
      </aside>
    </div>`;
  } else {
    // 三栏布局：左=关键帧编辑器 + 代码/AI 面板，中=预览(顶)，右=属性(名称/时长/速率/循环)+相关
    html += `<div class="ae-grid">
      <aside class="ae-side ae-side-left" id="ae-side-left">
        <div class="ae-side-body ae-col-left">
          <div class="ae-section">
            <div class="ae-subhead ae-sec-head" data-collapse>预设姿势 <span class="ae-sec-caret">▾</span></div>
            <div class="ae-section-body">
              <div class="ae-template-list">
                ${Object.keys(POSE_TEMPLATES).map(k => `<button class="btn btn-sm ae-template-btn" data-template="${k}">${POSE_TEMPLATES[k].label}</button>`).join('')}
              </div>
              <div class="ae-note">点击套用整套关键帧（覆盖当前帧，作为复杂动作的编辑起点）</div>
            </div>
          </div>
          <div class="ae-section">
            <div class="ae-subhead ae-sec-head" data-collapse>${t('actions.keyframes')} <button class="btn btn-sm" id="ae-add-kf">+ ${t('actions.addKeyframe')}</button><span class="ae-sec-caret">▾</span></div>
            <div class="ae-section-body">
              <div class="ae-kf-list" id="ae-kf-list"></div>
            </div>
          </div>
          <div class="ae-section">
            <div class="ae-subhead ae-sec-head" data-collapse>${t('actions.keyframeEdit')}: <span id="ae-kf-t-val"></span><span class="ae-sec-caret">▾</span></div>
            <div class="ae-section-body">
              <div class="ae-kf-body" id="ae-kf-body"></div>
            </div>
          </div>
          <div class="ae-section">
            <div class="ae-subhead ae-sec-head" data-collapse>${t('actions.petDisplay')}<span class="ae-sec-caret">▾</span></div>
            <div class="ae-section-body">
              <div class="ae-visual-panel" id="ae-visual-panel"></div>
            </div>
          </div>
        </div>
      </aside>

      <section class="ae-col ae-col-center">
        <div class="ae-stage">
          <div class="ae-subhead">${t('actions.previewTitle')}</div>
          <div class="ae-preview-canvas-wrap">
            <canvas id="ae-preview-canvas" data-tip="${t('actions.previewHint')}"></canvas>
            <div class="ae-preview-status" id="ae-preview-status">${t('actions.previewLoading')}</div>
            ${aePreviewOverlay(t)}
          </div>
        </div>
      </section>

      <aside class="ae-side ae-side-right" id="ae-side-right">
        <div class="ae-side-body ae-col-right">
          <div class="ae-section">
            <div class="ae-subhead ae-sec-head" data-collapse>${t('actions.properties')}<span class="ae-sec-caret">▾</span></div>
            <div class="ae-section-body">
              <div class="ae-prop">
                <div class="ae-field"><label>${t('actions.name')}</label><input type="text" id="ae-label" value="${escapeHtml(def.label || '')}" maxlength="30" placeholder="如：挥手打招呼"></div>
                <div class="ae-field"><label>${t('actions.duration')}</label><input type="number" id="ae-duration" min="0.2" max="30" step="0.1" value="${def.duration != null ? def.duration : 2}"></div>
                <div class="ae-field"><label>${t('actions.speed')}</label><input type="number" id="ae-speed" min="0.1" max="3" step="0.05" value="${def.speed != null ? def.speed : 1}"></div>
                <label class="ae-check"><input type="checkbox" id="ae-loop" ${def.loop ? 'checked' : ''}> ${t('actions.loop')}</label>
              </div>
            </div>
          </div>
          <div class="ae-section">
            <div class="ae-subhead ae-sec-head" data-collapse>${t('actions.related')}<span class="ae-sec-caret">▾</span></div>
            <div class="ae-section-body">
              <div class="ae-related-list" id="ae-related-list"></div>
            </div>
          </div>
        </div>
      </aside>
    </div>`;
  }

  // 时间条：独立于三栏布局，铺满整行（全宽），紧贴预览框下方
  html += `<div class="ae-timeline" data-tip="${t('actions.timelineHint')}">
    <div class="ae-tl-controls">
      <button class="btn btn-sm" id="ae-play">${window.ElIcons.getIcon('play')} ${t('actions.previewPlay')}</button>
      <button class="btn btn-sm" id="ae-pause">${window.ElIcons.getIcon('pause')} ${t('actions.previewPause')}</button>
      <span class="ae-tl-time" id="ae-time-readout">0.00s / 0.00s</span>
    </div>
    <div class="ae-tl-ruler" id="ae-timeline-ruler">
      <div class="ae-tl-ticks" id="ae-tl-ticks"></div>
      <div class="ae-editline" id="ae-editline"></div>
      <div class="ae-bp-layer" id="ae-bp-layer"></div>
      <div class="ae-playhead" id="ae-playhead"></div>
    </div>
  </div>`;

  html += `</div>`;
  return html;
}

function wireActionEditor(ae) {
  const def = ae.def;
  const labelEl = document.getElementById('ae-label');
  if (labelEl) labelEl.addEventListener('input', () => { def.label = labelEl.value; _aeDirty = true; });
  const durEl = document.getElementById('ae-duration');
  if (durEl) durEl.addEventListener('input', () => { const v = parseFloat(durEl.value); def.duration = isFinite(v) ? v : 2; _syncPreviewDef(ae); _aeDirty = true; });
  const loopEl = document.getElementById('ae-loop');
  if (loopEl) loopEl.addEventListener('change', () => { def.loop = loopEl.checked; _aeDirty = true; });
  const speedEl = document.getElementById('ae-speed');
  if (speedEl) speedEl.addEventListener('input', () => { const v = parseFloat(speedEl.value); def.speed = (isFinite(v) && v > 0) ? v : 1; _aeDirty = true; });

  if (!ae.isBuiltin) {
    const addBtn = document.getElementById('ae-add-kf');
    if (addBtn) addBtn.addEventListener('click', () => {
      const kfs = def.keyframes;
      const lastT = kfs.length ? kfs[kfs.length - 1].t : 0;
      const nt = Math.min(1, +(lastT + 0.25).toFixed(2));
      kfs.push({ t: nt, bones: {}, root: {}, morphs: {} });
      ae.kfIndex = kfs.length - 1;
      renderKeyframeList(ae); renderKeyframeBody(ae); renderTimelineMarkers(ae);
      _syncPreviewDef(ae);
      _aeDirty = true;
    });
    const prevBtn = document.getElementById('ae-preview');
    if (prevBtn) prevBtn.addEventListener('click', () => previewCurrentAction(ae));
    // 预设姿势模板按钮（仅非内置动作存在）
    document.querySelectorAll('.ae-template-btn').forEach(btn => {
      btn.addEventListener('click', () => applyPoseTemplate(ae, btn.dataset.template));
    });
  }

  const saveBtn = document.getElementById('ae-save');
  if (saveBtn) saveBtn.addEventListener('click', () => saveActionEditor(ae));

  // 把「宠物显示 / 代码 / AI 控制」面板（可视化编辑）注入动作编辑器
  const vePanel = document.getElementById('ae-visual-panel');
  if (vePanel && typeof window.buildVisualControlPanel === 'function') {
    window.buildVisualControlPanel(vePanel, ae);
  }

  // 内置动作：提供「复制为可编辑动作」入口（派生一份可编辑副本，便于 AI / 代码优化）
  const deriveBtn = document.getElementById('ae-derive');
  if (deriveBtn) deriveBtn.addEventListener('click', () => deriveBuiltinToEditable(ae));

  // 注入可拖拽分隔条（左/中/右 水平 + 主区/时间轴 垂直），实现自由调整各区域大小
  initSplitters();

  // 预览框悬浮控件：复位视角 + 色彩设置（饱和度/亮度/色相）
  wireActionColorControls(ae);

  // 预览专用「模型组件调整」：整体/部件位移与缩放（仅预览，不影响保存姿态）
  wireActionAdjust(ae);

  // 侧栏标题栏点击展开/折叠对应功能区块
  setupSectionCollapse(document.querySelector('.action-editor'));
}

// 动作编辑器：侧栏各功能区块标题栏（.ae-subhead[data-collapse]）点击展开/折叠
function setupSectionCollapse(root) {
  if (!root) return;
  root.querySelectorAll('.ae-subhead[data-collapse]').forEach(head => {
    head.addEventListener('click', (e) => {
      // 标题内的按钮（如「+ 添加关键帧」）点击不应触发折叠
      if (e.target.closest('button')) return;
      const section = head.closest('.ae-section');
      if (section) section.classList.toggle('collapsed');
    });
  });
}

// 动作编辑器：预览模型色彩设置（饱和度/亮度/色相）持久化 + 复位视角
function wireActionColorControls(ae) {
  const canvas = document.getElementById('ae-preview-canvas');
  const resetViewBtn = document.getElementById('ae-reset-view');
  const colorBtn = document.getElementById('ae-color-btn');
  const colorPop = document.getElementById('ae-color-pop');
  const satEl = document.getElementById('ae-col-sat');
  const briEl = document.getElementById('ae-col-bri');
  const hueEl = document.getElementById('ae-col-hue');
  const satVal = document.getElementById('ae-col-sat-v');
  const briVal = document.getElementById('ae-col-bri-v');
  const hueVal = document.getElementById('ae-col-hue-v');
  const resetColorBtn = document.getElementById('ae-col-reset');

  const DEF = { saturation: 1, brightness: 1, hue: 0 };
  const numOr = (v, d) => (typeof v === 'number' && isFinite(v)) ? v : d;

  // 初始值：优先读取已保存配置
  let color = { ...DEF };
  try {
    const saved = (state.settings && state.settings.pet && state.settings.pet.color) || {};
    color = {
      saturation: numOr(saved.saturation, DEF.saturation),
      brightness: numOr(saved.brightness, DEF.brightness),
      hue: numOr(saved.hue, DEF.hue)
    };
  } catch (e) { /* 配置缺失时用默认值 */ }

  function filterStr() {
    return `saturate(${color.saturation}) brightness(${color.brightness}) hue-rotate(${color.hue}deg)`;
  }
  function applyColor() {
    if (canvas) canvas.style.filter = filterStr();
    if (satVal) satVal.textContent = (+color.saturation).toFixed(2);
    if (briVal) briVal.textContent = (+color.brightness).toFixed(2);
    if (hueVal) hueVal.textContent = (color.hue > 0 ? '+' : '') + Math.round(color.hue) + '°';
  }
  function syncInputs() {
    if (satEl) satEl.value = color.saturation;
    if (briEl) briEl.value = color.brightness;
    if (hueEl) hueEl.value = color.hue;
  }
  function persist() {
    try { window.api.setConfig({ pet: { color: { saturation: color.saturation, brightness: color.brightness, hue: color.hue } } }); } catch (e) {}
  }

  // 初始化
  syncInputs();
  applyColor();

  // 复位视角：重置轨道相机到默认前视
  if (resetViewBtn) {
    resetViewBtn.addEventListener('click', () => {
      if (_actionPreview && typeof _actionPreview.setView === 'function') {
        _actionPreview.setView({ yaw: 0, pitch: 0, zoom: 1 });
      }
    });
  }

  // 色彩设置弹窗开合
  if (colorBtn && colorPop) {
    colorBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      colorPop.classList.toggle('open');
    });
    // 点击面板/按钮以外区域关闭弹窗
    document.addEventListener('click', (e) => {
      if (colorPop.classList.contains('open') && !colorPop.contains(e.target) && e.target !== colorBtn && !colorBtn.contains(e.target)) {
        colorPop.classList.remove('open');
      }
    });
  }

  if (satEl) satEl.addEventListener('input', () => { color.saturation = parseFloat(satEl.value); applyColor(); persist(); });
  if (briEl) briEl.addEventListener('input', () => { color.brightness = parseFloat(briEl.value); applyColor(); persist(); });
  if (hueEl) hueEl.addEventListener('input', () => { color.hue = parseFloat(hueEl.value); applyColor(); persist(); });
  if (resetColorBtn) resetColorBtn.addEventListener('click', () => {
    color = { ...DEF };
    syncInputs();
    applyColor();
    persist();
  });
}

// 预览专用「模型组件调整」：整体 / 选中身体部件的位移(X/Y/Z) + 缩放 + 旋转。
// 仅作用于预览，永不写入关键帧。支持「点击模型拾取部件」（参考 Unity 点击选中物体）。
function wireActionAdjust(ae) {
  const btn = document.getElementById('ae-adjust-btn');
  const bar = document.getElementById('ae-adjust-bar');
  const targetSel = document.getElementById('ae-adj-target');
  const modeBtns = bar ? Array.from(bar.querySelectorAll('.ae-adj-mode')) : [];
  const resetBtn = document.getElementById('ae-adj-reset');
  if (!btn || !bar) return;

  // 每个调整对象的状态（UI 直接存世界位移量，单位与模型一致；传给引擎叠加到基准位置）。
  // 部件调整以「位移」为主——拖拽关节即平移该关节，其下游子骨骼刚性跟随，不产生旋转累积（不会一直转）。
  const DEF_ST = () => ({ dx: 0, dy: 0, dz: 0 });
  ae._adjustByTarget = ae._adjustByTarget || { '': DEF_ST() };
  ae._adjTarget = ae._adjTarget || '';
  ae._adjMode = ae._adjMode || 'move';
  ae._previewAdjust = ae._previewAdjust || { root: { dx: 0, dy: 0, dz: 0, scale: 1 }, part: null };

  // 每次打开编辑器都重置为「环绕视角」模式，避免上次遗留的 _aeAdjustMode 仍为真导致画布一开就处于变换态
  _aeAdjustMode = false;
  btn.classList.remove('active');
  bar.classList.remove('open');

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function valsFor(tgt) { return ae._adjustByTarget[tgt] || (ae._adjustByTarget[tgt] = DEF_ST()); }
  function setMode(m) {
    ae._adjMode = m;
    modeBtns.forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  }
  function syncTarget() { if (targetSel) targetSel.value = ae._adjTarget; }
  // 把当前调整状态推给引擎（仅叠加在预览上，永不写入关键帧）。
  // 部件以「位移」方式移动（dx/dy/dz 为世界空间增量，引擎会按父骨骼朝向转为局部并叠加到基准位置）。
  function applyAdj() {
    const st = valsFor(ae._adjTarget);
    const adj = {
      root: ae._adjustByTarget[''],   // 整体模型：仅用于取景（位移/等比缩放/整体旋转），不影响骨骼
      part: ae._adjTarget ? {
        name: ae._adjTarget,
        dx: st.dx, dy: st.dy, dz: st.dz   // 世界空间位移增量（引擎用）
      } : null
    };
    ae._previewAdjust = adj;
    if (_actionPreview && typeof _actionPreview.setAdjust === 'function') _actionPreview.setAdjust(adj);
  }

  setMode(ae._adjMode);
  syncTarget();

  // 齿轮按钮：开/关「调整模型」模式。开启后画布可直接点选部件、拖拽变换；关闭则恢复环绕视角
  btn.addEventListener('click', () => {
    const open = bar.classList.toggle('open');
    _aeAdjustMode = open;
    btn.classList.toggle('active', open);
    if (open) { setMode(ae._adjMode); syncTarget(); }
  });
  if (targetSel) targetSel.addEventListener('change', () => { ae._adjTarget = targetSel.value; applyAdj(); });
  modeBtns.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  if (resetBtn) resetBtn.addEventListener('click', () => {
    ae._adjustByTarget[ae._adjTarget] = DEF_ST();
    applyAdj();
  });

  // 画布拖拽：以「移动关节」为主——水平拖拽 → 世界 X（右为正），垂直拖拽 → 世界 Y（上为正）。
  // 直接平移当前选中关节，下游骨骼随之刚性跟随；不再做旋转，避免「一直旋转停不下来」。
  const MOVE_SENS = 0.03;   // 每像素对应的世界位移量
  const MOVE_LIMIT = 10;    // 单轴最大位移，防止关节被拖飞
  _aeAdjustDrag = (dx, dy) => {
    const st = valsFor(ae._adjTarget);
    st.dx = clamp(st.dx + dx * MOVE_SENS, -MOVE_LIMIT, MOVE_LIMIT);  // 水平拖拽 → 世界 X
    st.dy = clamp(st.dy - dy * MOVE_SENS, -MOVE_LIMIT, MOVE_LIMIT);  // 垂直拖拽 → 世界 Y（屏幕向下为负）
    applyAdj();
  };
  // 滚轮在「调整模型」模式下不再缩放对象，交由视角缩放（避免局部骨骼被缩放扭曲）。
  _aeAdjustWheel = null;
  // 点击模型拾取部件（参考 Unity 点击选中）：射线命中模型表面，选中离命中点最近的身体部件
  _aeAdjustClick = (clientX, clientY) => {
    if (!_actionPreview || typeof _actionPreview.pickPart !== 'function') return;
    const k = _actionPreview.pickPart(clientX, clientY);
    if (!k) return;
    ae._adjTarget = k;
    syncTarget();
    setMode('move'); // 选中部件后默认进入移动模式
    applyAdj();
  };
}

// 注入拖拽分隔条并绑定拖动逻辑（左↔中、中↔右、主区↔时间轴）
function initSplitters() {
  const grid = document.querySelector('.action-editor .ae-grid');
  if (!grid) return;
  const left = document.getElementById('ae-side-left');
  const center = grid.querySelector('.ae-col-center');
  const right = document.getElementById('ae-side-right');
  const timeline = document.querySelector('.action-editor .ae-timeline');

  // 水平分隔条：左↔中、中↔右
  if (left && center) {
    const spL = document.createElement('div');
    spL.className = 'ae-splitter ae-splitter-h'; spL.dataset.side = 'left';
    grid.insertBefore(spL, center);
  }
  if (center && right) {
    const spR = document.createElement('div');
    spR.className = 'ae-splitter ae-splitter-h'; spR.dataset.side = 'right';
    grid.insertBefore(spR, right);
  }
  // 垂直分隔条：主区 ↔ 时间轴（全宽）
  if (timeline && timeline.parentElement) {
    const spV = document.createElement('div');
    spV.className = 'ae-splitter ae-splitter-v';
    timeline.parentElement.insertBefore(spV, timeline);
  }

  grid.querySelectorAll('.ae-splitter-h').forEach(sp => sp.addEventListener('pointerdown', (e) => startSplitH(e, sp)));
  const spV = document.querySelector('.action-editor .ae-splitter-v');
  if (spV) spV.addEventListener('pointerdown', (e) => startSplitV(e, spV));
}

function startSplitH(e, sp) {
  e.preventDefault();
  const side = sp.dataset.side;
  const aside = document.getElementById(side === 'left' ? 'ae-side-left' : 'ae-side-right');
  const grid = aside.parentElement;
  const rect = grid.getBoundingClientRect();
  const move = (ev) => {
    let nb = side === 'left' ? (ev.clientX - rect.left) : (rect.right - ev.clientX);
    nb = Math.max(180, Math.min(560, nb));
    aside.style.flexBasis = nb + 'px';
    aside.dataset.basis = nb;
    window.dispatchEvent(new Event('resize'));
  };
  dragSplitEnd(sp, move);
}

function startSplitV(e, sp) {
  e.preventDefault();
  const timeline = document.querySelector('.action-editor .ae-timeline');
  const editor = document.querySelector('.action-editor');
  const startY = e.clientY;
  const startH = timeline.getBoundingClientRect().height;
  // 预览框最小保留高度：保证调高时间轴时模型永远不会被时间轴覆盖
  const MIN_PREVIEW = 160;
  const SPLITTER = 8;
  const TOOLBAR = (editor && editor.firstElementChild) ? editor.firstElementChild.getBoundingClientRect().height : 44;
  const maxH = editor ? Math.max(MIN_PREVIEW + SPLITTER, editor.clientHeight - TOOLBAR - SPLITTER - MIN_PREVIEW) : 520;
  const move = (ev) => {
    let dh = startH + (startY - ev.clientY); // 向上拖增大时间轴高度
    dh = Math.max(90, Math.min(maxH, dh));
    timeline.style.flex = '0 0 ' + dh + 'px';
    window.dispatchEvent(new Event('resize'));
  };
  dragSplitEnd(sp, move);
}

function dragSplitEnd(sp, move) {
  sp.classList.add('dragging');
  document.body.style.cursor = sp.classList.contains('ae-splitter-v') ? 'row-resize' : 'col-resize';
  document.body.style.userSelect = 'none';
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    sp.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    window.dispatchEvent(new Event('resize'));
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

// 关闭动作编辑器：独立窗口关闭窗口，页内模态关闭模态
// 有未保存修改时弹出确认弹窗
async function closeActionEditor() {
  if (_aeDirty) {
    const confirmed = await showConfirm({
      type: 'warning',
      title: window.I18N?.t?.('unsavedTitle') || '未保存的修改',
      message: window.I18N?.t?.('unsavedMessage') || '当前动作有未保存的修改或新增内容，确定要退出吗？'
    });
    if (!confirmed) return; // 用户取消，不关闭
  }
  _destroyActionPreview();
  if (IS_EDITOR_WINDOW) { window.api.editor.close(); }
  else { closeModal(); }
}

// 把一个关键帧“浓缩”成一句人话：哪些骨骼被摆了、几个表情被触发，让列表/标记一眼看懂
function summarizeKeyframe(kf) {
  const bones = kf.bones || {};
  const morphs = kf.morphs || {};
  const labels = [];
  for (const [key, label] of ACTION_BONES) {
    const b = bones[key];
    if (b && (b.x || b.y || b.z)) labels.push(label);
  }
  let morphCount = 0;
  for (const k in morphs) if (morphs[k] > 0) morphCount++;
  const parts = [];
  if (labels.length) {
    const head = labels.slice(0, 3).join('·');
    parts.push(labels.length > 3 ? `${head}等${labels.length}骨` : `${head}骨`);
  }
  if (morphCount) parts.push(`${morphCount}表情`);
  return parts.length ? parts.join(' · ') : '仅整体位姿';
}

function renderKeyframeList(ae) {
  const t = window.I18N?.t || ((k) => k);
  const listEl = document.getElementById('ae-kf-list');
  if (!listEl) return;
  listEl.innerHTML = '';
  const CIRCLED = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩'];
  ae.def.keyframes.forEach((kf, i) => {
    const item = document.createElement('div');
    item.className = 'ae-kf-item' + (i === ae.kfIndex ? ' active' : '');
    const idx = CIRCLED[i] || (i + 1);
    const sum = summarizeKeyframe(kf);
    item.innerHTML = `<span class="ae-kf-idx" title="关键帧 ${i + 1}">${idx}</span>
      <span class="ae-kf-t">${(+kf.t).toFixed(2)}</span>
      <span class="ae-kf-sum" title="${sum}">${sum}</span>
      <button class="ae-kf-del" title="${t('actions.removeKeyframe')}">×</button>`;
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('ae-kf-del')) {
        if (ae.def.keyframes.length <= 1) { showToast(t('actions.tooFewKeyframes'), '', 'warning'); return; }
        ae.def.keyframes.splice(i, 1);
        if (ae.kfIndex >= ae.def.keyframes.length) ae.kfIndex = ae.def.keyframes.length - 1;
        renderKeyframeList(ae); renderKeyframeBody(ae); renderTimelineMarkers(ae);
        _syncPreviewDef(ae);
        _aeDirty = true;
        return;
      }
      ae.kfIndex = i;
      renderKeyframeList(ae); renderKeyframeBody(ae); renderTimelineMarkers(ae);
      const kf = ae.def.keyframes[ae.kfIndex];
      if (kf) seekPreview(kf.t);
    });
    listEl.appendChild(item);
  });
}

function renderKeyframeBody(ae) {
  const t = window.I18N?.t || ((k) => k);
  const bodyEl = document.getElementById('ae-kf-body');
  if (!bodyEl) return;
  if (!ae || !ae.def || !Array.isArray(ae.def.keyframes)) { bodyEl.innerHTML = ''; return; }
  if (ae.kfIndex < 0 || ae.kfIndex >= ae.def.keyframes.length) { bodyEl.innerHTML = ''; return; }
  try {
  const kf = ae.def.keyframes[ae.kfIndex];
  if (!kf) { bodyEl.innerHTML = ''; return; }
  kf.bones = kf.bones || {}; kf.root = kf.root || {}; kf.morphs = kf.morphs || {};

  let html = `<div class="ae-field ae-kf-time-row"><label>${t('actions.time')}</label>
    <input type="number" id="ae-kf-time" min="0" max="1" step="0.01" value="${kf.t}">
    <button class="btn btn-sm" id="ae-mirror" title="把当前帧的左右姿势镜像到对侧（一键做对称姿势）">⇄ 镜像左右</button></div>`;

  html += `<div class="ae-bones-title">${t('actions.bones')}</div><div class="ae-bone-grid">`;
  for (const [key, label] of ACTION_BONES) {
    const b = kf.bones[key] || {};
    html += `<div class="ae-bone-row" data-bone="${key}">
      <span class="ae-bone-name" title="${key}">${label}</span>
      <div class="ae-axis-seg" data-bone="${key}">
        <button type="button" class="ae-axis-btn active" data-axis="x">X</button>
        <button type="button" class="ae-axis-btn" data-axis="y">Y</button>
        <button type="button" class="ae-axis-btn" data-axis="z">Z</button>
      </div>
      <input type="number" step="1" class="ae-bx" data-bone="${key}" data-axis="x" value="${radToDeg(b.x)}">
      <div class="ae-knob-slot" data-bone="${key}"></div>
    </div>`;
  }
  html += `</div>`;

  const r = kf.root;
  html += `<div class="ae-bones-title">${t('actions.root')}</div><div class="ae-root-row">
    <label class="ae-root-y-label">${t('actions.rootY')}</label><input type="number" id="ae-root-y" step="0.01" min="-0.6" max="0.6" value="${r.y || 0}">
    <span class="ae-bone-name">${t('actions.rootRot')}</span>
    <div class="ae-axis-seg" id="ae-root-axis">
      <button type="button" class="ae-axis-btn active" data-axis="x">X</button>
      <button type="button" class="ae-axis-btn" data-axis="y">Y</button>
      <button type="button" class="ae-axis-btn" data-axis="z">Z</button>
    </div>
    <div class="ae-knob-slot" id="ae-root-knob"></div>
    <input type="number" step="1" class="ae-root-rot" id="ae-root-rot" data-axis="x" value="${radToDeg(r.rotX)}">
  </div>`;

  html += `<div class="ae-bones-title">${t('actions.morphs')}</div><div class="ae-morph-grid">`;
  for (const [key, label] of ACTION_MORPHS) {
    const w = kf.morphs[key] || 0;
    const on = w > 0;
    html += `<div class="ae-morph-row">
      <input type="checkbox" class="ae-morph-cb" data-morph="${key}" ${on ? 'checked' : ''}>
      <span class="ae-morph-name">${label}</span>
      <input type="range" min="0" max="1" step="0.05" class="ae-morph-range" data-morph="${key}" value="${w}" ${on ? '' : 'disabled'}></div>`;
  }
  html += `</div>`;

  bodyEl.innerHTML = html;
  document.getElementById('ae-kf-t-val').textContent = (+kf.t).toFixed(2);

  document.getElementById('ae-kf-time').addEventListener('input', (e) => {
    let v = parseFloat(e.target.value); if (!isFinite(v)) v = 0;
    kf.t = Math.max(0, Math.min(1, v));
    ae.def.keyframes.sort((a, b) => a.t - b.t);
    ae.kfIndex = ae.def.keyframes.indexOf(kf);
    renderKeyframeList(ae); renderTimelineMarkers(ae);
    const items = document.querySelectorAll('#ae-kf-list .ae-kf-item');
    if (items[ae.kfIndex]) items[ae.kfIndex].querySelector('.ae-kf-t').textContent = (+kf.t).toFixed(2);
    const tv = document.getElementById('ae-kf-t-val'); if (tv) tv.textContent = (+kf.t).toFixed(2);
    _syncPreviewDef(ae); updatePlayhead(kf.t);
    _aeDirty = true;
  });
  const mirrorBtn = document.getElementById('ae-mirror');
  if (mirrorBtn) mirrorBtn.addEventListener('click', () => mirrorKeyframeLR(ae));
  // 骨骼旋转：旋钮 + XYZ 轴选择（旋转角度用旋钮定位）
  bodyEl.querySelectorAll('.ae-bone-row').forEach(row => {
    const key = row.dataset.bone;
    const knobSlot = row.querySelector('.ae-knob-slot');
    const num = row.querySelector('.ae-bx');
    const segBtns = row.querySelectorAll('.ae-axis-btn');
    const axisOf = () => row.querySelector('.ae-axis-btn.active').dataset.axis;
    const degOf = (axis) => radToDeg((kf.bones[key] || {})[axis] || 0);
    const writeBone = (axis, deg) => {
      kf.bones[key] = kf.bones[key] || {};
      kf.bones[key][axis] = degToRad(deg);
      if (!kf.bones[key].x && !kf.bones[key].y && !kf.bones[key].z) delete kf.bones[key];
    };
    const knob = makeKnob({ value: degOf('x'), onChange: (deg) => { writeBone(axisOf(), deg); num.value = Math.round(deg); _syncPreviewDef(ae); _aeDirty = true; } });
    knobSlot.appendChild(knob.el);
    segBtns.forEach(btn => btn.addEventListener('click', () => {
      segBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const axis = btn.dataset.axis;
      const deg = degOf(axis);
      knob.setValue(deg);
      num.dataset.axis = axis;
      num.value = Math.round(deg);
    }));
    num.addEventListener('input', () => {
      const axis = axisOf();
      const deg = parseFloat(num.value) || 0;
      writeBone(axis, deg);
      knob.setValue(deg);
      _syncPreviewDef(ae);
      _aeDirty = true;
    });
  });

  // 根旋转：旋钮 + XYZ 轴选择
  {
    const rootAxis = bodyEl.querySelector('#ae-root-axis');
    const rootKnobSlot = bodyEl.querySelector('#ae-root-knob');
    const rootNum = bodyEl.querySelector('#ae-root-rot');
    if (rootAxis && rootKnobSlot && rootNum) {
      const segBtns = rootAxis.querySelectorAll('.ae-axis-btn');
      const axisOf = () => rootAxis.querySelector('.ae-axis-btn.active').dataset.axis;
      const degOf = (axis) => radToDeg((kf.root['rot' + axis.toUpperCase()] || 0));
      const writeRot = (axis, deg) => { kf.root['rot' + axis.toUpperCase()] = degToRad(deg); };
      const knob = makeKnob({ value: degOf('x'), onChange: (deg) => { writeRot(axisOf(), deg); rootNum.value = Math.round(deg); _syncPreviewDef(ae); _aeDirty = true; } });
      rootKnobSlot.appendChild(knob.el);
      segBtns.forEach(btn => btn.addEventListener('click', () => {
        segBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const axis = btn.dataset.axis;
        const deg = degOf(axis);
        knob.setValue(deg);
        rootNum.dataset.axis = axis;
        rootNum.value = Math.round(deg);
      }));
      rootNum.addEventListener('input', () => {
        const axis = axisOf();
        const deg = parseFloat(rootNum.value) || 0;
        writeRot(axis, deg);
        knob.setValue(deg);
        _syncPreviewDef(ae);
        _aeDirty = true;
      });
    }
  }

  const ry = document.getElementById('ae-root-y'); if (ry) ry.addEventListener('input', () => { kf.root.y = parseFloat(ry.value) || 0; _syncPreviewDef(ae); _aeDirty = true; });
  bodyEl.querySelectorAll('.ae-morph-cb').forEach(cb => cb.addEventListener('change', () => {
    const key = cb.dataset.morph;
    if (cb.checked) {
      // 单选：一个关键帧只对应一个表情，勾选时取消其它已选表情
      kf.morphs = {};
      bodyEl.querySelectorAll('.ae-morph-cb').forEach(other => {
        if (other === cb) return;
        other.checked = false;
        const or = bodyEl.querySelector(`.ae-morph-range[data-morph="${other.dataset.morph}"]`);
        if (or) or.disabled = true;
      });
      const range = bodyEl.querySelector(`.ae-morph-range[data-morph="${key}"]`);
      if (range) { range.disabled = false; kf.morphs[key] = parseFloat(range.value) || 0.6; }
      else kf.morphs[key] = 0.6;
    } else {
      delete kf.morphs[key];
    }
    _syncPreviewDef(ae);
    _aeDirty = true;
  }));
  bodyEl.querySelectorAll('.ae-morph-range').forEach(rg => rg.addEventListener('input', () => {
    const key = rg.dataset.morph;
    if (kf.morphs[key] != null) kf.morphs[key] = parseFloat(rg.value) || 0;
    _syncPreviewDef(ae);
    _aeDirty = true;
  }));
  wrapNumberSteppers(bodyEl);
  } catch (e) {
    console.error('[renderKeyframeBody] 渲染失败:', e);
    bodyEl.innerHTML = '<div style="color:#f66;padding:8px;font-size:12px">关键帧参数渲染失败: ' + escapeHtml(e.message) + '</div>';
  }
}

// 把容器内的 <input type="number"> 包裹成主题化 −/+ 步进器（复用系统设置页 .stepper-wrapper 组件）：
// 点击 −/+ 按 step 增减并触发 input 事件，使现有监听器（骨骼/位移/表情/相关参数）照常生效。
function wrapNumberSteppers(scope) {
  if (!scope || !window.ElIcons) return;
  scope.querySelectorAll('input[type="number"]').forEach(inp => {
    if (inp.closest('.stepper-wrapper')) return;
    const wrap = document.createElement('span');
    wrap.className = 'stepper-wrapper';
    inp.parentNode.insertBefore(wrap, inp);
    wrap.appendChild(inp);
    const dec = document.createElement('button');
    dec.type = 'button'; dec.className = 'stepper-btn'; dec.title = '−';
    dec.innerHTML = window.ElIcons.getIcon('minus');
    const inc = document.createElement('button');
    inc.type = 'button'; inc.className = 'stepper-btn'; inc.title = '+';
    inc.innerHTML = window.ElIcons.getIcon('plusSimple');
    wrap.insertBefore(dec, inp);
    wrap.appendChild(inc);
    const stepOf = () => { const s = parseFloat(inp.getAttribute('step')); return (isFinite(s) && s !== 0) ? Math.abs(s) : 1; };
    const clamp = (v) => {
      const min = parseFloat(inp.getAttribute('min'));
      const max = parseFloat(inp.getAttribute('max'));
      if (isFinite(min) && v < min) v = min;
      if (isFinite(max) && v > max) v = max;
      return v;
    };
    const bump = (dir) => {
      let v = parseFloat(inp.value);
      if (!isFinite(v)) v = parseFloat(inp.getAttribute('value')) || 0;
      v = clamp(+(v + dir * stepOf()).toFixed(6));
      inp.value = String(v);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    };
    dec.addEventListener('click', () => bump(-1));
    inc.addEventListener('click', () => bump(1));
  });
}

// 旋转角度旋钮（圆盘拖拽 + 滚轮微调）：返回 { el, setValue }。
// 交互：在圆盘上按下并绕中心画圆 → 角度跟随（0° 在 12 点方向，顺时针为正）；
// 也支持鼠标滚轮 ±1°。value 单位：度，范围 [min,max]。
function makeKnob({ value = 0, min = -180, max = 180, size = 46, onChange } = {}) {
  const NS = 'http://www.w3.org/2000/svg';
  const el = document.createElement('div');
  el.className = 'ae-knob';
  el.title = '拖拽旋转 / 滚轮微调角度';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%');
  const track = document.createElementNS(NS, 'circle');
  track.setAttribute('cx', 50); track.setAttribute('cy', 50); track.setAttribute('r', 40);
  track.setAttribute('class', 'ae-knob-track');
  const ptr = document.createElementNS(NS, 'line');
  ptr.setAttribute('x1', 50); ptr.setAttribute('y1', 50);
  ptr.setAttribute('x2', 50); ptr.setAttribute('y2', 12);
  ptr.setAttribute('class', 'ae-knob-ptr');
  const txt = document.createElementNS(NS, 'text');
  txt.setAttribute('x', 50); txt.setAttribute('y', 56);
  txt.setAttribute('text-anchor', 'middle');
  txt.setAttribute('class', 'ae-knob-val');
  svg.appendChild(track); svg.appendChild(ptr); svg.appendChild(txt);
  el.appendChild(svg);

  let val = value;
  const clamp = (v) => Math.max(min, Math.min(max, v));
  function render() {
    ptr.setAttribute('transform', `rotate(${val} 50 50)`);
    txt.textContent = Math.round(val) + '°';
  }
  function setVal(v, fire = true) { val = clamp(v); render(); if (fire && onChange) onChange(val); }

  const topAngle = (clientX, clientY) => {
    const r = svg.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    // 标准 atan2：0° 在 3 点方向，顺时针为正（屏幕 y 向下）；+90° 使 0° 落在 12 点方向
    return Math.atan2(clientY - cy, clientX - cx) * 180 / Math.PI + 90;
  };
  let dragging = false, prevTop = 0;
  const onMove = (e) => {
    if (!dragging) return;
    let d = topAngle(e.clientX, e.clientY) - prevTop;
    while (d > 180) d -= 360; while (d < -180) d += 360;
    prevTop = topAngle(e.clientX, e.clientY);
    setVal(val + d);
  };
  const onUp = () => {
    dragging = false;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    el.classList.remove('dragging');
  };
  el.addEventListener('pointerdown', (e) => {
    dragging = true; prevTop = topAngle(e.clientX, e.clientY);
    el.classList.add('dragging');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    e.preventDefault();
  });
  el.addEventListener('wheel', (e) => { e.preventDefault(); setVal(val + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });

  render();
  return { el, setValue: (v) => setVal(v, false) };
}

// 相关动作条目规范化：兼容旧格式「字符串键」与新格式「{key,count,interval,loop}」
function normalizeRelatedEntry(r, idx, arr) {
  const n = (arr && arr.length) ? arr.length : 1;
  const spread = (idx + 1) / (n + 1); // 缺省沿时间轴均布
  if (typeof r === 'string') return { key: r, count: 1, interval: 0, loop: false, t: spread };
  if (!r || !r.key) return null;
  const t = (typeof r.t === 'number' && isFinite(r.t)) ? Math.max(0, Math.min(1, r.t)) : spread;
  return {
    key: r.key,
    count: (r.count && r.count > 1) ? r.count : 1,
    interval: (r.interval && r.interval > 0) ? r.interval : 0,
    loop: !!r.loop,
    t
  };
}

function renderRelatedList(ae) {
  const t = window.I18N?.t || ((k) => k);
  const listEl = document.getElementById('ae-related-list');
  if (!listEl) return;
  // 规范化：旧格式字符串或新格式对象统一处理
  ae.def.related = (ae.def.related || []).map(normalizeRelatedEntry).filter(r => r && r.key);

  const labelOf = (key) => {
    const bu = BUILTIN_ACTIONS.find(a => a.key === key);
    if (bu) return bu.label;
    if (ae.data.actions[key]) return ae.data.actions[key].label || key;
    return key;
  };

  const rel = ae.def.related;
  const dur = (ae.def.duration || 2);
  if (rel.length === 0) {
    listEl.innerHTML = `<div class="ae-note">${t('actions.noRelated')}</div>`;
  } else {
    listEl.innerHTML = rel.map((r, i) => `
      <div class="ae-related-row${_bpIndex === i ? ' ae-rel-active' : ''}">
        <div class="ae-rel-reorder">
          <button class="ae-rel-btn" data-edit="${r.key}" title="${t('related.edit')}">${window.ElIcons.getIcon('edit')}</button>
          <button class="ae-rel-btn" data-up="${i}" ${i === 0 ? 'disabled' : ''} title="${t('related.up')}">${window.ElIcons.getIcon('up')}</button>
          <button class="ae-rel-btn" data-down="${i}" ${i === rel.length - 1 ? 'disabled' : ''} title="${t('related.down')}">${window.ElIcons.getIcon('down')}</button>
        </div>
        <div class="ae-rel-main">
          <div class="ae-rel-label">${escapeHtml(labelOf(r.key))}</div>
          <div class="ae-rel-params">
            <label class="ae-rel-field"><span>${t('related.time')}</span><input type="number" class="ae-rel-t" data-i="${i}" min="0" max="${dur}" step="0.05" value="${(r.t * dur).toFixed(2)}"></label>
            <label class="ae-rel-field"><span>${t('related.count')}</span><input type="number" class="ae-rel-count" data-i="${i}" min="1" max="20" step="1" value="${r.count}"></label>
            <label class="ae-rel-field"><span>${t('related.interval')}</span><input type="number" class="ae-rel-interval" data-i="${i}" min="0" max="10" step="0.1" value="${r.interval}"></label>
            <label class="ae-rel-field ae-rel-loop"><input type="checkbox" class="ae-rel-loop" data-i="${i}" ${r.loop ? 'checked' : ''}><span>${t('actions.loop')}</span></label>
          </div>
        </div>
        <button class="ae-rel-btn ae-rel-remove" data-remove="${i}" title="${t('related.remove')}">×</button>
      </div>`).join('');
  }

  listEl.querySelectorAll('[data-up]').forEach(b => b.addEventListener('click', () => {
    const i = +b.dataset.up; if (i <= 0) return;
    const tmp = ae.def.related[i - 1]; ae.def.related[i - 1] = ae.def.related[i]; ae.def.related[i] = tmp;
    renderRelatedList(ae);
  }));
  listEl.querySelectorAll('[data-down]').forEach(b => b.addEventListener('click', () => {
    const i = +b.dataset.down; if (i >= ae.def.related.length - 1) return;
    const tmp = ae.def.related[i + 1]; ae.def.related[i + 1] = ae.def.related[i]; ae.def.related[i] = tmp;
    renderRelatedList(ae);
  }));
  listEl.querySelectorAll('[data-remove]').forEach(b => b.addEventListener('click', () => {
    ae.def.related.splice(+b.dataset.remove, 1);
    renderRelatedList(ae);
  }));
  // 直接打开「相关动作」进行编辑（绑定到该动作本身，而非联合/选择模式）
  listEl.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
    const key = b.dataset.edit;
    if (!key) return;
    const isBuiltin = !!BUILTIN_ACTIONS.find(a => a.key === key);
    window.api.editor.open({ modelId: ae.model.id, actionKey: key, isNew: false, isBuiltin });
  }));
  listEl.querySelectorAll('.ae-rel-count').forEach(inp => inp.addEventListener('input', () => {
    const i = +inp.dataset.i; const v = parseInt(inp.value, 10);
    if (ae.def.related[i]) ae.def.related[i].count = (v > 1 ? v : 1);
  }));
  listEl.querySelectorAll('.ae-rel-interval').forEach(inp => inp.addEventListener('input', () => {
    const i = +inp.dataset.i; const v = parseFloat(inp.value);
    if (ae.def.related[i]) ae.def.related[i].interval = (isFinite(v) && v > 0 ? v : 0);
  }));
  listEl.querySelectorAll('.ae-rel-loop').forEach(cb => cb.addEventListener('change', () => {
    const i = +cb.dataset.i;
    if (ae.def.related[i]) ae.def.related[i].loop = cb.checked;
  }));
  listEl.querySelectorAll('.ae-rel-t').forEach(inp => inp.addEventListener('input', () => {
    const i = +inp.dataset.i; const d = (ae.def.duration || 2); const v = parseFloat(inp.value);
    if (ae.def.related[i] && isFinite(v)) ae.def.related[i].t = Math.max(0, Math.min(d, v)) / d;
  }));

  // 添加相关动作（排除自身与已添加的）
  const curKey = ae.isNew ? null : ae.key;
  const usedKeys = new Set(ae.def.related.map(r => r.key));
  const all = BUILTIN_ACTIONS.concat(
    Object.keys(ae.data.actions).map(k => ({ key: k, label: ae.data.actions[k].label || k }))
  );
  const avail = all.filter(a => a.key !== curKey && !usedKeys.has(a.key));
  const addWrap = document.createElement('div');
  addWrap.className = 'ae-rel-add';
  addWrap.innerHTML = `
    <select class="ae-rel-select" id="ae-rel-select">
      <option value="">${t('related.select')}</option>
      ${avail.map(a => `<option value="${a.key}">${escapeHtml(a.label)}</option>`).join('')}
    </select>
    <button class="btn btn-sm" id="ae-rel-add-btn">+ ${t('related.add')}</button>`;
  listEl.appendChild(addWrap);
  document.getElementById('ae-rel-add-btn').addEventListener('click', () => {
    const sel = document.getElementById('ae-rel-select');
    const key = sel && sel.value;
    if (!key) return;
    ae.def.related.push({ key, count: 1, interval: 0, loop: false });
    renderRelatedList(ae);
  });
  wrapNumberSteppers(listEl);
  // 首次渲染时自绘下拉 wrapper 的 flex 宽度可能算偏几像素，把右侧「+ 添加相关动作」按钮顶出
  // 滚动容器右边界被裁（表现为默认打开按钮缺一个字，手动 resize 窗口后正常）。
  // 下一帧强制重排一次，等价于手动调整窗口大小，确保首屏布局即正确。
  requestAnimationFrame(() => requestAnimationFrame(() => window.dispatchEvent(new Event('resize'))));
}


function buildActionDef(ae) {
  const def = JSON.parse(JSON.stringify(ae.def));
  def.keyframes = (def.keyframes || []).map(normalizeKeyframe).sort((a, b) => a.t - b.t);
  def.speed = (typeof def.speed === 'number' && def.speed > 0) ? def.speed : 1;
  return def;
}

function previewCurrentAction(ae) {
  const t = window.I18N?.t || ((k) => k);
  if (ae.isBuiltin) { showToast(t('actions.previewNoPet'), '', 'info'); return; }
  if (!ae.def.keyframes || !ae.def.keyframes.length) { showToast(t('actions.tooFewKeyframes'), '', 'warning'); return; }
  const def = buildActionDef(ae);
  window.api.previewActionInPet(def).catch(() => {});
  showToast(t('actions.previewInPet'), t('actions.previewSent'), 'info');
}

// 供 visualEditor 的代码控制台 / AI 助手调用：修改 ae.def 后统一重绘动作编辑器（关键帧列表/编辑/时间轴/相关动作/预览同步）
window.refreshActionEditor = function (ae) {
  if (!ae) return;
  if (!ae.isBuiltin) {
    if (typeof renderKeyframeList === 'function') renderKeyframeList(ae);
    if (typeof renderKeyframeBody === 'function') renderKeyframeBody(ae);
    if (typeof renderTimelineMarkers === 'function') renderTimelineMarkers(ae);
  }
  if (typeof renderRelatedList === 'function') renderRelatedList(ae);
  if (typeof _syncPreviewDef === 'function') _syncPreviewDef(ae);
  const kf = (ae.def.keyframes && ae.def.keyframes[ae.kfIndex]) ? ae.def.keyframes[ae.kfIndex] : null;
  if (typeof seekPreview === 'function') seekPreview((kf && kf.t) || 0);
};

async function saveActionEditor(ae) {
  const t = window.I18N?.t || ((k) => k);
  const def = ae.def;
  if (!def.label || !def.label.trim()) { showToast('请填写动作名称', '', 'warning'); return; }
  def.label = def.label.trim();
  if (!ae.isBuiltin) {
    if (!def.keyframes || def.keyframes.length === 0) { showToast(t('actions.tooFewKeyframes'), '', 'warning'); return; }
    def.keyframes = def.keyframes.map(normalizeKeyframe).sort((a, b) => a.t - b.t);
  }
  def.related = (def.related || []).map(normalizeRelatedEntry).filter(r => r && r.key);
  if (ae.isNew || !def.key) def.key = generateActionKey(ae.data, def.label);
  def.key = String(def.key);
  ae.data.actions[def.key] = def;
  const r = await persistActions(ae.model, ae.data);
  if (r && r.success) {
    showToast(t('actions.saved'), '', 'success');
    _aeDirty = false; // 保存成功，重置脏标记
    if (IS_EDITOR_WINDOW) {
      try { await window.api.editor.saved(ae.model.id); } catch (e) {}
      closeActionEditor();
    } else {
      closeModal();
      showModelInfo(ae.model);
    }
  } else {
    showToast(t('actions.saveFail'), (r && r.error) || '', 'error');
  }
}

// 缩略图改为导入时智能匹配模型目录中的图片，不再提供手动编辑（见 modelManager.importModel）

// 保存模型名称与描述
async function saveModelEdits(model) {
  const name = document.getElementById('input-edit-name').value.trim();
  const description = document.getElementById('input-edit-desc').value;
  if (!name) {
    showToast('名称不能为空', '', 'warning');
    return;
  }
  const result = await window.api.updateModel(model.id, { name, description });
  if (result.success) {
    state.models = await window.api.listModels();
    renderModelList();
    const updated = state.models.find(m => m.id === model.id) || model;
    showModelInfo(updated);
    updateModelStatusBar();
    showToast('已保存', '', 'success');
  } else {
    showToast('保存失败', result.error, 'error');
  }
}

function getModelIcon(format, thumbnail) {
  if (thumbnail) {
    // 用 data-thumb 标记，渲染后通过 IPC 异步读取转 base64（规避协议/CORS 问题）
    return `<div class="model-thumb-wrap" data-thumb="${thumbnail.replace(/"/g, '&quot;')}">${window.ElIcons.getIcon('model')}</div>`;
  }
  return window.ElIcons.getIcon('model');
}

// 异步加载模型缩略图（IPC 读取 → base64 data URL）
async function loadModelThumbnails() {
  const wraps = document.querySelectorAll('.model-thumb-wrap[data-thumb]');
  for (const wrap of wraps) {
    const thumbPath = wrap.dataset.thumb;
    if (!thumbPath || wrap.dataset.loaded) continue;
    wrap.dataset.loaded = '1';
    try {
      const result = await window.api.readFile({ path: thumbPath, encoding: 'base64' });
      if (result && result.success && result.data) {
        const ext = (thumbPath.split('.').pop() || 'png').toLowerCase();
        const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
        wrap.innerHTML = `<img class="model-thumb-img" src="data:${mime};base64,${result.data}" alt="">`;
      } else {
        wrap.innerHTML = window.ElIcons.getIcon('model');
      }
    } catch (e) {
      wrap.innerHTML = window.ElIcons.getIcon('model');
    }
  }
}

function createEmptyState() {
  const div = document.createElement('div');
  div.className = 'empty-state';
  div.innerHTML = `
    <div class="empty-icon">${window.ElIcons.getIcon('models')}</div>
    <div class="empty-text">还没有导入自定义模型</div>
    <div class="empty-hint">支持 Live2D (.model3.json / .model2.json) 和 MMD (.pmx / .pmd)</div>
  `;
  return div;
}

function createSoftwareEmptyState() {
  const div = document.createElement('div');
  div.className = 'empty-state';
  div.innerHTML = `
    <div class="empty-icon">${window.ElIcons.getIcon('software')}</div>
    <div class="empty-text">未检测到已安装软件</div>
    <div class="empty-hint">点击"刷新列表"重新扫描系统已安装的软件</div>
  `;
  return div;
}

// ==================== 文件管理 ====================
async function loadFileList() {
  const pathInput = document.getElementById('current-path');
  const pathValue = state.currentPath || window.api.os.homedir() || '';
  pathInput.value = pathValue;

  try {
    const result = await window.api.listFiles({ path: pathValue });
    if (result.success) {
      state.fileTree = result.data;
      state.currentPath = result.path;
      renderFileList(result.data);
      document.getElementById('file-count').textContent = (window.I18N?.t || ((k) => k))('files.itemCount', { count: result.total });
    } else {
      showToast('加载失败', result.error, 'error');
    }
  } catch (err) {
    showToast('加载失败', err.message, 'error');
  }
}

function renderFileList(files) {
  const listEl = document.getElementById('file-list');
  listEl.innerHTML = '';

  // 上级目录
  if (state.currentPath) {
    const upItem = document.createElement('div');
    upItem.className = 'file-item';
    upItem.innerHTML = `
      <div class="file-item-icon">${window.ElIcons.ICONS.folder}</div>
      <div class="file-item-name">.. (上级目录)</div>
      <div class="file-item-size"></div>
      <div class="file-item-date"></div>
      <div class="file-item-actions"></div>
    `;
    upItem.addEventListener('dblclick', () => {
      state.currentPath = window.api.path.dirname(state.currentPath);
      loadFileList();
    });
    listEl.appendChild(upItem);
  }

  const sorted = [...files].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const file of sorted) {
    const item = document.createElement('div');
    item.className = 'file-item';
    const sizeText = file.accessDenied ? '不可访问' : (file.isDirectory ? '' : formatSize(file.size));
    const dateText = file.modified ? new Date(file.modified).toLocaleDateString() : '';
    item.innerHTML = `
      <div class="file-item-icon">${file.isDirectory ? window.ElIcons.ICONS.folder : getFileIcon(file.name)}</div>
      <div class="file-item-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
      <div class="file-item-size">${sizeText}</div>
      <div class="file-item-date">${dateText}</div>
      <div class="file-item-actions">
        <button class="file-action-btn" title="打开">${file.isDirectory ? window.ElIcons.ICONS.folder : window.ElIcons.ICONS.externalLink}</button>
        <button class="file-action-btn danger" title="删除">${window.ElIcons.ICONS.delete}</button>
      </div>
    `;

    item.addEventListener('dblclick', () => {
      if (file.isDirectory) {
        state.currentPath = file.path;
        loadFileList();
      } else {
        openFile(file);
      }
    });

    item.querySelectorAll('.file-action-btn')[0].addEventListener('click', () => openFile(file));
    item.querySelectorAll('.file-action-btn')[1].addEventListener('click', () => deleteFile(file));

    listEl.appendChild(item);
  }
}

function getFileIcon(name) {
  return window.ElIcons.getFileIconSVG(name);
}

async function openFile(file) {
  if (file.isDirectory) {
    state.currentPath = file.path;
    loadFileList();
  } else {
    await window.api.openPath(file.path);
  }
}

async function deleteFile(file) {
  const isDanger = file.path && (state.settings.system?.confirmDangerOps !== false);

  if (isDanger) {
    const confirmed = await showConfirm({
      type: 'warning',
      title: '删除确认',
      message: `确定要删除「${file.name}」吗？`,
      detail: `路径：${file.path}\n此操作不可恢复。`
    });
    if (!confirmed) return;
  }

  const result = await window.api.deleteFile({ path: file.path, recursive: file.isDirectory });
  if (result.success) {
    showToast('删除成功', '', 'success');
    loadFileList();
  } else {
    showToast('删除失败', result.error, 'error');
  }
}

async function createNewFolder() {
  const name = await window.AppDialog.prompt({
    title: '新建文件夹',
    message: '请输入文件夹名称：',
    placeholder: '文件夹名称'
  });
  if (!name) return;

  const path = window.api.path.join(state.currentPath || window.api.os.homedir(), name);
  const result = await window.api.createDir({ path });
  if (result.success) {
    showToast('创建成功', '', 'success');
    loadFileList();
  } else {
    showToast('创建失败', result.error, 'error');
  }
}

async function uploadFile() {
  const paths = await window.api.selectFiles();
  if (!paths || paths.length === 0) return;

  showToast('正在上传...', `${paths.length} 个文件`, 'info');

  for (const filePath of paths) {
    const fileName = window.api.path.basename(filePath);
    const destPath = window.api.path.join(state.currentPath || window.api.os.homedir(), fileName);
    await window.api.copyFile({ sourcePath: filePath, destPath });
  }

  showToast('上传完成', `${paths.length} 个文件已上传`, 'success');
  loadFileList();
}

async function searchFiles() {
  const query = document.getElementById('file-search').value.trim();
  if (!query) {
    loadFileList();
    return;
  }
  try {
    const searchPath = state.currentPath || window.api.os.homedir();
    const result = await window.api.searchFiles({ query, path: searchPath });
    if (result.success) {
      state.fileTree = result.data;
      renderFileList(result.data);
      document.getElementById('file-count').textContent = (window.I18N?.t || ((k) => k))('files.itemCount', { count: result.total });
    } else {
      showToast('搜索失败', result.error, 'error');
    }
  } catch (err) {
    showToast('搜索失败', err.message, 'error');
  }
}

// ==================== 命令终端 ====================
async function executeCommand() {
  const input = document.getElementById('terminal-input');
  const cmd = input.value.trim();
  if (!cmd) return;

  input.value = '';

  appendTerminalLine('cmd', `❯ ${cmd}`);

  try {
    const result = await window.api.executeCommand({ command: cmd });

    if (result.stdout) appendTerminalLine('output', result.stdout);
    if (result.stderr) appendTerminalLine('error', result.stderr);

    if (result.timedOut) {
      appendTerminalLine('error', '[命令执行超时]');
    }

    addToHistory(cmd);
  } catch (err) {
    appendTerminalLine('error', err.message);
  }
}

function appendTerminalLine(type, text) {
  const container = document.getElementById('terminal-output');
  const line = document.createElement('div');
  line.className = `terminal-line ${type}`;
  line.textContent = text;
  container.appendChild(line);
  container.scrollTop = container.scrollHeight;
}

function addToHistory(cmd) {
  if (state.commandHistory.includes(cmd)) return;
  state.commandHistory.unshift(cmd);
  if (state.commandHistory.length > 20) state.commandHistory.pop();
  renderHistory();
}

function renderHistory() {
  const list = document.getElementById('history-list');
  list.innerHTML = '';
  state.commandHistory.forEach(cmd => {
    const item = document.createElement('div');
    item.className = 'history-item';
    item.textContent = cmd;
    item.addEventListener('click', () => {
      document.getElementById('terminal-input').value = cmd;
    });
    list.appendChild(item);
  });
}

// ==================== 软件管理 ====================
let _softwareLoading = false; // 防重复点击标志
async function loadSoftwareList(forceRefresh = false) {
  // ★ 防重复点击：加载期间禁用刷新按钮，避免多次扫描导致系统卡顿
  if (_softwareLoading) return;
  _softwareLoading = true;
  const refreshBtn = document.getElementById('btn-refresh-software');
  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.style.opacity = '0.5';
    refreshBtn.style.cursor = 'not-allowed';
  }

  try {
    showToast('正在加载软件列表...', '', 'info');
    const result = await window.api.listInstalled(forceRefresh);

    if (result.success) {
      state.softwareList = result.data;
      renderSoftwareList(result.data);
      document.getElementById('software-count').textContent = `${result.total} 个软件`;
      showToast('加载完成', `${result.total} 个已安装软件`, 'success');
    } else {
      showToast('加载失败', result.error, 'error');
    }
  } finally {
    _softwareLoading = false;
    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.style.opacity = '';
      refreshBtn.style.cursor = '';
    }
  }
}

function renderSoftwareList(software) {
  const listEl = document.getElementById('software-list');
  listEl.innerHTML = '';

  if (software.length === 0) {
    listEl.appendChild(createSoftwareEmptyState());
    return;
  }

  // ★ 优化：使用 DocumentFragment 批量添加 DOM 节点，减少重排次数
  // 原实现逐个 appendChild，软件多时会触发多次重排导致 UI 卡顿
  const fragment = document.createDocumentFragment();
  const defaultIcon = '<svg viewBox="0 0 1024 1024" width="1em" height="1em" fill="currentColor"><path d="M832 64H192c-35.3 0-64 28.7-64 64v768c0 35.3 28.7 64 64 64h640c35.3 0 64-28.7 64-64V128c0-35.3-28.7-64-64-64z m0 832H192V128h640v768z M480 384h64c17.7 0 32-14.3 32-32s-14.3-32-32-32h-64c-17.7 0-32 14.3-32 32s14.3 32 32 32z M480 544h64c17.7 0 32-14.3 32-32s-14.3-32-32-32h-64c-17.7 0-32 14.3-32 32s14.3 32 32 32z M480 704h64c17.7 0 32-14.3 32-32s-14.3-32-32-32h-64c-17.7 0-32 14.3-32 32s14.3 32 32 32z"/></svg>';
  const iconSvg = (window.ElIcons && window.ElIcons.ICONS && window.ElIcons.ICONS.archive) || defaultIcon;

  for (const sw of software) {
    if (!sw.name) continue;
    const item = document.createElement('div');
    item.className = 'software-item';
    item.innerHTML = `
      <div class="sw-icon"><span class="el-icon">${iconSvg}</span></div>
      <div class="sw-info">
        <div class="sw-name">${escapeHtml(sw.name)}</div>
        <div class="sw-meta">
          ${sw.version ? `<span class="sw-meta-tag">v${escapeHtml(sw.version)}</span>` : ''}
          ${sw.publisher ? `<span class="sw-meta-tag">${escapeHtml(sw.publisher)}</span>` : ''}
          ${sw.installLocation ? `<span class="sw-meta-tag location" title="${escapeHtml(sw.installLocation)}">${escapeHtml(sw.installLocation)}</span>` : ''}
        </div>
      </div>
      <div class="sw-actions">
        <button class="btn btn-sm btn-danger">卸载</button>
      </div>
    `;
    item.querySelector('.btn-danger').addEventListener('click', () => uninstallSoftware(sw));
    fragment.appendChild(item);
  }
  listEl.appendChild(fragment);
}

function filterSoftware() {
  const query = document.getElementById('software-search').value.trim().toLowerCase();
  if (!query) {
    renderSoftwareList(state.softwareList);
    return;
  }
  const filtered = state.softwareList.filter(sw =>
    sw.name && sw.name.toLowerCase().includes(query)
  );
  renderSoftwareList(filtered);
}

async function installSoftware() {
  const paths = await window.api.selectFiles({
    filters: [
      { name: '安装包', extensions: ['exe', 'msi', 'dmg', 'pkg', 'deb', 'rpm', 'AppImage'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (!paths || paths.length === 0) return;

  const confirmed = await showConfirm({
    type: 'warning',
    title: '安装软件',
    message: `即将安装：${window.api.path.basename(paths[0])}`,
    detail: '安装过程可能需要管理员权限，请耐心等待。'
  });
  if (!confirmed) return;

  showToast('正在安装...', paths[0], 'info');
  const result = await window.api.installSoftware({ sourcePath: paths[0] });

  if (result.success) {
    showToast('安装完成', '', 'success');
    loadSoftwareList();
  } else {
    showToast('安装失败', result.error, 'error');
  }
}

async function uninstallSoftware(sw) {
  const confirmed = await showConfirm({
    type: 'warning',
    title: '卸载软件',
    message: `确定要卸载「${sw.name}」吗？`,
    detail: '此操作将删除软件及其相关文件，部分配置可能保留。'
  });
  if (!confirmed) return;

  showToast('正在卸载...', sw.name, 'info');
  const result = await window.api.uninstallSoftware({ name: sw.name });

  if (result.success) {
    showToast('卸载完成', '', 'success');
    loadSoftwareList();
  } else {
    showToast('卸载失败', result.error, 'error');
  }
}

// ==================== AI 配置 ====================
function loadCloudProviders() {
  state.cloudProviders = state.settings.ai?.cloudProviders || [];
  state.activeProviderId = state.settings.ai?.activeProvider || null;
}

function loadLocalModels() {
  state.localModels = state.settings.ai?.localModels || [];
}

// 将渲染进程的 cloudProviders / localModels 同步到 state.settings.ai，
// 防止后续 setConfig 调用使用旧数据覆盖主进程中已更新的提供商列表
function syncAISettings() {
  if (!state.settings.ai) state.settings.ai = {};
  state.settings.ai.cloudProviders = state.cloudProviders;
  state.settings.ai.localModels = state.localModels;
  state.settings.ai.activeProvider = state.activeProviderId;
}

// 构建完整的 AI 配置对象（始终包含最新的提供商和模型列表）
function buildAIConfig(overrides = {}) {
  if (!state.settings.ai) state.settings.ai = {};
  return {
    ...state.settings.ai,
    cloudProviders: state.cloudProviders,
    localModels: state.localModels,
    activeProvider: state.activeProviderId,
    ...overrides
  };
}

function renderAIConfig() {
  renderLocalModels();
  renderCloudProviders();
  renderAISettings();
  refreshLocalEngineStatus();   // 异步补一个"本地服务是否在跑"的实时状态
}

// 本地推理服务的运行状态（用于列表顶部提示 + 停止按钮）
async function refreshLocalEngineStatus() {
  try {
    state.localEngine = await window.api.getLocalEngineStatus();
  } catch (e) {
    state.localEngine = { running: false };
  }
  renderLocalModels();
}

function renderLocalModels() {
  const listEl = document.getElementById('local-models-list');
  listEl.innerHTML = '';

  // 顶部：由本应用启动的本地服务正在跑 → 给个明显的状态 + 停止入口
  const eng = state.localEngine;
  if (eng && eng.running) {
    const bar = document.createElement('div');
    bar.className = 'local-engine-bar';
    const txt = document.createElement('span');
    txt.textContent = (eng.managed ? '本地服务运行中' : '复用本机运行中的服务') +
      '（端口 ' + eng.port + (eng.modelId ? '，模型 ' + eng.modelId : '') + '）';
    bar.appendChild(txt);
    if (eng.managed) {
      const stopBtn = document.createElement('button');
      stopBtn.className = 'btn btn-sm';
      stopBtn.textContent = '停止';
      stopBtn.title = '停止由浮灵饰界启动的本地推理服务，释放显存';
      stopBtn.addEventListener('click', async () => {
        const r = await window.api.stopLocalModel();
        showToast(r.stopped ? '已停止本地服务' : '无需停止', r.message || '', r.stopped ? 'success' : 'info');
        refreshLocalEngineStatus();
      });
      bar.appendChild(stopBtn);
    }
    listEl.appendChild(bar);
  }

  if (state.localModels.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state-sm">
        <div class="empty-text">未添加本地模型</div>
        <div class="empty-hint">本地直接可跑的是 GGUF / GGML（经 llama.cpp）；Safetensors / ONNX 需先转换</div>
      </div>
    `;
    return;
  }

  state.localModels.forEach(model => {
    const runnable = model.runnable !== false;   // 老数据没有该字段时按可用来试
    const isCurrent = state.activeProviderId === localProviderIdOf(model.id);
    const item = document.createElement('div');
    item.className = 'config-item' + (isCurrent ? ' provider-active' : '');
    item.innerHTML = `
      <div class="config-item-info">
        <div class="config-item-name"></div>
        <div class="config-item-meta">
          <span>${escapeHtml(String(model.format || '').toUpperCase())}</span>
          <span>${escapeHtml(model.sizeFormatted || '')}</span>
          ${runnable ? '' : '<span class="local-badge warn">需转 GGUF</span>'}
          ${isCurrent ? '<span class="local-badge ok">当前模型</span>' : ''}
        </div>
        ${runnable ? '' : '<div class="local-model-tip">Safetensors / ONNX 本机没有可直接加载的运行时；请转成 GGUF 后重新导入，或改用 Ollama。</div>'}
      </div>
      <div class="config-item-actions"></div>
    `;
    item.querySelector('.config-item-name').textContent = model.name || '(未命名)';

    const actions = item.querySelector('.config-item-actions');
    if (runnable) {
      const useBtn = document.createElement('button');
      useBtn.className = 'btn btn-sm ' + (isCurrent ? '' : 'btn-primary');
      useBtn.textContent = isCurrent ? '重新加载' : '使用';
      useBtn.title = isCurrent ? '重启本地服务并重新加载该模型' : '启动本地推理服务并切换为当前模型';
      useBtn.addEventListener('click', () => useLocalModel(model, useBtn));
      actions.appendChild(useBtn);
    }
    // 非 GGUF 的 HuggingFace/safetensors 模型：提供一键转换
    if (!runnable && (model.format === 'huggingface' || model.format === 'safetensors')) {
      const convBtn = document.createElement('button');
      convBtn.className = 'btn btn-sm';
      convBtn.textContent = '转GGUF';
      convBtn.title = '自动调用 llama.cpp convert_hf_to_gguf.py 转换为 GGUF（需 Python + torch + transformers）';
      convBtn.addEventListener('click', () => promptModelConversion(model, convBtn));
      actions.appendChild(convBtn);
    }
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-sm btn-danger';
    delBtn.textContent = '删除';
    delBtn.addEventListener('click', async () => {
      const result = await window.api.deleteLocalModel(model.id);
      if (result.success) {
        state.localModels = state.localModels.filter(m => m.id !== model.id);
        syncAISettings();
        renderLocalModels();
        showToast('删除成功', '', 'success');
      }
    });
    actions.appendChild(delBtn);
    listEl.appendChild(item);
  });
}


// 本地推理工具管理面板
async function renderTools() {
  const listEl = document.getElementById('tools-list');
  if (!listEl) return;
  try {
    const tools = await window.api.checkTools();
    const items = [];

    // llama-server
    const ls = tools.llamaServer;
    items.push({
      name: 'llama.cpp 工具包',
      desc: 'llama-server 推理服务 + llama-quantize 显存量化优化 + llama-cli 命令行',
      installed: ls.installed,
      path: ls.path,
      extra: [ls.hasQuantize ? '含量化工具' : '', ls.hasCli ? '含CLI' : ''].filter(Boolean).join(' · '),
      tool: 'llama-server',
    });

    // convert script
    const cs = tools.convertScript;
    items.push({
      name: 'convert_hf_to_gguf.py',
      desc: 'HuggingFace 模型 → GGUF 格式转换脚本（需 Python + torch + transformers）',
      installed: cs.installed,
      path: cs.path,
      extra: '',
      tool: 'convert-script',
    });

    // Python
    const py = tools.python;
    items.push({
      name: 'Python 环境',
      desc: py.available ? (py.version + (py.hasDeps ? ' · torch/transformers 已安装' : ' · 缺少 torch/transformers')) : '未检测到 Python 3',
      installed: py.available && py.hasDeps,
      path: py.available ? py.command : '',
      extra: py.available && !py.hasDeps ? 'pip install torch transformers sentencepiece protobuf' : '',
      tool: null,
    });

    // 顶部：镜像源测速按钮
    const testBar = document.createElement('div');
    testBar.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:12px;padding:8px 12px;background:var(--bg-tertiary);border-radius:8px;';
    testBar.innerHTML = '<span style="font-size:12px;color:var(--text-secondary);">下载源：</span>';
    const testBtn = document.createElement('button');
    testBtn.className = 'btn btn-sm';
    testBtn.textContent = '测速选最优';
    const testResult = document.createElement('span');
    testResult.style.cssText = 'font-size:11px;color:var(--text-secondary);';
    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      testBtn.textContent = '测速中...';
      testResult.textContent = '';
      try {
        const urls = [
          'https://raw.gitmirror.com/ggerganov/llama.cpp/master/convert_hf_to_gguf.py',
          'https://ghproxy.com/https://raw.githubusercontent.com/ggerganov/llama.cpp/master/convert_hf_to_gguf.py',
          'https://mirror.ghproxy.com/https://raw.githubusercontent.com/ggerganov/llama.cpp/master/convert_hf_to_gguf.py',
          'https://raw.githubusercontent.com/ggerganov/llama.cpp/master/convert_hf_to_gguf.py',
        ];
        const results = await window.api.testMirrors(urls);
        const ok = results.filter(r => r.ok);
        if (ok.length > 0) {
          const fastest = ok.sort((a,b) => a.latency - b.latency)[0];
          const host = new URL(fastest.url).hostname;
          testResult.innerHTML = '<span style="color:var(--success);">最快: ' + host + ' (' + fastest.latency + 'ms)</span> · 可用 ' + ok.length + '/' + results.length;
        } else {
          testResult.innerHTML = '<span style="color:var(--danger);">全部不可用，请检查网络</span>';
        }
      } catch (e) {
        testResult.textContent = '测速失败: ' + (e.message || e);
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = '测速选最优';
      }
    });
    testBar.appendChild(testBtn);
    testBar.appendChild(testResult);

    listEl.innerHTML = '';
    listEl.appendChild(testBar);
    for (const item of items) {
      const div = document.createElement('div');
      div.className = 'config-item';
      div.innerHTML = `
        <div class="config-item-info">
          <div class="config-item-name">${escapeHtml(item.name)}</div>
          <div class="config-item-meta">
            <span class="local-badge ${item.installed ? 'ok' : 'warn'}">${item.installed ? '已安装' : '未安装'}</span>
            ${item.extra ? '<span>' + escapeHtml(item.extra) + '</span>' : ''}
          </div>
          ${item.path ? '<div style="font-size:11px;color:var(--text-secondary);margin-top:4px;word-break:break-all;">' + escapeHtml(item.path) + '</div>' : ''}
          <div style="font-size:11px;color:var(--text-secondary);margin-top:2px;">${escapeHtml(item.desc)}</div>
        </div>
        <div class="config-item-actions"></div>
      `;
      const actions = div.querySelector('.config-item-actions');
      if (item.tool) {
        const btn = document.createElement('button');
        btn.className = 'btn btn-sm ' + (item.installed ? '' : 'btn-primary');
        btn.textContent = item.installed ? '重新下载' : '下载';
        btn.addEventListener('click', async () => {
          const dl = await promptAndDownloadTool(item.tool, { defaultDir: tools.installDir || '' });
          if (dl.success) renderTools();
        });
        actions.appendChild(btn);
      }
      listEl.appendChild(div);
    }
  } catch (e) {
    listEl.innerHTML = '<div class="empty-state-sm"><div class="empty-text">检测失败: ' + escapeHtml(String(e.message || e)) + '</div></div>';
  }
}
// provider id 规则与主进程一致（local-<uuid>），用来判断哪个本地模型正在被使用
function localProviderIdOf(modelId) {
  const p = (state.cloudProviders || []).find(x => x.local && x.modelId === modelId);
  return p ? p.id : null;
}



// 模型转换弹窗：显示 Python 环境状态、依赖、转换进度
async function promptModelConversion(model, triggerBtn) {
  if (triggerBtn) { triggerBtn.disabled = true; }

  const body = `
    <div style="padding: 8px 0;">
      <p style="margin:0 0 12px;color:var(--text-secondary);line-height:1.6;">将 <strong style="color:var(--text-primary);">${escapeHtml(model.name)}</strong> 转换为 GGUF 格式</p>
      <div id="conv-env-status" style="margin-bottom:16px;">
        <div style="font-size:12px;color:var(--text-secondary);">正在检测 Python 环境...</div>
      </div>
      <div id="conv-progress" style="display:none;margin-top:8px;">
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-secondary);margin-bottom:4px;">
          <span id="conv-progress-text">准备中...</span>
          <span id="conv-progress-pct"></span>
        </div>
        <div style="height:6px;background:var(--bg-tertiary);border-radius:3px;overflow:hidden;">
          <div id="conv-progress-bar" style="height:100%;width:0%;background:var(--accent);transition:width 0.3s;"></div>
        </div>
      </div>
    </div>
  `;
  const footer = `
    <button class="btn" id="conv-cancel-btn">取消</button>
    <button class="btn btn-primary" id="conv-start-btn" disabled>开始转换</button>
  `;
  showModal({ title: '转换模型为 GGUF', body, footer });

  const envStatus = document.getElementById('conv-env-status');
  const progressWrap = document.getElementById('conv-progress');
  const progressText = document.getElementById('conv-progress-text');
  const progressPct = document.getElementById('conv-progress-pct');
  const progressBar = document.getElementById('conv-progress-bar');
  const startBtn = document.getElementById('conv-start-btn');
  const cancelBtn = document.getElementById('conv-cancel-btn');

  let pyInfo = null;
  let canConvert = false;

  // 异步检测 Python（不阻塞 UI）
  try {
    pyInfo = await window.api.detectPython();
  } catch (e) {
    pyInfo = { available: false };
  }

  if (!pyInfo.available) {
    envStatus.innerHTML = `
      <div style="background:rgba(255,82,82,0.1);border:1px solid rgba(255,82,82,0.3);border-radius:6px;padding:10px 14px;">
        <div style="color:#ff5252;font-weight:500;margin-bottom:4px;">未检测到 Python 3</div>
        <div style="font-size:12px;color:var(--text-secondary);line-height:1.5;">请先安装 Python 3.10+，然后在终端运行：<br><code style="background:var(--bg-primary);padding:2px 6px;border-radius:3px;">pip install torch transformers sentencepiece protobuf</code></div>
      </div>`;
    startBtn.disabled = true;
    startBtn.textContent = '需要 Python';
  } else if (!pyInfo.hasDeps) {
    envStatus.innerHTML = `
      <div style="background:rgba(255,152,0,0.1);border:1px solid rgba(255,152,0,0.3);border-radius:6px;padding:10px 14px;">
        <div style="color:#ff9800;font-weight:500;margin-bottom:4px;">${escapeHtml(pyInfo.version || 'Python 3')} 已安装，但缺少依赖</div>
        <div style="font-size:12px;color:var(--text-secondary);line-height:1.5;">请在终端运行：<br><code style="background:var(--bg-primary);padding:2px 6px;border-radius:3px;word-break:break-all;">pip install torch transformers sentencepiece protobuf</code></div>
      </div>`;
    startBtn.disabled = true;
    startBtn.textContent = '缺少依赖';
  } else {
    envStatus.innerHTML = `
      <div style="background:rgba(76,175,80,0.1);border:1px solid rgba(76,175,80,0.3);border-radius:6px;padding:10px 14px;">
        <div style="color:#4caf50;font-weight:500;">环境就绪</div>
        <div style="font-size:12px;color:var(--text-secondary);margin-top:2px;">${escapeHtml(pyInfo.version || '')} · torch / transformers 已安装</div>
      </div>`;
    canConvert = true;
    startBtn.disabled = false;
  }

  cancelBtn.addEventListener('click', () => {
    closeModal();
    if (triggerBtn) triggerBtn.disabled = false;
  });
  // X 按钮也能关闭（全局 modal-close 监听可能被覆盖，这里直接绑定）
  const xBtn1 = document.getElementById('modal-close');
  if (xBtn1) xBtn1.addEventListener('click', () => { closeModal(); if (triggerBtn) triggerBtn.disabled = false; }, { once: true });

  startBtn.addEventListener('click', async () => {
    if (!canConvert) return;
    startBtn.disabled = true;
    cancelBtn.disabled = true;
    progressWrap.style.display = 'block';
    progressText.textContent = '正在转换（大模型可能需要几分钟）...';

    // 监听转换进度（后端通过 IPC 事件推送）
    const off = window.api.onToolDownloadProgress ? window.api.onToolDownloadProgress((p) => {
      progressText.textContent = p.message || p.phase || '转换中...';
      if (p.percent >= 0) {
        progressPct.textContent = p.percent + '%';
        progressBar.style.width = p.percent + '%';
      }
    }) : null;

    try {
      const r = await window.api.convertModelToGguf(model.id);
      if (r.success) {
        progressText.textContent = '转换完成';
        progressBar.style.width = '100%';
        progressPct.textContent = '100%';
        setTimeout(async () => {
          closeModal();
          showToast('转换完成', '已生成 GGUF 文件，可直接使用', 'success');
          state.localModels = await window.api.listLocalModels();
          renderLocalModels();
        }, 800);
      } else {
        progressText.textContent = '转换失败';
        startBtn.disabled = false;
        cancelBtn.disabled = false;
        startBtn.textContent = '重试';
        envStatus.innerHTML += `<div style="margin-top:10px;color:#ff5252;font-size:12px;word-break:break-all;">${escapeHtml(r.error || '未知错误')}</div>`;
      }
    } catch (e) {
      progressText.textContent = '转换失败';
      startBtn.disabled = false;
      cancelBtn.disabled = false;
      envStatus.innerHTML += `<div style="margin-top:10px;color:#ff5252;font-size:12px;">${escapeHtml(String(e.message || e))}</div>`;
    } finally {
      if (off) off();
      if (triggerBtn) triggerBtn.disabled = false;
    }
  });
}
// 工具下载确认弹窗：用户同意 + 自选目录 + 进度显示
async function promptAndDownloadTool(tool, options = {}) {
  const toolNames = {
    'llama-server': 'llama.cpp 工具包（llama-server 推理服务 + llama-quantize 显存优化 + llama-cli）',
    'convert-script': 'convert_hf_to_gguf.py 转换脚本',
  };
  const toolName = toolNames[tool] || tool;
  let chosenDir = options.defaultDir || '';

  return new Promise((resolve) => {
    const body = `
      <div style="padding: 8px 0;">
        <p style="margin:0 0 12px;color:var(--text-secondary);line-height:1.6;">需要下载以下工具才能继续：</p>
        <div style="background:var(--bg-tertiary);border:1px solid var(--border);border-radius:6px;padding:10px 14px;margin-bottom:16px;">
          <strong style="color:var(--accent);">${escapeHtml(toolName)}</strong>
        </div>
        <div style="margin-bottom:12px;">
          <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:6px;">安装目录</label>
          <div style="display:flex;gap:8px;align-items:center;">
            <input type="text" id="tool-install-dir" readonly value="${escapeHtml(chosenDir)}"
              style="flex:1;background:var(--bg-primary);border:1px solid var(--border);border-radius:4px;padding:6px 10px;color:var(--text-primary);font-size:12px;" />
            <button class="btn btn-sm" id="tool-choose-dir">浏览...</button>
          </div>
        </div>
        <div id="tool-download-progress" style="display:none;margin-top:8px;">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-secondary);margin-bottom:4px;">
            <span id="tool-progress-text">准备中...</span>
            <span id="tool-progress-pct"></span>
          </div>
          <div style="height:6px;background:var(--bg-tertiary);border-radius:3px;overflow:hidden;">
            <div id="tool-progress-bar" style="height:100%;width:0%;background:var(--accent);transition:width 0.3s;"></div>
          </div>
        </div>
      </div>
    `;
    const footer = `
      <button class="btn" id="tool-cancel-btn">取消</button>
      <button class="btn btn-primary" id="tool-download-btn">确认下载</button>
    `;
    showModal({ title: '下载工具', body, footer });

    const dirInput = document.getElementById('tool-install-dir');
    const chooseBtn = document.getElementById('tool-choose-dir');
    const dlBtn = document.getElementById('tool-download-btn');
    const cancelBtn = document.getElementById('tool-cancel-btn');
    const progressWrap = document.getElementById('tool-download-progress');
    const progressText = document.getElementById('tool-progress-text');
    const progressPct = document.getElementById('tool-progress-pct');
    const progressBar = document.getElementById('tool-progress-bar');

    chooseBtn.addEventListener('click', async () => {
      const dirs = await window.api.selectDirectory();
      if (dirs && dirs.length > 0) { chosenDir = dirs[0]; dirInput.value = chosenDir; }
    });

    cancelBtn.addEventListener('click', () => { closeModal(); resolve({ cancelled: true }); });
    const xBtn2 = document.getElementById('modal-close');
    if (xBtn2) xBtn2.addEventListener('click', () => { closeModal(); resolve({ cancelled: true }); }, { once: true });

    dlBtn.addEventListener('click', async () => {
      if (!chosenDir) { showToast('请选择安装目录', '', 'warning'); return; }
      dlBtn.disabled = true; chooseBtn.disabled = true; cancelBtn.disabled = true;
      progressWrap.style.display = 'block';
      progressText.textContent = '正在下载...';

      const off = window.api.onToolDownloadProgress((p) => {
        progressText.textContent = p.message || p.phase;
        if (p.percent >= 0) {
          progressPct.textContent = p.percent + '%';
          progressBar.style.width = p.percent + '%';
        }
      });

      try {
        const r = await window.api.downloadTool(tool, chosenDir);
        progressText.textContent = '下载完成';
        progressBar.style.width = '100%';
        progressPct.textContent = '100%';
        setTimeout(() => { closeModal(); resolve({ success: true, path: r.path, installDir: chosenDir }); }, 800);
      } catch (e) {
        progressText.textContent = '下载失败: ' + (e.message || e);
        dlBtn.disabled = false; chooseBtn.disabled = false; cancelBtn.disabled = false;
      } finally {
        if (off) off();
      }
    });
  });
}
// 让本地模型真正跑起来：主进程会复用已在运行的本地服务，或拉起 llama-server
async function useLocalModel(model, btn) {
  const original = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '加载中…'; }
  showToast('正在加载本地模型', model.name + '（首次加载可能需要几十秒）', 'info');
  try {
    let r = await window.api.useLocalModel(model.id);
    // 工具缺失：弹窗让用户确认下载 + 选择目录，完成后重试
    if (!r.success && r.toolMissing) {
      const tools = await window.api.checkTools();
      const dl = await promptAndDownloadTool(r.tool || 'llama-server', { defaultDir: tools.installDir || '' });
      if (dl.cancelled || !dl.success) { return; }
      showToast('工具安装完成', '正在重新加载模型...', 'info');
      r = await window.api.useLocalModel(model.id);
    }
    if (!r.success) {
      try {
        await window.api.showError('本地模型无法使用', r.error || '未知错误', r.hint || '');
      } catch (e) {
        showToast('本地模型无法使用', (r.error || '') + (r.hint ? ' ' + r.hint : ''), 'error', { duration: 12000 });
      }
      return;
    }
    await reloadProvidersAndActive();
    renderLocalModels();
    renderCloudProviders();
    showToast('已切换为本地模型', r.message || '', 'success');
  } catch (e) {
    showToast('本地模型启动失败', String(e && e.message || e), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = original; }
  }
}

// 主进程改了 activeProvider / 新增 provider 之后，把渲染层状态和下拉同步过来
async function reloadProvidersAndActive() {
  try {
    const [providers, status] = await Promise.all([
      window.api.listCloudProviders(),
      window.api.getAIStatus()
    ]);
    state.cloudProviders = providers || [];
    syncAISettings();
    if (status && status.activeProvider) {
      state.activeProviderId = status.activeProvider;
      const sel = document.getElementById('chat-provider');
      if (sel) {
        if (!Array.from(sel.options).some(o => o.value === state.activeProviderId)) {
          const opt = document.createElement('option');
          opt.value = state.activeProviderId;
          opt.textContent = (state.cloudProviders.find(p => p.id === state.activeProviderId) || {}).name || '本地模型';
          sel.appendChild(opt);
        }
        sel.value = state.activeProviderId;
        if (window.CustomSelect) window.CustomSelect.sync(sel);
      }
    }
    if (typeof updateActiveProviderDisplay === 'function') updateActiveProviderDisplay();
    if (typeof updateProviderIconDisplay === 'function') updateProviderIconDisplay();
  } catch (e) {
    console.warn('刷新提供商状态失败:', e);
  }
}

function renderCloudProviders() {
  const listEl = document.getElementById('cloud-providers-list');
  listEl.innerHTML = '';

  if (state.cloudProviders.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state-sm">
        <div class="empty-text">未配置AI模型服务</div>
        <div class="empty-hint">支持任何兼容OpenAI API的服务</div>
      </div>
    `;
    return;
  }

  state.cloudProviders.forEach(provider => {
    const item = document.createElement('div');
    // ★ 当前活跃的提供商添加高亮样式
    const isActive = provider.enabled && provider.id === state.activeProviderId;
    item.className = 'config-item' + (isActive ? ' provider-active' : '');
    const meta = PROVIDER_TYPES.find(p => p.value === provider.type) || { label: 'OpenAI兼容', icon: 'cloud' };
    const typeLabel = meta.label || 'OpenAI兼容';
    // 使用 LobeHub 图标自动识别
    const iconId = window.ModelIcons ? window.ModelIcons.detectProviderIcon(provider) : 'default';
    const typeIcon = window.ModelIcons ? window.ModelIcons.renderIconHtml(iconId, 'config-type-icon', '28px') : window.ElIcons.getIcon(meta.icon || 'cloud');
    item.innerHTML = `
      <div class="config-toggle ${provider.enabled ? 'active' : ''}" data-id="${provider.id}"></div>
      ${typeIcon}
      <div class="config-item-info" data-action="set-active" data-id="${provider.id}" style="cursor:pointer;flex:1;">
        <div class="config-item-name">${escapeHtml(provider.name)}${isActive ? ' <span class="active-badge">当前使用</span>' : ''}</div>
        <div class="config-item-meta">
          <span class="provider-type-badge">${typeLabel}</span>
          <span>${escapeHtml(provider.model)}</span>
          <span>${escapeHtml(provider.apiUrl)}</span>
        </div>
      </div>
      <button class="btn btn-sm">编辑</button>
      <button class="btn btn-sm btn-danger">删除</button>
    `;
    // 异步加载真实 SVG 图标
    if (window.ModelIcons) window.ModelIcons.updateIconsInContainer(item);

    // ★ 点击提供商信息区域切换为活跃模型（仅已启用的提供商）—— 与开关走同一个入口
    const infoEl = item.querySelector('.config-item-info');
    if (infoEl) {
      infoEl.addEventListener('click', async (e) => {
        // 避免点击编辑/删除按钮时触发
        if (e.target.closest('button')) return;
        const switched = await setActiveProvider(infoEl.dataset.id);
        if (switched) {
          // 重建列表以刷新高亮与「当前使用」徽标（setActiveProvider 不重建 DOM）
          renderCloudProviders();
          renderAISettings();
        }
      });
    }

    item.querySelector('.config-toggle').addEventListener('click', async (e) => {
      const toggle = e.target;
      const id = toggle.dataset.id;
      const provider = state.cloudProviders.find(p => p.id === id);
      if (provider) {
        provider.enabled = !provider.enabled;
        toggle.classList.toggle('active', provider.enabled);
        await window.api.updateCloudProvider({ id, enabled: provider.enabled });
        syncAISettings();
        // ★ 开启即选中：启用某个模型服务后直接把它设为当前使用的模型，无需再选一次
        if (provider.enabled) {
          await setActiveProvider(provider.id);
        } else if (state.activeProviderId === provider.id) {
          // 禁用了当前活跃的提供商，自动切换到其他已启用的
          const next = state.cloudProviders.find(p => p.enabled && p.id !== provider.id);
          await setActiveProvider(next ? next.id : null, {
            toast: next
              ? { title: '当前模型已禁用', message: `已切换到：${next.name}` }
              : { title: '当前模型已禁用', message: '暂无其他已启用的模型' }
          });
        }
        // ★ 重新渲染：列表高亮/「当前使用」徽标 + 参数区（"活跃模型"下拉的 option 列表）
        // （updateActiveProviderDisplay 只设置 value，不重新生成 option 列表）
        renderCloudProviders();
        renderAISettings();
        updateActiveProviderDisplay();
      }
    });

    item.querySelectorAll('button')[0].addEventListener('click', () => editCloudProvider(provider));
    item.querySelectorAll('button')[1].addEventListener('click', async () => {
      const confirmed = await showConfirm({
        type: 'warning',
        title: '删除提供商',
        message: `确定要删除「${provider.name}」吗？`
      });
      if (confirmed) {
        await window.api.deleteCloudProvider(provider.id);
        state.cloudProviders = state.cloudProviders.filter(p => p.id !== provider.id);
        syncAISettings();
        renderCloudProviders();
        updateActiveProviderDisplay();
        showToast('删除成功', '', 'success');
      }
    });

    listEl.appendChild(item);
  });

  updateActiveProviderDisplay();
}

// 根据当前活跃模型类型显示/隐藏 max_tokens 设置项（Ollama 模型不需要设置）
function updateMaxTokensVisibility() {
  const item = document.getElementById('max-tokens-item');
  if (!item) return;
  const provider = state.cloudProviders.find(p => p.id === state.activeProviderId);
  const isOllama = provider && provider.type === 'ollama';
  item.style.display = isOllama ? 'none' : '';
}

function renderAISettings() {
  // ★ 没有已启用的模型时隐藏"参数设置"部分
  const enabledProviders = state.cloudProviders.filter(p => p.enabled);
  const paramsSection = document.getElementById('ai-params-section');
  if (paramsSection) {
    paramsSection.style.display = enabledProviders.length > 0 ? '' : 'none';
  }

  document.getElementById('temperature').value = state.settings.ai?.temperature || 0.7;
  document.getElementById('temperature-value').textContent = document.getElementById('temperature').value;
  document.getElementById('max-tokens').value = state.settings.ai?.maxTokens || 2048;
  // Ollama 模型隐藏 max_tokens 设置项
  updateMaxTokensVisibility();
  // 上下文窗口：0/空 = 按模型名自动识别（无覆盖值时留空显示 placeholder「自动」）
  const ctxWinEl = document.getElementById('context-window');
  if (ctxWinEl) {
    const v = parseInt(state.settings.ai?.contextWindow, 10) || 0;
    ctxWinEl.value = v > 0 ? v : '';
  }
  // 系统提示词已挪到「系统设置 → 功能设置 → 个性化」（2026-10-03），这里不再有输入框

  const select = document.getElementById('active-provider');
  if (select) {
    select.innerHTML = '<option value="">-- 选择 --</option>';
    enabledProviders.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      if (p.id === state.activeProviderId) opt.selected = true;
      select.appendChild(opt);
    });
  }

  updateActiveProviderDisplay();
}

function updateActiveProviderDisplay() {
  const select = document.getElementById('chat-provider');
  if (select) {
    select.innerHTML = '<option value="">选择AI模型...</option>';
    state.cloudProviders.filter(p => p.enabled).forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      if (p.id === state.activeProviderId) opt.selected = true;
      select.appendChild(opt);
    });
  }
  // 更新当前模型图标
  updateProviderIconDisplay();

  // 验证活跃提供商是否存在且已启用
  const activeProvider = state.cloudProviders.find(p => p.id === state.activeProviderId);
  const isConnected = state.activeProviderId && activeProvider && activeProvider.enabled;

  const statusEl = document.getElementById('ai-status');
  const statusText = document.getElementById('ai-status-text');
  const t = window.I18N?.t || ((k) => k);
  if (statusEl && statusText) {
    if (isConnected) {
      statusEl.classList.add('connected');
      statusText.textContent = t('chat.aiConnected');
    } else {
      statusEl.classList.remove('connected');
      statusText.textContent = t('chat.aiNotConnected');
    }
  }

  // 同步 AI 配置页的活跃提供商下拉
  const configSelect = document.getElementById('active-provider');
  if (configSelect) {
    configSelect.value = state.activeProviderId || '';
  }
}

/**
 * 把某个模型服务设为「当前使用」的活跃模型并持久化。
 *
 * 这是「设置活跃模型」的唯一入口。用户**开启**或**新增**一个模型服务，本身就已经表达了
 * "我要用这个模型"的意图，所以直接生效，不需要再去点一次列表行或拉一次下拉框（二次选择）。
 *
 * @param {string|null} providerId 目标提供商 id；传 null / 空串表示清除活跃模型
 * @param {{ toast?: { title: string, message?: string } | null }} [options]
 *        toast 省略 → 默认提示「已切换模型」；传 null → 静默（调用方自己提示）
 * @returns {Promise<boolean>} 是否真的发生了切换
 */
async function setActiveProvider(providerId, options = {}) {
  const target = providerId ? state.cloudProviders.find(p => p.id === providerId) : null;
  // 只有已启用的模型才能成为活跃模型（新增的提供商默认就是启用状态）
  if (providerId && (!target || !target.enabled)) return false;

  const nextId = target ? target.id : null;
  if (nextId === (state.activeProviderId || null)) return false;

  state.activeProviderId = nextId;
  // 持久化到配置（始终带上最新的 cloudProviders / localModels，避免覆盖主进程数据）
  const ai = buildAIConfig({ activeProvider: nextId });
  await window.api.setConfig({ ai });
  state.settings.ai = ai;

  // 同步聊天页选择器 / 状态灯 / 图标 / max_tokens 显隐
  updateActiveProviderDisplay();
  updateMaxTokensVisibility();

  const toast = options.toast === undefined
    ? { title: '已切换模型', message: target ? `当前使用：${target.name}` : '' }
    : options.toast;
  if (toast && window.showToast) {
    window.showToast(toast.title, toast.message || '', 'success');
  }
  return true;
}


async function addLocalModelDirectory() {
  const dirs = await window.api.selectDirectory();
  if (!dirs || dirs.length === 0) return;

  const dirPath = dirs[0];
  showToast('正在导入模型目录...', dirPath, 'info');

  const name = window.api.path.basename(dirPath);
  const result = await window.api.importLocalModel({ path: dirPath, name });

  if (result.success) {
    if (result.updated) {
      state.localModels = await window.api.listLocalModels();
    } else {
      state.localModels.push(result.data);
    }
    syncAISettings();
    renderLocalModels();
    if (result.warning) {
      showToast('已导入，但无法本地加载', result.warning, 'warning', { duration: 12000 });
    } else {
      const fc = result.data.fileCount || 1;
      showToast('添加成功', `${result.data.name}（${fc > 1 ? fc + '个文件' : '单文件'}）已添加，点「使用」即可加载`, 'success');
    }
  } else {
    showToast('添加失败', result.error, 'error');
  }
}
async function addLocalModel() {
  const paths = await window.api.selectFiles({
    filters: [
      { name: 'AI模型', extensions: ['gguf', 'ggml', 'safetensors', 'bin', 'onnx'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (!paths || paths.length === 0) return;

  const name = window.api.path.basename(paths[0], window.api.path.extname(paths[0]));
  const result = await window.api.importLocalModel({ path: paths[0], name });

  if (result.success) {
    // 重复导入返回的是 updated：别 push 第二条，改成整表刷新
    if (result.updated) {
      state.localModels = await window.api.listLocalModels();
    } else {
      state.localModels.push(result.data);
    }
    syncAISettings();
    renderLocalModels();
    if (result.warning) {
      showToast('已导入，但无法本地加载', result.warning, 'warning', { duration: 9000 });
    } else {
      showToast('添加成功', `${result.data.name} 已添加，点「使用」即可加载为当前模型`, 'success');
    }
  } else {
    showToast('添加失败', result.error, 'error');
  }
}

// 云端提供商类型元数据：兼容任何 OpenAI 兼容接口（腾讯云混元/DeepSeek/智谱/百度千帆/Kimi 等）
// 后端 callProviderAPI 仅区分 ollama 与其余（均按 OpenAI 兼容处理），故这里列出常见厂商便于选择并预填地址
const PROVIDER_TYPES = [
  { value: 'openai',    label: 'OpenAI 兼容（自定义）', icon: 'cloud',   url: 'https://api.openai.com/v1/chat/completions',                              model: 'gpt-4',     hint: '腾讯云混元、DeepSeek、智谱、百度千帆、Kimi、Groq 等任何 OpenAI 兼容接口，均选此项' },
  { value: 'ollama',    label: 'Ollama 本地',          icon: 'ollama',  url: 'http://localhost:11434',                                                    model: 'llama3',    hint: '本地大模型服务，无需 API Key' },
  { value: 'dashscope', label: '阿里云百炼',           icon: 'bailian', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',       model: 'qwen-plus', hint: '' },
  { value: 'tencent',   label: '腾讯云混元',           icon: 'cloud',   url: 'https://api.hunyuan.cloud.tencent.com/v1/chat/completions',                model: 'hunyuan-pro', hint: '' },
  { value: 'tencentmaas', label: '腾讯云 TokenHub',    icon: 'cloud',   url: 'https://tokenhub.tencentmaas.com/v1/chat/completions',                     model: 'hy3',        hint: '腾讯云 TokenHub MaaS 网关（OpenAI 兼容），需填写 TokenHub 的 API Key 与模型名；模型名以 TokenHub 控制台为准（如 hy3）' },
  { value: 'deepseek',  label: 'DeepSeek',             icon: 'cloud',   url: 'https://api.deepseek.com/v1/chat/completions',                            model: 'deepseek-chat', hint: '' },
  { value: 'zhipu',     label: '智谱 GLM',             icon: 'cloud',   url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',                   model: 'glm-4',     hint: '' },
  { value: 'baidu',     label: '百度千帆',             icon: 'cloud',   url: 'https://qianfan.baidubce.com/v2/chat/completions',                        model: 'ernie-4.0-8k', hint: '' },
  { value: 'moonshot',  label: '月之暗面 Kimi',        icon: 'cloud',   url: 'https://api.moonshot.cn/v1/chat/completions',                             model: 'moonshot-v1-8k', hint: '' }
];

function providerTypeOptions(currentType) {
  return PROVIDER_TYPES.map(p =>
    `<option value="${p.value}" ${p.value === currentType ? 'selected' : ''}>${p.label}</option>`
  ).join('');
}


// 从 API 获取可用模型列表并填充到模型输入框（下拉选择）
async function fetchAndFillModels(modelInput, provider) {
  if (!modelInput || !provider) return;
  const btn = document.getElementById('btn-fetch-models');
  if (btn) { btn.textContent = '获取中...'; btn.disabled = true; }
  try {
    const result = await window.api.fetchProviderModels(provider);
    if (result.success && result.models && result.models.length > 0) {
      // 创建临时下拉选择
      const select = document.createElement('select');
      select.style.cssText = 'position:absolute;top:100%;left:0;right:0;z-index:10001;background:var(--bg-primary,#1e1e2e);border:1px solid var(--border-color,#444);border-radius:6px;color:#fff;font-size:13px;max-height:200px;overflow-y:auto;';
      result.models.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m; opt.textContent = m;
        select.appendChild(opt);
      });
      modelInput.parentElement.style.position = 'relative';
      modelInput.parentElement.appendChild(select);
      select.focus();
      select.addEventListener('change', () => { modelInput.value = select.value; select.remove(); });
      select.addEventListener('blur', () => { setTimeout(() => select.remove(), 200); });
      showToast('获取成功', `找到 ${result.models.length} 个模型`, 'success');
    } else {
      showToast('获取失败', result.error || '未找到模型', 'warning');
    }
  } catch (e) {
    showToast('获取失败', e.message, 'error');
  } finally {
    if (btn) { btn.textContent = '获取模型'; btn.disabled = false; }
  }
}

// 选择厂商后预填 API 地址与默认模型（URL 为空或匹配旧默认地址时更新；模型始终更新为新厂商默认值）
function wireProviderTypeSelect() {
  const sel = document.getElementById('input-type');
  if (!sel) return;
  sel.addEventListener('change', () => {
    const meta = PROVIDER_TYPES.find(p => p.value === sel.value);
    if (!meta) return;
    const urlEl = document.getElementById('input-url');
    const modelEl = document.getElementById('input-model');
    if (urlEl) {
      const cur = urlEl.value.trim();
      // URL 为空，或当前 URL 是某个厂商的默认地址时，自动更新为新厂商地址
      const isDefaultUrl = !cur || PROVIDER_TYPES.some(p => p.url === cur);
      if (isDefaultUrl) urlEl.value = meta.url;
    }
    // 默认模型始终跟随厂商类型更新
    if (modelEl) modelEl.value = meta.model;
  });
}

async function addCloudProvider() {
  showModal({
    title: '添加AI模型提供商',
    body: `
      <div class="modal-form-group">
        <label>提供商类型</label>
        <select id="input-type" data-search="true">
          ${providerTypeOptions()}
        </select>
        <div class="modal-form-hint">腾讯云混元、DeepSeek、智谱、百度千帆、Kimi 等任何 OpenAI 兼容接口均可添加，选择对应厂商会自动预填地址</div>
      </div>
      <div class="modal-form-group" style="display:flex;align-items:center;gap:16px;">
        <div class="model-icon-preview" id="provider-icon-preview">
          <span data-icon-id="default" style="width:32px;height:32px;display:inline-flex;color:var(--text-secondary);"></span>
        </div>
        <div style="flex:1;">
          <label>提供商名称</label>
          <input type="text" id="input-name" placeholder="例如：My AI Service">
          <div class="icon-detected-label" id="icon-detected-text">输入名称/地址后自动识别图标</div>
        </div>
      </div>
      <div class="modal-form-group">
        <label>API 地址</label>
        <input type="text" id="input-url" placeholder="Ollama: http://localhost:11434 | OpenAI: https://api.example.com/v1/chat/completions">
      </div>
      <div class="modal-form-group">
        <label>API 密钥（Ollama 可留空）</label>
        <input type="password" id="input-key" placeholder="sk-...">
      </div>
      <div class="modal-form-group">
        <label>默认模型</label>
        <input type="text" id="input-model" placeholder="Ollama: llama3 | 百炼: qwen-plus | OpenAI: gpt-4">
      </div>
      <div class="modal-form-group">
        <label>描述（可选）</label>
        <input type="text" id="input-desc" placeholder="备注信息">
      </div>
    `,
    footer: `
      <button class="btn" id="btn-cancel">取消</button>
      <button class="btn btn-primary" id="btn-save">保存</button>
    `
  });

  document.getElementById('btn-cancel').addEventListener('click', closeModal);
  wireProviderTypeSelect();
  const fetchBtnAdd = document.getElementById('btn-fetch-models');
  if (fetchBtnAdd) fetchBtnAdd.addEventListener('click', () => {
    const provider = {
      type: document.getElementById('input-type').value,
      apiUrl: document.getElementById('input-url').value.trim(),
      apiKey: document.getElementById('input-key').value.trim(),
      model: document.getElementById('input-model').value.trim()
    };
    fetchAndFillModels(document.getElementById('input-model'), provider);
  });

  // 图标实时识别
  function updateProviderIconPreview() {
    if (!window.ModelIcons) return;
    const name = document.getElementById('input-name')?.value || '';
    const type = document.getElementById('input-type')?.value || '';
    const url = document.getElementById('input-url')?.value || '';
    const model = document.getElementById('input-model')?.value || '';
    const iconId = window.ModelIcons.detectProviderIcon({ name, type, apiUrl: url, model });
    const preview = document.getElementById('provider-icon-preview');
    const detectedText = document.getElementById('icon-detected-text');
    if (preview) {
      preview.innerHTML = window.ModelIcons.renderIconHtml(iconId, '', '32px');
      window.ModelIcons.updateIconsInContainer(preview);
    }
    if (detectedText) {
      detectedText.textContent = iconId === 'default' ? '未识别到特定图标，使用默认图标' : '已识别图标: ' + iconId;
    }
  }
  ['input-name', 'input-url', 'input-model', 'input-type'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', updateProviderIconPreview);
    document.getElementById(id)?.addEventListener('change', updateProviderIconPreview);
  });
  setTimeout(updateProviderIconPreview, 100);

  document.getElementById('btn-save').addEventListener('click', async () => {
    const type = document.getElementById('input-type').value;
    const name = document.getElementById('input-name').value.trim();
    const apiUrl = document.getElementById('input-url').value.trim();
    const apiKey = document.getElementById('input-key').value.trim();
    const model = document.getElementById('input-model').value.trim() || (type === 'ollama' ? 'llama3' : 'gpt-4');
    const description = document.getElementById('input-desc').value.trim();

    if (!name || !apiUrl) {
      showToast('信息不完整', '名称和API地址为必填项', 'warning');
      return;
    }

    const result = await window.api.addCloudProvider({ name, apiUrl, apiKey, model, description, type });
    if (result.success) {
      state.cloudProviders.push(result.data);
      syncAISettings();
      await setActiveProvider(result.data.id, { toast: null }); // 新增即选中
      renderCloudProviders();
      renderAISettings();
      closeModal();
      showToast('添加成功', `${name} 已设为当前模型`, 'success');
    } else {
      showToast('添加失败', result.error, 'error');
    }
  });
}

async function editCloudProvider(provider) {
  showModal({
    title: '编辑提供商',
    body: `
      <div class="modal-form-group">
        <label>提供商类型</label>
        <select id="input-type" data-search="true">
          ${providerTypeOptions(provider.type)}
        </select>
        <div class="modal-form-hint">腾讯云混元、DeepSeek、智谱、百度千帆、Kimi 等任何 OpenAI 兼容接口均可添加，选择对应厂商会自动预填地址</div>
      </div>
      <div class="modal-form-group">
        <label>提供商名称</label>
        <input type="text" id="input-name" value="${escapeHtml(provider.name)}">
      </div>
      <div class="modal-form-group">
        <label>API 地址</label>
        <input type="text" id="input-url" value="${escapeHtml(provider.apiUrl)}">
      </div>
      <div class="modal-form-group">
        <label>API 密钥（Ollama 可留空）</label>
        <input type="password" id="input-key" value="${escapeHtml(provider.apiKey)}">
      </div>
      <div class="modal-form-group">
        <label>默认模型</label>
        <div style="display:flex;gap:8px;align-items:center;">
          <input type="text" id="input-model" value="${escapeHtml(provider.model)}" style="flex:1;">
          <button type="button" class="btn btn-sm" id="btn-fetch-models" style="white-space:nowrap;">获取模型</button>
        </div>
      </div>
      <div class="modal-form-group">
        <label>描述（可选）</label>
        <input type="text" id="input-desc" value="${escapeHtml(provider.description || '')}">
      </div>
    `,
    footer: `
      <button class="btn" id="btn-cancel">取消</button>
      <button class="btn btn-primary" id="btn-save">保存</button>
    `
  });

  document.getElementById('btn-cancel').addEventListener('click', closeModal);
  wireProviderTypeSelect();
  const fetchBtnEdit = document.getElementById('btn-fetch-models');
  if (fetchBtnEdit) fetchBtnEdit.addEventListener('click', () => {
    const provider = {
      type: document.getElementById('input-type').value,
      apiUrl: document.getElementById('input-url').value.trim(),
      apiKey: document.getElementById('input-key').value.trim(),
      model: document.getElementById('input-model').value.trim()
    };
    fetchAndFillModels(document.getElementById('input-model'), provider);
  });
  document.getElementById('btn-save').addEventListener('click', async () => {
    const updates = {
      type: document.getElementById('input-type').value,
      name: document.getElementById('input-name').value.trim(),
      apiUrl: document.getElementById('input-url').value.trim(),
      apiKey: document.getElementById('input-key').value.trim(),
      model: document.getElementById('input-model').value.trim(),
      description: document.getElementById('input-desc').value.trim()
    };

    if (!updates.name || !updates.apiUrl) {
      showToast('信息不完整', '名称和API地址为必填项', 'warning');
      return;
    }

    const result = await window.api.updateCloudProvider({ id: provider.id, ...updates });
    if (result.success) {
      const idx = state.cloudProviders.findIndex(p => p.id === provider.id);
      if (idx !== -1) state.cloudProviders[idx] = result.data;
      syncAISettings();
      renderCloudProviders();
      closeModal();
      showToast('保存成功', '', 'success');
    } else {
      showToast('保存失败', result.error, 'error');
    }
  });
}

// ==================== Ollama 与预设 ====================
async function checkOllamaConnection(retries = 3) {
  const statusEl = document.getElementById('ollama-status');
  if (!statusEl) return;
  
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const result = await window.api.ollamaTest('http://localhost:11434');
      if (result.connected) {
        statusEl.textContent = '已连接';
        statusEl.classList.add('connected');
        statusEl.classList.remove('error');
        const ollamaSection = document.getElementById('ollama-section');
        if (ollamaSection) ollamaSection.style.display = 'block';
        loadOllamaModels();
        return;
      }
    } catch (e) {
      console.log('[Ollama] connection check failed (attempt ' + (attempt + 1) + '/' + retries + '):' + e.message);
    }
    
    if (attempt < retries - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  statusEl.textContent = '未连接';
  statusEl.classList.add('error');
  statusEl.classList.remove('connected');
}

// Update preset card status
function updatePresetCardStatus() {
  if (!state.cloudProviders || !Array.isArray(state.cloudProviders)) return;
  
  const presetTypeMap = {
    'ollama': 'ollama',
    'bailian': 'bailian',
    'deepseek': 'deepseek',
    'openai': 'openai',
    'anthropic': 'anthropic',
    'google': 'google',
    'zhipu': 'zhipu',
    'tencent': 'tencent',
    'baidu': 'baidu',
    'moonshot': 'moonshot',
    'bytedance': 'bytedance'
  };
  
  const presetCards = document.querySelectorAll('.preset-card');
  presetCards.forEach(card => {
    const presetType = card.getAttribute('data-preset');
    const statusEl = card.querySelector('.preset-status');
    if (!statusEl || !presetType) return;
    
    if (presetType === 'ollama') return;
    
    const providerType = presetTypeMap[presetType] || presetType;
    const hasProvider = state.cloudProviders.some(p => p.type === providerType);
    
    if (hasProvider) {
      statusEl.textContent = '已配置';
      statusEl.classList.add('connected');
      statusEl.classList.remove('error');
      card.classList.add('configured');
    } else {
      if (statusEl.textContent !== '已配置') {
        statusEl.textContent = '点击配置';
      }
    }
  });
}

async function loadOllamaModels() {
  const listEl = document.getElementById('ollama-models-list');
  if (!listEl) return;
  listEl.innerHTML = '<div class="empty-state-sm"><div class="empty-text">正在获取模型列表...</div></div>';

  const result = await window.api.ollamaListModels('http://localhost:11434');
  if (!result.success || !result.models || result.models.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state-sm">
        <div class="empty-text">${result.connected ? 'Ollama 中暂无模型' : 'Ollama 未连接'}</div>
        <div class="empty-hint">${result.connected ? '使用 ollama pull <模型名> 下载模型' : '请先启动 Ollama 服务'}</div>
      </div>
    `;
    return;
  }

  listEl.innerHTML = '';
  result.models.forEach(model => {
    const item = document.createElement('div');
    item.className = 'ollama-model-item';
    const alreadyAdded = state.cloudProviders.some(p => p.type === 'ollama' && p.model === model.name);
    // 根据模型名称自动识别对应图标（如 qwen→阿里, llama→Meta, mistral→Mistral）
    const modelIconId = window.ModelIcons ? window.ModelIcons.detectIconId(model.name) : 'ollama';
    item.innerHTML = `
      <span class="config-type-icon model-icon-wrap">${window.ModelIcons ? window.ModelIcons.renderIconHtml(modelIconId, 'model-icon', '24px') : window.ElIcons.getIcon('ollama')}</span>
      <div class="ollama-model-info">
        <div class="ollama-model-name">${escapeHtml(model.name)}</div>
        <div class="ollama-model-meta">${model.sizeFormatted || '-'}${model.modifiedAt ? ' · ' + model.modifiedAt.split('T')[0] : ''}</div>
      </div>
      <button class="btn btn-sm ${alreadyAdded ? '' : 'btn-primary'}" ${alreadyAdded ? 'disabled' : ''}>
        ${alreadyAdded ? '已添加' : '添加为提供商'}
      </button>
    `;
    if (!alreadyAdded) {
      item.querySelector('button').addEventListener('click', async () => {
        const r = await window.api.addCloudProvider({
          name: `Ollama · ${model.name}`,
          apiUrl: 'http://localhost:11434',
          apiKey: '',
          model: model.name,
          description: `Ollama 本地模型 ${model.sizeFormatted || ''}`,
          type: 'ollama'
        });
        if (r.success) {
          state.cloudProviders.push(r.data);
          syncAISettings();
          await setActiveProvider(r.data.id, { toast: null }); // 新增即选中
          renderCloudProviders();
          renderAISettings();
          loadOllamaModels();
          updatePresetCardStatus();
          showToast('添加成功', `${model.name} 已添加并设为当前模型`, 'success');
        } else {
          showToast('添加失败', r.error, 'error');
        }
      });
    }
    listEl.appendChild(item);
  });
}

function setupPresetCards() {
  document.querySelectorAll('.preset-card').forEach(card => {
    card.addEventListener('click', () => {
      const preset = card.dataset.preset;
      handlePresetClick(preset);
    });
  });

  const refreshBtn = document.getElementById('btn-refresh-ollama');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      checkOllamaConnection();
    });
  }
}

async function handlePresetClick(preset) {
  if (preset === 'custom') {
    // 其他/自定义：打开添加提供商弹窗
    addCloudProvider();
    return;
  }
  if (preset === 'ollama') {
    // Ollama: 刷新连接状态并展开模型列表
    await checkOllamaConnection();
    if (document.getElementById('ollama-section').style.display === 'block') {
      loadOllamaModels();
      showToast('Ollama 已连接', '请在下方选择要添加的模型', 'success');
    } else {
      // 如果未连接，仍可手动添加
      const exists = state.cloudProviders.some(p => p.type === 'ollama');
      if (!exists) {
        addOllamaManual();
      } else {
        showToast('Ollama 未连接', '请先启动 Ollama 服务（ollama serve）', 'warning');
      }
    }
    return;
  }

  // 百炼 / DeepSeek / OpenAI: 弹出配置对话框
  const presets = await window.api.getProviderPresets();
  const p = presets[preset];
  if (!p) return;

  const exists = state.cloudProviders.some(pro => pro.name === p.name);
  if (exists) {
    showToast('已存在', `${p.name} 已经添加过了`, 'info');
    return;
  }

  showPresetConfigModal(preset, p);
}

function addOllamaManual() {
  showModal({
    title: '配置 Ollama',
    body: `
      <div class="modal-info-box">
        <strong>使用前提：</strong><br>
        1. 已安装 Ollama（<a href="#" id="ollama-link">ollama.com</a>）<br>
        2. Ollama 服务正在运行（命令行执行 <code>ollama serve</code>）<br>
        3. 已拉取模型（如 <code>ollama pull llama3</code>）
      </div>
      <div class="modal-form-group">
        <label>Ollama 服务地址</label>
        <input type="text" id="input-url" value="http://localhost:11434">
      </div>
      <div class="modal-form-group">
        <label>模型名称</label>
        <input type="text" id="input-model" placeholder="llama3 / qwen2 / mistral ..." value="llama3">
      </div>
      <div class="modal-form-group">
        <label>显示名称（可选）</label>
        <input type="text" id="input-name" placeholder="Ollama 本地" value="Ollama 本地">
      </div>
    `,
    footer: `
      <button class="btn" id="btn-cancel">取消</button>
      <button class="btn btn-primary" id="btn-save">保存</button>
    `
  });
  document.getElementById('btn-cancel').addEventListener('click', closeModal);
  document.getElementById('btn-save').addEventListener('click', async () => {
    const apiUrl = document.getElementById('input-url').value.trim();
    const model = document.getElementById('input-model').value.trim();
    const name = document.getElementById('input-name').value.trim() || `Ollama · ${model}`;
    if (!apiUrl || !model) {
      showToast('信息不完整', '服务地址和模型名称为必填项', 'warning');
      return;
    }
    const r = await window.api.addCloudProvider({
      name, apiUrl, apiKey: '', model, description: 'Ollama 本地模型', type: 'ollama'
    });
    if (r.success) {
      state.cloudProviders.push(r.data);
      syncAISettings();
      await setActiveProvider(r.data.id, { toast: null }); // 新增即选中
      renderCloudProviders();
      renderAISettings();
      closeModal();
      showToast('添加成功', `${name} 已添加并设为当前模型`, 'success');
    } else {
      showToast('添加失败', r.error, 'error');
    }
  });
}

function showPresetConfigModal(preset, p) {
  const isBailian = preset === 'bailian';
  const titleText = isBailian ? '配置阿里云百炼' : `配置 ${p.name}`;
  showModal({
    title: titleText,
    body: `
      ${isBailian ? `
      <div class="modal-info-box">
        <strong>获取 API Key：</strong><br>
        1. 访问阿里云百炼控制台（bailian.console.aliyun.com）<br>
        2. 开通服务并创建 API-KEY<br>
        3. 常用模型：qwen-plus / qwen-turbo / qwen-max / qwen-long
      </div>
      ` : ''}
      <div class="modal-form-group">
        <label>提供商名称</label>
        <input type="text" id="input-name" value="${escapeHtml(p.name)}">
      </div>
      <div class="modal-form-group">
        <label>API 地址</label>
        <input type="text" id="input-url" value="${escapeHtml(p.apiUrl)}">
      </div>
      <div class="modal-form-group">
        <label>API 密钥</label>
        <input type="password" id="input-key" placeholder="${p.type === 'ollama' ? 'Ollama 无需密钥' : 'sk-...'}">
      </div>
      <div class="modal-form-group">
        <label>模型名称</label>
        <input type="text" id="input-model" value="${escapeHtml(p.model)}">
      </div>
      <div class="modal-form-group">
        <label>描述</label>
        <input type="text" id="input-desc" value="${escapeHtml(p.description)}">
      </div>
    `,
    footer: `
      <button class="btn" id="btn-cancel">取消</button>
      <button class="btn btn-primary" id="btn-save">保存</button>
    `
  });

  document.getElementById('btn-cancel').addEventListener('click', closeModal);
  document.getElementById('btn-save').addEventListener('click', async () => {
    const name = document.getElementById('input-name').value.trim();
    const apiUrl = document.getElementById('input-url').value.trim();
    const apiKey = document.getElementById('input-key').value.trim();
    const model = document.getElementById('input-model').value.trim();
    const description = document.getElementById('input-desc').value.trim();
    if (!name || !apiUrl) {
      showToast('信息不完整', '名称和API地址为必填项', 'warning');
      return;
    }
    const r = await window.api.addCloudProvider({
      name, apiUrl, apiKey, model, description, type: p.type
    });
    if (r.success) {
      state.cloudProviders.push(r.data);
      syncAISettings();
      await setActiveProvider(r.data.id, { toast: null }); // 新增即选中
      renderCloudProviders();
      renderAISettings();
      closeModal();
      showToast('添加成功', `${name} 已设为当前模型`, 'success');
    } else {
      showToast('添加失败', r.error, 'error');
    }
  });
}

async function saveAISettings() {
  const ctxWinEl = document.getElementById('context-window');
  const ai = buildAIConfig({
    temperature: parseFloat(document.getElementById('temperature').value),
    maxTokens: parseInt(document.getElementById('max-tokens').value),
    // 0 / 空 = 自动识别上下文窗口，保存为 0 便于读取统一
    contextWindow: ctxWinEl ? (parseInt(ctxWinEl.value, 10) || 0) : (parseInt(state.settings.ai?.contextWindow, 10) || 0)
    // 系统提示词不在这里了：已挪到「设置 → 功能设置 → 个性化」，见 savePersonalization()
  });

  await window.api.setConfig({ ai });
  state.settings.ai = ai;
}

// ==================== 设置 ====================
function renderSettings() {
  const pet = state.settings.pet || {};
  const sys = state.settings.system || {};

  document.getElementById('pet-size').value = pet.size || 1;
  document.getElementById('pet-size-value').textContent = ((pet.size || 1) * 100).toFixed(0) + '%';
  document.getElementById('pet-opacity').value = pet.opacity != null ? pet.opacity : 0;
  document.getElementById('pet-opacity-value').textContent = ((pet.opacity != null ? pet.opacity : 0) * 100).toFixed(0) + '%';
  document.getElementById('pet-framerate').value = String(pet.frameRate || 60);
  if (window.CustomSelect) window.CustomSelect.sync(document.getElementById('pet-framerate'));
  // 色彩调节（饱和度/亮度/色相）
  const col = pet.color || {};
  const colSat = (typeof col.saturation === 'number' && isFinite(col.saturation)) ? col.saturation : 1;
  const colBri = (typeof col.brightness === 'number' && isFinite(col.brightness)) ? col.brightness : 1;
  const colHue = (typeof col.hue === 'number' && isFinite(col.hue)) ? col.hue : 0;
  const colSatNode = document.getElementById('pet-col-sat');
  const colBriNode = document.getElementById('pet-col-bri');
  const colHueNode = document.getElementById('pet-col-hue');
  if (colSatNode) { colSatNode.value = colSat; document.getElementById('pet-col-sat-value').textContent = colSat.toFixed(2); }
  if (colBriNode) { colBriNode.value = colBri; document.getElementById('pet-col-bri-value').textContent = colBri.toFixed(2); }
  if (colHueNode) { colHueNode.value = colHue; document.getElementById('pet-col-hue-value').textContent = colHue + '°'; }
  document.getElementById('pet-topmost').checked = pet.alwaysOnTop !== false;
  document.getElementById('pet-clickthrough').checked = pet.clickThrough || false;
  const showInputEl = document.getElementById('pet-show-input');
  if (showInputEl) showInputEl.checked = pet.showInput !== false;
  const showCtxEl = document.getElementById('pet-show-contextmenu');
  if (showCtxEl) showCtxEl.checked = pet.showContextMenu !== false;
  // 渲染倍率（同时影响模型和键盘叠加层清晰度）
  const renderScaleEl = document.getElementById('pet-render-scale');
  if (renderScaleEl) {
    const rs = (typeof pet.renderScale === 'number' && isFinite(pet.renderScale)) ? pet.renderScale : 1.0;
    renderScaleEl.value = rs;
    document.getElementById('pet-render-scale-value').textContent = rs.toFixed(1) + 'x';
  }
  document.getElementById('confirm-danger').checked = sys.confirmDangerOps !== false;
  document.getElementById('show-notifications').checked = sys.showNotifications !== false;
  document.getElementById('auto-start').checked = sys.autoStart || false;
  document.getElementById('language').value = sys.language || 'zh-CN';
  if (window.CustomSelect) window.CustomSelect.sync(document.getElementById('language'));

  const theme = sys.theme || 'dark';
  document.querySelectorAll('.theme-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.theme === theme);
  });
  const accent = sys.accent || 'red';
  document.querySelectorAll('.accent-dot').forEach(d => {
    d.classList.toggle('active', d.dataset.accent === accent);
  });
  // 窗口透明效果
  const transparencyEl = document.getElementById('transparency-effect');
  if (transparencyEl) transparencyEl.checked = sys.transparency || false;

  // 系统外观（Windows only）—— 任务栏 + 开始菜单统一管理
  const sysSection = document.getElementById('system-appearance-section');
  if (sysSection) {
    sysSection.style.display = '';
    loadSystemAppearanceState();
  }
}

/**
 * 渲染"系统外观"面板：任务栏效果 + 开始菜单效果（各自独立，无总开关）。
 * 配置里没有 effect 时回落到 'normal'（默认=系统原生外观）。
 */
async function loadSystemAppearanceState() {
  const tbEffectSelect = document.getElementById('taskbar-effect-select');
  const smEffectSelect = document.getElementById('startmenu-effect-select');

  try {
    const cfg = await window.api.getConfig();
    const tbCfg = (cfg && cfg.taskbar) || {};
    const smCfg = (cfg && cfg.startMenu) || {};

    // 兼容旧配置：上一版有"启用自定义系统外观"总开关，enabled=false 时实际就是系统原生
    // 外观（旧版只在开关打开时才应用 effect），此时下拉回落到「默认」，
    // 避免界面显示「透明/亚克力」而系统实际是原生外观。
    // ★ 直接读 effect：不再有 `enabled===false → 强制 normal` 的旧字段兼容 ——
    //   defaultConfig 里 enabled 恰好是 false，会把用户选好的效果在读回时整体劫持成
    //   "默认"（表现为"重启/关页面后设置变回默认"，实际存储是好的）。已废弃该字段语义。
    const tbEffect = tbCfg.effect || 'normal';
    const smEffect = smCfg.effect || 'normal';

    // ★ 设完 value 必须同步自绘下拉的显示标签：CustomSelect 把原生 select 藏起来
    //   自绘文字，程序化 .value 赋值不触发 change → 标签不刷新，收起状态永远显示
    //   「默认」（实际效果已生效）。见 custom-select.js 的 CustomSelect.sync 注释。
    if (tbEffectSelect) {
      tbEffectSelect.value = tbEffect;
      if (window.CustomSelect) window.CustomSelect.sync(tbEffectSelect);
    }
    if (smEffectSelect) {
      smEffectSelect.value = smEffect;
      if (window.CustomSelect) window.CustomSelect.sync(smEffectSelect);
    }

    // 弹层同步二级开关回显（每个弹层目标独立）。
    // 兼容旧格式：布尔 false = 全关；true/无字段 = 全开；对象 = 按键取值。
    // 任务栏效果为「默认」时没有可同步的效果 → 全部置灰（不改高度，避免双列重排）。
    const syncMap = (() => {
      const v = tbCfg.flyoutSync;
      const allOff = v === false;
      const obj = (v && typeof v === 'object') ? v : {};
      return {
        notification: !allOff && obj.notification !== false,
        // 旧 contextmenu（右击菜单栏）已并入托盘弹窗：旧配置为 false 时跟随关闭
        overflow: !allOff && obj.overflow !== false && obj.contextmenu !== false,
        quicksettings: !allOff && obj.quicksettings !== false
      };
    })();
    const flyoutDisabled = (tbEffect === 'normal');
    for (const key of ['notification', 'overflow', 'quicksettings']) {
      const toggle = document.getElementById('flyout-sync-' + key);
      if (toggle) {
        toggle.checked = syncMap[key];
        toggle.disabled = flyoutDisabled;
      }
    }
  } catch (e) {
    console.warn('加载系统外观配置失败:', e);
  }

  // 功能设置（记忆 + 个性化，2026-10-03 新增）
  renderPersonalization();
  loadMemoryPanel();
  loadEvolutionPanel();
}

// ==================== 功能设置：记忆 + 个性化 ====================

const DEFAULT_PERSONA_PROMPT = '你是浮灵饰界的智能助手灵汐，一个运行在Windows桌面上的智能助手。你可以帮助用户回答问题、编写代码、管理文件、执行系统命令、推荐软件等。';

function getPersonalizationCfg() {
  return state.settings.personalization || {};
}

/** 把配置回显到「功能设置」控件上。 */
function renderPersonalization() {
  const p = getPersonalizationCfg();
  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v ?? ''; };
  const setChk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };

  setChk('memory-enabled', p.memoryEnabled !== false);
  setChk('memory-auto-record', p.autoRecordHabits !== false);
  setChk('memory-evolve', p.evolveEnabled !== false);
  setVal('persona-name', p.personaName || '灵汐');
  setVal('persona-role', p.personaRole || '桌面 AI 助手');
  setVal('persona-desc', p.personaDesc || '');
  setVal('custom-instructions', p.customInstructions || '');
  setVal('personal-system-prompt', p.systemPrompt || '');
  updateSmallPreview('persona-desc');
  updateSmallPreview('personal-system-prompt');
  updateCharCounter('custom-instructions');

  const style = p.replyStyle || 'default';
  document.querySelectorAll('#reply-style-selector .style-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.style === style);
  });

  const hint = document.getElementById('memory-scope-hint');
  if (hint) {
    hint.textContent = state.workdir
      ? '当前作用域：项目 ' + state.workdir + '（.ai_workspace/memory/memory.md）'
      : '当前作用域：全局（选中项目后自动切换为该项目）';
  }
}

/** 从控件收集并保存个性化配置。 */
async function savePersonalization() {
  const cur = getPersonalizationCfg();
  const val = (id, def) => { const el = document.getElementById(id); return el ? el.value : (def || ''); };
  const personalization = {
    memoryEnabled: document.getElementById('memory-enabled')?.checked ?? true,
    autoRecordHabits: document.getElementById('memory-auto-record')?.checked ?? true,
    evolveEnabled: document.getElementById('memory-evolve')?.checked ?? true,
    replyStyle: document.querySelector('#reply-style-selector .style-btn.active')?.dataset.style || cur.replyStyle || 'default',
    personaName: val('persona-name', '灵汐').trim() || '灵汐',
    personaRole: val('persona-role', '桌面 AI 助手').trim(),
    personaDesc: val('persona-desc'),
    customInstructions: val('custom-instructions'),
    systemPrompt: val('personal-system-prompt')
  };
  await window.api.setConfig({ personalization });
  state.settings.personalization = { ...cur, ...personalization };
  return personalization;
}

// ==================== 个性化：小文本弹窗编辑（2026-10-03）====================

/** 单行预览字数。 */
function updateCharCounter(fieldId) {
  const el = document.getElementById(fieldId);
  const counter = document.getElementById(fieldId + '-counter');
  if (el && counter) counter.textContent = (el.value.length) + ' 字';
}

/** 把隐藏 textarea 的值同步到单行预览行。 */
function updateSmallPreview(fieldId) {
  const src = document.getElementById(fieldId);
  const preview = document.getElementById(fieldId + '-preview');
  if (!src || !preview) return;
  const v = (src.value || '').trim();
  preview.textContent = v || (window.I18N?.t?.('settings.notSet') || '（未填写）');
  preview.classList.toggle('empty', !v);
}

let smallEditorField = null;

function openSmallEditor(fieldId) {
  const src = document.getElementById(fieldId);
  if (!src) return;
  smallEditorField = fieldId;
  const titleKey = fieldId === 'persona-desc' ? 'settings.personaDesc' : 'settings.systemPrompt';
  const titleEl = document.getElementById('small-text-editor-title');
  if (titleEl) titleEl.textContent = window.I18N?.t?.(titleKey) || titleEl.textContent;
  const ta = document.getElementById('small-text-editor');
  if (ta) {
    ta.value = src.value || '';
    updateSmallEditorCounter();
    setTimeout(() => ta.focus(), 50);
  }
  const ov = document.getElementById('small-text-editor-overlay');
  if (ov) ov.classList.add('show');
}

function updateSmallEditorCounter() {
  const ta = document.getElementById('small-text-editor');
  const c = document.getElementById('small-text-editor-counter');
  if (ta && c) c.textContent = (ta.value.length) + ' 字';
}

function closeSmallEditor() {
  const ov = document.getElementById('small-text-editor-overlay');
  if (ov) ov.classList.remove('show');
  smallEditorField = null;
}

function saveSmallEditor() {
  if (!smallEditorField) return;
  const src = document.getElementById(smallEditorField);
  const ta = document.getElementById('small-text-editor');
  if (src && ta) src.value = ta.value;
  closeSmallEditor();
  updateSmallPreview(smallEditorField);
  savePersonalization();
}

function bindSmallTextEditor() {
  const cancel = document.getElementById('small-text-editor-cancel');
  if (cancel) cancel.addEventListener('click', closeSmallEditor);
  const save = document.getElementById('small-text-editor-save');
  if (save) save.addEventListener('click', saveSmallEditor);
  const close = document.getElementById('small-text-editor-close');
  if (close) close.addEventListener('click', closeSmallEditor);
  const overlay = document.getElementById('small-text-editor-overlay');
  if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSmallEditor(); });
  const ta = document.getElementById('small-text-editor');
  if (ta) ta.addEventListener('input', updateSmallEditorCounter);
}

/** 长期记忆面板：列出/搜索/编辑/删除。 */
async function loadMemoryPanel() {
  const list = document.getElementById('memory-list');
  if (!list) return;
  const q = (document.getElementById('memory-search')?.value || '').trim();
  try {
    const items = q
      ? await window.api.memory.search(q, 50, state.workdir || '')
      : await window.api.memory.list({ limit: 50, workdir: state.workdir || '' });
    list.innerHTML = '';
    if (!items || !items.length) {
      list.innerHTML = '<div class="memory-empty">' + (q ? '没有匹配的记忆' : '还没有长期记忆。AI 记住的东西会出现在这里，可随时编辑或删除。') + '</div>';
      return;
    }
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'memory-item';
      const body = document.createElement('div');
      body.className = 'memory-item-body';
      const text = document.createElement('div');
      text.textContent = it.text || '';
      body.appendChild(text);
      const tags = document.createElement('div');
      tags.className = 'memory-item-tags';
      const bits = [];
      if (it.pinned) bits.push('置顶');
      if (it.kind) bits.push(it.kind);
      if (it.tags && it.tags.length) bits.push(it.tags.join(' / '));
      bits.push(it.updatedAt || '');
      tags.textContent = bits.filter(Boolean).join(' · ');
      body.appendChild(tags);

      const actions = document.createElement('div');
      actions.className = 'memory-item-actions';
      const editBtn = document.createElement('button');
      editBtn.className = 'memory-icon-btn';
      editBtn.type = 'button';
      editBtn.title = '编辑';
      editBtn.innerHTML = window.ElIcons ? window.ElIcons.getIcon('edit') : '';
      const delBtn = document.createElement('button');
      delBtn.className = 'memory-icon-btn';
      delBtn.type = 'button';
      delBtn.title = '删除';
      delBtn.innerHTML = window.ElIcons ? window.ElIcons.getIcon('delete') : '';

      let editing = false;
      editBtn.addEventListener('click', async () => {
        if (editing) return;
        editing = true;
        const ta = document.createElement('textarea');
        ta.className = 'memory-edit';
        ta.value = it.text || '';
        body.appendChild(ta);
        ta.focus();
        const save = async () => {
          const v = ta.value.trim();
          if (v && v !== it.text) {
            await window.api.memory.update(it.id, { text: v });
            showToast('已更新', '记忆已保存', 'success');
          }
          await loadMemoryPanel();
        };
        ta.addEventListener('blur', save, { once: true });
        ta.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ta.blur(); }
          if (e.key === 'Escape') { ta.value = it.text || ''; ta.blur(); }
        });
      });
      delBtn.addEventListener('click', async () => {
        await window.api.memory.remove(it.id);
        showToast('已删除', '该条记忆已移除', 'success');
        await loadMemoryPanel();
      });
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
      row.appendChild(body);
      row.appendChild(actions);
      list.appendChild(row);
    }
  } catch (e) {
    list.innerHTML = '<div class="memory-empty">读取记忆失败：' + (e.message || e) + '</div>';
  }
}

/** AI 进化档案：统计 + 画像。 */
async function loadEvolutionPanel() {
  const box = document.getElementById('evolution-profile');
  const stat = document.getElementById('evolution-stats');
  if (!box) return;
  try {
    const s = await window.api.evolution.stats(14);
    if (stat) {
      stat.textContent = s && s.total
        ? ('最近 ' + s.days + ' 天：' + s.total + ' 条记录' + ((s.projects || []).length ? '，常在 ' + (s.projects || []).map(p => p.name.split(/[\\/]/).pop()).join('、') : ''))
        : '还没有记录';
    }
    if (s && s.total) {
      const r = await window.api.evolution.profile();
      box.textContent = (r && r.content) || '（画像生成失败）';
    } else {
      box.textContent = '还没有动向记录。跟 AI 聊几句或让它处理几个任务后，这里会自动出现按天记录与汇总画像。';
    }
  } catch (e) {
    box.textContent = '读取进化档案失败：' + (e.message || e);
  }
}

async function saveSettings() {
  const pet = {
    size: parseFloat(document.getElementById('pet-size').value),
    opacity: parseFloat(document.getElementById('pet-opacity').value),
    frameRate: parseInt(document.getElementById('pet-framerate').value),
    alwaysOnTop: document.getElementById('pet-topmost').checked,
    clickThrough: document.getElementById('pet-clickthrough').checked,
    showInput: document.getElementById('pet-show-input')?.checked ?? true,
    showContextMenu: document.getElementById('pet-show-contextmenu')?.checked ?? true,
    renderScale: parseFloat(document.getElementById('pet-render-scale')?.value ?? 1.0),
    color: {
      saturation: parseFloat(document.getElementById('pet-col-sat')?.value ?? 1),
      brightness: parseFloat(document.getElementById('pet-col-bri')?.value ?? 1),
      hue: parseInt(document.getElementById('pet-col-hue')?.value ?? 0, 10)
    }
  };

  const sys = {
    confirmDangerOps: document.getElementById('confirm-danger').checked,
    showNotifications: document.getElementById('show-notifications').checked,
    autoStart: document.getElementById('auto-start').checked,
    language: document.getElementById('language').value,
    theme: document.querySelector('.theme-btn.active')?.dataset.theme || 'dark',
    accent: document.querySelector('.accent-dot.active')?.dataset.accent || 'red',
    transparency: document.getElementById('transparency-effect')?.checked || false
  };

  // 任务栏外观不进应用配置：它直接对应系统设置（开关值实时从注册表读），存两份会不一致。
  // 旧的 taskbar.enabled / taskbar.effect 已废弃 —— 那个效果在本机无法安全实现。
  await window.api.setConfig({ pet, system: sys });
  state.settings.pet = { ...state.settings.pet, ...pet };
  state.settings.system = { ...state.settings.system, ...sys };

  // ★ 内存优化：设置中关闭输入框或右键菜单时，关闭对应的独立窗口，释放资源
  if (!pet.showInput) {
    console.log('[MemoryOptimizer] 设置中关闭输入框，关闭输入框窗口');
    if (window.api && window.api.hideInputBar) {
      window.api.hideInputBar().catch(() => {});
    }
  }
  if (!pet.showContextMenu) {
    console.log('[MemoryOptimizer] 设置中关闭右键菜单，关闭右键菜单窗口');
    if (window.api && window.api.closeContextMenu) {
      window.api.closeContextMenu().catch(() => {});
    }
  }

  // 仅在主题/透明度实际变化时才翻转根属性（无谓的翻转 = 全文档样式重匹配）
  const prevSys = state.settings.system || {};
  if (sys.theme !== (prevSys.theme || 'dark')) applyTheme(sys.theme);
  if ((sys.transparency || false) !== (prevSys.transparency || false)) applyTransparency(sys.transparency || false);

  // 仅当宠物设置实际变化时才发送到主进程，避免不必要的窗口操作导致位移
  const petSnapshot = JSON.stringify({
    size: Math.round(pet.size * 100) / 100,
    opacity: Math.round(pet.opacity * 100) / 100,
    frameRate: pet.frameRate,
    alwaysOnTop: pet.alwaysOnTop,
    clickThrough: pet.clickThrough,
    renderScale: Math.round(pet.renderScale * 100) / 100,
    color: {
      saturation: Math.round(pet.color.saturation * 100) / 100,
      brightness: Math.round(pet.color.brightness * 100) / 100,
      hue: pet.color.hue
    }
  });
  if (petSnapshot !== lastSentPetSettings) {
    try {
      await window.api.applyPetSettings(pet);
      lastSentPetSettings = petSnapshot;
    } catch (e) {
      console.warn('应用宠物设置失败:', e.message);
    }
  }

  // 实时设置开机自启
  try {
    await window.api.setAutoStart(sys.autoStart);
  } catch (e) {
    console.warn('设置开机自启失败:', e.message);
  }
}

// 当前主题设置（dark/light/auto），用于系统主题变化时判断是否自动切换
let currentThemeSetting = 'dark';
// 系统主题变化监听器引用，用于切换主题时移除旧监听器
let systemThemeListener = null;

// 根属性翻转（data-theme/data-accent/data-transparency）会触发全文档样式重匹配，
// 若各元素还挂着 transition:all，会让所有过渡属性（含 backdrop-filter 模糊）在同一帧
// 同时动画 → 明显卡顿。翻转期间临时禁用全页过渡，两帧后恢复（不影响日常交互动画）。
function withRootFlipFast(fn) {
  const html = document.documentElement;
  html.classList.add('root-flipping');
  try {
    fn();
  } finally {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => html.classList.remove('root-flipping'));
    });
  }
}

function applyTheme(theme) {
  currentThemeSetting = theme || 'dark';

  // 移除之前的系统主题变化监听器
  if (systemThemeListener) {
    try {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.removeEventListener) mq.removeEventListener('change', systemThemeListener);
      else if (mq.removeListener) mq.removeListener(systemThemeListener);
    } catch (e) {}
    systemThemeListener = null;
  }

  if (theme === 'auto') {
    // 跟随系统：检测当前系统主题并应用
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    withRootFlipFast(() => document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light'));

    // 监听系统主题变化，自动切换
    systemThemeListener = (e) => {
      if (currentThemeSetting === 'auto') {
        withRootFlipFast(() => document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light'));
        updateLogoColors();
      }
    };;
    try {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', systemThemeListener);
      else if (mq.addListener) mq.addListener(systemThemeListener);
    } catch (e) {}
  } else {
    // 固定主题：直接应用 dark/light
    withRootFlipFast(() => document.documentElement.setAttribute('data-theme', theme));
  }
  // 更新工具栏图标样式（浅色模式下使用描边式）
  updateToolbarIconStyles();
  // 深色模式 Logo 用粉色版，浅色模式用原色
  updateLogoColors();
}

// 根据当前主题切换 Logo 颜色（深色=粉色线稿，浅色=原黑色线稿）
function updateLogoColors() {
  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  const pinkSrc = '../../assets/icons/logo-pink.png';
  const origSrc = '../../assets/icons/logo.png';
  document.querySelectorAll('.logo-icon-img, .about-logo-img').forEach(img => {
    img.src = isDark ? pinkSrc : origSrc;
  });
}
// 强调色（主题色）切换：作用于 <html data-accent="...">，覆盖 --accent/--primary 系列
function applyAccent(accent) {
  withRootFlipFast(() => document.documentElement.setAttribute('data-accent', accent || 'red'));
  // 生效自检：CSS 变量理论上即时级联到所有组件，但用户环境出现过「开关已跟随、
  // 主题按钮仍显示旧色」的分裂态。这里读回实际值校验，不一致时强制触发一次重算。
  requestAnimationFrame(() => {
    try {
      const html = document.documentElement;
      const varVal = getComputedStyle(html).getPropertyValue('--accent').trim();
      const btn = document.querySelector('.theme-btn.active');
      const sw = document.querySelector('#tab-settings .switch-toggle input:checked + .switch-slider');
      const btnBg = btn ? getComputedStyle(btn).backgroundColor : '';
      const swBg = sw ? getComputedStyle(sw).backgroundColor : '';
      // 把 var 值转成 rgb() 对比（varVal 可能是 #hex）
      const probe = document.createElement('span');
      probe.style.color = varVal;
      document.body.appendChild(probe);
      const expectRgb = getComputedStyle(probe).color;
      probe.remove();
      const mismatch = (btnBg && btnBg !== expectRgb && btnBg !== varVal) ||
                       (swBg && swBg !== expectRgb && swBg !== varVal);
      if (mismatch) {
        console.warn('[Accent] 强调色未正确级联（btn=' + btnBg + ' switch=' + swBg + ' expect=' + expectRgb + '），强制重设 data-accent');
        html.setAttribute('data-accent', '');
        html.setAttribute('data-accent', accent || 'red');
      }
    } catch (e) { /* 自检失败不影响正常流程 */ }
  });
}

// 窗口透明效果切换：作用于 <html data-transparency="...">（CSS 半透明底色），
// 同时通知主进程记录状态。主窗口永远以系统 Acrylic 创建，磨砂开/关只靠本函数切
// CSS 透明度即时生效（无感切换，主进程不再重建窗口——运行时切材质实测是死路）
function applyTransparency(enabled) {
  withRootFlipFast(() => {
    if (enabled) {
      document.documentElement.setAttribute('data-transparency', 'true');
    } else {
      document.documentElement.removeAttribute('data-transparency');
    }
  });
  if (window.api && window.api.setWindowTransparency) {
    window.api.setWindowTransparency(!!enabled).catch(() => {});
  }
}

// 基于当前宠物位置做相对位移（滑块为 Δx/Δy，应用后归零）
async function applyPetPositionNudge() {
  const dx = parseInt(document.getElementById('pet-posx')?.value || '0', 10);
  const dy = parseInt(document.getElementById('pet-posy')?.value || '0', 10);
  try {
    const pos = await window.api.getPetPosition();
    if (pos) {
      await window.api.petDrag((pos.x || 0) + dx, (pos.y || 0) + dy);
    }
    const px = document.getElementById('pet-posx'), py = document.getElementById('pet-posy');
    if (px) { px.value = 0; document.getElementById('pet-posx-value').textContent = '0'; }
    if (py) { py.value = 0; document.getElementById('pet-posy-value').textContent = '0'; }
    if (window.showToast) window.showToast('已移动灵汐', `Δx=${dx} Δy=${dy}`, 'success');
  } catch (e) {
    console.warn('应用位置失败:', e.message);
    if (window.showToast) window.showToast('移动失败', e.message, 'error');
  }
}

// 仅恢复桌宠外观默认值（大小/透明度/色彩/渲染倍率），其余设置不变
async function resetPetDisplay() {
  const sizeEl = document.getElementById('pet-size');
  const opacityEl = document.getElementById('pet-opacity');
  if (sizeEl) { sizeEl.value = 1; document.getElementById('pet-size-value').textContent = '100%'; }
  if (opacityEl) { opacityEl.value = 0; document.getElementById('pet-opacity-value').textContent = '0%'; }
  const colSatEl = document.getElementById('pet-col-sat');
  const colBriEl = document.getElementById('pet-col-bri');
  const colHueEl = document.getElementById('pet-col-hue');
  if (colSatEl) { colSatEl.value = 1; document.getElementById('pet-col-sat-value').textContent = '1.00'; }
  if (colBriEl) { colBriEl.value = 1; document.getElementById('pet-col-bri-value').textContent = '1.00'; }
  if (colHueEl) { colHueEl.value = 0; document.getElementById('pet-col-hue-value').textContent = '0°'; }
  // 重置渲染倍率
  const renderScaleEl = document.getElementById('pet-render-scale');
  if (renderScaleEl) {
    renderScaleEl.value = 1.0;
    document.getElementById('pet-render-scale-value').textContent = '1.0x';
    if (window.api && typeof window.api.setPetRenderScale === 'function') {
      window.api.setPetRenderScale(1.0);
    }
  }
  // ★ 重置 lastSentPetSettings，确保新设置被发送到主进程（解决设置后无法回到默认值的问题）
  lastSentPetSettings = null;
  await saveSettings();
  if (window.showToast) window.showToast('已恢复默认', '大小/透明度/色彩/渲染倍率已重置', 'success');
}

async function resetConfig() {
  const confirmed = await showConfirm({
    type: 'warning',
    title: '重置配置',
    message: '确定要重置所有配置吗？',
    detail: '所有个性化设置将被清除，恢复默认值。此操作不可撤销。'
  });
  if (!confirmed) return;

  await window.api.resetConfig();
  state.settings = await window.api.getConfig();
  lastSentPetSettings = null; // 重置快照，确保新设置被发送
  applySettings();
  loadCloudProviders();
  loadLocalModels();
  renderAIConfig();
  updateModelStatusBar();
  showToast('已重置', '所有配置已恢复默认', 'success');
}

async function exportConfig() {
  const filePath = await window.api.saveFile({
    defaultPath: `ai_lobster_config_${Date.now()}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (!filePath) return;
  const config = await window.api.getConfig();
  const result = await window.api.writeFile({ path: filePath, content: JSON.stringify(config, null, 2) });
  if (result.success) {
    showToast('导出成功', '配置已保存到所选文件', 'success');
  } else {
    showToast('导出失败', result.error, 'error');
  }
}

async function importConfig() {
  const paths = await window.api.selectFiles({
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (!paths || paths.length === 0) return;
  const result = await window.api.readFile({ path: paths[0] });
  if (!result.success) {
    showToast('读取失败', result.error, 'error');
    return;
  }
  try {
    const importedConfig = JSON.parse(result.data);
    await window.api.setConfig(importedConfig);
    state.settings = await window.api.getConfig();
    lastSentPetSettings = null; // 重置快照，确保导入的设置被发送
    applySettings();
    loadCloudProviders();
    loadLocalModels();
    renderAIConfig();
    updateModelStatusBar();
    showToast('导入成功', '配置已恢复', 'success');
  } catch (e) {
    showToast('导入失败', '配置文件格式错误', 'error');
  }
}

async function updateDisclaimerAgreement(agreed) {
  await window.api.setConfig({
    disclaimer: { accepted: agreed, acceptedAt: agreed ? new Date().toISOString() : null }
  });
  state.settings.disclaimer = { accepted: agreed };
  if (agreed) {
    showToast('感谢同意', '现在可以使用所有功能了', 'success');
    // 通知主进程创建并显示宠物窗口（首次安装场景）
    if (window.api.disclaimerAccepted) {
      window.api.disclaimerAccepted();
    }
  }
}

function applySettings() {
  const sys = state.settings.system || {};
  if (sys.theme) applyTheme(sys.theme);
  applyAccent(sys.accent || 'red');
  applyTransparency(sys.transparency || false);

  // 应用语言（实时翻译整个界面）
  const lang = sys.language || 'zh-CN';
  if (window.I18N && window.I18N.applyLanguage) {
    window.I18N.applyLanguage(lang);
  }
  const langSelect = document.getElementById('language');
  if (langSelect) {
    langSelect.value = lang;
    if (window.CustomSelect) window.CustomSelect.sync(langSelect);
  }

  // 填充设置表单
  renderSettings();

  // 启动时应用宠物外观设置
  const pet = state.settings.pet || {};
  if (Object.keys(pet).length > 0) {
    // 初始化快照，避免首次 saveSettings 时重复发送
    lastSentPetSettings = JSON.stringify({
      size: Math.round((pet.size || 1) * 100) / 100,
      opacity: Math.round((pet.opacity != null ? pet.opacity : 0) * 100) / 100,
      frameRate: pet.frameRate || 60,
      alwaysOnTop: pet.alwaysOnTop !== false,
      clickThrough: pet.clickThrough || false,
      renderScale: Math.round((pet.renderScale || 1.0) * 100) / 100
    });
    // 启动时应用渲染倍率
    if (pet.renderScale && window.api && typeof window.api.setPetRenderScale === 'function') {
      window.api.setPetRenderScale(pet.renderScale);
    }
    window.api.applyPetSettings(pet).catch(() => {});
  }
}

// ==================== 对话框 ====================
function showModal({ title, body, footer }) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = body;
  document.getElementById('modal-footer').innerHTML = footer || '';
  document.getElementById('modal-overlay').classList.add('show');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('show');
  const m = document.getElementById('modal');
  if (m) m.classList.remove('ae-modal');
  _destroyActionPreview();
}

async function showConfirm({ type = 'warning', title, message, detail, buttons = ['确定', '取消'] }) {
  // 使用应用内自定义对话框（非系统原生弹窗），返回 boolean（点击主按钮为 true）
  return await window.AppDialog.confirm({ type, title, message, detail, buttons });
}

// ==================== Toast ====================
function showToast(title, message, type = 'info', options = {}) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const I = window.ElIcons.getIcon;
  const icons = { success: 'success', error: 'error', warning: 'warning', info: 'info' };
  toast.innerHTML = `
    <div class="toast-icon">${I(icons[type] || 'info')}</div>
    <div>
      <div class="toast-title">${escapeHtml(title)}</div>
      ${message ? `<div class="toast-message">${(options && options.useHtml) ? message : escapeHtml(message)}</div>` : ''}
    </div>
  `;
  container.appendChild(toast);

  // options.duration：报错时带操作建议的提示需要多留一会儿（可用该参数单独延长）
  const lifespan = Number(options && options.duration) || 2000;
  setTimeout(() => {
    toast.style.transition = 'all 0.3s ease';
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(120%)';
    setTimeout(() => toast.remove(), 300);
  }, lifespan);
}

// ==================== 更新公告 ====================

const CHANGE_TYPE_META = {
  feature:     { icon: 'sparkles',  color: '#4fc3f7', label: '新功能' },
  fix:         { icon: 'check',     color: '#4caf50', label: '修复' },
  improvement: { icon: 'lightning', color: '#ff9800', label: '优化' },
  notice:      { icon: 'warning',   color: '#f44336', label: '公告' }
};

// 渲染更新公告页面（融入关于页面）- 默认只展开最新版本
async function getPatchedChangelog() {
  try {
    // 从模型路径推断 userData 目录（兼容打包版，无需主进程改动）
    const models = await window.api.listModels();
    let userData = null;
    if (models && models.length > 0) {
      const mp = models[0].installPath || models[0].path || models[0].modelPath || '';
      const idx = mp.indexOf('ai-lobster');
      if (idx > 0) userData = mp.substring(0, idx + 'ai-lobster'.length);
    }
    if (!userData) return null;
    const sep = userData.includes('/') ? '/' : '\\';
    // 读取 applied.json
    const appliedRes = await window.api.readFile({ path: userData + sep + 'patches' + sep + 'applied.json' });
    if (!appliedRes || !appliedRes.success) return null;
    const applied = JSON.parse(appliedRes.data);
    if (!Array.isArray(applied) || applied.length === 0) return null;
    // 版本降序
    applied.sort((a, b) => {
      const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        if ((pa[i]||0) !== (pb[i]||0)) return (pb[i]||0) - (pa[i]||0);
      }
      return 0;
    });
    // 收集所有补丁中的更新日志
    const allEntries = [];
    const seenVersions = new Set();
    for (const ver of applied) {
      const clRes = await window.api.readFile({ path: userData + sep + 'patches' + sep + ver + sep + 'renderer' + sep + 'data' + sep + 'changelog.json' });
      if (clRes && clRes.success) {
        const data = JSON.parse(clRes.data);
        if (Array.isArray(data) && data.length > 0) {
          for (const entry of data) {
            if (entry && entry.version && !seenVersions.has(entry.version)) {
              seenVersions.add(entry.version);
              allEntries.push(entry);
            }
          }
        }
      }
    }
    // 合并包体中的更新日志（window.CHANGELOG 或 data/changelog.json）
    let packageChangelog = null;
    if (window.CHANGELOG && Array.isArray(window.CHANGELOG) && window.CHANGELOG.length > 0) {
      packageChangelog = window.CHANGELOG;
    } else {
      try {
        const resp = await fetch('data/changelog.json', { cache: 'no-store' });
        if (resp.ok) packageChangelog = await resp.json();
      } catch (e) {}
    }
    if (packageChangelog && Array.isArray(packageChangelog)) {
      for (const entry of packageChangelog) {
        if (entry && entry.version && !seenVersions.has(entry.version)) {
          seenVersions.add(entry.version);
          allEntries.push(entry);
        }
      }
    }
    // 按版本号降序排序
    allEntries.sort((a, b) => {
      const pa = String(a.version).split('.').map(Number), pb = String(b.version).split('.').map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        if ((pa[i]||0) !== (pb[i]||0)) return (pb[i]||0) - (pa[i]||0);
      }
      return 0;
    });
    if (allEntries.length > 0) return allEntries;
  } catch (e) { console.error('[changelog] 读取补丁公告失败:', e); }
  return null;
}

async function renderAboutChangelog() {
  const container = document.getElementById('about-changelog-list');
  if (!container) return;

  try {
    let changelog = null;
    // 1. 优先从补丁目录读取（打包版也能用）
    changelog = await getPatchedChangelog();
    // 2. 回退 window.CHANGELOG（由 data/changelog.js 注入）
    if (!changelog && window.CHANGELOG && Array.isArray(window.CHANGELOG) && window.CHANGELOG.length > 0) {
      changelog = window.CHANGELOG;
    }
    // 3. 回退 fetch JSON
    if (!changelog) {
      try {
        const resp = await fetch('data/changelog.json', { cache: 'no-store' });
        if (resp.ok) changelog = await resp.json();
      } catch (e) {}
    }
    // 4. 最终回退：主进程 IPC（内置公告）
    if (!changelog || !Array.isArray(changelog)) {
      try { changelog = await window.api.getChangelog(); } catch (e) {}
    }
    if (!changelog || changelog.length === 0) {
      container.innerHTML = '<div class="changelog-empty">暂无更新记录</div>';
      return;
    }

    container.innerHTML = changelog.map((version, index) => {
      const isLatest = index === 0;
      const changesHtml = version.changes.map(change => {
        const meta = CHANGE_TYPE_META[change.type] || CHANGE_TYPE_META.notice;
        return `
          <div class="changelog-change-item">
            <span class="change-badge" style="color: ${meta.color}; border-color: ${meta.color};">
              ${meta.label}
            </span>
            <div class="change-content">
              <div class="change-title">${escapeHtml(change.title)}</div>
              ${change.desc ? `<div class="change-desc">${escapeHtml(change.desc)}</div>` : ''}
            </div>
          </div>
        `;
      }).join('');

      return `
        <div class="changelog-version ${isLatest ? 'expanded' : 'collapsed'}">
          <div class="version-header ${isLatest ? '' : 'clickable'}" data-toggle-version="${index}">
            <div class="version-toggle-icon">${isLatest ? '▾' : '▸'}</div>
            <div class="version-info">
              <span class="version-tag">v${escapeHtml(version.version)}</span>
              <span class="version-date">${escapeHtml(version.date)}</span>
            </div>
            <h3 class="version-title">${escapeHtml(version.title)}</h3>
          </div>
          <div class="version-changes" style="${isLatest ? '' : 'display:none;'}">
            ${changesHtml}
          </div>
        </div>
      `;
    }).join('');

    // 绑定折叠/展开事件
    container.querySelectorAll('.version-header.clickable').forEach(header => {
      header.addEventListener('click', function() {
        const versionDiv = this.closest('.changelog-version');
        const changesDiv = versionDiv.querySelector('.version-changes');
        const icon = this.querySelector('.version-toggle-icon');
        const isExpanded = versionDiv.classList.contains('expanded');

        if (isExpanded) {
          versionDiv.classList.remove('expanded');
          versionDiv.classList.add('collapsed');
          changesDiv.style.display = 'none';
          icon.textContent = '▸';
        } else {
          versionDiv.classList.add('expanded');
          versionDiv.classList.remove('collapsed');
          changesDiv.style.display = '';
          icon.textContent = '▾';
        }
      });
    });
  } catch (err) {
    console.error('加载更新公告失败:', err);
    container.innerHTML = '<div class="changelog-empty">加载失败，请稍后重试</div>';
  }
}

// 检查版本更新，首次启动新版本时自动弹窗
async function checkForUpdates() {
  try {
    const result = await window.api.checkUpdate();
    if (result && result.hasUpdate && result.changes) {
      showChangelogModal(result.changes, result.version);
    }
  } catch (err) {
    console.error('检查更新失败:', err);
  }
}

// 显示更新公告弹窗
function showChangelogModal(versionData, version) {
  const overlay = document.getElementById('changelog-modal-overlay');
  const titleEl = document.getElementById('changelog-modal-title');
  const bodyEl = document.getElementById('changelog-modal-body');
  if (!overlay || !titleEl || !bodyEl) return;

  titleEl.textContent = `更新到 v${version} - ${versionData.title || ''}`;

  const changesHtml = (versionData.changes || []).map(change => {
    const meta = CHANGE_TYPE_META[change.type] || CHANGE_TYPE_META.notice;
    return `
      <div class="changelog-change-item">
        <span class="change-badge" style="color: ${meta.color}; border-color: ${meta.color};">
          ${meta.label}
        </span>
        <div class="change-content">
          <div class="change-title">${escapeHtml(change.title)}</div>
          ${change.desc ? `<div class="change-desc">${escapeHtml(change.desc)}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');

  bodyEl.innerHTML = `
    <div class="changelog-modal-version">
      <span class="version-tag">v${escapeHtml(version)}</span>
      <span class="version-date">${escapeHtml(versionData.date || '')}</span>
    </div>
    <div class="changelog-modal-changes">
      ${changesHtml}
    </div>
  `;

  overlay.classList.add('show');
}

// 设置更新公告弹窗事件监听
function setupChangelogModal() {
  const overlay = document.getElementById('changelog-modal-overlay');
  const closeBtn = document.getElementById('changelog-modal-close');
  const okBtn = document.getElementById('changelog-modal-ok');
  if (!overlay) return;

  const closeModal = () => overlay.classList.remove('show');

  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (okBtn) okBtn.addEventListener('click', closeModal);

  // 不响应点击空白处关闭（程序规范：须点击 × / 知道了 关闭）

  // ESC 关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('show')) {
      closeModal();
    }
  });
}

// ==================== 工具函数 ====================
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function formatSize(bytes) {
  if (!bytes && bytes !== 0) return '-';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + units[i];
}

function debounce(fn, delay) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

// 启动
document.addEventListener('DOMContentLoaded', init);


// ==================== 文件附件上传 ====================
async function addUploadedFile(file) {
  // ★ 图片文件分流进多模态附件（与粘贴/拖拽图片同一通道）：
  //   走普通文件列表的话只会变成「请用 read_file 读取」的文字提示——read_file 读不了
  //   二进制图片，模型就只识别到文字、不识别图片（用户实测反馈的"分批上传"问题）。
  const isImg = (file.type && file.type.startsWith('image/')) ||
    /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name || '');
  if (isImg && window.MultimodalUI && typeof window.MultimodalUI.addImageFile === 'function') {
    window.MultimodalUI.addImageFile(file);
    return;
  }
  // 上传只保存路径，不限制大小（AI 用 read_file 读取时会自行处理）
  // Electron 的 File 对象有 path 属性（真实本地路径）
  const filePath = file.path || file.name;
  state.uploadedFiles = state.uploadedFiles || [];
  state.uploadedFiles.push({ name: file.name, size: file.size, path: filePath });
  renderUploadedFiles();
  // 不弹 toast：输入区文件条已即时显示文件名，成功与否一目了然
}

function renderUploadedFiles() {
  let container = document.getElementById('uploaded-files-bar');
  if (!container) {
    container = document.createElement('div');
    container.id = 'uploaded-files-bar';
    container.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;padding:4px 12px;';
    const inputArea = document.querySelector('.chat-input-area');
    inputArea.insertBefore(container, inputArea.firstChild);
  }
  if (!state.uploadedFiles || state.uploadedFiles.length === 0) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }
  container.style.display = 'flex';
  container.innerHTML = state.uploadedFiles.map((f, i) => `
    <div style="display:flex;align-items:center;gap:4px;padding:4px 10px;background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.3);border-radius:16px;font-size:12px;color:var(--text-primary);">
      <span style="display:inline-flex;align-items:center;gap:6px;">${window.ElIcons.ICONS.document} ${f.name}</span>
      <span style="color:var(--text-muted);font-size:11px;">(${(f.size/1024).toFixed(1)}KB)</span>
      <button onclick="removeUploadedFile(${i})" style="background:none;border:none;color:var(--text-muted);cursor:pointer;padding:0 2px;font-size:14px;line-height:1;">×</button>
    </div>
  `).join('');
}

function removeUploadedFile(index) {
  state.uploadedFiles.splice(index, 1);
  renderUploadedFiles();
}


// ==================== 多角色智能体管理 ====================
async function loadAgentRoles() {
  try {
    state.agentRoles = await window.api.getAgentRoles();
    renderRoleList();
    updateCurrentRoleDisplay();
  } catch (e) {
    console.error('加载角色列表失败:', e);
  }
}

function renderRoleList() {
  const list = document.getElementById('role-list');
  if (!list) return;
  list.innerHTML = state.agentRoles.map(role => `
    <div class="role-item ${role.id === state.currentRoleId ? 'active' : ''}" data-role-id="${role.id}">
      <div class="role-item-icon">${window.RoleIcons ? window.RoleIcons.getRoleIcon(role.id, '28px') : window.ElIcons.ICONS.ai}</div>
      <div class="role-item-info">
        <div class="role-item-name">${role.name}</div>
        <div class="role-item-desc">${role.description || ''}</div>
      </div>
      ${role.isPreset ? '' : '<button class="role-item-edit" data-edit="${role.id}">编辑</button><button class="role-item-delete" data-delete="${role.id}">×</button>'}
    </div>
  `).join('');

  // 角色点击选择
  list.querySelectorAll('.role-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('role-item-edit') || e.target.classList.contains('role-item-delete')) return;
      const roleId = item.dataset.roleId;
      selectRole(roleId);
      document.getElementById('role-select-panel').style.display = 'none';
    });
  });

  // 编辑按钮
  list.querySelectorAll('.role-item-edit').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const roleId = btn.dataset.edit;
      openRoleEditModal(roleId);
    });
  });

  // 删除按钮
  list.querySelectorAll('.role-item-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const roleId = btn.dataset.delete;
      if (await window.AppDialog.confirm({ type: 'warning', title: '删除角色', message: '确定删除这个角色吗？', buttons: ['删除', '取消'] })) {
        await window.api.deleteAgentRole(roleId);
        if (state.currentRoleId === roleId) state.currentRoleId = 'general';
        await loadAgentRoles();
      }
    });
  });
}

function selectRole(roleId) {
  state.currentRoleId = roleId;
  // 保存到 localStorage
  try { localStorage.setItem('ai-lobster-current-role', roleId); } catch(e) {}
  updateCurrentRoleDisplay();
  renderRoleList();
  const role = state.agentRoles.find(r => r.id === roleId);
  if (role) {
    const roleIcon = window.RoleIcons ? window.RoleIcons.getRoleIcon(role.id, '16px') : '';
    showToast('已切换角色', roleIcon + ' ' + role.name, 'success', { useHtml: true });
  }
}

function updateCurrentRoleDisplay() {
  const role = state.agentRoles.find(r => r.id === state.currentRoleId) || state.agentRoles[0];
  const emojiEl = document.getElementById('current-role-emoji');
  if (emojiEl && role) {
    if (window.RoleIcons) {
      emojiEl.innerHTML = window.RoleIcons.getRoleIcon(role.id, '18px');
      emojiEl.style.display = 'inline-flex';
      emojiEl.style.alignItems = 'center';
      emojiEl.style.justifyContent = 'center';
    } else {
      emojiEl.innerHTML = window.RoleIcons ? window.RoleIcons.getRoleIcon(role.id, '24px') : window.ElIcons.ICONS.ai;
    }
  }
  // 更新工具栏图标样式（浅色模式下使用描边式）
  updateToolbarIconStyles();
  // 深色模式 Logo 用粉色版，浅色模式用原色
  updateLogoColors();
}

// 更新工具栏图标样式：浅色模式下闪电/机器人/扳手使用描边式，深色模式恢复填充式
function updateToolbarIconStyles() {
  // 工具栏图标样式主要通过CSS控制（[data-theme="light"] #btn-xxx）
  // 此函数作为备用，确保RoleIcons图标的颜色正确
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const roleBtn = document.getElementById('btn-role-select');
  if (roleBtn) {
    const roleIcon = roleBtn.querySelector('.role-svg-icon');
    if (roleIcon) {
      if (isLight) {
        roleIcon.style.color = '#1a1a2e';
      } else {
        roleIcon.style.color = '';
      }
    }
  }
}

function openRoleEditModal(roleId) {
  const modal = document.getElementById('role-edit-modal');
  const isNew = !roleId;
  const defaultTools = state.agentTools.length
    ? state.agentTools.map(t => t.name)
    : ['run_shell', 'read_file', 'write_file', 'get_system_info', 'pet_action', 'web_search', 'web_fetch', 'http_request', 'file_search', 'directory_list', 'copy_file', 'move_file', 'create_directory', 'download_file', 'get_current_time', 'calculator', 'check_url', 'open_url'];
  const role = isNew ? { id: 'custom_' + Date.now(), name: '', emoji: '', description: '', systemPrompt: '', tools: defaultTools, temperature: 0.7, maxIterations: 0 } : state.agentRoles.find(r => r.id === roleId);
  if (!role) return;

  document.getElementById('role-edit-title').textContent = isNew ? '新建角色' : '编辑角色';
  document.getElementById('role-edit-name').value = role.name || '';
  document.getElementById('role-edit-emoji').value = role.emoji || '';
  document.getElementById('role-edit-desc').value = role.description || '';
  document.getElementById('role-edit-prompt').value = role.systemPrompt || '';
  document.getElementById('role-edit-temp').value = role.temperature || 0.7;
  document.getElementById('role-edit-iter').value = (role.maxIterations === undefined || role.maxIterations === null) ? 0 : role.maxIterations;

  document.querySelectorAll('.role-tool-check').forEach(cb => {
    cb.checked = (role.tools || []).includes(cb.value);
  });

  modal.style.display = 'flex';
  modal.dataset.editingId = isNew ? role.id : roleId;
  modal.dataset.isNew = isNew ? '1' : '0';
}

function closeRoleEditModal() {
  document.getElementById('role-edit-modal').style.display = 'none';
}

async function saveRoleFromModal() {
  const modal = document.getElementById('role-edit-modal');
  const id = modal.dataset.editingId;
  const isNew = modal.dataset.isNew === '1';
  const name = document.getElementById('role-edit-name').value.trim();
  if (!name) { await window.AppDialog.alert({ type: 'warning', title: '提示', message: '角色名称不能为空' }); return; }

  const tools = Array.from(document.querySelectorAll('.role-tool-check:checked')).map(cb => cb.value);
  const role = {
    id,
    name,
    emoji: document.getElementById('role-edit-emoji').value.trim() || '',
    description: document.getElementById('role-edit-desc').value.trim(),
    systemPrompt: document.getElementById('role-edit-prompt').value.trim() || null,
    tools,
    temperature: parseFloat(document.getElementById('role-edit-temp').value) || 0.7,
    maxIterations: Math.max(0, parseInt(document.getElementById('role-edit-iter').value) || 0)
  };

  await window.api.saveAgentRole(role);
  closeRoleEditModal();
  await loadAgentRoles();
  showToast('保存成功', role.emoji + ' ' + role.name, 'success');
}

// ==================== 工具清单（从主进程 AGENT_TOOLS 动态获取） ====================
// 这两个钩子由 setupEventListeners 注入（设置持久化函数定义在它内部，外部拿不到）
let applyAgentSettings = null;
let onAgentToolToggle = null;

async function loadAgentTools() {
  try {
    const tools = await window.api.getAgentTools();
    if (Array.isArray(tools) && tools.length) state.agentTools = tools;
  } catch (e) {
    console.warn('加载工具清单失败:', e);
  }
  renderAgentToolList();
  renderRoleToolList();
  // 渲染完成后重新套用已保存的勾选状态，并绑定 change 事件
  if (typeof applyAgentSettings === 'function') applyAgentSettings();
  document.querySelectorAll('.agent-tool-check').forEach(cb => {
    if (!cb.dataset.bound) {
      cb.dataset.bound = '1';
      cb.addEventListener('change', () => {
        if (typeof onAgentToolToggle === 'function') onAgentToolToggle();
      });
    }
  });
}

// ── 工具名脱敏层 ────────────────────────────────────────────────
// 规则：界面上一律显示「人类可读的展示名」，任何情况下都不回退成内部函数名（xxx_yyy）。
//   · 中文界面 → 中文短语（准备桌面分身）
//   · 英文界面 → 英文短语（Prepare Desktop Clone）
//   两者都不是原名本身；重点是「脱敏」，不是「强制中文」。
// 不依赖 i18n 的 tool.* 键：语言包若漏登记就会回落到原名（这正是原先泄漏的原因）。
const TOOL_LABELS = {
  zh: {
    // 命令 / 文件
    run_shell: '执行命令', execute_command: '执行命令', execute_shell: '执行命令',
    read_file: '读取文件', write_file: '写入文件',
    copy_file: '复制文件', move_file: '移动文件',
    create_directory: '创建目录', download_file: '下载文件',
    file_search: '搜索文件',
    directory_list: '列出目录', list_directory: '列出目录',
    // 系统 / 宠物
    get_system_info: '系统信息', get_current_time: '当前时间',
    calculator: '计算器', pet_action: '宠物动作',
    // 网络
    web_search: '网络搜索', web_fetch: '抓取网页',
    http_request: 'HTTP 请求', check_url: '检查链接', open_url: '打开链接',
    // 待办 / 交互 / 记忆
    todo_write: '整理待办', todo_update: '更新进度', todo_read: '读取待办',
    ask_user: '询问用户',
    memory_save: '记忆写入', memory_search: '记忆检索',
    memory_list: '记忆列表', memory_delete: '记忆删除',
    // 视觉 / 控制
    capture_window: '窗口截图', verify_ui: '界面自验证', analyze_screenshot: '看图分析',
    control_computer: '控制电脑',
    // 桌面分身 / 项目启动（原先 i18n 未登记，会直接漏出原名）
    ensure_clone_desktop: '准备桌面分身',
    launch_in_clone: '分身启动程序',
    launch_project: '启动项目',
  },
  en: {
    run_shell: 'Run Command', execute_command: 'Run Command', execute_shell: 'Run Command',
    read_file: 'Read File', write_file: 'Write File',
    copy_file: 'Copy File', move_file: 'Move File',
    create_directory: 'Create Folder', download_file: 'Download File',
    file_search: 'Search Files',
    directory_list: 'List Folder', list_directory: 'List Folder',
    get_system_info: 'System Info', get_current_time: 'Current Time',
    calculator: 'Calculator', pet_action: 'Pet Action',
    web_search: 'Web Search', web_fetch: 'Fetch Webpage',
    http_request: 'HTTP Request', check_url: 'Check Link', open_url: 'Open Link',
    todo_write: 'Plan Tasks', todo_update: 'Update Task', todo_read: 'Read Tasks',
    ask_user: 'Ask User',
    memory_save: 'Save Memory', memory_search: 'Search Memory',
    memory_list: 'List Memory', memory_delete: 'Delete Memory',
    capture_window: 'Capture Window', verify_ui: 'Verify UI', analyze_screenshot: 'Analyze Screenshot',
    control_computer: 'Control Computer',
    ensure_clone_desktop: 'Prepare Desktop Clone',
    launch_in_clone: 'Launch App in Clone',
    launch_project: 'Launch Project',
  }
};
// 未登记工具的通用占位：宁可笼统，也不暴露原名
const TOOL_FALLBACK = { zh: '工具调用', en: 'Tool Call' };

/** 取当前界面语言（'zh' / 'en'） */
function toolLang() {
  try {
    if (typeof getCurrentLang === 'function') {
      return String(getCurrentLang() || '').toLowerCase().indexOf('en') === 0 ? 'en' : 'zh';
    }
    if (typeof window !== 'undefined' && window.document) {
      return String(window.document.documentElement.getAttribute('lang') || '')
        .toLowerCase().indexOf('en') === 0 ? 'en' : 'zh';
    }
  } catch (e) { /* 取不到就按中文 */ }
  return 'zh';
}

/** 唯一的工具名 → 展示名出口。未知名返回占位，绝不返回原名。 */
function toolDisplayName(name) {
  const lang = toolLang();
  if (!name) return TOOL_FALLBACK[lang];
  const dict = TOOL_LABELS[lang] || TOOL_LABELS.zh;
  return dict[name] || TOOL_FALLBACK[lang] || TOOL_FALLBACK.zh;
}

/** 文本级脱敏：把思考/说明里写出的内部函数名替换成当前语言的展示名。 */
function desensitizeToolText(text) {
  if (!text) return text;
  const dict = TOOL_LABELS[toolLang()] || TOOL_LABELS.zh;
  let out = '' + text;
  try {
    for (const k of Object.keys(dict)) {
      if (out.indexOf(k) === -1) continue;   // 先快速跳过，避免每次都跑正则
      // 只替换「独立标识符」：前后不能紧邻字母/数字/下划线，防止误伤 run_shellLike 之类的普通文本
      out = out.replace(
        new RegExp('(^|[^A-Za-z0-9_])' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9_])', 'g'),
        '$1' + dict[k]
      );
    }
  } catch (e) { /* 脱敏失败也不能阻断渲染 */ }
  return out;
}

function toolLabel(name) {
  return toolDisplayName(name);
}

// 根据工具名称和参数生成简短描述（不显示完整参数，只说明干了什么）
function toolDescription(name, args) {
  if (!args) return '';
  try {
    const shortPath = function(p) { return ('' + p).split(/[\\\\/]/).pop(); };
    const shortUrl = function(u) { return ('' + u).replace('https://', '').replace('http://', '').slice(0, 40); };
    switch (name) {
      case 'run_shell':
      case 'execute_command':
        return args.command ? ('' + args.command).slice(0, 50) : '';
      case 'read_file':
      case 'write_file':
        return args.path ? shortPath(args.path) : '';
      case 'directory_list':
      case 'list_directory':
        return args.path ? ('' + args.path) : '';
      case 'file_search':
      case 'web_search':
        return args.query ? ('' + args.query).slice(0, 40) : '';
      case 'web_fetch':
      case 'http_request':
      case 'open_url':
      case 'check_url':
        return args.url ? shortUrl(args.url) : '';
      case 'download_file':
        return args.url ? ('' + args.url).split('/').pop() : (args.path ? shortPath(args.path) : '');
      case 'copy_file':
      case 'move_file':
        return args.source ? shortPath(args.source) : '';
      case 'create_directory':
        return args.path ? shortPath(args.path) : '';
      case 'calculator':
        return args.expression ? ('' + args.expression).slice(0, 40) : '';
      case 'pet_action':
        return args.action ? ('' + args.action) : '';
      case 'memory_save':
        return args.key ? ('' + args.key).slice(0, 30) : '';
      case 'memory_search':
        return args.query ? ('' + args.query).slice(0, 30) : '';
      default:
        for (const k of Object.keys(args)) {
          const v = args[k];
          if (typeof v === 'string' && v.length > 0 && v.length < 60) return v.slice(0, 40);
        }
        return '';
    }
  } catch (e) { return ''; }
}

// 根据工具名称返回对应的SVG图标
function getToolIcon(name) {
  const iconMap = {
    'run_shell': 'terminal',
    'write_file': 'edit',
    'read_file': 'document',
    'get_system_info': 'cpu',
    'pet_action': 'lobster',
    'web_search': 'search',
    'web_fetch': 'globe',
    'http_request': 'refresh',
    'file_search': 'files',
    'directory_list': 'list',
    'copy_file': 'copy',
    'move_file': 'move',
    'create_directory': 'folderPlus',
    'download_file': 'download',
    'get_current_time': 'clock',
    'calculator': 'calculator',
    'check_url': 'eye',
    'open_url': 'externalLink',
    // 长期记忆 / 界面自验证
    'memory_save': 'save',
    'memory_search': 'search',
    'memory_list': 'brain',
    'memory_delete': 'delete',
    'capture_window': 'image',
    'verify_ui': 'success',
    'analyze_screenshot': 'eye',
    // 待办事项
    'todo_write': 'list',
    'todo_update': 'success',
    'todo_read': 'list',
  };
  const iconName = iconMap[name] || 'terminal';
  return window.ElIcons.ICONS[iconName] || window.ElIcons.ICONS.terminal;
}

function renderAgentToolList() {
  const box = document.getElementById('agent-tools-list');
  if (!box || !state.agentTools.length) return;
  box.innerHTML = state.agentTools.map(t => `
    <label class="agent-tool-item" title="${desensitizeToolText(t.description || '')}">
      <input type="checkbox" class="agent-tool-check" value="${t.name}" checked>
      <span>${toolDisplayName(t.name)}</span>
    </label>`).join('');
}

function renderRoleToolList() {
  const box = document.getElementById('role-edit-tools');
  if (!box || !state.agentTools.length) return;
  box.innerHTML = state.agentTools.map(t => `
    <label style="display:flex;align-items:center;gap:4px;font-size:12px;color:var(--text-primary);cursor:pointer;" title="${t.description || ''}">
      <input type="checkbox" value="${t.name}" class="role-tool-check"> ${toolDisplayName(t.name)}
    </label>`).join('');
}

// ==================== AI 长期记忆（Agent 设置面板「AI 记忆」） ====================
// 记忆由主进程的 memory_* 工具写入，这里只做查看/删除/清空，方便用户知道 AI 记了什么。
let memoryCache = [];
const MEMORY_KIND_LABEL = { fact: '事实', preference: '偏好', project: '项目', fix: '修复经验', note: '备注' };

async function loadMemories() {
  const box = document.getElementById('agent-memory-list');
  if (!box) return;
  box.innerHTML = '<div class="agent-memory-empty">加载中…</div>';
  try {
    // ★ 必须传 workdir：选了项目要看「该项目 .ai_workspace/memory/memory.md」的作用域，
    // 不传会让主进程读全局库——项目里有记忆也显示为空（踩过）。
    const items = await window.api.memory.list({ limit: 100, workdir: state.workdir || '' });
    memoryCache = Array.isArray(items) ? items : [];
  } catch (e) {
    console.warn('加载 AI 记忆失败:', e);
    memoryCache = [];
    box.innerHTML = '<div class="agent-memory-empty">读取记忆失败，请查看日志</div>';
    return;
  }
  renderMemoryList();
}

function renderMemoryList() {
  const box = document.getElementById('agent-memory-list');
  if (!box) return;
  box.innerHTML = '';
  if (!memoryCache.length) {
    const empty = document.createElement('div');
    empty.className = 'agent-memory-empty';
    empty.textContent = '还没有记忆。让 AI「记住…」之后，会显示在这里。';
    box.appendChild(empty);
    return;
  }
  // 用 DOM 拼装（而非 innerHTML 模板）——记忆正文是模型写的，可能含 < > 等字符
  for (const m of memoryCache) {
    const row = document.createElement('div');
    row.className = 'agent-memory-item';

    const body = document.createElement('div');
    body.className = 'agent-memory-body';

    const text = document.createElement('div');
    text.className = 'agent-memory-text';
    text.textContent = m.text;
    body.appendChild(text);

    const meta = document.createElement('div');
    meta.className = 'agent-memory-meta';
    const kind = document.createElement('span');
    kind.className = 'agent-memory-tag kind';
    kind.textContent = MEMORY_KIND_LABEL[m.kind] || '备注';
    meta.appendChild(kind);
    if (m.pinned) {
      const pin = document.createElement('span');
      pin.className = 'agent-memory-tag pinned';
      pin.textContent = '置顶';
      meta.appendChild(pin);
    }
    for (const t of (m.tags || [])) {
      const tag = document.createElement('span');
      tag.className = 'agent-memory-tag';
      tag.textContent = t;
      meta.appendChild(tag);
    }
    body.appendChild(meta);
    row.appendChild(body);

    const del = document.createElement('button');
    del.className = 'agent-memory-del';
    del.type = 'button';
    del.title = '删除这条记忆';
    del.textContent = '×';
    del.dataset.memoryId = m.id;
    row.appendChild(del);

    box.appendChild(row);
  }
}

async function deleteMemory(id) {
  try {
    await window.api.memory.remove(id);
    memoryCache = memoryCache.filter(m => m.id !== id);
    renderMemoryList();
    showToast('已删除记忆', '', 'success');
  } catch (e) {
    showToast('删除失败', String(e && e.message || e), 'error');
  }
}

async function clearMemories() {
  if (!memoryCache.length) { showToast('没有可清空的记忆', '', 'info'); return; }
  const ok = await window.api.confirm({
    type: 'warning',
    title: '清空 AI 记忆',
    message: '确定清空全部 ' + memoryCache.length + ' 条长期记忆吗？',
    detail: '清空后 AI 不再记得这些跨会话信息（本次对话上下文不受影响）。此操作不可恢复。'
  });
  if (!ok) return;
  await window.api.memory.clear(state.workdir || '');
  memoryCache = [];
  renderMemoryList();
  showToast('已清空全部记忆', '', 'success');
}

function setupMemoryPanel() {
  const box = document.getElementById('agent-memory-list');
  if (!box) return;
  // 删除：事件委托（列表是动态重建的）
  box.addEventListener('click', (e) => {
    const btn = e.target.closest('.agent-memory-del');
    if (btn && btn.dataset.memoryId) deleteMemory(btn.dataset.memoryId);
  });
  const refreshBtn = document.getElementById('btn-memory-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', () => loadMemories());
  const clearBtn = document.getElementById('btn-memory-clear');
  if (clearBtn) clearBtn.addEventListener('click', () => clearMemories());
}

function initRoleManagement() {
  // 恢复上次选择的角色
  try {
    const saved = localStorage.getItem('ai-lobster-current-role');
    if (saved) state.currentRoleId = saved;
  } catch(e) {}

  loadAgentRoles();
  loadAgentTools();
  setupMemoryPanel();

  // 角色选择按钮
  document.getElementById('btn-role-select')?.addEventListener('click', () => {
    const panel = document.getElementById('role-select-panel');
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  });

  // 关闭角色面板
  document.getElementById('btn-role-panel-close')?.addEventListener('click', () => {
    document.getElementById('role-select-panel').style.display = 'none';
  });

  // 点击外部关闭角色面板
  document.addEventListener('click', (e) => {
    const panel = document.getElementById('role-select-panel');
    const btn = document.getElementById('btn-role-select');
    if (panel && panel.style.display !== 'none' && !panel.contains(e.target) && !btn.contains(e.target)) {
      panel.style.display = 'none';
    }
  });

  // 管理角色按钮
  document.getElementById('btn-manage-roles')?.addEventListener('click', () => {
    document.getElementById('role-select-panel').style.display = 'none';
    openRoleEditModal(null);
  });

  // 角色编辑弹窗
  document.getElementById('role-edit-cancel')?.addEventListener('click', closeRoleEditModal);
  document.getElementById('role-edit-save')?.addEventListener('click', saveRoleFromModal);
}


// ==================== 模型图标显示辅助 ====================
function updateProviderIconDisplay() {
  const provider = state.cloudProviders.find(p => p.id === state.activeProviderId);
  const hasIcon = !!(provider && window.ModelIcons);
  const iconId = hasIcon ? window.ModelIcons.detectProviderIcon(provider) : 'default';

  // 对话页面图标：没有选中模型时隐藏占位，避免空方块
  const chatIcon = document.getElementById('chat-provider-icon');
  if (chatIcon) {
    if (!provider) {
      chatIcon.style.display = 'none';
      chatIcon.innerHTML = '';
    } else {
      chatIcon.style.display = 'inline-flex';
      if (window.ModelIcons) {
        chatIcon.innerHTML = window.ModelIcons.renderIconHtml(iconId, '', '20px');
        window.ModelIcons.updateIconsInContainer(chatIcon);
      }
    }
  }

  // 配置页面图标
  const configIcon = document.getElementById('active-provider-icon');
  if (configIcon) {
    if (!provider) {
      configIcon.style.display = 'none';
      configIcon.innerHTML = '';
    } else {
      configIcon.style.display = 'inline-flex';
      if (window.ModelIcons) {
        configIcon.innerHTML = window.ModelIcons.renderIconHtml(iconId, '', '20px');
        window.ModelIcons.updateIconsInContainer(configIcon);
      }
    }
  }
}

// 选择器变化时更新图标
document.addEventListener('change', (e) => {
  if (e.target.id === 'chat-provider' || e.target.id === 'active-provider') {
    setTimeout(updateProviderIconDisplay, 50);
  }
});
