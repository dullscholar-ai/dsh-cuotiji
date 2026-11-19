/**
 * 本地 OCR：调用 RapidOCR(PP-OCR) 把整页试卷转成带阅读顺序的文字。
 *
 * 为什么要有这一层：模型不一定具备图片输入能力，而错题入库要求「逐字抄录」。
 * 先把原卷在**本机** OCR 成文本，再连同原图一起交给模型，模型就能以文字为准、
 * 用原图核对分栏与手写答案，而不是在看不见图的情况下猜。
 *
 * 约束：
 *   - 不联网、不上传任何图片；
 *   - 找不到可用解释器或 rapidocr 未安装时**不报错**，返回 ok:false 让上层降级；
 *   - 结果按「文件 + 大小 + 修改时间」缓存，重复点击不会重跑十几秒。
 * @module @dullscholar-ai/dsh-cuotiji/lib/ocr
 */

import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'ocr-page.py');

/** 引擎需要 Python 侧装有 rapidocr_onnxruntime；这里按优先级探测。 */
const PYTHON_CANDIDATES = [
  process.env.CUOTIJI_PYTHON,
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'),
  'python.exe',
  'python3.exe',
  'py.exe',
].filter((candidate) => typeof candidate === 'string' && candidate !== '');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff']);

/** 进程级缓存：同一个文件不重复 OCR。 */
const CACHE = new Map();
let pythonPromise;

function run(exe, args, timeoutMs) {
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
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已经退出 */
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

/** 探测哪个解释器能 `import rapidocr_onnxruntime`，结果缓存。 */
export function resolvePython() {
  if (pythonPromise !== undefined) return pythonPromise;
  pythonPromise = (async () => {
    const notes = [];
    for (const candidate of PYTHON_CANDIDATES) {
      const probe = await run(candidate, ['-c', 'import rapidocr_onnxruntime as r; print(getattr(r, "__version__", "?"))'], 30_000);
      if (probe.code === 0) {
        return { ok: true, python: candidate, version: probe.stdout.trim() };
      }
      if (probe.missing === true) notes.push(`${candidate}: 不存在`);
      else notes.push(`${candidate}: ${(probe.stderr || probe.stdout).trim().split('\n').slice(-1)[0]}`);
    }
    return { ok: false, reason: `没找到装了 rapidocr_onnxruntime 的解释器（${notes.join('；')}）` };
  })();
  return pythonPromise;
}

export function isOcrCandidate(absolutePath) {
  return IMAGE_EXTENSIONS.has(path.extname(absolutePath).toLowerCase());
}

/**
 * 对一张图跑 OCR。
 * @param absolutePath 图片绝对路径
 * @param options.cacheKey 附加缓存键（默认用路径+大小+修改时间）
 * @param options.timeoutMs 超时，默认 180 秒（首次加载模型较慢）
 * @returns {Promise<{ok: boolean, reason?: string, engine?: string, lines?: string[], blocks?: unknown[], size?: number[], elapsed?: object, text?: string}>}
 */
export async function runOcr(absolutePath, options = {}) {
  if (!isOcrCandidate(absolutePath)) {
    return { ok: false, reason: `不是图片（${path.extname(absolutePath) || '无扩展名'}），当前只对图片做本地 OCR。` };
  }

  let stat;
  try {
    stat = await fsp.stat(absolutePath);
  } catch {
    return { ok: false, reason: '文件不存在。' };
  }

  const cacheKey = options.cacheKey ?? `${absolutePath}::${stat.size}::${stat.mtimeMs}`;
  if (CACHE.has(cacheKey)) return CACHE.get(cacheKey);

  const python = await resolvePython();
  if (python.ok !== true) {
    const failed = { ok: false, reason: python.reason };
    CACHE.set(cacheKey, failed);
    return failed;
  }

  const outJson = path.join(os.tmpdir(), `cuotiji-ocr-${process.pid}-${Date.now()}.json`);
  try {
    const started = Date.now();
    const result = await run(python.python, [SCRIPT, absolutePath, outJson], options.timeoutMs ?? 180_000);
    if (result.code !== 0) {
      return {
        ok: false,
        reason: `OCR 进程失败（退出码 ${result.code}）：${(result.stderr || result.stdout).trim().slice(0, 400)}`,
      };
    }
    const raw = await fsp.readFile(outJson, 'utf8');
    const payload = JSON.parse(raw);
    const lines = Array.isArray(payload.lines) ? payload.lines : [];
    const value = {
      ok: lines.length > 0,
      reason: lines.length === 0 ? 'OCR 没有识别出文字（可能是空白页或纯图）。' : undefined,
      engine: payload.engine,
      lines,
      blocks: Array.isArray(payload.blocks) ? payload.blocks : [],
      size: payload.size,
      elapsed: { ...payload.elapsed, totalMs: Date.now() - started },
      text: lines.join('\n'),
    };
    CACHE.set(cacheKey, value);
    return value;
  } catch (error) {
    return { ok: false, reason: `OCR 结果解析失败：${String(error?.message ?? error)}` };
  } finally {
    await fsp.rm(outJson, { force: true });
  }
}

/** 把 OCR 结果整理成交给模型看的段落（含阅读顺序说明）。 */
export function describeOcr(result) {
  if (result.ok !== true) return `本地 OCR 未成功：${result.reason ?? '未知原因'}。请直接读原图。`;
  const { lines, elapsed, size } = result;
  const seconds = elapsed?.totalMs === undefined ? '' : `，耗时 ${(elapsed.totalMs / 1000).toFixed(1)} 秒`;
  const pixels = Array.isArray(size) ? `${size[0]}×${size[1]}` : '未知尺寸';
  return [
    `引擎 ${result.engine}（本机运行，图片未上传），${pixels}${seconds}，识别 ${lines.length} 段文字。`,
    '已按「左栏自上而下 → 右栏自上而下」重排，避免双栏串序。',
  ].join('');
}
