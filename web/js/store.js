/**
 * 应用状态与设置持久化
 * - 设置：服务端 /api/settings 为准，localStorage 兜底（API 不可达时仍可用）
 * - 视图偏好（排序/筛选）存 localStorage
 */
import { api } from './api.js';

export const THEMES = ['light', 'sepia', 'dark'];
export const FONT_FAMILIES = ['serif', 'sans', 'kai', 'system'];
export const PAGE_MODES = ['paginated', 'scroll'];
export const SPREADS = ['auto', 'none'];

export const DEFAULT_SETTINGS = {
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

const SETTINGS_KEY = 'moyue.settings';
const VIEW_KEY = 'moyue.view';

export const store = {
  ready: false,
  loading: true,
  error: null,
  books: [],
  folders: [],
  collections: [],
  counts: { total: 0, byFormat: {} },
  settings: { ...DEFAULT_SETTINGS },
  /** prepare 结果缓存：id -> { type, url, title, author, toc, pageCount } */
  prepared: new Map(),
  view: {
    sort: 'recent',
    format: 'all',
    unreadOnly: false,
    query: '',
    collection: 'all',
  },
  listeners: new Set(),
};

/* ---------------- 设置 ---------------- */

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function sanitizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { ...DEFAULT_SETTINGS };
  if (THEMES.includes(src.theme)) out.theme = src.theme;
  out.fontSize = Math.round(clampNumber(src.fontSize, 12, 40, DEFAULT_SETTINGS.fontSize));
  if (FONT_FAMILIES.includes(src.fontFamily)) out.fontFamily = src.fontFamily;
  out.lineHeight = Math.round(clampNumber(src.lineHeight, 1.2, 3, DEFAULT_SETTINGS.lineHeight) * 10) / 10;
  out.letterSpacing = Math.round(clampNumber(src.letterSpacing, 0, 0.3, DEFAULT_SETTINGS.letterSpacing) * 100) / 100;
  out.paragraphSpacing = Math.round(clampNumber(src.paragraphSpacing, 0, 1.5, DEFAULT_SETTINGS.paragraphSpacing) * 100) / 100;
  out.autoTurnEnabled = Boolean(src.autoTurnEnabled);
  out.autoTurnInterval = Math.round(clampNumber(src.autoTurnInterval, 3, 120, DEFAULT_SETTINGS.autoTurnInterval));
  if (PAGE_MODES.includes(src.pageMode)) out.pageMode = src.pageMode;
  if (SPREADS.includes(src.spread)) out.spread = src.spread;
  out.maxWidth = Math.round(clampNumber(src.maxWidth, 560, 1200, DEFAULT_SETTINGS.maxWidth) / 10) * 10;
  if (src.pdfZoom === 'fit' || src.pdfZoom === 'page') {
    out.pdfZoom = src.pdfZoom;
  } else if (typeof src.pdfZoom === 'string' && /^\d{2,3}$/.test(src.pdfZoom)) {
    out.pdfZoom = src.pdfZoom;
  } else if (typeof src.pdfZoom === 'number' && src.pdfZoom > 0) {
    out.pdfZoom = String(Math.round(src.pdfZoom));
  }
  return out;
}

export function readLocalSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return null;
    return sanitizeSettings(JSON.parse(raw));
  } catch (_) {
    return null;
  }
}

export function applyTheme(theme) {
  const next = THEMES.includes(theme) ? theme : DEFAULT_SETTINGS.theme;
  document.documentElement.setAttribute('data-theme', next);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const colors = { light: '#f5f2ec', sepia: '#efe4d2', dark: '#121416' };
    meta.setAttribute('content', colors[next] || colors.light);
  }
}

function writeLocalSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (_) {
    /* 隐私模式等场景忽略 */
  }
}

let saveTimer = 0;
let saveSeq = 0;

function scheduleServerSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const seq = ++saveSeq;
    try {
      await api.putSettings(store.settings);
    } catch (err) {
      if (seq === saveSeq) {
        // 不打断阅读，仅提示一次：设置仍保存在本机
        const evt = new CustomEvent('moyue:settings-offline');
        window.dispatchEvent(evt);
      }
    }
  }, 320);
}

/**
 * 更新设置（局部），即时生效并持久化。
 * @param {object} patch
 * @param {{silent?: boolean}} [opts]
 */
export function updateSettings(patch, opts = {}) {
  store.settings = sanitizeSettings({ ...store.settings, ...patch });
  applyTheme(store.settings.theme);
  writeLocalSettings(store.settings);
  if (!opts.silent) scheduleServerSave();
  emit({ type: 'settings', settings: store.settings, patch });
  return store.settings;
}

/* ---------------- 视图偏好 ---------------- */

export function loadViewPrefs() {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    if (!raw) return;
    const v = JSON.parse(raw);
    if (typeof v.sort === 'string') store.view.sort = v.sort;
    if (typeof v.format === 'string') store.view.format = v.format;
    if (typeof v.unreadOnly === 'boolean') store.view.unreadOnly = v.unreadOnly;
    if (typeof v.collection === 'string') store.view.collection = v.collection;
  } catch (_) {
    /* ignore */
  }
}

export function saveViewPrefs() {
  try {
    localStorage.setItem(
      VIEW_KEY,
      JSON.stringify({
        sort: store.view.sort,
        format: store.view.format,
        unreadOnly: store.view.unreadOnly,
        collection: store.view.collection,
      })
    );
  } catch (_) {
    /* ignore */
  }
}

/* ---------------- 书库数据 ---------------- */

/** 拉取 /api/state（一次拿全量）。成功返回 true，失败写 store.error 返回 false */
export async function loadState() {
  store.loading = true;
  emit({ type: 'loading' });
  try {
    const data = await api.state();
    store.books = Array.isArray(data.books) ? data.books : [];
    store.folders = Array.isArray(data.folders) ? data.folders : [];
    store.collections = Array.isArray(data.collections) ? data.collections : [];
    store.counts = data.counts || { total: store.books.length, byFormat: {} };
    // 服务端设置优先；若服务端返回空对象则保留本机设置
    const serverSettings = data.settings && Object.keys(data.settings).length ? data.settings : null;
    store.settings = sanitizeSettings(serverSettings || store.settings);
    writeLocalSettings(store.settings);
    applyTheme(store.settings.theme);
    store.error = null;
    store.loading = false;
    store.ready = true;
    emit({ type: 'state' });
    return true;
  } catch (err) {
    store.loading = false;
    store.error = err;
    emit({ type: 'error', error: err });
    return false;
  }
}

export function getBook(id) {
  return store.books.find((b) => b.id === id) || null;
}

/** 本地更新某本书的进度（避免为了刷新书架再次请求） */
export function patchBookProgress(id, progress) {
  const book = getBook(id);
  if (!book) return;
  book.progress = { ...(book.progress || {}), ...progress };
  book.lastReadAt = Date.now();
}

/* ---------------- 订阅 ---------------- */

export function subscribe(fn) {
  store.listeners.add(fn);
  return () => store.listeners.delete(fn);
}

function emit(event) {
  store.listeners.forEach((fn) => {
    try {
      fn(event);
    } catch (err) {
      console.error('[store] listener error', err);
    }
  });
}

export { emit };
