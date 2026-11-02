/**
 * selftest/real-machine/scenarios/h-queue-lock.ts —— 票 #270（spec #263 T6 / F 组：队列与锁）真机场景。
 *
 * 测什么：两个**真机入口**同时更新同一 profile/target 时，产品的队列与全局锁行为。
 * 入口 = 两个独立 DSH web 宿主进程（selftest/real-machine/host/cli-host.ts）：
 * 二者用同一个 USERPROFILE/osHomeDir、同一个 homeDir=osHomeDir/.dsh、同一个 profile 名，
 * 于是两个进程解析到同一个 profileDir，抢同一把 <home>/update-queue/<shortHash(profileDir)>/global.lock，
 * 并写同一份 queue.json —— 这是真跨进程锁竞争（不是同进程模拟）。
 *
 * 四个 mode（工具 tools/run-h-queue-lock.ts 传 --mode）：
 *   - concurrent-simultaneous：两个入口几乎同时（Promise.all、不 await 完成）对同一 target 发 updateInstall；
 *   - concurrent-lock-window：入口 1 先受理、轮询到 global.lock 出现（持锁窗内）立刻让入口 2 发同一目标安装；
 *   - stale-reclaim：预写一个 pid 已死、startedAt 60s 前的 global.lock，宿主安装预算压到 4s，触发更新看
 *     lock.anomaly(stale-owner) + queue.transition(reclaimed) 后是否继续装成；
 *   - can-red：镜像入口 1 抢到全局锁 + 自家锁后，由 harness 删除两把锁并把 queue.json 置空（模拟锁/队列
 *     状态一起丢失），再让入口 2 发同一目标安装 ——
 *     预期第二个安装越过锁（被受理或两个 exec 窗口重叠），本 run 记为 fail/exit1（证明该断言可红）。
 *
 * 证据口径（selftest/evidence/README.md）：安装窗口不用 UI，用 <home>/logs/<pluginId>/<date>.log 里
 * update.install.exec 的 ts 与 durationMs 还原 [ts-durationMs, ts]；锁/队列用 10ms 轮询锁文件与 queue.json
 * 的时间线；磁盘看 profile package.json/node_modules；台账看 <home>/updates/<pluginId>/<hash>/state.json。
 *
 * 共享 home 的取舍：两个宿主共享 home 是为了共享同一把锁；sessions/storages 等其它状态串台不在本组断言范围
 * （notes 里写明）。这属于 harness 侧人为构造的真机条件，不冒充产品支持的部署方式。
 */
import { createHash } from 'node:crypto'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  FIXTURE_INSTALL_TIMEOUT_ENV,
  FIXTURE_REGISTRY_ENV,
  fixtureBridgeRouteOf,
  fixtureBuildTagPhoneOf,
  fixtureSlotOf,
} from '../../fixtures/identity/fixture-slots.ts'
import { fetchPublishedVersions } from '../../fixtures/release/registry-client.ts'
import { ensureDir, listFilesRecursive } from '../../tooling/fs-utils.ts'
import { isPortFree } from '../../tooling/ports.ts'
import { isProcessAlive, sleep } from '../../tooling/process.ts'
import type { CliHostSession } from '../host/cli-host.ts'
import { startCliHost } from '../host/cli-host.ts'
import { readProfileManifest } from '../host/dsh-cli.ts'
import { createWebProfileInHome } from '../host/isolated-profile.ts'
import type { RunManifest } from '../runtime/evidence.ts'
import { captureLogFiles } from '../runtime/log-evidence.ts'
import { publishScenarioVariants } from '../runtime/scenario-runner.ts'
import { copyRunEvidence } from './batch-helpers.ts'
import type { T3Run } from './t3-common.ts'
import { installedFixtureVersion, openT3Run, verifySutInstalled } from './t3-common.ts'

/** 场景 mode：两个并发入口变体 + 陈旧锁回收 + can-red（预期红）。 */
export type QueueLockMode = 'concurrent-simultaneous' | 'concurrent-lock-window' | 'stale-reclaim' | 'can-red'

/** 一次真机 run 的入参（工具层解析后原样传）。 */
export interface QueueLockOptions {
  readonly worktree: string
  readonly runBaseDir: string
  readonly verdaccioInstallDir: string
  readonly esbuildPath: string
  readonly stamp?: string
  readonly maintainerHome?: string
  readonly mode: QueueLockMode
  /** false = 只把证据留在仓库外（试错 run），true/缺省 = 复制进 selftest/evidence/runs。 */
  readonly syncEvidence?: boolean
}

/** 场景 id 与 mode 的映射（并发时序拆成两个声明；can-red 复用 h1：同一场景、同一组断言被破坏）。 */
export function scenarioIdOf(mode: QueueLockMode): string {
  if (mode === 'stale-reclaim') return 'h2-queue-lock-stale-reclaim'
  if (mode === 'concurrent-simultaneous') return 'h1b-queue-lock-simultaneous'
  return 'h1-queue-lock-concurrent'
}

/** 隔离 profile 名（不能用 desktop：官方桌面独占该名，普通宿主建不了，见 P1 探针）。 */
const PROFILE_NAME = 't6lock'
/** 锁/队列轮询间隔（can-red 要抢在安装真正写盘之前删锁，取 10ms）。 */
const LOCK_POLL_MS = 10
/** 宿主安装预算/全局锁陈旧阈值：陈旧锁格压到 4s（capabilities 会把 installTimeoutMs 传给 tryAcquireGlobalLock）。 */
const STALE_INSTALL_TIMEOUT_MS = 4000
/** 预写陈旧锁的 startedAt 老化量。 */
const STALE_LOCK_AGE_MS = 60_000
/** 一个必然已死的 pid（Windows 上 999999 不存在；落 raw 前会用 isProcessAlive 核实）。 */
const DEAD_PID = 999_999
/** 等作业终态的预算。 */
const TERMINAL_TIMEOUT_MS = 180_000
/** 等 exec 证据行出现的预算。 */
const EXEC_WAIT_TIMEOUT_MS = 120_000
/** 锁时间线/exec 窗口断言的轮询误差容忍（毫秒）。 */
const WINDOW_TOLERANCE_MS = 1000

interface HostEntry {
  readonly label: string
  readonly host: CliHostSession
  readonly pid: number | null
  readonly port: number
  closed: boolean
}

interface QueuePaths {
  readonly directory: string
  readonly queueFile: string
  readonly lockFile: string
  readonly baseLockFile: string
  readonly stateFile: string
}

interface LockSample {
  readonly t: number
  readonly lockPresent: boolean
  readonly lockRaw: string | null
  readonly lockId: string | null
  readonly lockPid: number | null
  readonly lockStartedAt: number | null
  readonly lockPluginId: string | null
  readonly queueRaw: string | null
  readonly queueOwnerPluginId: string | null
  readonly queueOwnerJobId: string | null
  readonly queueOwnerRequestId: string | null
  readonly queueWaitingCount: number
  readonly queueWaitingRequestIds: string[]
}

interface RawLogRow {
  readonly ts: number | null
  readonly event: string
  readonly level: string | null
  readonly fields: Record<string, unknown>
  readonly source: string
  readonly line: number
}

interface LedgerState {
  readonly file: string
  readonly state: Record<string, unknown>
}

interface SnapshotJob {
  readonly id?: string | null
  readonly state?: string | null
  readonly targetVersion?: string | null
  readonly message?: string | null
  readonly requestId?: string | null
}

interface CliSnapshot {
  readonly runningVersion?: string | null
  readonly installed?: boolean
  readonly installedVersion?: string | null
  readonly latestVersion?: string | null
  readonly canInstall?: boolean
  readonly blockedReason?: string | null
  readonly job?: SnapshotJob | null
}

interface PhoneOutcome {
  readonly status: number
  readonly durationMs: number
  readonly body: Record<string, unknown>
  readonly ok: boolean
  readonly error: string | null
  readonly errorKind: string | null
  readonly fields: Record<string, unknown>
  readonly replyValue: unknown
  readonly snapshot: CliSnapshot | null
}

interface ExecWindow {
  readonly start: number
  readonly end: number
  readonly ts: number
  readonly durationMs: number
  readonly route: string | null
  readonly ok: boolean | null
  readonly exitCode: number | null
  readonly pluginId: string | null
  readonly source: string
  readonly line: number
}

/** 产品 src/shared/hash.ts 的 hash8（djb2 截 8 位十六进制）；断言 ownerHash/holderHash 时复算。 */
function hash8Of(value: unknown): string {
  try {
    const text = String(value === null || value === undefined ? '' : value)
    let h = 5381
    for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0
    return ('0000000' + h.toString(16)).slice(-8)
  } catch {
    return '00000000'
  }
}

/** 产品 src/core/store-base.ts 的 shortHash：sha256 十六进制前 24 位。 */
function shortHashOf(text: string): string {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 24)
}

/** 产品 queuePathsForUpdate / pathsForUpdate 的同一口径（home, profileDir -> 锁/队列/台账路径）。 */
function queuePathsOf(homeDir: string, profileDir: string, pluginId: string): QueuePaths {
  const queueDirectory = join(homeDir, 'update-queue', shortHashOf(profileDir))
  const stateDirectory = join(homeDir, 'updates', pluginId, shortHashOf(profileDir))
  return {
    directory: queueDirectory,
    queueFile: join(queueDirectory, 'queue.json'),
    lockFile: join(queueDirectory, 'global.lock'),
    baseLockFile: join(stateDirectory, 'install.lock'),
    stateFile: join(stateDirectory, 'state.json'),
  }
}

