/**
 * 错题集的筛选与导出。
 *
 * 一次导出可以产出：
 *   - `.docx`：一题一页 A4，题头 / ① 原题 / ② 解题过程（右侧并排原卷图）/ ③ 答案
 *   - `.html`：同版式，浏览器打印即 PDF
 * 传 `split: true` 时按「学科 + 章节」分册，每册一套 docx/html。
 * @module dsh-cuotiji/lib/exporters
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { renderHtml } from './render.js';

/**
 * 按条件筛选题目。
 * @param questions listQuestions 的结果
 * @param filter { subject?, chapter?, topic?, query?, ids? }
 */
/**
 * 按条件筛选题目。
 *
 * 三种「选什么」可以叠加，也可以各自单独用：
 *   - 目录坐标：subject / book / chapter / section / topic
 *   - 日期区间：from / to（含首尾整天），配合 dateField: 'createdAt'（默认）| 'updatedAt'
 *   - 手选：ids（面板里勾选的题号；给了 ids 就只在这些题里选）
 * @param questions listQuestions 的结果
 * @param filter 见上
 */
export function selectQuestions(questions, filter = {}) {
  const subject = filter.subject?.trim();
  const book = filter.book?.trim();
  const chapter = filter.chapter?.trim();
  const section = filter.section?.trim();
  const topic = filter.topic?.trim();
  const query = filter.query?.trim().toLowerCase();
  const ids = Array.isArray(filter.ids) && filter.ids.length > 0 ? new Set(filter.ids) : undefined;

  const fromTime = parseDayStart(filter.from);
  const toTime = parseDayEnd(filter.to);
  const dateField = filter.dateField === 'updatedAt' ? 'updatedAt' : 'createdAt';

  return questions.filter((item) => {
    if (ids !== undefined && !ids.has(item.id) && !ids.has(item.relPath)) return false;
    if (subject !== undefined && subject !== '' && item.subject !== subject) return false;
    if (book !== undefined && book !== '' && item.book !== book) return false;
    if (chapter !== undefined && chapter !== '') {
      const itemChapter = item.chapter === '' ? '（未分类）' : item.chapter;
      if (itemChapter !== chapter) return false;
    }
    if (section !== undefined && section !== '' && item.section !== section) return false;
    if (topic !== undefined && topic !== '' && !item.topics.includes(topic)) return false;
    if (fromTime !== undefined || toTime !== undefined) {
      const stamp = Date.parse(item[dateField]);
      if (!Number.isNaN(stamp)) {
        if (fromTime !== undefined && stamp < fromTime) return false;
        if (toTime !== undefined && stamp > toTime) return false;
      }
    }
    if (query !== undefined && query !== '') {
      const haystack = [
        item.stem, item.answer, item.source, item.chapter, item.section, item.book, item.subject,
        ...item.topics, ...item.subQuestions, ...item.analysis,
      ].join('\n').toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

/** `YYYY-MM-DD` → 当天 00:00:00.000 的时间戳；无法解析返回 undefined。 */
function parseDayStart(value) {
  const text = String(value ?? '').trim();
  if (text === '') return undefined;
  const stamp = Date.parse(`${text}T00:00:00`);
  return Number.isNaN(stamp) ? undefined : stamp;
}

/** `YYYY-MM-DD` → 当天 23:59:59.999 的时间戳；无法解析返回 undefined。 */
function parseDayEnd(value) {
  const text = String(value ?? '').trim();
  if (text === '') return undefined;
  const stamp = Date.parse(`${text}T23:59:59.999`);
  return Number.isNaN(stamp) ? undefined : stamp;
}

function stamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/**
 * 原卷图尺寸策略：兼顾「一题一页不浪费纸」与「看得清」。
 * 按每题文字量估算占用高度，把一页剩余空间尽量分给图片——文字少的题图片
 * 放大到十几厘米看清细节，文字多的题自动缩小；同时夹在合理区间内。
 * 这样每题（文字+图）恰好落在一页内，避免超长图溢出产生只占几行的尾巴页。
 */
const MAX_IMAGE_WIDTH_CM = 13;    // 版心宽度
const IMG_H_MIN_CM = 5;           // 图片最小高度，保证截图内容可读
const IMG_H_MAX_CM = 16;          // 图片最大高度
const PAGE_CONTENT_H_CM = 26;     // A4 一页可用高度（含紧凑页边距）
const FIXED_LINES = 9;            // 题头/知识点/三个小节标题/段间距/选项额外行折算
const CM_PER_LINE = 0.58;         // 11pt 正文每行高度（含行距，略保守防溢出）
const CHARS_PER_LINE = 40;        // 每行约 40 个汉字宽

/** 读 PNG / JPEG 的像素尺寸，读不出来返回 undefined。 */
async function readImageSize(absolutePath) {
  let buffer;
  try {
    buffer = await fsp.readFile(absolutePath);
  } catch {
    return undefined;
  }
  // PNG：8 字节签名 + 4 字节长度 + "IHDR" + 宽(4) + 高(4)
  if (buffer.length > 24 && buffer.readUInt32BE(0) === 0x89504e47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  // JPEG：逐段扫到 SOFn（C0–CF，排除 C4/C8/CC）
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) return undefined;
      offset += 2 + length;
    }
  }
  return undefined;
}

/**
 * 把图片按比例塞进给定宽高框（动态计算得出），保持比例不变形。
 * 拿不到像素尺寸时返回 undefined，交给 docx 生成器自己推断。
 */
async function fitImage(absolutePath, maxWidthCm, maxHeightCm) {
  const size = await readImageSize(absolutePath);
  if (size === undefined || size.width <= 0 || size.height <= 0) return undefined;
  const cmPerPx = 2.54 / 96;
  const naturalWidth = size.width * cmPerPx;
  const naturalHeight = size.height * cmPerPx;
  const scale = Math.min(1, maxWidthCm / naturalWidth, maxHeightCm / naturalHeight);
  return {
    widthCm: Math.round(naturalWidth * scale * 100) / 100,
    heightCm: Math.round(naturalHeight * scale * 100) / 100,
  };
}

/** 估算一段文字占多少行（汉字按 1 宽、西文按 0.55 宽）。 */
function estimateLines(text) {
  const clean = String(text ?? '').replace(/\r\n?/g, '\n');
  if (clean.trim() === '') return 0;
  let lines = 0;
  for (const line of clean.split('\n')) {
    let weight = 0;
    for (const ch of line) weight += /[\u2E80-\u9FFF\uFF00-\uFFEF]/.test(ch) ? 1 : 0.55;
    lines += Math.max(1, Math.ceil(weight / CHARS_PER_LINE));
  }
  return lines;
}

/** 把一条记录换成导出器要的形状。 */
async function toExportQuestion(record, root) {
  // 按本题文字量动态分配图片高度：文字少→图片大，文字多→图片小，
  // 使「文字 + 图片」恰好落在一页内，既不浪费纸也不把题图压到看不清。
  const stemText = String(record.stem ?? '').replace(/\s/g, '');
  const subs = (record.subQuestions ?? []).filter((s) => String(s).replace(/\s/g, '') !== '' && !stemText.includes(String(s).replace(/\s/g, '')));
  const textLines =
    estimateLines(record.stem)
    + subs.reduce((sum, s) => sum + estimateLines(s), 0)
    + (record.analysis ?? []).reduce((sum, a) => sum + estimateLines(a), 0)
    + estimateLines(record.answer)
    + FIXED_LINES;
  const imgMaxH = Math.max(IMG_H_MIN_CM, Math.min(IMG_H_MAX_CM, PAGE_CONTENT_H_CM - textLines * CM_PER_LINE));

  const images = [];
  for (const figure of record.figures) {
    const absolute = path.resolve(root, figure.path);
    const fitted = await fitImage(absolute, MAX_IMAGE_WIDTH_CM, imgMaxH);
    images.push({
      path: absolute,
      caption: figure.caption,
      ...fitted === undefined ? {} : fitted,
    });
  }
  return {
    q: record.q === '' ? record.id : record.q,
    subject: record.subject,
    chapter: [record.chapter, record.section].filter((part) => part !== '').join(' · '),
    topics: record.topics,
    source: record.source,
    stem: record.stem,
    subQuestions: record.subQuestions,
    analysis: record.analysis,
    answer: record.answer,
    images,
  };
}

async function writeOne(outDir, baseName, questions, options, wantDocx, wantPdf) {
  await fsp.mkdir(outDir, { recursive: true });
  const outputs = [];
  const warnings = [];

  const html = renderHtml(questions, {
    title: options.title,
    subtitle: options.subtitle,
    root: options.root,
  });
  const htmlPath = path.join(outDir, `${baseName}.html`);
  await fsp.writeFile(htmlPath, html, 'utf8');
  outputs.push({ format: 'html', path: htmlPath });

  let docxPath;
  if (wantDocx) {
    const { buildDocx } = await import('./docx.js');
    const buffer = await buildDocx(questions, {
      title: options.title,
      subtitle: options.subtitle,
    });
    docxPath = path.join(outDir, `${baseName}.docx`);
    await fsp.writeFile(docxPath, buffer);
    outputs.push({ format: 'docx', path: docxPath });
  }

  if (wantPdf) {
    const pdfPath = path.join(outDir, `${baseName}.pdf`);
    try {
      const { exportPdf } = await import('./pdf.js');
      const done = await exportPdf({ docxPath, htmlPath, pdfPath });
      outputs.push({ format: 'pdf', path: done.path });
      if (done.degraded) {
        warnings.push(
          `PDF 由 ${done.engine} 生成：本机没找到可用的 Word/WPS，所以这一份没有页眉、页脚和页码（版式仍是一题一页）。`,
        );
      }
    } catch (error) {
      warnings.push(`PDF 未生成：${String(error?.message ?? error)}`);
    }
  }

  return { outputs, warnings };
}

/**
 * 导出一份或多份错题集。
 * @param root 错题本根目录
 * @param outDir 导出目录
 * @param questions 已筛选好的题目（store 记录）
 * @param options { title?, subtitle?, split?, format? }
 * @returns { outputs: [{format, path}], count, split: boolean }
 */
export async function exportQuestions(root, outDir, questions, options = {}) {
  // format: 'pdf'（默认，docx + html + pdf）| 'docx'（docx + html）| 'html'（只出 html）
  const format = options.format ?? 'pdf';
  const wantDocx = format !== 'html';
  const wantPdf = format === 'pdf';
  const title = options.title ?? '错题集 · 详细解析';
  const exported = await Promise.all(questions.map((record) => toExportQuestion(record, root)));

  if (exported.length === 0) {
    throw new Error('没有符合条件的错题，导出已跳过。');
  }

  if (options.split !== true) {
    const written = await writeOne(
      outDir,
      `错题集-${stamp()}`,
      exported,
      { title, subtitle: options.subtitle, root },
      wantDocx,
      wantPdf,
    );
    return {
      outputs: written.outputs,
      warnings: written.warnings,
      count: exported.length,
      split: false,
    };
  }

  const groups = new Map();
  for (const record of questions) {
    const chapter = record.chapter === '' ? '未分类' : record.chapter;
    const key = `${record.subject}｜${chapter}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }

  const outputs = [];
  const warnings = [];
  const bookDir = path.join(outDir, `分册-${stamp()}`);
  for (const [key, records] of groups) {
    const [subject, chapter] = key.split('｜');
    const baseName = `${subject}-${chapter}`.replace(/[\\/:*?"<>|]/g, '-');
    const groupExported = await Promise.all(records.map((record) => toExportQuestion(record, root)));
    const written = await writeOne(
      bookDir,
      baseName,
      groupExported,
      { title: `${subject} · ${chapter}`, subtitle: options.subtitle, root },
      wantDocx,
      wantPdf,
    );
    outputs.push(...written.outputs);
    warnings.push(...written.warnings);
  }
  return {
    outputs,
    warnings,
    count: exported.length,
    split: true,
    books: groups.size,
  };
}
