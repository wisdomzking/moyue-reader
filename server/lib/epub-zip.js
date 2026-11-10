'use strict';

/**
 * EPUB zip 轻量解析（jszip），供全文搜索、书签章节名、封面兜底使用。
 * 只做读操作，不修改任何文件。
 */

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const HTML_MIME = /xhtml|html|xml/i;

function decodeSafe(s) {
  try {
    return decodeURIComponent(String(s));
  } catch (e) {
    return String(s);
  }
}

function stripHash(href) {
  return String(href == null ? '' : href).split('#')[0];
}

/** 把 OPF 相对的 href 归一成 zip 内路径 */
function normalizeZipPath(baseDir, href) {
  const raw = decodeSafe(stripHash(href)).replace(/\\/g, '/').trim();
  if (!raw) return '';
  if (raw.startsWith('/')) return path.posix.normalize(raw.replace(/^\/+/, ''));
  const joined = baseDir ? `${baseDir}/${raw}` : raw;
  return path.posix.normalize(joined).replace(/^\/+/, '');
}

function parseAttrs(text) {
  const out = {};
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    out[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
  }
  return out;
}

function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote)>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '…')
    .replace(/&rsquo;/gi, '’')
    .replace(/&lsquo;/gi, '‘')
    .replace(/&ldquo;/gi, '“')
    .replace(/&rdquo;/gi, '”')
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#8217;/g, '’')
    .replace(/\s+/g, ' ')
    .trim();
}

async function readText(zip, entryPath) {
  const f = zip.file(entryPath);
  if (!f) return null;
  try {
    return await f.async('string');
  } catch (e) {
    return null;
  }
}

async function findOpfPath(zip) {
  const container = await readText(zip, 'META-INF/container.xml');
  if (container) {
    const m = /full-path\s*=\s*["']([^"']+)["']/i.exec(container);
    if (m) return decodeSafe(m[1]).replace(/\\/g, '/');
  }
  const names = Object.keys(zip.files || {}).filter((n) => /\.opf$/i.test(n));
  return names[0] || null;
}

function parseManifest(opfText) {
  const items = new Map();
  const re = /<item\b([^>]*?)\/?>/gi;
  let m;
  while ((m = re.exec(String(opfText || '')))) {
    const a = parseAttrs(m[1]);
    if (!a.id || !a.href) continue;
    items.set(a.id, {
      id: a.id,
      href: a.href,
      mediaType: a['media-type'] || '',
      properties: a.properties || '',
    });
  }
  return items;
}

function parseSpine(opfText) {
  const ids = [];
  const re = /<itemref\b([^>]*?)\/?>/gi;
  let m;
  while ((m = re.exec(String(opfText || '')))) {
    const a = parseAttrs(m[1]);
    if (a.idref) ids.push(a.idref);
  }
  return ids;
}

/** 目录（NCX 或 nav.xhtml）→ Map<zip 内路径, 章节标题> */
async function buildTocLabels(zip, opfDir, manifest) {
  const labels = new Map();
  const items = Array.from(manifest.values());
  const navItem = items.find((it) => /(^|\s)nav(\s|$)/.test(it.properties) || /nav\.x?html?$/i.test(it.href));
  const ncxItem = items.find((it) => /dtbncx/i.test(it.mediaType) || /\.ncx$/i.test(it.href));

  if (navItem) {
    const zipPath = normalizeZipPath(opfDir, navItem.href);
    const html = await readText(zip, zipPath);
    if (html) {
      const base = path.posix.dirname(zipPath);
      const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let m;
      while ((m = re.exec(html))) {
        const target = normalizeZipPath(base, m[1]);
        const label = stripTags(m[2]);
        if (target && label && !labels.has(target)) labels.set(target, label);
      }
    }
  }
  if (!labels.size && ncxItem) {
    const zipPath = normalizeZipPath(opfDir, ncxItem.href);
    const ncx = await readText(zip, zipPath);
    if (ncx) {
      const base = path.posix.dirname(zipPath);
      const pointRe = /<navPoint\b[\s\S]*?<\/navPoint>/gi;
      const points = ncx.match(pointRe) || [];
      for (const block of points) {
        const t = /<text[^>]*>([\s\S]*?)<\/text>/i.exec(block);
        const c = /<content\b[^>]*src\s*=\s*["']([^"']+)["']/i.exec(block);
        if (!c) continue;
        const target = normalizeZipPath(base, c[1]);
        const label = t ? stripTags(t[1]) : '';
        if (target && label && !labels.has(target)) labels.set(target, label);
      }
    }
  }
  return labels;
}

