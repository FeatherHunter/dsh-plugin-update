/**
 * tests/store-log.test.mjs —— 落盘 / 锁 / 队列的日志接线（#124 Node 侧）。
 *
 * 只测外部行为：用假 deps 注入发射口收行，断言「真边沿才发、发什么字段、值脱敏到什么程度」，
 * 以及不传端口时零行为差异（不抛、返回值一字不差）。钉住的四件事：
 *   1. 陈旧锁/拥有者被回收 → `update.lock.anomaly{kind:'stale-owner', ageMs}`；
 *   2. 放锁/抢锁/队列写盘失败 → `update.lock.anomaly{kind:'release-failed'}` 与
 *      `update.store.fail{op, reason}`，reason 只许稳定短码，行里绝不出现路径原文；
 *   3. 队列真跃迁才发 `update.queue.transition`，同状态连发多少次都只落一行（边沿触发）；
 *   4. 不传端口（或端口自己抛错）时，行为、返回值、抛错与今天一字不差。
 * 落盘走真实临时目录（前缀隔离），不碰生产路径；网络、子进程一律不用。
 * 最后一节把本文件真正会发的七种字段组合喂给真发射口（真清单 + mode:'throw'），证明白名单对得上。
 */
import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  createUpdateDiskPorts,
  createUpdateQueuePorts,
  pathsForUpdate,
  queuePathsForUpdate,
} from '../dist/store.js'
import {
  cancelEnqueuedInQueue,
  emptyQueueState,
  enqueueInQueue,
  promoteHeadToOwner,
  releaseOwnerInQueue,
} from '../dist/queue.js'

/** 三个事件的字段白名单（逐字抄 event-list.update.json，多一格整行会被发射口丢掉）。 */
const WHITELIST = {
  'update.lock.anomaly': ['kind', 'ageMs'],
  'update.store.fail': ['op', 'reason'],
  'update.queue.transition': ['phase', 'waitedMs', 'position'],
}

const cleanups = []

function freshDirs(tag) {
  const homeDir = mkdtempSync(join(tmpdir(), `dpu-slog-home-${tag}-`))
  const profileDir = mkdtempSync(join(tmpdir(), `dpu-slog-prof-${tag}-`))
  cleanups.push(homeDir, profileDir)
  return { homeDir, profileDir }
}

after(() => {
  for (const dir of cleanups) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
})

/** 收行的假发射口：磁盘侧传 `log`，队列侧传 `logFor`（跨插件共享，按当次动作方取口）。 */
function recorder() {
  const rows = []
  const make = (pluginId) => (level, event, fields, opts) => {
    rows.push({ level, event, fields: { ...fields }, opts, pluginId: pluginId ?? null })
  }
  return { rows, log: make(null), logFor: (pluginId) => make(pluginId) }
}

/** 收下来的行必须合规：字段是白名单子集、值只能是字符串/有限数、字符串里不许有路径形状。 */
function assertRowsSane(rows) {
  for (const row of rows) {
    const allowed = WHITELIST[row.event]
    assert.ok(allowed, `未知事件 ${row.event}`)
    for (const [key, value] of Object.entries(row.fields)) {
      assert.ok(allowed.includes(key), `${row.event} 多出字段 ${key}`)
      assert.ok(
        typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)),
        `${row.event}.${key} 值不合法：${String(value)}`
      )
      if (typeof value === 'string') {
        assert.ok(!/[\\/]/.test(value), `${row.event}.${key} 疑似含路径分隔符：${value}`)
        assert.ok(!/^[A-Za-z]:/.test(value), `${row.event}.${key} 疑似含盘符：${value}`)
      }
    }
  }
}

function assertNoPathText(rows, needles) {
  const text = JSON.stringify(rows)
  for (const needle of needles) {
    assert.ok(needle && !text.includes(needle), `行里不该出现路径原文：${needle}`)
  }
  assert.ok(!text.includes(tmpdir().replace(/\\/g, '\\\\')), '行里不该出现临时目录原文')
}

