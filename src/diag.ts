/**
 * src/diag.ts —— 电话侧失败证据 diag 落地（#21，承接 #18 契约）。
 *
 * 失败回包加可选内联小证据对象 `diag`：平时面板仍只按稳定码分支与文案映射，
 * 复制诊断按钮用 `diag` 组出一段自包含、可粘贴、已脱敏的文本；日志通道保留用于深挖。
 * `diag` 只增不改、旧面板宽容读（未知键与错类型一律忽略），缺省即省略；
 * 脱敏是构造属性，无安全详情时宁可省略也不给原文。所有失败经一次回包即证据闭包，
 * 不做二次往返；深证据超限再另议，不在本模块内。
 *
 * 19 键目录（第一版 16 键 + #155 翻译官 3 键，线键永不改名）：
 *   v / stage / route / method / httpStatus / exitCode / latencyMs / detail /
 *   targetPackageName / runningVersion / latestVersion / environmentKind /
 *   requestId / checkId / registryHost / action /
 *   causeKind / causePackage / causeUnlockAt（#155：安装失败已知签名的机读结论，
 *   冻结枚举 + 包规格 + 解封毫秒；面板只按 causeKind 枚举分支，不读自由文本）
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
import { causeInterpreter } from './install-cause.js'
import { validReleaseVersion, validRequestId } from './service.js'
import { hash8 } from './hash.js'
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

/** 16 键目录与线类型（面板宽容读的唯一依据）+ #155 翻译官 3 键（共 19 键）。 */
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
  /**
   * 意图哈希（#207）：requestId 的 djb2 八位十六进制，供用户把「复制诊断」里那一次安装
   * 与日志里的 update.install.request / update.install.fail 对上；不落原始编号进日志行。
   */
  intentHash: 'string',
  checkId: 'string',
  registryHost: 'string',
  action: 'string',
  causeKind: 'string',
  causePackage: 'string',
  causeUnlockAt: 'number',
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
  /** 翻译官时钟（毫秒 epoch；#155 解封时间反推用；不给即 Date.now，测试必传）。 */
  nowMs?: unknown
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
  /** 意图哈希（#207）：八位十六进制，等于日志行里的 intentHash 字段。 */
  intentHash?: string
  checkId?: string
  registryHost?: string
  action?: DiagAction
  /** 翻译官结论（#155，仅安装失败已知签名时带；冻结枚举，面板只按它分支）。 */
  causeKind?: string
  /** 肇事包完整规格（如 dshmarket@1.66.28；显示用，归因比对剥版本）。 */
  causePackage?: string
  /** 解封时刻毫秒 epoch（算不出或已过即省略，面板只给无时间版文案）。 */
  causeUnlockAt?: number
  /** 显式截断位（#24）：仅超墙动过手时为 true，否则省略以保持键目录纯净。 */
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

/**
 * 失败原因行前置（#154）：命中失败标记的行按原相对顺序提到最前面，
 * 紧随其后的缩进行（堆栈/明细续行）跟随其所属的原因行；其余行随后。
 * 纯重排（同一输入同一输出），不增删一字；预算截断仍在下游发生。
 * 只认工具输出里常见的失败标记，不猜自然语言。
 */
const CAUSE_LINE_RE =
  /✗|×\s|ERR_[A-Za-z_]+|code\s+[A-Z][A-Z_0-9]+|fail(?:ed|ure)?|error|fatal|panic|not ok|rejected|denied|失败|错误|异常/i

/**
 * 行首 `code:` 前缀剥离（仅分类用，不改输出一字）。
 * 动机：store.ts 的 detailText 把宿主 ManagementError 收成 `operation-error: <原话首行>`，
 * 该前缀自身含 `error` 一词——不剥，它会把进度头 `? Verifying…` 误判成原因行，
 * 真因 `✗ Lockfile failed…` 反而挤到 300 字截断之外（2026-10-17 dsh-prompt 0.4.28→0.4.29 现场）。
 * 只剥一层 `Token:`（宿主码形）；`ERR_*` 机器 token 本身即信号，不剥。
 * 剥完仍命中才是真原因；通用码前缀不单独算信号（ generic 的 failed 不如 ✗ 定位）。
 */
function causeSignalOf(line: string): string {
  try {
    const m = /^\s*([A-Za-z][A-Za-z0-9_.-]*)\s*:\s*/.exec(line)
    if (m && m[1] && !/ERR_/i.test(m[1])) return line.slice(m[0].length)
  } catch {
    /* 坏行即原文分类，不抛 */
  }
  return line
}

