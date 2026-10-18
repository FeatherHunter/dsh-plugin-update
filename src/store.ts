/**
 * src/store.ts —— 更新任务的落盘与执行跑腿。
 *
 * 由 src/host/updateStore.js 改写拎入：只跑腿不决策。相对旧实现的增量（规格 #591）：
 * 1. 状态目录按插件标识派生（第 3 条）：join(家目录, 'updates', 插件标识, 使用范围短指纹），
 *    三文件名保持 state.json、install.lock、before.json 不变。
 * 2. 默认旧路径冻结（第 14 条）：插件标识取旧值 dsh-mattpocock-skills-deck 时路径与旧原文
 *    一字不差——下面的旧字面是永久冻结特例，注释永不删除（动默认即破冰）。
 * 3. 只读自己的新路径（第 7 条，2026-10-18 #203 修订）：不再回退读旧路径。旧路径的冻结字面
 *    恰好是默认标识自己的实时目录，别的插件回退读它只会读到**别家正在跑的任务**，heal 之后
 *    又写回自己目录（真机跨插件污染）。旧文件不动，清理另票再议。
 * 4. 三处注入默认现状（第 4 条）：目标包名、官方源、安装时限经零件注入，默认值等于现状。
 * 5. 安装执行日志带必填插件标识（第 8、13 条）：update.install.exec 加完标识后 5 键为基线。
 *
 * 安装执行按核心给的配方跑三条路由之一（第三方 Desktop 走桌面服务、官方桌面版交给宿主
 * 进程内的插件管理器、普通 DSH 自己起进程），
 * 本文件不按操作系统分支，也不拼 shell。决策顺序全在更新核心。测试一律用假零件，
 * 不真写盘真跑命令（经可选的文件读写函数注入，默认走真文件系统）。
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, link, open, readFile, rename, realpath, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { installRecipe, normalizeApprovedBuilds, shellSafeArg } from './commands.js'
import { BACKUP_FILE, DEFAULT_INSTALL_TIMEOUT_MS, LEGACY_PLUGIN_ID, LOCK_FILE, SKIPPED_FILE, STATE_FILE } from './config.js'
import { emptyBatchSession, normalizeBatchSession, type BatchSession } from './batch.js'
import { QUEUE_INTENT_TTL_MS, normalizeQueueState, type QueueOwner, type UpdateQueueState } from './queue.js'
import { hash8 } from './hash.js'
import { validReleaseVersion } from './service.js'
import { DETAIL_MAX_CHARS, MASKED_CREDENTIAL_NOTE, sanitizeDetail } from './redaction.js'
import { LOG_EVENT_INSTALL_EXEC } from './log-events.js'
import { attachInstallFail, normalizeCode, normalizeHostCode, readInstallFail } from './install-fail.js'
import type { InstallFailFacts } from './install-fail.js'
import type { EnvironmentKind, InstallRecipe, ReleaseChannel, UpdateJob, UpdateLogPort } from './ports.js'

// 永久冻结的旧字面（规格 #591 第 14 条）：默认旧路径原文加三固定名永久冻结，永不删除。
// 旧原文：join(家目录, 'updates', 'dsh-mattpocock-skills-deck', 短指纹(使用范围目录))。
const LEGACY_SEGMENT = 'updates'
const LEGACY_DIR_PLUGIN = LEGACY_PLUGIN_ID

const JOB_STATES = ['installing', 'verifying', 'restart-required', 'completed', 'failed', 'interrupted']
const SNAPSHOT_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']

function fail(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code })
}
function shortHash(text: string): string {
  try {
    return createHash('sha256').update(String(text)).digest('hex').slice(0, 24)
  } catch {
    return '00000000'
  }
}

/** 目录短指纹（#209）：与 `logDirHash` 同族（sha256 前 8 位十六进制），只做同一性聚合，不可逆。 */
function shortHash8(text: string): string {
  return shortHash(text).slice(0, 8)
}

/** 持有者指纹（#209）：从锁文件里记得下的稳定量算 8 位短哈希，绝不入原文（ADR-0006）。 */
function lockOwnerHash(owner: Record<string, unknown> | null | undefined): string | undefined {
  if (!owner) return undefined
  const parts: string[] = []
  for (const key of ['pluginId', 'id', 'pid', 'startedAt']) {
    const value = owner[key]
    if (typeof value === 'string' && value) parts.push(`${key}:${value}`)
    else if (typeof value === 'number' && Number.isFinite(value)) parts.push(`${key}:${value}`)
  }
  return parts.length > 0 ? hash8(parts.join('|')) : undefined
}

// ---- #124 日志接线：本文件负责的三个事件的落点辅助 ----
// 事件名单源本该是 src/log-events.ts，但那一行不在本票的写域内；这里按随包清单
// event-list.update.json 的名字逐字引用（字段白名单在唯一发射口校验，多一格整行会被丢掉）。
const LOG_EVENT_LOCK_ANOMALY = 'update.lock.anomaly'
const LOG_EVENT_STORE_FAIL = 'update.store.fail'
const LOG_EVENT_QUEUE_TRANSITION = 'update.queue.transition'
/** 锁异常 kind（清单口径逐字）：陈旧拥有者被回收 / 放锁失败 / 锁被新鲜持有者占着。
 *  `busy-timeout` 不在这里出现是有意的：本文件两条抢锁路径都是「看一眼，不陈旧就当场认输」，
 *  没有「等待/重试到超时才放弃」的路径，不为了凑齐词汇造一条。 */
const LOCK_ANOMALY_STALE_OWNER = 'stale-owner'
const LOCK_ANOMALY_RELEASE_FAILED = 'release-failed'
/** #209：被新鲜持有者挡住的试抢也发一条——不然调用方只看到 `update-busy`，不知道是谁、拿了多久。 */
const LOCK_ANOMALY_BUSY_OWNER = 'busy-owner'

/**
 * 失败原因白名单（ADR-0006）：行里只许出现稳定短码，所以 `error.code` 先过白名单再入行，
 * 拿不到码就退到 `'throw'`（抛出来的错，没有码）/ `'unknown'`（连错误对象都不是）。
 * 绝不放 `error.message`、路径、命令——那些是自由文本，一旦入行就再也收不回来。
 */
const STORE_FAIL_REASON_CODES = new Set([
  'eacces', 'eagain', 'ebadf', 'ebusy', 'edquot', 'eexist', 'efbig', 'eintr', 'eio', 'eisdir',
  'eloop', 'emfile', 'enametoolong', 'enfile', 'enodev', 'enoent', 'enomem', 'enospc', 'enotdir',
  'enotempty', 'eperm', 'epipe', 'erofs', 'etxtbsy', 'exdev',
])

function stableFailReason(error: unknown): string {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  if (typeof code === 'string' && code) {
    const lower = code.toLowerCase()
    // 本模块自己的 install-failed / queue-unavailable 说的是「归类」不是「盘上为什么坏」，同样归 unknown。
    return STORE_FAIL_REASON_CODES.has(lower) ? lower : 'unknown'
  }
  return error && typeof error === 'object' ? 'throw' : 'unknown'
}

/** 缺文件不是失败：放锁时锁已经不在＝目的已达，不当异常记。 */
function isMissingFileError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT'
}

/** 从锁里记的 `startedAt` 算年龄；取不到（缺格、非数、零、未来时间）就省略这格（清单允许缺格，不许给 null）。 */
function lockAgeMs(lock: Record<string, unknown> | null, nowMs: number): number | undefined {
  const startedAt = lock ? lock['startedAt'] : undefined
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || startedAt <= 0) return undefined
  const age = nowMs - startedAt
  return Number.isFinite(age) && age >= 0 ? age : undefined
}

// ---- 锁位判据（#181）：安装锁（按插件）与跨插件全局锁共用同一套「时间 + 可解析性」 ----

/** 锁位此刻的样子：在不在、认不认得出主人、以及判「还是不是刚才那一代」用的 mtime 与大小。 */
interface LockProbe {
  present: boolean
  owner: Record<string, unknown> | null
  mtimeMs: number | undefined
  size: number | undefined
}

/** 只有「盘不支持硬链接 / 权限受限」才退回原地创建；其余错误照旧上抛，由调用方记 `acquire-*`。 */
const LOCK_LINK_FALLBACK_CODES = new Set(['EACCES', 'EMLINK', 'ENOSYS', 'ENOTSUP', 'EPERM', 'EXDEV'])

/**
 * 原子建锁（#181）：先写同目录临时文件，再 `link` 到锁位——`link` 在目标已存在时回 `EEXIST`，天然互斥；
 * 锁位于是要么不存在、要么是完整内容（具备硬链接的文件系统上），不再有「`open(wx)` 后、写内容前崩溃」的空锁。
 * 不吃硬链接的盘退回原地 `open(wx)` + 写（形态退化回旧版的空文件窗口，可用优先）；降级本身按调用方的
 * `acquire-*` 动作留痕（失败必须留痕，但不因此拒绝安装）。
 * 返回 `false` 只表示「锁被占」；其余真故障上抛。
 */
