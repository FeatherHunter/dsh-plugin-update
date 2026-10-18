// src/install-button.ts — 槽位级“安装”按钮控件（#148）。
//
// 一句话：在任意容器里挂一颗按钮，原地装好一家插件。开发者决定放哪、长什么样，
// 装的正确性归本包；兜底保留手工命令；既有面板/入口/批量零改动。
//
// 不另起第二套口径：判定走 panelViewModel，失败判定走 failureCodeOf/failureCopy/blockedCopy，
// 诊断走 buildUpdateDiagCopy，文案走 copyText 既有键（唯一新键见 bilingual），
// 时序照抄 panel runAction 的 check/install 两案，日志沿用 update.panel.action。
// 本文件只做装配：挂载校验、双角色按钮、锁存、有界轮询、渲染。
//
// 浏览器安全：零 `node:` 导入。中文只许出现在 copyText 的 key 里，
// 本文件字符串字面量一律英文（双语门禁基线不动）。

import {
  buildLogAppendPhoneName,
  buildPhoneNames,
  DEFAULT_PANEL_POLL_MS,
  DEFAULT_PREFIX,
  MIN_PANEL_POLL_MS,
} from './config.js'
import { copyText, type BilingualKey } from './bilingual.js'
import { normalizeLangTag, resolveLang, subscribeLang, type AppLang, type LocaleOption } from './lang.js'
import {
  buildUpdateDiagCopy,
  failureCodeOf,
  fallbackCauseFromDetail,
  fallbackCauseFromDiag,
  isCheckSideFailureCode,
  messageCodeOf,
  panelViewModel,
  redactForCopy,
  replyIsCheckExpired,
  lastResortBarHTML,
  lastResortCopyButtonHTML,
  copyBubbleHTML,
  themeTokensStyleFor,
  thrownIsCheckExpired,
  type UpdatePanelClientLogOptions,
  type UpdateThemeTokens,
} from './panel.js'
import { formatUnlockAt } from './install-cause.js'
import { hash8 } from './hash.js'
import { lastResortVerdictOf, type ManualSource } from './last-resort.js'
// #174：last-resort 的类型经既有子路径转出，消费者无需新子路径即可命名（`ManualSource` 已出现在本模块导出签名里）。
export type { LastResortKind, RescueRouteKey, ManualSource, LastResortVerdict } from './last-resort.js'
import { createClientLogChannel, type ClientLogChannel } from './log/client-queue.js'
// #212：只借类型（浏览器侧不许运行时引 ./log 的 Node 模块；类型导入编译即抹掉）。
import type { UpdateLogHealth } from './log/health.js'
import type { InstallSource, UpdateSnapshot } from './ports.js'
import type { VisibleQueue } from './queue.js'

// ---------- 对外类型 ----------

export type InstallButtonCall = (
  name: string,
  args: Record<string, unknown>,
) => Promise<Record<string, unknown>>

export type InstallButtonCopyText = (text: string) => void | Promise<void>

export interface InstallButtonOptions {
  pluginId: string
  call: InstallButtonCall
  prefix?: string
  pollMs?: number
  autoCheck?: 'mount' | 'never'
  showOthers?: boolean
  profileName?: string | null
  locale?: LocaleOption
  theme?: 'default' | 'archive'
  themeTokens?: UpdateThemeTokens
  copyText?: InstallButtonCopyText
  /**
   * 安装意图来源（#207）：落进 update.install.request.from。缺省 `entry`——按钮是嵌在宿主界面里的
   * 入口，可嵌入任何页面；面板本体自己的调用显式传 `panel`，批量编排传 `batch`。
   */
  from?: InstallSource
  clientLog?: UpdatePanelClientLogOptions | null
}

export interface InstallButtonContainer {
  innerHTML: string
  addEventListener?: (type: string, listener: (ev: unknown) => void) => void
  removeEventListener?: (type: string, listener: (ev: unknown) => void) => void
}

export interface InstallButtonController {
  state(): {
    snapshot: UpdateSnapshot | null
    manual: string | null
    queue: VisibleQueue | null
    failedCode: string | null
    busy: boolean
  }
  refresh(): Promise<void>
  unmount(): void
}

export type InstallButtonRole = 'install' | 'check' | 'none'

export interface InstallButtonViewInput {
  snapshot: UpdateSnapshot | null
  manual: string | null
  queue: VisibleQueue | null
  lastError: string | null
  errorKind?: string | null
  /** 锁存里的失败原文（翻译官重认用；没有即不认，不猜）。 */
  errorDetail?: string | null
  /** 锁存里的机读诊断（#156 第四轮）：异步失败时宿主随成功回包补的包名/归因，认因优先用它。 */
  errorDiag?: unknown
  /** 归因用的插件标识（与 panel 锁存同口径）。 */
  pluginId?: string | null
  /** 决议已出的候选（有即二次确认态，无即首问态）。 */
  fallbackOffer?: { candidate: string; targetVersion: string } | null
  busyAct: 'check' | 'install' | 'fallback' | null
  /**轮询封顶后转重查态：在途也不再显示忙。请调用方（挂载）传入，纯函数不读计时器。*/
  pollCapped?: boolean | null
  lang?: AppLang | string | null
}

export interface InstallButtonView {
  role: InstallButtonRole
  buttonLabel: string
  buttonEnabled: boolean
  buttonBusy: boolean
  /** Whether to render the button element at all (restart/blocked/action-less failure show text only). */
  showButton: boolean
  statusTitle: string
  statusAction: string
  showManual: boolean
  queueNote: string | null
  bannerKind: string
  /** 合规版兜底（#156）：失败且拦的正是更新目标时非 null；复用 panel.action.* 既有键，零新增键。 */
  fallbackStage: 'offer' | 'confirm' | null
  fallbackCandidate: string | null
  fallbackBusy: boolean
}

export const INSTALL_BUTTON_POLL = {
  defaultMs: DEFAULT_PANEL_POLL_MS,
  minMs: MIN_PANEL_POLL_MS,
} as const

/** 有界轮询上限（约 5 分钟 @ 默认 1 秒；到顶停轮询转重查态，安装在宿主侧继续）。 */
export const INSTALL_BUTTON_MAX_POLLS = 300

export const INSTALL_BUTTON_CSS = [
  '.dsh-upd-ib{display:flex;flex-direction:column;gap:8px;font:inherit}',
  '.dsh-upd-ib-status{font-weight:600;overflow-wrap:anywhere}',
  '.dsh-upd-ib-sub{opacity:.85;overflow-wrap:anywhere}',
  '.dsh-upd-ib-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
  '.dsh-upd-ib button{cursor:pointer;transition:border-color 120ms ease,box-shadow 120ms ease,transform 80ms ease}',
  '.dsh-upd-ib button[disabled]{cursor:default}',
  // #173 v1.3：按钮 hover 必须看得见边框变化（主色边框 + 2px 外环），不能只靠 brightness。
  '.dsh-upd-ib button:hover:not(:disabled){border-color:var(--dsh-update-primary,#2563eb);box-shadow:0 0 0 2px var(--dsh-update-primary,#2563eb)}',
  '.dsh-upd-ib button:active:not(:disabled){transform:translateY(1px)}',
  '.dsh-upd-ib button:focus-visible{outline:2px solid var(--dsh-update-primary,#2563eb);outline-offset:2px}',
  '@media (prefers-reduced-motion: reduce){.dsh-upd-ib button{transition:none}}',
  '.dsh-upd-ib-manual summary{cursor:pointer}',
  '.dsh-upd-ib-manual code{display:block;white-space:pre-wrap;overflow-wrap:anywhere}',
  // #174：折叠细节里的最后手段条与 #177 的 stale 说明（主题令牌走既有变量；内联回退色与同文件既有变量写法一致）。
  '.dsh-upd-ib-manual .dsh-upd-lastresort{margin-top:6px}',
  '.dsh-upd-ib-manual .dsh-upd-lr-go{margin:0}',
  '.dsh-upd-ib-stale{color:var(--dsh-update-text-muted,inherit);font-size:var(--dsh-update-panel-small-font-size,12px)}',
  '.dsh-upd-ib-notice{opacity:.8}',
  // #173 v1.3：复制成功气泡（fixed 定位，不挤动布局；系统色/减弱动态下可用）。
  '.dsh-upd-ib .dsh-upd-copy-bubble{position:fixed;z-index:10000;transform:translate(-50%,-100%);background:var(--dsh-update-text,#1f2937);color:var(--dsh-update-bg,#ffffff);border-radius:4px;padding:3px 9px;font-size:var(--dsh-update-panel-small-font-size,12px);line-height:1.5;pointer-events:none}',
  '@media (prefers-reduced-motion: reduce){.dsh-upd-ib .dsh-upd-copy-bubble{animation:none}}',
  '@media (forced-colors: active){.dsh-upd-ib .dsh-upd-copy-bubble{border:1px solid CanvasText;background:Canvas;color:CanvasText}}',
  '.dsh-upd-ib[data-theme="archive"] .dsh-upd-ib-status{font-family:serif}',
].join('\n')

