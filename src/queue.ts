// src/queue.ts —— 跨插件单队列串行的纯决策（#15）。
//
// 全程用“更新系统”指更新功能本身，用“更新包”指装着更新系统的这个 npm 包。
// 电话指宿主对外提供的方法；落盘指宿主统一写本地文件的动作。
//
// 归属（拥有者与持久化）：队列按使用范围共享——同一 (homeDir, profileDir)
// 的全部插件共用一个队列文件，与 `updates/<插件标识>/<指纹>` 那棵按插件隔离的
// 树完全分开（目录见 store.ts 的 queuePathsForUpdate，父目录不同，任何插件标识
// 都撞不上）。快照六字段、配方五键、三个电话名一字不动；队列经独立纯函数与
// 电话的可选参数进出，不碰冻结形状。
//
// 公平：先进先出。同一 (pluginId, requestId) 幂等占一位；队首才有资格抢全局锁，
// 非队首直接报 update-busy（沿用旧码，不新增码）；拥有者（owner）一次只装一个。
// 意向过期：waiting 里超过 ttlMs 未被消费的条目在读写时惰性丢弃（调用方传 nowMs
// 与 ttlMs，默认见 QUEUE_INTENT_TTL_MS）。
//
// 取消：waiting 里只能取消自己的条目（pluginId 必须对上）；owner 不经队列取消——
// 安装一旦开始，只能等它收尾（成功/失败/超时）或走宿主取消（#14），不能经队列摘牌。
// 面板可见性开关：包提供全面功能（owner + 全 waiting + 全队列位置），消费者传
// showOthers 决定是否看他人项（false 时他人项隐藏，owner 仅露 busy 占位）。
//
// 本文件零导入、纯函数、无 Node/浏览器专属能力，两边都跑得动；落盘与加锁在
// store.ts（Node 侧），展示过滤两边复用同一套。

/** 队列意向默认有效期：10 分钟（与凭证有效期同口径，调用方可覆盖）。 */
export const QUEUE_INTENT_TTL_MS = 10 * 60_000

/** 正在安装的拥有者（一次只能有一个，与全局锁持有者一一对应）。 */
export interface QueueOwner {
  pluginId: string
  jobId: string
  requestId: string | null
  targetVersion: string | null
  startedAt: number
}

/** 排队中的安装意向（尚未开始装，只占位）。 */
export interface QueuedEntry {
  pluginId: string
  requestId: string | null
  targetVersion: string | null
  enqueuedAt: number
}

/** 队列落盘形状（版本号锁死为 1，收到别的数字按空队列处理，不抛错）。 */
export interface UpdateQueueState {
  version: 1
  owner: QueueOwner | null
  waiting: QueuedEntry[]
}

/** 空队列（调用方拿它当起点，落盘文件缺失或损坏时同样回退到它）。 */
export function emptyQueueState(): UpdateQueueState {
  return { version: 1, owner: null, waiting: [] }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function asMillis(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/** 把外面读到的值验成可用的队列：错了不抛错，直接回空队列（队列坏了不能挡安装）。 */
export function normalizeQueueState(raw: unknown): UpdateQueueState {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyQueueState()
    const input = raw as Record<string, unknown>
    if (input['version'] !== 1) return emptyQueueState()
    let owner: QueueOwner | null = null
    const rawOwner = input['owner']
    if (rawOwner && typeof rawOwner === 'object' && !Array.isArray(rawOwner)) {
      const o = rawOwner as Record<string, unknown>
      if (isNonEmptyString(o['pluginId']) && isNonEmptyString(o['jobId'])) {
        owner = {
          pluginId: o['pluginId'] as string,
          jobId: o['jobId'] as string,
          requestId: typeof o['requestId'] === 'string' ? (o['requestId'] as string) : null,
          targetVersion: typeof o['targetVersion'] === 'string' ? (o['targetVersion'] as string) : null,
          startedAt: asMillis(o['startedAt'], 0),
        }
      }
    }
    const waiting: QueuedEntry[] = []
    const rawWaiting = input['waiting']
    if (Array.isArray(rawWaiting)) {
      for (const item of rawWaiting) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue
        const e = item as Record<string, unknown>
        if (!isNonEmptyString(e['pluginId'])) continue
        waiting.push({
          pluginId: e['pluginId'] as string,
          requestId: typeof e['requestId'] === 'string' ? (e['requestId'] as string) : null,
          targetVersion: typeof e['targetVersion'] === 'string' ? (e['targetVersion'] as string) : null,
          enqueuedAt: asMillis(e['enqueuedAt'], 0),
        })
      }
    }
    return { version: 1, owner, waiting }
  } catch {
    return emptyQueueState()
  }
}

function sameIntent(a: { pluginId: string; requestId: string | null }, b: { pluginId: string; requestId: string | null }): boolean {
  return a.pluginId === b.pluginId && (a.requestId ?? null) === (b.requestId ?? null)
}

