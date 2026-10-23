/**
 * src/core/install-button/mount.ts —— 挂载装配（双角色按钮/锁存/有界轮询/日志，#221 自旧 src/install-button.ts 拆出）。
 *
 * 本文件只做装配：判定仍走 panel 纯函数，视图走 ./view.ts，渲染走 ./render.ts。
 * 浏览器安全：零 `node:` 导入。
 */
import {
  buildLogAppendPhoneName,
  buildPhoneNames,
  DEFAULT_PANEL_POLL_MS,
  DEFAULT_PREFIX,
  MIN_PANEL_POLL_MS,
} from '../../shared/config.js'
import { copyText } from '../../core/i18n/text.js'
import type { BilingualKey } from '../../core/i18n/dictionary.js'
import {
  resolveLang,
  subscribeLang,
  type AppLang,
  type LocaleOption,
} from '../../shared/lang.js'
import {
  buildUpdateDiagCopy,
  failureCodeOf,
  fallbackCauseFromDetail,
  messageCodeOf,
  redactForCopy,
  replyIsCheckExpired,
  themeTokensStyleFor,
  thrownIsCheckExpired,
  type UpdatePanelClientLogOptions,
} from '../../panel.js'
import { formatUnlockAt } from '../../core/cause.js'
import { failureSettledOf, settledClearsLatch } from '../../shared/failure-settled.js'
import { hash8 } from '../../shared/hash.js'
import type { ManualSource } from '../../shared/last-resort.js'
import { createClientLogChannel, type ClientLogChannel } from '../../log/client-queue.js'
// #212：只借类型（浏览器侧不许运行时引 ./log 的 Node 模块；类型导入编译即抹掉）。
import type { UpdateLogHealth } from '../../log/health.js'
import type { InstallSource, UpdateSnapshot } from '../../shared/ports.js'
import type { VisibleQueue } from '../../core/queue/model.js'
import type {
  InstallButtonContainer,
  InstallButtonController,
  InstallButtonOptions,
  InstallButtonView,
} from '../../install-button.js'
import {
  asQueue,
  asSnapshot,
  defaultCopyText,
  getTimer,
  isObject,
  jobTargetOf,
  randomRequestId,
  utf8ByteLength,
} from './widgets.js'
import { installButtonViewModel } from './view.js'
import { renderInstallButtonHTML } from './render.js'

/** 默认轮询口径（与 panel 同源；#221 自旧文件随挂载段迁入，入口壳 re-export 保持公开面不变）。 */
export const INSTALL_BUTTON_POLL = {
  defaultMs: DEFAULT_PANEL_POLL_MS,
  minMs: MIN_PANEL_POLL_MS,
} as const

/** 有界轮询上限（约 5 分钟 @ 默认 1 秒；到顶停轮询转重查态，安装在宿主侧继续）。 */
export const INSTALL_BUTTON_MAX_POLLS = 300

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
    // Mount has failed: push the evidence out, then drop the self-built channel (no leaked listener).
    const channel = clientLog
    if (!channel) return
    try {
      void Promise.resolve(channel.flush())
        .catch(() => undefined)
        .then(() => {
          if (clientLogOwned) channel.dispose()
        })
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
  // #211 AC-2：挂载行的 autoCheck 记**事实**（挂载后自动检查到底跑没跑），所以这行
  // 要等首刷（以及随之的自动查）落定才发；这里记首刷给出的判定，挂载代码在 refresh
  // 的 Promise 落定后取它落行。null = 首刷还没落定（或挂载已拆，不补发）。
  let mountAutoCheckState: 'started' | 'recent' | 'failed' | 'disabled' | null = null
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
  /** #214: per-call "rejected while busy" marker, so overlapping controller.act() calls don't share state. */
  let currentActionSkips: { skipped: boolean } | null = null

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
        // #245：失败任务已被版本证据结算（目标版本确在跑）→ 旧失败是历史账本：
        // 装侧失败锁存就地解除且不再重建；查侧锁存（读/联网失败）是当下证据，仍循 #58 不动。
        if (failureSettledOf(snapshot)) {
          if (settledClearsLatch(latch)) clearLatch()
        } else {
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
    let refreshFailed = false
    try {
      const reply = await call(phoneNames.updateStatus, queueArgs())
      if (!mounted) return
      transportFailStreak = 0
      applyStatusReply(reply, 'refresh')
    } catch (err) {
      if (!mounted) return
      refreshFailed = true
      // #214: a transport failure now leaves evidence (streak + fingerprint), not just a latch.
      transportFailStreak++
      emitRenderFail('poll', 'transport', errorTextOf(err) || 'transport-failed')
      if (!thrownBusy(err)) setLatch(volatileLatch('check'))
    }
    if (!mounted) return
    // #211 AC-2：首刷同时给出「这次挂载的自动检查到底跑没跑」的事实（install-button 的
    // 自动查只在首刷拿不到 latest 时才补发，所以四态都能出现，不许挂载时预先写 started）。
    let autoCheckOutcome: 'started' | 'recent' | 'failed'
    if (refreshFailed || !snapshot) autoCheckOutcome = 'failed'
    else if (autoCheck !== 'never' && !busyAct && !ensuring && !snapshot.latestVersion) {
      autoCheckOutcome = 'started'
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
    } else {
      autoCheckOutcome = 'recent'
    }
    // 只记首刷那次判定：后续刷新不覆盖挂载行的事实。
    if (mountAutoCheckState === null) mountAutoCheckState = autoCheckOutcome
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
    // #214：volatile 锁存（传输失败/瞬态）也要能复制——连接段正是给「点了没反应」留的证据。
    if (!latch) return null
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
    const skipToken = { skipped: false }
    currentActionSkips = skipToken
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
        } else if (skipToken.skipped) {
          ok = false
          errorKind = 'busy'
        }
      }
      currentActionSkips = null
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
          if (currentActionSkips) currentActionSkips.skipped = true
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
          if (currentActionSkips) currentActionSkips.skipped = true
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
          if (currentActionSkips) currentActionSkips.skipped = true
          return
        }
        await doFallbackResolve()
        return
      }
      case 'install-fallback-confirm': {
        if (busyAct) {
          if (currentActionSkips) currentActionSkips.skipped = true
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
    // The dedupe window only matters for this instance; clear it with the mount.
    renderFailSeen.clear()
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

  function emitMountRow(autoCheck: 'started' | 'recent' | 'failed' | 'disabled'): void {
    logClient('info', 'update.panel.mount', {
      mode: clientLogMountName || 'install-button',
      theme,
      lang: currentLang(),
      pollMs,
      // #211 AC-2：挂载行带自动检查状态——四态都是**事实**，不是预告。
      autoCheck,
    })
  }

  if (autoCheck === 'mount') {
    // 挂载行等首刷（以及首刷触发的自动查）落定再发：autoCheck 记的是「跑没跑」，不是「打不打算跑」。
    void refresh().then(() => {
      if (!mounted || mountAutoCheckState === null) return
      emitMountRow(mountAutoCheckState)
    })
  } else {
    emitMountRow('disabled')
  }

  return { state, refresh, unmount }
}
