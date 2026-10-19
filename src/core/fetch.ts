/**
 * src/core/fetch.ts —— 联网取数（#163 registry 从 service.ts 独立）。
 *
 * 四个取数函数＋取数常量＋取数小工具：问官方源 latest 文档、版本文档、全量包文档时间表，
 * 以及在通道内挑最高发行版（#183 的 `/latest` 回退）。
 * 只依赖判定核（core/judgment.ts，叶子）与 ports 类型；core/service.ts 留垫片 re-export，行为零变化。
 */

import type {
  FetchImpl,
  MinimalResponse,
  ReleaseInfo,
  UpdateErrorCode,
  UpdateLogPort,
} from '../shared/ports.js'
import { CHECK_FAIL_CAUSE_KEY, type CheckErrorKind } from './conclusion.js'
import {
  compareReleaseVersions,
  isVersionAllowedInChannel,
  updateError,
  validReleaseVersion,
} from './judgment.js'
import type { ReleaseChannel } from './judgment.js'

export const PACKAGE_NAME = 'dsh-mattpocock-skills-deck'
export const NPM_REGISTRY = 'https://registry.npmjs.org/'
export const CHECK_TIMEOUT_MS = 10_000
export const MAX_METADATA_BYTES = 256 * 1024
/**
 * 全量包文档的字节墙（#R3 对抗审查）：latest / 版本文档天生小（256KB 足够），
 * 但 packument 会随版本数线性长大——真实包里 dsh-prompt 已 314KB、`@xmanrui/dsh-im` 458KB，
 * 用同一个 256KB 墙会把「合规版候选」这条路对真实包永久打死（探针复现）。
 * 这条给读全量包文档的两个口用（`fetchPackumentTimes` 与 `fetchNpmChannelRelease`），
 * 其余两个取数口仍是 256KB。
 */
const MAX_PACKUMENT_BYTES = 4 * 1024 * 1024
export const INTEGRITY_PATTERN = '^sha512-[A-Za-z0-9+/]{86}==$'

/** 取数阶段（#124）：`update.check.fail.stage` 与 `update.registry.fetch` 的定位用，四个合法值。 */
export type FetchStage = 'fetch' | 'compare' | 'channel' | 'verify'

/**
 * 源地址归一（#R5 对抗审查）：配置里漏了结尾斜杠时，裸拼会得到
 * `https://registry.npmjs.orgdsh-plugin-update/latest`（主机名被吃掉）；带路径的私有源同理会拼错。
 * 取数口统一在这里补一个斜杠——调用方给什么都只补不猜，不改协议/主机/路径。
 */
function normalizeRegistry(raw: string | undefined, fallback: string): string {
  const value = typeof raw === 'string' && raw.trim() ? raw.trim() : fallback
  return value.endsWith('/') ? value : `${value}/`
}

/**
 * 发行包地址的**唯一**形状判据（#R1 对抗审查）：npm 对 scoped 包把 tarball 放在
 * `/<scope>/<name>/-/<basename>-<version>.tgz`——路径里的最后一个名字段不带 scope，
 * 文件名也不带。原先两处都用 `/${targetName}/-/${targetName}-${version}.tgz` 内联比较，
 * 于是 `@xmanrui/dsh-im` 这类包永远被误判成 invalid-release（真实 registry 黑箱复现）。
 */
function tarballPathnameOf(targetName: string, version: string): string {
  const base = targetName.slice(targetName.lastIndexOf('/') + 1)
  return `/${targetName}/-/${base}-${version}.tgz`
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
  // 细类别（#211）：拿到了 HTTP 应答但不可用，统一按 http（没状态码的假件也算 HTTP 层拒绝）。
  return withKind(err, 'http')
}

/** 通道门拒绝（#124 stage=channel + #211 errorKind=channel）：公开码仍是 invalid-release。 */
function channelReject(): Error & { code: UpdateErrorCode } {
  return withKind(withStage(updateError('invalid-release'), 'channel'), 'channel')
}

