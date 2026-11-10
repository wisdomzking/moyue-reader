#!/usr/bin/env node
/**
 * MoYue launcher.
 *
 * Starts the local server if needed (detached, logs to data/server.log),
 * waits until it is healthy, then opens the reader window.
 *
 * Usage:
 *   node scripts/launch.js                  # start server + open reader
 *   node scripts/launch.js --open "D:\a.epub"
 *   node scripts/launch.js --port 7788 --no-browser
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);

function argValue(name, fallback) {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return fallback;
}

const PORT = Number(argValue('--port', process.env.MOYUE_PORT || 7788)) || 7788;
const OPEN = argValue('--open', '');
const NO_BROWSER = args.includes('--no-browser');
const BASE = `http://127.0.0.1:${PORT}/`;

async function healthy(timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${BASE}api/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function tail(file, lines = 12) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
    return text.slice(-lines).join('\n');
  } catch (_) {
    return '';
  }
}

function startServer() {
  const dataDir = path.join(ROOT, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(ROOT, '.cache'), { recursive: true });
  const out = fs.openSync(path.join(dataDir, 'server.log'), 'a');
  const err = fs.openSync(path.join(dataDir, 'server.err.log'), 'a');
  const server = path.join(ROOT, 'server', 'server.js');
  if (!fs.existsSync(server)) {
    console.error('[墨阅] 找不到 server/server.js');
    process.exit(1);
  }
  const child = spawn(process.execPath, [server, '--port', String(PORT)], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, err],
  });
  child.unref();
  return child.pid;
}

function findBrowser() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) { /* ignore */ }
  }
  return null;
}

function openBrowser(url) {
  const browser = findBrowser();
  const useAppMode = process.env.MOYUE_NO_APP_MODE !== '1';
  if (browser) {
    const browserArgs = useAppMode ? [`--app=${url}`] : [url];
    const child = spawn(browser, browserArgs, { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return true;
  }
  // Fallback: hand the URL to the shell
  const child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return true;
}

async function main() {
  let url = BASE;
  if (OPEN && OPEN.trim()) {
    const abs = path.resolve(OPEN.trim());
    if (!fs.existsSync(abs)) {
      console.error(`[墨阅] 文件不存在：${abs}`);
      process.exit(1);
    }
    url = `${BASE}?open=${encodeURIComponent(abs)}`;
  }

  const already = await healthy(1200);
  if (!already) {
    if (!(await healthy(300))) {
      // not running -> start
      try {
        const pid = startServer();
        console.log(`[墨阅] 正在启动本地服务（pid ${pid}）…`);
      } catch (e) {
        console.error('[墨阅] 启动失败：', e && e.message ? e.message : e);
        process.exit(1);
      }
      if (!(await healthy(25000))) {
        console.error('[墨阅] 服务启动超时，日志如下：');
        console.error(tail(path.join(ROOT, 'data', 'server.err.log')) || tail(path.join(ROOT, 'data', 'server.log')));
        process.exit(1);
      }
    }
  }

  console.log(`[墨阅] 服务已就绪 → ${BASE}`);

  if (NO_BROWSER) {
    console.log(`[墨阅] 打开：${url}`);
    process.exit(0);
  }
  if (openBrowser(url)) {
    console.log(`[墨阅] 已打开：${url}`);
    process.exit(0);
  }
  console.log(`[墨阅] 请手动在浏览器打开：${url}`);
}

main().catch((e) => {
  console.error('[墨阅] 启动异常：', e);
  process.exit(1);
});
