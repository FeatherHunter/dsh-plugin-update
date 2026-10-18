/**
 * tests/issue-211-panel-mount.test.mjs —— #211 AC-2：面板挂载行带自动检查状态（autoCheck）。
 *
 * 契约（event-list.update.json「update.panel.mount」）：常驻行一次挂载一条，
 * fields = [mode, theme, lang, pollMs, autoCheck]，autoCheck ∈ started / recent / disabled / failed：
 *   - started ：挂载后自动检查已发起；
 *   - recent  ：没发起是因为首刷拿到的状态本身新鲜（job 在 installing/verifying，或已有动作在途），无需再查；
 *   - disabled：调用方显式关掉自动检查（autoCheck:false）；
 *   - failed  ：首次刷新失败（拿不到状态），自动检查没能跑。
 *
 * 只测外部行为：注入「同步记录通道」看挂载行何时落、带什么字段、调了几次电话；
 * 容器与传输全用假件，不碰真机、不真联网、不真装。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountUpdatePanel } from '../dist/panel.js'
import { mountInstallButton } from '../dist/install-button.js'
import { mountUpdateEntry } from '../dist/entry.js'

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

function baseQueue(overrides = {}) {
  return { busy: false, owner: null, waiting: [], position: null, ...overrides }
}

function statusReply(snapshot, extra = {}) {
  return { ok: true, snapshot, manual: null, receipt: null, queue: baseQueue(), ...extra }
}

function checkReply(snapshot, extra = {}) {
  return {
    ok: true,
    snapshot,
    manual: null,
    receipt: { checkId: 'check-1', checkedAt: 1, expiresAt: 999 },
    queue: baseQueue(),
    ...extra,
  }
}

/** 假容器：只要 innerHTML 与事件能力（与面板/入口件同一契约）。 */
function fakeContainer() {
  return { innerHTML: '', addEventListener() {}, removeEventListener() {} }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 同步记录通道：emit 当场进 rows（不攒批、不等 flush），所以「挂载行何时落」可直接观察。
 * 只实现面板真的会用到的那几个方法。
 */
function recordingChannel() {
  const rows = []
  const channel = {
    emit(level, event, fields) {
      rows.push({ level, event, fields: { ...fields } })
    },
    async flush() {},
    pending: () => 0,
    dropped: () => 0,
    droppedByReason: () => ({}),
    sent: () => 0,
    enabled: () => true,
    dispose() {},
  }
  return { ch: channel, rows }
}

function mountsOf(rows) {
  return rows.filter((r) => r.event === 'update.panel.mount')
}

/** 面板侧假传输：按电话名回剧本，并记下每次调用。 */
function fakeCall(script = {}) {
  const log = []
  const call = async (name, args) => {
    log.push({ name, args })
    if (name.endsWith('.updateStatus')) {
      return script.status ?? statusReply(baseSnapshot())
    }
    if (name.endsWith('.updateCheck')) {
      return script.check ?? checkReply(baseSnapshot())
    }
    if (name.endsWith('.updateInstall')) {
      return script.install ?? { ok: true, snapshot: baseSnapshot({ job: null }), manual: null }
    }
    if (name.endsWith('.logAppend')) {
      return { accepted: Array.isArray(args?.rows) ? args.rows.length : 0, dropped: 0 }
    }
    throw new Error('unknown-phone:' + name)
  }
  return { call, log }
}

function callsOf(log, suffix) {
  return log.filter((e) => e.name.endsWith(suffix))
}

// ---------- 四种状态 ----------

test('默认自动查一次：挂载行等首刷后落，autoCheck=started 且恰一条', async () => {
  const { ch, rows } = recordingChannel()
  const { call, log } = fakeCall()
  const panel = mountUpdatePanel(fakeContainer(), {
    pluginId: 'p',
    call,
    pollMs: 60000,
    clientLog: { channel: ch, mount: 'entry' },
  })

  // 同步返回时挂载行还没发：autoCheck 要等首刷回来才判得出（此时只有语言行与首绘状态行）。
  assert.deepEqual(rows.map((r) => r.event), ['update.lang.applied', 'update.panel.state'], '挂载行必须挪到首刷之后')
  assert.equal(mountsOf(rows).length, 0, '首刷前不许有挂载行')

  await sleep(30)
  const mounts = mountsOf(rows)
  assert.equal(mounts.length, 1, '一次挂载只记一条')
  assert.equal(mounts[0].level, 'info')
  assert.deepEqual(mounts[0].fields, {
    mode: 'entry',
    theme: 'default',
    lang: 'zh',
    pollMs: 60000,
    autoCheck: 'started',
  })
  assert.equal(callsOf(log, '.updateCheck').length, 1, '默认自动查一次')
  panel.unmount()
})

test('autoCheck:false 即调用方点名关掉：autoCheck=disabled，首刷照做但不自动查', async () => {
  const { ch, rows } = recordingChannel()
  const { call, log } = fakeCall()
  const panel = mountUpdatePanel(fakeContainer(), {
    pluginId: 'p',
    call,
    pollMs: 60000,
    autoCheck: false,
    clientLog: { channel: ch, mount: 'entry' },
  })
  await sleep(30)
  const mounts = mountsOf(rows)
  assert.equal(mounts.length, 1)
  assert.equal(mounts[0].fields.autoCheck, 'disabled')
  assert.equal(callsOf(log, '.updateStatus').length, 1, '首刷只读刷新照做')
  assert.equal(callsOf(log, '.updateCheck').length, 0, '关掉就不许自动查')
  panel.unmount()
})

test('首刷拿到的状态本身新鲜（装在跑/校验中）：autoCheck=recent，不重复查', async () => {
  for (const jobState of ['installing', 'verifying']) {
    const snapshot = baseSnapshot({
      latestVersion: null,
      canInstall: false,
      job: { id: 'j', state: jobState, targetVersion: '1.1.0', message: null, requestId: 'r' },
    })
    const { ch, rows } = recordingChannel()
    const { call, log } = fakeCall({ status: statusReply(snapshot) })
    const panel = mountUpdatePanel(fakeContainer(), {
      pluginId: 'p',
      call,
      pollMs: 60000,
      clientLog: { channel: ch, mount: 'entry' },
    })
    await sleep(30)
    const mounts = mountsOf(rows)
    assert.equal(mounts.length, 1)
    assert.equal(mounts[0].fields.autoCheck, 'recent', jobState + ' 状态新鲜，无需再查')
    assert.equal(callsOf(log, '.updateCheck').length, 0, jobState + ' 不许另发检查')
    panel.unmount()
  }
})

test('首刷回来时已有动作在途：autoCheck=recent，不双发', async () => {
  const { ch, rows } = recordingChannel()
  const calls = []
  let releaseCheck = null
  const hangingCheck = new Promise((res) => {
    releaseCheck = res
  })
  const call = async (name) => {
    calls.push(name)
    if (name.endsWith('.updateStatus')) return statusReply(baseSnapshot())
    if (name.endsWith('.updateCheck')) {
      await hangingCheck
      return checkReply(baseSnapshot())
    }
    throw new Error('unknown-phone:' + name)
  }
  const panel = mountUpdatePanel(fakeContainer(), {
    pluginId: 'p',
    call,
    pollMs: 60000,
    clientLog: { channel: ch, mount: 'entry' },
  })
  // 手动查先飞（挂起），首刷回来时 busyAct 仍占着 → 不该再发一次自动查。
  void panel.act('check')
  await sleep(30)
  const mounts = mountsOf(rows)
  assert.equal(mounts.length, 1)
  assert.equal(mounts[0].fields.autoCheck, 'recent', '有动作在途即 recent')
  assert.equal(calls.filter((n) => n.endsWith('.updateCheck')).length, 1, '只有在飞的那一次')

  releaseCheck()
  await sleep(30)
  assert.equal(calls.filter((n) => n.endsWith('.updateCheck')).length, 1, '放行后也不补发')
  assert.equal(mountsOf(rows).length, 1, '挂载行仍恰一条')
  panel.unmount()
})

test('首刷失败（传输失败 / 回包失败）：autoCheck=failed，不自动查、恰一条', async () => {
  for (const mode of ['throw', 'reply-fail']) {
    const { ch, rows } = recordingChannel()
    const log = []
    const call = async (name) => {
      log.push(name)
      if (name.endsWith('.updateStatus')) {
        if (mode === 'throw') throw new Error('offline')
        return { ok: false, error: 'status-failed', errorKind: 'status-failed', queue: baseQueue() }
      }
      if (name.endsWith('.updateCheck')) return checkReply(baseSnapshot())
      throw new Error('unknown-phone:' + name)
    }
    const panel = mountUpdatePanel(fakeContainer(), {
      pluginId: 'p',
      call,
      pollMs: 60000,
      clientLog: { channel: ch, mount: 'entry' },
    })
    await sleep(30)
    const mounts = mountsOf(rows)
    assert.equal(mounts.length, 1, mode + ' 也要恰一条')
    assert.equal(mounts[0].fields.autoCheck, 'failed', mode + ' 记 failed')
    assert.equal(log.filter((n) => n.endsWith('.updateCheck')).length, 0, mode + ' 不自动查')
    panel.unmount()
  }
})

// ---------- 恰好一条 / 校验失败不发 ----------

test('挂载后刷新与动作不会追加挂载行', async () => {
  const { ch, rows } = recordingChannel()
  const { call } = fakeCall()
  const panel = mountUpdatePanel(fakeContainer(), {
    pluginId: 'p',
    call,
    pollMs: 60000,
    clientLog: { channel: ch, mount: 'entry' },
  })
  await sleep(30)
  await panel.refresh()
  await panel.act('toggle-changelog')
  await sleep(20)
  assert.equal(mountsOf(rows).length, 1, '常驻行只在挂载时记一次')
  panel.unmount()
})

test('autoCheck 非法值：先留一条 render.fail 证据再抛，不发挂载行', async () => {
  for (const bad of ['bogus', 1, null]) {
    const { ch, rows } = recordingChannel()
    const { call, log } = fakeCall()
    assert.throws(
      () =>
        mountUpdatePanel(fakeContainer(), {
          pluginId: 'p',
          call,
          pollMs: 60000,
          autoCheck: bad,
          clientLog: { channel: ch, mount: 'entry' },
        }),
      /自动检查/,
      '只收布尔值'
    )
    assert.equal(mountsOf(rows).length, 0, '参数校验失败不发挂载行')
    assert.equal(callsOf(log, '.updateStatus').length, 0, '校验失败不打电话')
    const fails = rows.filter((r) => r.event === 'update.panel.render.fail')
    assert.equal(fails.length, 1, '失败证据恰一条')
    assert.equal(fails[0].fields.phase, 'mount')
    assert.equal(fails[0].fields.kind, 'auto-check')
    assert.match(fails[0].fields.errorHash, /^[0-9a-f]{8}$/)
  }
})

test('其余挂载校验失败同样不发挂载行（theme 非法，autoCheck 合法）', async () => {
  const { ch, rows } = recordingChannel()
  const { call, log } = fakeCall()
  assert.throws(
    () =>
      mountUpdatePanel(fakeContainer(), {
        pluginId: 'p',
        call,
        pollMs: 60000,
        autoCheck: false,
        theme: 'weird',
        clientLog: { channel: ch, mount: 'entry' },
      }),
    /主题非法/
  )
  assert.equal(mountsOf(rows).length, 0)
  assert.equal(callsOf(log, '.updateStatus').length, 0)
  const fails = rows.filter((r) => r.event === 'update.panel.render.fail')
  assert.equal(fails.length, 1)
  assert.equal(fails[0].fields.kind, 'theme')
})

// ---------- 安装按钮：四态映射（记事实，不是预告） ----------

function buttonSnapshot(overrides = {}) {
  return {
    runningVersion: '0.0.0',
    installed: false,
    installedVersion: null,
    latestVersion: null,
    canInstall: true,
    blockedReason: null,
    job: null,
    ...overrides,
  }
}

test('安装按钮：started=首刷后自动查真的发起；recent=首刷已有 latest 不重查；各恰一条', async () => {
  for (const [snapshotOverrides, expected] of [
    [{}, { autoCheck: 'started', statusHits: 1, checkHits: 1 }],
    [{ latestVersion: '0.3.54' }, { autoCheck: 'recent', statusHits: 1, checkHits: 0 }],
  ]) {
    const { ch, rows } = recordingChannel()
    const { call, log } = fakeCall({ status: statusReply(buttonSnapshot(snapshotOverrides)) })
    const btn = mountInstallButton(fakeContainer(), {
      pluginId: 'p',
      prefix: 'p',
      call,
      pollMs: 60000,
      clientLog: { channel: ch, mount: 'slot' },
    })
    await sleep(30)
    const mounts = mountsOf(rows)
    assert.equal(mounts.length, 1)
    assert.deepEqual(mounts[0].fields, {
      mode: 'slot',
      theme: 'default',
      lang: 'zh',
      pollMs: 60000,
      autoCheck: expected.autoCheck,
    })
    assert.equal(callsOf(log, '.updateStatus').length, expected.statusHits, '首刷照做')
    assert.equal(callsOf(log, '.updateCheck').length, expected.checkHits, 'autoCheck 记的是跑没跑')
    btn.unmount()
  }
})

test('安装按钮：autoCheck:never=disabled，不刷新也不查；恰一条', async () => {
  const { ch, rows } = recordingChannel()
  const { call, log } = fakeCall({ status: statusReply(buttonSnapshot()) })
  const btn = mountInstallButton(fakeContainer(), {
    pluginId: 'p',
    prefix: 'p',
    call,
    pollMs: 60000,
    autoCheck: 'never',
    clientLog: { channel: ch, mount: 'slot' },
  })
  await sleep(30)
  const mounts = mountsOf(rows)
  assert.equal(mounts.length, 1)
  assert.equal(mounts[0].fields.autoCheck, 'disabled')
  assert.equal(callsOf(log, '.updateStatus').length, 0, 'never 不自动刷新')
  assert.equal(callsOf(log, '.updateCheck').length, 0, 'never 不自动查')
  btn.unmount()
})

test('安装按钮：首刷失败（传输抛错）=failed，不自动查', async () => {
  const { ch, rows } = recordingChannel()
  const names = []
  const call = async (name) => {
    names.push(name)
    if (name.endsWith('.updateStatus')) throw new Error('offline')
    if (name.endsWith('.updateCheck')) return checkReply(buttonSnapshot())
    throw new Error('unknown-phone:' + name)
  }
  const btn = mountInstallButton(fakeContainer(), {
    pluginId: 'p',
    prefix: 'p',
    call,
    pollMs: 60000,
    clientLog: { channel: ch, mount: 'slot' },
  })
  await sleep(30)
  const mounts = mountsOf(rows)
  assert.equal(mounts.length, 1)
  assert.equal(mounts[0].fields.autoCheck, 'failed', '拿不到状态就记 failed，不许冒充 started')
  assert.equal(names.filter((n) => n.endsWith('.updateCheck')).length, 0, '首刷失败不自动查')
  btn.unmount()
})

// ---------- 入口件 inline：autoCheck 透传给面板 ----------

function entryFakeCall() {
  const log = []
  const call = async (name, args) => {
    log.push({ name, args })
    if (name.endsWith('.updateStatus')) return statusReply(baseSnapshot())
    if (name.endsWith('.updateCheck')) return checkReply(baseSnapshot())
    if (name.endsWith('.updateInstall')) return { ok: true, snapshot: baseSnapshot(), manual: null }
    if (name.endsWith('.logAppend')) {
      return { accepted: Array.isArray(args?.rows) ? args.rows.length : 0, dropped: 0 }
    }
    throw new Error('unknown-phone:' + name)
  }
  return { call, log }
}

/** 入口件自建通道：卸载时 dispose 会尽力冲刷一次，行的最终归宿在 logAppend 的参数里。 */
function appendedRows(log) {
  return log.filter((e) => e.name.endsWith('.logAppend')).flatMap((e) => e.args?.rows ?? [])
}

for (const [autoCheck, expected] of [
  ['never', { autoCheck: 'disabled', checkHits: 0 }],
  ['mount', { autoCheck: 'started', checkHits: 1 }],
]) {
  test(`入口件 inline autoCheck=${autoCheck}：面板挂载行如实记 ${expected.autoCheck}`, async () => {
    const { call, log } = entryFakeCall()
    const entry = mountUpdateEntry(fakeContainer(), {
      pluginId: 'p',
      prefix: 'p',
      call,
      pollMs: 60000,
      variant: 'inline',
      autoCheck,
    })
    await sleep(50)
    assert.equal(callsOf(log, '.updateCheck').length, expected.checkHits, '自动检查跟着入口件的时机')
    entry.unmount()
    // 面板自建通道 dispose 后异步尽力冲刷，等它落地。
    await sleep(150)
    const mounts = appendedRows(log).filter((r) => r.event === 'update.panel.mount')
    assert.equal(mounts.length, 1, '一次挂载一条')
    assert.equal(mounts[0].fields.autoCheck, expected.autoCheck)
    assert.equal(mounts[0].fields.mode, 'entry')
  })
}
