# 墨阅 MoYue — 本地电子书阅读器 · 构建规格（唯一契约）

> 本文件是 Lead、后端、格式转换、前端四个工作流的唯一接口契约。任何人实现前先通读本文件；
> 需要改契约时先发消息给 Lead，不要擅自修改本文件。

## 1. 产品目标

一个运行在本机的电子书阅读器：直接读取电脑上任意位置的电子书（不复制、不搬运），
支持主流格式：**EPUB / PDF / MOBI / AZW / AZW3 / PRC / DOC / DOCX / RTF / ODT / TXT / MD / HTML / FB2**。

形态：本地 Node 服务（只监听 127.0.0.1:7788）+ 浏览器 UI（Edge/Chrome 打开，窗口可无边框）。
双击 `启动墨阅.cmd` 启动；`打开书.cmd "<某本电子书的绝对路径>"` 可直接打开指定书。
运行期**不依赖互联网**；所有前端库已 vendored 到 `web/vendor/`，npm 依赖已装在 `node_modules/`。

## 2. 目录与归属（写权限边界）

```
ebook-reader/
  SPEC.md                  Lead 所有，只读
  package.json             Lead
  server/
    server.js              backend：HTTP 入口 / 路由 / 静态资源
    lib/                   backend：library.js、browse.js、progress.js、search.js、util.js 等
    formats/
      index.js             formats：对外接口（见 §6）
      epub.js mobi.js docx.js text.js pdf.js epub-build.js util.js ...  formats 所有
  web/
    index.html             frontend
    css/                   frontend（app.css 负责壳/书架/弹窗；reader.css 负责阅读器）
    js/                    frontend
    vendor/                Lead 已放置：epub.min.js、pdf.min.js、pdf.worker.min.js —— 只读
  data/                    Lead（运行时数据：library.json、covers/、server.log）
  .cache/                  运行时缓存（转换产物、LibreOffice profile、tmp）—— 可随时清空
  test/                    测试书与测试脚本（Lead 主导；可新增测试用脚本，不改别人文件）
  scripts/                 Lead（start.ps1 等）
  启动墨阅.cmd / 打开书.cmd Lead
  README.md                Lead
```

**硬规则**：只改自己范围内的文件；不得 npm install / 不得改 SPEC.md / 不得改 vendor；不要占端口
7788/7790；完成后在任务里写清改动文件与自测结果。所有路径使用本机绝对路径（`D:\tools\dsh\ebook-reader`）。

## 3. 运行环境事实（已实测）

- Node v24.19.0（CommonJS 可用，自带 fetch、TextDecoder('gbk')）；npm 缓存必须放工作区内（已配好）。
- Python 3.12 在 PATH：`python`。已装 PyMuPDF(`fitz`)、python-docx、lxml、Pillow。pip 可用但运行期不需要。
- LibreOffice：`C:\Program Files\LibreOffice\program\soffice.exe`。**调用必须带参数**
  `-env:UserInstallation=file:///D:/tools/dsh/ebook-reader/.cache/lo-profile`，否则退出码异常；
  首次启动约 5–10 秒，转换写文件，必须 `stdio:'ignore'` 并检查输出文件是否生成。
- KindleUnpack：`vendor/kindleunpack/lib/kindleunpack.py`（Python 3 可直接跑）：
  `python vendor/kindleunpack/lib/kindleunpack.py <book.mobi> <outDir> --epub_version=3`
  实测 MOBI6 输出 `<outDir>/mobi7/{book.html,content.opf,toc.ncx,Images/}`；KF8/AZW3 可能直接输出 `.epub`，
  **以实际产物为准**；转换后遍历 outDir 找 `*.epub`，没有则用 mobi7 产物自己组装 EPUB。
- 沙箱限制（Lead 的会话内）：Node `child_process` 用管道 stdio 会 EPERM，必须用
  `spawnSync(cmd,args,{stdio:'ignore'})` 或 `spawn(..., {stdio:'ignore'})`，结果通过输出文件/退出码判断。
  用户正常双击运行时无此限制，但请统一按 `stdio:'ignore'` 写，兼容两边。
- 浏览器：Edge + Chrome 已装；E2E 用 Python Playwright（已装 Chromium）。

## 4. 数据模型

`data/library.json`（服务端持久化，原子写：先写 .tmp 再 rename）：

```jsonc
{
  "version": 1,
  "folders": ["D:\\Books", "C:\\Users\\<user>\\Documents\\电子书"],
  "books": { "<id>": BookRecord },        // id = sha1(absPath.toLowerCase()) 前 16 位 hex
  "settings": Settings
}
```

