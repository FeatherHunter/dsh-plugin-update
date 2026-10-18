/**
 * tests/install-button.test.mjs —— #148：槽位级“安装”按钮控件。
 *
 * 只测外部行为：挂上、看 HTML、点按钮、看电话记录。
 * 传输与容器全用假件，不碰真机、不真联网、不真装。
 * 铁律（与入口件同一条）：挂载与检查永不调 updateInstall——整个生命周期断言。
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { installButtonViewModel, mountInstallButton } from '../dist/install-button.js'

function absentInstallable(over = {}) {
  return {
    runningVersion: '0.0.0',
    installed: false,
    installedVersion: null,
    latestVersion: '0.3.54',
    canInstall: true,
    blockedReason: null,
    job: null,
    ...over,
  }
}

function baseQueue(over = {}) {
  return { busy: false, owner: null, waiting: [], position: null, ...over }
}

function statusReply(snapshot, extra = {}) {
  return { ok: true, snapshot, manual: null, receipt: null, queue: baseQueue(), ...extra }
}

function checkReply(snapshot, extra = {}) {
  return {
    ok: true,
    snapshot,
    manual: 'dsh plugin --profile web add --save-exact dsh-bill-ilife@0.3.54 --registry=https://registry.npmjs.org/',
    receipt: { checkId: 'check-1', checkedAt: 1, expiresAt: 999 },
    queue: baseQueue(),
    ...extra,
  }
}

function failedReply(code, kind, extra = {}) {
  return { ok: false, error: code, errorKind: kind, queue: baseQueue(), ...extra }
}

/** 假传输：按电话名回剧本，并记下每一次调用。 */
function fakeCall(script = {}) {
  const log = []
  const pick = (s, fallback) => (typeof s === 'function' ? s(log) : s === undefined ? fallback : s)
  const call = async (name, args) => {
    log.push({ name, args })
    if (name.endsWith('.updateStatus')) return pick(script.status, statusReply(absentInstallable()))
    if (name.endsWith('.updateCheck')) return pick(script.check, checkReply(absentInstallable()))
    if (name.endsWith('.updateInstall')) return pick(script.install, statusReply(absentInstallable()))
    if (name.endsWith('.logAppend')) return { accepted: 0, dropped: 0 }
    throw new Error('unknown-phone:' + name)
  }
  return { call, log }
}

function callsOf(log, suffix) {
  return log.filter((e) => e.name.endsWith(suffix))
}

/** 假容器：innerHTML + 事件能力（与面板/入口同一契约，不许要求 querySelector）。 */
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

/** 计时器桩：只收不跑，滴答由测试手动给；恢复全局。 */
let timerFns = []
let origSet = null
let origClear = null
beforeEach(() => {
  timerFns = []
  origSet = globalThis.setInterval
  origClear = globalThis.clearInterval
  globalThis.setInterval = (fn) => {
    timerFns.push(fn)
    return timerFns.length
  }
  globalThis.clearInterval = () => {}
})
afterEach(() => {
  globalThis.setInterval = origSet
  globalThis.clearInterval = origClear
})

async function settledMount(options, script = {}) {
  const { call, log } = fakeCall(script)
  const container = fakeContainer()
  const btn = mountInstallButton(container, { pluginId: 'dsh-life-pack-bill', prefix: 'ilife-bill', call, ...options })
  await btn.refresh()
  await flush()
  await btn.refresh()
  await flush()
  return { btn, container, log }
}

describe('挂载校验与铁律', () => {
  it('坏容器/缺 pluginId/缺 call/非法 pollMs 即抛', () => {
    const { call } = fakeCall()
    assert.throws(() => mountInstallButton(null, { pluginId: 'p', call }))
    assert.throws(() => mountInstallButton({ innerHTML: 1 }, { pluginId: 'p', call }))
    assert.throws(() => mountInstallButton(fakeContainer(), { call }))
    assert.throws(() => mountInstallButton(fakeContainer(), { pluginId: '', call }))
    assert.throws(() => mountInstallButton(fakeContainer(), { pluginId: 'p' }))
    assert.throws(() => mountInstallButton(fakeContainer(), { pluginId: 'p', call, pollMs: 100 }))
  })

  it('挂载 + 检查全程零 updateInstall 调用', async () => {
    const { log } = await settledMount({})
    assert.equal(callsOf(log, '.updateInstall').length, 0)
    assert.ok(callsOf(log, '.updateStatus').length >= 1)
  })
})

