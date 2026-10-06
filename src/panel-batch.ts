// src/panel-batch.ts —— 多目标批量更新的面板组件（#25）。
//
// 归属：面板（浏览器）侧。一趟跑产品真代码：吃 <prefix>.batchStatus 的回包，画
// 「总账 + 明细 + 动作」三层；某一行展开时复用单插件内核（renderUpdatePanelHTML），
// 不为多插件再写一套详情渲染。
//
// 契约（宿主侧按它写，见 src/host-batch.ts）：
//   status/check/install/resume/cancel 五个电话，回包统一形状：
//     { ok: true, session: BatchSession, rows: BatchRowView[], progress: BatchProgress }
//     { ok: false, error, errorKind }
//   面板侧实际打出的五个电话（名字只从 buildBatchPhoneNames 来，不写字面量）：
//     <p>.batchStatus  {}                 挂载即查、按 pollMs 轮询
//     <p>.batchCheck   {}                 「检查更新」
//     <p>.batchInstall {}                 「全部更新」（不点 keys 即「全部提交」语义）
//     <p>.batchInstall { keys: [key] }     行内「安装这家」/「重试」只推这一家
//     <p>.batchResume  {} / <p>.batchCancel {}   「接着上次」/「取消这一批」
//
// 信息架构（第一性：多插件场景用户只问有没有事 / 是哪几家 / 我要做什么）：
//   ① 总账：一句话（有没有事）+ 分类计数（可更新/安装中/待查/待重启/失败/已跳过/已最新）；
//   ② 明细：一行一家（状态灯 + 中文名 + 当前版本 → 远端版本 + 一句可执行的状态词 + 行内动作）；
//   ③ 动作：顶部两件宏（检查更新/全部更新）+ 行内（安装这家/重试/重启宿主/详情）。
//   一行只回答一个问题：这家的**下一步**是什么。状态词一律中文可执行，不写相位英文。
//   待重启与失败走常驻横幅，不藏进抽屉。
//
// 忙守卫：任一行 installing（或本面板正有一次电话在飞）→「检查更新」「全部更新」一起置灰，
//   与单插件面板同一口径（同一使用范围一次只安装一个，禁止并发提交）。
// 详情：复用单插件内核 renderUpdatePanelHTML（embedded + actions:'none' 只读渲染，内核不画动作按钮）；
//   动作行由批量面板自己出（data-act，与行内同一通道：安装／重试、跳过／恢复、复制手工命令、复制诊断）。
//   内核里残留的 data-action 控件（03 章队列开关不在 actions 缝里）整颗摘掉——详情里绝不留「可点没人接」的死按钮。
//   详情不嵌套滚动（CSS 显式中和 overlay 的 max-height/overflow）。
// 卸载：只停轮询、只拆监听，绝不发安装/取消电话（安装在宿主进程内继续跑）。
//
// 本文件零 Node 专属能力（不读盘、不起进程、不拼 shell）：Node 宿主与浏览器闭包两边都跑得动；
// DOM 只在 mountUpdateBatchPanel 被调用时经容器与 globalThis 现取，模块顶层不碰。

import { assertPrefix, MIN_PANEL_POLL_MS } from './config.js'
import { copyText as bilingualText, type BilingualKey } from './bilingual.js'
import { normalizeLangTag, resolveLang, subscribeLang, type AppLang, type LocaleOption } from './lang.js'
import { validReleaseVersion } from './service.js'
import { shouldFetchChangelog } from './changelog.js'
import {
  isTerminalPhase,
  normalizeBatchSession,
  type BatchPhase,
  type BatchSession,
} from './batch.js'
import {
  UPDATE_PANEL_CSS,
  UPDATE_PANEL_ARCHIVE_CSS,
  buildDiagnosticText,
  createBrowserSkipStore,
  failureCopy,
  isKnownFailureCode,
  normalizePanelTheme,
  renderUpdatePanelHTML,
  type PanelDiagnosticInput,
  type PanelSkipStore,
  type UpdatePanelTheme,
} from './panel.js'
import type { UpdateSnapshot } from './ports.js'
import type { VisibleQueue } from './queue.js'

// ---------- 公开类型 ----------

/** 一行要画的东西（宿主回包里的形状）。 */
export interface BatchRowView {
  key: string
  title: string
  /** 会话相位：pending/checking/ready/installing/current/done/failed/skipped（认不出按 pending）。 */
  phase: string
  targetVersion: string | null
  restartRequired: boolean
  error: string | null
  /** 该行的单插件快照（展开详情与「安装这家」按钮的门控都用它）。 */
  snapshot: unknown
  manual?: string | null
  queue?: unknown
  profileName?: string | null
  /** 该行的插件标识（跳过存储与诊断文本用；缺省用 key）。宿主侧后补字段，缺了照样跑。 */
  pluginId?: string | null
  /** 该行的诊断详情（宿主给就带上；没有就不带）。 */
  diag?: unknown
  /** 宿主种类（进诊断文本；缺省说人话）。 */
  hostKind?: string | null
  /** 该家单插件三电话的名字（取消排队要用它自己的安装电话；老宿主不给就不给取消入口）。 */
  phoneNames?: unknown
}

/** 摆放形态：默认内嵌，切弹窗走同一参数（与单插件面板同一套写法）。 */
export type BatchPanelMode = 'embedded' | 'dialog'

/** 批量面板的挂载参数。 */
export interface BatchPanelOptions {
  /** 批量电话前缀（与宿主一致）。 */
  prefix: string
  /** 调宿主电话：(phoneName, args) => Promise<reply>。 */
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>
  /** 主题：与单插件面板同一套（缺省 default）。 */
  theme?: UpdatePanelTheme
  /** 摆放形态：内嵌或弹窗（缺省 embedded）。 */
  mode?: BatchPanelMode
  /** 轮询间隔（毫秒，缺省 1500，下限 250）。 */
  pollMs?: number
  /** 可选：键 -> 中文名覆盖。 */
  titles?: Record<string, string>
  /**
   * 「重启宿主」的落地（与单插件面板同一口径）：不传就只提示手动重启，不假装能重启。
   */
  onRestartRequested?: () => void | Promise<void>
  /** 复制文本的出口（与单插件面板同一口径）：不传即试浏览器剪贴板，都没有也不抛错。 */
  copyText?: (text: string) => void | Promise<void>
  /**
   * 详情行自动取日志（#38）：默认开。展开行有新版时调该行自己的更新日志电话按需取；
   * 老宿主没给行电话名即回中性提示；false 关闭。
   */
  autoChangelog?: boolean
  /**
   * 弹窗关闭的落地（与单插件面板同一口径）：只在 dialog 下点「关闭」/按 Esc 时调用；调用方在此撤掉弹窗 DOM。
   * 不传则回退为只停轮询（unmount），DOM 留给调用方处理。入口件打开的 dialog 已内置（收 dialog + 还原按钮）。
   */
  onCloseRequested?: () => void | Promise<void>
  /**
   * 语言覆盖（#59 起消费：新文案走集中字典单语渲染；既有散落文案保持基线不变）。
   * 形态与入口件一致：'zh' | 'en' | { getActive(): string; subscribe?(cb): () => void }。
   */
  locale?: unknown
  /**
   * 打开面板自动查（#59 D3）：缺省 true。false 即手动挡（行为回今天，只修文案）。
   * 优先级：用户偏好（prefs.json）> 本选项 > 缺省。
   */
  checkOnOpen?: boolean
  /**
   * 自动继续未终态轮次（#59 Q3：与显式按钮并存，常开）。false 可关（测试与特殊集成用）。
   */
  autoResume?: boolean
}

/** 面板可点的动作（HTML 上 data-act 一一对应；测试走同一条路）。 */
export type BatchPanelActionKind =
  | 'check'
  | 'install'
  | 'resume'
  | 'cancel'
  | 'row-install'
  | 'row-skip'
  | 'row-resume-skip'
  | 'row-cancel-queue'
  | 'row-copy-manual'
  | 'row-copy-diag'
  | 'toggle-details'
  | 'restart'
  | 'close'
  | 'toggle-check-on-open'

/** 挂载点：只要有 innerHTML 的容器即可（浏览器元素或测试替身都行）。 */
export interface BatchPanelContainer {
  innerHTML: string
  addEventListener?: (type: string, listener: (ev: unknown) => void) => void
  removeEventListener?: (type: string, listener: (ev: unknown) => void) => void
}

/** 批量面板控制器（与契约桩同名同义；act 多收一个可选 key，供行内动作指认某一家）。 */
export interface BatchPanelController {
  refresh(): Promise<void>
  act(action: BatchPanelActionKind, key?: string): Promise<void>
  setTheme(theme: UpdatePanelTheme): void
  setMode(mode: BatchPanelMode): void
  unmount(): void
}

/** 批量七个电话名（与宿主侧 MultiHostUpdate.phoneNames 同一形状）。 */
export interface BatchPhoneNames {
  status: string
  check: string
  install: string
  resume: string
  cancel: string
  prefs: string
  prefsSave: string
}

/** 批量面板轮询口径（默认 1.5 秒、下限 250 毫秒，与单插件面板同一套下限）。 */
export const BATCH_PANEL_POLL = {
  defaultMs: 1500,
  minMs: MIN_PANEL_POLL_MS,
} as const

/** 批量电话名拼法：前缀 + 七个固定动作名（前缀形状校验与单插件面板同一套）。 */
export function buildBatchPhoneNames(prefix: string): BatchPhoneNames {
  const p = assertPrefix(prefix, '批量电话前缀 prefix')
  return {
    status: p + '.batchStatus',
    check: p + '.batchCheck',
    install: p + '.batchInstall',
    resume: p + '.batchResume',
    cancel: p + '.batchCancel',
    prefs: p + '.batchPrefs',
    prefsSave: p + '.batchPrefsSave',
  }
}

// ---------- 总账（一句话 + 分类计数：面板与门禁共用同一份口径） ----------

export interface BatchLedgerCounts {
  /** phase=ready：有新版、还没安装。 */
  updatable: number
  /** phase=installing：正在安装。 */
  installing: number
  /** phase=pending/checking：还没轮到/正在查。 */
  pending: number
  /** 安装好了但要重启宿主才生效（终态之外的一档，单独数）。 */
  restart: number
  /** phase=failed。 */
  failed: number
  /** phase=skipped。 */
  skipped: number
  /** phase=current/done 且不用重启：真的没事了。 */
  settled: number
}

/**
 * 从行上数分类账（每行恰好进一档，七档之和 === 行数）：
 * 失败优先（失败行永远算失败，不算待重启）；其余按相位落档；不用重启的终态才算「已最新」。
 * 例外一处：「忙失败占位」（phase=failed 但 error=update-busy）其实是**排队**不是失败——
 * 宿主忙时先写占位再回 update-busy，面板把它翻回「可更新」，免得总账把它报成失败。
 */
export function batchLedgerCounts(rows: readonly BatchRowView[]): BatchLedgerCounts {
  const counts: BatchLedgerCounts = {
    updatable: 0,
    installing: 0,
    pending: 0,
    restart: 0,
    failed: 0,
    skipped: 0,
    settled: 0,
  }
  for (const row of rows) {
    const phase = asBatchPhase(row.phase)
    if (isQueueBusyRow(row)) counts.updatable += 1
    else if (phase === 'failed') counts.failed += 1
    else if (phase === 'installing') counts.installing += 1
    else if (phase === 'ready') counts.updatable += 1
    else if (phase === 'pending' || phase === 'checking') counts.pending += 1
    else if (phase === 'skipped') counts.skipped += 1
    else if (row.restartRequired === true) counts.restart += 1
    else counts.settled += 1
  }
  return counts
}

