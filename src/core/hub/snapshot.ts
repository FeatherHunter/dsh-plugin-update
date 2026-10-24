// src/core/hub/snapshot.ts —— 更新中枢的只读全局快照：把盘上的「方案 + 批量账本 + 检查知识」
//   投影成任意集成方都能渲染的进度视图。
//
// 第一性：全局进度的真相在磁盘上，不在某个插件的内存里。谁都能读盘，谁就都能答全局进度；
//   快照是纯函数——输入已经读好的数据，输出快照，不碰 IO、不依赖中枢在不在。
//
// 纪律：
//   - 坏输入按「缺失」处理，永不抛（一个坏账本不许让整通电话失败）。
//   - 只投影会话状态与行，不替你决定「要不要装」。
//   - 有上限：会话数与每会话行数封顶，回包不随盘上历史无限膨胀。
//
// 归属：本文件零 Node/浏览器专属能力、无副作用，宿主与面板两侧都能 import；
//   盘怎么读由调用方（host/hub 的只读聚合器）负责，与 core/batch/model.ts 同一分工。

import type { BatchInventoryEntry, BatchInventory } from '../disk.js'
import type { BatchPhase, BatchSession } from '../batch/model.js'
import { batchEntryOf, batchProgress, isBatchFinished } from '../batch/model.js'
import type { HubPlan } from './plan.js'
import { normalizeHubPlan } from './plan.js'

/** 快照格式版本：收到别的数字按「读不懂」处理（调用方回空快照即可）。 */
export const HUB_SNAPSHOT_VERSION = 1

/** 一份快照最多带几个会话（再多就截断，并在 sessionsTruncated 里说实话）。 */
export const HUB_SNAPSHOT_MAX_SESSIONS = 8

/** 每个会话最多带几行（目标多的批次截断，避免回包无限大）。 */
export const HUB_SNAPSHOT_MAX_ROWS_PER_SESSION = 20

/** 会话在全局视图里的状态。 */
export type HubSessionState =
  /** 有人正在推进（有行在查/在装，或队列里正在装的是它家的目标）。 */
  | 'running'
  /** 还有没轮到的行，但当前没人推进。 */
  | 'waiting'
  /** 每一行都进了终态（失败也算收尾）。 */
  | 'finished'
  /** 有方案，但账本读不出来或会话编号对不上（不知道进度，但知道有过这轮）。 */
  | 'missing'

/** 全局视图里的一行（一个更新目标）。 */
export interface HubRowSnapshot {
  /** 目标稳定键（与批量账本的行一一对应）。 */
  key: string
  /** 展示名（人话）。 */
  title: string
  /** 批量账本里的相位。 */
  phase: BatchPhase
  /** 远端目标版本（查过才有）。 */
  targetVersion: string | null
  /** 当前盘上已装版本（读不到就是 null，不猜）。 */
  installedVersion: string | null
  /** 检查知识里记的最新版本（没有知识时退回目标版本）。 */
  latestVersion: string | null
  /** 装完后是否要重启宿主才生效。 */
  restartRequired: boolean
  /** 失败稳定码（成功恒为 null）。 */
  error: string | null
}

/** 会话进度读数（与批量账本 batchProgress 同口径）。 */
export interface HubProgressSnapshot {
  total: number
  done: number
  failed: number
  skipped: number
  current: number
  pending: number
  finished: boolean
}

/** 一个会话在全局视图里的样子。 */
export interface HubSessionSnapshot {
  sessionId: string
  /** 属主 = 批量前缀（ADR-0003）；没有方案的旧账本允许为空串。 */
  owner: string
  /** 「自己」的键（只作展示与日志归属）。 */
  selfKey: string | null
  state: HubSessionState
  updatedAt: number
  progress: HubProgressSnapshot
  rows: HubRowSnapshot[]
  /** 截断前的行数（如实告知被截了多少）。 */
  rowsTotal: number
  rowsTruncated: boolean
}

/** 「现在正有一个安装在进行」——给全局视图显示谁在装（可为空）。 */
export interface HubActiveInstallSnapshot {
  /** 正在安装的拥有者插件标识。 */
  pluginId: string
  startedAt: number
}

/** 一通 updateHubStatus 回的快照。 */
export interface HubSnapshot {
  version: typeof HUB_SNAPSHOT_VERSION
  /** 生成时刻（调用方给，纯函数不读钟）。 */
  at: number
  sessions: HubSessionSnapshot[]
  /** 截断前的会话数。 */
  sessionsTotal: number
  sessionsTruncated: boolean
  activeInstall: HubActiveInstallSnapshot | null
}

/**
 * 一个会话的原始来源：方案、账本、检查知识、盘上已装版本。
 * 旧版本留下的「无方案账本」也能投影（session + owner 就够），只是缺 title/selfKey。
 */
