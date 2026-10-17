/**
 * src/reader.ts —— 把本机真实情况翻译成更新核心要的零件（读取器）。
 *
 * 由 src/host/updateReader.js 改写拎入：只翻译不决定。相对旧实现的增量（规格 #591）：
 * 1. 插件标识必填（第 2 条）：非空且不含路径分隔符；环境指纹强制含插件标识（第 6 条单例隔离）。
 * 2. 三处注入默认现状（第 4 条）：目标包名、官方源、目录根经配置注入，默认值等于现状。
 * 3. 时间可调（第 5 条）：联网超时、凭证有效期、安装时限经配置注入，默认值等于现状。
 * 4. 包完好判定看目标包名（默认旧包名，默认行为零变化）。
 */

import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertPluginId } from './config.js'
import { resolveCompliantVersion } from './compliant-version.js'
import { createUpdateCore, isVersionAllowedInChannel, validReleaseVersion } from './service.js'
import type { EnvironmentKind, EnvironmentView, FetchImpl, ReleaseChannel, UpdateCore, UpdateJob, UpdateLogPort } from './ports.js'

const LOCK_FILES = ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package-lock.json']

function inside(directory: string, filename: string): boolean {
  const suffix = relative(directory, filename)
  return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
}

async function readOptional(filename: string): Promise<string> {
  try {
    return await readFile(filename, 'utf8')
  } catch (error) {
    if (error && (error as { code?: string }).code === 'ENOENT') return ''
    throw error
  }
}

/**
 * profile 清单里的 bundle 选择（#180）：取 `dsh.profile.bundles` 这一层。
 * 返回 `layer: false` = 清单没有这一层概念（老/最小 profile，调用方退回 `dependencies` 键）；
 * `layer: true` = 有这一层，`names` 为选中名单——不过 `names` 为 null 表示层在但读不成数组
 * （`bundles: null` / 对象等），按「未登记」处理：宁可大声失败，也不退回 dependencies 把半装态洗成成功。
 */
function bundleSelection(manifest: Record<string, unknown>): { layer: boolean; names: string[] | null } {
  const dsh = manifest.dsh as { profile?: Record<string, unknown> } | undefined
  const profile = dsh?.profile
  const layer = typeof profile === 'object' && profile !== null && Object.prototype.hasOwnProperty.call(profile, 'bundles')
  const raw = layer ? profile.bundles : undefined
  return { layer, names: Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : null }
}

async function packageAt(directory: string): Promise<{ directory: string; manifest: Record<string, unknown>; contents: string }> {
  const contents = await readFile(join(directory, 'package.json'), 'utf8')
  return { directory: await realpath(directory), manifest: JSON.parse(contents) as Record<string, unknown>, contents }
}

