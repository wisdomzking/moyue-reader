'use strict';
/**
 * formats/pdf.js — PDF 不转换，直接交给浏览器（pdf.js）。
 * probe/pdfCover 用 PyMuPDF（python + fitz，写 JSON/图片文件，不依赖 stdout）；
 * 无 PyMuPDF 时退回 pdfjs-dist legacy 只读 metadata，再不行用文件名。
 */

const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const {
  readTextHead, titleFromFilename, guessLanguage, ensureScratch, uniqueTempPath,
  runPythonTool, rmrf, existsNonEmpty, fileSize,
} = require('./util');

const FORMAT = 'PDF';
const probeCache = new Map();
const PROBE_CACHE_MAX = 80;

function cacheGet(key) {
  const hit = probeCache.get(key);
  if (hit) {
    probeCache.delete(key);
    probeCache.set(key, hit);
  }
  return hit || null;
}

function cacheSet(key, value) {
  probeCache.set(key, value);
  while (probeCache.size > PROBE_CACHE_MAX) {
    const first = probeCache.keys().next().value;
    probeCache.delete(first);
  }
}

function cacheKeyFor(filePath) {
  try {
    const st = fs.statSync(filePath);
    return filePath + '|' + st.size + '|' + Math.round(st.mtimeMs);
  } catch (_) {
    return filePath;
  }
}

/** 调 PyMuPDF 读元数据（可选渲染封面），返回结构或 null */
function pymupdfProbe(filePath, wantCover) {
  ensureScratch();
  const jsonPath = uniqueTempPath('pdfmeta', '.json');
  const coverPath = wantCover ? uniqueTempPath('pdfcover', '.jpg') : '';
  const args = [filePath, jsonPath];
  if (coverPath) args.push(coverPath);
  const res = runPythonTool('pdf_probe.py', args, { timeout: 30000 });
  let parsed = null;
  try {
    if (fs.existsSync(jsonPath)) parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (_) {
    parsed = null;
  }
  let cover = null;
  if (parsed && parsed.ok && coverPath && parsed.cover && existsNonEmpty(coverPath)) {
    try { cover = fs.readFileSync(coverPath); } catch (_) { cover = null; }
  }
  rmrf(jsonPath);
  if (coverPath) rmrf(coverPath);
  if (!parsed && !res.ok) return null;
  return parsed ? { ...parsed, coverBuffer: cover } : null;
}

/** pdfjs-dist legacy 兜底：只读 metadata / 页数（渲染需要 canvas，不可用） */
async function pdfjsProbe(filePath) {
  try {
    const mod = await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.js')).href);
    const pdfjs = mod.default || mod;
    const data = new Uint8Array(fs.readFileSync(filePath));
    const doc = await pdfjs.getDocument({
      data,
      disableWorker: true,
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      verbosity: 0,
    }).promise;
    const meta = await doc.getMetadata().catch(() => ({ info: {} }));
    const info = (meta && meta.info) || {};
    const pages = doc.numPages || 0;
    try { doc.destroy(); } catch (_) { /* ignore */ }
    return {
      title: String(info.Title || info.title || ''),
      author: String(info.Author || info.author || ''),
      pages,
      language: '',
      outline: [],
    };
  } catch (_) {
    return null;
  }
}

async function readPdfMeta(filePath, wantCover) {
  const baseKey = cacheKeyFor(filePath);
  const key = baseKey + '|' + (wantCover ? 'cover' : 'nocover');
  const cached = cacheGet(key);
  if (cached) return cached;
  // 已缓存过带封面的探测结果时，直接复用（pageCount/title/author 相同）
  if (!wantCover) {
    const coverCached = cacheGet(baseKey + '|cover');
    if (coverCached) {
      cacheSet(key, coverCached);
      return coverCached;
    }
  }
  let meta = pymupdfProbe(filePath, wantCover);
  if (!meta || !meta.ok) {
    const viaPdfjs = await pdfjsProbe(filePath);
    if (viaPdfjs) {
      meta = { ...viaPdfjs, ok: true, coverBuffer: null };
    }
  }
  if (!meta || !meta.ok) meta = null;
  cacheSet(key, meta);
  if (meta && wantCover) cacheSet(baseKey + '|nocover', meta);
  return meta;
}

async function probe(filePath) {
  const fallback = {
    format: FORMAT,
    title: titleFromFilename(filePath),
    author: '',
    language: 'zh',
    cover: null,
    coverMime: null,
    pageCount: undefined,
  };
  try {
    const meta = await readPdfMeta(filePath, true);
    if (!meta) return fallback;
    const title = (meta.title || '').trim() || titleFromFilename(filePath);
    return {
      format: FORMAT,
      title,
      author: (meta.author || '').trim(),
      language: (meta.language || '').trim() || guessLanguage(title),
      cover: meta.coverBuffer || null,
      coverMime: meta.coverBuffer ? 'image/jpeg' : null,
      pageCount: Number(meta.pages) || 0,
      outline: meta.outline || [],
    };
  } catch (_) {
    return fallback;
  }
}

/** PDF 不转换 */
async function prepare(filePath, outDir) {
  if (!existsNonEmpty(filePath)) throw new Error('文件不存在或为空：' + filePath);
  let pageCount = 0;
  try {
    const meta = await readPdfMeta(filePath, false);
    if (meta) pageCount = Number(meta.pages) || 0;
  } catch (_) {
    pageCount = 0;
  }
  return { type: 'pdf', file: filePath, pageCount };
}

/** 首页封面渲染到 outJpgPath；失败返回 false 不抛错 */
async function pdfCover(filePath, outJpgPath) {
  try {
    const dir = path.dirname(outJpgPath);
    await fs.promises.mkdir(dir, { recursive: true }).catch(() => {});
    const meta = pymupdfProbe(filePath, true);
    if (meta && meta.ok && meta.coverBuffer && meta.coverBuffer.length) {
      fs.writeFileSync(outJpgPath, meta.coverBuffer);
      return true;
    }
    // 直接调用渲染脚本（某些情况下 probe 走的 pdfjs 兜底）
    const jsonPath = uniqueTempPath('pdfcover-meta', '.json');
    const res = runPythonTool('pdf_probe.py', [filePath, jsonPath, outJpgPath], { timeout: 30000 });
    rmrf(jsonPath);
    if (existsNonEmpty(outJpgPath)) return true;
    return !!res.ok && false;
  } catch (_) {
    return false;
  }
}

module.exports = { FORMAT, probe, prepare, pdfCover, readPdfMeta };
