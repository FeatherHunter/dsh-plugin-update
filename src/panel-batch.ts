// src/panel-batch.ts —— 多目标批量更新的面板组件入口壳（#229 起实现拆入 panel/batch/，行为不变）。
//
//
// 本文件是包入口（package.json exports 的子路径 ./panel-batch）：公开导出集冻结不变。
// 公开类型在这里声明；实现按职责拆在 panel/batch/ 下：
//   helpers.ts —— 行/队列/会话形状归一、回退与失败文案、电话名拼法（被三层共用的最底层）
//   ledger.ts  —— 总账：一句话 + 分类计数 + 每行状态词（纯计算）
//   render.ts  —— 渲染：同一输入 → 同一份只读 HTML（含详情弹窗）
//   styles.ts  —— 批量面板 CSS（默认最小样式 + Archive 皮肤）
//   mount.ts   —— 挂载：轮询、事件、动作与控制器（唯一碰副作用的一层）
// 依赖只向下：mount → render → ledger → helpers；壳只做类型声明与 re-export。
// 归属：面板（浏览器）侧。一趟跑产品真代码：吃 <prefix>.batchStatus 的回包，画
// 「总账 + 明细 + 动作」三层；某一行展开时复用单插件内核（renderUpdatePanelHTML），
// 不为多插件再写一套详情渲染。
//
// 契约（宿主侧按它写，见 src/host-batch.ts）：
//   status/check/install/resume/cancel 五个电话，回包统一形状：
//     { ok: true, session: BatchSession, rows: BatchRowView[], progress: BatchProgress }
//     { ok: false, error, errorKind }
//   面板侧实际打出的五个电话（名字只从 buildBatchPhoneNames 来，不写字面量）：
//     <p>.batchStatus  {}                 挂载即查、按 pollMs 轮询
//     <p>.batchCheck   {}                 「检查更新」
//     <p>.batchInstall {}                 「全部更新」（不点 keys 即「全部提交」语义）
//     <p>.batchInstall { keys: [key] }     行内「安装这家」/「重试」只推这一家
//     <p>.batchResume  {} / <p>.batchCancel {}   「接着上次」/「取消这一批」
//
// 信息架构（第一性：多插件场景用户只问有没有事 / 是哪几家 / 我要做什么）：
//   ① 总账：一句话（有没有事）+ 分类计数（可更新/安装中/待查/待重启/失败/已跳过/已最新）；
//   ② 明细：一行一家（状态灯 + 中文名 + 当前版本 → 远端版本 + 一句可执行的状态词 + 行内动作）；
//   ③ 动作：顶部两件宏（检查更新/全部更新）+ 行内（安装这家/重试/请重启DSH/详情）。
//   一行只回答一个问题：这家的**下一步**是什么。状态词一律中文可执行，不写相位英文。
//   待重启与失败走常驻横幅，不藏进抽屉。
//
// 忙守卫：任一行 installing（或本面板正有一次电话在飞）→「检查更新」「全部更新」一起置灰，
//   与单插件面板同一口径（同一使用范围一次只安装一个，禁止并发提交）。
// 详情：复用单插件内核 renderUpdatePanelHTML（embedded + actions:'none' 只读渲染，内核不画动作按钮）；
//   动作行由批量面板自己出（data-act，与行内同一通道：安装／重试、跳过／恢复、复制手工命令、复制诊断）。
//   内核里残留的 data-action 控件（03 章队列开关不在 actions 缝里）整颗摘掉——详情里绝不留「可点没人接」的死按钮。
//   详情不嵌套滚动（CSS 显式中和 overlay 的 max-height/overflow）。
// 卸载：只停轮询、只拆监听，绝不发安装/取消电话（安装在宿主进程内继续跑）。
//
// 本文件零 Node 专属能力（不读盘、不起进程、不拼 shell）：Node 宿主与浏览器闭包两边都跑得动；
// DOM 只在 mountUpdateBatchPanel 被调用时经容器与 globalThis 现取，模块顶层不碰。

import type { UpdatePanelTheme, UpdateThemeTokens } from './panel.js'
import type { PanelClientLogOptions } from './log/panel-client.js'
import type { ManualSource } from './shared/last-resort.js'

