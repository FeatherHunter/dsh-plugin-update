/**
 * selftest/real-machine/base-verify/runner.ts —— base CLI 的 typed runner（黑盒）。
 *
 * 只做四件事：拿 describe --json 的命令表、按 args 数组起子进程（不经 shell）、
 * 收 exit/stdout/stderr/耗时、把 base 的退出码映射成我们的判定：
 *   exit 0 → pass；exit 1 → fail；exit 2 → blocked，映射成我们的 unknown（不算通过）。
 * 参数/用法错误（exit 2 但没有 blocked 报告）、拿不到报告、超时一律 unknown + toolError，
 * 因为「没证明」和「产品坏了」必须分开记。
 */
import { runCommand } from '../../tooling/process.ts'
import type { CommandResult } from '../../tooling/process.ts'
import { commandLine, formatError } from '../../tooling/process.ts'
import type {
  BaseBlockedReason,
  BaseCheckResult,
  BaseCheckTally,
  BaseCommandRecord,
  BaseCommandVerdict,
  BaseRunReport,
} from './types.ts'

/** base 全局旗标：--json 时 stdout 只有一段 JSON（人话在 stderr）。 */
export const BASE_JSON_FLAG = '--json'

/** 跑一条 base 命令的入参。 */
export interface BaseCommandRequest {
  readonly cliPath: string
  readonly command: string
  readonly args?: readonly string[]
  readonly cwd: string
  readonly env?: Record<string, string | undefined>
  readonly timeoutMs?: number
}

/** describe --json 里命令表的一项（只声明适配层要读的字段）。 */
export interface BaseCommandDeclaration {
  readonly name: string
  readonly layer?: string
  readonly summary?: string
  readonly usage?: string
  readonly writes?: boolean
}

/** describe --json 的机器可读命令表。 */
export interface BaseDescribe {
  readonly capability?: string
  readonly schemaVersion?: number
  readonly commands?: readonly BaseCommandDeclaration[]
  readonly exitCodes?: Readonly<Record<string, number>>
}

function parseJsonDocument(text: string): { value?: unknown; error?: string } {
  const trimmed = text.trim()
  if (trimmed === '') return { error: 'stdout 为空，没有 --json 输出' }
  try {
    return { value: JSON.parse(trimmed) as unknown }
  } catch (error) {
    return { error: 'stdout 不是合法 JSON：' + formatError(error) }
  }
}

function asReport(value: unknown): { report?: BaseRunReport; error?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { error: '--json 输出不是对象' }
  const report = value as BaseRunReport
  if (report.capability !== undefined && report.capability !== 'real-machine-verification') {
    return { error: '--json 报告的 capability=' + JSON.stringify(report.capability) + '，不是 real-machine-verification' }
  }
  return { report }
}

/** 报告里四种检查状态的计数。 */
export function tallyChecks(checks: readonly BaseCheckResult[] | undefined): BaseCheckTally {
  const tally = { pass: 0, fail: 0, skip: 0, blocked: 0 }
  for (const check of checks ?? []) {
    if (check.status === 'pass') tally.pass += 1
    else if (check.status === 'fail') tally.fail += 1
    else if (check.status === 'skip') tally.skip += 1
    else if (check.status === 'blocked') tally.blocked += 1
  }
  return tally
}

/** 把所有 blocked 检查的结构化原因抽出来（保留 base 原文，不重新解释）。 */
export function collectBlockedReasons(report: BaseRunReport | undefined): BaseBlockedReason[] {
  const reasons: BaseBlockedReason[] = []
  for (const check of report?.checks ?? []) {
    const reason = check.blockedReason
    if (!reason) continue
    const code = typeof reason.code === 'string' && reason.code !== '' ? reason.code : 'prerequisite-missing'
    const message = typeof reason.message === 'string' && reason.message !== '' ? reason.message : '（base 未给出 message，检查 ' + check.id + '）'
    const hint = typeof reason.hint === 'string' && reason.hint !== '' ? reason.hint : undefined
    reasons.push({ code, message, ...(hint ? { hint } : {}) })
  }
  return reasons
}

