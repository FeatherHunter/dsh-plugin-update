/**
 * tests/issue-253-hub-exception-boundary.test.mjs —— #253 中枢后台泵异常边界。
 *
 * 宿主契约（dsh-app-boot README「启动与重载失败」表）：**脱离 apply() 返回 Promise 的异步任务
 * 产生未处理 rejection ＝ 致命错误：释放应用并以非零码退出**。中枢的泵、退避重试、孤儿接管
 * 都跑在 apply() 之外的后台，所以它们碰到的每一种异常都必须在中枢边界里收住：
 *   - 任务层：该任务明确 failed（或让位重排队），等待者拿到终态，泵继续下一个；
 *   - 落盘层：租约/方案的读写释放异常按 ADR-0008 的 best-effort 降级，绝不外抛；
 *   - 旁路层：孤儿接管、退避定时器里抛出的异常只让这一次放弃，绝不变未处理 rejection；
 *   - 关停层：宿主关停/释放时停掉退避定时器、归还本代租约，下一次启动按盘上方案接管。
 *
 * 只测外部可观察行为：电话回包、盘上相位/租约、假时钟推进、未处理 rejection 事件。
 */
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { createMultiHostUpdate } from '../dist/host-batch.js'
import { createHubPlan } from '../dist/core/hub/plan.js'
import { createBatchSession, markBatchEntry } from '../dist/core/batch/model.js'
import { hubPathsForUpdate } from '../dist/host/hub/plan-store.js'
import { readHubLease, writeHubLease } from '../dist/host/hub/lease-store.js'
import { HUB_LEASE_VERSION } from '../dist/core/hub/lease-policy.js'
import { HUB_MAX_LEASE_FAULTS } from '../dist/host/hub/protocol.js'
import { DEFAULT_HUB_IO } from '../dist/host/hub/boundary.js'
import { adoptOrphanHubTasks } from '../dist/host/hub/adopt.js'
import {
  __resetHubRegistryForTests,
  hubSlotCountForTests,
  releaseHubLeasesOnExit,
  shutdownHubScope,
  submitHubTask,
} from '../dist/host/hub/registry.js'
import { fakeTransport, mkScope, mkTarget, phaseOf, unbindAll } from './helpers/batch-log-harness.mjs'

beforeEach(() => {
  __resetHubRegistryForTests()
})

