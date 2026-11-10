/**
 * 目录浏览弹窗（/api/browse）
 * - 盘符 / 常用目录 / 上级 / 子目录 / 文件
 * - 添加当前目录为书库文件夹（POST /api/folders）
 * - 直接打开单个电子书（POST /api/open）
 */
import { api } from './api.js';
import { loadState } from './store.js';
import { icon } from './icons.js';
import { el, clearNode, toast, formatBytes, fileExt } from './ui.js';

let backdrop = null;
let body = null;
let pathLabel = null;
let upBtn = null;
let addBtn = null;
let openBtn = null;
let quickBar = null;
let hint = null;

let current = { path: '', data: null };
let selectedFile = null;
let loading = false;
let isOpen = false;
let handlers = { openPath: null };

const BOOK_EXTS = ['epub', 'pdf', 'mobi', 'azw', 'azw3', 'prc', 'doc', 'docx', 'rtf', 'odt', 'txt', 'md', 'html', 'htm', 'xhtml', 'fb2'];

export function initBrowse(options = {}) {
  handlers = { ...handlers, ...options };
  backdrop = document.getElementById('browseBackdrop');
  body = document.getElementById('browseBody');
  pathLabel = document.getElementById('browsePath');
  upBtn = document.getElementById('browseUp');
  addBtn = document.getElementById('browseAddFolder');
  openBtn = document.getElementById('browseOpenFile');
  quickBar = document.getElementById('browseQuick');
  hint = document.getElementById('browseHint');
  if (!backdrop) return;

  document.getElementById('browseClose')?.addEventListener('click', closeBrowse);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) closeBrowse();
  });
  upBtn?.addEventListener('click', () => {
    if (!current.data) return;
    if (current.data.isDriveList) return;
    load(current.data.parent || '');
  });
  document.getElementById('browseRefresh')?.addEventListener('click', () => load(current.path));
  addBtn?.addEventListener('click', addCurrentFolder);
  openBtn?.addEventListener('click', () => {
    if (selectedFile && selectedFile.isBook) openSelected(selectedFile);
  });

  document.addEventListener('keydown', (e) => {
    if (!isOpen) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeBrowse();
    } else if (e.key === 'Backspace' && !isTyping(e.target)) {
      e.preventDefault();
      if (current.data && !current.data.isDriveList) load(current.data.parent || '');
    }
  });
}

function isTyping(target) {
  const tag = target && target.tagName ? target.tagName.toLowerCase() : '';
  return tag === 'input' || tag === 'textarea';
}

export function openBrowse(path) {
  if (!backdrop) return;
  if (isOpen) return;
  isOpen = true;
  backdrop.hidden = false;
  requestAnimationFrame(() => backdrop.classList.add('is-open'));
  document.body.classList.add('is-scroll-locked');
  document.getElementById('browseClose')?.focus({ preventScroll: true });
  load(path || '');
}

export function closeBrowse() {
  if (!backdrop || !isOpen) return;
  isOpen = false;
  backdrop.classList.remove('is-open');
  setTimeout(() => {
    if (!isOpen) backdrop.hidden = true;
  }, 180);
  document.body.classList.remove('is-scroll-locked');
}

export function isBrowseOpen() {
  return isOpen;
}

/* ---------------- 数据加载 ---------------- */

async function load(path) {
  if (loading) return;
  loading = true;
  selectedFile = null;
  updateFooter();
  renderLoading();
  try {
    const data = await api.browse(path || '');
    current = { path: data.path || '', data };
    renderBrowser();
  } catch (err) {
    current = { path: path || '', data: null };
    renderError(err);
  } finally {
    loading = false;
  }
}

/* ---------------- 渲染 ---------------- */

function renderLoading() {
  clearNode(body);
  body.appendChild(
    el('div', { class: 'browse-loading' }, [
      el('span', { class: 'spinner spinner-sm' }),
      el('span', { text: '正在读取目录…' }),
    ])
  );
  if (pathLabel) pathLabel.textContent = current.path || '此电脑';
  if (upBtn) upBtn.disabled = true;
  if (addBtn) addBtn.disabled = true;
  if (quickBar) clearNode(quickBar);
}

function renderError(err) {
  clearNode(body);
  body.appendChild(
    el('div', { class: 'browse-empty' }, [
      el('span', { html: icon('alert', 28) }),
      el('span', { text: (err && err.message) || '无法读取该目录' }),
      el('button', {
        class: 'btn btn-ghost btn-sm',
        type: 'button',
        text: '重试',
        onclick: () => load(current.path),
      }),
    ])
  );
  if (upBtn) upBtn.disabled = true;
  if (addBtn) addBtn.disabled = true;
}

