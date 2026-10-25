// src/host/hub/registry.ts —— 进程级更新中枢：一个使用范围一个槽位、一条 FIFO 任务表、一个泵。
//
// 第一性（ADR-0008）：
//   1. 批量推进的寿命不该等于「发起它的那个插件 fiber」。所以把这个推进循环从 fiber 里搬出来，
//      挂在进程级注册表上（globalThis 的 Symbol 槽，同一进程里所有集成方共用），
//      再用盘上的租约与方案与其它进程/其它版本协商。
//   2. 一次只推一个（FIFO）：同一使用范围内的安装共用一把全局锁，并发即互踩；
//      排队由本模块的任务表表达，不靠调用方自己重试。
//   3. 每步都复用既有驱动器（core/batch/run.ts，maxSteps:1）并立即落盘；
//      本模块只负责「什么时候推、推完告诉谁」，不重写批量语义。
//   4. 协议换代（#254）：注册表的 Symbol 带协议版本，新一代用新槽；旧任务表留在旧 Symbol 上由旧泵排空，
//      旧一代还有未结算任务时本代只观察，排空或观察超时后按盘上方案/账本接管。
//
// 边界：本模块不认识具体插件，只认识 HubSeat（执行席）与盘上账本。
//   发起方返回/卸载不影响已提交任务的推进；等待者在 done/failed 时拿到终态，
//   让位（queued）与关停也会立刻回话——后台泵绝不让调用方悬挂，也绝不外抛异常（#253）。

import { isBatchFinished, type BatchSession } from '../../core/batch/model.js'
import { runBatch, type BatchRunStep, type BatchStoppedByBecause } from '../../core/batch/run.js'
import { decideHubCycleVerdict, type HubCycleVerdict } from '../../core/hub/drive-policy.js'
import {
  createHubLease,
  decideHubLease,
  HUB_LEASE_STALE_MS,
  isHubLeaseOwner,
  shouldHeartbeatHubLease,
  type HubLease,
} from '../../core/hub/lease-policy.js'
import { hubIoOf, safeReadLease, safeReleaseLease, safeWriteLease, safeWritePlan } from './boundary.js'
import { HUB_REGISTRY_KEY, legacyHubBusyForKey } from './handoff.js'
import { releaseHubLeaseSync } from './lease-store.js'
import { hubPathsForUpdate, type HubPaths } from './plan-store.js'
import {
  HUB_MAX_LEASE_FAULTS,
  HUB_PROTOCOL_VERSION,
  HUB_RETRY_INTERVAL_MS,
  type HubRuntimeDeps,
  type HubScope,
  type HubSeat,
  type HubSettledReport,
  type HubTaskOutcome,
} from './protocol.js'

/** 槽位里保留多少条已结算任务（只为去重/诊断，防内存无界增长）。 */
const MAX_SETTLED_TASKS = 8

interface HubTask {
  /** 去重键：属主 + 会话编号（同一份批次在同一进程里只挂一个任务）。 */
  id: string
  owner: string
  seat: HubSeat
  state: 'queued' | 'running' | 'settled'
  outcome: HubTaskOutcome | null
  /** 本任务已收集的步骤（给 lastRun / 日志；防无界：只留最近 64 步）。 */
  steps: BatchRunStep[]
  /** 连续无进展步数（跨让位累计；付给 drive-policy 防饿死）。 */
  idleSteps: number
  /** 租约端口连续抛未预期异常的次数（#253：坏 I/O 不许变成每秒空转，到上限给明确 failed）。 */
  leaseFaults: number
  /** 行级选择（keys 提交时冻结）：null = 整份会话；数组 = 只推这几行，别家的行原样保留。 */
  selection: readonly string[] | null
  /** 结局等待者：done/failed/queued 都会被唤醒（queued = 让位，稍后泵会自己重试）。 */
  waiters: Array<(outcome: HubTaskOutcome) => void>
}

interface HubSlot {
  /** 槽位键：`homeDir + NUL + profileDir`。 */
  key: string
  homeDir: string
  profileDir: string
  paths: HubPaths
  /** 本进程在这个使用范围里的驾驶者身份（进程级稳定，不随任务变）。 */
  driverId: string
  tasks: HubTask[]
  pumping: boolean
  /** 槽位已关停（宿主关停/协议换代）：泵不再起新轮、退避定时器不再续命。 */
  closed: boolean
  /** 换代观察起点（#254）：第一次看见旧一代还有未结算任务的时间；null = 当前没在观察。 */
  legacyObservedAt: number | null
  retryTimer: unknown
  lease: HubLease | null
  deps: HubRuntimeDeps
}

