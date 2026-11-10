/**
 * 内联 SVG 图标集（stroke=currentColor）
 * 用法: icon('search', 18) -> '<svg ...>...</svg>'
 */

const PATHS = {
  /* 界面 */
  search: '<circle cx="11" cy="11" r="7"/><path d="M16.4 16.4 21 21"/>',
  'folder-plus':
    '<path d="M3.2 7.2A1.7 1.7 0 0 1 4.9 5.5h3.5l1.6 2h8.1a1.7 1.7 0 0 1 1.7 1.7v8.1a1.7 1.7 0 0 1-1.7 1.7H4.9a1.7 1.7 0 0 1-1.7-1.7z"/>' +
    '<path d="M12 11.4v5M9.5 13.9h5"/>',
  'file-plus':
    '<path d="M13.6 3.2H7.4a2 2 0 0 0-2 2v13.6a2 2 0 0 0 2 2h9.2a2 2 0 0 0 2-2V8.1z"/>' +
    '<path d="M13.6 3.2v4.9h4.9"/><path d="M12 12.2v4.6M9.7 14.5h4.6"/>',
  refresh:
    '<path d="M20.5 12a8.5 8.5 0 0 1-14.6 5.9M3.5 12a8.5 8.5 0 0 1 14.6-5.9"/>' +
    '<path d="M20.5 3.4v5.1h-5.1M3.5 20.6v-5.1h5.1"/>',
  sliders:
    '<path d="M4 6.4h9.4M18.2 6.4H20M4 12h3.3M12.1 12H20M4 17.6h11.1M19.9 17.6H20"/>' +
    '<circle cx="16" cy="6.4" r="2.2"/><circle cx="9.9" cy="12" r="2.2"/>' +
    '<circle cx="17.8" cy="17.6" r="2.2"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  'chevron-left': '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  'chevron-right': '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',
  'chevron-up': '<path d="M5.5 14.5 12 8l6.5 6.5"/>',
  'chevron-down': '<path d="M5.5 9.5 12 16l6.5-6.5"/>',
  'arrow-left': '<path d="M19 12H5M11 18l-6-6 6-6"/>',
  'arrow-right': '<path d="M5 12h14M13 6l6 6-6 6"/>',
  'arrow-up': '<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  check: '<path d="M4.5 12.5 9.5 17.5 19.5 7"/>',
  more: '<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  alert:
    '<path d="M12 4.2 21 19.4H3z"/><path d="M12 9.6v4.2"/><circle cx="12" cy="16.8" r=".9" fill="currentColor" stroke="none"/>',
  info: '<circle cx="12" cy="12" r="8.6"/><path d="M12 11v5.2"/><circle cx="12" cy="7.9" r=".95" fill="currentColor" stroke="none"/>',
  'book-open':
    '<path d="M12 6.6C10.2 5 8 4.4 5.9 4.4a2 2 0 0 0-1.9 2v9.1c0 .9.7 1.5 1.5 1.5 2.4 0 4.6.6 6.5 2.2"/>' +
    '<path d="M12 6.6c1.8-1.6 4-2.2 6.1-2.2a2 2 0 0 1 1.9 2v9.1c0 .9-.7 1.5-1.5 1.5-2.4 0-4.6.6-6.5 2.2"/>' +
    '<path d="M12 6.6v13"/>',
  toc: '<path d="M8.5 6.4H20M8.5 12H20M8.5 17.6H20"/><circle cx="4.4" cy="6.4" r="1.1"/><circle cx="4.4" cy="12" r="1.1"/><circle cx="4.4" cy="17.6" r="1.1"/>',
  bookmark: '<path d="M6.6 4.4h10.8v15.2L12 15.6l-5.4 4z"/>',
  'bookmark-filled': '<path d="M6.6 4.4h10.8v15.2L12 15.6l-5.4 4z" fill="currentColor"/>',
  fullscreen: '<path d="M4.5 9.5v-5h5M19.5 9.5v-5h-5M4.5 14.5v5h5M19.5 14.5v5h-5"/>',
  'fullscreen-exit': '<path d="M9.5 4.5v5h-5M14.5 4.5v5h5M9.5 19.5v-5h-5M14.5 19.5v-5h5"/>',
  sun: '<circle cx="12" cy="12" r="4.1"/><path d="M12 2.8v2.1M12 19.1v2.1M4.5 4.5l1.5 1.5M18 18l1.5 1.5M2.8 12h2.1M19.1 12h2.1M4.5 19.5 6 18M18 6l1.5-1.5"/>',
  moon: '<path d="M20.3 14.6A8.6 8.6 0 0 1 9.4 3.7 8.6 8.6 0 1 0 20.3 14.6z"/>',
  leaf: '<path d="M4.4 19.6C4.4 11.3 10 4.9 20 4.4c.1 9.7-5 15.2-12.4 15.2-1.5 0-3.2 0-3.2 0z"/><path d="M9.4 14.6c1.6-2.6 3.7-4.4 6.4-5.6"/>',
  copy:
    '<rect x="8.6" y="8.6" width="10.8" height="10.8" rx="2.2"/><path d="M15.4 8.6V6.2a1.8 1.8 0 0 0-1.8-1.8H6.2a1.8 1.8 0 0 0-1.8 1.8v7.4a1.8 1.8 0 0 0 1.8 1.8h2.4"/>',
  highlight: '<path d="M4.5 20h5l9.6-9.6a2.1 2.1 0 0 0 0-3l-1.5-1.5a2.1 2.1 0 0 0-3 0L5 15.5z"/><path d="M13.2 7.8l3 3"/>',
  trash: '<path d="M4.5 7h15M9.3 7V4.6h5.4V7M6.4 7l.9 12.9a1.6 1.6 0 0 0 1.6 1.5h6.2a1.6 1.6 0 0 0 1.6-1.5L17.6 7"/><path d="M10.4 11v6.2M13.6 11v6.2"/>',
  folder:
    '<path d="M3.2 7.2A1.7 1.7 0 0 1 4.9 5.5h3.5l1.6 2h8.1a1.7 1.7 0 0 1 1.7 1.7v8.1a1.7 1.7 0 0 1-1.7 1.7H4.9a1.7 1.7 0 0 1-1.7-1.7z"/>',
  'folder-open':
    '<path d="M3.2 8.1V7.2a1.7 1.7 0 0 1 1.7-1.7h3.5l1.6 2h7.2a1.7 1.7 0 0 1 1.7 1.7v.9"/>' +
    '<path d="M3.6 18.9 5.9 9.6h15.7l-2.4 9.3z"/>',
  file: '<path d="M13.6 3.2H7.4a2 2 0 0 0-2 2v13.6a2 2 0 0 0 2 2h9.2a2 2 0 0 0 2-2V8.1z"/><path d="M13.6 3.2v4.9h4.9"/>',
  drive:
    '<rect x="3.4" y="13" width="17.2" height="7.2" rx="2"/><path d="M5.6 13 8.2 4.8h7.6L18.4 13"/><circle cx="7.4" cy="16.6" r="1" fill="currentColor" stroke="none"/><path d="M11.4 16.6h5.4"/>',
  sort: '<path d="M4 7h9M4 12h6M4 17h4"/><path d="M17.4 4.6v14.8M14.6 16.6l2.8 2.8 2.8-2.8"/>',
  'fit-width': '<path d="M3.5 12h17M6.5 8.5 3 12l3.5 3.5M17.5 8.5 21 12l-3.5 3.5"/>',
  'actual-size':
    '<rect x="3.6" y="5.4" width="16.8" height="13.2" rx="2"/><path d="M8.4 10.2v3.6M11.6 10.2v3.6M15 10.2h1.2M15.6 10.2v3.6"/>',
  'zoom-in': '<circle cx="11" cy="11" r="7"/><path d="M16.4 16.4 21 21M8 11h6M11 8v6"/>',
  'zoom-out': '<circle cx="11" cy="11" r="7"/><path d="M16.4 16.4 21 21M8 11h6"/>',
  clock: '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.4V12l3.2 2"/>',
  sparkles:
    '<path d="M12 3.6l1.4 4.2 4.2 1.4-4.2 1.4L12 14.8l-1.4-4.2L6.4 9.2l4.2-1.4z"/>' +
    '<path d="M18.4 14.8l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>' +
    '<path d="M5.6 15.2l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6z"/>',
  'book-marked': '<path d="M5.4 4.6h13.2v15.8H5.4z"/><path d="M8.4 4.6v6l2.6-1.9 2.6 1.9v-6"/>',
  edit: '<path d="M5 19h3.4L19 8.4a2.1 2.1 0 0 0 0-3L18 4.4a2.1 2.1 0 0 0-3 0L4.6 15V19z"/><path d="M14.2 5.2l4.6 4.6"/>',
};

