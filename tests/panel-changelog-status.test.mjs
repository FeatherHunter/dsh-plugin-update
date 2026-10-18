/**
 * tests/panel-changelog-status.test.mjs —— #213 更新说明空白分档的面板侧回归护栏。
 *
 * 四档话术是这一票新增的**用户可见文案**，此前仓内零测试（两轴 code review 都点了这一格：
 * 功能由 verify-213 的临时脚本证明过，但没有常驻护栏）。只测外部行为：
 *   1. 四档各说各的话，互不串味，也不再与「更新日志无法读取」同形；
 *   2. 老宿主（无 `status`）/ `ok` / `cache-hit` / 认不出的野值 → 输出与旧版逐字节相同；
 *   3. 显式文本永不被分档覆盖；
 *   4. 新版给出**结论性**空白（空文件 / 包里没有 / 取不到）时，上一版的正文不许留在新版标题下；
 *      老宿主（认不出分档）不动旧正文，行为与 #213 之前一致。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderUpdatePanelHTML, mountUpdatePanel } from '../dist/panel.js'

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

const SAMPLE = [
  '# Changelog',
  '',
  '## [1.1.0] - 2026-10-05',
  '',
  '### Added',
  '',
  '- 自动取日志',
  '',
  '## [1.0.0] - 2026-09-01',
  '',
  '### Fixed',
  '',
  '- 首版',
  '',
].join('\n')

/** 无分档时 02 章的老句（「作者没写」那一形——本票就是要让它不再与「取不到」同形）。 */
const SAME_SHAPE_COPY = '作者未提供更新说明，安装不受影响。'
/** 画坏/兜底路径的老句（另一条路，别混）。 */
const BROKEN_COPY = '更新日志无法读取，安装不受影响。'

/** 四档话术（src/bilingual.ts 的 zh 原文；en 另有快照门禁管）。 */
const STATUS_COPY = [
  { status: 'empty', markdown: null, text: '该版本的更新说明是空文件，不是取数失败。' },
  { status: 'missing', markdown: null, text: '该版本包里没有更新说明文件，不是取数失败。' },
  { status: 'fetch-failed', markdown: null, text: '更新说明没取到（网络或完整性校验失败）。' },
  { status: 'parse-degraded', markdown: '这是一份有内容但读不出结构的说明', text: '更新说明有内容，但没解析出结构，不是没有说明。' },
]

/** 2.4.0 的正文（G1 用例用；与 SAMPLE 的标记区分开）。 */
const BODY_240 = [
  '# Changelog',
  '',
  '## [2.4.0] - 2026-10-01',
  '',
  '### Added',
  '',
  '- 二四零正文',
  '',
].join('\n')

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
    mode: 'embedded',
    snapshot: baseSnapshot(),
    manual: null,
    queue: null,
    skippedLatest: false,
    lastError: null,
    showOthers: false,
    pluginId: 'p',
    copyNotice: null,
    ...overrides,
  }
}

function fakeContainer() {
  return { innerHTML: '', addEventListener() {}, removeEventListener() {} }
}

/** 面板电话假件：状态与日志回复都可随场景换（用来演「新版来了」）。 */
function panelCall({ getStatus, getChangelog }) {
  const log = []
  const call = async (name, args) => {
    log.push({ name, args })
    if (name.endsWith('.updateStatus')) return { ok: true, snapshot: getStatus(), manual: null, receipt: null }
    if (name.endsWith('.updateCheck')) {
      return { ok: true, snapshot: getStatus(), manual: null, receipt: { checkId: 'c', checkedAt: 1, expiresAt: 9 } }
    }
    if (name.endsWith('.updateChangelog')) return getChangelog(args)
    throw new Error('unknown-phone:' + name)
  }
  return { call, log }
}

