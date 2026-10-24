// src/core/hub/plan.ts —— 更新中枢的「方案」：一份可被任一存活集成方接手的持久任务书。
//
// 第一性：批量更新是「持久会话 + 单步执行」的循环。会话与进度已经在 batch.json 里（ADR-0003），
//   但「目标清单 + 使用范围身份 + 从哪查源」只活在发起它的插件 fiber 里。fiber 一销毁，
//   这些信息就没了——盘上的 batch.json 还在，却没人知道该怎么继续。方案就是把这几个问题
//   在开跑之前先写下来：装什么、装到哪、从哪个源查。
//
// 归属：本文件零 Node/浏览器专属能力、无副作用，宿主与面板两侧都能 import；
//   落盘由 host/hub/plan-store.ts 负责（与 core/batch/model.ts 同一分工）。
//
// 边界（ADR-0008 §3）：
//   - 方案只写意图，不写进度；进度唯一真相仍是各属主 batch.json。
//   - 方案按属主命名（属主即批量前缀，ADR-0003），同一属主同时只有一份方案。
//   - 坏方案自愈：读不出来当没写过，绝不挡安装（与队列同一纪律）。

import type { BatchSelfOrder } from '../batch/model.js'

/** 方案格式版本：收到别的数字按「没有方案」处理，不抛错。 */
export const HUB_PLAN_VERSION = 1

/** 方案在 hub 目录下的子目录名（自解释：这里只放 plans）。 */
export const HUB_PLANS_DIR_SEGMENT = 'plans'

/** 一个目标在方案里的身份：够通用席位把「查」与「装」重新装配起来。 */
export interface HubTargetSpec {
  /** 目标稳定键（与会话里的行一一对应）。 */
  key: string
  /** 展示名（人话）。 */
  title: string
  /** npm 包名（查新版用）。 */
  packageName: string
  /** 更新系统里的插件标识（状态文件/日志归属用）。 */
  pluginId: string
  /** 电话前缀（每目标一套单插件电话）。 */
  prefix: string
  /** 可选的每目标使用范围覆盖（批量目标允许各自 homeDir/profileDir）。 */
  homeDir?: string
  profileDir?: string
}

/** 使用范围身份：把执行器需要的环境信息一起带上。 */
export interface HubScopeRef {
  homeDir: string
  profileDir: string
  profileName: string
  /** 'desktop' | 'cli' | ...（宿主环境种类，决定安装出口）。 */
  environmentKind?: string
  releaseChannel?: string
  /** npm 源（查新版与安装共用；不填走默认源）。 */
  registryUrl?: string
}

/**
 * 一份方案（落盘形状）。字段刻意只留「重建执行」必需的信息：
 * 会话编号（认领进度）、属主（认领 batch.json）、排序意图（重开会话时口径一致）、
 * 目标清单（通用席位）、使用范围（执行器）、源（查新版）。
 */
export interface HubPlan {
  version: 1
  /** 对应的批量会话编号（与 batch.json 的 id 比对，不匹配说明会话已换新）。 */
  sessionId: string
  /** 属主 = 批量前缀（ADR-0003；batch.json 落在同一目录下）。 */
  owner: string
  /** 「自己」的键（只作日志归属；排序由 selfOrder 决定）。 */
  selfKey: string | null
  /** 排序意图：'first' 是爱生活的既有要求（#219），中枢不改语义。 */
  selfOrder: BatchSelfOrder
  /** 一家失败后是否停下（默认 false：继续下一家）。 */
  stopOnFailure: boolean
  /** 目标清单（顺序不承载语义；执行顺序以会话 order 为准）。 */
  targets: HubTargetSpec[]
  scope: HubScopeRef
  createdAt: number
  updatedAt: number
}

/** 属主命名规则与 batchPathsForOwner 保持一致（目录安全 + 上限 64）。 */
export function isSafeHubOwner(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 64 && /^[A-Za-z0-9_-]+$/.test(value)
}

/** 方案文件名：`<属主>.json`（属主本身已过安全字符集，无需再哈希）。 */
export function hubPlanFileName(owner: unknown): string | null {
  return isSafeHubOwner(owner) ? owner + '.json' : null
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function asMillisOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function normalizeTarget(raw: unknown): HubTargetSpec | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const input = raw as Record<string, unknown>
  const key = input['key']
  const packageName = input['packageName']
  const pluginId = input['pluginId']
  const prefix = input['prefix']
  if (!isNonEmptyText(key) || !isNonEmptyText(packageName) || !isNonEmptyText(pluginId) || !isNonEmptyText(prefix)) return null
  const spec: HubTargetSpec = {
    key,
    title: isNonEmptyText(input['title']) ? input['title'] : key,
    packageName,
    pluginId,
    prefix,
  }
  if (isNonEmptyText(input['homeDir'])) spec.homeDir = input['homeDir']
  if (isNonEmptyText(input['profileDir'])) spec.profileDir = input['profileDir']
  return spec
}

function isSafeRelativeAbsoluteText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
}

