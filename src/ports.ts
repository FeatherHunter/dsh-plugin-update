/**
 * src/ports.ts —— 更新模块的插口定义（规格 #591 的字面落实）。
 *
 * 由 update-core/src/ports.ts 原样拎入：六边形架构不变，核心只管做决定，插口由核心定，
 * 跑腿的活全在外面。检验标准仍是核心不碰硬盘、网络、子进程也能被测透，所以本文件只放类型，
 * 不放任何运行时逻辑；转译出的 JS 是空壳，第二家直接吃 TS 源码。
 *
 * 相对原样的增量（规格 #591 要求的新增注入点位，不动冻结的入参回参形状）：
 * 插件标识、目标包名、官方源、安装时限经 UpdatePorts 的可选字段注入，默认值等于现状。
 * 三个对外方法、快照六字段、任务公开形状、检查凭证形状、配方五键形状全部冻结不变。
 */

/**
 * 宿主种类：核心按它选安装路由。
 * - `desktop`：第三方 Desktop 宿主（发布 `desktopProfiles`／`desktopPnpm` 的那一支）；
 * - `desktop-manager`：官方桌面版（宿主进程内 `pluginManager.installBundle` 那一支）；
 * - `cli`：普通 DSH 宿主（本包自己起命令行）。
 *
 * 取值可增：新增取值属向后兼容，调用方不认就当普通宿主处理（诚实失败转手工命令）；
 * 值按时间可调，键与形状仍冻结（见 README 第 5 节）。
 */
export type EnvironmentKind = 'desktop' | 'desktop-manager' | 'cli'

/** 版本通道（#16）：默认只推 stable；prerelease 须调用方显式 opt-in。 */
export type ReleaseChannel = 'stable' | 'prerelease'

/**
 * 安装意图的来源（#124 日志接线）：面板、入口件、批量驱动器三处共用同一个安装电话，
 * 行里只记枚举名。核心只把它透传进 `update.install.request`，不参与任何决策。
 * 默认（调用方没报）按 `'panel'`——电话的既有调用方是面板。
 */
export type InstallSource = 'panel' | 'entry' | 'batch'

/** 检查更新的触发起因（#124）：手动点、面板自动、批量驱动、入口件。默认按 `'user'`。 */
export type CheckTrigger = 'auto' | 'user' | 'batch' | 'entry'

/**
 * 日志发射口（#124）：中立文件（core / 批量驱动器）不许 import `node:`，所以由 Node 侧的
 * 建口人把**已经绑好插件标识**的发射函数递进来；不递即不记（默认值等于现状，老调用一字不动）。
 * 实现方只许调唯一发射口 `emitUpdateLog`，且永不外抛（发射口自身已吃掉所有异常）。
 */
export type UpdateLogPort = (
  level: string,
  event: string,
  fields: Record<string, unknown>,
  opts?: { always?: boolean; fingerprint?: string }
) => void

/**
 * 装不了的原因（装前不满足条件只给原因不给装，见通用方案复用清单）与
 * 公开错误码（核心定码，适配器只负责把外面世界的脏错误翻译进来）。
 *
 * 取值只在 src/codes.ts 定义一次（#141）：本文件是唯一被外部依赖的公开面，
 * 所以在这里转发这两个名字，调用方的 import 一字不用改；`export type` 会被完全擦除，
 * 本文件「只有类型、没有运行时逻辑」这条不变。
 */
import type { BlockedReason, UpdateErrorCode } from './codes.js'
import type { CauseBlame } from './install-cause.js'
import type { CompliantVerdict, CompliantVersionInput, CompliantWindowSource } from './compliant-version.js'

export type { BlockedReason, UpdateErrorCode } from './codes.js'
export type { CauseBlame } from './install-cause.js'
export type { CompliantVerdict, CompliantVersionInput, CompliantWindowSource } from './compliant-version.js'

