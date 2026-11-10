#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Check that page buttons scroll the page in scroll mode."""
import json
import os
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = 'http://127.0.0.1:7788'
EPUB = os.path.join(ROOT, 'test', 'books', 'sample.epub')


def api(path, method='GET', body=None):
    data = json.dumps(body).encode('utf-8') if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={'Content-Type': 'application/json'} if data else {})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode('utf-8'))


def scroll_state(page):
    return page.evaluate("""() => {
        const c = document.querySelector('#epub-viewer .epub-container');
        if (!c) return null;
        return { y: c.scrollTop, h: c.scrollHeight, ch: c.clientHeight };
    }""")


def main():
    original = api('/api/settings')['settings']
    book = api('/api/open', 'POST', {'path': EPUB})
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel='chrome', headless=True)
            page = browser.new_page(viewport={'width': 1440, 'height': 900})
            page.goto(f'{BASE}/#/read/{book["id"]}', wait_until='domcontentloaded')
            page.wait_for_selector('[data-testid="reader"]', timeout=30000)
            page.wait_for_function('document.body.dataset.ready === "1"', timeout=120000)
            time.sleep(1.5)
            page.click('.reader-epub [data-action="settings"]')
            page.wait_for_selector('#settingsDrawer.is-open', timeout=10000)
            page.click('[data-setting="pageMode"][data-value="scroll"]')
            time.sleep(1.2)
            page.keyboard.press('Escape')
            time.sleep(1.0)
            before = scroll_state(page)
            page.click('.reader-epub .page-nav-next')
            time.sleep(1.6)
            after = scroll_state(page)
            ok = before and after and after['y'] > before['y'] + 20
            print('scroll before:', before)
            print('scroll after :', after)
            print('PASS scroll page button' if ok else 'FAIL scroll page button')
            browser.close()
            return 0 if ok else 1
    finally:
        try:
            api('/api/settings', 'PUT', original)
        except Exception:
            pass
        try:
            api('/api/books/' + book['id'], 'DELETE')
        except Exception:
            pass


if __name__ == '__main__':
    sys.exit(main())