/** 分类计数 → 一句话总账（只出现非零档，顺序固定：可更新 · 安装中 · 待查 · 待重启 · 失败 · 已跳过 · 已最新；#64 单语：缺省 zh 零回归）。 */
export function batchLedgerText(counts: BatchLedgerCounts, lang?: unknown): string {
  const l = langOf(lang)
  const parts: string[] = []
  if (counts.updatable > 0) parts.push(batchText('batch.summary.updatable', l, { n: String(counts.updatable) }))
  if (counts.installing > 0) parts.push(batchText('batch.summary.installing', l, { n: String(counts.installing) }))
  if (counts.pending > 0) parts.push(batchText('batch.summary.pending', l, { n: String(counts.pending) }))
  if (counts.restart > 0) parts.push(batchText('batch.summary.restart', l, { n: String(counts.restart) }))
  if (counts.failed > 0) parts.push(batchText('batch.summary.failed', l, { n: String(counts.failed) }))
  if (counts.skipped > 0) parts.push(batchText('batch.summary.skipped', l, { n: String(counts.skipped) }))
  if (counts.settled > 0) parts.push(batchText('batch.summary.settled', l, { n: String(counts.settled) }))
  return parts.length > 0 ? parts.join(' · ') : batchText('batch.summary.empty', l)
}

/**
 * 排队中的状态词：只回答「还要等多久」。位置从该行的队列视图来。
 * queue.ts 的 position 是 waiting 顺位（队首为 1、0 = 自己正在装），而正在装的那一家也压在这一家前面，
 * 所以「前方 N 个」= position N（队首那家前方正好 1 个：正在装的拥有者）。
 * 位置取不到（宿主只记了忙、没给占位读数）就说「等前面安装完」，不猜数字。
 */
export function batchQueuedStatus(position: number | null, lang?: unknown): string {
  const l = langOf(lang)
  if (typeof position !== 'number' || !Number.isFinite(position) || position < 1) return batchText('batch.row.queued-generic', l)
  return batchText('batch.row.queued-n', l, { n: String(position) })
}

/** 知识账本里的一行（只做展示，不参与安装决策）。 */
export interface BatchKnowledgeEntry {
  lastCheckedAt: number
  installedVersion: string | null
  latestVersion: string | null
  canInstall: boolean | null
  error: string | null
}

function knowledgeEntryOf(inventory: unknown, key: string): BatchKnowledgeEntry | null {
  if (!isObject(inventory)) return null
  const entries = (inventory as Record<string, unknown>)['entries']
  if (!isObject(entries)) return null
  const item = (entries as Record<string, unknown>)[key]
  if (!isObject(item)) return null
  const e = item as Record<string, unknown>
  const canInstallRaw = e['canInstall']
  return {
    lastCheckedAt: typeof e['lastCheckedAt'] === 'number' ? (e['lastCheckedAt'] as number) : 0,
    installedVersion: typeof e['installedVersion'] === 'string' ? (e['installedVersion'] as string) : null,
    latestVersion: typeof e['latestVersion'] === 'string' ? (e['latestVersion'] as string) : null,
    canInstall: typeof canInstallRaw === 'boolean' ? canInstallRaw : null,
    error: typeof e['error'] === 'string' ? (e['error'] as string) : null,
  }
}

function langOf(lang: unknown): AppLang {
  try {
    return normalizeLangTag(typeof lang === 'string' ? lang : resolveLang(lang as LocaleOption))
  } catch {
    return 'zh'
  }
}

function batchText(key: BilingualKey, lang: unknown, values?: Record<string, unknown>): string {
  try {
    return bilingualText(key, langOf(lang), values)
  } catch {
    return ''
  }
}

/** 有未终态行（控制区出现条件：盘上有没做完的一轮）。 */
export function hasUnfinishedRows(rows: readonly BatchRowView[], session?: unknown): boolean {
  if (isObject(session)) {
    const entries = (session as Record<string, unknown>)['entries']
    if (Array.isArray(entries)) {
      for (const item of entries) {
        if (!isObject(item)) continue
        const phase = (item as Record<string, unknown>)['phase']
        if (typeof phase === 'string' && !isTerminalPhase(asBatchPhase(phase))) return true
      }
      return false
    }
  }
  if (rows.length === 0) return false
  return !rows.every((row) => isTerminalPhase(asBatchPhase(row.phase)))
}

export function unfinishedCount(rows: readonly BatchRowView[], session?: unknown): number {
  if (isObject(session)) {
    const entries = (session as Record<string, unknown>)['entries']
    if (Array.isArray(entries)) {
      let n = 0
      for (const item of entries) {
        if (!isObject(item)) continue
        const phase = (item as Record<string, unknown>)['phase']
        if (typeof phase === 'string' && !isTerminalPhase(asBatchPhase(phase))) n += 1
      }
      return n
    }
  }
  return rows.filter((row) => !isTerminalPhase(asBatchPhase(row.phase))).length
}

/**
 * 一行的状态词：只回答一个问题——这家的**下一步**是什么。
 * 中文可执行，不写相位英文（相位只留在 data-phase 属性上，给人看的这句永远是动作）。
 * （#59 D2：调用方在无轮次 + 有知识时优先用 batchRowKnowledgeText；本函数语义冻结，旧快照不动。）
 */
export function batchRowStatus(row: BatchRowView, skippedVersion?: string | null, lang?: unknown): string {
  const l = langOf(lang)
  const skipped = typeof skippedVersion === 'string' && skippedVersion ? skippedVersion : null
  if (skipped !== null && asBatchPhase(row.phase) === 'ready') return batchText('batch.row.skipped', l, { version: skipped })
  switch (asBatchPhase(row.phase)) {
    case 'pending':
      return batchText('batch.row.wait-turn', l)
    case 'checking':
      return batchText('batch.row.checking', l)
    case 'ready':
      return row.targetVersion
      ? batchText('batch.row.cta-version', l, { version: row.targetVersion })
      : batchText('batch.row.cta-generic', l)
    case 'installing':
      return batchText('batch.row.installing', l)
    case 'current':
      return batchText('batch.row.current', l)
    case 'done':
      return row.restartRequired === true ? batchText('batch.row.done-restart', l) : batchText('batch.row.done', l)
    case 'failed':
      return batchText('batch.row.failed-retry', l)
    case 'skipped':
      return batchText('batch.row.skipped-idle', l)
    default:
      return batchText('batch.row.unknown', l)
  }
}

/**
 * 无轮次时的知识行（#59 D2）：pending + 有知识即按知识展示；有轮次未做完仍走执行态。
 * 无知识（从没查过）回 null，调用方回退旧 pending 文案。
 */
export function batchRowKnowledgeText(row: BatchRowView, entry: BatchKnowledgeEntry | null, lang?: unknown): string | null {
  if (asBatchPhase(row.phase) !== 'pending' || !entry) return null
  if (entry.error) return batchText('batch.row.failed', lang)
  if (entry.latestVersion && entry.installedVersion && entry.latestVersion !== entry.installedVersion) {
    return batchText('batch.row.update', lang, { version: entry.latestVersion })
  }
  if (entry.latestVersion && entry.installedVersion && entry.latestVersion === entry.installedVersion) {
    return batchText('batch.row.current', lang)
  }
  if (entry.latestVersion && !entry.installedVersion) {
    return batchText('batch.row.update', lang, { version: entry.latestVersion })
  }
  if (entry.lastCheckedAt > 0) return batchText('batch.row.current', lang)
  return batchText('batch.row.never', lang)
}

// ---------- 渲染（纯函数：同一输入 → 同一份 HTML） ----------

export interface BatchPanelRenderInput {
  rows?: readonly BatchRowView[]
  theme?: UpdatePanelTheme
  mode?: BatchPanelMode
  /** 当前展开的那一家（键）；null 即全部收起。 */
  expandedKey?: string | null
  /** 批量电话本身失败的稳定码（ok:false 或抛错）。 */
  lastError?: string | null
  /** 本地提示（重启入口、取消结果之类）。 */
  notice?: string | null
  /** 面板正有一次电话在飞（本地忙守卫的一半）。 */
  inFlight?: boolean
  /** 「取消这一批」已点过一次：按钮换确认文案，再点一次才真取消（防误触）。 */
  confirmCancel?: boolean
  /** 是否已经拿到过第一次回包（决定总账那句是不是「正在读取…」）。 */
  loaded?: boolean
  titles?: Record<string, string>
  /** 键 -> 该家被跳过的版本（挂载侧从跳过存储读出；纯渲染函数不读存储）。 */
  skippedVersions?: Record<string, string | null>
  /** notice 归哪一家：等于某行键时那条回执画在该家详情里（否则画在面板底部）。 */
  noticeKey?: string | null
  /** 键 -> 该行已取到的日志全文（只传有文本的；取不到与没展开即中性提示，不挡安装）。 */
  changelogs?: Record<string, string | null>
  /** 轮次会话（有未终态行才画控制区；不传按行相位回退旧口径，兼容旧快照）。 */
  session?: unknown
  /** 知识账本（无轮次时行按知识展示；只做展示，不参与安装决策）。 */
  inventory?: unknown
  /** 偏好（底部勾选的受控状态；不传不画勾选）。 */
  prefs?: unknown
  /** 语言（单语渲染新文案用；不传跟随全局信号）。 */
  lang?: unknown
}

interface RowRenderContext {
  expanded: boolean
  /** 有人正在装（别家）：本行按钮文案换「加入队列」，但不置灰。 */
  busy: boolean
  /** 本面板正有一次电话在飞：行内动作短暂置灰，防连点。 */
  inFlight: boolean
  theme: UpdatePanelTheme
  titles: Record<string, string>
  /** 这一家被跳过的版本（null = 没跳过）。 */
  skipped: string | null
  /** 展开时挂在详情里的那条回执（复制/跳过之类）；不展开不画。 */
  notice: string | null
  /** 该行已取到的日志全文（null 即中性提示）。 */
  changelogMarkdown: string | null
  /** 单语（新文案渲染用）。 */
  lang: AppLang
  /** 该行的知识条目（无轮次 pending 行按知识展示）。 */
  knowledge: BatchKnowledgeEntry | null
  /** 该行是否在没做完的一轮里（轮次事实小标记用，不改写下一步）。 */
  inRound: boolean
}

