// src/host/batch/fan-out.ts —— 批量扇出装配（#227 从 host-batch.ts 搬出，蓝图 §4 batch 域）。
//
// 身份：createMultiHostUpdate 本体——给 N 个目标各建一份单插件宿主能力（前缀与插件标识隔离），
// 共享同一套队列端口与一份会话账本，把七个批量电话翻译成驱动器的一步步推进。
// 电话外壳/目标零件见 ./phones.js，账本幂等换算与会话行合并见 ./resume.js，日志接缝见 ./log.js。

import {
  asRecord,
  callPhone,
  defaultCheck,
  defaultInstall,
  defaultTimers,
  EMPTY_CACHE,
  errorPayloadOf,
  firstText,
  pluginIdOf,
  validateTargets,
  type BatchHostPhoneNames,
  type TargetRuntime,
  type TargetScope,
} from './phones.js'
import { addKeys, mergeInto } from './resume.js'
import type { MultiHostDeps, MultiHostOptions, MultiHostUpdate, MultiTargetSpec } from '../../host-batch.js'

import { homedir } from 'node:os'
import { basename } from 'node:path'
import { hash8 } from '../../shared/hash.js'
import { createHubPlan, type HubPlan, type HubScopeRef } from '../../core/hub/plan.js'
import { emptyHubSnapshot } from '../../core/hub/snapshot.js'
import { readHubStatus } from '../hub/aggregate.js'
import { adoptOrphanHubTasks } from '../hub/adopt.js'
import { hubBusyForScope, submitHubTask } from '../hub/registry.js'
import type { HubRuntimeDeps, HubScope, HubSeat } from '../hub/protocol.js'
import {
  batchEntryOf,
  batchProgress,
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
} from '../../core/batch/model.js'
import {
  noteBatchEntryFailure,
  runBatch,
  type BatchCheckOutcome,
  type BatchInstallOutcome,
  type BatchRunStep,
  type BatchStoppedByBecause,
} from '../../core/batch/run.js'
import { assertPrefix, buildLogAppendPhoneName, resolveUpdateConfig, type UpdateConfigInput } from '../../shared/config.js'
import { CROSS_SCOPE_CODE } from '../../shared/codes.js'
import { createBatchLogSeams, pluginLogPort } from './log.js'
import { createHostUpdate } from '../../host/factory.js'
import type { ReaderOverrides } from '../../host/capabilities.js'
import { defaultHomeDir } from '../../core/reader.js'
import {
  createBatchOwnerPorts,
  createSkipDiskPorts,
  emptyBatchInventory,
  normalizeBatchInventory,
  normalizeBatchPrefs,
  type BatchInventory,
  type BatchPrefs,
} from '../../core/disk.js'
import { createUpdateQueuePorts } from '../../core/queue/ports.js'
import type { UpdateQueueState } from '../../core/queue/model.js'

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
//   1. 每个目标一份 createHostUpdate：它的单例复用键含插件标识与前缀（见 host/factory.ts），
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
// ---------- 小工具（纯函数，可单独看） ----------

const DEFAULT_DRAIN_INTERVAL_MS = 5000
const MIN_DRAIN_INTERVAL_MS = 1000
const DEFAULT_INSTALL_POLL_MS = 500
/**
 * 本入口的认码一律走 src/shared/codes.ts 的归属判断（真源那两张表在这里不再抄第二份）：
 * 电话/队列认 `isBatchReplyCode`（核心码面 + 本入口的 cross-scope），
 * 任务说明前缀认 `isCoreErrorCode`（核心码面）。
 */
