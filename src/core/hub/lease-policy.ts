// src/core/hub/lease-policy.ts —— 中枢「唯一驱动者租约」：谁现在算驾驶位、什么时候该让位/该接管。
//
// 第一性：怀疑自己不再是驾驶位时什么都不做，比做一次错的安装便宜得多。所以判决只有四种：
//   - acquire：盘上还没有租约，我上任（generation=1）；
//   - renew  ：租约还是我的，续任（generation 不变）；
//   - takeover：原驾驶者已失联（心跳过期，含进程活着但假死）/已死，我顶上（generation+1，旧者下次心跳必然失配）；
//   - wait   ：驾驶者心跳未过期，我什么都不做。
//
// 纪律：本文件零 IO；「进程还活着吗」「现在几点」都由调用方给事实，函数只给判决（纯函数可单测）。
//   generation 单调递增是防「双驾驶」的唯一开关：旧 generation 的写回必须被判为非属主。

/** 租约格式版本（收到别的数字按「读不懂」处理）。 */
export const HUB_LEASE_VERSION = 1

/** 驾驶者多久心跳一次。 */
export const HUB_LEASE_HEARTBEAT_MS = 5_000

/** 心跳多久没更新就算失联（默认 20s：比单次安装轮询上限宽松，又不至于挂死太久）。 */
export const HUB_LEASE_STALE_MS = 20_000

/** 驾驶者标识上限（自解释：中枢实例名，不是用户输入）。 */
export const HUB_MAX_DRIVER_ID_LENGTH = 128

/**
 * 盘上的驾驶者租约（JSON 形状即协议，宿主两个进程版本共存时按它协商）。
 * 字段全是最小事实：谁、哪个插件、哪个进程、什么时候开始、最后一次心跳、第几代。
 */
export interface HubLease {
  version: typeof HUB_LEASE_VERSION
  /** 驾驶者实例标识（宿主进程级，形如 dsh-hub:<pid>:<random>）。 */
  driverId: string
  /** 当前驾驶者插件标识（排障用：复现「是谁在推」）。 */
  pluginId: string
  /** 宿主进程号（同机可据此判断是否还活着；跨机/沙箱不可靠，只作线索）。 */
  pid: number
  /** 上任时刻（毫秒）。 */
  startedAt: number
  /** 最后一次心跳（毫秒）。 */
  heartbeatAt: number
  /** 第几代驾驶者；每接管一次 +1，旧代写回必须被拒。 */
  generation: number
}

/** 租约判决。 */
export type HubLeaseDecision =
  | { kind: 'acquire'; generation: number }
  | { kind: 'renew'; generation: number }
  | { kind: 'takeover'; generation: number }
  | { kind: 'wait' }

/** 判决输入：现租约 + 事实（不读盘、不读钟）。 */
export interface HubLeaseDecisionInput {
  /** 现租约（盘上读到的原样对象；坏值按「没有租约」处理）。 */
  current: unknown
  /** 我方驾驶者标识。 */
  driverId: string
  /** 现在几点（毫秒）。 */
  now: number
  /**
   * 现租约进程是否还活着：true=进程还在（仅说明没死；是否接管仍按心跳判）；
   * false=已死（立即接管）；null/缺省=不知道（按心跳是否过期决定）。
   */
  processAlive?: boolean | null
  /** 覆盖租约过期阈值（测试用；缺省 HUB_LEASE_STALE_MS）。 */
  staleMs?: number
}

/** 驾驶者标识合法性：非空、长度封顶、只含可安全出现在文件名里的字符。 */
export function isHubDriverId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= HUB_MAX_DRIVER_ID_LENGTH && /^[A-Za-z0-9._:-]+$/.test(trimmed)
}