async function createLockAtomically(
  lockPath: string,
  directory: string,
  payload: string,
  onFallback: (error: unknown) => void
): Promise<boolean> {
  const temporary = join(directory, `${LOCK_FILE}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, payload, { mode: 0o600 })
    await link(temporary, lockPath)
    return true
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'EEXIST') return false
    if (code && LOCK_LINK_FALLBACK_CODES.has(code)) {
      onFallback(error)
      try {
        const handle = await open(lockPath, 'wx', 0o600)
        try {
          await handle.writeFile(payload)
        } finally {
          await handle.close()
        }
        return true
      } catch (fallbackError) {
        if ((fallbackError as { code?: string }).code === 'EEXIST') return false
        throw fallbackError
      }
    }
    throw error
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

/**
 * 读锁位（#181 判据的另一半）：先读内容再 `stat`——读坏时用的是「之后」的 mtime，方向保守（宁可判新鲜）。
 * 可解析且是对象才算「读得到主人」；空文件/半截 JSON/内容 `null` 一律当不可解析，年龄退回 mtime。
 * 读失败按 `onReadFail` 留痕后当「占着但认不出主人」，交给时间列判。
 */
async function probeLockFile(
  lockPath: string,
  readOf: (filename: string) => Promise<string>,
  statOf: (filename: string) => Promise<{ size: number; mtimeMs?: number }>,
  onReadFail: (error: unknown) => void
): Promise<LockProbe> {
  let raw: string | null = null
  let readMissing = false
  try {
    raw = await readOf(lockPath)
  } catch (error) {
    if (isMissingFileError(error)) readMissing = true
    else onReadFail(error)
  }
  let mtimeMs: number | undefined
  let size: number | undefined
  let statMissing = false
  try {
    const info = await statOf(lockPath)
    mtimeMs = typeof info.mtimeMs === 'number' ? info.mtimeMs : undefined
    size = typeof info.size === 'number' ? info.size : undefined
  } catch (error) {
    if (isMissingFileError(error)) statMissing = true
    else onReadFail(error)
  }
  if (readMissing && statMissing) return { present: false, owner: null, mtimeMs: undefined, size: undefined }
  let owner: Record<string, unknown> | null = null
  if (raw !== null && raw !== '') {
    try {
      const parsed = JSON.parse(raw) as unknown
      owner = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
    } catch (error) {
      // 半截 JSON：真读故障，留痕；内容 null 不算读故障（可解析，只是认不出主人）。
      onReadFail(error)
    }
  }
  return { present: true, owner, mtimeMs, size }
}

/** 锁的年龄：可解析看 `startedAt`；不可解析/缺格退回 mtime；两条都判不了返回 undefined（保守拒）。 */
function lockAgeOf(probe: LockProbe, nowMs: number): number | undefined {
  return (probe.owner ? lockAgeMs(probe.owner, nowMs) : undefined) ?? (probe.mtimeMs === undefined ? undefined : nowMs - probe.mtimeMs)
}

/**
 * 全局锁的年龄（#209 修）：锁里写了 `startedAt` 就按本端逻辑钟比（注入时钟的测试/宿主能走通）；
 * 缺格、不可解析就退回 mtime，而 mtime 是文件系统的**真墙钟**——必须用 `Date.now()` 比。
 * 否则宿主注入的假时钟会把「一小时前」看成未来时间，陈旧锁永远回收不了（#181 的回归点）。
 */
function queueLockAge(probe: LockProbe, nowMs: number): number | undefined {
  const fromStamp = probe.owner ? lockAgeMs(probe.owner, nowMs) : undefined
  if (fromStamp !== undefined) return fromStamp
  return probe.mtimeMs === undefined ? undefined : Date.now() - probe.mtimeMs
}

/** 锁位还是不是刚才那一代（回收动手前的二次核对，缩小「判陈旧 → 删锁」之间被别人重建的竞态窗口）。 */
function sameLockGeneration(before: LockProbe, after: LockProbe): boolean {
  return (
    before.present &&
    after.present &&
    before.mtimeMs !== undefined &&
    before.size !== undefined &&
    after.mtimeMs === before.mtimeMs &&
    after.size === before.size
  )
}

/** 队列跃迁相位（#209）：与字段清单 `update.queue.transition.phase` 的枚举逐字一致。 */
type QueueTransitionPhase = 'queued' | 'running' | 'done' | 'reclaimed' | 'pruned' | 'abandoned'

interface StoreLogPorts {
  /** 有没有可用发射口：没有就一行额外读盘都不做（行为、返回值、时序与今天一字不差）。 */
  enabled(): boolean
  /** 按动作方取发射口；磁盘侧用固定标识，队列侧取不到当次动作方即回 null（不猜）。 */
  portFor(pluginId?: string | null): UpdateLogPort | null
  /** `update.store.fail`：清单 guard 是「同一操作连续失败只记首次」，按 (动作方, op, 原因) 去重。 */
  fail(op: string, error: unknown, pluginId?: string | null): void
  /** `update.lock.anomaly`：ownerHash 是持有者指纹（#209），量不到就省略；busy-owner 同一持有者连续只记一次。 */
  anomaly(kind: string, pluginId?: string | null, ageMs?: number, ownerHash?: string): void
  /** `update.queue.transition`：边沿由调用点判（真写了盘且相位真的变了）。 */
  transition(
    phase: QueueTransitionPhase,
    pluginId: string,
    extra?: { waitedMs?: number; position?: number; holderHash?: string },
    /** 边沿主体：同一相位下逐条待办（如同时被摘的多条意向）靠它各留一条，不给则按「动作方 + 相位」边沿去重。 */
    fingerprintSalt?: string
  ): void
}

/**
 * 建本文件三个事件的记法：全部 best-effort —— 发射口抛错一律吞掉，记日志绝不能改变控制流、
 * 返回值或抛错。磁盘侧传已绑好插件标识的 `log`；队列侧是跨插件共享的，传 `logFor` 按当次
 * 动作方取口，取不到标识就不发（不许猜）。`dirHash` 是本次操作的目录短指纹（#209）：清单里
 * `update.store.fail.dirHash` 声明了就必须实发，且只许 8 位十六进制（绝不入路径原文）。
 */
function createStoreLog(
  log: UpdateLogPort | null,
  logFor: ((pluginId: string) => UpdateLogPort | null) | null,
  fixedPluginId: string | null,
  dirHash?: string
): StoreLogPorts {
  const lastFailReason = new Map<string, string>()
  const lastBusyOwner = new Map<string, string>()
  const routable = log !== null || logFor !== null
  function portFor(pluginId?: string | null): UpdateLogPort | null {
    if (log) return log
    const actor = typeof pluginId === 'string' && pluginId ? pluginId : fixedPluginId
    if (!logFor || !actor) return null
    try {
      const port = logFor(actor)
      return typeof port === 'function' ? port : null
    } catch {
      return null
    }
  }
  function fire(port: UpdateLogPort, level: string, event: string, fields: Record<string, unknown>, fingerprint?: string): void {
    try {
      port(level, event, fields, fingerprint === undefined ? undefined : { fingerprint })
    } catch {
      /* 发射口自己坏掉时保持沉默：任何外抛都比丢一行更坏 */
    }
  }
  function ownerHashField(fields: Record<string, unknown>, ownerHash?: string): void {
    if (typeof ownerHash === 'string' && /^[0-9a-f]{8}$/.test(ownerHash)) fields['ownerHash'] = ownerHash
  }
  function holderHashField(fields: Record<string, unknown>, holderHash?: string): void {
    if (typeof holderHash === 'string' && /^[0-9a-f]{8}$/.test(holderHash)) fields['holderHash'] = holderHash
  }
  return {
    enabled: () => routable,
    portFor,
    fail(op, error, pluginId) {
      try {
        const port = portFor(pluginId)
        if (!port) return
        const reason = stableFailReason(error)
        const key = `${pluginId ?? fixedPluginId ?? ''}\u0000${op}`
        if (lastFailReason.get(key) === reason) return
        lastFailReason.set(key, reason)
        const fields: Record<string, unknown> = { op, reason }
        if (dirHash) fields['dirHash'] = dirHash
        fire(port, 'warn', LOG_EVENT_STORE_FAIL, fields)
      } catch {}
    },
    anomaly(kind, pluginId, ageMs, ownerHash) {
      try {
        const port = portFor(pluginId)
        if (!port) return
        // busy-owner 的边沿是「换没换持有者」：同一把锁被同一个持有者连续挡住只记第一眼，
        // 否则一次安装被点十下就十行，真信号反被淹没。
        if (kind === LOCK_ANOMALY_BUSY_OWNER) {
          const key = `${pluginId ?? fixedPluginId ?? ''}`
          if (ownerHash && lastBusyOwner.get(key) === ownerHash) return
          if (ownerHash) lastBusyOwner.set(key, ownerHash)
        }
        const fields: Record<string, unknown> = { kind }
        if (typeof ageMs === 'number' && Number.isFinite(ageMs) && ageMs >= 0) fields['ageMs'] = ageMs
        ownerHashField(fields, ownerHash)
        fire(port, 'warn', LOG_EVENT_LOCK_ANOMALY, fields)
      } catch {}
    },
    transition(phase, pluginId, extra, fingerprintSalt) {
      try {
        if (typeof pluginId !== 'string' || !pluginId) return
        const port = portFor(pluginId)
        if (!port) return
        const fields: Record<string, unknown> = { phase }
        if (extra && typeof extra.waitedMs === 'number' && Number.isFinite(extra.waitedMs) && extra.waitedMs >= 0) {
          fields['waitedMs'] = extra.waitedMs
        }
        if (extra && typeof extra.position === 'number' && Number.isInteger(extra.position) && extra.position >= 0) {
          fields['position'] = extra.position
        }
        holderHashField(fields, extra?.holderHash)
        // 指纹带上动作方与相位：队列跨插件共享，同一进程里两家的同相位行不能互相吃掉（相位边沿仍由指纹守住）；
        // 逐条待办的边沿另带主体盐（intentKey），同一相位下不同待办各记一条。
        fire(port, 'info', LOG_EVENT_QUEUE_TRANSITION, fields, `${pluginId}\u0000${phase}\u0000${fingerprintSalt ?? ''}`)
      } catch {}
    },
  }
}

export interface UpdatePaths {
  directory: string
  state: string
  lock: string
  backup: string
}

/**
 * 状态目录：家目录下按插件标识派生，短指纹只做同一性判断，不记原文。
 * 插件标识取旧值时与旧原文一字不差（旧默认路径冻结，验收项）。
 */
export function pathsForUpdate(homeDir: string, pluginId: string, profileDir: string): UpdatePaths | null {
  if (typeof homeDir !== 'string' || !homeDir || typeof profileDir !== 'string' || !profileDir) return null
  if (typeof pluginId !== 'string' || !pluginId) return null
  const directory = join(homeDir, LEGACY_SEGMENT, pluginId, shortHash(profileDir))
  return { directory, state: join(directory, STATE_FILE), lock: join(directory, LOCK_FILE), backup: join(directory, BACKUP_FILE) }
}

/**
 * 旧路径冻结字面（规格 #591 第 7 条，2026-10-18 #203 修订）：常量保留（迁移与诊断要能说出旧目录在哪），
 * **不参与任何读写**——旧字面恰好是默认标识自己的实时目录，跨标识回退读会读到别家任务。
 */
export function legacyPathsForUpdate(homeDir: string, profileDir: string): UpdatePaths | null {
  // 旧字面永不删除：join(家目录, 'updates', 'dsh-mattpocock-skills-deck', 短指纹)。
  if (typeof homeDir !== 'string' || !homeDir || typeof profileDir !== 'string' || !profileDir) return null
  const directory = join(homeDir, LEGACY_SEGMENT, LEGACY_DIR_PLUGIN, shortHash(profileDir))
  return { directory, state: join(directory, STATE_FILE), lock: join(directory, LOCK_FILE), backup: join(directory, BACKUP_FILE) }
}

async function readJsonGuarded(filename: string, missing: null): Promise<Record<string, unknown> | null> {
  try {
    if ((await stat(filename)).size > 10 * 1024 * 1024) throw fail('install-failed')
    return JSON.parse(await readFile(filename, 'utf8')) as Record<string, unknown>
  } catch (error) {
    if (error && (error as { code?: string }).code === 'ENOENT') return missing
    throw error && (error as { code?: string }).code ? error : fail('install-failed')
  }
}

async function writeJsonAtomic(filename: string, value: unknown, onFail?: (error: unknown) => void): Promise<void> {
  const temporary = `${filename}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await rename(temporary, filename)
  } catch (error) {
    // 先把原始失败交给记账（稳定短码），再按原样抛 install-failed：归类与原来一字不差。
    if (onFail) onFail(error)
    throw fail('install-failed')
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

function normalizeJob(job: Record<string, unknown>): UpdateJob {
  return {
    id: typeof job.id === 'string' ? job.id : 'corrupt',
    state: JOB_STATES.includes(String(job.state)) ? (job.state as UpdateJob['state']) : 'interrupted',
    targetVersion: typeof job.targetVersion === 'string' ? job.targetVersion : null,
    message: typeof job.message === 'string' ? job.message : null,
    requestId: typeof job.requestId === 'string' ? job.requestId : null,
  }
}

export interface DiskPortsDeps {
  readFileImpl?: (filename: string, encoding: string) => Promise<string>
  statImpl?: (filename: string) => Promise<{ size: number }>
  /** 日志发射口（#124，可选）：已绑好本插件标识；不传即不记（行为与今天一字不差）。 */
  log?: UpdateLogPort
}

/**
 * 建任务存取与锁：调用方按当前插件标识建一份，转交核心当零件。
 * 只读自己的新路径（#203：旧路径字面是默认标识的实时目录，跨标识回退读会串插件），写只写自己的。
 */
export function createUpdateDiskPorts(homeDir: string, pluginId: string, profileDir: string, deps: DiskPortsDeps = {}): {
  paths: UpdatePaths | null
  readJob: () => Promise<UpdateJob | null>
  writeJob: (job: UpdateJob | null) => Promise<void>
  tryAcquireLock: (lockId: string, options?: { timeoutMs?: number }) => Promise<boolean>
  releaseLock: (lockId: string) => Promise<void>
  backupJob: (job: UpdateJob) => Promise<void>
} {
  const paths = pathsForUpdate(homeDir, pluginId, profileDir)
  const readText = deps.readFileImpl ?? ((filename: string, encoding: string) => readFile(filename, encoding))
  const statFile = deps.statImpl ?? ((filename: string) => stat(filename))
  // 日志接线（#124）：不传 log 时下面每一条记账都是空转，行为与今天一字不差。
  // #209：store.fail 的行必须带目录短指纹（清单声明了 dirHash，声明了就实发）。
  const storeLog = createStoreLog(
    typeof deps.log === 'function' ? deps.log : null,
    null,
    pluginId,
    paths ? shortHash8(paths.directory) : undefined
  )
  async function readAt(p: UpdatePaths | null): Promise<Record<string, unknown> | null> {
    if (!p) return null
    try {
      if ((await statFile(p.state)).size > 10 * 1024 * 1024) throw fail('install-failed')
      return JSON.parse(await readText(p.state, 'utf8')) as Record<string, unknown>
    } catch (error) {
      if (error && (error as { code?: string }).code === 'ENOENT') return null
      throw error && (error as { code?: string }).code ? error : fail('install-failed')
    }
  }
  // 前版本保真（#186）：state.json 老形状没有这一格时从 before.json 补读。
  // 只认同一条任务写下的快照（jobId 对得上才采信）；读不到/读坏都不挡状态读取，返回 null。
  async function previousVersionFromBackup(p: UpdatePaths | null, jobId: string): Promise<string | null> {
    if (!p) return null
    try {
      const backup = await readJsonGuarded(p.backup, null)
      if (!backup || String(backup.jobId ?? '') !== jobId) return null
      const value = (backup as { previousVersion?: unknown }).previousVersion
      return typeof value === 'string' && value ? value : null
    } catch {
      return null
    }
  }
  async function withPreviousVersion(p: UpdatePaths | null, job: UpdateJob): Promise<UpdateJob> {
    const direct = typeof job.previousVersion === 'string' && job.previousVersion ? job.previousVersion : null
    const fromBackup = direct ? null : await previousVersionFromBackup(p, job.id)
    const previousVersion = direct ?? fromBackup
    if (previousVersion) return { ...job, previousVersion }
    // 非字符串脏值归一为 null，别让它原样漏进公开形状；原本就没有这一格的老任务不补造。
    if (job.previousVersion === undefined || job.previousVersion === null) return job
    return { ...job, previousVersion: null }
  }
  async function readJob(): Promise<UpdateJob | null> {
    if (!paths) return null
    const job = await readAt(paths)
    if (job) {
      if (!JOB_STATES.includes(String(job.state)) || typeof job.id !== 'string') {
        return { id: 'corrupt', state: 'interrupted', message: 'recovery-required', targetVersion: null, requestId: null }
      }
      return withPreviousVersion(paths, { requestId: null, message: null, ...job } as UpdateJob)
    }
    const lock = await readJsonGuarded(paths.lock, null).catch((error: unknown) => {
      // #181：半截/空锁（open-write 之间崩溃的形态）不该让整次状态读取失败。当「没有锁」，
      // 把「是否陈旧、要不要回收」留给抢锁那一步判；否则坏锁在快照层就永远 update-busy。
      storeLog.fail('read-job', error)
      return null
    })
    if (lock) return { id: 'locked', state: 'interrupted', message: 'recovery-required', targetVersion: null, requestId: null }
    return null
  }
  async function writeJob(job: UpdateJob | null): Promise<void> {
    if (!paths) throw fail('install-failed')
    if (job === null) {
      await unlink(paths.state).catch((error: { code?: string }) => {
        if (!error || error.code !== 'ENOENT') {
          storeLog.fail('write-job', error)
          throw fail('install-failed')
        }
      })
      return
    }
    await mkdir(paths.directory, { recursive: true, mode: 0o700 })
    await writeJsonAtomic(paths.state, job, (error) => storeLog.fail('write-job', error))
  }
  /** 抢锁的陈旧阈值：注入的安装额度优先；未注入时退回 QUEUE_LOCK_STALE_MS（= 默认安装时限，同一口径）。 */
  function lockStaleMs(options: { timeoutMs?: number } = {}): number {
    const timeoutMs = options.timeoutMs
    return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : QUEUE_LOCK_STALE_MS
  }
  /** 安装锁的锁位视图（读失败记在当前动作 `acquire-lock` 上；`reclaim-stale-owner` 只留给真回收）。 */
  function probeInstallLock(): Promise<LockProbe> {
    return probeLockFile(
      paths!.lock,
      (filename) => readFile(filename, 'utf8'),
      (filename) => stat(filename),
      (error) => storeLog.fail('acquire-lock', error)
    )
  }
  function createInstallLock(lockId: string): Promise<boolean> {
    const payload = JSON.stringify({ id: lockId, pid: process.pid, startedAt: Date.now() })
    return createLockAtomically(paths!.lock, paths!.directory, payload, (error) => storeLog.fail('acquire-lock', error))
  }
  async function tryAcquireLock(lockId: string, options: { timeoutMs?: number } = {}): Promise<boolean> {
    if (!paths) return false
    const staleMs = lockStaleMs(options)
    try {
      await mkdir(paths.directory, { recursive: true, mode: 0o700 })
      if (await createInstallLock(lockId)) return true
      const held = await probeInstallLock()
      // 锁刚被放掉（两次读之间消失）：直接再抢一次，不算回收。
      if (!held.present) return createInstallLock(lockId)
      // 可解析看锁里记的 startedAt；不可解析/缺格退回 mtime；判不了年龄就按「别人正持有」拒（保守）。
      const age = lockAgeOf(held, Date.now())
      if (age === undefined || age <= staleMs) {
        // #209：原来这里一声不响回 false，调用方只看到 update-busy。现在说出被谁持有、持有多久
        // （同一把锁按持有者指纹连续只记一次，见 createStoreLog.anomaly）。
        storeLog.anomaly(LOCK_ANOMALY_BUSY_OWNER, null, age, lockOwnerHash(held.owner))
        return false
      }
      // 二次核对：年龄仍超、且锁没被换过才动手——别人可能在「判陈旧 → 删锁」之间已经重建。
      // 残余窗口（B 的删锁落在 A 的重建之后）在直接集成 createUpdateDiskPorts 时仍存在；宿主路径先拿
      // 跨插件全局锁（src/host.ts:355-370），到不了这里。记在 #181 票面，不在本批扩大。
      const again = await probeInstallLock()
      if (!again.present) return createInstallLock(lockId)
      const ageAgain = lockAgeOf(again, Date.now())
      if (ageAgain === undefined || ageAgain <= staleMs || !sameLockGeneration(held, again)) return false
      try {
        await unlink(paths.lock)
      } catch (error) {
        // 删不掉（盘坏/路径被占）：只当没抢到，原始原因入行。
        if (!isMissingFileError(error)) {
          storeLog.fail('reclaim-stale-owner', error)
          return false
        }
      }
      // 回收与建锁之间被别人抢先：认输（不递归重试，避免两个进程互摘）。
      if (!(await createInstallLock(lockId))) return false
      // 回收成功＝锁的主人早该收尾却没放（孤儿/陈旧）而这次真被摘掉：真边沿，年龄记判据来路，
      // 持有者指纹说明被摘掉的是哪一把（#209）。
      storeLog.anomaly(LOCK_ANOMALY_STALE_OWNER, null, ageAgain, lockOwnerHash(again.owner))
      return true
    } catch (error) {
      // 非「占着」的真故障原来静默回 false（对调用方看起来就是「被别人占着」）：留一条痕。
      storeLog.fail('acquire-lock', error)
      return false
    }
  }
  async function releaseLock(lockId: string): Promise<void> {
    if (!paths) return
    try {
      const current = await readJsonGuarded(paths.lock, null)
      if (current && (current as { id?: unknown }).id === lockId) {
        await unlink(paths.lock).catch((error: unknown) => {
          // 删不掉＝这把锁没放掉（原来静默吞）；锁已经不在了则目的已达，不算失败。
          if (isMissingFileError(error)) return
          storeLog.fail('release-lock', error)
          // 锁内容读到了就带上持有者指纹：放不掉的是「谁的锁」要说得清（#209）。
          storeLog.anomaly(LOCK_ANOMALY_RELEASE_FAILED, null, undefined, lockOwnerHash(current))
        })
      }
    } catch (error) {
      // 读锁就坏了＝连「这把锁是不是我的」都判不了，放锁这一步真失败（原来静默吞）。
      storeLog.fail('release-lock', error)
      storeLog.anomaly(LOCK_ANOMALY_RELEASE_FAILED)
    }
  }
  async function backupJob(job: UpdateJob): Promise<void> {
    if (!paths) throw fail('install-failed')
    const files: Record<string, string> = {}
    for (const name of SNAPSHOT_FILES) {
      try {
        const filename = join(profileDir, name)
        if ((await stat(filename)).size > 3 * 1024 * 1024) throw fail('install-failed')
        files[name] = await readFile(filename, 'utf8')
      } catch (error) {
        if (!error || (error as { code?: string }).code !== 'ENOENT') {
          // 快照读不出来只留稳定码，原文（含路径）绝不入行；归类仍按原样抛 install-failed。
          storeLog.fail('read-snapshot', error)
          throw fail('install-failed')
        }
      }
    }
    await mkdir(paths.directory, { recursive: true, mode: 0o700 })
    await writeJsonAtomic(
      paths.backup,
      {
        jobId: job.id,
        previousVersion: job.previousVersion ?? null,
        files,
      },
      (error) => storeLog.fail('write-backup', error)
    )
  }
  return { paths, readJob, writeJob, tryAcquireLock, releaseLock, backupJob }
}

/** 跨插件队列的共享落盘（#15，新增强制串行的归属与持久化，不碰按插件隔离的旧树）。
 *
 * 归属：按使用范围共享——同一 (homeDir, profileDir) 的全部插件共用同一目录，
 * 不同使用范围各用各的、可并行。父目录取 `update-queue`（与 `updates` 平级），
 * 任何插件标识都撞不上（插件标识只能决定 `updates` 下的子目录名）。
 * 文件：`queue.json`（owner + waiting，快照式整写），`global.lock`（执行互斥，
 * 抢到才许装，一次只装一个）。
 */
export const QUEUE_DIR_SEGMENT = 'update-queue'
export const QUEUE_FILE = 'queue.json'
export const QUEUE_LOCK_FILE = 'global.lock'
/** 全局锁陈旧回收默认口径：15 分钟（直接取安装时限默认值，两处口径单源；调用方可按注入覆盖）。 */
export const QUEUE_LOCK_STALE_MS = DEFAULT_INSTALL_TIMEOUT_MS

export interface UpdateQueuePaths {
  directory: string
  file: string
  lock: string
}

/**
 * 队列共享目录：家目录下按使用范围短指纹派生（短指纹算法与按插件隔离的旧树同一套，
 * 只做同一性判断，不记原文）。入参非法返回 null，调用方按“无队列可用”放行安装，
 * 绝不因队列自身故障挡住更新。
 */
export function queuePathsForUpdate(homeDir: string, profileDir: string): UpdateQueuePaths | null {
  if (typeof homeDir !== 'string' || !homeDir || typeof profileDir !== 'string' || !profileDir) return null
  const directory = join(homeDir, QUEUE_DIR_SEGMENT, shortHash(profileDir))
  return { directory, file: join(directory, QUEUE_FILE), lock: join(directory, QUEUE_LOCK_FILE) }
}

export interface QueuePortsDeps {
  readFileImpl?: (filename: string, encoding: string) => Promise<string>
  statImpl?: (filename: string) => Promise<{ size: number; mtimeMs?: number }>
  nowImpl?: () => number
  /** 意向有效期（#209）：判定「摘掉的待办是过期清理 pruned 还是主动放弃 abandoned」，默认 10 分钟。 */
  ttlMs?: number
  /**
   * 按当次动作方插件标识取发射口（#124，可选）：队列是跨插件共享的，所以这里不能要一个固定
   * pluginId 的发射口；取不到标识的调用段（如 readQueue／不看主人的放锁）就不发——不许猜。
   */
  logFor?: (pluginId: string) => UpdateLogPort | null
}

function queueFail(): Error & { code: string } {
  // 队列自身的错不用 install-failed（那是安装失败的码）：队列坏了只影响可见性与公平
  // 提示，不改变安装成败的归类，调用方（host.ts）一律 best-effort 吞掉。
  return Object.assign(new Error('queue-unavailable'), { code: 'queue-unavailable' })
}

/** 一次队列真实跃迁：谁跨了相位、新相位、以及真量到的等待/位次/当时谁持有队列（#209）。 */
interface QueueEdge {
  pluginId: string
  phase: QueueTransitionPhase
  extra: { waitedMs?: number; position?: number; holderHash?: string }
  /** 逐条待办的边沿主体（被摘意向的 intentKey）：同一相位下的不同待办各留一行。 */
  fingerprintSalt?: string
}

function intentKey(entry: { pluginId: string; requestId: string | null }): string {
  return `${entry.pluginId}\u0000${entry.requestId ?? null}`
}

/** 这个拥有者在队列里真等了多久：从它自己的占位时间到记账的开始时间；两格缺一或对不上就不给。 */
function waitMsOf(previous: UpdateQueueState, owner: QueueOwner): number | undefined {
  const entry = previous.waiting.find((e) => intentKey(e) === intentKey(owner))
  if (!entry || entry.enqueuedAt <= 0 || !Number.isFinite(owner.startedAt) || owner.startedAt <= 0) return undefined
  const waited = owner.startedAt - entry.enqueuedAt
  return Number.isFinite(waited) && waited >= 0 ? waited : undefined
}

/** 给跃迁行挂上「此刻谁持有队列」的指纹：没有持有者可指时整格不给（不猜）。 */
function withHolderHash<T extends { waitedMs?: number; position?: number; holderHash?: string }>(
  extra: T,
  holderHash: string | undefined
): T {
  if (!holderHash) return extra
  return { ...extra, holderHash }
}

/**
 * 从「写盘前 / 写盘后」两份队列算出真跃迁——边沿只在这里判：两份同一相位就是没跃迁（回空数组）。
 * 相位：`'queued'`（新占位）→ `'running'`（拿到锁开始装）→ `'done'`（终态摘牌）；
 * 陈旧回收成功在 tryAcquireGlobalLock 里另记 `'reclaimed'`（那件事真写的是 global.lock，不是 queue.json）。
 * #209 起待办被摘牌也记（原来静默）：按意向年龄分「过期清理 pruned」与「主动放弃 abandoned」，
 * 并带上当时谁持有队列的指纹——卡住时才能回答「被谁、多久」。
 */
function queueEdgesOf(
  previous: UpdateQueueState,
  next: UpdateQueueState,
  context: { now: number; ttlMs: number }
): QueueEdge[] {
  const edges: QueueEdge[] = []
  const before = previous.owner
  const after = next.owner
  const hashOf = (owner: QueueOwner | null): string | undefined => (owner ? hash8(owner.pluginId) : undefined)
  if (before && !after) {
    edges.push({ pluginId: before.pluginId, phase: 'done', extra: withHolderHash({}, hashOf(before)) })
  } else if (after && (!before || before.pluginId !== after.pluginId)) {
    const waitedMs = waitMsOf(previous, after)
    edges.push({
      pluginId: after.pluginId,
      phase: 'running',
      extra: withHolderHash(waitedMs === undefined ? {} : { waitedMs }, hashOf(after)),
    })
  } else {
    const known = new Set(previous.waiting.map(intentKey))
    const at = next.waiting.findIndex((entry) => !known.has(intentKey(entry)))
    if (at >= 0) {
      edges.push({ pluginId: next.waiting[at].pluginId, phase: 'queued', extra: withHolderHash({ position: at + 1 }, hashOf(after)) })
    }
  }
  // 摘掉的待办：刚升成 owner 的那条已经记过 running，别重复记成放弃。
  const remained = new Set(next.waiting.map(intentKey))
  const promoted = after ? intentKey(after) : null
  for (const entry of previous.waiting) {
    if (remained.has(intentKey(entry))) continue
    if (promoted && intentKey(entry) === promoted) continue
    const age = context.now - entry.enqueuedAt
    // 量不到年龄（脏值）当主动放弃：过期清理必须真的过得了期，不能拿「算不出来」冒充。
    const expired = Number.isFinite(entry.enqueuedAt) && Number.isFinite(age) && age >= context.ttlMs
    edges.push({
      pluginId: entry.pluginId,
      phase: expired ? 'pruned' : 'abandoned',
      extra: withHolderHash({}, hashOf(after)),
      // 同一份队列里同一条待办被摘是独立边沿：盐用 intentKey，多条同时被摘时逐条发（不去重吃掉）。
      fingerprintSalt: intentKey(entry),
    })
  }
  return edges
}

/**
 * 建跨插件队列存取与全局锁：调用方按当前使用范围建一份（与插件标识无关），转交宿主入口组合进安装锁。
 * 读走单读（队列文件只此一份，没有旧影子）；写原子整写；锁走独占建文件，过期可回收一次。
 */
export function createUpdateQueuePorts(
  homeDir: string,
  profileDir: string,
  deps: QueuePortsDeps = {}
): {
  paths: UpdateQueuePaths | null
  readQueue: () => Promise<UpdateQueueState>
  writeQueue: (state: UpdateQueueState) => Promise<void>
  tryAcquireGlobalLock: (lockId: string, pluginId: string, opts?: { timeoutMs?: number }) => Promise<boolean>
  releaseGlobalLock: (lockId: string) => Promise<void>
} {
  const paths = queuePathsForUpdate(homeDir, profileDir)
  const readText = deps.readFileImpl ?? ((filename: string, encoding: string) => readFile(filename, encoding))
  const statFile = deps.statImpl ?? ((filename: string) => stat(filename))
  const now = deps.nowImpl ?? Date.now
  const ttlMs =
    typeof deps.ttlMs === 'number' && Number.isFinite(deps.ttlMs) && deps.ttlMs > 0 ? deps.ttlMs : QUEUE_INTENT_TTL_MS
  // 日志接线（#124）：不传 logFor 时下面每一条记账都是空转，行为、返回值、时序与今天一字不差。
  // #209：store.fail 带队列目录短指纹，跃迁判据用同一套 ttl/now（与宿主 pruneExpiredIntents 同口径）。
  const storeLog = createStoreLog(
    null,
    typeof deps.logFor === 'function' ? deps.logFor : null,
    null,
    paths ? shortHash8(paths.directory) : undefined
  )
  /** 判跃迁要「写盘前」那一份：只有接了发射口才多读这一次，读不到就判不了（宁可不发，不猜）。 */
  async function readQueueForEdge(): Promise<UpdateQueueState | null> {
    try {
      return await readQueue()
    } catch {
      return null
    }
  }
  async function readQueue(): Promise<UpdateQueueState> {
    if (!paths) throw queueFail()
    try {
      if ((await statFile(paths.file)).size > 10 * 1024 * 1024) throw queueFail()
      return normalizeQueueState(JSON.parse(await readText(paths.file, 'utf8')))
    } catch (error) {
      if (error && (error as { code?: string }).code === 'ENOENT') {
        return normalizeQueueState(null)
      }
      // 这一层没有动作方标识（读队列的调用段拿不到是谁在读），没法路由，所以只按原样抛。
      throw error && (error as { code?: string }).code ? error : queueFail()
    }
  }
  async function writeQueue(state: UpdateQueueState): Promise<void> {
    if (!paths) throw queueFail()
    const next = normalizeQueueState(state)
    const previous = storeLog.enabled() ? await readQueueForEdge() : null
    const edges = previous ? queueEdgesOf(previous, next, { now: now(), ttlMs }) : []
    // 最原始的那个失败留给 store.fail 取稳定码（里面那层原来把它换成了 queueFail）。
    let failure: unknown = null
    try {
      await mkdir(paths.directory, { recursive: true, mode: 0o700 })
      const temporary = `${paths.file}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
        await rename(temporary, paths.file)
      } catch (error) {
        failure = error
        throw queueFail()
      } finally {
        await unlink(temporary).catch(() => {})
      }
    } catch (error) {
      const code = error && (error as { code?: string }).code
      const original = failure ?? error ?? queueFail()
      if (edges.length > 0) storeLog.fail('write-queue', original, edges[0].pluginId)
      throw code ? error : queueFail()
    }
    // 真的写完盘才记（边沿＝真写了盘且相位真的变了）；一次写盘可能同时有「进」和「出」两条边。
    for (const edge of edges) storeLog.transition(edge.phase, edge.pluginId, edge.extra, edge.fingerprintSalt)
  }
  /**
   * 读全局锁。读不到只是「看不见锁」，不是异常——但抢锁侧要保守认输、放锁侧这把锁就放不掉，
   * 所以有动作方标识时留一条痕（原来静默回 null）。
   */
  async function readLockRaw(actor: string | null): Promise<Record<string, unknown> | null> {
    if (!paths) return null
    try {
      if ((await statFile(paths.lock)).size > 1024 * 1024) return null
      return JSON.parse(await readText(paths.lock, 'utf8')) as Record<string, unknown>
    } catch (error) {
      if (actor) storeLog.fail('read-global-lock', error, actor)
      return null
    }
  }
  /** 全局锁的锁位视图（读失败记在 read-global-lock 上；reclaim-stale-owner 只留给真回收）。 */
  function probeGlobalLock(actor: string): Promise<LockProbe> {
    return probeLockFile(
      paths!.lock,
      (filename) => readText(filename, 'utf8'),
      statFile,
      (error) => storeLog.fail('read-global-lock', error, actor)
    )
  }
  function createGlobalLock(lockId: string, pluginId: string): Promise<boolean> {
    const payload = JSON.stringify({ id: lockId, pluginId, pid: process.pid, startedAt: now() })
    return createLockAtomically(paths!.lock, paths!.directory, payload, (error) =>
      storeLog.fail('acquire-global-lock', error, pluginId)
    )
  }
  async function tryAcquireGlobalLock(lockId: string, pluginId: string, opts: { timeoutMs?: number } = {}): Promise<boolean> {
    if (!paths) return false
    if (typeof lockId !== 'string' || !lockId || typeof pluginId !== 'string' || !pluginId) return false
    const timeoutMs =
      typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
        ? opts.timeoutMs
        : QUEUE_LOCK_STALE_MS
    try {
      await mkdir(paths.directory, { recursive: true, mode: 0o700 })
      if (await createGlobalLock(lockId, pluginId)) return true
      const held = await probeGlobalLock(pluginId)
      // 锁刚被放掉（两次读之间消失）：直接再抢一次，不算回收。
      if (!held.present) return createGlobalLock(lockId, pluginId)
      // 与安装锁同一判据：可解析看 startedAt，不可解析/缺格退回 mtime，判不了年龄就保守拒。
      const age = queueLockAge(held, now())
      if (age === undefined || age <= timeoutMs) {
        // #209：新鲜持有者占着要说得出「谁、多久」；同一代持有者连续只记一次（createStoreLog 去重）。
        storeLog.anomaly(LOCK_ANOMALY_BUSY_OWNER, pluginId, age, lockOwnerHash(held.owner))
        return false
      }
      // 二次核对：别人可能在「判陈旧 → 删锁」之间已经重建（同安装锁的残余窗口，见 tryAcquireLock 注）。
      const again = await probeGlobalLock(pluginId)
      if (!again.present) return createGlobalLock(lockId, pluginId)
      const ageAgain = queueLockAge(again, now())
      if (ageAgain === undefined || ageAgain <= timeoutMs || !sameLockGeneration(held, again)) return false
      try {
        await unlink(paths.lock)
      } catch (error) {
        if (!isMissingFileError(error)) {
          storeLog.fail('reclaim-stale-owner', error, pluginId)
          return false
        }
      }
      // 回收与建锁之间被别人抢先：认输（不递归重试，避免两个进程互摘）。
      if (!(await createGlobalLock(lockId, pluginId))) return false
      // 回收成功是真跃迁：陈旧主人被摘掉（lock.anomaly）＋锁到了我手里（queue.transition 的 reclaimed）。
      storeLog.anomaly(LOCK_ANOMALY_STALE_OWNER, pluginId, ageAgain, lockOwnerHash(again.owner))
      storeLog.transition('reclaimed', pluginId, { holderHash: hash8(pluginId) })
      return true
    } catch (error) {
      // 非「占着」的真故障原来静默回 false（对调用方看起来就是「有人在装」）：留一条痕。
      storeLog.fail('acquire-global-lock', error, pluginId)
      return false
    }
  }
  async function releaseGlobalLock(lockId: string): Promise<void> {
    if (!paths) return
    try {
      // 放锁这里还不知道动作方（标识记在锁里，得先读到）：读坏了就没有可路由的标识，不猜。
      const current = await readLockRaw(null)
      if (current && (current as { id?: unknown }).id === lockId) {
        const owner = typeof current['pluginId'] === 'string' && current['pluginId'] ? (current['pluginId'] as string) : null
        await unlink(paths.lock).catch((error: unknown) => {
          // 删不掉＝这把锁没放掉（原来静默吞）；锁已经不在了则目的已达，不算失败。
          if (isMissingFileError(error)) return
          storeLog.fail('release-global-lock', error, owner)
          if (owner) storeLog.anomaly(LOCK_ANOMALY_RELEASE_FAILED, owner, undefined, lockOwnerHash(current))
        })
      }
    } catch {}
  }
  return { paths, readQueue, writeQueue, tryAcquireGlobalLock, releaseGlobalLock }
}

/** 批量会话账本的共享落盘（#25，与队列同一目录：同一使用范围一份，跨插件共用）。
 *
 * 归属：按使用范围共享（与跨插件队列同一套目录派生：`update-queue/<使用范围短指纹>`），
 * 不同使用范围各用各的。文件只有一份 `batch.json` —— 「这一轮批量更新走到哪了」是全范围唯一的一份，
 * 与按插件隔离的 `updates/<插件标识>/...` 那棵树完全分开（父目录不同，任何插件标识都撞不上）。
 * 纪律与队列同一套：读坏自愈为空会话（缺文件、超大、JSON 坏掉、读失败都回空，绝不因账本坏掉挡住更新）；
 * 写走原子整写（临时文件 + rename，写完删临时件）；清空写一份空会话（不是删文件，避免与并发读打架）。
 */
export const BATCH_FILE = 'batch.json'
/** 账本读入上限：1 MiB，超了当坏账本（正常一份几百字节）。 */
export const BATCH_FILE_MAX_BYTES = 1024 * 1024

export interface UpdateBatchPaths {
  directory: string
  file: string
}

/**
 * 批量账本路径：与队列同一目录（`update-queue/<短指纹>/batch.json`）。
 * 入参非法返回 null，调用方按「账本不可落盘」处理（诚实说明，绝不猜目录）。
 */
export function batchPathsForUpdate(homeDir: string, profileDir: string): UpdateBatchPaths | null {
  const queue = queuePathsForUpdate(homeDir, profileDir)
  if (!queue) return null
  return { directory: queue.directory, file: join(queue.directory, BATCH_FILE) }
}

export interface BatchPortsDeps {
  readFileImpl?: (filename: string, encoding: string) => Promise<string>
  statImpl?: (filename: string) => Promise<{ size: number }>
}

function batchFail(): Error & { code: string } {
  // 批量账本自身的错另起一个码（与队列的 queue-unavailable 同风格）：账本写不进去要能一眼认出来，
  // 不冒充 install-failed —— 安装成败的归类不因账本故障改变。
  return Object.assign(new Error('batch-unavailable'), { code: 'batch-unavailable' })
}

/**
 * 建批量账本存取：调用方按当前使用范围建一份（与插件标识无关），转交批量宿主入口。
 * 读走单读自愈为空会话；写原子整写；清空写空会话。路径算不出来时不抛错（读回空、写抛 batch-unavailable）。
 */
export function createBatchDiskPorts(
  homeDir: string,
  profileDir: string,
  deps: BatchPortsDeps = {}
): {
  paths: UpdateBatchPaths | null
  readBatch: () => Promise<BatchSession>
  writeBatch: (session: BatchSession) => Promise<void>
  clearBatch: () => Promise<void>
} {
  const paths = batchPathsForUpdate(homeDir, profileDir)
  const readText = deps.readFileImpl ?? ((filename: string, encoding: string) => readFile(filename, encoding))
  const statFile = deps.statImpl ?? ((filename: string) => stat(filename))
  async function readBatch(): Promise<BatchSession> {
    if (!paths) return emptyBatchSession()
    try {
      if ((await statFile(paths.file)).size > BATCH_FILE_MAX_BYTES) return emptyBatchSession()
      return normalizeBatchSession(JSON.parse(await readText(paths.file, 'utf8')))
    } catch {
      // 自愈为空会话：缺文件、超大、JSON 坏掉、读失败都回空，坏账本不能挡更新（与队列同一纪律）。
      return emptyBatchSession()
    }
  }
  async function writeBatch(session: BatchSession): Promise<void> {
    if (!paths) throw batchFail()
    const normalized = normalizeBatchSession(session)
    try {
      await mkdir(paths.directory, { recursive: true, mode: 0o700 })
      const temporary = `${paths.file}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
        await rename(temporary, paths.file)
      } catch {
        throw batchFail()
      } finally {
        await unlink(temporary).catch(() => {})
      }
    } catch (error) {
      throw error && (error as { code?: string }).code ? error : batchFail()
    }
  }
  async function clearBatch(): Promise<void> {
    if (!paths) return
    await writeBatch(emptyBatchSession())
  }
  return { paths, readBatch, writeBatch, clearBatch }
}

/** 批量属主隔离与知识/偏好落盘（#59 D1：知识、一轮、属主各回各家）。 */
/* Owner identity is the batch prefix (unique per integrator); old owner-less batch.json is never read or written by the new ports (Q2=A). */

export const INVENTORY_FILE = 'inventory.json'
export const PREFS_FILE = 'prefs.json'
export const INVENTORY_FILE_MAX_BYTES = 1024 * 1024
export const PREFS_FILE_MAX_BYTES = 64 * 1024

export function sanitizeBatchOwner(owner: unknown): string | null {
  if (typeof owner !== 'string' || !owner) return null
  if (owner.length < 1 || owner.length > 64) return null
  if (!/^[A-Za-z0-9_-]+$/.test(owner)) return null
  return owner
}

export interface BatchOwnerPaths {
  directory: string
  batchFile: string
  inventoryFile: string
  prefsFile: string
}

export function batchPathsForOwner(homeDir: string, profileDir: string, owner: unknown): BatchOwnerPaths | null {
  const clean = sanitizeBatchOwner(owner)
  if (!clean) return null
  const queue = queuePathsForUpdate(homeDir, profileDir)
  if (!queue) return null
  const directory = join(queue.directory, clean)
  return { directory, batchFile: join(directory, BATCH_FILE), inventoryFile: join(directory, INVENTORY_FILE), prefsFile: join(directory, PREFS_FILE) }
}

export interface BatchInventoryEntry {
  lastCheckedAt: number
  /** 在场事实（与行内快照同步；老账本缺省即 null，按未知处理）。 */
  installed: boolean | null
  installedVersion: string | null
  latestVersion: string | null
  canInstall: boolean | null
  error: string | null
}

export interface BatchInventory {
  version: 1
  updatedAt: number
  entries: Record<string, BatchInventoryEntry>
}

export function emptyBatchInventory(nowMs?: number): BatchInventory {
  const at = typeof nowMs === 'number' && Number.isFinite(nowMs) && nowMs >= 0 ? nowMs : 0
  return { version: 1, updatedAt: at, entries: {} }
}

function asMillisOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function asNullableText(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

export function normalizeBatchInventory(raw: unknown, nowMs?: number): BatchInventory {
  const fallback = emptyBatchInventory(nowMs)
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback
    const input = raw as Record<string, unknown>
    if (input['version'] !== 1) return fallback
    const entries: Record<string, BatchInventoryEntry> = {}
    const rawEntries = input['entries']
    if (rawEntries && typeof rawEntries === 'object' && !Array.isArray(rawEntries)) {
      for (const [key, item] of Object.entries(rawEntries as Record<string, unknown>)) {
        if (!key || typeof item !== 'object' || !item || Array.isArray(item)) continue
        const e = item as Record<string, unknown>
        const canInstallRaw = e['canInstall']
        const installedRaw = e['installed']
        entries[key] = {
          lastCheckedAt: asMillisOrZero(e['lastCheckedAt']),
          installed: typeof installedRaw === 'boolean' ? installedRaw : null,
          installedVersion: asNullableText(e['installedVersion']),
          latestVersion: asNullableText(e['latestVersion']),
          canInstall: typeof canInstallRaw === 'boolean' ? canInstallRaw : null,
          error: asNullableText(e['error']),
        }
      }
    }
    return { version: 1, updatedAt: asMillisOrZero((input as Record<string, unknown>)['updatedAt']), entries }
  } catch {
    return fallback
  }
}

export interface BatchPrefs {
  checkOnOpen?: boolean
}

export function normalizeBatchPrefs(raw: unknown): BatchPrefs {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const v = (raw as Record<string, unknown>)['checkOnOpen']
    if (typeof v === 'boolean') return { checkOnOpen: v }
    return {}
  } catch {
    return {}
  }
}

