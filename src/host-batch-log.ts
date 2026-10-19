/**
 * 批量侧日志接缝（#208/#209）：批量级事件落哪、去重怎么判、失败行长什么形状——这些「日志状态」
 * 从 host-batch.ts 的闭包里抽出来单独一份，宿主侧只递读数（谁属主、每个目标的插件标识、最近一次
 * 推进为什么停、时钟），发射点仍与账本/电话同处一条流程，不改变任何行的时机。
 *
 * 落点纪律（ADR-0006）：不知道去哪就不猜——
 * - 批量级三事件（入队/单项失败之外的失败/总账）落**属主**目录；没有属主一行不发；
 * - 单项失败落**失败那家自己**的目录（targetHash 是它的指纹）；键不在清单里一行不发；
 * - 电话失败落属主目录；没有属主一行不发。
 */

import { batchProgress, isBatchFinished, type BatchSession } from './batch.js'
import type { BatchStoppedByBecause } from './batch-run.js'
import { isBatchReplyCode } from './codes.js'
import { hash8 } from './shared/hash.js'
import { emitUpdateLog } from './log/emit.js'
import type { UpdateLogPort } from './ports.js'

/** 一次发射的容错口：日志是旁路，任何发射异常都不许改变调用方行为。 */
export function emitBatchLog(
  pluginId: string,
  level: 'info' | 'warn',
  event: string,
  fields: Record<string, unknown>,
): void {
  try {
    emitUpdateLog(level, event, fields, { pluginId })
  } catch {
    // 日志永不外抛
  }
}

/**
 * 按插件标识取口（队列端口的 logFor 用，与 host.ts 的 logPortFor 同形状）：
 * 动作方是哪家，update.queue.transition / update.store.fail 就落哪家的目录。
 */
export function pluginLogPort(pluginId: string): UpdateLogPort {
  return (level, event, fields, opts) => {
    try {
      emitUpdateLog(level, event, fields, { ...opts, pluginId })
    } catch {
      // 日志永不外抛
    }
  }
}

/** 日志接缝需要的宿主读数。 */
export interface BatchLogHost {
  /** 批量属主那家的插件标识；没有属主 → null（批量级行一行不发）。 */
  ownerPluginId: string | null
  /** 属主在目标清单里的键（ownCount 判定用）；没有属主 → null。 */
  ownerKey: string | null
  /** 目标键 → 那家自己的插件标识；键不在清单里 → null（一行不发）。 */
  pluginIdOfTarget: (key: string) => string | null
  /** 最近一次推进的读数（还没推进过 → undefined）。 */
  lastStoppedBecause: () => BatchStoppedByBecause | undefined
  now: () => number
}

/** 宿主侧可用的批量日志接缝。调用点与原先的闭包内函数一一对应，便于逐处替换。 */
export interface BatchLogSeams {
  /** 单项失败的口：按目标键取那家自己的插件标识。 */
  logPortFor(key: string): UpdateLogPort | null
  /** 一批一条入队行。 */
  noteEntryRequest(session: BatchSession): void
  /** 总账按收尾边沿记。 */
  noteBatchSummary(session: BatchSession): void
  /** 没跑完就停下也有一行（同一会话同一原因只记一次）。 */
  noteBatchStopped(session: BatchSession, stoppedBecause: BatchStoppedByBecause): void
  /** 一次推进结束后的读数收尾：收尾边沿总账 + 未收尾时「为什么停」一行。 */
  noteRunOutcome(session: BatchSession): void
  /** 七个批量电话每通失败留一行（同 method 连续同码只记首次、成功清记忆）。 */
  notePhoneFail(name: string, kind: string, reply: Record<string, unknown>): void
}

