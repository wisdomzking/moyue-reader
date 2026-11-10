'use strict';

/**
 * 墨阅 backend 公共工具。
 * 只依赖 Node 内置模块：路径常量、原子 JSON 读写、HTTP 响应、文件/格式识别、流写入、错误类型。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = '1.0.0';

// ---------------------------------------------------------------- 目录常量
const ROOT = path.resolve(__dirname, '..', '..'); // ebook-reader/
const WEB_DIR = path.join(ROOT, 'web');
const DATA_DIR = path.join(ROOT, 'data');
const CACHE_DIR = path.join(ROOT, '.cache');
const BOOKS_CACHE_DIR = path.join(CACHE_DIR, 'books');
const COVERS_DIR = path.join(DATA_DIR, 'covers');
const IMPORTED_DIR = path.join(DATA_DIR, 'imported');
const LIBRARY_FILE = path.join(DATA_DIR, 'library.json');
const BOOKMARKS_FILE = path.join(DATA_DIR, 'bookmarks.json');

// 扩展名 → 展示用大写字面（与 SPEC §6 SUPPORTED 对齐）
const EXT_FORMAT = {
  epub: 'EPUB',
  pdf: 'PDF',
  mobi: 'MOBI',
  azw: 'AZW',
  azw3: 'AZW3',
  prc: 'PRC',
  doc: 'DOC',
  docx: 'DOCX',
  rtf: 'RTF',
  odt: 'ODT',
  txt: 'TXT',
  md: 'MD',
  html: 'HTML',
  htm: 'HTML',
  xhtml: 'XHTML',
  fb2: 'FB2',
};
const SUPPORTED_EXT = new Set(Object.keys(EXT_FORMAT));

// 静态资源 mime 表（SPEC 要求含 html/css/js/svg/png/jpg/woff2/epub/pdf）
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.epub': 'application/epub+zip',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
};

// ---------------------------------------------------------------- 基础工具
function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    /* 目录已存在或无权限时交由调用方处理 */
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (e) {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}

function statSafe(p) {
  try {
    return fs.statSync(p);
  } catch (e) {
    return null;
  }
}

/** 扩展名（小写、不带点） */
function extOf(p) {
  return path.extname(String(p || '')).replace(/^\./, '').toLowerCase();
}

function formatOfExt(ext) {
  const key = String(ext || '').toLowerCase();
  return EXT_FORMAT[key] || (key ? key.toUpperCase() : null);
}

function isSupportedFile(p) {
  return SUPPORTED_EXT.has(extOf(p));
}

/** id = sha1(absPath.toLowerCase()) 前 16 位 hex（SPEC §4） */
function makeId(absPath) {
  return crypto.createHash('sha1').update(String(absPath).toLowerCase(), 'utf8').digest('hex').slice(0, 16);
}

