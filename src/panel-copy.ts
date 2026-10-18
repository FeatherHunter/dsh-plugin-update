/**
 * src/panel-copy.ts —— 面板文案簇（#166 第三刀：从 panel.ts 独立）。
 *
 * 阻塞/失败文案＋诊断复制文本＋容错读：改文案只碰这里，不翻面板大文件。
 * 只依赖叶子模块（bilingual/codes/install-cause/lang/redaction）与 ports 类型；
 * panel.ts 留垫片 re-export，老位置零变化。
 */

import { copyText, type BilingualKey } from './bilingual.js'
import { INTERNAL_CODE, isCheckSideFailureCode, type PhoneFailureCode } from './codes.js'
import { blameCausePackage, CAUSE_KINDS, formatUnlockAt, interpretInstallCause } from './install-cause.js'
import { normalizeLangTag, type AppLang } from './lang.js'
import { COPY_BUDGET_CHARS, sanitizeForCopy } from './redaction.js'
import type { BlockedReason } from './ports.js'

// ---------- 状态与失败文案（#61 起全部出自集中字典，单语渲染；分支只认稳定码） ----------
//
// README §5.2：面板只展示“用户该做什么”，不只展示英文原因。
// zh 逐字等于旧散落文案（兼容既有测试）；en 待母语评审全 draft（见 src/bilingual.ts）。
// 10 阻塞行复用同一组 key（failureCopy 对阻塞码直接复用 blocked 行，不另起措辞）。

export interface BlockedCopy {
  title: string
  action: string
}

const BLOCKED_KEYS: Record<BlockedReason, { title: BilingualKey; action: BilingualKey }> = {
  'unknown-profile': { title: 'panel.blocked.unknown-profile.title', action: 'panel.blocked.unknown-profile.action' },
  'channel-mismatch': { title: 'panel.blocked.channel-mismatch.title', action: 'panel.blocked.channel-mismatch.action' },
  'source-install': { title: 'panel.blocked.source-install.title', action: 'panel.blocked.source-install.action' },
  'invalid-installation': { title: 'panel.blocked.invalid-installation.title', action: 'panel.blocked.invalid-installation.action' },
  'installation-changed': { title: 'panel.blocked.installation-changed.title', action: 'panel.blocked.installation-changed.action' },
  'pending-restart': { title: 'panel.blocked.pending-restart.title', action: 'panel.blocked.pending-restart.action' },
  'registry-conflict': { title: 'panel.blocked.registry-conflict.title', action: 'panel.blocked.registry-conflict.action' },
  'incompatible-node': { title: 'panel.blocked.incompatible-node.title', action: 'panel.blocked.incompatible-node.action' },
  'incompatible-dsh': { title: 'panel.blocked.incompatible-dsh.title', action: 'panel.blocked.incompatible-dsh.action' },
  'recovery-required': { title: 'panel.blocked.recovery-required.title', action: 'panel.blocked.recovery-required.action' },
  'dev-source': { title: 'panel.blocked.dev-source.title', action: 'panel.blocked.dev-source.action' },
}

/** 装不了的原因 → 单语一句话（能装传 null 即回 null，不猜；lang 缺省 zh，零回归）。 */
export function blockedCopy(reason: BlockedReason | null, lang?: AppLang | string | null): BlockedCopy | null {
  if (reason === null || reason === undefined) return null
  const keys = (BLOCKED_KEYS as Record<string, { title: BilingualKey; action: BilingualKey }>)[reason]
  if (!keys) return null
  const l = normalizeLangTag(lang ?? 'zh')
  return { title: copyText(keys.title, l), action: copyText(keys.action, l) }
}

// ---------- 稳定码单语文案（#22 原型 + #61 入字典：阻塞 + 电话 + internal + 未来兜底） ----------
//
// 码面真源在 src/codes.ts（#141）：下面两张表按真源的类型穷尽，真源添码而这里缺行 TS 直接报错；
// 10 行以 README §5.2 为准（手册是源，字典逐字跟手册，不自创措辞）；
// 5 电话专属 + internal 为原型 panel-tolerated-reader 起草，措辞只给行动，不推导；
// 未来码走兜底（unknown），面板只渲染不推导（分支只用稳定码，不碰 diag 明细）。
export interface FailureCopy {
  zh: string
  act: string
}