describe('缺席可装（核心场景）', () => {
  it('zh：按钮“安装版本 0.3.54”，状态行含“未安装”，不见 0.0.0', async () => {
    const { container } = await settledMount({})
    assert.ok(container.innerHTML.includes('安装版本 0.3.54'))
    assert.ok(container.innerHTML.includes('未安装'))
    assert.ok(!container.innerHTML.includes('0.0.0'))
    assert.ok(container.innerHTML.includes('data-action="install"'))
  })

  it('en：按钮“Install 0.3.54”，状态行“Not installed”', async () => {
    const { container } = await settledMount({ locale: 'en' })
    assert.ok(container.innerHTML.includes('Install 0.3.54'))
    assert.ok(container.innerHTML.includes('Not installed'))
  })
})

describe('缺席未查到远端', () => {
  it('按钮退回“检查更新”，点后只调 updateCheck', async () => {
    const snap = absentInstallable({ latestVersion: null, canInstall: false })
    const { container, log } = await settledMount({}, { status: statusReply(snap), check: checkReply(snap) })
    assert.ok(container.innerHTML.includes('检查更新'))
    assert.ok(!container.innerHTML.includes('data-action="install"'))
    container.click({ 'data-action': 'check' })
    await flush(10)
    assert.ok(callsOf(log, '.updateCheck').length >= 1)
    assert.equal(callsOf(log, '.updateInstall').length, 0)
  })
})

describe('点击安装', () => {
  it('无 receipt 时一次点击内先 check 后 install，requestId 新编且带 checkId', async () => {
    const { container, log } = await settledMount({ autoCheck: 'never' })
    log.length = 0
    container.click({ 'data-action': 'install' })
    await flush(10)
    const checks = callsOf(log, '.updateCheck')
    const installs = callsOf(log, '.updateInstall')
    assert.equal(checks.length, 1)
    assert.equal(installs.length, 1)
    assert.ok(log.indexOf(checks[0]) < log.indexOf(installs[0]))
    assert.equal(installs[0].args.checkId, 'check-1')
    assert.equal(typeof installs[0].args.requestId, 'string')
    assert.ok(installs[0].args.requestId.length > 0)
  })

  it('连点只认第一次（在途安装未收尾前不重发）', async () => {
    let release = null
    const gate = new Promise((r) => {
      release = r
    })
    const installing = absentInstallable({
      job: { id: 'j1', state: 'installing', targetVersion: '0.3.54', message: null, requestId: 'r0' },
    })
    const { container, log } = await settledMount(
      { autoCheck: 'never' },
      { status: statusReply(absentInstallable()), install: () => gate.then(() => statusReply(installing)) },
    )
    log.length = 0
    container.click({ 'data-action': 'install' })
    container.click({ 'data-action': 'install' })
    await flush(10)
    assert.equal(callsOf(log, '.updateInstall').length, 1)
    release()
    await flush(10)
  })
})

describe('忙与排队', () => {
  it('job installing 时按钮置忙“正在安装…”且不可点', async () => {
    const snap = absentInstallable({
      installed: true,
      installedVersion: '0.3.53',
      job: { id: 'j1', state: 'installing', targetVersion: '0.3.54', message: null, requestId: 'r0' },
    })
    const { container } = await settledMount({}, { status: statusReply(snap) })
    assert.ok(container.innerHTML.includes('正在安装'))
    assert.ok(container.innerHTML.includes('disabled'))
  })

  it('update-busy 瞬态不锁存：按钮仍可装，队列位照常显示', async () => {
    const busyQueue = baseQueue({ busy: true, owner: { pluginId: 'other' }, waiting: [], position: 2 })
    const script = {
      status: (log) => (callsOf(log, '.updateStatus').length <= 2
        ? statusReply(absentInstallable())
        : failedReply('update-busy', 'update-busy', { queue: busyQueue })),
    }
    const { container, log } = await settledMount({}, script)
    await flush(10)
    assert.ok(!container.innerHTML.includes('更新失败'))
    assert.ok(container.innerHTML.includes('data-action="install"'))
  })
})

