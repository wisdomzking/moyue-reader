/**
 * PDF 阅读器（pdf.js 3.11.174 UMD + worker）
 * - 单页 canvas 渲染（devicePixelRatio 高清）
 * - 页码 / 缩放 / 适应宽度 / 实际大小 / 目录 outline / 全屏 / 夜间滤镜
 * - 进度保存与恢复、键盘、Ctrl+滚轮缩放、滚轮翻页
 */
import { api } from './api.js';
import { store, getBook, patchBookProgress, subscribe, updateSettings } from './store.js';
import { icon, hydrateIcons } from './icons.js';
import { el, clearNode, toast, clamp, debounce, isTypingTarget } from './ui.js';
import { isSettingsOpen, toggleSettings } from './settings.js';
import { createAiPanel } from './ai-guide.js';

const TEMPLATE = `
<div class="reader reader-pdf" data-testid="reader" role="region" aria-label="PDF 阅读器">
  <header class="pdf-toolbar">
    <button class="reader-back" type="button" data-action="back" aria-label="返回书架" title="返回书架 (Esc)">
      <span data-ico="chevron-left" data-ico-size="20"></span>
    </button>
    <span class="pdf-title" id="pdfTitle">PDF</span>

    <div class="pdf-group">
      <button class="reader-action" type="button" data-action="prev" aria-label="上一页" title="上一页 (←)">
        <span data-ico="chevron-left"></span>
      </button>
      <input class="pdf-page-input" id="pdfPageInput" data-testid="page-input" type="text" inputmode="numeric" aria-label="页码" />
      <span class="pdf-page-total" id="pdfPageTotal">/ 0</span>
      <button class="reader-action" type="button" data-action="next" aria-label="下一页" title="下一页 (→)">
        <span data-ico="chevron-right"></span>
      </button>
    </div>

    <div class="reader-divider"></div>

    <div class="pdf-group">
      <button class="reader-action" type="button" data-action="zoom-out" aria-label="缩小" title="缩小 (−)">
        <span data-ico="zoom-out"></span>
      </button>
      <span class="pdf-zoom-label" id="pdfZoomLabel">100%</span>
      <button class="reader-action" type="button" data-action="zoom-in" aria-label="放大" title="放大 (+)">
        <span data-ico="zoom-in"></span>
      </button>
      <button class="btn btn-ghost pdf-label-btn" type="button" data-action="fit-width" title="适应宽度">适应宽度</button>
      <button class="btn btn-ghost pdf-label-btn" type="button" data-action="actual-size" title="实际大小">实际大小</button>
    </div>

    <div class="reader-divider"></div>

    <div class="pdf-group">
      <button class="pdf-night-indicator" type="button" data-action="night" title="夜间滤镜" aria-label="夜间滤镜">
        <span data-ico="moon" data-ico-size="15"></span><span>夜间滤镜</span>
      </button>
      <button class="reader-action" type="button" data-action="autoturn" aria-label="自动翻页" title="自动翻页 (A)">
        <span data-ico="clock"></span>
      </button>
      <button class="reader-action" type="button" data-action="ai" aria-label="AI 本页导读" title="AI 本页导读 (I)">
        <span data-ico="sparkles"></span>
      </button>
      <button class="reader-action" type="button" data-action="toc" aria-label="目录" title="目录 (T)">
        <span data-ico="toc"></span>
      </button>
      <button class="reader-action" type="button" data-action="settings" aria-label="阅读设置" title="设置 (S)">
        <span data-ico="sliders"></span>
      </button>
      <button class="reader-action" type="button" data-action="fullscreen" aria-label="全屏" title="全屏 (F)">
        <span data-ico="fullscreen"></span>
      </button>
    </div>
  </header>

  <div class="pdf-stage" id="pdfStage">
    <div class="pdf-page-wrap">
      <div class="pdf-page" id="pdfPage">
        <canvas id="pdf-canvas" aria-label="PDF 页面"></canvas>
        <div class="pdf-page-loading" id="pdfPageLoading"><span class="spinner spinner-sm"></span></div>
      </div>
    </div>
  </div>

  <button class="page-nav page-nav-prev" type="button" data-action="prev" aria-label="上一页">
    <span data-ico="chevron-left" data-ico-size="22"></span>
  </button>
  <button class="page-nav page-nav-next" type="button" data-action="next" aria-label="下一页">
    <span data-ico="chevron-right" data-ico-size="22"></span>
  </button>

  <div class="reader-progress">
    <span class="progress-chapter" id="pdfChapterLabel"></span>
    <button class="auto-chip" id="pdfAutoTurnChip" type="button" data-action="autoturn" hidden title="关闭自动翻页">
      <span data-ico="clock" data-ico-size="13"></span>
      <span id="pdfAutoTurnChipText">自动翻页</span>
    </button>
    <button class="progress-track" type="button" data-action="progress" aria-label="阅读进度，点击跳转">
      <span class="progress-rail"></span>
      <span class="progress-fill" id="pdfProgressFill" style="width:0%"></span>
      <span class="progress-knob" id="pdfProgressKnob" style="left:0%"></span>
    </button>
    <span class="progress-label" id="pdfProgressLabel" data-testid="progress-label">1 / 0</span>
  </div>

  <aside class="reader-drawer" id="pdfDrawer" data-testid="toc" aria-label="PDF 目录">
    <div class="drawer-tabs">
      <button class="drawer-tab is-active" type="button" data-tab="outline">目录</button>
      <button class="btn btn-icon btn-ghost btn-xs drawer-close" type="button" data-action="close-drawer" aria-label="关闭目录">
        <span data-ico="close" data-ico-size="16"></span>
      </button>
    </div>
    <div class="drawer-panel is-active" data-panel="outline">
      <div class="drawer-panel-scroll">
        <ul class="toc-list pdf-outline" id="pdfOutline" role="list"></ul>
      </div>
    </div>
  </aside>

  <div class="reader-veil" id="pdfVeil"></div>
</div>
`;