async function readMaybe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

function parseJsonMaybe(text: string | null): Record<string, unknown> | null {
  if (text === null || text.trim() === '') return null
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function strOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function numOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 轮询直到 check 返回非 null 或超时（超时回 null，不抛）。 */
async function pollUntil<T>(check: () => Promise<T | null>, timeoutMs: number, intervalMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value !== null) return value
    await sleep(intervalMs)
  }
  return null
}

/** 递归读 <home>/logs/** 的 JSON 行，保留 raw 行里的 ts（log-evidence.readLogEvents 会丢 ts）。 */
async function readRawLogRows(homeDir: string): Promise<RawLogRow[]> {
  const logsDir = join(homeDir, 'logs')
  const files = await listFilesRecursive(logsDir).catch(() => [] as string[])
  const rows: RawLogRow[] = []
  for (const relative of files) {
    if (!relative.endsWith('.log')) continue
    const file = join(logsDir, relative.split('/').join('\\'))
    const text = await readFile(file, 'utf8').catch(() => '')
    const lines = text.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (line.trim() === '') continue
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>
        const event = strOf(parsed.event)
        if (!event) continue
        const fields = parsed.fields !== null && typeof parsed.fields === 'object' ? (parsed.fields as Record<string, unknown>) : {}
        rows.push({
          ts: numOf(parsed.ts),
          event,
          level: strOf(parsed.level),
          fields,
          source: relative,
          line: index + 1,
        })
      } catch {
        // 未解析行由 captureLogFiles 的 unparsedLines 统计
      }
    }
  }
  return rows
}

/** 读 <home>/updates 下各级 state.json 台账（与 e-cli-host-exits 同一口径）。 */
async function readLedgerStates(homeDir: string): Promise<LedgerState[]> {
  const root = join(homeDir, 'updates')
  const files = await listFilesRecursive(root).catch(() => [] as string[])
  const result: LedgerState[] = []
  for (const relative of files) {
    const segments = relative.split('/')
    if (segments[segments.length - 1] !== 'state.json') continue
    const file = join(root, relative.split('/').join('\\'))
    const text = await readMaybe(file)
    if (text === null) {
      result.push({ file, state: { unreadable: true } })
      continue
    }
    try {
      const parsed = JSON.parse(text) as unknown
      result.push({ file, state: parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { corrupt: true } })
    } catch {
      result.push({ file, state: { corrupt: true } })
    }
  }
  return result
}

/** 发一次电话并解析出回包（ok/error/fields/snapshot 都在 body 顶层与 body.reply 里，口径同 e-cli）。 */
async function callPhone(host: CliHostSession, route: string, phone: string, args: Record<string, unknown>): Promise<PhoneOutcome> {
  const reply = await host.postPhone(route, phone, args)
  const body =
    reply.body !== null && typeof reply.body === 'object'
      ? (reply.body as Record<string, unknown>)
      : ({ rawText: String(reply.body) } as Record<string, unknown>)
  const inner = body.reply !== null && typeof body.reply === 'object' ? (body.reply as Record<string, unknown>) : null
  const fields = inner ?? {}
  const snapshot = fields.snapshot !== null && typeof fields.snapshot === 'object' ? (fields.snapshot as CliSnapshot) : null
  return {
    status: reply.status,
    durationMs: reply.durationMs,
    body,
    // 宿主电话是 {ok:true, reply:{ok:false,error:'update-busy'}} 这样的双层信封：外层表示电话本身送达，
    // 业务受理/拒绝要看 reply.ok。夹具 buildTag 之类没有 ok 字段的则退回外层。
    ok: inner !== null && typeof inner.ok === 'boolean' ? inner.ok === true : body.ok === true,
    error: strOf(inner?.error) ?? strOf(body.error),
    errorKind: strOf(inner?.errorKind) ?? strOf(body.errorKind),
    fields,
    replyValue: body.reply,
    snapshot,
  }
}

/** 作业状态判定（与 e-cli 同一组终态）。 */
function terminalJobState(state: string | null | undefined): boolean {
  return state === 'completed' || state === 'restart-required' || state === 'failed' || state === 'interrupted'
}

function jobStateOf(outcome: PhoneOutcome | null | undefined): string | null {
  return outcome?.snapshot?.job?.state ?? null
}

/** 一个安装电话是否被受理（快速回包 + job 进入 installing/verifying）。 */
function acceptedOf(outcome: PhoneOutcome): boolean {
  const state = jobStateOf(outcome)
  return outcome.ok && (state === 'installing' || state === 'verifying')
}

/** 把安装电话回包压成一句可写进断言 actual 的事实。 */
function describeOutcome(label: string, outcome: PhoneOutcome): string {
  return (
    label +
    ': ok=' +
    String(outcome.ok) +
    '；job.state=' +
    String(jobStateOf(outcome)) +
    '；error=' +
    String(outcome.error) +
    '；http=' +
    String(outcome.status) +
    '；durationMs=' +
    String(outcome.durationMs)
  )
}

/** 锁/队列时间线观察器：10ms 轮询 global.lock 与 queue.json，只在变化时留样本。 */
class QueueLockWatcher {
  readonly samples: LockSample[] = []
  timer: ReturnType<typeof setInterval> | null = null
  readonly paths: QueuePaths

  constructor(paths: QueuePaths) {
    this.paths = paths
  }

  async readSample(): Promise<LockSample> {
    const lockRaw = await readMaybe(this.paths.lockFile)
    const queueRaw = await readMaybe(this.paths.queueFile)
    const lock = parseJsonMaybe(lockRaw)
    const queue = parseJsonMaybe(queueRaw)
    const owner =
      queue !== null && queue.owner !== null && typeof queue.owner === 'object' ? (queue.owner as Record<string, unknown>) : null
    const waiting = queue !== null && Array.isArray(queue.waiting) ? (queue.waiting as unknown[]) : []
    const waitingRequestIds: string[] = []
    for (const item of waiting) {
      const entry = item !== null && typeof item === 'object' ? (item as Record<string, unknown>) : {}
      const requestId = strOf(entry.requestId)
      if (requestId !== null) waitingRequestIds.push(requestId)
    }
    return {
      t: Date.now(),
      lockPresent: lockRaw !== null,
      lockRaw,
      lockId: lock ? strOf(lock.id) : null,
      lockPid: lock ? numOf(lock.pid) : null,
      lockStartedAt: lock ? numOf(lock.startedAt) : null,
      lockPluginId: lock ? strOf(lock.pluginId) : null,
      queueRaw,
      queueOwnerPluginId: owner ? strOf(owner.pluginId) : null,
      queueOwnerJobId: owner ? strOf(owner.jobId) : null,
      queueOwnerRequestId: owner ? strOf(owner.requestId) : null,
      queueWaitingCount: waiting.length,
      queueWaitingRequestIds: waitingRequestIds,
    }
  }