/** 电话码 + internal → 文案键（缺一个码，TS 在这行报错，不用等门禁）。 */
const PHONE_FAILURE_KEYS: Record<PhoneFailureCode | typeof INTERNAL_CODE, { title: BilingualKey; action: BilingualKey }> = {
  'check-failed': { title: 'panel.failure.check-failed.title', action: 'panel.failure.check-failed.action' },
  'invalid-release': { title: 'panel.failure.invalid-release.title', action: 'panel.failure.invalid-release.action' },
  'check-expired': { title: 'panel.failure.check-expired.title', action: 'panel.failure.check-expired.action' },
  'update-busy': { title: 'panel.failure.update-busy.title', action: 'panel.failure.update-busy.action' },
  'install-failed': { title: 'panel.failure.install-failed.title', action: 'panel.failure.install-failed.action' },
  [INTERNAL_CODE]: { title: 'panel.failure.internal.title', action: 'panel.failure.internal.action' },
}

const UNKNOWN_FAILURE_KEYS: { title: BilingualKey; action: BilingualKey } = {
  title: 'panel.failure.unknown.title',
  action: 'panel.failure.unknown.action',
}

/** 稳定码全表是否包含该码（阻塞 + 电话 + internal，见 src/codes.ts；未来码不在此列，走兜底）。 */
export function isKnownFailureCode(code: unknown): boolean {
  if (typeof code !== 'string' || !code) return false
  const c = code.trim()
  if (!c) return false
  return c in BLOCKED_KEYS || c in PHONE_FAILURE_KEYS
}

/**
 * 稳定码 → 单语一句话（全表覆盖，见 src/codes.ts；未知码回未来兜底，空码回 null；lang 缺省 zh，零回归）。
 * 10 阻塞行复用 blocked 行原文，不另起措辞；面板分支只认返回值，不碰 diag。
 */
export function failureCopy(code: unknown, lang?: AppLang | string | null): FailureCopy | null {
  if (typeof code !== 'string') return null
  const c = code.trim()
  if (!c) return null
  const l = normalizeLangTag(lang ?? 'zh')
  const blocked = (BLOCKED_KEYS as Record<string, { title: BilingualKey; action: BilingualKey }>)[c]
  if (blocked) return { zh: copyText(blocked.title, l), act: copyText(blocked.action, l) }
  const phone = (PHONE_FAILURE_KEYS as Record<string, { title: BilingualKey; action: BilingualKey }>)[c]
  if (phone) return { zh: copyText(phone.title, l), act: copyText(phone.action, l) }
  return { zh: copyText(UNKNOWN_FAILURE_KEYS.title, l), act: copyText(UNKNOWN_FAILURE_KEYS.action, l) }
}

/**
 * 失败回包取稳定码：只认 errorKind，error 仅作回退（#22 验收：errorKind=internal 时
 * 不许误判为查新版失败；包内已把未知码收敛为 error=check-failed/errorKind=internal，
 * 此时 error 那格不可信）。缺省回 internal（真源常量，见 src/codes.ts），不抛错。
 */
export function failureCodeOf(
  reply: { error?: unknown; errorKind?: unknown } | null | undefined,
  fallback?: unknown,
): string {
  const kind = reply && typeof reply.errorKind === 'string' ? reply.errorKind.trim() : ''
  if (kind) return kind
  const err = reply && typeof reply.error === 'string' ? reply.error.trim() : ''
  if (err) return err
  if (typeof fallback === 'string' && fallback.trim()) return fallback.trim()
  return INTERNAL_CODE
}

/**
 * 是否被拒为过期凭证（#150）：回包 error/errorKind 任一为 check-expired 即算。
 * 只认这个精确码——查失败、忙、装失败都不自动续（续了也拿不到新东西）。
 */
