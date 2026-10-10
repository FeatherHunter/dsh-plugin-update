// src/panel.ts —— 现成整组件（#17 开放形式三件套之三）。
//
// 宿主构造器（src/host.ts：一次调用得电话名与处理器）与构建期派生
// （derive-client-values.mjs：电话名与轮询常量）之后，剩下的第三件就是这个文件：
// 框架无关的整组件。调用者只传标识与摆放参数（pluginId + prefix，另加 mode / showOthers /
// pollMs 可选），面板里放一个挂载点即跑。轮询调度、安装门控、中文一句话、待重启横幅、
// 手工命令展示与复制、排队可见开关、跳过读写承诺、诊断一键复制全在组件内部消化。
//
// 单组件单内核：内嵌与弹窗是同一套内核、同一套 HTML，只差最外层包裹（mode 参数切换），
// 不做两个组件。关闭面板/弹窗只停轮询、不停安装（安装在宿主进程内跑；重开面板立刻重查，
// 默认 1 秒轮询即恢复进度）。
//
// 本文件零 Node 专属能力（不读盘、不起进程、不拼 shell），Node 宿主与浏览器闭包两边都
// 跑得动；DOM 与剪贴板只在 mountUpdatePanel 被调用时经 globalThis 现取，模块顶层不碰。
// 样式隔离走 `dsh-upd` 前缀类 + 按需内联的最小默认样式（跟随系统主题、可被调用方覆盖）。
//
// 与错误架构子地图的分工：回包形状由子地图定，本组件只承诺“有、够、已脱敏”——
// 平时一句话、旁边常驻复制诊断；复制文本经 redactForCopy 收干净后再交出去。

import { buildChangelogPhoneName, buildPhoneNames, DEFAULT_PANEL_POLL_MS, MIN_PANEL_POLL_MS } from './config.js'
import { COPY_BUDGET_CHARS, sanitizeForCopy } from './redaction.js'
import { compareReleaseVersions, validReleaseVersion } from './service.js'
import {
  changelogForUpdate,
  parseChangelog,
  renderChangelogHTML,
  shouldFetchChangelog,
  yankedBannerHTML,
} from './changelog.js'
import { visibleQueueFor, type UpdateQueueState, type VisibleQueue } from './queue.js'
import { LOG_EVENT_CALL, LOG_EVENT_CALL_FAIL, LOG_EVENT_INSTALL_EXEC } from './log-events.js'
import type { BlockedReason, UpdateSnapshot } from './ports.js'
import { copyText, type BilingualKey } from './bilingual.js'
import { normalizeLangTag, resolveLang, subscribeLang, type AppLang, type LocaleOption } from './lang.js'

// ---------- 公开类型（完整类型定义：公开入口一律有类型，不做源码级复用） ----------

/** 摆放形态：默认内嵌，切弹窗走同一参数。 */
export type UpdatePanelMode = 'embedded' | 'dialog'

/** 面板主题：默认最小可用样式；`archive` 为档案卷纸面浅色（只换肤，不换 DOM 顺序）。 */
/**
 * 面板主题：`default` 最小可用深色；`archive` 档案卷纸面浅色（原型敲定的案卷风格，只换肤）。
 */
export type UpdatePanelTheme = 'default' | 'archive'

/**
 * 主题归一：`archive` 挂 `data-theme="archive"`，其余一律回 `default`（DOM 属性只出 `archive`）；
 * 其余一律回 default（纯渲染函数永不抛；挂载/setTheme 的非法值另行抛错）。
 */
export function normalizePanelTheme(value: unknown): 'default' | 'archive' {
  return value === 'archive' ? 'archive' : 'default'
}

// ---------- 主题变量覆盖（第三方换肤的一等口径） ----------
//
// 口径只有一套：与样式表里的 `--dsh-update-*` 变量逐一对应；`themeTokens` 只是把同一套变量
// 以内联方式写到面板根上，手写 CSS 变量同样生效。内联写在根元素，变量天然继承：单面板、
// 批量面板（含展开的详情行）、入口件打开的 dialog 全生效；两个主题通用。
// 被覆盖的 token 不再跟随深色媒体查询（内联赢过媒体块，即固定值，调用方自己保证深色可读）。
// 非法即抛（未知键、空串、注入字符、非正有限 entryScale 都不收），与 theme/sizing 同口径。

/** 第三方主题变量覆盖：键为语义名；颜色收 hex（#rgb/#rrggbb/#rrggbbaa）或英文名单词；其余收安全 CSS 值；缺省即主题默认值，零回归。 */
export interface UpdateThemeTokens {
  text?: string; textMuted?: string; bg?: string; bgSoft?: string;
  border?: string; borderStrong?: string; buttonBg?: string;
  primary?: string; primaryDeep?: string; focus?: string;
  okBg?: string; okBorder?: string; okText?: string;
  warnBg?: string; warnBorder?: string; warnText?: string;
  badBg?: string; badBorder?: string; badText?: string;
  busyBg?: string; busyBorder?: string; busyText?: string;
  /** 有新版版本号的醒目红（#71 Q1 专用；缺省跟随坏项红的对比度口径，深浅主题另覆）。 */
  newText?: string;
  /** 已装好新版版本号的绿色（#71 状态跟随修订：done 行走绿，其余走红；深浅主题另覆）。 */
  newOkText?: string;
  fontSans?: string; fontSerif?: string; fontMono?: string; shadow?: string;
  radiusPanel?: string; radiusButton?: string; radiusBadge?: string;
  entryFontSize?: string; entryPadding?: string; entryBorderRadius?: string;
  /** 入口件整体缩放（对应 CSS `zoom`），须为大于 0 的有限数。 */
  entryScale?: number;
}

/** 语义键 → CSS 变量（顺序即序列化顺序，输出稳定可测）。 */
const THEME_TOKEN_VARS: { [K in keyof UpdateThemeTokens]-?: string } = {
  text: '--dsh-update-text', textMuted: '--dsh-update-text-muted',
  bg: '--dsh-update-bg', bgSoft: '--dsh-update-bg-soft',
  border: '--dsh-update-border', borderStrong: '--dsh-update-border-strong',
  buttonBg: '--dsh-update-button-bg',
  primary: '--dsh-update-primary', primaryDeep: '--dsh-update-primary-deep',
  focus: '--dsh-update-focus',
  okBg: '--dsh-update-ok-bg', okBorder: '--dsh-update-ok-border', okText: '--dsh-update-ok-text',
  warnBg: '--dsh-update-warn-bg', warnBorder: '--dsh-update-warn-border', warnText: '--dsh-update-warn-text',
  badBg: '--dsh-update-bad-bg', badBorder: '--dsh-update-bad-border', badText: '--dsh-update-bad-text',
  busyBg: '--dsh-update-busy-bg', busyBorder: '--dsh-update-busy-border', busyText: '--dsh-update-busy-text',
  newText: '--dsh-update-new-text',
  newOkText: '--dsh-update-new-ok-text',
  fontSans: '--dsh-update-font-sans', fontSerif: '--dsh-update-font-serif',
  fontMono: '--dsh-update-font-mono', shadow: '--dsh-update-shadow',
  radiusPanel: '--dsh-update-radius-panel', radiusButton: '--dsh-update-radius-button',
  radiusBadge: '--dsh-update-radius-badge',
  entryFontSize: '--dsh-update-entry-font-size', entryPadding: '--dsh-update-entry-padding',
  entryBorderRadius: '--dsh-update-entry-border-radius', entryScale: '--dsh-update-entry-scale',
};

/** 颜色键集合：只收 hex 或英文名单词（含 transparent/currentColor）。 */
const THEME_TOKEN_COLOR_KEYS: ReadonlySet<string> = new Set([
  'text', 'textMuted', 'bg', 'bgSoft', 'border', 'borderStrong', 'buttonBg',
  'primary', 'primaryDeep', 'focus',
  'okBg', 'okBorder', 'okText', 'warnBg', 'warnBorder', 'warnText',
  'badBg', 'badBorder', 'badText', 'busyBg', 'busyBorder', 'busyText', 'newText', 'newOkText',
]);

function themeTokensError(raw: unknown): Error {
  return new Error(`[dsh-plugin-update] 主题参数 themeTokens 非法：只收已知 token 键（颜色用 hex 或英文名，字体/圆角/阴影/尺寸为安全 CSS 值，entryScale 为大于 0 的有限数）（收到 ${JSON.stringify(raw ?? null)})`)
}

