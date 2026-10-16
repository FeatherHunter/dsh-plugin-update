/**
 * src/codes.ts —— 错误码的唯一定义处（#141；码面契约源自 #22，#138 定案「先立真源再加码」）。
 *
 * 为什么有这个文件：码原先至少散在八处（两个类型、宿主收敛表、批量两张认码表、面板文案表、
 * 双语门禁、字典快照与测试）。加一个码要手工同步八处，漏一处就是「面板不认、门禁不查、测试不知」。
 * 现在只在这里定义一次，其余全部派生：类型从数组取，门禁从 dist/codes.js 读，
 * 文案表按码型穷尽（缺一个码 TS 直接报错）。
 *
 * 用词提醒（CONTEXT.md:55-57）：词表里**错误码**是已定词（失败时回给面板的稳定短码，面板只对它分支）；
 * 「稳定码」是 #22 以来代码与门禁里沿用下来的工作名，规格（#5/#18/#6）落定前不算既成词——
 * 本文件沿用工作名，但不在这里给它下新定义。
 *
 * 三层码面（动手改之前先认准在哪一层）：
 * 1. 阻塞原因（`BLOCKED_REASONS`）：查完发现装不了的原因，是环境或包状态的事实，面板按它出阻塞横幅；
 * 2. 电话失败码（`PHONE_FAILURE_CODES`）：三个电话（查新版 / 装更新 / 批量）回包里的失败码；
 * 3. 入口自用码：`internal`（码不可信时的兜底，面板走人话兜底）、`unsupported`（只读半程的诚实失败）、
 *    `cross-scope`（批量入口拒绝跨使用范围）。
 *
 * 铁律（docs/maintainers.md:140-145 + docs/adr/0001）：
 * - 面板只认码，不认文案；
 * - **取值可增**属向后兼容扩展；改既有取值的语义 / 删值 / 改名要按冻结项走一次破冰讨论；
 * - 这里只有码本身，文案在 src/bilingual.ts（一码一组 title + action，双语门禁盯着）；
 * - 「未来码」不进这张表：未知码必须走人话兜底（面板 failureCopy 的 unknown 一族）。
 */

/** 装不了的原因：环境或包状态不满足，装前如实拒绝（面板阻塞横幅与失败行都按它取文案）。 */
export const BLOCKED_REASONS = [
  'unknown-profile',
  'channel-mismatch',
  'source-install',
  'invalid-installation',
  'installation-changed',
  'pending-restart',
  'registry-conflict',
  'incompatible-node',
  'recovery-required',
  'dev-source',
] as const
export type BlockedReason = (typeof BLOCKED_REASONS)[number]

/** 电话失败码：三个电话回包 `{ ok: false, error, errorKind }` 里的码。 */
export const PHONE_FAILURE_CODES = [
  'check-failed',
  'invalid-release',
  'check-expired',
  'update-busy',
  'install-failed',
] as const
export type PhoneFailureCode = (typeof PHONE_FAILURE_CODES)[number]

/**
 * 查侧失败码（#134）：查电话与装电话的失败码里，「查的那一半」出的那三个。
 * 查装分家的依据——面板失败行按它决定标题打头的是「查失败」还是「装失败」。
 * 从 PHONE_FAILURE_CODES 派生（satisfies 钉住拼写），不许在面板另建第二张表（#141 单点真源铁律）。
 */
export const CHECK_SIDE_FAILURE_CODES = [
  'check-failed',
  'invalid-release',
  'check-expired',
] as const satisfies readonly PhoneFailureCode[]
export type CheckSideFailureCode = (typeof CHECK_SIDE_FAILURE_CODES)[number]

/** 码不可信时的兜底码：errorKind 认不出即按它走人话兜底，不拿 error 那格猜。 */
export const INTERNAL_CODE = 'internal' as const

/** 只读半程的诚实失败码：安装能力还没接上时用它（src/service.ts 的 install）。 */
export const UNSUPPORTED_CODE = 'unsupported' as const

/** 批量入口的跨使用范围拒绝码：不替调用方跨范围抢锁（src/host-batch.ts）。 */
export const CROSS_SCOPE_CODE = 'cross-scope' as const

/** 面板口径的全表：阻塞 + 电话 + internal（面板文案与分支的完备面，双语门禁按它查）。 */
export const STABLE_CODES = [...BLOCKED_REASONS, ...PHONE_FAILURE_CODES, INTERNAL_CODE] as const

/** 核心码面：电话与任务说明里可能出现的码（电话 + 阻塞），不含各入口的自用码。 */
export const CORE_ERROR_CODES = [...PHONE_FAILURE_CODES, ...BLOCKED_REASONS] as const
export type CoreErrorCode = (typeof CORE_ERROR_CODES)[number]

/** 公开错误码（src/ports.ts 的 UpdateErrorCode）：核心码面 + 只读半程的诚实失败码。 */
export type UpdateErrorCode = CoreErrorCode | typeof UNSUPPORTED_CODE

/** 批量电话与队列认的码：核心码面 + 本入口自己的跨范围拒绝码。 */
export const BATCH_REPLY_CODES = [...CORE_ERROR_CODES, CROSS_SCOPE_CODE] as const
export type BatchReplyCode = (typeof BATCH_REPLY_CODES)[number]

/** 归属判断：码面是 readonly 字面量元组，`includes(string)` 过不了类型检查，统一从这里走。 */
function isOneOf(codes: readonly string[], code: unknown): boolean {
  return typeof code === 'string' && codes.includes(code)
}

/** 是核心码吗（宿主收敛表据此决定原样回码还是收敛为检查失败）。 */
export function isCoreErrorCode(code: unknown): code is CoreErrorCode {
  return isOneOf(CORE_ERROR_CODES, code)
}

/** 是批量入口认的码吗（批量电话与队列据此决定原样回码还是收敛）。 */
export function isBatchReplyCode(code: unknown): code is BatchReplyCode {
  return isOneOf(BATCH_REPLY_CODES, code)
}

/** 是查侧失败码吗（面板失败行查装分家用；装侧另两个码 update-busy/install-failed 不进）。 */
export function isCheckSideFailureCode(code: unknown): code is CheckSideFailureCode {
  return typeof code === 'string' && isOneOf(CHECK_SIDE_FAILURE_CODES, code.trim())
}
