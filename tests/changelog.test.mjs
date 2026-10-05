/**
 * tests/changelog.test.mjs —— 专业版更新日志面板渲染（#23）。
 *
 * 只测外部行为：调公开纯函数与面板渲染，看解析、区间、HTML、面板门控、离线读与 tarball 取数，
 * 不测内部实现、样式像素、网络细节。传输与文件全用假件，不真联网（tarball 用内存现造）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import {
  CHANGELOG_FILENAME,
  CHANGELOG_NEUTRAL_HINT,
  changelogForUpdate,
  parseChangelog,
  renderChangelogHTML,
  selectChangelogEntries,
} from '../dist/changelog.js'
import { extractChangelogFromTar, fetchReleaseChangelogText, readInstalledChangelogText } from '../dist/changelog-io.js'
import { panelViewModel, renderUpdatePanelHTML } from '../dist/panel.js'

const SAMPLE = `# Changelog

## [Unreleased]

### Added
- 还没发的东西，不该出现在面板

## [1.1.0] - 2026-09-30

### Added
- 新功能 A
- 新功能 B

### Fixed
- 修了崩溃

### Security
- 收紧了令牌校验

## [1.0.0] - 2026-09-01

### Changed
- 改了默认行为

### Deprecated
- 旧参数即将移除

### Removed
- 删掉旧开关

### EmptyCheck

## [0.9.0] - 2026-08-01
`

function baseSnapshot(overrides = {}) {
  return {
    runningVersion: '1.0.0',
    installedVersion: '1.0.0',
    latestVersion: '1.1.0',
    canInstall: true,
    blockedReason: null,
    job: null,
    ...overrides,
  }
}

function baseInput(overrides = {}) {
  return {
    snapshot: baseSnapshot(),
    manual: null,
    queue: null,
    skippedLatest: false,
    lastError: null,
    errorKind: null,
    mode: 'embedded',
    showOthers: false,
    pluginId: 'my-plugin',
    copyNotice: null,
    ...overrides,
  }
}

// ---------- 解析器：纯函数、零依赖 ----------

test('解析：Added/Fixed/Changed/Security 进必显（#41 终裁），Deprecated/Removed 进折叠类', () => {
  const entries = parseChangelog(SAMPLE)
  const v110 = entries.find((e) => e.version === '1.1.0')
  assert.ok(v110, '应解析出 1.1.0')
  assert.deepEqual(v110.sections.Added, ['新功能 A', '新功能 B'])
  assert.deepEqual(v110.sections.Fixed, ['修了崩溃'])
  assert.deepEqual(v110.sections.Security, ['收紧了令牌校验'])
  const v100 = entries.find((e) => e.version === '1.0.0')
  assert.ok(v100)
  assert.deepEqual(v100.sections.Changed, ['改了默认行为'])
  assert.deepEqual(v100.sections.Deprecated, ['旧参数即将移除'])
  assert.deepEqual(v100.sections.Removed, ['删掉旧开关'])
})

test('解析：Unreleased 保留但可识别，空节版本直接丢弃', () => {
  const entries = parseChangelog(SAMPLE)
  const un = entries.find((e) => e.version === 'Unreleased')
  assert.ok(un, 'Unreleased 保留在解析结果里（渲染层再忽略）')
  // [0.9.0] 全空（无六类条目）应被丢弃
  assert.ok(!entries.some((e) => e.version === '0.9.0'), '空节版本应忽略')
  // 未知三级标题（EmptyCheck）不应建类、不应污染
  const v100 = entries.find((e) => e.version === '1.0.0')
  assert.ok(v100)
  for (const items of Object.values(v100.sections)) {
    for (const item of items) assert.ok(!/EmptyCheck/.test(item))
  }
})

test('解析：脏输入永不抛错，回 []', () => {
  assert.deepEqual(parseChangelog(null), [])
  assert.deepEqual(parseChangelog(''), [])
  assert.deepEqual(parseChangelog(42), [])
  assert.deepEqual(parseChangelog('# 只有一级标题\n没有版本节\n'), [])
  assert.deepEqual(parseChangelog('## 乱写的标题没有版本\n### Added\n- x\n'), [])
})

test('解析器零依赖：不碰 Node 专属导入', () => {
  const src = readFileSync(new URL('../src/changelog.ts', import.meta.url), 'utf8')
  assert.ok(!/from\s+['"]node:/.test(src), '纯解析器不得导入 node: 内建')
  assert.ok(!/require\s*\(/.test(src), '纯解析器不得用 require')
})

// ---------- 对抗复查回归（第一性原理重审抓到的真问题） ----------

test('对抗：无空格标题不漏收、不错挂（归因污染比漏收更坏）', () => {
  const md = '## [1.0.0] - 2026-09-01\n\n### Added\n- old\n\n##[1.1.0] - 2026-09-30\n\n### Added\n- new\n'
  const entries = parseChangelog(md)
  const v100 = entries.find((e) => e.version === '1.0.0')
  const v110 = entries.find((e) => e.version === '1.1.0')
  assert.ok(v100 && v110, '两个版本都应解析出')
  assert.deepEqual(v100.sections.Added, ['old'], '旧版节不得混入新版标题行与新条目')
  assert.deepEqual(v110.sections.Added, ['new'])
  const mdCat = '## [1.1.0]\n\n###Added\n- X\n'
  assert.deepEqual(parseChangelog(mdCat)[0]?.sections.Added, ['X'], '无空格分类标题同样收')
})

test('对抗：版本号在标题任意位置出现即收', () => {
  const md = '## Version 1.1.0 - 2026-09-30\n\n### Added\n- X\n'
  assert.equal(parseChangelog(md)[0]?.version, '1.1.0')
  const link = '## [1.1.0](https://example.com/releases/tag/v1.1.0) - 2026-09-30\n\n### Added\n- X\n'
  const e = parseChangelog(link)[0]
  assert.equal(e?.version, '1.1.0')
  assert.equal(e?.date, '2026-09-30')
})

test('对抗：顶格段落不改写条目原文，缩进换行不断裂', () => {
  const md = '## [1.1.0] - 2026-09-30\n\n### Added\n- A\n\nNote: 顶格段落不是条目的一部分\n- B\n  缩进换行是同一条\n'
  const added = parseChangelog(md)[0]?.sections.Added ?? []
  assert.deepEqual(added, ['A', 'B 缩进换行是同一条'], '顶格段落丢弃、缩进换行拼接')
  const hash = '## [1.1.0]\n\n### Added\n- A\n###\n'
  assert.deepEqual(parseChangelog(hash)[0]?.sections.Added, ['A'], '残缺标题行永不进条目')
})

test('对抗：围栏代码块里的 ## 不是标题', () => {
  const md = '## [1.1.0]\n\n### Added\n- A\n\n```sh\n## 这是安装示例里的注释\n```\n\n### Fixed\n- B\n'
  const e = parseChangelog(md)[0]
  assert.deepEqual(e?.sections.Added, ['A'])
  assert.deepEqual(e?.sections.Fixed, ['B'])
})

test('对抗：[YANKED] 只做文本提示，不做机器信号', () => {
  const md = '## [1.1.0] - 2026-09-30 [YANKED]\n\n### Added\n- A\n'
  const e = parseChangelog(md)[0]
  assert.equal(e?.version, '1.1.0')
  assert.equal(e?.yanked, true)
  const html = renderChangelogHTML(parseChangelog(md), { from: '1.0.0', to: '1.1.0' })
  assert.match(html, /已撤回/, '撤回标记须以人话可见')
  assert.match(html, /<li>A<\/li>/, '撤回节内容照常展示（仅提示，不拦截）')
})

// ---------- 区间 ----------

test('区间：只收 (from, to]，Unreleased 与非法版本忽略', () => {
  const entries = parseChangelog(SAMPLE)
  const ranged = selectChangelogEntries(entries, '1.0.0', '1.1.0')
  assert.ok(ranged.some((e) => e.version === '1.1.0'))
  assert.ok(!ranged.some((e) => e.version === '1.0.0'), '下界不含')
  assert.ok(!ranged.some((e) => e.version === 'Unreleased'), 'Unreleased 永不进区间')
  assert.deepEqual(selectChangelogEntries(entries, '1.1.0', '1.1.0'), [])
  assert.deepEqual(selectChangelogEntries(entries, '1.0.0', 'not-a-version'), [])
})

test('区间：预发布节在区间内一并收录（通道门禁由核心负责，此处只管人读完整）', () => {
  const md = '# C\n\n## [1.1.0] - 2026-09-30\n\n### Added\n- s\n\n## [1.1.0-rc.1] - 2026-09-20\n\n### Added\n- r\n\n## [1.0.0] - 2026-09-01\n\n### Added\n- o\n'
  const versions = selectChangelogEntries(parseChangelog(md), '1.0.0', '1.1.0').map((e) => e.version)
  assert.deepEqual(versions, ['1.1.0', '1.1.0-rc.1'])
})

test('区间便捷口：已是最新即空，由渲染层给中性提示', () => {
  const entries = parseChangelog(SAMPLE)
  assert.deepEqual(changelogForUpdate(entries, '1.1.0', '1.1.0'), [])
  assert.deepEqual(changelogForUpdate(entries, '1.0.0', null), [])
  const ranged = changelogForUpdate(entries, '1.0.0', '1.1.0', '1.0.0')
  assert.ok(ranged.some((e) => e.version === '1.1.0'))
})

// ---------- 渲染 ----------

test('渲染：必显展开（含 Security）、折叠进 details、Unreleased 不见（#41 终裁）', () => {
  const entries = parseChangelog(SAMPLE)
  const html110 = renderChangelogHTML(entries, { from: '1.0.0', to: '1.1.0' })
  assert.match(html110, /Added/, '必显类标题在')
  assert.match(html110, /新功能 A/, '必显条目展开')
  assert.match(html110, /Security/, 'Security 必显不丢')
  assert.match(html110, /data-cat="Security"/, 'Security 进必显集合')
  assert.ok(!html110.includes('data-cat="Security"') || !/<details[^>]*data-cat="Security"/.test(html110), 'Security 不再进折叠 details')
  assert.ok(!html110.includes('还没发的东西'), 'Unreleased 不渲染')
  const htmlAll = renderChangelogHTML(entries)
  assert.match(htmlAll, /<details/, '折叠类（Deprecated/Removed）用 details')
  assert.match(htmlAll, /data-cat="Deprecated"/, 'Deprecated 仍折叠')
  assert.match(htmlAll, /data-cat="Removed"/, 'Removed 仍折叠')
})

test('渲染：缺日志一律中性提示', () => {
  for (const bad of [null, undefined, [], '']) {
    const html = renderChangelogHTML(bad)
    assert.match(html, new RegExp(CHANGELOG_NEUTRAL_HINT), `缺日志应中性提示（收到 ${String(bad)})`)
  }
  const html = renderChangelogHTML(parseChangelog(SAMPLE), { from: '1.1.0', to: '1.1.0' })
  assert.match(html, new RegExp(CHANGELOG_NEUTRAL_HINT), '无区间内容同样中性提示')
})

test('渲染：作者文本先转义，不出活标签', () => {
  const evil = `## [1.1.0] - 2026-09-30\n\n### Added\n- <script>alert(1)</script>\n`
  const html = renderChangelogHTML(parseChangelog(evil), { from: '1.0.0', to: '1.1.0' })
  assert.ok(!html.includes('<script>'), '原文标签必须转义')
  assert.match(html, /&lt;script&gt;/, '转义后可见')
})

// ---------- 面板集成：快照不动、不挡安装 ----------

test('面板：日志节不碰安装门控与 blockedReason', () => {
  const without = panelViewModel(baseInput())
  const withLog = panelViewModel(baseInput({ changelogMarkdown: SAMPLE }))
  assert.equal(withLog.installEnabled, without.installEnabled, '缺/有日志安装门控一字不动')
  assert.equal(withLog.installLabel, without.installLabel)
  assert.deepEqual(Object.keys(baseSnapshot()).sort(), ['blockedReason', 'canInstall', 'installedVersion', 'job', 'latestVersion', 'runningVersion'].sort(), '快照恰好六字段')
})

test('面板：有远端版才画日志节；缺日志中性提示但按钮照旧', () => {
  const html = renderUpdatePanelHTML(baseInput({ changelogMarkdown: SAMPLE }))
  assert.match(html, /更新说明/, '有远端版即画日志节')
  assert.match(html, /新功能 A/, '区间内容进面板')
  const neutral = renderUpdatePanelHTML(baseInput({}))
  assert.match(neutral, new RegExp(CHANGELOG_NEUTRAL_HINT), '缺日志中性提示')
  assert.match(neutral, /安装 1\.1\.0/, '中性提示不挡安装按钮')
  const noLatest = renderUpdatePanelHTML(baseInput({ snapshot: baseSnapshot({ latestVersion: null, canInstall: false }) }))
  assert.ok(!noLatest.includes('更新说明'), '没查过远端版不画日志节、不添噪音')
})

test('面板：setChangelogMarkdown 只换日志节', async () => {
  const { mountUpdatePanel } = await import('../dist/panel.js')
  const box = { innerHTML: '', addEventListener() {}, removeEventListener() {} }
  const panel = mountUpdatePanel(box, {
    pluginId: 'my-plugin',
    prefix: 'notes',
    call: async () => ({ ok: true, snapshot: baseSnapshot(), manual: null, receipt: null, queue: null }),
    pollMs: 60000,
  })
  await new Promise((r) => setTimeout(r, 20))
  const before = box.innerHTML
  assert.match(before, new RegExp(CHANGELOG_NEUTRAL_HINT), '没传日志先中性提示')
  panel.setChangelogMarkdown(SAMPLE)
  assert.match(box.innerHTML, /新功能 A/, '换日志后重绘出内容')
  assert.match(box.innerHTML, /安装 1\.1\.0/, '换日志不碰安装按钮')
  panel.unmount()
})

// ---------- 包内文件已落地 ----------

test('包内文件：包根 CHANGELOG.md 与 files 白名单已落地', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(Array.isArray(pkg.files) && pkg.files.includes('CHANGELOG.md'), 'files 须含 CHANGELOG.md')
  assert.equal(CHANGELOG_FILENAME, 'CHANGELOG.md')
  assert.ok(existsSync(new URL('../CHANGELOG.md', import.meta.url)), '包根须有 CHANGELOG.md')
})

// ---------- 离线读 ----------

test('离线读：有文件读回，无文件/空文件回 null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'changelog-'))
  writeFileSync(join(dir, 'CHANGELOG.md'), SAMPLE, 'utf8')
  assert.equal(await readInstalledChangelogText(dir), SAMPLE)
  assert.equal(await readInstalledChangelogText(join(dir, 'no-such-dir')), null)
  const emptyDir = mkdtempSync(join(tmpdir(), 'changelog-empty-'))
  writeFileSync(join(emptyDir, 'CHANGELOG.md'), '   \n', 'utf8')
  assert.equal(await readInstalledChangelogText(emptyDir), null)
  assert.equal(await readInstalledChangelogText(null), null)
})

// ---------- tarball 取数 ----------

function tarEntry(name, data) {
  const header = Buffer.alloc(512, 0)
  Buffer.from(name, 'utf8').copy(header, 0, 0, Math.min(name.length, 100))
  const sizeOct = data.length.toString(8).padStart(11, '0') + '\0'
  Buffer.from(sizeOct, 'utf8').copy(header, 124)
  header[156] = 48 // '0' 普通文件
  Buffer.from('ustar\0', 'utf8').copy(header, 257)
  const blocks = Math.ceil(data.length / 512)
  const body = Buffer.alloc(blocks * 512, 0)
  Buffer.from(data).copy(body)
  return Buffer.concat([header, body])
}

function makeTgz(files) {
  const parts = []
  for (const [name, text] of Object.entries(files)) {
    parts.push(tarEntry(name, Buffer.from(text, 'utf8')))
  }
  parts.push(Buffer.alloc(1024, 0))
  return gzipSync(Buffer.concat(parts))
}

function tgzIntegrity(tgz) {
  return `sha512-${createHash('sha512').update(tgz).digest('base64')}`
}

function fakeTarballFetch(tgz, { ok = true, url = 'https://registry.npmjs.org/my-pkg/-/my-pkg-1.1.0.tgz' } = {}) {
  return async () => ({
    ok,
    status: ok ? 200 : 404,
    headers: { get: () => null },
    text: async () => '',
    arrayBuffer: async () => {
      const copy = Buffer.from(tgz)
      return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength)
    },
  })
}

test('tarball 取数：同名文件取回，integrity 对上才给', async () => {
  const tgz = makeTgz({ 'package/CHANGELOG.md': SAMPLE })
  const integrity = tgzIntegrity(tgz)
  const release = { tarball: 'https://registry.npmjs.org/my-pkg/-/my-pkg-1.1.0.tgz', integrity, version: '1.1.0' }
  const text = await fetchReleaseChangelogText(fakeTarballFetch(tgz), release, {
    targetPackageName: 'my-pkg',
    registryUrl: 'https://registry.npmjs.org/',
  })
  assert.equal(text, SAMPLE)
  // integrity 对不上即回落中性（回 null）
  const bad = await fetchReleaseChangelogText(fakeTarballFetch(tgz), { ...release, integrity: `sha512-${'A'.repeat(86)}==` }, {
    targetPackageName: 'my-pkg',
    registryUrl: 'https://registry.npmjs.org/',
  })
  assert.equal(bad, null)
})

test('tarball 取数：包里没同名文件/非官方源/失败一律回 null', async () => {
  const tgz = makeTgz({ 'package/README.md': 'hi' })
  const release = {
    tarball: 'https://registry.npmjs.org/my-pkg/-/my-pkg-1.1.0.tgz',
    integrity: tgzIntegrity(tgz),
    version: '1.1.0',
  }
  assert.equal(
    await fetchReleaseChangelogText(fakeTarballFetch(tgz), release, {
      targetPackageName: 'my-pkg',
      registryUrl: 'https://registry.npmjs.org/',
    }),
    null,
    '无同名文件回 null',
  )
  const tgz2 = makeTgz({ 'package/CHANGELOG.md': SAMPLE })
  const evilRelease = {
    tarball: 'https://evil.example.com/my-pkg/-/my-pkg-1.1.0.tgz',
    integrity: tgzIntegrity(tgz2),
    version: '1.1.0',
  }
  assert.equal(
    await fetchReleaseChangelogText(fakeTarballFetch(tgz2), evilRelease, {
      targetPackageName: 'my-pkg',
      registryUrl: 'https://registry.npmjs.org/',
    }),
    null,
    '非官方源回 null',
  )
  assert.equal(
    await fetchReleaseChangelogText(fakeTarballFetch(tgz2, { ok: false }), {
      tarball: 'https://registry.npmjs.org/my-pkg/-/my-pkg-1.1.0.tgz',
      integrity: tgzIntegrity(tgz2),
      version: '1.1.0',
    }),
    null,
    '取不到回 null',
  )
})

test('对抗：gzip 炸弹（小压缩包炸出超大 tar）直接回 null，不 OOM', async () => {
  const { CHANGELOG_TAR_MAX_BYTES } = await import('../dist/changelog-io.js')
  assert.ok(CHANGELOG_TAR_MAX_BYTES > 0, '解压后上限常量存在')
  // 33MB 全零：gzip 后仅数十 KB，解压后超 32MB 墙。
  const big = Buffer.alloc(33 * 1024 * 1024, 0)
  const { gzipSync } = await import('node:zlib')
  const tgz = gzipSync(big)
  assert.ok(tgz.length < 1024 * 1024, '炸弹压缩态确实很小（前提成立）')
  const { gunzipSync } = await import('node:zlib')
  const raw = gunzipSync(tgz)
  const tar = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  assert.ok(tar.length > CHANGELOG_TAR_MAX_BYTES, '解压后确实超墙（前提成立）')
  // 直接调取数口：伪造 integrity 对上的炸弹，期望取数层在解压后拦截。
  const { createHash } = await import('node:crypto')
  const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`
  const fetchBomb = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => '',
    arrayBuffer: async () => {
      const c = Buffer.from(tgz)
      return c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength)
    },
  })
  assert.equal(
    await fetchReleaseChangelogText(fetchBomb, {
      tarball: 'https://registry.npmjs.org/my-pkg/-/my-pkg-1.1.0.tgz',
      integrity,
      version: '1.1.0',
    }, { targetPackageName: 'my-pkg', registryUrl: 'https://registry.npmjs.org/' }),
    null,
    '炸弹包回 null（中性提示），不解出 GB 文本',
  )
})

test('对抗：包内文件名大小写敏感（小写变体视为缺日志，已知边界）', async () => {
  const { gunzipSync } = await import('node:zlib')
  const toTar = (tgz) => {
    const raw = gunzipSync(tgz)
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  }
  assert.equal(extractChangelogFromTar(toTar(makeTgz({ 'package/changelog.md': 'hi' }))), null, '小写变体按缺日志回 null')
  assert.equal(extractChangelogFromTar(toTar(makeTgz({ 'package/CHANGELOG.md': 'hi' }))), 'hi', '同名文件原样取回')
})

test('tar 解包：只有文本 response（无 arrayBuffer）时诚实回 null', async () => {
  const onlyText = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => 'binary?' })
  const release = {
    tarball: 'https://registry.npmjs.org/my-pkg/-/my-pkg-1.1.0.tgz',
    integrity: `sha512-${createHash('sha512').update(Buffer.from('x')).digest('base64')}`,
    version: '1.1.0',
  }
  assert.equal(await fetchReleaseChangelogText(onlyText, release), null)
  // extract 直调：空包回 null，不抛
  assert.equal(extractChangelogFromTar(new Uint8Array(0)), null)
  assert.equal(extractChangelogFromTar(new Uint8Array(512)), null)
})

test('示例界：本包 CHANGELOG 能走完解析→区间→渲染', () => {
  const md = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  const entries = parseChangelog(md)
  assert.ok(entries.length > 0, '本包日志应解析出版本节')
  const html = renderChangelogHTML(entries, { from: '0.1.2', to: '0.2.0' })
  assert.ok(!html.includes(CHANGELOG_NEUTRAL_HINT) || /更新说明|作者未提供/.test(html))
})
