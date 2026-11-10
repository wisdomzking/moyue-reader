#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Dark theme screenshot of the new settings (visual sanity)."""
import json
import os
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
        api('/api/settings', 'PUT', {**original, 'theme': 'dark'})
        with sync_playwright() as p:
            browser = p.chromium.launch(channel='chrome', headless=True)
            page = browser.new_page(viewport={'width': 1280, 'height': 900}, device_scale_factor=1)
            page.goto(f'{BASE}/#/read/{book["id"]}', wait_until='domcontentloaded')
            page.wait_for_selector('[data-testid="reader"]', timeout=30000)
            page.wait_for_function('document.body.dataset.ready === "1"', timeout=120000)
            time.sleep(1.5)
            page.click('.reader-epub [data-action="settings"]')
            page.wait_for_selector('#settingsDrawer.is-open', timeout=10000)
            time.sleep(0.8)
            page.evaluate("document.querySelector('#settingsBody').scrollTop = 260")
            time.sleep(0.4)
            page.screenshot(path=os.path.join(ROOT, 'test', 'shots', 'settings-dark.png'))
            browser.close()
    finally:
        api('/api/settings', 'PUT', original)
        api('/api/books/' + book['id'], 'DELETE')


if __name__ == '__main__':
    main()