describe('#213 面板更新说明分档', () => {
  it('四档各说各的话：互不串味，也不再与「读不出来」同形', () => {
    for (const c of STATUS_COPY) {
      const html = renderUpdatePanelHTML(baseInput({ changelogMarkdown: c.markdown, changelogStatus: c.status }))
      assert.ok(html.includes(c.text), `${c.status} 要说自己的话`)
      for (const other of STATUS_COPY) {
        if (other.status === c.status) continue
        assert.ok(!html.includes(other.text), `${c.status} 不许说 ${other.status} 的话`)
      }
      assert.ok(!html.includes(SAME_SHAPE_COPY), `${c.status} 不再与「作者没写」同形`)
      assert.ok(!html.includes(BROKEN_COPY), `${c.status} 也不退回「读不出来」那句`)
    }
  })

  it('老宿主与认不出的分档：输出与旧版逐字节相同', () => {
    const base = renderUpdatePanelHTML(baseInput({ changelogMarkdown: null }))
    assert.ok(base.includes(SAME_SHAPE_COPY), '无分档时仍是老句「作者未提供」')
    for (const value of [undefined, null, 'ok', 'cache-hit', 'wild-value', 42, {}]) {
      const html = renderUpdatePanelHTML(baseInput({ changelogMarkdown: null, changelogStatus: value }))
      assert.equal(html, base, `changelogStatus=${String(value)} 必须一字不差`)
    }
  })

  it('显式文本永不被分档覆盖：有正文时四档都插不上话', () => {
    const explicit = renderUpdatePanelHTML(baseInput({ changelogMarkdown: SAMPLE }))
    assert.ok(explicit.includes('自动取日志'), '正文照常渲染')
    for (const c of [...STATUS_COPY, { status: 'ok' }]) {
      const html = renderUpdatePanelHTML(baseInput({ changelogMarkdown: SAMPLE, changelogStatus: c.status }))
      assert.equal(html, explicit, `有正文时 ${c.status} 不得改一个字节`)
    }
  })

  it('新版结论性空白：上一版正文不许留在新版标题下，改说这一版的分档', async () => {
    let status = baseSnapshot({ latestVersion: '1.1.0' })
    const { call } = panelCall({
      getStatus: () => status,
      getChangelog: (args) =>
        args && args.version === '1.2.0'
          ? { ok: true, version: '1.2.0', markdown: null, status: 'missing', cached: false }
          : { ok: true, version: '1.1.0', markdown: SAMPLE, status: 'ok', cached: false },
    })
    const slot = fakeContainer()
    const panel = mountUpdatePanel(slot, { pluginId: 'p', prefix: 't', call })
    try {
      await panel.refresh()
      await settled()
      await settled()
      assert.ok(slot.innerHTML.includes('自动取日志'), '1.1.0 的正文先正常显示')
      // 新版 1.2.0 来了，宿主给出结论性分档「包里没有」且没有正文：
      status = baseSnapshot({ latestVersion: '1.2.0' })
      await panel.refresh()
      await settled()
      await settled()
      await settled()
      assert.ok(slot.innerHTML.includes('该版本包里没有更新说明文件，不是取数失败。'), '新版要说这一版的分档')
      assert.ok(!slot.innerHTML.includes('自动取日志'), '上一版正文不许留在新版标题下')
    } finally {
      panel.unmount()
    }
  })

  it('老宿主（认不出分档）不动旧正文：行为与 #213 之前一致', async () => {
    let status = baseSnapshot({ latestVersion: '1.1.0' })
    const { call } = panelCall({
      getStatus: () => status,
      getChangelog: (args) =>
        args && args.version === '1.2.0'
          ? { ok: true, version: '1.2.0', markdown: null }
          : { ok: true, version: '1.1.0', markdown: SAMPLE },
    })
    const slot = fakeContainer()
    const panel = mountUpdatePanel(slot, { pluginId: 'p', prefix: 't', call })
    try {
      await panel.refresh()
      await settled()
      await settled()
      status = baseSnapshot({ latestVersion: '1.2.0' })
      await panel.refresh()
      await settled()
      await settled()
      await settled()
      // verify-213 D4-ME：只看 innerHTML 会被残留 DOM 骗过（「状态被清但那一帧没重绘」的实现也能全绿），
      // 断言前用同一版快照再刷一次，逼 DOM 反映真实状态。
      await panel.refresh()
      await settled()
      await settled()
      assert.ok(slot.innerHTML.includes('自动取日志'), '认不出分档就照老样子，不擅自清正文')
      assert.ok(!slot.innerHTML.includes('该版本包里没有更新说明文件'), '没有分档就没有分档话术')
    } finally {
      panel.unmount()
    }
  })

  it('上一版的迟到空白回包不许擦掉新版正文（verify-213 D3-5 反例）', async () => {
    let status = baseSnapshot({ latestVersion: '1.1.0' })
    let releaseOld = () => {}
    const oldReply = new Promise((resolve) => {
      releaseOld = () => resolve({ ok: true, version: '1.1.0', markdown: null, status: 'missing', cached: false })
    })
    const { call } = panelCall({
      getStatus: () => status,
      getChangelog: (args) =>
        args && args.version === '1.1.0'
          ? oldReply
          : { ok: true, version: '1.2.0', markdown: SAMPLE, status: 'ok', cached: false },
    })
    const slot = fakeContainer()
    const panel = mountUpdatePanel(slot, { pluginId: 'p', prefix: 't', call })
    try {
      await panel.refresh()
      await settled()
      // 1.1.0 那通电话还挂在网上；新版 1.2.0 先回来并上屏：
      status = baseSnapshot({ latestVersion: '1.2.0' })
      await panel.refresh()
      await settled()
      await settled()
      assert.ok(slot.innerHTML.includes('自动取日志'), '新版正文先上屏')
      // 现在放行 1.1.0 的迟到结论性空白——它说的是上一版，不许动屏上这一版：
      releaseOld()
      await settled()
      await settled()
      assert.ok(slot.innerHTML.includes('自动取日志'), '上一版的迟到空白不许擦掉新版正文')
      assert.ok(!slot.innerHTML.includes('该版本包里没有更新说明文件'), '也不许把上一版的分档贴到新版上')
    } finally {
      panel.unmount()
    }
  })

  it('连跳两版时，中间那版的结论性空白也要清掉更旧的正文（verify-213 G1 反例）', async () => {
    let status = baseSnapshot({ latestVersion: '2.4.0' })
    const pending = {}
    const hold = (v) =>
      new Promise((resolve) => {
        pending[v] = () => resolve({ ok: true, version: v, markdown: null, status: 'missing', cached: false })
      })
    const { call } = panelCall({
      getStatus: () => status,
      getChangelog: (args) => {
        const v = args && args.version
        if (v === '2.4.0') return { ok: true, version: '2.4.0', markdown: BODY_240, status: 'ok', cached: false }
        return hold(v)
      },
    })
    const slot = fakeContainer()
    const panel = mountUpdatePanel(slot, { pluginId: 'p', prefix: 't', call })
    try {
      await panel.refresh()
      await settled()
      await settled()
      assert.ok(slot.innerHTML.includes('二四零正文'), '2.4.0 的正文先上屏')
      status = baseSnapshot({ latestVersion: '2.5.0' })
      await panel.refresh()
      await settled()
      status = baseSnapshot({ latestVersion: '2.6.0' })
      await panel.refresh()
      await settled()
      assert.ok(slot.innerHTML.includes('二四零正文'), '2.6.0 的正文还没回来，屏上仍是旧的那段')
      // 2.5.0 的结论性空白迟到：屏上正文（2.4.0）比它更旧，必须清掉——
      // 闸门比「屏上正文所属版本 vs 当前新版」，不是「回包版本 vs 当前新版」。
      pending['2.5.0']()
      await settled()
      await settled()
      assert.ok(!slot.innerHTML.includes('二四零正文'), '更旧一版的正文不许留在新版标题下')
      assert.ok(
        !slot.innerHTML.includes('该版本包里没有更新说明文件'),
        '2.5.0 的分档也不许贴到 2.6.0 上（屏上只留中性的「作者未提供」）',
      )
    } finally {
      panel.unmount()
    }
  })
})