/**
 * 读正文 JSON（#211）：解析失败打 bad-json 标签，公开码仍是 invalid-release（行为一字不动）。
 * 已连上但正文不是 JSON，是「远端给的东西坏了」这一类事实，与网络断掉分开记。
 */
function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw withKind(updateError('invalid-release'), 'bad-json')
  }
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
 * 给错误贴「失败细类别」（#211，审查 S2-3）：不可枚举属性——错误码、消息与既有 detail
 * 形状一字不动，细分类只进 `update.check.fail.errorKind`（公开回执仍按稳定码走）。
 */
function withKind<T extends Error>(error: T, kind: CheckErrorKind): T {
  try {
    Object.defineProperty(error, CHECK_FAIL_CAUSE_KEY, {
      value: kind,
      enumerable: false,
      configurable: true,
      writable: true,
    })
  } catch {
    /* 冻结对象等怪情况：贴不上就按 unknown 兜底，绝不改取数行为 */
  }
  return error
}

/**
 * 联网失败细分类（#211）：只落现场能证实的事实（超时名 / 系统错误码 / 错误链首因），
 * 原始错误文本绝不进日志。走到这里的都是 fetch 本身抛错，认不出至少是 network。
 */
function fetchFailureKind(error: unknown): CheckErrorKind {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const node = current as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown }
    const name = typeof node.name === 'string' ? node.name : ''
    // AbortSignal.timeout 的中断在 Node 里可能以 TimeoutError 或 AbortError 两种名字出现。
    if (name === 'TimeoutError' || name === 'AbortError') return 'timeout'
    const code = typeof node.code === 'string' ? node.code : ''
    if (code) {
      if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'timeout'
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code.startsWith('EAI_')) return 'dns'
      if (/^(?:CERT_|ERR_TLS_|ERR_SSL_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_)/.test(code)) return 'tls'
    }
    const message = typeof node.message === 'string' ? node.message : ''
    if (/getaddrinfo|ENOTFOUND|EAI_AGAIN/.test(message)) return 'dns'
    if (/certificate|CERT_|TLS|SSL/i.test(message)) return 'tls'
    current = node.cause
  }
  return 'network'
}

/**
 * 取数打点器（#124）：`update.registry.fetch` 的唯一落点。只记状态码、耗时与白名单主机名，
 * 不带 URL、不带账号（ADR-0001 规则 3）；没给发射口就什么也不做（默认等于现状）。
 *
 * `cacheHit` 这一格不发：本包的缓存命中发生在取数之前（命中就根本不取数，也就不发这行），
 * 到了取数点就是未命中——发一个恒为 false 的格子只是噪声（接线结论记在事件目录里）。
 *
 * #211：changelog-io 取 tarball 也复用这一台打点器（同一行语义），所以导出。
 */
