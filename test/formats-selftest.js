#!/usr/bin/env node
'use strict';
/**
 * test/formats-selftest.js — server/formats 全格式自测（不依赖后端）。
 *
 * 用法（项目根目录任意位置）：node test/formats-selftest.js [--verbose]
 *
 * 覆盖：
 *   EPUB / PDF / MOBI / DOCX / DOC / RTF / ODT / TXT / MD / HTML / FB2 的 probe + prepare，
 *   并额外生成 GBK/UTF-16 编码 TXT、带图片 DOCX、LibreOffice 转出的 RTF/ODT 作为回归样书。
 * 校验：
 *   - 生成的 EPUB 用 test/formats-validate-epub.py 严格校验（mimetype 首条 STORE、
 *     container→OPF、manifest/spine、nav 链接与锚点、全部 XHTML 可 XML 解析）；
 *   - PDF 检查 pageCount；pdfCover 检查能生成 jpg；
 *   - 不支持扩展名应抛出「不支持的格式」。
 * 产物：.cache/selftest/（报告 report.json），退出码 0 表示全部通过。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WORK = path.join(ROOT, '.cache', 'selftest');
const FIX = path.join(WORK, 'fixtures');
const BOOKS = path.join(ROOT, 'test', 'books');
const VALIDATOR = path.join(__dirname, 'formats-validate-epub.py');
const LO = 'C:\\Program Files\\LibreOffice\\program\\soffice.exe';
const VERBOSE = process.argv.includes('--verbose');

const formats = require(path.join(ROOT, 'server', 'formats'));

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* ignore */ } }
function run(cmd, args, timeout) {
  return spawnSync(cmd, args, { stdio: 'ignore', windowsHide: true, timeout: timeout || 120000 });
}
function findProduced(dir, ext) {
  let found = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.toLowerCase().endsWith('.' + ext)) {
        const p = path.join(dir, f);
        if (fs.statSync(p).size > 0) found = p;
      }
    }
  } catch (_) { /* ignore */ }
  return found;
}
function sofficeConvert(src, outDir, target) {
  ensureDir(outDir);
  const profile = 'file:///' + path.join(ROOT, '.cache', 'lo-profile').replace(/\\/g, '/');
  run(LO, ['-env:UserInstallation=' + profile, '--headless', '--norestore', '--nologo',
    '--convert-to', target, '--outdir', outDir, src], 120000);
  return findProduced(outDir, target);
}
function py(code, args) {
  const r = spawnSync('python', ['-c', code].concat(args || []), { stdio: 'ignore', windowsHide: true, timeout: 120000 });
  return !r.error && r.status === 0;
}
function ms(t) { return (t / 1000).toFixed(t < 1000 ? 2 : 1) + 's'; }
function fmtBytes(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}
function validateEpub(epubPath, tag) {
  ensureDir(WORK);
  const out = path.join(WORK, 'validate-' + tag + '.json');
  rmrf(out);
  const r = spawnSync('python', [VALIDATOR, epubPath, out], { stdio: 'ignore', windowsHide: true, timeout: 120000 });
  let res = null;
  try { res = JSON.parse(fs.readFileSync(out, 'utf8')); } catch (_) { res = null; }
  if (!res) return { ok: false, errors: ['校验脚本执行失败（status=' + r.status + '）'], warnings: [] };
  return res;
}

/* ------------------------------------------------------------------ */
/* 生成回归样书                                                        */
/* ------------------------------------------------------------------ */

