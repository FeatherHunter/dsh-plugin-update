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

import { buildChangelogPhoneName, buildLogAppendPhoneName, buildPhoneNames, DEFAULT_PANEL_POLL_MS, DEFAULT_PREFIX, MIN_PANEL_POLL_MS } from './config.js'
import { hash8 } from './hash.js'
import { COPY_BUDGET_CHARS, sanitizeForCopy } from './redaction.js'
import { compareReleaseVersions, validReleaseVersion } from './service.js'
import {
  changelogForUpdate,
  isChangelogStatus,
  parseChangelogReport,
  renderChangelogHTML,
  shouldFetchChangelog,
  truncationNoteHTML,
  yankedBannerHTML,
  type ChangelogStatus,
} from './changelog.js'
import { visibleQueueFor, type UpdateQueueState, type VisibleQueue } from './queue.js'
import { LOG_EVENT_CALL, LOG_EVENT_CALL_FAIL, LOG_EVENT_INSTALL_EXEC } from './log-events.js'
import { createClientLogChannel, type ClientLogChannel, type ClientLogEvent } from './log/client-queue.js'
// #212：只要类型（import type 在编译期擦除，浏览器闭包里不会多出 log/ 内部模块的运行时依赖）。
import type { UpdateLogHealth } from './log/health.js'
import type { BlockedReason, UpdateSnapshot } from './ports.js'
import { INTERNAL_CODE, isCheckSideFailureCode, type PhoneFailureCode } from './codes.js'
export { isCheckSideFailureCode } // 查侧判定从单点真源派生（#134/US15；#141 铁律：本文件不另建第二张表）
import { copyText, type BilingualKey } from './bilingual.js'
import { manualAbsentReasonOf, manualAbsentTextOf, manualAppliesToBanner } from './manual-absent.js'
import { lastResortVerdictOf, type LastResortVerdict, type ManualSource } from './last-resort.js'
// #174：last-resort 的类型经既有子路径转出，消费者无需新子路径即可命名（`ManualSource` 已出现在本模块导出签名里）。
export type { LastResortKind, RescueRouteKey, ManualSource, LastResortSubject, LastResortInput, LastResortVerdict } from './last-resort.js'
import { blameCausePackage, CAUSE_KINDS, formatUnlockAt, interpretInstallCause } from './install-cause.js'
import { langSignalSource, normalizeLangTag, resolveLang, subscribeLang, type AppLang, type LocaleOption } from './lang.js'

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
  /** 面板正文字号基准（默认 `14px`；传了只改变量值，不改结构）。 */
  panelFontSize?: string;
  /** 面板章节标题字号（默认主题 `14px` / 档案卷 `17px`；批量标题 `15px` / 档案卷 `21px` 同走此键，各自回退不同）。 */
  panelChapterFontSize?: string;
  /** 面板横幅标题字号（默认跟随正文继承 / 档案卷 `27px`、已最新 `24px`；传了即固定值）。 */
  panelBannerTitleFontSize?: string;
  /** 面板日志字号（默认 `13px` 系：手册/队列/日志/更新日志体；档案卷日志体 `13.5px`、命令块 `12.5px` 各自回退不同）。 */
  panelLogFontSize?: string;
  /** 面板小字字号（副行/注脚系：默认 `11px`–`12.5px` 按规则回退不同，传了即统一固定值）。 */
  panelSmallFontSize?: string;
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
  panelFontSize: '--dsh-update-panel-font-size',
  panelChapterFontSize: '--dsh-update-panel-chapter-font-size',
  panelBannerTitleFontSize: '--dsh-update-panel-banner-title-font-size',
  panelLogFontSize: '--dsh-update-panel-log-font-size',
  panelSmallFontSize: '--dsh-update-panel-small-font-size',
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

/**
 * 更新日志里链接（`[文本](https://…)`／裸 URL）的落地（#111 定稿）：
 * 不传即 `window.open(url, "_blank", "noopener,noreferrer")`——桌面宿主把新窗口交给系统浏览器，
 * web 宿主开新标签页；面板正文**永不被导航走**（渲染的锚恒带 `target="_blank"`）。
 * 传了就交给调用方（想走自己的外链/内嵌浏览器都行）；抛错只吞，不挡更新。
 */
export type UpdatePanelOpenLink = (url: string) => void | Promise<void>

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
  | 'install-fallback'
  | 'install-fallback-confirm'
  | 'wait-latest'

/**
 * 客户端日志选项（#122）：
 * - 不传：面板按 `pluginId` / `prefix` / `call` 自建一条通道（宿主有 `<prefix>.logAppend` 电话就落盘；
 *   老宿主或 HTTP 网关没这条路由时静默降级，只记账不外抛）。
 * - 传 `{ channel }`：用调用方的通道（面板不碰它的生命周期，调用方自己 dispose）；
 *   `{ channel: null }` 即彻底关掉客户端日志（一行都不发）。
 * - `mount`：挂载点名字，写进 `update.panel.mount` 的 `mode` 字段（入口件 / HTTP 直挂 / 批量面板各报各的）。
 */
export interface UpdatePanelClientLogOptions {
  channel?: ClientLogChannel | null
  mount?: string
}

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
  /**
   * 客户端日志（#122）：不传即自建（宿主有 `<prefix>.logAppend` 就落盘）；`{ channel: null }` 即关掉。
   * 客户端事件只有五个：mount / action / render.fail（常驻）与 state / lang.applied（按需）。
   */
  clientLog?: UpdatePanelClientLogOptions | null
  /** 日志链接的落地（可选）：不传即开新窗口（桌面宿主交系统浏览器）；见 UpdatePanelOpenLink。 */
  openLink?: UpdatePanelOpenLink
  skipStore?: PanelSkipStore
  /** 宿主种类（调用方知道就传进诊断文本；不传就用宿主 includeEnv 回的宿主种类，再没有显示“未知”）。 */
  hostKind?: string | null
  /**
   * 使用范围名（profile）：**装到哪个范围**的展示面。不传就用宿主 includeEnv 回的真值；
   * 两者都没有时显示“未知”，绝不猜（猜错会让人以为更新装到了别的范围）。
   */
  profileName?: string | null
  /**
   * 本插件日志目录（#123）：给错误章路牌用，只在传了的时候写实路径 + 现成的 `npx dsh-log <dir>`。
   * 不传（或空串）即退回目录算式 `<DSH_HOME>/logs/<派生命名空间>` 与命令模板——路牌不指不存在的值。
   * 目录由宿主侧算：`updateLogDirFor(pluginId, homeDir)`（与落盘同一算式、同一派生规则）。
   * 电话回包一个字不改：使用范围那栏仍然只回范围名与宿主种类，绝不回目录路径。
   */
  logDir?: string | null
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

// ---------- 文案垫片（#166：实现搬 panel-copy，老位置 re-export，行为零变化） ----------
import {
  PANEL_DIAG_MAX_CHARS,
  blockedCopy,
  buildHealthyDiagCopy,
  buildUpdateDiagCopy,
  failureCodeOf,
  failureCopy,
  logHealthText,
  readDiagTolerant,
  redactForCopy,
  replyIsCheckExpired,
  thrownIsCheckExpired,
} from './panel-copy.js'
import type { DiagCopyFormat, UpdaterSelfView } from './panel-copy.js'
import { updaterPartsOf } from './panel-copy.js'
export type { UpdaterSelfView } from './panel-copy.js'
export {
  PANEL_DIAG_MAX_CHARS,
  blockedCopy,
  buildDiagnosticText,
  buildHealthyDiagCopy,
  buildUpdateDiagCopy,
  causeRemedyText,
  failureCodeOf,
  failureCopy,
  isKnownFailureCode,
  logHealthText,
  readDiagTolerant,
  redactForCopy,
  replyIsCheckExpired,
  thrownIsCheckExpired,
} from './panel-copy.js'
export type {
  BlockedCopy,
  DiagCopyFormat,
  FailureCopy,
  HealthyDiagCopyInput,
  PanelDiagnosticInput,
  TolerantDiag,
  UpdateDiagCopyInput,
} from './panel-copy.js'

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

