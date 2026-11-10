/**
 * 书架：继续阅读 / 网格 / 排序筛选 / 搜索 / 空态骨架屏 / 拖拽导入 / 右键菜单
 */
import { api } from './api.js';
import { store, loadState, saveViewPrefs, subscribe, getBook } from './store.js';
import { icon, emptyIllustration } from './icons.js';
import {
  el, clearNode, toast, formatBytes, formatRelative, formatPercent,
  coverPlaceholder, clamp, looksLikeBook, isTypingTarget, confirmAction,
} from './ui.js';
import { openSettings } from './settings.js';

const collator = new Intl.Collator('zh-Hans', { numeric: true, sensitivity: 'base' });

const handlers = {
  openBook: null,
  openBrowse: null,
};

let gridEl = null;
let continueRow = null;
let continueSection = null;
let continueSub = null;
let toolbar = null;
let chipsEl = null;
let sortEl = null;
let unreadBtn = null;
let countEl = null;
let emptyEl = null;
let errorEl = null;
let searchInput = null;
let searchClear = null;
let dropDepth = 0;
let ctxBook = null;
let ctxEl = null;
let collectionTabsEl = null;
let shelfTitleEl = null;
let collectionDialogBackdrop = null;
let collectionNameInput = null;
let collectionDialogHint = null;
let collectionDialogSubmit = null;
let moveDialogBackdrop = null;
let moveDialogSub = null;
let collectionPickList = null;
let manageDialogBackdrop = null;
let collectionManageList = null;
let autoClassifyBackdrop = null;
let autoClassifyHint = null;
let collectionDialogMode = 'create';
let editingCollectionId = null;
let pendingMoveIds = [];
let pendingCreateThenMove = false;
let autoClassifyBusy = false;

export function initShelf(options = {}) {
  handlers.openBook = options.openBook || null;
  handlers.openBrowse = options.openBrowse || null;

  gridEl = document.getElementById('shelfGrid');
  continueRow = document.getElementById('continueRow');
  continueSection = document.getElementById('continueSection');
  continueSub = document.getElementById('continueSub');
  toolbar = document.getElementById('shelfToolbar');
  chipsEl = document.getElementById('formatChips');
  sortEl = document.getElementById('sortSelect');
  unreadBtn = document.getElementById('unreadToggle');
  countEl = document.getElementById('shelfCount');
  emptyEl = document.getElementById('shelfEmpty');
  errorEl = document.getElementById('shelfError');
  searchInput = document.getElementById('shelfSearch');
  searchClear = document.getElementById('searchClear');
  ctxEl = document.getElementById('ctxMenu');
  collectionTabsEl = document.getElementById('collectionTabs');
  shelfTitleEl = document.getElementById('shelfTitle');
  collectionDialogBackdrop = document.getElementById('collectionDialogBackdrop');
  collectionNameInput = document.getElementById('collectionNameInput');
  collectionDialogHint = document.getElementById('collectionDialogHint');
  collectionDialogSubmit = document.getElementById('collectionDialogSubmit');
  moveDialogBackdrop = document.getElementById('moveDialogBackdrop');
  moveDialogSub = document.getElementById('moveDialogSub');
  collectionPickList = document.getElementById('collectionPickList');
  manageDialogBackdrop = document.getElementById('manageDialogBackdrop');
  collectionManageList = document.getElementById('collectionManageList');
  autoClassifyBackdrop = document.getElementById('autoClassifyBackdrop');
  autoClassifyHint = document.getElementById('autoClassifyHint');

  bindToolbar();
  bindSearch();
  bindDrop();
  bindFilePicker();
  bindCtxDismiss();
  bindCollectionDialogs();
  hydrateShelfIcons();

  subscribe((event) => {
    if (event.type === 'error' && store.ready && event.error) {
      // 首次加载失败由错误页呈现；刷新失败时用 toast 提示，已有书库保持可见
      toast(event.error.message || '刷新书库失败', 'error', 4000);
    }
    if (event.type === 'state' || event.type === 'loading' || event.type === 'error') renderShelf();
  });

  renderShelf();
}

function hydrateShelfIcons() {
  document.querySelectorAll('#shelfEmpty [data-icon], .continue-empty [data-icon]').forEach((node) => {
    node.innerHTML = icon(node.dataset.icon, Number(node.dataset.iconSize || 18));
  });
}

/* ---------------- 过滤与排序 ---------------- */

export function visibleBooks() {
  let list = store.books.slice();
  const query = (store.view.query || '').trim().toLowerCase();
  if (query) {
    list = list.filter((book) => {
      const hay = `${book.title || ''} ${book.author || ''} ${book.filename || ''}`.toLowerCase();
      return hay.includes(query);
    });
  }
  if (store.view.format && store.view.format !== 'all') {
    list = list.filter((book) => book.format === store.view.format);
  }
  if (store.view.unreadOnly) {
    list = list.filter((book) => !book.lastReadAt);
  }
  const collection = store.view.collection || 'all';
  if (collection === 'unfiled') {
    list = list.filter((book) => !book.collectionId);
  } else if (collection !== 'all') {
    list = list.filter((book) => book.collectionId === collection);
  }
  switch (store.view.sort) {
    case 'added':
      list.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
      break;
    case 'title':
      list.sort((a, b) => collator.compare(a.title || a.filename || '', b.title || b.filename || ''));
      break;
    case 'author':
      list.sort((a, b) => collator.compare(a.author || 'zzz', b.author || 'zzz'));
      break;
    case 'recent':
    default:
      list.sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0) || (b.addedAt || 0) - (a.addedAt || 0));
      break;
  }
  return list;
}

