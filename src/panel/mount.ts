// src/panel/mount.ts —— 面板挂载（单组件入口：调用者只传标识与摆放参数）。
//
// 从 src/panel.ts 拆出（#226，蓝图 §4：panel/mount）。轮询调度、动作分发、失败锁存读写、
// 客户端日志、跳过读写、语言订阅全在这里；渲染与视图模型是它依赖的纯函数层。
// DOM 与剪贴板只在 mountUpdatePanel 被调用时经 globalThis 现取，模块顶层不碰。
//
// 组件行为总述（原 src/panel.ts 头注）：框架无关的整组件，调用者只传 pluginId + prefix，
// 另加 mode/showOthers/pollMs 可选；单组件单内核（内嵌与弹窗同一套 HTML，只差最外层包裹），
// 关闭面板只停轮询、不停安装，重开立刻重查。本域文件零 Node 专属能力，
// Node 宿主与浏览器闭包两边都跑得动。

import { formatUnlockAt } from '../core/cause.js'
import { isChangelogStatus, shouldFetchChangelog, type ChangelogStatus } from '../core/changelog/parse.js'
import type { BilingualKey } from '../core/i18n/dictionary.js'
import { copyText } from '../core/i18n/text.js'
import type { VisibleQueue } from '../core/queue/model.js'
import { validReleaseVersion } from '../core/service.js'
import type { UpdateLogHealth } from '../log/health.js'
import { createPanelClientLogShell } from '../log/panel-client.js'
import { PANEL_DIAG_MAX_CHARS, buildHealthyDiagCopy, buildUpdateDiagCopy, failureCodeOf, redactForCopy, replyIsCheckExpired, thrownIsCheckExpired, type DiagCopyFormat, type UpdaterSelfView } from '../panel-copy.js'
import type { UpdatePanelActionKind, UpdatePanelClientLogOptions, UpdatePanelContainer, UpdatePanelController, UpdatePanelMode, UpdatePanelOptions, UpdatePanelTheme } from '../panel.js'
import { DEFAULT_PANEL_POLL_MS, DEFAULT_PREFIX, MIN_PANEL_POLL_MS, buildChangelogPhoneName, buildLogAppendPhoneName, buildPhoneNames } from '../shared/config.js'
import { hash8 } from '../shared/hash.js'
import { langSignalSource, resolveLang, subscribeLang, type AppLang, type LocaleOption } from '../shared/lang.js'
import type { ManualSource } from '../shared/last-resort.js'
import type { UpdateSnapshot } from '../shared/ports.js'
import { PANEL_FAILURE_LATCHES, type FailureLatch } from './failure-latch.js'
import { fallbackCauseFromDetail, fallbackCauseFromDiag, renderUpdatePanelHTML, updaterSelfOfEnv } from './render.js'
import { createBrowserSkipStore } from './skip-store.js'
import { normalizePanelTheme, themeTokensStyleFor, type UpdateThemeTokens } from './theme.js'
import { messageCodeOf } from './view-model.js'

// ---------- 挂载（单组件入口：调用者只传标识与摆放参数） ----------

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function asSnapshot(value: unknown): UpdateSnapshot | null {
  if (!isObject(value)) return null
  const s = value as Partial<Record<keyof UpdateSnapshot, unknown>>
  // #182：运行版本未知是合法状态（null）；只在既不是字符串也不是 null 时拒收。
  if (s['runningVersion'] !== null && typeof s['runningVersion'] !== 'string') return null
  if (typeof s['canInstall'] !== 'boolean') return null
  return value as unknown as UpdateSnapshot
}

function asQueue(value: unknown): VisibleQueue | null {
  if (!isObject(value) || typeof value['busy'] !== 'boolean') return null
  return value as unknown as VisibleQueue
}

function randomRequestId(): string {
  try {
    const rand = Math.floor(Math.random() * 0xffffff).toString(36)
    return `r${Date.now().toString(36)}${rand}`.slice(0, 64)
  } catch {
    return `r${Date.now()}`
  }
}

