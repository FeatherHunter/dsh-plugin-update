/**
 * src/log/registry.ts —— 同进程内「一个日志目录一个句柄」的登记表（自建实例的唯一入口）。
 *
 * 为什么必须是 globalThis：dsh-log 的目录租约登记表是**模块副本级**的，跨副本互相看不见；
 * 而本包在同一进程里出现两份副本是现实（顶层 `dsh-plugin-update@0.13.0` 与别的插件嵌套的 0.12.0）。
 * 两份副本各自 `createNodeHostLog` 同一个目录时，谁都不知道对方在写 —— 后写的会把先写的整份文件吃掉
 * （dsh-log 实测：10 行剩 9 行）。所以登记表挂在 `globalThis[Symbol.for('dsh-plugin-update.log.registry')]`：
 * 同进程所有副本共用一张表，同一目录只有一个句柄，第二份副本拿到的是**同一个**实例。
 *
 * 三条硬纪律：
 *   1. **绝不外抛**：建库失败一律降级成「没有落点」，由调用方记 selfmon 行；
 *   2. **卡死不得变永久死**：撞租约先退避重试，再降级；降级带冷却，冷却过后下一次接线会重新试
 *      （插件重装、面板重挂都会再调一次接线，这就是恢复路径）；
 *   3. **跨进程不做承诺**：另一个进程在写同一目录，本表看不见，dsh-log 自己也只能事后诊断
 *      （`log.persist.fail reason:'foreign-write'`）。这条边界写进 ADR-0005，不假装做到。
 */
import { join } from 'node:path'
import { hashToken, logDirKey, logSwitchFileName } from './namespace.js'
import { sinkFromStore, type LogSink } from './sink.js'
import { ownPackageVersion } from './own-version.js'
import type { GateEventList } from '../gate.js'

/** 登记表在 globalThis 上的键（Symbol.for：跨副本、跨包副本同名同键）。 */
export const OWN_LOG_REGISTRY_KEY = 'dsh-plugin-update.log.registry'

/** 降级原因（与事件目录里 `update.log.degraded` 的取值一一对应）。 */
export type OwnLogDegradeReason = 'no-dsh-log' | 'lease-conflict' | 'write-fail'

export interface OwnLogStore {
  log: (level: string, event: string, fields: Record<string, unknown>) => unknown
  isEnabled?: (level: string, event?: string) => boolean
  getDroppedCount?: () => number
  /**
   * 按需信息开关的当前状态（#212）。dsh-log 0.3.x 的 store 回 `{ enabled: boolean }`；
   * 也认「直接回布尔」的自建实现。取不到就是 null（未验证），绝不当成 false 或 true 猜。
   */
  getSwitchState?: () => boolean | { enabled?: unknown }
  getLastPersistFail?: () => { op?: string; reason?: string; dirHash?: string; at?: number } | null
  /**
   * 把已排队行推落到磁盘（dsh-log 0.3.4 起的 HostLog 有；老实现可能没有）。
   * `synced()` 只保证「已经落到磁盘」，`flushNow()` 是主动催一次——flushUpdateLog 优先用它。
   */
  flushNow?: () => Promise<void>
  synced?: () => Promise<void>
  /** 仍未落盘的行数（尽力估计；取不到就是不知道，按 0 计）。 */
  getPendingCount?: () => number
  release?: () => void
}

export interface OwnLogHandle {
  /** 派生命名空间（目录名、开关文件名、dsh-log 的 pluginId 都是它）。 */
  namespace: string
  /** 日志目录绝对路径。 */
  dir: string
  /** 引用计数：同一目录被多个调用点借走时只建一次，全部还回来才释放。 */
  refs: number
  /** 落点（直接交给路由表）。 */
  sink: LogSink
  store: OwnLogStore
  /** 取本目录的引擎自述（丢弃数、按需开关、最近一次落盘失败）。纯读，绝不抛。 */
  health: () => {
    namespace: string
    dir: string
    refs: number
    dropped: number
    switchEnabled: boolean | null
    lastPersistFail: { op?: string; reason?: string; dirHash?: string; at?: number } | null
  }
}

