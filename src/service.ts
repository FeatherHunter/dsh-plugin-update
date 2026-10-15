/**
 * src/service.ts — 更新模块的业务流程（安装闭环）。
 *
 * 由 update-core/src/service.ts 原样拎入：只记得规矩，不动手装：查状态读本地、查新版联网问一次、
 * 装前复核用的凭证与指纹在这里生成与比对，安装的排队、去重、复核、备份顺序也在此。
 * 真正的跑腿（读盘、联网、拼命令、执行）全在适配器，本文件零导入，依赖全当参数传。
 *
 * 相对原样的增量（规格 #591 第 4、5 条）：目标包名、官方源、联网超时、凭证有效期经 UpdatePorts
 * 的可选字段注入，默认值等于现状常量（冻结默认值）。不传即走现状，老调用零变化。
 */

import type {
  BlockedReason,
  CheckResult,
  CheckTrigger,
  EnvironmentView,
  FetchImpl,
  InstallSource,
  MinimalResponse,
  ReleaseInfo,
  UpdateCore,
  UpdateErrorCode,
  UpdateJob,
  UpdateLogPort,
  UpdatePorts,
  UpdateSnapshot,
} from './ports.js'

export const PACKAGE_NAME = 'dsh-mattpocock-skills-deck'
export const NPM_REGISTRY = 'https://registry.npmjs.org/'
export const CHECK_TIMEOUT_MS = 10_000
export const CONFIRMATION_TTL_MS = 10 * 60_000
/** 2 秒内重复点击复用上次结果，不重新联网。 */
export const RECHECK_WINDOW_MS = 2_000
export const MAX_METADATA_BYTES = 256 * 1024
export const INTEGRITY_PATTERN = '^sha512-[A-Za-z0-9+/]{86}==$'

/** 取数阶段（#124）：`update.check.fail.stage` 与 `update.registry.fetch` 的定位用，四个合法值。 */
type FetchStage = 'fetch' | 'compare' | 'channel' | 'verify'

/**
 * 给错误贴一个取数阶段（#124）：核心只用它写 `update.check.fail.stage`，不参与归类决策。
 * 贴不上的按码兜底——`check-failed` 是没连上/没取到（fetch），其余是拿到了但内容或通道不认（verify）。
 */
function stageOfError(error: unknown): FetchStage {
  const stage = (error as { stage?: unknown } | null)?.stage
  if (stage === 'fetch' || stage === 'compare' || stage === 'channel' || stage === 'verify') return stage
  return (error as { code?: unknown } | null)?.code === 'check-failed' ? 'fetch' : 'verify'
}

/** 稳定码（#124）：行里只许稳定码，不许自由文本；没有码就给 `internal`（与 diag 同一口径）。 */
function stableCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && code ? code : 'internal'
}

/** HTTP 状态码（#124）：只有取数阶段真的带回来才写，不猜。 */
function httpStatusOfError(error: unknown): number | null {
  const status = (error as { httpStatus?: unknown } | null)?.httpStatus
  return typeof status === 'number' && Number.isInteger(status) ? status : null
}

/** 安装意图来源（#124）：认不出或没报都按 `panel`（电话的既有调用方是面板）。 */
function installSourceOf(value: unknown): InstallSource {
  return value === 'entry' || value === 'batch' ? value : 'panel'
}

/**
 * 检查触发方（#124）：只有调用方**自报**了合法取值才认，认不出返回 null。
 * 原因：宿主侧只能看到「有人在问」，分不清用户点的还是自动跑的（`pendingAutoCheck` 走同一支电话）；
 * 猜一个 `'user'` 会在自动检查时留下口径相反的行，宁可不发（由触发方在客户端侧打点，见 W1 目录 ③）。
 */
function triggerOf(value: unknown): CheckTrigger | null {
  return value === 'auto' || value === 'user' || value === 'batch' || value === 'entry' ? value : null
}

/**
 * 请求编号是否合法（#19 收紧：非空、去空格后 1 到 128 个字符，且为不透明编号形状）。
 *
 * 收紧内容：只收 `[A-Za-z0-9._~-]`（UUID 与 `req-1` 形都在内），拒绝路径 / 令牌 / 邮箱 /
 * 键值对 / URL 用户信息形状——要放进诊断块的正是接入方经公开电话传进来的这个值，
 * 旧口径下路径与令牌形状的字符串都能通过（见 #19 Out of Scope 第 1 件）。
 * 属公开契约变更（破冰范围）：兼容说明与迁移口径见 #19 进度区——调用方请用 UUID 或同形状不透明串，
 * 不要把路径、令牌、邮箱、URL 当编号传；旧的合法不透明串（`req-1`、`id-N`、UUID）不受影响。
 */
export function validRequestId(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const id = v.trim()
  if (id.length < 1 || id.length > 128) return false
  if (!/^[A-Za-z0-9._~-]+$/.test(id)) return false
  if (/^(npm_|gh[pousr]_|github_pat_|sk-|bearer)/i.test(id)) return false
  return true
}

export function updateError(code: UpdateErrorCode): Error & { code: UpdateErrorCode } {
  return Object.assign(new Error(code), { code })
}

