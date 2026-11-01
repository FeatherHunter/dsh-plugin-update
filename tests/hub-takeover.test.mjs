/**
 * tests/hub-takeover.test.mjs —— 孤儿接管（ADR-0008 / #249 / #276）。
 *
 * 只测外部可观察行为，不测内部实现：
 *   1. 发起方消失后，同进程新实例按盘上方案接着把同一批推完（不新开批次）；
 *   2. 已收尾的会话不会被后来者重装；
 *   3. 跨属主接管（US31）：别的属主留下的未收尾方案，任一存活实例都能接着装完——
 *      已 done 的行不重装，没装完的那家由接管方自己的传输装完；
 *   4. 取消（US33）：账本、方案、租约一并清理，重启后不会装一个幽灵批次。
 *
 * 「进程重启」用 __resetHubRegistryForTests() 模拟：槽、租约、定时器全丢，
 * 只剩盘上的 batch.json + plans/<owner>.json——这正是自更新后的真实起点。
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createMultiHostUpdate } from '../dist/host-batch.js'
import { createBatchOwnerPorts } from '../dist/core/disk.js'
import { readHubLease } from '../dist/host/hub/lease-store.js'
import { hubPathsForUpdate, readHubPlan } from '../dist/host/hub/plan-store.js'
import { __resetHubRegistryForTests, hubBusyForScope } from '../dist/host/hub/registry.js'
import { mkScope, mkTarget, phaseOf, unbindAll } from './helpers/batch-log-harness.mjs'
import { fakeClock, makeHubDeps, waitForPhase } from './helpers/hub-harness.mjs'

beforeEach(() => {
  __resetHubRegistryForTests()
})

/**
 * 「进程重启」：先让上一任泵把收尾（含租约释放的 I/O）跑完，再丢注册表。
 * 不等这一步，旧泵的 finally 可能落在新实例已经拿到驾驶位之后（Windows 上 rename/unlink
 * 都是真 I/O，等待者被 resolve 并不代表泵已经收手）。
 */
async function restartProcess(clock) {
  await clock.flush()
  __resetHubRegistryForTests()
}

/**
 * 第一次装被队列挡住（queued），之后正常装完。
 * 这样第一任发起方只推了一步就让位，盘上留下「ready + 方案」——接着被杀掉。
 */
function queuedThenDoneTransport(script) {
  let installCalls = 0
  return {
    check: async (key) => script[key]?.check ?? { kind: 'current' },
    install: async (key) => {
      installCalls += 1
      if (installCalls === 1) return { kind: 'queued', position: 1 }
      return script[key]?.install ?? { kind: 'done', restartRequired: false }
    },
    get installCount() {
      return installCalls
    },
  }
}

/** 按目标脚本记账的传输：check 全 update，install 按脚本（没给就 done）。 */
function keyedTransport(script) {
  const installs = []
  return {
    check: async (key) => script[key]?.check ?? { kind: 'current' },
    install: async (key) => {
      installs.push(key)
      return script[key]?.install ?? { kind: 'done', restartRequired: false }
    },
    get installs() {
      return installs
    },
  }
}

test('重启接管：发起方消失后，同进程新实例按盘上方案接着推完', async () => {
  const { scope } = await mkScope('hub-takeover-resume-')
  const clock = fakeClock()
  const transport = queuedThenDoneTransport({ a: { check: { kind: 'update', version: '2.0.0' } } })
  const options = { hub: true, prefix: 'life', targets: [mkTarget('a')] }

  const first = createMultiHostUpdate(makeHubDeps(scope, clock, transport), options)
  const reply = await first.handlers['life.batchInstall']({})
  assert.equal(reply.ok, true)
  assert.equal(phaseOf(reply.session, 'a'), 'ready', '被队列挡住时先把现状交回去，不算失败')
  const sessionId = reply.session.id
  first.dispose()
  await restartProcess(clock)

  const second = createMultiHostUpdate(makeHubDeps(scope, clock, transport), options)
  try {
    const done = await waitForPhase(clock, second, 'life.batchStatus', 'a', 'done')
    assert.equal(done.session.id, sessionId, '接手的是同一份账本，不新开批次')
    const paths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
    const plan = await readHubPlan(paths, 'life')
    assert.ok(plan)
    assert.equal(plan.sessionId, sessionId)
  } finally {
    second.dispose()
    unbindAll()
  }
})

test('已收尾的会话不再重装', async () => {
  const { scope } = await mkScope('hub-takeover-settled-')
  const clock = fakeClock()
  const transport = queuedThenDoneTransport({ a: { check: { kind: 'update', version: '2.0.0' } } })
  const options = { hub: true, prefix: 'life', targets: [mkTarget('a')] }

  const first = createMultiHostUpdate(makeHubDeps(scope, clock, transport), options)
  const reply = await first.handlers['life.batchInstall']({})
  assert.equal(phaseOf(reply.session, 'a'), 'ready')
  first.dispose()
  await restartProcess(clock)

  const second = createMultiHostUpdate(makeHubDeps(scope, clock, transport), options)
  try {
    await waitForPhase(clock, second, 'life.batchStatus', 'a', 'done')
  } finally {
    second.dispose()
  }

  const installsBefore = transport.installCount
  const third = createMultiHostUpdate(makeHubDeps(scope, clock, transport), options)
  try {
    for (let i = 0; i < 20; i += 1) {
      await clock.flush()
      await clock.advance(10)
    }
    assert.equal(transport.installCount, installsBefore, '收尾后再装载不重装')
    const status = await third.handlers['life.batchStatus']({})
    assert.equal(phaseOf(status.session, 'a'), 'done')
  } finally {
    third.dispose()
    unbindAll()
  }
})

