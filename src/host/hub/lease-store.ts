// src/host/hub/lease-store.ts —— 驾驶位租约落盘：同一使用范围同一时刻只有一个推进者。
//
// 第一性：双驱动比「暂时没人推」危险得多（两边各写一份 batch.json，进度互相覆盖）。
// 所以租约只认盘上那一份：读不懂 → 当没有；写不进 → 本次不硬推；不是我的代次 → 一个字都不动。
//
// #276 起租约写入是真 CAS（比较后写）而不是「读 → 无条件整写」：
//   - 拿驾驶位：目标不存在才发布（createJsonFileExclusive / 硬链接原子发布）；
//   - 续任/接管/心跳：先核对盘上还是不是「我预期的那一代」，是才整写替换；
//   - 所有「读 → 判 → 写」都放在同一把目录锁里（lease.lock，mkdir 独占），
//     跨进程同抢时只有一个能进临界区，另一个按「这次没抢到」如实返回 false。
// 锁本身也可能因进程崩溃而残留：超过 HUB_LEASE_LOCK_STALE_MS 的锁视为陈旧、清掉重抢（只影响抢锁延迟，
// 不影响正确性——临界区里仍会重读、重判）。
//
// 纪律：本文件只做「读/写（带预期）/独占创建/按属主释放」几件事，判决在 core/hub/lease-policy.ts
// （纯函数，可单测）。

import { readFileSync, unlinkSync } from 'node:fs'
import { mkdir, rm, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isHubLeaseOwner, normalizeHubLease, type HubLease } from '../../core/hub/lease-policy.js'
import { createJsonFileExclusive, readJsonFile, writeJsonFileAtomic } from './json-file.js'
import type { HubPaths } from './plan-store.js'

/** 单份租约的上限：一个最小事实对象，64 KiB 已是奢侈。 */
export const HUB_LEASE_FILE_MAX_BYTES = 64 * 1024

/** 租约更新临界区目录名（与 lease.json 同目录；mkdir 成功即拿到锁）。 */
const HUB_LEASE_LOCK_DIR = 'lease.lock'

/** 临界区目录超过这个年龄按「上一个持有者崩了」清掉重抢。 */
export const HUB_LEASE_LOCK_STALE_MS = 2_000

/** 抢锁最多等多久：跨进程的某一次争用通常是毫秒级；等不到就如实回「这次没抢到」。 */
const HUB_LEASE_LOCK_WAIT_MS = 500

/** 释放临界区目录：Windows 上偶发 EBUSY/EPERM（杀毒/索引/句柄还没放），重试几次比留个假锁强。 */
async function removeLockDir(lockDir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(lockDir, { recursive: true, force: true })
      return
    } catch {
      await sleep(5)
    }
  }
}

/**
 * 一次带预期的租约写入（CAS）：
 *   - absent：盘上必须没有租约（拿一代驾驶位）；
 *   - owner ：盘上必须是这一代（续任 / 心跳 / 按代次接管）。
 */
export type HubLeaseExpectation =
  | { kind: 'absent' }
  | { kind: 'owner'; driverId: string; generation: number }

