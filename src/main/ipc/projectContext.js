/**
 * 项目上下文分析（AI 工作模式"选项目"后自动执行）
 * ------------------------------------------------------------
 * 目的：当用户在 AI 工作模式里选择了项目（agentChat 收到 workdir），
 *       在模型"理解用户问题"之前，先扫描并分析项目结构 / 技术栈 / 入口，
 *       把「项目上下文」注入系统提示词；同时把分析结果以隐藏文件夹
 *       <workdir>/.workbuddy/memory/project-profile.json 的形式落盘，
 *       供 AI 后续用 read_file 查看 / 核对（思考校验）。
 *
 * 与记忆的关系：长期记忆（memory.json）也按项目隔离存到同一隐藏文件夹，
 *       做到「AI 生成的相关记忆文件存储在相关项目里」，而不是全局混在一起。
 */
const fs = require('fs');
const path = require('path');
const ProjectLauncher = require('../projectLauncher');
const ProjectWorkspace = require('./projectWorkspace');

// 这些目录不参与结构统计（体积大 / 非源码 / 隐藏）
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.workbuddy', 'out', 'target',
  '.idea', '.vscode', 'vendor', '__pycache__', '.next', '.nuxt', 'coverage',
  '.cache', '.turbo', 'bin', 'obj', '.angular', '.svelte-kit'
]);
const IGNORE_FILES = new Set([
  '.DS_Store', 'Thumbs.db', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'bun.lockb', '.gitignore', '.npmignore', 'LICENSE', 'license'
]);
const EXT_LANG = {
  js: 'JavaScript', ts: 'TypeScript', jsx: 'React', tsx: 'React',
  py: 'Python', rs: 'Rust', go: 'Go', java: 'Java', c: 'C', cpp: 'C++',
  cs: 'C#', vue: 'Vue', html: 'HTML', css: 'CSS', scss: 'SCSS', json: 'JSON',
  md: 'Markdown', rb: 'Ruby', php: 'PHP', kt: 'Kotlin', swift: 'Swift',
  sql: 'SQL', sh: 'Shell', yml: 'YAML', yaml: 'YAML', toml: 'TOML', lua: 'Lua'
};

function safeReaddir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return []; }
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (e) { return null; }
}

function walkFiles(rootDir, maxDepth, cap, out) {
  if (out.length >= cap) return;
  // 注意：递归时 cur 会被换成子目录，但相对路径必须相对 rootDir（项目根），
  // 否则嵌套目录下只剩文件名（memoryStore.js），模型拿到也没法 read_file。
  const walk = (cur, depth) => {
    if (out.length >= cap || depth < 0) return;
    for (const e of safeReaddir(cur)) {
      if (out.length >= cap) return;
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        walk(full, depth - 1);
      } else {
        if (IGNORE_FILES.has(e.name)) continue;
        out.push(path.relative(rootDir, full).replace(/\\/g, '/'));
      }
    }
  };
  walk(rootDir, maxDepth);
}

function detectLanguages(files) {
  const cnt = {};
  for (const f of files) {
    const m = f.match(/\.([a-z0-9]+)$/i);
    if (m) { const e = m[1].toLowerCase(); cnt[e] = (cnt[e] || 0) + 1; }
  }
  return Object.entries(cnt)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([e, n]) => (EXT_LANG[e] || e) + `(${n})`);
}

// ============================================================
// 问题驱动的「先检查项目」：把用户问题解析成关键词，匹配到项目里的真实文件，
// 给模型一份「先读这些文件」的落点，避免它拿到静态摘要就凭空猜。
// ============================================================

/** 从用户问题里抽关键词：英文/数字词 + 中文 2~4 字滑窗。 */
function tokenizeQuestion(q) {
  const s = String(q || '').toLowerCase();
  const tokens = [];
  for (const w of s.match(/[a-z0-9_]{2,}/g) || []) if (!STOPWORDS.has(w)) tokens.push(w);
  const cn = s.replace(/[^一-龥]/g, '');
  for (let n = 4; n >= 2; n--) {
    for (let i = 0; i + n <= cn.length; i++) {
      const t = cn.substr(i, n);
      if (!STOPWORDS.has(t)) tokens.push(t);
    }
  }
  return Array.from(new Set(tokens));
}

// 高频无信息量词：出现在任何问题里都不该拿来匹配文件
const STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'this', 'that', 'with', 'from', 'what', 'how', 'why',
  '为什么', '怎么', '如何', '这个', '那个', '一下', '请问', '可以', '需要', '不是',
  '没有', '还是', '就是', '然后', '现在', '因为', '所以', '如果', '但是', '我们',
  '它们', '他们', '问题', '代码', '功能', '实现', '使用', '进行', '一个', '两个'
]);