function mimeOf(p) {
  return MIME[path.extname(String(p || '')).toLowerCase()] || 'application/octet-stream';
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function safeDecode(s) {
  try {
    return decodeURIComponent(String(s));
  } catch (e) {
    return String(s);
  }
}

/** 把用户传入的路径转成 Windows 绝对路径（统一反斜杠、去掉尾部分隔符） */
function normalizeInputPath(input) {
  const raw = String(input == null ? '' : input).trim().replace(/^"|"$/g, '');
  if (!raw) return '';
  return path.resolve(raw);
}

/** child 是否位于 folder 之下（大小写不敏感，Windows 语义） */
function isUnderPath(child, folder) {
  if (!child || !folder) return false;
  const c = String(child).replace(/\//g, '\\').toLowerCase();
  let f = String(folder).replace(/\//g, '\\').toLowerCase();
  if (!f.endsWith('\\')) f += '\\';
  return c === f.slice(0, -1) || c.startsWith(f);
}

/** 文件名安全化（拖拽导入用） */
function safeFileName(input) {
  let base = String(input || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop();
  base = base.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '');
  base = base.replace(/[. ]+$/, '');
  base = base.trim();
  if (!base) return '';
  if (base.length > 120) {
    const ext = path.extname(base).slice(0, 12);
    base = base.slice(0, Math.max(1, 120 - ext.length)) + ext;
  }
  return base;
}

// ---------------------------------------------------------------- JSON 持久化
function readJson(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (!text || !text.trim()) return fallback;
    return JSON.parse(text);
  } catch (e) {
    return fallback;
  }
}

/** 原子写：先写同目录 .tmp，再 rename 覆盖（SPEC §4） */
function writeJsonAtomic(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch (e2) {
      /* ignore */
    }
    throw e;
  }
}

/** 把可读流写入文件（先 .part 再 rename），用于拖拽导入大文件 */
function writeStreamToFile(stream, dest) {
  ensureDir(path.dirname(dest));
  return new Promise((resolve, reject) => {
    const tmp = `${dest}.${process.pid}.part`;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      stream.unpipe && stream.unpipe();
      try {
        stream.destroy && stream.destroy();
      } catch (e) {
        /* ignore */
      }
      try {
        fs.unlinkSync(tmp);
      } catch (e) {
        /* ignore */
      }
      reject(err);
    };
    let ws;
    try {
      ws = fs.createWriteStream(tmp);
    } catch (e) {
      return fail(e);
    }
    ws.on('error', fail);
    stream.on('error', fail);
    stream.on('aborted', () => fail(new Error('上传被中断')));
    ws.on('finish', () => {
      if (settled) return;
      settled = true;
      try {
        fs.renameSync(tmp, dest);
        resolve(dest);
      } catch (e) {
        fail(e);
      }
    });
    stream.pipe(ws);
  });
}

// ---------------------------------------------------------------- 并发池
/** 简单并发池：单个任务失败不影响其它任务 */
async function runPool(items, concurrency, worker) {
  const list = Array.from(items || []);
  if (!list.length) return;
  const n = Math.max(1, Math.min(Number(concurrency) || 1, list.length));
  let cursor = 0;
  const runners = [];
  for (let i = 0; i < n; i += 1) {
    runners.push(
      (async () => {
        for (;;) {
          const idx = cursor;
          cursor += 1;
          if (idx >= list.length) return;
          try {
            await worker(list[idx], idx);
          } catch (e) {
            /* 单个任务失败不影响其它文件 */
          }
        }
      })()
    );
  }
  await Promise.all(runners);
}

// ---------------------------------------------------------------- HTTP
class HttpError extends Error {
  constructor(status, code, message) {
    super(message || '请求处理失败');
    this.status = status || 500;
    this.code = code || 'internal';
  }
}

function sendJson(res, status, obj, extraHeaders) {
  if (res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(obj == null ? null : obj), 'utf8');
  const headers = Object.assign(
    {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    },
    extraHeaders || {}
  );
  res.writeHead(status, headers);
  res.end(body);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code: code || 'error', message: message || '请求处理失败' } });
}

const JSON_BODY_LIMIT = 2 * 1024 * 1024; // 2MB

function readBody(req, limit) {
  const max = Number(limit) || JSON_BODY_LIMIT;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > max) {
        settled = true;
        req.pause();
        reject(new HttpError(413, 'payload_too_large', '请求体过大'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

async function readJsonBody(req, limit) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    const obj = JSON.parse(buf.toString('utf8'));
    if (obj === null || typeof obj !== 'object') {
      throw new HttpError(400, 'bad_request', '请求体必须是 JSON 对象');
    }
    return obj;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'bad_request', '请求体不是合法 JSON');
  }
}

module.exports = {
  VERSION,
  ROOT,
  WEB_DIR,
  DATA_DIR,
  CACHE_DIR,
  BOOKS_CACHE_DIR,
  COVERS_DIR,
  IMPORTED_DIR,
  LIBRARY_FILE,
  BOOKMARKS_FILE,
  EXT_FORMAT,
  SUPPORTED_EXT,
  MIME,
  ensureDir,
  isFile,
  isDir,
  statSafe,
  extOf,
  formatOfExt,
  isSupportedFile,
  makeId,
  mimeOf,
  clamp,
  safeDecode,
  normalizeInputPath,
  isUnderPath,
  safeFileName,
  readJson,
  writeJsonAtomic,
  writeStreamToFile,
  runPool,
  HttpError,
  sendJson,
  sendError,
  readBody,
  readJsonBody,
  JSON_BODY_LIMIT,
};