/** 丢弃过期的 waiting 意向（owner 不过期——它由全局锁与安装时限看守，不由这里清）。 */
export function pruneExpiredIntents(
  state: UpdateQueueState,
  nowMs: number,
  ttlMs: number = QUEUE_INTENT_TTL_MS
): UpdateQueueState {
  const now = asMillis(nowMs, 0)
  const ttl = typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : QUEUE_INTENT_TTL_MS
  const waiting = state.waiting.filter((e) => now - asMillis(e.enqueuedAt, now) < ttl)
  if (waiting.length === state.waiting.length) return state
  return { version: 1, owner: state.owner, waiting }
}

/**
 * 占位：同一 (pluginId, requestId) 幂等占一位，已在即返回旧位置不挪位。
 * 位置口径：0 = 已是拥有者，1..n = waiting 中的顺位（队首为 1），与 visibleQueueFor 的
 * position 同口径。targetVersion 仅作展示用，不参与身份判定；已在时不覆盖旧条目。
 */
export function enqueueInQueue(
  state: UpdateQueueState,
  entry: { pluginId: string; requestId?: string | null; targetVersion?: string | null; enqueuedAt: number }
): { state: UpdateQueueState; position: number | null } {
  const base = normalizeQueueState(state)
  if (!isNonEmptyString(entry.pluginId)) return { state: base, position: null }
  const key = { pluginId: entry.pluginId, requestId: entry.requestId ?? null }
  if (base.owner && sameIntent(base.owner, key)) return { state: base, position: 0 }
  const at = base.waiting.findIndex((e) => sameIntent(e, key))
  if (at >= 0) return { state: base, position: at + 1 }
  const next: QueuedEntry = {
    pluginId: entry.pluginId,
    requestId: entry.requestId ?? null,
    targetVersion: typeof entry.targetVersion === 'string' ? entry.targetVersion : null,
    enqueuedAt: asMillis(entry.enqueuedAt, 0),
  }
  const waiting = [...base.waiting, next]
  return { state: { version: 1 as const, owner: base.owner, waiting }, position: waiting.length }
}

/**
 * 取消排队意向：只能取消自己的 waiting 条目（pluginId 必须对上），owner 不经这里取消。
 * 对不上（他人的条目、owner、查无此人）返回 removed: false 且状态原样。
 */
export function cancelEnqueuedInQueue(
  state: UpdateQueueState,
  pluginId: string,
  requestId: string | null
): { state: UpdateQueueState; removed: boolean } {
  const base = normalizeQueueState(state)
  if (!isNonEmptyString(pluginId)) return { state: base, removed: false }
  const key = { pluginId, requestId: requestId ?? null }
  // 拥有者不经队列取消：安装已开始，只能等收尾或走宿主取消。
  if (base.owner && sameIntent(base.owner, key)) return { state: base, removed: false }
  const at = base.waiting.findIndex((e) => sameIntent(e, key))
  if (at < 0) return { state: base, removed: false }
  const waiting = [...base.waiting.slice(0, at), ...base.waiting.slice(at + 1)]
  return { state: { version: 1 as const, owner: base.owner, waiting }, removed: true }
}

/** 拥有者收尾：只有 (pluginId, jobId) 双对上才清掉，对不上原样（不替别人摘牌）。 */
export function releaseOwnerInQueue(
  state: UpdateQueueState,
  pluginId: string,
  jobId: string
): { state: UpdateQueueState; released: boolean } {
  const base = normalizeQueueState(state)
  if (!isNonEmptyString(pluginId) || !isNonEmptyString(jobId)) return { state: base, released: false }
  if (!base.owner || base.owner.pluginId !== pluginId || base.owner.jobId !== jobId) {
    return { state: base, released: false }
  }
  return { state: { version: 1 as const, owner: null, waiting: base.waiting }, released: true }
}

/** 把队首意向提为拥有者（调用方抢到全局锁后记账用；队空或信息不全返回 promoted: false）。 */
export function promoteHeadToOwner(
  state: UpdateQueueState,
  args: { jobId: string; startedAt: number }
): { state: UpdateQueueState; promoted: boolean } {
  const base = normalizeQueueState(state)
  if (base.owner || base.waiting.length === 0) return { state: base, promoted: false }
  if (!isNonEmptyString(args.jobId)) return { state: base, promoted: false }
  const [head, ...rest] = base.waiting
  const owner: QueueOwner = {
    pluginId: head.pluginId,
    jobId: args.jobId,
    requestId: head.requestId,
    targetVersion: head.targetVersion,
    startedAt: asMillis(args.startedAt, 0),
  }
  return { state: { version: 1 as const, owner, waiting: rest }, promoted: true }
}

