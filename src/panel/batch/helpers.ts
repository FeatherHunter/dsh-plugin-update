/**
 * src/panel/batch/helpers.ts —— 批量面板的共享底座（#229 自旧 src/panel-batch.ts 拆出）。
 *
 * 最底层：行/队列/会话形状归一、转义、版本比较、回退原因与失败文案、电话名拼法。
 * 被 ledger/render/mount 三层共用；不反向依赖任何上层。
 */

import { assertPrefix, MIN_PANEL_POLL_MS } from '../../shared/config.js'
import { isTerminalPhase } from '../../core/batch/model.js'
import { fallbackCauseFromDetail, fallbackCauseFromDiag, isKnownFailureCode } from '../../panel.js'
import type { BatchPhase } from '../../core/batch/model.js'
import type { UpdateSnapshot } from '../../shared/ports.js'
import type { VisibleQueue } from '../../core/queue/model.js'
import type { BatchPhoneNames, BatchRowView } from '../../panel-batch.js'

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

export function escapeHtml(text: string): string {
  // panel.ts 的同名内部件没有转出口，这里按同一口径本地复制（只这四行）。
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function isObject(value: unknown): value is Record<string, unknown> {
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
export function isQueueBusyRow(row: BatchRowView): boolean {
  return asBatchPhase(row.phase) === 'failed' && row.error === 'update-busy'
}

/** 这一家在队里的位置（1..n；0=自己就在装、null=不在队里）：只认忙且有位置的队列视图。 */
export function queuePositionOf(row: BatchRowView): number | null {
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
export function isQueuedRow(row: BatchRowView): boolean {
  const phase = asBatchPhase(row.phase)
  if (phase === 'installing') return false
  if (isQueueBusyRow(row)) return true
  if (isTerminalPhase(phase)) return false
  return queuePositionOf(row) !== null
}

/** 排队那一条自己的编号（取消排队要用；showOthers=false 时 waiting 里只有自己）。 */
export function queuedRequestIdOf(row: BatchRowView): string | null {
  const queue = asQueueLike(row.queue)
  if (!queue || !Array.isArray(queue.waiting)) return null
  for (const entry of queue.waiting) {
    if (entry && typeof entry.requestId === 'string' && entry.requestId) return entry.requestId
  }
  return null
}

/** 单查要打的电话：该家自己的单插件查新版电话；老宿主没给行 phoneNames 就没有单查入口。 */
export function singleCheckPhoneOf(row: BatchRowView): string | null {
  const phones = isObject(row.phoneNames) ? row.phoneNames : null
  if (!phones) return null
  const check = (phones as Record<string, unknown>)['updateCheck']
  return typeof check === 'string' && check ? check : null
}

/** 取消排队要打的电话：该家自己的单插件安装电话（带 cancelQueued 用）；老宿主不给就取消不了。 */
export function cancelQueuePhoneOf(row: BatchRowView): string | null {
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
export function asBatchPhase(value: unknown): BatchPhase {
  return typeof value === 'string' && (BATCH_PHASES as readonly string[]).includes(value)
    ? (value as BatchPhase)
    : 'pending'
}

/** 单插件快照宽容读：形状不对当没有（详情退回「正在读取更新状态…」）。 */
export function asSnapshotLike(value: unknown): UpdateSnapshot | null {
  if (!isObject(value)) return null
  // #182：运行版本未知是合法状态（null）；只在既不是字符串也不是 null 时拒收。
  if (value['runningVersion'] !== null && typeof value['runningVersion'] !== 'string') return null
  if (typeof value['canInstall'] !== 'boolean') return null
  return value as unknown as UpdateSnapshot
}

export function asQueueLike(value: unknown): VisibleQueue | null {
  if (!isObject(value) || typeof value['busy'] !== 'boolean') return null
  return value as unknown as VisibleQueue
}

/** 行中文名：调用方 titles 覆盖 > 宿主 title > 稳定键。 */
export function titleOf(row: BatchRowView, titles: Record<string, string>): string {
  const override = titles[row.key]
  if (typeof override === 'string' && override) return override
  return row.title || row.key
}

/** 该行的插件标识：宿主给了用宿主的，没给用稳定键（跳过存储与诊断文本都认它）。 */
export function pluginIdOf(row: BatchRowView): string {
  return typeof row.pluginId === 'string' && row.pluginId ? row.pluginId : row.key
}

/** 这一版是哪个版本：会话账本的远端版优先，退回快照里的远端版；都没有给 null（不猜）。 */
export function latestVersionOf(row: BatchRowView): string | null {
  if (typeof row.targetVersion === 'string' && row.targetVersion) return row.targetVersion
  const snapshot = row.snapshot
  if (!isObject(snapshot)) return null
  const latest = snapshot['latestVersion']
  return typeof latest === 'string' && latest ? latest : null
}

/** 当前版本（运行版优先，退回磁盘版）；读不到给 null，不猜。缺席时永不采信运行版号（#134/US19）。 */
export function currentVersionOf(row: BatchRowView): string | null {
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
export function jobFailureOf(row: BatchRowView): { code: string | null; detail: string | null } | null {
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
