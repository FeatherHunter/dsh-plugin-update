/**
 * src/panel/batch/render.ts —— 批量面板渲染层（#229 自旧 src/panel-batch.ts 渲染段拆出）。
 *
 * 纯函数：同一输入 → 同一份 HTML（总账 + 明细 + 动作；展开行复用单插件内核只读渲染）。
 * 向下依赖 helpers、ledger；不碰轮询与动作。
 */

import { copyText as bilingualText } from '../../core/i18n/text.js'
import { manualAbsentReasonOf, manualAbsentReasonTextOf, manualAbsentTextOf } from '../../shared/manual-absent.js'
import { UPDATE_PANEL_CSS, UPDATE_PANEL_ARCHIVE_CSS, failureCopy, isCheckSideFailureCode, normalizePanelTheme, renderUpdatePanelHTML, themeTokensStyleFor } from '../../panel.js'
import { formatUnlockAt } from '../../core/cause.js'
import { lastResortVerdictOf } from '../../shared/last-resort.js'
import type { ManualAbsentReason } from '../../shared/manual-absent.js'
import type { AppLang } from '../../shared/lang.js'
import type { BatchPhase } from '../../core/batch/model.js'
import type { UpdatePanelTheme, UpdateThemeTokens } from '../../panel.js'
import type { LastResortVerdict, ManualSource } from '../../shared/last-resort.js'
import { asBatchPhase, asQueueLike, asSnapshotLike, batchFailedRows, batchFallbackCauseOf, cancelQueuePhoneOf, compliantInstalledOf, escapeHtml, isObject, isQueuedRow, jobFailureOf, latestVersionOf, pluginIdOf, queuePositionOf, queuedRequestIdOf, singleCheckPhoneOf, singleFallbackPhoneOf, titleOf } from './helpers.js'
import { batchLedgerCounts, batchLedgerText, batchQueuedStatus, batchRowKnowledgeText, batchRowPendingStatus, batchRowStatus, batchRowVersionHTML, batchText, hasUnfinishedRows, isInUnfinishedRound, knowledgeEntryOf, langOf, restartUnregistered, sessionUpdatedAtOf, unfinishedCount, worldUpdateVersion } from './ledger.js'
import type { BatchKnowledgeEntry, BatchLedgerCounts } from './ledger.js'
import { UPDATE_BATCH_PANEL_ARCHIVE_CSS, UPDATE_BATCH_PANEL_CSS } from './styles.js'
import type { BatchPanelMode, BatchRowView } from '../../panel-batch.js'

export interface BatchPanelRenderInput {
  rows?: readonly BatchRowView[]
  theme?: UpdatePanelTheme
  /** 主题变量覆盖：见 panel 的 UpdateThemeTokens；写到批量根上，详情行经继承生效。 */
  themeTokens?: UpdateThemeTokens
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
  /** 旧批次结果可能过期（首帧/自动检查在途）：行状态先按「检查中」渲染，别把旧 done 当结论（#231）。 */
  staleResults?: boolean
  titles?: Record<string, string>
  /** 键 -> 该家被跳过的版本（挂载侧从跳过存储读出；纯渲染函数不读存储）。 */
  skippedVersions?: Record<string, string | null>
  /** notice 归哪一家：等于某行键时那条回执画在该家详情里（否则画在面板底部）。 */
  noticeKey?: string | null
  /** 键 -> 该行已取到的日志全文（只传有文本的；取不到与没展开即中性提示，不挡安装）。 */
  changelogs?: Record<string, string | null>
  /** 轮次会话（有未终态行才画控制区，并决定在轮的行与总账吃不吃知识；不传按行相位回退旧口径，兼容旧快照）。 */
  session?: unknown
  /** 知识账本（无轮次时行按知识展示；只做展示，不参与安装决策）。 */
  inventory?: unknown
  /** 偏好（底部勾选的受控状态；不传不画勾选）。 */
  prefs?: unknown
  /** 语言（单语渲染新文案用；不传跟随全局信号）。 */
  lang?: unknown
  /** 键 -> 该行已决议出的候选（#156；目标对不上当前远端版即视为旧决议，渲染时忽略）。 */
  fallbackOffers?: Record<string, { candidate: string; targetVersion: string } | null>
  /** 正在决议中的那一行（键；在途短暂置灰，防连点）。 */
  fallbackBusyKey?: string | null
  /** 批量级合规版入口（#156）：被年龄门挡住的行数、决议出的点名清单与在途态，外加"等解封"与解封时刻记忆。 */
  compliant?: {
    gated: number
    confirmList: string | null
    confirmCount: number
    busy: boolean
    wait?: { keys: readonly string[]; unlockAtMs: number | null } | null
    unlocks?: Record<string, number | null> | null
  } | null
}

