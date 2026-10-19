/**
 * src/check-conclusion.ts —— 检查结论编排（#163 故事 3 收尾：从 service.ts 独立）。
 *
 * 查失败了贴什么阶段、报什么稳定码、认谁触发的：五个纯函数，无 I/O。
 * 只依赖类型（ports/registry-fetch 的 type-only import），零值导入；
 * service.ts 按内部 import 引用，不进包导出表（#159 冻结）。
 */

import type { CheckTrigger, InstallSource } from './shared/ports.js'
import type { FetchStage } from './registry-fetch.js'

/**
 * 给错误贴一个取数阶段（#124）：核心只用它写 `update.check.fail.stage`，不参与归类决策。
 * 贴不上的按码兜底——`check-failed` 是没连上/没取到（fetch），其余是拿到了但内容或通道不认（verify）。
 */
export function stageOfError(error: unknown): FetchStage {
  const stage = (error as { stage?: unknown } | null)?.stage
  if (stage === 'fetch' || stage === 'compare' || stage === 'channel' || stage === 'verify') return stage
  return (error as { code?: unknown } | null)?.code === 'check-failed' ? 'fetch' : 'verify'
}

/** 稳定码（#124）：行里只许稳定码，不许自由文本；没有码就给 `internal`（与 diag 同一口径）。 */
export function stableCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && code ? code : 'internal'
}

/** HTTP 状态码（#124）：只有取数阶段真的带回来才写，不猜。 */
export function httpStatusOfError(error: unknown): number | null {
  const status = (error as { httpStatus?: unknown } | null)?.httpStatus
  return typeof status === 'number' && Number.isInteger(status) ? status : null
}

/**
 * 检查失败的细类别（#211，审查 S2-3）：**日志专用**枚举，只写进 `update.check.fail.errorKind`，
 * 绝不改变公开稳定码（`stableCodeOf` 那条路仍回 check-failed / invalid-release 等旧码，
 * 面板回执与诊断副本一字不动）。老错误没有标签即 `unknown`——未知如实记录，不猜。
 */
export const CHECK_ERROR_KINDS = [
  'timeout',
  'network',
  'dns',
  'tls',
  'http',
  'bad-json',
  'too-large',
  'shape',
  'channel',
  'unknown',
] as const
export type CheckErrorKind = (typeof CHECK_ERROR_KINDS)[number]

/**
 * 抛错上的内部成因键（#211）：registry-fetch 在各 throw 处贴（不可枚举属性，
 * 不改变错误码/消息/既有 detail 形状），本文件只读它做映射。
 */
export const CHECK_FAIL_CAUSE_KEY = 'checkFailCause'

/** 细类别映射（#211）：认不出标签/没有标签一律 `unknown`，永不外抛。 */
export function checkErrorKindOf(error: unknown): CheckErrorKind {
  try {
    const cause = (error as Record<string, unknown> | null | undefined)?.[CHECK_FAIL_CAUSE_KEY]
    return typeof cause === 'string' && (CHECK_ERROR_KINDS as readonly string[]).includes(cause)
      ? (cause as CheckErrorKind)
      : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** 安装意图来源（#124）：认不出或没报都按 `panel`（电话的既有调用方是面板）。 */
export function installSourceOf(value: unknown): InstallSource {
  return value === 'entry' || value === 'batch' ? value : 'panel'
}

/**
 * 检查触发方（#124）：只有调用方**自报**了合法取值才认，认不出返回 null。
 * 原因：宿主侧只能看到「有人在问」，分不清用户点的还是自动跑的（`pendingAutoCheck` 走同一支电话）；
 * 猜一个 `'user'` 会在自动检查时留下口径相反的行，宁可不发（由触发方在客户端侧打点，见 W1 目录 ③）。
 */
export function triggerOf(value: unknown): CheckTrigger | null {
  return value === 'auto' || value === 'user' || value === 'batch' || value === 'entry' ? value : null
}
