/**
 * tests/bilingual-foundation.test.mjs —— 文案底座 v2 单语契约（#60，承接 #52 + #53 + #57 v2）。
 *
 * 只断言外部行为（#57 Testing Decisions 好测试口径）：
 * 同一份快照按 lang 单语渲染（zh 不见英文/en 不见中文，冻结词元除外），语义块仍带 lang；
 * 同一快照同一句话；按码分支；变量与自由文本不译；词元不动；改文案不换 key。
 * 主接缝：集中字典 + 按 lang 单语渲染 + 语言信号层（src/lang.ts），entry/entry-batch 为打通的两条链。
 * 语言信号一律用注入的假信号源（对象 locale 或全局桩），不依赖 jsdom。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BILINGUAL_CSS,
  BILINGUAL_DICT_VERSION,
  BILINGUAL_STRINGS,
  bilingualHTML,
  bilingualText,
  copyHTML,
  copyText,
  draftKeys,
} from '../dist/bilingual.js'
import { normalizeLangTag, resolveLang, subscribeLang, __resetLangState } from '../dist/lang.js'
import { entryBilingualHTMLFor, entryBilingualKeyFor, entryBilingualTextFor, entryLabelFor, entryStateKind, mountUpdateEntry } from '../dist/entry.js'
import { batchEntryLabelFor, batchEntryStateKind, mountUpdateBatchEntry } from '../dist/entry-batch.js'

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

/** 可注入的假语言服务（不依赖 jsdom）：getActive + subscribe，set() 即触发重绘。 */
function fakeLocale(initial = 'zh') {
  let cur = initial
  let cb = null
  return {
    get current() { return cur },
    getActive() { return cur },
    subscribe(fn) {
      cb = fn
      return () => { cb = null }
    },
    set(lang) {
      cur = lang
      if (cb) cb()
    },
  }
}

// ---------- 类型锁死：288 键齐全，版本钉死 ----------