// ---------- 本地小件（与 panel 同形，见 parity 注释；判定一律调 panel 纯函数） ----------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Parity with panel asSnapshot: invalid shape never replaces the live snapshot.
function asSnapshot(value: unknown): UpdateSnapshot | null {
  if (!isObject(value)) return null
  if (typeof value['canInstall'] !== 'boolean') return null
  return value as unknown as UpdateSnapshot
}

// Parity with panel asQueue: queue view is best-effort, wrong shape ignored.
function asQueue(value: unknown): VisibleQueue | null {
  if (!isObject(value) || typeof value['busy'] !== 'boolean') return null
  return value as unknown as VisibleQueue
}

// Parity with panel randomRequestId: fresh idempotency id per install click.
function randomRequestId(): string {
  try {
    const rand = Math.floor(Math.random() * 0xffffff).toString(36)
    return `r${Date.now().toString(36)}${rand}`.slice(0, 64)
  } catch {
    return `r${Date.now()}`
  }
}

// Parity with panel jobTargetOf: install target of that failed run, null when unknown.
function jobTargetOf(value: unknown): string | null {
  try {
    const job = (value as { job?: { targetVersion?: unknown } } | null | undefined)?.job
    const tv = job?.targetVersion
    return typeof tv === 'string' && tv.trim() ? tv.trim() : null
  } catch {
    return null
  }
}

function utf8ByteLength(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}

function getTimer(): { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void } {
  const g = globalThis as Record<string, unknown>
  const set = g['setInterval']
  const clear = g['clearInterval']
  if (typeof set === 'function' && typeof clear === 'function') {
    return {
      set: (fn, ms) => (set as (fn: () => void, ms: number) => unknown).call(g, fn, ms),
      clear: (handle) => (clear as (handle: unknown) => void).call(g, handle),
    }
  }
  return { set: () => null, clear: () => {} }
}

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
    // Clipboard unavailable: caller shows the manual-select fallback, never throws.
  }
}

// ---------- 纯函数视图（无计时器无 DOM；挂载与测试共用同一装配） ----------

/**
 * 合规版兜底资格（#156，纯函数）：失败原文经翻译官重认，拦的正是当前更新目标才给。
 * B 类（别家包）与认不出的失败回 null——调用方走通用老路，最坏情况就是现在。
 * 候选对不上当前目标即视为无候选（旧决议不指手画脚，由挂载侧清掉）。
 * #156 第四轮：先认机读诊断（宿主补的包名/归因）——真机上插件标识与 npm 包名不是一回事，
 * 只按标识认的话这支按钮在真机上永远不出现；诊断认不出才退回原文认。
 */
function installButtonFallbackOf(input: InstallButtonViewInput, bannerKind: string): {
  stage: 'offer' | 'confirm'
  candidate: string | null
} | null {
  try {
    if (bannerKind !== 'failed') return null
    if (input.busyAct === 'check' || input.busyAct === 'install') return null
    const code = typeof input.lastError === 'string' && input.lastError ? input.lastError : 'install-failed'
    const byDiag = fallbackCauseFromDiag(input.errorDiag, input.errorDetail ?? null, code, input.snapshot?.job?.targetVersion)
    const cause = byDiag ?? fallbackCauseFromDetail(input.errorDetail ?? null, code, input.pluginId ?? null)
    if (!cause) return null
    const latest = input.snapshot?.latestVersion ?? null
    if (typeof latest !== 'string' || !latest || cause.targetVersion !== latest) return null
    const offered = typeof input.fallbackOffer?.candidate === 'string' ? input.fallbackOffer.candidate.trim() : ''
    const offerTarget = typeof input.fallbackOffer?.targetVersion === 'string' ? input.fallbackOffer.targetVersion.trim() : ''
    if (offered && offerTarget === cause.targetVersion) return { stage: 'confirm', candidate: offered }
    return { stage: 'offer', candidate: null }
  } catch {
    return null
  }
}

export function installButtonViewModel(input: InstallButtonViewInput): InstallButtonView {
  const l = normalizeLangTag(input.lang ?? 'zh')
  const view = panelViewModel(
    {
      snapshot: input.snapshot,
      manual: input.manual,
      queue: input.queue,
      skippedLatest: false,
      lastError: input.lastError,
      errorKind: input.errorKind ?? null,
    },
    l,
  )
  const job = input.snapshot?.job ?? null
  const jobState = job?.state ?? null
  const jobActive = jobState === 'installing' || jobState === 'verifying'
  const fallback = installButtonFallbackOf(input, view.banner.kind)
  const fallbackBusy = input.busyAct === 'fallback'
  // 封顶转重查态：在途也不再显示忙，按钮退回检查（点查即刷新，不多一次自动调用）。
  if (input.pollCapped === true && jobActive && !input.busyAct) {
    return {
      role: 'check',
      buttonLabel: copyText('panel.action.check', l),
      buttonEnabled: true,
      buttonBusy: false,
      showButton: true,
      statusTitle: view.banner.title,
      statusAction: view.banner.action,
      showManual: view.showManual,
      queueNote: view.queueNote,
      bannerKind: view.banner.kind,
      fallbackStage: null,
      fallbackCandidate: null,
      fallbackBusy: false,
    }
  }
  if (input.busyAct === 'check' || input.busyAct === 'install' || input.busyAct === 'fallback' || jobActive) {
    const label =
      input.busyAct === 'check'
        ? copyText('panel.action.checking-busy', l)
        : input.busyAct === 'install'
          ? copyText('panel.action.installing-busy', l)
          : view.installLabel
    return {
      role: 'none',
      buttonLabel: label,
      buttonEnabled: false,
      buttonBusy: true,
      showButton: true,
      statusTitle: view.banner.title,
      statusAction: view.banner.action,
      showManual: view.showManual,
      queueNote: view.queueNote,
      bannerKind: view.banner.kind,
      fallbackStage: fallback?.stage ?? null,
      fallbackCandidate: fallback?.candidate ?? null,
      fallbackBusy,
    }
  }
  // 可安装（核心口径）：主按钮照旧，兜底是**加法**不是替代——与主面板同一摆放。
  // 关键：年龄门是 pnpm 在装的那一刻拦的，核心的 canInstall 根本不知道它，
  // 所以"装失败之后 canInstall 仍为真"才是生产真形状；此处若把兜底吞掉，
  // 主场景（最新版被拦）在槽位上就永远看不见［装合规版］（2026-10-17 对抗审查实测）。
  if (view.installEnabled) {
    return {
      role: 'install',
      buttonLabel: view.installLabel,
      buttonEnabled: true,
      buttonBusy: false,
      showButton: true,
      statusTitle: view.banner.title,
      statusAction: view.banner.action,
      showManual: view.showManual,
      queueNote: view.queueNote,
      bannerKind: view.banner.kind,
      fallbackStage: fallback?.stage ?? null,
      fallbackCandidate: fallback?.candidate ?? null,
      fallbackBusy,
    }
  }
  if (!input.snapshot || !input.snapshot.latestVersion) {
    return {
      role: 'check',
      buttonLabel: copyText('panel.action.check', l),
      buttonEnabled: true,
      buttonBusy: false,
      showButton: true,
      statusTitle: view.banner.title,
      statusAction: view.banner.action,
      showManual: view.showManual,
      queueNote: view.queueNote,
      bannerKind: view.banner.kind,
      fallbackStage: null,
      fallbackCandidate: null,
      fallbackBusy: false,
    }
  }
  if (input.lastError && isCheckSideFailureCode(input.lastError)) {
    return {
      role: 'check',
      buttonLabel: copyText('panel.action.check', l),
      buttonEnabled: true,
      buttonBusy: false,
      showButton: true,
      statusTitle: view.banner.title,
      statusAction: view.banner.action,
      showManual: view.showManual,
      queueNote: view.queueNote,
      bannerKind: view.banner.kind,
      fallbackStage: null,
      fallbackCandidate: null,
      fallbackBusy: false,
    }
  }
  const done = view.banner.kind === 'done'
  return {
    role: 'none',
    buttonLabel: done ? copyText('install-button.action.installed' as BilingualKey, l) : view.installLabel,
    buttonEnabled: false,
    buttonBusy: false,
    showButton: done,
    statusTitle: view.banner.title,
    statusAction: view.banner.action,
    showManual: view.showManual,
    queueNote: view.queueNote,
    bannerKind: view.banner.kind,
    fallbackStage: fallback?.stage ?? null,
    fallbackCandidate: fallback?.candidate ?? null,
    fallbackBusy,
  }
}

