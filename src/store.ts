/**
 * src/store.ts —— 更新任务的落盘与执行跑腿。
 *
 * 由 src/host/updateStore.js 改写拎入：只跑腿不决策。相对旧实现的增量（规格 #591）：
 * 1. 状态目录按插件标识派生（第 3 条）：join(家目录, 'updates', 插件标识, 使用范围短指纹），
 *    三文件名保持 state.json、install.lock、before.json 不变。
 * 2. 默认旧路径冻结（第 14 条）：插件标识取旧值 dsh-mattpocock-skills-deck 时路径与旧原文
 *    一字不差——下面的旧字面是永久冻结特例，注释永不删除（动默认即破冰）。
 * 3. 读走双读、写只写新（第 7 条）：先读新路径，没有再回退读旧路径；写只写新路径，
 *    旧路径只读不写永久留作只读影子。旧文件不动，清理另票再议。
 * 4. 三处注入默认现状（第 4 条）：目标包名、官方源、安装时限经零件注入，默认值等于现状。
 * 5. 安装执行日志带必填插件标识（第 8、13 条）：update.install.exec 加完标识后 5 键为基线。
 *
 * 安装执行按核心给的配方跑三条路由之一（第三方 Desktop 走桌面服务、官方桌面版交给宿主
 * 进程内的插件管理器、普通 DSH 自己起进程），
 * 本文件不按操作系统分支，也不拼 shell。决策顺序全在更新核心。测试一律用假零件，
 * 不真写盘真跑命令（经可选的文件读写函数注入，默认走真文件系统）。
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, realpath, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { installRecipe } from './commands.js'
import { BACKUP_FILE, LEGACY_PLUGIN_ID, LOCK_FILE, SKIPPED_FILE, STATE_FILE } from './config.js'
import { emptyBatchSession, normalizeBatchSession, type BatchSession } from './batch.js'
import { normalizeQueueState, type UpdateQueueState } from './queue.js'
import { validReleaseVersion } from './service.js'
import { sanitizeDetail } from './redaction.js'
import { LOG_EVENT_INSTALL_EXEC } from './log-events.js'
import type { EnvironmentKind, InstallRecipe, UpdateJob } from './ports.js'

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

/** 旧只读影子目录（规格 #591 第 7 条）：只读不写，永久留作回退读取用。 */
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

