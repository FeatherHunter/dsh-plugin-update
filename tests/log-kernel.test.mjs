/**
 * tests/log-kernel.test.mjs —— 日志内核验收（地图「全面集成 dsh-log 0.3.1」· 票「日志内核」#121）。
 *
 * 钉住的四件事：
 *   1. 派生命名空间：合法原样通过、有损必带指纹、不同标识永不共目录（不变量）；
 *   2. 登记表：同目录同进程只有一个句柄、引用计数到零才释放、撞租约降级而不抛、冷却不永久死；
 *   3. 路由：每个插件标识各写各的落点，取不到就丢弃计数，绝不回退到别人的 sink；
 *   4. 唯一发射口四条纪律：字段白名单 / 脱敏 / 准入短路 / 预算守卫，且落点抛错不外抛。
 * 外加一条真引擎端到端：真装 dsh-log 0.3.4，真落一份文件，真读出五键行（含启动头那一行）。
 */
import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const kernel = await import('../dist/log/index.js')
const {
  deriveLogNamespace,
  hashToken,
  logDirKey,
  logSwitchFileName,
  createLogRouter,
  createLogEmitter,
  createPendingSink,
  sinkFromLogCtx,
  acquireOwnLog,
  releaseOwnLog,
  describeOwnLogRegistry,
  lastOwnLogDegraded,
  buildUpdateManifest,
  loadUpdateEventTable,
  ownPackageVersion,
  isEdgeEvent,
  sanitizeLogFields,
  __resetOwnLogRegistryForTests,
} = kernel

/** 收行用的假落点：把行原样记下来，便于断言「谁收到了什么」。 */
function collectSink(rows, opts = {}) {
  return {
    fire: (level, event, fields) => rows.push({ level, event, fields }),
    ...(opts.isEnabled ? { isEnabled: opts.isEnabled } : {}),
  }
}

describe('日志内核：派生命名空间', () => {
  it('合法标识原样通过（集成方拿到的目录名就是它自己写的标识）', () => {
    for (const id of ['wf', 'my-plugin', 'dsh-mattpocock-skills-deck', 'a', 'p-1-2-3']) {
      assert.equal(deriveLogNamespace(id), id, id + ' 应原样通过')
    }
  })

  it('有损映射必带指纹：大写 / 点 / 空格 / 中文 / 超长都不与原标识同形', () => {
    const cases = [
      'My.Plugin',
      'MY-PLUGIN',
      'my plugin',
      '中文插件',
      'my--plugin-',
      'a'.repeat(40),
    ]
    for (const raw of cases) {
      const got = deriveLogNamespace(raw)
      assert.match(got, /^[a-z0-9-]{1,32}$/, raw + ' → ' + got + ' 必须满足 dsh-log 的 pluginId 形状')
      assert.notEqual(got, raw, raw + ' 是有损映射，不该原样返回')
      assert.ok(got.includes(hashToken(raw, 6)), raw + ' 的派生名应带自己的 6 位指纹')
    }
  })

  it('不变量：不同 raw 标识永不落到同一个名字（这正是「日志互相覆盖」的根因）', () => {
    const raws = ['My.Plugin', 'my-plugin', 'my.plugin', 'my plugin', 'my--plugin', 'MY.PLUGIN', '中文插件', '插件中文']
    const seen = new Map()
    for (const raw of raws) {
      const got = deriveLogNamespace(raw)
      assert.equal(seen.has(got), false, `派生名撞车：${raw} 与 ${seen.get(got)} 都是 ${got}`)
      seen.set(got, raw)
    }
  })

  it('空标识回退 plugin-<指纹>，绝不产出空目录名', () => {
    for (const raw of ['', '   ', '...', null, undefined, 42]) {
      const got = deriveLogNamespace(raw)
      assert.match(got, /^[a-z0-9-]{1,32}$/)
      assert.ok(got.startsWith('plugin-') || got.length > 0)
    }
  })

  it('同一标识稳定派生（跨进程、跨副本、跨版本都要一致）', () => {
    const first = deriveLogNamespace('My.Plugin')
    for (let i = 0; i < 5; i++) assert.equal(deriveLogNamespace('My.Plugin'), first)
  })

  it('目录身份键在 Windows 上折叠大小写、在 POSIX 上不折叠', () => {
    assert.equal(logDirKey('C:\\Logs\\My-Plugin\\'), 'c:\\logs\\my-plugin')
    assert.equal(logDirKey('/var/logs/My-Plugin/'), '/var/logs/My-Plugin')
    assert.equal(logDirKey('\\\\server\\share\\Logs'), '\\\\server\\share\\logs')
  })

  it('开关文件名：wf 走 dsh-log 的保留名，其余带命名空间后缀', () => {
    assert.equal(logSwitchFileName('wf'), 'log-switch.json')
    assert.equal(logSwitchFileName('my-plugin'), 'log-switch-my-plugin.json')
  })
})