describe('落盘层：陈旧锁回收与失败记账', () => {
  it('陈旧锁被回收：记 stale-owner，ageMs 是从锁里算出来的年龄', async () => {
    const { homeDir, profileDir } = freshDirs('stale')
    const rec = recorder()
    const ports = createUpdateDiskPorts(homeDir, 'plugin-a', profileDir, { log: rec.log })
    assert.ok(ports.paths)
    mkdirSync(ports.paths.directory, { recursive: true })
    // 手工造一把「主人早该收尾却没放」的锁：任务文件不在（还在装），锁里记着 4 秒前开始。
    // #181 换了判据：陈旧只看「时间 + 可解析性」，不看 state.json——这里注入 2 秒额度把 4 秒锁判陈旧。
    writeFileSync(ports.paths.lock, JSON.stringify({ id: 'job-a', pid: 1, startedAt: Date.now() - 4242 }))

    assert.equal(await ports.tryAcquireLock('job-b', { timeoutMs: 2000 }), true)
    assert.equal(JSON.parse(readFileSync(ports.paths.lock, 'utf8')).id, 'job-b', '回收后锁归自己')

    const anomalies = rec.rows.filter((row) => row.event === 'update.lock.anomaly')
    assert.equal(anomalies.length, 1)
    assert.equal(anomalies[0].level, 'warn')
    assert.deepEqual(Object.keys(anomalies[0].fields).sort(), ['ageMs', 'kind'])
    assert.equal(anomalies[0].fields.kind, 'stale-owner')
    assert.ok(
      anomalies[0].fields.ageMs >= 4000 && anomalies[0].fields.ageMs <= 20000,
      `ageMs 应是算出来的年龄，实得 ${anomalies[0].fields.ageMs}`
    )
    assertRowsSane(rec.rows)
    assertNoPathText(rec.rows, [homeDir, profileDir, ports.paths.lock])

    await ports.releaseLock('job-b')
  })

  it('放锁时真的抛错：release-failed + store.fail 稳定码，行里没有路径原文', async () => {
    const { homeDir, profileDir } = freshDirs('release')
    const rec = recorder()
    const ports = createUpdateDiskPorts(homeDir, 'plugin-b', profileDir, { log: rec.log })
    assert.ok(ports.paths)
    mkdirSync(ports.paths.directory, { recursive: true })
    // 让锁位被一个目录占着：读锁即抛 EISDIR，放锁根本走不下去（原来静默吞）。
    mkdirSync(ports.paths.lock)

    await ports.releaseLock('job-x') // 不许抛：接线只是加记录，不是改行为

    const fails = rec.rows.filter((row) => row.event === 'update.store.fail')
    assert.equal(fails.length, 1)
    assert.equal(fails[0].level, 'warn')
    assert.deepEqual(fails[0].fields, { op: 'release-lock', reason: 'eisdir' })
    const anomalies = rec.rows.filter((row) => row.event === 'update.lock.anomaly')
    assert.equal(anomalies.length, 1)
    assert.deepEqual(anomalies[0].fields, { kind: 'release-failed' })
    assertRowsSane(rec.rows)
    assertNoPathText(rec.rows, [homeDir, profileDir, ports.paths.lock, ports.paths.directory])
  })

  it('抢锁收到真故障（非 EEXIST）也留痕，返回值仍是原来的 false', async () => {
    const { homeDir, profileDir } = freshDirs('acquire')
    const rec = recorder()
    const ports = createUpdateDiskPorts(homeDir, 'plugin-c', profileDir, { log: rec.log })
    assert.ok(ports.paths)
    mkdirSync(ports.paths.directory, { recursive: true })
    mkdirSync(ports.paths.lock)

    assert.equal(await ports.tryAcquireLock('job-y'), false)
    const fails = rec.rows.filter((row) => row.event === 'update.store.fail')
    assert.equal(fails.length, 1, '真故障只留一条（同一操作连续失败只记首次）')
    // 平台差异：Windows 把「锁位是目录」当 EEXIST 才轮到回收，POSIX 当场回 EISDIR。
    assert.ok(['acquire-lock', 'reclaim-stale-owner'].includes(fails[0].fields.op), fails[0].fields.op)
    assert.match(fails[0].fields.reason, /^[a-z][a-z0-9]*$/, 'reason 必须是稳定短码')
    assertRowsSane(rec.rows)
    assertNoPathText(rec.rows, [homeDir, profileDir, ports.paths.lock])
  })
})

