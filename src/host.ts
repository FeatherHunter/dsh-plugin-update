// src/host.ts —— 更新包的宿主入口（包根，#581 双入口之一）。
//
// 3 步接入：装包、调用 createHostUpdate 并传入插件标识、用默认配置即跑。
// 当前插件传插件标识 dsh-mattpocock-skills-deck、电话名前缀 wf，拼出的 3 个电话名、
// 落盘目录、三个文件名与现状一字不差。第二个插件传自己的标识与前缀即隔离。
//
// 全程用“更新系统”指更新功能本身，用“更新包”指装着更新系统的这个 npm 包。
// 电话指宿主对外提供的方法；落盘指宿主统一写本地文件的动作。
//
// 本入口只做三件事：建更新能力、拼电话名、给调用方回电话名与处理器（注册由调用方完成，
// 已注册再注册由调用方的注册表决定，本包不覆盖旧的）。
// 电话只做三件事：查状态（只读本地）、查新版（用户点了才联网一次）、装更新（拿凭证提交）。

import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { sep } from 'node:path'
import {
  DEFAULT_CONFIRMATION_TTL_MS,
  DEFAULT_CHECK_TIMEOUT_MS,
  DEFAULT_INSTALL_TIMEOUT_MS,
  buildPhoneNames,
  resolveUpdateConfig,
  type PhoneAction,
  type UpdateConfigInput,
} from './config.js'
import { manualCommand } from './commands.js'
import { buildDiag } from './diag.js'
import { isVersionAllowedInChannel, validRequestId } from './service.js'
import { createUpdateDiskPorts, createUpdateExecutor, createUpdateQueuePorts } from './store.js'
import { createUpdateReader, defaultHomeDir, resolveProfileName, resolveTargetPackage } from './reader.js'
import type { EnvironmentKind, ReleaseChannel } from './ports.js'
import {
  QUEUE_INTENT_TTL_MS,
  cancelEnqueuedInQueue,
  emptyQueueState,
  enqueueInQueue,
  isHeadOfQueue,
  normalizeQueueState,
  pruneExpiredIntents,
  queuePositionOf,
  releaseOwnerInQueue,
  setOwnerIfFree,
  visibleQueueFor,
  type UpdateQueueState,
  type VisibleQueue,
} from './queue.js'

export { buildPhoneName, buildPhoneNames, resolveUpdateConfig } from './config.js'
export type { PhoneAction, UpdateConfigInput } from './config.js'
// 门禁模板检查器（#584，对象形式，更新包不读盘；经包根转出口，第二家可达）。
export { parseEventListManifest, checkEventFields, checkEventCounts } from './gate.js'
export type {
  GateEventLevel,
  GateEventKind,
  GateEventEntry,
  GateEventCounts,
  GateEventList,
  GateFieldCheck,
  GateCountCheck
} from './gate.js'
export { containingPackage, defaultHomeDir, profileNameValid, registrySpec, resolveTargetPackage } from './reader.js'
// 脱敏词汇（#19：五条具名规则 + 两占位符 + 顺序 + 源主机名规则，经包根转出口，第二家可达）。
// #24 单源收敛 + 字节墙：复制预算 / known-gap / 按序丢弃 enforcement 同经此出口。
export {
  COPY_BUDGET_CHARS,
  DETAIL_MAX_CHARS,
  DIAG_DROP_ORDER,
  DIAG_INLINE_BUDGET_BYTES,
  DIAG_NEVER_DROP_KEYS,
  ENDORSED_REGISTRY_HOSTS,
  KNOWN_GAP_FILE_URL_PREFIX,
  REDACTED_PATH,
  REDACTED_SECRET,
  REDACTION_RULE_NAMES,
  diagByteLength,
  enforceDiagBudget,
  resolveRegistryHost,
  sanitizeDetail,
  sanitizeForCopy,
  truncateToWordBoundary,
} from './redaction.js';
export type { DiagDropKey, RedactionRuleName } from './redaction.js';
// 电话侧失败证据 diag（#21，承接 #18 契约：16 键目录 + 阶段六值 + 路由/方法正交 +
// 包内动作推导 + 缺省省略 + 1024 字节墙；queuePos 留空到队列转正，经包根转出口）。
export {
  DIAG_ACTIONS,
  DIAG_KEYS,
  DIAG_KNOWN_TYPES,
  DIAG_STAGE_EXPECT,
  DIAG_STAGES,
  DIAG_VERSION,
  buildDiag,
  deriveAction,
  deriveRouteMethod,
  deriveStage,
  enforceBudget as enforceDiagBudgetForPhone,
} from './diag.js';
export type { DiagAction, DiagInput, DiagObject, DiagStage } from './diag.js';
// 更新日志（#23，承接 #11：包内 CHANGELOG.md 展示；纯函数两边可进，I/O 仅 Node 侧）。
export {
  CHANGELOG_ALL_CATEGORIES,
  CHANGELOG_FILENAME,
  CHANGELOG_FOLDED,
  CHANGELOG_MAX_BULLETS_PER_SECTION,
  CHANGELOG_MAX_BULLET_CHARS,
  CHANGELOG_MAX_CHARS,
  CHANGELOG_MAX_ENTRIES,
  CHANGELOG_MUST_SHOW,
  CHANGELOG_NEUTRAL_HINT,
  CHANGELOG_NEUTRAL_LINE,
  changelogForUpdate,
  hasVisibleSections,
  isUnreleasedVersion,
  parseChangelog,
  renderChangelogHTML,
  renderChangelogNeutral,
  renderChangelogSection,
  selectChangelogEntries,
} from './changelog.js';
export type { ChangelogCategory, ChangelogEntry } from './changelog.js';
export {
  CHANGELOG_DEFAULT_REGISTRY,
  CHANGELOG_FETCH_MAX_BYTES,
  CHANGELOG_TAR_MAX_BYTES,
  CHANGELOG_TARBALL_MAX_BYTES,
  extractChangelogFromTar,
  fetchReleaseChangelogText,
  readInstalledChangelogText,
} from './changelog-io.js';
export type { ReleaseChangelogRef } from './changelog-io.js';
export { createUpdateDiskPorts, createUpdateExecutor, pathsForUpdate, resolveCliEntry } from './store.js'
// 跳过与版本通道（#16：按插件 + 版本持久化跳过、stable 默认 / prerelease 开关、精确版锁定）。
export { SKIPPED_FILE } from './config.js'
export {
  addSkipped,
  clearSkipped,
  createSkipDiskPorts,
  isVersionSkipped,
  MAX_SKIPPED_ENTRIES,
  normalizeSkipped,
  skipKey,
  type SkippedVersionEntry,
} from './store.js'
export {
  compareReleaseVersions,
  isPrereleaseVersion,
  isVersionAllowedInChannel,
  validReleaseVersion,
  validVersion,
  compareVersions,
} from './service.js'
export type { ReleaseChannel } from './ports.js'
// 跨插件单队列（#15）：纯决策经包根转出口，落盘与全局锁同上；面板展示过滤见 client.ts 同名转出口。
export {
  createUpdateQueuePorts,
  queuePathsForUpdate,
  QUEUE_DIR_SEGMENT,
  QUEUE_FILE,
  QUEUE_LOCK_FILE,
  QUEUE_LOCK_STALE_MS,
} from './store.js'
export {
  QUEUE_INTENT_TTL_MS,
  cancelEnqueuedInQueue,
  emptyQueueState,
  enqueueInQueue,
  isHeadOfQueue,
  normalizeQueueState,
  pruneExpiredIntents,
  queuePositionOf,
  releaseOwnerInQueue,
  setOwnerIfFree,
  visibleQueueFor,
} from './queue.js'
export type { QueuedEntry, QueueOwner, UpdateQueueState, VisibleQueue } from './queue.js'