interface RowRenderContext {
  expanded: boolean
  /** 有人正在装（别家）：本行按钮文案换「加入队列」，但不置灰。 */
  busy: boolean
  /** 本面板正有一次电话在飞：行内动作短暂置灰，防连点。 */
  inFlight: boolean
  theme: UpdatePanelTheme
  themeTokens: UpdateThemeTokens | undefined
  titles: Record<string, string>
  /** 这一家被跳过的版本（null = 没跳过）。 */
  skipped: string | null
  /** 展开时挂在详情里的那条回执（复制/跳过之类）；不展开不画。 */
  notice: string | null
  /** 该行已取到的日志全文（null 即中性提示）。 */
  changelogMarkdown: string | null
  /** 单语（新文案渲染用）。 */
  lang: AppLang
  /** 该行的知识条目（在轮行恒为 null，不吃知识；其余行按知识展示/推翻）。 */
  knowledge: BatchKnowledgeEntry | null
  /** 该行是否在没做完的一轮里（轮次事实小标记用，不改写下一步）。 */
  inRound: boolean
  /** 首帧/自动检查在途：旧账本结果可能过期，行状态先按「检查中」渲染（#231）。 */
  staleResults: boolean
  /** 世界账推翻出的新版本号（#90：终态行被更新鲜的知识推翻时非 null，状态词与圆点同它走）。 */
  worldLatest: string | null
  /** 该行已决议出的候选（#156；有即二次确认态，无即首问态；旧决议由调用方过滤）。 */
  fallbackCandidate: string | null
  /** 该行是否正在决议在途（短暂置灰，防连点）。 */
  fallbackBusy: boolean
  /** 该行已决议、此刻确实没有可装版（等解封）：不画按钮，免得点了也没用（#156 诚实性）。 */
  fallbackWaiting: boolean
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
  // 每行自算一次「收尾事实」（纯函数），同一份喂给总账、hint、印章与横幅：一处算两处用，免得说法打架。
  const compliantFacts = new Map<string, { version: string; target: string; needsRestart: boolean }>()
  for (const row of rows) {
    const fact = compliantInstalledOf(row)
    if (fact) compliantFacts.set(row.key, fact)
  }
  const compliantDone = new Map<string, boolean>()
  for (const [key, fact] of compliantFacts) compliantDone.set(key, fact.needsRestart)
  const counts = batchLedgerCounts(rows, input.inventory, input.session, compliantDone)
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
    themeTokens: (input as { themeTokens?: UpdateThemeTokens }).themeTokens ?? undefined,
    titles,
    skipped: null,
    notice: null,
    changelogMarkdown: null,
    lang,
    knowledge: null,
    inRound: false,
    staleResults: input.staleResults === true,
    worldLatest: null,
    fallbackCandidate: null,
    fallbackBusy: false,
    fallbackWaiting: false,
  }
  const fallbackOffers =
    input.fallbackOffers && typeof input.fallbackOffers === 'object' ? input.fallbackOffers : {}
  const fallbackBusyKey = typeof input.fallbackBusyKey === 'string' && input.fallbackBusyKey ? input.fallbackBusyKey : null
  const compliantInput = isObject(input.compliant) ? (input.compliant as Record<string, unknown>) : null
  const compliantWaitInput =
    compliantInput && isObject(compliantInput['wait']) ? (compliantInput['wait'] as Record<string, unknown>) : null
  const waitKeys: string[] = []
  if (compliantWaitInput && Array.isArray(compliantWaitInput['keys'])) {
    for (const key of compliantWaitInput['keys'] as unknown[]) if (typeof key === 'string' && key) waitKeys.push(key)
  }
  const waitUnlockAtMs =
    compliantWaitInput && typeof compliantWaitInput['unlockAtMs'] === 'number'
      ? (compliantWaitInput['unlockAtMs'] as number)
      : null
  const compliantUnlocksInput =
    compliantInput && isObject(compliantInput['unlocks']) ? (compliantInput['unlocks'] as Record<string, unknown>) : null
  const compliant =
    compliantInput && typeof compliantInput['gated'] === 'number'
      ? {
          gated: compliantInput['gated'] as number,
          confirmList: typeof compliantInput['confirmList'] === 'string' && compliantInput['confirmList'] ? (compliantInput['confirmList'] as string) : null,
          confirmCount: typeof compliantInput['confirmCount'] === 'number' ? (compliantInput['confirmCount'] as number) : 0,
          busy: compliantInput['busy'] === true,
          wait: waitKeys.length > 0 ? { keys: waitKeys, unlockAtMs: waitUnlockAtMs } : null,
          unlocks: compliantUnlocksInput ? (compliantUnlocksInput as Record<string, number | null>) : null,
        }
      : null
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
  parts.push(bannersHTML(rows, titles, lastError, lang, compliant, compliantFacts))
  const session = isObject(input.session) ? (input.session as Record<string, unknown>) : null
  const unfinished = unfinishedCount(rows, session ?? undefined)
  const showControls = total > 0 && hasUnfinishedRows(rows, session ?? undefined)
  const prefs = isObject(input.prefs) ? (input.prefs as Record<string, unknown>) : null
  const checkOnOpen = prefs === null ? null : (prefs['checkOnOpen'] === false ? false : true)

  // 明细：一行一家。
  parts.push('<div class="dsh-upd-btable">')
  for (const row of rows) {
    const raw = skippedVersions[row.key]
    const skipped = typeof raw === 'string' && raw ? raw : null
    const expanded = row.key === expandedKey
    const inRound = isInUnfinishedRound(input.session, row.key)
    const knowledge = !inRound ? knowledgeEntryOf(input.inventory, row.key) : null
    // 旧决议不指新失败：候选对不上该行当前远端版即视为无候选（挂载侧随后清掉，这里先不画错）。
    const offerRaw = (fallbackOffers as Record<string, unknown>)[row.key]
    const offerCand =
      isObject(offerRaw) && typeof offerRaw['candidate'] === 'string' && (offerRaw['candidate'] as string).trim()
        ? ((offerRaw['candidate'] as string).trim() as string)
        : null
    const offerTarget = isObject(offerRaw) && typeof offerRaw['targetVersion'] === 'string' ? (offerRaw['targetVersion'] as string) : null
    const latest = latestVersionOf(row)
    parts.push(
      rowSetHTML(row, {
        ...ctx,
        expanded,
        skipped,
        notice: expanded && row.key === detailNoticeKey ? notice : null,
        changelogMarkdown:
          expanded && typeof changelogs[row.key] === 'string' ? (changelogs[row.key] as string) : null,
        lang,
        knowledge,
        inRound,
        staleResults: input.staleResults === true,
        worldLatest: worldUpdateVersion(row, knowledge, sessionUpdatedAtOf(input.session, row.key)),
        fallbackCandidate: offerCand && offerTarget === latest ? offerCand : null,
        fallbackBusy: fallbackBusyKey === row.key,
        fallbackWaiting: waitKeys.includes(row.key),
      }),
    )
  }
  parts.push('</div>')

  // 表下一行分类总账。
  if (total > 0) {
    // #231：自动检查还没结论时，别把旧账本的总账当结论（尤其「N 个已是最新」）。
    const ledgerText = input.staleResults === true ? batchText('batch.ledger.checking', lang) : batchLedgerText(counts, lang)
    parts.push('<div class="dsh-upd-batch-ledger">' + escapeHtml(ledgerText) + '</div>')
  }

  // 断点续跑与取消（有没做完的一轮才有意义；不与顶部两件宏抢位）。
  if (showControls) {
    const more: string[] = []
    more.push(
      '<button type="button" data-act="resume" title="' + escapeHtml(batchText('batch.action.resume-title', lang)) + '">' +
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
  const tokensStyle = themeTokensStyleFor((input as { themeTokens?: UpdateThemeTokens }).themeTokens ?? undefined)
  const tokensAttr = tokensStyle ? ' style="' + tokensStyle + '"' : ''
  const seal = batchSealOf(counts, lang)
  const root =
    '<div class="dsh-upd dsh-upd-batch" data-mode="' + mode + '" data-seal="' + escapeHtml(seal.text) +
    '" data-seal-tone="' + seal.tone + '"' + attr + tokensAttr + '>\n' + kernel + '\n</div>'
  const body = mode === 'dialog' ? '<div class="dsh-upd-overlay" data-mode="dialog">' + root + '</div>' : root
  // 详情默认弹窗（#108）：展开行以 sibling dialog 呈现（与批量底叠放，内层 z-index+1）；行内不再内嵌，默认即弹窗。
  let detailDialog = ''
  if (expandedKey !== null) {
    const target = rows.find((row) => row.key === expandedKey) ?? null
    if (target !== null) {
      const rawSkipped = skippedVersions[target.key]
      const skippedForDialog = typeof rawSkipped === 'string' && rawSkipped ? rawSkipped : null
      const offerRaw = (fallbackOffers as Record<string, unknown>)[target.key]
      const offerCand =
        isObject(offerRaw) && typeof offerRaw['candidate'] === 'string' && (offerRaw['candidate'] as string).trim()
          ? ((offerRaw['candidate'] as string).trim() as string)
          : null
      const offerTarget = isObject(offerRaw) && typeof offerRaw['targetVersion'] === 'string' ? (offerRaw['targetVersion'] as string) : null
      detailDialog = detailDialogHTML(target, {
        ...ctx,
        expanded: true,
        skipped: skippedForDialog,
        notice: target.key === detailNoticeKey ? notice : null,
        changelogMarkdown:
          typeof changelogs[target.key] === 'string' ? (changelogs[target.key] as string) : null,
        fallbackCandidate: offerCand && offerTarget === latestVersionOf(target) ? offerCand : null,
        fallbackBusy: fallbackBusyKey === target.key,
        fallbackWaiting: waitKeys.includes(target.key),
      })
    }
  }
  const css = archive
    ? [UPDATE_PANEL_CSS, UPDATE_BATCH_PANEL_CSS, UPDATE_PANEL_ARCHIVE_CSS, UPDATE_BATCH_PANEL_ARCHIVE_CSS].join(String.fromCharCode(10))
    : [UPDATE_PANEL_CSS, UPDATE_BATCH_PANEL_CSS].join(String.fromCharCode(10))
  return '<style>' + css + '</style>\n' + body + (detailDialog ? '\n' + detailDialog : '')
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
  // #190：全部未登记时重启不会加载——一句话总账不许落到「已全部为最新」。
  if (counts.restartUnregistered > 0) return batchText('batch.hint.restart-unregistered', l, { n: String(counts.restartUnregistered) })
  if (counts.pending > 0) return batchText('batch.hint.pending', l, { n: String(counts.pending) })
  return batchText('batch.hint.done', l)
}

/** 印章（Archive 才画）：色调按总账里最重的一档走；文字跟随语言（#64 单语，tone 不入 key）。 */
function batchSealOf(counts: BatchLedgerCounts, lang?: unknown): { text: string; tone: 'ink' | 'green' | 'yellow' | 'red' } {
  const text = batchText('batch.seal.ledger', langOf(lang))
  if (counts.failed > 0) return { text, tone: 'red' }
  // #190：未登记的行也算「有一件事要处理」（去选中），印章不许落成灰的「没事」。
  if (counts.installing > 0 || counts.restart > 0 || counts.restartUnregistered > 0) return { text, tone: 'yellow' }
  if (counts.updatable > 0) return { text, tone: 'green' }
  return { text, tone: 'ink' }
}

/** 常驻横幅：批量电话失败 / 有失败行 / 合规版兜底与收尾事实 / 有待重启行（都不许藏进抽屉；#64 单语：缺省 zh；data-mini 冻结待 #67 仲裁）。 */
function bannersHTML(
  rows: readonly BatchRowView[],
  titles: Record<string, string>,
  lastError: string | null,
  lang?: unknown,
  compliant: {
    gated?: number
    confirmList?: string | null
    confirmCount?: number
    busy?: boolean
    /** 已决议、此刻确实没有可装版的行（#156：如实说等多久，不画假按钮）。 */
    wait?: { keys: readonly string[]; unlockAtMs: number | null } | null
    /** 决议记忆里的解封时刻（按行 key）：只用来把「最新版还挡多久」说清。 */
    unlocks?: Record<string, number | null> | null
  } | null = null,
  facts?: ReadonlyMap<string, { version: string; target: string; needsRestart: boolean }> | null,
): string {
  const l = langOf(lang)
  const unlocks = compliant?.unlocks ?? null
  // 收尾事实（#156 第一性原理）：账本目标没装成、但这家已经装上「能装的最新」——逐行自算（纯函数自足），
  // 记忆只补一句「最新版还挡多久」。这是「全部更新到能更新的最新」的交付凭证，不许再算成安装失败。
  // 渲染侧已经把这份账算过一遍（总账要用同一份），传进来就直接用；单独调用（测试）时自算，纯函数照样自足。
  const done = new Map<string, { version: string; target: string; needsRestart: boolean }>(facts ?? [])
  if (!facts) {
    for (const row of rows) {
      const fact = compliantInstalledOf(row)
      if (fact) done.set(row.key, fact)
    }
  }
  const doneLineOf = (row: BatchRowView, fact: { version: string; target: string }): string => {
    const raw = unlocks && typeof unlocks[row.key] === 'number' ? (unlocks[row.key] as number) : null
    const time = raw !== null ? formatUnlockAt(raw, l) : null
    const vars = { title: titleOf(row, titles), version: fact.version, target: fact.target }
    return time
      ? escapeHtml(batchText('batch.banner.compliant-done-gated', l, { ...vars, time }))
      : escapeHtml(batchText('batch.banner.compliant-done', l, vars))
  }
  // 名单自己算（纯函数自足）：有年龄门结论且有该家决议电话、且还没装上合规版的行才算数；调用方只需补决议态。
  const gatedCandidates = rows.filter(
    (row) => batchFallbackCauseOf(row) !== null && singleFallbackPhoneOf(row) !== null && !done.has(row.key),
  )
  const gated = typeof compliant?.gated === 'number' ? compliant.gated : gatedCandidates.length
  const confirmList = typeof compliant?.confirmList === 'string' && compliant.confirmList ? compliant.confirmList : null
  const confirmCount = typeof compliant?.confirmCount === 'number' ? compliant.confirmCount : 0
  const compliantBusy = compliant?.busy === true
  const waitKeys = compliant?.wait && Array.isArray(compliant.wait.keys) ? compliant.wait.keys : []
  const parts: string[] = []
  if (lastError) {
    const copy = failureCopy(lastError, l)
    const detail = copy?.zh ?? failureCopy('unknown', l)?.zh ?? ''
    const act = copy?.act ?? batchText('batch.banner.error-action-fallback', l)
    // 副行出框（与单面板同口径）：色框只装标题，行动句住框外第二行居左。
    parts.push(
      '<div class="dsh-upd-banner" data-kind="failed" data-mini="阻" role="status">' +
        '<div><span class="dsh-upd-sealmini" aria-hidden="true">阻</span><strong>' + escapeHtml(batchText('batch.banner.error-title', l, { code: lastError, detail })) + '</strong></div>' +
        '</div>',
    )
    if (act) parts.push('<div class="dsh-upd-banner-sub">' + escapeHtml(act) + '</div>')
  }
  // 排队占位不算失败：忙时宿主会把它记成 failed+update-busy，这里翻回来。
  // 等重启也不算失败（#156 M1 诚实性）：这类行账本相位是 failed、error 是 pending-restart——磁盘上
  // 已经有更新版、只差重启生效，丢进"安装失败"是冤枉（目标版确实没装上，所以相位一个字不改）。
  // 它该待的位置是"等重启"那一栏：那一栏的行动就是重启，正是这一行需要的那一下。
  // 已装上合规版的行同样不算失败（#156 收尾事实）：最新版没装成、但这家确实装到了能装的最新，
  // 继续把它算成"安装失败"才是撒谎；它的结果由下面那条"实际安装结果"横幅如实说出。
  const pendingRestartRow = (row: BatchRowView): boolean =>
    asBatchPhase(row.phase) === 'failed' && row.error === 'pending-restart'
  // 失败行集合只认 batchFailedRows（#176 单一真源）：横幅与两枚批量复制按钮永远同一份口径。
  const failed = batchFailedRows(rows)
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
    const failedAct = batchText('batch.banner.failed-action', l)
    // #176：名单下方给统一的复制出口——两枚批量按钮，别让用户为了复制证据一家家点开详情。
    // 一条手工命令都没有时按钮置灰并说明原因（复制一段只有 # 注释的文本没有意义）。
    const failedManual = batchFailedManualText(failed, l, titles)
    const manualAbsent = failedManual.commands === 0
    // #92：置灰说明只在整批原因一致时点名原因；混着不同原因（或判不出）时给中性一句话，
    // 不把第一行的原因扣给整批（逐行原因仍写在「复制手工命令」的注释行里）。
    const absentReasons = failed.map((row) => manualAbsentReasonOf(asSnapshotLike(row.snapshot)))
    const absentReasonSet = new Set<ManualAbsentReason>(
      absentReasons.filter((reason): reason is ManualAbsentReason => reason !== null),
    )
    const absentTitle =
      absentReasonSet.size === 1 && absentReasons.every((reason) => reason !== null)
        ? manualAbsentTextOf([...absentReasonSet][0], l)
        : manualAbsentTextOf(null, l)
    parts.push(
      '<div class="dsh-upd-banner" data-kind="failed" data-mini="阻" role="status">' +
        '<div><span class="dsh-upd-sealmini" aria-hidden="true">阻</span><strong>' + escapeHtml(batchText('batch.banner.failed-title', l, { n: String(failed.length) })) + '</strong></div>' +
        '<div class="dsh-upd-blist">' + lines + '</div>' +
        '<div class="dsh-upd-browline"><span class="dsh-upd-bcopy">' +
        '<button type="button" data-act="copy-all-diag">' + escapeHtml(batchText('batch.row-action.copy-diag', l)) + '</button>' +
        '<button type="button" data-act="copy-all-manual"' + (manualAbsent ? ' disabled title="' + escapeHtml(absentTitle) + '"' : '') + '>' +
        escapeHtml(batchText('batch.row-action.copy-manual', l)) + '</button>' +
        '</span></div>' +
        '</div>',
    )
    if (failedAct) parts.push('<div class="dsh-upd-banner-sub">' + escapeHtml(failedAct) + '</div>')
  }
  // 合规版（#156 第一性原理）：最新版被 24 小时年龄门挡住时，「全部更新」这一步不能只剩一句失败——
  // 有决议电话的行当场给一条批量入口：先逐家决议，再点名精确版本请用户确认（永不静默装旧版）。
  // 只加一条横幅，不碰账本相位（#152）：合规版安装是用户显式确认后的独立动作，不是本轮的"已更新"。
  if (confirmList) {
    parts.push(
      '<div class="dsh-upd-banner" data-kind="update" role="status">' +
        '<div><strong>' + escapeHtml(batchText('batch.banner.compliant-confirm', l, { list: confirmList })) + '</strong></div>' +
        '<div class="dsh-upd-browline"><span class="dsh-upd-blist">' + escapeHtml(confirmList) + '</span>' +
        '<button type="button" data-act="batch-fallback-confirm" data-primary="1"' + (compliantBusy ? ' disabled' : '') + '>' +
        escapeHtml(batchText('batch.action.install-compliant-confirm', l, { n: String(confirmCount) })) + '</button></div>' +
        '</div>',
    )
  }
  // 两条路各自成立、可以同时存在：有候选的端确认条，没有候选的把"等多久"如实说清。
  if (waitKeys.length > 0) {
    // 此刻确实没有可装版（#156 诚实性）：说清是谁、等多久，不画一个点了也没用的按钮。
    // 解封时刻一到，挂载侧的自动决议会重新跑（它的签名会变），所以这里不需要手动入口。
    const rawUnlock = compliant?.wait ? compliant.wait.unlockAtMs : null
    const unlockAtMs = typeof rawUnlock === 'number' ? rawUnlock : null
    const time = unlockAtMs !== null ? formatUnlockAt(unlockAtMs, l) : null
    const waitTitles = rows
      .filter((row) => waitKeys.includes(row.key))
      .map((row) => titleOf(row, titles))
      .join('、')
    parts.push(
      '<div class="dsh-upd-banner" data-kind="update" role="status">' +
        '<div><strong>' +
        escapeHtml(
          time
            ? batchText('batch.banner.gated-wait', l, { n: String(waitKeys.length), time })
            : batchText('batch.banner.age-gated', l, { n: String(waitKeys.length) }),
        ) +
        '</strong></div>' +
        '<div class="dsh-upd-browline"><span class="dsh-upd-blist">' + escapeHtml(waitTitles) + '</span></div>' +
        '</div>',
    )
  } else if (gated > 0 && confirmList === null) {
    parts.push(
      '<div class="dsh-upd-banner" data-kind="update" role="status">' +
        '<div><strong>' + escapeHtml(batchText('batch.banner.age-gated', l, { n: String(gated) })) + '</strong></div>' +
        '<div class="dsh-upd-browline"><span class="dsh-upd-blist">' +
        escapeHtml(gatedCandidates.map((row) => titleOf(row, titles)).join('、')) +
        '</span>' +
        '<button type="button" data-act="batch-fallback-scan"' + (compliantBusy ? ' disabled' : '') + ' title="' +
        escapeHtml(bilingualText('panel.action.install-fallback-title', l)) + '">' +
        escapeHtml(bilingualText('panel.action.install-fallback', l)) + '</button></div>' +
        '</div>',
    )
  }
  // 收尾事实（#156）：账本目标没装成、但这家已经装上「能装的最新」——如实说清装了哪一版、最新那版还差什么。
  // 不比失败条纹更"安慰"：这是事实陈述，也是「全部更新到能更新的最新」这一步的交付凭证。
  if (done.size > 0) {
    const lines = rows
      .filter((row) => done.has(row.key))
      .map((row) => '<div>' + doneLineOf(row, done.get(row.key) as { version: string; target: string }) + '</div>')
      .join('')
    parts.push(
      '<div class="dsh-upd-banner" data-kind="update" role="status">' +
        '<div><strong>' + escapeHtml(batchText('batch.banner.compliant-done-title', l, { n: String(done.size) })) + '</strong></div>' +
        '<div class="dsh-upd-blist">' + lines + '</div>' +
        '</div>',
    )
  }
  const restart = rows.filter(
    (row) => row.restartRequired === true || pendingRestartRow(row) || done.get(row.key)?.needsRestart === true,
  )
  if (restart.length > 0) {
    const restartAct = batchText('batch.banner.restart-action', l)
    // #190：在册事实为 false 的行重启也不会加载——横幅分别计数，不再把「重启后生效」说满。
    const unregistered = restart.filter(restartUnregistered)
    const registered = restart.filter((row) => !restartUnregistered(row))
    const title =
      unregistered.length === 0
        ? batchText('batch.banner.restart-title', l, { n: String(restart.length) })
        : registered.length === 0
          ? batchText('batch.banner.restart-unregistered-title', l)
          : batchText('batch.banner.restart-partial-title', l, { n: String(registered.length), m: String(unregistered.length) })
    const names = restart
      .map((row) => escapeHtml(titleOf(row, titles)) + (restartUnregistered(row) ? escapeHtml(batchText('batch.row.unregistered-suffix', l)) : ''))
      .join('、')
    // 措辞与单插件面板 panel.blocked.pending-restart.action 同一句（#64 按清单独立成键，英文可独立调优）；位置与单面板同口径：住框外。
    parts.push(
      '<div class="dsh-upd-banner" data-kind="restart" role="status">' +
        '<div><strong>' + escapeHtml(title) + '</strong></div>' +
        // 名单居左、按钮同行居右：名单与按钮同处一行内 flex 行，窄屏换行时按钮仍靠右。
        // #190：只有「已登记」的行重启才会加载；全部未登记时不画重启按钮，免得点了也白点。
        '<div class="dsh-upd-browline"><span class="dsh-upd-blist">' + names + '</span>' +
        (registered.length > 0
          ? '<button type="button" data-act="restart">' + escapeHtml(batchText('batch.banner.restart-button', l)) + '</button>'
          : '') +
        '</div>' +
        '</div>',
    )
    // #190：「重启宿主以加载新版本」只对已登记的行成立；全部未登记时这句是假指令，不出现。
    if (registered.length > 0 && restartAct) parts.push('<div class="dsh-upd-banner-sub">' + escapeHtml(restartAct) + '</div>')
    if (unregistered.length > 0) {
      parts.push('<div class="dsh-upd-banner-sub">' + escapeHtml(batchText('batch.banner.restart-unregistered-hint', l)) + '</div>')
    }
  }
  return parts.join('')
}

