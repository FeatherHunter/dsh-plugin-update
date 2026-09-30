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
import { createUpdateCore, validVersion } from './service.js'
import type { EnvironmentKind, EnvironmentView, FetchImpl, UpdateCore, UpdateJob } from './ports.js'

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

/** 依赖写法是否像从源装的（纯谓词，导出供验证与面板复用）。 */
export function registrySpec(spec: unknown): boolean {
  return (
    typeof spec === 'string' &&
    spec.trim().length > 0 &&
    (validVersion(spec.trim()) ||
      /^[~^>=< ]*[0-9x*][0-9x*./\-_ |~^>=<]*$/u.test(spec.trim()) ||
      /^[A-Za-z][A-Za-z0-9._-]*$/u.test(spec.trim()))
  )
}

/** 包是否完好：名字对得上目标包名、版本合法、三个入口文件都在包内且真实存在。 */
async function validPackage(pkg: { manifest: Record<string, unknown>; directory: string } | null, targetName: string): Promise<boolean> {
  if (!pkg || pkg.manifest?.name !== targetName || !validVersion(pkg.manifest.version)) return false
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
  runningVersion: string
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
  readInstalled?: () => EnvironmentView | Promise<EnvironmentView>
  readJob?: () => UpdateJob | null | Promise<UpdateJob | null>
  writeJob?: (job: UpdateJob | null) => void | Promise<void>
  tryAcquireLock?: (lockId: string) => boolean | Promise<boolean>
  releaseLock?: (lockId: string) => void | Promise<void>
  backupJob?: (job: UpdateJob) => void | Promise<void>
  runInstall?: (args: { version: string; profileName: string | null; environmentKind: EnvironmentKind }) => void | Promise<void>
}

/** 建更新读取器：运行版本、使用范围目录、插件标识三者必填，其余不给用本机默认。 */
export function createUpdateReader(options: UpdateReaderOptions): UpdateCore & { readEnv: () => Promise<EnvironmentView> } {
  const runningVersion = options.runningVersion
  if (typeof runningVersion !== 'string' || !runningVersion) {
    throw new Error('[dsh-plugin-update] 建读取器必须给运行版本 runningVersion（读宿主自带清单）')
  }
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
  // 与宿主入口共用同一个解析函数（issue #3）：显式目录优先，否则按包名解析，失败为 null。
  const loadedPackage = resolveTargetPackage(
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
      installedVersion: null,
      packageValid: false,
      sourceInstall: false,
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
    let installed: { directory: string; manifest: Record<string, unknown>; contents: string }
    try {
      profile = await packageAt(profileDir)
      installed = await packageAt(join(profileDir, 'node_modules', targetPackageName))
    } catch {
      result.blockedReason = 'invalid-installation'
      return result
    }
    const deps = (profile.manifest.dependencies ?? {}) as Record<string, unknown>
    result.sourceInstall = !registrySpec(deps[targetPackageName]) || !inside(join(profileDir, 'node_modules'), installed.directory)
    result.installedVersion = typeof installed.manifest.version === 'string' ? installed.manifest.version : null
    result.packageValid = await validPackage(installed, targetPackageName)
    const loaded = await loadedPackage
    // 目标包定位不到（自动解析全失败且没给显式目录）：诚实失败，不产假的 installation-changed
    //（issue #3；到这里已装包真实存在，是“本包认不出目标”而非“安装位置变了”，重开宿主也修不好）。
    const loadedUnresolvable = loaded === null
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
    else if (loadedUnresolvable) result.blockedReason = 'unknown-profile'
    else if (!sameLoadedPackage && boundIdentity === undefined) result.blockedReason = 'installation-changed'
    else if (!result.packageValid) result.blockedReason = 'invalid-installation'
    else if (result.sourceInstall) result.blockedReason = 'source-install'
    else if (result.installedVersion !== runningVersion) result.blockedReason = 'pending-restart'
    result.eligible = !result.blockedReason
    result.blockedReason = result.blockedReason ?? null
    return result
  }
  const readInstalled = options.readInstalled ?? readInstalledReal
  const core = createUpdateCore({
    readRunningVersion: () => runningVersion,
    readInstalled,
    fetchImpl,
    now,
    randomId,
    nodeVersion,
    checkTimeoutMs: options.checkTimeoutMs,
    confirmationTtlMs: options.confirmationTtlMs,
    targetPackageName,
    registryUrl,
    readJob: options.readJob,
    writeJob: options.writeJob,
    tryAcquireLock: options.tryAcquireLock,
    releaseLock: options.releaseLock,
    backupJob: options.backupJob,
    runInstall: options.runInstall,
  })
  return Object.assign(core, { readEnv: readInstalled as () => Promise<EnvironmentView> })
}