function readingBooks() {
  return store.books
    .filter((book) => (book.lastReadAt || 0) > 0)
    .sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0))
    .slice(0, 3);
}

/* ---------------- 总渲染 ---------------- */

export function renderShelf() {
  if (!gridEl) return;

  // 顶栏/工具栏同步
  if (sortEl) sortEl.value = store.view.sort;
  if (unreadBtn) unreadBtn.setAttribute('aria-pressed', store.view.unreadOnly ? 'true' : 'false');
  if (searchInput && searchInput.value !== store.view.query) searchInput.value = store.view.query;
  if (searchClear) searchClear.hidden = !store.view.query;
  hydrateShelfIcons();

  if (store.loading && !store.ready) {
    continueSection.hidden = true;
    toolbar.hidden = false;
    emptyEl.hidden = true;
    errorEl.hidden = true;
    renderSkeleton();
    return;
  }

  if (store.error && !store.ready) {
    continueSection.hidden = true;
    toolbar.hidden = true;
    gridEl.hidden = true;
    emptyEl.hidden = true;
    errorEl.hidden = false;
    renderError(store.error);
    return;
  }

  errorEl.hidden = true;

  if (!store.books.length) {
    continueSection.hidden = true;
    toolbar.hidden = true;
    gridEl.hidden = true;
    gridEl.innerHTML = '';
    emptyEl.hidden = false;
    renderEmpty();
    renderCollectionBar();
    return;
  }

  // 选中的文件夹被删除后回到「全部」
  if (
    store.view.collection &&
    store.view.collection !== 'all' &&
    store.view.collection !== 'unfiled' &&
    !store.collections.some((c) => c.id === store.view.collection)
  ) {
    store.view.collection = 'all';
    saveViewPrefs();
  }

  emptyEl.hidden = true;
  gridEl.hidden = false;
  renderCollectionBar();
  // 筛选/搜索时隐藏「继续阅读」，避免与筛选结果混淆
  const filtering =
    !!store.view.query ||
    store.view.format !== 'all' ||
    store.view.unreadOnly ||
    (store.view.collection || 'all') !== 'all';
  continueSection.hidden = filtering;
  toolbar.hidden = false;

  if (shelfTitleEl) {
    if (store.view.collection === 'unfiled') shelfTitleEl.textContent = '未分类书籍';
    else if (store.view.collection && store.view.collection !== 'all') {
      const active = store.collections.find((c) => c.id === store.view.collection);
      shelfTitleEl.textContent = active ? active.name : '全部书籍';
    } else shelfTitleEl.textContent = '全部书籍';
  }

  if (!filtering) renderContinue();
  renderChips();
  renderGrid();
}

/* ---------------- 继续阅读 ---------------- */

function renderContinue() {
  const books = readingBooks();
  clearNode(continueRow);
  if (continueSub) {
    continueSub.textContent = books.length ? `最近打开的 ${books.length} 本` : '从书架里挑一本开始';
  }
  if (!books.length) {
    continueRow.appendChild(
      el('div', { class: 'continue-empty' }, [
        el('span', { class: 'continue-empty-art', html: icon('book-open', 22) }),
        el('div', { class: 'continue-empty-text' }, [
          el('strong', { text: '开始你的第一本书' }),
          el('span', { text: '打开任意一本，墨阅会记住你的阅读位置和进度。' }),
        ]),
      ])
    );
    return;
  }
  books.forEach((book) => continueRow.appendChild(continueCard(book)));
}

function continueCard(book) {
  const percent = clamp(Number(book.progress && book.progress.percent) || 0, 0, 1);
  const cover = coverNode(book, 'cc-cover');
  const card = el('div', {
    class: 'continue-card',
    role: 'button',
    tabindex: '0',
    'data-book-id': book.id,
    'data-format': book.format || '',
    'aria-label': `继续阅读 ${book.title || book.filename}`,
    onclick: () => openBook(book),
    onkeydown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openBook(book);
      }
    },
  }, [
    cover,
    el('div', { class: 'cc-body' }, [
      el('span', { class: 'cc-kicker', text: `上次阅读 ${formatRelative(book.lastReadAt)}` }),
      el('div', { class: 'cc-title', text: book.title || book.filename || '未命名' }),
      el('div', { class: 'cc-author', text: book.author || '未知作者' }),
      el('div', { class: 'cc-foot' }, [
        el('div', { class: 'cc-bar' }, [
          el('div', { class: 'cc-bar-fill', style: { width: `${Math.max(percent * 100, 2)}%` } }),
        ]),
        el('div', { class: 'cc-meta' }, [
          el('span', { text: `已读 ${formatPercent(percent)}` }),
          el('span', { class: 'cc-go' }, [
            el('span', { text: '继续' }),
            el('span', { html: icon('arrow-right', 13) }),
          ]),
        ]),
      ]),
    ]),
  ]);
  return card;
}

/* ---------------- 卡片 ---------------- */

function coverNode(book, className = 'card-cover') {
  const wrap = el('div', { class: className });
  wrap.appendChild(coverPlaceholder(book));
  if (book.cover) {
    const img = el('img', {
      class: 'cover-img',
      src: book.cover,
      alt: '',
      loading: 'lazy',
      decoding: 'async',
      style: { position: 'absolute', inset: '0' },
      onerror: () => img.remove(),
    });
    wrap.appendChild(img);
  }
  return wrap;
}