export function renderInstallButtonHTML(
  view: InstallButtonView,
  opts: {
    manual: string | null
    notice: string | null
    theme: 'default' | 'archive'
    lang: AppLang
    manualSource?: ManualSource | null
    /** 该帧失败码（给了才判最后手段；缺省按无码 → unknown，不误亮）。 */
    failureCode?: string | null
    /** 合规版救援证据（给了就把 install-failed 判成 salvageable）。 */
    fallbackAvailable?: boolean
    /** 待重启那档的在册事实（#190；false → 救援路径是「在宿主里选择」）。 */
    registered?: boolean | null
    /** 复制成功气泡（#173 v1.3）：缺省即不画。 */
    bubble?: { text: string; left: number; top: number } | null
  },
): string {
  const l = opts.lang
  // #177：命令可信来源（缺省按 frame，兼容老调用方）；carried-over 一律 fail-closed。
  const manualSource: ManualSource | null =
    opts.manualSource === 'carried-over' ? 'carried-over' : opts.manualSource === null ? null : 'frame'
  const manualTrusted =
    typeof opts.manual === 'string' && opts.manual.trim() !== '' && manualSource === 'frame'
  const lastResort = lastResortVerdictOf({
    code: opts.failureCode ?? null,
    blockedReason: null,
    manual: typeof opts.manual === 'string' ? opts.manual : null,
    manualSource,
    fallbackAvailable: opts.fallbackAvailable === true,
    registered: opts.registered ?? null,
  })
  const parts: string[] = []
  parts.push('<style>' + INSTALL_BUTTON_CSS + '</style>')
  parts.push('<div class="dsh-upd-ib" data-theme="' + opts.theme + '">')
  parts.push(
    '<div class="dsh-upd-ib-status dsh-upd-ib-kind-' +
      escapeHtml(view.bannerKind) +
      '">' +
      escapeHtml(view.statusTitle) +
      '</div>',
  )
  const sub = [view.statusAction, view.queueNote].filter((t) => typeof t === 'string' && t.trim())
  if (sub.length > 0) {
    parts.push('<div class="dsh-upd-ib-sub">' + escapeHtml(sub.join(' ')) + '</div>')
  }
  if (view.showButton) {
    // Actionable roles carry data-action; done/busy states render text only.
    const actionAttr = view.role === 'none' ? '' : ' data-action="' + (view.role === 'check' ? 'check' : 'install') + '"'
    const disabled = view.buttonEnabled ? '' : ' disabled'
    const busy = view.buttonBusy ? ' aria-busy="true"' : ''
    parts.push(
      '<div class="dsh-upd-ib-row"><button type="button"' +
        actionAttr +
        ' data-primary="1"' +
        disabled +
        busy +
        '>' +
        escapeHtml(view.buttonLabel) +
        '</button></div>',
    )
  }
  // 合规版兜底（#156）：失败且拦的正是更新目标时，与主面板同口径给双按钮；
  // B 类与认不出的失败一个字不动（通用老路）。复用 panel.action.* 既有键，零新增键。
  if (view.fallbackStage === 'confirm' && view.fallbackCandidate) {
    const busy = view.fallbackBusy || view.buttonBusy ? ' disabled aria-busy="true"' : ''
    parts.push(
      '<div class="dsh-upd-ib-row"><button type="button" data-action="install-fallback-confirm" data-primary="1" title="' +
        escapeHtml(copyText('panel.action.install-fallback-confirm-title', l)) +
        '"' +
        busy +
        '>' +
        escapeHtml(copyText('panel.action.install-fallback-confirm', l, { version: view.fallbackCandidate })) +
        '</button><button type="button" data-action="wait-latest" title="' +
        escapeHtml(copyText('panel.action.wait-latest-title', l)) +
        '"' +
        (view.fallbackBusy || view.buttonBusy ? ' disabled' : '') +
        '>' +
        escapeHtml(copyText('panel.action.wait-latest', l)) +
        '</button></div>',
    )
  } else if (view.fallbackStage === 'offer') {
    const busy = view.fallbackBusy || view.buttonBusy ? ' disabled aria-busy="true"' : ''
    parts.push(
      '<div class="dsh-upd-ib-row"><button type="button" data-action="install-fallback" data-primary="1" title="' +
        escapeHtml(copyText('panel.action.install-fallback-title', l)) +
        '"' +
        busy +
        '>' +
        escapeHtml(copyText('panel.action.install-fallback', l)) +
        '</button><button type="button" data-action="wait-latest" title="' +
        escapeHtml(copyText('panel.action.wait-latest-title', l)) +
        '"' +
        (view.fallbackBusy || view.buttonBusy ? ' disabled' : '') +
        '>' +
        escapeHtml(copyText('panel.action.wait-latest', l)) +
        '</button></div>',
    )
  }
  // 失败证据常驻：复制诊断不随主按钮同隐——无动作可点时（blocked/待重启后的失败）仍可取证。
  if (view.bannerKind === 'failed') {
    parts.push(
      '<div class="dsh-upd-ib-row"><button type="button" data-action="copy-diag" title="' +
        escapeHtml(copyText('panel.action.copy-diag-title', l)) +
        '">' +
        escapeHtml(copyText('panel.action.copy-diag', l)) +
        '</button></div>',
    )
  }
  // 手工命令折叠区（#174 A′）：只有最后手段那一档在折叠细节里插 A′ 条，按钮落在主位；
  // 其余档沿用原样。carried-over（#177）不给命令、不给复制、只说明未按当帧确认。
  if (view.showManual && manualTrusted) {
    const bar = lastResortBarHTML({
      verdict: lastResort,
      lang: l,
      buttonHtml: lastResortCopyButtonHTML(l),
    })
    parts.push(
      '<details class="dsh-upd-ib-manual"><summary>' +
        escapeHtml(copyText('panel.chapter.manual', l)) +
        '</summary>' +
        bar +
        '<code>' +
        escapeHtml(opts.manual ?? '') +
        '</code>' +
        (bar
          ? ''
          : '<button type="button" data-action="copy-manual" title="' +
            escapeHtml(copyText('panel.action.copy-manual-title', l)) +
            '">' +
            escapeHtml(copyText('panel.action.copy-manual', l)) +
            '</button>') +
        '</details>',
    )
  } else if (view.showManual && manualSource === 'carried-over' && opts.manual) {
    parts.push(
      '<details class="dsh-upd-ib-manual"><summary>' +
        escapeHtml(copyText('panel.chapter.manual', l)) +
        '</summary><div class="dsh-upd-ib-stale">' +
        escapeHtml(copyText('panel.manual.stale', l)) +
        '</div></details>',
    )
  }
  if (opts.notice) {
    parts.push('<div class="dsh-upd-ib-notice" role="status">' + escapeHtml(opts.notice) + '</div>')
  }
  // v1.3：复制成功气泡挂在槽位根部之内（CSS `.dsh-upd-ib .dsh-upd-copy-bubble` 才能管到定位/配色）；
  // fixed 定位不挤压布局，按钮文案/图标不变。
  parts.push(copyBubbleHTML(opts.bubble ?? null))
  parts.push('</div>')
  return parts.join('')
}