// ---------- 版本号小工具（只认纯数字三段，预发布一律拒绝） ----------
// 冻结语：validVersion / compareVersions 的行为保持现状（stable 通道默认值），
// 预发布识别走下面新增的 release 版小工具（#16，加法扩展，不改旧行为）。

export function validVersion(v: unknown): v is string {
  return typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v)
}

/** 版本通道：默认只推 stable；prerelease 须调用方显式 opt-in（#16）。 */
export type ReleaseChannel = 'stable' | 'prerelease'
export const RELEASE_CHANNELS = ['stable', 'prerelease'] as const

export function validReleaseChannel(v: unknown): v is ReleaseChannel {
  return v === 'stable' || v === 'prerelease'
}

/** 预发布标识符是否合法（SemVer §9：点分字母数字与连字符，非空、不留空段）。 */
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

/**
 * 发行版本号（含预发布）：`X.Y.Z` 或 `X.Y.Z-ids`（ids 见 SemVer §9）。
 * stable 版（纯三段）恒为真；`0.2.0-rc.2` 这类预发布在此为真、在 validVersion 为假。
 */
export function validReleaseVersion(v: unknown): v is string {
  if (typeof v !== 'string' || !v) return false
  const dash = v.indexOf('-')
  if (dash < 0) return validVersion(v)
  const core = v.slice(0, dash)
  const ids = v.slice(dash + 1)
  if (!validVersion(core) || !validPrereleaseIds(ids)) return false
  // 构建元数据（`+build`）不参与版本比较，本包不接受：含 `+` 一律拒绝。
  if (ids.includes('+')) return false
  return true
}

/** 是否预发布版本（发行合法但非纯三段）。 */
export function isPrereleaseVersion(v: unknown): v is string {
  return validReleaseVersion(v) && !validVersion(v)
}

