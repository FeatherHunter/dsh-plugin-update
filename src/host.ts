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
import { isAbsolute, join, sep } from 'node:path'
import {
  DEFAULT_CONFIRMATION_TTL_MS,
  DEFAULT_CHECK_TIMEOUT_MS,
  DEFAULT_INSTALL_TIMEOUT_MS,
  buildPhoneNames,
  resolveUpdateConfig,
  type PhoneNames,
  type UpdateConfigInput,
} from './config.js'
import { manualCommand, normalizeApprovedBuilds } from './commands.js'
import { fetchReleaseChangelogText } from './changelog-io.js'
import { parseChangelogReport, shouldFetchChangelog } from './changelog.js'
import { buildDiag, type DiagObject } from './diag.js'
import { isCoreErrorCode } from './codes.js'
import { LOG_EVENT_CALL, LOG_EVENT_CALL_FAIL } from './log-events.js'
import { emitUpdateLog } from './log/emit.js'
import { pruneEventFields } from './gate.js'
import { buildUpdateManifest, currentUpdateEventTable, primeUpdateEventTable, updateContractStatus, type UpdateContractStatus } from './log/manifest.js'
import { deriveLogNamespace } from './log/namespace.js'
import { isClientLogEvent, LOG_LEVELS } from './log/client-queue.js'
import { acquireOwnLog, logDirHash } from './log/registry.js'
import { updateLogRouter } from './log/router.js'
import { createPendingSink, sinkFromLogCtx, type LogSink } from './log/sink.js'
import { withLogTrace } from './log/trace.js'
import { fetchNpmVersionRelease, isVersionAllowedInChannel, updateError, validReleaseVersion, validRequestId } from './service.js'
import { selfCopyInfo, type SelfCopyInfo, type SelfCopyLevel } from './self.js'
import { createUpdateDiskPorts, createUpdateExecutor, createUpdateQueuePorts } from './store.js'
import { createUpdateReader, defaultHomeDir, resolveProfileName, resolveTargetPackage } from './reader.js'
import { resolveRegistryHost } from './redaction.js'
import type { CheckTrigger, EnvironmentKind, InstallSource, ReleaseChannel, UpdateLogPort } from './ports.js'
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

// 转发表已搬家（#162 首刀，#164 规格）：实体见 ./host-forwarding.js，本包根只留垫片。
// tests 深引用（../dist/host.js）与包导出表零碰（#159 冻结）。
export * from './host-forwarding.js'

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

/** 取服务值：既接受服务对象，也接受零件工厂（executor parts 惯用形式；取不到算没有）。 */
function serviceValueOf(value: unknown): unknown {
  try {
    return typeof value === 'function' ? (value as () => unknown)() : value
  } catch {
    return undefined
  }
}

