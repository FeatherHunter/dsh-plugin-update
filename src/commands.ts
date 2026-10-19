/**
 * src/commands.ts — 安装命令的纯拼接（政策收归核心）。
 *
 * 由 update-core/src/commands.ts 原样拎入，两条产物形状冻结（改键改模板即破冰）：
 *   1. 执行配方（installRecipe）——真正安装时用：按宿主种类选路由，程序与参数数组分开，
 *      使用范围名原样进数组；一律精确版本与官方源——第三方 Desktop 与普通宿主那两条把源写进
 *      参数数组（带 --save-exact），官方桌面版那条只交一个精确版本规格，源走宿主管理器的选项。
 *   2. 手工兜底文案（manualCommand）——给人复制到终端执行：沿用命令串形状，
 *      使用范围名含特殊字符时加引号（只影响展示，不影响配方）。
 * 自包含：不引用同层其它文件，版本号小工具按需内联。
 * 类型引用只用 import type，转译后无运行时导入。
 *
 * 相对原样的增量（规格 #591 第 4、5 条）：目标包名、官方源、安装时限经可选字段注入，
 * 默认值等于现状常量。不传即走现状，老调用零变化。
 */

import type { BlockedReason, EnvironmentKind, InstallRecipe, ReleaseChannel } from './shared/ports.js'

/**
 * #92 单点真源：哪些阻塞原因本身就意味「不该给手工命令」。
 * 源码安装会被按版本安装覆盖（#153）、开发态挂载只服务版本安装、认不出使用范围就没有可指向的范围名。
 * `manualCommand` 的早退与面板空态分类（src/manual-absent.ts）共用这一个 predicate，别在两处各抄一份。
 */
const MANUAL_SUPPRESSING_REASONS = ['source-install', 'unknown-profile', 'dev-source'] as const
export type ManualSuppressingReason = (typeof MANUAL_SUPPRESSING_REASONS)[number]

export function manualCommandSuppressedBy(reason: BlockedReason | null | undefined): reason is ManualSuppressingReason {
  return reason !== null && reason !== undefined && (MANUAL_SUPPRESSING_REASONS as readonly string[]).includes(reason)
}

const PACKAGE_NAME = 'dsh-mattpocock-skills-deck'
const NPM_REGISTRY = 'https://registry.npmjs.org/'
/**
 * 宿主管理器（官方桌面版的 pluginManager）接受的包名形状：全小写、可带作用域。
 * 出处：宿主 `@deepseek-ai/dsh-plugin-manager` 的 `PACKAGE_NAME`（见 docs/host-install-exits.md）。
 */
const MANAGER_TARGET_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/
/** 安装时限：15 分钟（起进程到退出，超时终止整棵进程树并按失败处理）。 */
export const INSTALL_TIMEOUT_MS = 15 * 60_000

function validVersion(v: unknown): v is string {
  return typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v)
}

// 发行版识别（#16，与 src/service.ts 同口径的内联版，本文件自包含不引用同层其它文件）。
function validPrereleaseIds(ids: string): boolean {
  if (typeof ids !== 'string' || !ids) return false
  const parts = ids.split('.')
  if (parts.length === 0) return false
  for (const p of parts) {
    if (!p || !/^[0-9A-Za-z-]+$/.test(p)) return false
    if (/^\d+$/.test(p) && p.length > 1 && p.startsWith('0')) return false
  }
  return true
}

function validReleaseVersion(v: unknown): v is string {
  if (typeof v !== 'string' || !v) return false
  const dash = v.indexOf('-')
  if (dash < 0) return validVersion(v)
  if (v.slice(dash + 1).includes('+')) return false
  return validVersion(v.slice(0, dash)) && validPrereleaseIds(v.slice(dash + 1))
}

/** 该版本在该通道是否可装：stable 只收纯三段，prerelease 通道两者皆收（精确版锁定不变）。 */
function versionAllowed(version: unknown, channel: ReleaseChannel): version is string {
  if (channel === 'prerelease') return validReleaseVersion(version)
  return validVersion(version)
}

function parseTriple(v: string): [number, number, number] | null {
  const parts = String(v).split('.')
  if (parts.length > 3) return null
  const nums: number[] = []
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null
    const n = Number(p)
    if (!Number.isSafeInteger(n)) return null
    nums.push(n)
  }
  while (nums.length < 3) nums.push(0)
  return [nums[0], nums[1], nums[2]]
}

function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseTriple(a)
  const pb = parseTriple(b)
  if (!pa || !pb) throw new Error('invalid-release')
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1
    if (pa[i] > pb[i]) return 1
  }
  return 0
}

