// src/panel-batch.ts —— 多目标批量更新的面板组件（#25）。
//
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

import { assertPrefix, MIN_PANEL_POLL_MS } from './config.js'
import { copyText as bilingualText, type BilingualKey } from './bilingual.js'
import {
  manualAbsentReasonOf,
  manualAbsentReasonTextOf,
  manualAbsentTextOf,
  type ManualAbsentReason,
} from './manual-absent.js'
import { normalizeLangTag, resolveLang, subscribeLang, type AppLang, type LocaleOption } from './lang.js'
import { compareReleaseVersions, validReleaseVersion } from './service.js'
import { shouldFetchChangelog } from './changelog.js'
import {
  isTerminalPhase,
  normalizeBatchSession,
  type BatchPhase,
  type BatchSession,
} from './batch.js'
import {
  UPDATE_PANEL_CSS,
  UPDATE_PANEL_ARCHIVE_CSS,
  buildDiagnosticText,
  createBrowserSkipStore,
  failureCopy,
  fallbackCauseFromDetail,
  fallbackCauseFromDiag,
  isCheckSideFailureCode,
  isKnownFailureCode,
  normalizePanelTheme,
  readDiagTolerant,
  renderUpdatePanelHTML,
  themeTokensStyleFor,
  type PanelDiagnosticInput,
  type PanelSkipStore,
  type UpdatePanelTheme,
  type UpdateThemeTokens,
} from './panel.js'
import { formatUnlockAt } from './install-cause.js'
import type { UpdateSnapshot } from './ports.js'
import type { VisibleQueue } from './queue.js'

// ---------- 公开类型 ----------

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

/** 批量七个电话名（与宿主侧 MultiHostUpdate.phoneNames 同一形状）。 */
export interface BatchPhoneNames {
  status: string
  check: string
  install: string
  resume: string
  cancel: string
  prefs: string
  prefsSave: string
}

/** 批量面板轮询口径（默认 1.5 秒、下限 250 毫秒，与单插件面板同一套下限）。 */
export const BATCH_PANEL_POLL = {
  defaultMs: 1500,
  minMs: MIN_PANEL_POLL_MS,
} as const

/** 批量电话名拼法：前缀 + 七个固定动作名（前缀形状校验与单插件面板同一套）。 */
export function buildBatchPhoneNames(prefix: string): BatchPhoneNames {
  const p = assertPrefix(prefix, '批量电话前缀 prefix')
  return {
    status: p + '.batchStatus',
    check: p + '.batchCheck',
    install: p + '.batchInstall',
    resume: p + '.batchResume',
    cancel: p + '.batchCancel',
    prefs: p + '.batchPrefs',
    prefsSave: p + '.batchPrefsSave',
  }
}

// ---------- 总账（一句话 + 分类计数：面板与门禁共用同一份口径） ----------

export interface BatchLedgerCounts {
  /** phase=ready：有新版、还没安装。 */
  updatable: number
  /** phase=installing：正在安装。 */
  installing: number
  /** phase=pending/checking：还没轮到/正在查。 */
  pending: number
  /** 安装好了但要重启宿主才生效（终态之外的一档，单独数）。 */
  restart: number
  /** #190：待重启里插件未登记的部分——重启宿主也不会加载，总账不许说满「生效」。 */
  restartUnregistered: number
  /** phase=failed。 */
  failed: number
  /** phase=skipped。 */
  skipped: number
  /** phase=current/done 且不用重启：真的没事了。 */
  settled: number
}

/**
 * #190：记一档「待重启」。插件未登记的行单独计数（重启也不会加载），总账才不把话说满。
 */
function noteRestart(counts: BatchLedgerCounts, row: BatchRowView): void {
  if (restartUnregistered(row)) counts.restartUnregistered += 1
  else counts.restart += 1
}

/**
 * 从行上数分类账（每行恰好进一档，八档之和 === 行数）：
 * 失败优先（失败行永远算失败，不算待重启）；其余按相位落档；不用重启的终态才算「已最新」。
 * #190：待重启按在册事实再拆一档（restartUnregistered），总账才不把「重启后生效」说满。
 * 例外一处：「忙失败占位」（phase=failed 但 error=update-busy）其实是**排队**不是失败——
 * 宿主忙时先写占位再回 update-busy，面板把它翻回「可更新」，免得总账把它报成失败。
 * 无轮次 pending 行看知识（#73 口径 = #82 报告 §6 推荐 A），条件与行展示同一处（isInUnfinishedRound）：
 * 有新版进可更新、已是最新进已最新、没有结果（无知识 / 查失败）仍待查；
 * checking 行与「有没做完一轮」的行永远走执行态（待查），都不吃知识。
 * 终态 current / 无重启 done 行看世界账（#90 世界账与轮次账分家）：知识更新鲜且确有新版即进可更新，
 * 否则沿旧结论（已最新），免得陈旧知识或失败的检查翻转已收尾的轮次。
 * 不传 inventory 即无知识；不传 session 即当无轮次（旧调用零回归）。
 */
export function batchLedgerCounts(
  rows: readonly BatchRowView[],
  inventory?: unknown,
  session?: unknown,
  compliantDone?: ReadonlyMap<string, boolean> | null,
): BatchLedgerCounts {
  const counts: BatchLedgerCounts = {
    updatable: 0,
    installing: 0,
    pending: 0,
    restart: 0,
    restartUnregistered: 0,
    failed: 0,
    skipped: 0,
    settled: 0,
  }
  for (const row of rows) {
    const phase = asBatchPhase(row.phase)
    // 例外之三（#156 收尾事实，用户 2026-10-17 裁决）：账本目标没装成、但这家已经装上「能装的最新」
    // （job 落定、installedVersion === job.targetVersion ≠ 账本目标）——相位一个字不改（目标版确实没
    // 装上），可总账、hint 与印章不许再报「安装失败」：要重启的进「待重启」，不用重启的进「已最新」。
    // 传进来的值 = 这一行要不要重启（收尾事实的 needsRestart）；不传即零回归。
    const doneRestart = phase === 'failed' ? compliantDone?.get(row.key) : undefined
    if (doneRestart !== undefined) {
      if (doneRestart) noteRestart(counts, row)
      else counts.settled += 1
    } else if (isQueueBusyRow(row)) counts.updatable += 1
    else if (phase === 'failed') {
      // 例外之二（#156 M1）：「等重启」行（phase=failed 但 error=pending-restart）其实是磁盘上
      // 已经有更新版、只差重启生效——账本相位一个字不改（目标版确实没装上），但总账与 hint
      // 把它记进「待重启」那一档，免得报成「N 个插件安装失败」冤枉它。
      if (row.error === 'pending-restart') noteRestart(counts, row)
      else counts.failed += 1
    }
    else if (phase === 'installing') counts.installing += 1
    else if (phase === 'ready') counts.updatable += 1
    else if (phase === 'pending')
      counts[isInUnfinishedRound(session, row.key) ? 'pending' : ledgerKnowledgeBucket(knowledgeEntryOf(inventory, row.key))] += 1
    else if (phase === 'checking') counts.pending += 1
    else if (phase === 'skipped') counts.skipped += 1
    else if (row.restartRequired === true) noteRestart(counts, row)
    else counts[worldUpdateVersion(row, knowledgeEntryOf(inventory, row.key), sessionUpdatedAtOf(session, row.key)) ? 'updatable' : 'settled'] += 1
  }
  return counts
}

/**
 * pending 行的知识档位（#73）：知识只回答三件事，档位与行文案同义——
 * 有新版 → 可更新（行「有新版 x」）、已是最新 → 已最新（行「已是最新，不用动」）、
 * 没有结果（无知识 / 这次没查到）→ 待查（行「还没查过」/「这次没查到」）。
 * 查失败**不是**安装失败：failed 档的文案与横幅讲的是安装失败，知识不许冒充它。
 * checking 行与在轮行不走这里（永远执行态）。
 */
function ledgerKnowledgeBucket(entry: BatchKnowledgeEntry | null): keyof BatchLedgerCounts {
  const verdict = knowledgeVerdictOf(entry)
  if (verdict === 'update') return 'updatable'
  if (verdict === 'current') return 'settled'
  return 'pending'
}

/** 分类计数 → 一句话总账（只出现非零档，顺序固定：可更新 · 安装中 · 待查 · 待重启 · 未登记 · 失败 · 已跳过 · 已最新；#64 单语：缺省 zh 零回归）。 */
export function batchLedgerText(counts: BatchLedgerCounts, lang?: unknown): string {
  const l = langOf(lang)
  const parts: string[] = []
  if (counts.updatable > 0) parts.push(batchText('batch.summary.updatable', l, { n: String(counts.updatable) }))
  if (counts.installing > 0) parts.push(batchText('batch.summary.installing', l, { n: String(counts.installing) }))
  if (counts.pending > 0) parts.push(batchText('batch.summary.pending', l, { n: String(counts.pending) }))
  if (counts.restart > 0) parts.push(batchText('batch.summary.restart', l, { n: String(counts.restart) }))
  if (counts.restartUnregistered > 0) parts.push(batchText('batch.summary.restart-unregistered', l, { n: String(counts.restartUnregistered) }))
  if (counts.failed > 0) parts.push(batchText('batch.summary.failed', l, { n: String(counts.failed) }))
  if (counts.skipped > 0) parts.push(batchText('batch.summary.skipped', l, { n: String(counts.skipped) }))
  if (counts.settled > 0) parts.push(batchText('batch.summary.settled', l, { n: String(counts.settled) }))
  return parts.length > 0 ? parts.join(' · ') : batchText('batch.summary.empty', l)
}

/**
 * 排队中的状态词：只回答「还要等多久」。位置从该行的队列视图来。
 * queue.ts 的 position 是 waiting 顺位（队首为 1、0 = 自己正在装），而正在装的那一家也压在这一家前面，
 * 所以「前方 N 个」= position N（队首那家前方正好 1 个：正在装的拥有者）。
 * 位置取不到（宿主只记了忙、没给占位读数）就说「等前面安装完」，不猜数字。
 */
export function batchQueuedStatus(position: number | null, lang?: unknown): string {
  const l = langOf(lang)
  if (typeof position !== 'number' || !Number.isFinite(position) || position < 1) return batchText('batch.row.queued-generic', l)
  return batchText('batch.row.queued-n', l, { n: String(position) })
}

/** 知识账本里的一行（只做展示，不参与安装决策）。 */
export interface BatchKnowledgeEntry {
  lastCheckedAt: number
  /** 在场事实（与行内快照同步；老账本缺省即 null，按未知处理）。 */
  installed: boolean | null
  installedVersion: string | null
  latestVersion: string | null
  canInstall: boolean | null
  error: string | null
}

function knowledgeEntryOf(inventory: unknown, key: string): BatchKnowledgeEntry | null {
  if (!isObject(inventory)) return null
  const entries = (inventory as Record<string, unknown>)['entries']
  if (!isObject(entries)) return null
  const item = (entries as Record<string, unknown>)[key]
  if (!isObject(item)) return null
  const e = item as Record<string, unknown>
  const canInstallRaw = e['canInstall']
  const installedRaw = e['installed']
  return {
    lastCheckedAt: typeof e['lastCheckedAt'] === 'number' ? (e['lastCheckedAt'] as number) : 0,
    installed: typeof installedRaw === 'boolean' ? (installedRaw as boolean) : null,
    installedVersion: typeof e['installedVersion'] === 'string' ? (e['installedVersion'] as string) : null,
    latestVersion: typeof e['latestVersion'] === 'string' ? (e['latestVersion'] as string) : null,
    canInstall: typeof canInstallRaw === 'boolean' ? canInstallRaw : null,
    error: typeof e['error'] === 'string' ? (e['error'] as string) : null,
  }
}

/**
 * 无轮次 pending 行的知识判定——**唯一出处**：行文案（batchRowKnowledgeText）与总账档位
 * （ledgerKnowledgeBucket）都从它推，别再各写一份四态（#82 §7 改动点 2「行循环的 knowledge 计算
 * 应与计数共用同一判定，避免两处分叉」；上一版就是两处手抄，改一处必漏另一处）。
 * 四种结果与 ADR-0003 §2 的四种行状态一一对应：update=有新版、current=已是最新、
 * failed=这次没查到（查失败≠安装失败，它的"结果"就是没有结果）、never=还没查过/没知识。
 * 查过但无版本（#90 R5：未知永不坍缩为已是最新）亦判 never，不判 current。
 */
type BatchKnowledgeVerdict = 'update' | 'current' | 'failed' | 'never'

function knowledgeVerdictOf(entry: BatchKnowledgeEntry | null): BatchKnowledgeVerdict {
  if (!entry) return 'never'
  if (entry.error) return 'failed'
  if (entry.latestVersion && entry.installedVersion) return entry.latestVersion !== entry.installedVersion ? 'update' : 'current'
  if (entry.latestVersion && !entry.installedVersion) return 'update'
  return 'never'
}

function langOf(lang: unknown): AppLang {
  try {
    return normalizeLangTag(typeof lang === 'string' ? lang : resolveLang(lang as LocaleOption))
  } catch {
    return 'zh'
  }
}

function batchText(key: BilingualKey, lang: unknown, values?: Record<string, unknown>): string {
  try {
    return bilingualText(key, langOf(lang), values)
  } catch {
    return ''
  }
}

/**
 * 会话里的条目（宽容读：没有会话/没有 entries 数组就给 null，调用方各自处理）。
 * 会话只在这一处读——原先三处各手写一遍同样形状的遍历（#73 code-review 收敛）。
 */
function sessionEntriesOf(session: unknown): readonly Record<string, unknown>[] | null {
  if (!isObject(session)) return null
  const entries = (session as Record<string, unknown>)['entries']
  if (!Array.isArray(entries)) return null
  return entries.filter((item): item is Record<string, unknown> => isObject(item))
}

