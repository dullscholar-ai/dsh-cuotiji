/**
 * 错题本的数据层：工作区文件夹就是真相源。
 *
 * 目录约定（root 默认 `<工作区>/错题本`）：
 *   _inbox/                       上传但尚未识别的原件
 *   <学科>/<题号>.json             一题一文件
 *   <学科>/assets/<题号>/<文件>     原卷裁切图、配图
 *   <学科>/keypoints.md           可选的知识点大纲
 *
 * 这里只做纯文件读写，不认识 Cordis 与 Agent；HTTP 路由、工具、命令共用这一层，
 * 保证「面板上的操作」和「模型调用的工具」落到同一份数据上。
 * @module @dullscholar-ai/dsh-cuotiji/lib/store
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

/** 允许的学科目录名；不在表内的学科名会被清洗后原样建目录。 */
export const KNOWN_SUBJECTS = [
  '语文', '数学', '英语', '物理', '化学', '生物',
  '历史', '地理', '政治', '科学', '道德与法治',
];

const INBOX = '_inbox';
const ASSETS = 'assets';

/** 去掉路径分隔符与 Windows 非法字符，得到一个可做目录/文件名的片段。 */
export function safeName(input, fallback = '未分类') {
  const text = String(input ?? '').trim();
  if (text === '') return fallback;
  const cleaned = text
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 60);
  return cleaned === '' ? fallback : cleaned;
}

/** 把任意路径统一成记录里使用的正斜杠相对路径。 */
function toPosix(p) {
  return p.split(path.sep).join('/');
}

/**
 * 把相对路径解析成 root 内的绝对路径；越界直接抛错。
 * @param root 错题本根目录的绝对路径
 * @param relative 记录里保存的正斜杠相对路径
 */
export function containedPath(root, relative) {
  const target = path.resolve(root, relative);
  const base = path.resolve(root);
  const rel = path.relative(base, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`路径越界：${relative}`);
  }
  return target;
}