function bookCard(book) {
  const percent = clamp(Number(book.progress && book.progress.percent) || 0, 0, 1);
  const cover = coverNode(book);

  cover.appendChild(el('span', { class: 'fmt-badge', text: book.format || 'BOOK' }));
  if (percent > 0.0005) {
    cover.appendChild(
      el('div', { class: 'cover-progress', 'data-testid': 'book-progress' }, [
        el('div', { class: 'cover-progress-fill', style: { width: `${(percent * 100).toFixed(1)}%` } }),
      ])
    );
  } else {
    cover.appendChild(el('div', { class: 'cover-progress', 'data-testid': 'book-progress', hidden: true }));
  }

  const menuBtn = el('button', {
    class: 'card-menu-btn',
    type: 'button',
    title: '更多操作',
    'aria-label': '更多操作',
    html: icon('more', 16),
    onclick: (e) => {
      e.stopPropagation();
      showCtxMenu(book, menuBtn);
    },
  });
  cover.appendChild(menuBtn);

  const authorText = book.author || '未知作者';
  const author = el('div', { class: `card-author${book.author ? '' : ' is-empty'}` }, [
    !book.lastReadAt && percent === 0 ? el('span', { class: 'card-unread-dot' }) : null,
    el('span', { text: authorText }),
  ]);

  const card = el('article', {
    class: 'book-card',
    tabindex: '0',
    role: 'button',
    'data-book-id': book.id,
    'data-format': book.format || '',
    'aria-label': `打开 ${book.title || book.filename}`,
    title: `${book.title || book.filename}\n${authorText}${book.size ? ' · ' + formatBytes(book.size) : ''}`,
    onclick: () => openBook(book),
    onkeydown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openBook(book);
      }
    },
    oncontextmenu: (e) => {
      e.preventDefault();
      showCtxMenu(book, card);
    },
  }, [cover, el('div', { class: 'card-title', text: book.title || book.filename || '未命名' }), author]);

  return card;
}

function renderGrid() {
  const list = visibleBooks();
  clearNode(gridEl);
  if (!list.length) {
    gridEl.hidden = true;
    emptyEl.hidden = false;
    renderFilteredEmpty();
    updateCount(0);
    return;
  }
  gridEl.hidden = false;
  emptyEl.hidden = true;
  const frag = document.createDocumentFragment();
  list.forEach((book) => frag.appendChild(bookCard(book)));
  gridEl.appendChild(frag);
  updateCount(list.length);
}

function updateCount(visible) {
  if (!countEl) return;
  const total = store.books.length;
  const filtering =
    !!store.view.query ||
    store.view.format !== 'all' ||
    store.view.unreadOnly ||
    (store.view.collection || 'all') !== 'all';
  if (filtering) {
    countEl.textContent = `${visible} / ${total} 本`;
  } else {
    countEl.textContent = `${total} 本`;
  }
}

/* ---------------- 骨架屏 ---------------- */

function renderSkeleton() {
  clearNode(gridEl);
  gridEl.hidden = false;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 12; i++) {
    frag.appendChild(
      el('div', { class: 'skeleton-card' }, [
        el('div', { class: 'sk-cover' }),
        el('div', { class: 'sk-line' }),
        el('div', { class: 'sk-line is-short' }),
      ])
    );
  }
  gridEl.appendChild(frag);
  if (countEl) countEl.textContent = '正在加载…';
}

/* ---------------- 空态 / 错误 ---------------- */

function renderEmpty() {
  clearNode(emptyEl);
  emptyEl.appendChild(el('div', { html: emptyIllustration() }));
  emptyEl.appendChild(el('h3', { class: 'empty-title', text: '书架还空着' }));
  emptyEl.appendChild(
    el('p', {
      class: 'empty-text',
      text: '把电脑里的电子书加进来。墨阅只记录文件路径，不会复制或搬运你的原文件。',
    })
  );
  emptyEl.appendChild(
    el('div', { class: 'empty-actions' }, [
      el('button', {
        class: 'btn btn-primary',
        type: 'button',
        html: `${icon('folder-plus', 17)}<span>添加文件夹</span>`,
        onclick: () => handlers.openBrowse && handlers.openBrowse(),
      }),
      el('button', {
        class: 'btn btn-ghost',
        type: 'button',
        html: `${icon('file-plus', 17)}<span>添加文件</span>`,
        onclick: () => document.getElementById('filePicker')?.click(),
      }),
    ])
  );
  emptyEl.appendChild(
    el('p', {
      class: 'empty-note',
      text: '支持 EPUB · PDF · MOBI · AZW3 · DOCX · TXT · MD · HTML · FB2 等格式',
    })
  );
}

function renderFilteredEmpty() {
  clearNode(emptyEl);
  const folderFilter =
    store.view.collection && store.view.collection !== 'all' && store.view.collection !== 'unfiled';
  emptyEl.appendChild(
    el('div', { class: 'empty-badge' }, [el('span', { html: icon(folderFilter ? 'folder' : 'search', 26) })])
  );
  if (
    folderFilter &&
    !store.view.query &&
    store.view.format === 'all' &&
    !store.view.unreadOnly
  ) {
    const collection = (store.collections || []).find((c) => c.id === store.view.collection);
    emptyEl.appendChild(el('h3', { class: 'empty-title', text: '这个文件夹还是空的' }));
    emptyEl.appendChild(
      el('p', { class: 'empty-text', text: `在「全部书籍」里右键一本书 →「移动到文件夹…」，把它放进「${collection ? collection.name : '这个文件夹'}」。` })
    );
    emptyEl.appendChild(
      el('div', { class: 'empty-actions' }, [
        el('button', {
          class: 'btn btn-primary',
          type: 'button',
          text: '去全部书籍',
          onclick: () => {
            store.view.collection = 'all';
            saveViewPrefs();
            renderShelf();
          },
        }),
      ])
    );
    return;
  }
  emptyEl.appendChild(el('h3', { class: 'empty-title', text: '没有符合条件的书' }));
  emptyEl.appendChild(
    el('p', { class: 'empty-text', text: '试试换个关键词，或清除格式 / 文件夹 / 未读筛选。' })
  );
  emptyEl.appendChild(
    el('div', { class: 'empty-actions' }, [
      el('button', {
        class: 'btn btn-ghost',
        type: 'button',
        text: '清除筛选',
        onclick: () => {
          store.view.query = '';
          store.view.format = 'all';
          store.view.unreadOnly = false;
          store.view.collection = 'all';
          saveViewPrefs();
          if (searchInput) searchInput.value = '';
          if (searchClear) searchClear.hidden = true;
          renderShelf();
        },
      }),
    ])
  );
}