BookRecord（API 返回同样结构，绝对路径可返回）：

```jsonc
{
  "id": "a1b2c3d4e5f60718",
  "path": "D:\\Books\\三体.epub",
  "dir": "D:\\Books",
  "filename": "三体.epub",
  "ext": "epub",
  "format": "EPUB",                       // 大写字面：EPUB PDF MOBI AZW3 DOCX DOC TXT HTML FB2 ...
  "title": "三体",
  "author": "刘慈欣",
  "language": "zh",
  "size": 1234567,
  "mtime": 1760000000000,
  "cover": "/api/books/<id>/cover?v=<mtime>",   // 无封面时前端画渐变占位，不要 500，返回 404 即可
  "addedAt": 1760000000000,
  "lastReadAt": 0,                        // 0 表示未读
  "progress": { "percent": 0, "location": "", "page": 1, "totalPages": 0 },
  "status": "ready",                      // ready | converting | error | unsupported
  "error": null
}
```

Settings 默认值：

```jsonc
{ "theme": "light", "fontSize": 18, "fontFamily": "serif", "lineHeight": 1.8,
  "pageMode": "paginated", "spread": "auto", "maxWidth": 880, "pdfZoom": "fit" }
```
theme: light|sepia|dark；fontFamily: serif|sans|kai；pageMode: paginated|scroll；spread: auto|none。
pdfZoom: "fit" | "page" | 数字百分比字符串（如 "125"）。

## 5. HTTP API（后端实现，前端按此调用；JSON UTF-8；错误统一 `{"error":{"code":"...","message":"中文提示"}}`）

静态：`/` → `web/index.html`；`/css/*`、`/js/*`、`/vendor/*` 映射 `web/`；其它非 `/api/*` GET → 返回 index.html（SPA）。

- `GET /api/health` → `{ ok:true, version:"1.0.0", capabilities:{ mobi:true, docx:true, pdf:true, libreoffice:true, python:true } }`
- `GET /api/state` → `{ folders:[{path,name,bookCount}], books:[BookRecord], settings:Settings, counts:{total,byFormat} }`
  （一次拿全量，书籍按 lastReadAt 降序再由前端排序）
- `POST /api/scan` → 重新扫描全部文件夹：`{ added:n, removed:n, errors:[{path,message}], folders:[...] }`
  （递归深度上限 6，跳过隐藏目录、node_modules、.cache；支持扩展名见 §6；单个文件出错不影响其它）
- `POST /api/folders` body `{path}` → 添加并扫描该文件夹：`{ folder:{path,name,bookCount}, added:n }`
- `DELETE /api/folders?path=<absolute>` → `{ ok:true, removed:n }`
- `POST /api/open` body `{path}` → 登记单本（不在任何文件夹也可）返回 `BookRecord`；不支持 415，文件不存在 404
- `POST /api/import?name=<filename>` body=原始文件字节（拖拽导入）→ 保存到 `data/imported/<uuid>-<safeName>`，返回 BookRecord
- `GET /api/books/:id` → BookRecord
- `DELETE /api/books/:id` → `{ ok:true }`（只移出书库，不删磁盘文件）
- `POST /api/books/:id/prepare` → 确保可阅读，**可能耗时数秒**（超时 180s）：
  ```jsonc
  { "type": "epub",                 // epub | pdf
    "url": "/api/books/<id>/content",
    "title": "...", "author": "...",
    "toc": [{ "label":"第一章", "href":"chapter1.xhtml", "level":1 }],  // 可空；EPUB 也可由 epub.js 自己读
    "pageCount": 0 }
  ```
  转换期间把 BookRecord.status 置 `converting`，失败置 `error` 并写 error 文案，可重试。
- `GET /api/books/:id/content` → 原始字节流。EPUB: `application/epub+zip`；PDF: `application/pdf`。
  **必须支持 Range**（206/Content-Range/Accept-Ranges），支持 ETag + Last-Modified；PDF.js 会发 Range 请求。
- `GET /api/books/:id/cover` → `image/jpeg|png`，可 `Cache-Control: public, max-age=86400`；无封面 404。
  封面懒生成并缓存在 `data/covers/<id>.jpg`。
- `PUT /api/books/:id/progress` body `{percent, location, page, totalPages}` → `{ok:true, progress}`
  （percent 0..1，location 为 EPUB CFI 字符串；PDF 用 page/totalPages）