interface HubRegistryState {
  version: typeof HUB_PROTOCOL_VERSION
  slots: Map<string, HubSlot>
}

function registry(): HubRegistryState {
  const holder = globalThis as unknown as Record<PropertyKey, unknown>
  const existing = holder[HUB_REGISTRY_KEY] as HubRegistryState | undefined
  if (existing && typeof existing === 'object' && existing.version === HUB_PROTOCOL_VERSION && existing.slots instanceof Map) {
    return existing
  }
  // 旧一代的任务表在别的 Symbol 上（handoff.ts 的 LEGACY_HUB_REGISTRIES）：本代不读、不写、不覆盖——
  // 旧任务与旧等待者只归旧泵（#254）。盘上方案/账本原样保留，排空后由本代接管。
  const fresh: HubRegistryState = { version: HUB_PROTOCOL_VERSION, slots: new Map<string, HubSlot>() }
  holder[HUB_REGISTRY_KEY] = fresh
  return fresh
}

function normalizeDriverId(raw: string): string {
  const cleaned = String(raw ?? '').replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 128)
  return cleaned || 'dsh-hub'
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM：进程存在但没权限探测——只说明「没死」；接管仍看它的心跳是否陈旧。
    return (error as { code?: string } | null)?.code === 'EPERM'
  }
}

function isAlive(deps: HubRuntimeDeps, pid: number): boolean {
  return typeof deps.isProcessAlive === 'function' ? deps.isProcessAlive(pid) : defaultIsProcessAlive(pid)
}

function slotKeyOf(scope: HubScope): string {
  return scope.homeDir + '\u0000' + scope.profileDir
}

function slotFor(scope: HubScope, deps: HubRuntimeDeps): HubSlot | null {
  const paths = hubPathsForUpdate(scope.homeDir, scope.profileDir)
  if (!paths) return null
  const key = slotKeyOf(scope)
  const state = registry()
  const existing = state.slots.get(key)
  if (existing && !existing.closed) {
    // 同一进程里后到的集成方复用同一驾驶者身份与任务表（换 deps 只为测试时钟/定时器能接手）。
    existing.deps = deps
    return existing
  }
  // 已关停的槽不再复用：新实例拿新任务表（旧泵可能还在收手，绝不能与它共用表）。
  if (existing) state.slots.delete(key)
  const slot: HubSlot = {
    key,
    homeDir: scope.homeDir,
    profileDir: scope.profileDir,
    paths,
    driverId: normalizeDriverId('dsh-hub:' + String(deps.pid) + ':' + deps.randomId()),
    tasks: [],
    pumping: false,
    closed: false,
    legacyObservedAt: null,
    retryTimer: null,
    lease: null,
    deps,
  }
  state.slots.set(key, slot)
  ensureProcessExitHook()
  return slot
}

function taskIdOf(seat: HubSeat): string {
  return seat.owner + ':' + seat.plan.sessionId
}

function registerTaskWaiter(task: HubTask): Promise<HubTaskOutcome> {
  return new Promise<HubTaskOutcome>((resolve) => {
    task.waiters.push(resolve)
  })
}

function waitForTask(task: HubTask): Promise<HubTaskOutcome> {
  if (task.state === 'settled' && task.outcome) return Promise.resolve(task.outcome)
  return registerTaskWaiter(task)
}

function resolveWaiters(task: HubTask, outcome: HubTaskOutcome): void {
  for (const waiter of task.waiters.splice(0)) waiter(outcome)
}

/**
 * 让位终态：任务这次不推了，等等待者一个诚实的 'queued'（不是 failed，也不是悬挂）。
 * 关停与「槽位已关但提交晚到」两种竞态都用它——只认第一次，重复调用不重复回话。
 */
function settleTaskAsQueued(task: HubTask): void {
  if (task.state === 'settled') return
  task.state = 'settled'
  task.outcome = 'queued'
  resolveWaiters(task, 'queued')
}

/**
 * 让位重排队：任务回队列、等待者先拿到 'queued'、退避后自己再来。
 * 关停已经给过终态时保持终态（不复活），并立刻停手。
 */
function requeueTask(slot: HubSlot, task: HubTask): RunVerdict {
  if (task.state === 'settled') return 'stop'
  task.state = 'queued'
  resolveWaiters(task, 'queued')
  scheduleRetry(slot)
  return 'stop'
}

/** 任务明确 failed 的唯一写法（异常边界、租约故障上限、驱动抛错三处共用）。 */
async function failTask(slot: HubSlot, task: HubTask): Promise<void> {
  await settleTask(slot, task, {
    outcome: 'failed',
    stoppedBecause: 'error',
    steps: task.steps.slice(),
    session: null,
  })
}