export interface HubSessionSource {
  plan?: HubPlan | null
  /** 方案缺失时的会话编号回退（旧账本用它）。 */
  sessionId?: string | null
  /** 方案缺失时的属主回退（旧账本用它）。 */
  owner?: string | null
  session?: BatchSession | null
  inventory?: BatchInventory | null
  /** 目标键 → 盘上已装版本（宿主读单品状态得到）；读不到不填。 */
  installed?: Readonly<Record<string, string | null>> | null
}

/** 快照上限（调用方可调小；超过内部上限按内部上限算）。 */
export interface HubSnapshotLimits {
  maxSessions?: number
  maxRowsPerSession?: number
}

export interface HubSnapshotInput {
  at: number
  sources: readonly HubSessionSource[]
  activeInstall?: HubActiveInstallSnapshot | null
  limits?: HubSnapshotLimits
}

/** 空快照：没有方案/没有账本时如实回「什么都没有」，不是错误。 */
export function emptyHubSnapshot(at: number): HubSnapshot {
  return {
    version: HUB_SNAPSHOT_VERSION,
    at: asMillisOrZero(at),
    sessions: [],
    sessionsTotal: 0,
    sessionsTruncated: false,
    activeInstall: null,
  }
}

/**
 * 投影全局快照：坏来源逐条跳过，整体永不抛。
 * 排序：进行中 → 等待 → 记录缺失 → 已收尾；同状态内按更新时间新到旧，再按会话编号稳定排序。
 */
export function projectHubSnapshot(input: HubSnapshotInput): HubSnapshot {
  const at = isRecord(input) ? asMillisOrZero(input['at']) : 0
  try {
    if (!isRecord(input)) return emptyHubSnapshot(0)
    const limits = normalizeLimits(input['limits'])
    const activeInstall = normalizeActiveInstall(input['activeInstall'])
    const rawSources = input['sources']
    const sources: readonly unknown[] = Array.isArray(rawSources) ? rawSources : []
    const byId = new Map<string, HubSessionSnapshot>()
    for (const source of sources) {
      try {
        if (!isRecord(source)) continue
        const snapshot = projectSource(source as HubSessionSource, activeInstall, limits.maxRowsPerSession)
        if (!snapshot) continue
        const existing = byId.get(snapshot.sessionId)
        if (!existing || preferSnapshot(snapshot, existing)) byId.set(snapshot.sessionId, snapshot)
      } catch {
        continue
      }
    }
    const ordered = [...byId.values()].sort(compareSessions)
    const sessionsTotal = ordered.length
    const sessions = ordered.slice(0, limits.maxSessions)
    return {
      version: HUB_SNAPSHOT_VERSION,
      at,
      sessions,
      sessionsTotal,
      sessionsTruncated: sessionsTotal > sessions.length,
      activeInstall,
    }
  } catch {
    return emptyHubSnapshot(at)
  }
}

/** 快照里还有没做完的会话数（常驻 UI 用它决定是否空闲隐藏）。永不抛。 */
export function hubSnapshotActiveCount(snapshot: HubSnapshot | null | undefined): number {
  try {
    if (!snapshot || !Array.isArray(snapshot.sessions)) return 0
    return snapshot.sessions.filter((session) => session.state === 'running' || session.state === 'waiting').length
  } catch {
    return 0
  }
}

// ---------- 内部：单个来源的投影 ----------

function projectSource(
  source: HubSessionSource,
  activeInstall: HubActiveInstallSnapshot | null,
  maxRowsPerSession: number,
): HubSessionSnapshot | null {
  const plan = source.plan ? normalizeHubPlan(source.plan) : null
  const session = isBatchSessionShape(source.session) ? source.session : null
  const sessionId = plan?.sessionId ?? asText(source.sessionId) ?? session?.id ?? null
  if (!sessionId) return null
  const owner = plan?.owner ?? asText(source.owner) ?? ''
  const sessionMismatch = plan !== null && session !== null && session.id !== plan.sessionId
  const state: HubSessionState = !session || sessionMismatch ? 'missing' : isBatchFinished(session) ? 'finished' : sessionIsRunning(session, plan, activeInstall) ? 'running' : 'waiting'
  const inventoryEntries = inventoryEntriesOf(source.inventory)
  const installed = asInstalledMap(source.installed)
  const rows: HubRowSnapshot[] = []
  for (const key of hubRowKeys(plan, session)) {
    const entry = session ? batchEntryOf(session, key) : null
    const knowledge = inventoryEntries ? inventoryEntries[key] : null
    rows.push({
      key,
      title: planTargetTitle(plan, key),
      phase: entry ? entry.phase : 'pending',
      targetVersion: entry ? entry.targetVersion : null,
      installedVersion: installed ? asText(installed[key]) ?? asText(knowledge?.installedVersion) : asText(knowledge?.installedVersion),
      latestVersion: asText(knowledge?.latestVersion) ?? (entry ? entry.targetVersion : null),
      restartRequired: entry ? entry.restartRequired === true : false,
      error: entry ? entry.error : null,
    })
  }
  const rowsTotal = rows.length
  const limitedRows = rowsTotal > maxRowsPerSession ? rows.slice(0, maxRowsPerSession) : rows
  return {
    sessionId,
    owner,
    selfKey: plan ? plan.selfKey : null,
    state,
    updatedAt: session ? session.updatedAt : plan ? plan.updatedAt : 0,
    progress: session ? batchProgress(session) : zeroProgress(),
    rows: limitedRows,
    rowsTotal,
    rowsTruncated: limitedRows.length !== rowsTotal,
  }
}

