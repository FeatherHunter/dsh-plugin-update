/**
 * tests/log-trace.test.mjs —— 宿主侧链上下文（`store.trace()` 采纳，需 dsh-log 0.3.3）。
 *
 * 钉住的六件事：
 *   1. 自建落点上，一次调用里的多行共享一个 `traceId`、`seq` 从 0 递增 —— `--trace` 追得到；
 *   2. **认源**：环境里的链只对建它的那个落点生效（A 插件的链绝不写到 B 插件的目录）；
 *   3. 没有链时一字不变：集成方注入的客户端实例照旧只有清单声明的字段；
 *   4. `withLogTraceStep` 换 `spanId`、`seq` 从 0 起，`traceId` 不变；
 *   5. 懒取：待接落点接上之前拿不到链，接上之后就拿得到（自建实例是异步的）；
 *   6. 并发不串味：两条同时跑的链各拿各的 `traceId`。
 * 外加一条「被开关挡下的行不消耗 seq」（与 dsh-log 客户端同口径）。
 *
 * 只测外部行为：真装 dsh-log 0.3.3、真落文件、真读回五行键；没有真引擎就跳过（依赖没装的机器上不红）。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const kernel = await import('../dist/log/index.js')
const {
  acquireOwnLog,
  releaseOwnLog,
  buildUpdateManifest,
  loadUpdateEventTable,
  createLogEmitter,
  createLogRouter,
  createPendingSink,
  sinkFromLogCtx,
  deriveLogNamespace,
  withLogTrace,
  withLogTraceStep,
  currentLogTraceFor,
  __resetOwnLogRegistryForTests,
} = kernel
const { lintEventFields, parseLogRow, stripReservedLogFields, RESERVED_LOG_FIELDS } = await import('../dist/core/gate.js')

/** 读回一个日志目录里的全部落盘行（按文件顺序）。 */
function readRows(dir) {
  const files = readdirSync(dir).filter((n) => n.endsWith('.log')).sort()
  const out = []
  for (const name of files) {
    const text = readFileSync(join(dir, name), 'utf8').trim()
    for (const line of text.split('\n')) {
      if (line.trim()) out.push(JSON.parse(line))
    }
  }
  return out
}

/** 自建一个真落点（拿不到引擎就回 null，调用方据此跳过）。 */
async function ownSink(logsRoot, namespace) {
  const built = await buildUpdateManifest(namespace)
  const got = await acquireOwnLog({ logsRoot, namespace, prefix: 'wf', eventList: built.manifest })
  return got.sink ? { sink: got.sink, dir: got.dir, handle: got.handle, namespace } : null
}