function buildFixtures() {
  ensureDir(FIX);
  const fixtures = [];
  const txtSrc = path.join(BOOKS, 'sample.txt');

  // GBK 编码 TXT
  const gbk = path.join(FIX, 'sample-gbk.txt');
  const okGbk = py(
    "import sys;d=open(sys.argv[1],'rb').read().decode('utf-8');open(sys.argv[2],'wb').write(d.encode('gbk'))",
    [txtSrc, gbk]
  );
  if (okGbk && fs.existsSync(gbk)) fixtures.push({ label: 'sample-gbk.txt', file: gbk, minChapters: 5, note: 'GBK 编码探测' });

  // UTF-16 (带 BOM) TXT
  const u16 = path.join(FIX, 'sample-utf16.txt');
  const okU16 = py(
    "import sys;d=open(sys.argv[1],'rb').read().decode('utf-8');open(sys.argv[2],'wb').write(b'\\xff\\xfe'+d.encode('utf-16-le'))",
    [txtSrc, u16]
  );
  if (okU16 && fs.existsSync(u16)) fixtures.push({ label: 'sample-utf16.txt', file: u16, minChapters: 5, note: 'UTF-16 BOM 探测' });

  // Markdown（# 标题切章）
  const md = path.join(FIX, 'sample.md');
  fs.writeFileSync(md, [
    '# 山海小记 · Markdown 版', '',
    '## 序章', '', '　　东海之外，有大壑焉。', '',
    '## 第一章 归墟', '', '　　少年负剑，立于崖上。', '',
    '## 第二章 渔火', '', '　　归墟之下另有一片海。', '',
    '## 后记', '', '　　很多年以后，有人在归墟边看到一个老人。', '',
  ].join('\n'), 'utf8');
  fixtures.push({ label: 'sample.md', file: md, minChapters: 4, note: 'Markdown 标题切章' });

  // 带图片的 DOCX（python-docx + Pillow 现场生成）
  const imgDocx = path.join(FIX, 'docx-with-image.docx');
  const png = path.join(FIX, 'pic.png');
  const okImgDocx = py([
    'import sys',
    'from docx import Document',
    'from docx.shared import Inches',
    'from PIL import Image, ImageDraw',
    'png_path, docx_path = sys.argv[1], sys.argv[2]',
    "img = Image.new('RGB', (400, 240), (243, 238, 227))",
    'd = ImageDraw.Draw(img)',
    'd.rectangle([12, 12, 388, 228], outline=(47, 111, 100), width=4)',
    'd.line([40, 60, 360, 180], fill=(185, 106, 69), width=6)',
    "img.save(png_path, 'PNG')",
    'doc = Document()',
    "doc.core_properties.title = '带图片的 DOCX 测试书'",
    "doc.core_properties.author = 'formats 自测'",
    "doc.add_heading('带图片的 DOCX 测试书', level=1)",
    "doc.add_paragraph('第一段：验证 DOCX 正文与图片能被转换进 EPUB。')",
    'doc.add_picture(png_path, width=Inches(3))',
    "doc.add_heading('第一章 图片测试', level=1)",
    "doc.add_paragraph('这是第一章的正文，下面再放一张图。')",
    'doc.add_picture(png_path, width=Inches(2))',
    "doc.add_heading('第二章 结尾', level=1)",
    "doc.add_paragraph('结束。')",
    'doc.save(docx_path)',
  ].join('\n'), [png, imgDocx]);
  if (okImgDocx && fs.existsSync(imgDocx)) {
    fixtures.push({ label: 'docx-with-image.docx', file: imgDocx, minChapters: 2, minImages: 1, note: 'DOCX 图片进 EPUB' });
  }

  // HTML + 相对路径图片
  if (fs.existsSync(png)) {
    const htmlImg = path.join(FIX, 'html-with-image.html');
    fs.writeFileSync(htmlImg, [
      '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>带图片的 HTML 样章 · 墨阅</title>',
      '<script>console.log("should be removed")</script></head><body>',
      '<h1>带图片的 HTML 样章</h1>',
      '<p onclick="alert(1)">这段正文里有一张相对路径图片，以及一个应被移除的 script/onclick。</p>',
      '<p><img src="pic.png" alt="测试图片"></p>',
      '<p><img src="https://example.com/remote.png" alt="外链图片应被跳过"></p>',
      '</body></html>',
    ].join('\n'), 'utf8');
    fixtures.push({ label: 'html-with-image.html', file: htmlImg, minChapters: 1, minImages: 1, note: 'HTML 清洗+图片复制' });
  }

  // 嵌套 section 的 FB2（验证多级目录）
  const fb2Nested = path.join(FIX, 'fb2-nested.fb2');
  fs.writeFileSync(fb2Nested, [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">',
    '  <description><title-info>',
    '    <author><first-name>测试</first-name><last-name>作者</last-name></author>',
    '    <book-title>嵌套章节 FB2</book-title><lang>zh</lang>',
    '  </title-info></description>',
    '  <body>',
    '    <section><title><p>第一部 起</p></title>',
    '      <section><title><p>第一章 甲</p></title><p>甲部正文。</p></section>',
    '      <section><title><p>第二章 乙</p></title><p>乙部正文。</p></section>',
    '    </section>',
    '  </body>',
    '</FictionBook>',
  ].join('\n'), 'utf8');
  fixtures.push({ label: 'fb2-nested.fb2', file: fb2Nested, minChapters: 3, expectNestedNav: true, note: 'FB2 嵌套 section / 多级目录' });

  // LibreOffice 转出的 RTF / ODT
  const baseDocx = path.join(BOOKS, 'sample.docx');
  const rtfDir = path.join(FIX, 'soffice-rtf');
  const rtf = sofficeConvert(baseDocx, rtfDir, 'rtf');
  if (rtf) fixtures.push({ label: 'sample-converted.rtf', file: rtf, minChapters: 5, note: 'DOCX→RTF(LibreOffice)' });
  const odtDir = path.join(FIX, 'soffice-odt');
  const odt = sofficeConvert(baseDocx, odtDir, 'odt');
  if (odt) fixtures.push({ label: 'sample-converted.odt', file: odt, minChapters: 5, note: 'DOCX→ODT(LibreOffice)' });

  return fixtures;
}

