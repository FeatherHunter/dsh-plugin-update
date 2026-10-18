/**
 * 日志健康（#212）——回包里「日志是空的」的机器可读判据。
 *
 * 这里只放对外形状。取值一律来自本进程的真实接线状态与引擎自述，
 * 不含任何目录路径（目录只用 8 位指纹，算式与日志行 logDirHash 相同）。
 * 混入本模块的类型进 `./log` 公共出口，再从 host.ts 重新导出给主入口消费者。
 */
import { logEmitterCountsFor, type LogPluginCounts } from './emit.js'
import { updateContractStatus, type UpdateContractStatus } from './manifest.js'
import type { OwnLogHandle } from './registry.js'
import type { PendingLogSink } from './sink.js'

/** 落点类型。pending 是自建实例异步建库期间的瞬时态，稍后重查即落定。 */
export type LogHealthSink = 'pending' | 'external' | 'self' | 'off'

/** external 落点的可验证性：对方引擎确认放行 / 明确未放行 / 没给判据（未验证）。 */
export type LogHealthExternalGate = 'open' | 'closed' | 'unknown'

/** off 落点的原因码（与 `update.log.degraded` 同一套降级原因）。 */
export type LogHealthOffReason = 'no-dsh-log' | 'lease-conflict' | 'write-fail'

/** 事件契约状态（与回包 `logContract.state` 同源）。 */
export type LogHealthContractState = 'unloaded' | 'ok' | 'missing' | 'invalid'

/** `updateStatus` 成功回包里的可选日志健康读数。老宿主不回这个键。 */
export interface UpdateLogHealth {
  /** 落点类型：external=集成方实例，self=本包自建，off=没接上，pending=建库中。 */
  sink: LogHealthSink
  /** 8 位目录指纹（与日志行 `logDirHash` 同一算式）；external 为 null（对方目录本包不猜）。 */
  dirHash: string | null
  /** 按需信息开关：self 取引擎自述；external/off/pending 为 null（-切换要重启宿主后才生效）。 */
  switchEnabled: boolean | null
  /** 启动以来没落进文件的日志行数：发射口丢弃 + 待接缓冲丢弃 + self 引擎自述丢弃。 */
  droppedSinceStart: number
  /** 最近一次把行交给落点的时间（epoch ms）；启动以来一行都没到过落点为 null。 */
  lastEventAt: number | null
  /** 事件契约状态：missing/invalid 时字段门禁这轮没有尺子。 */
  contract: LogHealthContractState
  /** external 专属：open=对方引擎确认放行，closed=明确未放行，unknown=未验证（对方没给判据）。 */
  external: LogHealthExternalGate | null
  /** off 专属原因；其余落点为 null。 */
  reason: LogHealthOffReason | null
}

/**
 * 接线状态（`wireUpdateLog` 的返回值）：**一份可变的活状态**，由 `createHostUpdate` 持有。
 * 自建实例是异步的，所以落点会从 pending 变到 self 或 off；外部实例一接线就定。
 * 这里只放「事实」（谁在写、写到哪、为什么没写成），**不放目录路径**。
 */
export interface UpdateLogWiring {
  pluginId: string
  /** 当前落点类型。 */
  sink: LogHealthSink
  /** 目录指纹（8 位）；external 时为 null（对方目录本包不猜）。 */
  dirHash: string | null
  /** external 专属：对方引擎的准入判据结论。 */
  external: LogHealthExternalGate | null
  /** off 专属原因码；其余为 null。 */
  reason: LogHealthOffReason | null
  /** 自建路径上的待接落点（还没接上/接不上时，缓冲丢弃数从它读）。 */
  pendingSink: PendingLogSink | null
  /** 自建成功后的引擎句柄（开关与丢弃数的来源）。 */
  handle: OwnLogHandle | null
}

/** 引擎自述里健康读数用得着的两格（从 `OwnLogHandle.health()` 收窄出来）。 */
export interface LogHealthEngineReport {
  switchEnabled: boolean | null
  dropped: number
}

/**
 * 取值口（测试可注入）：默认全部走进程里的真实读数；
 * 注入时纯函数化 —— 这样「映射对不对」与「接线对不对」是两组独立可证的命题。
 */
export interface LogHealthDeps {
  counts?: (pluginId: string) => LogPluginCounts
  contract?: () => UpdateContractStatus['state']
  engine?: (handle: OwnLogHandle) => LogHealthEngineReport | null
  pendingDropped?: (pending: PendingLogSink) => number
}

