/**
 * src/log/emit.ts —— 唯一发射口。
 *
 * 为什么必须有「唯一」发射口：日志的四个纪律（脱敏、字段白名单、准入短路、预算守卫）散在调用点写，
 * 就一定有人漏写一条；而漏掉的那条恰好会在第三方交日志时才被发现。所以本包只有这一个地方
 * 允许把行交给落点，其余地方只许调 `emitUpdateLog`。
 *
 * 四条纪律（每条都有测试钉住）：
 *   1. **脱敏**：字段里所有字符串过 `sanitizeDetail`（ADR-0001 的边界）。路径、带凭证的 URL、
 *      令牌、邮箱一律在边界内被改写；行里绝不出现绝对路径。
 *   2. **字段白名单**：随包清单（`event-list.update.json`）没声明的事件或字段一律不落盘，
 *      计入丢弃并记一条 `update.log.degraded`；开发/测试期可以切成 `mode: 'throw'` 当场炸出来。
 *   3. **准入短路**：落点说 `isEnabled(level)` 是假就直接不发 —— 这是「没开开关」不是「丢行」，
 *      计入 skipped，不触发 degraded。
 *   4. **预算守卫**：清单标了「边沿触发」的事件（或调用方给了状态指纹的行）同一状态指纹只落一条；
 *      轮询每秒一次也不会把日志灌满。
 *
 * 落点抛错、字段里有怪东西、清单没加载 —— 一律不得影响主流程：本文件对外只回布尔与计数，绝不外抛。
 */
import { sanitizeDetail } from '../redaction.js'
import { NOOP_SINK, type LogSink } from './sink.js'
import { updateLogRouter } from './router.js'
import { checkLogFields, currentUpdateEventTable, isEdgeEvent } from './manifest.js'

/** 丢弃原因（内部计数用的口径，比事件目录的 reason 取值更细）。 */
export type LogDropReason = 'unknown-field' | 'unknown-event' | 'no-plugin-id' | 'no-sink' | 'emit-threw'

/**
 * 丢弃原因 → `update.log.degraded` 的 reason 取值（事件目录定的六个合法值）。
 * `no-plugin-id` 没有对应行：连插件标识都没有的行没法路由，也就没有落点可以承载这条坏消息。
 */
const DEGRADE_REASON: Record<LogDropReason, string | null> = {
  'unknown-field': 'unknown-field',
  'unknown-event': 'unknown-event',
  'emit-threw': 'emit-threw',
  'no-sink': 'no-dsh-log',
  'no-plugin-id': null,
}

export interface LogEmitterCounts {
  emitted: number
  suppressed: number
  skipped: number
  dropped: number
  droppedByReason: Record<string, number>
}

export interface LogEmitOptions {
  /** 路由用插件标识；不给时退回 `fields.pluginId`（行的内容与路由是两件事，能显式就显式）。 */
  pluginId?: string
  /** 状态指纹：给了就按它去重（不给且事件是边沿触发时，用脱敏后的字段算指纹）。 */
  fingerprint?: string
  /** 强制落这一条（跳过预算守卫），用于「状态确实又变回来了」这类真重复。 */
  always?: boolean
}

export interface LogEmitter {
  emit: (level: string, event: string, fields: Record<string, unknown>, opts?: LogEmitOptions) => boolean
  counts: () => LogEmitterCounts
  /** 已记过 degraded 的原因（同一原因全进程只记首次）。 */
  degradedReasons: () => string[]
}

export interface LogEmitterDeps {
  /** 按插件标识取落点；回 null 即「这行没地方去」，按丢弃计数（绝不回退到别人的 sink）。 */
  resolve: (pluginId: string) => LogSink | null
  /** 字段白名单与边沿判据的清单来源（现取，异步加载完才有）。 */
  table?: () => ReturnType<typeof currentUpdateEventTable>
  /** 'drop'（运行期，默认）：不合规的行丢弃并计数；'throw'（开发/测试）：当场抛。 */
  mode?: 'drop' | 'throw'
}

/** 字段值脱敏：字符串过 ADR-0001 的边界；对象/数组先序列化再脱敏（宁可变成字符串，也不许原样落盘）。 */
export function sanitizeLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(fields)) {
    const value = fields[key]
    if (typeof value === 'string') out[key] = sanitizeDetail(value)
    else if (value === null || value === undefined) out[key] = value ?? null
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value
    else if (typeof value === 'bigint') out[key] = String(value)
    else out[key] = sanitizeDetail(safeStringify(value))
  }
  return out
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return '[unserializable]'
  }
}

/** 状态指纹：键排序后的稳定串（字段顺序不同、内容相同的两行必须算出同一个指纹）。 */
export function fieldFingerprint(fields: Record<string, unknown>): string {
  const keys = Object.keys(fields).sort()
  const parts: string[] = []
  for (const key of keys) parts.push(`${key}=${safeStringify(fields[key])}`)
  return parts.join('&')
}