// 发行版比较（#16，内联版：三段数字先比，无预发布大于有预发布，标识符按 SemVer §11）。
function compareReleaseVersions(a: string, b: string): -1 | 0 | 1 {
  if (!validReleaseVersion(a) || !validReleaseVersion(b)) throw new Error('invalid-release')
  const dashA = a.indexOf('-')
  const dashB = b.indexOf('-')
  const coreA = dashA < 0 ? a : a.slice(0, dashA)
  const coreB = dashB < 0 ? b : b.slice(0, dashB)
  const order = compareVersions(coreA, coreB)
  if (order !== 0) return order
  const preA = dashA < 0 ? null : a.slice(dashA + 1).split('.')
  const preB = dashB < 0 ? null : b.slice(dashB + 1).split('.')
  if (preA === null && preB === null) return 0
  if (preA === null) return 1
  if (preB === null) return -1
  const width = Math.max(preA.length, preB.length)
  for (let i = 0; i < width; i++) {
    const x = preA[i]
    const y = preB[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x) ? Number(x) : null
    const yn = /^\d+$/.test(y) ? Number(y) : null
    if (xn !== null && yn !== null) {
      if (xn < yn) return -1
      if (xn > yn) return 1
      continue
    }
    if (xn !== null) return -1
    if (yn !== null) return 1
    if (x < y) return -1
    if (x > y) return 1
  }
  return 0
}

/**
 * Shell 安全的单段参数：只接受无需任何引号、也不会被 bash / PowerShell / cmd 展开或截断的字符。
 *
 * 手工命令与载体命令都是给人复制到终端执行的，`JSON.stringify` 不是 shell 引号（它产出 JSON
 * 字符串字面量）：`$`、反引号在 PowerShell/bash 里仍会被展开（甚至执行），含空格/`&` 的源地址
 * 会被拆开或截断。所以插值一律先过这里——**宁可不出命令，也不出一条会执行别的东西、悄悄换源
 * 或截断的假命令**（对抗审查 HARD：`usableProfileName` 允许这些字符）。
 *
 * 允许非 ASCII（中文使用范围名在各 shell 里都是字面量），只禁 ASCII 元字符与空白。
 */