/** 停掉这个槽的退避定时器（关停/退出/测试重启三处共用；定时器假件抛错也不外泄）。 */
function stopRetryTimer(slot: HubSlot): void {
  if (slot.retryTimer === null) return
  try {
    slot.deps.timers.clearTimeout(slot.retryTimer)
  } catch {
    // 停表是清理旁路：假件/环境异常不该让清理本身失败。
  }
  slot.retryTimer = null
}

function retryDelayOf(deps: HubRuntimeDeps): number {
  const raw = deps.retryMs
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : HUB_RETRY_INTERVAL_MS
}

function scheduleRetry(slot: HubSlot): void {
  if (slot.closed || slot.retryTimer !== null) return
  try {
    slot.retryTimer = slot.deps.timers.setTimeout(() => {
      slot.retryTimer = null
      try {
        if (slot.closed) return
        // 退避到点时泵还没收手：等它收手后再补一次（不丢这次重试，也不并发双泵）。
        if (slot.pumping) {
          scheduleRetry(slot)
          return
        }
        kickPump(slot)
      } catch {
        // 退避定时器直接跑在事件循环里：这里的任何异常都会变成宿主级未捕获异常（致命），
        // 所以连重排定时器这一步也要收住（#253）。
      }
    }, retryDelayOf(slot.deps))
  } catch {
    // 定时器本身起不来（环境限制/假件抛错）：这次重试放弃，等待者们已经拿到 queued，不会悬挂。
    slot.retryTimer = null
  }
}

function kickPump(slot: HubSlot): void {
  if (slot.closed || slot.pumping || slot.retryTimer !== null) return
  slot.pumping = true
  // 两个回调都写：pumpSlot 已被泵级兜底包住，这里再兜一层——它的 rejection 绝不能被漏掉
  // （裸 .finally() 会把 rejection 原样透给一个没人等的 promise）。
  void pumpSlot(slot).then(
    () => {
      slot.pumping = false
    },
    () => {
      slot.pumping = false
    },
  )
}

/**
 * 提交一个批次的执行席。返回三种诚实结局：
 * - 空闲：一直等到本次推完（done/failed）才返回；
 * - 已有任务在推（FIFO）：立刻回 queued，让调用方先渲染现状，中枢随后自己推；
 * - 同一份批次重复提交：并入现有任务，等它给出结局（忙时入队语义不丢）。
 */
export async function submitHubTask(
  scope: HubScope,
  seat: HubSeat,
  deps: HubRuntimeDeps,
  options: { selection?: readonly string[] | null } = {},
): Promise<HubTaskOutcome> {
  try {
    return await submitHubTaskToSlot(scope, seat, deps, options)
  } catch {
    // 提交是电话/孤儿接管的一部分，也是 apply() 之外的后台入口：异常降级成 failed，
    // 绝不让调用方（更不让宿主事件循环）拿到一个未处理 rejection。
    return 'failed'
  }
}

async function submitHubTaskToSlot(
  scope: HubScope,
  seat: HubSeat,
  deps: HubRuntimeDeps,
  options: { selection?: readonly string[] | null },
): Promise<HubTaskOutcome> {
  const slot = slotFor(scope, deps)
  if (!slot) return 'failed'
  // 方案先落盘（best-effort）：写不进去只影响「别人接手」，不影响本进程推进。
  // 但必须等这一笔 I/O 有结果：进程/插件在提交后立刻消失时，下一次装载只有盘上方案可依，
  // 不能把「方案还没写完」当成「没有方案」。
  await safeWritePlan(hubIoOf(deps), slot.paths, seat.plan)
  const id = taskIdOf(seat)
  const existing = slot.tasks.find((task) => task.state !== 'settled' && task.id === id)
  if (existing) {
    // 行级选择取并集：同一批次排队/推进中又被点了别的行时，第二次点击的意图不能丢。
    existing.selection = mergeSelection(existing.selection, options.selection ?? null)
    // T3 孤儿接管：排着队但还没人推的任务，换上新来的席位（新 fiber 的盘/宿主能力）。
    // 正在推的不换——运行中的闭包正在用旧席位，换掉会让同一步走两遍。
    if (existing.state === 'queued') {
      existing.seat = seat
      kickPump(slot)
      // 槽位恰好在提交与起泵之间被关停：给等待者让位终态，别悬挂。
      if (slot.closed) settleTaskAsQueued(existing)
      // 已入队未开跑：等这一轮跑完再回话，调用方拿到的才是可渲染的终态。
      return await waitForTask(existing)
    }
    // 正在推：不阻塞调用方（忙时提交只回 queued），否则会与驱动里正在等待的宿主调用互相咬死。
    return 'queued'
  }
  const busyBefore = slot.tasks.some((task) => task.state !== 'settled')
  const task: HubTask = {
    id,
    owner: seat.owner,
    seat,
    state: 'queued',
    outcome: null,
    steps: [],
    idleSteps: 0,
    leaseFaults: 0,
    selection: options.selection ?? null,
    waiters: [],
  }
  slot.tasks.push(task)
  if (busyBefore) {
    // 忙时只回 queued，不登记等待者：这个结局已经定了，留一个没人等兑现的 promise 只会误导下一个读者。
    kickPump(slot)
    if (slot.closed) settleTaskAsQueued(task)
    return 'queued'
  }
  // 先登记等待者、再起泵（#254）：换代观察闸是同步路径，泵可能在同一 tick 里就把任务让位回队列；
  // 晚一步登记的等待者会永远等不到唤醒（让位只结算当时已有的等待者）。
  const outcome = registerTaskWaiter(task)
  kickPump(slot)
  if (slot.closed) settleTaskAsQueued(task)
  return await outcome
}