/** 一行要画的东西（宿主回包里的形状）。 */
export interface BatchRowView {
  key: string
  title: string
  /** 会话相位：pending/checking/ready/installing/current/done/failed/skipped（认不出按 pending）。 */
  phase: string
  targetVersion: string | null
  restartRequired: boolean
  error: string | null
  /** 该行的单插件快照（展开详情与「安装这家」按钮的门控都用它）。 */
  snapshot: unknown
  manual?: string | null
  /**
   * 手工命令的可信来源（#177）：`frame` = 与当帧快照同一回包；`carried-over` = 失败回包沿用的旧值
   * （fail-closed：不展示、不给复制、不高亮）。缺省按 `frame` 处理，兼容老调用方。
   */
  manualSource?: ManualSource | null
  queue?: unknown
  profileName?: string | null
  /** 该行的插件标识（跳过存储与诊断文本用；缺省用 key）。宿主侧后补字段，缺了照样跑。 */
  pluginId?: string | null
  /** 该行的诊断详情（宿主给就带上；没有就不带）。 */
  diag?: unknown
  /** 宿主种类（进诊断文本；缺省说人话）。 */
  hostKind?: string | null
  /** 该家单插件三电话的名字（取消排队要用它自己的安装电话；老宿主不给就不给取消入口）。 */
  phoneNames?: unknown
}

/** 摆放形态：默认内嵌，切弹窗走同一参数（与单插件面板同一套写法）。 */
export type BatchPanelMode = 'embedded' | 'dialog'

/** 批量面板的挂载参数。 */
export interface BatchPanelOptions {
  /** 批量电话前缀（与宿主一致）。 */
  prefix: string
  /** 调宿主电话：(phoneName, args) => Promise<reply>。 */
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>
  /** 主题：与单插件面板同一套（缺省 default）。 */
  theme?: UpdatePanelTheme
  /** 主题变量覆盖：见 panel 的 UpdateThemeTokens；批量根 + 展开详情行全继承，不传即零回归。 */
  themeTokens?: UpdateThemeTokens
  /** 摆放形态：内嵌或弹窗（缺省 embedded）。 */
  mode?: BatchPanelMode
  /** 轮询间隔（毫秒，缺省 1500，下限 250）。 */
  pollMs?: number
  /** 可选：键 -> 中文名覆盖。 */
  titles?: Record<string, string>
  /**
   * 「请重启DSH」的落地（与单插件面板同一口径）：不传就只提示手动重启，不假装能重启。
   */
  onRestartRequested?: () => void | Promise<void>
  /** 复制文本的出口（与单插件面板同一口径）：不传即试浏览器剪贴板，都没有也不抛错。 */
  copyText?: (text: string) => void | Promise<void>
  /**
   * 详情行自动取日志（#38）：默认开。展开行有新版时调该行自己的更新日志电话按需取；
   * 老宿主没给行电话名即回中性提示；false 关闭。
   */
  autoChangelog?: boolean
  /**
   * 自动决议合规版（#156 第一性原理）：默认开。行是"最新版被 24 小时年龄门挡住"的失败时，
   * 开面板/刷新后自动逐家问一次可装的最新版；有候选即端上点名确认条，没有即如实说等多久。
   * false 只保留手动入口（[装合规版] 按钮），不自动打这些电话。
   */
  autoCompliant?: boolean
  /**
   * 弹窗关闭的落地（与单插件面板同一口径）：只在 dialog 下点「关闭」/按 Esc 时调用；调用方在此撤掉弹窗 DOM。
   * 不传则回退为只停轮询（unmount），DOM 留给调用方处理。入口件打开的 dialog 已内置（收 dialog + 还原按钮）。
   */
  onCloseRequested?: () => void | Promise<void>
  /**
   * 语言覆盖（#59 起消费：新文案走集中字典单语渲染；既有散落文案保持基线不变）。
   * 形态与入口件一致：'zh' | 'en' | { getActive(): string; subscribe?(cb): () => void }。
   */
  locale?: unknown
  /**
   * 打开面板自动查（#59 D3）：缺省 true。false 即手动挡（行为回今天，只修文案）。
   * 优先级：用户偏好（prefs.json）> 本选项 > 缺省。
   */
  checkOnOpen?: boolean
  /**
   * 自动继续未终态轮次（#59 Q3：与显式按钮并存，常开）。false 可关（测试与特殊集成用）。
   */
  autoResume?: boolean
  /**
   * 客户端日志通道（#208，复用 #214 单面板同一接触面）：批量面板把挂载/动作/渲染失败/全局兜底
   * 四类行交给这里。传 channel 即用调用方通道、不自建不销毁；传 { channel: null } 完全关闭；
   * 不传则自建 owned 通道（电话名 <prefix>.logAppend，卸载时销毁）。
   * mount 只覆盖 update.panel.mount 行里的 mode 名（入口件传 'batch'），不改面板摆放形态。
   */
  clientLog?: PanelClientLogOptions | null
}