// ---------- 宿主种类探测与桌面服务 ----------

// 单例让查状态看到查新版的结果；复用键强制含插件标识（规格 #591 第 6 条），多插件不串内存。
// 跨插件队列读写口（#15）随单例一起缓存，与本次解析出的使用范围绑定。
type SharedQueueIO = {
  readQueuePruned(): Promise<UpdateQueueState>
  writeQueueState(state: UpdateQueueState): Promise<void>
  queueTtlMs: number
  queueNow(): number
}
let sharedReader: (ReturnType<typeof createUpdateReader> & SharedQueueIO) | null = null
let sharedReaderKey = ''
/** 桌面宿主才有：launcher 注册的公开服务，嵌套注入拿到后缓存（普通 DSH 拿不到也不报错）。 */
let sharedDesktopPnpm: unknown = null

function ctxService(ctx: unknown, name: string): unknown {
  try {
    const get = (ctx as { get?: (name: string) => unknown })?.get
    return typeof get === 'function' ? get.call(ctx, name) : undefined
  } catch {
    return undefined
  }
}

/**
 * 宿主种类按能力判定，顺序固定（写死是为了将来宿主形态收敛时行为可预测）：
 *   1. 有 `desktopProfiles` 服务 → `desktop`（第三方 Desktop，launcher 在 Loader entry 挂载前注册）；
 *   2. 否则有 `pluginManager.installBundle`、且使用范围名恰是命令行明确封禁的 `desktop`
 *      → `desktop-manager`（官方桌面版：命令行那条对这个使用范围一定失败）；
 *   3. 其余 → `cli`。
 *
 * 第 2 条不是拿名字猜宿主身份，而是用**命令行自己的拒绝规则**判断这条路封没封：
 * `dsh` 在 boot 与 plugin 子命令都按名字（大小写不敏感）拒绝 `--profile desktop`，
 * 唯一豁免是桌面自带的 CLI 载体。名字由调用方按 resolveProfileName 的同一口径给出；
 * 不传名字时只认第 1、3 条，绝不猜。
 */
export function detectEnvironmentKind(ctx: unknown, profileName?: string | null): EnvironmentKind {
  const profiles = ctxService(ctx, 'desktopProfiles')
  if (profiles !== undefined && profiles !== null) return 'desktop'
  const manager = ctxService(ctx, 'pluginManager')
  if (hasInstallBundle(manager) && cliRefusesProfile(profileName)) return 'desktop-manager'
  return 'cli'
}

/** 插件管理器的能力判据：`installBundle` 是可调用的方法（现取现用，不缓存跨代服务）。 */
function hasInstallBundle(manager: unknown): boolean {
  try {
    return typeof (manager as { installBundle?: unknown } | null | undefined)?.installBundle === 'function'
  } catch {
    return false
  }
}

/** 命令行明确封禁的使用范围名：只有 `desktop`（大小写不敏感，与命令行同一判据，不做 trim）。 */
function cliRefusesProfile(profileName: unknown): boolean {
  return typeof profileName === 'string' && profileName.toLowerCase() === 'desktop'
}

