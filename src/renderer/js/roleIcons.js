/**
 * 智能体角色 SVG 图标库
 * 用矢量图标替换 emoji，适配深色/浅色主题
 */
(function () {
  'use strict';

  // 每个角色的 SVG 图标（使用 currentColor 适配主题）
  const ROLE_SVG_ICONS = {
    // 通用助手 - 机器人/AI 芯片
    general: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
      <rect x="4" y="6" width="16" height="14" rx="3" stroke="currentColor" stroke-width="1.8"/>
      <path d="M12 6V3M8 3h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      <circle cx="9" cy="12" r="1.5" fill="currentColor"/>
      <circle cx="15" cy="12" r="1.5" fill="currentColor"/>
      <path d="M9 16h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      <path d="M2 12v3M22 12v3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </svg>`,

    // 程序员 - 代码括号
    coder: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
      <path d="M8 6L3 12l5 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M16 6l5 6-5 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M13 4l-2 16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </svg>`,

    // 研究员 - 放大镜+文档
    researcher: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z" stroke="currentColor" stroke-width="1.8"/>
      <path d="M8 8h6M8 12h6M8 16h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      <circle cx="17" cy="17" r="3.5" stroke="currentColor" stroke-width="1.8"/>
      <path d="M20 20l2 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </svg>`,

    // 文案写手 - 钢笔
    writer: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
      <path d="M12 19l7-7 3 3-7 7-3-3z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
      <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
      <path d="M2 2l7.586 7.586" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      <circle cx="11" cy="11" r="2" stroke="currentColor" stroke-width="1.8"/>
    </svg>`,

    // 运维工程师 - 齿轮+服务器
    ops: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
      <rect x="3" y="4" width="18" height="7" rx="2" stroke="currentColor" stroke-width="1.8"/>
      <rect x="3" y="13" width="18" height="7" rx="2" stroke="currentColor" stroke-width="1.8"/>
      <circle cx="7" cy="7.5" r="1.2" fill="currentColor"/>
      <circle cx="7" cy="16.5" r="1.2" fill="currentColor"/>
      <path d="M11 7.5h6M11 16.5h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </svg>`,

    // 数据分析师 - 柱状图
    analyst: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
      <path d="M3 3v18h18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      <rect x="6" y="10" width="3.5" height="8" rx="1" fill="currentColor" opacity="0.6"/>
      <rect x="10.5" y="6" width="3.5" height="12" rx="1" fill="currentColor" opacity="0.8"/>
      <rect x="15" y="13" width="3.5" height="5" rx="1" fill="currentColor"/>
      <path d="M6 6l3-2 3 2 3-3 3 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.5"/>
    </svg>`,

    // 翻译 - 地球
    translator: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
      <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/>
      <path d="M3 12h18" stroke="currentColor" stroke-width="1.8"/>
      <ellipse cx="12" cy="12" rx="4.2" ry="9" stroke="currentColor" stroke-width="1.8"/>
    </svg>`,

    // 旅行 - 指南针
    travel: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
      <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/>
      <path d="M15.8 8.2l-2.4 5.6-5.6 2.4 2.4-5.6 5.6-2.4z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
      <circle cx="12" cy="12" r="1" fill="currentColor"/>
    </svg>`,

    // 通用自定义智能体 - 星形
    custom: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
      <path d="M12 3l2.3 5.7L20 11l-5.7 2.3L12 19l-2.3-5.7L4 11l5.7-2.3z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
      <circle cx="19" cy="5" r="1.1" fill="currentColor"/>
    </svg>`,

    // 默认图标
    default: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
      <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/>
      <path d="M12 8v4l3 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </svg>`,
  };

  // 商城/自定义智能体没有单独写矢量图标，按 ID 归到最接近的内置图标，避免全变默认时钟
  const ROLE_ICON_ALIASES = {
    'agent-data-analyst': 'analyst',
    'agent-ms-chartist': 'analyst',
    'agent-ms-deep-research': 'researcher',
    'agent-translator': 'translator',
    'agent-travel-planner': 'travel',
    'agent-ms-novel-copilot': 'writer',
  };

  // 商城条目的图标是 emoji；这里换成对应的矢量图，不把 emoji 直接画到界面上
  const EMOJI_ICON_MAP = {
    '🤖': 'general',
    '💻': 'coder',
    '🔎': 'researcher',
    '🔬': 'researcher',
    '✍️': 'writer',
    '✍': 'writer',
    '🛠': 'ops',
    '🛠️': 'ops',
    '📈': 'analyst',
    '📊': 'analyst',
    '🌐': 'translator',
    '🧭': 'travel',
  };

  function resolveIconKey(roleId) {
    const id = String(roleId || '');
    if (ROLE_SVG_ICONS[id]) return id;
    if (ROLE_ICON_ALIASES[id]) return ROLE_ICON_ALIASES[id];
    const lower = id.toLowerCase();
    if (/translat|翻译/.test(lower)) return 'translator';
    if (/travel|trip|tour|旅行|旅游/.test(lower)) return 'travel';
    if (/research|paper|scholar|论文|学术/.test(lower)) return 'researcher';
    if (/data|chart|analytic|report|stock|finance|数据|分析|图表|报表/.test(lower)) return 'analyst';
    if (/writ|novel|copy|文案|写作|小说/.test(lower)) return 'writer';
    if (/code|developer|engineer|program|frontend|backend|开发|工程|程序/.test(lower)) return 'coder';
    if (/ops|devops|server|infra|运维|服务器/.test(lower)) return 'ops';
    if (/agent|custom|ms-agent|智能体|助手/.test(lower)) return 'custom';
    return 'custom';
  }

  function svgIconHtml(svg, size) {
    return `<span class="role-svg-icon" style="width:${size};height:${size};display:inline-flex;align-items:center;justify-content:center;color:var(--text-secondary);flex-shrink:0;">${svg}</span>`;
  }

  /**
   * 获取角色矢量图标
   * 一律用 SVG 线稿原样显示，不转成 emoji，也不回退成白色实心块。
   * 商城/自定义角色按 ID 归到接近的内置矢量图标，未知的用通用星形，不用默认时钟。
   * @param {object|string} roleOrId - 角色对象或角色 ID
   * @param {string} size - 尺寸
   * @returns {string} HTML 字符串
   */
  function getRoleIcon(roleOrId, size = '24px') {
    const role = (roleOrId && typeof roleOrId === 'object') ? roleOrId : null;
    const roleId = role ? role.id : String(roleOrId || '');

    // 商城角色带 emoji 的，先换成对应矢量图（不显示 emoji 本身）
    let emoji = role && role.emoji ? String(role.emoji).trim() : '';
    if (!emoji && role && role.icon && role.icon.kind === 'emoji') emoji = String(role.icon.value || '').trim();
    if (emoji && EMOJI_ICON_MAP[emoji]) {
      return svgIconHtml(ROLE_SVG_ICONS[EMOJI_ICON_MAP[emoji]], size);
    }

    const key = resolveIconKey(roleId);
    return svgIconHtml(ROLE_SVG_ICONS[key] || ROLE_SVG_ICONS.default, size);
  }

  /**
   * 获取角色图标 SVG 原始内容
   */
  function getRoleIconSvg(roleId) {
    return ROLE_SVG_ICONS[roleId] || ROLE_SVG_ICONS.default;
  }

  // 暴露到全局
  window.RoleIcons = {
    getRoleIcon,
    getRoleIconSvg,
    ROLE_SVG_ICONS,
  };

  console.log('[RoleIcons] 角色 SVG 图标库已加载，共 ' + Object.keys(ROLE_SVG_ICONS).length + ' 个图标');
})();