export function createLogEmitter(deps: LogEmitterDeps): LogEmitter {
  const counts: LogEmitterCounts = { emitted: 0, suppressed: 0, skipped: 0, dropped: 0, droppedByReason: {} }
  const degraded = new Set<string>()
  const seen = new Map<string, string>()
  const mode = deps.mode ?? 'drop'
  const table = (): ReturnType<typeof currentUpdateEventTable> => {
    try {
      return deps.table ? deps.table() : null
    } catch {
      return null
    }
  }

  function countDrop(reason: LogDropReason, pluginId: string): void {
    counts.dropped++
    counts.droppedByReason[reason] = (counts.droppedByReason[reason] ?? 0) + 1
    degrade(reason, pluginId)
  }

  /** 自监控行：同一个原因只记首次（清单里 `update.log.degraded` 的 guard 就是这么写的）。 */
  function degrade(reason: LogDropReason, pluginId: string): void {
    const code = DEGRADE_REASON[reason]
    if (!code || degraded.has(code)) return
    degraded.add(code)
    try {
      const sink = pluginId ? resolveSink(pluginId) : null
      if (!sink || sink === NOOP_SINK) return
      if (typeof sink.isEnabled === 'function') {
        try {
          if (!sink.isEnabled('warn', 'update.log.degraded')) return
        } catch {
          /* 准入判据坏了也照发：selfmon 行的意义就是「别的东西坏了」 */
        }
      }
      sink.fire('warn', 'update.log.degraded', { reason: code })
    } catch {
      /* 自监控自己坏掉时保持沉默：任何外抛都比丢一行更坏 */
    }
  }

  function resolveSink(pluginId: string): LogSink | null {
    try {
      return deps.resolve(pluginId) ?? null
    } catch {
      return null
    }
  }

  function emit(level: string, event: string, fields: Record<string, unknown>, opts?: LogEmitOptions): boolean {
    try {
      const raw = fields && typeof fields === 'object' ? fields : {}
      const pluginId = opts?.pluginId ?? (typeof raw['pluginId'] === 'string' ? (raw['pluginId'] as string) : '')
      if (!pluginId) {
        countDrop('no-plugin-id', pluginId)
        if (mode === 'throw') throw new Error('日志行缺 pluginId：无法路由到落点')
        return false
      }
      const tableNow = table()
      if (tableNow && !checkLogFields(event, Object.keys(raw), tableNow)) {
        const unknownEvent = !tableNow.events?.[event]
        countDrop(unknownEvent ? 'unknown-event' : 'unknown-field', pluginId)
        if (mode === 'throw') throw new Error(`日志事件不合清单：${event}`)
        return false
      }
      const sink = resolveSink(pluginId)
      if (!sink || sink === NOOP_SINK) {
        countDrop('no-sink', pluginId)
        return false
      }
      if (typeof sink.isEnabled === 'function') {
        try {
          if (!sink.isEnabled(level, event)) {
            counts.skipped++
            return false
          }
        } catch {
          /* 准入判据抛错按「开着」处理：宁可多写一行，也不因为判据坏了静默不写 */
        }
      }
      const sanitized = sanitizeLogFields(raw)
      const fingerprint = opts?.fingerprint ?? (isEdgeEvent(event, tableNow) ? fieldFingerprint(sanitized) : undefined)
      if (!opts?.always && typeof fingerprint === 'string') {
        const previous = seen.get(event)
        if (previous === fingerprint) {
          counts.suppressed++
          return false
        }
        seen.set(event, fingerprint)
      }
      sink.fire(level, event, sanitized)
      counts.emitted++
      return true
    } catch (error) {
      countDrop('emit-threw', opts?.pluginId ?? '')
      if (mode === 'throw') throw error
      return false
    }
  }

  return {
    emit,
    counts: () => ({ ...counts, droppedByReason: { ...counts.droppedByReason } }),
    degradedReasons: () => Array.from(degraded),
  }
}

/**
 * 本包进程内的那个发射口：路由走 `updateLogRouter`，清单走随包 JSON。
 * 宿主、共享零件（store 执行器）、将来的接线点全部只调它。
 */
export const updateLogEmitter: LogEmitter = createLogEmitter({
  resolve: (pluginId) => updateLogRouter.resolve(pluginId),
  table: () => currentUpdateEventTable(),
  mode: 'drop',
})

/** 唯一发射口的简写（调用点只写这一行，四项纪律都在里面）。 */
export function emitUpdateLog(
  level: string,
  event: string,
  fields: Record<string, unknown>,
  opts?: LogEmitOptions
): boolean {
  return updateLogEmitter.emit(level, event, fields, opts)
}

/** 丢弃/短路计数出口（诊断面 #125 会把它们摆到面板上，这里先有只读口）。 */
export function logEmitterCounts(): LogEmitterCounts {
  return updateLogEmitter.counts()
}

/**
 * 测试缝：`createLogEmitter` 是工厂，测试各自建实例就拿到彼此隔离的计数与去重记忆，
 * 不需要清模块单例的状态（单例只被生产代码使用，测试不碰它）。
 */
