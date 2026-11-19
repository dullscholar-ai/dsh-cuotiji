/**
 * 零依赖 OOXML .docx 生成器（错题集一题一页版）
 *
 * 只用 Node 内置模块：node:fs/promises、node:zlib。
 * ZIP 容器由本文件自行拼装（deflateRaw / store），不做任何第三方依赖。
 *
 * 唯一导出： buildDocx(questions, options) -> Promise<Buffer>
 *
 * 版式：A4 21×29.7cm，页边距 上1.8/下1.5/左右1.8cm，可用 17.4×26.4cm
 *      正文 微软雅黑 9.5pt / 行距 1.2
 *      每题一个 1×1 表格 + trPr/cantSplit，题间用 pageBreakBefore 起新页（不插 <w:br w:type="page"/>）
 *
 * 图片：images[].widthCm / heightCm 显式给出时按其精确换算 EMU；缺省时读文件头像素按 96dpi
 *      等比换算（仍不变形），最后统一夹到 宽 ≤ 11.2cm / 高 ≤ 20cm。
 */

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import zlib from 'node:zlib';

/* ============================================================
 * 0. 单位与常量
 * ========================================================== */

const cm2tw = (cm) => Math.round((cm * 1440) / 2.54); // 缇（1/20 pt）
const cm2emu = (cm) => Math.round(cm * 360000); // EMU（1cm = 360000 EMU）

const PAGE_W_TW = cm2tw(21); // 11906
const PAGE_H_TW = cm2tw(29.7); // 16838
const MARGIN_T = cm2tw(0.8); // 上下收紧到 0.8cm，给 11pt 正文一题一页留足高度
const MARGIN_B = cm2tw(0.8);
const MARGIN_LR = cm2tw(1.5);
const CONTENT_W_TW = PAGE_W_TW - MARGIN_LR * 2; // ≈ 18cm
const TAB_RIGHT = CONTENT_W_TW; // 页眉右对齐 tab 与版心右边界一致
const COL_LEFT_TW = cm2tw(5.6); // 3175
const COL_RIGHT_TW = cm2tw(11.2); // 6350
const MAX_IMG_W_CM = 13;
// 原卷图尺寸由 exporter 按本题文字量动态算出（见 exporters.js），
// 这里只留宽松兜底，不再二次压缩 exporter 算好的尺寸。
const MAX_IMG_H_CM = 16;

const FONT = 'Microsoft YaHei';
const FONT_EA = '\u5FAE\u8F6F\u96C5\u9ED1'; // 微软雅黑
const FONT_MONO = 'Consolas';

const C_HEAD_GRAY = '595959'; // 页眉 / 题头副文本
const C_META_GRAY = '595959';
const C_RULE_DARK = '333333'; // 题头 0.75pt
const C_RULE_SECTION = 'D0D0D0'; // 小节 0.5pt 浅灰
const C_RULE_HEADER = '999999'; // 页眉 0.5pt
const C_RULE_HR = 'BFBFBF'; // ———— 分隔线
const C_TBL_BORDER = '808080'; // 迷你表格 4 号灰线
const FILL_ANSWER = 'F4F5F7'; // ③ 答案底纹
const C_FOOT = '8C8C8C';

/* 字号（半磅）：22=11pt 20=10pt 23=11.5pt 26=13pt 18=9pt 16=8pt 2=1pt */
// 正文放大到 11pt，阅读更舒适；辅助信息保持较小以维持层次。
const SZ_BODY = 22;
const SZ_META = 18;
const SZ_SECTION = 23;
const SZ_QNO = 26;
const SZ_HEAD = 17;
const SZ_CAPTION = 16;
const SZ_TINY = 2;

const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
};

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W_NS_DECL =
  `xmlns:w="${NS.w}" xmlns:r="${NS.r}" xmlns:wp="${NS.wp}" xmlns:a="${NS.a}" xmlns:pic="${NS.pic}"`;

/* ============================================================
 * 1. XML 基础工具
 * ========================================================== */

