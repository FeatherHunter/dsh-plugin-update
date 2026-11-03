/**
 * selftest/real-machine/base-verify/scenario-run.ts —— base run 场景的通用编排（真机快速通道）。
 *
 * 干什么：把「复制隔离 home → 跑 base run <scenario> → 收报告/证据 → 校验截图 sidecar → 写汇总」
 * 收成一条可复用通道。base 自己的 run 负责起宿主、跑场景、收 run.json；这里只做本仓的口径：
 *
 * - 源 DSH_HOME 只读：只把源 home 的 profiles/<profile> 复制进 <out>/home，任何写入都落在 --out 下。
 * - 证据链：base 的 run.json 侧车 sha256 先复核再整目录拷进 <out>/raw/base-verify/run（不复制结论，复制原始观测）。
 * - 截图：<out>/shots 下每张 png 必须有同名 .json sidecar，且含六字段（看什么/步骤/expected/actual/判定/备注）；
 *   缺一个都按 fail 记——截图没有旁注就只是一张图，证明不了「看到了什么」。
 * - 四态：复用 runner.ts 的 exit 0/1/2 映射（0=pass、1=fail、2=blocked→unknown），
 *   blocked 一律不算通过；工具自身的错也记 unknown，不冒充产品失败。
 *
 * 汇总写 <out>/base-scenario-summary.json，供上游证据账本/研究笔记引用。
 */
