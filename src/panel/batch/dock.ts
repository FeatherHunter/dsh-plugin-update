/**
 * src/panel/batch/dock.ts —— T5 常驻更新进度 dock（面板侧组件）。
 *
 * 定位：集成方把「全局更新进度」这一小块挂到自己的右下角（或贴底通栏），不开面板也能
 * 看到别处/本处的批量更新走到哪；空闲时自己隐藏、不占空间。
 *
 * 分层（自上而下，互不越界）：
 *   1. 视图模型 `hubDockViewModel`：纯函数。吃 `updateHubStatus` 回包里的 snapshot（宽容解析，
 *      坏输入按「什么都没发生」处理，永不抛），产出可单测的纯数据；不碰 DOM、不读全局。
 *   2. 挂载 `mountHubProgressDock`：只管生命周期——建骨架、注入样式（每 document 一次）、
 *      轮询、`document.hidden` 暂停、dispose 清理；把视图模型画进自己 append 进容器的那个根节点。
 *
 * 数据来源：宿主电话 `<批量前缀>.updateHubStatus` → `{ ok: true, snapshot }`
 *    （#250 只读全局进度，快照形状见 core/hub/snapshot.ts；接线见 host/batch/fan-out.ts）。
 *   phone 由 options.phone 显式给，或由 options.prefix 派生；两者都没有就在挂载期报错，
 *   不静默猜一个打不通的电话。
 *
 * 纪律：
 *   - 本文件是叶子组件：只依赖 shared 语言/配置、i18n 文案与少量类型，不反向拉批量面板实现图。
 *   - 零中文字符串字面量（#56 文案门禁）：用户可见文案全部经 copyText 取既有 key，不新增 key。
 *   - 不写 document.body、不 append 容器以外的 DOM；样式只注入到 document.head（无 head 的极简宿主退回容器）。
 *   - 浏览器安全：tsconfig types:[] 不带 DOM lib，这里用结构类型描述最小 DOM 面；
 *     Node 侧只用到全局 setTimeout/clearTimeout（node-ambient.d.ts 已有声明）。
 */

import { assertPrefix, DEFAULT_PANEL_POLL_MS, MIN_PANEL_POLL_MS } from '../../shared/config.js'
import { normalizeLangTag, resolveLang } from '../../shared/lang.js'
import { copyText } from '../../core/i18n/text.js'
import type { AppLang } from '../../shared/lang.js'
import type { HubSessionState } from '../../core/hub/snapshot.js'

// ---------- 公开常量与摆放形态 ----------

/** dock 轮询口径：默认 1 秒，下限与面板同一条 250 毫秒（规格 #591 第 5 条）。 */
export const HUB_DOCK_POLL = {
  defaultMs: DEFAULT_PANEL_POLL_MS,
  minMs: MIN_PANEL_POLL_MS,
} as const

/** 摆放形态：右下角浮层 / 贴底通栏 / 内联（由调用方放进自己的页面流里）。 */
export const HUB_DOCK_MOUNT_MODES = ['bottom-right', 'bottom-bar', 'inline'] as const
export type HubDockMountAs = (typeof HUB_DOCK_MOUNT_MODES)[number]

/** 明细行上限口径：缺省只展示 3 行，最多 20 行（再多交给面板，别让 dock 抢版面）。 */
export const HUB_DOCK_ROWS = {
  defaultMax: 3,
  max: 20,
} as const

/** 电话动作名：与 host/batch/fan-out.ts 的 `prefix + '.updateHubStatus'` 一字不差（电话名只从前缀派生）。 */
const HUB_STATUS_PHONE_SUFFIX = '.updateHubStatus'

// ---------- 公开类型（视图模型） ----------

/** 明细里的一行（每个目标插件一行，纯数据）。 */
export interface HubDockRowView {
  /** 目标在批量顺序里的键。 */
  key: string
  /** 目标显示名。 */
  title: string
  /** 相位人话（取自既有文案 key）。 */
  phaseText: string
  /** 版本箭头：`已装 -> 目标`；没有可用版本时为空串。 */
  versionText: string
  /** 失败原因（只给码/短文本，不做长篇解释）；没有失败时为空串。 */
  errorText: string
  /** 装完是否要重启宿主才生效。 */
  restartRequired: boolean
}

/** 一个「还在推进」的会话在 dock 里的展示数据（纯数据，不碰 DOM）。 */
export interface HubDockSessionView {
  /** 全局快照里的会话编号。 */
  sessionId: string
  /** 属主＝批量前缀（ADR-0003）；旧账本允许空串。 */
  owner: string
  /** 只收 running/waiting：finished/missing 不占 dock（空闲隐藏口径）。 */
  state: HubSessionState
  total: number
  done: number
  failed: number
  skipped: number
  current: number
  pending: number
  /** 会话里「待重启」的行数。 */
  restartCount: number
  /** 会话明细行（可能被快照截断，行数上限见 snapshot 的 maxRowsPerSession）。 */
  rows: HubDockRowView[]
  /** 终态占比（done+failed+skipped / total，四舍五入，夹在 0..100）。 */
  percent: number
  /** 一行可读文案：「属主  75%  3/4」。 */
  text: string
}

