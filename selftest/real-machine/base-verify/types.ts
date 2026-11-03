/**
 * selftest/real-machine/base-verify/types.ts —— base dsh-verify 黑盒适配层的共享类型。
 *
 * 所有形状都以 base 的公开 CLI 契约（exit code、--json 报告、run.json 侧车）为准，
 * 不 import base 的私有实现：适配层把 base 当外部命令，读它写下的 JSON 与文件。
 */

/** 我们对一条 base 命令的判定：pass / fail / unknown。unknown 覆盖 base 的 blocked 与工具错误，永不算通过。 */
export type BaseCommandVerdict = 'pass' | 'fail' | 'unknown'

/** base 的退出码语义：0=全过（允许 skip）、1=hard fail、2=blocked（什么都没证明）。 */
export type BaseExitCode = 0 | 1 | 2

/** CheckResult.blockedReason 的结构（base 契约里 code 是三选一，这里保留原文不丢信息）。 */
export interface BaseBlockedReason {
  readonly code: string
  readonly message: string
  readonly hint?: string
}

/** base --json 报告里 checks 的一项（只声明适配层要读的字段，未知字段忽略）。 */
export interface BaseCheckResult {
  readonly id: string
  readonly title?: string
  readonly hard?: boolean
  readonly status: 'pass' | 'fail' | 'skip' | 'blocked'
  readonly detail?: string
  readonly expected?: string
  readonly actual?: string
  readonly hint?: string
  readonly blockedReason?: { readonly code?: string; readonly message?: string; readonly hint?: string }
  readonly durationMs?: number
}

/** base --json 报告（RunReport）里适配层要读的字段。 */
export interface BaseRunReport {
  readonly schemaVersion?: number
  readonly capability?: string
  readonly command?: string
  readonly profile?: string
  readonly state?: string
  readonly exitCode?: number
  readonly checks?: readonly BaseCheckResult[]
  readonly artifacts?: Readonly<Record<string, string>>
  readonly notes?: readonly string[]
}

/** 报告里四种检查状态的计数（skip 是「不适用」，与 pass 分开报）。 */
export interface BaseCheckTally {
  readonly pass: number
  readonly fail: number
  readonly skip: number
  readonly blocked: number
}

/** 一条 base 命令的完整记录（stdout/stderr 原文另存证据目录，不入汇总）。 */
export interface BaseCommandRecord {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly exitCode: number | null
  readonly signal: string | null
  readonly timedOut: boolean
  readonly durationMs: number
  readonly verdict: BaseCommandVerdict
  readonly detail: string
  readonly toolError?: string
  readonly tally?: BaseCheckTally
  readonly blockedReasons?: readonly BaseBlockedReason[]
  readonly report?: BaseRunReport
  readonly reportPath?: string
  readonly reportSha256?: string
  readonly stdout: string
  readonly stderr: string
}

/** 证据目录里保存的调用记录（raw/base-verify/<command>/invocation.json）。 */
export interface BaseInvocationRecord {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly exitCode: number | null
  readonly signal: string | null
  readonly timedOut: boolean
  readonly durationMs: number
  readonly verdict: BaseCommandVerdict
  readonly detail: string
  readonly toolError?: string
  readonly tally?: BaseCheckTally
  readonly blockedReasons?: readonly BaseBlockedReason[]
  readonly reportPath?: string
  readonly reportSha256?: string
}
