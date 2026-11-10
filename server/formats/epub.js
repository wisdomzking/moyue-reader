'use strict';
/**
 * formats/epub.js — EPUB 探测（轻量，不转换）与原样 prepare。
 * probe 用 zip.js 只解压 container.xml / content.opf / 封面图，避免整书解压。
 */

const path = require('path');
const {
  readTextHead, titleFromFilename, stripTags, decodeEntities, guessLanguage,
} = require('./util');
const { readZipEntries, extractEntry, findEntry, isZipFile } = require('./zip');

/** 解析开始标签的属性列表，如 <item id="x" href="a"> */
function parseAttrs(tagText) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m;
  while ((m = re.exec(tagText))) {
    const key = m[1].toLowerCase();
    if (attrs[key] == null) attrs[key] = m[2] != null ? m[2] : (m[3] != null ? m[3] : m[4]);
  }
  return attrs;
}

function firstMatch(text, re) {
  const m = String(text || '').match(re);
  return m ? m[1] : '';
}

/**
 * 解析 OPF 字符串 → 元数据 + manifest + spine + 封面 href。
 * 相对路径（href）会被解析成相对 OPF 所在目录的 zip 内路径。
 */
function parseOpf(opfText, opfPath) {
  const text = String(opfText || '');
  const baseDir = path.posix.dirname(String(opfPath || 'OEBPS/content.opf').replace(/\\/g, '/'));
  const metadataBlock = firstMatch(text, /<metadata\b[^>]*>([\s\S]*?)<\/metadata>/i) || text;
  const titleRaw = firstMatch(metadataBlock, /<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i) ||
    firstMatch(metadataBlock, /<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const creatorRaw = firstMatch(metadataBlock, /<dc:creator\b[^>]*>([\s\S]*?)<\/dc:creator>/i);
  const languageRaw = firstMatch(metadataBlock, /<dc:language\b[^>]*>([\s\S]*?)<\/dc:language>/i);
  const identifierRaw = firstMatch(metadataBlock, /<dc:identifier\b[^>]*>([\s\S]*?)<\/dc:identifier>/i);
  const subtitleRaw = firstMatch(metadataBlock, /<dc:description\b[^>]*>([\s\S]*?)<\/dc:description>/i);

  // manifest
  const manifestBlock = firstMatch(text, /<manifest\b[^>]*>([\s\S]*?)<\/manifest>/i);
  const items = [];
  const itemRe = /<item\b([^>]*)\/?>/gi;
  let m;
  while ((m = itemRe.exec(manifestBlock))) {
    const a = parseAttrs(m[1]);
    if (!a.href) continue;
    const href = normalizeHref(a.href);
    items.push({
      id: a.id || '',
      href,
      mediaType: a['media-type'] || '',
      properties: a.properties || '',
      zipPath: path.posix.normalize(path.posix.join(baseDir, href)),
    });
  }

  // spine 顺序
  const spineBlock = firstMatch(text, /<spine\b[^>]*>([\s\S]*?)<\/spine>/i);
  const spineIds = [];
  const refRe = /<itemref\b([^>]*)\/?>/gi;
  while ((m = refRe.exec(spineBlock))) {
    const a = parseAttrs(m[1]);
    if (a.idref) spineIds.push(a.idref);
  }

  // 封面：EPUB3 properties="cover-image" > EPUB2 <meta name="cover" content="id"> > 名字含 cover 的图片 > 第一张图片
  let coverItem = items.find((it) => /(^|\s)cover-image(\s|$)/.test(it.properties) && /^image\//.test(it.mediaType));
  if (!coverItem) {
    const metaRe = /<meta\b([^>]*)\/?>/gi;
    while ((m = metaRe.exec(metadataBlock))) {
      const a = parseAttrs(m[1]);
      if (a.name && a.name.toLowerCase() === 'cover' && a.content) {
        const hit = items.find((it) => it.id === a.content) || items.find((it) => it.href === normalizeHref(a.content));
        if (hit && /^image\//.test(hit.mediaType || '') === true) { coverItem = hit; break; }
        if (hit) { coverItem = hit; break; }
      }
    }
  }
  if (!coverItem) coverItem = items.find((it) => /^image\//.test(it.mediaType) && /cover/i.test(it.href));
  if (!coverItem) coverItem = items.find((it) => /^image\//.test(it.mediaType));

  return {
    baseDir,
    title: stripTags(titleRaw),
    author: stripTags(creatorRaw),
    language: stripTags(languageRaw) || guessLanguage(stripTags(subtitleRaw)),
    identifier: stripTags(identifierRaw),
    items,
    spineIds,
    coverItem: coverItem || null,
    textItems: items.filter((it) => /xhtml|html/.test(it.mediaType || it.href)),
  };
}

function normalizeHref(href) {
  let s = String(href || '').trim().replace(/\\/g, '/');
  const hash = s.indexOf('#');
  if (hash >= 0) s = s.slice(0, hash);
  try { s = decodeURIComponent(s); } catch (_) { /* ignore */ }
  return s.replace(/^\.\//, '');
}

function readOpf(filePath) {
  const entries = readZipEntries(filePath);
  const container = findEntry(entries, 'META-INF/container.xml');
  let opfPath = '';
  if (container) {
    const xml = extractEntry(filePath, container).toString('utf8');
    opfPath = firstMatch(xml, /<rootfile\b[^>]*full-path\s*=\s*["']([^"']+)["']/i);
  }
  if (!opfPath) {
    const guess = entries.find((e) => /(^|\/)content\.opf$/i.test(e.name)) || entries.find((e) => /\.opf$/i.test(e.name));
    if (!guess) throw new Error('EPUB 缺少 content.opf');
    opfPath = guess.name;
  }
  const opfEntry = findEntry(entries, opfPath);
  if (!opfEntry) throw new Error('EPUB 缺少 OPF 文件: ' + opfPath);
  const opfText = extractEntry(filePath, opfEntry).toString('utf8');
  return { entries, opfPath: opfEntry.name, opfText, opf: parseOpf(opfText, opfEntry.name) };
}

function readCover(filePath, entries, opf) {
  if (!opf.coverItem) return null;
  const wanted = opf.coverItem.zipPath;
  let entry = findEntry(entries, wanted);
  if (!entry) {
    // 有些书 OPF 里 href 大小写不一致或带奇怪前缀，退化为按文件名匹配
    const base = path.posix.basename(wanted).toLowerCase();
    entry = entries.find((e) => path.posix.basename(e.name).toLowerCase() === base) || null;
  }
  if (!entry) return null;
  try {
    const buf = extractEntry(filePath, entry);
    if (!buf || buf.length < 64) return null;
    let mime = opf.coverItem.mediaType;
    if (!/^image\//.test(mime || '')) {
      const ext = path.extname(entry.name).slice(1).toLowerCase();
      mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
    }
    return { cover: buf, coverMime: mime };
  } catch (_) {
    return null;
  }
}

const FORMAT = 'EPUB';

/**
 * 轻量探测
 * @returns {Promise<{format,title,author,language,cover,coverMime,pageCount}>}
 */
async function probe(filePath) {
  const fallback = {
    format: FORMAT,
    title: titleFromFilename(filePath),
    author: '',
    language: 'zh',
    cover: null,
    coverMime: null,
  };
  try {
    if (!isZipFile(filePath)) return fallback;
    const { entries, opf } = readOpf(filePath);
    const result = {
      format: FORMAT,
      title: opf.title || titleFromFilename(filePath),
      author: opf.author || '',
      language: (opf.language || '').toLowerCase().slice(0, 12) || guessLanguage(opf.title),
      cover: null,
      coverMime: null,
      pageCount: undefined,
    };
    const coverInfo = readCover(filePath, entries, opf);
    if (coverInfo) {
      result.cover = coverInfo.cover;
      result.coverMime = coverInfo.coverMime;
    }
    return result;
  } catch (err) {
    // 封面/元数据损坏不应影响书架：返回文件名信息
    fallback.error = err && err.message;
    return fallback;
  }
}

/** EPUB 不转换，直接交给浏览器 */
async function prepare(filePath, outDir) {
  const st = require('fs').statSync(filePath);
  if (!st.isFile()) throw new Error('文件不存在：' + filePath);
  return { type: 'epub', file: filePath };
}

/** 读取 EPUB 内的目录（nav.xhtml 优先，再 toc.ncx）——供 backend 搜索/目录使用（可选导出） */
async function readToc(filePath) {
  const { entries, opf } = readOpf(filePath);
  const out = [];
  try {
    const navItem = opf.items.find((it) => /(^|\s)nav(\s|$)/.test(it.properties));
    const navEntry = navItem ? findEntry(entries, navItem.zipPath) : null;
    if (navEntry) {
      const navText = extractEntry(filePath, navEntry).toString('utf8');
      const navBase = path.posix.dirname(navEntry.name);
      const linkRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
      let m;
      while ((m = linkRe.exec(navText))) {
        const a = parseAttrs(m[1]);
        if (!a.href) continue;
        const href = path.posix.normalize(path.posix.join(navBase, normalizeHref(a.href)));
        out.push({ label: stripTags(decodeEntities(m[2])), href, level: 1 });
      }
      if (out.length) return out;
    }
  } catch (_) { /* 继续尝试 ncx */ }
  try {
    const ncxItem = opf.items.find((it) => /ncx/.test(it.mediaType || it.href));
    const ncxEntry = ncxItem ? findEntry(entries, ncxItem.zipPath) : findEntry(entries, 'toc.ncx');
    if (ncxEntry) {
      const ncxText = extractEntry(filePath, ncxEntry).toString('utf8');
      const navBase = path.posix.dirname(ncxEntry.name);
      const navRe = /<navPoint\b[\s\S]*?<navLabel>\s*<text>([\s\S]*?)<\/text>[\s\S]*?<content\b[^>]*src\s*=\s*["']([^"']+)["']/gi;
      let m;
      while ((m = navRe.exec(ncxText))) {
        const href = path.posix.normalize(path.posix.join(navBase, normalizeHref(m[2])));
        out.push({ label: stripTags(decodeEntities(m[1])), href, level: 1 });
      }
    }
  } catch (_) { /* ignore */ }
  return out;
}

module.exports = { FORMAT, probe, prepare, readOpf, parseOpf, parseAttrs, readToc, normalizeHref };
