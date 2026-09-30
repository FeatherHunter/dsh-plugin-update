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
import { validVersion } from './service.js'
import { createUpdateDiskPorts, createUpdateExecutor } from './store.js'
import { createUpdateReader, defaultHomeDir, resolveProfileName, resolveTargetPackage } from './reader.js'
import type { EnvironmentKind } from './ports.js'

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
export { createUpdateDiskPorts, createUpdateExecutor, pathsForUpdate, resolveCliEntry } from './store.js'

// ---------- 宿主种类探测与桌面服务 ----------

// 单例让查状态看到查新版的结果；复用键强制含插件标识（规格 #591 第 6 条），多插件不串内存。
let sharedReader: ReturnType<typeof createUpdateReader> | null = null
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
  randomId?: () => string
  nodeVersion?: string
  targetPackageName?: string
  registryUrl?: string
  checkTimeoutMs?: number
  confirmationTtlMs?: number
  installTimeoutMs?: number
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

async function getSharedReader(pluginId: string, config: ReturnType<typeof resolveUpdateConfig>, overrides: ReaderOverrides = {}): Promise<ReturnType<typeof createUpdateReader>> {
  const env = overrides.env ?? process.env
  const osHome = overrides.osHome ?? homedir()
  const homeDirDefault = defaultHomeDir(env, osHome)
  const targetPackageName = overrides.targetPackageName ?? config.targetPackageName
  const explicitTargetDir =
    typeof overrides.targetPackageDir === 'string' && overrides.targetPackageDir ? String(overrides.targetPackageDir) : ''
  // 与读取器共用同一个解析函数（issue #3）：显式目录优先，否则按包名解析。
  const loaded = await resolveTargetPackage(targetPackageName, explicitTargetDir ? { targetPackageDir: explicitTargetDir } : {}).catch(
    () => null
  )
  const runningVersion =
    overrides.runningVersion ?? (loaded && validVersion((loaded.manifest as { version?: unknown }).version) ? String((loaded.manifest as { version: string }).version) : null)
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
  const key = `${pluginId}\0${config.prefix}\0${runningVersion}\0${profileDirInput}\0${overrides.profileName ?? ''}\0${homeDirInput}\0${overrides.runInstall ? 'exec' : ''}\0${environmentKind}\0${targetPackageName}\0${explicitTargetDir}`
  if (sharedReader && sharedReaderKey === key) return sharedReader
  const disk = overrides.readJob && overrides.writeJob ? null : createUpdateDiskPorts(homeDirInput, pluginId, profileDirInput)
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
  sharedReader = createUpdateReader({
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
    readInstalled: overrides.readInstalled,
    readJob: overrides.readJob,
    writeJob: overrides.writeJob,
    tryAcquireLock: overrides.tryAcquireLock ?? disk?.tryAcquireLock,
    releaseLock: overrides.releaseLock ?? disk?.releaseLock,
    backupJob: overrides.backupJob ?? disk?.backupJob,
    runInstall: overrides.runInstall ?? defaultRun,
  })
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

type LogCtx = { fire: (level: string, event: string, fields: Record<string, unknown>) => void } | null
let phoneLogCtx: LogCtx = null

/** 安装执行结果进日志（常驻事件 update.install.exec，由执行器在跨边界调用后发）。 */
function emitInstallLog(level: string, event: string, fields: Record<string, unknown>): void {
  try {
    if (phoneLogCtx && typeof phoneLogCtx.fire === 'function') phoneLogCtx.fire(level, event, fields)
  } catch {}
}

function loggedPhone(
  method: string,
  kind: string,
  pluginId: string,
  fn: (args: Record<string, unknown>) => Promise<{ snapshot: unknown; manual?: string | null; receipt?: unknown }>
): (args: Record<string, unknown>) => Promise<Record<string, unknown>> {
  return async function (args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const t0 = Date.now()
    const emit = (level: string, event: string, fields: Record<string, unknown>): void => {
      try {
        if (phoneLogCtx && typeof phoneLogCtx.fire === 'function') phoneLogCtx.fire(level, event, fields)
      } catch {}
    }
    try {
      const out = await fn(args)
      const snapshot = out && out.snapshot ? out.snapshot : out
      // 成功事件 5 键基线（规格 #591 第 8 条）：旧 4 键加必填插件标识。
      emit('info', 'host.call', { method, latencyMs: Date.now() - t0, ok: true, kind, pluginId })
      return { ok: true, snapshot, manual: out && out.snapshot ? (out.manual ?? null) : null, receipt: out && out.receipt ? out.receipt : null }
    } catch (error) {
      const payload = toUpdateErrorPayload(error)
      // 失败事件 4 键基线（规格 #591 第 8 条）：旧 3 键加必填插件标识。
      emit('warn', 'host.call.fail', { method, kind, errorHash: hash8(String((error as Error)?.message || payload.error)), pluginId })
      return { ok: false, ...payload }
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
  async function readStatus(args: Record<string, unknown>): Promise<{ snapshot: unknown; manual: string | null }> {
    const reader = await getSharedReader(pluginId, config, {
      ...readerOverrides,
      profileDir: args && args.profileDir ? String(args.profileDir) : readerOverrides.profileDir,
    })
    return snapWithManual(reader, (await reader.status()) as never, config)
  }
  async function readCheck(args: Record<string, unknown>): Promise<{ snapshot: unknown; manual: string | null; receipt: unknown }> {
    const reader = await getSharedReader(pluginId, config, {
      ...readerOverrides,
      profileDir: args && args.profileDir ? String(args.profileDir) : readerOverrides.profileDir,
    })
    const result = await reader.check()
    const withManual = await snapWithManual(reader, result.snapshot as never, config)
    return { snapshot: withManual.snapshot, manual: withManual.manual, receipt: result.receipt ?? null }
  }
  async function runInstall(args: Record<string, unknown>): Promise<{ snapshot: unknown; manual: string | null }> {
    const checkId = args && typeof args.checkId === 'string' ? args.checkId : ''
    const requestId = args && typeof args.requestId === 'string' ? args.requestId : ''
    const reader = await getSharedReader(pluginId, config, {
      ...readerOverrides,
      profileDir: args && args.profileDir ? String(args.profileDir) : readerOverrides.profileDir,
    })
    return snapWithManual(reader, (await reader.install({ checkId, requestId })) as never, config)
  }
  const handlers: Record<string, (args: Record<string, unknown>) => Promise<Record<string, unknown>>> = {
    [phoneNames.updateStatus]: loggedPhone(phoneNames.updateStatus, 'update-status', pluginId, readStatus),
    [phoneNames.updateCheck]: loggedPhone(phoneNames.updateCheck, 'update-check', pluginId, readCheck),
    [phoneNames.updateInstall]: loggedPhone(phoneNames.updateInstall, 'update-install', pluginId, runInstall),
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