/** 该版本在该通道是否允许出现：stable 通道只收纯三段，prerelease 通道两者皆收。 */
export function isVersionAllowedInChannel(version: unknown, channel: ReleaseChannel = 'stable'): version is string {
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

/** -1 更小，0 相等，1 更大（入参须先过 validVersion 或 parseTriple）。 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseTriple(a)
  const pb = parseTriple(b)
  if (!pa || !pb) throw updateError('invalid-release')
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1
    if (pa[i] > pb[i]) return 1
  }
  return 0
}

function parseReleaseIds(ids: string): (number | string)[] {
  return ids.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p))
}

/**
 * 发行版比较（SemVer §11）：先比三段数字；三段相等时，无预发布 > 有预发布；
 * 都有预发布则按标识符逐个比（纯数字按数字比、数字 < 字母、段多者大）。
 * 入参须先过 validReleaseVersion，否则抛 invalid-release。
 */
export function compareReleaseVersions(a: string, b: string): -1 | 0 | 1 {
  if (!validReleaseVersion(a) || !validReleaseVersion(b)) throw updateError('invalid-release')
  const dashA = String(a).indexOf('-')
  const dashB = String(b).indexOf('-')
  const coreA = dashA < 0 ? String(a) : String(a).slice(0, dashA)
  const coreB = dashB < 0 ? String(b) : String(b).slice(0, dashB)
  const order = compareVersions(coreA, coreB)
  if (order !== 0) return order
  const preA = dashA < 0 ? null : parseReleaseIds(String(a).slice(dashA + 1))
  const preB = dashB < 0 ? null : parseReleaseIds(String(b).slice(dashB + 1))
  if (preA === null && preB === null) return 0
  if (preA === null) return 1
  if (preB === null) return -1
  const width = Math.max(preA.length, preB.length)
  for (let i = 0; i < width; i++) {
    const x = preA[i]
    const y = preB[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (typeof x === 'number' && typeof y === 'number') {
      if (x < y) return -1
      if (x > y) return 1
      continue
    }
    if (typeof x === 'number') return -1
    if (typeof y === 'number') return 1
    if (x < y) return -1
    if (x > y) return 1
  }
  return 0
}

function compareOne(node: [number, number, number], op: string, target: [number, number, number]): boolean {
  const order = compareTriple(node, target)
  if (op === '=' || op === '') return order === 0
  if (op === '>') return order === 1
  if (op === '>=') return order >= 0
  if (op === '<') return order === -1
  if (op === '<=') return order <= 0
  return true
}

function compareTriple(a: [number, number, number], b: [number, number, number]): -1 | 0 | 1 {
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return -1
    if (a[i] > b[i]) return 1
  }
  return 0
}

function upperBound(t: [number, number, number], kind: '^' | '~', kept: number): [number, number, number] {
  if (kind === '^') {
    if (kept >= 1) return [t[0] + 1, 0, 0]
    return [0, t[1] + 1, 0]
  }
  if (kept >= 2) return [t[0], t[1] + 1, 0]
  return [t[0] + 1, 0, 0]
}

/**
 * 运行环境是否满足远端要求的 Node 范围。
 * 只看懂星号、精确版与 ^ ~ > >= < <= 比较式；看不懂的写法一律放行不误拦。
 */
export function satisfiesNodeRange(nodeVersion: string, range: string | undefined): boolean {
  if (range === undefined || range === null) return true
  const text = String(range).trim()
  if (text === '' || text === '*') return true
  const node = parseTriple(String(nodeVersion).replace(/^v/, ''))
  if (!node) return true
  if (text.includes('||')) return true
  const parts = text.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return true
  for (const part of parts) {
    const m = part.match(/^(\^|~|>=|<=|>|<|=)?(.+)$/)
    if (!m) return true
    const op = m[1] || ''
    const target = parseTriple(m[2])
    if (!target) return true
    if (op === '^' || op === '~') {
      const kept = m[2].split('.').length
      if (compareTriple(node, target) < 0) return false
      if (compareTriple(node, upperBound(target, op, kept)) >= 0) return false
      continue
    }
    if (!compareOne(node, op, target)) return false
  }
  return true
}

// ---------- 问远端（联网只发生在这里，调用方点一次才问一次） ----------

function byteLength(text: string): number {
  try {
    return new TextEncoder().encode(text).length
  } catch {
    return text.length
  }
}

function timeoutSignal(ms: number): unknown {
  try {
    const ctor = (globalThis as { AbortSignal?: { timeout?: (ms: number) => unknown } }).AbortSignal
    if (ctor && typeof ctor.timeout === 'function') return ctor.timeout(ms)
  } catch {
    // 忽略：没有超时能力就直接请求，调用方仍可经外层超时收敛为检查失败。
  }
  return undefined
}

function httpStatusOf(response: MinimalResponse | null): number | null {
  const raw = (response as { status?: unknown } | null)?.status
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 100 && raw <= 599 ? raw : null
}

function checkFailedWithStatus(response: MinimalResponse | null): Error & { code: UpdateErrorCode; httpStatus?: number } {
  const err = updateError('check-failed') as Error & { code: UpdateErrorCode; httpStatus?: number; stage?: FetchStage }
  const status = httpStatusOf(response)
  if (status !== null) err.httpStatus = status
  // 阶段钉在错误上（#124）：`update.check.fail.stage` 只许四值，取数阶段就是 fetch。
  err.stage = 'fetch'
  return err
}

/** 给错误贴阶段（#124，贴不上不改行为）。 */
function withStage<T extends Error>(error: T, stage: FetchStage): T {
  try {
    ;(error as { stage?: FetchStage }).stage = stage
  } catch {
    /* 冻结对象等怪情况：贴不上就算了，行里的 stage 按码兜底 */
  }
  return error
}
/**
 * 取数打点器（#124）：`update.registry.fetch` 的唯一落点。只记状态码、耗时与白名单主机名，
 * 不带 URL、不带账号（ADR-0001 规则 3）；没给发射口就什么也不做（默认等于现状）。
 *
 * `cacheHit` 这一格不发：本包的缓存命中发生在取数之前（命中就根本不取数，也就不发这行），
 * 到了取数点就是未命中——发一个恒为 false 的格子只是噪声（接线结论记在事件目录里）。
 */
function makeFetchNoter(
  emitLog: UpdateLogPort | undefined,
  registryHost: string | null | undefined,
): (httpStatus: number | null, startedAt: number) => void {
  const port = typeof emitLog === 'function' ? emitLog : null
  const host = typeof registryHost === 'string' && registryHost ? registryHost : null
  if (!port) return () => {}
  return (httpStatus: number | null, startedAt: number): void => {
    try {
      port('info', 'update.registry.fetch', {
        ...(httpStatus === null ? {} : { httpStatus }),
        latencyMs: Math.max(0, Date.now() - startedAt),
        ...(host ? { registryHost: host } : {}),
      })
    } catch {
      /* 记日志绝不挡取数：注入方可能是第三方实现，坏了就当没记 */
    }
  }
}

/**
 * 问官方源的最新版接口，只接受名字对得上、版本号合法正式版、
 * 包地址与完整性校验全合规的返回，否则按版本信息无效处理。
 *
 * 联网取数失败带 httpStatus（仅 !ok 有；假件不给即省略，diag 按阶段×键表断言）：
 * 取数阶段该有、校验阶段不该有（由 diag 层按阶段强制省略，本层只诚实携带）。
 */
export async function fetchNpmRelease(
  fetchImpl: FetchImpl,
  timeoutMs: number = CHECK_TIMEOUT_MS,
  opts?: {
    targetPackageName?: string
    registryUrl?: string
    releaseChannel?: ReleaseChannel
    /** 日志发射口（#124，可选）：取数这一次的事实（状态码/耗时/白名单主机名）经它出去。 */
    emitLog?: UpdateLogPort
    /** 白名单源主机名（#124，可选）：不在白名单即省略该格，绝不落完整 URL。 */
    registryHost?: string | null
  },
): Promise<ReleaseInfo> {
  const targetName = opts?.targetPackageName ?? PACKAGE_NAME
  const registry = opts?.registryUrl ?? NPM_REGISTRY
  const channel: ReleaseChannel = opts?.releaseChannel === 'prerelease' ? 'prerelease' : 'stable'
  const noteFetch = makeFetchNoter(opts?.emitLog, opts?.registryHost)
  let response: MinimalResponse | null = null
  const startedAt = Date.now()
  try {
    response = await fetchImpl(`${registry}${encodeURIComponent(targetName)}/latest`, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: timeoutSignal(timeoutMs),
    })
  } catch {
    noteFetch(null, startedAt)
    throw updateError('check-failed')
  }
  noteFetch(httpStatusOf(response), startedAt)
  try {
    if (!response.ok) throw checkFailedWithStatus(response)
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_METADATA_BYTES) throw updateError('invalid-release')
    const text = await response.text()
    if (byteLength(text) > MAX_METADATA_BYTES) throw updateError('invalid-release')
    const value = JSON.parse(text) as {
      name?: unknown
      version?: unknown
      engines?: { node?: unknown }
      dist?: { tarball?: unknown; integrity?: unknown }
    }
    if (value.name !== targetName) throw updateError('invalid-release')
    // 通道门单独贴 stage（#124）：远端版本不被本通道接受，是「通道判定」不是「版本信息坏掉」。
    if (!isVersionAllowedInChannel(value.version, channel)) {
      throw withStage(updateError('invalid-release'), 'channel')
    }
    const version = value.version
    const nodeRange = value.engines?.node
    if (nodeRange !== undefined && typeof nodeRange !== 'string') throw updateError('invalid-release')
    const tarballText = value.dist?.tarball
    const integrity = value.dist?.integrity
    let tarball: URL
    try {
      tarball = new URL(String(tarballText))
    } catch {
      throw updateError('invalid-release')
    }
    const registryOrigin = new URL(registry).origin
    const shapeOk =
      tarball.origin === registryOrigin &&
      !tarball.username &&
      !tarball.password &&
      !tarball.search &&
      !tarball.hash &&
      tarball.pathname === `/${targetName}/-/${targetName}-${version}.tgz` &&
      typeof integrity === 'string' &&
      new RegExp(INTEGRITY_PATTERN).test(integrity)
    if (!shapeOk) throw updateError('invalid-release')
    return { version, nodeRange: typeof nodeRange === 'string' ? nodeRange : '*', integrity, tarball: tarball.href }
  } catch (error) {
    if ((error as { code?: unknown })?.code === 'check-failed') throw error
    if ((error as { code?: unknown })?.code === 'invalid-release') throw error
    // 已连上但内容坏掉（读 body 失败、JSON 解析失败）算版本信息无效；
    // 连不上、超时、中断都算检查失败（有状态带状态，无状态即省略）。
    if (response !== null && response.ok) throw updateError('invalid-release')
    throw checkFailedWithStatus(response)
  }
}

