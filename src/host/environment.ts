// src/host/environment.ts —— 宿主环境探测与桌面服务（#227 从 host.ts 搬出，蓝图 §4 host 域）。
//
// 管三件事：① 宿主种类（desktop / desktop-manager / cli）与使用范围身份（#204 三来源）；
// ② 桌面服务嵌套注入（不把 desktopPnpm 放进顶层依赖，普通 DSH 才能照常加载）；
// ③ 日志落点目录（updateLogRootDir / updateLogDirFor）与落点探针。
// 只被 host 域内部与包根壳使用；对外公开面仍由 src/host.ts 壳收口。

import type { ReaderOverrides } from './capabilities.js'

import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, sep } from 'node:path'
import { type LogHealthExternalGate } from '../log/health.js'
import { deriveLogNamespace } from '../log/namespace.js'
import { type LogSink } from '../log/sink.js'
import { selfCopyInfo, type SelfCopyInfo, type SelfCopyLevel } from '../shared/self.js'
import { defaultHomeDir, resolveProfileName } from '../core/reader.js'
import type { EnvironmentKind } from '../shared/ports.js'

// ---------- 宿主种类探测与桌面服务 ----------

/** 桌面宿主才有：launcher 注册的公开服务，嵌套注入拿到后缓存（普通 DSH 拿不到也不报错）。 */
let sharedDesktopPnpm: unknown = null
export function ctxService(ctx: unknown, name: string): unknown {
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
export function nonEmptyText(value: unknown): string {
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
export function profileIdentityFromContext(overrides: ReaderOverrides): { dir: string; name: string } | null {
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
export function profileIdentityFromEnv(overrides: ReaderOverrides): { dir: string; name: string } | null {
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
export function watchDesktopPnpm(ctx: unknown): void {
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

/**
 * 从目标包位置反推使用范围目录：装好的包住在 `<范围>/node_modules/<目标包>` 下。
 * 反推不到返回 null，调用方诚实失败（issue #3：不再猜 `profiles/web`，多范围并存时猜即读错）。
 */
export async function tryInferProfileDir(targetDir: string, targetPackageName: string): Promise<string | null> {
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

export function unknownProfile(): Error & { code: string } {
  return Object.assign(new Error('unknown-profile'), { code: 'unknown-profile' })
}

/**
 * 开发态挂载（#153）：目标包真实存在、但不在 `<范围>/node_modules/<包>` 版本位置下
 * （junction / 源码链接 / 显式外部目录），反推不到使用范围。这是“找到了包但无版本落点”，
 * 与“包都找不到”的 unknown-profile 不同：重启宿主修不好，应走仓库改完重启宿主。
 */
export function devSource(): Error & { code: string } {
  return Object.assign(new Error('dev-source'), { code: 'dev-source' })
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

export async function readEnvForPanel(reader: { readEnv?: () => Promise<unknown> }): Promise<PhoneEnvView | null> {
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
/** 日志根目录：`<homeDir>/logs`（现场三家插件都在这里，`dsh-log <DSH_HOME>/logs` 一条命令横扫全部）。 */
export function updateLogRootDir(homeDir: unknown): string {
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
 * 外部落点的准入探针（#212）：集成方注入的实例**可能**不给 `isEnabled`（老客户端），
 * 此时「有没有在写」无从判定 —— 如实报 `unknown`（未验证），不许当成 open 也不许当成 closed。
 * 判据给了但抛错同样是「问不出来」= unknown；只有真回布尔才算验过。
 */
export function probeExternalGate(sink: LogSink): LogHealthExternalGate {
  if (typeof sink.isEnabled !== 'function') return 'unknown'
  try {
    return sink.isEnabled('info', 'update.wire.ready') ? 'open' : 'closed'
  } catch {
    return 'unknown'
  }
}
/**
 * 接线身份里的宿主种类（#211 AC-2）。
 *
 * 取读取器同一个探测函数（`detectEnvironmentKind`）与同一身份优先级（显式覆盖 → 显式 profileDir
 * → ctx 权威 → env 注入），并且和读取器一样先用 `resolveProfileName` 归一名字（显式名字 > 目录
 * 最后一段）——只给 `profileDir` 的集成方不许被误判成 `cli`。仍只用**接线时同步可见**的信息：
 * 接线先于读取器创建（建读取器要异步反推 profile 目录），不为了一句自述把同步接线契约变成异步；
 * 反推那一支同步侧拿不到目录，就不猜名字（`detectEnvironmentKind` 的第 2 条自然不触发）。
 */
export function wireHostKind(overrides: ReaderOverrides, ctx: unknown): EnvironmentKind {
  if (overrides.environmentKind) return overrides.environmentKind
  const explicitName = nonEmptyText(overrides.profileName)
  const contextIdentity = profileIdentityFromContext({ ...overrides, ctx })
  const envIdentity = profileIdentityFromEnv(overrides)
  // 与 getSharedReader 的 profileDirInput / profileNameInput 同一取法（见 src/host/capabilities.ts 的 getSharedReader）。
  let profileDir = ''
  let profileNameInput: string | undefined
  if (overrides.profileDir) {
    profileDir = String(overrides.profileDir)
    profileNameInput = explicitName || undefined
  } else if (contextIdentity) {
    profileDir = contextIdentity.dir
    profileNameInput = explicitName || contextIdentity.name || undefined
  } else if (envIdentity) {
    profileDir = envIdentity.dir
    profileNameInput = explicitName || envIdentity.name || undefined
  } else {
    profileNameInput = explicitName || undefined
  }
  const profileName = profileDir || profileNameInput ? resolveProfileName(profileNameInput, profileDir) : undefined
  return detectEnvironmentKind(ctx, profileName)
}

/** 桌面服务读口（能力装配用；普通 DSH 拿不到也不报错）。 */
export function sharedDesktopService(): unknown {
  return sharedDesktopPnpm
}

/** 桌面服务写口（集成方显式注入 / 测试复位与 watchDesktopPnpm 共用同一份状态）。 */
export function setSharedDesktopService(value: unknown): void {
  sharedDesktopPnpm = value
}
