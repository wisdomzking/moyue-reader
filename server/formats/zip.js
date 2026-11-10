'use strict';
/**
 * formats/zip.js — 轻量 ZIP 随机读取器。
 *
 * 为什么不直接用 jszip：书架扫描要求单本 probe < 300ms，jszip.loadAsync 需要整文件读入并
 * 解析目录；这里直接读中央目录 + 按需解压单个条目，几 MB 的 EPUB/DOCX 也能毫秒级 probe。
 * 仅支持单卷、非 ZIP64（电子书/Office 文档的常态）；遇到 ZIP64 抛错，调用方退回 jszip。
 */

const fs = require('fs');
const zlib = require('zlib');

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function readAt(fd, offset, length) {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, offset);
  return n === length ? buf : buf.subarray(0, n);
}

function decodeEntryName(nameBuf, flags) {
  if (flags & 0x800) return nameBuf.toString('utf8');
  const asUtf8 = nameBuf.toString('utf8');
  if (!asUtf8.includes('\uFFFD')) return asUtf8; // 常见工具会写 UTF-8 但不打标记
  return nameBuf.toString('latin1');
}

/**
 * 读取 ZIP 中央目录。
 * @returns {Array<{name:string, method:number, compSize:number, uncompSize:number, localOffset:number, flags:number}>}
 */
function readZipEntries(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 22) throw new Error('不是有效的 ZIP 文件');
    const tailLen = Math.min(size, 65557 + 22);
    const tail = readAt(fd, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP 文件（找不到中央目录）');
    const total = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (total === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
      throw new Error('暂不支持 ZIP64');
    }
    const cd = readAt(fd, cdOffset, cdSize);
    const entries = [];
    let p = 0;
    let guard = 0;
    while (p + 46 <= cd.length && cd.readUInt32LE(p) === CEN_SIG && guard++ < 200000) {
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const uncompSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      const nameBuf = cd.subarray(p + 46, p + 46 + nameLen);
      entries.push({
        name: decodeEntryName(nameBuf, flags).replace(/\\/g, '/'),
        method,
        compSize,
        uncompSize,
        localOffset,
        flags,
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

function extractEntry(filePath, entry) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const loc = readAt(fd, entry.localOffset, 30);
    if (loc.length < 30 || loc.readUInt32LE(0) !== LOC_SIG) throw new Error('ZIP 本地文件头损坏');
    const nameLen = loc.readUInt16LE(26);
    const extraLen = loc.readUInt16LE(28);
    const dataOffset = entry.localOffset + 30 + nameLen + extraLen;
    const comp = readAt(fd, dataOffset, entry.compSize);
    if (entry.method === 0) return Buffer.from(comp);
    if (entry.method === 8) return zlib.inflateRawSync(comp);
    throw new Error('不支持的 ZIP 压缩方式: ' + entry.method);
  } finally {
    fs.closeSync(fd);
  }
}

/** 规范化 zip 内路径：去 ./、解码 %xx、统一 / */
function normalizeZipPath(p) {
  let s = String(p || '').replace(/\\/g, '/');
  try { s = decodeURIComponent(s); } catch (_) { /* 保留原样 */ }
  s = s.replace(/^\.\//, '');
  return s;
}

function findEntry(entries, wanted) {
  const target = normalizeZipPath(wanted).toLowerCase();
  // 先精确（忽略大小写），再忽略前导目录差异
  let hit = entries.find((e) => e.name.toLowerCase() === target);
  if (hit) return hit;
  hit = entries.find((e) => normalizeZipPath(e.name).toLowerCase() === target);
  if (hit) return hit;
  const byBase = entries.find((e) => e.name.toLowerCase().endsWith('/' + target));
  return byBase || null;
}

/** 读取指定条目的文本（UTF-8） */
function readEntryText(filePath, entry) {
  return extractEntry(filePath, entry).toString('utf8');
}

/**
 * 按路径列表批量取条目（不存在返回 null）。
 * @param {string} filePath
 * @param {string[]} wantedPaths
 * @returns {Object<string, Buffer|null>}
 */
function readEntries(filePath, wantedPaths) {
  const entries = readZipEntries(filePath);
  const out = {};
  for (const wanted of wantedPaths) {
    const entry = findEntry(entries, wanted);
    if (!entry) { out[wanted] = null; continue; }
    try { out[wanted] = extractEntry(filePath, entry); } catch (_) { out[wanted] = null; }
  }
  return out;
}

function isZipFile(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = readAt(fd, 0, 4);
      return buf.length === 4 && buf[0] === 0x50 && buf[1] === 0x4b &&
        ((buf[2] === 3 && buf[3] === 4) || (buf[2] === 5 && buf[3] === 6));
    } finally { fs.closeSync(fd); }
  } catch (_) {
    return false;
  }
}

module.exports = {
  readZipEntries, extractEntry, readEntryText, readEntries,
  findEntry, normalizeZipPath, isZipFile,
};