/** 面板可点的动作（HTML 上 data-act 一一对应；测试走同一条路）。 */
export type BatchPanelActionKind =
  | 'check'
  | 'install'
  | 'resume'
  | 'cancel'
  | 'row-install'
  | 'row-check'
  | 'row-skip'
  | 'row-resume-skip'
  | 'row-cancel-queue'
  | 'row-copy-manual'
  | 'row-copy-diag'
  | 'copy-all-diag'
  | 'copy-all-manual'
  | 'row-fallback'
  | 'row-fallback-confirm'
  | 'batch-fallback-scan'
  | 'batch-fallback-confirm'
  | 'toggle-details'
  | 'detail-close'
  | 'restart'
  | 'close'
  | 'toggle-check-on-open'

/** 挂载点：只要有 innerHTML 的容器即可（浏览器元素或测试替身都行）。 */
export interface BatchPanelContainer {
  innerHTML: string
  addEventListener?: (type: string, listener: (ev: unknown) => void) => void
  removeEventListener?: (type: string, listener: (ev: unknown) => void) => void
}

/** 批量面板控制器（与契约桩同名同义；act 多收一个可选 key，供行内动作指认某一家）。 */
export interface BatchPanelController {
  refresh(): Promise<void>
  act(action: BatchPanelActionKind, key?: string): Promise<void>
  setTheme(theme: UpdatePanelTheme): void
  /** 换一套主题变量（重绘；传 undefined 即清掉覆盖，回主题默认）。 */
  setThemeTokens(tokens: UpdateThemeTokens | undefined): void
  setMode(mode: BatchPanelMode): void
  unmount(): void
}

/**
 * 面板侧实际打的七个批量电话名。
 *
 * 宿主侧 `./batch` 的 `MultiHostUpdate.phoneNames`（`BatchHostPhoneNames`）**多登记一个可选 `logAppend`**：
 * 只有宿主知道属主插件的日志口，面板自建日志通道要打那个电话名。两份类型故意不同名
 * （同名导出会经不同子路径发布，消费者同时 import 会撞名）。
 */
export interface BatchPhoneNames {
  status: string
  check: string
  install: string
  resume: string
  cancel: string
  prefs: string
  prefsSave: string
}

export { BATCH_PANEL_POLL, batchFailedRows, batchFallbackCauseOf, buildBatchPhoneNames, compliantInstalledOf, singleFallbackPhoneOf } from './panel/batch/helpers.js'
export type { BatchKnowledgeEntry, BatchLedgerCounts, BatchRowVersionParts } from './panel/batch/ledger.js'
export { batchLedgerCounts, batchLedgerText, batchQueuedStatus, batchRowKnowledgeText, batchRowPendingStatus, batchRowStatus, batchRowVersionParts, hasUnfinishedRows, unfinishedCount } from './panel/batch/ledger.js'
export type { BatchPanelRenderInput } from './panel/batch/render.js'
export { batchFailedManualText, renderBatchPanelHTML } from './panel/batch/render.js'
export { UPDATE_BATCH_PANEL_ARCHIVE_CSS, UPDATE_BATCH_PANEL_CSS } from './panel/batch/styles.js'
export { batchFailedDiagText, fallbackOutcomeOf, mountUpdateBatchPanel, singleInstallPhoneOf } from './panel/batch/mount.js'
