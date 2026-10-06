// src/entry-batch.ts —— 批量感知的更新入口件（一颗按钮看 N 家，点开即批量面板）。
//
// 归属：面板（浏览器）侧。纯加法：不改 src/entry.ts 的单插件入口语义，只新增一个批量入口。
//   单入口回答「我这一家有没有更新」；批量入口回答「这 N 家有没有事」——徽标/文案按七行聚合，
//   点开即批量面板（复用 src/panel-batch.ts 的整组件，不另写界面）。
//
// 第一性（为什么要它）：
//   一个总管插件替 N 家管更新时，用户在那颗按钮上只问一句——「这几家有没有我要做的事」。
//   没有它，下游只能用 openOn manual + onActivate 自己桥进批量面板：徽标还只反映总管自己
//   一行的快照（prefix ilife-life-pack），不是七家聚合——按钮说的和点开看到的不是一回事。
//   有了它：同一颗按钮的徽标即七家聚合，点开即批量面板；总管单行不再当状态源，manual 桥接可删。
//
// 契约（下游按它接）：
//   variant='button'（默认）：一个按钮，文案按聚合推出来；点下去先调 <前缀>.batchCheck 查一次，
//     再按 openOn 决定去向（缺省 'always'：查完总是以 dialog 形态开批量面板）；
//   variant='badge' ：只有一个小圆点（接入方自己排版、自己接管点击 → 走 onActivate 回调）；
//   variant='inline'：批量面板本体直接嵌进来（等价 mountUpdateBatchPanel 的 embedded，状态文案读 batchEntryLabelFor）；
//   打开面板 = 以 mode:'dialog' 挂批量面板（复用 src/panel-batch.ts，不另写界面）。
//   容器只有一个要求：有 innerHTML（与 panel 同口径）。入口件自己在容器里画按钮；面板开着时容器
//   暂时归面板所有（经转发件写同一个容器），关闭即还原按钮——接入方不用给第二个挂载点。
//
// 聚合口径（唯一出处：与批量面板总账同一份数法，不各写一份）：
//   计数吃 batchLedgerCounts(rows)（含「忙失败占位翻回可更新」的例外，与面板总账一字不差）；
//   状态档按「忙 > 失败 > 待重启 > 可更新 > 待查」落档（单入口是忙 > 待重启 > 失败 > 可更新，
//   这里失败排在待重启前面：待重启是某家已装好的正常终态，失败是整批里最需要人动手的那档，
//   聚合时必须先喊失败；正在装的忙仍最优先——活任务比陈旧失败更可信，与单入口同理）。
//   文案只用中文可执行，不写相位英文：检查更新 / N 家可更新 / 正在安装… / N 家待重启 / N 家失败，点此查看。
//
// 一条铁律（与单入口同一条）：**检查是只读、安装是写入，两者不许合并成一个动作**。
//   批量入口件永远只做「查 + 打开面板」，绝不自动装；用户必须在面板里明确点「安装」。
//   落实在本文件：只调 <前缀>.batchStatus（只读本地）与 <前缀>.batchCheck（只读查 N 家），
//   源码里不出现安装电话；安装只发生在批量面板里的动作被用户点下时。
//
// 本文件零 Node 专属能力（不读盘、不起进程、不拼 shell）：Node 宿主与浏览器闭包两边都跑得动；
// DOM 只在 mountUpdateBatchEntry 被调用时经容器与 globalThis 现取，模块顶层不碰。

import { MIN_PANEL_POLL_MS } from './config.js'
import { UPDATE_ENTRY_CSS } from './entry.js'
import {
  BATCH_PANEL_POLL,
  batchLedgerCounts,
  batchLedgerText,
  buildBatchPhoneNames,
  mountUpdateBatchPanel,
  type BatchPanelController,
  type BatchPanelMode,
  type BatchRowView,
} from './panel-batch.js'
import {
  failureCodeOf,
  normalizePanelTheme,
  type UpdatePanelTheme,
} from './panel.js'

// ---------- 公开类型 ----------

/** 批量入口件的形态（与单入口同一套取值）。 */
export type BatchEntryVariant = 'button' | 'badge' | 'inline'

