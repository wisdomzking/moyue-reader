'use strict';
/**
 * formats/fb2.js — FictionBook 2（best-effort）。
 * 自带轻量 XML 解析器（不依赖第三方），把 <section> 递归转成 XHTML 章节；
 * <binary> 里的图片写入 EPUB images/；<coverpage> 作为封面；<title> 作为目录标签。
 */

const path = require('path');
const fs = require('fs');
const {
  titleFromFilename, guessLanguage, escapeXmlText, escapeXmlAttr, decodeEntities, stripTags,
  ensureDir, sanitizeHtmlFragment, sniffImage, extFromMime, mimeFromExt, decodeBuffer,
} = require('./util');
const { EpubBuilder } = require('./epub-build');

const XML_ENC_ALIASES = {
  'utf-8': 'utf-8', utf8: 'utf-8',
  'windows-1251': 'windows-1251', cp1251: 'windows-1251', 'win-1251': 'windows-1251',
  'koi8-r': 'koi8-r', 'windows-1252': 'windows-1252', 'iso-8859-1': 'windows-1252',
  'iso-8859-5': 'iso-8859-5', 'windows-1250': 'windows-1250',
  'utf-16': 'utf-16le', 'utf-16le': 'utf-16le', 'utf-16be': 'utf-16be',
  gbk: 'gbk', gb2312: 'gbk', big5: 'big5',
};

function readFb2Text(filePath, maxBytes) {
  const size = fs.statSync(filePath).size;
  const len = Math.min(size, maxBytes || size);
  const fd = fs.openSync(filePath, 'r');
  let buf;
  try {
    buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
  } finally {
    fs.closeSync(fd);
  }
  // 从 XML 声明里取编码
  const head = buf.subarray(0, Math.min(buf.length, 200)).toString('latin1');
  const m = head.match(/encoding\s*=\s*["']([^"']+)["']/i);
  let enc = m ? XML_ENC_ALIASES[m[1].toLowerCase()] || m[1].toLowerCase() : null;
  if (!enc) {
    // BOM 判断
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) enc = 'utf-16le';
    else if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) enc = 'utf-8';
    else enc = 'utf-8';
  }
  if (maxBytes && len < size) {
    // 头部截断处可能落在多字节字符中间，TextDecoder 会给出替换符，探测用可以接受
    return { text: decodeBuffer(buf, enc), encoding: enc, truncated: true };
  }
  return { text: decodeBuffer(buf, enc), encoding: enc, truncated: false };
}

/* ------------------------- 轻量 XML 树解析 ------------------------- */

function findTagEnd(xml, from) {
  let quote = null;
  for (let i = from; i < xml.length; i++) {
    const ch = xml[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

function parseAttrsText(text) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(text))) {
    attrs[m[1]] = decodeEntities(m[2] != null ? m[2] : m[3]);
  }
  return attrs;
}

function parseXmlTree(xml) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const pushText = (text) => {
    if (text) stack[stack.length - 1].children.push(text);
  };
  let i = 0;
  const len = xml.length;
  while (i < len) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) { pushText(xml.slice(i)); break; }
    if (lt > i) pushText(xml.slice(i, lt));
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      i = end < 0 ? len : end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      pushText(xml.slice(lt + 9, end < 0 ? len : end));
      i = end < 0 ? len : end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      i = end < 0 ? len : end + 2;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt + 2);
      i = end < 0 ? len : end + 1;
      continue;
    }
    const gt = findTagEnd(xml, lt + 1);
    if (gt < 0) { pushText(xml.slice(lt)); break; }
    const raw = xml.slice(lt + 1, gt).trim();
    if (raw[0] === '/') {
      const tag = raw.slice(1).trim().toLowerCase();
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].tag === tag) { stack.length = s; break; }
      }
    } else {
      const selfClose = raw.endsWith('/');
      const inner = selfClose ? raw.slice(0, -1) : raw;
      const nameMatch = inner.match(/^([a-zA-Z_][\w:.-]*)/);
      if (nameMatch) {
        const tag = nameMatch[1].toLowerCase();
        const node = { tag, attrs: parseAttrsText(inner.slice(nameMatch[0].length)), children: [] };
        stack[stack.length - 1].children.push(node);
        if (!selfClose) stack.push(node);
      }
    }
    i = gt + 1;
  }
  return root;
}

