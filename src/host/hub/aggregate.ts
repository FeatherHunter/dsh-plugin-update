// src/host/hub/aggregate.ts —— 只读全局进度聚合器（spec #246 / 票 #250）。
//
// 第一性：全局进度的真相在磁盘上——方案（hub/plans/<owner>.json）、批量账本
//   （<queue.directory>/<owner>/batch.json）、检查知识（inventory.json）、驾驶位租约
//   （hub/lease.json）。任意活着的集成方只要读得到这个使用范围，就能答全局进度；
//   中枢在不在、面板开没开都不影响答案。
//
// 纪律：
//   - 只读：不写方案、不碰租约、不驱动任何东西。
//   - 逐家独立读，坏文件当缺失（一个坏账本不许让整通电话失败）。
//   - 快照由 core/hub/snapshot.ts 的纯函数投影（上限/排序/状态都在那儿，本文件只管读盘）。

import {
  BATCH_FILE_MAX_BYTES,
  INVENTORY_FILE_MAX_BYTES,
  batchPathsForOwner,
  normalizeBatchInventory,
  type BatchInventory,
} from '../../core/disk.js'
import { normalizeBatchSession, type BatchSession } from '../../core/batch/model.js'
import { HUB_LEASE_STALE_MS, type HubLease } from '../../core/hub/lease-policy.js'
import type { HubPlan } from '../../core/hub/plan.js'
import {
  emptyHubSnapshot,
  projectHubSnapshot,
  type HubActiveInstallSnapshot,
  type HubSessionSource,
  type HubSnapshot,
  type HubSnapshotLimits,
} from '../../core/hub/snapshot.js'
import { hubPathsForUpdate, readHubPlans } from './plan-store.js'
import { readHubLease } from './lease-store.js'
import { readJsonFile } from './json-file.js'

/** 聚合所需的最小使用范围（与中枢槽键同一形状）。 */
export interface HubStatusScope {
  homeDir: string
  profileDir: string | null
}

export interface ReadHubStatusOptions {
  /** 生成时刻（纯读取，不读钟）。 */
  at: number
  limits?: HubSnapshotLimits
}

/**
 * 读一遍这个使用范围的全部进度，投影成 HubSnapshot。
 * 永不抛：没有方案/坏账本/读不到租约都按「缺失」处理。
 */
export async function readHubStatus(scope: HubStatusScope, options: ReadHubStatusOptions): Promise<HubSnapshot> {
  const at = Number.isFinite(options.at) ? options.at : 0
  if (!scope || typeof scope.homeDir !== 'string' || !scope.profileDir) return emptyHubSnapshot(at)
  const hubPaths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
  if (!hubPaths) return emptyHubSnapshot(at)
  try {
    const plans = await readHubPlans(hubPaths)
    const sources: HubSessionSource[] = []
    for (const plan of plans) {
      sources.push(await readOwnerSource(scope, plan.owner, plan))
    }
    const lease = await readHubLease(hubPaths)
    return projectHubSnapshot({
      at,
      sources,
      activeInstall: activeInstallOf(lease, at),
      ...(options.limits ? { limits: options.limits } : {}),
    })
  } catch {
    return emptyHubSnapshot(at)
  }
}

/** 一个属主的来源：方案 + 账本 + 检查知识；坏文件按缺失处理。 */
async function readOwnerSource(scope: HubStatusScope, owner: string, plan: HubPlan): Promise<HubSessionSource> {
  const paths = batchPathsForOwner(scope.homeDir, scope.profileDir as string, owner)
  if (!paths) return { plan, session: null, inventory: null }
  const [session, inventory] = await Promise.all([readBatch(paths.batchFile), readInventory(paths.inventoryFile)])
  const installed: Record<string, string | null> = {}
  for (const [key, entry] of Object.entries(inventory?.entries ?? {})) {
    installed[key] = entry.installedVersion ?? null
  }
  return { plan, session, inventory, installed }
}

async function readBatch(file: string): Promise<BatchSession | null> {
  const raw = await readJsonFile(file, BATCH_FILE_MAX_BYTES)
  return normalizeBatchSession(raw)
}

async function readInventory(file: string): Promise<BatchInventory | null> {
  const raw = await readJsonFile(file, INVENTORY_FILE_MAX_BYTES)
  return normalizeBatchInventory(raw)
}

/** 租约活着才算「正在装」；陈旧租约按「没人推」处理（回收是中枢的活，这里不越权）。 */
function activeInstallOf(lease: HubLease | null | undefined, at: number): HubActiveInstallSnapshot | null {
  if (!lease) return null
  if (!(at - lease.heartbeatAt <= HUB_LEASE_STALE_MS)) return null
  return { pluginId: lease.pluginId, startedAt: lease.startedAt }
}
