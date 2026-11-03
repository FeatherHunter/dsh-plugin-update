/**
 * selftest/real-machine/tools/run-all.ts —— T11（#275）spec #263 全量真机矩阵回归编排器。
 *
 * 它不实现任何场景与断言：每个场景仍由既有 tools/run-*.ts 子进程跑（各自独立 clean profile /
 * verdaccio / 端口），本编排器只负责：
 *   1) 按 fixtures/identity/scenario-declarations.ts 的 32 条 SCENARIOS 枚举全部主链场景，
 *      再按 can-red 表枚举 12 组「注入后必须真失败」的期望失败 run；
 *   2) 调度：官方桌面通道串行（单实例，一次只跑一个），dsh-web 通道默认 3 路并发；
 *   3) 隔离：每个 run 私有 pnpm/npm 缓存目录（T10 坑：共享 D:/caches/pnpm 的钥匙含 registry
 *      origin+端口，复用会命中旧 packument 导致 ERR_PNPM_TARBALL_INTEGRITY 假红）；
 *   4) 证据：仓库外 run 由各工具自己落盘并自动复制进 selftest/evidence/runs；
 *      本编排器再落一份 suite 级证据 <stamp>-full/{run.json,index.md,raw/}；
 *   5) 判定：四态 pass/fail/known-red/unknown 聚合（fail > unknown > known-red > pass）；
 *      can-red run 必须 fail 且红断言集合落在历史期望集合内，否则记 can-red-unexpected-pass /
 *      can-red-mismatch（按失败算）；
 *   6) 退出码：0=全部 pass 或仅账本内 known-red；1=有 fail/unknown/期望失败未达成；2=编排器 blocked。
 *
 * 用法：node selftest/real-machine/tools/run-all.ts --run-base-dir <真机临时目录根>
 * 完整参数见 parseArgs（k/j 组 UI 场景需要 Playwright：自动探测 --playwright / DSH_VERIFY_PLAYWRIGHT /
 * 工作树 node_modules / 仓库外 deck 安装；探测不到时这些场景记 unknown 而不是假 pass）。
 * 续跑：同一 --stamp 重跑会复用 <stamp>-full 目录与已完成记录，
 * 未完成/blocked/unknown 会自动补跑；--rerun 强制全部重跑。
 *
 * 证据契约见 selftest/evidence/README.md；known-red 只允许 selftest/evidence/known-red.md 已登记条件。
 */
