'use strict';
/**
 * formats/docx.js — DOCX → EPUB。
 * mammoth 转 HTML（图片用 convertImage 落盘进 EPUB 的 images/），按 <h1>/<h2> 切章；
 * probe 只读 docProps/core.xml（zip 随机读）与 docProps/thumbnail.jpeg 作为封面。
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const {
  titleFromFilename, guessLanguage, escapeXmlText, stripTags, decodeEntities,
  ensureDir, sanitizeHtmlFragment, sniffImage, extFromMime, mimeFromExt,
} = require('./util');
const { EpubBuilder } = require('./epub-build');
const { readZipEntries, extractEntry, findEntry, isZipFile } = require('./zip');
const { parseAttrs } = require('./epub');

function readCoreProps(filePath) {
  const out = { title: '', author: '', language: '' };
  try {
    if (!isZipFile(filePath)) return out;
    const entries = readZipEntries(filePath);
    const core = findEntry(entries, 'docProps/core.xml');
    if (core) {
      const xml = extractEntry(filePath, core).toString('utf8');
      out.title = stripTags(decodeEntities((xml.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i) || [])[1] || ''));
      out.author = stripTags(decodeEntities((xml.match(/<dc:creator\b[^>]*>([\s\S]*?)<\/dc:creator>/i) || [])[1] || ''));
      out.language = stripTags(decodeEntities((xml.match(/<dc:language\b[^>]*>([\s\S]*?)<\/dc:language>/i) || [])[1] || ''));
    }
  } catch (_) { /* 元数据损坏不影响打开 */ }
  return out;
}

function readDocxThumbnail(filePath) {
  try {
    if (!isZipFile(filePath)) return null;
    const entries = readZipEntries(filePath);
    const thumb = findEntry(entries, 'docProps/thumbnail.jpeg') ||
      entries.find((e) => /^docProps\/thumbnail\.(jpe?g|png)$/i.test(e.name));
    if (!thumb) return null;
    const buf = extractEntry(filePath, thumb);
    if (!buf || buf.length < 64) return null;
    const sniff = sniffImage(buf);
    return { cover: buf, coverMime: sniff ? sniff.mime : mimeFromExt(path.extname(thumb.name).slice(1)) };
  } catch (_) {
    return null;
  }
}

async function probe(filePath) {
  const fallback = {
    format: 'DOCX',
    title: titleFromFilename(filePath),
    author: '',
    language: 'zh',
    cover: null,
    coverMime: null,
  };
  try {
    const props = readCoreProps(filePath);
    const title = props.title || titleFromFilename(filePath);
    const result = {
      ...fallback,
      title,
      author: props.author || '',
      language: props.language || guessLanguage(title),
    };
    const thumb = readDocxThumbnail(filePath);
    if (thumb) {
      result.cover = thumb.cover;
      result.coverMime = thumb.coverMime;
    }
    return result;
  } catch (_) {
    return fallback;
  }
}

/** 按 h1（优先）或 h2 切章 */
function splitByHeadings(html, fallbackTitle) {
  const src = String(html || '');
  const count = (tag) => (src.match(new RegExp('<' + tag + '\\b', 'gi')) || []).length;
  let level = null;
  if (count('h1') > 0) level = 1;
  else if (count('h2') > 0) level = 2;
  if (!level) {
    return [{ title: fallbackTitle, body: src, level: 0 }];
  }
  const re = new RegExp('<(h' + level + ')\\b[^>]*>([\\s\\S]*?)</h' + level + '>', 'gi');
  const marks = [];
  let m;
  while ((m = re.exec(src))) marks.push({ index: m.index, end: re.lastIndex, label: stripTags(m[2]) || fallbackTitle });
  const chapters = [];
  const front = src.slice(0, marks[0].index);
  if (stripTags(front).replace(/\s/g, '').length > 2) {
    chapters.push({ title: fallbackTitle, body: front, level: 0 });
  }
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index;
    const end = i + 1 < marks.length ? marks[i + 1].index : src.length;
    const body = src.slice(start, end);
    if (!stripTags(body).trim()) continue;
    chapters.push({ title: marks[i].label, body, level: 1 });
  }
  if (!chapters.length) chapters.push({ title: fallbackTitle, body: src, level: 0 });
  return chapters;
}

async function prepare(filePath, outDir) {
  let mammoth;
  try {
    mammoth = require('mammoth');
  } catch (e) {
    throw new Error('缺少 mammoth 组件，无法转换 DOCX');
  }
  const props = readCoreProps(filePath);
  const title = props.title || titleFromFilename(filePath);
  const author = props.author || '';
  ensureDir(outDir);
  const builder = new EpubBuilder({ title, author, language: props.language || guessLanguage(title) });

  const imageMap = new Map();
  let imageSeq = 0;
  const convertImage = mammoth.images.imgElement(async (image) => {
    const buffer = await image.read();
    if (!buffer || !buffer.length) return {};
    let mime = image.contentType || '';
    const sniff = sniffImage(buffer);
    if (sniff) mime = mime || sniff.mime;
    if (!mime) mime = 'image/png';
    let ext = sniff ? sniff.ext : extFromMime(mime);
    const hash = crypto.createHash('md5').update(buffer).digest('hex');
    let href = imageMap.get(hash);
    if (!href) {
      imageSeq++;
      href = builder.addImage({ name: 'docx-img' + imageSeq + '.' + ext, buffer, mime });
      imageMap.set(hash, href);
    }
    return { src: href.replace(/^images\//, '../images/') };
  });

  let result;
  try {
    result = await mammoth.convertToHtml({ path: filePath }, { convertImage });
  } catch (e) {
    throw new Error('DOCX 解析失败：' + (e && e.message ? e.message : e));
  }
  let html = sanitizeHtmlFragment(result.value || '');
  if (!html.trim()) throw new Error('DOCX 中没有可显示的正文内容');

  const language = props.language || guessLanguage(stripTags(html).slice(0, 20000));
  builder.language = language;
  const chapters = splitByHeadings(html, title);
  const toc = [];
  let first = true;
  for (const ch of chapters) {
    let body = ch.body;
    if (first && title && !/<h[1-6]\b/i.test(body)) {
      body = '<h1 class="chapter-title">' + escapeXmlText(title) + '</h1>\n' + body;
    }
    first = false;
    const href = builder.addChapter({ title: ch.title || title, bodyHtml: body });
    toc.push({ label: ch.title || title, href, level: 1 });
  }
  if (toc.length === 0) {
    const href = builder.addChapter({ title, bodyHtml: '<p>' + escapeXmlText(title) + '</p>' });
    toc.push({ label: title, href, level: 1 });
  }
  // 没有封面时用 DOCX 缩略图（docProps/thumbnail.jpeg）
  const thumb = readDocxThumbnail(filePath);
  if (thumb) builder.setCover(thumb.cover, thumb.coverMime);
  builder.setToc(toc);
  const outFile = path.join(outDir, 'book.epub');
  await builder.write(outFile);
  return { type: 'epub', file: outFile, toc, chapters: toc.length, warnings: (result.messages || []).length };
}

module.exports = { FORMAT: 'DOCX', probe, prepare, readCoreProps, splitByHeadings };