async function pumpSlot(slot: HubSlot): Promise<void> {
  try {
    while (!slot.closed) {
      const task = slot.tasks.find((one) => one.state === 'queued')
      if (!task) break
      const verdict = await runTaskGuarded(slot, task)
      if (verdict === 'stop') break
    }
  } catch {
    // 泵级兜底：任务边界已把每个任务收住，这里不该出现异常；真出现了也绝不外抛——
    // DSH 把 apply() 之外的未处理 rejection 当致命错误，泵不能成为进程退出的入口。
  } finally {
    // 让位/收尾/关停都要把驾驶位还回去：不还，下一次接管就会误以为有人活着，等到租约过期。
    await releaseIfOwner(slot)
  }
}

type RunVerdict = 'next' | 'stop'

/**
 * 任务边界（#253）：一次任务里的任何未预期异常（席位调用、会话读写、租约探测……）
 * 都收在这里 → 该任务明确 failed、等待者拿到终态、泵继续下一个。
 */
async function runTaskGuarded(slot: HubSlot, task: HubTask): Promise<RunVerdict> {
  try {
    return await runTask(slot, task)
  } catch {
    await failTask(slot, task)
    return 'next'
  }
}

async function runTask(slot: HubSlot, task: HubTask): Promise<RunVerdict> {
  // 换代只观察（#254）：旧一代还有未结算任务时，本代先不驱动同一步——旧任务与旧等待者只认旧泵，
  // 贸然接管会把同一步走两遍。让位退避等它排空；观察窗口到 HUB_LEASE_STALE_MS 还没排空，
  // 说明旧一代可能已死/假死，此后不再只观察，交给租约仲裁（旧租约新鲜时 ensureLease 仍会让位）。
  if (legacyHubBusyForKey(slot.key)) {
    if (slot.legacyObservedAt === null) slot.legacyObservedAt = slot.deps.now()
    if (slot.deps.now() - slot.legacyObservedAt < HUB_LEASE_STALE_MS) return requeueTask(slot, task)
  } else {
    slot.legacyObservedAt = null
  }
  const attempt = await ensureLease(slot, task.owner)
  if (attempt.kind === 'fault') {
    // 租约端口抛了未预期异常：这不是「等别家让位」，坏 I/O 等不来。记一次故障后让位；
    // 连续到上限就给明确 failed（绝不每秒重试到进程结束）。
    task.leaseFaults += 1
    if (task.leaseFaults >= HUB_MAX_LEASE_FAULTS) {
      await failTask(slot, task)
      return 'next'
    }
    return requeueTask(slot, task)
  }
  if (attempt.kind === 'wait') {
    // 拿不到驾驶位：如实告诉等待者「已排队」，退避后再推（不是失败）。
    return requeueTask(slot, task)
  }
  // 非故障的一次尝试（拿到或正常等待）说明「连续故障」断了，计数归零。
  task.leaseFaults = 0
  const lease = attempt.lease
  if (slot.closed) {
    // 提交/拿租约的同一瞬间槽关了：不再驱动，给等待者让位终态。
    settleTaskAsQueued(task)
    return 'stop'
  }
  task.state = 'running'
  task.seat.enterDrive?.()
  try {
    const session = await task.seat.readSession()
    if (session.entries.length > 0 && isBatchFinished(session)) {
      await settleTask(slot, task, { outcome: 'done', stoppedBecause: 'finished', steps: [], session })
      return 'next'
    }
    // 旧一代排空/观察超时后真正由本代开推：补做「接手续跑」该做的落盘（重读最新账本再 resume、
    // 清上一任排队占位、记启动日志）。旧一代忙时这只席位是只读装的，不补就会带着中断相位开推、
    // 日志也缺续跑口径（#254 审查）。
    await task.seat.takeOver?.()
    const result = await driveTask(slot, task)
    // 让位：账本已逐步落盘，任务回队列等退避重试；等待者先拿到「已排队」。
    if (result.kind === 'yield') return requeueTask(slot, task)
    await settleTask(slot, task, result.report)
    return 'next'
  } catch {
    await failTask(slot, task)
    return 'next'
  } finally {
    try {
      task.seat.exitDrive?.()
    } catch {
      // 复位「忙」标志是旁路：它抛错不该改写已经给出的结局。
    }
  }
}