function renderError(error) {
  clearNode(errorEl);
  errorEl.appendChild(
    el('div', { class: 'error-badge' }, [el('span', { html: icon('alert', 26) })])
  );
  errorEl.appendChild(el('h3', { text: '无法连接墨阅服务' }));
  errorEl.appendChild(
    el('p', {
      text: (error && error.message) || '请确认本地服务已启动后重试。',
    })
  );
  errorEl.appendChild(
    el('code', { text: '双击运行「启动墨阅.cmd」，或执行 node server/server.js' })
  );
  errorEl.appendChild(
    el('div', { class: 'empty-actions' }, [
      el('button', {
        class: 'btn btn-primary',
        type: 'button',
        text: '重试',
        onclick: () => loadState(),
      }),
      el('button', {
        class: 'btn btn-ghost',
        type: 'button',
        text: '阅读设置',
        onclick: () => openSettings(),
      }),
    ])
  );
}

/* ---------------- 工具条 ---------------- */

function formatList() {
  const byFormat = store.counts && store.counts.byFormat ? store.counts.byFormat : {};
  const formats = Object.keys(byFormat);
  const preferred = ['EPUB', 'PDF', 'MOBI', 'AZW3', 'DOCX', 'DOC', 'TXT', 'MD', 'HTML', 'FB2'];
  formats.sort((a, b) => {
    const ia = preferred.indexOf(a);
    const ib = preferred.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return collator.compare(a, b);
  });
  return formats;
}

function renderChips() {
  if (!chipsEl) return;
  const formats = formatList();
  const total = store.books.length;
  const active = store.view.format || 'all';
  clearNode(chipsEl);

  const makeChip = (value, label, count, attrValue) => {
    const chip = el('button', {
      class: `chip${active === value ? ' is-active' : ''}`,
      type: 'button',
      'data-format-filter': attrValue || value,
      'aria-pressed': active === value ? 'true' : 'false',
      onclick: () => {
        store.view.format = value;
        saveViewPrefs();
        renderShelf();
      },
    }, [el('span', { text: label })]);
    if (typeof count === 'number') {
      chip.appendChild(el('span', { class: 'chip-count', text: String(count) }));
    }
    return chip;
  };

  chipsEl.appendChild(makeChip('all', '全部', total, 'ALL'));
  formats.forEach((format) => {
    chipsEl.appendChild(makeChip(format, format, store.counts.byFormat[format] || 0, format));
  });
}

/* ---------------- 书架文件夹 ---------------- */

function showBackdrop(node) {
  if (!node) return;
  node.hidden = false;
  requestAnimationFrame(() => node.classList.add('is-open'));
}

function hideBackdrop(node) {
  if (!node) return;
  node.classList.remove('is-open');
  node.hidden = true;
}

function collectionName(id) {
  if (id === 'unfiled') return '未分类';
  if (id === 'all') return '全部书籍';
  const found = (store.collections || []).find((c) => c.id === id);
  return found ? found.name : '全部书籍';
}

function renderCollectionBar() {
  if (!collectionTabsEl) return;
  const active = store.view.collection || 'all';
  const total = store.books.length;
  const unfiled = store.books.filter((book) => !book.collectionId).length;
  clearNode(collectionTabsEl);

  const makeChip = (value, label, count, iconName) => {
    const chip = el('button', {
      class: `collection-chip${active === value ? ' is-active' : ''}`,
      type: 'button',
      role: 'tab',
      'aria-selected': active === value ? 'true' : 'false',
      'data-collection': value,
      onclick: () => {
        store.view.collection = value;
        saveViewPrefs();
        renderShelf();
      },
    });
    if (iconName) chip.appendChild(el('span', { class: 'collection-chip-ico', html: icon(iconName, 14) }));
    chip.appendChild(el('span', { class: 'collection-chip-name', text: label }));
    chip.appendChild(el('span', { class: 'collection-chip-count', text: String(count) }));
    if (value !== 'all' && value !== 'unfiled') {
      chip.title = '右键可重命名 / 删除';
      chip.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        const collection = (store.collections || []).find((c) => c.id === value);
        if (collection) showCollectionCtxMenu(collection, chip);
      });
    }
    return chip;
  };

  collectionTabsEl.appendChild(makeChip('all', '全部', total, 'book-open'));
  (store.collections || []).forEach((collection) => {
    const count = store.books.filter((book) => book.collectionId === collection.id).length;
    collectionTabsEl.appendChild(makeChip(collection.id, collection.name, count, 'folder'));
  });
  if (unfiled || (store.collections || []).length) {
    collectionTabsEl.appendChild(makeChip('unfiled', '未分类', unfiled, 'file-plus'));
  }
}

