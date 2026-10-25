/**
 * tests/issue-254-protocol-handoff.test.mjs —— #254 协议换代：保留并排空旧中枢任务，不静默丢任务表。
 *
 *  现实：DSH 的 HMR 会在同一个宿主进程里替换包版本（0.18.39 的 v1 中枢 → 新版的 v2 中枢）。
 * 两个版本的文件各是各的模块实例，但 globalThis 是共用的。换代时：
 *   1. 旧一代的任务表必须原样留给旧泵排空（旧等待者要拿到终态），新实例不许覆盖/清掉它；
 *   2. 新实例在旧泵还持着租约/还有未结算任务时只观察、不驱动同一步；
 *   3. 旧泵退出（任务结算、租约归还）后，新实例按盘上方案 + 账本接管未收尾会话，不丢任务。
 *
 * 只测外部可观察行为：电话回包、盘上相位/租约、假时钟推进、globalThis 里的旧槽（真旧代码的槽形状）。
 */
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { unlink } from 'node:fs/promises'
import { createMultiHostUpdate } from '../dist/host-batch.js'
import { createHubPlan } from '../dist/core/hub/plan.js'
import { createBatchSession, markBatchEntry } from '../dist/core/batch/model.js'
import { createBatchOwnerPorts } from '../dist/core/disk.js'
import { hash8 } from '../dist/shared/hash.js'
import { hubPathsForUpdate, writeHubPlan } from '../dist/host/hub/plan-store.js'
import { readHubLease, writeHubLease } from '../dist/host/hub/lease-store.js'
import { HUB_LEASE_STALE_MS, HUB_LEASE_VERSION } from '../dist/core/hub/lease-policy.js'
import { HUB_PROTOCOL_VERSION } from '../dist/host/hub/protocol.js'
import { primeUpdateEventTable } from '../dist/log/manifest.js'
import { __resetHubRegistryForTests, hubBusyForScope } from '../dist/host/hub/registry.js'
import { bind, collector, mkScope, mkTarget, phaseOf, rowsOf, unbindAll } from './helpers/batch-log-harness.mjs'
import { fakeClock, makeHubDeps, trackUnhandledRejections, waitForPhase } from './helpers/hub-harness.mjs'

const LEGACY_REGISTRY_KEY = Symbol.for('dsh-plugin-update:update-hub:registry')
const registryKeyFor = (version) => Symbol.for('dsh-plugin-update:update-hub:registry:v' + version)
const scopeKeyOf = (scope) => scope.homeDir + '\u0000' + scope.profileDir

const unhandled = trackUnhandledRejections()

beforeEach(() => {
  __resetHubRegistryForTests()
  delete globalThis[LEGACY_REGISTRY_KEY]
  primeUpdateEventTable()
})

after(async () => {
  await unhandled.settle()
  unhandled.stop()
  __resetHubRegistryForTests()
  delete globalThis[LEGACY_REGISTRY_KEY]
  assert.deepEqual(unhandled.seen, [], '换代/接管路径不得留下未处理 rejection（DSH 会据此退出进程）')
})

function legacyTask(overrides = {}) {
  return {
    id: 'legacy:life:s1',
    owner: 'life',
    seat: {},
    state: 'running',
    outcome: null,
    steps: [],
    idleSteps: 0,
    leaseFaults: 0,
    selection: null,
    waiters: [],
    ...overrides,
  }
}

/** 造一份「旧一代（v1）」的注册表槽：形状就是 0.18.39 代码写进 globalThis 的样子。 */
function installLegacyHubState(scope, tasks) {
  const slot = {
    key: scopeKeyOf(scope),
    homeDir: scope.homeDir,
    profileDir: scope.profileDir,
    paths: hubPathsForUpdate(scope.homeDir, scope.profileDir),
    driverId: 'legacy-driver',
    tasks,
    pumping: false,
    retryTimer: null,
    lease: null,
    deps: {},
  }
  const state = { version: 1, slots: new Map([[scopeKeyOf(scope), slot]]) }
  globalThis[LEGACY_REGISTRY_KEY] = state
  return { state, slot }
}

const updateTransport = () => {
  let installs = 0
  return {
    check: async () => ({ kind: 'update', version: '2.0.0' }),
    install: async () => {
      installs += 1
      return { kind: 'done', restartRequired: false }
    },
    get installCount() {
      return installs
    },
  }
}