function esc(v) {
  return String(v)
    // 去掉 XML 1.0 非法控制字符
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function rPrXml(o = {}) {
  if (!o.font && !o.bold && !o.color && !o.sizeHalf) return '';
  const p = [];
  if (o.font) {
    // 等宽字体只换 ascii/hAnsi/cs，中文仍走 eastAsia 默认（微软雅黑）
    p.push(
      o.font === FONT_MONO
        ? `<w:rFonts w:ascii="${FONT_MONO}" w:hAnsi="${FONT_MONO}" w:cs="${FONT_MONO}"/>`
        : `<w:rFonts w:ascii="${esc(o.font)}" w:hAnsi="${esc(o.font)}" w:eastAsia="${FONT_EA}" w:cs="${esc(o.font)}"/>`,
    );
  }
  if (o.bold) p.push('<w:b/><w:bCs/>');
  if (o.color) p.push(`<w:color w:val="${o.color}"/>`);
  if (o.sizeHalf) p.push(`<w:sz w:val="${o.sizeHalf}"/><w:szCs w:val="${o.sizeHalf}"/>`);
  return `<w:rPr>${p.join('')}</w:rPr>`;
}

function runXml(text, o = {}) {
  const t = text === '' || text == null ? '' : esc(text);
  return `<w:r>${rPrXml(o)}<w:t xml:space="preserve">${t}</w:t></w:r>`;
}

function spacingXml(sp) {
  if (!sp) return '';
  const a = [];
  if (sp.before != null) a.push(`w:before="${Math.round(sp.before)}"`);
  if (sp.after != null) a.push(`w:after="${Math.round(sp.after)}"`);
  if (sp.line != null) a.push(`w:line="${Math.round(sp.line)}"`);
  if (sp.lineRule) a.push(`w:lineRule="${sp.lineRule}"`);
  return a.length ? `<w:spacing ${a.join(' ')}/>` : '';
}

/**
 * w:pPr 子元素必须严格按 OOXML schema 顺序输出，否则 Word 静默忽略整段属性。
 * 顺序：pStyle → keepNext → keepLines → pageBreakBefore → widowControl → numPr
 *       → pBdr → shd → tabs → … → spacing → ind → jc → rPr
 */
function pPrXml(o = {}) {
  const p = [];
  if (o.style) p.push(`<w:pStyle w:val="${esc(o.style)}"/>`);
  if (o.keepNext) p.push('<w:keepNext/>');
  if (o.keepLines) p.push('<w:keepLines/>');
  if (o.pageBreakBefore) p.push('<w:pageBreakBefore/>');
  if (o.widowControl === false) p.push('<w:widowControl w:val="0"/>');
  if (o.pBdr) p.push(`<w:pBdr>${o.pBdr}</w:pBdr>`);
  if (o.shd) p.push(`<w:shd w:val="clear" w:color="auto" w:fill="${o.shd}"/>`);
  if (o.tabs) p.push(`<w:tabs>${o.tabs}</w:tabs>`);
  if (o.snapToGrid === false) p.push('<w:snapToGrid w:val="0"/>');
  if (o.spacing) p.push(spacingXml(o.spacing));
  if (o.ind) {
    const a = [];
    if (o.ind.left != null) a.push(`w:left="${Math.round(o.ind.left)}"`);
    if (o.ind.right != null) a.push(`w:right="${Math.round(o.ind.right)}"`);
    if (o.ind.firstLine != null) a.push(`w:firstLine="${Math.round(o.ind.firstLine)}"`);
    if (a.length) p.push(`<w:ind ${a.join(' ')}/>`);
  }
  if (o.jc) p.push(`<w:jc w:val="${o.jc}"/>`);
  if (o.rPr) p.push(o.rPr);
  if (o.sectPr) p.push(o.sectPr); // 分节符：必须是 pPr 的最后一个子元素
  return p.length ? `<w:pPr>${p.join('')}</w:pPr>` : '';
}

/** 每个 <w:p> 至少一个 <w:r>：空段落也必须带 run */
function paragraph(contentXml, o = {}) {
  const body = contentXml && contentXml.trim() ? contentXml : runXml('');
  return `<w:p>${pPrXml(o)}${body}</w:p>`;
}

/* ============================================================
 * 2. 迷你 Markdown → OOXML 片段
 * ========================================================== */

const RE_CJK = /[\u2E80-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/;

/** 软换行拼接：中文之间不加空格，西文之间加一个空格 */
function joinSoft(lines) {
  let s = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0) {
      s = line;
      continue;
    }
    const a = s.slice(-1);
    const b = line.slice(0, 1);
    s += RE_CJK.test(a) && RE_CJK.test(b) ? line : ` ${line}`;
  }
  return s;
}

