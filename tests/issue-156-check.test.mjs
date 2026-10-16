/**
 * tests/issue-156-check.test.mjs —— #156 场景二：检查页预判。
 *
 * 用户故事：装 0.4.2 被年龄门拦过、点了［等新版］之后，面板不应再说"有新版 0.4.2
 * 可安装"骗点——而是"0.4.2 刚发布未满门，X 可装；等不及可先装合规版"，主安装按钮
 * 置灰，［装合规版］走同一决议流（点名版本二次确认后才真装）。
 *
 * 只测外部行为：纯渲染走公开的 renderUpdatePanelHTML（checkPrejudge 输入），
 * 纯门走公开的 checkPrejudgeOfView，挂载走公开入口（mount/act/refresh）。
 * 规则（第一性原理）：没有记住的窗口就不预判——窗口只来自失败锁存里解析出的
 * 机读结论，用户点了"等新版"清掉锁存，记住的窗口留给检查页用；锁存还在时失败页
 * 优先（场景一），检查页预判只在"已确认、无新鲜失败"时出现。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkPrejudgeOfView,
  mountUpdatePanel,
  renderUpdatePanelHTML,
} from '../dist/panel.js'

const NOW = 2_000_000_000_000
const HOUR = 3_600_000
const UNLOCK_AT = NOW + 3 * HOUR

// 0.4.2 一小时前发布、门限 24 小时：三小时后放行（与面板挂载测试同源措辞）。
// 包名参数化：原文解析按插件标识匹配包名，跨挂载测试用独立标识时报文也要对上。
function ageMessage(pkg) {
  return [
    `install-failed: ✗ ${pkg}@0.4.2: This version was published less than 1440 minutes ago (2026-10-16T05:58:34.000Z).`,
    'The minimumReleaseAge cutoff for this version is 2026-10-15T07:34:55.413Z.',
    '',
    `Failed to install ${pkg}@0.4.2.`,
    `Command failed with exit code 1: pnpm add -g ${pkg}@0.4.2`,
    '[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION]',
  ].join('\n')
}
const AGE_MESSAGE = ageMessage('p')

function updateSnapshot(overrides = {}) {
  return {
    runningVersion: '0.4.1',
    installedVersion: '0.4.1',
    installed: true,
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

function prejudge(overrides = {}) {
  return { targetVersion: '0.4.2', unlockAtMs: UNLOCK_AT, nowMs: NOW, ...overrides }
}

function renderInput(overrides = {}) {
  return {
    pluginId: 'p',
    snapshot: updateSnapshot(),
    manual: null,
    queue: baseQueue(),
    mode: 'embedded',
    lastError: null,
    ...overrides,
  }
}

describe('检查页预判渲染（#156 场景二）', () => {
  it('记住的窗口对上当前新版：不说"可安装"，主按钮置灰，给［装合规版］', () => {
    const html = renderUpdatePanelHTML(renderInput({ checkPrejudge: prejudge() }))
    assert.match(html, /未满门/, '横幅说人话：未满门')
    assert.match(html, /0\.4\.2/, '横幅点名版本')
    assert.doesNotMatch(html, /可安装/, '不再骗点"可安装"')
    assert.match(html, /data-action="install"[^>]*disabled/, '主安装按钮置灰')
    assert.match(html, /data-action="install-fallback"/, '给装合规版')
    assert.doesNotMatch(html, /data-action="wait-latest"/, '检查页本就是等的地方，不再给等新版')
    assert.doesNotMatch(html, /data-action="dismiss-failure"/, '无失败不给已知晓')
  })

  it('记住的是旧版、远端已出新版：按正常检查页，不预判', () => {
    const html = renderUpdatePanelHTML(
      renderInput({
        snapshot: updateSnapshot({ latestVersion: '0.4.3' }),
        checkPrejudge: prejudge(),
      })
    )
    assert.match(html, /可安装/, '新版本无窗口记录，按老样子')
    assert.match(html, /data-action="install"[^>]*title="[^"]*"[^>]*>(?!.*disabled)/, '主按钮可点')
    assert.doesNotMatch(html, /data-action="install-fallback"/, '不对没证据的版本给按钮')
  })

  it('记住的窗口已过期（够岁数了）：按正常检查页，主路能装了', () => {
    const html = renderUpdatePanelHTML(
      renderInput({ checkPrejudge: prejudge({ nowMs: UNLOCK_AT + 1 }) })
    )
    assert.match(html, /可安装/, '过期即恢复正常')
    assert.doesNotMatch(html, /data-action="install-fallback"/)
  })

  it('装不了（有阻拦原因）：走阻拦页，预判不掺和', () => {
    const html = renderUpdatePanelHTML(
      renderInput({
        snapshot: updateSnapshot({ canInstall: false, blockedReason: 'update-busy' }),
        checkPrejudge: prejudge(),
      })
    )
    assert.doesNotMatch(html, /data-action="install-fallback"/, '阻拦页不给合规版按钮')
  })

  it('决议已出候选：确认按钮点名版本，"装合规版"退场（与失败页同口径）', () => {
    const html = renderUpdatePanelHTML(
      renderInput({
        checkPrejudge: prejudge(),
        fallbackOffer: { candidate: '0.4.1', targetVersion: '0.4.2' },
      })
    )
    assert.match(html, /data-action="install-fallback-confirm"/)
    assert.match(html, /确认装 0\.4\.1/)
    assert.doesNotMatch(html, /data-action="install-fallback"/)
  })
})

describe('纯门 checkPrejudgeOfView（#156 场景二）', () => {
  it('对版、未过期、时钟正常 → 通过并原样带回目标与解封时刻', () => {
    const out = checkPrejudgeOfView(prejudge(), updateSnapshot())
    assert.deepEqual(out, { targetVersion: '0.4.2', unlockAtMs: UNLOCK_AT })
  })

  it('缺输入、无新版、不可装、对不上版、过期、无时钟 → 一律 null（不预判）', () => {
    assert.equal(checkPrejudgeOfView(null, updateSnapshot()), null)
    assert.equal(checkPrejudgeOfView(prejudge(), null), null)
    assert.equal(checkPrejudgeOfView(prejudge(), updateSnapshot({ latestVersion: null })), null)
    assert.equal(checkPrejudgeOfView(prejudge(), updateSnapshot({ canInstall: false })), null)
    assert.equal(checkPrejudgeOfView(prejudge({ targetVersion: '0.4.3' }), updateSnapshot()), null)
    assert.equal(checkPrejudgeOfView(prejudge({ nowMs: UNLOCK_AT }), updateSnapshot()), null)
    assert.equal(checkPrejudgeOfView(prejudge({ nowMs: null }), updateSnapshot()), null)
    assert.equal(checkPrejudgeOfView(prejudge({ unlockAtMs: Number.NaN }), updateSnapshot()), null)
  })
})

// ---------- 挂载整环：失败 → 等新版 → 检查页预判 → 装合规版 ----------

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

function failedSnapshot(pkg = 'p') {
  return updateSnapshot({
    job: { id: 'job-1', state: 'failed', targetVersion: '0.4.2', message: ageMessage(pkg), requestId: 'req-1' },
  })
}

async function settled(ms = 20) {
  await new Promise((r) => setTimeout(r, 10))
  await new Promise((r) => setTimeout(r, ms))
}

describe('挂载整环（#156 场景二）', () => {
  it('失败 → 等新版 → 检查页预判 → 装合规版 → 确认装候选', async () => {
    const seen = {}
    const { call, log } = scriptedCall({
      status: () => ({ ok: true, snapshot: failedSnapshot(), manual: null, receipt: null, queue: baseQueue() }),
      check: () => ({ ok: true, snapshot: updateSnapshot(), manual: null, receipt: null, queue: baseQueue() }),
      install: (name, args) => {
        seen.installArgs = args
        return {
          ok: true,
          snapshot: updateSnapshot({ job: { id: 'job-2', state: 'installing', targetVersion: '0.4.1', message: null, requestId: args.requestId } }),
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
    const box = fakeContainer()
    const panel = mountUpdatePanel(box, {
      pluginId: 'p',
      call,
      pollMs: 60000,
      copyText: async () => {},
      autoChangelog: false,
    })
    await panel.refresh()
    await settled()
    assert.match(box.innerHTML, /data-action="install-fallback"/, '失败页先给装合规版（场景一）')
    await panel.act('wait-latest')
    await settled()
    assert.match(box.innerHTML, /未满门/, '等新版后检查页预判接管，不再骗点')
    assert.match(box.innerHTML, /data-action="install"[^>]*disabled/, '主按钮置灰')
    assert.match(box.innerHTML, /data-action="install-fallback"/, '检查页给装合规版')
    await panel.act('install-fallback')
    await settled()
    assert.equal(seen.fallbackArgs.blame, 'target', '检查页决议沿用记住的归因')
    assert.equal(seen.fallbackArgs.targetVersion, '0.4.2')
    assert.equal(seen.fallbackArgs.windowMs, 1440 * 60_000, '检查页决议沿用记住的窗口')
    assert.match(box.innerHTML, /确认装 0\.4\.1/, '决议后点名版本二次确认')
    await panel.act('install-fallback-confirm')
    await settled()
    assert.equal(seen.installArgs.version, '0.4.1', '安装电话带上决议版本')
    assert.equal(seen.installArgs.checkId, 'fb-1')
    const installCalls = log.filter((e) => e.name.endsWith('.updateInstall'))
    assert.equal(installCalls.length, 1, '确认只装一次')
    panel.unmount()
  })

  it('跨挂载不断忆：关闭重开后点了等新版，检查页预判照样接管', async () => {
    const script = {
      status: () => ({ ok: true, snapshot: failedSnapshot('p-remount'), manual: null, receipt: null, queue: baseQueue() }),
      check: () => ({ ok: true, snapshot: updateSnapshot(), manual: null, receipt: null, queue: baseQueue() }),
      install: () => ({ ok: false, error: 'install-failed', errorKind: 'install-failed' }),
      fallback: () => ({ ok: true, snapshot: { verdict: { kind: 'abstain' }, candidate: null }, receipt: null }),
    }
    const mountOptions = (extraCall) => ({
      pluginId: 'p-remount',
      call: extraCall,
      pollMs: 60000,
      copyText: async () => {},
      autoChangelog: false,
    })
    const first = scriptedCall(script)
    const box1 = fakeContainer()
    const panel1 = mountUpdatePanel(box1, mountOptions(first.call))
    await panel1.refresh()
    await settled()
    assert.match(box1.innerHTML, /data-action="install-fallback"/, '首挂载失败页有按钮（锁存落跨挂载表）')
    panel1.unmount()
    // 新挂载的 remembered 是空的（内存不跨挂载），只能靠活锁存补记。
    const second = scriptedCall(script)
    const box2 = fakeContainer()
    const panel2 = mountUpdatePanel(box2, mountOptions(second.call))
    await panel2.refresh()
    await settled()
    assert.match(box2.innerHTML, /data-action="install-fallback"/, '重开后失败页仍在（锁存恢复）')
    await panel2.act('wait-latest')
    await settled()
    assert.match(box2.innerHTML, /未满门/, '重开后等新版，预判照样接管（补记生效）')
    assert.match(box2.innerHTML, /data-action="install-fallback"/, '检查页给装合规版')
    panel2.unmount()
  })

  it('远端出了新版：记住的旧窗口不对新版指手画脚', async () => {
    const { call } = scriptedCall({
      status: () => ({ ok: true, snapshot: failedSnapshot(), manual: null, receipt: null, queue: baseQueue() }),
      check: () => ({
        ok: true,
        snapshot: updateSnapshot({ latestVersion: '0.4.3', job: null }),
        manual: null,
        receipt: null,
        queue: baseQueue(),
      }),
      install: () => ({ ok: false, error: 'install-failed', errorKind: 'install-failed' }),
      fallback: () => ({ ok: true, snapshot: { verdict: { kind: 'abstain' }, candidate: null }, receipt: null }),
    })
    const box = fakeContainer()
    const panel = mountUpdatePanel(box, {
      pluginId: 'p',
      call,
      pollMs: 60000,
      copyText: async () => {},
      autoChangelog: false,
    })
    await panel.refresh()
    await settled()
    await panel.act('wait-latest')
    await settled()
    await panel.act('check')
    await settled()
    assert.match(box.innerHTML, /0\.4\.3/, '新版照常出现')
    assert.doesNotMatch(box.innerHTML, /data-action="install-fallback"/, '旧窗口不对新版给按钮')
    panel.unmount()
  })
})
