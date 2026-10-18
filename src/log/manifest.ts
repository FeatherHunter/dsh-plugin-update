/**
 * src/log/manifest.ts —— 随包事件清单的读取与合并（本包事件表的唯一事实源是 JSON）。
 *
 * 为什么运行时也要读这份 JSON 而不是抄一份 TS 常量：`event-list.update.json` 同时是
 * 集成方与门禁读的那一份（`docs/research/20261014-log-event-catalog.md` 是它的人读版）。
 * 抄一份 TS 常量就等于有了两个事实源，早晚分叉；这里读盘一次、进程内缓存，失败回 null 绝不抛。
 *
 * 读取失败（打包漏带文件、只读介质）不是致命事：发射口在没有清单时**不做字段白名单拦截**，
 * 但会如实计 `unvalidated`（不冒充「已过白名单」）、由健康回包报 `state`（#210）。
 * 宁可少一层守卫，也不因为读不到清单就静默不写日志。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cloneEventEntry, parseEventListManifest, mergeUpdateEvents, type GateEventList, type GateEventEntry } from '../gate.js'
import { packageRoot } from './own-version.js'

/** 随包清单的文件名（`package.json files` 白名单里要有它，发布门禁会核）。 */
export const UPDATE_EVENT_LIST_FILE = 'event-list.update.json'

/** 清单加载失败的三种可区分原因（#210：读不到 ≠ 读坏了 ≠ 形状不对）。 */
export type UpdateContractFailure = 'read' | 'json' | 'shape'

/**
 * 契约健康（#210）：回给「健康回包」看的机器状态。
 * `ok` = 清单已加载并通过形状校验；`missing` = 读不到文件；`invalid` = 读到了但 JSON/形状坏；
 * `unloaded` = 还没尝试加载。**没有清单时字段门禁不静默放行**：发射口计 unvalidated，这里如实报状态。
 */
export interface UpdateContractStatus {
  state: 'unloaded' | 'ok' | 'missing' | 'invalid'
  file: string
  // 已加载事件条数（未加载或失败为 0）。
  events: number
  failure?: UpdateContractFailure
}

let cached: GateEventList | null = null
let loaded = false
let liveStatus: UpdateContractStatus = { state: 'unloaded', file: UPDATE_EVENT_LIST_FILE, events: 0 }
let forcedStatus: UpdateContractStatus | null = null

/** 已加载的清单（没加载或加载失败时回 null）。发射口用它做白名单与边沿判据，同步取。 */
export function currentUpdateEventTable(): GateEventList | null {
  return cached
}

/** 契约健康快照（健康回包与诊断用）。 */
export function updateContractStatus(): UpdateContractStatus {
  const status = forcedStatus ?? liveStatus
  return { ...status }
}

/** 测试缝：强制健康状态（真实读文件失败不可在测试里安全模拟，状态判定逻辑已由 load 单测覆盖）。 */
export function __forceUpdateContractStatusForTests(status: UpdateContractStatus | null): void {
  forcedStatus = status
}

/** 立即加载（同步调用点用）。重复调用直接命中缓存。 */
export function primeUpdateEventTable(): void {
  loadUpdateEventTable()
}

/**
 * 读随包清单并解析；任何失败（读不到、JSON 坏、形状不合）都回 null，且把失败缓存住不重试。
 * **同步**是有意的：字段守卫的判据必须当场就有 —— 异步读会让同一行在清单没加载完时放行、
 * 加载完后被拒，行为随微任务时序漂移（#122 抓到的真实差异）。
 *
 * 测试可传 `readText` 注入读到的东西（默认真读包根文件），用来区分三种失败并验健康状态；
 * 传了注入源时照样写进程内缓存与状态，测试之间用 `__resetUpdateEventTableForTests` 清。
 */
export function loadUpdateEventTable(): GateEventList | null {
  if (loaded) return cached
  return loadUpdateEventTableFrom(null)
}

/**
 * 测试缝：用注入的读文件结果走一遍加载（含失败分类与状态写入）。
 * 生产路径不要用 —— 它绕过「只读一次」的缓存纪律，且会改进程内健康状态。
 */
