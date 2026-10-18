/**
 * tests/log-health.test.mjs —— issue #212：日志健康要能被机器判定。
 *
 * 钉住五件事：
 *   1. `buildUpdateLogHealth` 的纯映射（注入 deps，不依赖进程单例）：pending / external(open|closed|unknown)
 *      / off / self，每种落点的 switchEnabled、dirHash、reason、lastEventAt 口径都必须对得上；
 *   2. `updateStatus` 成功回包里的 `logHealth` 来自**真实接线状态**：四种现场各断言一次，
 *      外加契约缺失时 `contract:'missing'`；
 *   3. 负断言：回包里的 logHealth 绝不含目录路径（只有 8 位指纹与枚举/数字）；
 *   4. 发射口按插件计数（本插件丢了什么，别的插件的行不算）；
 *   5. 老宿主形状：没有 wiring 时不产出 logHealth，也不崩。
 *
 * 只测外部行为：dist 公开出口 + 假落点 + mkdtemp 临时 homeDir，不碰真实家目录、不写真实日志目录。
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const log = await import('../dist/log/index.js')
const logManifest = await import('../dist/log/manifest.js')
const logHealthMod = await import('../dist/log/health.js')
const logRegistry = await import('../dist/log/registry.js')
const hostMod = await import('../dist/host.js')

// 映射函数与测试缝只从内部模块取，不走 `./log` 公共出口（#210 纪律：测试缝不上公共面）。
const { buildUpdateLogHealth } = logHealthMod
const {
  createLogRouter,
  createLogEmitter,
  logEmitterCountsFor,
  deriveLogNamespace,
  logDirHash,
  __resetOwnLogRegistryForTests,
} = log
const { __setOwnLogAcquireSeamsForTests } = logRegistry
const { __forceUpdateContractStatusForTests, __resetUpdateEventTableForTests } = logManifest
const { createHostUpdate, __resetSharedUpdateReaderForTests } = hostMod

/** 八格契约：logHealth 的键集合是冻结的（多一格就等于偷偷外放别的状态）。 */
const LOG_HEALTH_KEYS = ['contract', 'dirHash', 'droppedSinceStart', 'external', 'lastEventAt', 'reason', 'sink', 'switchEnabled']

const ZERO_COUNTS = () => ({ emitted: 0, skipped: 0, dropped: 0, lastEventAt: null })

function wiringOf(patch = {}) {
  return {
    pluginId: 'pure-map',
    sink: 'pending',
    dirHash: 'abcdef12',
    external: null,
    reason: null,
    pendingSink: null,
    handle: null,
    ...patch,
  }
}

