#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Verify page-turn buttons, auto page turn, typography (font/size/spacing) controls."""
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


def set_range(page, selector, value):
    page.evaluate(
        """([sel, val]) => {
            const el = document.querySelector(sel);
            if (!el) return;
            el.value = String(val);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }""",
        [selector, value],
    )


def main():
    original = api('/api/settings')['settings']
    epub = api('/api/open', 'POST', {'path': EPUB})
    pdf = api('/api/open', 'POST', {'path': PDF})
    results = []

    def check(name, cond, detail=''):
        results.append((name, bool(cond)))
        print(('  PASS ' if cond else '  FAIL ') + name + (f' :: {detail}' if not cond and detail else ''))

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel='chrome', headless=True)
            page = browser.new_page(viewport={'width': 1440, 'height': 900})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)

            # ---------- EPUB ----------
            page.goto(f'{BASE}/#/read/{epub["id"]}', wait_until='domcontentloaded')
            page.wait_for_selector('[data-testid="reader"]', timeout=30000)
            page.wait_for_function('document.body.dataset.ready === "1"', timeout=120000)
            time.sleep(1.6)

            nav_opacity = page.evaluate("getComputedStyle(document.querySelector('.reader-epub .page-nav')).opacity")
            check('EPUB page buttons visible', float(nav_opacity) > 0.3, f'opacity={nav_opacity}')

            before = api(f'/api/books/{epub["id"]}')['progress'].get('location', '')
            page.click('.reader-epub .page-nav-next')
            time.sleep(2.6)
            after_click = api(f'/api/books/{epub["id"]}')['progress'].get('location', '')
            check('EPUB page button turns page', after_click != before, f'{before} -> {after_click}')

            page.click('.reader-epub [data-action="settings"]')
            page.wait_for_selector('#settingsDrawer.is-open', timeout=10000)
            time.sleep(0.6)
            page.screenshot(path=os.path.join(SHOTS, 'settings-typography.png'))

            # typography
            set_range(page, '#fontSizeRange', 24)
            set_range(page, '#letterSpacingRange', 0.06)
            set_range(page, '#paragraphSpacingRange', 0.4)
            page.click('[data-setting="fontFamily"][data-value="system"]')
            time.sleep(1.0)
            styles = page.evaluate("""() => {
                const f = document.querySelector('#epub-viewer iframe');
                const d = f && f.contentDocument;
                if (!d || !d.body) return null;
                const p = d.querySelector('p');
                return {
                    fontSize: getComputedStyle(d.body).fontSize,
                    fontFamily: getComputedStyle(d.body).fontFamily,
                    letterSpacing: getComputedStyle(d.body).letterSpacing,
                    pMarginTop: p ? getComputedStyle(p).marginTop : null,
                };
            }""")
            check('font size applies', styles and styles['fontSize'] == '24px', str(styles))
            check('font family applies', styles and 'system-ui' in styles['fontFamily'], str(styles))
            check('letter spacing applies', styles and abs(float(styles['letterSpacing'].replace('px', '')) - 24 * 0.06) < 0.5, str(styles))
            check('paragraph spacing applies', styles and styles['pMarginTop'] and styles['pMarginTop'] != '0px', str(styles))

            # auto page turn
            page.click('#autoTurnToggle')
            set_range(page, '#autoTurnIntervalRange', 3)
            time.sleep(0.8)
            chip_visible = page.evaluate("!document.getElementById('autoTurnChip').hidden")
            check('auto turn chip shown', chip_visible)
            page.screenshot(path=os.path.join(SHOTS, 'settings-autoturn.png'))
            page.keyboard.press('Escape')
            time.sleep(0.4)
            loc_before = api(f'/api/books/{epub["id"]}')['progress'].get('location', '')
            time.sleep(4.6)
            loc_after = api(f'/api/books/{epub["id"]}')['progress'].get('location', '')
            check('EPUB auto page turn advances', loc_after != loc_before, f'{loc_before} -> {loc_after}')
            page.screenshot(path=os.path.join(SHOTS, 'reader-autoturn.png'))

            # stop auto turn via keyboard A
            page.keyboard.press('a')
            time.sleep(0.6)
            check('auto turn toggled off by A', api('/api/settings')['settings']['autoTurnEnabled'] is False)

            # ---------- PDF ----------
            page.goto(f'{BASE}/#/pdf/{pdf["id"]}', wait_until='domcontentloaded')
            page.wait_for_selector('[data-testid="reader"]', timeout=30000)
            page.wait_for_function('document.body.dataset.ready === "1"', timeout=120000)
            time.sleep(1.0)
            pdf_nav = page.evaluate("getComputedStyle(document.querySelector('.reader-pdf .page-nav')).opacity")
            check('PDF page buttons visible', float(pdf_nav) > 0.3, f'opacity={pdf_nav}')
            page.click('.reader-pdf .page-nav-next')
            time.sleep(1.2)
            page_no = page.locator('[data-testid="page-input"]').input_value()
            check('PDF page button turns page', page_no not in ('1', ''), f'page={page_no}')

            page.click('.reader-pdf [data-action="settings"]')
            page.wait_for_selector('#settingsDrawer.is-open', timeout=10000)
            page.click('#autoTurnToggle')
            set_range(page, '#autoTurnIntervalRange', 3)
            time.sleep(0.6)
            page.keyboard.press('Escape')
            time.sleep(0.4)
            pdf_before = int(page.locator('[data-testid="page-input"]').input_value())
            time.sleep(4.6)
            pdf_after = int(page.locator('[data-testid="page-input"]').input_value())
            check('PDF auto page turn advances', pdf_after > pdf_before, f'{pdf_before} -> {pdf_after}')
            page.screenshot(path=os.path.join(SHOTS, 'pdf-autoturn.png'))

            check('no console errors', not errors, '; '.join(errors[:5]))
            browser.close()
    finally:
        # restore settings & remove the temporary books
        try:
            api('/api/settings', 'PUT', original)
        except Exception:
            pass
        for book in (epub, pdf):
            try:
                api('/api/books/' + book['id'], 'DELETE')
            except Exception:
                pass

    passed = sum(1 for _, ok in results if ok)
    print(f'\nRESULT {passed}/{len(results)} passed')
    if passed != len(results):
        print('FAILURES:')
        for name, ok in results:
            if not ok:
                print(' -', name)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())

