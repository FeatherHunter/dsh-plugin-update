// src/host-batch.ts —— 多目标批量更新的宿主入口（#25）。
//
// 归属：宿主（Node）侧。为 N 个目标各建一份现有 createHostUpdate 能力（前缀与插件标识隔离），
// 共享同一套队列端口（同一使用范围）；批量会话账本落盘（见 core/disk.ts 的 batch 路径），
// 让「关面板/重启进程」之后还能接着推进（resume）。
//
// 契约（面板侧按它写，见 src/panel-batch.ts）：
//   前缀由调用方给（batchPrefix，例 'life'；即属主身份），七个批量电话：
//     <p>.batchStatus  {}                -> 全表（rows + progress + session + inventory + prefs）
//     <p>.batchCheck   {}                -> 查 N 家、重写知识账本后同形状（成功结论同步对账进会话，见 checkPhone）
//     <p>.batchInstall { keys?: string[] }-> 建/续会话并推进：不给 keys 即「全部提交」；
//                                            给了 keys 只推那几家（行内「装这家」/「重试」用）
//     <p>.batchResume  {}                -> 读盘上会话，resume 后推进（含 resumed 事实）
//     <p>.batchCancel  {}                -> 只清本属主盘上会话，回空会话（知识不动）
//     <p>.batchPrefs   {}                -> 读本属主偏好
//     <p>.batchPrefsSave { checkOnOpen }  -> 写本属主偏好
//   每行的单插件三电话照旧各自前缀暴露（<target.prefix>.updateStatus 等）。
//
// 实现要点（第一性）：
//   1. 每个目标一份 createHostUpdate：它的单例复用键含插件标识与前缀（见 host.ts），
//      七个目标各有各的内存状态，不串台；队列端口只建一份给所有目标共用（同一使用范围）。
//   2. 串行与落盘全交 core/batch/model.ts / run.ts（已有门禁），本文件只做「电话 <-> 驱动器」的翻译：
//      查电话 -> BatchCheckOutcome；装电话 + 轮询该家到终态 -> BatchInstallOutcome。
//   3. 查/装传输可注入（deps.transport），真路径走单插件电话；单测给假件即能逮住顺序与落盘。
//   4. drain 默认关：显式 drain:true 才起定时器，一次只推一步（maxSteps:1），dispose() 停干净。
//   5. 跨使用范围如实拒绝：目标清单里混进不同 (homeDir, profileDir) 时五个电话都回
//      { ok:false, error:'cross-scope', errorKind:'cross-scope' }，绝不自作主张跨范围抢锁。
//      算不出使用范围目录时会话退化为内存账本：诚实降级，不猜目录（落盘不可用，推进照旧）。
//   6. 一家收尾才起下一家：装电话返回后轮询该家状态到终态（restart-required / completed /
//      failed / interrupted），期间本进程不再打别家电话——宿主读取器是单槽缓存，换键会丢掉
//      正在装那家的活动任务编号，把「在装」误读成「中断」。
//   7. 忙时入队（#25 排队语义）：batchInstall 在驱动进行中不再回 update-busy，而是把 keys 并进
//      当前会话（幂等）并回 ok:true，单飞不另起驱动；单插件装电话回 update-busy（已占位、等轮到你）
//      时映射成驱动器的 { kind:'queued', position }（相位退回 ready，不是 failed），行上带出队列位置。
//   8. 批量侧常驻事件三条（#124 / #208），全部 best-effort、只走唯一发射口（脱敏/白名单/预算都在里面）：
//      建会话时一条 update.batch.entry.request（只给 total/own/foreign 三个计数 + sessionHash，不给插件名清单）、
//      一家失败一条 update.batch.entry.fail（在 core/batch/run.ts 里按目标发射，落点是那家自己的插件标识；
//      #208 起带 sessionHash、失败阶段 stage 与批内序号 index）、
//      收尾一条 update.batch.summary（宿主侧汇总，面板只渲染；带 sessionHash 与 stoppedBecause）。
//      总账的判据是**收尾边沿**：同一份会话每次「没收尾 → 收尾」都记一条（行内重试装成后再收尾会再记），
//      所以日志不会一直写着过期的 failed 计数。落点未知（没 selfKey、键不在清单里、没有日志接线）时
//      一行不发：不知道去哪就不猜。
//   9. 七个批量电话每通失败留一行（#208）：复用 host.call.fail 落属主目录（无属主不发），
//      同一 method 连续同码只记首次、成功清记忆（batchStatus 轮询失败不灌爆目录）；
//      有属主时登记 `<批量前缀>.logAppend` 转发给属主的 logAppend，批量面板的客户端日志行才落得下来。

import { homedir } from 'node:os'
import { hash8 } from './shared/hash.js'
import {
  batchEntryOf,
  batchProgress,
  batchRequestId,
  createBatchSession,
  emptyBatchSession,
  isBatchFinished,
  isTerminalPhase,
  markBatchEntry,
  orderTargets,
  resumeBatchSession,
  type BatchEntry,
  type BatchPhase,
  type BatchProgress,
  type BatchSession,
} from './core/batch/model.js'
import {
  noteBatchEntryFailure,
  runBatch,
  type BatchCheckOutcome,
  type BatchInstallOutcome,
  type BatchRunStep,
  type BatchStoppedByBecause,
} from './core/batch/run.js'
import { assertPluginId, assertPrefix, buildLogAppendPhoneName, resolveUpdateConfig, type UpdateConfigInput } from './shared/config.js'
import { CROSS_SCOPE_CODE, isBatchReplyCode, isCoreErrorCode } from './shared/codes.js'
import { createBatchLogSeams, pluginLogPort } from './host-batch-log.js'
import { createHostUpdate, type HostUpdate, type ReaderOverrides } from './host.js'
import type { ManualSource } from './shared/last-resort.js'
import { defaultHomeDir } from './core/reader.js'
import { compareReleaseVersions } from './core/service.js'
import {
  createBatchOwnerPorts,
  createSkipDiskPorts,
  emptyBatchInventory,
  isVersionSkipped,
  normalizeBatchInventory,
  normalizeBatchPrefs,
  type BatchInventory,
  type BatchPrefs,
} from './core/disk.js'
import { createUpdateQueuePorts } from './core/queue/ports.js'

/** 一个批量目标：要更新的那个插件包 + 它在电话表里的前缀。 */
export interface MultiTargetSpec {
  /** 会话内稳定键（唯一）。 */
  key: string
  /** 中文名（面板行首用；缺省用 key）。 */
  title?: string
  /** 目标包名（createHostUpdate 的 targetPackageName）。 */
  packageName: string
  /** 该目标的单插件电话前缀（七个必须互不相同，否则串台）。 */
  prefix: string
  /** 宿主侧插件标识（缺省用 batchPrefix + '-' + key）。 */
  pluginId?: string
  /** 该目标的落盘使用范围（家目录）：缺省随批量范围；与批量不一致即如实拒绝（cross-scope）。 */
  homeDir?: string
  /** 该目标的落盘使用范围（使用范围目录）：缺省随批量范围；与批量不一致即如实拒绝。 */
  profileDir?: string
}

/** createMultiHostUpdate 的配置。 */
export interface MultiHostOptions {
  /** 批量电话前缀（例 'life'）。 */
  prefix: string
  /** 目标清单（顺序即会话顺序；selfKey 会被排到最后）。 */
  targets: MultiTargetSpec[]
  /** 「自己」的键：排序时排最后，自更新安全。 */
  selfKey?: string | null
  /** 一家失败后是否停下（默认 false：继续下一家）。 */
  stopOnFailure?: boolean
  /** 宿主侧 drain：定时自动推进队列（**默认关**，显式 opt-in）。 */
  drain?: boolean
  /** drain 间隔（毫秒，缺省 5000，下限 1000）。 */
  drainIntervalMs?: number
}

/** 查一家：真路径打该目标的 updateCheck 电话，单测给假件。 */
export type TargetCheckFn = (key: string, spec: MultiTargetSpec) => Promise<BatchCheckOutcome>
/** 装一家：requestId 是会话账本里的幂等编号（同一会话同一目标恒定）。 */
export type TargetInstallFn = (
  key: string,
  spec: MultiTargetSpec,
  requestId: string,
  version: string,
) => Promise<BatchInstallOutcome>

