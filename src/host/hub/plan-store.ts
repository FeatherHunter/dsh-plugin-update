// src/host/hub/plan-store.ts —— 方案落盘：把「装什么、装到哪」写成任一处都能读回的交接凭证。
//
// 第一性：盘是跨 fiber / 跨进程唯一共享的真相。方案文件的位置由现有队列目录派生
// （同一 (家目录, 使用范围目录) 的全部插件共用 `<queue.directory>/hub/`），
// 不新造第二套指纹，也不碰 batch.json 的归属（属主仍是批量前缀，ADR-0003）。
//
// 纪律：读坏当没写过（自愈）；写失败返回 false、绝不抛——方案写不进去只影响「别人接手」，
// 不影响本次在本进程里推进（ADR-0008 §3：写失败不挡安装）。

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { HUB_PLANS_DIR_SEGMENT, hubPlanFileName, normalizeHubPlan, type HubPlan } from '../../core/hub/plan.js'
import { queuePathsForUpdate } from '../../core/queue/ports.js'
import { readJsonFile, writeJsonFileAtomic } from './json-file.js'

/** 中枢目录名（与安装域 `update-queue` 并列在同一个指纹目录下）。 */
export const HUB_DIR_SEGMENT = 'hub'

/** 租约文件名（独占驾驶位的那份文件，见 lease-store）。 */
export const HUB_LEASE_FILE = 'lease.json'

/** 单份方案的上限：目标清单再长也到不了 1 MiB（与 batch.json 同一预算）。 */
export const HUB_PLAN_FILE_MAX_BYTES = 1024 * 1024

/** 一个使用范围的中枢路径三件套。 */
export interface HubPaths {
  /** `<queue.directory>/hub/` */
  directory: string
  /** `<directory>/plans/` */
  plansDir: string
  /** `<directory>/lease.json` */
  leaseFile: string
}

/** 由 (家目录, 使用范围目录) 派生中枢路径；算不出（无 profileDir）即 null。 */
export function hubPathsForUpdate(homeDir: string, profileDir: string): HubPaths | null {
  const queue = queuePathsForUpdate(homeDir, profileDir)
  if (!queue) return null
  const directory = join(queue.directory, HUB_DIR_SEGMENT)
  return { directory, plansDir: join(directory, HUB_PLANS_DIR_SEGMENT), leaseFile: join(directory, HUB_LEASE_FILE) }
}

/** 读一份属主方案；不存在/坏值/属主不合法一律 null。 */
export async function readHubPlan(paths: HubPaths, owner: unknown): Promise<HubPlan | null> {
  const name = hubPlanFileName(owner)
  if (!name) return null
  const raw = await readJsonFile(join(paths.plansDir, name), HUB_PLAN_FILE_MAX_BYTES)
  return normalizeHubPlan(raw)
}

/** 列出这个使用范围下的全部合法方案（坏文件跳过；按文件名稳定排序）。 */
export async function readHubPlans(paths: HubPaths): Promise<HubPlan[]> {
  let names: string[]
  try {
    names = await readdir(paths.plansDir)
  } catch {
    return []
  }
  const plans: HubPlan[] = []
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue
    const raw = await readJsonFile(join(paths.plansDir, name), HUB_PLAN_FILE_MAX_BYTES)
    const plan = normalizeHubPlan(raw)
    if (plan) plans.push(plan)
  }
  return plans
}

/** 写一份属主方案（原子整写）；写失败返回 false，从不抛。 */
export async function writeHubPlan(paths: HubPaths, plan: HubPlan | null | undefined): Promise<boolean> {
  const name = hubPlanFileName(plan?.owner)
  if (!name || !plan) return false
  try {
    await writeJsonFileAtomic(join(paths.plansDir, name), plan)
    return true
  } catch {
    return false
  }
}