function showCollectionCtxMenu(collection, anchor) {
  if (!ctxEl) return;
  ctxBook = null;
  clearNode(ctxEl);
  ctxEl.hidden = false;
  ctxEl.setAttribute('role', 'menu');

  const item = (label, iconName, onClick, extraClass) =>
    el('button', {
      class: `ctx-item${extraClass ? ' ' + extraClass : ''}`,
      type: 'button',
      role: 'menuitem',
      html: `${icon(iconName, 16)}<span>${label}</span>`,
      onclick: () => {
        hideCtxMenu();
        onClick();
      },
    });

  ctxEl.appendChild(el('div', { class: 'ctx-label', text: collection.name }));
  ctxEl.appendChild(item('重命名文件夹', 'edit', () => openCollectionDialog('rename', collection)));
  ctxEl.appendChild(
    item(
      '删除文件夹',
      'trash',
      async () => {
        const ok = await confirmAction({
          title: '删除文件夹',
          message: `「${collection.name}」中的书籍会回到「未分类」，磁盘上的原文件不会被删除。`,
          confirmText: '删除文件夹',
          danger: true,
        });
        if (!ok) return;
        try {
          const res = await api.deleteCollection(collection.id);
          await loadState();
          toast(`已删除文件夹${res && res.movedToUnfiled ? `，${res.movedToUnfiled} 本书回到未分类` : ''}`, 'success');
        } catch (err) {
          toast(err.message || '删除失败', 'error');
        }
      },
      'is-danger'
    )
  );

  const rect = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
  const menuRect = ctxEl.getBoundingClientRect();
  let left = rect ? rect.left : 100;
  let top = rect ? rect.bottom + 6 : 100;
  if (left + menuRect.width > window.innerWidth - 8) left = window.innerWidth - menuRect.width - 8;
  if (top + menuRect.height > window.innerHeight - 8) top = rect ? rect.top - menuRect.height - 6 : window.innerHeight - menuRect.height - 8;
  if (left < 8) left = 8;
  if (top < 8) top = 8;
  ctxEl.style.left = `${Math.round(left)}px`;
  ctxEl.style.top = `${Math.round(top)}px`;
  const first = ctxEl.querySelector('.ctx-item');
  if (first) first.focus({ preventScroll: true });
}

function openCollectionDialog(mode, collection) {
  if (!collectionDialogBackdrop) return;
  collectionDialogMode = mode === 'rename' ? 'rename' : 'create';
  editingCollectionId = collection ? collection.id : null;
  const title = document.getElementById('collectionDialogTitle');
  const sub = document.getElementById('collectionDialogSub');
  const submit = collectionDialogSubmit;
  const input = collectionNameInput;
  if (title) title.textContent = collectionDialogMode === 'rename' ? '重命名文件夹' : '新建文件夹';
  if (sub) {
    sub.textContent =
      collectionDialogMode === 'rename'
        ? '改名不会移动或删除书籍'
        : '给书架建一个分类文件夹，之后可以把书拖进来或右键移动';
  }
  if (submit) submit.textContent = collectionDialogMode === 'rename' ? '保存' : '创建';
  if (input) input.value = collectionDialogMode === 'rename' && collection ? collection.name : '';
  if (collectionDialogHint) collectionDialogHint.textContent = '';
  showBackdrop(collectionDialogBackdrop);
  window.setTimeout(() => input && input.focus(), 30);
}

function closeCollectionDialog() {
  if (!collectionDialogBackdrop) return;
  hideBackdrop(collectionDialogBackdrop);
  collectionDialogMode = 'create';
  editingCollectionId = null;
  if (collectionDialogHint) collectionDialogHint.textContent = '';
}

async function submitCollectionDialog() {
  if (!collectionNameInput) return;
  const name = collectionNameInput.value.trim();
  if (!name) {
    if (collectionDialogHint) collectionDialogHint.textContent = '请输入文件夹名称';
    collectionNameInput.focus();
    return;
  }
  if (collectionDialogSubmit) collectionDialogSubmit.disabled = true;
  try {
    let created = null;
    if (collectionDialogMode === 'rename' && editingCollectionId) {
      await api.renameCollection(editingCollectionId, name);
      toast('文件夹已重命名', 'success');
    } else {
      const res = await api.createCollection(name);
      created = res && res.collection ? res.collection : null;
    }
    const moveIds = pendingCreateThenMove ? pendingMoveIds.slice() : [];
    pendingCreateThenMove = false;
    pendingMoveIds = [];
    await loadState();
    closeCollectionDialog();
    if (created) {
      if (moveIds.length) {
        await api.moveBooks(moveIds, created.id);
        await loadState();
        toast(`已新建「${created.name}」并移入 ${moveIds.length} 本书`, 'success');
      } else {
        renderShelf();
        toast(`已创建文件夹「${created.name}」`, 'success');
      }
    }
  } catch (err) {
    if (collectionDialogHint) collectionDialogHint.textContent = err.message || '操作失败';
  } finally {
    if (collectionDialogSubmit) collectionDialogSubmit.disabled = false;
  }
}

function openMoveDialog(books) {
  if (!moveDialogBackdrop || !collectionPickList) return;
  pendingMoveIds = (Array.isArray(books) ? books : [books]).filter(Boolean).map((book) => book.id);
  if (!pendingMoveIds.length) return;
  const label = books && books.length > 1 ? `${books.length} 本书` : (books[0] && (books[0].title || books[0].filename)) || '';
  if (moveDialogSub) moveDialogSub.textContent = label ? `选择目标文件夹：${label}` : '选择目标文件夹';
  renderMoveList();
  showBackdrop(moveDialogBackdrop);
}

