/**
 * tests/issue-211-wire.test.mjs —— issue #211 AC-2：`update.wire.ready` 的接线身份五格。
 *
 * 钉住五件事：
 *   1. 每一支接线（external / external-unverified / self / off）都恰好落**一条** wire.ready，
 *      字段正好五格：logSink / logDirHash / updaterVersion / copyLevel / hostKind；
 *   2. logSink 语义：外部落点探针 open → external；closed / unknown / 探针抛错 → external-unverified
 *      （「没验证通过」不许冒充 external）；
 *   3. logDirHash 口径不变：external 支是本包算出的预期目录指纹，self 支是真实落点目录指纹；
 *   4. updaterVersion / copyLevel / hostKind 的取值来源分别是 ownPackageVersion()、
 *      selfCopyLevelOf(packageRoot())、detectEnvironmentKind(ctx, profileName)；
 *      environmentKind 显式覆盖优先（与 updateStatus 读取器同一口径）；
 *   5. off 支在**降级之后**才发，且三格身份与 logDirHash 仍在（降级也要能回答「本来该写哪」）。
 *
 * 只测外部行为：dist 公开出口 + 假 logCtx / mkdtemp 临时 homeDir / 假 dsh-log 测试缝，
 * 不碰真实家目录、不写真实日志目录（self 支也只写到临时 homeDir 下）。
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const log = await import('../dist/log/index.js')
const logManifest = await import('../dist/log/manifest.js')
const logRegistryModule = await import('../dist/log/registry.js')
const selfModule = await import('../dist/shared/self.js')
const hostMod = await import('../dist/host.js')

const {
  flushUpdateLog,
  logDirHash,
  deriveLogNamespace,
  ownPackageVersion,
  packageRoot,
  updateLogRouter,
  __resetOwnLogRegistryForTests,
} = log
const { __setOwnLogAcquireSeamsForTests } = logRegistryModule
const { __forceUpdateContractStatusForTests, __resetUpdateEventTableForTests } = logManifest
const { selfCopyLevelOf } = selfModule
const { createHostUpdate, __resetSharedUpdateReaderForTests } = hostMod

/** 冻结契约：wire.ready 正好五格（多一格 / 少一格都算破坏线上形状）。 */
const WIRE_KEYS = ['copyLevel', 'hostKind', 'logDirHash', 'logSink', 'updaterVersion']
const SINKS = ['external', 'external-unverified', 'self', 'off']
const COPY_LEVELS = ['profile', 'nested', 'repo', 'unknown']
const HOST_KINDS = ['desktop', 'desktop-manager', 'cli']

const expectedVersion = () => ownPackageVersion()
const expectedCopyLevel = () => selfCopyLevelOf(packageRoot())

function makeTempHome(tag) {
  return mkdtempSync(join(tmpdir(), `dsh-update-wire-${tag}-`))
}

/**
 * 一台最小宿主：不给 logCtx 时走自建支（self/off），给了就走 external 支。
 * 所有磁盘假件都置空/假件，只有日志目录会真的落到 homeDir（测试用临时目录）。
 */
