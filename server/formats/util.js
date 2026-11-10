'use strict';
/**
 * formats/util.js — 通用工具：XML/HTML 转义、实体解码、编码探测、外部进程、文件系统。
 * 注意：本机 Node child_process 管道 stdio 会 EPERM，外部进程统一 spawnSync(..., {stdio:'ignore'})。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const CACHE_ROOT = path.join(PROJECT_ROOT, '.cache');
const SCRATCH_DIR = path.join(CACHE_ROOT, 'tmp');

/* ------------------------------------------------------------------ */
/* 文本 / XML 转义                                                     */
/* ------------------------------------------------------------------ */

function escapeXmlText(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXmlAttr(s) {
  return escapeXmlText(s).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', zwnj: '\u200c', zwj: '\u200d',
  ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', middot: '\u00b7',
  lsquo: '\u2018', rsquo: '\u2019', sbquo: '\u201a', ldquo: '\u201c', rdquo: '\u201d', bdquo: '\u201e',
  laquo: '\u00ab', raquo: '\u00bb', lsaquo: '\u2039', rsaquo: '\u203a',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', deg: '\u00b0', plusmn: '\u00b1',
  times: '\u00d7', divide: '\u00f7', frac12: '\u00bd', frac14: '\u00bc', frac34: '\u00be',
  sect: '\u00a7', para: '\u00b6', dagger: '\u2020', Dagger: '\u2021', bull: '\u2022',
  prime: '\u2032', Prime: '\u2033', permil: '\u2030', euro: '\u20ac', pound: '\u00a3',
  yen: '\u00a5', cent: '\u00a2', shy: '\u00ad', sup1: '\u00b9', sup2: '\u00b2', sup3: '\u00b3',
  micro: '\u00b5', alpha: '\u03b1', beta: '\u03b2', gamma: '\u03b3', delta: '\u03b4',
  epsilon: '\u03b5', zeta: '\u03b6', eta: '\u03b7', theta: '\u03b8', iota: '\u03b9',
  kappa: '\u03ba', lambda: '\u03bb', mu: '\u03bc', nu: '\u03bd', xi: '\u03be',
  omicron: '\u03bf', pi: '\u03c0', rho: '\u03c1', sigma: '\u03c3', tau: '\u03c4',
  upsilon: '\u03c5', phi: '\u03c6', chi: '\u03c7', psi: '\u03c8', omega: '\u03c9',
  Agrave: '\u00c0', Aacute: '\u00c1', Acirc: '\u00c2', Atilde: '\u00c3', Auml: '\u00c4',
  Aring: '\u00c5', AElig: '\u00c6', Ccedil: '\u00c7', Egrave: '\u00c8', Eacute: '\u00c9',
  Ecirc: '\u00ca', Euml: '\u00cb', Igrave: '\u00cc', Iacute: '\u00cd', Icirc: '\u00ce',
  Iuml: '\u00cf', Ntilde: '\u00d1', Ograve: '\u00d2', Oacute: '\u00d3', Ocirc: '\u00d4',
  Otilde: '\u00d5', Ouml: '\u00d6', Oslash: '\u00d8', Ugrave: '\u00d9', Uacute: '\u00da',
  Ucirc: '\u00db', Uuml: '\u00dc', Yacute: '\u00dd', szlig: '\u00df', agrave: '\u00e0',
  aacute: '\u00e1', acirc: '\u00e2', atilde: '\u00e3', auml: '\u00e4', aring: '\u00e5',
  aelig: '\u00e6', ccedil: '\u00e7', egrave: '\u00e8', eacute: '\u00e9', ecirc: '\u00ea',
  euml: '\u00eb', igrave: '\u00ec', iacute: '\u00ed', icirc: '\u00ee', iuml: '\u00ef',
  ntilde: '\u00f1', ograve: '\u00f2', oacute: '\u00f3', ocirc: '\u00f4', otilde: '\u00f5',
  ouml: '\u00f6', oslash: '\u00f8', ugrave: '\u00f9', uacute: '\u00fa', ucirc: '\u00fb',
  uuml: '\u00fc', yacute: '\u00fd', yuml: '\u00ff',
};

function decodeEntities(input) {
  return String(input == null ? '' : input).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch (_) { return m; }
      }
      return m;
    }
    const v = NAMED_ENTITIES[body];
    return v == null ? m : v;
  });
}

