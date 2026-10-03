// src/batch.ts —— 多目标批量更新的会话账本（#25）。
//
// 全程用「目标」指一个要更新的插件包，用「会话」指一轮批量更新（一次检测到 N 个目标要升级，
// 从排队到全部收尾为止）。
//
// 第一性（为什么要它）：
//   爱生活 dsh-life-pack 的七家批量更新把队列与进度**只放在浏览器内存**里（调查见
//   docs/research/20261004-ilife-多插件更新调查.md §4.3）。于是「更新自己」时磁盘换新 +
//   装插件触发前端重载，内存一丢，剩下几家永不启动——这就是「UI 消失、更新功能停」的根因。
//   所以会话必须**落盘**：谁重启都不怕，读回来接着推进；同一 (会话, 目标) 的编号恒定，
//   重复提交天然幂等（队列按 (pluginId, requestId) 幂等占位）。
//
// 归属：本文件零导入、纯函数、无 Node/浏览器专属能力，宿主侧与面板闭包两边都跑得动；
//   落盘与读写由宿主侧负责（与 queue.ts 同一分工）。
//
// 自更新安全：`orderTargets` 默认把「自己」（selfKey）排到最后——承载更新界面的那个包若第一个
//   被换掉，界面与推进它的循环会一起消失；排最后则前面几家早已落盘收尾。

/** 会话账本版本号：收到别的数字按空会话处理，不抛错（与队列同一纪律）。 */
export const BATCH_SESSION_VERSION = 1

/** 一个目标在一轮批量里的相位。 */
export type BatchPhase =
  /** 还没轮到你 */
  | 'pending'
  /** 正在查远端版本 */
  | 'checking'
  /** 查到了、有新版可装，等排队 */
  | 'ready'
  /** 已提交安装，正在进行 */
  | 'installing'
  /** 本家已是最新，不需要动 */
  | 'current'
  /** 装完了（可能还要重启宿主才生效，见 restartRequired） */
  | 'done'
  /** 这一家失败了（error 给稳定码），按策略决定要不要继续下一家 */
  | 'failed'
  /** 这一家被跳过（用户跳过该版本） */
  | 'skipped'

/** 终态：不会再变化的相位。 */
export function isTerminalPhase(phase: BatchPhase): boolean {
  return phase === 'done' || phase === 'failed' || phase === 'skipped' || phase === 'current'
}

/** 会话里的一行。 */
export interface BatchEntry {
  /** 目标稳定键（会话内唯一）。 */
  key: string
  phase: BatchPhase
  /** 幂等编号：同一会话同一目标恒定，重复提交不重复装（队列按它占位）。 */
  requestId: string
  /** 远端最新版（查过才有）。 */
  targetVersion: string | null
  /** 装完之后是否要重启宿主才生效（pending-restart）。 */
  restartRequired: boolean
  /** 失败稳定码（认不出给 internal）；成功恒为 null。 */
  error: string | null
  /** 这一行最后一次变化的时刻。 */
  updatedAt: number
}

/** 一轮批量更新的会话账本（落盘形状）。 */
export interface BatchSession {
  version: 1
  /** 会话编号（调用方给：时间戳 + 随机串之类，只作标识用）。 */
  id: string
  /** 「自己」的键：排序时排最后；没有就传 null。 */
  selfKey: string | null
  /** 一家失败后是否停下（默认 false：继续下一家）。 */
  stopOnFailure: boolean
  /** 目标处理顺序（自更新安全：selfKey 在最后）。 */
  order: string[]
  entries: BatchEntry[]
  createdAt: number
  updatedAt: number
}

/** 会话里进度的读数。 */
export interface BatchProgress {
  total: number
  done: number
  failed: number
  skipped: number
  current: number
  pending: number
  /** 终态齐了就 true（失败也算收尾——不阻塞整轮的结束）。 */
  finished: boolean
}