import { existsSync, readFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { SCENARIOS } from '../../fixtures/identity/scenario-declarations.ts'
import { formatRunStamp } from '../runtime/run-layout.ts'
import { directoryFingerprint } from '../../tooling/fs-utils.ts'

type HostChannel = 'desktop-official' | 'dsh-web'
type Verdict = 'pass' | 'fail' | 'known-red' | 'unknown'
type Outcome =
  | 'pass'
  | 'known-red'
  | 'fail'
  | 'unknown'
  | 'blocked'
  | 'can-red-expected-fail'
  | 'can-red-unexpected-pass'
  | 'can-red-mismatch'

interface ToolSpec {
  readonly tool: string
  readonly mode?: string
  readonly fault?: string
}

/** 场景 id → 真机 run 工具与 mode/fault。32 条声明必须全部有落点（缺一条 buildPlan 直接抛错）。 */
const TOOL_BY_SCENARIO: Readonly<Record<string, ToolSpec>> = {
  'a-single-package-main-chain': { tool: 'run-a-main-chain' },
  'b-batch-two-integrators': { tool: 'run-b-batch' },
  'c-pure-target-no-wiring': { tool: 'run-c-pure-target' },
  'd1-desktop-manager-update-success': { tool: 'run-d-desktop-manager', mode: 'success' },
  'd2-desktop-manager-update-failure': { tool: 'run-d-desktop-manager', mode: 'failure' },
  'e1-cli-host-update-success': { tool: 'run-e-cli-host', mode: 'success' },
  'e2-cli-host-update-failure': { tool: 'run-e-cli-host', mode: 'failure' },
  'e3-cli-host-install-timeout': { tool: 'run-e-cli-host', mode: 'timeout' },
  'f1-third-party-desktop-probe': { tool: 'run-f-desktop-probe' },
  'g1-desktop-manager-install-timeout': { tool: 'run-g-settlement', mode: 'timeout' },
  'g2-batch-queued-cancel': { tool: 'run-g-settlement', mode: 'queued-cancel' },
  'g3-desktop-manager-failed-no-retry': { tool: 'run-g-settlement', mode: 'failed-no-retry' },
  'g4-desktop-manager-retry-single-success': { tool: 'run-g-settlement', mode: 'retry-single-success' },
  'g5-desktop-manager-no-cancel-probe': { tool: 'run-g-settlement', mode: 'no-cancel-probe' },
  'e-batch-three-package-upgrade': { tool: 'run-e-batch', mode: 'three-package-upgrade' },
  'e-batch-partial-failure': { tool: 'run-e-batch', mode: 'partial-failure' },
  'e-batch-resume-retry': { tool: 'run-e-batch', mode: 'resume-retry' },
  'h1-queue-lock-concurrent': { tool: 'run-h-queue-lock', mode: 'concurrent-lock-window' },
  'h1b-queue-lock-simultaneous': { tool: 'run-h-queue-lock', mode: 'concurrent-simultaneous' },
  'h2-queue-lock-stale-reclaim': { tool: 'run-h-queue-lock', mode: 'stale-reclaim' },
  'g6-hub-survives-self-replacement': { tool: 'run-g-hub', mode: 'handoff' },
  'g7-hub-handoff-evidence': { tool: 'run-g-hub', mode: 'page-recovery' },
  'i1-restart-enrollment-truth': { tool: 'run-i-enrollment', mode: 'restart-truth' },
  'i2-unregistered-honesty': { tool: 'run-i-enrollment', mode: 'unregistered-honesty' },
  'i3-topology-compensation': { tool: 'run-i-compensation', mode: 'lock-remove-timeout' },
  'k-single-panel-happy': { tool: 'run-k-ui', mode: 'k1' },
  'k-single-panel-failure': { tool: 'run-k-ui', mode: 'k2' },
  'k-batch-panel-states': { tool: 'run-k-ui', mode: 'k3' },
  'k-batch-resume': { tool: 'run-k-ui', mode: 'k4' },
  'j1-log-contract-coverage': { tool: 'run-j-log', mode: 'contract-coverage' },
  'j2-noise-budget': { tool: 'run-j-log', mode: 'noise-budget' },
  'j3-namespace-whitelist': { tool: 'run-j-log', mode: 'namespace-whitelist' },
}

/**
 * can-red 期望失败 run：每组用「该场景历史上真实的失败 run」作为红断言期望集合。
 * 注入方式与矩阵 can-red 表一致；历史 run 只用来给期望，不复制其证据。
 */
interface CanRedSpec {
  readonly scenarioId: string
  readonly tool: string
  readonly mode?: string
  readonly fault?: string
  readonly historyRunId: string
}

const CAN_RED_SPECS: readonly CanRedSpec[] = [
  { scenarioId: 'a-single-package-main-chain', tool: 'run-a-main-chain', fault: 'stale-variant', historyRunId: '265-20261101T214716' },
  { scenarioId: 'b-batch-two-integrators', tool: 'run-b-batch', fault: 'skip-variant:c', historyRunId: '266-20261102T080334' },
  { scenarioId: 'c-pure-target-no-wiring', tool: 'run-c-pure-target', fault: 'stale-variant:c', historyRunId: '266-20261102T081101' },
  { scenarioId: 'd1-desktop-manager-update-success', tool: 'run-d-desktop-manager', mode: 'can-red', historyRunId: '267-20261102T113218' },
  { scenarioId: 'e1-cli-host-update-success', tool: 'run-e-cli-host', mode: 'can-red', historyRunId: '267-20261102T113629' },
  { scenarioId: 'g4-desktop-manager-retry-single-success', tool: 'run-g-settlement', mode: 'retry-can-red', historyRunId: '268-20261102T180537' },
  { scenarioId: 'e-batch-three-package-upgrade', tool: 'run-e-batch', mode: 'can-red', historyRunId: '269-20261102T230056' },
  { scenarioId: 'i1-restart-enrollment-truth', tool: 'run-i-enrollment', mode: 'can-red', historyRunId: '272-20261103T041611' },
  { scenarioId: 'k-single-panel-happy', tool: 'run-k-ui', mode: 'can-red', historyRunId: '274-20261103T090655' },
  { scenarioId: 'j1-log-contract-coverage', tool: 'run-j-log', mode: 'can-red', historyRunId: '273-20261103T054614' },
  { scenarioId: 'h1-queue-lock-concurrent', tool: 'run-h-queue-lock', mode: 'can-red', historyRunId: '270-20261103T004915' },
  { scenarioId: 'g6-hub-survives-self-replacement', tool: 'run-g-hub', mode: 'can-red', historyRunId: '271-20261103T015357' },
]

/** known-red 账本（selftest/evidence/known-red.md，棘轮：只增不减）。只有这 4 条允许 known-red 收尾。 */
interface KnownRedEntry {
  readonly id: string
  readonly scenarioId: string
  readonly firstRunId: string
}

const KNOWN_RED_LEDGER: readonly KnownRedEntry[] = [
  { id: 't3-267-exit-one', scenarioId: 'f1-third-party-desktop-probe', firstRunId: '267-20261102T113042' },
  { id: 't4-268-no-cancel-probe', scenarioId: 'g5-desktop-manager-no-cancel-probe', firstRunId: '268-20261102T181106' },
  { id: 't8-272-panel-pending-restart-branch', scenarioId: 'i1-restart-enrollment-truth', firstRunId: '272-20261103T040926' },
  { id: 't8-272-i2-runtime-version-not-authoritative', scenarioId: 'i2-unregistered-honesty', firstRunId: '272-20261103T040932' },
]

/** 支持 --no-evidence-sync 的工具（其余工具恒把证据复制进仓库，试错时不要选）。 */
const NO_SYNC_CAPABLE: readonly string[] = [
  'run-e-batch',
  'run-g-hub',
  'run-i-compensation',
  'run-h-queue-lock',
  'run-i-enrollment',
  'run-k-ui',
  'run-j-log',
]

const DEFAULT_VERDACCIO_INSTALL_DIR = 'D:/dsh-plugin/_wt263/runtime/tools/verdaccio'

/** suite 起跑前统一构建过 dist 后置 true：子进程的 npm（pack/publish）以 npm_config_ignore_scripts 跳过 prepack 重建。 */
let suitePrebuildActive = false
const DEFAULT_MAINTAINER_HOME = 'C:/Users/辰辰洋洋/.dsh'
/** k/j 组 UI 场景的 Playwright 兜底目录（仓库外已装，不进 package.json；可用 --playwright 或 DSH_VERIFY_PLAYWRIGHT 覆盖）。 */
const DEFAULT_PLAYWRIGHT_DIR = 'D:/dsh-plugin/dsh-mattpocock-skills-deck/node_modules/playwright'

function resolvePlaywrightDir(worktree: string): { dir: string | null; source: string } {
  const candidates: Array<{ dir: string; source: string }> = []
  const fromEnv = process.env.DSH_VERIFY_PLAYWRIGHT
  if (typeof fromEnv === 'string' && fromEnv !== '') candidates.push({ dir: fromEnv, source: 'env' })
  candidates.push({ dir: join(worktree, 'node_modules', 'playwright'), source: 'worktree' })
  candidates.push({ dir: DEFAULT_PLAYWRIGHT_DIR, source: 'deck' })
  for (const candidate of candidates) {
    if (existsSync(join(candidate.dir, 'package.json'))) return candidate
  }
  return { dir: null, source: 'missing' }
}

interface Options {
  readonly worktree: string
  readonly runBaseDir: string
  readonly verdaccioInstallDir: string
  readonly esbuildPath: string
  readonly maintainerHome: string
  readonly playwrightDir: string | null
  readonly stamp: string
  readonly stampProvided: boolean
  readonly only: readonly string[] | null
  readonly skip: readonly string[]
  readonly noCanRed: boolean
  readonly noEvidenceSync: boolean
  readonly dryRun: boolean
  readonly rerun: boolean
  readonly rebuildState: boolean
  readonly suiteOut: string | null
  readonly timeoutMs: number
  readonly webConcurrency: number
}

interface PlannedSpec {
  readonly key: string
  readonly kind: 'pass' | 'can-red'
  readonly scenarioId: string
  readonly ticket: string
  readonly hostChannel: HostChannel
  readonly summary: string
  readonly tool: string
  readonly mode: string | null
  readonly fault: string | null
  readonly order: number
  readonly stamp: string
  readonly allowedVerdicts: readonly Verdict[]
  readonly historicalRunId: string | null
  readonly canRedHistoryRunId: string | null
  readonly expectedRedIds: readonly string[] | null
  readonly expectedRedSteps: readonly string[] | null
}

interface AssertionCounts {
  readonly total: number
  readonly pass: number
  readonly fail: number
  readonly knownRed: number
  readonly unknown: number
}

interface HistoricalRun {
  readonly runId: string
  readonly scenarioId: string
  readonly ticket: string
  readonly verdict: Verdict
  readonly exitCode: number | null
  readonly assertions: number
  readonly shots: number
}

interface ScenarioRecord {
  key: string
  kind: 'pass' | 'can-red'
  scenarioId: string
  ticket: string
  hostChannel: HostChannel
  summary: string
  tool: string
  mode: string | null
  fault: string | null
  order: number
  stamp: string
  runId: string
  runDir: string
  evidencePath: string | null
  evidenceSynced: boolean
  isHistorical: boolean
  historicalRunId: string | null
  canRedHistoryRunId: string | null
  startedAt: string
  finishedAt: string | null
  durationMs: number
  processExitCode: number | null
  timedOut: boolean
  spawnError: string | null
  runVerdict: Verdict | null
  exitCode: number | null
  assertions: AssertionCounts
  redIds: string[]
  knownRedIds: string[]
  expectedVerdict: readonly Verdict[]
  expectedRedIds: readonly string[] | null
  expectedRedSteps: readonly string[] | null
  outcome: Outcome | 'running'
  notes: string[]
}

interface SuiteEnvironment {
  node: string
  platform: string
  worktree: string
  branch: string
  head: string
  dirtyFiles: number
  hostChannel: 'mixed'
  concurrency: { desktop: number; web: number }
  pnpmCacheMode: 'per-run-private'
  maintainerHome: string
  runBaseDir: string
}

interface SuiteState {
  schemaVersion: 1
  kind: 'full-matrix-suite'
  runId: string
  ticket: string
  title: string
  status: 'running' | 'finished'
  startedAt: string
  finishedAt: string | null
  verdict: Verdict
  exitCode: number | null
  environment: SuiteEnvironment
  isolationFacts: {
    pnpmCacheRoot: string
    perScenarioRegistry: string
    pnpmCacheNote: string
    playwrightDir: string | null
    playwrightNote: string
    /** 起跑前统一构建一次 dist（可选：续跑的老 suite run.json 没有这一段）。 */
    suitePrebuild?: {
      ok: boolean
      digest: string
      files: number
      durationMs: number
      note: string
    }
  }
  scenarios: ScenarioRecord[]
  knownRedLedger: Array<{
    id: string
    scenarioId: string
    firstRunId: string
    status: 'documented-unreachable' | 'documented-condition'
    thisRound: string
  }>
  cleanup: { processes: number[]; ports: string[]; notes: string[] }
  notes: string[]
}

interface SuiteRuntime {
  opts: Options
  state: SuiteState
  suiteDir: string
  runtimeSuiteDir: string
  fullPlan: PlannedSpec[]
  runPlan: PlannedSpec[]
  persist: () => Promise<void>
}

interface ProcResult {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  stdout: string
  stderr: string
  spawnError: string | null
}

interface RunJsonShape {
  runId?: string
  ticket?: string
  scenarioId?: string
  verdict?: Verdict
  exitCode?: number
  assertions?: Array<{ id?: string; verdict?: string; step?: string }>
  shots?: unknown[]
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

function splitList(value: string | undefined): string[] {
  if (value === undefined || value === '') return []
  return value.split(',').map((item) => item.trim()).filter((item) => item !== '')
}

function parseArgs(argv: readonly string[]): Options {
  const values = new Map<string, string>()
  const flags = new Set<string>()
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) throw new Error('无法解析参数：' + JSON.stringify(item))
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      values.set(item.slice(2), next)
      index += 1
    } else {
      flags.add(item.slice(2))
    }
  }
  const runBaseDir = values.get('run-base-dir')
  if (runBaseDir === undefined || runBaseDir === '') {
    throw new Error('必须传 --run-base-dir（真机临时目录根，例如 D:/dsh-plugin/_wt263/runtime/t11-275）')
  }
  const worktree = values.get('worktree') || process.cwd()
  const playwrightResolved = values.has('playwright')
    ? { dir: values.get('playwright') || null, source: 'cli' }
    : resolvePlaywrightDir(worktree)
  const stampProvided = values.has('stamp')
  const stamp = values.get('stamp') || formatRunStamp()
  const webConcurrencyRaw = values.get('web-concurrency')
  const webConcurrency = webConcurrencyRaw === undefined ? 3 : Number(webConcurrencyRaw)
  if (!Number.isInteger(webConcurrency) || webConcurrency < 1 || webConcurrency > 3) {
    throw new Error('--web-concurrency 只支持 1..3（官方桌面单实例；web 通道并发上限按 brief 为 3）')
  }
  const timeoutRaw = values.get('timeout-ms')
  const timeoutMs = timeoutRaw === undefined ? 1800000 : Number(timeoutRaw)
  if (!Number.isFinite(timeoutMs) || timeoutMs < 60000) throw new Error('--timeout-ms 至少 60000')
  return {
    worktree,
    runBaseDir,
    verdaccioInstallDir: values.get('verdaccio-install-dir') || DEFAULT_VERDACCIO_INSTALL_DIR,
    esbuildPath: values.get('esbuild') || join(worktree, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe'),
    maintainerHome: values.get('maintainer-home') || DEFAULT_MAINTAINER_HOME,
    playwrightDir: playwrightResolved.dir,
    stamp,
    stampProvided,
    only: values.has('only') ? splitList(values.get('only')) : null,
    skip: splitList(values.get('skip')),
    noCanRed: flags.has('no-can-red'),
    noEvidenceSync: flags.has('no-evidence-sync'),
    dryRun: flags.has('dry-run'),
    rerun: flags.has('rerun'),
    rebuildState: flags.has('rebuild-state'),
    suiteOut: values.get('suite-out') || null,
    timeoutMs,
    webConcurrency,
  }
}

// ---------------------------------------------------------------------------
// 基础设施：git / 进程 / 文件
// ---------------------------------------------------------------------------

function gitOutput(worktree: string, args: readonly string[]): string {
  const result = spawnSync('git', ['-C', worktree, ...args], { windowsHide: true })
  return result.status === 0 ? String(result.stdout || '').trim() : ''
}

function killProcessTree(pid: number): void {
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
}

/** 查本 suite 运行根下残留的官方桌面实例与 verdaccio 进程（只匹配 --run-base-dir 的目录名叶子，不碰别人的实例）。
 *  includeVerdaccio=false 时只查官方桌面实例：per-run 预清理必须用这个模式——desktop 队列起动时 web 队列可能正并行跑，
 *  另一个场景自己的 verdaccio 也落在本 suite 运行根下，泛查会跨场景误杀（T11 首轮全量第 29 个 run 的实际事故）。 */