/** 整面板 HTML（含样式；重绘即整体替换 innerHTML，故每次都带 style 也只留一份）。 */
export function renderBatchPanelHTML(input: BatchPanelRenderInput): string {
  const rows: readonly BatchRowView[] = Array.isArray(input.rows) ? input.rows : []
  const theme: UpdatePanelTheme = normalizePanelTheme(input.theme)
  const mode: BatchPanelMode = input.mode === 'dialog' ? 'dialog' : 'embedded'
  const titles = input.titles && typeof input.titles === 'object' ? input.titles : {}
  const skippedVersions =
    input.skippedVersions && typeof input.skippedVersions === 'object' ? input.skippedVersions : {}
  const expandedKey = typeof input.expandedKey === 'string' && input.expandedKey ? input.expandedKey : null
  const lastError = typeof input.lastError === 'string' && input.lastError ? input.lastError : null
  const loaded = input.loaded === undefined ? rows.length > 0 : input.loaded === true
  const counts = batchLedgerCounts(rows)
  // 忙分两种：installing = 有人正在装（决定「加入队列」文案）；macroBusy = 再加本地电话在飞（决定宏按钮置灰）。
  const installing = counts.installing > 0
  const macroBusy = input.inFlight === true || installing
  const total = rows.length
  const disabled = macroBusy ? ' disabled' : ''
  const notice = typeof input.notice === 'string' && input.notice ? input.notice : null
  const noticeKey = typeof input.noticeKey === 'string' && input.noticeKey ? input.noticeKey : null
  // 回执挂在该家详情里（那家正展开才算数）；否则落回面板底部那条。
  const detailNoticeKey = notice !== null && noticeKey !== null && noticeKey === expandedKey ? noticeKey : null
  const changelogs = input.changelogs && typeof input.changelogs === 'object' ? input.changelogs : {}
  // #64 单语：渲染语言提前解出，头部宏/总账/横幅/分类账/印章同语言（不传跟随全局信号，缺省 zh）。
  const lang = langOf((input as Record<string, unknown>)['lang'])
  const ctx: RowRenderContext = {
    expanded: false,
    busy: installing,
    inFlight: input.inFlight === true,
    theme,
    titles,
    skipped: null,
    notice: null,
    changelogMarkdown: null,
    lang,
    knowledge: null,
    inRound: false,
  }
  const parts: string[] = []

  // 顶部一行：卷宗抬头 + 两件宏（忙守卫：任一行安装中，两个批量入口一起置灰）。
  parts.push('<div class="dsh-upd-batch-head">')
  parts.push('<div class="dsh-upd-batch-title">' + escapeHtml(batchText('batch.header.title', lang)) + ' · <i>' + escapeHtml(batchText('batch.seal.ledger', lang)) + '</i></div>')
  parts.push('<div class="dsh-upd-batch-macros">')
  parts.push('<button type="button" data-act="check"' + disabled + ' title="' + escapeHtml(batchText('batch.action.check-title', lang)) + '">' + escapeHtml(batchText('batch.action.check', lang)) + '</button>')
  parts.push('<button type="button" data-act="install" data-primary="1"' + disabled + ' title="' + escapeHtml(batchText('batch.action.install-all-title', lang)) + '">' + escapeHtml(batchText('batch.action.install-all', lang)) + '</button>')
  if (mode === 'dialog') parts.push('<button type="button" data-act="close" title="' + escapeHtml(batchText('batch.action.close-title', lang)) + '">' + escapeHtml(batchText('batch.action.close', lang)) + '</button>')
  parts.push('</div>')
  parts.push('</div>')

  // 一句话总账（有没有事）。
  const summary = loaded
    ? batchSummaryText(counts, rows, total, installing, lastError !== null, lang)
    : batchText('batch.banner.loading', lang)
  parts.push('<div class="dsh-upd-batch-sum" role="status" aria-live="polite">' + escapeHtml(summary) + '</div>')

  // 常驻横幅：失败与待重启不藏进抽屉。
  parts.push(bannersHTML(rows, titles, lastError, lang))
  const session = isObject(input.session) ? (input.session as Record<string, unknown>) : null
  const unfinished = unfinishedCount(rows, session ?? undefined)
  const showControls = total > 0 && hasUnfinishedRows(rows, session ?? undefined)
  const prefs = isObject(input.prefs) ? (input.prefs as Record<string, unknown>) : null
  const checkOnOpen = prefs === null ? null : (prefs['checkOnOpen'] === false ? false : true)

  function roundEntryPhase(key: string): string | null {
    if (!session) return null
    const entries = (session as Record<string, unknown>)['entries']
    if (!Array.isArray(entries)) return null
    for (const item of entries) {
      if (!isObject(item)) continue
      const e = item as Record<string, unknown>
      if (e['key'] === key && typeof e['phase'] === 'string') return e['phase'] as string
    }
    return null
  }

  // 明细：一行一家。
  parts.push('<div class="dsh-upd-btable">')
  for (const row of rows) {
    const raw = skippedVersions[row.key]
    const skipped = typeof raw === 'string' && raw ? raw : null
    const expanded = row.key === expandedKey
    const entryPhase = roundEntryPhase(row.key)
    const inRound = entryPhase !== null && !isTerminalPhase(asBatchPhase(entryPhase))
    parts.push(
      rowSetHTML(row, {
        ...ctx,
        expanded,
        skipped,
        notice: expanded && row.key === detailNoticeKey ? notice : null,
        changelogMarkdown:
          expanded && typeof changelogs[row.key] === 'string' ? (changelogs[row.key] as string) : null,
        lang,
        knowledge: asBatchPhase(row.phase) === 'pending' && !inRound ? knowledgeEntryOf(input.inventory, row.key) : null,
        inRound,
      }),
    )
  }
  parts.push('</div>')

  // 表下一行分类总账。
  if (total > 0) {
    parts.push('<div class="dsh-upd-batch-ledger">' + escapeHtml(batchLedgerText(counts, lang)) + '</div>')
  }

  // 断点续跑与取消（有没做完的一轮才有意义；不与顶部两件宏抢位）。
  if (showControls) {
    const more: string[] = []
    more.push(
      '<button type="button" data-act="resume">' +
        escapeHtml(batchText('batch.action.resume', lang, { count: String(unfinished) })) + '</button>',
    )
    // 忙守卫同理：安装中「取消」停不了正在跑的那一家（宿主侧取消只清会话），别给人假动作。
    // 两步确认：第一次只上膛（红框 + 换文案），第二次才真取消；点别的按钮自动卸膛。
    const confirmCancel = input.confirmCancel === true
    const discardLabel = confirmCancel
      ? batchText('batch.action.confirm-discard', lang)
      : batchText('batch.action.discard', lang)
    more.push(
      '<button type="button" data-act="cancel"' + disabled +
        (confirmCancel
          ? ' data-confirm="1" title="' + escapeHtml(batchText('batch.notice.cancel-confirm', lang)) + '"'
          : ' title="' + escapeHtml(batchText('batch.action.discard', lang)) + '"') +
        '>' + escapeHtml(discardLabel) + '</button>',
    )
    parts.push('<div class="dsh-upd-batch-more">' + more.join('') + '</div>')
    parts.push('<div class="dsh-upd-batch-fact" role="note">' + escapeHtml(batchText('batch.fact.close-safe', lang)) + '</div>')
    if (macroBusy) {
      parts.push('<div class="dsh-upd-batch-fact" role="note">' + escapeHtml(batchText('batch.notice.busy-cancel', lang)) + '</div>')
    }
  }
  if (prefs !== null && checkOnOpen !== null) {
    parts.push(
      '<div class="dsh-upd-batch-prefs"><button type="button" data-act="toggle-check-on-open" aria-pressed="' + (checkOnOpen ? 'true' : 'false') + '">' +
        escapeHtml((checkOnOpen ? '[x] ' : '[ ] ') + batchText('batch.setting.check-on-open', lang)) + '</button></div>',
    )
  }
  if (notice !== null && detailNoticeKey === null) {
    parts.push('<div class="dsh-upd-batch-notice" role="status">' + escapeHtml(notice) + '</div>')
  }

  const kernel = parts.join(String.fromCharCode(10))
  // 主题只换肤：默认不带 data-theme、不带 Archive 串；archive 才挂属性并追加两份 Archive 皮肤。
  const archive = normalizePanelTheme(theme) === 'archive'
  const attr = archive ? ' data-theme="archive"' : ''
  const seal = batchSealOf(counts, lang)
  const root =
    '<div class="dsh-upd dsh-upd-batch" data-mode="' + mode + '" data-seal="' + escapeHtml(seal.text) +
    '" data-seal-tone="' + seal.tone + '"' + attr + '>\n' + kernel + '\n</div>'
  const body = mode === 'dialog' ? '<div class="dsh-upd-overlay" data-mode="dialog">' + root + '</div>' : root
  const css = archive
    ? [UPDATE_PANEL_CSS, UPDATE_BATCH_PANEL_CSS, UPDATE_PANEL_ARCHIVE_CSS, UPDATE_BATCH_PANEL_ARCHIVE_CSS].join(String.fromCharCode(10))
    : [UPDATE_PANEL_CSS, UPDATE_BATCH_PANEL_CSS].join(String.fromCharCode(10))
  return '<style>' + css + '</style>\n' + body
}

/** 一句话总账：先答「有没有事」（#64 单语：缺省 zh 零回归）。 */
function batchSummaryText(
  counts: BatchLedgerCounts,
  rows: readonly BatchRowView[],
  total: number,
  installing: boolean,
  hasError: boolean,
  lang?: unknown,
): string {
  const l = langOf(lang)
  if (hasError) return batchText('batch.hint.error', l)
  if (total === 0) return batchText('batch.hint.empty', l)
  if (installing) {
    // 忙不等于别的家不能动：可以排队（入队不算失败），所以这里说的是「还能怎么加进来」。
    const canQueue = rows.filter((row) => asBatchPhase(row.phase) === 'ready' && !isQueuedRow(row)).length
    return canQueue > 0
      ? batchText('batch.hint.installing-queueable', l, { a: String(counts.installing), b: String(canQueue) })
      : batchText('batch.hint.installing-auto', l, { a: String(counts.installing) })
  }
  if (counts.failed > 0) return batchText('batch.hint.failed', l, { n: String(counts.failed) })
  if (counts.updatable > 0)
    return batchText('batch.hint.updatable', l, { n: String(counts.updatable) })
  if (counts.restart > 0) return batchText('batch.hint.restart', l, { n: String(counts.restart) })
  if (counts.pending > 0) return batchText('batch.hint.pending', l, { n: String(counts.pending) })
  return batchText('batch.hint.done', l)
}

/** 印章（Archive 才画）：色调按总账里最重的一档走；文字跟随语言（#64 单语，tone 不入 key）。 */
function batchSealOf(counts: BatchLedgerCounts, lang?: unknown): { text: string; tone: 'ink' | 'green' | 'yellow' | 'red' } {
  const text = batchText('batch.seal.ledger', langOf(lang))
  if (counts.failed > 0) return { text, tone: 'red' }
  if (counts.installing > 0 || counts.restart > 0) return { text, tone: 'yellow' }
  if (counts.updatable > 0) return { text, tone: 'green' }
  return { text, tone: 'ink' }
}

/** 常驻横幅：批量电话失败 / 有失败行 / 有待重启行（都不许藏进抽屉；#64 单语：缺省 zh；data-mini 冻结待 #67 仲裁）。 */
function bannersHTML(rows: readonly BatchRowView[], titles: Record<string, string>, lastError: string | null, lang?: unknown): string {
  const l = langOf(lang)
  const parts: string[] = []
  if (lastError) {
    const copy = failureCopy(lastError, l)
    const detail = copy?.zh ?? failureCopy('unknown', l)?.zh ?? ''
    const act = copy?.act ?? batchText('batch.banner.error-action-fallback', l)
    parts.push(
      '<div class="dsh-upd-banner" data-kind="failed" data-mini="阻" role="status">' +
        '<div><strong>' + escapeHtml(batchText('batch.banner.error-title', l, { code: lastError, detail })) + '</strong></div>' +
        '<div>' + escapeHtml(act) + '</div>' +
        '</div>',
    )
  }
  // 排队占位不算失败：忙时宿主会把它记成 failed+update-busy，这里翻回来。
  const failed = rows.filter((row) => asBatchPhase(row.phase) === 'failed' && !isQueueBusyRow(row))
  if (failed.length > 0) {
    const lines = failed
      .map((row) => {
        const code = row.error || 'install-failed'
        const copy = failureCopy(code, l)
        return (
          '<div>' + escapeHtml(titleOf(row, titles)) + '：<code>' + escapeHtml(code) + '</code> ' +
          escapeHtml(copy?.zh ?? failureCopy('unknown', l)?.zh ?? '') + '</div>'
        )
      })
      .join('')
    parts.push(
      '<div class="dsh-upd-banner" data-kind="failed" data-mini="阻" role="status">' +
        '<div><strong>' + escapeHtml(batchText('batch.banner.failed-title', l, { n: String(failed.length) })) + '</strong></div>' +
        '<div>' + escapeHtml(batchText('batch.banner.failed-action', l)) + '</div>' +
        '<div class="dsh-upd-blist">' + lines + '</div>' +
        '</div>',
    )
  }
  const restart = rows.filter((row) => row.restartRequired === true)
  if (restart.length > 0) {
    parts.push(
      '<div class="dsh-upd-banner" data-kind="restart" role="status">' +
        '<div><strong>' + escapeHtml(batchText('batch.banner.restart-title', l, { n: String(restart.length) })) + '</strong></div>' +
        // 措辞与单插件面板 panel.blocked.pending-restart.action 同一句（#64 按清单独立成 batch.banner.restart-action 键，英文可独立调优）。
        '<div>' + escapeHtml(batchText('batch.banner.restart-action', l)) + '</div>' +
        '<div class="dsh-upd-blist">' + restart.map((row) => escapeHtml(titleOf(row, titles))).join('、') + '</div>' +
        '<div><button type="button" data-act="restart" data-primary="1">' + escapeHtml(batchText('batch.banner.restart-button', l)) + '</button></div>' +
        '</div>',
    )
  }
  return parts.join('')
}