export function replyIsCheckExpired(reply: Record<string, unknown> | null | undefined): boolean {
  if (!reply || typeof reply !== 'object') return false
  const kind = (reply as Record<string, unknown>)['errorKind']
  if (typeof kind === 'string' && kind.trim() === 'check-expired') return true
  const err = (reply as Record<string, unknown>)['error']
  return typeof err === 'string' && err.trim() === 'check-expired'
}

/** 抛错形态的过期凭证（#150）：与回包形态同判据，传输层直抛时用。 */
export function thrownIsCheckExpired(err: unknown): boolean {
  if (typeof err === 'string') return err.trim() === 'check-expired'
  if (err instanceof Error) {
    if (err.message.trim() === 'check-expired') return true
    const code = (err as { code?: unknown }).code
    return typeof code === 'string' && code.trim() === 'check-expired'
  }
  if (err && typeof err === 'object' && !Array.isArray(err)) {
    const rec = err as Record<string, unknown>
    const e = typeof rec['error'] === 'string' ? (rec['error'] as string).trim() : ''
    const k = typeof rec['errorKind'] === 'string' ? (rec['errorKind'] as string).trim() : ''
    const c = typeof rec['code'] === 'string' ? (rec['code'] as string).trim() : ''
    return e === 'check-expired' || k === 'check-expired' || c === 'check-expired'
  }
  return false
}

// ---------- 复制前脱敏（#24 单源收敛：规则唯一源是 src/redaction.ts） ----------
//
// 面板不再自存一份 PANEL_* 镜像：脱敏五条规则、顺序、占位符、遮蔽语义、落刀语义
// 全部由 redaction 纯核定义（零 Node 导入，宿主/面板同缝），此处只转调。
// 统一遮蔽语义（#198）：URL 用户信息只遮盖 userinfo 段，其余原文保留，并追加固定中文说明；
// file:/// 三斜杠缺口显式 known-gap（见 redaction.KNOWN_GAP_FILE_URL_PREFIX），原样放过不静默修。

/** 诊断复制预算（单源：值取 redaction.COPY_BUDGET_CHARS，此处只转出口，老名保留兼容）。 */
export const PANEL_DIAG_MAX_CHARS = COPY_BUDGET_CHARS

/** 复制前把一行文本收干净（确定性：同一输入两次运行逐字节相同；实现见 redaction.sanitizeForCopy）。 */
export function redactForCopy(text: unknown): string {
  return sanitizeForCopy(text)
}

// ---------- 诊断文本（自包含、可粘贴：稳定码 + 脱敏详情 + 版本 + 宿主 + 队列位置） ----------

export interface PanelDiagnosticInput {
  pluginId: string
  /** 稳定码（失败回包的 errorKind 优先，error 仅回退；任务 message 取前缀码）。 */
  code: string
  /** 脱敏前的详情（任务 message 去掉前缀码剩下的部分，可空）。 */
  detail?: string | null
  runningVersion?: string | null
  installedVersion?: string | null
  latestVersion?: string | null
  hostKind?: string | null
  /** 使用范围名：装到哪个 profile 是排错第一信息；旧复制不传则该段不出现，新复制块恒显（缺省为未知）。 */
  profileName?: string | null
  queuePosition?: number | null
  requestId?: string | null
  manual?: string | null
  /** 失败那次安装的目标版本（冻结证据；缺省省略，只显式值）。 */
  targetVersion?: string | null
  /** 电话侧 diag（#21 落定前多半没有；有则宽容读，无则走显式字段，缺省说人话）。 */
  diag?: unknown
  /** 显式来源（diag 没有时用；有 diag 时显式优先，缺省仍说人话，不留白）。 */
  route?: string | null
  checkId?: string | null
  /**
   * 更新器自检（#196 部署偏斜）：本面板实际加载到的本包副本版本与层级。
   * 缺省即老调用——输出一字不差（不掺空字段）；给了才多一格「更新器=版本（层级）」。
   */
  updater?: UpdaterSelfView | null
  /** 渲染语言（#63 单语：缺省 zh 零回归；挂载态传 currentLang，纯函数直调可显式传 en/zh）。 */
  lang?: AppLang | string | null
}