function renderBrowser() {
  const data = current.data;
  if (!data) return;

  // 路径
  if (pathLabel) {
    pathLabel.textContent = data.isDriveList ? '此电脑' : data.path || '此电脑';
    pathLabel.title = data.isDriveList ? '' : data.path || '';
  }
  if (upBtn) upBtn.disabled = !!(data.isDriveList || !data.parent);
  if (addBtn) {
    addBtn.disabled = !!(data.isDriveList || !data.path);
    addBtn.textContent = '添加此文件夹';
  }

  // 常用位置 / 盘符
  if (quickBar) {
    clearNode(quickBar);
    const drives = Array.isArray(data.drives) ? data.drives : [];
    const quick = Array.isArray(data.quick) ? data.quick : [];
    drives.forEach((drive) => {
      quickBar.appendChild(
        el('button', {
          class: 'quick-chip',
          type: 'button',
          title: drive.path,
          onclick: () => load(drive.path),
        }, [
          el('span', { html: icon('drive', 15) }),
          el('span', { text: drive.name + (drive.free ? ` · 可用 ${formatBytes(drive.free)}` : '') }),
        ])
      );
    });
    quick.forEach((item) => {
      const p = typeof item === 'string' ? item : item.path;
      const name = typeof item === 'string' ? item : item.name || item.path;
      quickBar.appendChild(
        el('button', {
          class: 'quick-chip',
          type: 'button',
          title: p,
          onclick: () => load(p),
        }, [
          el('span', { html: icon('folder', 15) }),
          el('span', { text: name }),
        ])
      );
    });
  }

  // 列表
  clearNode(body);
  const dirs = Array.isArray(data.dirs) ? data.dirs : [];
  const files = Array.isArray(data.files) ? data.files : [];
  const books = files.filter((f) => f.isBook || BOOK_EXTS.includes(String(f.ext || '').toLowerCase()));
  const others = files.filter((f) => !books.includes(f));

  if (data.isDriveList && !dirs.length && !files.length) {
    body.appendChild(
      el('div', { class: 'browse-empty' }, [
        el('span', { html: icon('drive', 28) }),
        el('span', { text: '选择一个磁盘或常用位置开始浏览' }),
      ])
    );
  }

  if (dirs.length) {
    body.appendChild(el('div', { class: 'browse-section-title', text: '文件夹' }));
    dirs.forEach((dir) => body.appendChild(renderDirRow(dir)));
  }

  if (books.length) {
    body.appendChild(el('div', { class: 'browse-section-title', text: '电子书' }));
    books.forEach((file) => body.appendChild(renderFileRow(file, true)));
  }

  if (others.length) {
    body.appendChild(el('div', { class: 'browse-section-title', text: '其他文件' }));
    others.forEach((file) => body.appendChild(renderFileRow(file, false)));
  }

  if (!data.isDriveList && !dirs.length && !files.length) {
    body.appendChild(
      el('div', { class: 'browse-empty' }, [
        el('span', { html: icon('folder-open', 28) }),
        el('span', { text: '这个文件夹是空的' }),
      ])
    );
  }

  if (hint) {
    hint.textContent = data.isDriveList
      ? '选择磁盘或常用位置，进入后可将文件夹加入书库'
      : '双击文件夹进入 · 双击电子书打开 · Backspace 返回上级';
  }
  updateFooter();
}

function renderDirRow(dir) {
  return el('button', {
    class: 'browse-row is-dir',
    type: 'button',
    title: dir.path,
    dataset: { path: dir.path },
    onclick: () => load(dir.path),
  }, [
    el('span', { class: 'browse-icon', html: icon('folder', 17) }),
    el('span', { class: 'browse-name', text: dir.name || dir.path }),
    el('span', { class: 'browse-meta', text: '文件夹' }),
  ]);
}

function renderFileRow(file, isBook) {
  const ext = String(file.ext || fileExt(file.name)).toUpperCase();
  const row = el('button', {
    class: `browse-row${isBook ? ' is-book' : ' is-disabled'}`,
    type: 'button',
    title: file.path,
    dataset: { path: file.path },
    onclick: () => {
      if (!isBook) return;
      selectFile(file);
    },
    ondblclick: () => {
      if (isBook) openSelected(file);
    },
  }, [
    el('span', { class: 'browse-icon', html: icon(isBook ? 'book-open' : 'file', 17) }),
    el('span', { class: 'browse-name', text: file.name }),
    isBook ? null : el('span', { class: 'browse-meta', text: formatBytes(file.size) }),
    el('span', { class: 'browse-ext', text: ext || 'FILE' }),
  ]);
  if (selectedFile && selectedFile.path === file.path) row.classList.add('is-selected');
  return row;
}

function selectFile(file) {
  selectedFile = file;
  body.querySelectorAll('.browse-row').forEach((row) => {
    row.classList.toggle('is-selected', row.dataset.path === file.path);
  });
  updateFooter();
}

function updateFooter() {
  if (openBtn) openBtn.disabled = !selectedFile;
  if (addBtn) addBtn.disabled = !(current.data && !current.data.isDriveList && current.data.path);
}

/* ---------------- 动作 ---------------- */

async function addCurrentFolder() {
  const data = current.data;
  if (!data || data.isDriveList || !data.path) return;
  addBtn.disabled = true;
  addBtn.textContent = '正在添加…';
  try {
    const res = await api.addFolder(data.path);
    const name = (res && res.folder && res.folder.name) || data.path;
    const added = res && typeof res.added === 'number' ? res.added : 0;
    toast(added > 0 ? `已添加「${name}」，发现 ${added} 本电子书` : `已添加「${name}」`, 'success');
    closeBrowse();
    await loadState();
  } catch (err) {
    toast(err.message || '添加文件夹失败', 'error');
    addBtn.disabled = false;
    addBtn.textContent = '添加此文件夹';
  }
}

async function openSelected(file) {
  if (!file || !file.isBook) return;
  if (openBtn) {
    openBtn.disabled = true;
    openBtn.textContent = '正在打开…';
  }
  try {
    const record = await api.openBook(file.path);
    closeBrowse();
    if (typeof handlers.openPath === 'function') {
      await handlers.openPath(record);
    }
  } catch (err) {
    toast(err.message || '打开失败', 'error');
    if (openBtn) {
      openBtn.disabled = false;
      openBtn.textContent = '打开选中';
    }
  }
}
