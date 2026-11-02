/**
 * selftest/real-machine/base-verify/preflight.ts —— 预检编排：capability 门 → 隔离 home → 自写 install → self-check → single-instance。
 *
 * 给两类调用方用：
 *   - T9/T10 快速通道：拿本仓 dist tgz 跑一遍，确认「装得上、能起、面板/日志检查有结论」；
 *   - T11 门三预检：在正式证据轮之前先跑一次，blocked/fail 早暴露。
 *
 * 关键约束：
 *   - 绝不写调用方给的 home：整个流程只操作 <out>/home 这份副本；
 *   - 一次只跑一个实例（single-instance 本身起一个 headless web 宿主），跑完由 base 负责 teardown；
 *   - base 的 run 目录连同 run.json 侧车整份拷进 <out>/raw/base-verify/<command>/；
 *   - 退出码：0=全 pass、1=有 fail、2=blocked/工具错（blocked 映射成 unknown，永不算通过）。
 */
import { cp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { directoryExists, ensureDir, writeJsonFile } from '../../tooling/fs-utils.ts'
import { formatError } from '../../tooling/process.ts'
import { captureBaseRunArtifacts } from './artifacts.ts'
import { checkBaseCapability, repositoryRoot } from './capability.ts'
import { installTarballIntoProfile } from './install-tarball.ts'
import { runBaseCommand } from './runner.ts'
import type { BaseBlockedReason, BaseCheckTally, BaseCommandRecord, BaseCommandVerdict } from './types.ts'

/** 本仓的 npm 包名（与 verify/profile.ts 的 packageName 一致）。 */
export const SELF_PACKAGE_NAME = 'dsh-plugin-update'

/** self-check 的默认超时（light：只查运行环境与已装产物）。 */
export const DEFAULT_SELF_CHECK_TIMEOUT_MS = 180000

/** single-instance 的默认超时（含宿主启动就绪 120s 与页级检查，留足余量）。 */
export const DEFAULT_SINGLE_INSTANCE_TIMEOUT_MS = 420000

/** 汇总里一条命令的薄记录（stdout/stderr 原文在证据目录）。 */
export interface BaseCommandSummary {
  readonly command: string
  readonly args: readonly string[]
  readonly exitCode: number | null
  readonly verdict: BaseCommandVerdict
  readonly detail: string
  readonly toolError?: string
  readonly durationMs: number
  readonly tally?: BaseCheckTally
  readonly blockedReasons?: readonly BaseBlockedReason[]
  readonly reportPath?: string
  readonly reportSha256?: string
  readonly evidenceDir?: string
  readonly stdoutPath?: string
  readonly stderrPath?: string
}

/** 汇总里 tarball 身份段（自写 extract 装进去的那份）。 */
export interface BaseVerifyTarballSummary {
  readonly path: string
  readonly sha256: string
  readonly packageName: string
  readonly version: string
  readonly files: number
  readonly bytes: number
  readonly dependencySpec: string
  readonly installedDir: string
}

/** 预检汇总 JSON 的形状（落 <out>/base-verify-summary.json，供证据账本引用）。 */
export interface BaseVerifySummary {
  readonly schemaVersion: 1
  readonly tool: 'run-base-verify'
  readonly generatedAt: string
  readonly verdict: BaseCommandVerdict
  readonly exitCode: 0 | 1 | 2
  readonly repoRoot: string
  readonly baseCli: string
  readonly baseVersion?: string
  readonly capabilityLine?: string
  readonly profile: string
  readonly sourceHome: string
  readonly sourceProfileDir: string
  readonly isolatedHome: string
  readonly workRoot: string
  readonly tarball?: BaseVerifyTarballSummary
  readonly commands: readonly BaseCommandSummary[]
  readonly notes: readonly string[]
  readonly summaryPath: string
}

/** 预检入参。 */
export interface BaseVerifyPreflightOptions {
  /** 源 DSH_HOME（只读；必须含 profiles/<profile>）。 */
  readonly home: string
  /** profile 名（例如 web）。 */
  readonly profile: string
  /** 证据输出目录（本工具在里面建 home/ work/ raw/ 与 summary）。 */
  readonly out: string
  /** 本仓 dist tgz（npm pack 产物）；给了就解进隔离 profile 的 node_modules。 */
  readonly tarball?: string
  readonly selfCheckTimeoutMs?: number
  readonly singleInstanceTimeoutMs?: number
}

/** 预检结果：summary 同时已写盘。 */
export interface BaseVerifyPreflightResult {
  readonly summary: BaseVerifySummary
  readonly exitCode: 0 | 1 | 2
}

interface CapturedCommand {
  readonly record: BaseCommandRecord
  readonly evidenceDir: string
  readonly stdoutPath: string
  readonly stderrPath: string
}

interface FinishParts {
  readonly repoRoot: string
  readonly cliPath: string
  readonly baseVersion?: string
  readonly capabilityLine?: string
  readonly profile: string
  readonly sourceHome: string
  readonly sourceProfileDir: string
  readonly isolatedHome: string
  readonly workRoot: string
  readonly tarball?: BaseVerifyTarballSummary
  readonly commands: readonly BaseCommandSummary[]
  readonly outDir: string
  readonly notes: readonly string[]
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toInvocation(record: BaseCommandRecord): Record<string, unknown> {
  return {
    command: record.command,
    args: record.args,
    cwd: record.cwd,
    exitCode: record.exitCode,
    signal: record.signal,
    timedOut: record.timedOut,
    durationMs: record.durationMs,
    verdict: record.verdict,
    detail: record.detail,
    ...(record.toolError ? { toolError: record.toolError } : {}),
    ...(record.tally ? { tally: record.tally } : {}),
    ...(record.blockedReasons ? { blockedReasons: record.blockedReasons } : {}),
    ...(record.reportPath ? { reportPath: record.reportPath } : {}),
    ...(record.reportSha256 ? { reportSha256: record.reportSha256 } : {}),
  }
}

/** 落 stdout/stderr/调用记录，并在有报告时先验侧车再拷 run 目录。 */
async function captureCommand(record: BaseCommandRecord, evidenceRoot: string): Promise<CapturedCommand> {
  const evidenceDir = join(evidenceRoot, record.command)
  await ensureDir(evidenceDir)
  const stdoutPath = join(evidenceDir, 'stdout.json')
  const stderrPath = join(evidenceDir, 'stderr.txt')
  await writeFile(stdoutPath, record.stdout)
  await writeFile(stderrPath, record.stderr)
  let next = record
  if (record.reportPath) {
    const captured = await captureBaseRunArtifacts({
      runtimeReportPath: record.reportPath,
      ...(record.reportSha256 ? { reportSha256: record.reportSha256 } : {}),
      targetDir: evidenceDir,
    })
    if (!captured.ok) {
      next = { ...record, verdict: 'fail', detail: record.detail + '；证据身份链校验失败（按 fail 记）：' + captured.detail }
    } else {
      next = { ...record, reportPath: captured.value.reportPath, reportSha256: captured.value.sha256 }
    }
  }
  await writeJsonFile(join(evidenceDir, 'invocation.json'), toInvocation(next))
  return { record: next, evidenceDir, stdoutPath, stderrPath }
}

function summarize(captured: CapturedCommand): BaseCommandSummary {
  const record = captured.record
  return {
    command: record.command,
    args: record.args,
    exitCode: record.exitCode,
    verdict: record.verdict,
    detail: record.detail,
    ...(record.toolError ? { toolError: record.toolError } : {}),
    durationMs: record.durationMs,
    ...(record.tally ? { tally: record.tally } : {}),
    ...(record.blockedReasons ? { blockedReasons: record.blockedReasons } : {}),
    ...(record.reportPath ? { reportPath: record.reportPath } : {}),
    ...(record.reportSha256 ? { reportSha256: record.reportSha256 } : {}),
    evidenceDir: captured.evidenceDir,
    stdoutPath: captured.stdoutPath,
    stderrPath: captured.stderrPath,
  }
}

function rollup(commands: readonly BaseCommandSummary[]): { readonly verdict: BaseCommandVerdict; readonly exitCode: 0 | 1 | 2 } {
  if (commands.some((command) => command.verdict === 'fail')) return { verdict: 'fail', exitCode: 1 }
  if (commands.length === 0 || commands.some((command) => command.verdict === 'unknown')) return { verdict: 'unknown', exitCode: 2 }
  return { verdict: 'pass', exitCode: 0 }
}

async function finish(parts: FinishParts): Promise<BaseVerifyPreflightResult> {
  const rolled = rollup(parts.commands)
  const summaryPath = join(parts.outDir, 'base-verify-summary.json')
  const summary: BaseVerifySummary = {
    schemaVersion: 1,
    tool: 'run-base-verify',
    generatedAt: new Date().toISOString(),
    verdict: rolled.verdict,
    exitCode: rolled.exitCode,
    repoRoot: parts.repoRoot,
    baseCli: parts.cliPath,
    ...(parts.baseVersion ? { baseVersion: parts.baseVersion } : {}),
    ...(parts.capabilityLine ? { capabilityLine: parts.capabilityLine } : {}),
    profile: parts.profile,
    sourceHome: parts.sourceHome,
    sourceProfileDir: parts.sourceProfileDir,
    isolatedHome: parts.isolatedHome,
    workRoot: parts.workRoot,
    ...(parts.tarball ? { tarball: parts.tarball } : {}),
    commands: parts.commands,
    notes: parts.notes,
    summaryPath,
  }
  await writeJsonFile(summaryPath, summary)
  return { summary, exitCode: rolled.exitCode }
}

/** 跑一遍预检；返回的 summary 已落盘，exitCode 就是调用方应退的码。 */
export async function runBaseVerifyPreflight(options: BaseVerifyPreflightOptions): Promise<BaseVerifyPreflightResult> {
  const repoRoot = repositoryRoot()
  const outDir = resolve(options.out)
  const sourceHome = resolve(options.home)
  const sourceProfileDir = join(sourceHome, 'profiles', options.profile)
  const isolatedHome = join(outDir, 'home')
  const isolatedProfileDir = join(isolatedHome, 'profiles', options.profile)
  const workRoot = join(outDir, 'work')
  const evidenceRoot = join(outDir, 'raw', 'base-verify')
  const notes: string[] = []
  const commands: BaseCommandSummary[] = []
  let cliPath = ''
  let baseVersion: string | undefined
  let capabilityLine: string | undefined
  let tarballSummary: BaseVerifyTarballSummary | undefined
  const bare = (): FinishParts => ({
    repoRoot,
    cliPath,
    ...(baseVersion ? { baseVersion } : {}),
    ...(capabilityLine ? { capabilityLine } : {}),
    profile: options.profile,
    sourceHome,
    sourceProfileDir,
    isolatedHome,
    workRoot,
    ...(tarballSummary ? { tarball: tarballSummary } : {}),
    commands,
    outDir,
    notes,
  })

  await ensureDir(outDir)
  try {
    const capability = checkBaseCapability({ repoRoot })
    if (!capability.ok) {
      notes.push('capability 门未通过（blocked）：' + capability.blockedReason.message + (capability.blockedReason.hint ? '；' + capability.blockedReason.hint : ''))
      return await finish(bare())
    }
    cliPath = capability.value.cliPath
    baseVersion = capability.value.version
    capabilityLine = capability.value.capabilityLine
    notes.push('capability 门通过：' + capability.value.version + '（' + capability.value.capabilityLine + '）')

    if (!(await directoryExists(sourceProfileDir))) {
      notes.push('源 profile 不存在（blocked）：' + sourceProfileDir)
      return await finish(bare())
    }

    await rm(isolatedHome, { recursive: true, force: true })
    await ensureDir(join(isolatedHome, 'profiles'))
    await cp(sourceProfileDir, isolatedProfileDir, { recursive: true, force: true })
    notes.push('已把源 profile 复制进隔离 home：' + isolatedProfileDir)

    if (options.tarball) {
      const installed = await installTarballIntoProfile({
        tarballPath: options.tarball,
        profileDir: isolatedProfileDir,
        packageName: SELF_PACKAGE_NAME,
      })
      if (!installed.ok) {
        notes.push('tgz 安装失败（blocked/工具错误）：' + installed.error)
        return await finish(bare())
      }
      tarballSummary = {
        path: installed.value.tarballPath,
        sha256: installed.value.tarballSha256,
        packageName: installed.value.packageName,
        version: installed.value.version,
        files: installed.value.files,
        bytes: installed.value.bytes,
        dependencySpec: installed.value.dependencySpec,
        installedDir: installed.value.installedDir,
      }
      notes.push(
        '已自写 extract 安装 ' +
          installed.value.packageName +
          '@' +
          installed.value.version +
          '（' +
          installed.value.files +
          ' 个文件；绕过 base install 的 package-version-constant 校验，原因见 docs/research）',
      )
    } else {
      notes.push('未给 --tarball：假定隔离 profile 里已有 ' + SELF_PACKAGE_NAME + '（base 的 package-installed 会如实判）')
    }

    const env: Record<string, string | undefined> = { ...process.env, DSH_HOME: isolatedHome }
    const selfCheck = await runBaseCommand({
      cliPath,
      command: 'self-check',
      args: ['--profile', options.profile, '--work-root', workRoot],
      cwd: repoRoot,
      env,
      timeoutMs: options.selfCheckTimeoutMs ?? DEFAULT_SELF_CHECK_TIMEOUT_MS,
    })
    const capturedSelfCheck = await captureCommand(selfCheck, evidenceRoot)
    commands.push(summarize(capturedSelfCheck))
    if (capturedSelfCheck.record.verdict !== 'pass') {
      notes.push('self-check 未 pass（' + capturedSelfCheck.record.verdict + '）：' + capturedSelfCheck.record.detail + '；single-instance 已跳过')
      return await finish(bare())
    }

    const singleInstance = await runBaseCommand({
      cliPath,
      command: 'single-instance',
      args: ['--profile', options.profile, '--work-root', workRoot],
      cwd: repoRoot,
      env,
      timeoutMs: options.singleInstanceTimeoutMs ?? DEFAULT_SINGLE_INSTANCE_TIMEOUT_MS,
    })
    const capturedSingleInstance = await captureCommand(singleInstance, evidenceRoot)
    commands.push(summarize(capturedSingleInstance))
    notes.push('single-instance 判定：' + capturedSingleInstance.record.verdict + '；' + capturedSingleInstance.record.detail)
  } catch (error) {
    notes.push('工具异常（blocked）：' + errorText(error))
  }
  return await finish(bare())
}