/** 条目相位（宽容读：认不出的字符串按 pending；压根不是字符串即没读到，与旧口径一致）。 */
function entryPhaseOf(entry: Record<string, unknown>): BatchPhase | null {
  const phase = entry['phase']
  return typeof phase === 'string' ? asBatchPhase(phase) : null
}

/** 条目是不是「没做完」的那一行（相位非终态）。 */
function isUnfinishedEntry(entry: Record<string, unknown>): boolean {
  const phase = entryPhaseOf(entry)
  return phase !== null && !isTerminalPhase(phase)
}

/**
 * 这一家是否在「没做完的一轮」里：会话里该家**任一条目**非终态即算。
 * 总账与行展示共用这一处判定（#82 §6 细则 3 与 §7 测试 4「有轮次未做完仍走执行态」、ADR-0003 §2）：
 * 在轮行不吃知识、不按知识落档，免得同一屏一边说执行态一边报知识。
 * 与 hasUnfinishedRows/unfinishedCount 同一份读法：坏会话一律按执行态读——
 * 控制区说「有没做完的一轮」，行与总账就不许改口说知识。
 */
function isInUnfinishedRound(session: unknown, key: string): boolean {
  const entries = sessionEntriesOf(session)
  if (entries === null) return false
  return entries.some((entry) => entry['key'] === key && isUnfinishedEntry(entry))
}

/** 会话里该行的 updatedAt（没有会话/没有该行即 null，调用方按无历史处理）。 */
function sessionUpdatedAtOf(session: unknown, key: string): number | null {
  const entries = sessionEntriesOf(session)
  if (entries === null) return null
  for (const entry of entries) {
    if (entry['key'] !== key) continue
    const at = entry['updatedAt']
    if (typeof at === 'number' && Number.isFinite(at)) return at
  }
  return null
}

/**
 * 世界账推翻（#90 R1：世界账与轮次账分家）。终态 current / 无重启 done 行，若知识更新鲜
 * （lastCheckedAt > 会话行 updatedAt）且与实时快照比对确有新版，回新版本号；否则回 null。
 * 失败的检查（entry.error）永不推翻——旧结论保留；无会话历史（null）即按知识直判。
 */
function worldUpdateVersion(
  row: BatchRowView,
  knowledge: BatchKnowledgeEntry | null,
  sessionUpdatedAt: number | null,
): string | null {
  const phase = asBatchPhase(row.phase)
  if (phase !== 'current' && !(phase === 'done' && row.restartRequired !== true)) return null
  if (!knowledge || knowledge.error) return null
  if (sessionUpdatedAt !== null && !(knowledge.lastCheckedAt > sessionUpdatedAt)) return null
  const parts = batchRowVersionParts(row, knowledge)
  return parts.hasUpdate && parts.latest ? parts.latest : null
}

/**
 * 有未终态行（控制区出现条件：盘上有没做完的一轮，#85）。
 * 只认盘上会话：无会话（还没读到状态、或老宿主根本没带 session）一律按「没有」处理，
 * 面板只渲染不推导——行相位（ledger）不可作判据（#82），否则无会话时也会画出续跑按钮，
 * 点下去命中空账本分支，报一句空话成功。rows 参数保留（调用形状不变），仅作兼容不参与判定。
 */
export function hasUnfinishedRows(rows: readonly BatchRowView[], session?: unknown): boolean {
  void rows
  const entries = sessionEntriesOf(session)
  if (entries === null) return false
  return entries.some(isUnfinishedEntry)
}

/** 未终态行数（续跑按钮里的计数与回执共用；与 hasUnfinishedRows 同一口径：只认盘上会话，#85）。 */
export function unfinishedCount(rows: readonly BatchRowView[], session?: unknown): number {
  void rows
  const entries = sessionEntriesOf(session)
  if (entries === null) return 0
  return entries.filter(isUnfinishedEntry).length
}

/**
 * #190：这一行装完了但插件未登记在使用范围清单（快照 `registered === false`）——重启宿主也不会
 * 加载，「重启后生效」这类话不许说满。读不到快照/未知一律按已登记处理（不吓人、不冒充事实）。
 */
function restartUnregistered(row: BatchRowView): boolean {
  const snapshot = row.snapshot as { registered?: unknown } | null | undefined
  return !!snapshot && typeof snapshot === 'object' && snapshot.registered === false
}

/**
 * 一行的状态词：只回答一个问题——这家的**下一步**是什么。
 * 中文可执行，不写相位英文（相位只留在 data-phase 属性上，给人看的这句永远是动作）。
 * （#59 D2：调用方在无轮次 + 有知识时优先用 batchRowKnowledgeText；本函数语义冻结，旧快照不动。）
 */
export function batchRowStatus(row: BatchRowView, skippedVersion?: string | null, lang?: unknown): string {
  const l = langOf(lang)
  const skipped = typeof skippedVersion === 'string' && skippedVersion ? skippedVersion : null
  if (skipped !== null && asBatchPhase(row.phase) === 'ready') return batchText('batch.row.skipped', l, { version: skipped })
  switch (asBatchPhase(row.phase)) {
    case 'pending':
      return batchText('batch.row.wait-turn', l)
    case 'checking':
      return batchText('batch.row.checking', l)
    case 'ready':
      return row.targetVersion
      ? batchText('batch.row.cta-version', l, { version: row.targetVersion })
      : batchText('batch.row.cta-generic', l)
    case 'installing':
      return batchText('batch.row.installing', l)
    case 'current':
      return batchText('batch.row.current', l)
    case 'done':
      if (row.restartRequired !== true) return batchText('batch.row.done', l)
      // #190：装完但未登记——重启宿主也不会加载，状态词不许说满。
      return restartUnregistered(row) ? batchText('batch.row.done-restart-unregistered', l) : batchText('batch.row.done-restart', l)
    case 'failed': {
      // 查/装分家（#134/US15）：行上失败码属查侧说「本次未能查询」，属装侧才说安装失败。
      // 无码回退装侧（旧口径，旧快照不动）；pending/知识路由（#59 D2）一字不动。
      const fail = jobFailureOf(row)
      const code = fail?.code ?? (typeof row.error === 'string' && row.error ? row.error : null)
      return isCheckSideFailureCode(code) ? batchText('batch.row.failed', l) : batchText('batch.row.failed-retry', l)
    }
    case 'skipped':
      return batchText('batch.row.skipped-idle', l)
    default:
      return batchText('batch.row.unknown', l)
  }
}

/**
 * 无轮次时的知识行（#59 D2）：pending + 有知识即按知识展示；有轮次未做完仍走执行态。
 * 无知识（从没查过）回 null，调用方回退旧 pending 文案。
 */
export function batchRowKnowledgeText(row: BatchRowView, entry: BatchKnowledgeEntry | null, lang?: unknown): string | null {
  if (asBatchPhase(row.phase) !== 'pending' || !entry) return null
  const verdict = knowledgeVerdictOf(entry)
  if (verdict === 'update' && entry.latestVersion) return batchText('batch.row.update', lang, { version: entry.latestVersion })
  if (verdict === 'current') return batchText('batch.row.current', lang)
  if (verdict === 'failed') return batchText('batch.row.failed', lang)
  return batchText('batch.row.never', lang)
}

/**
 * 一行的版本展示（#71 Q3：永远显示当前版；有新版才 `当前 → 最新`）。
 * latest 只做展示，不参与安装决策：会话目标版优先（安装语义），无会话目标时才看知识最新版。
 * - 会话有目标版：current（快照运行版优先）→ 会话目标（current 缺失时占位 `?`，与旧口径一致）。
 * - 会话无目标：current（快照优先，缺失退知识 installedVersion）→ 知识 latest（比当前新即 →；相等即已是最新，只显当前；倒挂（latest 更老）同样只显当前，降级不许当更新画（#152）；current 缺失而 latest 有即 `? → latest` 红，与会话缺当前同例）。
 * - 两者皆无：current 为 null、latest 为 null、hasUpdate 为 false（调用方不画版本 span）。
 */
export interface BatchRowVersionParts {
  current: string | null
  latest: string | null
  hasUpdate: boolean
}

export function batchRowVersionParts(row: BatchRowView, knowledge: BatchKnowledgeEntry | null): BatchRowVersionParts {
  const sessionTarget = typeof row.targetVersion === 'string' && row.targetVersion ? row.targetVersion : null
  if (sessionTarget) {
    const current = currentVersionOf(row)
    if (current === null) return { current: null, latest: sessionTarget, hasUpdate: true }
    if (current === sessionTarget || !isUpgradeOf(sessionTarget, current)) {
      // 倒挂永不画成更新（#152）：陈旧会话目标比当前还老时（昨日 0.3.55 配今日 0.3.60），
      // 只显当前，不画箭头——降级不是新版本。
      return { current, latest: null, hasUpdate: false }
    }
    return { current, latest: sessionTarget, hasUpdate: true }
  }
  const snapshotCurrent = currentVersionOf(row)
  // 缺席时知识账本的 installedVersion 恒为 null（宿主侧不再回退运行版号），此处再加 presence 门，
  // 旧账本里的假版号也到不了版本列（#134/US19）。
  const knowledgeCurrent = knowledge && knowledge.installed !== false && typeof knowledge.installedVersion === 'string' && knowledge.installedVersion ? knowledge.installedVersion : null
  const current = snapshotCurrent ?? knowledgeCurrent
  const latest = knowledge && typeof knowledge.latestVersion === 'string' && knowledge.latestVersion ? knowledge.latestVersion : null
  if (current && latest && latest !== current && isUpgradeOf(latest, current)) return { current, latest, hasUpdate: true }
  if (current) return { current, latest: null, hasUpdate: false }
  if (latest) return { current: null, latest, hasUpdate: true }
  return { current: null, latest: null, hasUpdate: false }
}

/**
 * 目标版是不是比当前版新（#152 倒挂守卫）。
 * 比不出（非法版号）就不拦展示：宁可多画一句，不可在渲染层误藏一次更新；抛错永不漏到调用方。
 */
function isUpgradeOf(target: string, current: string): boolean {
  try {
    return compareReleaseVersions(target, current) === 1
  } catch {
    return true
  }
}

/**
 * 版本列 HTML（#71 Q1 修订为状态跟随：装好绿、未装红；老版本弱化、箭头中性不变）。
 * 有新版：`<cur> → <new>` 三段式（new 加粗 + 专用 token：`done` 行走绿 `newOkText`，其余行走红 `newText`）；
 * 无新版：只显当前；皆无：空串（调用方不画 span）。红绿之外 `→` + 加粗 + 状态词保留为非颜色信号。
 */
function batchRowVersionHTML(row: BatchRowView, knowledge: BatchKnowledgeEntry | null, lang?: unknown): string {
  const parts = batchRowVersionParts(row, knowledge)
  if (parts.hasUpdate && parts.latest) {
    // 缺席时左值不许是哨兵 `?` 更不许是假版号（#134/US1）：说人话「未安装」。
    const snapshot = isObject(row.snapshot) ? row.snapshot : null
    const cur = parts.current ?? (snapshot !== null && snapshot['installed'] === false ? batchText('batch.row.not-installed', lang) : '?')
    const newCls = asBatchPhase(row.phase) === 'done' ? 'dsh-upd-bver-new-ok' : 'dsh-upd-bver-new'
    return '<span class="dsh-upd-bver"><span class="dsh-upd-bver-cur">' + escapeHtml(cur) + '</span><span class="dsh-upd-bver-arrow" aria-hidden="true"> → </span><span class="' + newCls + '">' + escapeHtml(parts.latest) + '</span></span>'
  }
  if (parts.current) return '<span class="dsh-upd-bver">' + escapeHtml(parts.current) + '</span>'
  return ''
}

/**
 * 无轮次 pending 行的状态词（#71 Q3 四态：有新版 / 已是最新 / 还没查过 / 查失败）。
 * 有知识走知识分支；无知识（inventory 缺失或该家无条目）回「还没查过」，不再误显示 wait-turn。
 * 有轮次未做完（inRound）仍走执行态，由调用方按旧口径显示 wait-turn + 未终态标记。
 */
export function batchRowPendingStatus(row: BatchRowView, knowledge: BatchKnowledgeEntry | null, lang?: unknown): string | null {
  if (asBatchPhase(row.phase) !== 'pending') return null
  const known = batchRowKnowledgeText(row, knowledge, lang)
  if (known !== null) return known
  if (!knowledge) return batchText('batch.row.never', lang)
  return null
}

// ---------- 渲染（纯函数：同一输入 → 同一份 HTML） ----------

