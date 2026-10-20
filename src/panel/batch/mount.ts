/**
 * src/panel/batch/mount.ts —— 批量面板挂载层（#229 自旧 src/panel-batch.ts 挂载段拆出）。
 *
 * 唯一碰副作用的一层：轮询、事件、动作、控制器与日志壳（另带少量纯辅助：行读取/诊断文本）。
 * 向下依赖 helpers、ledger、render；不向外暴露控制面。
 */

import { buildLogAppendPhoneName, DEFAULT_PREFIX } from '../../shared/config.js'
import { hash8 } from '../../shared/hash.js'
import { createPanelClientLogShell } from '../../log/panel-client.js'
import { copyText as bilingualText } from '../../core/i18n/text.js'
import { subscribeLang } from '../../shared/lang.js'
import { validReleaseVersion } from '../../core/service.js'
import { shouldFetchChangelog } from '../../core/changelog/parse.js'
import { normalizeBatchSession } from '../../core/batch/model.js'
import { buildDiagnosticText, createBrowserSkipStore, failureCopy, normalizePanelTheme, readDiagTolerant, themeTokensStyleFor } from '../../panel.js'
import { formatUnlockAt } from '../../core/cause.js'
import type { AppLang, LocaleOption } from '../../shared/lang.js'
import type { BatchSession } from '../../core/batch/model.js'
import type { PanelDiagnosticInput, PanelSkipStore, UpdatePanelTheme, UpdateThemeTokens } from '../../panel.js'
import { BATCH_PANEL_POLL, asBatchPhase, batchFailedRows, batchFallbackCauseOf, buildBatchPhoneNames, cancelQueuePhoneOf, compliantInstalledOf, isObject, jobFailureOf, latestVersionOf, pluginIdOf, queuedRequestIdOf, singleCheckPhoneOf, singleFallbackPhoneOf, titleOf } from './helpers.js'
import { batchText, hasUnfinishedRows, langOf, unfinishedCount } from './ledger.js'
import { batchFailedManualText, renderBatchPanelHTML } from './render.js'
import type { BatchPanelActionKind, BatchPanelContainer, BatchPanelController, BatchPanelMode, BatchPanelOptions, BatchPhoneNames, BatchRowView } from '../../panel-batch.js'

/**
 * #243：自动续跑只对「新鲜」会话生效。打开面板就静默续跑两小时前的旧会话，
 * 用户以为只是「检查更新」——超过这个时长的旧会话必须由用户显式点「继续上次未完成的更新」。
 */
const AUTO_RESUME_MAX_AGE_MS = 10 * 60 * 1000

/** 候选安装要打的电话：该家自己的单插件安装电话（带 version 走第二槽绑定）；老宿主不给即装不了候选。 */
export function singleInstallPhoneOf(row: BatchRowView): string | null {
  const phones = isObject(row.phoneNames) ? (row.phoneNames as Record<string, unknown>) : null
  if (!phones) return null
  const name = phones['updateInstall']
  return typeof name === 'string' && name ? name : null
}

/**
 * 决议回包的机读结论（#156，纯函数）：行内单家与批量级两条路共用同一套解析，
 * 免得两处各解一遍、日后只改一处。candidate/checkId 只在这一版真能用时给出（点名要精）。
 */
