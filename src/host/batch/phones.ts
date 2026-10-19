// src/host/batch/phones.ts —— 批量电话外壳与目标运行期零件（#227 从 host-batch.ts 搬出，蓝图 §4 batch 域）。
//
// 身份：本文件只做「电话 <-> 驱动器」的翻译（原 host-batch.ts 头注释第 2 条）：
// 目标清单校验与电话前缀隔离（前缀重复即拒）、目标运行期零件 TargetRuntime、打一通单插件电话并把
// 回包读数收进行缓存、真查/真装/等收尾、queued 时的队列位置。串行与落盘仍全交 core/batch/。
// BatchHostPhoneNames 也住这里（宿主侧多登记一个 logAppend，见类型注释）。

import { phoneRequestIdOf } from './resume.js'
import type { MultiHostTimer, MultiTargetSpec, TargetCheckFn, TargetInstallFn } from '../../host-batch.js'

import {
  type BatchCheckOutcome,
  type BatchInstallOutcome,
} from '../../core/batch/run.js'
import { assertPluginId, assertPrefix, resolveUpdateConfig, type UpdateConfigInput } from '../../shared/config.js'
import { isBatchReplyCode, isCoreErrorCode } from '../../shared/codes.js'
import { type HostUpdate } from '../../host/factory.js'
import type { ManualSource } from '../../shared/last-resort.js'
import { compareReleaseVersions } from '../../core/service.js'
import {
  createSkipDiskPorts,
  isVersionSkipped,
} from '../../core/disk.js'

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
export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
export function firstText(...values: unknown[]): string | null {
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
export function errorPayloadOf(error: unknown): { error: string; errorKind: string } {
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
export function validateTargets(raw: unknown): MultiTargetSpec[] {
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
export function pluginIdOf(spec: MultiTargetSpec, batchPrefix: string): string {
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

export const EMPTY_CACHE: RowCache = {
  snapshot: null,
  manual: null,
  manualSource: null,
  queue: null,
  profileName: null,
  hostKind: null,
  error: null,
  diag: null,
}

export interface TargetScope {
  homeDir: string
  profileDir: string | null
}

/** 一个目标的全部运行期零件（宿主能力、传输、缓存、幂等凭证）。 */
export interface TargetRuntime {
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

export function defaultTimers(): MultiHostTimer {
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
export async function callPhone(rt: TargetRuntime, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
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
export async function defaultCheck(rt: TargetRuntime): Promise<BatchCheckOutcome> {
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
export async function defaultInstall(rt: TargetRuntime, key: string, spec: MultiTargetSpec, requestId: string): Promise<BatchInstallOutcome> {
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