describe('失败分家与兜底', () => {
  it('未装 + 查侧失败：说“未安装”与查询失败，不说安装失败', async () => {
    const { container } = await settledMount(
      {},
      { status: statusReply(absentInstallable()), check: failedReply('check-failed', 'check-failed') },
    )
    container.click({ 'data-action': 'check' })
    await flush(10)
    assert.ok(container.innerHTML.includes('未安装'))
    assert.ok(!container.innerHTML.includes('安装失败'))
  })

  it('装侧失败：重试按钮 + 复制诊断（文本含码与插件标识）', async () => {
    const { container, btn } = await settledMount({ autoCheck: 'never' }, {
      install: failedReply('install-failed', 'install-failed', {
        manual: 'dsh plugin --profile web add --save-exact dsh-bill-ilife@0.3.54 --registry=https://registry.npmjs.org/',
      }),
    })
    container.click({ 'data-action': 'install' })
    await flush(10)
    assert.ok(container.innerHTML.includes('重试安装'))
    assert.ok(container.innerHTML.includes('data-action="copy-diag"'))
    // #177：失败回包自带的 manual 也是上一帧沿用值，不按当帧事实展示，也不给复制。
    assert.ok(!container.innerHTML.includes('data-action="copy-manual"'))
    assert.ok(!container.innerHTML.includes('手工命令'))
    const st = btn.state()
    assert.equal(st.failedCode, 'install-failed')
  })

  it('#177 失败回包后静默补读一次：补到当帧命令即恢复「最后手段」', async () => {
    let n = 0
    const { container, log } = await settledMount({ autoCheck: 'never' }, {
      status: () =>
        ++n <= 2
          ? statusReply(absentInstallable())
          : statusReply(absentInstallable(), {
              manual: 'dsh plugin --profile web add --save-exact dsh-bill-ilife@0.3.54 --registry=https://registry.npmjs.org/',
            }),
      install: failedReply('install-failed', 'install-failed'),
    })
    log.length = 0
    container.click({ 'data-action': 'install' })
    await flush(10)
    assert.equal(callsOf(log, '.updateStatus').length, 1)
    assert.ok(container.innerHTML.includes('data-last-resort="last-resort"'))
    assert.ok(container.innerHTML.includes('data-action="copy-manual"'))
  })

  it('#177 补读也失败：保持失败帧、不展示旧命令、不重复补读', async () => {
    const { container, log } = await settledMount({ autoCheck: 'never' }, {
      install: failedReply('install-failed', 'install-failed'),
    })
    log.length = 0
    container.click({ 'data-action': 'install' })
    await flush(10)
    assert.equal(callsOf(log, '.updateStatus').length, 1)
    assert.ok(container.innerHTML.includes('重试安装'))
    assert.ok(!container.innerHTML.includes('data-last-resort'))
    await flush(10)
    assert.equal(callsOf(log, '.updateStatus').length, 1)
  })

  it('job failed 进锁存：message 前缀码被识别', async () => {
    const snap = absentInstallable({
      job: { id: 'j1', state: 'failed', targetVersion: '0.3.54', message: 'install-failed: boom', requestId: 'r9' },
    })
    const { container, btn } = await settledMount({}, { status: statusReply(snap) })
    assert.ok(container.innerHTML.includes('重试安装'))
    assert.equal(btn.state().failedCode, 'install-failed')
  })
})