/** 书库 Logo 标记（实心，自带配色由 CSS 控制） */
export function logoMark() {
  return (
    '<svg viewBox="0 0 28 28" width="22" height="22" fill="none" aria-hidden="true">' +
    '<path d="M5.4 6.2c0-.9.7-1.6 1.6-1.6h4.6c1.5 0 2.9.6 3.9 1.7l.5.6.5-.6c1-1.1 2.4-1.7 3.9-1.7H22c.9 0 1.6.7 1.6 1.6v13.6c0 .9-.7 1.6-1.6 1.6h-4.2c-1.2 0-2.4.5-3.2 1.4l-.6.6-.6-.6c-.8-.9-2-1.4-3.2-1.4H5.4c-.9 0-1.6-.7-1.6-1.6z" fill="currentColor"/>' +
    '<path d="M14 8.6v13" stroke="#fffdf8" stroke-opacity=".55" stroke-width="1.5" stroke-linecap="round"/>' +
    '</svg>'
  );
}

export function icon(name, size = 18, extraClass = '') {
  const body = PATHS[name];
  if (!body) return '';
  const cls = extraClass ? ` class="ico ${extraClass}"` : ' class="ico"';
  return (
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}"${cls} fill="none" ` +
    'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ' +
    `aria-hidden="true" focusable="false">${body}</svg>`
  );
}