/** 正在进行的安装（宿主租约活着才有；只作展示，不参与聚合）。 */
export interface HubDockInstallView {
  pluginId: string
  startedAt: number
}

/** 视觉档位：warn 表示有失败要关注（样式只换颜色，不换结构）。 */
export type HubDockTone = 'busy' | 'warn'

/** dock 的完整视图模型（纯数据）：挂载层只按它画，测试只按它断言。 */
export interface HubDockViewModel {
  /** 有没有「还在推进」的会话或活着的安装租约；false 时 dock 隐藏且不占空间。 */
  visible: boolean
  /** options.title 原样透传；不可见时为空串。 */
  title: string
  tone: HubDockTone
  /** 跨会话聚合：终态占比。 */
  percent: number
  total: number
  done: number
  failed: number
  skipped: number
  current: number
  /** 聚合后「待重启」的行数。 */
  restartCount: number
  /** 参与聚合的会话数（running + waiting）。 */
  activeSessions: number
  /** 快照里截断前的会话总数（如实透传；小于 activeSessions 时按 activeSessions 算）。 */
  sessionsTotal: number
  sessions: HubDockSessionView[]
  /** 跨会话聚合的明细行（按会话顺序拼接，最多 maxRows 行）。 */
  rows: HubDockRowView[]
  /** 因 maxRows 上限没画出来的行数（折叠成一行计数）。 */
  foldedCount: number
  activeInstall: HubDockInstallView | null
  /** 摘要文案：「75%」（没有进度时为空串）。 */
  text: string
  /** 状态语句（取自既有文案 key，随语言切换）。 */
  statusText: string
  /** 失败语句（失败数为 0 时为空串）。 */
  failureText: string
  /** 待重启语句（没有待重启时为空串）。 */
  restartText: string
  /** 折叠时的一行计数：「2 个安装中  1 个失败  1 个待重启」（全部为空时为空串）。 */
  summaryText: string
}

/** 视图模型的选项：都可不给（缺省跟随 zh；挂载层会传入当次解析出的语言）。 */
export interface HubDockViewModelOptions {
  title?: string
  lang?: AppLang
  /** 明细行展示上限：缺省 HUB_DOCK_ROWS.defaultMax，夹在 1..HUB_DOCK_ROWS.max。 */
  maxRows?: number
}

// ---------- 公开类型（挂载） ----------

/**
 * 容器的最小结构面：只要求能 append/remove 自己建出来的节点。
 * 真实 DOM Element 结构上满足它（本包 tsconfig 的 types:[] 不带 DOM lib，所以不写 Element）；
 * 容器里已有的内容本组件不碰，只 append 一个自己的根节点、dispose 时原样拿走。
 */
export interface HubDockContainer {
  appendChild(node: unknown): unknown
  removeChild(node: unknown): unknown
  readonly ownerDocument?: unknown
}

/** 传输函数：只负责把完整电话名（含前缀）转给宿主，不做前缀加工。 */
export type HubDockCall = (name: string, args: Record<string, unknown>) => unknown | Promise<unknown>

export interface HubDockOptions {
  /** 传输函数：dock 调宿主电话的唯一接触面。 */
  call: HubDockCall
  /** 批量前缀：用于拼 `<prefix>.updateHubStatus`（与 host 侧同一拼法）。 */
  prefix?: string
  /** 完整电话名：给了就优先于 prefix（便于接入方自行接线）。 */
  phone?: string
  /** 顶部标题（调用方文案；不给只显示百分比与进度条）。 */
  title?: string
  /** 轮询间隔毫秒：缺省 1000，不得小于 250；非法值在挂载期报错。 */
  pollMs?: number
  /** 摆放形态：缺省 bottom-right。 */
  mountAs?: HubDockMountAs
  /** 空闲（没有在推进的会话/安装）时是否整块隐藏：缺省 true；false 则保留一个空壳。 */
  hideWhenIdle?: boolean
  /** 初始是否折叠：缺省 false；折叠时只显示标题、百分比与一行计数。 */
  collapsed?: boolean
  /** 明细行展示上限：缺省 HUB_DOCK_ROWS.defaultMax，夹在 1..HUB_DOCK_ROWS.max。 */
  maxRows?: number
  /** 固定语言；不传即跟随全局语言信号（每次轮询重解，切语言后下一次刷新生效）。 */
  lang?: AppLang
  /** 点击标题区的回调（通常打开批量面板）；回调抛错不连坐 dock。 */
  onOpen?: () => void
}

export interface HubDockController {
  /** 立即刷新一次（并发调用合并为同一趟在飞行）；永不 reject，坏回包保持上一次画面。 */
  update(): Promise<void>
  /** update 的同义名（票面写的 refresh）：接线方两种写法都认。 */
  refresh(): Promise<void>
  /** 停表、摘监听、把根节点从容器拿走；幂等。 */
  dispose(): void
}