describe('队列层：真跃迁才发，同状态连发只落一行', () => {
  it('入队 → 占位 → 摘牌各发一次，摘待办不算跃迁', async () => {
    const { homeDir, profileDir } = freshDirs('edge')
    const rec = recorder()
    const ports = createUpdateQueuePorts(homeDir, profileDir, { logFor: rec.logFor })

    const queued = enqueueInQueue(emptyQueueState(), { pluginId: 'p-a', requestId: 'r1', enqueuedAt: 1000 })
    await ports.writeQueue(queued.state)
    await ports.writeQueue(queued.state)
    await ports.writeQueue(queued.state) // 同状态连发：后两次都不该再发

    const running = promoteHeadToOwner(queued.state, { jobId: 'job-a', startedAt: 3000 })
    assert.equal(running.promoted, true)
    await ports.writeQueue(running.state)
    await ports.writeQueue(running.state)

    const done = releaseOwnerInQueue(running.state, 'p-a', 'job-a')
    assert.equal(done.released, true)
    await ports.writeQueue(done.state)
    await ports.writeQueue(done.state)

    const parked = enqueueInQueue(done.state, { pluginId: 'p-b', requestId: 'r2', enqueuedAt: 5000 })
    await ports.writeQueue(parked.state)
    const cancelled = cancelEnqueuedInQueue(parked.state, 'p-b', 'r2')
    assert.equal(cancelled.removed, true)
    await ports.writeQueue(cancelled.state) // 摘待办不是相位跃迁：不发

    const transitions = rec.rows.filter((row) => row.event === 'update.queue.transition')
    assert.deepEqual(
      transitions.map((row) => `${row.pluginId}:${row.fields.phase}`),
      ['p-a:queued', 'p-a:running', 'p-a:done', 'p-b:queued']
    )
    assert.ok(transitions.every((row) => row.level === 'info'))
    assert.equal(transitions[0].fields.position, 1, 'position 只有真知道位次时才给')
    assert.equal(transitions[0].fields.waitedMs, undefined, '还没开始装就没有等待时长')
    assert.equal(transitions[1].fields.waitedMs, 2000, 'waitedMs 是从占位到开始装真量到的时长')
    assert.equal(transitions[2].fields.position, undefined)
    assertRowsSane(rec.rows)
    assertNoPathText(rec.rows, [homeDir, profileDir])
  })

  it('回收陈旧全局锁：stale-owner 与 reclaimed 都算当次抢锁那家的', async () => {
    const { homeDir, profileDir } = freshDirs('reclaim')
    let now = 1_000_000
    const rec = recorder()
    const ports = createUpdateQueuePorts(homeDir, profileDir, { logFor: rec.logFor, nowImpl: () => now })

    assert.equal(await ports.tryAcquireGlobalLock('job-a', 'p-a', { timeoutMs: 1000 }), true)
    now += 500
    assert.equal(await ports.tryAcquireGlobalLock('job-b', 'p-b', { timeoutMs: 1000 }), false)
    assert.equal(rec.rows.length, 0, '不陈旧就别发任何行')
    now += 600
    assert.equal(await ports.tryAcquireGlobalLock('job-b', 'p-b', { timeoutMs: 1000 }), true)

    const anomalies = rec.rows.filter((row) => row.event === 'update.lock.anomaly')
    assert.equal(anomalies.length, 1)
    assert.equal(anomalies[0].fields.kind, 'stale-owner')
    assert.equal(anomalies[0].fields.ageMs, 1100)
    assert.equal(anomalies[0].pluginId, 'p-b', '动作方是来抢锁的那家')
    const transitions = rec.rows.filter((row) => row.event === 'update.queue.transition')
    assert.deepEqual(transitions.map((row) => row.fields.phase), ['reclaimed'])
    assert.equal(transitions[0].pluginId, 'p-b')
    assertRowsSane(rec.rows)
    assertNoPathText(rec.rows, [homeDir, profileDir, ports.paths.lock])

    await ports.releaseGlobalLock('job-b')
  })

  it('队列写盘真的失败：记 store.fail 稳定码，绝不发跃迁行，抛错行为不变', async () => {
    const { homeDir, profileDir } = freshDirs('qfail')
    const queuePaths = queuePathsForUpdate(homeDir, profileDir)
    // 让真实落盘位置不可用：把队列目录占成一个文件（写盘必失败）。
    mkdirSync(dirname(queuePaths.directory), { recursive: true })
    writeFileSync(queuePaths.directory, 'x')

    const rec = recorder()
    const previous = enqueueInQueue(emptyQueueState(), { pluginId: 'p-a', requestId: 'r1', enqueuedAt: 1000 })
    const next = enqueueInQueue(previous.state, { pluginId: 'p-b', requestId: 'r2', enqueuedAt: 2000 })
    const ports = createUpdateQueuePorts(homeDir, profileDir, {
      logFor: rec.logFor,
      // 读用假件（读到一份真状态，好让跃迁判得出来），写走真实且必失败的落盘。
      statImpl: async () => ({ size: 64 }),
      readFileImpl: async () => JSON.stringify(previous.state),
    })

    await assert.rejects(
      () => ports.writeQueue(next.state),
      (error) => typeof error.code === 'string'
    )
    const fails = rec.rows.filter((row) => row.event === 'update.store.fail')
    assert.equal(fails.length, 1)
    assert.deepEqual(fails[0].fields, { op: 'write-queue', reason: 'eexist' })
    assert.equal(fails[0].pluginId, 'p-b', '按跃迁那家的标识路由')
    assert.equal(rec.rows.filter((row) => row.event === 'update.queue.transition').length, 0, '没写成就不发跃迁')
    assertRowsSane(rec.rows)
    assertNoPathText(rec.rows, [homeDir, profileDir, queuePaths.directory])
  })
})

