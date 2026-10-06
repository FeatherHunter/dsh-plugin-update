/**
 * src/diag.ts —— 电话侧失败证据 diag 落地（#21，承接 #18 契约）。
 *
 * 失败回包加可选内联小证据对象 `diag`：平时面板仍只按稳定码分支与文案映射，
 * 复制诊断按钮用 `diag` 组出一段自包含、可粘贴、已脱敏的文本；日志通道保留用于深挖。
 * `diag` 只增不改、旧面板宽容读（未知键与错类型一律忽略），缺省即省略；
 * 脱敏是构造属性，无安全详情时宁可省略也不给原文。所有失败经一次回包即证据闭包，
 * 不做二次往返；深证据超限再另议，不在本模块内。
 *
 * 16 键目录（第一版，线键永不改名）：
 *   v / stage / route / method / httpStatus / exitCode / latencyMs / detail /
 *   targetPackageName / runningVersion / latestVersion / environmentKind /
 *   requestId / checkId / registryHost / action
 * 其余一律易变（面板必须忽略），queuePos 等上游语义落定后再转正——本模块永不产出
 * queuePos（保留未来键，见 STAGE_EXPECT 之外的显式断言）。
 *
 * 阶段枚举冻结并与真实接缝对齐（6 值）：
 *   read-installed（读已装）/ fetch-release（取远端）/ validate-release（校验发行物）/
 *   preflight（装前复核）/ exec（执行）/ verify（装后校验）
 * 路由与方法正交，不拼串。动作提示由包内政策按（阶段×信号）推导
 * （retry / manual / contact / restart），面板只渲染不推导。
 *
 * 缺省即省略（无此格即本阶段不适用或未知），按（阶段×键）期望表断言；
 * 对象版本只管大门（v=1），新增可选键不 bump 版本，面板永不分支于版本。
 * 宽容读契约：未知键忽略、错类型忽略、缺省当正常；面板分支只允许用稳定码。
 *
 * 序列化墙：整个 diag JSON ≤ DIAG_INLINE_BUDGET_BYTES（1024，单源见 redaction.ts）。
 * 按 #24  enforcement 按序丢弃（registryHost → action → 版本 → 其余可选，detail 只截断；
 * action 可省，v/码/阶段/路由/请求编号永不丢）。verify 阶段暂无电话来源（装后校验走后台异步，
 * 不经电话失败回包），枚举保留、电话侧不产出；running/latest 仅已知时带，未知即省略。
 * 构造全程 best-effort：任何一步异常即回 undefined（调用方按无 diag 的旧形状返回，
 * 新面板×旧载荷仍为正常缺省，不抛）。
 */

import { DIAG_INLINE_BUDGET_BYTES, diagByteLength, enforceDiagBudget, resolveRegistryHost, sanitizeDetail } from './redaction.js'
import { validReleaseVersion, validRequestId } from './service.js'
import { copyText, type BilingualKey } from './bilingual.js'
import { normalizeLangTag, type AppLang } from './lang.js'

/** diag 对象版本：只管大门，新增可选键不 bump，面板永不分支于版本。 */
export const DIAG_VERSION = 1

/** 阶段枚举（冻结 6 值，与真实接缝对齐）。 */
export const DIAG_STAGES = [
  'read-installed',
  'fetch-release',
  'validate-release',
  'preflight',
  'exec',
  'verify',
] as const
export type DiagStage = (typeof DIAG_STAGES)[number]

/** 动作提示（冻结 4 值，包内按阶段×信号推导，面板只渲染）。 */
export const DIAG_ACTIONS = ['retry', 'manual', 'contact', 'restart'] as const
export type DiagAction = (typeof DIAG_ACTIONS)[number]

