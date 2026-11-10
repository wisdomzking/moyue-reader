'use strict';
/**
 * formats/office.js — DOC / RTF / ODT。
 * prepare：LibreOffice 转 docx（带 UserInstallation 参数，stdio:'ignore'），再走 DOCX 流程；
 *          失败则 --convert-to html 兜底，再走 HTML 流程。
 * probe：ODT 读 meta.xml + Thumbnails 封面；RTF 解析 {\info{\title..}{\author..}}；DOC 用文件名。
 */

const path = require('path');
const fs = require('fs');
const {
  PROJECT_ROOT, ensureDir, rmrf, runProcess, readTextHead, titleFromFilename,
  guessLanguage, decodeBuffer, stripTags, decodeEntities, mimeFromExt, sniffImage, existsNonEmpty,
} = require('./util');
const { readZipEntries, extractEntry, findEntry, isZipFile } = require('./zip');
const docx = require('./docx');
const html = require('./html');

const SOFFICE_CANDIDATES = [
  'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
  'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  'C:\\Program Files\\LibreOffice 7\\program\\soffice.exe',
];

function sofficePath() {
  for (const p of SOFFICE_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch (_) { /* ignore */ }
  }
  return 'soffice';
}

function userInstallationUri() {
  const profile = path.join(PROJECT_ROOT, '.cache', 'lo-profile').replace(/\\/g, '/');
  return 'file:///' + profile;
}

/** 运行 LibreOffice 转换，返回产物路径或 null */
function convertWithLibreOffice(srcPath, outDir, targetFormat) {
  ensureDir(outDir);
  const lo = sofficePath();
  const args = [
    '-env:UserInstallation=' + userInstallationUri(),
    '--headless',
    '--norestore',
    '--nologo',
    '--nodefault',
    '--nofirststartwizard',
    '--convert-to', targetFormat,
    '--outdir', outDir,
    srcPath,
  ];
  const res = runProcess(lo, args, { timeout: 90000 });
  const ext = '.' + String(targetFormat).split(':')[0].toLowerCase();
  let files = [];
  try { files = fs.readdirSync(outDir); } catch (_) { return null; }
  const candidates = files
    .filter((f) => f.toLowerCase().endsWith(ext))
    .map((f) => path.join(outDir, f))
    .filter((p) => existsNonEmpty(p));
  if (candidates.length) return candidates[0];
  if (!res.ok) return null;
  return null;
}

/* ----------------------------- ODT probe ----------------------------- */

function readOdtMeta(filePath) {
  const out = { title: '', author: '', language: '', cover: null, coverMime: null };
  try {
    if (!isZipFile(filePath)) return out;
    const entries = readZipEntries(filePath);
    const meta = findEntry(entries, 'meta.xml');
    if (meta) {
      const xml = extractEntry(filePath, meta).toString('utf8');
      out.title = stripTags(decodeEntities((xml.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i) || [])[1] || ''));
      out.author = stripTags(decodeEntities(
        (xml.match(/<dc:creator\b[^>]*>([\s\S]*?)<\/dc:creator>/i) || [])[1] ||
        (xml.match(/<meta:initial-creator\b[^>]*>([\s\S]*?)<\/meta:initial-creator>/i) || [])[1] || ''
      ));
      out.language = stripTags(decodeEntities((xml.match(/<dc:language\b[^>]*>([\s\S]*?)<\/dc:language>/i) || [])[1] || ''));
    }
    const thumb = entries.find((e) => /^Thumbnails\/thumbnail\.(png|jpe?g)$/i.test(e.name));
    if (thumb) {
      const buf = extractEntry(filePath, thumb);
      if (buf && buf.length > 64) {
        const sniff = sniffImage(buf);
        out.cover = buf;
        out.coverMime = sniff ? sniff.mime : mimeFromExt(path.extname(thumb.name).slice(1));
      }
    }
  } catch (_) { /* ignore */ }
  return out;
}

