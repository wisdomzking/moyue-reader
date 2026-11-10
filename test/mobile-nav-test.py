#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Mobile check: page-turn buttons visible and working at 390px."""
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


def main():
    original = api('/api/settings')['settings']
    book = api('/api/open', 'POST', {'path': EPUB})
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel='chrome', headless=True)
            page = browser.new_page(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
            page.goto(f'{BASE}/#/read/{book["id"]}', wait_until='domcontentloaded')
            page.wait_for_selector('[data-testid="reader"]', timeout=30000)
            page.wait_for_function('document.body.dataset.ready === "1"', timeout=120000)
            time.sleep(1.5)
            info = page.evaluate("""() => {
                const btn = document.querySelector('.reader-epub .page-nav-next');
                const cs = getComputedStyle(btn);
                const r = btn.getBoundingClientRect();
                return { display: cs.display, opacity: cs.opacity, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x) };
            }""")
            print('mobile page nav:', info)
            before = api(f'/api/books/{book["id"]}')['progress'].get('location', '')
            page.click('.reader-epub .page-nav-next')
            time.sleep(2.6)
            after = api(f'/api/books/{book["id"]}')['progress'].get('location', '')
            print('page turn:', before != after)
            page.screenshot(path=os.path.join(ROOT, 'test', 'shots', 'mobile-reader-nav.png'))
            browser.close()
            return 0 if info['display'] != 'none' and float(info['opacity']) > 0.3 and before != after else 1
    finally:
        api('/api/settings', 'PUT', original)
        api('/api/books/' + book['id'], 'DELETE')


if __name__ == '__main__':
    sys.exit(main())