type DriveTaskResult = { kind: 'settled'; report: HubSettledReport } | { kind: 'yield' }

/**
 * 一轮推进：每步复用 runBatch(maxSteps:1)，按 drive-policy 决定继续/让位/收尾/报错。
 *
 * 与旧 fiber 内驱动的三条差异（对抗审查 B1/B2/B3 的结论）：
 *   1. 行级选择：只把选中行做成视图交给 runBatch，其余行按盘上现状原样保留；
 *   2. 每步重读账本再合并落盘：并发写入者（用户点重试/入队、另一个进程）不会被这一轮的陈旧快照覆盖；
 *   3. 队列让位（queued）不计入「无进展」看门狗——排队不是故障，等就是。
 */
async function driveTask(slot: HubSlot, task: HubTask): Promise<DriveTaskResult> {
  let session = await task.seat.readSession()
  let cycleSteps = 0
  let lastStoppedBecause: BatchStoppedByBecause = 'empty'
  while (true) {
    // 槽位已关停（宿主关停/协议换代）：这一步的成果已在盘上，剩下的留给下一个实例，别再推。
    if (slot.closed) return { kind: 'yield' }
    // 跨进程也算数：每一步前复核一次驾驶位（文件是最终裁判），丢了就让位——
    // 避免两个进程都以为自己拿到了早已被接管的那一代租约、把同一步走两遍。
    if (!(await stillOwnsLease(slot))) return { kind: 'yield' }
    const before = progressSignature(session)
    // 这一步的起草底稿：patch 只对「底稿里真变过的行」有发言权，其余行以盘上最新为准。
    const baseline = stepView(session, task.selection)
    const result = await runBatch(
      baseline,
      {
        check: (key: string) => task.seat.check(key),
        install: (key: string, requestId: string, version: string) => task.seat.install(key, requestId, version),
        save: async (next: BatchSession) => {
          // 先读回盘上最新（可能已被并发写入者改过），只把这一步真变过的行合并进去。
          const fresh = await task.seat.readSession()
          session = mergeBatchSessions(fresh, next, baseline)
          await task.seat.saveSession(session)
        },
        now: () => slot.deps.now(),
        ...(task.seat.logFor ? { logFor: task.seat.logFor } : {}),
        indexOf: (key: string) => task.seat.indexOf(key),
      },
      { maxSteps: 1 },
    )
    // 以盘为准：runBatch 返回的是视图，合并后的完整会话语义在 save 里已经落盘。
    session = await task.seat.readSession()
    // 收尾口径跟着「这一任务的范围」走：行级选择的批次只关心选中的行；整批才关心全表。
    const scoped = task.selection ? stepView(session, task.selection) : session
    const scopeFinished = scoped.entries.length > 0 && isBatchFinished(scoped)
    // 视图里的「收尾 / 失败即停」不算数：并发写者可能刚把某一行改回待装（审查报告 B3）。
    // 以合并后的盘上会话为准——真收尾才保留原判定，否则按预算用完继续推。
    const mergedStopped = (result.stoppedBecause === 'finished' || result.stoppedBecause === 'stopped-after-failure') && !scopeFinished ? 'max-steps' : result.stoppedBecause
    lastStoppedBecause = mergedStopped
    for (const step of result.steps) task.steps.push(step)
    if (task.steps.length > 64) task.steps.splice(0, task.steps.length - 64)
    cycleSteps += 1
    // 排队让位不是「无进展」：把它算进看门狗会让「队列被别家占十秒」被误判成故障。
    if (lastStoppedBecause !== 'queued') {
      task.idleSteps = progressSignature(session) === before ? task.idleSteps + 1 : 0
    }
    const beat = await heartbeat(slot)
    // 心跳时发现已经被换代接管：这一步的成果已经在盘上，留给新驾驶位合并；
    // 自己退回队列走退避重试，不能拿旧代次继续判收尾/写盘。
    if (beat === 'lost') return { kind: 'yield' }
    const verdict: HubCycleVerdict = decideHubCycleVerdict({
      sessionFinished: scopeFinished,
      stoppedBecause: lastStoppedBecause,
      stepsTaken: cycleSteps,
      consecutiveNoProgress: task.idleSteps,
    })
    if (verdict === 'continue') continue
    if (verdict === 'yield') return { kind: 'yield' }
    if (verdict === 'fail') {
      return {
        kind: 'settled',
        report: {
          outcome: 'failed',
          stoppedBecause: lastStoppedBecause === 'finished' || lastStoppedBecause === 'stopped-after-failure' ? lastStoppedBecause : 'error',
          steps: task.steps.slice(),
          session,
        },
      }
    }
    return { kind: 'settled', report: { outcome: 'done', stoppedBecause: lastStoppedBecause, steps: task.steps.slice(), session } }
  }
}

