/**
 * tests/bilingual-foundation.test.mjs —— 文案底座 #54 契约门禁（承接 #52 + #53 + #57）。
 *
 * 只断言外部行为（#57 Testing Decisions 好测试口径）：
 * 渲染出的双语块中英同显、英文在前、语言属性正确、窄处竖排；
 * 同一快照同一句话；按码分支；变量与自由文本不译；词元不动；改文案不换 key。
 * 主接缝唯一：集中字典 + 双语语义块（src/bilingual.ts），entry 为首条打通的调用链。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BILINGUAL_CSS,
  BILINGUAL_DICT_VERSION,
  BILINGUAL_STRINGS,
  bilingualHTML,
  bilingualText,
  draftKeys,
} from '../dist/bilingual.js'
import { entryBilingualHTMLFor, entryBilingualKeyFor, entryBilingualTextFor, entryLabelFor, entryStateKind, mountUpdateEntry } from '../dist/entry.js'

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

function fakeContainer() {
  const listeners = new Map()
  return {
    innerHTML: '',
    addEventListener(type, fn) {
      const l = listeners.get(type) ?? []
      l.push(fn)
      listeners.set(type, l)
    },
    removeEventListener() {},
  }
}

// ---------- 类型锁死：首批 7 键齐全，版本钉死 ----------

test('字典钉住版本且首批 7 键齐全（缺键即实现未完成）', () => {
  assert.equal(BILINGUAL_DICT_VERSION, '2026-10-06-pin53')
  const keys = Object.keys(BILINGUAL_STRINGS).sort()
  assert.deepEqual(keys, [
    'entry.action.checking',
    'entry.label.busy',
    'entry.label.failed',
    'entry.label.has-update',
    'entry.label.idle',
    'entry.label.restart',
    'entry.note.up-to-date',
  ])
  for (const k of keys) {
    const e = BILINGUAL_STRINGS[k]
    assert.equal(typeof e.en, 'string', k + ' 有英文')
    assert.equal(typeof e.zh, 'string', k + ' 有中文')
    assert.ok(e.en.trim() && e.zh.trim(), k + ' 中英皆非空')
    assert.equal(typeof e.draft, 'boolean', k + ' draft 诚实标记')
  }
})

test('draft 诚实态：首批全 draft，门禁读 draftKeys()（#54 不卡 draft，#56 才零 draft 放行）', () => {
  assert.equal(draftKeys().length, 7)
  assert.ok(draftKeys().includes('entry.label.idle'))
})

// ---------- 语义块契约：英文前中文后、空白分隔、lang 齐全 ----------

test('语义块英文在前中文在后，带 lang，空白分隔', () => {
  const html = bilingualHTML('entry.label.idle')
  assert.match(html, /^<span class="dsh-upd-bi"><span lang="en">Check for updates<\/span> <span lang="zh">检查更新<\/span><\/span>$/)
  const enAt = html.indexOf('lang="en"')
  const zhAt = html.indexOf('lang="zh"')
  assert.ok(enAt >= 0 && zhAt > enAt, '英文在前')
  assert.ok(html.includes('</span> <span'), '空白分隔')
})

test('窄处竖排：CSS 在 360px 以下切 column（只管排版，不管字重字号）', () => {
  assert.match(BILINGUAL_CSS, /\.dsh-upd-bi\{display:inline-flex/)
  assert.match(BILINGUAL_CSS, /@media \(max-width:360px\)\{\.dsh-upd-bi\{flex-direction:column/)
})

test('纯文本版同内容（title/aria 用）：英文在前空格分隔', () => {
  assert.equal(bilingualText('entry.label.idle'), 'Check for updates 检查更新')
})

// ---------- 变量不译：同一值两 span 各出现一次 ----------

test('占位按名填充：version 在中英各出现一次，原样不译', () => {
  const html = bilingualHTML('entry.label.has-update', { version: '1.2.3-beta' })
  assert.match(html, /<span lang="en">Update available 1\.2\.3-beta<\/span>/)
  assert.match(html, /<span lang="zh">有新版 1\.2\.3-beta<\/span>/)
  // 同一值出现两次（数据层不拼串，表现层两 span 各装一次）
  assert.equal(html.split('1.2.3-beta').length - 1, 2)
})

test('缺值不漏 {name} 到 UI', () => {
  const html = bilingualHTML('entry.label.has-update', {})
  assert.ok(!html.includes('{version}'), '缺值填空，不漏占位符')
})

test('转义：值与文案的尖括号不破 HTML', () => {
  const html = bilingualHTML('entry.label.has-update', { version: '<img>' })
  assert.ok(!html.includes('<img>'), '已转义')
  assert.match(html, /&lt;img&gt;/)
})

// ---------- 一路调用链：entry 五档经字典渲染 ----------

test('entry key 映射五档齐全（分支输入与旧文案同一套：快照 + 失败码）', () => {
  const UP_TO_DATE = baseSnapshot({ latestVersion: '1.0.0', canInstall: false })
  assert.equal(entryBilingualKeyFor(null), 'entry.label.idle')
  assert.equal(entryBilingualKeyFor({ snapshot: UP_TO_DATE, error: null }), 'entry.label.idle')
  assert.equal(entryBilingualKeyFor({ snapshot: baseSnapshot(), error: null }), 'entry.label.has-update')
  assert.equal(
    entryBilingualKeyFor({ snapshot: baseSnapshot({ job: { state: 'installing' } }), error: null }),
    'entry.label.busy',
  )
  assert.equal(
    entryBilingualKeyFor({ snapshot: baseSnapshot({ blockedReason: 'pending-restart' }), error: null }),
    'entry.label.restart',
  )
  assert.equal(entryBilingualKeyFor({ snapshot: null, error: 'check-failed' }), 'entry.label.failed')
})

test('新旧映射一致：同一快照旧中文与新 key 同档（未引入新分支）', () => {
  const cases = [
    [null, '检查更新', 'entry.label.idle'],
    [{ snapshot: baseSnapshot(), error: null }, '有新版 1.1.0', 'entry.label.has-update'],
    [{ snapshot: baseSnapshot({ job: { state: 'installing' } }), error: null }, '正在安装…', 'entry.label.busy'],
  ]
  for (const [state, zh, key] of cases) {
    assert.equal(entryLabelFor(state), zh)
    assert.equal(entryBilingualKeyFor(state), key)
    // 同一快照同一句话：HTML 里必含旧中文（兼容既有断言口径）
    assert.match(entryBilingualHTMLFor(state), new RegExp(zh.replace(/…/g, '…')))
  }
})

test('分支仍只认稳定码：同一快照换文案不换档（改文案不换 key 的反面）', () => {
  const s = { snapshot: baseSnapshot(), error: null }
  const before = entryStateKind(s)
  // 文案是渲染结果，不参与分支：kind 只由快照/码算出
  assert.equal(before, 'update')
  assert.equal(entryBilingualKeyFor(s), 'entry.label.has-update')
  assert.equal(entryBilingualTextFor(s), 'Update available 1.1.0 有新版 1.1.0')
})

test('挂载即走字典：按钮 innerHTML 为语义块，label() 仍回旧中文（兼容接入方）', async () => {
  const box = fakeContainer()
  const entry = mountUpdateEntry(
    box,
    {
      pluginId: 'p',
      prefix: 'p',
      call: async (name) => {
        if (name.endsWith('.updateStatus')) return { ok: true, snapshot: baseSnapshot(), manual: null, receipt: null, queue: null }
        throw new Error('unknown-phone:' + name)
      },
      autoCheck: 'never',
      pollMs: 60000,
    },
  )
  await new Promise((r) => setTimeout(r, 10))
  await entry.refresh()
  assert.match(box.innerHTML, /<span class="dsh-upd-bi"><span lang="en">Update available/)
  assert.match(box.innerHTML, /<span lang="zh">有新版 1\.1\.0<\/span>/)
  assert.match(box.innerHTML, /dsh-upd-bi/)
  assert.equal(entry.label(), '有新版 1.1.0')
  entry.unmount()
})

// ---------- 不制造双源：changelog 标题仍唯一源于 CATEGORY_ZH ----------

test('不为 changelog 另立第二映射：底座无 changelog key', () => {
  assert.ok(!Object.keys(BILINGUAL_STRINGS).some((k) => k.startsWith('changelog.')), '分类表唯一源仍在 changelog.ts')
})