export interface BatchOwnerPorts {
  paths: BatchOwnerPaths | null
  readBatch: () => Promise<BatchSession>
  writeBatch: (session: BatchSession) => Promise<void>
  clearBatch: () => Promise<void>
  readInventory: () => Promise<BatchInventory>
  writeInventory: (inventory: BatchInventory) => Promise<void>
  readPrefs: () => Promise<BatchPrefs>
  writePrefs: (prefs: BatchPrefs) => Promise<void>
}

async function readJsonFile(filename: string, maxBytes: number, readText: (f: string, e: string) => Promise<string>, statFile: (f: string) => Promise<{ size: number }>): Promise<unknown | null> {
  try {
    if ((await statFile(filename)).size > maxBytes) return null
    return JSON.parse(await readText(filename, 'utf8')) as unknown
  } catch (error) {
    if (error && (error as { code?: string }).code === 'ENOENT') return null
    return null
  }
}

async function writeJsonFileAtomic(filename: string, value: unknown, directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = filename + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temporary, filename)
  } catch {
    throw batchFail()
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

export function createBatchOwnerPorts(
  homeDir: string,
  profileDir: string,
  owner: unknown,
  deps: BatchPortsDeps = {},
): BatchOwnerPorts {
  const paths = batchPathsForOwner(homeDir, profileDir, owner)
  const readText = deps.readFileImpl ?? ((filename: string, encoding: string) => readFile(filename, encoding))
  const statFile = deps.statImpl ?? ((filename: string) => stat(filename))
  async function readBatch(): Promise<BatchSession> {
    if (!paths) return emptyBatchSession()
    const raw = await readJsonFile(paths.batchFile, BATCH_FILE_MAX_BYTES, readText, statFile)
    if (raw === null) return emptyBatchSession()
    return normalizeBatchSession(raw)
  }
  async function writeBatch(session: BatchSession): Promise<void> {
    if (!paths) throw batchFail()
    await writeJsonFileAtomic(paths.batchFile, normalizeBatchSession(session), paths.directory)
  }
  async function clearBatch(): Promise<void> {
    if (!paths) return
    await writeBatch(emptyBatchSession())
  }
  async function readInventory(): Promise<BatchInventory> {
    if (!paths) return emptyBatchInventory()
    const raw = await readJsonFile(paths.inventoryFile, INVENTORY_FILE_MAX_BYTES, readText, statFile)
    if (raw === null) return emptyBatchInventory()
    return normalizeBatchInventory(raw)
  }
  async function writeInventory(inventory: BatchInventory): Promise<void> {
    if (!paths) throw batchFail()
    const normalized = normalizeBatchInventory(inventory, inventory.updatedAt)
    normalized.updatedAt = asMillisOrZero(inventory.updatedAt)
    await writeJsonFileAtomic(paths.inventoryFile, normalized, paths.directory)
  }
  async function readPrefs(): Promise<BatchPrefs> {
    if (!paths) return {}
    const raw = await readJsonFile(paths.prefsFile, PREFS_FILE_MAX_BYTES, readText, statFile)
    if (raw === null) return {}
    return normalizeBatchPrefs(raw)
  }
  async function writePrefs(prefs: BatchPrefs): Promise<void> {
    if (!paths) throw batchFail()
    await writeJsonFileAtomic(paths.prefsFile, normalizeBatchPrefs(prefs), paths.directory)
  }
  return { paths, readBatch, writeBatch, clearBatch, readInventory, writeInventory, readPrefs, writePrefs }
}

/** 按插件 + 版本持久化的跳过记录（#16，与三冻结落盘名并存的第四文件，不碰旧树）。
 *
 * 键：跳过只按「插件标识 + 版本」记——目录已按插件标识隔离（pathsForUpdate），
 * 文件内只记版本集合。新版本恒重新提醒（跳过是 dismissal 不是全局静音）。
 * 重置入口（第一性原理结论，见 #16）：已跳过版本留在同一更新横幅行展示为
 * 「已跳过 X.Y.Z · 恢复」，点恢复即清掉该版本的跳过并重查；不藏进设置页。
 * 文件：`skipped.json`（`{ skipped: [{ version, skippedAt }] }`，快照式整写，上限 50 条）。
 */
export interface SkippedVersionEntry {
  version: string
  skippedAt: number
}

/** 跳过文件上限：只留最近 50 条，避免无界增长（老条目自然淘汰）。 */
export const MAX_SKIPPED_ENTRIES = 50

/** 跳过展示键：面板行展示与去重用（`插件标识@版本`）。 */
export function skipKey(pluginId: string, version: string): string {
  return `${String(pluginId)}@${String(version)}`
}

/** 跳过记录归一化：只收发行合法版（stable + 预发布），非法条目丢弃（自愈不抛错）。 */
export function normalizeSkipped(raw: unknown): SkippedVersionEntry[] {
  if (!raw || typeof raw !== 'object') return []
  const list = (raw as { skipped?: unknown }).skipped
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const out: SkippedVersionEntry[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const version = (item as { version?: unknown }).version
    const skippedAt = (item as { skippedAt?: unknown }).skippedAt
    if (!validReleaseVersion(version) || seen.has(version as string)) continue
    seen.add(version as string)
    out.push({ version: version as string, skippedAt: typeof skippedAt === 'number' && Number.isFinite(skippedAt) ? skippedAt : 0 })
  }
  return out.slice(0, MAX_SKIPPED_ENTRIES)
}

/** 该版本是否已被跳过（版本须发行合法，否则为 false）。 */
export function isVersionSkipped(skipped: readonly SkippedVersionEntry[] | unknown, version: unknown): boolean {
  if (!validReleaseVersion(version)) return false
  return normalizeSkipped({ skipped }).some((entry) => entry.version === version)
}

/** 记一次跳过：同版本幂等（刷新 skippedAt），新版本追加并按上限裁剪。 */
export function addSkipped(skipped: readonly SkippedVersionEntry[] | unknown, version: string, now: number): SkippedVersionEntry[] {
  if (!validReleaseVersion(version)) throw fail('install-failed')
  const at = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
  const rest = normalizeSkipped({ skipped }).filter((entry) => entry.version !== version)
  return [{ version, skippedAt: at }, ...rest].slice(0, MAX_SKIPPED_ENTRIES)
}

/** 重置跳过：给了版本只清该版本（面板「恢复」走这条），不给清全部。 */
export function clearSkipped(skipped: readonly SkippedVersionEntry[] | unknown, version?: string): SkippedVersionEntry[] {
  const base = normalizeSkipped({ skipped })
  if (version === undefined) return []
  return base.filter((entry) => entry.version !== version)
}

export interface SkipPortsDeps {
  readFileImpl?: (filename: string, encoding: string) => Promise<string>
  statImpl?: (filename: string) => Promise<{ size: number }>
}

/**
 * 建跳过存取：调用方按当前插件标识建一份（目录与任务落盘同一套，无旧影子）。
 * 读坏自愈为空（缺文件、超大、JSON 坏掉都回 []，绝不因跳过文件挡住更新）；
 * 写走原子整写。
 */
export function createSkipDiskPorts(
  homeDir: string,
  pluginId: string,
  profileDir: string,
  deps: SkipPortsDeps = {}
): {
  file: string | null
  readSkipped: () => Promise<SkippedVersionEntry[]>
  writeSkipped: (skipped: readonly SkippedVersionEntry[] | unknown) => Promise<void>
  clearSkippedVersion: (version?: string) => Promise<SkippedVersionEntry[]>
} {
  const paths = pathsForUpdate(homeDir, pluginId, profileDir)
  const file = paths ? join(paths.directory, SKIPPED_FILE) : null
  const readText = deps.readFileImpl ?? ((filename: string, encoding: string) => readFile(filename, encoding))
  const statFile = deps.statImpl ?? ((filename: string) => stat(filename))
  async function readSkipped(): Promise<SkippedVersionEntry[]> {
    if (!file) return []
    try {
      if ((await statFile(file)).size > 64 * 1024) return []
      return normalizeSkipped(JSON.parse(await readText(file, 'utf8')))
    } catch {
      // 自愈为空：缺文件、超大、JSON 坏掉、读失败都回 []，
      // 绝不因跳过文件挡住更新；下次写时整体覆盖。
      return []
    }
  }
  async function writeSkipped(skipped: readonly SkippedVersionEntry[] | unknown): Promise<void> {
    if (!file || !paths) throw fail('install-failed')
    const normalized = normalizeSkipped({ skipped })
    await mkdir(paths.directory, { recursive: true, mode: 0o700 })
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify({ skipped: normalized }, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
      await rename(temporary, file)
    } catch {
      throw fail('install-failed')
    } finally {
      await unlink(temporary).catch(() => {})
    }
  }
  async function clearSkippedVersion(version?: string): Promise<SkippedVersionEntry[]> {
    const next = clearSkipped(await readSkipped(), version)
    await writeSkipped(next)
    return next
  }
  return { file, readSkipped, writeSkipped, clearSkippedVersion }
}

/** 运行入口要反查的 CLI 包名（入口必须来自正在运行的这份 CLI）。 */
const CLI_PACKAGE_NAME = '@deepseek-ai/dsh'
/**
 * 安装子进程的流出置：输出只留一段有界缓冲（不读、不落盘），只看退出事实。
 * 必须是「有界收集」形状——子进程能力的 'pipe' 会没人读、'ignore' 不是它的合法取值。
 */
const INSTALL_STDIO = { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 64 * 1024 } }
/** 终止宽限期：先请进程树自己退，宽限到了再强杀（由子进程能力执行）。 */
const TERMINATION_GRACE_MS = 3000
/**
 * 桌面管理器的三条超时人话格（#184）：按「宿主有没有取消能力」与「卡在哪一步」分支，不许笼统。
 * 没取消能力就一次取消都没发过，不能说「已请求宿主取消」；移除步超时则要先说清包可能已被摘掉。
 */
