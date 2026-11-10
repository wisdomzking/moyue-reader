#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""MoYue Web UI E2E acceptance test (Playwright + Chromium).

Requires browser permission (do not run inside the restricted sandbox).
Usage: python test/e2e.py [--port 7788] [--fresh] [--headed]
Produces screenshots under test/shots/ and prints PASS/FAIL summary.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEST_DIR = os.path.join(ROOT, 'test', 'books')
SHOTS = os.path.join(ROOT, 'test', 'shots')
BASE = ''
SERVER = None
PORT = 7788
STEP = ['init']


def api(path, method='GET', body=None):
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            raw = r.read()
            try:
                return r.status, json.loads(raw.decode('utf-8'))
            except Exception:
                return r.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw.decode('utf-8'))
        except Exception:
            return e.code, raw


def wait_server(timeout=40):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            code, js = api('/api/health')
            if code == 200 and js.get('ok'):
                return True
        except Exception:
            pass
        time.sleep(0.4)
    return False


def ensure_server(fresh):
    global BASE, SERVER
    BASE = f'http://127.0.0.1:{PORT}'
    if wait_server(3):
        print(f'[e2e] reuse running server {BASE}')
        return
    if fresh:
        for name in ('library.json', 'bookmarks.json'):
            p = os.path.join(ROOT, 'data', name)
            if os.path.exists(p):
                os.remove(p)
        shutil.rmtree(os.path.join(ROOT, 'data', 'covers'), ignore_errors=True)
        shutil.rmtree(os.path.join(ROOT, 'data', 'imported'), ignore_errors=True)
    os.makedirs(os.path.join(ROOT, '.cache'), exist_ok=True)
    log = open(os.path.join(ROOT, '.cache', 'e2e-server.log'), 'a', encoding='utf-8')
    SERVER = subprocess.Popen(
        ['node', os.path.join(ROOT, 'server', 'server.js'), '--port', str(PORT)],
        cwd=ROOT, stdout=log, stderr=subprocess.STDOUT,
    )
    if not wait_server(40):
        raise SystemExit('[e2e] server failed to start, see .cache/e2e-server.log')


def settle(sec=1.2):
    time.sleep(sec)


def wait_ready(page, timeout=90):
    page.wait_for_function('document.body.dataset.ready === "1"', timeout=timeout * 1000)


def open_book(page, book, timeout=150):
    page.wait_for_selector('[data-testid="shelf"]', timeout=15000)
    card = page.locator(f'[data-book-id="{book["id"]}"]').first
    card.wait_for(timeout=15000)
    card.click()
    page.wait_for_selector('[data-testid="reader"]', timeout=20000)
    try:
        page.wait_for_function('document.body.dataset.ready === "1"', timeout=timeout * 1000)
    except Exception:
        err = page.locator('[data-testid="reader-error"]')
        if err.count():
            raise AssertionError('reader error: ' + err.first.inner_text().replace('\n', ' ')[:200])
        raise
    settle()


def back(page):
    page.click('[data-action="back"]')
    page.wait_for_selector('[data-testid="shelf"]', timeout=20000)
    settle(0.5)


def shot(page, name):
    os.makedirs(SHOTS, exist_ok=True)
    path = os.path.join(SHOTS, name)
    page.screenshot(path=path)
    print('[e2e] shot', os.path.relpath(path, ROOT))


def launch_browser(p, headed):
    attempts = [{'channel': 'chrome'}, {'channel': 'msedge'}, {}]
    last = None
    for extra in attempts:
        try:
            return p.chromium.launch(headless=not headed, args=['--font-render-hinting=none'], **extra)
        except Exception as e:  # noqa: BLE001
            last = e
            print('[e2e] launch failed', extra, ':', str(e)[:100].replace('\n', ' '))
    raise last