describe('日志内核：按插件标识路由（多插件不串台）', () => {
  it('两个插件各写各的落点，谁后绑都不会收走前一个的行', () => {
    const rowsA = []
    const rowsB = []
    const router = createLogRouter()
    router.bind('plugin-a', collectSink(rowsA))
    router.bind('plugin-b', collectSink(rowsB))
    // 模拟「后装的插件改了模块级落点」：再绑一次 A 的标识，B 的行必须还在 B 那里。
    router.bind('plugin-a', collectSink(rowsA))
    const emitter = createLogEmitter({ resolve: (id) => router.resolve(id) })
    emitter.emit('warn', 'update.log.degraded', { reason: 'no-dsh-log' }, { pluginId: 'plugin-a' })
    emitter.emit('warn', 'update.log.degraded', { reason: 'write-fail' }, { pluginId: 'plugin-b' })
    emitter.emit('warn', 'update.log.degraded', { reason: 'emit-threw' }, { pluginId: 'plugin-a' })
    assert.deepEqual(rowsA.map((r) => r.fields.reason), ['no-dsh-log', 'emit-threw'])
    assert.deepEqual(rowsB.map((r) => r.fields.reason), ['write-fail'])
  })

  it('取不到落点即丢弃并计数，绝不回退到别人的 sink', () => {
    const rows = []
    const router = createLogRouter()
    router.bind('plugin-a', collectSink(rows))
    const emitter = createLogEmitter({ resolve: (id) => router.resolve(id) })
    const ok = emitter.emit('info', 'update.log.degraded', { reason: 'no-dsh-log' }, { pluginId: 'plugin-b' })
    assert.equal(ok, false)
    assert.equal(rows.length, 0, 'B 的行不许落到 A 的落点')
    assert.equal(emitter.counts().dropped, 1)
    assert.equal(emitter.counts().droppedByReason['no-sink'], 1)
  })

  it('解绑只摘自己那一个（后绑的不会被误摘）', () => {
    const router = createLogRouter()
    const first = collectSink([])
    router.bind('p', first)
    assert.equal(router.unbind('p', collectSink([])), false, '不是当前绑定的那个，不摘')
    assert.equal(router.resolve('p'), first)
    assert.equal(router.unbind('p', first), true)
    assert.equal(router.resolve('p'), null)
  })

  it('既有 logCtx 形状照旧可用（生态兼容），半成品落点被拒', () => {
    const rows = []
    const sink = sinkFromLogCtx({ fire: (level, event, fields) => rows.push({ level, event, fields }) })
    assert.ok(sink && typeof sink.fire === 'function')
    sink.fire('info', 'update.wire.ready', { logSink: 'external', logDirHash: 'abcdef12' })
    assert.equal(rows.length, 1)
    assert.equal(sinkFromLogCtx(null), null)
    assert.equal(sinkFromLogCtx({}), null)
    assert.equal(sinkFromLogCtx('nope'), null)
  })

  it('待接落点先收后转：建库成功前的行按序补上，转不进去的计入丢弃', () => {
    const rows = []
    const pending = createPendingSink(4)
    pending.sink.fire('info', 'update.wire.ready', { logSink: 'self', logDirHash: 'aaaaaaaa' })
    pending.sink.fire('info', 'update.wire.ready', { logSink: 'self', logDirHash: 'bbbbbbbb' })
    assert.equal(pending.pendingCount(), 2)
    pending.attach(collectSink(rows))
    assert.equal(rows.length, 2)
    assert.equal(pending.isAttached(), true)
    const dropped = createPendingSink(1)
    dropped.sink.fire('info', 'update.wire.ready', { logSink: 'self', logDirHash: 'cccccccc' })
    dropped.sink.fire('info', 'update.wire.ready', { logSink: 'self', logDirHash: 'dddddddd' })
    assert.equal(dropped.droppedCount(), 1, '缓冲满了就丢新的并计数')
  })
})

