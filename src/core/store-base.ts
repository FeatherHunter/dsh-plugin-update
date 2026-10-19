/**
 * src/core/store-base.ts —— 更新任务落盘的公共底座（自旧 src/store.ts 前置段拆出）。
 *
 * 只放 disk / queue/ports / executor 三家共用的东西：永久冻结的旧路径字面、稳定失败码白名单、
 * 原子锁原语（临时文件 + link，退化 open wx）、锁代际与陈旧判定，以及 store 的三类日志发射
 * （update.lock.anomaly / update.store.fail / update.queue.transition）。
 * 本文件不派生任何业务路径、不做任何决策；拆分只为让另外三家单向依赖它（无环）。
 */

import { createHash, randomUUID } from 'node:crypto'
import { link, open, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LEGACY_PLUGIN_ID, LOCK_FILE } from '../shared/config.js'
import { hash8 } from '../shared/hash.js'
import type { UpdateLogPort } from '../shared/ports.js'

// 永久冻结的旧字面（规格 #591 第 14 条）：默认旧路径原文加三固定名永久冻结，永不删除。
// 旧原文：join(家目录, 'updates', 'dsh-mattpocock-skills-deck', 短指纹(使用范围目录))。
export const LEGACY_SEGMENT = 'updates'
export const LEGACY_DIR_PLUGIN = LEGACY_PLUGIN_ID

export const JOB_STATES = ['installing', 'verifying', 'restart-required', 'completed', 'failed', 'interrupted']
export const SNAPSHOT_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']

export function fail(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code })
}
export function shortHash(text: string): string {
  try {
    return createHash('sha256').update(String(text)).digest('hex').slice(0, 24)
  } catch {
    return '00000000'
  }
}

/** 持有者指纹（#209）：从锁文件里记得下的稳定量算 8 位短哈希，绝不入原文（ADR-0006）。 */
export function lockOwnerHash(owner: Record<string, unknown> | null | undefined): string | undefined {
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
// 事件名单源本该是 src/shared/log-events.ts，但那一行不在本票的写域内；这里按随包清单
// event-list.update.json 的名字逐字引用（字段白名单在唯一发射口校验，多一格整行会被丢掉）。
const LOG_EVENT_LOCK_ANOMALY = 'update.lock.anomaly'
const LOG_EVENT_STORE_FAIL = 'update.store.fail'
const LOG_EVENT_QUEUE_TRANSITION = 'update.queue.transition'
/** 锁异常 kind（清单口径逐字）：陈旧拥有者被回收 / 放锁失败 / 锁被新鲜持有者占着。
 *  `busy-timeout` 不在这里出现是有意的：本文件两条抢锁路径都是「看一眼，不陈旧就当场认输」，
 *  没有「等待/重试到超时才放弃」的路径，不为了凑齐词汇造一条。 */
export const LOCK_ANOMALY_STALE_OWNER = 'stale-owner'
export const LOCK_ANOMALY_RELEASE_FAILED = 'release-failed'
/** #209：被新鲜持有者挡住的试抢也发一条——不然调用方只看到 `update-busy`，不知道是谁、拿了多久。 */
export const LOCK_ANOMALY_BUSY_OWNER = 'busy-owner'

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
export function isMissingFileError(error: unknown): boolean {
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
export interface LockProbe {
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
export async function createLockAtomically(
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
export async function probeLockFile(
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
export function lockAgeOf(probe: LockProbe, nowMs: number): number | undefined {
  return (probe.owner ? lockAgeMs(probe.owner, nowMs) : undefined) ?? (probe.mtimeMs === undefined ? undefined : nowMs - probe.mtimeMs)
}

/**
 * 全局锁的年龄（#209 修）：锁里写了 `startedAt` 就按本端逻辑钟比（注入时钟的测试/宿主能走通）；
 * 缺格、不可解析就退回 mtime，而 mtime 是文件系统的**真墙钟**——必须用 `Date.now()` 比。
 * 否则宿主注入的假时钟会把「一小时前」看成未来时间，陈旧锁永远回收不了（#181 的回归点）。
 */
export function queueLockAge(probe: LockProbe, nowMs: number): number | undefined {
  const fromStamp = probe.owner ? lockAgeMs(probe.owner, nowMs) : undefined
  if (fromStamp !== undefined) return fromStamp
  return probe.mtimeMs === undefined ? undefined : Date.now() - probe.mtimeMs
}

/** 锁位还是不是刚才那一代（回收动手前的二次核对，缩小「判陈旧 → 删锁」之间被别人重建的竞态窗口）。 */
export function sameLockGeneration(before: LockProbe, after: LockProbe): boolean {
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
export type QueueTransitionPhase = 'queued' | 'running' | 'done' | 'reclaimed' | 'pruned' | 'abandoned'

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
  /**
   * 抢锁成功后清掉 busy-owner 的去重记忆（#209）：持有者放锁、锁真的换了代以后，
   * 同一个持有者再挡一次要重新记——「连续只记首次」说的是同一次占用，不是永久沉默。
   */
  clearBusyOwner(): void
}

/**
 * 建本文件三个事件的记法：全部 best-effort —— 发射口抛错一律吞掉，记日志绝不能改变控制流、
 * 返回值或抛错。磁盘侧传已绑好插件标识的 `log`；队列侧是跨插件共享的，传 `logFor` 按当次
 * 动作方取口，取不到标识就不发（不许猜）。`dirHash` 是本次操作的目录短指纹（#209）：清单里
 * `update.store.fail.dirHash` 声明了就必须实发，且只许 8 位十六进制（绝不入路径原文）。
 */
export function createStoreLog(
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
    clearBusyOwner() {
      lastBusyOwner.clear()
    },
  }
}