/** 行内语法：**粗体** / `等宽` —— 其余原样，$...$ 公式保持原文 */
function inlineXml(text, base = {}) {
  const out = [];
  const re = /\*\*([\s\S]+?)\*\*|`([^`\n]+)`/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(runXml(text.slice(last, m.index), base));
    if (m[1] !== undefined) out.push(runXml(m[1], { ...base, bold: true }));
    else out.push(runXml(m[2], { ...base, font: base.font || FONT_MONO }));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(runXml(text.slice(last), base));
  if (!out.length) out.push(runXml('', base));
  return out.join('');
}

/** 只有 | : - 空格 的分隔行（|---|:--:|）在真实 Word 表格里没有意义，丢弃 */
function isSeparatorRow(t) {
  if (!/^\|.*\|$/.test(t)) return false;
  const cells = t.replace(/^\||\|$/g, '').split('|');
  return cells.every((c) => /^\s*:?-{1,}:?\s*$/.test(c));
}

function parseRow(t) {
  const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|');
  return cells.map((c) => c.trim());
}

function parseBlocks(src) {
  const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  let table = [];

  const flushPara = () => {
    if (para.length) {
      blocks.push({ type: 'p', lines: para });
      para = [];
    }
  };
  const flushTable = () => {
    if (table.length) {
      blocks.push({ type: 'table', rows: table.map(parseRow) });
      table = [];
    }
  };

  // 选项行（A./B./C./D./A．等）单独成段，避免 4 个选项被 joinSoft 拼成一段
  // 连在一起，读起来挤成一坨。每个选项一行、彼此并列。
  const isOptionLine = (t) => /^[A-Da-d][.．、]\s*/.test(t) || /^[（(][A-Da-d][)）]/.test(t);

  // 把「逐项判断：A 正确——…；B 错误——…；C …；D …」里挤在一行的
  // ABCD 判定拆成独立行，和题目选项一样每个占一行，便于阅读。
  const splitInlineChoices = (text) => {
    // 仅当同一句里出现 >=2 个「X 正确/错误」判定才拆，避免误伤普通分号句
    const verdicts = /[A-D][\s．.、]*(?:正确|错误)/g;
    const hits = text.match(verdicts) || [];
    if (hits.length < 2) return [text];
    // 在每个「；X 正确/错误」或「 X 正确/错误」前切分，保留前缀引导语
    const parts = text.split(/(?=[；;]\s*[A-D][\s．.、]*(?:正确|错误))|(?<=[：:])\s*(?=[A-D][\s．.、]*(?:正确|错误))/);
    return parts.map((p) => p.replace(/^[；;]\s*/, '').trim()).filter(Boolean);
  };

  for (const lineRaw of lines) {
    const trimmedLine = lineRaw.trim();
    const parts = splitInlineChoices(trimmedLine);
    const wasSplit = parts.length > 1;
    for (const part of parts) {
      const t = part.trim();
      if (!t) {
        flushPara();
        flushTable();
        continue;
      }
      if (/^\|.*\|$/.test(t)) {
        if (isSeparatorRow(t)) continue;
        flushPara();
        table.push(t);
        continue;
      }
      if (/^[\u2014\u2013-]{4,}$/.test(t)) {
        flushPara();
        flushTable();
        blocks.push({ type: 'hr' });
        continue;
      }
      // 原选项行，或从一行判定句里拆出的 A/B/C/D：都独占一段
      if (isOptionLine(t) || wasSplit) {
        flushPara();
        flushTable();
        blocks.push({ type: 'p', lines: [t], option: true });
        continue;
      }
      flushTable();
      para.push(t);
    }
  }
  flushPara();
  flushTable();
  return blocks;
}

/** 迷你表格：单线边框 w:val="single"，4 号（0.5pt）灰线 */
function buildTable(rows, totalTw) {
  const nCols = Math.max(1, ...rows.map((r) => r.length));
  const base = Math.floor(totalTw / nCols);
  const widths = [];
  for (let i = 0; i < nCols; i++) widths.push(i === nCols - 1 ? totalTw - base * (nCols - 1) : base);

  const bd = (side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="${C_TBL_BORDER}"/>`;
  const tblPr =
    `<w:tblPr><w:tblW w:w="${totalTw}" w:type="dxa"/>` +
    `<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(bd).join('')}</w:tblBorders>` +
    `<w:tblLayout w:type="fixed"/>` +
    `<w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/>` +
    `<w:bottom w:w="40" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar>` +
    `<w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr>`;

  const grid = `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`;

  const trs = rows
    .map((r) => {
      const tcs = [];
      for (let i = 0; i < nCols; i++) {
        const cell = r[i] == null ? '' : String(r[i]);
        tcs.push(
          `<w:tc><w:tcPr><w:tcW w:w="${widths[i]}" w:type="dxa"/></w:tcPr>` +
            `${paragraph(inlineXml(cell), { spacing: { before: 20, after: 20, line: 264, lineRule: 'auto' } })}` +
            `</w:tc>`,
        );
      }
      return `<w:tr>${tcs.join('')}</w:tr>`;
    })
    .join('');

  return `<w:tbl>${tblPr}${grid}${trs}</w:tbl>`;
}