export function messageCodeOf(message: unknown): string {
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
   * 检查页预判（#156 场景二）：内核记住的窗口（目标版 + 解封时刻 + 渲染时刻）。
   * 缺省即无预判（输出与旧版一字不差）；只在"已确认、无新鲜失败"时改变失败横幅与
   * 可装横幅的去向——锁存还在（有新鲜失败）时失败页优先，本输入不生效。
   */
  checkPrejudge?: CheckPrejudge | null
  /**
   * 更新日志 Markdown（#23）：只影响日志节的渲染，不参与安装门控。
   * 缺省/空串即中性提示；快照字段与 blockedReason 一字不动。
   */
  changelogMarkdown?: string | null
  /**
   * 更新日志分档（#213）：宿主判定的「为什么没有说明」（empty/missing/fetch-failed/parse-degraded）。
   * 只在日志节画不出内容时决定那句中性话术；有内容一律照旧（分档永不覆盖内容）。
   * 缺省/null/认不出的值/`ok`/`cache-hit` 即旧文案一字不差。
   */
  changelogStatus?: ChangelogStatus | null
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
  // #156 场景二：已确认（errorKind/lastError 为空即锁存已清：用户点了等新版/已知晓）
  // + 记住的窗口正对当前新版 + 还没放行 → 失败横幅让位给检查页预判，不再拿旧失败挡路。
  // 记住的窗口仍是事实（这版现在装还是会被拦），且只在"无新鲜失败"时让位——
  // 锁存还在（errorKind/lastError 有值）时失败页优先，本门直接 null。
  const noFreshFailure = !(typeof errorKind === 'string' && errorKind.trim()) && !lastError
  const gated = noFreshFailure ? checkPrejudgeOfView(input.checkPrejudge, snapshot) : null
  if (!staleFailure && !gated && (failedCode || jobState === 'failed' || jobState === 'interrupted')) {
    const code = failedCode || 'install-failed'
    const copy = failureCopy(code, l)
    // 未装 + 查侧失败（#134/US15）：未装状态词打头 + 查侧文案，不说安装失败。
    const checkDetail = copy?.zh ?? code
    const detail =
      snapshot?.installed === false && isCheckSideFailureCode(code)
        ? copyText('panel.banner.not-installed', l) + '：' + checkDetail
        : checkDetail
    return {
      banner: {
        kind: 'failed',
        title: copyText('panel.banner.error.title', l, { code, detail }),
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
    // #190：在册事实为 false 时「重启宿主后生效」是假话——重启也不会加载。改说未登记 + 下一步。
    const unregistered = snapshot.registered === false
    return {
      banner: {
        kind: 'restart',
        // 文案照原型（archive.html:329）：不带 emoji——警示由横幅左侧的手绘 SVG 标承担，
        // 印章在状态一侧，两者各司其职，不再三重标记。
        title: unregistered
          ? copyText('panel.banner.restart-unregistered-title', l, { latest })
          : copyText('panel.banner.restart-title', l, { latest }),
        action: unregistered
          ? copyText('panel.banner.restart-unregistered-action', l)
          : blockedCopy('pending-restart', l)?.action ?? '',
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
  // #182：磁盘在场但运行版本未知——不知道在跑哪版，既不宣称有新版、也不谎称已是最新。
  if (snapshot.installed !== false && snapshot.runningVersion === null) {
    return {
      banner: {
        kind: 'blocked',
        title: copyText('panel.banner.unknown-running-title', l),
        action: copyText('panel.banner.unknown-running-action', l),
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
    // #197：首次安装（磁盘没有 + 清单未登记的新增依赖）与换版是两种身份，给两张脸。
    // 判不出身份（identity 为 null）时退回旧文案，绝不猜。
    if (snapshot.identity === 'first-install') {
      return {
        banner: {
          kind: 'update',
          title: copyText('panel.banner.first-install-title', l, { latest: snapshot.latestVersion }),
          action: copyText('panel.banner.first-install-action', l),
        },
        installEnabled: true,
        installLabel: copyText('panel.action.first-install-version', l, { latest: snapshot.latestVersion }),
        skippedLatest: false,
        showManual: manual ? true : false,
        showReset: false,
        queueNote,
      }
    }
    // 未装时标题的「当前版本」不许填注入的假版号（#134/US19）：填人话状态词。
    const running =
      snapshot.installed === false
        ? copyText('panel.banner.not-installed', l)
        : snapshot.runningVersion ?? copyText('panel.meta.unknown', l)
    // #156 场景二：记住的窗口正对当前新版——不说"可安装"骗点，主按钮置灰，
    // 横幅说清"哪一版、何时可装、先装合规版"；按钮由内核渲染按同一纯门补［装合规版］。
    if (gated) {
      const unlock = formatUnlockAt(gated.unlockAtMs, l) ?? ''
      return {
        banner: {
          kind: 'update',
          title: copyText('panel.banner.update-gated-title', l, { latest: snapshot.latestVersion, unlock }),
          action: copyText('panel.banner.update-action', l),
        },
        installEnabled: false,
        installLabel: copyText('panel.action.install-version', l, { latest: snapshot.latestVersion }),
        skippedLatest: false,
        showManual: manual ? true : false,
        showReset: false,
        queueNote,
      }
    }
    return {
      banner: {
        kind: 'update',
        title: copyText('panel.banner.update-title', l, { latest: snapshot.latestVersion, running }),
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
  // 未装且没查到（#134/US16）：永不说「已是最新」；未装状态词 + 需先检查，按钮不可点。
  if (snapshot?.installed === false) {
    return {
      banner: {
        kind: 'idle',
        title: copyText('panel.banner.not-installed', l),
        action: copyText('panel.action.check', l),
      },
      installEnabled: false,
      installLabel: copyText('panel.action.install', l),
      skippedLatest: false,
      showManual: false,
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
  '.dsh-upd{font:var(--dsh-update-panel-font-size,14px)/1.75 system-ui,"Microsoft YaHei",sans-serif;color:var(--dsh-update-text,#1f2937);',
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
  // —— 最后手段条（#174 A′ 形态）——
  // 只有判定为 last-resort（无自动救援且命令当帧可信）才画；语义类 `.dsh-upd-lastresort` 也只在那一档出现，
  // 测试靠 data-last-resort 钩子与它区分「有高亮」和「只是样式表里恰好有这个名字」。
  '.dsh-upd-lastresort{display:flex;align-items:flex-start;gap:9px;flex-wrap:wrap;border:1px solid var(--dsh-update-bad-border,#dc2626);border-left:4px solid var(--dsh-update-bad-text,#b91c1c);background:var(--dsh-update-bad-bg,#fef2f2);padding:8px 10px;margin:0 0 8px}',
  '.dsh-upd-lr-ico{flex:none;width:18px;height:18px;color:var(--dsh-update-bad-border,#dc2626);margin-top:2px}',
  '.dsh-upd-lr-main{flex:1 1 220px;min-width:0}',
  '.dsh-upd-lr-line{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
  '.dsh-upd-lr-badge{display:inline-block;font-size:var(--dsh-update-panel-small-font-size,11px);font-weight:700;letter-spacing:.08em;border:1px solid currentColor;color:var(--dsh-update-bad-border,#dc2626);border-radius:3px;padding:0 5px}',
  '.dsh-upd-lr-status{font-weight:700}',
  '.dsh-upd-lr-reason{font-size:var(--dsh-update-panel-log-font-size,13px);opacity:.9;margin-top:2px;overflow-wrap:anywhere}',
  '.dsh-upd-lr-go{margin:0;padding:4px 10px;font-size:var(--dsh-update-panel-small-font-size,12.5px);align-self:center}',
  '.dsh-upd-lr-chap-badge{flex:none;display:inline-block;font-size:var(--dsh-update-panel-small-font-size,11px);font-weight:700;border:1px solid currentColor;color:var(--dsh-update-bad-border,#dc2626);border-radius:3px;padding:0 5px;margin-left:6px;vertical-align:baseline}',
  // 复制成功气泡（#173 v1.3）：fixed 定位，不挤压布局；角色 status 由标记带出，按钮文案/图标不变。
  '.dsh-upd-copy-bubble{position:fixed;z-index:10000;transform:translate(-50%,-100%);background:var(--dsh-update-text,#1f2937);color:var(--dsh-update-bg,#ffffff);border-radius:4px;padding:3px 9px;font-size:var(--dsh-update-panel-small-font-size,12px);line-height:1.5;pointer-events:none;animation:dsh-upd-fadein .12s ease}',
  '.dsh-upd code{font-family:Consolas,Menlo,monospace;font-size:var(--dsh-update-panel-log-font-size,12px);word-break:break-all}',
  '.dsh-upd-manual,.dsh-upd-queue,.dsh-upd-log{margin:4px 0;font-size:var(--dsh-update-panel-log-font-size,13px)}',
  '.dsh-upd-changelog-wrap{margin:4px 0 0;font-size:var(--dsh-update-panel-log-font-size,13px)}',
  '.dsh-upd-changelog-title{font-weight:700;margin:0 0 4px}',
  '.dsh-upd-changelog-version{margin:6px 0}',
  '.dsh-upd-changelog-catname{font-weight:600;margin:6px 0 2px}',
  '.dsh-upd-changelog ul{margin:2px 0 6px 20px;padding:0}',
  '.dsh-upd-changelog li{margin:2px 0}',
  '.dsh-upd-changelog-fold{margin:4px 0}',
  '.dsh-upd-changelog-fold>summary{cursor:pointer}',
  '.dsh-upd-changelog-count{font-size:var(--dsh-update-panel-small-font-size,12px);opacity:.7;margin:2px 0 4px}',
  '.dsh-upd-changelog-yanked{border-left:4px solid var(--dsh-update-warn-border,#d97706);background:var(--dsh-update-warn-bg,#fffbeb);padding:6px 10px;margin:6px 0;font-size:var(--dsh-update-panel-log-font-size,13px)}',
  '.dsh-upd-breaking-badge{display:inline-block;font-size:var(--dsh-update-panel-small-font-size,11px);font-weight:700;border:1px solid currentColor;border-radius:3px;padding:0 5px;margin-right:6px;vertical-align:baseline}',
  '.dsh-upd-changelog-security-more{margin:4px 0 6px}',
  '.dsh-upd-changelog-security-more>summary{cursor:pointer;font-size:var(--dsh-update-panel-small-font-size,12px);opacity:.8}',
  '.dsh-upd-changelog-more-note{font-size:var(--dsh-update-panel-small-font-size,12px);opacity:.7;margin:2px 0 4px}',
  // 文档级截断说明（0.16.0）：切掉多少写在日志块头上，不再静默丢字。
  '.dsh-upd-changelog-truncnote{font-size:var(--dsh-update-panel-small-font-size,12px);opacity:.8;border-left:3px solid var(--dsh-update-border,#d1d5db);padding:2px 0 2px 8px;margin:4px 0 6px}',
  '.dsh-upd-changelog-neutral{color:inherit;opacity:.8}',
  // —— 日志行内 Markdown（#110 取样：行内代码 4914 处/81 份是主力，粗体 4742/26，链接 6286+裸 URL 6671）——
  // 只上最小可用样式：颜色/底色一律走现有 token（第三方 themeTokens 覆盖即生效），不新增配色体系。
  '.dsh-upd-md-code{font-family:var(--dsh-update-font-mono,Consolas,Menlo,monospace);font-size:.92em;background:var(--dsh-update-bg-soft,#f3f4f6);border:1px solid var(--dsh-update-border,#e5e7eb);border-radius:3px;padding:0 3px;word-break:break-word}',
  '.dsh-upd-md-link{color:var(--dsh-update-primary,#2563eb);text-decoration:underline;text-underline-offset:2px;cursor:pointer;word-break:break-all}',
  '.dsh-upd-md-del{opacity:.7}',
  '.dsh-upd-md-img{display:inline-block;max-width:100%;border:1px dashed var(--dsh-update-border,#d1d5db);border-radius:3px;padding:0 4px;font-size:var(--dsh-update-panel-small-font-size,12px);opacity:.85;word-break:break-all}',
  // —— 日志块级 Markdown（嵌套子条目 / 引用块 / 围栏代码块 / 续行段落，见 #116 返工后的解析层）——
  // 面板正文只有 400–460px 宽：代码块横向滚动而不是撑破面板，列表缩进收紧，引用块只留一条左边线。
  '.dsh-upd-md-pre{margin:6px 0;padding:7px 9px;max-width:100%;overflow-x:auto;background:var(--dsh-update-bg-soft,#f3f4f6);border:1px solid var(--dsh-update-border,#e5e7eb);border-radius:4px}',
  '.dsh-upd-md-precode{display:block;font-family:var(--dsh-update-font-mono,Consolas,Menlo,monospace);font-size:.9em;white-space:pre;background:none;border:0;padding:0}',
  '.dsh-upd-md-quote{margin:6px 0;padding:1px 0 1px 9px;border-left:3px solid var(--dsh-update-border,#d1d5db);color:var(--dsh-update-text-muted,#4b5563)}',
  '.dsh-upd-md-list{margin:4px 0;padding-left:18px;list-style:disc}',
  '.dsh-upd-md-list-ol{margin:4px 0;padding-left:20px;list-style:decimal}',
  '.dsh-upd-md-list li,.dsh-upd-md-list-ol li{margin:2px 0}',
  '.dsh-upd-md-para{margin:4px 0}',
  // 分隔线（`---`／`***`）：作者拿它切版本或小节，别让它以字面 `---` 混在正文里（jimp 类日志常见）。
  '.dsh-upd-md-hr{margin:8px 0;border:0;border-top:1px solid var(--dsh-update-border,#e5e7eb)}',
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
  '.dsh-upd-meta{font-size:var(--dsh-update-panel-small-font-size,12.5px);opacity:.75}',
  '.dsh-upd-proftag{font-family:Consolas,Menlo,monospace;font-size:var(--dsh-update-panel-small-font-size,11px);border:1px solid var(--dsh-update-border,#d1d5db);border-radius:3px;padding:0 5px;margin-left:6px;letter-spacing:.06em}',
  '.dsh-upd-strip{display:flex;flex-wrap:wrap;margin:8px 0 0;border:1px solid var(--dsh-update-border,#e5e7eb);border-radius:4px;overflow:hidden;font-size:var(--dsh-update-panel-small-font-size,12.5px)}',
  '.dsh-upd-strip>div{flex:1 1 110px;min-width:0;padding:6px 10px;border-left:1px solid var(--dsh-update-border,#e5e7eb)}',
  '.dsh-upd-strip>div:first-child{border-left:0}',
  '.dsh-upd-strip-k{display:block;font-size:var(--dsh-update-panel-small-font-size,11px);letter-spacing:.14em;opacity:.7}',
  '.dsh-upd-strip-v{font-family:Consolas,Menlo,monospace;font-size:var(--dsh-update-panel-small-font-size,12.5px);word-break:break-all}',
  '.dsh-upd-chapter{margin-top:18px;padding-top:14px;border-top:1px solid var(--dsh-update-border,#e5e7eb)}',
  // 右下角独立 footer 区（#47 定案 A）：与第一章 actions 脱钩，右对齐，一次找到。
  '.dsh-upd-footer{display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-top:14px;padding-top:10px;border-top:1px solid var(--dsh-update-border,#e5e7eb)}',
  '.dsh-upd-foot-note{margin-right:auto;font-size:var(--dsh-update-panel-small-font-size,12px);opacity:.7}',
  // 更新器自检（#196）：页脚里一行机读事实（品牌名 + 版本 + 层级 token），字号更小、等宽、弱化。
  '.dsh-upd-updater-note{font-size:var(--dsh-update-panel-small-font-size,12px);opacity:.55;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap}',
  '.dsh-upd-updater-id{margin-top:8px;font-size:var(--dsh-update-panel-small-font-size,12px);opacity:.55;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.dsh-upd-updater-nested{margin-top:8px;font-size:var(--dsh-update-panel-small-font-size,12px);opacity:.8;line-height:1.5;word-break:break-word}',
  '.dsh-upd-footer button{margin:0}',
  '.dsh-upd-chap-head{display:flex;align-items:baseline;gap:10px;margin-bottom:6px}',
  '.dsh-upd-chap-no{font-size:var(--dsh-update-panel-chapter-font-size,13px);font-style:italic;opacity:.6}',
  '.dsh-upd-chap-title{font-size:var(--dsh-update-panel-chapter-font-size,14px);margin:0}',
  // —— 宿主样式隔离：章节标题是裸 h3，宿主全局 h3 规则（如渐变标题字）会直接命中它，
  // 而继承来的根颜色输给任何直接命中的规则。双 class 显式钉死颜色并洗掉背景裁剪，
  // 深色宿主下即回近白正文，档案卷下跟纸墨变量走（宿主 !important 另议，见测试）。
  '.dsh-upd .dsh-upd-chap-title{color:var(--dsh-update-text,#1f2937);background:none;-webkit-background-clip:border-box;-webkit-text-fill-color:currentColor}',
  '.dsh-upd-chap-rule{flex:1;border-top:1px solid var(--dsh-update-border,#e5e7eb);transform:translateY(-3px)}',
  // 03 章标题行右端的开关（问题 3 定案：按钮形态、挪到标题行）。
  '.dsh-upd-chap-note{flex:none;font-size:var(--dsh-update-panel-small-font-size,12px);opacity:.75}',
  '.dsh-upd-chap-note button{margin:0}',
  // 更新队列两行键值（用户定案的设计）：结构两主题共用，皮肤各自收敛。
  '.dsh-upd-qrow{display:flex;align-items:baseline;flex-wrap:wrap;gap:10px;padding:6px 0;min-width:0}',
  '.dsh-upd-qrow+.dsh-upd-qrow{border-top:1px solid var(--dsh-update-border,#e5e7eb)}',
  '.dsh-upd-qdot{width:8px;height:8px;border-radius:50%;flex:none;align-self:center;background:currentColor;opacity:.5}',
  '.dsh-upd-qdot[data-tone="busy"]{background:var(--dsh-update-warn-border,#d97706);opacity:1}',
  '.dsh-upd-qdot[data-tone="you"]{background:var(--dsh-update-primary,#2563eb);opacity:1}',
  '.dsh-upd-qk{flex:none;width:5.5em;font-size:var(--dsh-update-panel-small-font-size,12px);opacity:.7}',
  '.dsh-upd-qv{font-weight:600}',
  '.dsh-upd-qn{margin-left:auto;font-size:var(--dsh-update-panel-small-font-size,12px);opacity:.7}',
  '.dsh-upd-qseq{font-family:Consolas,Menlo,monospace;font-size:var(--dsh-update-panel-small-font-size,12px);word-break:break-all}',
  '.dsh-upd-prog{height:8px;background:var(--dsh-update-border,#e5e7eb);border-radius:4px;overflow:hidden;margin:10px 0 4px}',
  '.dsh-upd-prog-bar{display:block;height:100%;background:var(--dsh-update-primary,#2563eb);transition:width .3s}',
  '.dsh-upd-progtxt{font-size:var(--dsh-update-panel-small-font-size,12.5px);opacity:.75}',
  '.dsh-upd-skipline{font-size:var(--dsh-update-panel-log-font-size,13px);margin-top:8px}',
  // 骨架微光：只在首帧 loading 出现；reduced-motion 下静止占位，不断语义。
  '.dsh-upd-skv{display:inline-block;min-width:64px;border-radius:3px;color:transparent !important;user-select:none;',
  'background:linear-gradient(90deg,var(--dsh-update-border,#e5e7eb) 25%,var(--dsh-update-bg-soft,#f3f4f6) 50%,var(--dsh-update-border,#e5e7eb) 75%);',
  'background-size:200% 100%;animation:dsh-upd-shimmer 1.2s linear infinite}',
  '@keyframes dsh-upd-shimmer{to{background-position:-200% 0}}',
  '.dsh-upd-tag{display:inline-block;border:1px dashed currentColor;border-radius:3px;padding:1px 8px;margin-right:8px;font-family:Consolas,Menlo,monospace;font-size:var(--dsh-update-panel-small-font-size,12px)}',
  '.dsh-upd-err{font-size:var(--dsh-update-panel-log-font-size,13px);margin:0 0 6px}',
  // —— 04 错误信息长行换行（#199）：日志/错误行补换行契约，与版本号/状态列同风格；纵滚区横向裁断不动 ——
  '.dsh-upd-log,.dsh-upd-err{overflow-wrap:anywhere}',
  // —— 全按钮交互反馈（#36：悬停/按下/过渡/在途忙态；浅深双主题通用写法，不碰上面的既有串）——
  '.dsh-upd button{transition:background-color .15s ease,border-color .15s ease,color .15s ease,transform .06s ease,box-shadow .15s ease}',
  // #173 v1.3：hover 必须有明显边框变化（主色边框 + 外环），不能只靠 brightness。
  '.dsh-upd button:hover:not(:disabled){border-color:var(--dsh-update-primary,#2563eb);box-shadow:0 0 0 2px var(--dsh-update-primary,#2563eb)}',
  '.dsh-upd button[data-primary="1"]:hover:not(:disabled){border-color:var(--dsh-update-focus,#2563eb);box-shadow:0 0 0 2px var(--dsh-update-primary,#2563eb)}',
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
  '@media (prefers-reduced-motion: reduce){.dsh-upd button{transition:none}.dsh-upd button:active:not(:disabled){transform:none}.dsh-upd button[aria-busy="true"]{animation:none}.dsh-upd-skv{animation:none}.dsh-upd-banner{animation:none}.dsh-upd-changelog-foldbox{transition:none}.dsh-upd-copy-bubble{animation:none}}',
  '@media (forced-colors: active){.dsh-upd-overlay .dsh-upd-body .dsh-upd-chap-head{background:Canvas}.dsh-upd-lastresort{border-color:CanvasText}.dsh-upd-lr-badge,.dsh-upd-lr-chap-badge{border-color:CanvasText;color:CanvasText}.dsh-upd-copy-bubble{border:1px solid CanvasText;background:Canvas;color:CanvasText}}',
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
  '.dsh-upd-banner-sub{font-size:var(--dsh-update-panel-small-font-size,12.5px);opacity:.75;margin:2px 0 8px;text-align:left}',
  // —— 横幅标题字号参数化（#103）：默认跟随正文继承，传 panelBannerTitleFontSize 即固定值 ——
  '.dsh-upd-banner>div:first-child strong{font-size:var(--dsh-update-panel-banner-title-font-size,inherit)}',
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
  '.dsh-upd[data-theme="archive"] .dsh-upd-masthead-kicker{display:block;font-size:var(--dsh-update-panel-small-font-size,11px);letter-spacing:.35em;color:var(--dsh-update-text-muted);margin-bottom:3px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-masthead-title{font-family:var(--dsh-update-font-serif);font-size:26px;font-weight:700;line-height:1.2}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-masthead-title i{color:var(--dsh-update-primary);font-style:normal}',
  // 横幅不再给大印章留 124px：实测（headless 量盒子）印章盒底边 y=109，横幅正文顶边 y=108、
  // 状态行那句在 y=159——印章只压到横幅顶部的留白带，压不到正文。留着反而把 27px 那句话挤成两行
  // （27px 单行需 428px，留白后只剩 366px）。档案头那 120px 保留：那里是真的重叠。
  // —— 更新队列（03 章）Archive 皮肤 ——
  '.dsh-upd[data-theme="archive"] .dsh-upd-qrow{padding:6px 0}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-qk{width:66px;letter-spacing:.18em}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-qv{font-family:var(--dsh-update-font-serif);font-size:var(--dsh-update-panel-small-font-size,16px)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-qn{font-family:var(--dsh-update-font-mono);font-size:var(--dsh-update-panel-small-font-size,11.5px);color:var(--dsh-update-text-muted)}',
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
  '.dsh-upd[data-theme="archive"] .dsh-upd-log code{font-family:var(--dsh-update-font-mono);font-size:var(--dsh-update-panel-log-font-size,11px);color:var(--dsh-update-text-muted);border:1px solid var(--dsh-update-border-strong);border-radius:3px;padding:0 6px;letter-spacing:.06em}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-manual code{display:block;background:var(--dsh-update-text);color:var(--dsh-update-bg-soft);font-family:var(--dsh-update-font-mono);font-size:var(--dsh-update-panel-log-font-size,12.5px);padding:12px 14px;border-radius:4px;white-space:pre-wrap;word-break:break-all}',
  // 待重启标记：手绘 SVG 当**独立 flex 标记**放在文字块左侧（原型 :446 `.mark` 是独立节点），
  // 不能用行内背景——那样换行时三角会落在句子中间把话劈开（现场回归）。
  // 标记贴首行居中：标题 27px×1.25 行高≈33.75px 行盒，标 20px，(33.75-20)/2≈7px；
  // 故意不用 align-items:center——标题换两行时标会飘到块中间，flex-start 永远贴首行。
  // 悬挂缩进：首行给图标让位（图标 20px＋间距 10px），换行顶格落到图标下方、整块居左；
  // 不是两行文字互相对齐——负 margin 把标题拉回行首，text-indent 只顶首行。
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="restart"]>div:first-child strong{margin-left:-30px;text-indent:30px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="restart"]>div:first-child{display:flex;gap:10px;align-items:flex-start}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="restart"]>div:first-child::before{content:"";flex:none;width:20px;height:20px;margin-top:7px;',
  'background:url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2720%27 height=%2720%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%238a5a00%27 stroke-width=%272%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27%3E%3Cpath d=%27M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z%27/%3E%3Cline x1=%2712%27 y1=%279%27 x2=%2712%27 y2=%2713%27/%3E%3Cline x1=%2712%27 y1=%2717%27 x2=%2712.01%27 y2=%2717%27/%3E%3C/svg%3E") no-repeat center/20px 20px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner>div:first-child{overflow:hidden;text-overflow:ellipsis}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-actions{flex-wrap:wrap}',
  // footer 只换肤（#47 定案 A + Archive 约束：不换 DOM 顺序；复制诊断永不隐藏，本串不动它）。
  '.dsh-upd[data-theme="archive"] .dsh-upd-footer{margin-top:14px;padding-top:10px;border-top:1px solid var(--dsh-update-border)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-foot-note{color:var(--dsh-update-text-muted)}',
  // footer 关闭幽灵统一（#108：与 actions 非主按钮同口径——缺覆盖吃到底层 button-bg 灰填充；只给透明底，沿用 border-strong/text 纸墨，不独立设色；字号/内边距跟 footer 现状走）。
  '.dsh-upd[data-theme="archive"] .dsh-upd-footer button{background:transparent}',
  // —— 档案头（原型 :208-211 `.filehead`：serif 插件名 22px + 使用范围 + profile 牌；右侧留章位）——
  '.dsh-upd[data-theme="archive"] .dsh-upd-head{display:flex;gap:16px;align-items:baseline;flex-wrap:wrap;padding-right:120px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-name{font-family:var(--dsh-update-font-serif);font-size:22px;font-weight:700}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-meta{width:100%;font-size:var(--dsh-update-panel-small-font-size,12.5px);color:var(--dsh-update-text-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-meta b{color:var(--dsh-update-text);font-weight:600}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-proftag{font-family:var(--dsh-update-font-mono);font-size:var(--dsh-update-panel-small-font-size,11px);color:var(--dsh-update-text-muted);border:1px solid var(--dsh-update-border-strong);border-radius:3px;padding:0 6px;margin-left:8px;letter-spacing:.06em}',
  // —— 版本条（原型 :216 `.strip`：三格，格间一线，左上小写标签 + 等宽值）——
  '.dsh-upd[data-theme="archive"] .dsh-upd-strip{display:flex;flex-wrap:wrap;margin:8px 0 0;border:1px solid var(--dsh-update-border);border-radius:4px;overflow:hidden;font-size:var(--dsh-update-panel-small-font-size,12.5px)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-strip>div{flex:1 1 120px;padding:6px 10px;border-left:1px solid var(--dsh-update-border)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-strip>div:first-child{border-left:0}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-strip-k{display:block;font-size:var(--dsh-update-panel-small-font-size,11px);letter-spacing:.2em;color:var(--dsh-update-text-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-strip-v{font-family:var(--dsh-update-font-mono);font-size:var(--dsh-update-panel-small-font-size,13px)}',
  // —— 章节（原型 :218-245：01–05 编号 + 衬线标题 + 细线）——
  '.dsh-upd[data-theme="archive"] .dsh-upd-chapter{margin-top:16px;padding-top:10px;border-top:1px solid var(--dsh-update-border)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-chap-head{display:flex;align-items:baseline;gap:12px;margin-bottom:6px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-chap-no{font-family:var(--dsh-update-font-serif);font-style:italic;font-size:var(--dsh-update-panel-chapter-font-size,15px);color:var(--dsh-update-text-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-chap-title{font-family:var(--dsh-update-font-serif);font-size:var(--dsh-update-panel-chapter-font-size,17px);margin:0;letter-spacing:.1em}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-chap-rule{flex:1;border-top:1px solid var(--dsh-update-border);transform:translateY(-4px)}',
  // —— 横幅即状态行 / 待重启横幅（原型 :81-85 `.restart-banner`：2px 边框、圆角 4、内边距 12/16、衬线；右侧留章位）——
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner{border:2px solid var(--dsh-update-border-strong);border-radius:4px;padding:10px 12px;font-size:var(--dsh-update-panel-font-size,14.5px);font-family:var(--dsh-update-font-serif);gap:10px;align-items:center}',
  // #99 标题行拉满：纵向 flex + align-items:center 会把短标题收成窄块居中（章跟着偏右）；
  // 原型状态行是整行块居左，这里 stretch 回去（副行已移出框体为独立兄弟节点，不吃本条）。
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner>div:first-child{flex:1 1 auto;min-width:0;align-self:stretch}',
  // 状态行字号照原型 .status-line=27px（实测去掉横幅右侧占位后可写 486px > 428px，一行放得下）
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner>div:first-child strong{font-family:var(--dsh-update-font-serif);font-size:var(--dsh-update-panel-banner-title-font-size,27px);font-weight:700;line-height:1.25}',
  // 已是最新是落定态，标题收一号 24px（其余档位仍 27px；只动 done，不碰原型行）。
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="done"]>div:first-child strong{font-size:var(--dsh-update-panel-banner-title-font-size,24px)}',
  // —— 进度条 / 跳过行（原型 :132-133 `.prog`、:129-131 `.skipline .tag`）——
  '.dsh-upd[data-theme="archive"] .dsh-upd-prog{height:8px;background:var(--dsh-update-border);border-radius:4px;overflow:hidden;margin:10px 0 4px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-prog-bar{display:block;height:100%;background:var(--dsh-update-primary);transition:width .3s}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-progtxt{font-size:var(--dsh-update-panel-small-font-size,12.5px);color:var(--dsh-update-text-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-skipline{font-size:var(--dsh-update-panel-log-font-size,13px);margin-top:8px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-tag{display:inline-block;border:1px dashed var(--dsh-update-border-strong);border-radius:3px;padding:1px 8px;margin-right:8px;font-family:var(--dsh-update-font-mono);font-size:var(--dsh-update-panel-small-font-size,12px)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-err{font-size:var(--dsh-update-panel-log-font-size,13px);margin:0 0 6px;color:var(--dsh-update-text-muted)}',
  // —— 横幅副行（框外第二行居左小字；色框只装标题，原型状态行是裸文本）——
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner-sub{color:var(--dsh-update-text-muted);font-size:var(--dsh-update-panel-small-font-size,12.5px);text-align:left;margin:2px 0 8px}',
  // —— 动作行贴原型（d5-paper :119-125 `.btn`：13px 紧凑、无最小宽、8px 间距；复制类小按钮 12px）——
  '.dsh-upd[data-theme="archive"] .dsh-upd-actions{gap:8px;min-height:0}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-actions button{font-size:13px;line-height:1.45;padding:6px 12px;margin:0;min-width:0}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-actions button:first-child{min-width:0}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-actions button[data-primary="1"]{min-width:0}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-actions button:first-child:not([aria-busy="true"])::after{display:none}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-actions button:not([data-primary="1"]){background:transparent}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-actions button[data-action="copy-manual"],' +
  '.dsh-upd[data-theme="archive"] .dsh-upd-actions button[data-action="copy-diag"]{font-size:12px;padding:4px 10px}',
  // —— 章节标题行开关贴原型小按钮（收起/展开日志、队列开关与复制类同档 12px）——
  '.dsh-upd[data-theme="archive"] .dsh-upd-chap-note button{font-size:12px;line-height:1.45;padding:4px 10px;margin:0;min-width:0;background:transparent}',
  // —— 日志贴原型（d5-paper :137-144 `.logver`：版本 mono 粗体、分类头隐藏、条目前缀红字）——
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-version{margin:12px 0}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-title{font-family:var(--dsh-update-font-mono);font-size:var(--dsh-update-panel-log-font-size,14px);font-weight:700}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-date{font-weight:400;font-size:var(--dsh-update-panel-small-font-size,12px);color:var(--dsh-update-text-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog ul{margin:6px 0 0 2px;padding-left:18px;font-size:var(--dsh-update-panel-log-font-size,13.5px)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog li{margin:3px 0}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-catname{display:none}',
  // 作者自定义小节（data-cat="other"）：档案卷没有「类名前缀」可补，标题必须自己显示出来，
  // 否则整段内容会变成没有出处的一堆条目（六类之外唯一需要露出标题的分支）。
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-cat[data-cat="other"] .dsh-upd-changelog-catname{display:block;font-size:var(--dsh-update-panel-small-font-size,12.5px);color:var(--dsh-update-primary);font-weight:700}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-truncnote{border-left-color:var(--dsh-update-border-strong);opacity:1;color:var(--dsh-update-text-muted)}',
  // 前缀只给「正文自己没写类名」的顶层**散文**条目：嵌套子列表（.dsh-upd-md-list）的 li 不是 cat 的直接子级，
  // 正文已写 `**Added** · …` 的条目标了 data-cat-lead、整条是代码块/引用块的标了 data-cat-block（见 renderChangelogItem）
  //——否则会出现「Added · Added · …」，或在代码块前挂一个孤零零的「Added ·」。
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-cat[data-cat="Added"]>ul>li:not([data-cat-lead]):not([data-cat-block])::before{content:"Added · ";color:var(--dsh-update-primary);font-weight:700}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-cat[data-cat="Fixed"]>ul>li:not([data-cat-lead]):not([data-cat-block])::before{content:"Fixed · ";color:var(--dsh-update-primary);font-weight:700}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-cat[data-cat="Changed"]>ul>li:not([data-cat-lead]):not([data-cat-block])::before{content:"Changed · ";color:var(--dsh-update-primary);font-weight:700}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-cat[data-cat="Security"]>ul>li:not([data-cat-lead]):not([data-cat-block])::before{content:"Security · ";color:var(--dsh-update-primary);font-weight:700}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-fold[data-cat="Deprecated"]>ul>li:not([data-cat-lead]):not([data-cat-block])::before{content:"Deprecated · ";color:var(--dsh-update-text-muted);font-weight:700}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-changelog-fold[data-cat="Removed"]>ul>li:not([data-cat-lead]):not([data-cat-block])::before{content:"Removed · ";color:var(--dsh-update-text-muted);font-weight:700}',
  // —— 档案卷：行内 Markdown 只换肤（纸色底、朱红链接、去掉下划线改细底线，贴原型 .logver 的手记感）——
  '.dsh-upd[data-theme="archive"] .dsh-upd-md-code{background:var(--dsh-update-bg-soft);border-color:var(--dsh-update-border);color:var(--dsh-update-primary-deep);border-radius:2px;padding:0 3px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-md-link{color:var(--dsh-update-primary);text-decoration:none;border-bottom:1px solid currentColor}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-md-img{border-color:var(--dsh-update-border-strong);color:var(--dsh-update-text-muted)}',
  // —— 档案卷：块级 Markdown 同样只换肤（纸色代码块、墨色引用边线、列表缩进收紧）——
  '.dsh-upd[data-theme="archive"] .dsh-upd-md-pre{background:var(--dsh-update-bg-soft);border-color:var(--dsh-update-border);border-radius:2px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-md-quote{border-left-color:var(--dsh-update-border-strong);color:var(--dsh-update-text-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-md-list,.dsh-upd[data-theme="archive"] .dsh-upd-md-list-ol{padding-left:16px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-md-hr{border-top-color:var(--dsh-update-border-strong)}',
  '@media (max-width:640px){.dsh-upd[data-theme="archive"]{padding:10px 12px}.dsh-upd[data-theme="archive"]::before{top:12px;right:12px;width:56px;height:56px;font-size:15px;box-shadow:inset 0 0 0 4px var(--dsh-update-bg),inset 0 0 0 5px currentColor}.dsh-upd[data-theme="archive"] .dsh-upd-masthead-title{font-size:19px}.dsh-upd[data-theme="archive"] .dsh-upd-banner{padding-right:16px}.dsh-upd[data-theme="archive"] .dsh-upd-banner .dsh-upd-sealmini{min-width:28px;height:28px;font-size:14px;line-height:20px}.dsh-upd[data-theme="archive"] .dsh-upd-banner>div:first-child{white-space:normal}}',
  '@media (prefers-color-scheme: dark){.dsh-upd[data-theme="archive"]{--dsh-update-bg-soft:#141210;--dsh-update-bg:#1e1a15;--dsh-update-text:#ece5d3;--dsh-update-text-muted:#a89c83;',
  '--dsh-update-border:#3a3226;--dsh-update-border-strong:#5c4e3b;--dsh-update-primary:#e0684e;--dsh-update-primary-deep:#f0866b;',
  '--dsh-update-ok-text:#8fd6a4;--dsh-update-ok-bg:rgba(80,180,120,.12);--dsh-update-warn-text:#e8c15a;--dsh-update-warn-bg:rgba(232,193,90,.12);',
  '--dsh-update-bad-text:#ef8a7d;--dsh-update-bad-bg:rgba(239,138,125,.12);--dsh-update-shadow:0 1px 2px rgba(0,0,0,.4),0 12px 32px rgba(0,0,0,.45)}}',
  '@media (prefers-color-scheme: dark){.dsh-upd[data-theme="archive"] button[data-primary="1"]{color:#141210}.dsh-upd[data-theme="archive"] button:focus-visible{outline-color:var(--dsh-update-primary-deep)}}',
  '@media (prefers-color-scheme: dark){.dsh-upd[data-theme="archive"] .dsh-upd-banner[data-kind="restart"]>div:first-child::before{background-image:url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2720%27 height=%2720%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%23e8c15a%27 stroke-width=%272%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27%3E%3Cpath d=%27M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z%27/%3E%3Cline x1=%2712%27 y1=%279%27 x2=%2712%27 y2=%2713%27/%3E%3Cline x1=%2712%27 y1=%2717%27 x2=%2712.01%27 y2=%2717%27/%3E%3C/svg%3E")}}',
  // —— 深色手工命令块去反白：亮底在深纸上太晃，改卡面微亮深底 + 浅字 + 细边框（浅色仍是原型深块，不动）——
  '@media (prefers-color-scheme: dark){.dsh-upd[data-theme="archive"] .dsh-upd-manual code{background:#26211a;color:#ece5d3;border:1px solid var(--dsh-update-border-strong)}}',
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
  busyAct?: 'check' | 'install' | 'fallback' | null
  /** 失败引用（失败档案的查询键；缺省即无失败，不画卷宗）。 */
  failure?: PanelFailureRef | null
  /**
   * 合规版二次确认（#156：用户点了"装合规版"且决议出候选后，确认按钮才出现；
   * 缺省即无二次确认，只画"装合规版"。candidate 是决议点名的精确版本，按钮文案即它——
   * 用户永远先看见版本号再点确认，永不静默装旧版）。
   */
  fallbackOffer?: { candidate: string; targetVersion: string } | null
  /** 日志指引开关：false 即藏通用日志行（失败证据行不受影响）。 */
  showLogHint?: boolean
  /**
   * 本插件的日志目录（#123）：宿主经 includeEnv 回的真值，只在错误章路牌里露一行。
   * 没给（或不是字符串）= 退回「目录算式 + tail 命令模板」，路牌不指一个并不存在的值。
   */
  logDir?: string | null
  /**
   * 日志健康读数（#212）：宿主成功回包里的 logHealth，只在日志区露一行；缺省（老宿主）不出现，
   * 输出与旧版一字不差。面板不解释语义，措辞全部来自 panel-copy 的 logHealthText（单一措辞源）。
   */
  logHealth?: UpdateLogHealth | null
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
  /**
   * 更新器自检（#196 部署偏斜）：这块面板实际加载到的本包副本版本与层级。
   * 缺省即老输出一字不差；给了就在页脚恒显 `dsh-plugin-update@版本 (层级)`，
   * 嵌套副本另在 05 章给「先更新所属插件 / 或载体 CLI」的可执行指引。
   */
  updater?: UpdaterSelfView | null
  /**
   * 手工命令的可信来源（#177）：`frame` = 与当帧快照来自同一回包且回包带 `manual` 键；
   * `carried-over` = 失败回包沿用的旧值（fail-closed：不展示、不给复制、不高亮）；
   * `null` = 当帧确认没有命令。缺省（undefined）按 `frame` 处理，兼容纯渲染直调。
   */
  manualSource?: ManualSource | null
  /** 合规版通道是否可用（#174 判定输入之一；缺省由 `failure` 证据推导，不传即老口径）。 */
  fallbackAvailable?: boolean
  /**
   * 当前帧运行版读数是否已知（#174：`false` → 先判「可重查」而不是「无救」；
   * 缺省由 snapshot.runningVersion 推导，纯渲染要覆盖时显式给）。
   */
  runningVersionKnown?: boolean | null
  /** 复制成功气泡（#173 v1.3）：坐标由点击时的 getBoundingClientRect 算出；缺省即不画。 */
  copyBubble?: { text: string; left: number; top: number } | null
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
  /**
   * 翻译官机读结论（#156：内核由锁存证据解析后填入；渲染只按它们分支，不读自由文本）。
   * causePackage 是带版本的规格（如 dshmarket@1.66.28）；窗口/发布时间缺省即 null（算不出）。
   * 全缺省即老行为（通用失败按钮），调用方不传与传 null 等价。
   */
  causeKind?: string | null
  causePackage?: string | null
  causeTarget?: string | null
  causeWindowMs?: number | null
  causePublishedAtMs?: number | null
}

/**
 * 检查页预判输入（#156 场景二）：内核把"记住的窗口"翻译成渲染能直接用的三件事——
 * 哪一版（记住的目标版）、何时放行（记住的发布时间 + 窗口）、现在何时（渲染时刻，
 * 纯函数可测）。窗口为 null 即不传本输入（规则三：没有窗口不预判）。
 */
export interface CheckPrejudge {
  targetVersion: string
  unlockAtMs: number
  nowMs: number | null
}

/**
 * 检查页预判门（#156 场景二，纯函数）：四道全过才预判——有输入、可装、有新版、
 * 记住的正是对当前这一版、时钟正常且还没放行。缺一律 null（调用方走正常检查页）。
 * 内核已按记住匹配过一次，这里再验一遍：渲染只信当下快照，不信调用方。
 */
export function checkPrejudgeOfView(
  pre: CheckPrejudge | null | undefined,
  snapshot: UpdateSnapshot | null | undefined,
): { targetVersion: string; unlockAtMs: number } | null {
  try {
    if (!pre || !snapshot?.canInstall) return null
    const latest = typeof snapshot.latestVersion === 'string' ? snapshot.latestVersion.trim() : ''
    const target = typeof pre.targetVersion === 'string' ? pre.targetVersion.trim() : ''
    if (!latest || !target || latest !== target) return null
    if (typeof pre.unlockAtMs !== 'number' || !Number.isFinite(pre.unlockAtMs)) return null
    if (typeof pre.nowMs !== 'number' || !Number.isFinite(pre.nowMs) || pre.nowMs >= pre.unlockAtMs) return null
    return { targetVersion: target, unlockAtMs: pre.unlockAtMs }
  } catch {
    return null
  }
}

/**
 * 合规版双按钮门（#156，纯函数）：拦的正是更新目标本身才给"装合规版/等新版"。
 * 输入是失败引用里的机读结论 + 失败那次的目标版本；返回被拦住的版本号（无则 null，不画按钮）。
 * 归因只认 target（B 类 other-package/unknown 一律 null：降级装没被拦的包躲不掉别人的窗口）。
 */
export function fallbackBlockedVersionOf(
  failure: Pick<PanelFailureRef, 'targetVersion' | 'causeKind' | 'causePackage' | 'causeTarget'> | null | undefined,
  pluginId: unknown,
): string | null {
  try {
    return vetFailureRef(failure, pluginId)
  } catch {
    return null
  }
}

function vetFailureRef(
  failure: Pick<PanelFailureRef, 'targetVersion' | 'causeKind' | 'causePackage' | 'causeTarget'> | null | undefined,
  pluginId: unknown,
): string | null {
  const kind = typeof failure?.causeKind === 'string' ? failure.causeKind.trim() : ''
  if (!kind || !(CAUSE_KINDS as readonly string[]).includes(kind)) return null
  const spec = typeof failure?.causePackage === 'string' ? failure.causePackage.trim() : ''
  if (!spec) return null
  // 归因目标优先用机读包名（命名空间正确），缺省才退回插件标识——对不上即无按钮，不硬认。
  const target = typeof failure?.causeTarget === 'string' && failure.causeTarget.trim()
    ? failure.causeTarget.trim()
    : typeof pluginId === 'string' && pluginId.trim() ? pluginId.trim() : ''
  if (!target) return null
  if (blameCausePackage(spec, target) !== 'target') return null
  const direct = typeof failure?.targetVersion === 'string' ? failure.targetVersion.trim() : ''
  if (direct) return direct
  const at = spec.lastIndexOf('@')
  const ver = at > 0 ? spec.slice(at + 1).trim() : ''
  return ver || null
}

/**
 * 锁存证据 → 机读结论（#156，纯函数）：翻译官重认一次锁存里的失败原文，
 * 给出渲染门与电话入参要的全部事实；认不出即 null（调用方走通用老路）。
 * 窗口优先用报文自述分钟数，否则用门限反推（cutoff - published），都没有即 null——
 * 永不硬编码策略时长；归因非 target 即 null（与渲染门同口径）。
 */
export function fallbackCauseFromDetail(detail: unknown, errorCode: unknown, pluginId: unknown): {
  kind: string
  packageName: string
  targetVersion: string
  windowMs: number | null
  /** 窗口出处（报文自述分钟数即 message，门限反推即 unknown——只回传，不参与决议）。 */
  windowSource: 'message' | 'unknown'
  publishedAtMs: number | null
} | null {
  try {
    const facts = interpretInstallCause({
      errorCode: typeof errorCode === 'string' && errorCode ? errorCode : 'install-failed',
      detail,
      targetPackageName: typeof pluginId === 'string' ? pluginId : undefined,
    })
    if (!facts || facts.kind !== 'minimum-release-age' || facts.blame !== 'target') return null
    const targetVersion = typeof facts.packageVersion === 'string' && facts.packageVersion.trim()
      ? facts.packageVersion.trim()
      : null
    if (!targetVersion) return null
    let windowMs: number | null = null
    let windowSource: 'message' | 'unknown' = 'unknown'
    if (typeof facts.windowMinutes === 'number' && Number.isFinite(facts.windowMinutes) && facts.windowMinutes > 0) {
      windowMs = facts.windowMinutes * 60_000
      windowSource = 'message'
    } else if (
      typeof facts.cutoffMs === 'number' && typeof facts.publishedAtMs === 'number'
      && facts.cutoffMs > facts.publishedAtMs
    ) {
      windowMs = facts.cutoffMs - facts.publishedAtMs
    }
    return {
      kind: facts.kind,
      packageName: facts.packageName,
      targetVersion,
      windowMs,
      windowSource,
      publishedAtMs: typeof facts.publishedAtMs === 'number' ? facts.publishedAtMs : null,
    }
  } catch {
    return null
  }
}

/**
 * 机读诊断 → 兜底结论（#156 第四轮，纯函数，三个入口共用同一支）。
 *
 * 为什么必须有这一支：安装是异步的。年龄门拦在**安装那一刻**，回包照旧 ok:true，真正的失败
 * 落在之后的快照任务里，而任务里只剩「失败码 + 原文」。原文要认出因必须知道**包名**，可面板手里
 * 只有**插件标识**；真宿主（dsh-life-pack）给的标识是 `life-<key>` 这类派生值，与 npm 包名不同
 * ——于是「装合规版」在真机上永远说不出因（fail-closed 成一枚死按钮）。
 * 宿主已按同一套 buildDiag 把目标包名补回 diag（host.ts 的 failedJobDiagOf），这里就按机读格认，
 * 不再拿标识撞运气：包名与归因来自宿主事实，时间格仍从原文取（窗口/发布时间只在原文里）。
 * 原文认不出也照样回身份结论（窗口交决议侧反推）——只要 diag 说得清「拦的是这个包」。
 */
export function fallbackCauseFromDiag(
  diag: unknown,
  detail: unknown,
  errorCode: unknown,
  preferredTargetVersion?: unknown,
): {
  kind: string
  /** 诊断里的包规格原样（`pkg@0.4.2`）。 */
  spec: string
  /** 诊断里的目标包名（宿主事实，归因就按它判）。 */
  target: string
  /** 剥掉版本的包名（渲染/日志用）。 */
  packageName: string
  targetVersion: string
  windowMs: number | null
  windowSource: 'message' | 'unknown'
  publishedAtMs: number | null
} | null {
  try {
    const d = diag && typeof diag === 'object' && !Array.isArray(diag) ? (diag as Record<string, unknown>) : null
    if (!d) return null
    const dKind = typeof d['causeKind'] === 'string' ? d['causeKind'].trim() : ''
    const dSpec = typeof d['causePackage'] === 'string' ? d['causePackage'].trim() : ''
    const dTarget = typeof d['targetPackageName'] === 'string' ? d['targetPackageName'].trim() : ''
    if (!dKind || !(CAUSE_KINDS as readonly string[]).includes(dKind) || !dSpec || !dTarget) return null
    if (blameCausePackage(dSpec, dTarget) !== 'target') return null
    const timed = fallbackCauseFromDetail(detail, errorCode, dTarget)
    const preferred = typeof preferredTargetVersion === 'string' ? preferredTargetVersion.trim() : ''
    const at = dSpec.lastIndexOf('@')
    const specVer = at > 0 ? dSpec.slice(at + 1).trim() : ''
    const targetVersion = preferred || timed?.targetVersion || specVer
    if (!targetVersion) return null
    return {
      kind: dKind,
      spec: dSpec,
      target: dTarget,
      packageName: at > 0 && dSpec.slice(0, at).trim() ? dSpec.slice(0, at).trim() : dTarget,
      targetVersion,
      windowMs: timed?.windowMs ?? null,
      windowSource: timed?.windowSource ?? 'unknown',
      publishedAtMs: timed?.publishedAtMs ?? null,
    }
  } catch {
    return null
  }
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
    // 磁盘格是单插件面板的版本槽状态词：缺席不说「未知」，说「未安装」（#134/US8）。
    cell(copyText('panel.strip.installed', l), snapshot.installed === false ? copyText('panel.banner.not-installed', l) : snapshot.installedVersion) +
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

/**
 * 更新器自检身份（#196 部署偏斜）：`dsh-plugin-update@版本 (层级)`。
 * 这是机读事实（品牌名 + 版本 + 层级 token），不进字典、不翻译；缺版本即不画（不编造）。
 */
function updaterIdentityOf(input: PanelRenderInput): string | null {
  const parts = updaterPartsOf((input as { updater?: UpdaterSelfView | null }).updater)
  return parts ? `dsh-plugin-update@${parts.version} (${parts.level})` : null
}

/** 从 includeEnv 回包两格取自检事实（#196）；本包版本读不到就 null（不编造）。 */
function updaterSelfOfEnv(env: Record<string, unknown>): UpdaterSelfView | null {
  const uv = env['updaterVersion']
  const ul = env['updaterCopyLevel']
  if (typeof uv !== 'string' || !uv.trim()) return null
  return { version: uv.trim(), level: typeof ul === 'string' && ul.trim() ? ul.trim() : 'unknown' }
}

/**
 * 嵌套副本的载体 CLI 升级指引（#196）：把更新器装到使用范围级，让共用那一份的其他插件先换新。
 * 缺使用范围名就是假命令 ⇒ null（宁可只说明为什么升级不生效，也不画「或运行：」空着）。
 */
function selfUpgradeCommandOf(profileName: string | null | undefined): string | null {
  const profile = typeof profileName === 'string' ? profileName.trim() : ''
  if (!profile) return null
  return `dsh plugin --profile ${profile} add --save-exact dsh-plugin-update@latest`
}

/**
 * #177：渲染输入里的 manualSource 归一。
 * - `undefined` = 纯渲染直调（老调用方没这个概念）：按 `frame` 处理，保持既有输出；
 * - `null` = 当帧确认没有命令；
 * - `carried-over` = 失败回包沿用的旧值（不可信）。
 */
function manualSourceOfRender(input: { manualSource?: ManualSource | null }): ManualSource | null {
  const value = input.manualSource
  if (value === 'carried-over') return 'carried-over'
  if (value === null) return null
  return 'frame'
}

/** 命令是否可信（当帧且非空）——展示/复制/高亮三件事共用这一个判据。 */
function manualTrustedOf(manual: string | null, source: ManualSource | null): boolean {
  return typeof manual === 'string' && manual.trim() !== '' && source === 'frame'
}

/** 手绘 alert 图标（八角停形 + 惊叹号；#174：统一 16×16 viewBox，inline SVG，禁 emoji，不引外部图标）。 */
const LAST_RESORT_ALERT_SVG =
  '<svg class="dsh-upd-lr-ico" viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">' +
  '<path d="M8 1.8 12.4 3.6 14.2 8 12.4 12.4 8 14.2 3.6 12.4 1.8 8 3.6 3.6Z"/><path d="M8 5.2v4"/>' +
  '<circle cx="8" cy="11.6" r="0.85" fill="currentColor" stroke="none"/></svg>'

/** 手绘 copy 图标（双页，16×16 viewBox）。复制按钮前后一字不变（v1.3：成功不改按钮文案/图标）。 */
const COPY_ICON_SVG =
  '<svg class="dsh-upd-copy-ico" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">' +
  '<rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1"/>' +
  '<path d="M10.5 5.5V4.2a1 1 0 0 0-1-1H4.2a1 1 0 0 0-1 1v5.3a1 1 0 0 0 1 1h1.3"/></svg>'

/**
 * A′ 最后手段条（#174）：左红轨 + alert SVG + 「最后手段」徽标 + 状态短语 + 归因句 + 紧凑主按钮。
 * 只有 `kind === 'last-resort'` 才输出；其它三态返回空串（不画空高亮）。按钮由调用方决定：
 * 有动作面的渲染点给 copy-manual，只读渲染（批量详情）不给按钮，沿用详情自己的动作行。
 */
export function lastResortBarHTML(opts: {
  verdict: LastResortVerdict | null
  lang: AppLang | string | null
  buttonHtml?: string
}): string {
  const verdict = opts.verdict
  if (!verdict || verdict.kind !== 'last-resort') return ''
  const l = normalizeLangTag(opts.lang ?? 'zh')
  const badge = escapeHtml(copyText('panel.lastresort.badge', l))
  return (
    '<div class="dsh-upd-lastresort" data-last-resort="last-resort">' +
    LAST_RESORT_ALERT_SVG +
    '<div class="dsh-upd-lr-main">' +
    '<div class="dsh-upd-lr-line"><span class="dsh-upd-lr-badge">' +
    badge +
    '</span><strong class="dsh-upd-lr-status">' +
    escapeHtml(copyText('panel.lastresort.status', l)) +
    '</strong></div>' +
    '<div class="dsh-upd-lr-reason">' + escapeHtml(copyText('panel.lastresort.reason', l)) + '</div>' +
    '</div>' +
    (opts.buttonHtml ?? '') +
    '</div>'
  )
}

/** 最后手段条里的紧凑主按钮（#174 A′：按钮在主位；文案/图标在复制前后不变，见 v1.3）。 */
export function lastResortCopyButtonHTML(lang: AppLang | string | null): string {
  const l = normalizeLangTag(lang ?? 'zh')
  return (
    '<button type="button" class="dsh-upd-lr-go primary" data-primary="1" data-action="copy-manual" data-copy-anchor="1" title="' +
    escapeHtml(copyText('panel.lastresort.copy', l)) +
    '">' + COPY_ICON_SVG + escapeHtml(copyText('panel.lastresort.copy', l)) + '</button>'
  )
}

/** 复制成功气泡（v1.3）：fixed 定位、role=status，约 1.4s 由挂载侧撤掉。 */
export function copyBubbleHTML(bubble: { text: string; left: number; top: number } | null | undefined): string {
  if (!bubble) return ''
  const left = Number.isFinite(bubble.left) ? Math.round(bubble.left) : 0
  const top = Number.isFinite(bubble.top) ? Math.round(bubble.top) : 0
  return (
    '<span class="dsh-upd-copy-bubble" role="status" style="position:fixed;left:' + left + 'px;top:' + top + 'px">' +
    escapeHtml(bubble.text) + '</span>'
  )
}

/**
 * #213：宿主判定的「为什么没有说明」→ 空白分支的话术。只认这四档（各自说清「不是什么」）；
 * `ok` 与 `cache-hit` 不入表：前者本就有内容要渲染，后者只是取数方式位，文案保持既有。
 */
const CHANGELOG_STATUS_KEYS: Partial<Record<ChangelogStatus, BilingualKey>> = {
  empty: 'panel.changelog.status.empty',
  missing: 'panel.changelog.status.missing',
  'fetch-failed': 'panel.changelog.status.fetch-failed',
  'parse-degraded': 'panel.changelog.status.parse-degraded',
}

/** 分档话术键（认不出/`ok`/`cache-hit` → null，即保持既有文案一字不动）。 */
function changelogStatusCopyKey(status: ChangelogStatus | null | undefined): BilingualKey | null {
  if (!status) return null
  return CHANGELOG_STATUS_KEYS[status] ?? null
}

/** 内核 HTML（双形态行为等价的根：同一视图产出同一内核，只换外层；#62 按 lang 单语，缺省 zh 零回归）。 */
export function renderUpdatePanelKernel(input: PanelRenderInput, view: PanelView, lang?: AppLang | string | null): string {
  const { snapshot, manual, queue, mode, showOthers, pluginId, copyNotice } = input
  const l = normalizeLangTag(lang ?? (input as { lang?: unknown }).lang ?? 'zh')
  const changelogMarkdown =
    (input as { changelogMarkdown?: unknown }).changelogMarkdown ?? null
  // #213：宿主判定的日志分档（空文件 / 包里没有这个文件 / 取数失败 / 有文无结构）。
  // 认不出的值（老宿主、手搓回包、未来野值）一律当没有——文案与旧版一字不差。
  const rawChangelogStatus = (input as { changelogStatus?: unknown }).changelogStatus
  const changelogStatusValue = isChangelogStatus(rawChangelogStatus) ? rawChangelogStatus : null
  const changelogStatusKey = changelogStatusValue === null
    ? null
    : changelogStatusCopyKey(changelogStatusValue)
  const profileName =
    typeof (input as { profileName?: unknown }).profileName === 'string' && (input as { profileName: string }).profileName
      ? (input as { profileName: string }).profileName
      : null
  const b = view.banner
  const seal = view.seal
  const parts: string[] = []
  // #174：最后手段判定只算一次（纯函数是唯一真源，三处渲染点共用；渲染器不各自推导）。
  // manualSource 缺省按 frame（见 manualSourceOfRender）；只有 last-resort 这一档才落高亮。
  const manualSource = manualSourceOfRender(input)
  const manualTrusted = manualTrustedOf(manual, manualSource)
  // #174：失败码优先取 errorKind（与 viewModel 同口径；lastError 仅兜底），否则实际码会被上一帧的码盖住。
  const lastResortCode =
    (typeof (input as { errorKind?: unknown }).errorKind === 'string' && (input as { errorKind: string }).errorKind.trim()
      ? (input as { errorKind: string }).errorKind.trim()
      : '') ||
    (typeof (input as { lastError?: unknown }).lastError === 'string' ? (input as { lastError: string }).lastError.trim() : '')
  const lastResort = lastResortVerdictOf({
    code: lastResortCode || null,
    blockedReason: snapshot ? snapshot.blockedReason : null,
    manual,
    manualSource,
    // 合规版救援证据只认 #156 的正式渲染门（与 01 章双按钮同一判据），不凭 cause 字段猜。
    fallbackAvailable: input.fallbackAvailable === true || fallbackBlockedVersionOf(input.failure, pluginId) !== null,
    runningVersionKnown:
      typeof input.runningVersionKnown === 'boolean'
        ? input.runningVersionKnown
        : snapshot
          ? snapshot.runningVersion !== null
          : null,
    // #174：待重启救援按「在册」分叉（未登记 → 在宿主里先选中，重启也不会加载）。
    registered: snapshot ? snapshot.registered ?? null : null,
  })
  // 动作面开关要在横幅之前算：最后手段条的紧凑主按钮与 01 章按钮同权，只读渲染（批量详情）不给。
  const showActions = input.actions !== 'none'
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
  // #174 A′：失败 / 待重启 / 受阻帧的失败块第一行插最后手段条（只在判定为 last-resort 时真有内容，
  // 其余三态返回空串，不留空壳）。放在横幅之前 = 失败块第一行，也避开横幅的 role=status 活区。
  const lastResortBarHtml =
    b.kind === 'failed' || b.kind === 'restart' || b.kind === 'blocked'
      ? lastResortBarHTML({
          verdict: lastResort,
          lang: l,
          buttonHtml: showActions ? lastResortCopyButtonHTML(l) : '',
        })
      : ''
  if (lastResortBarHtml) parts.push(lastResortBarHtml)
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
  // showActions 已在横幅之前算过（最后手段条的按钮要先知道动作面开不开）。
  const actions: string[] = []
  if (showActions) {
  const busyAct = (input as { busyAct?: unknown }).busyAct
  const checkBusy = busyAct === 'check'
  const installBusy = busyAct === 'install'
  const fallbackBusy = busyAct === 'fallback'
  // #87 宏忙守卫（与批量 macroBusy 同口径）：快照 installing/verifying 或任一本地电话在飞，两键一起置灰。只渲染不推导：不改电话形状与快照字段，不新增文案键。
  // #156：合规版决议在途也算宏忙——查/装按钮一起置灰，防决议结论（第二槽）被并发检查洗掉。
  const jobState = (snapshot as unknown as { job?: { state?: unknown } } | null)?.job?.state
  const snapshotBusy = jobState === 'installing' || jobState === 'verifying'
  const macroBusy = busyAct === 'check' || busyAct === 'install' || fallbackBusy || snapshotBusy
  // #156 场景二：检查页预判与视图模型同一纯门（只信当下快照）——主安装按钮已按它置灰，
  // 这里只补按钮与悬停说明。决议凭证只认对当前这一版的：旧版决议不跨版复用。
  const gatePrejudge = b.kind === 'update' ? checkPrejudgeOfView(
    (input as { checkPrejudge?: CheckPrejudge | null }).checkPrejudge ?? null,
    snapshot,
  ) : null
  const gateOfferRaw = (input as { fallbackOffer?: { candidate?: unknown; targetVersion?: unknown } | null }).fallbackOffer ?? null
  const gateCandidate =
    gatePrejudge && typeof gateOfferRaw?.candidate === 'string' && gateOfferRaw.candidate.trim()
    && typeof gateOfferRaw?.targetVersion === 'string' && gateOfferRaw.targetVersion.trim() === gatePrejudge.targetVersion
      ? gateOfferRaw.candidate.trim()
      : null
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
        : `<button type="button" data-action="install" data-primary="1" title="${escapeHtml(gatePrejudge ? copyText('panel.action.install-gated-title', l, { latest: snapshot?.latestVersion ?? '', unlock: formatUnlockAt(gatePrejudge.unlockAtMs, l) ?? '' }) : copyText('panel.action.install-title', l))}"${macroBusy || !view.installEnabled ? ' disabled' : ''}>${escapeHtml(view.installLabel)}</button>`),
  )
  if (snapshot?.latestVersion && !view.skippedLatest && view.banner.kind === 'update') {
    actions.push(`<button type="button" data-action="skip" title="${escapeHtml(copyText('panel.action.skip-title', l))}">${escapeHtml(copyText('panel.action.skip', l))}</button>`)
  }
  // #156 场景二：检查页预判生效 → 给［装合规版］（决议出候选后变"确认装 X"，
  // 与失败页同一对按钮的复刻；独缺"等新版"——检查页本就是等的地方，不需要再等一次）。
  if (gatePrejudge) {
    actions.push(
      gateCandidate
        ? `<button type="button" data-action="install-fallback-confirm" data-primary="1" title="${escapeHtml(copyText('panel.action.install-fallback-confirm-title', l))}"${macroBusy || fallbackBusy ? ' disabled' : ''}>${escapeHtml(copyText('panel.action.install-fallback-confirm', l, { version: gateCandidate }))}</button>`
        : fallbackBusy
          ? `<button type="button" data-action="install-fallback" data-primary="1" disabled aria-busy="true" title="${escapeHtml(copyText('panel.action.install-fallback-title', l))}">${escapeHtml(copyText('panel.action.install-fallback', l))}</button>`
          : `<button type="button" data-action="install-fallback" data-primary="1" title="${escapeHtml(copyText('panel.action.install-fallback-title', l))}"${macroBusy ? ' disabled' : ''}>${escapeHtml(copyText('panel.action.install-fallback', l))}</button>`,
    )
  }
  if (view.showReset && snapshot?.latestVersion) {
    actions.push(`<button type="button" data-action="reset-skip" title="${escapeHtml(copyText('panel.action.unskip-title', l))}">${escapeHtml(copyText('panel.action.unskip', l, { version: snapshot.latestVersion }))}</button>`)
  }
  // 最后手段条已经给了同一颗主按钮时，01 章不再画第二颗一模一样的「复制手工命令」。
  if (view.showManual && manualTrusted && !lastResortBarHtml) {
    actions.push(`<button type="button" data-action="copy-manual" title="${escapeHtml(copyText('panel.action.copy-manual-title', l))}">${escapeHtml(copyText('panel.action.copy-manual', l))}</button>`)
  }
  // 原型的待重启横幅右侧有个主动作「重启宿主」（archive.html:448）。
  // 宿主没有「重启自己」的电话，所以这里只做入口：调用方给了 onRestartRequested 就交给它，
  // 没给就如实提示「请手动重启」——不假装能重启。
  if (b.kind === 'restart') {
    actions.push(`<button type="button" data-action="restart-hint" title="${escapeHtml(copyText('panel.action.restart-host-title', l))}">${escapeHtml(copyText('panel.action.restart-host', l))}</button>`)
  }
  // #156：拦的正是更新目标本身，失败行给双按钮［装合规版］［等新版］替代"已知晓"——
  // B 类（拦的是别家包）与认不出的失败走通用老路，一个字不动。二次确认态（fallbackOffer）
  // 把"装合规版"换成点名版本的"确认装 X"：用户先看见版本号再点确认，永不静默装旧版。
  const failureForFallback = (input as { failure?: PanelFailureRef | null }).failure ?? null
  const fallbackBlocked = b.kind === 'failed' ? fallbackBlockedVersionOf(failureForFallback, pluginId) : null
  const fallbackOfferRaw = (input as { fallbackOffer?: { candidate?: unknown; targetVersion?: unknown } | null }).fallbackOffer ?? null
  const fallbackCandidate =
    fallbackBlocked && typeof fallbackOfferRaw?.candidate === 'string' && fallbackOfferRaw.candidate.trim()
      ? fallbackOfferRaw.candidate.trim()
      : null
  if (fallbackBlocked) {
    actions.push(
      fallbackCandidate
        ? `<button type="button" data-action="install-fallback-confirm" data-primary="1" title="${escapeHtml(copyText('panel.action.install-fallback-confirm-title', l))}"${macroBusy || fallbackBusy ? ' disabled' : ''}>${escapeHtml(copyText('panel.action.install-fallback-confirm', l, { version: fallbackCandidate }))}</button>`
        : fallbackBusy
          ? `<button type="button" data-action="install-fallback" data-primary="1" disabled aria-busy="true" title="${escapeHtml(copyText('panel.action.install-fallback-title', l))}">${escapeHtml(copyText('panel.action.install-fallback', l))}</button>`
          : `<button type="button" data-action="install-fallback" data-primary="1" title="${escapeHtml(copyText('panel.action.install-fallback-title', l))}"${macroBusy ? ' disabled' : ''}>${escapeHtml(copyText('panel.action.install-fallback', l))}</button>`,
    )
    actions.push(`<button type="button" data-action="wait-latest" title="${escapeHtml(copyText('panel.action.wait-latest-title', l))}"${macroBusy || fallbackBusy ? ' disabled' : ''}>${escapeHtml(copyText('panel.action.wait-latest', l))}</button>`)
  } else if (b.kind === 'failed') {
    actions.push(`<button type="button" data-action="dismiss-failure" title="${escapeHtml(copyText('panel.action.dismiss-title', l))}">${escapeHtml(copyText('panel.action.dismiss', l))}</button>`)
  }
  // #153-B：复制诊断在失败时常驻——无快照但有失败横幅/失败引用时也给按钮，
  // 修“失败旁没有复制诊断”。首帧 loading（无快照、无失败）仍不给，不多一个按钮。
  const failureRef = (input as { failure?: unknown }).failure
  if (snapshot || b.kind === 'failed' || !!failureRef) {
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
    // #213：分档话术只在「本来就没有内容可渲染」时才顶替旧中性句（见下面两条分支与兜底）。
    const statusCopyText = changelogStatusKey === null ? '' : copyText(changelogStatusKey, l)
    if (snapshot && snapshot.latestVersion) {
      try {
        const mdText = typeof changelogMarkdown === 'string' ? changelogMarkdown : ''
        const report = parseChangelogReport(mdText)
        const entries = report.entries
        const ranged = changelogForUpdate(
          entries,
          snapshot.runningVersion,
          snapshot.latestVersion,
          snapshot.installedVersion,
        )
        // 有文本但一个版本节都读不出：诚实说读不出来，不说"未提供"。
        // 空文本仍走"未提供"；有解析节但区间外仍走旧中性（区间外是另一回事，不在此改）。
        if (ranged.length === 0 && mdText.trim() && entries.length === 0) {
          // #213：宿主判了 parse-degraded（有内容、没结构）就说「不是没有说明」；其余分档不在这插话。
          const degradedText = changelogStatusValue === 'parse-degraded' ? statusCopyText : ''
          inner = `<div class="dsh-upd-changelog-wrap"><div class="dsh-upd-changelog-neutral">${escapeHtml(degradedText || copyText('panel.changelog.unavailable', l))}</div>${truncationNoteHTML(report.truncation, l)}</div>`
          hasLog = false
        } else if (!mdText.trim() && statusCopyText) {
          // #213：文本为空但成因不同（空文件 / 包里没有 / 没取到）——空白分支改说实话，
          // 不再一律「未提供」；没有分档（老宿主/手搓回包）仍走下面的老分支，输出一字不差。
          inner = `<div class="dsh-upd-changelog-wrap"><div class="dsh-upd-changelog-neutral">${escapeHtml(statusCopyText)}</div></div>`
          hasLog = false
        } else {
          const changelogHTML = renderChangelogHTML(ranged, { lang: l, truncated: report.truncation })
          // 缺席时日志区间的左端不许写注入的假版号（#134/US19）：写人话状态词；运行版未知同样写「未知」（#182）。
          const fromText =
            snapshot.installed === false
              ? copyText('panel.banner.not-installed', l)
              : snapshot.runningVersion ?? copyText('panel.meta.unknown', l)
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
        } // end else（正常渲染分支）
      } catch {
        // 日志画坏了也不挡更新：退回中性提示，安装按钮状态不变。
        inner = ''
      }
    }
    if (!inner) {
      // #213：这一档本该说「更新日志无法读取」——有分档就说清是哪一档；无新版仍走旧句。
      const blankText =
        snapshot && snapshot.latestVersion
          ? statusCopyText || copyText('panel.changelog.unavailable', l)
          : copyText('panel.changelog.unavailable-empty', l)
      inner = `<div class="dsh-upd-changelog-wrap"><div class="dsh-upd-changelog-neutral">${escapeHtml(blankText)}</div></div>`
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
      // 路牌里的日志目录（#123）：宿主 includeEnv 回了就写实路径，没回就写算式与命令模板
      // ——路牌宁可说「目录长这样、命令长这样」，也不指一个并不存在的值。
      const logDirInput = (input as { logDir?: unknown }).logDir
      const logDirKnown = typeof logDirInput === 'string' && logDirInput.trim() ? logDirInput.trim() : null
      // 占位符一律 ASCII：中文只许存文案源（src/bilingual.ts），路径与命令里的尖括号不译。
      const logDirShown = logDirKnown ?? '<DSH_HOME>/logs/<derived>'
      // 命令不带 `tail`：dsh-log 0.3.1 的解析器把非 `-` 开头的词一律当路径，
      // 而它的 USAGE 写着 `tail` —— 带上就会多吐一句「没找到日志目录：tail」。
      const logCmdShown = logDirKnown ? `npx dsh-log ${logDirKnown}` : 'npx dsh-log <log-dir>'
      errLines.push(
        `<div class="dsh-upd-log">${copyText('panel.error.log-hint', l, {
          dir: `<code>${escapeHtml(logDirShown)}</code>`,
          cmd: `<code>${escapeHtml(logCmdShown)}</code>`,
          pluginId: `<code>${escapeHtml(pluginId)}</code>`,
          e1: `<code>${LOG_EVENT_CALL}</code>`,
          e2: `<code>${LOG_EVENT_CALL_FAIL}</code>`,
          e3: `<code>${LOG_EVENT_INSTALL_EXEC}</code>`,
        })}</div>`,
      )
      // #212 日志健康：成功回包带了读数就多一行（这一帧日志到底有没有、落点是谁、为什么没有）；
      // 老宿主没有这个键 / 没读数即不出现（不占位），措辞全部来自 panel-copy.logHealthText。
      const healthLine = logHealthText(input.logHealth, l)
      if (healthLine) errLines.push(`<div class="dsh-upd-log">${escapeHtml(healthLine)}</div>`)
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
  // #92：空态分原因说清（源码安装 / 开发态 / 范围认不出 / 运行版未知 / 没有安全候选）。
  // 只在「用户本该拿到命令」的横幅状态（失败 / 待重启 / 受阻 / 可更新）里套原因，判据与
  // 面板分支共用 manual-absent 的一张表；读取中、已最新这类状态不涉及命令，仍给中性兜底句。
  const manualAbsentReason =
    !manual && manualAppliesToBanner(b.kind) ? manualAbsentReasonOf(snapshot) : null
  // #177：失败回包沿用的旧命令不可信 —— fail-closed：不展示、不给复制、不高亮，只说明它还没按当帧读数确认。
  const manualStale = manualSource === 'carried-over' && Boolean(manual)
  let manualHtml =
    view.showManual && manualTrusted
      ? `<div class="dsh-upd-manual"><div>${escapeHtml(copyText('panel.manual.heading', l))}</div><code>${escapeHtml(manual ?? '')}</code></div>`
      : `<div class="dsh-upd-manual"><div class="dsh-upd-changelog-neutral">${
          manualStale
            ? escapeHtml(copyText('panel.manual.stale', l))
            : escapeHtml(manualAbsentTextOf(manualAbsentReason, l))
        }</div></div>`
  // #196 部署偏斜：嵌套副本（被消费方声明范围钉死）在这里给可执行的升级指引。
  // 缺使用范围名就不给命令（假命令比没有更糟），只说明为什么升级不生效。
  const selfParts = updaterPartsOf((input as { updater?: UpdaterSelfView | null }).updater)
  if (selfParts && selfParts.level === 'nested') {
    const command = selfUpgradeCommandOf(profileName)
    manualHtml +=
      `<div class="dsh-upd-updater-nested">` +
      escapeHtml(
        command
          ? copyText('panel.manual.updater-nested', l, { version: selfParts.version, command })
          : copyText('panel.manual.updater-nested-nocmd', l, { version: selfParts.version }),
      ) +
      `</div>`
  }
  // 身份兜底：footer 只在 dialog + 有动作面时画；embedded / 只读渲染由 05 章补一行，
  // 保证「任意宿主插件面板都能看到本面板跑的是哪一份副本」（#196 验收）。
  const updaterIdentity = updaterIdentityOf(input)
  const footerRendersIdentity = showActions && mode === 'dialog'
  if (updaterIdentity && !footerRendersIdentity) {
    manualHtml += `<div class="dsh-upd-updater-id">${escapeHtml(updaterIdentity)}</div>`
  }
  // #174：05 章命令块 title 旁的小徽标 —— 命令是唯一出路的提示，告诉读者 05 章这条就是最后手段。
  const manualChapNote =
    lastResortBarHtml && lastResort.kind === 'last-resort'
      ? `<span class="dsh-upd-lr-chap-badge">${escapeHtml(copyText('panel.lastresort.badge', l))}</span>`
      : ''
  chapters.push(chapterOf(5, manualHtml, manualChapNote, l))
  parts.push('<div class="dsh-upd-body">' + chapters.join('\n') + '</div>')
  // —— 右下角独立 footer 区（#47 定案 A：一次找到，脱离第一章 actions）——
  // dialog 才有，永远在 05 章之后；embedded 无（宿主框架自带关）；
  // 只读渲染（actions:'none'）下不画（动作面归调用方，免得出现可点却没人接的死按钮）。
  if (showActions && mode === 'dialog') {
    parts.push(
      '<div class="dsh-upd-footer"><span class="dsh-upd-foot-note">' + escapeHtml(copyText('panel.footer.note', l)) + '</span>' +
        (updaterIdentity ? `<span class="dsh-upd-updater-note">${escapeHtml(updaterIdentity)}</span>` : '') +
        `<button type="button" data-action="close-view" title="${escapeHtml(copyText('panel.footer.close-title', l))}">${escapeHtml(copyText('panel.footer.close', l))}</button></div>`,
    )
  }
  // v1.3：复制成功气泡是 fixed 定位的状态提示，画在卷宗根部（不挤压布局），约 1.4s 由挂载侧撤掉。
  if (input.copyBubble) parts.push(copyBubbleHTML(input.copyBubble))
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
  // 客户端日志（#122）：先把调用方给的通道读出来 —— 这样「挂载校验失败」也能如实记一行
  // （自建通道要等 call 校验过才建得起来：没有传输就没有地方可报）。
  const logOptionRead =
    options && typeof options === 'object' ? (options as { clientLog?: UpdatePanelClientLogOptions | null }).clientLog : undefined
  const clientLogDisabled = logOptionRead === null
  const clientLogMountName =
    logOptionRead && typeof logOptionRead === 'object' && typeof logOptionRead.mount === 'string' && logOptionRead.mount
      ? logOptionRead.mount
      : ''
  let clientLog: ClientLogChannel | null =
    logOptionRead && typeof logOptionRead === 'object' && logOptionRead.channel ? logOptionRead.channel : null
  let clientLogOwned = false
  /** 客户端行出口：没有通道就什么都不做（每一处调用点都不必自己判空）。 */
  function logClient(level: string, event: ClientLogEvent, fields: Record<string, unknown>): void {
    const channel = clientLog
    if (!channel) return
    try {
      channel.emit(level, event, fields)
    } catch {
      // 报日志永不外抛：日志坏了不挡面板。
    }
  }
  // ---------- 失败证据（#214）：挂载校验 / 渲染 / 轮询传输 / 全局兜底共用一套字段与去重 ----------
  //
  // 挂载行解决「默认集成下 0 行」：先建通道再校验，五种以上挂载失败各留一行（phase=mount + errorHash）。
  // 渲染/轮询/全局只留指纹：同 phase+kind+errorHash 60 秒内至多一条，风暴进不了日志。
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
  /** 挂载校验失败：先落一行再抛；顺手催一次冲刷（默认集成里这一行往往就是唯一证据）。 */
  function failMount(kind: string, message: string): void {
    emitRenderFail('mount', kind, message)
    // 挂载已失败：先催冲刷，冲完把自建通道收掉——不留 visibilitychange 监听，也不留半条通道。
    const channel = clientLog
    if (!channel) return
    try {
      void Promise.resolve(channel.flush())
        .catch(() => undefined)
        .then(() => {
          if (clientLogOwned) channel.dispose()
        })
    } catch {
      /* 冲刷失败也不影响抛错路径 */
    }
  }
  /** 客户端通道按原因计的丢弃总数（含无法上浮的 no-channel/disposed）：进 copy-diag 计数段。 */
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
  // #214 全局兜底：未捕获异常/未处理拒绝只留阶段 + 指纹，绝不把原话搬上面板或日志。
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
          /* 摘不掉也不挡卸载 */
        }
      }
    }
  }
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
  // 先建通道再校验其余项（#214）：prefix 非法时用默认前缀兜底路由，先把证据送出去，随后照常抛。
  const prefix = options.prefix === undefined ? DEFAULT_PREFIX : options.prefix
  let channelPrefix = DEFAULT_PREFIX
  try {
    buildLogAppendPhoneName(prefix)
    channelPrefix = String(prefix)
  } catch {
    /* prefix 非法：通道先用默认前缀，prefix 校验会如实抛并留一行 */
  }
  // 自建通道（调用方没给、也没明确关掉时）：电话名只从前缀派生，缺 `<prefix>.logAppend` 的老宿主
  // 会在投递时失败 —— 通道自己退避重试后丢弃计数，一个异常都不往上冒。
  if (!clientLog && !clientLogDisabled) {
    try {
      clientLog = createClientLogChannel({ call: options.call, phoneName: buildLogAppendPhoneName(channelPrefix) })
      clientLogOwned = true
    } catch {
      clientLog = null
    }
  }
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
  // 挂载行（常驻）：一次挂载一条；挂载点名字由入口件 / HTTP 直挂 / 批量面板传进来，缺省即摆放形态。
  logClient('info', 'update.panel.mount', { mode: clientLogMountName || mode, theme, lang: currentLang(), pollMs })
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
    removeGlobalHandlers?.()
    removeGlobalHandlers = null
    // 去重窗口只对这面已拆的面板有意义：随它一起清，别把指纹记忆留到下一次挂载。
    renderFailSeen.clear()
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
    if (clientLogOwned && clientLog) {
      try {
        clientLog.dispose()
      } catch {
        // 停不掉也不挡。
      }
    }
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
  parseChangelogReport,
  renderChangelogHTML,
  renderChangelogNeutral,
  renderChangelogSection,
  selectChangelogEntries,
  truncationNoteHTML,
} from './changelog.js'
export type { ChangelogCategory, ChangelogEntry, ChangelogOtherSection, ChangelogParseReport, ChangelogTruncation } from './changelog.js'