test('跨属主接管：别的属主留下的方案，任一存活实例用自己的能力接着装完', async () => {
  const { scope } = await mkScope('hub-takeover-foreign-')
  const clock = fakeClock()
  // other 自己只推得动 b：c 被队列挡住（模拟第一任还没装完就消失）。
  const otherTransport = keyedTransport({
    b: { check: { kind: 'update', version: '2.0.0' }, install: { kind: 'done', restartRequired: false } },
    c: { check: { kind: 'update', version: '2.0.0' }, install: { kind: 'queued', position: 1 } },
  })

  const other = createMultiHostUpdate(makeHubDeps(scope, clock, otherTransport), {
    hub: true,
    prefix: 'other',
    targets: [mkTarget('b'), mkTarget('c')],
  })
  const otherReply = await other.handlers['other.batchInstall']({})
  assert.equal(otherReply.ok, true)
  assert.equal(phaseOf(otherReply.session, 'b'), 'done', 'other 先把自己推得动的那家装完')
  assert.equal(phaseOf(otherReply.session, 'c'), 'ready', 'c 被队列挡住，留在账本里')
  const sessionId = otherReply.session.id
  other.dispose()
  await restartProcess(clock)

  // life 只认识自己那家 a：它的执行能力与 other 的方案无关，但盘上方案说该装 c。
  const lifeTransport = keyedTransport({})
  const life = createMultiHostUpdate(makeHubDeps(scope, clock, lifeTransport), {
    hub: true,
    prefix: 'life',
    targets: [mkTarget('a')],
  })
  try {
    const otherPorts = createBatchOwnerPorts(scope.homeDir, scope.profileDir, 'other')
    let session = null
    for (let i = 0; i < 200; i += 1) {
      await clock.flush()
      await clock.advance(10)
      session = await otherPorts.readBatch()
      if (phaseOf(session, 'c') === 'done') break
    }
    assert.equal(phaseOf(session, 'b'), 'done', '已装完的家保持原样')
    assert.equal(phaseOf(session, 'c'), 'done', 'life 实例把 other 没装完的家装完了')
    assert.equal(session.id, sessionId, '接的是同一份账本，不新开批次')
    assert.deepEqual(lifeTransport.installs, ['c'], '只装没装完的那家：已 done 的不重装')
    assert.deepEqual(otherTransport.installs, ['b', 'c'], 'other 自己只走到 b 装完、c 排队')
  } finally {
    life.dispose()
  }

  const paths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
  const plan = await readHubPlan(paths, 'other')
  assert.ok(plan, '接管不撤别人的方案（只有取消才撤）')
  assert.equal(plan.sessionId, sessionId)
  unbindAll()
})

test('取消批次：账本、方案与租约一并清理，重启后不装幽灵批次', async () => {
  const { scope } = await mkScope('hub-takeover-cancel-')
  const clock = fakeClock()
  const transport = queuedThenDoneTransport({ a: { check: { kind: 'update', version: '2.0.0' } } })
  const options = { hub: true, prefix: 'life', targets: [mkTarget('a')] }

  const first = createMultiHostUpdate(makeHubDeps(scope, clock, transport), options)
  const reply = await first.handlers['life.batchInstall']({})
  assert.equal(reply.ok, true)
  assert.equal(phaseOf(reply.session, 'a'), 'ready')
  await clock.flush()

  const paths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
  assert.ok(await readHubPlan(paths, 'life'), '提交后盘上有方案')

  const cancelled = await first.handlers['life.batchCancel']({})
  assert.equal(cancelled.ok, true)
  assert.equal(cancelled.session.entries.length, 0, '账本已清空')
  await clock.flush()

  assert.equal(await readHubPlan(paths, 'life'), null, '取消撤掉方案')
  assert.equal(hubBusyForScope(scope), false, '取消撤掉中枢任务')
  assert.equal(await readHubLease(paths), null, '取消释放租约')
  first.dispose()
  await restartProcess(clock)

  const installsBefore = transport.installCount
  const second = createMultiHostUpdate(makeHubDeps(scope, clock, transport), options)
  try {
    for (let i = 0; i < 20; i += 1) {
      await clock.flush()
      await clock.advance(10)
    }
    assert.equal(transport.installCount, installsBefore, '重启后不会接着装被取消的批次')
    const status = await second.handlers['life.batchStatus']({})
    assert.equal(status.session.entries.length, 0, '重启后仍是空账本')
  } finally {
    second.dispose()
    unbindAll()
  }
})
