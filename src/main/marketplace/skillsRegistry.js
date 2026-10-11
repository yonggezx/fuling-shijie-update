/**
 * 技能能力包运行时
 * ============================================================
 * 「技能」在浮灵饰界的落地：一个能力包 = data/skills/<skillId>/ 下的
 *   · SKILL.md —— 指令说明（含 name/description/触发场景，供 AI 理解怎么用）
 *   · 可选 assets / references —— 参考资料，AI 按需 read_file 读取
 *
 * 装配方式（轻量，不引入独立执行引擎）：
 *   1. aiOps 拼系统提示词时，把「已启用的技能索引」注入（skillsRegistry.buildNotice）
 *   2. AI 判断任务命中某技能 → 用已有 read_file 工具读对应 SKILL.md，按说明执行
 *
 * 数据位置：app.getPath('userData')/skills/<skillId>/
 *   启用状态：data/marketplace/installed.yaml（由 marketplaceManager 统一管）
 */
'use strict';
const fs = require('fs');
const path = require('path');

let SKILLS_DIR = null;

function init(userDataDir) {
  SKILLS_DIR = path.join(userDataDir, 'skills');
  try { fs.mkdirSync(SKILLS_DIR, { recursive: true }); } catch (e) { /* 忽略 */ }
  return SKILLS_DIR;
}

function skillsDir() {
  if (!SKILLS_DIR) throw new Error('[Skills] 未初始化（需先调用 init(userDataDir)）');
  return SKILLS_DIR;
}

/** 解析 SKILL.md 的简易 frontmatter（--- 包裹的 YAML 前块），拿 name/description */
function parseFrontmatter(text) {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(text || '');
  const meta = { name: '', description: '' };
  if (!m) return meta;
  const block = m[1];
  for (const line of block.split('\n')) {
    const kv = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) {
      const val = kv[2].replace(/^["']|["']$/g, '').trim();
      if (kv[1] === 'name') meta.name = val;
      else if (kv[1] === 'description') meta.description = val;
    }
  }
  return meta;
}

/**
 * 列出已安装的技能（含启用状态）。
 * 启用状态来自 marketplaceManager 的 installed 记录；这里通过回调查询，避免循环依赖。
 * @param {(id:string)=>boolean|undefined} isEnabled
 * @param {(id:string)=>string|undefined} titleOverride
 * @returns {Array<{id,name,description,enabled,path,sizeBytes,title}>}
 */
function listSkills(isEnabled) {
  if (!SKILLS_DIR) return []; // 未初始化时安全返回空
  const dir = skillsDir();
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) { return out; }
  for (const d of names) {
    if (!d.isDirectory()) continue;
    const sk = path.join(dir, d.name);
    const skFile = path.join(sk, 'SKILL.md');
    if (!fs.existsSync(skFile)) continue;
    let text = '';
    try { text = fs.readFileSync(skFile, 'utf8'); } catch (e) { continue; }
    const meta = parseFrontmatter(text);
    let sizeBytes = 0;
    try { sizeBytes = dirSize(sk); } catch (e) { /* 忽略 */ }
    const enabled = typeof isEnabled === 'function' ? !!isEnabled(d.name) : true;
    out.push({
      id: d.name,
      name: meta.name || d.name,
      description: meta.description || '',
      enabled,
      path: sk,
      sizeBytes,
      title: meta.name || d.name
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function dirSize(dir) {
  let total = 0;
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) total += dirSize(p);
    else { try { total += fs.statSync(p).size; } catch (e) {} }
  }
  return total;
}

/** 读取某个技能的 SKILL.md 全文（供 AI 用 read_file 读取时也一致） */
function readSkillMd(skillId) {
  const p = path.join(skillsDir(), String(skillId).replace(/[^a-zA-Z0-9_\-]/g, ''), 'SKILL.md');
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

/**
 * 构建注入系统提示词的技能索引块。只放「名字 + 一句话触发场景 + 读取路径」，
 * 全文让 AI 按需 read_file 读，避免每轮常驻开销过大。
 */
function buildNotice(enabledList) {
  if (!enabledList || !enabledList.length) return '';
  const lines = enabledList.map(s => {
    const hint = s.description ? s.description.split(/[。\n]/)[0] : '';
    return `- **${s.name}**（技能 ${s.id}）：${hint}。命中时先用 read_file 读取 ${'data/skills/' + s.id + '/SKILL.md'} 了解用法，再按说明执行。`;
  }).join('\n');
  return `\n\n## 可用技能（按需调用）\n你可以调用以下已启用的技能来完成对应任务。命中相关场景时，先用 read_file 读取该技能的 SKILL.md，严格按其说明执行，不要自创做法。\n${lines}`;
}

module.exports = {
  init, skillsDir, listSkills, readSkillMd, buildNotice, parseFrontmatter
};