const ZERO_COUNTS: LogPluginCounts = { emitted: 0, skipped: 0, dropped: 0, lastEventAt: null }
const CONTRACT_STATES: readonly LogHealthContractState[] = ['unloaded', 'ok', 'missing', 'invalid']
const SINKS: readonly LogHealthSink[] = ['pending', 'external', 'self', 'off']

/** 计数只认「有限且非负」的数：NaN / Infinity / 负数一律按 0（不许冒充丢弃数）。 */
function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

/** 时间戳同样只认有限正数；取不到就是「没记到」（null）。 */
function safeTime(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/** 开关只认真布尔：引擎自述坏掉（回字符串/数字）时如实报「问不出来」，不许猜。 */
function safeSwitch(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function normalizeContract(value: unknown): LogHealthContractState {
  return CONTRACT_STATES.includes(value as LogHealthContractState) ? (value as LogHealthContractState) : 'unloaded'
}

function normalizeSink(value: unknown): LogHealthSink {
  return SINKS.includes(value as LogHealthSink) ? (value as LogHealthSink) : 'pending'
}

function readCounts(deps: LogHealthDeps, pluginId: string): LogPluginCounts {
  try {
    return deps.counts ? deps.counts(pluginId) : logEmitterCountsFor(pluginId)
  } catch {
    return ZERO_COUNTS
  }
}

function readContract(deps: LogHealthDeps): LogHealthContractState {
  try {
    return normalizeContract(deps.contract ? deps.contract() : updateContractStatus().state)
  } catch {
    return 'unloaded'
  }
}

/** 引擎自述坏了就当「问不出来」（null），绝不让读数本身把回包打挂。 */
function readEngine(deps: LogHealthDeps, handle: OwnLogHandle): LogHealthEngineReport | null {
  try {
    if (deps.engine) return deps.engine(handle)
    const report = handle.health()
    return { switchEnabled: typeof report.switchEnabled === 'boolean' ? report.switchEnabled : null, dropped: safeCount(report.dropped) }
  } catch {
    return null
  }
}

function readPendingDropped(deps: LogHealthDeps, pending: PendingLogSink): number {
  try {
    return safeCount(deps.pendingDropped ? deps.pendingDropped(pending) : pending.droppedCount())
  } catch {
    return 0
  }
}

/**
 * 接线状态 → 回包读数（`updateStatus` 成功回包的可选 `logHealth`）。
 *
 * 三条口径（写死在这里，别处在读之前不许再加工）：
 *   1. `dirHash` 只对**本包自己写/本该自己写**的目录给指纹；external 一律 null —— 对方的目录本包不猜。
 *   2. `switchEnabled` 只对 self 有意义（开关文件在那个目录里）；其余落点为 null。
 *   3. `lastEventAt` 与 off 互斥：没有落点时一行也没到过落点，缓冲里转一圈又倒掉的不算。
 * 没有接线状态（老宿主形状）时回 null：回包不带这个键，老调用形状一字不变。
 */
export function buildUpdateLogHealth(wiring: UpdateLogWiring | null | undefined, deps: LogHealthDeps = {}): UpdateLogHealth | null {
  if (!wiring || typeof wiring !== 'object' || typeof wiring.pluginId !== 'string' || !wiring.pluginId) return null
  const sink = normalizeSink(wiring.sink)
  const counts = readCounts(deps, wiring.pluginId)
  const engine = wiring.handle ? readEngine(deps, wiring.handle) : null
  const pendingDropped = wiring.pendingSink ? readPendingDropped(deps, wiring.pendingSink) : 0
  return {
    sink,
    // external 一律 null：对方写到哪本包不猜（wiring 里给了也不外放）。
    dirHash: sink === 'external' ? null : typeof wiring.dirHash === 'string' && wiring.dirHash ? wiring.dirHash : null,
    switchEnabled: sink === 'self' ? safeSwitch(engine?.switchEnabled) : null,
    // 三处丢弃相加：发射口（没落点/坏行）+ 待接缓冲（建库期间的溢出与倒掉）+ 引擎自述（落盘侧）。
    droppedSinceStart: safeCount(counts.dropped) + pendingDropped + safeCount(engine?.dropped),
    // off 与「到过落点」互斥：没有落点时一行也没到过落点，缓冲里转一圈又倒掉的不算。
    lastEventAt: sink === 'off' ? null : safeTime(counts.lastEventAt),
    contract: readContract(deps),
    external: sink === 'external' ? wiring.external ?? 'unknown' : null,
    reason: sink === 'off' ? wiring.reason ?? null : null,
  }
}

