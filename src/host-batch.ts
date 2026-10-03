// src/host-batch.ts —— 多目标批量更新的宿主入口（#25）。
//
// 归属：宿主（Node）侧。为 N 个目标各建一份现有 createHostUpdate 能力（前缀与插件标识隔离），
// 共享同一套队列端口（同一使用范围）；批量会话账本落盘（见 store.ts 的 batch 路径），
// 让「关面板/重启进程」之后还能接着推进（resume）。
//
// 契约（面板侧按它写，见 src/panel-batch.ts）：
//   前缀由调用方给（batchPrefix，例 'life'），五个批量电话：
//     <p>.batchStatus  {}                -> 全表（rows + progress + session）
//     <p>.batchCheck   {}                -> 查 N 家后同形状
//     <p>.batchInstall { keys?: string[] }-> 建/续会话并推进：不给 keys 即「全部提交」；
//                                            给了 keys 只推那几家（行内「装这家」/「重试」用）
//     <p>.batchResume  {}                -> 读盘上会话，resume 后推进
//     <p>.batchCancel  {}                -> 清掉盘上会话，回空会话
//   每行的单插件三电话照旧各自前缀暴露（<target.prefix>.updateStatus 等）。
//
// 实现要点（第一性）：
//   1. 每个目标一份 createHostUpdate：它的单例复用键含插件标识与前缀（见 host.ts），
//      七个目标各有各的内存状态，不串台；队列端口只建一份给所有目标共用（同一使用范围）。
//   2. 串行与落盘全交 batch.ts / batch-run.ts（已有门禁），本文件只做「电话 <-> 驱动器」的翻译：
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

import { homedir } from 'node:os'
import {
  batchProgress,
  batchRequestId,
  createBatchSession,
  emptyBatchSession,
  isBatchFinished,
  orderTargets,
  resumeBatchSession,
  type BatchEntry,
  type BatchPhase,
  type BatchProgress,
  type BatchSession,
} from './batch.js'
import {
  runBatch,
  type BatchCheckOutcome,
  type BatchInstallOutcome,
  type BatchRunStep,
} from './batch-run.js'
import { assertPluginId, assertPrefix, resolveUpdateConfig, type UpdateConfigInput } from './config.js'
import { createHostUpdate, type HostUpdate, type ReaderOverrides } from './host.js'
import { defaultHomeDir } from './reader.js'
import { compareReleaseVersions } from './service.js'
import {
  createBatchDiskPorts,
  createSkipDiskPorts,
  createUpdateQueuePorts,
  isVersionSkipped,
} from './store.js'

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

/** 批量宿主入口的返回面。 */
export interface MultiHostUpdate {
  /** 电话表：批量电话 + 每个目标的单插件三电话，键即电话名。 */
  handlers: Record<string, (args?: Record<string, unknown>) => Promise<unknown>>
  /** 批量电话名（供接入方登记用，不写字面量）。 */
  phoneNames: { status: string; check: string; install: string; resume: string; cancel: string }
  /** 目标清单（顺序与会话一致）。 */
  targets: readonly MultiTargetSpec[]
  /** 最近一次推进的读数（驱动器停下来的原因 + 步骤）：给日志与门禁用；没推过为 null。 */
  lastRun: { stoppedBecause: string; steps: BatchRunStep[] } | null
  /** 停掉 drain（接入方卸载时调）。 */
  dispose(): void
}

// ---------- 小工具（纯函数，可单独看） ----------

const DEFAULT_DRAIN_INTERVAL_MS = 5000
const MIN_DRAIN_INTERVAL_MS = 1000
const DEFAULT_INSTALL_POLL_MS = 500
const REQUEST_ID_MAX_CHARS = 128

/** 电话/队列认的错误码表（与 host.ts 的收敛表同口径，另加本入口自己的 cross-scope）。 */
const KNOWN_ERROR_CODES = [
  'check-failed',
  'invalid-release',
  'check-expired',
  'update-busy',
  'install-failed',
  'unknown-profile',
  'source-install',
  'invalid-installation',
  'installation-changed',
  'pending-restart',
  'incompatible-node',
  'registry-conflict',
  'recovery-required',
  'cross-scope',
]

/** 任务失败说明里能当前缀认出来的码（job.message 形如「install-failed: 详情」）。 */
const JOB_FAILURE_CODES = [
  'install-failed',
  'installation-changed',
  'registry-conflict',
  'source-install',
  'unknown-profile',
  'invalid-installation',
  'incompatible-node',
  'pending-restart',
  'recovery-required',
  'check-expired',
  'update-busy',
  'check-failed',
  'invalid-release',
]

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

