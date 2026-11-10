'use strict';

/**
 * 封面懒生成 + 缓存（data/covers/<id>.jpg|.png）。
 * 优先 formats.probe 返回的封面 Buffer；PDF 用 formats.pdfCover；EPUB 兜底用 jszip 取封面图。
 */

const fs = require('fs');
const path = require('path');
const { COVERS_DIR, BOOKS_CACHE_DIR, ensureDir, isFile, readJson, extOf } = require('./util');
const adapter = require('./formats-adapter');
const { openEpub, extractCover } = require('./epub-zip');
const { renderCoverSvg } = require('./cover-art');

const COVER_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'];
const inflight = new Map();

function coverPathFor(id) {
  for (const ext of COVER_EXTS) {
    const p = path.join(COVERS_DIR, `${id}.${ext}`);
    if (isFile(p)) return p;
  }
  return null;
}

function removeCover(id) {
  for (const ext of COVER_EXTS) {
    try {
      const p = path.join(COVERS_DIR, `${id}.${ext}`);
      if (isFile(p)) fs.unlinkSync(p);
    } catch (e) {
      /* ignore */
    }
  }
}

function mimeForCoverFile(file) {
  const ext = extOf(file);
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'svg') return 'image/svg+xml; charset=utf-8';
  return 'image/jpeg';
}

async function removeOtherCovers(id, keepExt) {
  for (const other of COVER_EXTS) {
    if (other === keepExt) continue;
    const p = path.join(COVERS_DIR, `${id}.${other}`);
    if (isFile(p)) {
      try {
        await fs.promises.unlink(p);
      } catch (e) {
        /* ignore */
      }
    }
  }
}

async function saveCoverSvg(id, svg) {
  if (!svg) return null;
  ensureDir(COVERS_DIR);
  const out = path.join(COVERS_DIR, `${id}.svg`);
  await fs.promises.writeFile(out, svg, 'utf8');
  await removeOtherCovers(id, 'svg');
  return out;
}

async function saveCoverBuffer(id, buf, mime) {
  if (!buf || !buf.length) return null;
  ensureDir(COVERS_DIR);
  const isPng = mime === 'image/png' || (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e);
  const isWebp = buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP';
  const ext = isPng ? 'png' : isWebp ? 'webp' : 'jpg';
  const out = path.join(COVERS_DIR, `${id}.${ext}`);
  await fs.promises.writeFile(out, buf);
  // 清掉其它扩展名的旧封面，避免 coverPathFor 取到陈旧文件
  await removeOtherCovers(id, ext);
  return out;
}

/** 找一本（可能是转换产物）可读 EPUB 文件，仅用于封面兜底 */
function epubFileFor(book) {
  const fmt = adapter.formatOf(book.path) || (extOf(book.path) || '').toUpperCase();
  if (fmt === 'EPUB') return isFile(book.path) ? book.path : null;
  const meta = readJson(path.join(BOOKS_CACHE_DIR, book.id, 'meta.json'), null);
  if (
    meta &&
    meta.srcMtime === book.mtime &&
    meta.srcSize === book.size &&
    meta.type === 'epub' &&
    meta.file &&
    isFile(meta.file)
  ) {
    return meta.file;
  }
  return null;
}

async function generate(book) {
  // 1) formats.probe 直接给封面（EPUB/PDF/DOCX 等）
  try {
    const info = await adapter.probe(book.path);
    if (info && info.cover && info.cover.length) {
      const p = await saveCoverBuffer(book.id, info.cover, info.coverMime);
      if (p) return p;
    }
  } catch (e) {
    /* ignore */
  }
  // 2) PDF：formats.pdfCover 渲染首页
  const fmt = adapter.formatOf(book.path);
  if (fmt === 'PDF') {
    ensureDir(COVERS_DIR);
    const out = path.join(COVERS_DIR, `${book.id}.jpg`);
    const ok = await adapter.pdfCover(book.path, out);
    if (ok && isFile(out)) return out;
  }
  // 3) EPUB（含转换产物）：从 zip 里取封面图
  const epubFile = epubFileFor(book);
  if (epubFile) {
    try {
      const parsed = await openEpub(epubFile);
      const cov = await extractCover(parsed);
      if (cov) return await saveCoverBuffer(book.id, cov.buffer, cov.mime);
    } catch (e) {
      /* ignore */
    }
  }
  // 4) 没有可用图片：生成一张稳定的排版封面（有封面时不会走到这里）
  try {
    return await saveCoverSvg(book.id, renderCoverSvg(book));
  } catch (e) {
    return null;
  }
}

/**
 * 确保封面已生成，返回封面文件绝对路径；无封面返回 null（调用方回 404）。
 * @param {object} book BookRecord
 */
async function ensureCover(book) {
  const existing = coverPathFor(book.id);
  if (existing) return existing;
  if (inflight.has(book.id)) return inflight.get(book.id);
  const task = generate(book)
    .catch(() => null)
    .finally(() => inflight.delete(book.id));
  inflight.set(book.id, task);
  return task;
}

module.exports = {
  ensureCover,
  coverPathFor,
  saveCoverBuffer,
  saveCoverSvg,
  removeCover,
  mimeForCoverFile,
};
