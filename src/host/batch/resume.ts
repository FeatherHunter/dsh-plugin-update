// src/host/batch/resume.ts —— 会话恢复的纯函数面（#227 从 host-batch.ts 搬出，蓝图 §4 batch 域）。
//
// 身份：把「账本幂等编号 <-> 电话/队列收的编号」的换算（phoneRequestIdOf）与会话行合并
// （忙时入队行并入、只推几家的视图会话并回全量账本）抽成不碰闭包的纯函数。
// 真正读盘/推进的 resume 分支仍在 fan-out.ts 的 createMultiHostUpdate 里（闭包内，抽不动也无需抽）。

import { hash8 } from '../../shared/hash.js'
import {
  batchRequestId,
  orderTargets,
  type BatchEntry,
  type BatchSession,
} from '../../core/batch/model.js'

const REQUEST_ID_MAX_CHARS = 128

/**
 * 账本幂等编号 -> 电话/队列收的编号。账本编号形如 batch:<会话>:<目标>，带冒号，
 * 不在更新核心收的「不透明编号」形状里（[A-Za-z0-9._~-]，见 core/service.ts 的 validRequestId）。
 * 纯函数：同一账本编号恒得同一电话编号，所以「同一会话同一目标恒定、重复提交不重复装」原样成立；
 * 形状被改写过的追加短哈希，避免不同账本编号撞成同一个电话编号。
 */
export function phoneRequestIdOf(batchRequestId: string): string {
  const raw = typeof batchRequestId === 'string' ? batchRequestId : ''
  const opaque =
    raw.length <= REQUEST_ID_MAX_CHARS &&
    /^[A-Za-z0-9._~-]+$/.test(raw) &&
    !/^(npm_|gh[pousr]_|github_pat_|sk-|bearer)/i.test(raw)
  if (opaque) return raw
  const safe = raw.replace(/[^A-Za-z0-9._~-]/g, '-').replace(/^[.-]+/, '').slice(0, REQUEST_ID_MAX_CHARS - 10)
  return (safe || 'batch') + '-' + hash8(raw)
}
/**
 * #218：这次安装回包是不是「同一 requestId 的旧任务」的幂等命中？
 *
 * 核心按 requestId 幂等（service.ts：同一编号重复提交直接返回上一次的结果），这是为了让
 * 「重试同一意图」不重复装；但续跑的旧账本会把上一轮用过的编号带到新目标版本上。
 * 旧任务 completed 了别的版本、或干脆 failed/interrupted 着，照它收尾都会说谎：
 * 前者把没装的这一轮记成成功，后者让用户永远重试不出去。认出来就必须换编号重提。
 */
export function staleIdempotentHit(job: Record<string, unknown> | null, phoneRequestId: string, version: string): boolean {
  if (!job) return false
  if (typeof job['requestId'] !== 'string' || job['requestId'] !== phoneRequestId) return false
  const state = typeof job['state'] === 'string' ? (job['state'] as string) : ''
  if (state === 'completed') return typeof job['targetVersion'] !== 'string' || job['targetVersion'] !== version
  return state === 'failed' || state === 'interrupted'
}

/**
 * #218：同一账本编号的「换一次尝试」编号。形状仍是核心收的不透明编号
 * （[A-Za-z0-9._~-]，见 service.ts 的 validRequestId）；同一 nonce 恒得同一编号，
 * 不同 nonce 必得不同编号（末尾 8 位哈希覆盖整段输入）。
 */
export function attemptRequestId(phoneRequestId: string, nonce: string): string {
  const raw = typeof phoneRequestId === 'string' ? phoneRequestId : ''
  const base = raw.replace(/[^A-Za-z0-9._~-]/g, '-').replace(/^[.-]+/, '').slice(0, REQUEST_ID_MAX_CHARS - 12)
  return (base || 'batch') + '-a' + hash8(raw + '|' + (typeof nonce === 'string' ? nonce : ''))
}
/**
 * 把更全的那份会话里的行并进 base（键相同的以 base 的相位为准），顺序以更全的那份为准。
 * 两处用：忙时入队（驱动期间并进来的新行）、「只推几家」的视图会话合并回全量账本。
 */
export function mergeInto(base: BatchSession, extra: BatchSession | null): BatchSession {
  if (!extra) return base
  const baseKeys = new Set(base.entries.map((entry) => entry.key))
  const missing = extra.entries.filter((entry) => !baseKeys.has(entry.key))
  if (missing.length === 0) return base
  const merged = new Map<string, BatchEntry>(base.entries.map((entry) => [entry.key, entry]))
  for (const entry of missing) merged.set(entry.key, entry)
  const order: string[] = []
  const seen = new Set<string>()
  for (const key of [...extra.order, ...base.order]) {
    if (seen.has(key) || !merged.has(key)) continue
    seen.add(key)
    order.push(key)
  }
  for (const key of merged.keys()) {
    if (seen.has(key)) continue
    seen.add(key)
    order.push(key)
  }
  return {
    ...base,
    entries: order.map((key) => merged.get(key) as BatchEntry),
    order,
    updatedAt: Math.max(base.updatedAt, extra.updatedAt),
  }
}
/** 忙时入队：把键并进会话（幂等）——缺的按会话编号补一条 pending 行，顺序仍「自己排最后」。 */
export function addKeys(session: BatchSession, keys: Iterable<string>, at: number): BatchSession {
  const have = new Set(session.entries.map((entry) => entry.key))
  const added: BatchEntry[] = []
  for (const key of keys) {
    if (have.has(key)) continue
    have.add(key)
    added.push({
      key,
      phase: 'pending',
      requestId: batchRequestId(session.id, key),
      targetVersion: null,
      restartRequired: false,
      error: null,
      updatedAt: at,
    })
  }
  if (added.length === 0) return session
  const addedKeys = added.map((entry) => entry.key)
  const merged = [...session.order, ...addedKeys.filter((key) => !session.order.includes(key))]
  // #219：本体在第一位的会话，追加目标后仍让本体留在第一位（不能按默认 last 又把它踢到最后）。
  const order =
    session.selfKey !== null && merged[0] === session.selfKey
      ? [session.selfKey, ...merged.filter((key) => key !== session.selfKey)]
      : orderTargets(merged, session.selfKey)
  return {
    ...session,
    entries: [...session.entries, ...added],
    order,
    updatedAt: at,
  }
}
