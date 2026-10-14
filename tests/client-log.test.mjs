/**
 * tests/client-log.test.mjs —— 客户端日志通道（#122）：环形缓冲、按批投递、退避与丢弃计数，
 * 以及宿主侧 `<prefix>.logAppend` 电话的协议面（谁有权说、什么形状收、什么时候拒）。
 *
 * 只测外部行为：给假传输/假计时器/假可见性，看交出去的载荷、看计数、
 * 断言「永不外抛」。不碰真机、不真联网、不真落盘（宿主侧走注入的 logCtx 假件）。
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHostUpdate, __resetSharedUpdateReaderForTests } from '../dist/host.js'
import { mountUpdatePanel } from '../dist/panel.js'
import {
  CLIENT_LOG_EVENTS,
  createClientLogChannel,
  isClientLogEvent,
} from '../dist/log/client-queue.js'

/** 假计时器：记下排了什么，手动触发（测试自己决定「到点」）。 */
function fakeTimer() {
  let seq = 0
  const jobs = new Map()
  return {
    set(fn, ms) {
      const id = ++seq
      jobs.set(id, { fn, ms })
      return id
    },
    clear(id) {
      jobs.delete(id)
    },
    /** 触发当前所有排着的任务（触发中排的新任务留给下一次）。 */
    runAll() {
      for (const [id, job] of [...jobs]) {
        jobs.delete(id)
        job.fn()
      }
    },
    size() {
      return jobs.size
    },
  }
}

/** 假传输：记下每次载荷，按剧本回执（缺省 accepted=行数）。 */
function fakeCall(script = {}) {
  const calls = []
  const call = async (name, args) => {
    calls.push({ name, args })
    if (script.throwAlways) throw new Error('boom')
    if (script.reply) return script.reply(args, calls.length)
    return { accepted: Array.isArray(args?.rows) ? args.rows.length : 0, dropped: 0 }
  }
  return { call, calls }
}

function channel(overrides = {}) {
  const { call, calls } = fakeCall(overrides.script ?? {})
  const ch = createClientLogChannel({
    call,
    phoneName: 'notes.logAppend',
    timer: null,
    visibility: null,
    batchSize: 1000,
    ...overrides.options,
  })
  return { ch, calls }
}

describe('客户端日志通道：有界缓冲与按批投递', () => {
  it('攒着不自动发；手动 flush 一次交一批，载荷就是四键行', async () => {
    const { ch, calls } = channel()
    ch.emit('info', 'update.panel.state', { state: 'ready', theme: 'default', tokensApplied: 0, fallback: true })
    ch.emit('warn', 'update.panel.render.fail', { kind: 'unknown' })
    assert.equal(ch.pending(), 2)
    assert.equal(ch.dropped(), 0)
    assert.equal(ch.enabled(), true)

    await ch.flush()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].name, 'notes.logAppend')
    assert.equal(calls[0].args.rows.length, 2)
    assert.deepEqual(
      calls[0].args.rows.map((r) => [r.level, r.event]),
      [
        ['info', 'update.panel.state'],
        ['warn', 'update.panel.render.fail'],
      ]
    )
    assert.equal(typeof calls[0].args.rows[0].ts, 'number', '行带发生时刻（宿主用它判过期）')
    assert.deepEqual(calls[0].args.rows[0].fields, { state: 'ready', theme: 'default', tokensApplied: 0, fallback: true })
    assert.equal(ch.pending(), 0)
    assert.equal(ch.sent(), 2)
  })

  it('一批只交 batchSize 行，剩下的留着下一批', async () => {
    const { ch, calls } = channel({ options: { batchSize: 2 } })
    ch.emit('info', 'update.panel.action', { action: 'check' })
    ch.emit('info', 'update.panel.action', { action: 'install' })
    ch.emit('info', 'update.panel.action', { action: 'close-view' })
    await ch.flush()
    assert.equal(calls[0].args.rows.length, 2)
    assert.equal(ch.pending(), 1)
    await ch.flush()
    assert.equal(calls[1].args.rows.length, 1)
    assert.equal(calls[1].args.rows[0].fields.action, 'close-view')
  })

  it('缓冲满了挤掉最老的（留最近状态），挤掉的如实计入丢弃', async () => {
    const seen = []
    const { ch } = channel({
      options: { maxQueue: 3, onDrop: (row, reason) => seen.push([row?.fields?.action ?? null, reason]) },
    })
    for (const action of ['a', 'b', 'c', 'd', 'e']) ch.emit('info', 'update.panel.action', { action })
    assert.equal(ch.pending(), 3)
    assert.equal(ch.dropped(), 2)
    assert.deepEqual(seen, [
      ['a', 'overflow'],
      ['b', 'overflow'],
    ])
  })

  it('destroy 后清缓冲、再报也只计数', async () => {
    const { ch } = channel()
    ch.emit('info', 'update.panel.mount', { mode: 'panel' })
    ch.dispose()
    assert.equal(ch.pending(), 0)
    assert.equal(ch.dropped(), 1)
    ch.emit('info', 'update.panel.mount', { mode: 'panel' })
    assert.equal(ch.dropped(), 2)
    assert.equal(ch.enabled(), false)
  })
})