function hash8(text: string): string {
  try {
    const t = String(text || '')
    let h = 5381
    for (let i = 0; i < t.length; i += 1) h = ((h << 5) + h + t.charCodeAt(i)) >>> 0
    return ('0000000' + h.toString(16)).slice(-8)
  } catch {
    return '00000000'
  }
}

/**
 * 账本幂等编号 -> 电话/队列收的编号。账本编号形如 batch:<会话>:<目标>，带冒号，
 * 不在更新核心收的「不透明编号」形状里（[A-Za-z0-9._~-]，见 service.ts 的 validRequestId）。
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
  if (KNOWN_ERROR_CODES.includes(code)) return { error: code, errorKind: code }
  return { error: 'check-failed', errorKind: 'internal' }
}

function codeOfReply(reply: Record<string, unknown>): string {
  const code = firstText(reply['error']) ?? ''
  return KNOWN_ERROR_CODES.includes(code) ? code : 'check-failed'
}

function jobFailureCode(job: Record<string, unknown> | null): string {
  const message = job && typeof job['message'] === 'string' ? (job['message'] as string) : ''
  const head = message.split(':')[0].trim()
  return JOB_FAILURE_CODES.includes(head) ? head : 'install-failed'
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
  queue: unknown
  profileName: string | null
  error: string | null
  /** 最近一次回包带的失败诊断（#21 的 diag；成功回包恒不带，所以成功即清空，不留陈旧诊断）。 */
  diag: unknown
}

const EMPTY_CACHE: RowCache = {
  snapshot: null,
  manual: null,
  queue: null,
  profileName: null,
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
 * 打一通单插件电话，把回包读数收进缓存：成功收快照/手工命令/队列读数并清掉诊断，
 * 失败收失败诊断（#21 的 diag，可能没有）——旧快照读数保留，只有诊断随成败换手。
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
    if ('manual' in value) next.manual = firstText(value['manual'])
    if ('queue' in value) next.queue = value['queue'] ?? null
    if ('env' in value) next.profileName = firstText(asRecord(value['env'])['profileName'])
    next.error = null
    // 成功回包永不带 diag（#21 冻结）：成功即清空，旧诊断不留成陈旧证据。
    next.diag = null
  } else {
    // 失败回包才可能带 diag（status / check / install 三电话同一套 #21 契约），有就收下。
    next.diag = 'diag' in value ? (value['diag'] ?? null) : null
  }
  rt.cache = next
  return value
}

/** 真查一家：打 updateCheck 电话，把快照翻成驱动器读数（有新版才 update；用户跳过的版本不装）。 */
async function defaultCheck(rt: TargetRuntime): Promise<BatchCheckOutcome> {
  const reply = await callPhone(rt, rt.host.phoneNames.updateCheck, { includeEnv: true, includeQueue: true })
  if (reply['ok'] !== true) return { kind: 'failed', error: codeOfReply(reply) }
  const snapshot = snapshotOf(reply)
  const latest = firstText(snapshot['latestVersion'])
  if (!latest) return { kind: 'current' }
  if (isVersionSkipped(await skippedVersionsOf(rt), latest)) return { kind: 'skipped', version: latest }
  const base = firstText(snapshot['installedVersion'], snapshot['runningVersion'])
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
    return { kind: 'failed', error: blocked && KNOWN_ERROR_CODES.includes(blocked) ? blocked : 'check-failed' }
  }
  const checkId = firstText(asRecord(reply['receipt'])['checkId'])
  if (!checkId) return { kind: 'failed', error: 'check-failed' }
  rt.receipt = { checkId, version: latest }
  return { kind: 'update', version: latest }
}

/** 任务相位 -> 安装读数：只有终态才算收尾（装是后台跑的，装电话返回时多半还在 installing）。 */
function installOutcomeOf(job: Record<string, unknown> | null): BatchInstallOutcome | null {
  const state = job && typeof job['state'] === 'string' ? (job['state'] as string) : ''
  if (state === 'restart-required') return { kind: 'done', restartRequired: true }
  if (state === 'completed') return { kind: 'done', restartRequired: false }
  if (state === 'failed' || state === 'interrupted') return { kind: 'failed', error: jobFailureCode(job) }
  return null
}

