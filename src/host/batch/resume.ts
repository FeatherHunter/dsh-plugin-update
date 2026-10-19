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
  return {
    ...session,
    entries: [...session.entries, ...added],
    order: orderTargets([...session.order, ...added.map((entry) => entry.key)], session.selfKey),
    updatedAt: at,
  }
}
