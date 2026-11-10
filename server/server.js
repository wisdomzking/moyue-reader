#!/usr/bin/env node
'use strict';

/**
 * 墨阅 MoYue 本地电子书阅读器 —— 后端 HTTP 入口。
 *
 * - 静态资源：web/（SPA fallback）
 * - API：见 SPEC.md §5
 * - 只监听本机回环地址（默认 127.0.0.1:7788）
 *
 * 启动参数：
 *   --port <n>     端口（默认 7788，可用环境变量 PORT）
 *   --host <addr>  监听地址（默认 127.0.0.1）
 *   --open <file>  启动即登记指定电子书，并打印可直接打开的 URL
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const {
  VERSION,
  WEB_DIR,
  ensureDir,
  isFile,
  isDir,
  normalizeInputPath,
  readJsonBody,
  sendJson,
  sendError,
  HttpError,
  safeDecode,
} = require('./lib/util');
const library = require('./lib/library');
const browse = require('./lib/browse');
const search = require('./lib/search');
const media = require('./lib/media');
const cover = require('./lib/cover');
const bookmarks = require('./lib/bookmarks');
const adapter = require('./lib/formats-adapter');

const DEFAULT_PORT = 7788;
const DEFAULT_HOST = '127.0.0.1';

// ------------------------------------------------------------ 参数
function parseArgs(argv) {
  const out = {
    port: Number(process.env.PORT) || DEFAULT_PORT,
    host: process.env.HOST || DEFAULT_HOST,
    open: process.env.MOYUE_OPEN || null,
    help: false,
    error: null,
  };
  const take = (i, inline) => {
    if (inline != null && inline !== '') return { value: inline, index: i };
    if (i + 1 < argv.length) return { value: argv[i + 1], index: i + 1 };
    return { value: null, index: i };
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (typeof arg !== 'string') continue;
    const eq = arg.indexOf('=');
    const key = (eq >= 0 ? arg.slice(0, eq) : arg).toLowerCase();
    const inline = eq >= 0 ? arg.slice(eq + 1) : null;
    if (key === '--port' || key === '-p') {
      const r = take(i, inline);
      i = r.index;
      const n = Number(r.value);
      if (Number.isFinite(n) && n >= 1 && n <= 65535) out.port = Math.floor(n);
      else out.error = `端口无效：${r.value == null ? '（缺少参数值）' : r.value}，应为 1-65535 的整数`;
    } else if (key === '--host' || key === '-H') {
      const r = take(i, inline);
      i = r.index;
      if (r.value) out.host = String(r.value);
      else out.error = '缺少 --host 的参数值';
    } else if (key === '--open' || key === '-o') {
      const r = take(i, inline);
      i = r.index;
      if (r.value) out.open = String(r.value);
      else out.error = '缺少 --open 的参数值（电子书绝对路径）';
    } else if (key === '--help' || key === '-h' || key === '-help' || key === '/?') {
      out.help = true;
    }
  }
  return out;
}

function printHelp() {
  console.log(`墨阅 MoYue 后端 v${VERSION}

用法：node server/server.js [--port 7788] [--host 127.0.0.1] [--open <电子书绝对路径>]

  --port <n>     监听端口，默认 7788（也可用环境变量 PORT）
  --host <addr>  监听地址，默认 127.0.0.1（仅本机可访问）
  --open <file>  启动时登记该书并打印可直接打开的链接
`);
}

// ------------------------------------------------------------ 静态资源
function resolveWebFile(urlPath) {
  const decoded = safeDecode(urlPath);
  const rel = decoded.replace(/^\/+/, '');
  const target = path.resolve(WEB_DIR, rel || 'index.html');
  const root = path.resolve(WEB_DIR);
  if (target !== root && !target.startsWith(root + path.sep)) return { forbidden: true };
  return { target };
}

function sendPlaceholder(req, res) {
  const status = adapter.formatsStatus();
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>墨阅 · 前端尚未就绪</title>
<style>body{font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#f5f2ec;color:#25221d;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#fffdf8;border:1px solid #e6dfd2;border-radius:16px;padding:40px 44px;max-width:560px;box-shadow:0 10px 30px rgba(60,45,25,.10)}
h1{font-size:22px;margin:0 0 12px}p{line-height:1.8;color:#797165;margin:6px 0}
code{background:#f5f2ec;border-radius:6px;padding:2px 6px;color:#2f6f64}</style></head>
<body><div class="card"><h1>墨阅 · 后端已就绪</h1>
<p>前端文件 <code>web/index.html</code> 尚未生成，当前仅提供 API 服务。</p>
<p>API 自检：<code>/api/health</code>、<code>/api/state</code></p>
<p>转换模块：${status.available ? '已加载' : '未就绪（EPUB / PDF 可直接阅读）'}</p>
</div></body></html>`;
  const body = Buffer.from(html, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function handleStatic(req, res, urlPath) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendError(res, 405, 'method_not_allowed', '静态资源仅支持 GET / HEAD');
    return;
  }
  const resolved = resolveWebFile(urlPath);
  if (resolved.forbidden) {
    sendError(res, 403, 'forbidden', '禁止访问该路径');
    return;
  }
  const target = resolved.target;
  if (isFile(target)) {
    media.serveStatic(req, res, target);
    return;
  }
  // 有扩展名却不存在 → 真正 404，避免把 HTML 当 js/css 返回
  const ext = path.extname(target).toLowerCase();
  if (ext && ext !== '.html' && ext !== '.htm') {
    sendError(res, 404, 'not_found', '静态资源不存在');
    return;
  }
  // SPA fallback
  const index = path.join(WEB_DIR, 'index.html');
  if (isFile(index)) {
    media.serveStatic(req, res, index);
    return;
  }
  sendPlaceholder(req, res);
}

// ------------------------------------------------------------ 路由辅助
function requireMethod(req, res, methods) {
  if (methods.includes(req.method)) return true;
  sendError(res, 405, 'method_not_allowed', `该接口仅支持 ${methods.join(' / ')} 请求`);
  return false;
}

function getBookOrThrow(id) {
  const book = library.getBook(id);
  if (!book) throw new HttpError(404, 'not_found', '书籍不存在');
  return book;
}

// ------------------------------------------------------------ API 路由
/**
 * @returns {Promise<boolean>} 是否已处理（false 表示交给静态资源）
 */
