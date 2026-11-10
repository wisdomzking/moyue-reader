/**
 * DOM / 格式化 / Toast / 确认框 等通用工具
 */
import { icon } from './icons.js';

/** 轻量 DOM 构建器：属性、事件、文本/子节点，用户数据一律走 textContent */
export function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const key of Object.keys(attrs)) {
      const value = attrs[key];
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'html') node.innerHTML = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  if (children === null || children === undefined || children === false) return;
  if (Array.isArray(children)) {
    children.forEach((child) => appendChildren(node, child));
    return;
  }
  node.appendChild(typeof children === 'string' || typeof children === 'number'
    ? document.createTextNode(String(children))
    : children);
}

export function clearNode(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function debounce(fn, wait) {
  let timer = 0;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  return wrapped;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/* ---------------- 格式化 ---------------- */

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

export function formatPercent(value) {
  const n = clamp(Number(value) || 0, 0, 1);
  const pct = n * 100;
  if (pct >= 100) return '100%';
  if (pct <= 0) return '0%';
  if (pct < 10) {
    // 小比例保留一位小数，避免正文很靠前时一直显示 0%
    const oneDecimal = Math.round(pct * 10) / 10;
    if (oneDecimal <= 0) return '0%';
    if (oneDecimal >= 10) return '10%';
    return oneDecimal.toFixed(1) + '%';
  }
  return Math.round(pct) + '%';
}

const DAY = 24 * 60 * 60 * 1000;

export function formatRelative(timestamp) {
  if (!timestamp) return '未读';
  const diff = Date.now() - Number(timestamp);
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < DAY) return Math.floor(diff / 3600000) + ' 小时前';
  if (diff < 2 * DAY) return '昨天';
  if (diff < 7 * DAY) return Math.floor(diff / DAY) + ' 天前';
  return formatDate(timestamp);
}

export function formatDate(timestamp) {
  const d = new Date(Number(timestamp) || Date.now());
  const now = new Date();
  const pad = (v) => String(v).padStart(2, '0');
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  }
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
}

/* ---------------- 封面占位 ---------------- */

const COVER_PALETTES = [
  ['#2f6f64', '#194740'],
  ['#b96a45', '#8b452e'],
  ['#4d5f7e', '#2d3a52'],
  ['#7c4d64', '#553247'],
  ['#5c7052', '#3a4d35'],
  ['#8d6b3c', '#644924'],
  ['#3f6b7d', '#284a58'],
  ['#6b5a86', '#493c60'],
];

function hashSeed(text) {
  let hash = 2166136261;
  const str = String(text || '');
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function coverGradient(seed) {
  const pair = COVER_PALETTES[hashSeed(seed) % COVER_PALETTES.length];
  return `linear-gradient(152deg, ${pair[0]} 0%, ${pair[1]} 100%)`;
}

export function bookInitial(title, fallback = '书') {
  const chars = Array.from(String(title || '').trim());
  if (!chars.length) return fallback;
  const first = chars[0];
  return /[\w\u4e00-\u9fa5]/.test(first) ? first : fallback;
}

/** 无封面时的占位（渐变 + 书名首字 + 书脊） */
export function coverPlaceholder(book) {
  return el('div', {
    class: 'cover-placeholder',
    style: { background: coverGradient(book.title || book.filename || book.id) },
    'aria-hidden': 'true',
  }, [el('span', { class: 'cover-glyph', text: bookInitial(book.title || book.filename) })]);
}

/* ---------------- Toast ---------------- */

const TOAST_ICONS = { success: 'check', error: 'alert', warn: 'alert', info: 'info' };

export function toast(message, type = 'info', duration = 3400) {
  const stack = document.getElementById('toastStack');
  if (!stack) return;
  const node = el('div', {
    class: `toast toast-${type}`,
    'data-testid': 'toast',
    role: type === 'error' ? 'alert' : 'status',
  }, [
    el('span', { class: 'toast-icon', html: icon(TOAST_ICONS[type] || 'info', 17) }),
    el('span', { class: 'toast-text', text: message }),
  ]);
  stack.appendChild(node);
  while (stack.children.length > 3) stack.removeChild(stack.firstChild);
  requestAnimationFrame(() => node.classList.add('is-in'));
  const hide = () => {
    node.classList.remove('is-in');
    node.classList.add('is-out');
    setTimeout(() => node.remove(), 260);
  };
  const timer = setTimeout(hide, duration);
  node.addEventListener('click', () => {
    clearTimeout(timer);
    hide();
  });
  return node;
}

/* ---------------- 确认框 ---------------- */

export function confirmAction({ title, message, confirmText = '确定', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modalRoot');
    if (!root) return resolve(window.confirm(message || title || '确定？'));
    const backdrop = el('div', { class: 'modal-backdrop is-open', role: 'presentation' });
    const dialog = el('div', {
      class: 'modal modal-sm',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': title || '确认',
      'data-testid': 'confirm',
    }, [
      el('div', { class: 'modal-head' }, [
        el('h3', { class: 'modal-title', text: title || '确认操作' }),
      ]),
      el('div', { class: 'confirm-body', text: message || '' }),
      el('div', { class: 'modal-foot modal-foot-end' }, [
        el('button', { class: 'btn btn-ghost', type: 'button', text: cancelText, onclick: () => done(false) }),
        el('button', {
          class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`,
          type: 'button',
          text: confirmText,
          onclick: () => done(true),
        }),
      ]),
    ]);
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        done(false);
      }
    };
    function done(value) {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      resolve(value);
    }
    backdrop.appendChild(dialog);
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) done(false);
    });
    document.addEventListener('keydown', onKey, true);
    root.appendChild(backdrop);
  });
}

export function isTypingTarget(target) {
  if (!target || !target.tagName) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

/** 文件是否可能是电子书（导入前判断，仅做提示用） */
const BOOK_EXTS = ['epub', 'pdf', 'mobi', 'azw', 'azw3', 'prc', 'doc', 'docx', 'rtf', 'odt', 'txt', 'md', 'html', 'htm', 'xhtml', 'fb2'];
export function fileExt(name) {
  const idx = String(name || '').lastIndexOf('.');
  return idx === -1 ? '' : String(name).slice(idx + 1).toLowerCase();
}
export function looksLikeBook(file) {
  return BOOK_EXTS.includes(fileExt(file && file.name));
}
