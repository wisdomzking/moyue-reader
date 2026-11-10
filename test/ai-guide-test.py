#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Verify AI chapter guide: panel, generation, cached re-open, PDF page guide."""
import json
import os
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = 'http://127.0.0.1:7788'
EPUB = os.path.join(ROOT, 'test', 'books', 'sample.epub')
PDF = os.path.join(ROOT, 'test', 'books', 'sample.pdf')
SHOTS = os.path.join(ROOT, 'test', 'shots')


def api(path, method='GET', body=None):
    data = json.dumps(body).encode('utf-8') if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={'Content-Type': 'application/json'} if data else {})
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read()
        try:
            return json.loads(raw.decode('utf-8'))
        except Exception:
            return raw


def open_reader(page, book):
    page.goto(f'{BASE}/#/read/{book["id"]}' if book['format'] != 'PDF' else f'{BASE}/#/pdf/{book["id"]}',
              wait_until='domcontentloaded')
    page.wait_for_selector('[data-testid="reader"]', timeout=30000)
    page.wait_for_function('document.body.dataset.ready === "1"', timeout=120000)
    time.sleep(1.5)


def main():
    results = []

    def check(name, cond, detail=''):
        results.append((name, bool(cond)))
        print(('  PASS ' if cond else '  FAIL ') + name + (f' :: {detail}' if not cond and detail else ''))

    epub = api('/api/open', 'POST', {'path': EPUB})
    pdf = api('/api/open', 'POST', {'path': PDF})
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel='chrome', headless=True)
            page = browser.new_page(viewport={'width': 1440, 'height': 900})
            errors = []
            page_errors = []
            page.on('pageerror', lambda e: page_errors.append(str(e)))
            page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
            bad_resources = []
            page.on('response', lambda r: bad_resources.append((r.status, r.url)) if r.status >= 400 else None)

            # ---------- EPUB ----------
            open_reader(page, epub)
            # 封面/目录页文字太少，先翻到正文再测 AI 章节导读
            for _ in range(6):
                page.keyboard.press('ArrowRight')
                time.sleep(0.8)
            page.mouse.move(720, 20)
            time.sleep(0.6)
            page.keyboard.press('i')
            page.wait_for_selector('.ai-drawer.is-open', timeout=10000)
            time.sleep(1.0)
            subtitle = page.locator('[data-testid="ai-guide"] .ai-sub').inner_text()
            check('AI panel opens with chapter title', bool(subtitle) and '定位' not in subtitle, subtitle)
            page.screenshot(path=os.path.join(SHOTS, 'ai-empty.png'))

            # 打开面板后会自动为当前章节生成（无需再点按钮）
            page.wait_for_selector('[data-testid="ai-guide"] .ai-section', timeout=120000)
            time.sleep(0.8)
            body_text = page.locator('[data-testid="ai-guide"] .ai-body').inner_text()
            sections = page.locator('[data-testid="ai-guide"] .ai-section').count()
            check('EPUB guide sections rendered', sections >= 4, f'sections={sections}')
            check('guide has questions', '思考问题' in body_text)
            check('guide has structure', '结构化分析' in body_text)
            page.screenshot(path=os.path.join(SHOTS, 'ai-guide-epub.png'))

            # cached re-open
            t0 = time.time()
            open_reader(page, epub)
            page.keyboard.press('i')
            page.wait_for_selector('[data-testid="ai-guide"] .ai-section', timeout=8000)
            elapsed = time.time() - t0
            check('cached guide loads fast', elapsed < 6, f'{elapsed:.1f}s')
            sub_before = page.locator('[data-testid="ai-guide"] .ai-sub').inner_text()

            # 切到另一章，AI 面板应自动识别新的章节标题
            page.keyboard.press('t')
            page.wait_for_selector('[data-testid="toc"] .toc-item', timeout=10000)
            page.locator('[data-testid="toc"] .toc-item').nth(2).click()
            time.sleep(1.6)
            sub_after = page.locator('[data-testid="ai-guide"] .ai-sub').inner_text()
            check('chapter switch updates AI context', sub_after != sub_before, f'{sub_before} -> {sub_after}')
            page.keyboard.press('Escape')
            time.sleep(0.4)

            # ---------- PDF ----------
            open_reader(page, pdf)
            page.keyboard.press('i')
            page.wait_for_selector('.ai-drawer.is-open', timeout=10000)
            time.sleep(0.8)
            try:
                page.wait_for_selector('[data-testid="ai-guide"] .ai-section', timeout=120000)
                time.sleep(0.8)
                pdf_body = page.locator('[data-testid="ai-guide"] .ai-body').inner_text()
                check('PDF page guide rendered', '摘要' in pdf_body and len(pdf_body) > 80)
                page.screenshot(path=os.path.join(SHOTS, 'ai-guide-pdf.png'))
            except Exception as e:  # noqa: BLE001
                check('PDF page guide rendered', False, repr(e)[:200])

            real_errors = [e for e in errors if 'Failed to load resource' not in e]
            print('bad resources:', bad_resources[:10])
            check('no app console errors', not real_errors, '; '.join(real_errors[:5]))
            check('no page errors', not page_errors, '; '.join(page_errors[:5]))
            browser.close()
    finally:
        for book in (epub, pdf):
            try:
                api('/api/books/' + book['id'], 'DELETE')
            except Exception:
                pass

    passed = sum(1 for _, ok in results if ok)
    print(f'\nRESULT {passed}/{len(results)} passed')
    return 0 if passed == len(results) else 1


if __name__ == '__main__':
    sys.exit(main())
