// tests/hub-lease-store.test.mjs —— #276 P0：驾驶位租约必须是真 CAS（比较后写）+ 按代次释放。
//
// 只看可观察的文件事实（盘上租约是什么、谁写的、第几代），不测内部锁实现：
//   1. 独占创建：盘上没有才成功，已有就失败（两个进程同抢只有一个能上任）；
//   2. 带预期写入：预期不符（盘上不是那一代）一个字都不写；
//   3. 并发 CAS：同一预期下两个写者只有一个成功（后到者读到的已经不是预期代次）；
//   4. 释放只认自己这一代：旧代次释放不得删掉新代次的驾驶位；
//   5. 不残留临界区目录（lease.lock）——否则下一次写入/释放会被陈旧锁挡 2 秒。

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHubLease } from '../dist/core/hub/lease-policy.js'
import { hubPathsForUpdate } from '../dist/host/hub/plan-store.js'
import {
  createHubLeaseFile,
  readHubLease,
  releaseHubLease,
  writeHubLease,
} from '../dist/host/hub/lease-store.js'

let scope

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hub-lease-store-'))
  scope = { homeDir: dir, profileDir: dir }
})

function leaseOf(driverId, generation) {
  return createHubLease({ driverId, pluginId: 'plugin-a', pid: process.pid, now: 1_000, generation })
}

test('独占创建：盘上没有才成功，已有就失败（两个同抢者只有一个上任）', async () => {
  const paths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
  assert.equal(await createHubLeaseFile(paths, leaseOf('driver-a', 1)), true)
  assert.equal(await createHubLeaseFile(paths, leaseOf('driver-b', 1)), false, '已有租约时独占创建必须失败')
  const current = await readHubLease(paths)
  assert.equal(current.driverId, 'driver-a')
  assert.equal(current.generation, 1)
})

test('带预期写入：预期是「没有租约」但盘上已有 → 不写', async () => {
  const paths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
  assert.equal(await createHubLeaseFile(paths, leaseOf('driver-a', 1)), true)
  const wrote = await writeHubLease(paths, leaseOf('driver-b', 1), { kind: 'absent' })
  assert.equal(wrote, false)
  assert.equal((await readHubLease(paths)).driverId, 'driver-a', '预期不符时一个字都不写')
})

test('带预期写入：代次不符 → 不写；代次相符 → 整写替换并读回确认', async () => {
  const paths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
  assert.equal(await createHubLeaseFile(paths, leaseOf('driver-a', 1)), true)

  const mismatch = await writeHubLease(paths, leaseOf('driver-b', 2), { kind: 'owner', driverId: 'driver-a', generation: 2 })
  assert.equal(mismatch, false, '盘上还是第 1 代，按第 2 代预期写必须失败')

  const renewed = { ...leaseOf('driver-b', 2), heartbeatAt: 5_000 }
  const write = await writeHubLease(paths, renewed, { kind: 'owner', driverId: 'driver-a', generation: 1 })
  assert.equal(write, true)
  const current = await readHubLease(paths)
  assert.equal(current.driverId, 'driver-b')
  assert.equal(current.generation, 2)
  assert.equal(current.heartbeatAt, 5_000)
})

test('并发 CAS：同一预期下两个写者只有一个成功（后到者看到的已不是预期代次）', async () => {
  const paths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
  assert.equal(await createHubLeaseFile(paths, leaseOf('base-driver', 1)), true)

  const a = { ...leaseOf('driver-a', 2), heartbeatAt: 2_000 }
  const b = { ...leaseOf('driver-b', 2), heartbeatAt: 2_000 }
  const results = await Promise.all([
    writeHubLease(paths, a, { kind: 'owner', driverId: 'base-driver', generation: 1 }),
    writeHubLease(paths, b, { kind: 'owner', driverId: 'base-driver', generation: 1 }),
  ])
  assert.equal(results.filter(Boolean).length, 1, '同一代次预期只允许一个写者成功')
  const current = await readHubLease(paths)
  assert.equal(current.generation, 2)
  assert.ok(['driver-a', 'driver-b'].includes(current.driverId))
})

test('释放只认自己这一代：旧代次不得删掉新驾驶位的租约', async () => {
  const paths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
  assert.equal(await createHubLeaseFile(paths, leaseOf('driver-a', 1)), true)
  assert.equal(await writeHubLease(paths, leaseOf('driver-b', 2), { kind: 'owner', driverId: 'driver-a', generation: 1 }), true)

  await releaseHubLease(paths, 'driver-a', 1)
  assert.equal((await readHubLease(paths)).driverId, 'driver-b', '旧代次释放不得删别人的驾驶位')

  await releaseHubLease(paths, 'driver-b', 2)
  assert.equal(await readHubLease(paths), null, '自己的代次才释放得掉')
})

test('不残留临界区目录（lease.lock）：下一次写入/释放不被陈旧锁挡', async () => {
  const paths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
  assert.equal(await createHubLeaseFile(paths, leaseOf('driver-a', 1)), true)
  assert.equal(await writeHubLease(paths, { ...leaseOf('driver-a', 1), heartbeatAt: 2_000 }, { kind: 'owner', driverId: 'driver-a', generation: 1 }), true)
  await releaseHubLease(paths, 'driver-a', 1)
  assert.equal(await readHubLease(paths), null)

  const names = await readdir(paths.directory)
  assert.equal(names.includes('lease.lock'), false, '临界区目录必须被清掉，否则下一次写入会被陈旧锁挡住')
  await rm(paths.directory, { recursive: true, force: true })
})