export interface OwnLogAcquireInput {
  /** 日志根目录：`<homeDir>/logs`。 */
  logsRoot: string
  /** 派生命名空间（`deriveLogNamespace(pluginId)` 的结果）。 */
  namespace: string
  /** 电话名前缀（dsh-log 的 prefix，默认 `wf`）。 */
  prefix: string
  /** 交给 dsh-log 的事件清单（对象形式；读不到随包清单时可以是 null）。 */
  eventList?: GateEventList | null
  /**
   * 写进启动头 `host.start` 行的「这个目录是谁写的」版本号（dsh-log 0.3.3 的 `pluginVersion`）。
   * 不给就用**本包自己的版本**（`ownPackageVersion()`）—— 自建目录里落的都是本包的事件，
   * 交日志时对方第一个要问的就是「这堆行出自哪一版」。
   */
  pluginVersion?: string
  /** 测试缝：换掉 `import('dsh-log/node')`（默认动态 import 真实包）。 */
  loader?: () => Promise<unknown>
  /** 撞租约时的退避表（默认 [50, 250, 1000] 毫秒，三次之后降级）。 */
  retryDelaysMs?: number[]
  /** 降级冷却：冷却期内的接线直接降级，不去反复撞同一把锁（默认 60 秒）。 */
  cooldownMs?: number
  /** 时钟注入（测试用）。 */
  now?: () => number
  /** 降级回调（调用方据此发 selfmon 行；本模块自己保持沉默，不写任何日志）。 */
  onDegrade?: (reason: OwnLogDegradeReason, dir: string) => void
}

export interface OwnLogAcquireResult {
  /** 落点；降级时为 null（调用方按「没有落点」处理，绝不回退到别人的 sink）。 */
  sink: LogSink | null
  dir: string
  namespace: string
  /** 是否是复用已有句柄（同一目录第二次接线）。 */
  reused: boolean
  /** 降级原因；成功时为 null。 */
  reason: OwnLogDegradeReason | null
  handle: OwnLogHandle | null
}

interface RegistryState {
  handles: Map<string, OwnLogHandle>
  /** 每个目录最近一次降级（跨副本可见的「为什么没日志」）。 */
  degraded: Map<string, { reason: OwnLogDegradeReason; at: number }>
  /** 冷却到什么时候（毫秒时间戳）。 */
  cooldownUntil: Map<string, number>
  /** 全进程最近一次降级（诊断面直接读它）。 */
  lastDegraded: { reason: OwnLogDegradeReason; dir: string; at: number } | null
}

const DEFAULT_RETRY_DELAYS = [50, 250, 1000]
const DEFAULT_COOLDOWN_MS = 60_000
const LEASE_SHAPE = /占用|写者|租约|lease|lock|接管/i

function registryState(): RegistryState {
  const holder = globalThis as unknown as Record<string | symbol, unknown>
  let state = holder[Symbol.for(OWN_LOG_REGISTRY_KEY)] as RegistryState | undefined
  if (!state || !(state.handles instanceof Map)) {
    state = { handles: new Map(), degraded: new Map(), cooldownUntil: new Map(), lastDegraded: null }
    holder[Symbol.for(OWN_LOG_REGISTRY_KEY)] = state
  }
  return state
}

/** 登记表现状（诊断面用）：几棵树、各自引用计数与引擎自述。 */
export function describeOwnLogRegistry(): { size: number; entries: Array<ReturnType<OwnLogHandle['health']>> } {
  try {
    const state = registryState()
    return { size: state.handles.size, entries: Array.from(state.handles.values()).map((handle) => handle.health()) }
  } catch {
    return { size: 0, entries: [] }
  }
}

/** 全进程最近一次自建日志降级（没有就回 null）。诊断面据此解释「这个插件为什么没有日志」。 */
export function lastOwnLogDegraded(): { reason: OwnLogDegradeReason; dir: string; at: number } | null {
  try {
    return registryState().lastDegraded
  } catch {
    return null
  }
}

/**
 * 测试缝（#212）：接线路径（`createHostUpdate` → `acquireOwnLog`）不显式传 loader/退避表，
 * 而「建库失败 → 降级成没有落点」这条分支必须在测试里可复现（否则只能靠真把 dsh-log 弄坏）。
 * **入参显式给了就用入参**，缝只在没给时生效；默认（null）完全不动既有行为。
 */
export interface OwnLogAcquireSeams {
  loader?: () => Promise<unknown>
  retryDelaysMs?: number[]
  cooldownMs?: number
}

let acquireSeams: OwnLogAcquireSeams | null = null

/** 装/拆测试缝：只影响之后发起的 `acquireOwnLog`。 */
export function __setOwnLogAcquireSeamsForTests(seams: OwnLogAcquireSeams | null): void {
  acquireSeams = seams ?? null
}