/** 16 键目录与线类型（面板宽容读的唯一依据）。 */
export const DIAG_KNOWN_TYPES: Record<string, 'number' | 'string'> = {
  v: 'number',
  stage: 'string',
  route: 'string',
  method: 'string',
  httpStatus: 'number',
  exitCode: 'number',
  latencyMs: 'number',
  detail: 'string',
  targetPackageName: 'string',
  runningVersion: 'string',
  latestVersion: 'string',
  environmentKind: 'string',
  requestId: 'string',
  checkId: 'string',
  registryHost: 'string',
  action: 'string',
}
export const DIAG_KEYS = Object.keys(DIAG_KNOWN_TYPES)

/** （阶段×键）期望表：期望有 / 期望没有（缺省即省略，异常仅提示不改分支）。 */
export const DIAG_STAGE_EXPECT: Record<DiagStage, { want: string[]; forbid: string[] }> = {
  'read-installed': { want: [], forbid: ['httpStatus', 'exitCode'] },
  'fetch-release': { want: ['httpStatus'], forbid: ['exitCode'] },
  'validate-release': { want: [], forbid: ['httpStatus', 'exitCode'] },
  preflight: { want: [], forbid: ['httpStatus', 'exitCode'] },
  exec: { want: [], forbid: ['httpStatus'] },
  verify: { want: [], forbid: ['httpStatus', 'exitCode'] },
}

export interface DiagInput {
  /** 稳定码（已收敛后的 error 格，如 check-failed / invalid-release / install-failed …）。 */
  errorCode: string
  /** 电话种类：update-status / update-check / update-install（loggedPhone 的 kind）。 */
  phoneKind: string
  /** 原始错误对象（读 httpStatus / exitCode / detail，不读栈）。 */
  error?: unknown
  /** 调用入参（读 requestId / checkId，脏类型一律忽略）。 */
  args?: Record<string, unknown>
  /** 包配置：目标包名与官方源（源主机名只给认可源）。 */
  targetPackageName?: unknown
  registryUrl?: unknown
  /** 已知运行版本（显式覆盖或清单解析值，非版本形状一律省略）。 */
  runningVersion?: unknown
  /** 已知远端版本（失败路径多半未知，未知即省略）。 */
  latestVersion?: unknown
  /** 宿主种类（显式覆盖值，三取值之外一律省略）。 */
  environmentKind?: unknown
  /** 本次电话耗时毫秒（只收有限非负数）。 */
  latencyMs?: unknown
  /** 人话兜底渲染语言（#66 单语：缺省 zh 零回归；电话侧无 DOM 信号时仍落 zh，面板侧 free-text 英文混入属正常见 #57 v2 非目标）。 */
  lang?: AppLang | string | null
}

export interface DiagObject {
  v: number
  stage: DiagStage
  /** 路由与方法正交；exec 在宿主种类未知时省略（不猜，缺省即省略）。 */
  route?: string
  method?: string
  httpStatus?: number
  exitCode?: number
  latencyMs?: number
  detail?: string
  targetPackageName?: string
  runningVersion?: string
  latestVersion?: string
  environmentKind?: string
  requestId?: string
  checkId?: string
  registryHost?: string
  action?: DiagAction
  /** 显式截断位（#24）：仅超墙动过手时为 true，否则省略以保持 16 键纯净。 */
  truncated?: boolean
}

function isStage(v: unknown): v is DiagStage {
  return typeof v === 'string' && (DIAG_STAGES as readonly string[]).includes(v)
}

function isAction(v: unknown): v is DiagAction {
  return typeof v === 'string' && (DIAG_ACTIONS as readonly string[]).includes(v)
}

/**
 * 阶段推导（第一性原理：阶段 = 哪道接缝挂了，由电话 × 码共同定位，不单看码）。
 * - update-status 只读本地：一切失败归 read-installed（从不执行安装，install-failed 在此亦为读失败）。
 * - update-check 两段：取数失败归 fetch-release，校验失败归 validate-release，其余环境失败归 read-installed。
 * - update-install 三段：安装执行失败归 exec，取数重验失败归 fetch/validate，其余（含凭证/队列/环境）归 preflight。
 * verify 暂无电话来源（装后校验走后台异步，不经电话失败回包），此处永不返回 verify。
 */