/** 行级选择视图：selection 为 null 就是整份会话；否则只保留选中的行（顺序与 entries 同步收窄）。 */
function stepView(session: BatchSession, selection: readonly string[] | null): BatchSession {
  if (!selection) return session
  const selected = new Set(selection)
  const order = session.order.filter((key) => selected.has(key))
  if (order.length === session.order.length) return session
  // entries 必须一起收窄：否则驱动器会把「没选中的失败行」当成这一轮的失败来收尾（审查报告 B1 残余）。
  return { ...session, order, entries: session.entries.filter((entry) => selected.has(entry.key)) }
}

/** 两次提交的选择合并：任一为 null（整批）就是整批；否则取并集。 */
function mergeSelection(current: readonly string[] | null, incoming: readonly string[] | null): readonly string[] | null {
  if (!current || !incoming) return null
  const merged = new Set(current)
  for (const key of incoming) merged.add(key)
  return [...merged]
}

/**
 * 把这一步的结果合并进盘上最新会话：只覆盖「相对起草底稿真变过」的行，其余行与顺序原样保留。
 * 这就是旧路径 `mergeInto(liveSession)` 的等价物（#25 忙时入队语义）；
 * 关键在 baseline：驱动器返回的是整份视图快照，没变过的行也在里面，不能拿它覆盖盘上的新值。
 */
function mergeBatchSessions(base: BatchSession, patch: BatchSession, baseline: BatchSession): BatchSession {
  if (patch.id !== base.id || patch.entries.length === 0) return base
  const baselineByKey = new Map(baseline.entries.map((entry) => [entry.key, entry]))
  const patched = new Map(patch.entries.map((entry) => [entry.key, entry]))
  const changedKeys = new Set<string>()
  for (const [key, entry] of patched) {
    if (baselineByKey.get(key) !== entry) changedKeys.add(key)
  }
  if (changedKeys.size === 0) return base
  let changed = false
  const entries = base.entries.map((entry) => {
    if (!changedKeys.has(entry.key)) return entry
    const next = patched.get(entry.key)
    if (!next || next === entry) return entry
    changed = true
    return next
  })
  if (!changed) return base
  return { ...base, entries, updatedAt: Math.max(base.updatedAt, patch.updatedAt) }
}

async function settleTask(slot: HubSlot, task: HubTask, report: HubSettledReport): Promise<void> {
  // 关停/异常边界可能已经给过终态：只认第一次，等待者不会重复收，也不会被改写成另一个结局。
  if (task.state === 'settled') return
  task.state = 'settled'
  task.outcome = report.outcome
  try {
    await task.seat.onSettled?.(report)
  } catch {
    // 收尾旁路失败不改变结局（如实报告比改写结局重要）。
  }
  resolveWaiters(task, report.outcome)
  pruneSettledTasks(slot)
}

function pruneSettledTasks(slot: HubSlot): void {
  const settled = slot.tasks.filter((task) => task.state === 'settled')
  if (settled.length <= MAX_SETTLED_TASKS) return
  const drop = new Set(settled.slice(0, settled.length - MAX_SETTLED_TASKS))
  slot.tasks = slot.tasks.filter((task) => !drop.has(task))
}

/** 一次驾驶位尝试的三种结局：拿到了 / 正常等待别家 / 端口抛了未预期异常。 */
type LeaseAttempt =
  | { kind: 'owned'; lease: HubLease }
  | { kind: 'wait' }
  | { kind: 'fault' }