test('换代保留：新实例不覆盖旧一代的注册表，旧任务表与等待者原样留给旧泵排空', async () => {
  const { scope } = await mkScope('hub254-keep-')
  const clock = fakeClock()
  const resolved = []
  const oldTask = legacyTask({ state: 'queued', waiters: [(outcome) => resolved.push(outcome)] })
  const { state, slot } = installLegacyHubState(scope, [oldTask])
  const oldTasks = slot.tasks
  const host = createMultiHostUpdate(makeHubDeps(scope, clock, updateTransport()), { hub: true, prefix: 'life', targets: [mkTarget('a')] })
  try {
    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true, '新实例自己的电话照常受理（任务排进本代队列）')

    // 旧一代的槽一个字节都不许动：同一对象、同一版本、同一任务数组、同一等待者。
    assert.equal(globalThis[LEGACY_REGISTRY_KEY], state, '不许替换旧一代的注册表对象')
    assert.equal(state.version, 1)
    assert.equal(slot.tasks, oldTasks)
    assert.deepEqual(oldTasks, [oldTask])
    assert.equal(oldTask.state, 'queued', '旧任务仍留给旧泵推进')
    assert.equal(typeof oldTask.waiters[0], 'function', '旧等待者原样保留（不能被新实例丢弃）')

    // 新实例的状态在版本限定的另一个槽里，两代各读写各的。
    const own = globalThis[registryKeyFor(HUB_PROTOCOL_VERSION)]
    assert.ok(own && own !== state, '新实例应使用版本限定的注册表槽')
    assert.equal(own.version, HUB_PROTOCOL_VERSION)

    // 旧泵排空：旧任务照常结算，等待者拿到终态（新实例没把它丢掉）。
    oldTask.state = 'settled'
    oldTask.outcome = 'done'
    for (const resolve of oldTask.waiters.splice(0)) resolve('done')
    assert.deepEqual(resolved, ['done'])
  } finally {
    host.dispose();
    unbindAll()
    delete globalThis[LEGACY_REGISTRY_KEY]
  }
})

test('旧泵持租约时只观察不驱动；旧泵退出后新实例按盘上方案与账本自动接管未收尾会话', async () => {
  const { scope } = await mkScope('hub254-handoff-')
  const clock = fakeClock()
  const paths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
  assert.ok(paths)

  // 盘上留一份未收尾的会话 + 旧一代写的方案（= HMR 前的真实起点）。
  const ownerPorts = createBatchOwnerPorts(scope.homeDir, scope.profileDir, 'life')
  let session = createBatchSession({ id: 'life-handoff-s1', keys: ['a'], now: 1000 })
  session = markBatchEntry(session, 'a', { phase: 'ready', targetVersion: '2.0.0' }, 1000).session
  await ownerPorts.writeBatch(session)
  await writeHubPlan(
    paths,
    createHubPlan({
      sessionId: session.id,
      owner: 'life',
      targets: [{ key: 'a', title: 'a', packageName: 'pkg-a', pluginId: 'plugin-a', prefix: 'p-a' }],
      scope: { homeDir: scope.homeDir, profileDir: scope.profileDir, profileName: 'web' },
      now: 1000,
    }),
  )

  // 旧一代：任务正在推进 + 盘上租约是本代旧泵持有（同进程 pid，心跳相对假时钟是新鲜的）。
  // 本用例先撞上的是「旧一代还忙」的观察闸；新鲜租约层面的仲裁另有用例（见下）。
  const oldTask = legacyTask({ state: 'running' })
  installLegacyHubState(scope, [oldTask])
  await writeHubLease(paths, {
    version: HUB_LEASE_VERSION,
    driverId: 'legacy-driver',
    pluginId: 'life',
    pid: process.pid,
    startedAt: 1_000_000,
    heartbeatAt: 1_000_000,
    generation: 1,
  })

  const transport = updateTransport()
  const host = createMultiHostUpdate(makeHubDeps(scope, clock, transport), { hub: true, prefix: 'life', targets: [mkTarget('a')] })
  try {
    // 旧泵还在：新实例只观察，一步都不驱动。
    await clock.flush()
    await clock.advance(50)
    assert.equal(transport.installCount, 0, '旧泵持租约时新实例不得驱动同一步')
    const during = await host.handlers['life.batchStatus']({})
    assert.equal(during.session.id, 'life-handoff-s1', '没有新开批次（盘上会话原样）')
    assert.equal(phaseOf(during.session, 'a'), 'ready', '账本不被旧一代忙时的接管改写')

    // 旧泵退出：任务结算、归还租约（旧代码正常收手后退出）。
    oldTask.state = 'settled'
    oldTask.outcome = 'done'
    delete globalThis[LEGACY_REGISTRY_KEY]
    await unlink(paths.leaseFile).catch(() => {})

    // 新实例退避后自己从方案 + 账本接管，把同一批推完——不需要任何电话触发。
    const done = await waitForPhase(clock, host, 'life.batchStatus', 'a', 'done')
    assert.equal(done.session.id, 'life-handoff-s1', '接管的仍是盘上那份未收尾会话')
    assert.equal(transport.installCount, 1, '同一行只装一次')
    // 收尾后的归还租约是泵退出 finally 里的异步 I/O，允许比「相位 done」晚一两个回合落定。
    let lease = await readHubLease(paths)
    for (let i = 0; i < 50 && lease !== null; i += 1) {
      await clock.flush()
      lease = await readHubLease(paths)
    }
    assert.equal(lease, null, '推完后本代租约已归还')
  } finally {
    host.dispose();
    unbindAll()
    delete globalThis[LEGACY_REGISTRY_KEY]
  }
})