import { cp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { directoryExists, ensureDir, fileExists, sha256File, writeJsonFile } from '../../tooling/fs-utils.ts'
import { formatError } from '../../tooling/process.ts'
import { captureBaseRunArtifacts } from './artifacts.ts'
import { checkBaseCapability, repositoryRoot } from './capability.ts'
import { classifyExit, runBaseCommand } from './runner.ts'
import type { BaseBlockedReason, BaseCheckTally, BaseCommandRecord, BaseCommandVerdict, BaseRunReport } from './types.ts'

/** 一次场景 run 的默认超时：web 宿主 launch 约 5s，UI 步骤留足余量。 */
export const DEFAULT_SCENARIO_TIMEOUT_MS = 240000

/** 截图 sidecar 的六个固定中文键（顺序即证据契约里的阅读顺序）。 */
export const SHOT_SIDECAR_KEYS = ['看什么', '步骤', 'expected', 'actual', '判定', '备注'] as const
const SHOT_VERDICTS = ['pass', 'fail', 'skip', 'blocked'] as const

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const

/** base run 的调用参数（纯函数，单测直接断言）。 */
export interface ScenarioInvocation {
  readonly command: 'run'
  readonly args: readonly string[]
}

/** 按 base run 的命令面拼参数：场景文件是位置参数，profile/work-root 是全局旗标。 */
export function buildScenarioArgs(input: {
  readonly scenarioPath: string
  readonly profile: string
  readonly workRoot: string
}): ScenarioInvocation {
  return {
    command: 'run',
    args: [input.scenarioPath, '--profile', input.profile, '--work-root', input.workRoot],
  }
}

/** 四态映射的纯函数入口：只读退出码/信号/耗时 + 报告，不碰进程。 */
export function classifyScenarioExit(
  facts: { readonly exitCode: number | null; readonly signal: string | null; readonly durationMs: number },
  report: BaseRunReport | undefined,
  parseError?: string,
): { readonly verdict: BaseCommandVerdict; readonly detail: string; readonly toolError?: string } {
  return classifyExit(facts, report, parseError)
}

/** 证据里出现的 token 一律脱敏：tokenUrl 是本次实例的一次性凭证，不该成为可复用的字符串。 */
export function redactTokenUrl(url: string): string {
  return url.replace(/([?&]token=)[^&#]*/g, '$1***')
}

/** 一张截图的校验结果。 */
export interface ScenarioShotSummary {
  readonly id: string
  readonly png: string
  readonly sidecar: string
  readonly bytes: number
  readonly verdict: 'pass' | 'fail'
  readonly problems: readonly string[]
}

/** 截图校验结果：每张图一行 + 所有问题汇总。 */
export interface ShotValidationResult {
  readonly shots: readonly ScenarioShotSummary[]
  readonly problems: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasPngMagic(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_MAGIC.length) return false
  return PNG_MAGIC.every((byte, index) => bytes[index] === byte)
}

/**
 * 校验 <shotsDir> 下每张 png 的同名 sidecar。
 *
 * 为什么校验「六字段」而不是只看文件存在：截图是给人看的证据，缺 expected/actual 的图无法被独立复核；
 * 判定列必须落在四态里，否则证据账本没法汇总。备注允许 null（表示没有额外说明）。
 */
export async function validateShotSidecars(
  shotsDir: string,
  options: { readonly requireAtLeastOne?: boolean } = {},
): Promise<ShotValidationResult> {
  const requireAtLeastOne = options.requireAtLeastOne ?? true
  const problems: string[] = []
  let names: string[] = []
  if (await directoryExists(shotsDir)) {
    try {
      names = await readdir(shotsDir)
    } catch (error) {
      return { shots: [], problems: ['列不出截图目录 ' + shotsDir + '：' + formatError(error)] }
    }
  }
  const pngNames = names.filter((name) => name.toLowerCase().endsWith('.png')).sort()
  if (pngNames.length === 0 && requireAtLeastOne) {
    problems.push('没有截图：' + shotsDir + ' 下没有任何 *.png')
  }
  const shots: ScenarioShotSummary[] = []
  for (const pngName of pngNames) {
    const id = pngName.slice(0, -4)
    const pngPath = join(shotsDir, pngName)
    const sidecarPath = join(shotsDir, id + '.json')
    const shotProblems: string[] = []
    let bytes = 0
    try {
      bytes = (await stat(pngPath)).size
      if (bytes === 0) shotProblems.push('png 是空文件')
      const head = await readFile(pngPath)
      if (!hasPngMagic(head)) shotProblems.push('png 头不是 89 50 4E 47 0D 0A 1A 0A')
    } catch (error) {
      shotProblems.push('读不出 png：' + formatError(error))
    }
    let sidecar: unknown
    try {
      sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) as unknown
    } catch (error) {
      shotProblems.push('同名 sidecar 不可读（' + sidecarPath + '）：' + formatError(error))
    }
    if (sidecar !== undefined) {
      if (!isRecord(sidecar)) {
        shotProblems.push('sidecar 不是 JSON 对象')
      } else {
        for (const key of SHOT_SIDECAR_KEYS) {
          if (!(key in sidecar)) {
            shotProblems.push('sidecar 缺字段「' + key + '」')
            continue
          }
          const value = sidecar[key]
          if (key === '备注') {
            if (value !== null && typeof value !== 'string') shotProblems.push('sidecar 字段「备注」必须是字符串或 null')
            continue
          }
          if (typeof value !== 'string' || value.trim() === '') {
            shotProblems.push('sidecar 字段「' + key + '」必须是非空字符串')
            continue
          }
          if (key === '判定' && !(SHOT_VERDICTS as readonly string[]).includes(value)) {
            shotProblems.push('sidecar 判定列不是四态之一：' + JSON.stringify(value))
          }
        }
      }
    }
    shots.push({
      id,
      png: pngPath,
      sidecar: sidecarPath,
      bytes,
      verdict: shotProblems.length === 0 ? 'pass' : 'fail',
      problems: shotProblems,
    })
    if (shotProblems.length > 0) problems.push(id + '：' + shotProblems.join('；'))
  }
  return { shots, problems }
}

/** 汇总里一条 base 命令的调用记录（与预检工具同口径）。 */
export interface ScenarioCommandSummary {
  readonly command: 'run'
  readonly args: readonly string[]
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
  readonly stdoutPath: string
  readonly stderrPath: string
}

/** 汇总里的实例段（tokenUrl 已脱敏）。 */
export interface ScenarioInstanceSummary {
  readonly instanceId: string
  readonly pid?: number
  readonly port?: number
  readonly originUrl?: string
  readonly tokenUrl?: string
  readonly profile?: string
  readonly readyMs?: number
  readonly instanceJsonPath: string
  readonly copiedTo?: string
}

/** 汇总里的场景段：指向 base 自己的 run 报告。 */
export interface ScenarioReportSummary {
  readonly path: string
  readonly sha256?: string
  readonly workRoot: string
  readonly runId?: string
  readonly runtimeReportPath?: string
  readonly reportPath?: string
  readonly state?: string
  readonly exitCode?: number
  readonly checks?: BaseCheckTally
}

/** 滚动判定：证据问题（身份链/截图）优先于命令判定，任何「没证明」都不算 pass。 */
export interface ScenarioRollupInput {
  readonly commandVerdict?: BaseCommandVerdict
  readonly evidenceProblems: readonly string[]
  readonly shots: readonly ScenarioShotSummary[]
  readonly requireScreenshots: boolean
}
export interface ScenarioRollup {
  readonly verdict: BaseCommandVerdict
  readonly exitCode: 0 | 1 | 2
  readonly reasons: readonly string[]
}
export function rollupScenarioVerdict(input: ScenarioRollupInput): ScenarioRollup {
  const reasons: string[] = []
  if (input.evidenceProblems.length > 0) reasons.push('证据问题：' + input.evidenceProblems.join('；'))
  if (input.shots.some((shot) => shot.verdict === 'fail')) reasons.push('截图 sidecar 校验未通过')
  if (input.requireScreenshots && input.shots.length === 0) reasons.push('没有截图可校验')
  if (reasons.length > 0) return { verdict: 'fail', exitCode: 1, reasons }
  if (input.commandVerdict === 'fail') return { verdict: 'fail', exitCode: 1, reasons: ['base run 硬失败'] }
  if (input.commandVerdict === undefined || input.commandVerdict === 'unknown') {
    return { verdict: 'unknown', exitCode: 2, reasons: ['base run 未给出可采信的结论'] }
  }
  return { verdict: 'pass', exitCode: 0, reasons: [] }
}

/** 汇总 JSON 的形状（落 <out>/base-scenario-summary.json）。 */
export interface BaseScenarioSummary {
  readonly schemaVersion: 1
  readonly tool: 'run-base-verify'
  readonly mode: 'scenario'
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
  readonly shotsDir: string
  readonly scenario?: ScenarioReportSummary
  readonly commands: readonly ScenarioCommandSummary[]
  readonly screenshots: readonly ScenarioShotSummary[]
  readonly instance?: ScenarioInstanceSummary
  readonly artifacts?: {
    readonly runtimeRunDir?: string
    readonly copiedRunDir?: string
    readonly reportSha256?: string
  }
  readonly notes: readonly string[]
  readonly summaryPath: string
}

/** runBaseScenario 的入参。 */
export interface BaseScenarioOptions {
  /** 源 DSH_HOME（只读；必须含 profiles/<profile>）。 */
  readonly home: string
  /** profile 名（例如 web）。 */
  readonly profile: string
  /** 场景文件（.ts/.mjs/.js）；相对路径按 repoRoot 解析。 */
  readonly scenario: string
  /** 证据输出目录（本工具在里面建 home/ work/ shots/ raw/ 与 summary）。 */
  readonly out: string
  readonly repoRoot?: string
  readonly timeoutMs?: number
  /** 默认 true：一次 UI 场景至少要有 1 张带 sidecar 的截图，否则按 fail 记。 */
  readonly requireScreenshots?: boolean
  /** 覆盖 DSH_VERIFY_PLAYWRIGHT（不设就继承进程环境）。 */
  readonly playwrightPath?: string
  /** 额外环境变量（覆盖继承值）。 */
  readonly env?: Record<string, string | undefined>
}

export interface BaseScenarioResult {
  readonly summary: BaseScenarioSummary
  readonly exitCode: 0 | 1 | 2
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

interface DetectedInstance {
  readonly summary: ScenarioInstanceSummary
  readonly sourcePath: string
  readonly mtimeMs: number
}

/** 在 workRoot/instances 下逐个 instance.json 里挑最新的一份（隔离 out 下就是本次 run 起的实例）。 */
async function detectLatestInstance(workRoot: string): Promise<DetectedInstance | null> {
  const root = join(workRoot, 'instances')
  if (!(await directoryExists(root))) return null
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return null
  }
  let best: DetectedInstance | null = null
  for (const name of names) {
    const sourcePath = join(root, name, 'instance.json')
    try {
      const info = JSON.parse(await readFile(sourcePath, 'utf8')) as unknown
      if (!isRecord(info)) continue
      const mtimeMs = (await stat(sourcePath)).mtimeMs
      const summary: ScenarioInstanceSummary = {
        instanceId: asOptionalString(info.instanceId) ?? name,
        ...(asOptionalNumber(info.pid) !== undefined ? { pid: asOptionalNumber(info.pid) } : {}),
        ...(asOptionalNumber(info.port) !== undefined ? { port: asOptionalNumber(info.port) } : {}),
        ...(asOptionalString(info.originUrl) !== undefined ? { originUrl: asOptionalString(info.originUrl) } : {}),
        ...(asOptionalString(info.tokenUrl) !== undefined
          ? { tokenUrl: redactTokenUrl(asOptionalString(info.tokenUrl) as string) }
          : {}),
        ...(asOptionalString(info.profile) !== undefined ? { profile: asOptionalString(info.profile) } : {}),
        ...(asOptionalNumber(info.readyMs) !== undefined ? { readyMs: asOptionalNumber(info.readyMs) } : {}),
        instanceJsonPath: sourcePath,
      }
      if (best === null || mtimeMs > best.mtimeMs) best = { summary, sourcePath, mtimeMs }
    } catch {
      continue
    }
  }
  return best
}

/** 把 instance.json 以脱敏副本落进 raw/：保留形状，不把 token 原样带进证据。 */
async function copyRedactedInstance(instance: DetectedInstance, rawDir: string): Promise<string> {
  const targetDir = join(rawDir, 'instance')
  await ensureDir(targetDir)
  const targetPath = join(targetDir, 'instance.json')
  const info = JSON.parse(await readFile(instance.sourcePath, 'utf8')) as unknown
  if (isRecord(info) && typeof info.tokenUrl === 'string') {
    info.tokenUrl = redactTokenUrl(info.tokenUrl)
  }
  await writeJsonFile(targetPath, info)
  return targetPath
}

/** 把一条 base 命令记录写成 stdout/stderr/invocation 三件，并在有报告时先验侧车再拷 run 目录。 */
async function captureScenarioCommand(
  record: BaseCommandRecord,
  rawDir: string,
): Promise<{
  readonly command: ScenarioCommandSummary
  readonly evidenceProblems: readonly string[]
  readonly runtimeReportPath?: string
  readonly copiedReportPath?: string
  readonly reportSha256?: string
}> {
  const evidenceDir = join(rawDir, 'base-verify', record.command)
  await ensureDir(evidenceDir)
  const stdoutPath = join(evidenceDir, 'stdout.json')
  const stderrPath = join(evidenceDir, 'stderr.txt')
  await writeFile(stdoutPath, record.stdout)
  await writeFile(stderrPath, record.stderr)
  const evidenceProblems: string[] = []
  let reportPath = record.reportPath
  let reportSha256 = record.reportSha256
  let copiedReportPath: string | undefined
  const runtimeReportPath = record.reportPath
  if (record.reportPath) {
    const captured = await captureBaseRunArtifacts({
      runtimeReportPath: record.reportPath,
      ...(record.reportSha256 ? { reportSha256: record.reportSha256 } : {}),
      targetDir: evidenceDir,
    })
    if (!captured.ok) {
      evidenceProblems.push('证据身份链校验失败：' + captured.detail)
    } else {
      copiedReportPath = captured.value.reportPath
      reportPath = captured.value.reportPath
      reportSha256 = captured.value.sha256
    }
  }
  const invocation = {
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
    ...(reportPath ? { reportPath } : {}),
    ...(reportSha256 ? { reportSha256 } : {}),
  }
  await writeJsonFile(join(evidenceDir, 'invocation.json'), invocation)
  const command: ScenarioCommandSummary = {
    command: 'run',
    args: record.args,
    exitCode: record.exitCode,
    signal: record.signal,
    timedOut: record.timedOut,
    durationMs: record.durationMs,
    verdict: record.verdict,
    detail: record.detail,
    ...(record.toolError ? { toolError: record.toolError } : {}),
    ...(record.tally ? { tally: record.tally } : {}),
    ...(record.blockedReasons ? { blockedReasons: record.blockedReasons } : {}),
    ...(reportPath ? { reportPath } : {}),
    ...(reportSha256 ? { reportSha256 } : {}),
    stdoutPath,
    stderrPath,
  }
  return { command, evidenceProblems, ...(runtimeReportPath ? { runtimeReportPath } : {}), ...(copiedReportPath ? { copiedReportPath } : {}), ...(reportSha256 ? { reportSha256 } : {}) }
}

function buildReportSummary(parts: {
  readonly scenarioPath: string
  readonly scenarioSha256?: string
  readonly workRoot: string
  readonly record: BaseCommandRecord
  readonly runtimeReportPath?: string
  readonly copiedReportPath?: string
}): ScenarioReportSummary {
  const report = parts.record.report
  const runtimeReportPath = parts.runtimeReportPath
  return {
    path: parts.scenarioPath,
    ...(parts.scenarioSha256 ? { sha256: parts.scenarioSha256 } : {}),
    workRoot: parts.workRoot,
    ...(runtimeReportPath ? { runId: basename(dirname(runtimeReportPath)), runtimeReportPath } : {}),
    ...(parts.copiedReportPath ? { reportPath: parts.copiedReportPath } : {}),
    ...(report?.state !== undefined ? { state: String(report.state) } : {}),
    ...(report?.exitCode !== undefined ? { exitCode: report.exitCode } : {}),
    ...(parts.record.tally ? { checks: parts.record.tally } : {}),
  }
}

/**
 * 跑一遍 base run 场景通道；返回的 summary 已落盘，exitCode 就是调用方应退的码。
 *
 * 流程固定为：capability 门 → 源 profile 只读复制 → base run（spawn，不经 shell）→
 * 收 stdout/stderr 与 run 目录（先验侧车）→ 校验截图 sidecar → 汇总。
 * 任何一步失败都写 summary 再返回，不抛给调用方当崩溃处理。
 */
export async function runBaseScenario(options: BaseScenarioOptions): Promise<BaseScenarioResult> {
  const repoRoot = resolve(options.repoRoot ?? repositoryRoot())
  const outDir = resolve(options.out)
  const sourceHome = resolve(options.home)
  const sourceProfileDir = join(sourceHome, 'profiles', options.profile)
  const isolatedHome = join(outDir, 'home')
  const isolatedProfileDir = join(isolatedHome, 'profiles', options.profile)
  const workRoot = join(outDir, 'work')
  const shotsDir = join(outDir, 'shots')
  const rawDir = join(outDir, 'raw')
  const summaryPath = join(outDir, 'base-scenario-summary.json')
  const requireScreenshots = options.requireScreenshots ?? true
  const scenarioPath = isAbsolute(options.scenario) ? options.scenario : resolve(repoRoot, options.scenario)

  const notes: string[] = []
  let baseCli = ''
  let baseVersion: string | undefined
  let capabilityLine: string | undefined
  let scenarioSha256: string | undefined
  let commands: ScenarioCommandSummary[] = []
  let screenshots: ScenarioShotSummary[] = []
  let evidenceProblems: string[] = []
  let scenarioInfo: ScenarioReportSummary | undefined
  let instance: ScenarioInstanceSummary | undefined
  let artifacts: BaseScenarioSummary['artifacts']

  const finish = async (verdict: BaseCommandVerdict, exitCode: 0 | 1 | 2): Promise<BaseScenarioResult> => {
    const summary: BaseScenarioSummary = {
      schemaVersion: 1,
      tool: 'run-base-verify',
      mode: 'scenario',
      generatedAt: new Date().toISOString(),
      verdict,
      exitCode,
      repoRoot,
      baseCli,
      ...(baseVersion ? { baseVersion } : {}),
      ...(capabilityLine ? { capabilityLine } : {}),
      profile: options.profile,
      sourceHome,
      sourceProfileDir,
      isolatedHome,
      workRoot,
      shotsDir,
      ...(scenarioInfo ? { scenario: scenarioInfo } : {}),
      commands,
      screenshots,
      ...(instance ? { instance } : {}),
      ...(artifacts ? { artifacts } : {}),
      notes,
      summaryPath,
    }
    await writeJsonFile(summaryPath, summary)
    return { summary, exitCode }
  }

  await ensureDir(outDir)

  try {
    const capability = checkBaseCapability({ repoRoot })
    if (!capability.ok) {
      notes.push('capability 门未通过（blocked）：' + capability.blockedReason.message + (capability.blockedReason.hint ? '；' + capability.blockedReason.hint : ''))
      return await finish('unknown', 2)
    }
    baseCli = capability.value.cliPath
    baseVersion = capability.value.version
    capabilityLine = capability.value.capabilityLine
    notes.push('capability 门通过：' + capability.value.version + '（' + capability.value.capabilityLine + '）')

    if (!(await directoryExists(sourceProfileDir))) {
      notes.push('源 profile 不存在（blocked）：' + sourceProfileDir)
      return await finish('unknown', 2)
    }
    if (!(await fileExists(scenarioPath))) {
      notes.push('场景文件不存在（blocked）：' + scenarioPath)
      return await finish('unknown', 2)
    }

    scenarioSha256 = await sha256File(scenarioPath)
    notes.push('场景文件：' + scenarioPath + '（sha256=' + scenarioSha256 + '）')

    await rm(isolatedHome, { recursive: true, force: true })
    await ensureDir(join(isolatedHome, 'profiles'))
    await cp(sourceProfileDir, isolatedProfileDir, { recursive: true, force: true })
    notes.push('已把源 profile 复制进隔离 home：' + isolatedProfileDir)

    // out 是一次 run 的证据目录：清掉上一轮的 work/shots/raw，避免旧实例与旧截图混进本次结论。
    await rm(workRoot, { recursive: true, force: true })
    await rm(shotsDir, { recursive: true, force: true })
    await rm(rawDir, { recursive: true, force: true })
    await ensureDir(rawDir)
    await ensureDir(shotsDir)

    const env: Record<string, string | undefined> = {
      ...process.env,
      ...options.env,
      DSH_HOME: isolatedHome,
      BASE_UI_SHOTS: shotsDir,
      ...(options.playwrightPath ? { DSH_VERIFY_PLAYWRIGHT: options.playwrightPath } : {}),
    }
    const invocation = buildScenarioArgs({ scenarioPath, profile: options.profile, workRoot })
    const record = await runBaseCommand({
      cliPath: baseCli,
      command: invocation.command,
      args: invocation.args,
      cwd: repoRoot,
      env,
      timeoutMs: options.timeoutMs ?? DEFAULT_SCENARIO_TIMEOUT_MS,
    })
    const captured = await captureScenarioCommand(record, rawDir)
    commands = [captured.command]
    evidenceProblems = [...captured.evidenceProblems]
    scenarioInfo = buildReportSummary({
      scenarioPath,
      scenarioSha256,
      workRoot,
      record,
      ...(captured.runtimeReportPath ? { runtimeReportPath: captured.runtimeReportPath } : {}),
      ...(captured.copiedReportPath ? { copiedReportPath: captured.copiedReportPath } : {}),
    })
    notes.push(
      'base run：exit=' + String(record.exitCode) + ' verdict=' + record.verdict + (record.tally ? '（pass=' + record.tally.pass + ' fail=' + record.tally.fail + ' skip=' + record.tally.skip + ' blocked=' + record.tally.blocked + '）' : ''),
    )
    for (const reason of record.blockedReasons ?? []) {
      notes.push('blocked[' + reason.code + '] ' + reason.message + (reason.hint ? '（' + reason.hint + '）' : ''))
    }
    if (record.toolError) notes.push('工具错误：' + record.toolError)

    // 截图校验：缺 sidecar / 缺字段都按 fail 记（不是 skip，也不是「没看到」）。
    const validated = await validateShotSidecars(shotsDir, { requireAtLeastOne: requireScreenshots })
    screenshots = [...validated.shots]
    if (validated.problems.length > 0) evidenceProblems.push(...validated.problems)
    notes.push('截图校验：' + screenshots.length + ' 张 png，问题 ' + validated.problems.length + ' 条（目录 ' + shotsDir + '）')

    const detected = await detectLatestInstance(workRoot)
    if (detected !== null) {
      const copied = await copyRedactedInstance(detected, rawDir)
      instance = { ...detected.summary, copiedTo: copied }
      notes.push('实例：' + detected.summary.instanceId + ' pid=' + String(detected.summary.pid ?? '?') + '（tokenUrl 已脱敏）')
    } else {
      notes.push('没有找到 <workRoot>/instances/*/instance.json（实例可能未起来）')
    }

    // 场景文件连同 run 目录一起留档：证据目录要能回答「跑的是哪一版场景」。
    try {
      await cp(scenarioPath, join(rawDir, basename(scenarioPath)), { recursive: false, force: true })
      notes.push('场景文件副本：' + join(rawDir, basename(scenarioPath)))
    } catch (error) {
      notes.push('场景文件副本写入失败：' + formatError(error))
    }

    artifacts = {
      ...(captured.runtimeReportPath ? { runtimeRunDir: dirname(captured.runtimeReportPath) } : {}),
      ...(captured.copiedReportPath ? { copiedRunDir: dirname(captured.copiedReportPath) } : {}),
      ...(captured.reportSha256 ? { reportSha256: captured.reportSha256 } : {}),
    }

    const rolled = rollupScenarioVerdict({
      commandVerdict: record.verdict,
      evidenceProblems,
      shots: screenshots,
      requireScreenshots,
    })
    for (const reason of rolled.reasons) notes.push('判定理由：' + reason)
    return await finish(rolled.verdict, rolled.exitCode)
  } catch (error) {
    notes.push('工具异常（blocked）：' + formatError(error))
    return await finish('unknown', 2)
  }
}
