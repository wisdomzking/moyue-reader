/**
 * 墨阅前端入口：初始化、hash 路由、?open= 直达、全局按钮
 * 路由：#/shelf | #/read/<id> (EPUB) | #/pdf/<id> (PDF)
 */
import { api } from './api.js';
import {
  store, loadState, loadViewPrefs, applyTheme, readLocalSettings, getBook,
} from './store.js';
import { icon, hydrateIcons, logoMark } from './icons.js';
import { toast, isTypingTarget } from './ui.js';
import { initSettings, openSettings } from './settings.js';
import { initBrowse, openBrowse } from './browse.js';
import { initShelf, bindShelfKeys } from './shelf.js';
import { mountEpub } from './epub-reader.js';
import { mountPdf } from './pdf-reader.js';

let currentReader = null;
let currentRoute = '';
let lastRouteWasReader = false;
let settingsOfflineNotified = false;

/* ---------------- 书架动作 ---------------- */

function isPdfRecord(record) {
  if (!record) return false;
  const format = String(record.format || '').toUpperCase();
  const ext = String(record.ext || '').toLowerCase();
  return format === 'PDF' || ext === 'pdf';
}

function openBookRecord(record) {
  if (!record || !record.id) return;
  const hash = (isPdfRecord(record) ? '#/pdf/' : '#/read/') + record.id;
  if (location.hash === hash) {
    // 相同书籍重复点击：直接重新进入
    route(true);
    return;
  }
  location.hash = hash;
}

function openBookFromShelf(book) {
  if (!book) return;
  if (!getBook(book.id)) store.books.unshift(book);
  openBookRecord(book);
}

/** 目录浏览弹窗打开单本后回调 */
async function handleOpenedRecord(record) {
  if (!record) return;
  if (!getBook(record.id)) store.books.unshift(record);
  openBookRecord(record);
}

/** ?open=<绝对路径> */
async function openByPath(path) {
  try {
    const record = await api.openBook(path);
    if (!record || !record.id) throw new Error('无法打开该文件');
    if (!getBook(record.id)) store.books.unshift(record);
    openBookRecord(record);
  } catch (err) {
    toast(err.message || '打开文件失败', 'error', 5000);
    if (location.hash && location.hash !== '#/shelf') location.hash = '#/shelf';
    else showShelf();
  }
}

/* ---------------- 路由 ---------------- */

function destroyReader() {
  if (currentReader) {
    try {
      currentReader.destroy();
    } catch (err) {
      console.warn('[app] 关闭阅读器出错', err);
    }
    currentReader = null;
  }
  const root = document.getElementById('readerRoot');
  if (root) root.innerHTML = '';
}

function showShelf() {
  destroyReader();
  const shell = document.getElementById('appShell');
  if (shell) shell.hidden = false;
  document.body.dataset.route = 'shelf';
  document.title = '墨阅 · 本地电子书阅读器';
  // 注意：ready 仅用于「阅读器首屏就绪」信号（QA 依赖）。
  // 回到书架时由 reader.destroy() 置为 0，这里不要重新置 1。
  if (lastRouteWasReader) {
    lastRouteWasReader = false;
    loadState();
  }
}

async function route(force) {
  const hash = location.hash || '#/shelf';
  const readMatch = /^#\/read\/([^/?#]+)/.exec(hash);
  const pdfMatch = /^#\/pdf\/([^/?#]+)/.exec(hash);

  if (!readMatch && !pdfMatch) {
    if (hash !== '#/shelf' && hash !== '#') {
      // 未知路由回书架
      try {
        history.replaceState(null, '', location.pathname + '#/shelf');
      } catch (_) {
        /* ignore */
      }
    }
    showShelf();
    return;
  }

  let id = '';
  try {
    id = decodeURIComponent((readMatch || pdfMatch)[1]);
  } catch (_) {
    id = (readMatch || pdfMatch)[1];
  }
  if (!id) {
    showShelf();
    return;
  }
  if (!force && currentRoute === hash && currentReader) return;

  destroyReader();
  currentRoute = hash;
  lastRouteWasReader = true;

  const shell = document.getElementById('appShell');
  if (shell) shell.hidden = true;

  const readerRoot = document.getElementById('readerRoot');
  if (!readerRoot) return;

  try {
    currentReader = readMatch ? mountEpub(readerRoot, id) : mountPdf(readerRoot, id);
  } catch (err) {
    console.error('[app] 阅读器挂载失败', err);
    showShelf();
    toast('阅读器加载失败：' + ((err && err.message) || '未知错误'), 'error', 5000);
  }
}

/* ---------------- 启动 ---------------- */

function hydrateStaticIcons() {
  hydrateIcons(document);
  const brandMark = document.getElementById('brandMark');
  if (brandMark) brandMark.innerHTML = logoMark();
  const settingsBtn = document.getElementById('btnSettings');
  if (settingsBtn) settingsBtn.addEventListener('click', () => openSettings());
  const backLinks = document.querySelectorAll('.brand');
  backLinks.forEach((link) => {
    link.addEventListener('click', () => {
      if (location.hash !== '#/shelf' && location.hash !== '') {
        location.hash = '#/shelf';
      }
    });
  });
}

async function start() {
  // 1. 本机设置先行（服务端不可达时也可用）
  const local = readLocalSettings();
  if (local) store.settings = local;
  applyTheme(store.settings.theme);
  loadViewPrefs();

  // 2. 静态图标 + 组件
  hydrateStaticIcons();
  initSettings();
  initBrowse({ openPath: handleOpenedRecord });
  initShelf({
    openBook: openBookFromShelf,
    openBrowse: () => openBrowse(),
  });
  bindShelfKeys();

  // 3. 设置保存失败提示（只提示一次）
  window.addEventListener('moyue:settings-offline', () => {
    if (settingsOfflineNotified) return;
    settingsOfflineNotified = true;
    toast('服务端不可用，阅读设置已保存在本机浏览器', 'warn', 4000);
  });

  // 4. 键盘：Esc 关闭弹窗（阅读器各自处理）
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (isTypingTarget(event.target)) return;
    if (document.body.dataset.route !== 'shelf') return;
    const browseOpen = !document.getElementById('browseBackdrop')?.hidden;
    const settingsOpen = document.getElementById('settingsDrawer')?.classList.contains('is-open');
    if (browseOpen || settingsOpen) event.preventDefault();
  });

  // 5. 路由
  window.addEventListener('hashchange', () => route(false));

  // 6. 首屏数据
  await loadState();
  document.body.dataset.ready = '1';

  // 7. ?open=<绝对路径> 直达
  const params = new URLSearchParams(location.search);
  const openPath = params.get('open');
  if (openPath) {
    const cleanUrl = location.pathname + location.hash;
    try {
      history.replaceState(null, '', cleanUrl);
    } catch (_) {
      /* ignore */
    }
    await openByPath(openPath);
    return;
  }

  const initial = location.hash || '#/shelf';
  if (initial !== '#/shelf' && initial !== '#') {
    await route(false);
  } else {
    showShelf();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}

// 方便调试与 QA
window.__moyue = { store, route, openBookRecord, icon };