test('字典钉住版本且 313 键齐全（entry 7 + batch-entry 6 + panel 75 + kernel 74 + diag 35 + batch 17 + batch-ledger 33 + batch-row 42 + changelog 9 + diag-fallback 15，缺键即实现未完成）', () => {
  __resetLangState()
  assert.equal(BILINGUAL_DICT_VERSION, '2026-10-06-pin53')
  const keys = Object.keys(BILINGUAL_STRINGS).sort()
  // #60 底座 13 键必须都在（既有键 en/zh/draft 不动）
  for (const k of [
    'batch-entry.action.checking',
    'batch-entry.label.busy',
    'batch-entry.label.failed',
    'batch-entry.label.idle',
    'batch-entry.label.restart',
    'batch-entry.label.update',
    'entry.action.checking',
    'entry.label.busy',
    'entry.label.failed',
    'entry.label.has-update',
    'entry.label.idle',
    'entry.label.restart',
    'entry.note.up-to-date',
  ]) assert.ok(keys.includes(k), k + ' 缺键')
  // #61 panel 75 键（§3.1 16 + §3.2 14 + §3.5 16 + §3.6 18 + §3.8 11）+ #62 kernel 74（§3.7）+ #63 diag 35（§3.3 13 + §3.4 22）+ #64 batch-ledger 33（§4.1/4.3/4.4/4.5）+ #65 batch-row 42（§4.2 13 + §4.6 15 + §4.7 14）+ #66 changelog 9 + diag-fallback 15（§6.1/§7.1）
  assert.equal(keys.length, 313)
  assert.ok(keys.includes('batch.action.resume'))
  assert.ok(keys.includes('batch.action.resume-title'))
  assert.ok(keys.includes('batch.fact.close-safe'))
  assert.ok(keys.includes('batch.setting.check-on-open'))
  assert.ok(keys.includes('batch.row.update'))
  assert.ok(keys.includes('panel.blocked.unknown-profile.title'))
  assert.ok(keys.includes('panel.failure.check-failed.title'))
  assert.ok(keys.includes('panel.seal.loading.text'))
  assert.ok(keys.includes('panel.banner.error.title'))
  assert.ok(keys.includes('panel.toast.checking'))
  assert.ok(keys.includes('panel.diag.header'))
  assert.ok(keys.includes('panel.diag.label.human'))
  assert.ok(keys.includes('panel.diag.copy.no-detail'))
  assert.ok(keys.includes('panel.diag.copy.field.plugin'))
  assert.ok(keys.includes('panel.diag.copy.block.summary'))
  // #64 panel-batch 聚合总账 33 键（§4.1/4.3/4.4/4.5，逐条见 research/52-inventory.md）
  for (const k of [
    'batch.summary.updatable', 'batch.summary.installing', 'batch.summary.pending', 'batch.summary.restart',
    'batch.summary.failed', 'batch.summary.skipped', 'batch.summary.settled', 'batch.summary.empty',
    'batch.header.title', 'batch.action.check', 'batch.action.check-title', 'batch.action.install-all',
    'batch.action.install-all-title', 'batch.action.close', 'batch.action.close-title', 'batch.banner.loading',
    'batch.hint.error', 'batch.hint.empty', 'batch.hint.installing-queueable', 'batch.hint.installing-auto',
    'batch.hint.failed', 'batch.hint.updatable', 'batch.hint.restart', 'batch.hint.pending', 'batch.hint.done',
    'batch.seal.ledger', 'batch.banner.error-title', 'batch.banner.error-action-fallback', 'batch.banner.failed-title',
    'batch.banner.failed-action', 'batch.banner.restart-title', 'batch.banner.restart-action', 'batch.banner.restart-button',
  ]) assert.ok(keys.includes(k), k + ' 缺键（#64）')
  // #65 panel-batch 行/详情/回执 42 键（§4.2 13 + §4.6 15 + §4.7 14，逐条见 research/52-inventory.md；batch.row.failed 更名为 failed-retry 避让既有 knowledge 键，batch.row.current 复用既有）
  for (const k of [
    'batch.row.queued-generic', 'batch.row.queued-n', 'batch.row.skipped', 'batch.row.wait-turn',
    'batch.row.checking', 'batch.row.cta-version', 'batch.row.cta-generic', 'batch.row.installing',
    'batch.row.done-restart', 'batch.row.done', 'batch.row.failed-retry', 'batch.row.skipped-idle',
    'batch.row.unknown',
    'batch.row-action.installing', 'batch.row-action.cancel-queue', 'batch.row-action.queue', 'batch.row-action.install-row',
    'batch.row-action.retry', 'batch.row-action.install-version', 'batch.row-action.install-generic', 'batch.row-action.unskip',
    'batch.row-action.restart', 'batch.row-action.show-detail', 'batch.row-action.hide-detail', 'batch.row-action.skip',
    'batch.row-action.copy-manual', 'batch.row-action.copy-diag', 'batch.row.error-label',
    'batch.diag.source-job', 'batch.toast.copy-fail', 'batch.toast.queue-missed', 'batch.toast.skipped',
    'batch.toast.unskipped-version', 'batch.toast.unskipped-all', 'batch.toast.cancel-unavailable', 'batch.toast.cancel-ok',
    'batch.toast.cancel-fail', 'batch.toast.copy-manual-ok', 'batch.toast.copy-diag-ok', 'batch.toast.restart-delegated',
    'batch.toast.restart-manual', 'batch.toast.restart-failed',
  ]) assert.ok(keys.includes(k), k + ' 缺键（#65）')
  // #66 changelog 运行时 9 键（§6.1，去六类）+ diag 兜底 15 键（§7.1 18 行含 3 复用电话表，逐条见 research/52-inventory.md）
  for (const k of [
    'changelog.neutral.hint', 'changelog.neutral.line', 'changelog.breaking.badge', 'changelog.breaking.aria',
    'changelog.truncated.count', 'changelog.yanked.banner', 'changelog.yanked.suffix',
    'changelog.security.summary', 'changelog.security.note',
    'diag.fallback.generic', 'diag.fallback.read-installed', 'diag.fallback.revalidate-fetch', 'diag.fallback.rate-limited',
    'diag.fallback.http-status', 'diag.fallback.invalid-release', 'diag.fallback.install-failed',
    'diag.fallback.unknown-profile', 'diag.fallback.source-install', 'diag.fallback.invalid-installation',
    'diag.fallback.installation-changed', 'diag.fallback.pending-restart', 'diag.fallback.incompatible-node',
    'diag.fallback.registry-conflict', 'diag.fallback.recovery-required',
  ]) assert.ok(keys.includes(k), k + ' 缺键（#66）')
  for (const k of keys) {
    const e = BILINGUAL_STRINGS[k]
    assert.equal(typeof e.en, 'string', k + ' 有英文')
    assert.equal(typeof e.zh, 'string', k + ' 有中文')
    assert.ok(e.en.trim() && e.zh.trim(), k + ' 中英皆非空')
    assert.equal(typeof e.draft, 'boolean', k + ' draft 诚实标记')
  }
})