/** 把任意 HTML 片段变成「XML 安全」的实体写法：命名实体→数字实体，裸 & → &amp; */
function normalizeEntities(input) {
  return String(input == null ? '' : input)
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
      if (body[0] === '#') return m;
      if (body === 'amp' || body === 'lt' || body === 'gt' || body === 'quot' || body === 'apos') return m;
      const v = NAMED_ENTITIES[body];
      if (v == null) return '&amp;' + body + ';'; // 未知命名实体：退化成普通文本，保证 XML 合法
      return '&#' + v.codePointAt(0) + ';';
    })
    .replace(/&(?!(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);)/g, '&amp;');
}

/** 去掉 HTML 标签，返回纯文本（用于目录标签、标题判定） */
function stripTags(html) {
  return decodeEntities(String(html == null ? '' : html)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|blockquote)>/gi, ' ')
    .replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function collapseWhitespace(s) {
  return String(s == null ? '' : s).replace(/[\t\f\v ]+/g, ' ').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n');
}

/* ------------------------------------------------------------------ */
/* 编码探测                                                            */
/* ------------------------------------------------------------------ */

function sniffBom(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le';
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be';
  // BOM-less UTF-16 启发：ASCII 区文本的高字节为 0
  if (buf.length >= 16) {
    const n = Math.min(buf.length, 4096);
    let evenZero = 0;
    let oddZero = 0;
    let pairs = 0;
    for (let i = 0; i + 1 < n; i += 2) {
      pairs++;
      if (buf[i] === 0) evenZero++;
      if (buf[i + 1] === 0) oddZero++;
    }
    if (pairs > 8) {
      if (oddZero / pairs > 0.6 && evenZero / pairs < 0.1) return 'utf-16le';
      if (evenZero / pairs > 0.6 && oddZero / pairs < 0.1) return 'utf-16be';
    }
  }
  return null;
}

function isValidUtf8(buf) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 探测文本编码。
 * 顺序：UTF-8 BOM → UTF-16 BOM/启发 → UTF-8 严格校验 → GBK
 */
function detectEncoding(buf) {
  if (!buf || buf.length === 0) return 'utf-8';
  const bom = sniffBom(buf);
  if (bom) return bom;
  const probe = buf.length > 512 * 1024 ? buf.subarray(0, 512 * 1024) : buf;
  if (isValidUtf8(probe)) return 'utf-8';
  return 'gbk';
}

function decodeBuffer(buf, encoding) {
  if (!buf || buf.length === 0) return '';
  let enc = encoding || detectEncoding(buf);
  let data = buf;
  if (enc === 'utf-8' && data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    data = data.subarray(3);
  } else if (enc === 'utf-16le') {
    if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) data = data.subarray(2);
  } else if (enc === 'utf-16be') {
    if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) data = data.subarray(2);
    const swapped = Buffer.alloc(data.length - (data.length % 2));
    for (let i = 0; i + 1 < data.length; i += 2) {
      swapped[i] = data[i + 1];
      swapped[i + 1] = data[i];
    }
    data = swapped;
    enc = 'utf-16le';
  }
  try {
    return new TextDecoder(enc).decode(data).replace(/^\uFEFF/, '');
  } catch (_) {
    return data.toString('utf8').replace(/^\uFEFF/, '');
  }
}

/** 读取整文件并自动解码 */
function readTextAuto(filePath) {
  const buf = fs.readFileSync(filePath);
  const encoding = detectEncoding(buf);
  return { text: decodeBuffer(buf, encoding), encoding, size: buf.length };
}