describe('#133 宿主侧链上下文：一次调用一条链', () => {
  let root = ''
  const owned = []

  before(async () => {
    __resetOwnLogRegistryForTests()
    root = mkdtempSync(join(tmpdir(), 'dsh-update-log-trace-'))
  })
  after(() => {
    for (const o of owned) {
      try {
        releaseOwnLog(o.namespace, root)
      } catch {}
    }
    __resetOwnLogRegistryForTests()
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true })
  })

  it('自建落点上：多行共享 traceId、seq 递增，被开关挡下的行不消耗 seq', async () => {
    const namespace = deriveLogNamespace('Trace.One')
    const got = await ownSink(root, namespace)
    if (!got) return // 依赖没装：跳过（不假装通过）
    owned.push(got)
    const table = await loadUpdateEventTable()
    const router = createLogRouter()
    router.bind('trace.one', got.sink)
    const emitter = createLogEmitter({ resolve: (id) => router.resolve(id), table })
    const emit = (level, event, fields) => emitter.emit(level, event, fields, { pluginId: 'trace.one' })

    await withLogTrace(got.sink, async () => {
      assert.equal(emit('info', 'update.wire.ready', { logSink: 'self', logDirHash: 'aaaaaaaa' }), true)
      // 按需事件、开关默认关着 → skipped，且**不**消耗 seq（与 dsh-log 客户端同口径）。
      assert.equal(emit('info', 'update.check.start', { trigger: 'manual', source: 'panel' }), false)
      assert.equal(emit('info', 'update.check.done', { ok: true, current: '1.0.0', latest: '1.1.0', channel: 'stable', source: 'npm', latencyMs: 12 }), true)
      assert.equal(emit('info', 'update.install.request', { from: '1.0.0', current: '1.0.0', latest: '1.1.0', checkAgeMs: 5 }), true)
    })

    await got.handle.store.synced?.()
    const rows = readRows(got.dir).filter((r) => r.event.startsWith('update.'))
    assert.equal(rows.length, 3, '三行常驻行应落盘；被开关挡下的按需行不落')
    const traces = new Set(rows.map((r) => r.fields.traceId))
    assert.equal(traces.size, 1, '一次调用里的行必须共享同一个 traceId')
    assert.ok([...traces][0], 'traceId 非空')
    assert.equal(new Set(rows.map((r) => r.fields.spanId)).size, 1, '同一步骤里 spanId 不变')
    assert.deepEqual(rows.map((r) => r.fields.seq), [0, 1, 2], 'seq 从 0 起、逐行递增、跳过的不占号')
    // 五行键基线不动（ADR-0006：链是字段，不是新的顶层键）。
    for (const r of rows) assert.deepEqual(Object.keys(r).sort(), ['event', 'fields', 'level', 'ts', 'v'])
  })

  it('认源：A 的链绝不写到 B 的落点上', async () => {
    const nsA = deriveLogNamespace('Trace.Alpha')
    const nsB = deriveLogNamespace('Trace.Beta')
    const a = await ownSink(root, nsA)
    const b = await ownSink(root, nsB)
    if (!a || !b) return
    owned.push(a, b)
    const table = await loadUpdateEventTable()
    const router = createLogRouter()
    router.bind('trace.alpha', a.sink)
    router.bind('trace.beta', b.sink)
    const emitter = createLogEmitter({ resolve: (id) => router.resolve(id), table })

    await withLogTrace(a.sink, async () => {
      emitter.emit('info', 'update.wire.ready', { logSink: 'self', logDirHash: 'aaaa1111' }, { pluginId: 'trace.alpha' })
      // 同一个环境里给**另一个**落点发一行：它不该沾上 A 的链（也不该进 A 的目录）。
      emitter.emit('info', 'update.wire.ready', { logSink: 'self', logDirHash: 'bbbb2222' }, { pluginId: 'trace.beta' })
    })

    await a.handle.store.synced?.()
    await b.handle.store.synced?.()
    const rowsA = readRows(a.dir)
    const rowsB = readRows(b.dir)
    const rowA = rowsA.find((r) => r.fields.logDirHash === 'aaaa1111')
    const rowB = rowsB.find((r) => r.fields.logDirHash === 'bbbb2222')
    assert.ok(rowA && rowB, '两行各进各的目录')
    assert.ok(rowA.fields.traceId, 'A 的行带 A 的链')
    assert.equal(rowB.fields.traceId, undefined, 'B 的行不该沾上 A 的链')
    assert.equal(rowsA.filter((r) => r.fields.logDirHash === 'bbbb2222').length, 0, 'B 的行没进 A 的目录')
  })

  it('没有链时一字不变：集成方注入的客户端实例照旧只有清单声明的字段', async () => {
    const collected = []
    const guest = sinkFromLogCtx({ fire: (level, event, fields) => collected.push({ level, event, fields }) })
    assert.ok(guest)
    const table = await loadUpdateEventTable()
    const router = createLogRouter()
    router.bind('trace.guest', guest)
    const emitter = createLogEmitter({ resolve: (id) => router.resolve(id), table })

    assert.equal(currentLogTraceFor(guest), null, '客户端实例落点没有链')
    await withLogTrace(guest, async () => {
      emitter.emit('info', 'update.wire.ready', { logSink: 'external', logDirHash: 'cccc3333' }, { pluginId: 'trace.guest' })
    })
    assert.equal(collected.length, 1)
    assert.deepEqual(Object.keys(collected[0].fields).sort(), ['logDirHash', 'logSink'], '既有行为不变：不注入三件套')
  })

  it('withLogTraceStep：换 spanId、seq 从 0 起，traceId 不变', async () => {
    const namespace = deriveLogNamespace('Trace.Steps')
    const got = await ownSink(root, namespace)
    if (!got) return
    owned.push(got)
    const table = await loadUpdateEventTable()
    const router = createLogRouter()
    router.bind('trace.steps', got.sink)
    const emitter = createLogEmitter({ resolve: (id) => router.resolve(id), table })
    const emit = (hash) => emitter.emit('info', 'update.wire.ready', { logSink: 'self', logDirHash: hash }, { pluginId: 'trace.steps' })

    await withLogTrace(got.sink, async () => {
      emit('dddd0001')
      withLogTraceStep(() => emit('dddd0002'))
      emit('dddd0003')
    })

    await got.handle.store.synced?.()
    const rows = readRows(got.dir).filter((r) => String(r.fields.logDirHash).startsWith('dddd'))
    assert.equal(rows.length, 3)
    assert.equal(new Set(rows.map((r) => r.fields.traceId)).size, 1, '换 span 不换 trace')
    assert.equal(new Set(rows.map((r) => r.fields.spanId)).size, 2, '步骤之间 spanId 不同')
    assert.deepEqual(rows.map((r) => r.fields.seq), [0, 0, 1], '新步骤的 seq 从 0 起')
  })

  it('懒取：待接落点接上之前拿不到链，接上之后就拿得到', async () => {
    const namespace = deriveLogNamespace('Trace.Pending')
    const got = await ownSink(root, namespace)
    if (!got) return
    owned.push(got)
    const pending = createPendingSink()
    assert.equal(pending.sink.trace?.() ?? null, null, '还没接上：没有链')

    let seenBefore = 'unset'
    await withLogTrace(pending.sink, async () => {
      seenBefore = currentLogTraceFor(pending.sink)?.traceId ?? null
    })
    assert.equal(seenBefore, null, '接上之前取不到链')

    pending.attach(got.sink)
    let seenAfter = null
    await withLogTrace(pending.sink, async () => {
      seenAfter = currentLogTraceFor(pending.sink)?.traceId ?? null
    })
    assert.ok(typeof seenAfter === 'string' && seenAfter.length > 0, '接上之后取得到链')
  })

  it('读侧那把尺子：带链的行先摘保留名再量，野生字段照样红', async () => {
    const namespace = deriveLogNamespace('Trace.Ruler')
    const got = await ownSink(root, namespace)
    if (!got) return
    owned.push(got)
    const table = await loadUpdateEventTable()
    const router = createLogRouter()
    router.bind('trace.ruler', got.sink)
    const emitter = createLogEmitter({ resolve: (id) => router.resolve(id), table })

    await withLogTrace(got.sink, async () => {
      emitter.emit(
        'info',
        'update.check.done',
        { ok: true, current: '1.0.0', latest: '1.1.0', channel: 'stable', source: 'npm', latencyMs: 3 },
        { pluginId: 'trace.ruler' }
      )
    })
    await got.handle.store.synced?.()

    const raw = readRows(got.dir).find((r) => r.event === 'update.check.done')
    const row = parseLogRow(raw)
    const names = Object.keys(row.fields)
    assert.deepEqual(
      RESERVED_LOG_FIELDS.filter((f) => names.includes(f)).sort(),
      ['seq', 'spanId', 'traceId'],
      '真落盘的行确实带三个保留名'
    )
    assert.equal(lintEventFields(table, row.event, names).ok, false, '不摘保留名：这把尺子是字面的，会判黄')
    assert.equal(
      lintEventFields(table, row.event, stripReservedLogFields(names)).ok,
      true,
      '摘掉保留名后：清单量得过'
    )
    assert.equal(stripReservedLogFields([...names, 'bogus']).includes('bogus'), true, '野生字段不会被一起摘掉')
    assert.deepEqual(
      lintEventFields(table, row.event, stripReservedLogFields([...names, 'bogus'])).unknownFields,
      ['bogus'],
      '摘完保留名，野生字段照样被点出来'
    )
  })

  it('并发不串味：两条同时跑的链各拿各的 traceId', async () => {
    const namespace = deriveLogNamespace('Trace.Concurrent')
    const got = await ownSink(root, namespace)
    if (!got) return
    owned.push(got)
    const table = await loadUpdateEventTable()
    const router = createLogRouter()
    router.bind('trace.concurrent', got.sink)
    const emitter = createLogEmitter({ resolve: (id) => router.resolve(id), table })
    const emit = (hash) => emitter.emit('info', 'update.wire.ready', { logSink: 'self', logDirHash: hash }, { pluginId: 'trace.concurrent' })

    const seen = {}
    const run = (name, hash) =>
      withLogTrace(got.sink, async () => {
        seen[name] = currentLogTraceFor(got.sink)?.traceId ?? null
        await new Promise((resolve) => setTimeout(resolve, 5))
        assert.equal(currentLogTraceFor(got.sink)?.traceId, seen[name], name + ' 的链在 await 之后仍然是它自己的')
        emit(hash)
      })
    await Promise.all([run('a', 'eeee0001'), run('b', 'eeee0002')])
    assert.ok(seen.a && seen.b && seen.a !== seen.b, '两条链的 traceId 不同')

    await got.handle.store.synced?.()
    const rows = readRows(got.dir).filter((r) => String(r.fields.logDirHash).startsWith('eeee'))
    assert.equal(rows.length, 2)
    for (const r of rows) {
      const expected = r.fields.logDirHash === 'eeee0001' ? seen.a : seen.b
      assert.equal(r.fields.traceId, expected, '每行带的是它自己那条链')
    }
  })
})