/** 桌面服务用嵌套注入拿：不把桌面服务放进顶层依赖声明，普通 DSH 才能照常加载。 */
function watchDesktopPnpm(ctx: unknown): void {
  try {
    if (detectEnvironmentKind(ctx) !== 'desktop') return
    const inject = (ctx as { inject?: (names: string[], cb: (c: unknown) => void) => void })?.inject
    if (typeof inject !== 'function') return
    inject.call(ctx, ['desktopPnpm'], (desktopCtx: unknown) => {
      try {
        const service = (desktopCtx as { desktopPnpm?: unknown })?.desktopPnpm
        if (service) sharedDesktopPnpm = service
      } catch {}
    })
  } catch {}
}

function hash8(s: string): string {
  try {
    const t = String(s || '')
    let h = 5381
    for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) >>> 0
    return (`0000000${h.toString(16)}`).slice(-8)
  } catch {
    return '00000000'
  }
}

/**
 * 从目标包位置反推使用范围目录：装好的包住在 `<范围>/node_modules/<目标包>` 下。
 * 反推不到返回 null，调用方诚实失败（issue #3：不再猜 `profiles/web`，多范围并存时猜即读错）。
 */
async function tryInferProfileDir(targetDir: string, targetPackageName: string): Promise<string | null> {
  try {
    const dir = String(targetDir || '')
    if (!dir) return null
    const marker = `${sep}node_modules${sep}${String(targetPackageName || '').split('/').join(sep)}`
    const at = dir.lastIndexOf(marker)
    if (at > 0) {
      const candidate = dir.slice(0, at)
      try {
        return await realpath(candidate)
      } catch {
        return candidate
      }
    }
  } catch {}
  return null
}

function unknownProfile(): Error & { code: string } {
  return Object.assign(new Error('unknown-profile'), { code: 'unknown-profile' })
}

export interface ReaderOverrides {
  env?: Record<string, string | undefined>
  osHome?: string
  runningVersion?: string
  profileDir?: string
  profileName?: string | null
  homeDir?: string
  environmentKind?: EnvironmentKind
  ctx?: unknown
  fetchImpl?: (url: string, init?: Record<string, unknown>) => Promise<never>
  now?: () => number
  /**
   * 编号发生器（测试与特殊宿主可换）。
   * **契约：同一个使用范围（同一队列文件）内，注入值必须全局唯一** —— 队列的拥有者账本按
   * (pluginId, jobId) 认人；若给多个目标注入同一个编号，会被记串（#27 里一个夹具就这么撞过）。
   * 生产走 randomUUID，不会撞；写测试夹具时请按目标派生（如 'id-' + key + '-' + n）。
   */
  randomId?: () => string
  nodeVersion?: string
  targetPackageName?: string
  registryUrl?: string
  checkTimeoutMs?: number
  confirmationTtlMs?: number
  installTimeoutMs?: number
  /** 版本通道：默认走配置的通道，显式覆盖供测试与特殊宿主用（#16）。 */
  releaseChannel?: ReleaseChannel
  /** 队列意向有效期毫秒：默认 10 分钟（#15），须为有限大于 0 的数才生效，否则走默认。 */
  queueTtlMs?: number
  /** 跨插件队列的显式假件（测试用；给了 readQueue + writeQueue 即不走真实队列目录，#15）。 */
  readQueue?: () => UpdateQueueState | Promise<UpdateQueueState>
  writeQueue?: (state: UpdateQueueState) => void | Promise<void>
  /**
   * 抢全局锁的显式覆盖（测试与特殊宿主用）。
   * 第三参是**锁陈旧判据的时限**，与安装时限同源——阈值只由这一处决定，别再让覆盖实现自己拍一个；
   * 不接这个参数的旧实现行为一字不变（TS 允许少接参数）。
   */
  tryAcquireGlobalLock?: (lockId: string, pluginId: string, opts?: { timeoutMs?: number }) => boolean | Promise<boolean>
  releaseGlobalLock?: (lockId: string) => void | Promise<void>
  readInstalled?: () => Promise<import('./ports.js').EnvironmentView>
  readJob?: () => Promise<import('./ports.js').UpdateJob | null>
  writeJob?: (job: import('./ports.js').UpdateJob | null) => Promise<void>
  tryAcquireLock?: (lockId: string) => boolean | Promise<boolean>
  releaseLock?: (lockId: string) => void | Promise<void>
  backupJob?: (job: import('./ports.js').UpdateJob) => void | Promise<void>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runInstall?: (args: { version: string; profileName: string | null; environmentKind: EnvironmentKind }) => any
  subprocess?: unknown
  desktopPnpm?: unknown
  desktopProfiles?: unknown
  /** 官方桌面版进程内的插件管理器（显式覆盖用；不传就从 ctx 现取）。 */
  pluginManager?: unknown
  runtimeExecutable?: string
  runtimeExecArgs?: string[]
  cliEntry?: string
  /** 显式目标包目录：优先于按包名自动解析（hoisted、多副本、开发态链接等场景的逃生口）。 */
  targetPackageDir?: string
}