/** 只读文件头部用于轻量探测（UTF-8 截断处可能产生替换符，探测足够） */
function readTextHead(filePath, maxBytes) {
  const size = fs.statSync(filePath).size;
  const len = Math.min(size, maxBytes || 64 * 1024);
  const fd = fs.openSync(filePath, 'r');
  let buf;
  try {
    buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
  } finally {
    fs.closeSync(fd);
  }
  const encoding = detectEncoding(buf);
  return { text: decodeBuffer(buf, encoding), encoding, size };
}

/** 粗略语言猜测：CJK→zh，西里尔→ru，其它→en */
function guessLanguage(text) {
  const sample = String(text || '').slice(0, 20000);
  if (!sample) return 'zh';
  let cjk = 0;
  let cyr = 0;
  let latin = 0;
  for (const ch of sample) {
    const c = ch.codePointAt(0);
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)) cjk++;
    else if (c >= 0x0400 && c <= 0x04ff) cyr++;
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) latin++;
  }
  const total = cjk + cyr + latin;
  if (!total) return 'zh';
  if (cjk / total > 0.15) return 'zh';
  if (cyr / total > 0.15) return 'ru';
  return 'en';
}

/* ------------------------------------------------------------------ */
/* 文件系统                                                            */
/* ------------------------------------------------------------------ */

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ensureScratch() {
  ensureDir(SCRATCH_DIR);
  return SCRATCH_DIR;
}

function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (_) { /* ignore */ }
}

function fileSize(filePath) {
  try { return fs.statSync(filePath).size; } catch (_) { return -1; }
}

function existsNonEmpty(filePath) {
  try { return fs.statSync(filePath).isFile() && fs.statSync(filePath).size > 0; } catch (_) { return false; }
}

function walkFiles(dir, maxDepth) {
  const out = [];
  const limit = maxDepth == null ? 6 : maxDepth;
  function walk(d, depth) {
    let items;
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) {
        if (depth < limit && it.name !== '__MACOSX') walk(p, depth + 1);
      } else if (it.isFile()) {
        out.push(p);
      }
    }
  }
  walk(dir, 0);
  return out;
}

/** 递归找第一个满足条件的文件，找不到返回 null */
function findFirst(dir, predicate, maxDepth) {
  const files = walkFiles(dir, maxDepth);
  for (const f of files) {
    if (predicate(f, path.basename(f))) return f;
  }
  return null;
}

function writeFileAtomic(target, data) {
  ensureDir(path.dirname(target));
  const tmp = target + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, data);
  try { fs.renameSync(tmp, target); } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    fs.writeFileSync(target, data);
  }
}

function uniqueTempPath(prefix, ext) {
  ensureScratch();
  return path.join(SCRATCH_DIR, (prefix || 'tmp') + '-' + process.pid + '-' + Math.random().toString(36).slice(2, 8) + (ext || ''));
}