function queryOwnProcesses(runBaseDir: string, includeVerdaccio: boolean = true): Array<{ pid: number; name: string }> {
  const leaf = basename(runBaseDir).replace(/'/g, "''")
  // 只匹配「本 suite 运行根下按 <ticket>-<stamp> 目录跑的」隔离桌面实例与 verdaccio。
  // 绝不匹配外层 harness 的 subprocess runner（它的命令行里也含 run-base-dir 文本）与本编排器自身：
  // T2 教训——按 runId 泛匹配会杀掉自己的 runner，导致 job runner 异常退出。
  const script =
    "$ErrorActionPreference='SilentlyContinue'; $leaf='" + leaf +
    "'; $pattern=$leaf + '[\\\\/][0-9]{2,4}-[0-9]{8}T'; Get-CimInstance Win32_Process | Where-Object { " +
    "($_.ProcessId -ne " + String(process.pid) + ") -and ($_.CommandLine -match $pattern) -and " +
    "($_.CommandLine -notlike '*run-all.ts*') -and " +
    "((($_.Name -eq 'DeepSeek Harness.exe') -and ($_.CommandLine -like '*--user-data-dir*')) -or " +
    "(($_.Name -eq 'node.exe') -and ($_.CommandLine -like '*verdaccio*'))) } | " +
    "Select-Object ProcessId,Name | ConvertTo-Json -Compress"
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
  const text = String(result.stdout || '').trim()
  if (text === '') return []
  try {
    const parsed = JSON.parse(text) as unknown
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    const found: Array<{ pid: number; name: string }> = []
    for (const row of rows) {
      const item = row as { ProcessId?: number; Name?: string }
      if (typeof item.ProcessId === 'number') found.push({ pid: item.ProcessId, name: String(item.Name || '') })
    }
    // 桌面实例名固定；verdaccio 是 node.exe（由 verdaccio bin 拉起），按名字区分即可，不解析更细的命令行。
    return includeVerdaccio ? found : found.filter((item: { pid: number; name: string }) => item.name !== 'node.exe')
  } catch {
    return []
  }
}

function killOwnProcesses(runBaseDir: string, includeVerdaccio: boolean = true): number[] {
  const found = queryOwnProcesses(runBaseDir, includeVerdaccio)
  for (const item of found) killProcessTree(item.pid)
  return found.map((item) => item.pid)
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => resolve(), ms)
  })
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await readFile(path, 'utf8')
    const parsed = JSON.parse(text) as unknown
    if (parsed !== null && typeof parsed === 'object') return parsed as Record<string, unknown>
    return null
  } catch {
    return null
  }
}

function parseLastJsonObject(text: string): Record<string, unknown> | null {
  const marker = text.lastIndexOf('"runDir"')
  if (marker < 0) return null
  const start = text.lastIndexOf('{', marker)
  if (start < 0) return null
  const tail = text.slice(start).trim()
  try {
    return JSON.parse(tail) as Record<string, unknown>
  } catch {
    const end = tail.lastIndexOf('}')
    if (end > 0) {
      try {
        return JSON.parse(tail.slice(0, end + 1)) as Record<string, unknown>
      } catch {
        return null
      }
    }
    return null
  }
}

function countOutcomes(records: readonly ScenarioRecord[]): {
  pass: number
  knownRed: number
  fail: number
  unknown: number
  canRedExpected: number
  canRedBad: number
} {
  let pass = 0
  let knownRed = 0
  let fail = 0
  let unknown = 0
  let canRedExpected = 0
  let canRedBad = 0
  for (const record of records) {
    if (record.outcome === 'pass') pass += 1
    else if (record.outcome === 'known-red') knownRed += 1
    else if (record.outcome === 'can-red-expected-fail') canRedExpected += 1
    else if (record.outcome === 'can-red-unexpected-pass' || record.outcome === 'can-red-mismatch') {
      canRedBad += 1
      fail += 1
    } else if (record.outcome === 'fail') fail += 1
    else unknown += 1
  }
  return { pass, knownRed, fail, unknown, canRedExpected, canRedBad }
}

function aggregateVerdict(records: readonly ScenarioRecord[]): { verdict: Verdict; exitCode: number } {
  const counts = countOutcomes(records)
  if (counts.fail > 0) return { verdict: 'fail', exitCode: 1 }
  if (counts.unknown > 0) return { verdict: 'unknown', exitCode: 1 }
  if (counts.knownRed > 0) return { verdict: 'known-red', exitCode: 0 }
  return { verdict: 'pass', exitCode: 0 }
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return seconds + 's'
  return Math.floor(seconds / 60) + 'm' + (seconds % 60) + 's'
}

function pad2(value: number): string {
  return value < 10 ? '0' + String(value) : String(value)
}

// ---------------------------------------------------------------------------
// 历史证据发现（用于「定稿历史 run」列与 can-red 期望集合）
// ---------------------------------------------------------------------------

interface HistoricalIndex {
  pass: Map<string, HistoricalRun>
  canRed: Map<string, HistoricalRun>
}

async function discoverHistoricalRuns(worktree: string): Promise<HistoricalIndex> {
  const runsDir = join(worktree, 'selftest', 'evidence', 'runs')
  const index: HistoricalIndex = { pass: new Map<string, HistoricalRun>(), canRed: new Map<string, HistoricalRun>() }
  if (!existsSync(runsDir)) return index
  const entries = await readdir(runsDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const runId = entry.name
    const runJson = (await readJsonFile(join(runsDir, runId, 'run.json'))) as RunJsonShape | null
    if (runJson === null) continue
    const scenarioId = typeof runJson.scenarioId === 'string' ? runJson.scenarioId : ''
    const verdict = runJson.verdict
    if (scenarioId === '' || (verdict !== 'pass' && verdict !== 'known-red' && verdict !== 'fail')) continue
    const historical: HistoricalRun = {
      runId,
      scenarioId,
      ticket: typeof runJson.ticket === 'string' ? runJson.ticket : runId.split('-')[0],
      verdict,
      exitCode: typeof runJson.exitCode === 'number' ? runJson.exitCode : null,
      assertions: Array.isArray(runJson.assertions) ? runJson.assertions.length : 0,
      shots: Array.isArray(runJson.shots) ? runJson.shots.length : 0,
    }
    const bucket = verdict === 'fail' ? index.canRed : index.pass
    const previous = bucket.get(scenarioId)
    if (previous === undefined || previous.runId < runId) bucket.set(scenarioId, historical)
  }
  return index
}

/** 从历史 can-red run.json 读期望红断言：id + 断言所属步骤（step）。
 *  步骤用于「同一断言因场景增删断言导致编号漂移」时按语义匹配（例如 e1 历史 40-assert → 本轮 41-assert，
 *  step/what 完全相同）；编号仍是首选键，漂移会在 suite notes 里显式记一行，不放宽成「任意红断言」。 */
async function readExpectedRedIds(
  worktree: string,
  historyRunId: string,
): Promise<{
  redIds: string[] | null
  redSteps: string[] | null
  scenarioId: string | null
  verdict: Verdict | null
}> {
  const runJson = (await readJsonFile(
    join(worktree, 'selftest', 'evidence', 'runs', historyRunId, 'run.json'),
  )) as RunJsonShape | null
  if (runJson === null) return { redIds: null, redSteps: null, scenarioId: null, verdict: null }
  const assertions = Array.isArray(runJson.assertions) ? runJson.assertions : []
  const redIds: string[] = []
  const redSteps: string[] = []
  for (const assertion of assertions) {
    if (assertion.verdict === 'fail' || assertion.verdict === 'unknown') {
      redIds.push(typeof assertion.id === 'string' ? assertion.id : '(无 id)')
      redSteps.push(typeof assertion.step === 'string' ? assertion.step : '')
    }
  }
  return {
    redIds: redIds.length > 0 ? redIds : null,
    redSteps: redSteps.length > 0 ? redSteps : null,
    scenarioId: typeof runJson.scenarioId === 'string' ? runJson.scenarioId : null,
    verdict: runJson.verdict === undefined ? null : runJson.verdict,
  }
}

// ---------------------------------------------------------------------------
// 计划构建
// ---------------------------------------------------------------------------

interface PlanResult {
  fullPlan: PlannedSpec[]
  runPlan: PlannedSpec[]
  notes: string[]
}

