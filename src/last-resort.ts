/**
 * src/last-resort.ts —— 「最后手段」判定的唯一真源（#174，规格 #173 v2 + #177 D1–D4）。
 *
 * 为什么单独成模块：同一件事实（当前帧还有没有自动救援、手工命令能不能信）要在三处渲染点
 * （单插件面板 / 批量面板 / 槽位安装按钮）用同一个口径，各算一遍迟早会漂。这里只做纯派生，
 * 不新增码、不加快照字段、不改 verify 事件：输入是现成事实（码 + 阶段 + manual + manualSource
 * + fallbackAvailable + 运行版是否已知），输出四态与救援路径枚举，渲染器只消费结果。
 *
 * 四态合取规则（#173「真值表」+ #177 D4）：
 * - 有救援路径 → `salvageable`（不高亮）；
 * - 无救援 ∧ 命令当帧可信（manualSource === 'frame' 且 manual 非空）→ `last-resort`（唯一高亮窗口）；
 * - 无救援 ∧ 当帧确认无命令（manualSource === null / manual 空）→ `dead-end`（走 #92 分原因文案）；
 * - 无救援 ∧ 命令不可信（carried-over）或证据不全 / 认不出的码 → `unknown`（不高亮，不宣称「无救」）。
 *
 * 防误报（#171 D5）：阻塞原因的救援表是穷尽 `Record<BlockedReason, …>`，新增码时 TypeScript 直接报错；
 * 测试另外遍历 `BLOCKED_REASONS` 逼补一行。判不出的新状态一律 `unknown`。
 */

import {
  BLOCKED_REASONS,
  CHECK_SIDE_FAILURE_CODES,
  INTERNAL_CODE,
  type BlockedReason,
} from './shared/codes.js'

/** 判定四态。只有 `last-resort` 允许在渲染层高亮。 */
export type LastResortKind = 'last-resort' | 'salvageable' | 'dead-end' | 'unknown'

/** 救援路径枚举：渲染层不各自发明动作，只按这里给的路线出文案 / 按钮。 */
export type RescueRouteKey =
  | 'retry'
  | 'recheck'
  | 'wait-retry'
  | 'restart-host'
  | 'select-in-host'
  | 'upgrade-runtime'
  | 'switch-channel'
  | 'fix-manifest'
  | 'install-compliant'

/**
 * 手工命令的可信来源（#177 D1）：
 * - `frame`：与当帧快照来自同一回包，且回包带 `manual` 键；
 * - `carried-over`：失败回包沿用的旧值（不算可信，界面 fail-closed）。
 * `null` = 当帧确认无命令（走 #92 的原因分类）。
 */
export type ManualSource = 'frame' | 'carried-over'

/** 渲染帧的阶段：只由码面推导，不引入新状态。 */
export type LastResortStage = 'install' | 'check' | 'busy' | 'restart' | 'blocked' | 'unknown'

/** 判定主体 = 渲染帧的「码 + 阶段」（另带 pending-restart 需要的一位证据：是否已登记）。 */
export interface LastResortSubject {
  code: string | null
  stage: LastResortStage
  registered?: boolean | null
}

/** 判定输入：全部是现成事实，缺项按「证据不全」处理。 */
export interface LastResortInput {
  /** 当帧码（失败码 / 阻塞原因 / internal）。`blockedReason` 优先。 */
  code?: string | null
  /** 快照里的阻塞原因（有它就按阻塞面判定）。 */
  blockedReason?: string | null
  /** 显式阶段（渲染器知道自己在画哪一档时可给；缺省由码推导）。 */
  stage?: LastResortStage | null
  manual?: string | null
  manualSource?: ManualSource | null
  /** 失败的是更新目标本身且有合规版候选（#156 通道）时为 true。 */
  fallbackAvailable?: boolean | null
  /** 运行版是否已知（false = #182 的 unknown-running 分支）。 */
  runningVersionKnown?: boolean | null
  /** 待重启那档：false = 没登记，下一步是「在宿主里选择」。 */
  registered?: boolean | null
}

/** 判定结果：渲染器只读这里。 */
export interface LastResortVerdict {
  kind: LastResortKind
  subject: LastResortSubject
  routes: RescueRouteKey[]
  manualSource: ManualSource | null
}

const STAGES: readonly LastResortStage[] = ['install', 'check', 'busy', 'restart', 'blocked', 'unknown']