/** 非空字符串（trim 后）；其余一律视为「不知道」。 */
function nonEmptyText(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

/** 只收绝对路径：相对路径不是一个可用的使用范围身份（跳过该来源，不猜）。 */
function absoluteDirOf(value: unknown): string {
  const text = nonEmptyText(value)
  if (!text) return ''
  try {
    return isAbsolute(text) ? text : ''
  } catch {
    return ''
  }
}

/**
 * #204：当前 profile 的权威身份（DSH 内运行必得）。
 *
 * 来源一：`ctx.profileContext`——DSH 在插件挂载前 `provide("profileContext", { name, dir, ... })`
 * （`dsh/lib/profile-boot-*.js`），每个 profile 启动的宿主都有，是最权威的一手身份。
 * 来源二：`desktopProfiles.current { name, dir }`——第三方 Desktop 的公开服务；官方桌面版没有它
 * （走 pluginManager），所以两个来源互补。
 *
 * 只读宿主给的权威值：不读隐式 process.env、不猜 `profiles/web`。取不到返回 null。
 */
function profileIdentityFromContext(overrides: ReaderOverrides): { dir: string; name: string } | null {
  try {
    const profile = ctxService(overrides.ctx, 'profileContext') as { name?: unknown; dir?: unknown } | null | undefined
    const dir = absoluteDirOf(profile?.dir)
    if (dir) return { dir, name: nonEmptyText(profile?.name) }
  } catch {}
  try {
    const desktop = serviceValueOf(overrides.desktopProfiles) ?? ctxService(overrides.ctx, 'desktopProfiles')
    const current = (desktop as { current?: { name?: unknown; dir?: unknown } } | null | undefined)?.current
    const dir = absoluteDirOf(current?.dir)
    if (dir) return { dir, name: nonEmptyText(current?.name) }
  } catch {}
  return null
}

/**
 * #204 第三来源：调用方显式传入的 env 快照（`DSH_PROFILE_DIR` / `DSH_PROFILE` 是
 * `dsh-shell-env` 的保留内置变量）。**只认 `overrides.env`，不读隐式 `process.env`**——
 * 嵌入方/测试不该因为进程环境里恰好有值而被串到别的 profile。
 */
function profileIdentityFromEnv(overrides: ReaderOverrides): { dir: string; name: string } | null {
  const env = overrides.env
  if (!env) return null
  const dir = absoluteDirOf(env.DSH_PROFILE_DIR)
  if (!dir) return null
  return { dir, name: nonEmptyText(env.DSH_PROFILE) }
}

/**
 * 宿主种类按能力判定，顺序固定（写死是为了将来宿主形态收敛时行为可预测）：
 *   1. 有 `desktopProfiles` 服务 → `desktop`（第三方 Desktop，launcher 在 Loader entry 挂载前注册）；
 *   2. 否则有 `pluginManager.installBundle`、且使用范围名恰是命令行明确封禁的 `desktop`
 *      → `desktop-manager`（官方桌面版：in-process 管理器是唯一带 HMR 感知 / 移除 / 重载的完整通道；
 *      桌面发行包的载体 CLI 虽可用但只作兜底，见 docs/host-install-exits.md 出口二末条）；
 *   3. 其余 → `cli`。
 *
 * 第 2 条不是拿名字猜宿主身份，而是用**命令行自己的拒绝规则**判断 in-process 这条路是不是官方桌面版：
 * 普通 `dsh` 在 boot 与 plugin 子命令都按名字（大小写不敏感）拒绝 `--profile desktop`，
 * 唯一豁免是桌面发行包自带的 CLI 载体（`dsh-desktop-host/lib/cli.js`）——那条路存在，但只作兜底，
 * 不参与路由判定。名字由调用方按 resolveProfileName 的同一口径给出；不传名字时只认第 1、3 条，绝不猜。
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

/**
 * 开发态挂载（#153）：目标包真实存在、但不在 `<范围>/node_modules/<包>` 版本位置下
 * （junction / 源码链接 / 显式外部目录），反推不到使用范围。这是“找到了包但无版本落点”，
 * 与“包都找不到”的 unknown-profile 不同：重启宿主修不好，应走仓库改完重启宿主。
 */
function devSource(): Error & { code: string } {
  return Object.assign(new Error('dev-source'), { code: 'dev-source' })
}

export interface ReaderOverrides {
  env?: Record<string, string | undefined>
  osHome?: string
  /**
   * 运行版本（宿主自带清单）。**未知请显式传 `null`**（#182）——不要伪造 `0.0.0`：
   * 未知不参与比较、不落事件 `current`、面板按未知呈现。不传则回落到读宿主清单。
   */
  runningVersion?: string | null
  /**
   * 当前 DSH 运行时版本（#195，可选）：未知时不传或传 `null`/空串。
   * 检查层只在拿得到时提前判远端 `engines.dsh` 要求；拿不到就不猜、不误拦。
   */
  dshVersion?: string | null
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
  runInstall?: (args: {
    version: string
    profileName: string | null
    environmentKind: EnvironmentKind
    releaseChannel?: ReleaseChannel
    approvedBuilds?: string[]
  }) => any
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
  // 运行版本只认“是不是合法发行版”，通道政策不在这里门控（issue #98）：
  // 定位得到但版本不被通道接受 → 照常建成读取器，阻拦由 readInstalled 的
  // channel-mismatch 分支诚实报告；unknown-profile 只留给“定位不到”。
  // #182：运行版本「未知」是一等状态——显式 null/空串即未知；不传才回落到宿主清单。
  const loadedVersion = loaded ? (loaded.manifest as { version?: unknown }).version : null
  const overrideVersion = overrides.runningVersion
  let runningVersion: string | null = null
  if (overrideVersion === null || overrideVersion === '') {
    runningVersion = null
  } else if (overrideVersion !== undefined) {
    // 显式覆盖即调用方责任，原样采用、有效性门不过问（与改造前一致）。
    runningVersion = overrideVersion
  } else if (validReleaseVersion(loadedVersion)) {
    runningVersion = String(loadedVersion)
  }
  const rawDshVersion = overrides.dshVersion
  const dshVersion: string | null = typeof rawDshVersion === 'string' && rawDshVersion.trim() ? rawDshVersion.trim() : null
  // #204：profile 身份优先用宿主给的权威来源，不再只靠目标包目录反推。
  // 顺序：显式覆盖 → ctx.profileContext（DSH 权威）→ desktopProfiles.current（第三方 Desktop）
  //      → 显式 env.DSH_PROFILE_DIR/DSH_PROFILE（集成方注入）→ 从目标包反推（旧兜底）。
  // 只有在「没有权威来源、也反推不到」的嵌入场景，才保留 #3/#153 的诚实失败语义。
  const explicitProfileName = nonEmptyText(overrides.profileName)
  const contextIdentity = profileIdentityFromContext(overrides)
  const envIdentity = profileIdentityFromEnv(overrides)
  let profileDirInput: string
  let profileNameInput: string | undefined
  if (overrides.profileDir) {
    profileDirInput = String(overrides.profileDir)
    profileNameInput = explicitProfileName || undefined
  } else if (contextIdentity) {
    profileDirInput = contextIdentity.dir
    profileNameInput = explicitProfileName || contextIdentity.name || undefined
  } else if (envIdentity) {
    profileDirInput = envIdentity.dir
    profileNameInput = explicitProfileName || envIdentity.name || undefined
  } else {
    const anchorDir = (loaded && loaded.directory ? String(loaded.directory) : '') || explicitTargetDir
    const inferred = anchorDir ? await tryInferProfileDir(anchorDir, targetPackageName) : null
    // 诚实失败（issue #3）：目标包定位不到且调用方没给 profileDir / targetPackageDir 时，
    // 不再猜 profiles/web（多范围并存即读错），也不再往下产出假的 installation-changed。
    // #153：包真实定位到（loaded != null）但反推不到范围（junction/显式外部目录）→ dev-source；
    // 判别式必须锚在 loaded 而非 anchorDir：显式目录指错/不存在时 loaded 为 null，
    // 此时真相是“指的地方没这个包”，仍报 unknown-profile，不许谎称开发态挂载。
    const located = !!(loaded && loaded.directory)
    if (!inferred) throw (located ? devSource() : unknownProfile())
    profileDirInput = inferred
    profileNameInput = explicitProfileName || undefined
  }
  const homeDirInput = overrides.homeDir ?? config.homeDir ?? homeDirDefault
  const environmentKind =
    overrides.environmentKind ?? detectEnvironmentKind(overrides.ctx, resolveProfileName(profileNameInput, profileDirInput))
  const checkTimeoutMs = overrides.checkTimeoutMs ?? config.checkTimeoutMs
  const confirmationTtlMs = overrides.confirmationTtlMs ?? config.confirmationTtlMs
  const installTimeoutMs = overrides.installTimeoutMs ?? config.installTimeoutMs
  const registryUrl = overrides.registryUrl ?? config.registryUrl
  const key = `${pluginId}\0${config.prefix}\0${runningVersion}\0${dshVersion}\0${profileDirInput}\0${profileNameInput ?? ''}\0${homeDirInput}\0${overrides.runInstall ? 'exec' : ''}\0${environmentKind}\0${targetPackageName}\0${explicitTargetDir}\0${releaseChannel}`
  if (sharedReader && sharedReaderKey === key) return sharedReader
  // 绑好插件标识的发射口（#124）：中立文件不 import node、也不认识插件标识，端口一律在宿主侧绑好再递进去。
  // 磁盘侧就是本插件这一家；队列与全局锁是**跨插件共享**的，所以给一个「按当次动作方取口」的工厂——
  // 一次跃迁记在谁头上，行就落谁自己的目录（路由表按标识寻址，别的插件没接线就只能没有落点，不猜）。
  const logPortFor = (id: string): UpdateLogPort => (level, event, fields, opts) => {
    emitUpdateLog(level, event, fields, { ...opts, pluginId: id })
  }
  const disk =
    overrides.readJob && overrides.writeJob
      ? null
      : createUpdateDiskPorts(homeDirInput, pluginId, profileDirInput, { log: logPortFor(pluginId) })
  // 跨插件单队列（#15）：与插件标识无关，按使用范围共享。显式队列假件优先；有真实落盘
  // 才走真实队列目录；纯内存测试（磁盘被假件替代）默认不碰真实队列目录，免得单测写脏真机。
  // 队列自身永远 best-effort：读不到按空队放行，写失败吞掉——队列坏了不能挡安装。
  const queueTtlMs =
    typeof overrides.queueTtlMs === 'number' && Number.isFinite(overrides.queueTtlMs) && overrides.queueTtlMs > 0
      ? overrides.queueTtlMs
      : QUEUE_INTENT_TTL_MS
  const queueDisk =
    overrides.readQueue && overrides.writeQueue
      ? null
      : disk
        ? createUpdateQueuePorts(homeDirInput, profileDirInput, { logFor: logPortFor })
        : null
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
  // #181：内置端口要吃到安装额度（陈旧阈值与安装时限同源），显式覆盖实现保持单参不变。
  const baseTryAcquire: ((lockId: string) => boolean | Promise<boolean>) | undefined = overrides.tryAcquireLock
    ? (lockId: string) => overrides.tryAcquireLock!(lockId)
    : disk
      ? (lockId: string) => disk.tryAcquireLock(lockId, { timeoutMs: installTimeoutMs })
      : undefined
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
  // 任务落盘（#179）：以前这里只留内存镜像，进程一崩任务就没了——`recovery-required` 永不点亮，
  // 半装态还会被环境比较画成「待重启」。现在写镜像的同时写盘（无注入走真实磁盘端口），
  // 首次读任务时先尝试从盘上取回初值（冷启动/重启后的唯一真相）。
  // 磁盘写失败不挡安装：内存镜像仍是本次真值，store 侧已记 store.fail；落盘的失败语义由装后校验兜底。
  // 落盘只在「两侧都没注入」时启用：只注一侧时不混两套真相（写走注入、读走镜像）。
  const jobDisk = overrides.readJob || overrides.writeJob ? null : disk
  let memJobFallback: import('./ports.js').UpdateJob | null = null
  let jobStoreSeeded = false
  async function mirroredWriteJob(job: import('./ports.js').UpdateJob | null): Promise<void> {
    if (overrides.writeJob) {
      memJobFallback = job
      await overrides.writeJob(job)
    } else {
      memJobFallback = job
      jobStoreSeeded = true
      if (jobDisk) {
        try {
          await jobDisk.writeJob(job)
        } catch {}
      }
    }
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
    // 冷启动首次读盘取初值；读失败不写死空——下一次读还会再试，免得一次瞬时失败把本进程画成「无任务」。
    // 坏形状的收敛在 store.readJob 里（corrupt → interrupted / recovery-required），这里不另立判据。
    if (!jobStoreSeeded && !memJobFallback && jobDisk) {
      try {
        memJobFallback = await jobDisk.readJob()
        jobStoreSeeded = true
      } catch {}
    }
    return memJobFallback
  }
  // 执行零件按需现取（桌面服务要等注入到位）：路由与参数形态由核心的 installRecipe 定，
  // 这里只提供「用哪个可执行文件、哪份 CLI 入口、哪条子进程口子」。
  const defaultRun = createUpdateExecutor({
    profileName: profileNameInput ?? null,
    environmentKind,
    releaseChannel,
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
  // 中立核心不 import node，也不认识插件标识：这里把**绑好插件标识**的发射口递进去（#124）。
  // 不递也能跑，只是没有 update.* 的常驻/按需行；递进去的每一行都走唯一发射口（脱敏/白名单/预算都在里面）。
  const coreLog: UpdateLogPort = logPortFor(pluginId)
  // 源主机名只在宿主侧解析一次（白名单口径在 redaction）：核心只把它填进两格，不自己解析 URL。
  const coreRegistryHost = resolveRegistryHost(registryUrl)
  sharedReader = Object.assign(
    createUpdateReader({
      runningVersion,
      dshVersion,
      profileDir: profileDirInput,
      pluginId,
      profileName: profileNameInput,
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
      emitLog: coreLog,
      registryHost: coreRegistryHost,
    }),
    // 跨插件队列的面板侧读写口（#15）：与本次解析出的使用范围绑定，面板经电话可选参数消费。
    { readQueuePruned: loadQueuePruned, writeQueueState: writeQueueBestEffort, queueTtlMs, queueNow },
  )
  sharedReaderKey = key
  return sharedReader
}

/** 核心错误码原样返回，外面世界的脏错误收敛为检查失败（码面真源在 src/codes.ts，#141）。 */
function toUpdateErrorPayload(error: unknown): { error: string; errorKind: string } {
  const code = error && typeof (error as { code?: unknown }).code === 'string' ? String((error as { code: string }).code) : ''
  if (isCoreErrorCode(code)) return { error: code, errorKind: code }
  return { error: 'check-failed', errorKind: 'internal' }
}

function manualOfEnv(
  env: { profileName?: string | null; sourceInstall?: boolean } | null,
  snapshot: { latestVersion?: string | null; installedVersion?: string | null; runningVersion?: string | null; job?: { targetVersion?: string | null } | null; blockedReason?: string | null } | null,
  config: ReturnType<typeof resolveUpdateConfig>
): string | null {
  try {
    return manualCommand({
      profileName: env?.profileName ?? null,
      latestVersion: snapshot?.latestVersion ?? null,
      installedVersion: snapshot?.installedVersion ?? null,
      runningVersion: snapshot?.runningVersion ?? null,
      jobTargetVersion: snapshot?.job?.targetVersion ?? null,
      blockedReason: (snapshot?.blockedReason as never) ?? null,
      sourceInstall: env?.sourceInstall === true,
      targetPackageName: config.targetPackageName,
      registryUrl: config.registryUrl,
      releaseChannel: config.releaseChannel,
    })
  } catch {
    return null
  }
}

async function snapWithManual(
  reader: ReturnType<typeof createUpdateReader>,
  snapshot: { latestVersion?: string | null; installedVersion?: string | null; runningVersion?: string | null; job?: { targetVersion?: string | null } | null; blockedReason?: string | null },
  config: ReturnType<typeof resolveUpdateConfig>
): Promise<{ snapshot: unknown; manual: string | null; diag?: DiagObject }> {
  try {
    const out: { snapshot: unknown; manual: string | null; diag?: DiagObject } = {
      snapshot,
      manual: manualOfEnv(await reader.readEnv(), snapshot, config),
    }
    // 失败任务的机读诊断（#156 第四轮）：安装是异步的，拦下时回包照旧 ok:true，失败只在快照任务里。
    // 这里把宿主自己知道的包名补回 diag，面板才不必拿插件标识当包名去猜（详见 failedJobDiagOf）。
    const diag = failedJobDiagOf(snapshot, { targetPackageName: config.targetPackageName, registryUrl: config.registryUrl })
    return diag ? { ...out, diag } : out
  } catch {
    return { snapshot, manual: null }
  }
}

/**
 * 失败任务的机读诊断（#156 对抗审查第四轮）。
 *
 * 安装是异步的：装上被年龄门拦下时，安装电话回包照旧是 ok:true，真正的失败只出现在之后
 * status 回包的快照任务里（state=failed，message=「失败码: 原文」）。这条路上以前没有 diag，
 * 面板只能拿**插件标识**当包名去认失败原文；而真宿主（dsh-life-pack）给的标识是 `life-<key>`
 * 这类派生值，与 npm 包名（dsh-prompt 之类）不是一回事——于是「装合规版」四个入口在生产形状下
 * 全都认不出因（fail-closed 成一枚死按钮）。
 *
 * 这里让宿主把自己知道的两件事（目标包名、失败原文）按同一套 buildDiag 组装回 diag：
 * 面板的机读路（causeKind／causePackage／targetPackageName）即可命中，不再靠标识撞运气。
 * 只在失败任务上带；查询成功且无失败任务时一个键都不加，旧形状逐字不变（#21）。
 */
export function failedJobDiagOf(
  snapshot: unknown,
  input: { targetPackageName?: unknown; registryUrl?: unknown },
): DiagObject | undefined {
  try {
    const snap = snapshot && typeof snapshot === 'object' ? (snapshot as Record<string, unknown>) : null
    const job = snap && snap['job'] && typeof snap['job'] === 'object' ? (snap['job'] as Record<string, unknown>) : null
    if (!job || job['state'] !== 'failed') return undefined
    const message = typeof job['message'] === 'string' ? job['message'] : ''
    const at = message.indexOf(':')
    const code = (at > 0 ? message.slice(0, at) : message).trim()
    const detail = at > 0 ? message.slice(at + 1).trim() : ''
    if (!code) return undefined
    // 电话种类只在「解码 → 阶段」这一步有用：失败码自带上下文（install-* 即安装侧），认不出的码
    // 落到同一支兜底（buildDiag 里 deriveStage 对未知 kind 也按安装上下文解），故这里不问调用方。
    const phoneKind = code.startsWith('install') ? 'update-install' : code.startsWith('check') ? 'update-check' : 'update-status'
    const built = buildDiag({
      errorCode: code,
      phoneKind,
      // 任务里只剩「码 + 原文」；把原文放回 detail 格，翻译官照旧从同一处挑因。
      error: detail ? { code, detail } : { code },
      args: {},
      targetPackageName: input.targetPackageName,
      registryUrl: input.registryUrl,
      runningVersion: snap?.['runningVersion'],
    })
    return built && typeof built === 'object' ? built : undefined
  } catch {
    return undefined
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
  /**
   * 在册事实（#180 读取器给出、#184 起转发到面板）：目标包在 profile 加载名单里吗？
   * true=登记着；false=清单里没有它（例如宿主 removeBundle 先摘选中、重装没走完）；
   * null=旧读取器/旧覆盖实现没给这格，按未知（面板不据此判失败）。
   */
  registered: boolean | null
  /**
   * 更新器自检（#196 部署偏斜）：这块面板实际加载到的本包副本版本与层级。
   * 同机可能并存使用范围级 / 消费方嵌套的多代副本，同一动作行为不同，先看这两格对账；
   * 只给版本与层级，**不回本机路径**（路径留在宿主日志/诊断里，电话形状不带目录）。
   */
  updaterVersion: string | null
  updaterCopyLevel: SelfCopyLevel
}

/** 更新器自检缓存：整个宿主生命周期内只算一次（模块加载地址定死，不会变）。 */
let selfCopyInfoPromise: Promise<SelfCopyInfo> | null = null

function currentSelfCopy(): Promise<SelfCopyInfo> {
  selfCopyInfoPromise ??= selfCopyInfo()
  return selfCopyInfoPromise
}

async function readEnvForPanel(reader: { readEnv?: () => Promise<unknown> }): Promise<PhoneEnvView | null> {
  try {
    if (typeof reader.readEnv !== 'function') return null
    const env = (await reader.readEnv()) as { profileName?: unknown; environmentKind?: unknown; registered?: unknown } | null
    if (!env || typeof env !== 'object') return null
    const self = await currentSelfCopy().catch(() => null)
    return {
      profileName: typeof env.profileName === 'string' && env.profileName ? env.profileName : null,
      environmentKind: typeof env.environmentKind === 'string' && env.environmentKind ? env.environmentKind : null,
      registered: typeof env.registered === 'boolean' ? env.registered : null,
      updaterVersion: self && self.version ? self.version : null,
      updaterCopyLevel: self ? self.level : 'unknown',
    }
  } catch {
    return null
  }
}

/** 调用方显式要使用范围一栏时才算（默认不算，老回包形状不变）。 */
function wantsEnv(args: Record<string, unknown>): boolean {
  return !!args && args['includeEnv'] === true
}

/**
 * 落点类型：与既有生态的 `logCtx` 同形（只有 `fire`，可选 `isEnabled`）。
 * 名字保留是因为集成方的 deps 类型引用了它；实现已迁进内核（`src/log/sink.ts`）。
 */
type LogCtx = LogSink | null

/** 安装执行结果进日志（常驻事件 update.install.exec，由执行器在跨边界调用后发）。 */
function emitInstallLog(level: string, event: string, fields: Record<string, unknown>): void {
  emitUpdateLog(level, event, fields)
}

/** 日志根目录：`<homeDir>/logs`（现场三家插件都在这里，`dsh-log <DSH_HOME>/logs` 一条命令横扫全部）。 */
function updateLogRootDir(homeDir: unknown): string {
  return join(String(homeDir ?? ''), 'logs')
}

/**
 * 本插件日志目录（`#123`）：`<homeDir>/logs/<派生命名空间>` —— 与落盘、与 README 里的派生规则同一个算式。
 *
 * 给面板挂载项的 `logDir` 用：宿主/入口把它传给 `mountUpdatePanel`（或 `mountUpdatePanelHttp`），
 * 面板错误章的路牌就能给出一条能直接抄的 `npx dsh-log <dir>`；不传时路牌退回算式与命令模板，
 * 绝不给一个并不存在的值。家目录优先级与其余入口一致：显式 `homeDir` > `DSH_HOME` > `~/.dsh`。
 */
export function updateLogDirFor(pluginId: string, homeDir?: string | null): string {
  const explicit = typeof homeDir === 'string' && homeDir.trim() ? homeDir.trim() : null
  const root = updateLogRootDir(explicit ?? defaultHomeDir(process.env, homedir()))
  return join(root, deriveLogNamespace(pluginId))
}

/**
 * 接线日志：把落点挂进路由表，并如实记一条 `update.wire.ready`。
 *
 * 归属规则（ADR-0005 决策 2）：集成方给了 `logCtx` 就用它的实例，本包绝不再开第二个写者；
 * 没给就自建 dsh-log 实例（同一目录在同一进程里只有一个句柄，由内核登记表兜住，跨副本也只有一个）；
 * 自建失败就降级成「没有落点」并**解绑** —— 之后每一行都计入丢弃，绝不回退到别人的 sink。
 *
 * 建库是异步的（`dsh-log/node` 要动态 import 再读盘），而 `createHostUpdate` 是同步契约，
 * 所以先接一个「先收后转」的待接落点：建好了按序灌进真落点，建不起来就整体丢弃。
 */
function wireUpdateLog(
  homeDir: string,
  prefix: string,
  pluginId: string,
  namespace: string,
  integratorLogCtx: unknown,
  integratorEventList: unknown
): void {
  const logsRoot = updateLogRootDir(homeDir)
  const namespaceDirHash = logDirHash(`${logsRoot}${sep}${namespace}`)
  const external = sinkFromLogCtx(integratorLogCtx)
  if (external) {
    updateLogRouter.bind(pluginId, external)
    emitUpdateLog('info', 'update.wire.ready', { logSink: 'external', logDirHash: namespaceDirHash }, { pluginId })
    return
  }
  const pending = createPendingSink()
  updateLogRouter.bind(pluginId, pending.sink)
  void (async (): Promise<void> => {
    const built = await buildUpdateManifest(namespace, integratorEventList)
    const got = await acquireOwnLog({
      logsRoot,
      namespace,
      prefix,
      eventList: built.manifest,
      onDegrade: (reason) => {
        // 建不起来的坏消息只能如实记下（此刻没有落点可写，所以这行多半也到不了任何文件）。
        emitUpdateLog('warn', 'update.log.degraded', { reason }, { pluginId })
      },
    })
    if (got.sink) {
      pending.attach(got.sink)
      emitUpdateLog('info', 'update.wire.ready', { logSink: 'self', logDirHash: logDirHash(got.dir) }, { pluginId })
      return
    }
    pending.attach(null)
    updateLogRouter.unbind(pluginId, pending.sink)
    emitUpdateLog('info', 'update.wire.ready', { logSink: 'off', logDirHash: namespaceDirHash }, { pluginId })
  })()
}

/** 电话回包里的可选队列视图（#15）：只在调用方显式要时才带，不传即与改造前一字不差。 */
function queueArgsOf(args: Record<string, unknown>): { includeQueue: boolean; showOthers: boolean } {
  return {
    includeQueue: !!args && args['includeQueue'] === true,
    showOthers: !!args && args['showOthers'] === true,
  }
}

/**
 * 轮询抑制记忆（#124）：**每个宿主接线实例一份**，不是模块级——所以同进程的不同实例、
 * 不同测试互不干扰；一个实例的第一次 `updateStatus` 永远算「没有上一次可比」，照常落一行。
 */
type StatusPollMemory = Map<string, string>

/**
 * 快照指纹（#124）：**只做进程内比较用，绝不入日志行**（脱敏面不因此扩大）。
 * 序列化不了（循环引用）就返回 null，等于「算不出，别抑制」——宁可多发一行，也不误吞一次状态变化。
 */
function statusFingerprint(snapshot: unknown): string | null {
  try {
    if (typeof snapshot === 'string') return snapshot
    const text = JSON.stringify(snapshot)
    return typeof text === 'string' ? text : null
  } catch {
    return null
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
  fn: (args: Record<string, unknown>) => Promise<{
    snapshot: unknown
    manual?: string | null
    receipt?: unknown
    queue?: VisibleQueue | null
    env?: PhoneEnvView | null
    /** 可选：契约健康（#210），只有 updateStatus 带。 */
    logContract?: UpdateContractStatus
    /** 可选：机读诊断（#21/#18），成功回包在快照里有失败任务时才带。 */
    diag?: unknown
  }>,
  diagCtx?: {
    config: ReturnType<typeof resolveUpdateConfig>
    readerOverrides: ReaderOverrides
  },
  /** 轮询抑制记忆（#124）：只有 `updateStatus` 用得上；不传即完全不抑制（默认等于现状）。 */
  pollMemory?: StatusPollMemory,
): (args: Record<string, unknown>) => Promise<Record<string, unknown>> {
  /**
   * 一次电话 = 一条链（`0.16.4` 起，需 dsh-log 0.3.3 的 `store.trace()`）。
   * 链挂在**路由表给这个插件的落点**上：发射口只认与落点同源的链，所以 A 插件的链
   * 绝不会写到 B 插件的目录里。落点还没接上（自建实例是异步的）或集成方注入的是
   * 客户端实例时，`withLogTrace` 拿不到链，发射口退回原来的 `fire` —— 既有行为不变。
   */
  const sinkForPhone = (): LogSink | null => {
    try {
      return updateLogRouter.resolve(pluginId) ?? null
    } catch {
      return null
    }
  }

  async function runPhone(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const t0 = Date.now()
    // 行统一从唯一发射口出去：落点按插件标识从路由表取（不再有「模块级最后一个落点」这种串台入口）。
    const emit = (level: string, event: string, fields: Record<string, unknown>): void => {
      emitUpdateLog(level, event, fields, { pluginId })
    }
    const safeArgs = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
    try {
      const out = await fn(safeArgs)
      const snapshot = out && out.snapshot ? out.snapshot : out
      // 轮询抑制（#124）：`updateStatus` 是每秒一次的既有轮询，**成功行一律不落常驻行**——
      // 名字与字段一字不动，只改「发不发」。依据：`host.call` 在 dsh-log 内置常驻名单里，
      // 集成方清单改不动它，所以只能在发射侧治（现场 934 KB/天里有 5309 行是它）。
      // 第一次轮询没有可比的上次，也不算事件：轮询的第一次观测不是事件（#125 装置的判据就是
      // 「N≥100 次轮询零常驻行」）；真状态事实走 `update.status.changed` 的边沿行与按需档 `update.poll`。
      // 只有「上次算得出指纹、这次算得出、且与上次不同」才留一行，供真发生变化时追溯。
      const isStatusPoll = method.endsWith('.updateStatus')
      const fingerprint = isStatusPoll ? statusFingerprint(snapshot) : null
      const pollNoise = isStatusPoll && pollMemory !== undefined
      const previous = pollNoise ? (pollMemory.get(pluginId) ?? null) : null
      if (pollNoise && fingerprint !== null) pollMemory.set(pluginId, fingerprint)
      const pollSuppressed = pollNoise && fingerprint !== null && (previous === null || previous === fingerprint)
      if (!pollSuppressed) {
        // 成功事件 5 键基线（规格 #591 第 8 条）：旧 4 键加必填插件标识。
        // 成功形状不动（#21）：成功回包不因成功而带 diag——唯一例外是快照里躺着失败任务
        //（异步安装的失败在快照里，见下方 diag 透传）；无失败任务时旧面板逐字不变。
        emit('info', LOG_EVENT_CALL, { method, latencyMs: Date.now() - t0, ok: true, kind, pluginId })
      }
      return {
        ok: true,
        snapshot,
        manual: out && out.snapshot ? (out.manual ?? null) : null,
        receipt: out && out.receipt ? out.receipt : null,
        // 新增选填（#210）：契约健康——面板/诊断据此知道「字段门禁这轮有没有尺子」。
        ...(out && out.logContract ? { logContract: out.logContract } : {}),
        // 新增选填（#15）：调用方没要时不带该键，老调用形状不变。
        ...(out && out.queue ? { queue: out.queue } : {}),
        // 新增选填：使用范围一栏（只有调用方传了 includeEnv 才带，老调用形状不变）。
        ...(out && out.env ? { env: out.env } : {}),
        // 新增选填（#156 第四轮）：异步安装的失败藏在快照任务里——此时成功回包也带机读诊断，
        // 因为「哪家的哪个包被拦下」只有宿主知道，面板拿插件标识猜不出来（B4）。无失败任务即不带。
        ...(out && out.diag ? { diag: out.diag } : {}),
      }
    } catch (error) {
      const payload = toUpdateErrorPayload(error)
      // 失败事件 4 键基线（规格 #591 第 8 条）：旧 3 键加必填插件标识。
      emit('warn', LOG_EVENT_CALL_FAIL, { method, kind, error: payload.error, errorHash: hash8(String((error as Error)?.message || payload.error)), pluginId })
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
      // 失败也带使用范围与队列（#45：调用方显式要才带，老调用形状不变；best-effort，读不到即省略）。
      // 读数只取一次：取不到则 env 与 queue 一并省略（两者消费互相独立，互不挡路）。
      let failReader: Awaited<ReturnType<typeof getSharedReader>> | null = null
      try {
        const failConfig = diagCtx?.config
        const failOverrides = (diagCtx?.readerOverrides ?? {}) as ReaderOverrides
        if (failConfig && (wantsEnv(safeArgs) || queueArgsOf(safeArgs).includeQueue)) {
          failReader = await getSharedReader(pluginId, failConfig, {
            ...failOverrides,
            profileDir:
              safeArgs && safeArgs.profileDir ? String(safeArgs.profileDir) : failOverrides.profileDir,
          })
        }
      } catch {
        failReader = null
      }
      let envPatch: Record<string, unknown> = {}
      try {
        if (failReader && wantsEnv(safeArgs)) {
          const env = await readEnvForPanel(failReader)
          if (env) envPatch = { env }
        }
      } catch {
        envPatch = {}
      }
      let queuePatch: Record<string, unknown> = {}
      try {
        const { includeQueue, showOthers } = queueArgsOf(safeArgs)
        if (failReader && includeQueue) {
          const requestIdForQueue =
            safeArgs && typeof safeArgs.requestId === 'string' ? String(safeArgs.requestId) : undefined
          const q = visibleQueueFor(await failReader.readQueuePruned(), pluginId, showOthers, requestIdForQueue)
          if (q) queuePatch = { queue: q }
        }
      } catch {
        queuePatch = {}
      }
      return { ok: false, ...payload, ...(diag ? { diag } : {}), ...envPatch, ...queuePatch }
    }
  }

  return async function (args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return withLogTrace(sinkForPhone(), () => runPhone(args))
  }
}

/**
 * 更新日志电话的包边（#38）：成功只回 version + markdown（无路径、无快照），
 * 失败复用 error / errorKind 体系 + 可选 diag；日志沿用 host.call / host.call.fail 基线。
 */
function loggedChangelogPhone(
  method: string,
  pluginId: string,
  fn: (args: Record<string, unknown>) => Promise<{ version: string; markdown: string | null }>,
  diagCtx?: {
    config: ReturnType<typeof resolveUpdateConfig>
    readerOverrides: ReaderOverrides
  },
): (args: Record<string, unknown>) => Promise<Record<string, unknown>> {
  // 与 `loggedPhone` 同一条纪律：一次电话 = 一条链（0.16.4 起）。
  const sinkForPhone = (): LogSink | null => {
    try {
      return updateLogRouter.resolve(pluginId) ?? null
    } catch {
      return null
    }
  }

  async function runChangelogPhone(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const t0 = Date.now()
    const emit = (level: string, event: string, fields: Record<string, unknown>): void => {
      emitUpdateLog(level, event, fields, { pluginId })
    }
    const safeArgs = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
    try {
      const out = await fn(safeArgs)
      emit('info', LOG_EVENT_CALL, { method, latencyMs: Date.now() - t0, ok: true, kind: 'update-changelog', pluginId })
      return { ok: true, version: out.version, markdown: out.markdown }
    } catch (error) {
      const payload = toUpdateErrorPayload(error)
      emit('warn', LOG_EVENT_CALL_FAIL, { method, kind: 'update-changelog', error: payload.error, errorHash: hash8(String((error as Error)?.message || payload.error)), pluginId })
      let diag: Record<string, unknown> | undefined
      try {
        const cfg = diagCtx?.config
        const overrides = diagCtx?.readerOverrides ?? {}
        const envRaw = (overrides as ReaderOverrides)?.environmentKind
        const runningRaw = (overrides as ReaderOverrides)?.runningVersion
        const built = buildDiag({
          errorCode: payload.error,
          phoneKind: 'update-changelog',
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

  return async function (args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return withLogTrace(sinkForPhone(), () => runChangelogPhone(args))
  }
}

export interface HostUpdate {
  phoneNames: PhoneNames
  handlers: Record<string, (args: Record<string, unknown>) => Promise<Record<string, unknown>>>
}

/**
 * 建宿主更新能力：一次调用得到该插件的一组电话名与处理器（调用方负责注册进自己的电话表）。
 * 配置只经函数入参注入（冻结写法，第 11 条），插件标识必填，其余可选。
 */
export function createHostUpdate(deps: { ctx?: unknown; logCtx?: LogCtx; logEventList?: unknown; desktopPnpm?: unknown; pluginManager?: unknown; readerOverrides?: ReaderOverrides } = {}, configInput: UpdateConfigInput): HostUpdate {
  const config = resolveUpdateConfig(configInput)
  const pluginId = config.pluginId
  // 日志接线：先起随包清单的加载，再按「外部实例优先、没有才自建」挂落点（ADR-0005）。
  // 家目录与 getSharedReader（第 417 行）同一优先级：显式覆盖 > 配置 > DSH_HOME/家目录。
  const logOverrides = (deps.readerOverrides ?? {}) as ReaderOverrides
  const logHomeDir =
    logOverrides.homeDir ?? config.homeDir ?? defaultHomeDir(logOverrides.env ?? process.env, logOverrides.osHome ?? homedir())
  primeUpdateEventTable()
  wireUpdateLog(logHomeDir, config.prefix, pluginId, deriveLogNamespace(pluginId), deps.logCtx, deps.logEventList)
  // 宿主上下文：探测宿主种类（桌面 / 普通 DSH）并接上执行零件（子进程口子、桌面服务）。
  const ctx = deps.ctx ?? null
  if (deps.desktopPnpm) sharedDesktopPnpm = deps.desktopPnpm
  else watchDesktopPnpm(ctx)
  const readerOverrides = { ...(deps.readerOverrides ?? {}), ctx, ...(deps.pluginManager ? { pluginManager: deps.pluginManager } : {}) } as ReaderOverrides
  const phoneNames = buildPhoneNames(config.prefix)
  // 更新日志按版本记住结果（#41 终裁）：成功与取不到按版本永久记（宿主进程级，不落盘）；
  // 传输失败（抛错）不进缓存，下次重查；轮询退避由面板侧按 shouldFetchChangelog 门控，宿主侧总视为手动（有缓存即回，无缓存即取）。
  const changelogCache = new Map<string, string | null>()
  const changelogFailedAt = new Map<string, number>()
  async function readChangelog(args: Record<string, unknown>): Promise<{ version: string; markdown: string | null }> {
    const raw = args ? (args as Record<string, unknown>)['version'] : undefined
    if (!validReleaseVersion(raw)) throw updateError('invalid-release')
    const version = raw as string
    if (!isVersionAllowedInChannel(version, config.releaseChannel)) throw updateError('invalid-release')
    if (changelogCache.has(version)) return { version, markdown: changelogCache.get(version) ?? null }
    try {
      let nowMs = 0
      try { nowMs = Date.now(); } catch { nowMs = 0; }
      const failedAt = changelogFailedAt.has(version) ? (changelogFailedAt.get(version) as number) : null
      void shouldFetchChangelog({ hasCache: false, failedAt: failedAt, now: nowMs, isManual: true })
    } catch { }
    const fetchImpl = (readerOverrides as { fetchImpl?: unknown }).fetchImpl ?? (globalThis as unknown as { fetch?: unknown }).fetch
    const release = await fetchNpmVersionRelease(fetchImpl as never, config.checkTimeoutMs, {
      targetPackageName: config.targetPackageName,
      registryUrl: config.registryUrl,
      releaseChannel: config.releaseChannel,
      version,
    })
    let markdown: string | null
    try {
      markdown = await fetchReleaseChangelogText(
        fetchImpl,
        { tarball: release.tarball, integrity: release.integrity, version },
        { targetPackageName: config.targetPackageName, registryUrl: config.registryUrl, timeoutMs: config.checkTimeoutMs },
      )
    } catch (err) {
      try { changelogFailedAt.set(version, Date.now()); } catch { try { changelogFailedAt.set(version, 0); } catch {} }
      throw err
    }
    changelogCache.set(version, markdown)
    try { changelogFailedAt.delete(version); } catch { }
    // changelog 解析（#124，ondemand 档）：宿主侧只**多算一次统计**用于落行，不改回包形状
    // （回包仍是原文，渲染方自己解析）。缓存命中在上面的早退分支返回，不发这条——那次没有解析发生。
    try {
      const report = parseChangelogReport(markdown ?? '')
      emitUpdateLog('info', 'update.changelog.parse', {
        entries: Array.isArray(report.entries) ? report.entries.length : 0,
        truncated: report.truncation ? true : false,
        degraded: markdown === null,
        source: 'npm',
      }, { pluginId })
    } catch { /* 打点绝不影响取日志 */ }
    return { version, markdown }
  }
  async function readStatus(args: Record<string, unknown>): Promise<{
    snapshot: unknown
    manual: string | null
    logContract?: UpdateContractStatus
    env?: PhoneEnvView | null
    queue?: VisibleQueue | null
  }> {
    const reader = await getSharedReader(pluginId, config, {
      ...readerOverrides,
      profileDir: args && args.profileDir ? String(args.profileDir) : readerOverrides.profileDir,
    })
    const out = await snapWithManual(reader, (await reader.status()) as never, config)
    const logContract = updateContractStatus()
    const env = wantsEnv(args) ? { env: await readEnvForPanel(reader) } : {}
    const { includeQueue, showOthers } = queueArgsOf(args)
    if (!includeQueue) return { ...out, logContract, ...env }
    const requestId = args && typeof args.requestId === 'string' ? args.requestId : undefined
    return { ...out, logContract, ...env, queue: visibleQueueFor(await reader.readQueuePruned(), pluginId, showOthers, requestId) }
  }
  async function readCheck(args: Record<string, unknown>): Promise<{ snapshot: unknown; manual: string | null; receipt: unknown; env?: PhoneEnvView | null; queue?: VisibleQueue | null }> {
    const reader = await getSharedReader(pluginId, config, {
      ...readerOverrides,
      profileDir: args && args.profileDir ? String(args.profileDir) : readerOverrides.profileDir,
    })
    // 触发方只有调用方知道（面板同一支电话里既有用户点也有自动跑）：报了才落 `update.check.start`（#124）。
    const askedBy: CheckTrigger | undefined =
      args && typeof args['trigger'] === 'string' ? (args['trigger'] as CheckTrigger) : undefined
    const result = await reader.check(askedBy)
    const withManual = await snapWithManual(reader, result.snapshot as never, config)
    const env = wantsEnv(args) ? { env: await readEnvForPanel(reader) } : {}
    const { includeQueue, showOthers } = queueArgsOf(args)
    if (!includeQueue) return { snapshot: withManual.snapshot, manual: withManual.manual, receipt: result.receipt ?? null, ...(withManual.diag ? { diag: withManual.diag } : {}), ...env }
    const requestId = args && typeof args.requestId === 'string' ? args.requestId : undefined
    return {
      snapshot: withManual.snapshot,
      manual: withManual.manual,
      receipt: result.receipt ?? null,
      ...(withManual.diag ? { diag: withManual.diag } : {}),
      ...env,
      queue: visibleQueueFor(await reader.readQueuePruned(), pluginId, showOthers, requestId),
    }
  }
  /**
   * 合规版决议电话（#156）：面板把翻译官结论里"调用方知道"的部分递进来
   *（kind/blame/目标版/窗口/发布时间），核心取时间表做五值裁决；有候选即落
   * 第二槽凭证并随回包带回。取数失败诚实抛（面板退通用老路），永不编造候选。
   * 回包形状走 loggedPhone 通用包装：snapshot 格即决议结果，receipt 格即候选凭证。
   */
  async function readCheckFallback(args: Record<string, unknown>): Promise<{ snapshot: unknown; receipt: unknown }> {
    const reader = await getSharedReader(pluginId, config, {
      ...readerOverrides,
      profileDir: args && args.profileDir ? String(args.profileDir) : readerOverrides.profileDir,
    })
    const blameRaw = args && typeof args['blame'] === 'string' ? args['blame'] : undefined
    const windowSourceRaw = args && typeof args['windowSource'] === 'string' ? args['windowSource'] : undefined
    const result = await reader.checkFallback({
      ...(args && typeof args['kind'] === 'string' && args['kind'] ? { kind: args['kind'] as string } : {}),
      ...(blameRaw === 'target' || blameRaw === 'other-package' || blameRaw === 'unknown' ? { blame: blameRaw as 'target' | 'other-package' | 'unknown' } : {}),
      ...(args && typeof args['targetVersion'] === 'string' && args['targetVersion'] ? { targetVersion: args['targetVersion'] as string } : {}),
      ...(args && typeof args['windowMs'] === 'number' && Number.isFinite(args['windowMs']) ? { windowMs: args['windowMs'] as number } : {}),
      ...(windowSourceRaw === 'message' || windowSourceRaw === 'host' || windowSourceRaw === 'unknown' ? { windowSource: windowSourceRaw as 'message' | 'host' | 'unknown' } : {}),
      ...(args && typeof args['publishedAtMs'] === 'number' && Number.isFinite(args['publishedAtMs']) ? { publishedAtMs: args['publishedAtMs'] as number } : {}),
    })
    return { snapshot: { verdict: result.verdict, candidate: result.candidate }, receipt: result.receipt ?? null }
  }
  async function runInstall(args: Record<string, unknown>): Promise<{ snapshot: unknown; manual: string | null; env?: PhoneEnvView | null; queue?: VisibleQueue | null }> {
    const checkId = args && typeof args.checkId === 'string' ? args.checkId : ''
    const requestId = args && typeof args.requestId === 'string' ? args.requestId : ''
    // 安装意图来源（#124）：调用方自报就照传（批量驱动报 `'batch'`），认不出按 `'panel'`——
    // 老调用方不传即现状，只影响日志行 `update.install.request.from`，不参与任何决策。
    const installFrom: InstallSource =
      args && (args['from'] === 'entry' || args['from'] === 'batch') ? (args['from'] as InstallSource) : 'panel'
    // 候选安装（#156）：调用方点"装合规版"时带候选版；不带即走 latest 老路。
    // 只做形状提取（非空字符串），绑定校验归核心第二槽——这里不认任何版本。
    const installVersion = args && typeof args['version'] === 'string' && args['version'] ? String(args['version']) : undefined
    // 批准构建名单（#194）：上一次失败点名「需要批准的构建脚本」后，调用方决定批准时把宿主给的
    // 精确包名带回；形状归一在这里做（只认安全包名），核心零导入契约不破。不传即现状。
    const approvedBuilds = normalizeApprovedBuilds(args ? args['approvedBuilds'] : undefined)
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
    // 候选版随凭证一起进核心（#156）：核心只认第二槽绑定，占位仍按插件+编号，不按版本。
    if (!checkId || !validRequestId(requestId)) {
      const out = await snapWithManual(reader, (await reader.install({ checkId, requestId, from: installFrom, ...(installVersion ? { version: installVersion } : {}), ...(approvedBuilds.length > 0 ? { approvedBuilds } : {}) })) as never, config)
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
      const out = await snapWithManual(reader, (await reader.install({ checkId, requestId, from: installFrom, ...(installVersion ? { version: installVersion } : {}), ...(approvedBuilds.length > 0 ? { approvedBuilds } : {}) })) as never, config)
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
  /**
   * 客户端日志电话（#122）：面板侧的行经这里写进本插件的**同一个** log handle —— 单写者语义不变。
   *
   * 三条纪律：
   *   1. **永不抛**：形状坏成什么样都只回 `{ accepted, dropped }`（面板侧据此计数，不会因为日志把功能搞挂）。
   *   2. **不自我放大**：这个电话**不产生 `host.call` 行**（否则每送一批日志就多一行电话日志），
   *      所以它不经过 `loggedPhone`，直接进表。
   *   3. **口径分明**：协议层拒收（形状不对 / 级别不认识 / 不是客户端事件 / 整行事件不在清单 / 超量 / 过期）
   *      计入 `dropped`；**字段不合清单只摘该字段**（#210：整行仍接收，由发射口记字段级降级行），
   *      引擎因调试开关关掉而 skip 的按需行也不计 drop（那是准入，不是丢行）。
   */
  const LOG_APPEND_MAX_ROWS = 200
  const LOG_APPEND_MAX_FIELD_CHARS = 4096
  const LOG_APPEND_STALE_MS = 10 * 60_000
  function logAppendRows(args: Record<string, unknown>): { accepted: number; dropped: number } {
    let accepted = 0
    let dropped = 0
    try {
      const raw = args && typeof args === 'object' ? (args as Record<string, unknown>)['rows'] : undefined
      if (!Array.isArray(raw)) return { accepted: 0, dropped: 0 }
      const rows = raw.slice(0, LOG_APPEND_MAX_ROWS)
      dropped += Math.max(0, raw.length - rows.length)
      let nowMs = 0
      try {
        nowMs = Date.now()
      } catch {
        nowMs = 0
      }
      const table = currentUpdateEventTable()
      for (const row of rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
          dropped++
          continue
        }
        const r = row as Record<string, unknown>
        const level = r['level']
        const event = r['event']
        const fields = r['fields']
        const ts = r['ts']
        if (typeof level !== 'string' || !(LOG_LEVELS as readonly string[]).includes(level)) { dropped++; continue }
        if (typeof event !== 'string' || !isClientLogEvent(event)) { dropped++; continue }
        if (!fields || typeof fields !== 'object' || Array.isArray(fields)) { dropped++; continue }
        if (typeof ts !== 'number' || !Number.isFinite(ts)) { dropped++; continue }
        if (nowMs > 0 && nowMs - ts > LOG_APPEND_STALE_MS) { dropped++; continue }
        let size = 0
        try {
          size = JSON.stringify(fields)?.length ?? 0
        } catch {
          size = LOG_APPEND_MAX_FIELD_CHARS + 1
        }
        if (size > LOG_APPEND_MAX_FIELD_CHARS) { dropped++; continue }
        // #210：与发射口同一把尺子 —— 未声明/枚举外的字段只丢该字段，整行仍接收；
        // 只有「整行都不该要」的情况（事件不在清单）才在这里计 dropped。
        // 原始字段交给发射口：那里负责裁剪并记字段级降级行，这里不重复裁剪，
        // 否则「丢过字段」这件事在落点就看不见了。
        if (table && pruneEventFields(table, event, fields as Record<string, unknown>).unknownEvent) {
          dropped++
          continue
        }
        emitUpdateLog(level, event, fields as Record<string, unknown>, { pluginId })
        accepted++
      }
    } catch {
      // 电话永不抛：任何意外都只回计数（面板侧的丢弃计数是唯一诚实的说法）。
    }
    return { accepted, dropped }
  }

  // 轮询抑制记忆（#124）：实例级，不跨实例、不跨插件（同一个 updateStatus 电话每 1s 一次）。
  const statusPollMemory: StatusPollMemory = new Map()
  const handlers: Record<string, (args: Record<string, unknown>) => Promise<Record<string, unknown>>> = {
    [phoneNames.updateStatus]: loggedPhone(phoneNames.updateStatus, 'update-status', pluginId, readStatus, {
      config,
      readerOverrides,
    }, statusPollMemory),
    [phoneNames.updateCheck]: loggedPhone(phoneNames.updateCheck, 'update-check', pluginId, readCheck, {
      config,
      readerOverrides,
    }),
    [phoneNames.updateInstall]: loggedPhone(phoneNames.updateInstall, 'update-install', pluginId, runInstall, {
      config,
      readerOverrides,
    }),
    [phoneNames.updateCheckFallback]: loggedPhone(phoneNames.updateCheckFallback, 'update-check-fallback', pluginId, readCheckFallback, {
      config,
      readerOverrides,
    }),
    [phoneNames.updateChangelog]: loggedChangelogPhone(phoneNames.updateChangelog, pluginId, readChangelog, {
      config,
      readerOverrides,
    }),
    [phoneNames.logAppend]: async (args: Record<string, unknown>): Promise<Record<string, unknown>> =>
      logAppendRows(args && typeof args === 'object' ? args : {}),
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