function getTimer(): { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void } {
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
 * 日志链接缺省落地：开新窗口。用 `noopener,noreferrer` 且**不带** `location` 回退——
 * 拿不到 `window.open` 时宁可不跳，也绝不把宿主面板导航走（面板是宿主页面的一部分）。
 */
function defaultOpenLink(url: string): void {
  try {
    if (!/^https?:\/\//i.test(String(url || ''))) return
    const g = globalThis as Record<string, unknown>
    const w = g['window'] as { open?: (u: string, t?: string, f?: string) => unknown } | undefined
    const open = w && typeof w.open === 'function' ? w.open : null
    if (open && w) open.call(w, url, '_blank', 'noopener,noreferrer')
  } catch {
    // 开窗失败不挡更新，也不改当前页地址。
  }
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
    // 剪贴板不可用即留提示，不抛错（复制失败不能挡更新）。
  }
}

/**
 * mount 自动查抑制谓词（#48：#46 结论固化，纯函数）：
 * 仅当快照任务态为 installing/verifying，或已有查/装在途动作时不发起；
 * 同范围忙、凭证过期、各类阻拦一律不抑制（前两者正是要刷新/重建凭证时）。
 * 无活体快照（null）也不发起：首个只读刷新没拿到快照时不猜。
 */
export function pendingAutoCheck(
  snapshot: UpdateSnapshot | null,
  busyAct: 'check' | 'install' | 'fallback' | null,
): boolean {
  if (busyAct === 'check' || busyAct === 'install' || busyAct === 'fallback') return false
  if (!snapshot) return false
  const st = (snapshot as UpdateSnapshot | null)?.job?.state
  if (st === 'installing' || st === 'verifying') return false
  return true
}

/**
 * 挂载整组件（面板侧一行即跑）：
 * ```js
 * const panel = mountUpdatePanel(document.getElementById('upd'), { pluginId: 'my-plugin', prefix: 'notes', call: host.call })
 * // …离开时 panel.unmount()（只停轮询，安装在宿主侧继续跑）
 * ```
 */
export function mountUpdatePanel(container: UpdatePanelContainer, options: UpdatePanelOptions): UpdatePanelController {
  // 客户端日志（#122/#214）：壳在 src/log/panel-client.ts，单面板与批量面板共用同一口径。
  // 先读调用方选项、能建通道就先建——这样「挂载校验失败」也能如实记一行。
  const channelPrefix = ((): string => {
    if (!options || typeof options !== 'object') return DEFAULT_PREFIX
    const rawPrefix = (options as { prefix?: unknown }).prefix
    if (typeof rawPrefix !== 'string') return DEFAULT_PREFIX
    try {
      buildLogAppendPhoneName(rawPrefix)
      return rawPrefix
    } catch {
      /* prefix 非法：通道先用默认前缀，prefix 校验会如实抛并留一行 */
      return DEFAULT_PREFIX
    }
  })()
  const logShell = createPanelClientLogShell({
    clientLog:
      options && typeof options === 'object'
        ? (options as { clientLog?: UpdatePanelClientLogOptions | null }).clientLog
        : undefined,
    call:
      options && typeof options === 'object' && typeof (options as { call?: unknown }).call === 'function'
        ? (options as { call: (phoneName: string, args: Record<string, unknown>) => Promise<unknown> }).call
        : null,
    logAppendPhone: buildLogAppendPhoneName(channelPrefix),
  })
  const logClient = logShell.log
  const emitRenderFail = logShell.emitRenderFail
  const failMount = logShell.failMount
  const errorTextOf = logShell.errorTextOf
  const clientDroppedRows = logShell.droppedRows
  const installGlobalHandlers = logShell.installGlobalHandlers
  const clientLogMountName = logShell.mountName
  if (!options || typeof options !== 'object') {
    const message = '[dsh-plugin-update] 挂载面板缺少配置：插件标识 pluginId 必填'
    failMount('plugin-id', message)
    throw new Error(message)
  }
  // 传输是唯一的最小依赖：没有 call 就没有任何地方能报错，这是唯一可能「零行」的挂载失败。
  if (typeof options.call !== 'function') {
    const message = '[dsh-plugin-update] 挂载面板需要传输函数 call（面板调宿主电话的唯一接触面）'
    failMount('call', message)
    throw new Error(message)
  }
  const prefix = options.prefix === undefined ? DEFAULT_PREFIX : options.prefix
  if (!container || typeof container.innerHTML !== 'string') {
    const message = '[dsh-plugin-update] 挂载面板需要一个有 innerHTML 的容器'
    failMount('container', message)
    throw new Error(message)
  }
  const pluginId = options.pluginId
  if (typeof pluginId !== 'string' || !pluginId) {
    const message = `[dsh-plugin-update] 插件标识 pluginId 必填：须为非空字符串（收到 ${JSON.stringify(pluginId)}）`
    failMount('plugin-id', message)
    throw new Error(message)
  }
  // 电话名派生（前缀非法即抛）：这里失败了也要留一行——容器与插件标识都已经过了。
  let phoneNames: ReturnType<typeof buildPhoneNames>
  let changelogPhone: string
  try {
    phoneNames = buildPhoneNames(prefix)
    changelogPhone = buildChangelogPhoneName(prefix)
  } catch (err) {
    failMount('prefix', errorTextOf(err))
    throw err
  }
  // 自动日志（#38）：默认开；显式传过 changelogMarkdown 或显式关即退回手动。
  const autoChangelogEnabled = typeof options.changelogMarkdown !== 'string' && options.autoChangelog !== false
  let manualChangelogOverride = typeof options.changelogMarkdown === 'string'
  // 按版本记住结果（#41 终裁）：成功与取不到按版本永久记（面板内存会话级，不落盘，显式文本永不覆盖）；
  // 传输失败不进缓存，手动查新版/换版/重开立即重问，轮询按退避问（三处共用 shouldFetchChangelog，各存各的）。
  const changelogCache = new Map<string, string | null>()
  const changelogInflight = new Set<string>()
  // 失败退避时间戳（版本 -> 失败时刻毫秒）：轮询按退避问，手动/换版/重开立即忘，下次照常问。
  const changelogFailedAt = new Map<string, number>()
  let autoSeq = 0
  const pollMs =
    options.pollMs === undefined ? DEFAULT_PANEL_POLL_MS : options.pollMs
  if (typeof pollMs !== 'number' || !Number.isFinite(pollMs) || pollMs < MIN_PANEL_POLL_MS) {
    const message = `[dsh-plugin-update] 面板轮询间隔非法：不得小于 250 毫秒（收到 ${JSON.stringify(options.pollMs)}）`
    failMount('poll-ms', message)
    throw new Error(message)
  }
  // 自动检查开关（#211 AC-2）：默认开，只收布尔值；非法即当场抛（与 mode/theme 同口径）。
  const autoCheckOption: unknown = options.autoCheck === undefined ? true : options.autoCheck
  if (typeof autoCheckOption !== 'boolean') {
    const message = `[dsh-plugin-update] 自动检查开关非法：只收布尔值（收到 ${JSON.stringify(options.autoCheck)}）`
    failMount('auto-check', message)
    throw new Error(message)
  }
  const autoCheckEnabled = autoCheckOption
  let mode: UpdatePanelMode = options.mode ?? 'embedded'
  if (mode !== 'embedded' && mode !== 'dialog') {
    const message = `[dsh-plugin-update] 摆放形态非法：只收 embedded 或 dialog（收到 ${JSON.stringify(options.mode)}）`
    failMount('mode', message)
    throw new Error(message)
  }
  if (options.theme !== undefined && options.theme !== 'default' && options.theme !== 'archive') {
    const message = `[dsh-plugin-update] 主题非法：只收 default 或 archive（收到 ${JSON.stringify(options.theme)}）`
    failMount('theme', message)
    throw new Error(message)
  }
  let theme: UpdatePanelTheme = normalizePanelTheme(options.theme ?? 'default')
  // 主题是调用方点名的还是我们兜到默认的：写进 update.panel.state 的 fallback（面板自己不让主题退回，这是唯一口径）。
  const themeExplicit = options.theme !== undefined
  // 主题变量覆盖：挂载时校验（非法即抛，与 theme 同口径）；合法存下，每次 render 拼到根上。
  try {
    themeTokensStyleFor(options.themeTokens ?? undefined)
  } catch (err) {
    failMount('theme-tokens', errorTextOf(err))
    throw err
  }
  let themeTokens: UpdateThemeTokens | undefined = options.themeTokens
  const localeOpt: LocaleOption = (options as { locale?: LocaleOption }).locale ?? undefined
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
  /** 语言行（按需）：语言真的变了才发（挂载时发首次）；source 与 resolveLang 同一份判据。 */
  let loggedLang: AppLang | null = null
  function logLangApplied(): void {
    const lang = currentLang()
    if (lang === loggedLang) return
    loggedLang = lang
    logClient('info', 'update.lang.applied', { lang, source: langSignalSource(localeOpt) })
  }
  /**
   * 状态行（按需）：状态 / 主题 / 主题变量条数 / 是否兜默认 里任一项变了才发（轮询每秒重算也不会灌满）。
   * `fallback` 的口径：调用方没点名主题、面板兜到默认即 true（面板对非法主题是「当场抛」，没有静默退回）。
   */
  let loggedState = ''
  /** #214 连接计数：连续传输失败次数（刷新成功即清零）；进 copy-diag 的连接段。 */
  let transportFailStreak = 0
  /** copy-diag 动作行专用的两个数：-1 表示这次动作没复制诊断。 */
  let actionBytes = -1
  let actionTruncated = false
  /** #214：当前这次动作是否因为已有动作在途而被拒（第四态）。每次 act 一份，并发调用不串。 */
  let currentActionSkips: { skipped: boolean } | null = null
  /** UTF-8 字节数（不依赖 TextEncoder：面板侧只许引无 node: 的纯代码）。 */
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
  function logPanelState(): void {
    const state = busyAct ? 'busy' : latch || snapshot?.job?.state === 'failed' ? 'error' : 'ready'
    let tokensApplied = 0
    if (themeTokens) {
      for (const key of Object.keys(themeTokens)) {
        if ((themeTokens as Record<string, unknown>)[key] !== undefined) tokensApplied++
      }
    }
    const key = `${state}|${theme}|${tokensApplied}|${themeExplicit ? 'x' : 'd'}`
    if (key === loggedState) return
    loggedState = key
    logClient('info', 'update.panel.state', { state, theme, tokensApplied, fallback: !themeExplicit })
  }
  // 挂载行（常驻，#211 AC-2）：一次挂载一条；挂载点名字由入口件 / HTTP 直挂 / 批量面板传进来，缺省即摆放形态。
  // 字段在挂载这一刻定格（之后 setMode/setTheme 不追改），但行本身要等首刷回来才发——
  // autoCheck 记的是「这面面板挂载后有没有自动跑检查」，首刷前判不出来；行在首刷串行段统一落。
  const mountRowFields = { mode: clientLogMountName || mode, theme, lang: currentLang(), pollMs }
  logLangApplied()
  let showOthers = options.showOthers === true
  // 更新日志折叠（视图态：只影响 02 章展示，不调电话；换肤/轮询不丢）。
  let changelogCollapsed = false
  const call = options.call
  const onRestartRequested = options.onRestartRequested
  const onCloseRequested = typeof options.onCloseRequested === 'function' ? options.onCloseRequested : null
  // 上次落盘的 HTML：逐字相同即跳过赋值（闪烁根治的比较基线）。
  let lastHTML = ''
  const copyTextOut = options.copyText ?? defaultCopyText
  const openLinkOut = options.openLink ?? defaultOpenLink
  const skipStore = options.skipStore ?? createBrowserSkipStore(pluginId)
  const hostKind = typeof options.hostKind === 'string' && options.hostKind ? options.hostKind : null
  // 使用范围（profile）：宿主经 includeEnv 回真值，调用方也能显式覆盖。
  // 这一栏是「更新装到哪个范围」的唯一展示面——web / desktop 各装一份，必须让人看见自己点的是哪个。
  const profileNameOption = typeof options.profileName === 'string' && options.profileName ? options.profileName : null
  const showLogHintOption = options.showLogHint !== false
  // 日志目录（#123）：调用方显式传才认（电话回包一个字不改——使用范围那栏绝不回目录路径）。
  const logDirOption = typeof options.logDir === 'string' && options.logDir ? options.logDir : null
  const diagCopyFormat: DiagCopyFormat = options.diagCopyFormat === 'line' ? 'line' : 'block'
  let changelogMarkdown: string | null =
    typeof options.changelogMarkdown === 'string' ? options.changelogMarkdown : null
  // #213：屏上这段正文是**哪一版**的（自动取数写入时记；显式文本或认不出即 null = 不参与版本判断）。
  // 用途：结论性空白要不要清正文，比的是「屏上正文所属版本 vs 当前新版」，而不是回包版本——
  // 回包可能是中间某一版的迟到答案（verify-213 G1：连跳 2.4.0→2.5.0→2.6.0 时 2.5.0 的空白会被误挡）。
  let changelogMarkdownFor: string | null = null
  // #213：宿主判定的日志分档，只属于取它的那一版（changelogStatusFor）。显式给文本即作废；
  // 换版本也作废（见 syncChangelogStatusVersion / setChangelogMarkdown）——旧话术不许落到新版上。
  let changelogStatus: ChangelogStatus | null = null
  let changelogStatusFor: string | null = null

  let snapshot: UpdateSnapshot | null = null
  let manual: string | null = null
  // #177：命令的可信来源。成功回包带 manual 键才写 frame；失败回包沿用旧值即 carried-over（不可信）。
  let manualSource: ManualSource | null = null
  // #177 D3：失败回包后只补读一次（成功才应用；不写锁存、不重试、失败即静默）。
  let failureRereadDone = false
  let queue: VisibleQueue | null = null
  let receipt: { checkId: string } | null = null
  let requestId: string | null = null
  // 失败锁存（#58）：用户主动动作的失败证据在此冻结；只读轮询无权清除非瞬态锁存。
  const latchKey = `${pluginId}${profileNameOption ?? ''}`
  let latch: FailureLatch | null = null
  /**
   * 记住的窗口（#156 场景二）：失败锁存里解析出的 target + 窗口事实，给检查页预判用。
   * 只在 setLatch 单点写入；锁存清除（等新版/已知晓）不抹——检查页还要用它说话；
   * 新失败覆盖旧记住；过期/对版与否每次现算，结论不缓存。
   */
  let remembered: {
    targetVersion: string
    windowMs: number
    windowSource: 'message' | 'unknown'
    publishedAtMs: number | null
  } | null = null
  try {
    latch = PANEL_FAILURE_LATCHES.get(latchKey) ?? null
    // 瞬态不跨重挂：读数传输失败是上一挂载的事，重开即重新读数
    if (latch?.volatile) latch = null
  } catch {
    latch = null
  }
  function saveLatch(): void {
    try {
      // 瞬态只活在本挂载：不进跨挂载表；表有界（100 家），老的自然淘汰
      if (latch && !latch.volatile) {
        if (!PANEL_FAILURE_LATCHES.has(latchKey) && PANEL_FAILURE_LATCHES.size >= 100) {
          const oldest = PANEL_FAILURE_LATCHES.keys().next()
          if (!oldest.done) PANEL_FAILURE_LATCHES.delete(oldest.value)
        }
        PANEL_FAILURE_LATCHES.set(latchKey, latch)
      } else PANEL_FAILURE_LATCHES.delete(latchKey)
    } catch {
      // 锁存落盘失败不挡更新
    }
  }
  function latchNow(): number | null {
    try {
      const n = Date.now()
      return Number.isFinite(n) ? n : null
    } catch {
      return null
    }
  }
  function setLatch(next: FailureLatch): void {
    latch = next
    // 新失败即新上下文：基于旧失败的决议（二次确认）作废，不许拿旧凭证装新局面。
    fallbackOffer = null
    // 记住的窗口（#156 场景二）：锁存里刚解析出的 target + 年龄门 + 有窗口才记，
    // 给检查页预判用。记住失败不挡锁存；非年龄门失败不覆盖旧记住（旧窗口仍是事实）。
    adoptRemembered(fallbackCauseOf())
    saveLatch()
  }
  /**
   * 记住采用（#156 场景二）：setLatch 与 paint 共用同一判据——target + 年龄门 + 有窗口。
   * paint 里再调一次是补跨挂载的洞：锁存从跨挂载表恢复时 remembered 还是空的，
   * 用活锁存补记一次，否则新挂载里点了等新版会回到"可安装"谎言。
   */
  function adoptRemembered(cause: {
    kind: string
    targetVersion: string
    windowMs: number | null
    windowSource: 'message' | 'unknown'
    publishedAtMs: number | null
  } | null): void {
    try {
      if (
        cause && cause.kind === 'minimum-release-age' && cause.targetVersion
        && typeof cause.windowMs === 'number' && Number.isFinite(cause.windowMs) && cause.windowMs > 0
      ) {
        remembered = {
          targetVersion: cause.targetVersion,
          windowMs: cause.windowMs,
          windowSource: cause.windowSource,
          publishedAtMs: cause.publishedAtMs,
        }
      }
    } catch {
      // 忽略：记住写不进去，检查页退回老样子。
    }
  }
  function clearLatch(): void {
    if (!latch) {
      fallbackOffer = null
      return
    }
    latch = null
    fallbackOffer = null
    saveLatch()
  }
  function currentEnvPair(): { hostKind: string | null; profileName: string | null } {
    return { hostKind: hostKind ?? envHostKind, profileName: profileNameOption ?? envProfileName }
  }
  /** 任务自带的目标版本（失败那次装的是哪一版；读不到即 null，不猜）。 */
  function jobTargetOf(value: unknown): string | null {
    try {
      const job = (value as { job?: { targetVersion?: unknown } } | null | undefined)?.job
      const tv = job?.targetVersion
      return typeof tv === 'string' && tv.trim() ? tv.trim() : null
    } catch {
      return null
    }
  }
  /**
   * 锁存 → 合规版事实（#156）：渲染门与"装合规版"电话入参的唯一来源，认不出即 null。
   * 机读结论优先（host exec diag：包名命名空间正确）；job message 路径 diag 为空时，
   * 用原文解析兜底（包名命名空间退回插件标识——对不上即无按钮，不硬认）。
   * 只看安装失败：查失败/瞬态的签名表本来就不认安装码，解析了也是 null。
   */
  function fallbackCauseOf(): {
    kind: string
    spec: string
    target: string
    targetVersion: string
    windowMs: number | null
    windowSource: 'message' | 'unknown'
    publishedAtMs: number | null
  } | null {
    try {
      if (!latch || latch.source !== 'install') return null
      // 机读诊断优先（宿主事实）：真机上的插件标识与 npm 包名不是一回事，
      // 只有诊断里的 targetPackageName 能说清「拦的是哪个包」（#156 第四轮）。
      const byDiag = fallbackCauseFromDiag(latch.diag, latch.detail, latch.code, latch.targetVersion)
      if (byDiag) {
        return {
          kind: byDiag.kind,
          spec: byDiag.spec,
          target: byDiag.target,
          targetVersion: byDiag.targetVersion,
          windowMs: byDiag.windowMs,
          windowSource: byDiag.windowSource,
          publishedAtMs: byDiag.publishedAtMs,
        }
      }
      const cause = fallbackCauseFromDetail(latch.detail, latch.code, pluginId)
      if (!cause) return null
      return {
        kind: cause.kind,
        spec: `${cause.packageName}@${cause.targetVersion}`,
        target: typeof pluginId === 'string' ? pluginId : '',
        targetVersion: latch.targetVersion ?? cause.targetVersion,
        windowMs: cause.windowMs,
        windowSource: cause.windowSource,
        publishedAtMs: cause.publishedAtMs,
      }
    } catch {
      return null
    }
  }
  /**
   * 记住 → 合规版事实（#156 场景二）：检查页点"装合规版"时锁存已清（用户点了等新版），
   * fallbackCauseOf 为 null——用记住的窗口顶上，形状与锁存结论一致，下游电话入参同口径。
   * 只认"记住的正是对当下快照这一版"：远端出了新版，旧记住闭嘴（规则三：不对没证据的版决议）。
   * 解封是否已过这里不卡——过了决议会走 ok-now 直接装最新，自己痊愈。
   */
  function rememberedCause(): {
    kind: string
    targetVersion: string
    windowMs: number
    windowSource: 'message' | 'unknown'
    publishedAtMs: number | null
  } | null {
    try {
      if (!remembered) return null
      const latest = typeof snapshot?.latestVersion === 'string' ? snapshot.latestVersion.trim() : ''
      if (!latest || latest !== remembered.targetVersion) return null
      return {
        kind: 'minimum-release-age',
        targetVersion: remembered.targetVersion,
        windowMs: remembered.windowMs,
        windowSource: remembered.windowSource,
        publishedAtMs: remembered.publishedAtMs,
      }
    } catch {
      return null
    }
  }
  function latchFromReply(reply: Record<string, unknown>, source: 'check' | 'install'): FailureLatch {
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
      diag: Object.prototype.hasOwnProperty.call(reply, 'diag') ? (reply as Record<string, unknown>)['diag'] : null,
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
      jobId: null,
      atMs: latchNow(),
    }
  }
  function latchFromJob(job: NonNullable<UpdateSnapshot['job']>, snap: UpdateSnapshot | null, replyDiag?: unknown): FailureLatch {
    const env = currentEnvPair()
    const message = typeof job.message === 'string' ? job.message : null
    const detail = message && message.includes(':') ? message.slice(message.indexOf(':') + 1).trim() || null : message
    return {
      code: messageCodeOf(message) || 'install-failed',
      kind: null,
      detail,
      // 快照里没有 diag：优先保留锁存里既有的（多半是致命安装回包自带的），
      // 其次用本次回包随行的 diag（异步失败时宿主补的包名/归因，#156 第四轮），都没有即缺省说人话。
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
      jobId: typeof job.id === 'string' ? job.id : null,
      atMs: latchNow(),
    }
  }
  /** 抛错原文收成摘要（脱敏后；裸码不算人话，缺省由渲染侧说人话）。 */
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
  /** 用户路径抛错锁存（非瞬态）：点下去的动作，其结果无论回包还是抛错都冻结。 */
  function userThrowLatch(source: 'check' | 'install', err: unknown): FailureLatch {
    const env = currentEnvPair()
    return {
      code: source === 'install' ? 'install-failed' : 'check-failed',
      kind: null,
      detail: thrownDetail(err),
      diag: null,
      requestId: source === 'install' ? requestId : null,
      checkId: source === 'install' ? (receipt?.checkId ?? null) : null,
      runningVersion: snapshot?.runningVersion ?? null,
      installedVersion: snapshot?.installedVersion ?? null,
      latestVersion: snapshot?.latestVersion ?? null,
      targetVersion: null,
      hostKind: env.hostKind,
      profileName: env.profileName,
      source,
      volatile: false,
      jobId: null,
      atMs: latchNow(),
    }
  }
  function volatileLatch(source: 'check' | 'install'): FailureLatch {
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
      jobId: null,
      atMs: latchNow(),
    }
  }
  function backfillLatch(s: UpdateSnapshot): void {
    if (!latch) return
    let touched = false
    if (latch.runningVersion === null && s.runningVersion) {
      latch.runningVersion = s.runningVersion
      touched = true
    }
    if (latch.installedVersion === null && s.installedVersion) {
      latch.installedVersion = s.installedVersion
      touched = true
    }
    if (latch.latestVersion === null && s.latestVersion) {
      latch.latestVersion = s.latestVersion
      touched = true
    }
    if (touched) saveLatch()
  }
  function tripleChanged(s: UpdateSnapshot): boolean {
    if (!latch) return false
    backfillLatch(s)
    const pairs: [string | null, string | null][] = [
      [latch.runningVersion, s.runningVersion ?? null],
      [latch.installedVersion, s.installedVersion ?? null],
      [latch.latestVersion, s.latestVersion ?? null],
    ]
    return pairs.some(([a, b]) => a !== null && b !== null && a !== b)
  }
  /** 同语义失败（#143）：除 atMs 外逐字一致即同一失败，不许时间戳 churn 触发重绘。 */
  function latchSameFailure(a: FailureLatch | null, b: FailureLatch): boolean {
    if (!a) return false
    return (
      a.code === b.code &&
      a.kind === b.kind &&
      a.detail === b.detail &&
      a.diag === b.diag &&
      a.requestId === b.requestId &&
      a.checkId === b.checkId &&
      a.runningVersion === b.runningVersion &&
      a.installedVersion === b.installedVersion &&
      a.latestVersion === b.latestVersion &&
      a.targetVersion === b.targetVersion &&
      a.hostKind === b.hostKind &&
      a.profileName === b.profileName &&
      a.source === b.source &&
      a.volatile === b.volatile &&
      a.jobId === b.jobId
    )
  }
  let copyNotice: string | null = null
  let noticeExpiresAt = 0
  // v1.3：复制成功气泡（fixed 定位，约 1.4s）。按钮文案/图标不参与，故与 copyNotice 分开存。
  let copyBubble: { text: string; left: number; top: number } | null = null
  let copyBubbleTimer: ReturnType<typeof setTimeout> | null = null
  /** 点击时的按钮元素（只给气泡量坐标用，不参与任何状态判断）。 */
  let copyAnchorEl: unknown = null
  // 在途动作（#36）：点下查新版/安装到回包前的那一帧，按钮置忙 + 并发连点只认第一次。
  let busyAct: 'check' | 'install' | 'fallback' | null = null
  /**
   * 合规版二次确认（#156）：用户点了"装合规版"且决议出候选后才有；
   * 存"候选版 + 决议凭证"，确认按钮点下去即凭它安装。上下文一变（新失败/新检查/确认发出）即清——
   * 凭证只活在决议的那一次上下文里，不跨检查复用（核心第二槽同口径）。
   */
  let fallbackOffer: { candidate: string; checkId: string; targetVersion: string } | null = null
  let mounted = true
  // 宿主 includeEnv 回的使用范围与宿主种类（调用方显式传的优先，见 render）。
  let envProfileName: string | null = null
  let envHostKind: string | null = null
  // 更新器自检（#196 部署偏斜）：这块面板实际加载到的本包副本（版本 + 层级）；旧宿主不给即 null。
  let envUpdater: UpdaterSelfView | null = null
  /**
   * 日志健康读数（#212）：宿主成功回包里的 logHealth；旧宿主没有这个键就一直是 null，
   * 面板日志区那一行随之不出现（老输出一字不差）。语义判断全在 panel-copy.logHealthText。
   */
  let envLogHealth: UpdateLogHealth | null = null

  /** 记一条 transient 回执：5 秒后过期（toast 语义），下次点击不清它、时间到才清。 */
  function sayCopy(text: string): void {
    copyNotice = text
  }
  function sayCopyKey(key: BilingualKey, values?: Record<string, unknown>): void {
    try {
      copyNotice = copyText(key, currentLang(), values)
    } catch {
      copyNotice = copyText(key, 'zh', values)
    }
    try {
      noticeExpiresAt = Date.now() + 5000
    } catch {
      noticeExpiresAt = 0
    }
  }

  /**
   * 复制成功：在按钮上方浮出「已复制」气泡（v1.3）。
   * 只加一层 fixed 定位的状态提示，按钮文案与图标一字不变；1.4s 后撤掉。
   * 拿不到矩形（老测试桩 / 非浏览器）就画在左上角兜底，绝不因为量不到坐标而不给反馈。
   */
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
        if (mounted) render()
      }, 1400)
    } catch { copyBubbleTimer = null }
  }

  function setStableHTML(target: UpdatePanelContainer, html: string): void {
    try {
      const g = globalThis as unknown as Record<string, unknown>
      const doc = g['document'] as unknown as {
        activeElement?: { getAttribute?: (n: string) => string | null } | null
        querySelector?: (sel: string) => { focus?: (o?: unknown) => void } | null
      } | null | undefined
      const el = target as unknown as {
        querySelectorAll?: (sel: string) => ArrayLike<{ scrollTop?: unknown }> | null
        querySelector?: (sel: string) => { focus?: (o?: unknown) => void } | null
      }
      if (!doc || typeof el.querySelectorAll !== 'function') {
        target.innerHTML = html
        return
      }
      let focusAction: string | null = null
      try {
        const active = doc.activeElement
        if (active && typeof active.getAttribute === 'function') {
          focusAction = active.getAttribute('data-action')
        }
      } catch { focusAction = null }
      let scrolls: number[] = []
      // #143：dialog 下外层面板根同样可滚（max-height + overflow-y:auto），与内层同保。
      let rootScrolls: number[] = []
      try {
        const nodes = el.querySelectorAll('.dsh-upd-body')
        if (nodes) {
          for (let i = 0; i < nodes.length; i++) {
            const n = nodes[i] as unknown as { scrollTop?: unknown }
            scrolls.push(typeof n.scrollTop === 'number' ? (n.scrollTop as number) : 0)
          }
        }
      } catch { scrolls = [] }
      try {
        const roots = el.querySelectorAll('.dsh-upd')
        if (roots) {
          for (let i = 0; i < roots.length; i++) {
            const n = roots[i] as unknown as { scrollTop?: unknown }
            rootScrolls.push(typeof n.scrollTop === 'number' ? (n.scrollTop as number) : 0)
          }
        }
      } catch { rootScrolls = [] }
      target.innerHTML = html
      try {
        const bodies = el.querySelectorAll('.dsh-upd-body')
        if (bodies) {
          for (let i = 0; i < bodies.length && i < scrolls.length; i++) {
            const n = bodies[i] as unknown as { scrollTop?: unknown }
            try { (n as { scrollTop: number }).scrollTop = scrolls[i] } catch { /* keep */ }
          }
        }
      } catch { /* keep */ }
      try {
        const roots = el.querySelectorAll('.dsh-upd')
        if (roots) {
          for (let i = 0; i < roots.length && i < rootScrolls.length; i++) {
            const n = roots[i] as unknown as { scrollTop?: unknown }
            try { (n as { scrollTop: number }).scrollTop = rootScrolls[i] } catch { /* keep */ }
          }
        }
      } catch { /* keep */ }
      try {
        if (focusAction && typeof el.querySelector === 'function') {
          const next = el.querySelector('[data-action="' + focusAction + '"]')
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

  function queueArgs(): Record<string, unknown> {
    // includeEnv：要宿主把「装到哪个使用范围」一并回给我们（老调用不带，回包形状不变）。
    return { includeQueue: true, includeEnv: true, showOthers, ...(requestId ? { requestId } : {}) }
  }

  function render(): void {
    if (!mounted) return
    // 渲染期兜底（#122 清单里的 kind:'unknown'）：渲染坏了如实记一行，别把轮询计时器带崩。
    try {
      paint()
    } catch (err) {
      // #214：带阶段 + 指纹；同错风暴 60 秒内只留一条。
      emitRenderFail('paint', 'render', errorTextOf(err) || 'render-failed')
    }
  }

  /** 真正的渲染体（原来就叫 render；#122 加兜底后拆成「壳 + 体」，逻辑一字不动）。 */
  function paint(): void {
    // Toast 过期（#37）：transient 提示只活 5 秒；戳在赋值点打（sayCopy），轮询重绘不续命。
    // busy 在途提示由 finally 清，这里只管过期。
    if (!copyNotice) noticeExpiresAt = 0
    else if (noticeExpiresAt && Date.now() > noticeExpiresAt) {
      copyNotice = null
      noticeExpiresAt = 0
    }
    // #213：日志分档只跟随当前新版——换版本（或无新版）即作废，上一版的话术绝不许落到新版上。
    syncChangelogStatusVersion()
    const latest = snapshot?.latestVersion ?? null
    const skippedLatest = !!latest && validReleaseVersion(latest) && skipStore.has(latest)
    // 渲染只在变化时落盘（闪烁根治）：轮询每秒重算，但输出逐字相同时不碰 DOM，
    // 悬停/focus 状态不再被整树替换打断；状态变化仍即时重绘。
    const langNow = currentLang()
    const nextHTML = renderUpdatePanelHTML({
      snapshot,
      manual,
      manualSource,
      copyBubble,
      queue,
      busyAct,
      lang: langNow,
      skippedLatest,
      lastError: latch?.code ?? null,
      errorKind: latch?.kind ?? null,
      failure: latch
        ? {
          requestId: latch.requestId,
          checkId: latch.checkId,
          atMs: latch.atMs,
          source: latch.source,
          volatile: latch.volatile,
          targetVersion: latch.targetVersion,
          // 合规版门（#156）：安装失败才解析锁存证据；查失败/瞬态不解析（签名表只认安装码）。
          ...(() => {
            const cause = fallbackCauseOf()
            return cause
              ? {
                causeKind: cause.kind,
                causePackage: cause.spec,
                causeTarget: cause.target,
                causeWindowMs: cause.windowMs,
                causePublishedAtMs: cause.publishedAtMs,
              }
              : { causeKind: null, causePackage: null, causeTarget: null, causeWindowMs: null, causePublishedAtMs: null }
          })(),
        }
        : null,
      // 合规版二次确认（#156）：有决议凭证才下发，渲染只画按钮不认凭证（装时凭它）。
      fallbackOffer: fallbackOffer
        ? { candidate: fallbackOffer.candidate, targetVersion: fallbackOffer.targetVersion }
        : null,
      // 检查页预判（#156 场景二）：记住的窗口翻译成渲染输入——对版、有发布时间、
      // 时钟正常才下发；渲染侧按同一纯门再验一遍，不信这里。
      checkPrejudge: (() => {
        try {
          // 跨挂载补记：锁存从表里恢复时 remembered 为空，用活锁存补记一次。
          if (!remembered) adoptRemembered(fallbackCauseOf())
          if (!remembered || !snapshot?.canInstall) return null
          const latest = typeof snapshot.latestVersion === 'string' ? snapshot.latestVersion.trim() : ''
          if (!latest || latest !== remembered.targetVersion) return null
          if (typeof remembered.publishedAtMs !== 'number' || !Number.isFinite(remembered.publishedAtMs)) return null
          if (!Number.isFinite(remembered.windowMs) || remembered.windowMs <= 0) return null
          const unlockAtMs = remembered.publishedAtMs + remembered.windowMs
          if (!Number.isFinite(unlockAtMs)) return null
          const nowMs = latchNow()
          if (nowMs == null) return null
          return { targetVersion: latest, unlockAtMs, nowMs }
        } catch {
          return null
        }
      })(),
      showLogHint: showLogHintOption,
      changelogMarkdown,
      // #213：宿主判定的空白分档（只影响画不出内容时的那句话）。
      changelogStatus,
      mode,
      showOthers,
      changelogCollapsed,
      pluginId,
      copyNotice,
      theme,
      themeTokens,
      // 使用范围与宿主种类：调用方显式传的优先，否则用宿主回的真值。
      profileName: profileNameOption ?? envProfileName,
      hostKind: hostKind ?? envHostKind,
      // 更新器自检（#196）：宿主 includeEnv 回的真值；旧宿主不给就省略（老输出一字不差）。
      updater: envUpdater,
      // 日志目录（#123）：挂载项给的真值；没给就由错误章路牌退回算式与命令模板。
      logDir: logDirOption,
      // 日志健康（#212）：成功回包里的 logHealth；老宿主一直是 null，渲染一字不差。
      logHealth: envLogHealth,
    })
    if (nextHTML !== lastHTML) {
      lastHTML = nextHTML
      setStableHTML(container, nextHTML)
    }
    // 状态行（按需）：画完再算 —— 状态行是给第三方看「面板此刻什么状态」的，不是渲染输入。
    logPanelState()
  }

  /**
   * #212：采纳成功回包里的日志健康读数（选填键）。
   * 键缺席（老宿主 / 该回包不带）→ 保持现状，不动已有读数、也不制造新读数；
   * 键在但不是对象（null / 字符串…）→ 显式清空：「这一帧说没有」就照实没有，不沿用旧值；
   * 形状对不对由 panel-copy.logHealthText 在渲染时按枚举分支判定（认不出即「无法识别」）。
   */
  function adoptLogHealth(value: unknown): void {
    if (value === undefined) return
    envLogHealth = isObject(value) ? (value as unknown as UpdateLogHealth) : null
  }

  function applyStatusReply(reply: Record<string, unknown>, via: 'refresh' | 'check' | 'install'): void {
    if (!isObject(reply)) return
    if (reply['ok'] === true) {
      if (via === 'check') {
        // 新检查结论落地，基于旧上下文的决议凭证作废（核心第二槽同口径：check 即清）。
        fallbackOffer = null
      }
      const s = asSnapshot(reply['snapshot'])
      if (s) snapshot = s
      manual = typeof reply['manual'] === 'string' ? (reply['manual'] as string) : null
      // #177 D2：manual 与 snapshot 同回包且回包带 manual 键 → 当帧可信；没有该键 = 当帧确实没有命令。
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
        const selfView = updaterSelfOfEnv(env)
        if (selfView) envUpdater = selfView
      }
      // #212 日志健康（选填键）：老宿主没有这个键即不动，输出与旧版一字不差。
      adoptLogHealth(reply['logHealth'])
      // 成功回包的锁存规则（#58）：只读轮询永不清除非瞬态锁存；diag 不覆写既有证据。
      const jobState = snapshot?.job?.state ?? null
      if (jobState === 'installing' || jobState === 'verifying') {
        // 新一轮在途：旧失败让位
        clearLatch()
      } else if (jobState === 'completed' || jobState === 'restart-required') {
        // 成功终态：旧失败已无意义
        clearLatch()
      } else if ((jobState === 'failed' || jobState === 'interrupted') && snapshot?.job) {
        // 后台结局到达：单调置入（只允许从无到有或同源更新，永不由轮询清除）。
        // #100：三元组已变（比如远端出了新版）→ 旧失败的上下文被新信息替代，不再复活；
        // 同上下文才常驻（#58）。
        if (snapshot && tripleChanged(snapshot)) clearLatch()
        else {
          // #143：同语义重复轮询冻结首次失败时刻，不重建锁存（时间戳 churn 即重绘即丢滚动）。
          // #156 第四轮：异步失败的事实（包名/归因）由宿主随本次回包的 diag 一起带回——
          // 快照里没有它，锁存又空着时就是它顶上（既有证据不覆写，#58）。
          const next = latchFromJob(snapshot.job, snapshot, isObject(reply['diag']) ? reply['diag'] : null)
          if (!latchSameFailure(latch, next)) setLatch(next)
        }
      } else if (via === 'install') {
        // 安装调用成功且无任务态：新一轮已被接受，旧失败让位
        clearLatch()
      } else if (snapshot && tripleChanged(snapshot)) {
        // 版本三元组变化：旧失败的上下文已被新信息替代
        clearLatch()
      } else if (via === 'check' && latch?.source === 'check') {
        // 用户主动查成功：查失败解除；装失败保留（查成功不证明装会成功）
        clearLatch()
      } else if (latch?.volatile) {
        // 瞬态读失败被一次成功读数治愈（用户查与轮询同权）
        clearLatch()
      }
    } else {
      const errText = typeof reply['error'] === 'string' ? reply['error'].trim() : ''
      const kindText = typeof reply['errorKind'] === 'string' ? reply['errorKind'].trim() : ''
      if ((kindText || errText) === 'update-busy') {
        // 忙是瞬态排队态：不锁存、不清除（位置走队列视图实时渲染）
      } else {
        setLatch(latchFromReply(reply, via === 'install' ? 'install' : 'check'))
        // #177：失败回包里的 manual 只是上一帧沿用的旧值 —— 标 carried-over（fail-closed：不展示/不复制/不高亮），
        // 然后静默补读一次 updateStatus，补到当帧命令才恢复可信；补读失败不改锁存、不重试。
        manualSource = manual ? 'carried-over' : null
        scheduleFailureReread()
      }
      // #45：失败也收使用范围与队列（快照/凭证不动；best-effort，形状不对即忽略）。
      try {
        const env = (reply as Record<string, unknown>)['env']
        if (isObject(env)) {
          const pn = env['profileName']
          const hk = env['environmentKind']
          if (typeof pn === 'string' && pn.trim()) envProfileName = pn.trim()
          if (typeof hk === 'string' && hk.trim()) envHostKind = hk.trim()
          const selfView = updaterSelfOfEnv(env)
          if (selfView) envUpdater = selfView
        }
      } catch {
        // 忽略：失败回包的环境栏是选填。
      }
      try {
        const q = asQueue((reply as Record<string, unknown>)['queue'])
        if (q) queue = q
      } catch {
        // 忽略：失败回包的队列视图是选填。
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
        const value = reply as Record<string, unknown>
        if (value && value['ok'] === true) {
          // #177 D3：补读只补读当帧读数（快照 / 命令 / 队列 / 环境），不跑成功回包的锁存规则——
          // 它不是一次新的判定，只用来把命令从「沿用值」恢复成「当帧事实」；失败帧原样保留。
          const s = asSnapshot(value['snapshot'])
          if (s) snapshot = s
          manual = typeof value['manual'] === 'string' ? (value['manual'] as string) : null
          manualSource = manual !== null ? 'frame' : null
          const q = asQueue(value['queue'])
          if (q) queue = q
          try {
            const env = value['env']
            if (isObject(env)) {
              const pn = env['profileName']
              const hk = env['environmentKind']
              if (typeof pn === 'string' && pn.trim()) envProfileName = pn.trim()
              if (typeof hk === 'string' && hk.trim()) envHostKind = hk.trim()
              const selfView = updaterSelfOfEnv(env)
              if (selfView) envUpdater = selfView
            }
          } catch {
            // 忽略：补读回包的环境栏是选填。
          }
          // #212 日志健康：补读同权只补当帧读数（老宿主没有这个键即不动）。
          adoptLogHealth(value['logHealth'])
          render()
        }
      } catch {
        // 静默：补读只是最后一次读数机会；不写锁存、不重试、不打断已有失败帧。
      }
    })()
  }

  /** #213：当前新版（无快照/无新版 → null）；宿主判定的分档话术只属于这一版。 */
  function changelogStatusVersionNow(): string | null {
    const v = snapshot?.latestVersion
    return typeof v === 'string' && v ? v : null
  }

  /** #213：换版本即作废已记的分档——上一版的话术绝不许落到新版上。 */
  function syncChangelogStatusVersion(): void {
    const now = changelogStatusVersionNow()
    // #213（verify-213 G2-null）：版本号**暂时**读不到（重查在飞、快照里没新版）那一帧不作废——
    // 02 章那一帧本来就不渲染，作废只会让同一版的分档话术凭空丢掉（回来的还是这一版时无从恢复）；
    // 等版本号回来再按「同版保留、异版作废」判，旧话术仍落不到新版上。
    if (now === null) return
    if (now === changelogStatusFor) return
    changelogStatusFor = now
    changelogStatus = null
  }

  /**
   * #213：把自动取数回包里的分档记到这一版上，返回分档是否变了（变了才需要重绘空白分支）。
   * 回包里的 `status` 恒为原始内容态（裁决：命中缓存那帧也是原样，另有 `cached:true` 只说明
   * 这次回的是宿主缓存——面板侧不消费它）；字段缺失或认不出（老宿主/野值/万一的 `cache-hit`）
   * 一律保持本版已记下的分档：一个字的文案都不改。
   */
  function applyChangelogStatusReply(reply: Record<string, unknown>, version: string): boolean {
    const raw = reply['status']
    const known = isChangelogStatus(raw) && raw !== 'cache-hit' ? raw : null
    if (known === null) return false
    const changed = known !== changelogStatus
    changelogStatus = known
    changelogStatusFor = version
    return changed
  }

  /** 自动取日志的触发条件（#41 终裁）：仅有新版可装、未跳过该版时按退避问一次。 */
  function pendingAutoChangelogVersion(): string | null {
    if (!autoChangelogEnabled || manualChangelogOverride || !mounted) return null
    const v = snapshot?.latestVersion ?? null
    if (typeof v !== 'string' || !validReleaseVersion(v)) return null
    if (!snapshot || snapshot.canInstall !== true) return null
    try {
      if (skipStore.has(v)) return null
    } catch {
      // 跳过存储读不到即当没跳过，不挡日志。
    }
    if (changelogInflight.has(v)) return null
    const hasCache = changelogCache.has(v)
    const failedAt = changelogFailedAt.has(v) ? (changelogFailedAt.get(v) as number) : null
    let nowMs = 0
    try { nowMs = Date.now(); } catch { nowMs = 0; }
    if (!shouldFetchChangelog({ hasCache: hasCache, failedAt: failedAt, now: nowMs, isManual: false })) return null
    return v
  }

  /** 有新版即按 latestVersion 调一次宿主电话，回来经内部通道换日志节；过期回包直接丢。 */
  function maybeAutoChangelog(): void {
    const v = pendingAutoChangelogVersion()
    if (v === null) return
    changelogInflight.add(v)
    const seq = autoSeq
    void Promise.resolve()
      .then(() => call(changelogPhone, { version: v }))
      .then(
        (reply) => {
          changelogInflight.delete(v)
          if (!mounted || seq !== autoSeq) return
          const box = (reply && typeof reply === 'object' ? reply : {}) as Record<string, unknown>
          if (!reply || typeof reply !== 'object' || box['ok'] !== true) {
            try { changelogFailedAt.set(v, Date.now()); } catch { try { changelogFailedAt.set(v, 0); } catch {} }
            // 电话本身没成（老路径，照旧退避重试）；回包若如实带了分档，空白分支照样说实话。
            if (applyChangelogStatusReply(box, v)) render()
            return
          }
          const md = box['markdown']
          changelogCache.set(v, typeof md === 'string' ? md : null)
          const statusChanged = applyChangelogStatusReply(box, v)
          if (typeof md === 'string') {
            changelogMarkdown = md
            changelogMarkdownFor = v
            render()
          } else {
            // #213：宿主对**这一版**给了结论性分档（空文件 / 包里没有 / 取不到）却没有正文——
            // 上一版的正文不许留在新版标题下：那会让空白区既拿不到分档话术，还可能把旧版说明
            // 冒充新版（两轴评审都点了这一格）。认不出分档的老宿主不动旧正文，行为与 #213 之前一致。
            // 闸门比的是「屏上正文所属版本 vs 当前新版」，不是回包版本（verify-213 D3-5 + G1）：
            //  · 回包是**屏上这一版**的迟到答案 → 正文本来就对，不许清（D3-5：升版时慢的那通后到）；
            //  · 屏上正文是**更旧一版**的、当前新版已换 → 该清（G1：连跳时中间那版的空白也要清掉旧正文）；
            //  · 屏上正文版本未知（显式文本 / 认不出）→ 不动，显式内容永远赢。
            if (
              statusChanged &&
              changelogMarkdown !== null &&
              changelogMarkdownFor !== null &&
              changelogMarkdownFor !== changelogStatusVersionNow()
            ) {
              changelogMarkdown = null
              changelogMarkdownFor = null
            }
            // 没有文本时也要重绘一次——空白分支的话术要跟着分档走。
            if (statusChanged) render()
          }
        },
        () => {
          changelogInflight.delete(v)
          if (mounted && seq === autoSeq) { try { changelogFailedAt.set(v, Date.now()); } catch { try { changelogFailedAt.set(v, 0); } catch {} } }
        },
      )
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
      transportFailStreak++
      // #214：轮询传输失败不再只锁存不说话；一行指纹让「面板一直读取中」有证据。
      emitRenderFail('poll', 'transport', errorTextOf(err) || 'transport-failed')
      // 读数传输失败是瞬态：记 volatile 锁存，下一次成功读数即清，不留死结
      setLatch(volatileLatch('check'))
    }
    render()
    maybeAutoChangelog()
  }

  async function act(kind: UpdatePanelActionKind, arg?: string): Promise<void> {
    if (!mounted) return
    const startedAtMs = Date.now()
    // 动作行（常驻）：用户每点一下记一条，含提前 return 的分支；bytes/truncated 只由 copy-diag 那段回填。
    // #214 补四态：ok=true 成功；ok=false 且 errorKind=锁存码（动作把面板带进失败态）；
    // errorKind='thrown'（动作直接抛错）；errorKind='busy'（已有动作在途，这次点击被拒）。
    actionBytes = -1
    actionTruncated = false
    const skipToken = { skipped: false }
    currentActionSkips = skipToken
    const latchBefore = latch
    let ok = true
    let errorKind: string | null = null
    let errorHash: string | null = null
    try {
      await runAction(kind, arg)
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

  /** 原来的动作分发体（#122 加动作行后拆成「壳 + 体」，逻辑一字不动）。 */
  async function runAction(kind: UpdatePanelActionKind, arg?: string): Promise<void> {
    copyNotice = null
    switch (kind) {
      case 'check': {
        if (busyAct) {
          if (currentActionSkips) currentActionSkips.skipped = true
          return
        }
        busyAct = 'check'
        copyNotice = copyText('panel.toast.checking', currentLang())
        render()
        try {
          const reply = await call(phoneNames.updateCheck, queueArgs())
          if (!mounted) return
          applyStatusReply(reply, 'check')
          // 手动查新版是明确意图：清掉失败退避，下面的自动链路可再问一次。
          changelogFailedAt.clear()
        } catch (err) {
          if (!mounted) return
          setLatch(userThrowLatch('check', err))
        } finally {
          busyAct = null
          try {
            const zh = copyText('panel.toast.checking', 'zh')
            const en = copyText('panel.toast.checking', 'en')
            if (copyNotice === zh || copyNotice === en) copyNotice = null
          } catch {
            copyNotice = null
          }
        }
        render()
        maybeAutoChangelog()
        return
      }
      case 'install': {
        if (busyAct) {
          if (currentActionSkips) currentActionSkips.skipped = true
          return
        }
        busyAct = 'install'
        copyNotice = copyText('panel.toast.installing', currentLang())
        render()
        try {
          // 至多静默续一次（#150）：旧凭证被拒即重查 + 新凭证重装；其余失败原样锁存。
          // 查回 ok:true 却无收据时真实故事在快照里（阻拦 / 无需装），绝不伪造 check-expired。
          for (let attempt = 0; attempt < 2; attempt += 1) {
            if (!receipt) {
              const prevLatch = latch
              try {
                const checked = await call(phoneNames.updateCheck, queueArgs())
                if (!mounted) return
                applyStatusReply(checked, 'check')
              } catch (err) {
                if (!mounted) return
                setLatch(userThrowLatch('check', err))
                render()
                return
              }
              if (!mounted) return
              if (!receipt) {
                // 与安装按钮同一口径：只有本轮查没换掉的旧锁存才清，本轮派生的 job 失败保留。
                if (latch === prevLatch) clearLatch()
                render()
                return
              }
            }
            if (!mounted) return
            requestId = randomRequestId()
            let reply: Record<string, unknown>
            try {
              reply = await call(phoneNames.updateInstall, {
                checkId: receipt.checkId,
                requestId,
                from: 'panel',
                ...queueArgs(),
              })
            } catch (err) {
              if (!mounted) return
              if (thrownIsCheckExpired(err) && attempt === 0) {
                receipt = null
                continue
              }
              setLatch(userThrowLatch('install', err))
              render()
              return
            }
            if (!mounted) return
            // 先判过期再应用：attempt 0 的过期回包直接续查，不锁存（render 也跳过）。
            if (replyIsCheckExpired(reply) && attempt === 0) {
              receipt = null
              continue
            }
            applyStatusReply(reply, 'install')
            render()
            return
          }
        } catch (err) {
          if (!mounted) return
          setLatch(userThrowLatch('install', err))
        } finally {
          busyAct = null
          try {
            const zh = copyText('panel.toast.installing', 'zh')
            const en = copyText('panel.toast.installing', 'en')
            if (copyNotice === zh || copyNotice === en) copyNotice = null
          } catch {
            copyNotice = null
          }
        }
        render()
        maybeAutoChangelog()
        return
      }
      case 'install-fallback': {
        // 合规版决议（#156）：点"装合规版"本身不装任何东西——先认证据，再问决议，
        // 有候选才给点名版本的二次确认按钮。决议算不出/宿主没这条电话，一律退回通用提醒。
        if (busyAct) {
          if (currentActionSkips) currentActionSkips.skipped = true
          return
        }
        // 检查页（#156 场景二）：锁存已清时用记住的窗口顶上；锁存还在时锁存优先。
        const cause = fallbackCauseOf() ?? rememberedCause()
        if (!cause) {
          sayCopyKey('panel.toast.fallback-unavailable')
          render()
          return
        }
        busyAct = 'fallback'
        render()
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
            // 老宿主没有这条电话（unknown-phone）或传输失败：退化"只呈现"，面板不碎。
            reply = null
          }
          if (!mounted) return
          const snap = isObject(reply) && isObject((reply as Record<string, unknown>)['snapshot'])
            ? (reply as Record<string, unknown>)['snapshot'] as Record<string, unknown>
            : null
          const verdict = snap && isObject(snap['verdict']) ? snap['verdict'] as Record<string, unknown> : null
          const vKind = verdict && typeof verdict['kind'] === 'string' ? (verdict['kind'] as string) : ''
          const vVersion = verdict && typeof verdict['version'] === 'string' ? (verdict['version'] as string).trim() : ''
          const snapCandidate = snap && typeof snap['candidate'] === 'string' ? (snap['candidate'] as string).trim() : ''
          const rec = isObject(reply) && isObject((reply as Record<string, unknown>)['receipt'])
            ? (reply as Record<string, unknown>)['receipt'] as Record<string, unknown>
            : null
          const gotCheckId = rec && typeof rec['checkId'] === 'string' ? (rec['checkId'] as string) : ''
          // ok-now 的候选即目标版自己（决议 verdict.version 点名）；其余只认 snapshot.candidate。
          const candidate = snapCandidate || (vKind === 'ok-now' ? vVersion : '')
          if ((vKind === 'downgrade-available' || vKind === 'ok-now') && candidate && gotCheckId) {
            fallbackOffer = { candidate, checkId: gotCheckId, targetVersion: cause.targetVersion }
          } else if (vKind === 'wait-until') {
            const unlockAt = verdict && typeof verdict['unlockAtMs'] === 'number'
              ? verdict['unlockAtMs'] as number
              : null
            const time = typeof unlockAt === 'number' ? formatUnlockAt(unlockAt, currentLang()) : null
            if (time) sayCopyKey('panel.toast.fallback-wait', { time })
            else sayCopyKey('panel.toast.fallback-unavailable')
          } else {
            sayCopyKey('panel.toast.fallback-unavailable')
          }
        } finally {
          busyAct = null
        }
        render()
        return
      }
      case 'install-fallback-confirm': {
        // 二次确认（#156）：按钮文案即决议点名的精确版本——用户先看见再点，不存在静默装旧版。
        // 门与 latest 路径同口径：决议凭证过期（期间跑过检查）即退回重决议，不锁存不硬装。
        if (busyAct) {
          if (currentActionSkips) currentActionSkips.skipped = true
          return
        }
        if (!fallbackOffer) return
        const offer = fallbackOffer
        busyAct = 'install'
        copyNotice = copyText('panel.toast.installing', currentLang())
        render()
        try {
          requestId = randomRequestId()
          let reply: Record<string, unknown>
          try {
            reply = await call(phoneNames.updateInstall, {
              checkId: offer.checkId,
              requestId,
              version: offer.candidate,
              from: 'panel',
              ...queueArgs(),
            })
          } catch (err) {
            if (!mounted) return
            fallbackOffer = null
            if (thrownIsCheckExpired(err)) {
              sayCopyKey('panel.toast.fallback-unavailable')
              render()
              return
            }
            setLatch(userThrowLatch('install', err))
            render()
            return
          }
          if (!mounted) return
          fallbackOffer = null
          if (replyIsCheckExpired(reply)) {
            sayCopyKey('panel.toast.fallback-unavailable')
            render()
            return
          }
          applyStatusReply(reply, 'install')
        } catch (err) {
          if (!mounted) return
          setLatch(userThrowLatch('install', err))
        } finally {
          busyAct = null
          try {
            const zh = copyText('panel.toast.installing', 'zh')
            const en = copyText('panel.toast.installing', 'en')
            if (copyNotice === zh || copyNotice === en) copyNotice = null
          } catch {
            copyNotice = null
          }
        }
        render()
        maybeAutoChangelog()
        return
      }
      case 'wait-latest': {
        // 等新版（#156）：与"已知晓"同效果——只清面板锁存，不调电话、不写跳过；
        // 话术贴场景：最新版满门限后照常可装，旧账已销。
        fallbackOffer = null
        clearLatch()
        sayCopyKey('panel.toast.failure-dismissed')
        render()
        return
      }
      case 'skip': {
        const v = snapshot?.latestVersion ?? null
        if (v && validReleaseVersion(v)) {
          try {
            skipStore.skip(v)
          } catch {
            // 跳记不进去也不挡更新，只是不免打扰。
          }
        }
        render()
        return
      }
      case 'reset-skip': {
        try {
          skipStore.reset(arg ?? snapshot?.latestVersion ?? undefined)
        } catch {
          // 同上。
        }
        await refresh()
        return
      }
      case 'copy-manual': {
        // #177：只复制当帧可信的命令；遗留值不提供按钮，这里再守一道（纵深防御）。
        if (manual && manualSource === 'frame') {
          try {
            await copyTextOut(manual)
            // v1.3：成功不改按钮文案/图标，只在按钮上方浮出「已复制」气泡（不再另发 toast，避免双重反馈）。
            showCopyBubble(copyAnchorEl)
          } catch {
            sayCopyKey('panel.toast.copy-manual-fail')
          }
        }
        copyAnchorEl = null
        render()
        return
      }
      case 'copy-diag': {
        const jobCode = snapshot?.job?.state === 'failed' ? messageCodeOf(snapshot.job.message) || 'install-failed' : ''
        // 健康态诚实复制（#58）：没有失败就不伪造失败码，只给当前状态快照。
        if (!latch && !jobCode && !snapshot?.blockedReason && snapshot) {
          // 健康态复制：缺席不写注入的假版号、不谎称已是最新（#134/US16/US19）。
          // 文案实现在 panel-copy（#166 切片 2），内核只留分支条件与复制动作。
          const text = buildHealthyDiagCopy({
            canInstall: snapshot.canInstall,
            latestVersion: snapshot.latestVersion,
            installed: snapshot.installed,
            runningVersion: snapshot.runningVersion,
            installedVersion: snapshot.installedVersion,
            queuePosition: queue?.position ?? null,
            pluginId,
            hostKind: hostKind ?? envHostKind,
            profileName: profileNameOption ?? envProfileName,
            requestId,
            checkId: receipt?.checkId ?? null,
            updater: envUpdater,
            // #212 日志健康：与面板日志区同一句（单一措辞源）；老宿主没有读数即不出现。
            logHealth: envLogHealth,
            transportFailStreak,
            clientDropped: clientDroppedRows(),
            format: diagCopyFormat,
            lang: currentLang(),
          })
          actionBytes = utf8ByteLength(text)
          actionTruncated = text.length >= PANEL_DIAG_MAX_CHARS
          try {
            await copyTextOut(text)
            sayCopyKey('panel.toast.copy-state-ok')
          } catch {
            sayCopyKey('panel.toast.copy-diag-fail')
          }
          render()
          return
        }
        // #58：锁存存在即锁定致命回包的 frozen 证据；只有无锁存才走旧的实时回退链。
        const frozen = latch
        const code = frozen?.code ?? failureCodeOf({ error: null, errorKind: null }, jobCode || snapshot?.blockedReason || 'check-failed')
        const detail =
          frozen?.detail ??
          (snapshot?.job?.message && snapshot.job.message.includes(':')
            ? snapshot.job.message.slice(snapshot.job.message.indexOf(':') + 1)
            : snapshot?.job?.message)
        const text = buildUpdateDiagCopy({
          pluginId,
          code,
          detail,
          runningVersion: frozen?.runningVersion ?? snapshot?.runningVersion ?? null,
          installedVersion: frozen?.installedVersion ?? snapshot?.installedVersion ?? null,
          latestVersion: frozen?.latestVersion ?? snapshot?.latestVersion ?? null,
          targetVersion: frozen?.targetVersion ?? null,
          hostKind: frozen?.hostKind ?? hostKind ?? envHostKind,
          profileName: frozen?.profileName ?? profileNameOption ?? envProfileName,
          queuePosition: queue?.position ?? null,
          requestId: frozen?.requestId ?? requestId,
          checkId: frozen?.checkId ?? receipt?.checkId ?? null,
          route: null,
          diag: frozen?.diag ?? null,
          manual,
          updater: envUpdater,
          // #212 日志健康：与面板日志区同一句（单一措辞源）；老宿主没有读数即不出现。
          logHealth: envLogHealth,
          // #214 连接计数：轮询传输失败与客户端丢弃计数（0 时不追加，老输出逐字不变）。
          transportFailStreak,
          clientDropped: clientDroppedRows(),
          format: diagCopyFormat,
          lang: currentLang(),
        })
        actionBytes = utf8ByteLength(text)
        actionTruncated = text.length >= PANEL_DIAG_MAX_CHARS
        try {
          await copyTextOut(text)
          sayCopyKey('panel.toast.copy-diag-ok')
        } catch {
          sayCopyKey('panel.toast.copy-diag-fail')
        }
        render()
        return
      }
      case 'dismiss-failure': {
        // 显式确认（#58）：只清面板锁存，不调电话、不写跳过；下次查/装将重新评估。
        clearLatch()
        sayCopyKey('panel.toast.failure-dismissed')
        render()
        return
      }
      case 'toggle-queue': {
        showOthers = !showOthers
        await refresh()
        return
      }
      case 'toggle-changelog': {
        changelogCollapsed = !changelogCollapsed
        render()
        return
      }
      // 「请重启DSH」：宿主没有重启自己的电话，所以只做入口——
      // 调用方给了 onRestartRequested 就交给它；没给就如实说“请手动重启”，不假装。
      case 'restart-hint': {
        try {
          if (typeof onRestartRequested === 'function') {
            await onRestartRequested()
            sayCopyKey('panel.toast.restart-delegated')
          } else {
            sayCopyKey('panel.toast.restart-manual')
          }
        } catch {
          sayCopyKey('panel.toast.restart-failed')
        }
        render()
        return
      }
      case 'close-view': {
        await requestDialogClose()
        return
      }
    }
  }

  async function setMode(next: UpdatePanelMode): Promise<void> {
    if (next !== 'embedded' && next !== 'dialog') {
      throw new Error(`[dsh-plugin-update] 摆放形态非法：只收 embedded 或 dialog（收到 ${JSON.stringify(next)}）`)
    }
    mode = next
    render()
  }

  async function setTheme(next: UpdatePanelTheme): Promise<void> {
    if (next !== 'default' && next !== 'archive') {
      throw new Error(`[dsh-plugin-update] 主题非法：只收 default 或 archive（收到 ${JSON.stringify(next)}）`)
    }
    theme = normalizePanelTheme(next)
    render()
  }

  async function setThemeTokens(next: UpdateThemeTokens | undefined): Promise<void> {
    themeTokensStyleFor(next ?? undefined)
    themeTokens = next ?? undefined
    render()
  }

  async function setShowOthers(show: boolean): Promise<void> {
    showOthers = show === true
    await refresh()
  }

  async function setChangelogCollapsed(collapsed: boolean): Promise<void> {
    changelogCollapsed = collapsed === true
    render()
  }

  function onClick(ev: unknown): void {
    try {
      const t = ev as {
        target?: { closest?: (sel: string) => { getAttribute?: (n: string) => string | null } | null } | null
        preventDefault?: () => void
      }
      // 日志里的链接先于动作分支：渲染期只认 http/https，这里再筛一次（纵深防御），
      // 落地走 options.openLink，缺省开新窗口——面板正文永不被导航走。
      const anchor = t?.target && typeof t.target.closest === 'function' ? t.target.closest('a[data-openlink][href]') : null
      const href = anchor?.getAttribute ? anchor.getAttribute('href') : null
      if (href && /^https?:\/\//i.test(href)) {
        if (typeof t?.preventDefault === 'function') t.preventDefault()
        try {
          void Promise.resolve(openLinkOut(href)).catch(() => {})
        } catch {
          // 落地抛错只吞：外链开不出来不挡更新。
        }
        return
      }
      const btn = t?.target && typeof t.target.closest === 'function' ? t.target.closest('[data-action]') : null
      const kind = btn?.getAttribute ? btn.getAttribute('data-action') : null
      if (!kind) return
      // v1.3 气泡要贴着按钮浮出：点击时把按钮元素交给动作体量一次矩形（拿不到就兜底）。
      copyAnchorEl = btn
      void act(kind as UpdatePanelActionKind)
    } catch {
      // 点坏了也不挡更新。
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

  function setChangelogMarkdown(markdown: string | null): void {
    changelogMarkdown = typeof markdown === 'string' ? markdown : null
    // 显式文本不绑版本：所属版本置空，空白分支的清理闸门就不认它（显式内容永远赢）。
    changelogMarkdownFor = null
    // #213：显式给文本即接管——宿主判定的分档随之作废，绝不在显式内容旁边再插一句判定。
    changelogStatus = null
    changelogStatusFor = changelogStatusVersionNow()
    // 显式 wins（#38）：手动给过文本后自动链路不再覆盖（同版本只问一次，本来也不会再问）。
    if (typeof markdown === 'string') manualChangelogOverride = true
    render()
  }

  function unmount(): void {
    if (!mounted) return
    mounted = false
    logShell.removeGlobalHandlers()
    try {
      unsubLang()
    } catch {
      // 停不掉也无妨。
    }
    // 过期回包丢弃（#38）：序号加一 + 在途集合清空，在飞的取数回来即丢，不写已拆的面板。
    autoSeq++
    changelogInflight.clear()
    try {
      timer.clear(handle)
    } catch {
      // 停不掉也无妨：安装在宿主侧跑，面板计时器只是轮询。
    }
    // 气泡计时器随面板一起停，拆掉后不再回调重绘。
    if (copyBubbleTimer !== null) {
      try { clearTimeout(copyBubbleTimer) } catch { /* 忽略 */ }
      copyBubbleTimer = null
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
    // 自建通道（含它没发完的队列）随面板一起停；调用方注入的通道归调用方管，我们只停手。
    logShell.dispose()
    // 卸载只停轮询：绝不调安装/取消电话，安装在宿主进程内继续跑。
  }

  // #61 v2 语言跟随：已挂载控件即时重绘，unmount 后停订（单例观察者，显式 locale 对象亦经同一出口）。
  // #122 语言行也挂在这个出口上：语言真的变了才落一行（与重绘同一判据，不会因为重绘而多发）。
  const unsubLang = subscribeLang(() => {
    render()
    logLangApplied()
  }, localeOpt)
  // 首绘即 loading：先做一次只读本地的状态刷新，拿到活体快照后再判定是否自动查一次（#48）。
  // 轮询心跳永远只做只读本地的状态刷新，不触发查新版；自动查复用手动查同一通路（act('check')），
  // 并发只信服务端真相源（busyAct 互斥 + checking 在途复用 + 2 秒复用窗口），卸载靠 mounted 丢弃。
  render()
  try {
    container.addEventListener?.('click', onClick)
  } catch {
    // 没有事件能力的容器也能看（按钮调 controller.act）。
  }
  try {
    container.addEventListener?.('keydown', onKeyDown)
  } catch {
    // 没有键盘事件能力的容器忽略（Esc 关弹窗是渐进增强）。
  }
  // #214 全局兜底（渐进增强）：有 addEventListener 的环境才注册，unmount 摘掉。
  installGlobalHandlers()
  const timer = getTimer()
  const handle = timer.set(() => {
    if (busyAct) return
    void refresh()
  }, pollMs)
  try {
    // 轮询不占进程退出：安装在宿主侧跑，面板计时器只是视图刷新。
    const h = handle as { unref?: () => void } | null
    if (h && typeof h.unref === 'function') h.unref()
  } catch {
    // 无 unref 的环境（浏览器）忽略。
  }
  // mount 串行（#211 AC-2）：首绘 loading → await refresh（只读本地）→ 判定自动检查四态 → 落挂载行 →
  // 只有确实要查（started）才复用手动查同一通路；轮询永不查新版。
  // 挂载行必须等首刷回来才发：autoCheck 记的是「这面面板挂载后有没有自动跑检查」，四态里
  // disabled（调用方关掉）/ failed（首刷拿不到状态）/ recent（状态本身新鲜、已有动作在途）/ started，
  // 只有首刷回来才判得准；任何走到这里的路径恰好发一条（参数/挂载校验失败在更早处已抛，到不了这里）。
  void (async () => {
    let firstRefreshFailed = false
    try {
      await refresh()
    } catch {
      // refresh 自身吞传输错误（从不 reject）；这里只兜意外抛出，仍按「拿不到状态」记 failed。
      firstRefreshFailed = true
    }
    const autoCheck: 'started' | 'recent' | 'disabled' | 'failed' = !autoCheckEnabled
      ? 'disabled'
      : firstRefreshFailed || snapshot === null
        ? 'failed'
        : !pendingAutoCheck(snapshot, busyAct)
          ? 'recent'
          : 'started'
    logClient('info', 'update.panel.mount', { ...mountRowFields, autoCheck })
    if (autoCheck === 'started') {
      try {
        void act('check')
      } catch {
        // 自动查失败已在 act 内渲染为既有失败文案，这里不另行处理。
      }
    }
  })()

  return { refresh, act, setMode, setTheme, setThemeTokens, setShowOthers, setChangelogCollapsed, setChangelogMarkdown, unmount }
}
