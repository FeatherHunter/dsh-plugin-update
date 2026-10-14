# 野外取样：插件 CHANGELOG 到底用了哪些 Markdown 构造（#110）

- 取样时间：2026-10-14（Asia/Shanghai）
- 手段：只读递归扫描（脚本 `.tmp/sample-changelogs.mjs`），正则计数；**不改任何被扫文件、不联网**
- 扫描根：`~/.dsh/profiles`、`~/.dsh/integrations`（深度 ≤8，跳过 `.git`/`cache`/`attachments`）+ 本仓库 `CHANGELOG.md`
- 命中 CHANGELOG.md：**88** 份；其中**插件包**（路径含 `node_modules\dsh-*` 或本仓库）**8** 份，其余（第三方 npm 依赖）80 份

## 1. 插件包 CHANGELOG：构造 × 出现次数

| 构造 | 键 | 总出现次数 | 出现在几份文件 | 结论 |
| --- | --- | ---: | ---: | --- |
| `h2` | ^##\s+\S | 141 | 8/8 | 常见 |
| `h3` | ^###\s+\S | 208 | 8/8 | 常见 |
| `h4` | ^####\s+\S | 0 | 0/8 | 野外未出现 |
| `h1` | ^#\s+\S | 8 | 8/8 | 常见 |
| `bullet` | ^\s*[-*+]\s+\S | 580 | 8/8 | 常见 |
| `bulletNested` | ^\s{2,}[-*+]\s+\S | 0 | 0/8 | 野外未出现 |
| `orderedList` | ^\s*\d+\.\s+\S | 0 | 0/8 | 野外未出现 |
| `taskList` | ^\s*[-*+]\s+\[[ xX]\]\s | 0 | 0/8 | 野外未出现 |
| `bold` | \*\*[^*\n]+\*\* | 108 | 6/8 | 常见 |
| `italic` | (^|[^*\w])\*[^*\n]+\*([^*\w]|$) | 12 | 4/8 | 常见 |
| `strikethrough` | ~~[^~\n]+~~ | 0 | 0/8 | 野外未出现 |
| `inlineCode` | `[^`\n]+` | 1129 | 6/8 | 常见 |
| `fencedCode` | ^\s*(```|~~~) | 0 | 0/8 | 野外未出现 |
| `table` | ^\s*\|.*\|\s*$ | 0 | 0/8 | 野外未出现 |
| `tableAlign` | ^\s*\|?[\s:-]*-[\s|:-]*\|?\s*$ | 0 | 0/8 | 野外未出现 |
| `link` | \[[^\]\n]+\]\([^)\s]+\) | 1 | 1/8 | 罕见（≤1/3 文件） |
| `autolink` | <https?:\/\/[^>\s]+> | 0 | 0/8 | 野外未出现 |
| `bareUrl` | (^|[\s(])(https?:\/\/[^\s)]+) | 1 | 1/8 | 罕见（≤1/3 文件） |
| `image` | !\[[^\]\n]*\]\([^)\s]+\) | 0 | 0/8 | 野外未出现 |
| `refLink` | ^\[[^\]\n]+\]:\s*\S+ | 0 | 0/8 | 野外未出现 |
| `blockquote` | ^>\s*\S | 4 | 1/8 | 罕见（≤1/3 文件） |
| `hr` | ^\s*(---|\*\*\*|___)\s*$ | 0 | 0/8 | 野外未出现 |
| `rawHtmlTag` | <\/?[a-zA-Z][a-zA-Z0-9-]*(\s[^<>]*)?\/?> | 2 | 1/8 | 罕见（≤1/3 文件） |
| `htmlDetails` | <details|<summary | 0 | 0/8 | 野外未出现 |
| `htmlBr` | <br\s*\/?> | 0 | 0/8 | 野外未出现 |
| `htmlImg` | <img\s | 0 | 0/8 | 野外未出现 |
| `htmlAnchor` | <a\s[^>]*href= | 0 | 0/8 | 野外未出现 |
| `emojiShortcode` | (^|[\s(]):[a-z0-9_+-]{2,}:(\s|$|[.,)]) | 0 | 0/8 | 野外未出现 |
| `footnote` | \[\^[^\]\n]+\] | 0 | 0/8 | 野外未出现 |
| `anchorHeading` | \{#[\w-]+\}\s*$ | 0 | 0/8 | 野外未出现 |
| `definitionList` | ^:[ \t]+\S | 0 | 0/8 | 野外未出现 |
| `setextH2` | ^[^\s].*\n[-=]{2,}\s*$ | 0 | 0/8 | 野外未出现 |

## 2. 逐文件明细（插件包）

| 文件 | 行数 | 字节 | h2 | h3 | 列表项 | 表格 | 围栏 | 行内码 | 链接 | 图片 | HTML | 引用 | 分隔线 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `~\profiles\desktop\node_modules\dsh-im-companion.bak.20261011-1709\CHANGELOG.md` | 395 | 30445 | 26 | 6 | 141 | 0 | 0 | 241 | 1 | 0 | 2 | 4 | 0 |
| `~\profiles\desktop\node_modules\dsh-mattpocock-skills-deck\CHANGELOG.md` | 20 | 855 | 2 | 3 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `~\profiles\desktop\node_modules\dsh-mattpocock-skills-deck\node_modules\dsh-plugin-update\CHANGELOG.md` | 236 | 26338 | 22 | 41 | 99 | 0 | 0 | 197 | 0 | 0 | 0 | 0 | 0 |
| `~\profiles\desktop\node_modules\dsh-plugin-update\CHANGELOG.md` | 247 | 27582 | 23 | 43 | 102 | 0 | 0 | 222 | 0 | 0 | 0 | 0 | 0 |
| `~\profiles\desktop\node_modules\dsh-prompt\CHANGELOG.md` | 145 | 10285 | 22 | 30 | 37 | 0 | 0 | 54 | 0 | 0 | 0 | 0 | 0 |
| `~\profiles\web\node_modules\dsh-mattpocock-skills-deck\CHANGELOG.md` | 20 | 855 | 2 | 3 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `~\profiles\web\node_modules\dsh-plugin-update\CHANGELOG.md` | 222 | 25231 | 21 | 39 | 93 | 0 | 0 | 193 | 0 | 0 | 0 | 0 | 0 |
| `D:\dsh-plugin\dsh-plugin-update\CHANGELOG.md` | 247 | 27582 | 23 | 43 | 102 | 0 | 0 | 222 | 0 | 0 | 0 | 0 | 0 |

## 3. 第三方依赖 CHANGELOG（仅佐证，非本插件输入）

共 80 份；出现的构造键：h1, h2, h3, h4, bullet, bulletNested, bold, italic, strikethrough, inlineCode, fencedCode, tableAlign, link, autolink, bareUrl, image, refLink, blockquote, hr, rawHtmlTag, htmlImg, emojiShortcode, setextH2

## 4. 复现命令

```powershell
node .tmp/sample-changelogs.mjs   # 只读；输出本文件
```

## 5. 关键发现

1. **真实的插件更新日志是 Keep-a-Changelog 子集**：`# Changelog` 头 + `## [x.y.z] - 日期` + `### Added/Fixed/Changed/Security` + 长条目 bullet。8/8 文件都有 h2/h3/bullet，这份体例就是面板正文的全部形态。
2. **行内代码是绝对主力：1129 处**（6/8 文件），是粗体（108 处）的十倍。⇒「漂亮」的第一收益点是把 `` `...` `` 渲染成代码样式（现在反引号原样显示在面板里）。
3. 其次：粗体 108 处（6/8）、斜体 12 处（4/8）、引用块 4 行（1/8，正是本插件 changelog 顶部的体例说明）。
4. **链接几乎不出现**：8 份文件里只有 1 个 `[#100](https://github.com/…)` 和 1 个裸 URL，`<https://…>` autolink 0 处。⇒ 链接渲染是「为将来兜底」而非当前痛点（#111 的形状仍然要对，但优先级低于行内代码/粗体）。
5. **野外完全不出现的构造**：图片 0、表格 0、围栏代码 0、嵌套列表 0、有序列表 0、任务列表 0、脚注 0、emoji 短码 0、h4 0、删除线 0、分隔线 0。⇒ 这几项的取舍该按实现成本算，不该按需求紧迫度算。
6. **真实存在的危险样本**：`dsh-im-companion` 的 changelog 里有两处裸的 `dsh-im<channel>`（行内产品名）。任何把「未知 HTML 原样塞进 DOM」的渲染器都会把它当标签吃掉或破坏结构。⇒ 渲染器必须**默认全转义**，HTML 一律当文本。

## 6. 支持面建议（给 #112 定稿的输入）

- **必须渲染（有真实数据支撑）**：h2 版本行、h3 分类行、bullet、`**粗体**`、`` `行内代码` ``、一切 HTML 默认转义。
- **应当渲染（低成本、直观、为将来兜底）**：`> 引用块`、`*斜体*`/`_斜体_`、`~~删除线~~`、```围栏代码块```、`[文本](http/https)`、`<https://…>` autolink、裸 URL。
- **降级为等宽原文（不实现布局）**：表格（野外 0 例；400px 面板里做对齐表格必然难看，宁可「原样但等宽」）。
- **明确不做**：脚注、emoji 短码、定义列表、标题锚点、`<details>` 折叠（野外 0 例，成本/收益不成立）。
- **永不做**：HTML 直通（`dsh-im<channel>` 就是反例）、图片自动联网取图（见 #113）。

## 7. 局限与未覆盖

- 只扫了本机 `.dsh/profiles/*` 与 `.dsh/integrations` 下命中的 8 份插件 changelog + 本仓库 `CHANGELOG.md`；生态里没装过的插件没被覆盖，第三方作者可能用更花的语法。
- 计数用正则，不区分代码块内外；`italic`/`rawHtmlTag` 这类正则天然有误报（`dsh-im<channel>` 被计成 HTML 标签即是例证）。结论按「量级」用，不按绝对值。
- 本报告不含渲染效果判断——那是 #114 的活。