// ---------- 视图模型（纯函数层） ----------

/**
 * 把 `updateHubStatus` 回包里的 snapshot 投影成 dock 视图模型。
 * 宽容解析：null/缺字段/坏形状一律当「没有可展示的进度」，永不抛；只认 running/waiting 的会话
 * （与 `hubSnapshotActiveCount` 的空闲隐藏口径一致），finished/missing 不参与聚合也不占空间。
 */
export function hubDockViewModel(snapshot: unknown, options: HubDockViewModelOptions = {}): HubDockViewModel {
  const safeOptions: Record<string, unknown> = isRecord(options) ? options : {}
  const lang = normalizeLangTag(safeOptions['lang'])
  const title = typeof safeOptions['title'] === 'string' ? safeOptions['title'] : ''
  const maxRows = resolveMaxRows(safeOptions['maxRows'])
  const root = isRecord(snapshot) ? snapshot : null

  const sessions: HubDockSessionView[] = []
  const rawSessions = root !== null && Array.isArray(root['sessions']) ? root['sessions'] : []
  for (const raw of rawSessions) {
    const session = sessionViewOf(raw, lang)
    if (session !== null) sessions.push(session)
  }

  const activeInstall = activeInstallOf(root !== null ? root['activeInstall'] : null)
  const visible = sessions.length > 0 || activeInstall !== null

  let total = 0
  let done = 0
  let failed = 0
  let skipped = 0
  let current = 0
  let restartCount = 0
  for (const session of sessions) {
    total += session.total
    done += session.done
    failed += session.failed
    skipped += session.skipped
    current += session.current
    restartCount += session.restartCount
  }
  const percent = percentOf(done + failed + skipped, total)

  const sessionsTotal = Math.max(asCount(root !== null ? root['sessionsTotal'] : 0), sessions.length)

  // 明细：跨会话按出现顺序拼接，只画前 maxRows 行；剩余折叠成一行计数（票面 #251 验收 3/5）。
  const allRows: HubDockRowView[] = []
  for (const session of sessions) {
    for (const row of session.rows) allRows.push(row)
  }
  const rows = allRows.slice(0, maxRows)
  const foldedCount = Math.max(0, allRows.length - rows.length)

  const tone: HubDockTone = failed > 0 ? 'warn' : 'busy'
  let statusText = ''
  if (visible) {
    statusText =
      activeInstall !== null
        ? copyText('batch.row-action.installing', lang)
        : copyText('batch.summary.installing', lang, { n: sessions.length })
  }
  const failureText = failed > 0 ? copyText('batch.summary.failed', lang, { n: failed }) : ''
  const restartText = restartCount > 0 ? copyText('batch.summary.restart', lang, { n: restartCount }) : ''
  const summaryText = [statusText, failureText, restartText].filter(Boolean).join('  ')

  return {
    visible,
    title: visible ? title : '',
    tone,
    percent,
    total,
    done,
    failed,
    skipped,
    current,
    restartCount,
    activeSessions: sessions.length,
    sessionsTotal,
    sessions,
    rows,
    foldedCount,
    activeInstall,
    text: total > 0 ? percent + '%' : '',
    statusText,
    failureText,
    restartText,
    summaryText,
  }
}

/** 单个会话的投影：非 running/waiting、无会话编号也无属主、坏形状都回 null（跳过，不抛）。 */
function sessionViewOf(raw: unknown, lang: AppLang): HubDockSessionView | null {
  if (!isRecord(raw)) return null
  const state = activeStateOf(raw['state'])
  if (state === null) return null
  const sessionId = asText(raw['sessionId'])
  const owner = asText(raw['owner'])
  const who = owner !== '' ? owner : sessionId
  if (who === '') return null

  const counts = countsOf(raw)
  const rows = rowsOf(raw, lang)
  let restartCount = 0
  for (const row of rows) {
    if (row.restartRequired) restartCount += 1
  }
  const terminal = counts.done + counts.failed + counts.skipped
  const percent = percentOf(terminal, counts.total)
  const parts: string[] = [who, percent + '%']
  if (counts.total > 0) parts.push(terminal + '/' + counts.total)
  return {
    sessionId,
    owner,
    state,
    total: counts.total,
    done: counts.done,
    failed: counts.failed,
    skipped: counts.skipped,
    current: counts.current,
    pending: counts.pending,
    restartCount,
    rows,
    percent,
    text: parts.join('  '),
  }
}

/** 会话明细行：坏行直接跳过（同行级快照的宽容口径），行数由快照上限决定。 */
function rowsOf(raw: Record<string, unknown>, lang: AppLang): HubDockRowView[] {
  const list = Array.isArray(raw['rows']) ? raw['rows'] : []
  const rows: HubDockRowView[] = []
  for (const value of list) {
    const row = rowViewOf(value, lang)
    if (row !== null) rows.push(row)
  }
  return rows
}

