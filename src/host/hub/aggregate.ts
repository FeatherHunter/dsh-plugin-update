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
import { readdir } from 'node:fs/promises'
import { queuePathsForUpdate } from '../../core/queue/ports.js'
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
  /** 使用范围目录（调用方已解析；只读聚合不接受「没有范围」的请求）。 */
  profileDir: string
}

export interface ReadHubStatusOptions {
  /** 生成时刻（纯读取，不读钟）。 */
  at: number
  limits?: HubSnapshotLimits
}

/**
 * 读一遍这个使用范围的全部进度，投影成 HubSnapshot。
 * 永不抛：没有方案/坏账本/读不到租约都按「缺失」处理。
 *
 * 真相分两层：方案是索引（认领过的批次），账本是事实（旧版本 / hub:false 留下的批次没有方案）。
 * 所以先按方案收，再把队列目录里没方案、但有批次的属主补进来——「从盘上读」才不会漏掉回退线批次。
 */
export async function readHubStatus(scope: HubStatusScope, options: ReadHubStatusOptions): Promise<HubSnapshot> {
  const at = Number.isFinite(options.at) ? options.at : 0
  if (!scope || typeof scope.homeDir !== 'string' || !scope.profileDir) return emptyHubSnapshot(at)
  const hubPaths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
  if (!hubPaths) return emptyHubSnapshot(at)
  try {
    const plans = await readHubPlans(hubPaths)
    const sources: HubSessionSource[] = []
    const claimedOwners = new Set<string>()
    for (const plan of plans) {
      claimedOwners.add(plan.owner)
      sources.push(await readOwnerSource(scope, plan.owner, plan))
    }
    for (const owner of await listLedgerOwners(scope, claimedOwners)) {
      const source = await readOwnerSource(scope, owner, null)
      if (source.session) sources.push(source)
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

/**
 * 队列目录下「有账本、但没有方案」的属主目录（旧版本 / hub:false 的批次）。
 * 只认能通过 owner 校验且 batch.json 读得出来的目录；读目录失败按「没有」处理。
 */
async function listLedgerOwners(scope: HubStatusScope, skip: ReadonlySet<string>): Promise<string[]> {
  const queuePaths = queuePathsForUpdate(scope.homeDir, scope.profileDir)
  if (!queuePaths) return []
  let names: string[]
  try {
    names = await readdir(queuePaths.directory)
  } catch {
    return []
  }
  const owners: string[] = []
  for (const name of names) {
    if (skip.has(name) || name === 'hub') continue
    const paths = batchPathsForOwner(scope.homeDir, scope.profileDir, name)
    if (!paths) continue
    owners.push(name)
  }
  return owners
}

/** 一个属主的来源：方案 + 账本 + 检查知识；坏文件按缺失处理。方案可缺（旧批次）。 */
async function readOwnerSource(scope: HubStatusScope, owner: string, plan: HubPlan | null): Promise<HubSessionSource> {
  const paths = batchPathsForOwner(scope.homeDir, scope.profileDir, owner)
  if (!paths) return { plan, owner, session: null, inventory: null }
  const [session, inventory] = await Promise.all([readBatch(paths.batchFile), readInventory(paths.inventoryFile)])
  const installed: Record<string, string | null> = {}
  for (const [key, entry] of Object.entries(inventory?.entries ?? {})) {
    installed[key] = entry.installedVersion ?? null
  }
  return plan ? { plan, session, inventory, installed } : { owner, sessionId: session?.id ?? null, session, inventory, installed }
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