/** 定时器：drain 用；测试给假件即能确定性地断言「起没起、停没停」。 */
export interface MultiHostTimer {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

/**
 * createMultiHostUpdate 的宿主依赖（全部可选）。
 * ctx / logCtx / desktopPnpm / pluginManager / readerOverrides 原样透传给每个目标的 createHostUpdate；
 * 其余是本入口自己的口子（范围、传输、定时器、时钟、编号），生产可不传。
 */
export interface MultiHostDeps {
  ctx?: unknown
  logCtx?: { fire: (level: string, event: string, fields: Record<string, unknown>) => void } | null
  desktopPnpm?: unknown
  pluginManager?: unknown
  /** 逐目标共用的读侧覆盖（透传给每个目标）。 */
  readerOverrides?: ReaderOverrides
  /** 逐目标读侧覆盖（给了就按目标算；测试与异构目标用）。 */
  readerOverridesFor?: (spec: MultiTargetSpec) => ReaderOverrides | undefined
  /** 逐目标共用的配置覆盖（pluginId / prefix / targetPackageName 按目标算，不从这里来）。 */
  config?: Omit<UpdateConfigInput, 'pluginId' | 'prefix' | 'targetPackageName'>
  /** 批量使用范围（会话落盘与共享队列端口用；缺省取 readerOverrides 的同名项）。 */
  scope?: { homeDir?: string; profileDir?: string }
  /** 查/装传输：缺省走单插件电话；测试给假件。 */
  transport?: { check?: TargetCheckFn; install?: TargetInstallFn }
  /** drain 的定时器（缺省真 setTimeout / clearTimeout）。 */
  timers?: MultiHostTimer
  now?: () => number
  randomId?: () => string
  /** 装完之后轮询该家状态的间隔毫秒（缺省 500；后台安装收尾用）。 */
  installPollMs?: number
}

/**
 * 批量宿主侧电话名（供接入方登记用，不写字面量）。
 *
 * 与面板侧 `./panel-batch` 的 `BatchPhoneNames` **不同名**（两份同名导出会经不同子路径发布，
 * 消费者同时 import 会撞名）：面板那份只描述它实际打的七个电话；这份多登记一个 `logAppend`，
 * 因为宿主是唯一知道「属主插件日志口」的一侧。
 */
export interface BatchHostPhoneNames {
  status: string
  check: string
  install: string
  resume: string
  cancel: string
  prefs: string
  prefsSave: string
  /**
   * 客户端日志电话（#208）：属主存在时登记、转发给属主插件的 logAppend，
   * 批量面板自建的日志通道打这个名。没有属主时**不登记**——面板行宁可投递失败，也不猜落点。
   */
  logAppend?: string
}

/** 批量宿主入口的返回面。 */
export interface MultiHostUpdate {
  /** 电话表：批量电话 + 每个目标的单插件电话，键即电话名。 */
  handlers: Record<string, (args?: Record<string, unknown>) => Promise<unknown>>
  /** 批量电话名（供接入方登记用，不写字面量）。 */
  phoneNames: BatchHostPhoneNames
  /** 目标清单（顺序与会话一致）。 */
  targets: readonly MultiTargetSpec[]
  /** 最近一次推进的读数（驱动器停下来的原因 + 步骤）：给日志与门禁用；没推过为 null。 */
  lastRun: { stoppedBecause: BatchStoppedByBecause; steps: BatchRunStep[] } | null
  /** 停掉 drain（接入方卸载时调）。 */
  dispose(): void
}

// ---------- 小工具（纯函数，可单独看） ----------

const DEFAULT_DRAIN_INTERVAL_MS = 5000
const MIN_DRAIN_INTERVAL_MS = 1000
const DEFAULT_INSTALL_POLL_MS = 500
const REQUEST_ID_MAX_CHARS = 128

/**
 * 本入口的认码一律走 src/shared/codes.ts 的归属判断（真源那两张表在这里不再抄第二份）：
 * 电话/队列认 `isBatchReplyCode`（核心码面 + 本入口的 cross-scope），
 * 任务说明前缀认 `isCoreErrorCode`（核心码面）。
 */

function batchFail(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code })
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value) return value
  }
  return null
}

/**
 * 从电话回包里取真退出码（#124）：核心把失败诊断放在回包顶层的 diag（host.ts 的失败回包口径），
 * 只有阶段 exec 的诊断才带 exitCode。取不到就是 null——不拿 0 冒充「跑过并退出」。
 */
function exitCodeOf(reply: Record<string, unknown>): number | null {
  const raw = asRecord(reply['diag'])['exitCode']
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : null
}


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

function errorPayloadOf(error: unknown): { error: string; errorKind: string } {
  const code = error && typeof (error as { code?: unknown }).code === 'string' ? String((error as { code: string }).code) : ''
  if (isBatchReplyCode(code)) return { error: code, errorKind: code }
  return { error: 'check-failed', errorKind: 'internal' }
}

function codeOfReply(reply: Record<string, unknown>): string {
  const code = firstText(reply['error']) ?? ''
  return isBatchReplyCode(code) ? code : 'check-failed'
}

function jobFailureCode(job: Record<string, unknown> | null): string {
  const message = job && typeof job['message'] === 'string' ? (job['message'] as string) : ''
  const head = message.split(':')[0].trim()
  return isCoreErrorCode(head) ? head : 'install-failed'
}

function snapshotOf(reply: Record<string, unknown>): Record<string, unknown> {
  return asRecord(reply['snapshot'])
}

function jobOf(snapshot: Record<string, unknown>): Record<string, unknown> | null {
  const job = snapshot['job']
  return job && typeof job === 'object' && !Array.isArray(job) ? (job as Record<string, unknown>) : null
}

function sleep(ms: number): Promise<void> {
  return new Promise((settle) => {
    setTimeout(() => settle(), ms > 0 ? ms : 0)
  })
}

/** 一轮推进的步数上限：防病态状态下空转（正常一家两步，七家十几步）。 */
const DRIVE_STEP_GUARD = 10000

/**
 * 批量查新的受控并发（#70 ADR-0004：取下限保守起步，待实测上调）。
 * 只关乎“registry 礼貌”，与并发安全无关：checkPhone 只写版本串不读 receipt，
 * 在途调用各持各的 reader 对象，落盘单次全量写，逐家 try/catch 即 allSettled 语义。
 * 回退线：降到 1 即退回现状串行查，装阶段不受影响。
 */
export const BATCH_CHECK_CONCURRENCY = 3

/** 受控池：最多 limit 个在飞，不新增依赖；items 为空即直接回。 */
async function runWithConcurrency<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const Inflight = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1
  if (items.length === 0) return
  let next = 0
  const workers = Array.from({ length: Math.min(Inflight, items.length) }, async () => {
    while (next < items.length) {
      const current = next
      next += 1
      await fn(items[current])
    }
  })
  await Promise.all(workers)
}

/**
 * 把更全的那份会话里的行并进 base（键相同的以 base 的相位为准），顺序以更全的那份为准。
 * 两处用：忙时入队（驱动期间并进来的新行）、「只推几家」的视图会话合并回全量账本。
 */
