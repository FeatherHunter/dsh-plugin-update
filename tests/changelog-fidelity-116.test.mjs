/**
 * tests/changelog-fidelity-116.test.mjs —— 更新日志保真轮（map #128 / 实施票 #130 / 验收票 #131）。
 *
 * 保真的定义（先定口径再定实现，wiki 式「不丢内容」）：
 *   1. 作者写下的**内容行**必须出现在渲染结果里，唯一允许的消失是**已声明**的（孤儿条目 / 超限截断 / 64K 切断）；
 *   2. 不能凭空造出源文件里没有的版本节（幻影版本 = 0）；
 *   3. 认不出的块不渲染成花活，但也不许消失 —— 按原文落到兜底段落。
 *
 * 只测外部行为：公开纯函数的输入输出。语料形态来自野外取样
 * （docs/research/20261014-changelog-markdown-constructs.md：changesets / semantic-release / jimp 三类模板）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  parseChangelog,
  parseChangelogReport,
  renderChangelogHTML,
  renderChangelogBlocks,
  renderChangelogItem,
  renderChangelogSection,
  truncationNoteHTML,
  validateChangelog,
  CHANGELOG_CATEGORY_ALIASES,
  CHANGELOG_MAX_ENTRIES,
} = await import('../dist/changelog.js')

/** 可见文本：去标签、还原实体，用来判「这一行到底有没有出现在读者眼前」。 */
function visibleText(html) {
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 内容行签名：取该行最长的字母数字连续段（≥4 字符）。Markdown 标记是标点，自动出局。 */
function signatures(line) {
  const runs = String(line).match(/[\p{L}\p{N}]{4,}/gu) || []
  if (runs.length === 0) return []
  return [runs.slice().sort((a, b) => b.length - a.length)[0]]
}

// ---------- 1. 未知小节名：内容不再因为名字不认识而消失 ----------

const UNKNOWN_SECTIONS = `# Changelog

## [1.2.0] - 2026-01-02

### Patch Changes

- 作者自定义小节的条目甲

- 第二条乙

### Features

- 别名走的条目丙
`

test('未知小节名：按作者原文标题原样保留（otherSections），内容一条不丢', () => {
  const [e] = parseChangelog(UNKNOWN_SECTIONS)
  assert.equal(e.version, '1.2.0')
  const other = e.otherSections || []
  assert.ok(other.length >= 1, 'otherSections 至少一节')
  const titles = other.map((s) => s.title)
  assert.ok(titles.includes('Patch Changes'), '作者标题原样保留：' + titles.join(' | '))
  const flat = other.flatMap((s) => s.items).join('\n')
  assert.match(flat, /条目甲/)
  assert.match(flat, /第二条乙/)
})

test('未知小节名：渲染时用原文标题 + data-cat="other"，不是折叠也不是丢弃', () => {
  const [e] = parseChangelog(UNKNOWN_SECTIONS)
  const html = renderChangelogSection(e)
  assert.match(html, /Patch Changes/)
  assert.match(html, /data-cat="other"/)
  assert.match(visibleText(html), /条目甲/)
})

// ---------- 2. 别名归一到六类 ----------

test('别名表：Bug Fixes / 修复 → Fixed，Features / feat / 新增 → Added，并列写法也认', () => {
  assert.equal(CHANGELOG_CATEGORY_ALIASES['bug fixes'], 'Fixed')
  assert.equal(CHANGELOG_CATEGORY_ALIASES['修复'], 'Fixed')
  assert.equal(CHANGELOG_CATEGORY_ALIASES['features'], 'Added')
  assert.equal(CHANGELOG_CATEGORY_ALIASES['feat'], 'Added')
  assert.equal(CHANGELOG_CATEGORY_ALIASES['新增'], 'Added')
  const md = [
    '# Changelog',
    '',
    '## [2.0.0] - 2026-02-02',
    '',
    '### Bug Fixes',
    '',
    '- 修好了一个真缺陷',
    '',
    '### Fixed / 修复',
    '',
    '- 并列写法也进 Fixed',
    '',
    '### Features',
    '',
    '- 新能力进来了',
    '',
  ].join('\n')
  const [e] = parseChangelog(md)
  assert.equal(e.sections.Fixed.length, 2, '两条都进 Fixed：' + JSON.stringify(e.sections.Fixed))
  assert.equal(e.sections.Added.length, 1)
  assert.equal((e.otherSections || []).length, 0, '别名命中的不该再落 otherSections')
})

test('含混名（Patch Changes / Chores / Documentation）故意不收，走自定义小节而不是猜', () => {
  assert.equal(CHANGELOG_CATEGORY_ALIASES['patch changes'], undefined)
  assert.equal(CHANGELOG_CATEGORY_ALIASES['chores'], undefined)
  assert.equal(CHANGELOG_CATEGORY_ALIASES['documentation'], undefined)
})

// ---------- 3. 版本节下没有小节标题的裸条目 ----------

test('版本节下没有 `###` 的裸条目：收进隐式小节（title 空），不整节丢', () => {
  const md = [
    '## v1.1.0 — 2026-01-01',
    '',
    '- 裸条目一',
    '- 裸条目二',
    '',
  ].join('\n')
  const [e] = parseChangelog(md)
  assert.equal(e.version, '1.1.0')
  const other = e.otherSections || []
  assert.equal(other.length, 1)
  assert.equal(other[0].title, '')
  assert.equal(other[0].items.length, 2)
})

// ---------- 4. 版本标题放宽：H1/H4/两段号/前缀 v ----------

test('版本标题：H1、H4、`## v1.0.0 — 日期`、两段 `## 1.0` 都认', () => {
  const cases = [
    ['# 3.0.0', '3.0.0'],
    ['#### v3.1.0', '3.1.0'],
    ['## v3.2.0 — 2026-03-03', '3.2.0'],
    ['## 1.0', '1.0'],
  ]
  for (const [heading, version] of cases) {
    const md = [heading, '', '- 有些事发生了', ''].join('\n')
    const [e] = parseChangelog(md)
    assert.ok(e, heading + ' 应当收成一个版本节')
    assert.equal(e.version, version, heading)
  }
})

test('取不出号的版本样标题（`## 1`）不造节，validate 报 E_VERSION_TITLE', () => {
  const md = ['## 1', '', '- 这条没有归属', ''].join('\n')
  assert.equal(parseChangelog(md).length, 0)
  const v = validateChangelog(md)
  assert.equal(v.ok, false)
  assert.ok(v.diagnostics.some((d) => d.code === 'E_VERSION_TITLE'))
})

// ---------- 5. setext 下划线标题 ----------

test('setext 标题：`0.16.0` + `===` 与 `1.0.0` + `---` 都当版本标题', () => {
  const md = [
    '0.16.0',
    '======',
    '',
    '### Added',
    '',
    '- setext 形态的条目',
    '',
    '1.0.0',
    '-----',
    '',
    '### Fixed',
    '',
    '- 下划线形态的条目',
    '',
  ].join('\n')
  const entries = parseChangelog(md)
  assert.equal(entries.length, 2, '两个 setext 版本节：' + JSON.stringify(entries.map((e) => e.version)))
  assert.deepEqual(entries.map((e) => e.version), ['0.16.0', '1.0.0'])
})

test('setext 不误判：列表项后的 `---` 是分隔线，不是把它变成标题', () => {
  const md = [
    '## [1.0.0] - 2026-01-01',
    '',
    '### Added',
    '',
    '- 条目一',
    '---',
    '',
  ].join('\n')
  const [e] = parseChangelog(md)
  assert.equal(e.version, '1.0.0')
  assert.equal(e.sections.Added.length, 1)
})

// ---------- 6. 顶格块与未识别块：兜底段落，不消失 ----------

test('顶格段落 / 顶格围栏 / 顶格引用都进条目，并渲染成块级标签', () => {
  const md = [
    '## [1.0.0] - 2026-01-01',
    '',
    '### Added',
    '',
    '- 条目先来',
    '',
    '顶格的一段说明文字',
    '',
    '```sh',
    'npm i dsh-plugin-update',
    '```',
    '',
    '> 顶格引用一句',
    '',
  ].join('\n')
  const [e] = parseChangelog(md)
  const html = renderChangelogSection(e)
  const text = visibleText(html)
  assert.match(text, /顶格的一段说明文字/)
  assert.match(text, /npm i dsh-plugin-update/)
  assert.match(text, /顶格引用一句/)
  assert.match(html, /<pre class="dsh-upd-md-pre"><code class="dsh-upd-md-precode">/)
  assert.match(html, /<blockquote class="dsh-upd-md-quote">/)
})

test('认不出的块（HTML 注释 / details / 表格行）原文落到兜底段落，不静默消失', () => {
  const md = [
    '## [1.0.0] - 2026-01-01',
    '',
    '### Added',
    '',
    '- 条目先来',
    '',
    '<!-- 这段备注不想丢 -->',
    '',
    '<details><summary>折叠说明</summary>里面的内容</details>',
    '',
    '| 列一 | 列二 |',
    '| --- | --- |',
    '',
  ].join('\n')
  const [e] = parseChangelog(md)
  const text = visibleText(renderChangelogSection(e))
  assert.match(text, /这段备注不想丢/)
  assert.match(text, /折叠说明/)
  assert.match(text, /列一/)
})

test('分隔线 `---` 渲染成 <hr>，不以字面三个短横混在正文里', () => {
  const html = renderChangelogBlocks(['- 条目一', '---', '- 条目二'])
  assert.match(html, /<hr class="dsh-upd-md-hr">/)
  assert.match(html, /条目一/)
  assert.match(html, /条目二/)
})

test('围栏之后的尾注落进兜底段落 div：认不出的块不消失，也不硬塞进上一项', () => {
  const html = renderChangelogBlocks(['- 条目一', '```sh', 'npm i dsh-plugin-update', '```', '尾注一段'])
  assert.match(html, /<pre class="dsh-upd-md-pre"><code class="dsh-upd-md-precode">/)
  assert.match(html, /<div class="dsh-upd-md-para">尾注一段<\/div>/)
})

// ---------- 7. 截断必须明说 ----------

test('超 64K：账本记下 chars 与残余版本数，面板头上出截断说明（中文、无拉丁字母）', () => {
  const head = ['## [1.0.0] - 2026-01-01', '', '### Added', '', '- 前面的条目', ''].join('\n')
  const filler = 'x'.repeat(64 * 1024)
  const tail = ['', '## [0.9.0] - 2025-01-01', '', '### Added', '', '- 被切掉的条目', ''].join('\n')
  const rep = parseChangelogReport(head + filler + tail)
  assert.equal(rep.truncation.chars, true)
  assert.ok(rep.truncation.tailVersions >= 1, '切点之后还有版本标题，要记账')
  const note = truncationNoteHTML(rep.truncation)
  assert.match(note, /dsh-upd-changelog-truncnote/)
  const zh = visibleText(note)
  assert.ok(!/[A-Za-z]/.test(zh), '中文文案里不该夹拉丁字母：' + zh)
  const html = renderChangelogHTML(rep.entries, { truncated: rep.truncation })
  assert.match(html, /dsh-upd-changelog-truncnote/)
})

test('超 100 个版本节：账本记 entries，提示里带上限与总数', () => {
  const md = Array.from({ length: CHANGELOG_MAX_ENTRIES + 3 }, (_, i) => {
    return ['## [1.0.' + (CHANGELOG_MAX_ENTRIES + 3 - i) + '] - 2026-01-01', '', '### Added', '', '- 条目 ' + i, ''].join('\n')
  }).join('\n')
  const rep = parseChangelogReport(md)
  assert.equal(rep.truncation.entries, 3)
  assert.match(visibleText(truncationNoteHTML(rep.truncation)), /1[0-9][0-9]/)
})

// ---------- 8. 两条不变式（保真的可测量定义） ----------

const MIXED = `# Changelog

关于本文件的说明段落不该进任何版本节。

## [1.2.0] - 2026-01-02

### Added

- 新增了 alpha 能力，详见 https://example.com/alpha

### Patch Changes

- 自定义小节的条目 beta
- 第二条 gamma

## v1.1.0 — 2026-01-01

- 裸条目 delta

### Bug Fixes

- 修好了 epsilon 缺陷

1.0.0
=====

### Fixed

- 最早的一条 zeta
`

test('不变式一（无未声明丢失）：每个版本节里的内容行签名都出现在渲染结果里', () => {
  const md = MIXED
  const entries = parseChangelog(md)
  const html = renderChangelogHTML(entries)
  const text = visibleText(html)
  const skip = /^\s*$|^\s{0,3}#{1,6}\s|^\s*(?:={3,}|-{3,})\s*$/
  const all = md.split('\n')
  // 文件抬头（第一个**版本**标题之前，含 `# Changelog` 这类文件题）属于文件级前言，
  // 不属于任何版本节：按口径不计入「版本节内容行」。
  const firstHeading = all.findIndex((l, i) => {
    const m = l.match(/^\s{0,3}#{1,6}\s*(.+?)\s*$/)
    if (m && /\d+\.\d+|unreleased/i.test(m[1])) return true
    return /^\s*(?:={3,}|-{3,})\s*$/.test(all[i + 1] || '') && /^\s*\d+\.\d+/.test(l)
  })
  const lost = []
  for (let i = 0; i < all.length; i++) {
    const line = all[i]
    if (i < firstHeading) continue
    if (skip.test(line)) continue
    for (const s of signatures(line)) {
      if (!text.includes(s)) lost.push({ line: line.trim(), sig: s })
    }
  }
  assert.deepEqual(lost, [], '这些内容行的签名没出现在渲染结果里（未声明的丢失）')
})

test('不变式二（幻影版本 = 0）：每个渲染出的版本节都能在源文件里找到版本号 token', () => {
  const entries = parseChangelog(MIXED)
  assert.ok(entries.length >= 3, '应当解析出多个版本节')
  for (const e of entries) {
    assert.ok(String(MIXED).includes(e.version), '源文件里找不到这个版本号：' + e.version)
  }
})

test('被声明丢弃的孤儿条目：内容不进渲染，但 validate 必须报 E_BULLET_ORPHAN', () => {
  const md = [
    '# Changelog',
    '',
    '- 这条在版本节之外，谁也不知道它属于哪个版本',
    '',
    '## [1.0.0] - 2026-01-01',
    '',
    '### Added',
    '',
    '- 正常条目',
    '',
  ].join('\n')
  const v = validateChangelog(md)
  assert.ok(v.diagnostics.some((d) => d.code === 'E_BULLET_ORPHAN' && d.line === 3), JSON.stringify(v.diagnostics))
  const html = renderChangelogHTML(parseChangelog(md))
  assert.ok(!visibleText(html).includes('谁也不知道'), '孤儿条目不该被塞进某个版本节')
  assert.match(visibleText(html), /正常条目/)
})

test('负例语料：`# Changelog`／`# 更新日志`／`# <插件名>` 不得成为版本节（幻影的另一面）', () => {
  for (const title of ['# Changelog', '# 更新日志', '# dsh-prompt']) {
    const md = [title, '', '格式为 Keep-a-Changelog 子集：Added/Fixed/Changed 必写。', ''].join('\n')
    assert.equal(parseChangelog(md).length, 0, title + ' 不该成为版本节')
  }
})

// ---------- 9. 行号与转义 ----------

test('setext 转换不挪行号：诊断行号仍是原文件里的行号', () => {
  const md = [
    '1.2.0',
    '=====',
    '',
    '## 1',
    '',
    '- 这条没有归属，在第六行',
    '',
  ].join('\n')
  const v = validateChangelog(md)
  const bad = v.diagnostics.find((d) => d.code === 'E_VERSION_TITLE')
  const orphan = v.diagnostics.find((d) => d.code === 'E_BULLET_ORPHAN')
  assert.ok(bad, JSON.stringify(v.diagnostics))
  assert.ok(orphan, JSON.stringify(v.diagnostics))
  assert.equal(bad.line, 4)
  assert.equal(orphan.line, 6)
})

test('保真不等于放行 HTML：兜底段落里的标签照样被转义', () => {
  const html = renderChangelogBlocks(['<script>alert(1)</script>'])
  assert.ok(!html.includes('<script>'), '原始 <script> 不得直通')
  assert.match(html, /&lt;script&gt;/)
})

test('条目渲染入口对未知分类/空输入不抛错', () => {
  assert.equal(typeof renderChangelogItem(''), 'string')
  assert.equal(typeof renderChangelogItem('- 一条', 'zh', 'Nope'), 'string')
  assert.equal(typeof renderChangelogBlocks([]), 'string')
})