test('旧一代还有未结算任务时中枢对外表现为忙（旁路让位），排空后恢复空闲', async () => {
  const { scope } = await mkScope('hub254-busy-')
  const task = legacyTask({ state: 'queued' })
  installLegacyHubState(scope, [task])
  try {
    assert.equal(hubBusyForScope(scope), true, '旧一代忙碌时 drain/自动续跑等旁路要让位')
    task.state = 'settled'
    task.outcome = 'done'
    assert.equal(hubBusyForScope(scope), false, '旧一代排空后不再挡本代')
  } finally {
    delete globalThis[LEGACY_REGISTRY_KEY]
  }
})

test('旧一代卡在未结算任务超过观察窗口时按租约仲裁接管（旧任务表仍原样）', async () => {
  const { scope } = await mkScope('hub254-stale-')
  const clock = fakeClock()
  const paths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
  assert.ok(paths)

  const ownerPorts = createBatchOwnerPorts(scope.homeDir, scope.profileDir, 'life')
  let session = createBatchSession({ id: 'life-stale-s1', keys: ['a'], now: 1000 })
  session = markBatchEntry(session, 'a', { phase: 'ready', targetVersion: '2.0.0' }, 1000).session
  await ownerPorts.writeBatch(session)
  await writeHubPlan(
    paths,
    createHubPlan({
      sessionId: session.id,
      owner: 'life',
      targets: [{ key: 'a', title: 'a', packageName: 'pkg-a', pluginId: 'plugin-a', prefix: 'p-a' }],
      scope: { homeDir: scope.homeDir, profileDir: scope.profileDir, profileName: 'web' },
      now: 1000,
    }),
  )

  // 旧一代表里有 running 任务，但盘上没有租约（旧泵已死/假死，没能正常收手）。
  const oldTask = legacyTask({ state: 'running' })
  const { state, slot } = installLegacyHubState(scope, [oldTask])
  const transport = updateTransport()
  const host = createMultiHostUpdate(makeHubDeps(scope, clock, transport), { hub: true, prefix: 'life', targets: [mkTarget('a')] })
  try {
    // 观察窗口内：仍然只观察，不驱动。先等到观察闸登记（接管是后台读盘后提交的任务，I/O 慢时可能
    // 比一次 flush 晚；窗口从「第一次看见旧一代忙」起算，测试必须等这个起点，否则推进时钟不会生效）。
    for (let i = 0; i < 100 && clock.pending() === 0; i += 1) await clock.flush()
    assert.ok(clock.pending() > 0, '观察闸应已登记退避重试')
    await clock.advance(Math.floor(HUB_LEASE_STALE_MS / 2))
    assert.equal(transport.installCount, 0, '观察窗口内不得接管')

    // 超过窗口：不再只观察，交给租约仲裁；盘上没有租约，本代接管。
    await clock.advance(HUB_LEASE_STALE_MS)
    const done = await waitForPhase(clock, host, 'life.batchStatus', 'a', 'done')
    assert.equal(transport.installCount, 1, '观察超时后由本代推完')

    // 旧一代的任务表一个字节都不动（旧任务只能由旧泵结算）。
    assert.equal(globalThis[LEGACY_REGISTRY_KEY], state)
    assert.equal(state.version, 1)
    assert.equal(slot.tasks[0], oldTask)
    assert.equal(oldTask.state, 'running')
  } finally {
    host.dispose();
    unbindAll()
    delete globalThis[LEGACY_REGISTRY_KEY]
  }
})

