/**
 * tests/issue-156-install-button.test.mjs —— #156 槽位按钮双形态。
 *
 * 只测外部行为：纯视图看兜底资格（installButtonViewModel），挂载走公开入口
 * （mount/refresh/click），电话走假传输。复用 panel.action.* 既有键，零新增键。
 * 铁律：点"装合规版"本身不装任何东西——决议先行，有候选才给点名版本的二次确认；
 * B 类与认不出的失败一个字不动（通用老路）。
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { installButtonViewModel, mountInstallButton, renderInstallButtonHTML } from '../dist/install-button.js'

// 现场实证形状（issue-156-panel.test.mjs 同源，插件标识 p）。
const PUBLISHED = Date.parse('2026-10-16T05:58:34.000Z')
const AGE_MESSAGE = [
  'install-failed: ✗ p@0.4.2: This version was published less than 1440 minutes ago (2026-10-16T05:58:34.000Z).',
  'The minimumReleaseAge cutoff for this version is 2026-10-15T07:34:55.413Z.',
  '',
  'Failed to install p@0.4.2.',
  'Command failed with exit code 1: pnpm add -g p@0.4.2',
  '[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION]',
].join('\n')
const OTHER_MESSAGE = AGE_MESSAGE.replaceAll('p@0.4.2', 'other@9.9.9').replaceAll(' p@', ' other@')

function failedSnapshot(over = {}) {
  return {
    runningVersion: '0.4.0',
    installedVersion: '0.4.0',
    installed: true,
    latestVersion: '0.4.2',
    // 生产真形状：年龄门是 pnpm 在装的那一刻拦的，核心的 canInstall 根本不知道它，
    // 所以"装失败之后 canInstall 仍为真"是常态。夹具不许写成 false 替实现掩护。
    canInstall: true,
    blockedReason: null,
    job: { id: 'job-1', state: 'failed', targetVersion: '0.4.2', message: AGE_MESSAGE, requestId: 'req-1' },
    ...over,
  }
}

function baseQueue(over = {}) {
  return { busy: false, owner: null, waiting: [], position: null, ...over }
}

function viewInput(over = {}) {
  return {
    snapshot: failedSnapshot(),
    manual: null,
    queue: baseQueue(),
    lastError: 'install-failed',
    errorKind: null,
    errorDetail: AGE_MESSAGE,
    pluginId: 'p',
    fallbackOffer: null,
    busyAct: null,
    pollCapped: null,
    lang: 'zh',
    ...over,
  }
}

describe('纯视图兜底资格', () => {
  it('拦的正是更新目标：offer 态', () => {
    const view = installButtonViewModel(viewInput())
    assert.equal(view.fallbackStage, 'offer')
    assert.equal(view.fallbackCandidate, null)
    assert.equal(view.fallbackBusy, false)
  })

  it('生产真形状（装失败后 canInstall 仍为真）：主按钮照旧 + 兜底并存，与主面板同摆放', () => {
    const view = installButtonViewModel(viewInput())
    assert.equal(view.role, 'install', '不许抢主按钮的活')
    assert.equal(view.buttonEnabled, true)
    assert.equal(view.fallbackStage, 'offer', '年龄门只有 pnpm 知道，兜底必须还在')
    const html = renderInstallButtonHTML(view, { manual: null, notice: null, theme: 'default', lang: 'zh' })
    assert.match(html, /data-action="install"/)
    assert.match(html, /data-action="install-fallback"/)
  })

  it('有候选即 confirm 态，点名精确版本', () => {
    const view = installButtonViewModel(viewInput({ fallbackOffer: { candidate: '0.4.1', targetVersion: '0.4.2' } }))
    assert.equal(view.fallbackStage, 'confirm')
    assert.equal(view.fallbackCandidate, '0.4.1')
    const html = renderInstallButtonHTML(view, { manual: null, notice: null, theme: 'default', lang: 'zh' })
    assert.match(html, /data-action="install-fallback-confirm"/)
    assert.match(html, /确认装 0\.4\.1/)
    assert.doesNotMatch(html, /data-action="install-fallback"/)
  })

  it('offer 态渲染装合规版 + 等新版', () => {
    const view = installButtonViewModel(viewInput())
    const html = renderInstallButtonHTML(view, { manual: null, notice: null, theme: 'default', lang: 'zh' })
    assert.match(html, /data-action="install-fallback"/)
    assert.match(html, /装合规版/)
    assert.match(html, /data-action="wait-latest"/)
  })

  it('B 类（别家包）：无兜底，走通用老路', () => {
    const view = installButtonViewModel(viewInput({ errorDetail: OTHER_MESSAGE }))
    assert.equal(view.fallbackStage, null)
    const html = renderInstallButtonHTML(view, { manual: null, notice: null, theme: 'default', lang: 'zh' })
    assert.doesNotMatch(html, /data-action="install-fallback"/)
  })

  it('认不出的失败：无兜底', () => {
    const view = installButtonViewModel(viewInput({ errorDetail: 'plain boom', lastError: 'install-failed' }))
    assert.equal(view.fallbackStage, null)
  })

  it('查侧失败：无兜底（退回查按钮）', () => {
    const view = installButtonViewModel(viewInput({ lastError: 'check-failed', errorDetail: null }))
    assert.equal(view.fallbackStage, null)
  })

  it('候选对不上当前目标：视为无候选（旧决议不指手画脚）', () => {
    const view = installButtonViewModel(viewInput({ fallbackOffer: { candidate: '0.4.1', targetVersion: '0.4.9' } }))
    assert.equal(view.fallbackStage, 'offer')
  })

  it('决议在途：按钮置灰防并发', () => {
    const view = installButtonViewModel(viewInput({ busyAct: 'fallback' }))
    assert.equal(view.fallbackStage, 'offer')
    assert.equal(view.fallbackBusy, true)
    const html = renderInstallButtonHTML(view, { manual: null, notice: null, theme: 'default', lang: 'zh' })
    assert.match(html, /data-action="install-fallback"[^>]*disabled/)
  })
})

/** 假传输：按电话名回剧本，并记下每一次调用。 */
function fakeCall(script = {}) {
  const log = []
  const pick = (s, fallback) => (typeof s === 'function' ? s(log) : s === undefined ? fallback : s)
  const call = async (name, args) => {
    log.push({ name, args })
    if (name.endsWith('.updateStatus')) return pick(script.status, { ok: true, snapshot: failedSnapshot(), manual: null, receipt: null, queue: baseQueue() })
    if (name.endsWith('.updateCheckFallback')) return pick(script.fallback, {
      ok: true,
      snapshot: { verdict: { kind: 'downgrade-available', version: '0.4.1' }, candidate: '0.4.1' },
      receipt: { checkId: 'fb-1', checkedAt: 1, expiresAt: 9999999999999 },
    })
    if (name.endsWith('.updateCheck')) return pick(script.check, { ok: true, snapshot: failedSnapshot(), manual: null, receipt: null, queue: baseQueue() })
    if (name.endsWith('.updateInstall')) return pick(script.install, { ok: true, snapshot: failedSnapshot(), manual: null, queue: baseQueue() })
    if (name.endsWith('.logAppend')) return { accepted: 0, dropped: 0 }
    throw new Error('unknown-phone:' + name)
  }
  return { call, log }
}