function lockDirOf(paths: HubPaths): string {
  return join(dirname(paths.leaseFile), HUB_LEASE_LOCK_DIR)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 在临界区里做一次「读 → 判 → 写」：拿不到锁返回 null（调用方按「这次没写进去」处理）。 */
async function withLeaseLock<T>(paths: HubPaths, body: () => Promise<T>): Promise<T | null> {
  const directory = dirname(paths.leaseFile)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const lockDir = lockDirOf(paths)
  const deadline = Date.now() + HUB_LEASE_LOCK_WAIT_MS
  for (;;) {
    try {
      await mkdir(lockDir)
      break
    } catch (error) {
      if ((error as { code?: string } | null)?.code !== 'EEXIST') throw error
      // 陈旧锁：上一个持有者在临界区里崩了。清掉重抢；清不掉（别人也刚好在清）就继续等。
      try {
        const info = await stat(lockDir)
        if (Date.now() - info.mtimeMs > HUB_LEASE_LOCK_STALE_MS) {
          await removeLockDir(lockDir)
          continue
        }
      } catch {}
      if (Date.now() >= deadline) return null
      await sleep(5)
    }
  }
  try {
    return await body()
  } finally {
    await removeLockDir(lockDir)
  }
}

function expectationMatches(current: HubLease | null, expected: HubLeaseExpectation): boolean {
  if (expected.kind === 'absent') return current === null
  return isHubLeaseOwner(current, expected.driverId, expected.generation)
}

/** 读盘上租约；坏值/不存在 → null（自愈，不抛）。 */
export async function readHubLease(paths: HubPaths): Promise<HubLease | null> {
  return normalizeHubLease(await readJsonFile(paths.leaseFile, HUB_LEASE_FILE_MAX_BYTES))
}

/**
 * 写租约。不带 expected 就是无条件原子整写（只给「模拟外部写入/夹具」用；中枢自己的写一律带预期）。
 * 带 expected 时是一次真 CAS：在临界区里重读、核对预期、整写、再读回确认属主与心跳，
 * 成功 true；预期不符/没抢到锁/读回不属主一律 false（调用方会重读决定让位还是单飞）。
 * 从未抛异常（降级口径与 #253 一致）。
 */
export async function writeHubLease(
  paths: HubPaths,
  lease: HubLease,
  expected?: HubLeaseExpectation,
): Promise<boolean> {
  try {
    if (!expected) {
      // 夹具/外部模拟写入也必须走同一把锁：否则「占用者刚读完、写之前」可能被塞进一份新代次，
      // 随后的整写会把别人的驾驶位盖掉（换代栅栏就漏了）。所有写入串行化，读-判-写才成立。
      const result = await withLeaseLock(paths, async () => {
        await writeJsonFileAtomic(paths.leaseFile, lease)
        return true
      })
      return result === true
    }
    const result = await withLeaseLock(paths, async () => {
      const current = await readHubLease(paths)
      if (!expectationMatches(current, expected)) return false
      await writeJsonFileAtomic(paths.leaseFile, lease)
      const confirmed = await readHubLease(paths)
      return (
        isHubLeaseOwner(confirmed, lease.driverId, lease.generation) &&
        confirmed?.heartbeatAt === lease.heartbeatAt &&
        confirmed?.startedAt === lease.startedAt
      )
    })
    return result === true
  } catch {
    return false
  }
}

/**
 * 拿一代新驾驶位：只有盘上还没有租约时才发布（原子独占创建）。
 * true=这一代归我；false=已有租约（可能是别家刚写的，也可能是自己写失败），调用方重读再判。
 */
export async function createHubLeaseFile(paths: HubPaths, lease: HubLease): Promise<boolean> {
  try {
    return await createJsonFileExclusive(paths.leaseFile, lease)
  } catch {
    return false
  }
}

/** 只释放「我这一代」的租约：代次不符说明已被接管，绝不能删别人的驾驶位。 */
export async function releaseHubLease(paths: HubPaths, driverId: string, generation: number): Promise<void> {
  try {
    await withLeaseLock(paths, async () => {
      const current = await readHubLease(paths)
      if (!isHubLeaseOwner(current, driverId, generation)) return
      await unlink(paths.leaseFile)
    })
  } catch {
    // 释放失败只多留一份过期租约（下一个驱动者会按心跳判失联），不影响推进。
  }
}

/**
 * 同步版释放：只给「进程退出」用（Node 的 exit 事件里只能跑同步代码，见 registry 的退出钩子）。
 * 同一口径：只删「我这一代」；读不到/坏值/不是我的代次一律不动；永不抛。
 */
export function releaseHubLeaseSync(paths: HubPaths, driverId: string, generation: number): void {
  try {
    const text = readFileSync(paths.leaseFile, 'utf8')
    // 与异步读同一份预算：超限当读不到（exit 阶段不值得为一个坏文件做异常处理分支）。
    if (text.length === 0 || text.length > HUB_LEASE_FILE_MAX_BYTES) return
    const current = normalizeHubLease(JSON.parse(text) as unknown)
    if (!isHubLeaseOwner(current, driverId, generation)) return
    unlinkSync(paths.leaseFile)
  } catch {
    // 退出阶段尽力而为：删不掉只是多留一份过期租约，下一次启动按死进程/陈旧窗口接管。
  }
}