/** 快照：恰好七个字段，永远不带钥匙（检查编号与环境指纹另交）。 */
export interface UpdateSnapshot {
  /** 运行版本：宿主自带清单里的版本号。 */
  runningVersion: string
  /**
   * 在场事实（#134）：目标包在磁盘上是否存在。缺席时 `installedVersion` 为 null；
   * 未装的可安装性不看 `runningVersion`（集成方注入值缺席时不可采信）。
   */
  installed: boolean
  /** 磁盘已装版本：已安装包里的清单版本号（读不到为 null）。 */
  installedVersion: string | null
  /** 远端最新版本：最近一次查新版带回的版本（没查过为 null）。 */
  latestVersion: string | null
  /** 能不能装：环境允许、无阻拦原因、有没过期的检查且指纹一致、远端确实更新。 */
  canInstall: boolean
  /** 装不了的原因（能装为 null）。 */
  blockedReason: BlockedReason | null
  /** 当前任务：只读半程恒为 null，安装票再接真实任务。 */
  job: UpdateJob | null
}

/** 任务的公开形状（长任务状态随时可问，见通用方案第 5 步）。 */
export interface UpdateJob {
  id: string
  state: 'installing' | 'verifying' | 'restart-required' | 'completed' | 'failed' | 'interrupted'
  targetVersion: string | null
  /**
   * 任务说明：失败时是「失败码」或「失败码: 详情」（详情来自宿主原话，已截断、已去掉绝对路径）。
   * 取值可变，字段与形状不变；要匹配请匹配前缀失败码，不要整串相等（README 第 12 节）。
   */
  message: string | null
  /** 提交时的请求编号：同一个编号重复提交直接返回旧结果，不重装。 */
  requestId: string | null
}

/**
 * 检查凭证：查新版把快照和凭证分开交。
 * 凭证是“用户当时点头的那一次检查”的绑定（编号加当时看到的环境指纹），
 * 装更新时调用方把凭证递回来，快照里永远不带钥匙。
 */
export interface CheckReceipt {
  checkId: string
  checkedAt: number
  expiresAt: number
}

/** 查新版一次返回：快照与凭证分家。 */
export interface CheckResult {
  snapshot: UpdateSnapshot
  receipt: CheckReceipt | null
}

/**
 * 合规版决议输入（#156）：面板把翻译官结论里"调用方知道"的部分递进来，
 * 运行版/通道/时钟/时间表由核心自己填——面板够不着 registry，也不做决议。
 */
export interface FallbackCheckInput {
  /** 签名 kind（缺省 'minimum-release-age'；不认识的直接 abstain，不取数）。 */
  kind?: string
  /** 归因（缺省 'target'；非主包直接 abstain，不取数——B 类不决议）。 */
  blame?: CauseBlame
  /** 被拦住的版本（缺省取时间表的 dist-tags.latest；与 latest 不一致即 abstain）。 */
  targetVersion?: string
  /** 策略窗口毫秒（报文自述或调用方反推；缺省即 abstain，不取数不猜）。 */
  windowMs?: number | null
  /** 窗口出处（缺省 'unknown'；只回传，不参与决议）。 */
  windowSource?: CompliantWindowSource
  /** 报文里抠出的发布时间（时间表缺最新版时的 fallback；缺省即无）。 */
  publishedAtMs?: number | null
}

/** 合规版决议一次返回：裁决 + 候选（无则 null）+ 候选安装凭证（无候选则 null）。 */
export interface FallbackCheckResult {
  verdict: CompliantVerdict
  candidate: string | null
  receipt: CheckReceipt | null
}

/** 远端发行信息：只接受名字对得上、版本合法、包地址与完整性校验全合规的返回。 */
export interface ReleaseInfo {
  version: string
  nodeRange: string
  integrity: string
  tarball: string
}

/**
 * 安装执行路由：三条，由核心按宿主种类选（见 installRecipe），适配器只负责把它跑起来。
 * - `desktop-service`：第三方 Desktop 宿主公开的 `desktopPnpm.runPlugin`；
 * - `desktop-manager`：官方桌面版进程内的 `pluginManager.installBundle`；
 * - `cli-process`：普通 DSH 宿主自己起命令行。
 */
export type InstallRoute = 'desktop-service' | 'desktop-manager' | 'cli-process'

/**
 * 安装执行配方：核心给适配器的完整政策产物（冻结五键：改键改模板即破冰，值按时间可调）。
 * 一律「程序 + 参数数组」——pluginArgs 是**这条路自己的**参数数组，按路由解释：
 *   - `desktop-service`／`cli-process`：pnpm 形状（`add --save-exact <包名>@<版本> --registry=<源>`）；
 *   - `desktop-manager`：宿主管理器形状（`add <包名>@<精确版本>`，一个 spec 字符串、不带任何开关）。
 * 使用范围名不做引号包裹也不按空格拆分（引号只出现在给用户看的手工命令里）。
 * 源按路由落地：前两条进参数数组，`desktop-manager` 走管理器自己的 `registry` 选项（取同一个注入值）。
 */