async function getSharedReader(pluginId: string, config: ReturnType<typeof resolveUpdateConfig>, overrides: ReaderOverrides = {}): Promise<ReturnType<typeof createUpdateReader> & SharedQueueIO> {
  const env = overrides.env ?? process.env
  const osHome = overrides.osHome ?? homedir()
  const homeDirDefault = defaultHomeDir(env, osHome)
  const targetPackageName = overrides.targetPackageName ?? config.targetPackageName
  const releaseChannel: ReleaseChannel = overrides.releaseChannel ?? config.releaseChannel ?? 'stable'
  const explicitTargetDir =
    typeof overrides.targetPackageDir === 'string' && overrides.targetPackageDir ? String(overrides.targetPackageDir) : ''
  // 与读取器共用同一个解析函数（issue #3）：显式目录优先，否则按包名解析。
  const loaded = await resolveTargetPackage(targetPackageName, explicitTargetDir ? { targetPackageDir: explicitTargetDir } : {}).catch(
    () => null
  )
  const runningVersion =
    overrides.runningVersion ??
    (loaded && isVersionAllowedInChannel((loaded.manifest as { version?: unknown }).version, releaseChannel)
      ? String((loaded.manifest as { version: string }).version)
      : null)
  if (!runningVersion) throw unknownProfile()
  let profileDirInput: string
  if (overrides.profileDir) {
    profileDirInput = String(overrides.profileDir)
  } else {
    const anchorDir = (loaded && loaded.directory ? String(loaded.directory) : '') || explicitTargetDir
    const inferred = anchorDir ? await tryInferProfileDir(anchorDir, targetPackageName) : null
    // 诚实失败（issue #3）：目标包定位不到且调用方没给 profileDir / targetPackageDir 时，
    // 不再猜 profiles/web（多范围并存即读错），也不再往下产出假的 installation-changed。
    if (!inferred) throw unknownProfile()
    profileDirInput = inferred
  }
  const homeDirInput = overrides.homeDir ?? config.homeDir ?? homeDirDefault
  const environmentKind =
    overrides.environmentKind ?? detectEnvironmentKind(overrides.ctx, resolveProfileName(overrides.profileName, profileDirInput))
  const checkTimeoutMs = overrides.checkTimeoutMs ?? config.checkTimeoutMs
  const confirmationTtlMs = overrides.confirmationTtlMs ?? config.confirmationTtlMs
  const installTimeoutMs = overrides.installTimeoutMs ?? config.installTimeoutMs
  const registryUrl = overrides.registryUrl ?? config.registryUrl
  const key = `${pluginId}\0${config.prefix}\0${runningVersion}\0${profileDirInput}\0${overrides.profileName ?? ''}\0${homeDirInput}\0${overrides.runInstall ? 'exec' : ''}\0${environmentKind}\0${targetPackageName}\0${explicitTargetDir}\0${releaseChannel}`
  if (sharedReader && sharedReaderKey === key) return sharedReader
  const disk = overrides.readJob && overrides.writeJob ? null : createUpdateDiskPorts(homeDirInput, pluginId, profileDirInput)
  // 跨插件单队列（#15）：与插件标识无关，按使用范围共享。显式队列假件优先；有真实落盘
  // 才走真实队列目录；纯内存测试（磁盘被假件替代）默认不碰真实队列目录，免得单测写脏真机。
  // 队列自身永远 best-effort：读不到按空队放行，写失败吞掉——队列坏了不能挡安装。
  const queueTtlMs =
    typeof overrides.queueTtlMs === 'number' && Number.isFinite(overrides.queueTtlMs) && overrides.queueTtlMs > 0
      ? overrides.queueTtlMs
      : QUEUE_INTENT_TTL_MS
  const queueDisk = overrides.readQueue && overrides.writeQueue ? null : disk ? createUpdateQueuePorts(homeDirInput, profileDirInput) : null
  const queueNow = overrides.now ?? Date.now
  async function readQueueBestEffort(): Promise<UpdateQueueState> {
    try {
      if (overrides.readQueue) return normalizeQueueState(await overrides.readQueue())
      if (queueDisk) return normalizeQueueState(await queueDisk.readQueue())
    } catch {}
    return emptyQueueState()
  }
  async function writeQueueBestEffort(state: UpdateQueueState): Promise<void> {
    try {
      if (overrides.writeQueue) await overrides.writeQueue(normalizeQueueState(state))
      else if (queueDisk) await queueDisk.writeQueue(state)
    } catch {}
  }
  async function loadQueuePruned(): Promise<UpdateQueueState> {
    const raw = await readQueueBestEffort()
    const pruned = pruneExpiredIntents(raw, queueNow(), queueTtlMs)
    if (pruned !== raw) await writeQueueBestEffort(pruned)
    return pruned
  }
  // 组合锁：先抢全局（跨插件一次只装一个），再抢自家；自家没抢到就把全局放了，不占着。
  // 无全局可用时退化为自家锁（与改造前一字不差，老单测走这条）。
  const baseTryAcquire = overrides.tryAcquireLock ?? disk?.tryAcquireLock
  const baseRelease = overrides.releaseLock ?? disk?.releaseLock
  // 阈值单源：两条路（显式覆盖 / 内置端口）拿到**同一个** installTimeoutMs。
  // 覆盖实现不接第三参就还是它自己的口径（行为不变），接了就跟安装时限对齐——批量路径原先自己传 {}，
  // 陈旧阈值落回 QUEUE_LOCK_STALE_MS，改过 installTimeoutMs 就会与这条分叉（#26 照出来的）。
  const globalTryAcquire: ((lockId: string) => boolean | Promise<boolean>) | undefined = overrides.tryAcquireGlobalLock
    ? (lockId: string) => overrides.tryAcquireGlobalLock!(lockId, pluginId, { timeoutMs: installTimeoutMs })
    : queueDisk
      ? (lockId: string) => queueDisk.tryAcquireGlobalLock(lockId, pluginId, { timeoutMs: installTimeoutMs })
      : undefined
  const globalRelease: ((lockId: string) => void | Promise<void>) | undefined =
    overrides.releaseGlobalLock ?? queueDisk?.releaseGlobalLock
  async function combinedTryAcquire(lockId: string): Promise<boolean> {
    try {
      if (globalTryAcquire && !(await globalTryAcquire(lockId))) return false
      if (baseTryAcquire && !(await baseTryAcquire(lockId))) {
        if (globalRelease) {
          try {
            await globalRelease(lockId)
          } catch {}
        }
        return false
      }
      return true
    } catch {
      return false
    }
  }
  async function combinedRelease(lockId: string): Promise<void> {
    try {
      if (baseRelease) await baseRelease(lockId)
    } catch {}
    try {
      if (globalRelease) await globalRelease(lockId)
    } catch {}
    // 拥有者兜底：只清自己的牌（jobId 对上才清），终态正常走镜像已清，这里多半是空操作。
    try {
      const current = await readQueueBestEffort()
      const next = releaseOwnerInQueue(current, pluginId, lockId)
      if (next.released) await writeQueueBestEffort(next.state)
    } catch {}
  }
  // 任务镜像：持久化路由与现状一字不差（有注入走注入，无注入走内存），只顺带把 owner
  // 状态对齐进队列（安装中记牌、终态摘牌）。队列异常只吞不抛，安装成败归类不动。
  let memJobFallback: import('./ports.js').UpdateJob | null = null
  async function mirroredWriteJob(job: import('./ports.js').UpdateJob | null): Promise<void> {
    if (overrides.writeJob) await overrides.writeJob(job)
    else memJobFallback = job
    try {
      if (!job) return
      const current = await readQueueBestEffort()
      const pruned = pruneExpiredIntents(current, queueNow(), queueTtlMs)
      if (job.state === 'installing' || job.state === 'verifying') {
        let next = pruned
        if (next.owner && next.owner.jobId === job.id) {
          next = {
            version: 1 as const,
            owner: {
              ...next.owner,
              requestId: job.requestId ?? next.owner.requestId,
              targetVersion: job.targetVersion ?? next.owner.targetVersion,
            },
            waiting: next.waiting.filter((e) => !(e.pluginId === pluginId && (e.requestId ?? null) === (job.requestId ?? null))),
          }
        } else {
          // 陈旧拥有者回收：持有者早该收尾却没摘牌（崩溃/杀进程），后来者直接接管不等它；
          // 口径与全局锁一致（安装时限），未知年龄按可回收算。
          let base = next
          const age = queueNow() - (typeof base.owner?.startedAt === 'number' ? base.owner.startedAt : 0)
          if (base.owner && age > installTimeoutMs) base = { version: 1 as const, owner: null, waiting: base.waiting }
          next = setOwnerIfFree(base, {
            pluginId,
            jobId: job.id,
            requestId: job.requestId,
            targetVersion: job.targetVersion,
            startedAt: queueNow(),
          }).state
        }
        if (next !== pruned) await writeQueueBestEffort(next)
        else if (pruned !== current) await writeQueueBestEffort(pruned)
      } else {
        const released = releaseOwnerInQueue(pruned, pluginId, job.id)
        const out = released.released ? released.state : pruned
        if (out !== current) await writeQueueBestEffort(out)
      }
    } catch {}
  }
  async function mirroredReadJob(): Promise<import('./ports.js').UpdateJob | null> {
    if (overrides.readJob) return (await overrides.readJob()) ?? null
    return memJobFallback
  }
  // 执行零件按需现取（桌面服务要等注入到位）：路由与参数形态由核心的 installRecipe 定，
  // 这里只提供「用哪个可执行文件、哪份 CLI 入口、哪条子进程口子」。
  const defaultRun = createUpdateExecutor({
    profileName: overrides.profileName ?? null,
    environmentKind,
    profileDir: profileDirInput,
    subprocess: () => overrides.subprocess ?? ctxService(overrides.ctx, 'subprocess'),
    desktopPnpm: () => overrides.desktopPnpm ?? sharedDesktopPnpm,
    desktopProfiles: () => overrides.desktopProfiles ?? ctxService(overrides.ctx, 'desktopProfiles'),
    pluginManager: () => overrides.pluginManager ?? ctxService(overrides.ctx, 'pluginManager'),
    runtimeExecutable: () => overrides.runtimeExecutable,
    runtimeExecArgs: () => overrides.runtimeExecArgs,
    cliEntry: () => overrides.cliEntry,
    targetPackageName,
    registryUrl,
    installTimeoutMs,
    pluginId,
    log: emitInstallLog,
  })
  sharedReader = Object.assign(
    createUpdateReader({
      runningVersion,
      profileDir: profileDirInput,
      pluginId,
      profileName: overrides.profileName ?? undefined,
      homeDir: overrides.homeDir,
      targetPackageDir: explicitTargetDir || undefined,
      env,
      osHome,
      fetchImpl: overrides.fetchImpl as never,
      now: overrides.now,
      randomId: overrides.randomId,
      nodeVersion: overrides.nodeVersion,
      environmentKind,
      targetPackageName,
      registryUrl,
      checkTimeoutMs,
      confirmationTtlMs,
      releaseChannel,
      readInstalled: overrides.readInstalled,
      readJob: mirroredReadJob,
      writeJob: mirroredWriteJob,
      tryAcquireLock: combinedTryAcquire,
      releaseLock: combinedRelease,
      backupJob: overrides.backupJob ?? disk?.backupJob,
      runInstall: overrides.runInstall ?? defaultRun,
    }),
    // 跨插件队列的面板侧读写口（#15）：与本次解析出的使用范围绑定，面板经电话可选参数消费。
    { readQueuePruned: loadQueuePruned, writeQueueState: writeQueueBestEffort, queueTtlMs, queueNow },
  )
  sharedReaderKey = key
  return sharedReader
}

