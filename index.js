/**
 * 错题本 · Host 半段。
 *
 * 三件事：
 *   1. 把 `错题本/` 文件夹（工作区内的真相源）通过受认证的 `/api/cuotiji/*` 精确路由暴露给面板；
 *   2. 把「入库 / 检索 / 导出」暴露成 Agent 工具，让模型的识别结果落到同一份数据上；
 *   3. 提供 `/cuotiji` 斜杠命令与一段常驻提示词，规定双轨保存与不改写题面的硬规则。
 *
 * 面板与工具调用同一个数据层（lib/store.js、lib/exporters.js），不存在两套业务逻辑。
 *
 * 刻意只用 Node 内置模块与 Cordis 运行时对象：profile 里安装的是链接目录，
 * 解析不到 dsh 安装目录下的 `@deepseek-ai/*` 包，所以这里不 import 它们，
 * 工具定义用注册表直接接受的 JSON Schema 形状。
 * @module @local/dsh-cuotiji
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  buildIndex,
  deleteQuestion,
  ensureRoot,
  kindOfFile,
  listInbox,
  listQuestions,
  saveInboxFile,
  saveQuestion,
} from './lib/store.js';
import { exportQuestions, selectQuestions } from './lib/exporters.js';
import { describeOcr, isOcrCandidate, runOcr } from './lib/ocr.js';
import {
  findChapter,
  findSection,
  loadTaxonomies,
  outlineOf,
  sameName,
  sortIndex,
  suggestChapters,
  summarize,
} from './lib/taxonomy.js';

/** 插件行 id。 */
export const name = 'dsh-cuotiji';

/** 必需的 Host 服务；缺任意一个就不激活，避免半残状态。 */
export const inject = ['connection', 'tools', 'workingDirectory', 'agents'];

const ROUTE_PREFIX = '/api/cuotiji';
const DEFAULT_ROOT = '错题本';
const DEFAULT_EXPORT_DIR = '错题导出';

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** 深冻结并补一个稳定 id，与 dsh-llm 的 createUserMessage 等价。 */
function userMessage(text) {
  const message = structuredClone({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
    role: 'user',
    id: randomUUID(),
  });
  const freeze = (value) => {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const item of Object.values(value)) freeze(item);
    }
    return value;
  };
  return freeze(message);
}

/** 构造注册表直接接受的工具定义（parameters 已是 JSON Schema）。 */
function tool(definition) {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    output: {
      schema: definition.output.schema,
      render: (_args, value) => [{ type: 'text', text: definition.output.render(value) }],
    },
    execute: definition.execute,
  };
}