async function buildPlan(opts: Options): Promise<PlanResult> {
  const notes: string[] = []
  const historical = await discoverHistoricalRuns(opts.worktree)
  const redCache = new Map<string, { ids: string[]; steps: string[] } | null>()
  const knownRedScenarioIds = new Set<string>(KNOWN_RED_LEDGER.map((entry) => entry.scenarioId))
  const baseSpecs: PlannedSpec[] = []
  let order = 0

  for (const declaration of SCENARIOS) {
    const scenarioId = declaration.id
    const toolSpec = TOOL_BY_SCENARIO[scenarioId]
    if (toolSpec === undefined) {
      throw new Error('场景声明 ' + scenarioId + ' 在 run-all 的 TOOL_BY_SCENARIO 里没有落点（新增场景要补映射）')
    }
    order += 1
    const passHistorical = historical.pass.get(scenarioId)
    if (passHistorical === undefined) notes.push('场景 ' + scenarioId + ' 没有定稿历史 run（isHistorical 列将为空）')
    baseSpecs.push({
      key: scenarioId,
      kind: 'pass',
      scenarioId,
      ticket: declaration.ticket,
      hostChannel: declaration.hostChannel as HostChannel,
      summary: declaration.summary,
      tool: toolSpec.tool,
      mode: toolSpec.mode === undefined ? null : toolSpec.mode,
      fault: toolSpec.fault === undefined ? null : toolSpec.fault,
      order,
      stamp: opts.stamp + '-p' + pad2(order),
      allowedVerdicts: knownRedScenarioIds.has(scenarioId) ? (['pass', 'known-red'] as const) : (['pass'] as const),
      historicalRunId: passHistorical === undefined ? null : passHistorical.runId,
      canRedHistoryRunId: null,
      expectedRedIds: null,
      expectedRedSteps: null,
    })
  }

  if (!opts.noCanRed) {
    for (const canRed of CAN_RED_SPECS) {
      const declaration = SCENARIOS.find((item) => item.id === canRed.scenarioId)
      if (declaration === undefined) throw new Error('can-red 场景 ' + canRed.scenarioId + ' 不在 SCENARIOS 声明里')
      if (!redCache.has(canRed.historyRunId)) {
        const history = await readExpectedRedIds(opts.worktree, canRed.historyRunId)
        if (history.verdict !== 'fail') {
          notes.push('can-red 历史 run ' + canRed.historyRunId + ' 的 verdict 不是 fail（实际 ' + String(history.verdict) + '），期望集合不可用')
          redCache.set(canRed.historyRunId, null)
        } else if (history.scenarioId !== null && history.scenarioId !== canRed.scenarioId) {
          notes.push('can-red 历史 run ' + canRed.historyRunId + ' 的 scenarioId=' + history.scenarioId + ' 与声明 ' + canRed.scenarioId + ' 不符')
          redCache.set(canRed.historyRunId, null)
        } else {
          redCache.set(
            canRed.historyRunId,
            history.redIds === null
              ? null
              : { ids: history.redIds, steps: history.redSteps === null ? [] : history.redSteps },
          )
          if (history.redIds === null) notes.push('can-red 历史 run ' + canRed.historyRunId + ' 没有红断言记录')
        }
      }
      const cached = redCache.get(canRed.historyRunId) || null
      const expectedRedIds = cached === null ? null : cached.ids
      const expectedRedSteps = cached === null ? null : cached.steps
      order += 1
      baseSpecs.push({
        key: 'can-red:' + canRed.scenarioId,
        kind: 'can-red',
        scenarioId: canRed.scenarioId,
        ticket: declaration.ticket,
        hostChannel: declaration.hostChannel as HostChannel,
        summary: declaration.summary,
        tool: canRed.tool,
        mode: canRed.mode === undefined ? null : canRed.mode,
        fault: canRed.fault === undefined ? null : canRed.fault,
        order,
        stamp: opts.stamp + '-r' + pad2(order),
        allowedVerdicts: ['fail'] as const,
        historicalRunId: historical.pass.get(canRed.scenarioId)?.runId ?? null,
        canRedHistoryRunId: canRed.historyRunId,
        expectedRedIds,
        expectedRedSteps,
      })
    }
  }

  const only = opts.only === null ? null : new Set<string>(opts.only)
  const skip = new Set<string>(opts.skip)
  if (only !== null) {
    for (const token of only) {
      if (!baseSpecs.some((spec) => spec.key === token)) {
        throw new Error('--only 里的 ' + JSON.stringify(token) + ' 不是已知场景 id 或 can-red:<场景 id>')
      }
    }
  }
  const matches = (spec: PlannedSpec): boolean => {
    if (skip.has(spec.key) || skip.has(spec.scenarioId)) return false
    if (only === null) return true
    if (only.has(spec.key)) return true
    // 点名场景 id 只跑该场景主链；can-red 必须显式写 can-red:<id>（避免试跑意外带上注入 run）
    return spec.kind === 'pass' && only.has(spec.scenarioId)
  }
  const runPlan = baseSpecs.filter(matches)
  if (runPlan.length === 0) throw new Error('筛选后没有要跑的场景（检查 --only/--skip/--no-can-red）')
  return { fullPlan: baseSpecs, runPlan, notes }
}

// ---------------------------------------------------------------------------
// suite 状态
// ---------------------------------------------------------------------------

function createSuiteState(opts: Options, plan: PlanResult): SuiteState {
  const environment: SuiteEnvironment = {
    node: process.version,
    platform: process.platform,
    worktree: opts.worktree,
    branch: gitOutput(opts.worktree, ['rev-parse', '--abbrev-ref', 'HEAD']),
    head: gitOutput(opts.worktree, ['rev-parse', 'HEAD']),
    dirtyFiles: gitOutput(opts.worktree, ['status', '--porcelain']).split('\n').filter((line) => line.trim() !== '').length,
    hostChannel: 'mixed',
    concurrency: { desktop: 1, web: opts.webConcurrency },
    pnpmCacheMode: 'per-run-private',
    maintainerHome: opts.maintainerHome,
    runBaseDir: opts.runBaseDir,
  }
  return {
    schemaVersion: 1,
    kind: 'full-matrix-suite',
    runId: opts.stamp + '-full',
    ticket: '275',
    title: 'spec #263 全量真机矩阵回归（A–K 主链 + can-red 期望失败）',
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    verdict: 'unknown',
    exitCode: null,
    environment,
    isolationFacts: {
      pnpmCacheRoot: join(opts.runBaseDir, '_pkgcache'),
      perScenarioRegistry: '每个场景子进程自起本地 verdaccio（动态端口），suite 不复用 registry',
      pnpmCacheNote:
        'T10 坑：共享 D:/caches/pnpm 的缓存键含 registry origin+端口，复用会命中旧 packument → ERR_PNPM_TARBALL_INTEGRITY 假红；本 suite 每个 run 独立 pnpm_config_cache_dir/npm_config_cache/npm_config_store_dir',
      playwrightDir: opts.playwrightDir,
      playwrightNote:
        opts.playwrightDir === null
          ? '未找到 Playwright：k/j 组 UI 场景会 unknown；用 --playwright 或 DSH_VERIFY_PLAYWRIGHT 指向已安装的 playwright 目录'
          : 'k/j 组 UI 场景通过子进程环境 DSH_VERIFY_PLAYWRIGHT=' + opts.playwrightDir + ' 加载（仓库外已装，不进 package.json）',
    },
    scenarios: [],
    knownRedLedger: KNOWN_RED_LEDGER.map((entry) => ({
      id: entry.id,
      scenarioId: entry.scenarioId,
      firstRunId: entry.firstRunId,
      status: 'documented-unreachable',
      thisRound: '本轮未跑',
    })),
    cleanup: { processes: [], ports: [], notes: [] },
    notes: plan.notes,
  }
}

function mergeState(state: SuiteState, plan: PlanResult, opts: Options): void {
  state.notes = Array.from(new Set([...state.notes, ...plan.notes]))
  state.knownRedLedger = state.knownRedLedger.map((entry) => ({ ...entry }))
  state.environment.concurrency = { desktop: 1, web: opts.webConcurrency }
}

function buildPersist(runtime: SuiteRuntime): () => Promise<void> {
  let chain: Promise<void> = Promise.resolve()
  const state = runtime.state
  return (): Promise<void> => {
    chain = chain.then(async () => {
      const aggregate = aggregateVerdict(state.scenarios)
      state.verdict = aggregate.verdict
      state.exitCode = aggregate.exitCode
      await writeFile(join(runtime.suiteDir, 'run.json'), JSON.stringify(state, null, 2) + '\n')
      await writeFile(join(runtime.suiteDir, 'index.md'), renderIndex(state, runtime.fullPlan))
    })
    return chain
  }
}

// ---------------------------------------------------------------------------
// 单个 run 执行
// ---------------------------------------------------------------------------

function buildToolArgs(opts: Options, spec: PlannedSpec): string[] {
  const toolPath = join(opts.worktree, 'selftest', 'real-machine', 'tools', spec.tool + '.ts')
  const args: string[] = [
    toolPath,
    '--worktree', opts.worktree,
    '--run-base-dir', opts.runBaseDir,
    '--verdaccio-install-dir', opts.verdaccioInstallDir,
    '--esbuild', opts.esbuildPath,
    '--stamp', spec.stamp,
    '--maintainer-home', opts.maintainerHome,
  ]
  if (spec.mode !== null) args.push('--mode', spec.mode)
  if (spec.fault !== null) args.push('--fault', spec.fault)
  if (opts.noEvidenceSync && NO_SYNC_CAPABLE.indexOf(spec.tool) >= 0) args.push('--no-evidence-sync')
  return args
}

function runToolProcess(opts: Options, spec: PlannedSpec, args: string[]): Promise<ProcResult> {
  return new Promise<ProcResult>((resolve) => {
    const runId = spec.ticket + '-' + spec.stamp
    const pkgCacheDir = join(opts.runBaseDir, '_pkgcache', runId)
    const env: Record<string, string | undefined> = { ...process.env }
    env.pnpm_config_cache_dir = pkgCacheDir
    env.npm_config_cache = pkgCacheDir
    env.npm_config_store_dir = pkgCacheDir
    if (opts.playwrightDir !== null) env.DSH_VERIFY_PLAYWRIGHT = opts.playwrightDir
    // 并发 run 各跑 npm pack 会各自触发 prepack（npm run build）同时重写同一个 dist/，聚合指纹在读/写竞争下漂移
    // （首轮全量 k-batch-resume 的 14/15-assert 实测事故）。dist 已在 suite 起跑前统一构建，这里跳过生命周期脚本。
    if (suitePrebuildActive) env.npm_config_ignore_scripts = 'true'
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(process.execPath, args, {
        cwd: opts.worktree,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: '',
        spawnError: error instanceof Error ? error.message : String(error),
      })
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let spawnError: string | null = null
    if (child.stdout !== null) {
      child.stdout.on('data', (chunk: Uint8Array) => {
        stdout += Buffer.from(chunk).toString('utf8')
      })
    }
    if (child.stderr !== null) {
      child.stderr.on('data', (chunk: Uint8Array) => {
        stderr += Buffer.from(chunk).toString('utf8')
      })
    }
    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid !== undefined) killProcessTree(child.pid)
      try {
        child.kill()
      } catch {
        // 已退出则忽略
      }
    }, opts.timeoutMs)
    const finish = (code: number | null, signal: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode: code, signal, timedOut, stdout, stderr, spawnError })
    }
    child.on('exit', (code, signal) => finish(code, signal))
    child.on('error', (error) => {
      spawnError = error instanceof Error ? error.message : String(error)
      finish(null, null)
    })
  })
}

async function readRunJson(runDir: string): Promise<RunJsonShape | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const parsed = await readJsonFile(join(runDir, 'run.json'))
    if (parsed !== null) return parsed as RunJsonShape
    await sleep(300)
  }
  return null
}

function assertionCountsOf(runJson: RunJsonShape | null): AssertionCounts {
  const assertions = runJson !== null && Array.isArray(runJson.assertions) ? runJson.assertions : []
  let pass = 0
  let fail = 0
  let knownRed = 0
  let unknown = 0
  for (const assertion of assertions) {
    if (assertion.verdict === 'pass') pass += 1
    else if (assertion.verdict === 'fail') fail += 1
    else if (assertion.verdict === 'known-red') knownRed += 1
    else unknown += 1
  }
  return { total: assertions.length, pass, fail, knownRed, unknown }
}