/* ------------------------------ 工具 ------------------------------ */

function childNodes(node, tag) {
  return (node.children || []).filter((c) => typeof c !== 'string' && c.tag === tag);
}

function firstChild(node, tag) {
  return (node.children || []).find((c) => typeof c !== 'string' && c.tag === tag) || null;
}

function textContent(node) {
  if (node == null) return '';
  if (typeof node === 'string') return decodeEntities(node);
  return (node.children || []).map(textContent).join('');
}

function findDeep(node, tag) {
  if (typeof node === 'string' || !node) return null;
  if (node.tag === tag) return node;
  for (const c of node.children || []) {
    const hit = findDeep(c, tag);
    if (hit) return hit;
  }
  return null;
}

/* ---------------------------- 元数据 ---------------------------- */

function parseFb2Meta(tree) {
  const fiction = findDeep(tree, 'fictionbook') || tree;
  const description = firstChild(fiction, 'description');
  const titleInfo = description ? firstChild(description, 'title-info') : null;
  const meta = { title: '', author: '', language: '', coverHref: '', annotation: '' };
  if (titleInfo) {
    meta.title = textContent(firstChild(titleInfo, 'book-title')).trim();
    meta.language = textContent(firstChild(titleInfo, 'lang')).trim().toLowerCase();
    const authorNode = firstChild(titleInfo, 'author');
    if (authorNode) {
      const parts = ['first-name', 'middle-name', 'last-name', 'nickname']
        .map((t) => textContent(firstChild(authorNode, t)).trim())
        .filter(Boolean);
      meta.author = parts.join(' ');
    }
    const coverpage = firstChild(titleInfo, 'coverpage');
    if (coverpage) {
      const img = firstChild(coverpage, 'image');
      if (img) meta.coverHref = img.attrs['l:href'] || img.attrs.href || '';
    }
    const annotation = firstChild(titleInfo, 'annotation');
    if (annotation) meta.annotation = textContent(annotation).trim();
  }
  return meta;
}

/* ---------------------------- 渲染 ---------------------------- */

function renderInline(node) {
  if (typeof node === 'string') return escapeXmlText(decodeEntities(node));
  if (!node) return '';
  const kids = () => (node.children || []).map(renderInline).join('');
  const attrsHref = node.attrs['l:href'] || node.attrs.href || '';
  switch (node.tag) {
    case 'p':
    case 'v':
      return kids();
    case 'emphasis': return '<em>' + kids() + '</em>';
    case 'strong': return '<strong>' + kids() + '</strong>';
    case 'strikethrough': return '<s>' + kids() + '</s>';
    case 'sub': return '<sub>' + kids() + '</sub>';
    case 'sup': return '<sup>' + kids() + '</sup>';
    case 'code': return '<code>' + kids() + '</code>';
    case 'a': {
      if (!attrsHref) return kids();
      return '<a href="' + escapeXmlAttr(attrsHref) + '">' + kids() + '</a>';
    }
    case 'image':
      return node.__imgHtml || '';
    case 'empty-line': return '<br/>';
    case 'title':
      return kids();
    case 'section':
      return kids();
    default:
      return kids();
  }
}

function renderBlocks(nodes, ctx) {
  return (nodes || []).map((node) => renderBlock(node, ctx)).filter(Boolean).join('\n');
}

