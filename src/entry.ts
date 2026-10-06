// src/entry.ts —— 更新入口件：按钮 / 徽标 / 内嵌三态（#25）。
//
// 第一性（为什么它该由本包提供，而不是接入方自己拼）：
//   接入方真正要回答的问题只有一句——「用户在这个页面上，怎么知道我这儿有更新、怎么走到更新界面」。
//   这件事的形状与插件无关，只有三个自由度：**摆什么**（按钮/徽标/内嵌）、**什么时候查**（进来就查/
//   只手工查）、**点了做什么**（有新版才开面板 / 总是开 / 只回调给接入方自己跳）。
//   所以本包把它做成一件：接入方一行挂上，状态文案由我们从快照推出来，接入方不写状态机。
//
// 一条铁律：**检查是只读、安装是写入，两者不许合并成一个动作**。
//   入口件永远只做「查 + 打开面板」，绝不自动装；用户必须在面板里明确点「安装」。
//   落实在本文件：只调 <前缀>.updateStatus（只读本地）与 <前缀>.updateCheck（联网、只读），
//   源码里不出现安装电话；安装只发生在 src/panel.ts 的「安装」按钮被用户点下时。
//
// 契约（#25 实现）：
//   variant='button'（默认）：一个按钮，文案随状态；点下去先查一次，再按 openOn 决定去向；
//   variant='badge' ：只有一个小圆点（接入方自己排版、自己接管点击 → 走 onActivate 回调）；
//   variant='inline'：面板本体直接嵌进来（等价 mountUpdatePanel 的 embedded，状态文案读 entryLabelFor）；
//   打开面板 = 以 mode:'dialog' 挂单插件面板（复用 src/panel.ts，不另写界面）。
//   容器只有一个要求：有 innerHTML（与 panel 同口径）。入口件自己在容器里画按钮；面板开着时容器
//   暂时归面板所有（经转发件写同一个容器），关闭即还原按钮——接入方不用给第二个挂载点。
//
// 文案不写状态机：只由 entryLabelFor(快照 + 失败码) 推出来，接入方读 label() 做自定义排版。

import { DEFAULT_PREFIX, MIN_PANEL_POLL_MS, buildPhoneNames } from './config.js'
import {
  failureCodeOf,
  mountUpdatePanel,
  normalizePanelTheme,
  type UpdatePanelContainer,
  type UpdatePanelController,
  type UpdatePanelMode,
  type UpdatePanelTheme,
} from './panel.js'
import type { UpdateSnapshot } from './ports.js'
import { BILINGUAL_CSS, copyHTML, copyText, type BilingualKey } from './bilingual.js'
import { resolveLang, subscribeLang, type AppLang, type LocaleOption } from './lang.js'

// ---------- 公开类型 ----------

/** 入口件的形态。 */
export type EntryVariant = 'button' | 'badge' | 'inline'

/** 什么时候主动查一次（只读，联网一次）。 */
export type EntryAutoCheck = 'mount' | 'never'

/** 用户点下去之后做什么。 */
/**
 * 点下去之后做什么：`has-update` 有新版才开面板（无事只给一句小字）；`always` 检查完总是开；
 * `manual` 交给 onActivate；`direct` 点开即弹窗、不预查（面板挂载即自查；badge 仍走回调口径）。
 */
export type EntryOpenOn = 'has-update' | 'always' | 'manual' | 'direct'

/** 入口件主题（与面板同一套取值，切换即换肤）。 */
export type EntryTheme = UpdatePanelTheme

/** 入口件的状态档：只用来算文案与 data-state，不另立状态机。 */
export type EntryStateKind = 'idle' | 'update' | 'busy' | 'restart' | 'failed'

/** 算文案要的全部输入：一份快照 + 最近一次通话的失败稳定码（没查过、没失败为 null）。 */
export interface UpdateEntryState {
  snapshot: UpdateSnapshot | null
  error: string | null
}