export interface InstallRecipe {
  route: InstallRoute
  /** 安装目标使用范围名，原样保留（含空格与非 ASCII 字符）。 */
  profileName: string
  /** 精确版本（不带 ^ ~ 等前缀）。 */
  version: string
  /** 这条路自己的参数数组；含义随路由而定（见本接口说明）。 */
  pluginArgs: string[]
  /** 执行时限（毫秒）：超时终止（命令行终止整棵进程树，管理器请求取消）并按安装失败处理。 */
  timeoutMs: number
}

/**
 * 适配器看到的环境（小零件：读版本、看环境、上报宿主种类）。
 * 拼安装命令和选执行器路由收归核心（精确版本、强制官方源是政策，不是跑腿）。
 * environmentKind 由适配器探测，顺序固定：有 `desktopProfiles` 即 desktop；
 * 否则有 `pluginManager.installBundle` 且使用范围名恰是命令行明确封禁的 `desktop` 即 desktop-manager；
 * 其余为 cli。探测不出就按 cli 走，跑不通按诚实失败转手工命令。
 */
export interface EnvironmentView {
  profileName: string | null
  environmentKind: EnvironmentKind
  homeDir: string | null
  profileDir: string | null
  /**
   * 在场事实（#134）：目标包在磁盘上是否存在。缺席（目标包读取报 ENOENT）时为 false，
   * 且提前返回、不算指纹；其余读不到统一判 `invalid-installation`（见读取器）。
   */
  installed: boolean
  installedVersion: string | null
  packageValid: boolean
  sourceInstall: boolean
  blockedReason: BlockedReason | null
  installationKey: string | null
  eligible: boolean
}

/** 核心要的最小网络形状（结构化定义，不依赖任何运行时的网络类型）。 */
export interface MinimalHeaders {
  get(name: string): string | null
}

export interface MinimalResponse {
  ok: boolean
  /** HTTP 状态码（仅联网取数有；假件不给即省略，调用方不得猜）。 */
  status?: number
  headers: MinimalHeaders
  text(): Promise<string>
}

export type FetchImpl = (
  url: string,
  init?: { headers?: Record<string, string>; redirect?: string; signal?: unknown },
) => Promise<MinimalResponse>

/**
 * 插口：时钟和编号从外面灌进来（默认真的、测试用假的）。
 * 核心不直接读硬盘、不直接联网，联网经外面递进来的 fetchImpl 发生一次。
 * 安装用的存取与执行也全是外面给的小零件：任务记哪里、锁怎么加、
 * 备份怎么做、安装命令怎么跑，核心只指挥顺序，不碰硬盘与子进程。
 *
 * 新增注入点位（规格 #591 第 2、4、5 条，全部可选，默认值等于现状）：
 * 插件标识、目标包名、官方源、安装时限。不传即走现状，老调用补一个标识即可。
 */
