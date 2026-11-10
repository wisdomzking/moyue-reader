'use strict';

/**
 * server/formats 适配层。
 *
 * formats 模块由另一位同事并行开发（SPEC §6）。本层负责：
 *  - require 失败时**优雅降级**：按扩展名 + 文件名做最简 probe；EPUB/PDF 仍可直接阅读；
 *  - 统一校验返回值，避免 formats 半成品把后端带崩；
 *  - 探测环境能力（LibreOffice / Python / mammoth）供 /api/health 使用。
 *
 * 注：按 SPEC，formats 就绪后需要重启服务生效（不做热加载）。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { extOf, formatOfExt, SUPPORTED_EXT, isFile, ROOT } = require('./util');

let formatsMod = null;
let loadTried = false;
let loadError = null;
let capsCache = null;

function loadFormats() {
  if (loadTried) return formatsMod;
  loadTried = true;
  try {
    // eslint-disable-next-line global-require
    const mod = require('../formats');
    if (mod && typeof mod === 'object' && typeof mod.prepare === 'function') {
      formatsMod = mod;
    } else {
      loadError = 'server/formats 已存在但未导出 prepare()';
    }
  } catch (e) {
    loadError = e && e.message ? e.message : String(e);
    formatsMod = null;
  }
  return formatsMod;
}

function hasFormats() {
  return !!loadFormats();
}

function formatsStatus() {
  const mod = loadFormats();
  return {
    available: !!mod,
    error: mod ? null : loadError,
    supportedCount: SUPPORTED_EXT.size,
  };
}

function isSupported(filePath) {
  const ext = extOf(filePath);
  if (!ext) return false;
  const mod = loadFormats();
  if (mod && typeof mod.isSupported === 'function') {
    try {
      return !!mod.isSupported(filePath);
    } catch (e) {
      /* fall through */
    }
  }
  return SUPPORTED_EXT.has(ext);
}

function formatOf(filePath) {
  const mod = loadFormats();
  if (mod && typeof mod.formatOf === 'function') {
    try {
      const f = mod.formatOf(filePath);
      if (f) return String(f).toUpperCase();
    } catch (e) {
      /* fall through */
    }
  }
  return formatOfExt(extOf(filePath));
}

// ------------------------------------------------------------ 降级 probe
const TEXT_EXT = new Set(['html', 'htm', 'xhtml', 'fb2', 'txt', 'md']);

function stripTagsMini(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntitiesMini(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)));
}