export function makeFetchNoter(
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
    /**
     * 通道不符时是否把版本原样交回（#183，可选，仅检查路径用）。
     * 缺省 false：远端 latest 不被本通道接受就按「版本信息无效 + stage=channel」抛，
     * 这是取数口的旧纪律。检查路径在「已装版本本身就不在本通道」时必须容忍——
     * 那次报错的真正结论是 channel-mismatch（读取器已算出来），不是取数失败；
     * 否则缺省 stable 遇到 latest 是预发布时，面板连「通道不符」都说不出，只剩 check-failed。
     */
    tolerateOutOfChannel?: boolean
  },
): Promise<ReleaseInfo> {
  const targetName = opts?.targetPackageName ?? PACKAGE_NAME
  const registry = normalizeRegistry(opts?.registryUrl, NPM_REGISTRY)
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
  } catch (error) {
    noteFetch(null, startedAt)
    throw withKind(updateError('check-failed'), fetchFailureKind(error))
  }
  noteFetch(httpStatusOf(response), startedAt)
  try {
    if (!response.ok) throw checkFailedWithStatus(response)
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_METADATA_BYTES) throw withKind(updateError('invalid-release'), 'too-large')
    let text: string
    try {
      text = await response.text()
    } catch {
      // 已连上但读正文断了（#211）：按网络层事实记，公开码仍是 invalid-release。
      throw withKind(updateError('invalid-release'), 'network')
    }
    if (byteLength(text) > MAX_METADATA_BYTES) throw withKind(updateError('invalid-release'), 'too-large')
    const value = parseJsonBody(text) as {
      name?: unknown
      version?: unknown
      engines?: { node?: unknown; dsh?: unknown }
      dist?: { tarball?: unknown; integrity?: unknown }
    }
    if (value.name !== targetName) throw withKind(updateError('invalid-release'), 'shape')
    // 通道门单独贴 stage（#124）：远端版本不被本通道接受，是「通道判定」不是「版本信息坏掉」。
    // #183：只有检查路径在「已装版本也不在本通道」时会要求容忍——把版本原样交回，
    // 让通道结论由读取器/快照层如实说出；其余形状校验照旧（容忍不等于放宽信任）。
    if (!isVersionAllowedInChannel(value.version, channel)) {
      if (opts?.tolerateOutOfChannel !== true) throw channelReject()
      if (!validReleaseVersion(value.version)) throw withKind(updateError('invalid-release'), 'shape')
    }
    const version = value.version
    const nodeRange = value.engines?.node
    if (nodeRange !== undefined && typeof nodeRange !== 'string') throw withKind(updateError('invalid-release'), 'shape')
    // #195：远端包的 DSH 运行时要求（engines.dsh）。只取声明，不在这里判定——
    // 判定需要「当前 DSH 版本」，那由检查层在拿得到时做；拿不到就不猜。
    const dshRange = value.engines?.dsh
    if (dshRange !== undefined && typeof dshRange !== 'string') throw withKind(updateError('invalid-release'), 'shape')
    const tarballText = value.dist?.tarball
    const integrity = value.dist?.integrity
    let tarball: URL
    try {
      tarball = new URL(String(tarballText))
    } catch {
      throw withKind(updateError('invalid-release'), 'shape')
    }
    const registryOrigin = new URL(registry).origin
    const shapeOk =
      tarball.origin === registryOrigin &&
      !tarball.username &&
      !tarball.password &&
      !tarball.search &&
      !tarball.hash &&
      tarball.pathname.endsWith(tarballPathnameOf(targetName, version)) &&
      typeof integrity === 'string' &&
      new RegExp(INTEGRITY_PATTERN).test(integrity)
    if (!shapeOk) throw withKind(updateError('invalid-release'), 'shape')
    return {
      version,
      nodeRange: typeof nodeRange === 'string' ? nodeRange : '*',
      dshRange: typeof dshRange === 'string' ? dshRange : '*',
      integrity,
      tarball: tarball.href,
    }
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
  const registry = normalizeRegistry(opts?.registryUrl, NPM_REGISTRY)
  const channel: ReleaseChannel = opts?.releaseChannel === 'prerelease' ? 'prerelease' : 'stable'
  const version = opts?.version
  const noteFetch = makeFetchNoter(opts?.emitLog, opts?.registryHost)
  if (typeof version !== 'string' || !validReleaseVersion(version) || !isVersionAllowedInChannel(version, channel)) {
    throw channelReject()
  }
  let response: MinimalResponse | null = null
  const startedAt = Date.now()
  try {
    response = await fetchImpl(`${registry}${encodeURIComponent(targetName)}/${encodeURIComponent(version)}`, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: timeoutSignal(timeoutMs),
    })
  } catch (error) {
    noteFetch(null, startedAt)
    throw withKind(updateError('check-failed'), fetchFailureKind(error))
  }
  noteFetch(httpStatusOf(response), startedAt)
  try {
    if (!response.ok) throw checkFailedWithStatus(response)
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_METADATA_BYTES) throw withKind(updateError('invalid-release'), 'too-large')
    let text: string
    try {
      text = await response.text()
    } catch {
      // 已连上但读正文断了（#211）：按网络层事实记，公开码仍是 invalid-release。
      throw withKind(updateError('invalid-release'), 'network')
    }
    if (byteLength(text) > MAX_METADATA_BYTES) throw withKind(updateError('invalid-release'), 'too-large')
    const value = parseJsonBody(text) as {
      name?: unknown
      version?: unknown
      engines?: { node?: unknown; dsh?: unknown }
      dist?: { tarball?: unknown; integrity?: unknown }
    }
    if (value.name !== targetName || value.version !== version) throw withKind(updateError('invalid-release'), 'shape')
    // 通道门单独贴 stage（#124）与细类别（#211）：与 fetchNpmRelease 同一口径。
    if (!isVersionAllowedInChannel(value.version, channel)) {
      throw channelReject()
    }
    const nodeRange = value.engines?.node
    if (nodeRange !== undefined && typeof nodeRange !== 'string') throw withKind(updateError('invalid-release'), 'shape')
    // #195：同 fetchNpmRelease——只取声明（engines.dsh），判定留给检查层。
    const dshRange = value.engines?.dsh
    if (dshRange !== undefined && typeof dshRange !== 'string') throw withKind(updateError('invalid-release'), 'shape')
    const tarballText = value.dist?.tarball
    const integrity = value.dist?.integrity
    let tarball: URL
    try {
      tarball = new URL(String(tarballText))
    } catch {
      throw withKind(updateError('invalid-release'), 'shape')
    }
    const registryOrigin = new URL(registry).origin
    const shapeOk =
      tarball.origin === registryOrigin &&
      !tarball.username &&
      !tarball.password &&
      !tarball.search &&
      !tarball.hash &&
      tarball.pathname.endsWith(tarballPathnameOf(targetName, version)) &&
      typeof integrity === 'string' &&
      new RegExp(INTEGRITY_PATTERN).test(integrity)
    if (!shapeOk) throw withKind(updateError('invalid-release'), 'shape')
    return {
      version,
      nodeRange: typeof nodeRange === 'string' ? nodeRange : '*',
      dshRange: typeof dshRange === 'string' ? dshRange : '*',
      integrity,
      tarball: tarball.href,
    }
  } catch (error) {
    if ((error as { code?: unknown })?.code === 'check-failed') throw error
    if ((error as { code?: unknown })?.code === 'invalid-release') throw error
    if (response !== null && response.ok) throw updateError('invalid-release')
    throw checkFailedWithStatus(response)
  }
}