function renderBlocks(src, opts = {}) {
  const tableTw = opts.tableWidthTw || CONTENT_W_TW;
  const out = [];
  for (const b of parseBlocks(src)) {
    if (b.type === 'table') {
      out.push(buildTable(b.rows, tableTw));
    } else if (b.type === 'hr') {
      out.push(
        paragraph(runXml(''), {
          spacing: { before: 40, after: 120, line: 240, lineRule: 'auto' },
          pBdr: `<w:bottom w:val="single" w:sz="4" w:space="1" w:color="${C_RULE_HR}"/>`,
        }),
      );
    } else {
      out.push(
        paragraph(inlineXml(joinSoft(b.lines)), {
          spacing: b.option
            ? { before: 0, after: 45, line: 220, lineRule: 'auto' } // 选项：独占一行，行距适中
            : (opts.spacing || { before: 0, after: 60 }),
          shd: opts.shade,
          jc: opts.align,
          ind: b.option ? { left: cm2tw(0.5) } : opts.ind, // 选项首行轻微缩进，4 项并列对齐
        }),
      );
    }
  }
  if (!out.length) out.push(paragraph(runXml(''), { spacing: opts.spacing || { before: 0, after: 60 }, shd: opts.shade }));
  return out.join('');
}

/* ============================================================
 * 3. 图片
 * ========================================================== */

function sniffExt(buf, filePath) {
  const fromPath = String(filePath).toLowerCase().match(/\.([a-z0-9]+)$/);
  const ext = fromPath ? fromPath[1] : '';
  if (ext === 'png') return 'png';
  if (ext === 'jpg' || ext === 'jpeg') return 'jpeg';
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  throw new Error(`[docx] 不支持的图片格式（只支持 png / jpeg）: ${filePath}`);
}

/** 从文件头读像素尺寸（png IHDR / jpeg SOF），用于没给 widthCm/heightCm 时按原比例兜底 */
function readPixelSize(buf, ext) {
  if (ext === 'png') {
    if (buf.length >= 24) return { px: buf.readUInt32BE(16), py: buf.readUInt32BE(20) };
    return null;
  }
  if (ext === 'jpeg') {
    if (!(buf[0] === 0xff && buf[1] === 0xd8)) return null;
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
        i += marker === 0xff ? 1 : 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) return null;
      const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) return { py: buf.readUInt16BE(i + 5), px: buf.readUInt16BE(i + 7) };
      if (marker === 0xda) return null; // 已到 Scan，之前没有 SOF
      i += 2 + len;
    }
  }
  return null;
}

/** 没有显式尺寸时：按 96dpi 把像素换成 cm（等比，不变形） */
function naturalSizeCm(buf, ext) {
  const px = readPixelSize(buf, ext);
  if (!px || !(px.px > 0) || !(px.py > 0)) return null;
  return { w: (px.px * 2.54) / 96, h: (px.py * 2.54) / 96 };
}

function drawingRunXml({ rId, cx, cy, id, name }) {
  return (
    `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:docPr id="${id}" name="${esc(name)}"/>` +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic><a:graphicData uri="${NS.pic}">` +
    `<pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${esc(name)}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
  );
}

/* ============================================================
 * 4. 区块组件
 * ========================================================== */

/** 小节标题：① 原题 / ② 解题过程 / ③ 答案，10.5pt 粗体 + 0.5pt 浅灰下划线 */
function sectionHeading(text) {
  return paragraph(runXml(text, { sizeHalf: SZ_SECTION, bold: true }), {
    keepNext: true,
    spacing: { before: 80, after: 40, line: 216, lineRule: 'auto' },
    pBdr: `<w:bottom w:val="single" w:sz="4" w:space="2" w:color="${C_RULE_SECTION}"/>`,
  });
}

/**
 * 题间换页：分节符（nextPage）段落。
 *
 * 不用 pageBreakBefore：当上一题内容恰好接近满页时，pageBreakBefore
 * 会在文档末尾产生一个只有页眉页脚的空白页。分节符让下一节天然从新页
 * 开始，既不产生尾随空页，也不会因满页边界多插一页。
 * 每个分节都必须自带页面尺寸/页边距/页眉页脚引用，否则后续节会丢页眉页码。
 */
function pageAnchor() {
  const sectPr =
    `<w:sectPr>` +
    `<w:headerReference w:type="default" r:id="rId2"/>` +
    `<w:footerReference w:type="default" r:id="rId3"/>` +
    `<w:type w:val="nextPage"/>` +
    `<w:pgSz w:w="${PAGE_W_TW}" w:h="${PAGE_H_TW}"/>` +
    `<w:pgMar w:top="${MARGIN_T}" w:right="${MARGIN_LR}" w:bottom="${MARGIN_B}" w:left="${MARGIN_LR}" ` +
    `w:header="${cm2tw(1.0)}" w:footer="${cm2tw(0.8)}" w:gutter="0"/>` +
    `<w:cols w:space="425"/>` +
    `</w:sectPr>`;
  return paragraph(runXml('', { sizeHalf: SZ_TINY }), {
    spacing: { before: 0, after: 0, line: 20, lineRule: 'exact' },
    sectPr,
  });
}