/** 阻塞原因 → 救援路径（穷尽表；空数组 = 没有自动救援，按命令可得性再分三态）。 */
const BLOCKED_RESCUE: Record<BlockedReason, RescueRouteKey[]> = {
  'unknown-profile': [],
  'source-install': [],
  'dev-source': [],
  'invalid-installation': [],
  'recovery-required': [],
  // 安装态已变（#173 未单列）：重查一次即可拿到当帧事实，属可救援。
  'installation-changed': ['recheck'],
  'pending-restart': ['restart-host'],
  'channel-mismatch': ['switch-channel'],
  'registry-conflict': ['fix-manifest'],
  'incompatible-node': ['upgrade-runtime'],
  'incompatible-dsh': ['upgrade-runtime'],
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function firstText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function isBlockedReason(value: string | null): value is BlockedReason {
  return value !== null && (BLOCKED_REASONS as readonly string[]).includes(value)
}

function isStage(value: unknown): value is LastResortStage {
  return typeof value === 'string' && (STAGES as readonly string[]).includes(value)
}

function stageOfCode(code: string | null, blocked: string | null): LastResortStage {
  if (isBlockedReason(blocked)) return 'blocked'
  if (isBlockedReason(code)) return 'blocked'
  if (code === null) return 'unknown'
  if (code === 'install-failed') return 'install'
  if ((CHECK_SIDE_FAILURE_CODES as readonly string[]).includes(code)) return 'check'
  if (code === 'update-busy') return 'busy'
  if (code === INTERNAL_CODE) return 'unknown'
  return 'unknown'
}

/** 帧主体：码 + 阶段（错误输入 → `{ code: null, stage: 'unknown' }`，不抛）。 */
export function lastResortSubjectOf(input: unknown): LastResortSubject {
  const rec = asRecord(input)
  const blocked = firstText(rec['blockedReason'])
  const code = isBlockedReason(blocked) ? blocked : firstText(rec['code'])
  // 显式阶段只在码推导不出时兜底：码面永远是主证据，免得调用方传错阶段造成误判。
  const derived = stageOfCode(code, blocked)
  const explicit = isStage(rec['stage']) ? (rec['stage'] as LastResortStage) : null
  const stage = derived === 'unknown' && explicit !== null ? explicit : derived
  const registeredRaw = rec['registered']
  const registered = typeof registeredRaw === 'boolean' ? registeredRaw : null
  return { code, stage, registered }
}

/** 阶段 → 救援路径（1 参；`install-compliant` 由判定函数按 fallbackAvailable 补）。 */
export function rescueRoutesOf(subject: LastResortSubject | null | undefined): RescueRouteKey[] {
  const s = asRecord(subject)
  const code = firstText(s['code'])
  const stage = isStage(s['stage']) ? (s['stage'] as LastResortStage) : 'unknown'
  if (stage === 'blocked') {
    if (!isBlockedReason(code)) return []
    if (code === 'pending-restart' && s['registered'] === false) return ['select-in-host']
    return [...BLOCKED_RESCUE[code]]
  }
  if (stage === 'check') return ['recheck']
  if (stage === 'busy') return ['wait-retry']
  if (stage === 'restart') return [s['registered'] === false ? 'select-in-host' : 'restart-host']
  // install 阶段的合规版通道要看 fallbackAvailable（不在 subject 里），由判定函数补。
  return []
}

function manualSourceOf(value: unknown): ManualSource | null {
  return value === 'frame' || value === 'carried-over' ? value : null
}

/** 唯一判定入口：渲染器只调它（错误输入 → unknown）。 */
export function lastResortVerdictOf(input: unknown): LastResortVerdict {
  const rec = asRecord(input)
  const subject = lastResortSubjectOf(input)
  const manualSource = manualSourceOf(rec['manualSource'])
  const manual = firstText(rec['manual'])
  const routes = rescueRoutesOf(subject)

  const verdict = (kind: LastResortKind, rs: RescueRouteKey[] = routes): LastResortVerdict => ({
    kind,
    subject,
    routes: [...rs],
    manualSource,
  })

  // 证据不全 / 认不出：先落 unknown，绝不猜「无救」。
  if (subject.stage === 'unknown') return verdict('unknown', [])
  // #177 D4：命令不可信（carried-over）一律 unknown——阻塞面也不能把「沿用旧值」当「确认无命令」。
  if (manualSource === 'carried-over') return verdict('unknown')
  // 阻塞面：有救援就 salvageable；没有就 dead-end（当帧命令可信时命令仍展示，但不改变阻塞事实）。
  if (subject.stage === 'blocked') return verdict(routes.length > 0 ? 'salvageable' : 'dead-end')
  // 查侧 / 忙 / 待重启：重查、等、重启本身就是救援。
  if (routes.length > 0) return verdict('salvageable')
  // 安装失败：合规版通道是自动救援。
  if (rec['fallbackAvailable'] === true) return verdict('salvageable', ['install-compliant'])
  // 运行版都认不出 → 先重查，别宣称「无救」。
  if (rec['runningVersionKnown'] === false) return verdict('salvageable', ['recheck'])
  // 无救援 ∧ 命令当帧可得 = 唯一高亮窗口。
  if (manual !== null && manualSource === 'frame') return verdict('last-resort')
  // 当帧确认无命令 = 死路（理由交给 #92 的分原因文案）。
  if (manualSource === null && manual === null) return verdict('dead-end')
  return verdict('unknown')
}
