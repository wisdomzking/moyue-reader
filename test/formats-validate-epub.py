#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""EPUB3 结构校验（formats 自测用）。

用法：python formats-validate-epub.py <book.epub> <out.json>

校验项：
  - zip：mimetype 是第一条且 STORE 压缩、内容 application/epub+zip
  - META-INF/container.xml 指向的 OPF 存在
  - OPF：dc:title / dc:language / dc:identifier 非空；manifest 条目文件都存在；spine idref 有效
  - nav.xhtml 存在且带 properties="nav"，nav 链接的文件/锚点都能解析
  - 所有 XHTML 章节可被严格 XML 解析；图片有 media-type
结果写 JSON 文件（不依赖 stdout）。
"""
import json
import os
import posixpath
import sys
import zipfile

from lxml import etree

OPF_NS = 'http://www.idpf.org/2007/opf'
DC_NS = 'http://purl.org/dc/elements/1.1/'
CONTAINER_NS = 'urn:oasis:names:tc:opendocument:xmlns:container'


def main():
    if len(sys.argv) < 3:
        return 2
    epub_path = sys.argv[1]
    out_path = sys.argv[2]
    res = {
        'ok': False,
        'errors': [],
        'warnings': [],
        'size': 0,
        'chapters': 0,
        'images': 0,
        'toc': 0,
        'title': '',
        'language': '',
        'nav_ok': False,
        'nav_present': False,
        'nav_lists': 0,
        'ncx': False,
    }
    errors = res['errors']
    warnings = res['warnings']

    def add_err(msg):
        errors.append(msg)

    try:
        if not os.path.isfile(epub_path):
            raise RuntimeError('文件不存在')
        res['size'] = os.path.getsize(epub_path)
        z = zipfile.ZipFile(epub_path)
        names = z.namelist()
        infos = z.infolist()
        if not infos:
            add_err('zip 为空')
        else:
            first = infos[0]
            if first.filename != 'mimetype':
                add_err('第一条不是 mimetype：' + first.filename)
            if first.compress_type != zipfile.ZIP_STORED:
                add_err('mimetype 被压缩了（compress_type=%d）' % first.compress_type)
        if 'mimetype' in names:
            if z.read('mimetype') != b'application/epub+zip':
                add_err('mimetype 内容不是 application/epub+zip')
        else:
            add_err('缺少 mimetype')

        container_name = None
        for n in names:
            if n.lower() == 'meta-inf/container.xml':
                container_name = n
                break
        if not container_name:
            add_err('缺少 META-INF/container.xml')
            raise RuntimeError('no container')
        container = etree.fromstring(z.read(container_name))
        rootfiles = container.findall('.//{%s}rootfiles/{%s}rootfile' % (CONTAINER_NS, CONTAINER_NS))
        if not rootfiles:
            add_err('container.xml 没有 rootfile')
            raise RuntimeError('no rootfile')
        opf_path = rootfiles[0].get('full-path') or ''
        if opf_path not in names:
            add_err('container.xml 指向的 OPF 不存在：' + opf_path)
            raise RuntimeError('no opf')

        opf = etree.fromstring(z.read(opf_path))
        base = posixpath.dirname(opf_path)

        def find_text(ns, tag):
            el = opf.find('.//{%s}%s' % (ns, tag))
            if el is None:
                return ''
            return ''.join(el.itertext()).strip()

        res['title'] = find_text(DC_NS, 'title')
        res['language'] = find_text(DC_NS, 'language')
        identifier = find_text(DC_NS, 'identifier')
        if not res['title']:
            add_err('OPF 缺少 dc:title')
        if not res['language']:
            add_err('OPF 缺少 dc:language')
        if not identifier:
            add_err('OPF 缺少 dc:identifier')

        manifest = {}
        id_to_item = {}
        nav_item = None
        for item in opf.findall('.//{%s}manifest/{%s}item' % (OPF_NS, OPF_NS)):
            iid = item.get('id') or ''
            href = item.get('href') or ''
            media = item.get('media-type') or ''
            props = item.get('properties') or ''
            zip_path = posixpath.normpath(posixpath.join(base, href))
            if zip_path not in names:
                add_err('manifest 条目文件不存在：' + href + ' → ' + zip_path)
            manifest[iid] = {'href': href, 'media': media, 'props': props, 'zip_path': zip_path}
            id_to_item[iid] = manifest[iid]
            if 'nav' in props.split():
                nav_item = manifest[iid]
            if media.startswith('image/'):
                res['images'] += 1
        if not manifest:
            add_err('manifest 为空')
        if not nav_item:
            warnings.append('manifest 中没有 properties="nav" 的 nav.xhtml（EPUB2 原书可接受）')
        res['nav_present'] = bool(nav_item)

        spine_ids = [el.get('idref') for el in opf.findall('.//{%s}spine/{%s}itemref' % (OPF_NS, OPF_NS))]
        if not spine_ids:
            add_err('spine 为空')
        for sid in spine_ids:
            if sid not in id_to_item:
                add_err('spine idref 不存在于 manifest：' + str(sid))
        res['chapters'] = len(spine_ids)

        # ncx 可选
        for iid, it in manifest.items():
            if it['media'] == 'application/x-dtbncx+xml' or it['href'].lower().endswith('.ncx'):
                res['ncx'] = True
                try:
                    etree.fromstring(z.read(it['zip_path']))
                except Exception as exc:
                    add_err('toc.ncx XML 解析失败：%s' % exc)

        # 所有 xhtml/html 条目都必须能严格解析
        xhtml_count = 0
        for n in names:
            if n.lower().endswith(('.xhtml', '.html', '.htm')):
                try:
                    etree.fromstring(z.read(n))
                    xhtml_count += 1
                except Exception as exc:
                    add_err('XHTML 解析失败 %s：%s' % (n, str(exc)[:200]))
        if xhtml_count == 0:
            add_err('没有任何 XHTML 文件')

        # nav 链接解析
        if nav_item:
            try:
                nav_doc = etree.fromstring(z.read(nav_item['zip_path']))
                nav_base = posixpath.dirname(nav_item['zip_path'])
                links = nav_doc.findall('.//{http://www.w3.org/1999/xhtml}a')
                res['nav_lists'] = len(nav_doc.findall('.//{http://www.w3.org/1999/xhtml}ol'))
                if not links:
                    add_err('nav.xhtml 没有链接')
                for a in links:
                    href = a.get('href') or ''
                    if not href or href.startswith(('http:', 'https:', 'mailto:')):
                        continue
                    file_part, _, frag = href.partition('#')
                    target = nav_item['zip_path'] if not file_part else posixpath.normpath(posixpath.join(nav_base, file_part))
                    if target not in names:
                        add_err('nav 链接目标不存在：' + href)
                        continue
                    if frag:
                        try:
                            target_doc = etree.fromstring(z.read(target))
                            ids = set(target_doc.xpath('//@id'))
                            if frag not in ids:
                                add_err('nav 锚点不存在：' + href)
                        except Exception as exc:
                            add_err('nav 目标解析失败 %s：%s' % (href, str(exc)[:120]))
                res['nav_ok'] = not any('nav' in e for e in errors)
                res['toc'] = len(links)
            except Exception as exc:
                add_err('nav.xhtml 解析失败：%s' % exc)

        # 图片 MIME 检查
        for iid, it in manifest.items():
            if it['media'].startswith('image/'):
                if it['zip_path'] not in names:
                    add_err('图片缺失：' + it['href'])

        res['ok'] = len(errors) == 0
    except Exception as exc:
        add_err('校验异常：%s' % exc)
        res['ok'] = False
    try:
        with open(out_path, 'w', encoding='utf-8') as fp:
            json.dump(res, fp, ensure_ascii=False)
    except Exception:
        return 1
    return 0 if res['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