export interface UpdateEntryOptions {
  pluginId: string
  /** 单插件电话前缀（与宿主侧一致）。 */
  prefix: string
  /** 调宿主电话：(phoneName, args) => Promise<reply>。 */
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>
  variant?: EntryVariant
  /** 主题：`default` 最小可用深色，`archive` 档案卷纸面浅色（`d5-paper` 为旧别名仍可用）。 */
  theme?: UpdatePanelTheme
  /** 缺省 'mount'：进页面静默查一次（只读）。'never' 则只在用户点击时查。 */
  autoCheck?: EntryAutoCheck
  /** 缺省 'has-update'：有新版才开面板，没有就只在原地给一句提示。 */
  openOn?: EntryOpenOn
  /** 覆盖默认按钮文案（不传就用状态联动文案）。 */
  label?: string
  /** 语言覆盖（#60 v2）：'zh' | 'en' | { getActive(): string; subscribe?(cb): () => void }，不传即跟随 html[lang] > navigator > zh。 */
  locale?: LocaleOption
  profileName?: string
  pollMs?: number
  /**
   * 更新日志自动/手动（#38）：透传给面板（dialog 与 inline 同走 mountPanel），默认自动；
   * 显式文本仍赢，false 退回手动。入口件自己不取数。
   */
  autoChangelog?: boolean
  changelogMarkdown?: string | null
  /** variant='badge' 或 openOn='manual' 时，点击交给接入方（自己跳自己的页面）。 */
  onActivate?: (state: { hasUpdate: boolean; latestVersion: string | null }) => void
}

export interface UpdateEntryController {
  /** 立刻查一次并把状态刷到界面上（只读）。 */
  refresh(): Promise<void>
  /** 打开更新面板（dialog 形态）。 */
  open(): void
  /** 关掉更新面板。 */
  close(): void
  /** 当前按钮上的状态文案（接入方做自定义排版时读它）。 */
  label(): string
  setTheme(theme: UpdatePanelTheme): void
  unmount(): void
}

// ---------- 状态 → 文案（纯函数：同一份快照永远算出同一句话，接入方不用写状态机） ----------
//
// 文案是可执行的话，不是稳定码：用户读到的是「待重启」而不是 pending-restart。
// 五档与票面口径一一对应：无新版/未查→检查更新；有新版→有新版 X.Y.Z；安装中→正在安装…；
// 待重启→待重启；失败→更新失败，点此查看。

// v2 起入口文案全部出自集中字典（单语），不再硬编码中文（#60：旧 LABEL_* 常量退场，zh 口径由字典保证逐字兼容）。

/** 有没有新版：远端版本存在且与运行版本不同（能不能装是面板的事，入口件只如实说「有」）。 */
function hasUpdateOf(snapshot: UpdateSnapshot | null): boolean {
  if (!snapshot) return false
  const latest = snapshot.latestVersion
  if (typeof latest !== 'string' || !latest.trim()) return false
  return latest.trim() !== snapshot.runningVersion
}

/**
 * 状态档：快照六字段 + 失败码推出，顺序固定（活任务 > 待重启 > 失败 > 有新版 > 待查）。
 * 待重启是正常终态（不是失败），所以排在失败前面；正在装的任务比一条陈旧的失败码更可信。
 */
export function entryStateKind(state: UpdateEntryState | null | undefined): EntryStateKind {
  const snapshot = state?.snapshot ?? null
  const job = snapshot?.job ?? null
  if (job && (job.state === 'installing' || job.state === 'verifying')) return 'busy'
  if (snapshot && (snapshot.blockedReason === 'pending-restart' || job?.state === 'restart-required')) {
    return 'restart'
  }
  if ((state && state.error) || (job && (job.state === 'failed' || job.state === 'interrupted'))) {
    return 'failed'
  }
  if (hasUpdateOf(snapshot)) return 'update'
  return 'idle'
}

/**
 * 入口件双语 key（#54 底座调用链）：与 entryStateKind 同一输入（快照 + 失败码），分支只认稳定码，永不读文案。
 * 数据层只传 key + {version} 运行时值，表现层经 copyHTML 拼单语块。
 */