- `GET /api/books/:id/bookmarks` → `{bookmarks:[{id,cfi,href,percent,label,excerpt,createdAt}]}`
- `POST /api/books/:id/bookmarks` body 同上（无 id）→ 返回创建的对象
- `DELETE /api/books/:id/bookmarks/:bid` → `{ok:true}`
- `GET /api/books/:id/search?q=<kw>` → `{results:[{href,label,excerpt}], total:n}`（服务端解压 EPUB 全文搜索；上限 50 条）
- `GET /api/settings` / `PUT /api/settings` body Settings → `{settings}`
- `GET /api/browse?path=<absolute|empty>` → 目录浏览：
  ```jsonc
  { "path": "D:\\Books", "parent": "D:\\", "isDriveList": false,
    "drives":[{"name":"D:","path":"D:\\","free":1234567890}],           // 仅 isDriveList 时使用
    "quick":["桌面","文档","下载"],
    "dirs":[{"name":"小说","path":"D:\\Books\\小说"}],
    "files":[{"name":"三体.epub","path":"...","size":123,"ext":"epub","isBook":true}] }
  ```
  path 为空或 `/` 时返回磁盘列表 + 常用目录。遍历只列一层，不递归。
- `POST /api/reveal` body `{path}` → 在资源管理器定位文件：`{ok:true}`（spawn explorer，失败不报 500）

## 6. formats 模块接口（formats 实现，backend 调用）

`server/formats/index.js`（CommonJS，异步）：

```js
module.exports = {
  SUPPORTED: ['epub','mobi','azw','azw3','prc','pdf','doc','docx','rtf','odt','txt','md','html','htm','xhtml','fb2'],
  isSupported(filePath): boolean,
  formatOf(filePath): 'EPUB' | 'PDF' | ... | null,

  // 轻量探测（不转换、不产生大 IO，书架扫描用；单本 < 300ms 目标）
  // cover 可选：Buffer + mime，用于 /cover 首次生成
  async probe(filePath) -> {
    "format", "title", "author", "language",
    "cover": Buffer|null, "coverMime": "image/jpeg"|null,
    "pageCount": number|undefined
  },

  // 确保可直接交给浏览器：PDF 原样返回；流式格式生成/复用 EPUB 缓存
  // outDir: .cache/books/<id>/（调用方保证已建好、且已做 mtime/size 失效判断）
  // 返回 { type:'epub'|'pdf', file:'<绝对路径>', toc?: [...], pageCount?:number }
  // 失败抛 Error(中文可读原因)
  async prepare(filePath, outDir) -> { type, file, toc?, pageCount? },

  // PDF 首页封面（无 PyMuPDF 时返回 false，不报错）
  async pdfCover(filePath, outJpgPath) -> boolean
}
```

backend 必须**优雅降级**：`require('../formats')` 失败时用「按扩展名 + 文件名」的最简 probe，
PDF/EPUB 仍可读；formats 就绪后自动生效（进程重启即可，无需热加载）。

## 7. 各格式转换规则（formats）

统一目标：所有流式格式产出**合法 EPUB3**（zip：`mimetype` 首条且不压缩；`META-INF/container.xml`；
`OEBPS/content.opf`（dc:title/dc:creator/dc:language/dc:identifier，manifest 全量，spine 顺序，`properties="nav"` 的 nav.xhtml）；
`OEBPS/nav.xhtml`（嵌套 `<ol>`）；`OEBPS/toc.ncx` 可一并生成兼容老阅读器；各章节 XHTML UTF-8；相对路径引用 css/图片。
生成后应能被本机 `epub.js` 打开（Lead 会用 Playwright E2E 验证）。