/**
 * 按版本号取发行信息（#38 更新日志电话用：面板说要哪版就取哪版）。
 *
 * 与 fetchNpmRelease 同一信任根：只接受名字对得上、版本与请求完全一致且发行合法、
 * 包地址与完整性校验全合规的返回，否则按版本信息无效处理。通道门禁同样复用
 * （stable 只要纯三段，prerelease 才收预发布）。取的是版本文档（与 latest 文档同量级），
 * 不是全量包元数据。
 */
export async function fetchNpmVersionRelease(
  fetchImpl: FetchImpl,
  timeoutMs: number = CHECK_TIMEOUT_MS,
  opts: {
    targetPackageName?: string
    registryUrl?: string
    releaseChannel?: ReleaseChannel
    version: string
    /** 日志发射口（#124，可选）：与 fetchNpmRelease 同一格取数事实（更新日志电话取版本文档时也走这里）。 */
    emitLog?: UpdateLogPort
    /** 白名单源主机名（#124，可选）：不在白名单即省略，绝不落完整 URL。 */
    registryHost?: string | null
  },
): Promise<ReleaseInfo> {
  const targetName = opts?.targetPackageName ?? PACKAGE_NAME
  const registry = opts?.registryUrl ?? NPM_REGISTRY
  const channel: ReleaseChannel = opts?.releaseChannel === 'prerelease' ? 'prerelease' : 'stable'
  const version = opts?.version
  const noteFetch = makeFetchNoter(opts?.emitLog, opts?.registryHost)
  if (typeof version !== 'string' || !validReleaseVersion(version) || !isVersionAllowedInChannel(version, channel)) {
    throw withStage(updateError('invalid-release'), 'channel')
  }
  let response: MinimalResponse | null = null
  const startedAt = Date.now()
  try {
    response = await fetchImpl(`${registry}${encodeURIComponent(targetName)}/${encodeURIComponent(version)}`, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: timeoutSignal(timeoutMs),
    })
  } catch {
    noteFetch(null, startedAt)
    throw updateError('check-failed')
  }
  noteFetch(httpStatusOf(response), startedAt)
  try {
    if (!response.ok) throw checkFailedWithStatus(response)
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_METADATA_BYTES) throw updateError('invalid-release')
    const text = await response.text()
    if (byteLength(text) > MAX_METADATA_BYTES) throw updateError('invalid-release')
    const value = JSON.parse(text) as {
      name?: unknown
      version?: unknown
      engines?: { node?: unknown }
      dist?: { tarball?: unknown; integrity?: unknown }
    }
    if (value.name !== targetName || value.version !== version) throw updateError('invalid-release')
    // 通道门单独贴 stage（#124）：与 fetchNpmRelease 同一口径。
    if (!isVersionAllowedInChannel(value.version, channel)) {
      throw withStage(updateError('invalid-release'), 'channel')
    }
    const nodeRange = value.engines?.node
    if (nodeRange !== undefined && typeof nodeRange !== 'string') throw updateError('invalid-release')
    const tarballText = value.dist?.tarball
    const integrity = value.dist?.integrity
    let tarball: URL
    try {
      tarball = new URL(String(tarballText))
    } catch {
      throw updateError('invalid-release')
    }
    const registryOrigin = new URL(registry).origin
    const shapeOk =
      tarball.origin === registryOrigin &&
      !tarball.username &&
      !tarball.password &&
      !tarball.search &&
      !tarball.hash &&
      tarball.pathname === `/${targetName}/-/${targetName}-${version}.tgz` &&
      typeof integrity === 'string' &&
      new RegExp(INTEGRITY_PATTERN).test(integrity)
    if (!shapeOk) throw updateError('invalid-release')
    return { version, nodeRange: typeof nodeRange === 'string' ? nodeRange : '*', integrity, tarball: tarball.href }
  } catch (error) {
    if ((error as { code?: unknown })?.code === 'check-failed') throw error
    if ((error as { code?: unknown })?.code === 'invalid-release') throw error
    if (response !== null && response.ok) throw updateError('invalid-release')
    throw checkFailedWithStatus(response)
  }
}