export function deriveStage(errorCode: string, phoneKind: string): DiagStage {
  const code = String(errorCode || '')
  if (phoneKind === 'update-status') return 'read-installed'
  if (phoneKind === 'update-check') {
    if (code === 'check-failed' || code === 'internal') return 'fetch-release'
    if (code === 'invalid-release') return 'validate-release'
    return 'read-installed'
  }
  // update-install（含未知 kind 的兜底：按安装上下文解）。
  if (code === 'install-failed') return 'exec'
  if (code === 'check-failed' || code === 'internal') return 'fetch-release'
  if (code === 'invalid-release') return 'validate-release'
  return 'preflight'
}

/**
 * 路由与方法正交（不拼串，各自独立断言）。
 * - 取数/校验：registry/https；读已装/装后校验：disk/fs。
 * - preflight：仅 update-busy 走 queue/fs（队列即公平门），其余（凭证/环境）走 disk/fs。
 * - exec：路由即真实安装路由（由宿主种类定），方法为传输形态；宿主种类未知时省略（不猜）。
 */
export function deriveRouteMethod(
  stage: DiagStage,
  environmentKind: unknown,
  errorCode?: string,
): { route?: string; method?: string } {
  if (stage === 'fetch-release' || stage === 'validate-release') return { route: 'registry', method: 'https' }
  if (stage === 'read-installed' || stage === 'verify') return { route: 'disk', method: 'fs' }
  if (stage === 'preflight') {
    if (String(errorCode || '') === 'update-busy') return { route: 'queue', method: 'fs' }
    return { route: 'disk', method: 'fs' }
  }
  // exec：路由即真实安装路由（由宿主种类定），方法为传输形态；未知种类省略，不猜 cli-process。
  const kind = String(environmentKind || '')
  if (kind === 'desktop-manager') return { route: 'desktop-manager', method: 'phone' }
  if (kind === 'desktop') return { route: 'desktop-service', method: 'service' }
  if (kind === 'cli') return { route: 'cli-process', method: 'spawn' }
  return {}
}

/** 动作提示包内推导（面板只渲染，不自写状态码分支）。 */
export function deriveAction(stage: DiagStage, errorCode: string): DiagAction {
  const code = String(errorCode || '')
  if (code === 'pending-restart' || stage === 'verify') return 'restart'
  if (code === 'install-failed' || stage === 'exec') return 'contact'
  if (code === 'invalid-release' || stage === 'validate-release') return 'manual'
  if (code === 'check-expired') return 'manual'
  if (code === 'update-busy') return 'retry'
  if (code === 'check-failed' || code === 'internal') return 'retry'
  if (stage === 'fetch-release') return 'retry'
  return 'manual'
}

function pickHttpStatus(stage: DiagStage, error: unknown): number | null {
  if (DIAG_STAGE_EXPECT[stage].forbid.includes('httpStatus')) return null
  const raw = (error as { httpStatus?: unknown })?.httpStatus
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 100 && raw <= 599) return raw
  // 兼容：fetch 实现若把 status 挂在 response 上，service 层已转交此处只认 httpStatus；
  // 此处不猜其它形状，未知即省略。
  return null
}

function pickExitCode(stage: DiagStage, error: unknown): number | null {
  if (DIAG_STAGE_EXPECT[stage].forbid.includes('exitCode')) return null
  const raw = (error as { exitCode?: unknown })?.exitCode
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw
  return null
}

function pickLatencyMs(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null
  return Math.floor(raw)
}

function pickVersion(raw: unknown): string | null {
  // 版本只收发行合法形（stable 纯三段或 prerelease）：令牌/路径/邮箱形一律省略，
  // 调用方误传不透明串当版本时不把它写进载荷（宁可省略，不造可疑原文）。
  if (typeof raw !== 'string' || !raw) return null
  const t = raw.trim()
  if (!t) return null
  return validReleaseVersion(t) ? t : null
}