const INSTALL_TIMEOUT_DETAIL = '安装超时，已请求宿主取消'
const INSTALL_TIMEOUT_NO_CANCEL_DETAIL = '安装超时；宿主未提供取消能力，这次安装可能仍在后台继续'
const REMOVE_TIMEOUT_DETAIL = '移除已装包超时，未继续安装；目标包可能已不在册，请重启宿主检查并按手工命令重装'
/**
 * 两步配方的第二次没成时要补的事实（#168）：移除已经成功，用户面对的不再是「装着旧版、可重试」，
 * 而是「什么都没装」——必须点明并给一条一定能用的重装命令，否则会把「摘掉了」当成「升级没成功」。
 */
const REINSTALL_AFTER_REMOVAL_DETAIL = '目标包已被宿主移除，重装失败；它现在不在使用范围里，请复制手工命令重新安装'
/**
 * 未选中的已装包要先恢复选中才能走宿主的两步配方（#201）：真机六个第三方插件都在
 * `dependencies` 里、却不在 `dsh.profile.bundles` 选中名单里，且仍在运行——宿主
 * `removeBundle` 只对选中的 bundle 先取消选中再重载卸载，未选中的包直接判 `bundle-in-use`。
 * 恢复选中本身也可能被宿主拖住，所以同样有额度与诚实超时口径。
 */