function asMillis(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

const PHASES: readonly BatchPhase[] = ['pending', 'checking', 'ready', 'installing', 'current', 'done', 'failed', 'skipped']

function asPhase(value: unknown): BatchPhase {
  return typeof value === 'string' && (PHASES as readonly string[]).includes(value) ? (value as BatchPhase) : 'pending'
}

/**
 * 目标顺序：selfKey 排最后，其余保持传入顺序（稳定排序，不许键乱序导致顺序漂移）。
 * 传进来的键去重后仍为空即返回空数组，调用方按「没有可做的」处理。
 */
export function orderTargets(keys: readonly string[], selfKey?: string | null): string[] {
  const seen = new Set<string>()
  const others: string[] = []
  let self: string | null = null
  for (const key of keys) {
    if (!isNonEmptyString(key) || seen.has(key)) continue
    seen.add(key)
    if (selfKey && key === selfKey) self = key
    else others.push(key)
  }
  return self ? [...others, self] : others
}

/** 会话内某一行的幂等编号：会话 + 目标 ⇒ 恒定（重跑同一会话不会重复装）。 */
export function batchRequestId(sessionId: string, key: string): string {
  return 'batch:' + sessionId + ':' + key
}

/** 开一轮会话：给定目标键与「自己」的键，按自更新安全排好序，每行落一个幂等编号。 */
export function createBatchSession(args: {
  id: string
  keys: readonly string[]
  selfKey?: string | null
  stopOnFailure?: boolean
  now: number
}): BatchSession {
  const id = isNonEmptyString(args.id) ? args.id : 'batch'
  const selfKey = isNonEmptyString(args.selfKey) ? args.selfKey : null
  const order = orderTargets(args.keys, selfKey)
  const now = asMillis(args.now, 0)
  const entries: BatchEntry[] = order.map((key) => ({
    key,
    phase: 'pending',
    requestId: batchRequestId(id, key),
    targetVersion: null,
    restartRequired: false,
    error: null,
    updatedAt: now,
  }))
  return {
    version: BATCH_SESSION_VERSION as 1,
    id,
    selfKey,
    stopOnFailure: args.stopOnFailure === true,
    order,
    entries,
    createdAt: now,
    updatedAt: now,
  }
}

/** 空会话（文件缺失或损坏时的回退：坏账本不能挡更新，与队列同一纪律）。 */
export function emptyBatchSession(): BatchSession {
  return {
    version: BATCH_SESSION_VERSION as 1,
    id: '',
    selfKey: null,
    stopOnFailure: false,
    order: [],
    entries: [],
    createdAt: 0,
    updatedAt: 0,
  }
}

/** 把外面读到的值验成可用的会话：错了不抛错，回空会话。 */
export function normalizeBatchSession(raw: unknown): BatchSession {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyBatchSession()
    const input = raw as Record<string, unknown>
    if (input['version'] !== BATCH_SESSION_VERSION) return emptyBatchSession()
    const id = isNonEmptyString(input['id']) ? (input['id'] as string) : ''
    const selfKey = isNonEmptyString(input['selfKey']) ? (input['selfKey'] as string) : null
    const entries: BatchEntry[] = []
    const seen = new Set<string>()
    const rawEntries = input['entries']
    if (Array.isArray(rawEntries)) {
      for (const item of rawEntries) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue
        const e = item as Record<string, unknown>
        const key = e['key']
        if (!isNonEmptyString(key) || seen.has(key)) continue
        seen.add(key)
        const requestId = isNonEmptyString(e['requestId']) ? (e['requestId'] as string) : batchRequestId(id, key)
        entries.push({
          key,
          phase: asPhase(e['phase']),
          requestId,
          targetVersion: isNonEmptyString(e['targetVersion']) ? (e['targetVersion'] as string) : null,
          restartRequired: e['restartRequired'] === true,
          error: isNonEmptyString(e['error']) ? (e['error'] as string) : null,
          updatedAt: asMillis(e['updatedAt'], 0),
        })
      }
    }
    // order 以 entries 为准重建（order 里多出来的键不认，缺的按 entries 补），避免两处不同步。
    const order = entries.map((e) => e.key)
    return {
      version: BATCH_SESSION_VERSION as 1,
      id,
      selfKey: selfKey && seen.has(selfKey) ? selfKey : null,
      stopOnFailure: input['stopOnFailure'] === true,
      order,
      entries,
      createdAt: asMillis(input['createdAt'], 0),
      updatedAt: asMillis(input['updatedAt'], 0),
    }
  } catch {
    return emptyBatchSession()
  }
}

