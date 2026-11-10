/**
 * EPUB 阅读器（epub.js 0.3.93）
 * - 目录 / 搜索 / 书签抽屉
 * - 进度 CFI 恢复 + relocated 防抖保存
 * - locations 百分比、键盘快捷键、选中复制/高亮、翻页按钮
 * - 顶栏 3 秒无操作淡出
 */
import { api } from './api.js';
import {
  store, getBook, patchBookProgress, subscribe, updateSettings, applyTheme,
} from './store.js';
import { icon, hydrateIcons } from './icons.js';
import {
  el, clearNode, toast, clamp, debounce, formatPercent, isTypingTarget,
} from './ui.js';
import { closeSettings, isSettingsOpen, toggleSettings } from './settings.js';
import { createAiPanel } from './ai-guide.js';

const FONT_STACKS = {
  serif: '"Songti SC", "SimSun", "STSong", serif',
  sans: '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  kai: '"Kaiti SC", "KaiTi", "STKaiti", serif',
  system: 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
};

const THEME_COLORS = {
  light: { bg: '#fffdf8', fg: '#25221d', muted: '#797165', accent: '#2f6f64', link: '#2f6f64', border: '#e6dfd2' },
  sepia: { bg: '#f9f1e3', fg: '#3a2f22', muted: '#8a7a63', accent: '#8a5a34', link: '#8a5a34', border: '#e0d0b5' },
  dark: { bg: '#1b1e21', fg: '#e9e4dc', muted: '#9b958b', accent: '#63b3a3', link: '#7cc7b8', border: '#2b3034' },
};

const TEMPLATE = `
<div class="reader reader-epub" data-testid="reader" role="region" aria-label="EPUB 阅读器">
  <header class="reader-topbar">
    <button class="reader-back" type="button" data-action="back" aria-label="返回书架" title="返回书架 (Esc)">
      <span data-ico="chevron-left" data-ico-size="20"></span>
    </button>
    <div class="reader-title-wrap">
      <div class="reader-title" id="epubTitle">正在打开…</div>
      <div class="reader-subtitle" id="epubSubtitle"></div>
    </div>
    <div class="reader-actions">
      <button class="reader-action" type="button" data-action="toc" aria-label="目录" title="目录 (T)">
        <span data-ico="toc"></span>
      </button>
      <button class="reader-action" type="button" data-action="search" aria-label="搜索本书" title="搜索 (/)">
        <span data-ico="search"></span>
      </button>
      <button class="reader-action" type="button" data-action="bookmark" aria-label="添加或移除书签" title="书签 (B)">
        <span data-ico="bookmark"></span>
      </button>
      <button class="reader-action" type="button" data-action="ai" aria-label="AI 章节导读" title="AI 章节导读 (I)">
        <span data-ico="sparkles"></span>
      </button>
      <div class="reader-divider"></div>
      <button class="reader-action" type="button" data-action="autoturn" aria-label="自动翻页" title="自动翻页 (A)">
        <span data-ico="clock"></span>
      </button>
      <button class="reader-action" type="button" data-action="settings" aria-label="阅读设置" title="设置 (S)">
        <span data-ico="sliders"></span>
      </button>
      <button class="reader-action" type="button" data-action="fullscreen" aria-label="全屏" title="全屏 (F)">
        <span data-ico="fullscreen"></span>
      </button>
    </div>
  </header>

  <div class="reader-stage">
    <button class="page-nav page-nav-prev" type="button" data-action="prev" aria-label="上一页">
      <span data-ico="chevron-left" data-ico-size="22"></span>
    </button>
    <div id="epub-viewer"></div>
    <button class="page-nav page-nav-next" type="button" data-action="next" aria-label="下一页">
      <span data-ico="chevron-right" data-ico-size="22"></span>
    </button>
  </div>

  <div class="reader-progress">
    <span class="progress-chapter" id="chapterLabel" data-testid="chapter-label"></span>
    <button class="auto-chip" id="autoTurnChip" type="button" data-action="autoturn" hidden title="关闭自动翻页">
      <span data-ico="clock" data-ico-size="13"></span>
      <span id="autoTurnChipText">自动翻页</span>
    </button>
    <button class="progress-track" type="button" data-action="progress" aria-label="阅读进度，点击跳转">
      <span class="progress-rail"></span>
      <span class="progress-fill" id="progressFill" style="width:0%"></span>
      <span class="progress-knob" id="progressKnob" style="left:0%"></span>
    </button>
    <span class="progress-label" id="progressLabel" data-testid="progress-label">0%</span>
  </div>

  <aside class="reader-drawer" id="epubDrawer" data-testid="toc" aria-label="目录、搜索与书签">
    <div class="drawer-tabs">
      <button class="drawer-tab is-active" type="button" data-tab="toc">目录</button>
      <button class="drawer-tab" type="button" data-tab="search">搜索</button>
      <button class="drawer-tab" type="button" data-tab="bookmarks">书签<span class="drawer-tab-count" id="bookmarkCount"></span></button>
      <button class="btn btn-icon btn-ghost btn-xs drawer-close" type="button" data-action="close-drawer" aria-label="关闭侧栏">
        <span data-ico="close" data-ico-size="16"></span>
      </button>
    </div>
    <div class="drawer-panel is-active" data-panel="toc">
      <div class="drawer-panel-scroll">
        <ul class="toc-list" id="tocList" role="list"></ul>
      </div>
    </div>
    <div class="drawer-panel" data-panel="search">
      <div class="search-box">
        <input class="search-input" id="epubSearchInput" type="search" placeholder="搜索本书内容，回车确认" aria-label="搜索本书内容" autocomplete="off" />
      </div>
      <div class="search-hint" id="searchHint">输入关键词后按回车，在全书范围内搜索。</div>
      <div class="drawer-panel-scroll" id="searchResults"></div>
    </div>
    <div class="drawer-panel" data-panel="bookmarks">
      <div class="bookmark-list" id="bookmarkList" data-testid="bookmarks"></div>
    </div>
  </aside>

  <div class="sel-toolbar" id="selToolbar" role="toolbar" aria-label="选中文本操作">
    <button class="sel-btn" type="button" data-sel="copy">
      <span data-ico="copy" data-ico-size="15"></span><span>复制</span>
    </button>
    <button class="sel-btn" type="button" data-sel="highlight">
      <span data-ico="highlight" data-ico-size="15"></span><span>高亮</span>
    </button>
  </div>

  <div class="reader-veil" id="readerVeil"></div>
</div>
`;