/** 把模板里的 <span data-icon="x"> 或 data-ico="x" 占位符替换成 SVG */
export function hydrateIcons(root = document) {
  const nodes = root.querySelectorAll('[data-icon], [data-ico]');
  nodes.forEach((node) => {
    const name = node.dataset.icon || node.dataset.ico;
    if (!name) return;
    const size = Number(node.dataset.iconSize || node.dataset.icoSize || 18);
    node.innerHTML = icon(name, size);
    if (node.hasAttribute('data-icon')) node.removeAttribute('data-icon');
    if (node.hasAttribute('data-ico')) node.removeAttribute('data-ico');
  });
}


/** 空状态插画：摊开的书 + 飘出的纸页（用内联 style 引用主题变量，兼容性最好） */
export function emptyIllustration() {
  return `
<svg class="empty-art" viewBox="0 0 240 168" width="240" height="168" fill="none" aria-hidden="true">
  <defs>
    <linearGradient id="ea-g1" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" style="stop-color:var(--accent);stop-opacity:.18"/>
      <stop offset="1" style="stop-color:var(--accent2);stop-opacity:.10"/>
    </linearGradient>
    <linearGradient id="ea-g2" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" style="stop-color:var(--accent);stop-opacity:.55"/>
      <stop offset="1" style="stop-color:var(--accent2);stop-opacity:.7"/>
    </linearGradient>
  </defs>
  <ellipse cx="120" cy="146" rx="82" ry="10" style="fill:var(--accent);opacity:.08"/>
  <path d="M120 52c-14-9-30-13-47-13-6 0-11 1-15 2v78c5-1 10-2 15-2 17 0 33 4 47 13 14-9 30-13 47-13 5 0 10 1 15 2V41c-4-1-9-2-15-2-17 0-33 4-47 13z" fill="url(#ea-g1)" style="stroke:var(--accent);stroke-opacity:.45" stroke-width="1.6"/>
  <path d="M120 52v78" style="stroke:var(--accent);stroke-opacity:.45" stroke-width="1.6"/>
  <path d="M73 62c11 0 21 2 30 6M73 78c11 0 21 2 30 6M73 94c11 0 21 2 30 6" style="stroke:var(--accent);stroke-opacity:.28" stroke-width="1.5" stroke-linecap="round"/>
  <path d="M137 62c11-4 21-6 30-6M137 78c11-4 21-6 30-6M137 94c11-4 21-6 30-6" style="stroke:var(--accent);stroke-opacity:.28" stroke-width="1.5" stroke-linecap="round"/>
  <rect x="150" y="18" width="26" height="34" rx="4" transform="rotate(9 150 18)" style="fill:var(--surface);stroke:var(--accent2);stroke-opacity:.55" stroke-width="1.5"/>
  <path d="M158 28h11M158 35h8" style="stroke:var(--accent2);stroke-opacity:.6" stroke-width="1.4" stroke-linecap="round"/>
  <circle cx="66" cy="34" r="3" fill="url(#ea-g2)"/>
  <circle cx="88" cy="24" r="2" style="fill:var(--accent2);opacity:.55"/>
  <circle cx="182" cy="66" r="2.4" style="fill:var(--accent);opacity:.4"/>
</svg>`;
}