function hoistCauseLines(text: string): string {
  try {
    const lines = String(text).split(/\r?\n/)
    if (lines.length < 2) return text
    const cause: string[] = []
    const rest: string[] = []
    let prevIsCause = false
    for (const line of lines) {
      if (CAUSE_LINE_RE.test(causeSignalOf(line))) {
        cause.push(line)
        prevIsCause = true
      } else if (prevIsCause && cause.length > 0 && /^[ \t]+[^ \t]/.test(line)) {
        cause.push(line)
        prevIsCause = true
      } else {
        rest.push(line)
        prevIsCause = false
      }
    }
    if (cause.length === 0 || rest.length === 0) return text
    return [...cause, ...rest].join('\n')
  } catch {
    return text
  }
}

/** 人话摘要格：永远是字符串，压平空白、脱敏、300 字封顶；URL 用户信息只遮盖 userinfo、保留其余原文（#198）。
 * #66 入字典单语（§7.1 20 行，271/273/274 复用电话表 key，其余走 diag.fallback.*）：分支只认稳定码，lang 缺省 zh 零回归。 */
function pickDetail(errorCode: string, error: unknown, httpStatus: number | null, phoneKind?: string, lang?: AppLang | string | null): string | null {
  try {
    const rawDetail = (error as { detail?: unknown })?.detail
    if (typeof rawDetail === 'string' && rawDetail.trim()) {
      // #154：安装执行的工具输出头重脚轻（进度头 + 中部真因 + 尾部噪音），
      // 而预算截断只保头。先把原因行提到前面，其它错误码一律不动。
      const ordered = errorCode === 'install-failed' ? hoistCauseLines(rawDetail) : rawDetail
      const clean = sanitizeDetail(ordered)
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
    else if (code === 'channel-mismatch') key = 'diag.fallback.channel-mismatch'
    else if (code === 'source-install') key = 'diag.fallback.source-install'
    else if (code === 'invalid-installation') key = 'diag.fallback.invalid-installation'
    else if (code === 'installation-changed') key = 'diag.fallback.installation-changed'
    else if (code === 'pending-restart') key = 'diag.fallback.pending-restart'
    else if (code === 'incompatible-node') key = 'diag.fallback.incompatible-node'
    else if (code === 'incompatible-dsh') key = 'diag.fallback.incompatible-dsh'
    else if (code === 'registry-conflict') key = 'diag.fallback.registry-conflict'
    else if (code === 'recovery-required') key = 'diag.fallback.recovery-required'
    else if (code === 'dev-source') key = 'diag.fallback.dev-source'
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
    // #207 意图哈希：与日志行同一个算法（hash8），用户把复制诊断与日志里的同一次安装对上。
    const intentHash = requestId ? hash8(requestId) : null
    let registryHost: string | null = null
    try {
      registryHost = resolveRegistryHost(String(input?.registryUrl ?? ''))
    } catch {
      registryHost = null
    }
    // #155 翻译官：已知签名即附机读结论（认不出即全空，通用老路一字不动；计数进统计口）。
    // 只问 exec：统计口的"未识别"总体应是"尝试安装却没认出来的"，查侧失败不算没认出来。
    // （表里签名自带码×阶段双门；这里的 exec 门只管"问不问"，不管"认不认"。）
    let causeKind: string | null = null
    let causePackage: string | null = null
    let causeUnlockAt: number | null = null
    try {
      const rawDetail = (input?.error as { detail?: unknown } | null | undefined)?.detail
      const rawNowMs = input?.nowMs
      const interpreted =
        stage === 'exec'
          ? causeInterpreter.interpret({
              errorCode,
              stage,
              detail: typeof rawDetail === 'string' ? rawDetail : undefined,
              targetPackageName,
              nowMs: typeof rawNowMs === 'number' ? rawNowMs : undefined,
            })
          : null
      if (interpreted) {
        causeKind = interpreted.kind
        causePackage = interpreted.spec
        causeUnlockAt = typeof interpreted.unlockAtMs === 'number' ? interpreted.unlockAtMs : null
      }
    } catch {
      causeKind = null
      causePackage = null
      causeUnlockAt = null
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
    if (intentHash) diag.intentHash = intentHash
    if (checkId) diag.checkId = checkId
    if (registryHost) diag.registryHost = registryHost
    if (causeKind) diag.causeKind = causeKind
    if (causePackage) diag.causePackage = causePackage
    if (causeUnlockAt !== null) diag.causeUnlockAt = causeUnlockAt
    diag.action = action
    return enforceBudget(diag)
  } catch {
    return undefined
  }
}

/**
 * 序列化 ≤1024 字节墙（#24 单源）：经 redaction.enforceDiagBudget 按序丢弃。
 * truncated 位显式返回：false 即全键原样（删掉该位，保持 #18 目录纯净）；
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