const NIL_BORDERS =
  `<w:tblBorders>` +
  ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((s) => `<w:${s} w:val="nil" w:sz="0" w:space="0" w:color="auto"/>`)
    .join('') +
  `</w:tblBorders>`;

const ZERO_CELL_MAR =
  `<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/>` +
  `<w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar>`;

const TBL_LOOK = `<w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/>`;

/** ② 里的 1 行 2 列无框表格：左 5.6cm 解析 / 右 11.2cm 图片 */
function twoColumnTable(leftXml, rightXml) {
  const total = COL_LEFT_TW + COL_RIGHT_TW; // 9525 = 16.8cm
  // 单元格边距为 0：这样右列可用宽度正好 11.2cm，宽 11.2cm 的图不会被 Word 裁切
  const tblPr =
    `<w:tblPr><w:tblW w:w="${total}" w:type="dxa"/>` +
    NIL_BORDERS +
    `<w:tblLayout w:type="fixed"/>` +
    ZERO_CELL_MAR +
    TBL_LOOK +
    `</w:tblPr>`;
  const grid = `<w:tblGrid><w:gridCol w:w="${COL_LEFT_TW}"/><w:gridCol w:w="${COL_RIGHT_TW}"/></w:tblGrid>`;
  const row =
    `<w:tr>` +
    `<w:tc><w:tcPr><w:tcW w:w="${COL_LEFT_TW}" w:type="dxa"/><w:vAlign w:val="top"/></w:tcPr>${leftXml}</w:tc>` +
    `<w:tc><w:tcPr><w:tcW w:w="${COL_RIGHT_TW}" w:type="dxa"/><w:vAlign w:val="top"/></w:tcPr>${rightXml}</w:tc>` +
    `</w:tr>`;
  return `<w:tbl>${tblPr}${grid}${row}</w:tbl>`;
}

/** 一题一页的外壳：1 行 1 列、无框；cantSplit 让整题不跨页 */
function questionFrame(innerXml, cantSplit = true) {
  const tblPr =
    `<w:tblPr><w:tblW w:w="${CONTENT_W_TW}" w:type="dxa"/>` +
    NIL_BORDERS +
    `<w:tblLayout w:type="fixed"/>` +
    ZERO_CELL_MAR +
    TBL_LOOK +
    `</w:tblPr>`;
  const grid = `<w:tblGrid><w:gridCol w:w="${CONTENT_W_TW}"/></w:tblGrid>`;
  // 最后一题若内容恰好填满一页，cantSplit 会让 Word 在文末多留一个只有页眉页脚的
  // 空白页；所以最后一题不加 cantSplit（其内容本就完整落在一页，不会真的跨页）。
  const row =
    `<w:tr>${cantSplit ? '<w:trPr><w:cantSplit/></w:trPr>' : ''}` +
    `<w:tc><w:tcPr><w:tcW w:w="${CONTENT_W_TW}" w:type="dxa"/></w:tcPr>${innerXml}</w:tc>` +
    `</w:tr>`;
  return `<w:tbl>${tblPr}${grid}${row}</w:tbl>`;
}

/* ============================================================
 * 5. 单题渲染
 * ========================================================== */

function normalizeList(v) {
  if (Array.isArray(v)) return v.filter((x) => x != null && String(x).trim() !== '');
  if (v == null || v === '') return [];
  return [String(v)];
}

