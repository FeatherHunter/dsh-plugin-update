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
//
// 边界：本模块不认识具体插件，只认识 HubSeat（执行席）与盘上账本。
//   发起方返回/卸载不影响已提交任务的推进；任务只在 done/failed 时通知等待者。

import { isBatchFinished, type BatchSession } from '../../core/batch/model.js'
import { runBatch, type BatchRunStep, type BatchStoppedByBecause } from '../../core/batch/run.js'
import { decideHubCycleVerdict, type HubCycleVerdict } from '../../core/hub/drive-policy.js'
import {
  createHubLease,
  decideHubLease,
  isHubLeaseOwner,
  shouldHeartbeatHubLease,
  type HubLease,
} from '../../core/hub/lease-policy.js'
import { readHubLease, releaseHubLease, writeHubLease } from './lease-store.js'
import { hubPathsForUpdate, writeHubPlan, type HubPaths } from './plan-store.js'
import {
  HUB_PROTOCOL_VERSION,
  HUB_RETRY_INTERVAL_MS,
  type HubRuntimeDeps,
  type HubScope,
  type HubSeat,
  type HubSettledReport,
  type HubTaskOutcome,
} from './protocol.js'

/** 进程级注册表的 Symbol 槽：同一进程里不同包副本共用一份（协议版本随状态一起存）。 */
const REGISTRY_KEY = Symbol.for('dsh-plugin-update:update-hub:registry')

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
  const existing = holder[REGISTRY_KEY] as HubRegistryState | undefined
  if (existing && typeof existing === 'object' && existing.version === HUB_PROTOCOL_VERSION && existing.slots instanceof Map) {
    return existing
  }
  // 协议换代：旧任务表不再被读（它们的推进语义已不可保证）；盘上方案/账本原样保留，等新代码认领。
  const fresh: HubRegistryState = { version: HUB_PROTOCOL_VERSION, slots: new Map<string, HubSlot>() }
  holder[REGISTRY_KEY] = fresh
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
  if (existing) {
    // 同一进程里后到的集成方复用同一驾驶者身份与任务表（换 deps 只为测试时钟/定时器能接手）。
    existing.deps = deps
    return existing
  }
  const slot: HubSlot = {
    key,
    homeDir: scope.homeDir,
    profileDir: scope.profileDir,
    paths,
    driverId: normalizeDriverId('dsh-hub:' + String(deps.pid) + ':' + deps.randomId()),
    tasks: [],
    pumping: false,
    retryTimer: null,
    lease: null,
    deps,
  }
  state.slots.set(key, slot)
  return slot
}

function taskIdOf(seat: HubSeat): string {
  return seat.owner + ':' + seat.plan.sessionId
}

function waitForTask(task: HubTask): Promise<HubTaskOutcome> {
  if (task.state === 'settled' && task.outcome) return Promise.resolve(task.outcome)
  return new Promise<HubTaskOutcome>((resolve) => {
    task.waiters.push(resolve)
  })
}

function resolveWaiters(task: HubTask, outcome: HubTaskOutcome): void {
  for (const waiter of task.waiters.splice(0)) waiter(outcome)
}

function retryDelayOf(deps: HubRuntimeDeps): number {
  const raw = deps.retryMs
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : HUB_RETRY_INTERVAL_MS
}

function scheduleRetry(slot: HubSlot): void {
  if (slot.retryTimer !== null) return
  slot.retryTimer = slot.deps.timers.setTimeout(() => {
    slot.retryTimer = null
    // 退避到点时泵还没收手：等它收手后再补一次（不丢这次重试，也不并发双泵）。
    if (slot.pumping) {
      scheduleRetry(slot)
      return
    }
    kickPump(slot)
  }, retryDelayOf(slot.deps))
}

function kickPump(slot: HubSlot): void {
  if (slot.pumping || slot.retryTimer !== null) return
  slot.pumping = true
  void pumpSlot(slot).finally(() => {
    slot.pumping = false
  })
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
  const slot = slotFor(scope, deps)
  if (!slot) return 'failed'
  // 方案先落盘（best-effort）：写不进去只影响「别人接手」，不影响本进程推进。
  // 但必须等这一笔 I/O 有结果：进程/插件在提交后立刻消失时，下一次装载只有盘上方案可依，
  // 不能把「方案还没写完」当成「没有方案」。
  await writeHubPlan(slot.paths, seat.plan)
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
    selection: options.selection ?? null,
    waiters: [],
  }
  slot.tasks.push(task)
  kickPump(slot)
  if (busyBefore) return 'queued'
  return await waitForTask(task)
}

async function pumpSlot(slot: HubSlot): Promise<void> {
  try {
    while (true) {
      const task = slot.tasks.find((one) => one.state === 'queued')
      if (!task) break
      const verdict = await runTask(slot, task)
      if (verdict === 'stop') break
    }
  } finally {
    // 让位/收尾都要把驾驶位还回去：不还，下一次接管就会误以为有人活着，等到租约过期。
    await releaseIfOwner(slot)
  }
}