| 格式 | 做法 |
|---|---|
| EPUB | 不转换：`prepare` 直接返回原文件 `type:'epub'` |
| PDF | 不转换：`type:'pdf'`；`probe` 用 PyMuPDF 读 title/author/pages 并渲染首页封面（宽 400 jpg，缓存由 backend 负责）；无 pymupdf 时退回 pdfjs-dist legacy（Node）只读 metadata；再不行用文件名 |
| MOBI/AZW/AZW3/PRC | `python vendor/kindleunpack/lib/kindleunpack.py <src> <tmpOut> --epub_version=3`；有 `*.epub` 直接用，否则把 `mobi7/{book.html,content.opf,toc.ncx,Images}` 组装成 EPUB（html 内 `filepos`/锚点可用即可）。`probe` 只读 PalmDB+EXTH：title=EXTH 503、author=EXTH 100，封面可缺失（打开后会从生成的 EPUB 取） |
| DOCX | `mammoth.convertToHtml({path})`；收集图片（mammoth `convertImage` 写入 img 目录并改 src），按 `<h1>/<h2>` 切章（无标题则整本一章），生成 EPUB；probe 读 `docProps/core.xml`（title/creator）用 jszip |
| DOC/RTF/ODT | LibreOffice `--convert-to docx` 到临时目录（带 UserInstallation 参数），再走 DOCX 流程；失败则 `--convert-to html` 兜底 |
| TXT/MD | 编码探测：UTF-8 BOM → UTF-16 → UTF-8 → GBK(`new TextDecoder('gbk')`)；按行聚段；`第X章/第X节/卷/回/Chapter N/序章/前言/后记/尾声` 正则切章并生成 nav；MD 直接当 TXT 处理（保留换行） |
| HTML/HTM/XHTML | 读取、去掉 `<script>/<iframe>/on*=`、取 `<body>`，相对图片尽量内联或跳过；整本一章 + 标题 nav |
| FB2 | 从 `<book-title>`、`<author><first-name/last-name>`、`<section><title>` 提取，best-effort 转 XHTML/EPUB |
| 其它 | `prepare` 抛错 `不支持的格式` |

缓存目录：`.cache/books/<id>/`（backend 传 outDir；formats 自行创建 `work/` 子目录放中间文件）。
**注意**：LibreOffice/KindleUnpack 的中间产物放 outDir/work，不要污染其它目录。

## 8. 前端（frontend）

### 8.1 文件与入口
`web/index.html` 引 `vendor/epub.min.js`、`vendor/pdf.min.js`（`pdfjsLib.GlobalWorkerOptions.workerSrc='/vendor/pdf.worker.min.js'`），
自身 `css/app.css` + `css/reader.css` + `js/app.js`（`<script type="module">`）。无构建步骤、无框架。
无后端时可用 mock：`node test/mock-api.js` 监听 7790，`http://127.0.0.1:7790/` 与真实 API 同构（Lead 提供）。

### 8.2 路由（hash）
- `#/shelf` 书架（默认）
- `#/read/<id>` 阅读器（EPUB）
- `#/pdf/<id>` PDF 阅读器
- `?open=<绝对路径>`：启动时调 `POST /api/open` 后跳阅读器（`scripts/start.ps1` 会用到 `#/read` 直接跳）

### 8.3 书架
- 顶栏：Logo「墨阅」（inline SVG）+ 搜索框（书名/作者即时过滤）+ 按钮：`添加文件夹`（打开目录浏览弹窗）、`添加文件`（弹窗选文件）、`扫描`、`设置`。
- 继续阅读区：最近读的 3 本横排大卡（封面 + 进度 + 继续按钮）；无记录则显示「开始你的第一本书」。
- 书架网格：`repeat(auto-fill,minmax(150px,1fr))`；每张卡：封面 2:3 圆角、格式角标、底部细进度条、标题 2 行、作者 1 行；无封面用「书名首字 + 渐变底色」占位。右键/悬停菜单：打开、在文件夹中显示、移出书架。
- 工具条：排序（最近阅读/添加时间/书名/作者）、格式筛选 chips、仅看未读。
- 空状态：插画式 SVG + 两个主按钮；加载 skeleton；错误 toast。
- 拖拽文件到窗口任意位置 → `POST /api/import` 导入并提示。

### 8.4 EPUB 阅读器（核心体验）
- 全窗口沉浸式；顶栏：返回、书名（可折行）、目录、搜索、书签、设置、全屏。顶栏 3 秒无操作淡出，鼠标移入顶部/移动时出现；`Esc` 关阅读器。
- 左右两栏：目录抽屉（`book.loaded.navigation.toc` 嵌套树，当前章高亮）、设置抽屉（主题三选、字号 14–32、字体 衬线/无衬线/楷体、行距 1.4–2.4、单双栏 spread、翻页/滚动 pageMode、版心宽度）。设置即时生效并 PUT `/api/settings`。
- epub.js：`ePub('/api/books/<id>/content')`；`rendition = book.renderTo(container, {width:'100%',height:'100%',flow,spread,allowScriptedContent:false})`；
  `rendition.themes.register` 三套主题 + `fontSize/font/override('line-height')`；`rendition.display(savedCfi)` 恢复位置；
  `book.locations.generate(1600)` 计算 percent（异步，失败时用 cfi 粗估），`relocated` 事件防抖 1.5s PUT 进度；
  `book.loaded.navigation` 生成目录；`book.ready` 前显示加载动画。
