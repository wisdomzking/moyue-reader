'use strict';

/**
 * 书库：data/library.json 持久化、文件夹管理、递归扫描、单本登记、拖拽导入、转换缓存与状态机。
 * 对应 SPEC §4 数据模型 与 §5 的 books/folders/scan/open/import/prepare 接口。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  DATA_DIR,
  BOOKS_CACHE_DIR,
  COVERS_DIR,
  IMPORTED_DIR,
  LIBRARY_FILE,
  ensureDir,
  isFile,
  statSafe,
  extOf,
  formatOfExt,
  makeId,
  clamp,
  normalizeInputPath,
  isUnderPath,
  safeFileName,
  readJson,
  writeJsonAtomic,
  writeStreamToFile,
  runPool,
  HttpError,
} = require('./util');
const adapter = require('./formats-adapter');
const bookmarks = require('./bookmarks');
const cover = require('./cover');

const MAX_DEPTH = 6;
const PROBE_CONCURRENCY = 4;
const SKIP_DIRS = new Set([
  'node_modules',
  '.cache',
  '.git',
  '.svn',
  '__macosx',
  'system volume information',
  '$recycle.bin',
  '.trash',
]);

const COLLECTION_NAME_MAX = 40;
const AUTO_RULES = {
  format: { label: '按格式' },
  status: { label: '按阅读状态' },
  added: { label: '按添加月份' },
};

function newCollectionId() {
  return `c${crypto.randomBytes(4).toString('hex')}`;
}

function cleanCollectionName(value) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, COLLECTION_NAME_MAX);
}

function sanitizeCollectionName(value) {
  const name = cleanCollectionName(value);
  if (!name) throw new HttpError(400, 'bad_request', '文件夹名称不能为空');
  if (String(value).replace(/\s+/g, ' ').trim().length > COLLECTION_NAME_MAX) {
    throw new HttpError(400, 'bad_request', `文件夹名称不能超过 ${COLLECTION_NAME_MAX} 个字`);
  }
  return name;
}

// ------------------------------------------------------------ 默认设置
function defaultSettings() {
  return {
    theme: 'light',
    fontSize: 18,
    fontFamily: 'serif',
    lineHeight: 1.8,
    letterSpacing: 0,
    paragraphSpacing: 0,
    pageMode: 'paginated',
    spread: 'auto',
    maxWidth: 880,
    pdfZoom: 'fit',
    autoTurnEnabled: false,
    autoTurnInterval: 20,
  };
}

function applySettings(target, src) {
  if (!src || typeof src !== 'object') return target;
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  if (typeof src.theme === 'string' && ['light', 'sepia', 'dark'].includes(src.theme)) target.theme = src.theme;
  if (src.fontSize !== undefined) {
    const n = num(src.fontSize);
    if (n !== null) target.fontSize = Math.round(clamp(n, 12, 40));
  }
  if (typeof src.fontFamily === 'string' && ['serif', 'sans', 'kai', 'system'].includes(src.fontFamily)) {
    target.fontFamily = src.fontFamily;
  }
  if (src.lineHeight !== undefined) {
    const n = num(src.lineHeight);
    if (n !== null) target.lineHeight = Math.round(clamp(n, 1.2, 3) * 10) / 10;
  }
  if (src.letterSpacing !== undefined) {
    const n = num(src.letterSpacing);
    if (n !== null) target.letterSpacing = Math.round(clamp(n, 0, 0.3) * 100) / 100;
  }
  if (src.paragraphSpacing !== undefined) {
    const n = num(src.paragraphSpacing);
    if (n !== null) target.paragraphSpacing = Math.round(clamp(n, 0, 1.5) * 100) / 100;
  }
  if (src.autoTurnEnabled !== undefined) target.autoTurnEnabled = Boolean(src.autoTurnEnabled);
  if (src.autoTurnInterval !== undefined) {
    const n = num(src.autoTurnInterval);
    if (n !== null) target.autoTurnInterval = Math.round(clamp(n, 3, 120));
  }
  if (typeof src.pageMode === 'string' && ['paginated', 'scroll'].includes(src.pageMode)) target.pageMode = src.pageMode;
  if (typeof src.spread === 'string' && ['auto', 'none'].includes(src.spread)) target.spread = src.spread;
  if (src.maxWidth !== undefined) {
    const n = num(src.maxWidth);
    if (n !== null) target.maxWidth = clamp(Math.round(n), 480, 1400);
  }
  if (src.pdfZoom !== undefined) {
    const v = src.pdfZoom;
    if (typeof v === 'number' && v > 0) target.pdfZoom = String(Math.round(v));
    else if (typeof v === 'string') {
      if (/^(fit|page)$/i.test(v)) target.pdfZoom = v.toLowerCase();
      else if (/^\d+$/.test(v)) target.pdfZoom = v;
    }
  }
  return target;
}

/**
 * 归一化设置：以默认值为底，叠加 base（现有值）与 input（本次修改）。
 * 非法字段保留 base 中的有效值，不会被打回默认值。
 */