export function mountEpub(root, bookId) {
  let destroyed = false;
  let bootToken = 0;

  const state = {
    book: null,
    rendition: null,
    record: null,
    toc: [],
    flatToc: [],
    bookmarks: [],
    cfi: '',
    currentHref: '',
    chapterLabel: '',
    percent: 0,
    savedPercent: 0,
    savedCfi: '',
    holdPercentUntil: 0,
    page: 1,
    totalPages: 0,
    locationsReady: false,
    lastLocation: null,
    lastSettings: { ...store.settings },
    drawerOpen: false,
    activeTab: 'toc',
    selection: null,
    idleTimer: 0,
    saveTimer: 0,
    autoTimer: 0,
    contentDocs: new Set(),
    aiHref: '',
    aiContext: null,
    searchSeq: 0,
  };

  const cleanups = [];
  const attachedDocs = new WeakSet();

  root.innerHTML = TEMPLATE;
  const reader = root.querySelector('[data-testid="reader"]');
  hydrateIcons(reader);

  const dom = {
    reader,
    title: reader.querySelector('#epubTitle'),
    subtitle: reader.querySelector('#epubSubtitle'),
    host: reader.querySelector('#epub-viewer'),
    veil: reader.querySelector('#readerVeil'),
    drawer: reader.querySelector('#epubDrawer'),
    tocList: reader.querySelector('#tocList'),
    bookmarkList: reader.querySelector('#bookmarkList'),
    bookmarkCount: reader.querySelector('#bookmarkCount'),
    searchInput: reader.querySelector('#epubSearchInput'),
    searchResults: reader.querySelector('#searchResults'),
    searchHint: reader.querySelector('#searchHint'),
    chapterLabel: reader.querySelector('#chapterLabel'),
    progressFill: reader.querySelector('#progressFill'),
    progressKnob: reader.querySelector('#progressKnob'),
    progressLabel: reader.querySelector('#progressLabel'),
    selToolbar: reader.querySelector('#selToolbar'),
    progressTrack: reader.querySelector('.progress-track'),
    autoChip: reader.querySelector('#autoTurnChip'),
    autoChipText: reader.querySelector('#autoTurnChipText'),
  };

  document.body.dataset.route = 'read';
  document.body.dataset.ready = '0';

  const aiPanel = createAiPanel({
    root: reader,
    bookId,
    mode: 'chapter',
    resolveContext: buildAiContext,
  });

  /* ======================= 遮罩 ======================= */

  function showVeil(html) {
    dom.veil.innerHTML = html;
    dom.veil.classList.remove('is-hidden');
    hydrateIcons(dom.veil);
  }

  function hideVeil() {
    dom.veil.classList.add('is-hidden');
    document.body.dataset.ready = '1';
    // 内容就绪后再开始 3 秒倒计时，避免加载耗时导致顶栏一开始就是隐藏态
    wake();
  }

  function showLoading(title, text) {
    showVeil(`
      <span class="spinner"></span>
      <div class="veil-title">${escapeText(title || '正在打开…')}</div>
      <div class="veil-text">${escapeText(text || '')}</div>
    `);
  }

  function showConverting(title) {
    showVeil(`
      <div class="veil-dots"><i></i><i></i><i></i></div>
      <div class="veil-title">正在转换《${escapeText(title || '')}》</div>
      <div class="veil-text">首次打开这种格式需要转换成 EPUB，可能需要几秒到一分钟，请稍候。转换完成后会自动打开。</div>
    `);
  }

  function showError(title, message, retryFn) {
    showVeil(`
      <div class="reader-error-card" data-testid="reader-error">
        <div class="reader-error-icon"><span data-ico="alert" data-ico-size="26"></span></div>
        <div class="reader-error-title">${escapeText(title || '打开失败')}</div>
        <div class="reader-error-text">${escapeText(message || '请稍后重试。')}</div>
        <div class="reader-error-actions">
          <button class="btn btn-primary" type="button" data-veil-action="retry">重试</button>
          <button class="btn btn-ghost" type="button" data-veil-action="back">返回书架</button>
        </div>
      </div>
    `);
    dom.veil.querySelector('[data-veil-action="retry"]')?.addEventListener('click', () => {
      if (typeof retryFn === 'function') retryFn();
    });
    dom.veil.querySelector('[data-veil-action="back"]')?.addEventListener('click', backToShelf);
    document.body.dataset.ready = '1';
  }

  /* ======================= 启动流程 ======================= */

  async function boot() {
    const token = ++bootToken;
    state.lastSettings = { ...store.settings };
    updateHostWidth();
    applyReaderChromeClass();
    showLoading('正在打开…', '');

    try {
      let record = getBook(bookId);
      if (!record) record = await api.book(bookId);
      if (destroyed || token !== bootToken) return;
      state.record = record;
      renderBookMeta(record);
      if (record.progress) {
        state.savedPercent = clamp(Number(record.progress.percent) || 0, 0, 1);
        state.savedCfi = typeof record.progress.location === 'string' ? record.progress.location : '';
        state.percent = state.savedPercent;
        state.page = Number(record.progress.page) || 1;
        state.totalPages = Number(record.progress.totalPages) || 0;
        // locations 就绪前先保留服务端保存的百分比，避免第一次 relocated
        // 把「7%」瞬间覆盖成粗估的 0%（正文很靠前时看起来像 bug）
        state.holdPercentUntil = Date.now() + 8000;
        updateProgressBarOnly();
      }

      if (record.status === 'converting') {
        showConverting(record.title || record.filename);
        record = await pollUntilReady(token);
        if (!record || destroyed || token !== bootToken) return;
        state.record = record;
        renderBookMeta(record);
      }

      if (record.status === 'error' || record.status === 'unsupported') {
        showError('这本书暂时无法打开', record.error || '文件格式不受支持或已损坏。', retry);
        return;
      }

      showLoading(`正在准备《${record.title || record.filename || ''}》`, '正在检查内容与目录…');
      const prepared = await getPrepared(bookId);
      if (destroyed || token !== bootToken) return;

      if (prepared.type === 'pdf') {
        // 后端判定为 PDF：交给 PDF 阅读器
        document.body.dataset.ready = '0';
        window.location.hash = '#/pdf/' + bookId;
        return;
      }

      await openBook(prepared, record, token);
    } catch (err) {
      if (destroyed || token !== bootToken) return;
      showError('打开失败', (err && err.message) || '无法读取这本书的内容。', retry);
    }
  }

  async function getPrepared(id) {
    const cached = store.prepared.get(id);
    if (cached && cached.url) return cached;
    const prepared = await api.prepare(id);
    store.prepared.set(id, prepared);
    return prepared;
  }

  async function pollUntilReady(token) {
    const maxAttempts = 120;
    for (let i = 0; i < maxAttempts; i++) {
      await sleep(1500);
      if (destroyed || token !== bootToken) return null;
      let record;
      try {
        record = await api.book(bookId);
      } catch (err) {
        continue;
      }
      if (record.status === 'ready' || record.status === 'error' || record.status === 'unsupported') return record;
    }
    throw new Error('转换超时，请稍后在书架重试');
  }

  async function openBook(prepared, record, token) {
    const url = prepared.url || api.contentUrl(bookId);
    // 注意：/api/books/<id>/content 没有 .epub 扩展名，epub.js 的 determineType()
    // 会把无扩展名 URL 判定成 directory 并去请求 META-INF/container.xml（404）。
    // 因此这里先取 ArrayBuffer，走 epub.js 的 binary 分支（book.url 归一化为 "/"，
    // 章节/图片相对路径由 zip archive 解析，进度 CFI 不受影响）。
    showLoading(`正在读取《${record.title || record.filename || ''}》`, '正在解压书籍内容…');
    if (typeof window.ePub !== 'function') {
      throw new Error('EPUB 引擎未加载（vendor/epub.min.js 或其依赖 JSZip 加载失败）');
    }
    const buffer = await fetchBookBuffer(url);
    if (destroyed || token !== bootToken) return;

    const book = window.ePub(buffer, { allowScriptedContent: false });
    state.book = book;

    await book.ready;
    if (destroyed || token !== bootToken) return;

    let navToc = [];
    try {
      const navigation = await book.loaded.navigation;
      navToc = (navigation && navigation.toc) || [];
    } catch (_) {
      navToc = [];
    }
    if (!navToc.length && Array.isArray(prepared.toc)) {
      navToc = prepared.toc.map((item) => ({ label: item.label, href: item.href, subitems: [] }));
    }
    state.toc = navToc;
    state.flatToc = flattenToc(navToc);
    renderToc();

    if (!state.record) state.record = record;
    createRendition();
    if (destroyed || token !== bootToken) return;

    await displaySavedLocation(record);
    if (destroyed || token !== bootToken) return;

    hideVeil();
    updateProgressUI(state.lastLocation || null);

    generateLocations();
    loadBookmarks();
    syncAutoTurn();
    void aiPanel.update();
    document.body.dataset.ready = '1';
  }

  function createRendition() {
    const settings = store.settings;
    const flow = settings.pageMode === 'scroll' ? 'scrolled-doc' : 'paginated';
    const spread = settings.pageMode === 'scroll'
      ? 'none'
      : settings.spread === 'none' ? 'none' : 'auto';

    const rendition = state.book.renderTo(dom.host, {
      width: '100%',
      height: '100%',
      flow,
      spread,
      manager: 'default',
      allowScriptedContent: false,
      minSpreadWidth: 900,
    });
    state.rendition = rendition;

    registerThemes(rendition);
    rendition.themes.select(settings.theme);
    applyTypography(rendition);
    updateHostWidth();
    applyReaderChromeClass();

    rendition.on('relocated', onRelocated);
    rendition.on('selected', onSelected);
    rendition.on('rendered', () => {
      attachContentListeners();
      if (!state.lastLocation) {
        try {
          const loc = rendition.currentLocation();
          if (loc && loc.start) onRelocated(loc);
        } catch (_) {
          /* ignore */
        }
      }
    });
    rendition.hooks.content.register((contents) => {
      try {
        attachContentDoc(contents.document);
        state.contentDocs.add(contents.document);
        ensureTypographyStyle(contents.document);
        contents.document.addEventListener('mouseup', () => {
          window.setTimeout(() => {
            const sel = contents.window.getSelection();
            if (!sel || sel.isCollapsed) hideSelToolbar();
          }, 10);
        });
      } catch (_) {
        /* ignore */
      }
    });

    return rendition;
  }

  function registerThemes(rendition) {
    Object.keys(THEME_COLORS).forEach((name) => {
      const c = THEME_COLORS[name];
      rendition.themes.register(name, {
        'html, body': { background: `${c.bg} !important`, color: `${c.fg} !important` },
        'body, p, div, span, li, td, th, dd, dt, blockquote, pre, code, figcaption, small':
          { color: `${c.fg} !important` },
        'h1, h2, h3, h4, h5, h6, strong, b, em, i': { color: `${c.fg} !important` },
        'a, a:visited, a:link': { color: `${c.link} !important`, 'text-decoration': 'underline' },
        hr: { 'border-color': `${c.border} !important` },
        img: { 'max-width': '100% !important', height: 'auto !important' },
        body: {
          'padding-left': '0 !important',
          'padding-right': '0 !important',
          'overflow-wrap': 'break-word',
        },
      });
    });
  }

  function applyTypography(rendition) {
    if (!rendition) return;
    const settings = store.settings;
    try {
      rendition.themes.override('font-size', `${settings.fontSize}px`, true);
      rendition.themes.override('font-family', FONT_STACKS[settings.fontFamily] || FONT_STACKS.serif, true);
      rendition.themes.override('line-height', String(settings.lineHeight), true);
    } catch (err) {
      console.warn('[reader] 应用排版失败', err);
    }
    applyTypographyToDocs();
  }

  /** 字间距 / 段间距需要直接注入到每章文档（epub.js 的 override 只覆盖单一属性） */
  function typographyCss() {
    const s = store.settings;
    const rules = [];
    if (s.letterSpacing > 0) {
      rules.push(`html body, html body p, html body li, html body dd, html body dt, html body blockquote, html body td { letter-spacing: ${s.letterSpacing}em !important; }`);
    }
    if (s.paragraphSpacing > 0) {
      rules.push(`html body p, html body blockquote, html body dd { margin-top: ${s.paragraphSpacing}em !important; margin-bottom: ${s.paragraphSpacing}em !important; }`);
    }
    return rules.join('\n');
  }

  function writeTypographyStyle(style) {
    if (!style) return;
    const css = typographyCss();
    if (style.textContent !== css) style.textContent = css;
  }

  function ensureTypographyStyle(doc) {
    if (!doc) return;
    try {
      let style = doc.getElementById('moyue-typography');
      if (!style) {
        style = doc.createElement('style');
        style.id = 'moyue-typography';
        (doc.head || doc.documentElement).appendChild(style);
      }
      writeTypographyStyle(style);
    } catch (_) {
      /* ignore */
    }
  }

  function applyTypographyToDocs() {
    state.contentDocs.forEach((doc) => {
      try {
        ensureTypographyStyle(doc);
      } catch (_) {
        /* ignore */
      }
    });
  }

  function updateHostWidth() {
    const width = store.settings.maxWidth || 880;
    dom.host.style.maxWidth = `${width}px`;
  }

  function applyReaderChromeClass() {
    const scrollMode = store.settings.pageMode === 'scroll';
    dom.reader.classList.toggle('reader-scroll-mode', scrollMode);
  }

  async function displaySavedLocation(record) {
    const rendition = state.rendition;
    const saved = record && record.progress && record.progress.location;
    try {
      if (saved) await rendition.display(saved);
      else await rendition.display();
      return true;
    } catch (err) {
      console.warn('[reader] 恢复阅读位置失败，改为从头打开', err);
      try {
        await rendition.display();
        return true;
      } catch (err2) {
        throw new Error('无法显示书籍内容：' + (err2.message || '未知错误'));
      }
    }
  }

  function generateLocations() {
    const book = state.book;
    if (!book || !book.locations) return;
    let timer = 0;
    const timeout = new Promise((resolve) => {
      timer = window.setTimeout(() => resolve(false), 45000);
    });
    Promise.race([book.locations.generate(1600).then(() => true), timeout])
      .then((ok) => {
        window.clearTimeout(timer);
        if (destroyed) return;
        state.locationsReady = ok === true;
        if (state.locationsReady && state.lastLocation) updateProgressUI(state.lastLocation);
      })
      .catch(() => {
        window.clearTimeout(timer);
        state.locationsReady = false;
      });
    cleanups.push(() => window.clearTimeout(timer));
  }

  /* ======================= 书籍信息 ======================= */

  function renderBookMeta(record) {
    const title = (record && (record.title || record.filename)) || '未命名';
    dom.title.textContent = title;
    dom.title.title = title;
    const parts = [];
    if (record && record.author) parts.push(record.author);
    if (record && record.format) parts.push(record.format);
    dom.subtitle.textContent = parts.join(' · ');
    document.title = `${title} · 墨阅`;
  }

  /* ======================= 目录 / 书签 / 搜索 ======================= */

  function flattenToc(items, level = 1, out = []) {
    if (!items || !items.length) return out;
    items.forEach((item) => {
      const href = typeof item.href === 'string' ? item.href : '';
      out.push({ label: cleanLabel(item.label), href, level: Math.min(level, 3) });
      if (item.subitems && item.subitems.length && level < 4) {
        flattenToc(item.subitems, level + 1, out);
      }
    });
    return out;
  }

  function cleanLabel(label) {
    if (!label) return '未命名章节';
    return String(label).replace(/\s+/g, ' ').trim() || '未命名章节';
  }

  function renderToc() {
    clearNode(dom.tocList);
    if (!state.flatToc.length) {
      dom.tocList.appendChild(
        el('li', { class: 'drawer-empty' }, [
          el('span', { html: icon('toc', 26) }),
          el('span', { text: '这本书没有提供目录' }),
          el('span', { text: '可以直接翻页阅读' }),
        ])
      );
      return;
    }
    state.flatToc.forEach((item, index) => {
      const li = el('li', { role: 'listitem' });
      const btn = el('button', {
        class: `toc-item toc-level-${item.level}`,
        type: 'button',
        style: { paddingLeft: `${10 + (item.level - 1) * 14}px` },
        title: item.label,
        dataset: { index: String(index), href: item.href },
        onclick: () => gotoHref(item.href, item.label),
      }, [el('span', { class: 'toc-label', text: item.label })]);
      li.appendChild(btn);
      dom.tocList.appendChild(li);
    });
  }

  function updateTocCurrent(location) {
    if (!location || !location.start) return { label: '' };
    const href = stripHash(location.start.href || '');
    state.currentHref = location.start.href || '';
    let currentIndex = -1;
    let label = '';
    state.flatToc.forEach((item, index) => {
      if (stripHash(item.href) === href) {
        currentIndex = index;
        label = item.label;
      }
    });
    if (!label) label = state.chapterLabel || '';
    dom.tocList.querySelectorAll('.toc-item').forEach((node, index) => {
      node.classList.toggle('is-current', index === currentIndex);
    });
    if (currentIndex >= 0 && state.drawerOpen && state.activeTab === 'toc') {
      const active = dom.tocList.children[currentIndex];
      if (active) active.scrollIntoView({ block: 'nearest' });
    }
    if (label) {
      state.chapterLabel = label;
      dom.chapterLabel.textContent = label;
    }
    return { label };
  }

  function stripHash(href) {
    return String(href || '').split('#')[0];
  }

  async function gotoHref(href, label) {
    if (!state.rendition || !href) return;
    try {
      await state.rendition.display(href);
      closeDrawer();
      if (label) toast(`已跳转到「${label}」`, 'success', 1800);
    } catch (err) {
      toast('无法跳转到该章节', 'error');
    }
  }

  async function loadBookmarks() {
    try {
      const res = await api.bookmarks(bookId);
      state.bookmarks = Array.isArray(res.bookmarks) ? res.bookmarks : [];
    } catch (_) {
      state.bookmarks = [];
    }
    renderBookmarks();
    updateBookmarkButton();
  }

  function renderBookmarks() {
    clearNode(dom.bookmarkList);
    if (dom.bookmarkCount) {
      dom.bookmarkCount.textContent = state.bookmarks.length ? String(state.bookmarks.length) : '';
    }
    if (!state.bookmarks.length) {
      dom.bookmarkList.appendChild(
        el('div', { class: 'drawer-empty' }, [
          el('span', { html: icon('bookmark', 26) }),
          el('span', { text: '还没有书签' }),
          el('span', { text: '阅读时按 B 或点顶栏书签按钮，即可记住当前页。' }),
        ])
      );
      return;
    }
    state.bookmarks.slice().reverse().forEach((mark) => {
      const item = el('div', {
        class: 'bookmark-item',
        role: 'button',
        tabindex: '0',
        title: mark.label || '',
        onclick: () => gotoHref(mark.cfi || mark.href, mark.label),
        onkeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            gotoHref(mark.cfi || mark.href, mark.label);
          }
        },
      }, [
        el('div', { class: 'bookmark-title', text: mark.label || '未命名书签' }),
        el('div', { class: 'bookmark-excerpt', text: mark.excerpt || '' }),
        el('div', { class: 'bookmark-meta', text: `${formatPercent(mark.percent || 0)} · ${formatDateShort(mark.createdAt)}` }),
      ]);
      const del = el('button', {
        class: 'bookmark-del',
        type: 'button',
        'aria-label': '删除书签',
        title: '删除书签',
        html: icon('trash', 15),
        onclick: async (e) => {
          e.stopPropagation();
          try {
            await api.removeBookmark(bookId, mark.id);
            state.bookmarks = state.bookmarks.filter((m) => m.id !== mark.id);
            renderBookmarks();
            toast('已删除书签', 'success', 1600);
          } catch (err) {
            toast(err.message || '删除书签失败', 'error');
          }
        },
      });
      item.appendChild(del);
      dom.bookmarkList.appendChild(item);
    });
  }

  function formatDateShort(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  }

  async function toggleBookmark() {
    if (!state.cfi) {
      toast('内容还在加载，请稍候', 'warn');
      return;
    }
    const exists = state.bookmarks.find((mark) => mark.cfi === state.cfi);
    if (exists) {
      try {
        await api.removeBookmark(bookId, exists.id);
        state.bookmarks = state.bookmarks.filter((m) => m.id !== exists.id);
        renderBookmarks();
        updateBookmarkButton();
        toast('已移除书签', 'success', 1600);
      } catch (err) {
        toast(err.message || '移除书签失败', 'error');
      }
      return;
    }
    const excerpt = currentSelectionText() || `阅读到 ${formatPercent(state.percent)} 的位置`;
    const payload = {
      cfi: state.cfi,
      href: state.currentHref || '',
      percent: state.percent,
      label: state.chapterLabel || `阅读位置 ${formatPercent(state.percent)}`,
      excerpt: excerpt.slice(0, 120),
    };
    try {
      const created = await api.addBookmark(bookId, payload);
      state.bookmarks.push({ ...payload, createdAt: created.createdAt, id: created.id });
      renderBookmarks();
      updateBookmarkButton();
      toast('已添加书签', 'success', 1800);
    } catch (err) {
      toast(err.message || '添加书签失败', 'error');
    }
  }

  function updateBookmarkButton() {
    const btn = dom.reader.querySelector('[data-action="bookmark"]');
    if (!btn) return;
    const active = !!state.bookmarks.find((mark) => mark.cfi === state.cfi);
    btn.classList.toggle('is-active', active);
    const span = btn.querySelector('span');
    if (span) span.innerHTML = icon(active ? 'bookmark-filled' : 'bookmark', 18);
  }

  function currentSelectionText() {
    if (state.selection && state.selection.text) return state.selection.text;
    try {
      const contents = state.rendition ? state.rendition.getContents() : [];
      for (const content of contents) {
        const sel = content.window.getSelection();
        if (sel && !sel.isCollapsed) return sel.toString();
      }
    } catch (_) {
      /* ignore */
    }
    return '';
  }

  async function runSearch(keyword) {
    const q = (keyword || '').trim();
    if (!q) {
      dom.searchHint.textContent = '输入关键词后按回车，在全书范围内搜索。';
      clearNode(dom.searchResults);
      return;
    }
    const seq = ++state.searchSeq;
    dom.searchHint.textContent = '正在搜索…';
    clearNode(dom.searchResults);
    dom.searchResults.appendChild(
      el('div', { class: 'browse-loading' }, [
        el('span', { class: 'spinner spinner-sm' }),
        el('span', { text: `正在搜索「${q}」…` }),
      ])
    );
    try {
      const res = await api.search(bookId, q);
      if (seq !== state.searchSeq || destroyed) return;
      const results = Array.isArray(res.results) ? res.results : [];
      const total = typeof res.total === 'number' ? res.total : results.length;
      dom.searchHint.textContent = results.length
        ? `找到 ${total > results.length ? `前 ${results.length} 条（共 ${total} 条）` : `${total} 条结果`}`
        : `没有找到「${q}」`;
      clearNode(dom.searchResults);
      if (!results.length) {
        dom.searchResults.appendChild(
          el('div', { class: 'drawer-empty' }, [
            el('span', { html: icon('search', 26) }),
            el('span', { text: '换个关键词试试' }),
          ])
        );
        return;
      }
      results.forEach((item) => {
        dom.searchResults.appendChild(
          el('button', {
            class: 'search-result',
            type: 'button',
            title: item.label || '',
            onclick: () => gotoHref(item.href, item.label),
          }, [
            el('div', { class: 'search-result-label', text: item.label || '正文' }),
            el('div', { class: 'search-result-excerpt', html: highlightText(item.excerpt || '', q) }),
          ])
        );
      });
    } catch (err) {
      if (seq !== state.searchSeq) return;
      dom.searchHint.textContent = '搜索失败';
      clearNode(dom.searchResults);
      dom.searchResults.appendChild(
        el('div', { class: 'drawer-empty' }, [
          el('span', { html: icon('alert', 26) }),
          el('span', { text: (err && err.message) || '搜索请求失败' }),
        ])
      );
    }
  }

  function highlightText(text, keyword) {
    const safe = escapeText(text);
    if (!keyword) return safe;
    const escapedKeyword = escapeRegExp(escapeText(keyword));
    if (!escapedKeyword) return safe;
    return safe.replace(new RegExp(escapedKeyword, 'gi'), (match) => `<mark>${match}</mark>`);
  }

  /* ======================= AI 章节上下文 ======================= */

  function buildAiContext() {
    if (!state.rendition) return null;
    const href = state.currentHref || '';
    if (state.aiHref === href && state.aiContext) return state.aiContext;
    let text = '';
    try {
      const raw = state.rendition.getContents();
      const contents = Array.isArray(raw) ? raw[0] : raw;
      const doc = contents && contents.document;
      if (doc && doc.body) text = doc.body.innerText || doc.body.textContent || '';
    } catch (_) {
      text = '';
    }
    text = String(text)
      .replace(/\r/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 20000);
    const title =
      state.chapterLabel ||
      (state.flatToc[0] && state.flatToc[0].label) ||
      '当前章节';
    const record = state.record || {};
    const bookTitle = record.title || record.filename || '未知书名';
    // 有些 EPUB 多章共用同一个 XHTML 文件，用标题参与 key，避免不同章节命中同一份缓存
    const context = { key: `${href || title}::${title}`, title, text, bookTitle };
    state.aiHref = href;
    state.aiContext = context;
    return context;
  }

  /* ======================= 位置 / 进度 ======================= */

  function onRelocated(location) {
    if (!location || !location.start) return;
    state.lastLocation = location;
    state.cfi = location.start.cfi || state.cfi;
    const displayed = location.start.displayed;
    if (displayed) {
      state.page = displayed.page;
      state.totalPages = displayed.total;
    }
    updateTocCurrent(location);
    updateProgressUI(location);
    updateBookmarkButton();
    hideSelToolbar();
    scheduleSaveProgress();
    wake();
    void aiPanel.update();
  }

  function locationPercent(location) {
    if (!location) return state.percent;
    const cfi = location.start && location.start.cfi;
    if (state.locationsReady && cfi && state.book && state.book.locations) {
      try {
        const percent = state.book.locations.percentageFromCfi(cfi);
        if (Number.isFinite(percent)) return clamp(percent, 0, 1);
      } catch (_) {
        /* ignore */
      }
    }
    // locations 还没生成完时的粗估：章节位置 + 章内页码进度，
    // 保证同一章内翻页也能看到百分比变化（进度条 / QA 依赖）。
    const start = location.start || {};
    const index = typeof start.index === 'number' ? start.index : 0;
    const total = (state.book && state.book.spine && state.book.spine.length) || 1;
    const displayed = start.displayed;
    let within = 0;
    if (displayed && displayed.total > 1 && displayed.page >= 1) {
      within = (displayed.page - 1) / displayed.total;
    }
    const fallback = clamp(total > 0 ? (index + within) / total : 0, 0, 1);
    // 刚打开时保留服务端保存的百分比（有保存的 CFI 说明确实恢复到了该位置），
    // 避免位置在正文开头时被粗估覆盖成 0%；locations 就绪后或超过 8 秒后自动失效。
    if (state.savedCfi && !state.locationsReady && Date.now() < state.holdPercentUntil) {
      return Math.max(fallback, state.savedPercent);
    }
    return fallback;
  }

  function updateProgressBarOnly() {
    const pct = (state.percent * 100).toFixed(2);
    dom.progressFill.style.width = `${pct}%`;
    dom.progressKnob.style.left = `${pct}%`;
    dom.progressLabel.textContent = formatPercent(state.percent);
  }

  function updateProgressUI(location) {
    if (location) {
      state.percent = clamp(locationPercent(location), 0, 1);
      if (location.start && location.start.href) state.currentHref = location.start.href;
    }
    updateProgressBarOnly();
    document.body.dataset.reading = String(Math.round(state.percent * 100));
  }

  function scheduleSaveProgress() {
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = window.setTimeout(() => {
      state.saveTimer = 0;
      saveProgress();
    }, 1500);
  }

  function buildProgressPayload() {
    if (!state.cfi) return null;
    return {
      percent: Number(state.percent.toFixed(4)),
      location: state.cfi,
      page: state.page || 1,
      totalPages: state.totalPages || 0,
    };
  }

  function flushProgress() {
    const payload = buildProgressPayload();
    if (!payload) return;
    try {
      api.saveProgress(bookId, payload)
        .then(() => patchBookProgress(bookId, payload))
        .catch(() => {});
    } catch (_) {
      /* ignore */
    }
  }

  async function saveProgress() {
    if (destroyed) return;
    const payload = buildProgressPayload();
    if (!payload) return;
    try {
      await api.saveProgress(bookId, payload);
      patchBookProgress(bookId, payload);
    } catch (_) {
      /* 静默失败：下次 relocated 会再存 */
    }
  }

  async function jumpByProgress(fraction) {
    if (!state.rendition || !state.book) return;
    const frac = clamp(fraction, 0, 1);
    if (state.locationsReady && state.book.locations) {
      try {
        const cfi = state.book.locations.cfiFromPercentage(frac);
        if (cfi) {
          await state.rendition.display(cfi);
          return;
        }
      } catch (_) {
        /* fallback */
      }
    }
    const spine = state.book.spine;
    const total = (spine && spine.length) || 1;
    const index = Math.min(total - 1, Math.max(0, Math.round(frac * (total - 1))));
    const section = spine.get ? spine.get(index) : null;
    if (section && section.href) {
      try {
        await state.rendition.display(section.href);
      } catch (_) {
        /* ignore */
      }
    }
  }

  /* ======================= 选中文本 ======================= */

  function onSelected(cfiRange, contents) {
    try {
      const sel = contents.window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) {
        hideSelToolbar();
        return;
      }
      const text = sel.toString().trim();
      if (!text) {
        hideSelToolbar();
        return;
      }
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      let frameRect = { left: 0, top: 0 };
      try {
        if (contents.window.frameElement) {
          frameRect = contents.window.frameElement.getBoundingClientRect();
        }
      } catch (_) {
        /* ignore */
      }
      state.selection = { cfiRange, contents, text };
      showSelToolbar(frameRect.left + rect.left + rect.width / 2, frameRect.top + rect.top);
    } catch (_) {
      hideSelToolbar();
    }
  }

  function showSelToolbar(centerX, topY) {
    const bar = dom.selToolbar;
    bar.classList.add('is-visible');
    const barRect = bar.getBoundingClientRect();
    let left = centerX - barRect.width / 2;
    let top = topY - barRect.height - 10;
    left = clamp(left, 10, Math.max(10, window.innerWidth - barRect.width - 10));
    if (top < 78) top = topY + 26;
    bar.style.left = `${Math.round(left)}px`;
    bar.style.top = `${Math.round(top)}px`;
  }

  function hideSelToolbar() {
    dom.selToolbar.classList.remove('is-visible');
    state.selection = null;
  }

  async function copySelection() {
    const text = state.selection ? state.selection.text : '';
    if (!text) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (_) {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.top = '-1000px';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try {
        ok = document.execCommand('copy');
      } catch (_) {
        ok = false;
      }
      area.remove();
    }
    hideSelToolbar();
    toast(ok ? '已复制到剪贴板' : '复制失败，请手动选择复制', ok ? 'success' : 'warn', 2000);
  }

  function highlightSelection() {
    if (!state.selection || !state.rendition) return;
    const { cfiRange } = state.selection;
    try {
      state.rendition.annotations.highlight(cfiRange, {}, null, 'moyue-highlight', {
        fill: 'rgba(185, 106, 69, 0.22)',
        'fill-opacity': '1',
      });
      toast('已高亮（仅本次会话）', 'success', 2000);
    } catch (err) {
      toast('高亮失败', 'warn');
    }
    hideSelToolbar();
  }

  /* ======================= 顶栏淡出 ======================= */

  function wake() {
    if (destroyed) return;
    dom.reader.classList.remove('is-idle');
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = window.setTimeout(() => {
      if (!state.drawerOpen && !isSettingsOpen()) dom.reader.classList.add('is-idle');
    }, 3000);
  }

  function attachContentDoc(doc) {
    if (!doc || attachedDocs.has(doc)) return;
    attachedDocs.add(doc);
    ['mousemove', 'mousedown', 'wheel', 'keydown'].forEach((eventName) => {
      doc.addEventListener(eventName, wake, { passive: true });
    });
  }

  function attachContentListeners() {
    if (!state.rendition) return;
    let contentsList = [];
    try {
      contentsList = state.rendition.getContents() || [];
    } catch (_) {
      contentsList = [];
    }
    contentsList.forEach((contents) => {
      try {
        attachContentDoc(contents.document);
      } catch (_) {
        /* ignore */
      }
    });
  }

  /* ======================= 抽屉 ======================= */

  function openDrawer(tab) {
    state.drawerOpen = true;
    dom.drawer.classList.add('is-open');
    setTab(tab || state.activeTab);
    wake();
    if (tab === 'search') {
      window.setTimeout(() => dom.searchInput.focus(), 60);
    }
  }

  function closeDrawer() {
    state.drawerOpen = false;
    dom.drawer.classList.remove('is-open');
    syncDrawerButtons();
    wake();
  }

  function toggleDrawer(tab) {
    if (state.drawerOpen && state.activeTab === tab) closeDrawer();
    else openDrawer(tab);
  }

  function syncDrawerButtons() {
    const tocBtn = dom.reader.querySelector('[data-action="toc"]');
    const searchBtn = dom.reader.querySelector('[data-action="search"]');
    if (!state.drawerOpen) {
      if (tocBtn) tocBtn.classList.remove('is-active');
      if (searchBtn) searchBtn.classList.remove('is-active');
      return;
    }
    if (tocBtn) tocBtn.classList.toggle('is-active', state.activeTab === 'toc' || state.activeTab === 'bookmarks');
    if (searchBtn) searchBtn.classList.toggle('is-active', state.activeTab === 'search');
  }

  function setTab(tab) {
    state.activeTab = tab;
    dom.drawer.querySelectorAll('.drawer-tab').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.tab === tab);
    });
    dom.drawer.querySelectorAll('.drawer-panel').forEach((panel) => {
      panel.classList.toggle('is-active', panel.dataset.panel === tab);
    });
    if (tab === 'toc') {
      const current = dom.tocList.querySelector('.is-current');
      if (current) current.scrollIntoView({ block: 'nearest' });
    }
    if (tab === 'bookmarks') renderBookmarks();
    syncDrawerButtons();
  }

  /* ======================= 全屏 ======================= */

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
    } else if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {
        toast('当前浏览器不支持全屏', 'warn');
      });
    } else {
      toast('当前浏览器不支持全屏', 'warn');
    }
  }

  function updateFullscreenIcon() {
    const btn = dom.reader.querySelector('[data-action="fullscreen"]');
    if (!btn) return;
    const span = btn.querySelector('span');
    if (span) span.innerHTML = icon(document.fullscreenElement ? 'fullscreen-exit' : 'fullscreen', 18);
  }

  /* ======================= 设置变更 ======================= */

  function onSettingsChanged(settings) {
    if (!state.rendition) return;
    const previous = state.lastSettings || {};
    if (settings.theme !== previous.theme) {
      applyTheme(settings.theme);
      try {
        state.rendition.themes.select(settings.theme);
      } catch (_) {
        /* ignore */
      }
    }
    if (
      settings.fontSize !== previous.fontSize ||
      settings.fontFamily !== previous.fontFamily ||
      settings.lineHeight !== previous.lineHeight ||
      settings.letterSpacing !== previous.letterSpacing ||
      settings.paragraphSpacing !== previous.paragraphSpacing
    ) {
      applyTypography(state.rendition);
    }
    if (settings.autoTurnEnabled !== previous.autoTurnEnabled || settings.autoTurnInterval !== previous.autoTurnInterval) {
      syncAutoTurn();
    }
    if (settings.maxWidth !== previous.maxWidth) {
      updateHostWidth();
      window.setTimeout(() => {
        try {
          state.rendition.resize();
        } catch (_) {
          /* ignore */
        }
      }, 240);
    }
    if (settings.pageMode !== previous.pageMode || settings.spread !== previous.spread) {
      applyPageMode(settings);
    }
    state.lastSettings = { ...settings };
  }

  function applyPageMode(settings) {
    applyReaderChromeClass();
    const flow = settings.pageMode === 'scroll' ? 'scrolled-doc' : 'paginated';
    const spread = settings.pageMode === 'scroll' ? 'none' : settings.spread === 'none' ? 'none' : 'auto';
    try {
      state.rendition.flow(flow);
      state.rendition.spread(spread, 900);
      window.setTimeout(() => {
        try {
          state.rendition.resize();
        } catch (_) {
          /* ignore */
        }
      }, 120);
    } catch (err) {
      console.warn('[reader] 切换翻页方式失败', err);
    }
  }

  /* ======================= 自动翻页 ======================= */

  function autoTurnSeconds() {
    const seconds = Math.round(Number(store.settings.autoTurnInterval) || 20);
    return Math.max(3, Math.min(120, seconds));
  }

  function autoTurnTick() {
    if (destroyed || !state.rendition) {
      stopAutoTurn();
      return;
    }
    if (document.hidden || isSettingsOpen()) return;
    const loc = state.lastLocation;
    if (loc && loc.atEnd) {
      updateSettings({ autoTurnEnabled: false });
      toast('已到最后一页，自动翻页已停止', 'warn');
      stopAutoTurn();
      return;
    }
    flip(1);
  }

  function startAutoTurn() {
    if (state.autoTimer) {
      window.clearInterval(state.autoTimer);
      state.autoTimer = 0;
    }
    if (destroyed || !state.rendition || !store.settings.autoTurnEnabled) {
      updateAutoTurnUI();
      return;
    }
    state.autoTimer = window.setInterval(autoTurnTick, autoTurnSeconds() * 1000);
    updateAutoTurnUI();
  }

  function stopAutoTurn() {
    if (state.autoTimer) {
      window.clearInterval(state.autoTimer);
      state.autoTimer = 0;
    }
    updateAutoTurnUI();
  }

  function syncAutoTurn() {
    if (store.settings.autoTurnEnabled) startAutoTurn();
    else stopAutoTurn();
  }

  function toggleAutoTurn() {
    wake();
    updateSettings({ autoTurnEnabled: !store.settings.autoTurnEnabled });
    if (store.settings.autoTurnEnabled) toast(`自动翻页已开启：每 ${autoTurnSeconds()} 秒翻一页`, 'info');
    else toast('自动翻页已关闭', 'info');
  }

  function updateAutoTurnUI() {
    const enabled = Boolean(store.settings.autoTurnEnabled);
    const btn = dom.reader.querySelector('[data-action="autoturn"]');
    if (btn) {
      btn.classList.toggle('is-active', enabled);
      btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
      btn.title = enabled ? `自动翻页中 · ${autoTurnSeconds()} 秒/页（A 关闭）` : '自动翻页 (A)';
    }
    if (dom.autoChip) {
      dom.autoChip.hidden = !enabled;
      dom.autoChip.title = enabled ? '点击关闭自动翻页' : '自动翻页';
    }
    if (dom.autoChipText) dom.autoChipText.textContent = `自动翻页 ${autoTurnSeconds()}s`;
  }

  /* ======================= 事件绑定 ======================= */

  const onKeyDown = (event) => {
    if (destroyed || event.defaultPrevented) return;
    wake();
    if (event.key === 'Escape') {
      if (state.drawerOpen) {
        closeDrawer();
        event.preventDefault();
        return;
      }
      if (aiPanel.isOpen()) {
        aiPanel.close();
        event.preventDefault();
        return;
      }
      if (isSettingsOpen()) return;
      event.preventDefault();
      backToShelf();
      return;
    }
    if (isTypingTarget(event.target)) return;
    if (isSettingsOpen()) return;
    const key = event.key;
    if (key === 'ArrowRight' || key === 'PageDown' || key === ' ' || key === 'Spacebar') {
      event.preventDefault();
      flip(1);
    } else if (key === 'ArrowLeft' || key === 'PageUp') {
      event.preventDefault();
      flip(-1);
    } else if (key === '+' || key === '=') {
      event.preventDefault();
      stepFont(1);
    } else if (key === '-' || key === '_') {
      event.preventDefault();
      stepFont(-1);
    } else if (key === 't' || key === 'T') {
      event.preventDefault();
      toggleDrawer('toc');
    } else if (key === 's' || key === 'S') {
      event.preventDefault();
      toggleSettings();
    } else if (key === 'f' || key === 'F') {
      event.preventDefault();
      toggleFullscreen();
    } else if (key === 'b' || key === 'B') {
      event.preventDefault();
      toggleBookmark();
    } else if (key === 'a' || key === 'A') {
      event.preventDefault();
      toggleAutoTurn();
    } else if (key === 'i' || key === 'I') {
      event.preventDefault();
      aiPanel.toggle();
    } else if (key === '/') {
      event.preventDefault();
      openDrawer('search');
    }
  };

  function flip(direction) {
    if (!state.rendition) return;
    // 上下滚动模式：按钮按「一屏」滚动 epub.js 的滚动容器；到边界后再切到下一 / 上一节
    if (store.settings.pageMode === 'scroll') {
      try {
        const container = dom.host.querySelector('.epub-container');
        if (container) {
          const before = container.scrollTop;
          const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
          container.scrollBy({ top: direction * Math.max(180, container.clientHeight * 0.86), behavior: 'smooth' });
          if ((direction > 0 && before >= maxScroll - 4) || (direction < 0 && before <= 4)) {
            const promise = direction > 0 ? state.rendition.next() : state.rendition.prev();
            Promise.resolve(promise).catch(() => {});
          }
          if (store.settings.autoTurnEnabled) startAutoTurn();
          return;
        }
      } catch (_) {
        /* 回退到 epub.js 的翻页 */
      }
    }
    const promise = direction > 0 ? state.rendition.next() : state.rendition.prev();
    Promise.resolve(promise).catch(() => {});
    // 手动翻页后重新计时，避免自动翻页紧跟着再翻一次
    if (store.settings.autoTurnEnabled) startAutoTurn();
  }

  function stepFont(delta) {
    updateSettings({ fontSize: clamp(store.settings.fontSize + delta, 12, 40) });
  }

  dom.reader.addEventListener('click', (event) => {
    const actionBtn = event.target.closest ? event.target.closest('[data-action]') : null;
    if (!actionBtn || !dom.reader.contains(actionBtn)) return;
    switch (actionBtn.dataset.action) {
      case 'back':
        backToShelf();
        break;
      case 'toc':
        toggleDrawer('toc');
        break;
      case 'search':
        toggleDrawer('search');
        break;
      case 'bookmark':
        toggleBookmark();
        break;
      case 'autoturn':
        toggleAutoTurn();
        break;
      case 'ai':
        aiPanel.toggle();
        break;
      case 'settings':
        toggleSettings();
        break;
      case 'fullscreen':
        toggleFullscreen();
        break;
      case 'prev':
        flip(-1);
        break;
      case 'next':
        flip(1);
        break;
      case 'progress': {
        const rect = dom.progressTrack.getBoundingClientRect();
        const fraction = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
        jumpByProgress(fraction);
        break;
      }
      case 'close-drawer':
        closeDrawer();
        break;
      default:
        break;
    }
  });

  dom.drawer.addEventListener('click', (event) => {
    const tab = event.target.closest ? event.target.closest('[data-tab]') : null;
    if (tab) {
      setTab(tab.dataset.tab);
      wake();
    }
  });

  dom.searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      runSearch(dom.searchInput.value);
    } else if (event.key === 'Escape') {
      event.stopPropagation();
      closeDrawer();
    }
  });

  dom.searchInput.addEventListener('input', () => {
    if (!dom.searchInput.value.trim()) {
      state.searchSeq += 1;
      dom.searchHint.textContent = '输入关键词后按回车，在全书范围内搜索。';
      clearNode(dom.searchResults);
    }
  });

  dom.selToolbar.addEventListener('click', (event) => {
    const btn = event.target.closest ? event.target.closest('[data-sel]') : null;
    if (!btn) return;
    if (btn.dataset.sel === 'copy') copySelection();
    else if (btn.dataset.sel === 'highlight') highlightSelection();
  });

  ['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel'].forEach((name) => {
    dom.reader.addEventListener(name, wake, { passive: true });
  });

  const onGlobalMouseDown = (event) => {
    if (dom.selToolbar.contains(event.target)) return;
    hideSelToolbar();
  };

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('fullscreenchange', updateFullscreenIcon);
  document.addEventListener('mousedown', onGlobalMouseDown, true);

  const onWindowResize = debounce(() => {
    if (destroyed || !state.rendition) return;
    try {
      state.rendition.resize();
    } catch (_) {
      /* ignore */
    }
  }, 220);
  window.addEventListener('resize', onWindowResize);

  const unsubscribe = subscribe((event) => {
    if (event.type === 'settings') onSettingsChanged(event.settings);
  });

  cleanups.push(() => unsubscribe());
  cleanups.push(() => document.removeEventListener('keydown', onKeyDown));
  cleanups.push(() => document.removeEventListener('fullscreenchange', updateFullscreenIcon));
  cleanups.push(() => document.removeEventListener('mousedown', onGlobalMouseDown, true));
  cleanups.push(() => window.removeEventListener('resize', onWindowResize));
  cleanups.push(() => {
    if (state.idleTimer) clearTimeout(state.idleTimer);
    if (state.saveTimer) clearTimeout(state.saveTimer);
  });

  function backToShelf() {
    flushProgress();
    window.location.hash = '#/shelf';
  }

  /**
   * 销毁前先停掉 book.locations 的生成队列。
   * 否则 locations.generate(1600) 还在后台逐章 load 时 book.destroy() 会销毁 Section，
   * epub.js 内部队列继续访问已销毁的 section，控制台抛
   * "Cannot read properties of undefined (reading 'content')"。
   * Locations.destroy() 内部会 q.stop() / clearTimeout(processingTimeout)。
   */
  function stopBookTasks() {
    try {
      const book = state.book;
      if (!book) return;
      // 1) 停掉 locations 生成队列（q.stop() + clearTimeout）
      if (book.locations && typeof book.locations.destroy === 'function') {
        book.locations.destroy();
      }
      // 置空，避免 book.destroy() 再 destroy 一次已释放的队列
      book.locations = null;
      // 2) 保留 hooks 的 Section.destroy（见 neutralizeSectionTeardown 注释），
      //    防止仍在飞行的 section.load() 回调访问 this.hooks.content 抛错
      neutralizeSectionTeardown(book);
    } catch (_) {
      /* ignore */
    }
  }

  function retry() {
    bootToken += 1;
    clearNode(dom.veil);
    stopBookTasks();
    if (state.rendition) {
      try {
        state.rendition.destroy();
      } catch (_) {
        /* ignore */
      }
      state.rendition = null;
    }
    if (state.book) {
      try {
        state.book.destroy();
      } catch (_) {
        /* ignore */
      }
      state.book = null;
    }
    store.prepared.delete(bookId);
    boot();
  }

  function destroy() {
    if (destroyed) return;
    if (state.saveTimer) {
      clearTimeout(state.saveTimer);
      state.saveTimer = 0;
    }
    stopAutoTurn();
    state.contentDocs.clear();
    flushProgress();
    // 顺序很重要：先停 locations 队列 → 销毁 rendition（渲染队列）→ 销毁 book（archive/spine），
    // 避免后台 locations.generate 访问已销毁的 Section 抛出异步错误。
    stopBookTasks();
    try {
      if (state.rendition) state.rendition.destroy();
    } catch (_) {
      /* ignore */
    }
    try {
      if (state.book) state.book.destroy();
    } catch (_) {
      /* ignore */
    }
    state.rendition = null;
    state.book = null;
    destroyed = true;
    aiPanel.destroy();
    cleanups.forEach((fn) => {
      try {
        fn();
      } catch (_) {
        /* ignore */
      }
    });
    cleanups.length = 0;
    closeDrawer();
    closeSettings();
    document.body.dataset.ready = '0';
    delete document.body.dataset.route;
    delete document.body.dataset.reading;
    document.title = '墨阅 · 本地电子书阅读器';
    root.innerHTML = '';
  }

  wake();
  boot();

  return { destroy };
}