describe('日志内核：登记表（同进程一个目录一个句柄）', () => {
  const fakeModule = (state) => ({
    createNodeHostLog: async () => {
      state.created++
      return {
        log: () => {},
        isEnabled: () => true,
        release: () => {
          state.released++
        },
        getDroppedCount: () => 0,
        getLastPersistFail: () => null,
      }
    },
  })

  before(() => __resetOwnLogRegistryForTests())
  after(() => __resetOwnLogRegistryForTests())

  it('同目录第二次取库拿到同一个句柄（引用计数），不是第二个写者', async () => {
    const state = { created: 0, released: 0 }
    const loader = async () => fakeModule(state)
    const first = await acquireOwnLog({ logsRoot: '/tmp/kernel-a', namespace: 'plugin-a', prefix: 'wf', loader })
    const second = await acquireOwnLog({ logsRoot: '/tmp/kernel-a', namespace: 'plugin-a', prefix: 'wf', loader })
    assert.ok(first.sink && second.sink)
    assert.equal(first.handle, second.handle, '同一目录必须是同一个句柄对象')
    assert.equal(second.reused, true)
    assert.equal(state.created, 1, '只建了一次库')
    assert.equal(first.handle.refs, 2)
    assert.equal(describeOwnLogRegistry().size, 1)
    // 收尾：两次引用都还回去（引用计数到零才真释放），后面的用例从空表开始。
    assert.equal(releaseOwnLog('plugin-a', '/tmp/kernel-a'), false)
    assert.equal(releaseOwnLog('plugin-a', '/tmp/kernel-a'), true)
    assert.equal(describeOwnLogRegistry().size, 0)
  })

  it('引用计数归零才释放引擎实例', async () => {
    __resetOwnLogRegistryForTests()
    const state = { created: 0, released: 0 }
    const loader = async () => fakeModule(state)
    await acquireOwnLog({ logsRoot: '/tmp/kernel-b', namespace: 'plugin-b', prefix: 'wf', loader })
    await acquireOwnLog({ logsRoot: '/tmp/kernel-b', namespace: 'plugin-b', prefix: 'wf', loader })
    assert.equal(releaseOwnLog('plugin-b', '/tmp/kernel-b'), false, '还有引用时不释放')
    assert.equal(state.released, 0)
    assert.equal(releaseOwnLog('plugin-b', '/tmp/kernel-b'), true, '引用归零即释放')
    assert.equal(state.released, 1)
    assert.equal(describeOwnLogRegistry().size, 0)
  })

  it('撞租约：退避重试后降级，绝不外抛；冷却期内不再反复撞锁', async () => {
    let attempts = 0
    const loader = async () => ({
      createNodeHostLog: async () => {
        attempts++
        throw new Error('日志目录已被另一个实例占用（目录租约）')
      },
    })
    const got = await acquireOwnLog({
      logsRoot: '/tmp/kernel-c',
      namespace: 'plugin-c',
      prefix: 'wf',
      loader,
      retryDelaysMs: [1, 1],
      cooldownMs: 60_000,
    })
    assert.equal(got.sink, null, '降级＝没有落点')
    assert.equal(got.reason, 'lease-conflict')
    assert.equal(attempts, 3, '一次首发加两次退避重试')
    const again = await acquireOwnLog({ logsRoot: '/tmp/kernel-c', namespace: 'plugin-c', prefix: 'wf', loader, retryDelaysMs: [1, 1] })
    assert.equal(again.reason, 'lease-conflict')
    assert.equal(attempts, 3, '冷却期内不该再撞同一把锁')
    assert.equal(lastOwnLogDegraded().reason, 'lease-conflict')
  })

  it('拿不到 dsh-log（缺包/形状不对）也降级：no-dsh-log', async () => {
    const missing = await acquireOwnLog({ logsRoot: '/tmp/kernel-d', namespace: 'plugin-d', prefix: 'wf', loader: async () => { throw new Error('cannot find module') } })
    assert.equal(missing.reason, 'no-dsh-log')
    __resetOwnLogRegistryForTests()
    const wrongShape = await acquireOwnLog({ logsRoot: '/tmp/kernel-e', namespace: 'plugin-e', prefix: 'wf', loader: async () => ({}) })
    assert.equal(wrongShape.reason, 'no-dsh-log')
    __resetOwnLogRegistryForTests()
  })

  it('建库抛非租约错：降级 write-fail', async () => {
    const got = await acquireOwnLog({
      logsRoot: '/tmp/kernel-f',
      namespace: 'plugin-f',
      prefix: 'wf',
      loader: async () => ({ createNodeHostLog: async () => { throw new Error('EACCES: permission denied') } }),
      retryDelaysMs: [],
    })
    assert.equal(got.reason, 'write-fail')
    __resetOwnLogRegistryForTests()
  })

  it('建库配置带上 pluginVersion：默认本包版本（0.3.4 起启动头幂等，只能在建库那一次给）', async () => {
    __resetOwnLogRegistryForTests()
    const seen = []
    const loader = async () => ({
      createNodeHostLog: async (_deps, config) => {
        seen.push(config)
        return {
          log: () => {},
          isEnabled: () => true,
          release: () => {},
          getDroppedCount: () => 0,
          getLastPersistFail: () => null,
        }
      },
    })
    const own = ownPackageVersion()
    assert.ok(own, '本包 package.json 的版本必须读得到（读不到就没法写启动头）')
    assert.match(own, /^\d+\.\d+\.\d+$/)
    const first = await acquireOwnLog({ logsRoot: '/tmp/kernel-g', namespace: 'plugin-g', prefix: 'wf', loader })
    assert.ok(first.sink)
    assert.equal(seen.length, 1, '建库只调一次')
    assert.equal(seen[0].pluginVersion, own, '没显式给就用本包版本')
    assert.equal(seen[0].pluginId, 'plugin-g', '别的建库配置不受影响')
    __resetOwnLogRegistryForTests()
    // 显式给了就用给的（集成方想写自己那一版）
    const second = await acquireOwnLog({ logsRoot: '/tmp/kernel-h', namespace: 'plugin-h', prefix: 'wf', loader, pluginVersion: '9.9.9' })
    assert.ok(second.sink)
    assert.equal(seen[1].pluginVersion, '9.9.9')
    // 空白字符串按「没给」处理（不写一个空格进启动头）
    __resetOwnLogRegistryForTests()
    const third = await acquireOwnLog({ logsRoot: '/tmp/kernel-i', namespace: 'plugin-i', prefix: 'wf', loader, pluginVersion: '   ' })
    assert.ok(third.sink)
    assert.equal(seen[2].pluginVersion, own)
    __resetOwnLogRegistryForTests()
  })
})