/** 核心错误码原样返回，外面世界的脏错误收敛为检查失败（码表由核心定）。 */
function toUpdateErrorPayload(error: unknown): { error: string; errorKind: string } {
  const code = error && typeof (error as { code?: unknown }).code === 'string' ? String((error as { code: string }).code) : ''
  const known = [
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
  ]
  if (known.includes(code)) return { error: code, errorKind: code }
  return { error: 'check-failed', errorKind: 'internal' }
}

function manualOfEnv(
  env: { profileName?: string | null; sourceInstall?: boolean } | null,
  snapshot: { latestVersion?: string | null; installedVersion?: string | null; runningVersion?: string; job?: { targetVersion?: string | null } | null; blockedReason?: string | null } | null,
  config: ReturnType<typeof resolveUpdateConfig>
): string | null {
  try {
    return manualCommand({
      profileName: env?.profileName ?? null,
      latestVersion: snapshot?.latestVersion ?? null,
      installedVersion: snapshot?.installedVersion ?? null,
      runningVersion: String(snapshot?.runningVersion ?? ''),
      jobTargetVersion: snapshot?.job?.targetVersion ?? null,
      blockedReason: (snapshot?.blockedReason as never) ?? null,
      sourceInstall: env?.sourceInstall === true,
      targetPackageName: config.targetPackageName,
      registryUrl: config.registryUrl,
    })
  } catch {
    return null
  }
}