/** 更新器自检格（#196）：版本与副本层级；两格都可被旧调用省略。 */
export interface UpdaterSelfView {
  version?: unknown
  level?: unknown
}

/**
 * 更新器自检两格的规范化（#196）：只认非空字符串版本（没有就不编造），层级缺省 unknown。
 * 面板身份、诊断行、05 章嵌套指引共用这一份口径，避免三处各写一遍。
 */
export function updaterPartsOf(
  updater: UpdaterSelfView | null | undefined,
): { version: string; level: string } | null {
  if (!updater || typeof updater !== 'object') return null
  const version = typeof updater.version === 'string' && updater.version.trim() ? updater.version.trim() : null
  if (!version) return null
  const level = typeof updater.level === 'string' && updater.level.trim() ? updater.level.trim() : 'unknown'
  return { version, level }
}

/**
 * 更新器自检格：有版本才出（没版本不编造），层级缺省 unknown。
 * 层级 token（profile / nested / repo / unknown）是机读事实，不翻译；标签走字典。
 */
function updaterFieldText(updater: UpdaterSelfView | null | undefined, lang: AppLang): string | null {
  const parts = updaterPartsOf(updater)
  if (!parts) return null
  return copyText('panel.diag.copy.field.updater', lang, { version: parts.version, level: parts.level })
}

/** 组出一段自包含诊断（调用方直接拿去粘工单/issue；粘之前已脱敏，不必手检；#63 入字典单语，lang 缺省 zh 零回归）。 */
export function buildDiagnosticText(input: PanelDiagnosticInput, langOverride?: AppLang | string | null): string {
  const l = normalizeLangTag(langOverride ?? (input as { lang?: unknown }).lang ?? 'zh')
  const unknown = copyText('panel.diag.copy.unknown', l)
  const code = String(input.code || 'check-failed')
  const lines: string[] = [copyText('panel.diag.header', l, { pluginId: String(input.pluginId), code })]
  const detail = redactForCopy(input.detail ?? '')
  const fallbackAct = failureCopy(code, l)?.act || code
  lines.push(copyText('panel.diag.label.human', l, { detail: detail || fallbackAct }))
  const versions = [
    copyText('panel.diag.label.running', l, { version: input.runningVersion ?? unknown }),
    copyText('panel.diag.label.installed', l, { version: input.installedVersion ?? unknown }),
    copyText('panel.diag.label.latest', l, { version: input.latestVersion ?? (l === 'en' ? 'Not checked' : '未查过') }),
  ].join(' / ')
  lines.push(versions)
  const queue = queueTextOf(input.queuePosition ?? null, l)
  // 使用范围只在给了的时候出现：不给就与旧输出一字不差（诊断文本是给人粘工单的，不掺空字段）。
  const hostLine = [copyText('panel.diag.label.host', l, { host: input.hostKind ?? unknown })]
  if (typeof input.profileName === 'string' && input.profileName) hostLine.push(copyText('panel.diag.label.profile', l, { profile: input.profileName }))
  hostLine.push(copyText('panel.diag.label.queue', l, { queue }))
  // #196：更新器自检格只在调用方给了版本时出现（老调用输出一字不差）。
  const updaterLine = updaterFieldText(input.updater, l)
  if (updaterLine) hostLine.push(updaterLine)
  lines.push(hostLine.join(' / ') + (input.requestId ? ` / ${copyText('panel.diag.label.request', l, { requestId: input.requestId })}` : ''))
  const manual = redactForCopy(input.manual ?? '')
  if (manual) lines.push(copyText('panel.diag.label.manual', l, { manual }))
  return redactForCopy(lines.join('\n'))
}

