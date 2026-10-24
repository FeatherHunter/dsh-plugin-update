// tests/hub-status.test.mjs —— #250 只读全局进度电话（updateHubStatus）验收。
//
// 验收口径（票 #250）：
//   1. 同一使用范围里的多个属主都能聚到一份快照里（谁都能答全局进度）；
//   2. 电话是只读的：调它不改盘上任何账本；
//   3. 坏账本按「记录缺失」如实上报，绝不抛；
//   4. 租约活着才报 activeInstall，陈旧租约不报；
//   5. hub:false 的接入方**不登记**这个电话（回退线干净）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMultiHostUpdate } from '../dist/host-batch.js'
import { batchPathsForOwner } from '../dist/core/disk.js'
import { hubPathsForUpdate } from '../dist/host/hub/plan-store.js'
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

test('回退线：hub:false 不登记 updateHubStatus', async () => {
  const scope = await mkScope()
  const clock = fakeClock()
  try {
    const host = createMultiHostUpdate(
      { scope, now: clock.now, timers: clock.timers, randomId: () => 'legacy-id' },
      { prefix: 'legacy', targets: [mkTarget('legacy-a')], hub: false },
    )
    assert.equal(host.phoneNames.hubStatus, undefined)
    assert.equal(host.handlers['legacy.updateHubStatus'], undefined)
  } finally {
    await rm(scope.homeDir, { recursive: true, force: true })
    await rm(scope.profileDir, { recursive: true, force: true })
  }
})