export function entryBilingualKeyFor(state: UpdateEntryState | null | undefined): BilingualKey {
  switch (entryStateKind(state)) {
    case 'busy':
      return 'entry.label.busy'
    case 'restart':
      return 'entry.label.restart'
    case 'failed':
      return 'entry.label.failed'
    case 'update': {
      const latest = state?.snapshot?.latestVersion
      return typeof latest === 'string' && latest.trim() ? 'entry.label.has-update' : 'entry.label.idle'
    }
    default:
      return 'entry.label.idle'
  }
}

/** 双语插值（运行时值永不翻译：同一 version 在单语块里原样透传，冻结词元两语言逐字相同）。 */
export function entryBilingualValuesFor(state: UpdateEntryState | null | undefined): Record<string, string> {
  const key = entryBilingualKeyFor(state)
  if (key === 'entry.label.has-update') {
    const v = state?.snapshot?.latestVersion
    return { version: typeof v === 'string' ? v.trim() : '' }
  }
  return {}
}

/** 一路调用链的单语块 HTML（entryHTML 按钮正文唯一来源，无覆盖时必走此函数；lang 显式入参，缺省跟随全局）。 */
export function entryBilingualHTMLFor(state: UpdateEntryState | null | undefined, lang?: AppLang | string | null): string {
  const l = lang ?? resolveLang()
  return copyHTML(entryBilingualKeyFor(state), l, entryBilingualValuesFor(state))
}

/** 属性位纯文本单语（title / aria-label 用，放不下 HTML 时的同内容平面版；与 HTML 出口同语言）。 */
export function entryBilingualTextFor(state: UpdateEntryState | null | undefined, lang?: AppLang | string | null): string {
  const l = lang ?? resolveLang()
  return copyText(entryBilingualKeyFor(state), l, entryBilingualValuesFor(state))
}

/** 入口件文案第二出口（唯一出处：测试与接入方都读它；与 HTML 出口同语言，v2 起按 lang 取字典，不再硬编码中文）。 */
export function entryLabelFor(state: UpdateEntryState | null | undefined, lang?: AppLang | string | null): string {
  const l = lang ?? resolveLang()
  return copyText(entryBilingualKeyFor(state), l, entryBilingualValuesFor(state))
}

// ---------- 入口件自己的最小样式（面板本体仍由 src/panel.ts 提供，这里只画按钮/圆点/提示） ----------

