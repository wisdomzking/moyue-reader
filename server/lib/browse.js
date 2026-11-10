'use strict';

/**
 * 目录浏览（SPEC §5 /api/browse）：
 *  - path 为空或 "/"：返回盘符列表（A..Z）+ 常用目录
 *  - 其它：只列一层目录与文件，不递归
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { extOf, formatOfExt, normalizeInputPath, HttpError } = require('./util');
const adapter = require('./formats-adapter');

const MAX_DIRS = 500;
const MAX_FILES = 1000;

const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

function sortByName(a, b) {
  return collator.compare(a.name, b.name);
}

function driveList() {
  const drives = [];
  for (let i = 0; i < 26; i += 1) {
    const letter = String.fromCharCode(65 + i);
    const root = `${letter}:\\`;
    let ok = false;
    try {
      ok = fs.existsSync(root);
    } catch (e) {
      ok = false;
    }
    if (!ok) continue;
    const drive = { name: `${letter}:`, path: root };
    try {
      const st = fs.statfsSync(root);
      const free = Number(st.bavail) * Number(st.bsize);
      if (Number.isFinite(free)) drive.free = free;
    } catch (e) {
      /* 部分盘符不支持 statfs，忽略 */
    }
    drives.push(drive);
  }
  return drives;
}

function quickDirs() {
  const home = os.homedir();
  const candidates = [
    { name: '桌面', paths: [path.join(home, 'Desktop'), path.join(home, 'OneDrive', 'Desktop'), path.join(home, 'OneDrive', '桌面')] },
    { name: '文档', paths: [path.join(home, 'Documents'), path.join(home, 'OneDrive', 'Documents'), path.join(home, 'OneDrive', '文档')] },
    { name: '下载', paths: [path.join(home, 'Downloads'), path.join(home, 'OneDrive', 'Downloads'), path.join(home, 'OneDrive', '下载')] },
  ];
  const out = [];
  for (const c of candidates) {
    const hit = c.paths.find((p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch (e) {
        return false;
      }
    });
    if (hit) out.push({ name: c.name, path: hit });
  }
  return out;
}

function parentOf(dir) {
  const resolved = path.resolve(dir);
  const parsed = path.parse(resolved);
  if (resolved.toLowerCase() === parsed.root.toLowerCase()) return ''; // 盘符根 → 回到盘符列表
  return path.dirname(resolved);
}

function isDriveRoot(dir) {
  const resolved = path.resolve(dir);
  return resolved.toLowerCase() === path.parse(resolved).root.toLowerCase();
}

/**
 * @param {string} rawPath 请求参数 path（可空）
 */
function browse(rawPath) {
  const input = String(rawPath == null ? '' : rawPath).trim();
  if (!input || input === '/' || input === '\\') {
    return {
      path: '',
      parent: null,
      isDriveList: true,
      drives: driveList(),
      quick: quickDirs(),
      dirs: [],
      files: [],
    };
  }
  let dir;
  try {
    dir = normalizeInputPath(input);
  } catch (e) {
    throw new HttpError(400, 'browse_failed', '路径无效');
  }
  let st;
  try {
    st = fs.statSync(dir);
  } catch (e) {
    throw new HttpError(404, 'browse_failed', '无法访问该目录：' + (e.code || e.message));
  }
  if (!st.isDirectory()) {
    throw new HttpError(400, 'browse_failed', '该路径不是文件夹');
  }
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    throw new HttpError(400, 'browse_failed', '无法读取目录：' + (e.code || e.message));
  }

  const dirs = [];
  const files = [];
  for (const ent of entries) {
    const name = ent.name;
    if (!name || name[0] === '.') continue;
    const abs = path.join(dir, name);
    if (ent.isDirectory()) {
      dirs.push({ name, path: abs });
      continue;
    }
    if (!ent.isFile()) continue;
    const ext = extOf(name);
    let size = 0;
    try {
      size = fs.statSync(abs).size;
    } catch (e) {
      /* ignore */
    }
    files.push({
      name,
      path: abs,
      size,
      ext,
      format: formatOfExt(ext),
      isBook: adapter.isSupported(name),
    });
  }
  dirs.sort(sortByName);
  files.sort(sortByName);
  return {
    path: dir,
    parent: parentOf(dir),
    isDriveList: false,
    drives: [],
    quick: [],
    dirs: dirs.slice(0, MAX_DIRS),
    files: files.slice(0, MAX_FILES),
  };
}

module.exports = { browse, driveList, quickDirs, isDriveRoot };
