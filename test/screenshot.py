#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""截图小工具：python test/screenshot.py <url> <out.png> [width] [height] [wait_ms] [selector]

例：
  python test/screenshot.py http://127.0.0.1:7788/#/shelf test/shots/shelf.png 1440 900 1200
"""
import sys
import time
from playwright.sync_api import sync_playwright


def launch(p):
    for extra in ({'channel': 'chrome'}, {'channel': 'msedge'}, {}):
        try:
            return p.chromium.launch(headless=True, **extra)
        except Exception:  # noqa: BLE001
            continue
    raise SystemExit('no browser available')


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 1
    url = sys.argv[1]
    out = sys.argv[2]
    width = int(sys.argv[3]) if len(sys.argv) > 3 else 1440
    height = int(sys.argv[4]) if len(sys.argv) > 4 else 900
    wait_ms = int(sys.argv[5]) if len(sys.argv) > 5 else 1200
    selector = sys.argv[6] if len(sys.argv) > 6 else None

    with sync_playwright() as p:
        browser = launch(p)
        page = browser.new_page(viewport={'width': width, 'height': height}, device_scale_factor=1)
        logs = []
        page.on('console', lambda m: logs.append(f'[{m.type}] {m.text}'))
        page.on('pageerror', lambda e: logs.append(f'[pageerror] {e}'))
        page.goto(url, wait_until='domcontentloaded', timeout=30000)
        if selector:
            try:
                page.wait_for_selector(selector, timeout=20000)
            except Exception as e:  # noqa: BLE001
                print('selector wait failed:', e)
        time.sleep(wait_ms / 1000.0)
        page.screenshot(path=out)
        print('saved', out)
        if logs:
            print('--- console ---')
            for line in logs[:30]:
                print(line)
        browser.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
