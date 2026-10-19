/**
 * src/panel/batch/ledger.ts —— 批量面板「总账」层（#229 自旧 src/panel-batch.ts 总账段拆出）。
 *
 * 只做纯计算：一句话总账、分类计数、每行状态词/版本单元/待办词。产出是纯值或 HTML 片段串，
 * 不碰 DOM、不碰网络。
 * 向下依赖 helpers；向上不依赖。
 */

import { copyText as bilingualText } from '../../core/i18n/text.js'
import { normalizeLangTag, resolveLang } from '../../shared/lang.js'
import { compareReleaseVersions } from '../../core/service.js'
import { isTerminalPhase } from '../../core/batch/model.js'
import { isCheckSideFailureCode } from '../../panel.js'
import type { BilingualKey } from '../../core/i18n/dictionary.js'
import type { AppLang, LocaleOption } from '../../shared/lang.js'
import type { BatchPhase } from '../../core/batch/model.js'
import { asBatchPhase, currentVersionOf, escapeHtml, isObject, isQueueBusyRow, jobFailureOf } from './helpers.js'
import type { BatchRowView } from '../../panel-batch.js'

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
 * core/queue/model.ts 的 position 是 waiting 顺位（队首为 1、0 = 自己正在装），而正在装的那一家也压在这一家前面，
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

export function knowledgeEntryOf(inventory: unknown, key: string): BatchKnowledgeEntry | null {
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

export function langOf(lang: unknown): AppLang {
  try {
    return normalizeLangTag(typeof lang === 'string' ? lang : resolveLang(lang as LocaleOption))
  } catch {
    return 'zh'
  }
}

export function batchText(key: BilingualKey, lang: unknown, values?: Record<string, unknown>): string {
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
export function isInUnfinishedRound(session: unknown, key: string): boolean {
  const entries = sessionEntriesOf(session)
  if (entries === null) return false
  return entries.some((entry) => entry['key'] === key && isUnfinishedEntry(entry))
}

/** 会话里该行的 updatedAt（没有会话/没有该行即 null，调用方按无历史处理）。 */
export function sessionUpdatedAtOf(session: unknown, key: string): number | null {
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
export function worldUpdateVersion(
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
export function restartUnregistered(row: BatchRowView): boolean {
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
export function batchRowVersionHTML(row: BatchRowView, knowledge: BatchKnowledgeEntry | null, lang?: unknown): string {
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