/** 单行投影：没有 key 的行不是目标行（快照里每行必有 key），按坏行跳过。 */
function rowViewOf(value: unknown, lang: AppLang): HubDockRowView | null {
  if (!isRecord(value)) return null
  const key = asText(value['key'])
  if (key === '') return null
  const restartRequired = value['restartRequired'] === true
  const title = asText(value['title'])
  return {
    key,
    title: title !== '' ? title : key,
    phaseText: phaseTextOf(asText(value['phase']), lang, restartRequired),
    versionText: versionTextOf(value),
    errorText: shortErrorOf(value['error']),
    restartRequired,
  }
}

/** 相位 -> 既有文案 key（不新增 key；不认识/空相位给空串，dock 不猜）。 */
function phaseTextOf(phase: string, lang: AppLang, restartRequired: boolean): string {
  switch (phase) {
    case 'checking':
      return copyText('batch.row.checking', lang)
    case 'installing':
      return copyText('batch.row.installing', lang)
    case 'ready':
      return copyText('batch.row.batch-queued', lang)
    case 'pending':
      return copyText('batch.row.wait-turn', lang)
    case 'done':
      return restartRequired ? copyText('batch.row.done-restart', lang) : copyText('batch.row.done', lang)
    case 'current':
      return copyText('batch.row.current', lang)
    case 'failed':
      return copyText('batch.row.failed-retry', lang)
    case 'skipped':
      return copyText('batch.row.skipped-idle', lang)
    default:
      return ''
  }
}

/** 版本箭头：优先「已装 -> 目标」，只有一边就给那一边，都没有给空串（ASCII 箭头，门禁安全）。 */
function versionTextOf(row: Record<string, unknown>): string {
  const installed = asText(row['installedVersion'])
  const target = asText(row['targetVersion']) || asText(row['latestVersion'])
  if (installed !== '' && target !== '') return installed + ' -> ' + target
  if (target !== '') return target
  if (installed !== '') return installed
  return ''
}

/** 失败原因只留短文本（码/一句），超长截断——dock 是状态摘要，不长篇解释。 */
function shortErrorOf(value: unknown): string {
  const text = asText(value)
  if (text === '') return ''
  return text.length > 48 ? text.slice(0, 45) + '...' : text
}

/** 行数上限：坏值/缺省都用 defaultMax，超过 max 夹住（纯函数，挂载层与测试同一口径）。 */
function resolveMaxRows(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return HUB_DOCK_ROWS.defaultMax
  return Math.min(HUB_DOCK_ROWS.max, Math.floor(value))
}

/** 会话读数：优先用快照给的 progress；缺 progress 时按 rows 的 phase 兜底（与 batchProgress 同口径）。 */
function countsOf(raw: Record<string, unknown>): SessionCounts {
  const progress = isRecord(raw['progress']) ? raw['progress'] : null
  if (progress !== null) {
    return {
      total: asCount(progress['total']),
      done: asCount(progress['done']),
      failed: asCount(progress['failed']),
      skipped: asCount(progress['skipped']),
      current: asCount(progress['current']),
      pending: asCount(progress['pending']),
    }
  }
  const rows = Array.isArray(raw['rows']) ? raw['rows'] : []
  const counts: SessionCounts = { total: rows.length, done: 0, failed: 0, skipped: 0, current: 0, pending: 0 }
  for (const row of rows) {
    const phase = isRecord(row) ? row['phase'] : null
    if (phase === 'done' || phase === 'current') counts.done += 1
    else if (phase === 'failed') counts.failed += 1
    else if (phase === 'skipped') counts.skipped += 1
    else if (phase === 'installing' || phase === 'checking' || phase === 'ready') counts.current += 1
    else counts.pending += 1
  }
  return counts
}

interface SessionCounts {
  total: number
  done: number
  failed: number
  skipped: number
  current: number
  pending: number
}

/** 正在进行的安装：pluginId 是必填锚点，坏形状当没有（dock 仍可只靠会话进度显示）。 */
function activeInstallOf(value: unknown): HubDockInstallView | null {
  if (!isRecord(value)) return null
  const pluginId = asText(value['pluginId'])
  if (pluginId === '') return null
  return { pluginId, startedAt: asCount(value['startedAt']) }
}

// ---------- DOM 挂载层 ----------

/** 最小 DOM 面（types:[] 使然）：只声明本组件真正用到的能力。 */
interface HubDockElement {
  className: string
  textContent: string
  readonly firstChild: HubDockElement | null
  readonly style: { width?: string }
  appendChild(node: HubDockElement): unknown
  removeChild(node: HubDockElement): unknown
  addEventListener?(type: string, listener: (event: unknown) => void): void
  removeEventListener?(type: string, listener: (event: unknown) => void): void
  setAttribute?(name: string, value: string): void
}

interface HubDockDocument {
  readonly hidden?: boolean
  createElement(tag: string): HubDockElement
  addEventListener?(type: string, listener: (event: unknown) => void): void
  removeEventListener?(type: string, listener: (event: unknown) => void): void
  readonly head?: HubDockStyleParent | null
}

interface HubDockStyleParent {
  appendChild(node: unknown): unknown
}