async function dispatchApi(req, res, u) {
  const p = u.pathname;

  // ---- 健康检查
  if (p === '/api/health') {
    if (!requireMethod(req, res, ['GET'])) return true;
    sendJson(res, 200, {
      ok: true,
      version: VERSION,
      capabilities: adapter.capabilities(),
    });
    return true;
  }

  // ---- 全量状态
  if (p === '/api/state') {
    if (!requireMethod(req, res, ['GET'])) return true;
    try {
      sendJson(res, 200, library.state());
    } catch (e) {
      sendJson(res, 200, {
        folders: library.folderList(),
        collections: library.collectionList(),
        books: library.sortedBooks(),
        settings: library.state().settings,
        counts: library.counts(),
      });
    }
    return true;
  }

  // ---- 扫描
  if (p === '/api/scan') {
    if (!requireMethod(req, res, ['POST'])) return true;
    const result = await library.scanAll();
    sendJson(res, 200, result);
    return true;
  }

  // ---- 文件夹
  if (p === '/api/folders') {
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await library.addFolder(body.path);
      sendJson(res, 200, result);
      return true;
    }
    if (req.method === 'DELETE') {
      const target = u.searchParams.get('path') || '';
      if (!target) throw new HttpError(400, 'bad_request', '缺少文件夹路径');
      const result = library.removeFolder(target);
      sendJson(res, 200, result);
      return true;
    }
    sendError(res, 405, 'method_not_allowed', '该接口仅支持 POST / DELETE');
    return true;
  }

  // ---- 书架文件夹（手动分组）
  if (p === '/api/collections') {
    if (req.method === 'GET') {
      sendJson(res, 200, { collections: library.collectionList() });
      return true;
    }
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const collection = library.createCollection(body.name);
      sendJson(res, 200, { collection });
      return true;
    }
    sendError(res, 405, 'method_not_allowed', '该接口仅支持 GET / POST');
    return true;
  }

  if (p === '/api/collections/auto') {
    if (!requireMethod(req, res, ['POST'])) return true;
    const body = await readJsonBody(req);
    const result = library.autoClassify(body.mode);
    sendJson(res, 200, result);
    return true;
  }

  if (p === '/api/collections/apply-ai') {
    if (!requireMethod(req, res, ['POST'])) return true;
    const body = await readJsonBody(req);
    const result = library.applyAiClassify(body.groups);
    sendJson(res, 200, result);
    return true;
  }

  const collectionMatch = /^\/api\/collections\/([a-z0-9]+)$/i.exec(p);
  if (collectionMatch) {
    const collectionId = collectionMatch[1];
    if (req.method === 'PATCH' || req.method === 'PUT') {
      const body = await readJsonBody(req);
      const collection = library.renameCollection(collectionId, body.name);
      sendJson(res, 200, { collection });
      return true;
    }
    if (req.method === 'DELETE') {
      const result = library.deleteCollection(collectionId);
      sendJson(res, 200, result);
      return true;
    }
    sendError(res, 405, 'method_not_allowed', '该接口仅支持 PATCH / DELETE');
    return true;
  }

  // ---- 批量移动书籍到文件夹
  if (p === '/api/books/move') {
    if (!requireMethod(req, res, ['POST'])) return true;
    const body = await readJsonBody(req);
    const result = library.moveBooks(body.bookIds, body.collectionId);
    sendJson(res, 200, result);
    return true;
  }

  // ---- 单本登记
  if (p === '/api/open') {
    if (!requireMethod(req, res, ['POST'])) return true;
    const body = await readJsonBody(req);
    const record = await library.openPath(body.path);
    sendJson(res, 200, record);
    return true;
  }

  // ---- 拖拽导入（原始字节）
  if (p === '/api/import') {
    if (!requireMethod(req, res, ['POST'])) return true;
    const name = u.searchParams.get('name') || '';
    if (!name.trim()) {
      req.resume(); // 丢弃请求体
      throw new HttpError(400, 'bad_request', '缺少文件名参数 ?name=');
    }
    try {
      const record = await library.importBook(name, req);
      sendJson(res, 200, record);
    } catch (e) {
      req.resume();
      throw e;
    }
    return true;
  }

  // ---- 设置
  if (p === '/api/settings') {
    if (req.method === 'GET') {
      sendJson(res, 200, { settings: library.state().settings });
      return true;
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      const body = await readJsonBody(req);
      const settings = library.updateSettings(body);
      sendJson(res, 200, { settings });
      return true;
    }
    sendError(res, 405, 'method_not_allowed', '该接口仅支持 GET / PUT');
    return true;
  }

  // ---- 目录浏览
  if (p === '/api/browse') {
    if (!requireMethod(req, res, ['GET'])) return true;
    const data = browse.browse(u.searchParams.get('path') || '');
    sendJson(res, 200, data);
    return true;
  }

  // ---- 在资源管理器中定位
  if (p === '/api/reveal') {
    if (!requireMethod(req, res, ['POST'])) return true;
    const body = await readJsonBody(req);
    revealInExplorer(body.path);
    sendJson(res, 200, { ok: true });
    return true;
  }

  // ---- 单本书相关
  const m = /^\/api\/books\/([0-9a-zA-Z_-]+)(?:\/(.+))?$/.exec(p);
  if (m) {
    const id = m[1];
    const sub = m[2] || '';
    const book = getBookOrThrow(id);

    if (!sub) {
      if (req.method === 'GET') {
        sendJson(res, 200, { ...book, cover: `/api/books/${book.id}/cover?v=${book.mtime}` });
        return true;
      }
      if (req.method === 'DELETE') {
        const removed = library.removeBook(id);
        sendJson(res, 200, { ok: true, id: removed.id });
        return true;
      }
      sendError(res, 405, 'method_not_allowed', '该接口仅支持 GET / DELETE');
      return true;
    }

    // 准备（可能耗时数秒）
    if (sub === 'prepare') {
      if (!requireMethod(req, res, ['POST'])) return true;
      const readable = await library.prepareBook(id);
      library.markOpened(id);
      sendJson(res, 200, {
        type: readable.type,
        url: `/api/books/${id}/content`,
        title: book.title,
        author: book.author,
        toc: readable.toc || [],
        pageCount: readable.pageCount || 0,
      });
      return true;
    }

    // 原始字节流（EPUB / PDF，支持 Range）
    if (sub === 'content') {
      if (!requireMethod(req, res, ['GET', 'HEAD'])) return true;
      const readable = await library.resolveReadable(book);
      const contentType = readable.type === 'pdf' ? 'application/pdf' : 'application/epub+zip';
      media.serveFile(req, res, readable.file, contentType, { cacheControl: 'no-cache' });
      return true;
    }

    // 封面（懒生成 + 缓存）
    if (sub === 'cover') {
      if (!requireMethod(req, res, ['GET', 'HEAD'])) return true;
      const coverFile = await cover.ensureCover(book);
      if (!coverFile) {
        sendError(res, 404, 'no_cover', '这本书没有可用的封面');
        return true;
      }
      media.serveFile(req, res, coverFile, cover.mimeForCoverFile(coverFile), {
        cacheControl: 'public, max-age=86400',
      });
      return true;
    }

    // 阅读进度
    if (sub === 'progress') {
      if (!requireMethod(req, res, ['PUT', 'POST'])) return true;
      const body = await readJsonBody(req);
      const progress = library.updateProgress(id, body);
      sendJson(res, 200, { ok: true, progress });
      return true;
    }

    // 全文搜索
    if (sub === 'search') {
      if (!requireMethod(req, res, ['GET'])) return true;
      const q = (u.searchParams.get('q') || '').trim();
      if (!q) {
        sendJson(res, 200, { results: [], total: 0 });
        return true;
      }
      try {
        const readable = await library.resolveReadable(book);
        if (readable.type !== 'epub') {
          sendJson(res, 200, { results: [], total: 0 });
          return true;
        }
        const result = await search.searchEpub(readable.file, q);
        sendJson(res, 200, result);
      } catch (e) {
        // 搜索失败（例如需要转换但转换模块未就绪）不影响页面，返回空结果
        console.error('[墨阅] 搜索失败:', book.path, e && e.message);
        sendJson(res, 200, { results: [], total: 0 });
      }
      return true;
    }

    // 书签
    const bm = /^bookmarks(?:\/([^/]+))?$/.exec(sub);
    if (bm) {
      const bookmarkId = bm[1];
      if (bookmarkId != null) {
        if (!requireMethod(req, res, ['DELETE'])) return true;
        const ok = bookmarks.remove(id, safeDecode(bookmarkId));
        if (!ok) throw new HttpError(404, 'not_found', '书签不存在');
        sendJson(res, 200, { ok: true });
        return true;
      }
      if (req.method === 'GET') {
        sendJson(res, 200, { bookmarks: bookmarks.list(id) });
        return true;
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const created = bookmarks.create(id, body);
        sendJson(res, 200, created);
        return true;
      }
      sendError(res, 405, 'method_not_allowed', '该接口仅支持 GET / POST / DELETE');
      return true;
    }

    throw new HttpError(404, 'not_found', '接口不存在');
  }

  return false;
}