/** 目录指纹：日志目录不进日志行，只进 8 位指纹（第三方交日志时用来对齐目录，不泄露路径）。 */
export function logDirHash(dir: string): string {
  return hashToken(String(dir ?? ''), 8)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(), ms)
  })
}

/**
 * 取一个自建日志句柄（同目录复用；建不起来就降级，绝不抛）。
 * 调用方拿到 `sink` 后接进路由表即可；`handle` 交给释放路径与诊断面。
 */
export async function acquireOwnLog(input: OwnLogAcquireInput): Promise<OwnLogAcquireResult> {
  const now = input.now ?? (() => Date.now())
  const namespace = String(input.namespace ?? '').trim()
  const dir = join(String(input.logsRoot ?? ''), namespace)
  const key = logDirKey(dir)
  const base: OwnLogAcquireResult = { sink: null, dir, namespace, reused: false, reason: null, handle: null }
  try {
    if (!input.logsRoot || !namespace) return { ...base, reason: 'no-dsh-log' }
    const state = registryState()
    const existing = state.handles.get(key)
    if (existing) {
      existing.refs++
      return { sink: existing.sink, dir, namespace, reused: true, reason: null, handle: existing }
    }
    const cooldown = state.cooldownUntil.get(key) ?? 0
    if (cooldown > now()) {
      const reason = state.degraded.get(key)?.reason ?? 'no-dsh-log'
      return { ...base, reason }
    }
    const pluginVersion = resolvePluginVersion(input.pluginVersion)
    const load = input.loader ?? acquireSeams?.loader ?? (() => import('dsh-log/node') as Promise<unknown>)
    let mod: unknown
    try {
      mod = await load()
    } catch {
      return degrade(state, input, base, 'no-dsh-log', now(), key, dir)
    }
    const factory = (mod as { createNodeHostLog?: unknown } | null | undefined)?.createNodeHostLog
    if (typeof factory !== 'function') return degrade(state, input, base, 'no-dsh-log', now(), key, dir)
    const delays = input.retryDelaysMs ?? acquireSeams?.retryDelaysMs ?? DEFAULT_RETRY_DELAYS
    let store: OwnLogStore | null = null
    let lastError: unknown = null
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        const created = (await (factory as (deps: unknown, config: unknown) => Promise<unknown>).call(null, { cacheDir: input.logsRoot }, {
          pluginId: namespace,
          prefix: String(input.prefix ?? 'wf'),
          logDirName: namespace,
          switchFileName: logSwitchFileName(namespace),
          ...(pluginVersion ? { pluginVersion } : {}),
          ...(input.eventList ? { eventList: input.eventList as unknown as Record<string, unknown> } : {}),
        })) as unknown
        store = resolveOwnLogStore(created)
        if (store) {
          watchReady(created as { ready?: Promise<{ ok?: boolean; reason?: string }> }, state, key, dir, input)
          break
        }
        // 形状不对不是租约问题：再建一次只会撞上「同目录第二个写者」，反而把真因盖掉。直接降级。
        lastError = new Error('dsh-log/node 建库回的形状里没有可用的 store')
        break
      } catch (error) {
        lastError = error
      }
      const delay = delays[attempt]
      if (delay === undefined) break
      await sleep(delay)
    }
    if (!store) {
      const reason: OwnLogDegradeReason = LEASE_SHAPE.test(String((lastError as Error)?.message ?? lastError ?? ''))
        ? 'lease-conflict'
        : 'write-fail'
      return degrade(state, input, base, reason, now(), key, dir)
    }
    const handle: OwnLogHandle = {
      namespace,
      dir,
      refs: 1,
      sink: sinkFromStore(store),
      store,
      health: () => {
        let dropped = 0
        let switchEnabled: boolean | null = null
        let lastPersistFail: ReturnType<NonNullable<OwnLogStore['getLastPersistFail']>> = null
        try {
          dropped = Number(store?.getDroppedCount?.() ?? 0)
        } catch {
          dropped = 0
        }
        // 开关自述两种形状都认（`{ enabled }` 与裸布尔）；取不到或形状不对＝null（未验证）。
        try {
          const state = store?.getSwitchState?.()
          if (typeof state === 'boolean') switchEnabled = state
          else if (state && typeof state === 'object' && typeof (state as { enabled?: unknown }).enabled === 'boolean') {
            switchEnabled = (state as { enabled: boolean }).enabled
          }
        } catch {
          switchEnabled = null
        }
        try {
          lastPersistFail = store?.getLastPersistFail?.() ?? null
        } catch {
          lastPersistFail = null
        }
        return { namespace, dir, refs: handle.refs, dropped, switchEnabled, lastPersistFail }
      },
    }
    state.handles.set(key, handle)
    return { sink: handle.sink, dir, namespace, reused: false, reason: null, handle }
  } catch {
    return { ...base, reason: 'write-fail' }
  }
}