/* ---------------- 工具函数 ---------------- */

/**
 * 取书籍原始字节：epub.js 需要 ArrayBuffer 才会走 binary 解析（见 openBook 注释）。
 */
async function fetchBookBuffer(url) {
  let res;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch (err) {
    throw new Error('无法读取书籍内容，请确认墨阅服务正在运行');
  }
  if (res.status === 404) throw new Error('书籍内容不存在，文件可能已被移动或删除');
  if (!res.ok) throw new Error(`读取书籍内容失败（HTTP ${res.status}）`);
  let buffer;
  try {
    buffer = await res.arrayBuffer();
  } catch (err) {
    throw new Error('读取书籍内容失败，请重试');
  }
  if (!buffer || !buffer.byteLength) throw new Error('书籍内容为空或已损坏');
  return buffer;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeText(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * epub.js 的 Section.destroy() 会把 this.hooks 置为 undefined；
 * 但 Locations.destroy() 只是 q.stop()，无法取消已经发出的 section.load()。
 * 该 promise 的 .then 里会执行 this.hooks.content.trigger(...) →
 * "Cannot read properties of undefined (reading 'content')"（dist 1:149704）。
 * 这里把每个 Section 的 destroy 换成「只 unload、保留 hooks」的版本，
 * 让飞行中的 section.load() 回调安全返回，Section 交给 GC 回收。
 */
function neutralizeSectionTeardown(book) {
  const items = book && book.spine && Array.isArray(book.spine.spineItems) ? book.spine.spineItems : [];
  items.forEach((sec) => {
    if (!sec || sec.__moyuePatched || typeof sec.destroy !== 'function') return;
    sec.__moyuePatched = true;
    sec.destroy = function patchedSectionDestroy() {
      try {
        if (typeof this.unload === 'function') this.unload();
      } catch (_) {
        /* ignore */
      }
    };
  });
}
