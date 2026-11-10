'use strict';

/**
 * 无封面书籍的自动封面（SVG）。
 * 依据 书名 / 作者 / 格式 / id 生成稳定的配色与排版，同一本书每次生成结果一致。
 */

const PALETTES = [
  { bg: ['#0f2740', '#06101c'], accent: '#d9b36c', ink: '#f7f1e3', soft: '#93a7bc' },
  { bg: ['#3a1d1a', '#150908'], accent: '#e0a96d', ink: '#fbf0df', soft: '#c29a7d' },
  { bg: ['#12352f', '#071713'], accent: '#cdb87d', ink: '#f2f0e6', soft: '#8fb0a4' },
  { bg: ['#2b2140', '#120d1c'], accent: '#c7b0e6', ink: '#f7f2ff', soft: '#a99cc4' },
  { bg: ['#4a3b1c', '#1d160a'], accent: '#f0d394', ink: '#fff8e8', soft: '#c9b184' },
  { bg: ['#17333b', '#081418'], accent: '#93cfc6', ink: '#eef8f6', soft: '#94b1ad' },
  { bg: ['#40202b', '#190b10'], accent: '#e6a3b1', ink: '#fdf0f3', soft: '#c79aa6' },
  { bg: ['#23303c', '#0d1218'], accent: '#b8c7d6', ink: '#f4f7fa', soft: '#8fa0b1' },
];

const FORMAT_LABELS = {
  EPUB: 'EPUB',
  PDF: 'PDF',
  MOBI: 'MOBI',
  AZW: 'AZW',
  AZW3: 'AZW3',
  PRC: 'PRC',
  DOC: 'DOC',
  DOCX: 'DOCX',
  RTF: 'RTF',
  ODT: 'ODT',
  TXT: 'TXT',
  MD: 'MARKDOWN',
  HTML: 'HTML',
  HTM: 'HTML',
  XHTML: 'HTML',
  FB2: 'FB2',
};

function escapeXml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function hashString(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function isWideChar(ch) {
  const code = ch.codePointAt(0);
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xff60)
  );
}

/** 按视觉宽度折行（中文按 1，拉丁字符按 0.56 估算），最多 maxLines 行。 */
function wrapTitle(raw, maxUnits, maxLines) {
  const text = String(raw || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return ['未命名'];
  const chars = Array.from(text);
  const lines = [];
  let current = '';
  let units = 0;
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    const width = isWideChar(ch) ? 1 : ch === ' ' ? 0.34 : 0.56;
    if (units + width > maxUnits && current.trim()) {
      lines.push(current.trim());
      current = '';
      units = 0;
      if (lines.length === maxLines) break;
      if (ch === ' ') continue;
    }
    current += ch;
    units += width;
  }
  if (lines.length < maxLines && current.trim()) lines.push(current.trim());
  if (!lines.length) lines.push('未命名');
  const consumed = lines.join('').replace(/\s/g, '').length;
  const total = text.replace(/\s/g, '').length;
  if (consumed < total) {
    lines[lines.length - 1] = lines[lines.length - 1].replace(/[，。,.!?！？；;：:]+$/, '') + '…';
  }
  return lines.slice(0, maxLines);
}

/**
 * @param {{id?:string,title?:string,author?:string,format?:string}} book
 * @returns {string} SVG 文本
 */