const ENABLE_TIMEOUT_DETAIL = '启用已装包超时，未继续安装；请在宿主插件页确认该插件已启用后重试'
/**
 * 宿主没有 `setBundleEnabled` 时的诚实原因（Spec 审查：不能再合成 `bundle-in-use` 冒充
 * 「还有别的层在用」——真实原因是宿主缺恢复选中的能力，和活 fiber 无关）。
 */
const ENABLE_UNSUPPORTED_DETAIL = '宿主不支持恢复选中，无法安全更新已装包，请用载体 CLI 原地更新'
/**
 * 这几种拒绝码说明「管理器通道对这个包走不通」：把一定能用的载体 CLI 命令补进人话格，
 * 用户不必再回面板翻手工命令（有些半装态下面板已经不给命令了，见 #168 同类处置）。
 */
const MANAGER_ROUTE_BLOCKED_CODES = new Set(['already-installed', 'bundle-in-use', 'not-removable'])
/**
 * 出口一（第三方 Desktop 的 desktopPnpm 服务）的三格（#193，审查 A 线 R3）：
 * 与出口二 #184 同一套纪律——宿主给了 terminate 才说「已请求终止」，没给就一次终止都没发过、
 * 安装可能还在后台跑；服务直接崩了也要如实说，不许伪装成超时。
 */
const SERVICE_TIMEOUT_DETAIL = '安装超时，已请求宿主终止'
const SERVICE_TIMEOUT_NO_TERMINATE_DETAIL = '安装超时；宿主未提供终止能力，这次安装可能仍在后台继续'
const SERVICE_CRASHED_DETAIL = '宿主安装服务异常退出'
/**
 * 出口三（cli-process）的三格（#185，审查 A 线 R4）：同一套纪律——到点先终止（`handle` 有
 * `terminate` 才真调）、再给终止宽限；没终止能力就如实说安装可能仍在后台；`done` reject 是崩溃
 * 不是超时，三者详情各说各的，不许再笼统成「装失败」。终止由本包直接对子进程调用，所以这里说
 * 「已终止子进程」而不是「已请求宿主终止」。
 */
const CLI_TIMEOUT_DETAIL = '安装超时，已终止子进程'
/** 没终止能力的说法与出口一（桌面服务）共用一条（字面一致，不复制第三份）。 */
const CLI_CRASHED_DETAIL = '宿主子进程能力异常，安装未完成'
/**
 * 到点后宽限内它自己收尾了（非零退出 / 崩溃）：超时仍是超时，但「可能仍在后台继续」已经不成立
 * （#185 Spec 审查：不许拿没发生的事实凑口径）。两个出口共用这句。
 */
const TIMEOUT_SETTLED_DETAIL = '安装超时；任务随后退出，安装未完成'
/**
 * 终止能力在、调用却抛错：不许说「已终止」，也不许甩锅「宿主未提供终止能力」（#185 Spec 审查）。
 */
const TERMINATE_FAILED_DETAIL = '安装超时；终止进程失败，这次安装可能仍在后台继续'

/** 执行零件可以是值，也可以是取值函数（桌面服务要等注入到位才能取）。 */
function part<T>(value: T | (() => T)): T {
  return typeof value === 'function' ? (value as () => T)() : value
}

function withExit(error: Error & { exitCode?: number }, exitCode: number | null): Error & { exitCode?: number } {
  if (typeof exitCode === 'number') error.exitCode = exitCode
  return error
}

/** 同一份目录：先按解析后的写法比，再问一次文件系统（能容下大小写与符号链接差异）。 */
async function sameDir(a: string, b: string): Promise<boolean> {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false
  try {
    if (resolve(a) === resolve(b)) return true
  } catch {
    return false
  }
  try {
    const pair = await Promise.all([realpath(a), realpath(b)])
    return pair[0] === pair[1]
  } catch {
    return false
  }
}