describe('客户端日志通道：没有通道 / 传输失败都不外抛', () => {
  it('缺 call 或电话名即「没通道」：计数丢弃，一个异常都不抛', async () => {
    const ch = createClientLogChannel({ call: null, phoneName: '', timer: null, visibility: null })
    assert.equal(ch.enabled(), false)
    assert.doesNotThrow(() => ch.emit('info', 'update.panel.mount', { mode: 'panel' }))
    assert.equal(ch.dropped(), 1)
    assert.equal(ch.pending(), 0)
    await assert.doesNotReject(() => ch.flush())
  })

  it('传输总失败：首发 + 2 次重试后丢弃（重试次数可配）', async () => {
    const { ch, calls } = channel({ script: { throwAlways: true }, options: { retryDelaysMs: [1, 1] } })
    ch.emit('info', 'update.panel.action', { action: 'check' })
    await ch.flush()
    assert.equal(calls.length, 3, '首发 + 2 次重试')
    assert.equal(ch.dropped(), 1)
    assert.equal(ch.sent(), 0)
    assert.equal(ch.pending(), 0)
  })

  it('宿主回包说它丢了几行，我们照样计进去（两个丢弃计数不合并）', async () => {
    const { ch } = channel({ script: { reply: () => ({ accepted: 1, dropped: 2 }) } })
    ch.emit('info', 'update.panel.action', { action: 'check' })
    ch.emit('info', 'update.panel.action', { action: 'install' })
    ch.emit('info', 'update.panel.action', { action: 'close-view' })
    await ch.flush()
    assert.equal(ch.sent(), 1)
    assert.equal(ch.dropped(), 2)
  })

  it('回包形状不对（不是 {accepted,dropped} 两个数）算失败，走重试', async () => {
    const { ch, calls } = channel({ script: { reply: () => ({ ok: true }) }, options: { retryDelaysMs: [1, 1] } })
    ch.emit('info', 'update.panel.action', { action: 'check' })
    await ch.flush()
    assert.equal(calls.length, 3)
    assert.equal(ch.dropped(), 1)
  })

  it('页面切到后台立刻冲刷（visibilitychange → hidden）', async () => {
    const listeners = []
    const visibility = {
      visibilityState: 'visible',
      hidden: false,
      addEventListener: (type, fn) => listeners.push(fn),
      removeEventListener: () => {},
    }
    const { call, calls } = fakeCall()
    const ch = createClientLogChannel({ call, phoneName: 'wf.logAppend', timer: null, visibility, batchSize: 1000 })
    ch.emit('info', 'update.panel.mount', { mode: 'panel' })
    assert.equal(calls.length, 0)
    visibility.hidden = true
    visibility.visibilityState = 'hidden'
    listeners[0]()
    await new Promise((r) => setTimeout(r, 5))
    assert.equal(calls.length, 1, '切后台即送一批，别等用户关标签页')
  })

  it('上报垃圾不抛、不污染缓冲', async () => {
    const { ch } = channel()
    assert.doesNotThrow(() => ch.emit('info', '', {}))
    assert.doesNotThrow(() => ch.emit('info', 'update.panel.mount', null))
    assert.doesNotThrow(() => ch.emit(undefined, undefined, undefined))
    assert.equal(ch.pending(), 1, '只有事件名非空、fields 被兜成 {} 的那条进来了')
    await ch.flush()
    assert.equal(ch.pending(), 0)
  })
})

