'use strict';
/**
 * 智能商城回归测试（无网络依赖）
 * ============================================================
 * 覆盖：list 目录装载 / 安装(agent, mcp, skill) / 启用停用 / 卸载 / 导入(清单+zip) / zip 解压 / 技能索引注入。
 * 用临时 userData，不污染真实数据。mcp 安装只验配置写入与 mcpManager 感知，不真实拉起进程。
 *
 * 运行：node scripts/test-marketplace.js
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'out', 'test-marketplace', 'userdata');

function assert(cond, msg) {
  if (!cond) throw new Error('断言失败: ' + msg);
}

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  const mcpManager = require(path.join(ROOT, 'src/main/mcp/mcpManager.js'));
  mcpManager.setUserDataOverride(TMP);
  const marketplace = require(path.join(ROOT, 'src/main/marketplace/marketplaceManager.js'));
  marketplace.init({ userDataDir: TMP, factoryDir: path.join(ROOT, 'src/main/agent-config'), mcpManager });

  // 1. list：目录装载（出厂 + 用户），字段完整
  const items = marketplace.list();
  assert(items.length >= 24, '目录条目过少（应含魔搭扩充 24+）: ' + items.length);
  assert(items.some(i => i.type === 'skill') && items.some(i => i.type === 'mcp') && items.some(i => i.type === 'agent'),
    '三类条目都应存在');
  assert(items.every(i => i.id && i.name && i.type), '条目字段缺失');

  // 1b. 魔搭社区条目：三类来源都应上架
  assert(items.some(i => i.id === 'mscp-vision' && i.type === 'mcp'), '魔搭 MCP 条目缺失');
  assert(items.some(i => i.id === 'skill-ms-studio-deploy' && i.type === 'skill'), '魔搭技能条目缺失');
  assert(items.some(i => i.id === 'agent-ms-deep-research' && i.type === 'agent'), '魔搭智能体条目缺失');

  // 2. 安装 agent（inline）
  const ra = await marketplace.install('agent-data-analyst');
  assert(ra.success, 'agent 安装失败: ' + ra.error);
  const roles = JSON.parse(fs.readFileSync(path.join(TMP, 'agent_roles.json'), 'utf8'));
  assert(roles.find(r => r.id === 'agent-data-analyst' && r.isPreset === false), 'agent 未写入自定义角色');

  // 3. 安装 MCP：配置写入 + mcpManager 感知 + 启用
  const rm = await marketplace.install('mcp-everything');
  assert(rm.success, 'mcp 安装失败: ' + rm.error);
  assert(fs.readFileSync(path.join(TMP, 'marketplace', 'mcp.yaml'), 'utf8').includes('mcp-everything'), 'mcp.yaml 未写入');
  assert(!!mcpManager.getServerDef('mcp-everything'), 'mcpManager 未感知商城 MCP');
  assert(mcpManager.getEnabled().includes('mcp-everything'), 'mcp 未启用');

  // 4. 导入 yaml 清单 + 安装其中 inline 技能
  const cat = path.join(TMP, 'extras.yaml');
  fs.writeFileSync(cat, 'marketplace:\n  - id: skill-demo\n    type: skill\n    name: 示例技能\n    emoji: 🧩\n    category: other\n    description: 回归测试技能\n    source: {kind: inline, skillMd: "---\\nname: 示例技能\\ndescription: 回归测试\\n---\\n# 示例技能\\n按说明执行。"}\n', 'utf8');
  const imp = await marketplace.importPackage(cat);
  assert(imp.success && imp.added.includes('skill-demo'), 'yaml 清单导入失败: ' + imp.error);
  const rs = await marketplace.install('skill-demo');
  assert(rs.success, 'inline 技能安装失败: ' + rs.error);
  assert(fs.existsSync(path.join(TMP, 'skills', 'skill-demo', 'SKILL.md')), '技能 SKILL.md 未落盘');

  // 4b. 魔搭条目安装：MCP(env 透传) / 技能(inline SKILL.md) / 智能体(inline role)
  const rm2 = await marketplace.install('mscp-vision');
  assert(rm2.success, '魔搭 MCP 安装失败: ' + rm2.error);
  const mcpYaml = fs.readFileSync(path.join(TMP, 'marketplace', 'mcp.yaml'), 'utf8');
  assert(mcpYaml.includes('mscp-vision') && mcpYaml.includes('MODELSCOPE_TOKEN'), '魔搭 MCP 配置/env 未写入');
  const rs2 = await marketplace.install('skill-ms-studio-deploy');
  assert(rs2.success, '魔搭技能安装失败: ' + rs2.error);
  const md = fs.readFileSync(path.join(TMP, 'skills', 'skill-ms-studio-deploy', 'SKILL.md'), 'utf8');
  assert(md.includes('modelscope-studio-deploy') && md.includes('创空间'), '魔搭技能 SKILL.md 内容缺失');
  const ra2 = await marketplace.install('agent-ms-deep-research');
  assert(ra2.success, '魔搭智能体安装失败: ' + ra2.error);
  const roles2 = JSON.parse(fs.readFileSync(path.join(TMP, 'agent_roles.json'), 'utf8'));
  assert(roles2.find(r => r.id === 'agent-ms-deep-research'), '魔搭智能体未写入自定义角色');
  assert(marketplace.skillsNotice().includes('modelscope-studio-deploy'), '魔搭技能未注入索引');

  // 5. 技能索引注入
  assert(marketplace.skillsNotice().includes('示例技能'), '技能索引未注入');

  // 6. zip 解压 + 本地技能包导入
  const zipTmp = path.join(TMP, 'skillpack.zip');
  const src = path.join(TMP, 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: 打包技能\ndescription: zip导入\n---\n# 打包技能\n按说明执行。', 'utf8');
  fs.writeFileSync(path.join(src, 'asset.txt'), 'hello', 'utf8');
  try {
    execSync('tar -a -c -f "' + zipTmp + '" -C "' + src + '" SKILL.md asset.txt', { stdio: 'pipe' });
  } catch (e) { throw new Error('系统无法创建测试 zip: ' + e.message); }
  const { extractZip } = require(path.join(ROOT, 'src/main/marketplace/zipExtract.js'));
  const zdest = path.join(TMP, 'zipped');
  fs.mkdirSync(zdest, { recursive: true });
  const zr = await extractZip(fs.readFileSync(zipTmp), zdest);
  assert(zr.files.length === 2 && fs.readFileSync(path.join(zdest, 'SKILL.md'), 'utf8').includes('打包技能'), 'zip 解压错误');
  const imp2 = await marketplace.importPackage(zipTmp);
  assert(imp2.success && fs.existsSync(path.join(TMP, 'skills', imp2.id, 'SKILL.md')), 'zip 技能导入失败');

  // 7. 停用 / 卸载
  marketplace.setEnabled('skill-demo', false);
  assert(marketplace.list().find(i => i.id === 'skill-demo').enabled === false, '技能停用失败');
  marketplace.uninstall('skill-demo');
  assert(!fs.existsSync(path.join(TMP, 'skills', 'skill-demo')), '技能卸载失败');
  marketplace.uninstall('agent-data-analyst');
  assert(!JSON.parse(fs.readFileSync(path.join(TMP, 'agent_roles.json'), 'utf8')).find(r => r.id === 'agent-data-analyst'), 'agent 卸载失败');

  console.log('marketplace-test: 全部通过（目录/安装/启用/卸载/导入/zip/技能注入）');
  process.exit(0);
})().catch(e => { console.error('marketplace-test: FAIL -> ' + (e.stack || e.message)); process.exit(1); });