async function loadImage(img, media, ctx) {
  const p = img && img.path;
  if (!p) throw new Error('[docx] images[] 缺少 path');

  // ---- 去重：主键=解析后的绝对路径；同一路径只读一次、只写一份 media、只建一条关系项 ----
  // 次键=内容 sha256：不同路径但字节相同的同一张图也只写一份（错题本会把同一页复制到各题 assets，
  // 按路径判重不足以去重，会让 docx 体积翻倍）。
  const abs = path.resolve(String(p));
  const pathKey = process.platform === 'win32' ? abs.toLowerCase() : abs;

  let entry = ctx.mediaByPath.get(pathKey);
  if (!entry) {
    let buf;
    try {
      buf = await readFile(abs);
    } catch (e) {
      throw new Error(`[docx] 读取图片失败: ${abs} (${e && e.message})`);
    }
    const ext = sniffExt(buf, abs);
    const sha = createHash('sha256').update(buf).digest('hex');

    entry = ctx.mediaByHash.get(sha) || null;
    if (!entry) {
      const index = media.length + 1;
      entry = {
        name: `image${index}.${ext}`,
        ext,
        rId: `rIdImg${index}`,
        nat: naturalSizeCm(buf, ext),
      };
      media.push({ name: entry.name, buf, ext, rId: entry.rId });
      ctx.mediaByHash.set(sha, entry);
    }
    ctx.mediaByPath.set(pathKey, entry);
  }

  // 优先用调用方显式给的 widthCm/heightCm；缺省时按图片真实像素等比换算（96dpi），仍保证不变形
  const widthCm = Number(img.widthCm);
  const heightCm = Number(img.heightCm);
  const explicit = Number.isFinite(widthCm) && Number.isFinite(heightCm) && widthCm > 0 && heightCm > 0;

  let w;
  let h;
  if (explicit) {
    w = widthCm;
    h = heightCm;
  } else {
    if (!entry.nat) throw new Error(`[docx] 无法从文件头读出图片尺寸，请显式传 widthCm/heightCm: ${abs}`);
    w = entry.nat.w;
    h = entry.nat.h;
  }

  if (w > MAX_IMG_W_CM) {
    h = (h * MAX_IMG_W_CM) / w;
    w = MAX_IMG_W_CM;
  }
  if (h > MAX_IMG_H_CM) {
    w = (w * MAX_IMG_H_CM) / h;
    h = MAX_IMG_H_CM;
  }

  // 每处引用都要有自己的 docPr id（Word 要求文档内唯一），rId 复用
  ctx.docPrId += 1;
  return {
    xml: drawingRunXml({
      rId: entry.rId,
      cx: cm2emu(w),
      cy: cm2emu(h),
      id: ctx.docPrId,
      name: entry.name,
    }),
    caption: img.caption ? String(img.caption) : '',
  };
}

async function renderQuestion(q, ctx, newPage = false, isLast = false) {
  const out = [];

  /* --- 题头：13pt 粗体题号 + ｜学科 · 章节，0.75pt 粗线 --- */
  const headRuns = [runXml(String(q.q == null ? '' : q.q), { sizeHalf: SZ_QNO, bold: true })];
  const meta = [q.subject, q.chapter]
    .map((v) => (v == null ? '' : String(v).trim()))
    .filter(Boolean)
    .join(' · ');
  if (meta) headRuns.push(runXml(`\uFF5C${meta}`, { sizeHalf: SZ_BODY, color: C_HEAD_GRAY }));
  // 换页放在题头段落上（第 2 题起）。不加 keepNext：满页边界时 keepNext
  // 会把题头连同上一段一起推到新页，进而多出一个空白页。
  out.push(
    paragraph(headRuns.join(''), {
      ...(newPage ? { pageBreakBefore: true } : {}),
      spacing: { before: 0, after: 50, line: 240, lineRule: 'auto' },
      pBdr: `<w:bottom w:val="single" w:sz="6" w:space="3" w:color="${C_RULE_DARK}"/>`,
    }),
  );

  /* --- 知识点 / 出处 --- */
  const topics = normalizeList(q.topics).map((t) => String(t).trim()).filter(Boolean);
  const source = q.source == null ? '' : String(q.source).trim();
  const metaBits = [];
  if (topics.length) metaBits.push(`\u77E5\u8BC6\u70B9\uFF1A${topics.join('\u3001')}`);
  if (source) metaBits.push(`\u51FA\u5904\uFF1A${source}`);
  if (metaBits.length) {
    out.push(
      paragraph(runXml(metaBits.join('\u3000\uFF5C\u3000'), { sizeHalf: SZ_META, color: C_META_GRAY }), {
        spacing: { before: 40, after: 60, line: 240, lineRule: 'auto' },
      }),
    );
  }

  /* --- ① 原题：题干 + 小问 + 原卷图（题图是题干的一部分，必须紧跟题干） --- */
  out.push(sectionHeading('\u2460 \u539F\u9898'));
  out.push(renderBlocks(q.stem, { tableWidthTw: CONTENT_W_TW }));

  const subs = normalizeList(q.subQuestions);
  const stemText = String(q.stem ?? '').replace(/\s/g, '');
  for (const sub of subs) {
    // 若小问文本其实已包含在题干里，就不再重复渲染一遍：
    // 有些录入把(1)(2)(3)同时写进了 stem 和 subQuestions，重复印刷会白占半页。
    const subKey = String(sub).replace(/\s/g, '');
    if (subKey !== '' && stemText.includes(subKey)) continue;
    out.push(renderBlocks(String(sub), { tableWidthTw: CONTENT_W_TW }));
  }

  // 原卷截图放在题干之后：很多题干含配图，看不到图就无法作答。
  const images = normalizeList(q.images);
  for (const img of images) {
    if (!img || typeof img !== 'object') continue;
    const loaded = await loadImage(img, ctx.media, ctx);
    out.push(paragraph(loaded.xml, {
      jc: 'center',
      spacing: { before: 60, after: loaded.caption ? 40 : 120, line: 240, lineRule: 'auto' },
    }));
    if (loaded.caption) {
      out.push(paragraph(runXml(loaded.caption, { sizeHalf: SZ_CAPTION, color: C_META_GRAY }), {
        jc: 'center',
        spacing: { before: 0, after: 120, line: 220, lineRule: 'auto' },
      }));
    }
  }

  /* --- ② 解题过程：整段通栏 --- */
  const analysis = normalizeList(q.analysis);
  if (analysis.length) {
    out.push(sectionHeading('\u2461 \u89E3\u9898\u8FC7\u7A0B'));
    for (const a of analysis) {
      out.push(renderBlocks(String(a), { tableWidthTw: CONTENT_W_TW }));
    }
  }

  /* --- ③ 答案：整段浅灰底纹 --- */
  out.push(sectionHeading('\u2462 \u7B54\u6848'));
  const answerBlocks = parseBlocks(q.answer == null ? '' : String(q.answer));
  const paras = [];
  for (const b of answerBlocks) {
    paras.push(b);
  }
  if (!paras.length) paras.push({ type: 'p', lines: [''] });

  paras.forEach((b, i) => {
    const first = i === 0;
    const last = i === paras.length - 1;
    if (b.type === 'table') {
      out.push(buildTable(b.rows, CONTENT_W_TW));
      return;
    }
    if (b.type === 'hr') {
      out.push(
        paragraph(runXml(''), {
          spacing: { before: 40, after: 120 },
          pBdr: `<w:bottom w:val="single" w:sz="4" w:space="1" w:color="${C_RULE_HR}"/>`,
        }),
      );
      return;
    }
    out.push(
      paragraph(inlineXml(joinSoft(b.lines)), {
        shd: FILL_ANSWER,
        spacing: { before: first ? 20 : 0, after: last ? 30 : 0, line: 200, lineRule: 'auto' },
      }),
    );
  });

  return questionFrame(out.join(''), !isLast);
}