export interface BatchPanelRenderInput {
  rows?: readonly BatchRowView[]
  theme?: UpdatePanelTheme
  /** 主题变量覆盖：见 panel 的 UpdateThemeTokens；写到批量根上，详情行经继承生效。 */
  themeTokens?: UpdateThemeTokens
  mode?: BatchPanelMode
  /** 当前展开的那一家（键）；null 即全部收起。 */
  expandedKey?: string | null
  /** 批量电话本身失败的稳定码（ok:false 或抛错）。 */
  lastError?: string | null
  /** 本地提示（重启入口、取消结果之类）。 */
  notice?: string | null
  /** 面板正有一次电话在飞（本地忙守卫的一半）。 */
  inFlight?: boolean
  /** 「取消这一批」已点过一次：按钮换确认文案，再点一次才真取消（防误触）。 */
  confirmCancel?: boolean
  /** 是否已经拿到过第一次回包（决定总账那句是不是「正在读取…」）。 */
  loaded?: boolean
  titles?: Record<string, string>
  /** 键 -> 该家被跳过的版本（挂载侧从跳过存储读出；纯渲染函数不读存储）。 */
  skippedVersions?: Record<string, string | null>
  /** notice 归哪一家：等于某行键时那条回执画在该家详情里（否则画在面板底部）。 */
  noticeKey?: string | null
  /** 键 -> 该行已取到的日志全文（只传有文本的；取不到与没展开即中性提示，不挡安装）。 */
  changelogs?: Record<string, string | null>
  /** 轮次会话（有未终态行才画控制区，并决定在轮的行与总账吃不吃知识；不传按行相位回退旧口径，兼容旧快照）。 */
  session?: unknown
  /** 知识账本（无轮次时行按知识展示；只做展示，不参与安装决策）。 */
  inventory?: unknown
  /** 偏好（底部勾选的受控状态；不传不画勾选）。 */
  prefs?: unknown
  /** 语言（单语渲染新文案用；不传跟随全局信号）。 */
  lang?: unknown
  /** 键 -> 该行已决议出的候选（#156；目标对不上当前远端版即视为旧决议，渲染时忽略）。 */
  fallbackOffers?: Record<string, { candidate: string; targetVersion: string } | null>
  /** 正在决议中的那一行（键；在途短暂置灰，防连点）。 */
  fallbackBusyKey?: string | null
  /** 批量级合规版入口（#156）：被年龄门挡住的行数、决议出的点名清单与在途态，外加"等解封"与解封时刻记忆。 */
  compliant?: {
    gated: number
    confirmList: string | null
    confirmCount: number
    busy: boolean
    wait?: { keys: readonly string[]; unlockAtMs: number | null } | null
    unlocks?: Record<string, number | null> | null
  } | null
}

interface RowRenderContext {
  expanded: boolean
  /** 有人正在装（别家）：本行按钮文案换「加入队列」，但不置灰。 */
  busy: boolean
  /** 本面板正有一次电话在飞：行内动作短暂置灰，防连点。 */
  inFlight: boolean
  theme: UpdatePanelTheme
  themeTokens: UpdateThemeTokens | undefined
  titles: Record<string, string>
  /** 这一家被跳过的版本（null = 没跳过）。 */
  skipped: string | null
  /** 展开时挂在详情里的那条回执（复制/跳过之类）；不展开不画。 */
  notice: string | null
  /** 该行已取到的日志全文（null 即中性提示）。 */
  changelogMarkdown: string | null
  /** 单语（新文案渲染用）。 */
  lang: AppLang
  /** 该行的知识条目（在轮行恒为 null，不吃知识；其余行按知识展示/推翻）。 */
  knowledge: BatchKnowledgeEntry | null
  /** 该行是否在没做完的一轮里（轮次事实小标记用，不改写下一步）。 */
  inRound: boolean
  /** 世界账推翻出的新版本号（#90：终态行被更新鲜的知识推翻时非 null，状态词与圆点同它走）。 */
  worldLatest: string | null
  /** 该行已决议出的候选（#156；有即二次确认态，无即首问态；旧决议由调用方过滤）。 */
  fallbackCandidate: string | null
  /** 该行是否正在决议在途（短暂置灰，防连点）。 */
  fallbackBusy: boolean
  /** 该行已决议、此刻确实没有可装版（等解封）：不画按钮，免得点了也没用（#156 诚实性）。 */
  fallbackWaiting: boolean
}

/** 整面板 HTML（含样式；重绘即整体替换 innerHTML，故每次都带 style 也只留一份）。 */
export function renderBatchPanelHTML(input: BatchPanelRenderInput): string {
  const rows: readonly BatchRowView[] = Array.isArray(input.rows) ? input.rows : []
  const theme: UpdatePanelTheme = normalizePanelTheme(input.theme)
  const mode: BatchPanelMode = input.mode === 'dialog' ? 'dialog' : 'embedded'
  const titles = input.titles && typeof input.titles === 'object' ? input.titles : {}
  const skippedVersions =
    input.skippedVersions && typeof input.skippedVersions === 'object' ? input.skippedVersions : {}
  const expandedKey = typeof input.expandedKey === 'string' && input.expandedKey ? input.expandedKey : null
  const lastError = typeof input.lastError === 'string' && input.lastError ? input.lastError : null
  const loaded = input.loaded === undefined ? rows.length > 0 : input.loaded === true
  // 每行自算一次「收尾事实」（纯函数），同一份喂给总账、hint、印章与横幅：一处算两处用，免得说法打架。
  const compliantFacts = new Map<string, { version: string; target: string; needsRestart: boolean }>()
  for (const row of rows) {
    const fact = compliantInstalledOf(row)
    if (fact) compliantFacts.set(row.key, fact)
  }
  const compliantDone = new Map<string, boolean>()
  for (const [key, fact] of compliantFacts) compliantDone.set(key, fact.needsRestart)
  const counts = batchLedgerCounts(rows, input.inventory, input.session, compliantDone)
  // 忙分两种：installing = 有人正在装（决定「加入队列」文案）；macroBusy = 再加本地电话在飞（决定宏按钮置灰）。
  const installing = counts.installing > 0
  const macroBusy = input.inFlight === true || installing
  const total = rows.length
  const disabled = macroBusy ? ' disabled' : ''
  const notice = typeof input.notice === 'string' && input.notice ? input.notice : null
  const noticeKey = typeof input.noticeKey === 'string' && input.noticeKey ? input.noticeKey : null
  // 回执挂在该家详情里（那家正展开才算数）；否则落回面板底部那条。
  const detailNoticeKey = notice !== null && noticeKey !== null && noticeKey === expandedKey ? noticeKey : null
  const changelogs = input.changelogs && typeof input.changelogs === 'object' ? input.changelogs : {}
  // #64 单语：渲染语言提前解出，头部宏/总账/横幅/分类账/印章同语言（不传跟随全局信号，缺省 zh）。
  const lang = langOf((input as Record<string, unknown>)['lang'])
  const ctx: RowRenderContext = {
    expanded: false,
    busy: installing,
    inFlight: input.inFlight === true,
    theme,
    themeTokens: (input as { themeTokens?: UpdateThemeTokens }).themeTokens ?? undefined,
    titles,
    skipped: null,
    notice: null,
    changelogMarkdown: null,
    lang,
    knowledge: null,
    inRound: false,
    worldLatest: null,
    fallbackCandidate: null,
    fallbackBusy: false,
    fallbackWaiting: false,
  }
  const fallbackOffers =
    input.fallbackOffers && typeof input.fallbackOffers === 'object' ? input.fallbackOffers : {}
  const fallbackBusyKey = typeof input.fallbackBusyKey === 'string' && input.fallbackBusyKey ? input.fallbackBusyKey : null
  const compliantInput = isObject(input.compliant) ? (input.compliant as Record<string, unknown>) : null
  const compliantWaitInput =
    compliantInput && isObject(compliantInput['wait']) ? (compliantInput['wait'] as Record<string, unknown>) : null
  const waitKeys: string[] = []
  if (compliantWaitInput && Array.isArray(compliantWaitInput['keys'])) {
    for (const key of compliantWaitInput['keys'] as unknown[]) if (typeof key === 'string' && key) waitKeys.push(key)
  }
  const waitUnlockAtMs =
    compliantWaitInput && typeof compliantWaitInput['unlockAtMs'] === 'number'
      ? (compliantWaitInput['unlockAtMs'] as number)
      : null
  const compliantUnlocksInput =
    compliantInput && isObject(compliantInput['unlocks']) ? (compliantInput['unlocks'] as Record<string, unknown>) : null
  const compliant =
    compliantInput && typeof compliantInput['gated'] === 'number'
      ? {
          gated: compliantInput['gated'] as number,
          confirmList: typeof compliantInput['confirmList'] === 'string' && compliantInput['confirmList'] ? (compliantInput['confirmList'] as string) : null,
          confirmCount: typeof compliantInput['confirmCount'] === 'number' ? (compliantInput['confirmCount'] as number) : 0,
          busy: compliantInput['busy'] === true,
          wait: waitKeys.length > 0 ? { keys: waitKeys, unlockAtMs: waitUnlockAtMs } : null,
          unlocks: compliantUnlocksInput ? (compliantUnlocksInput as Record<string, number | null>) : null,
        }
      : null
  const parts: string[] = []

  // 顶部一行：卷宗抬头 + 两件宏（忙守卫：任一行安装中，两个批量入口一起置灰）。
  parts.push('<div class="dsh-upd-batch-head">')
  parts.push('<div class="dsh-upd-batch-title">' + escapeHtml(batchText('batch.header.title', lang)) + ' · <i>' + escapeHtml(batchText('batch.seal.ledger', lang)) + '</i></div>')
  parts.push('<div class="dsh-upd-batch-macros">')
  parts.push('<button type="button" data-act="check"' + disabled + ' title="' + escapeHtml(batchText('batch.action.check-title', lang)) + '">' + escapeHtml(batchText('batch.action.check', lang)) + '</button>')
  parts.push('<button type="button" data-act="install" data-primary="1"' + disabled + ' title="' + escapeHtml(batchText('batch.action.install-all-title', lang)) + '">' + escapeHtml(batchText('batch.action.install-all', lang)) + '</button>')
  if (mode === 'dialog') parts.push('<button type="button" data-act="close" title="' + escapeHtml(batchText('batch.action.close-title', lang)) + '">' + escapeHtml(batchText('batch.action.close', lang)) + '</button>')
  parts.push('</div>')
  parts.push('</div>')

  // 一句话总账（有没有事）。
  const summary = loaded
    ? batchSummaryText(counts, rows, total, installing, lastError !== null, lang)
    : batchText('batch.banner.loading', lang)
  parts.push('<div class="dsh-upd-batch-sum" role="status" aria-live="polite">' + escapeHtml(summary) + '</div>')

  // 常驻横幅：失败与待重启不藏进抽屉。
  parts.push(bannersHTML(rows, titles, lastError, lang, compliant, compliantFacts))
  const session = isObject(input.session) ? (input.session as Record<string, unknown>) : null
  const unfinished = unfinishedCount(rows, session ?? undefined)
  const showControls = total > 0 && hasUnfinishedRows(rows, session ?? undefined)
  const prefs = isObject(input.prefs) ? (input.prefs as Record<string, unknown>) : null
  const checkOnOpen = prefs === null ? null : (prefs['checkOnOpen'] === false ? false : true)

  // 明细：一行一家。
  parts.push('<div class="dsh-upd-btable">')
  for (const row of rows) {
    const raw = skippedVersions[row.key]
    const skipped = typeof raw === 'string' && raw ? raw : null
    const expanded = row.key === expandedKey
    const inRound = isInUnfinishedRound(input.session, row.key)
    const knowledge = !inRound ? knowledgeEntryOf(input.inventory, row.key) : null
    // 旧决议不指新失败：候选对不上该行当前远端版即视为无候选（挂载侧随后清掉，这里先不画错）。
    const offerRaw = (fallbackOffers as Record<string, unknown>)[row.key]
    const offerCand =
      isObject(offerRaw) && typeof offerRaw['candidate'] === 'string' && (offerRaw['candidate'] as string).trim()
        ? ((offerRaw['candidate'] as string).trim() as string)
        : null
    const offerTarget = isObject(offerRaw) && typeof offerRaw['targetVersion'] === 'string' ? (offerRaw['targetVersion'] as string) : null
    const latest = latestVersionOf(row)
    parts.push(
      rowSetHTML(row, {
        ...ctx,
        expanded,
        skipped,
        notice: expanded && row.key === detailNoticeKey ? notice : null,
        changelogMarkdown:
          expanded && typeof changelogs[row.key] === 'string' ? (changelogs[row.key] as string) : null,
        lang,
        knowledge,
        inRound,
        worldLatest: worldUpdateVersion(row, knowledge, sessionUpdatedAtOf(input.session, row.key)),
        fallbackCandidate: offerCand && offerTarget === latest ? offerCand : null,
        fallbackBusy: fallbackBusyKey === row.key,
        fallbackWaiting: waitKeys.includes(row.key),
      }),
    )
  }
  parts.push('</div>')

  // 表下一行分类总账。
  if (total > 0) {
    parts.push('<div class="dsh-upd-batch-ledger">' + escapeHtml(batchLedgerText(counts, lang)) + '</div>')
  }

  // 断点续跑与取消（有没做完的一轮才有意义；不与顶部两件宏抢位）。
  if (showControls) {
    const more: string[] = []
    more.push(
      '<button type="button" data-act="resume" title="' + escapeHtml(batchText('batch.action.resume-title', lang)) + '">' +
        escapeHtml(batchText('batch.action.resume', lang, { count: String(unfinished) })) + '</button>',
    )
    // 忙守卫同理：安装中「取消」停不了正在跑的那一家（宿主侧取消只清会话），别给人假动作。
    // 两步确认：第一次只上膛（红框 + 换文案），第二次才真取消；点别的按钮自动卸膛。
    const confirmCancel = input.confirmCancel === true
    const discardLabel = confirmCancel
      ? batchText('batch.action.confirm-discard', lang)
      : batchText('batch.action.discard', lang)
    more.push(
      '<button type="button" data-act="cancel"' + disabled +
        (confirmCancel
          ? ' data-confirm="1" title="' + escapeHtml(batchText('batch.notice.cancel-confirm', lang)) + '"'
          : ' title="' + escapeHtml(batchText('batch.action.discard', lang)) + '"') +
        '>' + escapeHtml(discardLabel) + '</button>',
    )
    parts.push('<div class="dsh-upd-batch-more">' + more.join('') + '</div>')
    parts.push('<div class="dsh-upd-batch-fact" role="note">' + escapeHtml(batchText('batch.fact.close-safe', lang)) + '</div>')
    if (macroBusy) {
      parts.push('<div class="dsh-upd-batch-fact" role="note">' + escapeHtml(batchText('batch.notice.busy-cancel', lang)) + '</div>')
    }
  }
  if (prefs !== null && checkOnOpen !== null) {
    parts.push(
      '<div class="dsh-upd-batch-prefs"><button type="button" data-act="toggle-check-on-open" aria-pressed="' + (checkOnOpen ? 'true' : 'false') + '">' +
        escapeHtml((checkOnOpen ? '[x] ' : '[ ] ') + batchText('batch.setting.check-on-open', lang)) + '</button></div>',
    )
  }
  if (notice !== null && detailNoticeKey === null) {
    parts.push('<div class="dsh-upd-batch-notice" role="status">' + escapeHtml(notice) + '</div>')
  }

  const kernel = parts.join(String.fromCharCode(10))
  // 主题只换肤：默认不带 data-theme、不带 Archive 串；archive 才挂属性并追加两份 Archive 皮肤。
  const archive = normalizePanelTheme(theme) === 'archive'
  const attr = archive ? ' data-theme="archive"' : ''
  const tokensStyle = themeTokensStyleFor((input as { themeTokens?: UpdateThemeTokens }).themeTokens ?? undefined)
  const tokensAttr = tokensStyle ? ' style="' + tokensStyle + '"' : ''
  const seal = batchSealOf(counts, lang)
  const root =
    '<div class="dsh-upd dsh-upd-batch" data-mode="' + mode + '" data-seal="' + escapeHtml(seal.text) +
    '" data-seal-tone="' + seal.tone + '"' + attr + tokensAttr + '>\n' + kernel + '\n</div>'
  const body = mode === 'dialog' ? '<div class="dsh-upd-overlay" data-mode="dialog">' + root + '</div>' : root
  // 详情默认弹窗（#108）：展开行以 sibling dialog 呈现（与批量底叠放，内层 z-index+1）；行内不再内嵌，默认即弹窗。
  let detailDialog = ''
  if (expandedKey !== null) {
    const target = rows.find((row) => row.key === expandedKey) ?? null
    if (target !== null) {
      const rawSkipped = skippedVersions[target.key]
      const skippedForDialog = typeof rawSkipped === 'string' && rawSkipped ? rawSkipped : null
      const offerRaw = (fallbackOffers as Record<string, unknown>)[target.key]
      const offerCand =
        isObject(offerRaw) && typeof offerRaw['candidate'] === 'string' && (offerRaw['candidate'] as string).trim()
          ? ((offerRaw['candidate'] as string).trim() as string)
          : null
      const offerTarget = isObject(offerRaw) && typeof offerRaw['targetVersion'] === 'string' ? (offerRaw['targetVersion'] as string) : null
      detailDialog = detailDialogHTML(target, {
        ...ctx,
        expanded: true,
        skipped: skippedForDialog,
        notice: target.key === detailNoticeKey ? notice : null,
        changelogMarkdown:
          typeof changelogs[target.key] === 'string' ? (changelogs[target.key] as string) : null,
        fallbackCandidate: offerCand && offerTarget === latestVersionOf(target) ? offerCand : null,
        fallbackBusy: fallbackBusyKey === target.key,
        fallbackWaiting: waitKeys.includes(target.key),
      })
    }
  }
  const css = archive
    ? [UPDATE_PANEL_CSS, UPDATE_BATCH_PANEL_CSS, UPDATE_PANEL_ARCHIVE_CSS, UPDATE_BATCH_PANEL_ARCHIVE_CSS].join(String.fromCharCode(10))
    : [UPDATE_PANEL_CSS, UPDATE_BATCH_PANEL_CSS].join(String.fromCharCode(10))
  return '<style>' + css + '</style>\n' + body + (detailDialog ? '\n' + detailDialog : '')
}