test('draft 诚实态：313 键全 draft，门禁读 draftKeys()（#61/#62/#63/#64/#65/#66 新增亦全 draft，--release 仍如实红）', () => {
  assert.equal(draftKeys().length, 313)
  assert.ok(draftKeys().includes('entry.label.idle'))
  assert.ok(draftKeys().includes('batch-entry.label.update'))
})

// ---------- 信号层：口径与兜底 ----------

test('信号口径：显式 > html[lang] > navigator > zh；zh* 落 zh，其余已知落 en，无信号落 zh', () => {
  __resetLangState()
  assert.equal(normalizeLangTag('zh'), 'zh')
  assert.equal(normalizeLangTag('zh-CN'), 'zh')
  assert.equal(normalizeLangTag('zh-Hant-HK'), 'zh')
  assert.equal(normalizeLangTag('en'), 'en')
  assert.equal(normalizeLangTag('en-US'), 'en')
  assert.equal(normalizeLangTag('fr-FR'), 'en')
  assert.equal(normalizeLangTag(''), 'zh')
  assert.equal(normalizeLangTag(null), 'zh')
  // 显式覆盖赢
  assert.equal(resolveLang('en'), 'en')
  assert.equal(resolveLang('zh-CN'), 'zh')
  assert.equal(resolveLang({ getActive: () => 'en-US' }), 'en')
  // Node/无 DOM 环境不抛，落 zh（本进程无 document，navigator 无中文信号即 zh）
  assert.equal(resolveLang(), 'zh')
  assert.equal(resolveLang(undefined), 'zh')
})

test('无信号兜底 zh：Node 里渲染不抛，落 zh（冻结词元除外）', () => {
  __resetLangState()
  const html = copyHTML('entry.label.idle', undefined, {})
  assert.match(html, /lang="zh"/)
  assert.ok(!html.includes('lang="en"'))
  assert.equal(copyText('entry.label.idle', undefined), '检查更新')
})

// ---------- 单语语义块：一次只一种语言 ----------

test('单语块：zh 只含中文，en 只含英文，各带 lang，一次一种', () => {
  __resetLangState()
  const zh = copyHTML('entry.label.idle', 'zh')
  assert.match(zh, /^<span class="dsh-upd-bi"><span lang="zh">[^<]+<\/span><\/span>$/)
  assert.ok(!zh.includes('lang="en"'))
  assert.ok(!zh.includes('Check for updates'))
  const en = copyHTML('entry.label.idle', 'en')
  assert.match(en, /^<span class="dsh-upd-bi"><span lang="en">Check for updates<\/span><\/span>$/)
  assert.ok(!en.includes('lang="zh"'))
  assert.ok(!en.includes('检查更新'))
})

test('同一份快照：zh 不见字典英文，en 不见中文（冻结词元除外）', () => {
  __resetLangState()
  const vals = { version: '9.9.9', count: '7' }
  for (const k of Object.keys(BILINGUAL_STRINGS)) {
    const zh = copyHTML(k, 'zh', vals)
    const en = copyHTML(k, 'en', vals)
    // 冻结词元（#61 #63 #66）：Node / installing / verifying / diag / yanked / BREAKING 在 zh 里逐字保留，不算混入。
    const zhText = zh.replace(/<[^>]*>/g, ' ').replace(/9\.9\.9/g, '').replace(/7/g, '').replace(/Node/g, '').replace(/installing/g, '').replace(/verifying/g, '').replace(/diag/g, '').replace(/yanked/gi, '').replace(/BREAKING/g, '')
    const enText = en.replace(/<[^>]*>/g, ' ').replace(/9\.9\.9/g, '').replace(/7/g, '')
    assert.ok(!/[A-Za-z]/.test(zhText), k + ' zh 混入英文：' + zh)
    assert.ok(!/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(enText), k + ' en 混入中文：' + en)
  }
})