function pickPackageName(raw: unknown): string | null {
  // 包名只收 npm 名形（小写作用域可选）：含空格/等号/冒号/令牌形的调用方误传一律省略。
  if (typeof raw !== 'string' || !raw) return null
  const t = raw.trim()
  if (!t || t.length > 256) return null
  if (/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(t)) return t
  return null
}

function pickEnvironmentKind(raw: unknown): string | null {
  return raw === 'desktop' || raw === 'desktop-manager' || raw === 'cli' ? String(raw) : null
}

function pickId(raw: unknown): string | null {
  // 请求/检查编号正是要放进诊断块的外部可控值：只收不透明编号形状（同 validRequestId），
  // 路径·令牌·邮箱·键值对·URL 形状一律省略（按凭证过期处理，不把秘密带进载荷）。
  return typeof raw === 'string' && validRequestId(raw) ? raw.trim() : null
}

/** 人话摘要格：永远是字符串，压平空白、脱敏、300 字封顶；命中 URL 用户信息即整项丢弃（回空=省略）。
 * #66 入字典单语（§7.1 18 行，271/273/274 复用电话表 key，其余走 diag.fallback.*）：分支只认稳定码，lang 缺省 zh 零回归。 */
function pickDetail(errorCode: string, error: unknown, httpStatus: number | null, phoneKind?: string, lang?: AppLang | string | null): string | null {
  try {
    const rawDetail = (error as { detail?: unknown })?.detail
    if (typeof rawDetail === 'string' && rawDetail.trim()) {
      const clean = sanitizeDetail(rawDetail)
      return clean ? clean : null
    }
    const rawMessage = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
    // updateError 的 message 恒为码本身（如 'check-failed'），此时不拿它当人话，改用按码合成。
    const msg = typeof rawMessage === 'string' ? rawMessage.trim() : ''
    const isBareCode = msg && /^[a-z][a-z-]*$/.test(msg) && msg.length <= 32
    if (msg && !isBareCode) {
      const clean = sanitizeDetail(msg)
      if (clean) return clean
    }
    const code = String(errorCode || '')
    const phone = String(phoneKind || '')
    const l = normalizeLangTag(lang ?? 'zh')
    let key: BilingualKey = 'diag.fallback.generic'
    let values: Record<string, unknown> | undefined
    if (code === 'check-failed' && phone === 'update-status') key = 'diag.fallback.read-installed'
    else if ((code === 'check-failed' || code === 'internal') && phone === 'update-install') key = 'diag.fallback.revalidate-fetch'
    else if (code === 'check-failed' && httpStatus === 429) key = 'diag.fallback.rate-limited'
    else if (code === 'check-failed' && typeof httpStatus === 'number') { key = 'diag.fallback.http-status'; values = { status: String(httpStatus) } }
    else if (code === 'check-failed' || code === 'internal') key = 'panel.failure.check-failed.title'
    else if (code === 'invalid-release') key = 'diag.fallback.invalid-release'
    else if (code === 'check-expired') key = 'panel.failure.check-expired.title'
    else if (code === 'update-busy') key = 'panel.failure.update-busy.title'
    else if (code === 'install-failed') key = 'diag.fallback.install-failed'
    else if (code === 'unknown-profile') key = 'diag.fallback.unknown-profile'
    else if (code === 'source-install') key = 'diag.fallback.source-install'
    else if (code === 'invalid-installation') key = 'diag.fallback.invalid-installation'
    else if (code === 'installation-changed') key = 'diag.fallback.installation-changed'
    else if (code === 'pending-restart') key = 'diag.fallback.pending-restart'
    else if (code === 'incompatible-node') key = 'diag.fallback.incompatible-node'
    else if (code === 'registry-conflict') key = 'diag.fallback.registry-conflict'
    else if (code === 'recovery-required') key = 'diag.fallback.recovery-required'
    let fallback: string
    try { fallback = copyText(key, l, values) } catch { fallback = copyText('diag.fallback.generic', 'zh') }
    const clean = sanitizeDetail(fallback)
    return clean ? clean : null
  } catch {
    return null
  }
}