interface DockParts {
  readonly doc: HubDockDocument
  readonly mountAs: HubDockMountAs
  readonly root: HubDockElement
  readonly head: HubDockElement
  readonly title: HubDockElement
  readonly percent: HubDockElement
  readonly fill: HubDockElement
  readonly meta: HubDockElement
  readonly rows: HubDockElement
  readonly folded: HubDockElement
  readonly toggle: HubDockElement
  readonly list: HubDockElement
}

/** 挂载期的展示状态（不放进纯视图模型：折叠/空闲是否隐藏是接线选择，不是数据）。 */
interface DockChrome {
  readonly hideWhenIdle: boolean
  readonly collapsed: boolean
}

/** 每个 document 只注入一次样式（多个 dock 共用一份；dispose 不摘，后来的挂载点还能直接用）。 */
const styledDocuments = new WeakSet<HubDockDocument>()

/** 类名前缀 `dsh-hub-dock-`；样式串只含 ASCII（#56 门禁：src 下不许新增中文字符串字面量）。 */
const HUB_DOCK_CSS = [
  '.dsh-hub-dock{position:fixed;z-index:1000;box-sizing:border-box;display:flex;flex-direction:column;gap:6px;width:260px;padding:10px 12px;border:1px solid var(--dsh-update-border,#d7dbe0);border-radius:10px;background:var(--dsh-update-bg,#fff);color:var(--dsh-update-text,#1f2937);font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 6px 20px rgba(15,23,42,.16)}',
  '.dsh-hub-dock-mode-bottom-right{right:16px;bottom:16px}',
  '.dsh-hub-dock-mode-bottom-bar{left:0;right:0;bottom:0;width:auto;border-width:1px 0 0;border-radius:0}',
  '.dsh-hub-dock-mode-inline{position:static;width:100%;max-width:none;border-radius:8px;box-shadow:none}',
  '.dsh-hub-dock-idle{display:none}',
  '.dsh-hub-dock-collapsed .dsh-hub-dock-track,.dsh-hub-dock-collapsed .dsh-hub-dock-rows{display:none}',
  '.dsh-hub-dock-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:0;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
  '.dsh-hub-dock-head:focus-visible{outline:2px solid var(--dsh-update-focus,#2563eb);outline-offset:2px}',
  '.dsh-hub-dock-title{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
  '.dsh-hub-dock-pct{font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}',
  '.dsh-hub-dock-track{position:relative;height:4px;overflow:hidden;border-radius:2px;background:var(--dsh-update-track,#e5e7eb)}',
  '.dsh-hub-dock-fill{display:block;width:0;height:100%;background:var(--dsh-update-primary,#2563eb);transition:width .25s ease}',
  '.dsh-hub-dock-tone-warn .dsh-hub-dock-fill{background:var(--dsh-update-warn-border,#d97706)}',
  '.dsh-hub-dock-meta{overflow-wrap:anywhere;opacity:.9}',
  '.dsh-hub-dock-rows{display:flex;flex-direction:column;gap:2px;max-height:9em;overflow:auto;margin:0;padding:0;list-style:none}',
  '.dsh-hub-dock-row{display:flex;gap:6px;align-items:baseline;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
  '.dsh-hub-dock-row-title{font-weight:600}',
  '.dsh-hub-dock-row-ver{font-variant-numeric:tabular-nums;opacity:.85}',
  '.dsh-hub-dock-row-phase{opacity:.8;overflow:hidden;text-overflow:ellipsis}',
  '.dsh-hub-dock-row-err{color:var(--dsh-update-warn-border,#d97706);overflow:hidden;text-overflow:ellipsis}',
  '.dsh-hub-dock-folded{opacity:.8}',
  '.dsh-hub-dock-toggle{align-self:flex-start;margin:0;padding:0 4px;border:1px solid transparent;border-radius:4px;background:transparent;color:inherit;font:inherit;line-height:1.2;cursor:pointer;opacity:.7}',
  '.dsh-hub-dock-toggle:hover{opacity:1;border-color:var(--dsh-update-border,#d7dbe0)}',
  '.dsh-hub-dock-sessions{display:flex;flex-direction:column;gap:2px;max-height:6.5em;overflow:auto;margin:0;padding:0;list-style:none}',
  '.dsh-hub-dock-session{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
  '@media (prefers-color-scheme: dark){.dsh-hub-dock{background:#111827;border-color:#374151;color:#e5e7eb}}',
  '@media (prefers-reduced-motion: reduce){.dsh-hub-dock-fill{transition:none}}',
].join('')

/**
 * 挂载常驻进度 dock：在 container 里 append 一个自管根节点，按 pollMs 轮询自己那条
 * `<prefix>.updateHubStatus` 并重画；返回 update/dispose。
 *
 * 配置错误（缺 call、prefix 与 phone 都没给、pollMs 越界、mountAs 不认识、容器不可 append）在
 * 挂载期抛 Error（与批量面板 mount 同一口径：错误暴露在接线处，不拖成运行时静默）；数据错误不抛。
 */