export function __loadUpdateEventTableForTests(readText: () => string): GateEventList | null {
  return loadUpdateEventTableFrom(readText)
}

function loadUpdateEventTableFrom(readText: (() => string) | null): GateEventList | null {
  loaded = true
  const file = UPDATE_EVENT_LIST_FILE
  try {
    const text = readText ? readText() : readFileSync(join(packageRoot(), file), 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      liveStatus = { state: 'invalid', file: file, events: 0, failure: 'json' }
      cached = null
      return null
    }
    try {
      cached = parseEventListManifest(parsed)
    } catch {
      liveStatus = { state: 'invalid', file: file, events: 0, failure: 'shape' }
      cached = null
      return null
    }
    liveStatus = { state: 'ok', file: file, events: Object.keys(cached.events).length }
    return cached
  } catch {
    liveStatus = { state: 'missing', file: file, events: 0, failure: 'read' }
    cached = null
    return null
  }
}

/** 测试与诊断用：清掉进程内缓存（改完清单再读一次的场合）。 */
export function __resetUpdateEventTableForTests(): void {
  cached = null
  loaded = false
  liveStatus = { state: 'unloaded', file: UPDATE_EVENT_LIST_FILE, events: 0 }
  forcedStatus = null
}

/**
 * 建本包实例要交给 dsh-log 的清单：随包清单换个 pluginId（命名空间），
 * 集成方给了自己的清单就合并（本包事件补进去，冲突如实回给调用方处置）。
 * 读不到随包清单时回 null —— 调用方照旧建库（宁可不写字段守卫，也不能没有日志）。
 */
export async function buildUpdateManifest(
  pluginId: string,
  integratorManifest?: unknown
): Promise<{ manifest: GateEventList | null; conflicts: string[]; added: string[] }> {
  const table = loadUpdateEventTable()
  if (!table) return { manifest: null, conflicts: [], added: [] }
  const own: GateEventList = { version: 1, pluginId, events: rebrand(table.events) }
  // 枚举声明跟着清单走：dsh-log 0.3.4 只认条目里的 level/kind/fields/codes/rules/guard，
  // 顶层未知键它收下不用（见 dsh-log dist/config/event-list.js），所以放在顶层既合法又不丢信息。
  if (table.fieldEnums) own.fieldEnums = cloneFieldEnums(table.fieldEnums)
  if (integratorManifest === undefined || integratorManifest === null) {
    return { manifest: own, conflicts: [], added: Object.keys(own.events) }
  }
  try {
    const merged = mergeUpdateEvents(integratorManifest, own)
    return { manifest: merged.manifest, conflicts: merged.conflicts, added: merged.added }
  } catch {
    // 集成方那份清单形状不合：用本包这份（对方的清单问题不该变成「没有日志」）。
    return { manifest: own, conflicts: [], added: Object.keys(own.events) }
  }
}

function rebrand(events: Record<string, GateEventEntry>): Record<string, GateEventEntry> {
  const out: Record<string, GateEventEntry> = {}
  for (const name of Object.keys(events)) out[name] = cloneEventEntry(events[name])
  return out
}

function cloneFieldEnums(
  source: Record<string, Record<string, string[]>>
): Record<string, Record<string, string[]>> {
  const out: Record<string, Record<string, string[]>> = {}
  for (const eventName of Object.keys(source)) {
    const fields: Record<string, string[]> = {}
    for (const field of Object.keys(source[eventName])) fields[field] = source[eventName][field].slice()
    out[eventName] = fields
  }
  return out
}

/** 清单里查一个事件该不该边沿触发（guard 里带「边沿触发」四个字）。找不到即 false。 */
export function isEdgeEvent(event: string, table: GateEventList | null = cached): boolean {
  try {
    const entry = table?.events?.[event]
    return typeof entry?.guard === 'string' && entry.guard.indexOf('边沿触发') >= 0
  } catch {
    return false
  }
}

export { mergeUpdateEvents }