describe('终态与卸载', () => {
  it('pending-restart：无安装动作，有重启指引', async () => {
    const snap = absentInstallable({
      installed: true,
      installedVersion: '0.3.54',
      runningVersion: '0.3.53',
      blockedReason: 'pending-restart',
      canInstall: false,
    })
    const { container } = await settledMount({}, { status: statusReply(snap) })
    assert.ok(!container.innerHTML.includes('data-action="install"'))
    assert.ok(container.innerHTML.includes('重启'))
  })

  it('已是最新：按钮“已安装”置灰', async () => {
    const snap = {
      runningVersion: '1.0.0',
      installed: true,
      installedVersion: '1.0.0',
      latestVersion: '1.0.0',
      canInstall: false,
      blockedReason: null,
      job: null,
    }
    const { container } = await settledMount({}, { status: statusReply(snap) })
    assert.ok(container.innerHTML.includes('已安装'))
  })

  it('unmount 停轮询：计时器被清，安装在宿主侧继续（无取消电话）', async () => {
    const installing = absentInstallable({
      job: { id: 'j1', state: 'installing', targetVersion: '0.3.54', message: null, requestId: 'r0' },
    })
    let cleared = 0
    globalThis.clearInterval = () => {
      cleared += 1
    }
    const { btn, log } = await settledMount({}, { status: statusReply(installing) })
    assert.ok(timerFns.length >= 1)
    btn.unmount()
    assert.ok(cleared >= 1)
    assert.equal(
      log.filter((e) => /cancel/i.test(e.name)).length,
      0,
    )
  })

  it('有界轮询：300 轮封顶后停（不再调 updateStatus）', async () => {
    const installing = absentInstallable({
      job: { id: 'j1', state: 'installing', targetVersion: '0.3.54', message: null, requestId: 'r0' },
    })
    const { container, log } = await settledMount({}, { status: statusReply(installing) })
    assert.ok(timerFns.length >= 1)
    const tick = timerFns[timerFns.length - 1]
    log.length = 0
    for (let i = 0; i < 310; i++) tick()
    await flush(10)
    assert.ok(callsOf(log, '.updateStatus').length <= 300)
  }, { timeout: 30000 })

  it('封顶转重查态：停轮询后按钮退回“检查更新”', async () => {
    const installing = absentInstallable({
      job: { id: 'j1', state: 'installing', targetVersion: '0.3.54', message: null, requestId: 'r0' },
    })
    const { container } = await settledMount({}, { status: statusReply(installing) })
    const tick = timerFns[timerFns.length - 1]
    for (let i = 0; i < 305; i++) tick()
    await flush(10)
    assert.ok(container.innerHTML.includes('检查更新'))
    assert.ok(container.innerHTML.includes('data-action="check"'))
  }, { timeout: 30000 })

  it('抛出的 update-busy 不锁存：安装仍可点，并重读队列', async () => {
    const { container, btn, log } = await settledMount({ autoCheck: 'never' }, {
      install: () => Promise.reject(new Error('update-busy')),
    })
    const before = callsOf(log, '.updateStatus').length
    container.click({ 'data-action': 'install' })
    await flush(10)
    assert.equal(btn.state().failedCode, null)
    assert.ok(!container.innerHTML.includes('更新失败'))
    assert.ok(container.innerHTML.includes('data-action="install"'))
    assert.ok(callsOf(log, '.updateStatus').length > before)
  })

  it('抛出的 update-busy 不锁存：检查角色保留', async () => {
    const snap = absentInstallable({ latestVersion: null, canInstall: false })
    const { container, btn } = await settledMount({}, {
      status: statusReply(snap),
      check: () => Promise.reject(new Error('update-busy')),
    })
    container.click({ 'data-action': 'check' })
    await flush(10)
    assert.equal(btn.state().failedCode, null)
    assert.ok(container.innerHTML.includes('data-action="check"'))
  })

  it('装侧失败但不可装：无动作按钮，复制诊断仍在', async () => {
    const snap = {
      runningVersion: '1.0.0',
      installed: true,
      installedVersion: '1.0.0',
      latestVersion: '1.1.0',
      canInstall: false,
      blockedReason: null,
      job: { id: 'j1', state: 'failed', targetVersion: '1.1.0', message: 'install-failed: boom', requestId: 'r9' },
    }
    const { container } = await settledMount(
      {},
      { status: statusReply(snap, { manual: 'dsh plugin --profile web add --save-exact dsh-x@1.1.0' }) },
    )
    assert.ok(container.innerHTML.includes('data-action="copy-diag"'))
    assert.ok(!container.innerHTML.includes('data-action="install"'))
    assert.ok(!container.innerHTML.includes('data-action="check"'))
  })

  it('挂载校验失败记 render.fail 行', async () => {
    const rows = []
    const channel = { emit: (level, event, fields) => rows.push({ level, event, fields }) }
    const { call } = fakeCall()
    assert.throws(() =>
      mountInstallButton(fakeContainer(), { pluginId: 'p', prefix: 't', call, clientLog: { channel }, autoCheck: 'bogus' }),
    )
    assert.ok(rows.some((r) => r.event === 'update.panel.render.fail'))
    rows.length = 0
    assert.throws(() =>
      mountInstallButton(fakeContainer(), { pluginId: 'p', prefix: 't', call, clientLog: { channel }, locale: '' }),
    )
    assert.ok(rows.some((r) => r.event === 'update.panel.render.fail'))
  })
})

describe('纯函数视图', () => {
  it('installButtonViewModel：缺席可装给 install 角色与版本标签', () => {
    const view = installButtonViewModel({
      snapshot: absentInstallable(),
      manual: null,
      queue: baseQueue(),
      lastError: null,
      errorKind: null,
      busyAct: null,
      lang: 'zh',
    })
    assert.equal(view.role, 'install')
    assert.equal(view.buttonLabel, '安装版本 0.3.54')
    assert.equal(view.buttonEnabled, true)
  })

  it('installButtonViewModel：忙态给 none 角色与置忙标签', () => {
    const view = installButtonViewModel({
      snapshot: absentInstallable({
        job: { id: 'j1', state: 'verifying', targetVersion: '0.3.54', message: null, requestId: 'r0' },
      }),
      manual: null,
      queue: baseQueue(),
      lastError: null,
      errorKind: null,
      busyAct: null,
      lang: 'zh',
    })
    assert.equal(view.role, 'none')
    assert.equal(view.buttonEnabled, false)
  })

  it('installButtonViewModel：无快照给 check 角色', () => {
    const view = installButtonViewModel({
      snapshot: null,
      manual: null,
      queue: null,
      lastError: null,
      errorKind: null,
      busyAct: null,
      lang: 'zh',
    })
    assert.equal(view.role, 'check')
  })

  it('installButtonViewModel：封顶后在途转 check 角色', () => {
    const view = installButtonViewModel({
      snapshot: absentInstallable({
        job: { id: 'j1', state: 'installing', targetVersion: '0.3.54', message: null, requestId: 'r0' },
      }),
      manual: null,
      queue: baseQueue(),
      lastError: null,
      errorKind: null,
      busyAct: null,
      pollCapped: true,
      lang: 'zh',
    })
    assert.equal(view.role, 'check')
    assert.equal(view.buttonLabel, '检查更新')
  })
})
