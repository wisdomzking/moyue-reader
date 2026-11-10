'use strict';
/**
 * formats/epub-build.js — EPUB3 生成器。
 *
 * 产物结构（严格按 SPEC §7）：
 *   mimetype                    （第一条、不压缩、内容 application/epub+zip）
 *   META-INF/container.xml
 *   OEBPS/content.opf           （EPUB3 package，manifest 全量、spine 顺序、nav properties）
 *   OEBPS/nav.xhtml             （嵌套 <ol>）
 *   OEBPS/toc.ncx               （兼容老阅读器，可嵌套）
 *   OEBPS/style.css
 *   OEBPS/text/*.xhtml          （UTF-8 章节）
 *   OEBPS/images/*              （相对路径引用）
 */

const path = require('path');
const JSZip = require('jszip');
const { escapeXmlText, escapeXmlAttr, uuid, nowIso, ensureDir, writeFileAtomic, mimeFromExt } = require('./util');

const STYLE_CSS = `/* 墨阅生成 EPUB 的基础排版；阅读器会再叠加主题与用户设置 */
html, body { margin: 0; padding: 0; }
body {
  font-family: "Songti SC", "SimSun", Georgia, serif;
  line-height: 1.8;
  color: #25221d;
  padding: 0 0.6em;
  word-wrap: break-word;
  overflow-wrap: break-word;
}
p { margin: 0 0 0.85em; text-indent: 2em; }
h1, h2, h3, h4, h5, h6 {
  text-indent: 0;
  font-weight: 600;
  line-height: 1.4;
  margin: 1.4em 0 0.7em;
}
h1 { font-size: 1.65em; text-align: center; margin: 1.8em 0 1.1em; }
h2 { font-size: 1.32em; }
h3 { font-size: 1.15em; }
blockquote { margin: 1.1em 2em; color: #55514a; text-indent: 0; }
blockquote p { text-indent: 0; }
img { max-width: 100%; height: auto; }
a { color: #2f6f64; text-decoration: none; }
hr { border: none; border-top: 1px solid #d8d0c2; margin: 1.8em 0; }
table { border-collapse: collapse; max-width: 100%; margin: 1em 0; font-size: 0.94em; }
td, th { border: 1px solid #cfc6b6; padding: 0.3em 0.55em; vertical-align: top; }
td p { text-indent: 0; margin: 0.15em 0; }
pre { white-space: pre-wrap; font-size: 0.9em; background: #f4f1ea; padding: 0.8em; }
code, tt { font-family: Consolas, "Courier New", monospace; }
.center { text-align: center; }
img.cover { max-width: 100%; }
.chapter-title { text-align: center; }
`;

function xhtmlDoc({ title, lang, body, extraHead }) {
  const langAttr = escapeXmlAttr(lang || 'zh');
  return '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<!DOCTYPE html>\n' +
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="' + langAttr + '" xml:lang="' + langAttr + '">\n' +
    '<head>\n' +
    '<meta charset="utf-8"/>\n' +
    '<title>' + escapeXmlText(title || '') + '</title>\n' +
    '<link rel="stylesheet" type="text/css" href="../style.css"/>\n' +
    (extraHead || '') +
    '</head>\n' +
    '<body>\n' + (body || '') + '\n</body>\n</html>\n';
}