function fakeContainer() {
  const listeners = new Map()
  return {
    innerHTML: '',
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? []
      list.push(listener)
      listeners.set(type, list)
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) ?? []).filter((fn) => fn !== listener))
    },
    click(attrs) {
      const matches = (sel) => {
        const m = /^\[([A-Za-z0-9_-]+)(?:="([^"]*)")?\]$/.exec(sel)
        if (!m) return false
        if (!Object.prototype.hasOwnProperty.call(attrs, m[1])) return false
        return m[2] === undefined || attrs[m[1]] === m[2]
      }
      const ev = {
        target: {
          closest(sel) {
            return matches(sel) ? { getAttribute: (k) => (k in attrs ? attrs[k] : null) } : null
          },
        },
      }
      for (const fn of [...(listeners.get('click') ?? [])]) fn(ev)
    },
  }
}

const flush = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r))
}

let origSet = null
let origClear = null
beforeEach(() => {
  origSet = globalThis.setInterval
  origClear = globalThis.clearInterval
  globalThis.setInterval = () => 0
  globalThis.clearInterval = () => {}
})
afterEach(() => {
  globalThis.setInterval = origSet
  globalThis.clearInterval = origClear
})

describe('挂载决议确认流', () => {
  it('失败页有装合规版；点后调决议电话；有候选即确认装X；确认后安装带 version', async () => {
    const { call, log } = fakeCall()
    const container = fakeContainer()
    const btn = mountInstallButton(container, { pluginId: 'p', prefix: 't', call, autoCheck: 'never' })
    await btn.refresh()
    await flush(10)
    assert.match(container.innerHTML, /data-action="install-fallback"/)
    assert.equal(log.filter((e) => e.name.endsWith('.updateInstall')).length, 0)

    container.click({ 'data-action': 'install-fallback' })
    await flush(10)
    const fb = log.filter((e) => e.name.endsWith('.updateCheckFallback'))
    assert.equal(fb.length, 1)
    assert.equal(fb[0].args.targetVersion, '0.4.2')
    assert.equal(fb[0].args.blame, 'target')
    assert.match(container.innerHTML, /data-action="install-fallback-confirm"/)
    assert.match(container.innerHTML, /确认装 0\.4\.1/)

    container.click({ 'data-action': 'install-fallback-confirm' })
    await flush(10)
    const installs = log.filter((e) => e.name.endsWith('.updateInstall'))
    assert.equal(installs.length, 1)
    assert.equal(installs[0].args.version, '0.4.1')
    assert.equal(installs[0].args.checkId, 'fb-1')
    assert.ok(typeof installs[0].args.requestId === 'string' && installs[0].args.requestId.length > 0)
    btn.unmount()
  })

  it('装失败回包只带回码（没原文）：读完状态里的失败任务才补上兜底', async () => {
    let failedJobVisible = false
    const { call, log } = fakeCall({
      status: () =>
        failedJobVisible
          ? { ok: true, snapshot: failedSnapshot(), manual: null, receipt: null, queue: baseQueue() }
          : { ok: true, snapshot: failedSnapshot({ job: null }), manual: null, receipt: null, queue: baseQueue() },
      check: () => ({
        ok: true,
        snapshot: failedSnapshot({ job: null }),
        manual: null,
        receipt: { checkId: 'chk-1' },
        queue: baseQueue(),
      }),
      install: () => ({ ok: false, error: 'install-failed', errorKind: null, diag: null }),
    })
    const container = fakeContainer()
    const btn = mountInstallButton(container, { pluginId: 'p', prefix: 't', call, autoCheck: 'never' })
    await btn.refresh()
    await flush(10)
    assert.doesNotMatch(container.innerHTML, /data-action="install-fallback"/, '还没失败过：不许凭空出现')

    container.click({ 'data-action': 'install' })
    await flush(10)
    assert.ok(
      log.some((e) => e.name.endsWith('.updateInstall')),
      '主按钮确实去装了',
    )
    assert.equal(
      container.innerHTML.includes('data-action="install-fallback"'),
      false,
      '宿主失败回包没带原文：此刻认不出因，不该乱给按钮',
    )

    failedJobVisible = true
    await btn.refresh()
    await flush(10)
    assert.match(container.innerHTML, /data-action="install-fallback"/, '状态读回失败任务（带原文）后必须补上')
    btn.unmount()
  })

  it('老宿主无决议电话：退化只呈现，给通用提醒，不碎', async () => {
    const { call } = fakeCall({ fallback: async () => { throw new Error('unknown-phone:x.updateCheckFallback') } })
    const container = fakeContainer()
    const btn = mountInstallButton(container, { pluginId: 'p', prefix: 't', call, autoCheck: 'never' })
    await btn.refresh()
    await flush(10)
    container.click({ 'data-action': 'install-fallback' })
    await flush(10)
    assert.doesNotMatch(container.innerHTML, /data-action="install-fallback-confirm"/)
    assert.match(container.innerHTML, /data-action="install-fallback"/)
    btn.unmount()
  })

  it('等新版：清锁存与决议，不调电话', async () => {
    const { call, log } = fakeCall()
    const container = fakeContainer()
    const btn = mountInstallButton(container, { pluginId: 'p', prefix: 't', call, autoCheck: 'never' })
    await btn.refresh()
    await flush(10)
    container.click({ 'data-action': 'install-fallback' })
    await flush(10)
    assert.match(container.innerHTML, /data-action="install-fallback-confirm"/)
    const before = log.length
    container.click({ 'data-action': 'wait-latest' })
    await flush(10)
    assert.equal(log.length, before, '等新版不调任何电话')
    assert.doesNotMatch(container.innerHTML, /data-action="install-fallback-confirm"/)
    btn.unmount()
  })
})