function renderMoveList() {
  if (!collectionPickList) return;
  clearNode(collectionPickList);
  const options = [{ id: '', name: '未分类', count: store.books.filter((book) => !book.collectionId).length }];
  (store.collections || []).forEach((collection) => {
    options.push({
      id: collection.id,
      name: collection.name,
      count: store.books.filter((book) => book.collectionId === collection.id).length,
    });
  });
  options.forEach((option) => {
    const row = el('button', {
      class: 'collection-pick-item',
      type: 'button',
      onclick: async () => {
        try {
          await api.moveBooks(pendingMoveIds, option.id || null);
          const count = pendingMoveIds.length;
          pendingMoveIds = [];
          closeMoveDialog();
          await loadState();
          toast(option.id ? `已移入「${option.name}」` : `已移回「未分类」`, 'success');
          if (option.id && store.view.collection === 'all') {
            /* 停留在当前视图 */
          } else if (!option.id && store.view.collection === 'unfiled') {
            /* 保持视图 */
          }
          void count;
        } catch (err) {
          toast(err.message || '移动失败', 'error');
        }
      },
    }, [
      el('span', { class: 'collection-pick-ico', html: icon(option.id ? 'folder' : 'file-plus', 16) }),
      el('span', { class: 'collection-pick-name', text: option.name }),
      el('span', { class: 'collection-pick-count', text: `${option.count} 本` }),
    ]);
    collectionPickList.appendChild(row);
  });
}

function closeMoveDialog() {
  hideBackdrop(moveDialogBackdrop);
  pendingMoveIds = [];
  pendingCreateThenMove = false;
}

function openManageDialog() {
  if (!manageDialogBackdrop) return;
  renderManageList();
  showBackdrop(manageDialogBackdrop);
}

function closeManageDialog() {
  hideBackdrop(manageDialogBackdrop);
}

function renderManageList() {
  if (!collectionManageList) return;
  clearNode(collectionManageList);
  const collections = store.collections || [];
  if (!collections.length) {
    collectionManageList.appendChild(
      el('p', { class: 'collection-manage-empty', text: '还没有文件夹。点下方「新建文件夹」开始整理书架。' })
    );
    return;
  }
  collections.forEach((collection) => {
    const count = store.books.filter((book) => book.collectionId === collection.id).length;
    const row = el('div', { class: 'collection-manage-row' }, [
      el('span', { class: 'collection-manage-ico', html: icon('folder', 16) }),
      el('span', { class: 'collection-manage-name', text: collection.name }),
      el('span', { class: 'collection-manage-count', text: `${count} 本` }),
      el('button', {
        class: 'btn btn-icon btn-ghost btn-xs',
        type: 'button',
        title: '重命名',
        'aria-label': '重命名',
        html: icon('edit', 15),
        onclick: () => {
          closeManageDialog();
          openCollectionDialog('rename', collection);
        },
      }),
      el('button', {
        class: 'btn btn-icon btn-ghost btn-xs is-danger',
        type: 'button',
        title: '删除',
        'aria-label': '删除',
        html: icon('trash', 15),
        onclick: async () => {
          const ok = await confirmAction({
            title: '删除文件夹',
            message: `「${collection.name}」中的书籍会回到「未分类」，磁盘上的原文件不会被删除。`,
            confirmText: '删除文件夹',
            danger: true,
          });
          if (!ok) return;
          try {
            await api.deleteCollection(collection.id);
            await loadState();
            renderManageList();
            toast('文件夹已删除', 'success');
          } catch (err) {
            toast(err.message || '删除失败', 'error');
          }
        },
      }),
    ]);
    collectionManageList.appendChild(row);
  });
}

function closeAutoClassify() {
  hideBackdrop(autoClassifyBackdrop);
  if (autoClassifyHint) autoClassifyHint.textContent = '选择一种分类方式';
  autoClassifyBusy = false;
}

async function runAutoClassify(mode, button) {
  if (autoClassifyBusy) return;
  autoClassifyBusy = true;
  const labels = { format: '按格式', status: '按阅读状态', added: '按添加月份', ai: 'AI 智能' };
  const options = autoClassifyBackdrop ? autoClassifyBackdrop.querySelectorAll('[data-auto-mode]') : [];
  options.forEach((node) => {
    node.disabled = true;
    node.classList.toggle('is-busy', node === button);
  });
  if (autoClassifyHint) {
    autoClassifyHint.textContent = mode === 'ai' ? 'AI 正在阅读书籍清单并分组，约 10–30 秒…' : '正在分类…';
  }
  try {
    const res = mode === 'ai' ? await classifyBooksWithAi() : await api.autoClassify(mode);
    await loadState();
    store.view.collection = 'all';
    saveViewPrefs();
    closeAutoClassify();
    const groups = res && Array.isArray(res.groups) ? res.groups.length : 0;
    const assigned = res && Number(res.assigned) ? Number(res.assigned) : 0;
    toast(
      mode === 'ai'
        ? `AI 已分成 ${groups} 个文件夹${assigned ? `，整理 ${assigned} 本书` : ''}`
        : `已${labels[mode] || '自动'}分类：${groups} 个文件夹`,
      'success'
    );
  } catch (err) {
    if (autoClassifyHint) autoClassifyHint.textContent = err.message || '自动分类失败';
    autoClassifyBusy = false;
  } finally {
    options.forEach((node) => {
      node.disabled = false;
      node.classList.remove('is-busy');
    });
  }
}

async function classifyBooksWithAi() {
  const books = store.books.map((book) => ({
    id: book.id,
    title: book.title || book.filename || '',
    author: book.author || '',
    format: book.format || '',
  }));
  if (!books.length) throw new Error('书架是空的');
  const endpoint = String(window.MOYUE_AI_ENDPOINT || 'http://127.0.0.1:7797').replace(/\/+$/, '');
  const response = await fetch(`${endpoint}/classify-books`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ books }),
  }).catch(() => {
    throw new Error('无法连接本地 AI 服务，请确认 DSH 中的墨阅插件已启用');
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.ok !== true) {
    throw new Error((data && data.error && data.error.message) || `AI 服务返回错误（HTTP ${response.status}）`);
  }
  if (!Array.isArray(data.folders) || !data.folders.length) {
    throw new Error('AI 没有返回有效的分组');
  }
  return api.applyAiClassify(data.folders);
}