/** 什么时候主动查一次（只读；与单入口同一口径）。 */
export type BatchEntryAutoCheck = 'mount' | 'never'

/**
 * 用户点下去之后做什么（与单入口同一套取值，缺省不同：批量缺省 'always'）。
 * 单入口缺省 'has-update'（有新版才开单面板）；批量入口缺省 'always'（查完总是开批量面板——
 * 批量面板的总账本身就是答案，空着也值得看一眼；下游删 manual 桥接即按此缺省跑）。
 * 'has-update' 下只有聚合档非 idle 才开面板（忙/失败/待重启/可更新都算有事），否则原地给总账一句。
 */
export type BatchEntryOpenOn = 'has-update' | 'always' | 'manual' | 'direct'

/** 批量入口件的状态档：只用来算文案与 data-state，不另立状态机。 */
export type BatchEntryStateKind = 'idle' | 'update' | 'busy' | 'restart' | 'failed'

/** 算文案要的全部输入：批量七行 + 最近一次批量电话的失败稳定码（没查过、没失败为 null）。 */
export interface UpdateBatchEntryState {
  rows: readonly BatchRowView[] | null
  error: string | null
}

/** 聚合后的读数（onActivate 与测试共用同一份，不各算一份）。 */
export interface BatchEntrySummary {
  kind: BatchEntryStateKind
  label: string
  updatable: number
  installing: number
  pending: number
  restart: number
  failed: number
  skipped: number
  settled: number
  total: number
  hasUpdate: boolean
}

export interface UpdateBatchEntryOptions {
  /** 批量电话前缀（与宿主侧一致，例 'life'）。 */
  prefix: string
  /** 调宿主电话：(phoneName, args) => Promise<reply>。 */
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>
  variant?: BatchEntryVariant
  /** 主题：与单入口/面板同一套（default/archive，d5-paper 为旧别名仍可用）。 */
  theme?: UpdatePanelTheme
  /** 缺省 'mount'：进页面静默查一次（只调 .batchStatus，只读）。'never' 则只在用户点击时查。 */
  autoCheck?: BatchEntryAutoCheck
  /** 缺省 'always'：查完总是开批量面板（见本类型说明）。 */
  openOn?: BatchEntryOpenOn
  /** 覆盖默认按钮文案（不传就用聚合文案）。 */
  label?: string
  /** 可选：键 -> 中文名覆盖（透传给批量面板）。 */
  titles?: Record<string, string>
  /** 轮询间隔（毫秒，透传给批量面板；缺省 1500，下限 250）。 */
  pollMs?: number
  /**
   * 详情行自动取日志（透传给批量面板，缺省开）。
   * 展开行有新版时调该行自己的更新日志电话按需取；false 关闭。
   */
  autoChangelog?: boolean
  /** 「重启宿主」的落地（透传给批量面板）：不传就只提示手动重启，不假装能重启。 */
  onRestartRequested?: () => void | Promise<void>
  /** 复制文本的出口（透传给批量面板）：不传即试浏览器剪贴板，都没有也不抛错。 */
  copyText?: (text: string) => void | Promise<void>
  /** variant='badge' 或 openOn='manual' 时，点击交给接入方（自己跳自己的页面）。 */
  onActivate?: (state: BatchEntrySummary) => void
}

export interface UpdateBatchEntryController {
  /** 立刻查一次并把状态刷到界面上（只读：调 .batchStatus）。 */
  refresh(): Promise<void>
  /** 打开批量面板（dialog 形态）。 */
  open(): void
  /** 关掉批量面板。 */
  close(): void
  /** 当前按钮上的聚合文案（接入方做自定义排版时读它）。 */
  label(): string
  /** 当前聚合读数（含七档计数，接入方排版与 onActivate 共用）。 */
  summary(): BatchEntrySummary
  setTheme(theme: UpdatePanelTheme): void
  unmount(): void
}

// ---------- 聚合 → 文案（纯函数：同一七行永远算出同一句话，面板总账与入口徽标共用同一份数法） ----------