// ---------- 双形态复制块（#22：三行块默认 + 单行 [update-diag] 可选，顺序完全一致） ----------
//
// 顺序由包内定（码 → 摘要 → 来源），两种形态只是排版不同：
// - block：三段（首行码+中文、次行怎么办+摘要、末行来源），默认复制形态；
// - line：单行 `[update-diag] code=… · …`，方便粘进单行输入框。
// 内容顺序完全一致：同一输入先算出同一段数组，再按形态 join。
// 面板只渲染不推导：文案只取 failureCopy(稳定码)，摘要只取 diag.detail/显式 detail
//（脱敏后），来源只取 diag/显式字段，缺省一律说人话，不分支、不猜。

export type DiagCopyFormat = 'block' | 'line'

const DIAG_KNOWN_TYPES: Record<string, string> = {
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
  intentHash: 'string',
  checkId: 'string',
  registryHost: 'string',
  action: 'string',
  causeKind: 'string',
  causePackage: 'string',
  causeUnlockAt: 'number',
}

export interface TolerantDiag {
  stage: string | null
  route: string | null
  method: string | null
  httpStatus: number | null
  exitCode: number | null
  latencyMs: number | null
  detail: string | null
  targetPackageName: string | null
  runningVersion: string | null
  latestVersion: string | null
  environmentKind: string | null
  requestId: string | null
  /** #207 安装意图指纹（hash8(requestId)）：诊断回包与日志行之间的跨落点聚合键。 */
  intentHash: string | null
  checkId: string | null
  registryHost: string | null
  action: string | null
  /** 翻译官结论（#155）：冻结枚举 causeKind + 肇事包规格 + 解封毫秒；缺省即通用老路。 */
  causeKind: string | null
  causePackage: string | null
  causeUnlockAt: number | null
  /** 目录外的键（如 queuePos 转正前）一律忽略，记在这里仅供排错，不进渲染。 */
  unknownKeys: string[]
}

/** 宽容读 diag：未知键忽略、错类型忽略、缺省当正常（永不抛；面板分支永不用它）。 */
export function readDiagTolerant(diag: unknown): TolerantDiag {
  const empty: TolerantDiag = {
    stage: null,
    route: null,
    method: null,
    httpStatus: null,
    exitCode: null,
    latencyMs: null,
    detail: null,
    targetPackageName: null,
    runningVersion: null,
    latestVersion: null,
    environmentKind: null,
    requestId: null,
    intentHash: null,
    checkId: null,
    registryHost: null,
    action: null,
    causeKind: null,
    causePackage: null,
    causeUnlockAt: null,
    unknownKeys: [],
  }
  if (!diag || typeof diag !== 'object' || Array.isArray(diag)) return empty
  const raw = diag as Record<string, unknown>
  const out: TolerantDiag = { ...empty, unknownKeys: [] }
  for (const key of Object.keys(DIAG_KNOWN_TYPES)) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue
    const v = raw[key]
    if (v === undefined || v === null) continue
    if (typeof v !== DIAG_KNOWN_TYPES[key]) continue
    ;(out as unknown as Record<string, unknown>)[key] = v
  }
  for (const key of Object.keys(raw)) {
    if (!Object.prototype.hasOwnProperty.call(DIAG_KNOWN_TYPES, key)) out.unknownKeys.push(key)
  }
  return out
}

export interface UpdateDiagCopyInput extends PanelDiagnosticInput {
  /** 复制形态：默认三行块；单行用于单行输入框，内容顺序与块完全一致。 */
  format?: DiagCopyFormat
}

function pickText(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim()
  return fallback
}

export function queueTextOf(queuePosition: number | null | undefined, lang?: AppLang | string | null, _diagQueuePos?: unknown): string {
  // 第一性：queuePos 未转正前面板必须忽略（#18 预留未来键，diag.ts 永不产出，原型按目录外键静默丢）。
  // 排队位置只看队列视图；转正后电话侧按目录给，届时再接线，本函数签名保留占位以免误用。
  // #63 入字典单语，lang 缺省 zh 零回归。
  void _diagQueuePos
  const l = normalizeLangTag(lang ?? 'zh')
  const pos = typeof queuePosition === 'number' ? queuePosition : null
  if (pos === 0) return copyText('panel.diag.queue.installing', l)
  if (typeof pos === 'number') return copyText('panel.diag.queue.position', l, { n: pos })
  return copyText('panel.diag.queue.absent', l)
}