/** 在资源管理器中定位文件（失败不报 500） */
function revealInExplorer(inputPath) {
  try {
    const abs = normalizeInputPath(typeof inputPath === 'string' ? inputPath : '');
    if (!abs) return;
    const exists = isFile(abs) || isDir(abs);
    if (!exists) return;
    const st = fs.statSync(abs);
    const args = st.isDirectory() ? [abs] : ['/select,', abs];
    const child = spawn('explorer.exe', args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', () => {
      /* 忽略：explorer 不可用时也不影响接口 */
    });
    child.unref();
  } catch (e) {
    /* 失败不报 500 */
  }
}

// ------------------------------------------------------------ 总入口
async function handle(req, res) {
  let u;
  try {
    u = new URL(req.url || '/', 'http://127.0.0.1');
  } catch (e) {
    sendError(res, 400, 'bad_request', '请求地址无法解析');
    return;
  }
  const isApi = u.pathname === '/api' || u.pathname.startsWith('/api/');
  try {
    if (isApi) {
      const handled = await dispatchApi(req, res, u);
      if (!handled) sendError(res, 404, 'not_found', '接口不存在');
      return;
    }
    handleStatic(req, res, u.pathname);
  } catch (e) {
    if (res.writableEnded) return;
    if (e instanceof HttpError) {
      sendError(res, e.status, e.code, e.message);
      return;
    }
    console.error('[墨阅] 请求处理异常:', req.method, req.url, e && e.stack ? e.stack : e);
    sendError(res, 500, 'internal', '服务器内部错误');
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (args.error) {
    console.error(`[墨阅] 启动参数错误：${args.error}`);
    console.error('用法：node server/server.js [--port 7788] [--host 127.0.0.1] [--open <电子书绝对路径>]');
    process.exitCode = 1;
    return;
  }
  ensureDir(WEB_DIR);
  library.init();

  const server = http.createServer((req, res) => {
    handle(req, res);
  });
  // prepare 可能耗时数秒；关掉请求超时，避免长转换被中断
  server.requestTimeout = 0;
  server.headersTimeout = 120000;
  server.keepAliveTimeout = 65000;

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`[墨阅] 端口 ${args.port} 已被占用，请换一个端口：--port <n>`);
    } else {
      console.error('[墨阅] 服务启动失败:', err && err.message ? err.message : err);
    }
    process.exitCode = 1;
  });

  const shutdown = (signal) => {
    console.log(`\n[墨阅] 收到 ${signal}，正在退出…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    console.error('[墨阅] unhandledRejection:', reason && reason.stack ? reason.stack : reason);
  });

  server.listen(args.port, args.host, async () => {
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : args.port;
    const base = `http://${args.host}:${port}`;
    const status = adapter.formatsStatus();
    const books = library.sortedBooks();
    console.log(`[墨阅] 本地阅读器后端 v${VERSION} 已启动 → ${base}/`);
    console.log(`[墨阅] 书库：${books.length} 本，文件夹 ${library.folderList().length} 个`);
    if (!status.available) {
      console.log('[墨阅] 提示：server/formats 转换模块未就绪，当前 EPUB / PDF 可直接阅读，其它格式需等待转换模块');
    }
    if (args.open) {
      try {
        const record = await library.openPath(args.open);
        library.markOpened(record.id);
        const isPdf = adapter.formatOf(record.path) === 'PDF';
        const viewer = isPdf ? '#/pdf/' : '#/read/';
        console.log(`[墨阅] 已登记：${record.title}（${record.format}）`);
        console.log(`[墨阅] 直接打开：${base}/${viewer}${record.id}`);
        console.log(`[墨阅] 备用链接：${base}/?open=${encodeURIComponent(record.path)}`);
      } catch (e) {
        console.error(`[墨阅] --open 处理失败：${e && e.message ? e.message : e}`);
      }
    }
  });
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, handle, main };