type RunVerdict = 'next' | 'stop'

async function runTask(slot: HubSlot, task: HubTask): Promise<RunVerdict> {
  const lease = await ensureLease(slot, task.owner)
  if (!lease) {
    // 拿不到驾驶位：如实告诉等待者「已排队」，退避后再推（不是失败）。
    task.state = 'queued'
    resolveWaiters(task, 'queued')
    scheduleRetry(slot)
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
    const result = await driveTask(slot, task)
    if (result.kind === 'yield') {
      // 让位：账本已逐步落盘，任务回队列等退避重试；等待者先拿到「已排队」。
      task.state = 'queued'
      resolveWaiters(task, 'queued')
      scheduleRetry(slot)
      return 'stop'
    }
    await settleTask(slot, task, result.report)
    return 'next'
  } catch (error) {
    await settleTask(slot, task, {
      outcome: 'failed',
      stoppedBecause: 'error',
      steps: task.steps.slice(),
      session: null,
    })
    return 'next'
  } finally {
    task.seat.exitDrive?.()
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

/** 拿/续/接管驾驶位；拿不到即 null（让位，退避后重试）。 */
async function ensureLease(slot: HubSlot, pluginId: string): Promise<HubLease | null> {
  const deps = slot.deps
  const now = deps.now()
  const current = await readHubLease(slot.paths)
  const processAlive = current && current.driverId !== slot.driverId ? isAlive(deps, current.pid) : null
  const decision = decideHubLease({ current, driverId: slot.driverId, now, processAlive })
  if (decision.kind === 'wait') return null
  const lease = createHubLease({ driverId: slot.driverId, pluginId, pid: deps.pid, now, generation: decision.generation })
  const wrote = await writeHubLease(slot.paths, lease)
  if (wrote) {
    // 写完再读回确认代次：同机多进程同抢时，以最后一次落盘为准（写不出就退回单进程内推进）。
    const confirmed = await readHubLease(slot.paths)
    if (!isHubLeaseOwner(confirmed, slot.driverId, lease.generation)) return null
  }
  slot.lease = lease
  return lease
}

/**
 * 每步前的驾驶位复核：文件是最终裁判。
 * - 读不到租约：说明这台机器上写不出租约（ensureLease 已确认过归属），退回单进程内推进；
 * - 读到别人的代次：让位（yield），由退避重试重新排队，绝不和对方抢同一步。
 */
async function stillOwnsLease(slot: HubSlot): Promise<boolean> {
  const lease = slot.lease
  if (!lease) return true
  const current = await readHubLease(slot.paths)
  if (!current) return true
  return isHubLeaseOwner(current, slot.driverId, lease.generation)
}

/**
 * 续心跳。返回 'lost' 表示盘上已经换成别人的代次——此时一个字都不写（lease-store 的口径：
 * 不是我的代次就不动），并清掉本地租约，让调用方让位重排队。
 */
async function heartbeat(slot: HubSlot): Promise<'ok' | 'lost'> {
  const lease = slot.lease
  if (!lease) return 'ok'
  const now = slot.deps.now()
  if (!shouldHeartbeatHubLease(lease, now)) return 'ok'
  const current = await readHubLease(slot.paths)
  if (current && !isHubLeaseOwner(current, slot.driverId, lease.generation)) {
    slot.lease = null
    return 'lost'
  }
  const next: HubLease = { ...lease, heartbeatAt: now }
  slot.lease = next
  await writeHubLease(slot.paths, next)
  return 'ok'
}

async function releaseIfOwner(slot: HubSlot): Promise<void> {
  const lease = slot.lease
  if (!lease) return
  slot.lease = null
  await releaseHubLease(slot.paths, slot.driverId, lease.generation)
}

/** 进展指纹：只看会改变判定的事实（键/相位/目标版/待重启/错误）。 */
function progressSignature(session: BatchSession): string {
  const rows = session.entries
    .map((entry) => [entry.key, entry.phase, entry.targetVersion ?? '', entry.restartRequired ? '1' : '0', entry.error ?? ''].join('~'))
    .join(',')
  return session.id + '|' + rows
}

/** 这个使用范围里有没有未收尾的中枢任务（drain 等旁路据此让位，避免双驱动）。 */
export function hubBusyForScope(scope: HubScope): boolean {
  const slot = registry().slots.get(slotKeyOf(scope))
  return Boolean(slot && slot.tasks.some((task) => task.state !== 'settled'))
}

/** 测试用：清空注册表并停掉所有退避定时器（等价于「进程重启」）。 */
export function __resetHubRegistryForTests(): void {
  const state = registry()
  for (const slot of state.slots.values()) {
    if (slot.retryTimer !== null) {
      slot.deps.timers.clearTimeout(slot.retryTimer)
      slot.retryTimer = null
    }
  }
  state.slots.clear()
}

/** 测试用：这个使用范围当前有没有活着的中枢槽（诊断任务表是否泄漏）。 */
export function hubSlotCountForTests(): number {
  return registry().slots.size
}







