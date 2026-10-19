/**
 * src/core/queue/ports.ts —— 跨插件队列的共享落盘端口（自旧 src/store.ts 拆出，公共底座在 ../store-base.ts）。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_INSTALL_TIMEOUT_MS } from '../../shared/config.js'
import { QUEUE_INTENT_TTL_MS, normalizeQueueState, type QueueOwner, type UpdateQueueState } from './model.js'
import { hash8 } from '../../shared/hash.js'
import { hashToken } from '../../log/namespace.js'
import type { UpdateLogPort } from '../../shared/ports.js'
import {
  fail,
  shortHash,
  lockOwnerHash,
  LOCK_ANOMALY_STALE_OWNER,
  LOCK_ANOMALY_RELEASE_FAILED,
  LOCK_ANOMALY_BUSY_OWNER,
  isMissingFileError,
  type LockProbe,
  createLockAtomically,
  probeLockFile,
  queueLockAge,
  sameLockGeneration,
  type QueueTransitionPhase,
  createStoreLog,
} from '../store-base.js'

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
    paths ? hashToken(paths.directory, 8) : undefined
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
      if (await createGlobalLock(lockId, pluginId)) {
        storeLog.clearBusyOwner()
        return true
      }
      const held = await probeGlobalLock(pluginId)
      // 锁刚被放掉（两次读之间消失）：直接再抢一次，不算回收。
      if (!held.present) {
        const won = await createGlobalLock(lockId, pluginId)
        if (won) storeLog.clearBusyOwner()
        return won
      }
      // 与安装锁同一判据：可解析看 startedAt，不可解析/缺格退回 mtime，判不了年龄就保守拒。
      const age = queueLockAge(held, now())
      if (age === undefined || age <= timeoutMs) {
        // #209：新鲜持有者占着要说得出「谁、多久」；同一代持有者连续只记一次（createStoreLog 去重）。
        storeLog.anomaly(LOCK_ANOMALY_BUSY_OWNER, pluginId, age, lockOwnerHash(held.owner))
        return false
      }
      // 二次核对：别人可能在「判陈旧 → 删锁」之间已经重建（同安装锁的残余窗口，见 tryAcquireLock 注）。
      const again = await probeGlobalLock(pluginId)
      if (!again.present) {
        const won = await createGlobalLock(lockId, pluginId)
        if (won) storeLog.clearBusyOwner()
        return won
      }
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
      // 锁换代了：busy-owner 的去重记忆作废（#209）。
      storeLog.clearBusyOwner()
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