/* ----------------------------- RTF probe ----------------------------- */

const CP_MAP = {
  936: 'gbk', 950: 'big5', 65001: 'utf-8', 1252: 'windows-1252', 1251: 'windows-1251',
  932: 'shift_jis', 949: 'euc-kr', 874: 'windows-874', 1250: 'windows-1250',
  1253: 'windows-1253', 1254: 'windows-1254', 1255: 'windows-1255', 1256: 'windows-1256',
  1257: 'windows-1257', 1258: 'windows-1258', 10000: 'macintosh',
};

// RTF \fcharsetN → ANSI codepage
const FCHARSET_CP = {
  0: 1252, 1: 1252, 2: 1252, 77: 10000, 128: 932, 129: 949, 130: 1361, 134: 936,
  136: 950, 161: 1253, 162: 1254, 163: 1258, 177: 1255, 178: 1256, 186: 1257,
  204: 1251, 222: 874, 238: 1250, 255: 850,
};

/** 取出 RTF 里 {\name ...} 分组（大括号配对，跳过反斜杠转义） */
function rtfGroups(text, name) {
  const results = [];
  const re = new RegExp('\\{\\\\' + name + '\\b', 'g');
  let m;
  while ((m = re.exec(text))) {
    let depth = 0;
    let end = -1;
    for (let i = m.index; i < text.length; i++) {
      const c = text[i];
      if (c === '\\') { i++; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end > m.index) results.push(text.slice(m.index, end + 1));
  }
  return results;
}

/** 解码一段 RTF 文本（优先 \uN Unicode，其次按 codepage 解 \'xx 字节） */
function decodeRtfText(raw, codepage) {
  const enc = CP_MAP[codepage] || 'windows-1252';
  const s = String(raw || '');
  let out = '';
  const pending = [];
  const flush = () => {
    if (!pending.length) return;
    try { out += new TextDecoder(enc).decode(Buffer.from(pending)); } catch (_) { /* ignore */ }
    pending.length = 0;
  };
  let ucSkip = 1;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') {
      const next = s[i + 1];
      if (next === "'") {
        const b = parseInt(s.slice(i + 2, i + 4), 16);
        if (Number.isFinite(b)) pending.push(b);
        i += 4;
        continue;
      }
      if (next === '\\' || next === '{' || next === '}') {
        flush();
        out += next;
        i += 2;
        continue;
      }
      let j = i + 1;
      let word = '';
      while (j < s.length && /[a-zA-Z]/.test(s[j])) { word += s[j]; j++; }
      let param = '';
      if (s[j] === '-') { param = '-'; j++; }
      while (j < s.length && /[0-9]/.test(s[j])) { param += s[j]; j++; }
      if (s[j] === ' ') j++;
      if (word === 'u') {
        flush();
        let code = parseInt(param, 10);
        if (!Number.isFinite(code)) code = 0;
        if (code < 0) code += 65536;
        try { out += String.fromCharCode(code); } catch (_) { /* ignore */ }
        i = j;
        let skipped = 0;
        while (skipped < ucSkip && i < s.length) {
          if (s[i] === '\\' && s[i + 1] === "'") { i += 4; skipped++; continue; }
          if (s[i] === '\\') {
            let k = i + 1;
            while (k < s.length && /[a-zA-Z]/.test(s[k])) k++;
            while (k < s.length && /[0-9]/.test(s[k])) k++;
            if (s[k] === ' ') k++;
            i = k;
            skipped++;
            continue;
          }
          if (s[i] === '{' || s[i] === '}') { i++; continue; }
          i++;
          skipped++;
        }
        continue;
      }
      if (word === 'uc') { ucSkip = parseInt(param, 10) || 1; i = j; continue; }
      i = j;
      continue;
    }
    if (ch === '{' || ch === '}') { i++; continue; }
    flush();
    out += ch;
    i++;
  }
  flush();
  return out.replace(/\s+/g, ' ').trim();
}