export function createBatchLogSeams(host: BatchLogHost): BatchLogSeams {
  // 入队行按会话编号去重（「一批一条」）：同一份会话反复推进（drain 一轮一步 / 忙时入队被并进来）
  // 只记一次。总账另走**收尾边沿**，所以它自己记一份「上次看过是收尾吗」。
  // 这些状态只活在本进程里，重启后新一轮自然重新记。
  const notedEntryRequests = new Set<string>()
  /**
   * 上次观察时已经收尾的会话编号（总账的边沿判据，不是「一批一条」）：
   * 行内「重试」把失败那家退回 pending 时这一格会被清掉，装成后再收尾就再记一条 ——
   * 日志不能在前一条 summary 里一直写着 failed:1 而账本早已装成（审计口径的假话比多一行贵）。
   */
  const finishedBatchIds = new Set<string>()
  /**
   * 记过「为什么停」行的「会话编号 + 原因」（#209）。drain 每轮都会看见同一个 queued，
   * 不能每轮刷一行；同一份会话同一原因只记一次。
   */
  const stoppedBatchKeys = new Set<string>()
  /**
   * 七个批量电话每通失败留一行（#208）：同一 method 连续同码只记首次、成功清除记忆 ——
   * batchStatus 每 1.5s 轮询一次失败时不能灌爆目录。
   */
  const phoneFailSeen = new Map<string, string>()

  /**
   * 单项失败的发射口按「目标键 → 那家自己的插件标识」路由（#124）：一家失败记在那个插件自己的
   * 日志目录里（那行说的就是它的事，targetHash 是它的指纹）；键不在清单里就回 null，一行不发。
   */
  function logPortFor(key: string): UpdateLogPort | null {
    const pluginId = host.pluginIdOfTarget(key)
    if (!pluginId) return null
    return (level: string, event: string, fields: Record<string, unknown>) => {
      emitBatchLog(pluginId, level === 'warn' ? 'warn' : 'info', event, fields)
    }
  }

  /**
   * 一批只记一条入队行：own = 目标里属于批量属主自己那家（键 === selfKey 的那家），其余算 foreign。
   * 只给三个计数 + 批次指纹、不给插件名清单——入队行不该泄露「我在更新谁」。
   * #208 起带 sessionHash（hash8(会话 id)）：同一批的入队/失败/总账三条行靠它串起来。
   */
  function noteEntryRequest(session: BatchSession): void {
    const owner = host.ownerPluginId
    if (!owner || notedEntryRequests.has(session.id)) return
    notedEntryRequests.add(session.id)
    const total = session.entries.length
    const ownCount = host.ownerKey ? session.entries.filter((entry) => entry.key === host.ownerKey).length : 0
    emitBatchLog(owner, 'info', 'update.batch.entry.request', {
      total,
      ownCount,
      foreignCount: total - ownCount,
      sessionHash: hash8(session.id),
    })
  }

  /** 总账一行的公共形状（#209）：收尾行与异常停止行同字段，只有 stoppedBecause 不同。 */
  function emitBatchSummaryRow(session: BatchSession, stoppedBecause: BatchStoppedByBecause): void {
    const owner = host.ownerPluginId
    if (!owner) return
    const progress = batchProgress(session)
    const elapsed = host.now() - session.createdAt
    emitBatchLog(owner, 'info', 'update.batch.summary', {
      total: progress.total,
      ok: progress.done,
      failed: progress.failed,
      skipped: progress.skipped,
      durationMs: Number.isFinite(elapsed) && elapsed > 0 ? Math.floor(elapsed) : 0,
      sessionHash: hash8(session.id),
      stoppedBecause,
    })
  }

  /**
   * 总账按**收尾边沿**记：这次看是收尾、上次看不是，就记一条；两次都是收尾（例如对已经装成的行
   * 再点一次「装这家」）不重复记。所以调用方要在推进前后各看一次——重试把失败行退回 pending 时
   * 先清标记，装成后再收尾才记第二条。ok 用「没出事」的口径（装完 + 已是最新），
   * ok + failed + skipped === total 恒成立；durationMs 是「建会话 → 这次收尾」的真测量。
   * #208 起带 sessionHash 与 stoppedBecause：一批行能串起来，收尾能说明为什么停
   * （finished = 全部跑完，不代表没失败；别的原因都来自最近一次推进的读数）。
   */
  function noteBatchSummary(session: BatchSession): void {
    if (!host.ownerPluginId) return
    const finished = isBatchFinished(session)
    const wasFinished = finishedBatchIds.has(session.id)
    if (finished) {
      finishedBatchIds.add(session.id)
      // 收尾后不再需要「为什么停」的去重键（#209）：清掉本会话的，别让进程内集合随会话数无界增长。
      for (const key of stoppedBatchKeys) {
        if (key.startsWith(`${session.id}\u0000`)) stoppedBatchKeys.delete(key)
      }
    } else {
      finishedBatchIds.delete(session.id)
    }
    if (!finished || wasFinished) return
    emitBatchSummaryRow(session, host.lastStoppedBecause() ?? 'finished')
  }

  /**
   * 没跑完就停下也要有一行（#209）：收尾边沿只管 finished；「为什么停」由这里记——
   * queued（排上队还没轮到）/ stopped-after-failure（按策略遇错停）/ user-cancel（用户清账本）/
   * error（驱动自己抛异常）。同一份会话同一原因只记一次（drain 每轮都会看见同一个 queued）。
   */
  function noteBatchStopped(session: BatchSession, stoppedBecause: BatchStoppedByBecause): void {
    if (!host.ownerPluginId || session.entries.length === 0) return
    if (isBatchFinished(session)) return
    const key = `${session.id}\u0000${stoppedBecause}`
    if (stoppedBatchKeys.has(key)) return
    stoppedBatchKeys.add(key)
    emitBatchSummaryRow(session, stoppedBecause)
  }

  /** 一次推进结束后的读数收尾：收尾边沿的总账 + 未收尾时「为什么停」的一行（#209）。 */
  function noteRunOutcome(session: BatchSession): void {
    noteBatchSummary(session)
    if (isBatchFinished(session)) return
    const reason = host.lastStoppedBecause()
    if (reason === 'queued' || reason === 'stopped-after-failure') noteBatchStopped(session, reason)
  }

  /**
   * 七个批量电话每通失败留一行（#208）：落**属主**目录（没有属主就没有已知落点，一行不发）。
   * 复用 host.call.fail（不新增事件）；method 用全名、kind 用短名；error 只认稳定码，认不出折 unknown；
   * 同一 method 连续同码只记首次、成功清除记忆——batchStatus 每 1.5s 轮询一次失败时不能灌爆目录。
   */
  function notePhoneFail(name: string, kind: string, reply: Record<string, unknown>): void {
    const owner = host.ownerPluginId
    if (!owner) return
    if (reply['ok'] === true) {
      phoneFailSeen.delete(name)
      return
    }
    const raw = typeof reply['error'] === 'string' ? reply['error'] : ''
    const error = isBatchReplyCode(raw) ? raw : 'unknown'
    if (phoneFailSeen.get(name) === error) return
    phoneFailSeen.set(name, error)
    emitBatchLog(owner, 'warn', 'host.call.fail', {
      method: name,
      kind,
      error,
      errorHash: hash8(name + '|' + error),
      pluginId: owner,
    })
  }

  return { logPortFor, noteEntryRequest, noteBatchSummary, noteBatchStopped, noteRunOutcome, notePhoneFail }
}
