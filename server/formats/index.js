'use strict';
/**
 * formats/index.js — 格式解析/转换对外接口（见 SPEC §6）。
 *
 *   SUPPORTED / isSupported / formatOf / probe / prepare / pdfCover
 *
 * 约定：
 *   - probe 永不抛错（书架扫描用）：出错时退化为「扩展名 + 文件名」信息；
 *   - prepare 失败抛中文 Error；EPUB/PDF 原样返回，其它流式格式生成/复用 outDir/book.epub；
 *   - 中间产物统一写 <outDir>/work/，不污染其它目录；外部进程全部 stdio:'ignore'。
 */

const fs = require('fs');
const path = require('path');
const { ensureDir, titleFromFilename } = require('./util');

const SUPPORTED = ['epub', 'mobi', 'azw', 'azw3', 'prc', 'pdf', 'doc', 'docx', 'rtf', 'odt', 'txt', 'md', 'html', 'htm', 'xhtml', 'fb2'];

const FORMAT_BY_EXT = {
  epub: 'EPUB',
  mobi: 'MOBI',
  azw: 'AZW',
  azw3: 'AZW3',
  prc: 'PRC',
  pdf: 'PDF',
  doc: 'DOC',
  docx: 'DOCX',
  rtf: 'RTF',
  odt: 'ODT',
  txt: 'TXT',
  md: 'MD',
  html: 'HTML',
  htm: 'HTML',
  xhtml: 'XHTML',
  fb2: 'FB2',
};

// 延迟 require，某个依赖缺失时不至于让整个 formats 模块 require 失败（后端会优雅降级）
const MODULE_LOADERS = {
  EPUB: () => require('./epub'),
  PDF: () => require('./pdf'),
  MOBI: () => require('./mobi'),
  AZW: () => require('./mobi'),
  AZW3: () => require('./mobi'),
  PRC: () => require('./mobi'),
  DOCX: () => require('./docx'),
  DOC: () => require('./office'),
  RTF: () => require('./office'),
  ODT: () => require('./office'),
  TXT: () => require('./text'),
  MD: () => require('./text'),
  HTML: () => require('./html'),
  XHTML: () => require('./html'),
  FB2: () => require('./fb2'),
};

function extOf(filePath) {
  return path.extname(String(filePath || '')).replace(/^\./, '').toLowerCase();
}

function isSupported(filePath) {
  return SUPPORTED.includes(extOf(filePath));
}

function formatOf(filePath) {
  return FORMAT_BY_EXT[extOf(filePath)] || null;
}

function moduleFor(format, filePath) {
  const loader = MODULE_LOADERS[format];
  if (!loader) throw new Error('不支持的格式：' + (extOf(filePath) || path.extname(String(filePath || '')) || '未知'));
  let mod;
  try {
    mod = loader();
  } catch (e) {
    throw new Error('格式模块加载失败（' + format + '）：' + (e && e.message ? e.message : e));
  }
  if (!mod || typeof mod.prepare !== 'function') {
    throw new Error('格式模块不可用（' + format + '）');
  }
  return mod;
}

function fallbackProbe(filePath, format) {
  return {
    format: format || formatOf(filePath) || (extOf(filePath) || 'UNKNOWN').toUpperCase(),
    title: titleFromFilename(filePath),
    author: '',
    language: 'zh',
    cover: null,
    coverMime: null,
    pageCount: undefined,
  };
}

/**
 * 轻量探测（目标 < 300ms，不转换）
 * @param {string} filePath
 * @returns {Promise<object>}
 */
async function probe(filePath) {
  const format = formatOf(filePath);
  if (!format) return fallbackProbe(filePath, null);
  if (!fs.existsSync(filePath)) return fallbackProbe(filePath, format);
  try {
    const mod = MODULE_LOADERS[format] ? MODULE_LOADERS[format]() : null;
    if (!mod || typeof mod.probe !== 'function') return fallbackProbe(filePath, format);
    const result = await mod.probe(filePath);
    const out = result && typeof result === 'object' ? result : {};
    return {
      format,
      title: (out.title || '').trim() || titleFromFilename(filePath),
      author: (out.author || '').trim(),
      language: (out.language || '').trim() || 'zh',
      cover: out.cover || null,
      coverMime: out.coverMime || null,
      pageCount: typeof out.pageCount === 'number' ? out.pageCount : undefined,
      ...(out.outline ? { outline: out.outline } : {}),
    };
  } catch (_) {
    return fallbackProbe(filePath, format);
  }
}

/**
 * 确保可直接交给浏览器：PDF/EPUB 原样；其它生成 EPUB 缓存。
 * @param {string} filePath
 * @param {string} outDir .cache/books/<id>/（调用方保证存在）
 * @returns {Promise<{type:'epub'|'pdf', file:string, toc?:Array, pageCount?:number}>}
 */
async function prepare(filePath, outDir) {
  if (!filePath || typeof filePath !== 'string') throw new Error('文件路径无效');
  if (!fs.existsSync(filePath)) throw new Error('文件不存在：' + filePath);
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error('不是文件：' + filePath);
  const format = formatOf(filePath);
  if (!format) throw new Error('不支持的格式：' + (path.extname(filePath) || '无扩展名'));
  const dir = outDir || path.join(path.dirname(filePath));
  ensureDir(dir);
  ensureDir(path.join(dir, 'work'));
  const mod = moduleFor(format, filePath);
  const result = await mod.prepare(filePath, dir);
  if (!result || !result.file) throw new Error('转换失败：未生成产物');
  if (result.file !== filePath) {
    if (!fs.existsSync(result.file)) throw new Error('转换失败：产物不存在');
    if (fs.statSync(result.file).size <= 0) throw new Error('转换失败：产物为空');
  }
  return result;
}

/**
 * PDF 首页封面（无 PyMuPDF 时返回 false，不报错）
 * @param {string} filePath
 * @param {string} outJpgPath
 * @returns {Promise<boolean>}
 */
async function pdfCover(filePath, outJpgPath) {
  try {
    const mod = require('./pdf');
    return await mod.pdfCover(filePath, outJpgPath);
  } catch (_) {
    return false;
  }
}

module.exports = {
  SUPPORTED,
  VERSION: '1.0.0',
  isSupported,
  formatOf,
  probe,
  prepare,
  pdfCover,
};