/**
 * 翻译官怎么办句（#155）：diag 自带机读结论（causeKind 冻结枚举 + 肇事包规格 + 可选解封毫秒）
 * 时，按"归因 × 时间可算/不可算"四格选一句专项文案；否则回 null，调用方走通用怎么办。
 * 面板分支只认 causeKind 枚举与归因函数，不读自由文本；缺目标名即 unknown，不排除——措辞只退回通用。
 */
export function causeRemedyText(
  cause: { kind?: unknown; package?: unknown; unlockAtMs?: unknown; target?: unknown },
  lang?: AppLang | string | null,
): string | null {
  try {
    const l = normalizeLangTag(lang ?? 'zh')
    const kind = String(cause?.kind ?? '').trim()
    if (!kind || !(CAUSE_KINDS as readonly string[]).includes(kind)) return null
    const spec = String(cause?.package ?? '').trim()
    if (!spec) return null
    const blame = blameCausePackage(spec, cause?.target)
    if (blame === 'unknown') return null
    const timeRaw = typeof cause?.unlockAtMs === 'number' ? formatUnlockAt(cause.unlockAtMs, l) : null
    const timed = !!timeRaw
    const key =
      blame === 'target'
        ? timed
          ? 'diag.cause.age.target.timed'
          : 'diag.cause.age.target.untimed'
        : timed
          ? 'diag.cause.age.other.timed'
          : 'diag.cause.age.other.untimed'
    return copyText(key as BilingualKey, l, { package: spec, time: timeRaw ?? '' })
  } catch {
    return null
  }
}

/**
 * 组出 [update-diag] 复制块（双形态同序；调用方直接拿去粘工单/issue，已脱敏）。
 * 第一性：顺序码→摘要→来源（#18 定），怎么办是面板页脚放最后，不插断三元组；
 * 缺省即省略（#18）：路由/请求/检查/阶段等缺失即不出现，不占位“未知”；
 * 插件/版本/宿主/使用范围/队列恒显（面板侧显式值兜底），摘要缺省给人话，源缺省说未声明（#154：不编造来源）。
 * #63 入字典单语（§3.4 22 项，队列 3 复用旧块）：标签跟随语言，变量与自由文本、两种复制形态与字段顺序冻结不动；
 * 机读 tag [update-diag]/code=/·/— 冻结在代码里不进字典（非人类语言），人类标签（摘要/来源/怎么办/插件=…）走字典；
 * lang 缺省 zh 零回归，detail/变量/占位符不译（v2 非目标，英文界面出现中文正文属正常）。
 */
