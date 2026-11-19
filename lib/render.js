/**
 * 错题集的 HTML 渲染。
 *
 * 与 docx 版式同构：一题一页、题头（题号｜学科·章节）、① 原题、② 解题过程（右侧并排原卷图）、
 * ③ 答案（浅灰底纹）。浏览器直接打印即为 PDF，所以这里把 @page 与断页规则写死。
 * @module @dullscholar-ai/dsh-cuotiji/lib/render
 */

const CSS = `
@page { size: A4; margin: 1.8cm 1.8cm 1.5cm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; }
body {
  font: 11pt/1.6 "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", sans-serif;
  color: #1c1c1e;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.sheet { padding: 1.8cm 1.8cm 1.5cm; max-width: 21cm; margin: 0 auto; }
/* 打印/导出 PDF 时，页边距由 @page 提供，这里必须清零，否则会二次留白 */
@media print {
  .sheet { padding: 0; max-width: none; margin: 0; }
  html, body { background: #fff; }
}
.q { break-after: page; page-break-after: always; }
.q:last-child { break-after: auto; page-break-after: auto; }
.q-head {
  display: flex; align-items: baseline; gap: 8px;
  border-bottom: 0.75pt solid #1c1c1e; padding-bottom: 3pt; margin: 0 0 6pt;
}
.q-no { font-size: 13pt; font-weight: 700; }
.q-meta { font-size: 9.5pt; color: #6b6b70; }
.sec-title {
  font-size: 10.5pt; font-weight: 700; color: #1c1c1e;
  border-bottom: 0.5pt solid #d8d8dc; padding-bottom: 1.5pt;
  margin: 8pt 0 4pt;
}
.col-text { width: 100%; }
p { margin: 0 0 4pt; }
p.opt { margin: 0 0 5pt; padding-left: 0.5em; } /* 选项并列、缩进对齐 */
.answer { background: #f4f5f7; padding: 5pt 7pt; border-radius: 2px; }
.answer p:last-child { margin-bottom: 0; }
/* 原卷图紧跟题干：题图就是题干的一部分，必须清晰、完整、不被裁切 */
.q-figures { margin: 4pt 0 6pt; }
figure { margin: 0 0 6pt; text-align: center; break-inside: avoid; page-break-inside: avoid; }
figure img { max-width: 100%; object-fit: contain; border: 0.5pt solid #e3e3e7; }
figcaption { font-size: 8.5pt; color: #6b6b70; margin-top: 2pt; }
table.data { border-collapse: collapse; width: 100%; margin: 3pt 0 5pt; font-size: 9pt; }
table.data th, table.data td { border: 0.5pt solid #c9c9cf; padding: 2pt 4pt; text-align: left; }
table.data th { background: #f4f5f7; font-weight: 600; }
code { font-family: Consolas, "SF Mono", monospace; font-size: 9pt; background: #f4f5f7; padding: 0 2px; border-radius: 2px; }
hr.rule { border: 0; border-top: 0.5pt solid #d8d8dc; margin: 5pt 0; }
.muted { color: #6b6b70; font-size: 8.5pt; }
`;

/** HTML 转义。 */
export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 行内标记：`**粗体**` 与 `` `等宽` ``。公式 `$...$` 原样保留。
 * @param text 源文本
 */
export function renderInline(text) {
  let out = escapeHtml(text);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  return out;
}

function splitRow(line) {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim());
}

/**
 * 块级渲染：空行分段、`|a|b|` 连续行成表格、整行 `————` 成分隔线。
 * @param source 文本
 */