/**
 * 启动头 `host.start` 里那一格「这个目录是哪一版写的」：调用方给了就用给的（集成方自己的版本），
 * 没给就用**本包版本**（`ownPackageVersion()`），都没有就不带这个键。
 *
 * 为什么必须在建库时定：dsh-log **0.3.4 起启动头幂等**（`writeStartupHeader` 第二次调用直接返回
 * 首写结果），建库那一刻没给就再也补不上——晚一步传等于永远写不进去。
 */
function resolvePluginVersion(given: string | undefined): string | null {
  const one = typeof given === 'string' ? given.trim() : ''
  if (one) return one
  const own = ownPackageVersion()
  return own && own.trim() !== '' ? own.trim() : null
}

/**
 * 认 dsh-log 回执的两种形状：`createNodeHostLog` 回 HostLog（写口在 `store` 上），
 * `createHostLog` 也回 HostLog；老写法或自建实现可能直接回裸 store —— 两条都认，认不出回 null。
 */
function resolveOwnLogStore(created: unknown): OwnLogStore | null {
  const one = created as { log?: unknown; store?: { log?: unknown } } | null | undefined
  if (!one || typeof one !== 'object') return null
  if (typeof one.log === 'function') return one as OwnLogStore
  if (one.store && typeof one.store.log === 'function') return one.store as OwnLogStore
  return null
}

/** 建库成功后的落盘健康看门：只在引擎自述不健康时记一笔降级（不阻塞接线）。 */
function watchReady(
  created: { ready?: Promise<{ ok?: boolean; reason?: string }> },
  state: RegistryState,
  key: string,
  dir: string,
  input: OwnLogAcquireInput
): void {
  const ready = created.ready
  if (!ready || typeof ready.then !== 'function') return
  void Promise.resolve(ready)
    .then((report) => {
      if (report && report.ok === false) {
        state.degraded.set(key, { reason: 'write-fail', at: Date.now() })
        state.lastDegraded = { reason: 'write-fail', dir, at: Date.now() }
        try {
          input.onDegrade?.('write-fail', dir)
        } catch {
          /* 回调坏了不影响日志本身 */
        }
      }
    })
    .catch(() => {
      /* ready 自己抛错：等真正落盘失败时由引擎的 getLastPersistFail 自述 */
    })
}

function degrade(
  state: RegistryState,
  input: OwnLogAcquireInput,
  base: OwnLogAcquireResult,
  reason: OwnLogDegradeReason,
  at: number,
  key: string,
  dir: string
): OwnLogAcquireResult {
  state.degraded.set(key, { reason, at })
  state.cooldownUntil.set(key, at + (input.cooldownMs ?? acquireSeams?.cooldownMs ?? DEFAULT_COOLDOWN_MS))
  state.lastDegraded = { reason, dir, at }
  try {
    input.onDegrade?.(reason, dir)
  } catch {
    /* 回调坏了不影响接线 */
  }
  return { ...base, reason }
}

/** 还回引用；引用归零才真的释放引擎实例（同步幂等）。 */
export function releaseOwnLog(namespace: string, logsRoot = ''): boolean {
  try {
    const state = registryState()
    const key = logDirKey(join(String(logsRoot ?? ''), String(namespace ?? '').trim()))
    const handle = state.handles.get(key)
    if (!handle) return false
    handle.refs--
    if (handle.refs > 0) return false
    try {
      handle.store.release?.()
    } catch {
      /* 引擎释放失败也要把本地登记摘掉，否则目录永远占着 */
    }
    state.handles.delete(key)
    return true
  } catch {
    return false
  }
}

/** `flushUpdateLog` 的缺省有界等待上限（毫秒）：为 `beforeExit` 场景选的小值，宁可漏一行也不卡退出。 */
export const DEFAULT_FLUSH_UPDATE_LOG_TIMEOUT_MS = 1000

/** `flushUpdateLog` 的选项（issue #211 AC-3）。 */
export interface FlushUpdateLogOptions {
  /** 有界等待上限（毫秒）；缺省 1000。非正数 / 非有限值回落到缺省。 */
  timeoutMs?: number
}