/** 直接记拥有者（抢到全局锁但 waiting 里没有自己意向时的兜底记账；已有 owner 不覆盖）。 */
export function setOwnerIfFree(
  state: UpdateQueueState,
  owner: { pluginId: string; jobId: string; requestId?: string | null; targetVersion?: string | null; startedAt: number }
): { state: UpdateQueueState; set: boolean } {
  const base = normalizeQueueState(state)
  if (base.owner) return { state: base, set: false }
  if (!isNonEmptyString(owner.pluginId) || !isNonEmptyString(owner.jobId)) return { state: base, set: false }
  return {
    state: {
      version: 1 as const,
      owner: {
        pluginId: owner.pluginId,
        jobId: owner.jobId,
        requestId: owner.requestId ?? null,
        targetVersion: typeof owner.targetVersion === 'string' ? owner.targetVersion : null,
        startedAt: asMillis(owner.startedAt, 0),
      },
      // 抢到锁即消费自己的队首意向（若有），不留僵尸占位。
      waiting: base.waiting.filter((e) => !sameIntent(e, { pluginId: owner.pluginId, requestId: owner.requestId ?? null })),
    },
    set: true,
  }
}

/**
 * 查位置：0 = 正拥有全局锁在装，1..n = waiting 顺位（队首为 1），null = 不在队列里。
 * 面板拿它展示“前方还有 N 个”，不展开他人明细也能排得明白。
 */
export function queuePositionOf(
  state: UpdateQueueState,
  pluginId: string,
  requestId: string | null
): number | null {
  const base = normalizeQueueState(state)
  if (!isNonEmptyString(pluginId)) return null
  const key = { pluginId, requestId: requestId ?? null }
  if (base.owner && sameIntent(base.owner, key)) return 0
  const at = base.waiting.findIndex((e) => sameIntent(e, key))
  return at >= 0 ? at + 1 : null
}

/** 队首是不是我（公平门：非队首不许抢锁；队空时人人都是队首）。 */
export function isHeadOfQueue(
  state: UpdateQueueState,
  pluginId: string,
  requestId: string | null
): boolean {
  const base = normalizeQueueState(state)
  if (!isNonEmptyString(pluginId)) return false
  if (base.waiting.length === 0) return true
  const head = base.waiting[0]
  return head.pluginId === pluginId && (head.requestId ?? null) === (requestId ?? null)
}

/** 全局是否正忙（有人拥有锁在装）。 */
export function isQueueBusy(state: UpdateQueueState): boolean {
  return normalizeQueueState(state).owner !== null
}

export interface VisibleQueueOwner {
  /** 他人拥有时仅露 busy 占位（pluginId 为 null），不露标识；自己拥有时给全量。 */
  pluginId: string | null
  jobId?: string
  requestId?: string | null
  targetVersion?: string | null
  startedAt?: number
  busy: true
}

export interface VisibleQueue {
  busy: boolean
  /** 未隐藏时为全量 owner；隐藏他人时他人 owner 折成 {pluginId: null, busy: true}；空闲为 null。 */
  owner: QueueOwner | VisibleQueueOwner | null
  /** 未隐藏时为全 waiting；隐藏时仅留查看者自己的。 */
  waiting: QueuedEntry[]
  /** 查看者在全队列中的位置（0 = 在装，1..n = 顺位，null = 不在队列），隐藏时同样给（只给数不给明细）。 */
  position: number | null
}

/**
 * 面板可见性开关：包提供全面功能，消费者传参决定是否看他人项。
 * - showOthers=true：owner + waiting 全量。
 * - showOthers=false（默认）：waiting 仅留自己的；owner 是自己的给全量，是他人的折成
 *   busy 占位（能显示“前方有其他插件在安装”，但看不到是哪一家）。
 */
export function visibleQueueFor(
  state: UpdateQueueState,
  viewerPluginId: string,
  showOthers = false,
  requestId?: string | null
): VisibleQueue {
  const base = normalizeQueueState(state)
  // 位置口径：调用方给了 requestId 就按它精确算；没给（查状态顺带看一眼）就取自己最靠前的占位。
  const rid = requestId === undefined ? derivedRequestId(base, viewerPluginId) : (requestId ?? null)
  const position = isNonEmptyString(viewerPluginId) ? queuePositionOf(base, viewerPluginId, rid) : null
  if (showOthers === true) {
    return { busy: base.owner !== null, owner: base.owner, waiting: [...base.waiting], position }
  }
  const mine = isNonEmptyString(viewerPluginId) ? base.waiting.filter((e) => e.pluginId === viewerPluginId) : []
  let owner: QueueOwner | VisibleQueueOwner | null = null
  if (base.owner) {
    if (base.owner.pluginId === viewerPluginId) owner = base.owner
    else owner = { pluginId: null, busy: true as const }
  }
  return { busy: base.owner !== null, owner, waiting: mine, position }
}

/**
 * 隐藏模式下位置的归属：同一插件可能有多个 requestId 占位，取最靠前的那个；
 * 一个没有时为 null（面板“查状态顺带看一眼是否在队里”走这条，不用先编 requestId）。
 */
function derivedRequestId(state: UpdateQueueState, viewerPluginId: string): string | null {
  const mine = state.waiting.filter((e) => e.pluginId === viewerPluginId)
  if (state.owner && state.owner.pluginId === viewerPluginId) return state.owner.requestId
  if (mine.length === 0) return null
  return mine[0].requestId
}
