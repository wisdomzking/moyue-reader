/**
 * AI 章节导读面板（EPUB / PDF 阅读器共用）
 *
 * - 章节/页面文本由阅读器通过 resolveContext() 提供
 * - 生成请求发往 DSH「墨阅」插件提供的本地 AI 代理（默认 http://127.0.0.1:7797）
 * - 结果按「书 + 章节」缓存在 localStorage，切回同一章秒开
 * - 可开启「切章自动生成」：仅在面板打开时自动为未缓存的章节生成
 */
import { icon } from './icons.js';
import { toast } from './ui.js';

const AI_ENDPOINT = String(window.MOYUE_AI_ENDPOINT || 'http://127.0.0.1:7797').replace(/\/+$/, '');
const AUTO_KEY = 'moyue.ai.auto';
const CACHE_PREFIX = 'moyue.ai.v1';
const REQUEST_TIMEOUT = 150000;
const CONTEXT_SETTLE_MS = 900;

let uidSeq = 0;

function hashKey(value) {
  const text = String(value || '');
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readAutoPreference() {
  try {
    return localStorage.getItem(AUTO_KEY) === '1';
  } catch (_) {
    return false;
  }
}

function writeAutoPreference(value) {
  try {
    localStorage.setItem(AUTO_KEY, value ? '1' : '0');
  } catch (_) {
    /* ignore */
  }
}

function formatDate(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  } catch (_) {
    return '';
  }
}

function listHtml(items, ordered) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return '';
  const tag = ordered ? 'ol' : 'ul';
  return `<${tag}>${list.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</${tag}>`;
}

function guideToText(guide, meta) {
  if (!guide) return '';
  const lines = [];
  lines.push(`【${guide.chapterTitle || '本章'}】`);
  if (guide.summary) lines.push(`摘要：${guide.summary}`);
  if (guide.guide) lines.push(`导读：${guide.guide}`);
  const s = guide.structure || {};
  if (s.thesis) lines.push(`核心论点：${s.thesis}`);
  if (s.keyPoints && s.keyPoints.length) {
    lines.push('关键要点：');
    s.keyPoints.forEach((item, i) => lines.push(`${i + 1}. ${item}`));
  }
  if (s.flow && s.flow.length) {
    lines.push('论证脉络：');
    s.flow.forEach((item, i) => lines.push(`${i + 1}. ${item}`));
  }
  if (s.concepts && s.concepts.length) {
    lines.push('概念解释：');
    s.concepts.forEach((item) => lines.push(`- ${item.term}：${item.explain}`));
  }
  if (guide.questions && guide.questions.length) {
    lines.push('思考问题：');
    guide.questions.forEach((item, i) => lines.push(`${i + 1}. ${item}`));
  }
  if (guide.keywords && guide.keywords.length) lines.push(`关键词：${guide.keywords.join('、')}`);
  if (meta && meta.model) lines.push(`\n（AI：${meta.model.provider || ''}/${meta.model.model || ''}）`);
  return lines.join('\n');
}

