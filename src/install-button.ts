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
  isCheckSideFailureCode,
  messageCodeOf,
  panelViewModel,
  redactForCopy,
  replyIsCheckExpired,
  themeTokensStyleFor,
  thrownIsCheckExpired,
  type UpdatePanelClientLogOptions,
  type UpdateThemeTokens,
} from './panel.js'
import { createClientLogChannel, type ClientLogChannel } from './log/client-queue.js'
import type { UpdateSnapshot } from './ports.js'
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
  busyAct: 'check' | 'install' | null
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
  '.dsh-upd-ib button{cursor:pointer}',
  '.dsh-upd-ib button[disabled]{cursor:default}',
  '.dsh-upd-ib-manual summary{cursor:pointer}',
  '.dsh-upd-ib-manual code{display:block;white-space:pre-wrap;overflow-wrap:anywhere}',
  '.dsh-upd-ib-notice{opacity:.8}',
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
    }
  }
  if (input.busyAct === 'check' || input.busyAct === 'install' || jobActive) {
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
    }
  }
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
  }
}

export function renderInstallButtonHTML(
  view: InstallButtonView,
  opts: { manual: string | null; notice: string | null; theme: 'default' | 'archive'; lang: AppLang },
): string {
  const l = opts.lang
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
  if (view.showManual && opts.manual) {
    parts.push(
      '<details class="dsh-upd-ib-manual"><summary>' +
        escapeHtml(copyText('panel.chapter.manual', l)) +
        '</summary><code>' +
        escapeHtml(opts.manual) +
        '</code><button type="button" data-action="copy-manual" title="' +
        escapeHtml(copyText('panel.action.copy-manual-title', l)) +
        '">' +
        escapeHtml(copyText('panel.action.copy-manual', l)) +
        '</button></details>',
    )
  }
  if (opts.notice) {
    parts.push('<div class="dsh-upd-ib-notice" role="status">' + escapeHtml(opts.notice) + '</div>')
  }
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
  function logMountFailure(kind: string): void {
    logClient('error', 'update.panel.render.fail', { kind })
  }
  if (!container || typeof container.innerHTML !== 'string') {
    logMountFailure('container')
    throw new Error('[dsh-plugin-update] install button needs a container with innerHTML')
  }
  if (!options || typeof options !== 'object') {
    logMountFailure('plugin-id')
    throw new Error('[dsh-plugin-update] install button needs options: pluginId is required')
  }
  const pluginId = options.pluginId
  if (typeof pluginId !== 'string' || !pluginId) {
    logMountFailure('plugin-id')
    throw new Error(`[dsh-plugin-update] install button needs pluginId: non-empty string (got ${JSON.stringify(pluginId)})`)
  }
  if (typeof options.call !== 'function') {
    logMountFailure('call')
    throw new Error('[dsh-plugin-update] install button needs call (the only channel to host phones)')
  }
  const prefix = options.prefix === undefined ? DEFAULT_PREFIX : options.prefix
  let phoneNames: ReturnType<typeof buildPhoneNames>
  try {
    phoneNames = buildPhoneNames(prefix)
  } catch (err) {
    logMountFailure('prefix')
    throw err
  }
  if (!clientLog && !clientLogDisabled) {
    try {
      clientLog = createClientLogChannel({ call: options.call, phoneName: buildLogAppendPhoneName(prefix) })
      clientLogOwned = true
    } catch {
      clientLog = null
    }
  }
  const pollMs = options.pollMs === undefined ? DEFAULT_PANEL_POLL_MS : options.pollMs
  if (typeof pollMs !== 'number' || !Number.isFinite(pollMs) || pollMs < MIN_PANEL_POLL_MS) {
    logMountFailure('poll-ms')
    throw new Error(`[dsh-plugin-update] install button pollMs must be >= 250ms (got ${JSON.stringify(options.pollMs)})`)
  }
  const autoCheck = options.autoCheck ?? 'mount'
  if (autoCheck !== 'mount' && autoCheck !== 'never') {
    logMountFailure('auto-check')
    throw new Error(`[dsh-plugin-update] install button autoCheck must be mount or never (got ${JSON.stringify(options.autoCheck)})`)
  }
  if (options.theme !== undefined && options.theme !== 'default' && options.theme !== 'archive') {
    logMountFailure('theme')
    throw new Error(`[dsh-plugin-update] install button theme must be default or archive (got ${JSON.stringify(options.theme)})`)
  }
  const theme = options.theme ?? 'default'
  try {
    themeTokensStyleFor(options.themeTokens ?? undefined)
  } catch (err) {
    logMountFailure('theme-tokens')
    throw err
  }
  const localeOpt: LocaleOption = options.locale ?? undefined
  if (localeOpt !== undefined && localeOpt !== null) {
    const isStr = typeof localeOpt === 'string'
    const isObj = typeof localeOpt === 'object' && typeof (localeOpt as { getActive?: unknown }).getActive === 'function'
    if (!isStr && !isObj) {
      logMountFailure('locale')
      throw new Error('[dsh-plugin-update] invalid locale: expected zh / en / BCP47 or { getActive(), subscribe? }')
    }
    if (isStr && !(localeOpt as string).trim()) {
      logMountFailure('locale')
      throw new Error('[dsh-plugin-update] invalid locale: empty string')
    }
  }
  function currentLang(): AppLang {
    return resolveLang(localeOpt)
  }
  const showOthers = options.showOthers === true
  const profileNameOption = typeof options.profileName === 'string' && options.profileName ? options.profileName : null
  const copyTextOut = options.copyText ?? defaultCopyText
  const call = options.call

  let mounted = true
  let snapshot: UpdateSnapshot | null = null
  let manual: string | null = null
  let queue: VisibleQueue | null = null
  let receipt: { checkId: string } | null = null
  let requestId: string | null = null
  let latch: InstallButtonLatch | null = null
  let busyAct: 'check' | 'install' | null = null
  let ensuring = false
  let pollCount = 0
  let pollCapped = false
  let envHostKind: string | null = null
  let envProfileName: string | null = null
  let copyNotice: string | null = null
  let noticeExpiresAt = 0
  let actionBytes = -1
  let actionTruncated = false

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
  }

  // #150 判据单源：过期凭证的回包/抛错判定复用 panel.ts 的同名导出（本文件不再自存一份）。

  function clearLatch(): void {
    latch = null
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

  function latchFromJob(job: NonNullable<UpdateSnapshot['job']>, snap: UpdateSnapshot | null): InstallButtonLatch {
    const env = currentEnvPair()
    const message = typeof job.message === 'string' ? job.message : null
    const detail = message && message.includes(':') ? message.slice(message.indexOf(':') + 1).trim() || null : message
    return {
      code: messageCodeOf(message) || 'install-failed',
      kind: null,
      detail,
      diag: latch?.diag ?? null,
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

  // Parity with panel latch rules (#58): readonly polling never clears a
  // non-transient latch; a new round / terminal state yields to fresh evidence.
  function applyStatusReply(reply: Record<string, unknown>, via: 'refresh' | 'check' | 'install'): void {
    if (!isObject(reply)) return
    if (reply['ok'] === true) {
      const s = asSnapshot(reply['snapshot'])
      if (s) snapshot = s
      manual = typeof reply['manual'] === 'string' ? (reply['manual'] as string) : null
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
      const jobState = snapshot?.job?.state ?? null
      if (jobState === 'installing' || jobState === 'verifying') {
        clearLatch()
      } else if (jobState === 'completed' || jobState === 'restart-required') {
        clearLatch()
      } else if ((jobState === 'failed' || jobState === 'interrupted') && snapshot?.job) {
        const next = latchFromJob(snapshot.job, snapshot)
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
      const html = renderInstallButtonHTML(view, { manual, notice: copyNotice, theme, lang })
      try {
        container.innerHTML = html
      } catch {
        // Container write failure never blocks install.
      }
    } catch {
      logClient('error', 'update.panel.render.fail', { kind: 'unknown' })
    }
  }

  function sayCopyKey(key: BilingualKey): void {
    try {
      copyNotice = copyText(key, currentLang())
      noticeExpiresAt = Date.now() + 5000
    } catch {
      copyNotice = null
      noticeExpiresAt = 0
    }
  }

  async function refresh(): Promise<void> {
    if (!mounted) return
    try {
      const reply = await call(phoneNames.updateStatus, queueArgs())
      if (!mounted) return
      applyStatusReply(reply, 'refresh')
    } catch (err) {
      if (!mounted) return
      if (!thrownBusy(err)) setLatch(volatileLatch('check'))
    }
    if (!mounted) return
    if (autoCheck !== 'never' && !busyAct && !ensuring && snapshot && !snapshot.latestVersion) {
      ensuring = true
      try {
        const reply = await call(phoneNames.updateCheck, queueArgs())
        if (!mounted) return
        applyStatusReply(reply, 'check')
      } catch {
        if (!mounted) return
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
          lang: currentLang(),
        },
        currentLang(),
      )
    } catch {
      return null
    }
  }

  async function act(kind: 'install' | 'check' | 'copy-manual' | 'copy-diag'): Promise<void> {
    if (!mounted) return
    actionBytes = -1
    actionTruncated = false
    try {
      await runAction(kind)
    } finally {
      logClient('info', 'update.panel.action', {
        action: kind,
        ...(actionBytes >= 0 ? { bytes: actionBytes, truncated: actionTruncated } : {}),
      })
    }
  }

  async function runAction(kind: 'install' | 'check' | 'copy-manual' | 'copy-diag'): Promise<void> {
    copyNotice = null
    switch (kind) {
      case 'check': {
        if (busyAct) return
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
        if (busyAct) return
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
        if (manual) {
          try {
            await copyTextOut(manual)
            sayCopyKey('panel.toast.copy-manual-ok')
          } catch {
            sayCopyKey('panel.toast.copy-manual-fail')
          }
        }
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
    }
  }

  function onClick(ev: unknown): void {
    try {
      const t = ev as { target?: { closest?: (sel: string) => { getAttribute?: (k: string) => string | null } | null } | null } | null
      const btn = t?.target && typeof t.target.closest === 'function' ? t.target.closest('[data-action]') : null
      const kind = btn?.getAttribute ? btn.getAttribute('data-action') : null
      if (kind !== 'install' && kind !== 'check' && kind !== 'copy-manual' && kind !== 'copy-diag') return
      void act(kind)
    } catch {
      // Click failure never blocks install.
    }
  }

  function unmount(): void {
    if (!mounted) return
    mounted = false
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