/** CSS 值最小安全检查（与入口件 sizing 同口径）：放 style 属性前先拦掉注入。 */
export function isSafeThemeCssValue(value: string): boolean {
  const v = value.trim()
  if (!v || v.length > 200) return false
  if (/[;"'<>\`{}!&]/.test(v)) return false
  if (/url\s*\(/i.test(v)) return false
  if (/expression\s*\(/i.test(v)) return false
  if (/javascript\s*:/i.test(v)) return false
  return true
}

/** 颜色值检查：hex（#rgb/#rrggbb/#rrggbbaa）或英文名单词，不接受函数写法（rgb()/color-mix() 请换算成 hex）。 */
function isThemeColorValue(value: string): boolean {
  const v = value.trim()
  if (!v || v.length > 100) return false
  return /^(?:#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|[a-zA-Z]+)$/.test(v)
}

/**
 * `themeTokens` → 根 style 属性体（纯函数：同一输入永远算出同一串；空/缺省回空串，即不写 style）。
 * 非法即抛（未知键、空串、注入字符、颜色形状不对、非正有限 entryScale 都不收）。
 */
export function themeTokensStyleFor(tokens: UpdateThemeTokens | null | undefined): string {
  if (tokens === undefined || tokens === null) return ''
  if (typeof tokens !== 'object' || Array.isArray(tokens)) throw themeTokensError(tokens)
  for (const key of Object.keys(tokens)) {
    if (!Object.prototype.hasOwnProperty.call(THEME_TOKEN_VARS, key)) throw themeTokensError(tokens)
  }
  const parts: string[] = []
  for (const key of Object.keys(THEME_TOKEN_VARS) as (keyof UpdateThemeTokens)[]) {
    const value = (tokens as Record<string, unknown>)[key]
    if (value === undefined) continue
    if (key === 'entryScale') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw themeTokensError(tokens)
      parts.push(THEME_TOKEN_VARS[key] + ':' + String(value))
      continue
    }
    if (typeof value !== 'string') throw themeTokensError(tokens)
    const text = value.trim()
    if (THEME_TOKEN_COLOR_KEYS.has(key)) {
      if (!isThemeColorValue(text)) throw themeTokensError(tokens)
    } else if (!isSafeThemeCssValue(text)) throw themeTokensError(tokens)
    parts.push(THEME_TOKEN_VARS[key] + ':' + text)
  }
  return parts.join(';')
}

/** 与宿主通话的传输函数：面板只认这个签名，不认任何宿主对象的具体形状。 */
export type UpdatePanelCall = (
  phoneName: string,
  args: Record<string, unknown>,
) => Promise<Record<string, unknown>>

/** 复制文本的出口：不传即尝试浏览器剪贴板，都没有则只留“已生成、请手动复制”提示。 */
export type UpdatePanelCopyText = (text: string) => void | Promise<void>

/** 面板可点的动作（与 HTML 里 data-action 一一对应，测试走同一条路）。 */
export type UpdatePanelActionKind =
  | 'check'
  | 'install'
  | 'skip'
  | 'reset-skip'
  | 'copy-manual'
  | 'copy-diag'
  | 'toggle-queue'
  | 'toggle-changelog'
  | 'restart-hint'
  | 'close-view'
  | 'dismiss-failure'

export interface UpdatePanelOptions {
  /** 插件标识：必填，与宿主侧 createHostUpdate 传的 pluginId 一致。 */
  pluginId: string
  /** 电话名前缀：默认 wf，必须与宿主侧一致（取值只从这里算，不写字面量）。 */
  prefix?: string
  /** 摆放形态：默认内嵌。 */
  mode?: UpdatePanelMode
  /** 面板主题：默认 `default`（最小可用样式，一字不动）；传 `archive` 切档案卷。 */
  theme?: UpdatePanelTheme
  /** 主题变量覆盖：见 UpdateThemeTokens；两个主题通用，不传即零回归。 */
  themeTokens?: UpdateThemeTokens
  /** 是否看他人排队明细：默认只看自己的（他人仅露正忙占位，位置照给）。 */
  showOthers?: boolean
  /** 是否显示深挖日志指引：默认显示；面向纯终端用户的嵌入可关（失败证据行不受影响）。 */
  showLogHint?: boolean
  /** 轮询间隔毫秒：默认 1000，不得小于 250。 */
  pollMs?: number
  /** 与宿主通话的函数（面板侧唯一的宿主接触面）。 */
  call: UpdatePanelCall
  copyText?: UpdatePanelCopyText
  skipStore?: PanelSkipStore
  /** 宿主种类（调用方知道就传进诊断文本；不传就用宿主 includeEnv 回的宿主种类，再没有显示“未知”）。 */
  hostKind?: string | null
  /**
   * 使用范围名（profile）：**装到哪个范围**的展示面。不传就用宿主 includeEnv 回的真值；
   * 两者都没有时显示“未知”，绝不猜（猜错会让人以为更新装到了别的范围）。
   */
  profileName?: string | null
  /**
   * 「请重启DSH」按钮的落地（可选）：宿主没有重启自己的电话，默认点击只提示手动重启；
   * 调用方能把重启流程接进来（拉起自己的重启脚本/提示用户），按钮就交给它。
   */
  onRestartRequested?: () => void | Promise<void>
  diagCopyFormat?: DiagCopyFormat
  /**
   * 更新日志 Markdown（#23 包内 CHANGELOG 展示）：
   * 调用方按“已装版离线读、新版按需取 tarball”备好后传入（取不到传 null/空串即中性提示）；
   * 缺日志永不挡安装、不写 blockedReason。
   * 显式传入即赢：自动链路（见 autoChangelog）永不覆盖它。
   */
  changelogMarkdown?: string | null
  /**
   * 自动取日志（#38）：默认开。有新版时面板按 latestVersion 调一次宿主更新日志电话，
   * 回来经内部通道换日志节；显式传过 changelogMarkdown 或传 false 即退回手动模式。
   */
  autoChangelog?: boolean
  /**
   * 弹窗关闭的落地：只在 dialog 下点「关闭」/按 Esc 时调用；调用方在此撤掉弹窗 DOM。
   * 不传则回退为只停轮询（unmount），DOM 留给调用方处理。入口件打开的 dialog 已内置（收 dialog + 还原按钮）。
   */
  onCloseRequested?: () => void | Promise<void>
  /**
   * 语言覆盖（#61 起消费：'zh' | 'en' | { getActive(): string; subscribe?(cb): () => void }，不传即跟随全局信号）。
   * 与入口件同一口径：显式覆盖 > html[lang] > navigator > zh。
   */
  locale?: LocaleOption
}

/** 挂载点：只要有 innerHTML 的容器即可（浏览器元素或测试替身都行）。 */
export interface UpdatePanelContainer {
  innerHTML: string
  addEventListener?: (type: string, listener: (ev: unknown) => void) => void
  removeEventListener?: (type: string, listener: (ev: unknown) => void) => void
}

export interface UpdatePanelController {
  /** 立刻重查一次并重绘（挂载时自动调一次，重开面板即恢复进度）。 */
  refresh(): Promise<void>
  /** 点一次按钮（DOM 监听只是它的薄适配，测试直接调它）。 */
  act(kind: UpdatePanelActionKind, arg?: string): Promise<void>
  /** 切换摆放（同一状态重绘同一内核，只换外层包裹）。 */
  setMode(mode: UpdatePanelMode): Promise<void>
  /** 切换主题（同一内核重绘，只换肤；默认主题输出与旧版一字不差）。 */
  setTheme(theme: UpdatePanelTheme): Promise<void>
  /** 换一套主题变量（同一内核重绘，只换变量；传 undefined 即清掉覆盖，回主题默认）。 */
  setThemeTokens(tokens: UpdateThemeTokens | undefined): Promise<void>
  /** 切换排队可见性（重查一次，位置口径不变）。 */
  setShowOthers(show: boolean): Promise<void>
  /** 收起/展开更新日志（纯视图态，不调电话；轮询与换肤不丢）。 */
  setChangelogCollapsed(collapsed: boolean): Promise<void>
  /**
   * 换一版更新日志后重绘（#23：宿主侧备好新文本后调用；传 null/空串即回中性提示）。
   * 只换日志节，安装门控只跟快照，一字不动。
   */
  setChangelogMarkdown(markdown: string | null): void
  /** 卸载：只停轮询、只拆监听，绝不中断安装。 */
  unmount(): void
}

/** 面板本地的跳过读写承诺：按版本记、可重置（宿主侧 skipped.json 是另一套落盘，互不干扰）。 */
export interface PanelSkipStore {
  list(): string[]
  has(version: string): boolean
  skip(version: string): void
  reset(version?: string): void
}

// ---------- 状态与失败文案（#61 起全部出自集中字典，单语渲染；分支只认稳定码） ----------
//
// README §5.2：面板只展示“用户该做什么”，不只展示英文原因。
// zh 逐字等于旧散落文案（兼容既有测试）；en 待母语评审全 draft（见 src/bilingual.ts）。
// 9 阻塞行复用同一组 key（failureCopy 对阻塞码直接复用 blocked 行，不另起措辞）。

export interface BlockedCopy {
  title: string
  action: string
}

const BLOCKED_KEYS: Record<BlockedReason, { title: BilingualKey; action: BilingualKey }> = {
  'unknown-profile': { title: 'panel.blocked.unknown-profile.title', action: 'panel.blocked.unknown-profile.action' },
  'channel-mismatch': { title: 'panel.blocked.channel-mismatch.title', action: 'panel.blocked.channel-mismatch.action' },
  'source-install': { title: 'panel.blocked.source-install.title', action: 'panel.blocked.source-install.action' },
  'invalid-installation': { title: 'panel.blocked.invalid-installation.title', action: 'panel.blocked.invalid-installation.action' },
  'installation-changed': { title: 'panel.blocked.installation-changed.title', action: 'panel.blocked.installation-changed.action' },
  'pending-restart': { title: 'panel.blocked.pending-restart.title', action: 'panel.blocked.pending-restart.action' },
  'registry-conflict': { title: 'panel.blocked.registry-conflict.title', action: 'panel.blocked.registry-conflict.action' },
  'incompatible-node': { title: 'panel.blocked.incompatible-node.title', action: 'panel.blocked.incompatible-node.action' },
  'recovery-required': { title: 'panel.blocked.recovery-required.title', action: 'panel.blocked.recovery-required.action' },
}

/** 装不了的原因 → 单语一句话（能装传 null 即回 null，不猜；lang 缺省 zh，零回归）。 */
export function blockedCopy(reason: BlockedReason | null, lang?: AppLang | string | null): BlockedCopy | null {
  if (reason === null || reason === undefined) return null
  const keys = (BLOCKED_KEYS as Record<string, { title: BilingualKey; action: BilingualKey }>)[reason]
  if (!keys) return null
  const l = normalizeLangTag(lang ?? 'zh')
  return { title: copyText(keys.title, l), action: copyText(keys.action, l) }
}

// ---------- 15 码单语文案（#22 原型 + #61 入字典：9 阻塞 + 5 电话 + internal + 未来兜底） ----------
//
// 9 行以 README §5.2 为准（手册是源，字典逐字跟手册，不自创措辞）；
// 5 电话专属 + internal 为原型 panel-tolerated-reader 起草，措辞只给行动，不推导；
// 未来码走兜底（unknown），面板只渲染不推导（分支只用稳定码，不碰 diag 明细）。
export interface FailureCopy {
  zh: string
  act: string
}

const PHONE_FAILURE_KEYS: Record<string, { title: BilingualKey; action: BilingualKey }> = {
  'check-failed': { title: 'panel.failure.check-failed.title', action: 'panel.failure.check-failed.action' },
  'invalid-release': { title: 'panel.failure.invalid-release.title', action: 'panel.failure.invalid-release.action' },
  'check-expired': { title: 'panel.failure.check-expired.title', action: 'panel.failure.check-expired.action' },
  'update-busy': { title: 'panel.failure.update-busy.title', action: 'panel.failure.update-busy.action' },
  'install-failed': { title: 'panel.failure.install-failed.title', action: 'panel.failure.install-failed.action' },
  internal: { title: 'panel.failure.internal.title', action: 'panel.failure.internal.action' },
}

const UNKNOWN_FAILURE_KEYS: { title: BilingualKey; action: BilingualKey } = {
  title: 'panel.failure.unknown.title',
  action: 'panel.failure.unknown.action',
}

/** 15 码全表是否包含该码（9 阻塞 + 5 电话 + internal；未来码不在此列，走兜底）。 */
export function isKnownFailureCode(code: unknown): boolean {
  if (typeof code !== 'string' || !code) return false
  const c = code.trim()
  if (!c) return false
  return c in BLOCKED_KEYS || c in PHONE_FAILURE_KEYS
}

/**
 * 稳定码 → 单语一句话（15 码全覆盖；未知码回未来兜底，空码回 null；lang 缺省 zh，零回归）。
 * 9 阻塞行复用 blocked 行原文，不另起措辞；面板分支只认返回值，不碰 diag。
 */
export function failureCopy(code: unknown, lang?: AppLang | string | null): FailureCopy | null {
  if (typeof code !== 'string') return null
  const c = code.trim()
  if (!c) return null
  const l = normalizeLangTag(lang ?? 'zh')
  const blocked = (BLOCKED_KEYS as Record<string, { title: BilingualKey; action: BilingualKey }>)[c]
  if (blocked) return { zh: copyText(blocked.title, l), act: copyText(blocked.action, l) }
  const phone = PHONE_FAILURE_KEYS[c]
  if (phone) return { zh: copyText(phone.title, l), act: copyText(phone.action, l) }
  return { zh: copyText(UNKNOWN_FAILURE_KEYS.title, l), act: copyText(UNKNOWN_FAILURE_KEYS.action, l) }
}

/**
 * 失败回包取稳定码：只认 errorKind，error 仅作回退（#22 验收：errorKind=internal 时
 * 不许误判为查新版失败；包内已把未知码收敛为 error=check-failed/errorKind=internal，
 * 此时 error 那格不可信）。缺省回 internal，不抛错。
 */
export function failureCodeOf(
  reply: { error?: unknown; errorKind?: unknown } | null | undefined,
  fallback?: unknown,
): string {
  const kind = reply && typeof reply.errorKind === 'string' ? reply.errorKind.trim() : ''
  if (kind) return kind
  const err = reply && typeof reply.error === 'string' ? reply.error.trim() : ''
  if (err) return err
  if (typeof fallback === 'string' && fallback.trim()) return fallback.trim()
  return 'internal'
}

// ---------- 复制前脱敏（#24 单源收敛：规则唯一源是 src/redaction.ts） ----------
//
// 面板不再自存一份 PANEL_* 镜像：脱敏五条规则、顺序、占位符、丢弃语义、落刀语义
// 全部由 redaction 纯核定义（零 Node 导入，宿主/面板同缝），此处只转调。
// 统一丢弃语义：URL 用户信息命中即整项丢弃（返空串），非遮蔽；
// file:/// 三斜杠缺口显式 known-gap（见 redaction.KNOWN_GAP_FILE_URL_PREFIX），原样放过不静默修。

/** 诊断复制预算（单源：值取 redaction.COPY_BUDGET_CHARS，此处只转出口，老名保留兼容）。 */
export const PANEL_DIAG_MAX_CHARS = COPY_BUDGET_CHARS

/** 复制前把一行文本收干净（确定性：同一输入两次运行逐字节相同；实现见 redaction.sanitizeForCopy）。 */
export function redactForCopy(text: unknown): string {
  return sanitizeForCopy(text)
}

// ---------- 诊断文本（自包含、可粘贴：稳定码 + 脱敏详情 + 版本 + 宿主 + 队列位置） ----------

export interface PanelDiagnosticInput {
  pluginId: string
  /** 稳定码（失败回包的 errorKind 优先，error 仅回退；任务 message 取前缀码）。 */
  code: string
  /** 脱敏前的详情（任务 message 去掉前缀码剩下的部分，可空）。 */
  detail?: string | null
  runningVersion?: string | null
  installedVersion?: string | null
  latestVersion?: string | null
  hostKind?: string | null
  /** 使用范围名：装到哪个 profile 是排错第一信息；旧复制不传则该段不出现，新复制块恒显（缺省为未知）。 */
  profileName?: string | null
  queuePosition?: number | null
  requestId?: string | null
  manual?: string | null
  /** 失败那次安装的目标版本（冻结证据；缺省省略，只显式值）。 */
  targetVersion?: string | null
  /** 电话侧 diag（#21 落定前多半没有；有则宽容读，无则走显式字段，缺省说人话）。 */
  diag?: unknown
  /** 显式来源（diag 没有时用；有 diag 时显式优先，缺省仍说人话，不留白）。 */
  route?: string | null
  checkId?: string | null
  /** 渲染语言（#63 单语：缺省 zh 零回归；挂载态传 currentLang，纯函数直调可显式传 en/zh）。 */
  lang?: AppLang | string | null
}

/** 组出一段自包含诊断（调用方直接拿去粘工单/issue；粘之前已脱敏，不必手检；#63 入字典单语，lang 缺省 zh 零回归）。 */
export function buildDiagnosticText(input: PanelDiagnosticInput, langOverride?: AppLang | string | null): string {
  const l = normalizeLangTag(langOverride ?? (input as { lang?: unknown }).lang ?? 'zh')
  const unknown = copyText('panel.diag.copy.unknown', l)
  const code = String(input.code || 'check-failed')
  const lines: string[] = [copyText('panel.diag.header', l, { pluginId: String(input.pluginId), code })]
  const detail = redactForCopy(input.detail ?? '')
  const fallbackAct = failureCopy(code, l)?.act || code
  lines.push(copyText('panel.diag.label.human', l, { detail: detail || fallbackAct }))
  const versions = [
    copyText('panel.diag.label.running', l, { version: input.runningVersion ?? unknown }),
    copyText('panel.diag.label.installed', l, { version: input.installedVersion ?? unknown }),
    copyText('panel.diag.label.latest', l, { version: input.latestVersion ?? (l === 'en' ? 'Not checked' : '未查过') }),
  ].join(' / ')
  lines.push(versions)
  const queue = queueTextOf(input.queuePosition ?? null, l)
  // 使用范围只在给了的时候出现：不给就与旧输出一字不差（诊断文本是给人粘工单的，不掺空字段）。
  const hostLine = [copyText('panel.diag.label.host', l, { host: input.hostKind ?? unknown })]
  if (typeof input.profileName === 'string' && input.profileName) hostLine.push(copyText('panel.diag.label.profile', l, { profile: input.profileName }))
  hostLine.push(copyText('panel.diag.label.queue', l, { queue }))
  lines.push(hostLine.join(' / ') + (input.requestId ? ` / ${copyText('panel.diag.label.request', l, { requestId: input.requestId })}` : ''))
  const manual = redactForCopy(input.manual ?? '')
  if (manual) lines.push(copyText('panel.diag.label.manual', l, { manual }))
  return redactForCopy(lines.join('\n'))
}

// ---------- 双形态复制块（#22：三行块默认 + 单行 [update-diag] 可选，顺序完全一致） ----------
//
// 顺序由包内定（码 → 摘要 → 来源），两种形态只是排版不同：
// - block：三段（首行码+中文、次行怎么办+摘要、末行来源），默认复制形态；
// - line：单行 `[update-diag] code=… · …`，方便粘进单行输入框。
// 内容顺序完全一致：同一输入先算出同一段数组，再按形态 join。
// 面板只渲染不推导：文案只取 failureCopy(稳定码)，摘要只取 diag.detail/显式 detail
//（脱敏后），来源只取 diag/显式字段，缺省一律说人话，不分支、不猜。

export type DiagCopyFormat = 'block' | 'line'

const DIAG_KNOWN_TYPES: Record<string, string> = {
  v: 'number',
  stage: 'string',
  route: 'string',
  method: 'string',
  httpStatus: 'number',
  exitCode: 'number',
  latencyMs: 'number',
  detail: 'string',
  targetPackageName: 'string',
  runningVersion: 'string',
  latestVersion: 'string',
  environmentKind: 'string',
  requestId: 'string',
  checkId: 'string',
  registryHost: 'string',
  action: 'string',
}

export interface TolerantDiag {
  stage: string | null
  route: string | null
  method: string | null
  httpStatus: number | null
  exitCode: number | null
  latencyMs: number | null
  detail: string | null
  targetPackageName: string | null
  runningVersion: string | null
  latestVersion: string | null
  environmentKind: string | null
  requestId: string | null
  checkId: string | null
  registryHost: string | null
  action: string | null
  /** 目录外的键（如 queuePos 转正前）一律忽略，记在这里仅供排错，不进渲染。 */
  unknownKeys: string[]
}

/** 宽容读 diag：未知键忽略、错类型忽略、缺省当正常（永不抛；面板分支永不用它）。 */
export function readDiagTolerant(diag: unknown): TolerantDiag {
  const empty: TolerantDiag = {
    stage: null,
    route: null,
    method: null,
    httpStatus: null,
    exitCode: null,
    latencyMs: null,
    detail: null,
    targetPackageName: null,
    runningVersion: null,
    latestVersion: null,
    environmentKind: null,
    requestId: null,
    checkId: null,
    registryHost: null,
    action: null,
    unknownKeys: [],
  }
  if (!diag || typeof diag !== 'object' || Array.isArray(diag)) return empty
  const raw = diag as Record<string, unknown>
  const out: TolerantDiag = { ...empty, unknownKeys: [] }
  for (const key of Object.keys(DIAG_KNOWN_TYPES)) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue
    const v = raw[key]
    if (v === undefined || v === null) continue
    if (typeof v !== DIAG_KNOWN_TYPES[key]) continue
    ;(out as unknown as Record<string, unknown>)[key] = v
  }
  for (const key of Object.keys(raw)) {
    if (!Object.prototype.hasOwnProperty.call(DIAG_KNOWN_TYPES, key)) out.unknownKeys.push(key)
  }
  return out
}

export interface UpdateDiagCopyInput extends PanelDiagnosticInput {
  /** 复制形态：默认三行块；单行用于单行输入框，内容顺序与块完全一致。 */
  format?: DiagCopyFormat
}

function pickText(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim()
  return fallback
}

function queueTextOf(queuePosition: number | null | undefined, lang?: AppLang | string | null, _diagQueuePos?: unknown): string {
  // 第一性：queuePos 未转正前面板必须忽略（#18 预留未来键，diag.ts 永不产出，原型按目录外键静默丢）。
  // 排队位置只看队列视图；转正后电话侧按目录给，届时再接线，本函数签名保留占位以免误用。
  // #63 入字典单语，lang 缺省 zh 零回归。
  void _diagQueuePos
  const l = normalizeLangTag(lang ?? 'zh')
  const pos = typeof queuePosition === 'number' ? queuePosition : null
  if (pos === 0) return copyText('panel.diag.queue.installing', l)
  if (typeof pos === 'number') return copyText('panel.diag.queue.position', l, { n: pos })
  return copyText('panel.diag.queue.absent', l)
}

/**
 * 组出 [update-diag] 复制块（双形态同序；调用方直接拿去粘工单/issue，已脱敏）。
 * 第一性：顺序码→摘要→来源（#18 定），怎么办是面板页脚放最后，不插断三元组；
 * 缺省即省略（#18）：路由/请求/检查/阶段等缺失即不出现，不占位“未知”；
 * 插件/版本/宿主/使用范围/队列恒显（面板侧显式值兜底），摘要缺省给人话，源缺省给人话（省略本身即信息，人读不懂所以必须说）。
 * #63 入字典单语（§3.4 22 项，队列 3 复用旧块）：标签跟随语言，变量与自由文本、两种复制形态与字段顺序冻结不动；
 * 机读 tag [update-diag]/code=/·/— 冻结在代码里不进字典（非人类语言），人类标签（摘要/来源/怎么办/插件=…）走字典；
 * lang 缺省 zh 零回归，detail/变量/占位符不译（v2 非目标，英文界面出现中文正文属正常）。
 */
export function buildUpdateDiagCopy(input: UpdateDiagCopyInput, langOverride?: AppLang | string | null): string {
  const l = normalizeLangTag(langOverride ?? (input as { lang?: unknown }).lang ?? 'zh')
  const unknown = copyText('panel.diag.copy.unknown', l)
  const unknownPkg = copyText('panel.diag.copy.unknown-package', l)
  const rawCode = String((input as { code?: unknown }).code ?? '').trim() || 'internal'
  const copy = failureCopy(rawCode, l) ?? failureCopy('unknown', l)!
  const diag = readDiagTolerant((input as { diag?: unknown }).diag)
  const detailRaw = diag.detail ?? input.detail ?? ''
  const detail = redactForCopy(detailRaw) || copyText('panel.diag.copy.no-detail', l)
  const pluginName = pickText(diag.targetPackageName ?? input.pluginId, unknownPkg)
  const runVer = pickText(diag.runningVersion ?? input.runningVersion, '?')
  const instVer = pickText(input.installedVersion ?? diag.latestVersion, '?')
  const host = pickText(diag.environmentKind ?? input.hostKind, unknown)
  const routeRaw = (diag.route ?? (input as { route?: unknown }).route) as unknown
  const requestRaw = (diag.requestId ?? input.requestId) as unknown
  const checkRaw = (diag.checkId ?? (input as { checkId?: unknown }).checkId) as unknown
  const queue = queueTextOf(input.queuePosition ?? null, l)
  // 来源顺序固定：插件 → 版本 → 目标 → 宿主 → 使用范围 → 路由 → 阶段 → 方法 → HTTP/exit/耗时 → 源 → 建议 → 请求/检查 → 队列
  // 缺省即省略：路由/请求/检查/目标等无值即不出现；插件/版本/宿主/使用范围/队列恒显；源缺省给人话。
  const prov: string[] = [copyText('panel.diag.copy.field.plugin', l, { plugin: pluginName }), copyText('panel.diag.copy.field.version', l, { run: runVer, inst: instVer })]
  const targetRaw = (input as { targetVersion?: unknown }).targetVersion
  if (typeof targetRaw === 'string' && targetRaw.trim()) prov.push(copyText('panel.diag.copy.field.target', l, { version: targetRaw.trim() }))
  prov.push(copyText('panel.diag.copy.field.host', l, { host }))
  // #45：使用范围恒显（排错第一信息；未知也不猜，与表头口径一致，diag 无此键故只看显式值）。
  prov.push(copyText('panel.diag.copy.field.profile', l, { profile: pickText((input as { profileName?: unknown }).profileName, unknown) }))
  if (typeof routeRaw === 'string' && routeRaw.trim()) prov.push(copyText('panel.diag.copy.field.route', l, { route: routeRaw.trim() }))
  if (diag.stage) prov.push(copyText('panel.diag.copy.field.stage', l, { stage: diag.stage }))
  if (diag.method) prov.push(copyText('panel.diag.copy.field.method', l, { method: diag.method }))
  if (typeof diag.httpStatus === 'number') prov.push(`HTTP=${diag.httpStatus}`)
  if (typeof diag.exitCode === 'number') prov.push(`exit=${diag.exitCode}`)
  if (typeof diag.latencyMs === 'number') prov.push(`${copyText('panel.diag.copy.field.latency', l, { latency: diag.latencyMs })}ms`)
  if (diag.registryHost) prov.push(copyText('panel.diag.copy.field.registry', l, { host: diag.registryHost }))
  else prov.push(copyText('panel.diag.copy.field.registry-unknown', l))
  if (diag.action) prov.push(copyText('panel.diag.copy.field.action', l, { action: diag.action }))
  if (typeof requestRaw === 'string' && requestRaw.trim()) prov.push(copyText('panel.diag.copy.field.request', l, { request: requestRaw.trim() }))
  if (typeof checkRaw === 'string' && checkRaw.trim()) prov.push(copyText('panel.diag.copy.field.check', l, { check: checkRaw.trim() }))
  prov.push(copyText('panel.diag.copy.field.queue', l, { queue }))
  const format: DiagCopyFormat = (input as { format?: unknown }).format === 'line' ? 'line' : 'block'
  const provLine = redactForCopy(prov.join(' · '))
  if (format === 'line') {
    const line = `[update-diag] code=${rawCode} · ${copy.zh} · ${copyText('panel.diag.copy.line.summary', l, { summary: detail })} · ${provLine} · ${copyText('panel.diag.copy.line.remedy', l, { remedy: copy.act })}`
    return redactForCopy(line)
  }
  // 块形态保留换行：各段已脱敏，不再整块压平（压平会把三行块变成单行）。
  const block = [
    `[update-diag] ${rawCode} — ${copy.zh}`,
    `  ${copyText('panel.diag.copy.block.summary', l, { summary: detail })}`,
    `  ${copyText('panel.diag.copy.block.source', l, { source: provLine })}`,
    `  ${copyText('panel.diag.copy.block.remedy', l, { remedy: copy.act })}`,
  ].join('\n')
  return block
}

// ---------- 跳过存储（面板本地：localStorage 优先，无环境退内存；写坏吞掉不挡更新） ----------

const PANEL_SKIPPED_MAX = 50

function panelSkipKey(pluginId: string): string {
  return `dsh-upd-skipped/${String(pluginId)}`
}

function normalizePanelSkipped(raw: unknown): { version: string; skippedAt: number }[] {
  if (!raw || typeof raw !== 'object') return []
  const list = (raw as { skipped?: unknown }).skipped
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const out: { version: string; skippedAt: number }[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const version = (item as { version?: unknown }).version
    if (!validReleaseVersion(version) || seen.has(version as string)) continue
    seen.add(version as string)
    const at = (item as { skippedAt?: unknown }).skippedAt
    out.push({ version: version as string, skippedAt: typeof at === 'number' && Number.isFinite(at) ? at : 0 })
  }
  return out.slice(0, PANEL_SKIPPED_MAX)
}

export function createMemorySkipStore(now: () => number = Date.now): PanelSkipStore {
  let skipped: { version: string; skippedAt: number }[] = []
  function assertVersion(version: unknown): string {
    if (!validReleaseVersion(version)) {
      throw new Error(`[dsh-plugin-update] 跳过版本号非法：须为发行版本号（收到 ${JSON.stringify(version)}）`)
    }
    return version as string
  }
  return {
    list: () => skipped.map((e) => e.version),
    has: (version) => (validReleaseVersion(version) ? skipped.some((e) => e.version === version) : false),
    skip: (version) => {
      const v = assertVersion(version)
      const at = now()
      skipped = [{ version: v, skippedAt: typeof at === 'number' && Number.isFinite(at) ? at : 0 }]
        .concat(skipped.filter((e) => e.version !== v))
        .slice(0, PANEL_SKIPPED_MAX)
    },
    reset: (version) => {
      if (version === undefined) skipped = []
      else skipped = skipped.filter((e) => e.version !== version)
    },
  }
}

interface PanelStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function probeStorage(candidate: unknown): PanelStorageLike | null {
  try {
    if (!candidate || typeof candidate !== 'object') return null
    const s = candidate as PanelStorageLike
    if (typeof s.getItem !== 'function' || typeof s.setItem !== 'function' || typeof s.removeItem !== 'function') return null
    return s
  } catch {
    return null
  }
}

/** 浏览器跳过存储（localStorage 形状即可；没有或写坏退内存，绝不因跳过挡住更新）。 */
export function createBrowserSkipStore(
  pluginId: string,
  storage?: unknown,
  now: () => number = Date.now,
): PanelSkipStore {
  const memory = createMemorySkipStore(now)
  const store =
    probeStorage(storage) ??
    probeStorage((globalThis as Record<string, unknown>)['localStorage'] ?? null) ??
    null
  if (!store) return memory
  const active: PanelStorageLike = store
  const key = panelSkipKey(pluginId)
  function read(): { version: string; skippedAt: number }[] {
    try {
      const raw = active.getItem(key)
      if (!raw) return []
      return normalizePanelSkipped(JSON.parse(raw))
    } catch {
      return []
    }
  }
  function write(entries: { version: string; skippedAt: number }[]): void {
    try {
      active.setItem(key, JSON.stringify({ skipped: entries }))
    } catch {
      // best-effort：跳过写不进去也不能挡更新。
    }
  }
  // 启动时把能读到的搬进内存镜像，之后走同一套语义。
  try {
    for (const e of read()) memory.skip(e.version)
  } catch {
    // 读坏自愈为空。
  }
  return {
    list: () => memory.list(),
    has: (version) => memory.has(version),
    skip: (version) => {
      memory.skip(version)
      write(normalizePanelSkipped({ skipped: memory.list().map((v) => ({ version: v, skippedAt: now() })) }))
    },
    reset: (version) => {
      memory.reset(version)
      if (version === undefined) {
        try {
          active.removeItem(key)
        } catch {
          // 删不掉也不挡更新。
        }
      } else {
        write(normalizePanelSkipped({ skipped: memory.list().map((v) => ({ version: v, skippedAt: now() })) }))
      }
    },
  }
}

// ---------- 视图模型（纯函数：快照 → 面板该画什么；安装门控只跟快照，不另写规则） ----------

export interface PanelBanner {
  kind: 'loading' | 'restart' | 'blocked' | 'update' | 'busy' | 'failed' | 'done' | 'idle'
  title: string
  action: string
}

export interface PanelView {
  banner: PanelBanner
  installEnabled: boolean
  installLabel: string
  skippedLatest: boolean
  showManual: boolean
  showReset: boolean
  queueNote: string | null
  /** 大印章（状态词）与小印章（一字）：取值与原型 `archive.html:431-432` 的状态映射一一对应。 */
  seal: PanelSeal
}

/** 印章色调：与原型 `seal-ink / seal-green / seal-yellow / seal-red` 四个类同名同义。 */
export type PanelSealTone = 'ink' | 'green' | 'yellow' | 'red'

export interface PanelSeal {
  /** 大印章文字：待查 / 可装 / 安装中 / 待重启 / 受阻 / 已最新。 */
  text: string
  /** 小印章文字：查 / 装 / 启 / 阻 / 定（一字，与原型 sealmini 同口径）。 */
  mini: string
  tone: PanelSealTone
}

/**
 * 状态 → 印章（原型映射表，逐条对齐 archive.html:431-432，#61 入字典单语）：
 * 待查=查/ink、可装=装/green、安装中=装/yellow、待重启=启/yellow、受阻=阻/red、已最新=定/green。
 * 中文印章 blocked/failed 共用“受阻”，英文分流（Blocked — Action needed / Failed — Retry available，见 #53 Q4）。
 * 主题无关：默认主题只把它当属性带着（不画），Archive 用 CSS 读出来画成印章，DOM 两边仍同一份。
 */
const SEAL_KEYS: Record<PanelBanner['kind'], { text: BilingualKey; mini: BilingualKey; tone: PanelSealTone }> = {
  loading: { text: 'panel.seal.loading.text', mini: 'panel.seal.loading.mini', tone: 'ink' },
  idle: { text: 'panel.seal.idle.text', mini: 'panel.seal.idle.mini', tone: 'ink' },
  update: { text: 'panel.seal.update.text', mini: 'panel.seal.update.mini', tone: 'green' },
  busy: { text: 'panel.seal.busy.text', mini: 'panel.seal.busy.mini', tone: 'yellow' },
  restart: { text: 'panel.seal.restart.text', mini: 'panel.seal.restart.mini', tone: 'yellow' },
  blocked: { text: 'panel.seal.blocked.text', mini: 'panel.seal.blocked.mini', tone: 'red' },
  failed: { text: 'panel.seal.failed.text', mini: 'panel.seal.failed.mini', tone: 'red' },
  done: { text: 'panel.seal.done.text', mini: 'panel.seal.done.mini', tone: 'green' },
}

/** 状态 → 单语印章（lang 缺省 zh，零回归；tone 与原型同名同义，不入字典）。 */
export function panelSealFor(kind: PanelBanner['kind'], lang?: AppLang | string | null): PanelSeal {
  const keys = SEAL_KEYS[kind] ?? SEAL_KEYS.idle
  const l = normalizeLangTag(lang ?? 'zh')
  return { text: copyText(keys.text, l), mini: copyText(keys.mini, l), tone: keys.tone }
}

function messageCodeOf(message: unknown): string {
  if (typeof message !== 'string' || !message) return ''
  const at = message.indexOf(':')
  return (at < 0 ? message : message.slice(0, at)).trim()
}

export interface PanelViewInput {
  snapshot: UpdateSnapshot | null
  manual: string | null
  queue: VisibleQueue | null
  skippedLatest: boolean
  lastError: string | null
  /** 失败回包的 errorKind（有则优先于 lastError；internal 时不许误判为查新版失败）。 */
  errorKind?: string | null
  /**
   * 更新日志 Markdown（#23）：只影响日志节的渲染，不参与安装门控。
   * 缺省/空串即中性提示；快照六字段与 blockedReason 一字不动。
   */
  changelogMarkdown?: string | null
}

export function panelViewModel(input: PanelViewInput, lang?: AppLang | string | null): PanelView {
  const l = normalizeLangTag(lang ?? (input as { lang?: unknown }).lang ?? 'zh')
  const view = panelViewModelCore(input, l)
  return { ...view, seal: panelSealFor(view.banner.kind, l) }
}

function panelViewModelCore(input: PanelViewInput, lang: AppLang): Omit<PanelView, 'seal'> {
  const { snapshot, manual, queue, skippedLatest, lastError } = input
  const errorKind = (input as { errorKind?: unknown }).errorKind
  const l = normalizeLangTag(lang ?? 'zh')
  if (!snapshot) {
    const earlyCode =
      (typeof errorKind === 'string' && errorKind.trim()) || lastError || ''
    if (earlyCode) {
      const copy = failureCopy(earlyCode, l)
      return {
        banner: {
          kind: 'failed',
          title: copyText('panel.banner.error.title', l, { code: earlyCode, detail: copy?.zh ?? earlyCode }),
          action: copy?.act || copyText('panel.banner.error.action-fallback', l),
        },
        installEnabled: false,
        installLabel: copyText('panel.action.retry-install', l),
        skippedLatest: false,
        showManual: manual ? true : false,
        showReset: false,
        queueNote: null,
      }
    }
    return {
      banner: { kind: 'loading', title: copyText('panel.banner.loading', l), action: '' },
      installEnabled: false,
      installLabel: copyText('panel.action.install', l),
      skippedLatest: false,
      showManual: false,
      showReset: false,
      queueNote: null,
    }
  }
  const job = snapshot.job ?? null
  const jobState = job?.state ?? null
  const queueNote =
    queue && queue.busy
      ? queue.position === 0
        ? copyText('panel.queue.busy-self', l)
        : typeof queue.position === 'number'
          ? copyText('panel.queue.busy-queued', l, { n: queue.position })
          : copyText('panel.queue.busy-other', l)
      : null
  // 跳过即免打扰：新版本恒重新提醒（跳过按版本记），同一行给恢复入口。
  if (skippedLatest && snapshot.latestVersion) {
    return {
      banner: {
        kind: 'idle',
        title: copyText('panel.skip.skipped-title', l, { latest: snapshot.latestVersion }),
        action: copyText('panel.skip.skipped-action', l),
      },
      installEnabled: false,
      installLabel: copyText('panel.action.install', l),
      skippedLatest: true,
      showManual: false,
      showReset: true,
      queueNote,
    }
  }
  // 顺序（#91）：在途任务与新失败是新证据，旧快照的待重启排在其后。
  // 待重启仍是正常终态，但只在无在途、无新失败时展示。
  // 安装中：按钮置灰，进度靠轮询恢复（重开面板立刻重查即回进度）。
  if (jobState === 'installing' || jobState === 'verifying') {
    const ver = typeof job?.targetVersion === 'string' && job.targetVersion.trim() ? job.targetVersion.trim() : ''
    let installingTitle = copyText('panel.banner.installing-title', l, { version: ver || ' ' })
    // 空版本时去多余空格，还原旧输出“正在安装…关闭面板不会中断。”（模板带空格是为了有版本号时不断词）
    if (!ver) installingTitle = installingTitle.replace(' …', '…').replace(' ...', '...')
    return {
      banner: {
        kind: 'busy',
        title: installingTitle,
        action: copyText('panel.banner.installing-action', l),
      },
      installEnabled: false,
      installLabel: copyText('panel.action.installing', l),
      skippedLatest: false,
      showManual: false,
      showReset: false,
      queueNote,
    }
  }
  // 失败：稳定码 + 一句话 + 常驻复制诊断（分支只认 errorKind，error 仅回退）。
  const jobCode = jobState === 'failed' ? messageCodeOf(job?.message) || 'install-failed' : ''
  const failedCode =
    (typeof errorKind === 'string' && errorKind.trim()) ||
    lastError ||
    jobCode ||
    ''
  // #100：失败任务已是旧目标、远端已有新版 → 失败页让位给新信息（旧失败不挡新版）。
  // 只压任务自带的失败：另有新鲜的 errorKind/lastError 时仍按失败页（那是当下的证据）。
  // 让位只发生在有当下故事可讲时（可装 / 有阻拦原因）；否则退回失败页——撒谎说“已最新”比留旧失败更糟。
  // 比不出版本一律按旧失败页，不猜。
  let staleFailure = false
  try {
    const target = typeof job?.targetVersion === 'string' ? job.targetVersion.trim() : ''
    const latest = typeof snapshot.latestVersion === 'string' ? snapshot.latestVersion.trim() : ''
    const freshOther = (typeof errorKind === 'string' && errorKind.trim()) || lastError
    staleFailure =
      (jobState === 'failed' || jobState === 'interrupted') &&
      !!target && !!latest && !freshOther && (snapshot.canInstall || !!snapshot.blockedReason) &&
      compareReleaseVersions(latest, target) === 1
  } catch {
    staleFailure = false
  }
  if (!staleFailure && (failedCode || jobState === 'failed' || jobState === 'interrupted')) {
    const code = failedCode || 'install-failed'
    const copy = failureCopy(code, l)
    return {
      banner: {
        kind: 'failed',
        title: copyText('panel.banner.error.title', l, { code, detail: copy?.zh ?? code }),
        action: copy?.act || copyText('panel.banner.error.action-fallback', l),
      },
      installEnabled: snapshot.canInstall,
      installLabel: copyText('panel.action.retry-install', l),
      skippedLatest: false,
      showManual: manual ? true : false,
      showReset: false,
      queueNote,
    }
  }
  // 待重启是正常终态：只给重启指引与手工命令入口，不再给安装按钮。
  // 到这里已排除在途任务与新失败（见上），旧快照的待重启才可信（#91）。
  if (snapshot.blockedReason === 'pending-restart') {
    const latest = snapshot.latestVersion ?? snapshot.installedVersion ?? ''
    return {
      banner: {
        kind: 'restart',
        // 文案照原型（archive.html:329）：不带 emoji——警示由横幅左侧的手绘 SVG 标承担，
        // 印章在状态一侧，两者各司其职，不再三重标记。
        title: copyText('panel.banner.restart-title', l, { latest }),
        action: blockedCopy('pending-restart', l)?.action ?? '',
      },
      installEnabled: false,
      installLabel: copyText('panel.action.install', l),
      skippedLatest: false,
      showManual: manual ? true : false,
      showReset: false,
      queueNote,
    }
  }
  // 装不了（除待重启外）：一句话原因（句号跟随语言：zh 用。/ en 用.）。
  if (snapshot.blockedReason) {
    const copy = blockedCopy(snapshot.blockedReason, l)
    const stop = l === 'en' ? '.' : '。'
    return {
      banner: {
        kind: 'blocked',
        title: copy ? `${copy.title}${stop}` : `${snapshot.blockedReason}${stop}`,
        action: copy?.action || '',
      },
      installEnabled: false,
      installLabel: copyText('panel.action.install', l),
      skippedLatest: false,
      showManual: manual ? true : false,
      showReset: false,
      queueNote,
    }
  }
  if (snapshot.canInstall && snapshot.latestVersion) {
    return {
      banner: {
        kind: 'update',
        title: copyText('panel.banner.update-title', l, { latest: snapshot.latestVersion, running: snapshot.runningVersion }),
        action: copyText('panel.banner.update-action', l),
      },
      installEnabled: true,
      installLabel: copyText('panel.action.install-version', l, { latest: snapshot.latestVersion }),
      skippedLatest: false,
      showManual: manual ? true : false,
      showReset: false,
      queueNote,
    }
  }
  return {
    banner: { kind: 'done', title: copyText('panel.banner.done', l), action: '' },
    installEnabled: false,
    installLabel: copyText('panel.action.install', l),
    skippedLatest: false,
    showManual: false,
    showReset: false,
    queueNote,
  }
}

// ---------- 渲染（纯函数：同一视图 → 同一内核 HTML；内外摆放只差外层包裹） ----------

export const UPDATE_PANEL_CSS = [
  '.dsh-upd{font:14px/1.75 system-ui,"Microsoft YaHei",sans-serif;color:var(--dsh-update-text,#1f2937);',
  'background:var(--dsh-update-bg,#ffffff);border:1px solid var(--dsh-update-border,#e5e7eb);border-radius:8px;padding:12px 14px;max-width:560px;',
  // 横幅配色走变量（浅色默认 + 深色覆盖，见下方 dark 媒体块）：硬编码浅色会让深色下
  // 「浅底 + 浅字」读不出来（现场回归：默认主题深色模式更新横幅白底浅字）。
  '--dsh-update-ok-bg:#ecfdf5;--dsh-update-ok-border:#059669;--dsh-update-warn-bg:#fffbeb;--dsh-update-warn-border:#d97706;',
  '--dsh-update-bad-bg:#fef2f2;--dsh-update-bad-border:#dc2626;--dsh-update-busy-bg:#eff6ff;--dsh-update-busy-border:#2563eb}',
  '.dsh-upd *{box-sizing:border-box}',
  '.dsh-upd button{font:inherit;border:1px solid var(--dsh-update-border-strong,#d1d5db);border-radius:var(--dsh-update-radius-button,6px);background:var(--dsh-update-button-bg,#f9fafb);',
  'color:inherit;padding:7px 14px;cursor:pointer;margin:2px 6px 2px 0}',
  '.dsh-upd button:disabled{opacity:.45;cursor:not-allowed}',
  '.dsh-upd button:focus-visible{outline:2px solid var(--dsh-update-focus,#2563eb);outline-offset:1px}',
  '.dsh-upd button[data-primary="1"]{background:var(--dsh-update-primary,#2563eb);border-color:var(--dsh-update-primary,#2563eb);color:#fff}',
  '.dsh-upd-banner{border-left:4px solid var(--dsh-update-border,#9ca3af);padding:6px 10px;margin:0 0 8px;background:var(--dsh-update-bg-soft,#f3f4f6)}',
  '.dsh-upd-banner[data-kind="restart"]{border-color:var(--dsh-update-warn-border);background:var(--dsh-update-warn-bg)}',
  '.dsh-upd-banner[data-kind="failed"],.dsh-upd-banner[data-kind="blocked"]{border-color:var(--dsh-update-bad-border);background:var(--dsh-update-bad-bg)}',
  '.dsh-upd-banner[data-kind="update"]{border-color:var(--dsh-update-ok-border);background:var(--dsh-update-ok-bg)}',
  '.dsh-upd-banner[data-kind="busy"]{border-color:var(--dsh-update-busy-border);background:var(--dsh-update-busy-bg)}',
  '.dsh-upd code{font-family:Consolas,Menlo,monospace;font-size:12px;word-break:break-all}',
  '.dsh-upd-manual,.dsh-upd-queue,.dsh-upd-log{margin:4px 0;font-size:13px}',
  '.dsh-upd-changelog-wrap{margin:4px 0 0;font-size:13px}',
  '.dsh-upd-changelog-title{font-weight:700;margin:0 0 4px}',
  '.dsh-upd-changelog-version{margin:6px 0}',
  '.dsh-upd-changelog-catname{font-weight:600;margin:6px 0 2px}',
  '.dsh-upd-changelog ul{margin:2px 0 6px 20px;padding:0}',
  '.dsh-upd-changelog li{margin:2px 0}',
  '.dsh-upd-changelog-fold{margin:4px 0}',
  '.dsh-upd-changelog-fold>summary{cursor:pointer}',
  '.dsh-upd-changelog-count{font-size:12px;opacity:.7;margin:2px 0 4px}',
  '.dsh-upd-changelog-yanked{border-left:4px solid var(--dsh-update-warn-border,#d97706);background:var(--dsh-update-warn-bg,#fffbeb);padding:6px 10px;margin:6px 0;font-size:13px}',
  '.dsh-upd-breaking-badge{display:inline-block;font-size:11px;font-weight:700;border:1px solid currentColor;border-radius:3px;padding:0 5px;margin-right:6px;vertical-align:baseline}',
  '.dsh-upd-changelog-security-more{margin:4px 0 6px}',
  '.dsh-upd-changelog-security-more>summary{cursor:pointer;font-size:12px;opacity:.8}',
  '.dsh-upd-changelog-more-note{font-size:12px;opacity:.7;margin:2px 0 4px}',
  '.dsh-upd-changelog-neutral{color:inherit;opacity:.8}',
  '.dsh-upd-overlay{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:9999}',
  '.dsh-upd-overlay .dsh-upd{background:var(--dsh-update-bg,#ffffff);max-height:85vh;display:flex;flex-direction:column;overflow:hidden}',
  // —— 弹窗高度让渡契约（#93，headless 量盒子实测）——
  // 面板内容高过 85vh 时，纵向 flex 按比例压所有子项；唯独**显式写了 min-height 的区**会失去 CSS 的
  // 「内容最小尺寸」自动保护：横幅（3.4em）与版本条（48px）被压到地板，而没写 min-height 的抬头/
  // 档案头/页脚纹丝不动。档案卷皮肤又给横幅加了 flex-wrap:wrap——纵向 flex 上它不换行而换列，
  // 最后一项（副行）被甩到标题右侧、冲出横幅后被 .dsh-upd{overflow:hidden} 裁掉。
  // 契约：带滚动区的弹窗帧里，只有滚动区让高度，其余各区不得小于自己的内容高度。
  // :has(>.dsh-upd-body) 是刻意的边界——批量面板的弹窗帧没有滚动区，本契约不扩到它（属 #90/#91 域）。
  '.dsh-upd-overlay .dsh-upd:has(>.dsh-upd-body)>:not(.dsh-upd-body){flex:none}',
  // 兜底：窗口矮到连框架都放不下时，整面板自己滚（横向仍 hidden）；章节区留 8em 下限——
  // 别把章节区压成 0、更别把页脚顶出视野还滚不到（实测：可用高 ≤ 约 512 时接管，对应窗口高 ≤ 约 600）。
  '.dsh-upd-overlay .dsh-upd:has(>.dsh-upd-body){overflow-x:hidden;overflow-y:auto}',
  '.dsh-upd-overlay .dsh-upd:has(>.dsh-upd-body)>.dsh-upd-body{min-height:8em}',
  // —— 弹窗分栏滚动：头（抬头/档案头/横幅/版本条）与尾固定，只有 01–05 章节区滚动 ——
  '.dsh-upd-body{min-height:0}',
  '.dsh-upd-body *{min-width:0}',
  '.dsh-upd-overlay .dsh-upd-body{flex:1 1 auto;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--dsh-update-border,#e5e7eb) transparent}',
  '.dsh-upd-overlay .dsh-upd-body::-webkit-scrollbar{width:8px}',
  '.dsh-upd-overlay .dsh-upd-body::-webkit-scrollbar-thumb{background:var(--dsh-update-border,#e5e7eb);border-radius:4px}',
  '.dsh-upd-overlay .dsh-upd-body::-webkit-scrollbar-track{background:transparent}',
  // —— 章节标题磁吸：滚动时节标题贴顶（纯 CSS sticky；背景跟随主题，Archive 另覆）——
  '.dsh-upd-overlay .dsh-upd-body .dsh-upd-chap-head{position:sticky;top:0;z-index:1;background:var(--dsh-update-bg,#ffffff);padding-top:2px}',
  // —— 档案头 / 版本条 / 章节 / 进度条 / 跳过行（原型 :208-245 的新结构，默认主题给最小可用样式）——
  '.dsh-upd-head{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}',
  // 卷宗抬头「插件更新 / 更新档案 卷」：Archive 档案卷才画，默认（最小）主题不画。
  // 两个主题共用同一份内核 HTML（见 renderUpdatePanelHTML 的注释），画不画是皮肤决定的事。
  '.dsh-upd-masthead{display:none}',
  '.dsh-upd-name{font-weight:700}',
  '.dsh-upd-meta{font-size:12.5px;opacity:.75}',
  '.dsh-upd-proftag{font-family:Consolas,Menlo,monospace;font-size:11px;border:1px solid var(--dsh-update-border,#d1d5db);border-radius:3px;padding:0 5px;margin-left:6px;letter-spacing:.06em}',
  '.dsh-upd-strip{display:flex;flex-wrap:wrap;margin:8px 0 0;border:1px solid var(--dsh-update-border,#e5e7eb);border-radius:4px;overflow:hidden;font-size:12.5px}',
  '.dsh-upd-strip>div{flex:1 1 110px;min-width:0;padding:6px 10px;border-left:1px solid var(--dsh-update-border,#e5e7eb)}',
  '.dsh-upd-strip>div:first-child{border-left:0}',
  '.dsh-upd-strip-k{display:block;font-size:11px;letter-spacing:.14em;opacity:.7}',
  '.dsh-upd-strip-v{font-family:Consolas,Menlo,monospace;font-size:12.5px;word-break:break-all}',
  '.dsh-upd-chapter{margin-top:18px;padding-top:14px;border-top:1px solid var(--dsh-update-border,#e5e7eb)}',
  // 右下角独立 footer 区（#47 定案 A）：与第一章 actions 脱钩，右对齐，一次找到。
  '.dsh-upd-footer{display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-top:14px;padding-top:10px;border-top:1px solid var(--dsh-update-border,#e5e7eb)}',
  '.dsh-upd-foot-note{margin-right:auto;font-size:12px;opacity:.7}',
  '.dsh-upd-footer button{margin:0}',
  '.dsh-upd-chap-head{display:flex;align-items:baseline;gap:10px;margin-bottom:6px}',
  '.dsh-upd-chap-no{font-size:13px;font-style:italic;opacity:.6}',
  '.dsh-upd-chap-title{font-size:14px;margin:0}',
  '.dsh-upd-chap-rule{flex:1;border-top:1px solid var(--dsh-update-border,#e5e7eb);transform:translateY(-3px)}',
  // 03 章标题行右端的开关（问题 3 定案：按钮形态、挪到标题行）。
  '.dsh-upd-chap-note{flex:none;font-size:12px;opacity:.75}',
  '.dsh-upd-chap-note button{margin:0}',
  // 更新队列两行键值（用户定案的设计）：结构两主题共用，皮肤各自收敛。
  '.dsh-upd-qrow{display:flex;align-items:baseline;flex-wrap:wrap;gap:10px;padding:6px 0;min-width:0}',
  '.dsh-upd-qrow+.dsh-upd-qrow{border-top:1px solid var(--dsh-update-border,#e5e7eb)}',
  '.dsh-upd-qdot{width:8px;height:8px;border-radius:50%;flex:none;align-self:center;background:currentColor;opacity:.5}',
  '.dsh-upd-qdot[data-tone="busy"]{background:var(--dsh-update-warn-border,#d97706);opacity:1}',
  '.dsh-upd-qdot[data-tone="you"]{background:var(--dsh-update-primary,#2563eb);opacity:1}',
  '.dsh-upd-qk{flex:none;width:5.5em;font-size:12px;opacity:.7}',
  '.dsh-upd-qv{font-weight:600}',
  '.dsh-upd-qn{margin-left:auto;font-size:12px;opacity:.7}',
  '.dsh-upd-qseq{font-family:Consolas,Menlo,monospace;font-size:12px;word-break:break-all}',
  '.dsh-upd-prog{height:8px;background:var(--dsh-update-border,#e5e7eb);border-radius:4px;overflow:hidden;margin:10px 0 4px}',
  '.dsh-upd-prog-bar{display:block;height:100%;background:var(--dsh-update-primary,#2563eb);transition:width .3s}',
  '.dsh-upd-progtxt{font-size:12.5px;opacity:.75}',
  '.dsh-upd-skipline{font-size:13px;margin-top:8px}',
  // 骨架微光：只在首帧 loading 出现；reduced-motion 下静止占位，不断语义。
  '.dsh-upd-skv{display:inline-block;min-width:64px;border-radius:3px;color:transparent !important;user-select:none;',
  'background:linear-gradient(90deg,var(--dsh-update-border,#e5e7eb) 25%,var(--dsh-update-bg-soft,#f3f4f6) 50%,var(--dsh-update-border,#e5e7eb) 75%);',
  'background-size:200% 100%;animation:dsh-upd-shimmer 1.2s linear infinite}',
  '@keyframes dsh-upd-shimmer{to{background-position:-200% 0}}',
  '.dsh-upd-tag{display:inline-block;border:1px dashed currentColor;border-radius:3px;padding:1px 8px;margin-right:8px;font-family:Consolas,Menlo,monospace;font-size:12px}',
  '.dsh-upd-err{font-size:13px;margin:0 0 6px}',
  // —— 全按钮交互反馈（#36：悬停/按下/过渡/在途忙态；浅深双主题通用写法，不碰上面的既有串）——
  '.dsh-upd button{transition:background-color .15s ease,border-color .15s ease,color .15s ease,transform .06s ease}',
  '.dsh-upd button:hover:not(:disabled){border-color:var(--dsh-update-focus,#2563eb)}',
  '.dsh-upd button[data-primary="1"]:hover:not(:disabled){filter:brightness(.93)}',
  '.dsh-upd button:active:not(:disabled){transform:translateY(1px)}',
  '.dsh-upd button[aria-busy="true"]{cursor:wait;animation:dsh-upd-pulse 1s ease-in-out infinite}',
  '@keyframes dsh-upd-pulse{0%,100%{opacity:1}50%{opacity:.55}}',
  // —— 状态横幅淡入 + 日志折叠格动画（纯 CSS；重绘只发生在真变时；reduced-motion 下静止）——
  '.dsh-upd-banner{animation:dsh-upd-fadein .22s ease}',
  '@keyframes dsh-upd-fadein{from{opacity:.35;transform:translateY(2px)}}',
  '.dsh-upd-changelog-foldbox{display:grid;grid-template-rows:1fr;opacity:1;transition:grid-template-rows .22s ease,opacity .18s ease}',
  '.dsh-upd-changelog-foldbox-inner{min-height:0;overflow:hidden}',
  '.dsh-upd-changelog-foldbox[data-open="0"]{grid-template-rows:0fr;opacity:0}',
  // 在途转圈：纯 CSS ::after，不加 DOM 节点（内核 DOM 冻结）；转的是边框缺口，不是 emoji。
  '.dsh-upd button[aria-busy="true"]::after{content:"";display:inline-block;width:11px;height:11px;margin-left:8px;vertical-align:-1px;',
  'border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:dsh-upd-spin .8s linear infinite}',
  '@keyframes dsh-upd-spin{to{transform:rotate(360deg)}}',
  '@media (prefers-reduced-motion: reduce){.dsh-upd button{transition:none}.dsh-upd button:active:not(:disabled){transform:none}.dsh-upd button[aria-busy="true"]{animation:none}.dsh-upd-skv{animation:none}.dsh-upd-banner{animation:none}.dsh-upd-changelog-foldbox{transition:none}}',
  '@media (forced-colors: active){.dsh-upd-overlay .dsh-upd-body .dsh-upd-chap-head{background:Canvas}}',
  // —— 查新版布局稳定：按钮预留宽度 + 动态区最小高度 + 锚定不漂（只稳布局，不改文案语义）——
  '.dsh-upd{overflow-anchor:none}',
  '.dsh-upd-body{overflow-anchor:none}',
  '.dsh-upd-actions{display:flex;flex-wrap:wrap;align-items:center;min-height:34px}',
  '.dsh-upd-actions button:first-child{min-width:8em;text-align:center}',
  '.dsh-upd-actions button[data-primary="1"]{min-width:7em;text-align:center}',
  '.dsh-upd-actions button:first-child:not([aria-busy="true"])::after{content:"";display:inline-block;width:11px;height:11px;margin-left:8px;visibility:hidden}',
  '.dsh-upd-banner{min-height:1.2em}',
  '.dsh-upd-strip{min-height:48px}',
  // —— 查新版瞬时抖动补强：忙闲两帧同高 + 横幅不动（只追加覆盖，不改上面既有串）——
  '.dsh-upd-actions{align-content:flex-start}',
  '.dsh-upd-actions button{white-space:nowrap}',
  '.dsh-upd-actions button:first-child{min-width:10em}',
  '.dsh-upd-actions button[data-primary="1"]{min-width:9em}',
  '.dsh-upd-banner{min-height:3.4em;display:flex;flex-direction:column;justify-content:center}',
  '.dsh-upd-banner{animation:none}',
  // —— 横幅副行：色框之外的第二行补充说明（居左小字；两主题共用结构，皮肤各自收敛）——
  '.dsh-upd-banner-sub{font-size:12.5px;opacity:.75;margin:2px 0 8px;text-align:left}',
  // #99 真节点行内章：默认主题不画（Archive 串里才显示）；节点常驻 DOM（双主题内核逐字同一份）。
  '.dsh-upd-banner>div:first-child>.dsh-upd-sealmini{display:none}',
  '.dsh-upd-copy{min-height:1.75em}',
  '.dsh-upd-copy--empty{visibility:hidden}',
  '@media (prefers-color-scheme: dark){.dsh-upd{--dsh-update-text:#e5e7eb;--dsh-update-bg:#111827;--dsh-update-border:#374151;',
  '--dsh-update-button-bg:#1f2937;--dsh-update-bg-soft:#1f2937;--dsh-update-primary:#3b82f6;--dsh-update-focus:#93c5fd;',
  // 横幅深色覆盖：底色用低透明度同色系（不是浅色原值），边线提亮，保证「深底浅字」可读。
  '--dsh-update-ok-bg:rgba(16,185,129,.14);--dsh-update-ok-border:#34d399;',
  '--dsh-update-warn-bg:rgba(245,158,11,.16);--dsh-update-warn-border:#fbbf24;',
  '--dsh-update-bad-bg:rgba(239,68,68,.16);--dsh-update-bad-border:#f87171;',
  '--dsh-update-busy-bg:rgba(59,130,246,.16);--dsh-update-busy-border:#60a5fa}}',
].join('\n')

// ---------- Archive 档案卷可选主题（#20：只换肤，不换 DOM 顺序） ----------
//
// 约束（验收线）：内核 DOM 冻结——主题只换颜色/字体/间距，不得改顺序、不得藏复制诊断。
// 要素映射（原型 `prototype/redesign/archive.html` → 现有内核类，逐条对齐原型行号）：
// 大印章 → 根元素 `::before` + `content:attr(data-seal)`（原型 :206 `.seal`，右上 88px 旋转 -7°，
//          外框 + 内细框用两条 inset 阴影合成，不加节点）；色调按 `data-seal-tone` 四档。
// 小印章 → `.dsh-upd-banner::before` + `content:attr(data-mini)`（原型 :215 `.sealmini`，30px 旋转 -5°）；
//          **待重启横幅不画印章**——那一档的标记是手绘 SVG（原型 :446 `.mark` 只有 SVG）。
// profile 牌 → `.dsh-upd-log code`（现有插件标识 code 穿上牌样式，不加节点）；
// 待重启衬线横幅 → `[data-kind="restart"]` 衬线字体 + 警告配色 + 标题行左侧 SVG 标；
// 横幅副行 → `.dsh-upd-banner-sub`（行动句住色框之外、框下第二行居左；色框只装标题 strong）；
// 动作行 → `.dsh-upd-actions` 照原型 `.btn` 收紧（13px、无最小宽、8px 间距；复制类小按钮 12px）；
// 日志 → `.dsh-upd-changelog` 照原型 `.logver`（版本 mono 粗体、分类头隐藏改条目前缀红字）；
// 窄屏印章固定 → 640px 下印章固定 24px、不被挤掉，操作区换行；
// 优先级逐字折叠 → CSS 省略号逐字折叠（标题行单行省略；JS 引擎不移植：它要 data-fold 标记，会动 DOM）；
// 浅深双主题 → 同一套变量，浅色默认 + `prefers-color-scheme: dark` 深色（跟随系统，与默认主题同口径）。
// 可访问性：焦点环永不去掉；forced-colors 走系统色；reduced-motion 关掉一切过渡动画。
// 复制诊断永不隐藏：本串任何选择器都不对 `[data-action="copy-diag"]` / `.dsh-upd-manual` 写 `display:none`。
export const UPDATE_PANEL_ARCHIVE_CSS = [
  '/* Archive 档案卷可选主题：只换颜色/字体/间距；内核 DOM 顺序一字不动，不断复制诊断。 */',
  '.dsh-upd[data-theme="archive"]{--dsh-update-bg-soft:#f7f3ea;--dsh-update-bg:#fffdf6;--dsh-update-text:#1a1a1a;--dsh-update-text-muted:#6f675a;',
  '--dsh-update-border:#e3d9c4;--dsh-update-border-strong:#c4b896;--dsh-update-primary:#c8402a;--dsh-update-primary-deep:#9c2e1d;',
  '--dsh-update-ok-text:#1a7f37;--dsh-update-ok-bg:#e9f4ea;--dsh-update-warn-text:#8a5a00;--dsh-update-warn-bg:#fbf0d0;',
  '--dsh-update-bad-text:#b3261e;--dsh-update-bad-bg:#fbe9e5;',
  '--dsh-update-font-serif:Georgia,"Songti SC","STSong","SimSun","Noto Serif CJK SC","Source Han Serif SC",serif;',
  '--dsh-update-font-sans:system-ui,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;',
  '--dsh-update-font-mono:ui-monospace,"SF Mono",SFMono-Regular,Consolas,"Noto Sans Mono",monospace;',
  '--dsh-update-shadow:0 1px 2px rgba(60,40,20,.08),0 12px 32px rgba(60,40,20,.10);',
  'font-family:var(--dsh-update-font-sans);color:var(--dsh-update-text);background:var(--dsh-update-bg);',
  'border:1px solid var(--dsh-update-border-strong);border-radius:var(--dsh-update-radius-panel,4px);box-shadow:var(--dsh-update-shadow)}',
  // 按钮脸自己不透明（宿主底色未知时也读得出；卡片上渲染与 transparent 逐字同色）。
  '.dsh-upd[data-theme="archive"] button{border-color:var(--dsh-update-border-strong);background:var(--dsh-update-button-bg);color:var(--dsh-update-text);border-radius:var(--dsh-update-radius-button,3px);font-family:var(--dsh-update-font-sans)}',
  '.dsh-upd[data-theme="archive"] button:hover:not(:disabled){border-color:var(--dsh-update-primary);color:var(--dsh-update-primary)}',
  '.dsh-upd[data-theme="archive"] button[data-primary="1"]{background:var(--dsh-update-primary);border-color:var(--dsh-update-primary);color:#fff}',
  '.dsh-upd[data-theme="archive"] button[data-primary="1"]:hover:not(:disabled){background:var(--dsh-update-primary-deep);color:#fff}',
  '.dsh-upd[data-theme="archive"] button:focus-visible{outline:2px solid var(--dsh-update-primary);outline-offset:2px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner{background:var(--dsh-update-bg-soft);border-color:var(--dsh-update-border-strong)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="update"]{border-color:var(--dsh-update-ok-border);background:var(--dsh-update-ok-bg)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="busy"]{border-color:var(--dsh-update-busy-border);background:var(--dsh-update-busy-bg)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="restart"]{border-color:var(--dsh-update-warn-border);background:var(--dsh-update-warn-bg);font-family:var(--dsh-update-font-serif);border-width:2px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="failed"],.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="blocked"]{border-color:var(--dsh-update-bad-border);background:var(--dsh-update-bad-bg)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="done"]{border-color:var(--dsh-update-ok-border);background:var(--dsh-update-ok-bg)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-yanked{border-color:var(--dsh-update-warn-text);background:var(--dsh-update-warn-bg);color:var(--dsh-update-text)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-breaking-badge{color:var(--dsh-update-primary);border-color:var(--dsh-update-primary)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-count{color:var(--dsh-update-text-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-more-note{color:var(--dsh-update-text-muted)}',
  // —— 大印章（原型 :206 `.seal`：右上 88px、旋转 -7°、双细框；内容与色调来自根属性，不加节点）——
  '.dsh-upd[data-theme="archive"]{position:relative;padding:16px 20px 14px}',
  '.dsh-upd[data-theme="archive"]::before{content:attr(data-seal);position:absolute;top:20px;right:24px;width:88px;height:88px;',
  'display:flex;align-items:center;justify-content:center;text-align:center;letter-spacing:.18em;text-indent:.18em;line-height:1.35;',
  'border:3px solid currentColor;border-radius:14px;transform:rotate(-7deg);font-family:var(--dsh-update-font-serif);font-weight:700;font-size:21px;',
  'background:color-mix(in srgb,currentColor 8%,transparent);user-select:none;pointer-events:none;',
  'box-shadow:inset 0 0 0 5px var(--dsh-update-bg),inset 0 0 0 6px currentColor,0 2px 6px rgba(0,0,0,.12)}',
  '.dsh-upd[data-theme="archive"][data-seal-tone="ink"]::before{color:var(--dsh-update-text-muted)}',
  '.dsh-upd[data-theme="archive"][data-seal-tone="green"]::before{color:var(--dsh-update-ok-text)}',
  '.dsh-upd[data-theme="archive"][data-seal-tone="yellow"]::before{color:var(--dsh-update-warn-text)}',
  '.dsh-upd[data-theme="archive"][data-seal-tone="red"]::before{color:var(--dsh-update-bad-text)}',
  // 印章占位：首行（横幅/状态行）右侧留出 120px，文字不许压到印章上（原型 .filehead padding-right:120px）
  // —— 卷宗抬头（原型 :195-203 的刊头，主题切换按钮按用户口径去掉）：只有 Archive 档案卷才显示 ——
  '.dsh-upd[data-theme="archive"] .dsh-upd-masthead{display:block;padding:0 0 8px;margin:0 0 8px;border-bottom:1px solid var(--dsh-update-border)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-masthead-kicker{display:block;font-size:11px;letter-spacing:.35em;color:var(--dsh-update-text-muted);margin-bottom:3px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-masthead-title{font-family:var(--dsh-update-font-serif);font-size:26px;font-weight:700;line-height:1.2}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-masthead-title i{color:var(--dsh-update-primary);font-style:normal}',
  // 横幅不再给大印章留 124px：实测（headless 量盒子）印章盒底边 y=109，横幅正文顶边 y=108、
  // 状态行那句在 y=159——印章只压到横幅顶部的留白带，压不到正文。留着反而把 27px 那句话挤成两行
  // （27px 单行需 428px，留白后只剩 366px）。档案头那 120px 保留：那里是真的重叠。
  // —— 更新队列（03 章）Archive 皮肤 ——
  '.dsh-upd[data-theme="archive"] .dsh-upd-qrow{padding:6px 0}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-qk{width:66px;letter-spacing:.18em}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-qv{font-family:var(--dsh-update-font-serif);font-size:16px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-qn{font-family:var(--dsh-update-font-mono);font-size:11.5px;color:var(--dsh-update-text-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-qseq{color:var(--dsh-update-text-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-chap-note{color:var(--dsh-update-text-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-body .dsh-upd-chap-head{background:var(--dsh-update-bg)}',
  '.dsh-upd-overlay .dsh-upd[data-theme="archive"] .dsh-upd-body{scrollbar-color:var(--dsh-update-border-strong) transparent}',
  '.dsh-upd-overlay .dsh-upd[data-theme="archive"] .dsh-upd-body::-webkit-scrollbar-thumb{background:var(--dsh-update-border-strong)}',
  // —— 小印章（原型 :215 `.sealmini`：30px、旋转 -5°、一字；#99：真节点行内章）——
  // 待重启横幅一律不画印章：那一档的标记是左侧手绘 SVG（原型 :446 的 .mark 只有 SVG）。
  // #99 注：印章曾是横幅的 ::before 伪元素，但内核横幅是纵向 flex（#93 契约冻结），伪元素只能独占一行；
  // 英文词撑宽后固定缩进又会与标题重叠——纯 CSS 走不通。改为横幅首行内的真实行内节点（aria-hidden，
  // 默认主题隐藏），与原型 `.sealmini + 文字` 同结构；data-mini 属性保留（取证与快照口径不变）。
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="loading"] .dsh-upd-sealmini,.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="idle"] .dsh-upd-sealmini,',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="update"] .dsh-upd-sealmini,.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="busy"] .dsh-upd-sealmini,',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="blocked"] .dsh-upd-sealmini,.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="failed"] .dsh-upd-sealmini,',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="done"] .dsh-upd-sealmini{display:inline-flex;align-items:center;justify-content:center;width:auto;min-width:34px;height:34px;padding:0 6px;box-sizing:border-box;white-space:nowrap;vertical-align:middle;margin-right:10px;',
  'border:2px solid currentColor;border-radius:7px;',
  'font-family:var(--dsh-update-font-serif);font-weight:700;font-size:16px;line-height:26px;transform:rotate(-5deg);color:var(--dsh-update-text-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="update"] .dsh-upd-sealmini{color:var(--dsh-update-ok-text)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="busy"] .dsh-upd-sealmini{color:var(--dsh-update-warn-text)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="blocked"] .dsh-upd-sealmini,.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="failed"] .dsh-upd-sealmini{color:var(--dsh-update-bad-text)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="done"] .dsh-upd-sealmini{color:var(--dsh-update-ok-text)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-log code{font-family:var(--dsh-update-font-mono);font-size:11px;color:var(--dsh-update-text-muted);border:1px solid var(--dsh-update-border-strong);border-radius:3px;padding:0 6px;letter-spacing:.06em}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-manual code{display:block;background:var(--dsh-update-text);color:var(--dsh-update-bg-soft);font-family:var(--dsh-update-font-mono);font-size:12.5px;padding:12px 14px;border-radius:4px;white-space:pre-wrap;word-break:break-all}',
  // 待重启标记：手绘 SVG 当**独立 flex 标记**放在文字块左侧（原型 :446 `.mark` 是独立节点），
  // 不能用行内背景——那样换行时三角会落在句子中间把话劈开（现场回归）。
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="restart"]>div:first-child{display:flex;gap:10px;align-items:flex-start}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="restart"]>div:first-child::before{content:"";flex:none;width:20px;height:20px;margin-top:3px;',
  'background:url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2720%27 height=%2720%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%238a5a00%27 stroke-width=%272%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27%3E%3Cpath d=%27M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z%27/%3E%3Cline x1=%2712%27 y1=%279%27 x2=%2712%27 y2=%2713%27/%3E%3Cline x1=%2712%27 y1=%2717%27 x2=%2712.01%27 y2=%2717%27/%3E%3C/svg%3E") no-repeat center/20px 20px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner>div:first-child{overflow:hidden;text-overflow:ellipsis}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-actions{flex-wrap:wrap}',
  // footer 只换肤（#47 定案 A + Archive 约束：不换 DOM 顺序；复制诊断永不隐藏，本串不动它）。
  '.dsh-upd[data-theme="archive"] .dsh-upd-footer{margin-top:14px;padding-top:10px;border-top:1px solid var(--dsh-update-border)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-foot-note{color:var(--dsh-update-text-muted)}',
  // —— 档案头（原型 :208-211 `.filehead`：serif 插件名 22px + 使用范围 + profile 牌；右侧留章位）——
  '.dsh-upd[data-theme="archive"] .dsh-upd-head{display:flex;gap:16px;align-items:baseline;flex-wrap:wrap;padding-right:120px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-name{font-family:var(--dsh-update-font-serif);font-size:22px;font-weight:700}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-meta{width:100%;font-size:12.5px;color:var(--dsh-update-text-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-meta b{color:var(--dsh-update-text);font-weight:600}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-proftag{font-family:var(--dsh-update-font-mono);font-size:11px;color:var(--dsh-update-text-muted);border:1px solid var(--dsh-update-border-strong);border-radius:3px;padding:0 6px;margin-left:8px;letter-spacing:.06em}',
  // —— 版本条（原型 :216 `.strip`：三格，格间一线，左上小写标签 + 等宽值）——
  '.dsh-upd[data-theme="archive"] .dsh-upd-strip{display:flex;flex-wrap:wrap;margin:8px 0 0;border:1px solid var(--dsh-update-border);border-radius:4px;overflow:hidden;font-size:12.5px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-strip>div{flex:1 1 120px;padding:6px 10px;border-left:1px solid var(--dsh-update-border)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-strip>div:first-child{border-left:0}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-strip-k{display:block;font-size:11px;letter-spacing:.2em;color:var(--dsh-update-text-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-strip-v{font-family:var(--dsh-update-font-mono);font-size:13px}',
  // —— 章节（原型 :218-245：01–05 编号 + 衬线标题 + 细线）——
  '.dsh-upd[data-theme="archive"] .dsh-upd-chapter{margin-top:16px;padding-top:10px;border-top:1px solid var(--dsh-update-border)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-chap-head{display:flex;align-items:baseline;gap:12px;margin-bottom:6px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-chap-no{font-family:var(--dsh-update-font-serif);font-style:italic;font-size:15px;color:var(--dsh-update-text-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-chap-title{font-family:var(--dsh-update-font-serif);font-size:17px;margin:0;letter-spacing:.1em}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-chap-rule{flex:1;border-top:1px solid var(--dsh-update-border);transform:translateY(-4px)}',
  // —— 横幅即状态行 / 待重启横幅（原型 :81-85 `.restart-banner`：2px 边框、圆角 4、内边距 12/16、衬线；右侧留章位）——
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner{border:2px solid var(--dsh-update-border-strong);border-radius:4px;padding:10px 12px;font-size:14.5px;font-family:var(--dsh-update-font-serif);gap:10px;align-items:center}',
  // #99 标题行拉满：纵向 flex + align-items:center 会把短标题收成窄块居中（章跟着偏右）；
  // 原型状态行是整行块居左，这里 stretch 回去（只动交叉轴，主轴 stacking 与 #93 副行契约不动）。
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner>div:first-child{flex:1 1 auto;min-width:0;align-self:stretch}',
  // 状态行字号照原型 .status-line=27px（实测去掉横幅右侧占位后可写 486px > 428px，一行放得下）
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner>div:first-child strong{font-family:var(--dsh-update-font-serif);font-size:27px;font-weight:700;line-height:1.25}',
  // —— 进度条 / 跳过行（原型 :132-133 `.prog`、:129-131 `.skipline .tag`）——
  '.dsh-upd[data-theme="archive"] .dsh-upd-prog{height:8px;background:var(--dsh-update-border);border-radius:4px;overflow:hidden;margin:10px 0 4px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-prog-bar{display:block;height:100%;background:var(--dsh-update-primary);transition:width .3s}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-progtxt{font-size:12.5px;color:var(--dsh-update-text-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-skipline{font-size:13px;margin-top:8px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-tag{display:inline-block;border:1px dashed var(--dsh-update-border-strong);border-radius:3px;padding:1px 8px;margin-right:8px;font-family:var(--dsh-update-font-mono);font-size:12px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-err{font-size:13px;margin:0 0 6px;color:var(--dsh-update-text-muted)}',
  // —— 横幅副行（框外第二行居左小字；色框只装标题，原型状态行是裸文本）——
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner-sub{color:var(--dsh-update-text-muted);font-size:12.5px;text-align:left;margin:2px 0 8px}',
  // —— 动作行贴原型（d5-paper :119-125 `.btn`：13px 紧凑、无最小宽、8px 间距；复制类小按钮 12px）——
  '.dsh-upd[data-theme="archive"] .dsh-upd-actions{gap:8px;min-height:0}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-actions button{font-size:13px;line-height:1.45;padding:6px 12px;margin:0;min-width:0}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-actions button:first-child{min-width:0}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-actions button[data-primary="1"]{min-width:0}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-actions button:first-child:not([aria-busy="true"])::after{display:none}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-actions button:not([data-primary="1"]){background:transparent}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-actions button[data-action="copy-manual"],' +
  '.dsh-upd[data-theme="archive"] .dsh-upd-actions button[data-action="copy-diag"]{font-size:12px;padding:4px 10px}',
  // —— 日志贴原型（d5-paper :137-144 `.logver`：版本 mono 粗体、分类头隐藏、条目前缀红字）——
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-version{margin:12px 0}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-title{font-family:var(--dsh-update-font-mono);font-size:14px;font-weight:700}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog ul{margin:6px 0 0 2px;padding-left:18px;font-size:13.5px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog li{margin:3px 0}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-catname{display:none}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-cat[data-cat="Added"] ul li::before{content:"Added · ";color:var(--dsh-update-primary);font-weight:700}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-cat[data-cat="Fixed"] ul li::before{content:"Fixed · ";color:var(--dsh-update-primary);font-weight:700}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-cat[data-cat="Changed"] ul li::before{content:"Changed · ";color:var(--dsh-update-primary);font-weight:700}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-cat[data-cat="Security"] ul li::before{content:"Security · ";color:var(--dsh-update-primary);font-weight:700}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-fold[data-cat="Deprecated"] ul li::before{content:"Deprecated · ";color:var(--dsh-update-text-muted);font-weight:700}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-fold[data-cat="Removed"] ul li::before{content:"Removed · ";color:var(--dsh-update-text-muted);font-weight:700}',
  '@media (max-width:640px){.dsh-upd[data-theme="archive"]{padding:10px 12px}.dsh-upd[data-theme="archive"]::before{top:12px;right:12px;width:56px;height:56px;font-size:15px;box-shadow:inset 0 0 0 4px var(--dsh-update-bg),inset 0 0 0 5px currentColor}.dsh-upd[data-theme="archive"] .dsh-upd-masthead-title{font-size:19px}.dsh-upd[data-theme="archive"] .dsh-upd-banner{padding-right:16px}.dsh-upd[data-theme="archive"] .dsh-upd-banner .dsh-upd-sealmini{min-width:28px;height:28px;font-size:14px;line-height:20px}.dsh-upd[data-theme="archive"] .dsh-upd-banner>div:first-child{white-space:normal}}',
  '@media (prefers-color-scheme: dark){.dsh-upd[data-theme="archive"]{--dsh-update-bg-soft:#141210;--dsh-update-bg:#1e1a15;--dsh-update-text:#ece5d3;--dsh-update-text-muted:#a89c83;',
  '--dsh-update-border:#3a3226;--dsh-update-border-strong:#5c4e3b;--dsh-update-primary:#e0684e;--dsh-update-primary-deep:#f0866b;',
  '--dsh-update-ok-text:#8fd6a4;--dsh-update-ok-bg:rgba(80,180,120,.12);--dsh-update-warn-text:#e8c15a;--dsh-update-warn-bg:rgba(232,193,90,.12);',
  '--dsh-update-bad-text:#ef8a7d;--dsh-update-bad-bg:rgba(239,138,125,.12);--dsh-update-shadow:0 1px 2px rgba(0,0,0,.4),0 12px 32px rgba(0,0,0,.45)}}',
  '@media (prefers-color-scheme: dark){.dsh-upd[data-theme="archive"] button[data-primary="1"]{color:#141210}.dsh-upd[data-theme="archive"] button:focus-visible{outline-color:var(--dsh-update-primary-deep)}}',
  '@media (prefers-color-scheme: dark){.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="restart"]>div:first-child::before{background-image:url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2720%27 height=%2720%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%23e8c15a%27 stroke-width=%272%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27%3E%3Cpath d=%27M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z%27/%3E%3Cline x1=%2712%27 y1=%279%27 x2=%2712%27 y2=%2713%27/%3E%3Cline x1=%2712%27 y1=%2717%27 x2=%2712.01%27 y2=%2717%27/%3E%3C/svg%3E")}}',
  '@media (forced-colors: active){.dsh-upd[data-theme="archive"]{box-shadow:none}.dsh-upd[data-theme="archive"]::before{background:none;box-shadow:none;border-color:CanvasText;color:CanvasText}.dsh-upd[data-theme="archive"] .dsh-upd-banner{border:1px solid CanvasText}.dsh-upd[data-theme="archive"] .dsh-upd-banner::before{border-color:CanvasText;color:CanvasText;background:Canvas}.dsh-upd[data-theme="archive"] button{border:1px solid ButtonText}.dsh-upd[data-theme="archive"] button[data-primary="1"]{background:ButtonFace;color:ButtonText;border-color:ButtonText}.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="restart"]>div:first-child::before{background-image:none;content:"⚠"}}',
  '@media (prefers-reduced-motion: reduce){.dsh-upd[data-theme="archive"] *{transition:none !important;animation:none !important}}',
].join('\n')

function escapeHtml(text: string): string {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export interface PanelRenderInput extends PanelViewInput {
  mode: UpdatePanelMode
  showOthers: boolean
  pluginId: string
  copyNotice: string | null
  /** 渲染语言（#61 单语：缺省 zh；挂载态传 currentLang，纯函数直调可显式传 en/zh）。 */
  lang?: AppLang | string | null
  /** 可选主题：不传即默认（输出与旧版一字不差）；`archive` 切档案卷。 */
  theme?: UpdatePanelTheme
  /** 主题变量覆盖：见 UpdateThemeTokens；写到面板根上，不传即无 style 属性。 */
  themeTokens?: UpdateThemeTokens
  /** 使用范围名（profile）：面板「使用范围」一栏的唯一来源，缺省显示“未知”，不猜。 */
  profileName?: string | null
  /** 宿主种类：进诊断文本；缺省显示“未知”。 */
  hostKind?: string | null
  /**
   * 在途动作（仅挂载态内部用：点下查新版/安装到回包前的那一帧，按钮置忙）。
   * 缺省即静默（输出与旧版一字不差）；只在挂载器置忙的那次 render 里传。
   */
  busyAct?: 'check' | 'install' | null
  /** 失败引用（失败档案的查询键；缺省即无失败，不画卷宗）。 */
  failure?: PanelFailureRef | null
  /** 日志指引开关：false 即藏通用日志行（失败证据行不受影响）。 */
  showLogHint?: boolean
  /**
   * 动作面归谁：`default`（缺省）由内核画动作按钮；`none` 只画内容、不画按钮。
   * 给「调用方自己提供动作面」的场景（如批量面板的详情：动作由批量面板经自己的通道提供）。
   * 只读渲染下五章内容、进度条、「已跳过」提示一字不减，只是没有动作按钮。
   */
  actions?: 'default' | 'none'
  /**
   * 更新日志折叠（仅挂载态内部用：用户点了 02 章标题行的收起/展开）。
   * 缺省即展开（安全日志必显、可查找；只读渲染下恒展开）。
   */
  changelogCollapsed?: boolean
}

/** 章节骨架（照原型 archive.html:218-245 的 01–05 编号顺序；#62 入字典按 lang 单语）。 */
const CHAPTER_KEYS = [
  'panel.chapter.check',
  'panel.chapter.changelog',
  'panel.chapter.queue',
  'panel.chapter.error',
  'panel.chapter.manual',
] as const
function chapterTitle(index: 1 | 2 | 3 | 4 | 5, lang?: AppLang | string | null): string {
  const l = normalizeLangTag(lang ?? 'zh')
  return copyText(CHAPTER_KEYS[index - 1] as BilingualKey, l)
}

/** 内核渲染用的失败引用（只读快照：证据仍在锁存里，这里只传展示键）。 */
export interface PanelFailureRef {
  requestId: string | null
  checkId: string | null
  atMs: number | null
  source: 'check' | 'install' | null
  volatile: boolean
  /** 失败那次安装的目标版本（无则不画行）。 */
  targetVersion: string | null
}

/** 锁存时刻 → 本地 HH:MM:SS（失败档案“失败于”用；非法值回 null，不画时间；#62 跟随宿主 locale）。 */
export function formatLatchTime(atMs: unknown, lang?: AppLang | string | null): string | null {
  if (typeof atMs !== 'number' || !Number.isFinite(atMs) || atMs <= 0) return null
  const raw = typeof lang === 'string' ? lang.trim().replace(/_/g, '-') : ''
  const l = normalizeLangTag(lang ?? 'zh')
  const primary = l === 'en' ? 'en-US' : 'zh-CN'
  const fallback = l === 'en' ? 'zh-CN' : 'en-US'
  const candidates: string[] = []
  if (raw && raw !== primary && /^[A-Za-z]{2,3}(-[A-Za-z0-9]+)*$/.test(raw)) candidates.push(raw)
  candidates.push(primary, fallback)
  for (const tag of candidates) {
    try {
      const s = new Date(atMs).toLocaleTimeString(tag, { hour12: false })
      if (s) return s
    } catch {
      // 非法标签即试下一个，保留既有 try/catch 不抛。
    }
  }
  return null
}

function chapterOf(index: 1 | 2 | 3 | 4 | 5, inner: string, note = '', lang?: AppLang | string | null): string {
  const no = String(index).padStart(2, '0')
  const l = normalizeLangTag(lang ?? 'zh')
  const title = chapterTitle(index, l)
  return (
    `<section class="dsh-upd-chapter" data-chapter="${no}">` +
    `<div class="dsh-upd-chap-head"><span class="dsh-upd-chap-no">${no}</span>` +
    `<h3 class="dsh-upd-chap-title">${escapeHtml(title)}</h3><span class="dsh-upd-chap-rule"></span>${note}</div>` +
    `${inner}</section>`
  )
}

/** 首帧骨架：快照没到之前占住版本条的位置，纯 CSS 微光（aria-hidden，不进语义；#62 跟随 lang）。 */
function skeletonStrip(loading: boolean, lang?: AppLang | string | null): string {
  if (!loading) return ''
  const l = normalizeLangTag(lang ?? 'zh')
  const cell = (k: string): string =>
    `<div><span class="dsh-upd-strip-k">${escapeHtml(k)}</span>` +
    `<span class="dsh-upd-strip-v dsh-upd-skv" aria-hidden="true">…</span></div>`
  return `<div class="dsh-upd-strip" aria-hidden="true">` + cell(copyText('panel.strip.running', l)) + cell(copyText('panel.strip.installed', l)) + cell(copyText('panel.strip.latest', l)) + `</div>`
}

/** 版本条三格（照原型 :216 `.strip`：运行 / 磁盘 / 远端；#62 跟随 lang，未知走字典）。 */
function versionStrip(snapshot: UpdateSnapshot | null, lang?: AppLang | string | null): string {
  const l = normalizeLangTag(lang ?? 'zh')
  const unknown = copyText('panel.meta.unknown', l)
  const cell = (k: string, v: string | null): string =>
    `<div><span class="dsh-upd-strip-k">${escapeHtml(k)}</span><span class="dsh-upd-strip-v">${escapeHtml(v ?? unknown)}</span></div>`
  if (!snapshot) return ''
  return (
    `<div class="dsh-upd-strip">` +
    cell(copyText('panel.strip.running', l), snapshot.runningVersion) +
    cell(copyText('panel.strip.installed', l), snapshot.installedVersion) +
    cell(copyText('panel.strip.latest', l), snapshot.latestVersion) +
    `</div>`
  )
}

/** 安装进度条（照原型 :221-222）：只在 installing / verifying 时出现，纯展示，不参与门控（#62 跟随 lang）。 */
function progressBar(snapshot: UpdateSnapshot | null, lang?: AppLang | string | null): string {
  const job = snapshot?.job
  if (!job) return ''
  const state = String(job.state)
  if (state !== 'installing' && state !== 'verifying') return ''
  const l = normalizeLangTag(lang ?? 'zh')
  const width = state === 'installing' ? 60 : 90
  const text = state === 'installing' ? copyText('panel.progress.installing', l) : copyText('panel.progress.verifying', l)
  return (
    `<div class="dsh-upd-prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${width}">` +
    `<i class="dsh-upd-prog-bar" style="width:${width}%"></i></div>` +
    `<div class="dsh-upd-progtxt">${escapeHtml(text)}</div>`
  )
}

/** 内核 HTML（双形态行为等价的根：同一视图产出同一内核，只换外层；#62 按 lang 单语，缺省 zh 零回归）。 */
export function renderUpdatePanelKernel(input: PanelRenderInput, view: PanelView, lang?: AppLang | string | null): string {
  const { snapshot, manual, queue, mode, showOthers, pluginId, copyNotice } = input
  const l = normalizeLangTag(lang ?? (input as { lang?: unknown }).lang ?? 'zh')
  const changelogMarkdown =
    (input as { changelogMarkdown?: unknown }).changelogMarkdown ?? null
  const profileName =
    typeof (input as { profileName?: unknown }).profileName === 'string' && (input as { profileName: string }).profileName
      ? (input as { profileName: string }).profileName
      : null
  const b = view.banner
  const seal = view.seal
  const parts: string[] = []
  // 卷宗抬头（原型 :195-203 的刊头；主题切换按钮按用户口径去掉——那排按钮不重要）。
  // 两个主题共用同一份内核 HTML：默认（最小）主题由 CSS 不显示，Archive 档案卷才画。
  parts.push(
    '<div class="dsh-upd-masthead"><span class="dsh-upd-masthead-kicker">' + escapeHtml(copyText('panel.masthead.kicker', l)) + '</span>' +
      '<span class="dsh-upd-masthead-title">' + escapeHtml(copyText('panel.masthead.title', l)) + ' <i>' + escapeHtml(copyText('panel.masthead.volume', l)) + '</i></span></div>',
  )
  // 档案头（原型 :208-211 `.filehead`）：插件名 + 使用范围 + profile 牌。
  // 「使用范围」这一栏是更新落点的展示面：web / desktop 各装一份，装错范围是严重故障，
  // 所以这里宁可显示「未知」也不猜。
  parts.push(
    `<div class="dsh-upd-head"><span class="dsh-upd-name">${escapeHtml(pluginId)}</span>` +
      `<span class="dsh-upd-meta">${escapeHtml(copyText('panel.meta.label', l))} <b>${escapeHtml(profileName ?? copyText('panel.meta.unknown', l))}</b>` +
      `<span class="dsh-upd-proftag">profile</span></span></div>`,
  )
  // 横幅：状态行 / 待重启横幅（原型 :213-215 restartSlot + 状态行）。
  // 小印章是首行内的真实行内节点（#99；原型 :215 `.sealmini + 文字` 同结构）；待重启档不挂印章——
  // 那一档的标记是手绘 SVG（原型 :446 只有 SVG）。章对读屏隐藏（标题文本已含语义），默认主题由 CSS 隐藏。
  parts.push(`<div class="dsh-upd-banner" data-kind="${b.kind}" data-mini="${escapeHtml(seal.mini)}" role="status" aria-live="polite">`)
  parts.push(`<div>${b.kind === 'restart' ? '' : `<span class="dsh-upd-sealmini" aria-hidden="true">${escapeHtml(seal.mini)}</span>`}<strong>${escapeHtml(b.title)}</strong></div>`)
  parts.push('</div>')
  // 横幅副行（行动句）：放在色框之外、框下第二行居左（原型口径：状态行是裸文本，色框只装标题）。
  // 色框（绿/蓝/黄）只装标题 strong，副行是框外的补充说明，不进 role=status 的框体。
  if (b.action) parts.push(`<div class="dsh-upd-banner-sub">${escapeHtml(b.action)}</div>`)
  // 版本条（原型 :216 `.strip`）：运行 / 磁盘 / 远端三格。
  // 首帧无快照：画骨架占位（纯 CSS 微光，不加语义节点；快照一到即换真格）。
  parts.push(snapshot ? versionStrip(snapshot, l) : skeletonStrip(view.banner.kind === 'loading', l))
  // —— 01 检查与安装（原型 :218-224）：动作 + 进度条 + 跳过行 ——
  // 只读渲染（`actions: 'none'`）：调用方自己提供动作面时用（批量面板的详情就是这种）。
  // 五章内容、进度条、「已跳过」提示照画，唯独不画动作按钮——免得出现「可点却没人接」的死按钮。
  const showActions = input.actions !== 'none'
  const actions: string[] = []
  if (showActions) {
  const busyAct = (input as { busyAct?: unknown }).busyAct
  const checkBusy = busyAct === 'check'
  const installBusy = busyAct === 'install'
  // #87 宏忙守卫（与批量 macroBusy 同口径）：快照 installing/verifying 或任一本地电话在飞，两键一起置灰。只渲染不推导：不改电话形状与快照字段，不新增文案键。
  const jobState = (snapshot as unknown as { job?: { state?: unknown } } | null)?.job?.state
  const snapshotBusy = jobState === 'installing' || jobState === 'verifying'
  const macroBusy = busyAct === 'check' || busyAct === 'install' || snapshotBusy
  actions.push('<div class="dsh-upd-actions">')
  // 在途那一帧：按钮禁用 + 文案切换 + aria-busy（静默时输出与旧版一字不差）。
  // title 是零成本原生 tooltip：不引入浮层组件，只给悬停一句话说明。
  // 宏守卫只加 disabled，不换文案不加键：忙的不是本键时沿用闲态文案，仅置灰防并发。
  actions.push(
    (checkBusy
      ? `<button type="button" data-action="check" disabled aria-busy="true" title="${escapeHtml(copyText('panel.action.checking-busy-title', l))}">${escapeHtml(copyText('panel.action.checking-busy', l))}</button>`
      : `<button type="button" data-action="check" title="${escapeHtml(copyText('panel.action.check-title', l))}"${macroBusy ? ' disabled' : ''}>${escapeHtml(copyText('panel.action.check', l))}</button>`) +
      (installBusy
        ? `<button type="button" data-action="install" data-primary="1" disabled aria-busy="true" title="${escapeHtml(copyText('panel.action.installing-busy-title', l))}">${escapeHtml(copyText('panel.action.installing-busy', l))}</button>`
        : `<button type="button" data-action="install" data-primary="1" title="${escapeHtml(copyText('panel.action.install-title', l))}"${macroBusy || !view.installEnabled ? ' disabled' : ''}>${escapeHtml(view.installLabel)}</button>`),
  )
  if (snapshot?.latestVersion && !view.skippedLatest && view.banner.kind === 'update') {
    actions.push(`<button type="button" data-action="skip" title="${escapeHtml(copyText('panel.action.skip-title', l))}">${escapeHtml(copyText('panel.action.skip', l))}</button>`)
  }
  if (view.showReset && snapshot?.latestVersion) {
    actions.push(`<button type="button" data-action="reset-skip" title="${escapeHtml(copyText('panel.action.unskip-title', l))}">${escapeHtml(copyText('panel.action.unskip', l, { version: snapshot.latestVersion }))}</button>`)
  }
  if (view.showManual && manual) {
    actions.push(`<button type="button" data-action="copy-manual" title="${escapeHtml(copyText('panel.action.copy-manual-title', l))}">${escapeHtml(copyText('panel.action.copy-manual', l))}</button>`)
  }
  // 原型的待重启横幅右侧有个主动作「重启宿主」（archive.html:448）。
  // 宿主没有「重启自己」的电话，所以这里只做入口：调用方给了 onRestartRequested 就交给它，
  // 没给就如实提示「请手动重启」——不假装能重启。
  if (b.kind === 'restart') {
    actions.push(`<button type="button" data-action="restart-hint" title="${escapeHtml(copyText('panel.action.restart-host-title', l))}">${escapeHtml(copyText('panel.action.restart-host', l))}</button>`)
  }
  if (b.kind === 'failed') {
    actions.push(`<button type="button" data-action="dismiss-failure" title="${escapeHtml(copyText('panel.action.dismiss-title', l))}">${escapeHtml(copyText('panel.action.dismiss', l))}</button>`)
  }
  if (snapshot) {
    actions.push(`<button type="button" data-action="copy-diag" title="${escapeHtml(copyText('panel.action.copy-diag-title', l))}">${escapeHtml(copyText('panel.action.copy-diag', l))}</button>`)
  }
  // 关闭不住第一章（#47 定案 A）：dialog 的关闭住右下角独立 footer 区（见内核末尾）；
  // embedded 无面板自带关闭（宿主框架自带关），与 requestDialogClose 只认 dialog 同口径。
  actions.push('</div>')
  }
  actions.push(progressBar(snapshot, l))
  if (view.skippedLatest && snapshot?.latestVersion) {
    actions.push(
      `<div class="dsh-upd-skipline"><span class="dsh-upd-tag">${escapeHtml(copyText('panel.skip.line-tag', l, { version: snapshot.latestVersion }))}</span>` +
        `${escapeHtml(copyText('panel.skip.line-note', l))}</div>`,
    )
  }
  // 章节滚动区：01–05 先收进同一组，再包一层可滚动体；头尾留在外面固定。
  const chapters: string[] = []
  chapters.push(chapterOf(1, actions.join(''), '', l))
  // —— 02 更新日志（原型 :226-229）：章节恒在；缺日志给中性提示，不挡安装、不改门控 ——
  // 折叠只影响展示：默认展开（安全日志必显、可查找）；开关在标题行右端，与 03 章开关同一位置语言。
  {
    let inner = ''
    let hasLog = false
    if (snapshot && snapshot.latestVersion) {
      try {
        const mdText = typeof changelogMarkdown === 'string' ? changelogMarkdown : ''
        const entries = parseChangelog(mdText)
        const ranged = changelogForUpdate(
          entries,
          snapshot.runningVersion,
          snapshot.latestVersion,
          snapshot.installedVersion,
        )
        const changelogHTML = renderChangelogHTML(ranged, { lang: l })
        const fromText = String(snapshot.runningVersion ?? '')
        const toText = String(snapshot.latestVersion ?? '')
        const rangeTitle =
          fromText && toText ? copyText('panel.changelog.heading-range', l, { from: fromText, to: toText }) : copyText('panel.changelog.heading', l)
        let yankedBanner = ''
        try {
          const toEntry = Array.isArray(ranged) ? ranged.find(function(e) { try { return e && e.version === toText; } catch { return false; } }) : null
          if (toEntry && (toEntry as { yanked?: unknown }).yanked === true && toText) { yankedBanner = yankedBannerHTML(toText, l); }
        } catch { yankedBanner = ''; }
        const logOpen = (input as { changelogCollapsed?: unknown }).changelogCollapsed !== true
        inner = `<div class="dsh-upd-changelog-wrap"><div>${escapeHtml(rangeTitle)}</div>` +
          `<div class="dsh-upd-changelog-foldbox" data-open="${logOpen ? '1' : '0'}"><div class="dsh-upd-changelog-foldbox-inner">${yankedBanner}\n${changelogHTML}\n</div></div></div>`
        hasLog = Array.isArray(ranged) && ranged.length > 0
      } catch {
        // 日志画坏了也不挡更新：退回中性提示，安装按钮状态不变。
        inner = ''
      }
    }
    if (!inner) {
      inner = `<div class="dsh-upd-changelog-wrap"><div class="dsh-upd-changelog-neutral">${escapeHtml(
        snapshot && snapshot.latestVersion ? copyText('panel.changelog.unavailable', l) : copyText('panel.changelog.unavailable-empty', l),
      )}</div></div>`
    }
    const logCollapsed = (input as { changelogCollapsed?: unknown }).changelogCollapsed === true
    const logNote = showActions && hasLog
      ? '<span class="dsh-upd-chap-note"><button type="button" data-action="toggle-changelog" title="' + escapeHtml(copyText('panel.changelog.toggle-title', l)) + '">' +
        `${escapeHtml(logCollapsed ? copyText('panel.changelog.expand', l) : copyText('panel.changelog.collapse', l))}</button></span>`
      : ''
    chapters.push(chapterOf(2, inner, logNote, l))
  }
  // —— 03 更新队列（原型 :231-235）：章节恒在（没排队也给一句话，编号不许跳）——
  // 设计定案（2026-10-04，见 03 章设计稿）：正文改成两行键值（正在安装 / 你的顺位），
  // 开关仍是**按钮**（不是原型的复选框），位置照原型挪到章节标题行右端。
  {
    const queued = !!queue && (queue.busy || queue.waiting.length > 0)
    if (queued && queue) {
      const busy = queue.busy
      const ownerRaw = queue.owner
      // 他人标识只在 showOthers 打开时才露：宿主默认已折过一道，这里再守一道
      // （调用方直接塞原始队列时，面板也不许把人家的插件名印出来）。
      const named =
        ownerRaw && 'pluginId' in ownerRaw && ownerRaw.pluginId ? String(ownerRaw.pluginId) : null
      const version =
        ownerRaw && 'targetVersion' in ownerRaw && ownerRaw.targetVersion
          ? `@${String(ownerRaw.targetVersion)}`
          : ''
      const aboutSelf = named !== null && named === pluginId
      const reveal = showOthers === true
      const ownerShown = !busy
        ? copyText('panel.queue.state-idle', l)
        : named === null
          ? copyText('panel.queue.other', l)
          : aboutSelf
            ? copyText('panel.queue.self', l)
            : reveal
              ? named
              : copyText('panel.queue.other', l)
      const ownerVer = busy && named !== null && (aboutSelf || reveal) ? version : ''
      const pos = typeof queue.position === 'number' ? queue.position : null
      const posText = pos === null ? copyText('panel.queue.pos-absent', l) : copyText('panel.queue.pos-n', l, { n: pos })
      const posNote = pos === null ? '' : pos === 1 ? copyText('panel.queue.pos-next', l) : copyText('panel.queue.pos-ahead', l, { n: pos - 1 })
      const rows = [
        '<div class="dsh-upd-qrow">' +
          `<span class="dsh-upd-qdot" data-tone="${busy ? 'busy' : 'idle'}"></span>` +
          `<span class="dsh-upd-qk">${escapeHtml(copyText('panel.queue.row-installing', l))}</span>` +
          `<span class="dsh-upd-qv">${escapeHtml(ownerShown + ownerVer)}</span>` +
          `<span class="dsh-upd-qn">${escapeHtml(busy ? copyText('panel.queue.row-installing-note', l) : copyText('panel.queue.row-idle-note', l))}</span></div>`,
        '<div class="dsh-upd-qrow">' +
          '<span class="dsh-upd-qdot" data-tone="you"></span>' +
          `<span class="dsh-upd-qk">${escapeHtml(copyText('panel.queue.row-position', l))}</span>` +
          `<span class="dsh-upd-qv">${escapeHtml(posText)}</span>` +
          `<span class="dsh-upd-qn">${escapeHtml(posNote)}</span></div>`,
      ]
      // 开关打开要有东西可看：给一条排队顺序（否则「显示其他插件」点了跟没点一样）。
      if (reveal && queue.waiting.length > 0) {
        const seq = queue.waiting
          .map((e) => `${e.pluginId}${e.targetVersion ? `@${e.targetVersion}` : ''}`)
          .join(' → ')
        rows.push(
          '<div class="dsh-upd-qrow"><span class="dsh-upd-qdot"></span>' +
            `<span class="dsh-upd-qk">${escapeHtml(copyText('panel.queue.row-order', l))}</span>` +
            `<span class="dsh-upd-qseq">${escapeHtml(seq)}</span></div>`,
        )
      }
      // 队列开关也是动作面：只读渲染（actions:'none'）下同样不画——
      // 否则「内核不画按钮」这条缝会漏掉 03 章这一颗（现场实测：忙队列时它照样渲染，成了新的死按钮）。
      // 只读渲染下队列内容照画，看不看他人明细由调用方传的 showOthers 决定。
      const note = showActions
        ? '<span class="dsh-upd-chap-note"><button type="button" data-action="toggle-queue">' +
          `${escapeHtml(reveal ? copyText('panel.queue.toggle-hide', l) : copyText('panel.queue.toggle-show', l))}</button></span>`
        : ''
      chapters.push(chapterOf(3, `<div class="dsh-upd-queue">${rows.join('')}</div>`, note, l))
    } else {
      chapters.push(
        chapterOf(
          3,
          `<div class="dsh-upd-queue"><div class="dsh-upd-changelog-neutral">${escapeHtml(
            view.queueNote ?? copyText('panel.queue.empty', l),
          )}</div></div>`,
          '',
          l,
        ),
      )
    }
  }
  // —— 04 错误信息（原型 :237-240）：平时是路牌，失败时是带冻结证据与现成查询的卷宗 ——
  {
    const errLines: string[] = []
    const failedNow = b.kind === 'failed' || b.kind === 'blocked'
    const failRef = (input as { failure?: unknown }).failure as PanelFailureRef | null | undefined
    if (failedNow) {
      const shownCode =
        b.kind === 'blocked'
          ? (snapshot?.blockedReason ?? b.kind)
          : typeof (input as { lastError?: unknown }).lastError === 'string' && ((input as { lastError: string }).lastError).trim()
            ? (input as { lastError: string }).lastError
            : 'install-failed'
      errLines.push(
        `<div class="dsh-upd-err">${escapeHtml(copyText('panel.error.code-label', l))} <code>${escapeHtml(String(shownCode))}</code>${l === 'en' ? ':' : '：'}${escapeHtml(copyText('panel.error.code-note', l))}</div>`,
      )
      if (b.kind === 'failed' && failRef) {
        const keys: string[] = []
        if (typeof failRef.requestId === 'string' && failRef.requestId) keys.push(`${escapeHtml(copyText('panel.error.query-request', l))} <code>${escapeHtml(failRef.requestId)}</code>`)
        if (typeof failRef.checkId === 'string' && failRef.checkId) keys.push(`${escapeHtml(copyText('panel.error.query-check', l))} <code>${escapeHtml(failRef.checkId)}</code>`)
        const at = formatLatchTime(failRef.atMs, ((input as { lang?: unknown }).lang as AppLang | string | null) ?? l)
        if (at) keys.push(`${escapeHtml(copyText('panel.error.failed-at', l, { time: at }))}`)
        if (keys.length > 0) {
          errLines.push(`<div class="dsh-upd-err">${copyText('panel.error.query-keys', l, { keys: keys.join(' · ') })}</div>`)
        }
        if (typeof failRef.targetVersion === 'string' && failRef.targetVersion.trim()) {
          errLines.push(`<div class="dsh-upd-err">${escapeHtml(copyText('panel.error.target-version', l, { version: failRef.targetVersion.trim() }))}</div>`)
        }
        if (!failRef.volatile) {
          errLines.push(
            `<div class="dsh-upd-err">${escapeHtml(copyText('panel.error.evidence-frozen', l))}</div>`,
          )
        } else {
          errLines.push(
            `<div class="dsh-upd-err">${escapeHtml(copyText('panel.error.evidence-transient', l))}</div>`,
          )
        }
      }
    } else {
      errLines.push(`<div class="dsh-upd-changelog-neutral">${escapeHtml(copyText('panel.error.no-failure', l))}</div>`)
    }
    if ((input as { showLogHint?: unknown }).showLogHint !== false) {
      errLines.push(
        `<div class="dsh-upd-log">${copyText('panel.error.log-hint', l, {
          pluginId: `<code>${escapeHtml(pluginId)}</code>`,
          e1: `<code>${LOG_EVENT_CALL}</code>`,
          e2: `<code>${LOG_EVENT_CALL_FAIL}</code>`,
          e3: `<code>${LOG_EVENT_INSTALL_EXEC}</code>`,
        })}</div>`,
      )
      if (b.kind === 'failed' && failRef && (failRef.requestId || failRef.checkId)) {
        errLines.push(
          `<div class="dsh-upd-log">${copyText('panel.error.log-follow', l, {
            eFail: `<code>${LOG_EVENT_CALL_FAIL}</code>`,
            eCall: `<code>${LOG_EVENT_CALL}</code>`,
            eExec: `<code>${LOG_EVENT_INSTALL_EXEC}</code>`,
          })}</div>`,
        )
      }
    }
    if (copyNotice) errLines.push(`<div class="dsh-upd-copy" role="status">${escapeHtml(copyNotice)}</div>`)
    else errLines.push('<div class="dsh-upd-copy dsh-upd-copy--empty" aria-hidden="true"></div>')
    chapters.push(chapterOf(4, errLines.join(''), '', l))
  }
  // —— 05 手工命令（原型 :242-245）：章节恒在；没有可给的手工命令就说清为什么 ——
  chapters.push(
    chapterOf(
      5,
      view.showManual && manual
        ? `<div class="dsh-upd-manual"><div>${escapeHtml(copyText('panel.manual.heading', l))}</div><code>${escapeHtml(manual)}</code></div>`
        : `<div class="dsh-upd-manual"><div class="dsh-upd-changelog-neutral">${escapeHtml(copyText('panel.manual.absent', l))}</div></div>`,
      '',
      l,
    ),
  )
  parts.push('<div class="dsh-upd-body">' + chapters.join('\n') + '</div>')
  // —— 右下角独立 footer 区（#47 定案 A：一次找到，脱离第一章 actions）——
  // dialog 才有，永远在 05 章之后；embedded 无（宿主框架自带关）；
  // 只读渲染（actions:'none'）下不画（动作面归调用方，免得出现可点却没人接的死按钮）。
  if (showActions && mode === 'dialog') {
    parts.push(
      '<div class="dsh-upd-footer"><span class="dsh-upd-foot-note">' + escapeHtml(copyText('panel.footer.note', l)) + '</span>' +
        `<button type="button" data-action="close-view" title="${escapeHtml(copyText('panel.footer.close-title', l))}">${escapeHtml(copyText('panel.footer.close', l))}</button></div>`,
    )
  }
  return parts.join('\n')
}

/** 整面板 HTML（含样式；重绘即整体替换 innerHTML，故每次都带 style 也只留一份）。 */
export function renderUpdatePanelHTML(input: PanelRenderInput, lang?: AppLang | string | null): string {
  const l = normalizeLangTag(lang ?? (input as { lang?: unknown }).lang ?? 'zh')
  const view = panelViewModel(input, l)
  const kernel = renderUpdatePanelKernel(input, view, l)
  // 主题只换肤：默认主题输出与旧版一字不差（无 data-theme、不带 Archive 串）；
  // 档案卷才在根上挂 data-theme 并追加 Archive 串；内核 HTML 两边同一份。
  const archive = normalizePanelTheme(input.theme) === 'archive'
  const attr = archive ? ' data-theme="archive"' : ''
  const tokensStyle = themeTokensStyleFor((input as { themeTokens?: UpdateThemeTokens }).themeTokens ?? undefined)
  const tokensAttr = tokensStyle ? ` style="${tokensStyle}"` : ''
  // 印章走属性带到根上：Archive 用 CSS `content:attr(...)` 画成大印章，默认主题只当属性带着不画，
  // 两个主题的 DOM 仍逐字同一份（主题只换肤这条不变量不破）。
  const sealAttr = ` data-seal="${escapeHtml(view.seal.text)}" data-seal-tone="${view.seal.tone}"`
  const body =
    input.mode === 'dialog'
      ? `<div class="dsh-upd-overlay" data-mode="dialog"><div class="dsh-upd" data-mode="dialog" data-plugin="${escapeHtml(input.pluginId)}"${sealAttr}${attr}${tokensAttr}>\n${kernel}\n</div></div>`
      : `<div class="dsh-upd" data-mode="embedded" data-plugin="${escapeHtml(input.pluginId)}"${sealAttr}${attr}${tokensAttr}>\n${kernel}\n</div>`
  const css = archive ? `${UPDATE_PANEL_CSS}\n${UPDATE_PANEL_ARCHIVE_CSS}` : UPDATE_PANEL_CSS
  return `<style>${css}</style>\n${body}`
}

// ---------- 失败锁存（#58：安装/查失败常驻，复制诊断锁定致命回包） ----------
//
// 只读轮询（updateStatus）与用户主动动作（查/装）在失败证据上分权：
// - 用户动作的失败回包冻结成锁存；成功的状态轮询永不清除非瞬态锁存。
// - 瞬态（传输抛错）锁存记 volatile，下一次成功读数即清，不留死结。
// - update-busy 永不进锁存（排队态走队列视图实时渲染）。
// - 跨重挂按“插件 + 使用范围”在模块级存活（宿主进程内），进程重启即忘。
interface FailureLatch {
  code: string
  kind: string | null
  detail: string | null
  diag: unknown
  requestId: string | null
  checkId: string | null
  runningVersion: string | null
  installedVersion: string | null
  latestVersion: string | null
  /** 失败那次安装的目标版本（任务自带；查失败与抛错无此上下文即 null）。 */
  targetVersion: string | null
  hostKind: string | null
  profileName: string | null
  source: 'check' | 'install'
  volatile: boolean
  jobId: string | null
  atMs: number | null
}

const PANEL_FAILURE_LATCHES = new Map<string, FailureLatch>()

// ---------- 挂载（单组件入口：调用者只传标识与摆放参数） ----------

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function asSnapshot(value: unknown): UpdateSnapshot | null {
  if (!isObject(value)) return null
  const s = value as Partial<Record<keyof UpdateSnapshot, unknown>>
  if (typeof s['runningVersion'] !== 'string') return null
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
  busyAct: 'check' | 'install' | null,
): boolean {
  if (busyAct === 'check' || busyAct === 'install') return false
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
  if (!container || typeof container.innerHTML !== 'string') {
    throw new Error('[dsh-plugin-update] 挂载面板需要一个有 innerHTML 的容器')
  }
  if (!options || typeof options !== 'object') {
    throw new Error('[dsh-plugin-update] 挂载面板缺少配置：插件标识 pluginId 必填')
  }
  const pluginId = options.pluginId
  if (typeof pluginId !== 'string' || !pluginId) {
    throw new Error(`[dsh-plugin-update] 插件标识 pluginId 必填：须为非空字符串（收到 ${JSON.stringify(pluginId)}）`)
  }
  if (typeof options.call !== 'function') {
    throw new Error('[dsh-plugin-update] 挂载面板需要传输函数 call（面板调宿主电话的唯一接触面）')
  }
  const prefix = options.prefix === undefined ? 'wf' : options.prefix
  const phoneNames = buildPhoneNames(prefix)
  const changelogPhone = buildChangelogPhoneName(prefix)
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
    throw new Error(`[dsh-plugin-update] 面板轮询间隔非法：不得小于 250 毫秒（收到 ${JSON.stringify(options.pollMs)}）`)
  }
  let mode: UpdatePanelMode = options.mode ?? 'embedded'
  if (mode !== 'embedded' && mode !== 'dialog') {
    throw new Error(`[dsh-plugin-update] 摆放形态非法：只收 embedded 或 dialog（收到 ${JSON.stringify(options.mode)}）`)
  }
  if (options.theme !== undefined && options.theme !== 'default' && options.theme !== 'archive') {
    throw new Error(`[dsh-plugin-update] 主题非法：只收 default 或 archive（收到 ${JSON.stringify(options.theme)}）`)
  }
  let theme: UpdatePanelTheme = normalizePanelTheme(options.theme ?? 'default')
  // 主题变量覆盖：挂载时校验（非法即抛，与 theme 同口径）；合法存下，每次 render 拼到根上。
  themeTokensStyleFor(options.themeTokens ?? undefined)
  let themeTokens: UpdateThemeTokens | undefined = options.themeTokens
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
  let showOthers = options.showOthers === true
  // 更新日志折叠（视图态：只影响 02 章展示，不调电话；换肤/轮询不丢）。
  let changelogCollapsed = false
  const call = options.call
  const onRestartRequested = options.onRestartRequested
  const onCloseRequested = typeof options.onCloseRequested === 'function' ? options.onCloseRequested : null
  // 上次落盘的 HTML：逐字相同即跳过赋值（闪烁根治的比较基线）。
  let lastHTML = ''
  const copyTextOut = options.copyText ?? defaultCopyText
  const skipStore = options.skipStore ?? createBrowserSkipStore(pluginId)
  const hostKind = typeof options.hostKind === 'string' && options.hostKind ? options.hostKind : null
  // 使用范围（profile）：宿主经 includeEnv 回真值，调用方也能显式覆盖。
  // 这一栏是「更新装到哪个范围」的唯一展示面——web / desktop 各装一份，必须让人看见自己点的是哪个。
  const profileNameOption = typeof options.profileName === 'string' && options.profileName ? options.profileName : null
  const showLogHintOption = options.showLogHint !== false
  const diagCopyFormat: DiagCopyFormat = options.diagCopyFormat === 'line' ? 'line' : 'block'
  let changelogMarkdown: string | null =
    typeof options.changelogMarkdown === 'string' ? options.changelogMarkdown : null

  let snapshot: UpdateSnapshot | null = null
  let manual: string | null = null
  let queue: VisibleQueue | null = null
  let receipt: { checkId: string } | null = null
  let requestId: string | null = null
  // 失败锁存（#58）：用户主动动作的失败证据在此冻结；只读轮询无权清除非瞬态锁存。
  const latchKey = `${pluginId}${profileNameOption ?? ''}`
  let latch: FailureLatch | null = null
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
    saveLatch()
  }
  function clearLatch(): void {
    if (!latch) return
    latch = null
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
  function latchFromJob(job: NonNullable<UpdateSnapshot['job']>, snap: UpdateSnapshot | null): FailureLatch {
    const env = currentEnvPair()
    const message = typeof job.message === 'string' ? job.message : null
    const detail = message && message.includes(':') ? message.slice(message.indexOf(':') + 1).trim() || null : message
    return {
      code: messageCodeOf(message) || 'install-failed',
      kind: null,
      detail,
      // 快照里没有 diag：保留锁存里既有的（多半是致命安装回包自带的），没有即缺省说人话
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
  let copyNotice: string | null = null
  let noticeExpiresAt = 0
  // 在途动作（#36）：点下查新版/安装到回包前的那一帧，按钮置忙 + 并发连点只认第一次。
  let busyAct: 'check' | 'install' | null = null
  let mounted = true
  // 宿主 includeEnv 回的使用范围与宿主种类（调用方显式传的优先，见 render）。
  let envProfileName: string | null = null
  let envHostKind: string | null = null

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
      try {
        const nodes = el.querySelectorAll('.dsh-upd-body')
        if (nodes) {
          for (let i = 0; i < nodes.length; i++) {
            const n = nodes[i] as unknown as { scrollTop?: unknown }
            scrolls.push(typeof n.scrollTop === 'number' ? (n.scrollTop as number) : 0)
          }
        }
      } catch { scrolls = [] }
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
    // Toast 过期（#37）：transient 提示只活 5 秒；戳在赋值点打（sayCopy），轮询重绘不续命。
    // busy 在途提示由 finally 清，这里只管过期。
    if (!copyNotice) noticeExpiresAt = 0
    else if (noticeExpiresAt && Date.now() > noticeExpiresAt) {
      copyNotice = null
      noticeExpiresAt = 0
    }
    const latest = snapshot?.latestVersion ?? null
    const skippedLatest = !!latest && validReleaseVersion(latest) && skipStore.has(latest)
    // 渲染只在变化时落盘（闪烁根治）：轮询每秒重算，但输出逐字相同时不碰 DOM，
    // 悬停/focus 状态不再被整树替换打断；状态变化仍即时重绘。
    const langNow = currentLang()
    const nextHTML = renderUpdatePanelHTML({
      snapshot,
      manual,
      queue,
      busyAct,
      lang: langNow,
      skippedLatest,
      lastError: latch?.code ?? null,
      errorKind: latch?.kind ?? null,
      failure: latch
        ? { requestId: latch.requestId, checkId: latch.checkId, atMs: latch.atMs, source: latch.source, volatile: latch.volatile, targetVersion: latch.targetVersion }
        : null,
      showLogHint: showLogHintOption,
      changelogMarkdown,
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
    })
    if (nextHTML !== lastHTML) {
      lastHTML = nextHTML
      setStableHTML(container, nextHTML)
    }
  }

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
      // 成功回包的锁存规则（#58）：只读轮询永不清除非瞬态锁存；diag 不覆写既有证据。
      const jobState = snapshot?.job?.state ?? null
      if (jobState === 'installing' || jobState === 'verifying') {
        // 新一轮在途：旧失败让位
        clearLatch()
      } else if (jobState === 'completed' || jobState === 'restart-required') {
        // 成功终态：旧失败已无意义
        clearLatch()
      } else if ((jobState === 'failed' || jobState === 'interrupted') && snapshot?.job) {
        // 后台结局到达：单调置入（只允许从无到有或同源更新，永不由轮询清除）
        // #100：三元组已变（比如远端出了新版）→ 旧失败的上下文被新信息替代，不再复活；
        // 同上下文才常驻（#58）。
        if (snapshot && tripleChanged(snapshot)) clearLatch()
        else setLatch(latchFromJob(snapshot.job, snapshot))
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
      }
      // #45：失败也收使用范围与队列（快照/凭证不动；best-effort，形状不对即忽略）。
      try {
        const env = (reply as Record<string, unknown>)['env']
        if (isObject(env)) {
          const pn = env['profileName']
          const hk = env['environmentKind']
          if (typeof pn === 'string' && pn.trim()) envProfileName = pn.trim()
          if (typeof hk === 'string' && hk.trim()) envHostKind = hk.trim()
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
          if (!reply || typeof reply !== 'object' || (reply as Record<string, unknown>)['ok'] !== true) {
            try { changelogFailedAt.set(v, Date.now()); } catch { try { changelogFailedAt.set(v, 0); } catch {} }
            return
          }
          const md = (reply as Record<string, unknown>)['markdown']
          changelogCache.set(v, typeof md === 'string' ? md : null)
          if (typeof md === 'string') {
            changelogMarkdown = md
            render()
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
      applyStatusReply(reply, 'refresh')
    } catch {
      if (!mounted) return
      // 读数传输失败是瞬态：记 volatile 锁存，下一次成功读数即清，不留死结
      setLatch(volatileLatch('check'))
    }
    render()
    maybeAutoChangelog()
  }

  async function act(kind: UpdatePanelActionKind, arg?: string): Promise<void> {
    if (!mounted) return
    copyNotice = null
    switch (kind) {
      case 'check': {
        if (busyAct) return
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
        if (busyAct) return
        busyAct = 'install'
        copyNotice = copyText('panel.toast.installing', currentLang())
        render()
        try {
          if (!receipt) {
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
          }
          if (!mounted) return
          if (!receipt) {
            const expiredEnv = currentEnvPair()
            setLatch({
              code: 'check-expired',
              kind: 'check-expired',
              detail: null,
              diag: null,
              requestId,
              checkId: null,
              runningVersion: snapshot?.runningVersion ?? null,
              installedVersion: snapshot?.installedVersion ?? null,
              latestVersion: snapshot?.latestVersion ?? null,
              targetVersion: null,
              hostKind: expiredEnv.hostKind,
              profileName: expiredEnv.profileName,
              source: 'install',
              volatile: false,
              jobId: null,
              atMs: latchNow(),
            })
            render()
            return
          }
          requestId = randomRequestId()
          const reply = await call(phoneNames.updateInstall, {
            checkId: receipt.checkId,
            requestId,
            ...queueArgs(),
          })
          if (!mounted) return
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
        if (manual) {
          try {
            await copyTextOut(manual)
            sayCopyKey('panel.toast.copy-manual-ok')
          } catch {
            sayCopyKey('panel.toast.copy-manual-fail')
          }
        }
        render()
        return
      }
      case 'copy-diag': {
        const jobCode = snapshot?.job?.state === 'failed' ? messageCodeOf(snapshot.job.message) || 'install-failed' : ''
        // 健康态诚实复制（#58）：没有失败就不伪造失败码，只给当前状态快照。
        if (!latch && !jobCode && !snapshot?.blockedReason && snapshot) {
          const stateLine =
            snapshot.canInstall && snapshot.latestVersion
              ? `有新版 ${snapshot.latestVersion} 可装（当前 ${snapshot.runningVersion}）`
              : '已是最新，无需更新。'
          const queueName = queueTextOf(queue?.position ?? null)
          const envBits = [
            `插件=${pluginId}`,
            `宿主=${hostKind ?? envHostKind ?? '未知'}`,
            `使用范围=${profileNameOption ?? envProfileName ?? '未知'}`,
            `队列=${queueName}`,
          ]
          if (requestId) envBits.push(`请求=${requestId}`)
          if (receipt?.checkId) envBits.push(`检查=${receipt.checkId}`)
          const segs = [
            `[update-diag] 当前无失败：${stateLine}`,
            `版本：运行 ${snapshot.runningVersion}／磁盘 ${snapshot.installedVersion ?? '未知'}／远端 ${snapshot.latestVersion ?? '未查过'}`,
            `来源：${envBits.join(' · ')}`,
          ].map((s) => redactForCopy(s))
          const text = diagCopyFormat === 'line' ? segs.join(' · ') : segs.join('\n')
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
          format: diagCopyFormat,
          lang: currentLang(),
        })
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
      }
      const btn = t?.target && typeof t.target.closest === 'function' ? t.target.closest('[data-action]') : null
      const kind = btn?.getAttribute ? btn.getAttribute('data-action') : null
      if (!kind) return
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
    // 显式 wins（#38）：手动给过文本后自动链路不再覆盖（同版本只问一次，本来也不会再问）。
    if (typeof markdown === 'string') manualChangelogOverride = true
    render()
  }

  function unmount(): void {
    if (!mounted) return
    mounted = false
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
    // 卸载只停轮询：绝不调安装/取消电话，安装在宿主进程内继续跑。
  }

  // #61 v2 语言跟随：已挂载控件即时重绘，unmount 后停订（单例观察者，显式 locale 对象亦经同一出口）。
  const unsubLang = subscribeLang(() => {
    render()
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
  // mount 串行：首绘 loading → await refresh（只读本地）→ 条件自动查一次；轮询永不查新版。
  void (async () => {
    await refresh()
    try {
      if (pendingAutoCheck(snapshot, busyAct)) void act('check')
    } catch {
      // 自动查失败已在 act 内渲染为既有失败文案，这里不另行处理。
    }
  })()

  return { refresh, act, setMode, setTheme, setThemeTokens, setShowOthers, setChangelogCollapsed, setChangelogMarkdown, unmount }
}

// ---------- 面板侧电话名与轮询口径（与派生工具同一源，不写字面量） ----------

export { buildPhoneNames as buildPanelPhoneNames } from './config.js'
export type { PhoneAction as PanelPhoneAction } from './config.js'
export { buildChangelogPhoneName as buildPanelChangelogPhoneName } from './config.js'
export type { ChangelogPhoneAction as PanelChangelogPhoneAction } from './config.js'

/** 面板轮询口径（默认 1 秒、下限 250 毫秒，与宿主侧同一套）。 */
export const PANEL_POLL = {
  defaultMs: DEFAULT_PANEL_POLL_MS,
  minMs: MIN_PANEL_POLL_MS,
} as const

// 队列可见性开关的面板侧形状（转出口：面板凭电话可选参数拿视图，用这里再裁剪）。
export {
  QUEUE_INTENT_TTL_MS,
  emptyQueueState,
  normalizeQueueState,
  queuePositionOf,
  isHeadOfQueue,
  isQueueBusy,
  visibleQueueFor,
} from './queue.js'
export type { QueuedEntry, QueueOwner, UpdateQueueState, VisibleQueue as PanelVisibleQueue, VisibleQueueOwner } from './queue.js'

// 宿主种类（诊断文本用；取值可增，不认就当普通宿主展示）。
export type { EnvironmentKind as PanelEnvironmentKind } from './ports.js'
export type { UpdateSnapshot as PanelSnapshot } from './ports.js'
export type { BlockedReason as PanelBlockedReason } from './ports.js'

// 更新日志纯函数（#23：面板与浏览器闭包同缝，零依赖；I/O 在 changelog-io Node 侧）。
export {
  CHANGELOG_ALL_CATEGORIES,
  CHANGELOG_FILENAME,
  CHANGELOG_FOLDED,
  CHANGELOG_MAX_BULLETS_PER_SECTION,
  CHANGELOG_MAX_BULLET_CHARS,
  CHANGELOG_MAX_CHARS,
  CHANGELOG_MAX_ENTRIES,
  CHANGELOG_MUST_SHOW,
  CHANGELOG_NEUTRAL_HINT,
  CHANGELOG_NEUTRAL_LINE,
  changelogForUpdate,
  hasVisibleSections,
  isUnreleasedVersion,
  parseChangelog,
  renderChangelogHTML,
  renderChangelogNeutral,
  renderChangelogSection,
  selectChangelogEntries,
} from './changelog.js'
export type { ChangelogCategory, ChangelogEntry } from './changelog.js'