function byteLength(text: string): number {
  try {
    return diagByteLength(text)
  } catch {
    return text.length
  }
}

/**
 * 组装 diag（best-effort：任何异常回 undefined，调用方按无 diag 的旧形状返回）。
 * 永不产出 queuePos；类型恒对；缺省即省略。
 */
export function buildDiag(input: DiagInput): DiagObject | undefined {
  try {
    const errorCode = String(input?.errorCode || '')
    if (!errorCode) return undefined
    const phoneKind = String(input?.phoneKind || '')
    const stage = deriveStage(errorCode, phoneKind)
    if (!isStage(stage)) return undefined
    const { route, method } = deriveRouteMethod(stage, input?.environmentKind, errorCode)
    const action = deriveAction(stage, errorCode)
    if (!isAction(action)) return undefined
    const httpStatus = pickHttpStatus(stage, input?.error)
    const exitCode = pickExitCode(stage, input?.error)
    const latencyMs = pickLatencyMs(input?.latencyMs)
    const detail = pickDetail(errorCode, input?.error, httpStatus, phoneKind, (input as { lang?: AppLang | string | null })?.lang ?? 'zh')
    const targetPackageName = pickPackageName(input?.targetPackageName)
    const runningVersion = pickVersion(input?.runningVersion)
    const latestVersion = pickVersion(input?.latestVersion)
    const environmentKind = pickEnvironmentKind(input?.environmentKind)
    const args = input?.args && typeof input.args === 'object' ? (input.args as Record<string, unknown>) : {}
    const requestId = pickId(args['requestId'])
    const checkId = pickId(args['checkId'])
    let registryHost: string | null = null
    try {
      registryHost = resolveRegistryHost(String(input?.registryUrl ?? ''))
    } catch {
      registryHost = null
    }
    const diag: DiagObject = { v: DIAG_VERSION, stage }
    if (route) diag.route = route
    if (method) diag.method = method
    if (httpStatus !== null) diag.httpStatus = httpStatus
    if (exitCode !== null) diag.exitCode = exitCode
    if (latencyMs !== null) diag.latencyMs = latencyMs
    if (detail) diag.detail = detail
    if (targetPackageName) diag.targetPackageName = targetPackageName
    if (runningVersion) diag.runningVersion = runningVersion
    if (latestVersion) diag.latestVersion = latestVersion
    if (environmentKind) diag.environmentKind = environmentKind
    if (requestId) diag.requestId = requestId
    if (checkId) diag.checkId = checkId
    if (registryHost) diag.registryHost = registryHost
    diag.action = action
    return enforceBudget(diag)
  } catch {
    return undefined
  }
}

/**
 * 序列化 ≤1024 字节墙（#24 单源）：经 redaction.enforceDiagBudget 按序丢弃。
 * truncated 位显式返回：false 即 16 键原样（删掉该位，保持 #18 目录纯净）；
 * true 即超墙动过手（保留该位，面板宽容读忽略它，旧面板剥掉 diag 仍逐字不变）。
 * 仍超（理论上不可能，永不丢键兜底）则回 undefined 按无 diag 处理。
 */
export function enforceBudget(diag: DiagObject): (DiagObject & { truncated?: boolean }) | undefined {
  try {
    const out = enforceDiagBudget(diag as unknown as Record<string, unknown>) as unknown as DiagObject & { truncated: boolean }
    if (!out || typeof out !== 'object') return undefined
    if (out.truncated === true) return out as DiagObject & { truncated: boolean }
    const clean = { ...(out as unknown as Record<string, unknown>) }
    delete clean['truncated']
    try {
      if (diagByteLength(clean) > DIAG_INLINE_BUDGET_BYTES) return undefined
    } catch {
      return undefined
    }
    return clean as unknown as DiagObject
  } catch {
    return undefined
  }
}

// 显式使用共享预算常量（tree-shake 友好，避免“导入未用”漂移）。
void DIAG_INLINE_BUDGET_BYTES