describe('日志内核：唯一发射口的四条纪律', () => {
  it('字段白名单：未知事件整行不落、未知字段只丢该字段（开发期可切成当场抛）', async () => {
    const table = await loadUpdateEventTable()
    assert.ok(table, '随包清单必须读得到')
    const rows = []
    const router = createLogRouter()
    router.bind('p', collectSink(rows))
    const emitter = createLogEmitter({ resolve: (id) => router.resolve(id), table: () => table })
    assert.equal(emitter.emit('info', 'host.call', { method: 'wf.updateStatus', latencyMs: 1, ok: true, kind: 'update-status', pluginId: 'p' }, { pluginId: 'p' }), true)
    // 未声明字段只摘该字段，整行仍然落盘（#210：不要因为一枚漂移字段毁掉整条证据）。
    assert.equal(emitter.emit('info', 'host.call', { method: 'x', latencyMs: 1, ok: true, kind: 'k', pluginId: 'p', secret: 'oops' }, { pluginId: 'p' }), true)
    // 未声明事件没法校验字段，整行不落。
    assert.equal(emitter.emit('info', 'update.not.declared', { pluginId: 'p' }, { pluginId: 'p' }), false)
    const landed = rows.filter((r) => r.event !== 'update.log.degraded')
    assert.equal(landed.length, 2, '两行仍落盘，只是第二行少了未声明的字段')
    assert.equal(landed[0].event, 'host.call')
    assert.deepEqual(landed[1].fields, { method: 'x', latencyMs: 1, ok: true, kind: 'k', pluginId: 'p' })
    // 两种漂移各留一条自监控行：字段被摘（unknown-field）、事件整行被丢（unknown-event）。
    const degradedRows = rows.filter((r) => r.event === 'update.log.degraded')
    assert.deepEqual(degradedRows.map((r) => r.fields.reason).sort(), ['unknown-event', 'unknown-field'])
    assert.equal(emitter.counts().prunedByReason['unknown-field'], 1)
    assert.equal(emitter.counts().droppedByReason['unknown-field'], undefined)
    assert.equal(emitter.counts().droppedByReason['unknown-event'], 1)
    const strict = createLogEmitter({ resolve: (id) => router.resolve(id), table: () => table, mode: 'throw' })
    assert.throws(
      () => strict.emit('info', 'update.not.declared', { pluginId: 'p' }, { pluginId: 'p' }),
      /不合清单/
    )
    assert.throws(
      () => strict.emit('info', 'host.call', { method: 'x', latencyMs: 1, ok: true, kind: 'k', pluginId: 'p', secret: 'oops' }, { pluginId: 'p' }),
      /not in event list/
    )
  })

  it('脱敏：行里绝不出现绝对路径（ADR-0001 的边界在这里再过一遍）', () => {
    const sanitized = sanitizeLogFields({ op: 'C:\\Users\\someone\\secret\\profile', reason: 'write-fail', dirHash: 'abc12345' })
    assert.ok(!String(sanitized.op).includes('someone'), '路径必须被改写：' + String(sanitized.op))
    assert.equal(sanitized.reason, 'write-fail')
    assert.equal(sanitized.dirHash, 'abc12345')
    const rows = []
    const router = createLogRouter()
    router.bind('p', collectSink(rows))
    const emitter = createLogEmitter({ resolve: (id) => router.resolve(id) })
    emitter.emit('warn', 'update.store.fail', { op: '/home/user/.dsh/secret', reason: 'write-fail', dirHash: 'h' }, { pluginId: 'p' })
    assert.equal(rows.length, 1)
    assert.ok(!String(rows[0].fields.op).includes('/home/user'))
  })

  it('准入短路：落点说这一级不开就不发，且算 skipped 不算丢弃', () => {
    const rows = []
    const router = createLogRouter()
    router.bind('p', collectSink(rows, { isEnabled: (level) => level !== 'info' }))
    const emitter = createLogEmitter({ resolve: (id) => router.resolve(id) })
    assert.equal(emitter.emit('info', 'update.log.degraded', { reason: 'no-dsh-log' }, { pluginId: 'p' }), false)
    assert.equal(emitter.emit('warn', 'update.log.degraded', { reason: 'no-dsh-log' }, { pluginId: 'p' }), true)
    assert.equal(rows.length, 1)
    assert.equal(emitter.counts().skipped, 1)
    assert.equal(emitter.counts().dropped, 0)
  })

  it('预算守卫：边沿触发的事件同一状态指纹只落一条（轮询不会灌满日志）', async () => {
    const table = await loadUpdateEventTable()
    assert.equal(isEdgeEvent('update.status.changed', table), true, '清单里它是边沿触发')
    const rows = []
    const router = createLogRouter()
    router.bind('p', collectSink(rows))
    const emitter = createLogEmitter({ resolve: (id) => router.resolve(id), table: () => table })
    for (let i = 0; i < 100; i++) {
      emitter.emit('info', 'update.status.changed', { kind: 'up-to-date', latest: '1.2.3' }, { pluginId: 'p' })
    }
    assert.equal(rows.length, 1, '100 次同一状态只落一条')
    assert.equal(emitter.counts().suppressed, 99)
    emitter.emit('info', 'update.status.changed', { kind: 'update-available', latest: '1.2.3' }, { pluginId: 'p' })
    assert.equal(rows.length, 2, '状态真变了必须落')
    emitter.emit('info', 'update.status.changed', { kind: 'up-to-date', latest: '1.2.3' }, { pluginId: 'p', always: true })
    assert.equal(rows.length, 3, 'always 跳过预算守卫')
  })

  it('落点抛错不外抛：计一条丢弃，并只记一次自监控行', () => {
    const router = createLogRouter()
    let degradeRows = 0
    router.bind('p', {
      fire: (level, event) => {
        if (event === 'update.log.degraded') {
          degradeRows++
          return
        }
        throw new Error('sink 坏了')
      },
    })
    const emitter = createLogEmitter({ resolve: (id) => router.resolve(id) })
    assert.equal(emitter.emit('info', 'host.call', { method: 'x', latencyMs: 1, ok: true, kind: 'k', pluginId: 'p' }, { pluginId: 'p' }), false)
    assert.equal(emitter.emit('info', 'host.call', { method: 'x', latencyMs: 2, ok: true, kind: 'k', pluginId: 'p' }, { pluginId: 'p' }), false)
    assert.equal(emitter.counts().droppedByReason['emit-threw'], 2)
    assert.equal(degradeRows, 1, '同一原因只记首次')
  })
})