/** 优先用带 \uN Unicode 的那个分组（LibreOffice 会同时写 ANSI 回退串） */
function decodeRtfField(groups, codepage) {
  if (!groups || !groups.length) return '';
  const unicodeGroup = groups.find((g) => /\\u-?\d/.test(g));
  return decodeRtfText(unicodeGroup || groups[0], codepage);
}

function readRtfInfo(filePath) {
  const out = { title: '', author: '', language: '' };
  try {
    const { text } = readTextHead(filePath, 128 * 1024);
    let codepage = null;
    const cpMatch = text.match(/\\ansicpg(\d+)/);
    if (cpMatch) codepage = parseInt(cpMatch[1], 10);
    if (!codepage) {
      const fc = text.match(/\\fcharset(\d+)/);
      if (fc && FCHARSET_CP[parseInt(fc[1], 10)]) codepage = FCHARSET_CP[parseInt(fc[1], 10)];
    }
    if (!codepage) codepage = 1252;
    out.title = decodeRtfField(rtfGroups(text, 'title'), codepage);
    out.author = decodeRtfField(rtfGroups(text, 'author'), codepage);
    if (codepage === 936 || codepage === 950) out.language = 'zh';
  } catch (_) { /* ignore */ }
  return out;
}

/* ------------------------------- probe ------------------------------- */

async function probe(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const format = ext === '.doc' ? 'DOC' : ext === '.rtf' ? 'RTF' : 'ODT';
  const fallback = { format, title: titleFromFilename(filePath), author: '', language: 'zh', cover: null, coverMime: null };
  try {
    if (format === 'ODT') {
      const meta = readOdtMeta(filePath);
      return {
        ...fallback,
        title: meta.title || fallback.title,
        author: meta.author || '',
        language: meta.language || guessLanguage(meta.title || fallback.title),
        cover: meta.cover,
        coverMime: meta.coverMime,
      };
    }
    if (format === 'RTF') {
      const info = readRtfInfo(filePath);
      return {
        ...fallback,
        title: info.title || fallback.title,
        author: info.author || '',
        language: info.language || guessLanguage(info.title || fallback.title),
      };
    }
    return fallback;
  } catch (_) {
    return fallback;
  }
}

/* ------------------------------ prepare ------------------------------ */

async function prepare(filePath, outDir) {
  const workRoot = path.join(outDir, 'work', 'office');
  rmrf(workRoot);
  ensureDir(workRoot);
  const baseName = path.basename(filePath);
  const errors = [];

  const docxDir = path.join(workRoot, 'docx');
  ensureDir(docxDir);
  const docxFile = convertWithLibreOffice(filePath, docxDir, 'docx');
  if (docxFile) {
    try {
      const res = await docx.prepare(docxFile, outDir);
      res.converted = docxFile;
      return res;
    } catch (e) {
      errors.push('DOCX 流程失败：' + (e && e.message ? e.message : e));
    }
  } else {
    errors.push('LibreOffice 未能生成 DOCX');
  }

  // 兜底：转 HTML
  const htmlDir = path.join(workRoot, 'html');
  ensureDir(htmlDir);
  const htmlFile = convertWithLibreOffice(filePath, htmlDir, 'html');
  if (htmlFile) {
    try {
      const res = await html.prepare(htmlFile, outDir);
      res.converted = htmlFile;
      return res;
    } catch (e) {
      errors.push('HTML 流程失败：' + (e && e.message ? e.message : e));
    }
  } else {
    errors.push('LibreOffice 未能生成 HTML');
  }
  throw new Error('无法转换 ' + baseName + '（' + errors.join('；') + '）');
}

module.exports = { FORMAT: 'ODT', probe, prepare, convertWithLibreOffice, sofficePath, readOdtMeta, readRtfInfo };