/* ============================================================
 * 6. 部件 XML
 * ========================================================== */

function contentTypesXml() {
  return (
    `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Default Extension="png" ContentType="image/png"/>` +
    `<Default Extension="jpeg" ContentType="image/jpeg"/>` +
    `<Default Extension="jpg" ContentType="image/jpeg"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
    `<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>` +
    `<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>` +
    `</Types>`
  );
}

const REL_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function packageRelsXml() {
  return (
    `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${REL_BASE}/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`
  );
}

function documentRelsXml(media) {
  const parts = [
    `<Relationship Id="rId1" Type="${REL_BASE}/styles" Target="styles.xml"/>`,
    `<Relationship Id="rId2" Type="${REL_BASE}/header" Target="header1.xml"/>`,
    `<Relationship Id="rId3" Type="${REL_BASE}/footer" Target="footer1.xml"/>`,
  ];
  for (const m of media) {
    parts.push(`<Relationship Id="${m.rId}" Type="${REL_BASE}/image" Target="media/${m.name}"/>`);
  }
  return (
    `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    parts.join('') +
    `</Relationships>`
  );
}

function stylesXml() {
  const rpr =
    `<w:rPr><w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:eastAsia="${FONT_EA}" w:cs="${FONT}"/>` +
    `<w:sz w:val="${SZ_BODY}"/><w:szCs w:val="${SZ_BODY}"/>` +
    `<w:lang w:val="en-US" w:eastAsia="zh-CN" w:bidi="ar-SA"/></w:rPr>`;
  const ppr = `<w:pPr><w:spacing w:before="0" w:after="20" w:line="200" w:lineRule="auto"/></w:pPr>`;
  return (
    `${XML_DECL}<w:styles ${W_NS_DECL}>` +
    `<w:docDefaults><w:rPrDefault>${rpr}</w:rPrDefault><w:pPrDefault>${ppr}</w:pPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/>` +
    `${ppr}${rpr}</w:style>` +
    `<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont">` +
    `<w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>` +
    `</w:styles>`
  );
}