async function readManifestAt(directory: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * 从正在运行的入口反查 CLI 的 JS 入口：逐级向上找名字为 @deepseek-ai/dsh 的包，
 * 且该文件必须正好是包声明的可执行入口（bin.dsh 或 bin 字符串）。对不上就返回 null，
 * 绝不用 PATH 上的 `dsh` 命令名——否则可能装到别的使用范围或用错版本。
 * 第二参只给测试注入假清单读取器与假路径解析用（默认都走真文件系统）。
 */
export async function resolveCliEntry(
  argv1: string,
  deps: {
    readManifest?: (directory: string) => Promise<Record<string, unknown> | null>
    realpath?: (path: string) => Promise<string>
  } = {}
): Promise<string | null> {
  const readAt = typeof deps.readManifest === 'function' ? deps.readManifest : readManifestAt
  const realpathImpl = typeof deps.realpath === 'function' ? deps.realpath : realpath
  if (typeof argv1 !== 'string' || !argv1 || argv1.includes('\0')) return null
  let entry = ''
  try {
    entry = await realpathImpl(argv1)
  } catch {
    return null
  }
  if (typeof entry !== 'string' || !entry) return null
  let directory = dirname(entry)
  while (true) {
    let manifest: Record<string, unknown> | null = null
    try {
      manifest = await Promise.resolve()
        .then(() => readAt(directory))
        .catch(() => null)
    } catch {
      manifest = null
    }
    if (manifest && manifest.name === CLI_PACKAGE_NAME) {
      const bin = manifest.bin as unknown
      const declared = typeof bin === 'string' ? bin : bin && (bin as Record<string, unknown>).dsh
      if (typeof declared !== 'string' || !declared || isAbsolute(declared) || declared.includes('\0')) return null
      try {
        return (await realpathImpl(resolve(directory, declared))) === entry ? entry : null
      } catch {
        return null
      }
    }
    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}

export interface ExecutorParts {
  profileName?: string | null | (() => string | null)
  environmentKind?: EnvironmentKind | (() => EnvironmentKind)
  /** 版本通道：查用哪条，装就用哪条（#100：丢了它，预发布精确版在执行器回落 stable，白白 install-failed）。 */
  releaseChannel?: ReleaseChannel | (() => ReleaseChannel)
  profileDir?: string | (() => string)
  subprocess?: unknown | (() => unknown)
  desktopPnpm?: unknown | (() => unknown)
  desktopProfiles?: unknown | (() => unknown)
  /** 官方桌面版进程内的插件管理器（现取，不缓存跨代服务）。 */
  pluginManager?: unknown | (() => unknown)
  runtimeExecutable?: string | (() => string | undefined)
  runtimeExecArgs?: string[] | (() => string[] | undefined)
  cliEntry?: string | (() => string | undefined)
  targetPackageName?: string | (() => string)
  registryUrl?: string | (() => string)
  installTimeoutMs?: number | (() => number)
  pluginId?: string | (() => string)
  /**
   * 一次安装调用携带的「已批准构建脚本」名单（#194）：由执行器从 runInstall 入参归一带入，
   * 管理器路把它作为 `installBundle` 的 `approvedBuilds` 选项交回宿主（先批准再跑 pnpm）。
   * 只在本次调用内有效，不进任务、不落盘、不跨请求复用。
   */
  approvedBuilds?: string[]
  log?: (level: string, event: string, fields: Record<string, unknown>) => void
}

/**
 * 记一行安装执行的跨边界调用与结果（常驻事件，低频，只记路由与退出事实加插件标识）。
 * 日志里只记枚举与数字，不记命令、路径、使用范围名原文。
 */
function emitInstall(
  parts: ExecutorParts,
  recipe: { route: string } | null,
  ok: boolean,
  exitCode: number | null,
  durationMs: number
): void {
  const log = parts.log
  if (typeof log !== 'function') return
  try {
    const pluginId = part(parts.pluginId ?? null) as unknown
    log('info', LOG_EVENT_INSTALL_EXEC, {
      route: recipe ? recipe.route : 'none',
      ok: ok === true,
      exitCode: typeof exitCode === 'number' ? exitCode : null,
      durationMs,
      pluginId: typeof pluginId === 'string' ? pluginId : null,
    })
  } catch {}
}

/**
 * 执行现场的失败分类（#207 / 审查 S1-2）：路由分支早就知道「超时/崩溃/非零退出/起进程失败/
 * 终止失败/宿主拒绝」，以前只变成一句人话详情；现在把事实挂到抛错上，服务侧一条原因行即可落盘。
 * 只挂稳定枚举与数字，不碰错误码、消息与既有 detail 形状。
 */
function failExec(
  error: Error,
  facts: { reason: InstallFailFacts['reason']; code?: string; hostCode?: string; exitCode?: number | null }
): Error {
  return attachInstallFail(error, {
    stage: 'exec',
    reason: facts.reason,
    // 码格只收本包码面：执行器抛出的码是 install-failed；宿主自由标识走 hostCodeHash，不进这格。
    code: normalizeCode(facts.code ?? (error as { code?: unknown })?.code),
    hostCode: facts.hostCode ?? 'none',
    check: 'none',
    exitCode: typeof facts.exitCode === 'number' && Number.isInteger(facts.exitCode) ? facts.exitCode : null,
  })
}

/**
 * 桌面宿主：交给桌面端公开的 desktopPnpm 服务，由它用参数数组拉起打包好的 CLI。
 *
 * 出口一原来只 `await handle.done`、根本不执行安装时限（#193 / 审查 A 线 R3）：宿主服务不收尾，
 * 作业就永久停在 `installing`，之后所有动作 `update-busy`，用户只能在宿主重启前干等。
 * 这里照出口二（#184）的纪律：deadline + 终止（`handle` 有 `terminate` 才真调）+ 终止宽限 +
 * 诚实超时口径——没终止能力就如实说「这次安装可能仍在后台继续」，绝不谎称已请求终止。
 */
async function runDesktopService(
  recipe: { pluginArgs: string[]; profileName: string; timeoutMs: number },
  parts: ExecutorParts
): Promise<number | null> {
  const service = part(parts.desktopPnpm) as { runPlugin?: (args: string[], dir: string, extra: undefined) => { done: Promise<{ exitCode?: number }> } } | null
  if (!service || typeof service.runPlugin !== 'function') throw failExec(fail('install-failed'), { reason: 'spawn-failed' })
  const profiles = part(parts.desktopProfiles) as { current?: { dir?: string } } | null
  const active = profiles && profiles.current ? profiles.current : null
  const profileDir = part(parts.profileDir) as string
  // 桌面服务固定装进「当前激活的使用范围」，所以激活范围必须就是本插件所在的那个；
  // 对不上宁可不装（装错范围比装不上更糟），交回核心按诚实失败转手工命令。
  if (!active || !active.dir || !profileDir || !(await sameDir(active.dir, profileDir)))
    throw failExec(fail('install-failed'), { reason: 'spawn-failed' })
  const handle = service.runPlugin(recipe.pluginArgs, profileDir, undefined)
  if (!handle || !handle.done || typeof handle.done.then !== 'function') throw failExec(fail('install-failed'), { reason: 'spawn-failed' })
  // 双流由调用方负责读（契约）：先挂监听再等退出，失败原文才拿得到。
  const readOutput = streamCollectorOf(handle)
  const canTerminate = typeof (handle as { terminate?: unknown }).terminate === 'function'
  const terminate = canTerminate ? (handle as unknown as { terminate: () => void }).terminate : null
  let terminated = false
  let terminateFailed = false
  // 结局只分三种：自己收尾 / 崩了（done reject） / 到点；先把 reject 折成事实，不要让它冒充超时。
  const settled = Promise.resolve(handle.done).then(
    (value) => ({ kind: 'settled' as const, value }),
    () => ({ kind: 'crashed' as const, value: null })
  )
  const timeoutMs = typeof recipe.timeoutMs === 'number' && recipe.timeoutMs > 0 ? recipe.timeoutMs : 0
  const TIMEOUT = Symbol('install-timeout')
  let timer: ReturnType<typeof setTimeout> | null = null
  const outcome = await (async () => {
    if (timeoutMs === 0) return await settled
    const deadline = new Promise<typeof TIMEOUT>((settle) => {
      timer = setTimeout(() => {
        try {
          if (terminate !== null) {
            terminate.call(handle)
            terminated = true
          }
        } catch {
          terminateFailed = true
        }
        settle(TIMEOUT)
      }, timeoutMs)
    })
    try {
      return await Promise.race([settled, deadline])
    } finally {
      if (timer !== null) {
        try {
          clearTimeout(timer)
        } catch {}
      }
    }
  })()
  if (outcome === TIMEOUT) {
    // 到点时已经点过 terminate（有终止能力才会真调）；再给一段收尾宽限，拿到真实结局就按它自己的
    // 结局判——不把已经落地的改动记成失败（同出口二 finishCall 的宽限纪律）；口径仍点名超时，
    // 但按「终止是否真发出 / 任务是否已收尾」选词，不许拿没发生的事实凑（#185 Spec 审查）。
    const late = await settleWithin(settled, TERMINATION_GRACE_MS)
    const lateCode = late && late.kind === 'settled' ? (late.value && typeof late.value.exitCode === 'number' ? late.value.exitCode : null) : null
    if (late && late.kind === 'settled' && lateCode === 0) return 0
    const hint = timeoutHintOf(
      { terminated, ended: late !== null, terminateFailed },
      { terminated: SERVICE_TIMEOUT_DETAIL, noTerminate: SERVICE_TIMEOUT_NO_TERMINATE_DETAIL }
    )
    const excerpt = causeExcerptOf(readOutput())
    throw failExec(withDetail(withExit(fail('install-failed'), lateCode), excerpt ? withTimeoutHint(excerpt, hint) : hint), {
      reason: terminateFailed ? 'terminate-failed' : 'timeout',
      exitCode: lateCode,
    })
  }
  if (outcome.kind === 'crashed') {
    throw failExec(withDetail(fail('install-failed'), causeExcerptOf(readOutput()) || SERVICE_CRASHED_DETAIL), { reason: 'crashed' })
  }
  const code = outcome.value && typeof outcome.value.exitCode === 'number' ? outcome.value.exitCode : null
  if (code !== 0) throw failExec(withDetail(withExit(fail('install-failed'), code), causeExcerptOf(readOutput())), { reason: 'nonzero-exit', exitCode: code })
  return code
}

/**
 * 宿主管理器的回包（只声明本包用到的那几格）。
 * 出处：官方桌面版 `@deepseek-ai/dsh-plugin-manager` 的 ChangeResult；契约抄件见 docs/host-install-exits.md。
 */
interface ManagerChangeResult {
  application?: unknown
  error?: unknown
  /**
   * pnpm 的退出事实与原文就在这格（只抄本包用到的两格）：失败原文的唯一来源。
   * `exitCode` 是真跑过 pnpm 时的退出码（#R8 对抗审查：以前只抄 output，失败日志里
   * 真实退码被丢掉，一律记成 null——探针给 137 也一样）。
   */
  packageResult?: {
    output?: unknown
    exitCode?: unknown
    /**
     * 兼容性预检拒绝的明细（#195）：host 契约里与 `error.incompatible` 同形状，
     * `requirements` 的键是 `engines.dsh` 或 DSH peer 包名，值是不满足的范围；
     * `runtimeVersion` 是当前 DSH 版本。用来把「裸码」翻成「要求 ≥X（当前 Y）」。
     */
    incompatible?: unknown
  }
  /**
   * 待批准的构建脚本（#194）：宿主的 pnpm 失败且报告了「被忽略的构建脚本」时，会先把
   * `recordPendingBuilds()` 的结果（等待构建决策的精确包名）写进这一格再 throw；
   * 宿主的 `change()` 把部分结果折进 resolve 出来的失败回包，所以这格能到本包手里。
   * 重试时以 `approvedBuilds` 选项交回宿主（宿主先 approveBuilds 再跑 pnpm）。
   */
  pendingBuilds?: unknown
}

/** 成功三态：overridden 是「改动已被保留、只是被别的层盖住」，不是失败。 */
const MANAGER_OK = ['applied', 'restart-required', 'overridden']

function withDetail(error: Error & { detail?: string }, detail: string): Error & { detail?: string } {
  if (detail) error.detail = detail
  return error
}

/**
 * 脱敏规则表见 src/redaction.ts（#19）：五条具名规则 + 固定顺序 + 两占位符 + 空白边界封顶。
 * 本文件只经 `sanitizeDetail` 消费它（唯一自由文本出口），不自建规则、不做运行时事后扫描。
 */

/** 管理器失败时的 error 是普通对象（code／diagnostic），不是 Error；两种都要能读。 */
function detailText(error: unknown): string {
  if (typeof error === 'string') return sanitizeDetail(error)
  if (error instanceof Error) return sanitizeDetail(error.message)
  if (error && typeof error === 'object') {
    const shape = error as { code?: unknown; diagnostic?: unknown; message?: unknown }
    const code = typeof shape.code === 'string' ? shape.code : ''
    const said = typeof shape.diagnostic === 'string' ? shape.diagnostic : typeof shape.message === 'string' ? shape.message : ''
    const line = [code, said].filter(Boolean).join(': ')
    if (line) {
      const clean = sanitizeDetail(line)
      // 脱敏已改成「只遮盖 userinfo、保留其余原文 + 末尾声明」（#198），正常不会回空串。
      // 仍留一道兜底：万一 line 被收成空，退到 code 本身，绝不把空详情当成功。
      if (clean) return clean
      if (code) return sanitizeDetail(code)
      return ''
    }
    try {
      return sanitizeDetail(JSON.stringify(error))
    } catch {
      return sanitizeDetail(String(error))
    }
  }
  return error === undefined || error === null ? '' : sanitizeDetail(String(error))
}

/** 抓取读数上限（与 INSTALL_STDIO 同一 64 KiB 口径）：够挑出错误码行即可，不留整段日志。 */
const COLLECT_MAX_BYTES = 64 * 1024

/**
 * 安装原文里「签名行」的样子：装的是谁、何时发布、门限几时到、以及 pnpm 的错误码。
 * 认因（src/install-cause.ts）要的是整条签名，不是单独一个错误码。
 */
const CAUSE_SIGNATURE_LINE = /ERR_PNPM_[A-Z0-9_]+|(^|\s)ERR!|published|cutoff|minimumReleaseAge|Cannot install/i

/**
 * 从安装输出里挑出「因」：三条宿主路其实都把 pnpm 原文交给我们（cli 路的抓取读数、
 * 桌面服务路的双流、管理器路的 packageResult.output），但 detail 封顶只有 300 字，
 * 而 pnpm 把错误码打在日志尾巴上——先挑错误码行（连带紧邻上面的签名行），
 * 挑不到退最后一段，原文才活得到面板。
 * 脱敏仍只经唯一出口 sanitizeDetail。
 * 2026-10-17 对抗审查（#156）：这格此前无人生产，24h 年龄门的原文到不了面板，
 * 「装合规版」四个入口在生产形状下全都认不出因；第四轮又发现真报文是分行的
 * （签名在上、错误码单独在最后一行），只取错误码行等于把签名丢掉，故一并收签名行。
 */
function causeExcerptOf(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.replace(/\r\n?/g, '\n').trim() : ''
  if (!text) return ''
  const lines = text.split('\n')
  const at = lines.findIndex((line) => /ERR_PNPM_[A-Z0-9_]+|(^|\s)ERR!/.test(line))
  if (at >= 0) {
    // 错误码行未必自带因：pnpm 也把「装的是谁、何时发布、门限几时到」留在上面几行，
    // 错误码单独打在最后一行。认因要的是整条签名，光揣一个错误码等于没认出因——
    // 所以把紧邻上面的签名行一并收进来（2026-10-17 #156 第四轮：真机形状就是这种分行的）。
    const above: string[] = []
    for (let i = at - 1; i >= 0 && above.length < 2; i--) {
      const line = lines[i].trim()
      if (line && CAUSE_SIGNATURE_LINE.test(line)) above.unshift(line)
    }
    const picked = [...above, ...lines.slice(at, at + 3).map((line) => line.trim()).filter(Boolean)].join(' ')
    return sanitizeDetail(picked)
  }
  // 挑不到错误码行：从最后一行往前收（pnpm 把结论打在最后），最近的一行放最前，
  // 重复的进度行只留一次——既不丢结论，也不把开头那句进度日志当因。
  const picked: string[] = []
  let size = 0
  for (let i = lines.length - 1; i >= 0 && size < DETAIL_MAX_CHARS; i--) {
    const line = lines[i].trim()
    if (!line || picked.includes(line)) continue
    picked.push(line)
    size += line.length + 1
  }
  return picked.length === 0 ? '' : sanitizeDetail(picked.join(' '))
}

/**
 * cli 路：宿主 subprocess 的抓取读数。契约（@deepseek-ai/dsh-subprocess README）：
 * `spawn({ …, stdio: { stdin:'ignore', stdout:{ maxBytes }, … } })` 后
 * `handle.collected.stdout?.readFrom(0)` → `{ text, lossy, spillPath? }`，**退出后仍可读**；
 * `done` 只报退出事实。老宿主/假件没有这格 → 空串，不炸、不猜。
 */
function collectedOutputOf(handle: unknown): string {
  const collected = (handle as { collected?: { stdout?: unknown; stderr?: unknown } } | null)?.collected
  const parts: string[] = []
  for (const stream of [collected?.stderr, collected?.stdout]) {
    try {
      const read = (stream as { readFrom?: (offset: number) => { text?: unknown } } | null)?.readFrom?.(0)
      if (read && typeof read.text === 'string' && read.text) parts.push(read.text)
    } catch {}
  }
  return parts.join('\n')
}

/**
 * 桌面服务路：契约给的 `handle.stdout/stderr` 双流由**调用方自己读**（不读就永远没有原文）。
 * 先要 utf8 文本（流是宿主的，能要就要），再挂 data 监听、只留前 64 KiB；
 * 读失败一律吞掉，不影响成败判定。
 */
function streamCollectorOf(handle: unknown): () => string {
  const chunks: string[] = []
  let kept = 0
  const shape = handle as { stdout?: unknown; stderr?: unknown } | null
  const attach = (stream: unknown): void => {
    const on = (stream as { on?: (event: string, cb: (chunk: unknown) => void) => unknown } | null)?.on
    if (typeof on !== 'function') return
    const setEncoding = (stream as { setEncoding?: (encoding: string) => unknown } | null)?.setEncoding
    try {
      if (typeof setEncoding === 'function') setEncoding.call(stream, 'utf8')
    } catch {}
    try {
      on.call(stream, 'data', (chunk: unknown) => {
        if (kept >= COLLECT_MAX_BYTES) return
        const text = typeof chunk === 'string' ? chunk : String(chunk ?? '')
        if (!text) return
        kept += text.length
        chunks.push(text)
      })
    } catch {}
  }
  attach(shape?.stderr)
  attach(shape?.stdout)
  return () => chunks.join('')
}

/**
 * 管理器只吃一个 spec 字符串；配方给的就是 ['add', spec]，别的形状一律不试也不猜。
 * 编码处见 src/commands.ts 的 installRecipe——改这条形状要同时改两处（五键冻结，只能这样传）。
 */
function managerSpecOf(pluginArgs: string[]): string | null {
  if (!Array.isArray(pluginArgs) || pluginArgs.length !== 2) return null
  const [verb, spec] = pluginArgs
  if (verb !== 'add' || typeof spec !== 'string' || !spec || spec.startsWith('-')) return null
  return spec
}

/**
 * 拼「宿主原文；下一步」并守住 detail 的 300 字：原文在前、建议在后。
 * 超长时剪原文的尾巴，但不把脱敏核追加在末尾的「（原话里的账号密码已隐去…）」说明剪半
 * （ADR-0001 决策 2：被替换过的文本必须仍能与原样文本区分）。
 */
function withTrailingHint(said: string, hint: string): string {
  if (!hint) return said
  const room = DETAIL_MAX_CHARS - hint.length - 1
  if (room <= 0) return hint
  const head = said.length > room ? clipDetailForHint(said, room) : said
  return head ? `${head}；${hint}` : hint
}
function clipDetailForHint(said: string, room: number): string {
  const noteSuffix = `；${MASKED_CREDENTIAL_NOTE}`
  if (said.endsWith(noteSuffix) && room > noteSuffix.length + 1) {
    const cut = room - noteSuffix.length - 1
    return `${said.slice(0, cut)}…${noteSuffix}`
  }
  return said.slice(0, room)
}
/** 拼「宿主原文；超时/崩溃口径」：原文在前、下一步在后，总长仍守 detail 的 300 字（#193）。 */
function withTimeoutHint(said: string, hint: string): string {
  return withTrailingHint(said, hint)
}
/**
 * 到点后按「终止是否真发出 / 任务是否已收尾」挑人话格：三者互斥，不许拿没发生的事实凑口径。
 * `terminated` = terminate 真的调成功；`ended` = 宽限内自己收尾（含崩溃）；
 * `terminateFailed` = 有终止能力但调用抛错。
 */
function timeoutHintOf(
  facts: { terminated: boolean; ended: boolean; terminateFailed: boolean },
  wording: { terminated: string; noTerminate: string }
): string {
  if (facts.terminated) return wording.terminated
  if (facts.ended) return TIMEOUT_SETTLED_DETAIL
  if (facts.terminateFailed) return TERMINATE_FAILED_DETAIL
  return wording.noTerminate
}
/** 等管理器回话：带时限；到点先请它取消（能不能取消由它答），再由调用方决定怎么收场。 */
async function raceManager(
  running: Promise<ManagerChangeResult>,
  timeoutMs: number,
  requestCancel: () => Promise<unknown>
): Promise<{ timedOut: false; value: ManagerChangeResult } | { timedOut: true }> {
  const settled = Promise.resolve(running).then((value) => ({ timedOut: false as const, value }))
  if (!(typeof timeoutMs === 'number' && timeoutMs > 0)) return await settled
  const TIMEOUT = Symbol('install-timeout')
  let timer: ReturnType<typeof setTimeout> | null = null
  const deadline = new Promise<typeof TIMEOUT>((settle) => {
    timer = setTimeout(() => settle(TIMEOUT), timeoutMs)
  })
  let winner: { timedOut: false; value: ManagerChangeResult } | typeof TIMEOUT
  try {
    winner = await Promise.race([settled, deadline])
  } finally {
    if (timer !== null) {
      try {
        clearTimeout(timer)
      } catch {}
    }
  }
  if (winner !== TIMEOUT) return winner
  await requestCancel()
  return { timedOut: true }
}

/** 宽限期内等它自己收尾：到点还没落定就回 null（调用方自己做诚实失败）。中途抛错照样往外抛。 */
async function settleWithin<T>(promise: Promise<T>, graceMs: number): Promise<T | null> {
  if (!(typeof graceMs === 'number' && graceMs > 0)) return null
  const EXPIRED = Symbol('grace-expired')
  let timer: ReturnType<typeof setTimeout> | null = null
  const deadline = new Promise<typeof EXPIRED>((settle) => {
    timer = setTimeout(() => settle(EXPIRED), graceMs)
  })
  try {
    const winner = await Promise.race([promise, deadline])
    return winner === EXPIRED ? null : (winner as T)
  } finally {
    if (timer !== null) {
      try {
        clearTimeout(timer)
      } catch {}
    }
  }
}

/** 管理器只吃一个 spec 字符串；包名就是最后一个 '@' 之前那段（`@scope/name@1.2.3` → `@scope/name`）。 */
function managerPackageNameOf(spec: string): string {
  const at = spec.lastIndexOf('@')
  return at > 0 ? spec.slice(0, at) : ''
}

/**
 * 宿主在 HMR 宿主上对「已经装着的包」的同步拒绝：`application:'failed'` + `error.code === 'already-installed'`。
 * 它在 pnpm 之前就回，所以没有子进程、也没有操作日志——只有回包能认出来。
 */
function managerSaidAlreadyInstalled(result: ManagerChangeResult): boolean {
  if (!result || typeof result.application !== 'string' || result.application !== 'failed') return false
  const error = result.error
  if (!error || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code === 'already-installed'
}

/**
 * 管理器 `listBundles()` 的包拓扑（本包只需两格，其余一律不看）：
 * - `enabled`：是否在 `dsh.profile.bundles` 选中名单里——宿主只对选中的 bundle 做卸载重载；
 * - `removable`：宿主是否允许移除。官方桌面版里第三方包的 `removable = installed && !shipped`。
 */
interface ManagerBundleTopology {
  /** 选中名单成员；`null` 表示宿主这一版没给这格（不拿缺省当否，避免误改用户拓扑）。 */
  enabled: boolean | null
  /** 是否允许移除；`null` 表示宿主没给这格（不拿缺省当拒绝，避免误报 `not-removable`）。 */
  removable: boolean | null
}

/** 宿主证据只见过「直接回数组」一种形状；别的形状当没有（调用方退回旧两步，不猜）。 */
function managerBundleRowsOf(said: unknown): Record<string, unknown>[] {
  if (!Array.isArray(said)) return []
  return said.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
}

/**
 * 为「更新一个已在册的包」探一次宿主拓扑（#201）。管理器没有 `listBundles`、或调用失败、
 * 或清单里找不到这个包，都回 null——调用方退回旧两步配方，不拿猜测代替探测。
 */
async function probeManagerTopology(
  manager: { listBundles?: () => unknown },
  name: string
): Promise<ManagerBundleTopology | null> {
  const listBundles = manager.listBundles
  if (typeof listBundles !== 'function') return null
  let said: unknown
  try {
    said = await listBundles.call(manager)
  } catch {
    return null
  }
  const row = managerBundleRowsOf(said).find((item) => item.name === name)
  if (!row) return null
  // 三态归一：宿主明确给了布尔值才采信，缺格/异形一律 `null`（调用方只对明确的 false 动作）。
  const tri = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null)
  return { enabled: tri(row.enabled), removable: tri(row.removable) }
}

/**
 * 载体 CLI 的原位更新命令（官方桌面版自带 `dsh plugin --profile <名> …` 通道，参数逐字转给 pnpm）。
 *
 * 形状与 `src/commands.ts` 的 `manualCommand` 同源（`add --save-exact <包>@<版本> --registry=<源>`）：
 * 管理器配方自己的 `pluginArgs` 只有「add + spec」两个元素（它不接受开关），所以这里按包名与源
 * 重新拼成命令行能直接执行的形状；源未知时不附 `--registry=`（用户也可自行去掉）。
 * 管理器路的三个位置（启用缺失、移除超时、重装失败）共用这一份实现，避免各行拼出不同命令。
 *
 * 插值只走 `shellSafeArg` 的保守白名单（与 `manualCommand` 同一政策）：使用范围名 / 源 / 规格
 * 含空白、`$`、反引号、引号、`&` 等任意一个就返回 null——**宁可不出命令，也不出会被 shell
 * 展开、截断或悄悄换源的假命令**（对抗审查 HARD：`JSON.stringify` 不是 shell 引号）。
 */
function carrierAddCommand(profileName: string, spec: string, registry: string | null): string | null {
  const arg = shellSafeArg(profileName)
  const named = shellSafeArg(spec)
  if (!arg || !named) return null
  if (registry === null) return `dsh plugin --profile ${arg} add --save-exact ${named}`
  const source = shellSafeArg(registry)
  if (!source) return null
  return `dsh plugin --profile ${arg} add --save-exact ${named} --registry=${source}`
}

/**
 * 载体 CLI 的构建批准命令（#194）：`dsh plugin` 把参数逐字转给 pnpm，所以
 * `approve-builds` 就是宿主自带 CLI 的批准通道（交互式列出现有清单）。插值同
 * {@link carrierAddCommand}：使用范围名不安全就不出命令，绝不拼半句。
 */
function carrierApproveBuildsCommand(profileName: string): string | null {
  const arg = shellSafeArg(profileName)
  if (!arg) return null
  return `dsh plugin --profile ${arg} approve-builds`
}

/**
 * 待批构建名单的建议候选（#194）：名单从「全点名」逐级退让到「首个 等 N 个」，
 * 但**每一条候选都带着能走的批准路径**——长名单也不能只剩一句「去宿主页批准」。
 * 只负责措辞，不做过滤——名单进来前已经过 `normalizeApprovedBuilds`。
 *
 * Spec 审查 HARD：旧实现只在第一条候选里带 CLI 命令，名单一长就落到没有命令的短句，
 * 而宿主页的批准入口只在它自己的安装失败页出现，本包的 `updateInstall` 走不到——
 * 等于告诉用户一个不存在的按钮。现在命令（或没有命令时的宿主页说法）是每条的固定部分，
 * 变的是点名多少个包。
 */
function pendingBuildsAdviceCandidates(names: string[], approveCommand: string | null): string[] {
  if (names.length === 0) return []
  const total = names.length
  const suffix = approveCommand
    ? `；请先批准构建脚本（运行 ${approveCommand}），再重试本次安装`
    : '；请先在宿主的插件管理里批准该包的构建脚本，再重试'
  const candidates: string[] = []
  for (let count = total; count >= 1; count -= 1) {
    const list = count === total ? names.join('、') : `${names.slice(0, count).join('、')} 等 ${total} 个`
    candidates.push(`需要批准构建脚本：${list}${suffix}`)
  }
  candidates.push(`有构建脚本被忽略${suffix}`)
  return candidates
}

/**
 * 摘掉人话格里业已存在的构建批准建议（#194）：两段式路径上 `failureOf` 会在尾部补一次，
 * 而 `withRemovalFact` 要按「原话 → 批准建议 → 移除事实」重新排版，避免重复与位置丢失。
 */
function stripPendingBuildsAdvice(detail: string): string {
  const marker = detail.search(/[；]?(?:需要批准构建脚本：|有构建脚本被忽略|安装脚本需要批准（pendingBuilds）)/u)
  return marker >= 0 ? detail.slice(0, marker) : detail
}

/**
 * 把「需要批准的构建脚本」点名到人话格里（#194）：宿主原话在前、本包建议在后。
 *
 * 名单是宿主 `recordPendingBuilds` 给的精确包名（调用方已归一，这里按同一白名单再兜底一遍），
 * 通配规则与开关样式不进文案。文案按预算退让：全名单 → 少点几个名 → 「首个 等 N 个」→
 * 「有构建脚本被忽略」；**无论退到哪一级，批准路径（CLI 命令，或没有命令时的宿主页说法）
 * 都保留**。宿主码 `build-blocked` 自带的通用建议会被本函数的具体建议取代（同义不重复）。
 */
function withPendingBuildsHint(
  error: Error & { detail?: string },
  names: string[],
  approveCommand: string | null
): Error & { detail?: string } {
  const candidates = pendingBuildsAdviceCandidates(names, approveCommand)
  if (candidates.length === 0) return error
  const said = stripPendingBuildsAdvice(typeof error.detail === 'string' ? error.detail : '')
  for (const hint of candidates) {
    const room = DETAIL_MAX_CHARS - hint.length - 1
    if (room < 0) continue
    const head = said.length > room ? said.slice(0, room) : said
    return withDetail(error, head ? `${head}；${hint}` : hint)
  }
  // 候选里最短的一条仍超预算（理论上不会：最后一条是固定短句）——只留截断原文，绝不越界。
  return withDetail(error, said.slice(0, DETAIL_MAX_CHARS))
}

/**
 * 无条件把载体 CLI 命令补在详情尾部（启用步用：这一步的失败没有宿主拒绝码可判，但用户
 * 同样需要「换通道」的下一步）。原文在前、总长守 DETAIL_MAX_CHARS；命令本身超预算时
 * 宁可只留原文，绝不输出越界详情（Spec 审查：room<=0 曾把全文拼回去）。
 * 命令为 null（插值不安全，见 `carrierAddCommand`）时一字不加；原文里已经带过同一条命令时
 * 也不重复补（重装失败先经 `failureOf`、再经 `withRemovalFact` 的两段式路径）。
 */
function withCarrierHint(error: Error & { detail?: string }, command: string | null): Error & { detail?: string } {
  if (command === null) return error
  const said = typeof error.detail === 'string' ? error.detail : ''
  if (said.includes(command)) return error
  const suffix = ` (${command})`
  const room = DETAIL_MAX_CHARS - suffix.length - 1
  if (room <= 0) return withDetail(error, said.slice(0, DETAIL_MAX_CHARS))
  const head = said.length > room ? said.slice(0, room) : said
  return withDetail(error, head ? `${head}${suffix}` : suffix.trim())
}

/**
 * 管理器通道明确走不通时，把载体 CLI 的原位更新命令补在宿主原话之后（原文在前、建议在后）。
 */
function withManagerRetryHint(
  error: Error & { detail?: string },
  result: ManagerChangeResult,
  command: string | null
): Error & { detail?: string } {
  const code = managerCodeOf(result)
  if (!MANAGER_ROUTE_BLOCKED_CODES.has(code)) return error
  return withCarrierHint(error, command)
}

/**
 * 管理器拒绝码的「下一步」翻译（#R1 对抗审查，S2「报错无下一步」）。
 *
 * 宿主自己有一张 ERROR_STEPS 表（`asar:…/dsh-plugin-manager/lib/types/tools.js:7-21`）给每个拒绝码
 * 写了下一步，但那是写给模型看的英文。本包把用户真会撞上的几码翻成一行中文动作，**拼在宿主原话后面**：
 * 原文永远在前（出事时还能按码搜索/报给宿主），建议永远在后；认不出的码一句不加，绝不替宿主编原因。
 * 只覆盖管理器路会原样透出的那几码（A 线探针逐个撞过）。
 */
const MANAGER_CODE_HINTS: Record<string, string> = {
  'already-installed': '宿主不支持自动移除重装，请复制手工命令在桌面 CLI 里更新',
  'not-removable': '宿主把这个包标为不可移除，请复制手工命令在桌面 CLI 里更新',
  'management-required': '这个条目归宿主插件管理本体所有，不能在这里更新',
  'not-bundle': '这个包没有声明 dsh.bundle，不能当作插件管理',
  'bundle-in-use': '还有别的层在用这个插件，请先在宿主插件页停用后再更新',
  'stop-profile': '这个使用范围没有 HMR，请停掉 DSH 后在命令行更新',
  'stale-approval': '构建批准名单已过期（宿主已重新记录），请重新发起更新，不要沿用上次的批准名单',
  'incompatible-version': '新版本与当前 DSH 不兼容，请先升级 DSH 再更新',
  'build-blocked': '安装脚本需要批准（pendingBuilds），请在宿主插件页批准构建后重试',
  'pnpm-missing': '宿主找不到 pnpm，请先安装 pnpm',
  'disk-full': '磁盘空间不足，腾出空间后重试',
  permission: '宿主写不了使用范围目录，修好权限后重试',
}

/** 从管理器回包的 error 里读本包认识的那一格（只认字符串 code，别的一律当没有）。 */
function managerCodeOf(result: ManagerChangeResult): string {
  const error = result ? result.error : undefined
  if (!error || typeof error !== 'object') return ''
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : ''
}

/** 拼「宿主原话；下一步」，总长仍守 detail 的 300 字：原文优先，建议让位。 */
function withManagerHint(result: ManagerChangeResult, said: string): string {
  const code = managerCodeOf(result)
  const hint = code ? MANAGER_CODE_HINTS[code] ?? '' : ''
  return withTrailingHint(said, hint)
}

/**
 * 宿主拒绝 `incompatible-version` 的明细（#195）：`incompatible[]` 每项带 `requirements`
 * （键是 `engines.dsh` 或 DSH peer 包名，值是不满足的范围）与 `runtimeVersion`（当前 DSH 版本）。
 * 只翻看得懂的形状；认不出即空串——绝不替宿主编原因、不编造要求。
 */
function incompatibleFactOf(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const facts: string[] = []
  for (const raw of value.slice(0, 2)) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as { name?: unknown; runtimeVersion?: unknown; requirements?: unknown }
    const requirements = entry.requirements
    if (!requirements || typeof requirements !== 'object' || Array.isArray(requirements)) continue
    const runtime = typeof entry.runtimeVersion === 'string' && entry.runtimeVersion.trim() ? entry.runtimeVersion.trim() : ''
    const who = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : ''
    const keys = Object.keys(requirements as Record<string, unknown>).slice(0, 2)
    for (const key of keys) {
      const range = (requirements as Record<string, unknown>)[key]
      if (typeof range !== 'string' || !range.trim()) continue
      const what = key === 'engines.dsh' ? 'DSH' : key
      const current = runtime ? `（当前 ${runtime}）` : ''
      facts.push(`要求 ${who ? `${who} 的 ` : ''}${what} ${range.trim()}${current}`)
    }
  }
  return facts.slice(0, 2).join('；')
}

/**
 * 把「要求 ≥X（当前 Y）」补在宿主原话与既有建议之后（#195，验收：详情/面板点明要求与当前版本）。
 * 原文永远在前、建议在后；总长仍守 DETAIL_MAX_CHARS；没有可翻译的 incompatible[] 时一字不加。
 */
function withIncompatibleFact(error: Error & { detail?: string }, result: ManagerChangeResult): Error & { detail?: string } {
  if (managerCodeOf(result) !== 'incompatible-version') return error
  const fromError = result?.error && typeof result.error === 'object' ? (result.error as { incompatible?: unknown }).incompatible : undefined
  // 宿主给的 name / requirements / runtimeVersion 也是外部文本：照旧走唯一自由文本出口脱敏。
  const fact = sanitizeDetail(incompatibleFactOf(fromError !== undefined ? fromError : result?.packageResult?.incompatible))
  if (!fact) return error
  const said = typeof error.detail === 'string' ? error.detail : ''
  const room = DETAIL_MAX_CHARS - fact.length - 1
  if (room <= 0) return error
  const head = said.length > room ? said.slice(0, room) : said
  return withDetail(error, head ? `${head}；${fact}` : fact)
}

/**
 * 移除已成功、重装却没成（失败或超时）：在宿主原话之后补「目标包已被摘掉」这条事实与一条
 * 一定能用的重装命令（#168）。原文在前、本包补记在后，总长仍守 DETAIL_MAX_CHARS。
 * 命令为 null（插值不安全）时只说事实；原文里已经带过同一条命令时不再重复拼。
 *
 * #194：第二次安装也可能失败在「需要批准的构建脚本」上。这里按「原话 → 批准建议 → 移除事实」
 * 重新排版并**同时保住两条事实**——不能像从前那样从头截断原话而把尾部的批准建议切掉
 * （对抗审查 HARD：真机最常走的「更新已装包」正是这条路径）。
 */
function withRemovalFact(
  error: Error & { detail?: string },
  command: string | null,
  pendingBuilds: { names: string[]; approveCommand: string | null } = { names: [], approveCommand: null }
): Error & { detail?: string } {
  const said = stripPendingBuildsAdvice(typeof error.detail === 'string' ? error.detail : '')
  const withCommand = command !== null && !said.includes(command)
  const fact = withCommand ? `${REINSTALL_AFTER_REMOVAL_DETAIL} (${command})` : REINSTALL_AFTER_REMOVAL_DETAIL
  // 两条事实并存时先挑一条放得下的批准建议；候选顺序本身就是优先级（完整名单优先）。
  for (const advice of pendingBuildsAdviceCandidates(pendingBuilds.names, pendingBuilds.approveCommand)) {
    const room = DETAIL_MAX_CHARS - fact.length - advice.length - 2
    if (room < 0) continue
    const head = said.length > room ? said.slice(0, room) : said
    return withDetail(error, head ? `${head}；${advice}；${fact}` : `${advice}；${fact}`)
  }
  const room = DETAIL_MAX_CHARS - fact.length - 1
  // 命令/事实本身就超预算时宁可丢补充事实也不越界：原文截到上限，绝不输出超长详情。
  if (room <= 0) return withDetail(error, said.slice(0, DETAIL_MAX_CHARS))
  const head = said.length > room ? said.slice(0, room) : said
  return withDetail(error, head ? `${head}；${fact}` : fact)
}

/**
 * 官方桌面版：把安装交给宿主进程内的插件管理器（`ctx.get('pluginManager')`）。
 *
 * 与命令行那条同政策：精确版本、官方源（走管理器的 registry 选项）、超时即终止（请求取消）。
 * 管理器**预期失败不 reject**——它 resolve 出 `application:'failed'` 加 `error`，所以成败只看
 * `application`，不看有没有抛异常；抛出来的只有「管理器自己挂了」这类意外。
 * 成败与失败原话按合同收成一行（截断脱敏），挂在抛出的错上由上层决定给谁看。
 *
 * 更新一个已在册的包要按宿主自己的 two-step 配方走：HMR 宿主里 `installBundle` 对已装包在跑
 * pnpm 之前就同步拒绝 `already-installed`（宿主自己的 next-step 表：先移除再装），本包若只调
 * `installBundle`，更新就永远停在这句拒绝上。所以命中这个拒绝时先按包名 removeBundle，再带新
 * requestId 装一次；别的失败一律不碰移除。四条宿主调用（首装、启用、移除、重装）共用配方里的
 * 一个超时额度，总上界不因多一步放宽。
 */
async function runDesktopManager(recipe: InstallRecipe, parts: ExecutorParts): Promise<number | null> {
  try {
    const manager = part(parts.pluginManager ?? null) as {
      installBundle?: (
        spec: string,
        options: { requestId: string; registry?: string; approvedBuilds?: string[] }
      ) => unknown
      cancelInstall?: (requestId: string) => unknown
      removeBundle?: (name: string) => unknown
      /** 拓扑探测（#201）：已装包是否在宿主选中名单里、能不能移走。老宿主没有这格。 */
      listBundles?: () => unknown
      /** 恢复选中（#201）：官方桌面版用它把「装着但未选中」的 bundle 放回选中名单。 */
      setBundleEnabled?: (name: string, enabled: boolean) => unknown
    } | null
    if (!manager || typeof manager.installBundle !== 'function') throw failExec(fail('install-failed'), { reason: 'spawn-failed' })
    // 取成常量再 `.call(manager, …)`：闭包里属性收窄会丢，this 也必须还是管理器自己。
    const installBundle = manager.installBundle
    const spec = managerSpecOf(recipe.pluginArgs)
    if (!spec) throw failExec(fail('install-failed'), { reason: 'spawn-failed' })
    // 使用范围名取配方自己的（`installRecipe` 已在入口归一过），注入值只作老调用形状的兜底。
    const profileName = part(parts.profileName ?? null)
    const profileArg =
      typeof recipe.profileName === 'string' && recipe.profileName
        ? recipe.profileName
        : typeof profileName === 'string' && profileName
          ? profileName
          : 'desktop'
    const registry = part(parts.registryUrl ?? '') as unknown
    // 批准名单（#194）：执行器已归一带入；这里再归一一次，保证交给宿主的永远是安全包名数组。
    const approvedBuilds = normalizeApprovedBuilds(part(parts.approvedBuilds ?? []))
    const carrierCommand = carrierAddCommand(
      profileArg,
      spec,
      typeof registry === 'string' && registry ? registry : null
    )
    // 源不进参数数组（管理器不吃开关），走它自己的 registry 选项，取同一个注入值；
    // 批准名单（#194）同理走宿主选项：installBundle 会先 approveBuilds 再跑 pnpm。
    const optionsFor = (requestId: string): { requestId: string; registry?: string; approvedBuilds?: string[] } => {
      const options: { requestId: string; registry?: string; approvedBuilds?: string[] } = { requestId }
      if (typeof registry === 'string' && registry) options.registry = registry
      if (approvedBuilds.length > 0) options.approvedBuilds = approvedBuilds
      return options
    }
    // 一个配方额度管四条宿主调用（首装／启用／移除／重装）：每步只领剩下的，领完给 1ms 让 raceManager 走自己的超时收场。
    const budgetMs = typeof recipe.timeoutMs === 'number' && recipe.timeoutMs > 0 ? recipe.timeoutMs : 0
    const deadline = budgetMs > 0 ? Date.now() + budgetMs : 0
    const stepTimeoutMs = (): number => (budgetMs > 0 ? Math.max(1, deadline - Date.now()) : recipe.timeoutMs)
    // 取消能力是超时文案的前提（#184）：宿主没给 cancelInstall 时我们一次取消都没发过，
    // 文案不许写「已请求宿主取消」；还要提示这类宿主里超时的安装可能仍在后台跑完（被告知失败、实际装上）。
    const cancelInstall = typeof manager.cancelInstall === 'function' ? manager.cancelInstall : null
    const cancelInstallOf = async (requestId: string): Promise<string> => {
      if (cancelInstall === null) return 'not-running'
      try {
        const answer = (await cancelInstall.call(manager, requestId)) as { status?: unknown } | null
        const status = answer && typeof answer.status === 'string' ? answer.status : ''
        return status === 'cancelled' || status === 'too-late' ? status : 'not-running'
      } catch {
        return 'not-running'
      }
    }
    // 超时且已经点过取消。可能是「刚好装完、还没报到」的竞态，所以再给一个终止宽限期
    // 等它自己收尾，按它自己的结局判——不把已经落地的改动记成失败。
    const finishCall = async (
      running: Promise<ManagerChangeResult>,
      requestCancel: () => Promise<string>,
      timeoutDetail: string
    ): Promise<ManagerChangeResult> => {
      const outcome = await raceManager(running, stepTimeoutMs(), requestCancel)
      if (!outcome.timedOut) return outcome.value
      const settled = await settleWithin(running, TERMINATION_GRACE_MS)
      if (!settled) {
        void running.catch(() => {})
        throw failExec(withDetail(fail('install-failed'), timeoutDetail), { reason: 'timeout' })
      }
      return settled
    }
    const installTimeoutDetail = cancelInstall !== null ? INSTALL_TIMEOUT_DETAIL : INSTALL_TIMEOUT_NO_CANCEL_DETAIL
    const installOnce = async (): Promise<ManagerChangeResult> => {
      const requestId = randomUUID()
      const running = Promise.resolve(installBundle.call(manager, spec, optionsFor(requestId))) as Promise<ManagerChangeResult>
      return await finishCall(running, () => cancelInstallOf(requestId), installTimeoutDetail)
    }
    const failureOf = (result: ManagerChangeResult, application: string): Error => {
      if (application === 'cancelled')
        return failExec(withDetail(fail('install-failed'), '安装已被取消'), { reason: 'host-rejected', hostCode: 'cancelled' })
      // 失败原文优先取 packageResult.output（契约里 pnpm 的原话就在那格，error 只有 code/diagnostic）；
      // 取不到才退回 error 的短码。挑因与封顶口径同另两条路。
      const rawOutput = result && result.packageResult && typeof result.packageResult.output === 'string' ? result.packageResult.output : ''
      const said = rawOutput.trim()
        ? causeExcerptOf(rawOutput)
        : detailText(result && result.error !== undefined ? result.error : `application: ${application || 'unknown'}`)
      // 真跑过 pnpm 的失败要带真实退码出去（#R8）：exec 日志那格与另两条路由同口径，不许一律 null。
      const failure = fail('install-failed')
      const rawCode = result && result.packageResult ? result.packageResult.exitCode : undefined
      const coded = typeof rawCode === 'number' && Number.isInteger(rawCode) ? withExit(failure, rawCode) : failure
      const withHints = withIncompatibleFact(withManagerRetryHint(withDetail(coded, withManagerHint(result, said)), result, carrierCommand), result)
      // 需要批准的构建脚本（#194）：宿主把名单写进失败回包（pendingBuilds），本包负责点名与给批准路径；
      // 调用方带 approvedBuilds 重试时宿主先批准再跑 pnpm，不再永远卡在同一句失败上。
      // #207：把「宿主拒绝 / 真跑过 pnpm 的非零退出」分类挂到错上；宿主码只收稳定码形状。
      const hostCode = normalizeHostCode(managerCodeOf(result) || 'none')
      const exitCode = typeof rawCode === 'number' && Number.isInteger(rawCode) ? rawCode : null
      return failExec(
        withPendingBuildsHint(
          withHints,
          normalizeApprovedBuilds(result ? result.pendingBuilds : []),
          carrierApproveBuildsCommand(profileArg)
        ),
        exitCode === null ? { reason: 'host-rejected', hostCode } : { reason: 'nonzero-exit', exitCode },
      )
    }
    let result = await installOnce()
    let application = result && typeof result.application === 'string' ? result.application : ''
    if (!MANAGER_OK.includes(application)) {
      // 只有「宿主说这包已经装着了」才走两步；其余失败（含包名取不到、宿主没这能力）照旧失败。
      const targetName = managerSaidAlreadyInstalled(result) ? managerPackageNameOf(spec) : ''
      const removeBundle = manager.removeBundle
      if (!targetName || typeof removeBundle !== 'function') throw failureOf(result, application)
      // #201：宿主只对**选中**的 bundle 先取消选中再重载卸载。真机上有一批包装着、也在跑，
      // 却不在选中名单里（`dsh.profile.bundles` 没有它们）——直接 remove 会在活 fiber 判
      // `bundle-in-use`（2–3ms 就回），两步配方永远走不完。所以先探拓扑：不可移除就诚实拒绝；
      // 未选中就先用宿主能力恢复选中，再按常规两步走。老宿主没有探测/启用能力时退回旧行为。
      const topology = await probeManagerTopology(manager, targetName)
      // `not-removable` 这个码宿主在这条路径上没回过话，是包侧按宿主 `removable === false`
      // 的语义给的原因；人话格会照常拼「宿主原话不够用 → 本包建议」，不冒充宿主原话。
      if (topology !== null && topology.removable === false) {
        throw failureOf({ application: 'failed', error: { code: 'not-removable' } }, 'failed')
      }
      if (topology !== null && topology.enabled === false) {
        const setBundleEnabled = manager.setBundleEnabled
        if (typeof setBundleEnabled !== 'function') {
          // 真实原因是「宿主没有恢复选中的能力」，不是活 fiber 占用：给诚实原因 + 换通道命令，
          // 不合成 bundle-in-use 之类的宿主码（Spec 审查 HARD ②）。
          const error = withDetail(fail('install-failed'), ENABLE_UNSUPPORTED_DETAIL)
          throw failExec(withCarrierHint(error, carrierCommand), { reason: 'spawn-failed' })
        }
        const enabling = Promise.resolve(setBundleEnabled.call(manager, targetName, true)) as Promise<ManagerChangeResult>
        // 宿主 `setBundleEnabled` 走内部 `change()`，resolve 出 `{ application, error? }`（不 reject；
        // 契约见 `asar:…/dsh-plugin-manager/lib/index.js` 的 setBundleEnabled → change），
        // 所以成败看 application，与 installBundle/removeBundle 同一套判法。
        // 启用步没有可取消的安装请求：超时口径不谎称「已请求取消」，只说没继续安装。
        // 启用步的失败/超时同样属于「管理器通道走不通」，一律补载体 CLI 命令（Spec 审查 HARD ①）。
        const enabled = await finishCall(enabling, async () => 'not-running', ENABLE_TIMEOUT_DETAIL).catch(
          (error: unknown) => {
            throw withCarrierHint(error as Error & { detail?: string }, carrierCommand)
          }
        )
        const enableApplication = enabled && typeof enabled.application === 'string' ? enabled.application : ''
        if (!MANAGER_OK.includes(enableApplication)) {
          throw withCarrierHint(failureOf(enabled, enableApplication), carrierCommand)
        }
      }
      // 移除步刻意不请求取消；超时意味着「可能已经摘掉了、但没来得及重装」（#184）——要当场说清并给下一步。
      // 这一步的「手工命令」面板里可能拿不到（目标已不在 dependencies，读取器会判成源码安装、不给命令），
      // 所以把这条桌面 CLI 一定能用的重装命令直接写进人话格（spec = 包名@目标版本）。
      const removalTimeoutDetail =
        carrierCommand === null ? REMOVE_TIMEOUT_DETAIL : `${REMOVE_TIMEOUT_DETAIL} (${carrierCommand})`
      const removing = Promise.resolve(removeBundle.call(manager, targetName)) as Promise<ManagerChangeResult>
      const removed = await finishCall(removing, async () => 'not-running', removalTimeoutDetail)
      const removalApplication = removed && typeof removed.application === 'string' ? removed.application : ''
      if (!MANAGER_OK.includes(removalApplication)) throw failureOf(removed, removalApplication)
      result = await installOnce().catch((error) => {
        throw withRemovalFact(error as Error & { detail?: string }, carrierCommand)
      })
      application = result && typeof result.application === 'string' ? result.application : ''
      if (!MANAGER_OK.includes(application)) {
        throw withRemovalFact(failureOf(result, application), carrierCommand, {
          names: normalizeApprovedBuilds(result ? result.pendingBuilds : []),
          approveCommand: carrierApproveBuildsCommand(profileArg),
        })
      }
    }
    return 0
  } catch (error) {
    // #207：已经带分类的错误原样上抛；认不出的一律 reason=unknown 照记，不猜原因。
    if ((error as { code?: unknown })?.code === 'install-failed') {
      if (readInstallFail(error)) throw error
      throw failExec(error as Error, { reason: 'unknown' })
    }
    throw failExec(withDetail(fail('install-failed'), detailText(error)), { reason: 'unknown' })
  }
}


/** 普通 DSH 宿主：当前运行时 + CLI 的 JS 入口 + 参数数组，经宿主注入的子进程能力起进程。 */
async function runCliProcess(
  recipe: { pluginArgs: string[]; profileName: string; timeoutMs: number },
  parts: ExecutorParts
): Promise<number | null> {
  const executable = part(parts.runtimeExecutable) || (typeof process !== 'undefined' ? process.execPath : '')
  const execArgs =
    part(parts.runtimeExecArgs) ??
    (typeof process !== 'undefined' && Array.isArray(process.execArgv) ? (process.execArgv as string[]) : [])
  const entry = part(parts.cliEntry) ?? (await resolveCliEntry(typeof process !== 'undefined' && process.argv ? process.argv[1] : ''))
  if (!executable || !entry) throw failExec(fail('install-failed'), { reason: 'spawn-failed' })
  const argv = [executable, ...execArgs, entry, 'plugin', '--profile', recipe.profileName, ...recipe.pluginArgs]
  const subprocess = part(parts.subprocess) as {
    spawn?: (opts: { argv: string[]; cwd?: string; stdio: unknown; graceMs: number }) => { done: Promise<{ exitCode?: number } | null> }
  } | null
  if (!subprocess || typeof subprocess.spawn !== 'function') throw failExec(fail('install-failed'), { reason: 'spawn-failed' })
  const handle = subprocess.spawn({
    argv,
    cwd: (part(parts.profileDir) as string) || undefined,
    stdio: INSTALL_STDIO,
    graceMs: TERMINATION_GRACE_MS,
  })
  if (!handle || !handle.done || typeof handle.done.then !== 'function') throw failExec(fail('install-failed'), { reason: 'spawn-failed' })
  const readOutput = (): string => causeExcerptOf(collectedOutputOf(handle))
  const canTerminate = typeof (handle as { terminate?: unknown }).terminate === 'function'
  const terminate = canTerminate ? (handle as unknown as { terminate: () => void }).terminate : null
  let terminated = false
  let terminateFailed = false
  // 结局只分三种：自己收尾 / 崩了（done reject） / 到点；先把 reject 折成事实，不要让它冒充超时。
  const settled = Promise.resolve(handle.done).then(
    (value) => ({ kind: 'settled' as const, value }),
    () => ({ kind: 'crashed' as const, value: null })
  )
  const timeoutMs = typeof recipe.timeoutMs === 'number' && recipe.timeoutMs > 0 ? recipe.timeoutMs : 0
  const TIMEOUT = Symbol('install-timeout')
  let timer: ReturnType<typeof setTimeout> | null = null
  const outcome = await (async () => {
    if (timeoutMs === 0) return await settled
    const deadline = new Promise<typeof TIMEOUT>((settle) => {
      timer = setTimeout(() => {
        try {
          if (terminate !== null) {
            terminate.call(handle)
            terminated = true
          }
        } catch {
          terminateFailed = true
        }
        settle(TIMEOUT)
      }, timeoutMs)
    })
    try {
      return await Promise.race([settled, deadline])
    } finally {
      if (timer !== null) {
        try {
          clearTimeout(timer)
        } catch {}
      }
    }
  })()
  if (outcome === TIMEOUT) {
    // 到点后宽限：宽限内自己以 0 收尾就算成功；否则超时是定局——即使它在被终止后落到非零/空退出码，
    // 也必须点名超时，不许退回「装失败」的通用兜底（#185：这就是用户看到的静默失败）。口径按
    // 「终止是否真发出 / 任务是否已收尾」选词，不许拿没发生的事实凑（Spec 审查）。
    const late = await settleWithin(settled, TERMINATION_GRACE_MS)
    if (late && late.kind === 'settled' && late.value && late.value.exitCode === 0) return 0
    const lateCode = late && late.kind === 'settled' ? (late.value && typeof late.value.exitCode === 'number' ? late.value.exitCode : null) : null
    const hint = timeoutHintOf(
      { terminated, ended: late !== null, terminateFailed },
      { terminated: CLI_TIMEOUT_DETAIL, noTerminate: SERVICE_TIMEOUT_NO_TERMINATE_DETAIL }
    )
    throw failExec(withDetail(withExit(fail('install-failed'), lateCode), withTimeoutHint(readOutput(), hint)), {
      reason: terminateFailed ? 'terminate-failed' : 'timeout',
      exitCode: lateCode,
    })
  }
  if (outcome.kind === 'crashed') {
    throw failExec(withDetail(fail('install-failed'), readOutput() || CLI_CRASHED_DETAIL), { reason: 'crashed' })
  }
  const code = outcome.value && typeof outcome.value.exitCode === 'number' ? outcome.value.exitCode : null
  // 抓取读数在退出后仍可读（宿主 subprocess 契约）：失败时把它挑成一句人话再上抛，
  // 上层按既有 message 通道给面板；挑不到就是空串，形状与从前一致。
  if (code !== 0) throw failExec(withDetail(withExit(fail('install-failed'), code), readOutput()), { reason: 'nonzero-exit', exitCode: code })
  return code
}

/**
 * 路由 → 跑法：三条路由与 README 第 4 节那张表一一对应，加路由只动这一处。
 * 起进程与两处宿主出口都只经宿主注入的零件，不经 shell、不用 PATH 上的命令名。
 */
type InstallRunner = (recipe: InstallRecipe, parts: ExecutorParts) => Promise<number | null>
const INSTALL_RUNNERS: Record<string, InstallRunner> = {
  'desktop-service': runDesktopService,
  'desktop-manager': runDesktopManager,
  'cli-process': runCliProcess,
}

/**
 * 真执行器：按核心给的配方跑安装（测试一律注入假零件，不走这里）。
 *
 * 路由只有三条，都由核心的 installRecipe 决定，本文件不按操作系统分支：
 *   - desktop-service：桌面宿主公开的 desktopPnpm.runPlugin(参数数组, 使用范围目录)；
 *   - desktop-manager：官方桌面版进程内的 pluginManager.installBundle(精确版本规格, 选项)；
 *   - cli-process：subprocess.spawn({ argv: [运行时, …运行时参数, CLI 入口, 'plugin', '--profile', 名, …参数] })。
 * 起进程只经宿主注入的子进程能力，不经 shell、不用 PATH 上的 `dsh` 命令名。
 */
export function createUpdateExecutor(parts: ExecutorParts = {}): (args?: { version?: string; profileName?: string | null; environmentKind?: EnvironmentKind; releaseChannel?: ReleaseChannel; approvedBuilds?: unknown }) => Promise<void> {
  return async function runInstall(args: { version?: string; profileName?: string | null; environmentKind?: EnvironmentKind; releaseChannel?: ReleaseChannel; approvedBuilds?: unknown } = {}): Promise<void> {
    const recipe = installRecipe({
      profileName: args.profileName ?? (part(parts.profileName ?? null) as string | null),
      version: String(args.version ?? ''),
      environmentKind: args.environmentKind ?? (part(parts.environmentKind ?? 'cli') as EnvironmentKind),
      releaseChannel: args.releaseChannel ?? (part(parts.releaseChannel ?? 'stable') as ReleaseChannel),
      targetPackageName: parts.targetPackageName === undefined ? undefined : (part(parts.targetPackageName) as string),
      registryUrl: parts.registryUrl === undefined ? undefined : (part(parts.registryUrl) as string),
      timeoutMs: parts.installTimeoutMs === undefined ? undefined : (part(parts.installTimeoutMs) as number),
    })
    // 一次调用携带的批准名单（#194）：归一后只对这次调用生效，不污染执行器的常驻零件。
    const approvedBuilds = normalizeApprovedBuilds(args.approvedBuilds)
    const partsForCall = approvedBuilds.length > 0 ? { ...parts, approvedBuilds } : parts
    const startedAt = Date.now()
    let exitCode: number | null = null
    try {
      if (!recipe) throw failExec(fail('install-failed'), { reason: 'spawn-failed' })
      const runner = INSTALL_RUNNERS[recipe.route] ?? null
      if (!runner) throw failExec(fail('install-failed'), { reason: 'spawn-failed' })
      exitCode = await runner(recipe, partsForCall)
      emitInstall(parts, recipe, true, exitCode, Date.now() - startedAt)
    } catch (error) {
      emitInstall(parts, recipe, false, (error as { exitCode?: number })?.exitCode ?? exitCode, Date.now() - startedAt)
      // 失败详情（宿主原话，已截断脱敏）随错误一起上抛，由上层决定给谁看；不塞进日志字段。
      // 不带原始调用栈：栈里全是本机绝对路径，零读者，且一旦有人读就会顺着越界。
      const detail = (error as { detail?: unknown })?.detail
      const wrapped = Object.assign(fail('install-failed'), {
        ...(typeof detail === 'string' && detail ? { detail } : {}),
      })
      // #207：执行器是失败事实的搬运工——路由分支挂上的分类原样带到上层（服务侧只落一行）。
      const facts = readInstallFail(error)
      throw facts ? attachInstallFail(wrapped, facts) : failExec(wrapped, { reason: 'unknown' })
    }
  }
}

// 内部复用导出（供单测断言子进程形态：数组、无 shell、不用 PATH 名、不按系统分支）。
export const __executorInternals = { INSTALL_STDIO, TERMINATION_GRACE_MS, CLI_PACKAGE_NAME }
