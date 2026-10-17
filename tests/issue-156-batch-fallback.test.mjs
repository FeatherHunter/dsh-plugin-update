/**
 * tests/issue-156-batch-fallback.test.mjs —— #156 批量行兜底。
 *
 * 只测外部行为：纯门（batchFallbackCauseOf / singleFallbackPhoneOf / singleInstallPhoneOf），
 * 纯渲染（renderBatchPanelHTML 行内 + 详情的装合规版/确认装X），挂载走公开入口
 * （mountUpdateBatchPanel + data-act 点击），电话走假传输。
 * 铁律：行内[重试]不动（仍是最新）；决议走该家自己的单插件电话；账本不记"已更新到最新"，
 * 随后 refresh 读回真快照是什么就是什么；B 类与认不出的失败不画按钮。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  batchFallbackCauseOf,
  mountUpdateBatchPanel,
  renderBatchPanelHTML,
  singleFallbackPhoneOf,
  singleInstallPhoneOf,
} from '../dist/panel-batch.js'

// 现场实证形状（issue-156-panel.test.mjs 同源，插件标识 p）。
const AGE_MESSAGE = [
  'install-failed: ✗ p@0.4.2: This version was published less than 1440 minutes ago (2026-10-16T05:58:34.000Z).',
  'The minimumReleaseAge cutoff for this version is 2026-10-15T07:34:55.413Z.',
  '',
  'Failed to install p@0.4.2.',
  'Command failed with exit code 1: pnpm add -g p@0.4.2',
  '[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION]',
].join('\n')
const OTHER_MESSAGE = AGE_MESSAGE.replaceAll('p@0.4.2', 'other@9.9.9').replaceAll(' p@', ' other@')

const ROW_PHONES = {
  updateCheck: 'p.updateCheck',
  updateInstall: 'p.updateInstall',
  updateCheckFallback: 'p.updateCheckFallback',
}

function failedRow(over = {}) {
  return {
    key: 'p',
    title: 'P 插件',
    phase: 'failed',
    targetVersion: '0.4.2',
    restartRequired: false,
    error: 'install-failed',
    snapshot: {
      runningVersion: '0.4.0',
      installedVersion: '0.4.0',
      latestVersion: '0.4.2',
      canInstall: false,
      job: { id: 'job-1', state: 'failed', targetVersion: '0.4.2', message: AGE_MESSAGE, requestId: 'req-1' },
    },
    manual: null,
    queue: null,
    profileName: null,
    pluginId: 'p',
    phoneNames: { ...ROW_PHONES },
    ...over,
  }
}

describe('纯门', () => {
  it('拦的正是该行目标：给出结论', () => {
    const cause = batchFallbackCauseOf(failedRow())
    assert.ok(cause)
    assert.equal(cause.targetVersion, '0.4.2')
    assert.equal(cause.kind, 'minimum-release-age')
  })

  it('B 类（别家包）：null', () => {
    const row = failedRow({
      snapshot: {
        runningVersion: '0.4.0',
        installedVersion: '0.4.0',
        latestVersion: '0.4.2',
        canInstall: false,
        job: { id: 'job-1', state: 'failed', targetVersion: '0.4.2', message: OTHER_MESSAGE, requestId: 'req-1' },
      },
    })
    assert.equal(batchFallbackCauseOf(row), null)
  })

  it('认不出的失败：null', () => {
    const row = failedRow({
      snapshot: {
        runningVersion: '0.4.0',
        installedVersion: '0.4.0',
        latestVersion: '0.4.2',
        canInstall: false,
        job: { id: 'job-1', state: 'failed', targetVersion: '0.4.2', message: 'install-failed: plain boom', requestId: 'req-1' },
      },
    })
    assert.equal(batchFallbackCauseOf(row), null)
  })

  it('非失败行：null（旧失败不指手画脚）', () => {
    assert.equal(batchFallbackCauseOf(failedRow({ phase: 'ready' })), null)
  })

  it('候选目标对不上当前远端：null', () => {
    const row = failedRow({
      targetVersion: '0.4.3',
      snapshot: {
        runningVersion: '0.4.0',
        installedVersion: '0.4.0',
        latestVersion: '0.4.3',
        canInstall: false,
        job: { id: 'job-1', state: 'failed', targetVersion: '0.4.2', message: AGE_MESSAGE, requestId: 'req-1' },
      },
    })
    assert.equal(batchFallbackCauseOf(row), null)
  })

  it('行电话透传：有即给，无即 null（老宿主诚实缺省）', () => {
    assert.equal(singleFallbackPhoneOf(failedRow()), 'p.updateCheckFallback')
    assert.equal(singleInstallPhoneOf(failedRow()), 'p.updateInstall')
    assert.equal(singleFallbackPhoneOf(failedRow({ phoneNames: null })), null)
    assert.equal(singleFallbackPhoneOf(failedRow({ phoneNames: {} })), null)
    assert.equal(singleInstallPhoneOf(failedRow({ phoneNames: null })), null)
  })
})

describe('纯渲染', () => {
  it('失败行有资格：行内给装合规版，重试不动', () => {
    const html = renderBatchPanelHTML({ rows: [failedRow()], lang: 'zh' })
    assert.match(html, /data-act="row-fallback"/)
    assert.match(html, /装合规版/)
    assert.match(html, /data-act="row-install"/)
  })

  it('有候选：行内换确认装X，点名精确版本', () => {
    const html = renderBatchPanelHTML({
      rows: [failedRow()],
      fallbackOffers: { p: { candidate: '0.4.1', targetVersion: '0.4.2' } },
      lang: 'zh',
    })
    assert.match(html, /data-act="row-fallback-confirm"/)
    assert.match(html, /确认装 0\.4\.1/)
  })

  it('旧决议（目标对不上）：忽略，不画错按钮', () => {
    const html = renderBatchPanelHTML({
      rows: [failedRow()],
      fallbackOffers: { p: { candidate: '0.4.1', targetVersion: '0.4.9' } },
      lang: 'zh',
    })
    assert.doesNotMatch(html, /data-act="row-fallback-confirm"/)
    assert.match(html, /data-act="row-fallback"/)
  })

  it('B 类失败：不画兜底按钮，重试仍在', () => {
    const row = failedRow({
      snapshot: {
        runningVersion: '0.4.0',
        installedVersion: '0.4.0',
        latestVersion: '0.4.2',
        canInstall: false,
        job: { id: 'job-1', state: 'failed', targetVersion: '0.4.2', message: OTHER_MESSAGE, requestId: 'req-1' },
      },
    })
    const html = renderBatchPanelHTML({ rows: [row], lang: 'zh' })
    assert.doesNotMatch(html, /data-act="row-fallback"/)
    assert.doesNotMatch(html, /data-act="row-fallback-confirm"/)
    assert.match(html, /data-act="row-install"/)
  })

  it('老宿主无决议电话：不画兜底按钮', () => {
    const html = renderBatchPanelHTML({ rows: [failedRow({ phoneNames: { updateInstall: 'p.updateInstall' } })], lang: 'zh' })
    assert.doesNotMatch(html, /data-act="row-fallback"/)
  })

  it('展开详情同样给选择', () => {
    const html = renderBatchPanelHTML({ rows: [failedRow()], expandedKey: 'p', lang: 'zh' })
    assert.match(html, /data-act="row-fallback"/)
  })

  it('批量级：有年龄门失败行即给「装合规版」入口，并点名列里是哪几家', () => {
    const html = renderBatchPanelHTML({ rows: [failedRow()], lang: 'zh' })
    assert.match(html, /data-act="batch-fallback-scan"/)
    assert.match(html, /个插件的最新版被 24 小时年龄门挡住/)
    assert.match(html, /装合规版/)
    assert.match(html, /P 插件/)
  })

  it('批量级：有决议即换「确认装这 N 个」，清单点名到精确版本', () => {
    const html = renderBatchPanelHTML({
      rows: [failedRow()],
      compliant: { gated: 1, confirmList: 'P 插件 0.4.1', confirmCount: 1, busy: false },
      lang: 'zh',
    })
    assert.match(html, /data-act="batch-fallback-confirm"/)
    assert.match(html, /确认安装以下合规版：P 插件 0\.4\.1？/)
    assert.match(html, /确认装这 1 个/)
    assert.doesNotMatch(html, /data-act="batch-fallback-scan"/)
  })

  // M1 诚实性（2026-10-17 对抗审查）：账本相位是 failed、error 是 pending-restart 的行，
  // 真身是"磁盘上已经有更新版、只差重启生效"——把它算进"N 个插件安装失败"是冤枉它
  // （目标版确实没装上，所以账本相位一个字不改），该待的位置是"等重启"那一栏。
  it('等重启的行不算安装失败：从失败横幅挪到等重启横幅，相位仍如实是 failed', () => {
    const row = failedRow({
      error: 'pending-restart',
      snapshot: {
        runningVersion: '0.4.0',
        installedVersion: '0.4.1',
        latestVersion: '0.4.2',
        canInstall: false,
        blockedReason: 'pending-restart',
        job: { id: 'job-2', state: 'restart-required', targetVersion: '0.4.1', message: null, requestId: 'req-2' },
      },
    })
    const html = renderBatchPanelHTML({ rows: [row], lang: 'zh' })
    assert.doesNotMatch(html, /个插件安装失败/)
    assert.match(html, /个已安装完成，重启宿主后生效/)
    assert.match(html, /P 插件/)
    assert.match(html, /data-act="restart"/)
    // 相位不被篡改：行本身仍是 failed（面板不替账本改相位，#152 纪律）。
    assert.equal(batchFallbackCauseOf(row), null, '等重启不是年龄门失败，不该再给兜底按钮')
  })

  it('真失败（install-failed）仍留在失败横幅里，不被这一刀误伤', () => {
    const html = renderBatchPanelHTML({ rows: [failedRow()], lang: 'zh' })
    assert.match(html, /个插件安装失败/)
    assert.doesNotMatch(html, /已安装完成，重启宿主后生效/)
  })

  it('批量级：在途即置灰，防连点', () => {
    const html = renderBatchPanelHTML({
      rows: [failedRow()],
      compliant: { gated: 1, confirmList: null, confirmCount: 0, busy: true },
      lang: 'zh',
    })
    assert.match(html, /data-act="batch-fallback-scan"[^>]*disabled/)
  })

  it('批量级：B 类/老宿主无电话的行不进名单，也不画入口', () => {
    const other = failedRow({
      snapshot: {
        runningVersion: '0.4.0',
        installedVersion: '0.4.0',
        latestVersion: '0.4.2',
        canInstall: false,
        job: { id: 'job-1', state: 'failed', targetVersion: '0.4.2', message: OTHER_MESSAGE, requestId: 'req-1' },
      },
    })
    const noPhone = failedRow({ phoneNames: { updateInstall: 'p.updateInstall' } })
    assert.doesNotMatch(renderBatchPanelHTML({ rows: [other], lang: 'zh' }), /data-act="batch-fallback-scan"/)
    assert.doesNotMatch(renderBatchPanelHTML({ rows: [noPhone], lang: 'zh' }), /data-act="batch-fallback-scan"/)
  })

  // 等解封（#156 诚实性）：确实没有可装版时如实说等多久，不画一个点了也没用的按钮。
  it('批量级：等解封——说清是谁、等多久，不画假按钮，该行也不给兜底按钮', () => {
    const unlockAtMs = Date.now() + 3 * 3600 * 1000
    const html = renderBatchPanelHTML({
      rows: [failedRow()],
      compliant: { gated: 0, confirmList: null, confirmCount: 0, busy: false, wait: { keys: ['p'], unlockAtMs } },
      lang: 'zh',
    })
    assert.match(html, /现在还没有可装的版本/)
    assert.match(html, /P 插件/)
    assert.doesNotMatch(html, /data-act="batch-fallback-confirm"/)
    assert.doesNotMatch(html, /data-act="batch-fallback-scan"/)
    assert.doesNotMatch(html, /data-act="row-fallback"/)
    assert.match(html, /data-act="row-install"/)
  })

  // 收尾事实（#156 第一性原理）：账本目标没装成、但这家已经装上能装的最新——
  // 不许再算成「安装失败」，也不再劝装；结果如实写在「实际安装结果」里，重启入口照给。
  it('收尾事实：已装合规版的行不算失败，且如实点名装了哪版、最新那版还挡多久', () => {
    const unlockAtMs = Date.now() + 2 * 3600 * 1000
    const row = failedRow({
      snapshot: {
        runningVersion: '0.4.0',
        installedVersion: '0.4.1',
        latestVersion: '0.4.2',
        canInstall: false,
        job: { id: 'job-3', state: 'restart-required', targetVersion: '0.4.1', message: null, requestId: 'req-3' },
      },
    })
    const html = renderBatchPanelHTML({
      rows: [row],
      compliant: { gated: 0, confirmList: null, confirmCount: 0, busy: false, unlocks: { p: unlockAtMs } },
      lang: 'zh',
    })
    assert.doesNotMatch(html, /个插件安装失败/)
    // 行里那句「失败 install-failed」也是撒谎：状态字换成「已安装完成，重启宿主后生效。」，
    // 红字换成同一件事实；圆点从红换黄（装上了，但还差重启）。（"非安装失败"那种否定句不算撒谎。）
    assert.doesNotMatch(html, /失败 install-failed/)
    assert.match(html, /已安装完成，重启宿主后生效。/)
    assert.match(html, /已装 0\.4\.1，不是最新 0\.4\.2/)
    assert.match(html, /data-tone="warn"/)
    assert.match(html, /这 1 个插件的实际安装结果：/)
    assert.match(html, /已装 0\.4\.1/)
    assert.match(html, /最新 0\.4\.2 仍被 24 小时年龄门挡着/)
    assert.doesNotMatch(html, /data-act="batch-fallback-confirm"/)
    assert.doesNotMatch(html, /data-act="row-fallback"/)
    assert.match(html, /data-act="row-install"/)
    // 装上的是合规版、要重启才生效：重启入口照给（这一行不是"安装失败"，但确实还差重启）。
    assert.match(html, /data-act="restart"/)
    // 账本相位一个字不改（#152）：行本身仍是 failed。
    assert.equal(row.phase, 'failed')
  })

  // 不用重启的收尾（job=completed）：行是绿的、也不劝装，账本相位照样不动。
  it('收尾事实：装完就能用的合规版，行是绿的（不是红的、也不是"待重启"）', () => {
    const row = failedRow({
      snapshot: {
        runningVersion: '0.4.1',
        installedVersion: '0.4.1',
        latestVersion: '0.4.2',
        canInstall: false,
        job: { id: 'job-4', state: 'completed', targetVersion: '0.4.1', message: null, requestId: 'req-4' },
      },
    })
    const html = renderBatchPanelHTML({
      rows: [row],
      compliant: { gated: 0, confirmList: null, confirmCount: 0, busy: false },
      lang: 'zh',
    })
    assert.doesNotMatch(html, /失败 install-failed/)
    assert.match(html, /已安装完成，无需操作。/)
    assert.match(html, /已装 0\.4\.1，不是最新 0\.4\.2/)
    assert.match(html, /data-tone="ok"/)
    assert.doesNotMatch(html, /data-act="row-fallback"/)
    assert.doesNotMatch(html, /data-act="restart"/)
    assert.equal(row.phase, 'failed')
  })
})

function fakeContainer() {
  const listeners = []
  return {
    innerHTML: '',
    listeners,
    addEventListener(type, fn) {
      if (type === 'click') listeners.push(fn)
    },
    removeEventListener(type, fn) {
      const at = listeners.indexOf(fn)
      if (at >= 0) listeners.splice(at, 1)
    },
  }
}

function clickAct(box, act, key) {
  const attrs = {}
  if (act) attrs['data-act'] = act
  if (key !== undefined) attrs['data-key'] = key
  const el = { getAttribute: (name) => (name in attrs ? attrs[name] : null) }
  const target = { closest: (sel) => (sel === '[data-act]' && attrs['data-act'] ? el : null) }
  for (const fn of [...box.listeners]) fn({ target })
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))
const flush = async (n = 10) => {
  for (let i = 0; i < n; i++) await settled()
}

function sessionOf(rows) {
  return {
    version: 1,
    id: 's1',
    selfKey: null,
    stopOnFailure: false,
    order: rows.map((r) => r.key),
    entries: rows.map((r) => ({ key: r.key, phase: r.phase, requestId: 'batch:s1:' + r.key, targetVersion: r.targetVersion, restartRequired: false, error: r.error, updatedAt: 1 })),
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('挂载行级决议确认流', () => {
  it('点装合规版调该家决议电话；有候选即确认装X；确认后安装带 version', async () => {
    const rows = [failedRow()]
    const log = []
    const call = async (name, args) => {
      log.push({ name, args })
      if (name === 'life.batchStatus') return { ok: true, session: sessionOf(rows), rows, progress: {} }
      if (name === 'p.updateCheckFallback') {
        return { ok: true, snapshot: { verdict: { kind: 'downgrade-available', version: '0.4.1' }, candidate: '0.4.1' }, receipt: { checkId: 'fb-7', checkedAt: 1, expiresAt: 9999999999999 } }
      }
      if (name === 'p.updateInstall') return { ok: true, snapshot: rows[0].snapshot }
      throw new Error('unknown-phone:' + name)
    }
    const box = fakeContainer()
    const panel = mountUpdateBatchPanel(box, { prefix: 'life', call, pollMs: 60000, autoResume: false, checkOnOpen: false, autoCompliant: false })
    await flush()
    assert.match(box.innerHTML, /data-act="row-fallback"/)
    assert.equal(log.filter((e) => e.name === 'p.updateInstall').length, 0)

    clickAct(box, 'row-fallback', 'p')
    await flush()
    const fb = log.filter((e) => e.name === 'p.updateCheckFallback')
    assert.equal(fb.length, 1)
    assert.equal(fb[0].args.targetVersion, '0.4.2')
    assert.equal(fb[0].args.blame, 'target')
    assert.match(box.innerHTML, /data-act="row-fallback-confirm"/)
    assert.match(box.innerHTML, /确认装 0\.4\.1/)

    clickAct(box, 'row-fallback-confirm', 'p')
    await flush()
    const installs = log.filter((e) => e.name === 'p.updateInstall')
    assert.equal(installs.length, 1)
    assert.equal(installs[0].args.version, '0.4.1')
    assert.equal(installs[0].args.checkId, 'fb-7')
    assert.ok(typeof installs[0].args.requestId === 'string' && installs[0].args.requestId.length > 0)
    // 候选安装不走批量账本：batchInstall 全程零调用。
    assert.equal(log.filter((e) => e.name === 'life.batchInstall').length, 0)
    panel.unmount()
  })

  it('确认时宿主忙（update-busy）：候选留着再点一次，不说成"用不上合规版"（m3）', async () => {
    const rows = [failedRow()]
    const log = []
    let reply = { ok: false, error: 'update-busy', errorKind: 'update-busy' }
    const call = async (name, args) => {
      log.push({ name, args })
      if (name === 'life.batchStatus') return { ok: true, session: sessionOf(rows), rows, progress: {} }
      if (name === 'p.updateCheckFallback') {
        return { ok: true, snapshot: { verdict: { kind: 'downgrade-available', version: '0.4.1' }, candidate: '0.4.1' }, receipt: { checkId: 'fb-7', checkedAt: 1, expiresAt: 9999999999999 } }
      }
      if (name === 'p.updateInstall') return reply
      throw new Error('unknown-phone:' + name)
    }
    const box = fakeContainer()
    const panel = mountUpdateBatchPanel(box, { prefix: 'life', call, pollMs: 60000, autoResume: false, checkOnOpen: false, autoCompliant: false })
    await flush()
    clickAct(box, 'row-fallback', 'p')
    await flush()
    assert.match(box.innerHTML, /data-act="row-fallback-confirm"/)

    clickAct(box, 'row-fallback-confirm', 'p')
    await flush()
    assert.equal(log.filter((e) => e.name === 'p.updateInstall').length, 1)
    // 忙不是"没戏"：候选留着（凭证还在有效期内），提示说的是稍后再来。
    assert.match(box.innerHTML, /data-act="row-fallback-confirm"/)
    assert.match(box.innerHTML, /前方仍在安装/)

    // 真被核心拒了（凭证过期/复核不过）才撤候选：下次得重新决议，不拿旧凭证硬撞。
    reply = { ok: false, error: 'check-expired', errorKind: 'check-expired' }
    clickAct(box, 'row-fallback-confirm', 'p')
    await flush()
    assert.equal(log.filter((e) => e.name === 'p.updateInstall').length, 2)
    assert.doesNotMatch(box.innerHTML, /data-act="row-fallback-confirm"/)
    assert.match(box.innerHTML, /data-act="row-fallback"/)
    panel.unmount()
  })

  it('老宿主无决议电话：给通用提醒，不碎', async () => {
    const rows = [failedRow({ phoneNames: { updateCheck: 'p.updateCheck', updateInstall: 'p.updateInstall' } })]
    const log = []
    const call = async (name) => {
      log.push({ name })
      if (name === 'life.batchStatus') return { ok: true, session: sessionOf(rows), rows, progress: {} }
      throw new Error('unknown-phone:' + name)
    }
    const box = fakeContainer()
    const panel = mountUpdateBatchPanel(box, { prefix: 'life', call, pollMs: 60000, autoResume: false, checkOnOpen: false, autoCompliant: false })
    await flush()
    // 无电话即无按钮（诚实缺省），面板照常渲染。
    assert.doesNotMatch(box.innerHTML, /data-act="row-fallback"/)
    assert.match(box.innerHTML, /data-act="row-install"/)
    panel.unmount()
  })
})

const Q_MESSAGE = AGE_MESSAGE.replaceAll('p@', 'q@')

function qRow(over = {}) {
  const base = failedRow()
  return failedRow({
    key: 'q',
    title: 'Q 插件',
    pluginId: 'q',
    phoneNames: { updateCheck: 'q.updateCheck', updateInstall: 'q.updateInstall', updateCheckFallback: 'q.updateCheckFallback' },
    snapshot: { ...base.snapshot, job: { ...base.snapshot.job, message: Q_MESSAGE } },
    ...over,
  })
}

describe('挂载批量级决议确认流（#156 全部更新那一步的出路）', () => {
  it('点批量装合规版：逐家决议；点名清单；确认后逐家带 version 装，且不冒充已更新到最新', async () => {
    const rows = [failedRow(), qRow()]
    const log = []
    const call = async (name, args) => {
      log.push({ name, args })
      if (name === 'life.batchStatus') return { ok: true, session: sessionOf(rows), rows, progress: {} }
      if (name === 'p.updateCheckFallback') {
        return { ok: true, snapshot: { verdict: { kind: 'downgrade-available', version: '0.4.1' }, candidate: '0.4.1' }, receipt: { checkId: 'fb-p' } }
      }
      if (name === 'q.updateCheckFallback') {
        return { ok: true, snapshot: { verdict: { kind: 'downgrade-available', version: '0.3.9' }, candidate: '0.3.9' }, receipt: { checkId: 'fb-q' } }
      }
      if (name === 'p.updateInstall' || name === 'q.updateInstall') return { ok: true, snapshot: rows[0].snapshot }
      throw new Error('unknown-phone:' + name)
    }
    const box = fakeContainer()
    const panel = mountUpdateBatchPanel(box, { prefix: 'life', call, pollMs: 60000, autoResume: false, checkOnOpen: false, autoCompliant: false })
    await flush()
    assert.match(box.innerHTML, /data-act="batch-fallback-scan"/)

    clickAct(box, 'batch-fallback-scan')
    await flush()
    assert.equal(log.filter((e) => e.name === 'p.updateCheckFallback').length, 1)
    assert.equal(log.filter((e) => e.name === 'q.updateCheckFallback').length, 1)
    assert.match(box.innerHTML, /data-act="batch-fallback-confirm"/)
    assert.match(box.innerHTML, /P 插件 0\.4\.1/)
    assert.match(box.innerHTML, /Q 插件 0\.3\.9/)
    // 决议本身不装任何东西。
    assert.equal(log.filter((e) => e.name === 'p.updateInstall').length, 0)

    clickAct(box, 'batch-fallback-confirm')
    await flush()
    const pInstall = log.filter((e) => e.name === 'p.updateInstall')
    const qInstall = log.filter((e) => e.name === 'q.updateInstall')
    assert.equal(pInstall.length, 1)
    assert.equal(qInstall.length, 1)
    assert.equal(pInstall[0].args.version, '0.4.1')
    assert.equal(pInstall[0].args.checkId, 'fb-p')
    assert.equal(qInstall[0].args.version, '0.3.9')
    assert.equal(qInstall[0].args.checkId, 'fb-q')
    // 意图来源如实自报（#124）：批量横幅发起的确认，不是用户点单插件面板。
    assert.equal(pInstall[0].args.from, 'batch')
    assert.equal(qInstall[0].args.from, 'batch')
    // 合规版安装不冒充"已更新到最新"：批量账本安装电话零调用。
    assert.equal(log.filter((e) => e.name === 'life.batchInstall').length, 0)
    assert.doesNotMatch(box.innerHTML, /data-act="batch-fallback-confirm"/)
    panel.unmount()
  })

  it('只有一家有候选：清单只点名那一家，另一家不冒充', async () => {
    const rows = [failedRow(), qRow()]
    const call = async (name) => {
      if (name === 'life.batchStatus') return { ok: true, session: sessionOf(rows), rows, progress: {} }
      if (name === 'p.updateCheckFallback') {
        return { ok: true, snapshot: { verdict: { kind: 'downgrade-available', version: '0.4.1' }, candidate: '0.4.1' }, receipt: { checkId: 'fb-p' } }
      }
      if (name === 'q.updateCheckFallback') return { ok: false, error: 'check-failed', errorKind: 'registry-fetch-failed' }
      throw new Error('unknown-phone:' + name)
    }
    const box = fakeContainer()
    const panel = mountUpdateBatchPanel(box, { prefix: 'life', call, pollMs: 60000, autoResume: false, checkOnOpen: false, autoCompliant: false })
    await flush()
    clickAct(box, 'batch-fallback-scan')
    await flush()
    assert.match(box.innerHTML, /确认安装以下合规版：P 插件 0\.4\.1？/)
    assert.doesNotMatch(box.innerHTML, /Q 插件 0\.3\.9/)
    assert.match(box.innerHTML, /确认装这 1 个/)
    panel.unmount()
  })

  it('批量确认里某家忙（update-busy）：该家候选留着、确认条还在，不报成"没装成"（m3）', async () => {
    const rows = [failedRow(), qRow()]
    const log = []
    const call = async (name, args) => {
      log.push({ name, args })
      if (name === 'life.batchStatus') return { ok: true, session: sessionOf(rows), rows, progress: {} }
      if (name === 'p.updateCheckFallback') {
        return { ok: true, snapshot: { verdict: { kind: 'downgrade-available', version: '0.4.1' }, candidate: '0.4.1' }, receipt: { checkId: 'fb-p' } }
      }
      if (name === 'q.updateCheckFallback') {
        return { ok: true, snapshot: { verdict: { kind: 'downgrade-available', version: '0.3.9' }, candidate: '0.3.9' }, receipt: { checkId: 'fb-q' } }
      }
      if (name === 'p.updateInstall') return { ok: false, error: 'update-busy', errorKind: 'update-busy' }
      if (name === 'q.updateInstall') return { ok: true, snapshot: rows[1].snapshot }
      throw new Error('unknown-phone:' + name)
    }
    const box = fakeContainer()
    const panel = mountUpdateBatchPanel(box, { prefix: 'life', call, pollMs: 60000, autoResume: false, checkOnOpen: false, autoCompliant: false })
    await flush()
    clickAct(box, 'batch-fallback-scan')
    await flush()
    assert.match(box.innerHTML, /确认装这 2 个/)
    clickAct(box, 'batch-fallback-confirm')
    await flush()
    assert.equal(log.filter((e) => e.name === 'p.updateInstall').length, 1)
    assert.equal(log.filter((e) => e.name === 'q.updateInstall').length, 1)
    // q 家装成、p 家忙：两件事都如实说（装成的照报 + 忙的稍后再来），p 的候选留着 → 确认条还在。
    assert.match(box.innerHTML, /data-act="batch-fallback-confirm"/)
    assert.match(box.innerHTML, /确认装这 1 个/)
    assert.match(box.innerHTML, /已请求安装 1 个合规版/)
    assert.match(box.innerHTML, /前方仍在安装/)
    assert.equal(log.filter((e) => e.name === 'life.batchInstall').length, 0)
    panel.unmount()
  })

  it('全都没候选（还没出门限）：给等待提醒，不画确认条', async () => {
    const rows = [failedRow()]
    const call = async (name) => {
      if (name === 'life.batchStatus') return { ok: true, session: sessionOf(rows), rows, progress: {} }
      if (name === 'p.updateCheckFallback') {
        return {
          ok: true,
          snapshot: { verdict: { kind: 'wait-until', version: '0.4.2', unlockAtMs: Date.UTC(2026, 9, 18, 3, 0, 0) } },
          receipt: { checkId: 'fb-p' },
        }
      }
      throw new Error('unknown-phone:' + name)
    }
    const box = fakeContainer()
    const panel = mountUpdateBatchPanel(box, { prefix: 'life', call, pollMs: 60000, autoResume: false, checkOnOpen: false, autoCompliant: false })
    await flush()
    clickAct(box, 'batch-fallback-scan')
    await flush()
    assert.doesNotMatch(box.innerHTML, /data-act="batch-fallback-confirm"/)
    // 问过、确实还没出门限：如实说等多久（不画一个点了也没用的重试按钮——解封时刻一到，
    // 自动决议会重新问一次，签名变了就会再问）。
    assert.doesNotMatch(box.innerHTML, /data-act="batch-fallback-scan"/)
    assert.match(box.innerHTML, /可装/)
    panel.unmount()
  })
})

// #156 第一性原理（用户 2026-10-17 裁决）：撞了 24 小时年龄门之后，用户要的是「能装的最新」，
// 不是「自己去点按钮找一遍」。默认自动决议：开面板/刷新后自己逐家问，有候选直接端确认条。
describe('挂载自动决议（不用先找到按钮）', () => {
  it('开面板撞了年龄门：自己逐家决议，直接把点名确认条端上来（batchInstall 仍零调用）', async () => {
    const rows = [failedRow(), qRow()]
    const log = []
    const call = async (name, args) => {
      log.push({ name, args })
      if (name === 'life.batchStatus') return { ok: true, session: sessionOf(rows), rows, progress: {} }
      if (name === 'p.updateCheckFallback') {
        return { ok: true, snapshot: { verdict: { kind: 'downgrade-available', version: '0.4.1' }, candidate: '0.4.1' }, receipt: { checkId: 'fb-p' } }
      }
      if (name === 'q.updateCheckFallback') {
        return { ok: true, snapshot: { verdict: { kind: 'downgrade-available', version: '0.3.9' }, candidate: '0.3.9' }, receipt: { checkId: 'fb-q' } }
      }
      if (name === 'p.updateInstall' || name === 'q.updateInstall') return { ok: true, snapshot: rows[0].snapshot }
      throw new Error('unknown-phone:' + name)
    }
    const box = fakeContainer()
    const panel = mountUpdateBatchPanel(box, { prefix: 'life', call, pollMs: 60000, autoResume: false, checkOnOpen: false })
    await flush(20)
    // 一个按钮都没点：两家都已经问过了。
    assert.equal(log.filter((e) => e.name === 'p.updateCheckFallback').length, 1)
    assert.equal(log.filter((e) => e.name === 'q.updateCheckFallback').length, 1)
    assert.match(box.innerHTML, /data-act="batch-fallback-confirm"/)
    assert.match(box.innerHTML, /P 插件 0\.4\.1/)
    assert.match(box.innerHTML, /Q 插件 0\.3\.9/)
    assert.equal(log.filter((e) => e.name === 'life.batchInstall').length, 0)

    // 决议只跑一次：再刷新一轮也不重复问同一家（签名去重）。
    panel.refresh()
    await flush(20)
    assert.equal(log.filter((e) => e.name === 'p.updateCheckFallback').length, 1)
    assert.equal(log.filter((e) => e.name === 'q.updateCheckFallback').length, 1)
    panel.unmount()
  })

  it('全都没候选：自动决议一遍后如实说等多久，不画确认条、不画重试按钮、该行也不给兜底按钮', async () => {
    const rows = [failedRow()]
    const unlockAtMs = Date.now() + 5 * 3600 * 1000
    const log = []
    const call = async (name, args) => {
      log.push({ name, args })
      if (name === 'life.batchStatus') return { ok: true, session: sessionOf(rows), rows, progress: {} }
      if (name === 'p.updateCheckFallback') {
        return { ok: true, snapshot: { verdict: { kind: 'wait-until', version: '0.4.2', unlockAtMs }, candidate: null }, receipt: null }
      }
      throw new Error('unknown-phone:' + name)
    }
    const box = fakeContainer()
    const panel = mountUpdateBatchPanel(box, { prefix: 'life', call, pollMs: 60000, autoResume: false, checkOnOpen: false })
    await flush(20)
    assert.equal(log.filter((e) => e.name === 'p.updateCheckFallback').length, 1)
    assert.match(box.innerHTML, /现在还没有可装的版本/)
    assert.match(box.innerHTML, /P 插件/)
    assert.doesNotMatch(box.innerHTML, /data-act="batch-fallback-confirm"/)
    assert.doesNotMatch(box.innerHTML, /data-act="batch-fallback-scan"/)
    assert.doesNotMatch(box.innerHTML, /data-act="row-fallback"/)
    assert.match(box.innerHTML, /data-act="row-install"/)
    panel.unmount()
  })

  it('装上之后不再自动问同一家：刚装过的不会又端一次确认条', async () => {
    const rows = [failedRow()]
    const log = []
    const call = async (name, args) => {
      log.push({ name, args })
      if (name === 'life.batchStatus') return { ok: true, session: sessionOf(rows), rows, progress: {} }
      if (name === 'p.updateCheckFallback') {
        return { ok: true, snapshot: { verdict: { kind: 'downgrade-available', version: '0.4.1' }, candidate: '0.4.1' }, receipt: { checkId: 'fb-p' } }
      }
      if (name === 'p.updateInstall') return { ok: true, snapshot: rows[0].snapshot }
      throw new Error('unknown-phone:' + name)
    }
    const box = fakeContainer()
    const panel = mountUpdateBatchPanel(box, { prefix: 'life', call, pollMs: 60000, autoResume: false, checkOnOpen: false })
    await flush(20)
    assert.match(box.innerHTML, /data-act="batch-fallback-confirm"/)
    clickAct(box, 'batch-fallback-confirm')
    await flush(20)
    assert.equal(log.filter((e) => e.name === 'p.updateInstall').length, 1)
    assert.equal(log.filter((e) => e.name === 'p.updateInstall')[0].args.version, '0.4.1')
    assert.doesNotMatch(box.innerHTML, /data-act="batch-fallback-confirm"/)
    // 装完不重复问：决议电话全程只打了一次。
    assert.equal(log.filter((e) => e.name === 'p.updateCheckFallback').length, 1)
    panel.unmount()
  })
})