/**
 * 该行合规版按钮（#156，纯函数）：有候选即[确认装X]，有资格无候选即[装合规版]，
 * 其余（B 类/认不出/老宿主无电话/在途置灰由调用方处理）回 ''——调用方原样拼接，不画错按钮。
 * 文案复用 panel.action.* 既有键（经 bilingualText），零新增键。
 */
function rowFallbackButtonHTML(row: BatchRowView, ctx: RowRenderContext): string {
  try {
    // 已决议过、此刻确实没有可装版（等解封）：不画按钮——点了也只会得到同一句话（#156 诚实性），
    // 横幅已经说清等多久，解封后自动决议会重新给入口。
    if (ctx.fallbackWaiting) return ''
    const keyAttr = escapeHtml(row.key)
    const busy = ctx.fallbackBusy || ctx.inFlight ? ' disabled aria-busy="true"' : ''
    const off = ctx.inFlight && !ctx.fallbackBusy ? ' disabled' : ''
    if (typeof ctx.fallbackCandidate === 'string' && ctx.fallbackCandidate) {
      return (
        '<button type="button" data-act="row-fallback-confirm" data-key="' + keyAttr + '" data-primary="1" title="' +
        escapeHtml(bilingualText('panel.action.install-fallback-confirm-title', ctx.lang)) +
        '"' + busy + '>' +
        escapeHtml(bilingualText('panel.action.install-fallback-confirm', ctx.lang, { version: ctx.fallbackCandidate })) + '</button>'
      )
    }
    if (singleFallbackPhoneOf(row) === null) return ''
    if (!batchFallbackCauseOf(row)) return ''
    return (
      '<button type="button" data-act="row-fallback" data-key="' + keyAttr + '" data-primary="1" title="' +
      escapeHtml(bilingualText('panel.action.install-fallback-title', ctx.lang)) +
      '"' + (ctx.fallbackBusy ? busy : off) + '>' +
      escapeHtml(bilingualText('panel.action.install-fallback', ctx.lang)) + '</button>'
    )
  } catch {
    return ''
  }
}

