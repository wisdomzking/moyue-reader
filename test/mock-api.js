/**
 * Front-end mock API (no backend needed).
 * Run: node test/mock-api.js  ->  http://127.0.0.1:7790/
 * Shapes follow SPEC.md section 5.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const TEST = path.join(ROOT, 'test', 'books');
const PORT = Number(process.env.MOCK_PORT || 7790);

const SAMPLES = [
  { file: 'sample.epub', format: 'EPUB', title: 'Pride and Prejudice', author: 'Jane Austen', language: 'en' },
  { file: 'sample.mobi', format: 'MOBI', title: 'Pride and Prejudice (MOBI)', author: 'Jane Austen', language: 'en' },
  { file: 'sample.pdf', format: 'PDF', title: 'Work Report 2026 Q3', author: 'Team B', language: 'zh' },
  { file: 'sample.docx', format: 'DOCX', title: 'CRM Requirement Doc', author: 'Presales', language: 'zh' },
  { file: 'sample.txt', format: 'TXT', title: 'Shanhai Notes', author: 'Anon', language: 'zh' },
  { file: 'sample.html', format: 'HTML', title: 'Web Chapter', author: 'Anon', language: 'zh' },
  { file: 'sample.fb2', format: 'FB2', title: 'FictionBook Sample', author: 'Anon', language: 'zh' },
];

const state = {
  folders: [{ path: TEST, name: 'books', bookCount: SAMPLES.length }],
  settings: {
    theme: 'light', fontSize: 18, fontFamily: 'serif', lineHeight: 1.8,
    pageMode: 'paginated', spread: 'auto', maxWidth: 880, pdfZoom: 'fit',
  },
  books: {},
  bookmarks: {},
};

function makeId(p) {
  return crypto.createHash('sha1').update(p.toLowerCase()).digest('hex').slice(0, 16);
}

for (const s of SAMPLES) {
  const abs = path.join(TEST, s.file);
  if (!fs.existsSync(abs)) continue;
  const st = fs.statSync(abs);
  const id = makeId(abs);
  state.books[id] = {
    id, path: abs, dir: TEST, filename: s.file, ext: s.file.split('.').pop(),
    format: s.format, title: s.title, author: s.author, language: s.language,
    size: st.size, mtime: Math.floor(st.mtimeMs), cover: null,
    addedAt: Date.now(), lastReadAt: 0,
    progress: { percent: 0, location: '', page: 1, totalPages: 0 },
    status: 'ready', error: null,
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.ico': 'image/x-icon',
  '.epub': 'application/epub+zip', '.pdf': 'application/pdf',
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function serveStatic(res, urlPath) {
  const rel = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, '');
  let file = path.join(WEB, rel || 'index.html');
  if (!file.startsWith(WEB)) { res.writeHead(403); return res.end('forbidden'); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (!path.extname(file)) file = path.join(WEB, 'index.html');
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

function serveRange(req, res, file, contentType) {
  fs.stat(file, (err, st) => {
    if (err) return sendJSON(res, 404, { error: { code: 'not_found', message: 'file not found' } });
    const range = req.headers.range;
    const headers = { 'Content-Type': contentType, 'Accept-Ranges': 'bytes', ETag: `"${st.size}-${st.mtimeMs}"` };
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m && m[1] ? parseInt(m[1], 10) : 0;
      const end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      headers['Content-Length'] = st.size;
      res.writeHead(200, headers);
      fs.createReadStream(file).pipe(res);
    }
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  if (p === '/api/health') return sendJSON(res, 200, {
    ok: true, version: '1.0.0-mock',
    capabilities: { mobi: true, docx: true, pdf: true, libreoffice: true, python: true },
  });

  if (p === '/api/state') {
    const books = Object.values(state.books).sort((a, b) => b.lastReadAt - a.lastReadAt);
    return sendJSON(res, 200, {
      folders: state.folders, books, settings: state.settings,
      counts: { total: books.length, byFormat: books.reduce((m, b) => ((m[b.format] = (m[b.format] || 0) + 1), m), {}) },
    });
  }

  if (p === '/api/settings') {
    if (req.method === 'PUT') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      Object.assign(state.settings, body);
      return sendJSON(res, 200, { settings: state.settings });
    }
    return sendJSON(res, 200, { settings: state.settings });
  }

  if (p === '/api/scan') return sendJSON(res, 200, { added: 0, removed: 0, errors: [], folders: state.folders });

  if (p === '/api/folders' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    return sendJSON(res, 200, { folder: { path: body.path, name: path.basename(body.path || ''), bookCount: 0 }, added: 0 });
  }

  if (p === '/api/open' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    const abs = body.path;
    if (!abs || !fs.existsSync(abs)) return sendJSON(res, 404, { error: { code: 'not_found', message: 'file not found' } });
    const ext = path.extname(abs).slice(1).toLowerCase();
    const id = makeId(abs);
    if (!state.books[id]) {
      const st = fs.statSync(abs);
      state.books[id] = {
        id, path: abs, dir: path.dirname(abs), filename: path.basename(abs), ext,
        format: ext.toUpperCase(), title: path.basename(abs, path.extname(abs)), author: '',
        language: 'zh', size: st.size, mtime: Math.floor(st.mtimeMs), cover: null,
        addedAt: Date.now(), lastReadAt: 0,
        progress: { percent: 0, location: '', page: 1, totalPages: 0 },
        status: 'ready', error: null,
      };
    }
    return sendJSON(res, 200, state.books[id]);
  }

  if (p === '/api/browse') {
    const q = u.searchParams.get('path') || '';
    if (!q) {
      return sendJSON(res, 200, {
        path: '', parent: null, isDriveList: true,
        drives: [{ name: 'C:', path: 'C:\\' }, { name: 'D:', path: 'D:\\' }],
        quick: [{ name: 'Desktop', path: 'C:\\Users\\user\\Desktop' }, { name: 'Documents', path: 'C:\\Users\\user\\Documents' }],
        dirs: [], files: [],
      });
    }
    try {
      const entries = fs.readdirSync(q, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).slice(0, 200)
        .map((e) => ({ name: e.name, path: path.join(q, e.name) }));
      const files = entries.filter((e) => e.isFile() && !e.name.startsWith('.')).slice(0, 200)
        .map((e) => {
          const abs = path.join(q, e.name);
          const ext = path.extname(e.name).slice(1).toLowerCase();
          const st = fs.statSync(abs);
          return { name: e.name, path: abs, size: st.size, ext, isBook: ['epub', 'pdf', 'mobi', 'azw3', 'docx', 'txt'].includes(ext) };
        });
      return sendJSON(res, 200, { path: q, parent: path.dirname(q) === q ? '' : path.dirname(q), isDriveList: false, drives: [], quick: [], dirs, files });
    } catch (e) {
      return sendJSON(res, 400, { error: { code: 'browse_failed', message: 'cannot read dir: ' + e.message } });
    }
  }

  const m = /^\/api\/books\/([a-f0-9]+)(?:\/(prepare|content|cover|progress|bookmarks|search))?/.exec(p);
  if (m) {
    const book = state.books[m[1]];
    if (!book) return sendJSON(res, 404, { error: { code: 'not_found', message: 'book not found' } });
    const sub = m[2];
    if (!sub) {
      if (req.method === 'DELETE') { delete state.books[book.id]; return sendJSON(res, 200, { ok: true }); }
      return sendJSON(res, 200, book);
    }
    if (sub === 'prepare') {
      const isPdf = book.ext === 'pdf';
      book.lastReadAt = book.lastReadAt || Date.now();
      return sendJSON(res, 200, {
        type: isPdf ? 'pdf' : 'epub', url: `/api/books/${book.id}/content`,
        title: book.title, author: book.author, pageCount: isPdf ? 12 : 0,
      });
    }
    if (sub === 'content') {
      const isPdf = book.ext === 'pdf';
      return serveRange(req, res, path.join(TEST, isPdf ? 'sample.pdf' : 'sample.epub'),
        isPdf ? 'application/pdf' : 'application/epub+zip');
    }
    if (sub === 'cover') { res.writeHead(404); return res.end(); }
    if (sub === 'progress') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      Object.assign(book.progress, body, { percent: Number(body.percent) || 0 });
      book.lastReadAt = Date.now();
      return sendJSON(res, 200, { ok: true, progress: book.progress });
    }
    if (sub === 'bookmarks') {
      state.bookmarks[book.id] = state.bookmarks[book.id] || [];
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        const bm = { id: crypto.randomUUID().slice(0, 8), createdAt: Date.now(), ...body };
        state.bookmarks[book.id].push(bm);
        return sendJSON(res, 200, bm);
      }
      return sendJSON(res, 200, { bookmarks: state.bookmarks[book.id] });
    }
    if (sub === 'search') return sendJSON(res, 200, { results: [], total: 0 });
  }

  if (p.startsWith('/api/')) return sendJSON(res, 404, { error: { code: 'not_found', message: 'api not found' } });
  return serveStatic(res, p);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] MoYue mock API -> http://127.0.0.1:${PORT}/ (${Object.keys(state.books).length} books)`);
});