/** 造一份租约。参数坏值就地归一（不抛）：中枢宁可带一份保守租约上任，也不该在上任前崩。 */
export function createHubLease(args: {
  driverId: string
  pluginId: string
  pid: number
  now: number
  generation?: number
}): HubLease {
  const now = asMillis(args?.now)
  return {
    version: HUB_LEASE_VERSION,
    driverId: isHubDriverId(args?.driverId) ? args.driverId.trim() : 'unknown-driver',
    pluginId: asText(args?.pluginId) ?? 'unknown-plugin',
    pid: asProcessId(args?.pid),
    startedAt: now,
    heartbeatAt: now,
    generation: asGeneration(args?.generation, 1),
  }
}

/** 读盘后的租约归一：任何坏值 → null（不猜测、不复用半个租约）。 */
export function normalizeHubLease(raw: unknown): HubLease | null {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const input = raw as Record<string, unknown>
    if (input['version'] !== HUB_LEASE_VERSION) return null
    const driverId = input['driverId']
    const pluginId = asText(input['pluginId'])
    const pid = asProcessId(input['pid'])
    const startedAt = input['startedAt']
    if (!isHubDriverId(driverId) || !pluginId) return null
    if (typeof pid !== 'number' || pid < 0) return null
    if (!isMillis(startedAt)) return null
    const heartbeatAt = isMillis(input['heartbeatAt']) ? input['heartbeatAt'] : startedAt
    return {
      version: HUB_LEASE_VERSION,
      driverId: driverId.trim(),
      pluginId,
      pid,
      startedAt,
      heartbeatAt,
      generation: asGeneration(input['generation'], 1),
    }
  } catch {
    return null
  }
}

/** 判驾驶位。永不抛：任何不确定都落到 'wait'（宁可不动，也不抢一次错的安装）。 */
export function decideHubLease(input: HubLeaseDecisionInput): HubLeaseDecision {
  try {
    if (!input || typeof input !== 'object' || !isHubDriverId(input.driverId)) return { kind: 'wait' }
    const now = isMillis(input.now) ? input.now : 0
    const current = normalizeHubLease(input.current)
    if (!current) return { kind: 'acquire', generation: 1 }
    if (current.driverId === input.driverId.trim()) return { kind: 'renew', generation: current.generation }
    // 进程已死：立即接管。进程活着也按心跳判——心跳过期就当它失联（假死）；
    // 长安装步骤若超过陈旧窗口会被误判，由全局锁与幂等安装请求兜底，只有心跳新鲜才算真有人在推。
    if (input.processAlive === false) return { kind: 'takeover', generation: current.generation + 1 }
    const staleMs = typeof input.staleMs === 'number' && Number.isFinite(input.staleMs) && input.staleMs > 0 ? input.staleMs : HUB_LEASE_STALE_MS
    if (now - current.heartbeatAt >= staleMs) return { kind: 'takeover', generation: current.generation + 1 }
    return { kind: 'wait' }
  } catch {
    return { kind: 'wait' }
  }
}

/** 我是不是这份（已被归一的）租约的属主；给 generation 时还必须对上代次。 */
export function isHubLeaseOwner(lease: HubLease | null | undefined, driverId: string, generation?: number): boolean {
  if (!lease || !isHubDriverId(driverId)) return false
  if (lease.driverId !== driverId.trim()) return false
  return typeof generation !== 'number' || lease.generation === generation
}

/** 该续心跳了吗（纯判据：到点才写盘，别把 5s 心跳写成忙等）。永不抛。 */
export function shouldHeartbeatHubLease(lease: unknown, now: number, intervalMs?: number): boolean {
  try {
    const normalized = normalizeHubLease(lease)
    if (!normalized || !isMillis(now)) return false
    const interval = typeof intervalMs === 'number' && Number.isFinite(intervalMs) && intervalMs >= 1_000 ? Math.min(intervalMs, 60_000) : HUB_LEASE_HEARTBEAT_MS
    return now - normalized.heartbeatAt >= interval
  } catch {
    return false
  }
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asMillis(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

function isMillis(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function asProcessId(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

function asGeneration(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : fallback
}
