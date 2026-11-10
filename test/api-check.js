#!/usr/bin/env node
/** Backend API integration check. Usage: node test/api-check.js [port] (default 7788) */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2] || 7788);
const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = path.join(ROOT, 'test', 'books');

let pass = 0;
let fail = 0;
const failures = [];

function req(method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)));
    const h = { ...headers };
    if (payload) h['Content-Length'] = payload.length;
    if (body !== undefined && !Buffer.isBuffer(body)) h['Content-Type'] = 'application/json';
    const r = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function j(method, urlPath, body) {
  const r = await req(method, urlPath, body);
  let json = null;
  try { json = JSON.parse(r.body.toString('utf8')); } catch (e) { /* not json */ }
  return { ...r, json };
}

function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS', name); } else {
    fail += 1;
    failures.push(name + (detail ? ' :: ' + detail : ''));
    console.log('  FAIL', name, detail || '');
  }
}

const FMT = { epub: 'EPUB', mobi: 'MOBI', pdf: 'PDF', docx: 'DOCX', doc: 'DOC', txt: 'TXT', html: 'HTML', fb2: 'FB2' };
const PREPARE_ORDER = ['epub', 'mobi', 'docx', 'doc', 'txt', 'html', 'fb2', 'pdf'];

async function main() {
  const health = await j('GET', '/api/health');
  check('health 200', health.status === 200 && health.json && health.json.ok === true, JSON.stringify(health.json));
  console.log('       capabilities:', JSON.stringify(health.json && health.json.capabilities));

  const state0 = await j('GET', '/api/state');
  check('state 200', state0.status === 200 && Array.isArray(state0.json.books));
  for (const f of (state0.json && state0.json.folders) || []) {
    if (path.normcase ? false : false) { /* noop */ }
    if (path.resolve(f.path) === TEST_DIR) await j('DELETE', '/api/folders?path=' + encodeURIComponent(f.path));
  }

  const add = await j('POST', '/api/folders', { path: TEST_DIR });
  check('add folder', add.status === 200 && add.json && add.json.folder, JSON.stringify(add.json).slice(0, 200));
  check('scan finds >=8 books', add.json && add.json.added >= 8, 'added=' + (add.json && add.json.added));

  const state = await j('GET', '/api/state');
  const books = (state.json && state.json.books) || [];
  const byExt = {};
  for (const b of books) if (path.resolve(b.dir) === TEST_DIR) byExt[b.ext] = b;
  for (const ext of Object.keys(FMT)) check('library has ' + FMT[ext], !!byExt[ext], 'ext=' + ext);

  if (byExt.epub) {
    check('EPUB title parsed', /Pride|Austen/i.test(byExt.epub.title), byExt.epub.title);
    check('book id is 16 hex', /^[0-9a-f]{16}$/.test(byExt.epub.id), byExt.epub.id);
  }

  for (const ext of PREPARE_ORDER) {
    const b = byExt[ext];
    if (!b) { check('prepare ' + FMT[ext], false, 'missing book'); continue; }
    const t0 = Date.now();
    let pr;
    try { pr = await j('POST', `/api/books/${b.id}/prepare`); } catch (e) { check('prepare ' + FMT[ext], false, String(e)); continue; }
    const ms = Date.now() - t0;
    const expect = ext === 'pdf' ? 'pdf' : 'epub';
    check('prepare ' + FMT[ext], pr.status === 200 && pr.json && pr.json.url && pr.json.type === expect,
      pr.status + ' ' + JSON.stringify(pr.json).slice(0, 180));
    if (pr.status !== 200) continue;
    console.log(`       (${FMT[ext]} ${ms}ms type=${pr.json.type} toc=${(pr.json.toc || []).length} pages=${pr.json.pageCount || 0})`);

    const content = await req('GET', pr.json.url);
    check('content ' + FMT[ext], content.status === 200 && content.body.length > 1000,
      `status=${content.status} len=${content.body.length}`);
    const ct = content.headers['content-type'] || '';
    check('content-type ' + FMT[ext], expect === 'pdf' ? ct.includes('pdf') : ct.includes('epub'), ct);

    const range = await req('GET', pr.json.url, undefined, { Range: 'bytes=0-99' });
    check('range 206 ' + FMT[ext], range.status === 206 && range.body.length === 100 && /bytes 0-99\//.test(range.headers['content-range'] || ''),
      `status=${range.status} range=${range.headers['content-range']}`);
  }

  for (const ext of ['epub', 'pdf', 'docx']) {
    const b = byExt[ext];
    if (!b) continue;
    const cover = await req('GET', `/api/books/${b.id}/cover`);
    check('cover ' + FMT[ext], cover.status === 200 || cover.status === 404, 'status=' + cover.status);
    if (cover.status === 200) check('cover type ' + FMT[ext], /image\//.test(cover.headers['content-type'] || ''), cover.headers['content-type']);
  }

  if (byExt.epub) {
    const put = await j('PUT', `/api/books/${byExt.epub.id}/progress`, { percent: 0.42, location: 'epubcfi(/6/14!/4/2/2/1:0)', page: 7, totalPages: 40 });
    check('PUT progress', put.status === 200 && put.json && put.json.ok === true, JSON.stringify(put.json));
    const st = await j('GET', '/api/state');
    const b2 = (st.json.books || []).find((x) => x.id === byExt.epub.id);
    check('progress persisted', b2 && Math.abs((b2.progress || {}).percent - 0.42) < 0.001, JSON.stringify(b2 && b2.progress));

    const bm = await j('POST', `/api/books/${byExt.epub.id}/bookmarks`, { cfi: 'epubcfi(/6/8!/4/2)', label: 'ch3', percent: 0.3, excerpt: 'test' });
    check('POST bookmark', bm.status === 200 && bm.json && bm.json.id, JSON.stringify(bm.json));
    const list = await j('GET', `/api/books/${byExt.epub.id}/bookmarks`);
    check('GET bookmarks', list.status === 200 && list.json.bookmarks.length >= 1);
    if (bm.json && bm.json.id) {
      const del = await j('DELETE', `/api/books/${byExt.epub.id}/bookmarks/${bm.json.id}`);
      check('DELETE bookmark', del.status === 200);
    }

    const s = await j('GET', `/api/books/${byExt.epub.id}/search?q=marriage`);
    check('GET search', s.status === 200 && Array.isArray(s.json.results), 'status=' + s.status);
    console.log('       search hits:', s.json && s.json.results ? s.json.results.length : 'n/a');
  }

  const set = await j('PUT', '/api/settings', { theme: 'sepia', fontSize: 20 });
  check('PUT settings', set.status === 200 && set.json.settings && set.json.settings.theme === 'sepia', JSON.stringify(set.json));
  const set2 = await j('GET', '/api/settings');
  check('settings persisted', set2.json.settings.theme === 'sepia' && set2.json.settings.fontSize === 20, JSON.stringify(set2.json.settings));
  await j('PUT', '/api/settings', { theme: 'light', fontSize: 18 });

  const browseRoot = await j('GET', '/api/browse?path=');
  check('browse drives', browseRoot.status === 200 && Array.isArray(browseRoot.json.drives) && browseRoot.json.drives.length > 0,
    JSON.stringify(browseRoot.json).slice(0, 200));
  const browseTest = await j('GET', '/api/browse?path=' + encodeURIComponent(TEST_DIR));
  check('browse test dir', browseTest.status === 200 && browseTest.json.files.some((f) => f.name === 'sample.epub'),
    JSON.stringify(browseTest.json).slice(0, 200));

  const openBook = await j('POST', '/api/open', { path: path.join(TEST_DIR, 'sample.epub') });
  check('POST /api/open', openBook.status === 200 && openBook.json.id, JSON.stringify(openBook.json).slice(0, 160));
  const imported = await req('POST', '/api/import?name=' + encodeURIComponent('imported-sample.txt'), fs.readFileSync(path.join(TEST_DIR, 'sample.txt')));
  check('POST /api/import', imported.status === 200, 'status=' + imported.status + ' ' + imported.body.toString('utf8').slice(0, 160));

  const missing = await j('GET', '/api/books/0000000000000000');
  check('missing book 404', missing.status === 404, 'status=' + missing.status);

  const index = await req('GET', '/');
  check('GET / index', index.status === 200 && /<html/i.test(index.body.toString('utf8')), 'status=' + index.status);

  console.log(`\nAPI CHECK: ${pass} passed, ${fail} failed`);
  if (fail) { console.log('failures:'); failures.forEach((f) => console.log(' -', f)); }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('CRASH', e); process.exit(2); });