/**
 * 拿/续/接管驾驶位。三种结局都显式：拿不到是等（退避后重试），端口异常是 fault
 * （由任务边界计数，到上限判 failed——坏 I/O 不能靠等自愈）。
 * 写不进去仍退回「本进程单飞」（ADR-0008：租约一切 I/O best-effort，绝不挡安装）。
 */
async function ensureLease(slot: HubSlot, pluginId: string): Promise<LeaseAttempt> {
  const deps = slot.deps
  const io = hubIoOf(deps)
  const now = deps.now()
  const read = await safeReadLease(io, slot.paths)
  if (read.fault) return { kind: 'fault' }
  const current = read.value
  const processAlive = current && current.driverId !== slot.driverId ? isAlive(deps, current.pid) : null
  const decision = decideHubLease({ current, driverId: slot.driverId, now, processAlive })
  if (decision.kind === 'wait') return { kind: 'wait' }
  const lease = createHubLease({ driverId: slot.driverId, pluginId, pid: deps.pid, now, generation: decision.generation })
  const wrote = await safeWriteLease(io, slot.paths, lease)
  // 端口**抛出**未预期异常：算 fault（让位/到上限 failed），不拿「写失败也能单飞」的旧口径吞掉——
  // 那条口径说的是端口**返回 false**（正常的没写进去），不是故障。
  if (wrote.fault) return { kind: 'fault' }
  if (wrote.value) {
    // 写完再读回确认代次：同机多进程同抢时，以最后一次落盘为准（写不出就退回单进程内推进）。
    const confirmed = await safeReadLease(io, slot.paths)
    if (confirmed.fault) return { kind: 'fault' }
    if (!isHubLeaseOwner(confirmed.value, slot.driverId, lease.generation)) return { kind: 'wait' }
  }
  slot.lease = lease
  return { kind: 'owned', lease }
}

/**
 * 每步前的驾驶位复核：文件是最终裁判。
 * - 没有租约（单飞模式）或盘上没有租约：说明这台机器上写不出租约（ensureLease 已确认过归属），
 *   退回单进程内推进；
 * - 读**异常**：拿不到事实就不盲推（否则一整轮 2000 步都可能在坏 I/O 上双驱动）——
 *   这一步让位，下一次 ensureLease 会把这次故障计数，到上限给明确 failed；
 * - 读到别人的代次：让位（yield），由退避重试重新排队，绝不和对方抢同一步。
 */
async function stillOwnsLease(slot: HubSlot): Promise<boolean> {
  const lease = slot.lease
  if (!lease) return true
  const read = await safeReadLease(hubIoOf(slot.deps), slot.paths)
  if (read.fault) return false
  if (!read.value) return true
  return isHubLeaseOwner(read.value, slot.driverId, lease.generation)
}

/**
 * 续心跳。返回 'lost' 表示盘上已经换成别人的代次——此时一个字都不写（lease-store 的口径：
 * 不是我的代次就不动），并清掉本地租约，让调用方让位重排队。
 * 读异常时这一轮不写（读不到事实就别拿旧代次覆盖盘上可能更新的租约）。
 */
async function heartbeat(slot: HubSlot): Promise<'ok' | 'lost'> {
  const lease = slot.lease
  if (!lease) return 'ok'
  const now = slot.deps.now()
  if (!shouldHeartbeatHubLease(lease, now)) return 'ok'
  const io = hubIoOf(slot.deps)
  const read = await safeReadLease(io, slot.paths)
  if (read.fault) {
    // 读不到事实就不硬写旧代次（防「租约缺失时心跳复活旧代次」），并让位：
    // 下一次 ensureLease 会把故障计数，绝不带着坏 I/O 继续盲推。
    slot.lease = null
    return 'lost'
  }
  const current = read.value
  if (current && !isHubLeaseOwner(current, slot.driverId, lease.generation)) {
    slot.lease = null
    return 'lost'
  }
  const next: HubLease = { ...lease, heartbeatAt: now }
  slot.lease = next
  await safeWriteLease(io, slot.paths, next)
  return 'ok'
}

/** 归还驾驶位：只认自己这一代（releaseHubLease 内部再核对）；异常吞在边界里。 */
async function releaseIfOwner(slot: HubSlot): Promise<void> {
  const lease = slot.lease
  if (!lease) return
  slot.lease = null
  await safeReleaseLease(hubIoOf(slot.deps), slot.paths, slot.driverId, lease.generation)
}

