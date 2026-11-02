/**
 * selftest/real-machine/scenarios/h-hub-continuity.ts —— 票 #271（spec #263 T7 / G 组：更新中枢不断链）真机场景。
 *
 * 测什么：通道 B（普通 DSH web 宿主，host/cli-host.ts）上，A 作为批量发起者/中枢属主，
 * 三包批量更新（A 自键排第一，先换 A）推进到「A 已 done、B/C 尚未终态」时，把第一代宿主进程杀掉，
 * 再用同一个 USERPROFILE/osHomeDir + 同一个 homeDir + 同一个 profile 名起第二代宿主：
 *   - 第二代从盘上的 <home>/update-queue/<hash>/hub/plans/fxa.json + fxa/batch.json 恢复，
 *     B/C 无需人工续跑自动完成 0.0.2；
 *   - 中枢租约/台账/磁盘/面板状态一致，无断链遗留、无假绿；
 *   - g2 再关掉宿主重新打开（= 关页面再重开），面板批量/中枢/A 自身状态与台账/磁盘一致，刷新不是断线。
 *
 * 三个 mode（工具 tools/run-g-hub.ts 传 --mode）：
 *   - handoff：换手主格（g1-hub-handoff）；
 *   - page-recovery：换手后再关宿主/重开，查面板恢复（g2-hub-page-recovery）；
 *   - can-red：换手窗口里由 harness 删除 hub plan（中枢无方案可接管），预期 B/C 不再自动续跑 ——
 *     本 run 记为 fail/exit1，红点=「删 plan 后 B/C 未自动续跑」，证明该断言可红。
 *
 * 换手注入的等价性：web 宿主没有「应用自重启」，所以这里用「杀第一代 + 起第二代（同 home/profile）」
 * 注入换手，等价于官方桌面 relaunch 后新 fiber 接管；差别（web 是整进程退出，桌面是 app 内重启）写进
 * docs/research/20261103-issue-271-hub-continuity.md。断言只看「A 换了之后 B/C 是否无需人工继续完成」。
 *
 * 证据口径（selftest/evidence/README.md）：换手窗口/租约/plan/batch.json 用轮询快照 + 原文 raw；
 * B/C 是否「自动续跑」用 update.install.exec 的 ts 与第二代 host.start 的 ts 比较；台账读
 * <home>/updates/<pluginId>/<hash>/state.json；磁盘读 profile package.json 与 node_modules 版本。
 * 页面恢复用面板电话（batchStatus/updateHubStatus/updateCheck）+ 宿主页面 HTTP 取证；web 通道没有窗口，
 * 不冒充桌面真 UI 截图。
 */
import { createHash } from 'node:crypto'
import { readFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  FIXTURE_INSTALL_TIMEOUT_ENV,
  FIXTURE_REGISTRY_ENV,
  fixtureBridgeRouteOf,
  fixtureSlotOf,
} from '../../fixtures/identity/fixture-slots.ts'
import { fetchPublishedVersions } from '../../fixtures/release/registry-client.ts'
import { ensureDir, listFilesRecursive } from '../../tooling/fs-utils.ts'
import { isPortFree } from '../../tooling/ports.ts'
import { isProcessAlive, sleep } from '../../tooling/process.ts'
import type { CliHostSession } from '../host/cli-host.ts'
import { startCliHost } from '../host/cli-host.ts'
import { readProfileManifest } from '../host/dsh-cli.ts'
import { createWebProfileInHome } from '../host/isolated-profile.ts'
import type { RunManifest } from '../runtime/evidence.ts'
import { captureLogFiles } from '../runtime/log-evidence.ts'
import { baselineVersionOf, publishScenarioVariants, variantVersionOf } from '../runtime/scenario-runner.ts'
import { copyRunEvidence } from './batch-helpers.ts'
import type { T3Run } from './t3-common.ts'
import { installedFixtureVersion, openT3Run, verifySutInstalled } from './t3-common.ts'

/** 场景 mode：换手主格 / 页面重开恢复 / can-red（预期红）。 */
export type HubContinuityMode = 'handoff' | 'page-recovery' | 'can-red'

/** 一次真机 run 的入参（工具层解析后原样传）。 */
export interface HubContinuityOptions {
  readonly worktree: string
  readonly runBaseDir: string
  readonly verdaccioInstallDir: string
  readonly esbuildPath: string
  readonly stamp?: string
  readonly maintainerHome?: string
  readonly mode: HubContinuityMode
  /** false = 只把证据留在仓库外（试错 run），true/缺省 = 复制进 selftest/evidence/runs。 */
  readonly syncEvidence?: boolean
}

/** 场景 id 与 mode 的映射（can-red 复用 g1：同一场景、同一组断言被破坏）。 */
export function scenarioIdOf(mode: HubContinuityMode): string {
  if (mode === 'page-recovery') return 'g7-hub-handoff-evidence'
  return 'g6-hub-survives-self-replacement'
}

/** 隔离 profile 名（非 desktop：官方桌面独占该名，普通宿主建不了，见 T6 P1 探针）。 */
const PROFILE_NAME = 't7hub'
/** 夹具 A 的批量电话前缀（fixture-slots.ts: FIXTURE_SLOT_A.batch.prefix）。 */
const BATCH_PREFIX = 'fxa'
/** 宿主安装预算/锁陈旧阈值压到 4s：第一代被杀的 global.lock 与 install.lock 要在几秒后判陈旧。 */
const INSTALL_TIMEOUT_MS = 4000
/** 换手窗口轮询间隔（等 A done 且 B/C 未终态）。 */
const KILL_POLL_MS = 120
/** 第二代宿主把 B/C 推完的预算（含 #217 stale queue intent 的 ≤30s 恢复延迟）。 */
const BATCH_WAIT_MS = 120_000
/** can-red 注入后等「本应出现的续跑」的预算。 */
const CAN_RED_WAIT_MS = 45_000
/** 批量行终态。 */
const TERMINAL_PHASES = ['done', 'failed', 'skipped', 'current']

interface HostEntry {
  readonly label: string
  readonly host: CliHostSession
  readonly pid: number | null
  readonly port: number
  closed: boolean
}

interface RawLogRow {
  readonly ts: number | null
  readonly event: string
  readonly level: string | null
  readonly fields: Record<string, unknown>
  readonly source: string
  readonly line: number
}

interface PhoneResult {
  readonly phone: string
  readonly status: number
  readonly durationMs: number
  readonly body: unknown
  // 内层 reply 字段随产品/夹具演化，这里按原始对象保留，调用点自己窄化。
  readonly inner: any
  readonly ok: boolean
  readonly error: string | null
  readonly rows: any[]
  readonly session: any
  readonly snapshot: any
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** sha256(text) 前 24 位十六进制：产品 shortHash（src/core/store-base.ts），锁/台账目录都用它。 */
function shortHashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 24)
}

