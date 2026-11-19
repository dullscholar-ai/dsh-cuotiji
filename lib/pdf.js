/**
 * PDF 导出。
 *
 * 优先走本机 Office（Word，其次 WPS）把**已生成好的 docx** 另存为 PDF —— 这样
 * 页眉、页脚、页码域、一题一页的分页全部与 docx 完全一致，也就是 haha-cuotiji
 * 那套版式，不存在「第二套实现」走样的问题。
 *
 * 没装 Office 时退回本机 Chrome / Edge 直接打印 HTML（样式同构，但没有页眉页码）。
 *
 * 与 haha-cuotiji 的 calibrate.ps1 相比多两条保护：
 *   1. 不擅自把用户已经打开的 Word 窗口藏掉，退出前恢复原可见性；
 *   2. 只有当文档都关掉、且原本没在跑时才 Quit，绝不关用户自己的文档。
 * @module @dullscholar-ai/dsh-cuotiji/lib/pdf
 */

import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** wdExportFormatPDF */
const WD_EXPORT_FORMAT_PDF = 17;

/** 把命令跑完，收集退出码与输出；超时直接杀。 */
function run(exe, args, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error?.message ?? error), missing: true });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已经没了 */
      }
      finish({ code: -1, stdout, stderr: `${stderr}\n超时 ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ code: -1, stdout, stderr: String(error?.message ?? error), missing: error?.code === 'ENOENT' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function exists(target) {
  try {
    const stat = await fsp.stat(target);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/**
 * Word / WPS 的 COM 脚本。
 * 纯 ASCII，配合 UTF-8 BOM 写出，Windows PowerShell 5.1 与 pwsh 7 都能正确读。
 */
const COM_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '$docx = $args[0]',
  '$pdf = $args[1]',
  '$app = $null',
  '$doc = $null',
  '$wasVisible = $false',
  'try {',
  '  try { $app = New-Object -ComObject Word.Application }',
  '  catch { $app = New-Object -ComObject KWps.Application }',
  '  try { $wasVisible = [bool]$app.Visible } catch { $wasVisible = $false }',
  '  try { $app.Visible = $false } catch { }',
  '  try { $app.DisplayAlerts = 0 } catch { }',
  '  $doc = $app.Documents.Open($docx, $false, $true)',
  '  if (Test-Path -LiteralPath $pdf) { Remove-Item -LiteralPath $pdf -Force }',
  `  $doc.ExportAsFixedFormat($pdf, ${WD_EXPORT_FORMAT_PDF})`,
  '} finally {',
  '  if ($doc -ne $null) { try { $doc.Close(0) } catch { } }',
  '  if ($app -ne $null) {',
  '    try { $app.Visible = $wasVisible } catch { }',
  '    try { if ($app.Documents.Count -eq 0 -and -not $wasVisible) { $app.Quit() } } catch { }',
  '  }',
  '}',
  'if (-not (Test-Path -LiteralPath $pdf)) { Write-Error "Word 没有产出 PDF"; exit 1 }',
  'exit 0',
  '',
].join('\r\n');

/** 用 Word（或 WPS）把 docx 转成 PDF。 */
async function officeToPdf(docxPath, pdfPath) {
  const scriptPath = path.join(os.tmpdir(), `cuotiji-pdf-${randomUUID()}.ps1`);
  // 带 BOM：Windows PowerShell 5.1 会把无 BOM 的 UTF-8 当 ANSI，中文路径会坏
  await fsp.writeFile(scriptPath, `\uFEFF${COM_SCRIPT}`, 'utf8');
  try {
    const attempts = [
      ['pwsh', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, docxPath, pdfPath]],
      ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, docxPath, pdfPath]],
    ];
    const notes = [];
    for (const [exe, args] of attempts) {
      const result = await run(exe, args);
      if (await exists(pdfPath)) return { engine: exe === 'pwsh' ? 'word/pwsh' : 'word/powershell' };
      if (result.missing) {
        notes.push(`${exe} 未安装`);
        continue;
      }
      notes.push(`${exe} 退出码 ${result.code}：${(result.stderr || result.stdout).trim().slice(0, 400)}`);
    }
    throw new Error(`Office 转 PDF 失败（${notes.join('；')}）`);
  } finally {
    await fsp.rm(scriptPath, { force: true });
  }
}

/** 本机浏览器候选（Chrome 优先，Edge 兜底）。 */
function browserCandidates() {
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA ?? '';
  return [
    path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    localAppData === '' ? '' : path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter((candidate) => candidate !== '');
}

/** 用无头浏览器把 HTML 打印成 PDF（没有页眉页码，作为兜底）。 */
async function htmlToPdf(htmlPath, pdfPath) {
  const notes = [];
  for (const exe of browserCandidates()) {
    if (!(await exists(exe))) continue;
    const url = `file:///${htmlPath.replace(/\\/g, '/').replace(/^\/+/, '')}`;
    const result = await run(exe, [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-pdf-header-footer',
      '--virtual-time-budget=5000',
      `--print-to-pdf=${pdfPath}`,
      url,
    ]);
    if (await exists(pdfPath)) return { engine: `${path.basename(exe)} 打印` };
    notes.push(`${path.basename(exe)} 退出码 ${result.code}`);
  }
  throw new Error(`浏览器打印 PDF 失败（${notes.join('；') || '没找到 Chrome / Edge'}）`);
}

/**
 * 把一份错题集导成 PDF。
 *
 * @param options.docxPath Word 路线用的 docx（保留页眉页脚页码）
 * @param options.htmlPath 浏览器兜底路线用的 html
 * @param options.pdfPath 目标 PDF
 * @returns {{ path: string, engine: string, degraded: boolean }}
 */
export async function exportPdf({ docxPath, htmlPath, pdfPath }) {
  const notes = [];
  if (docxPath !== undefined) {
    try {
      const done = await officeToPdf(docxPath, pdfPath);
      return { path: pdfPath, engine: done.engine, degraded: false };
    } catch (error) {
      notes.push(String(error?.message ?? error));
    }
  }
  if (htmlPath !== undefined) {
    try {
      const done = await htmlToPdf(htmlPath, pdfPath);
      return { path: pdfPath, engine: done.engine, degraded: true };
    } catch (error) {
      notes.push(String(error?.message ?? error));
    }
  }
  throw new Error(`PDF 导出失败：${notes.join('；') || '没有可用的转换方式'}`);
}
