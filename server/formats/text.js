'use strict';
/**
 * formats/text.js — TXT / MD。
 *
 * 编码探测：UTF-8 BOM → UTF-16(BOM/启发) → UTF-8 严格校验 → GBK。
 * 正文按行聚段（中文全角缩进/不以句末标点结尾的行视为折行），
 * 按「第X章/第X节/卷/回/序章/前言/后记/尾声/番外/Chapter N」等正则切章。
 */

const path = require('path');
const fs = require('fs');
const {
  readTextAuto, readTextHead, titleFromFilename, guessLanguage,
  escapeXmlText, stripTags, ensureDir,
} = require('./util');
const { EpubBuilder } = require('./epub-build');

const CHAPTER_RE = new RegExp(
  '^(?:' +
  '第\\s*[0-9０-９零〇一二三四五六七八九十百千万两]+\\s*[章节節回卷篇部集幕话話]' +
  '|[卷卷][\\s]*[0-9０-９零〇一二三四五六七八九十百千万两]+' +
  '|[序楔]章|序言|前言|引子|楔子|后记|後記|尾声|尾聲|终章|終章|尾声|番外(?:篇)?|附录|附錄' +
  '|(?:Chapter|CHAPTER|Part|PART|Book|BOOK|Prologue|Epilogue|PROLOGUE|EPILOGUE|Prologue\\.)\\s*[0-9IVXLCDMivxlcdm]+\\b.*' +
  '|[Cc]hapter\\s+[0-9IVXLCDMivxlcdm]+\\b.*' +
  ')'
);