/** 一句话总账：先答「有没有事」（#64 单语：缺省 zh 零回归）。 */
function batchSummaryText(
  counts: BatchLedgerCounts,
  rows: readonly BatchRowView[],
  total: number,
  installing: boolean,
  hasError: boolean,
  lang?: unknown,
): string {
  const l = langOf(lang)
  if (hasError) return batchText('batch.hint.error', l)
  if (total === 0) return batchText('batch.hint.empty', l)
  if (installing) {
    // 忙不等于别的家不能动：可以排队（入队不算失败），所以这里说的是「还能怎么加进来」。
    const canQueue = rows.filter((row) => asBatchPhase(row.phase) === 'ready' && !isQueuedRow(row)).length
    return canQueue > 0
      ? batchText('batch.hint.installing-queueable', l, { a: String(counts.installing), b: String(canQueue) })
      : batchText('batch.hint.installing-auto', l, { a: String(counts.installing) })
  }
  if (counts.failed > 0) return batchText('batch.hint.failed', l, { n: String(counts.failed) })
  if (counts.updatable > 0)
    return batchText('batch.hint.updatable', l, { n: String(counts.updatable) })
  if (counts.restart > 0) return batchText('batch.hint.restart', l, { n: String(counts.restart) })
  // #190：全部未登记时重启不会加载——一句话总账不许落到「已全部为最新」。
  if (counts.restartUnregistered > 0) return batchText('batch.hint.restart-unregistered', l, { n: String(counts.restartUnregistered) })
  if (counts.pending > 0) return batchText('batch.hint.pending', l, { n: String(counts.pending) })
  return batchText('batch.hint.done', l)
}

/** 印章（Archive 才画）：色调按总账里最重的一档走；文字跟随语言（#64 单语，tone 不入 key）。 */
function batchSealOf(counts: BatchLedgerCounts, lang?: unknown): { text: string; tone: 'ink' | 'green' | 'yellow' | 'red' } {
  const text = batchText('batch.seal.ledger', langOf(lang))
  if (counts.failed > 0) return { text, tone: 'red' }
  // #190：未登记的行也算「有一件事要处理」（去选中），印章不许落成灰的「没事」。
  if (counts.installing > 0 || counts.restart > 0 || counts.restartUnregistered > 0) return { text, tone: 'yellow' }
  if (counts.updatable > 0) return { text, tone: 'green' }
  return { text, tone: 'ink' }
}

/** 常驻横幅：批量电话失败 / 有失败行 / 合规版兜底与收尾事实 / 有待重启行（都不许藏进抽屉；#64 单语：缺省 zh；data-mini 冻结待 #67 仲裁）。 */
function bannersHTML(
  rows: readonly BatchRowView[],
  titles: Record<string, string>,
  lastError: string | null,
  lang?: unknown,
  compliant: {
    gated?: number
    confirmList?: string | null
    confirmCount?: number
    busy?: boolean
    /** 已决议、此刻确实没有可装版的行（#156：如实说等多久，不画假按钮）。 */
    wait?: { keys: readonly string[]; unlockAtMs: number | null } | null
    /** 决议记忆里的解封时刻（按行 key）：只用来把「最新版还挡多久」说清。 */
    unlocks?: Record<string, number | null> | null
  } | null = null,
  facts?: ReadonlyMap<string, { version: string; target: string; needsRestart: boolean }> | null,
): string {
  const l = langOf(lang)
  const unlocks = compliant?.unlocks ?? null
  // 收尾事实（#156 第一性原理）：账本目标没装成、但这家已经装上「能装的最新」——逐行自算（纯函数自足），
  // 记忆只补一句「最新版还挡多久」。这是「全部更新到能更新的最新」的交付凭证，不许再算成安装失败。
  // 渲染侧已经把这份账算过一遍（总账要用同一份），传进来就直接用；单独调用（测试）时自算，纯函数照样自足。
  const done = new Map<string, { version: string; target: string; needsRestart: boolean }>(facts ?? [])
  if (!facts) {
    for (const row of rows) {
      const fact = compliantInstalledOf(row)
      if (fact) done.set(row.key, fact)
    }
  }
  const doneLineOf = (row: BatchRowView, fact: { version: string; target: string }): string => {
    const raw = unlocks && typeof unlocks[row.key] === 'number' ? (unlocks[row.key] as number) : null
    const time = raw !== null ? formatUnlockAt(raw, l) : null
    const vars = { title: titleOf(row, titles), version: fact.version, target: fact.target }
    return time
      ? escapeHtml(batchText('batch.banner.compliant-done-gated', l, { ...vars, time }))
      : escapeHtml(batchText('batch.banner.compliant-done', l, vars))
  }
  // 名单自己算（纯函数自足）：有年龄门结论且有该家决议电话、且还没装上合规版的行才算数；调用方只需补决议态。
  const gatedCandidates = rows.filter(
    (row) => batchFallbackCauseOf(row) !== null && singleFallbackPhoneOf(row) !== null && !done.has(row.key),
  )
  const gated = typeof compliant?.gated === 'number' ? compliant.gated : gatedCandidates.length
  const confirmList = typeof compliant?.confirmList === 'string' && compliant.confirmList ? compliant.confirmList : null
  const confirmCount = typeof compliant?.confirmCount === 'number' ? compliant.confirmCount : 0
  const compliantBusy = compliant?.busy === true
  const waitKeys = compliant?.wait && Array.isArray(compliant.wait.keys) ? compliant.wait.keys : []
  const parts: string[] = []
  if (lastError) {
    const copy = failureCopy(lastError, l)
    const detail = copy?.zh ?? failureCopy('unknown', l)?.zh ?? ''
    const act = copy?.act ?? batchText('batch.banner.error-action-fallback', l)
    // 副行出框（与单面板同口径）：色框只装标题，行动句住框外第二行居左。
    parts.push(
      '<div class="dsh-upd-banner" data-kind="failed" data-mini="阻" role="status">' +
        '<div><span class="dsh-upd-sealmini" aria-hidden="true">阻</span><strong>' + escapeHtml(batchText('batch.banner.error-title', l, { code: lastError, detail })) + '</strong></div>' +
        '</div>',
    )
    if (act) parts.push('<div class="dsh-upd-banner-sub">' + escapeHtml(act) + '</div>')
  }
  // 排队占位不算失败：忙时宿主会把它记成 failed+update-busy，这里翻回来。
  // 等重启也不算失败（#156 M1 诚实性）：这类行账本相位是 failed、error 是 pending-restart——磁盘上
  // 已经有更新版、只差重启生效，丢进"安装失败"是冤枉（目标版确实没装上，所以相位一个字不改）。
  // 它该待的位置是"等重启"那一栏：那一栏的行动就是重启，正是这一行需要的那一下。
  // 已装上合规版的行同样不算失败（#156 收尾事实）：最新版没装成、但这家确实装到了能装的最新，
  // 继续把它算成"安装失败"才是撒谎；它的结果由下面那条"实际安装结果"横幅如实说出。
  const pendingRestartRow = (row: BatchRowView): boolean =>
    asBatchPhase(row.phase) === 'failed' && row.error === 'pending-restart'
  // 失败行集合只认 batchFailedRows（#176 单一真源）：横幅与两枚批量复制按钮永远同一份口径。
  const failed = batchFailedRows(rows)
  if (failed.length > 0) {
    const lines = failed
      .map((row) => {
        const code = row.error || 'install-failed'
        const copy = failureCopy(code, l)
        return (
          '<div>' + escapeHtml(titleOf(row, titles)) + '：<code>' + escapeHtml(code) + '</code> ' +
          escapeHtml(copy?.zh ?? failureCopy('unknown', l)?.zh ?? '') + '</div>'
        )
      })
      .join('')
    const failedAct = batchText('batch.banner.failed-action', l)
    // #176：名单下方给统一的复制出口——两枚批量按钮，别让用户为了复制证据一家家点开详情。
    // 一条手工命令都没有时按钮置灰并说明原因（复制一段只有 # 注释的文本没有意义）。
    const failedManual = batchFailedManualText(failed, l, titles)
    const manualAbsent = failedManual.commands === 0
    // #92：置灰说明只在整批原因一致时点名原因；混着不同原因（或判不出）时给中性一句话，
    // 不把第一行的原因扣给整批（逐行原因仍写在「复制手工命令」的注释行里）。
    const absentReasons = failed.map((row) => manualAbsentReasonOf(asSnapshotLike(row.snapshot)))
    const absentReasonSet = new Set<ManualAbsentReason>(
      absentReasons.filter((reason): reason is ManualAbsentReason => reason !== null),
    )
    const absentTitle =
      absentReasonSet.size === 1 && absentReasons.every((reason) => reason !== null)
        ? manualAbsentTextOf([...absentReasonSet][0], l)
        : manualAbsentTextOf(null, l)
    parts.push(
      '<div class="dsh-upd-banner" data-kind="failed" data-mini="阻" role="status">' +
        '<div><span class="dsh-upd-sealmini" aria-hidden="true">阻</span><strong>' + escapeHtml(batchText('batch.banner.failed-title', l, { n: String(failed.length) })) + '</strong></div>' +
        '<div class="dsh-upd-blist">' + lines + '</div>' +
        '<div class="dsh-upd-browline"><span class="dsh-upd-bcopy">' +
        '<button type="button" data-act="copy-all-diag">' + escapeHtml(batchText('batch.row-action.copy-diag', l)) + '</button>' +
        '<button type="button" data-act="copy-all-manual"' + (manualAbsent ? ' disabled title="' + escapeHtml(absentTitle) + '"' : '') + '>' +
        escapeHtml(batchText('batch.row-action.copy-manual', l)) + '</button>' +
        '</span></div>' +
        '</div>',
    )
    if (failedAct) parts.push('<div class="dsh-upd-banner-sub">' + escapeHtml(failedAct) + '</div>')
  }
  // 合规版（#156 第一性原理）：最新版被 24 小时年龄门挡住时，「全部更新」这一步不能只剩一句失败——
  // 有决议电话的行当场给一条批量入口：先逐家决议，再点名精确版本请用户确认（永不静默装旧版）。
  // 只加一条横幅，不碰账本相位（#152）：合规版安装是用户显式确认后的独立动作，不是本轮的"已更新"。
  if (confirmList) {
    parts.push(
      '<div class="dsh-upd-banner" data-kind="update" role="status">' +
        '<div><strong>' + escapeHtml(batchText('batch.banner.compliant-confirm', l, { list: confirmList })) + '</strong></div>' +
        '<div class="dsh-upd-browline"><span class="dsh-upd-blist">' + escapeHtml(confirmList) + '</span>' +
        '<button type="button" data-act="batch-fallback-confirm" data-primary="1"' + (compliantBusy ? ' disabled' : '') + '>' +
        escapeHtml(batchText('batch.action.install-compliant-confirm', l, { n: String(confirmCount) })) + '</button></div>' +
        '</div>',
    )
  }
  // 两条路各自成立、可以同时存在：有候选的端确认条，没有候选的把"等多久"如实说清。
  if (waitKeys.length > 0) {
    // 此刻确实没有可装版（#156 诚实性）：说清是谁、等多久，不画一个点了也没用的按钮。
    // 解封时刻一到，挂载侧的自动决议会重新跑（它的签名会变），所以这里不需要手动入口。
    const rawUnlock = compliant?.wait ? compliant.wait.unlockAtMs : null
    const unlockAtMs = typeof rawUnlock === 'number' ? rawUnlock : null
    const time = unlockAtMs !== null ? formatUnlockAt(unlockAtMs, l) : null
    const waitTitles = rows
      .filter((row) => waitKeys.includes(row.key))
      .map((row) => titleOf(row, titles))
      .join('、')
    parts.push(
      '<div class="dsh-upd-banner" data-kind="update" role="status">' +
        '<div><strong>' +
        escapeHtml(
          time
            ? batchText('batch.banner.gated-wait', l, { n: String(waitKeys.length), time })
            : batchText('batch.banner.age-gated', l, { n: String(waitKeys.length) }),
        ) +
        '</strong></div>' +
        '<div class="dsh-upd-browline"><span class="dsh-upd-blist">' + escapeHtml(waitTitles) + '</span></div>' +
        '</div>',
    )
  } else if (gated > 0 && confirmList === null) {
    parts.push(
      '<div class="dsh-upd-banner" data-kind="update" role="status">' +
        '<div><strong>' + escapeHtml(batchText('batch.banner.age-gated', l, { n: String(gated) })) + '</strong></div>' +
        '<div class="dsh-upd-browline"><span class="dsh-upd-blist">' +
        escapeHtml(gatedCandidates.map((row) => titleOf(row, titles)).join('、')) +
        '</span>' +
        '<button type="button" data-act="batch-fallback-scan"' + (compliantBusy ? ' disabled' : '') + ' title="' +
        escapeHtml(bilingualText('panel.action.install-fallback-title', l)) + '">' +
        escapeHtml(bilingualText('panel.action.install-fallback', l)) + '</button></div>' +
        '</div>',
    )
  }
  // 收尾事实（#156）：账本目标没装成、但这家已经装上「能装的最新」——如实说清装了哪一版、最新那版还差什么。
  // 不比失败条纹更"安慰"：这是事实陈述，也是「全部更新到能更新的最新」这一步的交付凭证。
  if (done.size > 0) {
    const lines = rows
      .filter((row) => done.has(row.key))
      .map((row) => '<div>' + doneLineOf(row, done.get(row.key) as { version: string; target: string }) + '</div>')
      .join('')
    parts.push(
      '<div class="dsh-upd-banner" data-kind="update" role="status">' +
        '<div><strong>' + escapeHtml(batchText('batch.banner.compliant-done-title', l, { n: String(done.size) })) + '</strong></div>' +
        '<div class="dsh-upd-blist">' + lines + '</div>' +
        '</div>',
    )
  }
  const restart = rows.filter(
    (row) => row.restartRequired === true || pendingRestartRow(row) || done.get(row.key)?.needsRestart === true,
  )
  if (restart.length > 0) {
    const restartAct = batchText('batch.banner.restart-action', l)
    // #190：在册事实为 false 的行重启也不会加载——横幅分别计数，不再把「重启后生效」说满。
    const unregistered = restart.filter(restartUnregistered)
    const registered = restart.filter((row) => !restartUnregistered(row))
    const title =
      unregistered.length === 0
        ? batchText('batch.banner.restart-title', l, { n: String(restart.length) })
        : registered.length === 0
          ? batchText('batch.banner.restart-unregistered-title', l)
          : batchText('batch.banner.restart-partial-title', l, { n: String(registered.length), m: String(unregistered.length) })
    const names = restart
      .map((row) => escapeHtml(titleOf(row, titles)) + (restartUnregistered(row) ? escapeHtml(batchText('batch.row.unregistered-suffix', l)) : ''))
      .join('、')
    // 措辞与单插件面板 panel.blocked.pending-restart.action 同一句（#64 按清单独立成键，英文可独立调优）；位置与单面板同口径：住框外。
    parts.push(
      '<div class="dsh-upd-banner" data-kind="restart" role="status">' +
        '<div><strong>' + escapeHtml(title) + '</strong></div>' +
        // 名单居左、按钮同行居右：名单与按钮同处一行内 flex 行，窄屏换行时按钮仍靠右。
        // #190：只有「已登记」的行重启才会加载；全部未登记时不画重启按钮，免得点了也白点。
        '<div class="dsh-upd-browline"><span class="dsh-upd-blist">' + names + '</span>' +
        (registered.length > 0
          ? '<button type="button" data-act="restart">' + escapeHtml(batchText('batch.banner.restart-button', l)) + '</button>'
          : '') +
        '</div>' +
        '</div>',
    )
    // #190：「重启宿主以加载新版本」只对已登记的行成立；全部未登记时这句是假指令，不出现。
    if (registered.length > 0 && restartAct) parts.push('<div class="dsh-upd-banner-sub">' + escapeHtml(restartAct) + '</div>')
    if (unregistered.length > 0) {
      parts.push('<div class="dsh-upd-banner-sub">' + escapeHtml(batchText('batch.banner.restart-unregistered-hint', l)) + '</div>')
    }
  }
  return parts.join('')
}