describe('客户端事件白名单（协议面）', () => {
  it('五个客户端事件在内，宿主事实类事件不在内', () => {
    assert.equal(CLIENT_LOG_EVENTS.length, 5)
    for (const name of ['update.panel.mount', 'update.panel.action', 'update.panel.render.fail', 'update.panel.state', 'update.lang.applied']) {
      assert.equal(isClientLogEvent(name), true, name)
    }
    for (const name of ['update.install.exec', 'host.call', 'update.wire.ready', 'update.log.degraded', '']) {
      assert.equal(isClientLogEvent(name), false, name)
    }
    assert.equal(isClientLogEvent(null), false)
  })

  it('预排的定时器按 batchSize 立即触发、否则按间隔触发', async () => {
    const timer = fakeTimer()
    const { call, calls } = fakeCall()
    const ch = createClientLogChannel({ call, phoneName: 'wf.logAppend', timer, visibility: null, batchSize: 3 })
    ch.emit('info', 'update.panel.action', { action: 'a' })
    assert.equal(timer.size(), 1, '没满一批：排一次间隔冲刷')
    timer.runAll()
    await new Promise((r) => setTimeout(r, 5))
    assert.equal(calls.length, 1, '到点即送')
    ch.emit('info', 'update.panel.action', { action: 'b' })
    ch.emit('info', 'update.panel.action', { action: 'c' })
    ch.emit('info', 'update.panel.action', { action: 'd' })
    timer.runAll()
    await new Promise((r) => setTimeout(r, 5))
    assert.equal(calls.length, 2)
    assert.equal(calls[1].args.rows.length, 3)
  })
})

// ---------- 宿主侧：<prefix>.logAppend 电话 ----------

const TARGET = 'third-party-plugin'
const REGISTRY = 'https://registry.npmjs.org/'

function fakeFetch() {
  return async () => ({
    ok: true,
    headers: { get: () => null },
    text: async () =>
      JSON.stringify({
        name: TARGET,
        version: '9.9.9',
        engines: { node: '>=22' },
        dist: { tarball: `${REGISTRY}${TARGET}/-/${TARGET}-9.9.9.tgz`, integrity: 'sha512-' + 'A'.repeat(86) + '==' },
      }),
  })
}

function makeHost({ pluginId = 'third-party-plugin', prefix, fires }) {
  return createHostUpdate(
    {
      logCtx: { fire: (level, event, fields) => fires.push({ level, event, fields }) },
      readerOverrides: {
        runningVersion: '1.0.0',
        profileDir: 'C:\\fake\\profile',
        profileName: 'web',
        homeDir: 'C:\\fake\\home',
        fetchImpl: fakeFetch(),
        now: () => 1_000_000,
        nodeVersion: '22.0.0',
        environmentKind: 'cli',
        targetPackageName: TARGET,
        readInstalled: async () => ({
          profileName: 'web',
          environmentKind: 'cli',
          homeDir: 'C:\\fake\\home',
          profileDir: 'C:\\fake\\profile',
          installedVersion: '1.0.0',
          packageValid: true,
          sourceInstall: false,
          blockedReason: null,
          installationKey: 'k',
          eligible: true,
        }),
        readJob: async () => null,
        writeJob: async () => {},
        tryAcquireLock: async () => true,
        releaseLock: async () => {},
        backupJob: async () => {},
        runInstall: async () => {},
      },
    },
    prefix === undefined ? { pluginId } : { pluginId, prefix }
  )
}

function row(event, fields, overrides = {}) {
  return { level: 'info', event, fields, ts: Date.now(), ...overrides }
}

/** 接线本身会先记一条 update.wire.ready；这里只看客户端行交上来的那几条。 */
function appended(fires) {
  return fires.filter((f) => f.event !== 'update.wire.ready')
}

beforeEach(() => {
  __resetSharedUpdateReaderForTests()
})