/** 用问题关键词给项目文件打分，返回最相关的若干文件。 */
function pickRelevantFiles(files, question, topN) {
  const tokens = tokenizeQuestion(question);
  if (!tokens.length || !files || !files.length) return [];
  const clues = extractClues(question);
  const clueNames = new Set((clues.files || []).map((s) => s.toLowerCase().replace(/\\/g, '/')));
  const clueWords = new Set([].concat(clues.idents || [], clues.words || []).map((s) => String(s).toLowerCase()));
  const scored = [];
  for (const f of files) {
    const low = f.toLowerCase();
    const base = path.basename(low);
    let sc = 0;
    // 1) 文件名精确命中（用户在问题里直接点名了文件）→ 最高优先
    for (const cn of clueNames) {
      if (low === cn || low.endsWith('/' + cn) || base === cn) sc += 60;
      else if (low.includes(cn)) sc += 25;
    }
    // 2) 路径片段 / 目录名命中
    const segs = low.split('/');
    for (const t of tokens) {
      if (t.length >= 2 && segs.some((s) => s === t)) sc += 12;
      else if (low.includes(t)) sc += t.length >= 3 ? 3 : 1;
    }
    // 3) 问题里的英文标识符（函数名/变量名）命中文件名
    for (const w of clueWords) if (w.length >= 3 && base.includes(w)) sc += 8;
    // 4) 类型亲和：改界面优先看视图层，改逻辑优先看源码
    if (clues.uiHint && /\.(html|css|scss|vue|jsx|tsx)$/.test(base)) sc += 6;
    if (clues.logicHint && /\.(js|ts|py|java|go|rs|cs|cpp|c)$/.test(base)) sc += 4;
    // 5) 浅层文件（离项目根近）通常更关键
    sc += Math.max(0, 4 - segs.length);
    if (sc > 0) scored.push({ f, sc });
  }
  scored.sort((a, b) => b.sc - a.sc || (a.f < b.f ? -1 : 1));
  return scored.slice(0, topN || 8).map(x => x.f);
}

// ============================================================
// 线索抽取 + 项目内 grep：把用户那句话落到「哪个文件哪一行」
// （"问题识别不准确"的根因：只靠文件名模糊匹配，模型拿到一堆无关文件就开始猜）
// ============================================================