function mergeInto(base: BatchSession, extra: BatchSession | null): BatchSession {
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
function addKeys(session: BatchSession, keys: Iterable<string>, at: number): BatchSession {
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

function validateTargets(raw: unknown): MultiTargetSpec[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('[dsh-plugin-update] 批量目标清单 targets 必填：至少一个目标')
  }
  const out: MultiTargetSpec[] = []
  const seenKeys = new Set<string>()
  const seenPrefixes = new Set<string>()
  for (const item of raw) {
    const spec = asRecord(item) as unknown as MultiTargetSpec
    const key = firstText(spec.key)
    if (!key) throw new Error('[dsh-plugin-update] 批量目标缺少稳定键 key')
    if (seenKeys.has(key)) throw new Error('[dsh-plugin-update] 批量目标键重复：' + key)
    seenKeys.add(key)
    const prefix = assertPrefix(spec.prefix, '目标 ' + key + ' 的单插件电话前缀 prefix')
    if (seenPrefixes.has(prefix)) throw new Error('[dsh-plugin-update] 批量目标电话前缀重复：' + prefix)
    seenPrefixes.add(prefix)
    if (!firstText(spec.packageName)) throw new Error('[dsh-plugin-update] 批量目标缺少目标包名 packageName：' + key)
    out.push(spec)
  }
  return out
}

/** 插件标识：显式给了就用（非法即抛，调用方的错不替他兜）；缺省按批量前缀 + 键派生。 */
function pluginIdOf(spec: MultiTargetSpec, batchPrefix: string): string {
  if (typeof spec.pluginId === 'string' && spec.pluginId) return assertPluginId(spec.pluginId)
  const derived = batchPrefix + '-' + spec.key
  try {
    return assertPluginId(derived)
  } catch {
    // 键里有路径分隔符之类：按标识形状洗一遍（落盘目录只按标识派生，洗过仍然稳定）。
    return assertPluginId(derived.replace(/[^A-Za-z0-9._~-]+/g, '-'))
  }
}

/** 一行电话回包在内存里的读数（面板展开详情用；不落盘——盘上只放账本）。 */
interface RowCache {
  snapshot: unknown
  manual: string | null
  /**
   * 手工命令可信来源（#177）：`frame` = manual 与 snapshot 来自同一成功回包；
   * `carried-over` = 失败回包沿用旧值（行详情 fail-closed）；`null` = 当帧确认没有命令。
   */
  manualSource: ManualSource | null
  queue: unknown
  profileName: string | null
  /** 宿主种类（env.environmentKind；面板诊断与详情用，取不到即 null，说人话未知）。 */
  hostKind: string | null
  error: string | null
  /** 最近一次回包带的失败诊断（#21 的 diag；成功回包恒不带，所以成功即清空，不留陈旧诊断）。 */
  diag: unknown
}

const EMPTY_CACHE: RowCache = {
  snapshot: null,
  manual: null,
  manualSource: null,
  queue: null,
  profileName: null,
  hostKind: null,
  error: null,
  diag: null,
}

interface TargetScope {
  homeDir: string
  profileDir: string | null
}

/** 一个目标的全部运行期零件（宿主能力、传输、缓存、幂等凭证）。 */
interface TargetRuntime {
  spec: MultiTargetSpec
  config: UpdateConfigInput
  resolved: ReturnType<typeof resolveUpdateConfig>
  host: HostUpdate
  pluginId: string
  homeDir: string
  profileDir: string | null
  check: TargetCheckFn
  install: TargetInstallFn
  skipPorts: ReturnType<typeof createSkipDiskPorts> | null
  cache: RowCache
  receipt: { checkId: string; version: string } | null
  now: () => number
  pollMs: number
}

function defaultTimers(): MultiHostTimer {
  return {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  }
}

async function skippedVersionsOf(rt: TargetRuntime): Promise<unknown[]> {
  if (!rt.skipPorts) return []
  try {
    return await rt.skipPorts.readSkipped()
  } catch {
    return []
  }
}

/**
 * 打一通单插件电话，把回包读数收进缓存：成功收快照/手工命令/队列读数，失败收失败诊断
 * （#21 的 diag，可能没有）——旧快照读数保留，只有诊断随回包换手。
 *
 * #156 第四轮起：安装是异步的，年龄门拦在安装那一刻，成功回包本身也可能带着「快照任务已失败」
 * 的机读诊断（那时 diag 就是本次失败的事实，不能当陈旧证据清掉）。宿主口径是「有失败任务才有
 * diag」，所以「回包没带 diag 就清空」仍然成立，不靠成败猜。
 */
async function callPhone(rt: TargetRuntime, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const handler = rt.host.handlers[name]
  if (typeof handler !== 'function') return { ok: false, error: 'check-failed', errorKind: 'internal' }
  let reply: unknown
  try {
    reply = await handler(args)
  } catch (error) {
    return { ok: false, ...errorPayloadOf(error) }
  }
  const value = asRecord(reply)
  const next: RowCache = { ...rt.cache }
  if (value['ok'] === true) {
    if ('snapshot' in value) next.snapshot = value['snapshot'] ?? null
    // #177：manual 只在成功回包里算当帧事实；回包没带 `manual` 键 = 当帧确认没有命令（老宿主同样口径）。
    if ('manual' in value) {
      next.manual = firstText(value['manual'])
      next.manualSource = next.manual !== null ? 'frame' : null
    } else {
      next.manual = null
      next.manualSource = null
    }
    if ('queue' in value) next.queue = value['queue'] ?? null
    if ('env' in value) {
      next.profileName = firstText(asRecord(value['env'])['profileName'])
      next.hostKind = firstText(asRecord(value['env'])['environmentKind'])
    }
    next.error = null
    // 诊断随回包换手（成功也可能带：失败任务在快照里，见上）；没带即清空。
    next.diag = 'diag' in value ? (value['diag'] ?? null) : null
  } else {
    // 失败回包才可能带 diag（status / check / install 三电话同一套 #21 契约），有就收下。
    next.diag = 'diag' in value ? (value['diag'] ?? null) : null
    // #177：失败回包沿用旧命令 = 遗留值（carried-over），渲染侧据此 fail-closed，不展示/不给复制。
    next.manualSource = next.manual !== null ? 'carried-over' : null
    // 失败也带使用范围与宿主种类（#45：调用方显式要才带；读不到即保留旧值，不猜）。
    if ('env' in value) {
      const envRec = asRecord(value['env'])
      const pn = firstText(envRec['profileName'])
      const hk = firstText(envRec['environmentKind'])
      if (pn !== null) next.profileName = pn
      if (hk !== null) next.hostKind = hk
    }
  }
  rt.cache = next
  return value
}

/** 真查一家：打 updateCheck 电话，把快照翻成驱动器读数（有新版才 update；用户跳过的版本不装）。 */
async function defaultCheck(rt: TargetRuntime): Promise<BatchCheckOutcome> {
  const reply = await callPhone(rt, rt.host.phoneNames.updateCheck, { includeEnv: true, includeQueue: true })
  if (reply['ok'] !== true) return { kind: 'failed', error: codeOfReply(reply), stage: 'check' }
  const snapshot = snapshotOf(reply)
  const latest = firstText(snapshot['latestVersion'])
  // 未知永不判 current（#90 R2）：回包成功却无版本信息是失败，不是「已是最新」。
  if (!latest) return { kind: 'failed', error: 'check-failed', stage: 'check' }
  if (isVersionSkipped(await skippedVersionsOf(rt), latest)) return { kind: 'skipped', version: latest }
  // 缺席不断「已是最新」（#134/US16）：没有已装版本可比，注入的运行版号不可采信，直接看可安装性。
  const base = snapshot['installed'] === false ? null : firstText(snapshot['installedVersion'], snapshot['runningVersion'])
  if (base) {
    let newer = true
    try {
      newer = compareReleaseVersions(latest, base) === 1
    } catch {
      newer = true
    }
    if (!newer) return { kind: 'current' }
  }
  if (snapshot['canInstall'] !== true) {
    const blocked = firstText(snapshot['blockedReason'])
    return { kind: 'failed', error: blocked && isBatchReplyCode(blocked) ? blocked : 'check-failed', stage: 'check' }
  }
  const checkId = firstText(asRecord(reply['receipt'])['checkId'])
  if (!checkId) return { kind: 'failed', error: 'check-failed', stage: 'check' }
  rt.receipt = { checkId, version: latest }
  return { kind: 'update', version: latest }
}

/** 任务相位 -> 安装读数：只有终态才算收尾（装是后台跑的，装电话返回时多半还在 installing）。 */
function installOutcomeOf(job: Record<string, unknown> | null): BatchInstallOutcome | null {
  const state = job && typeof job['state'] === 'string' ? (job['state'] as string) : ''
  if (state === 'restart-required') return { kind: 'done', restartRequired: true }
  if (state === 'completed') return { kind: 'done', restartRequired: false }
  // 装到终态才失败的，失败阶段是「收尾」（#208）：区别于提交安装本身失败。
  if (state === 'failed' || state === 'interrupted') return { kind: 'failed', error: jobFailureCode(job), stage: 'settle' }
  return null
}

/** 等这一家收尾：轮询它的 updateStatus 到终态；超安装时限按失败收（不把整轮永远挂着）。 */
async function settleInstall(rt: TargetRuntime, firstReply: Record<string, unknown>): Promise<BatchInstallOutcome> {
  const early = installOutcomeOf(jobOf(snapshotOf(firstReply)))
  if (early) return early
  const deadline = rt.now() + rt.resolved.installTimeoutMs
  while (true) {
    // 等过安装时限：不是「提交失败」，是「收尾没等到」——阶段如实记 timeout（#208）。
    if (rt.now() >= deadline) return { kind: 'failed', error: 'install-failed', stage: 'timeout' }
    await sleep(rt.pollMs)
    const status = await callPhone(rt, rt.host.phoneNames.updateStatus, {})
    if (status['ok'] !== true) return { kind: 'failed', error: codeOfReply(status), stage: 'settle' }
    const outcome = installOutcomeOf(jobOf(snapshotOf(status)))
    if (outcome) return outcome
  }
}

/** 某家当前的队列位置（0 = 正在装，1..n = 顺位，null = 不在队里或取不到）。 */
async function queuePositionFor(rt: TargetRuntime, requestId: string | null): Promise<number | null> {
  try {
    const args: Record<string, unknown> = { includeQueue: true }
    if (requestId) args['requestId'] = requestId
    const reply = await callPhone(rt, rt.host.phoneNames.updateStatus, args)
    if (reply['ok'] !== true) return null
    const position = asRecord(reply['queue'])['position']
    return typeof position === 'number' && Number.isFinite(position) ? position : null
  } catch {
    return null
  }
}

/** 真装一家：拿凭证提交，再等它收尾；没有凭证（跨重启只剩 ready）就重查一次拿凭证。 */
async function defaultInstall(rt: TargetRuntime, key: string, spec: MultiTargetSpec, requestId: string): Promise<BatchInstallOutcome> {
  let receipt = rt.receipt
  if (!receipt) {
    const again = await rt.check(key, spec)
    if (again.kind !== 'update') {
      return { kind: 'failed', error: again.kind === 'failed' ? again.error : 'check-expired', stage: 'check' }
    }
    receipt = rt.receipt
    if (!receipt) return { kind: 'failed', error: 'check-expired', stage: 'check' }
  }
  const phoneRequestId = phoneRequestIdOf(requestId)
  // 意图来源（#124）：批量的装由驱动器发起、不是用户点面板，如实自报——只进日志行
  // `update.install.request.from`，不参与任何决策（认不出时宿主按 'panel' 兜底）。
  const submitOnce = async (checkId: string): Promise<Record<string, unknown>> =>
    await callPhone(rt, rt.host.phoneNames.updateInstall, {
      checkId,
      requestId: phoneRequestId,
      from: 'batch',
    })
  let reply = await submitOnce(receipt.checkId)
  rt.receipt = null
  if (reply['ok'] === true) return await settleInstall(rt, reply)
  let code = codeOfReply(reply)
  if (code === 'check-expired') {
    // A 案（#70 ADR-0004 §3）：单例 sharedReader 同一时刻只留最后一家，预查并发查完后
    // 槽里只剩最后一家——驱动串行装、每取下一家 reader（含第一家）凭证都已过期，
    // 所以 ≥2 家的批每家首次提交都会走这里当场重查一次；第二次仍过期才记 failed。不碰单例纪律。
    const again = await rt.check(key, spec)
    if (again.kind !== 'update') {
      return { kind: 'failed', error: again.kind === 'failed' ? again.error : 'check-expired', stage: 'check' }
    }
    const fresh = (rt as unknown as Record<string, unknown>)['receipt'] as { checkId: string; version: string } | null
    if (!fresh || typeof fresh.checkId !== 'string' || !fresh.checkId) {
      return { kind: 'failed', error: 'check-expired', stage: 'check' }
    }
    reply = await submitOnce(fresh.checkId)
    rt.receipt = null
    if (reply['ok'] === true) return await settleInstall(rt, reply)
    code = codeOfReply(reply)
  }
  if (code === 'update-busy') {
    // 宿主的「已占位、排队等轮到你」不是失败（#25 排队语义）：回 queued + 该家队列位置，
    // 驱动器据此把相位退回 ready（远端版本留着），下一轮推动从它接着装。
    return { kind: 'queued', position: await queuePositionFor(rt, phoneRequestId) }
  }
  const exit = exitCodeOf(reply)
  return exit === null
    ? { kind: 'failed', error: code, stage: 'install' }
    : { kind: 'failed', error: code, exitCode: exit, stage: 'install' }
}

/**
 * 建批量宿主能力：给 N 个目标各建一份单插件宿主能力，共享一套队列端口与一份会话账本。
 * 参数错了在装载时抛（fail fast）；使用范围冲突、装到一半、盘上没有会话这些运行期情况都走回包，不抛。
 */
export function createMultiHostUpdate(
  deps: MultiHostDeps | Record<string, unknown> = {},
  options: MultiHostOptions,
): MultiHostUpdate {
  const input = (deps ?? {}) as MultiHostDeps
  const prefix = assertPrefix(options && options.prefix, '批量电话前缀 prefix')
  const specs = validateTargets(options && options.targets)
  const byKey = new Map(specs.map((spec) => [spec.key, spec]))
  const orderedSpecs = orderTargets(specs.map((spec) => spec.key), options.selfKey ?? null).map(
    (key) => byKey.get(key) as MultiTargetSpec,
  )
  const now = typeof input.now === 'function' ? input.now : Date.now
  const timers = input.timers ?? defaultTimers()
  const randomId =
    typeof input.randomId === 'function' ? input.randomId : () => Math.random().toString(36).slice(2, 12)
  const pollMs =
    typeof input.installPollMs === 'number' && Number.isFinite(input.installPollMs) && input.installPollMs >= 0
      ? Math.floor(input.installPollMs)
      : DEFAULT_INSTALL_POLL_MS

  // 使用范围：批量一份（同一 (homeDir, profileDir) 才共用队列与账本）。
  const env = (input.readerOverrides && input.readerOverrides.env) || process.env
  const batchHome =
    firstText(input.scope?.homeDir, input.readerOverrides?.homeDir, input.config?.homeDir) ?? defaultHomeDir(env, homedir())
  const batchProfile = firstText(input.scope?.profileDir, input.readerOverrides?.profileDir)
  const perTargetOverrides = (spec: MultiTargetSpec): ReaderOverrides =>
    (input.readerOverridesFor ? input.readerOverridesFor(spec) : undefined) ?? {}
  const scopeOf = (spec: MultiTargetSpec): TargetScope => {
    const per = perTargetOverrides(spec)
    return {
      homeDir: firstText(spec.homeDir, per.homeDir) ?? batchHome,
      profileDir: firstText(spec.profileDir, per.profileDir, batchProfile),
    }
  }
  const scopes = new Map(specs.map((spec) => [spec.key, scopeOf(spec)]))
  const distinctScopes = new Set<string>()
  for (const scope of scopes.values()) distinctScopes.add(scope.homeDir + '\u0000' + (scope.profileDir ?? '\u0000'))
  // 混进别的使用范围：如实拒绝（五个电话都回错），绝不跨范围抢锁、绝不写别家的账本。
  const scopeError = distinctScopes.size > 1 ? CROSS_SCOPE_CODE : null
  const batchScope = scopeError ? null : (scopes.get(specs[0].key) as TargetScope)

  // 共享队列端口（#15 的同一份）：七个目标共用一套读写口与一把全局锁，不各建一套。
  // #208 一行修复（C-F02③）：队列端口必须带上按动作方取口的 logFor，否则 update.queue.transition /
  // update.store.fail 落不到正确目录（与 host.ts:399-421 的接线同形状；取口实现在 host-batch-log.ts）。

  const queue =
    batchScope && batchScope.profileDir
      ? createUpdateQueuePorts(batchScope.homeDir, batchScope.profileDir, {
          logFor: pluginLogPort,
          // #209：跃迁判据（pruned/abandoned）必须与宿主 prune 用同一个 TTL 与时钟，否则同一份队列
          // 一边说「过期清理」一边说「主动放弃」。TTL 跟宿主覆盖同源，没覆盖就用端口默认。
          ...(typeof input.readerOverrides?.queueTtlMs === 'number' &&
          Number.isFinite(input.readerOverrides.queueTtlMs) &&
          input.readerOverrides.queueTtlMs > 0
            ? { ttlMs: input.readerOverrides.queueTtlMs }
            : {}),
          nowImpl: () => now(),
        })
      : null
  const baseOverrides: ReaderOverrides = { ...(input.readerOverrides ?? {}) }
  if (queue && !(baseOverrides.readQueue && baseOverrides.writeQueue)) {
    baseOverrides.readQueue = () => queue.readQueue()
    baseOverrides.writeQueue = (state) => queue.writeQueue(state)
    if (typeof baseOverrides.tryAcquireGlobalLock !== 'function') {
      // 陈旧判据单源（#27 ①）：宿主把安装时限作为第三参递进来（host.ts 的抢锁口子），
      // 这里原样转发给队列端口，不再自己写死空对象让窗口退回默认 15 分钟。
      baseOverrides.tryAcquireGlobalLock = (
        lockId: string,
        pluginId: string,
        opts?: { timeoutMs?: number },
      ) => queue.tryAcquireGlobalLock(lockId, pluginId, opts ?? {})
    }
    if (typeof baseOverrides.releaseGlobalLock !== 'function') {
      baseOverrides.releaseGlobalLock = (lockId: string) => queue.releaseGlobalLock(lockId)
    }
  }
  const targetOverrides = (spec: MultiTargetSpec): ReaderOverrides => {
    const per = input.readerOverridesFor ? input.readerOverridesFor(spec) : undefined
    return per ? { ...baseOverrides, ...per } : baseOverrides
  }

  const injectedCheck = input.transport ? input.transport.check : undefined
  const injectedInstall = input.transport ? input.transport.install : undefined
  const configBase = input.config ?? {}
  const runtimes: TargetRuntime[] = orderedSpecs.map((spec) => {
    const config: UpdateConfigInput = {
      ...configBase,
      pluginId: pluginIdOf(spec, prefix),
      prefix: spec.prefix,
      targetPackageName: spec.packageName,
    }
    const resolved = resolveUpdateConfig(config)
    const scope = scopes.get(spec.key) as TargetScope
    let runtime: TargetRuntime
    runtime = {
      spec,
      config,
      resolved,
      host: createHostUpdate(
        {
          ctx: input.ctx,
          logCtx: input.logCtx ?? null,
          desktopPnpm: input.desktopPnpm,
          pluginManager: input.pluginManager,
          readerOverrides: targetOverrides(spec),
        },
        config,
      ),
      pluginId: resolved.pluginId,
      homeDir: scope.homeDir,
      profileDir: scope.profileDir,
      check: injectedCheck ?? (() => defaultCheck(runtime)),
      install:
        injectedInstall ?? ((key: string, one: MultiTargetSpec, requestId: string) => defaultInstall(runtime, key, one, requestId)),
      skipPorts: scope.profileDir ? createSkipDiskPorts(scope.homeDir, resolved.pluginId, scope.profileDir) : null,
      cache: { ...EMPTY_CACHE },
      receipt: null,
      now,
      pollMs,
    }
    return runtime
  })
  const runtimeByKey = new Map(runtimes.map((rt) => [rt.spec.key, rt]))

  /**
   * 批量属主（#124）：selfKey 那家就是「自己」——承载批量面板、自更新排最后的那家。
   * 批量级事件（入队 / 总账）落它的日志目录；没有 selfKey（或清单里没这家）就没有已知落点，
   * 一行不发（ADR-0006：不知道落点就别猜，宁缺勿错）。
   */
  const selfRuntime = options.selfKey ? runtimeByKey.get(options.selfKey) ?? null : null

  // 会话账本按属主隔离（#59 D1/Q2=A：update-queue/<指纹>/<owner>/batch.json；旧无属主 batch.json 永不读写）。
  // 知识账本与偏好同目录（inventory.json / prefs.json）。算不出范围时退化为内存账本。
  const ownerPorts =
    batchScope && batchScope.profileDir ? createBatchOwnerPorts(batchScope.homeDir, batchScope.profileDir, prefix) : null
  let memSession: BatchSession | null = null
  let memInventory: BatchInventory | null = null
  let memPrefs: BatchPrefs = {}
  let driveActive = false
  /** 正在被驱动的那份会话（内存里的唯一真相）：忙时入队并进来的行靠它传给正在跑的驱动。 */
  let liveSession: BatchSession | null = null
  /** 最近一次推进的读数（lastRun 用；推进抛错时不更新）。 */
  let lastRun: { stoppedBecause: BatchStoppedByBecause; steps: BatchRunStep[] } | null = null
  /**
   * 批量侧日志接缝（#208/#209）：入队行去重、总账收尾边沿、「为什么停」、电话失败去重这些
   * 日志状态都在 host-batch-log.ts；这里只递宿主读数，发射点仍与账本/电话同处一条流程。
   */
  const batchLog = createBatchLogSeams({
    ownerPluginId: selfRuntime ? selfRuntime.pluginId : null,
    ownerKey: selfRuntime ? selfRuntime.spec.key : null,
    pluginIdOfTarget: (key) => runtimeByKey.get(key)?.pluginId ?? null,
    lastStoppedBecause: () => lastRun?.stoppedBecause,
    now: () => now(),
  })
  const { logPortFor, noteEntryRequest, noteBatchSummary, noteBatchStopped, noteRunOutcome, notePhoneFail } = batchLog
  let drainTimer: unknown = null
  let disposed = false

  async function readSession(): Promise<BatchSession> {
    if (ownerPorts) return await ownerPorts.readBatch()
    return memSession ?? emptyBatchSession()
  }
  async function saveSession(session: BatchSession): Promise<void> {
    if (ownerPorts) {
      await ownerPorts.writeBatch(session)
      return
    }
    memSession = session
  }
  async function clearSession(): Promise<void> {
    if (ownerPorts) {
      await ownerPorts.clearBatch()
      return
    }
    memSession = emptyBatchSession()
  }
  async function readInventory(): Promise<BatchInventory> {
    if (ownerPorts) return await ownerPorts.readInventory()
    return memInventory ?? emptyBatchInventory()
  }
  async function writeInventory(inventory: BatchInventory): Promise<void> {
    if (ownerPorts) {
      await ownerPorts.writeInventory(inventory)
      return
    }
    memInventory = inventory
  }
  async function readPrefs(): Promise<BatchPrefs> {
    if (ownerPorts) return await ownerPorts.readPrefs()
    return memPrefs
  }
  async function writePrefs(prefs: BatchPrefs): Promise<void> {
    const normalized = normalizeBatchPrefs(prefs)
    if (ownerPorts) {
      await ownerPorts.writePrefs(normalized)
      return
    }
    memPrefs = normalized
  }
  function newSessionId(): string {
    const suffix = String(randomId() ?? '').replace(/[^A-Za-z0-9._~-]/g, '').slice(0, 24)
    return now().toString(36) + '-' + (suffix || hash8(String(now())))
  }

  /** 进度读数：有账本就按账本口径（与 core/batch/model.ts 同一份）；还没有账本时按清单给全待办。 */
  function progressOf(session: BatchSession): BatchProgress {
    if (session.entries.length > 0) return batchProgress(session)
    const total = runtimes.length
    return { total, done: 0, failed: 0, skipped: 0, current: 0, pending: total, finished: false }
  }

  /**
   * 事实优先（#27 ②）：账本记 failed，但该家实时快照显示磁盘上已经是目标版 —— 那次装后来其实
   * 装上了（超时收场、包随后落盘）。把这一行纠成 done，error 留着当痕迹（先失败、后来装上了）。
   * 只纠 failed；只走「重读最新会话 → 改这一行 → 写回」；驱动进行中不走这条路（调用点已守住）。
   */
  async function reconcileFailed(
    rt: TargetRuntime,
    entry: BatchEntry,
  ): Promise<{ session: BatchSession; entry: BatchEntry } | null> {
    if (entry.phase !== 'failed' || !entry.targetVersion) return null
    const snapshot = asRecord(rt.cache.snapshot)
    const installed = firstText(snapshot['installedVersion'])
    if (!installed || installed !== entry.targetVersion) return null
    try {
      const latest = await readSession()
      const current = batchEntryOf(latest, entry.key)
      if (!current || current.phase !== 'failed') return null
      const marked = markBatchEntry(
        latest,
        entry.key,
        { phase: 'done', restartRequired: snapshot['blockedReason'] === 'pending-restart' },
        now(),
      )
      if (!marked.changed) return null
      await saveSession(marked.session)
      const corrected = batchEntryOf(marked.session, entry.key)
      return corrected ? { session: marked.session, entry: corrected } : null
    } catch {
      // 纠正失败不挡状态读取：账本仍是那一行 failed，下次刷新再试。
      return null
    }
  }

  /**
   * 重启后回查（#91）：账本记 done+待重启，但该家实时快照已证明新版在跑
   * （运行版==目标版、磁盘版==运行版、单插件不再报待重启、任务非待重启）——
   * 那次重启其实已生效，把这一行纠成 done 且不再待重启。只清不置：证据不足即保留旧标记。
   * 与 reconcileFailed 同一纪律：重读最新会话 → 改这一行 → 写回；驱动进行中不走这条路。
   */
  async function reconcileRestart(
    rt: TargetRuntime,
    entry: BatchEntry,
  ): Promise<{ session: BatchSession; entry: BatchEntry } | null> {
    if (entry.phase !== 'done' || entry.restartRequired !== true) return null
    const snapshot = asRecord(rt.cache.snapshot)
    const running = firstText(snapshot['runningVersion'])
    const installed = firstText(snapshot['installedVersion'])
    if (!running || !installed) return null
    const target = entry.targetVersion ?? installed
    if (!target) return null
    if (running !== target) return null
    if (installed !== running) return null
    if (firstText(snapshot['blockedReason']) === 'pending-restart') return null
    const job = snapshot['job']
    const jobState = job && typeof job === 'object' && !Array.isArray(job) ? firstText((job as Record<string, unknown>)['state']) : null
    if (jobState === 'restart-required') return null
    try {
      const latest = await readSession()
      const current = batchEntryOf(latest, entry.key)
      if (!current || current.phase !== 'done' || current.restartRequired !== true) return null
      const marked = markBatchEntry(latest, entry.key, { phase: 'done', restartRequired: false, error: null }, now())
      if (!marked.changed) return null
      await saveSession(marked.session)
      const corrected = batchEntryOf(marked.session, entry.key)
      return corrected ? { session: marked.session, entry: corrected } : null
    } catch {
      // 纠正失败不挡状态读取：账本仍是待重启，下次刷新再试。
      return null
    }
  }
  /** 全表行：相位/版本/失败码来自账本，快照来自各目标电话（推进中一律用缓存，见注释）。 */
  async function buildRows(
    session: BatchSession,
    refresh: boolean,
  ): Promise<{ rows: Record<string, unknown>[]; session: BatchSession }> {
    let current = session
    const rows: Record<string, unknown>[] = []
    for (const rt of runtimes) {
      let entry = batchEntryOf(current, rt.spec.key)
      // 推进中不打单插件电话：宿主读取器是单槽缓存，换键会丢掉正在装那家的活动任务编号，
      // 把「在装」误读成「中断」。推进中的行给缓存快照，相位仍从盘上账本实时读。
      if (refresh && !driveActive) {
        await callPhone(rt, rt.host.phoneNames.updateStatus, { includeEnv: true, includeQueue: true })
        if (entry) {
          const corrected = await reconcileFailed(rt, entry)
          if (corrected) {
            current = corrected.session
            entry = corrected.entry
          }
        }
      }
      // 重启后回查：有实时快照即按快照再验一次账本旧标记（读表/重启后自动清零，见 #91）。
      // 推进中不用缓存快照做纠正（缓存是推进前的旧读数）；只在非驱动时纠。
      if (entry && !driveActive) {
        const correctedRestart = await reconcileRestart(rt, entry)
        if (correctedRestart) {
          current = correctedRestart.session
          entry = correctedRestart.entry
        }
      }
      const phase: BatchPhase = entry ? entry.phase : 'pending'
      rows.push({
        key: rt.spec.key,
        title: rt.spec.title ?? rt.spec.key,
        phase,
        targetVersion: entry ? entry.targetVersion : null,
        restartRequired: entry ? entry.restartRequired === true : false,
        error: entry ? entry.error : rt.cache.error,
        snapshot: rt.cache.snapshot,
        manual: rt.cache.manual,
        // #177：行判定也要知道这条命令是不是当帧读数（frame）还是失败后沿用的旧值。
        manualSource: rt.cache.manualSource,
        queue: rt.cache.queue,
        profileName: rt.cache.profileName,
        hostKind: rt.cache.hostKind,
        phoneNames: rt.host.phoneNames,
        // 新增两格（#25 解法三，只增不改）：该目标的宿主插件标识，与最近一次失败回包的诊断。
        pluginId: rt.pluginId,
        diag: rt.cache.diag,
      })
    }
    return { rows, session: current }
  }

  async function table(session: BatchSession, refresh = true): Promise<Record<string, unknown>> {
    const built = await buildRows(session, refresh)
    let inventory: BatchInventory = emptyBatchInventory()
    let prefs: BatchPrefs = {}
    try {
      inventory = await readInventory()
    } catch {
      inventory = emptyBatchInventory()
    }
    try {
      prefs = await readPrefs()
    } catch {
      prefs = {}
    }
    return { ok: true, session: built.session, rows: built.rows, progress: progressOf(built.session), inventory, prefs }
  }

  function denied(): Record<string, unknown> | null {
    if (!scopeError) return null
    return { ok: false, error: scopeError, errorKind: scopeError }
  }

  function runtimeOf(key: string): TargetRuntime {
    const rt = runtimeByKey.get(key)
    if (!rt) throw batchFail('check-failed')
    return rt
  }

  async function checkByKey(key: string): Promise<BatchCheckOutcome> {
    const rt = runtimeOf(key)
    return await rt.check(key, rt.spec)
  }

  /** 装一家；回 queued（已占位、排队等轮到你）时把队列位置补进该行读数，面板据此显示「已排队 · 前方 N 个」。 */
  async function installByKey(key: string, requestId: string, version: string): Promise<BatchInstallOutcome> {
    const rt = runtimeOf(key)
    const outcome = await rt.install(key, rt.spec, requestId, version)
    if (outcome.kind === 'queued') {
      const position =
        typeof outcome.position === 'number' && Number.isFinite(outcome.position) ? outcome.position : null
      if (position !== null) rt.cache = { ...rt.cache, queue: { ...asRecord(rt.cache.queue), position } }
    }
    return outcome
  }

  /** 显式重试：选中的行里，失败（或显式点到的跳过）先复位成 pending 再推，别的行不动。 */
  function resetForRetry(session: BatchSession, selected: Set<string> | null, at: number): BatchSession {
    let changed = false
    const entries = session.entries.map((entry) => {
      const picked = selected === null || selected.has(entry.key)
      if (!picked) return entry
      const retryable = entry.phase === 'failed' || (selected !== null && entry.phase === 'skipped')
      if (!retryable) return entry
      changed = true
      return { ...entry, phase: 'pending' as BatchPhase, error: null, updatedAt: at }
    })
    return changed ? { ...session, entries, updatedAt: at } : session
  }

  /**
   * 推进会话：一轮一步地走（每轮至多一次传输调用），轮与轮之间把「驱动期间并入的行」并进来，
   * 所以忙时入队的那几家会在本轮接着被推，而不是等下一次点击。调用方必须先占住 driveActive。
   * budget：允许的传输调用次数（Infinity = 推到收尾；drain 给 1 = 只推一步）。
   */
  async function driveLocked(session: BatchSession, selected: Set<string> | null, budget: number): Promise<BatchSession> {
    let full = mergeInto(session, liveSession)
    liveSession = full
    const steps: BatchRunStep[] = []
    let remaining = budget
    let guard = 0
    try {
      while (true) {
        // 忙时入队：驱动期间并进来的行这一轮就带上（不丢意图，也不等下一次点击）。
        full = mergeInto(full, liveSession)
        liveSession = full
        const view: BatchSession =
          selected === null
            ? full
            : {
                ...full,
                order: full.order.filter((key) => selected.has(key)),
                entries: full.entries.filter((entry) => selected.has(entry.key)),
              }
        const result = await runBatch(
          view,
          {
            check: (key: string) => checkByKey(key),
            install: (key: string, requestId: string, version: string) => installByKey(key, requestId, version),
            save: async (next: BatchSession) => {
              // 只推几家的视图合并回全量账本；忙时入队的行也在这里保住（驱动不会再把它覆盖掉）。
              const merged = mergeInto(next, liveSession)
              liveSession = merged
              full = merged
              await saveSession(merged)
            },
            now: () => now(),
            logFor: logPortFor,
            // 失败行的序号取**整批**顺序（视图可能只含选中的几行，findIndex 会给视图序号）。
            indexOf: (key: string) => full.order.indexOf(key),
          },
          { maxSteps: 1 },
        )
        for (const step of result.steps) steps.push(step)
        remaining -= 1
        guard += 1
        if (result.stoppedBecause !== 'max-steps') {
          lastRun = { stoppedBecause: result.stoppedBecause, steps }
          return full
        }
        if (remaining <= 0 || guard >= DRIVE_STEP_GUARD) {
          lastRun = { stoppedBecause: 'max-steps', steps }
          return full
        }
      }
    } finally {
      liveSession = null
    }
  }

  /** 单飞入口：抢到位子才推（resume / drain 走这条；batchInstall 自己占位后直接调 driveLocked）。 */
  async function drive(session: BatchSession, selected: Set<string> | null, budget: number): Promise<BatchSession> {
    if (driveActive) throw batchFail('update-busy')
    driveActive = true
    try {
      return await driveLocked(session, selected, budget)
    } finally {
      driveActive = false
    }
  }

  function selectedKeysOf(args: Record<string, unknown>): Set<string> | null {
    const raw = args['keys']
    if (!Array.isArray(raw)) return null
    const selected = new Set<string>()
    for (const item of raw) {
      if (typeof item === 'string' && runtimeByKey.has(item)) selected.add(item)
    }
    return selected
  }

  async function statusPhone(): Promise<Record<string, unknown>> {
    const refuse = denied()
    if (refuse) return refuse
    return await table(await readSession())
  }

  /** 单家查新并收敛知识行：checkPhone 与两段式预查共用（只写知识，不建会话、不装）。 */
  function applyCheckToInventory(
    entries: BatchInventory['entries'],
    rt: TargetRuntime,
    outcome: BatchCheckOutcome,
    at: number,
  ): void {
    rt.cache = { ...rt.cache, error: outcome.kind === 'failed' ? outcome.error : null }
    const snapshot = asRecord(rt.cache.snapshot)
    // 在场事实与行内快照同步（#134）：installedVersion 只取磁盘版，不回退运行版号——
    // 缺席时恒为 null，面板不再把注入的假版号当成已装版本。
    const snapInstalled = snapshot['installed']
    const installed = typeof snapInstalled === 'boolean' ? snapInstalled : null
    const installedVersionRaw = snapshot['installedVersion']
    const installedVersion = typeof installedVersionRaw === 'string' && installedVersionRaw ? installedVersionRaw : null
    const canInstallRaw = snapshot['canInstall']
    const canInstall = typeof canInstallRaw === 'boolean' ? canInstallRaw : null
    if (outcome.kind === 'update') {
      entries[rt.spec.key] = { lastCheckedAt: at, installed, installedVersion, latestVersion: outcome.version, canInstall, error: null }
    } else if (outcome.kind === 'current') {
      entries[rt.spec.key] = { lastCheckedAt: at, installed, installedVersion, latestVersion: installedVersion, canInstall: false, error: null }
    } else if (outcome.kind === 'skipped') {
      entries[rt.spec.key] = { lastCheckedAt: at, installed, installedVersion, latestVersion: outcome.version, canInstall: false, error: null }
    } else {
      entries[rt.spec.key] = {
        lastCheckedAt: at,
        installed,
        installedVersion,
        latestVersion: firstText(snapshot['latestVersion']),
        canInstall,
        error: outcome.error,
      }
    }
  }

  function applyCheckErrorToInventory(
    entries: BatchInventory['entries'],
    rt: TargetRuntime,
    error: unknown,
    at: number,
  ): void {
    const code = errorPayloadOf(error).error
    rt.cache = { ...rt.cache, error: code }
    const snapshot = asRecord(rt.cache.snapshot)
    const errInstalled = snapshot['installed']
    const errInstalledVersionRaw = snapshot['installedVersion']
    entries[rt.spec.key] = { lastCheckedAt: at, installed: typeof errInstalled === 'boolean' ? errInstalled : null, installedVersion: typeof errInstalledVersionRaw === 'string' && errInstalledVersionRaw ? errInstalledVersionRaw : null, latestVersion: firstText(snapshot['latestVersion']), canInstall: typeof snapshot['canInstall'] === 'boolean' ? (snapshot['canInstall'] as boolean) : null, error: code }
  }

  async function checkPhone(): Promise<Record<string, unknown>> {
    const refuse = denied()
    if (refuse) return refuse
    // 驱动进行中不静默跳过（#90 R4）：回忙（与 batchResume/batchCancel 同口径），
    // 绝不用旧表冒充 fresh 结果；调用方（面板自动查）本就吞掉非 ok 回包，手动点则见忙横幅。
    if (driveActive) return { ok: false, error: 'update-busy', errorKind: 'update-busy' }
    const session = await readSession()
    const at = now()
    let prev: BatchInventory = emptyBatchInventory()
    try {
      prev = await readInventory()
    } catch {
      prev = emptyBatchInventory()
    }
    const entries: BatchInventory['entries'] = { ...prev.entries }
    const outcomes = new Map<string, BatchCheckOutcome>()
    await runWithConcurrency(runtimes, BATCH_CHECK_CONCURRENCY, async (rt) => {
      try {
        const outcome = await rt.check(rt.spec.key, rt.spec)
        outcomes.set(rt.spec.key, outcome)
        applyCheckToInventory(entries, rt, outcome, at)
      } catch (error) {
        applyCheckErrorToInventory(entries, rt, error, at)
      }
    })
    try {
      await writeInventory(normalizeBatchInventory({ version: 1, updatedAt: at, entries }, at))
    } catch {
      // 知识落盘失败不挡检查回包（只做展示）。
    }
    // 成功检查对账（#152）：检查的后置条件是“此后展示的状态反映这次检查”。
    // 只查不装以前只写知识、会话终态（昨日失败/陈旧目标）永生，面板永远拼出昨天的数据。
    // 成功查出结论的行按与驱动预查同一口径收敛进会话；查失败的行没学到新东西，原样保留；
    // 重启 pending 行一律不动（等重启收尾）；飞行中（checking/installing）是驱动正在经手的行，
    // 检查不许碰；驱动半路起跑则跳过落盘（不踩驱动的账本）。
    let reconciled = session
    for (const [key, outcome] of outcomes) {
      const entry = batchEntryOf(reconciled, key)
      if (!entry || entry.restartRequired) continue
      if (entry.phase === 'checking' || entry.phase === 'installing') continue
      let patch: Partial<Omit<BatchEntry, 'key' | 'requestId'>> | null = null
      if (outcome.kind === 'update') {
        if (entry.phase !== 'ready' || entry.targetVersion !== outcome.version || entry.error !== null) {
          patch = { phase: 'ready', targetVersion: outcome.version, error: null }
        }
      } else if (outcome.kind === 'current') {
        if (entry.phase !== 'current' || entry.targetVersion !== null || entry.error !== null) {
          patch = { phase: 'current', targetVersion: null, error: null }
        }
      } else if (outcome.kind === 'skipped') {
        if (entry.phase !== 'skipped' || entry.targetVersion !== outcome.version || entry.error !== null) {
          patch = { phase: 'skipped', targetVersion: outcome.version, error: null }
        }
      }
      if (patch) {
        const marked = markBatchEntry(reconciled, key, patch, at)
        if (marked.changed) reconciled = marked.session
      }
    }
    if (reconciled !== session && !driveActive) {
      try {
        await saveSession(reconciled)
      } catch {
        // 落盘失败就当没对上：下面重读盘上账本回包，不端没存住的东西。
      }
    }
    // 端出去的永远是盘上那份（落盘后重读）：存住才展示，驱动接管了就展示驱动的，
    // 下一次打开不会回退到昨天。
    let served = reconciled
    try {
      served = await readSession()
    } catch {
      served = reconciled
    }
    return await table(served, false)
  }

  /** 忙时入队：把 keys 并进「正在被驱动的那份会话」（幂等，显式点到的失败行先复位重试），落盘后回全表。 */
  async function joinWhileBusy(selected: Set<string> | null): Promise<Record<string, unknown>> {
    let session = liveSession ?? (await readSession())
    if (session.entries.length === 0) {
      // 理论上到不了（有驱动在跑就一定有会话）：真到了就按全清单补一份，别把用户的意图丢了。
      session = createBatchSession({
        id: newSessionId(),
        keys: runtimes.map((rt) => rt.spec.key),
        selfKey: options.selfKey ?? null,
        stopOnFailure: options.stopOnFailure === true,
        now: now(),
      })
      liveSession = session
      await saveSession(session)
    } else {
      let next = selected && selected.size > 0 ? addKeys(session, selected, now()) : session
      next = resetForRetry(next, selected, now())
      if (next !== session) {
        session = next
        liveSession = session
        await saveSession(session)
      }
    }
    // 忙时入队并进来的行走同一条入队口径（同一份会话只记一次）。
    noteEntryRequest(session)
    return await table(session, false)
  }

  /**
   * 两段式预查（#70 生产者）：把选中 keys 先全查成 ready 进会话，再由 driveLocked 串行装。
   * - 并发查（BATCH_CHECK_CONCURRENCY），知识与会话同轮收敛，只写 inventory + 置 ready，不装；
   * - 终态行跳过，ready 有版复用不重查；失败行照常落盘，stopOnFailure 由驱动阶段执行；
   * - 传输抛错（真路径不会抛，只假件模拟崩溃）沿旧口径上抛，调用方回 ok:false，已收敛的行已落盘。
   */
  async function precheckSelectedToReady(
    session: BatchSession,
    selected: Set<string> | null,
  ): Promise<BatchSession> {
    let current = session
    const candidates = current.order.filter((key) => selected === null || selected.has(key))
    const pendingKeys: string[] = []
    for (const key of candidates) {
      const entry = batchEntryOf(current, key)
      if (!entry || isTerminalPhase(entry.phase)) continue
      if (entry.phase === 'ready' && entry.targetVersion) continue
      pendingKeys.push(key)
    }
    if (pendingKeys.length === 0) return current
    // 预查落盘必须先把「预查窗口里并进来的行」并回来（F2）：并发的 batchInstall
    // 在 driveActive 置位期间走 joinWhileBusy（写 liveSession + 落盘），而预查手里的
    // current 是那之前的快照；直接 saveSession(current) 会把并入的行暂时挤出盘面。
    const persistPrecheck = async (): Promise<void> => {
      current = mergeInto(current, liveSession)
      await saveSession(current)
    }
    // 先逐家记 checking 落盘（中断后知道哪家没查完，与驱动器单步口径一致）。
    for (const key of pendingKeys) {
      const marked = markBatchEntry(current, key, { phase: 'checking', error: null }, now())
      if (marked.changed) {
        current = marked.session
        await persistPrecheck()
      }
    }
    const at = now()
    let prev: BatchInventory = emptyBatchInventory()
    try {
      prev = await readInventory()
    } catch {
      prev = emptyBatchInventory()
    }
    const entries: BatchInventory['entries'] = { ...prev.entries }
    const outcomes = new Map<string, BatchCheckOutcome>()
    // #209：传输抛错的那几家也各记一条失败行（旧口径是留在 checking、只上抛 firstError，日志里静默）。
    const thrown = new Map<string, unknown>()
    let firstError: unknown = null
    let hasError = false
    await runWithConcurrency(pendingKeys, BATCH_CHECK_CONCURRENCY, async (key) => {
      const rt = runtimeOf(key)
      try {
        const outcome = await rt.check(key, rt.spec)
        outcomes.set(key, outcome)
        applyCheckToInventory(entries, rt, outcome, at)
      } catch (error) {
        thrown.set(key, error)
        if (!hasError) {
          hasError = true
          firstError = error
        }
        applyCheckErrorToInventory(entries, rt, error, at)
      }
    })
    try {
      await writeInventory(normalizeBatchInventory({ version: 1, updatedAt: at, entries }, at))
    } catch {
      // 知识落盘失败不挡会话收敛（只做展示）。
    }
    // 按会话顺序收敛结果并落盘；抛错的那家留在 checking（与旧驱动口径一致），最后再上抛。
    for (const key of pendingKeys) {
      if (!outcomes.has(key)) continue
      const outcome = outcomes.get(key) as BatchCheckOutcome
      let patch: Partial<Omit<BatchEntry, 'key' | 'requestId'>> | null = null
      if (outcome.kind === 'update') {
        patch = { phase: 'ready', targetVersion: outcome.version, error: null }
      } else if (outcome.kind === 'current') {
        patch = { phase: 'current', targetVersion: null, error: null }
      } else if (outcome.kind === 'skipped') {
        patch = { phase: 'skipped', targetVersion: outcome.version, error: null }
      } else {
        patch = { phase: 'failed', error: outcome.error }
      }
      if (patch) {
        const marked = markBatchEntry(current, key, patch, now())
        if (marked.changed) {
          current = marked.session
          await persistPrecheck()
        }
      }
      // #209：预查失败不再静默——与驱动失败同一行形状、同一个发射口（stage=check，index=整批序号）。
      if (outcome.kind === 'failed') {
        noteBatchEntryFailure(
          logPortFor,
          { sessionId: current.id, key, action: 'check', index: current.order.indexOf(key) },
          { error: outcome.error, stage: 'check' },
        )
      }
    }
    // 传输抛错的那几家：错误码一律折成 unknown（异常 message 里可能有路径/URL），但「哪家没查成」要说出来。
    for (const key of pendingKeys) {
      if (!thrown.has(key)) continue
      noteBatchEntryFailure(
        logPortFor,
        { sessionId: current.id, key, action: 'check', index: current.order.indexOf(key) },
        { error: 'unknown', stage: 'check' },
      )
    }
    if (hasError) throw firstError
    return current
  }

  async function installPhone(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const refuse = denied()
    if (refuse) return refuse
    const selected = selectedKeysOf(args)
    // 忙时入队（#25 排队语义）：驱动进行中不再回 update-busy——把 keys 并进当前会话（幂等）就回全表；
    // 单飞：已有驱动在跑就不另起一个，等它把这批带完（或用户再点一次 / drain 接着推）。
    if (driveActive) return await joinWhileBusy(selected)
    if (selected && selected.size === 0) return await table(await readSession())
    driveActive = true
    let driven: BatchSession
    let session: BatchSession | null = null
    try {
      session = await readSession()
      // 盘上没会话、或上一轮已收尾（且这次是「全部提交」）：按全清单开新会话
      // （新编号 ⇒ 重新查一遍；已是最新的自然进 current，不重装）。
      // 行内只推几家（keys）时即使上一轮已收尾也复用同一份账本：别家的 done/failed 是事实，不能抹掉。
      const reuse = session.entries.length > 0 && (selected !== null || !isBatchFinished(session))
      if (!reuse) {
        session = createBatchSession({
          id: newSessionId(),
          keys: runtimes.map((rt) => rt.spec.key),
          selfKey: options.selfKey ?? null,
          stopOnFailure: options.stopOnFailure === true,
          now: now(),
        })
        await saveSession(session)
      }
      const retried = resetForRetry(session, selected, now())
      if (retried !== session) {
        session = retried
        await saveSession(session)
      }
      // 入队行在建/复用会话之后记（新建与复用都由它兜住，同一份会话只记一次）。
      noteEntryRequest(session)
      // 推进前先看一次账本：重试把失败行退回 pending 时，「已收尾」标记要跟着清掉，
      // 装成后的那次收尾才算一次新的边沿（日志不写假话）。
      noteBatchSummary(session)
      // 两段式（#70）：先把选中 keys 全查成 ready 进会话，再串行装（装阶段复用 ready，不重查）。
      session = await precheckSelectedToReady(session, selected)
      driven = await driveLocked(session, selected, Number.POSITIVE_INFINITY)
      // 收尾总账（#209 起同时记「没跑完就停」的那一行）：面板只渲染不重发。
      noteRunOutcome(driven)
    } catch (error) {
      // #209：驱动自己抛异常也是一次「停止」——记之前先读回最新账本（推进是逐步落盘的），
      // 否则停止行的计数会停在推进开始前（把已装好的算成没装）。
      try {
        noteBatchStopped(await readSession(), 'error')
      } catch {}
      return { ok: false, ...errorPayloadOf(error) }
    } finally {
      driveActive = false
    }
    // 驱动已收尾：这里才刷新各行快照（含排队位置），排队中不打扰正在跑的那家。
    return await table(driven)
  }

  async function resumePhone(): Promise<Record<string, unknown>> {
    const refuse = denied()
    if (refuse) return refuse
    if (driveActive) return { ok: false, error: 'update-busy', errorKind: 'update-busy' }
    const disk = await readSession()
    const hadUnfinished = disk.entries.length > 0 && !isBatchFinished(disk)
    if (!hadUnfinished) return { ...(await table(disk)), resumed: false }
    const resumed = resumeBatchSession(disk, now())
    if (resumed !== disk) await saveSession(resumed)
    try {
      const driven = await drive(resumed, null, Number.POSITIVE_INFINITY)
      // 跨重启续跑收尾：这一轮是「接着推」，但收尾仍在宿主侧汇总（面板不重发）；
      // 没跑完就停也记一行（#209）。
      noteRunOutcome(driven)
      return { ...(await table(driven)), resumed: true }
    } catch (error) {
      // #209：续跑时驱动抛异常同样是「停止」——同样读回最新账本再记（计数跟事实走）。
      try {
        noteBatchStopped(await readSession(), 'error')
      } catch {}
      return { ok: false, ...errorPayloadOf(error) }
    }
  }

  async function cancelPhone(): Promise<Record<string, unknown>> {
    const refuse = denied()
    if (refuse) return refuse
    // 推进中不许清账本：清了会让下一轮换新编号重复装，宁可回忙。
    if (driveActive) return { ok: false, error: 'update-busy', errorKind: 'update-busy' }
    // #209：用户取消也是一次「驱动停止」——在清账本之前把原因记一行（只记真没收尾、真有活儿的那份）。
    try {
      const current = await readSession()
      if (current.entries.length > 0 && !isBatchFinished(current)) {
        noteBatchStopped(current, 'user-cancel')
      }
    } catch {
      // 读不到账本不挡取消：取消本身仍按原口径清空。
    }
    await clearSession()
    return await table(emptyBatchSession())
  }

  const drainEnabled = options.drain === true
  const drainIntervalMs = Math.max(
    MIN_DRAIN_INTERVAL_MS,
    typeof options.drainIntervalMs === 'number' && Number.isFinite(options.drainIntervalMs) && options.drainIntervalMs > 0
      ? Math.floor(options.drainIntervalMs)
      : DEFAULT_DRAIN_INTERVAL_MS,
  )

  async function drainOnce(): Promise<void> {
    if (disposed || driveActive || scopeError) return
    const disk = await readSession()
    if (disk.entries.length === 0 || isBatchFinished(disk)) return
    try {
      // drain 一轮只推一步：推完可能正好收尾（最后一家做完），总账就在这一轮记；
      // 排上队/按策略停下也各有一行（#209）。
      noteRunOutcome(await drive(disk, null, 1))
    } catch {
      // #209：驱动自己抛异常不再静默——读回最新账本后记一行「为什么停」（同一原因只记一次），
      // 再照旧吞掉（后台节拍）。
      try {
        noteBatchStopped(await readSession(), 'error')
      } catch {}
    }
  }

  async function tickDrain(): Promise<void> {
    drainTimer = null
    if (disposed) return
    try {
      await drainOnce()
    } catch {}
    armDrain()
  }

  function armDrain(): void {
    if (disposed || !drainEnabled) return
    drainTimer = timers.setTimeout(() => {
      void tickDrain()
    }, drainIntervalMs)
  }

  async function prefsPhone(): Promise<Record<string, unknown>> {
    const refuse = denied()
    if (refuse) return refuse
    return { ok: true, prefs: await readPrefs() }
  }

  async function prefsSavePhone(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const refuse = denied()
    if (refuse) return refuse
    const current = await readPrefs()
    const next: BatchPrefs = { ...current }
    if ('checkOnOpen' in args) {
      const v = args['checkOnOpen']
      if (typeof v !== 'boolean') return { ok: false, error: 'check-failed', errorKind: 'check-failed' }
      next.checkOnOpen = v
    }
    await writePrefs(next)
    return { ok: true, prefs: next }
  }

  const phoneNames: BatchHostPhoneNames = {
    status: prefix + '.batchStatus',
    check: prefix + '.batchCheck',
    install: prefix + '.batchInstall',
    resume: prefix + '.batchResume',
    cancel: prefix + '.batchCancel',
    prefs: prefix + '.batchPrefs',
    prefsSave: prefix + '.batchPrefsSave',
  }

  function phone(
    name: string,
    kind: string,
    fn: (args: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ): (args?: Record<string, unknown>) => Promise<unknown> {
    return async (args?: Record<string, unknown>): Promise<Record<string, unknown>> => {
      let reply: Record<string, unknown>
      try {
        reply = await fn(asRecord(args))
      } catch (error) {
        reply = { ok: false, ...errorPayloadOf(error) }
      }
      try {
        notePhoneFail(name, kind, reply)
      } catch {
        // 记日志是旁路：永不改变回包
      }
      return reply
    }
  }
  const handlers: Record<string, (args?: Record<string, unknown>) => Promise<unknown>> = {}
  handlers[phoneNames.status] = phone(phoneNames.status, 'batch-status', () => statusPhone())
  handlers[phoneNames.check] = phone(phoneNames.check, 'batch-check', () => checkPhone())
  handlers[phoneNames.install] = phone(phoneNames.install, 'batch-install', (args) => installPhone(args))
  handlers[phoneNames.resume] = phone(phoneNames.resume, 'batch-resume', () => resumePhone())
  handlers[phoneNames.cancel] = phone(phoneNames.cancel, 'batch-cancel', () => cancelPhone())
  handlers[phoneNames.prefs] = phone(phoneNames.prefs, 'batch-prefs', () => prefsPhone())
  handlers[phoneNames.prefsSave] = phone(phoneNames.prefsSave, 'batch-prefs-save', (args) => prefsSavePhone(args))
  // 每个目标的单插件三电话照旧各自前缀暴露：批量电话与它们同处一张表，接入方一次登记。
  for (const rt of runtimes) {
    for (const name of Object.keys(rt.host.handlers)) {
      const handler = rt.host.handlers[name]
      handlers[name] = (args?: Record<string, unknown>) => handler(asRecord(args))
    }
  }
  // 批量面板自建的客户端日志通道打的是 `buildLogAppendPhoneName(批量前缀)`（#208）：登记为属主 logAppend
  // 的转发，面板行就落进属主日志目录。没有属主（或属主没接日志）不登记——面板行宁可投递失败，也不猜落点。
  // 放在逐目标并入之后：万一某个目标前缀与批量前缀相同，以「转发给属主」这一份为准。
  if (selfRuntime) {
    const ownerLogAppendName = selfRuntime.host.phoneNames.logAppend
    const ownerLogAppend = selfRuntime.host.handlers[ownerLogAppendName]
    if (typeof ownerLogAppend === 'function') {
      const batchLogAppendName = buildLogAppendPhoneName(prefix)
      phoneNames.logAppend = batchLogAppendName
      handlers[batchLogAppendName] = (args?: Record<string, unknown>) => ownerLogAppend(asRecord(args))
    }
  }

  armDrain()

  return {
    handlers,
    phoneNames,
    targets: orderedSpecs,
    get lastRun(): { stoppedBecause: BatchStoppedByBecause; steps: BatchRunStep[] } | null {
      return lastRun
    },
    dispose(): void {
      disposed = true
      if (drainTimer !== null) {
        timers.clearTimeout(drainTimer)
        drainTimer = null
      }
    },
  }
}