/** 退出码 + 报告 → 我们的判定（四态映射的唯一实现处）。 */
function classifyExit(result: CommandResult, report: BaseRunReport | undefined, parseError: string | undefined): {
  verdict: BaseCommandVerdict
  detail: string
  toolError?: string
} {
  if (result.exitCode === null) {
    return {
      verdict: 'unknown',
      detail: '进程未正常结束（超时/信号终止，耗时 ' + result.durationMs + 'ms）',
      toolError: 'exit=null' + (result.signal ? '，signal=' + result.signal : ''),
    }
  }
  if (result.exitCode === 0) {
    if (!report) return { verdict: 'unknown', detail: 'exit 0 但拿不到 --json 报告：' + (parseError ?? '报告缺失'), toolError: parseError ?? '报告缺失' }
    return { verdict: 'pass', detail: 'exit 0；state=' + (report.state ?? '（未声明）') }
  }
  if (result.exitCode === 1) {
    return { verdict: 'fail', detail: report ? 'exit 1 硬失败；state=' + (report.state ?? '（未声明）') : 'exit 1 硬失败（无可解析报告）' }
  }
  if (result.exitCode === 2) {
    if (report && report.state === 'blocked') {
      return { verdict: 'unknown', detail: 'exit 2 blocked：前置/适配器缺失，本次什么都没证明' }
    }
    return {
      verdict: 'unknown',
      detail: 'exit 2 但不是 blocked 报告（参数/用法或工具错误）',
      toolError: parseError ?? 'state=' + (report ? String(report.state) : '无报告'),
    }
  }
  return { verdict: 'unknown', detail: '未知退出码 ' + String(result.exitCode), toolError: 'exit=' + String(result.exitCode) }
}

/** 跑一条 base 命令并返回完整记录；不抛（工具错误落在 toolError 上）。 */
export async function runBaseCommand(request: BaseCommandRequest): Promise<BaseCommandRecord> {
  const args = [request.cliPath, request.command, ...(request.args ?? []), BASE_JSON_FLAG]
  const rendered = commandLine(process.execPath, args)
  let result: CommandResult
  try {
    result = runCommand(process.execPath, args, {
      cwd: request.cwd,
      env: request.env ?? process.env,
      timeoutMs: request.timeoutMs ?? 120000,
    })
  } catch (error) {
    result = {
      command: process.execPath,
      args,
      cwd: request.cwd,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: formatError(error),
      durationMs: 0,
    }
  }
  const parsed = parseJsonDocument(result.stdout)
  const normalized = parsed.value === undefined ? { error: parsed.error } : asReport(parsed.value)
  const report = normalized.report
  let classification = classifyExit(result, report, normalized.error)
  // 报告自述命令必须与本次调用一致；不一致视为身份/接线错误，不能算 pass。
  if (report && typeof report.command === 'string' && report.command !== request.command) {
    classification = {
      verdict: 'unknown',
      detail: '报告 command=' + JSON.stringify(report.command) + ' 与调用命令 ' + JSON.stringify(request.command) + ' 不一致',
      toolError: '报告命令不一致：' + rendered,
    }
  }
  return {
    command: request.command,
    args: args.slice(1),
    cwd: request.cwd,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.exitCode === null,
    durationMs: result.durationMs,
    verdict: classification.verdict,
    detail: classification.detail,
    ...(classification.toolError ? { toolError: classification.toolError } : {}),
    ...(report ? { tally: tallyChecks(report.checks), blockedReasons: collectBlockedReasons(report) } : {}),
    ...(report ? { report } : {}),
    ...(report?.artifacts?.report ? { reportPath: report.artifacts.report } : {}),
    ...(report?.artifacts?.reportSha256 ? { reportSha256: report.artifacts.reportSha256 } : {}),
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

/** 读 base 的机器可读命令表（describe --json）；解析失败返回 error 而不是抛。 */
export async function describeBase(options: { cliPath: string; cwd: string; env?: Record<string, string | undefined>; timeoutMs?: number }): Promise<{
  ok: boolean
  describe?: BaseDescribe
  error?: string
}> {
  const result = runCommand(process.execPath, [options.cliPath, 'describe', BASE_JSON_FLAG], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    timeoutMs: options.timeoutMs ?? 30000,
  })
  const parsed = parseJsonDocument(result.stdout)
  if (parsed.value === undefined) return { ok: false, error: parsed.error }
  if (typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
    return { ok: false, error: 'describe 输出不是对象' }
  }
  const describe = parsed.value as BaseDescribe
  if (describe.capability !== undefined && describe.capability !== 'real-machine-verification') {
    return { ok: false, error: 'describe.capability=' + JSON.stringify(describe.capability) }
  }
  if (result.exitCode !== 0) return { ok: false, error: 'describe exit=' + String(result.exitCode) }
  return { ok: true, describe }
}