test('窄处竖排退场：CSS 无 column，保留 overflow-wrap', () => {
  assert.ok(!BILINGUAL_CSS.includes('flex-direction:column'), '竖排已退场')
  assert.ok(!BILINGUAL_CSS.includes('max-width:360px'), '窄处媒体查询已退场')
  assert.match(BILINGUAL_CSS, /overflow-wrap:anywhere/)
  assert.match(BILINGUAL_CSS, /\.dsh-upd-bi/)
})

test('纯文本单语：title/aria 用同语言平面版', () => {
  assert.equal(copyText('entry.label.idle', 'zh'), '检查更新')
  assert.equal(copyText('entry.label.idle', 'en'), 'Check for updates')
  // 历史名包装在 Node 无信号时落 zh（零回归）
  assert.equal(bilingualText('entry.label.idle'), '检查更新')
  assert.match(bilingualHTML('entry.label.idle'), /lang="zh"/)
})

// ---------- 变量不译：单语块里值出现一次，原样不译 ----------

test('占位按名填充：version 单语块里出现一次，原样不译', () => {
  const zh = copyHTML('entry.label.has-update', 'zh', { version: '1.2.3-beta' })
  assert.match(zh, /<span lang="zh">有新版 1\.2\.3-beta<\/span>/)
  assert.equal(zh.split('1.2.3-beta').length - 1, 1)
  const en = copyHTML('entry.label.has-update', 'en', { version: '1.2.3-beta' })
  assert.match(en, /<span lang="en">Update available 1\.2\.3-beta<\/span>/)
  assert.equal(en.split('1.2.3-beta').length - 1, 1)
})

test('缺值不漏 {name} 到 UI', () => {
  const html = copyHTML('entry.label.has-update', 'zh', {})
  assert.ok(!html.includes('{version}'), '缺值填空，不漏占位符')
})

test('转义：值与文案的尖括号不破 HTML', () => {
  const html = copyHTML('entry.label.has-update', 'zh', { version: '<img>' })
  assert.ok(!html.includes('<img>'), '已转义')
  assert.match(html, /&lt;img&gt;/)
})

// ---------- 两条链：entry 五档经字典单语渲染，第二出口同语言 ----------

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

test('第二出口同语言：同一快照 zh 回中文、en 回英文（未引入新分支）', () => {
  const s = { snapshot: baseSnapshot(), error: null }
  assert.equal(entryLabelFor(s, 'zh'), '有新版 1.1.0')
  assert.equal(entryLabelFor(s, 'en'), 'Update available 1.1.0')
  assert.equal(entryBilingualTextFor(s, 'zh'), '有新版 1.1.0')
  assert.equal(entryBilingualTextFor(s, 'en'), 'Update available 1.1.0')
  const zhH = entryBilingualHTMLFor(s, 'zh')
  const enH = entryBilingualHTMLFor(s, 'en')
  assert.match(zhH, /有新版 1\.1\.0/)
  assert.ok(!zhH.includes('Update available'))
  assert.match(enH, /Update available 1\.1\.0/)
  assert.ok(!enH.includes('有新版'))
})

test('分支仍只认稳定码：同一快照换语言不换档', () => {
  const s = { snapshot: baseSnapshot(), error: null }
  assert.equal(entryStateKind(s), 'update')
  assert.equal(entryBilingualKeyFor(s), 'entry.label.has-update')
})

test('挂载默认落 zh（Node 无信号）：按钮单语 zh，label() 同语言', async () => {
  __resetLangState()
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
  assert.match(box.innerHTML, /<span class="dsh-upd-bi"><span lang="zh">有新版 1\.1\.0<\/span><\/span>/)
  assert.ok(!box.innerHTML.includes('Update available'), 'zh 不见英文')
  assert.equal(entry.label(), '有新版 1.1.0')
  entry.unmount()
  __resetLangState()
})