/** #177：行命令来源归一。`undefined` 是旧调用方/旧行视图的缺省格，按「未标遗留」信任（只增不改）；显式 null 才是「当帧确认没有」。 */
function batchManualSourceOf(row: BatchRowView): ManualSource | null {
  return row.manualSource === 'carried-over' ? 'carried-over' : row.manualSource === null ? null : 'frame'
}

/**
 * #174：一行自己的最后手段判定（与单面板共用同一个纯函数，批量不共享结论）。
 * 行上只有 `error`（码）与快照，没有合规版决议证据，故不臆造 fallbackAvailable；
 * 命令的可信来源随宿主回包带下来（#177）。
 */
function batchRowLastResortOf(row: BatchRowView): LastResortVerdict {
  const snap = asSnapshotLike(row.snapshot) as
    | { blockedReason?: unknown; runningVersion?: unknown; registered?: unknown }
    | null
  const manualSource = batchManualSourceOf(row)
  // 只有失败行才谈「最后手段」：没失败的行走同一判定会因「命令可信 + 无救援」被误判高亮。
  const failed = asBatchPhase(row.phase) === 'failed'
  return lastResortVerdictOf({
    code: failed && typeof row.error === 'string' && row.error ? row.error : null,
    blockedReason: snap && typeof snap.blockedReason === 'string' ? snap.blockedReason : null,
    manual: typeof row.manual === 'string' ? row.manual : null,
    manualSource,
    runningVersionKnown: snap ? snap.runningVersion !== null : null,
    // #174：合规版救援证据只认批量自己的同一个判据（详情 01 章双按钮也用它），不臆造。
    fallbackAvailable: batchFallbackCauseOf(row) !== null,
    registered: snap && typeof snap.registered === 'boolean' ? snap.registered : null,
  })
}

