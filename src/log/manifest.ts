/**
 * src/log/manifest.ts —— 随包事件清单的读取与合并（本包事件表的唯一事实源是 JSON）。
 *
 * 为什么运行时也要读这份 JSON 而不是抄一份 TS 常量：`event-list.update.json` 同时是
 * 集成方与门禁读的那一份（`docs/research/20261014-log-event-catalog.md` 是它的人读版）。
 * 抄一份 TS 常量就等于有了两个事实源，早晚分叉；这里读盘一次、进程内缓存，失败回 null 绝不抛。
 *
 * 读取失败（打包漏带文件、只读介质）不是致命事：发射口在没有清单时**不做字段白名单拦截**，
 * 只由接线层记一条 `update.log.degraded`。宁可少一层守卫，也不因为读不到清单就静默不写日志。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEventListManifest, lintEventFields, mergeUpdateEvents, type GateEventList, type GateEventEntry } from '../gate.js'
import { packageRoot } from './own-version.js'

/** 随包清单的文件名（`package.json files` 白名单里要有它，发布门禁会核）。 */
export const UPDATE_EVENT_LIST_FILE = 'event-list.update.json'

let cached: GateEventList | null = null
let loaded = false

/** 已加载的清单（没加载或加载失败时回 null）。发射口用它做白名单与边沿判据，同步取。 */
export function currentUpdateEventTable(): GateEventList | null {
  return cached
}

/** 立即加载（同步调用点用）。重复调用直接命中缓存。 */
export function primeUpdateEventTable(): void {
  loadUpdateEventTable()
}

/**
 * 读随包清单并解析；任何失败（读不到、JSON 坏、形状不合）都回 null，且把失败缓存住不重试。
 * **同步**是有意的：字段守卫的判据必须当场就有 —— 异步读会让同一行在清单没加载完时放行、
 * 加载完后被拒，行为随微任务时序漂移（#122 抓到的真实差异）。
 */
export function loadUpdateEventTable(): GateEventList | null {
  if (loaded) return cached
  loaded = true
  try {
    // 包根算式与 own-version.ts 共用一份（dist/log/*.js 往上三层）。
    const path = join(packageRoot(), UPDATE_EVENT_LIST_FILE)
    const text = readFileSync(path, 'utf8')
    cached = parseEventListManifest(JSON.parse(text) as unknown)
  } catch {
    cached = null
  }
  return cached
}

/** 测试与诊断用：清掉进程内缓存（改完清单再读一次的场合）。 */
export function __resetUpdateEventTableForTests(): void {
  cached = null
  loaded = false
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
  for (const name of Object.keys(events)) {
    const entry = events[name]
    const copy: GateEventEntry = { level: entry.level, kind: entry.kind, fields: entry.fields.slice() }
    if (entry.codes) copy.codes = entry.codes.slice()
    if (entry.rules) copy.rules = entry.rules.slice()
    if (entry.guard !== undefined) copy.guard = entry.guard
    out[name] = copy
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

/** 字段白名单判据（0.3.1 的 lintEventFields）：未知事件与未知字段都算不通过。 */
export function checkLogFields(event: string, fieldNames: string[], table: GateEventList | null = cached): boolean {
  if (!table) return true
  try {
    return lintEventFields(table, event, fieldNames).ok
  } catch {
    return true
  }
}

export { mergeUpdateEvents }