/**
 * `flushUpdateLog` 的回执：只描述「这一次有界冲刷看得到的结果」。
 * 外部落点（`logSink=external` / `external-unverified`）不归这里管，不计进 `stores`。
 */
export interface FlushUpdateLogResult {
  /** 全部自建 store 的冲刷都已完成、都成功、且剩余待落盘行数为 0 时才为 true。 */
  flushed: boolean
  /** 是否因超时提前返回；true 时 `flushed` 必为 false（剩下的行交给引擎自己的退出冲刷）。 */
  timedOut: boolean
  /** 尽力估计的仍未落盘行数：各 store `getPendingCount()` 之和（取不到 / 抛错的按 0）。 */
  pending: number
  /** 本次参与冲刷的自建 store 数（= own-log 登记表里被接线的目录数）。 */
  stores: number
}

/**
 * 冲刷自建日志（issue #211 AC-3）：把 own-log 登记表里每个 store 的已排队行推落到磁盘，**有界等待**。
 *
 * 语义边界（README 照此写）：
 *   - 只冲刷 `logSink=self` 的自建落点；外部落点归集成方自己管，**不承诺**在这里也能冲。
 *   - 缺省最多等 1000ms（`options.timeoutMs` 可调）；到点即返回，绝不卡 `beforeExit`。
 *   - **永不抛错、不 reject**：没登记、引擎自己炸、超时，都折成回执。
 *   - 优先引擎的 `flushNow()`，没有退到 `synced()`，两者都没有的 store 视为「没有异步队列」直接完成。
 *   - 只读登记表快照：不动引用计数、不释放引擎实例（释放仍归 `releaseOwnLog` / 登记表重置）。
 *
 * @param options.timeoutMs 有界等待上限，毫秒；缺省 1000，非正数/非有限值回落缺省。
 */
export async function flushUpdateLog(options: FlushUpdateLogOptions = {}): Promise<FlushUpdateLogResult> {
  let stores = 0
  let pending = 0
  try {
    const rawTimeout = Number((options as FlushUpdateLogOptions | null | undefined)?.timeoutMs)
    const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_FLUSH_UPDATE_LOG_TIMEOUT_MS
    const handles = Array.from(registryState().handles.values())
    stores = handles.length
    if (stores === 0) return { flushed: true, timedOut: false, pending: 0, stores: 0 }
    // 逐格冲刷：一格失败/挂住不许挡别的格（每格自己消化异常，只回「完成没完成」）。
    const flushing = handles.map(async (handle): Promise<boolean> => {
      try {
        const store = handle?.store
        const flush =
          typeof store?.flushNow === 'function' ? store.flushNow : typeof store?.synced === 'function' ? store.synced : null
        if (flush) await flush.call(store)
        return true
      } catch {
        return false
      }
    })
    let timedOut = false
    let allOk = true
    let timer: unknown = null
    try {
      const outcome = await Promise.race([
        Promise.all(flushing),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs)
        }),
      ])
      if (outcome === null) timedOut = true
      else allOk = outcome.every((ok) => ok === true)
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
    pending = countPendingRows(handles)
    return { flushed: !timedOut && allOk && pending === 0, timedOut, pending, stores }
  } catch {
    // 兜底：连登记表都读坏了也不外抛（回执里 pending 保持 0，flushed=false 表示没冲干净）。
    return { flushed: false, timedOut: false, pending, stores }
  }
}

/** 尽力估计未落盘行数：每格单独 try，坏引擎不能把整次冲刷变成异常。 */
function countPendingRows(handles: OwnLogHandle[]): number {
  let pending = 0
  for (const handle of handles) {
    try {
      const count = Number(handle?.store?.getPendingCount?.() ?? 0)
      if (Number.isFinite(count) && count > 0) pending += count
    } catch {
      /* 拿不到按 0：不知道不等于有 */
    }
  }
  return pending
}

/** 测试用：清空登记表、冷却与降级记录（不动文件系统）。 */
export function __resetOwnLogRegistryForTests(): void {
  try {
    const state = registryState()
    for (const handle of state.handles.values()) {
      try {
        handle.store.release?.()
      } catch {
        /* 忽略 */
      }
    }
    state.handles.clear()
    state.degraded.clear()
    state.cooldownUntil.clear()
    state.lastDegraded = null
    acquireSeams = null
  } catch {
    /* 忽略 */
  }
}