test('旧一代忙超观察窗但盘上租约仍新鲜时按租约让位，不双驱动同一步（ADR-0008 §1.1）', async () => {
  const { scope } = await mkScope('hub254-fresh-lease-')
  const clock = fakeClock()
  const paths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
  assert.ok(paths)

  const ownerPorts = createBatchOwnerPorts(scope.homeDir, scope.profileDir, 'life')
  let session = createBatchSession({ id: 'life-fresh-lease-s1', keys: ['a'], now: 1000 })
  session = markBatchEntry(session, 'a', { phase: 'ready', targetVersion: '2.0.0' }, 1000).session
  await ownerPorts.writeBatch(session)
  await writeHubPlan(
    paths,
    createHubPlan({
      sessionId: session.id,
      owner: 'life',
      targets: [{ key: 'a', title: 'a', packageName: 'pkg-a', pluginId: 'plugin-a', prefix: 'p-a' }],
      scope: { homeDir: scope.homeDir, profileDir: scope.profileDir, profileName: 'web' },
      now: 1000,
    }),
  )

  // 旧一代表里有 running 任务 + 盘上租约心跳按假时钟算仍然新鲜（旧泵真的还活着，只是单步很长）。
  // 观察窗到点只是「不再只观察」，不能绕过租约仲裁：仲裁说别家新鲜持租 → 本代继续让位。
  const oldTask = legacyTask({ state: 'running' })
  installLegacyHubState(scope, [oldTask])
  await writeHubLease(paths, {
    version: HUB_LEASE_VERSION,
    driverId: 'legacy-driver',
    pluginId: 'life',
    pid: process.pid,
    startedAt: 1_000_000,
    heartbeatAt: 1_000_000 + HUB_LEASE_STALE_MS,
    generation: 1,
  })

  const transport = updateTransport()
  const host = createMultiHostUpdate(makeHubDeps(scope, clock, transport), { hub: true, prefix: 'life', targets: [mkTarget('a')] })
  try {
    for (let i = 0; i < 100 && clock.pending() === 0; i += 1) await clock.flush()
    assert.ok(clock.pending() > 0, '观察闸应已登记退避重试')
    // 刚过观察窗：仲裁读到别家心跳只在 10ms 前 → 让位。
    await clock.advance(HUB_LEASE_STALE_MS + 10)
    // 再推 10s：心跳仍在新陈窗口内 → 继续让位，一步都不驱动。
    await clock.advance(10_000)
    assert.equal(transport.installCount, 0, '旧租约新鲜时本代不得驱动同一步')
    assert.equal(phaseOf((await host.handlers['life.batchStatus']({})).session, 'a'), 'ready', '账本原样')
  } finally {
    host.dispose(); unbindAll()
    delete globalThis[LEGACY_REGISTRY_KEY]
  }
})