function headerXml(title, subtitle) {
  const rp = rPrXml({ sizeHalf: SZ_HEAD, color: C_HEAD_GRAY });
  const runs =
    `${rprWith(rp, title)}` + `<w:r>${rp}<w:tab/></w:r>` + `${rprWith(rp, subtitle)}`;
  return (
    `${XML_DECL}<w:hdr ${W_NS_DECL}>` +
    `<w:p>` +
    pPrXml({
      pBdr: `<w:bottom w:val="single" w:sz="4" w:space="1" w:color="${C_RULE_HEADER}"/>`,
      tabs: `<w:tab w:val="right" w:pos="${TAB_RIGHT}"/>`,
      spacing: { before: 0, after: 0, line: 240, lineRule: 'auto' },
      rPr: rp,
    }) +
    runs +
    `</w:p></w:hdr>`
  );
}

function rprWith(rp, text) {
  return `<w:r>${rp}<w:t xml:space="preserve">${esc(text == null ? '' : text)}</w:t></w:r>`;
}

function footerXml(footerText) {
  const rp = rPrXml({ sizeHalf: SZ_HEAD, color: C_FOOT });
  let inner;
  if (footerText && String(footerText).trim()) {
    inner = rprWith(rp, String(footerText));
  } else {
    inner =
      rprWith(rp, '\u2014\u00A0') +
      `<w:fldSimple w:instr=" PAGE "><w:r>${rp}<w:t>1</w:t></w:r></w:fldSimple>` +
      rprWith(rp, '\u00A0\u2014');
  }
  return (
    `${XML_DECL}<w:ftr ${W_NS_DECL}>` +
    `<w:p>` +
    pPrXml({ jc: 'center', spacing: { before: 0, after: 0, line: 240, lineRule: 'auto' }, rPr: rp }) +
    inner +
    `</w:p></w:ftr>`
  );
}

function documentXml(questionsXml) {
  const sectPr =
    `<w:sectPr>` +
    `<w:headerReference w:type="default" r:id="rId2"/>` +
    `<w:footerReference w:type="default" r:id="rId3"/>` +
    `<w:pgSz w:w="${PAGE_W_TW}" w:h="${PAGE_H_TW}"/>` +
    `<w:pgMar w:top="${MARGIN_T}" w:right="${MARGIN_LR}" w:bottom="${MARGIN_B}" w:left="${MARGIN_LR}" ` +
    `w:header="${cm2tw(1.0)}" w:footer="${cm2tw(0.8)}" w:gutter="0"/>` +
    `<w:cols w:space="425"/>` +
    `</w:sectPr>`;
  return `${XML_DECL}<w:document ${W_NS_DECL}><w:body>${questionsXml}${sectPr}</w:body></w:document>`;
}

/* ============================================================
 * 7. ZIP（自行拼装，node:zlib deflateRaw）
 * ========================================================== */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time: time & 0xffff, date: date & 0xffff };
}

/**
 * @param {{name:string, data:Buffer}[]} files
 * @returns {Buffer}
 */
function makeZip(files) {
  const { time, date } = dosDateTime(new Date());
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const raw = f.data;
    const crc = crc32(raw);
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30); // extra
    ch.writeUInt16LE(0, 32); // comment
    ch.writeUInt16LE(0, 34); // disk start
    ch.writeUInt16LE(0, 36); // internal attrs
    ch.writeUInt32LE(0, 38); // external attrs
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
  }

  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cdBuf, eocd]);
}

/* ============================================================
 * 8. 入口
 * ========================================================== */

/**
 * 生成错题集 .docx
 * @param {Array<object>} questions
 * @param {{title?:string, subtitle?:string, footerText?:string}} [options]
 * @returns {Promise<Buffer>}
 */
export async function buildDocx(questions, options = {}) {
  if (!Array.isArray(questions)) throw new TypeError('[docx] questions 必须是数组');
  const opts = options && typeof options === 'object' ? options : {};
  const title = opts.title == null ? '\u9519\u9898\u96C6 \u00B7 \u8BE6\u7EC6\u89E3\u6790' : String(opts.title);
  const subtitle = opts.subtitle == null ? '' : String(opts.subtitle);

  const ctx = { media: [], mediaByPath: new Map(), mediaByHash: new Map(), docPrId: 0 };
  const parts = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i] || {};
    parts.push(await renderQuestion(q, ctx, i > 0, i === questions.length - 1));
  }

  const docXml = documentXml(parts.join(''));

  const files = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypesXml(), 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(packageRelsXml(), 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(docXml, 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(documentRelsXml(ctx.media), 'utf8') },
    { name: 'word/styles.xml', data: Buffer.from(stylesXml(), 'utf8') },
    { name: 'word/header1.xml', data: Buffer.from(headerXml(title, subtitle), 'utf8') },
    { name: 'word/footer1.xml', data: Buffer.from(footerXml(opts.footerText), 'utf8') },
  ];
  for (const m of ctx.media) files.push({ name: `word/media/${m.name}`, data: m.buf });

  return makeZip(files);
}