/** 一行一家（含点开时的详情：详情就是单插件内核本身）。 */
function rowSetHTML(row: BatchRowView, ctx: RowRenderContext): string {
  const phase = asBatchPhase(row.phase)
  const keyAttr = escapeHtml(row.key)
  const skipped = ctx.skipped
  const queued = isQueuedRow(row)
  const position = queued ? queuePositionOf(row) : null
  const current = currentVersionOf(row)
  const version = row.targetVersion
    ? (current === null ? '?' : current) + ' → ' + row.targetVersion
    : current === null
      ? ''
      : current
  const actions: string[] = []
  // 忙守卫按行：正在装的那一行禁自己（不许重复提交）；**别的行不灰**——点下去是「加入队列」。
  const off = ctx.inFlight ? ' disabled' : ''
  if (phase === 'installing') {
    actions.push(
      '<button type="button" data-act="row-install" data-key="' + keyAttr + '" disabled>' + escapeHtml(batchText('batch.row-action.installing', ctx.lang)) + '</button>',
    )
  } else if (queued) {
    // 排队那行的下一步是「取消排队」：撤掉自己的占位（别家与正在装的拥有者都不碰）。
    if (cancelQueuePhoneOf(row) !== null && queuedRequestIdOf(row) !== null) {
      actions.push(
        '<button type="button" data-act="row-cancel-queue" data-key="' + keyAttr + '"' + off + '>' + escapeHtml(batchText('batch.row-action.cancel-queue', ctx.lang)) + '</button>',
      )
    }
  } else if (phase === 'ready' && skipped === null) {
    actions.push(
      '<button type="button" data-act="row-install" data-key="' + keyAttr + '" data-primary="1"' + off + '>' +
        escapeHtml(ctx.busy ? batchText('batch.row-action.queue', ctx.lang) : batchText('batch.row-action.install-row', ctx.lang)) + '</button>',
    )
  } else if (phase === 'ready' && skipped !== null) {
    // 跳过后这一版的下一步是「恢复」：与单插件面板同一套本地跳过语义（按插件 + 版本记）。
    actions.push(
      '<button type="button" data-act="row-resume-skip" data-key="' + keyAttr + '"' + off +
        '>' + escapeHtml(batchText('batch.row-action.unskip', ctx.lang, { version: skipped })) + '</button>',
    )
  } else if (phase === 'failed') {
    actions.push(
      '<button type="button" data-act="row-install" data-key="' + keyAttr + '"' + off + '>' +
        escapeHtml(ctx.busy ? batchText('batch.row-action.queue', ctx.lang) : batchText('batch.row-action.retry', ctx.lang)) + '</button>',
    )
  }
  if (row.restartRequired === true) {
    // 与单插件面板同一措辞：宿主没有重启自己的电话，这里只做入口。
    actions.push('<button type="button" data-act="restart" data-key="' + keyAttr + '">' + escapeHtml(batchText('batch.row-action.restart', ctx.lang)) + '</button>')
  }
  actions.push(
    '<button type="button" data-act="toggle-details" data-key="' + keyAttr + '">' +
      escapeHtml(ctx.expanded ? batchText('batch.row-action.hide-detail', ctx.lang) : batchText('batch.row-action.show-detail', ctx.lang)) + '</button>',
  )
  const failLine =
    phase === 'failed' && !queued
      ? (() => {
        const failCode = row.error || 'install-failed'
        const failDetail = failureCopy(failCode, ctx.lang)?.zh ?? failureCopy('unknown', ctx.lang)?.zh ?? ''
        // 字典不存 HTML（#64 口径）：模板为纯文本，<code> 由此处组装，语义与 inventory batch.row.error-label 一致。
        const label = batchText('batch.row.error-label', ctx.lang, { code: failCode, detail: failDetail })
        const escaped = escapeHtml(label)
        const codeEsc = escapeHtml(failCode)
        const withCode = escaped.includes(codeEsc) ? escaped.replace(codeEsc, '<code>' + codeEsc + '</code>') : escaped
        return '<span class="dsh-upd-bfail">' + withCode + '</span>'
      })()
      : ''
  const main =
    '<button type="button" class="dsh-upd-brow-main" data-act="toggle-details" data-key="' + keyAttr +
    '" aria-expanded="' + (ctx.expanded ? 'true' : 'false') + '">' +
    '<span class="dsh-upd-updot" data-tone="' + dotToneOf(row, phase, skipped, queued) + '"></span>' +
    '<span class="dsh-upd-bname">' + escapeHtml(titleOf(row, ctx.titles)) + '</span>' +
    (version ? '<span class="dsh-upd-bver">' + escapeHtml(version) + '</span>' : '') +
    '<span class="dsh-upd-bstat">' + escapeHtml(queued ? batchQueuedStatus(position, ctx.lang) : (batchRowKnowledgeText(row, ctx.knowledge, ctx.lang) ?? batchRowStatus(row, skipped, ctx.lang))) + (ctx.inRound && !queued ? '（' + escapeHtml(batchText('batch.row.unfinished-tag', ctx.lang)) + '）' : '') + '</span>' +
    failLine +
    '</button>'
  const detail = ctx.expanded
    ? '<div class="dsh-upd-bdetail" data-key="' + keyAttr + '">' +
      detailActionsHTML(row, ctx) +
      (ctx.notice !== null
        ? '<div class="dsh-upd-bdetail-notice" role="status">' + escapeHtml(ctx.notice) + '</div>'
        : '') +
      detailHTML(row, ctx) +
      '</div>'
    : ''
  return (
    '<div class="dsh-upd-brow-set" data-key="' + keyAttr + '">' +
    '<div class="dsh-upd-brow" data-phase="' + escapeHtml(phase) + '" data-key="' + keyAttr + '"' +
    (queued ? ' data-queued="1"' : '') + '>' +
    main +
    '<span class="dsh-upd-brow-actions">' + actions.join('') + '</span>' +
    '</div>' +
    detail +
    '</div>'
  )
}

/**
 * 该家的详情 = 单插件内核原样（renderUpdatePanelHTML），不另写一套。
 * 只读渲染（`actions: 'none'`）：内核不画动作按钮，动作行由批量面板自己出（见 detailActionsHTML）。
 */
function detailHTML(row: BatchRowView, ctx: RowRenderContext): string {
  const html = renderUpdatePanelHTML({
    snapshot: asSnapshotLike(row.snapshot),
    manual: typeof row.manual === 'string' ? row.manual : null,
    changelogMarkdown: typeof ctx.changelogMarkdown === 'string' ? ctx.changelogMarkdown : null,
    queue: asQueueLike(row.queue),
    // 跳过是面板本地记录（与单插件面板同一套语义）：内核按「已跳过」画 tag 与提示行，
    // 恢复按钮由上面的动作行提供，措辞与内核提示里的「恢复」对得上。
    skippedLatest: ctx.skipped !== null,
    lastError: row.error,
    errorKind: row.error,
    mode: 'embedded',
    showOthers: false,
    pluginId: pluginIdOf(row),
    copyNotice: null,
    theme: ctx.theme,
    profileName: typeof row.profileName === 'string' && row.profileName ? row.profileName : null,
    actions: 'none',
  }, ctx.lang)
  return stripActionButtons(html)
}

/**
 * 详情里由批量面板自己出的动作行：全部带 data-act，与行内同一通道，点了真能用。
 * 忙守卫与行内同一判据（任一行装东西时一起置灰）。
 */
function detailActionsHTML(row: BatchRowView, ctx: RowRenderContext): string {
  const phase = asBatchPhase(row.phase)
  const keyAttr = escapeHtml(row.key)
  const version = latestVersionOf(row)
  const queued = isQueuedRow(row)
  // 忙守卫按行：只防连点（本面板有电话在飞）；别家正在装不影响这一家的按钮（那正是「加入队列」）。
  const off = ctx.inFlight ? ' disabled' : ''
  const buttons: string[] = []
  if (phase === 'installing') {
    buttons.push('<button type="button" data-act="row-install" data-key="' + keyAttr + '" disabled>' + escapeHtml(batchText('batch.row-action.installing', ctx.lang)) + '</button>')
  } else if (queued) {
    if (cancelQueuePhoneOf(row) !== null && queuedRequestIdOf(row) !== null) {
      buttons.push(
        '<button type="button" data-act="row-cancel-queue" data-key="' + keyAttr + '"' + off + '>' + escapeHtml(batchText('batch.row-action.cancel-queue', ctx.lang)) + '</button>',
      )
    }
  } else if (phase === 'failed') {
    buttons.push(
      '<button type="button" data-act="row-install" data-key="' + keyAttr + '"' + off + '>' +
        escapeHtml(ctx.busy ? batchText('batch.row-action.queue', ctx.lang) : batchText('batch.row-action.retry', ctx.lang)) + '</button>',
    )
  } else if (phase === 'ready' && ctx.skipped === null) {
    buttons.push(
      '<button type="button" data-act="row-install" data-key="' + keyAttr + '" data-primary="1"' + off +
        '>' + escapeHtml(ctx.busy ? batchText('batch.row-action.queue', ctx.lang) : version !== null ? batchText('batch.row-action.install-version', ctx.lang, { version }) : batchText('batch.row-action.install-generic', ctx.lang)) + '</button>',
    )
  }
  if (!queued && phase === 'ready' && ctx.skipped === null && version !== null) {
    buttons.push(
      '<button type="button" data-act="row-skip" data-key="' + keyAttr + '"' + off + '>' + escapeHtml(batchText('batch.row-action.skip', ctx.lang)) + '</button>',
    )
  }
  if (ctx.skipped !== null) {
    buttons.push(
      '<button type="button" data-act="row-resume-skip" data-key="' + keyAttr + '"' + off +
        '>' + escapeHtml(batchText('batch.row-action.unskip', ctx.lang, { version: ctx.skipped })) + '</button>',
    )
  }
  if (typeof row.manual === 'string' && row.manual) {
    buttons.push(
      '<button type="button" data-act="row-copy-manual" data-key="' + keyAttr + '"' + off + '>' + escapeHtml(batchText('batch.row-action.copy-manual', ctx.lang)) + '</button>',
    )
  }
  buttons.push('<button type="button" data-act="row-copy-diag" data-key="' + keyAttr + '"' + off + '>' + escapeHtml(batchText('batch.row-action.copy-diag', ctx.lang)) + '</button>')
  return '<span class="dsh-upd-bdetail-actions">' + buttons.join('') + '</span>'
}

/**
 * 详情走只读渲染后，内核里只该剩内容、不该剩控件：`actions: 'none'` 关掉了动作行，
 * 但 03 章的「显示其他插件」开关不在那一块里，仍是可点、没人接的死按钮。
 * 批量面板的详情不接内核的动作通道，所以这里把残留的 data-action 按钮整颗摘掉（章节内容照留）。
 * panel.ts 日后若把队列开关也纳入只读开关，这里自然变成空操作。
 */
