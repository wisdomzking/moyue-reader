/**
 * 设置抽屉：主题 / 字号 / 字体 / 行距 / 翻页方式 / 版式 / 版心 / PDF 缩放
 * 即时生效 + 自动保存（服务端 PUT /api/settings，localStorage 兜底）
 */
import { store, updateSettings, subscribe } from './store.js';
import { clamp } from './ui.js';

const FONT_STACKS = {
  serif: 'var(--font-serif)',
  sans: 'var(--font-ui)',
  kai: 'var(--font-kai)',
  system: 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
};

const PDF_ZOOM_LABELS = { fit: '适应宽度', page: '适应页面' };
const PDF_ZOOM_OPTIONS = ['75', '100', '125', '150', '200'];

let drawer = null;
let backdrop = null;
let isOpen = false;

export function initSettings() {
  drawer = document.getElementById('settingsDrawer');
  backdrop = document.getElementById('settingsBackdrop');
  if (!drawer || !backdrop) return;

  const closeBtn = document.getElementById('settingsClose');
  closeBtn?.addEventListener('click', closeSettings);
  backdrop.addEventListener('click', closeSettings);

  // 主题 / 分段选择
  drawer.querySelectorAll('[data-setting]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.setting;
      const value = btn.dataset.value;
      if (!key || value === undefined) return;
      if (key === 'fontSize') return;
      updateSettings({ [key]: value });
    });
  });

  // 字号 / 行距 / 字间距 / 段间距 / 版心
  const fontRange = document.getElementById('fontSizeRange');
  fontRange?.addEventListener('input', () => {
    updateSettings({ fontSize: clamp(Number(fontRange.value), 12, 40) });
  });

  const lineRange = document.getElementById('lineHeightRange');
  lineRange?.addEventListener('input', () => {
    updateSettings({ lineHeight: Math.round(clamp(Number(lineRange.value), 1.2, 3) * 10) / 10 });
  });

  const letterRange = document.getElementById('letterSpacingRange');
  letterRange?.addEventListener('input', () => {
    updateSettings({ letterSpacing: Math.round(clamp(Number(letterRange.value), 0, 0.3) * 100) / 100 });
  });

  const paraRange = document.getElementById('paragraphSpacingRange');
  paraRange?.addEventListener('input', () => {
    updateSettings({ paragraphSpacing: Math.round(clamp(Number(paraRange.value), 0, 1.5) * 100) / 100 });
  });

  const widthRange = document.getElementById('maxWidthRange');
  widthRange?.addEventListener('input', () => {
    updateSettings({ maxWidth: Math.round(clamp(Number(widthRange.value), 560, 1200) / 10) * 10 });
  });

  // 自动翻页
  const autoToggle = document.getElementById('autoTurnToggle');
  autoToggle?.addEventListener('click', () => {
    updateSettings({ autoTurnEnabled: !store.settings.autoTurnEnabled });
  });

  const autoInterval = document.getElementById('autoTurnIntervalRange');
  autoInterval?.addEventListener('input', () => {
    updateSettings({ autoTurnInterval: Math.round(clamp(Number(autoInterval.value), 3, 120)) });
  });

  // 字号快捷按钮
  drawer.querySelectorAll('[data-action="font-inc"], [data-action="font-dec"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const delta = btn.dataset.action === 'font-inc' ? 1 : -1;
      updateSettings({ fontSize: clamp(store.settings.fontSize + delta, 12, 40) });
    });
  });

  // PDF 固定比例
  const zoomSelect = document.getElementById('pdfZoomSelect');
  zoomSelect?.addEventListener('change', () => {
    const value = zoomSelect.value;
    if (value) updateSettings({ pdfZoom: value });
    else if (!['fit', 'page'].includes(store.settings.pdfZoom)) updateSettings({ pdfZoom: 'fit' });
    syncUI();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) {
      e.preventDefault();
      e.stopPropagation();
      closeSettings();
    }
  });

  subscribe((event) => {
    if (event.type === 'settings' || event.type === 'state') syncUI();
  });

  syncUI();
}