export interface UpdatePorts {
  readRunningVersion(): string
  readInstalled(): EnvironmentView | Promise<EnvironmentView>
  fetchImpl: FetchImpl
  now(): number
  randomId(): string
  nodeVersion: string
  checkTimeoutMs?: number
  confirmationTtlMs?: number
  /** 插件标识：单例键与日志标识用（规格 #591 第 2、6、8 条）。 */
  pluginId?: string
  /** 目标包名：要检查更新的那个包是谁（规格 #591 第 4 条，默认等于现状）。 */
  targetPackageName?: string
  /** 官方源：默认等于现状地址（规格 #591 第 4 条）。 */
  registryUrl?: string
  /**
   * 白名单源主机名（#124，可选）：Node 侧用 `redaction.resolveRegistryHost` 解析后注入，
   * 核心只把它填进 `update.registry.fetch.registryHost` 与 `update.check.done.source` 两格；
   * 不注入（或源不在白名单）即省略该格——省略本身即信息（ADR-0006：行里不许出现完整 URL）。
   */
  registryHost?: string | null
  /** 版本通道：默认 stable（与旧行为一字不差），显式传 prerelease 才收预发布（#16）。 */
  releaseChannel?: ReleaseChannel
  /** 安装时限毫秒：默认 15 分钟（规格 #591 第 5 条）。 */
  installTimeoutMs?: number
  /** 读已落盘的任务（没有为 null；读坏由外面抛错，核心收敛为状态不可用）。 */
  readJob?: () => UpdateJob | null | Promise<UpdateJob | null>
  /** 写任务（传 null 为清空；写坏由外面抛错）。 */
  writeJob?: (job: UpdateJob | null) => void | Promise<void>
  /** 抢锁：抢到为 true，被别人占着为 false（同一个使用范围同时只装一个）。 */
  tryAcquireLock?: (lockId: string) => boolean | Promise<boolean>
  /** 放锁（只放自己抢到的那把）。 */
  releaseLock?: (lockId: string) => void | Promise<void>
  /** 装前备份使用范围的清单（小清单，不含凭据与整个家目录）。 */
  backupJob?: (job: UpdateJob) => void | Promise<void>
  /**
   * 真正跑安装（按钮强制官方源、精确版本与 --save-exact）。
   * 核心只把政策要的三件事交给适配器：版本、使用范围名、宿主种类；
   * 适配器必须调 installRecipe 拿配方再执行，不得自己按系统或宿主分支选路由。
   * 测试一律给假的，不真跑。
   */
  runInstall?: (args: { version: string; profileName: string | null; environmentKind: EnvironmentKind; releaseChannel?: ReleaseChannel }) => void | Promise<void>
  /**
   * 合规版决议函数（#156，可选注入）：核心的零运行时导入契约不变——决议逻辑由外面递进来，
   * 不递时 `checkFallback` 按不支持诚实失败（与 `runInstall` 缺席走 `unsupported` 同口径）。
   * 生产经读取器接入 `resolveCompliantVersion` 真件，测试可给假件。
   */
  resolveCompliantVersion?: (input: CompliantVersionInput) => CompliantVerdict
  /**
   * 日志发射口（#124，可选）：核心里的稳定边沿（检查成败、通道判定、安装意图与装后校验）经它出去。
   * 递进来的函数必须已经绑好插件标识（路由用），不递即不记——老调用方行为一字不动。
   */
  emitLog?: UpdateLogPort
}

/** 对外三个方法（进度不单独给方法，调用方轮询查状态）。 */
export interface UpdateCore {
  /** 查状态：只读本地，不联网。 */
  status(): Promise<UpdateSnapshot>
  /**
   * 查新版：联网问一次，成功带回快照加检查凭证（分开交）。
   * `trigger` 是 #124 的加法扩展（可选）：调用方自报触发方，只进日志行 `update.check.start.trigger`，
   * 不参与任何决策；不自报即不落这条（宿主侧分不清用户点与自动跑，宁缺勿错）。
   */
  check(trigger?: CheckTrigger): Promise<CheckResult>
  /**
   * 装更新：拿检查编号加请求编号提交。
   * 只读半程诚实失败（unsupported），安装票再实现。
   * `from` 是 #124 的加法扩展（可选，缺省按 `'panel'`）：调用方自报安装意图来自哪里，
   * 只进日志行 `update.install.request.from`，不参与任何决策；老调用方不传即现状。
   * `version` 是 #156 的加法扩展（可选）：指定装合规版候选——只认 `checkFallback`
   * 结论第二槽的绑定版本，不认任意旧版；不传即走 latest 老路，一字不动。
   */
  install(args: { checkId: string; requestId: string; from?: InstallSource; version?: string }): Promise<UpdateSnapshot>
  /**
   * 合规版决议（#156）：年龄门拦住时问一次——取包时间表，对翻译官结论做五值裁决。
   * 有候选即同时落第二槽凭证（装候选时凭它绑定）；无候选/输入不可用即只给裁决，不取数或不留槽。
   * 取数失败按检查失败诚实抛（调用方退回通用老路），永不编造候选。
   */
  checkFallback(input: FallbackCheckInput): Promise<FallbackCheckResult>
}

/**
 * 模块标识（运行时唯一内容）：类型在转译时已擦除，
 * 转译出的 JS 只剩这一行；第二家直接吃 TS 源码。
 */
export const PORTS_SOURCE = 'src/ports.ts'