function stripActionButtons(html: string): string {
  return html.replace(/<button\b[^>]*data-action=[^>]*>[\s\S]*?<\/button>/g, '')
}

function dotToneOf(
  row: BatchRowView,
  phase: BatchPhase,
  skipped: string | null,
  queued: boolean,
): 'idle' | 'todo' | 'busy' | 'warn' | 'bad' | 'ok' {
  if (phase === 'failed' && !queued) return 'bad'
  if (phase === 'installing' || phase === 'checking') return 'busy'
  if (queued) return 'warn'
  if (row.restartRequired === true) return 'warn'
  if (phase === 'ready') return skipped === null ? 'todo' : 'idle'
  if (phase === 'current' || phase === 'done') return 'ok'
  return 'idle'
}

// ---------- 样式（同一套 dsh-upd-* 前缀；默认最小，Archive 另起一串） ----------

export const UPDATE_BATCH_PANEL_CSS = [
  '/* 批量面板（#25）：类名沿用 dsh-upd-* 前缀；默认（最小）主题，Archive 皮肤见 UPDATE_BATCH_PANEL_ARCHIVE_CSS。 */',
  '.dsh-upd-batch-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap}',
  '.dsh-upd-batch-title{font-weight:700;font-size:15px;letter-spacing:.06em}',
  '.dsh-upd-batch-title i{font-style:normal;color:var(--dsh-update-primary,#2563eb)}',
  '.dsh-upd-batch-macros{flex:none}',
  '.dsh-upd-batch-sum{margin:4px 0 8px;font-size:13.5px}',
  '.dsh-upd-btable{margin-top:2px}',
  '.dsh-upd-brow-set{border-top:1px solid var(--dsh-update-border,#e5e7eb)}',
  '.dsh-upd-brow-set:first-child{border-top:0}',
  '.dsh-upd-brow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 0}',
  '.dsh-upd .dsh-upd-brow-main{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:1 1 260px;min-width:0;',
  'text-align:left;cursor:pointer;color:inherit;font:inherit;background:transparent;border:0;padding:2px 0;margin:0}',
  '.dsh-upd .dsh-upd-brow-main:hover{color:var(--dsh-update-primary,#2563eb)}',
  '.dsh-upd-brow-actions{flex:none;margin-left:auto}',
  '.dsh-upd-brow-actions button{font-size:12.5px}',
  '.dsh-upd-updot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsh-update-border,#9ca3af);opacity:.55}',
  '.dsh-upd-updot[data-tone="todo"]{background:var(--dsh-update-ok-border,#059669);opacity:1}',
  '.dsh-upd-updot[data-tone="ok"]{background:var(--dsh-update-ok-border,#059669);opacity:1}',
  '.dsh-upd-updot[data-tone="busy"]{background:var(--dsh-update-busy-border,#2563eb);opacity:1}',
  '.dsh-upd-updot[data-tone="warn"]{background:var(--dsh-update-warn-border,#d97706);opacity:1}',
  '.dsh-upd-updot[data-tone="bad"]{background:var(--dsh-update-bad-border,#dc2626);opacity:1}',
  '.dsh-upd-bname{font-weight:700;flex:none}',
  '.dsh-upd-bver{font-family:Consolas,Menlo,monospace;font-size:12px;opacity:.8;flex:none}',
  '.dsh-upd-bstat{font-size:12.5px;opacity:.9}',
  '.dsh-upd-bfail{flex:1 1 100%;display:block;font-size:12.5px;color:var(--dsh-update-bad-border,#dc2626)}',
  '.dsh-upd-blist{font-size:12.5px;margin-top:2px}',
  '.dsh-upd-batch-ledger{margin:8px 0 0;font-size:13px;opacity:.85}',
  '.dsh-upd-batch-more{margin-top:6px}',
  '.dsh-upd-batch-more button{font-size:12px}',
  // 确认态：红框红字，与「关闭」等中性按钮一眼区分；disabled 照旧置灰。
  '.dsh-upd-batch-more button[data-confirm="1"]{border-color:var(--dsh-update-bad-border,#dc2626);color:var(--dsh-update-bad-border,#dc2626)}',
  '.dsh-upd-batch-notice{margin-top:6px;font-size:12.5px;opacity:.85}',
  '.dsh-upd-bdetail-actions{margin:0 0 6px}',
  '.dsh-upd .dsh-upd-bdetail-actions button{font-size:12.5px}',
  '.dsh-upd-bdetail-notice{margin:0 0 6px;font-size:12.5px;opacity:.85}',
  '/* 详情复用单插件内核：不许嵌套滚动——中性化 overlay 的 max-height/overflow，自身也不给 overflow。 */',
  '.dsh-upd-bdetail{margin:2px 0 10px;overflow:visible}',
  '.dsh-upd .dsh-upd-bdetail .dsh-upd{max-width:none}',
  '.dsh-upd-overlay .dsh-upd-bdetail .dsh-upd{max-height:none;overflow:visible}',
  '.dsh-upd-overlay .dsh-upd-bdetail .dsh-upd-body{overflow:visible}',
  '.dsh-upd-overlay .dsh-upd-bdetail .dsh-upd-body .dsh-upd-chap-head{position:static}',
  '@media (prefers-color-scheme: dark){.dsh-upd-batch-title i{color:var(--dsh-update-focus,#93c5fd)}}',
  '@media (prefers-reduced-motion: reduce){.dsh-upd-batch *{transition:none !important;animation:none !important}}',
  // Batch check layout stability: reserve macro width + rows/summary heights + no scroll anchoring jumps.
  '.dsh-upd-batch{overflow-anchor:none}',
  '.dsh-upd-btable{overflow-anchor:none}',
  '.dsh-upd-batch-macros{display:flex;flex-wrap:wrap;align-items:center;gap:0}',
  '.dsh-upd-batch-macros button:first-child,.dsh-upd-batch-macros button[data-primary="1"]{min-width:6em;text-align:center}',
  '.dsh-upd-batch-sum,.dsh-upd-batch-ledger{min-height:1.6em}',
  '.dsh-upd-brow{min-height:28px}',
].join(String.fromCharCode(10))

/**
 * 批量面板的 Archive 皮肤（#20 同一套口径：只换颜色/字体/间距，不改顺序、不藏东西）。
 * 卷宗抬头右侧给大印章留 120px（与单插件面板档案头同一处理）。
 */
export const UPDATE_BATCH_PANEL_ARCHIVE_CSS = [
  '/* 批量面板的 Archive 皮肤：只换颜色/字体/间距；根上的大印章由 UPDATE_PANEL_ARCHIVE_CSS 负责。 */',
  '.dsh-upd[data-theme="archive"] .dsh-upd-batch-head{padding-right:120px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-batch-title{font-family:var(--dsh-update-font-serif);font-size:21px;letter-spacing:.04em}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-batch-title i{color:var(--dsh-update-primary)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-brow-main{background:transparent;border:0;color:var(--dsh-update-text)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-brow-main:hover{color:var(--dsh-update-primary)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-bname{font-family:var(--dsh-update-font-serif)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-bver{font-family:var(--dsh-update-font-mono);color:var(--dsh-update-text-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-batch-ledger{color:var(--dsh-update-text-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-batch-sum{color:var(--dsh-update-text)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-brow-set{border-top-color:var(--dsh-update-border)}',
].join(String.fromCharCode(10))

// ---------- 挂载（多目标批量面板入口） ----------