test('显式 locale=en：按钮与 label() 同为英文，不见中文', async () => {
  __resetLangState()
  const box = fakeContainer()
  const entry = mountUpdateEntry(
    box,
    {
      pluginId: 'p',
      prefix: 'p',
      locale: 'en',
      call: async (name) => {
        if (name.endsWith('.updateStatus')) return { ok: true, snapshot: baseSnapshot(), manual: null, receipt: null, queue: null }
        throw new Error('unknown-phone:' + name)
      },
      autoCheck: 'never',
      pollMs: 60000,
    },
  )
  await entry.refresh()
  assert.match(box.innerHTML, /<span lang="en">Update available 1\.1\.0<\/span>/)
  assert.ok(!box.innerHTML.includes('有新版'), 'en 不见中文')
  assert.equal(entry.label(), 'Update available 1.1.0')
  entry.unmount()
  __resetLangState()
})

// ---------- 即时重绘与停订（注入假信号源，不依赖 jsdom） ----------

test('html[lang] 变化即时重绘（假 document + 假 MutationObserver，不依赖 jsdom）', async () => {
  __resetLangState()
  const origDoc = globalThis.document
  const origMO = globalThis.MutationObserver
  let moCb = null
  const fakeEl = { lang: 'zh' }
  globalThis.document = { documentElement: fakeEl }
  globalThis.MutationObserver = class {
    constructor(cb) { moCb = cb }
    observe() {}
    disconnect() { moCb = null }
  }
  try {
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
    await entry.refresh()
    assert.match(box.innerHTML, /有新版 1\.1\.0/)
    fakeEl.lang = 'en'
    moCb()
    assert.match(box.innerHTML, /Update available 1\.1\.0/, 'html lang 切 en 后即时重绘')
    entry.unmount()
  } finally {
    if (origDoc === undefined) delete globalThis.document
    else globalThis.document = origDoc
    if (origMO === undefined) delete globalThis.MutationObserver
    else globalThis.MutationObserver = origMO
    __resetLangState()
  }
})

test('语言切换即时重绘已挂载入口件（假 locale 服务源）', async () => {
  __resetLangState()
  const locale = fakeLocale('zh')
  const box = fakeContainer()
  const entry = mountUpdateEntry(
    box,
    {
      pluginId: 'p',
      prefix: 'p',
      locale,
      call: async (name) => {
        if (name.endsWith('.updateStatus')) return { ok: true, snapshot: baseSnapshot(), manual: null, receipt: null, queue: null }
        throw new Error('unknown-phone:' + name)
      },
      autoCheck: 'never',
      pollMs: 60000,
    },
  )
  await entry.refresh()
  assert.match(box.innerHTML, /有新版 1\.1\.0/)
  locale.set('en')
  assert.match(box.innerHTML, /Update available 1\.1\.0/, '切换后即时重绘为英文')
  assert.equal(entry.label(), 'Update available 1.1.0')
  entry.unmount()
  __resetLangState()
})

test('批量入口件同样跟随语言（假源）：zh/en 切换即时重绘', async () => {
  __resetLangState()
  const locale = fakeLocale('zh')
  const box = fakeContainer()
  const row = (overrides = {}) => ({
    key: 'a',
    title: 'a',
    phase: 'ready',
    targetVersion: '1.2.0',
    restartRequired: false,
    error: null,
    snapshot: baseSnapshot(),
    manual: null,
    queue: null,
    profileName: null,
    ...overrides,
  })
  const entry = mountUpdateBatchEntry(
    box,
    {
      prefix: 'life',
      locale,
      call: async (name) => {
        if (name.endsWith('.batchStatus')) return { ok: true, session: { id: 's' }, rows: [row()], progress: null }
        if (name.endsWith('.batchCheck')) return { ok: true, session: { id: 's' }, rows: [row()], progress: null }
        throw new Error('unknown-phone:' + name)
      },
      autoCheck: 'never',
      pollMs: 60000,
    },
  )
  await entry.refresh()
  assert.match(box.innerHTML, /1 家可更新/)
  assert.ok(!box.innerHTML.includes('updates available'))
  locale.set('en')
  assert.match(box.innerHTML, /1 updates available/, '切英文后重绘')
  assert.ok(!box.innerHTML.includes('家可更新'))
  assert.equal(entry.label(), '1 updates available')
  assert.equal(batchEntryLabelFor({ rows: [row()], error: null }, 'zh'), '1 家可更新')
  assert.equal(batchEntryLabelFor({ rows: [row()], error: null }, 'en'), '1 updates available')
  entry.unmount()
  __resetLangState()
})