function bindCollectionDialogs() {
  const newBtn = document.getElementById('btnNewCollection');
  newBtn?.addEventListener('click', () => openCollectionDialog('create'));
  document.getElementById('btnManageCollections')?.addEventListener('click', openManageDialog);
  document.getElementById('btnAutoClassify')?.addEventListener('click', () => {
    showBackdrop(autoClassifyBackdrop);
  });

  document.getElementById('collectionDialogClose')?.addEventListener('click', closeCollectionDialog);
  document.getElementById('collectionDialogCancel')?.addEventListener('click', closeCollectionDialog);
  collectionDialogSubmit?.addEventListener('click', submitCollectionDialog);
  collectionNameInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submitCollectionDialog();
    }
  });
  collectionDialogBackdrop?.addEventListener('click', (event) => {
    if (event.target === collectionDialogBackdrop) closeCollectionDialog();
  });

  document.getElementById('moveDialogClose')?.addEventListener('click', closeMoveDialog);
  moveDialogBackdrop?.addEventListener('click', (event) => {
    if (event.target === moveDialogBackdrop) closeMoveDialog();
  });
  document.getElementById('moveDialogNew')?.addEventListener('click', () => {
    if (!pendingMoveIds.length) return;
    pendingCreateThenMove = true;
    hideBackdrop(moveDialogBackdrop);
    openCollectionDialog('create');
  });

  document.getElementById('manageDialogClose')?.addEventListener('click', closeManageDialog);
  document.getElementById('manageDialogDone')?.addEventListener('click', closeManageDialog);
  document.getElementById('manageDialogNew')?.addEventListener('click', () => {
    closeManageDialog();
    openCollectionDialog('create');
  });
  manageDialogBackdrop?.addEventListener('click', (event) => {
    if (event.target === manageDialogBackdrop) closeManageDialog();
  });

  document.getElementById('autoClassifyClose')?.addEventListener('click', closeAutoClassify);
  document.getElementById('autoClassifyCancel')?.addEventListener('click', closeAutoClassify);
  autoClassifyBackdrop?.addEventListener('click', (event) => {
    if (event.target === autoClassifyBackdrop) closeAutoClassify();
  });
  autoClassifyBackdrop?.querySelectorAll('[data-auto-mode]').forEach((button) => {
    button.addEventListener('click', () => void runAutoClassify(button.getAttribute('data-auto-mode'), button));
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (moveDialogBackdrop && !moveDialogBackdrop.hidden) {
      closeMoveDialog();
      event.preventDefault();
    } else if (collectionDialogBackdrop && !collectionDialogBackdrop.hidden) {
      closeCollectionDialog();
      event.preventDefault();
    } else if (manageDialogBackdrop && !manageDialogBackdrop.hidden) {
      closeManageDialog();
      event.preventDefault();
    } else if (autoClassifyBackdrop && !autoClassifyBackdrop.hidden) {
      closeAutoClassify();
      event.preventDefault();
    }
  });
}

/* ---------------- 交互 ---------------- */

function bindToolbar() {
  sortEl?.addEventListener('change', () => {
    store.view.sort = sortEl.value;
    saveViewPrefs();
    renderShelf();
  });

  unreadBtn?.addEventListener('click', () => {
    store.view.unreadOnly = !store.view.unreadOnly;
    saveViewPrefs();
    renderShelf();
  });

  document.getElementById('btnScan')?.addEventListener('click', scanLibrary);
  document.getElementById('btnAddFolder')?.addEventListener('click', () => {
    if (handlers.openBrowse) handlers.openBrowse();
  });
  document.getElementById('btnAddFile')?.addEventListener('click', () => {
    document.getElementById('filePicker')?.click();
  });
}

async function scanLibrary() {
  const btn = document.getElementById('btnScan');
  if (btn) {
    btn.disabled = true;
    btn.classList.add('is-busy');
  }
  try {
    const res = await api.scan();
    await loadState();
    const added = Number(res && res.added) || 0;
    const removed = Number(res && res.removed) || 0;
    const errors = Array.isArray(res && res.errors) ? res.errors : [];
    const parts = [];
    if (added) parts.push(`新增 ${added} 本`);
    if (removed) parts.push(`移除 ${removed} 本`);
    if (errors.length) parts.push(`${errors.length} 本读取失败`);
    toast(parts.length ? `扫描完成：${parts.join('，')}` : '扫描完成，书库已是最新', errors.length ? 'warn' : 'success');
    if (errors.length) console.warn('[scan] errors:', errors);
  } catch (err) {
    toast(err.message || '扫描失败', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('is-busy');
    }
  }
}

function bindSearch() {
  if (!searchInput) return;
  let timer = 0;
  searchInput.addEventListener('input', () => {
    clearTimeout(timer);
    const value = searchInput.value;
    if (searchClear) searchClear.hidden = !value;
    timer = setTimeout(() => {
      store.view.query = value;
      renderShelf();
    }, 120);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchInput.value = '';
      store.view.query = '';
      if (searchClear) searchClear.hidden = true;
      renderShelf();
      searchInput.blur();
    }
  });
  searchClear?.addEventListener('click', () => {
    searchInput.value = '';
    store.view.query = '';
    searchClear.hidden = true;
    renderShelf();
    searchInput.focus();
  });
}