/** 回包口径：一眼看完八格，且证明里面没有任何目录路径。 */
function assertNoPathInLogHealth(reply, forbidden) {
  const lh = reply?.logHealth
  assert.ok(lh, '成功回包必须带 logHealth：' + JSON.stringify(reply))
  assert.deepEqual(Object.keys(lh).sort(), LOG_HEALTH_KEYS, 'logHealth 只许有契约里的那八格')
  const text = JSON.stringify(lh)
  for (const one of forbidden) {
    assert.ok(!text.includes(one), `logHealth 里不许出现 ${one}：${text}`)
  }
  assert.ok(!/[\\/]/.test(text), 'logHealth 里不许出现任何路径分隔符：' + text)
  assert.ok(!/https?:\/\//.test(text), 'logHealth 里不许出现 URL：' + text)
  assert.equal(typeof lh.droppedSinceStart, 'number')
  assert.ok(Number.isFinite(lh.droppedSinceStart) && lh.droppedSinceStart >= 0)
  return lh
}

function makeHost({ pluginId, homeDir, logCtx, readInstalled }) {
  return createHostUpdate(
    {
      ...(logCtx === undefined ? {} : { logCtx }),
      readerOverrides: {
        runningVersion: '1.0.0',
        profileDir: 'C:\\fake\\profile',
        profileName: 'web',
        homeDir,
        now: () => 1_000_000,
        nodeVersion: '22.0.0',
        environmentKind: 'cli',
        readInstalled:
          readInstalled ??
          (async () => ({
            profileName: 'web',
            environmentKind: 'cli',
            homeDir,
            profileDir: 'C:\\fake\\profile',
            installedVersion: '1.0.0',
            packageValid: true,
            sourceInstall: false,
            blockedReason: null,
            installationKey: 'k',
            eligible: true,
          })),
        readJob: async () => null,
        writeJob: async () => {},
        tryAcquireLock: async () => true,
        releaseLock: async () => {},
        backupJob: async () => {},
        runInstall: async () => {},
      },
    },
    { pluginId, prefix: 'wf' }
  )
}

/** 自建实例是异步的：反复重查 updateStatus，直到读数不再是 pending（回包口径就是「稍后重查」）。 */
async function waitForSink(host, want, timeoutMs = 5000) {
  const started = Date.now()
  let last = null
  while (Date.now() - started < timeoutMs) {
    const reply = await host.handlers['wf.updateStatus']({})
    last = reply.logHealth
    if (last && last.sink === want) return { reply, logHealth: last }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`等待 sink=${want} 超时，最后读数：${JSON.stringify(last)}`)
}

const tempDirs = []
function makeTempHome(tag) {
  const dir = mkdtempSync(join(tmpdir(), `dsh-health-${tag}-`))
  tempDirs.push(dir)
  return dir
}

beforeEach(() => {
  __forceUpdateContractStatusForTests(null)
  __resetUpdateEventTableForTests()
  __resetSharedUpdateReaderForTests()
})

after(() => {
  __setOwnLogAcquireSeamsForTests(null)
  __resetOwnLogRegistryForTests()
  for (const dir of tempDirs.splice(0)) {
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
})

describe('#212 纯映射：buildUpdateLogHealth 按落点给口径（注入 deps，不碰进程单例）', () => {
  it('pending：落点未定、dirHash 是预期目录指纹、switchEnabled 为 null、只算发射口丢弃', () => {
    const lh = buildUpdateLogHealth(wiringOf({ sink: 'pending' }), {
      counts: () => ({ emitted: 3, skipped: 1, dropped: 2, lastEventAt: 123456 }),
      contract: () => 'ok',
    })
    assert.deepEqual(lh, {
      sink: 'pending',
      dirHash: 'abcdef12',
      switchEnabled: null,
      droppedSinceStart: 2,
      lastEventAt: 123456,
      contract: 'ok',
      external: null,
      reason: null,
    })
  })

  it('external：三种 gate 原样带出，dirHash 为 null（对方目录本包不猜）', () => {
    for (const gate of ['open', 'closed', 'unknown']) {
      const lh = buildUpdateLogHealth(wiringOf({ sink: 'external', dirHash: null, external: gate }), {
        counts: ZERO_COUNTS,
        contract: () => 'ok',
      })
      assert.equal(lh.sink, 'external')
      assert.equal(lh.external, gate)
      assert.equal(lh.dirHash, null)
      assert.equal(lh.switchEnabled, null)
      assert.equal(lh.reason, null)
    }
    // 没给判据＝未验证：映射层不许把它当成「有日志」
    const unverified = buildUpdateLogHealth(wiringOf({ sink: 'external', dirHash: null, external: null }), {
      counts: ZERO_COUNTS,
      contract: () => 'ok',
    })
    assert.equal(unverified.external, 'unknown')
  })

  it('off：原因三值带出，dirHash 是预期目录指纹，lastEventAt 必为 null（没有一行到过真落点）', () => {
    for (const reason of ['no-dsh-log', 'lease-conflict', 'write-fail']) {
      const lh = buildUpdateLogHealth(wiringOf({ sink: 'off', reason }), {
        // 故意给一个非 null 的 lastEventAt：待接缓冲里转一圈又倒掉的行不算「到过落点」。
        counts: () => ({ emitted: 5, skipped: 0, dropped: 1, lastEventAt: 987654 }),
        contract: () => 'ok',
      })
      assert.equal(lh.sink, 'off')
      assert.equal(lh.reason, reason)
      assert.equal(lh.lastEventAt, null)
      assert.equal(lh.switchEnabled, null)
      assert.equal(lh.external, null)
      assert.equal(lh.dirHash, 'abcdef12')
      assert.equal(lh.droppedSinceStart, 1)
    }
  })

  it('self：三处丢弃相加（发射口 + 待接缓冲 + 引擎自述），switchEnabled 取引擎自述', () => {
    const lh = buildUpdateLogHealth(wiringOf({ sink: 'self', handle: {}, pendingSink: {} }), {
      counts: () => ({ emitted: 5, skipped: 1, dropped: 1, lastEventAt: 999 }),
      contract: () => 'ok',
      engine: () => ({ switchEnabled: true, dropped: 4 }),
      pendingDropped: () => 2,
    })
    assert.equal(lh.sink, 'self')
    assert.equal(lh.droppedSinceStart, 7)
    assert.equal(lh.switchEnabled, true)
    assert.equal(lh.lastEventAt, 999)
    assert.equal(lh.reason, null)
    assert.equal(lh.external, null)
  })

  it('引擎自述坏了不抛：switchEnabled 回 null、丢弃按 0 计', () => {
    const thrower = buildUpdateLogHealth(
      wiringOf({ sink: 'self', handle: { health: () => { throw new Error('engine boom') } } }),
      { counts: ZERO_COUNTS, contract: () => 'ok' }
    )
    assert.equal(thrower.switchEnabled, null)
    assert.equal(thrower.droppedSinceStart, 0)
    const junk = buildUpdateLogHealth(wiringOf({ sink: 'self', handle: {}, pendingSink: {} }), {
      counts: () => ({ emitted: 1, skipped: 0, dropped: Number.NaN, lastEventAt: Number.NaN }),
      contract: () => 'ok',
      engine: () => ({ switchEnabled: 'yes', dropped: -3 }),
      pendingDropped: () => Number.NaN,
    })
    assert.equal(junk.switchEnabled, null, '引擎自述不是布尔就回 null，不猜')
    assert.equal(junk.droppedSinceStart, 0, '负数/NaN 不许冒充丢弃数')
    assert.equal(junk.lastEventAt, null, '时间取不到就回 null')
  })

  it('契约状态原样带出；wiring 缺失时回 null（老宿主形状）', () => {
    for (const state of ['unloaded', 'ok', 'missing', 'invalid']) {
      const lh = buildUpdateLogHealth(wiringOf({ sink: 'pending' }), { counts: ZERO_COUNTS, contract: () => state })
      assert.equal(lh.contract, state)
    }
    assert.equal(buildUpdateLogHealth(null), null)
    assert.equal(buildUpdateLogHealth(undefined), null)
    assert.equal(buildUpdateLogHealth({}), null)
  })

  it('落点认不出时回 null：不猜成 pending，也不外放半截读数', () => {
    assert.equal(buildUpdateLogHealth(wiringOf({ sink: 'mystery' }), { counts: ZERO_COUNTS, contract: () => 'ok' }), null)
    assert.equal(buildUpdateLogHealth(wiringOf({ sink: 42 }), { counts: ZERO_COUNTS, contract: () => 'ok' }), null)
  })
})

describe('#212 接线四现场：updateStatus 回包里的 logHealth 来自真实接线状态', () => {
  it('self：真 dsh-log 建库成功 → sink self、8 位指纹、开关默认 false、契约 ok、最近事件是数字', async () => {
    const pluginId = 'health-self'
    const homeDir = makeTempHome('self')
    __resetOwnLogRegistryForTests()
    const host = makeHost({ pluginId, homeDir })
    try {
      const { reply, logHealth } = await waitForSink(host, 'self')
      const lh = assertNoPathInLogHealth(reply, [homeDir, tmpdir()])
      assert.equal(lh.sink, 'self')
      assert.match(lh.dirHash, /^[0-9a-f]{8}$/)
      assert.equal(lh.dirHash, logDirHash(join(homeDir, 'logs', deriveLogNamespace(pluginId))))
      assert.equal(lh.switchEnabled, false, '默认开关是关的（只影响按需 info，常驻行照落）')
      assert.equal(lh.reason, null)
      assert.equal(lh.external, null)
      assert.equal(lh.contract, 'ok')
      assert.equal(typeof lh.lastEventAt, 'number')
      assert.ok(lh.lastEventAt > 0, '接线成功后至少有一行到过落点')
      assert.equal(reply.logContract.state, 'ok', '老口径 logContract 照旧')
    } finally {
      __resetOwnLogRegistryForTests()
    }
  })

  it('external（已验证）：isEnabled 为真 → external open、dirHash null、本包不开第二个写者', async () => {
    const fires = []
    const host = makeHost({
      pluginId: 'health-external-open',
      homeDir: 'C:\\fake\\home',
      logCtx: { fire: (level, event, fields) => fires.push({ level, event, fields }), isEnabled: () => true },
    })
    const reply = await host.handlers['wf.updateStatus']({})
    const lh = assertNoPathInLogHealth(reply, ['C:\\fake\\home', 'C:\\fake\\profile'])
    assert.equal(lh.sink, 'external')
    assert.equal(lh.external, 'open')
    assert.equal(lh.dirHash, null)
    assert.equal(lh.switchEnabled, null)
    assert.equal(lh.reason, null)
    assert.equal(lh.droppedSinceStart, 0, '对方放行的落点不该有本包侧的丢弃')
    assert.equal(typeof lh.lastEventAt, 'number')
    assert.ok(fires.some((row) => row.event === 'update.wire.ready' && row.fields.logSink === 'external'))
  })

  it('external-unverified：没给 isEnabled → external unknown（未验证，不得当「有日志」）', async () => {
    const fires = []
    const host = makeHost({
      pluginId: 'health-external-unknown',
      homeDir: 'C:\\fake\\home',
      logCtx: { fire: (level, event, fields) => fires.push({ level, event, fields }) },
    })
    const reply = await host.handlers['wf.updateStatus']({})
    const lh = assertNoPathInLogHealth(reply, ['C:\\fake\\home'])
    assert.equal(lh.sink, 'external')
    assert.equal(lh.external, 'unknown')
    assert.equal(lh.dirHash, null)
    assert.equal(lh.switchEnabled, null)
    assert.equal(lh.reason, null)
    assert.ok(fires.length >= 1, '没给判据时照旧把行交给集成方的实例')
  })

  it('external（明确未放行）：isEnabled 为假 / 抛错 → closed / unknown', async () => {
    const closedFires = []
    const closed = makeHost({
      pluginId: 'health-external-closed',
      homeDir: 'C:\\fake\\home',
      logCtx: { fire: (level, event, fields) => closedFires.push({ level, event, fields }), isEnabled: () => false },
    })
    const closedReply = await closed.handlers['wf.updateStatus']({})
    const closedLh = assertNoPathInLogHealth(closedReply, ['C:\\fake\\home'])
    assert.equal(closedLh.sink, 'external')
    assert.equal(closedLh.external, 'closed')
    assert.equal(closedLh.dirHash, null)
    assert.equal(closedLh.switchEnabled, null)
    assert.equal(closedFires.length, 0, '对方说没放行就不该有行过去（准入短路，不是丢弃）')
    assert.equal(closedLh.droppedSinceStart, 0)

    const throwing = makeHost({
      pluginId: 'health-external-throwing',
      homeDir: 'C:\\fake\\home',
      logCtx: {
        fire: () => {},
        isEnabled: () => {
          throw new Error('gate boom')
        },
      },
    })
    const throwingReply = await throwing.handlers['wf.updateStatus']({})
    assert.equal(throwingReply.logHealth.sink, 'external')
    assert.equal(throwingReply.logHealth.external, 'unknown', '判据抛错＝没判据，不是「未放行」')
  })

  it('off：拿不到 dsh-log → sink off、reason no-dsh-log、dirHash 是预期目录指纹、lastEventAt null', async () => {
    const pluginId = 'health-off'
    const homeDir = makeTempHome('off')
    __resetOwnLogRegistryForTests()
    __setOwnLogAcquireSeamsForTests({
      loader: async () => {
        throw new Error('cannot find module dsh-log')
      },
      retryDelaysMs: [],
    })
    try {
      const host = makeHost({ pluginId, homeDir })
      const { reply, logHealth } = await waitForSink(host, 'off')
      const lh = assertNoPathInLogHealth(reply, [homeDir, tmpdir()])
      assert.equal(lh.sink, 'off')
      assert.equal(lh.reason, 'no-dsh-log')
      assert.equal(lh.dirHash, logDirHash(join(homeDir, 'logs', deriveLogNamespace(pluginId))), '降级也要报「本来该写哪」的指纹')
      assert.equal(lh.switchEnabled, null)
      assert.equal(lh.external, null)
      assert.equal(lh.lastEventAt, null, '没有落点就没有一行到过落点')
      assert.ok(lh.droppedSinceStart >= 1, '没有落点时本包的行都在丢弃计数里')
      assert.equal(lh.contract, 'ok')
    } finally {
      __setOwnLogAcquireSeamsForTests(null)
      __resetOwnLogRegistryForTests()
    }
  })

  it('契约缺失：任一现场 + 强制 missing → logHealth.contract 同步为 missing', async () => {
    __forceUpdateContractStatusForTests({
      state: 'missing',
      file: 'event-list.update.json',
      events: 0,
      failure: 'read',
    })
    const host = makeHost({
      pluginId: 'health-contract-missing',
      homeDir: 'C:\\fake\\home',
      logCtx: { fire: () => {}, isEnabled: () => true },
    })
    const reply = await host.handlers['wf.updateStatus']({})
    assert.equal(reply.logContract.state, 'missing')
    assert.equal(reply.logHealth.contract, 'missing', '没有尺子这件事必须同时出现在两处读数里')
    assert.equal(reply.logHealth.sink, 'external')
  })

  it('失败回包不带 logHealth（只增不改：老调用方拿到的失败形状一字不变）', async () => {
    const host = makeHost({
      pluginId: 'health-fail-reply',
      homeDir: 'C:\\fake\\home',
      logCtx: { fire: () => {} },
      readInstalled: async () => {
        throw new Error('installed-state boom')
      },
    })
    const reply = await host.handlers['wf.updateStatus']({})
    assert.equal(reply.ok, false, '读数坏掉就该是失败回包：' + JSON.stringify(reply))
    assert.equal('logHealth' in reply, false, '失败回包不带 logHealth')
  })
})

describe('#212 发射口按插件计数：本插件丢了什么，别的插件的行不算', () => {
  it('emitted / skipped / dropped 各归各家，lastEventAt 只在真写进落点时更新', () => {
    const rowsA = []
    const router = createLogRouter()
    router.bind('plugin-a', { fire: (level, event, fields) => rowsA.push({ level, event, fields }) })
    router.bind('plugin-b', { fire: () => {}, isEnabled: () => false })
    const emitter = createLogEmitter({ resolve: (id) => router.resolve(id), table: () => null })
    const t0 = Date.now()
    assert.equal(emitter.emit('info', 'update.panel.action', { action: 'check' }, { pluginId: 'plugin-a' }), true)
    assert.equal(emitter.emit('info', 'update.panel.action', { action: 'check' }, { pluginId: 'plugin-b' }), false)
    assert.equal(emitter.emit('info', 'update.panel.action', { action: 'check' }, { pluginId: 'plugin-c' }), false)

    const a = emitter.pluginCounts('plugin-a')
    assert.equal(a.emitted, 1)
    assert.equal(a.skipped, 0)
    assert.equal(a.dropped, 0)
    assert.equal(typeof a.lastEventAt, 'number')
    assert.ok(a.lastEventAt >= t0, 'lastEventAt 是最近一次真写进落点的时间')

    const b = emitter.pluginCounts('plugin-b')
    assert.equal(b.emitted, 0)
    assert.equal(b.skipped, 1)
    assert.equal(b.dropped, 0, '准入短路是「没开开关」，不是丢行')
    assert.equal(b.lastEventAt, null)
    assert.equal(b.lastEventAt === null, true)

    const c = emitter.pluginCounts('plugin-c')
    assert.equal(c.dropped, 1, '没有落点＝丢弃')
    assert.equal(c.emitted, 0)
    assert.equal(c.lastEventAt, null)
    assert.equal(rowsA.length, 1)

    // 进程单例出口的同一读数口：没发射过的插件是全零，不是别人的数
    const untouched = logEmitterCountsFor('never-emitted-' + process.pid)
    assert.deepEqual(untouched, { emitted: 0, skipped: 0, dropped: 0, lastEventAt: null })
    // 既有计数形状不动（#210 与诊断面都在读它）
    assert.equal(emitter.counts().emitted, 1)
    assert.equal(emitter.counts().skipped, 1)
    assert.equal(emitter.counts().dropped, 1)
  })

  it('待接落点接不上：缓冲行逐行计入丢弃（不再静默蒸发）', async () => {
    const { createPendingSink } = log
    const pending = createPendingSink(4)
    pending.sink.fire('info', 'update.wire.ready', { logSink: 'self', logDirHash: 'aaaaaaaa' })
    pending.sink.fire('info', 'update.wire.ready', { logSink: 'self', logDirHash: 'bbbbbbbb' })
    assert.equal(pending.pendingCount(), 2)
    assert.equal(pending.droppedCount(), 0)
    pending.attach(null)
    assert.equal(pending.pendingCount(), 0)
    assert.equal(pending.droppedCount(), 2, '倒进无操作落点的行必须计入丢弃')
    assert.equal(pending.isAttached(), true)
  })
})