/** 一行的手工命令是否可信（展示 / 复制 / 高亮三处共用这一个判据，#177）。 */
function batchRowManualTrusted(row: BatchRowView): boolean {
  return typeof row.manual === 'string' && row.manual.trim() !== '' && batchManualSourceOf(row) === 'frame'
}

/** 一行一家（含点开时的详情：详情就是单插件内核本身）。 */
function rowSetHTML(row: BatchRowView, ctx: RowRenderContext): string {
  const phase = asBatchPhase(row.phase)
  const keyAttr = escapeHtml(row.key)
  const skipped = ctx.skipped
  const queued = isQueuedRow(row)
  const position = queued ? queuePositionOf(row) : null
  // 收尾事实（#156）：这一行账本相位是 failed、可它已经装上「能装的最新」——状态字、红字、圆点与
  // 兜底按钮都得跟着说实话：说"安装失败"是撒谎，再劝它装合规版是白劝（已经装上了）。
  const rowDone = phase === 'failed' && !queued ? compliantInstalledOf(row) : null
  const versionHTML = batchRowVersionHTML(row, ctx.knowledge, ctx.lang)
  const staleRow = ctx.staleResults && (phase === 'done' || phase === 'current')
  const rowStatusText = staleRow
    ? batchText('batch.row.checking', ctx.lang)
    : rowDone !== null
      ? rowDone.needsRestart
        ? batchText('batch.row.done-restart', ctx.lang)
        : batchText('batch.row.done', ctx.lang)
      : queued
        ? batchQueuedStatus(position, ctx.lang)
        : phase === 'ready' && ctx.inRound && ctx.busy
          ? batchText('batch.row.batch-queued', ctx.lang)
          : ctx.worldLatest !== null
            ? batchText('batch.row.update', ctx.lang, { version: ctx.worldLatest })
            : ctx.inRound
              ? (batchRowKnowledgeText(row, ctx.knowledge, ctx.lang) ?? batchRowStatus(row, skipped, ctx.lang))
              : (batchRowPendingStatus(row, ctx.knowledge, ctx.lang) ?? batchRowStatus(row, skipped, ctx.lang))
  // #174：只有判定为 last-resort 的行才在状态区落轻量标记（badge；不画空红轨，不动行内按钮）。
  const lastResort = batchRowLastResortOf(row)
  const lastResortBadge =
    lastResort.kind === 'last-resort'
      ? '<span class="dsh-upd-lr-rowbadge" data-last-resort="last-resort">' +
        escapeHtml(batchText('batch.lastresort.row-badge', ctx.lang)) + '</span>'
      : ''
  const actions: string[] = []
  // 忙守卫按行：正在装的那一行禁自己（不许重复提交）；**别的行不灰**——点下去是「加入队列」。
  const off = ctx.inFlight ? ' disabled' : ''
  if (phase === 'installing') {
    actions.push(
      '<button type="button" class="dsh-upd-busy-btn" data-act="row-install" data-key="' + keyAttr + '" data-busy="1" aria-busy="true" disabled>' + escapeHtml(batchText('batch.row-action.installing', ctx.lang)) + '</button>',
    )
  } else if (queued) {
    // 排队那行的下一步是「取消排队」：撤掉自己的占位（别家与正在装的拥有者都不碰）。
    if (cancelQueuePhoneOf(row) !== null && queuedRequestIdOf(row) !== null) {
      actions.push(
        '<button type="button" data-act="row-cancel-queue" data-key="' + keyAttr + '"' + off + '>' + escapeHtml(batchText('batch.row-action.cancel-queue', ctx.lang)) + '</button>',
      )
    }
  } else if (phase === 'ready' && skipped === null) {
    // #232：批次正在跑时这一家已在批次队列里，消费完上一家会自动装——不画「加入队列」按钮，
    // 免得读成「还得手动入队」。停下/空闲时才给手动的「安装此插件」。
    if (!(ctx.inRound && ctx.busy)) {
      actions.push(
        '<button type="button" data-act="row-install" data-key="' + keyAttr + '" data-primary="1"' + off + '>' +
          escapeHtml(ctx.busy ? batchText('batch.row-action.queue', ctx.lang) : batchText('batch.row-action.install-row', ctx.lang)) + '</button>',
      )
    }
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
    // 合规版兜底（#156）：拦的正是该行更新目标时再给一个选择——[重试]不动（仍是最新），
    // [装合规版]走该家自己的决议电话，有候选即换[确认装X]；B 类与认不出的失败不画，不硬上。
    // 文案复用 panel.action.* 既有键（经 bilingualText），零新增键。
    if (!queued && rowDone === null) actions.push(rowFallbackButtonHTML(row, ctx))
  }
  // #190：未登记的行重启也不会加载——行级重启入口也不画，免得点了白点（状态词已给下一步）。
  if (row.restartRequired === true && !restartUnregistered(row)) {
    // 与单插件面板同一措辞：宿主没有重启自己的电话，这里只做入口。
    actions.push('<button type="button" data-act="restart" data-key="' + keyAttr + '">' + escapeHtml(batchText('batch.row-action.restart', ctx.lang)) + '</button>')
  }
  actions.push(
    '<button type="button" data-act="toggle-details" data-key="' + keyAttr + '">' +
      escapeHtml(ctx.expanded ? batchText('batch.row-action.hide-detail', ctx.lang) : batchText('batch.row-action.show-detail', ctx.lang)) + '</button>',
  )
  const failLine =
    phase === 'failed' && !queued
      ? rowDone !== null
        ? (() => {
          // 收尾事实（#156）：装到了能装的最新，只是不是账本目标那一版。行里那句话不许说"失败"，
          // 换成同一件事实（缘由不断言：快照里没有那次失败的原文，措辞只说发生了什么）。
          const vars = { version: rowDone.version, target: rowDone.target }
          return (
            '<span class="dsh-upd-bfail dsh-upd-bdone">' +
            escapeHtml(batchText('batch.row.compliant-done', ctx.lang, vars)) +
            '</span>'
          )
        })()
        : (() => {
          const failCode = row.error || 'install-failed'
          // 查/装分家（#134/US15）：查侧码的红字说「本次未能查询」，不说安装失败。
          const failJob = jobFailureOf(row)
          const failSide = failJob?.code ?? (typeof row.error === 'string' && row.error ? row.error : null)
          const failDetail = isCheckSideFailureCode(failSide)
            ? batchText('batch.row.failed', ctx.lang)
            : failureCopy(failCode, ctx.lang)?.zh ?? failureCopy('unknown', ctx.lang)?.zh ?? ''
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
    '<span class="dsh-upd-updot" data-tone="' + dotToneOf(row, phase, skipped, queued, ctx.worldLatest, rowDone === null ? null : rowDone.needsRestart) + '"></span>' +
    '<span class="dsh-upd-bname">' + escapeHtml(titleOf(row, ctx.titles)) + '</span>' +
    versionHTML +
    '<span class="dsh-upd-bstat">' + lastResortBadge + escapeHtml(rowStatusText) + (ctx.inRound && !queued && phase === 'failed' ? '（' + escapeHtml(batchText('batch.row.unfinished-tag', ctx.lang)) + '）' : '') + '</span>' +
    failLine +
    '</button>'
  // 详情默认弹窗（#108：删内嵌展开路径——行内不再叠 `.dsh-upd-bdetail`，展开走弹窗 sibling overlay，见 detailDialogHTML）。
  return (
    '<div class="dsh-upd-brow-set" data-key="' + keyAttr + '">' +
    '<div class="dsh-upd-brow" data-phase="' + escapeHtml(phase) + '" data-key="' + keyAttr + '"' +
    (queued ? ' data-queued="1"' : '') + '>' +
    main +
    '<span class="dsh-upd-brow-actions">' + actions.join('') + '</span>' +
    '</div>' +
    '</div>'
  )
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
    buttons.push('<button type="button" class="dsh-upd-busy-btn" data-act="row-install" data-key="' + keyAttr + '" data-busy="1" aria-busy="true" disabled>' + escapeHtml(batchText('batch.row-action.installing', ctx.lang)) + '</button>')
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
    // 合规版兜底（#156）：与行内同口径（行内已注释），详情里同样给选择。
    if (!queued) {
      const fallback = rowFallbackButtonHTML(row, ctx)
      if (fallback) buttons.push(fallback)
    }
  } else if (phase === 'ready' && ctx.skipped === null) {
    // #232：与行内同一口径——批次正在跑时这一家已在队列，不给「加入队列」误动作。
    if (!(ctx.inRound && ctx.busy)) {
      buttons.push(
        '<button type="button" data-act="row-install" data-key="' + keyAttr + '" data-primary="1"' + off +
          '>' + escapeHtml(ctx.busy ? batchText('batch.row-action.queue', ctx.lang) : version !== null ? batchText('batch.row-action.install-version', ctx.lang, { version }) : batchText('batch.row-action.install-generic', ctx.lang)) + '</button>',
      )
    }
  }
  // 单查（#84）：该行自己的查新版电话透过行 phoneNames 透传（老宿主没给即不画，诚实缺省）。
  // 文案沿用批量宏的已有键（不新增键）：在详情里它自然就是「查这一家」。
  if (phase !== 'installing' && singleCheckPhoneOf(row) !== null) {
    buttons.push(
      '<button type="button" data-act="row-check" data-key="' + keyAttr + '"' + off + '>' + escapeHtml(batchText('batch.action.check', ctx.lang)) + '</button>',
    );
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
  if (batchRowManualTrusted(row)) {
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

/**
 * 详情默认弹窗（#108，按 #107 决议 B 落地）。
 * 复用单插件内核 dialog 只读（85vh/遮罩/圆角不动）+ 批量自出动作行前置为固定栏 + 内核 footer 同位复刻（右下独立区）。
 * - 动作行置顶固定栏：利用已有 `:has(>.dsh-upd-body)>:not(.dsh-upd-body){flex:none}` 契约，不随 body 滚，零新 CSS 契约；
 * - 关闭=B：右下 footer（`panel.footer.note` + `panel.footer.close`，bilingual 零新增键），通道走批量 `data-act="detail-close"`（内核 `data-action` 在批量挂载无接收端，沿用文案与位置、不新开发关闭件）；
 * - 滚动：弹窗内 body 走内核 `overflow-y:auto` + 章节头 sticky（推翻旧 `overflow:visible` 中性化，仅弹窗内，批量底不动）；
 * - 嵌套：内层 overlay 高一层（CSS `z-index:10000`），Esc/关闭只清 `expandedKey`，不碰批量 dialog 的 `onCloseRequested`。
 */
function detailFooterHTML(row: BatchRowView, ctx: RowRenderContext): string {
  const keyAttr = escapeHtml(row.key)
  return (
    '<div class="dsh-upd-footer"><span class="dsh-upd-foot-note">' + escapeHtml(batchText('panel.footer.note', ctx.lang)) + '</span>' +
    '<button type="button" data-act="detail-close" data-key="' + keyAttr + '" title="' + escapeHtml(batchText('panel.footer.close-title', ctx.lang)) + '">' +
    escapeHtml(batchText('panel.footer.close', ctx.lang)) + '</button></div>'
  )
}

function detailDialogHTML(row: BatchRowView, ctx: RowRenderContext): string {
  const keyAttr = escapeHtml(row.key)
  const kernel = renderUpdatePanelHTML({
    snapshot: asSnapshotLike(row.snapshot),
    manual: typeof row.manual === 'string' ? row.manual : null,
    manualSource: batchManualSourceOf(row),
    changelogMarkdown: typeof ctx.changelogMarkdown === 'string' ? ctx.changelogMarkdown : null,
    queue: asQueueLike(row.queue),
    skippedLatest: ctx.skipped !== null,
    lastError: row.error,
    errorKind: row.error,
    mode: 'dialog',
    showOthers: false,
    pluginId: pluginIdOf(row),
    copyNotice: null,
    theme: ctx.theme,
    themeTokens: ctx.themeTokens,
    profileName: typeof row.profileName === 'string' && row.profileName ? row.profileName : null,
    hostKind: typeof row.hostKind === 'string' && row.hostKind ? row.hostKind : null,
    actions: 'none',
  }, ctx.lang)
  const stripped = stripActionButtons(kernel)
  // 外层 batch 已带一份 panel CSS：内核自带的 `<style>` 去掉，免得弹窗 sibling 里再挂一份（DOM 只留 overlay）。
  const withoutStyle = stripped.replace(/^<style>[\s\S]*?<\/style>\s*/, '')
  const bar =
    '<div class="dsh-upd-bdetail-dialog-bar" data-detail-bar="' + keyAttr + '">' +
    detailActionsHTML(row, ctx) +
    '</div>' +
    (ctx.notice !== null
      ? '<div class="dsh-upd-bdetail-notice" role="status">' + escapeHtml(ctx.notice) + '</div>'
      : '')
  const withBar = withoutStyle
    .replace(
      '<div class="dsh-upd-overlay"',
      '<div class="dsh-upd-overlay dsh-upd-bdetail-dialog" data-detail-key="' + keyAttr + '"',
    )
    .replace('<div class="dsh-upd-body">', bar + '<div class="dsh-upd-body">')
  const footer = detailFooterHTML(row, ctx)
  const at = withBar.lastIndexOf('</div></div>')
  if (at < 0) return withBar + footer
  return withBar.slice(0, at) + footer + withBar.slice(at)
}

function dotToneOf(
  row: BatchRowView,
  phase: BatchPhase,
  skipped: string | null,
  queued: boolean,
  worldLatest: string | null = null,
  compliantRestart: boolean | null = null,
): 'idle' | 'todo' | 'busy' | 'warn' | 'bad' | 'ok' {
  // 收尾事实（#156）：账本相位 failed、但确实装到了能装的最新——红灯换成实话（等重启=黄，已收尾=绿）。
  if (compliantRestart === true) return 'warn'
  if (compliantRestart === false) return 'ok'
  if (phase === 'failed' && !queued) return 'bad'
  if (phase === 'installing' || phase === 'checking') return 'busy'
  if (queued) return 'warn'
  if (row.restartRequired === true) return 'warn'
  if (worldLatest !== null) return 'todo'
  if (phase === 'ready') return skipped === null ? 'todo' : 'idle'
  if (phase === 'current' || phase === 'done') return 'ok'
  return 'idle'
}

/**
 * 全部失败行的手工命令文本（#176）：有命令的行原样一行，没命令的行用 # 注释行占位，
 * 整段仍可安全粘终端（注释不会被执行、也不会漏掉哪一家没给命令）。
 * commands 是有效命令行数——失败横幅据此决定「复制手工命令」按钮置不置灰。
 */
export function batchFailedManualText(
  rows: readonly BatchRowView[],
  lang?: string | null,
  titles: Record<string, string> = {},
): { text: string; commands: number } {
  const l = langOf(lang)
  const lines: string[] = []
  let commands = 0
  for (const row of batchFailedRows(rows)) {
    const manual = typeof row.manual === 'string' ? row.manual : ''
    if (manual) {
      // 原样一行：复制的是用户该粘进终端的命令，一个字都不改写。
      lines.push(manual)
      commands += 1
      continue
    }
    const reason = manualAbsentReasonOf(asSnapshotLike(row.snapshot))
    const comment = reason
      ? // 「# 包名：无手工命令（原因）」——原因句只拼一次，别再套「当前没有可用的手工命令」整句。
        batchText('panel.manual.absent-comment', l, { reason: manualAbsentReasonTextOf(reason, l) })
      : batchText('panel.manual.absent-comment-unknown', l)
    lines.push('# ' + titleOf(row, titles) + '：' + comment)
  }
  return { text: lines.join('\n'), commands }
}