export function mountPdf(root, bookId) {
  let destroyed = false;
  let bootToken = 0;

  const state = {
    pdf: null,
    page: 1,
    total: 0,
    scale: 1,
    renderTask: null,
    rendering: false,
    pendingRender: null,
    outline: [],
    flatOutline: [],
    chapterLabel: '',
    drawerOpen: false,
    lastSettings: { ...store.settings },
    nightOn: true,
    saveTimer: 0,
    wheelCooldown: 0,
    zoomSeq: 0,
    autoTimer: 0,
    aiPage: 0,
    aiContext: null,
    bookTitle: 'PDF 文档',
  };

  const cleanups = [];

  root.innerHTML = TEMPLATE;
  const reader = root.querySelector('[data-testid="reader"]');
  hydrateIcons(reader);

  const aiPanel = createAiPanel({
    root: reader,
    bookId,
    mode: 'page',
    resolveContext: buildAiContext,
  });

  const dom = {
    reader,
    title: reader.querySelector('#pdfTitle'),
    stage: reader.querySelector('#pdfStage'),
    canvas: reader.querySelector('#pdf-canvas'),
    pageWrap: reader.querySelector('.pdf-page-wrap'),
    pageBox: reader.querySelector('#pdfPage'),
    pageLoading: reader.querySelector('#pdfPageLoading'),
    pageInput: reader.querySelector('#pdfPageInput'),
    pageTotal: reader.querySelector('#pdfPageTotal'),
    zoomLabel: reader.querySelector('#pdfZoomLabel'),
    chapterLabel: reader.querySelector('#pdfChapterLabel'),
    progressFill: reader.querySelector('#pdfProgressFill'),
    progressKnob: reader.querySelector('#pdfProgressKnob'),
    progressLabel: reader.querySelector('#pdfProgressLabel'),
    veil: reader.querySelector('#pdfVeil'),
    drawer: reader.querySelector('#pdfDrawer'),
    outlineList: reader.querySelector('#pdfOutline'),
    nightBtn: reader.querySelector('[data-action="night"]'),
    progressTrack: reader.querySelector('.progress-track'),
    autoChip: reader.querySelector('#pdfAutoTurnChip'),
    autoChipText: reader.querySelector('#pdfAutoTurnChipText'),
  };

  document.body.dataset.route = 'pdf';
  document.body.dataset.ready = '0';

  /* ---------------- 遮罩 ---------------- */

  function showVeil(html) {
    dom.veil.innerHTML = html;
    dom.veil.classList.remove('is-hidden');
    hydrateIcons(dom.veil);
  }

  function hideVeil() {
    dom.veil.classList.add('is-hidden');
    document.body.dataset.ready = '1';
  }

  function showLoading(text) {
    showVeil(`
      <span class="spinner"></span>
      <div class="veil-title">${escapeText(text || '正在打开 PDF…')}</div>
      <div class="veil-text">大文件首次载入会慢一些，请稍候。</div>
    `);
  }

  function showError(title, message) {
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
    dom.veil.querySelector('[data-veil-action="retry"]')?.addEventListener('click', () => boot(true));
    dom.veil.querySelector('[data-veil-action="back"]')?.addEventListener('click', backToShelf);
    document.body.dataset.ready = '1';
  }

  /* ---------------- 启动 ---------------- */

  async function boot(isRetry) {
    const token = ++bootToken;
    state.lastSettings = { ...store.settings };
    showLoading('正在打开 PDF…');

    try {
      let record = getBook(bookId);
      if (!record) record = await api.book(bookId);
      if (destroyed || token !== bootToken) return;
      renderMeta(record);

      if (record.status === 'converting') {
        showLoading('正在准备 PDF…');
        record = await pollUntilReady(token);
        if (!record || destroyed || token !== bootToken) return;
        renderMeta(record);
      }
      if (record.status === 'error' || record.status === 'unsupported') {
        showError('这本 PDF 暂时无法打开', record.error || '文件可能已损坏。');
        return;
      }

      const prepared = await getPrepared(bookId);
      if (destroyed || token !== bootToken) return;
      if (prepared.type && prepared.type !== 'pdf') {
        document.body.dataset.ready = '0';
        window.location.hash = '#/read/' + bookId;
        return;
      }

      if (isRetry && state.pdf) {
        try {
          await state.pdf.destroy();
        } catch (_) {
          /* ignore */
        }
        state.pdf = null;
      }

      const pdfjs = window.pdfjsLib;
      if (!pdfjs) throw new Error('PDF 引擎未加载（vendor/pdf.min.js）');
      pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.js';

      const task = pdfjs.getDocument({
        url: prepared.url || api.contentUrl(bookId),
        rangeChunkSize: 65536,
        disableAutoFetch: false,
      });
      cleanups.push(() => {
        try {
          Promise.resolve(task.destroy()).catch(() => {});
        } catch (_) {
          /* ignore */
        }
      });
      const pdf = await task.promise;
      if (destroyed || token !== bootToken) return;
      state.pdf = pdf;
      state.total = pdf.numPages;
      dom.pageTotal.textContent = `/ ${state.total}`;
      dom.pageInput.maxLength = String(state.total).length + 1;

      const restored = clamp(Number(record.progress && record.progress.page) || 1, 1, state.total);
      state.page = restored;
      updatePageInput();
      updateNightFilter();

      await renderPage(state.page);
      if (destroyed || token !== bootToken) return;

      hideVeil();
      updateProgressUI();
      syncAutoTurn();
      void aiPanel.update();
      loadOutline();
      window.setTimeout(() => dom.pageInput.blur(), 0);
    } catch (err) {
      if (destroyed || token !== bootToken) return;
      showError('打开 PDF 失败', (err && err.message) || '无法读取文件内容。');
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
    for (let i = 0; i < 120; i++) {
      await sleep(1500);
      if (destroyed || token !== bootToken) return null;
      let record;
      try {
        record = await api.book(bookId);
      } catch (_) {
        continue;
      }
      if (record.status === 'ready' || record.status === 'error' || record.status === 'unsupported') return record;
    }
    throw new Error('准备超时，请稍后重试');
  }

  function renderMeta(record) {
    const title = (record && (record.title || record.filename)) || 'PDF 文档';
    state.bookTitle = title;
    dom.title.textContent = title;
    dom.title.title = title;
    document.title = `${title} · 墨阅`;
  }

  /* ---------------- AI 页面上下文 ---------------- */

  async function buildAiContext() {
    if (!state.pdf) return null;
    const pageNo = state.page;
    if (state.aiPage === pageNo && state.aiContext) return state.aiContext;
    let text = '';
    try {
      const page = await state.pdf.getPage(pageNo);
      const content = await page.getTextContent();
      text = (content.items || [])
        .map((item) => (item && typeof item.str === 'string' ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    } catch (_) {
      text = '';
    }
    const title = `第 ${pageNo} 页${state.chapterLabel ? ` · ${state.chapterLabel}` : ''}`;
    const context = {
      key: `page-${pageNo}`,
      title,
      text: text.slice(0, 20000),
      bookTitle: state.bookTitle || 'PDF 文档',
    };
    state.aiPage = pageNo;
    state.aiContext = context;
    return context;
  }

  /* ---------------- 渲染 ---------------- */

  function availableBox() {
    const style = window.getComputedStyle(dom.stage);
    const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    const padY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    return {
      width: Math.max(120, dom.stage.clientWidth - padX),
      height: Math.max(120, dom.stage.clientHeight - padY),
    };
  }

  function computeScale(baseViewport) {
    const zoom = store.settings.pdfZoom;
    const box = availableBox();
    if (zoom === 'fit') return box.width / baseViewport.width;
    if (zoom === 'page') {
      return Math.min(box.width / baseViewport.width, box.height / baseViewport.height);
    }
    const numeric = Number(zoom);
    if (Number.isFinite(numeric) && numeric > 0) return clamp(numeric / 100, 0.2, 6);
    return box.width / baseViewport.width;
  }

  async function renderPage(pageNumber) {
    if (!state.pdf || destroyed) return;
    const token = ++state.zoomSeq;
    state.rendering = true;
    dom.pageLoading.classList.add('is-visible');
    try {
      if (state.renderTask) {
        try {
          state.renderTask.cancel();
        } catch (_) {
          /* ignore */
        }
        state.renderTask = null;
      }
      const page = await state.pdf.getPage(pageNumber);
      if (destroyed || token !== state.zoomSeq) return;
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = computeScale(baseViewport);
      state.scale = scale;
      const viewport = page.getViewport({ scale });
      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      const canvas = dom.canvas;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      dom.pageBox.style.width = `${Math.floor(viewport.width)}px`;
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const renderTask = page.render({
        canvasContext: ctx,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
      });
      state.renderTask = renderTask;
      await renderTask.promise;
      state.renderTask = null;
      if (destroyed || token !== state.zoomSeq) return;
      updateZoomLabel();
      state.rendering = false;
      dom.pageLoading.classList.remove('is-visible');
      updateOutlineCurrent();
    } catch (err) {
      if (err && err.name === 'RenderingCancelledException') return;
      state.rendering = false;
      dom.pageLoading.classList.remove('is-visible');
      if (!destroyed) console.warn('[pdf] 渲染失败', err);
    }
  }

  function updateZoomLabel() {
    dom.zoomLabel.textContent = `${Math.round(state.scale * 100)}%`;
  }

  /* ---------------- 页码 / 进度 ---------------- */

  function updatePageInput() {
    dom.pageInput.value = String(state.page);
  }

  function updateProgressUI() {
    const percent = state.total > 0 ? clamp(state.page / state.total, 0, 1) : 0;
    const pct = (percent * 100).toFixed(2);
    dom.progressFill.style.width = `${pct}%`;
    dom.progressKnob.style.left = `${pct}%`;
    dom.progressLabel.textContent = `${state.page} / ${state.total}`;
    dom.chapterLabel.textContent = state.chapterLabel || '';
    document.body.dataset.reading = String(Math.round(percent * 100));
  }

  async function goToPage(pageNumber, options = {}) {
    if (!state.pdf) return;
    const next = clamp(Math.round(Number(pageNumber) || 1), 1, state.total);
    const changed = next !== state.page;
    state.page = next;
    updatePageInput();
    updateProgressUI();
    if (!options.keepScroll) dom.stage.scrollTo({ top: 0, behavior: 'auto' });
    await renderPage(next);
    if (changed) {
      updateOutlineCurrent();
      scheduleSave();
      if (store.settings.autoTurnEnabled) startAutoTurn();
      void aiPanel.update();
    }
  }

  function scheduleSave() {
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = window.setTimeout(saveProgress, 800);
  }

  function buildProgressPayload() {
    if (!state.total) return null;
    return {
      percent: Number(clamp(state.page / state.total, 0, 1).toFixed(4)),
      location: '',
      page: state.page,
      totalPages: state.total,
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
      /* ignore */
    }
  }

  /* ---------------- 缩放 ---------------- */

  function applyZoomMode(mode) {
    if (mode === 'fit' || mode === 'page') {
      updateSettings({ pdfZoom: mode });
      return;
    }
    const numeric = Math.round(clamp(Number(mode) || 100, 25, 500));
    updateSettings({ pdfZoom: String(numeric) });
  }

  function zoomBy(direction) {
    const current = state.scale || 1;
    const nextPct = Math.round(clamp(current * (direction > 0 ? 1.15 : 1 / 1.15), 0.25, 5) * 100);
    updateSettings({ pdfZoom: String(nextPct) });
  }

  /* ---------------- 目录 ---------------- */

  async function loadOutline() {
    if (!state.pdf) return;
    let outline = null;
    try {
      outline = await state.pdf.getOutline();
    } catch (_) {
      outline = null;
    }
    if (destroyed) return;
    state.outline = Array.isArray(outline) ? outline : [];
    if (!state.outline.length) {
      renderOutlineEmpty();
      return;
    }
    const flat = [];
    flattenOutline(state.outline, 1, flat);
    const resolved = await Promise.all(
      flat.map(async (item) => {
        try {
          const page = await resolveDestPage(item.dest);
          return { ...item, page };
        } catch (_) {
          return { ...item, page: null };
        }
      })
    );
    if (destroyed) return;
    state.flatOutline = resolved.filter((item) => item.page);
    renderOutline();
  }

  function flattenOutline(items, level, out) {
    if (!Array.isArray(items)) return out;
    items.forEach((item) => {
      out.push({ title: item.title || '未命名章节', dest: item.dest, level: Math.min(level, 3) });
      if (item.items && item.items.length) flattenOutline(item.items, level + 1, out);
    });
    return out;
  }

  async function resolveDestPage(dest) {
    if (!state.pdf || dest == null) return null;
    let ref = dest;
    if (typeof dest === 'string') {
      ref = await state.pdf.getDestination(dest);
    }
    if (!Array.isArray(ref) || !ref.length) return null;
    const pageIndex = await state.pdf.getPageIndex(ref[0]);
    return pageIndex + 1;
  }

  function renderOutlineEmpty() {
    clearNode(dom.outlineList);
    dom.outlineList.appendChild(
      el('li', { class: 'drawer-empty' }, [
        el('span', { html: icon('toc', 26) }),
        el('span', { text: '这份 PDF 没有目录' }),
      ])
    );
  }

  function renderOutline() {
    clearNode(dom.outlineList);
    if (!state.flatOutline.length) {
      renderOutlineEmpty();
      return;
    }
    state.flatOutline.forEach((item) => {
      const li = el('li', { role: 'listitem' });
      li.appendChild(
        el('button', {
          class: `toc-item toc-level-${item.level}`,
          type: 'button',
          style: { paddingLeft: `${10 + (item.level - 1) * 14}px` },
          title: item.title,
          dataset: { page: String(item.page) },
          onclick: () => {
            goToPage(item.page);
            closeDrawer();
          },
        }, [el('span', { class: 'toc-label', text: item.title })])
      );
      dom.outlineList.appendChild(li);
    });
    updateOutlineCurrent();
  }

  function updateOutlineCurrent() {
    if (!state.flatOutline.length) return;
    let currentIndex = -1;
    state.flatOutline.forEach((item, index) => {
      if (item.page && item.page <= state.page) currentIndex = index;
    });
    const current = currentIndex >= 0 ? state.flatOutline[currentIndex] : null;
    state.chapterLabel = current ? current.title : '';
    dom.chapterLabel.textContent = state.chapterLabel;
    dom.outlineList.querySelectorAll('.toc-item').forEach((node, index) => {
      node.classList.toggle('is-current', index === currentIndex);
    });
  }

  /* ---------------- 夜间滤镜 ---------------- */

  function updateNightFilter() {
    const isDark = store.settings.theme === 'dark';
    const applied = state.nightOn && isDark;
    dom.canvas.classList.toggle('is-night', applied);
    dom.nightBtn.hidden = !isDark;
    dom.nightBtn.classList.toggle('is-active', applied);
    dom.nightBtn.setAttribute('aria-pressed', applied ? 'true' : 'false');
  }

  /* ---------------- 抽屉 ---------------- */

  function openDrawer() {
    state.drawerOpen = true;
    dom.drawer.classList.add('is-open');
    dom.reader.querySelector('[data-action="toc"]')?.classList.add('is-active');
    const current = dom.outlineList.querySelector('.is-current');
    if (current) current.scrollIntoView({ block: 'nearest' });
  }

  function closeDrawer() {
    state.drawerOpen = false;
    dom.drawer.classList.remove('is-open');
    dom.reader.querySelector('[data-action="toc"]')?.classList.remove('is-active');
  }

  function toggleDrawer() {
    if (state.drawerOpen) closeDrawer();
    else openDrawer();
  }

  /* ---------------- 全屏 ---------------- */

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
    } else if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => toast('当前浏览器不支持全屏', 'warn'));
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

  /* ---------------- 自动翻页 ---------------- */

  function autoTurnSeconds() {
    const seconds = Math.round(Number(store.settings.autoTurnInterval) || 20);
    return Math.max(3, Math.min(120, seconds));
  }

  function autoTurnTick() {
    if (destroyed || !state.pdf) {
      stopAutoTurn();
      return;
    }
    if (document.hidden || isSettingsOpen()) return;
    if (state.page >= state.total) {
      updateSettings({ autoTurnEnabled: false });
      toast('已到最后一页，自动翻页已停止', 'warn');
      stopAutoTurn();
      return;
    }
    goToPage(state.page + 1);
  }

  function startAutoTurn() {
    if (state.autoTimer) {
      window.clearInterval(state.autoTimer);
      state.autoTimer = 0;
    }
    if (destroyed || !state.pdf || !store.settings.autoTurnEnabled) {
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

  /* ---------------- 设置变更 ---------------- */

  function onSettingsChanged(settings) {
    const previous = state.lastSettings || {};
    if (settings.theme !== previous.theme) updateNightFilter();
    if (settings.pdfZoom !== previous.pdfZoom) {
      renderPage(state.page);
    }
    if (settings.autoTurnEnabled !== previous.autoTurnEnabled || settings.autoTurnInterval !== previous.autoTurnInterval) {
      syncAutoTurn();
    }
    state.lastSettings = { ...settings };
  }

  /* ---------------- 事件 ---------------- */

  const onKeyDown = (event) => {
    if (destroyed || event.defaultPrevented) return;
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
      goToPage(state.page + 1);
    } else if (key === 'ArrowLeft' || key === 'PageUp') {
      event.preventDefault();
      goToPage(state.page - 1);
    } else if (key === 'Home') {
      event.preventDefault();
      goToPage(1);
    } else if (key === 'End') {
      event.preventDefault();
      goToPage(state.total);
    } else if (key === '+' || key === '=') {
      event.preventDefault();
      zoomBy(1);
    } else if (key === '-' || key === '_') {
      event.preventDefault();
      zoomBy(-1);
    } else if (key === '0') {
      event.preventDefault();
      applyZoomMode('fit');
    } else if (key === 't' || key === 'T') {
      event.preventDefault();
      toggleDrawer();
    } else if (key === 's' || key === 'S') {
      event.preventDefault();
      toggleSettings();
    } else if (key === 'f' || key === 'F') {
      event.preventDefault();
      toggleFullscreen();
    } else if (key === 'a' || key === 'A') {
      event.preventDefault();
      toggleAutoTurn();
    } else if (key === 'i' || key === 'I') {
      event.preventDefault();
      aiPanel.toggle();
    }
  };

  dom.reader.addEventListener('click', (event) => {
    const actionBtn = event.target.closest ? event.target.closest('[data-action]') : null;
    if (!actionBtn || !dom.reader.contains(actionBtn)) return;
    switch (actionBtn.dataset.action) {
      case 'back':
        backToShelf();
        break;
      case 'prev':
        goToPage(state.page - 1);
        break;
      case 'next':
        goToPage(state.page + 1);
        break;
      case 'zoom-in':
        zoomBy(1);
        break;
      case 'zoom-out':
        zoomBy(-1);
        break;
      case 'fit-width':
        applyZoomMode('fit');
        break;
      case 'actual-size':
        applyZoomMode('100');
        break;
      case 'night':
        state.nightOn = !state.nightOn;
        updateNightFilter();
        break;
      case 'autoturn':
        toggleAutoTurn();
        break;
      case 'ai':
        aiPanel.toggle();
        break;
      case 'toc':
        toggleDrawer();
        break;
      case 'settings':
        toggleSettings();
        break;
      case 'fullscreen':
        toggleFullscreen();
        break;
      case 'close-drawer':
        closeDrawer();
        break;
      case 'progress': {
        const rect = dom.progressTrack.getBoundingClientRect();
        const fraction = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
        goToPage(Math.round(fraction * (state.total - 1)) + 1);
        break;
      }
      default:
        break;
    }
  });

  dom.pageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const value = Number(dom.pageInput.value.replace(/[^\d]/g, ''));
      if (value) goToPage(value);
      else updatePageInput();
      dom.pageInput.blur();
    } else if (event.key === 'Escape') {
      updatePageInput();
      dom.pageInput.blur();
    }
  });
  dom.pageInput.addEventListener('blur', () => {
    const value = Number(dom.pageInput.value.replace(/[^\d]/g, ''));
    if (value && value !== state.page) goToPage(value);
    else updatePageInput();
  });

  dom.stage.addEventListener(
    'wheel',
    (event) => {
      if (event.ctrlKey) {
        event.preventDefault();
        if (event.deltaY < 0) zoomBy(1);
        else zoomBy(-1);
        return;
      }
      if (state.total <= 1) return;
      const scrollable = dom.stage.scrollHeight > dom.stage.clientHeight + 4;
      if (scrollable) return;
      const now = Date.now();
      if (now - state.wheelCooldown < 380) return;
      if (Math.abs(event.deltaY) < 8) return;
      state.wheelCooldown = now;
      if (event.deltaY > 0) goToPage(state.page + 1);
      else goToPage(state.page - 1);
    },
    { passive: false }
  );

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('fullscreenchange', updateFullscreenIcon);

  const onResize = debounce(() => {
    if (destroyed || !state.pdf) return;
    const zoom = store.settings.pdfZoom;
    if (zoom === 'fit' || zoom === 'page') renderPage(state.page);
  }, 200);
  window.addEventListener('resize', onResize);

  const unsubscribe = subscribe((event) => {
    if (event.type === 'settings') onSettingsChanged(event.settings);
  });

  cleanups.push(() => unsubscribe());
  cleanups.push(() => document.removeEventListener('keydown', onKeyDown));
  cleanups.push(() => document.removeEventListener('fullscreenchange', updateFullscreenIcon));
  cleanups.push(() => window.removeEventListener('resize', onResize));
  cleanups.push(() => {
    if (state.saveTimer) clearTimeout(state.saveTimer);
  });
  cleanups.push(() => {
    if (state.renderTask) {
      try {
        state.renderTask.cancel();
      } catch (_) {
        /* ignore */
      }
    }
  });
  cleanups.push(() => {
    if (state.pdf && state.pdf.destroy) {
      try {
        Promise.resolve(state.pdf.destroy()).catch(() => {});
      } catch (_) {
        /* ignore */
      }
    }
  });

  function backToShelf() {
    flushProgress();
    window.location.hash = '#/shelf';
  }

  function destroy() {
    if (destroyed) return;
    if (state.saveTimer) {
      clearTimeout(state.saveTimer);
      state.saveTimer = 0;
    }
    stopAutoTurn();
    flushProgress();
    destroyed = true;
    aiPanel.destroy();
    closeDrawer();
    cleanups.forEach((fn) => {
      try {
        fn();
      } catch (_) {
        /* ignore */
      }
    });
    cleanups.length = 0;
    document.body.dataset.ready = '0';
    delete document.body.dataset.route;
    delete document.body.dataset.reading;
    document.title = '墨阅 · 本地电子书阅读器';
    root.innerHTML = '';
  }

  boot(false);

  return { destroy };
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