function normalizeSettings(input, base) {
  const s = defaultSettings();
  if (base && typeof base === 'object') applySettings(s, base);
  applySettings(s, input);
  return s;
}

// ------------------------------------------------------------ 数据加载
let db = null;

function normalizeBookRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const abs = raw.path ? normalizeInputPath(raw.path) : '';
  if (!abs) return null;
  const id = /^[0-9a-f]{8,40}$/.test(String(raw.id || '')) ? String(raw.id) : makeId(abs);
  const ext = String(raw.ext || extOf(abs)).replace(/^\./, '').toLowerCase();
  const prog = raw.progress && typeof raw.progress === 'object' ? raw.progress : {};
  const mtime = Number(raw.mtime) || 0;
  // 进程重启时残留的 converting 状态一律回到 ready（转换任务已随进程结束）
  let status = ['ready', 'converting', 'error', 'unsupported'].includes(raw.status) ? raw.status : 'ready';
  if (status === 'converting') status = 'ready';
  return {
    id,
    path: abs,
    dir: raw.dir ? String(raw.dir) : path.dirname(abs),
    filename: raw.filename ? String(raw.filename) : path.basename(abs),
    ext,
    format: raw.format ? String(raw.format).toUpperCase() : formatOfExt(ext),
    title: raw.title ? String(raw.title) : path.basename(abs, path.extname(abs)),
    author: raw.author ? String(raw.author) : '',
    language: raw.language ? String(raw.language) : 'zh',
    size: Number(raw.size) || 0,
    mtime,
    cover: `/api/books/${id}/cover?v=${mtime}`,
    addedAt: Number(raw.addedAt) || Date.now(),
    lastReadAt: Number(raw.lastReadAt) || 0,
    collectionId: raw.collectionId ? String(raw.collectionId) : null,
    progress: {
      percent: clamp(Number(prog.percent) || 0, 0, 1),
      location: prog.location ? String(prog.location) : '',
      page: Math.max(1, Math.round(Number(prog.page) || 1)),
      totalPages: Math.max(0, Math.round(Number(prog.totalPages) || 0)),
    },
    status,
    error: raw.error ? String(raw.error) : null,
  };
}

function init() {
  ensureDir(DATA_DIR);
  ensureDir(COVERS_DIR);
  ensureDir(IMPORTED_DIR);
  ensureDir(BOOKS_CACHE_DIR);
  const raw = readJson(LIBRARY_FILE, null);
  db = { version: 2, folders: [], collections: [], books: {}, settings: defaultSettings() };
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.folders)) {
      for (const f of raw.folders) {
        const p = typeof f === 'string' ? f : f && f.path;
        if (!p || typeof p !== 'string') continue;
        const abs = normalizeInputPath(p);
        if (!abs) continue;
        if (!db.folders.some((x) => x.toLowerCase() === abs.toLowerCase())) db.folders.push(abs);
      }
    }
    if (Array.isArray(raw.collections)) {
      const usedNames = new Set();
      for (const c of raw.collections) {
        if (!c || typeof c !== 'object') continue;
        const name = cleanCollectionName(c.name);
        if (!name) continue;
        let id = /^[a-z0-9]{4,40}$/i.test(String(c.id || '')) ? String(c.id) : newCollectionId();
        while (db.collections.some((x) => x.id === id)) id = newCollectionId();
        let unique = name;
        let n = 2;
        while (usedNames.has(unique.toLowerCase())) {
          unique = `${name} (${n})`;
          n += 1;
        }
        usedNames.add(unique.toLowerCase());
        db.collections.push({
          id,
          name: unique,
          createdAt: Number(c.createdAt) || Date.now(),
          autoRule: c.autoRule ? String(c.autoRule) : null,
        });
      }
    }
    if (raw.books && typeof raw.books === 'object' && !Array.isArray(raw.books)) {
      for (const [id, b] of Object.entries(raw.books)) {
        const rec = normalizeBookRecord(b);
        if (rec) db.books[rec.id] = rec;
      }
    }
    // 清理指向已不存在文件夹的 collectionId
    const validIds = new Set(db.collections.map((c) => c.id));
    for (const b of Object.values(db.books)) {
      if (b.collectionId && !validIds.has(b.collectionId)) b.collectionId = null;
    }
    db.settings = normalizeSettings(raw.settings);
  }
  return db;
}