export function createAiPanel({ root, bookId, mode, resolveContext }) {
  if (!root) throw new Error('createAiPanel: root is required');
  uidSeq += 1;
  const uid = `ai-${uidSeq}`;
  const panel = document.createElement('aside');
  panel.className = 'ai-drawer';
  panel.setAttribute('data-testid', 'ai-guide');
  panel.setAttribute('aria-label', 'AI 章节导读');
  panel.setAttribute('aria-hidden', 'true');
  panel.innerHTML = `
    <header class="ai-head">
      <span class="ai-head-icon">${icon('sparkles', 18)}</span>
      <div class="ai-head-text">
        <div class="ai-title">AI 章节导读</div>
        <div class="ai-sub" data-ai="chapter">正在定位章节…</div>
      </div>
      <button class="btn btn-icon btn-ghost btn-xs" type="button" data-ai="close" aria-label="关闭 AI 导读">
        ${icon('close', 16)}
      </button>
    </header>
    <div class="ai-body" data-ai="body"></div>
    <footer class="ai-foot">
      <button class="btn btn-primary btn-sm" type="button" data-ai="generate">生成本章导读</button>
      <button class="btn btn-ghost btn-sm" type="button" data-ai="copy" hidden>复制</button>
      <label class="ai-auto" title="切换章节时自动生成尚未缓存的导读（仅面板打开时）">
        <input type="checkbox" data-ai="auto" ${readAutoPreference() ? 'checked' : ''} />
        <span>切章自动生成</span>
      </label>
    </footer>
  `;
  root.appendChild(panel);

  const refs = {
    chapter: panel.querySelector('[data-ai="chapter"]'),
    body: panel.querySelector('[data-ai="body"]'),
    generate: panel.querySelector('[data-ai="generate"]'),
    copy: panel.querySelector('[data-ai="copy"]'),
    auto: panel.querySelector('[data-ai="auto"]'),
  };

  const state = {
    open: false,
    destroyed: false,
    loading: false,
    auto: readAutoPreference(),
    context: null,
    currentKey: '',
    guide: null,
    meta: null,
    updateToken: 0,
    autoTimer: 0,
    requestController: null,
  };

  function setGenerateLabel(label, disabled) {
    refs.generate.textContent = label;
    refs.generate.disabled = Boolean(disabled);
  }

  function renderEmpty(message) {
    refs.body.innerHTML = `
      <div class="ai-empty">
        <span class="ai-empty-icon">${icon('sparkles', 28)}</span>
        <p class="ai-empty-title">让 AI 帮你快速吸收这一章</p>
        <p class="ai-empty-text">${escapeHtml(
          message || '自动识别当前章节，生成摘要、导读、结构化分析与思考问题。',
        )}</p>
        <p class="ai-disclaimer">内容由 AI 生成，可能存在偏差，请以原文为准；每次生成会消耗 DSH 模型额度。</p>
      </div>
    `;
    setGenerateLabel('生成本章导读', false);
    refs.copy.hidden = true;
  }

  function renderLoading() {
    refs.body.innerHTML = `
      <div class="ai-loading">
        <span class="spinner spinner-sm"></span>
        <p class="ai-loading-title">AI 正在阅读本章并整理要点…</p>
        <p class="ai-loading-text">首次生成通常需要 10–30 秒，请保持阅读器打开。</p>
      </div>
    `;
    setGenerateLabel('生成中…', true);
    refs.copy.hidden = true;
  }

  function renderError(message) {
    const offlineHint =
      `请确认 DSH 中的「墨阅」插件正在运行（本地 AI 代理 127.0.0.1:7797），` +
      `若刚重启过 DSH，请等待几秒后重试。`;
    refs.body.innerHTML = `
      <div class="ai-error">
        <span class="ai-error-icon">${icon('alert', 22)}</span>
        <p class="ai-error-title">导读生成失败</p>
        <p class="ai-error-text">${escapeHtml(message || '未知错误')}</p>
        <p class="ai-error-hint">${escapeHtml(offlineHint)}</p>
      </div>
    `;
    setGenerateLabel('重试', false);
    refs.copy.hidden = true;
  }

  function renderGuide(payload, options) {
    const guide = payload && payload.guide;
    if (!guide) return;
    const cached = Boolean(options && options.cached);
    const structure = guide.structure || {};
    const concepts = Array.isArray(structure.concepts) ? structure.concepts.filter((c) => c && c.term) : [];
    const keywords = Array.isArray(guide.keywords) ? guide.keywords.filter(Boolean) : [];
    const parts = [];
    parts.push(
      `<div class="ai-meta">${cached ? '已缓存' : '刚刚生成'}${payload.model && payload.model.model ? ` · ${escapeHtml(payload.model.model)}` : ''}${payload.createdAt ? ` · ${escapeHtml(formatDate(payload.createdAt))}` : ''}</div>`,
    );
    if (guide.summary) {
      parts.push(`<section class="ai-section"><h4>摘要</h4><p>${escapeHtml(guide.summary)}</p></section>`);
    }
    if (guide.guide) {
      parts.push(`<section class="ai-section"><h4>导读</h4><p>${escapeHtml(guide.guide)}</p></section>`);
    }
    if (structure.thesis || (structure.keyPoints || []).length || (structure.flow || []).length || concepts.length) {
      let html = '<section class="ai-section"><h4>结构化分析</h4>';
      if (structure.thesis) {
        html += `<p class="ai-thesis"><span>核心论点</span>${escapeHtml(structure.thesis)}</p>`;
      }
      if ((structure.keyPoints || []).length) {
        html += `<h5>关键要点</h5>${listHtml(structure.keyPoints, false)}`;
      }
      if ((structure.flow || []).length) {
        html += `<h5>论证脉络</h5>${listHtml(structure.flow, true)}`;
      }
      if (concepts.length) {
        html += '<h5>概念解释</h5><dl class="ai-concepts">';
        concepts.forEach((concept) => {
          html += `<dt>${escapeHtml(concept.term)}</dt><dd>${escapeHtml(concept.explain)}</dd>`;
        });
        html += '</dl>';
      }
      html += '</section>';
      parts.push(html);
    }
    if ((guide.questions || []).length) {
      parts.push(`<section class="ai-section"><h4>思考问题</h4>${listHtml(guide.questions, true)}</section>`);
    }
    if (keywords.length) {
      parts.push(
        `<section class="ai-section"><h4>关键词</h4><div class="ai-keywords">${keywords
          .map((word) => `<span>${escapeHtml(word)}</span>`)
          .join('')}</div></section>`,
      );
    }
    parts.push('<p class="ai-disclaimer">内容由 AI 生成，可能存在偏差，请以原文为准。</p>');
    refs.body.innerHTML = parts.join('');
    refs.body.scrollTop = 0;
    setGenerateLabel('重新生成', false);
    refs.copy.hidden = false;
    state.guide = guide;
    state.meta = payload;
  }

  function cacheKey(key) {
    return `${CACHE_PREFIX}.${bookId}.${hashKey(key)}`;
  }

  function readCache(key) {
    try {
      const raw = localStorage.getItem(cacheKey(key));
      if (!raw) return null;
      const payload = JSON.parse(raw);
      if (!payload || !payload.guide || !payload.guide.summary) return null;
      return payload;
    } catch (_) {
      return null;
    }
  }

  function writeCache(key, payload) {
    try {
      localStorage.setItem(cacheKey(key), JSON.stringify(payload));
    } catch (_) {
      /* 存储已满或隐私模式，忽略 */
    }
  }

  function scheduleAuto() {
    if (state.autoTimer) clearTimeout(state.autoTimer);
    state.autoTimer = window.setTimeout(() => {
      state.autoTimer = 0;
      if (!state.auto || !state.open || state.loading || state.destroyed) return;
      if (!state.context || readCache(state.context.key)) return;
      if (!state.context.text || state.context.text.trim().length < 80) return;
      void generate(false);
    }, CONTEXT_SETTLE_MS);
  }

  async function update() {
    const token = ++state.updateToken;
    let context = null;
    try {
      context = await resolveContext();
    } catch (_) {
      context = null;
    }
    if (state.destroyed || token !== state.updateToken) return;
    state.context = context && context.key ? context : null;
    if (!state.context) {
      refs.chapter.textContent = '无法识别当前章节';
      if (state.open) renderEmpty('暂时无法读取当前章节内容。');
      return;
    }
    refs.chapter.textContent = state.context.title || '当前章节';
    const cached = readCache(state.context.key);
    if (cached) {
      state.currentKey = state.context.key;
      renderGuide(cached, { cached: true });
      return;
    }
    if (state.currentKey !== state.context.key) {
      state.currentKey = state.context.key;
      state.guide = null;
      state.meta = null;
      if (state.open) renderEmpty();
    }
    if (state.open && state.auto && !state.loading && !state.guide) scheduleAuto();
  }

  async function generate(force) {
    if (state.loading || state.destroyed || !state.context) return;
    const context = state.context;
    if (!context.text || context.text.trim().length < 30) {
      renderError('当前页面文字太少（可能是封面、目录或图片页），请翻到正文后再生成。');
      return;
    }
    const key = context.key;
    if (!force) {
      const cached = readCache(key);
      if (cached) {
        renderGuide(cached, { cached: true });
        return;
      }
    }
    state.loading = true;
    renderLoading();
    let lastError = null;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const controller = new AbortController();
        state.requestController = controller;
        const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
        try {
          const response = await fetch(`${AI_ENDPOINT}/chapter-guide`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              bookTitle: context.bookTitle,
              chapterTitle: context.title,
              mode: mode || 'chapter',
              text: String(context.text).slice(0, 18000),
            }),
            signal: controller.signal,
          });
          const data = await response.json().catch(() => null);
          if (!response.ok || !data || data.ok !== true) {
            const message =
              (data && data.error && data.error.message) ||
              `AI 服务返回错误（HTTP ${response.status}）`;
            const retryable = response.status >= 500 || response.status === 429;
            if (retryable && attempt === 0) {
              lastError = new Error(message);
              await new Promise((resolve) => setTimeout(resolve, 1200));
              continue;
            }
            throw new Error(message);
          }
          if (state.destroyed || state.currentKey !== key) return;
          const payload = { guide: data.guide, model: data.model || null, createdAt: Date.now() };
          writeCache(key, payload);
          renderGuide(payload);
          return;
        } catch (err) {
          if (err && err.name === 'AbortError') {
            lastError = err;
            break;
          }
          // 本地代理暂时不可达时重试一次
          if (attempt === 0 && err instanceof TypeError) {
            lastError = err;
            await new Promise((resolve) => setTimeout(resolve, 1500));
            continue;
          }
          lastError = err;
          break;
        } finally {
          window.clearTimeout(timer);
          if (state.requestController === controller) state.requestController = null;
        }
      }
      if (state.destroyed) return;
      const err = lastError;
      if (err && err.name === 'AbortError') {
        renderError('生成超时（150 秒），请稍后重试。');
      } else if (err instanceof TypeError) {
        renderError('无法连接本地 AI 服务，请确认 DSH 中的墨阅插件已启用。');
      } else {
        renderError((err && err.message) || 'AI 生成失败');
      }
    } finally {
      state.loading = false;
    }
  }

  function openPanel() {
    if (state.open || state.destroyed) return;
    state.open = true;
    panel.classList.add('is-open');
    panel.setAttribute('aria-hidden', 'false');
    if (state.guide) {
      setGenerateLabel('重新生成', false);
      refs.copy.hidden = false;
    } else if (state.context) {
      if (readCache(state.context.key)) {
        void update();
      } else {
        renderEmpty();
        void update().then(() => {
          if (
            state.open &&
            !state.guide &&
            state.context &&
            state.context.text &&
            state.context.text.trim().length >= 80
          ) {
            void generate(false);
          }
        });
      }
    } else {
      renderEmpty();
      void update().then(() => {
        if (state.open && state.context && !state.guide) void generate(false);
      });
    }
    if (state.context && state.auto && !readCache(state.context.key) && !state.loading) scheduleAuto();
  }

  function closePanel() {
    if (!state.open) return;
    state.open = false;
    panel.classList.remove('is-open');
    panel.setAttribute('aria-hidden', 'true');
    if (state.autoTimer) {
      clearTimeout(state.autoTimer);
      state.autoTimer = 0;
    }
  }

  function toggle() {
    if (state.open) closePanel();
    else openPanel();
  }

  function destroy() {
    if (state.destroyed) return;
    state.destroyed = true;
    state.open = false;
    if (state.autoTimer) clearTimeout(state.autoTimer);
    if (state.requestController) {
      try {
        state.requestController.abort();
      } catch (_) {
        /* ignore */
      }
    }
    panel.remove();
  }

  panel.addEventListener('click', (event) => {
    const target = event.target.closest ? event.target.closest('[data-ai]') : null;
    if (!target || !panel.contains(target)) return;
    const action = target.getAttribute('data-ai');
    if (action === 'close') closePanel();
    else if (action === 'generate') void generate(Boolean(state.guide));
    else if (action === 'copy') {
      const text = guideToText(state.guide, state.meta);
      if (!text) return;
      const done = () => toast('导读已复制', 'success');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(() => toast('复制失败', 'error'));
      } else {
        toast('当前浏览器不支持剪贴板', 'warn');
      }
    }
  });

  refs.auto.addEventListener('change', () => {
    state.auto = refs.auto.checked;
    writeAutoPreference(state.auto);
    if (state.auto) {
      if (state.open && state.context && !state.loading && !state.guide && !readCache(state.context.key)) {
        scheduleAuto();
      }
    } else if (state.autoTimer) {
      clearTimeout(state.autoTimer);
      state.autoTimer = 0;
    }
  });

  renderEmpty();
  setGenerateLabel('生成本章导读', false);

  return {
    update,
    toggle,
    open: openPanel,
    close: closePanel,
    isOpen: () => state.open,
    generate,
    destroy,
    id: uid,
  };
}