function baseNameNoExt(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

/** 从文件名得到书名：去掉常见后缀噪声，保留下划线/连字符不拆分 */
function titleFromFilename(filePath) {
  let name = baseNameNoExt(filePath || '');
  name = name.replace(/[.](?=\s*$)/, '');
  name = name.replace(/[_]+/g, ' ');
  name = name.replace(/\s*-\s*副本$/, '');
  const m = name.match(/《([^》]+)》/);
  if (m) name = m[1];
  name = name.replace(/[（(](高清|精校|全本|完结|校对版|文字版|epub|pdf|mobi|azw3?|txt)[)）]/gi, '');
  return name.trim() || baseNameNoExt(filePath || '') || '未命名';
}

/* ------------------------------------------------------------------ */
/* 外部进程（沙箱安全：stdio 全部 ignore）                              */
/* ------------------------------------------------------------------ */

function runProcess(cmd, args, options) {
  const opts = options || {};
  const res = spawnSync(cmd, args || [], {
    stdio: 'ignore',
    windowsHide: true,
    timeout: opts.timeout == null ? 60000 : opts.timeout,
    cwd: opts.cwd || PROJECT_ROOT,
    env: opts.env || process.env,
    maxBuffer: 1024 * 1024,
  });
  return {
    ok: !res.error && res.status === 0,
    status: res.status,
    signal: res.signal || null,
    error: res.error || null,
  };
}

/** python 辅助脚本路径（server/formats/tools/*.py） */
function toolScript(name) {
  return path.join(__dirname, 'tools', name);
}

/**
 * 运行 python 辅助脚本：python <script> <args...>，结果通过输出文件读取。
 * 返回 { ok, status, error }，不抛错。
 */
function runPythonTool(scriptName, args, options) {
  const py = (options && options.python) || 'python';
  const res = runProcess(py, [toolScript(scriptName)].concat(args || []), options || {});
  return res;
}

/* ------------------------------------------------------------------ */
/* HTML → XHTML 片段（JS 兜底清洗，高质量路径在 Python/lxml）            */
/* ------------------------------------------------------------------ */

const DROP_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea', 'frame', 'frameset', 'applet', 'noscript'];

function sanitizeHtmlFragment(input) {
  let s = String(input == null ? '' : input);
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<\?[\s\S]*?\?>/g, '');
  s = s.replace(/<!DOCTYPE[^>]*>/gi, '');
  for (const tag of DROP_TAGS) {
    const pair = new RegExp('<' + tag + '\\b[^>]*>[\\s\\S]*?<\\/' + tag + '\\s*>', 'gi');
    s = s.replace(pair, '');
    const single = new RegExp('<' + tag + '\\b[^>]*\\/?>', 'gi');
    s = s.replace(single, '');
  }
  // KindleUnpack 的 <mbp:*> 标签、未知命名空间标签
  s = s.replace(/<\/?(?:mbp|opf|ncx|dc|svg):[^>]*>/gi, '');
  // 事件属性
  s = s.replace(/\son[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/g, '');
  // 未加引号的属性值补引号（如 <font size=4>）
  s = s.replace(/(\s[a-zA-Z_:][-a-zA-Z0-9_:.]*\s*=\s*)(?!"|')([^\s>]+)/g, (m, pre, val) => pre + '"' + val + '"');
  // 空元素自闭合
  s = s.replace(/<(br|hr|img|wbr|area|col|source|track|embed|input|meta|link)\b([^>]*?)\/?>/gi, (m, tag, attrs) => {
    const clean = String(attrs || '').replace(/\/\s*$/, '');
    return '<' + tag + clean + '/>';
  });
  s = s.replace(/<\/(br|hr|img|wbr|area|col|source|track|embed|input|meta|link)\s*>/gi, '');
  // 实体
  s = normalizeEntities(s);
  // 顶层块级容器闭合修复：忽略（浏览器 DOMParser 对未闭合标签报错——这里做简单平衡）
  s = balanceTags(s);
  return s;
}

const VOID_TAGS = new Set(['br', 'hr', 'img', 'wbr', 'area', 'col', 'source', 'track', 'embed', 'input', 'meta', 'link']);
const BLOCK_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'blockquote', 'pre', 'section', 'article', 'aside',
  'figure', 'figcaption', 'header', 'footer', 'nav', 'main', 'address', 'hr', 'br', 'span', 'a', 'em',
  'strong', 'b', 'i', 'u', 's', 'strike', 'sub', 'sup', 'code', 'tt', 'small', 'big', 'font', 'center',
  'cite', 'q', 'abbr', 'acronym', 'dfn', 'kbd', 'mark', 'ruby', 'rt', 'rp', 'time', 'var', 'samp', 'ins', 'del']);

/** 简单标签平衡：补齐/丢弃未闭合或缺开头标签（对 KindleUnpack 产物足够） */
function balanceTags(html) {
  const tokenRe = /<(\/?)([a-zA-Z][a-zA-Z0-9:_-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  const out = [];
  const stack = [];
  let last = 0;
  let m;
  const pushText = (text) => {
    if (text) out.push(text);
  };
  while ((m = tokenRe.exec(html))) {
    pushText(html.slice(last, m.index));
    const closing = m[1] === '/';
    let tag = m[2].toLowerCase();
    const selfClose = m[4] === '/';
    const known = BLOCK_TAGS.has(tag);
    if (VOID_TAGS.has(tag)) {
      out.push('<' + tag + (m[3] || '') + '/>');
      last = tokenRe.lastIndex;
      continue;
    }
    if (!known) {
      // 未知标签：保留原样（XHTML 允许自定义元素？不合法但 XML 合法；这里降级为 span）
      if (closing) {
        // 关闭未知标签：忽略
      } else if (!selfClose) {
        out.push('<span' + (m[3] || '') + '>');
        stack.push('span');
      }
      last = tokenRe.lastIndex;
      continue;
    }
    if (closing) {
      // 找到最近的同名开标签
      let idx = -1;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i] === tag) { idx = i; break; }
      }
      if (idx >= 0) {
        while (stack.length > idx) {
          const t = stack.pop();
          if (stack.length > idx - 1 && t) out.push('</' + t + '>');
        }
      } else {
        // 无对应开标签：丢弃
      }
    } else if (selfClose) {
      out.push('<' + tag + (m[3] || '') + '/>');
    } else {
      out.push('<' + tag + (m[3] || '') + '>');
      stack.push(tag);
    }
    last = tokenRe.lastIndex;
  }
  pushText(html.slice(last));
  while (stack.length) {
    const t = stack.pop();
    out.push('</' + t + '>');
  }
  return out.join('');
}