function escapeHtml(text: string): string {
  // panel.ts 的同名内部件没有转出口，这里按同一口径本地复制（只这四行）。
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

const BATCH_PHASES: readonly BatchPhase[] = [
  'pending',
  'checking',
  'ready',
  'installing',
  'current',
  'done',
  'failed',
  'skipped',
]

/** 「忙失败占位」：宿主忙时先把占位写进队列再回 update-busy —— 那是排队，不是失败。 */
function isQueueBusyRow(row: BatchRowView): boolean {
  return asBatchPhase(row.phase) === 'failed' && row.error === 'update-busy'
}

/** 这一家在队里的位置（1..n；0=自己就在装、null=不在队里）：只认忙且有位置的队列视图。 */
function queuePositionOf(row: BatchRowView): number | null {
  const queue = asQueueLike(row.queue)
  if (!queue || queue.busy !== true) return null
  const position = queue.position
  return typeof position === 'number' && Number.isFinite(position) && position > 0 ? position : null
}

/**
 * 排队中：正在等前面那家装完。
 * 两条来源都认：① 宿主忙时把占位写进队列、会话里记成 failed+update-busy 的那档（面板必须翻回排队）；
 * ② 队列视图说这一家在等（position > 0）。自己正在装的那一行不算排队。
 */
function isQueuedRow(row: BatchRowView): boolean {
  const phase = asBatchPhase(row.phase)
  if (phase === 'installing') return false
  if (isQueueBusyRow(row)) return true
  if (isTerminalPhase(phase)) return false
  return queuePositionOf(row) !== null
}

/** 排队那一条自己的编号（取消排队要用；showOthers=false 时 waiting 里只有自己）。 */
function queuedRequestIdOf(row: BatchRowView): string | null {
  const queue = asQueueLike(row.queue)
  if (!queue || !Array.isArray(queue.waiting)) return null
  for (const entry of queue.waiting) {
    if (entry && typeof entry.requestId === 'string' && entry.requestId) return entry.requestId
  }
  return null
}

/** 取消排队要打的电话：该家自己的单插件安装电话（带 cancelQueued 用）；老宿主不给就取消不了。 */
function cancelQueuePhoneOf(row: BatchRowView): string | null {
  const phones = isObject(row.phoneNames) ? row.phoneNames : null
  if (!phones) return null
  const install = phones['updateInstall']
  return typeof install === 'string' && install ? install : null
}

/** 相位宽容读：认不出按 pending（坏回包不许把面板打挂，与队列/账本同一纪律）。 */
function asBatchPhase(value: unknown): BatchPhase {
  return typeof value === 'string' && (BATCH_PHASES as readonly string[]).includes(value)
    ? (value as BatchPhase)
    : 'pending'
}

/** 单插件快照宽容读：形状不对当没有（详情退回「正在读取更新状态…」）。 */
function asSnapshotLike(value: unknown): UpdateSnapshot | null {
  if (!isObject(value)) return null
  if (typeof value['runningVersion'] !== 'string') return null
  if (typeof value['canInstall'] !== 'boolean') return null
  return value as unknown as UpdateSnapshot
}

function asQueueLike(value: unknown): VisibleQueue | null {
  if (!isObject(value) || typeof value['busy'] !== 'boolean') return null
  return value as unknown as VisibleQueue
}

/** 行中文名：调用方 titles 覆盖 > 宿主 title > 稳定键。 */
function titleOf(row: BatchRowView, titles: Record<string, string>): string {
  const override = titles[row.key]
  if (typeof override === 'string' && override) return override
  return row.title || row.key
}

/** 该行的插件标识：宿主给了用宿主的，没给用稳定键（跳过存储与诊断文本都认它）。 */
function pluginIdOf(row: BatchRowView): string {
  return typeof row.pluginId === 'string' && row.pluginId ? row.pluginId : row.key
}

/** 这一版是哪个版本：会话账本的远端版优先，退回快照里的远端版；都没有给 null（不猜）。 */
function latestVersionOf(row: BatchRowView): string | null {
  if (typeof row.targetVersion === 'string' && row.targetVersion) return row.targetVersion
  const snapshot = row.snapshot
  if (!isObject(snapshot)) return null
  const latest = snapshot['latestVersion']
  return typeof latest === 'string' && latest ? latest : null
}

/** 复制文本的默认出口（与单插件面板同一套写法）：剪贴板不可用时静默返回，绝不抛错挡更新。 */
async function defaultCopyText(text: string): Promise<void> {
  try {
    const holder = (globalThis as Record<string, unknown>)['navigator'] as
      | { clipboard?: { writeText?: (t: string) => Promise<void> } }
      | undefined
    const clip = holder?.clipboard
    const write = clip?.writeText
    if (clip && typeof write === 'function') {
      await write.call(clip, text)
      return
    }
  } catch {
    // 剪贴板不可用即留提示，不抛错（复制失败不能挡更新）。
  }
}

/** 当前版本（运行版优先，退回磁盘版）；读不到给 null，不猜。 */
function currentVersionOf(row: BatchRowView): string | null {
  const snapshot = row.snapshot
  if (!isObject(snapshot)) return null
  const running = snapshot['runningVersion']
  if (typeof running === 'string' && running) return running
  const installed = snapshot['installedVersion']
  if (typeof installed === 'string' && installed) return installed
  return null
}

/**
 * 该行后台失败任务收尾时记下的真原因（该行快照里的 job）。
 * job.message 的形状由 ports.ts 冻结：失败时是「失败码」或「失败码: 详情」（详情是宿主原话）。
 * 只认失败／被打断的任务——跑着或已完成的 message 不是失败原因，不许拿来当诊断。
 * 拆不开就不硬拆：整串是包内已知稳定码就当码，否则整串当正文；返回 null 即这行没有可用记录。
 */
function jobFailureOf(row: BatchRowView): { code: string | null; detail: string | null } | null {
  const snapshot = isObject(row.snapshot) ? row.snapshot : null
  if (!snapshot) return null
  const job = isObject(snapshot['job']) ? snapshot['job'] : null
  if (!job) return null
  const state = typeof job['state'] === 'string' ? job['state'] : ''
  if (state !== 'failed' && state !== 'interrupted') return null
  const message = typeof job['message'] === 'string' ? job['message'].trim() : ''
  if (!message) return null
  const at = message.indexOf(':')
  if (at < 0) {
    return isKnownFailureCode(message) ? { code: message, detail: null } : { code: null, detail: message }
  }
  const code = message.slice(0, at).trim()
  const detail = message.slice(at + 1).trim()
  return { code: code || null, detail: detail || null }
}

/**
 * 该行的诊断文本：逐字出自单插件面板那套 buildDiagnosticText（稳定码 + 脱敏详情 + 版本 + 宿主 + 队列）。
 * 详情按来源优先级取，取到什么就标什么来源，绝不编造：
 *   ① row.diag.detail —— 宿主给的诊断摘要（最优先）；
 *   ② 该行后台失败任务收尾记下的正文（job.message 去掉前缀稳定码），并标「来源：后台任务收尾记录」；
 *   ③ 都没有就留空 —— buildDiagnosticText 走 failureCopy 的泛化人话。
 * 稳定码同理：后台那句带前缀码就取它（比账本里的码更贴这一家的失败），否则用行上的 error。
 * 使用范围（profileName）与宿主种类一并透传：诊断里能看出更新安装到了哪个范围。
 * 复制出去前已由 redactForCopy 收干净（绝对路径 → <路径>）。
 */
function diagTextOf(row: BatchRowView, lang?: string | null): string {
  const snapshot = isObject(row.snapshot) ? row.snapshot : null
  const queue = isObject(row.queue) ? row.queue : null
  const diag = isObject(row.diag) ? row.diag : null
  const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)
  const job = jobFailureOf(row)
  const diagDetail = diag ? text(diag['detail']) : null
  const detail =
    diagDetail !== null
      ? diagDetail
      : job !== null && job.detail !== null
        ? job.detail + batchText('batch.diag.source-job', langOf(lang))
        : null
  const input: PanelDiagnosticInput = {
    pluginId: pluginIdOf(row),
    code: job !== null && job.code !== null ? job.code : row.error || 'check-failed',
    detail,
    runningVersion: text(snapshot ? snapshot['runningVersion'] : null),
    installedVersion: text(snapshot ? snapshot['installedVersion'] : null),
    latestVersion: text(snapshot ? snapshot['latestVersion'] : null),
    hostKind: text(row.hostKind),
    queuePosition: queue && typeof queue['position'] === 'number' ? (queue['position'] as number) : null,
    manual: text(row.manual),
    diag: row.diag ?? null,
    profileName: text(row.profileName),
    // #63 透传语言（批量 en 跟随在 #64/#65 落；此处缺省 zh 零回归）。
    lang: lang ?? 'zh',
  }
  return buildDiagnosticText(input)
}

/** 回包说「忙」：入队没接住（老宿主）——那是排队语义，不是失败，别画红条。 */
function isBusyReply(reply: unknown): boolean {
  if (!isObject(reply) || reply['ok'] === true) return false
  const kind = typeof reply['errorKind'] === 'string' ? reply['errorKind'] : ''
  const err = typeof reply['error'] === 'string' ? reply['error'] : ''
  return kind === 'update-busy' || err === 'update-busy'
}

/** 宿主回包 rows -> 行视图（坏行丢弃：没有稳定键就没法指认哪一家）。 */
function readRows(value: unknown): BatchRowView[] {
  if (!Array.isArray(value)) return []
  const out: BatchRowView[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!isObject(item)) continue
    const key = typeof item['key'] === 'string' && item['key'] ? item['key'] : ''
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push({
      key,
      title: typeof item['title'] === 'string' && item['title'] ? item['title'] : key,
      phase: asBatchPhase(item['phase']),
      targetVersion:
        typeof item['targetVersion'] === 'string' && item['targetVersion'] ? item['targetVersion'] : null,
      restartRequired: item['restartRequired'] === true,
      error: typeof item['error'] === 'string' && item['error'] ? item['error'] : null,
      snapshot: item['snapshot'] === undefined ? null : item['snapshot'],
      manual: typeof item['manual'] === 'string' ? item['manual'] : null,
      queue: item['queue'] === undefined ? null : item['queue'],
      profileName:
        typeof item['profileName'] === 'string' && item['profileName'] ? item['profileName'] : null,
      pluginId: typeof item['pluginId'] === 'string' && item['pluginId'] ? item['pluginId'] : null,
      diag: item['diag'] === undefined ? null : item['diag'],
      hostKind: typeof item['hostKind'] === 'string' && item['hostKind'] ? item['hostKind'] : null,
      phoneNames: item['phoneNames'] === undefined ? null : item['phoneNames'],
    })
  }
  return out
}

/** 回包没带 rows 时的兜底：按会话账本把行补出来（老宿主/半截回包也能看）。 */
function rowsFromSession(session: BatchSession): BatchRowView[] {
  return session.entries.map((entry) => ({
    key: entry.key,
    title: entry.key,
    phase: entry.phase,
    targetVersion: entry.targetVersion,
    restartRequired: entry.restartRequired,
    error: entry.error,
    snapshot: null,
    manual: null,
    queue: null,
    profileName: null,
  }))
}

function getTimer(): { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void } {
  // panel.ts 的同名内部件没有转出口，这里按同一口径本地复制（浏览器 setInterval / Node 计时器都认）。
  const g = globalThis as Record<string, unknown>
  const set = g['setInterval']
  const clear = g['clearInterval']
  if (typeof set === 'function' && typeof clear === 'function') {
    return {
      set: (fn, ms) => (set as (fn: () => void, ms: number) => unknown)(fn, ms),
      clear: (h) => (clear as (h: unknown) => void)(h),
    }
  }
  const setT = g['setTimeout']
  const clearT = g['clearTimeout']
  return {
    set: (fn, ms) => (setT as (fn: () => void, ms: number) => unknown)(fn, ms),
    clear: (h) => (clearT as (h: unknown) => void)(h),
  }
}

/**
 * 挂批量面板（调用方一行即跑）：
 * ```js
 * const panel = mountUpdateBatchPanel(document.getElementById('upd'), { prefix: 'life', call: host.call })
 * // …离开时 panel.unmount()（只停轮询，批量更新在宿主侧继续跑）
 * ```
 */
