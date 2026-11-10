/**
 * 墨阅 API 客户端（同源，无构建）
 * 契约见 SPEC.md §5。所有错误统一抛 ApiError，message 为中文可直接展示的文案。
 */

export class ApiError extends Error {
  constructor(message, code = 'error', status = 0) {
    super(message || '请求失败');
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

async function readError(res) {
  let message = `请求失败（${res.status}）`;
  let code = 'http_' + res.status;
  try {
    const body = await res.json();
    if (body && body.error && body.error.message) {
      message = body.error.message;
      code = body.error.code || code;
    }
  } catch (_) {
    /* 非 JSON 错误响应，保留默认文案 */
  }
  return new ApiError(message, code, res.status);
}

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(path, options);
  } catch (err) {
    throw new ApiError('无法连接本地服务，请确认墨阅已启动（双击「启动墨阅.cmd」）', 'network', 0);
  }
  if (!res.ok) throw await readError(res);
  const type = res.headers.get('content-type') || '';
  if (type.indexOf('json') === -1) return res;
  try {
    return await res.json();
  } catch (err) {
    throw new ApiError('服务返回了无法解析的数据', 'bad_json', res.status);
  }
}

function jsonBody(method, data) {
  return {
    method,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(data || {}),
  };
}

export const api = {
  health() {
    return request('/api/health');
  },

  state() {
    return request('/api/state');
  },

  scan() {
    return request('/api/scan', { method: 'POST' });
  },

  addFolder(path) {
    return request('/api/folders', jsonBody('POST', { path }));
  },

  removeFolder(path) {
    return request('/api/folders?path=' + encodeURIComponent(path), { method: 'DELETE' });
  },

  collections() {
    return request('/api/collections');
  },

  createCollection(name) {
    return request('/api/collections', jsonBody('POST', { name }));
  },

  renameCollection(id, name) {
    return request('/api/collections/' + encodeURIComponent(id), jsonBody('PATCH', { name }));
  },

  deleteCollection(id) {
    return request('/api/collections/' + encodeURIComponent(id), { method: 'DELETE' });
  },

  autoClassify(mode) {
    return request('/api/collections/auto', jsonBody('POST', { mode }));
  },

  applyAiClassify(groups) {
    return request('/api/collections/apply-ai', jsonBody('POST', { groups }));
  },

  moveBooks(bookIds, collectionId) {
    return request('/api/books/move', jsonBody('POST', { bookIds, collectionId }));
  },

  openBook(path) {
    return request('/api/open', jsonBody('POST', { path }));
  },

  /** 拖拽/选择文件导入：body = 原始字节，文件名走 query（SPEC §5） */
  importFile(file) {
    const name = file && file.name ? file.name : '未命名.epub';
    return request('/api/import?name=' + encodeURIComponent(name), {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
  },

  book(id) {
    return request('/api/books/' + encodeURIComponent(id));
  },

  removeBook(id) {
    return request('/api/books/' + encodeURIComponent(id), { method: 'DELETE' });
  },

  prepare(id) {
    return request('/api/books/' + encodeURIComponent(id) + '/prepare', { method: 'POST' });
  },

  contentUrl(id) {
    return '/api/books/' + encodeURIComponent(id) + '/content';
  },

  saveProgress(id, progress) {
    return request('/api/books/' + encodeURIComponent(id) + '/progress', jsonBody('PUT', progress));
  },

  bookmarks(id) {
    return request('/api/books/' + encodeURIComponent(id) + '/bookmarks');
  },

  addBookmark(id, bookmark) {
    return request('/api/books/' + encodeURIComponent(id) + '/bookmarks', jsonBody('POST', bookmark));
  },

  removeBookmark(id, bookmarkId) {
    return request(
      '/api/books/' + encodeURIComponent(id) + '/bookmarks/' + encodeURIComponent(bookmarkId),
      { method: 'DELETE' }
    );
  },

  search(id, q) {
    return request('/api/books/' + encodeURIComponent(id) + '/search?q=' + encodeURIComponent(q));
  },

  getSettings() {
    return request('/api/settings');
  },

  putSettings(settings) {
    return request('/api/settings', jsonBody('PUT', settings));
  },

  browse(path) {
    const q = path ? '?path=' + encodeURIComponent(path) : '';
    return request('/api/browse' + q);
  },

  reveal(path) {
    return request('/api/reveal', jsonBody('POST', { path }));
  },
};