/**
 * 取全量包文档里的时间表（#156 合规版决议用：`dist-tags.latest` + `time`）。
 *
 * 与 fetchNpmRelease 同一信任根、同一字节墙（256KB）：只接受名字对得上、
 * latest 合法、time 条目时间可解析的返回；名字对不上/latest 非法即版本信息无效。
 * time 只收"版本号 → ISO 时间"的有效条目，坏条目忽略（不整表作废）——决议层还会再验。
 * 注意：精简版文档（abbreviated）没有 time 表，必须取完整包文档。
 */
export async function fetchPackumentTimes(
  fetchImpl: FetchImpl,
  timeoutMs: number = CHECK_TIMEOUT_MS,
  opts?: {
    targetPackageName?: string
    registryUrl?: string
    emitLog?: UpdateLogPort
    registryHost?: string | null
  },
): Promise<{ latest: string; times: Record<string, number> }> {
  const targetName = opts?.targetPackageName ?? PACKAGE_NAME
  const registry = normalizeRegistry(opts?.registryUrl, NPM_REGISTRY)
  const noteFetch = makeFetchNoter(opts?.emitLog, opts?.registryHost)
  let response: MinimalResponse | null = null
  const startedAt = Date.now()
  try {
    response = await fetchImpl(`${registry}${encodeURIComponent(targetName)}`, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: timeoutSignal(timeoutMs),
    })
  } catch (error) {
    noteFetch(null, startedAt)
    throw withKind(updateError('check-failed'), fetchFailureKind(error))
  }
  noteFetch(httpStatusOf(response), startedAt)
  try {
    if (!response.ok) throw checkFailedWithStatus(response)
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_PACKUMENT_BYTES) throw withKind(updateError('invalid-release'), 'too-large')
    let text: string
    try {
      text = await response.text()
    } catch {
      // 已连上但读正文断了（#211）：按网络层事实记，公开码仍是 invalid-release。
      throw withKind(updateError('invalid-release'), 'network')
    }
    if (byteLength(text) > MAX_PACKUMENT_BYTES) throw withKind(updateError('invalid-release'), 'too-large')
    const value = parseJsonBody(text) as {
      name?: unknown
      'dist-tags'?: { latest?: unknown }
      time?: unknown
    }
    if (value.name !== targetName) throw withKind(updateError('invalid-release'), 'shape')
    const latest = value['dist-tags']?.latest
    if (!validReleaseVersion(latest)) throw withKind(updateError('invalid-release'), 'shape')
    const times: Record<string, number> = {}
    if (value.time && typeof value.time === 'object') {
      for (const [version, stamp] of Object.entries(value.time as Record<string, unknown>)) {
        try {
          if (!validReleaseVersion(version) || typeof stamp !== 'string' || !stamp.trim()) continue
          const ms = Date.parse(stamp.trim())
          if (Number.isFinite(ms) && ms > 0) times[version] = ms
        } catch {
          /* 坏条目忽略，继续收好的 */
        }
      }
    }
    return { latest, times }
  } catch (error) {
    if ((error as { code?: unknown })?.code === 'check-failed') throw error
    if ((error as { code?: unknown })?.code === 'invalid-release') throw error
    if (response !== null && response.ok) throw updateError('invalid-release')
    throw checkFailedWithStatus(response)
  }
}

