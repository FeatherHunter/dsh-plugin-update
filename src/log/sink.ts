/**
 * src/log/sink.ts —— 日志落点（sink）的形状与三种来源的适配。
 *
 * 为什么要有这一层：本包的落点有两个来源 —— 集成方注入的 `logCtx`（既有生态写法）和本包自建的
 * dsh-log 实例；两者形状不同（前者只有 `fire`，后者是 `store.log` + `store.isEnabled`）。
 * 把它们收敛成同一个 `LogSink`，发射口就只需要认识一种东西。
 *
 * `LogSink` 故意与既有 `logCtx` 同形（`{ fire, isEnabled? }`）：集成方老代码一字不改就能接上，
 * 他们手里的 dsh-log 0.1.0/0.2.x 实例也照旧能用（常驻准入与否由他们那台引擎决定）。
 *
 * 本文件零 Node 内建依赖（面板侧只许引用这里的类型，不许把落盘逻辑拖进浏览器闭包）。
 */

/**
 * 链上下文的最小形状 —— dsh-log 0.3.3 起 `store.trace()` 给的就是它。
 * 这里只声明本包用得着的四个成员（`shadowWarns` 之类留给上游的类型面）。
 */
export interface LogTraceHandle {
  readonly traceId: string
  readonly spanId: string
  log: (level: string, event: string, fields?: Record<string, unknown>) => unknown
  child: (overrides?: { traceId?: string; spanId?: string }) => LogTraceHandle
}

/** 日志落点：唯一必需能力是「发一行」，可选的 isEnabled 用来短路（不落盘就不算丢）。 */
export interface LogSink {
  fire: (level: string, event: string, fields: Record<string, unknown>) => void
  isEnabled?: (level: string, event?: string) => boolean
  /**
   * 可选：这个落点能不能给出一条链。
   * 自建 dsh-log store（0.3.3+）能；集成方注入的客户端实例、降级落点、待接落点未接上时不能 ——
   * 取不到就退回 `fire`，那是既有行为，不在这条改动里悄悄改掉。
   */
  trace?: (input?: { traceId?: string; spanId?: string }) => LogTraceHandle | null
}

/** 什么都不做的落点：不知道往哪写时的唯一正确选择（绝不回退到别人的 sink）。 */
export function createNoopSink(): LogSink {
  return { fire: () => {}, isEnabled: () => false }
}

/** 进程内共用的无操作落点（只读常量，避免每处 new 一个）。 */
export const NOOP_SINK: LogSink = createNoopSink()

/** 判据：这东西能不能当落点用（既有 logCtx 的判据只有一条 —— fire 是函数）。 */
export function isLogSinkLike(value: unknown): boolean {
  try {
    return typeof (value as { fire?: unknown } | null | undefined)?.fire === 'function'
  } catch {
    return false
  }
}

/**
 * 既有 `logCtx` → `LogSink`。取不到（null / 不是对象 / 没有 fire）时回 null：
 * 调用方据此决定「自建实例」还是「降级」，本包不接受半成品落点。
 * 注入方的 isEnabled 若存在也一并接上（dsh-log 0.2.x 起的实例都有）。
 */
export function sinkFromLogCtx(logCtx: unknown): LogSink | null {
  if (!isLogSinkLike(logCtx)) return null
  const source = logCtx as { fire: LogSink['fire']; isEnabled?: unknown }
  const enabled = typeof source.isEnabled === 'function' ? (source.isEnabled as LogSink['isEnabled']) : undefined
  return {
    fire: (level, event, fields) => source.fire(level, event, fields),
    ...(enabled ? { isEnabled: (level, event) => !!enabled(level, event) } : {}),
  }
}

/**
 * dsh-log 的 `store` → `LogSink`。`store.log` 的回执（'queued'|'skipped'|'dropped'）本层不解读：
 * 丢弃计数由 dsh-log 自己维护（`getDroppedCount`），本包只在自建路径上另行暴露句柄。
 */
export function sinkFromStore(store: {
  log: (level: string, event: string, fields: Record<string, unknown>) => unknown
  isEnabled?: (level: string, event?: string) => boolean
  trace?: (input?: { traceId?: string; spanId?: string }) => unknown
}): LogSink {
  return {
    fire: (level, event, fields) => {
      store.log(level, event, fields)
    },
    ...(typeof store.isEnabled === 'function' ? { isEnabled: (level: string, event?: string) => !!store.isEnabled?.(level, event) } : {}),
    // 0.3.2 及更早的 store 没有 trace：那时这个键不出现，发射口自然退回 fire（形状探测，不做版本比较）。
    ...(typeof store.trace === 'function'
      ? {
          trace: (input?: { traceId?: string; spanId?: string }): LogTraceHandle | null => {
            try {
              const got = store.trace?.(input)
              return got && typeof (got as LogTraceHandle).log === 'function' ? (got as LogTraceHandle) : null
            } catch {
              return null
            }
          },
        }
      : {}),
  }
}

/**
 * 待接落点：自建 dsh-log 实例是异步的（`dsh-log/node` 是动态 import + 建库要读盘），
 * 而 `createHostUpdate` 是同步契约，不能为了日志改成 async（会破坏所有集成方的调用点）。
 * 所以先接一个「先收后转」的落点：建库成功就按序灌进去，失败就整体降级、计数不抛。
 */
export interface PendingLogSink {
  sink: LogSink
  attach: (next: LogSink | null) => void
  isAttached: () => boolean
  pendingCount: () => number
  droppedCount: () => number
}

export function createPendingSink(maxQueue = 200): PendingLogSink {
  const limit = Number.isFinite(maxQueue) ? Math.max(1, Math.floor(maxQueue)) : 200
  const buffer: Array<{ level: string; event: string; fields: Record<string, unknown> }> = []
  let target: LogSink | null = null
  let dropped = 0
  const sink: LogSink = {
    fire: (level, event, fields) => {
      if (target) {
        target.fire(level, event, fields)
        return
      }
      if (buffer.length >= limit) {
        dropped++
        return
      }
      buffer.push({ level, event, fields })
    },
    isEnabled: (level, event) => (target && typeof target.isEnabled === 'function' ? !!target.isEnabled(level, event) : true),
    // 链跟着真正落地的那个落点走：还没接上时回 null（发射口据此退回缓冲，行不会丢）。
    trace: (input) => (target && typeof target.trace === 'function' ? target.trace(input) : null),
  }
  return {
    sink,
    attach: (next) => {
      // 判据是「有没有真落点」：`attach(null)`（建库失败的降级路径）下，缓冲里的行倒进
      // 无操作落点，等于当场蒸发 —— 必须逐行计入丢弃，否则「丢弃数」会把最该看见的那批行漏掉。
      const real = next ?? null
      target = real ?? NOOP_SINK
      while (buffer.length) {
        const row = buffer.shift()
        if (!row) break
        if (!real) {
          dropped++
          continue
        }
        try {
          real.fire(row.level, row.event, row.fields)
        } catch {
          dropped++
        }
      }
    },
    isAttached: () => target !== null,
    pendingCount: () => buffer.length,
    droppedCount: () => dropped,
  }
}