/**
 * 打开 EPUB（已读入内存），返回结构化信息。
 * @returns {Promise<{zip, opfPath, opfDir, manifest, spine, labels, readText:Function}>}
 */
async function openEpub(filePath) {
  const buf = await fs.promises.readFile(filePath);
  const zip = await JSZip.loadAsync(buf);
  const opfPath = await findOpfPath(zip);
  if (!opfPath) throw new Error('EPUB 缺少 OPF，无法解析');
  const opfDir = path.posix.dirname(opfPath) === '.' ? '' : path.posix.dirname(opfPath);
  const opfText = (await readText(zip, opfPath)) || '';
  const manifest = parseManifest(opfText);
  const spineIds = parseSpine(opfText);
  const spine = spineIds
    .map((id) => manifest.get(id))
    .filter(Boolean)
    .map((it) => ({
      href: it.href,
      zipPath: normalizeZipPath(opfDir, it.href),
      mediaType: it.mediaType,
    }))
    .filter((it) => it.zipPath);
  if (!spine.length) {
    // 没有 spine 时退化为：所有 xhtml/html 按名字排序
    const names = Object.keys(zip.files || {})
      .filter((n) => /\.x?html?$/i.test(n))
      .sort();
    for (const n of names) {
      spine.push({ href: n, zipPath: n, mediaType: 'application/xhtml+xml' });
    }
  }
  const labels = await buildTocLabels(zip, opfDir, manifest);
  return {
    zip,
    opfPath,
    opfDir,
    manifest,
    spine,
    labels,
    opfText,
    readText: (zipPath) => readText(zip, zipPath),
  };
}

/** 取 EPUB 封面图（Buffer）与 mime；没有则返回 null */
async function extractCover(book) {
  const items = Array.from(book.manifest.values());
  const byProperties = items.find((it) => /(^|\s)cover-image(\s|$)/.test(it.properties));
  let target = byProperties;
  if (!target) {
    const meta = /<meta\b[^>]*name\s*=\s*["']cover["'][^>]*content\s*=\s*["']([^"']+)["']/i.exec(book.opfText || '');
    if (meta) {
      const id = meta[1];
      target = items.find((it) => it.id === id);
    }
  }
  if (!target) {
    target = items.find((it) => /image\//i.test(it.mediaType) && /cover/i.test(it.href));
  }
  if (!target) return null;
  const zipPath = normalizeZipPath(book.opfDir, target.href);
  const entry = book.zip.file(zipPath);
  if (!entry) return null;
  let buf;
  try {
    buf = await entry.async('nodebuffer');
  } catch (e) {
    return null;
  }
  if (!buf || !buf.length) return null;
  const mediaType = target.mediaType || '';
  let mime = mediaType.startsWith('image/') ? mediaType : 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) mime = 'image/png';
  else if (buf[0] === 0xff && buf[1] === 0xd8) mime = 'image/jpeg';
  else if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') mime = 'image/webp';
  else if (buf.slice(0, 3).toString('ascii') === 'GIF') mime = 'image/gif';
  return { buffer: buf, mime };
}

module.exports = {
  openEpub,
  extractCover,
  normalizeZipPath,
  stripTags,
  parseAttrs,
  readText,
  HTML_MIME,
};
