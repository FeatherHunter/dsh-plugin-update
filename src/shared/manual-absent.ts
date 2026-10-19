// src/shared/manual-absent.ts —— #92：手工命令为空时「为什么没有」的原因分类（纯函数，单一真源）。
//
// 背景：05 章在拿不到手工命令时只剩一句含糊话（「使用范围无法识别或源码安装场景不提供」），
// 而空态实际原因各不相同（源码安装 / 开发态挂载 / 范围认不出 / 运行版未知 / 没有安全候选），
// 用户照着那句猜不到自己该做什么。
//
// 本文件只决定「说什么」，不决定「给不给命令」——给命令的门槛由 manualCommand 与冻结政策决定：
//   #98 不降级、#153 不覆盖源码安装、#182 运行版未知不猜、#201 命令必须可执行。
// 所以这里没有「放宽」路径：分类只是把已有的拒绝理由翻译成原因 + 下一步。
// 判不出时由调用方决定用兜底句（`panel.manual.absent`），绝不硬编一个没验证过的原因。
import { copyText } from '../core/i18n/text.js'
import type { BilingualKey } from '../core/i18n/dictionary.js'
import { manualCommandSuppressedBy } from './commands.js'
import { normalizeLangTag, type AppLang } from './lang.js'
import type { UpdateSnapshot } from './ports.js'

/** 手工命令为空的五种可解释原因；判不出时由调用方决定用兜底句。 */
export type ManualAbsentReason =
  | 'unknown-profile'
  | 'source-install'
  | 'dev-source'
  | 'running-unknown'
  | 'no-safe-candidate'

const REASON_KEYS: Record<ManualAbsentReason, BilingualKey> = {
  'unknown-profile': 'panel.manual.absent.unknown-profile',
  'source-install': 'panel.manual.absent.source-install',
  'dev-source': 'panel.manual.absent.dev-source',
  'running-unknown': 'panel.manual.absent.running-unknown',
  'no-safe-candidate': 'panel.manual.absent.no-safe-candidate',
}

/**
 * 从单插件快照读出空态原因（只读已判好的事实，不重新推断能不能给命令）：
 * - 快照里的 blockedReason 直说三类真实拒绝（源码安装 / 开发态 / 范围认不出）；判据与
 *   `manualCommand` 的早退共用（`manualCommandSuppressedBy`），不另抄一份原因表；
 * - 运行版本未知（#182）单独一类，不并进「没有安全候选」：null 与空串都是命令侧认的未知；
 * - 其余（含无快照）判不出具体原因：无快照 / 旧快照缺格回 null 用兜底句，
 *   有快照且运行版本可读时落「没有安全候选」。
 */
export function manualAbsentReasonOf(snapshot: UpdateSnapshot | null | undefined): ManualAbsentReason | null {
  if (!snapshot || typeof snapshot !== 'object') return null
  const blocked = snapshot.blockedReason
  if (manualCommandSuppressedBy(blocked)) return blocked
  // 运行版本未知（#182）：null 是定义里的未知，空串在 manualCommand 里同样当未知。
  // 旧外部快照可能连这一格都没有（undefined）——那是判不出，不是「未知已知」，走兜底句。
  const running = snapshot.runningVersion as unknown
  if (running === null || running === '') return 'running-unknown'
  if (typeof running !== 'string') return null
  return 'no-safe-candidate'
}

/**
 * 哪些横幅状态下 05 章才该按原因解释「为什么没有命令」：用户本该拿到命令的状态
 * （失败 / 待重启 / 受阻 / 可更新）。读取中、已最新这类状态不涉及命令，仍给中性兜底句。
 * 面板分支与这里共用一张表，新增横幅种类时只改这一处。
 */
const MANUAL_APPLICABLE_BANNER_KINDS = ['failed', 'restart', 'blocked', 'update'] as const

export function manualAppliesToBanner(kind: string): boolean {
  return (MANUAL_APPLICABLE_BANNER_KINDS as readonly string[]).includes(kind)
}

/** 只给原因句（不含「没有手工命令」那句抬头），批量注释行这类已带抬头的位置用。 */
export function manualAbsentReasonTextOf(reason: ManualAbsentReason | null, lang?: AppLang | string | null): string {
  if (!reason) return copyText('panel.manual.absent', lang)
  return copyText(REASON_KEYS[reason], lang)
}

/**
 * 完整空态句：「当前没有可用的手工命令。」+ 原因句。
 * 中文直接相接，英文按词间习惯加一个空格；抬头与原因句都只在本文件拼一次，别处复用这两个函数。
 */
export function manualAbsentTextOf(reason: ManualAbsentReason | null, lang?: AppLang | string | null): string {
  if (!reason) return manualAbsentReasonTextOf(null, lang)
  const joiner = normalizeLangTag(lang) === 'en' ? ' ' : ''
  return manualAbsentReasonTextOf(null, lang) + joiner + manualAbsentReasonTextOf(reason, lang)
}