export const UPDATE_ENTRY_CSS = [
  '.dsh-upd-entry{display:inline-flex;align-items:center;gap:8px;font:13px/1.6 system-ui,"Microsoft YaHei",sans-serif;color:var(--dsh-upd-fg,#1f2937)}',
  '.dsh-upd-entry-btn{font:inherit;border:1px solid var(--dsh-upd-line,#d1d5db);border-radius:6px;',
  'background:var(--dsh-upd-btn,#f9fafb);color:inherit;padding:4px 12px;cursor:pointer}',
  '.dsh-upd-entry-btn:hover{border-color:var(--dsh-upd-primary,#2563eb)}',
  '.dsh-upd-entry-btn,.dsh-upd-entry-dot{transition:background-color .15s ease,border-color .15s ease,color .15s ease,transform .06s ease}',
  '.dsh-upd-entry-btn:active:not(:disabled){transform:translateY(1px)}',
  '.dsh-upd-entry-btn:disabled,.dsh-upd-entry-dot:disabled{opacity:.55;cursor:wait}',
  '.dsh-upd-entry-btn[aria-busy="true"]::after{content:"";display:inline-block;width:10px;height:10px;margin-left:7px;vertical-align:-1px;',
  'border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:dsh-upd-entry-spin .8s linear infinite}',
  '@keyframes dsh-upd-entry-spin{to{transform:rotate(360deg)}}',
  '@media (prefers-reduced-motion: reduce){.dsh-upd-entry-btn,.dsh-upd-entry-dot{transition:none}.dsh-upd-entry-btn[aria-busy="true"]::after{animation:none}}',
  '.dsh-upd-entry-btn:focus-visible,.dsh-upd-entry-dot:focus-visible{outline:2px solid var(--dsh-upd-focus,#2563eb);outline-offset:1px}',
  '.dsh-upd-entry[data-state="update"] .dsh-upd-entry-btn{border-color:var(--dsh-upd-ok-line,#059669);color:var(--dsh-upd-ok-line,#059669)}',
  '.dsh-upd-entry[data-state="restart"] .dsh-upd-entry-btn{border-color:var(--dsh-upd-warn-line,#d97706);color:var(--dsh-upd-warn-line,#d97706)}',
  '.dsh-upd-entry[data-state="failed"] .dsh-upd-entry-btn{border-color:var(--dsh-upd-bad-line,#dc2626);color:var(--dsh-upd-bad-line,#dc2626)}',
  '.dsh-upd-entry-dot{width:10px;height:10px;padding:0;border:0;border-radius:50%;background:var(--dsh-upd-line,#9ca3af);cursor:pointer}',
  '.dsh-upd-entry[data-state="update"] .dsh-upd-entry-dot{background:var(--dsh-upd-ok-line,#059669)}',
  '.dsh-upd-entry[data-state="busy"] .dsh-upd-entry-dot,.dsh-upd-entry[data-state="restart"] .dsh-upd-entry-dot{background:var(--dsh-upd-warn-line,#d97706)}',
  '.dsh-upd-entry[data-state="failed"] .dsh-upd-entry-dot{background:var(--dsh-upd-bad-line,#dc2626)}',
  // 小字自带底（深色宿主 + 浅色变量时也读得出；浅底宿主上只是多一圈细线，不抢戏）。
  '.dsh-upd-entry-note{font-size:12.5px;opacity:.9;background:var(--dsh-upd-bg,#ffffff);border:1px solid var(--dsh-upd-line,#e5e7eb);border-radius:4px;padding:1px 8px}',
  '.dsh-upd-entry[data-theme="archive"] .dsh-upd-entry-note{background:var(--d5-card);border-color:var(--d5-line-strong);color:var(--d5-ink)}',
  '.dsh-upd-entry[data-theme="archive"]{--d5-ink:#1a1a1a;--d5-muted:#6f675a;--d5-line-strong:#c4b896;--d5-accent:#c8402a;--d5-card:#fffdf6;',
  'font-family:Georgia,"Songti SC","STSong","SimSun",serif;color:var(--d5-ink)}',
  // 按钮脸自己不透明（深色宿主 + 浅色系统变量时也读得出；hover 红在深浅底上都可见）。
  '.dsh-upd-entry[data-theme="archive"] .dsh-upd-entry-btn{border-color:var(--d5-line-strong);background:var(--d5-card);color:var(--d5-ink);border-radius:3px}',
  '.dsh-upd-entry[data-theme="archive"] .dsh-upd-entry-btn:hover{border-color:var(--d5-accent);color:var(--d5-accent)}',
  '@media (prefers-color-scheme: dark){.dsh-upd-entry[data-theme="archive"]{--d5-ink:#ece5d3;--d5-muted:#a89c83;--d5-line-strong:#5c4e3b;--d5-accent:#e0684e;--d5-card:#1e1a15}}',
  '@media (prefers-color-scheme: dark){.dsh-upd-entry{color:#e5e7eb}',
  '.dsh-upd-entry-btn{--dsh-upd-btn:#1f2937;--dsh-upd-line:#374151}}',
].join('\n')

// ---------- 内部小件 ----------