export function renderBlocks(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let buffer = [];
  const flush = () => {
    if (buffer.length === 0) return;
    out.push(`<p>${buffer.map(renderInline).join('<br>')}</p>`);
    buffer = [];
  };

  const isOption = (t) => /^[A-Da-d][.．、]\s*/.test(t) || /^[（(][A-Da-d][)）]/.test(t);
  const splitInlineChoices = (text) => {
    const hits = text.match(/[A-D][\s．.、]*(?:正确|错误)/g) || [];
    if (hits.length < 2) return [text];
    const parts = text.split(/(?=[；;]\s*[A-D][\s．.、]*(?:正确|错误))|(?<=[：:])\s*(?=[A-D][\s．.、]*(?:正确|错误))/);
    return parts.map((p) => p.replace(/^[；;]\s*/, '').trim()).filter(Boolean);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed === '') {
      flush();
      continue;
    }
    // 选项独占一行、彼此并列，避免 4 个选项挤成一段
    if (isOption(trimmed)) {
      flush();
      out.push(`<p class="opt">${renderInline(trimmed)}</p>`);
      continue;
    }
    // 关键步骤里挤在一行的 ABCD 判定，拆成每个占一行
    const choiceParts = splitInlineChoices(trimmed);
    if (choiceParts.length > 1) {
      flush();
      for (const part of choiceParts) out.push(`<p class="opt">${renderInline(part)}</p>`);
      continue;
    }
    if (/^[—–-]{4,}$/.test(trimmed)) {
      flush();
      out.push('<hr class="rule">');
      continue;
    }
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      flush();
      const rows = [];
      while (index < lines.length) {
        const candidate = lines[index].trim();
        if (!(candidate.startsWith('|') && candidate.endsWith('|'))) break;
        if (!/^\|[\s:|-]+\|$/.test(candidate)) rows.push(splitRow(candidate));
        index += 1;
      }
      index -= 1;
      if (rows.length > 0) {
        const head = rows[0];
        const body = rows.slice(1);
        out.push('<table class="data">');
        out.push(`<thead><tr>${head.map((cell) => `<th>${renderInline(cell)}</th>`).join('')}</tr></thead>`);
        out.push('<tbody>');
        for (const row of body) {
          out.push(`<tr>${head.map((_, column) => `<td>${renderInline(row[column] ?? '')}</td>`).join('')}</tr>`);
        }
        out.push('</tbody></table>');
      }
      continue;
    }
    buffer.push(line);
  }
  flush();
  return out.join('\n');
}

function figureHtml(root, figure) {
  const raw = String(figure?.path ?? '');
  const joined = /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('/')
    ? raw
    : `${String(root).replace(/[\\/]+$/, '')}/${raw}`;
  const absolute = joined.replace(/\\/g, '/');
  const caption = figure.caption === undefined || figure.caption === '' ? '' : `<figcaption>${escapeHtml(figure.caption)}</figcaption>`;
  // 图尺寸由 exporter 按本题文字量动态算出；有就用内联样式，没有则退回 CSS 上限。
  const w = Number(figure?.widthCm);
  const h = Number(figure?.heightCm);
  const sized = Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0
    ? ` style="width:${w}cm;height:${h}cm;max-width:100%;max-height:none"`
    : '';
  return `<figure><img${sized} src="file:///${encodeURI(absolute.replace(/^\/+/, ''))}" alt="${escapeHtml(figure.caption || '原卷图')}">${caption}</figure>`;
}

/**
 * 渲染一份错题集 HTML。
 * @param questions 题目数组（已按需要筛选排序）
 * @param options { title, subtitle, root }
 */
export function renderHtml(questions, options = {}) {
  const title = options.title ?? '错题集 · 详细解析';
  const root = options.root ?? '.';
  const sheets = questions.map((question) => {
    const metaParts = [question.subject, question.chapter].filter((part) => part !== '');
    if (question.source !== '') metaParts.push(question.source);
    const head = `<div class="q-head"><span class="q-no">${escapeHtml(question.q === '' ? '—' : question.q)}</span><span class="q-meta">${escapeHtml(metaParts.join(' · '))}</span></div>`;

    const stem = question.stem === '' || question.stem === undefined ? '<p class="muted">（题干缺失）</p>' : renderBlocks(question.stem);
    const subQuestions = question.subQuestions ?? [];
    const analysisList = question.analysis ?? [];
    const images = question.images ?? [];
    const stemText = String(question.stem ?? '').replace(/\s/g, '');
    const subs = subQuestions.length === 0
      ? ''
      : subQuestions
        .filter((item) => {
          const key = String(item).replace(/\s/g, '');
          return key === '' || !stemText.includes(key); // 题干里已有的小问不重复渲染
        })
        .map((item) => renderBlocks(item)).join('\n');
    const analysis = analysisList.length === 0
      ? '<p class="muted">（尚未补解题思路）</p>'
      : analysisList.map((item) => renderBlocks(item)).join('\n');
    const figures = images.map((figure) => figureHtml(root, figure)).join('\n');
    const answer = question.answer === '' ? '<p class="muted">（尚未补答案）</p>' : renderBlocks(question.answer);

    return `<section class="q">
${head}
<div class="sec-title">① 原题</div>
${stem}
${subs}
${figures === '' ? '' : `<div class="q-figures">${figures}</div>`}
<div class="sec-title">② 解题过程</div>
<div class="col-text">${analysis}</div>
<div class="sec-title">③ 答案</div>
<div class="answer">${answer}</div>
</section>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="sheet">
${sheets}
</div>
</body>
</html>
`;
}