- 翻页按钮左右悬浮（桌面 hover 出现）、底部进度条可点击跳转章节首；键盘 ←/→/Space/PageUp/PageDown 翻页；`+/-` 字号；`T` 目录、`S` 设置、`F` 全屏、`B` 书签。
- 书签：当前 CFI 存 `/api/books/:id/bookmarks`，目录抽屉内「书签」页签列出，点击 `display(cfi)`。
- 搜索：输入 → `GET .../search?q=` → 结果列表（章节名+摘要），点击 `display(href)` 跳转并 toast。
- 选中文本弹出小工具条（复制 / 高亮）：高亮用 `rendition.annotations.highlight(cfiRange...)`，仅当次会话保留即可（可选加分项）；复制必做。
- 错误处理：加载失败显示原因 + 重试按钮；`status=converting` 时轮询 `GET /api/books/:id` 直到 ready 再加载。

### 8.5 PDF 阅读器
- pdf.js 单页画布渲染（`getDocument({url, rangeChunkSize:65536})`），顶部工具栏：返回、页码输入 `/ 总页数`、上一页/下一页、缩放 −/+/适应宽度/实际大小、目录（`getOutline`）、全屏、主题跟随。
- 进度：currentPage/total 存 `/progress`；打开时恢复页码。键盘 ←/→、PageUp/Down、Ctrl+滚轮缩放。
- 滚轮连续翻页；渲染用 devicePixelRatio 提高清晰度；深色主题下画布加滤镜（invert+hue-rotate）或提供「夜间滤镜」开关。

### 8.6 视觉规范（务必遵守，整体要「像成品」）
- 中文界面；字体栈：`-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif`；标题可用 `"Songti SC","SimSun",serif` 点缀。
- 设计 token（CSS 变量，html[data-theme] 切换）：
  - light：bg `#f5f2ec`、surface `#fffdf8`、text `#25221d`、muted `#797165`、border `#e6dfd2`、accent `#2f6f64`、accentHover `#255a51`、accent2 `#b96a45`、shadow `0 10px 30px rgba(60,45,25,.10)`
  - sepia：bg `#efe4d2`、surface `#f9f1e3`、text `#3a2f22`、muted `#8a7a63`、border `#e0d0b5`、accent `#8a5a34`
  - dark：bg `#121416`、surface `#1b1e21`、text `#e9e4dc`、muted `#9b958b`、border `#2b3034`、accent `#63b3a3`
- 圆角 8/12/16；过渡 160–220ms ease；hover 轻抬起；书架背景可加极淡径向渐变纸感。
- 响应式：≥1200 六列、900 四列、600 三列、手机两列；窄屏抽屉全屏化。
- 动效适度：阅读器加载淡入、抽屉滑入、toast 底部居中；无花哨动画。
- 所有图标用内联 SVG（stroke=currentColor），不要 emoji 充当图标。

## 9. 验收标准（Lead 用 Playwright + API 测试）

1. `node server/server.js` 启动无异常，`GET /api/health`、`/api/state` 正常。
2. 添加 `test/` 目录为书库后，EPUB/MOBI/PDF/DOCX/TXT/HTML/FB2 全部出现在书架（DOC 由 DOCX 经 LibreOffice 转出后测）。
3. 打开每一本：EPUB 能翻页且进度保存；MOBI 经转换后正常阅读；DOCX 正文+图片正常；TXT 中文章节生成；PDF 能翻页缩放；刷新后恢复到上次位置。
4. 书架搜索/排序/筛选/添加文件夹/目录浏览可用；`?open=` 直接打开可用。
5. 无控制台报错；首屏 < 3s；截图视觉检查通过（书架 + EPUB 阅读器 + PDF 阅读器，light/dark 至少各一张）。
6. 三套主题、字号/字体/行距/版心即时生效并持久化。

## 10. 协作

- 任务板任务 id 由 Lead 指派，完成后 `team_task_update` complete 并给 Lead 发消息（含改动文件清单、自测命令与结果、遗留问题）。
- 遇到接口歧义先按本文件实现并在消息里说明，不要擅自扩大范围；不要动别人的文件；不要提交 npm install。
- 测试数据：`test/sample.epub`（英文小说）、`test/sample.mobi`、`test/sample.pdf`、`test/sample.docx`。
- 时间有限，优先「能跑通的主流程」> 锦上添花；每完成一个可用阶段就给 Lead 发一条简短进度。