function renderBlock(node, ctx) {
  if (typeof node === 'string') {
    const text = decodeEntities(node).replace(/\s+/g, ' ').trim();
    return text ? '<p>' + escapeXmlText(text) + '</p>' : '';
  }
  if (!node) return '';
  const children = () => renderBlocks(node.children, ctx);
  const inline = () => renderInline(node);
  switch (node.tag) {
    case 'p': return '<p>' + inline() + '</p>';
    case 'title': return '<h2 class="chapter-title">' + inline() + '</h2>';
    case 'subtitle': return '<h3>' + inline() + '</h3>';
    case 'empty-line': return '<br/>';
    case 'epigraph':
    case 'cite': return '<blockquote>' + children() + '</blockquote>';
    case 'text-author': return '<p class="text-author">' + inline() + '</p>';
    case 'poem': return '<div class="poem">' + children() + '</div>';
    case 'stanza': return '<div class="stanza">' + children() + '</div>';
    case 'v': return '<p class="v">' + inline() + '</p>';
    case 'annotation': return '<div class="annotation">' + children() + '</div>';
    case 'image': return renderInline(node);
    case 'table': return '<table>' + children() + '</table>';
    case 'tr': return '<tr>' + children() + '</tr>';
    case 'td': return '<td>' + children() + '</td>';
    case 'th': return '<th>' + children() + '</th>';
    case 'section':
      // 内嵌 section（理论上已被拆成独立章节，这里兜底渲染）
      return children();
    default:
      return children() || ('<p>' + inline() + '</p>');
  }
}

/** 收集所有 section（深度优先，父章节在前），返回章节列表 */
function collectSections(node, depth, ctx, out) {
  const sections = childNodes(node, 'section');
  for (const sec of sections) {
    const titleNode = firstChild(sec, 'title');
    const labelRaw = titleNode ? renderInline(titleNode) : '';
    const label = stripTags(labelRaw) || ('第' + (out.length + 1) + '节');
    const contentChildren = (sec.children || []).filter((c) => {
      if (typeof c === 'string') return !!decodeEntities(c).trim();
      if (c.tag === 'title' || c.tag === 'section') return false;
      return true;
    });
    // 图片节点需要提前处理（转成 img 标签）
    const bodyHtml = renderBlocks(contentChildren, ctx).trim();
    out.push({ label, depth, body: bodyHtml });
    collectSections(sec, depth + 1, ctx, out);
  }
}

/* ------------------------------ probe ------------------------------ */

async function probe(filePath) {
  const fallback = {
    format: 'FB2',
    title: titleFromFilename(filePath),
    author: '',
    language: 'zh',
    cover: null,
    coverMime: null,
  };
  try {
    const size = fs.statSync(filePath).size;
    const { text } = readFb2Text(filePath, size < 12 * 1024 * 1024 ? size : 512 * 1024);
    const tree = parseXmlTree(text);
    const meta = parseFb2Meta(tree);
    const result = {
      ...fallback,
      title: meta.title || fallback.title,
      author: meta.author || '',
      language: meta.language || guessLanguage(meta.title || fallback.title),
    };
    // 封面：需要 binary 数据，文件不大时才解析（probe 要轻量）
    if (meta.coverHref && size < 12 * 1024 * 1024) {
      const bin = findBinary(tree, meta.coverHref);
      if (bin) {
        const sniff = sniffImage(bin.buffer);
        result.cover = bin.buffer;
        result.coverMime = sniff ? sniff.mime : (bin.mime || 'image/jpeg');
      }
    }
    return result;
  } catch (_) {
    return fallback;
  }
}