function openBook(book) {
  if (!book) return;
  if (handlers.openBook) handlers.openBook(book);
}

/* ---------------- 右键菜单 ---------------- */

function showCtxMenu(book, anchor) {
  if (!ctxEl) return;
  ctxBook = book;
  clearNode(ctxEl);
  ctxEl.hidden = false;
  ctxEl.setAttribute('role', 'menu');

  const item = (label, iconName, onClick, extraClass) =>
    el('button', {
      class: `ctx-item${extraClass ? ' ' + extraClass : ''}`,
      type: 'button',
      role: 'menuitem',
      html: `${icon(iconName, 16)}<span>${label}</span>`,
      onclick: () => {
        hideCtxMenu();
        onClick();
      },
    });

  ctxEl.appendChild(el('div', { class: 'ctx-label', text: book.title || book.filename || '' }));
  ctxEl.appendChild(item('打开', 'book-open', () => openBook(book)));
  ctxEl.appendChild(item('移动到文件夹…', 'folder', () => openMoveDialog([book])));
  ctxEl.appendChild(
    item('在文件夹中显示', 'folder-open', async () => {
      try {
        await api.reveal(book.path);
      } catch (err) {
        toast(err.message || '无法打开所在文件夹', 'error');
      }
    })
  );
  ctxEl.appendChild(el('div', { class: 'ctx-sep' }));
  ctxEl.appendChild(
    item('移出书架', 'trash', async () => {
      const ok = await confirmAction({
        title: '移出书架',
        message: `「${book.title || book.filename}」将从书库中移除，磁盘上的原文件不会被删除。`,
        confirmText: '移出书架',
        danger: true,
      });
      if (!ok) return;
      try {
        await api.removeBook(book.id);
        toast('已移出书架', 'success');
        await loadState();
      } catch (err) {
        toast(err.message || '移出失败', 'error');
      }
    }, 'is-danger')
  );

  // 定位（优先右键点，其次按钮下方）
  const rect = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
  const menuRect = ctxEl.getBoundingClientRect();
  let left = rect ? rect.right - menuRect.width : 100;
  let top = rect ? rect.bottom + 6 : 100;
  if (left < 8) left = 8;
  if (left + menuRect.width > window.innerWidth - 8) left = window.innerWidth - menuRect.width - 8;
  if (top + menuRect.height > window.innerHeight - 8) {
    top = rect ? rect.top - menuRect.height - 6 : window.innerHeight - menuRect.height - 8;
  }
  if (top < 8) top = 8;
  ctxEl.style.left = `${Math.round(left)}px`;
  ctxEl.style.top = `${Math.round(top)}px`;
  const first = ctxEl.querySelector('.ctx-item');
  if (first) first.focus({ preventScroll: true });
}

function hideCtxMenu() {
  if (!ctxEl) return;
  ctxEl.hidden = true;
  clearNode(ctxEl);
  ctxBook = null;
}

function bindCtxDismiss() {
  document.addEventListener('mousedown', (e) => {
    if (ctxEl && !ctxEl.hidden && !ctxEl.contains(e.target)) hideCtxMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ctxEl && !ctxEl.hidden) hideCtxMenu();
  });
  window.addEventListener('resize', () => hideCtxMenu());
  window.addEventListener('scroll', () => hideCtxMenu(), true);
}

/* ---------------- 拖拽导入 ---------------- */

function hasFiles(event) {
  const dt = event.dataTransfer;
  if (!dt) return false;
  const types = Array.from(dt.types || []);
  return types.includes('Files');
}

function bindDrop() {
  const overlay = document.getElementById('dropOverlay');
  if (!overlay) return;

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dropDepth += 1;
    overlay.classList.add('is-active');
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    overlay.classList.add('is-active');
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dropDepth = Math.max(0, dropDepth - 1);
    if (dropDepth === 0) overlay.classList.remove('is-active');
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dropDepth = 0;
    overlay.classList.remove('is-active');
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    if (files.length) importFiles(files);
  });
}

function bindFilePicker() {
  const picker = document.getElementById('filePicker');
  picker?.addEventListener('change', () => {
    const files = Array.from(picker.files || []);
    picker.value = '';
    if (files.length) importFiles(files);
  });
}

export async function importFiles(files) {
  const books = files.filter((file) => looksLikeBook(file));
  if (!books.length) {
    toast('没有可导入的电子书格式', 'warn');
    return;
  }
  let ok = 0;
  const failed = [];
  toast(`正在导入 ${books.length} 个文件…`, 'info', 2000);
  for (const file of books) {
    try {
      await api.importFile(file);
      ok += 1;
    } catch (err) {
      failed.push(`${file.name}：${err.message || '导入失败'}`);
    }
  }
  await loadState();
  if (failed.length === 0) {
    toast(`已导入 ${ok} 本电子书`, 'success');
  } else if (ok === 0) {
    toast(failed[0] || '导入失败', 'error', 5000);
  } else {
    toast(`已导入 ${ok} 本，${failed.length} 个失败：${failed[0]}`, 'warn', 5000);
  }
}

/* ---------------- 键盘：/ 聚焦搜索 ---------------- */

export function focusSearch() {
  searchInput?.focus();
  searchInput?.select();
}

export function bindShelfKeys() {
  document.addEventListener('keydown', (e) => {
    if (isTypingTarget(e.target)) return;
    const route = document.body.dataset.route;
    if (route && route !== 'shelf') return;
    if (e.key === '/' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      focusSearch();
    } else if (e.key === 's' || e.key === 'S') {
      if (e.metaKey || e.ctrlKey) return;
      if (document.body.dataset.route === 'shelf') {
        e.preventDefault();
        openSettings();
      }
    }
  });
}

export { getBook };