/** 只读取文件头部，用正则抠 title/author（html / fb2 兜底） */
function probeTextFile(filePath, ext) {
  const out = { title: '', author: '' };
  let head = '';
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(256 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      head = buf.slice(0, n).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return out;
  }
  if (ext === 'fb2') {
    const t = /<book-title[^>]*>([\s\S]*?)<\/book-title>/i.exec(head);
    if (t) out.title = stripTagsMini(t[1]);
    const first = /<first-name[^>]*>([\s\S]*?)<\/first-name>/i.exec(head);
    const last = /<last-name[^>]*>([\s\S]*?)<\/last-name>/i.exec(head);
    const nick = /<nickname[^>]*>([\s\S]*?)<\/nickname>/i.exec(head);
    const name = [first && first[1], last && last[1]].filter(Boolean).map(stripTagsMini).join('');
    if (name) out.author = name;
    else if (nick) out.author = stripTagsMini(nick[1]);
    const lang = /<lang[^>]*>([\s\S]*?)<\/lang>/i.exec(head);
    if (lang) out.language = stripTagsMini(lang[1]).toLowerCase();
  } else if (ext === 'html' || ext === 'htm' || ext === 'xhtml') {
    const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
    if (t) out.title = decodeEntitiesMini(stripTagsMini(t[1]));
    const a = /<meta[^>]+name\s*=\s*["']author["'][^>]*content\s*=\s*["']([^"']*)["']/i.exec(head);
    if (a) out.author = decodeEntitiesMini(a[1]);
  }
  return out;
}

function probeFallback(filePath) {
  const ext = extOf(filePath);
  const base = path.basename(String(filePath), path.extname(String(filePath)));
  const info = {
    format: formatOfExt(ext) || null,
    title: base,
    author: '',
    language: 'zh',
    cover: null,
    coverMime: null,
  };
  if (TEXT_EXT.has(ext)) {
    const t = probeTextFile(filePath, ext);
    if (t.title) info.title = t.title;
    if (t.author) info.author = t.author;
    if (t.language) info.language = t.language;
  }
  return info;
}

// ------------------------------------------------------------ 对外 API
/**
 * 轻量探测。失败时返回基于文件名的兜底信息，绝不抛错。
 * @returns {Promise<{format,title,author,language,cover,coverMime,pageCount?}>}
 */
async function probe(filePath) {
  const fb = probeFallback(filePath);
  const mod = loadFormats();
  if (!mod || typeof mod.probe !== 'function') return fb;
  try {
    const r = await mod.probe(filePath);
    if (!r || typeof r !== 'object') return fb;
    const info = {
      format: r.format ? String(r.format).toUpperCase() : fb.format,
      title: r.title ? String(r.title).trim() : fb.title,
      author: r.author ? String(r.author).trim() : fb.author,
      language: r.language ? String(r.language).toLowerCase() : fb.language,
      cover: Buffer.isBuffer(r.cover) && r.cover.length ? r.cover : null,
      coverMime: r.coverMime ? String(r.coverMime) : r.cover ? 'image/jpeg' : null,
    };
    if (Number.isFinite(Number(r.pageCount)) && Number(r.pageCount) > 0) {
      info.pageCount = Number(r.pageCount);
    }
    if (!info.title) info.title = fb.title;
    return info;
  } catch (e) {
    return fb;
  }
}

/**
 * 确保可阅读文件：PDF/EPUB 原样，其它格式生成/复用 EPUB。
 * @param {string} filePath
 * @param {string} outDir 调用方保证已建好（.cache/books/<id>/）
 * @returns {Promise<{type:'epub'|'pdf', file:string, toc?:Array, pageCount?:number}>}
 */
async function prepare(filePath, outDir) {
  const fmt = formatOf(filePath);
  if (fmt === 'PDF') return { type: 'pdf', file: filePath, toc: [], pageCount: undefined };
  if (fmt === 'EPUB') return { type: 'epub', file: filePath, toc: [] };
  const mod = loadFormats();
  if (!mod || typeof mod.prepare !== 'function') {
    throw new Error(`转换模块尚未就绪，暂不能打开 ${fmt || '该'} 格式（EPUB / PDF 可直接阅读）`);
  }
  const r = await mod.prepare(filePath, outDir);
  if (!r || typeof r !== 'object' || !r.file) {
    throw new Error('转换模块未返回可读文件');
  }
  if (!isFile(r.file)) {
    throw new Error('转换产物不存在，请重试');
  }
  return {
    type: r.type === 'pdf' ? 'pdf' : 'epub',
    file: path.resolve(r.file),
    toc: Array.isArray(r.toc) ? r.toc : [],
    pageCount: Number.isFinite(Number(r.pageCount)) ? Number(r.pageCount) : 0,
  };
}

/** PDF 首页封面；无能力时返回 false（不报错） */
async function pdfCover(filePath, outJpgPath) {
  const mod = loadFormats();
  if (!mod || typeof mod.pdfCover !== 'function') return false;
  try {
    return (await mod.pdfCover(filePath, outJpgPath)) === true;
  } catch (e) {
    return false;
  }
}

// ------------------------------------------------------------ 能力探测
function pythonAvailable() {
  try {
    const r = spawnSync('python', ['-V'], { stdio: 'ignore', timeout: 8000, windowsHide: true });
    return !r.error && r.status === 0;
  } catch (e) {
    return false;
  }
}

function libreOfficeAvailable() {
  const candidates = [
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  ];
  return candidates.some((p) => isFile(p));
}

function kindleUnpackAvailable() {
  const candidates = [
    path.join(ROOT, 'vendor', 'kindleunpack', 'lib', 'kindleunpack.py'),
    path.join(ROOT, 'vendor', 'kindleunpack', 'kindleunpack', 'lib', 'kindleunpack.py'),
  ];
  if (candidates.some((p) => isFile(p))) return true;
  // 脚本路径可能变化：formats 模块内部自行定位，这里以模块可用作为兜底
  return !!loadFormats();
}

function nodeModuleAvailable(name) {
  return isFile(path.join(ROOT, 'node_modules', name, 'package.json'));
}

function capabilities() {
  if (capsCache) return capsCache;
  const python = pythonAvailable();
  // 能力按「本机依赖是否具备」上报（与 SPEC §5 的示例一致），实际转换由 formats 模块执行
  capsCache = {
    mobi: python && kindleUnpackAvailable(),
    docx: nodeModuleAvailable('mammoth'),
    pdf: true,
    libreoffice: libreOfficeAvailable(),
    python,
  };
  return capsCache;
}

module.exports = {
  loadFormats,
  hasFormats,
  formatsStatus,
  isSupported,
  formatOf,
  probe,
  prepare,
  pdfCover,
  capabilities,
  pythonAvailable,
  libreOfficeAvailable,
};