test('unmount 之后语言变化不再触发回调（停订）', async () => {
  __resetLangState()
  let calls = 0
  const un = subscribeLang(() => { calls += 1 })
  un()
  // 全局无信号源可触发时，仅断言停订后不再被记账（服务源场景见下）
  assert.equal(calls, 0)
  const locale = fakeLocale('zh')
  const box = fakeContainer()
  const entry = mountUpdateEntry(
    box,
    {
      pluginId: 'p',
      prefix: 'p',
      locale,
      call: async () => ({ ok: true, snapshot: baseSnapshot(), manual: null, receipt: null, queue: null }),
      autoCheck: 'never',
      pollMs: 60000,
    },
  )
  await entry.refresh()
  const before = box.innerHTML
  entry.unmount()
  locale.set('en')
  assert.equal(box.innerHTML, before, 'unmount 后不再重绘')
  __resetLangState()
})

test('面板 dialog 打开期间切换语言不打断轮询与瞬时态（入口件侧不断快照，关后见新语言）', async () => {
  __resetLangState()
  const locale = fakeLocale('zh')
  const box = fakeContainer()
  const entry = mountUpdateEntry(
    box,
    {
      pluginId: 'p',
      prefix: 'p',
      locale,
      call: async (name) => {
        if (name.endsWith('.updateStatus')) return { ok: true, snapshot: baseSnapshot(), manual: null, receipt: null, queue: null }
        if (name.endsWith('.updateCheck')) return { ok: true, snapshot: baseSnapshot(), manual: null, receipt: { checkId: 'c', checkedAt: 1, expiresAt: 999 }, queue: null }
        if (name.endsWith('.updateInstall')) throw new Error('must-not-install')
        return { ok: true, snapshot: baseSnapshot(), manual: null, receipt: null, queue: null }
      },
      autoCheck: 'never',
      openOn: 'always',
      pollMs: 60000,
    },
  )
  await entry.refresh()
  assert.match(box.innerHTML, /有新版/)
  entry.open()
  const dialogHTML = box.innerHTML
  assert.match(dialogHTML, /dsh-upd/, 'dialog 已打开（面板接管容器）')
  assert.ok(!dialogHTML.includes('dsh-upd-entry-btn') || dialogHTML.includes('dsh-upd'), '面板态')
  // 打开期间切语言：dialog 不被收掉，快照不断；#61 起面板即时重绘为新语言（不再是窗口期占位）。
  locale.set('en')
  assert.match(box.innerHTML, /dsh-upd/, '面板打开期间仍由面板持有容器（轮询与瞬时态不断，未被入口件抢回）')
  assert.ok(!box.innerHTML.includes('dsh-upd-entry-btn'), '面板态未被入口件按钮替换')
  assert.match(box.innerHTML, /Update available|Loading update status|Not checked/, '面板已即时重绘为新语言（#61 消费 locale）')
  assert.equal(entry.label(), 'Update available 1.1.0', '第二出口已是新语言（快照未丢）')
  entry.close()
  await new Promise((r) => setTimeout(r, 20))
  assert.match(box.innerHTML, /Update available 1\.1\.0/, '关 dialog 后按钮即新语言')
  entry.unmount()
  __resetLangState()
})

// ---------- 不制造双源：changelog 标题仍唯一源于 CATEGORY_ZH ----------

test('不为 changelog 分类另立第二映射：底座无 changelog 分类 key（#66：运行时 9 键允许，分类仍唯一源于 CATEGORY_ZH）', () => {
  assert.ok(!Object.keys(BILINGUAL_STRINGS).some((k) => k.startsWith('changelog.category.')), '分类表唯一源仍在 changelog.ts')
  assert.ok(!Object.keys(BILINGUAL_STRINGS).some((k) => k.startsWith('changelog.category-')), '分类表唯一源仍在 changelog.ts')
  assert.ok(Object.keys(BILINGUAL_STRINGS).some((k) => k.startsWith('changelog.')), '运行时 9 键已入字典')
})
