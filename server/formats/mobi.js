'use strict';
/**
 * formats/mobi.js — MOBI / AZW / AZW3 / PRC。
 *
 * probe：直接读 PalmDB 头 + PalmDOC/MOBI 头 + EXTH（title 503 / author 100 / language 524 /
 *         cover offset 201），不跑 KindleUnpack，毫秒级。
 * prepare：
 *   1) python vendor/kindleunpack/.../kindleunpack.py --epub_version=3 <src> <work/kindle>
 *      （注意：KindleUnpack 用 getopt，选项必须放在位置参数之前，否则会被当成多余位置参数）
 *   2) 若产物里有 *.epub，直接使用；
 *   3) 否则把 mobi7/mobi8 目录交给 tools/mobi_html.py 切成章节素材（Python+lxml 清洗），
 *      再由 Node 用 epub-build 组装成 EPUB3（目录/图片/封面尽量保留）；
 *   4) Python 辅助脚本失败时退回 JS 清洗的整本一章（保证至少能读）。
 */

const path = require('path');
const fs = require('fs');
const {
  PROJECT_ROOT, ensureDir, rmrf, runProcess, runPythonTool, existsNonEmpty, walkFiles, findFirst,
  sanitizeHtmlFragment, extractBody, decodeEntities, stripTags, escapeXmlAttr, escapeXmlText,
  sniffImage, mimeFromExt, titleFromFilename, guessLanguage,
} = require('./util');
const { EpubBuilder } = require('./epub-build');
const { readZipEntries, findEntry, extractEntry } = require('./zip');

const FORMAT = 'MOBI';

/* ------------------------------------------------------------------ */
/* PalmDB / MOBI / EXTH 解析                                           */
/* ------------------------------------------------------------------ */

function readAt(fd, offset, length) {
  const buf = Buffer.alloc(Math.max(0, length));
  if (length <= 0) return buf;
  const n = fs.readSync(fd, buf, 0, length, offset);
  return n === length ? buf : buf.subarray(0, n);
}

function decodeText(buf, codec) {
  try {
    if (codec === 'utf-8') {
      const s = buf.toString('utf8');
      return s;
    }
    return new TextDecoder(codec || 'windows-1252').decode(buf);
  } catch (_) {
    return buf.toString('utf8');
  }
}

const LOCALE_LANG = {
  0x0409: 'en', 0x0809: 'en', 0x0c09: 'en', 0x1009: 'en', 0x1409: 'en',
  0x0404: 'zh', 0x0804: 'zh', 0x0c04: 'zh', 0x1004: 'zh',
  0x0407: 'de', 0x040c: 'fr', 0x0411: 'ja', 0x0412: 'ko', 0x0419: 'ru',
  0x0413: 'nl', 0x0416: 'pt', 0x0410: 'it', 0x040a: 'es', 0x0415: 'pl',
  0x041d: 'sv', 0x0406: 'da', 0x0414: 'no', 0x040b: 'fi', 0x0405: 'cs',
};