export function mountHubProgressDock(container: HubDockContainer, options: HubDockOptions): HubDockController {
  if (!isRecord(options)) {
    throw new Error('[dsh-plugin-update] mountHubProgressDock needs an options object')
  }
  const call = options['call']
  if (typeof call !== 'function') {
    throw new Error('[dsh-plugin-update] mountHubProgressDock needs options.call (the only transport to host phones)')
  }
  const phone = resolvePhone(options)
  const pollMs = resolvePollMs(options)
  const mountAs = resolveMountAs(options)
  const title = typeof options['title'] === 'string' ? options['title'] : ''
  const fixedLang = options['lang'] === undefined ? null : normalizeLangTag(options['lang'])
  const onOpen = typeof options['onOpen'] === 'function' ? options['onOpen'] : null
  const hideWhenIdle = options['hideWhenIdle'] !== false
  const maxRows = resolveMaxRows(options['maxRows'])
  let collapsed = options['collapsed'] === true
  const target = resolveMountTarget(container)
  const host = target.host
  const doc = target.doc

  /** 折叠/空闲是挂载实例的本地状态（不是数据）：每次重画时取当前值。 */
  function chromeNow(): DockChrome {
    return { hideWhenIdle, collapsed }
  }

  ensureDockStyle(doc, host)
  const parts = createDockParts(doc, mountAs, chromeNow())
  host.appendChild(parts.root)

  let disposed = false
  let timer: unknown = null
  let inFlight: Promise<void> | null = null
  let rerun = false
  let lastView: HubDockViewModel | null = null

  /** 每次重解语言：切语言后下一次刷新即可生效，不用重挂载。 */
  function langNow(): AppLang {
    return fixedLang !== null ? fixedLang : resolveLang()
  }

  function paintReply(reply: unknown): void {
    // 失败回包/坏形状一律保持上一次画面：dock 是进度指示器，不替面板报错。
    // snapshot 缺失/非对象也归入坏形状：合法空快照是对象（sessions: []），不能把 null 当空闲画。
    if (!isRecord(reply) || reply['ok'] !== true || !isRecord(reply['snapshot'])) return
    const view = hubDockViewModel(reply['snapshot'], { title, lang: langNow(), maxRows })
    lastView = view
    paintDock(parts, view, chromeNow())
  }

  function update(): Promise<void> {
    if (disposed) return Promise.resolve()
    if (inFlight !== null) {
      rerun = true
      return inFlight
    }
    inFlight = (async (): Promise<void> => {
      let reply: unknown = null
      try {
        reply = await call(phone, {})
      } catch {
        reply = null
      }
      if (disposed) return
      try {
        paintReply(reply)
      } catch {
        // 绘制失败不抛给调用方：坏 DOM 不该打断轮询。
      }
    })()
    return inFlight.then(() => {
      inFlight = null
      if (rerun && !disposed) {
        rerun = false
        void update()
      }
    })
  }

  function schedule(): void {
    if (disposed || timer !== null || doc.hidden === true) return
    timer = scheduleTimer(() => {
      timer = null
      void tick()
    }, pollMs)
  }

  async function tick(): Promise<void> {
    await update()
    schedule()
  }

  function onVisibilityChange(): void {
    if (disposed) return
    if (doc.hidden === true) {
      if (timer !== null) {
        cancelTimer(timer)
        timer = null
      }
      return
    }
    if (timer === null) void tick()
  }

  const onHeadClick = (): void => {
    if (disposed || onOpen === null) return
    try {
      onOpen()
    } catch {
      // 集成方回调抛错不连坐 dock。
    }
  }

  /** 折叠是纯本地视图状态：不触发轮询、不写盘，重画一次即可。 */
  const onToggle = (): void => {
    if (disposed) return
    collapsed = !collapsed
    parts.toggle.textContent = collapsed ? '+' : '-'
    setAttribute(parts.toggle, 'aria-expanded', collapsed ? 'false' : 'true')
    if (lastView !== null) paintDock(parts, lastView, chromeNow())
  }

  doc.addEventListener?.('visibilitychange', onVisibilityChange)
  if (onOpen !== null) parts.head.addEventListener?.('click', onHeadClick)
  parts.toggle.addEventListener?.('click', onToggle)

  // 先按空闲画（不占空间），再拉第一拍；页面本来就隐藏时等 visibilitychange 再拉（真暂停）。
  paintDock(parts, hubDockViewModel(null, { title, lang: langNow(), maxRows }), chromeNow())
  if (doc.hidden !== true) void tick()

  return {
    update,
    refresh: update,
    dispose(): void {
      if (disposed) return
      disposed = true
      rerun = false
      lastView = null
      if (timer !== null) {
        cancelTimer(timer)
        timer = null
      }
      doc.removeEventListener?.('visibilitychange', onVisibilityChange)
      parts.head.removeEventListener?.('click', onHeadClick)
      parts.toggle.removeEventListener?.('click', onToggle)
      try {
        host.removeChild(parts.root)
      } catch {
        // 容器可能已被调用方整体清空：摘不掉就算了，状态已经停住。
      }
    },
  }
}