describe('日志内核：真引擎端到端（dsh-log 0.3.4 真落一份文件）', () => {
  let tempRoot = ''
  before(() => {
    __resetOwnLogRegistryForTests()
    tempRoot = mkdtempSync(join(tmpdir(), 'dsh-update-log-kernel-'))
  })
  after(() => {
    try {
      releaseOwnLog('kernel-e2e-9a1b2c', tempRoot)
    } catch {}
    __resetOwnLogRegistryForTests()
    if (tempRoot && existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true })
  })

  it('自建实例 → 发一行 → 真落盘 → 读回五键行', async () => {
    // 故意用一个「有损」的插件标识：派生出来的名字要能被 dsh-log 自己的校验收下。
    const namespace = deriveLogNamespace('Kernel.E2E')
    assert.notEqual(namespace, 'Kernel.E2E')
    const built = await buildUpdateManifest(namespace)
    assert.ok(built.manifest, '随包清单能读出来并换标识')
    assert.equal(built.manifest.pluginId, namespace)
    const got = await acquireOwnLog({ logsRoot: tempRoot, namespace, prefix: 'wf', eventList: built.manifest })
    assert.ok(got.sink, '真 dsh-log 应该建得起来（拿不到就说明依赖没装）')
    const router = createLogRouter()
    router.bind('kernel.e2e', got.sink)
    const emitter = createLogEmitter({ resolve: (id) => router.resolve(id), table: () => loadUpdateEventTable() })
    // 常驻事件：即使调试开关关着也必须落盘（这正是清单 kind:'resident' 的意义）。
    assert.equal(
      emitter.emit('info', 'update.wire.ready', { logSink: 'self', logDirHash: 'deadbeef' }, { pluginId: 'kernel.e2e' }),
      true
    )
    await got.handle.store.synced?.()
    const dir = join(tempRoot, namespace)
    const files = readdirSync(dir).filter((n) => n.endsWith('.log'))
    assert.ok(files.length >= 1, '日志目录里应有按天文件：' + dir)
    const lines = readFileSync(join(dir, files[0]), 'utf8').trim().split('\n').filter(Boolean)
    const parsed = lines.map((line) => JSON.parse(line))
    const row = parsed.find((r) => r.event === 'update.wire.ready')
    assert.ok(row, '文件里应能找到我们那一行')
    assert.equal(row.v, 3, '落盘行格式版本是 3')
    assert.equal(row.level, 'info')
    assert.deepEqual(Object.keys(row).sort(), ['event', 'fields', 'level', 'ts', 'v'])
    assert.equal(row.fields.logSink, 'self')
    assert.equal(row.fields.logDirHash, 'deadbeef')
    assert.ok(describeOwnLogRegistry().size >= 1)
    // 启动头（dsh-log 建库时自己写的那一行）：0.3.4 起幂等，只许一行；本包版本与 os 都记上。
    const headers = parsed.filter((r) => r.event === 'host.start')
    assert.equal(headers.length, 1, '启动头只许一行（0.3.4 起同实例幂等）')
    assert.equal(headers[0].fields.pluginVersion, ownPackageVersion(), '启动头要写清「这目录是哪一版写的」')
    assert.ok('os' in headers[0].fields, '0.3.4 起启动头记 os')
  })
})