function classifyOutcome(
  spec: PlannedSpec,
  runJson: RunJsonShape | null,
  proc: ProcResult,
  processExitCode: number | null,
): { outcome: Outcome; notes: string[] } {
  const notes: string[] = []
  if (proc.timedOut) {
    notes.push('子进程超时（exit=' + String(processExitCode) + '），已杀进程树；按 blocked→unknown 收')
    return { outcome: 'blocked', notes }
  }
  if (proc.spawnError !== null) {
    notes.push('子进程启动失败：' + proc.spawnError)
    return { outcome: 'blocked', notes }
  }
  if (runJson === null) {
    if (processExitCode === 2) {
      notes.push('工具以 exit 2 收尾（blocked），且没有 run.json')
      return { outcome: 'blocked', notes }
    }
    notes.push('工具退出但没有 run.json（exit=' + String(processExitCode) + '）')
    return { outcome: 'unknown', notes }
  }
  if (runJson.scenarioId !== undefined && runJson.scenarioId !== spec.scenarioId) {
    notes.push('run.json 的 scenarioId=' + String(runJson.scenarioId) + ' 与声明 ' + spec.scenarioId + ' 不符')
    return { outcome: 'fail', notes }
  }
  const runVerdict = runJson.verdict
  const counts = assertionCountsOf(runJson)
  const redIds: string[] = []
  const redEntries: Array<{ id: string; step: string }> = []
  const assertions = Array.isArray(runJson.assertions) ? runJson.assertions : []
  for (const assertion of assertions) {
    if (assertion.verdict === 'fail') {
      const id = typeof assertion.id === 'string' ? assertion.id : '(无 id)'
      redIds.push(id)
      redEntries.push({ id, step: typeof assertion.step === 'string' ? assertion.step : '' })
    }
  }
  if (spec.kind === 'can-red') {
    const expected = spec.expectedRedIds
    if (runVerdict === 'fail' && redIds.length > 0) {
      if (expected !== null && expected.length > 0) {
        const expectedSteps = spec.expectedRedSteps === null ? [] : spec.expectedRedSteps
        const expectedStepSet = new Set(expectedSteps.filter((step) => step !== ''))
        const isMatched = (entry: { id: string; step: string }): boolean =>
          expected.indexOf(entry.id) >= 0 || (entry.step !== '' && expectedStepSet.has(entry.step))
        const extra = redEntries.filter((entry) => !isMatched(entry))
        if (extra.length > 0) {
          notes.push('红断言不在历史期望集合：' + extra.map((entry) => entry.id).join('、') + '（历史：' + expected.join('、') + '）')
          return { outcome: 'can-red-mismatch', notes }
        }
        const missing: string[] = []
        for (let index = 0; index < expected.length; index += 1) {
          const expectedId = expected[index]
          const expectedStep = expectedSteps[index] === undefined ? '' : expectedSteps[index]
          const hit = redEntries.some(
            (entry) => entry.id === expectedId || (expectedStep !== '' && entry.step === expectedStep),
          )
          if (!hit) missing.push(expectedId)
        }
        const drifted = redEntries.filter(
          (entry) => expected.indexOf(entry.id) < 0 && entry.step !== '' && expectedStepSet.has(entry.step),
        )
        if (drifted.length > 0) {
          notes.push(
            'can-red 断言编号漂移：历史 ' + expected.join('、') + ' → 本轮 ' + drifted.map((entry) => entry.id).join('、') +
              '，按断言语义步骤匹配（' + drifted.map((entry) => entry.step).join('；') + '）',
          )
        }
        if (missing.length > 0) notes.push('历史期望红断言本轮未红：' + missing.join('、'))
        return { outcome: 'can-red-expected-fail', notes }
      }
      notes.push('历史期望集合不可用，按「非空红断言」宽松校验')
      return { outcome: 'can-red-expected-fail', notes }
    }
    if (runVerdict === 'pass' || runVerdict === 'known-red') {
      notes.push('注入后没有产生 fail（verdict=' + String(runVerdict) + '，红断言 0 条）')
      return { outcome: 'can-red-unexpected-pass', notes }
    }
    notes.push('can-red run 的 verdict=' + String(runVerdict) + '（红断言 ' + String(redIds.length) + ' 条，不在 fail 路径）')
    return { outcome: 'can-red-mismatch', notes }
  }
  if (runVerdict === 'pass') return { outcome: 'pass', notes }
  if (runVerdict === 'known-red') {
    if (spec.allowedVerdicts.indexOf('known-red') >= 0) return { outcome: 'known-red', notes }
    notes.push('非 known-red 账本场景出现 known-red 收尾')
    return { outcome: 'fail', notes }
  }
  if (runVerdict === 'unknown') {
    notes.push('run 判定 unknown（断言 unknown 数 ' + String(counts.unknown) + '）')
    return { outcome: 'unknown', notes }
  }
  notes.push('run 判定 fail（红断言：' + redIds.join('、') + '）')
  return { outcome: 'fail', notes }
}

/** suite 起跑前在 worktree 里统一 npm run build 一次，并记录 dist 聚合指纹。
 *  之后所有子进程都带 npm_config_ignore_scripts=true，SUT pin 的 npm pack 不再触发 prepack 重建：
 *  多个 run 并发时各自 prepack 会同时重写同一个 dist/，聚合指纹在读/写竞争下漂移（首轮全量 k-batch-resume 的 14/15-assert 事故）。 */
async function runSuitePrebuild(opts: Options, runtime: SuiteRuntime): Promise<void> {
  const startedMs = Date.now()
  const result = spawnSync('npm', ['run', 'build'], { cwd: opts.worktree, shell: true, windowsHide: true })
  const durationMs = Date.now() - startedMs
  const distDir = join(opts.worktree, 'dist')
  const ok = result.status === 0 && existsSync(join(distDir, 'host.js'))
  let digest = ''
  let files = 0
  if (existsSync(distDir)) {
    const fingerprint = await directoryFingerprint(distDir)
    digest = fingerprint.digest
    files = fingerprint.files
  }
  const note = ok
    ? 'SUT dist：suite 起跑前在 worktree 统一 npm run build 一次（聚合指纹 ' + digest.slice(0, 16) + '…，' + String(files) + ' 文件），' +
      '所有 run 子进程带 npm_config_ignore_scripts=true，SUT pin 的 npm pack 不再并发触发 prepack 重建 dist/（避免并发写同一个 dist 造成指纹漂移）。'
    : 'SUT dist：suite 起跑前统一构建失败（exit ' + String(result.status) + '）。'
  const record = {
    ok,
    durationMs,
    digest,
    files,
    stdoutTail: String(result.stdout || '').split('\n').slice(-8).join('\n'),
    stderrTail: String(result.stderr || '').split('\n').slice(-12).join('\n'),
    note,
  }
  await writeFile(join(runtime.suiteDir, 'raw', '00-suite-prebuild.json'), JSON.stringify(record, null, 2) + '\n')
  runtime.state.isolationFacts.suitePrebuild = { ok, digest, files, durationMs, note }
  runtime.state.notes.push(note)
  if (!ok) {
    await runtime.persist()
    throw new Error('suite 起跑前 npm run build 失败（exit ' + String(result.status) + '）：' + record.stderrTail)
  }
  suitePrebuildActive = true
  console.log('[run-all] ' + note + '（' + String(durationMs) + 'ms）')
}

/** 按证据契约把 run 目录里的四件（run.json / index.md / shots/ / raw/）复制进仓库；成功返回 true。
 *  只复制这四件：运行目录里还有 user-data-dir、pack、npm-cache 等过程产物（可达数百 MB），不属于证据包。 */