// ---------- DOM 挂载层内部件 ----------

function resolvePhone(options: Record<string, unknown>): string {
  const explicit = asText(options['phone'])
  if (explicit !== '') return explicit
  const rawPrefix = options['prefix']
  if (typeof rawPrefix === 'string' && rawPrefix !== '') {
    return assertPrefix(rawPrefix, 'hub dock prefix') + HUB_STATUS_PHONE_SUFFIX
  }
  throw new Error(
    '[dsh-plugin-update] mountHubProgressDock needs options.prefix or options.phone to address the updateHubStatus phone',
  )
}

function resolvePollMs(options: Record<string, unknown>): number {
  const raw = options['pollMs']
  if (raw === undefined) return HUB_DOCK_POLL.defaultMs
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < HUB_DOCK_POLL.minMs) {
    throw new Error(
      '[dsh-plugin-update] hub dock pollMs must be a finite number >= ' +
        String(HUB_DOCK_POLL.minMs) +
        ' (got ' +
        JSON.stringify(raw) +
        ')',
    )
  }
  return Math.floor(raw)
}

function resolveMountAs(options: Record<string, unknown>): HubDockMountAs {
  const raw = options['mountAs']
  if (raw === undefined) return 'bottom-right'
  if (raw === 'bottom-right' || raw === 'bottom-bar' || raw === 'inline') return raw
  throw new Error(
    '[dsh-plugin-update] hub dock mountAs must be bottom-right, bottom-bar or inline (got ' +
      JSON.stringify(raw) +
      ')',
  )
}

function asContainer(value: unknown): HubDockContainer | null {
  if (!isRecord(value)) return null
  if (typeof value['appendChild'] !== 'function' || typeof value['removeChild'] !== 'function') return null
  return value as unknown as HubDockContainer
}

/** 挂载目标：容器必须能 append/remove，document 必须能 createElement（错误都在挂载期抛出）。 */
function resolveMountTarget(container: unknown): { host: HubDockContainer; doc: HubDockDocument } {
  const host = asContainer(container)
  if (host === null) {
    throw new Error('[dsh-plugin-update] mountHubProgressDock needs a container with appendChild/removeChild')
  }
  const doc = documentOf(host)
  if (doc === null) {
    throw new Error('[dsh-plugin-update] mountHubProgressDock needs a document (container.ownerDocument or globalThis.document)')
  }
  return { host, doc }
}

function documentOf(container: HubDockContainer): HubDockDocument | null {
  const own = container.ownerDocument
  if (isDocumentLike(own)) return own
  const globalDocument = (globalThis as unknown as { document?: unknown }).document
  return isDocumentLike(globalDocument) ? globalDocument : null
}

function isDocumentLike(value: unknown): value is HubDockDocument {
  if (!isRecord(value)) return false
  return typeof value['createElement'] === 'function'
}

function ensureDockStyle(doc: HubDockDocument, container: HubDockContainer): void {
  if (styledDocuments.has(doc)) return
  styledDocuments.add(doc)
  const style = doc.createElement('style')
  style.textContent = HUB_DOCK_CSS
  const head = doc.head
  if (head !== undefined && head !== null && typeof head.appendChild === 'function') {
    head.appendChild(style)
    return
  }
  // 没有 head 的极简宿主：样式与根节点同容器，仍只注入一次。
  container.appendChild(style)
}

function createDockParts(doc: HubDockDocument, mountAs: HubDockMountAs, chrome: DockChrome): DockParts {
  const root = doc.createElement('div')
  root.className = rootClassOf(mountAs, 'busy', true, chrome)
  setAttribute(root, 'role', 'status')
  setAttribute(root, 'aria-live', 'polite')

  const head = doc.createElement('button')
  head.className = 'dsh-hub-dock-head'
  setAttribute(head, 'type', 'button')

  const title = doc.createElement('span')
  title.className = 'dsh-hub-dock-title'
  const percent = doc.createElement('span')
  percent.className = 'dsh-hub-dock-pct'
  head.appendChild(title)
  head.appendChild(percent)

  const track = doc.createElement('div')
  track.className = 'dsh-hub-dock-track'
  const fill = doc.createElement('span')
  fill.className = 'dsh-hub-dock-fill'
  track.appendChild(fill)

  const meta = doc.createElement('div')
  meta.className = 'dsh-hub-dock-meta'
  const rows = doc.createElement('ul')
  rows.className = 'dsh-hub-dock-rows'
  const folded = doc.createElement('div')
  folded.className = 'dsh-hub-dock-folded'
  const list = doc.createElement('ul')
  list.className = 'dsh-hub-dock-sessions'

  const toggle = doc.createElement('button')
  toggle.className = 'dsh-hub-dock-toggle'
  setAttribute(toggle, 'type', 'button')
  toggle.textContent = chrome.collapsed ? '+' : '-'
  setAttribute(toggle, 'aria-expanded', chrome.collapsed ? 'false' : 'true')

  root.appendChild(head)
  root.appendChild(track)
  root.appendChild(meta)
  root.appendChild(rows)
  root.appendChild(folded)
  root.appendChild(list)
  root.appendChild(toggle)
  return { doc, mountAs, root, head, title, percent, fill, meta, rows, folded, toggle, list }
}

