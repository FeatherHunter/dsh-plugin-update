/**
 * src/core/disk.ts —— 更新任务的落盘端口（自旧 store.ts 拆出；公共底座在 store-base.ts，
 * 队列端口在 queue/ports.ts，执行器在 executor.ts）。
 *
 * 由旧版 updateStore.js 改写拎入：只跑腿不决策。相对旧实现的增量（规格 #591）：
 * 1. 状态目录按插件标识派生（第 3 条）：join(家目录, 'updates', 插件标识, 使用范围短指纹)，
 *    三文件名保持 state.json、install.lock、before.json 不变。
 * 2. 默认旧路径冻结（第 14 条）：插件标识取旧值 dsh-mattpocock-skills-deck 时路径与旧原文
 *    一字不差——下面的旧字面是永久冻结特例，注释永不删除（动默认即破冰）。
 * 3. 只读自己的新路径（第 7 条，2026-10-18 #203 修订）：不再回退读旧路径。旧路径的冻结字面
 *    恰好是默认标识自己的实时目录，别的插件回退读它只会读到**别家正在跑的任务**，heal 之后
 *    又写回自己目录（真机跨插件污染）。旧文件不动，清理另票再议。
 * 4. 三处注入默认现状（第 4 条）：目标包名、官方源、安装时限经零件注入，默认值等于现状。
 * 5. 安装执行日志带必填插件标识（第 8、13 条）：update.install.exec 加完标识后 5 键为基线。
 *
 * 测试一律用假零件，不真写盘真跑命令（经可选的文件读写函数注入，默认走真文件系统）。
 */

import { randomUUID } from 'node:crypto'
import { renameWithRetry } from './fs-atomic.js'
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BACKUP_FILE, LOCK_FILE, SKIPPED_FILE, STATE_FILE } from '../shared/config.js'
import { emptyBatchSession, normalizeBatchSession, type BatchSession } from './batch/model.js'
import { hashToken } from '../log/namespace.js'
import { validReleaseVersion } from './service.js'
import type { UpdateJob, UpdateLogPort } from '../shared/ports.js'
import {
  LEGACY_SEGMENT,
  LEGACY_DIR_PLUGIN,
  JOB_STATES,
  SNAPSHOT_FILES,
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
  lockAgeOf,
  sameLockGeneration,
  createStoreLog,
} from './store-base.js'
import { QUEUE_LOCK_STALE_MS, queuePathsForUpdate } from './queue/ports.js'

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
    await renameWithRetry(temporary, filename)
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
    paths ? hashToken(paths.directory, 8) : undefined
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
      if (await createInstallLock(lockId)) {
        storeLog.clearBusyOwner()
        return true
      }
      const held = await probeInstallLock()
      // 锁刚被放掉（两次读之间消失）：直接再抢一次，不算回收。
      if (!held.present) {
        const won = await createInstallLock(lockId)
        if (won) storeLog.clearBusyOwner()
        return won
      }
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
      // 跨插件全局锁（src/host/capabilities.ts 的 getSharedReader），到不了这里。记在 #181 票面，不在本批扩大。
      const again = await probeInstallLock()
      if (!again.present) {
        const won = await createInstallLock(lockId)
        if (won) storeLog.clearBusyOwner()
        return won
      }
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
      // 锁换代了：busy-owner 的去重记忆作废，同一持有者下次再挡要重新记（#209）。
      storeLog.clearBusyOwner()
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
        await renameWithRetry(temporary, paths.file)
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
    await renameWithRetry(temporary, filename)
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
      await renameWithRetry(temporary, file)
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