function renderCoverSvg(book) {
  const title = (book && book.title) || '未命名书籍';
  const author = (book && book.author) || '未知作者';
  const format = String((book && book.format) || 'BOOK').toUpperCase();
  const formatLabel = FORMAT_LABELS[format] || format || 'BOOK';
  const palette = PALETTES[hashString(`${book && book.id}|${title}|${format}`) % PALETTES.length];
  const variant = hashString(`${title}|author`) % 3;
  const lines = wrapTitle(title, 8.8, 4);
  const titleSize = lines.length >= 4 ? 42 : lines.length === 3 ? 47 : lines.length === 2 ? 54 : 58;
  const lineHeight = Math.round(titleSize * 1.32);
  const blockHeight = lines.length * lineHeight;
  const centerY = 402;
  const startY = centerY - blockHeight / 2 + titleSize * 0.36;
  const [bg1, bg2] = palette.bg;

  const titleSpans = lines
    .map((line, index) => {
      const y = Math.round(startY + index * lineHeight);
      return `<text x="300" y="${y}" text-anchor="middle" font-size="${titleSize}" font-weight="600" letter-spacing="1.5" fill="${palette.ink}">${escapeXml(line)}</text>`;
    })
    .join('\n    ');

  const motif =
    variant === 0
      ? `<circle cx="486" cy="690" r="238" fill="none" stroke="${palette.accent}" stroke-opacity=".16" stroke-width="1.4"/>
    <circle cx="486" cy="690" r="184" fill="none" stroke="${palette.accent}" stroke-opacity=".12" stroke-width="1"/>
    <circle cx="486" cy="690" r="130" fill="none" stroke="${palette.accent}" stroke-opacity=".09" stroke-width="1"/>`
      : variant === 1
        ? `<path d="M-40 690 L360 330 L760 690" fill="none" stroke="${palette.accent}" stroke-opacity=".13" stroke-width="1.6"/>
    <path d="M-40 748 L360 388 L760 748" fill="none" stroke="${palette.accent}" stroke-opacity=".09" stroke-width="1.2"/>
    <path d="M-40 806 L360 446 L760 806" fill="none" stroke="${palette.accent}" stroke-opacity=".06" stroke-width="1"/>`
        : `<rect x="78" y="150" width="444" height="600" rx="220" fill="none" stroke="${palette.accent}" stroke-opacity=".12" stroke-width="1.2"/>
    <rect x="112" y="190" width="376" height="520" rx="188" fill="none" stroke="${palette.accent}" stroke-opacity=".08" stroke-width="1"/>`;

  const dividerY = Math.round(startY + blockHeight + 54);
  const authorText = author.length > 22 ? `${author.slice(0, 22)}…` : author;
  const authorSize = authorText.length > 14 ? 21 : 27;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900" viewBox="0 0 600 900" role="img" aria-label="${escapeXml(title)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${bg1}"/>
      <stop offset="1" stop-color="${bg2}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.28" cy="0.12" r="0.95">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".10"/>
      <stop offset=".55" stop-color="#ffffff" stop-opacity=".02"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="600" height="900" fill="url(#bg)"/>
  <rect width="600" height="900" fill="url(#glow)"/>
  ${motif}
  <rect x="38" y="38" width="524" height="824" rx="3" fill="none" stroke="${palette.accent}" stroke-opacity=".42" stroke-width="1.6"/>
  <rect x="52" y="52" width="496" height="796" rx="2" fill="none" stroke="${palette.accent}" stroke-opacity=".14" stroke-width="1"/>
  <text x="300" y="104" text-anchor="middle" font-size="15" letter-spacing="6" fill="${palette.soft}" opacity=".85">MOYUE · 墨阅</text>
  <text x="300" y="176" text-anchor="middle" font-size="14" letter-spacing="4" fill="${palette.soft}" opacity=".55">本地藏书</text>
  <g font-family="&quot;Songti SC&quot;,&quot;Noto Serif SC&quot;,&quot;Source Han Serif SC&quot;,&quot;SimSun&quot;,serif">
    ${titleSpans}
  </g>
  <g stroke="${palette.accent}" stroke-opacity=".55">
    <line x1="196" y1="${dividerY}" x2="276" y2="${dividerY}" stroke-width="1"/>
    <line x1="324" y1="${dividerY}" x2="404" y2="${dividerY}" stroke-width="1"/>
  </g>
  <path d="M300 ${dividerY - 6} L306 ${dividerY} L300 ${dividerY + 6} L294 ${dividerY} Z" fill="${palette.accent}" fill-opacity=".75"/>
  <text x="300" y="${dividerY + 70}" text-anchor="middle" font-size="${authorSize}" letter-spacing="2" fill="${palette.ink}" opacity=".9">${escapeXml(authorText)}</text>
  <text x="300" y="${dividerY + 116}" text-anchor="middle" font-size="13" letter-spacing="3" fill="${palette.soft}" opacity=".6">${escapeXml(formatLabel)}</text>
  <text x="300" y="826" text-anchor="middle" font-size="12" letter-spacing="2.5" fill="${palette.soft}" opacity=".42">墨阅自动封面</text>
</svg>`;
}

module.exports = { renderCoverSvg };