/** 等这一家收尾：轮询它的 updateStatus 到终态；超安装时限按失败收（不把整轮永远挂着）。 */
async function settleInstall(rt: TargetRuntime, firstReply: Record<string, unknown>): Promise<BatchInstallOutcome> {
  const early = installOutcomeOf(jobOf(snapshotOf(firstReply)))
  if (early) return early
  const deadline = rt.now() + rt.resolved.installTimeoutMs
  while (true) {
    if (rt.now() >= deadline) return { kind: 'failed', error: 'install-failed' }
    await sleep(rt.pollMs)
    const status = await callPhone(rt, rt.host.phoneNames.updateStatus, {})
    if (status['ok'] !== true) return { kind: 'failed', error: codeOfReply(status) }
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
    if (again.kind !== 'update') return { kind: 'failed', error: again.kind === 'failed' ? again.error : 'check-expired' }
    receipt = rt.receipt
    if (!receipt) return { kind: 'failed', error: 'check-expired' }
  }
  const phoneRequestId = phoneRequestIdOf(requestId)
  const reply = await callPhone(rt, rt.host.phoneNames.updateInstall, {
    checkId: receipt.checkId,
    requestId: phoneRequestId,
  })
  rt.receipt = null
  if (reply['ok'] === true) return await settleInstall(rt, reply)
  const code = codeOfReply(reply)
  if (code === 'update-busy') {
    // 宿主的「已占位、排队等轮到你」不是失败（#25 排队语义）：回 queued + 该家队列位置，
    // 驱动器据此把相位退回 ready（远端版本留着），下一轮推动从它接着装。
    return { kind: 'queued', position: await queuePositionFor(rt, phoneRequestId) }
  }
  return { kind: 'failed', error: code }
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
  const scopeError = distinctScopes.size > 1 ? 'cross-scope' : null
  const batchScope = scopeError ? null : (scopes.get(specs[0].key) as TargetScope)

  // 共享队列端口（#15 的同一份）：七个目标共用一套读写口与一把全局锁，不各建一套。
  const queue =
    batchScope && batchScope.profileDir ? createUpdateQueuePorts(batchScope.homeDir, batchScope.profileDir) : null
  const baseOverrides: ReaderOverrides = { ...(input.readerOverrides ?? {}) }
  if (queue && !(baseOverrides.readQueue && baseOverrides.writeQueue)) {
    baseOverrides.readQueue = () => queue.readQueue()
    baseOverrides.writeQueue = (state) => queue.writeQueue(state)
    if (typeof baseOverrides.tryAcquireGlobalLock !== 'function') {
      baseOverrides.tryAcquireGlobalLock = (lockId: string, pluginId: string) =>
        queue.tryAcquireGlobalLock(lockId, pluginId, {})
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

  // 会话账本：有使用范围就落盘（store.ts 的 batch.json），算不出使用范围目录时退化为内存账本。
  const batchPorts =
    batchScope && batchScope.profileDir ? createBatchDiskPorts(batchScope.homeDir, batchScope.profileDir) : null
  let memSession: BatchSession | null = null
  let driveActive = false
  /** 正在被驱动的那份会话（内存里的唯一真相）：忙时入队并进来的行靠它传给正在跑的驱动。 */
  let liveSession: BatchSession | null = null
  /** 最近一次推进的读数（lastRun 用；推进抛错时不更新）。 */
  let lastRun: { stoppedBecause: string; steps: BatchRunStep[] } | null = null
  let drainTimer: unknown = null
  let disposed = false

  async function readSession(): Promise<BatchSession> {
    if (batchPorts) return await batchPorts.readBatch()
    return memSession ?? emptyBatchSession()
  }
  async function saveSession(session: BatchSession): Promise<void> {
    if (batchPorts) {
      await batchPorts.writeBatch(session)
      return
    }
    memSession = session
  }
  async function clearSession(): Promise<void> {
    if (batchPorts) {
      await batchPorts.clearBatch()
      return
    }
    memSession = emptyBatchSession()
  }
  function newSessionId(): string {
    const suffix = String(randomId() ?? '').replace(/[^A-Za-z0-9._~-]/g, '').slice(0, 24)
    return now().toString(36) + '-' + (suffix || hash8(String(now())))
  }

  /** 进度读数：有账本就按账本口径（与 batch.ts 同一份）；还没有账本时按清单给全待办。 */
  function progressOf(session: BatchSession): BatchProgress {
    if (session.entries.length > 0) return batchProgress(session)
    const total = runtimes.length
    return { total, done: 0, failed: 0, skipped: 0, current: 0, pending: total, finished: false }
  }

  /** 全表行：相位/版本/失败码来自账本，快照来自各目标电话（推进中一律用缓存，见注释）。 */
  async function buildRows(session: BatchSession, refresh: boolean): Promise<Record<string, unknown>[]> {
    const entryOf = new Map(session.entries.map((entry) => [entry.key, entry]))
    const rows: Record<string, unknown>[] = []
    for (const rt of runtimes) {
      const entry = entryOf.get(rt.spec.key) ?? null
      // 推进中不打单插件电话：宿主读取器是单槽缓存，换键会丢掉正在装那家的活动任务编号，
      // 把「在装」误读成「中断」。推进中的行给缓存快照，相位仍从盘上账本实时读。
      if (refresh && !driveActive) {
        await callPhone(rt, rt.host.phoneNames.updateStatus, { includeEnv: true, includeQueue: true })
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
        queue: rt.cache.queue,
        profileName: rt.cache.profileName,
        phoneNames: rt.host.phoneNames,
        // 新增两格（#25 解法三，只增不改）：该目标的宿主插件标识，与最近一次失败回包的诊断。
        pluginId: rt.pluginId,
        diag: rt.cache.diag,
      })
    }
    return rows
  }

  async function table(session: BatchSession, refresh = true): Promise<Record<string, unknown>> {
    const rows = await buildRows(session, refresh)
    return { ok: true, session, rows, progress: progressOf(session) }
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

  async function checkPhone(): Promise<Record<string, unknown>> {
    const refuse = denied()
    if (refuse) return refuse
    const session = await readSession()
    if (!driveActive) {
      for (const rt of runtimes) {
        try {
          const outcome = await rt.check(rt.spec.key, rt.spec)
          rt.cache = { ...rt.cache, error: outcome.kind === 'failed' ? outcome.error : null }
        } catch (error) {
          rt.cache = { ...rt.cache, error: errorPayloadOf(error).error }
        }
      }
    }
    return await table(session, false)
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
    return await table(session, false)
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
    try {
      let session = await readSession()
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
      driven = await driveLocked(session, selected, Number.POSITIVE_INFINITY)
    } catch (error) {
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
    if (disk.entries.length === 0) return await table(disk)
    const resumed = resumeBatchSession(disk, now())
    if (resumed !== disk) await saveSession(resumed)
    try {
      return await table(await drive(resumed, null, Number.POSITIVE_INFINITY))
    } catch (error) {
      return { ok: false, ...errorPayloadOf(error) }
    }
  }

  async function cancelPhone(): Promise<Record<string, unknown>> {
    const refuse = denied()
    if (refuse) return refuse
    // 推进中不许清账本：清了会让下一轮换新编号重复装，宁可回忙。
    if (driveActive) return { ok: false, error: 'update-busy', errorKind: 'update-busy' }
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
      await drive(disk, null, 1)
    } catch {}
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

  const phoneNames = {
    status: prefix + '.batchStatus',
    check: prefix + '.batchCheck',
    install: prefix + '.batchInstall',
    resume: prefix + '.batchResume',
    cancel: prefix + '.batchCancel',
  }
  function phone(
    fn: (args: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ): (args?: Record<string, unknown>) => Promise<unknown> {
    return async (args?: Record<string, unknown>): Promise<Record<string, unknown>> => {
      try {
        return await fn(asRecord(args))
      } catch (error) {
        return { ok: false, ...errorPayloadOf(error) }
      }
    }
  }
  const handlers: Record<string, (args?: Record<string, unknown>) => Promise<unknown>> = {}
  handlers[phoneNames.status] = phone(() => statusPhone())
  handlers[phoneNames.check] = phone(() => checkPhone())
  handlers[phoneNames.install] = phone((args) => installPhone(args))
  handlers[phoneNames.resume] = phone(() => resumePhone())
  handlers[phoneNames.cancel] = phone(() => cancelPhone())
  // 每个目标的单插件三电话照旧各自前缀暴露：批量电话与它们同处一张表，接入方一次登记。
  for (const rt of runtimes) {
    for (const name of Object.keys(rt.host.handlers)) {
      const handler = rt.host.handlers[name]
      handlers[name] = (args?: Record<string, unknown>) => handler(asRecord(args))
    }
  }

  armDrain()

  return {
    handlers,
    phoneNames,
    targets: orderedSpecs,
    get lastRun(): { stoppedBecause: string; steps: BatchRunStep[] } | null {
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
