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
import { validReleaseVersion } from './service.js'
import {
  isTerminalPhase,
  normalizeBatchSession,
  type BatchPhase,
  type BatchSession,
} from './batch.js'
import {
  UPDATE_PANEL_CSS,
  UPDATE_PANEL_D5_CSS,
  buildDiagnosticText,
  createBrowserSkipStore,
  failureCopy,
  isKnownFailureCode,
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

/** 批量五个电话名（与宿主侧 MultiHostUpdate.phoneNames 同一形状）。 */
export interface BatchPhoneNames {
  status: string
  check: string
  install: string
  resume: string
  cancel: string
}

/** 批量面板轮询口径（默认 1.5 秒、下限 250 毫秒，与单插件面板同一套下限）。 */
export const BATCH_PANEL_POLL = {
  defaultMs: 1500,
  minMs: MIN_PANEL_POLL_MS,
} as const

/** 批量电话名拼法：前缀 + 五个固定动作名（前缀形状校验与单插件面板同一套）。 */
export function buildBatchPhoneNames(prefix: string): BatchPhoneNames {
  const p = assertPrefix(prefix, '批量电话前缀 prefix')
  return {
    status: p + '.batchStatus',
    check: p + '.batchCheck',
    install: p + '.batchInstall',
    resume: p + '.batchResume',
    cancel: p + '.batchCancel',
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

/** 分类计数 → 一句话总账（只出现非零档，顺序固定：可更新 · 安装中 · 待查 · 待重启 · 失败 · 已跳过 · 已最新）。 */
export function batchLedgerText(counts: BatchLedgerCounts): string {
  const parts: string[] = []
  if (counts.updatable > 0) parts.push(counts.updatable + ' 家可更新')
  if (counts.installing > 0) parts.push(counts.installing + ' 家安装中')
  if (counts.pending > 0) parts.push(counts.pending + ' 家待查')
  if (counts.restart > 0) parts.push(counts.restart + ' 家待重启')
  if (counts.failed > 0) parts.push(counts.failed + ' 家失败')
  if (counts.skipped > 0) parts.push(counts.skipped + ' 家已跳过')
  if (counts.settled > 0) parts.push(counts.settled + ' 家已最新')
  return parts.length > 0 ? parts.join(' · ') : '还没有目标'
}

/**
 * 排队中的状态词：只回答「还要等多久」。位置从该行的队列视图来。
 * queue.ts 的 position 是 waiting 顺位（队首为 1、0 = 自己正在装），而正在装的那一家也压在这一家前面，
 * 所以「前方 N 个」= position N（队首那家前方正好 1 个：正在装的拥有者）。
 * 位置取不到（宿主只记了忙、没给占位读数）就说「等前面安装完」，不猜数字。
 */
export function batchQueuedStatus(position: number | null): string {
  if (typeof position !== 'number' || !Number.isFinite(position) || position < 1) return '已排队 · 等前面安装完'
  return '已排队 · 前方 ' + position + ' 个'
}

/**
 * 一行的状态词：只回答一个问题——这家的**下一步**是什么。
 * 中文可执行，不写相位英文（相位只留在 data-phase 属性上，给人看的这句永远是动作）。
 */
export function batchRowStatus(row: BatchRowView, skippedVersion?: string | null): string {
  const skipped = typeof skippedVersion === 'string' && skippedVersion ? skippedVersion : null
  if (skipped !== null && asBatchPhase(row.phase) === 'ready') return '已跳过 ' + skipped
  switch (asBatchPhase(row.phase)) {
    case 'pending':
      return '等它，轮到就自动查新版'
    case 'checking':
      return '正在查新版，稍等'
    case 'ready':
      return row.targetVersion
      ? '点「安装这家」安装 ' + row.targetVersion
      : '点「安装这家」安装新版'
    case 'installing':
      return '正在安装，别动'
    case 'current':
      return '已是最新，不用动'
    case 'done':
      return row.restartRequired === true ? '安装好了，重启宿主才生效' : '安装好了，不用动'
    case 'failed':
      return '安装没成功，点「重试」再来一次'
    case 'skipped':
      return '这一版已跳过，不用动'
    default:
      return '状态认不出，点「检查更新」重查一次'
  }
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
}

/** 整面板 HTML（含样式；重绘即整体替换 innerHTML，故每次都带 style 也只留一份）。 */
export function renderBatchPanelHTML(input: BatchPanelRenderInput): string {
  const rows: readonly BatchRowView[] = Array.isArray(input.rows) ? input.rows : []
  const theme: UpdatePanelTheme = input.theme === 'd5-paper' ? 'd5-paper' : 'default'
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
  const terminal = total > 0 && rows.every((row) => isTerminalPhase(asBatchPhase(row.phase)))
  const stalled =
    total > 0 &&
    !terminal &&
    !rows.some((row) => {
      const phase = asBatchPhase(row.phase)
      return phase === 'installing' || phase === 'checking'
    })
  const disabled = macroBusy ? ' disabled' : ''
  const notice = typeof input.notice === 'string' && input.notice ? input.notice : null
  const noticeKey = typeof input.noticeKey === 'string' && input.noticeKey ? input.noticeKey : null
  // 回执挂在该家详情里（那家正展开才算数）；否则落回面板底部那条。
  const detailNoticeKey = notice !== null && noticeKey !== null && noticeKey === expandedKey ? noticeKey : null
  const changelogs = input.changelogs && typeof input.changelogs === 'object' ? input.changelogs : {}
  const ctx: RowRenderContext = {
    expanded: false,
    busy: installing,
    inFlight: input.inFlight === true,
    theme,
    titles,
    skipped: null,
    notice: null,
    changelogMarkdown: null,
  }
  const parts: string[] = []

  // 顶部一行：卷宗抬头 + 两件宏（忙守卫：任一行安装中，两个批量入口一起置灰）。
  parts.push('<div class="dsh-upd-batch-head">')
  parts.push('<div class="dsh-upd-batch-title">更新档案 · <i>总账</i></div>')
  parts.push('<div class="dsh-upd-batch-macros">')
  parts.push('<button type="button" data-act="check"' + disabled + ' title="重新读取批量状态（只读）">检查更新</button>')
  parts.push('<button type="button" data-act="install" data-primary="1"' + disabled + ' title="把有新版的几家一次提交；同一会话同一幂等编号">全部更新</button>')
  if (mode === 'dialog') parts.push('<button type="button" data-act="close" title="关闭面板（批量推进在宿主侧继续跑）">关闭</button>')
  parts.push('</div>')
  parts.push('</div>')

  // 一句话总账（有没有事）。
  const summary = loaded
    ? batchSummaryText(counts, rows, total, installing, lastError !== null)
    : '正在读取批量更新状态…'
  parts.push('<div class="dsh-upd-batch-sum" role="status" aria-live="polite">' + escapeHtml(summary) + '</div>')

  // 常驻横幅：失败与待重启不藏进抽屉。
  parts.push(bannersHTML(rows, titles, lastError))

  // 明细：一行一家。
  parts.push('<div class="dsh-upd-btable">')
  for (const row of rows) {
    const raw = skippedVersions[row.key]
    const skipped = typeof raw === 'string' && raw ? raw : null
    const expanded = row.key === expandedKey
    parts.push(
      rowSetHTML(row, {
        ...ctx,
        expanded,
        skipped,
        notice: expanded && row.key === detailNoticeKey ? notice : null,
        changelogMarkdown:
          expanded && typeof changelogs[row.key] === 'string' ? (changelogs[row.key] as string) : null,
      }),
    )
  }
  parts.push('</div>')

  // 表下一行分类总账。
  if (total > 0) {
    parts.push('<div class="dsh-upd-batch-ledger">' + escapeHtml(batchLedgerText(counts)) + '</div>')
  }

  // 断点续跑与取消（会话没进终态才有意义；不与顶部两件宏抢位）。
  if (total > 0 && !terminal) {
    const more: string[] = []
    if (stalled) more.push('<button type="button" data-act="resume">接着上次</button>')
    // 忙守卫同理：安装中「取消」停不了正在跑的那一家（宿主侧取消只清会话），别给人假动作。
    // 两步确认：第一次只上膛（红框 + 换文案），第二次才真取消；点别的按钮自动卸膛。
    const confirmCancel = input.confirmCancel === true
    more.push(
      '<button type="button" data-act="cancel"' + disabled +
        (confirmCancel
          ? ' data-confirm="1" title="再点一次确认取消"'
          : ' title="取消这一批（要点两次确认，防误触）"') +
        '>' + (confirmCancel ? '确认取消这一批' : '取消这一批') + '</button>',
    )
    parts.push('<div class="dsh-upd-batch-more">' + more.join('') + '</div>')
  }
  if (notice !== null && detailNoticeKey === null) {
    parts.push('<div class="dsh-upd-batch-notice" role="status">' + escapeHtml(notice) + '</div>')
  }

  const kernel = parts.join(String.fromCharCode(10))
  // 主题只换肤：默认不带 data-theme、不带 D5 串；d5-paper 才挂属性并追加两份 D5 皮肤。
  const d5 = theme === 'd5-paper'
  const attr = d5 ? ' data-theme="d5-paper"' : ''
  const seal = batchSealOf(counts)
  const root =
    '<div class="dsh-upd dsh-upd-batch" data-mode="' + mode + '" data-seal="' + escapeHtml(seal.text) +
    '" data-seal-tone="' + seal.tone + '"' + attr + '>\n' + kernel + '\n</div>'
  const body = mode === 'dialog' ? '<div class="dsh-upd-overlay" data-mode="dialog">' + root + '</div>' : root
  const css = d5
    ? [UPDATE_PANEL_CSS, UPDATE_BATCH_PANEL_CSS, UPDATE_PANEL_D5_CSS, UPDATE_BATCH_PANEL_D5_CSS].join(String.fromCharCode(10))
    : [UPDATE_PANEL_CSS, UPDATE_BATCH_PANEL_CSS].join(String.fromCharCode(10))
  return '<style>' + css + '</style>\n' + body
}

/** 一句话总账：先答「有没有事」。 */
function batchSummaryText(
  counts: BatchLedgerCounts,
  rows: readonly BatchRowView[],
  total: number,
  installing: boolean,
  hasError: boolean,
): string {
  if (hasError) return '刚才那次没成功：看下面的红条，照它说的做一次。'
  if (total === 0) return '还没有目标：点「检查更新」看看哪几家有新版。'
  if (installing) {
    // 忙不等于别的家不能动：可以排队（入队不算失败），所以这里说的是「还能怎么加进来」。
    const canQueue = rows.filter((row) => asBatchPhase(row.phase) === 'ready' && !isQueuedRow(row)).length
    return canQueue > 0
      ? '正在安装 ' + counts.installing + ' 家；还有 ' + canQueue + ' 家可以点「加入队列」排队等。'
      : '正在安装 ' + counts.installing + ' 家，安装完自动下一家。'
  }
  if (counts.failed > 0) return counts.failed + ' 家安装失败；照下面的失败提示逐家重试。'
  if (counts.updatable > 0)
    return counts.updatable + ' 家可更新；点「全部更新」一次安装完，也可以逐家点「安装这家」。'
  if (counts.restart > 0) return counts.restart + ' 家已安装好，重启宿主后生效。'
  if (counts.pending > 0) return counts.pending + ' 家还没查过；点「检查更新」查一轮。'
  return '全部已最新，没有要做的。'
}

/** 印章（D5 才画）：色调按总账里最重的一档走。 */
function batchSealOf(counts: BatchLedgerCounts): { text: string; tone: 'ink' | 'green' | 'yellow' | 'red' } {
  if (counts.failed > 0) return { text: '总账', tone: 'red' }
  if (counts.installing > 0 || counts.restart > 0) return { text: '总账', tone: 'yellow' }
  if (counts.updatable > 0) return { text: '总账', tone: 'green' }
  return { text: '总账', tone: 'ink' }
}

/** 常驻横幅：批量电话失败 / 有失败行 / 有待重启行（都不许藏进抽屉）。 */
function bannersHTML(rows: readonly BatchRowView[], titles: Record<string, string>, lastError: string | null): string {
  const parts: string[] = []
  if (lastError) {
    const copy = failureCopy(lastError)
    parts.push(
      '<div class="dsh-upd-banner" data-kind="failed" data-mini="阻" role="status">' +
        '<div><strong>这次没成功（' + escapeHtml(lastError) + '）：' +
        escapeHtml(copy ? copy.zh : '认不出具体原因') + '。</strong></div>' +
        '<div>' + escapeHtml(copy ? copy.act : '先重试一次；一直这样就把复制诊断交给插件作者。') + '</div>' +
        '</div>',
    )
  }
  // 排队占位不算失败：忙时宿主会把它记成 failed+update-busy，这里翻回来。
  const failed = rows.filter((row) => asBatchPhase(row.phase) === 'failed' && !isQueueBusyRow(row))
  if (failed.length > 0) {
    const lines = failed
      .map((row) => {
        const code = row.error || 'install-failed'
        const copy = failureCopy(code)
        return (
          '<div>' + escapeHtml(titleOf(row, titles)) + '：<code>' + escapeHtml(code) + '</code> ' +
          escapeHtml(copy ? copy.zh : '认不出具体原因') + '</div>'
        )
      })
      .join('')
    parts.push(
      '<div class="dsh-upd-banner" data-kind="failed" data-mini="阻" role="status">' +
        '<div><strong>' + failed.length + ' 家安装失败。</strong></div>' +
        '<div>逐家点行内「重试」再来一次；一直失败就把复制诊断交给插件作者。</div>' +
        '<div class="dsh-upd-blist">' + lines + '</div>' +
        '</div>',
    )
  }
  const restart = rows.filter((row) => row.restartRequired === true)
  if (restart.length > 0) {
    parts.push(
      '<div class="dsh-upd-banner" data-kind="restart" role="status">' +
        '<div><strong>' + restart.length + ' 家已安装好，重启宿主后生效。</strong></div>' +
        // 措辞与单插件面板 BLOCKED_COPY['pending-restart'] 同一句：正常终态，不是失败。
        '<div>重启宿主，让新版跑起来；这是正常终态，不是失败。</div>' +
        '<div class="dsh-upd-blist">' + restart.map((row) => escapeHtml(titleOf(row, titles))).join('、') + '</div>' +
        '<div><button type="button" data-act="restart" data-primary="1">重启宿主</button></div>' +
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
      '<button type="button" data-act="row-install" data-key="' + keyAttr + '" disabled>安装中…</button>',
    )
  } else if (queued) {
    // 排队那行的下一步是「取消排队」：撤掉自己的占位（别家与正在装的拥有者都不碰）。
    if (cancelQueuePhoneOf(row) !== null && queuedRequestIdOf(row) !== null) {
      actions.push(
        '<button type="button" data-act="row-cancel-queue" data-key="' + keyAttr + '"' + off + '>取消排队</button>',
      )
    }
  } else if (phase === 'ready' && skipped === null) {
    actions.push(
      '<button type="button" data-act="row-install" data-key="' + keyAttr + '" data-primary="1"' + off + '>' +
        (ctx.busy ? '加入队列' : '安装这家') + '</button>',
    )
  } else if (phase === 'ready' && skipped !== null) {
    // 跳过后这一版的下一步是「恢复」：与单插件面板同一套本地跳过语义（按插件 + 版本记）。
    actions.push(
      '<button type="button" data-act="row-resume-skip" data-key="' + keyAttr + '"' + off +
        '>恢复（' + escapeHtml(skipped) + '）</button>',
    )
  } else if (phase === 'failed') {
    actions.push(
      '<button type="button" data-act="row-install" data-key="' + keyAttr + '"' + off + '>' +
        (ctx.busy ? '加入队列' : '重试') + '</button>',
    )
  }
  if (row.restartRequired === true) {
    // 与单插件面板同一措辞：宿主没有重启自己的电话，这里只做入口。
    actions.push('<button type="button" data-act="restart" data-key="' + keyAttr + '">重启宿主</button>')
  }
  actions.push(
    '<button type="button" data-act="toggle-details" data-key="' + keyAttr + '">' +
      (ctx.expanded ? '收起' : '详情') + '</button>',
  )
  const failLine =
    phase === 'failed' && !queued
      ? '<span class="dsh-upd-bfail">失败 <code>' + escapeHtml(row.error || 'install-failed') + '</code>：' +
        escapeHtml(failureCopy(row.error || 'install-failed')?.zh ?? '认不出具体原因') + '</span>'
      : ''
  const main =
    '<button type="button" class="dsh-upd-brow-main" data-act="toggle-details" data-key="' + keyAttr +
    '" aria-expanded="' + (ctx.expanded ? 'true' : 'false') + '">' +
    '<span class="dsh-upd-updot" data-tone="' + dotToneOf(row, phase, skipped, queued) + '"></span>' +
    '<span class="dsh-upd-bname">' + escapeHtml(titleOf(row, ctx.titles)) + '</span>' +
    (version ? '<span class="dsh-upd-bver">' + escapeHtml(version) + '</span>' : '') +
    '<span class="dsh-upd-bstat">' + escapeHtml(queued ? batchQueuedStatus(position) : batchRowStatus(row, skipped)) + '</span>' +
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
  })
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
    buttons.push('<button type="button" data-act="row-install" data-key="' + keyAttr + '" disabled>安装中…</button>')
  } else if (queued) {
    if (cancelQueuePhoneOf(row) !== null && queuedRequestIdOf(row) !== null) {
      buttons.push(
        '<button type="button" data-act="row-cancel-queue" data-key="' + keyAttr + '"' + off + '>取消排队</button>',
      )
    }
  } else if (phase === 'failed') {
    buttons.push(
      '<button type="button" data-act="row-install" data-key="' + keyAttr + '"' + off + '>' +
        (ctx.busy ? '加入队列' : '重试') + '</button>',
    )
  } else if (phase === 'ready' && ctx.skipped === null) {
    buttons.push(
      '<button type="button" data-act="row-install" data-key="' + keyAttr + '" data-primary="1"' + off +
        '>' + (ctx.busy ? '加入队列' : '安装 ' + escapeHtml(version ?? '新版')) + '</button>',
    )
  }
  if (!queued && phase === 'ready' && ctx.skipped === null && version !== null) {
    buttons.push(
      '<button type="button" data-act="row-skip" data-key="' + keyAttr + '"' + off + '>跳过这一版</button>',
    )
  }
  if (ctx.skipped !== null) {
    buttons.push(
      '<button type="button" data-act="row-resume-skip" data-key="' + keyAttr + '"' + off +
        '>恢复（' + escapeHtml(ctx.skipped) + '）</button>',
    )
  }
  if (typeof row.manual === 'string' && row.manual) {
    buttons.push(
      '<button type="button" data-act="row-copy-manual" data-key="' + keyAttr + '"' + off + '>复制手工命令</button>',
    )
  }
  buttons.push('<button type="button" data-act="row-copy-diag" data-key="' + keyAttr + '"' + off + '>复制诊断</button>')
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

// ---------- 样式（同一套 dsh-upd-* 前缀；默认最小，D5 另起一串） ----------

export const UPDATE_BATCH_PANEL_CSS = [
  '/* 批量面板（#25）：类名沿用 dsh-upd-* 前缀；默认（最小）主题，D5 皮肤见 UPDATE_BATCH_PANEL_D5_CSS。 */',
  '.dsh-upd-batch-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap}',
  '.dsh-upd-batch-title{font-weight:700;font-size:15px;letter-spacing:.06em}',
  '.dsh-upd-batch-title i{font-style:normal;color:var(--dsh-upd-primary,#2563eb)}',
  '.dsh-upd-batch-macros{flex:none}',
  '.dsh-upd-batch-sum{margin:4px 0 8px;font-size:13.5px}',
  '.dsh-upd-btable{margin-top:2px}',
  '.dsh-upd-brow-set{border-top:1px solid var(--dsh-upd-line,#e5e7eb)}',
  '.dsh-upd-brow-set:first-child{border-top:0}',
  '.dsh-upd-brow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 0}',
  '.dsh-upd .dsh-upd-brow-main{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:1 1 260px;min-width:0;',
  'text-align:left;cursor:pointer;color:inherit;font:inherit;background:transparent;border:0;padding:2px 0;margin:0}',
  '.dsh-upd .dsh-upd-brow-main:hover{color:var(--dsh-upd-primary,#2563eb)}',
  '.dsh-upd-brow-actions{flex:none;margin-left:auto}',
  '.dsh-upd-brow-actions button{font-size:12.5px}',
  '.dsh-upd-updot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsh-upd-line,#9ca3af);opacity:.55}',
  '.dsh-upd-updot[data-tone="todo"]{background:var(--dsh-upd-ok-line,#059669);opacity:1}',
  '.dsh-upd-updot[data-tone="ok"]{background:var(--dsh-upd-ok-line,#059669);opacity:1}',
  '.dsh-upd-updot[data-tone="busy"]{background:var(--dsh-upd-busy-line,#2563eb);opacity:1}',
  '.dsh-upd-updot[data-tone="warn"]{background:var(--dsh-upd-warn-line,#d97706);opacity:1}',
  '.dsh-upd-updot[data-tone="bad"]{background:var(--dsh-upd-bad-line,#dc2626);opacity:1}',
  '.dsh-upd-bname{font-weight:700;flex:none}',
  '.dsh-upd-bver{font-family:Consolas,Menlo,monospace;font-size:12px;opacity:.8;flex:none}',
  '.dsh-upd-bstat{font-size:12.5px;opacity:.9}',
  '.dsh-upd-bfail{flex:1 1 100%;display:block;font-size:12.5px;color:var(--dsh-upd-bad-line,#dc2626)}',
  '.dsh-upd-blist{font-size:12.5px;margin-top:2px}',
  '.dsh-upd-batch-ledger{margin:8px 0 0;font-size:13px;opacity:.85}',
  '.dsh-upd-batch-more{margin-top:6px}',
  '.dsh-upd-batch-more button{font-size:12px}',
  // 确认态：红框红字，与「关闭」等中性按钮一眼区分；disabled 照旧置灰。
  '.dsh-upd-batch-more button[data-confirm="1"]{border-color:var(--dsh-upd-bad-line,#dc2626);color:var(--dsh-upd-bad-line,#dc2626)}',
  '.dsh-upd-batch-notice{margin-top:6px;font-size:12.5px;opacity:.85}',
  '.dsh-upd-bdetail-actions{margin:0 0 6px}',
  '.dsh-upd .dsh-upd-bdetail-actions button{font-size:12.5px}',
  '.dsh-upd-bdetail-notice{margin:0 0 6px;font-size:12.5px;opacity:.85}',
  '/* 详情复用单插件内核：不许嵌套滚动——中性化 overlay 的 max-height/overflow，自身也不给 overflow。 */',
  '.dsh-upd-bdetail{margin:2px 0 10px;overflow:visible}',
  '.dsh-upd .dsh-upd-bdetail .dsh-upd{max-width:none}',
  '.dsh-upd-overlay .dsh-upd-bdetail .dsh-upd{max-height:none;overflow:visible}',
  '@media (prefers-color-scheme: dark){.dsh-upd-batch-title i{color:var(--dsh-upd-focus,#93c5fd)}}',
  '@media (prefers-reduced-motion: reduce){.dsh-upd-batch *{transition:none !important;animation:none !important}}',
].join(String.fromCharCode(10))

/**
 * 批量面板的 D5 皮肤（#20 同一套口径：只换颜色/字体/间距，不改顺序、不藏东西）。
 * 卷宗抬头右侧给大印章留 120px（与单插件面板档案头同一处理）。
 */
export const UPDATE_BATCH_PANEL_D5_CSS = [
  '/* 批量面板的 D5 皮肤：只换颜色/字体/间距；根上的大印章由 UPDATE_PANEL_D5_CSS 负责。 */',
  '.dsh-upd[data-theme="d5-paper"] .dsh-upd-batch-head{padding-right:120px}',
  '.dsh-upd[data-theme="d5-paper"] .dsh-upd-batch-title{font-family:var(--d5-serif);font-size:21px;letter-spacing:.04em}',
  '.dsh-upd[data-theme="d5-paper"] .dsh-upd-batch-title i{color:var(--d5-accent)}',
  '.dsh-upd[data-theme="d5-paper"] .dsh-upd-brow-main{background:transparent;border:0;color:var(--d5-ink)}',
  '.dsh-upd[data-theme="d5-paper"] .dsh-upd-brow-main:hover{color:var(--d5-accent)}',
  '.dsh-upd[data-theme="d5-paper"] .dsh-upd-bname{font-family:var(--d5-serif)}',
  '.dsh-upd[data-theme="d5-paper"] .dsh-upd-bver{font-family:var(--d5-mono);color:var(--d5-muted)}',
  '.dsh-upd[data-theme="d5-paper"] .dsh-upd-batch-ledger{color:var(--d5-muted)}',
  '.dsh-upd[data-theme="d5-paper"] .dsh-upd-batch-sum{color:var(--d5-ink)}',
  '.dsh-upd[data-theme="d5-paper"] .dsh-upd-brow-set{border-top-color:var(--d5-line)}',
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
function diagTextOf(row: BatchRowView): string {
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
        ? job.detail + '（来源：后台任务收尾记录）'
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
  let theme: UpdatePanelTheme = options.theme === undefined ? 'default' : options.theme
  if (theme !== 'default' && theme !== 'd5-paper') {
    throw new Error('[dsh-plugin-update] 主题非法：只收 default 或 d5-paper（收到 ' + JSON.stringify(options.theme) + '）')
  }
  const call = options.call
  const titles: Record<string, string> =
    options.titles && typeof options.titles === 'object' ? options.titles : {}
  const onRestartRequested = options.onRestartRequested
  const copyText = options.copyText ?? defaultCopyText
  // 跳过存储按插件标识各一份（浏览器 localStorage 优先，没有退内存；与单插件面板同一套语义）。
  const skipStores = new Map<string, PanelSkipStore>()
  // 详情行自动日志（#38）：默认开；按“行 key + 版本”记住结果（含取不到也记住），传输失败的不记。
  const autoChangelogEnabled = options.autoChangelog !== false
  const rowChangelog = new Map<string, { version: string; markdown: string | null }>()
  const rowInflight = new Set<string>()
  // 失败退避（#38 对抗补记）：同行同版本失败只记一次，轮询与反复展开不再重问；
  // 换版、批量查一次、重开面板即忘。
  const rowFailed = new Map<string, string>()
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
    if (rowFailed.get(key) === version) return
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
            rowFailed.set(key, version)
            return
          }
          const md = (reply as Record<string, unknown>)['markdown']
          rowChangelog.set(key, { version, markdown: typeof md === 'string' ? md : null })
          if (typeof md === 'string') render()
        },
        () => {
          rowInflight.delete(key)
          if (mounted && seq === rowAutoSeq) rowFailed.set(key, version)
        },
      )
  }

  function render(): void {
    if (!mounted) return
    container.innerHTML = renderBatchPanelHTML({
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
    })
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
      say('复制失败，请手动选中上面的信息。', key)
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
   */
  async function phone(name: string, args: Record<string, unknown>, busyRowKey: string | null = null): Promise<void> {
    if (!mounted || inFlight) return
    inFlight = true
    clearNotice()
    render()
    try {
      const reply = await call(name, args)
      if (!mounted) return
      if (busyRowKey !== null && isBusyReply(reply)) {
        // 老宿主还没接住这次入队：如实说「没排上，等它装完再点」，不画失败横幅、不把行记成失败。
        say('前面还在装：这一家还没排上，等那家装完再点一次。', busyRowKey)
        return
      }
      applyReply(reply)
      // 批量查/装一次是明确意图：清掉各行失败退避，下面的按行链路可再问一次。
      rowFailed.clear()
    } catch {
      if (!mounted) return
      lastError = 'check-failed'
    } finally {
      inFlight = false
      if (mounted) render()
    }
    maybeAutoRowChangelog(expandedKey)
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
        return phone(phones.check, {})
      case 'install':
        // 不点 keys 即「全部提交」：会话与推进由宿主驱动器保证。
        return phone(phones.install, {})
      case 'row-install': {
        if (typeof key !== 'string' || !key) return
        // 行内「安装这家」/「重试」/「加入队列」：只推这一家（同一会话同一幂等编号，重复提交不重复装）。
        return phone(phones.install, { keys: [key] }, key)
      }
      case 'resume': {
        await phone(phones.resume, {})
        if (!mounted) return
        say('已接着上次的会话推进一步。')
        render()
        return
      }
      // 程序调用（controller.act）即执行：调它就是明确意图，不上膛。
      // 鼠标误触的防护在 onClick 那一层（第一次点击只上膛）。
      case 'cancel': {
        confirmCancelArmed = false
        await phone(phones.cancel, {})
        if (!mounted) return
        say('已取消这一批：剩下的不再推进；要重来点「检查更新」。')
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
        say('已跳过 ' + version + '：这一版不再提醒；点「恢复」可撤销。', row.key)
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
        say(version ? '已恢复 ' + version + '：这一版会照常提醒。' : '已恢复跳过提醒。', row.key)
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
          say('这一行没带取消排队要用的电话名或编号，暂不能取消：等下一次刷新再看。', row.key)
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
          if (mounted) say('已取消排队：这一家不等了。', row.key)
        } catch {
          if (mounted) say('取消排队没成功（可能已经开始装了）：看下面最新状态。', row.key)
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
        await copyWith(manual, '手工命令已复制，粘到终端整行执行即可。', row.key)
        return
      }
      case 'row-copy-diag': {
        const row = typeof key === 'string' && key ? rowOfKey(key) : null
        if (!row) return
        await copyWith(diagTextOf(row), '诊断已复制，直接粘给插件作者即可（已脱敏）。', row.key)
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
            say('已按调用方的重启流程处理；重启后新版生效。')
          } else {
            say('本宿主未提供重启入口：请手动重启宿主，重启后新版生效。')
          }
        } catch {
          say('重启入口调用失败：请手动重启宿主，重启后新版生效。')
        }
        render()
        return
      }
      case 'close': {
        if (mode === 'dialog') unmount()
        return
      }
      default:
        return
    }
  }

  function onKeyDown(ev: unknown): void {
    // Esc 关弹窗：与「关闭」按钮同口径（只停轮询，不动宿主侧推进）。
    try {
      const e = ev as { key?: unknown } | null | undefined
      if (!mounted || mode !== 'dialog' || !e || e.key !== 'Escape') return
      unmount()
    } catch {
      // 按坏了也不挡更新。
    }
  }

  function setTheme(next: UpdatePanelTheme): void {
    if (next !== 'default' && next !== 'd5-paper') {
      throw new Error('[dsh-plugin-update] 主题非法：只收 default 或 d5-paper（收到 ' + JSON.stringify(next) + '）')
    }
    theme = next
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
        say('再点一次「确认取消这一批」才真的取消；点别的按钮可撤销这次确认。')
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

  function unmount(): void {
    if (!mounted) return
    mounted = false
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
    void refresh()
  }, pollMs)
  try {
    // 轮询不占进程退出：批量推进在宿主侧跑，面板计时器只是视图刷新。
    const h = handle as { unref?: () => void } | null
    if (h && typeof h.unref === 'function') h.unref()
  } catch {
    // 无 unref 的环境（浏览器）忽略。
  }
  void refresh()

  return { refresh, act, setTheme, setMode, unmount }
}