export function buildUpdateDiagCopy(input: UpdateDiagCopyInput, langOverride?: AppLang | string | null): string {
  const l = normalizeLangTag(langOverride ?? (input as { lang?: unknown }).lang ?? 'zh')
  const unknown = copyText('panel.diag.copy.unknown', l)
  const unknownPkg = copyText('panel.diag.copy.unknown-package', l)
  const rawCode = String((input as { code?: unknown }).code ?? '').trim() || 'internal'
  const copy = failureCopy(rawCode, l) ?? failureCopy('unknown', l)!
  const diag = readDiagTolerant((input as { diag?: unknown }).diag)
  // #155：有翻译官结论即换专项怎么办句；没有（或未知归因）即通用老话，一字不动。
  // 归因目标只认 diag.targetPackageName（npm 包名命名空间）；input.pluginId 是插件标识，
  // 拿它比对会把"未知"谎报成"他包"——缺包名即 unknown，不退而求其次。
  const remedy =
    causeRemedyText(
      { kind: diag.causeKind, package: diag.causePackage, unlockAtMs: diag.causeUnlockAt, target: diag.targetPackageName },
      l,
    ) ?? copy.act
  const detailRaw = diag.detail ?? input.detail ?? ''
  const detail = redactForCopy(detailRaw) || copyText('panel.diag.copy.no-detail', l)
  const pluginName = pickText(diag.targetPackageName ?? input.pluginId, unknownPkg)
  const runVer = pickText(diag.runningVersion ?? input.runningVersion, '?')
  const instVer = pickText(input.installedVersion ?? diag.latestVersion, '?')
  const host = pickText(diag.environmentKind ?? input.hostKind, unknown)
  const routeRaw = (diag.route ?? (input as { route?: unknown }).route) as unknown
  const requestRaw = (diag.requestId ?? input.requestId) as unknown
  const checkRaw = (diag.checkId ?? (input as { checkId?: unknown }).checkId) as unknown
  const queue = queueTextOf(input.queuePosition ?? null, l)
  // 来源顺序固定：插件 → 版本 → 目标 → 宿主 → 更新器 → 使用范围 → 路由 → 阶段 → 方法 → HTTP/exit/耗时 → 源 → 建议 → 请求/检查 → 队列
  // 缺省即省略：路由/请求/检查/目标等无值即不出现；插件/版本/宿主/使用范围/队列恒显；源缺省给人话。
  const prov: string[] = [copyText('panel.diag.copy.field.plugin', l, { plugin: pluginName }), copyText('panel.diag.copy.field.version', l, { run: runVer, inst: instVer })]
  const targetRaw = (input as { targetVersion?: unknown }).targetVersion
  if (typeof targetRaw === 'string' && targetRaw.trim()) prov.push(copyText('panel.diag.copy.field.target', l, { version: targetRaw.trim() }))
  prov.push(copyText('panel.diag.copy.field.host', l, { host }))
  // #45：使用范围恒显（排错第一信息；未知也不猜，与表头口径一致，diag 无此键故只看显式值）。
  prov.push(copyText('panel.diag.copy.field.profile', l, { profile: pickText((input as { profileName?: unknown }).profileName, unknown) }))
  if (typeof routeRaw === 'string' && routeRaw.trim()) prov.push(copyText('panel.diag.copy.field.route', l, { route: routeRaw.trim() }))
  if (diag.stage) prov.push(copyText('panel.diag.copy.field.stage', l, { stage: diag.stage }))
  if (diag.method) prov.push(copyText('panel.diag.copy.field.method', l, { method: diag.method }))
  if (typeof diag.httpStatus === 'number') prov.push(`HTTP=${diag.httpStatus}`)
  if (typeof diag.exitCode === 'number') prov.push(`exit=${diag.exitCode}`)
  if (typeof diag.latencyMs === 'number') prov.push(`${copyText('panel.diag.copy.field.latency', l, { latency: diag.latencyMs })}ms`)
  if (diag.registryHost) prov.push(copyText('panel.diag.copy.field.registry', l, { host: diag.registryHost }))
  else prov.push(copyText('panel.diag.copy.field.registry-unknown', l))
  if (diag.action) prov.push(copyText('panel.diag.copy.field.action', l, { action: diag.action }))
  if (typeof requestRaw === 'string' && requestRaw.trim()) prov.push(copyText('panel.diag.copy.field.request', l, { request: requestRaw.trim() }))
  if (typeof checkRaw === 'string' && checkRaw.trim()) prov.push(copyText('panel.diag.copy.field.check', l, { check: checkRaw.trim() }))
  // #207：意图短指纹是机读 tag（与 HTTP=/exit= 同待遇，不进字典），让复制出来的工单证据
  // 能与 update.install.request / update.install.fail 两类日志行对上；缺省即省略。
  if (diag.intentHash) prov.push(`intent=${diag.intentHash}`)
  prov.push(copyText('panel.diag.copy.field.queue', l, { queue }))
  // #196 部署偏斜：来源行补「更新器=版本（层级）」，缺省省略（老调用/未知副本不编）。
  const updaterText = updaterFieldText((input as { updater?: UpdaterSelfView | null }).updater, l)
  if (updaterText) prov.push(updaterText)
  const format: DiagCopyFormat = (input as { format?: unknown }).format === 'line' ? 'line' : 'block'
  const provLine = redactForCopy(prov.join(' · '))
  if (format === 'line') {
    const line = `[update-diag] code=${rawCode} · ${copy.zh} · ${copyText('panel.diag.copy.line.summary', l, { summary: detail })} · ${provLine} · ${copyText('panel.diag.copy.line.remedy', l, { remedy })}`
    return redactForCopy(line)
  }
  // 块形态保留换行：各段已脱敏，不再整块压平（压平会把三行块变成单行）。
  const block = [
    `[update-diag] ${rawCode} — ${copy.zh}`,
    `  ${copyText('panel.diag.copy.block.summary', l, { summary: detail })}`,
    `  ${copyText('panel.diag.copy.block.source', l, { source: provLine })}`,
    `  ${copyText('panel.diag.copy.block.remedy', l, { remedy })}`,
  ].join('\n')
  return block
}