function findBinary(tree, href) {
  const id = String(href || '').replace(/^#/, '');
  if (!id) return null;
  const bins = [];
  (function walk(node) {
    if (typeof node === 'string') return;
    if (node.tag === 'binary') bins.push(node);
    else for (const c of node.children || []) walk(c);
  })(tree);
  const hit = bins.find((b) => (b.attrs.id || '') === id);
  if (!hit) return null;
  const b64 = (hit.children || []).filter((c) => typeof c === 'string').map((s) => s.trim()).join('');
  try {
    return { buffer: Buffer.from(b64, 'base64'), mime: hit.attrs['content-type'] || '' };
  } catch (_) {
    return null;
  }
}

/* ----------------------------- prepare ----------------------------- */

async function prepare(filePath, outDir) {
  const { text } = readFb2Text(filePath);
  if (!text || !text.trim()) throw new Error('FB2 文件内容为空');
  const tree = parseXmlTree(text);
  const meta = parseFb2Meta(tree);
  const fiction = findDeep(tree, 'fictionbook') || tree;
  const bodies = childNodes(fiction, 'body');
  const mainBody = bodies.find((b) => !b.attrs.name) || bodies[0];
  if (!mainBody) throw new Error('FB2 缺少 <body> 正文');
  const title = meta.title || titleFromFilename(filePath);
  const language = meta.language || guessLanguage(title + ' ' + meta.annotation);
  ensureDir(outDir);
  const builder = new EpubBuilder({ title, author: meta.author, language });

  // 图片注册（延迟：只在引用时加入）
  const imageHrefCache = new Map();
  const binCache = new Map();
  const registerImage = (href) => {
    const key = String(href || '').replace(/^#/, '');
    if (imageHrefCache.has(key)) return imageHrefCache.get(key);
    let bin = binCache.get(key);
    if (!bin) {
      bin = findBinary(tree, key);
      if (bin) binCache.set(key, bin);
    }
    if (!bin || !bin.buffer || !bin.buffer.length) return null;
    const sniff = sniffImage(bin.buffer);
    const mime = sniff ? sniff.mime : (bin.mime || 'image/jpeg');
    const ext = sniff ? sniff.ext : extFromMime(mime);
    const epath = builder.addImage({ name: 'fb2-' + key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) + '.' + ext, buffer: bin.buffer, mime });
    imageHrefCache.set(key, epath);
    return epath;
  };

  // 给 image 节点生成内联 HTML（在渲染前遍历一遍）
  (function walkImages(node) {
    if (typeof node === 'string') return;
    if (node.tag === 'image') {
      const href = node.attrs['l:href'] || node.attrs.href || '';
      if (href && href.startsWith('#')) {
        const epath = registerImage(href);
        if (epath) {
          const alt = node.attrs.alt ? ' alt="' + escapeXmlAttr(node.attrs.alt) + '"' : '';
          node.__imgHtml = '<img src="' + escapeXmlAttr(epath.replace(/^images\//, '../images/')) + '"' + alt + '/>';
        }
      }
    }
    for (const c of node.children || []) walkImages(c);
  })(mainBody);

  // 封面（优先复用已注册的图片，避免重复打包）
  if (meta.coverHref) {
    const registered = registerImage(meta.coverHref);
    if (registered) {
      builder.setCoverHref(registered);
    } else {
      const coverBin = findBinary(tree, meta.coverHref);
      if (coverBin) {
        const sniff = sniffImage(coverBin.buffer);
        builder.setCover(coverBin.buffer, sniff ? sniff.mime : (coverBin.mime || 'image/jpeg'));
      }
    }
  }

  const chapters = [];
  if (childNodes(mainBody, 'section').length) {
    collectSections(mainBody, 1, { builder, registerImage }, chapters);
  } else {
    const bodyChildren = (mainBody.children || []).filter((c) => typeof c !== 'string' || decodeEntities(c).trim());
    chapters.push({ label: title, depth: 1, body: renderBlocks(bodyChildren, { builder, registerImage }) });
  }
  if (!chapters.length) throw new Error('FB2 中没有可显示的章节');

  const toc = [];
  let i = 0;
  for (const ch of chapters) {
    i++;
    const heading = '<h2 class="chapter-title">' + escapeXmlText(ch.label) + '</h2>\n';
    const body = heading + (ch.body || '');
    const href = builder.addChapter({ title: ch.label, bodyHtml: body });
    toc.push({ label: ch.label, href, level: Math.min(3, ch.depth) });
  }
  builder.setToc(toc);
  const outFile = path.join(outDir, 'book.epub');
  await builder.write(outFile);
  return { type: 'epub', file: outFile, toc, chapters: toc.length };
}

module.exports = { FORMAT: 'FB2', probe, prepare, parseXmlTree, parseFb2Meta, readFb2Text };
