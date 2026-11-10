'use strict';

/**
 * EPUB 全文搜索（SPEC §5 的 /api/books/:id/search）。
 * 用 jszip 解压正文 XHTML，去标签后按关键词扫描；最多返回 50 条。
 */

const { openEpub, stripTags } = require('./epub-zip');

const MAX_RESULTS = 50;
const MAX_DOC_MATCHES = 3; // 同一章最多 3 条，避免结果过于集中
const MAX_DOC_BYTES = 4 * 1024 * 1024;
const MAX_DOCS = 400;

function makeExcerpt(text, index, keywordLength) {
  const pad = 60;
  let start = Math.max(0, index - pad);
  let end = Math.min(text.length, index + keywordLength + pad);
  // 尽量在标点/空白处截断
  if (start > 0) {
    const nextStop = text.slice(start, index).search(/[。！？.!?;；\n]/);
    if (nextStop > 0) start += nextStop + 1;
  }
  if (end < text.length) {
    const stop = text.slice(index + keywordLength, end).search(/[。！？.!?;；\n]/);
    if (stop > 0) end = index + keywordLength + stop + 1;
  }
  let out = text.slice(start, end).trim();
  if (start > 0) out = `…${out}`;
  if (end < text.length) out = `${out}…`;
  return out.slice(0, 220);
}

/**
 * 在 EPUB 中搜索关键词。
 * @param {string} filePath 可读 EPUB 绝对路径
 * @param {string} query 关键词（不区分大小写）
 * @returns {Promise<{results:Array<{href,label,excerpt}>, total:number}>}
 */
async function searchEpub(filePath, query) {
  const q = String(query == null ? '' : query).trim();
  if (!q) return { results: [], total: 0 };
  const needle = q.toLowerCase();
  const book = await openEpub(filePath);
  const results = [];
  const docs = book.spine.slice(0, MAX_DOCS);
  for (let i = 0; i < docs.length; i += 1) {
    if (results.length >= MAX_RESULTS) break;
    const doc = docs[i];
    let html = null;
    try {
      const entry = book.zip.file(doc.zipPath);
      if (!entry) continue;
      html = await entry.async('string');
    } catch (e) {
      continue;
    }
    if (!html || html.length > MAX_DOC_BYTES) continue;
    const text = stripTags(html);
    if (!text) continue;
    const hay = text.toLowerCase();
    let from = 0;
    let perDoc = 0;
    while (perDoc < MAX_DOC_MATCHES && results.length < MAX_RESULTS) {
      const idx = hay.indexOf(needle, from);
      if (idx < 0) break;
      const label = book.labels.get(doc.zipPath) || `第 ${i + 1} 章`;
      results.push({
        href: doc.href,
        label,
        excerpt: makeExcerpt(text, idx, q.length),
      });
      perDoc += 1;
      from = idx + needle.length;
    }
  }
  return { results, total: results.length };
}

module.exports = { searchEpub };
