// src/host/hub/lease-store.ts —— 驾驶位租约落盘：同一使用范围同一时刻只有一个推进者。
//
// 第一性：双驱动比「暂时没人推」危险得多（两边各写一份 batch.json，进度互相覆盖）。
// 所以租约只认盘上那一份：读不懂 → 当没有；写不进 → 本次不硬推；不是我的代次 → 一个字都不动。
//
// 纪律：本文件只做「读/写/按属主释放」三件事，判决在 core/hub/lease-policy.ts（纯函数，可单测）。

import { unlink } from 'node:fs/promises'
import { isHubLeaseOwner, normalizeHubLease, type HubLease } from '../../core/hub/lease-policy.js'
import { readJsonFile, writeJsonFileAtomic } from './json-file.js'
import type { HubPaths } from './plan-store.js'

/** 单份租约的上限：一个最小事实对象，64 KiB 已是奢侈。 */
export const HUB_LEASE_FILE_MAX_BYTES = 64 * 1024

/** 读盘上租约；坏值/不存在 → null（自愈，不抛）。 */
export async function readHubLease(paths: HubPaths): Promise<HubLease | null> {
  return normalizeHubLease(await readJsonFile(paths.leaseFile, HUB_LEASE_FILE_MAX_BYTES))
}

/** 写租约（原子整写）；失败返回 false，从不抛。 */
export async function writeHubLease(paths: HubPaths, lease: HubLease): Promise<boolean> {
  try {
    await writeJsonFileAtomic(paths.leaseFile, lease)
    return true
  } catch {
    return false
  }
}

/** 只释放「我这一代」的租约：代次不符说明已被接管，绝不能删别人的驾驶位。 */
export async function releaseHubLease(paths: HubPaths, driverId: string, generation: number): Promise<void> {
  try {
    const current = await readHubLease(paths)
    if (!isHubLeaseOwner(current, driverId, generation)) return
    await unlink(paths.leaseFile)
  } catch {
    // 释放失败只多留一份过期租约（下一个驱动者会按心跳判失联），不影响推进。
  }
}
