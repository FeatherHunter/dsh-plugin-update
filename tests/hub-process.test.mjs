/**
 * tests/hub-process.test.mjs —— 进程内更新中枢（ADR-0008 / #248）。
 *
 * 只测外部可观察行为，不测内部实现：
 *   1. 空闲提交：中枢把批次推到收尾，账本/方案落盘，租约归还；
 *   2. 让位：同一批次的安装先被队列挡住（queued），调用方立刻拿现状，
 *      中枢退避后自己把剩下的推完（不绑在调用方 fiber 上）；
 *   3. FIFO：忙时后到的批次立刻回 queued，前一个收尾后中枢自己接着推；
 *   4. 回退线：hub:false 时不写中枢方案，仍在调用方里推完（旧路径零回归）；
 *   5. 接管：盘上租约记着死进程或活着但心跳过期的假死进程，活着的一方换代接过来推完。
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createMultiHostUpdate } from '../dist/host-batch.js'
import { batchPathsForOwner } from '../dist/core/disk.js'
import { hubPathsForUpdate, readHubPlan } from '../dist/host/hub/plan-store.js'
import { readHubLease, writeHubLease } from '../dist/host/hub/lease-store.js'
import { HUB_LEASE_HEARTBEAT_MS, HUB_LEASE_STALE_MS, HUB_LEASE_VERSION } from '../dist/core/hub/lease-policy.js'
import { __resetHubRegistryForTests, hubSlotCountForTests } from '../dist/host/hub/registry.js'
import { fakeTransport, mkScope, mkTarget, phaseOf, unbindAll } from './helpers/batch-log-harness.mjs'
import { fakeClock, makeHubDeps, waitForPhase } from './helpers/hub-harness.mjs'

beforeEach(() => {
  __resetHubRegistryForTests()
})

function allDone(session) {
  return session.entries.every((entry) => entry.phase === 'done' || entry.phase === 'skipped' || entry.phase === 'current')
}

test('空闲提交：推到收尾、账本/方案落盘、租约归还', async () => {
  const { scope } = await mkScope('hub-proc-idle-')
  const clock = fakeClock()
  const transport = fakeTransport({ a: { check: { kind: 'update', version: '2.0.0' } } })
  const host = createMultiHostUpdate(makeHubDeps(scope, clock, transport), {
    hub: true,
    prefix: 'life',
    targets: [mkTarget('self'), mkTarget('a')],
    selfKey: 'self',
    selfOrder: 'first',
  })
  try {
    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true)
    assert.deepEqual(reply.session.order, ['self', 'a'], '爱生活排第一行（#219 口径不变）')
    assert.deepEqual(reply.rows.map((row) => row.key), ['self', 'a'])
    assert.equal(phaseOf(reply.session, 'self'), 'current', '本机已是最新的目标不改相位')
    assert.equal(phaseOf(reply.session, 'a'), 'done')

    const paths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
    const plan = await readHubPlan(paths, 'life')
    assert.ok(plan, '开跑前把方案落盘（别的集成方/后来者据此接手）')
    assert.equal(plan.sessionId, reply.session.id)
    assert.deepEqual(plan.selfOrder, 'first')
    assert.equal(await readHubLease(paths), null, '收尾后把驾驶位还回去')
  } finally {
    host.dispose()
    unbindAll()
  }
})

test('让位：先被队列挡住回 queued，中枢退避后自己推完', async () => {
  const { scope } = await mkScope('hub-proc-yield-')
  const clock = fakeClock()
  let installCalls = 0
  const transport = {
    check: async (key) => (key === 'a' ? { kind: 'update', version: '2.0.0' } : { kind: 'current' }),
    install: async (key) => {
      installCalls += 1
      if (installCalls === 1) return { kind: 'queued', position: 1 }
      return { kind: 'done', restartRequired: false }
    },
  }
  const host = createMultiHostUpdate(makeHubDeps(scope, clock, transport), {
    hub: true,
    prefix: 'life',
    targets: [mkTarget('a')],
  })
  try {
    const first = await host.handlers['life.batchInstall']({})
    assert.equal(first.ok, true)
    assert.equal(phaseOf(first.session, 'a'), 'ready', '被队列挡住不是失败（相位回 ready）')
    assert.equal(allDone(first.session), false)

    const second = await waitForPhase(clock, host, 'life.batchStatus', 'a', 'done')
    assert.equal(phaseOf(second.session, 'a'), 'done', '中枢自己退避重试把这一家装完')
    assert.equal(installCalls >= 2, true)
  } finally {
    host.dispose()
    unbindAll()
  }
})

test('FIFO：忙时提交立刻回 queued，前一个收尾后中枢接着推下一个', async () => {
  const { scope } = await mkScope('hub-proc-fifo-')
  const clock = fakeClock()
  let releaseFirst = null
  let firstInstallStarted = null
  const started = new Promise((resolve) => {
    firstInstallStarted = resolve
  })
  const slowTransport = {
    check: async () => ({ kind: 'update', version: '2.0.0' }),
    install: async (key) => {
      if (key === 'a') {
        firstInstallStarted()
        await new Promise((resolve) => {
          releaseFirst = resolve
        })
      }
      return { kind: 'done', restartRequired: false }
    },
  }
  const hostA = createMultiHostUpdate(makeHubDeps(scope, clock, slowTransport), { hub: true, prefix: 'life', targets: [mkTarget('a')] })
  const fastTransport = {
    check: async () => ({ kind: 'update', version: '2.0.0' }),
    install: async () => ({ kind: 'done', restartRequired: false }),
  }
  const hostB = createMultiHostUpdate(makeHubDeps(scope, clock, fastTransport), { hub: true, prefix: 'other', targets: [mkTarget('b')] })
  try {
    const pendingA = hostA.handlers['life.batchInstall']({})
    await started

    const replyB = await hostB.handlers['other.batchInstall']({})
    assert.equal(replyB.ok, true)
    assert.equal(allDone(replyB.session), false, 'B 不该等 A 装完才回话（FIFO 排队，不阻塞调用方）')
    assert.equal(hubSlotCountForTests(), 1, '同一使用范围共用一条中枢任务表')

    releaseFirst()
    const replyA = await pendingA
    assert.equal(replyA.ok, true)
    assert.equal(phaseOf(replyA.session, 'a'), 'done')

    const afterB = await waitForPhase(clock, hostB, 'other.batchStatus', 'b', 'done')
    assert.equal(phaseOf(afterB.session, 'b'), 'done', 'A 收尾后中枢自己接着推 B')
  } finally {
    releaseFirst?.()
    hostA.dispose()
    hostB.dispose()
    unbindAll()
  }
})

test('回退线：hub:false 不写中枢方案，仍在调用方里推完', async () => {
  const { scope } = await mkScope('hub-proc-off-')
  const clock = fakeClock()
  const transport = {
    check: async () => ({ kind: 'update', version: '2.0.0' }),
    install: async () => ({ kind: 'done', restartRequired: false }),
  }
  const host = createMultiHostUpdate(makeHubDeps(scope, clock, transport), {
    hub: false,
    prefix: 'life',
    targets: [mkTarget('a')],
  })
  try {
    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true)
    assert.equal(phaseOf(reply.session, 'a'), 'done')
    const paths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
    assert.equal(await readHubPlan(paths, 'life'), null, '回旧路径时不碰中枢方案')
    assert.equal(hubSlotCountForTests(), 0, '回旧路径时不起中枢槽')
  } finally {
    host.dispose()
    unbindAll()
  }
})

test('接管：盘上租约记着活着但假死的进程（心跳过期），活着的一方换代接过来推完', async () => {
  const { scope } = await mkScope('hub-proc-stale-alive-')
  const clock = fakeClock()
  const paths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
  const now = clock.now()
  await writeHubLease(paths, {
    version: HUB_LEASE_VERSION,
    driverId: 'hung-driver',
    pluginId: 'life',
    pid: 4242,
    generation: 1,
    startedAt: now - 120_000,
    heartbeatAt: now - HUB_LEASE_STALE_MS,
  })
  let leaseDuringInstall = null
  const transport = {
    check: async () => ({ kind: 'update', version: '2.0.0' }),
    install: async () => {
      leaseDuringInstall = await readHubLease(paths)
      return { kind: 'done', restartRequired: false }
    },
  }
  const host = createMultiHostUpdate(makeHubDeps(scope, clock, transport, { hubIsProcessAlive: () => true }), {
    hub: true,
    prefix: 'life',
    targets: [mkTarget('a')],
  })
  try {
    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true)
    assert.equal(phaseOf(reply.session, 'a'), 'done')
    assert.ok(leaseDuringInstall, '安装期间应该有活着的驾驶位')
    assert.notEqual(leaseDuringInstall.driverId, 'hung-driver', '心跳过期的假死进程租约被接管')
    assert.equal(leaseDuringInstall.generation, 2, '换代 +1')
    assert.equal(await readHubLease(paths), null, '推完归还租约')
  } finally {
    host.dispose()
    unbindAll()
  }
})

test('换代期间的旧心跳不覆盖新驾驶位：被接管后旧驱动不复写旧代次', async () => {
  const { scope } = await mkScope('hub-proc-heartbeat-fence-')
  const clock = fakeClock()
  const paths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
  const transport = {
    check: async () => ({ kind: 'update', version: '2.0.0' }),
    install: async () => {
      // 安装期间另一个实例换代接管（模拟长步骤里发生的真接管）。
      await clock.advance(HUB_LEASE_HEARTBEAT_MS + 1)
      await writeHubLease(paths, {
        version: HUB_LEASE_VERSION,
        driverId: 'new-driver',
        pluginId: 'life',
        pid: 4242,
        generation: 2,
        startedAt: clock.now(),
        heartbeatAt: clock.now(),
      })
      return { kind: 'done', restartRequired: false }
    },
  }
  const host = createMultiHostUpdate(makeHubDeps(scope, clock, transport, { hubIsProcessAlive: () => true }), {
    hub: true,
    prefix: 'life',
    targets: [mkTarget('a')],
  })
  try {
    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true)
    const lease = await readHubLease(paths)
    assert.ok(lease, '新驾驶位的租约应还在（旧驱动不许删/不许覆盖）')
    assert.equal(lease.driverId, 'new-driver')
    assert.equal(lease.generation, 2, '旧代次的心跳不能把代次写回去')
  } finally {
    host.dispose()
    unbindAll()
  }
})

test('接管：盘上租约记着死进程，活着的一方换代接过来推完', async () => {
  const { scope } = await mkScope('hub-proc-takeover-')
  const clock = fakeClock()
  const paths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
  await writeHubLease(paths, {
    version: HUB_LEASE_VERSION,
    driverId: 'dead-driver',
    pluginId: 'life',
    pid: 999999,
    generation: 1,
    startedAt: 1000,
    heartbeatAt: 1000,
  })
  let leaseDuringInstall = null
  const transport = {
    check: async () => ({ kind: 'update', version: '2.0.0' }),
    install: async () => {
      leaseDuringInstall = await readHubLease(paths)
      return { kind: 'done', restartRequired: false }
    },
  }
  const host = createMultiHostUpdate(makeHubDeps(scope, clock, transport), { hub: true, prefix: 'life', targets: [mkTarget('a')] })
  try {
    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true)
    assert.equal(phaseOf(reply.session, 'a'), 'done')
    assert.ok(leaseDuringInstall, '安装期间应该有活着的驾驶位')
    assert.equal(leaseDuringInstall.driverId === 'dead-driver', false, '死进程的租约被接管')
    assert.equal(leaseDuringInstall.generation, 2, '换代 +1（不让旧进程复活后误认自己还持锁）')
    assert.equal(await readHubLease(paths), null, '推完归还租约')
  } finally {
    host.dispose()
    unbindAll()
  }
})






// --- 对抗审查 B1/B2/B3 回归（2026-10-25） ---

test('行级选择：hub 下点装某一家只推那一家（B1 回归）', async () => {
  const { scope } = await mkScope('hub-proc-keys-')
  const clock = fakeClock()
  const transport = {
    check: async () => ({ kind: 'update', version: '2.0.0' }),
    install: async () => ({ kind: 'done', restartRequired: false }),
  }
  const host = createMultiHostUpdate(makeHubDeps(scope, clock, transport), {
    hub: true,
    prefix: 'life',
    targets: [mkTarget('a'), mkTarget('b')],
  })
  try {
    const reply = await host.handlers['life.batchInstall']({ keys: ['b'] })
    assert.equal(reply.ok, true)
    assert.equal(phaseOf(reply.session, 'b'), 'done')
    assert.equal(phaseOf(reply.session, 'a'), 'pending', '没选中的行不许被中枢顺手装掉')
    const status = await host.handlers['life.batchStatus']({})
    assert.equal(phaseOf(status.session, 'a'), 'pending', '落盘后也不许被整批推进污染')
  } finally {
    host.dispose()
    unbindAll()
  }
})

test('队列长期被占：让位不累计成故障（B2 回归）', async () => {
  const { scope } = await mkScope('hub-proc-queue-')
  const clock = fakeClock()
  let attempts = 0
  const transport = {
    check: async () => ({ kind: 'update', version: '2.0.0' }),
    install: async () => {
      attempts += 1
      if (attempts <= 15) return { kind: 'queued', position: 1 }
      return { kind: 'done', restartRequired: false }
    },
  }
  const host = createMultiHostUpdate(makeHubDeps(scope, clock, transport), {
    hub: true,
    prefix: 'life',
    targets: [mkTarget('a')],
  })
  try {
    const first = await host.handlers['life.batchInstall']({})
    assert.equal(first.ok, true)
    assert.equal(first.session.entries.some((entry) => entry.phase === 'failed'), false, '排队不是失败')
    const done = await waitForPhase(clock, host, 'life.batchStatus', 'a', 'done')
    assert.equal(phaseOf(done.session, 'a'), 'done')
    assert.equal(attempts > 10, true, '确实被队列挡了十几次')
    assert.equal(done.session.entries.some((entry) => entry.phase === 'failed'), false, '不写失败总账')
  } finally {
    host.dispose()
    unbindAll()
  }
})

test('驱动中并发重试不被陈旧快照覆盖（B3 回归：failed → pending → 二次成功）', async () => {
  const { scope } = await mkScope('hub-proc-merge-')
  const clock = fakeClock()
  let releaseB = null
  let markBStarted = null
  const bStarted = new Promise((resolve) => {
    markBStarted = resolve
  })
  let aAttempts = 0
  const transport = {
    check: async () => ({ kind: 'update', version: '2.0.0' }),
    install: async (key) => {
      if (key === 'a') {
        aAttempts += 1
        // 第一次装失败（留给用户在驱动中点「重试」），第二次成功。
        if (aAttempts === 1) return { kind: 'failed', error: 'install-failed', stage: 'install' }
        return { kind: 'done', restartRequired: false }
      }
      markBStarted()
      await new Promise((resolve) => {
        releaseB = resolve
      })
      return { kind: 'done', restartRequired: false }
    },
  }
  const host = createMultiHostUpdate(makeHubDeps(scope, clock, transport), {
    hub: true,
    prefix: 'life',
    targets: [mkTarget('a'), mkTarget('b')],
  })
  try {
    const pending = host.handlers['life.batchInstall']({})
    await bStarted
    // 模拟用户在 b 装的空档点了「重试 a」：盘上把 a 从 failed 改回 pending（joinWhileBusy 的落盘效果）。
    const paths = batchPathsForOwner(scope.homeDir, scope.profileDir, 'life')
    const disk = JSON.parse(await readFile(paths.batchFile, 'utf8'))
    disk.entries = disk.entries.map((entry) => (entry.key === 'a' ? { ...entry, phase: 'pending', error: null } : entry))
    await writeFile(paths.batchFile, JSON.stringify(disk), 'utf8')
    releaseB()
    const reply = await pending
    assert.equal(reply.ok, true)
    assert.equal(aAttempts >= 2, true, '中枢必须看见盘上的 pending 并重试 a（旧代码会写回 failed、一次不试）')
    const after = await host.handlers['life.batchStatus']({})
    assert.equal(phaseOf(after.session, 'a'), 'done', '并发重试最终成功，不被陈旧快照回滚成 failed')
    assert.equal(after.session.entries.some((entry) => entry.phase === 'failed'), false)
  } finally {
    releaseB?.()
    host.dispose()
    unbindAll()
  }
})

test('排队中再点另一行：selection 取并集，两次点击都算数（B1 残余回归）', async () => {
  const { scope } = await mkScope('hub-proc-keys-merge-')
  const clock = fakeClock()
  let releaseB = null
  let markBStarted = null
  const bStarted = new Promise((resolve) => {
    markBStarted = resolve
  })
  const transport = {
    check: async () => ({ kind: 'update', version: '2.0.0' }),
    install: async (key) => {
      if (key === 'b') {
        markBStarted()
        await new Promise((resolve) => {
          releaseB = resolve
        })
      }
      return { kind: 'done', restartRequired: false }
    },
  }
  const host = createMultiHostUpdate(makeHubDeps(scope, clock, transport), {
    hub: true,
    prefix: 'life',
    targets: [mkTarget('a'), mkTarget('b')],
  })
  try {
    const first = host.handlers['life.batchInstall']({ keys: ['b'] })
    await bStarted
    // 同一批次在跑 b 的时候，用户又点了 a：第二次的意图必须并进同一个任务。
    const second = await host.handlers['life.batchInstall']({ keys: ['a'] })
    assert.equal(second.ok, true)
    releaseB()
    await first
    const done = await waitForPhase(clock, host, 'life.batchStatus', 'a', 'done')
    assert.equal(phaseOf(done.session, 'a'), 'done', '第二次点击的那一行也要装')
    assert.equal(phaseOf(done.session, 'b'), 'done')
  } finally {
    releaseB?.()
    host.dispose()
    unbindAll()
  }
})