const LABEL_IDLE = '检查更新'
const LABEL_BUSY = '正在安装…'

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** 宽容读七行：形状不对就当没查到（不猜、不抛）。 */
function asRows(value: unknown): BatchRowView[] | null {
  if (!Array.isArray(value)) return null
  return value as BatchRowView[]
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 聚合读数：计数唯一出处 batchLedgerCounts（与面板总账同一份，忙失败占位翻回可更新）。
 * hasUpdate = 忙/失败/待重启/可更新任一非零（openOn has-update 按它开面板；全 settled/待查/跳过即 idle）。
 */
export function batchEntrySummary(state: UpdateBatchEntryState | null | undefined): BatchEntrySummary {
  const rows = state?.rows ?? null
  const counts = batchLedgerCounts(Array.isArray(rows) ? rows : [])
  const total = Array.isArray(rows) ? rows.length : 0
  let kind: BatchEntryStateKind
  if (!Array.isArray(rows) || rows.length === 0) {
    kind = state?.error ? 'failed' : 'idle'
  } else if (counts.installing > 0) {
    kind = 'busy'
  } else if (counts.failed > 0) {
    kind = 'failed'
  } else if (counts.restart > 0) {
    kind = 'restart'
  } else if (counts.updatable > 0) {
    kind = 'update'
  } else {
    kind = 'idle'
  }
  // 电话本身失败但七行还在：按失败喊（行数还在，计数照旧，只把档位抬成失败）。
  if (kind !== 'busy' && state?.error) {
    if (Array.isArray(rows) && rows.length > 0 && counts.failed === 0 && counts.installing === 0) {
      kind = 'failed'
    }
  }
  const hasUpdate = counts.installing > 0 || counts.failed > 0 || counts.restart > 0 || counts.updatable > 0
  let label: string
  switch (kind) {
    case 'busy':
      label = LABEL_BUSY
      break
    case 'failed':
      label = counts.failed > 0 ? counts.failed + ' 家失败，点此查看' : '更新失败，点此查看'
      break
    case 'restart':
      label = counts.restart + ' 家待重启'
      break
    case 'update':
      label = counts.updatable + ' 家可更新'
      break
    default:
      label = LABEL_IDLE
      break
  }
  return {
    kind,
    label,
    updatable: counts.updatable,
    installing: counts.installing,
    pending: counts.pending,
    restart: counts.restart,
    failed: counts.failed,
    skipped: counts.skipped,
    settled: counts.settled,
    total,
    hasUpdate,
  }
}

/** 状态档（唯一出处：batchEntrySummary，不各写一份）。 */
export function batchEntryStateKind(state: UpdateBatchEntryState | null | undefined): BatchEntryStateKind {
  return batchEntrySummary(state).kind
}

/** 批量入口件文案（唯一出处：测试与接入方都读它，不各写一份）。 */
export function batchEntryLabelFor(state: UpdateBatchEntryState | null | undefined): string {
  return batchEntrySummary(state).label
}

// ---------- 挂载（接入方一行挂上；查是只读、装只能用户在面板里点） ----------

export function mountUpdateBatchEntry(
  container: { innerHTML: string; addEventListener?: (type: string, listener: (ev: unknown) => void) => void; removeEventListener?: (type: string, listener: (ev: unknown) => void) => void },
  options: UpdateBatchEntryOptions,
): UpdateBatchEntryController {
  if (!container || typeof container.innerHTML !== 'string') {
    throw new Error('[dsh-plugin-update] 挂批量入口件需要一个有 innerHTML 的容器')
  }
  if (!options || typeof options !== 'object') {
    throw new Error('[dsh-plugin-update] 挂批量入口件缺少配置：批量电话前缀 prefix 必填')
  }
  if (typeof options.call !== 'function') {
    throw new Error('[dsh-plugin-update] 挂批量入口件需要传输函数 call（入口件调宿主电话的唯一接触面）')
  }
  // 电话名只从批量前缀派生（与宿主侧同一套拼法，不写字面量）。
  const phones = buildBatchPhoneNames(options.prefix)

  const variant: BatchEntryVariant = options.variant ?? 'button'
  if (variant !== 'button' && variant !== 'badge' && variant !== 'inline') {
    throw new Error('[dsh-plugin-update] 入口件形态非法：只收 button / badge / inline（收到 ' + JSON.stringify(options.variant) + '）')
  }
  const autoCheck: BatchEntryAutoCheck = options.autoCheck ?? 'mount'
  if (autoCheck !== 'mount' && autoCheck !== 'never') {
    throw new Error('[dsh-plugin-update] 自动检查时机非法：只收 mount 或 never（收到 ' + JSON.stringify(options.autoCheck) + '）')
  }
  const openOn: BatchEntryOpenOn = options.openOn ?? 'always'
  if (openOn !== 'has-update' && openOn !== 'always' && openOn !== 'manual' && openOn !== 'direct') {
    throw new Error('[dsh-plugin-update] 点击去向非法：只收 has-update / always / manual / direct（收到 ' + JSON.stringify(options.openOn) + '）')
  }
  if (options.theme !== undefined && options.theme !== 'default' && options.theme !== 'archive' && options.theme !== 'd5-paper') {
    throw new Error('[dsh-plugin-update] 主题非法：只收 default 或 archive（d5-paper 为旧别名仍可用）（收到 ' + JSON.stringify(options.theme) + '）')
  }
  let theme: UpdatePanelTheme = normalizePanelTheme(options.theme ?? 'default')
  const pollMs = options.pollMs
  if (pollMs !== undefined && (typeof pollMs !== 'number' || !Number.isFinite(pollMs) || pollMs < MIN_PANEL_POLL_MS)) {
    throw new Error('[dsh-plugin-update] 面板轮询间隔非法：不得小于 250 毫秒（收到 ' + JSON.stringify(options.pollMs) + '）')
  }
  const labelOverride = typeof options.label === 'string' && options.label ? options.label : null
  const titles: Record<string, string> =
    options.titles && typeof options.titles === 'object' ? options.titles : {}
  const onActivate = typeof options.onActivate === 'function' ? options.onActivate : null
  const call = options.call

  const ENTRY_ATTR = 'data-dsh-upd-entry'
  const ENTRY_SELECTOR = '[data-dsh-upd-entry]'

  let rows: BatchRowView[] | null = null
  let error: string | null = null
  let note: string | null = null
  let loaded = false
  // 在途批量查（点下到回包前的那一帧，按钮置忙 + 并发连点只认第一次；与单入口同一口径）。
  let activating = false
  let mounted = true
  let panel: BatchPanelController | null = null
  let panelMode: BatchPanelMode | null = null

  // 面板与入口件共用同一个容器：面板经这个转发件写 innerHTML、挂监听，接入方不用给第二个挂载点。
  const panelHost = {
    get innerHTML(): string {
      return container.innerHTML
    },
    set innerHTML(value: string) {
      container.innerHTML = value
    },
    addEventListener(type: string, listener: (ev: unknown) => void) {
      ;(container as { addEventListener?: (type: string, listener: (ev: unknown) => void) => void }).addEventListener?.(type, listener)
    },
    removeEventListener(type: string, listener: (ev: unknown) => void) {
      ;(container as { removeEventListener?: (type: string, listener: (ev: unknown) => void) => void }).removeEventListener?.(type, listener)
    },
  }

  async function panelCall(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const reply = await call(name, args)
    return isObject(reply) ? reply : {}
  }

  function stateOf(): UpdateBatchEntryState {
    return { rows, error }
  }

  function summaryOf(): BatchEntrySummary {
    return batchEntrySummary(stateOf())
  }

  function currentLabel(): string {
    return labelOverride ?? summaryOf().label
  }

  /** 入口件自己那些电话的参数：只要全表，不带队列/环境（入口件不展示它们，少传少错）。 */
  function phoneArgs(): Record<string, unknown> {
    return {}
  }

  function entryHTML(): string {
    const summary = summaryOf()
    const text = activating ? '正在查新版…' : currentLabel()
    const busyAttr = activating ? ' disabled aria-busy="true"' : ''
    const themeAttr = theme === 'd5-paper' ? ' data-theme="d5-paper"' : ''
    const control =
      variant === 'badge'
        ? '<button type="button" class="dsh-upd-entry-dot" ' + ENTRY_ATTR + '="activate" title="' + escapeHtml(text) + '" aria-label="' + escapeHtml(text) + '"' + busyAttr + '></button>'
        : '<button type="button" class="dsh-upd-entry-btn" ' + ENTRY_ATTR + '="activate"' + busyAttr + '>' + escapeHtml(text) + '</button>'
    const noteHTML = note
      ? '<span class="dsh-upd-entry-note" data-dsh-upd-note="1">' + escapeHtml(note) + '</span>'
      : ''
    return (
      '<style>' + UPDATE_ENTRY_CSS + '</style>\n' +
      '<span class="dsh-upd-entry" data-variant="' + variant + '" data-state="' + summary.kind + '"' + themeAttr + '>' +
      control + noteHTML + '</span>'
    )
  }

  /** 重绘入口件本身；面板在容器里时容器归面板（关掉再还原）。 */
  function render(): void {
    if (!mounted) return
    if (panelMode !== null) return
    container.innerHTML = entryHTML()
  }

  function applyReply(reply: unknown): void {
    if (!isObject(reply) || reply['ok'] !== true) {
      // 失败（或回包形状不认）：记稳定码，七行不动（旧数还在，只把档位抬成失败）。
      error = failureCodeOf(isObject(reply) ? reply : null, 'check-failed')
      return
    }
    const next = asRows(reply['rows'])
    if (next) rows = next
    error = null
    loaded = true
  }

  async function refresh(): Promise<void> {
    if (!mounted) return
    try {
      const reply = await call(phones.status, phoneArgs())
      if (!mounted) return
      applyReply(reply)
    } catch {
      if (!mounted) return
      error = 'check-failed'
    }
    render()
  }

  /** 用户点击带来的那一次查（调 .batchCheck 查 N 家；只读，入口件唯一的联网点）。 */
  async function checkNow(): Promise<void> {
    try {
      const reply = await call(phones.check, phoneArgs())
      if (!mounted) return
      applyReply(reply)
    } catch {
      if (!mounted) return
      error = 'check-failed'
    }
  }

  /** 把批量面板挂进容器（复用 src/panel-batch.ts 的整组件，不另写界面）。 */
  function mountPanel(mode: BatchPanelMode): void {
    if (!mounted || panelMode !== null) return
    panel = mountUpdateBatchPanel(panelHost, {
      prefix: options.prefix,
      mode,
      theme,
      pollMs,
      titles,
      onRestartRequested: options.onRestartRequested,
      copyText: options.copyText,
      autoChangelog: options.autoChangelog,
      // 面板点「关闭」即走入口件的完整关闭（收 dialog + 还原按钮 + 重查一次），不再是面板自己停轮询。
      onCloseRequested: () => close(),
      call: panelCall,
    })
    panelMode = mode
  }

  function openDialog(): void {
    mountPanel('dialog')
  }

  function open(): void {
    if (!mounted || panelMode !== null) return
    // inline 的面板在挂载时就已经是容器本体；再 open 一次没有第二个可开的东西。
    if (variant === 'inline') return
    openDialog()
  }

  function close(): void {
    // 只收 dialog：inline 的面板是容器本体，收掉它等于把入口件拆了。
    if (!mounted || panelMode !== 'dialog' || !panel) return
    const opened = panel
    panel = null
    panelMode = null
    try {
      opened.unmount()
    } catch {
      // 停不掉也不挡还原按钮。
    }
    render()
    // 面板里可能刚装过：关掉后立刻只读查一次，让按钮文案如实（batchStatus 只读本地、不联网）。
    void refresh()
  }

  /**
   * 点下去：先查一次（只读），再按 openOn / variant 决定去向。
   * 任何分支都不会走到安装——安装只在批量面板里的动作被用户点下时发生。
   */
  async function activate(): Promise<void> {
    if (!mounted || panelMode !== null || activating) return
    // direct：点开即弹窗，不预查（面板挂载即自查，快照自己跟上；badge 仍走回调口径，不替接入方开面板）。
    if (openOn === 'direct' && variant === 'button') {
      openDialog()
      return
    }
    activating = true
    note = null
    render()
    try {
      await checkNow()
    } finally {
      activating = false
    }
    if (!mounted) return
    // badge 与 manual 都是「点击交给接入方」：把刚查到的聚合递出去，自己不开面板。
    if (variant === 'badge' || openOn === 'manual') {
      if (onActivate) onActivate(summaryOf())
      // 没给回调就没有别的去处：退回默认去向（开面板），总比点不动的死件强。
      else openDialog()
      render()
      return
    }
    const summary = summaryOf()
    // always 必开；has-update 下有事（忙/失败/待重启/可更新）或查不出来（没行或出错）也开——
    // 让用户看到为什么，而不是把失败咽掉。
    if (openOn === 'always' || summary.hasUpdate || !loaded || error) {
      openDialog()
      return
    }
    // 确知没事：不开面板，只在原地给总账一句（与面板总账同一句话，不各写一份）。
    note = batchLedgerText({
      updatable: summary.updatable,
      installing: summary.installing,
      pending: summary.pending,
      restart: summary.restart,
      failed: summary.failed,
      skipped: summary.skipped,
      settled: summary.settled,
    })
    render()
  }

  function setTheme(next: UpdatePanelTheme): void {
    if (next !== 'default' && next !== 'archive' && next !== 'd5-paper') {
      throw new Error('[dsh-plugin-update] 主题非法：只收 default 或 archive（d5-paper 为旧别名仍可用）（收到 ' + JSON.stringify(next) + '）')
    }
    theme = normalizePanelTheme(next)
    if (panel) void panel.setTheme(theme)
    else render()
  }

  function onClick(ev: unknown): void {
    if (!mounted) return
    try {
      const target = (ev as { target?: unknown } | null | undefined)?.target as
        | { closest?: (selector: string) => unknown }
        | undefined
      const closest = target && typeof target.closest === 'function' ? target.closest.bind(target) : null
      if (!closest) return
      if (closest(ENTRY_SELECTOR)) {
        void activate()
        return
      }
    } catch {
      // 点坏了也不挡更新。
    }
  }

  function onKeyDown(ev: unknown): void {
    try {
      const e = ev as { key?: unknown } | null | undefined
      if (!mounted || panelMode !== 'dialog' || !e || e.key !== 'Escape') return
      close()
    } catch {
      // 按坏了也不挡更新。
    }
  }

  function unmount(): void {
    if (!mounted) return
    mounted = false
    const opened = panel
    panel = null
    panelMode = null
    try {
      opened?.unmount()
    } catch {
      // 停不掉也无妨。
    }
    try {
      ;(container as { removeEventListener?: (type: string, listener: (ev: unknown) => void) => void }).removeEventListener?.('click', onClick)
    } catch {
      // 拆不掉也不挡。
    }
    try {
      ;(container as { removeEventListener?: (type: string, listener: (ev: unknown) => void) => void }).removeEventListener?.('keydown', onKeyDown)
    } catch {
      // 拆不掉也不挡。
    }
    // 卸载只停轮询与监听：绝不调安装/取消电话，也不动容器内容（与 panel.unmount 同口径）。
  }

  try {
    ;(container as { addEventListener?: (type: string, listener: (ev: unknown) => void) => void }).addEventListener?.('click', onClick)
  } catch {
    // 没有事件能力的容器也能用（controller.open/refresh 直达）。
  }
  try {
    ;(container as { addEventListener?: (type: string, listener: (ev: unknown) => void) => void }).addEventListener?.('keydown', onKeyDown)
  } catch {
    // 没有键盘事件能力的容器忽略（Esc 关弹窗是渐进增强）。
  }
  if (variant === 'inline') mountPanel('embedded')
  else render()
  // autoCheck='mount'：进页面静默查一次全表（只调 .batchStatus，只读）。'never' 就等用户点击。
  if (autoCheck === 'mount') void refresh()

  return { refresh, open, close, label: currentLabel, summary: summaryOf, setTheme, unmount }
}