def main():
    global PORT
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=7788)
    ap.add_argument('--fresh', action='store_true')
    ap.add_argument('--headed', action='store_true')
    args = ap.parse_args()
    PORT = args.port

    results = []
    failures = []

    def check(name, cond, detail=''):
        results.append((name, bool(cond)))
        print(('  PASS ' if cond else '  FAIL ') + name + (f' :: {detail}' if (detail and not cond) else ''))
        if not cond:
            failures.append(f'{name} :: {detail}')

    ensure_server(args.fresh)
    code, health = api('/api/health')
    check('health', code == 200 and health.get('ok'), str(code))

    code, st = api('/api/state')
    check('state', code == 200 and isinstance(st.get('books'), list), str(code))
    for f in st.get('folders', []):
        if os.path.normcase(os.path.abspath(f['path'])) == os.path.normcase(os.path.abspath(TEST_DIR)):
            api('/api/folders?path=' + urllib.parse.quote(f['path']), 'DELETE')
    code, added = api('/api/folders', 'POST', {'path': TEST_DIR})
    check('add test library', code == 200 and added.get('added', 0) >= 8, f'{code} added={added.get("added")}')
    code, st = api('/api/state')
    books = [b for b in st.get('books', []) if os.path.normcase(os.path.dirname(b['path'])) == os.path.normcase(TEST_DIR)]
    by_fmt = {}
    for b in books:
        by_fmt.setdefault(b['format'], b)
    print('[e2e] books:', ', '.join(f'{k}={v["title"]}' for k, v in by_fmt.items()))

    console_errors = []
    with sync_playwright() as p:
        browser = launch_browser(p, args.headed)
        page = browser.new_page(viewport={'width': 1440, 'height': 900}, device_scale_factor=1)
        page.on('console', lambda m: console_errors.append(f'[{STEP[0]}] [{m.type}] {m.text}') if m.type == 'error' else None)
        page.on('pageerror', lambda e: console_errors.append(f'[{STEP[0]}] [pageerror] {e} | {(e.stack or "")[:300]}'))

        STEP[0] = 'shelf'
        page.goto(BASE + '/#/shelf', wait_until='domcontentloaded', timeout=40000)
        page.wait_for_selector('[data-testid="shelf"]', timeout=40000)
        wait_ready(page, 60)
        settle(0.8)
        shot(page, 'shelf-light.png')
        cards = page.locator('[data-book-id]').count()
        check('shelf renders books', cards >= 8, f'cards={cards}')

        # search on shelf
        page.fill('[data-testid="search"]', 'Pride')
        settle(0.7)
        check('shelf search filters', page.locator('[data-book-id]').count() >= 1)
        page.fill('[data-testid="search"]', '')
        settle(0.5)

        # open every reflowable format
        opened = []
        for fmt in ['EPUB', 'MOBI', 'DOCX', 'DOC', 'TXT', 'HTML', 'FB2']:
            book = by_fmt.get(fmt)
            if not book:
                check(f'book {fmt}', False, 'missing sample')
                continue
            STEP[0] = f'open {fmt}'
            try:
                open_book(page, book)
                txt = page.inner_text('body') if page.locator('body').count() else ''
                check(f'open {fmt}', len(txt) > 10, f'text={len(txt)}')
                shot(page, f'read-{fmt.lower()}.png')

                if fmt == 'EPUB':
                    before = api(f'/api/books/{book["id"]}')[1].get('progress') or {}
                    page.keyboard.press('ArrowRight')
                    settle(0.9)
                    page.keyboard.press('ArrowRight')
                    settle(2.2)
                    after = api(f'/api/books/{book["id"]}')[1].get('progress') or {}
                    check('EPUB turn updates progress',
                          (after.get('location') or '') != (before.get('location') or '')
                          or (after.get('percent') or 0) > (before.get('percent') or 0),
                          f'{before} -> {after}')
                    label = page.locator('[data-testid="progress-label"]').inner_text() if page.locator('[data-testid="progress-label"]').count() else ''
                    check('EPUB progress label present', bool(label.strip()), repr(label))
                    if page.locator('[data-action="toc"]').count():
                        page.click('[data-action="toc"]')
                        settle(0.8)
                        toc_items = page.locator('[data-testid="toc"] a, [data-testid="toc"] button').count()
                        check('EPUB toc items', toc_items >= 3, f'items={toc_items}')
                        shot(page, 'reader-toc.png')
                        # in-book search
                        if page.locator('#epubSearchInput').count():
                            page.click('[data-action="search"]')
                            settle(0.6)
                            page.fill('#epubSearchInput', 'marriage')
                            page.keyboard.press('Enter')
                            settle(1.8)
                            hits = page.locator('#searchResults *').count()
                            check('EPUB search results', hits > 0, f'nodes={hits}')
                            shot(page, 'reader-search.png')
                        if page.locator('[data-action="close-drawer"]').count():
                            page.click('[data-action="close-drawer"]')
                        else:
                            page.keyboard.press('Escape')
                        settle(0.5)
                    # bookmark
                    if page.locator('[data-action="bookmark"]').count():
                        page.click('[data-action="bookmark"]')
                        settle(0.9)
                        bms = api(f'/api/books/{book["id"]}/bookmarks')[1].get('bookmarks') or []
                        check('EPUB bookmark saved', len(bms) >= 1, f'count={len(bms)}')

                    # font size change
                    size_before = page.evaluate('''() => { const f = document.querySelector('#epub-viewer iframe');
                        if (!f) return null; const d = f.contentDocument; return d && d.body ? getComputedStyle(d.body).fontSize : null; }''')
                    if page.locator('[data-action="settings"]').count():
                        page.click('[data-action="settings"]')
                        settle(0.6)
                        if page.locator('[data-action="font-inc"]').count():
                            page.click('[data-action="font-inc"]')
                            settle(0.9)
                        size_after = page.evaluate('''() => { const f = document.querySelector('#epub-viewer iframe');
                            if (!f) return null; const d = f.contentDocument; return d && d.body ? getComputedStyle(d.body).fontSize : null; }''')
                        check('EPUB font size applies', size_after and size_before and size_after != size_before, f'{size_before} -> {size_after}')
                        page.keyboard.press('Escape')
                        settle(0.4)
                opened.append(fmt)
                STEP[0] = f'back from {fmt}'
                back(page)
            except Exception as e:  # noqa: BLE001
                check(f'open {fmt}', False, repr(e)[:300])
                page.goto(BASE + '/#/shelf', wait_until='domcontentloaded')
                page.wait_for_selector('[data-testid="shelf"]', timeout=15000)

        # PDF
        pdf = by_fmt.get('PDF')
        if pdf:
            STEP[0] = 'open PDF'
            try:
                open_book(page, pdf)
                check('open PDF', True)
                shot(page, 'read-pdf.png')
                if page.locator('[data-action="next"]').count():
                    page.click('[data-action="next"]')
                    settle(1.2)
                page_no = page.locator('[data-testid="page-input"]').input_value() if page.locator('[data-testid="page-input"]').count() else '?'
                check('PDF next page', str(page_no).strip() not in ('1', ''), f'page={page_no}')
                shot(page, 'read-pdf-page2.png')
                if page.locator('[data-action="zoom-in"]').count():
                    page.click('[data-action="zoom-in"]')
                    settle(0.8)
                back(page)
            except Exception as e:  # noqa: BLE001
                check('open PDF', False, repr(e)[:300])
                page.goto(BASE + '/#/shelf', wait_until='domcontentloaded')

        # theme dark from shelf settings
        STEP[0] = 'dark theme'
        if page.locator('[data-action="settings"]').count():
            page.click('[data-action="settings"]')
            settle(0.6)
            if page.locator('[data-action="theme-dark"]').count():
                page.click('[data-action="theme-dark"]')
                settle(0.8)
                shot(page, 'shelf-dark.png')
                theme = page.evaluate('document.documentElement.dataset.theme')
                check('dark theme applied', theme == 'dark', str(theme))
            page.keyboard.press('Escape')
            settle(0.4)

        # EPUB dark reader
        STEP[0] = 'reader dark'
        if 'EPUB' in opened:
            try:
                open_book(page, by_fmt['EPUB'])
                shot(page, 'reader-dark.png')
                back(page)
            except Exception as e:  # noqa: BLE001
                print('[e2e] reader-dark failed:', e)

        # PDF in dark theme
        STEP[0] = 'PDF dark'
        if pdf:
            try:
                open_book(page, pdf)
                shot(page, 'read-pdf-dark.png')
                if page.locator('[data-action="night"]').count():
                    page.click('[data-action="night"]')
                    settle(0.9)
                    shot(page, 'read-pdf-night.png')
                back(page)
            except Exception as e:  # noqa: BLE001
                print('[e2e] pdf dark failed:', e)

        # mobile shelf + reader
        STEP[0] = 'mobile'
        mobile = browser.new_page(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
        mobile.goto(BASE + '/#/shelf', wait_until='domcontentloaded')
        mobile.wait_for_selector('[data-testid="shelf"]', timeout=30000)
        wait_ready(mobile, 30)
        settle(0.8)
        mobile.screenshot(path=os.path.join(SHOTS, 'mobile-shelf.png'))
        print('[e2e] shot mobile-shelf.png')
        if 'EPUB' in opened:
            mobile.locator(f'[data-book-id="{by_fmt["EPUB"]["id"]}"]').first.click()
            mobile.wait_for_selector('[data-testid="reader"]', timeout=30000)
            wait_ready(mobile, 120)
            settle()
            mobile.screenshot(path=os.path.join(SHOTS, 'mobile-reader.png'))
            print('[e2e] shot mobile-reader.png')
        mobile.close()

        browser.close()

    # progress persistence
    code, st = api('/api/state')
    epub = next((b for b in st.get('books', []) if b.get('id') == (by_fmt.get('EPUB') or {}).get('id')), None)
    if epub:
        pct = (epub.get('progress') or {}).get('percent', 0)
        check('EPUB progress saved', (pct or 0) > 0, json.dumps(epub.get('progress'), ensure_ascii=False))

    bad = [e for e in console_errors if 'Failed to load resource' not in e and 'net::ERR' not in e]
    check('no console errors', not bad, '; '.join(bad[:6]))

    print('\n=== E2E SUMMARY ===')
    passed = sum(1 for _, ok in results if ok)
    print(f'{passed}/{len(results)} checks passed')
    if failures:
        print('FAILURES:')
        for f in failures:
            print(' -', f)
    print('screenshots:', SHOTS)
    if SERVER:
        print('[e2e] server pid', SERVER.pid)
    return 0 if not failures else 1


if __name__ == '__main__':
    sys.exit(main())
