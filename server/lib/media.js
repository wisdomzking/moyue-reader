'use strict';

/**
 * 文件字节流服务：静态资源 / 书籍 content。
 * content 必须支持 Range（206 + Content-Range + Accept-Ranges）、ETag、Last-Modified（PDF.js 依赖）。
 */

const fs = require('fs');
const path = require('path');
const { sendError, mimeOf } = require('./util');

/** 解析单段 Range；返回 {start,end} / null（不处理） / 'invalid'（416） */
function parseRange(header, size) {
  if (!header) return null;
  const text = String(header).trim();
  if (!/^bytes=/i.test(text)) return null;
  const spec = text.slice(6).trim();
  if (!spec || spec.includes(',')) return null; // 多段 Range 退化为整文件 200
  const m = /^(\d*)-(\d*)$/.exec(spec);
  if (!m) return 'invalid';
  const hasStart = m[1] !== '';
  const hasEnd = m[2] !== '';
  if (!hasStart && !hasEnd) return 'invalid';
  let start;
  let end;
  if (hasStart) {
    start = parseInt(m[1], 10);
    end = hasEnd ? parseInt(m[2], 10) : size - 1;
  } else {
    // bytes=-N：最后 N 字节
    const suffix = parseInt(m[2], 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid';
  if (size === 0 || start >= size) return 'invalid';
  if (end < start) return 'invalid';
  end = Math.min(end, size - 1);
  return { start, end };
}

function etagFor(st) {
  return `"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;
}

function notModified(req, st) {
  const inm = req.headers['if-none-match'];
  if (!inm) return false;
  const etag = etagFor(st);
  return String(inm)
    .split(',')
    .map((s) => s.trim())
    .some((v) => v === etag || v === '*');
}

/**
 * 输出文件（自动处理 Range / 条件请求 / HEAD）。
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} file 绝对路径
 * @param {string} contentType
 * @param {object} [opts] { cacheControl, extraHeaders }
 */
function serveFile(req, res, file, contentType, opts) {
  const options = opts || {};
  let st;
  try {
    st = fs.statSync(file);
  } catch (e) {
    sendError(res, 404, 'not_found', '文件不存在');
    return;
  }
  if (!st.isFile()) {
    sendError(res, 404, 'not_found', '目标不是文件');
    return;
  }
  const total = st.size;
  const headers = Object.assign(
    {
      'Content-Type': contentType || mimeOf(file),
      'Accept-Ranges': 'bytes',
      ETag: etagFor(st),
      'Last-Modified': st.mtime.toUTCString(),
      'Cache-Control': options.cacheControl || 'no-cache',
    },
    options.extraHeaders || {}
  );

  if (notModified(req, st)) {
    delete headers['Content-Type'];
    res.writeHead(304, headers);
    res.end();
    return;
  }

  const range = parseRange(req.headers.range, total);
  if (range === 'invalid') {
    res.writeHead(416, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Range': `bytes */${total}`,
      'Cache-Control': 'no-store',
    });
    res.end(Buffer.from(JSON.stringify({ error: { code: 'range_not_satisfiable', message: '请求范围无效' } }), 'utf8'));
    return;
  }

  const isHead = req.method === 'HEAD';
  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${total}`;
    headers['Content-Length'] = range.end - range.start + 1;
    res.writeHead(206, headers);
    if (isHead) {
      res.end();
      return;
    }
    const stream = fs.createReadStream(file, { start: range.start, end: range.end });
    stream.on('error', () => {
      try {
        res.destroy();
      } catch (e) {
        /* ignore */
      }
    });
    stream.pipe(res);
    return;
  }

  headers['Content-Length'] = total;
  res.writeHead(200, headers);
  if (isHead) {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file);
  stream.on('error', () => {
    try {
      res.destroy();
    } catch (e) {
      /* ignore */
    }
  });
  stream.pipe(res);
}

/** 静态资源（web/ 下），SPA 回退由调用方决定。
 * 本机单用户应用：一律不缓存，保证前端更新后刷新即生效（本地读取成本可忽略）。 */
function serveStatic(req, res, file, opts) {
  const options = opts || {};
  const cacheControl = options.cacheControl || 'no-store';
  serveFile(req, res, file, mimeOf(file), { cacheControl });
}

module.exports = { serveFile, serveStatic, parseRange, etagFor };
