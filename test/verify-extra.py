#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Extra checks: ?open= path flow and folder browse modal."""
import json
import os
import time
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = 'http://127.0.0.1:7788'
SAMPLE = os.path.join(ROOT, 'test', 'books', 'sample.epub')


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='chrome', headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        page.goto(BASE + '/?open=' + urllib.parse.quote(SAMPLE), wait_until='domcontentloaded')
        page.wait_for_selector('[data-testid="reader"]', timeout=30000)
        page.wait_for_function('document.body.dataset.ready === "1"', timeout=120000)
        title = page.locator('#epubTitle').inner_text()
        print('open-by-path title:', title)
        print('PASS open-by-path' if 'Pride' in title else 'FAIL open-by-path')
        page.screenshot(path=os.path.join(ROOT, 'test', 'shots', 'open-by-path.png'))
        page.click('[data-action="back"]')
        page.wait_for_selector('[data-testid="shelf"]', timeout=20000)
        time.sleep(0.8)

        page.click('#btnAddFolder')
        page.wait_for_selector('[data-testid="browse"]', timeout=10000)
        time.sleep(0.9)
        text = page.locator('[data-testid="browse"]').inner_text()
        items = page.locator('[data-testid="browse"] button, [data-testid="browse"] [role="button"]').count()
        print('browse modal items:', items)
        print('browse has drives:', ('C:' in text or 'D:' in text))
        page.screenshot(path=os.path.join(ROOT, 'test', 'shots', 'browse-modal.png'))
        browser.close()


if __name__ == '__main__':
    main()