/** 从起点文件向上找到名字对得上的包（装的是源码还是装好的包都认）。 */
export async function containingPackage(
  filename: string,
  name: string
): Promise<{ directory: string; manifest: Record<string, unknown>; contents: string } | null> {
  let directory = dirname(await realpath(filename))
  while (true) {
    try {
      const found = await packageAt(directory)
      if (found.manifest && found.manifest.name === name) return found
    } catch (error) {
      if (!error || (error as { code?: string }).code !== 'ENOENT') throw error
    }
    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}

export interface ResolveTargetPackageOptions {
  /** 显式目标包目录：给了就不走任何自动解析（hoisted、多副本、开发态链接等场景的逃生口）。 */
  targetPackageDir?: string
}

/** 读目录清单且名字对得上才收，否则 null（解析全程 best-effort，失败由调用方诚实处理）。 */
async function packageAtIfNamed(
  directory: string,
  name: string
): Promise<{ directory: string; manifest: Record<string, unknown>; contents: string } | null> {
  try {
    const pkg = await packageAt(directory)
    if (pkg.manifest && pkg.manifest.name === name) return pkg
  } catch {}
  return null
}

/**
 * 按包名解析目标包（issue #3 治本：不再拿“本包自己住在哪”回答“要更新的包在哪”）。
 *
 * 顺序固定：
 *   1. 显式目录优先（给了就不走自动解析）；
 *   2. `createRequire(base).resolve(name + '/package.json')` 直解清单；
 *   3. `createRequire(base).resolve(name)` 取入口，再用 `containingPackage(入口)` 向上找清单；
 *   4. 手工 sibling 步行（绕过 `exports` 映射：逐级找 `node_modules/<name>/package.json`；
 *      第 2、3 步受 `exports` 约束，对“契约完整但未导出 `.` 与 `./package.json`”的包会失败，
 *      这一步按文件系统直读，保证普通依赖形态一定命中）；
 *   5. 退回自锚定 `containingPackage(自身文件)`（vendor 在目标包内部的老形态）。
 *
 * 全失败返回 null，调用方诚实失败，不猜。
 */
export async function resolveTargetPackage(
  targetName: string,
  opts: ResolveTargetPackageOptions = {}
): Promise<{ directory: string; manifest: Record<string, unknown>; contents: string } | null> {
  const name = String(targetName || '')
  if (!name) return null
  // 显式目录优先：给了就不走自动解析，命中即收，不中即 null。
  if (opts.targetPackageDir) return packageAtIfNamed(resolve(String(opts.targetPackageDir)), name)
  const base = import.meta.url
  let req: { resolve(spec: string): string } | null = null
  try {
    req = createRequire(base)
  } catch {
    req = null
  }
  if (req) {
    try {
      const pkg = await packageAtIfNamed(dirname(req.resolve(`${name}/package.json`)), name)
      if (pkg) return pkg
    } catch {}
    try {
      const entry = req.resolve(name)
      const pkg = await containingPackage(entry, name)
      if (pkg) return pkg
    } catch {}
  }
  try {
    let dir = dirname(fileURLToPath(base))
    while (true) {
      const pkg = await packageAtIfNamed(join(dir, 'node_modules', name), name)
      if (pkg) return pkg
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {}
  try {
    const pkg = await containingPackage(fileURLToPath(base), name)
    if (pkg) return pkg
  } catch {}
  return null
}

/** 使用范围名的唯一取法：调用方给了就用它，否则取使用范围目录的最后一段（宿主探测与读环境共用）。 */
export function resolveProfileName(profileName: string | null | undefined, profileDir: string): string {
  return profileName ?? basename(profileDir)
}

/** 使用范围名是否合法（纯谓词，导出供验证与面板复用）。 */
export function profileNameValid(name: unknown): boolean {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    Buffer.byteLength(name) <= 255 &&
    !name.startsWith('-') &&
    !['.', '..', 'node_modules'].includes(name) &&
    !/[\\/\x00-\x1f\x7f<>:"|?*]/u.test(name)
  )
}

/** 依赖写法是否像从源装的（纯谓词，导出供验证与面板复用）。
 *
 * 精确预发布版（`1.8.0-beta.1`）与预发布范围（`^1.8.0-beta.1`）都是注册表写法，
 * 不是源码安装（issue #98）：第一 clause 用发行版口径（含预发布），第二 clause
 * 的范围字符集收字母（预发布标识符含字母）。源码形（`file:` / `link:` /
 * `workspace:` / `npm:` / `git+` / `http` / 路径）都含 `:` 或 `/`，该字符集
 * 永远排除这两者，故不会被误判为注册表写法。
 */
export function registrySpec(spec: unknown): boolean {
  return (
    typeof spec === 'string' &&
    spec.trim().length > 0 &&
    (validReleaseVersion(spec.trim()) ||
      /^[~^>=< ]*[0-9x*][0-9A-Za-zx*./\-_ |~^>=<]*$/u.test(spec.trim()) ||
      /^[A-Za-z][A-Za-z0-9._-]*$/u.test(spec.trim()))
  )
}

/** 包是否完好：名字对得上目标包名、版本是合法发行版、三个入口文件都在包内且真实存在。
 *
 * 完好性只查身份与完整性，不查通道政策（issue #98）：版本合法但不被通道接受
 * 的包是“完好的、只是通道不对”，阻拦由 readInstalledReal 的 channel-mismatch
 * 分支报告，不在这里判 invalid-installation。
 */
async function validPackage(
  pkg: { manifest: Record<string, unknown>; directory: string } | null,
  targetName: string
): Promise<boolean> {
  if (!pkg || pkg.manifest?.name !== targetName || !validReleaseVersion(pkg.manifest.version)) return false
  const main = pkg.manifest.main
  const exportsField = pkg.manifest.exports as Record<string, unknown> | undefined
  const dshField = pkg.manifest.dsh as Record<string, unknown> | undefined
  const bundle = dshField?.bundle as Record<string, unknown> | undefined
  const entries = [main, exportsField?.['./client'], bundle?.patch]
  for (const entry of entries) {
    if (typeof entry !== 'string' || !entry || isAbsolute(entry) || entry.includes('\0')) return false
    const filename = resolve(pkg.directory, entry)
    if (!inside(pkg.directory, filename)) return false
    let target = filename
    try {
      target = await realpath(filename)
    } catch {
      return false
    }
    if (!inside(pkg.directory, target)) return false
    try {
      if (!(await stat(target)).isFile()) return false
    } catch {
      return false
    }
  }
  return true
}

/** 家目录默认值：环境变量优先，支持 ~ 写法（导出给调用方取默认值用）。 */
export function defaultHomeDir(env: Record<string, string | undefined>, osHome: string): string {
  let selected = env && env.DSH_HOME && env.DSH_HOME.trim() ? env.DSH_HOME : join(osHome, '.dsh')
  if (selected === '~') selected = osHome
  else if (/^~[\\/]/u.test(selected)) selected = join(osHome, selected.slice(2))
  return resolve(selected)
}

export interface UpdateReaderOptions {
  /**
   * 运行版本（宿主自带清单）：**未知传 `null`**（#182），不许伪造 `0.0.0`。
   * 未知时不判 pending-restart、不参与任何版本比较，快照/事件如实报未知。
   */
  runningVersion: string | null
  /** 当前 DSH 运行时版本（#195，可选）：未知即不传（或传 null/空串），检查层不拿它猜结论。 */
  dshVersion?: string | null
  profileDir: string
  pluginId: string
  profileName?: string
  homeDir?: string
  /** 显式目标包目录：优先于按包名自动解析（hoisted、多副本、开发态链接等场景的逃生口）。 */
  targetPackageDir?: string
  env?: Record<string, string | undefined>
  osHome?: string
  fetchImpl?: FetchImpl
  now?: () => number
  randomId?: () => string
  nodeVersion?: string
  environmentKind?: EnvironmentKind
  targetPackageName?: string
  registryUrl?: string
  checkTimeoutMs?: number
  confirmationTtlMs?: number
  /** 版本通道：默认 stable，显式传 prerelease 才收预发布（#16，加法扩展）。 */
  releaseChannel?: ReleaseChannel
  readInstalled?: () => EnvironmentView | Promise<EnvironmentView>
  readJob?: () => UpdateJob | null | Promise<UpdateJob | null>
  writeJob?: (job: UpdateJob | null) => void | Promise<void>
  tryAcquireLock?: (lockId: string) => boolean | Promise<boolean>
  releaseLock?: (lockId: string) => void | Promise<void>
  backupJob?: (job: UpdateJob) => void | Promise<void>
  runInstall?: (args: {
    version: string
    profileName: string | null
    environmentKind: EnvironmentKind
    approvedBuilds?: string[]
  }) => void | Promise<void>
  /**
   * 日志发射口（#124，可选）：由宿主侧建口人递进来，**必须已经绑好插件标识**；
   * 读取器只往下传给核心，自己不打点也不改判（不递即不记，默认等于现状）。
   */
  emitLog?: UpdateLogPort
  /** 白名单源主机名（#124，可选）：宿主侧解析后透传，核心只把它填进两格（不注入即省略）。 */
  registryHost?: string | null
}

/** 建更新读取器：使用范围目录、插件标识必填；运行版本可未知（null），未知不参与判定（#182）。 */
export function createUpdateReader(options: UpdateReaderOptions): UpdateCore & { readEnv: () => Promise<EnvironmentView> } {
  const rawRunningVersion = options.runningVersion
  // #182：未知是一等状态——null/空串/非字符串一律归一为 null，绝不伪造占位版本号。
  const runningVersion: string | null =
    typeof rawRunningVersion === 'string' && rawRunningVersion.trim() ? rawRunningVersion.trim() : null
  const rawDshVersion = options.dshVersion
  const dshVersion: string | null = typeof rawDshVersion === 'string' && rawDshVersion.trim() ? rawDshVersion.trim() : null
  const profileDirInput = options.profileDir
  if (typeof profileDirInput !== 'string' || !isAbsolute(profileDirInput)) {
    throw new Error('[dsh-plugin-update] 建读取器必须给绝对路径的使用范围目录 profileDir')
  }
  const pluginId = assertPluginId(options.pluginId)
  const env = options.env ?? process.env
  const osHome = options.osHome ?? homedir()
  const homeDirDefault = defaultHomeDir(env, osHome)
  const fallbackFetch = (globalThis as { fetch?: FetchImpl }).fetch
  if (!options.fetchImpl && !fallbackFetch) {
    throw new Error('[dsh-plugin-update] 建读取器必须给网络实现 fetchImpl（本机没有全局 fetch）')
  }
  const fetchImpl = options.fetchImpl ?? (fallbackFetch as FetchImpl)
  const now = options.now ?? Date.now
  const randomId = options.randomId ?? randomUUID
  const nodeVersion = options.nodeVersion ?? (typeof process !== 'undefined' ? process.versions.node : '')
  const environmentKind = options.environmentKind ?? 'cli'
  const targetPackageName = options.targetPackageName ?? 'dsh-mattpocock-skills-deck'
  const registryUrl = options.registryUrl ?? 'https://registry.npmjs.org/'
  const releaseChannel: ReleaseChannel = options.releaseChannel === 'prerelease' ? 'prerelease' : 'stable'
  // 与宿主入口共用同一个解析函数（issue #3）：显式目录优先，否则按包名解析，失败为 null。
  let loadedPackage = resolveTargetPackage(
    targetPackageName,
    options.targetPackageDir ? { targetPackageDir: options.targetPackageDir } : {}
  ).catch(() => null)
  let boundIdentity: string | undefined
  async function readInstalledReal(): Promise<EnvironmentView> {
    const result: EnvironmentView = {
      profileName: null,
      environmentKind,
      homeDir: null,
      profileDir: null,
      installed: true,
      installedVersion: null,
      packageValid: false,
      sourceInstall: false,
      registered: null,
      blockedReason: null,
      installationKey: null,
      eligible: false,
    }
    const profileName = resolveProfileName(options.profileName, profileDirInput)
    result.profileName = profileName
    if (!profileNameValid(profileName)) {
      result.blockedReason = 'unknown-profile'
      return result
    }
    let homeDir: string
    let profileDir: string
    try {
      homeDir = await realpath(options.homeDir ?? homeDirDefault)
      profileDir = await realpath(profileDirInput)
    } catch {
      result.blockedReason = 'unknown-profile'
      return result
    }
    result.homeDir = homeDir
    result.profileDir = profileDir
    let profile: { directory: string; manifest: Record<string, unknown>; contents: string }
    try {
      // 范围清单读不到：保持原判 invalid-installation（#137 登记为待定，本次不拆第二份）。
      // 此时在场性无法确认——按在场走（installed=true），让下游落阻拦分支说真话；
      // 若记 false，面板会把它谎称「未安装」（code-review Spec 轴，US11 两种情况不得混成一句）。
      profile = await packageAt(profileDir)
    } catch {
      result.installed = true
      result.blockedReason = 'invalid-installation'
      return result
    }
    let installed: { directory: string; manifest: Record<string, unknown>; contents: string }
    // 在册（#180/#197）：清单读到了就先算登记态——缺席早退也要带着它，否则 #197 的身份判定
    // 分不开「新增依赖的首次安装」与「清单登记了但磁盘缺失的坏安装」。
    const profileDeps = (profile.manifest.dependencies ?? {}) as Record<string, unknown>
    const profileSelection = bundleSelection(profile.manifest)
    result.registered = profileSelection.layer
      ? profileSelection.names !== null && profileSelection.names.includes(targetPackageName)
      : Object.prototype.hasOwnProperty.call(profileDeps, targetPackageName)
    try {
      installed = await packageAt(join(profileDir, 'node_modules', targetPackageName))
    } catch (error) {
      // 缺席判据只有 ENOENT（#137 硬要求）：坏 JSON（SyntaxError）、权限错误（EACCES）等
      // 说明包在场但读坏，仍判 invalid-installation，防止坏包被洗成可安装。
      if ((error as { code?: unknown })?.code === 'ENOENT') {
        // 缺席早退（#134）：缺席既不是错误也不是阻塞；指纹判定只对在场的包有定义，不跑。
        // profileName/homeDir/profileDir 已在上面照填。
        result.installed = false
        result.installedVersion = null
        result.packageValid = false
        result.sourceInstall = false
        result.blockedReason = null
        result.installationKey = null
        result.eligible = true
        return result
      }
      result.installed = true
      result.blockedReason = 'invalid-installation'
      return result
    }
    const deps = profileDeps
    // 在册已在读清单后立刻算好（#180/#197）：清单有 bundles 层就以它为准（插件没被选中 ⇒
    // 重启后不会加载，磁盘换版也不等于生效；层在但读不成数组同样按未登记，宁可大声失败）；
    // 没有这一层概念的老/最小清单退回 dependencies 键。读不到整体清单时上面已走 invalid-installation。
    result.sourceInstall = !registrySpec(deps[targetPackageName]) || !inside(join(profileDir, 'node_modules'), installed.directory)
    result.installedVersion = typeof installed.manifest.version === 'string' ? installed.manifest.version : null
    result.packageValid = await validPackage(installed, targetPackageName)
    let loaded = await loadedPackage
    if (loaded === null) {
      // 缺席后装上（#134/D5）：构造期解析不到就一直是 null，装完复查以读盘为准，重解一次；
      // 解到了就换掉缓存，后续沿用。仍解不到保持 unknown-profile（issue #3 诚实失败）。
      loaded = await resolveTargetPackage(
        targetPackageName,
        options.targetPackageDir ? { targetPackageDir: options.targetPackageDir } : {}
      ).catch(() => null)
      if (loaded !== null) loadedPackage = Promise.resolve(loaded)
    }
    // 目标包定位不到（自动解析全失败且没给显式目录）：诚实失败，不产假的 installation-changed
    //（issue #3；到这里已装包真实存在，是“本包认不出目标”而非“安装位置变了”，重开宿主也修不好）。
    // #153：已装目录实址落在范围外（junction/源码链接，realpath 逃出范围）→ dev-source，
    // 与真找不到的 unknown-profile 分开说。
    const loadedUnresolvable = loaded === null
    const installedOutsideProfile =
      loadedUnresolvable &&
      typeof installed.directory === 'string' &&
      typeof profileDir === 'string' &&
      installed.directory !== '' &&
      !inside(profileDir, installed.directory)
    // 环境指纹强制含插件标识（规格 #591 第 6 条）：多插件不共享同一份内存状态。
    const identity = `${homeDir}\0${profileDir}\0${profileName}\0${pluginId}`
    const sameLoadedPackage = loaded?.directory === installed.directory && loaded?.manifest.version === installed.manifest.version
    if (boundIdentity === undefined && sameLoadedPackage && result.packageValid) boundIdentity = identity
    const stateFiles = await Promise.all(LOCK_FILES.map((name) => readOptional(join(profileDir, name))))
    try {
      result.installationKey = createHash('sha256')
        .update(JSON.stringify([identity, profile.contents, installed.directory, installed.contents, ...stateFiles]))
        .digest('hex')
    } catch {
      result.installationKey = null
    }
    if (boundIdentity !== undefined && boundIdentity !== identity) result.blockedReason = 'installation-changed'
    else if (installedOutsideProfile) result.blockedReason = 'dev-source'
    else if (loadedUnresolvable) result.blockedReason = 'unknown-profile'
    else if (!sameLoadedPackage && boundIdentity === undefined) result.blockedReason = 'installation-changed'
    else if (!result.packageValid) result.blockedReason = 'invalid-installation'
    else if (result.sourceInstall) result.blockedReason = 'source-install'
    // 通道政策只断言在这里（issue #98）：完好包 + 非源码 + 已装版本不被通道接受
    // → channel-mismatch。unknown-profile 只留给定位不到；invalid-installation
    // 只留给包体不完整。pending-restart 只在通道通过后才判。
    else if (!isVersionAllowedInChannel(result.installedVersion, releaseChannel)) result.blockedReason = 'channel-mismatch'
    // #182：运行版本未知时不判 pending-restart——没有「正在跑哪版」就没有「新旧不同」的事实。
    else if (runningVersion !== null && result.installedVersion !== runningVersion) result.blockedReason = 'pending-restart'
    result.eligible = !result.blockedReason
    result.blockedReason = result.blockedReason ?? null
    return result
  }
  const readInstalled = options.readInstalled ?? readInstalledReal
  const core = createUpdateCore({
    readRunningVersion: () => runningVersion,
    // #195：DSH 运行时版本与运行版同一条信任线——未知即 null，检查层拿不到就不猜。
    readDshVersion: () => dshVersion,
    readInstalled,
    fetchImpl,
    now,
    randomId,
    nodeVersion,
    checkTimeoutMs: options.checkTimeoutMs,
    confirmationTtlMs: options.confirmationTtlMs,
    targetPackageName,
    registryUrl,
    releaseChannel,
    // 合规版决议函数（#156）：核心零运行时导入，决议逻辑由读取器递进来（依赖当参数传）。
    resolveCompliantVersion,
    readJob: options.readJob,
    writeJob: options.writeJob,
    tryAcquireLock: options.tryAcquireLock,
    releaseLock: options.releaseLock,
    backupJob: options.backupJob,
    runInstall: options.runInstall,
    emitLog: options.emitLog,
    registryHost: options.registryHost,
  })
  return Object.assign(core, { readEnv: readInstalled as () => Promise<EnvironmentView> })
}
