// tests/hub-status.test.mjs —— #250 只读全局进度电话（updateHubStatus）验收。
//
// 验收口径（票 #250）：
//   1. 单插件宿主与批量宿主都注册；同一使用范围里的多个属主都能聚到一份快照里；
//   2. 电话是只读的：调它不改盘上任何账本；
//   3. 坏账本按「记录缺失」如实上报，绝不抛；
//   4. 租约活着才报 activeInstall，陈旧租约不报；
//   5. hub:false 的接入方照常登记并从盘上答（回退线也看得见旧批次）；
//   6. 不返回跨使用范围数据。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMultiHostUpdate } from '../dist/host-batch.js'
import { createHostUpdate } from '../dist/host.js'
import { batchPathsForOwner } from '../dist/core/disk.js'
import { hubPathsForUpdate, readHubPlans } from '../dist/host/hub/plan-store.js'
import { readHubLease } from '../dist/host/hub/lease-store.js'
import { HUB_LEASE_VERSION } from '../dist/core/hub/lease-policy.js'

const FIXED_NOW = 1_700_000_000_000

function fakeClock(start = FIXED_NOW) {
  return {
    now: () => start,
    timers: { setTimeout: () => 0, clearTimeout: () => {} },
  }
}

async function mkScope() {
  const homeDir = await mkdtemp(join(tmpdir(), 'hub-status-home-'))
  const profileDir = await mkdtemp(join(tmpdir(), 'hub-status-profile-'))
  return { homeDir, profileDir }
}

function mkTarget(key) {
  return { key, title: key.toUpperCase(), packageName: `pkg-${key}`, prefix: `phone-${key}` }
}

function depsFor(scope, clock, id = 'hub-status-id') {
  return {
    scope,
    now: clock.now,
    timers: clock.timers,
    randomId: () => id,
    hub: true,
    transport: transports,
  }
}

const transports = {
  check: async () => ({ kind: 'update', version: '2.0.0' }),
  install: async () => ({ kind: 'done', restartRequired: false }),
}

async function runBatch(prefix, targets, scope, clock) {
  const host = createMultiHostUpdate(depsFor(scope, clock, `id-${prefix}`), {
    prefix,
    targets,
    selfKey: targets[0].key,
    hub: true,
  })
  const reply = await host.handlers[`${prefix}.batchInstall`]({})
  assert.equal(reply.ok, true, `${prefix} 的批量安装应成功`)
  return host
}

test('多属主聚合：同一使用范围里两个批次的进度出现在同一份快照', async () => {
  const scope = await mkScope()
  const clock = fakeClock()
  try {
    const life = await runBatch('life', [mkTarget('life-a'), mkTarget('life-b')], scope, clock)
    const tool = await runBatch('tool', [mkTarget('tool-a')], scope, clock)

    const reply = await life.handlers['life.updateHubStatus']({})
    assert.equal(reply.ok, true)
    const snapshot = reply.snapshot
    assert.equal(snapshot.version, 1)
    assert.equal(snapshot.at, FIXED_NOW)
    const owners = snapshot.sessions.map((session) => session.owner).sort()
    assert.deepEqual(owners, ['life', 'tool'])
    const lifeSession = snapshot.sessions.find((session) => session.owner === 'life')
    assert.equal(lifeSession.state, 'finished')
    assert.equal(lifeSession.progress.total, 2)
    assert.deepEqual(
      lifeSession.rows.map((row) => row.key).sort(),
      ['life-a', 'life-b'],
    )
    assert.ok(
      lifeSession.rows.every((row) => row.phase === 'done' || row.phase === 'current'),
      'life 两行都应进终态（current 是装了待重启的终态）',
    )
    assert.equal(lifeSession.rowsTruncated, false)
    assert.equal(lifeSession.rowsTotal, 2)
    // tool 是别家属主，但对 life 的电话同样可见——全局进度的意义就在这。
    const toolSession = snapshot.sessions.find((session) => session.owner === 'tool')
    assert.equal(toolSession.state, 'finished')
    // 另一个属主的电话看到的是同一份全局视图。
    const reply2 = await tool.handlers['tool.updateHubStatus']({})
    assert.deepEqual(
      reply2.snapshot.sessions.map((session) => session.owner).sort(),
      ['life', 'tool'],
    )
  } finally {
    await rm(scope.homeDir, { recursive: true, force: true })
    await rm(scope.profileDir, { recursive: true, force: true })
  }
})

test('只读：调电话不改盘上账本', async () => {
  const scope = await mkScope()
  const clock = fakeClock()
  try {
    const life = await runBatch('life', [mkTarget('life-a')], scope, clock)
    const paths = batchPathsForOwner(scope.homeDir, scope.profileDir, 'life')
    const before = await readFile(paths.batchFile, 'utf8')
    await life.handlers['life.updateHubStatus']({})
    await life.handlers['life.updateHubStatus']({})
    const after = await readFile(paths.batchFile, 'utf8')
    assert.equal(after, before, 'updateHubStatus 必须只读')
  } finally {
    await rm(scope.homeDir, { recursive: true, force: true })
    await rm(scope.profileDir, { recursive: true, force: true })
  }
})