const CLUE_FILE_RE = /[\w.\-/\\]+\.(?:js|ts|tsx|jsx|mjs|cjs|py|html|htm|css|scss|less|json|vue|md|rs|go|java|kt|cpp|c|h|cs|sh|yml|yaml|toml)\b/gi;
const CLUE_CALL_RE = /\b([a-z_$][a-z0-9_$]{2,})\s*\(/gi;
const CLUE_WORD_RE = /\b([a-z][a-z0-9_]{3,}|[a-z0-9_]*[A-Z][A-Za-z0-9_]{2,})\b/g;
const ERROR_LINE_RE = /([A-Za-z]*Error|Exception|Traceback|报错|错误|异常|失败)[^\n，。；]{0,50}/g;

// 英文里那些"到处都是"的词，不该当成标识符线索
const WORD_STOP = new Set(['this', 'that', 'with', 'from', 'into', 'when', 'then', 'else', 'null', 'true', 'false', 'console', 'function', 'return', 'const', 'error', 'file', 'data', 'name', 'value']);

/**
 * 从用户的话里抽线索：直接点名的文件、函数名/变量名、中文短语（UI 文案）、报错串。
 */
function extractClues(q) {
  const s = String(q || '');
  const files = [];
  for (const m of s.match(CLUE_FILE_RE) || []) {
    const f = m.replace(/^[.\\/]+/, '').replace(/\\/g, '/');
    if (f.length > 1) files.push(f);
  }
  const idents = [];
  for (const m of s.match(CLUE_CALL_RE) || []) idents.push(m.replace(/\s*\($/, '').replace(/\($/, ''));
  // 英文标识符：太短的（game/test）满屏都是，只留 >=5 的；文件名派生词也不当线索
  const fileStems = new Set(files.map((f) => path.basename(f).replace(/\.[a-z0-9]+$/i, '').toLowerCase()));
  const words = [];
  for (const m of s.match(CLUE_WORD_RE) || []) {
    const w = m.trim();
    const low = w.toLowerCase();
    if (w.length >= 5 && !WORD_STOP.has(low) && !fileStems.has(low)) words.push(w);
  }
  // 中文短语：用来在代码里找 UI 文案 / 中文注释。
  // ⚠️ 不能只按长度取最长的——"点击开始游戏按钮" 会把真正有用的 "开始游戏" 挤掉。
  // 做法：短优先 + 互相包含的只留较短的那个（最小覆盖集）。
  const phrases = [];
  const cn = s.replace(/[^一-龥]/g, ' ');
  for (const seg of cn.split(/\s+/)) {
    const cand = [];
    for (let n = 2; n <= Math.min(8, seg.length); n++) {
      for (let i = 0; i + n <= seg.length; i++) {
        const t = seg.substr(i, n);
        if (!STOPWORDS.has(t)) cand.push(t);
      }
    }
    cand.sort((a, b) => a.length - b.length);
    for (const t of cand) {
      if (phrases.some((p) => p.includes(t) || t.includes(p))) continue;
      phrases.push(t);
    }
  }
  const errors = [];
  for (const m of s.match(ERROR_LINE_RE) || []) {
    const t = String(m).trim();
    if (t.length >= 2) errors.push(t.slice(0, 60));
  }
  const uiHint = /界面|样式|布局|按钮|颜色|字体|显示|页面|错乱|遮挡|裁切|css|样式表|ui/i.test(s);
  const logicHint = /逻辑|函数|方法|报错|异常|崩溃|不生效|没反应|失败|卡|慢|bug|错误/i.test(s);
  return {
    files: Array.from(new Set(files)).slice(0, 8),
    idents: Array.from(new Set(idents)).slice(0, 8),
    words: Array.from(new Set(words)).slice(0, 12),
    phrases: Array.from(new Set(phrases)).sort((a, b) => b.length - a.length).slice(0, 12),
    errors: Array.from(new Set(errors)).slice(0, 4),
    uiHint,
    logicHint
  };
}

const GREP_EXT = new Set(['js', 'ts', 'tsx', 'jsx', 'mjs', 'cjs', 'py', 'html', 'htm', 'css', 'scss', 'vue', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'cs', 'json', 'md']);
const MAX_GREP_FILES = 60;
const MAX_READ_BYTES = 256 * 1024;

function readHead(p, maxBytes) {
  try {
    const fd = fs.openSync(p, 'r');
    const size = fs.fstatSync(fd).size;
    const n = Math.min(maxBytes, size);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, 0);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch (e) { return null; }
}

/**
 * 在项目里搜线索，返回「文件:行号 + 该行内容」的落点列表。
 * 只搜高价值候选（关键文件 + 问题相关文件 + 文件名命中线索的文件），避免全库扫描卡顿。
 */
function grepClues(dir, clues, fileIndex, keyFiles) {
  if (!dir || !clues) return [];
  const cands = new Set();
  for (const f of (keyFiles || [])) if (f) cands.add(f);
  for (const f of pickRelevantFiles(fileIndex || [], '', 12)) cands.add(f);
  const names = new Set((clues.files || []).map((s) => s.toLowerCase()));
  for (const f of (fileIndex || [])) {
    const low = String(f).toLowerCase();
    for (const n of names) if (low.endsWith('/' + n) || low === n || low.includes(n)) { cands.add(f); break; }
  }
  const greppable = (f) => {
    const m = String(f).match(/\.([a-z0-9]+)$/i);
    return m && GREP_EXT.has(m[1].toLowerCase());
  };
  let list = Array.from(cands).filter(greppable).slice(0, MAX_GREP_FILES);
  // 候选太少（小项目没 keyFiles）时，补上项目里的其它源码文件，别漏掉真正的落点
  if (list.length < 5) {
    for (const f of (fileIndex || [])) {
      if (list.length >= MAX_GREP_FILES) break;
      if (!greppable(f) || list.includes(f)) continue;
      list.push(f);
    }
  }

  // 线索按"信息量"排序：报错串 > 函数名 > 中文短语 > 英文标识符
  // ⚠️ 不用「用户点名的文件名」当内容线索：game.js 会命中 startGame() 这类噪音行。
  //    文件名线索交给 pickRelevantFiles 做文件名匹配就够了。
  const needles = [];
  for (const e of (clues.errors || [])) needles.push({ t: e, w: 10, kind: 'error' });
  for (const i of (clues.idents || [])) needles.push({ t: i, w: 7, kind: 'ident' });
  for (const p of (clues.phrases || []).slice(0, 6)) needles.push({ t: p, w: Math.min(9, 3 + p.length), kind: 'phrase' });
  for (const w of (clues.words || []).slice(0, 6)) needles.push({ t: w, w: 5, kind: 'word' });
  if (!needles.length || !list.length) return [];

  const hits = [];
  const perNeedle = new Map();
  for (const rel of list) {
    const txt = readHead(path.join(dir, rel), MAX_READ_BYTES);
    if (txt == null) continue;
    const lines = txt.split(/\r?\n/);
    for (const nd of needles) {
      if ((perNeedle.get(nd.t) || 0) >= 3) continue;
      const needle = nd.t.toLowerCase();
      if (needle.length < 2) continue;
      for (let i = 0; i < lines.length; i++) {
        const low = lines[i].toLowerCase();
        const at = low.indexOf(needle);
        if (at < 0) continue;
        // 跳过明显是"压缩/打包"的超长行
        if (lines[i].length > 800) continue;
        perNeedle.set(nd.t, (perNeedle.get(nd.t) || 0) + 1);
        hits.push({
          file: rel,
          line: i + 1,
          text: lines[i].trim().slice(0, 120),
          clue: nd.t,
          score: nd.w
        });
        break;
      }
      if (hits.length >= 40) break;
    }
    if (hits.length >= 40) break;
  }
  hits.sort((a, b) => b.score - a.score || (a.file < b.file ? -1 : 1));
  // 同一文件同一行去重
  const seen = new Set();
  return hits.filter((h) => {
    const k = h.file + ':' + h.line;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 12);
}

// ============================================================
// 闲聊/寒暄识别：避免"你好/谢谢/在吗"这类消息被误判成"要查项目"
// ============================================================
// ⚠️ 设计原则（保守优先）：宁可让简单消息走完整工具流，也不能把任务误判成闲聊。
//    所以白名单用「整句完全相等」的 Set，不用前缀正则——
//    "你好"是闲聊，"你好帮我看看项目"就不是；"好的"是闲聊，"好的继续"就不是。

// 纯寒暄短语（去标点/空格后必须完全等于这个串才算）
const CHAT_WHITELIST = new Set([
  // 问候
  '你好', '您好', '哈喽', '嗨', 'hi', 'hello', 'hey', 'yo',
  '早', '早上好', '上午好', '中午好', '下午好', '晚上好', '晚安',
  '你好呀', '你好啊', '嗨你好', '哈喽你好',
  '在吗', '在么', '在不在', '有人吗', '请问在吗', '在咩',
  '在忙吗', '忙吗', '有空吗',
  // 感谢
  '谢谢', '感谢', '多谢', '辛苦了', '辛苦啦', 'thankyou', 'thanks', 'thx',
  '谢谢你', '谢谢啦', '感谢感谢',
  // 告别
  '再见', '拜拜', '回见', '拜拜啦', '下次聊', 'bye', 'goodbye',
  '晚安啦',
  // 简单应答（仅独立出现才算——后面跟任何字都不算）
  '好的', '好嘞', '好呀', '好吧', '行', 'ok', 'OK', '嗯嗯', '嗯',
  '收到', '明白', '了解', '可以了', '就这样', '好', '噢', '哦',
  '可以', '都行', '随便', '行吧',
]);

// 出现任意一个"任务性/项目性"词，就不算闲聊（即使用户开头打了招呼）
// ⚠️ 只放词组/多字词，不要放"改/写/做"这种单字——会误伤"好的我知道了"这类应答。
const TASKY_WORDS_RE = /(项目|代码|文件|报错|错误|异常|崩溃|启动|运行|打开|跑起来|界面|样式|布局|按钮|颜色|字体|css|html|js|ts|py|python|java|bug|修复|改一下|改改|写个|写一下|加个|加一下|优化|重构|怎么|为什么|什么是|分析|看看|检查|读一下|帮我|帮我写|帮我改|帮我看|接口|数据库|表|函数|方法|类|组件|页面|命令|脚本|配置|安装|依赖|npm|node|run|build|部署|发布|登录|账号|密码|弹窗|响应|返回值|日志|log|debug|调试|继续|开始|接着|下一步|实现|完成|做完|处理|搞定|推进|执行|搞一下|整一下|试一下|跑一下|改一改|写一写|加一加|查一查|找一下|读一下)/i;

/**
 * 判断用户这条消息是不是纯闲聊/寒暄（"你好"、"谢谢"、"在吗"这类）。
 * 规则（保守）：
 *  - 去标点空格后长度 <= 12 字（长了一定不是纯寒暄）；
 *  - 不含任何"任务性/项目性"关键词；
 *  - 去标点空格后**完全等于**白名单里的某个短语。
 * 只要有一丁点要做事的味道，就返回 false，走正常项目流程。
 */
function isChattyMessage(q) {
  const raw = String(q || '').trim();
  if (!raw) return false;
  // 太长（>30 字原始）一定不是纯寒暄
  if (raw.length > 30) return false;
  // 含任务性词，不算闲聊
  if (TASKY_WORDS_RE.test(raw)) return false;
  // 去掉常见标点和空白
  const s = raw.replace(/[，。！？!?,.;:：、~～\s]+/g, '');
  if (!s) return false;
  // 去标点后长度 > 12 字不算（保守：防止"你好我想问问关于xxx"这种长寒暄漏过）
  if (s.length > 12) return false;
  // 整句完全命中白名单
  return CHAT_WHITELIST.has(s);
}

/**
 * 粗判这次需求属于哪一类，用来给模型一句"这次该往哪走"的提示（不是硬规则）。
 */
function classifyIntent(q) {
  const s = String(q || '');
  const has = (re) => re.test(s);
  // 闲聊/寒暄：最优先，避免"你好"被误判成 other → 被建议去查项目代码
  if (isChattyMessage(s)) {
    return {
      intent: 'chat',
      label: '闲聊/问候（与项目无关）',
      suggest: '用户在打招呼或寒暄，用简短、友好、自然的一句话直接回复即可。'
        + '⚠️ 不要去读项目文件、不要调用任何工具、不要拆待办、不要提"我先看一下代码"——这是纯聊天，直接回就完了。'
    };
  }
  if (has(/跑起来|启动|运行|打开|启动一下|跑一下|怎么运行|预览|预览一下|能不能用/)) {
    return { intent: 'run', label: '把项目跑起来/验证它能用', suggest: '用 launch_project 启动（网页项目会自动起服务在浏览器打开），再用 capture_window / verify_ui 看实际效果。' };
  }
  // ⚠️ bug 判定要放在 ui 之前：说"点按钮没反应"是 bug，不是改样式
  if (has(/报错|异常|崩溃|失败|不生效|没反应|没有反应|不对|有问题|修一下|修复|bug|错误|卡住|闪退|不好使|用不了/)) {
    return { intent: 'bug', label: '排查/修复问题', suggest: '先按问题落点读代码找到真实原因，再改；改完复现一次确认（命令用 run_shell，界面用 verify_ui/截图）。' };
  }
  if (has(/界面|样式|布局|按钮|颜色|字体|显示|错乱|遮挡|裁切|对不齐|css|改成|换个/i)) {
    return { intent: 'ui', label: '改界面/样式', suggest: '先读对应的 html/css/组件文件确认现状，改完用 verify_ui（外部程序传 title）或截图自证，别只说改好了。' };
  }
  if (has(/加|新增|添加|实现|做个|写个|支持|改成|优化|重构/)) {
    return { intent: 'feature', label: '加功能/改实现', suggest: '先看清现有写法再动手，改动贴合项目风格；多步就先用 todo_write 拆清单。' };
  }
  if (has(/为什么|是什么|怎么理解|讲讲|分析|介绍|看看|解释/)) {
    return { intent: 'question', label: '咨询/分析', suggest: '基于读到的真实代码回答，别凭项目摘要猜；没改动文件就在结尾带一句（未改动任何文件）。' };
  }
  return { intent: 'other', label: '未明确分类', suggest: '先检查项目相关代码再判断要做什么。' };
}

/** 读本项目今天的改动记录摘要（避免重复劳动 / 误判现状）。 */
function recentChanges(dir) {
  try {
    const files = ProjectWorkspace.listChanges(dir) || [];
    if (!files.length) return [];
    // listChanges 已按日期倒序，files[0] 是最新的一天
    const last = files[0];
    const txt = fs.readFileSync(last, 'utf-8');
    const heads = [];
    const re = /^##\s+(.+)$/gm;
    let m;
    while ((m = re.exec(txt)) !== null) heads.push({ date: path.basename(last, '.md'), title: m[1].trim().slice(0, 80) });
    return heads.slice(-3);
  } catch (e) { return []; }
}

// 项目类型的中文说法（AI 看到的摘要用，避免只看懂一个 "web" 就瞎猜启动方式）
const TYPE_CN = {
  web: '静态网页（html/css/js，无构建、无后端）',
  node: 'Node.js',
  python: 'Python',
  rust: 'Rust',
  go: 'Go',
  java: 'Java',
  'cpp-vs': 'Visual Studio (C++/C#)',
  unknown: '未知'
};

/** 轻量签名：仅看顶层条目 + 关键标记文件 mtime，用于判断是否需要重新深度分析。 */
function quickSignature(dir) {
  const parts = [];
  for (const e of safeReaddir(dir)) {
    if (e.name.startsWith('.')) continue;
    parts.push(e.name + (e.isDirectory() ? '/' : '') + (e.isFile() ? ':' + (() => { try { return fs.statSync(path.join(dir, e.name)).mtimeMs; } catch (_) { return 0; } })() : ''));
    if (parts.length >= 80) break;
  }
  const markers = ['package.json', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'requirements.txt', 'README.md', 'README'];
  for (const m of markers) {
    try {
      const st = fs.statSync(path.join(dir, m));
      parts.push(m + '@' + st.mtimeMs);
    } catch (_) { /* 不存在 */ }
  }
  return parts.join('|');
}

function analyze(dir) {
  if (!dir || !fs.existsSync(dir)) return { ok: false, error: '目录不存在: ' + (dir || '') };
  const detected = ProjectLauncher.detectProject(dir);
  const type = (detected && detected.detected) ? (detected.type || 'unknown') : '未识别';
  // 网页项目用页面标题当项目名（比临时目录名有意义得多）
  const name = (type === 'web' && detected.windowTitleHint) ? detected.windowTitleHint : path.basename(dir);

  // 顶层结构
  const top = safeReaddir(dir);
  const topDirs = [];
  const topFiles = [];
  for (const e of top) {
    if (e.name === '.ai_workspace') { topDirs.push('.ai_workspace（隐藏：AI 记忆/改动/分析）'); continue; }
    if (e.name === '.workbuddy') { topDirs.push('.workbuddy（隐藏：助理记忆）'); continue; }
    if (e.name.startsWith('.')) continue;
    if (IGNORE_DIRS.has(e.name)) continue;
    if (e.isDirectory()) topDirs.push(e.name);
    else if (!IGNORE_FILES.has(e.name) && topFiles.length < 40) topFiles.push(e.name);
  }

  // 关键文件定位（受限深度扫描，避免大仓库卡顿）
  const allFiles = [];
  walkFiles(dir, 3, 4000, allFiles);
  const languages = detectLanguages(allFiles);

  // 技术栈（node 读 package.json 依赖；其余用类型推断）
  let techStack = [];
  if (detected && detected.detected && detected.type === 'node') {
    const pkg = readJson(path.join(dir, 'package.json'));
    if (pkg && pkg.dependencies) techStack = Object.keys(pkg.dependencies).slice(0, 20);
  } else if (type !== '未识别' && type !== 'web') {
    techStack = [type]; // 网页项目不写"技术栈 web"，主要语言里已经写了 HTML/JS
  }

  // 入口 / 启动
  // ⚠️ launcher 给的字段叫 windowTitleHint（不是 titleHint），以前取错字段导致"窗口标题提示"永远为空
  const entry = (detected && detected.detected)
    ? {
        startCommand: detected.startCommand,
        installCommand: detected.installCommand,
        packageManager: detected.packageManager,
        isWeb: detected.type === 'web',
        webEntry: detected.type === 'web' ? detected.entry : null,
        titleHint: detected.windowTitleHint || null
      }
    : null;

  // README 摘要（去掉反引号，避免破坏外层代码块）
  let readme = '';
  for (const cand of ['README.md', 'readme.md', 'Readme.md', 'README.txt', 'README']) {
    const p = path.join(dir, cand);
    if (fs.existsSync(p)) {
      try {
        const txt = fs.readFileSync(p, 'utf-8')
          .replace(/[`]/g, '')
          .replace(/\r/g, '')
          .split('\n').filter(l => l.trim()).slice(0, 25).join('\n');
        readme = txt.slice(0, 1200);
      } catch (e) { /* 忽略 */ }
      break;
    }
  }

  // 代表性关键文件（靠近入口的源码）
  const keyFiles = allFiles
    .filter(f => /^(src|app|lib|main|index|server|client|public)\b/i.test(f)
      || /(main|index|app)\.[a-z0-9]+$/i.test(path.basename(f)))
    .slice(0, 15);

  return {
    ok: true,
    name,
    dir,
    type,
    typeLabel: TYPE_CN[type] || type,
    languages,
    techStack,
    topDirs: topDirs.slice(0, 30),
    topFiles: topFiles.slice(0, 40),
    keyFiles,
    entry,
    readme,
    fileIndex: allFiles.slice(0, 800), // 供「按问题匹配相关文件」用；不写进 markdown 文档
    analyzedAt: Date.now()
  };
}

function profilePath(dir) {
  return ProjectWorkspace.contextPath(dir);
}

// 内存缓存：{ dir, signature, profile }，结构未变时复用，避免每轮重新深度扫描
let profileCache = { dir: null, signature: null, profile: null };

/** 把分析结果渲染成人类 / AI 可读的 Markdown 文档。 */
function renderProfileMarkdown(profile) {
  const L = [];
  L.push('# 项目分析 · ' + profile.name);
  L.push('');
  L.push('> 本文件由 AI 龙虾在「选中项目 / 首次对话」时自动分析生成，供 AI 理解项目与思考校验。可手工编辑补充。');
  L.push('');
  L.push('- 项目名：' + profile.name);
  L.push('- 项目根：' + profile.dir);
  L.push('- 类型：' + (profile.typeLabel || profile.type));
  if (profile.languages && profile.languages.length) L.push('- 主要语言：' + profile.languages.join('、'));
  if (profile.techStack && profile.techStack.length) L.push('- 技术栈/依赖：' + profile.techStack.join('、'));
  if (profile.entry && profile.entry.isWeb) {
    L.push('- 入口页面：' + (profile.entry.webEntry || 'index.html'));
    L.push('- 启动方式：纯静态网页 —— launch_project 会自动起本地静态服务并在默认浏览器打开，'
      + '然后用页面标题抓浏览器窗口截图验证。⚠️ 不要用 exe 启动，也不要 run_shell 去 start 项目里的 exe。');
    if (profile.entry.titleHint) L.push('- 页面标题（截图定位窗口用）：' + profile.entry.titleHint);
  } else if (profile.entry && profile.entry.startCommand) {
    L.push('- 启动命令：' + profile.entry.startCommand + (profile.entry.packageManager ? '（包管理器：' + profile.entry.packageManager + '）' : ''));
    if (profile.entry.installCommand) L.push('- 安装依赖：' + profile.entry.installCommand);
    if (profile.entry.titleHint) L.push('- 窗口标题提示：' + profile.entry.titleHint);
  }
  L.push('');
  L.push('## 顶层目录');
  L.push('');
  for (const d of (profile.topDirs || [])) L.push('- ' + d);
  L.push('');
  L.push('## 关键文件（建议优先查看）');
  L.push('');
  for (const f of (profile.keyFiles || [])) L.push('- `' + String(f).replace(/`/g, '') + '`');
  if (profile.readme) {
    L.push('');
    L.push('## README 摘要');
    L.push('');
    L.push(profile.readme);
  }
  L.push('');
  L.push('（分析时间：' + new Date(profile.analyzedAt || Date.now()).toLocaleString() + '）');
  return L.join('\n') + '\n';
}

function saveProfile(dir, profile) {
  try {
    const p = profilePath(dir);
    const d = path.dirname(p);
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, renderProfileMarkdown(profile), 'utf-8');
    fs.renameSync(tmp, p);
    return true;
  } catch (e) { return false; }
}

/**
 * 生成注入系统提示词的「项目上下文 + 检查指引」文本块。
 * @param {string} dir 项目根
 * @param {string} [userMessage] 用户本轮问题（用于挑「先读这些文件」）
 * - 结构未变时复用内存缓存（快速路径），但「相关文件」每轮按问题重算。
 */
function buildContextBlock(dir, userMessage) {
  if (!dir || !fs.existsSync(dir)) return '';
  ProjectWorkspace.ensureInit(dir); // 选项目即建好隐藏工作区（含三个子文件夹）
  const sig = quickSignature(dir);
  let profile;
  if (profileCache.dir === dir && profileCache.signature === sig) {
    profile = profileCache.profile; // 快速路径：结构没变，直接用内存缓存
  } else {
    profile = analyze(dir);
    if (!profile.ok) return '';
    saveProfile(dir, profile);
    profileCache = { dir, signature: sig, profile };
  }
  const lines = [];
  lines.push('## 已分析的项目上下文（AI 工作模式已自动分析）');
  lines.push('- 项目名：' + profile.name);
  lines.push('- 项目根：' + profile.dir);
  lines.push('- 类型：' + (profile.typeLabel || profile.type));
  if (profile.languages && profile.languages.length) lines.push('- 主要语言：' + profile.languages.join('、'));
  if (profile.techStack && profile.techStack.length) lines.push('- 技术栈/依赖：' + profile.techStack.join('、'));
  if (profile.entry && profile.entry.isWeb) {
    lines.push('- 入口页面：' + (profile.entry.webEntry || 'index.html'));
    lines.push('- 怎么跑起来：**纯静态网页，没有 exe、也不需要 build** —— 用 launch_project（method=auto）'
      + '会自动起本地静态服务并在默认浏览器打开，返回页面地址与页面标题；'
      + '截图/验证时按页面标题抓浏览器里的窗口。⚠️ 绝对不要去找 exe 启动，也不要用 run_shell start 某个 exe。');
  } else if (profile.entry && profile.entry.startCommand) {
    lines.push('- 启动命令：' + profile.entry.startCommand + (profile.entry.packageManager ? '（包管理器：' + profile.entry.packageManager + '）' : ''));
    if (profile.entry.installCommand) lines.push('- 安装依赖：' + profile.entry.installCommand);
    if (profile.entry.titleHint) lines.push('- 窗口标题提示：' + profile.entry.titleHint);
  }
  if (profile.topDirs && profile.topDirs.length) lines.push('- 顶层目录：' + profile.topDirs.join('、'));

  // 闲聊/寒暄：不注入"必须先读代码"那一大套，直接给一句简短提示让模型回就完了
  if (isChattyMessage(userMessage)) {
    lines.push('');
    lines.push('## ⚠️ 本轮是闲聊/寒暄（不是项目任务）');
    lines.push('- 用户这句是打招呼/道谢/告别之类的纯聊天，与项目代码无关。');
    lines.push('- **直接用一两句话友好回复即可**：不要 read_file、不要 file_search、不要 run_shell、不要 todo_write、不要去"检查项目"。');
    lines.push('- **不要生成长段思考（reasoning）**：一句话能回的事就别"想"半天，也不要在思考里规划下一步、分析项目结构。');
    lines.push('- 也不要主动展开介绍项目能做什么——等用户真的提需求再做事。');
    return lines.join('\n');
  }

  // 关键：按本轮问题挑出最相关的真实文件，驱动模型「先检查项目 → 再解析需求」
  const relevant = pickRelevantFiles(profile.fileIndex, userMessage, 8);

  // 意图判断（给模型一句"这次该往哪走"，不是硬规则）
  const intent = classifyIntent(userMessage);
  lines.push('');
  lines.push('## 这次要做什么（按用户这句话判断）');
  lines.push('- 判断：' + intent.label);
  lines.push('- 建议：' + intent.suggest);

  // 问题落点：在真实代码里搜线索，给出「文件:行号」，避免模型凭摘要瞎猜
  if (userMessage) {
    const clues = extractClues(userMessage);
    const hits = grepClues(dir, clues, profile.fileIndex, profile.keyFiles);
    if (hits.length) {
      lines.push('');
      lines.push('### 问题落点（已按你说的话在项目代码里搜到，优先看这些）');
      for (const h of hits) {
        lines.push('- `' + h.file + ':' + h.line + '` ← 命中「' + h.clue + '」　' + h.text);
      }
      lines.push('（上面是源码里真实出现的行；用 read_file 打开对应文件核对上下文，不要凭这段摘要下结论）');
    } else {
      lines.push('');
      lines.push('（按你这句话没在项目里搜到明确落点：先用 file_search / directory_list 定位再说，别猜）');
    }
  }

  // 最近做过什么（避免重复劳动 / 误判现状）
  const recent = recentChanges(dir);
  if (recent.length) {
    lines.push('');
    lines.push('### 本项目最近做过（' + recent[0].date + ' 的改动记录）');
    for (const r of recent) lines.push('- ' + r.title);
  }

  lines.push('');
  lines.push('## 工作流程（必须遵守：先读文档/代码 → 再解析需求 → 再动手/回答）');
  lines.push('1. **先读文档与代码**：上面已经自动注入了项目关键 .md 文档和相关文件列表。动手前必须先用 read_file 打开列出的相关文件，确认现状与调用链；不要只凭这段摘要凭空猜测，也不要在没看代码前就下结论。');
  lines.push('2. 再解析需求：把用户的问题对应到项目里具体的文件 / 函数 / 配置上，明确「要改哪里、为什么这么改」。信息不足时先检查相关代码再判断。');
  lines.push('3. 最后才动手或回答：**改代码前必须已经读过相关文件**——没读过就 write_file 会被系统拦截（这是硬门禁，不是建议）。改动尽量小、贴合项目现有写法；改完按收尾规范总结。');
  if (relevant.length) {
    lines.push('');
    lines.push('### 与本问题最相关的文件（建议先读这些）');
    for (const f of relevant) lines.push('- `' + f + '`');
  } else if (profile.keyFiles && profile.keyFiles.length) {
    lines.push('');
    lines.push('### 关键文件（建议先读这些）');
    for (const f of profile.keyFiles.slice(0, 10)) lines.push('- `' + f + '`');
  }
  lines.push('');
  lines.push('（完整项目分析见 ' + profilePath(dir) + '，可用 read_file 查看/核对）');

  // 关键 .md 文档 + 隐藏记忆文件夹内容直接注入：让 AI 第一轮就看到项目约定和它自己的记忆，
  // 不用它自己想起来 read_file。
  const docs = collectKeyMarkdownDocs(dir, profile.fileIndex);
  if (docs.length) {
    lines.push('');
    lines.push('## 项目记忆文档（已自动读取，包含 .ai_workspace/.workbuddy 隐藏文件夹里的 AI 记忆与项目约定，请优先遵守）');
    for (const d of docs) {
      lines.push('');
      lines.push('### 📄 ' + d.path);
      lines.push(d.body);
    }
  }
  return lines.join('\n');
}

/**
 * 收集项目里的关键 Markdown 文档：
 *   1. 项目根 / src 下的 README/DESIGN/NOTES/CHANGELOG 等
 *   2. **隐藏记忆文件夹** .ai_workspace / .workbuddy 里的所有 .md（AI 之前留下的记忆/上下文/改动记录）
 * 把内容直接注入系统提示，让 AI 第一轮就看到项目约定，不用它自己想起来 read_file。
 */
function collectKeyMarkdownDocs(dir, fileIndex) {
  if (!dir) return [];
  const picked = [];
  let budget = 6000;

  // ── 1. 隐藏记忆文件夹：.ai_workspace / .workbuddy 下所有 .md，这是 AI 自己的记忆库 ──
  for (const hidden of ['.ai_workspace', '.workbuddy']) {
    const hdir = path.join(dir, hidden);
    if (!fs.existsSync(hdir)) continue;
    const walkHidden = (cur, depth) => {
      if (depth < 0 || budget <= 0) return;
      for (const e of safeReaddir(cur)) {
        if (budget <= 0) return;
        const full = path.join(cur, e.name);
        if (e.isDirectory()) { walkHidden(full, depth - 1); continue; }
        if (!/\.md$/i.test(e.name)) continue;
        try {
          const txt = fs.readFileSync(full, 'utf8');
          const body = txt.split('\n').filter(l => l.trim() && !/^```/.test(l.trim())).join('\n').slice(0, 2048);
          if (body.length < 30) continue;
          picked.push({ path: hidden + '/' + path.relative(hdir, full).replace(/\\/g, '/'), body });
          budget -= body.length + 80;
        } catch (e) { /* 忽略 */ }
      }
    };
    walkHidden(hdir, 4);
  }

  // ── 2. 项目根 / src 浅层的 README/DESIGN/NOTES 等 ──
  if (budget > 0 && Array.isArray(fileIndex)) {
    const PREFER = /(^|\/)(readme|design|docs?|notes?|changelog|architecture|开发|设计|说明|指引|规范|约定)(\.md|\.markdown)?$/i;
    const sorted = fileIndex.slice().sort((a, b) => {
      const da = (a.match(/\//g) || []).length, db = (b.match(/\//g) || []).length;
      return da - db;
    });
    for (const rel of sorted) {
      if (budget <= 0) break;
      if (!/\.(md|markdown)$/i.test(rel)) continue;
      if (!PREFER.test(rel.replace(/\\/g, '/'))) continue;
      try {
        const txt = fs.readFileSync(path.join(dir, rel), 'utf8');
        const body = txt.split('\n').filter(l => l.trim() && !/^```/.test(l.trim())).join('\n').slice(0, 2048);
        if (body.length < 50) continue;
        picked.push({ path: rel, body });
        budget -= body.length + 80;
      } catch (e) { /* 忽略 */ }
    }
  }
  return picked;
}

module.exports = {
  analyze,
  buildContextBlock,
  saveProfile,
  profilePath,
  quickSignature,
  pickRelevantFiles,
  tokenizeQuestion,
  extractClues,
  grepClues,
  classifyIntent,
  isChattyMessage,
  recentChanges,
  collectKeyMarkdownDocs
};
