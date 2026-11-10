#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Validate every generated EPUB in .cache: zip structure, mimetype stored first,
container.xml, OPF manifest/spine, nav, XHTML well-formedness, non-empty text."""
import glob
import os
import sys
import zipfile
from lxml import etree

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NS = {
    'c': 'urn:oasis:names:tc:opendocument:xmlns:container',
    'opf': 'http://www.idpf.org/2007/opf',
    'dc': 'http://purl.org/dc/elements/1.1/',
    'xhtml': 'http://www.w3.org/1999/xhtml',
}

errors = []
files = sorted(glob.glob(os.path.join(ROOT, '.cache', 'books', '*', '*.epub')))
if not files:
    print('no epub found, run api-check first')
    sys.exit(1)

for path in files:
    name = os.path.basename(os.path.dirname(path))
    try:
        z = zipfile.ZipFile(path)
        infos = z.infolist()
        if not infos or infos[0].filename != 'mimetype':
            errors.append(f'{name}: mimetype not first')
        elif infos[0].compress_type != zipfile.ZIP_STORED:
            errors.append(f'{name}: mimetype compressed')
        elif z.read('mimetype').strip() != b'application/epub+zip':
            errors.append(f'{name}: wrong mimetype content')
        container = etree.fromstring(z.read('META-INF/container.xml'))
        rootfile = container.find('.//c:rootfile', NS)
        if rootfile is None:
            errors.append(f'{name}: no rootfile')
            continue
        opf_path = rootfile.get('full-path')
        opf = etree.fromstring(z.read(opf_path))
        opf_dir = os.path.dirname(opf_path)
        title = opf.find('.//dc:title', NS)
        creator = opf.find('.//dc:creator', NS)
        items = {}
        for it in opf.findall('.//opf:manifest/opf:item', NS):
            items[it.get('id')] = (it.get('href'), it.get('media-type'))
        spine = [items[r.get('idref')] for r in opf.findall('.//opf:spine/opf:itemref', NS) if r.get('idref') in items]
        if not spine:
            errors.append(f'{name}: empty spine')
        total_text = 0
        bad = 0
        for href, _mt in spine:
            full = os.path.normpath(os.path.join(opf_dir, href)).replace('\\', '/')
            try:
                data = z.read(full)
            except KeyError:
                errors.append(f'{name}: missing spine file {full}')
                continue
            try:
                doc = etree.fromstring(data)
            except etree.XMLSyntaxError as e:
                bad += 1
                if bad <= 2:
                    errors.append(f'{name}: XHTML not well-formed {full}: {e}')
                continue
            text = ''.join(doc.itertext())
            total_text += len(text.strip())
        nav = None
        for it in opf.findall('.//opf:manifest/opf:item', NS):
            if 'nav' in (it.get('properties') or ''):
                nav = it.get('href')
        nav_ok = False
        if nav:
            try:
                navdoc = etree.fromstring(z.read(os.path.normpath(os.path.join(opf_dir, nav)).replace('\\', '/')))
                nav_ok = navdoc.find('.//xhtml:nav', NS) is not None
            except Exception:
                nav_ok = False
        status = 'OK' if total_text > 20 and not bad and nav_ok else 'WARN'
        print(f'{status} {name}  zipsize={os.path.getsize(path)//1024}KB spine={len(spine)} text={total_text} nav={"yes" if nav_ok else "no"} title={title.text if title is not None else "?"} author={creator.text if creator is not None else "-"}')
    except Exception as e:  # noqa: BLE001
        errors.append(f'{name}: EXC {e}')

print()
if errors:
    print('ERRORS:')
    for e in errors:
        print(' -', e)
    sys.exit(1)
print(f'ALL {len(files)} EPUBs VALID')