async function writeJsonAtomic(filename: string, value: unknown): Promise<void> {
  const temporary = `${filename}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await rename(temporary, filename)
  } catch {
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
}

/**
 * 建任务存取与锁：调用方按当前插件标识建一份，转交核心当零件。
 * 读走双读（先新后旧），写只写新（旧影子只读不写）。
 */
export function createUpdateDiskPorts(homeDir: string, pluginId: string, profileDir: string, deps: DiskPortsDeps = {}): {
  paths: UpdatePaths | null
  legacyPaths: UpdatePaths | null
  readJob: () => Promise<UpdateJob | null>
  writeJob: (job: UpdateJob | null) => Promise<void>
  tryAcquireLock: (lockId: string) => Promise<boolean>
  releaseLock: (lockId: string) => Promise<void>
  backupJob: (job: UpdateJob) => Promise<void>
} {
  const paths = pathsForUpdate(homeDir, pluginId, profileDir)
  // 旧标识自己的新路径就是旧路径：此时旧影子与新路径同一目录，不做重复回退。
  const legacyPaths = pluginId === LEGACY_DIR_PLUGIN ? null : legacyPathsForUpdate(homeDir, profileDir)
  const readText = deps.readFileImpl ?? ((filename: string, encoding: string) => readFile(filename, encoding))
  const statFile = deps.statImpl ?? ((filename: string) => stat(filename))
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
  async function readJob(): Promise<UpdateJob | null> {
    if (!paths) return null
    const job = await readAt(paths)
    if (job) {
      if (!JOB_STATES.includes(String(job.state)) || typeof job.id !== 'string') {
        return { id: 'corrupt', state: 'interrupted', message: 'recovery-required', targetVersion: null, requestId: null }
      }
      return { requestId: null, message: null, ...job } as UpdateJob
    }
    // 新路径没有再回退读旧路径（只读影子，不触发回写）。
    if (legacyPaths) {
      const legacyJob = await readAt(legacyPaths)
      if (legacyJob) {
        if (!JOB_STATES.includes(String(legacyJob.state)) || typeof legacyJob.id !== 'string') {
          return { id: 'corrupt', state: 'interrupted', message: 'recovery-required', targetVersion: null, requestId: null }
        }
        return { requestId: null, message: null, ...legacyJob } as UpdateJob
      }
    }
    const lock = await readJsonGuarded(paths.lock, null)
    if (lock) return { id: 'locked', state: 'interrupted', message: 'recovery-required', targetVersion: null, requestId: null }
    if (legacyPaths) {
      const legacyLock = await readJsonGuarded(legacyPaths.lock, null).catch(() => null)
      if (legacyLock) return { id: 'locked', state: 'interrupted', message: 'recovery-required', targetVersion: null, requestId: null }
    }
    return null
  }
  async function writeJob(job: UpdateJob | null): Promise<void> {
    // 写只写新路径：旧影子只读不写，永久保留。
    if (!paths) throw fail('install-failed')
    if (job === null) {
      await unlink(paths.state).catch((error: { code?: string }) => {
        if (!error || error.code !== 'ENOENT') throw fail('install-failed')
      })
      return
    }
    await mkdir(paths.directory, { recursive: true, mode: 0o700 })
    await writeJsonAtomic(paths.state, job)
  }
  async function tryAcquireLock(lockId: string): Promise<boolean> {
    if (!paths) return false
    try {
      await mkdir(paths.directory, { recursive: true, mode: 0o700 })
      const handle = await open(paths.lock, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ id: lockId, pid: process.pid, startedAt: Date.now() }))
      } finally {
        await handle.close()
      }
      return true
    } catch (error) {
      if (!error || (error as { code?: string }).code !== 'EEXIST') return false
      try {
        const current = await readJsonGuarded(paths.lock, null)
        const job = await readJsonGuarded(paths.state, null)
        if (!current || (job && (job as { id?: unknown }).id === (current as { id?: unknown }).id)) return false
        await unlink(paths.lock).catch(() => {})
        const handle = await open(paths.lock, 'wx', 0o600)
        try {
          await handle.writeFile(JSON.stringify({ id: lockId, pid: process.pid, startedAt: Date.now() }))
        } finally {
          await handle.close()
        }
        return true
      } catch {
        return false
      }
    }
  }
  async function releaseLock(lockId: string): Promise<void> {
    if (!paths) return
    try {
      const current = await readJsonGuarded(paths.lock, null)
      if (current && (current as { id?: unknown }).id === lockId) await unlink(paths.lock).catch(() => {})
    } catch {}
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
        if (!error || (error as { code?: string }).code !== 'ENOENT') throw fail('install-failed')
      }
    }
    await mkdir(paths.directory, { recursive: true, mode: 0o700 })
    await writeJsonAtomic(paths.backup, {
      jobId: job.id,
      previousVersion: (job as unknown as Record<string, unknown>).previousVersion ?? null,
      files,
    })
  }
  return { paths, legacyPaths, readJob, writeJob, tryAcquireLock, releaseLock, backupJob }
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
/** 全局锁陈旧回收默认口径：15 分钟（与安装时限同口径，调用方可按注入覆盖）。 */
export const QUEUE_LOCK_STALE_MS = 15 * 60_000

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
  statImpl?: (filename: string) => Promise<{ size: number }>
  nowImpl?: () => number
}

function queueFail(): Error & { code: string } {
  // 队列自身的错不用 install-failed（那是安装失败的码）：队列坏了只影响可见性与公平
  // 提示，不改变安装成败的归类，调用方（host.ts）一律 best-effort 吞掉。
  return Object.assign(new Error('queue-unavailable'), { code: 'queue-unavailable' })
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
  async function readQueue(): Promise<UpdateQueueState> {
    if (!paths) throw queueFail()
    try {
      if ((await statFile(paths.file)).size > 10 * 1024 * 1024) throw queueFail()
      return normalizeQueueState(JSON.parse(await readText(paths.file, 'utf8')))
    } catch (error) {
      if (error && (error as { code?: string }).code === 'ENOENT') {
        return normalizeQueueState(null)
      }
      throw error && (error as { code?: string }).code ? error : queueFail()
    }
  }
  async function writeQueue(state: UpdateQueueState): Promise<void> {
    if (!paths) throw queueFail()
    try {
      await mkdir(paths.directory, { recursive: true, mode: 0o700 })
      const temporary = `${paths.file}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, `${JSON.stringify(normalizeQueueState(state), null, 2)}\n`, { mode: 0o600, flag: 'wx' })
        await rename(temporary, paths.file)
      } catch {
        throw queueFail()
      } finally {
        await unlink(temporary).catch(() => {})
      }
    } catch (error) {
      throw error && (error as { code?: string }).code ? error : queueFail()
    }
  }
  async function readLockRaw(): Promise<Record<string, unknown> | null> {
    if (!paths) return null
    try {
      if ((await statFile(paths.lock)).size > 1024 * 1024) return null
      return JSON.parse(await readText(paths.lock, 'utf8')) as Record<string, unknown>
    } catch {
      return null
    }
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
      const handle = await open(paths.lock, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ id: lockId, pluginId, pid: process.pid, startedAt: now() }))
      } finally {
        await handle.close()
      }
      return true
    } catch (error) {
      if (!error || (error as { code?: string }).code !== 'EEXIST') return false
      // 占着：看是不是陈旧（持有者早该收尾却没放），陈旧才回收一次，不陈旧直接认输。
      try {
        const current = await readLockRaw()
        const startedAt = current && typeof current['startedAt'] === 'number' ? (current['startedAt'] as number) : 0
        if (!current || now() - startedAt < timeoutMs) return false
        await unlink(paths.lock).catch(() => {})
        const handle = await open(paths.lock, 'wx', 0o600)
        try {
          await handle.writeFile(JSON.stringify({ id: lockId, pluginId, pid: process.pid, startedAt: now() }))
        } finally {
          await handle.close()
        }
        return true
      } catch {
        return false
      }
    }
  }
  async function releaseGlobalLock(lockId: string): Promise<void> {
    if (!paths) return
    try {
      const current = await readLockRaw()
      if (current && (current as { id?: unknown }).id === lockId) await unlink(paths.lock).catch(() => {})
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
        entries[key] = {
          lastCheckedAt: asMillisOrZero(e['lastCheckedAt']),
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

/** 等子进程退出事实：带时限，超时终止整棵进程树并按失败处理。 */
async function awaitOutcome(
  handle: { done: Promise<{ exitCode?: number } | null>; terminate?: () => void },
  timeoutMs: number
): Promise<{ exitCode: number | null; timedOut: boolean }> {
  const settled = Promise.resolve(handle.done).then(
    (value) => ({ exitCode: value && typeof value.exitCode === 'number' ? value.exitCode : null, timedOut: false }),
    () => ({ exitCode: null, timedOut: true })
  )
  if (!(typeof timeoutMs === 'number' && timeoutMs > 0)) return await settled
  let timer: ReturnType<typeof setTimeout> | null = null
  const deadline = new Promise<{ exitCode: null; timedOut: boolean }>((settle) => {
    timer = setTimeout(() => {
      try {
        if (handle && typeof handle.terminate === 'function') handle.terminate()
      } catch {}
      settle({ exitCode: null, timedOut: true })
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
}

export interface ExecutorParts {
  profileName?: string | null | (() => string | null)
  environmentKind?: EnvironmentKind | (() => EnvironmentKind)
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

/** 桌面宿主：交给桌面端公开的 desktopPnpm 服务，由它用参数数组拉起打包好的 CLI。 */
async function runDesktopService(
  recipe: { pluginArgs: string[]; profileName: string },
  parts: ExecutorParts
): Promise<number | null> {
  const service = part(parts.desktopPnpm) as { runPlugin?: (args: string[], dir: string, extra: undefined) => { done: Promise<{ exitCode?: number }> } } | null
  if (!service || typeof service.runPlugin !== 'function') throw fail('install-failed')
  const profiles = part(parts.desktopProfiles) as { current?: { dir?: string } } | null
  const active = profiles && profiles.current ? profiles.current : null
  const profileDir = part(parts.profileDir) as string
  // 桌面服务固定装进「当前激活的使用范围」，所以激活范围必须就是本插件所在的那个；
  // 对不上宁可不装（装错范围比装不上更糟），交回核心按诚实失败转手工命令。
  if (!active || !active.dir || !profileDir || !(await sameDir(active.dir, profileDir))) throw fail('install-failed')
  const handle = service.runPlugin(recipe.pluginArgs, profileDir, undefined)
  if (!handle || !handle.done || typeof handle.done.then !== 'function') throw fail('install-failed')
  const outcome = await handle.done
  const code = outcome && typeof outcome.exitCode === 'number' ? outcome.exitCode : null
  if (code !== 0) throw withExit(fail('install-failed'), code)
  return code
}

/**
 * 宿主管理器的回包（只声明本包用到的那几格）。
 * 出处：官方桌面版 `@deepseek-ai/dsh-plugin-manager` 的 ChangeResult；契约抄件见 docs/host-install-exits.md。
 */
interface ManagerChangeResult {
  application?: unknown
  error?: unknown
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
      // URL 用户信息命中时整项丢弃（回空串）：密码起止无法定位，替换会销毁证据；
      // 此时退到 code 本身（安全短码），不把含凭据的原话带回来。
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

/**
 * 官方桌面版：把安装交给宿主进程内的插件管理器（`ctx.get('pluginManager')`）。
 *
 * 与命令行那条同政策：精确版本、官方源（走管理器的 registry 选项）、超时即终止（请求取消）。
 * 管理器**预期失败不 reject**——它 resolve 出 `application:'failed'` 加 `error`，所以成败只看
 * `application`，不看有没有抛异常；抛出来的只有「管理器自己挂了」这类意外。
 * 成败与失败原话按合同收成一行（截断脱敏），挂在抛出的错上由上层决定给谁看。
 */
async function runDesktopManager(recipe: { pluginArgs: string[]; timeoutMs: number }, parts: ExecutorParts): Promise<number | null> {
  try {
    const manager = part(parts.pluginManager ?? null) as {
      installBundle?: (spec: string, options: { requestId: string; registry?: string }) => unknown
      cancelInstall?: (requestId: string) => unknown
    } | null
    if (!manager || typeof manager.installBundle !== 'function') throw fail('install-failed')
    const spec = managerSpecOf(recipe.pluginArgs)
    if (!spec) throw fail('install-failed')
    const requestId = randomUUID()
    const registry = part(parts.registryUrl ?? '') as unknown
    const options: { requestId: string; registry?: string } = { requestId }
    // 源不进参数数组（管理器不吃开关），走它自己的 registry 选项，取同一个注入值；
    // 没人注入源就不传，由管理器用自己的源策略（宿主路径总会注入，默认即官方源）。
    if (typeof registry === 'string' && registry) options.registry = registry
    const running = Promise.resolve(manager.installBundle(spec, options)) as Promise<ManagerChangeResult>
    const outcome = await raceManager(running, recipe.timeoutMs, async () => {
      const cancel = manager.cancelInstall
      if (typeof cancel !== 'function') return 'not-running'
      try {
        const answer = (await cancel.call(manager, requestId)) as { status?: unknown } | null
        const status = answer && typeof answer.status === 'string' ? answer.status : ''
        return status === 'cancelled' || status === 'too-late' ? status : 'not-running'
      } catch {
        return 'not-running'
      }
    })
    let result: ManagerChangeResult
    if (!outcome.timedOut) result = outcome.value
    else {
      // 超时且已经点过取消。可能是「刚好装完、还没报到」的竞态，所以再给一个终止宽限期
      // 等它自己收尾，按它自己的结局判——不把已经落地的改动记成失败。
      const settled = await settleWithin(running, TERMINATION_GRACE_MS)
      if (!settled) {
        void running.catch(() => {})
        throw withDetail(fail('install-failed'), '安装超时，已请求宿主取消')
      }
      result = settled
    }
    const application = result && typeof result.application === 'string' ? result.application : ''
    if (MANAGER_OK.includes(application)) return 0
    if (application === 'cancelled') throw withDetail(fail('install-failed'), '安装已被取消')
    throw withDetail(fail('install-failed'), detailText(result && result.error !== undefined ? result.error : `application: ${application || 'unknown'}`))
  } catch (error) {
    if ((error as { code?: unknown })?.code === 'install-failed') throw error
    throw withDetail(fail('install-failed'), detailText(error))
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
  if (!executable || !entry) throw fail('install-failed')
  const argv = [executable, ...execArgs, entry, 'plugin', '--profile', recipe.profileName, ...recipe.pluginArgs]
  const subprocess = part(parts.subprocess) as {
    spawn?: (opts: { argv: string[]; cwd?: string; stdio: unknown; graceMs: number }) => { done: Promise<{ exitCode?: number } | null> }
  } | null
  if (!subprocess || typeof subprocess.spawn !== 'function') throw fail('install-failed')
  const handle = subprocess.spawn({
    argv,
    cwd: (part(parts.profileDir) as string) || undefined,
    stdio: INSTALL_STDIO,
    graceMs: TERMINATION_GRACE_MS,
  })
  if (!handle || !handle.done || typeof handle.done.then !== 'function') throw fail('install-failed')
  const outcome = await awaitOutcome(handle as { done: Promise<{ exitCode?: number } | null> }, recipe.timeoutMs)
  if (outcome.timedOut || outcome.exitCode !== 0) throw withExit(fail('install-failed'), outcome.exitCode)
  return outcome.exitCode
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
export function createUpdateExecutor(parts: ExecutorParts = {}): (args?: { version?: string; profileName?: string | null; environmentKind?: EnvironmentKind }) => Promise<void> {
  return async function runInstall(args: { version?: string; profileName?: string | null; environmentKind?: EnvironmentKind } = {}): Promise<void> {
    const recipe = installRecipe({
      profileName: args.profileName ?? (part(parts.profileName ?? null) as string | null),
      version: String(args.version ?? ''),
      environmentKind: args.environmentKind ?? (part(parts.environmentKind ?? 'cli') as EnvironmentKind),
      targetPackageName: parts.targetPackageName === undefined ? undefined : (part(parts.targetPackageName) as string),
      registryUrl: parts.registryUrl === undefined ? undefined : (part(parts.registryUrl) as string),
      timeoutMs: parts.installTimeoutMs === undefined ? undefined : (part(parts.installTimeoutMs) as number),
    })
    const startedAt = Date.now()
    let exitCode: number | null = null
    try {
      if (!recipe) throw fail('install-failed')
      const runner = INSTALL_RUNNERS[recipe.route] ?? null
      if (!runner) throw fail('install-failed')
      exitCode = await runner(recipe, parts)
      emitInstall(parts, recipe, true, exitCode, Date.now() - startedAt)
    } catch (error) {
      emitInstall(parts, recipe, false, (error as { exitCode?: number })?.exitCode ?? exitCode, Date.now() - startedAt)
      // 失败详情（宿主原话，已截断脱敏）随错误一起上抛，由上层决定给谁看；不塞进日志字段。
      // 不带原始调用栈：栈里全是本机绝对路径，零读者，且一旦有人读就会顺着越界。
      const detail = (error as { detail?: unknown })?.detail
      throw Object.assign(fail('install-failed'), {
        ...(typeof detail === 'string' && detail ? { detail } : {}),
      })
    }
  }
}

// 内部复用导出（供单测断言子进程形态：数组、无 shell、不用 PATH 名、不按系统分支）。
export const __executorInternals = { INSTALL_STDIO, TERMINATION_GRACE_MS, CLI_PACKAGE_NAME }