export function mountUpdateBatchPanel(
  container: BatchPanelContainer,
  options: BatchPanelOptions,
): BatchPanelController {
  if (!container || typeof container.innerHTML !== 'string') {
    throw new Error('[dsh-plugin-update] 挂载批量面板需要一个有 innerHTML 的容器')
  }
  if (!options || typeof options !== 'object') {
    throw new Error('[dsh-plugin-update] 挂载批量面板缺少配置：批量电话前缀 prefix 必填')
  }
  const phones = buildBatchPhoneNames(options.prefix)
  if (typeof options.call !== 'function') {
    throw new Error('[dsh-plugin-update] 挂载批量面板需要传输函数 call（面板调宿主电话的唯一接触面）')
  }
  const pollMs = options.pollMs === undefined ? BATCH_PANEL_POLL.defaultMs : options.pollMs
  if (typeof pollMs !== 'number' || !Number.isFinite(pollMs) || pollMs < BATCH_PANEL_POLL.minMs) {
    throw new Error(
      '[dsh-plugin-update] 批量面板轮询间隔非法：不得小于 250 毫秒（收到 ' + JSON.stringify(options.pollMs) + '）',
    )
  }
  let mode: BatchPanelMode = options.mode === undefined ? 'embedded' : options.mode
  if (mode !== 'embedded' && mode !== 'dialog') {
    throw new Error('[dsh-plugin-update] 摆放形态非法：只收 embedded 或 dialog（收到 ' + JSON.stringify(options.mode) + '）')
  }
  if (options.theme !== undefined && options.theme !== 'default' && options.theme !== 'archive') {
    throw new Error('[dsh-plugin-update] 主题非法：只收 default 或 archive（收到 ' + JSON.stringify(options.theme) + '）')
  }
  let theme: UpdatePanelTheme = normalizePanelTheme(options.theme ?? 'default')
  const call = options.call
  const titles: Record<string, string> =
    options.titles && typeof options.titles === 'object' ? options.titles : {}
  const onRestartRequested = options.onRestartRequested
  const onCloseRequested = typeof options.onCloseRequested === 'function' ? options.onCloseRequested : null
  const copyText = options.copyText ?? defaultCopyText
  // 跳过存储按插件标识各一份（浏览器 localStorage 优先，没有退内存；与单插件面板同一套语义）。
  const skipStores = new Map<string, PanelSkipStore>()
  // 详情行自动日志（#41 终裁）：默认开；按“行 key + 版本”记住结果（成功与取不到永久记，不落盘）；
  // 传输失败不进缓存，换版/批量查一次/重开立即重问，轮询按退避问（三处共用 shouldFetchChangelog，各存各的）。
  const autoChangelogEnabled = options.autoChangelog !== false
  const rowChangelog = new Map<string, { version: string; markdown: string | null }>()
  const rowInflight = new Set<string>()
  // 失败退避时间戳（行 key + 版本 -> 失败时刻毫秒）：轮询按退避问，反复展开不再每秒重问；
  // 换版（新 key）、批量查一次、重开面板即忘。
  const rowFailedAt = new Map<string, number>()
  let rowAutoSeq = 0

  let rows: BatchRowView[] = []
  let expandedKey: string | null = null
  let lastError: string | null = null
  let notice: string | null = null
  let noticeKey: string | null = null
  let inFlight = false
  let loaded = false
  let refreshing = false
  // 两步确认（#37）：「取消这一批」点一次只上膛，点别的按钮自动卸膛。
  let confirmCancelArmed = false
  let mounted = true
  // #64 v2 语言跟随：显式 locale 覆盖或全局信号；切换即时重绘，unmount 后停订（与单插件面板同一口径）。
  const localeOpt = (options as unknown as Record<string, unknown>)['locale'] as LocaleOption
  function currentLang(): AppLang {
    return langOf(localeOpt)
  }
  const checkOnOpenOption = (options as unknown as Record<string, unknown>)['checkOnOpen'] !== false
  const autoResumeOption = (options as unknown as Record<string, unknown>)['autoResume'] !== false
  let lastSession: unknown = null
  let lastInventory: unknown = null
  let lastPrefs: unknown = null
  let lastCheckedAt = 0
  let autoCheckDone = false
  let autoResumeDone = false

  /** 当前可画的各行日志：只给版本对得上且有文本的（其余即中性提示）。 */
  function changelogView(): Record<string, string | null> {
    const out: Record<string, string | null> = {}
    for (const row of rows) {
      const cached = rowChangelog.get(row.key)
      if (!cached || typeof cached.markdown !== 'string') continue
      if (latestVersionOf(row) !== cached.version) continue
      out[row.key] = cached.markdown
    }
    return out
  }

  /** 该行详情要用的更新日志电话名：行里没带（老宿主）即回 null，外层按取不到处理。 */
  function changelogPhoneOf(row: BatchRowView): string | null {
    const phones = isObject(row.phoneNames) ? (row.phoneNames as Record<string, unknown>) : null
    if (!phones) return null
    const name = phones['updateChangelog']
    return typeof name === 'string' && name ? name : null
  }

  /** 展开行有新版即调该行自己的电话取一次；单行失败只影响该行，绝不碰别家。 */
  function maybeAutoRowChangelog(key: string | null): void {
    if (!autoChangelogEnabled || !mounted || !key) return
    const row = rowOfKey(key)
    if (!row || asBatchPhase(row.phase) !== 'ready') return
    const version = latestVersionOf(row)
    if (!version || !validReleaseVersion(version)) return
    try {
      if (skipStoreFor(pluginIdOf(row)).has(version)) return
    } catch {
      // 跳过存储读不到即当没跳过，不挡日志。
    }
    const cached = rowChangelog.get(key)
    if (cached && cached.version === version) return
    if (rowInflight.has(key)) return
    try {
      const failKey = key + '\0' + version
      const hasCache = false
      const failedAt = rowFailedAt.has(failKey) ? (rowFailedAt.get(failKey) as number) : null
      let nowMs = 0
      try { nowMs = Date.now(); } catch { nowMs = 0; }
      if (!shouldFetchChangelog({ hasCache: hasCache, failedAt: failedAt, now: nowMs, isManual: false })) return
    } catch { }
    const phone = changelogPhoneOf(row)
    if (!phone) return
    rowInflight.add(key)
    const seq = rowAutoSeq
    void Promise.resolve()
      .then(() => call(phone, { version }))
      .then(
        (reply) => {
          rowInflight.delete(key)
          if (!mounted || seq !== rowAutoSeq) return
          if (!isObject(reply) || reply['ok'] !== true) {
            try { rowFailedAt.set(key + '\0' + version, Date.now()); } catch { try { rowFailedAt.set(key + '\0' + version, 0); } catch {} }
            return
          }
          const md = (reply as Record<string, unknown>)['markdown']
          rowChangelog.set(key, { version, markdown: typeof md === 'string' ? md : null })
          if (typeof md === 'string') render()
        },
        () => {
          rowInflight.delete(key)
          if (mounted && seq === rowAutoSeq) { try { rowFailedAt.set(key + '\0' + version, Date.now()); } catch { try { rowFailedAt.set(key + '\0' + version, 0); } catch {} } }
        },
      )
  }

  function setStableHTML(target: BatchPanelContainer, html: string): void {
    try {
      const g = globalThis as unknown as Record<string, unknown>
      const doc = g['document'] as unknown as {
        activeElement?: { getAttribute?: (n: string) => string | null } | null
      } | null | undefined
      const el = target as unknown as {
        querySelectorAll?: (sel: string) => ArrayLike<{ scrollTop?: unknown }> | null
        querySelector?: (sel: string) => { focus?: (o?: unknown) => void } | null
      }
      if (!doc || typeof el.querySelectorAll !== 'function') {
        target.innerHTML = html
        return
      }
      let focusAct: string | null = null
      let focusKey: string | null = null
      try {
        const active = doc.activeElement
        if (active && typeof active.getAttribute === 'function') {
          focusAct = active.getAttribute('data-act')
          focusKey = active.getAttribute('data-key')
        }
      } catch { focusAct = null; focusKey = null }
      let scrolls: number[] = []
      try {
        const nodes = el.querySelectorAll('.dsh-upd-btable')
        if (nodes) {
          for (let i = 0; i < nodes.length; i++) {
            const n = nodes[i] as unknown as { scrollTop?: unknown }
            scrolls.push(typeof n.scrollTop === 'number' ? (n.scrollTop as number) : 0)
          }
        }
      } catch { scrolls = [] }
      target.innerHTML = html
      try {
        const bodies = el.querySelectorAll('.dsh-upd-btable')
        if (bodies) {
          for (let i = 0; i < bodies.length && i < scrolls.length; i++) {
            const n = bodies[i] as unknown as { scrollTop?: unknown }
            try { (n as { scrollTop: number }).scrollTop = scrolls[i] } catch { /* keep */ }
          }
        }
      } catch { /* keep */ }
      try {
        if (focusAct && typeof el.querySelector === 'function') {
          const sel = focusKey ? '[data-act="' + focusAct + '"][data-key="' + focusKey + '"]' : '[data-act="' + focusAct + '"]'
          const next = el.querySelector(sel)
          if (next && typeof next.focus === 'function') {
            try { (next.focus as (o?: unknown) => void).call(next, { preventScroll: true }) } catch {
              try { (next.focus as () => void).call(next) } catch { /* keep */ }
            }
          }
        }
      } catch { /* keep */ }
    } catch {
      try { target.innerHTML = html } catch { /* keep */ }
    }
  }

  // 上次落盘的 HTML：逐字相同即跳过赋值（与单插件面板同一闪烁根治口径）。
  let lastHTML = ''
  function render(): void {
    if (!mounted) return
    const nextHTML = renderBatchPanelHTML({
      rows,
      theme,
      mode,
      expandedKey,
      lastError,
      notice,
      noticeKey,
      skippedVersions: skippedVersionsOf(),
      inFlight,
      loaded,
      titles,
      confirmCancel: confirmCancelArmed,
      changelogs: changelogView(),
      session: lastSession,
      inventory: lastInventory,
      prefs: lastPrefs,
      lang: currentLang(),
    })
    if (nextHTML !== lastHTML) {
      lastHTML = nextHTML
      setStableHTML(container, nextHTML)
    }
  }

  function rowOfKey(key: string): BatchRowView | null {
    return rows.find((row) => row.key === key) ?? null
  }

  function skipStoreFor(pluginId: string): PanelSkipStore {
    let store = skipStores.get(pluginId)
    if (!store) {
      store = createBrowserSkipStore(pluginId)
      skipStores.set(pluginId, store)
    }
    return store
  }

  /** 这一家被跳过的版本：只在「有可安装新版」的行上算数（与单插件面板同一口径）。 */
  function skippedVersionOf(row: BatchRowView): string | null {
    if (asBatchPhase(row.phase) !== 'ready') return null
    const version = latestVersionOf(row)
    if (!version) return null
    try {
      return skipStoreFor(pluginIdOf(row)).has(version) ? version : null
    } catch {
      return null
    }
  }

  function skippedVersionsOf(): Record<string, string | null> {
    const out: Record<string, string | null> = {}
    for (const row of rows) out[row.key] = skippedVersionOf(row)
    return out
  }

  /** 记一条回执：带 key 就挂在该家详情里，不带就落面板底部。 */
  function say(text: string, key: string | null = null): void {
    notice = text
    noticeKey = key
  }

  function clearNotice(): void {
    notice = null
    noticeKey = null
  }

  /** 复制一段文本，并按同一套措辞给回执（复制失败不抛错，只提示手动选）。 */
  async function copyWith(text: string, okNotice: string, key: string): Promise<void> {
    try {
      await copyText(text)
      say(okNotice, key)
    } catch {
      say(batchText('batch.toast.copy-fail', currentLang()), key)
    }
    render()
  }

  /** 把一次回包吃进状态：ok 认账本与行，不 ok 只记稳定码（表照旧留着，别让人丢视图）。 */
  function applyReply(reply: unknown): void {
    if (!isObject(reply)) {
      lastError = 'internal'
      return
    }
    if (reply['ok'] === true) {
      const session = normalizeBatchSession(reply['session'])
      const parsed = readRows(reply['rows'])
      rows = parsed.length > 0 ? parsed : rowsFromSession(session)
      lastSession = session
      if (isObject(reply['inventory'])) {
        lastInventory = reply['inventory']
        const at = (reply['inventory'] as Record<string, unknown>)['updatedAt']
        if (typeof at === 'number' && Number.isFinite(at) && at > 0) lastCheckedAt = at
      }
      if (isObject(reply['prefs'])) lastPrefs = reply['prefs']
      loaded = true
      lastError = null
      if (expandedKey !== null && !rows.some((row) => row.key === expandedKey)) expandedKey = null
      return
    }
    const err = typeof reply['error'] === 'string' ? reply['error'].trim() : ''
    const kind = typeof reply['errorKind'] === 'string' ? reply['errorKind'].trim() : ''
    lastError = kind || err || 'internal'
  }

  async function refresh(): Promise<void> {
    if (!mounted || refreshing) return
    refreshing = true
    try {
      const reply = await call(phones.status, {})
      if (!mounted) return
      applyReply(reply)
    } catch {
      if (!mounted) return
      lastError = 'check-failed'
    } finally {
      refreshing = false
    }
    render()
    maybeAutoRowChangelog(expandedKey)
  }

  /**
   * 打一次批量电话：飞之前先置忙（两个宏一起灰），回来后重绘。
   * busyRowKey 给「只推这一家」那条路：回包说忙时只给一句排队回执，绝不记成失败。
   * 回包原样返回（调用方按 resumed 等事实决定回执，杜绝空话成功）。
   */
  async function phone(name: string, args: Record<string, unknown>, busyRowKey: string | null = null): Promise<Record<string, unknown> | null> {
    if (!mounted || inFlight) return null
    inFlight = true
    clearNotice()
    render()
    let out: Record<string, unknown> | null = null
    try {
      const reply = await call(name, args)
      if (!mounted) return null
      if (busyRowKey !== null && isBusyReply(reply)) {
        // 老宿主还没接住这次入队：如实说「没排上，等它装完再点」，不画失败横幅、不把行记成失败。
        say(batchText('batch.toast.queue-missed', currentLang()), busyRowKey)
        return null
      }
      applyReply(reply)
      // 批量查/装一次是明确意图：清掉各行失败退避，下面的按行链路可再问一次。
      rowFailedAt.clear()
      out = isObject(reply) ? (reply as Record<string, unknown>) : null
    } catch {
      if (!mounted) return null
      lastError = 'check-failed'
      out = null
    } finally {
      inFlight = false
      if (mounted) render()
    }
    maybeAutoRowChangelog(expandedKey)
    return out
  }

  function remainingCount(): number {
    return unfinishedCount(rows, lastSession ?? undefined)
  }

  function checkOnOpenEffective(): boolean {
    if (isObject(lastPrefs)) {
      const v = (lastPrefs as Record<string, unknown>)['checkOnOpen']
      if (v === false) return false
      if (v === true) return true
    }
    return checkOnOpenOption
  }

  function nowMs(): number {
    try {
      return Date.now()
    } catch {
      return 0
    }
  }

  async function act(kind: BatchPanelActionKind, key?: string): Promise<void> {
    if (!mounted) return
    // 点别的按钮，上膛的取消确认自动撤销（当即重绘，不等人）。
    if (kind !== 'cancel' && confirmCancelArmed) {
      confirmCancelArmed = false
      render()
    }
    switch (kind) {
      case 'check':
        await phone(phones.check, {})
        return
      case 'install':
        // 不点 keys 即「全部提交」：会话与推进由宿主驱动器保证。
        await phone(phones.install, {})
        return
      case 'row-install': {
        if (typeof key !== 'string' || !key) return
        // 行内「安装这家」/「重试」/「加入队列」：只推这一家（同一会话同一幂等编号，重复提交不重复装）。
        await phone(phones.install, { keys: [key] }, key)
        return
      }
      case 'resume': {
        const reply = await phone(phones.resume, {})
        if (!mounted) return
        if (!reply || reply['ok'] !== true) return
        if (reply['resumed'] === false) {
          say(batchText('batch.notice.no-resume', currentLang()))
          render()
          return
        }
        say(batchText('batch.notice.resumed', currentLang(), { count: String(remainingCount()) }))
        render()
        return
      }
      // 程序调用（controller.act）即执行：调它就是明确意图，不上膛。
      // 鼠标误触的防护在 onClick 那一层（第一次点击只上膛）。
      case 'cancel': {
        confirmCancelArmed = false
        const reply = await phone(phones.cancel, {})
        if (!mounted) return
        if (!reply || reply['ok'] !== true) return
        say(batchText('batch.notice.discarded', currentLang()))
        render()
        return
      }
      case 'toggle-check-on-open': {
        const next = !checkOnOpenEffective()
        const reply = await phone(phones.prefsSave, { checkOnOpen: next })
        if (!mounted) return
        if (reply && reply['ok'] === true && isObject(reply['prefs'])) lastPrefs = reply['prefs']
        render()
        return
      }
      // —— 详情里的动作行（与行内同一通道：都走 row-install / row-skip 这些 data-act）——
      case 'row-skip': {
        const row = typeof key === 'string' && key ? rowOfKey(key) : null
        const version = row ? latestVersionOf(row) : null
        if (!row || !version) return
        try {
          skipStoreFor(pluginIdOf(row)).skip(version)
        } catch {
          // 跳记不进去也不挡更新，只是不免打扰（版本号非法时同此）。
        }
        say(batchText('batch.toast.skipped', currentLang(), { version }), row.key)
        render()
        return
      }
      case 'row-resume-skip': {
        const row = typeof key === 'string' && key ? rowOfKey(key) : null
        if (!row) return
        const version = latestVersionOf(row)
        try {
          skipStoreFor(pluginIdOf(row)).reset(version ?? undefined)
        } catch {
          // 同上：清不掉也不挡更新。
        }
        say(version ? batchText('batch.toast.unskipped-version', currentLang(), { version }) : batchText('batch.toast.unskipped-all', currentLang()), row.key)
        render()
        return
      }
      // 「取消排队」：走**该家自己的**单插件安装电话（宿主支持 cancelQueued：只撤自己那条 waiting，
      // 不碰别家、也不碰正在装的拥有者）。批量取消会清掉整轮会话，所以这里绝不用它顶。
      case 'row-cancel-queue': {
        const row = typeof key === 'string' && key ? rowOfKey(key) : null
        if (!row) return
        const phoneName = cancelQueuePhoneOf(row)
        const requestId = queuedRequestIdOf(row)
        if (phoneName === null || requestId === null) {
          say(batchText('batch.toast.cancel-unavailable', currentLang()), row.key)
          render()
          return
        }
        if (inFlight) return
        inFlight = true
        clearNotice()
        render()
        try {
          // 单插件回包形状与批量回包不同（没有 ok/session/rows），所以不进 applyReply，只当回执。
          await call(phoneName, { cancelQueued: true, requestId })
          if (mounted) say(batchText('batch.toast.cancel-ok', currentLang()), row.key)
        } catch {
          if (mounted) say(batchText('batch.toast.cancel-fail', currentLang()), row.key)
        } finally {
          inFlight = false
        }
        await refresh()
        return
      }
      case 'row-copy-manual': {
        const row = typeof key === 'string' && key ? rowOfKey(key) : null
        const manual = row && typeof row.manual === 'string' ? row.manual : ''
        if (!row || !manual) return
        await copyWith(manual, batchText('batch.toast.copy-manual-ok', currentLang()), row.key)
        return
      }
      case 'row-copy-diag': {
        const row = typeof key === 'string' && key ? rowOfKey(key) : null
        if (!row) return
        await copyWith(diagTextOf(row, currentLang()), batchText('batch.toast.copy-diag-ok', currentLang()), row.key)
        return
      }
      case 'toggle-details': {
        if (typeof key !== 'string' || !key) return
        expandedKey = expandedKey === key ? null : key
        render()
        maybeAutoRowChangelog(expandedKey)
        return
      }
      // 「重启宿主」：宿主没有重启自己的电话，只做入口——调用方给了 onRestartRequested 就交给它，
      // 没给就如实说「请手动重启」，不假装能重启（与单插件面板逐字同一口径）。
      case 'restart': {
        try {
          if (typeof onRestartRequested === 'function') {
            await onRestartRequested()
            say(batchText('batch.toast.restart-delegated', currentLang()))
          } else {
            say(batchText('batch.toast.restart-manual', currentLang()))
          }
        } catch {
          say(batchText('batch.toast.restart-failed', currentLang()))
        }
        render()
        return
      }
      case 'close': {
        await requestDialogClose()
        return
      }
      default:
        return
    }
  }

  /** 弹窗关闭：dialog 下点「关闭」/按 Esc 走这里；有落地回调先交调用方撤 DOM，再停轮询。 */
  async function requestDialogClose(): Promise<void> {
    if (!mounted || mode !== 'dialog') return
    if (onCloseRequested) {
      try {
        await onCloseRequested()
      } catch {
        // 调用方撤 DOM 失败也不挡停轮询。
      }
    }
    unmount()
  }

  function onKeyDown(ev: unknown): void {
    // Esc 关弹窗：焦点在面板内时按键冒泡到容器；与「关闭」按钮同口径（可配落地，不动宿主）。
    try {
      const e = ev as { key?: unknown } | null | undefined
      if (!mounted || mode !== 'dialog' || !e || e.key !== 'Escape') return
      void requestDialogClose()
    } catch {
      // 按坏了也不挡更新。
    }
  }

  function setTheme(next: UpdatePanelTheme): void {
    if (next !== 'default' && next !== 'archive') {
      throw new Error('[dsh-plugin-update] 主题非法：只收 default 或 archive（收到 ' + JSON.stringify(next) + '）')
    }
    theme = normalizePanelTheme(next)
    render()
  }

  function setMode(next: BatchPanelMode): void {
    if (next !== 'embedded' && next !== 'dialog') {
      throw new Error('[dsh-plugin-update] 摆放形态非法：只收 embedded 或 dialog（收到 ' + JSON.stringify(next) + '）')
    }
    mode = next
    render()
  }

  function onClick(ev: unknown): void {
    try {
      const t = ev as {
        target?: { closest?: (sel: string) => { getAttribute?: (n: string) => string | null } | null } | null
      }
      const btn = t?.target && typeof t.target.closest === 'function' ? t.target.closest('[data-act]') : null
      const kind = btn?.getAttribute ? btn.getAttribute('data-act') : null
      if (!kind) return
      // 鼠标路径的两步确认：第一次只上膛（红框 + 换文案），第二次才真取消。
      // 程序调 controller.act('cancel') 不走这里，仍是一次即执行。
      if (kind === 'cancel' && !confirmCancelArmed) {
        confirmCancelArmed = true
        say(batchText('batch.notice.cancel-confirm', currentLang()))
        render()
        return
      }
      if (kind === 'cancel') confirmCancelArmed = false
      const key = btn?.getAttribute ? btn.getAttribute('data-key') : null
      void act(kind as BatchPanelActionKind, key === null ? undefined : key)
    } catch {
      // 点坏了也不挡更新。
    }
  }

  /** 打开即查/续（#59 D3/Q3）：每挂载最多各一次；自动失败不弹红条，只留行上标记。 */
  async function autoOnce(): Promise<void> {
    if (!mounted) return
    if (autoResumeOption && !autoResumeDone) {
      autoResumeDone = true
      if (hasUnfinishedRows(rows, lastSession ?? undefined) && !inFlight && !refreshing) {
        const before = lastError
        try {
          const reply = await call(phones.resume, {})
          if (!mounted) return
          if (isObject(reply) && reply['ok'] === true) {
            applyReply(reply)
            const r = reply as Record<string, unknown>
            if (r['resumed'] !== false) {
              say(batchText('batch.notice.auto-resumed', currentLang(), { count: String(remainingCount()) }))
              rowFailedAt.clear()
            }
            render()
            maybeAutoRowChangelog(expandedKey)
            return
          }
          lastError = before
          render()
        } catch {
          if (mounted) render()
        }
      }
    }
    if (!autoCheckDone) {
      autoCheckDone = true
      if (!checkOnOpenEffective()) return
      if (hasUnfinishedRows(rows, lastSession ?? undefined)) return
      const stale = lastCheckedAt <= 0 || nowMs() - lastCheckedAt >= 60000
      if (!stale || inFlight || refreshing) return
      const before = lastError
      try {
        const reply = await call(phones.check, {})
        if (!mounted) return
        if (isObject(reply) && reply['ok'] === true) {
          applyReply(reply)
          rowFailedAt.clear()
          render()
          maybeAutoRowChangelog(expandedKey)
          return
        }
        lastError = before
        render()
      } catch {
        if (mounted) render()
      }
    }
  }

  function unmount(): void {
    if (!mounted) return
    mounted = false
    try {
      unsubLang()
    } catch {
      // 停不掉也无妨。
    }
    // 过期回包丢弃（#38）：序号加一 + 在途集合清空，在飞的取数回来即丢。
    rowAutoSeq++
    rowInflight.clear()
    try {
      timer.clear(handle)
    } catch {
      // 停不掉也无妨：批量更新在宿主侧跑，面板计时器只是轮询。
    }
    try {
      container.removeEventListener?.('click', onClick)
    } catch {
      // 拆不掉也不挡。
    }
    try {
      container.removeEventListener?.('keydown', onKeyDown)
    } catch {
      // 拆不掉也不挡。
    }
    // 卸载只停轮询：绝不调安装/取消电话，批量推进在宿主进程内继续跑。
  }

  // #64 v2 语言跟随：已挂载控件即时重绘，unmount 后停订（单例观察者，显式 locale 对象亦经同一出口）。
  const unsubLang = subscribeLang(() => {
    render()
  }, localeOpt)
  // 首绘即「正在读取…」，立刻查一次（重开即恢复进度），再按间隔轮询。
  render()
  try {
    container.addEventListener?.('click', onClick)
  } catch {
    // 没有事件能力的容器也能看（按钮走 controller.act）。
  }
  try {
    container.addEventListener?.('keydown', onKeyDown)
  } catch {
    // 没有键盘事件能力的容器忽略（Esc 关弹窗是渐进增强）。
  }
  const timer = getTimer()
  const handle = timer.set(() => {
    if (inFlight) return
    void refresh()
  }, pollMs)
  try {
    // 轮询不占进程退出：批量推进在宿主侧跑，面板计时器只是视图刷新。
    const h = handle as { unref?: () => void } | null
    if (h && typeof h.unref === 'function') h.unref()
  } catch {
    // 无 unref 的环境（浏览器）忽略。
  }
  void refresh().then(() => {
    void autoOnce()
  })

  return { refresh, act, setTheme, setMode, unmount }
}
