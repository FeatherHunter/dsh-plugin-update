/**
 * tests/hub-single-writer.test.mjs —— #276 P0：更新中枢的「真单写者」契约。
 *
 * 只从外部可观察的事实断言（盘上租约、账本相位、电话回值、安装被调了几次），不测内部实现：
 *   (a) 长安装步（> 20s 陈旧窗口）期间驾驶位持续续活：别人不会把正在装的人误判成假死；
 *   (b) 租约文件被删后心跳不得把旧代次写回（禁止复活）；
 *   (d) 接管真的发生时，旧代次不得再把安装结果写进账本（账本写前代次栅栏）；
 *   (i) 方案内容不变时不重复写盘（L101 sameHubPlan 接线）；
 *   (n) FIFO 队头长期 queued 不饿死后来者；
 *   (h) 取消/清空时同时撤方案、任务与租约，不留空转幽灵任务；
 *   (m) activeInstall 与方案 targets 的插件身份匹配。
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'

import { createMultiHostUpdate } from '../dist/host-batch.js'
import { DEFAULT_HUB_IO } from '../dist/host/hub/boundary.js'
import { hubPathsForUpdate, readHubPlan } from '../dist/host/hub/plan-store.js'
import { readHubLease, writeHubLease } from '../dist/host/hub/lease-store.js'
import {
  HUB_LEASE_HEARTBEAT_MS,
  HUB_LEASE_STALE_MS,
  HUB_LEASE_VERSION,
  decideHubLease,
} from '../dist/core/hub/lease-policy.js'
import { __resetHubRegistryForTests, revokeHubTask } from '../dist/host/hub/registry.js'
import { fakeTransport, mkScope, mkTarget, phaseOf, unbindAll } from './helpers/batch-log-harness.mjs'
import { fakeClock, makeHubDeps, waitForPhase, writeLeaseEventually } from './helpers/hub-harness.mjs'

beforeEach(() => {
  __resetHubRegistryForTests()
})

function installHost(scope, clock, transport, options, extra = {}) {
  return createMultiHostUpdate(makeHubDeps(scope, clock, transport, extra), { hub: true, ...options })
}

test('长安装步超过陈旧窗口：心跳保持者续活，别的驾驶位不会误判假死', async () => {
  const { scope } = await mkScope('hub-single-long-step-')
  const clock = fakeClock()
  const paths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
  const observed = []
  // 心跳是「异步写盘」：推进假时钟只负责把定时器点着，真正落盘要等真实 I/O 完成。
  // 所以每拍 advance + flush 后读一次盘：读到前进就记一拍，没读到就下一拍再看——
  // 不用「每拍死等 N 秒」的墙钟轮询（并行全量负载下那种等待会假红）。
  const waitForRenewal = async (afterHeartbeatAt) => {
    const lease = await readHubLease(paths)
    return lease && lease.heartbeatAt > afterHeartbeatAt ? lease : null
  }
  const transport = {
    check: async () => ({ kind: 'update', version: '2.0.0' }),
    install: async () => {
      // 假装一次装 30 秒：每 5 秒读一次盘上的驾驶位（真实安装步之间没有心跳机会）。
      const acquired = await readHubLease(paths)
      assert.ok(acquired, '驾驶位已在盘上')
      observed.push(acquired)
      // 假时钟下「下一拍」是心跳完成时才重新排的（真实 I/O 让节拍点在假时钟上漂移），
      // 一次 advance 不一定正好点到下一拍。这里给足假时间预算：每点一拍就等盘上心跳前进，
      // 没前进就继续往下点，直到攒够 6 次续活（30 秒假时间）。
      // 总预算按墙钟给（并行全量负载下 fs 完成可能慢），每拍只推进假时钟 + 读一次盘，不死等单拍。
      // 收尾条件不只是「攒够 7 拍」：还要盘上那份心跳相对「此刻的假时钟」是新鲜的——
      // 否则最后读到的是几拍之前落盘的旧值，用当前 now 判定当然会超窗（异步写盘还在飞）。
      const budgetDeadline = Date.now() + 15_000
      while (Date.now() < budgetDeadline) {
        await clock.advance(HUB_LEASE_HEARTBEAT_MS)
        await clock.flush()
        const renewed = await waitForRenewal(observed[observed.length - 1].heartbeatAt)
        if (renewed) observed.push(renewed)
        const latest = await readHubLease(paths)
        if (latest && clock.now() - latest.heartbeatAt < HUB_LEASE_STALE_MS && observed.length >= 7) {
          if (latest.heartbeatAt > observed[observed.length - 1].heartbeatAt) observed.push(latest)
          break
        }
      }
      assert.ok(observed.length >= 7, '长安装步 30 秒里心跳至少续活 6 拍（保持者没跑或没写进盘就会不到）')
      return { kind: 'done', restartRequired: false }
    },
  }
  const host = installHost(scope, clock, transport, { prefix: 'life', targets: [mkTarget('a')] })
  try {
    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true)
    assert.equal(phaseOf(reply.session, 'a'), 'done', '长步期间驾驶位没被误判假死，安装正常收尾')
    assert.ok(observed.length >= 7, '起步一份 + 至少六拍续活')
    assert.equal(observed.every(Boolean), true, '整个长步期间租约一直在盘上')

    const first = observed[0]
    const last = observed[observed.length - 1]
    assert.equal(last.driverId, first.driverId, '长步期间没有换代（是续活，不是被接管）')
    assert.equal(last.generation, 1)
    const now = clock.now()
    assert.ok(last.heartbeatAt > first.heartbeatAt, '心跳确实被续活过（不是最初那份一直不动）')
    assert.ok(
      now - last.heartbeatAt < HUB_LEASE_STALE_MS,
      '按陈旧窗口判定：别的驾驶位看到的是一个活着的驾驶位（而不是 30 秒不动的心跳）',
    )
    assert.equal(
      decideHubLease({ current: last, driverId: 'contender', now, processAlive: true }).kind,
      'wait',
      '心跳新鲜时后来者必须等，不许抢',
    )
    // 对照：假如同样的 30 秒里心跳停在最初那一刻（没有续活），按 20 秒陈旧窗口确实会被判假死——
    // 证明这条用例真的跨过了窗口，而不是窗口没到。
    assert.equal(
      decideHubLease({ current: { ...first }, driverId: 'contender', now, processAlive: true }).kind,
      'takeover',
      '没有续活的话窗口真的超了（对照组）',
    )
  } finally {
    host.dispose()
    unbindAll()
  }
})

test('租约文件被删后心跳不得复活旧代次（禁止复活）', async () => {
  const { scope } = await mkScope('hub-single-no-resurrect-')
  const clock = fakeClock()
  const paths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
  const transport = {
    check: async () => ({ kind: 'update', version: '2.0.0' }),
    install: async () => {
      // 模拟驾驶位文件被外部撤掉（清理/误删/另一套工具撤销接管），并推进到下一次心跳点。
      await rm(paths.leaseFile, { force: true })
      await clock.advance(HUB_LEASE_HEARTBEAT_MS + 1)
      return { kind: 'done', restartRequired: false }
    },
  }
  const host = installHost(scope, clock, transport, { prefix: 'life', targets: [mkTarget('a')] })
  try {
    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true)
    assert.equal(await readHubLease(paths), null, '盘上没有租约时心跳不得把旧代次写回来（复活）')
    assert.notEqual(phaseOf(reply.session, 'a'), 'done', '丢了驾驶位就不许把安装结果写进账本')
  } finally {
    host.dispose()
    unbindAll()
  }
})

test('接管发生后旧代次不得把安装结果写进账本（账本写前代次栅栏）', async () => {
  const { scope } = await mkScope('hub-single-ledger-fence-')
  const clock = fakeClock()
  const paths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
  const transport = {
    check: async () => ({ kind: 'update', version: '2.0.0' }),
    install: async () => {
      // 安装期间另一个驾驶位换代接管（长步骤里发生的真接管），旧驱动随后拿到「装完了」。
      await clock.advance(HUB_LEASE_HEARTBEAT_MS + 1)
      await writeLeaseEventually(paths, {
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
  // 心跳节拍拉长到 60s：让「接管」发生在两次心跳之间（确定性，不与保持者的异步写盘抢时间）。
  const host = installHost(
    scope,
    clock,
    transport,
    { prefix: 'life', targets: [mkTarget('a')] },
    { hubIsProcessAlive: () => true, hubHeartbeatMs: 60_000 },
  )
  try {
    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true)
    const lease = await readHubLease(paths)
    assert.ok(lease, '新驾驶位的租约还在（旧驱动不许覆盖/删除）')
    assert.equal(lease.driverId, 'new-driver')
    assert.equal(lease.generation, 2)
    assert.equal(phaseOf(reply.session, 'a'), 'installing', '旧代次不许把 done 写进账本，只留在中断相位交给新驾驶位')
  } finally {
    host.dispose()
    unbindAll()
  }
})

test('方案内容不变不重复写盘（L101 sameHubPlan 接线）', async () => {
  const { scope } = await mkScope('hub-single-plan-write-')
  const clock = fakeClock()
  const paths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
  let planWrites = 0
  const io = {
    ...DEFAULT_HUB_IO,
    writePlan: async (hubPaths, plan) => {
      planWrites += 1
      return DEFAULT_HUB_IO.writePlan(hubPaths, plan)
    },
  }
  let releaseInstall = null
  let markStarted = null
  const started = new Promise((resolve) => {
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
  const host = installHost(scope, clock, transport, { prefix: 'life', targets: [mkTarget('a')] }, { hubIo: io })
  try {
    const pending = host.handlers['life.batchInstall']({})
    await started
    // 同一批次在装的时候又确认了一次（内容与盘上方案一致：同一属主/会话/目标/范围）。
    const second = await host.handlers['life.batchInstall']({})
    assert.equal(second.ok, true)
    assert.equal(planWrites, 1, '方案内容不变时不重复写盘（L101）')
    releaseInstall()
    const reply = await pending
    assert.equal(reply.ok, true)
    assert.ok(await readHubPlan(paths, 'life'), '方案仍在盘上，后来者可据此接手')
  } finally {
    releaseInstall?.()
    host.dispose()
    unbindAll()
  }
})

test('FIFO 公平：队头长期 queued 不饿死后来者', async () => {
  const { scope } = await mkScope('hub-single-fair-')
  const clock = fakeClock()
  let headAttempts = 0
  const headTransport = {
    check: async () => ({ kind: 'update', version: '2.0.0' }),
    install: async () => {
      headAttempts += 1
      return { kind: 'queued', position: 1 }
    },
  }
  const tailTransport = {
    check: async () => ({ kind: 'update', version: '2.0.0' }),
    install: async () => ({ kind: 'done', restartRequired: false }),
  }
  const hostHead = installHost(scope, clock, headTransport, { prefix: 'life', targets: [mkTarget('a')] })
  const hostTail = installHost(scope, clock, tailTransport, { prefix: 'other', targets: [mkTarget('b')] })
  try {
    const first = await hostHead.handlers['life.batchInstall']({})
    assert.equal(first.ok, true)
    assert.notEqual(phaseOf(first.session, 'a'), 'done', '队头一直被队列挡着，这次没推完')

    const second = await hostTail.handlers['other.batchInstall']({})
    assert.equal(second.ok, true)
    const done = await waitForPhase(clock, hostTail, 'other.batchStatus', 'b', 'done')
    assert.equal(phaseOf(done.session, 'b'), 'done', '后来者不被永久排在队头后面饿死')
    assert.ok(headAttempts >= 1)
  } finally {
    hostHead.dispose()
    hostTail.dispose()
    unbindAll()
  }
})

test('运行中取消：撤任务/撤方案/归还租约，旧代次不再写账本', async () => {
  const { scope } = await mkScope('hub-single-revoke-running-')
  const clock = fakeClock()
  const paths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
  let installs = 0
  let releaseInstall = null
  let markStarted = null
  const started = new Promise((resolve) => {
    markStarted = resolve
  })
  const transport = {
    check: async () => ({ kind: 'update', version: '2.0.0' }),
    install: async () => {
      installs += 1
      markStarted()
      await new Promise((resolve) => {
        releaseInstall = resolve
      })
      return { kind: 'done', restartRequired: false }
    },
  }
  const host = installHost(scope, clock, transport, { prefix: 'life', targets: [mkTarget('a')] })
  try {
    const pending = host.handlers['life.batchInstall']({})
    await started
    await revokeHubTask(scope, 'life')
    assert.equal(await readHubPlan(paths, 'life'), null, '取消时把方案一起撤掉')

    releaseInstall()
    const reply = await pending
    assert.equal(reply.ok, true)
    assert.notEqual(phaseOf(reply.session, 'a'), 'done', '取消后旧代次不许把完成写回账本')
    await clock.flush()
    assert.equal(await readHubLease(paths), null, '取消后归还驾驶位')

    // 再推进很久：不许有幽灵任务继续空转（安装只被调了那一次）。
    for (let i = 0; i < 5; i += 1) await clock.advance(500)
    assert.equal(installs, 1, '空转的幽灵任务不许再发起安装')
    assert.equal(await readHubPlan(paths, 'life'), null)
  } finally {
    releaseInstall?.()
    host.dispose()
    unbindAll()
  }
})

test('让位空档取消：排队任务被清掉，不留反复重试的幽灵任务', async () => {
  const { scope } = await mkScope('hub-single-revoke-queued-')
  const clock = fakeClock()
  const paths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
  let installs = 0
  const transport = {
    check: async () => ({ kind: 'update', version: '2.0.0' }),
    install: async () => {
      installs += 1
      return { kind: 'queued', position: 1 }
    },
  }
  const host = installHost(scope, clock, transport, { prefix: 'life', targets: [mkTarget('a')] })
  try {
    const first = await host.handlers['life.batchInstall']({})
    assert.equal(first.ok, true)
    assert.equal(installs, 1)

    await revokeHubTask(scope, 'life')
    for (let i = 0; i < 20; i += 1) await clock.advance(100)
    assert.equal(installs, 1, '取消后不许再有任务自动重试装这一家')
    assert.equal(await readHubPlan(paths, 'life'), null)
    assert.equal(await readHubLease(paths), null)
  } finally {
    host.dispose()
    unbindAll()
  }
})

test('activeInstall 身份：租约 pluginId 取方案自更新目标的插件身份（与 targets 匹配）', async () => {
  const { scope } = await mkScope('hub-single-active-install-')
  const clock = fakeClock()
  const paths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
  let leaseDuringInstall = null
  let activeInstallDuringInstall = null
  let hostRef = null
  const transport = {
    check: async () => ({ kind: 'update', version: '2.0.0' }),
    install: async () => {
      leaseDuringInstall = await readHubLease(paths)
      // US6 的对外一面：装的时候 updateHubStatus 必须把这一家报成 activeInstall，且身份是自更新目标的插件。
      const status = await hostRef.handlers['life.updateHubStatus']({})
      activeInstallDuringInstall = status?.snapshot?.activeInstall ?? null
      return { kind: 'done', restartRequired: false }
    },
  }
  const host = installHost(scope, clock, transport, {
    prefix: 'life',
    targets: [mkTarget('self'), mkTarget('a')],
    selfKey: 'self',
    selfOrder: 'first',
  })
  hostRef = host
  try {
    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true)
    assert.ok(leaseDuringInstall, '安装期间有驾驶位')
    assert.equal(leaseDuringInstall.pluginId, 'plugin-self', '租约记的是方案自更新目标的 pluginId，不是属主前缀')
    assert.ok(activeInstallDuringInstall, 'updateHubStatus 在装的时候报出 activeInstall')
    assert.equal(
      activeInstallDuringInstall.pluginId,
      'plugin-self',
      'activeInstall 的身份与租约一致（自更新目标插件），面板据此认「正在装谁」',
    )
  } finally {
    host.dispose()
    unbindAll()
  }
})

test('updateHubStatus.activeInstall 用注入的陈旧窗判定（与中枢同一口径，不读 20s 常量）', async () => {
  const { scope } = await mkScope('hub-single-active-stale-')
  const clock = fakeClock()
  const paths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
  const leaseWith = (heartbeatAt) => ({
    version: HUB_LEASE_VERSION,
    driverId: 'other-driver',
    pluginId: 'plugin-a',
    pid: 999999,
    generation: 1,
    startedAt: clock.now(),
    heartbeatAt,
  })
  // 新鲜租约：activeInstall 指到插件；超过注入的 1000ms 窗：按没人推处理。
  await writeLeaseEventually(paths, leaseWith(clock.now()))
  const host = installHost(
    scope,
    clock,
    {},
    { prefix: 'life', targets: [mkTarget('a')] },
    { hubLeaseStaleMs: 1000 },
  )
  try {
    const fresh = await host.handlers['life.updateHubStatus']({})
    assert.equal(fresh?.snapshot?.activeInstall?.pluginId, 'plugin-a', '新鲜租约报成正在装')
    await writeLeaseEventually(paths, leaseWith(clock.now() - 5000))
    const stale = await host.handlers['life.updateHubStatus']({})
    assert.equal(stale?.snapshot?.activeInstall, null, '心跳 5s 前、注入窗 1s：按没人推处理（不是按 20s 常量）')
  } finally {
    host.dispose()
    unbindAll()
  }
})