/**
 * 该行合规版按钮（#156，纯函数）：有候选即[确认装X]，有资格无候选即[装合规版]，
 * 其余（B 类/认不出/老宿主无电话/在途置灰由调用方处理）回 ''——调用方原样拼接，不画错按钮。
 * 文案复用 panel.action.* 既有键（经 bilingualText），零新增键。
 */
function rowFallbackButtonHTML(row: BatchRowView, ctx: RowRenderContext): string {
  try {
    // 已决议过、此刻确实没有可装版（等解封）：不画按钮——点了也只会得到同一句话（#156 诚实性），
    // 横幅已经说清等多久，解封后自动决议会重新给入口。
    if (ctx.fallbackWaiting) return ''
    const keyAttr = escapeHtml(row.key)
    const busy = ctx.fallbackBusy || ctx.inFlight ? ' disabled aria-busy="true"' : ''
    const off = ctx.inFlight && !ctx.fallbackBusy ? ' disabled' : ''
    if (typeof ctx.fallbackCandidate === 'string' && ctx.fallbackCandidate) {
      return (
        '<button type="button" data-act="row-fallback-confirm" data-key="' + keyAttr + '" data-primary="1" title="' +
        escapeHtml(bilingualText('panel.action.install-fallback-confirm-title', ctx.lang)) +
        '"' + busy + '>' +
        escapeHtml(bilingualText('panel.action.install-fallback-confirm', ctx.lang, { version: ctx.fallbackCandidate })) + '</button>'
      )
    }
    if (singleFallbackPhoneOf(row) === null) return ''
    if (!batchFallbackCauseOf(row)) return ''
    return (
      '<button type="button" data-act="row-fallback" data-key="' + keyAttr + '" data-primary="1" title="' +
      escapeHtml(bilingualText('panel.action.install-fallback-title', ctx.lang)) +
      '"' + (ctx.fallbackBusy ? busy : off) + '>' +
      escapeHtml(bilingualText('panel.action.install-fallback', ctx.lang)) + '</button>'
    )
  } catch {
    return ''
  }
}

/** 一行一家（含点开时的详情：详情就是单插件内核本身）。 */
function rowSetHTML(row: BatchRowView, ctx: RowRenderContext): string {
  const phase = asBatchPhase(row.phase)
  const keyAttr = escapeHtml(row.key)
  const skipped = ctx.skipped
  const queued = isQueuedRow(row)
  const position = queued ? queuePositionOf(row) : null
  // 收尾事实（#156）：这一行账本相位是 failed、可它已经装上「能装的最新」——状态字、红字、圆点与
  // 兜底按钮都得跟着说实话：说"安装失败"是撒谎，再劝它装合规版是白劝（已经装上了）。
  const rowDone = phase === 'failed' && !queued ? compliantInstalledOf(row) : null
  const versionHTML = batchRowVersionHTML(row, ctx.knowledge, ctx.lang)
  const rowStatusText = rowDone !== null
    ? rowDone.needsRestart
      ? batchText('batch.row.done-restart', ctx.lang)
      : batchText('batch.row.done', ctx.lang)
    : queued
      ? batchQueuedStatus(position, ctx.lang)
      : ctx.worldLatest !== null
        ? batchText('batch.row.update', ctx.lang, { version: ctx.worldLatest })
        : ctx.inRound
          ? (batchRowKnowledgeText(row, ctx.knowledge, ctx.lang) ?? batchRowStatus(row, skipped, ctx.lang))
          : (batchRowPendingStatus(row, ctx.knowledge, ctx.lang) ?? batchRowStatus(row, skipped, ctx.lang))
  const actions: string[] = []
  // 忙守卫按行：正在装的那一行禁自己（不许重复提交）；**别的行不灰**——点下去是「加入队列」。
  const off = ctx.inFlight ? ' disabled' : ''
  if (phase === 'installing') {
    actions.push(
      '<button type="button" data-act="row-install" data-key="' + keyAttr + '" disabled>' + escapeHtml(batchText('batch.row-action.installing', ctx.lang)) + '</button>',
    )
  } else if (queued) {
    // 排队那行的下一步是「取消排队」：撤掉自己的占位（别家与正在装的拥有者都不碰）。
    if (cancelQueuePhoneOf(row) !== null && queuedRequestIdOf(row) !== null) {
      actions.push(
        '<button type="button" data-act="row-cancel-queue" data-key="' + keyAttr + '"' + off + '>' + escapeHtml(batchText('batch.row-action.cancel-queue', ctx.lang)) + '</button>',
      )
    }
  } else if (phase === 'ready' && skipped === null) {
    actions.push(
      '<button type="button" data-act="row-install" data-key="' + keyAttr + '" data-primary="1"' + off + '>' +
        escapeHtml(ctx.busy ? batchText('batch.row-action.queue', ctx.lang) : batchText('batch.row-action.install-row', ctx.lang)) + '</button>',
    )
  } else if (phase === 'ready' && skipped !== null) {
    // 跳过后这一版的下一步是「恢复」：与单插件面板同一套本地跳过语义（按插件 + 版本记）。
    actions.push(
      '<button type="button" data-act="row-resume-skip" data-key="' + keyAttr + '"' + off +
        '>' + escapeHtml(batchText('batch.row-action.unskip', ctx.lang, { version: skipped })) + '</button>',
    )
  } else if (phase === 'failed') {
    actions.push(
      '<button type="button" data-act="row-install" data-key="' + keyAttr + '"' + off + '>' +
        escapeHtml(ctx.busy ? batchText('batch.row-action.queue', ctx.lang) : batchText('batch.row-action.retry', ctx.lang)) + '</button>',
    )
    // 合规版兜底（#156）：拦的正是该行更新目标时再给一个选择——[重试]不动（仍是最新），
    // [装合规版]走该家自己的决议电话，有候选即换[确认装X]；B 类与认不出的失败不画，不硬上。
    // 文案复用 panel.action.* 既有键（经 bilingualText），零新增键。
    if (!queued && rowDone === null) actions.push(rowFallbackButtonHTML(row, ctx))
  }
  // #190：未登记的行重启也不会加载——行级重启入口也不画，免得点了白点（状态词已给下一步）。
  if (row.restartRequired === true && !restartUnregistered(row)) {
    // 与单插件面板同一措辞：宿主没有重启自己的电话，这里只做入口。
    actions.push('<button type="button" data-act="restart" data-key="' + keyAttr + '">' + escapeHtml(batchText('batch.row-action.restart', ctx.lang)) + '</button>')
  }
  actions.push(
    '<button type="button" data-act="toggle-details" data-key="' + keyAttr + '">' +
      escapeHtml(ctx.expanded ? batchText('batch.row-action.hide-detail', ctx.lang) : batchText('batch.row-action.show-detail', ctx.lang)) + '</button>',
  )
  const failLine =
    phase === 'failed' && !queued
      ? rowDone !== null
        ? (() => {
          // 收尾事实（#156）：装到了能装的最新，只是不是账本目标那一版。行里那句话不许说"失败"，
          // 换成同一件事实（缘由不断言：快照里没有那次失败的原文，措辞只说发生了什么）。
          const vars = { version: rowDone.version, target: rowDone.target }
          return (
            '<span class="dsh-upd-bfail dsh-upd-bdone">' +
            escapeHtml(batchText('batch.row.compliant-done', ctx.lang, vars)) +
            '</span>'
          )
        })()
        : (() => {
          const failCode = row.error || 'install-failed'
          // 查/装分家（#134/US15）：查侧码的红字说「本次未能查询」，不说安装失败。
          const failJob = jobFailureOf(row)
          const failSide = failJob?.code ?? (typeof row.error === 'string' && row.error ? row.error : null)
          const failDetail = isCheckSideFailureCode(failSide)
            ? batchText('batch.row.failed', ctx.lang)
            : failureCopy(failCode, ctx.lang)?.zh ?? failureCopy('unknown', ctx.lang)?.zh ?? ''
          // 字典不存 HTML（#64 口径）：模板为纯文本，<code> 由此处组装，语义与 inventory batch.row.error-label 一致。
          const label = batchText('batch.row.error-label', ctx.lang, { code: failCode, detail: failDetail })
          const escaped = escapeHtml(label)
          const codeEsc = escapeHtml(failCode)
          const withCode = escaped.includes(codeEsc) ? escaped.replace(codeEsc, '<code>' + codeEsc + '</code>') : escaped
          return '<span class="dsh-upd-bfail">' + withCode + '</span>'
        })()
      : ''
  const main =
    '<button type="button" class="dsh-upd-brow-main" data-act="toggle-details" data-key="' + keyAttr +
    '" aria-expanded="' + (ctx.expanded ? 'true' : 'false') + '">' +
    '<span class="dsh-upd-updot" data-tone="' + dotToneOf(row, phase, skipped, queued, ctx.worldLatest, rowDone === null ? null : rowDone.needsRestart) + '"></span>' +
    '<span class="dsh-upd-bname">' + escapeHtml(titleOf(row, ctx.titles)) + '</span>' +
    versionHTML +
    '<span class="dsh-upd-bstat">' + escapeHtml(rowStatusText) + (ctx.inRound && !queued ? '（' + escapeHtml(batchText('batch.row.unfinished-tag', ctx.lang)) + '）' : '') + '</span>' +
    failLine +
    '</button>'
  // 详情默认弹窗（#108：删内嵌展开路径——行内不再叠 `.dsh-upd-bdetail`，展开走弹窗 sibling overlay，见 detailDialogHTML）。
  return (
    '<div class="dsh-upd-brow-set" data-key="' + keyAttr + '">' +
    '<div class="dsh-upd-brow" data-phase="' + escapeHtml(phase) + '" data-key="' + keyAttr + '"' +
    (queued ? ' data-queued="1"' : '') + '>' +
    main +
    '<span class="dsh-upd-brow-actions">' + actions.join('') + '</span>' +
    '</div>' +
    '</div>'
  )
}