function store() {
  if (!db) init();
  return db;
}

function save() {
  writeJsonAtomic(LIBRARY_FILE, {
    version: 2,
    folders: store().folders,
    collections: store().collections,
    books: store().books,
    settings: store().settings,
  });
}

// ------------------------------------------------------------ 读取视图
function getBook(id) {
  return store().books[id] || null;
}

function allBooks() {
  return Object.values(store().books);
}

function sortedBooks() {
  return allBooks().sort(
    (a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0) || (b.addedAt || 0) - (a.addedAt || 0)
  );
}

function folderBookCount(folderPath) {
  let n = 0;
  for (const b of allBooks()) {
    if (isUnderPath(b.path, folderPath)) n += 1;
  }
  return n;
}

function folderMeta(folderPath) {
  const name = path.basename(folderPath) || String(folderPath).replace(/[\\/]+$/, '');
  return { path: folderPath, name, bookCount: folderBookCount(folderPath) };
}

function folderList() {
  return store().folders.map((p) => folderMeta(p));
}

// ------------------------------------------------------------ 书架文件夹（手动分组）
function collectionBookCount(collectionId) {
  let n = 0;
  for (const b of allBooks()) {
    if (b.collectionId === collectionId) n += 1;
  }
  return n;
}

function collectionMeta(c) {
  return {
    id: c.id,
    name: c.name,
    createdAt: c.createdAt || 0,
    autoRule: c.autoRule || null,
    bookCount: collectionBookCount(c.id),
  };
}

function collectionList() {
  return store()
    .collections.slice()
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .map(collectionMeta);
}

function findCollection(id) {
  return store().collections.find((c) => c.id === String(id || '')) || null;
}

function findCollectionByName(name) {
  const target = String(name || '').toLowerCase();
  return store().collections.find((c) => c.name.toLowerCase() === target) || null;
}

function createCollection(name, options) {
  const clean = sanitizeCollectionName(name);
  const d = store();
  const existing = findCollectionByName(clean);
  if (existing) return collectionMeta(existing);
  const collection = {
    id: newCollectionId(),
    name: clean,
    createdAt: Date.now(),
    autoRule: options && options.autoRule ? String(options.autoRule) : null,
  };
  d.collections.push(collection);
  save();
  return collectionMeta(collection);
}

function renameCollection(id, name) {
  const collection = findCollection(id);
  if (!collection) throw new HttpError(404, 'not_found', '文件夹不存在');
  const clean = sanitizeCollectionName(name);
  const dup = findCollectionByName(clean);
  if (dup && dup.id !== collection.id) throw new HttpError(409, 'conflict', '已存在同名文件夹');
  collection.name = clean;
  save();
  return collectionMeta(collection);
}

function deleteCollection(id) {
  const d = store();
  const idx = d.collections.findIndex((c) => c.id === String(id || ''));
  if (idx < 0) throw new HttpError(404, 'not_found', '文件夹不存在');
  const [removed] = d.collections.splice(idx, 1);
  let movedToUnfiled = 0;
  for (const b of Object.values(d.books)) {
    if (b.collectionId === removed.id) {
      b.collectionId = null;
      movedToUnfiled += 1;
    }
  }
  save();
  return { ok: true, id: removed.id, name: removed.name, movedToUnfiled };
}