export function shellSafeArg(value: string): string | null {
  if (typeof value !== 'string' || !value) return null
  return /^[^\s$`"'\\&|;<>()*?[\]{}~#%!^]+$/u.test(value) ? value : null
}

/**
 * 待批准构建名单的形状归一（#194）。
 *
 * 两个来源是同一形状：宿主 pnpm 失败回包里的 `pendingBuilds`（宿主 `recordPendingBuilds`
 * 给的是「被 pnpm 报告、等待构建决策」的**精确包名**，不含通配规则），以及安装电话入参
 * 里调用方带回的 `approvedBuilds`。
 *
 * 只收「形状上确实可能是 npm 包名」的项：非空、长度守 npm 包名上限、不以 `-`/`.`/`_` 开头
 * （不冒充开关、不构成路径）、符合 npm 包名文法（可带 `@scope/`，其余段只允许字母数字与
 * `._-`）、且不含 shell 元字符或通配符（与 `shellSafeArg` 同一白名单）；去重保序、最多 32 条。
 * 认不出的项一律丢——宁可少点名，也不把开关样式、路径片段或 `包@版本` 当包名交回宿主
 * （宿主还会按「确实在 pending 名单里」再校验一次，不符即 stale-approval）。
 */
export function normalizeApprovedBuilds(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const names: string[] = []
  for (const item of input) {
    if (typeof item !== 'string') continue
    const name = item.trim()
    if (!isNpmPackageName(name)) continue
    if (shellSafeArg(name) === null) continue
    if (names.includes(name)) continue
    names.push(name)
    if (names.length >= 32) break
  }
  return names
}

/**
 * npm 包名的形状谓词（只做文法判断，不查注册表）：`name` 或 `@scope/name`，
 * 1..214 字符，首字符为字母或数字，其余段只允许字母数字与 `._-`。
 * 用于挡住 `../x`、`a/b/c`、`包@1.0.0` 这类「不是包名」的字符串。
 */
function isNpmPackageName(name: string): boolean {
  if (!name || name.length > 214) return false
  return /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
}

/** 使用范围名是否可用作安装目标（纯谓词，配方与手工命令共用）。 */
function usableProfileName(raw: unknown): string | null {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!name || name.length > 255 || name.startsWith('-')) return null
  if (['.', '..', 'node_modules'].includes(name)) return null
  return name
}

/**
 * 安装执行配方：宿主种类决定路由，使用范围决定目标。
 *
 * - 第三方 Desktop（desktop）→ desktop-service：由桌面端公开的 desktopPnpm 服务用参数数组
 *   拉起打包好的 CLI，插件不碰 .cmd 垫片、不经 shell。
 * - 官方桌面版（desktop-manager）→ desktop-manager：交给宿主进程内的插件管理器，参数只有
 *   「add + 精确版本规格」——它只收一个 spec 字符串、不接受任何开关，源走它的 registry 选项。
 * - 普通 DSH 宿主（cli）→ cli-process：用「当前运行时的可执行文件 + CLI 的 JS 入口
 *   + 参数数组」自己起进程；三系统同一套形态，差异只在可执行文件与入口由适配器提供。
 *
 * 前两条一律带官方源与 --save-exact；官方源不可达时由适配器诚实失败，不换源。
 * 宿主种类不是已知三种取值、或目标包名不合管理器规格时不给配方（诚实失败转手工命令），不猜。
 */
export function installRecipe(input: {
  profileName: string | null
  version: string
  environmentKind: EnvironmentKind
  targetPackageName?: string
  registryUrl?: string
  timeoutMs?: number
  /** 版本通道（#16）：默认 stable；显式传 prerelease 才可装预发布精确版。 */
  releaseChannel?: ReleaseChannel
}): InstallRecipe | null {
  const name = usableProfileName(input?.profileName)
  const version = input?.version
  const channel: ReleaseChannel = input?.releaseChannel === 'prerelease' ? 'prerelease' : 'stable'
  if (!name || !versionAllowed(version, channel)) return null
  const kind = input?.environmentKind
  if (kind !== 'desktop' && kind !== 'desktop-manager' && kind !== 'cli') return null
  const targetName = input?.targetPackageName ?? PACKAGE_NAME
  const registry = input?.registryUrl ?? NPM_REGISTRY
  const timeoutMs = input?.timeoutMs ?? INSTALL_TIMEOUT_MS
  if (!targetName || !registry) return null
  if (kind === 'desktop-manager') {
    // 管理器只吃一个 spec 字符串，且包名形状比 npm 通用写法更窄（全小写）；不合就不给配方。
    // 解码处见 src/store.ts 的 managerSpecOf——改这条形状要同时改两处（五键冻结，只能这样传）。
    if (!MANAGER_TARGET_RE.test(targetName)) return null
    return {
      route: 'desktop-manager',
      profileName: name,
      version,
      pluginArgs: ['add', `${targetName}@${version}`],
      timeoutMs,
    }
  }
  return {
    route: kind === 'desktop' ? 'desktop-service' : 'cli-process',
    profileName: name,
    version,
    // 参数数组原样交给命令行工具：使用范围名不做引号包裹、不按空格拆分。
    pluginArgs: ['add', '--save-exact', `${targetName}@${version}`, `--registry=${registry}`],
    timeoutMs,
  }
}

/**
 * 手工兜底命令：给人复制到终端执行，形状沿用 `dsh plugin --profile <名> add <包>@<版本>`。
 * 与配方同一套政策（精确版本、官方源、--save-exact）。这一串要经用户自己的 shell 解释，
 * 而 shell 引号在各平台上并不同一套规则（cmd 不做单引号、PowerShell 的反引号是转义符），
 * 所以插值只走 `shellSafeArg` 的保守白名单：使用范围名 / 源地址 / 包名与版本里出现空白、
 * `$`、反引号、引号、`&` 等任意一个，就宁可返回 null 不出命令。网络受限时用户可自行去掉 --registry=。
 * 源码安装 / 开发态挂载 / 认不出使用范围等不安全情形不给命令；无安全可选项（候选全低于运行版、
 * 通道外、无候选、比不出）同样不给，不回退旧 picks[0]、不猜 latest。
 */
export function manualCommand(input: { profileName: string | null; latestVersion: string | null; installedVersion: string | null; runningVersion: string | null; jobTargetVersion: string | null; blockedReason: BlockedReason | null; sourceInstall: boolean; targetPackageName?: string; registryUrl?: string; releaseChannel?: ReleaseChannel }): string | null {
  if (input.sourceInstall || manualCommandSuppressedBy(input.blockedReason)) return null
  const name = usableProfileName(input.profileName)
  if (!name) return null
  const arg = shellSafeArg(name)
  if (!arg) return null
  const targetName = input.targetPackageName ?? PACKAGE_NAME
  const registry = input.registryUrl ?? NPM_REGISTRY
  if (!targetName || !registry) return null
  const source = shellSafeArg(registry)
  if (!source) return null
  const channel: ReleaseChannel = input.releaseChannel === 'prerelease' ? 'prerelease' : 'stable'
  const picks = [input.latestVersion, input.jobTargetVersion, input.installedVersion].filter((v) => versionAllowed(v, channel))
  // 安全可选项：通道允许且不低于运行版；没有即回空（issue #98：beta 运行 +
  // 更低 stable 远端时，旧回退曾产出降级命令）。
  let version: string | null = null
  // #182：运行版未知时不给手工命令——无法验证不会降级，不猜、不冒充安全建议。
  if (typeof input.runningVersion !== 'string' || !input.runningVersion) return null
  const runningVersion = input.runningVersion
  try {
    const ranked = picks.filter((v) => compareReleaseVersions(v, runningVersion) >= 0)
    if (ranked.length > 0) {
      version = ranked[0]
      for (const v of ranked) if (compareReleaseVersions(v, version) === 1) version = v
    }
  } catch {
    version = null
  }
  if (!version) return null
  const spec = shellSafeArg(`${targetName}@${version}`)
  if (!spec) return null
  return `dsh plugin --profile ${arg} add --save-exact ${spec} --registry=${source}`
}