/**
 * 详情里由批量面板自己出的动作行：全部带 data-act，与行内同一通道，点了真能用。
 * 忙守卫与行内同一判据（任一行装东西时一起置灰）。
 */
function detailActionsHTML(row: BatchRowView, ctx: RowRenderContext): string {
  const phase = asBatchPhase(row.phase)
  const keyAttr = escapeHtml(row.key)
  const version = latestVersionOf(row)
  const queued = isQueuedRow(row)
  // 忙守卫按行：只防连点（本面板有电话在飞）；别家正在装不影响这一家的按钮（那正是「加入队列」）。
  const off = ctx.inFlight ? ' disabled' : ''
  const buttons: string[] = []
  if (phase === 'installing') {
    buttons.push('<button type="button" data-act="row-install" data-key="' + keyAttr + '" disabled>' + escapeHtml(batchText('batch.row-action.installing', ctx.lang)) + '</button>')
  } else if (queued) {
    if (cancelQueuePhoneOf(row) !== null && queuedRequestIdOf(row) !== null) {
      buttons.push(
        '<button type="button" data-act="row-cancel-queue" data-key="' + keyAttr + '"' + off + '>' + escapeHtml(batchText('batch.row-action.cancel-queue', ctx.lang)) + '</button>',
      )
    }
  } else if (phase === 'failed') {
    buttons.push(
      '<button type="button" data-act="row-install" data-key="' + keyAttr + '"' + off + '>' +
        escapeHtml(ctx.busy ? batchText('batch.row-action.queue', ctx.lang) : batchText('batch.row-action.retry', ctx.lang)) + '</button>',
    )
    // 合规版兜底（#156）：与行内同口径（行内已注释），详情里同样给选择。
    if (!queued) {
      const fallback = rowFallbackButtonHTML(row, ctx)
      if (fallback) buttons.push(fallback)
    }
  } else if (phase === 'ready' && ctx.skipped === null) {
    buttons.push(
      '<button type="button" data-act="row-install" data-key="' + keyAttr + '" data-primary="1"' + off +
        '>' + escapeHtml(ctx.busy ? batchText('batch.row-action.queue', ctx.lang) : version !== null ? batchText('batch.row-action.install-version', ctx.lang, { version }) : batchText('batch.row-action.install-generic', ctx.lang)) + '</button>',
    )
  }
  // 单查（#84）：该行自己的查新版电话透过行 phoneNames 透传（老宿主没给即不画，诚实缺省）。
  // 文案沿用批量宏的已有键（不新增键）：在详情里它自然就是「查这一家」。
  if (phase !== 'installing' && singleCheckPhoneOf(row) !== null) {
    buttons.push(
      '<button type="button" data-act="row-check" data-key="' + keyAttr + '"' + off + '>' + escapeHtml(batchText('batch.action.check', ctx.lang)) + '</button>',
    );
  }
  if (!queued && phase === 'ready' && ctx.skipped === null && version !== null) {
    buttons.push(
      '<button type="button" data-act="row-skip" data-key="' + keyAttr + '"' + off + '>' + escapeHtml(batchText('batch.row-action.skip', ctx.lang)) + '</button>',
    )
  }
  if (ctx.skipped !== null) {
    buttons.push(
      '<button type="button" data-act="row-resume-skip" data-key="' + keyAttr + '"' + off +
        '>' + escapeHtml(batchText('batch.row-action.unskip', ctx.lang, { version: ctx.skipped })) + '</button>',
    )
  }
  if (typeof row.manual === 'string' && row.manual) {
    buttons.push(
      '<button type="button" data-act="row-copy-manual" data-key="' + keyAttr + '"' + off + '>' + escapeHtml(batchText('batch.row-action.copy-manual', ctx.lang)) + '</button>',
    )
  }
  buttons.push('<button type="button" data-act="row-copy-diag" data-key="' + keyAttr + '"' + off + '>' + escapeHtml(batchText('batch.row-action.copy-diag', ctx.lang)) + '</button>')
  return '<span class="dsh-upd-bdetail-actions">' + buttons.join('') + '</span>'
}

/**
 * 详情走只读渲染后，内核里只该剩内容、不该剩控件：`actions: 'none'` 关掉了动作行，
 * 但 03 章的「显示其他插件」开关不在那一块里，仍是可点、没人接的死按钮。
 * 批量面板的详情不接内核的动作通道，所以这里把残留的 data-action 按钮整颗摘掉（章节内容照留）。
 * panel.ts 日后若把队列开关也纳入只读开关，这里自然变成空操作。
 */
function stripActionButtons(html: string): string {
  return html.replace(/<button\b[^>]*data-action=[^>]*>[\s\S]*?<\/button>/g, '')
}

/**
 * 详情默认弹窗（#108，按 #107 决议 B 落地）。
 * 复用单插件内核 dialog 只读（85vh/遮罩/圆角不动）+ 批量自出动作行前置为固定栏 + 内核 footer 同位复刻（右下独立区）。
 * - 动作行置顶固定栏：利用已有 `:has(>.dsh-upd-body)>:not(.dsh-upd-body){flex:none}` 契约，不随 body 滚，零新 CSS 契约；
 * - 关闭=B：右下 footer（`panel.footer.note` + `panel.footer.close`，bilingual 零新增键），通道走批量 `data-act="detail-close"`（内核 `data-action` 在批量挂载无接收端，沿用文案与位置、不新开发关闭件）；
 * - 滚动：弹窗内 body 走内核 `overflow-y:auto` + 章节头 sticky（推翻旧 `overflow:visible` 中性化，仅弹窗内，批量底不动）；
 * - 嵌套：内层 overlay 高一层（CSS `z-index:10000`），Esc/关闭只清 `expandedKey`，不碰批量 dialog 的 `onCloseRequested`。
 */
function detailFooterHTML(row: BatchRowView, ctx: RowRenderContext): string {
  const keyAttr = escapeHtml(row.key)
  return (
    '<div class="dsh-upd-footer"><span class="dsh-upd-foot-note">' + escapeHtml(batchText('panel.footer.note', ctx.lang)) + '</span>' +
    '<button type="button" data-act="detail-close" data-key="' + keyAttr + '" title="' + escapeHtml(batchText('panel.footer.close-title', ctx.lang)) + '">' +
    escapeHtml(batchText('panel.footer.close', ctx.lang)) + '</button></div>'
  )
}

function detailDialogHTML(row: BatchRowView, ctx: RowRenderContext): string {
  const keyAttr = escapeHtml(row.key)
  const kernel = renderUpdatePanelHTML({
    snapshot: asSnapshotLike(row.snapshot),
    manual: typeof row.manual === 'string' ? row.manual : null,
    changelogMarkdown: typeof ctx.changelogMarkdown === 'string' ? ctx.changelogMarkdown : null,
    queue: asQueueLike(row.queue),
    skippedLatest: ctx.skipped !== null,
    lastError: row.error,
    errorKind: row.error,
    mode: 'dialog',
    showOthers: false,
    pluginId: pluginIdOf(row),
    copyNotice: null,
    theme: ctx.theme,
    themeTokens: ctx.themeTokens,
    profileName: typeof row.profileName === 'string' && row.profileName ? row.profileName : null,
    hostKind: typeof row.hostKind === 'string' && row.hostKind ? row.hostKind : null,
    actions: 'none',
  }, ctx.lang)
  const stripped = stripActionButtons(kernel)
  // 外层 batch 已带一份 panel CSS：内核自带的 `<style>` 去掉，免得弹窗 sibling 里再挂一份（DOM 只留 overlay）。
  const withoutStyle = stripped.replace(/^<style>[\s\S]*?<\/style>\s*/, '')
  const bar =
    '<div class="dsh-upd-bdetail-dialog-bar" data-detail-bar="' + keyAttr + '">' +
    detailActionsHTML(row, ctx) +
    '</div>' +
    (ctx.notice !== null
      ? '<div class="dsh-upd-bdetail-notice" role="status">' + escapeHtml(ctx.notice) + '</div>'
      : '')
  const withBar = withoutStyle
    .replace(
      '<div class="dsh-upd-overlay"',
      '<div class="dsh-upd-overlay dsh-upd-bdetail-dialog" data-detail-key="' + keyAttr + '"',
    )
    .replace('<div class="dsh-upd-body">', bar + '<div class="dsh-upd-body">')
  const footer = detailFooterHTML(row, ctx)
  const at = withBar.lastIndexOf('</div></div>')
  if (at < 0) return withBar + footer
  return withBar.slice(0, at) + footer + withBar.slice(at)
}

function dotToneOf(
  row: BatchRowView,
  phase: BatchPhase,
  skipped: string | null,
  queued: boolean,
  worldLatest: string | null = null,
  compliantRestart: boolean | null = null,
): 'idle' | 'todo' | 'busy' | 'warn' | 'bad' | 'ok' {
  // 收尾事实（#156）：账本相位 failed、但确实装到了能装的最新——红灯换成实话（等重启=黄，已收尾=绿）。
  if (compliantRestart === true) return 'warn'
  if (compliantRestart === false) return 'ok'
  if (phase === 'failed' && !queued) return 'bad'
  if (phase === 'installing' || phase === 'checking') return 'busy'
  if (queued) return 'warn'
  if (row.restartRequired === true) return 'warn'
  if (worldLatest !== null) return 'todo'
  if (phase === 'ready') return skipped === null ? 'todo' : 'idle'
  if (phase === 'current' || phase === 'done') return 'ok'
  return 'idle'
}

// ---------- 样式（同一套 dsh-upd-* 前缀；默认最小，Archive 另起一串） ----------