// ---------- 挂载 ----------

interface InstallButtonLatch {
  code: string
  kind: string | null
  detail: string | null
  diag: unknown
  requestId: string | null
  checkId: string | null
  runningVersion: string | null
  installedVersion: string | null
  latestVersion: string | null
  targetVersion: string | null
  hostKind: string | null
  profileName: string | null
  source: 'check' | 'install'
  volatile: boolean
  atMs: number | null
}

export function mountInstallButton(
  container: InstallButtonContainer,
  options: InstallButtonOptions,
): InstallButtonController {
  const logOptionRead =
    options && typeof options === 'object'
      ? (options as { clientLog?: UpdatePanelClientLogOptions | null }).clientLog
      : undefined
  const clientLogDisabled = logOptionRead === null
  const clientLogMountName =
    logOptionRead && typeof logOptionRead === 'object' && typeof logOptionRead.mount === 'string' && logOptionRead.mount
      ? logOptionRead.mount
      : ''
  let clientLog: ClientLogChannel | null =
    logOptionRead && typeof logOptionRead === 'object' && logOptionRead.channel ? logOptionRead.channel : null
  let clientLogOwned = false
  function logClient(level: string, event: string, fields: Record<string, unknown>): void {
    const channel = clientLog
    if (!channel) return
    try {
      channel.emit(level, event, fields)
    } catch {
      // Logging never blocks install.
    }
  }
  // ---------- failure evidence (#214): same shape and dedupe as the panel ----------
  const RENDER_FAIL_DEDUPE_MS = 60_000
  const renderFailSeen = new Map<string, number>()
  function errorTextOf(err: unknown): string {
    if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
      return (err as { message: string }).message
    }
    if (typeof err === 'string') return err
    try {
      return String(err ?? '')
    } catch {
      return ''
    }
  }
  function emitRenderFail(phase: 'mount' | 'paint' | 'poll' | 'global', kind: string, message: string): void {
    const errorHash = hash8(message)
    if (phase !== 'mount') {
      const key = `${phase}|${kind}|${errorHash}`
      const nowMs = Date.now()
      const last = renderFailSeen.get(key)
      if (last !== undefined && nowMs - last < RENDER_FAIL_DEDUPE_MS) return
      renderFailSeen.set(key, nowMs)
    }
    logClient('error', 'update.panel.render.fail', { phase, kind, errorHash })
  }
  function failMount(kind: string, message: string): void {
    emitRenderFail('mount', kind, message)
    try {
      void clientLog?.flush()
    } catch {
      // Best effort.
    }
  }
  function clientDroppedRows(): number {
    try {
      const map = clientLog?.droppedByReason?.() ?? {}
      let total = 0
      for (const key of Object.keys(map)) {
        const n = map[key]
        if (typeof n === 'number' && Number.isFinite(n) && n > 0) total += n
      }
      return total
    } catch {
      return 0
    }
  }
  let removeGlobalHandlers: (() => void) | null = null
  function installGlobalHandlers(): void {
    const g = globalThis as unknown as {
      addEventListener?: (type: string, fn: (event: unknown) => void) => void
      removeEventListener?: (type: string, fn: (event: unknown) => void) => void
    }
    if (typeof g.addEventListener !== 'function') return
    const onError = (event: unknown): void => {
      const msg = errorTextOf((event as { message?: unknown } | null)?.message ?? event)
      emitRenderFail('global', 'uncaught', msg || 'uncaught-error')
    }
    const onRejection = (event: unknown): void => {
      const reason = (event as { reason?: unknown } | null)?.reason
      emitRenderFail('global', 'unhandled', errorTextOf(reason) || 'unhandled-rejection')
    }
    let registered = false
    try {
      g.addEventListener('error', onError)
      g.addEventListener('unhandledrejection', onRejection)
      registered = true
    } catch {
      registered = false
    }
    if (registered) {
      removeGlobalHandlers = () => {
        try {
          g.removeEventListener?.('error', onError)
          g.removeEventListener?.('unhandledrejection', onRejection)
        } catch {
          // Best effort.
        }
      }
    }
  }
  if (!options || typeof options !== 'object') {
    const message = '[dsh-plugin-update] install button needs options: pluginId is required'
    failMount('plugin-id', message)
    throw new Error(message)
  }
  // Transport is the one minimal dependency: without call there is nowhere to report (only zero-row mount failure).
  if (typeof options.call !== 'function') {
    const message = '[dsh-plugin-update] install button needs call (the only channel to host phones)'
    failMount('call', message)
    throw new Error(message)
  }
  // Create the channel before the remaining checks (#214): an illegal prefix falls back to the default route
  // so the failure row still has somewhere to go; the prefix check below still throws as before.
  const prefix = options.prefix === undefined ? DEFAULT_PREFIX : options.prefix
  let channelPrefix = DEFAULT_PREFIX
  try {
    buildLogAppendPhoneName(prefix)
    channelPrefix = String(prefix)
  } catch {
    // Illegal prefix: channel uses the default prefix; the prefix check reports it.
  }
  if (!clientLog && !clientLogDisabled) {
    try {
      clientLog = createClientLogChannel({ call: options.call, phoneName: buildLogAppendPhoneName(channelPrefix) })
      clientLogOwned = true
    } catch {
      clientLog = null
    }
  }
  if (!container || typeof container.innerHTML !== 'string') {
    const message = '[dsh-plugin-update] install button needs a container with innerHTML'
    failMount('container', message)
    throw new Error(message)
  }
  const pluginId = options.pluginId
  if (typeof pluginId !== 'string' || !pluginId) {
    const message = `[dsh-plugin-update] install button needs pluginId: non-empty string (got ${JSON.stringify(pluginId)})`
    failMount('plugin-id', message)
    throw new Error(message)
  }
  let phoneNames: ReturnType<typeof buildPhoneNames>
  try {
    phoneNames = buildPhoneNames(prefix)
  } catch (err) {
    failMount('prefix', errorTextOf(err))
    throw err
  }
  const pollMs = options.pollMs === undefined ? DEFAULT_PANEL_POLL_MS : options.pollMs
  if (typeof pollMs !== 'number' || !Number.isFinite(pollMs) || pollMs < MIN_PANEL_POLL_MS) {
    const message = `[dsh-plugin-update] install button pollMs must be >= 250ms (got ${JSON.stringify(options.pollMs)})`
    failMount('poll-ms', message)
    throw new Error(message)
  }
  const autoCheck = options.autoCheck ?? 'mount'
  if (autoCheck !== 'mount' && autoCheck !== 'never') {
    const message = `[dsh-plugin-update] install button autoCheck must be mount or never (got ${JSON.stringify(options.autoCheck)})`
    failMount('auto-check', message)
    throw new Error(message)
  }
  if (options.theme !== undefined && options.theme !== 'default' && options.theme !== 'archive') {
    const message = `[dsh-plugin-update] install button theme must be default or archive (got ${JSON.stringify(options.theme)})`
    failMount('theme', message)
    throw new Error(message)
  }
  const theme = options.theme ?? 'default'
  try {
    themeTokensStyleFor(options.themeTokens ?? undefined)
  } catch (err) {
    failMount('theme-tokens', errorTextOf(err))
    throw err
  }
  const localeOpt: LocaleOption = options.locale ?? undefined
  if (localeOpt !== undefined && localeOpt !== null) {
    const isStr = typeof localeOpt === 'string'
    const isObj = typeof localeOpt === 'object' && typeof (localeOpt as { getActive?: unknown }).getActive === 'function'
    if (!isStr && !isObj) {
      const message = '[dsh-plugin-update] invalid locale: expected zh / en / BCP47 or { getActive(), subscribe? }'
      failMount('locale', message)
      throw new Error(message)
    }
    if (isStr && !(localeOpt as string).trim()) {
      const message = '[dsh-plugin-update] invalid locale: empty string'
      failMount('locale', message)
      throw new Error(message)
    }
  }
  function currentLang(): AppLang {
    return resolveLang(localeOpt)
  }
  const showOthers = options.showOthers === true
  const profileNameOption = typeof options.profileName === 'string' && options.profileName ? options.profileName : null
  const copyTextOut = options.copyText ?? defaultCopyText
  const call = options.call
  const installSource: InstallSource = options.from ?? 'entry'

  let mounted = true
  let snapshot: UpdateSnapshot | null = null
  let manual: string | null = null
  // #177：命令可信来源（frame / carried-over）；失败回包沿用旧值即不可信。
  let manualSource: ManualSource | null = null
  // #177 D3：失败回包后只补读一次（成功才应用；不写锁存、不重试、失败即静默）。
  let failureRereadDone = false
  let queue: VisibleQueue | null = null
  let receipt: { checkId: string } | null = null
  let requestId: string | null = null
  let latch: InstallButtonLatch | null = null
  let busyAct: 'check' | 'install' | 'fallback' | null = null
  /** 合规版决议已出的候选（#156）：新失败即失效，由 setLatch/clearLatch 单点清掉，不许旧决议指新失败。 */
  let fallbackOffer: { candidate: string; checkId: string; targetVersion: string } | null = null
  let ensuring = false
  let pollCount = 0
  let pollCapped = false
  let envHostKind: string | null = null
  let envProfileName: string | null = null
  /** #212 日志健康读数：成功回包才带；老宿主一直 null，复制诊断与旧输出逐字一致。 */
  let envLogHealth: UpdateLogHealth | null = null
  let copyNotice: string | null = null
  let noticeExpiresAt = 0
  // #173 v1.3：复制成功气泡（状态提示，不改按钮文案/图标）；1.4s 后撤掉。
  let copyBubble: { text: string; left: number; top: number } | null = null
  let copyBubbleTimer: ReturnType<typeof setTimeout> | null = null
  let copyAnchorEl: unknown = null
  let actionBytes = -1
  let actionTruncated = false
  /** #214：连续传输失败次数（刷新成功即清零）；进 copy-diag 的连接段。 */
  let transportFailStreak = 0
  /** #214：这次动作是否因为已有动作在途而被拒（动作行的第四态）。 */
  let actionSkipped = false

  function latchNow(): number | null {
    try {
      const n = Date.now()
      return Number.isFinite(n) ? n : null
    } catch {
      return null
    }
  }

  function currentEnvPair(): { hostKind: string | null; profileName: string | null } {
    return { hostKind: envHostKind, profileName: profileNameOption ?? envProfileName }
  }

  function thrownDetail(err: unknown): string | null {
    try {
      const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : null
      if (typeof raw !== 'string') return null
      const t = raw.trim()
      if (!t) return null
      if (/^[a-z][a-z-]*$/.test(t) && t.length <= 32) return null
      return redactForCopy(t) || null
    } catch {
      return null
    }
  }

  // update-busy is queue contention, not failure: thrown rejections carrying it
  // must not latch (same carve-out as the ok:false reply path).
  function thrownBusy(err: unknown): boolean {
    try {
      if (typeof err === 'string') return err.trim() === 'update-busy'
      if (err instanceof Error) return err.message.trim() === 'update-busy'
      if (isObject(err)) {
        const e = typeof err['error'] === 'string' ? (err['error'] as string).trim() : ''
        const k = typeof err['errorKind'] === 'string' ? (err['errorKind'] as string).trim() : ''
        return e === 'update-busy' || k === 'update-busy'
      }
    } catch {
      // Unreadable shape is not busy.
    }
    return false
  }

  function setLatch(next: InstallButtonLatch): void {
    latch = next
    fallbackOffer = null
  }

  // #150 判据单源：过期凭证的回包/抛错判定复用 panel.ts 的同名导出（本文件不再自存一份）。

  function clearLatch(): void {
    latch = null
    fallbackOffer = null
  }

  function latchFromReply(reply: Record<string, unknown>, source: 'check' | 'install'): InstallButtonLatch {
    const env = currentEnvPair()
    return {
      code: failureCodeOf(
        { error: reply['error'], errorKind: reply['errorKind'] },
        source === 'install' ? 'install-failed' : 'check-failed',
      ),
      kind:
        typeof reply['errorKind'] === 'string' && (reply['errorKind'] as string).trim()
          ? (reply['errorKind'] as string).trim()
          : null,
      detail: null,
      diag: Object.prototype.hasOwnProperty.call(reply, 'diag') ? reply['diag'] : null,
      requestId: source === 'install' ? requestId : null,
      checkId: source === 'install' ? (receipt?.checkId ?? null) : null,
      runningVersion: snapshot?.runningVersion ?? null,
      installedVersion: snapshot?.installedVersion ?? null,
      latestVersion: snapshot?.latestVersion ?? null,
      targetVersion: jobTargetOf(reply['snapshot']),
      hostKind: env.hostKind,
      profileName: env.profileName,
      source,
      volatile: false,
      atMs: latchNow(),
    }
  }

  function latchFromJob(job: NonNullable<UpdateSnapshot['job']>, snap: UpdateSnapshot | null, replyDiag?: unknown): InstallButtonLatch {
    const env = currentEnvPair()
    const message = typeof job.message === 'string' ? job.message : null
    const detail = message && message.includes(':') ? message.slice(message.indexOf(':') + 1).trim() || null : message
    return {
      code: messageCodeOf(message) || 'install-failed',
      kind: null,
      detail,
      // #156 第四轮：异步失败的事实（包名/归因）由宿主随成功回包的 diag 带回；
      // 既有证据不覆写（#58 单调置入），锁存空着时用本次回包的。
      diag: latch?.diag ?? replyDiag ?? null,
      requestId: job.requestId ?? latch?.requestId ?? requestId,
      checkId: receipt?.checkId ?? latch?.checkId ?? null,
      runningVersion: snap?.runningVersion ?? snapshot?.runningVersion ?? null,
      installedVersion: snap?.installedVersion ?? snapshot?.installedVersion ?? null,
      latestVersion: snap?.latestVersion ?? snapshot?.latestVersion ?? null,
      targetVersion: jobTargetOf({ job }),
      hostKind: env.hostKind ?? latch?.hostKind ?? null,
      profileName: env.profileName ?? latch?.profileName ?? null,
      source: 'install',
      volatile: false,
      atMs: latchNow(),
    }
  }

  function volatileLatch(source: 'check' | 'install'): InstallButtonLatch {
    const env = currentEnvPair()
    return {
      code: 'check-failed',
      kind: null,
      detail: null,
      diag: null,
      requestId,
      checkId: receipt?.checkId ?? null,
      runningVersion: snapshot?.runningVersion ?? null,
      installedVersion: snapshot?.installedVersion ?? null,
      latestVersion: snapshot?.latestVersion ?? null,
      targetVersion: null,
      hostKind: env.hostKind,
      profileName: env.profileName,
      source,
      volatile: true,
      atMs: latchNow(),
    }
  }

  /** #212：日志健康读数只按对象收；undefined（老宿主 / 补读没带）= 不动，非对象 = 清空。 */
  function adoptLogHealth(value: unknown): void {
    envLogHealth = isObject(value) ? (value as unknown as UpdateLogHealth) : null
  }

  // Parity with panel latch rules (#58): readonly polling never clears a
  // non-transient latch; a new round / terminal state yields to fresh evidence.
  function applyStatusReply(reply: Record<string, unknown>, via: 'refresh' | 'check' | 'install'): void {
    if (!isObject(reply)) return
    if (reply['ok'] === true) {
      const s = asSnapshot(reply['snapshot'])
      if (s) snapshot = s
      manual = typeof reply['manual'] === 'string' ? (reply['manual'] as string) : null
      manualSource = manual !== null ? 'frame' : null
      failureRereadDone = false
      if (reply['receipt'] && isObject(reply['receipt']) && typeof reply['receipt']['checkId'] === 'string') {
        receipt = { checkId: reply['receipt']['checkId'] as string }
      }
      const q = asQueue(reply['queue'])
      if (q) queue = q
      const env = reply['env']
      if (isObject(env)) {
        const pn = env['profileName']
        const hk = env['environmentKind']
        if (typeof pn === 'string' && pn.trim()) envProfileName = pn.trim()
        if (typeof hk === 'string' && hk.trim()) envHostKind = hk.trim()
      }
      // #212：日志健康（与面板 adoptLogHealth 同口径：缺省不动，非对象清空；只在成功回包里带）。
      if (reply['logHealth'] !== undefined) adoptLogHealth(reply['logHealth'])
      const jobState = snapshot?.job?.state ?? null
      if (jobState === 'installing' || jobState === 'verifying') {
        clearLatch()
      } else if (jobState === 'completed' || jobState === 'restart-required') {
        clearLatch()
      } else if ((jobState === 'failed' || jobState === 'interrupted') && snapshot?.job) {
        // #156 第四轮：异步失败的事实（包名/归因）随本次回包的 diag 一起来，锁存空着时收下。
        const next = latchFromJob(snapshot.job, snapshot, isObject(reply['diag']) ? reply['diag'] : null)
        if (
          !latch ||
          latch.volatile ||
          latch.code !== next.code ||
          latch.targetVersion !== next.targetVersion ||
          latch.latestVersion !== next.latestVersion
        ) {
          setLatch(next)
        }
      } else if (via === 'install') {
        clearLatch()
      } else if (via === 'check' && latch?.source === 'check') {
        clearLatch()
      } else if (latch?.volatile) {
        clearLatch()
      }
    } else {
      const kindText = typeof reply['errorKind'] === 'string' ? reply['errorKind'].trim() : ''
      const errText = typeof reply['error'] === 'string' ? reply['error'].trim() : ''
      if ((kindText || errText) !== 'update-busy') {
        setLatch(latchFromReply(reply, via === 'install' ? 'install' : 'check'))
        // #177：失败回包里的命令只是上一帧沿用值 —— fail-closed，等补读确认为当帧。
        manualSource = manual ? 'carried-over' : null
        scheduleFailureReread()
      }
      try {
        const env = reply['env']
        if (isObject(env)) {
          const pn = env['profileName']
          const hk = env['environmentKind']
          if (typeof pn === 'string' && pn.trim()) envProfileName = pn.trim()
          if (typeof hk === 'string' && hk.trim()) envHostKind = hk.trim()
        }
      } catch {
        // Failed-reply env is optional.
      }
      try {
        const q = asQueue(reply['queue'])
        if (q) queue = q
      } catch {
        // Failed-reply queue view is optional.
      }
    }
  }

  /**
   * #177 D3：失败回包后的静默补读（只一次）。
   * 只发一次只读 updateStatus：成功才按当帧应用（manual 恢复 frame）并重绘；失败静默，
   * 不写失败锁存、不重试、不制造新的失败帧。成功回包会重置闸门，给下一次失败留同一次机会。
   */
  function scheduleFailureReread(): void {
    if (failureRereadDone || !mounted) return
    failureRereadDone = true
    void (async () => {
      try {
        const reply = await call(phoneNames.updateStatus, queueArgs())
        if (!mounted) return
        if (!isObject(reply) || reply['ok'] !== true) return
        // 补读只补当帧读数（快照 / 命令 / 队列），不跑成功回包的锁存规则——失败帧原样保留。
        const s = asSnapshot(reply['snapshot'])
        if (s) snapshot = s
        manual = typeof reply['manual'] === 'string' ? (reply['manual'] as string) : null
        manualSource = manual !== null ? 'frame' : null
        const q = asQueue(reply['queue'])
        if (q) queue = q
        if (reply['logHealth'] !== undefined) adoptLogHealth(reply['logHealth'])
        paint()
      } catch {
        // 静默：补读只是最后一次读数机会；不写锁存、不重试。
      }
    })()
  }

  function queueArgs(): Record<string, unknown> {
    return { includeQueue: true, includeEnv: true, showOthers, ...(requestId ? { requestId } : {}) }
  }

  function currentView(): InstallButtonView {
    return installButtonViewModel({
      snapshot,
      manual,
      queue,
      lastError: latch?.code ?? null,
      errorKind: latch?.kind ?? null,
      errorDetail: latch?.detail ?? null,
      errorDiag: latch?.diag ?? null,
      pluginId,
      fallbackOffer: fallbackOffer ? { candidate: fallbackOffer.candidate, targetVersion: fallbackOffer.targetVersion } : null,
      busyAct,
      pollCapped,
      lang: currentLang(),
    })
  }

  function paint(): void {
    if (!mounted) return
    try {
      if (copyNotice && noticeExpiresAt && Date.now() > noticeExpiresAt) {
        copyNotice = null
        noticeExpiresAt = 0
      }
      const lang = currentLang()
      const view = currentView()
      const html = renderInstallButtonHTML(view, {
        manual,
        notice: copyNotice,
        theme,
        lang,
        manualSource,
        // #174：最后手段判定要失败码；槽位自己的失败锁存就是当帧码。
        failureCode: latch?.code ?? null,
        // #156 合规版救援在槽位表现为兜底按钮出现——有救援就不判最后手段。
        fallbackAvailable: view.fallbackStage !== null,
        registered: snapshot?.registered ?? null,
        bubble: copyBubble,
      })
      try {
        container.innerHTML = html
      } catch {
        // Container write failure never blocks install.
      }
    } catch (err) {
      // #214: paint failures keep the phase + fingerprint; the same storm logs at most one row per minute.
      emitRenderFail('paint', 'render', errorTextOf(err) || 'render-failed')
    }
  }

  function sayCopyKey(key: BilingualKey, params?: Record<string, string>): void {
    try {
      copyNotice = copyText(key, currentLang(), params)
      noticeExpiresAt = Date.now() + 5000
    } catch {
      copyNotice = null
      noticeExpiresAt = 0
    }
  }

  /** 复制成功气泡：量按钮矩形、fixed 定位；量不到就落在左上角兜底，绝不因缺坐标不给反馈。 */
  function showCopyBubble(anchor: unknown): void {
    if (copyBubbleTimer !== null) {
      try { clearTimeout(copyBubbleTimer) } catch { /* 忽略 */ }
      copyBubbleTimer = null
    }
    let left = 0
    let top = 0
    try {
      const el = anchor as { getBoundingClientRect?: () => { left?: unknown; top?: unknown; width?: unknown } } | null
      const rect = el && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null
      if (rect) {
        const l = Number(rect.left)
        const t = Number(rect.top)
        const w = Number(rect.width)
        if (Number.isFinite(l)) left = l + (Number.isFinite(w) ? w / 2 : 0)
        if (Number.isFinite(t)) top = t - 6
      }
    } catch { left = 0; top = 0 }
    try {
      copyBubble = { text: copyText('panel.lastresort.copied', currentLang()), left, top }
    } catch { copyBubble = null }
    try {
      copyBubbleTimer = setTimeout(() => {
        copyBubbleTimer = null
        copyBubble = null
        if (mounted) paint()
      }, 1400)
    } catch { copyBubbleTimer = null }
  }

  async function refresh(): Promise<void> {
    if (!mounted) return
    try {
      const reply = await call(phoneNames.updateStatus, queueArgs())
      if (!mounted) return
      transportFailStreak = 0
      applyStatusReply(reply, 'refresh')
    } catch (err) {
      if (!mounted) return
      // #214: a transport failure now leaves evidence (streak + fingerprint), not just a latch.
      transportFailStreak++
      emitRenderFail('poll', 'transport', errorTextOf(err) || 'transport-failed')
      if (!thrownBusy(err)) setLatch(volatileLatch('check'))
    }
    if (!mounted) return
    if (autoCheck !== 'never' && !busyAct && !ensuring && snapshot && !snapshot.latestVersion) {
      ensuring = true
      try {
        const reply = await call(phoneNames.updateCheck, queueArgs())
        if (!mounted) return
        transportFailStreak = 0
        applyStatusReply(reply, 'check')
      } catch (err) {
        if (!mounted) return
        transportFailStreak++
        emitRenderFail('poll', 'transport', errorTextOf(err) || 'transport-failed')
        setLatch(volatileLatch('check'))
      } finally {
        ensuring = false
      }
    }
    paint()
  }

  function jobActive(): boolean {
    const st = snapshot?.job?.state ?? null
    return st === 'installing' || st === 'verifying'
  }

  async function doCheck(): Promise<void> {
    try {
      const reply = await call(phoneNames.updateCheck, queueArgs())
      if (!mounted) return
      applyStatusReply(reply, 'check')
    } catch (err) {
      if (!mounted) return
      if (thrownBusy(err)) {
        // Busy is transient: pull the fresh queue view instead of latching.
        await refresh()
        return
      }
      const env = currentEnvPair()
      setLatch({
        code: 'check-failed',
        kind: null,
        detail: thrownDetail(err),
        diag: null,
        requestId: null,
        checkId: null,
        runningVersion: snapshot?.runningVersion ?? null,
        installedVersion: snapshot?.installedVersion ?? null,
        latestVersion: snapshot?.latestVersion ?? null,
        targetVersion: null,
        hostKind: env.hostKind,
        profileName: env.profileName,
        source: 'check',
        volatile: false,
        atMs: latchNow(),
      })
    }
  }

  async function doInstall(): Promise<void> {
    // At most one silent renewal (#150): a rejected checkId is re-checked and
    // retried once with the fresh receipt; anything else latches as before.
    // A successful check without a receipt means the snapshot itself carries
    // the true story (blocked / nothing to do) — never synthesize check-expired.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!receipt) {
        const prevLatch = latch
        try {
          const checked = await call(phoneNames.updateCheck, queueArgs())
          if (!mounted) return
          applyStatusReply(checked, 'check')
        } catch (err) {
          if (!mounted) return
          if (thrownBusy(err)) {
            await refresh()
            return
          }
          const env = currentEnvPair()
          setLatch({
            code: 'check-failed',
            kind: null,
            detail: thrownDetail(err),
            diag: null,
            requestId: null,
            checkId: null,
            runningVersion: snapshot?.runningVersion ?? null,
            installedVersion: snapshot?.installedVersion ?? null,
            latestVersion: snapshot?.latestVersion ?? null,
            targetVersion: null,
            hostKind: env.hostKind,
            profileName: env.profileName,
            source: 'check',
            volatile: false,
            atMs: latchNow(),
          })
          return
        }
        if (!mounted) return
        if (!receipt) {
          // 新查已有结论：没被本轮查换掉的锁存是旧结论，清掉让快照说话；
          // 本轮刚派生的 job 失败锁存原样保留。
          if (latch === prevLatch) clearLatch()
          return
        }
      }
      if (!mounted) return
      requestId = randomRequestId()
      pollCount = 0
      pollCapped = false
      let reply: Record<string, unknown>
      try {
        reply = await call(phoneNames.updateInstall, {
          checkId: receipt.checkId,
          requestId,
          from: installSource,
          ...queueArgs(),
        })
      } catch (err) {
        if (!mounted) return
        if (thrownBusy(err)) {
          await refresh()
          return
        }
        if (thrownIsCheckExpired(err) && attempt === 0) {
          receipt = null
          continue
        }
        const env = currentEnvPair()
        setLatch({
          code: 'install-failed',
          kind: null,
          detail: thrownDetail(err),
          diag: null,
          requestId,
          checkId: receipt?.checkId ?? null,
          runningVersion: snapshot?.runningVersion ?? null,
          installedVersion: snapshot?.installedVersion ?? null,
          latestVersion: snapshot?.latestVersion ?? null,
          targetVersion: null,
          hostKind: env.hostKind,
          profileName: env.profileName,
          source: 'install',
          volatile: false,
          atMs: latchNow(),
        })
        return
      }
      if (!mounted) return
      // 先判过期再应用：attempt 0 的过期回包直接续查，不锁存、不闪失败。
      if (replyIsCheckExpired(reply) && attempt === 0) {
        receipt = null
        continue
      }
      applyStatusReply(reply, 'install')
      return
    }
  }

  function diagText(): string | null {
    if (!latch || latch.volatile) return null
    try {
      return buildUpdateDiagCopy(
        {
          pluginId,
          code: latch.code,
          detail: latch.detail,
          runningVersion: latch.runningVersion,
          installedVersion: latch.installedVersion,
          latestVersion: latch.latestVersion,
          hostKind: latch.hostKind,
          profileName: latch.profileName,
          queuePosition: queue && typeof queue.position === 'number' ? queue.position : null,
          requestId: latch.requestId,
          manual,
          targetVersion: latch.targetVersion,
          diag: latch.diag,
          checkId: latch.checkId,
          logHealth: envLogHealth,
          transportFailStreak,
          clientDropped: clientDroppedRows(),
          lang: currentLang(),
        },
        currentLang(),
      )
    } catch {
      return null
    }
  }

  async function act(
    kind: 'install' | 'check' | 'copy-manual' | 'copy-diag' | 'install-fallback' | 'install-fallback-confirm' | 'wait-latest',
    anchor: unknown = null,
  ): Promise<void> {
    if (!mounted) return
    const startedAtMs = Date.now()
    copyAnchorEl = anchor
    actionBytes = -1
    actionTruncated = false
    actionSkipped = false
    const latchBefore = latch
    let ok = true
    let errorKind: string | null = null
    let errorHash: string | null = null
    try {
      await runAction(kind)
    } catch (err) {
      ok = false
      errorKind = 'thrown'
      errorHash = hash8(errorTextOf(err))
      throw err
    } finally {
      if (ok) {
        const latchAfter = latch
        if (latchAfter && latchAfter !== latchBefore) {
          ok = false
          errorKind = latchAfter.code
          errorHash = hash8(`${latchAfter.code}|${latchAfter.detail ?? ''}`)
        } else if (actionSkipped) {
          ok = false
          errorKind = 'busy'
        }
      }
      logClient('info', 'update.panel.action', {
        action: kind,
        ok,
        errorKind,
        durationMs: Math.max(0, Date.now() - startedAtMs),
        ...(errorHash ? { errorHash } : {}),
        ...(actionBytes >= 0 ? { bytes: actionBytes, truncated: actionTruncated } : {}),
      })
    }
  }

  /**
   * 合规版决议（#156）：点"装合规版"本身不装任何东西——先认证据，再问决议，
   * 有候选才给点名版本的二次确认按钮。与 panel.ts 同口径（入参/解析/退化），
   * 老宿主没有这条电话即退化"只呈现"，面板不碎。
   */
  async function doFallbackResolve(): Promise<void> {
    if (!latch) {
      sayCopyKey('panel.toast.fallback-unavailable')
      paint()
      return
    }
    const cause = fallbackCauseFromDetail(latch.detail, latch.code, pluginId)
    if (!cause || cause.targetVersion !== (latch.latestVersion ?? snapshot?.latestVersion ?? null)) {
      sayCopyKey('panel.toast.fallback-unavailable')
      paint()
      return
    }
    busyAct = 'fallback'
    paint()
    try {
      let reply: unknown
      try {
        reply = await call(phoneNames.updateCheckFallback, {
          kind: cause.kind,
          blame: 'target',
          targetVersion: cause.targetVersion,
          ...(typeof cause.windowMs === 'number' ? { windowMs: cause.windowMs } : {}),
          windowSource: cause.windowSource,
          ...(typeof cause.publishedAtMs === 'number' ? { publishedAtMs: cause.publishedAtMs } : {}),
        })
      } catch {
        reply = null
      }
      if (!mounted) return
      if (!isObject(reply) || reply['ok'] === false) {
        sayCopyKey('panel.toast.fallback-unavailable')
        paint()
        return
      }
      const snap = isObject(reply['snapshot']) ? (reply['snapshot'] as Record<string, unknown>) : null
      const verdict = snap && isObject(snap['verdict']) ? (snap['verdict'] as Record<string, unknown>) : null
      const vKind = verdict && typeof verdict['kind'] === 'string' ? (verdict['kind'] as string) : ''
      const vVersion = verdict && typeof verdict['version'] === 'string' ? (verdict['version'] as string).trim() : ''
      const snapCandidate = snap && typeof snap['candidate'] === 'string' ? (snap['candidate'] as string).trim() : ''
      const rec = isObject(reply['receipt']) ? (reply['receipt'] as Record<string, unknown>) : null
      const gotCheckId = rec && typeof rec['checkId'] === 'string' ? (rec['checkId'] as string) : ''
      const candidate = snapCandidate || (vKind === 'ok-now' ? vVersion : '')
      if ((vKind === 'downgrade-available' || vKind === 'ok-now') && candidate && gotCheckId) {
        fallbackOffer = { candidate, checkId: gotCheckId, targetVersion: cause.targetVersion }
      } else if (vKind === 'wait-until') {
        const unlockAt = verdict && typeof verdict['unlockAtMs'] === 'number' ? (verdict['unlockAtMs'] as number) : null
        const time = typeof unlockAt === 'number' ? (formatUnlockAt(unlockAt, currentLang()) ?? null) : null
        if (time) sayCopyKey('panel.toast.fallback-wait', { time })
        else sayCopyKey('panel.toast.fallback-unavailable')
      } else {
        sayCopyKey('panel.toast.fallback-unavailable')
      }
    } finally {
      busyAct = null
    }
    paint()
  }

  /**
   * 二次确认（#156）：按钮文案即决议点名的精确版本——用户先看见再点，不存在静默装旧版。
   * 决议凭证过期即退回重决议，不锁存不硬装（与 panel.ts 同口径）。
   */
  async function doFallbackConfirm(): Promise<void> {
    if (!fallbackOffer) return
    const offer = fallbackOffer
    busyAct = 'install'
    copyNotice = copyText('panel.toast.installing', currentLang())
    paint()
    try {
      requestId = randomRequestId()
      pollCount = 0
      pollCapped = false
      let reply: Record<string, unknown>
      try {
        reply = await call(phoneNames.updateInstall, {
          checkId: offer.checkId,
          requestId,
          version: offer.candidate,
          from: installSource,
          ...queueArgs(),
        })
      } catch (err) {
        if (!mounted) return
        fallbackOffer = null
        if (thrownIsCheckExpired(err)) {
          sayCopyKey('panel.toast.fallback-unavailable')
          paint()
          return
        }
        const env = currentEnvPair()
        setLatch({
          code: 'install-failed',
          kind: null,
          detail: thrownDetail(err),
          diag: null,
          requestId,
          checkId: offer.checkId,
          runningVersion: snapshot?.runningVersion ?? null,
          installedVersion: snapshot?.installedVersion ?? null,
          latestVersion: snapshot?.latestVersion ?? null,
          targetVersion: null,
          hostKind: env.hostKind,
          profileName: env.profileName,
          source: 'install',
          volatile: false,
          atMs: latchNow(),
        })
        paint()
        return
      }
      if (!mounted) return
      fallbackOffer = null
      if (replyIsCheckExpired(reply)) {
        sayCopyKey('panel.toast.fallback-unavailable')
        paint()
        return
      }
      applyStatusReply(reply, 'install')
    } finally {
      busyAct = null
    }
    paint()
  }

  async function runAction(
    kind: 'install' | 'check' | 'copy-manual' | 'copy-diag' | 'install-fallback' | 'install-fallback-confirm' | 'wait-latest',
  ): Promise<void> {
    copyNotice = null
    switch (kind) {
      case 'check': {
        if (busyAct) {
          actionSkipped = true
          return
        }
        busyAct = 'check'
        copyNotice = copyText('panel.toast.checking', currentLang())
        paint()
        try {
          await doCheck()
        } finally {
          busyAct = null
        }
        paint()
        return
      }
      case 'install': {
        if (busyAct) {
          actionSkipped = true
          return
        }
        busyAct = 'install'
        copyNotice = copyText('panel.toast.installing', currentLang())
        paint()
        try {
          await doInstall()
        } finally {
          busyAct = null
        }
        paint()
        return
      }
      case 'copy-manual': {
        // #177：只复制当帧可信的命令（遗留值连按钮都没有，这里再守一道）。
        if (manual && manualSource === 'frame') {
          try {
            await copyTextOut(manual)
            // v1.3：成功不改按钮文案/图标，只在按钮上方浮出「已复制」气泡（不另发 toast，避免双重反馈）。
            showCopyBubble(copyAnchorEl)
          } catch {
            sayCopyKey('panel.toast.copy-manual-fail')
          }
        }
        copyAnchorEl = null
        paint()
        return
      }
      case 'copy-diag': {
        const text = diagText()
        if (text) {
          try {
            await copyTextOut(text)
            sayCopyKey('panel.toast.copy-diag-ok')
          } catch {
            sayCopyKey('panel.toast.copy-diag-fail')
          }
          actionBytes = utf8ByteLength(text)
          actionTruncated = false
        }
        paint()
        return
      }
      case 'install-fallback': {
        // 决议本身不装任何东西：busyAct 守卫内由 doFallbackResolve 自理。
        if (busyAct) {
          actionSkipped = true
          return
        }
        await doFallbackResolve()
        return
      }
      case 'install-fallback-confirm': {
        if (busyAct) {
          actionSkipped = true
          return
        }
        if (!fallbackOffer) return
        await doFallbackConfirm()
        return
      }
      case 'wait-latest': {
        // 等新版：与 panel 同效果——只清锁存与决议，不调电话、不写跳过。
        fallbackOffer = null
        clearLatch()
        sayCopyKey('panel.toast.failure-dismissed')
        paint()
        return
      }
    }
  }

  function onClick(ev: unknown): void {
    try {
      const t = ev as { target?: { closest?: (sel: string) => { getAttribute?: (k: string) => string | null } | null } | null } | null
      const btn = t?.target && typeof t.target.closest === 'function' ? t.target.closest('[data-action]') : null
      const kind = btn?.getAttribute ? btn.getAttribute('data-action') : null
      if (
        kind !== 'install' &&
        kind !== 'check' &&
        kind !== 'copy-manual' &&
        kind !== 'copy-diag' &&
        kind !== 'install-fallback' &&
        kind !== 'install-fallback-confirm' &&
        kind !== 'wait-latest'
      )
        return
      void act(kind, btn ?? null)
    } catch {
      // Click failure never blocks install.
    }
  }

  function unmount(): void {
    if (!mounted) return
    mounted = false
    removeGlobalHandlers?.()
    removeGlobalHandlers = null
    try {
      unsubLang()
    } catch {
      // Best effort.
    }
    try {
      timer.clear(handle)
    } catch {
      // Poll timer is view-only; install keeps running host-side.
    }
    if (copyBubbleTimer !== null) {
      try { clearTimeout(copyBubbleTimer) } catch { /* 忽略 */ }
      copyBubbleTimer = null
    }
    try {
      container.removeEventListener?.('click', onClick)
    } catch {
      // Best effort.
    }
    if (clientLogOwned && clientLog) {
      try {
        clientLog.dispose()
      } catch {
        // Best effort.
      }
    }
    // Unmount stops polling only: never calls install/cancel phones.
  }

  const unsubLang = subscribeLang(
    () => {
      paint()
    },
    localeOpt,
  )
  paint()
  try {
    container.addEventListener?.('click', onClick)
  } catch {
    // Containers without event support still render (controller drives actions).
  }
  // #214 global fallback (progressive): register only where addEventListener exists; unmount removes.
  installGlobalHandlers()
  const timer = getTimer()
  const handle = timer.set(() => {
    if (!mounted || busyAct || pollCapped) return
    if (!jobActive()) return
    if (pollCount >= INSTALL_BUTTON_MAX_POLLS) {
      pollCapped = true
      try {
        timer.clear(handle)
      } catch {
        // Best effort.
      }
      paint()
      return
    }
    pollCount += 1
    void refresh()
  }, pollMs)
  if (autoCheck === 'mount') {
    void refresh()
  }

  function state(): ReturnType<InstallButtonController['state']> {
    const jobState = snapshot?.job?.state ?? null
    return {
      snapshot,
      manual,
      queue,
      failedCode: latch && !latch.volatile ? latch.code : null,
      busy: !!busyAct || jobState === 'installing' || jobState === 'verifying',
    }
  }

  logClient('info', 'update.panel.mount', {
    mode: clientLogMountName || 'install-button',
    theme,
    lang: currentLang(),
    pollMs,
  })

  return { state, refresh, unmount }
}