/** 把外面读到的值验成可用方案：错了回 null（调用方按「没有方案」处理）。 */
export function normalizeHubPlan(raw: unknown): HubPlan | null {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const input = raw as Record<string, unknown>
    if (input['version'] !== HUB_PLAN_VERSION) return null
    const sessionId = input['sessionId']
    const owner = input['owner']
    if (!isNonEmptyText(sessionId) || !isSafeHubOwner(owner)) return null
    const scopeRaw = input['scope']
    if (!scopeRaw || typeof scopeRaw !== 'object' || Array.isArray(scopeRaw)) return null
    const scopeInput = scopeRaw as Record<string, unknown>
    const homeDir = scopeInput['homeDir']
    const profileDir = scopeInput['profileDir']
    const profileName = scopeInput['profileName']
    if (!isSafeRelativeAbsoluteText(homeDir) || !isSafeRelativeAbsoluteText(profileDir) || !isNonEmptyText(profileName)) return null
    const targets: HubTargetSpec[] = []
    const seen = new Set<string>()
    if (Array.isArray(input['targets'])) {
      for (const item of input['targets'] as unknown[]) {
        const spec = normalizeTarget(item)
        if (!spec || seen.has(spec.key)) continue
        seen.add(spec.key)
        targets.push(spec)
      }
    }
    if (targets.length === 0) return null
    const selfKeyRaw = input['selfKey']
    const selfKey = isNonEmptyText(selfKeyRaw) && seen.has(selfKeyRaw) ? selfKeyRaw : null
    const selfOrder: BatchSelfOrder = input['selfOrder'] === 'first' ? 'first' : 'last'
    const scope: HubScopeRef = { homeDir, profileDir, profileName }
    if (isNonEmptyText(scopeInput['environmentKind'])) scope.environmentKind = scopeInput['environmentKind']
    if (isNonEmptyText(scopeInput['releaseChannel'])) scope.releaseChannel = scopeInput['releaseChannel']
    if (isNonEmptyText(scopeInput['registryUrl'])) scope.registryUrl = scopeInput['registryUrl']
    const createdAt = asMillisOrZero(input['createdAt'])
    return {
      version: HUB_PLAN_VERSION as 1,
      sessionId,
      owner,
      selfKey,
      selfOrder,
      stopOnFailure: input['stopOnFailure'] === true,
      targets,
      scope,
      createdAt,
      updatedAt: asMillisOrZero(input['updatedAt']) || createdAt,
    }
  } catch {
    return null
  }
}

/** 开一份方案：调用方给会话编号、属主、目标清单与使用范围。 */
export function createHubPlan(args: {
  sessionId: string
  owner: string
  targets: readonly HubTargetSpec[]
  scope: HubScopeRef
  selfKey?: string | null
  selfOrder?: BatchSelfOrder
  stopOnFailure?: boolean
  now: number
}): HubPlan {
  const targets = args.targets
    .filter((spec) => isNonEmptyText(spec.key) && isNonEmptyText(spec.packageName) && isNonEmptyText(spec.pluginId) && isNonEmptyText(spec.prefix))
    .map((spec) => ({ ...spec, title: spec.title || spec.key }))
  const selfKey = isNonEmptyText(args.selfKey) ? args.selfKey : null
  const now = asMillisOrZero(args.now)
  return {
    version: HUB_PLAN_VERSION as 1,
    sessionId: isNonEmptyText(args.sessionId) ? args.sessionId : 'batch',
    owner: args.owner,
    selfKey,
    selfOrder: args.selfOrder === 'first' ? 'first' : 'last',
    stopOnFailure: args.stopOnFailure === true,
    targets,
    scope: { ...args.scope },
    createdAt: now,
    updatedAt: now,
  }
}

function sameTarget(a: HubTargetSpec, b: HubTargetSpec): boolean {
  return (
    a.key === b.key &&
    a.title === b.title &&
    a.packageName === b.packageName &&
    a.pluginId === b.pluginId &&
    a.prefix === b.prefix &&
    a.homeDir === b.homeDir &&
    a.profileDir === b.profileDir
  )
}

function sameScope(a: HubScopeRef, b: HubScopeRef): boolean {
  return (
    a.homeDir === b.homeDir &&
    a.profileDir === b.profileDir &&
    a.profileName === b.profileName &&
    a.environmentKind === b.environmentKind &&
    a.releaseChannel === b.releaseChannel &&
    a.registryUrl === b.registryUrl
  )
}

/**
 * 两份方案是否「同一份工作」：会话编号、属主、排序意图、目标清单、使用范围全一致才算。
 * 用来避免每次安装都重写方案文件（写盘是原子整写，但没必要抖）。
 */
export function sameHubPlan(a: HubPlan | null, b: HubPlan | null): boolean {
  if (!a || !b) return a === b
  if (a.version !== b.version || a.sessionId !== b.sessionId || a.owner !== b.owner) return false
  if (a.selfKey !== b.selfKey || a.selfOrder !== b.selfOrder || a.stopOnFailure !== b.stopOnFailure) return false
  if (a.targets.length !== b.targets.length) return false
  for (let index = 0; index < a.targets.length; index += 1) {
    if (!sameTarget(a.targets[index], b.targets[index])) return false
  }
  return sameScope(a.scope, b.scope)
}

/** 按目标键取方案里的目标身份（通用席位装配用）。 */
export function planTargetOf(plan: HubPlan, key: string): HubTargetSpec | null {
  return plan.targets.find((spec) => spec.key === key) ?? null
}