/** 读取 PalmDB 基本结构 + record0（含 MOBI header/EXTH/fullname）；封面按需读一条记录 */
function readMobiProbe(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    if (fileSize < 100) throw new Error('文件太小，不是 MOBI');
    const head = readAt(fd, 0, 78);
    const type = head.toString('latin1', 60, 64);
    const creator = head.toString('latin1', 64, 68);
    if (!/MOBI|BOOK|TEXt|PDF/.test(type + creator)) {
      // 有些 PRC 的 type/creator 比较随意，继续尝试即可
    }
    const numRecords = head.readUInt16BE(76);
    if (!numRecords || numRecords > 100000) throw new Error('PalmDB 记录数异常');
    const tableLen = numRecords * 8;
    const table = readAt(fd, 78, tableLen);
    const offsets = [];
    for (let i = 0; i < numRecords; i++) {
      offsets.push(table.readUInt32BE(i * 8));
    }
    offsets.push(fileSize);
    const recordStart = (i) => offsets[i];
    const recordEnd = (i) => (i + 1 < offsets.length ? offsets[i + 1] : fileSize);
    const r0Len = Math.min(recordEnd(0) - recordStart(0), 4 * 1024 * 1024);
    const r0 = readAt(fd, recordStart(0), r0Len);

    const info = {
      title: '',
      author: '',
      language: '',
      cover: null,
      coverMime: null,
      codec: 'windows-1252',
      firstNonBookIndex: 0,
      coverOffset: -1,
      thumbOffset: -1,
      recordStart,
      recordEnd,
      numRecords,
    };
    // PalmDOC header
    info.compression = r0.readUInt16BE(0);
    info.textLength = r0.readUInt32BE(4);
    info.textRecords = r0.readUInt16BE(8);
    info.encryption = r0.readUInt16BE(12);
    info.firstNonBookIndex = info.textRecords + 1;

    if (r0.length >= 24 && r0.toString('latin1', 16, 20) === 'MOBI') {
      const headerLen = r0.length >= 24 ? r0.readUInt32BE(20) : 0;
      const textEncoding = r0.length >= 32 ? r0.readUInt32BE(28) : 1252;
      info.codec = textEncoding === 65001 ? 'utf-8' : 'windows-1252';
      info.firstResourceIndex = info.firstNonBookIndex;
      if (r0.length >= 84) {
        const firstNonBook = r0.readUInt32BE(80);
        if (firstNonBook > 0 && firstNonBook < numRecords) info.firstNonBookIndex = firstNonBook;
      }
      if (r0.length >= 112) {
        const firstResc = r0.readUInt32BE(108);
        if (firstResc > 0 && firstResc < numRecords) info.firstResourceIndex = firstResc;
      }
      let fullName = '';
      if (r0.length >= 92) {
        const fnOffset = r0.readUInt32BE(84);
        const fnLength = r0.readUInt32BE(88);
        if (fnOffset > 0 && fnLength > 0 && fnOffset + fnLength <= r0.length) {
          fullName = decodeText(r0.subarray(fnOffset, fnOffset + fnLength), info.codec).trim();
        }
      }
      if (r0.length >= 96) {
        const locale = r0.readUInt32BE(92) & 0xffff;
        info.language = LOCALE_LANG[locale] || '';
      }
      // EXTH
      const exthOffset = 16 + headerLen;
      if (headerLen > 0 && exthOffset + 12 <= r0.length && r0.toString('latin1', exthOffset, exthOffset + 4) === 'EXTH') {
        const exthLength = r0.readUInt32BE(exthOffset + 4);
        const count = r0.readUInt32BE(exthOffset + 8);
        let pos = exthOffset + 12;
        const end = Math.min(r0.length, exthOffset + Math.max(exthLength, 12));
        for (let i = 0; i < count && pos + 8 <= end; i++) {
          const type = r0.readUInt32BE(pos);
          const len = r0.readUInt32BE(pos + 4);
          if (len < 8 || pos + len > r0.length) break;
          const data = r0.subarray(pos + 8, pos + len);
          if (type === 503) info.title = decodeText(data, info.codec).trim();
          else if (type === 100) info.author = decodeText(data, info.codec).trim();
          else if (type === 524) {
            const lang = decodeText(data, info.codec).trim().toLowerCase();
            if (lang) info.language = lang.slice(0, 12);
          } else if (type === 201 && len === 12) info.coverOffset = data.readUInt32BE(0);
          else if (type === 202 && len === 12) info.thumbOffset = data.readUInt32BE(0);
          pos += len;
        }
      }
      if (!info.title) info.title = fullName || '';
    } else if (r0.length >= 32) {
      // 老式 PalmDOC：没有 MOBI header，只能靠文件名
      info.title = '';
    }

    // 封面：资源记录 index = firstResourceIndex + coverOffset
    for (const off of [info.coverOffset, info.thumbOffset]) {
      if (off == null || off < 0 || off > 0x7ffffffe) continue;
      const idx = info.firstResourceIndex + off;
      if (idx >= numRecords) continue;
      try {
        const start = recordStart(idx);
        const len = Math.min(recordEnd(idx) - start, 20 * 1024 * 1024);
        if (len <= 0) continue;
        const buf = readAt(fd, start, len);
        const sniff = sniffImage(buf);
        if (sniff && buf.length > 256) {
          info.cover = Buffer.from(buf);
          info.coverMime = sniff.mime;
          break;
        }
      } catch (_) { /* ignore */ }
    }
    return info;
  } finally {
    fs.closeSync(fd);
  }
}

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
    const info = readMobiProbe(filePath);
    return {
      format: FORMAT,
      title: info.title || titleFromFilename(filePath),
      author: info.author || '',
      language: info.language || guessLanguage(info.title || titleFromFilename(filePath)),
      cover: info.cover,
      coverMime: info.coverMime,
      pageCount: undefined,
    };
  } catch (_) {
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/* KindleUnpack / 组装                                                  */
/* ------------------------------------------------------------------ */

function findKindleUnpack() {
  const candidates = [
    path.join(PROJECT_ROOT, 'vendor', 'kindleunpack', 'kindleunpack', 'lib', 'kindleunpack.py'),
    path.join(PROJECT_ROOT, 'vendor', 'kindleunpack', 'lib', 'kindleunpack.py'),
    path.join(PROJECT_ROOT, 'vendor', 'kindleunpack', 'kindleunpack.py'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) { /* ignore */ }
  }
  return '';
}

function runKindleUnpack(srcFile, workDir) {
  const script = findKindleUnpack();
  if (!script) return { ok: false, error: '未找到 vendor/kindleunpack/lib/kindleunpack.py' };
  rmrf(workDir);
  ensureDir(workDir);
  const pyRes = runProcess('python', [script, '--epub_version=3', srcFile, workDir], { timeout: 120000 });
  return { ok: pyRes.ok, status: pyRes.status, error: pyRes.error ? String(pyRes.error.message || pyRes.error) : '' };
}

function findEpub(dir) {
  let hit = null;
  const files = walkFiles(dir, 4);
  // 优先顶层、名字含 content 的 epub
  const epubs = files.filter((f) => f.toLowerCase().endsWith('.epub') && existsNonEmpty(f));
  if (epubs.length) {
    hit = epubs.find((f) => /content/i.test(path.basename(f))) || epubs[0];
  }
  return hit;
}

function findUnpackedDir(dir) {
  // 找包含 content.opf（或 book.html）的目录，优先 mobi7/mobi8
  const files = walkFiles(dir, 4);
  const opfs = files.filter((f) => /content\.opf$/i.test(f));
  const htmls = files.filter((f) => /book\.html$/i.test(f) || /\.x?html?$/i.test(f));
  const dirs = [];
  for (const f of opfs.concat(htmls)) {
    const d = path.dirname(f);
    if (!dirs.includes(d)) dirs.push(d);
  }
  if (!dirs.length) return null;
  dirs.sort((a, b) => {
    const score = (d) => (/mobi7/i.test(d) ? 0 : /mobi8/i.test(d) ? 1 : 2);
    return score(a) - score(b);
  });
  return dirs[0];
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function mimeForFile(filePath) {
  const sniff = sniffImage(fs.readFileSync(filePath).subarray(0, 64));
  return sniff ? sniff.mime : mimeFromExt(path.extname(filePath).slice(1));
}

/* --------------------------- Python 组装路径 --------------------------- */

async function assembleWithPython(unpackedDir, workDir, outDir) {
  const stageDir = path.join(workDir, 'stage');
  const metaPath = path.join(workDir, 'mobi-meta.json');
  rmrf(stageDir);
  rmrf(metaPath);
  const res = runPythonTool('mobi_html.py', [unpackedDir, stageDir, metaPath], { timeout: 120000 });
  const meta = readJson(metaPath);
  if (!meta || !meta.ok) {
    throw new Error((meta && meta.error ? meta.error : 'mobi_html.py 执行失败') + '');
  }
  const title = (meta.title || '').trim() || titleFromFilename(unpackedDir);
  const builder = new EpubBuilder({
    title,
    author: meta.author || '',
    language: meta.language || guessLanguage(title),
    identifier: meta.identifier || undefined,
  });
  // 图片
  const imageByFile = new Map();
  for (const img of meta.images || []) {
    const p = path.join(stageDir, 'images', img.name);
    if (!existsNonEmpty(p)) continue;
    try {
      const buffer = fs.readFileSync(p);
      const href = builder.addImage({ name: img.name, buffer, mime: img.mime || mimeForFile(p) });
      imageByFile.set(img.name, href);
    } catch (_) { /* ignore */ }
  }
  if (meta.cover && imageByFile.has(meta.cover.name)) {
    builder.setCoverHref(imageByFile.get(meta.cover.name));
  } else if (meta.cover) {
    const p = path.join(stageDir, 'images', meta.cover.name);
    if (existsNonEmpty(p)) {
      try { builder.setCover(fs.readFileSync(p), meta.cover.mime || mimeForFile(p)); } catch (_) { /* ignore */ }
    }
  }
  // 章节
  const chapterHrefs = [];
  const chapterFallbackLabels = [];
  for (const ch of meta.chapters || []) {
    let body = '';
    try {
      body = fs.readFileSync(path.join(stageDir, ch.body), 'utf8');
    } catch (_) {
      body = '';
    }
    const label = ch.label || ('第' + (chapterHrefs.length + 1) + '节');
    // KindleUnpack 的 mobi7 HTML 自带章节标题段落，不再额外插入 heading，避免标题重复
    const href = builder.addChapter({ title: label, bodyHtml: body });
    chapterHrefs.push(href);
    chapterFallbackLabels.push(label);
  }
  if (!chapterHrefs.length) throw new Error('未切分出任何章节');
  // 目录
  const toc = [];
  for (const entry of meta.toc || []) {
    const idx = Math.max(0, Math.min(chapterHrefs.length - 1, Number(entry.chapter) || 0));
    let href = chapterHrefs[idx];
    if (entry.anchor) href += '#' + entry.anchor;
    toc.push({ label: entry.label || chapterFallbackLabels[idx], href, level: entry.level || 1 });
  }
  if (!toc.length) {
    toc.push({ label: title, href: chapterHrefs[0], level: 1 });
  }
  builder.setToc(toc);
  const outFile = path.join(outDir, 'book.epub');
  await builder.write(outFile);
  return { type: 'epub', file: outFile, toc, chapters: chapterHrefs.length, images: imageByFile.size };
}

/* ----------------------------- JS 兜底路径 ----------------------------- */

function readOpfSimple(opfPath) {
  const out = { title: '', author: '', language: '', coverHref: '', items: [] };
  let text = '';
  try { text = fs.readFileSync(opfPath, 'utf8'); } catch (_) { return out; }
  const pick = (tag) => {
    const m = text.match(new RegExp('<(?:dc:)?' + tag + '\\b[^>]*>([\\s\\S]*?)</(?:dc:)?' + tag + '>', 'i'));
    return m ? stripTags(decodeEntities(m[1])) : '';
  };
  out.title = pick('title');
  out.author = pick('creator');
  out.language = pick('language');
  const metaCover = text.match(/<meta\b[^>]*name\s*=\s*["']cover["'][^>]*content\s*=\s*["']([^"']+)["']/i);
  if (metaCover) out.coverHref = metaCover[1];
  const itemRe = /<item\b([^>]*)\/?>/gi;
  let m;
  while ((m = itemRe.exec(text))) {
    const attrs = m[1];
    const href = (attrs.match(/href\s*=\s*["']([^"']+)["']/i) || [])[1];
    const id = (attrs.match(/id\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (href) out.items.push({ href, id: id || '' });
  }
  return out;
}

async function assembleFallback(unpackedDir, outDir) {
  const opfPath = findFirst(unpackedDir, (f) => /content\.opf$/i.test(f), 4);
  const htmlPath = findFirst(unpackedDir, (f) => /book\.html$/i.test(f), 4) ||
    findFirst(unpackedDir, (f) => /\.x?html?$/i.test(f), 4);
  if (!htmlPath) throw new Error('找不到 mobi7 的 HTML 正文');
  const opf = opfPath ? readOpfSimple(opfPath) : { title: '', author: '', language: '', coverHref: '', items: [] };
  const title = opf.title || titleFromFilename(htmlPath);
  const raw = fs.readFileSync(htmlPath, 'utf8');
  const body = sanitizeHtmlFragment(extractBody(raw));
  const builder = new EpubBuilder({ title, author: opf.author, language: opf.language || guessLanguage(title) });
  // 图片
  const imgBase = new Map();
  const imgFiles = walkFiles(unpackedDir, 4).filter((f) => /\.(jpe?g|png|gif|bmp|webp|svg)$/i.test(f));
  for (const f of imgFiles) {
    const key = path.basename(f).toLowerCase();
    if (imgBase.has(key)) continue;
    try {
      const buffer = fs.readFileSync(f);
      const sniff = sniffImage(buffer);
      const href = builder.addImage({ name: path.basename(f), buffer, mime: sniff ? sniff.mime : mimeForFile(f) });
      imgBase.set(key, href);
    } catch (_) { /* ignore */ }
  }
  let bodyHtml = body.replace(/<img\b([^>]*?)\/?>/gi, (m, attrs) => {
    const srcM = String(attrs).match(/src\s*=\s*["']([^"']+)["']/i);
    if (!srcM) return '';
    const key = path.posix.basename(srcM[1].replace(/\\/g, '/')).toLowerCase();
    const href = imgBase.get(key);
    if (!href) return '';
    return '<img src="' + escapeXmlAttr(href.replace(/^images\//, '../images/')) + '"/>';
  });
  if (!/<h[1-6]\b/i.test(bodyHtml) && title) {
    bodyHtml = '<h1 class="chapter-title">' + escapeXmlText(title) + '</h1>\n' + bodyHtml;
  }
  const href = builder.addChapter({ title, bodyHtml });
  // 目录：从 NCX 里取锚点
  const toc = [];
  try {
    const ncxPath = findFirst(unpackedDir, (f) => /\.ncx$/i.test(f), 4);
    if (ncxPath) {
      const ncx = fs.readFileSync(ncxPath, 'utf8');
      const re = /<navPoint\b[\s\S]*?<navLabel>\s*<text>([\s\S]*?)<\/text>[\s\S]*?<content\b[^>]*src\s*=\s*["']([^"']+)["']/gi;
      let m;
      while ((m = re.exec(ncx))) {
        const label = stripTags(decodeEntities(m[1])) || title;
        const anchor = m[2].includes('#') ? m[2].split('#').pop() : '';
        toc.push({ label, href: href + (anchor ? '#' + anchor : ''), level: 1 });
      }
    }
  } catch (_) { /* ignore */ }
  if (!toc.length) toc.push({ label: title, href, level: 1 });
  builder.setToc(toc);
  if (opf.coverHref) {
    const coverBase = path.posix.basename(opf.coverHref.replace(/\\/g, '/')).toLowerCase();
    const coverFile = imgFiles.find((f) => path.basename(f).toLowerCase() === coverBase) || imgFiles.find((f) => /cover/i.test(f));
    if (coverFile) {
      const buffer = fs.readFileSync(coverFile);
      const sniff = sniffImage(buffer);
      builder.setCover(buffer, sniff ? sniff.mime : mimeForFile(coverFile));
    }
  }
  const outFile = path.join(outDir, 'book.epub');
  await builder.write(outFile);
  return { type: 'epub', file: outFile, toc, chapters: 1, degraded: true };
}

/* ------------------------------- prepare ------------------------------- */

async function prepare(filePath, outDir) {
  if (!existsNonEmpty(filePath)) throw new Error('文件不存在或为空：' + filePath);
  const workDir = path.join(outDir, 'work', 'mobi');
  rmrf(workDir);
  ensureDir(workDir);
  const unpackDir = path.join(workDir, 'kindle');
  const unpack = runKindleUnpack(filePath, unpackDir);
  const outFile = path.join(outDir, 'book.epub');
  rmrf(outFile);

  // 1) KindleUnpack 直接产出 epub
  const producedEpub = fs.existsSync(unpackDir) ? findEpub(unpackDir) : null;
  if (producedEpub) {
    try {
      const entries = readZipEntries(producedEpub);
      if (entries.length && findEntry(entries, 'META-INF/container.xml')) {
        fs.copyFileSync(producedEpub, outFile);
        return { type: 'epub', file: outFile, source: 'kindleunpack-epub' };
      }
    } catch (_) { /* 继续组装 */ }
  }

  const unpackedDir = fs.existsSync(unpackDir) ? findUnpackedDir(unpackDir) : null;
  if (!unpackedDir) {
    throw new Error('MOBI 转换失败：KindleUnpack 未产出可识别的文件' +
      (unpack.error ? '（' + unpack.error + '）' : '') + '。文件可能已加密（DRM）或格式不受支持。');
  }

  // 2) Python(lxml) 切章组装
  let pyError = null;
  try {
    return await assembleWithPython(unpackedDir, workDir, outDir);
  } catch (e) {
    pyError = e && e.message ? e.message : String(e);
  }

  // 3) JS 兜底：整本一章
  try {
    const res = await assembleFallback(unpackedDir, outDir);
    res.warning = '章节切分降级：' + (pyError || '');
    return res;
  } catch (e2) {
    throw new Error('MOBI 转换失败：' + (pyError || '') + '；兜底也失败：' + (e2 && e2.message ? e2.message : e2));
  }
}

module.exports = { FORMAT, probe, prepare, readMobiProbe, runKindleUnpack };