// ---------- 核心工厂（记得规矩，不动手装） ----------

interface CheckedState {
  release: ReleaseInfo
  checkId: string | null
  checkedAt: number
  expiresAt: number
  installationKey: string | null
  blockedReason: BlockedReason | null
}

export function createUpdateCore(ports: UpdatePorts): UpdateCore {
  const checkTimeoutMs = ports.checkTimeoutMs ?? CHECK_TIMEOUT_MS
  const confirmationTtlMs = ports.confirmationTtlMs ?? CONFIRMATION_TTL_MS
  const targetPackageName = ports.targetPackageName ?? PACKAGE_NAME
  const registryUrl = ports.registryUrl ?? NPM_REGISTRY
  const releaseChannel: ReleaseChannel = ports.releaseChannel === 'prerelease' ? 'prerelease' : 'stable'
  // 日志发射口（#124）：中立文件不 import node，发射函数由建口人**绑好插件标识**后注入；
  // 不注入即不记——默认等于现状，老调用一字不动。行的四纪律（脱敏/白名单/准入/预算）都在发射口里。
  const logPort: UpdateLogPort | null = typeof ports.emitLog === 'function' ? ports.emitLog : null
  // 白名单源主机名（#124）：同样由 Node 侧解析后注入，不在白名单即省略该格（省略本身即信息）。
  const registryHost = typeof ports.registryHost === 'string' && ports.registryHost ? ports.registryHost : null
  /** 行只从唯一发射口出；发射口坏了也绝不挡检查与安装（注入方可能是第三方实现）。 */
  function emit(level: string, event: string, fields: Record<string, unknown>, opts?: { always?: boolean }): void {
    if (!logPort) return
    try {
      logPort(level, event, fields, opts)
    } catch {
      /* 记日志绝不挡功能 */
    }
  }
  function fetchRelease(): Promise<ReleaseInfo> {
    return fetchNpmRelease(ports.fetchImpl, checkTimeoutMs, {
      targetPackageName,
      registryUrl,
      releaseChannel,
      emitLog: logPort ?? undefined,
      registryHost,
    })
  }
  let checked: CheckedState | null = null
  let checking: Promise<CheckResult> | null = null
  let lastCheckAt = -Infinity
  let activeJobId: string | null = null
  // 已经记过中断换算的任务编号（#124）：落盘写不回去时防重复刷屏。
  const notedInterruptions = new Set<string>()
  let memJob: UpdateJob | null = null
  let memLock: string | null = null
  async function loadJob(): Promise<UpdateJob | null> {
    try {
      return ports.readJob ? ((await ports.readJob()) ?? null) : memJob
    } catch {
      throw updateError('install-failed')
    }
  }
  async function saveJob(job: UpdateJob | null): Promise<void> {
    try {
      if (ports.writeJob) await ports.writeJob(job)
      else memJob = job
    } catch {
      throw updateError('install-failed')
    }
  }
  async function acquire(lockId: string): Promise<boolean> {
    try {
      if (ports.tryAcquireLock) return await ports.tryAcquireLock(lockId)
    } catch {
      return false
    }
    if (memLock !== null) return false
    memLock = lockId
    return true
  }
  async function release(lockId: string): Promise<void> {
    try {
      if (ports.releaseLock) await ports.releaseLock(lockId)
      else if (memLock === lockId) memLock = null
    } catch {}
  }
  function healJob(job: UpdateJob | null, env: EnvironmentView): UpdateJob | null {
    if (!job) return null
    if (job.state === 'installing' || job.state === 'verifying') {
      return job.id === activeJobId ? job : { ...job, state: 'interrupted', message: 'recovery-required', requestId: job.requestId ?? null }
    }
    if (job.state === 'restart-required' || job.state === 'completed') {
      if (!job.targetVersion || env.installedVersion !== job.targetVersion) {
        return { ...job, state: 'interrupted', message: 'installation-changed', requestId: job.requestId ?? null }
      }
      const runningVersion = ports.readRunningVersion()
      return { ...job, state: runningVersion === job.targetVersion ? 'completed' : 'restart-required', requestId: job.requestId ?? null }
    }
    return job
  }

  function buildSnapshot(env: EnvironmentView, job: UpdateJob | null): UpdateSnapshot {
    let blockedReason: BlockedReason | null = env.blockedReason ?? checked?.blockedReason ?? null
    if (job?.state === 'interrupted' || job?.state === 'failed') {
      if (env.installedVersion !== ports.readRunningVersion()) blockedReason = 'recovery-required'
    } else if (job?.state === 'restart-required' || (env.installedVersion && env.installedVersion !== ports.readRunningVersion())) {
      blockedReason = 'pending-restart'
    }
    const busy = job?.state === 'installing' || job?.state === 'verifying'
    const fresh = checked !== null && checked.checkId !== null && ports.now() < checked.expiresAt
    const runningVersion = ports.readRunningVersion()
    // 通道门（#16）：stable 默认与旧行为一字不差（纯三段 + 数字比较）；
    // prerelease 通道下运行版与远端版都按发行版语义比（预发布 < 同号正式版）。
    let newer = false
    try {
      newer =
        isVersionAllowedInChannel(runningVersion, releaseChannel) &&
        !!checked?.release &&
        isVersionAllowedInChannel(checked.release.version, releaseChannel) &&
        compareReleaseVersions(checked.release.version, runningVersion) === 1
    } catch {
      newer = false
    }
    const canInstall = Boolean(
      env.eligible &&
        !blockedReason &&
        !busy &&
        fresh &&
        checked?.installationKey === env.installationKey &&
        newer,
    )
    const snapshot: UpdateSnapshot = {
      runningVersion,
      installedVersion: env.installedVersion ?? null,
      latestVersion: checked?.release.version ?? null,
      canInstall,
      blockedReason,
      job,
    }
    // 主状态边沿（#124）：快照每次算出来都对一次账，只有真的变了才落一行。
    noteStatusChanged(snapshot)
    return snapshot
  }

  /** 主状态三值（#124）：与快照「有没有新版」同一判据，不许出现第二套口径。 */
  function statusKindOf(snapshot: UpdateSnapshot): 'update-available' | 'up-to-date' | 'unknown' {
    if (!snapshot.latestVersion) return 'unknown'
    try {
      const newer =
        isVersionAllowedInChannel(snapshot.runningVersion, releaseChannel) &&
        isVersionAllowedInChannel(snapshot.latestVersion, releaseChannel) &&
        compareReleaseVersions(snapshot.latestVersion, snapshot.runningVersion) === 1
      return newer ? 'update-available' : 'up-to-date'
    } catch {
      return 'unknown'
    }
  }
  let lastStatusKind: string | null = null
  /**
   * `update.status.changed` 的唯一落点（#124）：常驻行的铁律是边沿触发，所以状态没变就一条不发；
   * 变了就强制落（`always`）——发射口的去重记忆按事件名走，多插件同进程会互相压，本处自己把关。
   */
  function noteStatusChanged(snapshot: UpdateSnapshot): void {
    const kind = statusKindOf(snapshot)
    if (kind === lastStatusKind) return
    lastStatusKind = kind
    emit(
      'info',
      'update.status.changed',
      { kind, ...(snapshot.latestVersion ? { latest: snapshot.latestVersion } : {}) },
      { always: true },
    )
  }

  /**
   * 通道判定（#124）：一次成功检查落一行。四值是相互排斥的判定结果，不是自由文本：
   * 版本形状都不像版本 → `invalid`；形状像但有一条不被本通道接受 → `mismatch`；都收 → 本通道名。
   */
  function noteChannelDecision(current: string, latest: string): void {
    const shapeOk = validVersion(current) && validVersion(latest)
    let reason: 'stable' | 'prerelease' | 'mismatch' | 'invalid'
    if (!shapeOk) reason = 'invalid'
    else if (!isVersionAllowedInChannel(current, releaseChannel) || !isVersionAllowedInChannel(latest, releaseChannel)) {
      reason = 'mismatch'
    } else reason = releaseChannel === 'prerelease' ? 'prerelease' : 'stable'
    emit('info', 'update.channel.decide', { channel: releaseChannel, reason, from: current, to: latest })
  }

  function jobsEqual(a: UpdateJob | null, b: UpdateJob | null): boolean {
    if (a === b) return true
    if (!a || !b) return false
    return a.id === b.id && a.state === b.state && a.targetVersion === b.targetVersion && a.message === b.message && (a.requestId ?? null) === (b.requestId ?? null)
  }
  async function healedJob(env: EnvironmentView): Promise<UpdateJob | null> {
    const loaded = await loadJob()
    const healed = healJob(loaded, env)
    if (!jobsEqual(loaded, healed)) {
      try {
        await saveJob(healed)
      } catch {
        // 只读回查的落盘是 best-effort：写不回去仍按换算后的快照展示，不把状态读数变成安装失败。
      }
      // 中断换算（#124）：只有这次读回**才**把任务从活状态换成 `interrupted` 时记一条。
      // 落盘是 best-effort：写不回去时每次读回都会重现同一个换算，所以按任务编号去重，不刷屏。
      if (healed && healed.state === 'interrupted' && loaded && loaded.state !== 'interrupted' && !notedInterruptions.has(healed.id)) {
        notedInterruptions.add(healed.id)
        emit('info', 'update.install.verify', {
          result: 'interrupted',
          ...(env.installedVersion ? { installedVersion: env.installedVersion } : {}),
          pendingRestart: false,
        })
      }
    }
    return healed
  }
  async function status(): Promise<UpdateSnapshot> {
    const t0 = Date.now()
    const env = await ports.readInstalled()
    const job = await healedJob(env)
    const snapshot = buildSnapshot(env, job)
    // `update.poll`（#124，ondemand 档）：这一支就是每秒轮询走的入口。开关没开时发射口直接丢，
    // 不占预算；`state` 用主状态三值，与 `update.status.changed` 同一口径（排查「为什么一直在轮询」用）。
    emit('info', 'update.poll', { state: statusKindOf(snapshot), latencyMs: Math.max(0, Date.now() - t0) })
    return snapshot
  }

  async function check(trigger?: unknown): Promise<CheckResult> {
    if (checking) return checking
    // 2 秒内重复点击复用上次结果，不重新联网（失败不缓存为成功）。
    if (checked?.checkId && ports.now() - lastCheckAt < RECHECK_WINDOW_MS) {
      const env = await ports.readInstalled()
      const snapshot = buildSnapshot(env, await healedJob(env))
      return { snapshot, receipt: snapshot.canInstall ? toReceipt() : null }
    }
    lastCheckAt = ports.now()
    const startedAt = Date.now()
    // `update.check.start`（#124，ondemand 档）：只在调用方自报了触发方时落一条。
    const askedBy = triggerOf(trigger)
    if (askedBy) {
      emit('info', 'update.check.start', {
        trigger: askedBy,
        ...(registryHost ? { source: registryHost } : {}),
      })
    }
    checking = (async () => {
      try {
        const env = await ports.readInstalled()
        const release = await fetchRelease()
        checked = {
          release,
          checkId: ports.randomId(),
          checkedAt: ports.now(),
          expiresAt: ports.now() + confirmationTtlMs,
          installationKey: env.installationKey,
          blockedReason: satisfiesNodeRange(ports.nodeVersion, release.nodeRange) ? null : 'incompatible-node',
        }
        // 凭证只在能装时交：没新版或有阻拦时交了也没用，不交。
        const snapshot = buildSnapshot(env, await healedJob(env))
        // 通道判定与检查成功各一条（#124）：顺序是先判定再宣布成功，读日志的人先看到「为什么」。
        noteChannelDecision(snapshot.runningVersion, release.version)
        emit('info', 'update.check.done', {
          ok: true,
          current: snapshot.runningVersion,
          latest: release.version,
          channel: releaseChannel,
          ...(registryHost ? { source: registryHost } : {}),
          latencyMs: Math.max(0, Date.now() - startedAt),
        })
        return { snapshot, receipt: snapshot.canInstall ? toReceipt() : null }
      } catch (error) {
        if (checked) checked = { ...checked, checkId: null, expiresAt: 0 }
        const httpStatus = httpStatusOfError(error)
        emit('warn', 'update.check.fail', {
          stage: stageOfError(error),
          errorKind: stableCodeOf(error),
          ...(httpStatus === null ? {} : { httpStatus }),
        })
        throw error
      } finally {
        checking = null
      }
    })()
    return checking
  }

  function toReceipt(): CheckResult['receipt'] {
    if (!checked?.checkId) return null
    // 凭证只交编号与有效期：环境指纹留在核心内存里，快照与凭证都不带它。
    return { checkId: checked.checkId, checkedAt: checked.checkedAt, expiresAt: checked.expiresAt }
  }

  async function runBackground(job: UpdateJob, envAtStart: EnvironmentView): Promise<void> {
    // 装后校验读到的环境（#124）：失败分支也要如实记「磁盘上是什么版本」。
    let verifiedEnv: EnvironmentView | null = null
    try {
      if (ports.runInstall) await ports.runInstall({ version: job.targetVersion as string, profileName: envAtStart.profileName, environmentKind: envAtStart.environmentKind, releaseChannel })
      // 字面量不另存一份真源：`satisfies UpdateErrorCode` 把它钉在 src/codes.ts 的类型上，
      // 真源删/改这个码这里立刻 typecheck 报错；而本文件「零（运行时）导入」的契约不受影响。
      else throw updateError('unsupported' satisfies UpdateErrorCode)
      const doing: UpdateJob = { ...job, state: 'verifying', message: null }
      activeJobId = doing.id
      await saveJob(doing)
      const env = await ports.readInstalled()
      verifiedEnv = env
      // 装完校验也会失败：它同样要给出一句能读的说明，不能只留一个死码（验收判据 1）。
      if (env.installedVersion !== job.targetVersion) {
        throw Object.assign(updateError('install-failed'), {
          detail: `装完校验没过：磁盘上是 ${env.installedVersion ?? '未知'}，目标是 ${job.targetVersion ?? '未知'}`,
        })
      }
      if (env.blockedReason && env.blockedReason !== 'pending-restart') {
        throw Object.assign(updateError('install-failed'), { detail: `装完校验没过：环境报告 ${env.blockedReason}` })
      }
      const done: UpdateJob = { ...doing, state: 'restart-required', message: null }
      await saveJob(done)
      // 装后校验（#124）：磁盘版本与目标一致才算过；要不要重启按运行版判定——
      // 运行版还没换过来就是 `restart-required`，已经换过来了就是 `completed`。
      const pendingRestart = ports.readRunningVersion() !== job.targetVersion
      emit('info', 'update.install.verify', {
        result: pendingRestart ? 'restart-required' : 'completed',
        ...(env.installedVersion ? { installedVersion: env.installedVersion } : {}),
        pendingRestart,
      })
    } catch (error) {
      const code = (error as { code?: unknown })?.code
      const base =
        code === 'installation-changed' || code === 'registry-conflict' || code === 'install-failed' ? String(code) : 'install-failed'
      // 失败详情（宿主原话，执行器已截断脱敏）补进已有的 message 通道：值从纯 code 变成
      // 「code: 原话」，字段集与形状不变。消费方要匹配就匹配前缀 code，别做整串相等（README 第 12 节）。
      const detail = (error as { detail?: unknown })?.detail
      const message = typeof detail === 'string' && detail ? `${base}: ${detail}` : base
      const failedJob: UpdateJob = { ...job, state: 'failed', message, requestId: job.requestId ?? null }
      try {
        await saveJob(failedJob)
      } catch {
        memJob = failedJob
      }
      // 安装或装后校验失败（#124）：`result:'failed'`；磁盘上读到什么版本就记什么，读不到省这一格。
      emit('info', 'update.install.verify', {
        result: 'failed',
        ...(verifiedEnv?.installedVersion ? { installedVersion: verifiedEnv.installedVersion } : {}),
        pendingRestart: false,
      })
    } finally {
      await release(job.id)
      if (activeJobId === job.id) activeJobId = null
    }
  }

  async function install(args: { checkId: string; requestId: string; from?: InstallSource }): Promise<UpdateSnapshot> {
    const checkId = typeof args?.checkId === 'string' ? args.checkId : ''
    const requestId = typeof args?.requestId === 'string' ? args.requestId : ''
    if (!checkId || !validRequestId(requestId)) throw updateError('check-expired')
    let env = await ports.readInstalled()
    let previous = healJob(await loadJob(), env)
    // 同一个请求编号重复提交直接返回旧结果，不重装。
    if (previous?.requestId === requestId) return buildSnapshot(env, previous)
    if (previous?.state === 'installing' || previous?.state === 'verifying' || previous?.state === 'restart-required') {
      throw updateError('update-busy')
    }
    if (!checked || !checked.checkId || checked.checkId !== checkId || ports.now() >= checked.expiresAt) {
      throw updateError('check-expired')
    }
    if (env.installationKey !== checked.installationKey) throw updateError('installation-changed')
    if (!buildSnapshot(env, previous).canInstall) {
      throw updateError(env.blockedReason ?? checked.blockedReason ?? 'update-busy')
    }
    // 用户意图（#124）：过完所有闸门、真的要装了才落这一条；被闸门挡掉的请求不算一次意图。
    emit('info', 'update.install.request', {
      from: installSourceOf(args?.from),
      current: ports.readRunningVersion(),
      latest: checked.release.version,
      checkAgeMs: Math.max(0, ports.now() - checked.checkedAt),
    })
    const job: UpdateJob = {
      id: ports.randomId(),
      state: 'installing',
      targetVersion: checked.release.version,
      message: null,
      requestId,
    }
    if (!(await acquire(job.id))) throw updateError('update-busy')
    try {
      const current = await fetchRelease()
      if (JSON.stringify(current) !== JSON.stringify(checked.release)) throw updateError('check-expired')
      env = await ports.readInstalled()
      if (env.installationKey !== checked.installationKey) throw updateError('installation-changed')
      if (!env.eligible || env.blockedReason) throw updateError(env.blockedReason ?? 'update-busy')
      if (ports.backupJob) await ports.backupJob(job)
      await saveJob(job)
      activeJobId = job.id
    } catch (error) {
      await release(job.id)
      throw error
    }
    // 落盘后后台跑，调用方不干等：每秒轮询查状态即可看到进度，关页面不取消。
    void runBackground(job, env).catch(() => {})
    return buildSnapshot(env, job)
  }

  return { status, check, install }
}