async function snapWithManual(
  reader: ReturnType<typeof createUpdateReader>,
  snapshot: { latestVersion?: string | null; installedVersion?: string | null; runningVersion?: string; job?: { targetVersion?: string | null } | null; blockedReason?: string | null },
  config: ReturnType<typeof resolveUpdateConfig>
): Promise<{ snapshot: unknown; manual: string | null }> {
  try {
    return { snapshot, manual: manualOfEnv(await reader.readEnv(), snapshot, config) }
  } catch {
    return { snapshot, manual: null }
  }
}

/**
 * 面板要的一栏「装到哪个使用范围」：只回**使用范围名**与宿主种类，绝不回目录路径。
 * 为什么重要：同一个插件在 web / desktop 两个使用范围里各装一份，更新必须落到当前这一份；
 * 面板把这栏显示出来，用户才知道自己点的是哪个范围的更新（也才能对上 `--profile` 那一段）。
 * 走 includeEnv 选填（与 includeQueue 同一套口径）：老调用不带这个参数，回包形状一字不变。
 */
export interface PhoneEnvView {
  profileName: string | null
  environmentKind: string | null
}

async function readEnvForPanel(reader: { readEnv?: () => Promise<unknown> }): Promise<PhoneEnvView | null> {
  try {
    if (typeof reader.readEnv !== 'function') return null
    const env = (await reader.readEnv()) as { profileName?: unknown; environmentKind?: unknown } | null
    if (!env || typeof env !== 'object') return null
    return {
      profileName: typeof env.profileName === 'string' && env.profileName ? env.profileName : null,
      environmentKind: typeof env.environmentKind === 'string' && env.environmentKind ? env.environmentKind : null,
    }
  } catch {
    return null
  }
}

/** 调用方显式要使用范围一栏时才算（默认不算，老回包形状不变）。 */
function wantsEnv(args: Record<string, unknown>): boolean {
  return !!args && args['includeEnv'] === true
}

type LogCtx = { fire: (level: string, event: string, fields: Record<string, unknown>) => void } | null
let phoneLogCtx: LogCtx = null

/** 安装执行结果进日志（常驻事件 update.install.exec，由执行器在跨边界调用后发）。 */
function emitInstallLog(level: string, event: string, fields: Record<string, unknown>): void {
  try {
    if (phoneLogCtx && typeof phoneLogCtx.fire === 'function') phoneLogCtx.fire(level, event, fields)
  } catch {}
}

/** 电话回包里的可选队列视图（#15）：只在调用方显式要时才带，不传即与改造前一字不差。 */
function queueArgsOf(args: Record<string, unknown>): { includeQueue: boolean; showOthers: boolean } {
  return {
    includeQueue: !!args && args['includeQueue'] === true,
    showOthers: !!args && args['showOthers'] === true,
  }
}

function checkExpiredError(): Error & { code: string } {
  return Object.assign(new Error('check-expired'), { code: 'check-expired' })
}

function updateBusyError(): Error & { code: string } {
  return Object.assign(new Error('update-busy'), { code: 'update-busy' })
}