export const UPDATE_BATCH_PANEL_CSS = [
  '/* 批量面板（#25）：类名沿用 dsh-upd-* 前缀；默认（最小）主题，Archive 皮肤见 UPDATE_BATCH_PANEL_ARCHIVE_CSS。 */',
  '.dsh-upd-batch-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap}',
  '.dsh-upd-batch-title{font-weight:700;font-size:var(--dsh-update-panel-chapter-font-size,15px);letter-spacing:.06em}',
  '.dsh-upd-batch-title i{font-style:normal;color:var(--dsh-update-primary,#2563eb)}',
  '.dsh-upd-batch-macros{flex:none}',
  '.dsh-upd-batch-sum{margin:4px 0 8px;font-size:var(--dsh-update-panel-log-font-size,13.5px)}',
  '.dsh-upd-btable{margin-top:2px}',
  '.dsh-upd-brow-set{border-top:1px solid var(--dsh-update-border,#e5e7eb)}',
  '.dsh-upd-brow-set:first-child{border-top:0}',
  '.dsh-upd-brow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 0}',
  '.dsh-upd .dsh-upd-brow-main{display:grid;grid-template-columns:auto minmax(5em,max-content) minmax(18ch,max-content) minmax(0,1fr);align-items:baseline;column-gap:8px;row-gap:2px;flex:1 1 260px;min-width:0;',
  'text-align:left;cursor:pointer;color:inherit;font:inherit;background:transparent;border:0;padding:2px 0;margin:0}',
  '.dsh-upd .dsh-upd-brow-main:hover{color:var(--dsh-update-primary,#2563eb)}',
  '.dsh-upd-brow-actions{flex:none;margin-left:auto}',
  '.dsh-upd-brow-actions button{font-size:12.5px}',
  '.dsh-upd-updot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsh-update-border,#9ca3af);opacity:.55}',
  '.dsh-upd-updot[data-tone="todo"]{background:var(--dsh-update-ok-border,#059669);opacity:1}',
  '.dsh-upd-updot[data-tone="ok"]{background:var(--dsh-update-ok-border,#059669);opacity:1}',
  '.dsh-upd-updot[data-tone="busy"]{background:var(--dsh-update-busy-border,#2563eb);opacity:1}',
  '.dsh-upd-updot[data-tone="warn"]{background:var(--dsh-update-warn-border,#d97706);opacity:1}',
  '.dsh-upd-updot[data-tone="bad"]{background:var(--dsh-update-bad-border,#dc2626);opacity:1}',
  '.dsh-upd-bname{font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-upd-bver{font-family:Consolas,Menlo,monospace;font-size:var(--dsh-update-panel-small-font-size,12px);white-space:nowrap;font-variant-numeric:tabular-nums;min-width:0}',
  '.dsh-upd-bver-cur{opacity:.65}',
  '.dsh-upd-bver-arrow{opacity:.6}',
  '.dsh-upd-bver-new{color:var(--dsh-update-new-text,#dc2626);font-weight:700}',
  '.dsh-upd-bver-new-ok{color:var(--dsh-update-new-ok-text,#047857);font-weight:700}',
  '.dsh-upd-bstat{font-size:var(--dsh-update-panel-small-font-size,12.5px);opacity:.9;min-width:0;overflow-wrap:anywhere}',
  '.dsh-upd-bfail{grid-column:1/-1;display:block;font-size:var(--dsh-update-panel-small-font-size,12.5px);color:var(--dsh-update-bad-border,#dc2626)}',
  '/* #156 finishing fact: ledger phase failed but the newest installable build did get installed — green, not red. */',
  '.dsh-upd-bdone{color:var(--dsh-update-ok-border,#059669)}',
  '.dsh-upd-batch{--dsh-update-new-text:#dc2626}',
  '.dsh-upd-batch{--dsh-update-new-ok-text:#047857}',
  '@media (prefers-color-scheme: dark){.dsh-upd-batch{--dsh-update-new-text:#f87171}}',
  '@media (prefers-color-scheme: dark){.dsh-upd-batch{--dsh-update-new-ok-text:#34d399}}',
  '@media (forced-colors: active){.dsh-upd-bver-new{color:CanvasText}}',
  '@media (forced-colors: active){.dsh-upd-bver-new-ok{color:CanvasText}}',
  '.dsh-upd-blist{font-size:var(--dsh-update-panel-small-font-size,12.5px);margin-top:2px}',
  // 名单按钮同行：名单居左占满，按钮居右不换行；窄屏换行时按钮仍靠右。
  '.dsh-upd-browline{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
  '.dsh-upd-browline>.dsh-upd-blist{flex:1 1 auto;min-width:0;text-align:left;margin:0}',
  '.dsh-upd-browline>button{flex:none;margin:0;margin-left:auto}',
  // #176：失败横幅里两枚复制按钮成组；不然每颗按钮各吃一份 margin-left:auto，会被拉开到两处。
  '.dsh-upd-browline>.dsh-upd-bcopy{display:inline-flex;align-items:center;gap:10px;flex:none;margin-left:auto}',
  '.dsh-upd-browline>.dsh-upd-bcopy>button{flex:none;margin:0}',
  '.dsh-upd-batch-ledger{margin:8px 0 0;font-size:var(--dsh-update-panel-log-font-size,13px);opacity:.85}',
  '.dsh-upd-batch-more{margin-top:6px}',
  '.dsh-upd-batch-more button{font-size:12px}',
  // 确认态：红框红字，与「关闭」等中性按钮一眼区分；disabled 照旧置灰。
  '.dsh-upd-batch-more button[data-confirm="1"]{border-color:var(--dsh-update-bad-border,#dc2626);color:var(--dsh-update-bad-border,#dc2626)}',
  '.dsh-upd-batch-notice{margin-top:6px;font-size:var(--dsh-update-panel-small-font-size,12.5px);opacity:.85}',
  '.dsh-upd-bdetail-actions{margin:0 0 6px}',
  '.dsh-upd .dsh-upd-bdetail-actions button{font-size:12.5px}',
  '.dsh-upd-bdetail-notice{margin:0 0 6px;font-size:var(--dsh-update-panel-small-font-size,12.5px);opacity:.85}',
  '/* Detail dialog (#108): reuse kernel dialog scroll (body scroll + sticky heads); batch actions as fixed bar; legacy inline overflow:visible retired with inline removal. */',
  '.dsh-upd-overlay.dsh-upd-bdetail-dialog{z-index:10000}',
  '.dsh-upd-bdetail-dialog-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 0;margin-bottom:8px;border-bottom:1px dashed var(--dsh-update-border,#e5e7eb)}',
  '.dsh-upd-bdetail-dialog-bar .dsh-upd-bdetail-actions{margin:0}',
  '@media (prefers-color-scheme: dark){.dsh-upd-batch-title i{color:var(--dsh-update-focus,#93c5fd)}}',
  '@media (prefers-reduced-motion: reduce){.dsh-upd-batch *{transition:none !important;animation:none !important}}',
  // Batch check layout stability: reserve macro width + rows/summary heights + no scroll anchoring jumps.
  '.dsh-upd-batch{overflow-anchor:none}',
  '.dsh-upd-btable{overflow-anchor:none}',
  '.dsh-upd-batch-macros{display:flex;flex-wrap:wrap;align-items:center;gap:0}',
  '.dsh-upd-batch-macros button:first-child,.dsh-upd-batch-macros button[data-primary="1"]{min-width:6em;text-align:center}',
  '.dsh-upd-batch-sum,.dsh-upd-batch-ledger{min-height:1.6em}',
  '.dsh-upd-brow{min-height:28px}',
].join(String.fromCharCode(10))

/**
 * 批量面板的 Archive 皮肤（#20 同一套口径：只换颜色/字体/间距，不改顺序、不藏东西）。
 * 卷宗抬头右侧给大印章留 120px（与单插件面板档案头同一处理）。
 */