describe('可选增强：不传端口零行为差异', () => {
  it('落盘序列：传与不传端口的返回值一字不差，不传就一条都不发', async () => {
    async function run(deps, profileDir, pluginId) {
      const out = []
      const ports = createUpdateDiskPorts(homeDir, pluginId, profileDir, deps)
      out.push(await ports.readJob())
      await ports.writeJob({ id: 'job-1', state: 'installing', targetVersion: '1.0.0', message: null, requestId: 'r1' })
      out.push(await ports.readJob())
      out.push(await ports.tryAcquireLock('job-1'))
      out.push(await ports.tryAcquireLock('job-2')) // 同一任务占着：不陈旧，抢不到
      await ports.writeJob(null)
      // #181：任务不在但锁还新鲜 ⇒ 仍然拒（旧判据会在这里抢走活锁）；陈旧与否只看年龄，不看 state.json。
      out.push(await ports.tryAcquireLock('job-3'))
      out.push(await ports.readJob())
      await ports.releaseLock('job-3')
      // #181 判据只看时间：造一把真陈旧锁，回收这一下会记账——保证「接了端口真发得出来」。
      writeFileSync(ports.paths.lock, JSON.stringify({ id: 'job-old', pid: 1, startedAt: Date.now() - 5000 }))
      out.push(await ports.tryAcquireLock('job-4', { timeoutMs: 1000 }))
      await ports.releaseLock('job-4')
      return out
    }
    const { homeDir } = freshDirs('plain')
    const plainProfile = mkdtempSync(join(tmpdir(), 'dpu-slog-plain-'))
    const wiredProfile = mkdtempSync(join(tmpdir(), 'dpu-slog-wired-'))
    cleanups.push(plainProfile, wiredProfile)

    const rec = recorder()
    const plain = await run({}, plainProfile, 'plugin-plain')
    const wired = await run({ log: rec.log }, wiredProfile, 'plugin-wired')

    assert.deepEqual(wired, plain)
    assert.deepEqual(plain, [
      null,
      { requestId: 'r1', message: null, id: 'job-1', state: 'installing', targetVersion: '1.0.0' },
      true,
      false,
      // #181：锁还新鲜（state.json 刚被清掉不算陈旧证据），不许被抢。
      false,
      { id: 'locked', state: 'interrupted', message: 'recovery-required', targetVersion: null, requestId: null },
      true,
    ])
    assert.ok(rec.rows.length > 0, '接了端口的同一序列必须真发得出来，否则「相等」没意义')
    assertRowsSane(rec.rows)
  })

  it('队列序列：传与不传端口连落盘内容都一样，不传就一条都不发', async () => {
    async function run(deps, profileDir) {
      const out = []
      const ports = createUpdateQueuePorts(homeDir, profileDir, deps)
      const queued = enqueueInQueue(emptyQueueState(), { pluginId: 'p-a', requestId: 'r1', enqueuedAt: 1000 })
      await ports.writeQueue(queued.state)
      out.push(await ports.readQueue())
      const running = promoteHeadToOwner(queued.state, { jobId: 'job-1', startedAt: 2500 })
      await ports.writeQueue(running.state)
      out.push(await ports.readQueue())
      out.push(await ports.tryAcquireGlobalLock('job-1', 'p-a', { timeoutMs: 1000 }))
      out.push(await ports.tryAcquireGlobalLock('job-2', 'p-b', { timeoutMs: 1000 }))
      await ports.releaseGlobalLock('job-1')
      out.push(await ports.tryAcquireGlobalLock('job-2', 'p-b', { timeoutMs: 1000 }))
      await ports.releaseGlobalLock('job-2')
      const done = releaseOwnerInQueue(running.state, 'p-a', 'job-1')
      await ports.writeQueue(done.state)
      out.push(await ports.readQueue())
      return out
    }
    const { homeDir } = freshDirs('qplain')
    const plainProfile = mkdtempSync(join(tmpdir(), 'dpu-slog-qplain-'))
    const wiredProfile = mkdtempSync(join(tmpdir(), 'dpu-slog-qwired-'))
    cleanups.push(plainProfile, wiredProfile)

    const rec = recorder()
    const plain = await run({}, plainProfile)
    const wired = await run({ logFor: rec.logFor }, wiredProfile)
    assert.deepEqual(wired, plain)
    assert.equal(plain[0].waiting.length, 1)
    assert.equal(plain[1].owner.pluginId, 'p-a')
    assert.deepEqual(plain.slice(2, 5), [true, false, true])
    assert.equal(plain[5].owner, null)
    assert.equal(plain[5].waiting.length, 0)
    assert.equal(
      readFileSync(queuePathsForUpdate(homeDir, plainProfile).file, 'utf8'),
      readFileSync(queuePathsForUpdate(homeDir, wiredProfile).file, 'utf8'),
      '不传端口的落盘内容一字不差'
    )
    assert.ok(rec.rows.some((row) => row.event === 'update.queue.transition'))
    assertRowsSane(rec.rows)
  })

  it('发射口自己抛错也不改变控制流（best-effort）', async () => {
    const { homeDir, profileDir } = freshDirs('boom')
    const boom = () => {
      throw new Error('log-boom')
    }
    const disk = createUpdateDiskPorts(homeDir, 'plugin-boom', profileDir, { log: boom })
    assert.ok(disk.paths)
    mkdirSync(disk.paths.directory, { recursive: true })
    writeFileSync(disk.paths.lock, JSON.stringify({ id: 'job-a', pid: 1, startedAt: Date.now() - 1000 }))
    // #181：陈旧按时间判，注入 500ms 额度把 1 秒锁判陈旧。
    assert.equal(await disk.tryAcquireLock('job-b', { timeoutMs: 500 }), true, '回收时发射口抛错也必须照样抢到')
    await disk.writeJob({ id: 'job-b', state: 'installing', targetVersion: '1.0.0', message: null, requestId: null })
    assert.equal(await disk.tryAcquireLock('job-c'), false, '同一任务占着，行为不变')
    await disk.writeJob(null)
    await disk.releaseLock('job-b')
    assert.equal(await disk.readJob(), null)

    const queue = createUpdateQueuePorts(homeDir, profileDir, { logFor: () => boom })
    const queued = enqueueInQueue(emptyQueueState(), { pluginId: 'p-a', requestId: 'r1', enqueuedAt: 1 })
    await queue.writeQueue(queued.state)
    assert.equal((await queue.readQueue()).waiting.length, 1)
    assert.equal(await queue.tryAcquireGlobalLock('job-a', 'p-a'), true)
    await queue.releaseGlobalLock('job-a')
  })
})