// ---------- 健康态复制（#166 切片 2：panel.ts 里最后一块硬编码中文用户文案） ----------
//
// 失败分支走 buildUpdateDiagCopy（字典驱动）；健康态（无锁存、无失败码、无阻拦原因）
// 走这里：状态一句话＋版本三格＋来源。措辞逐字等于旧内联实现（先搬家、零行为变化；
// 是否入字典是另一次产品决策，不在本刀）。
// 纯函数：同一输入永远同一串；lang 缺省 zh。

export interface HealthyDiagCopyInput {
  canInstall: boolean
  latestVersion: string | null
  /** 快照 installed 字段：false 即未安装（人话状态词，不写注入的假版号，#134/US19）。 */
  installed: boolean | null
  runningVersion: string | null
  installedVersion: string | null
  queuePosition: number | null
  pluginId: string
  hostKind: string | null
  profileName: string | null
  requestId: string | null
  checkId: string | null
  /** 更新器自检（#196）：本面板加载到的本包副本版本与层级；缺省即老输出不变。 */
  updater?: UpdaterSelfView | null
  format?: DiagCopyFormat
  lang?: AppLang | string | null
}

export function buildHealthyDiagCopy(input: HealthyDiagCopyInput): string {
  const l = normalizeLangTag(input.lang ?? 'zh')
  const notInstalledWord = input.installed === false ? copyText('panel.banner.not-installed', l) : null
  // #182：运行版本未知时不许把 null 拼成「null」，也不许冒充「已是最新」。
  const runningWord = input.runningVersion ?? copyText('panel.meta.unknown', l)
  const stateLine =
    input.canInstall && input.latestVersion
      ? `有新版 ${input.latestVersion} 可装（当前 ${notInstalledWord ?? runningWord}）`
      : input.installed !== false && input.runningVersion === null
        ? '运行版本未知，无法判断是否有新版可装。'
        : (notInstalledWord ?? '已是最新，无需更新。')
  const queueName = queueTextOf(input.queuePosition ?? null, l)
  const envBits = [
    `插件=${input.pluginId}`,
    `宿主=${input.hostKind ?? '未知'}`,
    `使用范围=${input.profileName ?? '未知'}`,
    `队列=${queueName}`,
  ]
  if (input.requestId) envBits.push(`请求=${input.requestId}`)
  if (input.checkId) envBits.push(`检查=${input.checkId}`)
  // #196 部署偏斜：健康态也报「更新器=版本（层级）」，缺省省略（老调用一字不差）。
  const updaterLine = updaterFieldText(input.updater, l)
  if (updaterLine) envBits.push(updaterLine)
  const segs = [
    `[update-diag] 当前无失败：${stateLine}`,
    `版本：运行 ${input.runningVersion ?? '未知'}／磁盘 ${input.installedVersion ?? '未知'}／远端 ${input.latestVersion ?? '未查过'}`,
    `来源：${envBits.join(' · ')}`,
  ].map((s) => redactForCopy(s))
  return input.format === 'line' ? segs.join(' · ') : segs.join('\n')
}