export const UPDATE_BATCH_PANEL_ARCHIVE_CSS = [
  '/* 批量面板的 Archive 皮肤：只换颜色/字体/间距；根上的大印章由 UPDATE_PANEL_ARCHIVE_CSS 负责。 */',
  '.dsh-upd[data-theme="archive"] .dsh-upd-batch-head{padding-right:120px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-batch-title{font-family:var(--dsh-update-font-serif);font-size:var(--dsh-update-panel-chapter-font-size,21px);letter-spacing:.04em}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-batch-title i{color:var(--dsh-update-primary)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-brow-main{background:transparent;border:0;color:var(--dsh-update-text)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-brow-main:hover{color:var(--dsh-update-primary)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-bname{font-family:var(--dsh-update-font-serif)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-bver{font-family:var(--dsh-update-font-mono);color:var(--dsh-update-text-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-bver-cur{opacity:.75}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-bver-new{color:var(--dsh-update-new-text,#b3261e)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-bver-new-ok{color:var(--dsh-update-new-ok-text,#1a7f37)}',
  '@media (prefers-color-scheme: dark){.dsh-upd[data-theme="archive"] .dsh-upd-batch{--dsh-update-new-ok-text:#8fd6a4}}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-batch{--dsh-update-new-text:#b3261e}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-batch{--dsh-update-new-ok-text:#1a7f37}',
  '@media (prefers-color-scheme: dark){.dsh-upd[data-theme="archive"] .dsh-upd-batch{--dsh-update-new-text:#ef8a7d}}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-batch-ledger{color:var(--dsh-update-text-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-batch-sum{color:var(--dsh-update-text)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-brow-set{border-top-color:var(--dsh-update-border)}',
  // 批量动作行贴原型（与单面板同口径：13px 紧凑、无最小宽、8px 间距；行内/详情/更多按钮小号 12px）。
  '.dsh-upd[data-theme="archive"] .dsh-upd-batch-macros{gap:8px}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-batch-macros button{font-size:13px;line-height:1.45;padding:6px 12px;margin:0;min-width:0}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-batch-macros button:first-child,.dsh-upd[data-theme="archive"] .dsh-upd-batch-macros button[data-primary="1"]{min-width:0}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-batch-macros button:not([data-primary="1"]){background:transparent}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-brow-actions button{font-size:12px;line-height:1.45;padding:4px 10px;margin:0;min-width:0;background:transparent}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-bdetail-actions button{font-size:12px;line-height:1.45;padding:4px 10px;margin:0;min-width:0;background:transparent}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-batch-more button{font-size:12px;line-height:1.45;padding:4px 10px;margin:0;min-width:0;background:transparent}',
  // prefs 开关贴幽灵口径（#106：以请重启/详情为基准——此前无覆盖，吃到底层 archive button 填充；沿用 border-strong/text，不独立设键；13px 与宏/名单行同档）。
  '.dsh-upd[data-theme="archive"] .dsh-upd-batch-prefs button{font-size:13px;line-height:1.45;padding:6px 12px;margin:0;min-width:0;background:transparent}',
  // 黄框名单行（只收敛不对齐规则，不声明横幅盒体布局）：标题行拉满，名单居左，按钮同行居右。
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner>.dsh-upd-browline{align-self:stretch;display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner>.dsh-upd-browline .dsh-upd-blist{flex:1 1 auto;min-width:220px;text-align:left;margin:0;color:var(--dsh-update-text-muted)}',
  '.dsh-upd[data-theme="archive"] .dsh-upd-banner>.dsh-upd-browline button{flex:none;margin:0;margin-left:auto;font-size:13px;line-height:1.45;padding:6px 12px;min-width:0;background:transparent}',
].join(String.fromCharCode(10))

// ---------- 挂载（多目标批量面板入口） ----------

function escapeHtml(text: string): string {
  // panel.ts 的同名内部件没有转出口，这里按同一口径本地复制（只这四行）。
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

const BATCH_PHASES: readonly BatchPhase[] = [
  'pending',
  'checking',
  'ready',
  'installing',
  'current',
  'done',
  'failed',
  'skipped',
]

/** 「忙失败占位」：宿主忙时先把占位写进队列再回 update-busy —— 那是排队，不是失败。 */
function isQueueBusyRow(row: BatchRowView): boolean {
  return asBatchPhase(row.phase) === 'failed' && row.error === 'update-busy'
}

/** 这一家在队里的位置（1..n；0=自己就在装、null=不在队里）：只认忙且有位置的队列视图。 */
function queuePositionOf(row: BatchRowView): number | null {
  const queue = asQueueLike(row.queue)
  if (!queue || queue.busy !== true) return null
  const position = queue.position
  return typeof position === 'number' && Number.isFinite(position) && position > 0 ? position : null
}

/**
 * 排队中：正在等前面那家装完。
 * 两条来源都认：① 宿主忙时把占位写进队列、会话里记成 failed+update-busy 的那档（面板必须翻回排队）；
 * ② 队列视图说这一家在等（position > 0）。自己正在装的那一行不算排队。
 */
function isQueuedRow(row: BatchRowView): boolean {
  const phase = asBatchPhase(row.phase)
  if (phase === 'installing') return false
  if (isQueueBusyRow(row)) return true
  if (isTerminalPhase(phase)) return false
  return queuePositionOf(row) !== null
}

/** 排队那一条自己的编号（取消排队要用；showOthers=false 时 waiting 里只有自己）。 */
function queuedRequestIdOf(row: BatchRowView): string | null {
  const queue = asQueueLike(row.queue)
  if (!queue || !Array.isArray(queue.waiting)) return null
  for (const entry of queue.waiting) {
    if (entry && typeof entry.requestId === 'string' && entry.requestId) return entry.requestId
  }
  return null
}

/** 单查要打的电话：该家自己的单插件查新版电话；老宿主没给行 phoneNames 就没有单查入口。 */
function singleCheckPhoneOf(row: BatchRowView): string | null {
  const phones = isObject(row.phoneNames) ? row.phoneNames : null
  if (!phones) return null
  const check = (phones as Record<string, unknown>)['updateCheck']
  return typeof check === 'string' && check ? check : null
}

/** 取消排队要打的电话：该家自己的单插件安装电话（带 cancelQueued 用）；老宿主不给就取消不了。 */
function cancelQueuePhoneOf(row: BatchRowView): string | null {
  const phones = isObject(row.phoneNames) ? row.phoneNames : null
  if (!phones) return null
  const install = phones['updateInstall']
  return typeof install === 'string' && install ? install : null
}

/** 合规版决议要打的电话：该家自己的单插件决议电话；老宿主没给即无兜底入口（诚实缺省）。 */
export function singleFallbackPhoneOf(row: BatchRowView): string | null {
  const phones = isObject(row.phoneNames) ? (row.phoneNames as Record<string, unknown>) : null
  if (!phones) return null
  const name = phones['updateCheckFallback']
  return typeof name === 'string' && name ? name : null
}

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

/**
 * 该行合规版兜底资格（#156，纯函数）：行失败任务的机读结论经翻译官重认，
 * 拦的正是该行当前更新目标才给。B 类（别家包）与认不出的失败回 null，
 * 调用方走通用老路；目标对不上当前远端版即视为旧失败，不指手画脚。
 *
 * #156 第四轮：先认行里的机读诊断（宿主在异步失败回包里补的包名/归因）——
 * 真机上插件标识（`life-<key>`）与 npm 包名不是一回事，只按标识认的话
 * 批量行这支按钮在真机上永远不出现；诊断认不出才退回原文认（老路一字不动）。
 */
export function batchFallbackCauseOf(row: BatchRowView): {
  kind: string
  packageName: string
  targetVersion: string
  windowMs: number | null
  windowSource: 'message' | 'unknown'
  publishedAtMs: number | null
} | null {
  try {
    if (asBatchPhase(row.phase) !== 'failed') return null
    const fail = jobFailureOf(row)
    if (!fail) return null
    const rowDiag = (row as { diag?: unknown }).diag
    const byDiag = fallbackCauseFromDiag(rowDiag, fail.detail, fail.code, latestVersionOf(row))
    const cause = byDiag ?? fallbackCauseFromDetail(fail.detail, fail.code, pluginIdOf(row))
    if (!cause) return null
    if (cause.targetVersion !== latestVersionOf(row)) return null
    return cause
  } catch {
    return null
  }
}

/**
 * 该行是不是「已经装上能装的最新（合规版），账本目标没装成」（#156 第一性原理收尾事实，纯函数）。
 *
 * 判据只看实时快照三件事：最近一次任务已到 restart-required/completed、磁盘上就是它的目标版本、
 * 而这个版本**不等于**账本目标。满足即说明这一家确实被装到了「能装的最新」，只是不是账本要的那一版。
 * 面板必须认出这个状态：既不许继续把它算成「安装失败」（那是撒谎），也不许明知装过还反复劝装。
 * 不断言原因（快照里没有那次失败的原文），原因由决议记忆另说（调用方给 unlock 时刻）。
 */
export function compliantInstalledOf(
  row: BatchRowView,
): { version: string; target: string; needsRestart: boolean } | null {
  try {
    if (!isObject(row.snapshot)) return null
    const snapshot = row.snapshot as Record<string, unknown>
    if (!isObject(snapshot['job'])) return null
    const job = snapshot['job'] as Record<string, unknown>
    const state = typeof job['state'] === 'string' ? job['state'] : ''
    if (state !== 'restart-required' && state !== 'completed') return null
    const version = typeof job['targetVersion'] === 'string' ? job['targetVersion'].trim() : ''
    if (!version) return null
    const installed = typeof snapshot['installedVersion'] === 'string' ? snapshot['installedVersion'].trim() : ''
    if (installed !== version) return null
    const target = latestVersionOf(row)
    if (!target || target === version) return null
    return { version, target, needsRestart: state === 'restart-required' }
  } catch {
    return null
  }
}

/**
 * 失败横幅的行集合（#176 单一真源）：失败横幅画哪些行，两枚批量复制按钮就复制哪些行，只此一份过滤。
 * 口径：相位 failed，但排队占位不算失败（忙时宿主的占位）、等重启不算失败（#156 M1），
 * 已装上合规版的行也不算失败（#156 收尾事实——最新版没装成，但这家确实装到了能装的最新）。
 * 顺序跟面板行序一致（调用方传什么顺序就什么顺序）。
 */
export function batchFailedRows(rows: readonly BatchRowView[]): BatchRowView[] {
  const out: BatchRowView[] = []
  for (const row of rows) {
    if (asBatchPhase(row.phase) !== 'failed') continue
    if (isQueueBusyRow(row)) continue
    if (row.error === 'pending-restart') continue
    if (compliantInstalledOf(row) !== null) continue
    out.push(row)
  }
  return out
}

/** 相位宽容读：认不出按 pending（坏回包不许把面板打挂，与队列/账本同一纪律）。 */
function asBatchPhase(value: unknown): BatchPhase {
  return typeof value === 'string' && (BATCH_PHASES as readonly string[]).includes(value)
    ? (value as BatchPhase)
    : 'pending'
}

/** 单插件快照宽容读：形状不对当没有（详情退回「正在读取更新状态…」）。 */
function asSnapshotLike(value: unknown): UpdateSnapshot | null {
  if (!isObject(value)) return null
  // #182：运行版本未知是合法状态（null）；只在既不是字符串也不是 null 时拒收。
  if (value['runningVersion'] !== null && typeof value['runningVersion'] !== 'string') return null
  if (typeof value['canInstall'] !== 'boolean') return null
  return value as unknown as UpdateSnapshot
}

function asQueueLike(value: unknown): VisibleQueue | null {
  if (!isObject(value) || typeof value['busy'] !== 'boolean') return null
  return value as unknown as VisibleQueue
}

/** 行中文名：调用方 titles 覆盖 > 宿主 title > 稳定键。 */
function titleOf(row: BatchRowView, titles: Record<string, string>): string {
  const override = titles[row.key]
  if (typeof override === 'string' && override) return override
  return row.title || row.key
}

/** 该行的插件标识：宿主给了用宿主的，没给用稳定键（跳过存储与诊断文本都认它）。 */
function pluginIdOf(row: BatchRowView): string {
  return typeof row.pluginId === 'string' && row.pluginId ? row.pluginId : row.key
}

/** 这一版是哪个版本：会话账本的远端版优先，退回快照里的远端版；都没有给 null（不猜）。 */
function latestVersionOf(row: BatchRowView): string | null {
  if (typeof row.targetVersion === 'string' && row.targetVersion) return row.targetVersion
  const snapshot = row.snapshot
  if (!isObject(snapshot)) return null
  const latest = snapshot['latestVersion']
  return typeof latest === 'string' && latest ? latest : null
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

/** 当前版本（运行版优先，退回磁盘版）；读不到给 null，不猜。缺席时永不采信运行版号（#134/US19）。 */
function currentVersionOf(row: BatchRowView): string | null {
  const snapshot = row.snapshot
  if (!isObject(snapshot)) return null
  if (snapshot['installed'] === false) return null
  const running = snapshot['runningVersion']
  if (typeof running === 'string' && running) return running
  const installed = snapshot['installedVersion']
  if (typeof installed === 'string' && installed) return installed
  return null
}

/**
 * 该行后台失败任务收尾时记下的真原因（该行快照里的 job）。
 * job.message 的形状由 ports.ts 冻结：失败时是「失败码」或「失败码: 详情」（详情是宿主原话）。
 * 只认失败／被打断的任务——跑着或已完成的 message 不是失败原因，不许拿来当诊断。
 * 拆不开就不硬拆：整串是包内已知稳定码就当码，否则整串当正文；返回 null 即这行没有可用记录。
 */
function jobFailureOf(row: BatchRowView): { code: string | null; detail: string | null } | null {
  const snapshot = isObject(row.snapshot) ? row.snapshot : null
  if (!snapshot) return null
  const job = isObject(snapshot['job']) ? snapshot['job'] : null
  if (!job) return null
  const state = typeof job['state'] === 'string' ? job['state'] : ''
  if (state !== 'failed' && state !== 'interrupted') return null
  const message = typeof job['message'] === 'string' ? job['message'].trim() : ''
  if (!message) return null
  const at = message.indexOf(':')
  if (at < 0) {
    return isKnownFailureCode(message) ? { code: message, detail: null } : { code: null, detail: message }
  }
  const code = message.slice(0, at).trim()
  const detail = message.slice(at + 1).trim()
  return { code: code || null, detail: detail || null }
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
    runningVersion: text(snapshot ? snapshot['runningVersion'] : null),
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

/**
 * 全部失败行的手工命令文本（#176）：有命令的行原样一行，没命令的行用 # 注释行占位，
 * 整段仍可安全粘终端（注释不会被执行、也不会漏掉哪一家没给命令）。
 * commands 是有效命令行数——失败横幅据此决定「复制手工命令」按钮置不置灰。
 */
export function batchFailedManualText(
  rows: readonly BatchRowView[],
  lang?: string | null,
  titles: Record<string, string> = {},
): { text: string; commands: number } {
  const l = langOf(lang)
  const lines: string[] = []
  let commands = 0
  for (const row of batchFailedRows(rows)) {
    const manual = typeof row.manual === 'string' ? row.manual : ''
    if (manual) {
      // 原样一行：复制的是用户该粘进终端的命令，一个字都不改写。
      lines.push(manual)
      commands += 1
      continue
    }
    const reason = manualAbsentReasonOf(asSnapshotLike(row.snapshot))
    const comment = reason
      ? // 「# 包名：无手工命令（原因）」——原因句只拼一次，别再套「当前没有可用的手工命令」整句。
        batchText('panel.manual.absent-comment', l, { reason: manualAbsentReasonTextOf(reason, l) })
      : batchText('panel.manual.absent-comment-unknown', l)
    lines.push('# ' + titleOf(row, titles) + '：' + comment)
  }
  return { text: lines.join('\n'), commands }
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
  if (!container || typeof container.innerHTML !== 'string') {
    throw new Error('[dsh-plugin-update] 挂载批量面板需要一个有 innerHTML 的容器')
  }
  if (!options || typeof options !== 'object') {
    throw new Error('[dsh-plugin-update] 挂载批量面板缺少配置：批量电话前缀 prefix 必填')
  }
  const phones = buildBatchPhoneNames(options.prefix)
  if (typeof options.call !== 'function') {
    throw new Error('[dsh-plugin-update] 挂载批量面板需要传输函数 call（面板调宿主电话的唯一接触面）')
  }
  const pollMs = options.pollMs === undefined ? BATCH_PANEL_POLL.defaultMs : options.pollMs
  if (typeof pollMs !== 'number' || !Number.isFinite(pollMs) || pollMs < BATCH_PANEL_POLL.minMs) {
    throw new Error(
      '[dsh-plugin-update] 批量面板轮询间隔非法：不得小于 250 毫秒（收到 ' + JSON.stringify(options.pollMs) + '）',
    )
  }
  let mode: BatchPanelMode = options.mode === undefined ? 'embedded' : options.mode
  if (mode !== 'embedded' && mode !== 'dialog') {
    throw new Error('[dsh-plugin-update] 摆放形态非法：只收 embedded 或 dialog（收到 ' + JSON.stringify(options.mode) + '）')
  }
  if (options.theme !== undefined && options.theme !== 'default' && options.theme !== 'archive') {
    throw new Error('[dsh-plugin-update] 主题非法：只收 default 或 archive（收到 ' + JSON.stringify(options.theme) + '）')
  }
  let theme: UpdatePanelTheme = normalizePanelTheme(options.theme ?? 'default')
  // 主题变量覆盖：挂载时校验（非法即抛），合法存下，每次 render 拼到根上（详情行经继承生效）。
  themeTokensStyleFor(options.themeTokens ?? undefined)
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
  const checkOnOpenOption = (options as unknown as Record<string, unknown>)['checkOnOpen'] !== false
  const autoResumeOption = (options as unknown as Record<string, unknown>)['autoResume'] !== false
  let lastSession: unknown = null
  let lastInventory: unknown = null
  let lastPrefs: unknown = null
  let lastCheckedAt = 0
  let autoCheckDone = false
  let autoResumeDone = false
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
      lastError = 'internal'
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
      lastError = null
      if (expandedKey !== null && !rows.some((row) => row.key === expandedKey)) expandedKey = null
      pruneFallbackOffers()
      return
    }
    const err = typeof reply['error'] === 'string' ? reply['error'].trim() : ''
    const kind = typeof reply['errorKind'] === 'string' ? reply['errorKind'].trim() : ''
    lastError = kind || err || 'internal'
  }

  async function refresh(): Promise<void> {
    if (!mounted || refreshing) return
    refreshing = true
    try {
      const reply = await call(phones.status, {})
      if (!mounted) return
      applyReply(reply)
    } catch {
      if (!mounted) return
      lastError = 'check-failed'
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
    if (!mounted || inFlight) return null
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
        say(batchText('batch.toast.queue-missed', currentLang()), busyRowKey)
        return null
      }
      applyReply(reply)
      // 批量查/装一次是明确意图：清掉各行失败退避，下面的按行链路可再问一次。
      rowFailedAt.clear()
      out = isObject(reply) ? (reply as Record<string, unknown>) : null
    } catch {
      if (!mounted) return null
      lastError = 'check-failed'
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

  function nowMs(): number {
    try {
      return Date.now()
    } catch {
      return 0
    }
  }

  async function act(kind: BatchPanelActionKind, key?: string): Promise<void> {
    if (!mounted) return
    // 点别的按钮，上膛的取消确认自动撤销（当即重绘，不等人）。
    if (kind !== 'cancel' && confirmCancelArmed) {
      confirmCancelArmed = false
      render()
    }
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

  /** 打开即查/续（#59 D3/Q3）：每挂载最多各一次；自动失败不弹红条，只留行上标记。 */
  async function autoOnce(): Promise<void> {
    if (!mounted) return
    if (autoResumeOption && !autoResumeDone) {
      autoResumeDone = true
      if (hasUnfinishedRows(rows, lastSession ?? undefined) && !inFlight && !refreshing) {
        const before = lastError
        try {
          const reply = await call(phones.resume, {})
          if (!mounted) return
          if (isObject(reply) && reply['ok'] === true) {
            applyReply(reply)
            const r = reply as Record<string, unknown>
            if (r['resumed'] !== false) {
              say(batchText('batch.notice.auto-resumed', currentLang(), { count: String(remainingCount()) }))
              rowFailedAt.clear()
            }
            render()
            maybeAutoRowChangelog(expandedKey)
            return
          }
          lastError = before
          render()
        } catch {
          if (mounted) render()
        }
      }
    }
    if (!autoCheckDone) {
      autoCheckDone = true
      if (!checkOnOpenEffective()) return
      if (hasUnfinishedRows(rows, lastSession ?? undefined)) return
      const stale = lastCheckedAt <= 0 || nowMs() - lastCheckedAt >= 60000
      if (!stale || inFlight || refreshing) return
      const before = lastError
      try {
        const reply = await call(phones.check, {})
        if (!mounted) return
        if (isObject(reply) && reply['ok'] === true) {
          applyReply(reply)
          rowFailedAt.clear()
          render()
          maybeAutoRowChangelog(expandedKey)
          return
        }
        lastError = before
        render()
      } catch {
        if (mounted) render()
      }
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
