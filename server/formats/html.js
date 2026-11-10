'use strict';
/**
 * formats/html.js — HTML / HTM / XHTML。
 * 读取 → 去 <script>/<iframe>/on*= 等危险内容 → 取 <body> → 整本一章 + 标题式目录。
 * 本地相对图片复制进 EPUB 的 images/ 并改写 src；data: 图片解码成实体文件；外链图片跳过。
 */

const path = require('path');
const fs = require('fs');
const {
  readTextAuto, readTextHead, titleFromFilename, guessLanguage, escapeXmlAttr, escapeXmlText,
  sanitizeHtmlFragment, extractBody, decodeEntities, stripTags, ensureDir, mimeFromExt, extFromMime,
  sniffImage,
} = require('./util');
const { EpubBuilder } = require('./epub-build');
const { parseAttrs } = require('./epub');

function cleanTitle(raw) {
  let t = stripTags(decodeEntities(String(raw || '').trim()));
  t = t.replace(/\s+/g, ' ');
  // 去掉常见站点后缀：「网页样章 · 墨阅」「xxx - 小说网站」
  const parts = t.split(/\s+[·•|—–\-_]\s+/);
  if (parts.length > 1 && parts[parts.length - 1].length <= 16) t = parts.slice(0, -1).join(' ');
  return t.trim();
}

function extractMeta(html) {
  const h = String(html || '');
  const title = cleanTitle(
    (h.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ''
  );
  const h1 = stripTags((h.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '');
  const author = stripTags(
    (h.match(/<meta\b[^>]*name\s*=\s*["']author["'][^>]*content\s*=\s*["']([^"']*)["']/i) || [])[1] ||
    (h.match(/<meta\b[^>]*content\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']author["']/i) || [])[1] || ''
  );
  const langMatch = h.match(/<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i);
  return { title, h1, author, lang: langMatch ? langMatch[1].toLowerCase().split('-')[0] : '' };
}

async function probe(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const fallback = {
    format: ext === '.xhtml' ? 'XHTML' : 'HTML',
    title: titleFromFilename(filePath),
    author: '',
    language: 'zh',
    cover: null,
    coverMime: null,
  };
  try {
    const { text } = readTextHead(filePath, 96 * 1024);
    const meta = extractMeta(text);
    return {
      ...fallback,
      title: meta.title || meta.h1 || titleFromFilename(filePath),
      author: meta.author,
      language: meta.lang || guessLanguage(text),
    };
  } catch (_) {
    return fallback;
  }
}

/** 处理 <img>：本地图片复制进 EPUB；data URI 解码；外链删除 */
async function processImages(html, bookDir, builder, coverRef) {
  const counter = { n: 0 };
  const imgRe = /<img\b([^>]*?)\/?>/gi;
  const parts = [];
  let last = 0;
  let m;
  while ((m = imgRe.exec(html))) {
    parts.push(html.slice(last, m.index));
    last = imgRe.lastIndex;
    const attrs = parseAttrs(m[1]);
    let src = attrs.src || '';
    let buffer = null;
    let mime = '';
    let ext = '';
    if (/^data:image\//i.test(src)) {
      const dm = src.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/i);
      if (dm) {
        try {
          buffer = Buffer.from(dm[2], 'base64');
          mime = dm[1].toLowerCase();
          ext = extFromMime(mime);
        } catch (_) { buffer = null; }
      }
    } else if (src && !/^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/\/|#)/.test(src)) {
      const clean = (() => { try { return decodeURIComponent(src.split('#')[0].split('?')[0]); } catch (_) { return src.split('#')[0].split('?')[0]; } })();
      const candidates = [clean, clean.replace(/^\.\//, '')].map((p) => path.resolve(bookDir, p));
      for (const cand of candidates) {
        try {
          const st = fs.statSync(cand);
          if (!st.isFile() || st.size > 25 * 1024 * 1024) continue;
          const buf = fs.readFileSync(cand);
          const sniff = sniffImage(buf);
          mime = sniff ? sniff.mime : mimeFromExt(path.extname(cand).slice(1));
          if (!/^image\//.test(mime)) continue;
          buffer = buf;
          ext = sniff ? sniff.ext : path.extname(cand).slice(1).toLowerCase();
          break;
        } catch (_) { /* 下一候选 */ }
      }
    }
    if (!buffer || !buffer.length) {
      // 外链/缺失图片：保留 alt 文本的占位，避免破图
      const alt = attrs.alt || '';
      if (alt) parts.push('<span class="img-missing">' + escapeXmlText(alt) + '</span>');
      continue;
    }
    counter.n++;
    const href = builder.addImage({ name: 'html-img' + counter.n + '.' + (ext || 'jpg'), buffer, mime });
    if (coverRef && !coverRef.href) coverRef.href = href;
    const alt = attrs.alt ? ' alt="' + escapeXmlAttr(attrs.alt) + '"' : '';
    const title = attrs.title ? ' title="' + escapeXmlAttr(attrs.title) + '"' : '';
    parts.push('<img src="' + escapeXmlAttr(href.replace(/^images\//, '../images/')) + '"' + alt + title + '/>');
  }
  parts.push(html.slice(last));
  return parts.join('');
}

async function prepare(filePath, outDir) {
  const ext = path.extname(filePath).toLowerCase();
  const { text } = readTextAuto(filePath);
  if (!text || !text.trim()) throw new Error('文件内容为空');
  const meta = extractMeta(text);
  const title = meta.title || meta.h1 || titleFromFilename(filePath);
  const author = meta.author || '';
  const language = meta.lang || guessLanguage(text);
  const bodyRaw = extractBody(text);
  let body = sanitizeHtmlFragment(bodyRaw);
  if (!/<h[1-6]\b/i.test(body) && title) {
    body = '<h1 class="chapter-title">' + escapeXmlText(title) + '</h1>\n' + body;
  }
  ensureDir(outDir);
  const builder = new EpubBuilder({ title, author, language });
  const coverRef = { href: null };
  body = await processImages(body, path.dirname(path.resolve(filePath)), builder, coverRef);
  if (coverRef.href) builder.setCoverHref(coverRef.href);
  const href = builder.addChapter({ title, bodyHtml: body });
  builder.setToc([{ label: title, href, level: 1 }]);
  const outFile = path.join(outDir, 'book.epub');
  await builder.write(outFile);
  return { type: 'epub', file: outFile, toc: [{ label: title, href, level: 1 }], chapters: 1 };
}

module.exports = { FORMAT: 'HTML', probe, prepare, extractMeta };
