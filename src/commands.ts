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

import type { BlockedReason, EnvironmentKind, InstallRecipe, ReleaseChannel } from './ports.js'

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
 * 与配方同一套政策（精确版本、官方源、--save-exact），只是使用范围名含特殊字符时加引号，
 * 因为这一串要经用户自己的 shell 解释。网络受限时用户可自行去掉 --registry=。
 * 源码安装等不安全情形不给命令；无安全可选项（候选全低于运行版、
 * 通道外、无候选、比不出）同样不给，不回退旧 picks[0]、不猜 latest。
 */
export function manualCommand(input: { profileName: string | null; latestVersion: string | null; installedVersion: string | null; runningVersion: string; jobTargetVersion: string | null; blockedReason: BlockedReason | null; sourceInstall: boolean; targetPackageName?: string; registryUrl?: string; releaseChannel?: ReleaseChannel }): string | null {
  if (input.sourceInstall || input.blockedReason === 'source-install' || input.blockedReason === 'unknown-profile') return null
  const name = usableProfileName(input.profileName)
  if (!name) return null
  const targetName = input.targetPackageName ?? PACKAGE_NAME
  const registry = input.registryUrl ?? NPM_REGISTRY
  if (!targetName || !registry) return null
  const channel: ReleaseChannel = input.releaseChannel === 'prerelease' ? 'prerelease' : 'stable'
  const arg = /^[A-Za-z0-9_.-]+$/.test(name) ? name : JSON.stringify(name)
  const picks = [input.latestVersion, input.jobTargetVersion, input.installedVersion].filter((v) => versionAllowed(v, channel))
  // 安全可选项：通道允许且不低于运行版；没有即回空（issue #98：beta 运行 +
  // 更低 stable 远端时，旧回退曾产出降级命令）。
  let version: string | null = null
  try {
    const ranked = picks.filter((v) => compareReleaseVersions(v, input.runningVersion) >= 0)
    if (ranked.length > 0) {
      version = ranked[0]
      for (const v of ranked) if (compareReleaseVersions(v, version) === 1) version = v
    }
  } catch {
    version = null
  }
  if (!version) return null
  return `dsh plugin --profile ${arg} add --save-exact ${targetName}@${version} --registry=${registry}`
}