/**
 * 从全量包文档里挑「本通道最新发行版」（#183 剩余子项，2026-10-18）。
 *
 * 为什么需要它：`dist-tags.latest` 可能指向预发布版本（默认目标 deck 真机就是这样），
 * 而 stable 通道只认纯三段版本号——只问 `/latest` 永远拿不到「本通道的最新版」。检查路径
 * 遇到「latest 不在本通道、但已装版本在通道内」时退回这里：取全量包文档，在本通道允许的
 * 版本里挑最高发行版。于是：
 * - 本通道有更新的发行版 → 正常给出更新（可装）；
 * - 本通道没有更新（远端最新的只是预发布）→ 诚实呈现本通道已是最新，不再整次 check-failed；
 * - 全量包文档取不到/校验不过 → 如实抛（取数失败照旧大声失败，绝不悄悄画成已是最新）。
 *
 * 与 fetchNpmRelease 同一信任根：名字要对得上，每个版本条目各自过通道门、包地址形状与
 * 完整性校验；坏条目与被标记 `deprecated` 的条目逐条跳过（不整表作废、也不把被撤回/弃用
 * 的发行版当成本通道最新），一个通道内条目都收不到即
 * `invalid-release(stage=channel)`。字节墙用包文档墙（4MB），与 `fetchPackumentTimes` 同一理由。
 */