function moveBooks(ids, collectionId) {
  const list = Array.isArray(ids) ? ids.map(String).filter(Boolean) : [];
  if (!list.length) throw new HttpError(400, 'bad_request', '缺少书籍 id 列表');
  const target = collectionId == null || collectionId === '' ? null : String(collectionId);
  if (target) {
    const collection = findCollection(target);
    if (!collection) throw new HttpError(404, 'not_found', '目标文件夹不存在');
  }
  let count = 0;
  for (const id of list) {
    const book = store().books[id];
    if (!book) continue;
    book.collectionId = target;
    count += 1;
  }
  if (count) save();
  return { ok: true, count, collectionId: target };
}

function autoGroupName(rule, book) {  const format = String(book.format || formatOfExt(book.ext) || 'OTHER').toUpperCase();
  if (rule === 'format') {
    if (format === 'EPUB' || format === 'PDF') return format;
    if (['MOBI', 'AZW', 'AZW3', 'PRC'].includes(format)) return 'Kindle';
    if (['DOC', 'DOCX', 'RTF', 'ODT'].includes(format)) return 'Word 文档';
    if (['TXT', 'MD', 'HTML', 'HTM', 'XHTML', 'FB2'].includes(format)) return '文本 / 网页';
    return '其他格式';
  }
  if (rule === 'status') {
    const percent = Number(book.progress && book.progress.percent) || 0;
    if (percent >= 0.99) return '已读完';
    if (percent > 0 || book.lastReadAt) return '在读';
    return '未读';
  }
  if (rule === 'added') {
    const date = new Date(Number(book.addedAt) || Date.now());
    return `${date.getFullYear()}年${String(date.getMonth() + 1).padStart(2, '0')}月`;
  }
  return '未分类';
}

function pruneEmptyAutoCollections() {
  const d = store();
  d.collections = d.collections.filter(
    (c) => !c.autoRule || allBooks().some((b) => b.collectionId === c.id)
  );
}

function autoClassify(mode) {
  const rule = String(mode || 'format');
  if (!AUTO_RULES[rule]) throw new HttpError(400, 'bad_request', '不支持的自动分类方式');
  const d = store();
  const previousAutoIds = new Set(d.collections.filter((c) => c.autoRule === rule).map((c) => c.id));
  const groups = new Map();
  for (const book of allBooks()) {
    const name = autoGroupName(rule, book);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(book);
  }
  const usedIds = new Set();
  const resultGroups = [];
  let created = 0;
  for (const [name, books] of groups) {
    let collection = findCollectionByName(name);
    if (!collection) {
      collection = {
        id: newCollectionId(),
        name,
        createdAt: Date.now(),
        autoRule: rule,
      };
      d.collections.push(collection);
      created += 1;
    }
    usedIds.add(collection.id);
    for (const book of books) book.collectionId = collection.id;
    resultGroups.push({ id: collection.id, name: collection.name, count: books.length });
  }
  // 删除本次规则下已经空掉的自动文件夹
  for (const id of previousAutoIds) {
    if (usedIds.has(id)) continue;
    const collection = d.collections.find((c) => c.id === id);
    if (!collection) continue;
    const hasBooks = allBooks().some((b) => b.collectionId === id);
    if (!hasBooks) d.collections = d.collections.filter((c) => c.id !== id);
  }
  pruneEmptyAutoCollections();
  save();
  return {
    ok: true,
    mode: rule,
    created,
    assigned: allBooks().length,
    groups: resultGroups.sort((a, b) => b.count - a.count),
  };
}