function makeHost({
  pluginId,
  homeDir,
  logCtx,
  ctx,
  pluginManager,
  environmentKind = 'cli',
  omitEnvironmentKind = false,
  profileName = 'web',
  profileDir = 'C:\\fake\\profile',
}) {
  const readerOverrides = {
    runningVersion: '1.0.0',
    profileDir,
    profileName,
    homeDir,
    now: () => 1_000_000,
    nodeVersion: '22.0.0',
    readInstalled: async () => ({
      profileName,
      environmentKind: environmentKind ?? 'cli',
      homeDir,
      profileDir,
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
  }
  // 不给显式 environmentKind 时走「与读取器同一探测口径」（desktop / desktop-manager 两个分支）。
  if (!omitEnvironmentKind) readerOverrides.environmentKind = environmentKind
  return createHostUpdate(
    {
      ...(logCtx === undefined ? {} : { logCtx }),
      ...(ctx === undefined ? {} : { ctx }),
      ...(pluginManager === undefined ? {} : { pluginManager }),
      readerOverrides,
    },
    { pluginId, prefix: 'wf' },
  )
}

/** 收集 logCtx 落点的行（external 支用）。 */
function collector({ isEnabled } = {}) {
  const fires = []
  const sink = {
    fire: (level, event, fields) => fires.push({ level, event, fields }),
  }
  if (isEnabled !== undefined) sink.isEnabled = isEnabled
  return { fires, sink }
}

function wireRows(fires) {
  return fires.filter((row) => row.event === 'update.wire.ready')
}

/** 五格口径最集中的一处断言：字段集合 + 身份三格 + logSink/logDirHash。 */
function assertWireRow(fields, { logSink, logDirHash: dirHash, hostKind }) {
  assert.deepEqual(Object.keys(fields).sort(), WIRE_KEYS, 'wire.ready 必须正好五格：' + JSON.stringify(fields))
  assert.ok(SINKS.includes(fields.logSink), `logSink 在冻结枚举内：${fields.logSink}`)
  assert.equal(fields.logSink, logSink)
  assert.equal(fields.logDirHash, dirHash)
  assert.equal(fields.updaterVersion, expectedVersion(), 'updaterVersion 来自 ownPackageVersion()')
  assert.ok(COPY_LEVELS.includes(fields.copyLevel), `copyLevel 在冻结枚举内：${fields.copyLevel}`)
  assert.equal(fields.copyLevel, expectedCopyLevel(), 'copyLevel 来自 selfCopyLevelOf(packageRoot())')
  assert.ok(HOST_KINDS.includes(fields.hostKind), `hostKind 在冻结枚举内：${fields.hostKind}`)
  assert.equal(fields.hostKind, hostKind)
}

/** 自建实例是异步的：反复重查 updateStatus，直到 logHealth.sink 落定（回包口径就是「稍后重查」）。 */
async function waitForSink(host, want, timeoutMs = 5000) {
  const started = Date.now()
  let last = null
  while (Date.now() - started < timeoutMs) {
    const reply = await host.handlers['wf.updateStatus']({})
    last = reply.logHealth
    if (last && last.sink === want) return last
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`等不到 logHealth.sink=${want}（最后读数：${JSON.stringify(last)}）`)
}

async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now()
  for (;;) {
    const got = await predicate()
    if (got) return got
    if (Date.now() - started > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** 读 self 支真实落盘目录里的全部行（JSONL；解析不了的行跳过）。 */
function readLogRows(logsDir) {
  const rows = []
  for (const name of readdirSync(logsDir).filter((one) => one.endsWith('.log'))) {
    const text = readFileSync(join(logsDir, name), 'utf8')
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        rows.push(JSON.parse(trimmed))
      } catch {
        /* 半行 / 非 JSON 行不算本测试的对象 */
      }
    }
  }
  return rows
}

beforeEach(() => {
  __resetSharedUpdateReaderForTests()
  __resetOwnLogRegistryForTests()
  __forceUpdateContractStatusForTests(null)
  __resetUpdateEventTableForTests()
})

afterEach(() => {
  __resetSharedUpdateReaderForTests()
  __resetOwnLogRegistryForTests()
  __forceUpdateContractStatusForTests(null)
  __resetUpdateEventTableForTests()
})

describe('#211 update.wire.ready：external 支的五格与准入语义', () => {
  it('external + 探针 open → logSink=external、五格齐全、logDirHash 是预期目录指纹', () => {
    const pluginId = 'wire-external-open'
    const homeDir = 'C:\\fake\\home'
    const { fires, sink } = collector({ isEnabled: () => true })
    makeHost({ pluginId, homeDir, logCtx: sink })
    const rows = wireRows(fires)
    assert.equal(rows.length, 1, '一次接线只许一条 wire.ready')
    assertWireRow(rows[0].fields, {
      logSink: 'external',
      logDirHash: logDirHash(join(homeDir, 'logs', deriveLogNamespace(pluginId))),
      hostKind: 'cli',
    })
  })

  it('external + 对方没给 isEnabled → external-unverified（未验证不许冒充 external）', () => {
    const pluginId = 'wire-external-unknown'
    const homeDir = 'C:\\fake\\home'
    const { fires, sink } = collector()
    makeHost({ pluginId, homeDir, logCtx: sink })
    const rows = wireRows(fires)
    assert.equal(rows.length, 1)
    assertWireRow(rows[0].fields, {
      logSink: 'external-unverified',
      logDirHash: logDirHash(join(homeDir, 'logs', deriveLogNamespace(pluginId))),
      hostKind: 'cli',
    })
  })

  it('external + 探针 closed / 抛错 → 都不许冒充 external（closed 落点自己会拒收该行）', async () => {
    // closed：对方落点对 update.wire.ready 判定为关闭，发射口按 isEnabled 直接跳过——
    // 这一行在落点上本来看不见（这正是「关闭」的含义），能观察的是回包 logHealth.external。
    const closed = collector({ isEnabled: () => false })
    const closedHost = makeHost({ pluginId: 'wire-external-closed', homeDir: 'C:\\fake\\home', logCtx: closed.sink })
    assert.equal(wireRows(closed.fires).length, 0)
    const closedReply = await closedHost.handlers['wf.updateStatus']({})
    assert.equal(closedReply.logHealth.external, 'closed')

    const throwing = collector({
      isEnabled: () => {
        throw new Error('gate boom')
      },
    })
    makeHost({ pluginId: 'wire-external-throwing', homeDir: 'C:\\fake\\home', logCtx: throwing.sink })
    assert.equal(wireRows(throwing.fires).length, 1)
    assertWireRow(wireRows(throwing.fires)[0].fields, {
      logSink: 'external-unverified',
      logDirHash: logDirHash(join('C:\\fake\\home', 'logs', deriveLogNamespace('wire-external-throwing'))),
      hostKind: 'cli',
    })
  })

  it('hostKind：有 desktopProfiles 服务 → desktop（非 cli）；显式 environmentKind 覆盖优先', () => {
    const desktopCtx = {
      get: (name) => (name === 'desktopProfiles' ? { current: { name: 'desktop', dir: 'C:\\fake\\profile' } } : undefined),
    }
    const desktopPlugin = 'wire-host-desktop'
    const desktop = collector({ isEnabled: () => true })
    makeHost({ pluginId: desktopPlugin, homeDir: 'C:\\fake\\home', logCtx: desktop.sink, ctx: desktopCtx, omitEnvironmentKind: true })
    assertWireRow(wireRows(desktop.fires)[0].fields, {
      logSink: 'external',
      logDirHash: logDirHash(join('C:\\fake\\home', 'logs', deriveLogNamespace(desktopPlugin))),
      hostKind: 'desktop',
    })

    // 显式 environmentKind（读取器同一口径）优先于 ctx 探测：这里故意是 cli。
    const overridden = collector({ isEnabled: () => true })
    makeHost({
      pluginId: 'wire-host-override',
      homeDir: 'C:\\fake\\home',
      logCtx: overridden.sink,
      ctx: desktopCtx,
      environmentKind: 'cli',
    })
    assertWireRow(wireRows(overridden.fires)[0].fields, {
      logSink: 'external',
      logDirHash: logDirHash(join('C:\\fake\\home', 'logs', deriveLogNamespace('wire-host-override'))),
      hostKind: 'cli',
    })
  })

  it('hostKind：pluginManager.installBundle + 使用范围名 desktop → desktop-manager', () => {
    const pluginId = 'wire-host-manager'
    const manager = { installBundle: () => {} }
    const managerCtx = { get: (name) => (name === 'pluginManager' ? manager : undefined) }
    const { fires, sink } = collector({ isEnabled: () => true })
    makeHost({
      pluginId,
      homeDir: 'C:\\fake\\home',
      logCtx: sink,
      ctx: managerCtx,
      pluginManager: manager,
      profileName: 'desktop',
      omitEnvironmentKind: true,
    })
    assertWireRow(wireRows(fires)[0].fields, {
      logSink: 'external',
      logDirHash: logDirHash(join('C:\\fake\\home', 'logs', deriveLogNamespace(pluginId))),
      hostKind: 'desktop-manager',
    })
  })

  it('hostKind：只给 profileDir 时与读取器同一取法（名字取目录最后一段）→ desktop-manager，不误判 cli', () => {
    const pluginId = 'wire-host-manager-dir'
    const manager = { installBundle: () => {} }
    const managerCtx = { get: (name) => (name === 'pluginManager' ? manager : undefined) }
    const { fires, sink } = collector({ isEnabled: () => true })
    makeHost({
      pluginId,
      homeDir: 'C:\\fake\\home',
      logCtx: sink,
      ctx: managerCtx,
      pluginManager: manager,
      profileName: null,
      profileDir: 'C:\\fake\\profiles\\desktop',
      omitEnvironmentKind: true,
    })
    assertWireRow(wireRows(fires)[0].fields, {
      logSink: 'external',
      logDirHash: logDirHash(join('C:\\fake\\home', 'logs', deriveLogNamespace(pluginId))),
      hostKind: 'desktop-manager',
    })
  })
})

describe('#211 update.wire.ready：self 支（真实落盘）的五格', () => {
  it('self：建库成功后恰好一条 wire.ready，logDirHash 是真实落点目录指纹，身份三格齐全', async () => {
    const pluginId = 'wire-self'
    const homeDir = makeTempHome('self')
    const logsDir = join(homeDir, 'logs', deriveLogNamespace(pluginId))
    try {
      const host = makeHost({ pluginId, homeDir })
      const logHealth = await waitForSink(host, 'self')
      assert.equal(logHealth.sink, 'self')
      const flushed = await flushUpdateLog({ timeoutMs: 3000 })
      assert.equal(flushed.stores, 1, 'self 支应有一条 own-log 登记（flushUpdateLog 能看见它）')
      assert.equal(flushed.timedOut, false)

      const rows = readLogRows(logsDir).filter((row) => row.event === 'update.wire.ready')
      assert.equal(rows.length, 1, '一次接线只许一条 wire.ready（self 支也不许重复发）')
      assertWireRow(rows[0].fields, {
        logSink: 'self',
        logDirHash: logDirHash(logsDir),
        hostKind: 'cli',
      })
    } finally {
      updateLogRouter.unbind(pluginId)
      __resetOwnLogRegistryForTests()
      rmSync(homeDir, { recursive: true, force: true })
    }
  })
})

describe('#211 update.wire.ready：off 支（拿不到 dsh-log）也要带身份与预期目录指纹', () => {
  it('off：降级后发一条 wire.ready，五格齐全、logSink=off', async () => {
    const pluginId = 'wire-off'
    const homeDir = makeTempHome('off')
    try {
      __setOwnLogAcquireSeamsForTests({
        loader: async () => {
          throw new Error('cannot find module dsh-log')
        },
        retryDelaysMs: [],
      })
      // 同步返回后就立刻抢绑路由表：off 支是异步的，本测试要接住它之后才发的那一行。
      const host = makeHost({ pluginId, homeDir })
      const captured = []
      updateLogRouter.bind(pluginId, {
        fire: (level, event, fields) => {
          if (event === 'update.wire.ready') captured.push(fields)
        },
      })
      await waitFor(() => captured.length > 0)
      assert.equal(captured.length, 1, '一次接线只许一条 wire.ready（off 支也不许重复发）')
      assertWireRow(captured[0], {
        logSink: 'off',
        logDirHash: logDirHash(join(homeDir, 'logs', deriveLogNamespace(pluginId))),
        hostKind: 'cli',
      })
      // off 支的 wiring 回包口径也被 harness 顺手验一下：logHealth 能如实报 off。
      const reply = await host.handlers['wf.updateStatus']({})
      assert.equal(reply.logHealth.sink, 'off')
      assert.equal(reply.logHealth.reason, 'no-dsh-log')
    } finally {
      updateLogRouter.unbind(pluginId)
      __setOwnLogAcquireSeamsForTests(null)
      __resetOwnLogRegistryForTests()
      rmSync(homeDir, { recursive: true, force: true })
    }
  })
})
