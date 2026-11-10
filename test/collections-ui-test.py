#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Shelf covers + folders + auto-classify browser test."""
import json
import os
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = 'http://127.0.0.1:7788'
SHOTS = os.path.join(ROOT, 'test', 'shots')


def api(path, method='GET', body=None):
    data = json.dumps(body).encode('utf-8') if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={'Content-Type': 'application/json'} if data else {})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode('utf-8'))


def cleanup():
    try:
        state = api('/api/state')
        for book in state.get('books', []):
            if book.get('collectionId'):
                api('/api/books/move', 'POST', {'bookIds': [book['id']], 'collectionId': None})
        for collection in state.get('collections', []):
            api('/api/collections/' + collection['id'], 'DELETE')
    except Exception as exc:  # noqa: BLE001
        print('cleanup warning:', exc)


def main():
    results = []

    def check(name, cond, detail=''):
        results.append((name, bool(cond)))
        print(('  PASS ' if cond else '  FAIL ') + name + (f' :: {detail}' if not cond and detail else ''))

    cleanup()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel='chrome', headless=True)
            page = browser.new_page(viewport={'width': 1440, 'height': 960})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)

            page.goto(BASE + '/', wait_until='domcontentloaded')
            page.wait_for_selector('[data-testid="shelf"]', timeout=30000)
            page.wait_for_function('document.querySelectorAll(".book-card").length > 0', timeout=30000)
            time.sleep(1.5)

            cover = page.evaluate("""() => {
                const img = document.querySelector('.book-card .cover-img');
                return img ? { ok: img.complete && img.naturalWidth > 0, src: img.getAttribute('src') } : null;
            }""")
            check('book cover renders', bool(cover and cover['ok']), str(cover))
            check('cover is generated svg', bool(cover and '/cover' in cover['src']), str(cover))
            page.screenshot(path=os.path.join(SHOTS, 'shelf-covers.png'))

            # 新建文件夹
            page.click('#btnNewCollection')
            page.wait_for_selector('#collectionDialogBackdrop.is-open', timeout=5000)
            page.fill('#collectionNameInput', '测试文件夹')
            page.click('#collectionDialogSubmit')
            page.wait_for_selector('.collection-chip:has-text("测试文件夹")', timeout=15000)
            time.sleep(0.8)
            check('create folder from UI', page.locator('.collection-chip', has_text='测试文件夹').count() >= 1)
            page.screenshot(path=os.path.join(SHOTS, 'shelf-collections.png'))

            # 全部视图，右键把书移动到文件夹
            page.locator('.collection-chip', has_text='全部').first.click()
            time.sleep(0.5)
            page.locator('.book-card').first.click(button='right')
            page.wait_for_selector('#ctxMenu .ctx-item', timeout=5000)
            page.locator('#ctxMenu .ctx-item', has_text='移动到文件夹').click()
            page.wait_for_selector('#moveDialogBackdrop.is-open', timeout=5000)
            page.locator('#collectionPickList .collection-pick-item', has_text='测试文件夹').click()
            time.sleep(1.2)
            check('move book into folder', page.locator('.collection-chip', has_text='测试文件夹').inner_text().find('1') >= 0)

            # 自动分类（按阅读状态）
            page.click('#btnAutoClassify')
            page.wait_for_selector('#autoClassifyBackdrop.is-open', timeout=5000)
            page.locator('[data-auto-mode="status"]').click()
            page.wait_for_selector('.collection-chip:has-text("在读"), .collection-chip:has-text("未读")', timeout=20000)
            time.sleep(0.8)
            check('auto classify creates folders', page.locator('.collection-chip', has_text='在读').count() + page.locator('.collection-chip', has_text='未读').count() >= 1)
            page.screenshot(path=os.path.join(SHOTS, 'shelf-auto-classify.png'))

            # AI 智能分类（需要 DSH 模型通道）
            page.click('#btnAutoClassify')
            page.wait_for_selector('#autoClassifyBackdrop.is-open', timeout=5000)
            page.locator('[data-auto-mode="ai"]').click()
            deadline = time.time() + 75
            ai_folder = ''
            while time.time() < deadline:
                time.sleep(2)
                names = page.locator('.collection-chip .collection-chip-name').all_inner_texts()
                extra = [n for n in names if n not in ('全部', '未分类', '在读', '未读', '已读完', '测试文件夹')]
                if extra:
                    ai_folder = extra[0]
                    break
            check('AI classification creates themed folder', bool(ai_folder), str(ai_folder))
            page.screenshot(path=os.path.join(SHOTS, 'shelf-ai-classify.png'))

            check('no app console errors', not [e for e in errors if 'Failed to load resource' not in e], '; '.join(errors[:3]))
            browser.close()
    finally:
        cleanup()

    passed = sum(1 for _, ok in results if ok)
    print(f'\nRESULT {passed}/{len(results)} passed')
    return 0 if passed == len(results) else 1


if __name__ == '__main__':
    sys.exit(main())