async function readTextMaybe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function readJsonMaybe(path: string): Promise<any> {
  const text = await readTextMaybe(path)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function listDirs(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

/** 读 <home>/logs 下所有日志原文行（保留 ts：判定换手/续跑时间窗要用）。 */
async function readRawLogRows(homeDir: string): Promise<RawLogRow[]> {
  const root = join(homeDir, 'logs')
  const rows: RawLogRow[] = []
  let files: string[] = []
  try {
    files = await listFilesRecursive(root)
  } catch {
    return rows
  }
  for (const relative of files) {
    if (!relative.endsWith('.log')) continue
    const abs = join(root, relative.split('/').join('\\'))
    const text = (await readTextMaybe(abs)) ?? ''
    let line = 0
    for (const rawLine of text.split(/\r?\n/)) {
      line += 1
      if (!rawLine.trim()) continue
      try {
        const parsed = JSON.parse(rawLine)
        if (typeof parsed?.event !== 'string') continue
        rows.push({
          ts: typeof parsed?.ts === 'number' ? parsed.ts : null,
          event: parsed.event,
          level: typeof parsed?.level === 'string' ? parsed.level : null,
          fields: parsed?.fields && typeof parsed.fields === 'object' ? parsed.fields : {},
          source: relative,
          line,
        })
      } catch {
        /* 非 JSON 行忽略 */
      }
    }
  }
  rows.sort((left, right) => (left.ts ?? 0) - (right.ts ?? 0))
  return rows
}

/** 读 <home>/updates 下各级 state.json（产品台账）。 */
async function readLedgerStates(homeDir: string): Promise<{ file: string; state: any }[]> {
  const root = join(homeDir, 'updates')
  let files: string[] = []
  try {
    files = await listFilesRecursive(root)
  } catch {
    return []
  }
  const out: { file: string; state: any }[] = []
  for (const relative of files) {
    const segments = relative.split('/')
    if (segments[segments.length - 1] !== 'state.json') continue
    const abs = join(root, relative.split('/').join('\\'))
    out.push({ file: abs, state: await readJsonMaybe(abs) })
  }
  return out
}

/** 电话双层信封：外层 ok=电话送达，业务受理/拒绝看 reply.ok；error 优先取内层。 */
async function callPhone(host: CliHostSession, phone: string, args: Record<string, unknown> = {}): Promise<PhoneResult> {
  const started = Date.now()
  const result = await host.postPhone(routeOf, phone, args)
  const body: any = result.body ?? null
  const inner: any = body && typeof body === 'object' && body.reply && typeof body.reply === 'object' ? body.reply : null
  const ok = (inner?.ok ?? body?.ok) === true
  const errorValue = inner?.error ?? body?.error
  return {
    phone,
    status: result.status,
    durationMs: Date.now() - started,
    body,
    inner,
    ok,
    error: typeof errorValue === 'string' ? errorValue : null,
    rows: inner && Array.isArray(inner.rows) ? inner.rows : [],
    session: inner && inner.session && typeof inner.session === 'object' ? inner.session : null,
    snapshot: inner && inner.snapshot && typeof inner.snapshot === 'object' ? inner.snapshot : null,
  }
}

function phaseOfBatch(batch: any, key: string): string | null {
  if (!batch || !Array.isArray(batch.entries)) return null
  const entry = batch.entries.find((candidate: any) => candidate && candidate.key === key)
  return entry && typeof entry.phase === 'string' ? entry.phase : null
}

function allTerminal(batch: any): boolean {
  if (!batch || !Array.isArray(batch.entries) || batch.entries.length === 0) return false
  return batch.entries.every((entry: any) => TERMINAL_PHASES.includes(entry?.phase))
}

function phasesOfBatch(batch: any): Record<string, string | null> {
  return { a: phaseOfBatch(batch, 'a'), b: phaseOfBatch(batch, 'b'), c: phaseOfBatch(batch, 'c') }
}

/** 1s 粒度起止时间戳里的时间窗描述。 */
function tsOf(row: RawLogRow | undefined): number | null {
  return row && typeof row.ts === 'number' ? row.ts : null
}

/** 按插件筛 exec 行（route/ok/exitCode/durationMs 全带出）。 */
function execRowsOf(rows: RawLogRow[], pluginId: string): any[] {
  return rows
    .filter((row) => row.event === 'update.install.exec' && row.fields?.pluginId === pluginId)
    .map((row) => ({
      ts: row.ts,
      pluginId: row.fields?.pluginId ?? null,
      route: row.fields?.route ?? null,
      ok: row.fields?.ok ?? null,
      exitCode: row.fields?.exitCode ?? null,
      durationMs: row.fields?.durationMs ?? null,
    }))
}

function hostStartRows(rows: RawLogRow[]): any[] {
  return rows
    .filter((row) => row.event === 'host.start')
    .map((row) => ({ ts: row.ts, pid: row.fields?.pid ?? null, hostKind: row.fields?.hostKind ?? null }))
}

/** batch.json 落到 done 与 exec 日志行落盘有毫秒级先后：等目标插件的 exec 行出现（最多 budgetMs）。 */
async function waitForExecRows(homeDir: string, pluginIds: string[], budgetMs: number): Promise<RawLogRow[]> {
  const startedAt = Date.now()
  let rows = await readRawLogRows(homeDir)
  while (Date.now() - startedAt < budgetMs) {
    const missing = pluginIds.filter((pluginId) => execRowsOf(rows, pluginId).length === 0)
    if (missing.length === 0) return rows
    await sleep(300)
    rows = await readRawLogRows(homeDir)
  }
  return rows
}

function eventCountsOf(rows: RawLogRow[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const row of rows) counts[row.event] = (counts[row.event] ?? 0) + 1
  return counts
}

/** 完工：close 之后按需把证据复制进仓库（试错 run 用 syncEvidence:false 只留在仓库外）。 */
async function finish(run: T3Run, options: HubContinuityOptions): Promise<RunManifest> {
  const manifest = await run.close()
  if (options.syncEvidence === false) return manifest
  try {
    await copyRunEvidence(run.layout, options.worktree)
  } catch (error) {
    console.error('[h-hub-continuity] 复制证据失败（run 仍在仓库外）：' + messageOf(error))
  }
  return manifest
}

let routeOf = ''

/** 台账 state.json 本身不含 pluginId；从路径 .../updates/<pluginId>/<hash>/state.json 取。 */
function ledgerPluginIdOf(file: string): string | null {
  const parts = file.replace(/\\/g, '/').split('/')
  const index = parts.lastIndexOf('updates')
  return index >= 0 && index + 1 < parts.length ? parts[index + 1] : null
}

export async function runHubContinuity(options: HubContinuityOptions): Promise<RunManifest> {
  const scenarioId = scenarioIdOf(options.mode)
  const run = await openT3Run({
    worktree: options.worktree,
    runBaseDir: options.runBaseDir,
    verdaccioInstallDir: options.verdaccioInstallDir,
    esbuildPath: options.esbuildPath,
    scenarioId,
    hostChannel: 'dsh-web',
    stamp: options.stamp,
    maintainerHome: options.maintainerHome,
    ticket: '271',
  })
  const startedHosts: HostEntry[] = []
  try {
    const fixtureEnv = run.fixtureEnv
    if (!fixtureEnv) throw new Error('[h-hub-continuity] 本场景需要夹具环境（withFixtures=true）')
    const slotA = fixtureSlotOf('a')
    const slotB = fixtureSlotOf('b')
    const slotC = fixtureSlotOf('c')
    const slots = [slotA, slotB, slotC]
    // 批量 owner 是 A：三包在台账/日志里的 pluginId 是 A 的 targets 前缀（fxa-a/fxa-b/fxa-c），不是 packageName。
    const batchTargetPrefixes = new Map<string, string>(
      (slotA.batch?.targets ?? []).map((target) => [target.key, target.prefix] as [string, string]),
    )
    const variant = run.scenario.variants.find((candidate) => candidate.slotKey === 'a')
    if (!variant) throw new Error('[h-hub-continuity] 场景声明缺 a 的变体（0.0.2）')
    const baselineVersion = baselineVersionOf(run.scenario, 'a')
    const variantVersionRaw = variantVersionOf(run.scenario, 'a')
    if (!variantVersionRaw) throw new Error('[h-hub-continuity] 场景声明缺 a 的变体版本')
    const variantVersion = variantVersionRaw
    routeOf = fixtureBridgeRouteOf(slotA)
    const selfPrefix = slotA.selfTargetPrefix
    if (!selfPrefix) throw new Error('[h-hub-continuity] 夹具 A 缺 selfTargetPrefix')
    const phones = {
      check: selfPrefix + '.updateCheck',
      status: selfPrefix + '.updateStatus',
      batchStatus: BATCH_PREFIX + '.batchStatus',
      batchCheck: BATCH_PREFIX + '.batchCheck',
      batchInstall: BATCH_PREFIX + '.batchInstall',
      hubStatus: selfPrefix + '.updateHubStatus',
    }

    // ---------- 隔离口径与 profile ----------
    const osHomeDir = join(run.layout.root, 'os-home')
    const homeDir = join(osHomeDir, '.dsh')
    await ensureDir(osHomeDir)
    await ensureDir(homeDir)
    await run.raw('isolation-facts', {
      osHomeDir,
      homeDir,
      profileName: PROFILE_NAME,
      hostChannel: 'dsh-web',
      mode: options.mode,
      scenarioId,
      why:
        '通道 B 宿主用 USERPROFILE=osHomeDir、DSH_HOME=homeDir 解析 profile；第一代/第二代（以及 g2 重开）' +
        '用同一组目录与同一 profile 名，因此解析到同一 profileDir 与同一 update-queue/hub/updates 台账。',
    })
    run.record({
      step: '隔离口径（仓库外 home/profile）',
      what: 'osHomeDir/homeDir/profile 名均落在 run 目录内，两代宿主共用同一 profileDir',
      expected: 'homeDir=' + homeDir + '；profile=' + PROFILE_NAME,
      actual: 'homeDir=' + homeDir + '；profileDir=' + join(homeDir, 'profiles', PROFILE_NAME),
      verdict: homeDir.startsWith(run.layout.root) ? 'pass' : 'fail',
    })

    const create = await createWebProfileInHome({ homeDir, profileName: PROFILE_NAME })
    await run.raw('profile-create', {
      exitCode: create.create.exitCode,
      stdout: create.create.stdout,
      stderr: create.create.stderr,
      profileDir: create.profileDir,
    })
    run.record({
      step: '建普通 profile（CLI 入口）',
      what: 'createWebProfileInHome 建通道 B 的普通 profile（非 desktop）',
      expected: 'exit=0；profileDir=' + join(homeDir, 'profiles', PROFILE_NAME),
      actual: 'exit=' + create.create.exitCode + '；profileDir=' + create.profileDir,
      verdict: create.create.exitCode === 0 ? 'pass' : 'fail',
    })

    const registryUrl = fixtureEnv.registry.baseUrl
    const baselines = await run.installBaseline({ homeDir, profileName: PROFILE_NAME, registryUrl })
    await verifySutInstalled(run, { homeDir, profileName: PROFILE_NAME, packageName: slotA.packageName })
    for (const slot of slots) {
      const diskVersion = await installedFixtureVersion({ homeDir, profileName: PROFILE_NAME, packageName: slot.packageName })
      if (diskVersion !== baselineVersion) {
        run.record({
          step: '更新前基版在盘（' + slot.key + '）',
          what: '装完基版后磁盘版本',
          expected: baselineVersion,
          actual: diskVersion ?? 'null',
          verdict: 'fail',
        })
      }
    }
    await run.raw('baseline-installed', baselines)
    run.record({
      step: '更新前基版在盘',
      what: 'A/B/C 三包 @' + baselineVersion + ' 已装进 profile，SUT 钉版与工作树 dist 一致',
      expected: '三包磁盘版本=' + baselineVersion,
      actual: slots.map((slot) => slot.key + '=' + baselineVersion).join('，'),
      verdict: 'pass',
    })

    // ---------- 变体发布（0.0.2） ----------
    const baselinePublication = await run.publishBaseline()
    const publication = await publishScenarioVariants(run.scenario, fixtureEnv, undefined, baselinePublication)
    const publishedVariant = publication.variants[slotA.key]
    await fetchPublishedVersions(registryUrl, slotA.packageName)
    await run.raw('fixture-published-variant', {
      baselineVersion,
      variantVersion,
      spec: publishedVariant ? publishedVariant.plan.packageName + '@' + publishedVariant.plan.version : null,
      published: Object.fromEntries(
        Object.entries(publication.variants).map(([key, value]) => [key, value ? value.plan.version : null]),
      ),
    })
    run.record({
      step: '变体 0.0.2 已发布',
      what: '批量三包的 0.0.2 变体发布到仓库外 verdaccio',
      expected: 'A/B/C 均有 0.0.2，A 变体含批量坞/新版 UI',
      actual: 'A=' + (publishedVariant ? publishedVariant.plan.version : 'null') + '；baseline=' + baselineVersion,
      verdict: publishedVariant ? 'pass' : 'fail',
    })

    // ---------- 宿主环境 ----------
    const hostEnv: Record<string, string> = {
      [FIXTURE_REGISTRY_ENV]: registryUrl,
      [FIXTURE_INSTALL_TIMEOUT_ENV]: String(INSTALL_TIMEOUT_MS),
    }
    await run.raw('host-env', {
      env: hostEnv,
      why:
        '换手窗口里第一代宿主被强杀，会留下 global.lock / install.lock；installTimeoutMs 同时是锁陈旧阈值，' +
        '压到 4s 让第二代能在数秒内回收陈旧锁（默认 15min 会把换手拖死，不构成「不依赖人工」的检验）。',
    })
    run.record({
      step: '宿主安装预算=4s（锁陈旧阈值）',
      what: 'DSH_SELFTEST_INSTALL_TIMEOUT_MS 透传给夹具 host half → deps.config.installTimeoutMs',
      expected: 'installTimeoutMs=' + INSTALL_TIMEOUT_MS,
      actual: FIXTURE_INSTALL_TIMEOUT_ENV + '=' + String(INSTALL_TIMEOUT_MS),
      verdict: 'pass',
    })

    // ---------- 队列/中枢目录 ----------
    const expectedQueueDir = join(homeDir, 'update-queue', shortHashOf(create.profileDir))
    const actualQueueDirs = await listDirs(join(homeDir, 'update-queue'))
    await run.raw('hub-paths', {
      profileDir: create.profileDir,
      profileDirShortHash: shortHashOf(create.profileDir),
      expectedQueueDir,
      actualQueueDirs,
      leaseFile: join(expectedQueueDir, 'hub', 'lease.json'),
      plansDir: join(expectedQueueDir, 'hub', 'plans'),
      batchFile: join(expectedQueueDir, BATCH_PREFIX, 'batch.json'),
      why: '用实测目录证明 hub/plan/lease/batch.json 都落在同一 <home>/update-queue/<shortHash>/ 下（不是推断）。',
    })
    run.record({
      step: '中枢/批量目录定位',
      what: '按 profileDir 短哈希复算队列目录，并与盘上实际目录对照（首次安装前目录可能尚未创建）',
      expected: '盘上目录数 ≤1，且存在时=' + shortHashOf(create.profileDir),
      actual: '盘上=' + JSON.stringify(actualQueueDirs) + '；复算=' + shortHashOf(create.profileDir),
      verdict:
        actualQueueDirs.length <= 1 && (actualQueueDirs.length === 0 || actualQueueDirs[0] === shortHashOf(create.profileDir))
          ? 'pass'
          : 'fail',
    })
    const queueDir = expectedQueueDir
    const leaseFile = join(queueDir, 'hub', 'lease.json')
    const plansDir = join(queueDir, 'hub', 'plans')
    const batchFile = join(queueDir, BATCH_PREFIX, 'batch.json')

    await run.addNote(
      '换手注入：web 通道没有「应用自重启」，用「杀第一代宿主 + 同 home/profile 起第二代」注入换手，' +
        '等价于桌面 relaunch 后新 fiber 接管中枢；差别（整进程退出 vs 应用内重启）写进研究笔记。',
    )
    await run.addNote(
      '面板恢复口径：web 通道无窗口，g2 用面板电话（batchStatus/updateHubStatus/updateCheck）在「关宿主→重开」后取证，' +
        '并用宿主页面 HTTP 200 辅助；不冒充桌面真 UI 截图。',
    )
    await run.addNote(
      '为什么灌 installTimeoutMs=4000：第一代被强杀会留下陈旧 global.lock/install.lock，' +
        '第二代的锁回收本身依赖该阈值；不压小则换手要等默认 15min，测不到「无需人工续跑」。',
    )

    // ---------- 宿主生命周期 ----------
    async function startHost(label: string): Promise<HostEntry> {
      const host = await startCliHost({
        homeDir,
        osHomeDir,
        profileName: PROFILE_NAME,
        extraEnv: hostEnv,
      })
      const entry: HostEntry = { label, host, pid: host.pid() ?? null, port: host.port, closed: false }
      startedHosts.push(entry)
      await run.raw('cli-host-launch-' + label, {
        url: host.url,
        port: host.port,
        pid: entry.pid,
        bootMs: host.bootMs,
        profileName: PROFILE_NAME,
        homeDir,
        stdoutTail: host.stdout().slice(-800),
        stderrTail: host.stderr().slice(-800),
      })
      run.record({
        step: '第' + (label === 'host1' ? '一' : label === 'host2' ? '二' : '三') + '代宿主启动（通道 B）',
        what: 'startCliHost 起 DSH web 宿主（同 USERPROFILE/home/profile）',
        expected: 'boot 成功、HTTP 电话入口可用、pid>0',
        actual: 'pid=' + entry.pid + '，port=' + host.port + '，bootMs=' + host.bootMs,
        verdict: entry.pid !== null && entry.pid > 0 && host.port > 0 ? 'pass' : 'fail',
      })
      return entry
    }

    async function closeHost(entry: HostEntry | null): Promise<void> {
      if (!entry || entry.closed) return
      const pid = entry.pid
      const port = entry.port
      entry.closed = true
      await entry.host.close().catch((error) => console.error('[h-hub-continuity] 关宿主失败：' + messageOf(error)))
      run.registerProcess('cli-host-' + entry.label, pid)
      await run.registerPort('cli-host-' + entry.label + '-port', port)
    }

    async function readBatch(): Promise<any> {
      return readJsonMaybe(batchFile)
    }

    async function readLease(): Promise<any> {
      return readJsonMaybe(leaseFile)
    }

    async function readPlan(): Promise<{ file: string; raw: string | null; json: any } | null> {
      let names: string[] = []
      try {
        names = await readdir(plansDir)
      } catch {
        return null
      }
      const planName = names.find((name) => name.endsWith('.json'))
      if (!planName) return null
      const file = join(plansDir, planName)
      const raw = await readTextMaybe(file)
      return { file, raw, json: raw ? await readJsonMaybe(file) : null }
    }

    async function readDiskFacts(tag: string): Promise<Record<string, unknown>> {
      const profileDir = join(homeDir, 'profiles', PROFILE_NAME)
      let manifest: any = null
      let manifestError: string | null = null
      try {
        manifest = await readProfileManifest(profileDir)
      } catch (error) {
        manifestError = messageOf(error)
      }
      const nodeModules: Record<string, string | null> = {}
      const dependencies: Record<string, string | null> = {}
      for (const slot of slots) {
        nodeModules[slot.key] = await installedFixtureVersion({
          homeDir,
          profileName: PROFILE_NAME,
          packageName: slot.packageName,
        })
        dependencies[slot.key] = manifest?.dependencies ? manifest.dependencies[slot.packageName] ?? null : null
      }
      const facts = {
        tag,
        profileDir,
        manifestParseError: manifestError,
        dependencies,
        nodeModules,
        bundles: manifest?.dsh?.profile?.bundles ?? null,
      }
      await run.raw('disk-' + tag, facts)
      return facts
    }

    /** 等第一代宿主把 A 推到 done、B/C 仍未终态（= 换手窗口）。 */
    async function waitForHandoffWindow(host1: HostEntry): Promise<{
      at: number
      phases: Record<string, string | null>
      lease: any
      plan: any
      batch: any
      samples: any[]
    }> {
      const startedAt = Date.now()
      const samples: any[] = []
      let last: any = null
      while (Date.now() - startedAt < 60_000) {
        const batch = await readBatch()
        const lease = await readLease()
        const plan = await readPlan()
        const phases = phasesOfBatch(batch)
        last = { batch, lease, plan }
        samples.push({
          t: Date.now(),
          phases,
          lease: lease ? { pid: lease.pid ?? null, generation: lease.generation ?? null, driverId: lease.driverId ?? null, heartbeatAt: lease.heartbeatAt ?? null } : null,
          planSessionId: plan?.json?.sessionId ?? null,
        })
        if (phases.a === 'done' && phases.b !== null && !TERMINAL_PHASES.includes(phases.b)) {
          await run.raw('state-at-kill', {
            at: Date.now(),
            phases,
            lease,
            plan: plan ? { file: plan.file, json: plan.json } : null,
            batch,
            samples,
          })
          return { at: Date.now(), phases, lease, plan, batch, samples }
        }
        await sleep(KILL_POLL_MS)
      }
      await run.raw('state-at-kill', { at: Date.now(), phases: phasesOfBatch(last?.batch), batch: last?.batch, timeout: true, samples })
      throw new Error('60s 内没等到换手窗口（A 未 done 或 B 已终态）')
    }

    /** 第二代启动后等 batch 全部终态（轮询 batch.json，不驱动安装）。 */
    async function waitForBatchTerminal(budgetMs: number, tag: string): Promise<{
      batch: any
      elapsedMs: number
      samples: any[]
    }> {
      const startedAt = Date.now()
      const samples: any[] = []
      let last: any = null
      while (Date.now() - startedAt < budgetMs) {
        const batch = await readBatch()
        const lease = await readLease()
        last = batch
        samples.push({
          t: Date.now(),
          phases: phasesOfBatch(batch),
          lease: lease ? { pid: lease.pid ?? null, generation: lease.generation ?? null, driverId: lease.driverId ?? null, heartbeatAt: lease.heartbeatAt ?? null } : null,
        })
        if (allTerminal(batch)) break
        await sleep(500)
      }
      await run.raw('batch-' + tag, { batch: last, elapsedMs: Date.now() - startedAt, samples })
      return { batch: last, elapsedMs: Date.now() - startedAt, samples }
    }

    // ---------- 第一代宿主：发起批量、进入换手窗口 ----------
    let host1: HostEntry | null = null
    let host2: HostEntry | null = null
    let host3: HostEntry | null = null
    let killAt: { at: number; phases: Record<string, string | null>; lease: any; plan: any; batch: any } | null = null
    let awayFromWindow = 0
    const driveCalls: { t: number; phone: string; label: string }[] = []
    let installFire: { at: number; settled: string } = { at: 0, settled: 'pending' }
    let installPromise: Promise<unknown> | null = null

    /** 收尾：关掉所有宿主、抓终版日志、核实进程/端口无残留（正常格与 can-red 格共用）。 */
    async function finalizeHosts(): Promise<void> {
      await closeHost(host3)
      await closeHost(host2)
      await closeHost(host1)
      const capture = await captureLogFiles(run.recorder, homeDir)
      await run.raw('logs-final', {
        files: capture.snapshot.files,
        unparsedLines: capture.snapshot.unparsedLines,
        truncations: capture.truncations,
        eventCounts: eventCountsOf(capture.snapshot.events.map((event) => ({
          ts: null,
          event: event.event,
          level: event.level,
          fields: event.fields,
          source: event.source,
          line: event.line,
        }))),
      })
      const remainingPids = startedHosts.filter((entry) => entry.pid !== null && isProcessAlive(entry.pid)).map((entry) => entry.label + ':' + entry.pid)
      const portChecks: { label: string; port: number; free: boolean }[] = []
      for (const entry of startedHosts) portChecks.push({ label: entry.label, port: entry.port, free: await isPortFree(entry.port) })
      await run.raw('cleanup-verify', {
        startedHosts: startedHosts.map((entry) => ({ label: entry.label, pid: entry.pid, port: entry.port, closed: entry.closed })),
        remainingPids,
        portChecks,
      })
      run.record({
        step: '收尾：宿主进程与端口无残留',
        what: '关闭所有宿主后核实 pid 不在、端口空闲',
        expected: 'remainingPids=[]、所有端口 free=true',
        actual: 'remainingPids=' + JSON.stringify(remainingPids) + '；portChecks=' + JSON.stringify(portChecks),
        verdict: remainingPids.length === 0 && portChecks.every((check) => check.free) ? 'pass' : 'fail',
      })
    }

    host1 = await startHost('host1')
    const initialStatus = await callPhone(host1.host, phones.batchStatus)
    await run.raw('panel-batch-status-initial', {
      status: initialStatus.status,
      durationMs: initialStatus.durationMs,
      body: initialStatus.body,
    })
    run.record({
      step: '第一代宿主批量面板可读',
      what: 'batchStatus 电话（批量面板数据源）',
      expected: 'ok=true；三包会话可读或空',
      actual: 'ok=' + initialStatus.ok + '；error=' + (initialStatus.error ?? 'null'),
      verdict: initialStatus.ok ? 'pass' : 'fail',
    })

    const check = await callPhone(host1.host, phones.batchCheck)
    await run.raw('phone-batch-check', { status: check.status, durationMs: check.durationMs, body: check.body })
    const checkRowKeys = check.rows.map((row: any) => String(row?.key ?? ''))
    run.record({
      step: '批量检查电话受理',
      what: 'fxa.batchCheck 建/读批量会话（A 自键排在第一位）',
      expected: 'ok=true；三行 key=[a,b,c]（batchCheck 阶段的 session 骨架可能为空，以 rows 顺序为准）',
      actual: 'ok=' + check.ok + '；rowKeys=' + JSON.stringify(checkRowKeys) + '；rows=' + check.rows.length,
      verdict:
        check.ok && check.rows.length === 3 && JSON.stringify(checkRowKeys) === JSON.stringify(['a', 'b', 'c'])
          ? 'pass'
          : 'fail',
    })

    const aCheck = await callPhone(host1.host, phones.check)
    await run.raw('phone-a-update-check-before-batch', {
      status: aCheck.status,
      durationMs: aCheck.durationMs,
      body: aCheck.body,
    })
    const aCheckSnapshot = aCheck.inner?.snapshot ?? null
    run.record({
      step: 'A 自身检查更新（批量前）',
      what: 'A 的 updateCheck 看到 0.0.2 可更新',
      expected: 'canInstall=true；installedVersion=' + baselineVersion + '；latestVersion=' + variantVersion,
      actual:
        'canInstall=' + String(aCheckSnapshot?.canInstall ?? null) +
        '；installedVersion=' + String(aCheckSnapshot?.installedVersion ?? null) +
        '；latestVersion=' + String(aCheckSnapshot?.latestVersion ?? null),
      verdict:
        aCheck.ok && aCheckSnapshot?.canInstall === true && aCheckSnapshot?.latestVersion === variantVersion
          ? 'pass'
          : 'fail',
    })

    // 不 await：批量电话会同步驱动到收尾，必须在它跑的时候观测/杀宿主。
    installFire = { at: Date.now(), settled: 'pending' }
    await run.raw('phone-batch-install-fire', {
      at: installFire.at,
      note: '不 await；随后轮询 batch.json，A done 且 B 未终态时杀第一代宿主。',
    })
    driveCalls.push({ t: installFire.at, phone: phones.batchInstall, label: 'host1' })
    installPromise = callPhone(host1.host, phones.batchInstall)
      .then((result) => {
        installFire = { at: installFire.at, settled: 'resolved:' + (result.ok ? 'ok' : String(result.error)) }
        return result
      })
      .catch((error) => {
        installFire = { at: installFire.at, settled: 'rejected:' + messageOf(error) }
        return null
      })
    run.record({
      step: '批量安装电话已发出（不等回包）',
      what: 'host1 发 fxa.batchInstall，场景并行观测 batch.json/lease',
      expected: '电话已发出，批量会话开始推进（A 先换）',
      actual: 'at=' + installFire.at,
      verdict: 'pass',
    })

    let window: Awaited<ReturnType<typeof waitForHandoffWindow>> | null = null
    try {
      window = await waitForHandoffWindow(host1)
    } catch (error) {
      await run.raw('handoff-window-error', { message: messageOf(error) })
    }
    if (window) {
      killAt = window
      run.record({
        step: '换手窗口：A 已 done、B/C 未终态',
        what: '轮询 batch.json 捕获第一代推进到「A 已换、B/C 未终态」的窗口',
        expected: "phase(a)='done' 且 phase(b) 非终态",
        actual: 'phases=' + JSON.stringify(window.phases) + '；planSessionId=' + String(window.plan?.json?.sessionId ?? null),
        verdict:
          window.phases.a === 'done' && window.phases.b !== null && !TERMINAL_PHASES.includes(window.phases.b)
            ? 'pass'
            : 'fail',
      })
      await run.raw('hub-lease-at-kill', { lease: window.lease, plan: window.plan ? window.plan.json : null })
      const leaseAtKill = window.lease
      run.record({
        step: '换手前中枢租约由第一代宿主持有',
        what: 'hub/lease.json 的 pid/属主与 enhancement',
        expected: 'lease.pid=' + host1.pid + '（第一代宿主进程）',
        actual: 'lease=' + JSON.stringify(leaseAtKill ? { pid: leaseAtKill.pid, generation: leaseAtKill.generation, driverId: leaseAtKill.driverId } : null),
        verdict: leaseAtKill && leaseAtKill.pid === host1.pid ? 'pass' : 'fail',
      })
    }

    // ---------- 杀第一代 → 换手注入 ----------
    const host1Pid = host1.pid
    await closeHost(host1)
    await run.raw('host1-stopped', { pid: host1Pid, at: Date.now(), afterWindow: killAt?.at ?? null })
    host1 = null
    run.record({
      step: '第一代宿主已停（换手注入）',
      what: '关掉第一代宿主进程（未等待批量收尾），中枢执行者消失',
      expected: 'pid=' + host1Pid + ' 不再存活',
      actual: 'alive=' + (host1Pid !== null && isProcessAlive(host1Pid)),
      verdict: host1Pid === null || !isProcessAlive(host1Pid) ? 'pass' : 'fail',
    })

    // can-red：删除 hub plan（中枢没有方案可接管，预期 B/C 断链）。
    let canRedInjection: { planFile: string; rawBefore: string | null; deletedAt: number } | null = null
    if (options.mode === 'can-red') {
      const plan = await readPlan()
      if (!plan) throw new Error('can-red：换手窗口内找不到 hub plan，无法注入')
      canRedInjection = { planFile: plan.file, rawBefore: plan.raw, deletedAt: 0 }
      await run.raw('can-red-plan-before-delete', { file: plan.file, raw: plan.raw, json: plan.json })
      await unlink(plan.file)
      canRedInjection.deletedAt = Date.now()
      const after = await readTextMaybe(plan.file)
      await run.raw('can-red-plan-deleted', {
        file: plan.file,
        deletedAt: canRedInjection.deletedAt,
        before: plan.raw,
        after,
        why:
          '换手窗口里删除 <home>/update-queue/<hash>/hub/plans/fxa.json：中枢方案是第二代接管的唯一依据，' +
          '删掉后 B/C 不应继续（用于证明「B/C 自动续跑」断言可红）。',
      })
      run.record({
        step: 'can-red 注入：换手窗口删除 hub plan',
        what: '删 <home>/update-queue/<hash>/hub/plans/fxa.json，模拟中枢方案丢失',
        expected: '删除前 plan 在盘（原文已留 raw），删除后读不到',
        actual: 'deletedAt=' + canRedInjection.deletedAt + '；after=' + (after === null ? 'null' : 'still-present'),
        verdict: after === null ? 'pass' : 'fail',
      })
    }

    // ---------- 第二代宿主：从盘上恢复 ----------
    host2 = await startHost('host2')
    const host2StartWall = Date.now()
    await run.raw('host2-start-window', {
      wallAt: host2StartWall,
      pid: host2.pid,
      at: Date.now(),
      afterKillAt: killAt?.at ?? null,
      note: 'B/C 的 exec ts 必须晚于第二代 host.start 日志 ts，才算「换手后无需人工续跑」。',
    })

    const canRedBudget = options.mode === 'can-red' ? CAN_RED_WAIT_MS : BATCH_WAIT_MS
    const terminal = await waitForBatchTerminal(canRedBudget, options.mode === 'can-red' ? 'after-can-red' : 'after-handoff')

    // 第一代安装电话的结局（宿主被杀 → 预期拒绝/断开）
    if (installPromise) await installPromise
    await run.raw('install-promise-outcome', installFire)

    // ---------- 日志（含 exec ts / host.start ts / run.start） ----------
    const logRows =
      options.mode === 'can-red'
        ? await readRawLogRows(homeDir)
        : await waitForExecRows(
            homeDir,
            [batchTargetPrefixes.get('b') ?? 'fxa-b', batchTargetPrefixes.get('c') ?? 'fxa-c'],
            20000,
          )
    const execA = execRowsOf(logRows, batchTargetPrefixes.get('a') ?? 'fxa-a')
    const execB = execRowsOf(logRows, batchTargetPrefixes.get('b') ?? 'fxa-b')
    const execC = execRowsOf(logRows, batchTargetPrefixes.get('c') ?? 'fxa-c')
    const startRows = hostStartRows(logRows)
    const host2StartLog = startRows.filter((row) => row.pid === host2?.pid).sort((left, right) => (left.ts ?? 0) - (right.ts ?? 0))[0] ?? null
    const host2StartTs = tsOf(host2StartLog ?? undefined)
    const runStartRows = logRows
      .filter((row) => row.event === 'update.batch.run.start')
      .map((row) => ({ ts: row.ts, trigger: row.fields?.trigger ?? null, resumed: row.fields?.resumed ?? null, total: row.fields?.total ?? null }))
    const gateRefused = logRows.filter(
      (row) =>
        row.event === 'update.install.fail' &&
        row.fields?.reason === 'gate-refused',
    ).map((row) => ({ ts: row.ts, stage: row.fields?.stage ?? null, code: row.fields?.code ?? null }))
    const execFailures = logRows
      .filter((row) => row.event === 'update.install.fail' && row.fields?.stage === 'exec')
      .map((row) => ({ ts: row.ts, stage: row.fields?.stage ?? null, reason: row.fields?.reason ?? null, code: row.fields?.code ?? null }))
    await run.raw('log-timeline', {
      eventCounts: eventCountsOf(logRows),
      hostStartRows: startRows,
      host2StartTs,
      batchRunStart: runStartRows,
      gateRefusedCount: gateRefused.length,
      gateRefusedFirst: gateRefused[0] ?? null,
      gateRefusedLast: gateRefused[gateRefused.length - 1] ?? null,
      execFailures,
      execA,
      execB,
      execC,
      parseNote: 'raw 行保留 ts；readLogEvents 丢 ts，但 raw 拷回原文可解析。',
    })

    // ---------- 磁盘 / 台账 ----------
    const disk = await readDiskFacts('after-handoff')
    const ledger = await readLedgerStates(homeDir)
    const ledgerByPlugin: Record<string, any[]> = {}
    for (const entry of ledger) {
      const pluginId = ledgerPluginIdOf(entry.file)
      if (!pluginId) continue
      ledgerByPlugin[pluginId] = ledgerByPlugin[pluginId] ?? []
      ledgerByPlugin[pluginId].push(entry.state)
    }
    await run.raw('ledger-states', {
      entries: ledger,
      byPlugin: Object.fromEntries(
        Object.entries(ledgerByPlugin).map(([pluginId, states]) => [
          pluginId,
          states.map((state) => ({
            state: state?.state ?? null,
            targetVersion: state?.targetVersion ?? null,
            previousVersion: state?.previousVersion ?? null,
            requestId: state?.requestId ?? null,
          })),
        ]),
      ),
    })

    // ---------- 断言：换手后 B/C 自动续跑 ----------
    if (options.mode === 'can-red') {
      const phases = phasesOfBatch(terminal.batch)
      const execAfterHost2 = [...execB, ...execC].filter((row) => host2StartTs !== null && row.ts !== null && row.ts > host2StartTs)
      const resumed = runStartRows.filter((row) => row.trigger === 'resume')
      const broken =
        !allTerminal(terminal.batch) ||
        phases.b !== 'done' ||
        phases.c !== 'done' ||
        execAfterHost2.length === 0 ||
        resumed.length === 0
      await run.raw('can-red-verdict-facts', {
        phases,
        allTerminal: allTerminal(terminal.batch),
        host2StartTs,
        execAfterHost2,
        runStartRows,
        elapsedMs: terminal.elapsedMs,
        gateRefusedCount: gateRefused.length,
        note: '本 run 预期红：删 plan 后中枢无方案可接管，B/C 不应自动续跑。',
      })
      run.record({
        step: 'can-red 红点：换手窗口删 hub plan 后 B/C 未自动续跑',
        what: '删除中枢方案后启动第二代宿主，观察 B/C 是否仍自动完成（本断言在 can-red 注入下应当红）',
        expected: 'B/C 自动续跑完成（正常场景应如此；本 run 人为删 plan 后预期不成立）',
        actual:
          'phases=' + JSON.stringify(phases) +
          '；elapsedMs=' + terminal.elapsedMs +
          '；resumeRunStart=' + resumed.length +
          '；execAfterHost2=' + execAfterHost2.length,
        verdict: broken ? 'fail' : 'unknown',
        note: broken
          ? 'can-red 成立：删 plan 后 B/C 未自动续跑（无 resume run.start / 无第二代后 exec），红点可归因到注入的 plan 丢失。'
          : 'can-red 未变红：删 plan 后 B/C 仍完成，需排查是否还有其它恢复路径（不是预期结果）。',
      })
      await finalizeHosts()
      return await finish(run, options)
    }

    const finalPhases = phasesOfBatch(terminal.batch)
    run.record({
      step: '换手后 batch 三行终态全 done、failed=0',
      what: '不驱动安装，只轮询 batch.json 等第二代把 B/C 推完',
      expected: "phases={a:'done',b:'done',c:'done'}；无 failed",
      actual: 'phases=' + JSON.stringify(finalPhases) + '；elapsedMs=' + terminal.elapsedMs,
      verdict:
        finalPhases.a === 'done' && finalPhases.b === 'done' && finalPhases.c === 'done'
          ? 'pass'
          : 'fail',
    })

    const execAfterHost2 = [...execB, ...execC].filter((row) => host2StartTs !== null && row.ts !== null && row.ts > host2StartTs)
    run.record({
      step: 'B/C 在第二代宿主启动后自动续跑（无人工）',
      what: 'B/C 的 update.install.exec ts vs 第二代 host.start ts；换手后场景只发只读查询',
      expected: 'B/C 各有 1 条 exec（route=cli-process、ok=true、exitCode=0），且 ts > 第二代 host.start',
      actual:
        'host2StartTs=' + String(host2StartTs) +
        '；B=' + JSON.stringify(execB) +
        '；C=' + JSON.stringify(execC) +
        '；后置执行数=' + execAfterHost2.length +
        '；host2 启动后场景驱动电话=' + JSON.stringify(driveCalls.filter((call) => call.t > host2StartWall)),
      verdict:
        execB.length >= 1 &&
        execC.length >= 1 &&
        execB.every((row) => row.route === 'cli-process' && row.ok === true && row.exitCode === 0) &&
        execC.every((row) => row.route === 'cli-process' && row.ok === true && row.exitCode === 0) &&
        execAfterHost2.length >= 2
          ? 'pass'
          : 'fail',
    })

    run.record({
      step: '无安装期硬失败（exec 阶段失败=0）',
      what: 'update.install.fail 里 stage=exec 的行（安装执行失败）必须为 0；gate-refused 只是队列占位恢复的等待噪声',
      expected: 'execFailures=0',
      actual:
        'execFailures=' + execFailures.length +
        '；gateRefused=' + gateRefused.length +
        '（≤30s 的 #217 陈旧占位恢复噪声，见 notes）',
      verdict: execFailures.length === 0 ? 'pass' : 'fail',
    })

    const planAfter = await readPlan()
    const batchJson = terminal.batch
    run.record({
      step: '中枢方案在换手后仍在盘、被第二代接管（同 sessionId）',
      what: 'hub/plans/fxa.json 与 batch.json 的 sessionId 一致，plan 未被换手清掉',
      expected: 'plan 存在且 plan.sessionId=batch.id',
      actual:
        'plan=' + (planAfter ? planAfter.file : 'null') +
        '；planSessionId=' + String(planAfter?.json?.sessionId ?? null) +
        '；batchId=' + String(batchJson?.id ?? null) +
        '；runStart=' + JSON.stringify(runStartRows),
      verdict:
        planAfter !== null && batchJson?.id && planAfter?.json?.sessionId === batchJson.id ? 'pass' : 'fail',
    })

    // ---------- 断言：面板状态（host2 上的批量/中枢/A 自身） ----------
    const finalBatchStatus = await callPhone(host2.host, phones.batchStatus)
    await run.raw('panel-batch-status-final', {
      status: finalBatchStatus.status,
      durationMs: finalBatchStatus.durationMs,
      body: finalBatchStatus.body,
    })
    const finalSession = finalBatchStatus.session
    const finalRows = Array.isArray(finalSession?.entries) ? finalSession.entries : finalBatchStatus.rows
    run.record({
      step: '第二代宿主上的批量面板三行 done',
      what: 'batchStatus 回包（面板数据源）与磁盘 batch.json 一致',
      expected: "三行 phase=done；targetVersion=" + variantVersion,
      actual:
        'ok=' + finalBatchStatus.ok +
        '；rows=' + JSON.stringify(finalBatchStatus.rows.map((row: any) => ({ key: row.key, phase: row.phase, targetVersion: row.targetVersion }))) +
        '；sessionEntries=' + JSON.stringify((Array.isArray(finalSession?.entries) ? finalSession.entries : []).map((entry: any) => ({ key: entry.key, phase: entry.phase }))),
      verdict:
        finalBatchStatus.ok &&
        finalBatchStatus.rows.length === 3 &&
        finalBatchStatus.rows.every((row: any) => row.phase === 'done' && row.targetVersion === variantVersion)
          ? 'pass'
          : 'fail',
    })

    const hubStatus = await callPhone(host2.host, phones.hubStatus)
    await run.raw('panel-hub-status-final', {
      status: hubStatus.status,
      durationMs: hubStatus.durationMs,
      body: hubStatus.body,
    })
    const hubSessions = Array.isArray(hubStatus.snapshot?.sessions) ? hubStatus.snapshot.sessions : []
    const hubSession = hubSessions.find((session: any) => session?.sessionId === batchJson?.id) ?? hubSessions[0] ?? null
    run.record({
      step: '中枢状态与批量台账一致（finished done3 failed0）',
      what: 'updateHubStatus 回包：state/progress/activeInstall',
      expected: "state='finished'；progress.done=3、failed=0；activeInstall=null",
      actual:
        'state=' + String(hubSession?.state ?? null) +
        '；progress=' + JSON.stringify(hubSession?.progress ?? null) +
        '；activeInstall=' + JSON.stringify(hubStatus.snapshot?.activeInstall ?? null),
      verdict:
        hubSession?.state === 'finished' &&
        hubSession?.progress?.done === 3 &&
        hubSession?.progress?.failed === 0 &&
        (hubStatus.snapshot?.activeInstall ?? null) === null
          ? 'pass'
          : 'fail',
    })

    const aStatus = await callPhone(host2.host, phones.check)
    await run.raw('phone-a-update-check-after-handoff', {
      status: aStatus.status,
      durationMs: aStatus.durationMs,
      body: aStatus.body,
    })
    const aStatusSnapshot = aStatus.inner?.snapshot ?? null
    run.record({
      step: 'A 自身换手后状态正确（已是最新）',
      what: 'host2 上 A 的 updateCheck',
      expected: 'installedVersion/runningVersion=' + variantVersion + '；canInstall=false',
      actual:
        'installedVersion=' + String(aStatusSnapshot?.installedVersion ?? null) +
        '；runningVersion=' + String(aStatusSnapshot?.runningVersion ?? null) +
        '；canInstall=' + String(aStatusSnapshot?.canInstall ?? null),
      verdict:
        aStatusSnapshot?.installedVersion === variantVersion && aStatusSnapshot?.canInstall === false ? 'pass' : 'fail',
    })

    // ---------- 断言：磁盘 / 台账 ----------
    const diskNodeModules = disk.nodeModules as Record<string, string | null>
    const diskDependencies = disk.dependencies as Record<string, string | null>
    const diskOk = slots.every(
      (slot) => diskNodeModules[slot.key] === variantVersion && diskDependencies[slot.key] === variantVersion,
    )
    run.record({
      step: '磁盘三包一致 0.0.2（profile 未损坏、无双装）',
      what: 'profile package.json dependencies 与 node_modules 实际版本',
      expected: 'A/B/C dependencies+node_modules 都=' + variantVersion,
      actual: 'dependencies=' + JSON.stringify(diskDependencies) + '；node_modules=' + JSON.stringify(diskNodeModules),
      verdict: diskOk && disk.manifestParseError === null ? 'pass' : 'fail',
    })

    const ledgerFacts = slots.map((slot) => {
      const pluginId = batchTargetPrefixes.get(slot.key) ?? slot.pluginId
      return { slot: slot.key, pluginId, states: ledgerByPlugin[pluginId] ?? [] }
    })
    const ledgerOk = ledgerFacts.every(
      (fact) =>
        fact.states.length === 1 &&
        fact.states[0]?.targetVersion === variantVersion &&
        fact.states[0]?.previousVersion === baselineVersion &&
        ['completed', 'restart-required'].includes(fact.states[0]?.state),
    )
    run.record({
      step: '台账三包各恰一条成功终态（无重复/丢单）',
      what: '<home>/updates/<pluginId>/<hash>/state.json',
      expected: 'A/B/C 各 1 条：target=' + variantVersion + '、previous=' + baselineVersion + '、state∈{completed,restart-required}',
      actual: JSON.stringify(
        Object.fromEntries(ledgerFacts.map((fact) => [fact.pluginId, fact.states.map((state: any) => ({
          state: state?.state ?? null,
          targetVersion: state?.targetVersion ?? null,
          previousVersion: state?.previousVersion ?? null,
        }))])),
      ),
      verdict: ledgerOk ? 'pass' : 'fail',
    })

    // ---------- 断言：租约单一属主/换手 ----------
    const leaseSamples = [...(terminal.samples ?? [])]
    const leasePids = [...new Set(leaseSamples.map((sample) => sample?.lease?.pid).filter((pid) => typeof pid === 'number'))]
    const host2Pid = host2.pid
    const host2LeaseSeen = host2Pid !== null && leasePids.includes(host2Pid)
    const host1LeaseSeen = killAt?.lease ? leasePids.includes(killAt.lease.pid) : true
    const leaseAfterBatch = await readLease()
    await run.raw('hub-lease-timeline', {
      samples: leaseSamples,
      leasePids,
      host1Pid,
      host2Pid: host2.pid,
      leaseAfterBatch,
      note:
        'lease.json 任意时刻只有一份（单文件天然单写者）；换手后由第二代 driverId/pid 续租。' +
        'web 注入是整进程退出，第一代退出钩子会释放租约，因此第二代可能是新取 generation（不是桌面 relaunch 的 gen+1 接管）——记录实际值，不硬断言 gen+1。',
    })
    run.record({
      step: '中枢租约换手：单一属主，从第一代交到第二代',
      what: '轮询 hub/lease.json 的 pid/generation 序列',
      expected: '先见到第一代 pid=' + host1Pid + '，再见到第二代 pid=' + String(host2Pid),
      actual: 'leasePids=' + JSON.stringify(leasePids) + '；afterBatch=' + JSON.stringify(leaseAfterBatch ? { pid: leaseAfterBatch.pid, generation: leaseAfterBatch.generation } : null),
      verdict: host1LeaseSeen && host2LeaseSeen ? 'pass' : 'fail',
    })

    // ---------- g2：关宿主 → 重开页面 → 刷新一致 ----------
    if (options.mode === 'page-recovery') {
      const rawFetch = fetch as unknown as (url: string, init?: any) => Promise<any>
      const host2Pid = host2.pid
      await closeHost(host2)
      host2 = null
      await run.raw('host2-closed-for-page-reopen', { pid: host2Pid, at: Date.now() })
      host3 = await startHost('host3')
      // 浏览器口径：带 token 的根请求 303 下发签名 cookie，随后带 cookie 的 `/` 请求 200 返回页面。
      // 注意 Node fetch 默认跟随重定向但不保存 cookie——直接 GET 会 401，这里显式做两步握手。
      const handshake = await rawFetch(host3.host.url, { redirect: 'manual' })
      const setCookie = (handshake.headers.getSetCookie?.() ?? []).join('\n')
      const cookie = setCookie.split(';')[0] ?? ''
      const pageResponse = await rawFetch(new URL('/', host3.host.url).href, {
        headers: cookie ? { cookie } : {},
        redirect: 'manual',
      })
      const pageBody = await pageResponse.text()
      await run.raw('panel-page-http', {
        url: host3.host.url,
        handshakeStatus: handshake.status,
        handshakeLocation: handshake.headers.get('location'),
        setCookiePresent: setCookie.length > 0,
        status: pageResponse.status,
        bytes: pageBody.length,
        snippet: pageBody.slice(0, 1200),
      })
      run.record({
        step: '重开页面：宿主页面可加载',
        what: 'GET 重开后的宿主 URL（token）→ 303+cookie → 带 cookie GET / → 200 页面',
        expected: '握手 303 且下发 cookie；带 cookie 的 / 返回 HTTP 200 与页面内容',
        actual:
          'handshake=' + handshake.status +
          '；location=' + String(handshake.headers.get('location')) +
          '；cookieSet=' + (setCookie.length > 0) +
          '；page=' + pageResponse.status +
          '；bytes=' + pageBody.length,
        verdict:
          handshake.status === 303 && setCookie.length > 0 && pageResponse.status === 200 && pageBody.length > 0
            ? 'pass'
            : 'fail',
      })

      const reopened = await callPhone(host3.host, phones.batchStatus)
      await run.raw('panel-batch-status-reopened', {
        status: reopened.status,
        durationMs: reopened.durationMs,
        body: reopened.body,
      })
      const reopenedSession = reopened.session
      // batchStatus 的 progress 在 reply 顶层（session 只有 entries），不是 session.progress。
      const reopenedProgress = (reopened.inner as any)?.progress ?? null
      const reopenedPhases = Array.isArray(reopenedSession?.entries)
        ? Object.fromEntries(reopenedSession.entries.map((entry: any) => [entry.key, entry.phase]))
        : {}
      run.record({
        step: '重开页面后面板批量状态恢复（全部完成、无进行中残留）',
        what: '关第二代宿主、同 home/profile 重开宿主后取 batchStatus',
        expected: "三行 phase=done；progress finished；无 installing/queued 残留",
        actual: 'ok=' + reopened.ok + '；phases=' + JSON.stringify(reopenedPhases) + '；progress=' + JSON.stringify(reopenedProgress),
        verdict:
          reopened.ok &&
          JSON.stringify(reopenedPhases) === JSON.stringify({ a: 'done', b: 'done', c: 'done' }) &&
          reopenedProgress?.finished === true &&
          reopenedProgress?.failed === 0
            ? 'pass'
            : 'fail',
      })

      await sleep(1000)
      const refreshed = await callPhone(host3.host, phones.batchStatus)
      await run.raw('panel-batch-status-refreshed', {
        status: refreshed.status,
        durationMs: refreshed.durationMs,
        body: refreshed.body,
      })
      const refreshedSession = refreshed.session
      const refreshedPhases = Array.isArray(refreshedSession?.entries)
        ? Object.fromEntries(refreshedSession.entries.map((entry: any) => [entry.key, entry.phase]))
        : {}
      run.record({
        step: '同一页面刷新后数据一致（不是断线/假绿）',
        what: '同一宿主内再取一次 batchStatus，与重开时首次结果比对',
        expected: '两次 phase/进度完全一致',
        actual: 'first=' + JSON.stringify(reopenedPhases) + '；second=' + JSON.stringify(refreshedPhases),
        verdict:
          refreshed.ok && JSON.stringify(refreshedPhases) === JSON.stringify(reopenedPhases) ? 'pass' : 'fail',
      })

      const reopenedHub = await callPhone(host3.host, phones.hubStatus)
      await run.raw('panel-hub-status-reopened', {
        status: reopenedHub.status,
        durationMs: reopenedHub.durationMs,
        body: reopenedHub.body,
      })
      const reopenedHubSession = (Array.isArray(reopenedHub.snapshot?.sessions) ? reopenedHub.snapshot.sessions : [])
        .find((session: any) => session?.sessionId === batchJson?.id) ?? null
      run.record({
        step: '重开页面后中枢状态与台账一致',
        what: 'updateHubStatus：finished/done3/failed0/activeInstall=null',
        expected: "state='finished'；done=3、failed=0；activeInstall=null",
        actual:
          'state=' + String(reopenedHubSession?.state ?? null) +
          '；progress=' + JSON.stringify(reopenedHubSession?.progress ?? null) +
          '；activeInstall=' + JSON.stringify(reopenedHub.snapshot?.activeInstall ?? null),
        verdict:
          reopenedHubSession?.state === 'finished' &&
          reopenedHubSession?.progress?.done === 3 &&
          reopenedHubSession?.progress?.failed === 0 &&
          (reopenedHub.snapshot?.activeInstall ?? null) === null
            ? 'pass'
            : 'fail',
      })

      const reopenedA = await callPhone(host3.host, phones.check)
      await run.raw('phone-a-update-check-reopened', {
        status: reopenedA.status,
        durationMs: reopenedA.durationMs,
        body: reopenedA.body,
      })
      const reopenedASnapshot = reopenedA.inner?.snapshot ?? null
      run.record({
        step: '重开页面后 A 自身状态正确（已是最新）',
        what: 'A 的 updateCheck 回包',
        expected: 'installedVersion/runningVersion=' + variantVersion + '；canInstall=false',
        actual:
          'installedVersion=' + String(reopenedASnapshot?.installedVersion ?? null) +
          '；runningVersion=' + String(reopenedASnapshot?.runningVersion ?? null) +
          '；canInstall=' + String(reopenedASnapshot?.canInstall ?? null),
        verdict:
          reopenedASnapshot?.installedVersion === variantVersion && reopenedASnapshot?.canInstall === false
            ? 'pass'
            : 'fail',
      })

      const reopenedDisk = await readDiskFacts('after-page-reopen')
      const reopenedLedger = await readLedgerStates(homeDir)
      const reopenedLedgerCount = reopenedLedger.filter((entry) => {
        const pluginId = ledgerPluginIdOf(entry.file)
        return slots.some((slot) => pluginId === (batchTargetPrefixes.get(slot.key) ?? slot.pluginId))
      }).length
      const reopenedNodeModules = reopenedDisk.nodeModules as Record<string, string | null>
      run.record({
        step: '重开页面后台账/磁盘仍一致（无重复无丢行）',
        what: '再读 <home>/updates 台账与 profile 磁盘',
        expected: '台账三条、磁盘三包=' + variantVersion,
        actual: 'ledgerEntries=' + reopenedLedgerCount + '；nodeModules=' + JSON.stringify(reopenedNodeModules),
        verdict:
          reopenedLedgerCount === 3 && slots.every((slot) => reopenedNodeModules[slot.key] === variantVersion)
            ? 'pass'
            : 'fail',
      })
    }

    // ---------- 收尾 ----------
    await finalizeHosts()

    return await finish(run, options)
  } catch (error) {
    const message = messageOf(error)
    const stack = error instanceof Error && error.stack ? error.stack : ''
    await run.raw('scenario-error', { message, stack })
    run.record({
      step: '场景执行异常（blocked/unknown）',
      what: '场景主流程抛错',
      expected: '主流程完整跑完',
      actual: message,
      verdict: 'unknown',
    })
    await run.addNote('场景异常：' + message)
    for (const entry of startedHosts) {
      if (entry.closed) continue
      entry.closed = true
      await entry.host.close().catch(() => undefined)
      run.registerProcess('cli-host-' + entry.label, entry.pid)
      await run.registerPort('cli-host-' + entry.label + '-port', entry.port).catch(() => undefined)
    }
    return await finish(run, options)
  }
}
