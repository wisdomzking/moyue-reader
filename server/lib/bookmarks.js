'use strict';

/**
 * 书签持久化（data/bookmarks.json，原子写）。
 * 结构：{ "<bookId>": [ {id, cfi, href, percent, label, excerpt, createdAt} ] }
 */

const crypto = require('crypto');
const { BOOKMARKS_FILE, readJson, writeJsonAtomic, ensureDir, DATA_DIR } = require('./util');

let cache = null;

function load() {
  if (cache) return cache;
  ensureDir(DATA_DIR);
  const raw = readJson(BOOKMARKS_FILE, null);
  cache = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return cache;
}

function save() {
  writeJsonAtomic(BOOKMARKS_FILE, cache || {});
}

function normalizeBookmark(input) {
  const bm = input && typeof input === 'object' ? input : {};
  const percent = Number(bm.percent);
  return {
    cfi: bm.cfi ? String(bm.cfi).slice(0, 2000) : '',
    href: bm.href ? String(bm.href).slice(0, 2000) : '',
    percent: Number.isFinite(percent) ? Math.min(1, Math.max(0, percent)) : 0,
    label: bm.label ? String(bm.label).slice(0, 200) : '',
    excerpt: bm.excerpt ? String(bm.excerpt).slice(0, 500) : '',
  };
}

function list(bookId) {
  const all = load();
  const arr = Array.isArray(all[bookId]) ? all[bookId] : [];
  return arr.map((b) => ({ ...b }));
}

function create(bookId, input) {
  const all = load();
  if (!Array.isArray(all[bookId])) all[bookId] = [];
  const bm = {
    id: crypto.randomUUID(),
    ...normalizeBookmark(input),
    createdAt: Date.now(),
  };
  all[bookId].push(bm);
  save();
  return { ...bm };
}

function remove(bookId, bookmarkId) {
  const all = load();
  const arr = Array.isArray(all[bookId]) ? all[bookId] : [];
  const idx = arr.findIndex((b) => b.id === bookmarkId);
  if (idx < 0) return false;
  arr.splice(idx, 1);
  save();
  return true;
}

function removeAll(bookId) {
  const all = load();
  if (!Array.isArray(all[bookId])) return 0;
  const n = all[bookId].length;
  delete all[bookId];
  save();
  return n;
}

module.exports = { list, create, remove, removeAll };