/** 会话的行键：账本 order 权威（执行顺序即展示顺序），方案里多出来的目标接在后面。 */
function hubRowKeys(plan: HubPlan | null, session: BatchSession | null): string[] {
  const keys: string[] = []
  const seen = new Set<string>()
  const push = (key: unknown): void => {
    if (typeof key !== 'string' || !key || seen.has(key)) return
    seen.add(key)
    keys.push(key)
  }
  if (session) {
    for (const key of session.order) push(key)
    for (const entry of session.entries) push(entry.key)
  }
  for (const target of plan ? plan.targets : []) push(target.key)
  return keys
}

/** 有人正在推进这个会话吗：行相位在查/在装，或队列里正在装的是它家的目标。 */
function sessionIsRunning(
  session: BatchSession,
  plan: HubPlan | null,
  activeInstall: HubActiveInstallSnapshot | null,
): boolean {
  if (session.entries.some((entry) => entry.phase === 'installing' || entry.phase === 'checking')) return true
  if (!activeInstall) return false
  const targets = plan ? plan.targets : []
  return targets.some((target) => target.pluginId === activeInstall.pluginId)
}

function planTargetTitle(plan: HubPlan | null, key: string): string {
  if (plan) {
    for (const target of plan.targets) {
      if (target.key === key) return target.title || key
    }
  }
  return key
}

function zeroProgress(): HubProgressSnapshot {
  return { total: 0, done: 0, failed: 0, skipped: 0, current: 0, pending: 0, finished: false }
}

// ---------- 内部：来源字段的防御性读取 ----------

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isBatchSessionShape(value: unknown): value is BatchSession {
  if (!isRecord(value)) return false
  return value['version'] === 1 && typeof value['id'] === 'string' && Array.isArray(value['order']) && Array.isArray(value['entries'])
}

function inventoryEntriesOf(inventory: BatchInventory | null | undefined): Record<string, BatchInventoryEntry> | null {
  if (!isRecord(inventory)) return null
  return isRecord(inventory['entries']) ? (inventory['entries'] as Record<string, BatchInventoryEntry>) : null
}

function asInstalledMap(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function asMillisOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function asPositiveInt(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const rounded = Math.floor(value)
  if (rounded < 1) return fallback
  return rounded > max ? max : rounded
}

function normalizeLimits(limits: unknown): { maxSessions: number; maxRowsPerSession: number } {
  const record = isRecord(limits) ? limits : {}
  return {
    maxSessions: asPositiveInt(record['maxSessions'], HUB_SNAPSHOT_MAX_SESSIONS, 64),
    maxRowsPerSession: asPositiveInt(record['maxRowsPerSession'], HUB_SNAPSHOT_MAX_ROWS_PER_SESSION, 200),
  }
}

function normalizeActiveInstall(value: unknown): HubActiveInstallSnapshot | null {
  if (!isRecord(value)) return null
  const pluginId = asText(value['pluginId'])
  if (!pluginId) return null
  return { pluginId, startedAt: asMillisOrZero(value['startedAt']) }
}

/** 同一个会话号出现两份来源时，谁更可信：有账本优于记录缺失；都完整时取更新时间新的。 */
function preferSnapshot(candidate: HubSessionSnapshot, existing: HubSessionSnapshot): boolean {
  const candidateMissing = candidate.state === 'missing'
  const existingMissing = existing.state === 'missing'
  if (candidateMissing !== existingMissing) return existingMissing
  if (candidate.updatedAt !== existing.updatedAt) return candidate.updatedAt > existing.updatedAt
  return candidate.rowsTotal > existing.rowsTotal
}

const STATE_RANK: Record<HubSessionState, number> = { running: 0, waiting: 1, missing: 2, finished: 3 }

function compareSessions(a: HubSessionSnapshot, b: HubSessionSnapshot): number {
  const rank = STATE_RANK[a.state] - STATE_RANK[b.state]
  if (rank !== 0) return rank
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0
}