/** 假钟：定时器归测试手动推进（退避重试要可控）；pending() 让「定时器停没停」可断言。 */
function fakeClock(start = 1_000_000) {
  let current = start
  let seq = 0
  const timers = new Map()
  const timersPort = {
    setTimeout(fn, ms) {
      seq += 1
      const id = seq
      timers.set(id, { fn, at: current + Math.max(0, Number(ms) || 0) })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
  }
  async function flush() {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  async function advance(ms) {
    const target = current + ms
    for (let round = 0; round < 50; round += 1) {
      await flush()
      current = target
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)
      if (due.length === 0) return
      for (const [id, timer] of due) {
        timers.delete(id)
        timer.fn()
      }
    }
  }
  return { now: () => current, timers: timersPort, advance, flush, pending: () => timers.size }
}

function hubDeps(scope, clock, transport, extra = {}) {
  return {
    scope,
    transport,
    timers: clock.timers,
    now: clock.now,
    randomId: () => 'hub-test-slot',
    hubRetryMs: 5,
    ...extra,
  }
}

const planScopeOf = (scope) => ({ homeDir: scope.homeDir, profileDir: scope.profileDir, profileName: 'web' })

/** 手工执行席：直接测中枢任务边界（不经过电话，便于精确控制「泵在同一轮里继续」）。 */
function makeSeat({ owner, key, scope, install }) {
  let session = createBatchSession({ id: owner + '-s1', keys: [key], now: 1000 })
  session = markBatchEntry(session, key, { phase: 'ready', targetVersion: '2.0.0' }, 1000).session
  const seat = {
    owner,
    plan: createHubPlan({
      sessionId: session.id,
      owner,
      targets: [{ key, title: key, packageName: 'pkg-' + key, pluginId: 'plugin-' + key, prefix: 'p-' + key }],
      scope: planScopeOf(scope),
      now: 1000,
    }),
    readSession: async () => session,
    saveSession: async (next) => {
      session = next
    },
    check: async () => ({ kind: 'current' }),
    install: (keyArg, requestId, version) => install(keyArg, requestId, version),
    indexOf: (k) => session.order.indexOf(k),
  }
  return { seat, sessionOf: () => session }
}

/** 收未处理 rejection：DSH 会把它们升级成进程退出，所以测试里必须断言「一个都没有」。 */
function trackUnhandled() {
  const seen = []
  const onUnhandled = (reason) => seen.push(reason)
  process.on('unhandledRejection', onUnhandled)
  return {
    seen,
    async settle() {
      for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
    stop() {
      process.off('unhandledRejection', onUnhandled)
    },
  }
}

const TIMED_OUT = Symbol('timed-out')
/** 「不悬挂」的可断言形式：等待超过 3 秒还没回话就是悬挂。先到先清表，别把定时器留到测试进程退出。 */
function within(promise, ms = 3000) {
  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function waitForPhase(clock, host, phone, key, phase) {
  for (let i = 0; i < 200; i += 1) {
    await clock.flush()
    await clock.advance(10)
    const reply = await host.handlers[phone]({})
    if (phaseOf(reply.session, key) === phase) return reply
  }
  throw new Error('等不到相位 ' + phase + '（' + key + '）')
}

const doneTransport = () => ({
  check: async () => ({ kind: 'update', version: '2.0.0' }),
  install: async () => ({ kind: 'done', restartRequired: false }),
})

after(() => {
  __resetHubRegistryForTests()
})

// ---------- 任务层：一个任务的异常不外抛、不悬挂、不拖垮后续 ----------

test('任务边界：租约判定抛未预期异常 → 任务明确 failed，等待者不悬挂，进程无未处理 rejection', async () => {
  const { scope } = await mkScope('hub253-task-boundary-')
  const clock = fakeClock()
  const paths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
  // 盘上有一份别家的活租约：中枢必须走「探测原驾驶者还活着吗」这条路。
  await writeHubLease(paths, {
    version: HUB_LEASE_VERSION,
    driverId: 'other-driver',
    pluginId: 'life',
    pid: 4242,
    generation: 1,
    startedAt: 1000,
    heartbeatAt: clock.now(),
  })
  const track = trackUnhandled()
  const host = createMultiHostUpdate(
    hubDeps(scope, clock, fakeTransport({ a: { check: { kind: 'update', version: '2.0.0' } } }), {
      hubIsProcessAlive: () => {
        throw new Error('probe boom')
      },
    }),
    { hub: true, prefix: 'life', targets: [mkTarget('a')] },
  )
  try {
    const reply = await within(host.handlers['life.batchInstall']({}))
    assert.notEqual(reply, TIMED_OUT, '等待者不许悬挂')
    assert.equal(reply.ok, false, '任务边界要给出明确结局（failed），不是悬挂也不是崩溃')
    assert.equal(typeof reply.error, 'string')
    await track.settle()
    assert.deepEqual(track.seen, [], '进程不出现未处理 rejection')
  } finally {
    host.dispose()
    track.stop()
    unbindAll()
  }
})

test('任务边界：一个任务抛错不拖垮后续任务（泵在同一轮里继续处理下一个）', async () => {
  const { scope } = await mkScope('hub253-pump-forward-')
  const clock = fakeClock()
  const deps = { now: clock.now, randomId: () => 'drv-forward', timers: clock.timers, pid: process.pid, retryMs: 5 }
  let releaseA = null
  let markAStarted = null
  const aStarted = new Promise((resolve) => {
    markAStarted = resolve
  })
  const seatA = makeSeat({
    owner: 'life',
    key: 'a',
    scope,
    install: async () => {
      markAStarted()
      await new Promise((resolve) => {
        releaseA = resolve
      })
      throw new Error('transport boom')
    },
  })
  const seatB = makeSeat({
    owner: 'other',
    key: 'b',
    scope,
    install: async () => ({ kind: 'done', restartRequired: false }),
  })
  const track = trackUnhandled()
  try {
    const pendingA = submitHubTask(scope, seatA.seat, deps)
    await aStarted
    const pendingB = submitHubTask(scope, seatB.seat, deps) // 忙时提交：立刻回 queued
    assert.equal(await pendingB, 'queued', '后续任务先如实回「已排队」')
    releaseA()
    assert.equal(await pendingA, 'failed', '第一个任务抛错要给明确 failed')
    for (let i = 0; i < 60; i += 1) {
      await clock.flush()
      if (phaseOf(seatB.sessionOf(), 'b') === 'done') break
    }
    assert.equal(phaseOf(seatB.sessionOf(), 'b'), 'done', '泵继续把后续任务推到收尾')
    await track.settle()
    assert.deepEqual(track.seen, [], '进程不出现未处理 rejection')
  } finally {
    track.stop()
    __resetHubRegistryForTests()
  }
})

// ---------- 落盘层：租约读 / 写 / 释放三个 seam ----------

test('租约读取 seam：一次异常按让位收场，退避重试后继续推完（不悬挂、不外抛）', async () => {
  const { scope } = await mkScope('hub253-lease-read-')
  const clock = fakeClock()
  let reads = 0
  const io = {
    ...DEFAULT_HUB_IO,
    readLease: async (paths) => {
      reads += 1
      if (reads === 1) throw new Error('lease read boom')
      return await DEFAULT_HUB_IO.readLease(paths)
    },
  }
  const host = createMultiHostUpdate(hubDeps(scope, clock, doneTransport(), { hubIo: io }), {
    hub: true,
    prefix: 'life',
    targets: [mkTarget('a')],
  })
  const track = trackUnhandled()
  try {
    const first = await within(host.handlers['life.batchInstall']({}))
    assert.notEqual(first, TIMED_OUT, '等待者不许悬挂')
    assert.equal(first.ok, true, '一次 I/O 异常不许升级成安装失败')
    assert.equal(phaseOf(first.session, 'a'), 'ready', '异常按「让位重排队」收场')
    const done = await waitForPhase(clock, host, 'life.batchStatus', 'a', 'done')
    assert.equal(phaseOf(done.session, 'a'), 'done', '退避重试后照常推完')
    await track.settle()
    assert.deepEqual(track.seen, [])
  } finally {
    host.dispose()
    track.stop()
    unbindAll()
  }
})

test('租约读取 seam：持续异常到达上限 → 任务明确 failed，不再每秒空转', async () => {
  const { scope } = await mkScope('hub253-lease-read-hard-')
  const clock = fakeClock()
  let reads = 0
  const io = {
    ...DEFAULT_HUB_IO,
    readLease: async () => {
      reads += 1
      throw new Error('lease read boom')
    },
  }
  const host = createMultiHostUpdate(hubDeps(scope, clock, doneTransport(), { hubIo: io }), {
    hub: true,
    prefix: 'life',
    targets: [mkTarget('a')],
  })
  const track = trackUnhandled()
  try {
    const first = await within(host.handlers['life.batchInstall']({}))
    assert.notEqual(first, TIMED_OUT)
    // 把退避定时器耗尽：到上限就判 failed，之后计数不再增长（不是无限空转）。
    for (let i = 0; i < 50 && clock.pending() > 0; i += 1) await clock.advance(10)
    const drained = reads
    for (let i = 0; i < 5; i += 1) await clock.advance(10)
    assert.equal(reads, drained, '到上限后不再重试（没有残留的退避定时器）')
    assert.ok(drained >= HUB_MAX_LEASE_FAULTS && drained < 20, '重试有界，不是无限')
    assert.equal(clock.pending(), 0)
    await track.settle()
    assert.deepEqual(track.seen, [])
  } finally {
    host.dispose()
    track.stop()
    unbindAll()
  }
})

test('租约在驱动中被读坏：这一步让位重排队，不带着坏 I/O 盲推', async () => {
  const { scope } = await mkScope('hub253-lease-read-mid-drive-')
  const clock = fakeClock()
  let reads = 0
  const io = {
    ...DEFAULT_HUB_IO,
    readLease: async (paths) => {
      reads += 1
      // 前两次（拿租约的读 + 写后确认）正常；之后每步复核都读坏。
      if (reads <= 2) return await DEFAULT_HUB_IO.readLease(paths)
      throw new Error('lease read boom mid-drive')
    },
  }
  let installs = 0
  const transport = {
    check: async () => ({ kind: 'update', version: '2.0.0' }),
    install: async () => {
      installs += 1
      return { kind: 'done', restartRequired: false }
    },
  }
  const host = createMultiHostUpdate(hubDeps(scope, clock, transport, { hubIo: io }), {
    hub: true,
    prefix: 'life',
    targets: [mkTarget('a')],
  })
  const track = trackUnhandled()
  try {
    const first = await within(host.handlers['life.batchInstall']({}))
    assert.notEqual(first, TIMED_OUT, '等待者不许悬挂')
    assert.equal(first.ok, true)
    assert.equal(phaseOf(first.session, 'a'), 'ready', '读不到驾驶位事实就这一步让位')
    // 之后的重试会继续撞坏 I/O：到上限判 failed，计数不再增长（不是盲推、也不是空转）。
    for (let i = 0; i < 50 && clock.pending() > 0; i += 1) await clock.advance(10)
    const drained = reads
    for (let i = 0; i < 5; i += 1) await clock.advance(10)
    assert.equal(installs, 0, '拿不到租约事实时一步都不许装（不盲推）')
    assert.equal(reads, drained, '到上限后不再重试')
    assert.ok(drained < 20, '重试有界')
    assert.equal(clock.pending(), 0, '没有残留的退避定时器')
    await track.settle()
    assert.deepEqual(track.seen, [])
  } finally {
    host.dispose()
    track.stop()
    unbindAll()
  }
})

test('租约写入 seam：一次异常按让位收场，退避重试后继续推完（不悬挂、不外抛）', async () => {
  const { scope } = await mkScope('hub253-lease-write-')
  const clock = fakeClock()
  let writes = 0
  const io = {
    ...DEFAULT_HUB_IO,
    writeLease: async (paths, lease) => {
      writes += 1
      if (writes === 1) throw new Error('lease write boom')
      return await DEFAULT_HUB_IO.writeLease(paths, lease)
    },
  }
  const host = createMultiHostUpdate(hubDeps(scope, clock, doneTransport(), { hubIo: io }), {
    hub: true,
    prefix: 'life',
    targets: [mkTarget('a')],
  })
  const track = trackUnhandled()
  try {
    const first = await within(host.handlers['life.batchInstall']({}))
    assert.notEqual(first, TIMED_OUT, '等待者不许悬挂')
    assert.equal(first.ok, true, '一次 I/O 异常不许升级成安装失败')
    assert.equal(phaseOf(first.session, 'a'), 'ready', '异常按「让位重排队」收场')
    const done = await waitForPhase(clock, host, 'life.batchStatus', 'a', 'done')
    assert.equal(phaseOf(done.session, 'a'), 'done', '退避重试后照常推完')
    await track.settle()
    assert.deepEqual(track.seen, [])
  } finally {
    host.dispose()
    track.stop()
    unbindAll()
  }
})

test('租约写入 seam：持续异常到达上限 → 任务明确 failed，不再每秒空转', async () => {
  const { scope } = await mkScope('hub253-lease-write-hard-')
  const clock = fakeClock()
  let writes = 0
  const io = {
    ...DEFAULT_HUB_IO,
    writeLease: async () => {
      writes += 1
      throw new Error('lease write boom')
    },
  }
  const host = createMultiHostUpdate(hubDeps(scope, clock, doneTransport(), { hubIo: io }), {
    hub: true,
    prefix: 'life',
    targets: [mkTarget('a')],
  })
  const track = trackUnhandled()
  try {
    const first = await within(host.handlers['life.batchInstall']({}))
    assert.notEqual(first, TIMED_OUT)
    for (let i = 0; i < 50 && clock.pending() > 0; i += 1) await clock.advance(10)
    const drained = writes
    for (let i = 0; i < 5; i += 1) await clock.advance(10)
    assert.equal(writes, drained, '到上限后不再重试（没有残留的退避定时器）')
    assert.ok(drained >= HUB_MAX_LEASE_FAULTS && drained < 20, '重试有界，不是无限')
    assert.equal(clock.pending(), 0)
    await track.settle()
    assert.deepEqual(track.seen, [])
  } finally {
    host.dispose()
    track.stop()
    unbindAll()
  }
})

test('租约写入 seam：端口正常返回 false（没写进去）仍按单进程推进（ADR-0008 口径不变）', async () => {
  const { scope } = await mkScope('hub253-lease-write-false-')
  const clock = fakeClock()
  const io = { ...DEFAULT_HUB_IO, writeLease: async () => false }
  const host = createMultiHostUpdate(hubDeps(scope, clock, doneTransport(), { hubIo: io }), {
    hub: true,
    prefix: 'life',
    targets: [mkTarget('a')],
  })
  const track = trackUnhandled()
  try {
    const reply = await within(host.handlers['life.batchInstall']({}))
    assert.notEqual(reply, TIMED_OUT)
    assert.equal(reply.ok, true)
    assert.equal(phaseOf(reply.session, 'a'), 'done', '正常的写失败不挡安装')
    assert.equal(await readHubLease(hubPathsForUpdate(scope.homeDir, scope.profileDir)), null)
    await track.settle()
    assert.deepEqual(track.seen, [])
  } finally {
    host.dispose()
    track.stop()
    unbindAll()
  }
})

test('租约释放 seam：释放异常不改写结局，只多留一份过期租约等下一次接管', async () => {
  const { scope } = await mkScope('hub253-lease-release-')
  const clock = fakeClock()
  const paths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
  const io = {
    ...DEFAULT_HUB_IO,
    releaseLease: async () => {
      throw new Error('lease release boom')
    },
  }
  const host = createMultiHostUpdate(hubDeps(scope, clock, doneTransport(), { hubIo: io }), {
    hub: true,
    prefix: 'life',
    targets: [mkTarget('a')],
  })
  const track = trackUnhandled()
  try {
    const reply = await within(host.handlers['life.batchInstall']({}))
    assert.notEqual(reply, TIMED_OUT)
    assert.equal(reply.ok, true)
    assert.equal(phaseOf(reply.session, 'a'), 'done', '释放失败不许改写已给出的结局')
    const leftover = await readHubLease(paths)
    assert.ok(leftover, '释放失败就如实留一份过期租约（下一次按死进程/陈旧窗口接管）')
    await track.settle()
    assert.deepEqual(track.seen, [])
  } finally {
    host.dispose()
    track.stop()
    unbindAll()
  }
})

test('方案写入 seam：方案写不进去只影响别人接手，不影响本次推进', async () => {
  const { scope } = await mkScope('hub253-plan-write-')
  const clock = fakeClock()
  const io = {
    ...DEFAULT_HUB_IO,
    writePlan: async () => {
      throw new Error('plan write boom')
    },
  }
  const host = createMultiHostUpdate(hubDeps(scope, clock, doneTransport(), { hubIo: io }), {
    hub: true,
    prefix: 'life',
    targets: [mkTarget('a')],
  })
  const track = trackUnhandled()
  try {
    const reply = await within(host.handlers['life.batchInstall']({}))
    assert.notEqual(reply, TIMED_OUT)
    assert.equal(reply.ok, true)
    assert.equal(phaseOf(reply.session, 'a'), 'done')
    await track.settle()
    assert.deepEqual(track.seen, [])
  } finally {
    host.dispose()
    track.stop()
    unbindAll()
  }
})

// ---------- 旁路层：孤儿接管 ----------

test('孤儿接管 seam：装载时读方案抛异常 → 按没有方案降级，装载不炸、后续更新照常', async () => {
  const { scope } = await mkScope('hub253-adopt-read-')
  const clock = fakeClock()
  const io = {
    ...DEFAULT_HUB_IO,
    readPlans: async () => {
      throw new Error('plans read boom')
    },
  }
  const track = trackUnhandled()
  const host = createMultiHostUpdate(hubDeps(scope, clock, doneTransport(), { hubIo: io }), {
    hub: true,
    prefix: 'life',
    targets: [mkTarget('a')],
  })
  try {
    await track.settle() // 装载时触发的后台接管任务
    assert.deepEqual(track.seen, [], '后台接管出错也不许外抛')
    const reply = await within(host.handlers['life.batchInstall']({}))
    assert.notEqual(reply, TIMED_OUT)
    assert.equal(reply.ok, true)
    assert.equal(phaseOf(reply.session, 'a'), 'done', '接管失败不影响正常安装')
    assert.equal(hubSlotCountForTests(), 1)
  } finally {
    host.dispose()
    track.stop()
    unbindAll()
  }
})

test('孤儿接管 seam：单个方案接管抛错只放弃那一个，下一个照常、不外抛', async () => {
  const { scope } = await mkScope('hub253-adopt-per-plan-')
  const clock = fakeClock()
  const deps = { now: clock.now, randomId: () => 'drv-adopt', timers: clock.timers, pid: process.pid }
  const planA = createHubPlan({
    sessionId: 's-other',
    owner: 'other',
    targets: [{ key: 'b', title: 'b', packageName: 'pkg-b', pluginId: 'plugin-b', prefix: 'p-b' }],
    scope: planScopeOf(scope),
    now: 1,
  })
  const planB = createHubPlan({
    sessionId: 's-life',
    owner: 'life',
    targets: [{ key: 'a', title: 'a', packageName: 'pkg-a', pluginId: 'plugin-a', prefix: 'p-a' }],
    scope: planScopeOf(scope),
    now: 1,
  })
  const io = { ...DEFAULT_HUB_IO, readPlans: async () => [planA, planB] }
  const adopted = []
  const track = trackUnhandled()
  try {
    adoptOrphanHubTasks(scope, { ...deps, io }, async (plan) => {
      if (plan.owner === 'other') throw new Error('adopt boom')
      adopted.push(plan.owner)
    })
    await track.settle()
    assert.deepEqual(adopted, ['life'], '一个方案接管失败不挡下一个')
    assert.deepEqual(track.seen, [])
  } finally {
    track.stop()
    unbindAll()
  }
})

// ---------- 关停层：定时器、租约与下一次接管 ----------

test('关停：停掉所有中枢退避定时器，下一次装载不用等陈旧窗口就接管', async () => {
  const { scope } = await mkScope('hub253-shutdown-')
  const clock = fakeClock()
  const paths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
  let installCalls = 0
  const transport = {
    check: async () => ({ kind: 'update', version: '2.0.0' }),
    install: async () => {
      installCalls += 1
      if (installCalls === 1) return { kind: 'queued', position: 1 }
      return { kind: 'done', restartRequired: false }
    },
  }
  const options = { hub: true, prefix: 'life', targets: [mkTarget('a')] }
  const first = createMultiHostUpdate(hubDeps(scope, clock, transport), options)
  const track = trackUnhandled()
  try {
    const reply = await within(first.handlers['life.batchInstall']({}))
    assert.notEqual(reply, TIMED_OUT)
    assert.equal(phaseOf(reply.session, 'a'), 'ready', '被队列挡住时先交回现状')
    assert.ok(clock.pending() > 0, '让位后有退避定时器在等')
    const sessionId = reply.session.id

    await shutdownHubScope(scope)
    assert.equal(clock.pending(), 0, '关停要停掉所有中枢重试定时器')
    assert.equal(hubSlotCountForTests(), 0, '槽位已关停')
    assert.equal(await readHubLease(paths), null, '关停后盘上没有租约')

    // 新实例（同进程新槽）装载：按盘上方案与账本接管，不用等 20 秒陈旧窗口。
    const second = createMultiHostUpdate(hubDeps(scope, clock, transport), options)
    try {
      const done = await waitForPhase(clock, second, 'life.batchStatus', 'a', 'done')
      assert.equal(phaseOf(done.session, 'a'), 'done')
      assert.equal(done.session.id, sessionId, '接管的是同一份账本，不新开批次')
    } finally {
      second.dispose()
    }
    await track.settle()
    assert.deepEqual(track.seen, [])
  } finally {
    first.dispose()
    track.stop()
    unbindAll()
  }
})

test('关停：推进中关停也归还本代租约，等待者拿到终态（不悬挂）', async () => {
  const { scope } = await mkScope('hub253-shutdown-running-')
  const clock = fakeClock()
  const paths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
  let releaseInstall = null
  let markStarted = null
  const installStarted = new Promise((resolve) => {
    markStarted = resolve
  })
  const transport = {
    check: async () => ({ kind: 'update', version: '2.0.0' }),
    install: async () => {
      markStarted()
      await new Promise((resolve) => {
        releaseInstall = resolve
      })
      return { kind: 'done', restartRequired: false }
    },
  }
  const host = createMultiHostUpdate(hubDeps(scope, clock, transport), {
    hub: true,
    prefix: 'life',
    targets: [mkTarget('a')],
  })
  const track = trackUnhandled()
  try {
    const pending = host.handlers['life.batchInstall']({})
    await installStarted
    assert.ok(await readHubLease(paths), '推进中应当持有驾驶位')
    await shutdownHubScope(scope)
    assert.equal(await readHubLease(paths), null, '关停要归还本代租约')
    const reply = await within(pending)
    assert.notEqual(reply, TIMED_OUT, '等待者不许悬挂')
    assert.equal(reply.ok, true)
    releaseInstall()
    await clock.flush()
    await track.settle()
    assert.deepEqual(track.seen, [])
  } finally {
    releaseInstall?.()
    host.dispose()
    track.stop()
    unbindAll()
  }
})

test('宿主退出：同步停表并归还本代租约（下一次启动立刻接管）', async () => {
  const scopeQueued = await mkScope('hub253-exit-queued-')
  const scopeRunning = await mkScope('hub253-exit-running-')
  const clock = fakeClock()
  let releaseInstall = null
  let markStarted = null
  const installStarted = new Promise((resolve) => {
    markStarted = resolve
  })
  let installCalls = 0
  const queuedTransport = {
    check: async () => ({ kind: 'update', version: '2.0.0' }),
    install: async () => {
      installCalls += 1
      if (installCalls === 1) return { kind: 'queued', position: 1 }
      return { kind: 'done', restartRequired: false }
    },
  }
  const runningTransport = {
    check: async () => ({ kind: 'update', version: '2.0.0' }),
    install: async () => {
      markStarted()
      await new Promise((resolve) => {
        releaseInstall = resolve
      })
      return { kind: 'done', restartRequired: false }
    },
  }
  const queuedHost = createMultiHostUpdate(hubDeps(scopeQueued.scope, clock, queuedTransport), {
    hub: true,
    prefix: 'life',
    targets: [mkTarget('a')],
  })
  const runningHost = createMultiHostUpdate(hubDeps(scopeRunning.scope, clock, runningTransport), {
    hub: true,
    prefix: 'life',
    targets: [mkTarget('a')],
  })
  const track = trackUnhandled()
  try {
    await queuedHost.handlers['life.batchInstall']({})
    assert.ok(clock.pending() > 0, '让位后有待触发的退避定时器')
    const pendingRunning = runningHost.handlers['life.batchInstall']({})
    await installStarted
    const runningPaths = hubPathsForUpdate(scopeRunning.scope.homeDir, scopeRunning.scope.profileDir)
    assert.ok(await readHubLease(runningPaths), '推进中应当持有驾驶位')

    releaseHubLeasesOnExit()
    assert.equal(clock.pending(), 0, '退出时停掉所有中枢退避定时器')
    assert.equal(await readHubLease(runningPaths), null, '退出时同步归还本代租约')
    assert.equal(hubSlotCountForTests(), 0, '退出后槽位摘干净，下一次装载拿新表')

    releaseInstall()
    const reply = await within(pendingRunning)
    assert.notEqual(reply, TIMED_OUT)
    assert.equal(reply.ok, true)
    await clock.flush()
    await track.settle()
    assert.deepEqual(track.seen, [])
  } finally {
    releaseInstall?.()
    queuedHost.dispose()
    runningHost.dispose()
    track.stop()
    unbindAll()
  }
})