describe('日志内核：面板侧只许引用无 node: 依赖的纯类型与客户端通道', () => {
  it('浏览器侧入口不 import 会拖进 node: 的内核模块', () => {
    const browserFiles = ['panel.ts', 'client.ts', 'entry.ts', 'entry-batch.ts', 'panel-batch.ts', 'http.ts']
    // #226：面板实现拆进 src/panel/，拆出文件与入口壳同样要浏览器安全，逐个查（相对 src/ 的路径）。
    const walkPanel = (dir, prefix = '') => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walkPanel(join(dir, entry.name), prefix + entry.name + '/')
        else if (entry.name.endsWith('.ts')) browserFiles.push('panel/' + prefix + entry.name)
      }
    }
    walkPanel(join(PKG_DIR, 'src', 'panel'))
    // 浏览器安全的只有客户端通道（#122：面板唯一的报日志出口）；其余会把 node: 内建拖进打包器
    // （`trace` 也在列：宿主侧链上下文要 node:async_hooks）。
    const forbidden = /\.\.?\/log\/(index|namespace|emit|manifest|registry|trace|own-version)\.js$/
    for (const name of browserFiles) {
      const raw = readFileSync(join(PKG_DIR, 'src', name), 'utf8')
      const text = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^A-Za-z0-9_$:])\/\/.*$/gm, '$1')
      for (const m of text.matchAll(/import\s+(type\s+)?[^'\n]*?from\s+['"](\.\.?\/log\/[^'"]+)['"]/g)) {
        assert.ok(!forbidden.test(m[2]) || m[1], `${name} 引了会拖进 node: 的 ${m[2]}（只许 import type）`)
      }
    }
  })

  it('客户端日志壳自己不带 node: 依赖，两面面板都经它报日志（#122/#208）', () => {
    const channel = readFileSync(join(PKG_DIR, 'src', 'log', 'client-queue.ts'), 'utf8')
    assert.ok(!/from\s+['"]node:/.test(channel), '客户端通道必须浏览器安全：不许碰 node: 内建')
    const shell = readFileSync(join(PKG_DIR, 'src', 'log', 'panel-client.ts'), 'utf8')
    assert.ok(!/from\s+['"]node:/.test(shell), '客户端日志壳必须浏览器安全：不许碰 node: 内建')
    assert.match(shell, /from\s+['"]\.\/client-queue\.js['"]/, '壳要经客户端通道报日志')
    // #226：面板实现拆进 src/panel/，panel-client 的运行时引用落在 panel/mount.ts。
    const mount = readFileSync(join(PKG_DIR, 'src', 'panel', 'mount.ts'), 'utf8')
    assert.match(mount, /from\s+['"]\.\.\/log\/panel-client\.js['"]/, 'panel/mount.ts 要经共享日志壳报日志')
    const panelBatch = readFileSync(join(PKG_DIR, 'src', 'panel-batch.ts'), 'utf8')
    assert.match(panelBatch, /from\s+['"]\.\/log\/panel-client\.js['"]/, 'panel-batch.ts 要经共享日志壳报日志')
  })

  it('内核里只有登记表一处动态 import dsh-log/node（运行期唯一外部依赖）', () => {
    const raw = readFileSync(join(PKG_DIR, 'src', 'log', 'registry.ts'), 'utf8')
    assert.match(raw, /import\('dsh-log\/node'\)/)
    const files = ['namespace.ts', 'sink.ts', 'router.ts', 'emit.ts', 'manifest.ts', 'index.ts', 'own-version.ts']
    for (const name of files) {
      const text = readFileSync(join(PKG_DIR, 'src', 'log', name), 'utf8')
      assert.ok(!/from\s+['"]dsh-log/.test(text), name + ' 不该直接 import dsh-log（只有登记表按需动态取）')
    }
  })

  it('内核里的指纹是 sha256 前缀（跨进程稳定、抗撞车）', () => {
    assert.equal(hashToken('abc', 6).length, 6)
    assert.match(hashToken('abc', 6), /^[0-9a-f]{6}$/)
    assert.equal(hashToken('abc', 6), hashToken('abc', 6))
    assert.notEqual(hashToken('abc', 6), hashToken('abd', 6))
  })
})
