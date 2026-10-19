// src/panel.ts —— 面板公开入口壳（#226：实现拆进 panel/，本文件只做 curated 转出口）。
//
// `dist/panel.js` 是冻结出口（package.json `./panel`，map #220 §5）：路径与导出集一字不动；
// 蓝图 §5 铁律——入口壳只有导出语句、不写逻辑。公开类型完整定义留在这里（不做源码级复用），
// 视图/渲染/挂载/主题/跳过存储/电话名的实现都在 panel/ 里，本文件逐一转出。

export { isCheckSideFailureCode } from './shared/codes.js' // 查侧判定从单点真源派生（#134/US15）
// #174：last-resort 的类型经既有子路径转出，消费者无需新子路径即可命名（`ManualSource` 已出现在本模块导出签名里）。
export type { LastResortKind, RescueRouteKey, ManualSource, LastResortSubject, LastResortInput, LastResortVerdict } from './shared/last-resort.js'

import type { PanelClientLogOptions } from './log/panel-client.js'
import type { DiagCopyFormat } from './panel-copy.js'
import type { UpdateThemeTokens } from './panel/theme.js'
import type { LocaleOption } from './shared/lang.js'

// ---------- 公开类型（完整类型定义：公开入口一律有类型，不做源码级复用） ----------

/** 摆放形态：默认内嵌，切弹窗走同一参数。 */
export type UpdatePanelMode = 'embedded' | 'dialog'

/** 面板主题：默认最小可用样式；`archive` 为档案卷纸面浅色（只换肤，不换 DOM 顺序）。 */
/**
 * 面板主题：`default` 最小可用深色；`archive` 档案卷纸面浅色（原型敲定的案卷风格，只换肤）。
 */
export type UpdatePanelTheme = 'default' | 'archive'

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
export interface UpdatePanelClientLogOptions extends PanelClientLogOptions {}

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
  /**
   * 自动检查（#211 AC-2）：默认开。挂载后先做一次只读状态刷新，再决定要不要自动查一次新版：
   * 首刷失败（拿不到状态）即记 failed 并放弃；状态本身新鲜（安装在跑/校验中，或已有动作在途）即记
   * recent 不重复查；只有真的需要才发起（记 started）。显式传 false 即调用方点名关掉（记 disabled）。
   * 只收布尔值；挂载行的 autoCheck 字段如实记这四种结局（一次挂载一条）。
   */
  autoCheck?: boolean
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
export type { BlockedCopy, DiagCopyFormat, FailureCopy, HealthyDiagCopyInput, PanelDiagnosticInput, TolerantDiag, UpdateDiagCopyInput, UpdaterSelfView } from './panel-copy.js'

// ---------- 实现（#226 拆入 panel/；这里 curated 转出，蓝图 §4） ----------
export { normalizePanelTheme, isSafeThemeCssValue, themeTokensStyleFor } from './panel/theme.js'
export type { UpdateThemeTokens } from './panel/theme.js'
export { createMemorySkipStore, createBrowserSkipStore } from './panel/skip-store.js'
export { panelSealFor, messageCodeOf, panelViewModel, checkPrejudgeOfView } from './panel/view-model.js'
export type { PanelBanner, PanelView, PanelSealTone, PanelSeal, PanelViewInput, CheckPrejudge } from './panel/view-model.js'
export { UPDATE_PANEL_CSS, fallbackBlockedVersionOf, fallbackCauseFromDetail, fallbackCauseFromDiag, lastResortBarHTML, lastResortCopyButtonHTML, copyBubbleHTML, renderUpdatePanelKernel, renderUpdatePanelHTML } from './panel/render.js'
export type { PanelRenderInput } from './panel/render.js'
export { UPDATE_PANEL_ARCHIVE_CSS } from './panel/archive-theme.js'
export { formatLatchTime } from './panel/failure-latch.js'
export type { PanelFailureRef } from './panel/failure-latch.js'
export { pendingAutoCheck, mountUpdatePanel } from './panel/mount.js'

// ---------- 面板侧电话名与轮询口径（与派生工具同一源，不写字面量） ----------

export { buildPanelPhoneNames, buildPanelChangelogPhoneName } from './panel/client.js'
export type { PanelPhoneAction, PanelChangelogPhoneAction } from './panel/client.js'

/** 面板轮询口径（默认 1 秒、下限 250 毫秒，与宿主侧同一套）。 */
export { PANEL_POLL } from './panel/client.js'

// 队列可见性开关的面板侧形状（转出口：面板凭电话可选参数拿视图，用这里再裁剪）。
export {
  QUEUE_INTENT_TTL_MS,
  emptyQueueState,
  normalizeQueueState,
  queuePositionOf,
  isHeadOfQueue,
  isQueueBusy,
  visibleQueueFor,
} from './core/queue/model.js'
export type { QueuedEntry, QueueOwner, UpdateQueueState, VisibleQueue as PanelVisibleQueue, VisibleQueueOwner } from './core/queue/model.js'

// 宿主种类（诊断文本用；取值可增，不认就当普通宿主展示）。
export type { EnvironmentKind as PanelEnvironmentKind } from './shared/ports.js'
export type { UpdateSnapshot as PanelSnapshot } from './shared/ports.js'
export type { BlockedReason as PanelBlockedReason } from './shared/ports.js'

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
  selectChangelogEntries,
} from './core/changelog/parse.js'
export {
  renderChangelogHTML,
  renderChangelogNeutral,
  renderChangelogSection,
  truncationNoteHTML,
} from './core/changelog/render-model.js'
export type {
  ChangelogCategory,
  ChangelogEntry,
  ChangelogOtherSection,
  ChangelogParseReport,
  ChangelogTruncation,
} from './core/changelog/parse.js'