async function copyEvidencePackage(runDir: string, dest: string): Promise<boolean> {
  try {
    await mkdir(dest, { recursive: true })
    for (const name of ['run.json', 'index.md']) {
      const src = join(runDir, name)
      if (existsSync(src)) await cp(src, join(dest, name))
    }
    for (const name of ['shots', 'raw']) {
      const src = join(runDir, name)
      if (existsSync(src)) await cp(src, join(dest, name), { recursive: true, force: true })
    }
    return existsSync(join(dest, 'run.json'))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 单个 run：执行 + 落记录 + 持久化
// ---------------------------------------------------------------------------

/** 记录重建：从已定稿证据（repo 里 selftest/evidence/runs/<runId>/run.json）与编排 raw 日志复原
 *  suite 的聚合记录。用于「聚合记录被误清、但每个 run 的证据包仍然在」的事故恢复；
 *  数据源只有证据本身，不重跑、不臆造结论。--rebuild-state 只补缺失记录，已有记录不动。 */
async function rebuildRecords(runtime: SuiteRuntime, plan: PlanResult): Promise<void> {
  const opts = runtime.opts
  const state = runtime.state
  let restored = 0
  let kept = 0
  for (const spec of plan.fullPlan) {
    const runId = spec.ticket + '-' + spec.stamp
    if (state.scenarios.some((item) => item.key === spec.key && item.runId === runId)) {
      kept += 1
      continue
    }
    const evidenceRel = 'selftest/evidence/runs/' + runId
    const runJson = (await readJsonFile(join(opts.worktree, evidenceRel, 'run.json'))) as RunJsonShape | null
    if (runJson === null) {
      state.notes.push('记录重建：' + spec.key + ' 的定稿证据缺失（' + evidenceRel + '），保持无记录')
      continue
    }
    const rawLogPath = join(runtime.suiteDir, 'raw', spec.key + '.log')
    let processExitCode: number | null = null
    if (existsSync(rawLogPath)) {
      const match = /^\[exit\] (-?\d+)/m.exec(await readFile(rawLogPath, 'utf8'))
      if (match !== null) processExitCode = Number(match[1])
    }
    const proc: ProcResult = {
      exitCode: processExitCode,
      signal: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      spawnError: null,
    }
    const classification = classifyOutcome(spec, runJson, proc, processExitCode)
    const counts = assertionCountsOf(runJson)
    const redIds: string[] = []
    const knownRedIds: string[] = []
    const assertions = Array.isArray(runJson.assertions) ? runJson.assertions : []
    for (const assertion of assertions) {
      const id = typeof assertion.id === 'string' ? assertion.id : '(无 id)'
      if (assertion.verdict === 'fail') redIds.push(id)
      else if (assertion.verdict === 'known-red') knownRedIds.push(id)
    }
    const startedAtRaw = runJson['startedAt']
    const finishedAtRaw = runJson['finishedAt']
    const startedAt = typeof startedAtRaw === 'string' ? startedAtRaw : new Date().toISOString()
    const finishedAt = typeof finishedAtRaw === 'string' ? finishedAtRaw : null
    let durationMs = 0
    if (finishedAt !== null) {
      const delta = Date.parse(finishedAt) - Date.parse(startedAt)
      if (Number.isFinite(delta) && delta >= 0) durationMs = delta
    }
    const record: ScenarioRecord = {
      key: spec.key,
      kind: spec.kind,
      scenarioId: spec.scenarioId,
      ticket: spec.ticket,
      hostChannel: spec.hostChannel,
      summary: spec.summary,
      tool: spec.tool,
      mode: spec.mode,
      fault: spec.fault,
      order: spec.order,
      stamp: spec.stamp,
      runId,
      runDir: join(opts.runBaseDir, runId),
      evidencePath: evidenceRel,
      evidenceSynced: true,
      isHistorical: false,
      historicalRunId: spec.historicalRunId,
      canRedHistoryRunId: spec.canRedHistoryRunId,
      startedAt,
      finishedAt,
      durationMs,
      processExitCode,
      timedOut: false,
      spawnError: null,
      runVerdict: runJson.verdict === undefined ? null : runJson.verdict,
      exitCode: typeof runJson.exitCode === 'number' ? runJson.exitCode : null,
      assertions: counts,
      redIds,
      knownRedIds,
      expectedVerdict: spec.allowedVerdicts,
      expectedRedIds: spec.expectedRedIds,
      expectedRedSteps: spec.expectedRedSteps,
      outcome: classification.outcome,
      notes: ['聚合记录由证据重建（数据源：' + evidenceRel + '/run.json 与编排 raw/' + spec.key + '.log；原因见 suite notes）'].concat(
        classification.notes,
      ),
    }
    state.scenarios.push(record)
    restored += 1
  }
  // known-red 终账的「本轮观察」按最终记录回填（重建记录也要回填，否则账本会误报『本轮未跑』）。
  for (const spec of plan.fullPlan) {
    if (spec.kind === 'can-red') continue // can-red 是注入后的刻意失败，不写进 known-red 终账的「本轮观察」
    const record = state.scenarios.find((item) => item.key === spec.key)
    if (record === undefined) continue
    const ledgerEntry = state.knownRedLedger.find((entry) => entry.scenarioId === spec.scenarioId)
    if (ledgerEntry !== undefined) {
      ledgerEntry.thisRound = 'run ' + record.runId + '：' + String(record.runVerdict) + '（' + record.outcome + '）'
    }
  }
  state.scenarios.sort((left, right) => left.order - right.order)
  // 重建补齐到全量后，旧的「部分 suite」说明已不成立，去掉；重建说明只保留一条。
  state.notes = state.notes.filter((note) => note.indexOf('本轮是部分 suite') < 0)
  const rebuilt = state.scenarios.filter((item) => item.notes.some((note) => note.indexOf('聚合记录由证据重建') >= 0)).length
  // 恢复模式可能多次执行（后续定向重跑会让部分重建记录换成自然记录）：每次按当前数字重写该说明。
  state.notes = state.notes.filter((note) => note.indexOf('记录重建（--rebuild-state）') < 0)
  state.notes.push(
    '记录重建（--rebuild-state）：最近一次补回 ' + String(restored) + ' 条、保留已有 ' + String(kept) + ' 条（当前共 ' +
      String(rebuilt) + ' 条为证据重建记录，每条注明数据源；不是重跑结果）。',
  )
  await runtime.persist()
  console.log('[run-all] --rebuild-state：补回 ' + String(restored) + ' 条聚合记录（保留已有 ' + String(kept) + ' 条）')
}

async function executeSpec(spec: PlannedSpec, runtime: SuiteRuntime): Promise<void> {
  const opts = runtime.opts
  const state = runtime.state
  const runId = spec.ticket + '-' + spec.stamp
  // 续跑：同一 --stamp 下，已完成且结论为『良好』（pass / known-red / can-red 按预期红）的 run 直接复用记录，
  // 不重跑；unknown/fail/blocked 的 run 重跑，并先删自己上一轮那半个运行目录，避免新旧 raw 混在一起。
  const prior = runtime.state.scenarios.find((item) => item.key === spec.key)
  const priorGood =
    prior !== undefined &&
    (prior.outcome === 'pass' || prior.outcome === 'known-red' || prior.outcome === 'can-red-expected-fail')
  if (prior !== undefined && priorGood && !opts.rerun) {
    console.log('[run-all] ↺ 续跑跳过已完成：' + spec.key + '（' + String(prior.outcome) + '，run ' + prior.runId + '）')
    return
  }
  // 无论续跑还是 --rerun，执行前都先清掉自己上一轮那半个运行目录：--rerun 复用旧目录会让 verdaccio
  // 存储里残留上一轮的 SUT tarball（publish 同版本直接 exit 1），新旧 raw 也会混在一起。
  if (prior !== undefined || existsSync(join(opts.runBaseDir, runId))) {
    await rm(join(opts.runBaseDir, runId), { recursive: true, force: true })
  }
  const pkgCacheDir = join(opts.runBaseDir, '_pkgcache', runId)
  await mkdir(pkgCacheDir, { recursive: true })
  const startedAt = new Date().toISOString()
  const startedMs = Date.now()

  const preNotes: string[] = []
  if (spec.hostChannel === 'desktop-official') {
    // 只清残留的官方桌面实例：桌面队列串行，不存在“别的桌面 run 正在跑”；但 web 队列可能并行，
    // 它们各自的 verdaccio 也带本 suite 运行根目录名，泛清会跨场景误杀（首轮全量 k-batch-resume 的 unknown 即此因）。
    const killed = killOwnProcesses(opts.runBaseDir, false)
    if (killed.length > 0) preNotes.push('run 前清理本 suite 残留桌面实例：' + killed.join(','))
  }

  const args = buildToolArgs(opts, spec)
  const command = 'node ' + args.join(' ')
  const commandRecord = {
    key: spec.key,
    kind: spec.kind,
    scenarioId: spec.scenarioId,
    ticket: spec.ticket,
    hostChannel: spec.hostChannel,
    tool: spec.tool,
    mode: spec.mode,
    fault: spec.fault,
    stamp: spec.stamp,
    runId,
    command,
    cwd: opts.worktree,
    env: {
      pnpm_config_cache_dir: pkgCacheDir,
      npm_config_cache: pkgCacheDir,
      npm_config_store_dir: pkgCacheDir,
      DSH_VERIFY_PLAYWRIGHT: opts.playwrightDir,
    },
    timeoutMs: opts.timeoutMs,
    evidenceSync: !(opts.noEvidenceSync && NO_SYNC_CAPABLE.indexOf(spec.tool) >= 0),
  }
  await writeFile(join(runtime.suiteDir, 'raw', spec.key + '.command.json'), JSON.stringify(commandRecord, null, 2) + '\n')
  console.log(
    '[run-all] ▶ #' + String(spec.order) + ' ' + spec.key + '（' + spec.hostChannel + '，' + spec.tool +
      (spec.mode === null ? '' : ' --mode ' + spec.mode) +
      (spec.fault === null ? '' : ' --fault ' + spec.fault) +
      '，stamp ' + spec.stamp + '）',
  )

  const proc = await runToolProcess(opts, spec, args)
  const finishedAt = new Date().toISOString()
  const durationMs = Date.now() - startedMs
  const logText =
    '[command] ' + command + '\n' +
    '[cwd] ' + opts.worktree + '\n' +
    '[isolation] pnpm/npm cache: ' + pkgCacheDir + '\n' +
    '[exit] ' + String(proc.exitCode) + (proc.signal === null ? '' : ' signal=' + proc.signal) + (proc.timedOut ? ' TIMEOUT' : '') + '\n' +
    '[stdout]\n' + proc.stdout + '\n[stderr]\n' + proc.stderr + '\n'
  await writeFile(join(runtime.suiteDir, 'raw', spec.key + '.log'), logText)

  const parsed = parseLastJsonObject(proc.stdout)
  const expectedRunDir = join(opts.runBaseDir, runId)
  const runDir = parsed !== null && typeof parsed.runDir === 'string' ? parsed.runDir : expectedRunDir
  const runJson = await readRunJson(runDir)
  const processExitCode = parsed !== null && typeof parsed.exitCode === 'number' ? parsed.exitCode : proc.exitCode

  const classification = classifyOutcome(spec, runJson, proc, processExitCode)
  const counts = assertionCountsOf(runJson)
  const redIds: string[] = []
  const knownRedIds: string[] = []
  if (runJson !== null && Array.isArray(runJson.assertions)) {
    for (const assertion of runJson.assertions) {
      const id = typeof assertion.id === 'string' ? assertion.id : '(无 id)'
      if (assertion.verdict === 'fail') redIds.push(id)
      else if (assertion.verdict === 'known-red') knownRedIds.push(id)
    }
  }
  const evidenceSynced = !(opts.noEvidenceSync && NO_SYNC_CAPABLE.indexOf(spec.tool) >= 0)
  const evidenceRelPath = evidenceSynced ? 'selftest/evidence/runs/' + runId : null
  if (evidenceRelPath !== null && !existsSync(join(opts.worktree, evidenceRelPath, 'run.json'))) {
    // 个别工具（T1/T2 时代的桌面通道工具）自己不做证据复制；编排器按统一契约补一份，
    // 只复制 run.json/index.md/shots/raw 四件，不把 user-data-dir、pack、npm-cache 等过程产物带进仓库。
    const copied = await copyEvidencePackage(runDir, join(opts.worktree, evidenceRelPath))
    if (copied) preNotes.push('证据包由编排器补齐（该工具自身未同步）')
  }
  const notes = preNotes.concat(classification.notes)
  if (evidenceRelPath !== null && !existsSync(join(opts.worktree, evidenceRelPath, 'run.json'))) {
    notes.push('证据复制缺失：' + evidenceRelPath)
  }

  const runVerdict: Verdict | null = runJson !== null && runJson.verdict !== undefined ? runJson.verdict : null
  const exitCode = runJson !== null && typeof runJson.exitCode === 'number' ? runJson.exitCode : null
  const record: ScenarioRecord = {
    key: spec.key,
    kind: spec.kind,
    scenarioId: spec.scenarioId,
    ticket: spec.ticket,
    hostChannel: spec.hostChannel,
    summary: spec.summary,
    tool: spec.tool,
    mode: spec.mode,
    fault: spec.fault,
    order: spec.order,
    stamp: spec.stamp,
    runId,
    runDir,
    evidencePath: evidenceRelPath,
    evidenceSynced,
    isHistorical: false,
    historicalRunId: spec.historicalRunId,
    canRedHistoryRunId: spec.canRedHistoryRunId,
    startedAt,
    finishedAt,
    durationMs,
    processExitCode,
    timedOut: proc.timedOut,
    spawnError: proc.spawnError,
    runVerdict,
    exitCode,
    assertions: counts,
    redIds,
    knownRedIds,
    expectedVerdict: spec.allowedVerdicts,
    expectedRedIds: spec.expectedRedIds,
    expectedRedSteps: spec.expectedRedSteps,
    outcome: classification.outcome,
    notes,
  }

  const existingIndex = state.scenarios.findIndex((item) => item.key === spec.key)
  if (existingIndex >= 0) state.scenarios[existingIndex] = record
  else state.scenarios.push(record)
  state.scenarios.sort((left, right) => left.order - right.order)

  const ledgerEntry = state.knownRedLedger.find((entry) => entry.scenarioId === spec.scenarioId)
  if (ledgerEntry !== undefined) {
    ledgerEntry.thisRound = 'run ' + runId + '：' + String(runVerdict) + '（' + classification.outcome + '）'
  }

  await runtime.persist()
  const good =
    classification.outcome === 'pass' ||
    classification.outcome === 'known-red' ||
    classification.outcome === 'can-red-expected-fail'
  console.log(
    '[run-all] ' + (good ? '✓' : '✗') + ' ' + spec.key + ' → ' + String(runVerdict) + ' / ' + classification.outcome +
      '（' + formatDuration(durationMs) + '，run ' + runId + '）',
  )
}

// ---------------------------------------------------------------------------
// 调度：桌面串行 / web 并发
// ---------------------------------------------------------------------------

async function runQueue(specs: readonly PlannedSpec[], concurrency: number, runtime: SuiteRuntime): Promise<void> {
  let next = 0
  const workers: Array<Promise<void>> = []
  const workerCount = Math.max(1, Math.min(concurrency, specs.length))
  for (let index = 0; index < workerCount; index += 1) {
    workers.push(
      (async () => {
        while (true) {
          const cursor = next
          next += 1
          if (cursor >= specs.length) return
          await executeSpec(specs[cursor], runtime)
        }
      })(),
    )
  }
  await Promise.all(workers)
}

// ---------------------------------------------------------------------------
// index.md 渲染
// ---------------------------------------------------------------------------

const BT = String.fromCharCode(96)

function outcomeLabel(outcome: ScenarioRecord['outcome']): string {
  switch (outcome) {
    case 'pass':
      return '通过'
    case 'known-red':
      return 'known-red'
    case 'fail':
      return '失败'
    case 'unknown':
      return 'unknown'
    case 'blocked':
      return 'blocked（unknown）'
    case 'can-red-expected-fail':
      return '注入后按预期失败'
    case 'can-red-unexpected-pass':
      return '注入后未红（失败）'
    case 'can-red-mismatch':
      return '红断言不符（失败）'
    default:
      return '运行中'
  }
}

function shotsOf(record: ScenarioRecord): number {
  const runJsonPath = join(record.runDir, 'run.json')
  if (!existsSync(runJsonPath)) return 0
  try {
    const parsed = JSON.parse(readFileSync(runJsonPath, 'utf8')) as RunJsonShape
    return Array.isArray(parsed.shots) ? parsed.shots.length : 0
  } catch {
    return 0
  }
}

function isRebuilt(record: ScenarioRecord): boolean {
  return record.notes.some((note) => note.indexOf('聚合记录由证据重建') >= 0)
}

function runLink(record: ScenarioRecord): string {
  const rebuilt = isRebuilt(record) ? '（证据重建）' : ''
  if (record.evidencePath !== null) return '[' + BT + record.runId + BT + '](../' + record.runId + '/)' + rebuilt
  return BT + record.runId + BT + '（仓库外：' + record.runDir.replace(/\\/g, '/') + '）' + rebuilt
}

function colsPush(lines: string[], cells: readonly string[]): void {
  lines.push('| ' + cells.join(' | ') + ' |')
}

function renderIndex(state: SuiteState, fullPlan: readonly PlannedSpec[]): string {
  const counts = countOutcomes(state.scenarios)
  const lines: string[] = []
  lines.push('# spec #263 全量真机矩阵回归（T11 / #275）')
  lines.push('')
  lines.push('> 本文件由 ' + BT + 'selftest/real-machine/tools/run-all.ts' + BT + ' 自动生成（每个 run 完成后重写，可随中断续跑）。')
  lines.push('')
  lines.push('## 结论')
  lines.push('')
  lines.push('| 项 | 值 |')
  lines.push('| --- | --- |')
  lines.push('| suite runId | ' + BT + state.runId + BT + ' |')
  lines.push('| 状态 | ' + (state.status === 'finished' ? '已收尾' : '运行中') + ' |')
  lines.push('| 聚合 verdict | ' + BT + state.verdict + BT + ' |')
  lines.push('| 退出码 | ' + String(state.exitCode) + '（0=全 pass/仅 known-red；1=fail/unknown；2=blocked） |')
  lines.push(
    '| 轮次 | ' + String(state.scenarios.length) + ' / ' + String(fullPlan.length) + ' 个计划 run（主链 ' +
      String(fullPlan.filter((item) => item.kind === 'pass').length) + ' + can-red ' +
      String(fullPlan.filter((item) => item.kind === 'can-red').length) + '） |',
  )
  lines.push(
    '| 通过 / known-red / 失败 / unknown / 注入按预期失败 | ' + String(counts.pass) + ' / ' + String(counts.knownRed) +
      ' / ' + String(counts.fail) + ' / ' + String(counts.unknown) + ' / ' + String(counts.canRedExpected) + ' |',
  )
  lines.push(
    '| worktree | ' + BT + state.environment.worktree + BT + '（' + state.environment.branch + ' @ ' +
      state.environment.head.slice(0, 12) + '，dirty ' + String(state.environment.dirtyFiles) + '） |',
  )
  lines.push('| 并发 | 桌面官方通道 1（单实例）、dsh-web 通道 ' + String(state.environment.concurrency.web) + ' |')
  const rebuiltCount = state.scenarios.filter((record) => isRebuilt(record)).length
  lines.push(
    '| 记录来源 | 本轮真机重跑 ' + String(state.scenarios.length - rebuiltCount) + ' / 证据重建 ' + String(rebuiltCount) +
      '（重建记录由 ' + BT + '--rebuild-state' + BT + ' 从已定稿证据补回，数据源见各记录备注） |',
  )
  lines.push('| startedAt / finishedAt | ' + state.startedAt + ' / ' + String(state.finishedAt) + ' |')
  lines.push('')
  lines.push('## 场景总表（本轮重跑）')
  lines.push('')
  lines.push('| # | 场景 | 票 | 通道 | 证据 run | verdict | 结果 | 断言 通过/失败/known-red/unknown | 截图 | 耗时 | 定稿历史 run |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const record of state.scenarios) {
    const history = record.historicalRunId === null ? '—' : BT + record.historicalRunId + BT
    const label = record.kind === 'can-red' ? record.scenarioId + '（can-red）' : record.scenarioId
    colsPush(lines, [
      String(record.order),
      label,
      record.ticket,
      record.hostChannel,
      runLink(record),
      String(record.runVerdict),
      outcomeLabel(record.outcome),
      String(record.assertions.pass) + '/' + String(record.assertions.fail) + '/' +
        String(record.assertions.knownRed) + '/' + String(record.assertions.unknown),
      String(shotsOf(record)),
      formatDuration(record.durationMs),
      history,
    ])
  }
  lines.push('')
  lines.push(
    '（证据重建）= 该行聚合记录由 ' + BT + '--rebuild-state' + BT + ' 从已定稿单场景证据（' + BT + 'runs/<runId>/run.json' + BT +
      ' 与编排 ' + BT + 'raw/<key>.log' + BT + ' 的退出码）补回，不是本轮真机重跑；记录本身的数据仍来自真实 run。',
  )
  lines.push('')
  lines.push('## can-red 期望失败表')
  lines.push('')
  lines.push('| # | 场景 | 注入 | 期望红断言（历史 fail run） | 实测红断言 | 结果 | 证据 run |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const record of state.scenarios) {
    if (record.kind !== 'can-red') continue
    const injection =
      (record.fault !== null ? '--fault ' + record.fault : '') +
      (record.mode !== null ? (record.fault !== null ? ' ' : '') + '--mode ' + record.mode : '')
    const drifted = record.notes.some((note) => note.indexOf('can-red 断言编号漂移') >= 0)
    const expectedBase = record.expectedRedIds === null ? '（历史不可用，按非空红断言校验）' : record.expectedRedIds.join('、')
    const expected = drifted ? expectedBase + '（本轮编号漂移，按步骤语义匹配）' : expectedBase
    colsPush(lines, [
      String(record.order),
      record.scenarioId,
      injection === '' ? '（工具内置注入）' : BT + injection + BT,
      expected,
      record.redIds.length === 0 ? '（无）' : record.redIds.join('、'),
      outcomeLabel(record.outcome),
      runLink(record),
    ])
  }
  lines.push('')
  lines.push('## known-red 终账（只允许 selftest/evidence/known-red.md 已登记条件）')
  lines.push('')
  lines.push('| 编号 | 场景 | 首次发现 run | 本轮观察 | 状态 |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const entry of state.knownRedLedger) {
    colsPush(lines, [entry.id, entry.scenarioId, BT + entry.firstRunId + BT, entry.thisRound, entry.status])
  }
  lines.push('')
  lines.push('## 隔离事实')
  lines.push('')
  lines.push(
    '- pnpm/npm 缓存：每个 run 私有 ' + BT + state.isolationFacts.pnpmCacheRoot + '/<ticket>-<stamp>' + BT +
      '（' + BT + 'pnpm_config_cache_dir' + BT + '、' + BT + 'npm_config_cache' + BT + '、' + BT + 'npm_config_store_dir' + BT +
      ' 三键同指）。' + state.isolationFacts.pnpmCacheNote,
  )
  const prebuild = state.isolationFacts.suitePrebuild
  if (prebuild !== undefined) {
    lines.push(
      '- SUT dist：' + BT + prebuild.digest + BT + '（' + String(prebuild.files) + ' 文件，suite 起跑前统一构建）。' +
        '子进程带 ' + BT + 'npm_config_ignore_scripts=true' + BT + '，SUT pin 的 ' + BT + 'npm pack' + BT +
        ' 跳过 prepack 重建——并发 run 各自 prepack 会同时重写同一个 ' + BT + 'dist/' + BT + '，指纹会在读写竞争下漂移。',
    )
  }
  lines.push('- 本地 registry：' + state.isolationFacts.perScenarioRegistry + '。')
  lines.push(
    '- 维护者 profile：' + BT + state.environment.maintainerHome + BT +
      '（只读指纹核对，各工具清理步骤记录在各自 run.json 的 maintainerProfile 段）。',
  )
  lines.push(
    '- Playwright（k/j 组 UI 场景）：' + BT + state.isolationFacts.playwrightDir + BT + '。' + state.isolationFacts.playwrightNote,
  )
  lines.push('- 官方桌面：官方桌面发行包隔离实例（' + BT + '--user-data-dir' + BT + ' + ' + BT + 'DSH_HOME' + BT + ' 落在每个 run 目录），桌面通道串行。')
  lines.push('')
  lines.push('## Web 通道证据说明（UI 截图 vs 电话/原始文件）')
  lines.push('')
  const webNoShots = state.scenarios.filter((record) => record.hostChannel === 'dsh-web' && shotsOf(record) === 0)
  if (webNoShots.length === 0) {
    lines.push('- 本轮 web 通道 run 均有截图（shots>0）。')
  } else {
    lines.push(
      '- 以下 web 通道 run 没有 UI 截图（' + BT + 'shots=0' + BT + '，E/F/G/H/I/J 组按设计走电话/原始文件）：' +
        webNoShots.map((record) => BT + record.runId + BT).join('、') + '。',
    )
    lines.push(
      '- 其证据力来自 ' + BT + 'run.json' + BT + ' 的断言与各自运行目录 ' + BT + 'raw/*.json' + BT +
        '（电话回执、台账/队列/日志原始文件、宿主进程状态），不是 UI 截图。',
    )
  }
  lines.push('')
  lines.push('## 复跑命令')
  lines.push('')
  lines.push(BT + BT + BT + 'powershell')
  lines.push(
    'node selftest/real-machine/tools/run-all.ts --worktree ' + state.environment.worktree + ' --run-base-dir ' +
      state.environment.runBaseDir + ' --stamp ' + state.runId.replace(/-full$/, '') + ' --maintainer-home ' +
      state.environment.maintainerHome,
  )
  lines.push(BT + BT + BT)
  lines.push('')
  lines.push(
    '- 同一 ' + BT + '--stamp' + BT + ' 重跑 = 续跑（复用已完成记录，补跑未完成/blocked/unknown）；' + BT + '--rerun' + BT +
      ' 表示不跳过已完成、按计划重跑（不重置聚合记录，' + BT + '--only' + BT + ' 部分重跑安全）。',
  )
  lines.push('- 单场景重跑：' + BT + '--only <场景 id>' + BT + '；can-red 单组：' + BT + '--only can-red:<场景 id>' + BT + '。')
    lines.push('- 聚合记录抢救：' + BT + '--rebuild-state' + BT + '（只从已定稿证据补回缺失聚合记录，不跑真机；记录注明数据源）。')
  lines.push('')
  lines.push('## 备注')
  lines.push('')
  for (const note of state.notes) lines.push('- ' + note)
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// suite 打开 / 收尾 / 入口
// ---------------------------------------------------------------------------

async function openSuite(opts: Options, plan: PlanResult): Promise<SuiteRuntime> {
  const suiteStamp = opts.stamp
  const suiteDir =
    opts.suiteOut !== null
      ? join(opts.suiteOut, suiteStamp + '-full')
      : join(opts.worktree, 'selftest', 'evidence', 'runs', suiteStamp + '-full')
  const runtimeSuiteDir = join(opts.runBaseDir, suiteStamp + '-full')
  const existingRunJson = join(suiteDir, 'run.json')
  let state: SuiteState
  if (existsSync(existingRunJson)) {
    // 续跑与 --rerun 都沿用已有聚合记录：--rerun 只表示「不跳过已完成、按计划重跑」，
    // 绝不重置 state.scenarios —— 否则部分重跑（--only）会把其它 40 多条聚合记录一并清掉。
    const parsed = await readJsonFile(existingRunJson)
    if (parsed === null) throw new Error('suite run.json 存在但无法解析：' + existingRunJson)
    state = parsed as unknown as SuiteState
    state.status = 'running'
    state.finishedAt = null
    mergeState(state, plan, opts)
    console.log(
      '[run-all] ' + (opts.rerun ? '沿用已有 suite 记录重跑' : '续跑已有 suite') + '：' + suiteDir +
        '（已有 ' + String(state.scenarios.length) + ' 个记录）',
    )
  } else {
    state = createSuiteState(opts, plan)
  }
  await mkdir(join(suiteDir, 'raw'), { recursive: true })
  await mkdir(runtimeSuiteDir, { recursive: true })
  await mkdir(join(opts.runBaseDir, '_pkgcache'), { recursive: true })

  const runtime: SuiteRuntime = {
    opts,
    state,
    suiteDir,
    runtimeSuiteDir,
    fullPlan: plan.fullPlan,
    runPlan: plan.runPlan,
    persist: () => Promise.resolve(),
  }
  runtime.persist = buildPersist(runtime)
  await writeFile(
    join(suiteDir, 'raw', 'plan.json'),
    JSON.stringify({ suiteStamp, specs: plan.fullPlan, runPlan: plan.runPlan.map((item) => item.key), notes: plan.notes }, null, 2) + '\n',
  )
  return runtime
}

async function finalize(runtime: SuiteRuntime): Promise<void> {
  const state = runtime.state
  const killed = killOwnProcesses(runtime.opts.runBaseDir)
  for (const pid of killed) {
    if (state.cleanup.processes.indexOf(pid) < 0) state.cleanup.processes.push(pid)
  }
  const cleanupNote =
    killed.length === 0
      ? '收尾扫描：无本 suite 残留官方桌面/verdaccio 进程（各工具自清理）'
      : '收尾扫描：清理残留进程 ' + killed.join(',')
  // finalize 可能在 --rebuild-state 恢复时重复调用，清场说明去重（同一事实只写一次）。
  for (const note of [cleanupNote, '端口：每个场景的工具自起自清 verdaccio/宿主端口，无跨场景复用']) {
    if (state.cleanup.notes.indexOf(note) < 0) state.cleanup.notes.push(note)
  }
  if (state.scenarios.length < runtime.fullPlan.length) {
    state.notes.push(
      '本轮是部分 suite（' + String(state.scenarios.length) + '/' + String(runtime.fullPlan.length) + '），未跑场景不计入聚合 verdict',
    )
  }
  state.status = 'finished'
  state.finishedAt = new Date().toISOString()
  await runtime.persist()
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const plan = await buildPlan(opts)
  if (opts.dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          suiteStamp: opts.stamp,
          fullPlan: plan.fullPlan.map((item) => ({
            order: item.order,
            key: item.key,
            tool: item.tool,
            mode: item.mode,
            fault: item.fault,
            hostChannel: item.hostChannel,
            stamp: item.stamp,
            allowedVerdicts: item.allowedVerdicts,
            expectedRedIds: item.expectedRedIds,
            expectedRedSteps: item.expectedRedSteps,
          })),
          runPlan: plan.runPlan.map((item) => item.key),
          notes: plan.notes,
        },
        null,
        2,
      ),
    )
    process.exit(0)
  }
  const runtime = await openSuite(opts, plan)
  console.log(
    '[run-all] suite=' + runtime.suiteDir + '，计划 ' + String(plan.fullPlan.length) + ' 个 run，本次跑 ' + String(plan.runPlan.length) + ' 个',
  )
  await runtime.persist()
  if (opts.rebuildState) {
    // 事故恢复模式：只从定稿证据补回聚合记录，不跑任何真机 run（不重启 SUT、不占桌面实例）。
    await rebuildRecords(runtime, plan)
  } else {
    await runSuitePrebuild(opts, runtime)
    await runtime.persist()

    const desktopSpecs = plan.runPlan.filter((spec) => spec.hostChannel === 'desktop-official')
    const webSpecs = plan.runPlan.filter((spec) => spec.hostChannel === 'dsh-web')
    console.log(
      '[run-all] 队列：桌面 ' + String(desktopSpecs.length) + '（串行）、web ' + String(webSpecs.length) +
        '（并发 ' + String(opts.webConcurrency) + '）',
    )
    await Promise.all([runQueue(desktopSpecs, 1, runtime), runQueue(webSpecs, opts.webConcurrency, runtime)])
  }

  await finalize(runtime)
  const counts = countOutcomes(runtime.state.scenarios)
  const result = {
    suiteDir: runtime.suiteDir,
    suiteRunId: runtime.state.runId,
    verdict: runtime.state.verdict,
    exitCode: runtime.state.exitCode,
    counts,
    scenarios: runtime.state.scenarios.map((record) => ({
      key: record.key,
      runId: record.runId,
      runVerdict: record.runVerdict,
      outcome: record.outcome,
      durationMs: record.durationMs,
    })),
    notes: runtime.state.notes,
  }
  console.log(JSON.stringify(result, null, 2))
  process.exit(runtime.state.exitCode === null ? 1 : runtime.state.exitCode)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error('[run-all] 工具错误（blocked）：' + message)
  if (error instanceof Error && error.stack) console.error(error.stack)
  process.exit(2)
})