/** 按会话顺序取某一行。 */
export function batchEntryOf(session: BatchSession, key: string): BatchEntry | null {
  return session.entries.find((e) => e.key === key) ?? null
}

/**
 * 下一个该处理的目标键：
 * - 按会话顺序找第一个非终态行；
 * - `stopOnFailure` 为真且已有失败行时返回 null（停下，等人处理）；
 * - 全部收尾返回 null。
 */
export function nextBatchKey(session: BatchSession): string | null {
  if (session.stopOnFailure && session.entries.some((e) => e.phase === 'failed')) return null
  for (const key of session.order) {
    const entry = session.entries.find((e) => e.key === key)
    if (entry && !isTerminalPhase(entry.phase)) return key
  }
  return null
}

/** 改一行：返回新会话（不可变），键不存在时原样返回且 changed=false。 */
export function markBatchEntry(
  session: BatchSession,
  key: string,
  patch: Partial<Omit<BatchEntry, 'key' | 'requestId'>>,
  now: number,
): { session: BatchSession; changed: boolean } {
  const at = session.entries.findIndex((e) => e.key === key)
  if (at < 0) return { session, changed: false }
  const next: BatchEntry = { ...session.entries[at], ...patch, key: session.entries[at].key, requestId: session.entries[at].requestId, updatedAt: asMillis(now, session.entries[at].updatedAt) }
  const entries = [...session.entries.slice(0, at), next, ...session.entries.slice(at + 1)]
  return { session: { ...session, entries, updatedAt: next.updatedAt }, changed: true }
}

/** 进度读数（面板与门禁共用同一份口径）。 */
export function batchProgress(session: BatchSession): BatchProgress {
  const total = session.entries.length
  let done = 0
  let failed = 0
  let skipped = 0
  let current = 0
  let pending = 0
  for (const entry of session.entries) {
    if (entry.phase === 'done' || entry.phase === 'current') done += 1
    else if (entry.phase === 'failed') failed += 1
    else if (entry.phase === 'skipped') skipped += 1
    else if (entry.phase === 'installing' || entry.phase === 'checking' || entry.phase === 'ready') current += 1
    else pending += 1
  }
  return { total, done, failed, skipped, current, pending, finished: isBatchFinished(session) }
}

/** 一轮结束：每一行都进了终态（失败也算收尾——失败不该让整轮永远挂着）。 */
export function isBatchFinished(session: BatchSession): boolean {
  return session.entries.length > 0 && session.entries.every((e) => isTerminalPhase(e.phase))
}

/** 要重启才生效的那几家（批量装完给一条总账，别让用户逐家点）。 */
export function needsRestartKeys(session: BatchSession): string[] {
  return session.entries.filter((e) => e.restartRequired).map((e) => e.key)
}

/** 失败的那几家（给人话总账用）。 */
export function failedKeys(session: BatchSession): string[] {
  return session.entries.filter((e) => e.phase === 'failed').map((e) => e.key)
}

/**
 * 断点续跑：把「进行中」的行退回 pending——重启/重载后不知道它们走到哪了，
 * 由调用方重新查一次真实状态再决定装不装（幂等编号不变，重复提交不会重复装）。
 * 终态行（done/current/failed/skipped）一律保留：**已完成的不重装**。
 */
export function resumeBatchSession(session: BatchSession, now: number): BatchSession {
  const at = asMillis(now, session.updatedAt)
  let changed = false
  const entries = session.entries.map((entry) => {
    if (entry.phase === 'checking' || entry.phase === 'installing') {
      changed = true
      return { ...entry, phase: 'pending' as BatchPhase, error: null, updatedAt: at }
    }
    return entry
  })
  return changed ? { ...session, entries, updatedAt: at } : session
}