async function exists(p) {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 建立根目录与收件箱。 */
export async function ensureRoot(root) {
  await fsp.mkdir(path.join(root, INBOX), { recursive: true });
}

/**
 * 扫描全部错题。
 * @param root 根目录绝对路径
 * @returns 按「学科 → 章节 → 题号」排好序的记录数组，每条附带 `relPath`
 */
export async function listQuestions(root) {
  let subjects;
  try {
    subjects = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of subjects) {
    if (!entry.isDirectory()) continue;
    if (entry.name === INBOX) continue;
    const subjectDir = path.join(root, entry.name);
    let files;
    try {
      files = await fsp.readdir(subjectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      const relPath = toPosix(path.join(entry.name, file.name));
      try {
        const record = JSON.parse(await fsp.readFile(path.join(subjectDir, file.name), 'utf8'));
        out.push(normalize(record, { relPath, fallbackSubject: entry.name }));
      } catch (error) {
        out.push({
          id: relPath,
          subject: entry.name,
          chapter: '（无法解析）',
          topics: [],
          stem: `这个文件不是合法的错题 JSON：${relPath}\n${String(error?.message ?? error)}`,
          subQuestions: [],
          analysis: [],
          answer: '',
          figures: [],
          broken: true,
          relPath,
        });
      }
    }
  }
  out.sort((a, b) =>
    a.subject.localeCompare(b.subject, 'zh')
    || a.chapter.localeCompare(b.chapter, 'zh')
    || String(a.q ?? '').localeCompare(String(b.q ?? ''), 'zh', { numeric: true })
    || a.id.localeCompare(b.id));
  return out;
}

/** 补齐缺失字段，保证面板拿到稳定结构。 */
function normalize(record, { relPath, fallbackSubject }) {
  const figures = Array.isArray(record.figures)
    ? record.figures
      .map((figure) => (typeof figure === 'string' ? { path: figure } : figure))
      .filter((figure) => figure && typeof figure.path === 'string' && figure.path !== '')
      .map((figure) => ({ path: figure.path, caption: String(figure.caption ?? '') }))
    : [];
  return {
    id: String(record.id ?? relPath),
    q: record.q === undefined || record.q === null ? '' : String(record.q),
    subject: String(record.subject ?? fallbackSubject),
    book: String(record.book ?? ''),
    chapter: String(record.chapter ?? ''),
    section: String(record.section ?? ''),
    topics: Array.isArray(record.topics) ? record.topics.map(String) : [],
    source: String(record.source ?? ''),
    stem: String(record.stem ?? ''),
    subQuestions: Array.isArray(record.subQuestions) ? record.subQuestions.map(String) : [],
    analysis: Array.isArray(record.analysis) ? record.analysis.map(String) : [],
    answer: String(record.answer ?? ''),
    figures,
    createdAt: String(record.createdAt ?? ''),
    updatedAt: String(record.updatedAt ?? ''),
    relPath,
  };
}

/** 从扫描结果里按 id 找一条。 */
export async function findQuestion(root, id) {
  const all = await listQuestions(root);
  return all.find((item) => item.id === id || item.relPath === id);
}

function timestamp() {
  return Date.now().toString(36);
}

/** 生成一个在该学科目录内不冲突的题号。 */
async function nextId(root, subject) {
  const dir = path.join(root, safeName(subject, '未分类'));
  let seq = 1;
  for (;;) {
    const id = `${safeName(subject, '未分类')}-${String(seq).padStart(4, '0')}`;
    if (!(await exists(path.join(dir, `${id}.json`)))) return id;
    seq += 1;
  }
}

/**
 * 写入一道错题：分配题号、复制原图、落盘 JSON。
 *
 * 已存在（传了 id 且文件在）时原地更新，题号与目录保持不变。
 * @param root 根目录
 * @param input 题目字段；`figures` 里每项可以是字符串路径，也可以是 `{ source, caption }`
 * @returns 归一化后的记录
 */
export async function saveQuestion(root, input) {
  const subject = safeName(input.subject, '未分类');
  const subjectDir = path.join(root, subject);
  await fsp.mkdir(subjectDir, { recursive: true });

  let id = input.id ? safeName(input.id, '') : '';
  if (id === '') id = await nextId(root, subject);
  const filePath = path.join(subjectDir, `${id}.json`);

  // 读取已有记录：面板「保存修改」的草稿不带 figures/book/section，
  // 编辑保存时必须从原记录继承这些字段，否则配图（和册、节）会被清空。
  let existing = null;
  if (await exists(filePath)) {
    try {
      existing = JSON.parse(await fsp.readFile(filePath, 'utf8'));
    } catch {
      existing = null;
    }
  }

  let createdAt = input.createdAt ?? '';
  if (createdAt === '' && existing) {
    createdAt = String(existing.createdAt ?? '');
  }
  if (createdAt === '') createdAt = new Date().toISOString();

  const assetDir = path.join(subjectDir, ASSETS, id);
  const figures = [];
  if (Array.isArray(input.figures)) {
    // 调用方显式给了配图：照旧重建并复制图片。
    for (const raw of input.figures) {
      const figure = typeof raw === 'string' ? { source: raw } : raw;
      const source = String(figure?.source ?? figure?.path ?? '').trim();
      if (source === '') continue;
      const absoluteSource = path.isAbsolute(source) ? source : path.resolve(root, source);
      if (!(await exists(absoluteSource))) {
        throw new Error(`配图不存在：${source}`);
      }
      await fsp.mkdir(assetDir, { recursive: true });
      const base = path.basename(absoluteSource);
      const target = path.join(assetDir, base);
      if (path.resolve(absoluteSource) !== path.resolve(target)) {
        await fsp.copyFile(absoluteSource, target);
      }
      figures.push({
        path: toPosix(path.relative(root, target)),
        caption: String(figure?.caption ?? ''),
      });
    }
  } else if (existing && Array.isArray(existing.figures)) {
    // 没传配图字段：保留原记录已入库的配图，避免「保存修改」把截图抹掉。
    for (const figure of existing.figures) {
      const p = String(figure?.path ?? '').trim();
      if (p === '') continue;
      figures.push({ path: p, caption: String(figure?.caption ?? '') });
    }
  }

  // 客户端草稿未携带的字段沿用原值，避免编辑后被清空。
  const inherited = {
    book: input.book !== undefined ? input.book : (existing?.book ?? ''),
    section: input.section !== undefined ? input.section : (existing?.section ?? ''),
  };

  const record = normalize(
    {
      ...input,
      ...inherited,
      id,
      subject,
      figures,
      createdAt,
      updatedAt: new Date().toISOString(),
    },
    { relPath: toPosix(path.join(subject, `${id}.json`)), fallbackSubject: subject },
  );
  const { relPath, ...payload } = record;
  await fsp.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return record;
}

/** 删除一条错题，连同它的配图目录。 */
export async function deleteQuestion(root, id) {
  const found = await findQuestion(root, id);
  if (found === undefined) return false;
  await fsp.rm(path.join(root, found.relPath), { force: true });
  const assetDir = path.join(root, found.subject, ASSETS, found.id);
  await fsp.rm(assetDir, { recursive: true, force: true });
  return true;
}

/**
 * 保存一次上传：落到 `_inbox/`，返回可读路径。
 * @param root 根目录
 * @param name 原始文件名
 * @param data 文件字节
 */
export async function saveInboxFile(root, name, data) {
  await ensureRoot(root);
  const safe = safeName(name, 'upload');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(root, INBOX, `${stamp}-${safe}`);
  await fsp.writeFile(target, data);
  return {
    absolutePath: target,
    relPath: toPosix(path.join(INBOX, `${stamp}-${safe}`)),
  };
}

/** 列出收件箱里尚未处理的原件，新的在前。 */
export async function listInbox(root) {
  const dir = path.join(root, INBOX);
  let files;
  try {
    files = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    if (!file.isFile()) continue;
    const absolute = path.join(dir, file.name);
    const stat = await fsp.stat(absolute);
    out.push({
      name: file.name,
      relPath: toPosix(path.join(INBOX, file.name)),
      bytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    });
  }
  out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return out;
}

/**
 * 生成「学科 → 册 → 章 → 节」索引，供面板树与导出筛选使用。
 *
 * 只统计**已有题目**的节点，不铺满整份教材目录——否则一次打开面板要渲染上千个空节点。
 * 目录顺序由 `lib/taxonomy.js` 的 `sortIndex` 负责排。
 * @param questions listQuestions 的结果
 */
export function buildIndex(questions) {
  const subjects = new Map();
  const bump = (map, key, count) => {
    const current = map.get(key) ?? 0;
    map.set(key, current + count);
  };
  const nested = new Map();

  for (const item of questions) {
    const subjectKey = item.subject;
    if (!nested.has(subjectKey)) {
      nested.set(subjectKey, { count: 0, books: new Map() });
    }
    const subject = nested.get(subjectKey);
    subject.count += 1;

    const bookKey = item.book === '' ? '（未标册）' : item.book;
    if (!subject.books.has(bookKey)) {
      subject.books.set(bookKey, { count: 0, chapters: new Map() });
    }
    const book = subject.books.get(bookKey);
    book.count += 1;

    const chapterKey = item.chapter === '' ? '（未分类）' : item.chapter;
    if (!book.chapters.has(chapterKey)) {
      book.chapters.set(chapterKey, { count: 0, sections: new Map() });
    }
    const chapter = book.chapters.get(chapterKey);
    chapter.count += 1;

    if (item.section !== '') bump(chapter.sections, item.section, 1);
    void subjects;
  }

  return [...nested.entries()]
    .map(([subject, value]) => ({
      subject,
      count: value.count,
      books: [...value.books.entries()].map(([book, bookValue]) => ({
        book,
        count: bookValue.count,
        chapters: [...bookValue.chapters.entries()].map(([chapter, chapterValue]) => ({
          chapter,
          count: chapterValue.count,
          sections: [...chapterValue.sections.entries()].map(([section, count]) => ({ section, count })),
        })),
      })),
    }));
}

/** 该文件是图片还是别的东西，用于面板选择展示方式。 */
export function kindOfFile(name) {
  const ext = path.extname(name).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (['.md', '.markdown', '.txt'].includes(ext)) return 'text';
  return 'other';
}