export function syncUI() {
  if (!drawer) return;
  const s = store.settings;

  // 主题
  drawer.querySelectorAll('[data-setting="theme"]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.value === s.theme);
  });

  // 分段（字体 / 翻页 / 版式 / PDF）
  drawer.querySelectorAll('.seg-btn[data-setting]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.value === s[btn.dataset.setting]);
  });

  // 范围控件
  const fontRange = document.getElementById('fontSizeRange');
  if (fontRange && document.activeElement !== fontRange) fontRange.value = String(s.fontSize);
  const fontValue = document.getElementById('fontSizeValue');
  if (fontValue) fontValue.textContent = `${s.fontSize} px`;

  const lineRange = document.getElementById('lineHeightRange');
  if (lineRange && document.activeElement !== lineRange) lineRange.value = String(s.lineHeight);
  const lineValue = document.getElementById('lineHeightValue');
  if (lineValue) lineValue.textContent = s.lineHeight.toFixed(1);

  const letterRange = document.getElementById('letterSpacingRange');
  if (letterRange && document.activeElement !== letterRange) letterRange.value = String(s.letterSpacing);
  const letterValue = document.getElementById('letterSpacingValue');
  if (letterValue) letterValue.textContent = s.letterSpacing ? `${s.letterSpacing.toFixed(2)} em` : '0 em';

  const paraRange = document.getElementById('paragraphSpacingRange');
  if (paraRange && document.activeElement !== paraRange) paraRange.value = String(s.paragraphSpacing);
  const paraValue = document.getElementById('paragraphSpacingValue');
  if (paraValue) paraValue.textContent = s.paragraphSpacing ? `${s.paragraphSpacing.toFixed(2)} em` : '0 em';

  // 自动翻页
  const autoToggle = document.getElementById('autoTurnToggle');
  if (autoToggle) autoToggle.setAttribute('aria-pressed', s.autoTurnEnabled ? 'true' : 'false');
  const autoState = document.getElementById('autoTurnState');
  if (autoState) autoState.textContent = s.autoTurnEnabled ? '已开启' : '已关闭';
  const autoInterval = document.getElementById('autoTurnIntervalRange');
  if (autoInterval && document.activeElement !== autoInterval) autoInterval.value = String(s.autoTurnInterval);
  const autoIntervalValue = document.getElementById('autoTurnIntervalValue');
  if (autoIntervalValue) autoIntervalValue.textContent = `${s.autoTurnInterval} 秒`;

  const widthRange = document.getElementById('maxWidthRange');
  if (widthRange && document.activeElement !== widthRange) widthRange.value = String(s.maxWidth);
  const widthValue = document.getElementById('maxWidthValue');
  if (widthValue) widthValue.textContent = `${s.maxWidth} px`;

  // PDF 缩放
  const zoomLabel = document.getElementById('pdfZoomValue');
  if (zoomLabel) {
    zoomLabel.textContent = PDF_ZOOM_LABELS[s.pdfZoom] || `${s.pdfZoom}%`;
  }
  const zoomSelect = document.getElementById('pdfZoomSelect');
  if (zoomSelect) {
    const numeric = PDF_ZOOM_OPTIONS.includes(String(s.pdfZoom));
    zoomSelect.value = numeric ? String(s.pdfZoom) : '';
  }

  // 预览
  const preview = document.getElementById('previewLine');
  if (preview) {
    preview.style.fontFamily = FONT_STACKS[s.fontFamily] || FONT_STACKS.serif;
    preview.style.fontSize = `${s.fontSize}px`;
    preview.style.lineHeight = String(s.lineHeight);
    preview.style.letterSpacing = s.letterSpacing ? `${s.letterSpacing}em` : '';
  }
}

export function openSettings() {
  if (!drawer || isOpen) return;
  isOpen = true;
  syncUI();
  drawer.classList.add('is-open');
  drawer.setAttribute('aria-hidden', 'false');
  backdrop.hidden = false;
  requestAnimationFrame(() => backdrop.classList.add('is-open'));
  document.body.classList.add('is-scroll-locked');
  document.getElementById('settingsClose')?.focus({ preventScroll: true });
}

export function closeSettings() {
  if (!drawer || !isOpen) return;
  isOpen = false;
  drawer.classList.remove('is-open');
  drawer.setAttribute('aria-hidden', 'true');
  backdrop.classList.remove('is-open');
  setTimeout(() => {
    if (!isOpen) backdrop.hidden = true;
  }, 230);
  document.body.classList.remove('is-scroll-locked');
}

export function toggleSettings() {
  if (isOpen) closeSettings();
  else openSettings();
}

export function isSettingsOpen() {
  return isOpen;
}