export async function fetchNpmChannelRelease(
  fetchImpl: FetchImpl,
  timeoutMs: number = CHECK_TIMEOUT_MS,
  opts?: {
    targetPackageName?: string
    registryUrl?: string
    releaseChannel?: ReleaseChannel
    emitLog?: UpdateLogPort
    registryHost?: string | null
  },
): Promise<ReleaseInfo> {
  const targetName = opts?.targetPackageName ?? PACKAGE_NAME
  const registry = normalizeRegistry(opts?.registryUrl, NPM_REGISTRY)
  const channel: ReleaseChannel = opts?.releaseChannel === 'prerelease' ? 'prerelease' : 'stable'
  const noteFetch = makeFetchNoter(opts?.emitLog, opts?.registryHost)
  let response: MinimalResponse | null = null
  const startedAt = Date.now()
  try {
    response = await fetchImpl(`${registry}${encodeURIComponent(targetName)}`, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: timeoutSignal(timeoutMs),
    })
  } catch (error) {
    noteFetch(null, startedAt)
    throw withKind(updateError('check-failed'), fetchFailureKind(error))
  }
  noteFetch(httpStatusOf(response), startedAt)
  try {
    if (!response.ok) throw checkFailedWithStatus(response)
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_PACKUMENT_BYTES) throw withKind(updateError('invalid-release'), 'too-large')
    let text: string
    try {
      text = await response.text()
    } catch {
      // 已连上但读正文断了（#211）：按网络层事实记，公开码仍是 invalid-release。
      throw withKind(updateError('invalid-release'), 'network')
    }
    if (byteLength(text) > MAX_PACKUMENT_BYTES) throw withKind(updateError('invalid-release'), 'too-large')
    const value = parseJsonBody(text) as { name?: unknown; versions?: unknown }
    if (value.name !== targetName) throw withKind(updateError('invalid-release'), 'shape')
    const versions = value.versions
    if (!versions || typeof versions !== 'object') throw withKind(updateError('invalid-release'), 'shape')
    const registryOrigin = new URL(registry).origin
    let best: ReleaseInfo | null = null
    for (const [version, raw] of Object.entries(versions as Record<string, unknown>)) {
      // 每个版本条目独立校验：坏条目跳过（不整表作废），全坏才算版本信息无效。
      if (!validReleaseVersion(version) || !isVersionAllowedInChannel(version, channel)) continue
      if (!raw || typeof raw !== 'object') continue
      const doc = raw as {
        deprecated?: unknown
        engines?: { node?: unknown; dsh?: unknown }
        dist?: { tarball?: unknown; integrity?: unknown }
      }
      // 已弃用的发行版不参与挑选：撤回/弃用的版本不该被当成「本通道最新」推给用户。
      if (typeof doc.deprecated === 'string' && doc.deprecated.trim()) continue
      const nodeRange = doc.engines?.node
      if (nodeRange !== undefined && typeof nodeRange !== 'string') continue
      const dshRange = doc.engines?.dsh
      if (dshRange !== undefined && typeof dshRange !== 'string') continue
      const integrity = doc.dist?.integrity
      if (typeof integrity !== 'string' || !new RegExp(INTEGRITY_PATTERN).test(integrity)) continue
      let tarball: URL
      try {
        tarball = new URL(String(doc.dist?.tarball))
      } catch {
        continue
      }
      const shapeOk =
        tarball.origin === registryOrigin &&
        !tarball.username &&
        !tarball.password &&
        !tarball.search &&
        !tarball.hash &&
        tarball.pathname.endsWith(tarballPathnameOf(targetName, version))
      if (!shapeOk) continue
      const release: ReleaseInfo = {
        version,
        nodeRange: typeof nodeRange === 'string' ? nodeRange : '*',
        dshRange: typeof dshRange === 'string' ? dshRange : '*',
        integrity,
        tarball: tarball.href,
      }
      if (!best) {
        best = release
        continue
      }
      try {
        if (compareReleaseVersions(version, best.version) === 1) best = release
      } catch {
        /* 版本形状已校验过；比较异常即放弃这条，保住已选中的 */
      }
    }
    if (!best) throw channelReject()
    return best
  } catch (error) {
    if ((error as { code?: unknown })?.code === 'check-failed') throw error
    if ((error as { code?: unknown })?.code === 'invalid-release') throw error
    if (response !== null && response.ok) throw updateError('invalid-release')
    throw checkFailedWithStatus(response)
  }
}