  start(): void {
    if (this.timer !== null) return
    void this.readSample()
      .then((sample) => this.push(sample))
      .catch(() => undefined)
    this.timer = setInterval(() => {
      void this.readSample()
        .then((sample) => this.push(sample))
        .catch(() => undefined)
    }, LOCK_POLL_MS)
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private push(sample: LockSample): void {
    const last = this.samples[this.samples.length - 1]
    if (
      last === undefined ||
      last.lockRaw !== sample.lockRaw ||
      last.queueRaw !== sample.queueRaw ||
      last.lockPresent !== sample.lockPresent
    ) {
      this.samples.push(sample)
    }
  }

  /** 观测到的锁 id 序列（去重保序）；陈旧锁格应看到「旧 id -> 新 id」两个。 */
  lockIds(): string[] {
    const ids: string[] = []
    for (const sample of this.samples) {
      if (sample.lockId !== null && ids.indexOf(sample.lockId) < 0) ids.push(sample.lockId)
    }
    return ids
  }

  /** 把变化样本还原成「锁被持有的连续区间」（首末样本时间，误差 ±LOCK_POLL_MS）。 */
  lockIntervals(): { from: number; to: number | null; ids: string[] }[] {
    const intervals: { from: number; to: number | null; ids: string[] }[] = []
    let open: { from: number; to: number | null; ids: string[] } | null = null
    for (const sample of this.samples) {
      if (sample.lockPresent) {
        if (open === null) {
          open = { from: sample.t, to: null, ids: sample.lockId === null ? [] : [sample.lockId] }
          intervals.push(open)
        } else if (sample.lockId !== null && open.ids.indexOf(sample.lockId) < 0) {
          open.ids.push(sample.lockId)
        }
      } else if (open !== null) {
        open.to = sample.t
        open = null
      }
    }
    return intervals
  }

  async waitForLockPresent(timeoutMs: number): Promise<{ at: number; raw: string | null } | null> {
    return pollUntil(async () => {
      const raw = await readMaybe(this.paths.lockFile)
      return raw === null ? null : { at: Date.now(), raw }
    }, timeoutMs, LOCK_POLL_MS)
  }

  async waitForBothLocks(timeoutMs: number): Promise<{ at: number; globalRaw: string | null; baseRaw: string | null } | null> {
    return pollUntil(async () => {
      const globalRaw = await readMaybe(this.paths.lockFile)
      const baseRaw = await readMaybe(this.paths.baseLockFile)
      return globalRaw === null || baseRaw === null ? null : { at: Date.now(), globalRaw, baseRaw }
    }, timeoutMs, LOCK_POLL_MS)
  }

  async waitForLockAbsent(timeoutMs: number): Promise<number | null> {
    return pollUntil(async () => {
      const raw = await readMaybe(this.paths.lockFile)
      return raw === null ? Date.now() : null
    }, timeoutMs, 50)
  }
}

/** 把 update.install.exec 行还原成安装窗口 [ts-durationMs, ts]。 */
function execWindowsOf(rows: RawLogRow[]): ExecWindow[] {
  const windows: ExecWindow[] = []
  for (const row of rows) {
    if (row.event !== 'update.install.exec') continue
    const durationMs = numOf(row.fields.durationMs)
    const ts = row.ts
    if (durationMs === null || ts === null) continue
    windows.push({
      start: ts - durationMs,
      end: ts,
      ts,
      durationMs,
      route: strOf(row.fields.route),
      ok: typeof row.fields.ok === 'boolean' ? row.fields.ok : null,
      exitCode: numOf(row.fields.exitCode),
      pluginId: strOf(row.fields.pluginId),
      source: row.source,
      line: row.line,
    })
  }
  return windows
}

/** 两个窗口是否真重叠（只碰边界不算）。 */
function windowsOverlap(first: ExecWindow, second: ExecWindow): boolean {
  return first.start < second.end && second.start < first.end
}

async function waitForExecRows(homeDir: string, minCount: number, timeoutMs: number): Promise<RawLogRow[]> {
  const found = await pollUntil(async () => {
    const rows = await readRawLogRows(homeDir)
    return execWindowsOf(rows).length >= minCount ? rows : null
  }, timeoutMs, 250)
  return found ?? (await readRawLogRows(homeDir))
}

/** 等作业终态（轮询 updateStatus；超时回最后回包并标记 timedOut）。 */
async function waitForTerminal(
  host: CliHostSession,
  route: string,
  statusPhone: string,
  timeoutMs: number,
): Promise<{ outcome: PhoneOutcome | null; polls: number; elapsedMs: number; timedOut: boolean }> {
  const startedAt = Date.now()
  let polls = 0
  let last: PhoneOutcome | null = null
  while (Date.now() - startedAt < timeoutMs) {
    polls += 1
    try {
      last = await callPhone(host, route, statusPhone, {})
    } catch {
      last = null
    }
    if (terminalJobState(last?.snapshot?.job?.state)) {
      return { outcome: last, polls, elapsedMs: Date.now() - startedAt, timedOut: false }
    }
    await sleep(500)
  }
  return { outcome: last, polls, elapsedMs: Date.now() - startedAt, timedOut: true }
}

/** 收尾：把证据复制进仓库（除非试错 run 显式禁用）。 */
async function finish(run: T3Run, options: QueueLockOptions): Promise<RunManifest> {
  const manifest = await run.close()
  if (options.syncEvidence === false) return manifest
  try {
    await copyRunEvidence(run.layout, options.worktree)
  } catch (error) {
    console.error('[h-queue-lock] 复制证据失败（run 仍在仓库外）：' + messageOf(error))
  }
  return manifest
}

/** 场景主入口（工具层按 --mode 调用）。 */
export async function runQueueLock(options: QueueLockOptions): Promise<RunManifest> {
  const mode = options.mode
  const scenarioId = scenarioIdOf(mode)
  const run = await openT3Run({
    worktree: options.worktree,
    runBaseDir: options.runBaseDir,
    verdaccioInstallDir: options.verdaccioInstallDir,
    esbuildPath: options.esbuildPath,
    scenarioId,
    hostChannel: 'dsh-web',
    stamp: options.stamp,
    maintainerHome: options.maintainerHome,
    ticket: '270',
  })
  const started: HostEntry[] = []
  let watcher: QueueLockWatcher | null = null

  try {
    const fixtureEnv = run.fixtureEnv
    if (!fixtureEnv) throw new Error('[h-queue-lock] 场景没有夹具环境')
    const slot = fixtureSlotOf(run.scenario.install[0].slotKey)
    const packageName = slot.packageName
    const baselineVersion = run.scenario.install[0].version
    const variant = run.scenario.variants.filter((item) => item.slotKey === slot.key)[0]
    if (!variant) throw new Error('[h-queue-lock] 场景声明缺少 ' + slot.key + ' 的变体版本')
    const variantVersion = variant.version
    const phonePrefix = slot.selfTargetPrefix
    if (!phonePrefix) throw new Error('[h-queue-lock] 夹具席位缺单插件电话前缀')
    // 产品队列/台账里的 pluginId 是**更新目标前缀**（e1 真机日志的 holderHash=hash8('fxa-a')），
    // 不是 packageName；update-queue 短哈希目录、updates/<pluginId>/<hash>/install.lock 都按它落。
    const pluginId = phonePrefix
    const route = fixtureBridgeRouteOf(slot)
    const checkPhone = phonePrefix + '.updateCheck'
    const installPhone = phonePrefix + '.updateInstall'
    const statusPhone = phonePrefix + '.updateStatus'
    const buildTagPhone = fixtureBuildTagPhoneOf(slot)
    const registryUrl = fixtureEnv.registry.baseUrl

    // ---- 1. 隔离口径：两个宿主与它们 spawn 的 CLI 子进程都落在 run 内隔离 home ----
    const osHomeDir = join(run.layout.root, 'os-home')
    const homeDir = join(osHomeDir, '.dsh')
    await ensureDir(osHomeDir)
    await ensureDir(homeDir)
    await run.raw('isolation-facts', {
      osHomeDir,
      homeDir,
      profileName: PROFILE_NAME,
      why:
        '产品 spawn 的 CLI 子进程会剥掉 DSH_* 并按 USERPROFILE 解析 homedir()/.dsh；宿主 homeDir 必须正好是 USERPROFILE/.dsh，' +
        '否则安装落到默认 home，两个入口也就抢不到同一把锁',
      maintainerHomeUntouched: true,
    })
    run.record({
      step: '隔离口径（两宿主同 home = 同一 USERPROFILE/.dsh）',
      what: '两个通道 B 宿主用同一个 USERPROFILE/osHomeDir 与同一个 homeDir（= osHomeDir/.dsh），profile 名不是 desktop（P1 探针证明 desktop 被官方桌面独占）',
      expected: 'homeDir=' + homeDir + '；profileName=' + PROFILE_NAME,
      actual: 'osHomeDir=' + osHomeDir + '；homeDir=' + homeDir + '；profileName=' + PROFILE_NAME,
      verdict: homeDir === join(osHomeDir, '.dsh') && String(PROFILE_NAME) !== 'desktop' ? 'pass' : 'fail',
    })

    // ---- 2. 建普通 profile + 装基版 + SUT 钉住 ----
    const profile = await createWebProfileInHome({ homeDir, profileName: PROFILE_NAME })
    const profileDir = profile.profileDir
    const paths = queuePathsOf(homeDir, profileDir, pluginId)
    await run.raw('profile-create', {
      exitCode: profile.create.exitCode,
      stdout: profile.create.stdout,
      stderr: profile.create.stderr,
      profileDir,
    })
    run.record({
      step: '建普通 profile（CLI 入口）',
      what: '用官方发行 CLI 在隔离 home 建普通 DSH 使用范围 ' + PROFILE_NAME + '；profileDir 决定 update-queue 的短哈希目录名',
      expected: 'exit=0；profileDir=' + join(homeDir, 'profiles', PROFILE_NAME),
      actual: 'exit=' + String(profile.create.exitCode) + '；profileDir=' + profileDir,
      verdict: profile.create.exitCode === 0 ? 'pass' : 'fail',
    })
    await run.installBaseline({ homeDir, profileName: PROFILE_NAME, registryUrl })
    await verifySutInstalled(run, { homeDir, profileName: PROFILE_NAME, packageName })
    const baseDisk = await installedFixtureVersion({ homeDir, profileName: PROFILE_NAME, packageName })
    run.record({
      step: '更新前基版在盘',
      what: '隔离 profile 的 node_modules 里是场景声明的基版 ' + baselineVersion + '（更新前状态）',
      expected: '磁盘版本=' + baselineVersion,
      actual: '磁盘版本=' + String(baseDisk),
      verdict: baseDisk === baselineVersion ? 'pass' : 'fail',
    })
    await run.raw('queue-lock-paths', {
      homeDir,
      profileDir,
      queueDirectory: paths.directory,
      queueFile: paths.queueFile,
      globalLockFile: paths.lockFile,
      baseLockFile: paths.baseLockFile,
      stateFile: paths.stateFile,
      shortHashOfProfileDir: shortHashOf(profileDir),
      why: '两个宿主进程按产品 queuePathsForUpdate(homeDir, profileDir) 解析，profileDir 相同 => 队列目录/global.lock 相同',
    })

    // ---- 3. 发布变体版 + 校验 registry 可见 ----
    const baselinePublication = await run.publishBaseline()
    const publication = await publishScenarioVariants(run.scenario, fixtureEnv, undefined, baselinePublication)
    const publishedVariant = publication.variants[slot.key]
    const publishedVersions = await fetchPublishedVersions(registryUrl, packageName)
    await run.raw('fixture-published-variant', {
      baseline: baselineVersion,
      variant: variantVersion,
      plan: publishedVariant.plan,
      registryVersions: publishedVersions,
    })
    run.record({
      step: '变体版发布（更新目标）',
      what: '按场景声明发布变体 ' + packageName + '@' + variantVersion + '（UI/行为随版本变，重启后可自证）',
      expected: '本地 registry 可见版本含 ' + variantVersion,
      actual: 'registry 版本=' + JSON.stringify(publishedVersions),
      verdict: publishedVersions !== null && publishedVersions.indexOf(variantVersion) >= 0 ? 'pass' : 'fail',
    })

    // ---- 4. 宿主环境：registry 指向本次 run 的 verdaccio；陈旧锁格把安装预算压到 4s ----
    const hostExtraEnv: Record<string, string | undefined> = { [FIXTURE_REGISTRY_ENV]: registryUrl }
    if (mode === 'stale-reclaim') {
      hostExtraEnv[FIXTURE_INSTALL_TIMEOUT_ENV] = String(STALE_INSTALL_TIMEOUT_MS)
      await run.raw('stale-install-timeout-config', {
        env: FIXTURE_INSTALL_TIMEOUT_ENV,
        value: STALE_INSTALL_TIMEOUT_MS,
        why: 'capabilities.ts 会把 installTimeoutMs 传给 queueDisk.tryAcquireGlobalLock；压到 4s 后 60s 前的锁必判陈旧',
      })
    }
    run.addNote('两个宿主共享同一 home/profile 是为了共享同一把 global.lock；sessions/storages 等其它状态串台不在本组断言范围。')
    run.addNote('安装窗口用 update.install.exec 的 ts 与 durationMs 还原（[ts-durationMs, ts]），锁/队列用 ' + String(LOCK_POLL_MS) + 'ms 轮询时间线判定，不用 UI。')

    // ---- 5. 起宿主 / 关宿主 / 发电话的公共小工具 ----
    async function startHost(label: string): Promise<CliHostSession> {
      const host = await startCliHost({ homeDir, osHomeDir, profileName: PROFILE_NAME, extraEnv: hostExtraEnv })
      started.push({ label, host, pid: host.pid() ?? null, port: host.port, closed: false })
      await run.raw('cli-host-launch-' + label, {
        url: host.url,
        port: host.port,
        bootMs: host.bootMs,
        profileName: host.profileName,
        homeDir,
        stdoutTail: host.stdout().slice(-2000),
        stderrTail: host.stderr().slice(-2000),
      })
      return host
    }

    async function closeHosts(): Promise<void> {
      for (const entry of started) {
        if (entry.closed) continue
        entry.closed = true
        await entry.host.close().catch(() => undefined)
        run.registerProcess('cli-host-' + entry.label, entry.pid)
        await run.registerPort('cli-host-' + entry.label + '-port', entry.port)
      }
    }

    async function checkOn(host: CliHostSession, label: string): Promise<{ outcome: PhoneOutcome; checkId: string }> {
      const outcome = await callPhone(host, route, checkPhone, { trigger: 'user' })
      await run.raw('phone-update-check-' + label, { status: outcome.status, durationMs: outcome.durationMs, body: outcome.body })
      const receipt = outcome.fields.receipt !== null && typeof outcome.fields.receipt === 'object' ? (outcome.fields.receipt as Record<string, unknown>) : null
      const checkId = receipt ? (strOf(receipt.checkId) ?? '') : ''
      run.record({
        step: '入口 ' + label + ' check 电话（发现新版）',
        what: '宿主里的电话入口 updateCheck 返回快照：运行版=' + baselineVersion + '、最新版=' + variantVersion + '、可安装，并给候选凭证 checkId',
        expected: 'ok=true；runningVersion=' + baselineVersion + '；latestVersion=' + variantVersion + '；canInstall=true；receipt.checkId 非空',
        actual:
          'ok=' +
          String(outcome.ok) +
          '；runningVersion=' +
          String(outcome.snapshot?.runningVersion) +
          '；latestVersion=' +
          String(outcome.snapshot?.latestVersion) +
          '；canInstall=' +
          String(outcome.snapshot?.canInstall) +
          '；checkId=' +
          JSON.stringify(checkId),
        verdict:
          outcome.ok &&
          outcome.snapshot?.runningVersion === baselineVersion &&
          outcome.snapshot?.latestVersion === variantVersion &&
          outcome.snapshot?.canInstall === true &&
          checkId !== ''
            ? 'pass'
            : 'fail',
      })
      return { outcome, checkId }
    }

    async function fireInstall(host: CliHostSession, label: string, checkId: string, requestId: string): Promise<PhoneOutcome> {
      const outcome = await callPhone(host, route, installPhone, { checkId, requestId, from: 'panel' })
      await run.raw('phone-update-install-' + label, {
        requestId,
        checkId,
        status: outcome.status,
        durationMs: outcome.durationMs,
        body: outcome.body,
      })
      return outcome
    }

    // ---- 6. can-red 用的删锁证据（在宿主运行时由 harness 主动破坏锁） ----
    async function deleteLocksForCanRed(): Promise<{ globalRaw: string | null; baseRaw: string | null; deleteAt: number }> {
      const both = await watcher?.waitForBothLocks(20_000)
      if (!both) throw new Error('[h-queue-lock] can-red 等不到 global.lock + install.lock 同时出现')
      const globalRaw = await readMaybe(paths.lockFile)
      const baseRaw = await readMaybe(paths.baseLockFile)
      await run.raw('can-red-locks-before-delete', {
        at: both.at,
        globalLockPath: paths.lockFile,
        baseLockPath: paths.baseLockFile,
        globalRaw,
        baseRaw,
        globalOwnerHash: globalRaw ? hash8Of(JSON.parse(globalRaw) as Record<string, unknown>) : null,
      })
      const queueRawBefore = await readMaybe(paths.queueFile)
      const deleteAt = Date.now()
      await unlink(paths.lockFile).catch(() => undefined)
      await unlink(paths.baseLockFile).catch(() => undefined)
      // 只删两把锁还不够：queue.json 的 owner/占位还给第二入口一道公平门。这里把队列也置空，
      // 模拟「锁与队列状态一起丢失」——否则测到的是队列门的拒绝，而不是锁互斥被破坏。
      const emptyQueue = JSON.stringify({ version: 1, owner: null, waiting: [] }, null, 2) + '\n'
      await writeFile(paths.queueFile, emptyQueue)
      await run.raw('can-red-locks-deleted', {
        deleteAt,
        deleted: [paths.lockFile, paths.baseLockFile],
        globalRawBeforeDelete: globalRaw,
        baseRawBeforeDelete: baseRaw,
        queueRawBefore,
        queueRawAfter: emptyQueue,
        why: 'can-red 注入：入口 1 持锁安装中，删除 global.lock + install.lock 并把 queue.json 置空（锁与队列状态一起丢失），看第二入口是否越过互斥（预期红）',
      })
      return { globalRaw, baseRaw, deleteAt }
    }

    // ---- 7. 账目/磁盘/锁时间线收尾断言（并发类两个 mode 与 stale 共用一部分） ----
    async function captureRuntimeEvidence(label: string): Promise<RawLogRow[]> {
      watcher?.stop()
      await closeHosts()
      const captured = await captureLogFiles(run.recorder, homeDir)
      await run.raw('logs-' + label, {
        files: captured.snapshot.files,
        unparsedLines: captured.snapshot.unparsedLines,
        truncations: captured.truncations,
      })
      if (watcher) {
        await run.raw('lock-queue-timeline', {
          pollIntervalMs: LOCK_POLL_MS,
          samples: watcher.samples,
          lockIds: watcher.lockIds(),
          lockIntervals: watcher.lockIntervals(),
          finalQueueRaw: await readMaybe(paths.queueFile),
          finalLockRaw: await readMaybe(paths.lockFile),
        })
      }
      return readRawLogRows(homeDir)
    }

    function rowPhases(rows: RawLogRow[]): Record<string, number> {
      const counts: Record<string, number> = {}
      for (const row of rows) {
        if (row.event !== 'update.queue.transition') continue
        const phase = strOf(row.fields.phase) ?? 'unknown'
        counts[phase] = (counts[phase] ?? 0) + 1
      }
      return counts
    }

    function anomalyCounts(rows: RawLogRow[]): Record<string, number> {
      const counts: Record<string, number> = {}
      for (const row of rows) {
        if (row.event !== 'update.lock.anomaly') continue
        const kind = strOf(row.fields.kind) ?? 'unknown'
        counts[kind] = (counts[kind] ?? 0) + 1
      }
      return counts
    }

    async function assertDiskAndLedger(rows: RawLogRow[], winnerRequestId: string | null, label: string): Promise<void> {
      const manifest = await readProfileManifest(profileDir).catch(() => null)
      const dependencyVersion = manifest?.dependencies?.[packageName] ?? null
      const diskVersion = await installedFixtureVersion({ homeDir, profileName: PROFILE_NAME, packageName })
      const bundles = manifest?.dsh?.profile?.bundles ?? []
      await run.raw('disk-after-' + label, {
        profileDir,
        manifest,
        dependencyVersion,
        diskVersion,
        bundles,
        packageJsonParsed: manifest !== null,
      })
      run.record({
        step: 'profile 未损坏（' + label + '）',
        what: '更新后 profile 的 package.json 可解析、dependencies 与 node_modules 磁盘版本都是 ' + variantVersion + '、bundles 仍含该包（无半写/无双装）',
        expected: 'dependencies=' + variantVersion + '；磁盘版本=' + variantVersion + '；bundles 含 ' + packageName,
        actual:
          'dependencies=' +
          String(dependencyVersion) +
          '；磁盘版本=' +
          String(diskVersion) +
          '；bundles=[' +
          bundles.join(', ') +
          ']；package.json 可解析=' +
          String(manifest !== null),
        verdict:
          dependencyVersion === variantVersion && diskVersion === variantVersion && bundles.indexOf(packageName) >= 0 ? 'pass' : 'fail',
      })

      const ledger = await readLedgerStates(homeDir)
      await run.raw('ledger-states', { files: ledger })
      const targetStates = ledger.filter((item) => strOf(item.state.targetVersion) === variantVersion)
      const okStates = targetStates.filter((item) => {
        const state = strOf(item.state.state)
        return state === 'completed' || state === 'restart-required'
      })
      const winnerMatches = winnerRequestId === null ? true : okStates.every((item) => strOf(item.state.requestId) === winnerRequestId)
      run.record({
        step: '台账恰一条成功终态（' + label + '）',
        what: '每个 profile 一份 update 台账（<home>/updates/<pluginId>/<shortHash(profileDir)>/state.json）：恰一条 targetVersion=' + variantVersion + ' 的成功终态，无重复成功、无丢单',
        expected: 'target 台账=1 条；state ∈ {completed, restart-required}；requestId=' + String(winnerRequestId),
        actual:
          'target 台账=' +
          String(targetStates.length) +
          '；成功终态=' +
          String(okStates.length) +
          '；requestIds=' +
          JSON.stringify(okStates.map((item) => strOf(item.state.requestId))) +
          '；全部台账=' +
          JSON.stringify(ledger.map((item) => ({ file: item.file, state: item.state.state, target: item.state.targetVersion }))),
        verdict: targetStates.length === 1 && okStates.length === 1 && winnerMatches ? 'pass' : 'fail',
      })
    }

    async function assertCleanup(): Promise<void> {
      const processes = started.map((entry) => ({
        label: 'cli-host-' + entry.label,
        pid: entry.pid,
        aliveAfterStop: entry.pid !== null && isProcessAlive(entry.pid),
      }))
      const ports: { label: string; port: number; free: boolean }[] = []
      for (const entry of started) {
        ports.push({ label: 'cli-host-' + entry.label + '-port', port: entry.port, free: await isPortFree(entry.port) })
      }
      await run.raw('cleanup-facts', { processes, ports })
      run.record({
        step: '收尾（无宿主残留、端口释放）',
        what: '两个入口宿主（以及重启校验宿主）都已停止，进程不存在、端口已释放',
        expected: '所有宿主 pid 不再存活；所有宿主端口空闲',
        actual: '进程=' + JSON.stringify(processes) + '；端口=' + JSON.stringify(ports),
        verdict: processes.every((item) => !item.aliveAfterStop) && ports.every((item) => item.free) ? 'pass' : 'fail',
      })
    }

    // ================= 并发抢锁（simultaneous / lock-window） =================
    async function runConcurrentFlow(lockWindow: boolean): Promise<void> {
      const hostA = await startHost('a')
      const hostB = await startHost('b')
      await run.raw('two-hosts-same-profile', {
        hostA: { url: hostA.url, port: hostA.port, pid: hostA.pid(), bootMs: hostA.bootMs },
        hostB: { url: hostB.url, port: hostB.port, pid: hostB.pid(), bootMs: hostB.bootMs },
        homeDir,
        profileDir,
        queueDirectory: paths.directory,
        globalLockFile: paths.lockFile,
        queueFile: paths.queueFile,
      })
      run.record({
        step: '两个真机入口（两个独立宿主进程）同 profile',
        what: '两个独立的 DSH web 宿主进程用同一 USERPROFILE/.dsh 与同一 profile 名启动，各自暴露 HTTP 电话入口；它们解析到同一 profileDir，因此抢同一把 global.lock、写同一份 queue.json',
        expected: '两代 pid/port 不同；homeDir/profileDir/queueDirectory 相同',
        actual:
          'pidA=' +
          String(hostA.pid()) +
          '；portA=' +
          String(hostA.port) +
          '；pidB=' +
          String(hostB.pid()) +
          '；portB=' +
          String(hostB.port) +
          '；queueDir=' +
          paths.directory,
        verdict:
          hostA.pid() !== hostB.pid() && hostA.port !== hostB.port && profileDir === join(homeDir, 'profiles', PROFILE_NAME) ? 'pass' : 'fail',
      })

      const checkA = await checkOn(hostA, 'a')
      const checkB = await checkOn(hostB, 'b')
      const requestIdA = 'h1-a-' + Date.now()
      const requestIdB = 'h1-b-' + Date.now()

      watcher = new QueueLockWatcher(paths)
      watcher.start()
      let outcomeA: PhoneOutcome
      let outcomeB: PhoneOutcome
      if (lockWindow) {
        outcomeA = await fireInstall(hostA, 'a', checkA.checkId, requestIdA)
        const present = await watcher.waitForLockPresent(20_000)
        await run.raw('lock-first-present', present)
        if (!present) throw new Error('[h-queue-lock] 入口 1 受理后等不到 global.lock（安装可能已结束或没抢到锁）')
        outcomeB = await fireInstall(hostB, 'b', checkB.checkId, requestIdB)
      } else {
        // 不 await 完成：两个 postPhone 在同一 tick 内发出（各自回包很快，安装是后台作业）。
        const promiseA = fireInstall(hostA, 'a', checkA.checkId, requestIdA)
        const promiseB = fireInstall(hostB, 'b', checkB.checkId, requestIdB)
        const both = await Promise.all([promiseA, promiseB])
        outcomeA = both[0]
        outcomeB = both[1]
      }

      const entries = [
        { label: 'a', host: hostA, outcome: outcomeA, requestId: requestIdA, checkId: checkA.checkId },
        { label: 'b', host: hostB, outcome: outcomeB, requestId: requestIdB, checkId: checkB.checkId },
      ]
      const admitted = entries.filter((entry) => acceptedOf(entry.outcome))
      await run.raw('install-admission', {
        a: { requestId: requestIdA, ok: outcomeA.ok, error: outcomeA.error, job: outcomeA.snapshot?.job ?? null, status: outcomeA.status, durationMs: outcomeA.durationMs },
        b: { requestId: requestIdB, ok: outcomeB.ok, error: outcomeB.error, job: outcomeB.snapshot?.job ?? null, status: outcomeB.status, durationMs: outcomeB.durationMs },
        admitted: admitted.map((entry) => entry.label),
      })
      run.record({
        step: '两入口同时抢锁：恰一个受理',
        what:
          (lockWindow ? '入口 1 先受理、轮询到 global.lock 出现（持锁窗内）后入口 2 发同一 target 同一版本安装' : '两个入口几乎同时（不 await 完成）发同一 target 同一版本安装') +
          '；全局锁 + queue 公平门应当只放一个进来',
        expected: '恰一个入口 ok=true 且 job.state ∈ {installing, verifying}；另一个 ok=false（稳定拒绝）',
        actual: describeOutcome('A', outcomeA) + '；' + describeOutcome('B', outcomeB),
        verdict: admitted.length === 1 ? 'pass' : 'fail',
      })
      const winner = admitted[0] ?? entries[0]
      const loser = entries.filter((entry) => entry !== winner)[0] ?? null

      const terminal = await waitForTerminal(winner.host, route, statusPhone, TERMINAL_TIMEOUT_MS)
      await run.raw('phone-status-terminal', {
        winner: winner.label,
        polls: terminal.polls,
        elapsedMs: terminal.elapsedMs,
        timedOut: terminal.timedOut,
        status: terminal.outcome?.status ?? null,
        body: terminal.outcome?.body ?? null,
      })
      run.record({
        step: '赢家安装到终态',
        what: '轮询赢家宿主的 updateStatus，直到作业进入终态（进程未重启前应为 restart-required）',
        expected: 'job.state ∈ {restart-required, completed}',
        actual: 'job.state=' + String(jobStateOf(terminal.outcome ?? winner.outcome)) + '；polls=' + String(terminal.polls) + '；timedOut=' + String(terminal.timedOut),
        verdict: terminalJobState(jobStateOf(terminal.outcome ?? winner.outcome)) ? 'pass' : 'fail',
      })

      let rows = await waitForExecRows(homeDir, 1, EXEC_WAIT_TIMEOUT_MS)
      // 等锁被释放，让时间线有「末次 absent」样本（否则区间没有 to）。
      const absentAt = await watcher.waitForLockAbsent(10_000)
      await run.raw('lock-absent-after-install', { absentAt })

      // 赢家终态后，失败方立刻用同一意图重试一次（已装待重启期间应被稳定拒绝，不得产生第二次安装）。
      let retryOutcome: PhoneOutcome | null = null
      if (loser) {
        retryOutcome = await callPhone(loser.host, route, installPhone, {
          checkId: loser.checkId,
          requestId: loser.requestId,
          from: 'panel',
        })
        await run.raw('phone-retry-before-restart', {
          label: loser.label,
          requestId: loser.requestId,
          status: retryOutcome.status,
          durationMs: retryOutcome.durationMs,
          body: retryOutcome.body,
        })
      }
      await sleep(700)
      const rowsAfterRetry = await readRawLogRows(homeDir)
      run.record({
        step: '失败方重试（已装待重启）：诚实拒绝且不再装',
        what: '同一 checkId/requestId 的失败意图在赢家装完（restart-required，进程未重启）后重试一次；作业状态门/锁门应稳定拒绝，且不产生第二次安装',
        expected: 'ok=false；error ∈ ["update-busy","check-expired"]（稳定拒绝，不重装）；exec 行数保持 1；台账仍 1 条',
        actual:
          (retryOutcome ? describeOutcome('retry', retryOutcome) : '没有失败方') +
          '；exec 行数=' +
          String(execWindowsOf(rowsAfterRetry).length) +
          '；台账文件数=' +
          String((await readLedgerStates(homeDir)).length),
        verdict:
          retryOutcome !== null &&
          !retryOutcome.ok &&
          retryOutcome.error !== null &&
          ['update-busy', 'check-expired'].indexOf(retryOutcome.error) >= 0 &&
          execWindowsOf(rowsAfterRetry).length === 1
            ? 'pass'
            : 'fail',
      })

      await closeHosts()
      await run.raw('hosts-stopped-before-restart', { hosts: started.map((entry) => ({ label: entry.label, pid: entry.pid, port: entry.port })) })

      // 重启一个干净宿主：运行版应已是 0.0.2，fresh check 报「已是最新」，强行再装应被诚实拒绝且不产生新安装。
      const hostC = await startHost('c')
      const statusC = await callPhone(hostC, route, statusPhone, {})
      const buildTagC = await callPhone(hostC, route, buildTagPhone, {})
      await run.raw('phone-status-after-restart', { status: statusC.status, body: statusC.body })
      await run.raw('phone-build-tag-after-restart', { status: buildTagC.status, body: buildTagC.body, reply: buildTagC.replyValue })
      const buildTagValue = strOf(buildTagC.fields.buildTag) ?? strOf(buildTagC.replyValue)
      run.record({
        step: '重启后：profile 能正常 boot 且运行版已是变体',
        what: '装完后停掉两个入口宿主，再用同 home/profile 起一个干净宿主：能正常启动、运行版=' + variantVersion + '、夹具 buildTag 自证是变体构建（证明 profile 没被并发写坏）',
        expected: 'runningVersion=' + variantVersion + '；buildTag=host v' + variantVersion,
        actual: 'runningVersion=' + String(statusC.snapshot?.runningVersion) + '；buildTag=' + String(buildTagValue),
        verdict: statusC.snapshot?.runningVersion === variantVersion && buildTagValue === 'host v' + variantVersion ? 'pass' : 'fail',
      })
      const checkC = await callPhone(hostC, route, checkPhone, { trigger: 'user' })
      await run.raw('phone-check-after-restart', { status: checkC.status, body: checkC.body })
      run.record({
        step: '重启后 fresh check：已是最新（失败方收敛）',
        what: '重启后的 fresh updateCheck 应报已装=' + variantVersion + '、最新=' + variantVersion + '、canInstall=false',
        expected: 'canInstall=false；installedVersion=' + variantVersion + '；latestVersion=' + variantVersion,
        actual:
          'canInstall=' +
          String(checkC.snapshot?.canInstall) +
          '；installedVersion=' +
          String(checkC.snapshot?.installedVersion) +
          '；latestVersion=' +
          String(checkC.snapshot?.latestVersion),
        verdict:
          checkC.snapshot?.canInstall === false &&
          checkC.snapshot?.installedVersion === variantVersion &&
          checkC.snapshot?.latestVersion === variantVersion
            ? 'pass'
            : 'fail',
      })
      const checkIdC = (() => {
        const receipt = checkC.fields.receipt !== null && typeof checkC.fields.receipt === 'object' ? (checkC.fields.receipt as Record<string, unknown>) : null
        return receipt ? (strOf(receipt.checkId) ?? '') : ''
      })()
      const forcedRequestId = 'h1-retry-restart-' + Date.now()
      const forcedInstall = await callPhone(hostC, route, installPhone, { checkId: checkIdC, requestId: forcedRequestId, from: 'panel' })
      await run.raw('phone-install-after-restart', {
        checkId: checkIdC,
        requestId: forcedRequestId,
        status: forcedInstall.status,
        durationMs: forcedInstall.durationMs,
        body: forcedInstall.body,
      })
      await sleep(700)
      const rowsAfterForced = await readRawLogRows(homeDir)
      const forcedErrorCodes = ['installation-changed', 'check-expired', 'update-busy']
      run.record({
        step: '重启后强行再装：诚实拒绝且不产生新安装',
        what: '已是最新（canInstall=false、fresh check 没有候选凭证）时再发一次 updateInstall，产品应诚实拒绝（check-expired / installation-changed / update-busy 之一），不得再起安装',
        expected: 'ok=false；error ∈ ' + JSON.stringify(forcedErrorCodes) + '；exec 行数保持 1',
        actual:
          describeOutcome('forced', forcedInstall) +
          '；exec 行数=' +
          String(execWindowsOf(rowsAfterForced).length) +
          '；台账文件数=' +
          String((await readLedgerStates(homeDir)).length),
        verdict:
          !forcedInstall.ok &&
          forcedInstall.error !== null &&
          forcedErrorCodes.indexOf(forcedInstall.error) >= 0 &&
          execWindowsOf(rowsAfterForced).length === 1
            ? 'pass'
            : 'fail',
      })

      rows = await captureRuntimeEvidence('after-install')
      const windows = execWindowsOf(rows)
      const exec = windows[0]
      const execOk = exec !== undefined && exec.route === 'cli-process' && exec.ok === true && exec.exitCode === 0 && exec.durationMs > 0
      run.raw('exec-windows', { windows, count: windows.length })
      run.record({
        step: '恰一个真实安装 exec（route=cli-process）',
        what: '两个入口同时更新同一 target，日志里应只有一条 update.install.exec（第二个入口没有起 CLI 安装）',
        expected: 'update.install.exec 行数=1；route=cli-process；ok=true；exitCode=0；durationMs>0',
        actual: 'exec 行数=' + String(windows.length) + '；' + (exec ? JSON.stringify(exec) : '没有 exec'),
        verdict: windows.length === 1 && execOk ? 'pass' : 'fail',
      })

      const intervals = watcher?.lockIntervals() ?? []
      const lockIds = watcher?.lockIds() ?? []
      const interval = intervals[0]
      const contained = exec !== undefined && interval !== undefined && exec.start >= interval.from - WINDOW_TOLERANCE_MS && (interval.to === null ? true : exec.end <= interval.to + WINDOW_TOLERANCE_MS)
      await run.raw('lock-window-containment', {
        lockIds,
        intervals,
        execWindow: exec ?? null,
        toleranceMs: WINDOW_TOLERANCE_MS,
        note: 'interval 首末样本来自 ' + String(LOCK_POLL_MS) + 'ms 轮询，故给 ±' + String(WINDOW_TOLERANCE_MS) + 'ms 容忍',
      })
      run.record({
        step: '安装窗口落在单一全局锁持有区间内',
        what: '唯一一次真实安装的 exec 窗口 [ts-durationMs, ts] 完整落在一次 global.lock 持有区间内（任一时刻至多一个安装；两安装窗口不重叠）',
        expected: '锁 id 数=1；持有区间数=1；exec 窗口被该区间包含（±' + String(WINDOW_TOLERANCE_MS) + 'ms 轮询误差）',
        actual: '锁 id=' + JSON.stringify(lockIds) + '；区间=' + JSON.stringify(intervals) + '；exec 窗口=' + (exec ? JSON.stringify(exec) : '无'),
        verdict: lockIds.length === 1 && intervals.length === 1 && contained ? 'pass' : 'fail',
      })

      const phases = rowPhases(rows)
      await run.raw('queue-transitions', { phases })
      run.record({
        step: '队列跃迁：有排入/有运行/有完成、无回收',
        what: 'queue.json 的跃迁事件如实记录排队/运行/完成；并发格不应出现 reclaimed（没有陈旧锁）',
        expected: 'queued≥1；running≥1；done≥1；reclaimed=0',
        actual: JSON.stringify(phases),
        verdict: (phases.queued ?? 0) >= 1 && (phases.running ?? 0) >= 1 && (phases.done ?? 0) >= 1 && (phases.reclaimed ?? 0) === 0 ? 'pass' : 'fail',
      })

      const anomalies = anomalyCounts(rows)
      const gateFails = rows.filter(
        (row) => row.event === 'update.install.fail' && strOf(row.fields.stage) === 'gate' && strOf(row.fields.reason) === 'gate-refused',
      ).length
      const callFails = rows.filter((row) => row.event === 'host.call.fail').length
      const refusalCodes = ['update-busy', 'recovery-required', 'installation-changed', 'check-expired']
      const loserError = loser ? loser.outcome.error : null
      const attributable = (anomalies['busy-owner'] ?? 0) >= 1 || gateFails >= 1 || (loserError !== null && refusalCodes.indexOf(loserError) >= 0)
      await run.raw('refusal-evidence', {
        anomalies,
        gateFails,
        callFails,
        loser: loser ? { label: loser.label, error: loserError, job: loser.outcome.snapshot?.job ?? null } : null,
        refusalCodes,
      })
      run.record({
        step: '第二入口被稳定拒绝且可归因',
        what: '未受理的入口回包 ok=false，且拒绝原因能从日志/回包归因（全局锁 busy-owner 异常、queue 公平门 gate-refused、或回包里的拒绝码之一）',
        expected: 'ok=false；lock.anomaly busy-owner ≥1 或 update.install.fail(gate/gate-refused) ≥1 或 拒绝码 ∈ ' + JSON.stringify(refusalCodes),
        actual:
          'loser=' +
          String(loser?.label) +
          '；error=' +
          String(loserError) +
          '；anomalies=' +
          JSON.stringify(anomalies) +
          '；gateRefused=' +
          String(gateFails),
        verdict: loser !== null && !loser.outcome.ok && attributable ? 'pass' : 'fail',
      })

      await assertDiskAndLedger(rows, winner.requestId, 'after-install')
      {
        const finalQueueRaw = await readMaybe(paths.queueFile)
        const finalQueue = parseJsonMaybe(finalQueueRaw)
        const finalOwner = finalQueue !== null && finalQueue.owner !== null && typeof finalQueue.owner === 'object' ? finalQueue.owner : null
        const finalWaiting = finalQueue !== null && Array.isArray(finalQueue.waiting) ? (finalQueue.waiting as unknown[]) : []
        await run.raw('queue-final', { raw: finalQueueRaw, owner: finalOwner, waitingCount: finalWaiting.length })
        run.record({
          step: '队列收尾：owner=null、无残留占位',
          what: '赢家完成释放 owner，失败方重试（check-expired）时撤销了自己的 waiting 占位；收尾 queue.json 应只剩空队列',
          expected: 'owner=null；waiting=[]',
          actual: 'owner=' + JSON.stringify(finalOwner) + '；waiting 条数=' + String(finalWaiting.length),
          verdict: finalOwner === null && finalWaiting.length === 0 ? 'pass' : 'fail',
        })
      }
      await assertCleanup()
    }

    // ================= 陈旧锁回收 =================
    async function runStaleFlow(): Promise<void> {
      const staleId = 'selftest-stale-' + run.layout.stamp
      const stalePayload = {
        id: staleId,
        pluginId,
        pid: DEAD_PID,
        startedAt: Date.now() - STALE_LOCK_AGE_MS,
      }
      await ensureDir(paths.directory)
      const staleRaw = JSON.stringify(stalePayload)
      await writeFile(paths.lockFile, staleRaw)
      await run.raw('stale-lock-precreated', {
        path: paths.lockFile,
        raw: staleRaw,
        payload: stalePayload,
        ageMs: STALE_LOCK_AGE_MS,
        deadPid: DEAD_PID,
        deadPidAlive: isProcessAlive(DEAD_PID),
        installTimeoutMs: STALE_INSTALL_TIMEOUT_MS,
      })
      run.record({
        step: '预写陈旧 global.lock',
        what: '按产品 payload 形状 {id,pluginId,pid,startedAt} 预写一把锁：pid 用必然不存在的 ' + String(DEAD_PID) + '、startedAt 取 60s 前；宿主安装预算压到 4s',
        expected: '锁文件存在且内容是合法 JSON；pid 不存活；age≈60000ms > 安装预算 4000ms',
        actual: 'pidAlive=' + String(isProcessAlive(DEAD_PID)) + '；inspect=' + staleRaw,
        verdict: isProcessAlive(DEAD_PID) === false ? 'pass' : 'fail',
      })

      watcher = new QueueLockWatcher(paths)
      watcher.start()
      const host = await startHost('a')
      const check = await checkOn(host, 'a')
      const requestId = 'h2-stale-' + Date.now()
      const install = await fireInstall(host, 'a', check.checkId, requestId)
      run.record({
        step: '陈旧锁格安装受理',
        what: '带候选凭证的 updateInstall 应受理（先回收陈旧锁再安装）',
        expected: 'ok=true；job.state ∈ {installing, verifying}',
        actual: describeOutcome('install', install),
        verdict: acceptedOf(install) ? 'pass' : 'fail',
      })
      const terminal = await waitForTerminal(host, route, statusPhone, TERMINAL_TIMEOUT_MS)
      await run.raw('phone-status-terminal', {
        polls: terminal.polls,
        elapsedMs: terminal.elapsedMs,
        timedOut: terminal.timedOut,
        status: terminal.outcome?.status ?? null,
        body: terminal.outcome?.body ?? null,
      })
      run.record({
        step: '陈旧锁回收后安装到终态',
        what: '回收陈旧锁后继续安装，作业应进入成功终态（restart-required，进程未重启）',
        expected: 'job.state ∈ {restart-required, completed}',
        actual: 'job.state=' + String(jobStateOf(terminal.outcome)) + '；timedOut=' + String(terminal.timedOut),
        verdict: terminalJobState(jobStateOf(terminal.outcome)) ? 'pass' : 'fail',
      })
      await waitForExecRows(homeDir, 1, EXEC_WAIT_TIMEOUT_MS)
      const absentAt = await watcher.waitForLockAbsent(10_000)
      await run.raw('lock-absent-after-install', { absentAt })
      const rows = await captureRuntimeEvidence('after-stale-reclaim')
      const windows = execWindowsOf(rows)
      const exec = windows[0]
      run.raw('exec-windows', { windows, count: windows.length })

      const expectedOwnerHash = hash8Of(
        ['pluginId', 'id', 'pid', 'startedAt'].map((key) => key + ':' + String((stalePayload as Record<string, unknown>)[key])).join('|'),
      )
      const staleAnomalies = rows.filter((row) => row.event === 'update.lock.anomaly' && strOf(row.fields.kind) === 'stale-owner')
      const busyAnomalies = rows.filter((row) => row.event === 'update.lock.anomaly' && strOf(row.fields.kind) === 'busy-owner')
      const reclaimedRows = rows.filter((row) => row.event === 'update.queue.transition' && strOf(row.fields.phase) === 'reclaimed')
      await run.raw('stale-reclaim-events', {
        staleOwner: staleAnomalies.map((row) => ({ fields: row.fields, ts: row.ts, source: row.source, line: row.line })),
        busyOwner: busyAnomalies.map((row) => ({ fields: row.fields, ts: row.ts, source: row.source, line: row.line })),
        reclaimed: reclaimedRows.map((row) => ({ fields: row.fields, ts: row.ts, source: row.source, line: row.line })),
        expectedOwnerHash,
        expectedHolderHash: hash8Of(pluginId),
      })
      const staleFields = staleAnomalies[0]?.fields ?? null
      const staleAge = staleFields ? numOf(staleFields.ageMs) : null
      const staleOwnerHash = staleFields ? strOf(staleFields.ownerHash) : null
      run.record({
        step: '陈旧锁判定：stale-owner 且 ownerHash/age 对得上',
        what: '抢锁路径二次核对后判陈旧：应恰 1 条 lock.anomaly(kind=stale-owner)，ageMs≈60000、ownerHash 为预写锁 payload 的 hash8；不应出现 busy-owner（把陈旧锁误判为新鲜）',
        expected: 'stale-owner=1；ageMs≥59000；ownerHash=' + expectedOwnerHash + '；busy-owner=0',
        actual:
          'stale-owner=' +
          String(staleAnomalies.length) +
          '；ageMs=' +
          String(staleAge) +
          '；ownerHash=' +
          String(staleOwnerHash) +
          '；busy-owner=' +
          String(busyAnomalies.length),
        verdict:
          staleAnomalies.length === 1 &&
          staleAge !== null &&
          staleAge >= STALE_LOCK_AGE_MS - 1000 &&
          staleOwnerHash === expectedOwnerHash &&
          busyAnomalies.length === 0
            ? 'pass'
            : 'fail',
      })
      const reclaimedFields = reclaimedRows[0]?.fields ?? null
      const reclaimedHolder = reclaimedFields ? strOf(reclaimedFields.holderHash) : null
      run.record({
        step: '队列跃迁 reclaimed 且回收后继续安装',
        what: '回收成功应记 1 条 update.queue.transition(phase=reclaimed)，holderHash=hash8(pluginId)；随后安装照常完成',
        expected: 'reclaimed=1；holderHash=' + hash8Of(pluginId) + '；exec=1 且 ok/exit0',
        actual:
          'reclaimed=' +
          String(reclaimedRows.length) +
          '；holderHash=' +
          String(reclaimedHolder) +
          '；exec=' +
          String(windows.length) +
          '；execOk=' +
          String(exec?.ok) +
          '；exit=' +
          String(exec?.exitCode),
        verdict:
          reclaimedRows.length === 1 &&
          reclaimedHolder === hash8Of(pluginId) &&
          windows.length === 1 &&
          exec?.ok === true &&
          exec?.exitCode === 0
            ? 'pass'
            : 'fail',
      })
      const lockIds = watcher?.lockIds() ?? []
      const intervals = watcher?.lockIntervals() ?? []
      const lastSample = watcher?.samples[watcher.samples.length - 1] ?? null
      run.record({
        step: '锁时间线：旧 id 被换掉、最终释放',
        what: '预写的陈旧锁 id 与安装期间的新锁 id 都应在时间线里出现（旧 id 不会被旧 id 释放，新锁覆盖后最终 absent）',
        expected: '锁 id 数=2（' + staleId + ' + 新 id）；末次采样 lockPresent=false',
        actual: '锁 id=' + JSON.stringify(lockIds) + '；区间数=' + String(intervals.length) + '；末次 lockPresent=' + String(lastSample?.lockPresent),
        verdict: lockIds.length === 2 && lockIds.indexOf(staleId) >= 0 && lastSample !== null && lastSample.lockPresent === false ? 'pass' : 'fail',
      })

      const phases = rowPhases(rows)
      await run.raw('queue-transitions', { phases })
      run.record({
        step: '队列跃迁完整（queued/reclaimed/running/done）',
        what: '陈旧锁格应看到排队、回收、运行、完成四类跃迁，且 reclaimed 恰好一条',
        expected: 'queued≥1；reclaimed=1；running≥1；done≥1',
        actual: JSON.stringify(phases),
        verdict: (phases.queued ?? 0) >= 1 && (phases.reclaimed ?? 0) === 1 && (phases.running ?? 0) >= 1 && (phases.done ?? 0) >= 1 ? 'pass' : 'fail',
      })
      await assertDiskAndLedger(rows, requestId, 'after-stale-reclaim')
      {
        const finalQueueRaw = await readMaybe(paths.queueFile)
        const finalQueue = parseJsonMaybe(finalQueueRaw)
        const finalOwner = finalQueue !== null && finalQueue.owner !== null && typeof finalQueue.owner === 'object' ? finalQueue.owner : null
        const finalWaiting = finalQueue !== null && Array.isArray(finalQueue.waiting) ? (finalQueue.waiting as unknown[]) : []
        await run.raw('queue-final', { raw: finalQueueRaw, owner: finalOwner, waitingCount: finalWaiting.length })
        run.record({
          step: '队列收尾：owner=null、无残留占位',
          what: '单意图陈旧锁格：唯一意图被 owner 消费，完成后释放 owner；收尾 queue.json 应为空队列',
          expected: 'owner=null；waiting=[]',
          actual: 'owner=' + JSON.stringify(finalOwner) + '；waiting 条数=' + String(finalWaiting.length),
          verdict: finalOwner === null && finalWaiting.length === 0 ? 'pass' : 'fail',
        })
      }
      await assertCleanup()
    }

    // ================= can-red：删锁后第二入口是否越过锁（预期红） =================
    async function runCanRedFlow(): Promise<void> {
      const hostA = await startHost('a')
      const hostB = await startHost('b')
      await run.raw('two-hosts-same-profile', {
        hostA: { url: hostA.url, port: hostA.port, pid: hostA.pid(), bootMs: hostA.bootMs },
        hostB: { url: hostB.url, port: hostB.port, pid: hostB.pid(), bootMs: hostB.bootMs },
        homeDir,
        profileDir,
        queueDirectory: paths.directory,
      })
      const checkA = await checkOn(hostA, 'a')
      const checkB = await checkOn(hostB, 'b')
      const requestIdA = 'h1-red-a-' + Date.now()
      const requestIdB = 'h1-red-b-' + Date.now()

      watcher = new QueueLockWatcher(paths)
      watcher.start()
      const outcomeA = await fireInstall(hostA, 'a', checkA.checkId, requestIdA)
      const deleted = await deleteLocksForCanRed()
      const outcomeB = await fireInstall(hostB, 'b', checkB.checkId, requestIdB)
      const admittedA = acceptedOf(outcomeA)
      const admittedB = acceptedOf(outcomeB)
      await run.raw('can-red-admission', {
        deletedAt: deleted.deleteAt,
        a: { requestId: requestIdA, ok: outcomeA.ok, error: outcomeA.error, job: outcomeA.snapshot?.job ?? null },
        b: { requestId: requestIdB, ok: outcomeB.ok, error: outcomeB.error, job: outcomeB.snapshot?.job ?? null },
        admittedA,
        admittedB,
      })

      const waits: Promise<unknown>[] = [waitForTerminal(hostA, route, statusPhone, TERMINAL_TIMEOUT_MS)]
      if (admittedB) waits.push(waitForTerminal(hostB, route, statusPhone, TERMINAL_TIMEOUT_MS))
      const terminalResults = (await Promise.all(waits)) as { outcome: PhoneOutcome | null; timedOut: boolean }[]
      await run.raw('can-red-terminals', {
        a: terminalResults[0] ? { state: jobStateOf(terminalResults[0].outcome), timedOut: terminalResults[0].timedOut } : null,
        b: terminalResults[1] ? { state: jobStateOf(terminalResults[1].outcome), timedOut: terminalResults[1].timedOut } : null,
      })
      await waitForExecRows(homeDir, admittedB ? 2 : 1, EXEC_WAIT_TIMEOUT_MS)
      await sleep(500)
      const rows = await captureRuntimeEvidence('after-can-red')
      const windows = execWindowsOf(rows)
      let overlap = false
      for (let i = 0; i < windows.length; i += 1) {
        for (let j = i + 1; j < windows.length; j += 1) {
          if (windowsOverlap(windows[i], windows[j])) overlap = true
        }
      }
      await run.raw('can-red-exec-windows', { windows, count: windows.length, overlap })
      const red = admittedB || (windows.length >= 2 && overlap)
      run.record({
        step: 'can-red：删全局锁+自家锁后第二入口是否越过锁（预期红）',
        what: '入口 1 受理并持有 global.lock + install.lock 时，harness 删除两把锁并把 queue.json 置空（模拟锁与队列状态一起丢失），立刻让入口 2 对同一 target 发安装：若互斥依赖这些持久状态，第二入口会越过锁被受理或两 exec 窗口重叠（预期红）',
        expected: 'can-red 预期红：入口 2 被受理（ok=true/job installing）或 update.install.exec ≥2 且窗口重叠',
        actual:
          'admittedB=' +
          String(admittedB) +
          '；exec 行数=' +
          String(windows.length) +
          '；重叠=' +
          String(overlap) +
          '；A=' +
          describeOutcome('A', outcomeA) +
          '；B=' +
          describeOutcome('B', outcomeB),
        verdict: red ? 'fail' : 'unknown',
        note: red
          ? 'can-red 注入生效：删除 global.lock + install.lock 后第二入口越过锁（这是本票要能红的那条断言）'
          : 'can-red 未复现红：删锁后第二入口仍被拒（锁之外还有作业状态/队列守卫），如实记 unknown',
      })
      run.addNote(red ? 'can-red：删除全局锁+自家锁后第二安装越过锁（预期红，run 判 fail/exit1）。' : 'can-red：删锁后仍被拒，未复现红。')
      const ledger = await readLedgerStates(homeDir)
      await run.raw('can-red-disk-and-ledger', {
        ledger: ledger.map((item) => ({ file: item.file, state: item.state })),
        profileManifest: await readProfileManifest(profileDir).catch(() => null),
        lockIds: watcher?.lockIds() ?? [],
        finalQueueRaw: await readMaybe(paths.queueFile),
      })
      await assertCleanup()
    }

    // ---- 8. 按 mode 分派 ----
    if (mode === 'stale-reclaim') {
      await runStaleFlow()
    } else if (mode === 'can-red') {
      await runCanRedFlow()
    } else {
      await runConcurrentFlow(mode === 'concurrent-lock-window')
    }
    return await finish(run, options)
  } catch (error) {
    await run.raw('scenario-error', {
      message: messageOf(error),
      stack: error instanceof Error ? error.stack ?? null : null,
      mode,
    })
    run.record({
      step: '场景主流程',
      what: '场景执行过程中抛异常（异常本身也是证据，run 记 unknown）',
      expected: '无异常',
      actual: '异常：' + messageOf(error),
      verdict: 'unknown',
    })
    run.addNote('场景异常中断；已尽量关闭宿主并留证。')
    try {
      ;(watcher as QueueLockWatcher | null)?.stop()
    } catch {
      // 忽略
    }
    try {
      for (const entry of started) {
        if (entry.closed) continue
        entry.closed = true
        await entry.host.close().catch(() => undefined)
        run.registerProcess('cli-host-' + entry.label, entry.pid)
        await run.registerPort('cli-host-' + entry.label + '-port', entry.port)
      }
    } catch {
      // 收尾失败不覆盖原始异常
    }
    return await finish(run, options)
  }
}