function jsonOf(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function failure(error) {
  return jsonOf({ ok: false, error: String(error?.message ?? error) }, 200);
}

/** 解析一个可配置目录：绝对路径直接用，相对路径挂到工作区根上。 */
function resolveDir(configured, fallback, cwd) {
  const value = configured === undefined || configured === '' ? fallback : configured;
  if (path.isAbsolute(value)) return path.resolve(value);
  return path.resolve(cwd, value);
}

/** 当前工作区目录：优先指定 Agent，其次最近的活跃会话，最后默认工作区。 */
function resolveCwd(ctx, agent) {
  const workingDirectory = ctx.workingDirectory;
  if (agent !== undefined) {
    try {
      const cwd = workingDirectory.get(agent.session);
      if (typeof cwd === 'string' && cwd !== '') return cwd;
    } catch {
      /* 会话未就绪，继续往后退 */
    }
  }
  let listed = [];
  try {
    listed = ctx.agents.list();
  } catch {
    listed = [];
  }
  for (let index = listed.length - 1; index >= 0; index -= 1) {
    try {
      const cwd = workingDirectory.get(listed[index].session);
      if (typeof cwd === 'string' && cwd !== '') return cwd;
    } catch {
      /* 尝试下一个 */
    }
  }
  return workingDirectory.defaultDirectory ?? process.cwd();
}

/** 组装根目录与导出目录。 */
function dirsFor(ctx, config, agent) {
  const cwd = resolveCwd(ctx, agent);
  return {
    cwd,
    root: resolveDir(config?.root, DEFAULT_ROOT, cwd),
    exportDir: resolveDir(config?.exportDir, DEFAULT_EXPORT_DIR, cwd),
  };
}

/** 给面板的一份完整快照。 */
async function readState(ctx, config, agent, taxonomies) {
  const dirs = dirsFor(ctx, config, agent);
  await ensureRoot(dirs.root);
  const questions = await listQuestions(dirs.root);
  const topicCounts = new Map();
  for (const item of questions) {
    for (const topic of item.topics) topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
  }
  return {
    ok: true,
    root: dirs.root,
    exportDir: dirs.exportDir,
    cwd: dirs.cwd,
    total: questions.length,
    questions,
    index: sortIndex(buildIndex(questions), taxonomies),
    topics: [...topicCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
      .map(([topic, count]) => ({ topic, count })),
    inbox: await listInbox(dirs.root),
    taxonomy: Object.fromEntries(
      Object.entries(taxonomies).map(([subject, taxonomy]) => [subject, summarize(taxonomy)]),
    ),
  };
}

/** 只允许读取错题本目录内的文件。 */
async function readAsset(root, relative) {
  const absolute = path.resolve(root, relative);
  const rel = path.relative(path.resolve(root), absolute);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('只允许读取错题本目录内的文件。');
  }
  const data = await fsp.readFile(absolute);
  return { data, mediaType: MIME[path.extname(absolute).toLowerCase()] ?? 'application/octet-stream' };
}

/** 识别指令：给模型的硬规则都在这里，面板与命令共用同一段文字。 */
function recognitionPrompt(files) {
  const list = files
    .map((file) => `- ${file.name ?? file.relPath}（绝对路径：${file.absolutePath}）`)
    .join('\n');

  const ocrBlocks = files
    .filter((file) => file.ocr !== undefined)
    .map((file) => {
      if (file.ocr.ok !== true) {
        return `【${file.name}】${describeOcr(file.ocr)}`;
      }
      return [
        `【${file.name}】${describeOcr(file.ocr)}`,
        '<<<OCR 开始>>>',
        file.ocr.preview,
        file.ocr.truncated === true ? '……（以下省略，全文见下面的文件路径）' : '',
        '<<<OCR 结束>>>',
        `完整 OCR 文本（含每段的栏位与坐标）：${file.ocrPath}`,
      ].filter((part) => part !== '').join('\n');
    })
    .join('\n\n');

  return `【错题本 · 入库任务】

请把下面这份原卷里【打了红叉（批改错误）的题】录进错题本——不是全部题目。
${list}

 ⚠️ 必须执行的第 0 步（人工确认错题题号，不可跳过）：
 你（模型）看不清红笔批改的叉/勾，所以「哪些题是错题」必须由用户确认，绝不能自己猜或把全部题目都入库。
 1. 先通读上面的 OCR 与完整文本文件，列出这份原卷出现的所有题号（多份试卷可用「卷名-题号」前缀区分）。
 2. 调用 ask_user_question 工具，用多选（multi_select: true）把这些题号作为选项让用户勾选「哪些题打了红叉、需要录入」；
    问题写「以下题中哪些是打了红叉需要录入的错题？（未勾选的不录入）」。
 3. 在用户答复之前，不要调用任何 cuotiji_save。
 4. 收到用户勾选的题号后，只对被勾选的题执行下面的入库规则；其余题目一律不录入。
 5. 若已有部分题在错题本里（可先用 cuotiji_search 查），提示用户是否覆盖，避免重复。
 若当前会话没有 ask_user_question 工具，就停下来，用文字把题号列表发给用户请其回复要录入的题号，等答复后再继续。

${ocrBlocks === '' ? '' : `${ocrBlocks}

**关于上面的 OCR**：它由本机 RapidOCR（PP-OCR）识别，图片没有上传到任何服务器。
- 以 OCR 文字为底稿逐字录入；OCR 的明显错讹**不要静默改通顺**，必须在 stem 末尾写「⚠ 识别存疑：……」说明原样保留了什么。
- 分栏归属、示意图/电路图/几何图的内容、手写答案，OCR 都不可靠，须结合原图（或下面的完整文本文件）判断；判断不了就标存疑，绝不猜。
- 若 OCR 缺失或明显残缺，先读原图，再按规则标注。

`}硬性规则（违反任何一条都不算完成）：
1. 逐字完整抄录题干。不许概括、压缩、改写、合并小问；选择题的题干与全部选项都要抄全。
2. 表格一律还原成 GFM 表格（形如 | 列1 | 列2 |），保留表头与每一行数据。
3. 公式保留原文，用 $...$ 包裹，不要自己重写成结论。
4. 配图、示意图、电路图、几何图：不要用文字描述代替。**每道题的配图必须是「只含该题的单独截图」，绝不是整张试卷**——
    整页原卷会让每道题都重复出现整张卷子，无法对应到具体题目，也浪费版面。
    做法：用本机 OCR 的带坐标结果（_inbox/_ocr/ 下每段文字含坐标，或用 rapidocr 重跑取 boxes）定位本题题号，
    按题号与下一题题号的边界（双栏要按栏、跨页题要合并两页）把该题连同示意图裁成单独图片，
    存到 错题本/<学科>/assets/<题号>/第N题.png，figures 传 { source: 该单题截图绝对路径, caption: "原卷原件 · 第N题" }。
    截图须含完整题干、全部选项/小问和示意图，宁可略宽不要裁掉内容；确实无法裁切才退回整页并标注存疑。
5. 解题思路要写「为什么这样做」：先判断考点，再写关键步骤，最后写易错点，不是只写最终答案。
6. 答案单独写清楚，选择题写选项和内容。
7. 分类：subject 是学科（数学/语文/英语/物理/化学/生物/历史/地理/政治/科学…），
   chapter 是教材章节名，topics 是该题考到的 1-3 个知识点。
8. 凡是看不清、拿不准、疑似识别错误的地方，在 stem 末尾单独加一行「⚠ 识别存疑：……」，绝对不要猜。

只对第 0 步中用户勾选的题，每题用一次 cuotiji_save 入库；未勾选的题一律不入库。
全部做完后回报：入库了几道题、每道题的题号与知识点、以及哪些地方存在识别存疑。`;
}

/**
 * 对收件箱里的图片先跑一遍本地 OCR，并把全文落到 `_inbox/_ocr/` 下供模型随时读取。
 *
 * 只对图片做（PDF 等交给模型直读）；最多处理 `maxImages` 张，避免一次上传十几张时
 * 让「交给模型识别」这个按钮卡上几分钟。
 */
async function attachOcr(files, dirs, { maxImages = 3 } = {}) {
  const images = files.filter((file) => isOcrCandidate(file.absolutePath));
  if (images.length === 0) return files;

  const sidecarDir = path.join(dirs.root, '_inbox', '_ocr');
  await fsp.mkdir(sidecarDir, { recursive: true });

  const limit = Math.min(images.length, maxImages);
  for (let index = 0; index < limit; index += 1) {
    const file = images[index];
    const result = await runOcr(file.absolutePath);
    const safeName = path.basename(file.name, path.extname(file.name)).replace(/[\\/:*?"<>|]/g, '-');
    let ocrPath = '';
    if (result.ok === true) {
      ocrPath = path.join(sidecarDir, `${safeName}.ocr.txt`);
      const header = `# ${file.name}\n# ${describeOcr(result)}\n\n`;
      await fsp.writeFile(ocrPath, header + result.text, 'utf8');
    }
    const lines = result.ok === true ? result.lines : [];
    file.ocr = {
      ok: result.ok === true,
      reason: result.reason,
      engine: result.engine,
      lines,
      size: result.size,
      elapsed: result.elapsed,
      // 送进提示词的部分做个上限，避免超长页面撑爆上下文
      preview: lines.slice(0, 400).join('\n'),
      truncated: lines.length > 400,
    };
    file.ocrPath = ocrPath;
  }

  if (images.length > limit) {
    files.push({
      name: '（其余图片未做本地 OCR）',
      relPath: '',
      absolutePath: '',
      ocr: { ok: false, reason: `本次只对前 ${limit} 张图片跑了本地 OCR，其余请直接读原图。` },
    });
  }
  return files;
}

/** 找到可以接收指令的 Agent（最近创建的那个）。 */
function pickAgent(ctx) {
  let listed = [];
  try {
    listed = ctx.agents.list();
  } catch {
    listed = [];
  }
  return listed.length === 0 ? undefined : listed[listed.length - 1];
}

/** 把一段识别任务推给当前会话。 */
function steerRecognition(ctx, files) {
  const agent = pickAgent(ctx);
  if (agent === undefined) {
    return { recognized: false, note: '当前没有活跃会话；文件已存进收件箱，等会话打开后点「识别收件箱」。' };
  }
  try {
    agent.steer(userMessage(recognitionPrompt(files)));
    return { recognized: true, note: '已把识别任务交给当前会话。' };
  } catch (error) {
    return { recognized: false, note: `投递失败：${String(error?.message ?? error)}` };
  }
}

/**
 * 把模型给的册/章/节对齐到教材目录；对不上直接抛错并给候选。
 *
 * 该学科还没有目录数据时放行（`checked: false`），避免整个插件被一科缺失卡死；
 * 面板会在分类树与统计里显示该科「无目录」。
 */
function classify(taxonomies, args) {
  const subject = String(args.subject ?? '').trim();
  const book = String(args.book ?? '').trim();
  const chapter = String(args.chapter ?? '').trim();
  const section = String(args.section ?? '').trim();
  const taxonomy = taxonomies[subject];

  if (taxonomy === undefined) return { book, chapter, section, checked: false };

  if (chapter === '') {
    const books = outlineOf(taxonomy).map((item) => `${item.book}（${item.chapters.length} 章）`).join('、');
    throw new Error(`「${subject}」必须给 chapter，且要取自教材目录。目录里的册：${books}。先调用 cuotiji_taxonomy 取准确章名。`);
  }

  const found = findChapter(taxonomy, chapter);
  if (found === undefined) {
    const candidates = suggestChapters(taxonomy, chapter);
    throw new Error(
      `「${chapter}」不是「${subject}」教材目录里的章。最接近的候选：${candidates.join('、') || '（无）'}。`
      + '请用 cuotiji_taxonomy 查准章名后再保存。',
    );
  }

  let resolvedSection = '';
  if (section !== '') {
    const foundSection = findSection(taxonomy, found.chapter.chapter, section);
    if (foundSection === undefined) {
      const candidates = found.chapter.sections.map((item) => item.section).slice(0, 12).join('、');
      throw new Error(
        `「${section}」不是「${found.chapter.chapter}」里的节。该章的节：${candidates || '（这一章还没收录节）'}。`
        + '拿不准就把 section 留空，不要编。',
      );
    }
    resolvedSection = foundSection.section.section;
  }

  return {
    book: found.book.book === '' ? book : found.book.book,
    chapter: found.chapter.chapter,
    section: resolvedSection,
    checked: true,
  };
}

/**
 * 插件入口。
 * @param ctx Host 上下文
 * @param config 本插件的配置（可选）
 */
export async function apply(ctx, config = {}) {
  const taxonomies = await loadTaxonomies();
  // ── 1. 面板使用的精确路由 ────────────────────────────────────────────────
  const routes = [
    {
      path: `${ROUTE_PREFIX}/state`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          return jsonOf(await readState(ctx, config, undefined, taxonomies));
        } catch (error) {
          return failure(error);
        }
      },
    },
    {
      path: `${ROUTE_PREFIX}/file`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const relative = new URL(request.url).searchParams.get('path') ?? '';
          if (relative === '') return new Response('missing path', { status: 400 });
          const dirs = dirsFor(ctx, config);
          const asset = await readAsset(dirs.root, relative);
          return new Response(asset.data, {
            status: 200,
            headers: { 'content-type': asset.mediaType, 'cache-control': 'private, max-age=60' },
          });
        } catch (error) {
          return new Response(String(error?.message ?? error), { status: 404 });
        }
      },
    },
    {
      path: `${ROUTE_PREFIX}/upload`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const url = new URL(request.url);
          const fileName = url.searchParams.get('name') ?? 'upload';
          const recognize = url.searchParams.get('recognize') !== '0';
          const bytes = new Uint8Array(await request.arrayBuffer());
          if (bytes.byteLength === 0) return jsonOf({ ok: false, error: '上传内容为空。' });

          const dirs = dirsFor(ctx, config);
          const saved = await saveInboxFile(dirs.root, fileName, bytes);
          const result = recognize
            ? steerRecognition(ctx, [{ name: fileName, relPath: saved.relPath, absolutePath: saved.absolutePath }])
            : { recognized: false, note: '文件已存进收件箱。' };
          return jsonOf({
            ok: true,
            saved: { ...saved, kind: kindOfFile(fileName), bytes: bytes.byteLength },
            ...result,
          });
        } catch (error) {
          return failure(error);
        }
      },
    },
    {
      path: `${ROUTE_PREFIX}/recognize`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = await request.json().catch(() => ({}));
          const dirs = dirsFor(ctx, config);
          const inbox = await listInbox(dirs.root);
          const wanted = Array.isArray(body.relPaths) && body.relPaths.length > 0
            ? inbox.filter((file) => body.relPaths.includes(file.relPath))
            : inbox;
          if (wanted.length === 0) return jsonOf({ ok: false, error: '收件箱里没有待识别的原件。' });
          const files = wanted.map((file) => ({
            ...file,
            absolutePath: path.join(dirs.root, file.relPath),
          }));
          // 先把图片在本机 OCR 成文字，再连同原图一起交给模型：
          // 模型没有图片输入能力时也能逐字录入，有图片能力时可用原图核对分栏与手写答案。
          await attachOcr(files, dirs);
          const steered = steerRecognition(ctx, files);
          return jsonOf({
            ok: true,
            ...steered,
            count: files.filter((file) => file.relPath !== '').length,
            ocr: files
              .filter((file) => file.ocr !== undefined)
              .map((file) => ({
                file: file.name,
                ok: file.ocr.ok === true,
                engine: file.ocr.engine,
                lines: Array.isArray(file.ocr.lines) ? file.ocr.lines.length : 0,
                reason: file.ocr.reason,
              })),
          });
        } catch (error) {
          return failure(error);
        }
      },
    },
    {
      path: `${ROUTE_PREFIX}/save`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = await request.json();
          const dirs = dirsFor(ctx, config);
          const record = await saveQuestion(dirs.root, body);
          return jsonOf({ ok: true, question: record });
        } catch (error) {
          return failure(error);
        }
      },
    },
    {
      path: `${ROUTE_PREFIX}/delete`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = await request.json();
          const dirs = dirsFor(ctx, config);
          return jsonOf({ ok: await deleteQuestion(dirs.root, String(body.id ?? '')) });
        } catch (error) {
          return failure(error);
        }
      },
    },
    {
      path: `${ROUTE_PREFIX}/export`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = await request.json().catch(() => ({}));
          const dirs = dirsFor(ctx, config);
          const questions = await listQuestions(dirs.root);
          const picked = selectQuestions(questions, {
            ...(body.filter ?? {}),
            ids: body.ids,
            from: body.from,
            to: body.to,
            dateField: body.dateField,
          });
          const result = await exportQuestions(dirs.root, dirs.exportDir, picked, {
            split: body.split === true,
            format: body.format ?? 'pdf',
            // 不传 subtitle：导出记录（已选 N 道 / 关键词 / 日期）不写进文档页眉。
          });
          return jsonOf({ ok: true, ...result });
        } catch (error) {
          return failure(error);
        }
      },
    },
  ];

  for (const route of routes) {
    ctx.effect(() => ctx.connection.fetch.register(route), `dsh-cuotiji: ${route.path}`);
  }

  // ── 2. Agent 工具 ────────────────────────────────────────────────────────
  ctx.tools.register(tool({
    name: 'cuotiji_save',
    description:
      'Write one mistake into the mistake notebook (错题本). Use it once per question after reading an exam or homework file. '
      + 'The subject/chapter/section must be copied from cuotiji_taxonomy (浙江省在用教材目录); a chapter outside that catalogue is rejected with candidates. '
      + 'Copy the stem verbatim: never summarise, shorten, rewrite, or merge sub-questions; render tables as GFM tables; keep formulas as $...$ text. '
      + 'For figures, pass a SEPARATE screenshot containing ONLY this question (crop the full page by the question-number coordinates from OCR boxes; never attach the whole exam page for every question). '
      + 'Write the reasoning in analysis (why, step by step), not just the answer.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['subject', 'chapter', 'stem', 'analysis', 'answer'],
      properties: {
        subject: { type: 'string', description: '学科：科学、数学、语文、英语、历史与社会、道德与法治等。' },
        book: { type: 'string', description: '册，如「七年级上册」；能确定就填，留空时按目录自动补。' },
        chapter: { type: 'string', description: '章名，必须逐字取自 cuotiji_taxonomy 的目录（如「第2章 丰富多彩的生命世界」）。' },
        section: { type: 'string', description: '节名，同样取自目录（如「第1节 生物体的基本单位」）；拿不准就留空，不要编。' },
        topics: { type: 'array', items: { type: 'string' }, description: '该题考到的 1-3 个知识点标签（自由标注，不受目录限制）。' },
        q: { type: 'string', description: '题号，如「7」「三、2」；留空则用文件 id。' },
        source: { type: 'string', description: '出处，如「2026-11 期中卷 第7题」。' },
        stem: { type: 'string', description: '题干全文，逐字抄录；支持 **粗体**、`等宽`、GFM 表格、行内 $公式$。' },
        subQuestions: { type: 'array', items: { type: 'string' }, description: '各小问，按出现顺序，一问一段。' },
        analysis: { type: 'array', items: { type: 'string' }, description: '解题过程，按步骤分段：考点判断 → 关键步骤 → 易错点。' },
        answer: { type: 'string', description: '最终答案。' },
        figures: {
          type: 'array',
          description: '本题单独截图（只含这一道题，绝不是整张试卷）。每项 { source, caption }；source 是该单题截图的绝对路径或错题本内相对路径。',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['source'],
            properties: {
              source: { type: 'string' },
              caption: { type: 'string' },
            },
          },
        },
        id: { type: 'string', description: '更新已有题目时传它的 id，题号与目录保持不变。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['saved', 'id', 'relPath', 'total'],
        properties: {
          saved: { type: 'boolean' },
          id: { type: 'string' },
          relPath: { type: 'string' },
          total: { type: 'integer' },
        },
      },
      render: (value) => `已入库：${value.id}（${value.relPath}）。错题本现在共 ${value.total} 道题。`,
    },
    async execute(args, exec) {
      const dirs = dirsFor(ctx, config, exec.agent);
      await ensureRoot(dirs.root);
      const located = classify(taxonomies, args);
      const record = await saveQuestion(dirs.root, { ...args, ...located });
      const total = (await listQuestions(dirs.root)).length;
      return { saved: true, id: record.id, relPath: record.relPath, total };
    },
  }));

  ctx.tools.register(tool({
    name: 'cuotiji_taxonomy',
    description:
      'Read the textbook catalogue (浙江省在用教材, 学科 → 册 → 章 → 节) that cuotiji_save validates against. '
      + 'Call it before classifying a question, and again whenever cuotiji_save rejects a chapter: copy the exact chapter/section text from here.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['subject'],
      properties: {
        subject: { type: 'string', description: '学科，如 科学、数学、语文、英语、历史与社会、道德与法治。' },
        book: { type: 'string', description: '只看某一册，如「七年级上册」；留空返回全部。' },
        chapter: { type: 'string', description: '只列某一章的节；留空列全部章。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['subject', 'found', 'lines'],
        properties: {
          subject: { type: 'string' },
          found: { type: 'boolean' },
          lines: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (value) => (value.found === false
        ? `没有「${value.subject}」的教材目录数据，这一科可以自由填写章节名。`
        : `「${value.subject}」教材目录（${value.lines.length} 行）：\n${value.lines.join('\n')}`),
    },
    async execute(args) {
      const subject = String(args.subject ?? '').trim();
      const taxonomy = taxonomies[subject];
      if (taxonomy === undefined) {
        return {
          subject,
          found: false,
          lines: [`已收录目录的学科：${Object.keys(taxonomies).join('、') || '（暂无）'}`],
        };
      }
      const bookFilter = String(args.book ?? '').trim();
      const chapterFilter = String(args.chapter ?? '').trim();
      const lines = [];
      for (const book of outlineOf(taxonomy)) {
        if (bookFilter !== '' && !sameName(book.book, bookFilter)) continue;
        if (chapterFilter !== '' && book.chapters.every((chapter) => !sameName(chapter.chapter, chapterFilter))) continue;
        for (const chapter of book.chapters) {
          if (chapterFilter !== '' && !sameName(chapter.chapter, chapterFilter)) continue;
          if (chapter.sections.length === 0) {
            lines.push(`${book.book} | ${chapter.chapter} |（这一章还没收录节）`);
            continue;
          }
          for (const section of chapter.sections) {
            lines.push(`${book.book} | ${chapter.chapter} | ${section.section}${section.unverified === true ? '（节名待核）' : ''}`);
          }
        }
      }
      return { subject, found: true, lines };
    },
  }));

  ctx.tools.register(tool({
    name: 'cuotiji_search',
    description:
      'Look up mistakes already in the mistake notebook (错题本) by subject, chapter, knowledge point, or free text. '
      + 'Use it before saving to avoid duplicates, and when the user asks to review the mistakes of one knowledge point.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '在题干、解析、答案、出处、知识点里做的子串搜索。' },
        subject: { type: 'string', description: '限定学科。' },
        book: { type: 'string', description: '限定册，如「七年级上册」。' },
        chapter: { type: 'string', description: '限定章。' },
        section: { type: 'string', description: '限定节。' },
        topic: { type: 'string', description: '限定知识点标签（精确匹配）。' },
        full: { type: 'boolean', description: 'true 时返回题干全文，默认只给摘要。' },
        limit: { type: 'integer', description: '最多返回条数，默认 20。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['total', 'items'],
        properties: {
          total: { type: 'integer' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'q', 'subject', 'chapter', 'topics', 'source', 'excerpt'],
              properties: {
                id: { type: 'string' },
                q: { type: 'string' },
                subject: { type: 'string' },
                chapter: { type: 'string' },
                topics: { type: 'array', items: { type: 'string' } },
                source: { type: 'string' },
                excerpt: { type: 'string' },
              },
            },
          },
        },
      },
      render: (value) => (value.total === 0
        ? '错题本里还没有符合条件的题目。'
        : `匹配 ${value.total} 道题：\n${value.items.map((item) => `· [${item.q}] ${item.subject}·${item.chapter} ${item.topics.join('/')} — ${item.excerpt}`).join('\n')}`),
    },
    async execute(args, exec) {
      const dirs = dirsFor(ctx, config, exec.agent);
      const all = await listQuestions(dirs.root);
      const picked = selectQuestions(all, args);
      const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 20;
      return {
        total: picked.length,
        items: picked.slice(0, limit).map((item) => ({
          id: item.id,
          q: item.q === '' ? item.id : item.q,
          subject: item.subject,
          chapter: item.chapter,
          topics: item.topics,
          source: item.source,
          excerpt: args.full === true ? item.stem : item.stem.replace(/\s+/g, ' ').slice(0, 120),
        })),
      };
    },
  }));

  ctx.tools.register(tool({
    name: 'cuotiji_export',
    description:
      'Export the mistake notebook as a one-question-per-page A4 mistake set: a .pdf plus its source .docx and a printable .html. '
      + 'Filter by subject, chapter, knowledge point, or free text; set split to produce one book per subject and chapter.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        subject: { type: 'string', description: '只导出该学科。' },
        chapter: { type: 'string', description: '只导出该章节。' },
        topic: { type: 'string', description: '只导出该知识点。' },
        query: { type: 'string', description: '限定搜索词。' },
        ids: { type: 'array', items: { type: 'string' }, description: '只导出这些题号（面板里手选/批量选中的结果）。给了 ids 就忽略其它筛选条件里的目录项。' },
        from: { type: 'string', description: '入库日期下界，格式 YYYY-MM-DD（含当天）。' },
        to: { type: 'string', description: '入库日期上界，格式 YYYY-MM-DD（含当天）。' },
        dateField: { type: 'string', enum: ['createdAt', 'updatedAt'], description: '按哪个日期筛，默认 createdAt（入库时间）。' },
        split: { type: 'boolean', description: 'true 时按学科+章节分册导出。' },
        format: { type: 'string', enum: ['pdf', 'docx', 'html'], description: '默认 pdf：同时产出 docx 与 html，再把 docx 转成 PDF（保留页眉页脚页码）。docx 只出 docx+html；html 只出 html。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['count', 'split', 'files'],
        properties: {
          count: { type: 'integer' },
          split: { type: 'boolean' },
          files: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (value) => {
        const head = `已导出 ${value.count} 道题${value.split ? '（分册）' : ''}：\n${value.files.map((file) => `· ${file}`).join('\n')}`;
        const warnings = Array.isArray(value.warnings) ? value.warnings : [];
        return warnings.length === 0 ? head : `${head}\n\n注意：\n${warnings.map((item) => `· ${item}`).join('\n')}`;
      },
    },
    async execute(args, exec) {
      const dirs = dirsFor(ctx, config, exec.agent);
      const all = await listQuestions(dirs.root);
      const picked = selectQuestions(all, args);
      const result = await exportQuestions(dirs.root, dirs.exportDir, picked, {
        split: args.split === true,
        format: args.format ?? 'pdf',
      });
      return {
        count: result.count,
        split: result.split,
        files: result.outputs.map((output) => output.path),
        warnings: result.warnings ?? [],
      };
    },
  }));

  // ── 3. `/cuotiji` 斜杠命令 ──────────────────────────────────────────────
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'cuotiji',
      description: '错题本：导出错题集，或把收件箱里的原卷交给模型识别',
      input: { hint: '[export [学科] [章节] [知识点]|ingest|list]' },
      handler: async ({ agent, rawInput }) => {
        const tokens = rawInput.trim().split(/\s+/).filter((token) => token !== '');
        const action = tokens[0] ?? 'export';
        const dirs = dirsFor(ctx, config, agent);

        if (action === 'ingest') {
          await ensureRoot(dirs.root);
          const inbox = await listInbox(dirs.root);
          if (inbox.length === 0) {
            return { kind: 'error', text: '收件箱是空的，先把试卷图片或 PDF 放进错题本的 _inbox 目录。' };
          }
          const files = inbox.map((file) => ({ ...file, absolutePath: path.join(dirs.root, file.relPath) }));
          const result = steerRecognition(ctx, files);
          if (!result.recognized) return { kind: 'error', text: result.note };
          return { kind: 'success', text: `已把 ${files.length} 份原卷交给模型识别。` };
        }

        if (action === 'list') {
          const questions = await listQuestions(dirs.root);
          if (questions.length === 0) return { kind: 'success', text: '错题本还是空的。' };
          const text = buildIndex(questions)
            .map((subject) => `${subject.subject}（${subject.count}）\n${subject.chapters.map((chapter) => `  · ${chapter.chapter}（${chapter.count}）：${chapter.topics.map((topic) => topic.topic).join('、')}`).join('\n')}`)
            .join('\n');
          return { kind: 'success', text: `共 ${questions.length} 道错题：\n${text}` };
        }

        try {
          const questions = await listQuestions(dirs.root);
          const picked = selectQuestions(questions, {
            subject: tokens[1],
            chapter: tokens[2],
            topic: tokens[3],
          });
          const result = await exportQuestions(dirs.root, dirs.exportDir, picked, { format: 'pdf' });
          return {
            kind: 'success',
            text: `已导出 ${result.count} 道题：\n${result.outputs.map((output) => output.path).join('\n')}`,
          };
        } catch (error) {
          return { kind: 'error', text: String(error?.message ?? error) };
        }
      },
    });
  });

  // ── 4. 常驻提示词：让模型知道错题本存在，并守住双轨规则 ─────────────────
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: 'cuotiji',
      order: 3200,
      text: `## 错题本

工作区里有一个「错题本」文件夹：每道错题一个 JSON，原卷图放在同目录的 assets/<题号>/ 下。面板与工具读写同一份文件。

- 用户上传试卷/作业（图片、PDF、Markdown）并要求整理错题时：先读原件和 OCR，把识别到的题号列出来，用 ask_user_question（多选）请用户勾选哪些题打了红叉需要录入；**只录入用户勾选的错题，绝不全录、也不自己猜哪些错**。用户答复前不要调用 cuotiji_save。确认后再逐题入库，一题一次；遇到题干跨页要合并两页内容、并把两页原图都作为该题配图。
- **归类必须落在中国浙江在用教材的目录里**：入库前先调用 cuotiji_taxonomy 取该学科的「册 / 章 / 节」原文，
  把 chapter、section **逐字照抄**进去。写错会被 cuotiji_save 拒绝并给出候选，不要换一种写法硬试。
- topics 是自由标注的知识点标签，不受目录限制；章节归类才是硬约束。
- 抄录题面必须逐字完整：不许概括、压缩、改写、合并小问；表格还原成 GFM 表格；公式保留 $...$ 原文。
- 配图必须是「只含该题的单独截图」，不是整张试卷：按 OCR 题号坐标把该题（含示意图）裁成单独图片，再作为 figures 传入。绝不给每道题都挂整页原卷。
- analysis 写解题思路（考点判断 → 关键步骤 → 易错点），不是只写答案；answer 单独写最终答案。
- 看不清的地方写「⚠ 识别存疑：……」，不要猜。
- 用户问某个知识点的错题时先用 cuotiji_search；要成册时用 cuotiji_export。`,
    });
  });
}

// 供 _dev 自测直接调用（不参与运行时行为）
export { attachOcr, recognitionPrompt };