const ENTRY_ATTR = 'data-dsh-upd-entry'
const ENTRY_SELECTOR = '[data-dsh-upd-entry]'

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** 宽容读快照：形状不对就当没查到（不猜、不抛）。 */
function asSnapshot(value: unknown): UpdateSnapshot | null {
  if (!isObject(value)) return null
  if (typeof value['runningVersion'] !== 'string') return null
  if (typeof value['canInstall'] !== 'boolean') return null
  return value as unknown as UpdateSnapshot
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ---------- 挂载（接入方一行挂上；查是只读、装只能用户在面板里点） ----------

export function mountUpdateEntry(container: UpdatePanelContainer, options: UpdateEntryOptions): UpdateEntryController {
  if (!container || typeof container.innerHTML !== 'string') {
    throw new Error('[dsh-plugin-update] 挂更新入口件需要一个有 innerHTML 的容器')
  }
  if (!options || typeof options !== 'object') {
    throw new Error('[dsh-plugin-update] 挂更新入口件缺少配置：插件标识 pluginId 必填')
  }
  const pluginId = options.pluginId
  if (typeof pluginId !== 'string' || !pluginId) {
    throw new Error(`[dsh-plugin-update] 插件标识 pluginId 必填：须为非空字符串（收到 ${JSON.stringify(pluginId)}）`)
  }
  if (typeof options.call !== 'function') {
    throw new Error('[dsh-plugin-update] 挂更新入口件需要传输函数 call（入口件调宿主电话的唯一接触面）')
  }
  // 电话名只从前缀派生（与宿主侧同一套拼法，不写字面量）。
  const rawPrefix = (options as { prefix?: unknown }).prefix
  const prefix = rawPrefix === undefined ? DEFAULT_PREFIX : (rawPrefix as string)
  const phoneNames = buildPhoneNames(prefix)

  const variant: EntryVariant = options.variant ?? 'button'
  if (variant !== 'button' && variant !== 'badge' && variant !== 'inline') {
    throw new Error(`[dsh-plugin-update] 入口件形态非法：只收 button / badge / inline（收到 ${JSON.stringify(options.variant)}）`)
  }
  const autoCheck: EntryAutoCheck = options.autoCheck ?? 'mount'
  if (autoCheck !== 'mount' && autoCheck !== 'never') {
    throw new Error(`[dsh-plugin-update] 自动检查时机非法：只收 mount 或 never（收到 ${JSON.stringify(options.autoCheck)}）`)
  }
  const openOn: EntryOpenOn = options.openOn ?? 'has-update'
  if (openOn !== 'has-update' && openOn !== 'always' && openOn !== 'manual' && openOn !== 'direct') {
    throw new Error(`[dsh-plugin-update] 点击去向非法：只收 has-update / always / manual / direct（收到 ${JSON.stringify(options.openOn)}）`)
  }
  if (options.theme !== undefined && options.theme !== 'default' && options.theme !== 'archive' && options.theme !== 'd5-paper') {
    throw new Error(`[dsh-plugin-update] 主题非法：只收 default 或 archive（d5-paper 为旧别名仍可用）（收到 ${JSON.stringify(options.theme)}）`)
  }
  let theme: UpdatePanelTheme = normalizePanelTheme(options.theme ?? 'default')
  const pollMs = options.pollMs
  if (pollMs !== undefined && (typeof pollMs !== 'number' || !Number.isFinite(pollMs) || pollMs < MIN_PANEL_POLL_MS)) {
    throw new Error(`[dsh-plugin-update] 面板轮询间隔非法：不得小于 250 毫秒（收到 ${JSON.stringify(options.pollMs)}）`)
  }
  const labelOverride = typeof options.label === 'string' && options.label ? options.label : null
  const localeOpt: LocaleOption = (options as { locale?: LocaleOption }).locale ?? undefined
  if (localeOpt !== undefined && localeOpt !== null) {
    const isStr = typeof localeOpt === 'string'
    const isObj = typeof localeOpt === 'object' && typeof (localeOpt as { getActive?: unknown }).getActive === 'function'
    if (!isStr && !isObj) {
      throw new Error('[dsh-plugin-update] invalid locale: expected zh / en / BCP47 or { getActive(), subscribe? }')
    }
    if (isStr && !(localeOpt as string).trim()) {
      throw new Error('[dsh-plugin-update] invalid locale: empty string')
    }
  }
  function currentLang(): AppLang {
    return resolveLang(localeOpt)
  }
  const profileName = typeof options.profileName === 'string' && options.profileName ? options.profileName : null
  const onActivate = typeof options.onActivate === 'function' ? options.onActivate : null
  const call = options.call

  let snapshot: UpdateSnapshot | null = null
  let error: string | null = null
  // 已是最新提示的运行时值（#54 双语 entry.note.up-to-date 的 {version}，null 即无提示；值永不翻译）
  let noteVersion: string | null = null
  // 在途查新版（#36）：点下到回包前的那一帧，按钮置忙 + 并发连点只认第一次。
  let activating = false
  let mounted = true
  let panel: UpdatePanelController | null = null
  let panelMode: UpdatePanelMode | null = null

  // 面板与入口件共用同一个容器：面板经这个转发件写 innerHTML、挂监听，接入方不用给第二个挂载点。
  const panelHost: UpdatePanelContainer = {
    get innerHTML(): string {
      return container.innerHTML
    },
    set innerHTML(value: string) {
      container.innerHTML = value
    },
    addEventListener(type, listener) {
      container.addEventListener?.(type, listener)
    },
    removeEventListener(type, listener) {
      container.removeEventListener?.(type, listener)
    },
  }

  async function panelCall(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const reply = await call(name, args)
    return isObject(reply) ? reply : {}
  }

  function stateOf(): UpdateEntryState {
    return { snapshot, error }
  }

  function currentLabel(): string {
    return labelOverride ?? entryLabelFor(stateOf(), currentLang())
  }

  function hasUpdate(): boolean {
    return hasUpdateOf(snapshot)
  }

  /** 入口件自己那些电话的参数：只要快照，不带队列/环境（入口件不展示它们，少传少错）。 */
  function phoneArgs(): Record<string, unknown> {
    return {}
  }

  function entryHTML(): string {
    const kind = entryStateKind(stateOf())
    const lang = currentLang()
    // #60 v2 单语调用链：无覆盖时按钮正文必走集中字典单语块（只含当前语言，lang 齐全）；有覆盖仍走用户原文（兼容口径）。
    const labelHTML = labelOverride
      ? escapeHtml(labelOverride)
      : activating
        ? copyHTML('entry.action.checking', lang)
        : copyHTML(entryBilingualKeyFor(stateOf()), lang, entryBilingualValuesFor(stateOf()))
    const labelText = labelOverride ?? (activating ? copyText('entry.action.checking', lang) : copyText(entryBilingualKeyFor(stateOf()), lang, entryBilingualValuesFor(stateOf())))
    const busyAttr = activating ? ' disabled aria-busy="true"' : ''
    const themeAttr = theme === 'archive' ? ' data-theme="archive"' : ''
    const control =
      variant === 'badge'
        ? `<button type="button" class="dsh-upd-entry-dot" ${ENTRY_ATTR}="activate" title="${escapeHtml(labelText)}" aria-label="${escapeHtml(labelText)}"${busyAttr}></button>`
        : `<button type="button" class="dsh-upd-entry-btn" ${ENTRY_ATTR}="activate"${busyAttr}>${labelHTML}</button>`
    const noteHTML = noteVersion
      ? `<span class="dsh-upd-entry-note" data-dsh-upd-note="1">${copyHTML('entry.note.up-to-date', lang, { version: noteVersion })}</span>`
      : ''
    return (
      `<style>${UPDATE_ENTRY_CSS}\n${BILINGUAL_CSS}</style>\n` +
      `<span class="dsh-upd-entry" data-variant="${variant}" data-state="${kind}"${themeAttr}>` +
      `${control}${noteHTML}</span>`
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
      // 失败（或回包形状不认）：记稳定码，文案给「更新失败，点此查看」。
      error = failureCodeOf(isObject(reply) ? reply : null, 'check-failed')
      return
    }
    const next = asSnapshot(reply['snapshot'])
    if (next) snapshot = next
    error = null
  }

  async function refresh(): Promise<void> {
    if (!mounted) return
    try {
      const reply = await call(phoneNames.updateStatus, phoneArgs())
      if (!mounted) return
      applyReply(reply)
    } catch {
      if (!mounted) return
      error = 'check-failed'
    }
    render()
  }

  /** 用户点击带来的那一次查新版（联网、只读；入口件唯一的联网点）。 */
  async function checkNow(): Promise<void> {
    try {
      const reply = await call(phoneNames.updateCheck, phoneArgs())
      if (!mounted) return
      applyReply(reply)
    } catch {
      if (!mounted) return
      error = 'check-failed'
    }
  }

  /** 把面板挂进容器（复用 src/panel.ts 的整组件，不另写界面；#60 窗口期：面板暂不消费 locale，透传仅为占位）。 */
  function mountPanel(mode: UpdatePanelMode): void {
    if (!mounted || panelMode !== null) return
    panel = mountUpdatePanel(panelHost, {
      pluginId,
      prefix,
      mode,
      theme,
      pollMs,
      profileName,
      autoChangelog: options.autoChangelog,
      changelogMarkdown: options.changelogMarkdown ?? null,
      locale: localeOpt,
      // 面板点「关闭」即走入口件的完整关闭（收 dialog + 还原按钮 + 重查一次），不再是面板自己停轮询。
      onCloseRequested: () => close(),
      call: panelCall,
    } as Parameters<typeof mountUpdatePanel>[1])
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
    // 面板里可能刚装过：关掉后立刻只读查一次，让按钮文案如实（updateStatus 只读本地、不联网）。
    void refresh()
  }

  /**
   * 点下去：先查一次（只读），再按 openOn / variant 决定去向。
   * 任何分支都不会走到安装——安装只在面板里的「安装」按钮被用户点下时发生。
   */
  async function activate(): Promise<void> {
    if (!mounted || panelMode !== null || activating) return
    // direct：点开即弹窗，不预查（面板挂载即自查，快照自己跟上；badge 仍走回调口径，不替接入方开面板）。
    if (openOn === 'direct' && variant === 'button') {
      openDialog()
      return
    }
    activating = true
    noteVersion = null
    render()
    try {
      await checkNow()
    } finally {
      activating = false
    }
    if (!mounted) return
    // badge 与 manual 都是「点击交给接入方」：把刚查到的结论递出去，自己不开面板。
    if (variant === 'badge' || openOn === 'manual') {
      if (onActivate) onActivate({ hasUpdate: hasUpdate(), latestVersion: snapshot?.latestVersion ?? null })
      // 没给回调就没有别的去处：退回默认去向（开面板），总比点不动的死件强。
      else openDialog()
      render()
      return
    }
    // 有新版必开；查不出来（没快照或出错）也开——让用户看到为什么，而不是把失败咽掉。
    if (openOn === 'always' || hasUpdate() || !snapshot || error) {
      openDialog()
      return
    }
    // 确知没有新版：不开面板，只在原地给一句单语（#60 entry.note.up-to-date，值透传不译，与按钮同语言）。
    noteVersion = snapshot.runningVersion
    render()
  }

  function setTheme(next: UpdatePanelTheme): void {
    if (next !== 'default' && next !== 'archive' && next !== 'd5-paper') {
      throw new Error(`[dsh-plugin-update] 主题非法：只收 default 或 archive（d5-paper 为旧别名仍可用）（收到 ${JSON.stringify(next)}）`)
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
      // 弹窗里的「关闭」走面板的 onCloseRequested 落地（挂载 dialog 时已接为 close()），这里不再重复收一次。
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
    try {
      unsubLang()
    } catch {
      // 停不掉也无妨。
    }
    const opened = panel
    panel = null
    panelMode = null
    try {
      opened?.unmount()
    } catch {
      // 停不掉也无妨。
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
    // 卸载只停轮询与监听：绝不调安装/取消电话，也不动容器内容（与 panel.unmount 同口径）。
  }

  // #60 v2 语言跟随：已挂载控件即时重绘，unmount 后停订（单例观察者，显式 locale 对象亦经同一出口）。
  const unsubLang = subscribeLang(() => {
    render()
  }, localeOpt)
  try {
    container.addEventListener?.('click', onClick)
  } catch {
    // 没有事件能力的容器也能用（controller.open/refresh 直达）。
  }
  try {
    container.addEventListener?.('keydown', onKeyDown)
  } catch {
    // 没有键盘事件能力的容器忽略（Esc 关弹窗是渐进增强）。
  }
  if (variant === 'inline') mountPanel('embedded')
  else render()
  // autoCheck='mount'：进页面静默查一次状态（只读、不联网）。'never' 就等用户点击。
  if (autoCheck === 'mount') void refresh()

  return { refresh, open, close, label: currentLabel, setTheme, unmount }
}