/** 应用 AI 返回的分组：创建/复用文件夹并移动书籍；清理上一次 AI 分类留下的空文件夹。 */
function applyAiClassify(groups) {
  const list = Array.isArray(groups) ? groups.slice(0, 12) : [];
  if (!list.length) throw new HttpError(400, 'bad_request', '没有可应用的分组');
  const d = store();
  const previousAutoIds = new Set(d.collections.filter((c) => c.autoRule === 'ai').map((c) => c.id));
  const usedIds = new Set();
  const resultGroups = [];
  let assigned = 0;
  for (const group of list) {
    if (!group || typeof group !== 'object') continue;
    const name = cleanCollectionName(group.name);
    if (!name) continue;
    let collection = findCollectionByName(name);
    if (!collection) {
      collection = {
        id: newCollectionId(),
        name,
        createdAt: Date.now(),
        autoRule: 'ai',
      };
      d.collections.push(collection);
    }
    const ids = Array.isArray(group.bookIds) ? group.bookIds.map(String) : [];
    let count = 0;
    for (const id of new Set(ids)) {
      const book = d.books[id];
      if (!book) continue;
      book.collectionId = collection.id;
      count += 1;
    }
    if (!count) continue;
    usedIds.add(collection.id);
    assigned += count;
    resultGroups.push({ id: collection.id, name: collection.name, count });
  }
  if (!resultGroups.length) throw new HttpError(400, 'bad_request', '分组结果为空');
  for (const id of previousAutoIds) {
    if (usedIds.has(id)) continue;
    const hasBooks = allBooks().some((b) => b.collectionId === id);
    if (!hasBooks) d.collections = d.collections.filter((c) => c.id !== id);
  }
  pruneEmptyAutoCollections();
  save();
  return { ok: true, mode: 'ai', assigned, groups: resultGroups.sort((a, b) => b.count - a.count) };
}

function counts() {
  const byFormat = {};
  for (const b of allBooks()) {
    const key = b.format || formatOfExt(b.ext) || 'OTHER';
    byFormat[key] = (byFormat[key] || 0) + 1;
  }
  return { total: allBooks().length, byFormat };
}

function state() {
  return {
    folders: folderList(),
    collections: collectionList(),
    books: sortedBooks().map((b) => ({ ...b, cover: `/api/books/${b.id}/cover?v=${b.mtime}` })),
    settings: { ...store().settings },
    counts: counts(),
  };
}

// ------------------------------------------------------------ 扫描
async function probeSafe(absPath) {
  try {
    const info = await adapter.probe(absPath);
    return info && typeof info === 'object' ? info : {};
  } catch (e) {
    return {};
  }
}

function buildRecord(absPath, st, info, existing) {
  const id = makeId(absPath);
  const ext = extOf(absPath);
  const mtime = Math.round(st.mtimeMs);
  const title =
    (info.title && String(info.title).trim()) || path.basename(absPath, path.extname(absPath));
  return {
    id,
    path: absPath,
    dir: path.dirname(absPath),
    filename: path.basename(absPath),
    ext,
    format: (info.format && String(info.format).toUpperCase()) || formatOfExt(ext),
    title,
    author: info.author ? String(info.author) : '',
    language: info.language ? String(info.language).toLowerCase() : 'zh',
    size: st.size,
    mtime,
    cover: `/api/books/${id}/cover?v=${mtime}`,
    addedAt: existing && existing.addedAt ? existing.addedAt : Date.now(),
    lastReadAt: existing && existing.lastReadAt ? existing.lastReadAt : 0,
    collectionId: existing && existing.collectionId ? existing.collectionId : null,
    progress:
      existing && existing.progress
        ? existing.progress
        : { percent: 0, location: '', page: 1, totalPages: 0 },
    status: 'ready',
    error: null,
  };
}

/**
 * 登记/更新单本（探测 + 记录）。
 * ctx: { seen?:Set, errors?:Array, added?:number, dirty?:boolean }
 */
async function ensureBook(absPath, ctx) {
  const state_ = ctx || {};
  const abs = path.resolve(absPath);
  const id = makeId(abs);
  let st;
  try {
    st = await fs.promises.stat(abs);
  } catch (e) {
    if (Array.isArray(state_.errors)) state_.errors.push({ path: abs, message: '读取文件失败：' + (e.code || e.message) });
    return null;
  }
  if (!st.isFile()) return null;
  const mtime = Math.round(st.mtimeMs);
  const size = st.size;
  const existing = store().books[id];
  if (state_.seen && state_.seen.add) state_.seen.add(id);
  if (existing && existing.path.toLowerCase() === abs.toLowerCase() && existing.mtime === mtime && existing.size === size) {
    return existing;
  }
  const info = await probeSafe(abs);
  const rec = buildRecord(abs, st, info, existing);
  if (!existing) state_.added = (Number(state_.added) || 0) + 1;
  store().books[id] = rec;
  state_.dirty = true;
  // 探测时若 formats 顺带给到封面 Buffer，立即落盘，减少首次 /cover 请求的等待
  if (info.cover && Buffer.isBuffer(info.cover) && info.cover.length) {
    try {
      await cover.saveCoverBuffer(id, info.cover, info.coverMime);
    } catch (e) {
      /* ignore */
    }
  }
  return rec;
}