/* ------------------------------------------------------------------ */
/* 单本测试                                                            */
/* ------------------------------------------------------------------ */

async function testBook(entry, index, total) {
  const record = {
    label: entry.label,
    file: entry.file,
    note: entry.note || '',
    probe: null,
    prepare: null,
    validation: null,
    errors: [],
    warnings: [],
    ok: false,
  };
  const outDir = path.join(WORK, 'books', String(index + 1).padStart(2, '0') + '-' + entry.label.replace(/[^\w.-]+/g, '_'));
  rmrf(outDir);
  ensureDir(outDir);

  const t0 = Date.now();
  let probe = null;
  try {
    probe = await formats.probe(entry.file);
  } catch (e) {
    record.errors.push('probe 抛错：' + (e && e.message ? e.message : e));
  }
  const probeMs = Date.now() - t0;
  if (probe) {
    // 校验封面 Buffer 有效性
    if (probe.cover && (!Buffer.isBuffer(probe.cover) || probe.cover.length < 64)) {
      record.errors.push('probe.cover 不是有效 Buffer');
    }
    record.probe = {
      format: probe.format,
      title: probe.title,
      author: probe.author,
      language: probe.language,
      coverBytes: probe.cover ? probe.cover.length : 0,
      coverMime: probe.coverMime,
      pageCount: probe.pageCount,
      ms: probeMs,
    };
  }

  const t1 = Date.now();
  let prep = null;
  try {
    prep = await formats.prepare(entry.file, outDir);
  } catch (e) {
    record.errors.push('prepare 抛错：' + (e && e.message ? e.message : e));
  }
  const prepareMs = Date.now() - t1;
  if (prep) {
    const st = fs.existsSync(prep.file) ? fs.statSync(prep.file) : null;
    if (!st) {
      record.errors.push('prepare 产物不存在：' + prep.file);
    } else {
      record.prepare = {
        type: prep.type,
        file: prep.file,
        bytes: st.size,
        chapters: typeof prep.chapters === 'number' ? prep.chapters : (Array.isArray(prep.toc) ? prep.toc.length : 0),
        toc: Array.isArray(prep.toc) ? prep.toc.length : 0,
        pageCount: prep.pageCount,
        degraded: !!prep.degraded,
        ms: prepareMs,
      };
      if (entry.minChapters && record.prepare.chapters < entry.minChapters) {
        record.errors.push('章节数不足：' + record.prepare.chapters + ' < ' + entry.minChapters);
      }
      if (prep.degraded) record.warnings.push('走了降级路径：' + (prep.warning || ''));
    }
  }

  // EPUB 产物结构校验
  if (prep && prep.type === 'epub') {
    const val = validateEpub(prep.file, entry.label.replace(/[^\w.-]+/g, '_'));
    record.validation = {
      ok: val.ok,
      chapters: val.chapters,
      images: val.images,
      toc: val.toc,
      navPresent: !!val.nav_present,
      navOk: !!val.nav_ok,
      ncx: !!val.ncx,
      navLists: val.nav_lists || 0,
      size: val.size,
      errors: val.errors || [],
      warnings: val.warnings || [],
    };
    if (!val.ok) record.errors.push('EPUB 校验失败：' + (val.errors || []).slice(0, 3).join('；'));
    if (entry.expectNestedNav && !(val.nav_lists >= 2)) record.errors.push('多级目录未生成嵌套 <ol>');
    if (entry.file.toLowerCase().endsWith('.epub')) {
      // EPUB 原样直传：不要求 nav（老书可能只有 ncx）
      if (!(val.chapters > 0)) record.errors.push('直传 EPUB 的 spine 为空');
    } else {
      if (!val.nav_present) record.errors.push('生成的 EPUB 缺少 nav.xhtml');
      if (!(val.toc > 0)) record.errors.push('生成的 EPUB 目录为空');
      if (entry.minImages && !(val.images >= entry.minImages)) {
        record.errors.push('图片数不足：' + val.images + ' < ' + entry.minImages);
      }
    }
  } else if (prep && prep.type === 'pdf') {
    if (!(Number(prep.pageCount) > 0)) record.errors.push('PDF pageCount 无效');
    if (path.resolve(prep.file) !== path.resolve(entry.file)) record.errors.push('PDF 应原样返回原文件');
  }

  record.ok = record.errors.length === 0;
  const status = record.ok ? 'PASS' : 'FAIL';
  const probeInfo = record.probe
    ? `${record.probe.format} 「${record.probe.title}」 author=${record.probe.author || '-'} lang=${record.probe.language}` +
      ` cover=${record.probe.coverBytes ? fmtBytes(record.probe.coverBytes) : '无'}` +
      (record.probe.pageCount ? ` pages=${record.probe.pageCount}` : '')
    : 'probe 失败';
  let prepInfo = 'prepare 失败';
  if (record.prepare) {
    prepInfo = `type=${record.prepare.type} file=${path.basename(record.prepare.file)} size=${fmtBytes(record.prepare.bytes)}` +
      ` chapters=${record.prepare.chapters} toc=${record.prepare.toc}` +
      (record.prepare.pageCount ? ` pages=${record.prepare.pageCount}` : '');
  }
  let valInfo = '';
  if (record.validation) {
    valInfo = ` | EPUB校验 ${record.validation.ok ? 'OK' : 'FAIL'}` +
      ` nav=${record.validation.navPresent ? (record.validation.navOk ? 'OK' : 'BAD') : '无'}` +
      ` images=${record.validation.images}`;
  }
  console.log(`[${status}] ${String(index + 1).padStart(2, '0')}/${total} ${entry.label}${entry.note ? '（' + entry.note + '）' : ''}`);
  console.log(`       probe  ${ms(record.probe ? record.probe.ms : 0).padStart(7)}  ${probeInfo}`);
  console.log(`       prepare${ms(record.prepare ? record.prepare.ms : 0).padStart(7)}  ${prepInfo}${valInfo}`);
  for (const w of record.warnings) console.log('       ! ' + w);
  for (const e of record.errors) console.log('       ✗ ' + e);
  if (VERBOSE && record.prepare) console.log('       产物：' + record.prepare.file);
  return record;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

(async () => {
  console.log('墨阅 formats 自测 — Node ' + process.version + ' / ' + new Date().toISOString());
  console.log('项目：' + ROOT);
  rmrf(WORK);
  ensureDir(WORK);
  ensureDir(path.join(WORK, 'books'));

  let fixtures = [];
  try {
    fixtures = buildFixtures();
  } catch (e) {
    console.log('生成回归样书失败：' + (e && e.message ? e.message : e));
  }

  // 接口契约检查
  const contractErrors = [];
  const expectSupported = ['epub', 'mobi', 'azw', 'azw3', 'prc', 'pdf', 'doc', 'docx', 'rtf', 'odt', 'txt', 'md', 'html', 'htm', 'xhtml', 'fb2'];
  if (!Array.isArray(formats.SUPPORTED)) contractErrors.push('SUPPORTED 不是数组');
  else {
    for (const ext of expectSupported) {
      if (!formats.SUPPORTED.includes(ext)) contractErrors.push('SUPPORTED 缺少 ' + ext);
    }
  }
  const formatExpect = { epub: 'EPUB', pdf: 'PDF', mobi: 'MOBI', azw: 'AZW', azw3: 'AZW3', prc: 'PRC', docx: 'DOCX', doc: 'DOC', rtf: 'RTF', odt: 'ODT', txt: 'TXT', md: 'MD', html: 'HTML', htm: 'HTML', xhtml: 'XHTML', fb2: 'FB2' };
  for (const [ext, expected] of Object.entries(formatExpect)) {
    const actual = formats.formatOf('D:\\Books\\demo.' + ext);
    if (actual !== expected) contractErrors.push('formatOf(.' + ext + ')=' + actual + '，期望 ' + expected);
    if (!formats.isSupported('D:\\Books\\demo.' + ext)) contractErrors.push('isSupported(.' + ext + ') 应为 true');
  }
  if (formats.formatOf('D:\\Books\\demo.xyz') !== null) contractErrors.push('formatOf(.xyz) 应为 null');
  if (formats.isSupported('D:\\Books\\demo.xyz')) contractErrors.push('isSupported(.xyz) 应为 false');
  for (const fn of ['probe', 'prepare', 'pdfCover']) {
    if (typeof formats[fn] !== 'function') contractErrors.push('缺少接口 ' + fn);
  }
  console.log(`[${contractErrors.length ? 'FAIL' : 'PASS'}] 接口契约 SUPPORTED/isSupported/formatOf/probe/prepare/pdfCover`);
  for (const e of contractErrors) console.log('       ✗ ' + e);

  const entries = [
    { label: 'sample.epub', file: path.join(BOOKS, 'sample.epub'), note: 'EPUB 原样直传' },
    { label: 'sample.pdf', file: path.join(BOOKS, 'sample.pdf'), note: 'PDF 原样 + 封面' },
    { label: 'sample.mobi', file: path.join(BOOKS, 'sample.mobi'), note: 'MOBI→EPUB3', minChapters: 30 },
    { label: 'sample.docx', file: path.join(BOOKS, 'sample.docx'), note: 'DOCX 标题切章', minChapters: 10 },
    { label: 'sample.doc', file: path.join(BOOKS, 'sample.doc'), note: 'DOC→LibreOffice→DOCX', minChapters: 5 },
    { label: 'sample.txt', file: path.join(BOOKS, 'sample.txt'), note: 'TXT 中文章回', minChapters: 5 },
    { label: 'sample.html', file: path.join(BOOKS, 'sample.html'), note: 'HTML 单章+目录', minChapters: 1 },
    { label: 'sample.fb2', file: path.join(BOOKS, 'sample.fb2'), note: 'FB2 section 切章', minChapters: 2 },
  ].concat(fixtures.map((f) => ({ ...f, file: f.file })));

  const records = [];
  for (let i = 0; i < entries.length; i++) {
    records.push(await testBook(entries[i], i, entries.length));
  }

  // pdfCover 检查
  const coverOut = path.join(WORK, 'pdf-cover.jpg');
  const tCover = Date.now();
  let coverOk = false;
  try {
    coverOk = (await formats.pdfCover(path.join(BOOKS, 'sample.pdf'), coverOut)) === true;
  } catch (_) {
    coverOk = false;
  }
  const coverMs = Date.now() - tCover;
  const coverBytes = fs.existsSync(coverOut) ? fs.statSync(coverOut).size : 0;
  const coverRecord = { ok: coverOk && coverBytes > 0, ms: coverMs, bytes: coverBytes };
  console.log(`[${coverRecord.ok ? 'PASS' : 'FAIL'}] pdfCover  ${ms(coverMs)}  ${coverOut}（${fmtBytes(coverBytes)}）`);

  // 不支持格式
  const badFile = path.join(FIX, 'unsupported.xyz');
  fs.writeFileSync(badFile, 'not a book');
  let unsupportedOk = false;
  let unsupportedMsg = '';
  try {
    await formats.prepare(badFile, path.join(WORK, 'books', 'unsupported'));
  } catch (e) {
    unsupportedMsg = e && e.message ? e.message : String(e);
    unsupportedOk = /不支持/.test(unsupportedMsg);
  }
  console.log(`[${unsupportedOk ? 'PASS' : 'FAIL'}] 不支持格式应报错：${unsupportedMsg || '（未抛错）'}`);

  // 汇总
  const failed = records.filter((r) => !r.ok);
  const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    projectRoot: ROOT,
    totals: {
      books: records.length,
      passed: records.length - failed.length,
      failed: failed.length,
      contract: contractErrors.length === 0,
      pdfCover: coverRecord.ok,
      unsupported: unsupportedOk,
    },
    contract: { ok: contractErrors.length === 0, errors: contractErrors },
    books: records,
    pdfCover: coverRecord,
    unsupported: { ok: unsupportedOk, message: unsupportedMsg },
  };
  fs.writeFileSync(path.join(WORK, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

  console.log('');
  console.log('================ 汇总 ================');
  for (const r of records) {
    const p = r.prepare;
    console.log(`${r.ok ? '✓' : '✗'} ${r.label.padEnd(28)} ${r.probe ? r.probe.format.padEnd(6) : '?     '} ` +
      (p ? `${p.type.padEnd(4)} ${String(p.chapters).padStart(3)} 章 ${String(p.toc).padStart(3)} 目录 ${fmtBytes(p.bytes).padStart(8)}` : 'prepare 失败'));
  }
  console.log(`书：${records.length - failed.length}/${records.length} 通过；接口契约=${contractErrors.length ? 'FAIL' : 'OK'}；pdfCover=${coverRecord.ok ? 'OK' : 'FAIL'}；不支持格式检查=${unsupportedOk ? 'OK' : 'FAIL'}`);
  console.log('报告：' + path.join(WORK, 'report.json'));
  process.exit(failed.length === 0 && coverRecord.ok && unsupportedOk && contractErrors.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error('自测异常：', e);
  process.exit(2);
});