function loggedPhone(
  method: string,
  kind: string,
  pluginId: string,
  fn: (args: Record<string, unknown>) => Promise<{ snapshot: unknown; manual?: string | null; receipt?: unknown; queue?: VisibleQueue | null; env?: PhoneEnvView | null }>,
  diagCtx?: {
    config: ReturnType<typeof resolveUpdateConfig>
    readerOverrides: ReaderOverrides
  },
): (args: Record<string, unknown>) => Promise<Record<string, unknown>> {
  return async function (args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const t0 = Date.now()
    const emit = (level: string, event: string, fields: Record<string, unknown>): void => {
      try {
        if (phoneLogCtx && typeof phoneLogCtx.fire === 'function') phoneLogCtx.fire(level, event, fields)
      } catch {}
    }
    const safeArgs = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
    try {
      const out = await fn(safeArgs)
      const snapshot = out && out.snapshot ? out.snapshot : out
      // 成功事件 5 键基线（规格 #591 第 8 条）：旧 4 键加必填插件标识。
      // 成功形状不动（#21）：成功回包永不带 diag，旧面板逐字不变。
      emit('info', 'host.call', { method, latencyMs: Date.now() - t0, ok: true, kind, pluginId })
      return {
        ok: true,
        snapshot,
        manual: out && out.snapshot ? (out.manual ?? null) : null,
        receipt: out && out.receipt ? out.receipt : null,
        // 新增选填（#15）：调用方没要时不带该键，老调用形状不变。
        ...(out && out.queue ? { queue: out.queue } : {}),
        // 新增选填：使用范围一栏（只有调用方传了 includeEnv 才带，老调用形状不变）。
        ...(out && out.env ? { env: out.env } : {}),
      }
    } catch (error) {
      const payload = toUpdateErrorPayload(error)
      // 失败事件 4 键基线（规格 #591 第 8 条）：旧 3 键加必填插件标识。
      emit('warn', 'host.call.fail', { method, kind, errorHash: hash8(String((error as Error)?.message || payload.error)), pluginId })
      // 失败证据闭包（#21，#18 契约实现）：失败回包加可选 diag，只增不改。
      // best-effort：组装失败即按无 diag 的旧形状返回（新面板×旧载荷仍为正常缺省）。
      let diag: Record<string, unknown> | undefined
      try {
        const cfg = diagCtx?.config
        const overrides = diagCtx?.readerOverrides ?? {}
        const envRaw = (overrides as ReaderOverrides)?.environmentKind
        const runningRaw = (overrides as ReaderOverrides)?.runningVersion
        const built = buildDiag({
          errorCode: payload.error,
          phoneKind: kind,
          error,
          args: safeArgs,
          targetPackageName: cfg?.targetPackageName,
          registryUrl: cfg?.registryUrl,
          runningVersion: typeof runningRaw === 'string' ? runningRaw : undefined,
          latestVersion: undefined,
          environmentKind: typeof envRaw === 'string' ? envRaw : undefined,
          latencyMs: Date.now() - t0,
        })
        if (built && typeof built === 'object') diag = built as unknown as Record<string, unknown>
      } catch {
        diag = undefined
      }
      return { ok: false, ...payload, ...(diag ? { diag } : {}) }
    }
  }
}

export interface HostUpdate {
  phoneNames: Record<PhoneAction, string>
  handlers: Record<string, (args: Record<string, unknown>) => Promise<Record<string, unknown>>>
}

/**
 * 建宿主更新能力：一次调用得到该插件的一组电话名与处理器（调用方负责注册进自己的电话表）。
 * 配置只经函数入参注入（冻结写法，第 11 条），插件标识必填，其余可选。
 */
