#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""PDF 元数据/封面辅助：python pdf_probe.py <src.pdf> <out.json> [cover.jpg]

只写文件、不依赖 stdout（沙箱下 Node 管道 stdio 会 EPERM）。
输出 JSON：{ok,title,author,pages,language,outline,cover,error}
"""
import json
import os
import sys


def main():
    if len(sys.argv) < 3:
        return 2
    src = sys.argv[1]
    out_json = sys.argv[2]
    cover_out = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None
    result = {
        'ok': False,
        'title': '',
        'author': '',
        'pages': 0,
        'language': '',
        'outline': [],
        'cover': False,
        'error': '',
    }
    try:
        import fitz  # PyMuPDF

        doc = fitz.open(src)
        result['pages'] = int(doc.page_count or 0)
        meta = doc.metadata or {}
        result['title'] = (meta.get('title') or '').strip()
        result['author'] = (meta.get('author') or '').strip()
        result['subject'] = (meta.get('subject') or '').strip()
        try:
            outline = doc.get_toc(simple=True) or []
            result['outline'] = [[int(lv), str(title or ''), int(page or 0)] for lv, title, page in outline[:800]]
        except Exception:
            result['outline'] = []
        if cover_out and result['pages'] > 0:
            page = doc[0]
            width = float(page.rect.width or 0) or 1.0
            zoom = 400.0 / width
            if zoom > 4.0:
                zoom = 4.0
            pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
            try:
                pix.save(cover_out, jpg_quality=82)
            except Exception:
                pix.save(cover_out)
            result['cover'] = bool(os.path.exists(cover_out) and os.path.getsize(cover_out) > 0)
        result['ok'] = True
    except Exception as exc:  # 无 PyMuPDF / 文件损坏 / 需要密码等
        result['error'] = str(exc)
    try:
        with open(out_json, 'w', encoding='utf-8') as fp:
            json.dump(result, fp, ensure_ascii=False)
    except Exception:
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