function batchFail(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code })
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
  const orderedSpecs = orderTargets(specs.map((spec) => spec.key), options.selfKey ?? null, options.selfOrder).map(
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

  // 进程内更新中枢（ADR-0008）：批量推进从本 fiber 里搬出去。
  // 缺省开关：有宿主 ctx（真机接入）时开；纯宿主脚本/测试显式 hub:true 可开；hub:false 强制回旧路径。
  const hubEnabled = options.hub === true || (options.hub !== false && input.ctx != null)
  // #250：范围解析与中枢开关解耦——只读全局进度电话在 hub:false 下也要能答（从盘上读）。
  const hubScope: HubScope | null =
    batchScope && batchScope.profileDir
      ? {
          homeDir: batchScope.homeDir,
          profileDir: batchScope.profileDir,
          profileName:
            firstText(input.scope?.profileName, input.readerOverrides?.profileName, basename(batchScope.profileDir)) ??
            basename(batchScope.profileDir),
        }
      : null
  const hubPlanScope: HubScopeRef | null = hubScope
    ? {
        homeDir: hubScope.homeDir,
        profileDir: hubScope.profileDir,
        profileName: hubScope.profileName,
        ...(firstText(input.readerOverrides?.environmentKind)
          ? { environmentKind: firstText(input.readerOverrides?.environmentKind) as string }
          : {}),
        ...(firstText(input.config?.releaseChannel)
          ? { releaseChannel: firstText(input.config?.releaseChannel) as string }
          : {}),
        ...(firstText(input.config?.registryUrl) ? { registryUrl: firstText(input.config?.registryUrl) as string } : {}),
      }
    : null
  const hubDeps: HubRuntimeDeps = {
    now: () => now(),
    randomId: () => String(randomId() ?? ''),
    timers,
    pid: typeof process !== 'undefined' && typeof process.pid === 'number' ? process.pid : 0,
    ...(typeof input.hubRetryMs === 'number' && Number.isFinite(input.hubRetryMs) && input.hubRetryMs > 0
      ? { retryMs: Math.floor(input.hubRetryMs) }
      : {}),
    ...(typeof input.hubIsProcessAlive === 'function' ? { isProcessAlive: input.hubIsProcessAlive } : {}),
    // #253：落盘端口只在测试里注入（故障注入验证异常边界）；生产不传，走真实文件系统。
    ...(input.hubIo ? { io: input.hubIo } : {}),
  }

  // 共享队列端口（#15 的同一份）：七个目标共用一套读写口与一把全局锁，不各建一套。
  // #208 一行修复（C-F02③）：队列端口必须带上按动作方取口的 logFor，否则 update.queue.transition /
  // update.store.fail 落不到正确目录（与 host/factory.ts 的 wireUpdateLog 同形状；取口实现在 host/batch/log.ts）。

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
   * 日志状态都在 host/batch/log.ts；这里只递宿主读数，发射点仍与账本/电话同处一条流程。
   */
  const batchLog = createBatchLogSeams({
    ownerPluginId: selfRuntime ? selfRuntime.pluginId : null,
    ownerKey: selfRuntime ? selfRuntime.spec.key : null,
    pluginIdOfTarget: (key) => runtimeByKey.get(key)?.pluginId ?? null,
    lastStoppedBecause: () => lastRun?.stoppedBecause,
    now: () => now(),
  })
  const { logPortFor, noteEntryRequest, noteBatchSummary, noteBatchStopped, noteRunOutcome, notePhoneFail, noteRunStart } = batchLog

  /**
   * #217：撤掉批次自己留下的排队占位。真机 2026-10-19 08:47：续跑把待装行的意向写进共享队列后
   * 因「非队首」停下，队首那条的任务却已经结束——10 分钟 TTL 内任何安装都被公平门判
   * update-busy，面板上就表现为「点全部更新毫无反应」。所以每次开跑（建会话/续跑/drain 每一轮）
   * 和用户取消时都先扫掉自己的遗留意向；停下时不扫——留着的占位还要给面板显示位置、给「取消排队」用。
   * 只清 targetPluginIds 且 requestId 以 `batch-` 开头的 waiting 条目；owner 不碰（正在装的别家不受影响）。
   */
  async function clearBatchQueueIntents(): Promise<void> {
    try {
      const read = baseOverrides.readQueue ?? (queue ? () => queue.readQueue() : null)
      const write =
        baseOverrides.writeQueue ?? (queue ? (next: UpdateQueueState) => queue.writeQueue(next) : null)
      if (!read || !write) return
      const state = await read()
      const ids = new Set(runtimes.map((rt) => rt.pluginId))
      const waiting = state.waiting.filter(
        (one) =>
          !(ids.has(one.pluginId) && typeof one.requestId === 'string' && one.requestId.startsWith('batch-')),
      )
      if (waiting.length === state.waiting.length) return
      await write({ version: 1, owner: state.owner, waiting })
    } catch {}
  }
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

  /**
   * 执行席（ADR-0008）：把「查/装/落盘/日志 + 方案」冻结成一个值交给进程级中枢。
   * 席位里的函数只依赖盘与宿主能力，不依赖本 fiber 是否还活着——这正是自更新后能接着推的前提。
   */
  function hubSeatFor(session: BatchSession): HubSeat | null {
    // 中枢没启用（hub:false 且无宿主上下文）时绝不出席：否则范围一解析出来就会抢驱动，
    // 「hub:false 退回旧路径」的承诺就破了。只读进度电话不受这里影响（它读盘，不驱动）。
    if (!hubEnabled || !hubScope || !hubPlanScope) return null
    const plan = createHubPlan({
      sessionId: session.id,
      owner: prefix,
      targets: runtimes.map((rt) => ({
        key: rt.spec.key,
        title: rt.spec.title ?? rt.spec.key,
        packageName: rt.spec.packageName,
        pluginId: rt.pluginId,
        prefix: rt.spec.prefix,
        ...(rt.homeDir ? { homeDir: rt.homeDir } : {}),
        ...(rt.profileDir ? { profileDir: rt.profileDir } : {}),
      })),
      scope: hubPlanScope,
      selfKey: options.selfKey ?? null,
      selfOrder: options.selfOrder,
      stopOnFailure: options.stopOnFailure === true,
      now: now(),
    })
    // 失败行的序号取**提交时**的整批顺序（视图可能只含选中的几行，不能用视图下标）。
    const order = [...session.order]
    return {
      owner: prefix,
      plan,
      readSession,
      saveSession,
      check: (key: string) => checkByKey(key),
      install: (key: string, requestId: string, version: string) => installByKey(key, requestId, version),
      logFor: logPortFor,
      indexOf: (key: string) => order.indexOf(key),
      enterDrive: () => {
        driveActive = true
      },
      exitDrive: () => {
        driveActive = false
      },
      onSettled: async (report) => {
        if (!report.session) return
        lastRun = { stoppedBecause: report.stoppedBecause, steps: [...report.steps] }
        // 收尾边沿（#209）：中枢替本实例把这一轮推完时，总账仍由本实例的日志接缝发（落点不变）。
        noteRunOutcome(report.session)
      },
    }
  }

  /** 显式重试：选中的行里，失败（或显式点到的跳过）先复位成 pending 再推，别的行不动。 */
  function resetForRetry(session: BatchSession, selected: Set<string> | null, at: number): BatchSession {    let changed = false
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
    } else if (outcome.kind === 'done') {
      // #216：已装到目标版、只等重启——知识行也记「装完了」，最新版写成目标版，
      // 不让版本列再显示上一次的旧版。
      entries[rt.spec.key] = { lastCheckedAt: at, installed, installedVersion, latestVersion: outcome.version, canInstall: false, error: null }
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
    // #244：重启 pending 行不再是「一律不动」——检查结果是磁盘真相：若外部把版本改低，
    // done+restartRequired 的行必须按检查结论退回 ready/current，否则面板一直宣称「已安装完成」。
    // 飞行中（checking/installing）是驱动正在经手的行，检查不许碰；驱动半路起跑则跳过落盘（不踩驱动的账本）。
    let reconciled = session
    for (const [key, outcome] of outcomes) {
      const entry = batchEntryOf(reconciled, key)
      if (!entry) continue
      if (entry.phase === 'checking' || entry.phase === 'installing') continue
      let patch: Partial<Omit<BatchEntry, 'key' | 'requestId'>> | null = null
      if (outcome.kind === 'update') {
        if (entry.phase !== 'ready' || entry.targetVersion !== outcome.version || entry.error !== null || entry.restartRequired) {
          patch = { phase: 'ready', targetVersion: outcome.version, error: null, restartRequired: false }
        }
      } else if (outcome.kind === 'current') {
        if (entry.phase !== 'current' || entry.targetVersion !== null || entry.error !== null || entry.restartRequired) {
          patch = { phase: 'current', targetVersion: null, error: null, restartRequired: false }
        }
      } else if (outcome.kind === 'skipped') {
        if (entry.phase !== 'skipped' || entry.targetVersion !== outcome.version || entry.error !== null || entry.restartRequired) {
          patch = { phase: 'skipped', targetVersion: outcome.version, error: null, restartRequired: false }
        }
      } else if (outcome.kind === 'done') {
        // #216：检查发现「已经装好、只差重启」——会话从 ready/failed 收敛成 done+待重启，
        // 与驱动的结论同一口径（否则面板还停在「可更新」）。同版 done 保持不动（等重启收尾）。
        if (entry.phase !== 'done' || entry.restartRequired !== outcome.restartRequired || entry.targetVersion !== outcome.version || entry.error !== null) {
          patch = { phase: 'done', targetVersion: outcome.version, restartRequired: outcome.restartRequired, error: null }
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
        selfOrder: options.selfOrder,
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
      } else if (outcome.kind === 'done') {
        patch = { phase: 'done', targetVersion: outcome.version, restartRequired: outcome.restartRequired, error: null }
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
    if (driveActive) {
      const reply = await joinWhileBusy(selected)
      // 中枢在推时，第二次点击（可能点了别的行）必须并进中枢任务的行级选择里：
      // 否则这批只等第一次的行带完，第二次的意图就丢了（审查报告 B1 残余）。
      if (hubEnabled && hubScope && selected && hubBusyForScope(hubScope)) {
        const runningSeat = hubSeatFor(await readSession())
        if (runningSeat) await submitHubTask(hubScope, runningSeat, hubDeps, { selection: [...selected] })
      }
      return reply
    }
    if (selected && selected.size === 0) return await table(await readSession())
    driveActive = true
    // #217：开跑前先扫掉上一轮停下时留下的排队占位（真机 2026-10-19 08:47：续跑留下两条，
    // 队首任务已结束，公平门让之后每次点击都瞬间 update-busy；不扫就要等 10 分钟 TTL）。
    // 放在开跑前而不是停下时清：停下后占位还留着，面板才能显示「前方还有 N 个」并允许取消排队。
    await clearBatchQueueIntents()
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
          selfOrder: options.selfOrder,
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
      // #216：一次真推进开始也留一行（trigger=entry 表示用户点「全部更新/重试」推的；resumed
      // 专指「续跑」——继续上次未完成或自动续跑，entry 推旧账本仍算一次新推进，不算续跑）。
      // 没有这行，日志里只有入队与总账，中间隔着几小时没法看出这几步是哪一次点击推动的。
      noteRunStart(session, { trigger: 'entry', resumed: false })
      // 两段式（#70）：先把选中 keys 全查成 ready 进会话，再串行装（装阶段复用 ready，不重查）。
      session = await precheckSelectedToReady(session, selected)
      const seat = hubSeatFor(session)
      if (seat && hubScope) {
        // 中枢（ADR-0008）：装阶段交给进程级中枢——它拿执行席推进，本 fiber 结束/被替换也不断。
        // 行级选择（keys）必须一起冻结进任务：否则中枢会把「只点这一家」当整批推进（B1）。
        const outcome = await submitHubTask(hubScope, seat, hubDeps, {
          selection: selected ? [...selected] : null,
        })
        driven = await readSession()
        if (outcome === 'failed') throw batchFail('install-failed')
        // 收尾总账由中枢触发 onSettled 发（同上一条纪律）；这里不再重复发。
      } else {
        driven = await driveLocked(session, selected, Number.POSITIVE_INFINITY)
        // 收尾总账（#209 起同时记「没跑完就停」的那一行）：面板只渲染不重发。
        noteRunOutcome(driven)
      }
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
    // #217：续跑也是「重新开跑」，先把上一轮留下的排队占位扫掉再推进。
    await clearBatchQueueIntents()
    try {
      // #216：跨重启续跑也要有一行「这次真推进开始了」。
      noteRunStart(resumed, { trigger: 'resume', resumed: true })
      const seat = hubSeatFor(resumed)
      if (seat && hubScope) {
        // 中枢（ADR-0008）：续跑也交给中枢，避免「面板关掉后续跑断在 fiber 里」。
        const outcome = await submitHubTask(hubScope, seat, hubDeps)
        const hubDriven = await readSession()
        if (outcome === 'failed') throw batchFail('install-failed')
        return { ...(await table(hubDriven)), resumed: true }
      }
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
    // #217：用户取消也是一次「停下」，自己的排队占位一并撤掉。
    await clearBatchQueueIntents()
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
    // 中枢在手时同一份会话已由中枢任务推进（drain 再推就是双驱动）；让中枢的退避/接管负责。
    if (hubEnabled && hubScope && hubBusyForScope(hubScope)) return
    const disk = await readSession()
    if (disk.entries.length === 0 || isBatchFinished(disk)) return
    // #217：每轮开推前扫掉上一轮停下的排队占位（同一份理由见 installPhone）。
    await clearBatchQueueIntents()
    try {
      // #216：drain 每轮真推进也留一行（trigger=drain），把每个主动作与被推动的步串起来。
      noteRunStart(disk, { trigger: 'drain', resumed: true })
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

  /**
   * T3 孤儿接管：装载时扫盘上属于本属主的方案，把「同一会话、未收尾」的批次交给中枢接着推。
   *
   * 第一性：自更新换掉的只是「发起方这段 fiber」，盘上的方案 + 账本是它留下的全部事实。
   * 任一活着的集成方（新 fiber / 新进程 / 另一个挂载了同一属主批量入口的插件）读到同一份方案，
   * 就能用自己的宿主能力把剩下的步骤走完——不需要重开面板，也不需要重新点一次更新。
   *
   * 纪律：只动自己属主；会话必须对得上方案；已收尾不重装；有人在推就不抢（FIFO 由中枢管）。
   * 异常边界在 hub/adopt.ts：这里抛出的任何异常都只放弃这一个方案，绝不外抛（#253）。
   */
  async function adoptOrphanPlan(plan: HubPlan): Promise<void> {
    if (!hubEnabled || !hubScope || !hubPlanScope || !ownerPorts || scopeError) return
    if (plan.owner !== prefix) return
    if (hubBusyForScope(hubScope)) return
    const disk = await readSession()
    if (disk.entries.length === 0 || isBatchFinished(disk)) return
    if (disk.id !== plan.sessionId) return
    const resumed = resumeBatchSession(disk, now())
    if (resumed !== disk) await saveSession(resumed)
    // #217：上一任留下的排队占位先撤掉，这一任会重新逐家入队。
    await clearBatchQueueIntents()
    noteRunStart(resumed, { trigger: 'resume', resumed: true })
    const seat = hubSeatFor(resumed)
    if (!seat) return
    await submitHubTask(hubScope, seat, hubDeps)
  }

  /**
   * T4（#250）：只读全局进度。盘是唯一真相——方案 + 各家账本 + 检查知识 + 租约，
   * 投影成任意集成方都能渲染的快照；中枢在不在、面板开没开都不影响答案。
   */
  async function hubStatusPhone(): Promise<Record<string, unknown>> {
    if (!hubScope) return { ok: true, snapshot: emptyHubSnapshot(now()) }
    const snapshot = await readHubStatus({ homeDir: hubScope.homeDir, profileDir: hubScope.profileDir }, { at: now() })
    return { ok: true, snapshot }
  }

  async function prefsPhone(): Promise<Record<string, unknown>> {    const refuse = denied()
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
  // T4（#250）：只读全局进度电话。每套集成更新系统都登记——hub:false 的接入方同样要能答，
  // 快照从盘上聚合，中枢在不在、面板开没开都不影响答案。
  if (hubScope) {
    const hubStatusName = prefix + '.updateHubStatus'
    phoneNames.hubStatus = hubStatusName
    handlers[hubStatusName] = phone(hubStatusName, 'hub-status', () => hubStatusPhone())
  }
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

  // T3 孤儿接管（#249）：装载时扫一眼自己属主的未收尾方案，交给中枢接着推。
  // 异步、不阻塞装载；没有方案/已收尾/别的属主都不动；异常边界在 hub/adopt.ts（#253）。
  if (hubEnabled && hubScope) adoptOrphanHubTasks(hubScope, hubDeps, adoptOrphanPlan)

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

