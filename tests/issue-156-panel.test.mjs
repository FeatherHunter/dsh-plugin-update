/**
 * tests/issue-156-panel.test.mjs —— #156 面板呈现：失败页双按钮 + 决议确认流。
 *
 * 只测外部行为：纯渲染看按钮（renderUpdatePanelHTML），挂载走公开入口（mount/act/refresh），
 * 纯门走公开导出的 fallbackBlockedVersionOf / fallbackCauseFromDetail。
 * 灯下黑提醒：按钮只看机读结论（PanelFailureRef cause 三件套），不读自由文本；
 * 点"装合规版"本身不装任何东西——有候选才给点名版本的二次确认。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  fallbackBlockedVersionOf,
  fallbackCauseFromDetail,
  mountUpdatePanel,
  renderUpdatePanelHTML,
} from '../dist/panel.js'

// 现场实证形状（install-cause.test.mjs 同源，包名换成面板插件标识 p）。
const PUBLISHED = Date.parse('2026-10-16T05:58:34.000Z')
const AGE_MESSAGE = [
  'install-failed: ✗ p@0.4.2: This version was published less than 1440 minutes ago (2026-10-16T05:58:34.000Z).',
  'The minimumReleaseAge cutoff for this version is 2026-10-15T07:34:55.413Z.',
  '',
  'Failed to install p@0.4.2.',
  'Command failed with exit code 1: pnpm add -g p@0.4.2',
  '[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION]',
].join('\n')

function baseSnapshot(overrides = {}) {
  return {
    runningVersion: '0.4.1',
    installedVersion: '0.4.1',
    latestVersion: '0.4.2',
    canInstall: true,
    blockedReason: null,
    job: null,
    ...overrides,
  }
}

function baseQueue(overrides = {}) {
  return { busy: false, owner: null, waiting: [], position: null, ...overrides }
}

function failedSnapshot() {
  return baseSnapshot({
    job: { id: 'job-1', state: 'failed', targetVersion: '0.4.2', message: AGE_MESSAGE, requestId: 'req-1' },
  })
}

function causeFailure(overrides = {}) {
  return {
    requestId: null,
    checkId: null,
    atMs: 1,
    source: 'install',
    volatile: false,
    targetVersion: '0.4.2',
    causeKind: 'minimum-release-age',
    causePackage: 'p@0.4.2',
    causeTarget: 'p',
    causeWindowMs: 1440 * 60_000,
    causePublishedAtMs: PUBLISHED,
    ...overrides,
  }
}

function renderInput(overrides = {}) {
  return {
    pluginId: 'p',
    snapshot: failedSnapshot(),
    manual: null,
    queue: baseQueue(),
    mode: 'embedded',
    lastError: 'install-failed',
    ...overrides,
  }
}

describe('失败页双按钮（#156 场景一）', () => {
  it('拦的正是更新目标：给［装合规版］［等新版］，"已知晓"让位', () => {
    const html = renderUpdatePanelHTML(renderInput({ failure: causeFailure() }))
    assert.match(html, /data-action="install-fallback"/, '应有装合规版')
    assert.match(html, /装合规版/, '按钮文案可读')
    assert.match(html, /data-action="wait-latest"/, '应有等新版')
    assert.match(html, /等新版/, '按钮文案')
    assert.doesNotMatch(html, /data-action="dismiss-failure"/, '双按钮在场时已知晓让位')
  })

  it('拦的是别家包：无双按钮，走通用"已知晓"（场景四）', () => {
    const html = renderUpdatePanelHTML(
      renderInput({ failure: causeFailure({ causePackage: 'other@9.9.9', causeTarget: 'p', targetVersion: null }) })
    )
    assert.doesNotMatch(html, /data-action="install-fallback"/, 'B 类不给装合规版')
    assert.doesNotMatch(html, /data-action="wait-latest"/, 'B 类不给等新版')
    assert.match(html, /data-action="dismiss-failure"/, '通用已知晓仍在')
  })

  it('认不出的失败：按钮一个字不动（通用老路）', () => {
    const html = renderUpdatePanelHTML(
      renderInput({ failure: { requestId: null, checkId: null, atMs: 1, source: 'install', volatile: false, targetVersion: null } })
    )
    assert.doesNotMatch(html, /data-action="install-fallback"/)
    assert.match(html, /data-action="dismiss-failure"/)
  })

  it('决议出候选：确认按钮点名版本，"装合规版"退场', () => {
    const html = renderUpdatePanelHTML(
      renderInput({ failure: causeFailure(), fallbackOffer: { candidate: '0.4.1', targetVersion: '0.4.2' } })
    )
    assert.match(html, /data-action="install-fallback-confirm"/, '应有二次确认')
    assert.match(html, /确认装 0\.4\.1/, '确认按钮点名精确版本')
    assert.doesNotMatch(html, /data-action="install-fallback"/, '决议后装合规版退场')
  })

  it('决议在途：双按钮置灰防并发', () => {
    const html = renderUpdatePanelHTML(renderInput({ failure: causeFailure(), busyAct: 'fallback' }))
    assert.match(html, /data-action="install-fallback"[^>]*disabled/, '装合规版禁用')
    assert.match(html, /data-action="wait-latest"[^>]*disabled/, '等新版禁用')
  })
})

describe('纯门（#156）', () => {
  it('fallbackBlockedVersionOf：主包认、他包拒、无结论拒', () => {
    assert.equal(fallbackBlockedVersionOf(causeFailure(), 'p'), '0.4.2')
    assert.equal(
      fallbackBlockedVersionOf(causeFailure({ causePackage: 'other@9.9.9', causeTarget: 'p', targetVersion: null }), 'p'),
      null
    )
    assert.equal(fallbackBlockedVersionOf(null, 'p'), null)
    assert.equal(fallbackBlockedVersionOf({ targetVersion: '0.4.2' }, 'p'), null)
  })

  it('fallbackBlockedVersionOf：失败引用没带目标版时从规格里剥版本', () => {
    assert.equal(
      fallbackBlockedVersionOf(causeFailure({ targetVersion: null }), 'p'),
      '0.4.2'
    )
  })

  it('fallbackCauseFromDetail：原文抠出版本/窗口/出处，他包与垃圾回 null', () => {
    const detail = AGE_MESSAGE.slice(AGE_MESSAGE.indexOf(':') + 1)
    const out = fallbackCauseFromDetail(detail, 'install-failed', 'p')
    assert.ok(out, '应认出')
    assert.equal(out.targetVersion, '0.4.2')
    assert.equal(out.windowMs, 1440 * 60_000)
    assert.equal(out.windowSource, 'message')
    assert.equal(out.publishedAtMs, PUBLISHED)
    assert.equal(fallbackCauseFromDetail(detail, 'install-failed', 'q'), null, '包名对不上即他包')
    assert.equal(fallbackCauseFromDetail('nothing here', 'install-failed', 'p'), null, '垃圾文本认怂')
    assert.equal(fallbackCauseFromDetail(detail, 'check-failed', 'p'), null, '错码不认')
  })
})

// ---------- 挂载流：决议 → 确认 → 带版安装 ----------

function fakeContainer() {
  return { innerHTML: '', addEventListener() {}, removeEventListener() {} }
}

function scriptedCall(script) {
  const log = []
  const call = async (name, args) => {
    log.push({ name, args })
    if (name.endsWith('.updateStatus')) return script.status(name, args)
    if (name.endsWith('.updateCheck')) return script.check(name, args)
    if (name.endsWith('.updateInstall')) return script.install(name, args)
    if (name.endsWith('.updateCheckFallback')) return script.fallback(name, args)
    throw new Error('unknown-phone:' + name)
  }
  return { call, log }
}

function mountFor(pluginId, script) {
  const { call, log } = scriptedCall(script)
  const box = fakeContainer()
  const panel = mountUpdatePanel(box, {
    pluginId,
    call,
    pollMs: 60000,
    copyText: async () => {},
    autoChangelog: false,
  })
  return { panel, box, log }
}

async function settled(ms = 20) {
  await new Promise((r) => setTimeout(r, 10))
  await new Promise((r) => setTimeout(r, ms))
}

const okStatusFailed = () => ({
  ok: true,
  snapshot: failedSnapshot(),
  manual: null,
  receipt: null,
  queue: baseQueue(),
})

describe('挂载确认流（#156）', () => {
  it('装合规版 → 决议 → 确认装候选：安装电话带上决议版本', async () => {
    const seen = {}
    const { panel, box, log } = mountFor('p', {
      status: okStatusFailed,
      check: () => ({ ok: true, snapshot: baseSnapshot(), manual: null, receipt: null, queue: baseQueue() }),
      install: (name, args) => {
        seen.installArgs = args
        return {
          ok: true,
          snapshot: baseSnapshot({ job: { id: 'job-2', state: 'installing', targetVersion: '0.4.1', message: null, requestId: args.requestId } }),
          manual: null,
          receipt: null,
          queue: baseQueue(),
        }
      },
      fallback: (name, args) => {
        seen.fallbackArgs = args
        return {
          ok: true,
          snapshot: {
            verdict: { kind: 'downgrade-available', version: '0.4.1', targetVersion: '0.4.2', targetUnlockAtMs: 1, windowSource: 'message' },
            candidate: '0.4.1',
          },
          receipt: { checkId: 'fb-1', checkedAt: 1, expiresAt: 9999999999999 },
        }
      },
    })
    await panel.refresh()
    await settled()
    assert.match(box.innerHTML, /data-action="install-fallback"/, '失败页应有装合规版')
    await panel.act('install-fallback')
    await settled()
    assert.equal(seen.fallbackArgs.kind, 'minimum-release-age')
    assert.equal(seen.fallbackArgs.blame, 'target')
    assert.equal(seen.fallbackArgs.targetVersion, '0.4.2')
    assert.equal(seen.fallbackArgs.windowMs, 1440 * 60_000)
    assert.match(box.innerHTML, /确认装 0\.4\.1/, '决议后应有点名版本的确认按钮')
    await panel.act('install-fallback-confirm')
    await settled()
    assert.equal(seen.installArgs.version, '0.4.1', '安装电话带上决议版本')
    assert.equal(seen.installArgs.checkId, 'fb-1', '安装电话带上决议凭证')
    assert.ok(typeof seen.installArgs.requestId === 'string', '请求编号照常带')
    assert.doesNotMatch(box.innerHTML, /更新失败/, '安装接单后旧失败让位')
    const installCalls = log.filter((e) => e.name.endsWith('.updateInstall'))
    assert.equal(installCalls.length, 1, '确认只装一次')
    panel.unmount()
  })

  it('老宿主没有决议电话：退化只呈现，面板不碎、可重试', async () => {
    const { panel, box } = mountFor('p', {
      status: okStatusFailed,
      check: () => ({ ok: true, snapshot: baseSnapshot(), manual: null, receipt: null, queue: baseQueue() }),
      install: () => ({ ok: false, error: 'install-failed', errorKind: 'install-failed' }),
      fallback: () => {
        throw new Error('unknown-phone:wf.updateCheckFallback')
      },
    })
    await panel.refresh()
    await settled()
    await panel.act('install-fallback')
    await settled()
    assert.match(box.innerHTML, /data-action="install-fallback"/, '按钮仍在，可重试')
    assert.doesNotMatch(box.innerHTML, /data-action="install-fallback-confirm"/, '无决议即无确认')
    assert.match(box.innerHTML, /这次失败用不上合规版/, '诚实提醒，不装不藏')
    panel.unmount()
  })

  it('等新版：只清锁存，不调电话', async () => {
    const { panel, box, log } = mountFor('p', {
      status: okStatusFailed,
      check: () => ({ ok: true, snapshot: baseSnapshot(), manual: null, receipt: null, queue: baseQueue() }),
      install: () => ({ ok: false, error: 'install-failed', errorKind: 'install-failed' }),
      fallback: () => ({ ok: true, snapshot: { verdict: { kind: 'abstain' }, candidate: null }, receipt: null }),
    })
    await panel.refresh()
    await settled()
    const before = log.length
    await panel.act('wait-latest')
    await settled()
    assert.equal(log.length, before, '等新版不调任何电话')
    assert.doesNotMatch(box.innerHTML, /更新失败/, '失败横幅收起')
    panel.unmount()
  })
})
