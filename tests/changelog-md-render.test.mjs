/**
 * tests/changelog-md-render.test.mjs —— 更新日志行内 Markdown 渲染（map #109 / 落地票 #115）。
 *
 * 只测外部行为：公开纯函数的输入输出、面板 HTML 里的接线、两套 CSS 的存在性、点击落地两条路径。
 * 口径来自野外取样（docs/research/20261014-changelog-markdown-constructs.md 与 ...-sample.md）：
 * 行内代码 / 粗体 / 链接 / 裸 URL 是主力，图片只出占位，HTML 永不直通。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const tick = () => new Promise((r) => setTimeout(r, 10))

const {
  parseChangelog,
  renderChangelogInline,
  renderChangelogBlocks,
  renderChangelogItem,
  renderChangelogSection,
  renderChangelogHTML,
  CHANGELOG_MD_INLINE,
} = await import('../dist/changelog.js')
const { renderUpdatePanelHTML, mountUpdatePanel, UPDATE_PANEL_CSS, UPDATE_PANEL_ARCHIVE_CSS } = await import('../dist/panel.js')

const LINK_ATTRS = /data-openlink="1" href="([^"]*)" target="_blank" rel="noopener noreferrer"/

// ---------- 1. 行内构造 ----------

test('行内构造：代码/粗体/斜体/删除线/链接/autolink/裸 URL 全部渲染成标签', () => {
  const html = renderChangelogInline(
    '见 `src/panel.ts:2776-2788`、**粗体**、*斜体*、~~旧说法~~、[PR](https://github.com/a/b/pull/1)、<https://x.example/y>、https://z.example/w。',
  )
  assert.ok(html.includes('<code class="dsh-upd-md-code">src/panel.ts:2776-2788</code>'), '行内代码')
  assert.ok(html.includes('<strong>粗体</strong>'), '粗体')
  assert.ok(html.includes('<em>斜体</em>'), '斜体')
  assert.ok(html.includes('<del class="dsh-upd-md-del">旧说法</del>'), '删除线')
  assert.ok(LINK_ATTRS.test(html), '链接带 data-openlink/target/rel')
  assert.ok(html.includes('href="https://github.com/a/b/pull/1"'), '显式链接目标')
  assert.ok(html.includes('href="https://x.example/y"'), 'autolink 目标')
  assert.ok(html.includes('href="https://z.example/w"'), '裸 URL 目标')
  assert.ok(!html.includes('https://z.example/w。'), '裸 URL 不吃紧贴的中文句号')
  assert.ok(!html.includes('**') && !html.includes('`src'), '原语法不该残留')
  assert.equal(CHANGELOG_MD_INLINE.length > 0, true, '支持面常量表在')
})

test('下划线不在词中生效：snake_case / 版本号里的下划线不斜体', () => {
  const html = renderChangelogInline('字段 a_b_c 与 dsh-im<channel> 保持不变')
  assert.ok(!html.includes('<em>'), '词中下划线不斜体')
  assert.ok(html.includes('a_b_c'), '原文一字不动')
})

test('未闭合标记按字面输出：不猜、不吞字、不补标签', () => {
  const html = renderChangelogInline('仓内 `未闭合 与 **也没闭合')
  assert.ok(!html.includes('<code'), '未闭合反引号不成码')
  assert.ok(!html.includes('<strong>'), '未闭合粗体不成粗')
  assert.ok(html.includes('`未闭合'), '反引号按字面留着')
  assert.ok(html.includes('**也没闭合'), '星号按字面留着')
})

test('截断留下的悬空标记碎屑：配平的照渲染，悬空的剥掉', () => {
  const balanced = renderChangelogItem('这一条被截断，尾巴是 `code` 和 **强调**…')
  assert.ok(balanced.includes('<code class="dsh-upd-md-code">code</code>'), '配平的反引号照渲染')
  assert.ok(balanced.includes('<strong>强调</strong>'), '配平的粗体照渲染')
  const dangling = renderChangelogItem('长条目正文 **…')
  assert.ok(!dangling.includes('**…'), '结尾的裸标记被剥掉')
  const stray = renderChangelogItem('条目 `src/pa…')
  assert.ok(!stray.includes('`src/pa'), '悬空反引号被剥掉')
})

test('HTML 永不直通：野外反例 dsh-im<channel> 与 <script> 都当文本', () => {
  const html = renderChangelogInline('<script>alert(1)</script> 与 dsh-im<channel> 与 <img src=x onerror=1>')
  assert.ok(!html.includes('<script'), '不产出 script 标签')
  assert.ok(!html.includes('<img'), '不产出 img 标签')
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), '<script> 被转义')
  assert.ok(html.includes('dsh-im&lt;channel&gt;'), '真实反例被转义')
})

test('协议白名单：只认 http/https，危险协议与相对路径按字面文本', () => {
  for (const evil of ['[点我](javascript:alert(1))', '[点我](data:text/html,x)', '[点我](file:///etc/passwd)', '[点我](./local.md)']) {
    const html = renderChangelogInline(evil)
    assert.ok(!LINK_ATTRS.test(html), `${evil} 不得产出可点锚`)
    assert.ok(!html.includes('href='), `${evil} 不得产出 href`)
  }
  const img = renderChangelogInline('![图](data:image/png;base64,AAAA)')
  assert.ok(!img.includes('data-src='), '非 http(s) 图片不出占位')
})

test('图片只出占位：不产出 <img>、不发请求、alt 为空时退回地址', () => {
  const html = renderChangelogInline('发布截图：![界面](https://example.com/a.png) 与 ![](https://example.com/b.png)')
  assert.ok(!html.includes('<img'), '永不产出 img 元素')
  assert.ok(html.includes('data-src="https://example.com/a.png"'), '占位带 data-src')
  assert.ok(html.includes('界面'), 'alt 文本可见')
  assert.ok(html.includes('>https://example.com/b.png<'), 'alt 为空退回地址')
})

test('异形输入永不抛错：null/数字/对象/超长都退化成安全文本', () => {
  for (const bad of [null, undefined, 0, 1, {}, [], true, 'x'.repeat(5000)]) {
    const html = renderChangelogInline(bad)
    assert.equal(typeof html, 'string', `${String(bad)} 应变字符串`)
    assert.ok(!html.includes('<img') && !html.includes('<script'), '退化输出里没有危险标签')
  }
  assert.equal(renderChangelogInline(''), '', '空串回空串')
  assert.equal(renderChangelogInline('   '), '   ', '纯空白原样')
})

// ---------- 2. 与解析/渲染层接线 ----------

const MD_SAMPLE = `# Changelog

## [1.1.0] - 2026-10-14

### Added
- 新功能 A：` + '`src/a.ts`' + ` 与 **重点** 见 https://example.com/a
- 新功能 B：[PR](https://github.com/a/b/pull/2) 与 ![图](https://example.com/c.png)

### Fixed
- 修 dsh-im<channel> 的转义
`

test('渲染层接线：解析形状不变，条目走行内渲染', () => {
  const entries = parseChangelog(MD_SAMPLE)
  assert.equal(entries.length, 1, '解析仍只收发行的 1.1.0 节')
  assert.equal(entries[0].version, '1.1.0')
  assert.deepEqual(entries[0].sections.Added.length, 2, 'sections 形状与条数不变（公开形状冻结）')
  assert.ok(String(entries[0].sections.Added[0]).includes('**重点**'), '解析结果保留原文 markdown（集成方读到的还是原文）')
  const html = renderChangelogHTML(entries)
  assert.ok(html.includes('<code class="dsh-upd-md-code">src/a.ts</code>'), '行内代码渲染')
  assert.ok(html.includes('<strong>重点</strong>'), '粗体渲染')
  assert.ok(LINK_ATTRS.test(html), '链接接线')
  assert.ok(html.includes('dsh-im&lt;channel&gt;'), '尖括号文本被转义')
  assert.ok(!html.includes('<img'), '图片只出占位')
})

test('破坏标记徽标与正文渲染共存（前缀加粗不打架）', () => {
  const item = renderChangelogItem('[不兼容] 移除 `oldApi`，改用 **newApi**')
  assert.ok(item.includes('dsh-upd-breaking-badge') || item.includes('<strong>'), '徽标或加粗至少其一在位')
  assert.ok(item.includes('<code class="dsh-upd-md-code">oldApi</code>'), '正文里的代码照渲染')
  assert.ok(item.includes('<strong>newApi</strong>'), '正文里的粗体照渲染')
})

test('面板 02 章：日志节里真的出现可点锚与代码样式', () => {
  const html = renderUpdatePanelHTML({
    snapshot: { runningVersion: '1.0.0', installedVersion: '1.0.0', latestVersion: '1.1.0', canInstall: true, blockedReason: null, job: null },
    manual: null,
    queue: null,
    skippedLatest: false,
    lastError: null,
    errorKind: null,
    mode: 'embedded',
    showOthers: false,
    pluginId: 'my-plugin',
    copyNotice: null,
    changelogMarkdown: MD_SAMPLE,
  })
  assert.ok(html.includes('更新说明'), '日志节仍在')
  assert.ok(html.includes('data-openlink="1"'), '面板正文里有可点锚')
  assert.ok(html.includes('dsh-upd-md-code'), '面板正文里有代码样式')
  assert.ok(!html.includes('<img'), '面板正文里没有图片请求')
})

test('三处生效：批量两处复用单插件内核（静态接线核对，测编译后行为，#162 首拆票附带）', () => {
  const batchSrc = readFileSync(new URL('../dist/panel-batch.js', import.meta.url), 'utf8')
  assert.ok(/import[\s\S]*renderUpdatePanelHTML[\s\S]*from\s+['"]\.\/panel\.js['"]/.test(batchSrc), '批量面板导入单插件内核')
  assert.ok(batchSrc.includes('renderUpdatePanelHTML({'), '批量展开行/详情弹窗都走同一内核')
})

// ---------- 2b. 块级构造（解析层返工：嵌套层次 / 围栏代码块 / 引用块） ----------

const BLOCK_MD = [
  '## [0.4.14] - 2026-10-14',
  '',
  '### Added',
  '',
  '- **Added** · 悬浮小列表重排为底栏结构',
  '  - 底栏四动作（+ 开新增弹窗、× 收面板）',
  '  - 设置入口「成功才收面板」',
  '    这一项自己的续行',
  '  - 触发器识别与留痕字段白名单',
  '- 用法示例：',
  '  ```bash',
  '  npm i x@1.0.0',
  '  ```',
  '- 注意：',
  '  > 引用块里的提醒',
  '  > 引用第二行',
  '',
].join('\n')

test('块级：嵌套子条目收进父条目，不再拉平成同级兄弟', () => {
  const entry = parseChangelog(BLOCK_MD)[0]
  assert.equal(entry.sections.Added.length, 3, '三条父条目（子条目不再各占一条）')
  assert.equal(
    entry.sections.Added[0],
    '**Added** · 悬浮小列表重排为底栏结构\n  - 底栏四动作（+ 开新增弹窗、× 收面板）\n  - 设置入口「成功才收面板」\n    这一项自己的续行\n  - 触发器识别与留痕字段白名单',
    '缩进按行保留，块级渲染才分得出层次',
  )
  assert.equal(entry.counts.Added, 3, '计数按父条目算，不因子条目虚增')
})

test('块级：渲染成嵌套列表，子项续行并进该子项', () => {
  const html = renderChangelogItem(parseChangelog(BLOCK_MD)[0].sections.Added[0])
  assert.ok(html.startsWith('<li><strong>Added</strong> · 悬浮小列表重排为底栏结构<ul class="dsh-upd-md-list">'), html)
  assert.equal((html.match(/<li>/g) || []).length, 4, '父 + 三个子')
  assert.ok(html.includes('<li>设置入口「成功才收面板」 这一项自己的续行</li>'), '子项续行并进该子项，不另起一条')
  assert.ok(html.endsWith('</ul></li>'), html)
})

test('块级：缩进围栏代码块变成 <pre><code>，去缩进、内容转义、语言标注只做识别', () => {
  const html = renderChangelogItem(parseChangelog(BLOCK_MD)[0].sections.Added[1])
  assert.ok(html.includes('<pre class="dsh-upd-md-pre"><code class="dsh-upd-md-precode">npm i x@1.0.0</code></pre>'), html)
  assert.ok(!html.includes('bash'), '语言标注不进可见文本')
  const evil = renderChangelogItem('示例：\n  ```\n  <script>alert(1)</script>\n  ```')
  assert.ok(evil.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), evil)
  assert.ok(!evil.includes('<script'), '代码块内容永不直通')
})

test('块级：缩进引用块变成 <blockquote>，多行并成一条', () => {
  const html = renderChangelogItem(parseChangelog(BLOCK_MD)[0].sections.Added[2])
  assert.ok(html.includes('<blockquote class="dsh-upd-md-quote">引用块里的提醒 引用第二行</blockquote>'), html)
})

test('块级：顶格围栏 / 顶格引用收进条目的独立块（0.16.0 起不丢字）', () => {
  const md = '## [1.1.0]\n\n### Added\n- A\n\n```sh\n## 注释\n```\n\n> 顶格引用\n'
  const entries = parseChangelog(md)
  assert.equal(entries.length, 1, '围栏里的 ## 没有制造第二个版本节')
  const added = entries[0].sections.Added
  assert.equal(added[0], 'A')
  assert.ok(added[1].includes('## 注释'), '围栏内容留住（此前整段静默丢）')
  assert.ok(added[2].startsWith('> 顶格引用'), '引用行按原文规范成 > 前缀')
  const html = renderChangelogHTML(entries)
  assert.ok(html.includes('<pre class="dsh-upd-md-pre"><code class="dsh-upd-md-precode">## 注释</code></pre>'), html)
  assert.ok(html.includes('<blockquote class="dsh-upd-md-quote">顶格引用</blockquote>'), html)
})

test('块级：子条目位置上的有序列表渲染成 <ol>；顶格编号行按段落收字（不丢、不当条目）', () => {
  const html = renderChangelogItem('- 步骤：\n  1. 先查版本\n  2. 再安装')
  assert.ok(html.includes('<ol class="dsh-upd-md-list-ol"><li>先查版本</li><li>再安装</li></ol>'), html)
  assert.deepEqual(
    parseChangelog('## [1.1.0]\n\n### Added\n- A\n1. 顶格编号行\n')[0].sections.Added,
    ['A\n1. 顶格编号行'],
    '顶格编号行并进当前条目正文（留字，不当新条目）',
  )
})

test('块级：结构感知截断——按行截、以 … 收尾、截断点后的行不再收，且不压成一行', () => {
  const long = 'x'.repeat(490)
  const md = `## [1.1.0]\n\n### Added\n- 开头\n  - ${long}\n  - 尾巴\n`
  const entry = parseChangelog(md)[0].sections.Added[0]
  assert.ok(entry.length <= 500, '单条总长仍守 500 字符预算')
  assert.ok(entry.endsWith('…'), '装不下就补省略号，截断看得见')
  assert.ok(!entry.includes('尾巴'), '截断点之后的行不再收')
  assert.ok(entry.includes('\n'), '多行条目不被压成一行')
  assert.ok(renderChangelogItem(entry).includes('<ul class="dsh-upd-md-list">'), '截断后仍是块级渲染')
})

test('块级：异形输入永不抛错（null/undefined/超深缩进/未闭合围栏）', () => {
  assert.equal(renderChangelogBlocks(null), '')
  assert.equal(renderChangelogBlocks(undefined), '')
  assert.equal(renderChangelogBlocks([null, undefined, '']), '')
  assert.equal(renderChangelogBlocks([0]), '<div class="dsh-upd-md-para">0</div>', '数字退化成可见文本，不抛')
  const deep = '  '.repeat(200) + '- 深'
  assert.ok(renderChangelogItem(`A\n${deep}`).includes('<li>深</li>'), '超深缩进封顶，不栈溢出')
  assert.ok(renderChangelogItem('A\n  ```\n  没收尾').includes('dsh-upd-md-pre'), '未闭合围栏吃到结尾也不抛')
})

// ---------- 2c. 档案卷类名前缀不重复（data-cat-lead） ----------

test('条目正文自己写了类名时标 data-cat-lead，档案卷皮肤就不再补前缀', () => {
  const entry = parseChangelog('## [1.2.0]\n\n### Added\n- **Added** · 悬浮小列表重排为底栏结构\n- 没写类名的条目\n- 新增 · 中文类名开头的条目\n- Addendum 不是类名开头\n')[0]
  const html = renderChangelogSection(entry)
  const lis = html.match(/<li[^>]*>/g) || []
  assert.equal(lis.length, 4)
  assert.ok(lis[0].includes('data-cat-lead="1"'), '**Added** · … 标上：' + lis[0])
  assert.ok(!lis[1].includes('data-cat-lead'), '普通条目不标：' + lis[1])
  assert.ok(lis[2].includes('data-cat-lead="1"'), '中文类名（新增 · …）也算：' + lis[2])
  assert.ok(!lis[3].includes('data-cat-lead'), 'Addendum 不算类名开头：' + lis[3])
  assert.ok(!html.includes('<li data-cat-lead="1">**'), '标记加在 li 上、正文照常渲染')
})

test('档案卷前缀选择器只作用于顶层散文条目（嵌套子列表与整块条目都不补前缀）', () => {
  assert.ok(UPDATE_PANEL_ARCHIVE_CSS.includes('.dsh-upd-changelog-cat[data-cat="Added"]>ul>li:not([data-cat-lead]):not([data-cat-block])::before'), 'Added 前缀带直接子级 + 两个 :not')
  assert.ok(UPDATE_PANEL_ARCHIVE_CSS.includes('.dsh-upd-changelog-fold[data-cat="Removed"]>ul>li:not([data-cat-lead]):not([data-cat-block])::before'), '折叠类同理')
  assert.ok(!/changelog-(cat|fold)[^{]*\bul li::before/.test(UPDATE_PANEL_ARCHIVE_CSS), '不留未加限定的 ul li::before（它会钻进嵌套子列表）')
})

test('整条是代码块/引用块时不补类名前缀（data-cat-block），正文块照常成块', () => {
  const entry = parseChangelog('## [1.3.0]\n\n### Added\n- 普通条目\n\n```sh\nnpm i x\n```\n\n> 顶格引用\n')[0]
  const html = renderChangelogSection(entry)
  const lis = html.match(/<li[^>]*>/g) || []
  assert.equal(lis.length, 3, '三条顶层条目：散文 + 代码块 + 引用块')
  assert.ok(!lis[0].includes('data-cat-block'), '散文条目不带 data-cat-block（它要前缀）：' + lis[0])
  assert.ok(lis[1].includes('data-cat-block="1"'), '代码块整条带标记：' + lis[1])
  assert.ok(lis[2].includes('data-cat-block="1"'), '引用块整条带标记：' + lis[2])
  assert.ok(html.includes('<pre class="dsh-upd-md-pre"><code class="dsh-upd-md-precode">npm i x</code></pre>'), '代码块整条成块，不再把 ``` 当正文首行')
  assert.ok(html.includes('<blockquote class="dsh-upd-md-quote">顶格引用</blockquote>'), '引用块整条成块')
  assert.ok(!html.includes('```'), '围栏标记不残留成可见文本')
})

// ---------- 3. 双主题 CSS ----------

test('双主题样式：最小可用串与档案卷皮肤都带行内 Markdown 规则', () => {
  assert.ok(UPDATE_PANEL_CSS.includes('.dsh-upd-md-code{'), '默认主题有代码样式')
  assert.ok(UPDATE_PANEL_CSS.includes('.dsh-upd-md-link{'), '默认主题有链接样式')
  assert.ok(UPDATE_PANEL_CSS.includes('.dsh-upd-md-img{'), '默认主题有图片占位样式')
  assert.ok(UPDATE_PANEL_ARCHIVE_CSS.includes('[data-theme="archive"] .dsh-upd-md-code{'), '档案卷换肤有代码样式')
  assert.ok(UPDATE_PANEL_ARCHIVE_CSS.includes('[data-theme="archive"] .dsh-upd-md-link{'), '档案卷换肤有链接样式')
  assert.ok(UPDATE_PANEL_CSS.includes('.dsh-upd-md-pre{'), '默认主题有代码块样式')
  assert.ok(UPDATE_PANEL_CSS.includes('.dsh-upd-md-precode{'), '默认主题有代码块内容样式')
  assert.ok(UPDATE_PANEL_CSS.includes('.dsh-upd-md-quote{'), '默认主题有引用块样式')
  assert.ok(UPDATE_PANEL_CSS.includes('.dsh-upd-md-list{') && UPDATE_PANEL_CSS.includes('.dsh-upd-md-list-ol{'), '默认主题有嵌套无序/有序列表样式')
  assert.ok(UPDATE_PANEL_ARCHIVE_CSS.includes('[data-theme="archive"] .dsh-upd-md-pre{'), '档案卷换肤有代码块样式')
  assert.ok(UPDATE_PANEL_ARCHIVE_CSS.includes('[data-theme="archive"] .dsh-upd-md-quote{'), '档案卷换肤有引用块样式')
  assert.ok(!UPDATE_PANEL_CSS.includes('data-theme'), '默认串仍不含主题作用域')
  for (const line of [UPDATE_PANEL_CSS, UPDATE_PANEL_ARCHIVE_CSS]) {
    assert.equal((line.match(/\{/g) || []).length, (line.match(/\}/g) || []).length, '括号须配平')
  }
})

// ---------- 4. 点击落地两条路径 ----------

function fakeContainer() {
  const listeners = new Map()
  return {
    innerHTML: '',
    addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) ?? []), fn]) },
    removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn)) },
    clickAnchor(href) {
      let prevented = false
      const target = {
        closest: (sel) => (sel.includes('a[') ? { getAttribute: (n) => (n === 'href' ? href : n === 'data-openlink' ? '1' : null) } : null),
      }
      for (const fn of [...(listeners.get('click') ?? [])]) fn({ target, preventDefault: () => { prevented = true } })
      return prevented
    },
  }
}

const CALL_OK = async () => ({
  ok: true,
  snapshot: { runningVersion: '1.0.0', installedVersion: '1.0.0', latestVersion: '1.1.0', canInstall: true, blockedReason: null, job: null },
  manual: null,
  receipt: null,
  queue: null,
})

test('点击日志链接：走 options.openLink，且不把面板导航走', async () => {
  const opened = []
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, {
    pluginId: 'p',
    prefix: 't',
    call: CALL_OK,
    pollMs: 60000,
    changelogMarkdown: MD_SAMPLE,
    openLink: (url) => { opened.push(url) },
  })
  await tick(); await tick()
  const prevented = box.clickAnchor('https://example.com/a')
  assert.equal(prevented, true, '必须 preventDefault（不导航）')
  assert.deepEqual(opened, ['https://example.com/a'], '落地收到 URL')
  panel.unmount()
})

test('点击日志链接：不传 openLink 时开新窗口（noopener,noreferrer），危险协议不动', async () => {
  const calls = []
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window')
  const prev = globalThis.window
  globalThis.window = { open: (...args) => { calls.push(args); return null } }
  try {
    const box = fakeContainer()
    const panel = mountUpdatePanel(box, { pluginId: 'p', prefix: 't', call: CALL_OK, pollMs: 60000, changelogMarkdown: MD_SAMPLE })
    await tick(); await tick()
    box.clickAnchor('https://example.com/b')
    assert.deepEqual(calls, [['https://example.com/b', '_blank', 'noopener,noreferrer']], '缺省落地是新窗口')
    box.clickAnchor('javascript:alert(1)')
    assert.equal(calls.length, 1, '危险协议不落地')
    panel.unmount()
  } finally {
    if (had) globalThis.window = prev
    else delete globalThis.window
  }
})

test('openLink 抛错只吞：不挡面板更新', async () => {
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, {
    pluginId: 'p',
    prefix: 't',
    call: CALL_OK,
    pollMs: 60000,
    changelogMarkdown: MD_SAMPLE,
    openLink: () => { throw new Error('boom') },
  })
  await tick(); await tick()
  const prevented = box.clickAnchor('https://example.com/c')
  assert.equal(prevented, true, '照样不导航')
  assert.ok(box.innerHTML.includes('安装 1.1.0') || box.innerHTML.includes('dsh-upd'), '面板还活着')
  panel.unmount()
})