async function collectFolderFiles(folderPath, ctx, files) {
  const walk = async (dir, depth) => {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (e) {
      ctx.errors.push({ path: dir, message: '无法读取目录：' + (e.code || e.message) });
      return;
    }
    const subdirs = [];
    for (const ent of entries) {
      const name = ent.name;
      if (!name || name[0] === '.') continue; // 隐藏文件/目录
      const abs = path.join(dir, name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(name.toLowerCase())) continue;
        subdirs.push(abs);
      } else if (ent.isFile() && adapter.isSupported(name)) {
        files.push(abs);
      }
    }
    if (depth < MAX_DEPTH) {
      for (const sub of subdirs) await walk(sub, depth + 1);
    }
  };
  await walk(folderPath, 1);
}

async function scanAll() {
  const d = store();
  const ctx = { seen: new Set(), errors: [], added: 0, dirty: false };
  const files = [];
  for (const folder of d.folders) {
    await collectFolderFiles(folder, ctx, files);
  }
  await runPool(files, PROBE_CONCURRENCY, (file) => ensureBook(file, ctx));

  // 移除「属于某个书库文件夹、但磁盘上已不存在」的记录
  let removed = 0;
  for (const [id, b] of Object.entries(d.books)) {
    const underFolder = d.folders.some((f) => isUnderPath(b.path, f));
    if (!underFolder) continue;
    if (ctx.seen.has(id)) continue;
    if (!isFile(b.path)) {
      delete d.books[id];
      cleanupBookAssets(id);
      removed += 1;
      ctx.dirty = true;
    }
  }
  if (ctx.dirty) save();
  return { added: ctx.added, removed, errors: ctx.errors.slice(0, 50), folders: folderList() };
}

// ------------------------------------------------------------ 文件夹增删
async function addFolder(inputPath) {
  const raw = typeof inputPath === 'string' ? inputPath : '';
  const abs = normalizeInputPath(raw);
  if (!abs) throw new HttpError(400, 'bad_request', '缺少文件夹路径');
  let st;
  try {
    st = await fs.promises.stat(abs);
  } catch (e) {
    throw new HttpError(404, 'not_found', '文件夹不存在：' + abs);
  }
  if (!st.isDirectory()) throw new HttpError(400, 'bad_request', '该路径不是文件夹');
  const d = store();
  if (!d.folders.some((f) => f.toLowerCase() === abs.toLowerCase())) d.folders.push(abs);
  const before = new Set(Object.keys(d.books));
  save();

  const ctx = { seen: new Set(), errors: [], added: 0, dirty: false };
  const files = [];
  await collectFolderFiles(abs, ctx, files);
  await runPool(files, PROBE_CONCURRENCY, (file) => ensureBook(file, ctx));
  if (ctx.dirty) save();
  let added = 0;
  for (const id of Object.keys(store().books)) {
    if (!before.has(id) && isUnderPath(store().books[id].path, abs)) added += 1;
  }
  return { folder: folderMeta(abs), added };
}

function removeFolder(inputPath) {
  const abs = normalizeInputPath(typeof inputPath === 'string' ? inputPath : '');
  if (!abs) throw new HttpError(400, 'bad_request', '缺少文件夹路径');
  const d = store();
  const idx = d.folders.findIndex((f) => f.toLowerCase() === abs.toLowerCase());
  if (idx < 0) throw new HttpError(404, 'not_found', '该文件夹不在书库中');
  d.folders.splice(idx, 1);
  let removed = 0;
  for (const [id, b] of Object.entries(d.books)) {
    if (isUnderPath(b.path, abs)) {
      delete d.books[id];
      cleanupBookAssets(id);
      removed += 1;
    }
  }
  save();
  return { ok: true, removed };
}