/** 提取 <body> 内容（大小写不敏感）；无 body 返回原串 */
function extractBody(html) {
  const s = String(html || '');
  const m = s.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i);
  return m ? m[1] : s;
}

/* ------------------------------------------------------------------ */
/* 杂项                                                                */
/* ------------------------------------------------------------------ */

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function mimeFromExt(ext) {
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', tif: 'image/tiff',
    tiff: 'image/tiff', avif: 'image/avif', ico: 'image/x-icon',
    css: 'text/css', xhtml: 'application/xhtml+xml', html: 'text/html',
    xml: 'application/xml', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff',
    woff2: 'font/woff2', mp3: 'audio/mpeg', mp4: 'video/mp4', js: 'text/javascript',
  };
  return map[String(ext || '').toLowerCase().replace(/^\./, '')] || 'application/octet-stream';
}

function extFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  const map = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/x-ms-bmp': 'bmp',
    'image/tiff': 'tiff', 'image/avif': 'avif',
  };
  return map[m] || (m.split('/')[1] || 'bin').replace(/[^a-z0-9]/g, '');
}

function sniffImage(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { mime: 'image/png', ext: 'png' };
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return { mime: 'image/gif', ext: 'gif' };
  if (buf[0] === 0x42 && buf[1] === 0x4d) return { mime: 'image/bmp', ext: 'bmp' };
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf.length > 12 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return { mime: 'image/webp', ext: 'webp' };
  if (buf.length > 100 && buf.toString('latin1', 0, 100).includes('<svg')) return { mime: 'image/svg+xml', ext: 'svg' };
  return null;
}

function safeName(name, fallback) {
  const cleaned = String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').trim();
  return cleaned || fallback || 'file';
}

module.exports = {
  PROJECT_ROOT, CACHE_ROOT, SCRATCH_DIR,
  escapeXmlText, escapeXmlAttr, decodeEntities, normalizeEntities, stripTags, collapseWhitespace,
  detectEncoding, decodeBuffer, readTextAuto, readTextHead, guessLanguage,
  ensureDir, ensureScratch, rmrf, fileSize, existsNonEmpty, walkFiles, findFirst, writeFileAtomic, uniqueTempPath,
  baseNameNoExt, titleFromFilename,
  runProcess, runPythonTool, toolScript,
  sanitizeHtmlFragment, balanceTags, extractBody,
  uuid, nowIso, mimeFromExt, extFromMime, sniffImage, safeName,
};
