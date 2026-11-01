/**
 * tests/batch-hub-seat.test.mjs —— 中枢执行席的边界（#276）。
 *
 * 两件事必须可观察：
 *   1. 中枢席位查一家后，知识账本（inventory）要有这一家的检查结论——
 *      宿主侧不再跑两段式预查，知识写入必须跟着席位走（否则面板永远看不到「查过」）。
 *   2. 中枢路径不再有「预查整批失败」这道闸：查传输抛错只让那一行 failed（error=unknown），
 *      整批不被判失败、装阶段也不会拿着没查成的行去装。
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createMultiHostUpdate } from '../dist/host-batch.js'
import { createBatchOwnerPorts } from '../dist/core/disk.js'
import { createBatchSession } from '../dist/core/batch/model.js'
import { createHubPlan } from '../dist/core/hub/plan.js'
import { hubPathsForUpdate, writeHubPlan } from '../dist/host/hub/plan-store.js'
import { __resetHubRegistryForTests } from '../dist/host/hub/registry.js'
import { mkScope, mkTarget, phaseOf, unbindAll } from './helpers/batch-log-harness.mjs'
import { fakeClock, makeHubDeps, waitForPhase } from './helpers/hub-harness.mjs'

beforeEach(() => {
  __resetHubRegistryForTests()
})

/** 盘上预置一份「提交到一半、执行方消失」的批次：账本 + 方案都在，没人推。 */
async function seedOrphanBatch(scope, sessionId) {
  const ownerPorts = createBatchOwnerPorts(scope.homeDir, scope.profileDir, 'life')
  const session = createBatchSession({ id: sessionId, keys: ['a'], now: 1000 })
  await ownerPorts.writeBatch(session)
  const paths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
  assert.ok(paths, '测试范围能算出中枢路径')
  await writeHubPlan(
    paths,
    createHubPlan({
      sessionId,
      owner: 'life',
      targets: [mkTarget('a')],
      scope: { homeDir: scope.homeDir, profileDir: scope.profileDir, profileName: 'web' },
      now: 1000,
    }),
  )
  return { ownerPorts, paths }
}

test('中枢席位查一家：check 结论写进知识账本', async () => {
  const { scope } = await mkScope('batch-hub-seat-knowledge-')
  const clock = fakeClock()
  const { ownerPorts } = await seedOrphanBatch(scope, 'batch-hub-seat-knowledge')
  const transport = {
    check: async () => ({ kind: 'update', version: '2.0.0' }),
    install: async () => ({ kind: 'done', restartRequired: false }),
  }
  const host = createMultiHostUpdate(makeHubDeps(scope, clock, transport), {
    hub: true,
    prefix: 'life',
    targets: [mkTarget('a')],
  })
  try {
    const done = await waitForPhase(clock, host, 'life.batchStatus', 'a', 'done')
    assert.equal(done.ok, true)
    const inventory = await ownerPorts.readInventory()
    const row = inventory.entries['a']
    assert.ok(row, '查过的家要在知识账本里有一行（席位自己写，不靠宿主侧预查）')
    assert.equal(typeof row.lastCheckedAt, 'number', '知识行盖了检查时刻')
    assert.ok(row.lastCheckedAt >= 1_000_000 && row.lastCheckedAt <= clock.now(), '检查时刻落在这次推进的时间窗里')
    assert.equal(row.latestVersion, '2.0.0', '知识行记录了查到的目标版本')
  } finally {
    host.dispose()
    unbindAll()
  }
})

test('中枢路径不跑两段式预查：查传输抛错只把该行落 failed，整批不判失败', async () => {
  const { scope } = await mkScope('batch-hub-seat-check-throw-')
  const clock = fakeClock()
  let checkCalls = 0
  let installCalls = 0
  const transport = {
    check: async () => {
      checkCalls += 1
      throw new Error('boom secret')
    },
    install: async () => {
      installCalls += 1
      return { kind: 'done', restartRequired: false }
    },
  }
  const host = createMultiHostUpdate(makeHubDeps(scope, clock, transport), {
    hub: true,
    prefix: 'life',
    targets: [mkTarget('a')],
  })
  try {
    const reply = await host.handlers['life.batchInstall']({})
    assert.equal(reply.ok, true, '异常被收进这一行：整批不再回 ok:false')
    assert.equal(phaseOf(reply.session, 'a'), 'failed', '查失败那家如实落 failed')
    const entry = reply.session.entries.find((one) => one.key === 'a')
    assert.equal(entry.error, 'unknown', '异常 message 不外泄，折成稳定码 unknown')
    assert.equal(installCalls, 0, '没查成就不装')
    assert.ok(checkCalls >= 1, '这一行确实被查过（由中枢驱动，不是宿主预查闸拦下）')
    // 知识账本也要记下这次失败（否则面板把「查失败」当没查过）。
    const ownerPorts = createBatchOwnerPorts(scope.homeDir, scope.profileDir, 'life')
    const inventory = await ownerPorts.readInventory()
    assert.ok(inventory.entries['a'], '查失败也要留知识行')
    assert.equal(inventory.entries['a'].error, 'check-failed', '知识行记稳定码（与 checkPhone 同一口径）')
    assert.ok(!JSON.stringify(inventory.entries['a']).includes('boom secret'), '异常原文不进知识账本')
  } finally {
    host.dispose()
    unbindAll()
  }
})