// ------------------------------------------------------------ 单本 / 导入 / 删除
async function openPath(inputPath) {
  const abs = normalizeInputPath(typeof inputPath === 'string' ? inputPath : '');
  if (!abs) throw new HttpError(400, 'bad_request', '缺少文件路径');
  const st = statSafe(abs);
  if (!st) throw new HttpError(404, 'not_found', '文件不存在：' + abs);
  if (st.isDirectory()) throw new HttpError(400, 'bad_request', '这是一个文件夹，请改为添加书库文件夹');
  if (!adapter.isSupported(abs)) {
    throw new HttpError(415, 'unsupported_format', `不支持的格式：.${extOf(abs) || '未知'}`);
  }
  const ctx = { seen: new Set(), errors: [], added: 0, dirty: false };
  const rec = await ensureBook(abs, ctx);
  if (!rec) throw new HttpError(404, 'not_found', '无法读取该文件');
  if (ctx.dirty) save();
  return rec;
}

async function importBook(filename, stream) {
  const safe = safeFileName(filename);
  if (!safe) throw new HttpError(400, 'bad_request', '缺少文件名（?name=）');
  if (!adapter.isSupported(safe)) {
    throw new HttpError(415, 'unsupported_format', `不支持的格式：.${extOf(safe) || '未知'}`);
  }
  ensureDir(IMPORTED_DIR);
  const dest = path.join(IMPORTED_DIR, `${crypto.randomUUID()}-${safe}`);
  await writeStreamToFile(stream, dest);
  const ctx = { seen: new Set(), errors: [], added: 0, dirty: false };
  const rec = await ensureBook(dest, ctx);
  if (ctx.dirty) save();
  if (!rec) throw new HttpError(500, 'internal', '导入后无法登记该文件');
  return rec;
}

function cleanupBookAssets(id) {
  try {
    fs.rmSync(path.join(BOOKS_CACHE_DIR, id), { recursive: true, force: true });
  } catch (e) {
    /* ignore */
  }
  try {
    cover.removeCover(id);
  } catch (e) {
    /* ignore */
  }
  try {
    bookmarks.removeAll(id);
  } catch (e) {
    /* ignore */
  }
}

function removeBook(id) {
  const d = store();
  const b = d.books[id];
  if (!b) throw new HttpError(404, 'not_found', '书籍不存在');
  delete d.books[id];
  save();
  cleanupBookAssets(id);
  return b;
}

function markOpened(id) {
  const b = getBook(id);
  if (!b) return;
  b.lastReadAt = Date.now();
  save();
}

function updateProgress(id, input) {
  const b = getBook(id);
  if (!b) throw new HttpError(404, 'not_found', '书籍不存在');
  const p = b.progress && typeof b.progress === 'object' ? b.progress : { percent: 0, location: '', page: 1, totalPages: 0 };
  const body = input && typeof input === 'object' ? input : {};
  if (body.percent !== undefined) {
    const n = Number(body.percent);
    p.percent = Number.isFinite(n) ? clamp(n, 0, 1) : 0;
  }
  if (body.location !== undefined) p.location = body.location == null ? '' : String(body.location).slice(0, 2000);
  if (body.page !== undefined) {
    const n = Math.round(Number(body.page));
    p.page = Number.isFinite(n) && n >= 1 ? n : 1;
  }
  if (body.totalPages !== undefined) {
    const n = Math.round(Number(body.totalPages));
    p.totalPages = Number.isFinite(n) && n >= 0 ? n : 0;
  }
  b.progress = p;
  b.lastReadAt = Date.now();
  save();
  return { ...p };
}

function updateSettings(input) {
  store().settings = normalizeSettings(input, store().settings);
  save();
  return { ...store().settings };
}

// ------------------------------------------------------------ 转换 / 准备
const inflightPrepare = new Map();

function cacheMeta(book) {
  const meta = readJson(path.join(BOOKS_CACHE_DIR, book.id, 'meta.json'), null);
  if (!meta || typeof meta !== 'object') return null;
  if (meta.srcMtime !== book.mtime || meta.srcSize !== book.size) return null;
  if (!meta.file || !isFile(meta.file)) return null;
  return meta;
}