/** 把 [{level,label,href}] 转成树 */
function tocToTree(entries) {
  const root = [];
  const stack = [{ level: 0, children: root }];
  for (const e of entries || []) {
    const level = Math.max(1, Math.min(6, Number(e.level) || 1));
    while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
    const node = { label: e.label || '未命名', href: e.href || '', level, children: [] };
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return root;
}

function renderNavOl(nodes, indent) {
  const pad = '  '.repeat(indent);
  let out = pad + '<ol>\n';
  for (const n of nodes) {
    out += pad + '  <li><a href="' + escapeXmlAttr(n.href) + '">' + escapeXmlText(n.label) + '</a>';
    if (n.children && n.children.length) {
      out += '\n' + renderNavOl(n.children, indent + 2) + pad + '  ';
    }
    out += '</li>\n';
  }
  out += pad + '</ol>\n';
  return out;
}

function renderNcxNav(nodes, counter, indent) {
  const pad = '  '.repeat(indent);
  let out = '';
  for (const n of nodes) {
    counter.n++;
    out += pad + '<navPoint id="navPoint-' + counter.n + '" playOrder="' + counter.n + '">\n';
    out += pad + '  <navLabel><text>' + escapeXmlText(n.label) + '</text></navLabel>\n';
    out += pad + '  <content src="' + escapeXmlAttr(n.href) + '"/>\n';
    if (n.children && n.children.length) {
      out += renderNcxNav(n.children, counter, indent + 1);
    }
    out += pad + '</navPoint>\n';
  }
  return out;
}

class EpubBuilder {
  constructor(meta) {
    const m = meta || {};
    this.title = (m.title || '').trim() || '未命名';
    this.author = (m.author || '').trim() || '';
    this.language = (m.language || '').trim() || 'zh';
    this.identifier = m.identifier || ('urn:uuid:' + uuid());
    this.chapters = [];
    this.images = [];
    this.toc = null;
    this.coverImageHref = null;
    this.extraManifest = [];
    this.css = m.css || STYLE_CSS;
    this._imageNames = new Set();
  }

  /** 新增章节，返回 manifest 里的 href（相对 OEBPS） */
  addChapter(opts) {
    const o = opts || {};
    const n = this.chapters.length + 1;
    const id = (o.id || ('ch' + String(n).padStart(3, '0'))).replace(/[^a-zA-Z0-9_.-]/g, '');
    const href = o.href || ('text/' + id + '.xhtml');
    const chapter = {
      id,
      href,
      title: o.title || ('第' + n + '章'),
      body: o.bodyHtml || '',
      css: o.css || '',
      language: o.language || this.language,
    };
    this.chapters.push(chapter);
    return href;
  }

  get lastChapterHref() {
    const c = this.chapters[this.chapters.length - 1];
    return c ? c.href : '';
  }

  /** 新增图片，返回 href（相对 OEBPS，如 images/img1.png） */
  addImage(opts) {
    const o = opts || {};
    let name = String(o.name || ('img' + (this.images.length + 1) + '.' + (o.ext || 'bin'))).replace(/[\\/]/g, '_');
    name = name.replace(/[^a-zA-Z0-9_.-]/g, '_');
    let candidate = name;
    let i = 2;
    while (this._imageNames.has(candidate.toLowerCase())) {
      const ext = path.extname(name);
      candidate = path.basename(name, ext) + '_' + i++ + ext;
    }
    this._imageNames.add(candidate.toLowerCase());
    const href = 'images/' + candidate;
    this.images.push({
      id: 'img_' + (this.images.length + 1),
      href,
      name: candidate,
      buffer: o.buffer,
      mime: o.mime || mimeFromExt(path.extname(candidate).slice(1)),
    });
    if (o.cover) this.coverImageHref = href;
    return href;
  }

  /** 添加封面（EPUB3 properties="cover-image"） */
  setCover(buffer, mime, name) {
    if (!buffer || !buffer.length) return null;
    const ext = (mime || '').split('/')[1] || 'jpg';
    return this.addImage({ name: name || ('cover.' + ext.replace('jpeg', 'jpg')), buffer, mime: mime || 'image/jpeg', cover: true });
  }

  /** 把已经加进 images 的某张图标记为封面（避免同一张图重复打包） */
  setCoverHref(href) {
    if (!href) return null;
    if (!this.images.some((img) => img.href === href)) return null;
    this.coverImageHref = href;
    return href;
  }

  /** 设置目录项：[{label, href, level}]；不设置时用章节本身生成一级目录 */
  setToc(entries) {
    this.toc = (entries || []).filter((e) => e && e.href);
  }

  addManifestItem(item) {
    this.extraManifest.push(item);
  }

  _tocEntries() {
    if (this.toc && this.toc.length) return this.toc;
    return this.chapters.map((c) => ({ label: c.title, href: c.href, level: 1 }));
  }

  _buildOpf(tocTree) {
    const manifest = [];
    manifest.push('    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');
    manifest.push('    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>');
    manifest.push('    <item id="style" href="style.css" media-type="text/css"/>');
    for (const c of this.chapters) {
      manifest.push('    <item id="' + c.id + '" href="' + escapeXmlAttr(c.href) + '" media-type="application/xhtml+xml"/>');
    }
    for (const img of this.images) {
      const props = img.href === this.coverImageHref ? ' properties="cover-image"' : '';
      manifest.push('    <item id="' + img.id + '" href="' + escapeXmlAttr(img.href) + '" media-type="' + escapeXmlAttr(img.mime) + '"' + props + '/>');
    }
    for (const it of this.extraManifest) {
      manifest.push('    <item id="' + escapeXmlAttr(it.id) + '" href="' + escapeXmlAttr(it.href) + '" media-type="' + escapeXmlAttr(it.mime) + '"/>');
    }
    const spine = this.chapters.map((c) => '    <itemref idref="' + c.id + '"/>').join('\n');
    const metaCover = this.coverImageHref
      ? '    <meta name="cover" content="' + this.images.filter((i) => i.href === this.coverImageHref)[0].id + '"/>\n'
      : '';
    return '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="' + escapeXmlAttr(this.language) + '">\n' +
      '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
      '    <dc:identifier id="bookid">' + escapeXmlText(this.identifier) + '</dc:identifier>\n' +
      '    <dc:title>' + escapeXmlText(this.title) + '</dc:title>\n' +
      (this.author ? '    <dc:creator id="creator">' + escapeXmlText(this.author) + '</dc:creator>\n' : '') +
      '    <dc:language>' + escapeXmlText(this.language) + '</dc:language>\n' +
      '    <meta property="dcterms:modified">' + nowIso() + '</meta>\n' +
      metaCover +
      '  </metadata>\n' +
      '  <manifest>\n' + manifest.join('\n') + '\n  </manifest>\n' +
      '  <spine toc="ncx">\n' + spine + '\n  </spine>\n' +
      '</package>\n';
  }

  _buildNav(tocTree) {
    return '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<!DOCTYPE html>\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="' + escapeXmlAttr(this.language) + '" xml:lang="' + escapeXmlAttr(this.language) + '">\n' +
      '<head><meta charset="utf-8"/><title>目录</title><link rel="stylesheet" type="text/css" href="style.css"/></head>\n' +
      '<body>\n' +
      '<nav epub:type="toc" id="toc">\n' +
      '<h1 class="chapter-title">目录</h1>\n' +
      renderNavOl(tocTree, 0) +
      '</nav>\n' +
      '<nav epub:type="landmarks" id="landmarks" hidden="hidden">\n' +
      '  <ol>\n' +
      '    <li><a epub:type="bodymatter" href="' + escapeXmlAttr(this.chapters[0] ? this.chapters[0].href : 'text/ch001.xhtml') + '">正文</a></li>\n' +
      '  </ol>\n' +
      '</nav>\n' +
      '</body>\n</html>\n';
  }

  _buildNcx(tocTree) {
    const counter = { n: 0 };
    return '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="' + escapeXmlAttr(this.language) + '">\n' +
      '<head>\n' +
      '  <meta name="dtb:uid" content="' + escapeXmlAttr(this.identifier) + '"/>\n' +
      '  <meta name="dtb:depth" content="3"/>\n' +
      '  <meta name="dtb:totalPageCount" content="0"/>\n' +
      '  <meta name="dtb:maxPageNumber" content="0"/>\n' +
      '</head>\n' +
      '<docTitle><text>' + escapeXmlText(this.title) + '</text></docTitle>\n' +
      (this.author ? '<docAuthor><text>' + escapeXmlText(this.author) + '</text></docAuthor>\n' : '') +
      '<navMap>\n' + renderNcxNav(tocTree, counter, 0) + '</navMap>\n' +
      '</ncx>\n';
  }

  /** 生成 EPUB 文件（覆盖写），返回 {file, size, chapters, toc} */
  async write(outPath) {
    if (!this.chapters.length) {
      this.addChapter({ title: this.title, bodyHtml: '<p>' + escapeXmlText(this.title) + '</p>' });
    }
    const tocTree = tocToTree(this._tocEntries());
    const zip = new JSZip();
    // mimetype 必须是第一条且 STORE 压缩
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    zip.file('META-INF/container.xml',
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n' +
      '  <rootfiles>\n' +
      '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n' +
      '  </rootfiles>\n' +
      '</container>\n');
    zip.file('OEBPS/content.opf', this._buildOpf(tocTree));
    zip.file('OEBPS/nav.xhtml', this._buildNav(tocTree));
    zip.file('OEBPS/toc.ncx', this._buildNcx(tocTree));
    zip.file('OEBPS/style.css', this.css);
    for (const c of this.chapters) {
      const body = (c.body || '') + (c.css ? '\n<style type="text/css">' + c.css + '</style>' : '');
      zip.file('OEBPS/' + c.href, xhtmlDoc({ title: c.title, lang: c.language, body }));
    }
    for (const img of this.images) {
      if (!img.buffer || !img.buffer.length) continue;
      zip.file('OEBPS/' + img.href, img.buffer, { binary: true });
    }
    const buffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
      platform: 'UNIX',
      mimeType: 'application/epub+zip',
    });
    ensureDir(path.dirname(outPath));
    writeFileAtomic(outPath, buffer);
    return {
      file: outPath,
      size: buffer.length,
      chapters: this.chapters.length,
      images: this.images.length,
      toc: this._tocEntries().length,
    };
  }
}

module.exports = { EpubBuilder, STYLE_CSS, xhtmlDoc, tocToTree };
