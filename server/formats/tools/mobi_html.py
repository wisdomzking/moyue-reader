#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""KindleUnpack mobi7/mobi8 产物 → 结构化章节素材（供 Node 组装 EPUB3）。

用法：
  python mobi_html.py <unpackedDir> <stageDir> <metaOut.json>

产物：
  <stageDir>/chNNN.body.xhtml   每章 XHTML 片段（已清洗为 XML 安全的 XHTML，图片 src 指向 ../images/）
  <stageDir>/images/*           图片资源
  <metaOut.json>                {title, author, language, identifier, chapters:[...], toc:[...], images:[...], cover:{...}|null}

只写文件、不依赖 stdout；失败时返回非 0 且 meta 里带 error。
"""
import json
import os
import posixpath
import re
import shutil
import sys
from xml.sax.saxutils import escape as xml_escape

import lxml.html as LH
from lxml import etree

IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.tif', '.tiff'}
DROP_TAGS = {
    'script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button',
    'select', 'textarea', 'noscript', 'frame', 'frameset', 'applet', 'link', 'meta', 'base',
}
MIME_BY_EXT = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
    '.bmp': 'image/bmp', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.tif': 'image/tiff', '.tiff': 'image/tiff',
}


def localname(tag):
    if not isinstance(tag, str):
        return ''
    return tag.split('}')[-1].split(':')[-1].lower()


def parse_xml(path):
    try:
        return etree.parse(path).getroot()
    except Exception:
        return None


def iter_local(root, name):
    if root is None:
        return
    for el in root.iter():
        if localname(el.tag) == name:
            yield el


def text_of(el):
    return ''.join(el.itertext()).strip()


def sniff_mime(path):
    ext = os.path.splitext(path)[1].lower()
    try:
        with open(path, 'rb') as fp:
            head = fp.read(16)
        if head[:3] == b'\xff\xd8\xff':
            return 'image/jpeg'
        if head[:8] == b'\x89PNG\r\n\x1a\n':
            return 'image/png'
        if head[:6] in (b'GIF87a', b'GIF89a'):
            return 'image/gif'
        if head[:2] == b'BM':
            return 'image/bmp'
        if head[:4] == b'RIFF' and head[8:12] == b'WEBP':
            return 'image/webp'
    except Exception:
        pass
    return MIME_BY_EXT.get(ext, 'application/octet-stream')


# ---------------------------------------------------------------- OPF
def read_opf(path):
    root = parse_xml(path)
    info = {'title': '', 'author': '', 'language': '', 'identifier': '',
            'items': [], 'spine': [], 'cover_href': ''}
    if root is None:
        return info
    for el in iter_local(root, 'title'):
        t = text_of(el)
        if t:
            info['title'] = t
            break
    for el in iter_local(root, 'creator'):
        t = text_of(el)
        if t:
            info['author'] = t
            break
    for el in iter_local(root, 'language'):
        t = text_of(el)
        if t:
            info['language'] = t.lower()
            break
    for el in iter_local(root, 'identifier'):
        t = text_of(el)
        if t:
            info['identifier'] = t
            break
    for el in iter_local(root, 'item'):
        href = el.get('href') or ''
        if not href:
            continue
        info['items'].append({
            'id': el.get('id') or '',
            'href': href,
            'media_type': (el.get('media-type') or '').lower(),
            'properties': (el.get('properties') or ''),
        })
    for el in iter_local(root, 'itemref'):
        ref = el.get('idref') or ''
        if ref:
            info['spine'].append(ref)
    # 封面：EPUB2 <meta name="cover" content="id">
    for el in iter_local(root, 'meta'):
        if (el.get('name') or '').lower() == 'cover' and el.get('content'):
            cid = el.get('content')
            for it in info['items']:
                if it['id'] == cid:
                    info['cover_href'] = it['href']
                    break
        if not info['cover_href'] and (el.get('name') or '').lower() in ('cover thumbnail image',):
            if el.get('content'):
                info['cover_href'] = el.get('content')
    if not info['cover_href']:
        for it in info['items']:
            if it['media_type'].startswith('image/') and 'cover' in (it['href'] or '').lower():
                info['cover_href'] = it['href']
                break
    return info


# ---------------------------------------------------------------- NCX
def read_ncx(path):
    root = parse_xml(path)
    out = []
    if root is None:
        return out
    navmap = None
    for el in iter_local(root, 'navmap'):
        navmap = el
        break
    if navmap is None:
        return out

    def walk(node, depth):
        for child in node:
            if localname(child.tag) != 'navpoint':
                continue
            label = ''
            src = ''
            for sub in child.iter():
                ln = localname(sub.tag)
                if ln == 'text' and not label:
                    label = text_of(sub)
                elif ln == 'content' and not src:
                    src = sub.get('src') or ''
            out.append({'label': label, 'src': src, 'depth': depth})
            walk(child, depth + 1)

    walk(navmap, 1)
    return out


# ---------------------------------------------------------------- HTML 清洗
def clean_fragment(seg):
    """用 lxml.html 解析片段并序列化成 XML 安全的 XHTML。"""
    if not seg or not seg.strip():
        return ''
    try:
        root = LH.fragment_fromstring(seg, create_parent='div')
    except Exception:
        text = re.sub(r'<[^>]+>', ' ', seg)
        text = re.sub(r'\s+', ' ', text).strip()
        return ('<p>' + xml_escape(text) + '</p>') if text else ''
    for el in list(root.iter()):
        if not isinstance(el.tag, str):
            continue
        tag = el.tag
        local = tag.split(':')[-1].lower()
        if ':' in tag or local in DROP_TAGS:
            parent = el.getparent()
            if parent is None:
                continue
            try:
                el.drop_tree()
            except Exception:
                parent.remove(el)
            continue
        # 事件属性、srcset 等去掉；MOBI 专用的 height/width 排版提示对 EPUB 无意义
        for key in list(el.attrib.keys()):
            kl = key.lower()
            if kl.startswith('on') or kl in ('srcset', 'sizes'):
                del el.attrib[key]
            elif kl in ('height', 'width') and local in ('p', 'div', 'span', 'font', 'center', 'blockquote'):
                del el.attrib[key]
    parts = []
    if root.text:
        parts.append(xml_escape(root.text))
    for child in root:
        try:
            parts.append(etree.tostring(child, method='xml', encoding='unicode', with_tail=True))
        except Exception:
            continue
    out = ''.join(parts)
    # 段落开头残留的空格/不换行空格去掉（CSS 用 text-indent 控制缩进）
    out = re.sub(r'(<p\b[^>]*>)[\s\u00a0]+', r'\1', out)
    return out


def extract_body(html_text):
    m = re.search(r'<body\b[^>]*>([\s\S]*?)</body\s*>', html_text, re.I)
    return m.group(1) if m else html_text


def sanitize_text_attr(value, limit=60):
    plain = re.sub(r'<[^>]+>', '', value or '')
    plain = re.sub(r'\s+', ' ', plain).strip()
    return plain[:limit]


# ---------------------------------------------------------------- 主流程
def main():
    if len(sys.argv) < 4:
        return 2
    src_dir = os.path.abspath(sys.argv[1])
    stage_dir = os.path.abspath(sys.argv[2])
    meta_path = os.path.abspath(sys.argv[3])
    result = {'ok': False, 'error': '', 'title': '', 'author': '', 'language': '',
              'identifier': '', 'chapters': [], 'toc': [], 'images': [], 'cover': None}
    try:
        if os.path.isdir(stage_dir):
            shutil.rmtree(stage_dir, ignore_errors=True)
        os.makedirs(os.path.join(stage_dir, 'images'), exist_ok=True)

        # 1. 找 OPF（优先 src_dir 直下）
        opf_path = ''
        cand = os.path.join(src_dir, 'content.opf')
        if os.path.isfile(cand):
            opf_path = cand
        else:
            for root, _dirs, files in os.walk(src_dir):
                for f in files:
                    if f.lower().endswith('.opf'):
                        opf_path = os.path.join(root, f)
                        break
                if opf_path:
                    break
        info = read_opf(opf_path) if opf_path else {
            'title': '', 'author': '', 'language': '', 'identifier': '', 'items': [], 'spine': [], 'cover_href': ''}
        html_dir = os.path.dirname(opf_path) if opf_path else src_dir

        # 2. 主 HTML：优先 spine 里的 text/html，其次 book.html / 任意 html
        item_by_id = {it['id']: it for it in info['items'] if it['id']}
        html_rel = []
        for ref in info['spine']:
            it = item_by_id.get(ref)
            if it and ('html' in (it['media_type'] or '') or it['href'].lower().endswith(('.html', '.xhtml', '.htm'))):
                html_rel.append(it['href'])
        if not html_rel:
            html_rel = [it['href'] for it in info['items']
                        if 'html' in (it['media_type'] or '') or it['href'].lower().endswith(('.html', '.xhtml', '.htm'))]
        if not html_rel:
            book_html = os.path.join(html_dir, 'book.html')
            if os.path.isfile(book_html):
                html_rel = ['book.html']
            else:
                found = ''
                for root, _dirs, files in os.walk(src_dir):
                    for f in files:
                        if f.lower().endswith(('.html', '.htm', '.xhtml')):
                            found = os.path.relpath(os.path.join(root, f), html_dir).replace('\\', '/')
                            break
                    if found:
                        break
                html_rel = [found] if found else []
        if not html_rel:
            raise RuntimeError('未找到 mobi7/mobi8 的 HTML 正文')

        # 3. 合并正文 + 收集锚点（多 HTML 文件时按 spine 拼接，锚点位置全局化）
        anchors = []  # (pos, id)
        parts = []
        offsets = 0
        for rel in html_rel:
            path = os.path.normpath(os.path.join(html_dir, rel.replace('/', os.sep)))
            if not os.path.isfile(path):
                continue
            with open(path, 'rb') as fp:
                raw = fp.read()
            try:
                text = raw.decode('utf-8')
            except UnicodeDecodeError:
                text = raw.decode('utf-8', errors='replace')
            body = extract_body(text)
            for m in re.finditer(r'<a\b[^>]*?\bid\s*=\s*["\']([^"\']+)["\']', body, re.I):
                anchors.append((offsets + m.start(), m.group(1)))
            parts.append(body)
            offsets += len(body) + 1
        body = '\n'.join(parts)
        if not body.strip():
            raise RuntimeError('HTML 正文为空')

        # 4. 图片：按文件名去重（同名的取最大文件），复制到 stage/images
        image_files = {}
        for root, _dirs, files in os.walk(src_dir):
            for f in files:
                if os.path.splitext(f)[1].lower() in IMAGE_EXTS:
                    p = os.path.join(root, f)
                    key = f.lower()
                    try:
                        size = os.path.getsize(p)
                    except OSError:
                        continue
                    if key not in image_files or size > image_files[key][1]:
                        image_files[key] = (p, size)
        name_by_ext = {}
        images = []
        for key, (path, _size) in image_files.items():
            base = os.path.basename(path)
            ext = os.path.splitext(base)[1].lower()
            safe = re.sub(r'[^A-Za-z0-9_.-]+', '_', os.path.splitext(base)[0])[:50] + ext
            if safe in name_by_ext:
                safe = re.sub(r'[^A-Za-z0-9_.-]+', '_', key)[:50] + ext
            name_by_ext[key] = safe
            shutil.copyfile(path, os.path.join(stage_dir, 'images', safe))
            images.append({'name': safe, 'mime': sniff_mime(path)})
        result['images'] = images

        # 5. NCX → 目录
        ncx_path = ''
        for it in info['items']:
            if 'ncx' in (it['media_type'] or '') or it['href'].lower().endswith('.ncx'):
                ncx_path = os.path.normpath(os.path.join(html_dir, it['href'].replace('/', os.sep)))
                break
        if not ncx_path or not os.path.isfile(ncx_path):
            for cand_name in ('toc.ncx',):
                p = os.path.join(html_dir, cand_name)
                if os.path.isfile(p):
                    ncx_path = p
                    break
        navpoints = read_ncx(ncx_path) if ncx_path and os.path.isfile(ncx_path) else []
        # 目录过大时限制切章数量（否则会产出成百上千个 XHTML 文件）
        if len(navpoints) > 500:
            navpoints = [np for np in navpoints if np['depth'] <= 2]
        if len(navpoints) > 800:
            navpoints = [np for np in navpoints if np['depth'] <= 1]
        if len(navpoints) > 800:
            # 放弃切章：整本一章，目录退化为锚点跳转
            navpoints = []
        for np in navpoints:
            src = np['src']
            if '#' in src:
                np['anchor'] = src.rsplit('#', 1)[1]
            else:
                np['anchor'] = ''

        # 6. 按 NCX 锚点位置切章
        pos_by_id = {}
        for pos, aid in anchors:
            pos_by_id.setdefault(aid, pos)
        split_positions = sorted({pos_by_id[np['anchor']] for np in navpoints if np.get('anchor') in pos_by_id})
        boundaries = [0]
        for p in split_positions:
            if p > boundaries[-1]:
                boundaries.append(p)
        chapter_labels = ['']
        label_by_pos = {}
        for np in navpoints:
            p = pos_by_id.get(np.get('anchor'))
            if p is None:
                continue
            label_by_pos.setdefault(p, np['label'] or ('第%d节' % (len(label_by_pos) + 1)))
        for b in boundaries[1:]:
            chapter_labels.append(label_by_pos.get(b, ''))

        title = info['title'] or (navpoints[0]['label'] if navpoints else '') or ''
        result['title'] = title
        result['author'] = info['author']
        result['language'] = info['language']
        result['identifier'] = info['identifier']

        def chapter_index_for(pos):
            idx = 0
            for i, b in enumerate(boundaries):
                if b <= pos:
                    idx = i
                else:
                    break
            return idx

        # 锚点 → 章节索引（用于把跨章的内部链接改写成「chNNN.xhtml#id」）
        anchor_chapter = {}
        for pos, aid in anchors:
            anchor_chapter.setdefault(aid, chapter_index_for(pos))

        def make_anchor_rewriter(current_idx):
            def repl(m):
                tag = m.group(0)
                hm = re.search(r'\bhref\s*=\s*["\']#([^"\']+)["\']', tag, re.I)
                if not hm:
                    return tag
                aid = hm.group(1)
                tgt = anchor_chapter.get(aid)
                if tgt is None or tgt == current_idx:
                    return tag
                return re.sub(r'\bhref\s*=\s*["\'][^"\']*["\']',
                              'href="ch%03d.xhtml#%s"' % (tgt + 1, aid), tag, count=1)
            return repl

        # 7. 清洗每章，写 body 片段
        chapter_meta = []
        for i, start in enumerate(boundaries):
            end = boundaries[i + 1] if i + 1 < len(boundaries) else len(body)
            seg = body[start:end]

            def rewrite_img(m):
                attrs = m.group(0)
                sm = re.search(r'\bsrc\s*=\s*["\']([^"\']+)["\']', attrs, re.I)
                if not sm:
                    return ''
                src = sm.group(1)
                if src.startswith('data:'):
                    return ''
                base = posixpath.basename(src.replace('\\', '/')).lower()
                new = name_by_ext.get(base)
                if not new:
                    return ''
                return re.sub(r'\bsrc\s*=\s*["\'][^"\']*["\']', 'src="../images/%s"' % new, attrs, count=1)

            cleaned = clean_fragment(seg)
            cleaned = re.sub(r'<img\b[^>]*>', rewrite_img, cleaned, flags=re.I)
            cleaned = re.sub(r'<a\b[^>]*>', make_anchor_rewriter(i), cleaned, flags=re.I)
            body_file = 'ch%03d.body.xhtml' % (i + 1)
            with open(os.path.join(stage_dir, body_file), 'w', encoding='utf-8') as fp:
                fp.write(cleaned)
            label = chapter_labels[i] or (title if i == 0 and title else '第%d节' % (i + 1))
            chapter_meta.append({'body': body_file, 'label': label, 'start': start})

        # 8. toc：把每个 navPoint 映射到章节（anchor 若不在章节起点则带 fragment）
        anchor_ids_by_pos = {}
        for pos, aid in anchors:
            anchor_ids_by_pos.setdefault(pos, aid)
        toc = []
        for np in navpoints:
            label = np['label'] or ('第%d节' % (len(toc) + 1))
            p = pos_by_id.get(np.get('anchor'))
            if p is None:
                idx = 0
            else:
                idx = chapter_index_for(p)
            anchor = None
            if p is not None and boundaries[idx] != p:
                anchor = anchor_ids_by_pos.get(p)
            toc.append({'label': label, 'chapter': idx, 'anchor': anchor, 'level': min(3, np['depth'])})

        # 9. 封面
        cover = None
        cover_base = posixpath.basename((info.get('cover_href') or '').replace('\\', '/')).lower()
        cover_name = name_by_ext.get(cover_base) if cover_base else None
        if not cover_name:
            for key in name_by_ext:
                if 'cover' in key:
                    cover_name = name_by_ext[key]
                    break
        if cover_name:
            for img in images:
                if img['name'] == cover_name:
                    cover = {'name': img['name'], 'mime': img['mime']}
                    break
        result['cover'] = cover
        result['chapters'] = chapter_meta
        result['toc'] = toc
        result['ok'] = True
    except Exception as exc:
        import traceback
        result['error'] = str(exc) + '\n' + traceback.format_exc()
    try:
        with open(meta_path, 'w', encoding='utf-8') as fp:
            json.dump(result, fp, ensure_ascii=False)
    except Exception:
        return 1
    return 0 if result.get('ok') else 1


if __name__ == '__main__':
    sys.exit(main())