// 句末/段落结束标点（用于判断折行合并）
const TERMINAL_RE = /[。！？；：…—”’」』】）》〉.!?;:"'\])]$/;

const MAX_HEADING_LEN = 60;

const PREFACE_LABELS = new Set(['序章', '序言', '前言', '引子', '楔子', '后记', '後記', '尾声', '尾聲', '终章', '終章', '番外', '番外篇', '附录', '附錄']);

/** 是否章节标题行；返回 {label, level} 或 null */
function matchHeading(line, isMarkdown) {
  const text = String(line || '').trim();
  if (!text || text.length > MAX_HEADING_LEN) return null;
  if (isMarkdown) {
    const md = text.match(/^(#{1,4})\s+(.+)$/);
    if (md) return { label: md[2].trim(), level: Math.min(3, md[1].length) };
  }
  // 标题行通常不含句号；避免把「第一章 归墟。少年……」这类长段落误判
  if (/[。！？；]/.test(text) && !/^第[0-9零〇一二三四五六七八九十百千万两]+\s*[章节回卷]/.test(text)) return null;
  // 纯标题：以章回标记开头，或完全等于序章类词
  if (PREFACE_LABELS.has(text)) return { label: text, level: 1 };
  if (CHAPTER_RE.test(text)) {
    // 排除「第一章」出现在普通段落开头且长度很长的情况（如 "第一章里提到……"）
    if (text.length > 40 && /[，,、]/.test(text)) return null;
    return { label: text, level: 1 };
  }
  return null;
}

/**
 * 把文本切成章节
 * @returns {Array<{label:string, paragraphs:string[], level:number}>}
 */
function splitChapters(text, options) {
  const opts = options || {};
  const isMarkdown = !!opts.isMarkdown;
  const rawLines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const chapters = [];
  let current = { label: opts.bookTitle || '正文', paragraphs: [], level: 0 };
  let para = null;

  const flushPara = () => {
    if (para && para.trim()) current.paragraphs.push(para.trim());
    para = null;
  };
  const flushChapter = () => {
    flushPara();
    if (current.paragraphs.length || chapters.length === 0) {
      if (current.paragraphs.length) chapters.push(current);
    }
    current = null;
  };

  for (const raw of rawLines) {
    const line = raw.replace(/\u00a0/g, ' ').trimEnd();
    if (!line.trim()) {
      flushPara();
      continue;
    }
    const heading = matchHeading(line, isMarkdown);
    if (heading) {
      flushPara();
      if (current && current.paragraphs.length) chapters.push(current);
      current = { label: heading.label, paragraphs: [], level: heading.level };
      continue;
    }
    if (!current) current = { label: opts.bookTitle || '正文', paragraphs: [], level: 0 };

    const indented = /^[\s\u3000]{1,}/.test(line) || /^[\u3000]/.test(raw);
    const prev = para;
    const merge = !!prev && !indented && !TERMINAL_RE.test(prev) && !/^\s*[-*+>#]/.test(line) &&
      !/^[（(]?\d+[)）.、]/.test(line) && para.length < 2000;
    if (merge) {
      const glue = /[a-zA-Z0-9,;:]$/.test(prev) && /^[a-zA-Z0-9]/.test(line.trim()) ? ' ' : '';
      para = prev + glue + line.trim();
    } else {
      flushPara();
      para = line.trim();
    }
  }
  flushPara();
  if (current && current.paragraphs.length) chapters.push(current);
  if (!chapters.length) {
    chapters.push({ label: opts.bookTitle || '正文', paragraphs: String(text || '').split(/\n{2,}/).map((s) => s.trim()).filter(Boolean), level: 0 });
  }
  return chapters;
}

/** 从正文头部猜书名/作者（很多 TXT 首行是 《书名》 / 作者：xxx） */
function sniffMeta(text, filePath) {
  const head = String(text || '').slice(0, 8000);
  const lines = head.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 40);
  let title = '';
  let author = '';
  for (const line of lines) {
    if (!title) {
      const m = line.match(/^[*#\s]*《([^》]{1,80})》[*#\s]*$/);
      if (m) title = m[1].trim();
      else {
        const t = line.match(/^(?:书名|書名)\s*[:：]\s*(.{1,80})$/);
        if (t) title = t[1].trim();
        else {
          const md = line.match(/^#{1,2}\s+(.{1,80})$/);
          if (md && md[1].trim().length <= 40) title = md[1].trim();
        }
      }
    }
    if (!author) {
      const a = line.match(/^(?:作者|著者|作\s*者)\s*[:：]\s*(.{1,60})$/);
      if (a) author = a[1].trim();
    }
    if (title && author) break;
  }
  return {
    title: title || titleFromFilename(filePath),
    author: author || '',
  };
}

async function probe(filePath) {
  const fallback = {
    format: path.extname(filePath).toLowerCase() === '.md' ? 'MD' : 'TXT',
    title: titleFromFilename(filePath),
    author: '',
    language: 'zh',
    cover: null,
    coverMime: null,
  };
  try {
    const { text, size } = readTextHead(filePath, 128 * 1024);
    const meta = sniffMeta(text, filePath);
    return {
      ...fallback,
      title: meta.title,
      author: meta.author,
      language: guessLanguage(text),
      size,
    };
  } catch (_) {
    return fallback;
  }
}

async function prepare(filePath, outDir) {
  const ext = path.extname(filePath).toLowerCase();
  const isMarkdown = ext === '.md';
  const { text } = readTextAuto(filePath);
  if (!text || !text.trim()) throw new Error('文件内容为空');
  const meta = sniffMeta(text, filePath);
  const chapters = splitChapters(text, { isMarkdown, bookTitle: meta.title });
  // 首章若只是书名/作者等元信息行，去掉重复展示
  if (chapters.length) {
    const first = chapters[0];
    if (first.level === 0 || first.label === meta.title) {
      first.paragraphs = first.paragraphs.filter((p) => {
        const plain = stripTags(p);
        if (!plain) return false;
        if (plain === meta.title) return false;
        if (/^《[^》]*》$/.test(plain)) return false;
        if (meta.author && plain === meta.author) return false;
        if (/^(?:书名|書名|作者|著者)\s*[:：]/.test(plain)) return false;
        return true;
      });
    }
  }
  const usable = chapters.filter((c) => c.paragraphs.length > 0);
  if (!usable.length) throw new Error('文件内容为空');
  const language = guessLanguage(text);
  ensureDir(outDir);
  const builder = new EpubBuilder({ title: meta.title, author: meta.author, language });
  const toc = [];
  for (const ch of usable) {
    const heading = ch.label && ch.label !== meta.title
      ? '<h2 class="chapter-title">' + escapeXmlText(ch.label) + '</h2>\n'
      : (meta.title ? '<h1 class="chapter-title">' + escapeXmlText(meta.title) + '</h1>\n' : '');
    const body = heading + ch.paragraphs.map((p) => '<p>' + escapeXmlText(p.replace(/^[\s\u3000]+/, '')) + '</p>').join('\n');
    const href = builder.addChapter({ title: ch.label, bodyHtml: body });
    toc.push({ label: ch.label, href, level: 1 });
  }
  builder.setToc(toc);
  const outFile = path.join(outDir, 'book.epub');
  const info = await builder.write(outFile);
  return { type: 'epub', file: outFile, toc, chapters: info.chapters };
}

module.exports = { FORMAT: 'TXT', probe, prepare, splitChapters, matchHeading, sniffMeta };