test('坏账本自愈：账本坏了照实报 missing，电话不抛', async () => {
  const scope = await mkScope()
  const clock = fakeClock()
  try {
    const life = await runBatch('life', [mkTarget('life-a')], scope, clock)
    const tool = await runBatch('tool', [mkTarget('tool-a')], scope, clock)
    void tool
    const paths = batchPathsForOwner(scope.homeDir, scope.profileDir, 'life')
    await writeFile(paths.batchFile, '{not json', 'utf8')

    const reply = await life.handlers['life.updateHubStatus']({})
    assert.equal(reply.ok, true)
    const session = reply.snapshot.sessions.find((item) => item.owner === 'life')
    assert.equal(session.state, 'missing', '方案还在、账本坏了 → 记录缺失')
    // 账本读不出时，行从方案的目标清单回退成 pending（知道该装什么，不知道装到哪）。
    assert.equal(session.rows.length, 1)
    assert.equal(session.rows[0].key, 'life-a')
    assert.equal(session.rows[0].phase, 'pending')
  } finally {
    await rm(scope.homeDir, { recursive: true, force: true })
    await rm(scope.profileDir, { recursive: true, force: true })
  }
})

test('activeInstall：租约活着才报，陈旧租约不报', async () => {
  const scope = await mkScope()
  const clock = fakeClock()
  try {
    const life = await runBatch('life', [mkTarget('life-a')], scope, clock)
    const hubPaths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
    const writeLease = (heartbeatAt) =>
      writeFile(
        hubPaths.leaseFile,
        JSON.stringify({
          version: HUB_LEASE_VERSION,
          driverId: 'someone-else',
          pluginId: 'life',
          pid: process.pid,
          startedAt: heartbeatAt,
          heartbeatAt,
          generation: 1,
        }),
        'utf8',
      )

    await writeLease(FIXED_NOW)
    const fresh = await life.handlers['life.updateHubStatus']({})
    assert.deepEqual(fresh.snapshot.activeInstall, { pluginId: 'life', startedAt: FIXED_NOW })

    await writeLease(FIXED_NOW - 60_000)
    const stale = await life.handlers['life.updateHubStatus']({})
    assert.equal(stale.snapshot.activeInstall, null, '陈旧租约不算「正在装」')
  } finally {
    await rm(scope.homeDir, { recursive: true, force: true })
    await rm(scope.profileDir, { recursive: true, force: true })
  }
})

test('回退线：hub:false 照常登记，并从盘上答（旧批次无方案也看得见）', async () => {
  const scope = await mkScope()
  const clock = fakeClock()
  try {
    const host = createMultiHostUpdate(
      { scope, now: clock.now, timers: clock.timers, randomId: () => 'legacy-id', transport: transports },
      { prefix: 'legacy', targets: [mkTarget('legacy-a')], hub: false },
    )
    assert.equal(host.phoneNames.hubStatus, 'legacy.updateHubStatus', 'hub:false 也要登记这通只读电话')
    assert.equal(typeof host.handlers['legacy.updateHubStatus'], 'function')

    const installed = await host.handlers['legacy.batchInstall']({})
    assert.equal(installed.ok, true)
    const reply = await host.handlers['legacy.updateHubStatus']({})
    assert.equal(reply.ok, true)
    assert.deepEqual(
      reply.snapshot.sessions.map((session) => session.owner),
      ['legacy'],
      '没有中枢方案的旧批次，也要能从盘上账本聚合出来',
    )
    // 中枢没启用：不写方案/租约（回退线干净）。
    const paths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
    assert.deepEqual(await readHubPlans(paths), [])
    assert.equal(await readHubLease(paths), null)
  } finally {
    await rm(scope.homeDir, { recursive: true, force: true })
    await rm(scope.profileDir, { recursive: true, force: true })
  }
})

test('单插件宿主也登记 hubStatus，并看到别家属主的批次（两套前缀都能答）', async () => {
  const scope = await mkScope()
  const clock = fakeClock()
  try {
    await runBatch('life', [mkTarget('life-a')], scope, clock)
    const single = createHostUpdate(
      {
        readerOverrides: {
          homeDir: scope.homeDir,
          profileDir: scope.profileDir,
          env: process.env,
        },
      },
      { pluginId: 'hub-status-single', prefix: 'demo', targetPackageName: 'dsh-plugin-update' },
    )
    assert.equal(single.hubStatus, 'demo.updateHubStatus', '单插件宿主必须也有这通电话')
    const reply = await single.handlers['demo.updateHubStatus']({})
    assert.equal(reply.ok, true)
    assert.deepEqual(
      reply.snapshot.sessions.map((session) => session.owner),
      ['life'],
      '单插件宿主读到的是同一使用范围的全局视图',
    )
  } finally {
    await rm(scope.homeDir, { recursive: true, force: true })
    await rm(scope.profileDir, { recursive: true, force: true })
  }
})

test('不返回跨使用范围数据', async () => {
  const scopeA = await mkScope()
  const scopeB = await mkScope()
  const clock = fakeClock()
  try {
    await runBatch('life', [mkTarget('life-a')], scopeA, clock)
    const other = createMultiHostUpdate(depsFor(scopeB, clock, 'scope-b-id'), {
      prefix: 'other',
      targets: [mkTarget('other-a')],
    })
    const reply = await other.handlers['other.updateHubStatus']({})
    assert.equal(reply.ok, true)
    assert.deepEqual(reply.snapshot.sessions, [], '别的使用范围的会话不得出现在快照里')
  } finally {
    await rm(scopeA.homeDir, { recursive: true, force: true })
    await rm(scopeA.profileDir, { recursive: true, force: true })
    await rm(scopeB.homeDir, { recursive: true, force: true })
    await rm(scopeB.profileDir, { recursive: true, force: true })
  }
})