export function createHostUpdate(deps: { ctx?: unknown; logCtx?: LogCtx; desktopPnpm?: unknown; pluginManager?: unknown; readerOverrides?: ReaderOverrides } = {}, configInput: UpdateConfigInput): HostUpdate {
  const config = resolveUpdateConfig(configInput)
  const pluginId = config.pluginId
  phoneLogCtx = deps.logCtx ?? phoneLogCtx
  // 宿主上下文：探测宿主种类（桌面 / 普通 DSH）并接上执行零件（子进程口子、桌面服务）。
  const ctx = deps.ctx ?? null
  if (deps.desktopPnpm) sharedDesktopPnpm = deps.desktopPnpm
  else watchDesktopPnpm(ctx)
  const readerOverrides = { ...(deps.readerOverrides ?? {}), ctx, ...(deps.pluginManager ? { pluginManager: deps.pluginManager } : {}) } as ReaderOverrides
  const phoneNames = buildPhoneNames(config.prefix)
  async function readStatus(args: Record<string, unknown>): Promise<{ snapshot: unknown; manual: string | null; env?: PhoneEnvView | null; queue?: VisibleQueue | null }> {
    const reader = await getSharedReader(pluginId, config, {
      ...readerOverrides,
      profileDir: args && args.profileDir ? String(args.profileDir) : readerOverrides.profileDir,
    })
    const out = await snapWithManual(reader, (await reader.status()) as never, config)
    const env = wantsEnv(args) ? { env: await readEnvForPanel(reader) } : {}
    const { includeQueue, showOthers } = queueArgsOf(args)
    if (!includeQueue) return { ...out, ...env }
    const requestId = args && typeof args.requestId === 'string' ? args.requestId : undefined
    return { ...out, ...env, queue: visibleQueueFor(await reader.readQueuePruned(), pluginId, showOthers, requestId) }
  }
  async function readCheck(args: Record<string, unknown>): Promise<{ snapshot: unknown; manual: string | null; receipt: unknown; env?: PhoneEnvView | null; queue?: VisibleQueue | null }> {
    const reader = await getSharedReader(pluginId, config, {
      ...readerOverrides,
      profileDir: args && args.profileDir ? String(args.profileDir) : readerOverrides.profileDir,
    })
    const result = await reader.check()
    const withManual = await snapWithManual(reader, result.snapshot as never, config)
    const env = wantsEnv(args) ? { env: await readEnvForPanel(reader) } : {}
    const { includeQueue, showOthers } = queueArgsOf(args)
    if (!includeQueue) return { snapshot: withManual.snapshot, manual: withManual.manual, receipt: result.receipt ?? null, ...env }
    const requestId = args && typeof args.requestId === 'string' ? args.requestId : undefined
    return {
      snapshot: withManual.snapshot,
      manual: withManual.manual,
      receipt: result.receipt ?? null,
      ...env,
      queue: visibleQueueFor(await reader.readQueuePruned(), pluginId, showOthers, requestId),
    }
  }
  async function runInstall(args: Record<string, unknown>): Promise<{ snapshot: unknown; manual: string | null; env?: PhoneEnvView | null; queue?: VisibleQueue | null }> {
    const checkId = args && typeof args.checkId === 'string' ? args.checkId : ''
    const requestId = args && typeof args.requestId === 'string' ? args.requestId : ''
    const { includeQueue, showOthers } = queueArgsOf(args)
    const enqueueOnly = !!args && args['enqueueOnly'] === true
    const cancelQueued = !!args && args['cancelQueued'] === true
    const reader = await getSharedReader(pluginId, config, {
      ...readerOverrides,
      profileDir: args && args.profileDir ? String(args.profileDir) : readerOverrides.profileDir,
    })
    const envPatch = wantsEnv(args) ? { env: await readEnvForPanel(reader) } : {}
    // 取消占位：只撤自己的 waiting 条目（owner 不经这里取消），顺带回快照与队列。
    if (cancelQueued) {
      if (!validRequestId(requestId)) throw checkExpiredError()
      const current = await reader.readQueuePruned()
      const next = cancelEnqueuedInQueue(current, pluginId, requestId)
      if (next.removed) await reader.writeQueueState(next.state)
      const out = await snapWithManual(reader, (await reader.status()) as never, config)
      return { ...out, ...envPatch, queue: visibleQueueFor(next.state, pluginId, showOthers, requestId) }
    }
    // 只占位不装：面板先取号再装，供公平排队用（幂等占一位）。
    if (enqueueOnly) {
      if (!validRequestId(requestId)) throw checkExpiredError()
      const current = await reader.readQueuePruned()
      const placed = enqueueInQueue(current, { pluginId, requestId, targetVersion: null, enqueuedAt: reader.queueNow() })
      if (placed.state !== current) await reader.writeQueueState(placed.state)
      const out = await snapWithManual(reader, (await reader.status()) as never, config)
      return { ...out, ...envPatch, queue: visibleQueueFor(placed.state, pluginId, showOthers, requestId) }
    }
    // 正常安装：凭证不齐交给核心判（归类与改造前一致）；齐了先占位再过公平门。
    if (!checkId || !validRequestId(requestId)) {
      const out = await snapWithManual(reader, (await reader.install({ checkId, requestId })) as never, config)
      if (!includeQueue) return { ...out, ...envPatch }
      return { ...out, ...envPatch, queue: visibleQueueFor(await reader.readQueuePruned(), pluginId, showOthers, requestId) }
    }
    const before = await reader.readQueuePruned()
    const placed = enqueueInQueue(before, { pluginId, requestId, targetVersion: null, enqueuedAt: reader.queueNow() })
    if (placed.state !== before) await reader.writeQueueState(placed.state)
    // 公平门：非队首直接忙（沿用 update-busy，不新增码）；已是拥有者（同编号重复提交）
    // 不受此门阻拦，交给核心按旧结果返回。
    if (queuePositionOf(placed.state, pluginId, requestId) !== 0 && !isHeadOfQueue(placed.state, pluginId, requestId)) {
      throw updateBusyError()
    }
    try {
      const out = await snapWithManual(reader, (await reader.install({ checkId, requestId })) as never, config)
      if (!includeQueue) return { ...out, ...envPatch }
      return { ...out, ...envPatch, queue: visibleQueueFor(await reader.readQueuePruned(), pluginId, showOthers, requestId) }
    } catch (error) {
      // 忙失败留占位（面板凭它轮询位置，忙时失败回包不带队列，凭查状态补看）；
      // 其余失败撤占位，不留僵尸。
      if ((error as { code?: unknown })?.code !== 'update-busy') {
        try {
          const current = await reader.readQueuePruned()
          const next = cancelEnqueuedInQueue(current, pluginId, requestId)
          if (next.removed) await reader.writeQueueState(next.state)
        } catch {}
      }
      throw error
    }
  }
  const handlers: Record<string, (args: Record<string, unknown>) => Promise<Record<string, unknown>>> = {
    [phoneNames.updateStatus]: loggedPhone(phoneNames.updateStatus, 'update-status', pluginId, readStatus, {
      config,
      readerOverrides,
    }),
    [phoneNames.updateCheck]: loggedPhone(phoneNames.updateCheck, 'update-check', pluginId, readCheck, {
      config,
      readerOverrides,
    }),
    [phoneNames.updateInstall]: loggedPhone(phoneNames.updateInstall, 'update-install', pluginId, runInstall, {
      config,
      readerOverrides,
    }),
  }
  return { phoneNames, handlers }
}

// 未用到的默认值引用（保持与旧实现同一份超时口径，类型检查不误删常量）。
void DEFAULT_CHECK_TIMEOUT_MS
void DEFAULT_CONFIRMATION_TTL_MS
void DEFAULT_INSTALL_TIMEOUT_MS

/** 测试与门禁复位单例（正常运行不调用，规格 #591 第 6 条保留）。 */
export function __resetSharedUpdateReaderForTests(): void {
  sharedReader = null
  sharedReaderKey = ''
  sharedDesktopPnpm = null
}