/** 进展指纹：只看会改变判定的事实（键/相位/目标版/待重启/错误）。 */
function progressSignature(session: BatchSession): string {
  const rows = session.entries
    .map((entry) => [entry.key, entry.phase, entry.targetVersion ?? '', entry.restartRequired ? '1' : '0', entry.error ?? ''].join('~'))
    .join(',')
  return session.id + '|' + rows
}

/** 这个使用范围里旧一代中枢还有没有未结算任务（#254：只观察、不接管、不修改；探针在 handoff.ts）。 */
export function legacyHubBusyForScope(scope: HubScope): boolean {
  return legacyHubBusyForKey(slotKeyOf(scope))
}

/** 本代这个使用范围里有没有未收尾的中枢任务（drain 等旁路据此让位，避免双驱动）。 */
export function ownHubBusyForScope(scope: HubScope): boolean {
  const slot = registry().slots.get(slotKeyOf(scope))
  return Boolean(slot && slot.tasks.some((task) => task.state !== 'settled'))
}

/**
 * 这个使用范围里有没有未收尾的中枢任务：本代，或上一代（#254）。
 * 上一代的任务本代只观察不抢；drain 等旁路也一起让位，等旧泵排空。
 */
export function hubBusyForScope(scope: HubScope): boolean {
  return ownHubBusyForScope(scope) || legacyHubBusyForScope(scope)
}

/**
 * 关停一处中枢槽（宿主关停、协议换代、测试模拟重启）：停掉所有退避定时器、
 * 给未结束任务的等待者一个诚实终态（queued＝这次没推完，盘上进度与方案留给下一个实例）、
 * 归还本代租约。幂等；关停后新实例用新槽，按盘上方案与账本重新接管。
 *
 * 为什么不是 createMultiHostUpdate(...).dispose()：dispose 表示「这个插件的 fiber 没了」，
 * 而中枢的全部意义就是在 fiber 没了之后继续推进（自更新场景）——所以关停必须是显式的宿主级动作。
 */
export async function shutdownHubScope(scope: HubScope): Promise<void> {
  const state = registry()
  const key = slotKeyOf(scope)
  const slot = state.slots.get(key)
  if (!slot) return
  // 先摘槽：紧接着装载的新实例拿新槽，不会和正在收手的旧泵共用任务表。
  state.slots.delete(key)
  closeHubSlot(slot)
  await releaseIfOwner(slot)
}

/** 关停一个槽的公共清理：不再起新轮、不再重试、未结算任务给 queued 终态。 */
function closeHubSlot(slot: HubSlot): void {
  slot.closed = true
  stopRetryTimer(slot)
  for (const task of slot.tasks) settleTaskAsQueued(task)
}

let processExitHookInstalled = false

/**
 * 进程级退出钩子（只装一次）：宿主关停时同步停表、同步归还本代租约。
 * 下一次启动看到盘上没有租约就直接接管，不用先等 20 秒陈旧窗口 —— 这是「重启后续跑」
 * 在优雅退出场景下也能立刻生效的关键。钩子本身绝不抛（exit 事件里抛出只会污染退出诊断）。
 */
function ensureProcessExitHook(): void {
  if (processExitHookInstalled) return
  processExitHookInstalled = true
  if (typeof process === 'undefined' || typeof process.once !== 'function') return
  process.once('exit', releaseHubLeasesOnExit)
}

/**
 * 退出钩子的本体（导出给测试与诊断直接调）：同步停表、结算未结束任务、同步归还本代租约，
 * 最后把槽位摘掉（之后同进程再装载会拿新槽，不会捡到一张已关停的旧表）。
 */
export function releaseHubLeasesOnExit(): void {
  const state = registry()
  for (const slot of state.slots.values()) {
    closeHubSlot(slot)
    const lease = slot.lease
    if (!lease) continue
    slot.lease = null
    try {
      releaseHubLeaseSync(slot.paths, slot.driverId, lease.generation)
    } catch {
      // 退出阶段尽力而为：删不掉只多留一份过期租约，下一次启动按死进程/陈旧窗口接管。
    }
  }
  state.slots.clear()
}

/** 测试用：清空注册表并停掉所有退避定时器（等价于「进程重启」；租约与方案留在盘上）。 */
export function __resetHubRegistryForTests(): void {
  const state = registry()
  for (const slot of state.slots.values()) {
    slot.closed = true
    stopRetryTimer(slot)
  }
  state.slots.clear()
}

/** 测试用：这个使用范围当前有没有活着的中枢槽（诊断任务表是否泄漏）。 */
export function hubSlotCountForTests(): number {
  return registry().slots.size
}