describe('与真发射口对得上', () => {
  let createLogEmitter
  let createLogRouter
  let loadUpdateEventTable
  let table

  before(async () => {
    const kernel = await import('../dist/log/index.js')
    createLogEmitter = kernel.createLogEmitter
    createLogRouter = kernel.createLogRouter
    loadUpdateEventTable = kernel.loadUpdateEventTable
    table = await loadUpdateEventTable()
    assert.ok(table, '随包清单必须读得到')
  })

  it('本文件生产的字段在真清单里逐字合法（mode:throw 下不抛，一行都不丢）', () => {
    const rows = []
    const router = createLogRouter()
    router.bind('p-a', { fire: (level, event, fields) => rows.push({ level, event, fields }) })
    const emitter = createLogEmitter({ resolve: (id) => router.resolve(id), table: () => table, mode: 'throw' })

    // 逐字照抄 src/store.ts 里真正会发的那几种字段组合。
    assert.equal(emitter.emit('warn', 'update.store.fail', { op: 'release-lock', reason: 'eisdir' }, { pluginId: 'p-a' }), true)
    assert.equal(emitter.emit('warn', 'update.store.fail', { op: 'write-queue', reason: 'eexist' }, { pluginId: 'p-a' }), true)
    assert.equal(emitter.emit('warn', 'update.lock.anomaly', { kind: 'stale-owner', ageMs: 1100 }, { pluginId: 'p-a' }), true)
    assert.equal(emitter.emit('warn', 'update.lock.anomaly', { kind: 'release-failed' }, { pluginId: 'p-a' }), true)
    assert.equal(
      emitter.emit('info', 'update.queue.transition', { phase: 'queued', position: 1 }, { pluginId: 'p-a', fingerprint: 'p-a\u0000queued' }),
      true
    )
    assert.equal(
      emitter.emit('info', 'update.queue.transition', { phase: 'running', waitedMs: 2000 }, { pluginId: 'p-a', fingerprint: 'p-a\u0000running' }),
      true
    )
    assert.equal(
      emitter.emit('info', 'update.queue.transition', { phase: 'done' }, { pluginId: 'p-a', fingerprint: 'p-a\u0000done' }),
      true
    )
    assert.equal(rows.length, 7, '白名单对不上的行会被丢掉，行数少了就是字段名写错了')
    assert.deepEqual(rows.map((row) => row.event), [
      'update.store.fail',
      'update.store.fail',
      'update.lock.anomaly',
      'update.lock.anomaly',
      'update.queue.transition',
      'update.queue.transition',
      'update.queue.transition',
    ])
    assert.equal(emitter.counts().dropped, 0)
    // 反向自证：多带一格自由文本，真发射口只摘该字段并记降级（dev 模式选择抛而不是静默摘）；上面 7 行是过了校验的。
    assert.throws(
      () =>
        emitter.emit(
          'warn',
          'update.store.fail',
          { op: 'release-lock', reason: 'eisdir', path: 'C:\\Users\\someone\\secret' },
          { pluginId: 'p-a' }
        ),
      /not in event list/
    )
    // dev 模式在发射前就抛：字段级裁剪不记账（否则同一漂移会被记两遍），
    // 抛出的行按 emit-threw 记一次丢弃 + 一条降级行。
    assert.equal(emitter.counts().prunedFields, 0)
    assert.equal(emitter.counts().prunedByReason['unknown-field'], undefined)
    assert.equal(emitter.counts().dropped, 1)
    assert.equal(emitter.counts().droppedByReason['emit-threw'], 1)
    assert.equal(emitter.counts().droppedByReason['unknown-field'], undefined)
    const degraded = rows.filter((row) => row.event === 'update.log.degraded')
    assert.equal(degraded.length, 1, '同一进程同一原因只记一条降级')
    assert.equal(degraded[0].fields.reason, 'emit-threw')
    const landed = rows.filter((row) => row.event !== 'update.log.degraded')
    assert.equal(landed.length, 7, 'dev 模式在发射前就抛，落点仍只有先前 7 行')
    assert.ok(!JSON.stringify(landed).includes('someone'), '自由文本一格都不许落')
  })
})