function cacheMetaPath(book) {
  return path.join(BOOKS_CACHE_DIR, book.id, 'meta.json');
}

async function doPrepare(book) {
  const fmt = adapter.formatOf(book.path) || formatOfExt(book.ext);
  if (!isFile(book.path)) {
    book.status = 'error';
    book.error = '文件不存在或已被移动';
    save();
    throw new HttpError(404, 'not_found', '文件不存在或已被移动');
  }
  if (fmt === 'PDF' || fmt === 'EPUB') {
    book.status = 'ready';
    book.error = null;
    save();
    return {
      type: fmt === 'PDF' ? 'pdf' : 'epub',
      file: book.path,
      toc: [],
      pageCount: 0,
    };
  }
  const outDir = path.join(BOOKS_CACHE_DIR, book.id);
  ensureDir(outDir);
  const cached = cacheMeta(book);
  if (cached) {
    book.status = 'ready';
    book.error = null;
    save();
    return {
      type: cached.type === 'pdf' ? 'pdf' : 'epub',
      file: cached.file,
      toc: Array.isArray(cached.toc) ? cached.toc : [],
      pageCount: Number(cached.pageCount) || 0,
    };
  }
  book.status = 'converting';
  book.error = null;
  save();
  try {
    const r = await adapter.prepare(book.path, outDir);
    if (r.type !== 'pdf' && r.type !== 'epub') throw new Error('转换模块返回了未知类型');
    if (!isFile(r.file)) throw new Error('转换产物不存在，请重试');
    writeJsonAtomic(cacheMetaPath(book), {
      srcMtime: book.mtime,
      srcSize: book.size,
      type: r.type,
      file: r.file,
      toc: r.toc || [],
      pageCount: Number(r.pageCount) || 0,
      builtAt: Date.now(),
    });
    book.status = 'ready';
    book.error = null;
    save();
    return { type: r.type, file: r.file, toc: r.toc || [], pageCount: Number(r.pageCount) || 0 };
  } catch (e) {
    const msg = e && e.message ? e.message : '转换失败';
    book.status = 'error';
    book.error = msg;
    save();
    throw new HttpError(500, 'prepare_failed', msg);
  }
}

/** 确保可阅读（返回 {type,file,toc,pageCount}）；同一本书并发调用会合并 */
async function prepareBook(id) {
  const book = getBook(id);
  if (!book) throw new HttpError(404, 'not_found', '书籍不存在');
  if (inflightPrepare.has(id)) return inflightPrepare.get(id);
  const task = doPrepare(book).finally(() => inflightPrepare.delete(id));
  inflightPrepare.set(id, task);
  return task;
}

/** 拿到当前可读文件（不触发完整转换时优先复用缓存） */
async function resolveReadable(book) {
  if (!isFile(book.path)) throw new HttpError(404, 'not_found', '文件不存在或已被移动');
  const fmt = adapter.formatOf(book.path) || formatOfExt(book.ext);
  if (fmt === 'PDF') return { type: 'pdf', file: book.path, toc: [], pageCount: 0 };
  if (fmt === 'EPUB') return { type: 'epub', file: book.path, toc: [], pageCount: 0 };
  const cached = cacheMeta(book);
  if (cached) {
    return {
      type: cached.type === 'pdf' ? 'pdf' : 'epub',
      file: cached.file,
      toc: Array.isArray(cached.toc) ? cached.toc : [],
      pageCount: Number(cached.pageCount) || 0,
    };
  }
  return prepareBook(book.id);
}

module.exports = {
  init,
  save,
  state,
  getBook,
  allBooks,
  sortedBooks,
  folderList,
  folderMeta,
  collectionList,
  createCollection,
  renameCollection,
  deleteCollection,
  moveBooks,
  autoClassify,
  applyAiClassify,
  counts,
  scanAll,
  addFolder,
  removeFolder,
  openPath,
  importBook,
  removeBook,
  ensureBook,
  markOpened,
  updateProgress,
  updateSettings,
  prepareBook,
  resolveReadable,
  defaultSettings,
  normalizeSettings,
  buildRecord,
};