function paintDock(parts: DockParts, view: HubDockViewModel, chrome: DockChrome): void {
  parts.root.className = rootClassOf(parts.mountAs, view.tone, !view.visible, chrome)
  if (!view.visible) {
    parts.title.textContent = chrome.hideWhenIdle ? '' : view.title
    parts.percent.textContent = ''
    parts.fill.style.width = '0%'
    parts.meta.textContent = ''
    parts.folded.textContent = ''
    clearChildren(parts.rows)
    clearChildren(parts.list)
    return
  }
  parts.title.textContent = view.title
  parts.percent.textContent = view.percent + '%'
  parts.fill.style.width = view.percent + '%'
  parts.meta.textContent = view.summaryText
  parts.folded.textContent = view.foldedCount > 0 ? '+' + view.foldedCount : ''
  paintRows(parts, view)
  // 会话明细：有行级数据时不再重复画属主摘要行；只有快照没给行时才退回它。
  clearChildren(parts.list)
  if (view.rows.length === 0) {
    for (const session of view.sessions) {
      const item = parts.doc.createElement('li')
      item.className = 'dsh-hub-dock-session'
      item.textContent = session.text
      parts.list.appendChild(item)
    }
  }
}

/** 行级明细：标题 / 版本箭头 / 相位人话 / 失败码；空文本的 span 不 append（少一半 DOM）。 */
function paintRows(parts: DockParts, view: HubDockViewModel): void {
  clearChildren(parts.rows)
  for (const row of view.rows) {
    const item = parts.doc.createElement('li')
    item.className = 'dsh-hub-dock-row' + (row.errorText !== '' ? ' dsh-hub-dock-row-failed' : '')
    appendSpan(parts.doc, item, 'dsh-hub-dock-row-title', row.title)
    appendSpan(parts.doc, item, 'dsh-hub-dock-row-ver', row.versionText)
    appendSpan(parts.doc, item, 'dsh-hub-dock-row-phase', row.phaseText)
    appendSpan(parts.doc, item, 'dsh-hub-dock-row-err', row.errorText)
    parts.rows.appendChild(item)
  }
}

function appendSpan(doc: HubDockDocument, parent: HubDockElement, className: string, text: string): void {
  if (text === '') return
  const span = doc.createElement('span')
  span.className = className
  span.textContent = text
  parent.appendChild(span)
}

function rootClassOf(mountAs: HubDockMountAs, tone: HubDockTone, idle: boolean, chrome: DockChrome): string {
  const classes = ['dsh-hub-dock', 'dsh-hub-dock-mode-' + mountAs]
  if (idle && chrome.hideWhenIdle) classes.push('dsh-hub-dock-idle')
  else if (idle) classes.push('dsh-hub-dock-empty')
  else classes.push('dsh-hub-dock-tone-' + tone)
  if (chrome.collapsed) classes.push('dsh-hub-dock-collapsed')
  return classes.join(' ')
}

function clearChildren(element: HubDockElement): void {
  while (element.firstChild !== null) element.removeChild(element.firstChild)
}

function setAttribute(element: HubDockElement, name: string, value: string): void {
  try {
    element.setAttribute?.(name, value)
  } catch {
    // 属性只是锦上添花（role/aria/type），拿不到不算失败。
  }
}

// ---------- 定时器（Node 与浏览器共用全局实现；Node 里顺手 unref，别把进程钉住） ----------

function scheduleTimer(fn: () => void, ms: number): unknown {
  const g = globalThis as unknown as { setTimeout: (callback: () => void, delay: number) => unknown }
  const handle = g.setTimeout(fn, ms)
  try {
    const unref = (handle as { unref?: unknown } | null | undefined)?.unref
    if (typeof unref === 'function') (unref as () => void).call(handle)
  } catch {
    // unref 拿不到就算了，定时器照常跑。
  }
  return handle
}

function cancelTimer(handle: unknown): void {
  try {
    const g = globalThis as unknown as { clearTimeout: (timer: unknown) => void }
    g.clearTimeout(handle)
  } catch {
    // 定时器已经触发/环境不支持：忽略。
  }
}

// ---------- 宽容读取件- ----------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function activeStateOf(value: unknown): HubSessionState | null {
  return value === 'running' || value === 'waiting' ? value : null
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 计数口径：有限非负数取整；坏值一律 0（快照从不给负数，这里只是不许坏数据变成 NaN 进 UI）。 */
function asCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}

/** 终态占比：total<=0 时 0；夹在 0..100，坏计数不许画出越界宽度。 */
function percentOf(terminal: number, total: number): number {
  if (total <= 0) return 0
  const ratio = Math.round((Math.min(terminal, total) / total) * 100)
  return Math.max(0, Math.min(100, ratio))
}
