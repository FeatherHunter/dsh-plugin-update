/**
 * tests/hub-takeover.test.mjs —— 孤儿接管（ADR-0008 / #249）。
 *
 * 只测外部可观察行为，不测内部实现：
 *   1. 发起方消失后，同进程新实例按盘上方案接着把同一批推完（不新开批次）；
 *   2. 已收尾的会话不会被后来者重装；
 *   3. 只接手自己属主的方案——别家的方案与账本一概不动。
 *
 * 「进程重启」用 __resetHubRegistryForTests() 模拟：槽、租约、定时器全丢，
 * 只剩盘上的 batch.json + plans/<owner>.json——这正是自更新后的真实起点。
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createMultiHostUpdate } from '../dist/host-batch.js'
import { hubPathsForUpdate, readHubPlan } from '../dist/host/hub/plan-store.js'
import { __resetHubRegistryForTests } from '../dist/host/hub/registry.js'
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

test('只接手自己属主的方案：别家的方案与账本一概不动', async () => {
  const { scope } = await mkScope('hub-takeover-other-')
  const clock = fakeClock()
  const transport = queuedThenDoneTransport({ b: { check: { kind: 'update', version: '2.0.0' } } })

  const other = createMultiHostUpdate(makeHubDeps(scope, clock, transport), {
    hub: true,
    prefix: 'other',
    targets: [mkTarget('b')],
  })
  const otherReply = await other.handlers['other.batchInstall']({})
  assert.equal(phaseOf(otherReply.session, 'b'), 'ready')
  other.dispose()
  await restartProcess(clock)

  const life = createMultiHostUpdate(makeHubDeps(scope, clock, transport), {
    hub: true,
    prefix: 'life',
    targets: [mkTarget('a')],
  })
  try {
    for (let i = 0; i < 20; i += 1) {
      await clock.flush()
      await clock.advance(10)
    }
    const paths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
    assert.ok(await readHubPlan(paths, 'other'), '别家的方案不被删')
    assert.equal(transport.installCount, 1, '不替别家再装一次')
  } finally {
    life.dispose()
  }

  // 用 hub:false 的只读实例看别家账本：仍是 ready，没有被推进。
  const reader = createMultiHostUpdate({ scope, transport }, { hub: false, prefix: 'other', targets: [mkTarget('b')] })
  try {
    const status = await reader.handlers['other.batchStatus']({})
    assert.equal(phaseOf(status.session, 'b'), 'ready', '别家的账本保持原样')
  } finally {
    reader.dispose()
    unbindAll()
  }
})