describe('宿主侧 logAppend：收客户端行，落进同一条日志管道', () => {
  it('电话名进宿主接线表（第五个），合法行原样交出去', async () => {
    const fires = []
    const host = makeHost({ fires })
    assert.equal(host.phoneNames.logAppend, 'wf.logAppend')
    assert.equal(typeof host.handlers['wf.logAppend'], 'function')

    const reply = await host.handlers['wf.logAppend']({
      rows: [row('update.panel.action', { action: 'check' }), row('update.lang.applied', { lang: 'zh', source: 'document' })],
    })
    assert.deepEqual(reply, { accepted: 2, dropped: 0 })
    const got = appended(fires)
    assert.deepEqual(
      got.map((f) => f.event),
      ['update.panel.action', 'update.lang.applied']
    )
    assert.equal(got[0].fields.action, 'check')
  })

  it('logAppend 自己不产生 host.call 行（不自我放大）', async () => {
    const fires = []
    const host = makeHost({ fires })
    await host.handlers['wf.logAppend']({ rows: [row('update.panel.mount', { mode: 'panel' })] })
    assert.equal(
      fires.filter((f) => f.event === 'host.call').length,
      0
    )
  })

  it('协议层拒收都计入 dropped：级别/事件/字段形状/过期/超量', async () => {
    const fires = []
    const host = makeHost({ fires })
    const reply = await host.handlers['wf.logAppend']({
      rows: [
        row('update.panel.action', { action: 'check' }, { level: 'trace' }),
        row('update.install.exec', { route: 'x' }),
        row('update.panel.action', ['nope']),
        row('update.panel.action', { action: 'check' }, { ts: 'now' }),
        row('update.panel.action', { action: 'check', bogus: 1 }),
        row('update.panel.state', { state: 'ready' }, { ts: Date.now() - 20 * 60_000 }),
        'not-a-row',
        null,
      ],
    })
    assert.deepEqual(reply, { accepted: 0, dropped: 8 })
    assert.deepEqual(appended(fires), [], '一行都不许漏进去')
  })

  it('一次最多收 200 行，多出来的计 dropped', async () => {
    const fires = []
    const host = makeHost({ fires })
    const rows = []
    for (let i = 0; i < 205; i++) rows.push(row('update.panel.action', { action: 'check' }))
    const reply = await host.handlers['wf.logAppend']({ rows })
    assert.deepEqual(reply, { accepted: 200, dropped: 5 })
    assert.equal(appended(fires).length, 200)
  })

  it('形状坏成什么样都不抛：不是数组 / 空参 / 字段超大', async () => {
    const fires = []
    const host = makeHost({ fires })
    for (const args of [{}, { rows: 'x' }, { rows: null }, { rows: [] }]) {
      const reply = await host.handlers['wf.logAppend'](args)
      assert.equal(typeof reply.accepted, 'number')
      assert.equal(typeof reply.dropped, 'number')
    }
    const big = { action: 'x'.repeat(5000) }
    const reply = await host.handlers['wf.logAppend']({ rows: [row('update.panel.action', big)] })
    assert.deepEqual(reply, { accepted: 0, dropped: 1 })
  })

  it('端到端：面板自建通道 → 真电话表 → 真宿主落进同一条日志管道', async () => {
    const fires = []
    const host = makeHost({ fires })
    const box = { innerHTML: '', addEventListener() {}, removeEventListener() {} }
    const panel = mountUpdatePanel(box, {
      pluginId: 'third-party-plugin',
      prefix: 'wf',
      // 面板侧的 call 就是宿主电话表：电话名由两边各自从前缀派生，这里考的就是它们对得上。
      call: async (name, args) => host.handlers[name](args),
      pollMs: 60000,
    })
    await new Promise((r) => setTimeout(r, 1400))
    const got = appended(fires)
    assert.ok(
      got.some((f) => f.event === 'update.panel.mount'),
      `挂载行要经真电话落到日志出口，实际：${got.map((f) => f.event).join(',')}`
    )
    assert.ok(got.some((f) => f.event === 'update.panel.state'))
    await panel.act('copy-diag')
    await new Promise((r) => setTimeout(r, 1200))
    const action = appended(fires).find((f) => f.event === 'update.panel.action' && f.fields.action === 'copy-diag')
    assert.ok(action, '复制诊断那一行也要走完整条线')
    panel.unmount()
  })
})