test('旧一代忙时先只读装席位；真正开推前补做续跑落盘（run.start 记 resume）', async () => {
  const { scope } = await mkScope('hub254-takeover-')
  const clock = fakeClock()
  const paths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
  assert.ok(paths)

  // 盘上：一批死在安装步（旧泵没来得及收尾），这是换代后新实例能拿到的全部事实。
  const ownerPorts = createBatchOwnerPorts(scope.homeDir, scope.profileDir, 'life')
  let session = createBatchSession({ id: 'life-takeover-s1', keys: ['a'], now: 1000 })
  session = markBatchEntry(session, 'a', { phase: 'installing', targetVersion: '2.0.0' }, 1000).session
  await ownerPorts.writeBatch(session)
  await writeHubPlan(
    paths,
    createHubPlan({
      sessionId: session.id,
      owner: 'life',
      targets: [{ key: 'a', title: 'a', packageName: 'pkg-a', pluginId: 'plugin-a', prefix: 'p-a' }],
      scope: { homeDir: scope.homeDir, profileDir: scope.profileDir, profileName: 'web' },
      now: 1000,
    }),
  )
  const oldTask = legacyTask({ state: 'running' })
  installLegacyHubState(scope, [oldTask])

  const transport = updateTransport()
  const host = createMultiHostUpdate(makeHubDeps(scope, clock, transport), {
    hub: true,
    prefix: 'life',
    targets: [mkTarget('a'), mkTarget('self')],
    selfKey: 'self',
  })
  // 落点在构造之后再绑：构造期目标自己的日志接线也已登记到同一张路由表，先绑会被盖掉。
  const owner = collector()
  bind('plugin-self', owner.sink)
  try {
    for (let i = 0; i < 100 && clock.pending() === 0; i += 1) await clock.flush()
    assert.ok(clock.pending() > 0, '观察闸应已登记退避重试')
    // 观察窗内：只读装席位——不写账本、不清队列、不记本代的开始行。
    await clock.advance(Math.floor(HUB_LEASE_STALE_MS / 2))
    assert.equal(transport.installCount, 0, '旧一代还活着时一步都不驱动')
    assert.equal(rowsOf(owner, 'update.batch.run.start').length, 0, '旧一代还活着：不许先记本代的开始行')
    assert.equal(
      phaseOf((await host.handlers['life.batchStatus']({})).session, 'a'),
      'installing',
      '中断相位原样留给旧泵',
    )

    // 旧一代迟迟不结算：超观察窗、盘上无租约 → 本代接管；开推前补做「接手续跑」的落盘。
    await clock.advance(HUB_LEASE_STALE_MS)
    const done = await waitForPhase(clock, host, 'life.batchStatus', 'a', 'done')
    assert.equal(phaseOf(done.session, 'a'), 'done')
    assert.equal(transport.installCount, 1, '同一行只装一次')
    const starts = rowsOf(owner, 'update.batch.run.start')
    assert.equal(starts.length, 1, '接管时补一条本代推进开始行（装载时旧一代还忙，没提前写）')
    assert.equal(starts[0].fields.trigger, 'resume')
    assert.equal(starts[0].fields.resumed, true)
    assert.equal(starts[0].fields.sessionHash, hash8(session.id))
    // 总账也按「接手续跑」口径：durationMs 从 takeOver 记的起点算，不回落成会话年龄（#216）。
    let summary = rowsOf(owner, 'update.batch.summary')
    for (let i = 0; i < 50 && summary.length === 0; i += 1) {
      await clock.flush()
      summary = rowsOf(owner, 'update.batch.summary')
    }
    assert.equal(summary.length, 1, '接管推进收尾时补一条总账')
    assert.equal(summary[0].fields.resumed, true)
    assert.ok(
      summary[0].fields.durationMs < summary[0].fields.sessionAgeMs,
      'durationMs 是本次推进活跃时长，不回落成会话年龄',
    )
  } finally {
    host.dispose(); unbindAll()
    delete globalThis[LEGACY_REGISTRY_KEY]
  }
})

test('旧一代只剩已结算任务时不阻塞：新实例照常受理、推进自家的更新', async () => {
  const { scope } = await mkScope('hub254-idle-')
  const clock = fakeClock()
  const settledTask = legacyTask({ state: 'settled', outcome: 'done' })
  const { state, slot } = installLegacyHubState(scope, [settledTask])
  const host = createMultiHostUpdate(makeHubDeps(scope, clock, updateTransport()), { hub: true, prefix: 'life', targets: [mkTarget('a')] })
  try {
    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true)
    const done = await waitForPhase(clock, host, 'life.batchStatus', 'a', 'done')
    assert.equal(phaseOf(done.session, 'a'), 'done')
    assert.equal(globalThis[LEGACY_REGISTRY_KEY], state, '旧槽仍原样保留（已结算任务也不清）')
    assert.deepEqual(slot.tasks, [settledTask])
  } finally {
    host.dispose();
    unbindAll()
    delete globalThis[LEGACY_REGISTRY_KEY]
  }
})