export function fallbackOutcomeOf(reply: unknown): {
  kind: string
  candidate: string
  checkId: string
  unlockAtMs: number | null
} {
  if (!isObject(reply) || reply['ok'] === false) return { kind: '', candidate: '', checkId: '', unlockAtMs: null }
  const snap = isObject(reply['snapshot']) ? (reply['snapshot'] as Record<string, unknown>) : null
  const verdict = snap && isObject(snap['verdict']) ? (snap['verdict'] as Record<string, unknown>) : null
  const kind = verdict && typeof verdict['kind'] === 'string' ? (verdict['kind'] as string) : ''
  const version = verdict && typeof verdict['version'] === 'string' ? (verdict['version'] as string).trim() : ''
  const snapCandidate = snap && typeof snap['candidate'] === 'string' ? (snap['candidate'] as string).trim() : ''
  const rec = isObject(reply['receipt']) ? (reply['receipt'] as Record<string, unknown>) : null
  const checkId = rec && typeof rec['checkId'] === 'string' ? (rec['checkId'] as string) : ''
  const unlockAtMs = verdict && typeof verdict['unlockAtMs'] === 'number' ? (verdict['unlockAtMs'] as number) : null
  const candidate = snapCandidate || (kind === 'ok-now' ? version : '')
  const usable = (kind === 'downgrade-available' || kind === 'ok-now') && candidate !== '' && checkId !== ''
  return { kind, candidate: usable ? candidate : '', checkId: usable ? checkId : '', unlockAtMs }
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

/**
 * diag 结构化字段的机器后缀（#84）：宽容读电话侧 diag，把阶段/路由/方法/HTTP/exit/耗时/源等
 * 组一段 `k=v` 拼起来的后缀，拼进复制文本的摘要段。标签是机器 tag（与 buildUpdateDiagCopy
 * 里硬编码的 HTTP=/exit= 同口径，不进双语字典、不新增键）；缺省即整段省略。
 */
function diagStructuredSuffix(diagValue: unknown): string | null {
  const t = readDiagTolerant(diagValue)
  const parts: string[] = []
  if (t.stage) parts.push('stage=' + t.stage)
  if (t.route) parts.push('route=' + t.route)
  if (t.method) parts.push('method=' + t.method)
  if (typeof t.httpStatus === 'number') parts.push('HTTP=' + String(t.httpStatus))
  if (typeof t.exitCode === 'number') parts.push('exit=' + String(t.exitCode))
  if (typeof t.latencyMs === 'number') parts.push('latency=' + String(t.latencyMs) + 'ms')
  if (t.registryHost) parts.push('source=' + t.registryHost)
  if (t.action) parts.push('action=' + t.action)
  if (t.requestId) parts.push('request=' + t.requestId)
  if (t.checkId) parts.push('check=' + t.checkId)
  return parts.length > 0 ? parts.join(' · ') : null
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
  const baseDetail =
    diagDetail !== null
      ? diagDetail
      : job !== null && job.detail !== null
        ? job.detail + batchText('batch.diag.source-job', langOf(lang))
        : null
  // 结构化 diag 与摘要同段进复制文本（面板只渲染：原样拼，不推导；无结构化即整段省略）。
  const structured = diagStructuredSuffix(row.diag)
  const detail =
    baseDetail !== null && structured !== null
      ? baseDetail + ' [' + structured + ']'
      : (baseDetail ?? structured)
  const input: PanelDiagnosticInput = {
    pluginId: pluginIdOf(row),
    code: job !== null && job.code !== null ? job.code : row.error || 'check-failed',
    detail,
    // #215：缺席目标没有运行版——快照若还带着集成方注入的占位版号（旧宿主/旧缓存可能是
    // 0.0.0），复制文本一律按未知显示，绝不让假版号漏进用户贴出去的诊断。
    runningVersion: snapshot && snapshot['installed'] !== false ? text(snapshot['runningVersion']) : null,
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

/**
 * 全部失败行的诊断文本（#176）：逐行调 diagTextOf 原样拼，块间空行，零抬头、零新格式。
 * 集合只认 batchFailedRows（与失败横幅同一份真源），顺序跟面板行序；没有失败行即空串。
 */
export function batchFailedDiagText(rows: readonly BatchRowView[], lang?: string | null): string {
  return batchFailedRows(rows)
    .map((row) => diagTextOf(row, lang))
    .join('\n\n')
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
  // #208：批量面板复用单面板同一份客户端日志壳（src/log/panel-client.ts），mode:'batch' 由调用方经 mount 传入。
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
    clientLog: options && typeof options === 'object' ? options.clientLog : undefined,
    call:
      options && typeof options === 'object' && typeof (options as { call?: unknown }).call === 'function'
        ? (options as { call: (phoneName: string, args: Record<string, unknown>) => Promise<unknown> }).call
        : null,
    logAppendPhone: buildLogAppendPhoneName(channelPrefix),
    coerceReply: true,
  })
  const logClient = logShell.log
  const emitRenderFail = logShell.emitRenderFail
  const failMount = logShell.failMount
  const errorTextOf = logShell.errorTextOf
  const installGlobalHandlers = logShell.installGlobalHandlers
  const clientLogMountName = logShell.mountName

  if (!options || typeof options !== 'object') {
    const message = '[dsh-plugin-update] 挂载批量面板缺少配置：批量电话前缀 prefix 必填'
    failMount('prefix', message)
    throw new Error(message)
  }
  if (typeof options.call !== 'function') {
    const message = '[dsh-plugin-update] 挂载批量面板需要传输函数 call（面板调宿主电话的唯一接触面）'
    failMount('call', message)
    throw new Error(message)
  }
  // 先建通道再校验容器（#214 同序）：容器不合法时也要先把失败证据送出去。
  if (!container || typeof container.innerHTML !== 'string') {
    const message = '[dsh-plugin-update] 挂载批量面板需要一个有 innerHTML 的容器'
    failMount('container', message)
    throw new Error(message)
  }
  let phones: BatchPhoneNames
  try {
    phones = buildBatchPhoneNames(options.prefix)
  } catch (err) {
    failMount('prefix', errorTextOf(err))
    throw err
  }
  const pollMs = options.pollMs === undefined ? BATCH_PANEL_POLL.defaultMs : options.pollMs
  if (typeof pollMs !== 'number' || !Number.isFinite(pollMs) || pollMs < BATCH_PANEL_POLL.minMs) {
    const message =
      '[dsh-plugin-update] 批量面板轮询间隔非法：不得小于 250 毫秒（收到 ' + JSON.stringify(options.pollMs) + '）'
    failMount('poll-ms', message)
    throw new Error(message)
  }
  let mode: BatchPanelMode = options.mode === undefined ? 'embedded' : options.mode
  if (mode !== 'embedded' && mode !== 'dialog') {
    const message =
      '[dsh-plugin-update] 摆放形态非法：只收 embedded 或 dialog（收到 ' + JSON.stringify(options.mode) + '）'
    failMount('mode', message)
    throw new Error(message)
  }
  if (options.theme !== undefined && options.theme !== 'default' && options.theme !== 'archive') {
    const message =
      '[dsh-plugin-update] 主题非法：只收 default 或 archive（收到 ' + JSON.stringify(options.theme) + '）'
    failMount('theme', message)
    throw new Error(message)
  }
  let theme: UpdatePanelTheme = normalizePanelTheme(options.theme ?? 'default')
  // 主题变量覆盖：挂载时校验（非法即抛），合法存下，每次 render 拼到根上（详情行经继承生效）。
  try {
    themeTokensStyleFor(options.themeTokens ?? undefined)
  } catch (err) {
    failMount('theme-tokens', errorTextOf(err))
    throw err
  }
  let themeTokens: UpdateThemeTokens | undefined = options.themeTokens
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
  // 自动决议（#156 第一性原理）：默认开——撞了年龄门就自己问一遍"能装的最新是哪版"，
  // 有候选直接把点名确认条端上来，用户不必先找到按钮。宿主若不想在开面板时打这些电话可显式关掉。
  const autoPlanEnabled = options.autoCompliant !== false
  const rowChangelog = new Map<string, { version: string; markdown: string | null }>()
  const rowInflight = new Set<string>()
  // 失败退避时间戳（行 key + 版本 -> 失败时刻毫秒）：轮询按退避问，反复展开不再每秒重问；
  // 换版（新 key）、批量查一次、重开面板即忘。
  const rowFailedAt = new Map<string, number>()
  let rowAutoSeq = 0

  let rows: BatchRowView[] = []
  let expandedKey: string | null = null
  let lastError: string | null = null
  // 失败闩（#208）：`lastError` 是字符串，同一错误码连续失败两次看不出「变过」；
  // 动作壳按对象身份判断「这次动作期间有没有新失败」（与单面板 panel.ts 的 latch 同口径）。
  let failureLatch: { code: string } | null = null
  /** 记一次失败：字符串给面板红条，闩给动作行判断（每次都是新对象，重复同码也算新失败）。 */
  function noteFailure(code: string): void {
    lastError = code
    failureLatch = { code: code }
  }
  /** 回包成功：红条与闩一起清（面板显示与动作行判断必须同一口径）。 */
  function clearFailure(): void {
    lastError = null
    failureLatch = null
  }
  let notice: string | null = null
  let noticeKey: string | null = null
  let inFlight = false
  /** 在途的是查类电话（读-读让路，#87 防抖）；装类在途不抑制轮询（#90 R3：查询不被命令饿死）。 */
  let inFlightIsCheck = false
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
  /** update.panel.mount 的固定字段（挂载时冻结；mode 名取调用方 mount 覆盖值，#208）。 */
  const mountRowFields = { mode: clientLogMountName || mode, theme, lang: currentLang(), pollMs }
  const checkOnOpenOption = (options as unknown as Record<string, unknown>)['checkOnOpen'] !== false
  const autoResumeOption = (options as unknown as Record<string, unknown>)['autoResume'] !== false
  let lastSession: unknown = null
  let lastInventory: unknown = null
  let lastPrefs: unknown = null
  let lastCheckedAt = 0
  let autoCheckDone = false
  let autoResumeDone = false
  // #208 失败证据：挂载行只发一次；首次 refresh 与自动检查的结局决定 autoCheck 档位。
  let mountRowLogged = false
  let firstRefreshFailed = false
  let autoCheckOutcome: 'started' | 'recent' | 'disabled' | 'failed' | null = null
  /** 当前动作是否被忙守卫拒掉（由 phone() 置位，动作壳在 finally 里读）。 */
  let currentActionSkips: { busy: boolean } | null = null
  /** 各行已决议出的候选（#156）：行 key -> {candidate, checkId, targetVersion}；行刷新/新失败即 prune，不许旧决议指新失败。 */
  const rowFallbackOffers = new Map<string, { candidate: string; checkId: string; targetVersion: string }>()
  /** 正在决议中的那一行（键；在途短暂置灰，防连点）。 */
  let fallbackBusyKey: string | null = null
  /** 批量级合规版清单（#156）：批量入口决议出的行键；用户点名确认后逐家装，账本相位一个字不改（#152）。 */
  let batchCompliantKeys: string[] = []

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
    // #208：渲染也带兜底——画挂了落一条 paint/render，面板不能把轮询/动作链路一起带崩。
    try {
      paint()
    } catch (err) {
      emitRenderFail('paint', 'render', errorTextOf(err) || 'render-failed')
    }
  }

  function paint(): void {
    const offers: Record<string, { candidate: string; targetVersion: string } | null> = {}
    for (const [k, v] of rowFallbackOffers) offers[k] = { candidate: v.candidate, targetVersion: v.targetVersion }
    // 批量级确认清单只认还在的决议（行不再失败/换了目标即 prune，此处再过滤一次兜底）。
    const confirmKeys = batchCompliantKeys.filter((k) => rowFallbackOffers.has(k))
    const wait = waitingOf()
    const nextHTML = renderBatchPanelHTML({
      rows,
      theme,
      themeTokens,
      mode,
      expandedKey,
      lastError,
      notice,
      noticeKey,
      skippedVersions: skippedVersionsOf(),
      inFlight,
      loaded,
      staleResults: staleResultsActive(),
      titles,
      confirmCancel: confirmCancelArmed,
      changelogs: changelogView(),
      session: lastSession,
      inventory: lastInventory,
      prefs: lastPrefs,
      lang: currentLang(),
      fallbackOffers: offers,
      fallbackBusyKey,
      compliant: {
        // 还需要动作的（自动决议还没给出结论的）：有年龄门证据、有电话、且还没候上/还没装上。
        gated: rows.filter((row) => needsAutoResolve(row)).length,
        confirmList: confirmKeys.length > 0 ? compliantListText(confirmKeys) : null,
        confirmCount: confirmKeys.length,
        busy: inFlight,
        wait: wait.keys.length > 0 ? wait : null,
        unlocks: unlockTimesOf(),
      },
    })
    if (nextHTML !== lastHTML) {
      lastHTML = nextHTML
      setStableHTML(container, nextHTML)
    }
  }

  /** 旧决议不指新失败（#156）：行不失败/换了目标即忘掉该行候选；渲染侧已先忽略，这里清掉不再长大。 */
  function pruneFallbackOffers(): void {
    try {
      for (const [k, v] of [...rowFallbackOffers]) {
        const row = rowOfKey(k)
        if (!row || asBatchPhase(row.phase) !== 'failed' || v.targetVersion !== latestVersionOf(row)) {
          rowFallbackOffers.delete(k)
        }
      }
      if (batchCompliantKeys.length > 0) batchCompliantKeys = batchCompliantKeys.filter((k) => rowFallbackOffers.has(k))
    } catch {
      // 清不掉也不挡更新，下次渲染照样忽略旧决议。
    }
  }

  /** 点名清单（#156）：标题 + 精确版本，横幅与确认按钮共用同一串，用户先看见版本号再点。 */
  function compliantListText(keys: readonly string[]): string {
    const sep = currentLang() === 'en' ? ', ' : '、'
    return keys
      .map((k) => {
        const row = rowOfKey(k)
        const offer = rowFallbackOffers.get(k)
        return row && offer ? titleOf(row, titles) + ' ' + offer.candidate : ''
      })
      .filter((text) => text !== '')
      .join(sep)
  }

  // ---------- 自动决议（#156 第一性原理） ----------

  // 决议记忆（会话内）：这一家上次问出什么结论、最新版大约什么时候解封。
  // 用途三件：(a) 收尾事实里说清"最新版还挡多久"；(b) 没候选时不画一个点了也没用的按钮；
  // (c) 解封时刻一到就重新决议（签名会变），那时的答案可能变成"现在能装了"。
  // 页面刷新就忘——忘了只是回到"重新问一次"，永远不会撒谎。
  const gatedOutcomes = new Map<string, { kind: string; unlockAtMs: number | null }>()
  let autoPlanSignature = ''
  let autoPlanRunning = false

  /** 这一行现在还需不需要自动决议：有失败证据、有电话、还没装上合规版、且不是"问过在等解封"。 */
  function needsAutoResolve(row: BatchRowView): boolean {
    try {
      if (batchFallbackCauseOf(row) === null || singleFallbackPhoneOf(row) === null) return false
      if (compliantInstalledOf(row) !== null) return false
      if (rowFallbackOffers.has(row.key)) return false
      const seen = gatedOutcomes.get(row.key)
      if (seen) {
        // 已经装上过一次（这一轮）或问过且确实没有可装版：别反复问同一句。
        if (seen.kind === 'installed') return false
        if (seen.kind === 'wait-until') {
          if (seen.unlockAtMs === null) return false
          if (nowMs() < seen.unlockAtMs) return false
        }
      }
      return true
    } catch {
      return false
    }
  }

  /** 决议一次（走该家自己的电话）：解析成结论、顺手记进记忆；有候选即挂上点名确认。 */
  async function resolveGated(row: BatchRowView): Promise<{
    kind: string
    candidate: string
    checkId: string
    unlockAtMs: number | null
  }> {
    const cause = batchFallbackCauseOf(row)
    const phoneName = singleFallbackPhoneOf(row)
    if (!cause || phoneName === null) return { kind: '', candidate: '', checkId: '', unlockAtMs: null }
    let reply: unknown = null
    try {
      reply = await call(phoneName, {
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
    const outcome = fallbackOutcomeOf(reply)
    gatedOutcomes.set(row.key, { kind: outcome.kind, unlockAtMs: outcome.unlockAtMs })
    if (outcome.candidate) {
      rowFallbackOffers.set(row.key, {
        candidate: outcome.candidate,
        checkId: outcome.checkId,
        targetVersion: cause.targetVersion,
      })
    }
    return outcome
  }

  /**
   * 自动决议（#156 第一性原理）：撞了 24 小时年龄门之后，用户要的是"能装的最新"，
   * 不是"自己去点按钮找一遍"。条件够了就自己问（串行、互不干扰）：有候选就把点名版本的确认条端上来，
   * 没有候选就由横幅如实说等多久。三道闸：签名去重（同一批失败 + 同一批目标只问一次）、
   * 会话内在途、老宿主没这条电话的行一概不问（诚实缺省）。
   */
  function maybeAutoPlanCompliant(): void {
    if (!autoPlanEnabled || !mounted || inFlight || autoPlanRunning) return
    let signature = ''
    const targets: BatchRowView[] = []
    try {
      for (const row of rows) {
        if (!needsAutoResolve(row)) continue
        targets.push(row)
        signature += row.key + '@' + (latestVersionOf(row) ?? '') + ';'
      }
    } catch {
      return
    }
    if (targets.length === 0 || signature === autoPlanSignature) return
    autoPlanSignature = signature
    autoPlanRunning = true
    inFlight = true
    render()
    void (async () => {
      try {
        for (const row of targets) {
          if (!mounted) return
          if (!needsAutoResolve(row)) continue
          await resolveGated(row)
        }
      } finally {
        autoPlanRunning = false
        inFlight = false
      }
      if (!mounted) return
      // 并入而不是覆盖：手动那条路已经得出的候选不许丢。
      const merged = [...batchCompliantKeys]
      for (const row of targets) {
        if (rowFallbackOffers.has(row.key) && !merged.includes(row.key)) merged.push(row.key)
      }
      batchCompliantKeys = merged.filter((k) => rowFallbackOffers.has(k))
      if (batchCompliantKeys.length > 0) clearNotice()
      render()
      maybeAutoRowChangelog(expandedKey)
    })()
  }

  /** 等解封的行（决议记忆说 wait-until、且还没装上）：横幅说清是谁、等多久，这些行不画按钮。 */
  function waitingOf(): { keys: string[]; unlockAtMs: number | null } {
    const keys: string[] = []
    let earliest: number | null = null
    try {
      for (const row of rows) {
        const seen = gatedOutcomes.get(row.key)
        if (!seen || seen.kind !== 'wait-until') continue
        if (compliantInstalledOf(row) !== null) continue
        if (batchFallbackCauseOf(row) === null || singleFallbackPhoneOf(row) === null) continue
        keys.push(row.key)
        if (typeof seen.unlockAtMs === 'number' && (earliest === null || seen.unlockAtMs < earliest)) {
          earliest = seen.unlockAtMs
        }
      }
    } catch {
      return { keys: [], unlockAtMs: null }
    }
    return { keys, unlockAtMs: earliest }
  }

  /** 收尾事实（#156）要用的解封时刻（按行 key）：只给"最新版还挡多久"这一句话用。 */
  function unlockTimesOf(): Record<string, number | null> {
    const out: Record<string, number | null> = {}
    try {
      for (const [k, v] of gatedOutcomes) out[k] = v.unlockAtMs
    } catch {
      // 读不到即没有时刻，措辞退回中性那句。
    }
    return out
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
  async function copyWith(text: string, okNotice: string, key: string | null): Promise<void> {
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
      noteFailure('internal')
      return
    }
    if (reply['ok'] === true) {
      const hasSession = 'session' in reply && reply['session'] !== undefined
      const hasRows = 'rows' in reply && reply['rows'] !== undefined
      // Prefs-only save carries no ledger or rows: only flip the switch, keep the table (#74 flicker).
      if (!hasSession && !hasRows) {
        if (isObject(reply['prefs'])) lastPrefs = reply['prefs']
        return
      }
      if (hasSession) {
        const session = normalizeBatchSession(reply['session'])
        lastSession = session
        if (hasRows) {
          const parsed = readRows(reply['rows'])
          rows = parsed.length > 0 ? parsed : rowsFromSession(session)
        } else {
          rows = rowsFromSession(session)
        }
      } else {
        const parsed = readRows(reply['rows'])
        if (parsed.length > 0) rows = parsed
      }
      if (isObject(reply['inventory'])) {
        lastInventory = reply['inventory']
        const at = (reply['inventory'] as Record<string, unknown>)['updatedAt']
        if (typeof at === 'number' && Number.isFinite(at) && at > 0) lastCheckedAt = at
      }
      if (isObject(reply['prefs'])) lastPrefs = reply['prefs']
      loaded = true
      clearFailure()
      if (expandedKey !== null && !rows.some((row) => row.key === expandedKey)) expandedKey = null
      pruneFallbackOffers()
      return
    }
    const err = typeof reply['error'] === 'string' ? reply['error'].trim() : ''
    const kind = typeof reply['errorKind'] === 'string' ? reply['errorKind'].trim() : ''
    noteFailure(kind || err || 'internal')
  }

  async function refresh(): Promise<void> {
    if (!mounted || refreshing) return
    refreshing = true
    try {
      const reply = await call(phones.status, {})
      if (!mounted) return
      applyReply(reply)
    } catch (err) {
      if (!mounted) return
      noteFailure('check-failed')
      // #208：轮询/刷新传输失败落一条 poll/transport；首次刷新失败决定挂载行 autoCheck='failed'。
      if (!mountRowLogged) firstRefreshFailed = true
      emitRenderFail('poll', 'transport', errorTextOf(err) || 'transport-failed')
    } finally {
      refreshing = false
    }
    render()
    maybeAutoRowChangelog(expandedKey)
    maybeAutoPlanCompliant()
  }

  /**
   * 打一次批量电话：飞之前先置忙（两个宏一起灰），回来后重绘。
   * busyRowKey 给「只推这一家」那条路：回包说忙时只给一句排队回执，绝不记成失败。
   * 回包原样返回（调用方按 resumed 等事实决定回执，杜绝空话成功）。
   */
  async function phone(name: string, args: Record<string, unknown>, busyRowKey: string | null = null): Promise<Record<string, unknown> | null> {
    if (!mounted || inFlight) {
      // 忙守卫拒掉的这次点击也要在动作行里如实记 busy（动作壳读 currentActionSkips）。
      if (currentActionSkips) currentActionSkips.busy = true
      return null
    }
    inFlight = true
    inFlightIsCheck = name === phones.check
    clearNotice()
    render()
    let out: Record<string, unknown> | null = null
    try {
      const reply = await call(name, args)
      if (!mounted) return null
      if (busyRowKey !== null && isBusyReply(reply)) {
        // 老宿主还没接住这次入队：如实说「没排上，等它装完再点」，不画失败横幅、不把行记成失败。
        if (currentActionSkips) currentActionSkips.busy = true
        say(batchText('batch.toast.queue-missed', currentLang()), busyRowKey)
        return null
      }
      applyReply(reply)
      // 批量查/装一次是明确意图：清掉各行失败退避，下面的按行链路可再问一次。
      rowFailedAt.clear()
      out = isObject(reply) ? (reply as Record<string, unknown>) : null
    } catch {
      if (!mounted) return null
      noteFailure('check-failed')
      out = null
    } finally {
      inFlight = false
      inFlightIsCheck = false
      if (mounted) render()
    }
    maybeAutoRowChangelog(expandedKey)
    maybeAutoPlanCompliant()
    return out
  }

  /** 旧账本结果可能过期的窗口：旧会话已收尾、挂载后的自动检查还没结论（#231）。 */
  function staleResultsActive(): boolean {
    if (lastSession === null) return false
    if (autoCheckOutcome !== null) return false
    if (!checkOnOpenEffective()) return false
    return !hasUnfinishedRows(rows, lastSession ?? undefined)
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

  /** 挂载行只发一次（#208）：首次 refresh 与自动检查落定后才知道 autoCheck 该写哪一档。 */
  function logMountRowOnce(): void {
    if (mountRowLogged || !mounted) return
    mountRowLogged = true
    const autoCheck =
      autoCheckOutcome ?? (firstRefreshFailed ? 'failed' : checkOnOpenEffective() ? 'recent' : 'disabled')
    logClient('info', 'update.panel.mount', { ...mountRowFields, autoCheck })
  }

  function nowMs(): number {
    try {
      return Date.now()
    } catch {
      return 0
    }
  }

  /**
   * 动作壳（#208，与单面板同形）：一次点击一条 update.panel.action。
   *
   * 成功/失败口径与 panel.ts 的 act 对齐：抛错记 `thrown`；动作期间**闩上新失败**（回包 ok:false、
   * 传输抛错、刷新失败）记失败稳定码；忙守卫拒掉的点击记 `busy`。`errorHash` 是失败稳定码的指纹。
   * 批量面板没有 bytes/truncated 语义，行里不塞。
   */
  async function act(kind: BatchPanelActionKind, key?: string): Promise<void> {
    if (!mounted) return
    // 点别的按钮，上膛的取消确认自动撤销（当即重绘，不等人）。
    if (kind !== 'cancel' && confirmCancelArmed) {
      confirmCancelArmed = false
      render()
    }
    const startedAtMs = Date.now()
    const skipToken: { busy: boolean } = { busy: false }
    currentActionSkips = skipToken
    const latchBefore = failureLatch
    let ok = true
    let errorKind: string | null = null
    let errorHash: string | null = null
    try {
      await runAct(kind, key)
    } catch (err) {
      ok = false
      errorKind = 'thrown'
      errorHash = hash8(errorTextOf(err))
      throw err
    } finally {
      if (ok && failureLatch !== latchBefore) {
        // 动作期间有新失败：面板已画红条，动作行必须说失败（否则 ok:true 与界面自相矛盾）。
        ok = false
        errorKind = failureLatch?.code ?? lastError ?? 'internal'
        errorHash = hash8(errorKind)
      } else if (ok && skipToken.busy) {
        ok = false
        errorKind = 'busy'
      }
      currentActionSkips = null
      logClient('info', 'update.panel.action', {
        action: kind,
        ok,
        errorKind,
        durationMs: Math.max(0, Date.now() - startedAtMs),
        ...(errorHash ? { errorHash } : {}),
      })
    }
  }

  async function runAct(kind: BatchPanelActionKind, key?: string): Promise<void> {
    if (!mounted) return
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
        // 与单面板 skip 同口径（#88）：版本号非法就不记也不 toast，静默重绘（单面板同例：守卫拦下即只 render）。
        if (!validReleaseVersion(version)) {
          render()
          return
        }
        try {
          skipStoreFor(pluginIdOf(row)).skip(version)
        } catch {
          // 跳记不进去也不挡更新，只是不免打扰。
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
      // 「查这一家」（#84）：走该家自己的单插件查新版电话（行 phoneNames 透传；老宿主没给即无入口）。
      // 单插件回包形状与批量回包不同，不进 applyReply：成功靠随后一次 refresh 把新快照读回来；
      // 失败只在该行留一句失败回执（failureCopy 已有键），行相位不动，不编造。
      case 'row-check': {
        const row = typeof key === 'string' && key ? rowOfKey(key) : null
        if (!row) return
        const phoneName = singleCheckPhoneOf(row)
        if (phoneName === null) return
        if (inFlight) return
        inFlight = true
        inFlightIsCheck = true
        clearNotice()
        render()
        try {
          const reply = await call(phoneName, { includeEnv: true, includeQueue: true })
          if (!mounted) return
          if (isObject(reply) && reply['ok'] !== true) {
            const rec = reply as Record<string, unknown>
            const kind = typeof rec['errorKind'] === 'string' && (rec['errorKind'] as string).trim() ? (rec['errorKind'] as string).trim() : ''
            const err = typeof rec['error'] === 'string' && (rec['error'] as string).trim() ? (rec['error'] as string).trim() : ''
            const code = kind || err || 'check-failed'
            const copy = failureCopy(code, currentLang())
            say(copy ? copy.zh + '｜' + copy.act : code, row.key)
          }
        } catch {
          if (mounted) {
            const copy = failureCopy('check-failed', currentLang())
            say(copy ? copy.zh + '｜' + copy.act : 'check-failed', row.key)
          }
        } finally {
          inFlight = false
          inFlightIsCheck = false
        }
        // 显式单查后退避清掉该行：下面的按行日志链路可再问一次；日志按需取一行，不碰别家。
        try {
          for (const k of [...rowFailedAt.keys()]) {
            if (k === row.key || k.startsWith(row.key + '\0')) rowFailedAt.delete(k)
          }
        } catch { /* keep */ }
        await refresh()
        maybeAutoRowChangelog(expandedKey)
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
      // —— 失败横幅里的两枚批量出口（#176）：一次复制全部失败行；集合与横幅同一份真源 ——
      // 回执不带 key，落在面板底部（详情没展开时本就该在那；展开着也不把它塞进某一家）。
      case 'copy-all-diag': {
        const failed = batchFailedRows(rows)
        if (failed.length === 0) return
        await copyWith(
          batchFailedDiagText(rows, currentLang()),
          batchText('batch.toast.copy-all-diag-ok', currentLang(), { n: String(failed.length) }),
          null,
        )
        return
      }
      case 'copy-all-manual': {
        const failed = batchFailedRows(rows)
        if (failed.length === 0) return
        const all = batchFailedManualText(rows, currentLang(), titles)
        // 横幅里没有可执行命令时按钮已置灰；程序调用同样兜底（只复制注释没有意义）。
        if (all.commands === 0) return
        await copyWith(
          all.text,
          batchText('batch.toast.copy-all-manual-ok', currentLang(), { n: String(all.commands) }),
          null,
        )
        return
      }
      // 合规版决议（#156）：点"装合规版"本身不装任何东西——先认该行失败证据，
      // 再问该家自己的决议电话，有候选才给点名版本的二次确认按钮。
      // 老宿主没这条电话（unknown-phone）或取数失败即退回通用提醒，面板不碎。
      case 'row-fallback': {
        const row = typeof key === 'string' && key ? rowOfKey(key) : null
        if (!row) return
        const cause = batchFallbackCauseOf(row)
        const phoneName = singleFallbackPhoneOf(row)
        if (!cause || phoneName === null) {
          say(bilingualText('panel.toast.fallback-unavailable', currentLang()), row.key)
          render()
          return
        }
        if (inFlight) return
        inFlight = true
        fallbackBusyKey = row.key
        clearNotice()
        render()
        try {
          let reply: unknown
          try {
            reply = await call(phoneName, {
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
            say(bilingualText('panel.toast.fallback-unavailable', currentLang()), row.key)
            render()
            return
          }
          const outcome = fallbackOutcomeOf(reply)
          if (outcome.candidate) {
            rowFallbackOffers.set(row.key, {
              candidate: outcome.candidate,
              checkId: outcome.checkId,
              targetVersion: cause.targetVersion,
            })
            clearNotice()
          } else if (outcome.kind === 'wait-until') {
            const time =
              typeof outcome.unlockAtMs === 'number' ? (formatUnlockAt(outcome.unlockAtMs, currentLang()) ?? null) : null
            say(
              time
                ? bilingualText('panel.toast.fallback-wait', currentLang(), { time })
                : bilingualText('panel.toast.fallback-unavailable', currentLang()),
              row.key,
            )
          } else {
            say(bilingualText('panel.toast.fallback-unavailable', currentLang()), row.key)
          }
        } finally {
          inFlight = false
          fallbackBusyKey = null
        }
        render()
        return
      }
      // 批量级合规版（#156 第一性原理）：最新版被 24 小时年龄门挡住时，「全部更新」这一步的诚实出路——
      // 先逐家问该家自己的决议电话（串行、互不干扰、老宿主没这条电话的行直接不进名单），
      // 再点名精确版本请用户确认。铁律不变：决议本身不装任何东西。
      case 'batch-fallback-scan': {
        const targets = rows.filter((row) => batchFallbackCauseOf(row) !== null && singleFallbackPhoneOf(row) !== null)
        if (targets.length === 0) {
          say(bilingualText('panel.toast.fallback-unavailable', currentLang()))
          render()
          return
        }
        if (inFlight) return
        inFlight = true
        clearNotice()
        render()
        const got: string[] = []
        let waitTime: string | null = null
        try {
          for (const row of targets) {
            if (!batchFallbackCauseOf(row) || singleFallbackPhoneOf(row) === null) continue
            const outcome = await resolveGated(row)
            if (!mounted) return
            if (outcome.candidate) {
              got.push(row.key)
            } else if (outcome.kind === 'wait-until' && waitTime === null) {
              waitTime =
                typeof outcome.unlockAtMs === 'number' ? (formatUnlockAt(outcome.unlockAtMs, currentLang()) ?? null) : null
            }
          }
        } finally {
          inFlight = false
        }
        if (got.length > 0) {
          // 并入自动决议已经得出的候选，不覆盖：两条路得出的都是同一批"能装的最新"。
          const merged = [...batchCompliantKeys]
          for (const k of got) if (!merged.includes(k)) merged.push(k)
          batchCompliantKeys = merged.filter((k) => rowFallbackOffers.has(k))
          clearNotice()
        } else if (waitTime) {
          say(bilingualText('panel.toast.fallback-wait', currentLang(), { time: waitTime }))
        } else {
          say(bilingualText('panel.toast.fallback-unavailable', currentLang()))
        }
        render()
        return
      }
      // 批量级二次确认（#156）：按钮文案即点名清单——用户先看见每家要装哪个精确版本再点，不存在静默装旧版。
      // 逐家串行装（各自凭证各自核销，凭证过期即算这一家没成），装完刷新读真状态；
      // 账本相位一个字不改（#152）：合规版是用户显式确认后的独立动作，不冒充"已更新到最新"。
      case 'batch-fallback-confirm': {
        const keys = batchCompliantKeys.filter((k) => rowFallbackOffers.has(k))
        if (keys.length === 0) {
          batchCompliantKeys = []
          say(bilingualText('panel.toast.fallback-unavailable', currentLang()))
          render()
          return
        }
        if (inFlight) return
        inFlight = true
        clearNotice()
        render()
        let done = 0
        let bad = 0
        let busyCount = 0
        try {
          for (const k of keys) {
            const row = rowOfKey(k)
            const offer = rowFallbackOffers.get(k) ?? null
            const phoneName = row ? singleInstallPhoneOf(row) : null
            if (!row || !offer || phoneName === null || offer.targetVersion !== latestVersionOf(row)) {
              rowFallbackOffers.delete(k)
              bad++
              continue
            }
            const freshRequestId = `r${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffff).toString(36)}`.slice(0, 64)
            let reply: unknown = null
            try {
              reply = await call(phoneName, {
                checkId: offer.checkId,
                requestId: freshRequestId,
                version: offer.candidate,
                // 意图来源如实自报（#124）：这是批量横幅发起的确认，不是用户点单插件面板。
                from: 'batch',
                includeEnv: true,
                includeQueue: true,
              })
            } catch {
              reply = null
            }
            // 忙是暂时的（宿主里另一家正在装，m3/#156 对抗审查）：候选留着、确认条不撤，
            // 过一会儿再点一次就行——别把"稍后再来"说成"这次用不上合规版"。
            const busy =
              isObject(reply) && reply['ok'] === false && (reply['error'] === 'update-busy' || reply['errorKind'] === 'update-busy')
            if (!busy) rowFallbackOffers.delete(k)
            if (!mounted) return
            if (isObject(reply) && reply['ok'] !== false) {
              done++
              // 这一轮已经装上过一次：记下来，别再自动决议同一家（否则装完立刻又端一次确认条）。
              const prev = gatedOutcomes.get(k)
              gatedOutcomes.set(k, { kind: 'installed', unlockAtMs: prev ? prev.unlockAtMs : null })
            } else if (busy) busyCount++
            else bad++
          }
        } finally {
          inFlight = false
        }
        batchCompliantKeys = keys.filter((k) => rowFallbackOffers.has(k))
        pruneFallbackOffers()
        await refresh()
        // 两件事都如实说：装成的/被拒的照报，忙的那几家单独说清楚"稍后再来"（候选还留着）。
        const parts: string[] = []
        if (done > 0 || bad > 0) {
          parts.push(batchText('batch.toast.compliant-installed', currentLang(), { a: String(done), b: String(bad) }))
        }
        if (busyCount > 0) parts.push(bilingualText('batch.toast.queue-missed', currentLang()))
        if (parts.length > 0) say(parts.join(' '))
        render()
        return
      }
      // 二次确认（#156）：按钮文案即决议点名的精确版本——用户先看见再点，不存在静默装旧版。
      // 走该家自己的单插件安装电话（带 version 进核心第二槽绑定）；账本不记"已更新到最新"，
      // 随后一次 refresh 把真快照读回来是什么就是什么。凭证过期即退回重决议，不硬装。
      case 'row-fallback-confirm': {
        const row = typeof key === 'string' && key ? rowOfKey(key) : null
        if (!row) return
        const offer = rowFallbackOffers.get(row.key) ?? null
        const phoneName = singleInstallPhoneOf(row)
        if (!offer || phoneName === null || offer.targetVersion !== latestVersionOf(row)) {
          rowFallbackOffers.delete(row.key)
          say(bilingualText('panel.toast.fallback-unavailable', currentLang()), row.key)
          render()
          return
        }
        if (inFlight) return
        inFlight = true
        clearNotice()
        render()
        try {
          const freshRequestId = `r${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffff).toString(36)}`.slice(0, 64)
          let reply: unknown
          try {
            reply = await call(phoneName, {
              checkId: offer.checkId,
              requestId: freshRequestId,
              version: offer.candidate,
              // 意图来源如实自报（#124）：逐行确认也是批量入口发起的，不是用户点单插件面板。
              from: 'batch',
              includeEnv: true,
              includeQueue: true,
            })
          } catch {
            reply = null
          }
          if (!mounted) return
          const busy =
            isObject(reply) && reply['ok'] === false && (reply['error'] === 'update-busy' || reply['errorKind'] === 'update-busy')
          if (busy) {
            // 忙是暂时的（宿主里另一家正在装）：候选留着再点一次；复核仍在核心的确认那一步把关。
            say(bilingualText('batch.toast.queue-missed', currentLang()), row.key)
          } else {
            rowFallbackOffers.delete(row.key)
            if (!isObject(reply) || reply['ok'] === false) {
              say(bilingualText('panel.toast.fallback-unavailable', currentLang()), row.key)
            } else {
              // 这一轮已经装上过一次：记下来，别再自动决议同一家（否则装完立刻又端一次确认条）。
              const prev = gatedOutcomes.get(row.key)
              gatedOutcomes.set(row.key, { kind: 'installed', unlockAtMs: prev ? prev.unlockAtMs : null })
            }
          }
        } finally {
          inFlight = false
        }
        pruneFallbackOffers()
        await refresh()
        return
      }
      case 'toggle-details': {
        if (typeof key !== 'string' || !key) return
        expandedKey = expandedKey === key ? null : key
        render()
        maybeAutoRowChangelog(expandedKey)
        return
      }
      // 详情弹窗关闭（#108 决议 B 嵌套归属）：只清 expandedKey 重绘批量，不碰批量 dialog 的 onCloseRequested；批量 Esc 才走 entry-batch close。
      case 'detail-close': {
        if (expandedKey === null) return
        expandedKey = null
        render()
        return
      }
      // 「请重启DSH」：宿主没有重启自己的电话，只做入口——调用方给了 onRestartRequested 就交给它，
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
    // Esc 关弹窗：详情弹窗优先（只清 expandedKey，不碰批量 onCloseRequested）；批量底无展开时才走批量关闭。
    try {
      const e = ev as { key?: unknown } | null | undefined
      if (!mounted || !e || e.key !== 'Escape') return
      if (expandedKey !== null) {
        expandedKey = null
        render()
        return
      }
      if (mode !== 'dialog') return
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

  function setThemeTokens(next: UpdateThemeTokens | undefined): void {
    themeTokensStyleFor(next ?? undefined)
    themeTokens = next ?? undefined
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

  /** #243：未完成会话有多旧（毫秒）。updatedAt 缺失/不合法 → null（保持旧行为，不改老形状语义）。 */
  function autoResumeAgeMsOf(value: unknown): number | null {
    if (!isObject(value)) return null
    const at = (value as Record<string, unknown>)['updatedAt']
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return null
    return Math.max(0, Date.now() - at)
  }

  /** 打开即查/续（#59 D3/Q3）：每挂载最多各一次；自动失败不弹红条，只留行上标记。 */
  async function autoOnce(): Promise<void> {    try {
      await runAutoOnce()
    } catch {
      // 自动查/续出错不挡挂载：失败痕迹留给行上标记与轮询。
      if (autoCheckOutcome === null) autoCheckOutcome = 'failed'
    } finally {
      logMountRowOnce()
    }
  }

  async function runAutoOnce(): Promise<void> {
    if (!mounted) return
    if (autoResumeOption && !autoResumeDone) {
      autoResumeDone = true
      if (hasUnfinishedRows(rows, lastSession ?? undefined) && !inFlight && !refreshing) {
        // #243：旧会话不静默开跑——把「继续」交给用户（底部本来就有 resume 按钮）。
        const ageMs = autoResumeAgeMsOf(lastSession)
        if (ageMs !== null && ageMs > AUTO_RESUME_MAX_AGE_MS) {
          autoCheckOutcome = 'recent'
          say(batchText('batch.notice.resume-stale', currentLang()))
          render()
          return
        }
        const before = lastError
        const latchBefore = failureLatch
        try {
          const reply = await call(phones.resume, {})
          if (!mounted) return
          if (isObject(reply) && reply['ok'] === true) {
            applyReply(reply)
            const r = reply as Record<string, unknown>
            if (r['resumed'] !== false) {
              // #232：剩余 0 个就别再提示「已自动继续（剩余 0 个）」——那只会让人以为还有事。
              if (remainingCount() > 0) say(batchText('batch.notice.auto-resumed', currentLang(), { count: String(remainingCount()) }))
              rowFailedAt.clear()
            }
            // 续完没走查：对挂载行而言等价于「最近查过/还没到再查的时候」。
            autoCheckOutcome = 'recent'
            render()
            maybeAutoRowChangelog(expandedKey)
            return
          }
          lastError = before
          failureLatch = latchBefore
          render()
        } catch {
          if (mounted) render()
        }
      }
    }
    if (!autoCheckDone) {
      autoCheckDone = true
      if (!checkOnOpenEffective()) {
        autoCheckOutcome = 'disabled'
        return
      }
      if (hasUnfinishedRows(rows, lastSession ?? undefined)) {
        autoCheckOutcome = 'recent'
        return
      }
      const stale = lastCheckedAt <= 0 || nowMs() - lastCheckedAt >= 60000
      if (!stale || inFlight || refreshing) {
        autoCheckOutcome = 'recent'
        return
      }
      const before = lastError
      const latchBefore = failureLatch
      try {
        const reply = await call(phones.check, {})
        if (!mounted) return
        if (isObject(reply) && reply['ok'] === true) {
          applyReply(reply)
          rowFailedAt.clear()
          autoCheckOutcome = 'started'
          render()
          maybeAutoRowChangelog(expandedKey)
          return
        }
        lastError = before
        failureLatch = latchBefore
        autoCheckOutcome = 'failed'
        render()
      } catch {
        autoCheckOutcome = 'failed'
        if (mounted) render()
      }
    }
  }

  function unmount(): void {
    if (!mounted) return
    mounted = false
    // #208：全局兜底、去重表与自建日志通道都归壳管（注入通道不动）。
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
    logShell.dispose()
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
  // #208：全局兜底（error/unhandledrejection）挂载时装上，unmount 时摘掉。
  installGlobalHandlers()
  const timer = getTimer()
  const handle = timer.set(() => {
    // 查类在途轮询让路（#87 防抖：读-读不插帧，回包自带那一帧）；装类在途照刷
    // （#90 R3：查询不被命令饿死——轮询只读本地账本与缓存快照，宿主侧驱动期间跳过单插件电话）。
    // 按钮置灰照旧，防连点是命令侧的事。
    if (inFlight && inFlightIsCheck) return
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

  return { refresh, act, setTheme, setThemeTokens, setMode, unmount }
}
