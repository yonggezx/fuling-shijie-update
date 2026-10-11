/**
 * 多模态 & 多 Agent 协同 —— 自动识别模式
 *
 * 设计原则：不新增显眼按钮，全部自动触发
 * 1. 粘贴/拖拽图片 → 自动识别为多模态附件，发送时自动走视觉模型
 * 2. 输入复杂任务 → 自动检测并提示是否启用多Agent协同
 * 3. 与 app.js 完全解耦，通过捕获阶段事件拦截，不修改原有逻辑
 */
(function () {
  'use strict';

  // ===== 状态 =====
  const attachedImages = []; // [{path, name, dataUrl}]
  let maSuggested = false;   // 本次输入是否已提示过多Agent（避免重复弹）
  let maRunning = false;
  let maPresetsCache = null;
  let mmStreamSeq = 0;       // 多模态流式接收序号（新发送使旧监听器事件失效，防串扰）

  // ===== 工具 =====
  function $(id) { return document.getElementById(id); }
  function getActiveConv() {
    return typeof getActiveConversation === 'function' ? getActiveConversation() : null;
  }
  function toast(title, msg, type) {
    if (typeof showToast === 'function') showToast(title, msg, type || 'info');
  }
  function isImageFile(file) {
    if (!file) return false;
    if (file.type && file.type.startsWith('image/')) return true;
    return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name || '');
  }

  // ================================================================
  // 第一部分：图片自动识别（粘贴 / 拖拽）
  // ================================================================

  function initImageAutoDetect() {
    const input = $('chat-input');
    const chatArea = $('chat-messages');
    const inputArea = document.querySelector('.chat-input-area');
    if (!input) return;

    // --- 粘贴拦截（捕获阶段）---
    // app.js 在冒泡阶段处理 paste 并调用 addUploadedFile；
    // 我们在捕获阶段优先拦截图片，阻止冒泡，图片走多模态而非普通文件上传。
    input.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      const imageFiles = [];
      for (const item of Array.from(items)) {
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f && isImageFile(f)) imageFiles.push(f);
        }
      }
      if (imageFiles.length === 0) return; // 非图片，放行给 app.js 处理
      e.preventDefault();
      e.stopPropagation();
      imageFiles.forEach(f => addImageAttachment(f));
    }, true);

    // --- 拖拽拦截（捕获阶段）---
    // chatArea 和 inputArea 都可能收到 drop
    [chatArea, inputArea].forEach(el => {
      if (!el) return;
      el.addEventListener('drop', (e) => {
        const files = Array.from(e.dataTransfer?.files || []);
        const imageFiles = files.filter(isImageFile);
        const otherFiles = files.filter(f => !isImageFile(f));
        if (imageFiles.length === 0) return; // 无图片，放行
        e.preventDefault();
        e.stopPropagation();
        imageFiles.forEach(f => addImageAttachment(f));
        // 非图片文件仍交给 app.js 处理（模拟普通文件上传）
        if (otherFiles.length > 0 && typeof addUploadedFile === 'function') {
          otherFiles.forEach(f => addUploadedFile(f));
        }
      }, true);
    });
  }

  function addImageAttachment(file) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      attachedImages.push({
        path: file.path || file.name,
        name: file.name,
        dataUrl: ev.target.result,
        size: file.size
      });
      renderImageBar();
      // 不弹 toast：预览条已即时显示缩略图，成功与否一目了然
    };
    reader.readAsDataURL(file);
  }

  function renderImageBar() {
    let bar = $('image-preview-bar');
    let list = $('image-preview-list');
    if (!bar || !list) {
      // 动态创建预览条（如果 HTML 中没有）
      const inputArea = document.querySelector('.chat-input-area');
      if (!inputArea) return;
      bar = document.createElement('div');
      bar.id = 'image-preview-bar';
      bar.className = 'image-preview-bar';
      list = document.createElement('div');
      list.id = 'image-preview-list';
      list.className = 'image-preview-list';
      const clearBtn = document.createElement('button');
      clearBtn.className = 'image-clear-btn';
      clearBtn.id = 'btn-clear-images';
      clearBtn.textContent = '×';
      clearBtn.title = '清除所有图片';
      clearBtn.addEventListener('click', clearImages);
      bar.appendChild(list);
      bar.appendChild(clearBtn);
      // 插入到 input-tools 之后、chat-input-wrapper 之前
      const wrapper = inputArea.querySelector('.chat-input-wrapper');
      if (wrapper) inputArea.insertBefore(bar, wrapper);
      else inputArea.appendChild(bar);
    }
    if (attachedImages.length === 0) {
      bar.style.display = 'none';
      return;
    }
    bar.style.display = 'flex';
    list.innerHTML = '';
    attachedImages.forEach((img, idx) => {
      const item = document.createElement('div');
      item.className = 'image-preview-item';
      item.title = img.name;
      item.innerHTML = '<img src="' + img.dataUrl + '" alt="' + img.name + '">' +
        '<button class="image-preview-remove">×</button>';
      item.querySelector('.image-preview-remove').addEventListener('click', (e) => {
        e.stopPropagation();
        attachedImages.splice(idx, 1);
        renderImageBar();
      });
      list.appendChild(item);
    });
  }

  function clearImages() {
    attachedImages.length = 0;
    renderImageBar();
  }

  // ================================================================
  // 第二部分：发送时自动走多模态
  // ================================================================

  function initMultimodalSend() {
    const sendBtn = $('btn-send');
    const input = $('chat-input');
    if (!sendBtn || !input) return;

    // 捕获阶段拦截发送：有图片附件时走多模态通道
    const handler = (e) => {
      if (attachedImages.length === 0 || state.isStreaming) return;
      e.stopPropagation();
      e.preventDefault();
      sendMultimodal();
    };
    sendBtn.addEventListener('click', handler, true);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && attachedImages.length > 0 && !state.isStreaming) {
        e.stopPropagation();
        e.preventDefault();
        sendMultimodal();
      }
    }, true);
  }

  async function sendMultimodal() {
    const input = $('chat-input');
    const content = (input.value || '').trim();
    if (!content && attachedImages.length === 0) return;

    const conv = getActiveConv();
    if (!conv) { toast('无法发送', '当前没有活跃会话', 'error'); return; }

    // ⚠️ 不做任何发送前阻塞检测（视觉能力检测由主进程在真实请求链路上零阻塞判定）。
    // 此前这里 await visionDetect（首次最多 8s），点发送像没反应一样卡住。

    // 合并 app.js 上传按钮/拖拽进来的普通文件：把 read_file 提示并入同一条请求，
    // 避免「文字+图片走多模态、文件被静默丢掉」或「文字和附件分批」的分裂体验
    let requestContent = content;
    if (state.uploadedFiles && state.uploadedFiles.length > 0) {
      const fileList = state.uploadedFiles.map(f => `- ${f.name}（路径：${f.path}）`).join('\n');
      requestContent = content + (content ? '\n\n' : '') +
        `[用户同时上传了以下文件，请使用 read_file 工具读取文件内容后再回答：]\n${fileList}`;
      state.uploadedFiles = [];
      if (typeof renderUploadedFiles === 'function') renderUploadedFiles();
    }

    // 图片路径：粘贴的截图没有真实路径（clipboard File 无 .path），用预览 dataUrl 兜底
    // （buildMultimodalUserMessage 对 data: URL 直接透传）；有真实路径的仍走路径（主进程压缩）
    const imagePaths = attachedImages.map(i => {
      const hasRealPath = i.path && i.path !== i.name && !i.path.startsWith('data:');
      return hasRealPath ? i.path : (i.dataUrl || i.path);
    });

    // 构建用户消息（带图片标记，用于聊天记录展示）
    const userMsg = {
      role: 'user',
      content: content,
      time: Date.now(),
      images: attachedImages.map(i => ({ path: i.path, name: i.name, dataUrl: i.dataUrl }))
    };
    conv.messages.push(userMsg);
    state.chatHistory = conv.messages;
    appendChatMessage(userMsg);

    // 清空输入和图片
    input.value = '';
    input.style.height = 'auto';
    clearImages();

    // UI 状态
    state.isStreaming = true;
    const sendBtn = $('btn-send');
    const stopBtn = $('btn-stop');
    if (sendBtn) { sendBtn.disabled = true; sendBtn.style.display = 'none'; }
    if (stopBtn) stopBtn.style.display = '';

    // AI 占位消息
    const aiMsg = { role: 'ai', content: '', time: Date.now(), isMultimodal: true };
    conv.messages.push(aiMsg);
    state.chatHistory = conv.messages;
    const msgEl = appendChatMessage(aiMsg);
    const bubble = msgEl.querySelector('.chat-bubble');
    if (bubble) bubble.innerHTML = '<span style="color:#888;font-style:italic;">多模态模型识别中...</span>';

    try {
      const useAgent = $('agent-mode')?.checked;
      const thinkMode = $('agent-think-mode')?.checked || false;
      const enabledTools = Array.from(document.querySelectorAll('.agent-tool-check:checked')).map(cb => cb.value);

      // ★ 流式接收：主进程 multimodalChat 会广播 agent-content/agent-reasoning/agent-done
      //   增量事件（带 conversationId），边生成边渲染，不再傻等完整结果。
      //   用序号防串扰：新发送会使旧监听器的事件失效。
      const seq = ++mmStreamSeq;
      let mmStreamContent = '';
      let mmStreamReasoning = '';
      // 思考面板 + 正文双栏（思考到哪写到哪）：折叠面板实时流出思考，
      // 正文在其下方同步流出，与主界面 Agent 消息行为一致
      const renderMmStream = () => {
        let html = '';
        if (mmStreamReasoning) {
          html += '<div style="border-left:2px solid var(--border-color,#444);padding:2px 0 2px 10px;margin-bottom:8px;">'
            + '<div style="color:var(--text-muted,#888);font-size:12px;margin-bottom:4px;">深度思考</div>'
            + '<div style="color:var(--text-secondary,#a8b0c0);font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:180px;overflow-y:auto;">'
            + escapeHtml(mmStreamReasoning) + '</div></div>';
        }
        if (mmStreamContent) {
          html += renderMarkdown(mmStreamContent);
        }
        bubble.innerHTML = html;
        bubble.dataset.originalContent = mmStreamContent;
        const sc = bubble.querySelector('div[style*="overflow-y:auto"]');
        if (sc) sc.scrollTop = sc.scrollHeight;
      };
      const unsubStream = window.api.on ? window.api.on('ai:response', (data) => {
        if (seq !== mmStreamSeq) return;
        if (data.conversationId !== conv.id) return;
        if (!bubble) return;
        if (data.type === 'agent-reasoning') {
          mmStreamReasoning += data.text || '';
          renderMmStream();
        } else if (data.type === 'agent-content') {
          mmStreamContent += data.text || '';
          renderMmStream();
        }
      }) : null;

      // 历史消息（排除刚 push 的 userMsg 和 aiMsg）
      const historyMsgs = conv.messages
        .filter(m => m !== userMsg && m !== aiMsg)
        .map(m => ({ role: m.role === 'ai' ? 'assistant' : m.role, content: typeof m.content === 'string' ? m.content : '' }));
      historyMsgs.push({ role: 'user', content: requestContent });

      const result = await window.api.multimodalChat({
        messages: historyMsgs,
        images: imagePaths,
        conversationId: conv.id,
        providerId: state.activeProviderId,
        thinkMode,
        enabledTools: enabledTools.length ? enabledTools : undefined,
        roleId: state.currentRoleId,
        workdir: state.workdir || null
      });

      if (result && result.success) {
        aiMsg.content = result.content || mmStreamContent || '（无响应）';
        // 思考过程持久化（流式积累优先，主进程返回值兜底）
        aiMsg.reasoning = mmStreamReasoning || result.reasoning || '';
        if (bubble) {
          bubble.dataset.originalContent = aiMsg.content;
          bubble.innerHTML = renderMarkdown(aiMsg.content);
        }
      } else {
        const err = result?.error || '未知错误';
        aiMsg.content = '响应失败: ' + err;
        if (bubble) { bubble.textContent = aiMsg.content; bubble.style.color = '#ef4444'; }
        toast('多模态响应失败', err, 'error');
      }
    } catch (err) {
      aiMsg.content = '请求失败: ' + err.message;
      if (bubble) { bubble.textContent = aiMsg.content; bubble.style.color = '#ef4444'; }
      toast('请求失败', err.message, 'error');
    } finally {
      mmStreamSeq++; // 使本轮流式监听失效
      if (typeof unsubStream === 'function') unsubStream();
      state.isStreaming = false;
      if (sendBtn) { sendBtn.disabled = false; sendBtn.style.display = ''; }
      if (stopBtn) stopBtn.style.display = 'none';
      if (typeof saveConversations === 'function') saveConversations();
    }
  }

  // ================================================================
  // 第三部分：多Agent自动触发（复杂任务检测）
  // ================================================================

  // 复杂任务模式：匹配这些关键词/模式时提示多Agent协同
  const COMPLEX_PATTERNS = [
    // 多步骤流水线
    { re: /(写|生成|创建).*(并|然后|接着).*(审查|检查|测试|优化|润色|修改)/, preset: 'code-review', label: '编写+审查流水线' },
    { re: /(帮我|请).*(写|做|生成).*(并|同时).*(审查|测试|优化)/, preset: 'code-review', label: '编写+审查流水线' },
    // 研究分析
    { re: /(调研|研究|分析).*(报告|总结|方案)/, preset: 'research-report', label: '研究报告流水线' },
    { re: /(收集|查找|搜索).*(并|然后).*(分析|整理|总结)/, preset: 'research-report', label: '研究报告流水线' },
    // 多视角/对比
    { re: /(从多个角度|多方面|全方位|综合)分析/, preset: 'multi-perspective', label: '多视角并行分析' },
    { re: /(对比|比较|权衡).*(利弊|优缺点|优劣)/, preset: 'multi-perspective', label: '多视角并行分析' },
    { re: /(优势|劣势|优点|缺点).*(和|与).*(风险|机会|前景)/, preset: 'multi-perspective', label: '多视角并行分析' },
    // 辩论决策
    { re: /(要不要|是否应该|该不该).*(做|用|选择|买)/, preset: 'debate-decision', label: '正反辩论决策' },
    { re: /(讨论|辩论|探讨).*(一下|一番).*(可行性|是否)/, preset: 'debate-decision', label: '正反辩论决策' },
    // 创意写作
    { re: /(写一篇|创作|构思).*(文章|故事|文案|小说|剧本)/, preset: 'creative-writing', label: '创意写作流水线' },
    { re: /(大纲|框架).*(然后|接着|再).*(写|扩写|填充)/, preset: 'creative-writing', label: '创意写作流水线' },
    // 代码相关
    { re: /(重构|重构代码|代码审查|code review)/i, preset: 'code-review', label: '代码审查流水线' },
    { re: /(实现|开发).*(功能|模块|系统).*(并|同时).*(测试|文档)/, preset: 'code-review', label: '编写+审查流水线' }
  ];

  function detectComplexTask(text) {
    if (!text || text.length < 8) return null;
    for (const p of COMPLEX_PATTERNS) {
      if (p.re.test(text)) return p;
    }
    return null;
  }

  function initAutoMultiAgent() {
    const input = $('chat-input');
    if (!input) return;

    // 输入时检测（防抖）
    let detectTimer = null;
    input.addEventListener('input', () => {
      clearTimeout(detectTimer);
      detectTimer = setTimeout(() => {
        const text = input.value.trim();
        const match = detectComplexTask(text);
        if (match && !maSuggested && !maRunning) {
          maSuggested = true;
          showMaSuggestion(match);
        }
        if (!match) maSuggested = false;
      }, 600);
    });

    // 发送时如果用户已确认使用多Agent，则拦截走协同
    const sendBtn = $('btn-send');
    if (sendBtn) {
      sendBtn.addEventListener('click', (e) => {
        if (maRunning) { e.stopPropagation(); e.preventDefault(); return; }
        const pending = $('ma-pending-bar');
        if (pending && pending.dataset.enabled === '1') {
          e.stopPropagation();
          e.preventDefault();
          triggerMultiAgent();
        }
      }, true);
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        const pending = $('ma-pending-bar');
        if (pending && pending.dataset.enabled === '1') {
          e.stopPropagation();
          e.preventDefault();
          triggerMultiAgent();
        }
      }
    }, true);
  }

  function showMaSuggestion(match) {
    let bar = $('ma-pending-bar');
    if (!bar) {
      const inputArea = document.querySelector('.chat-input-area');
      if (!inputArea) return;
      bar = document.createElement('div');
      bar.id = 'ma-pending-bar';
      bar.className = 'ma-pending-bar';
      bar.innerHTML =
        '<span class="ma-pending-text"></span>' +
        '<button class="ma-pending-btn ma-pending-yes">使用协同</button>' +
        '<button class="ma-pending-btn ma-pending-no">不用</button>';
      const wrapper = inputArea.querySelector('.chat-input-wrapper');
      if (wrapper) inputArea.insertBefore(bar, wrapper);
      else inputArea.appendChild(bar);

      bar.querySelector('.ma-pending-yes').addEventListener('click', () => {
        bar.dataset.enabled = '1';
        bar.style.background = 'rgba(79,70,229,0.15)';
        bar.querySelector('.ma-pending-text').textContent = '✓ 已启用多Agent协同，发送即执行';
        toast('已启用', '发送消息时将自动使用多Agent协同', 'success');
      });
      bar.querySelector('.ma-pending-no').addEventListener('click', () => {
        bar.dataset.enabled = '0';
        bar.style.display = 'none';
        maSuggested = false;
      });
    }
    bar.dataset.enabled = '0';
    bar.style.display = 'flex';
    bar.style.background = '';
    bar.querySelector('.ma-pending-text').textContent =
      '检测到复杂任务（' + match.label + '），是否启用多Agent协同？';
  }

  async function triggerMultiAgent() {
    if (maRunning) return;
    const input = $('chat-input');
    const task = (input?.value || '').trim();
    if (!task) return;

    const match = detectComplexTask(task);
    const presetId = match?.preset || 'code-review';

    maRunning = true;
    const bar = $('ma-pending-bar');
    if (bar) {
      bar.querySelector('.ma-pending-text').textContent = '多Agent协同执行中...';
      bar.querySelector('.ma-pending-yes').style.display = 'none';
      bar.querySelector('.ma-pending-no').style.display = 'none';
    }

    const conv = getActiveConv();
    const userMsg = { role: 'user', content: task, time: Date.now(), multiAgent: true };
    if (conv) {
      conv.messages.push(userMsg);
      state.chatHistory = conv.messages;
      appendChatMessage(userMsg);
    }
    input.value = '';
    input.style.height = 'auto';

    // AI 占位
    const aiMsg = { role: 'ai', content: '', time: Date.now(), isMultiAgent: true };
    if (conv) {
      conv.messages.push(aiMsg);
      state.chatHistory = conv.messages;
    }
    const msgEl = appendChatMessage(aiMsg);
    const bubble = msgEl.querySelector('.chat-bubble');
    if (bubble) bubble.innerHTML = '<span style="color:#888;font-style:italic;">多Agent协同工作中...</span>';

    try {
      // 加载预设（缓存）
      if (!maPresetsCache) {
        maPresetsCache = await window.api.multiAgentPresets();
      }

      // 构建输入（含对话上下文）
      const inputData = { text: task };
      if (conv && conv.messages.length > 2) {
        const ctx = conv.messages.slice(-8).filter(m => m !== userMsg && m !== aiMsg).map(m =>
          (m.role === 'user' ? '用户' : '助手') + ': ' + (typeof m.content === 'string' ? m.content : '')
        ).join('\n');
        inputData.text = '【对话上下文】\n' + ctx + '\n\n【当前任务】\n' + task;
      }

      const built = await window.api.multiAgentBuildPreset(presetId, state.activeProviderId, { input: inputData });
      if (!built || !built.success) throw new Error(built?.error || '构建协同配置失败');

      // 监听协同事件，更新气泡
      const offEvent = window.api.onMultiAgentEvent((data) => {
        if (!data || !bubble) return;
        const prefix = '> ';
        let line = '';
        switch (data.type) {
          case 'pipeline-stage': line = prefix + '[' + (data.agentName || '') + '] 正在执行...'; break;
          case 'pipeline-stage-done': line = prefix + '[' + (data.agentName || '') + '] 完成'; break;
          case 'parallel-start': line = prefix + '并行启动 ' + data.count + ' 个 Agent'; break;
          case 'debate-round': line = prefix + '辩论第 ' + data.round + ' 轮'; break;
          case 'aggregator-start': line = prefix + '整合者汇总中...'; break;
          case 'debate-judge-start': line = prefix + '裁判总结中...'; break;
          case 'tool-execute': line = prefix + (data.agentName || 'Agent') + ' 调用工具: ' + data.tool; break;
          default: return;
        }
        const existing = bubble.textContent;
        bubble.textContent = existing.replace(/多Agent协同工作中\.\.\./, '') + '\n' + line;
      });

      const result = await window.api.multiAgentOrchestrate(built.config);
      offEvent?.();

      if (result && result.success) {
        aiMsg.content = result.finalOutput || '（无结果）';
        if (bubble) {
          bubble.dataset.originalContent = aiMsg.content;
          bubble.innerHTML = renderMarkdown(aiMsg.content);
        }
        toast('协同完成', '多Agent协同已完成', 'success');
      } else {
        throw new Error(result?.error || '协同执行失败');
      }
    } catch (err) {
      aiMsg.content = '协同失败: ' + err.message;
      if (bubble) { bubble.textContent = aiMsg.content; bubble.style.color = '#ef4444'; }
      toast('协同失败', err.message, 'error');
    } finally {
      maRunning = false;
      if (bar) {
        bar.style.display = 'none';
        bar.dataset.enabled = '0';
        bar.querySelector('.ma-pending-yes').style.display = '';
        bar.querySelector('.ma-pending-no').style.display = '';
      }
      maSuggested = false;
      if (typeof saveConversations === 'function') saveConversations();
    }
  }

  // ================================================================
  // 初始化
  // ================================================================
  function init() {
    initImageAutoDetect();
    initMultimodalSend();
    initAutoMultiAgent();
    // 供 app.js 调用：上传按钮/其他入口选到图片文件时转发进多模态附件，
    // 统一走「文字+图片一次请求」的视觉通道（否则图片只变成 read_file 路径提示，
    // 模型只识别文字不识别图片）
    window.MultimodalUI = {
      addImageFile: addImageAttachment,
      hasImages: () => attachedImages.length > 0
    };
    console.log('[MultimodalAuto] 多模态自动识别 & 多Agent自动触发已加载');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
