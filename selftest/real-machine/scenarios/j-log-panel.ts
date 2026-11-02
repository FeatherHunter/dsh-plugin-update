/**
 * selftest/real-machine/scenarios/j-log-panel.ts —— 票 #273（spec #263 T9 / J 组：日志面板）真机场景。
 *
 * 测什么（三格 + can-red，全部跑在真机通道 B 上）：
 *   j1 contract-coverage：真安装（单包 A@0.0.2）+ 真批量失败（只推 B，独占文件锁拖住 remove 致安装超时）之后，
 *      把 <home>/logs 下所有命名空间目录逐行读回，按 event-list.update.json 校验「事件名/level/字段/枚举」四关，
 *      并断言必备事件覆盖、失败事件面（exec ok=false + stage=exec + verify failed）、批量 summary 事实、
 *      台账逐包真相、命名空间落点合法、每命名空间行数在预算内。
 *   j2 noise-budget：真 UI（Playwright 打开 web 宿主页面 = 面板真轮询）静置 ≥100 次 updateStatus 轮询，
 *      断言窗口内常驻行 0 新增（轮询静默）；随后在面板点「检查更新」让状态真变化，断言恰一条 status.changed
 *      且同指纹不重复（边沿触发）。
 *   j3 namespace-whitelist：真 UI 面板的日志健康读数 ↔ 磁盘日志对齐（落点=self / 8 位目录指纹 = update.wire.ready
 *      行的 logDirHash / 丢弃 0 行 / 事件契约=正常）；客户端事件只落在属主命名空间且名字在 CLIENT_LOG_EVENTS
 *      白名单内；再用 logAppend 电话伪造宿主事实事件，断言客户端通道拒绝（不落伪造行）。
 *   can-red（复用 j1 场景 id）：把 event-list.update.json 复制到 run 私有目录并删掉 update.install.exec 事件，
 *      契约断言必然把真 exec 行判成未知事件 → 本 run 必须 fail/exit 1，证明断言有牙齿。
 *
 * 「面板」的口径：web GUI 没有独立的「插件日志查看器」；J 组要证的面板面 = 更新面板里的
 * 日志路牌（第 4 章）+ 日志健康读数（src/panel/render.ts:1035-1067、src/shared/copy.ts:431），
 * 再加磁盘日志本身。j3 的 UI 对照只断言这两行在真页面上可见且与磁盘一致，不冒充独立日志面板。
 *
 * 证据口径（selftest/evidence/README.md）：事件原始行/日志 inventory/轮询计数/面板原文全部进 raw；
 * 真 UI 截图带六字段 sidecar；断言只写 raw 里读得到的事实。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FIXTURE_REGISTRY_ENV, fixtureBridgeRouteOf, fixtureSlotOf } from '../../fixtures/identity/fixture-slots.ts'
import type { FixtureSlot, FixtureSlotKey } from '../../fixtures/identity/fixture-slots.ts'
import { ensureDir, listFilesRecursive } from '../../tooling/fs-utils.ts'
import { isProcessAlive, sleep } from '../../tooling/process.ts'
import { publishScenarioVariants, variantVersionOf } from '../runtime/scenario-runner.ts'
import { fixtureSpecOf } from '../runtime/fixture-environment.ts'
import type { CliHostSession } from '../host/cli-host.ts'
import { startCliHost } from '../host/cli-host.ts'
import { createWebProfileInHome } from '../host/isolated-profile.ts'
import { openAuthenticatedPage, readBodyText } from '../base-verify/web-ui.ts'
import type { RunManifest } from '../runtime/evidence.ts'
import { copyRunEvidence } from './batch-helpers.ts'
import type { T3Run } from './t3-common.ts'
import { installedFixtureVersion, openT3Run, verifySutInstalled } from './t3-common.ts'

/** 场景 mode（工具层 --mode 透传）。 */
export type JLogPanelMode = 'contract-coverage' | 'noise-budget' | 'namespace-whitelist' | 'can-red'

/** 一次真机 run 的入参（工具层解析后原样传）。 */
export interface JLogPanelOptions {
  readonly worktree: string
  readonly runBaseDir: string
  readonly verdaccioInstallDir: string
  readonly esbuildPath: string
  readonly stamp?: string
  readonly maintainerHome?: string
  readonly mode: JLogPanelMode
  /** false = 只把证据留在仓库外（试错 run），true/缺省 = 复制进 selftest/evidence/runs。 */
  readonly syncEvidence?: boolean
}

/** 场景 id 与 mode 的映射（can-red 复用 j1：同一场景、同一组断言被破坏）。 */
export function scenarioIdOf(mode: JLogPanelMode): string {
  if (mode === 'noise-budget') return 'j2-noise-budget'
  if (mode === 'namespace-whitelist') return 'j3-namespace-whitelist'
  return 'j1-log-contract-coverage'
}

/** 单格用的席位（面板/电话都从属主 A 出发）。 */
const SLOT: FixtureSlotKey = 'a'
/** 面板轮询间隔（产品缺省 pollMs=5000；j2 用它换算窗口）。 */
const PANEL_POLL_MS = 5000
/** Playwright 目录（DSH_VERIFY_PLAYWRIGHT 优先；仓库外已装的 deck 依赖兜底）。 */
const PLAYWRIGHT_DIR = process.env['DSH_VERIFY_PLAYWRIGHT'] || 'D:/dsh-plugin/dsh-mattpocock-skills-deck/node_modules/playwright'
/** 安装作业终态。 */
const TERMINAL_JOB_STATES = ['completed', 'restart-required', 'failed', 'interrupted']
/** 批量行终态。 */
const TERMINAL_PHASES = ['done', 'failed', 'skipped', 'current']
/** 客户端经 logAppend 允许上浮的事件（src/log/client-queue.ts:105 CLIENT_LOG_EVENTS 的同一清单）。 */
const CLIENT_LOG_EVENTS = [
  'update.panel.mount',
  'update.panel.action',
  'update.panel.render.fail',
  'update.panel.state',
  'update.lang.applied',
  'update.log.degraded',
]
/** 日志行里允许出现的保留字段（发射口 stripReservedLogFields 剥掉的链字段）。 */
const RESERVED_FIELDS = ['traceId', 'spanId', 'seq']
/** 不在 update 事件清单里的宿主基础事件（本包不拥有、契约不管）。 */
const NON_CONTRACT_EVENTS = ['host.start']
/** 每命名空间行数预算（产品稳态约 50 行/天；一次真机 run 远低于该量级）。 */
const MAX_ROWS_PER_NAMESPACE = 500

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
  /** 相对 <home>/logs 的路径，例如 fxa-a/2026-11-03.log。 */
  readonly source: string
  /** 命名空间目录名（fxa-a 等）。 */
  readonly ns: string
  readonly line: number
}

interface LogInventory {
  readonly root: string
  readonly namespaces: string[]
  readonly files: string[]
  readonly rows: RawLogRow[]
  readonly parseFailures: { file: string; line: number; text: string }[]
}

interface PhoneResult {
  readonly phone: string
  readonly status: number
  readonly durationMs: number
  readonly body: unknown
  readonly inner: any
  readonly ok: boolean
  readonly error: string | null
}

interface JContext {
  readonly options: JLogPanelOptions
  readonly run: T3Run
  readonly slot: FixtureSlot
  readonly packageName: string
  readonly phonePrefix: string
  readonly batchPrefix: string
  readonly route: string
  readonly registryUrl: string
  readonly osHomeDir: string
  readonly homeDir: string
  readonly profileName: string
  readonly baselineVersion: string
  readonly variantVersion: string
  readonly hosts: HostEntry[]
  readonly uiSessions: { label: string; session: any }[]
  current: HostEntry | null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** sha256(text) 前 24 位十六进制：产品 shortHash（src/core/store-base.ts）。 */
function shortHashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 24)
}

function strOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function numOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function boolOf(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

async function oursafeReadText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function readJsonMaybe(path: string): Promise<any> {
  const text = await oursafeReadText(path)
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
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  } catch {
    return []
  }
}

/** 读 <home>/logs 下所有日志：保留解析失败行（「无解析失败行」是可证伪断言）。 */
async function readLogInventory(homeDir: string): Promise<LogInventory> {
  const root = join(homeDir, 'logs')
  const namespaces = await listDirs(root)
  const files: string[] = []
  const rows: RawLogRow[] = []
  const parseFailures: { file: string; line: number; text: string }[] = []
  let all: string[] = []
  try {
    all = await listFilesRecursive(root)
  } catch {
    all = []
  }
  for (const relative of all) {
    if (!relative.endsWith('.log')) continue
    files.push(relative)
    const segments = relative.split('/')
    const ns = segments.length > 1 ? segments[0] : ''
    const abs = join(root, relative.split('/').join('\\'))
    const text = (await oursafeReadText(abs)) ?? ''
    let line = 0
    for (const rawLine of text.split(/\r?\n/)) {
      line += 1
      if (!rawLine.trim()) continue
      try {
        const parsed = JSON.parse(rawLine)
        if (typeof parsed?.event !== 'string') {
          parseFailures.push({ file: relative, line, text: rawLine.slice(0, 300) })
          continue
        }
        rows.push({
          ts: numOf(parsed?.ts),
          event: parsed.event,
          level: strOf(parsed?.level),
          fields: parsed?.fields && typeof parsed.fields === 'object' ? parsed.fields : {},
          source: relative,
          ns,
          line,
        })
      } catch {
        parseFailures.push({ file: relative, line, text: rawLine.slice(0, 300) })
      }
    }
  }
  rows.sort((left, right) => (left.ts ?? 0) - (right.ts ?? 0))
  return { root, namespaces, files, rows, parseFailures }
}

function rowsOfEvent(rows: RawLogRow[], event: string): RawLogRow[] {
  return rows.filter((row) => row.event === event)
}

function rowsInNs(rows: RawLogRow[], ns: string): RawLogRow[] {
  return rows.filter((row) => row.ns === ns)
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

/** 电话双层信封：外层 ok=电话送达，业务受理/拒绝看 reply.ok。 */
async function callPhone(ctx: JContext, phone: string, args: Record<string, unknown> = {}): Promise<PhoneResult> {
  const started = Date.now()
  const result = await ctx.current!.host.postPhone(ctx.route, phone, args)
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
  }
}

/** 按插件筛 exec 行（route/ok/exitCode/durationMs 全带出）。 */
function execFacts(rows: RawLogRow[]): { ts: number | null; ns: string; pluginId: string | null; route: string | null; ok: boolean | null; exitCode: number | null; durationMs: number | null }[] {
  return rows
    .filter((row) => row.event === 'update.install.exec')
    .map((row) => ({
      ts: row.ts,
      ns: row.ns,
      pluginId: strOf(row.fields['pluginId']),
      route: strOf(row.fields['route']),
      ok: boolOf(row.fields['ok']),
      exitCode: numOf(row.fields['exitCode']),
      durationMs: numOf(row.fields['durationMs']),
    }))
}

/** 轮询到满足条件（超时返回最后一次读取结果，不抛）。 */
async function waitForRows(
  homeDir: string,
  predicate: (rows: RawLogRow[]) => boolean,
  timeoutMs: number,
  intervalMs = 500,
): Promise<{ rows: RawLogRow[]; matched: boolean; elapsedMs: number }> {
  const started = Date.now()
  let rows = await readRawLogRowsOnly(homeDir)
  while (Date.now() - started < timeoutMs) {
    if (predicate(rows)) return { rows, matched: true, elapsedMs: Date.now() - started }
    await sleep(intervalMs)
    rows = await readRawLogRowsOnly(homeDir)
  }
  return { rows, matched: predicate(rows), elapsedMs: Date.now() - started }
}

async function readRawLogRowsOnly(homeDir: string): Promise<RawLogRow[]> {
  return (await readLogInventory(homeDir)).rows
}

/** 等某几个插件各出现至少 minCount 条 exec 行。 */
async function waitForExecCount(
  homeDir: string,
  pluginIds: string[],
  minCount: number,
  timeoutMs: number,
): Promise<{ rows: RawLogRow[]; matched: boolean; elapsedMs: number }> {
  return waitForRows(
    homeDir,
    (rows) => {
      const facts = execFacts(rows)
      return pluginIds.every((pluginId) => facts.filter((item) => item.pluginId === pluginId).length >= minCount)
    },
    timeoutMs,
  )
}

/** 读 event-list.update.json（契约单一源，仓库根）。 */
async function loadEventList(worktree: string): Promise<{ path: string; manifest: any }> {
  const path = join(worktree, 'event-list.update.json')
  const manifest = await readJsonMaybe(path)
  if (manifest === null || typeof manifest !== 'object') throw new Error('[j] 读不到事件清单：' + path)
  return { path, manifest }
}

interface ContractReport {
  readonly checkedRows: number
  readonly unknownEvents: { event: string; count: number; ns: string[] }[]
  readonly levelMismatches: { event: string; level: string | null; expected: string; ns: string }[]
  readonly fieldViolations: { event: string; field: string; ns: string }[]
  readonly enumViolations: { event: string; field: string; value: unknown; allowed: string[]; ns: string }[]
}

/** 行 × 清单四关校验：事件名 / level / 字段名 / 枚举值。 */
function validateAgainstManifest(manifest: any, rows: RawLogRow[]): ContractReport {
  const events = manifest?.events && typeof manifest.events === 'object' ? (manifest.events as Record<string, any>) : {}
  const enums = manifest?.fieldEnums && typeof manifest.fieldEnums === 'object' ? (manifest.fieldEnums as Record<string, any>) : {}
  const unknownMap = new Map<string, { count: number; ns: Set<string> }>()
  const levelMismatches: ContractReport['levelMismatches'] = []
  const fieldViolations: ContractReport['fieldViolations'] = []
  const enumViolations: ContractReport['enumViolations'] = []
  let checkedRows = 0
  for (const row of rows) {
    if (NON_CONTRACT_EVENTS.indexOf(row.event) >= 0) continue
    const spec = events[row.event]
    if (!spec || typeof spec !== 'object') {
      const entry = unknownMap.get(row.event) ?? { count: 0, ns: new Set<string>() }
      entry.count += 1
      entry.ns.add(row.ns)
      unknownMap.set(row.event, entry)
      continue
    }
    checkedRows += 1
    if (typeof spec.level === 'string' && row.level !== spec.level) {
      levelMismatches.push({ event: row.event, level: row.level, expected: spec.level, ns: row.ns })
    }
    const declared = Array.isArray(spec.fields) ? spec.fields.map((item: unknown) => String(item)) : []
    for (const key of Object.keys(row.fields)) {
      if (RESERVED_FIELDS.indexOf(key) >= 0) continue
      if (declared.indexOf(key) < 0) fieldViolations.push({ event: row.event, field: key, ns: row.ns })
    }
    const eventEnums = enums[row.event] && typeof enums[row.event] === 'object' ? (enums[row.event] as Record<string, unknown>) : {}
    for (const [key, allowedRaw] of Object.entries(eventEnums)) {
      if (!Array.isArray(allowedRaw)) continue
      const value = row.fields[key]
      if (value === null || value === undefined) continue
      const allowed = allowedRaw.map((item) => String(item))
      if (allowed.indexOf(String(value)) < 0) enumViolations.push({ event: row.event, field: key, value, allowed, ns: row.ns })
    }
  }
  return {
    checkedRows,
    unknownEvents: Array.from(unknownMap.entries()).map(([event, entry]) => ({ event, count: entry.count, ns: Array.from(entry.ns).sort() })),
    levelMismatches,
    fieldViolations,
    enumViolations,
  }
}

// ---------------------------------------------------------------------------
// 共用：搭隔离世界（通道 B 宿主 + 非 desktop profile + 基版/变体发布）
// ---------------------------------------------------------------------------

interface ScenarioSetup {
  readonly run: T3Run
  readonly profileName: string
  readonly osHomeDir: string
  readonly homeDir: string
  readonly baselineVersion: string
  readonly variantVersion: string
}

/** 搭隔离世界：建 profile → 装基版 → 钉住 SUT → 发布变体。三步都在真机磁盘上留证。 */
async function setupScenario(options: JLogPanelOptions, scenarioId: string, profileName: string): Promise<JContext> {
  const run = await openT3Run({
    worktree: options.worktree,
    runBaseDir: options.runBaseDir,
    verdaccioInstallDir: options.verdaccioInstallDir,
    esbuildPath: options.esbuildPath,
    scenarioId,
    hostChannel: 'dsh-web',
    stamp: options.stamp,
    maintainerHome: options.maintainerHome,
    ticket: '273',
  })
  const fixtureEnv = run.fixtureEnv
  if (fixtureEnv === null) throw new Error('[j] fixtureEnv 未初始化（真机夹具环境缺失）')
  const registryUrl = fixtureEnv.registry.baseUrl
  const slot = fixtureSlotOf(SLOT)
  const packageName = slot.packageName
  const phonePrefix = slot.selfTargetPrefix
  if (phonePrefix === null) throw new Error('[j] 夹具席位 A 缺单插件电话前缀')
  const batchPrefix = slot.batch !== null ? slot.batch.prefix : null
  if (batchPrefix === null) throw new Error('[j] 夹具席位 A 缺批量接线前缀')
  const route = fixtureBridgeRouteOf(slot)
  const baselineStep = run.scenario.install.find((step) => step.slotKey === SLOT)
  if (!baselineStep) throw new Error('[j] 场景声明缺席位 A 的基版')
  const variantVersion = variantVersionOf(run.scenario, SLOT)
  if (!variantVersion) throw new Error('[j] 场景声明缺席位 A 的变体版本')

  const osHomeDir = join(run.layout.root, 'os-home')
  const homeDir = join(osHomeDir, '.dsh')
  await ensureDir(osHomeDir)
  await ensureDir(homeDir)

  const ctx: JContext = {
    options,
    run,
    slot,
    packageName,
    phonePrefix,
    batchPrefix,
    route,
    registryUrl,
    osHomeDir,
    homeDir,
    profileName,
    baselineVersion: baselineStep.version,
    variantVersion,
    hosts: [],
    uiSessions: [],
    current: null,
  }

  // ---- 1. 隔离口径（通道 B）----
  await run.raw('isolation-facts', {
    hostChannel: 'dsh-web',
    osHomeDir,
    homeDir,
    profileName,
    profileDir: join(homeDir, 'profiles', profileName),
    route,
    phones: { phonePrefix, batchPrefix },
    logsRoot: join(homeDir, 'logs'),
    why:
      '通道 B 宿主是普通 DSH web 进程：spawn 的 CLI 子进程会剥掉 DSH_* 并按 USERPROFILE 解析 homedir()/.dsh，' +
      '所以 homeDir 必须正好是 USERPROFILE/.dsh；profile 名不能用 desktop（官方桌面独占）。',
  })
  await run.record({
    step: '隔离口径（通道 B：普通 DSH web 宿主 + 非 desktop profile）',
    what: '每个 run 一个仓库外 home；日志根 = <home>/logs（产品自建落点），命名空间目录按插件身份派生',
    expected: 'homeDir=' + join(osHomeDir, '.dsh') + '；profile=' + profileName,
    actual: 'osHomeDir=' + osHomeDir + '；homeDir=' + homeDir + '；profile=' + profileName,
    verdict: homeDir === join(osHomeDir, '.dsh') ? 'pass' : 'fail',
  })

  // ---- 2. 建普通 profile ----
  const profile = await createWebProfileInHome({ homeDir, profileName })
  await run.raw('profile-create', { exitCode: profile.create.exitCode, stdout: profile.create.stdout, stderr: profile.create.stderr, profileDir: profile.profileDir })
  await run.record({
    step: '建普通 profile（通道 B 宿主的使用范围）',
    what: '用官方发行 CLI 在隔离 home 建普通 DSH 使用范围 ' + profileName,
    expected: 'exit=0；profileDir=' + join(homeDir, 'profiles', profileName),
    actual: 'exit=' + String(profile.create.exitCode) + '；profileDir=' + profile.profileDir,
    verdict: profile.create.exitCode === 0 ? 'pass' : 'fail',
  })

  // ---- 3. 装基版 + SUT 钉住 ----
  await run.installBaseline({ homeDir, profileName, registryUrl })
  await verifySutInstalled(run, { homeDir, profileName, packageName })
  const baseDisk = await installedFixtureVersion({ homeDir, profileName, packageName })
  await run.raw('baseline-disk', { packageName, expected: baselineStep.version, actual: baseDisk })
  await run.record({
    step: '更新前基版在盘',
    what: '隔离 profile 里装着场景声明的基版 ' + baselineStep.version + '（日志命名空间随后由它派生）',
    expected: 'node_modules/' + packageName + ' 版本=' + baselineStep.version,
    actual: '磁盘版本=' + String(baseDisk),
    verdict: baseDisk === baselineStep.version ? 'pass' : 'fail',
  })

  // ---- 4. 发布基版缓存 + 变体（更新目标）----
  const baselinePublication = await run.publishBaseline()
  const publication = await publishScenarioVariants(run.scenario, fixtureEnv, undefined, baselinePublication)
  const publishedVariant = publication.variants[SLOT]
  if (!publishedVariant) throw new Error('[j] 变体发布失败：' + SLOT)
  await run.raw('fixture-published-variants', {
    baseline: baselineStep.version,
    variant: variantVersion,
    variantSpec: fixtureSpecOf(publishedVariant),
    variants: Object.keys(publication.variants),
    injected: publication.injected,
  })
  await run.record({
    step: '变体版本已发布（更新目标）',
    what: '本地 verdaccio 发布 ' + packageName + '@' + variantVersion + '；其余席位按场景声明一并发布',
    expected: fixtureSpecOf(publishedVariant) + '；variants=' + JSON.stringify(Object.keys(publication.variants)),
    actual: fixtureSpecOf(publishedVariant) + '；injected=' + JSON.stringify(publication.injected),
    verdict: 'pass',
  })

  return ctx
}

// ---------------------------------------------------------------------------
// 共用：宿主生命周期
// ---------------------------------------------------------------------------

async function startHost(ctx: JContext, label: string, extraEnv?: Record<string, string>): Promise<CliHostSession> {
  const host = await startCliHost({
    homeDir: ctx.homeDir,
    osHomeDir: ctx.osHomeDir,
    profileName: ctx.profileName,
    extraEnv: { [FIXTURE_REGISTRY_ENV]: ctx.registryUrl, ...(extraEnv ?? {}) },
    bootTimeoutMs: 90000,
  })
  const entry: HostEntry = { label, host, pid: host.pid() ?? null, port: host.port, closed: false }
  ctx.hosts.push(entry)
  ctx.current = entry
  await ctx.run.raw('cli-host-launch-' + label, {
    url: host.url,
    port: host.port,
    bootMs: host.bootMs,
    profileName: host.profileName,
    homeDir: ctx.homeDir,
    pid: entry.pid,
    stdoutTail: host.stdout().slice(-3000),
    stderrTail: host.stderr().slice(-3000),
  })
  return host
}

async function closeCurrentHost(ctx: JContext, tag: string): Promise<void> {
  const entry = ctx.current
  if (entry === null) return
  ctx.current = null
  entry.closed = true
  await entry.host.close().catch(() => undefined)
  ctx.run.registerProcess('cli-host-' + entry.label, entry.pid)
  await ctx.run.registerPort('cli-host-' + entry.label + '-port', entry.port)
  await ctx.run.raw('cli-host-close-' + tag, {
    label: entry.label,
    pid: entry.pid,
    port: entry.port,
    pidAlive: entry.pid === null ? null : isProcessAlive(entry.pid),
  })
}

async function closeAllPanels(ctx: JContext): Promise<void> {
  for (const item of ctx.uiSessions.splice(0)) {
    await item.session.close().catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// 共用：真 UI（Playwright）面板驱动
// ---------------------------------------------------------------------------

interface PanelSnapshot {
  readonly counts: { dshUpd: number; dshUpdLog: number; fixture: number }
  readonly logTexts: string[]
  readonly panelText: string
  readonly bodyLen: number
}

const PANEL_COUNTS_SCRIPT = `(() => {
  const q = (s) => document.querySelectorAll(s).length
  const logTexts = []
  document.querySelectorAll('.dsh-upd-log').forEach((el) => { logTexts.push(((el && el.innerText) || '').trim().replace(/\\s+/g, ' ')) })
  const panel = document.querySelector('.dsh-upd')
  const panelText = panel ? ((panel.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 6000)) : ''
  return {
    counts: { dshUpd: q('.dsh-upd'), dshUpdLog: q('.dsh-upd-log'), fixture: q('[data-fixture]') },
    logTexts,
    panelText,
    bodyLen: document.body ? document.body.innerText.length : 0,
  }
})()`

async function panelSnapshot(page: any): Promise<PanelSnapshot> {
  const value = await page.evaluate(PANEL_COUNTS_SCRIPT)
  return {
    counts: value?.counts ?? { dshUpd: 0, dshUpdLog: 0, fixture: 0 },
    logTexts: Array.isArray(value?.logTexts) ? value.logTexts : [],
    panelText: typeof value?.panelText === 'string' ? value.panelText : '',
    bodyLen: typeof value?.bodyLen === 'number' ? value.bodyLen : 0,
  }
}

/** 关掉首启的预览版说明（「继续」按钮）的页面脚本；关不到不算失败（页面可能没有该浮层）。 */
const DISMISS_WELCOME_SCRIPT = `(() => {
  const buttons = Array.from(document.querySelectorAll('button'))
  const target = buttons.find((button) => ((button.innerText || '').trim() === '继续'))
  if (target) {
    target.click()
    return true
  }
  return false
})()`

async function dismissWelcome(page: any): Promise<boolean> {
  try {
    return await page.evaluate(DISMISS_WELCOME_SCRIPT)
  } catch {
    return false
  }
}

/** 等面板真挂载（.dsh-upd 与 .dsh-upd-log 都出现）。 */
async function waitPanelMounted(page: any, timeoutMs: number): Promise<{ mounted: boolean; snapshot: PanelSnapshot; elapsedMs: number }> {
  const started = Date.now()
  let snapshot = await panelSnapshot(page)
  while (Date.now() - started < timeoutMs) {
    if (snapshot.counts.dshUpd >= 1) return { mounted: true, snapshot, elapsedMs: Date.now() - started }
    await sleep(500)
    snapshot = await panelSnapshot(page)
  }
  return { mounted: false, snapshot, elapsedMs: Date.now() - started }
}

interface PanelSession {
  readonly label: string
  readonly page: any
  /** 页面发出的 updateStatus 轮询请求（时间戳 + 原始 body 片段）。 */
  readonly statusRequests: { t: number; body: string }[]
}

/** 打开真 UI 页面（= 面板真在轮询），并等面板挂载。 */
async function openPanel(ctx: JContext, label: string): Promise<PanelSession> {
  const ui = await openAuthenticatedPage(ctx.current!.host.url, { playwrightDir: PLAYWRIGHT_DIR, headless: true, timeoutMs: 60000 })
  if (!ui.ok) throw new Error('[j] 打不开真 UI（' + label + '）：' + JSON.stringify(ui.problems))
  const session: any = ui.session
  ctx.uiSessions.push({ label, session })
  const page: any = session.page
  const statusRequests: { t: number; body: string }[] = []
  page.on('request', (request: any) => {
    let data = ''
    try {
      data = request.postData() || ''
    } catch {
      data = ''
    }
    if (data.indexOf('updateStatus') >= 0) statusRequests.push({ t: Date.now(), body: data.slice(0, 240) })
  })
  await sleep(1500)
  await dismissWelcome(page)
  const mounted = await waitPanelMounted(page, 60000)
  await ctx.run.raw('panel-open-' + label, {
    url: session.url,
    mounted: mounted.mounted,
    elapsedMs: mounted.elapsedMs,
    counts: mounted.snapshot.counts,
    logTexts: mounted.snapshot.logTexts,
    panelText: mounted.snapshot.panelText.slice(0, 4000),
  })
  await ctx.run.record({
    step: '真 UI 面板挂载（' + label + '）',
    what: 'Playwright 打开 web 宿主页面：夹具卡片与更新面板真出现，面板开始轮询 updateStatus',
    expected: '.dsh-upd≥1；[data-fixture]≥1；面板开始轮询 updateStatus',
    actual: 'counts=' + JSON.stringify(mounted.snapshot.counts) + '；elapsedMs=' + String(mounted.elapsedMs),
    verdict: mounted.snapshot.counts.dshUpd >= 1 && mounted.snapshot.counts.fixture >= 1 ? 'pass' : 'fail',
    note: '日志健康卡（.dsh-upd-log）只在面板 04 诊断章节（失败/待重启/可更新等横幅状态）渲染；j3 单独断言该卡，j1 批量后页面不强制。',
  })
  return { label, page, statusRequests }
}

/** 在真页面上按中文文案点面板按钮（返回实际点到的文本与候选清单，点不到不抛）。 */
function clickButtonScript(needles: string[]): string {
  return `((wanted) => {
    const elements = Array.from(document.querySelectorAll('button,[role="button"],a'))
    const candidates = []
    for (const element of elements) {
      const text = ((element.innerText || '').trim().replace(/\\s+/g, ' '))
      if (!text) continue
      if (candidates.length < 40) candidates.push(text.slice(0, 40))
      if (wanted.some((needle) => text.indexOf(needle) >= 0)) {
        element.click()
        return { clicked: true, text: text.slice(0, 80), candidates }
      }
    }
    return { clicked: false, text: null, candidates }
  })(${JSON.stringify(needles)})`
}

async function clickPanelButtonByText(page: any, needles: string[]): Promise<{ clicked: boolean; text: string | null; candidates: string[] }> {
  try {
    const value = await page.evaluate(clickButtonScript(needles))
    return {
      clicked: value?.clicked === true,
      text: typeof value?.text === 'string' ? value.text : null,
      candidates: Array.isArray(value?.candidates) ? value.candidates : [],
    }
  } catch (error) {
    return { clicked: false, text: null, candidates: ['[evaluate 失败] ' + messageOf(error)] }
  }
}

/** 截图：png 字节交给 evidence 层登记（run.json shots[] 必须有编号，sidecar 六字段由 evidence 层写）。 */
async function takeShot(
  ctx: JContext,
  page: any,
  name: string,
  meta: { what: string; steps: string; expected: string; actual: string; verdict: 'pass' | 'fail' | 'known-red' | 'unknown'; note?: string },
): Promise<any> {
  const bytes: Uint8Array = await page.screenshot({ fullPage: false })
  if (!bytes || bytes.length === 0) throw new Error('[j-log-panel] 截图字节为空：' + name)
  return ctx.run.recorder.shot(name, bytes, {
    what: meta.what,
    step: meta.steps,
    expected: meta.expected,
    actual: meta.actual,
    verdict: meta.verdict,
    note: meta.note,
  })
}

// ---------------------------------------------------------------------------
// 共用：批量电话（fxa.batchStatus 轮询）
// ---------------------------------------------------------------------------

interface BatchPoll {
  readonly snapshots: any[]
  readonly last: PhoneResult | null
  readonly timedOut: boolean
  readonly elapsedMs: number
}

function batchEntriesOf(result: PhoneResult | null): any[] {
  const session = result?.inner?.session ?? null
  return session && Array.isArray(session.entries) ? session.entries : []
}

function batchPhasesOf(result: PhoneResult | null): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const entry of batchEntriesOf(result)) {
    if (entry && typeof entry.key === 'string') out[entry.key] = typeof entry.phase === 'string' ? entry.phase : null
  }
  return out
}

/** 轮询 batchStatus 到所有行落定（终态含 done/failed/skipped/current）。 */
async function pollBatchTerminal(ctx: JContext, timeoutMs: number, intervalMs = 1500): Promise<BatchPoll> {
  const started = Date.now()
  const snapshots: any[] = []
  let last: PhoneResult | null = null
  for (;;) {
    last = await callPhone(ctx, ctx.batchPrefix + '.batchStatus', {})
    const entries = batchEntriesOf(last)
    const rows: any[] = Array.isArray(last.inner?.rows) ? last.inner.rows : []
    snapshots.push({
      t: Date.now(),
      entries: entries.map((entry: any) => ({
        key: entry?.key ?? null,
        phase: entry?.phase ?? null,
        targetVersion: entry?.targetVersion ?? null,
        error: entry?.error ?? null,
      })),
      rows: rows.map((row: any) => ({
        key: row?.key ?? null,
        phase: row?.phase ?? null,
        latestVersion: row?.snapshot?.latestVersion ?? null,
        runningVersion: row?.snapshot?.runningVersion ?? null,
        installedVersion: row?.snapshot?.installedVersion ?? null,
      })),
    })
    if (snapshots.length > 600) snapshots.shift()
    if (entries.length > 0 && entries.every((entry: any) => TERMINAL_PHASES.indexOf(entry?.phase) >= 0)) {
      return { snapshots, last, timedOut: false, elapsedMs: Date.now() - started }
    }
    if (Date.now() - started >= timeoutMs) return { snapshots, last, timedOut: true, elapsedMs: Date.now() - started }
    await sleep(intervalMs)
  }
}

// ---------------------------------------------------------------------------
// J1：日志事件契约覆盖（真安装 + 真批量失败 → 磁盘日志逐行对契约）
// ---------------------------------------------------------------------------

/** j1 必备的常驻事件覆盖集（宿主侧真实会发、本格流程必然触发的那些）。 */
const J1_REQUIRED_EVENTS = [
  'update.wire.ready',
  'update.check.done',
  'update.status.changed',
  'update.install.request',
  'update.install.exec',
  'update.install.verify',
  'update.install.fail',
  'update.batch.run.start',
  'update.batch.entry.request',
  'update.batch.entry.fail',
  'update.batch.summary',
]

/** j1 期望零行的噪声/失败面（本格流程不应触发；触发即红，说明事件面失控或流程跑偏）。 */
const J1_ZERO_EVENTS = [
  'update.log.degraded',
  'update.panel.render.fail',
  'update.store.fail',
  'update.check.fail',
  'update.panel.mount',
  'update.panel.action',
]

/** j1 期望的日志命名空间：由夹具批量接线派生（A 集成方 fxa-a/fxa-b/fxa-c；B 集成方 fxb-b/fxb-c）。 */
function expectedLogNamespaces(): string[] {
  const out = new Set<string>()
  for (const slotKey of ['a', 'b', 'c'] as FixtureSlotKey[]) {
    const slot = fixtureSlotOf(slotKey)
    if (slot.batch === null) continue
    for (const target of slot.batch.targets) out.add(target.prefix)
  }
  return Array.from(out).sort()
}

/** 轮询 batchStatus 直到指定行落定（只推一行时用：不必等别的行）。 */
async function pollBatchEntryTerminal(ctx: JContext, key: string, timeoutMs: number, intervalMs = 1500): Promise<BatchPoll> {
  const started = Date.now()
  const snapshots: any[] = []
  let last: PhoneResult | null = null
  for (;;) {
    last = await callPhone(ctx, ctx.batchPrefix + '.batchStatus', {})
    const entries = batchEntriesOf(last)
    const entry: any = entries.find((item: any) => item && item.key === key) ?? null
    snapshots.push({
      t: Date.now(),
      entry: entry === null ? null : { key: entry.key, phase: entry.phase, targetVersion: entry.targetVersion, error: entry.error },
    })
    if (snapshots.length > 600) snapshots.shift()
    if (entry !== null && TERMINAL_PHASES.indexOf(String(entry.phase)) >= 0) {
      return { snapshots, last, timedOut: false, elapsedMs: Date.now() - started }
    }
    if (Date.now() - started >= timeoutMs) return { snapshots, last, timedOut: true, elapsedMs: Date.now() - started }
    await sleep(intervalMs)
  }
}

/** j1 故障注入的安装预算（ms）：DSH_SELFTEST_INSTALL_TIMEOUT_MS 经夹具 host half → executor 安装预算。 */
const J1_INSTALL_TIMEOUT_MS = 6000
/** 注入锁持有时长（秒）：覆盖安装窗口 + 断言时间。 */
const J1_LOCK_HOLD_SECONDS = 180

/** 持锁进程句柄（场景结束必须杀）。 */
interface FileLock {
  readonly proc: ReturnType<typeof spawn> | null
  readonly pid: number | null
  readonly scriptPath: string
  readonly markerPath: string
  readonly targetPath: string
}

/** 同步跑一个短命令（判断独占打开 / 杀进程用）。 */
function runCommandSync(command: string, args: string[]): { exitCode: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { windowsHide: true })
  return { exitCode: result.status ?? null, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') }
}

/** 用 PowerShell 对目标文件持有 FileShare.Read 独占锁（允许读、拒绝写/删），写 marker 表示已上锁。 */
async function acquireFileLock(options: { run: T3Run; workDir: string; targetPath: string; tag: string }): Promise<FileLock> {
  const scriptPath = join(options.workDir, 'lock-' + options.tag + '.ps1')
  const markerPath = join(options.workDir, 'lock-' + options.tag + '.marker')
  const escapedTarget = options.targetPath.replace(/'/g, "''")
  const escapedMarker = markerPath.replace(/'/g, "''")
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$path = '" + escapedTarget + "'",
    "$marker = '" + escapedMarker + "'",
    "$fs = [System.IO.File]::Open($path, 'Open', 'Read', 'Read')",
    "Set-Content -Path $marker -Value ('locked pid=' + $PID) -NoNewline",
    "Start-Sleep -Seconds " + String(J1_LOCK_HOLD_SECONDS),
    "$fs.Dispose()",
  ].join('\n')
  await writeFile(scriptPath, script)
  const proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { windowsHide: true, stdio: 'ignore' })
  const pid = proc.pid ?? null
  if (pid !== null) options.run.registerProcess('file-lock-' + options.tag, pid)
  const started = Date.now()
  for (;;) {
    try {
      const markerText = await readFile(markerPath, 'utf8')
      if (markerText.length > 0) break
    } catch {
      // marker 还没出现，继续等
    }
    if (Date.now() - started >= 20000) throw new Error('[j1] 文件锁 marker 未在 20s 内出现：' + markerPath)
    await sleep(200)
  }
  return { proc, pid, scriptPath, markerPath, targetPath: options.targetPath }
}

/** 第二个进程尝试独占打开：打不开（exit 3）= 锁生效。 */
function probeExclusiveOpen(targetPath: string): { exitCode: number | null; stdout: string; stderr: string } {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    "  $fs = [System.IO.File]::Open('" + targetPath.replace(/'/g, "''") + "', 'Open', 'ReadWrite', 'None')",
    '  $fs.Dispose()',
    '  exit 0',
    '} catch {',
    '  exit 3',
    '}',
  ].join('\n')
  return runCommandSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script])
}

/** 杀掉持锁进程（kill + taskkill /T /F 兜底），返回是否仍存活。 */
async function releaseFileLock(run: T3Run, lock: FileLock): Promise<{ killed: boolean; aliveAfter: boolean }> {
  let killed = false
  try {
    if (lock.proc !== null) {
      lock.proc.kill()
      killed = true
    }
  } catch {
    killed = false
  }
  if (lock.pid !== null) runCommandSync('taskkill.exe', ['/PID', String(lock.pid), '/T', '/F'])
  await sleep(1000)
  const aliveAfter = lock.pid !== null ? isProcessAlive(lock.pid) : false
  await run.raw('file-lock-release', { pid: lock.pid, killed, aliveAfter, targetPath: lock.targetPath })
  return { killed, aliveAfter }
}
async function runContractCoverage(ctx: JContext): Promise<void> {
  const run = ctx.run
  const fixtureEnv = run.fixtureEnv
  if (fixtureEnv === null) throw new Error('[j1] fixtureEnv 未初始化')
  const slotB = fixtureSlotOf('b')
  const packageB = slotB.packageName
  const batchTargetPrefixB = ctx.slot.batch !== null ? (ctx.slot.batch.targets.find((target) => target.key === 'b') ?? null)?.prefix ?? null : null
  if (batchTargetPrefixB === null) throw new Error('[j1] 夹具 A 的批量接线缺 B 目标')

  // ---- 1. 起通道 B 宿主（安装预算压到 6s：锁陈旧阈值/执行预算同源，超时格要用短预算）----
  await startHost(ctx, 'main', { DSH_SELFTEST_INSTALL_TIMEOUT_MS: String(J1_INSTALL_TIMEOUT_MS) })

  // ---- 2. 单包更新 A：真 check → 真 install → 等 exec 行 ----
  const check = await callPhone(ctx, ctx.phonePrefix + '.updateCheck', { trigger: 'user' })
  const receipt = check.inner?.receipt ?? null
  const checkId = strOf(receipt?.checkId) ?? ''
  await run.raw('phone-check-single', { status: check.status, durationMs: check.durationMs, body: check.body })
  await run.record({
    step: '单包入口 check 发现 ' + ctx.variantVersion,
    what: '真电话 ' + ctx.phonePrefix + '.updateCheck：返回快照与候选凭证 checkId',
    expected: 'ok=true；latestVersion=' + ctx.variantVersion + '；canInstall=true；checkId 非空',
    actual: 'ok=' + String(check.ok) + '；latestVersion=' + String(check.inner?.snapshot?.latestVersion ?? null) + '；canInstall=' + String(check.inner?.snapshot?.canInstall ?? null) + '；checkId=' + JSON.stringify(checkId),
    verdict: check.ok && check.inner?.snapshot?.latestVersion === ctx.variantVersion && check.inner?.snapshot?.canInstall === true && checkId !== '' ? 'pass' : 'fail',
  })

  const requestId = 'j1-single-' + String(Date.now())
  const install = await callPhone(ctx, ctx.phonePrefix + '.updateInstall', { checkId, requestId, from: 'panel' })
  const replyJobState = strOf(install.inner?.snapshot?.job?.state)
  await run.raw('phone-install-single', { checkId, requestId, status: install.status, durationMs: install.durationMs, body: install.body })
  await run.record({
    step: '单包安装被受理（快照=安装中，不是终态）',
    what: '产品 install() 先 saveJob(installing) 再返回受理快照（src/core/service.ts:1027-1120）',
    expected: 'ok=true；job.state ∈ {installing, verifying}',
    actual: 'ok=' + String(install.ok) + '；job.state=' + String(replyJobState) + '；blockedReason=' + String(install.inner?.snapshot?.blockedReason ?? null),
    verdict: install.ok && (replyJobState === 'installing' || replyJobState === 'verifying') ? 'pass' : 'fail',
  })

  // exec 行的 pluginId 是「目标电话前缀」（fxa-a），不是包名——v1 试错踩过这个坑。
  const singleExec = await waitForExecCount(ctx.homeDir, [ctx.phonePrefix], 1, 180000)
  const execA = execFacts(singleExec.rows).filter((item) => item.pluginId === ctx.phonePrefix)
  const execASingle = execA.length === 1 ? execA[0] : null
  await run.raw('exec-rows-single', { matched: singleExec.matched, elapsedMs: singleExec.elapsedMs, exec: execA })
  await run.record({
    step: '单包安装恰一次真实执行（route=cli-process / ok=true / exit=0）',
    what: '日志 update.install.exec 行即安装窗口事实（比 UI 可靠）；pluginId=目标电话前缀 ' + ctx.phonePrefix,
    expected: 'exec 行数=1；route=cli-process；ok=true；exitCode=0；durationMs>0；ns=' + ctx.phonePrefix,
    actual: JSON.stringify(execA),
    verdict:
      execASingle !== null && execASingle.route === 'cli-process' && execASingle.ok === true && execASingle.exitCode === 0 && (execASingle.durationMs ?? 0) > 0 && execASingle.ns === execASingle.pluginId
        ? 'pass'
        : 'fail',
  })

  await sleep(1200)
  const singleInventory = await readLogInventory(ctx.homeDir)
  const verifyRows = rowsOfEvent(singleInventory.rows, 'update.install.verify').filter((row) => row.ns === ctx.phonePrefix)
  const verifySingle = verifyRows.length > 0 ? verifyRows[verifyRows.length - 1] : null
  await run.raw('verify-rows-single', verifyRows.map((row) => ({ ts: row.ts, ns: row.ns, fields: row.fields })))
  await run.record({
    step: '安装瞬间的 verify 行说真话（restart-required / pendingRestart=true）',
    what: '通道 B 不热换：装好后到重启前，verify 行结果是 restart-required 且 pendingRestart=true',
    expected: 'result=restart-required；pendingRestart=true；installedVersion=' + ctx.variantVersion,
    actual: 'result=' + String(verifySingle?.fields['result'] ?? null) + '；pendingRestart=' + String(verifySingle?.fields['pendingRestart'] ?? null) + '；installedVersion=' + String(verifySingle?.fields['installedVersion'] ?? null),
    verdict: verifySingle !== null && verifySingle.fields['result'] === 'restart-required' && verifySingle.fields['pendingRestart'] === true && verifySingle.fields['installedVersion'] === ctx.variantVersion ? 'pass' : 'fail',
    note: '单包 A 从 ' + ctx.baselineVersion + ' → ' + ctx.variantVersion + '；通道 A 是 in-process 热换，通道 B 要重启才生效，这条 verify 行是两种通道的共同真话。',
  })

  // ---- 3. 故障注入：对已装 B 的 lib/index.js 持 FileShare.Read 独占锁（remove 必被拖住）----
  const lockedTarget = join(ctx.homeDir, 'profiles', ctx.profileName, 'node_modules', packageB, 'lib', 'index.js')
  const lockWorkDir = join(run.layout.root, 'j1-work')
  await ensureDir(lockWorkDir)
  const lock = await acquireFileLock({ run, workDir: lockWorkDir, targetPath: lockedTarget, tag: 'b' })
  const exclusiveProbe = probeExclusiveOpen(lockedTarget)
  await run.raw('file-lock-acquired', {
    targetPath: lockedTarget,
    lockPid: lock.pid,
    probeExitCode: exclusiveProbe.exitCode,
    probeStderr: exclusiveProbe.stderr.slice(0, 500),
    installTimeoutMs: J1_INSTALL_TIMEOUT_MS,
    holdSeconds: J1_LOCK_HOLD_SECONDS,
  })
  await run.record({
    step: '故障注入：B 的已装文件被独占锁拖住（remove 被拖住 → 安装预算 6s 耗尽）',
    what: 'PowerShell 对 profile/node_modules/' + packageB + '/lib/index.js 持 FileShare.Read 独占句柄；宿主以 DSH_SELFTEST_INSTALL_TIMEOUT_MS=' + String(J1_INSTALL_TIMEOUT_MS) + ' 启动（夹具 installTimeoutMs → 执行器安装预算）',
    expected: '锁 marker 出现；第二个进程独占打开失败（probeExitCode=3）',
    actual: 'lockPid=' + String(lock.pid) + '；probeExitCode=' + String(exclusiveProbe.exitCode),
    verdict: exclusiveProbe.exitCode === 3 ? 'pass' : 'fail',
  })

  // ---- 4. 批量 check：注入不改 registry，候选门照常能过 ----
  const batchCheck = await callPhone(ctx, ctx.batchPrefix + '.batchCheck', {})
  const checkRows: any[] = Array.isArray(batchCheck.inner?.rows) ? batchCheck.inner.rows : []
  const bCheck: any = checkRows.find((row: any) => row && row.key === 'b') ?? null
  await run.raw('phone-batch-check', { status: batchCheck.status, durationMs: batchCheck.durationMs, body: batchCheck.body })
  await run.record({
    step: '批量 check 仍能列出 B@' + ctx.variantVersion + '（注入只锁已装文件，不动 registry）',
    what: '真电话 ' + ctx.batchPrefix + '.batchCheck：B 行 canInstall=true，候选门能过',
    expected: 'b.canInstall=true；b.latestVersion=' + ctx.variantVersion,
    actual: 'b=' + JSON.stringify({ canInstall: bCheck?.snapshot?.canInstall ?? null, latestVersion: bCheck?.snapshot?.latestVersion ?? null }),
    verdict: bCheck !== null && bCheck.snapshot?.canInstall === true && bCheck.snapshot?.latestVersion === ctx.variantVersion ? 'pass' : 'fail',
  })

  // ---- 5. 批量 install 整轮（b 的 remove 被锁拖住 → 超时；其余行照批量语义推进）----
  const batchInstall = await callPhone(ctx, ctx.batchPrefix + '.batchInstall', {})
  await run.raw('phone-batch-install-all', { status: batchInstall.status, durationMs: batchInstall.durationMs, body: batchInstall.body })
  await run.record({
    step: '批量安装整轮（b 的 remove 被锁拖住 → 超时；批量驱动串行推进所有行直到收尾）',
    what: '真电话 ' + ctx.batchPrefix + '.batchInstall {}；批量驱动按会话顺序串行推进，b 在 remove 阶段撞上独占锁',
    expected: '电话送达（status=200）；回包 ok=true 或明确忙（update-busy）',
    actual: 'status=' + String(batchInstall.status) + '；ok=' + String(batchInstall.ok) + '；error=' + JSON.stringify(batchInstall.error),
    verdict: batchInstall.status === 200 ? 'pass' : 'fail',
  })

  const firstRun = await pollBatchEntryTerminal(ctx, 'b', 240000)
  const firstPhases = batchPhasesOf(firstRun.last)
  await run.raw('batch-b-timeline', { timedOut: firstRun.timedOut, elapsedMs: firstRun.elapsedMs, phases: firstPhases, snapshots: firstRun.snapshots.slice(-60) })
  await run.record({
    step: 'B 行落定为 failed（remove 超时真失败，不伪装成功）',
    what: '批量行 phase 以 batchStatus 会话为准；B 应 failed，别的行不被这一行拖进安装',
    expected: 'timedOut=false；b.phase=failed',
    actual: 'phases=' + JSON.stringify(firstPhases) + '；timedOut=' + String(firstRun.timedOut),
    verdict: firstRun.timedOut === false && firstPhases['b'] === 'failed' ? 'pass' : 'fail',
  })

  // ---- 6. 失败事件面：等 exec 行落盘后再断言（防 host.close 前批量队列未 flush）----
  const failWait = await waitForRows(
    ctx.homeDir,
    (rows) => execFacts(rows).some((item) => item.pluginId === batchTargetPrefixB && item.ok === false),
    180000,
  )
  await sleep(1200)
  const failInventory = await readLogInventory(ctx.homeDir)
  const bExecFail = execFacts(failInventory.rows).filter((item) => item.pluginId === batchTargetPrefixB && item.ok === false)
  const bFailRows = rowsOfEvent(failInventory.rows, 'update.install.fail').filter((row) => row.ns === batchTargetPrefixB)
  const bFailExecRow = bFailRows.find((row) => row.fields['stage'] === 'exec') ?? null
  const bVerifyRows = rowsOfEvent(failInventory.rows, 'update.install.verify').filter((row) => row.ns === batchTargetPrefixB)
  const bVerifyFail = bVerifyRows.length > 0 ? bVerifyRows[bVerifyRows.length - 1] : null
  await run.raw('batch-b-failure', {
    exec: bExecFail,
    installFailRows: bFailRows.map((row) => ({ ts: row.ts, ns: row.ns, fields: row.fields })),
    verifyRows: bVerifyRows.map((row) => ({ ts: row.ts, ns: row.ns, fields: row.fields })),
    matched: failWait.matched,
    elapsedMs: failWait.elapsedMs,
  })
  const timeoutExitOk = bExecFail.length === 1 && (bExecFail[0].exitCode === null || bExecFail[0].exitCode !== 0)
  const timeoutDurationOk = bExecFail.length === 1 && bExecFail[0].durationMs !== null && bExecFail[0].durationMs >= J1_INSTALL_TIMEOUT_MS - 1500
  await run.record({
    step: 'B 的失败是「执行失败」事件面：exec ok=false（安装预算超时）+ install.fail stage=exec reason=timeout + verify failed',
    what: 'remove 被独占锁拖住，执行器在安装预算耗尽后判失败（不是 check 拒绝、不是静默跳过）；exec 行 pluginId=批量目标前缀 ' + batchTargetPrefixB,
    expected: 'B exec 失败恰 1；route=cli-process；durationMs≈' + String(J1_INSTALL_TIMEOUT_MS) + '；exitCode=null 或非 0；install.fail.stage=exec reason=timeout code=install-failed；verify.result=failed',
    actual: 'bExecFail=' + JSON.stringify(bExecFail) + '；bFail.stage=' + String(bFailExecRow?.fields['stage'] ?? null) + '；bFail.reason=' + String(bFailExecRow?.fields['reason'] ?? null) + '；bFail.code=' + String(bFailExecRow?.fields['code'] ?? null) + '；bVerify.result=' + String(bVerifyFail?.fields['result'] ?? null),
    verdict:
      bExecFail.length === 1 &&
      bExecFail[0].route === 'cli-process' &&
      timeoutExitOk &&
      timeoutDurationOk &&
      bFailExecRow !== null &&
      bFailExecRow.fields['reason'] === 'timeout' &&
      bFailExecRow.fields['code'] === 'install-failed' &&
      bVerifyFail !== null &&
      bVerifyFail.fields['result'] === 'failed'
        ? 'pass'
        : 'fail',
  })

  // ---- 7. 批量收尾 summary 真话（有失败行，不许假 finished 全绿）----
  const summaryWait = await waitForRows(ctx.homeDir, (rows) => rowsOfEvent(rows, 'update.batch.summary').length >= 1, 90000)
  const summaryRows = rowsOfEvent(summaryWait.rows, 'update.batch.summary')
  const summaryRow = summaryRows.length > 0 ? summaryRows[summaryRows.length - 1] : null
  await run.raw('batch-summary', { matched: summaryWait.matched, rows: summaryRows.map((row) => ({ ts: row.ts, ns: row.ns, fields: row.fields })) })
  await run.record({
    step: '批量 summary 如实记失败行（failed≥1，不冒充全绿）',
    what: '收尾一条 update.batch.summary：total/failed/stoppedBecause 反映真账本',
    expected: '存在 summary 行；failed≥1；total≥1',
    actual: 'fields=' + JSON.stringify(summaryRow?.fields ?? null),
    verdict: summaryRow !== null && numOf(summaryRow.fields['failed']) !== null && (numOf(summaryRow.fields['failed']) ?? 0) >= 1 && (numOf(summaryRow.fields['total']) ?? 0) >= 1 ? 'pass' : 'fail',
  })

  // ---- 8. 释放注入锁（本格没改 registry，无需恢复）----
  const release = await releaseFileLock(run, lock)
  await run.record({
    step: '释放注入锁（收尾）：持锁进程退出、文件句柄可再用',
    what: 'kill + taskkill /T /F 兜底，复核 pid 不再存活',
    expected: 'aliveAfter=false',
    actual: 'killed=' + String(release.killed) + '；aliveAfter=' + String(release.aliveAfter),
    verdict: release.aliveAfter === false ? 'pass' : 'fail',
  })
  // ---- 9. 台账逐包真相：A 恰一条成功；B 失败终态；C 没被推过就没有成功 ----
  const ledger = await readLedgerStates(ctx.homeDir)
  const ledgerRows = ledger
    .filter((item) => item.state && typeof item.state === 'object')
    .map((item) => ({
      pluginId: item.file.split('\\').slice(-3)[0],
      state: strOf(item.state.state),
      targetVersion: strOf(item.state.targetVersion),
      previousVersion: strOf(item.state.previousVersion),
    }))
  await run.raw('ledger-states', ledgerRows)
  const aSuccess = ledgerRows.filter((row) => row.pluginId === 'fxa-a' && (row.state === 'completed' || row.state === 'restart-required') && row.targetVersion === ctx.variantVersion && row.previousVersion === ctx.baselineVersion)
  const bFailed = ledgerRows.filter((row) => row.pluginId === batchTargetPrefixB && row.state === 'failed' && (row.targetVersion === ctx.variantVersion || row.targetVersion === null))
  const cRows = ledgerRows.filter((row) => row.pluginId === 'fxa-c')
  const cSuccess = cRows.filter((row) => row.state === 'completed' || row.state === 'restart-required')
  const perPluginCounts = countBy(ledgerRows, (row) => row.pluginId)
  const duplicated = Object.entries(perPluginCounts).filter(([, count]) => count > 1)
  await run.record({
    step: '台账逐包真相：A 恰一条成功终态；B 失败终态；C 无成功记录（整轮推进过 c，失败是注入级联）',
    what: '读 <home>/updates/<pluginId>/<hash>/state.json；成功不重复、失败不丢单；b 半删导致 c 也装不上是故障注入的级联副作用，如实记录不硬断言 c 成功',
    expected: 'A success=1（target=' + ctx.variantVersion + ' / previous=' + ctx.baselineVersion + '）；B failed=1；C success=0；每插件台账 ≤1 条',
    actual: 'aSuccess=' + JSON.stringify(aSuccess) + '；bFailed=' + JSON.stringify(bFailed) + '；cRows=' + JSON.stringify(cRows) + '；duplicated=' + JSON.stringify(duplicated),
    verdict: aSuccess.length === 1 && bFailed.length === 1 && cSuccess.length === 0 && duplicated.length === 0 ? 'pass' : 'fail',
  })

  // ---- 10. 契约四关：事件名/level/字段/枚举 ----
  await sleep(1500)
  const { path: manifestPath, manifest } = await loadEventList(ctx.options.worktree)
  const inventory = await readLogInventory(ctx.homeDir)
  await run.raw('log-inventory', {
    root: inventory.root,
    namespaces: inventory.namespaces,
    files: inventory.files,
    parseFailures: inventory.parseFailures,
    rowCount: inventory.rows.length,
    eventCounts: countBy(inventory.rows, (row) => row.event),
    nsCounts: countBy(inventory.rows, (row) => row.ns),
  })
  const contract = validateAgainstManifest(manifest, inventory.rows)
  await run.raw('contract-report', { manifestPath, contract })
  await run.record({
    step: '日志事件契约四关：事件名 ∈ 清单、level 一致、字段名 ∈ 声明、枚举值合法',
    what: '把磁盘日志逐行对 event-list.update.json（fieldEnums 也校验）；未知事件/未知字段/非法枚举都必须为 0',
    expected: 'unknownEvents=0；levelMismatches=0；fieldViolations=0；enumViolations=0；checkedRows>0',
    actual: 'checkedRows=' + String(contract.checkedRows) + '；unknown=' + JSON.stringify(contract.unknownEvents) + '；level=' + String(contract.levelMismatches.length) + '；fields=' + String(contract.fieldViolations.length) + '；enums=' + String(contract.enumViolations.length),
    verdict:
      contract.checkedRows > 0 && contract.unknownEvents.length === 0 && contract.levelMismatches.length === 0 && contract.fieldViolations.length === 0 && contract.enumViolations.length === 0
        ? 'pass'
        : 'fail',
  })

  const eventCounts = countBy(inventory.rows, (row) => row.event)
  const missing = J1_REQUIRED_EVENTS.filter((event) => (eventCounts[event] ?? 0) < 1)
  const zeroViolations = J1_ZERO_EVENTS.filter((event) => (eventCounts[event] ?? 0) > 0)
  await run.record({
    step: '必备常驻事件覆盖（真安装/真批量/真失败三处事件面都到齐）',
    what: '逐事件计数：覆盖集每项 ≥1；本格不应出现的噪声/失败面必须为 0',
    expected: 'missing=[]；zeroViolations=[]',
    actual: 'missing=' + JSON.stringify(missing) + '；zeroViolations=' + JSON.stringify(zeroViolations) + '；counts=' + JSON.stringify(eventCounts),
    verdict: missing.length === 0 && zeroViolations.length === 0 ? 'pass' : 'fail',
  })

  // ---- 11. 按需事件零行（常驻/按需分流真的生效）----
  const ondemand = Object.entries(manifest.events as Record<string, any>)
    .filter(([, spec]) => spec && spec.kind === 'ondemand')
    .map(([event]) => event)
  const ondemandRows = ondemand.filter((event) => (eventCounts[event] ?? 0) > 0)
  await run.raw('ondemand-events', { names: ondemand, counts: Object.fromEntries(ondemand.map((event) => [event, eventCounts[event] ?? 0])) })
  await run.record({
    step: '按需事件（kind=ondemand）零行：默认不写盘，不冒充常驻',
    what: '清单把事件分常驻/按需；本格没开按需开关，按需事件必须一行不落',
    expected: 'ondemand 事件计数全 0',
    actual: 'ondemand=' + JSON.stringify(ondemand) + '；withRows=' + JSON.stringify(ondemandRows),
    verdict: ondemandRows.length === 0 ? 'pass' : 'fail',
  })

  // ---- 12. 落点：命名空间集合与夹具身份一致、行只在属主目录、无解析失败、预算内 ----
  const expectedNamespaces = expectedLogNamespaces()
  const actualNamespaces = inventory.namespaces.slice().sort()
  const nsMatches = JSON.stringify(actualNamespaces) === JSON.stringify(expectedNamespaces)
  const execOwnership = execFacts(inventory.rows)
    .filter((item) => item.pluginId !== null && item.ns !== item.pluginId)
    .map((item) => ({ ns: item.ns, pluginId: item.pluginId }))
  const nsCounts = countBy(inventory.rows, (row) => row.ns)
  const overBudget = Object.entries(nsCounts).filter(([, count]) => count > MAX_ROWS_PER_NAMESPACE)
  await run.raw('namespace-landing', {
    expectedNamespaces,
    actualNamespaces,
    nsCounts,
    execOwnership,
    overBudget,
    parseFailures: inventory.parseFailures,
  })
  await run.record({
    step: '日志落点：命名空间集合 = 夹具身份派生、exec 行只在属主目录、无解析失败行、每命名空间在预算内',
    what: '命名空间目录只允许由已装夹具批量接线派生的集合（A 的 fxa-* 与 B 的 fxb-*）；exec 行 ns 必须等于其 pluginId；每目录 ≤' + String(MAX_ROWS_PER_NAMESPACE) + ' 行',
    expected: 'namespaces=' + JSON.stringify(expectedNamespaces) + '；execOwnership=[]；parseFailures=0；overBudget=[]',
    actual: 'namespaces=' + JSON.stringify(actualNamespaces) + '；nsMatches=' + String(nsMatches) + '；parseFailures=' + String(inventory.parseFailures.length) + '；overBudget=' + JSON.stringify(overBudget) + '；execOwnership=' + JSON.stringify(execOwnership),
    verdict: nsMatches && execOwnership.length === 0 && inventory.parseFailures.length === 0 && overBudget.length === 0 ? 'pass' : 'fail',
  })

  // ---- 13. 视觉证据：批量/失败之后真 UI 更新面板（批量面板与台账事实的对照）----
  const evidenceHost = await openPanel(ctx, 'j1-evidence')
  const evidencePanel = await panelSnapshot(evidenceHost.page)
  await takeShot(ctx, evidenceHost.page, 'panel-after-batch', {
    what: '真批量跑完（B 超时失败、C 级联失败）之后的真 UI 更新面板：批量结果与更新面板状态同屏',
    steps: '通道 B 宿主 + 三包装好 → 批量 check/install（B 被文件锁拖到 6s 预算超时）→ 轮询到终态 → 打开真 UI 页面截面板',
    expected: '面板挂载（.dsh-upd/[data-fixture] 在）；面板文本可读，作为批量结果的视觉对照',
    actual: JSON.stringify({ counts: evidencePanel.counts, panelText: evidencePanel.panelText.slice(0, 500), logTexts: evidencePanel.logTexts }),
    verdict: evidencePanel.counts.dshUpd >= 1 && evidencePanel.counts.fixture >= 1 ? 'pass' : 'fail',
    note: 'J1 的硬断言仍在日志/台账/电话；这张图只作批量面板的视觉对照（批量面板在「插件」页，非独立日志查看器）。',
  })
  await closeAllPanels(ctx)

  // ---- 14. 收尾 ----
  await closeCurrentHost(ctx, 'main')
  await closeAllPanels(ctx)
}

function countBy<T>(items: T[], keyOf: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const item of items) {
    const key = keyOf(item)
    out[key] = (out[key] ?? 0) + 1
  }
  return out
}

// ---------------------------------------------------------------------------
// J2：噪声预算（真 UI 面板轮询静置 + 状态变化边沿触发恰一次）
// ---------------------------------------------------------------------------

function statusPollTotal(sessions: PanelSession[]): number {
  let total = 0
  for (const session of sessions) total += session.statusRequests.length
  return total
}

async function waitForPollCount(sessions: PanelSession[], target: number, timeoutMs: number): Promise<{ reached: boolean; total: number; elapsedMs: number }> {
  const started = Date.now()
  let total = statusPollTotal(sessions)
  while (Date.now() - started < timeoutMs) {
    if (total >= target) return { reached: true, total, elapsedMs: Date.now() - started }
    await sleep(1000)
    total = statusPollTotal(sessions)
  }
  return { reached: total >= target, total, elapsedMs: Date.now() - started }
}

async function waitForLogCondition(
  homeDir: string,
  predicate: (rows: RawLogRow[]) => boolean,
  timeoutMs: number,
  intervalMs = 2000,
): Promise<{ rows: RawLogRow[]; matched: boolean; elapsedMs: number }> {
  const started = Date.now()
  let rows = (await readLogInventory(homeDir)).rows
  while (Date.now() - started < timeoutMs) {
    if (predicate(rows)) return { rows, matched: true, elapsedMs: Date.now() - started }
    await sleep(intervalMs)
    rows = (await readLogInventory(homeDir)).rows
  }
  return { rows, matched: predicate(rows), elapsedMs: Date.now() - started }
}

function statusChangedRows(rows: RawLogRow[], latest: string): RawLogRow[] {
  return rows.filter((row) => row.event === 'update.status.changed' && row.ns === 'fxa-a' && row.fields['latest'] === latest)
}

async function runNoiseBudget(ctx: JContext): Promise<void> {
  const run = ctx.run
  const { manifest } = await loadEventList(ctx.options.worktree)
  const resident = new Set<string>(
    Object.entries(manifest.events as Record<string, any>)
      .filter(([, spec]) => spec && spec.kind === 'resident')
      .map(([event]) => event),
  )

  // ---- 1. 起宿主 + 两个真 UI 面板（两个页面同时轮询 = 双倍轮询压力）----
  await startHost(ctx, 'main')
  const page1 = await openPanel(ctx, 'noise-1')
  const page2 = await openPanel(ctx, 'noise-2')
  await waitForPollCount([page1, page2], 2, 60000)
  await sleep(8000)

  // ---- 2. 静置窗口：≥100 次真实 updateStatus 轮询，常驻日志零新增 ----
  const baselineInv = await readLogInventory(ctx.homeDir)
  const baselineKeys = new Set(baselineInv.rows.map((row) => row.source + ':' + row.line))
  const windowStartPoll = statusPollTotal([page1, page2])
  await run.raw('noise-window-start', {
    baselineRows: baselineInv.rows.length,
    baselinePerNs: countBy(baselineInv.rows, (row) => row.ns),
    windowStartPoll,
    pollPerPage: [page1.statusRequests.length, page2.statusRequests.length],
    pollSample: [page1.statusRequests.slice(0, 2), page2.statusRequests.slice(0, 2)],
  })
  const windowPollsTarget = windowStartPoll + 100
  const waited = await waitForPollCount([page1, page2], windowPollsTarget, 330000)
  const windowInv = await readLogInventory(ctx.homeDir)
  const newRows = windowInv.rows.filter((row) => !baselineKeys.has(row.source + ':' + row.line))
  const newResident = newRows.filter((row) => resident.has(row.event))
  const windowPolls = statusPollTotal([page1, page2]) - windowStartPoll
  await run.raw('noise-window-end', {
    reached: waited.reached,
    windowPolls,
    pollPerPage: [page1.statusRequests.length, page2.statusRequests.length],
    waitElapsedMs: waited.elapsedMs,
    newRows: newRows.map((row) => ({ ts: row.ts, event: row.event, ns: row.ns, source: row.source })),
    newResidentCount: newResident.length,
  })
  await run.record({
    step: '静置 ≥100 次真 UI 面板轮询：常驻日志零新增（轮询静默、不刷屏）',
    what: '两个 Playwright 页面同时开着真面板轮询 updateStatus；窗口内每新增一行都算噪声',
    expected: '窗口轮询数≥100；每页≥50；窗口内新增行=0（常驻行=0）',
    actual: '窗口轮询数=' + String(windowPolls) + '（每页 ' + page1.statusRequests.length + '/' + page2.statusRequests.length + '）；新增行=' + String(newRows.length) + '（常驻=' + String(newResident.length) + '）' + (newRows.length > 0 ? '；' + JSON.stringify(newRows.map((row) => row.event)) : ''),
    verdict: waited.reached && windowPolls >= 100 && page1.statusRequests.length >= 50 && page2.statusRequests.length >= 50 && newRows.length === 0 ? 'pass' : 'fail',
  })

  // ---- 3. 真 UI 点「检查更新」：状态真变化，恰一条边沿事件 ----
  const preClickPanel = await panelSnapshot(page1.page)
  await takeShot(ctx, page1.page, 'panel-before-check', {
    what: '点「检查更新」前的真 UI 更新面板（状态未变、面板在每 5s 轮询；日志健康读数同在页面上）',
    steps: '起通道 B 宿主 → 两个 Playwright 页面打开真面板 → 静置 ≥100 次轮询 → 截 page1 面板',
    expected: '面板挂载且不含「有新版本」横幅；页面带日志路牌/健康读数',
    actual: JSON.stringify({ counts: preClickPanel.counts, panelText: preClickPanel.panelText.slice(0, 300), logTexts: preClickPanel.logTexts }),
    verdict: preClickPanel.counts.dshUpd >= 1 && preClickPanel.panelText.indexOf('有新版本') < 0 ? 'pass' : 'fail',
    note: '噪声预算格的视觉证据：此时状态仍是 unknown/latest=null，面板不刷横幅。',
  })
  const click = await clickPanelButtonByText(page1.page, ['检查更新', '查询更新'])
  await run.raw('panel-click-check', click)
  const changed = await waitForLogCondition(ctx.homeDir, (rows) => statusChangedRows(rows, ctx.variantVersion).length >= 1, 90000, 2000)
  await sleep(2000)
  const afterInv = await readLogInventory(ctx.homeDir)
  const availabilityRows = statusChangedRows(afterInv.rows, ctx.variantVersion)
  const panelAfter = await panelSnapshot(page1.page)
  await run.raw('panel-check-result', {
    clicked: click,
    matched: changed.matched,
    elapsedMs: changed.elapsedMs,
    availabilityRows: availabilityRows.map((row) => ({ ts: row.ts, ns: row.ns, fields: row.fields })),
    panelText: panelAfter.panelText.slice(0, 2000),
    logTexts: panelAfter.logTexts,
  })
  const availability = availabilityRows.length > 0 ? availabilityRows[availabilityRows.length - 1] : null
  await run.record({
    step: '真 UI 点「检查更新」→ 状态真变化，恰一条 update.status.changed（update-available）',
    what: '面板点击发出 updateCheck；宿主侧状态从 unknown 变为 update-available 时才落一行边沿事件',
    expected: 'clicked=true；恰 1 行 kind=update-available；latest=' + ctx.variantVersion,
    actual: 'clicked=' + String(click.clicked) + '；行数=' + String(availabilityRows.length) + '；kind=' + String(availability?.fields['kind'] ?? null) + '；latest=' + String(availability?.fields['latest'] ?? null),
    verdict: click.clicked && availabilityRows.length === 1 && availability?.fields['kind'] === 'update-available' && availability?.fields['latest'] === ctx.variantVersion ? 'pass' : 'fail',
  })

  // ---- 4. 再等 ≥20 次轮询：同指纹不重复 ----
  const repeatStartPoll = statusPollTotal([page1, page2])
  const repeatWait = await waitForPollCount([page1, page2], repeatStartPoll + 20, 180000)
  const repeatInv = await readLogInventory(ctx.homeDir)
  const repeatRows = statusChangedRows(repeatInv.rows, ctx.variantVersion)
  const repeatPolls = statusPollTotal([page1, page2]) - repeatStartPoll
  await run.raw('noise-repeat-window', { repeatPolls, repeatRows: repeatRows.map((row) => ({ ts: row.ts, fields: row.fields })), reached: repeatWait.reached })
  await run.record({
    step: '同一状态再等 ≥20 次轮询：同指纹事件不重复（边沿触发，不是每轮一行）',
    what: '状态不变时轮询不得再落 update.status.changed；指纹 = (kind, latest)',
    expected: '状态变化后新增轮询≥20；update-available 行数仍=1',
    actual: '新增轮询=' + String(repeatPolls) + '；update-available 行数=' + String(repeatRows.length),
    verdict: repeatWait.reached && repeatPolls >= 20 && repeatRows.length === 1 ? 'pass' : 'fail',
  })

  // ---- 5. 面板文本如实显示新版本 ----
  const finalPanel = await panelSnapshot(page1.page)
  await run.raw('panel-final-text', { panelText: finalPanel.panelText.slice(0, 2000), logTexts: finalPanel.logTexts, counts: finalPanel.counts })
  await run.record({
    step: '真 UI 面板如实显示「有新版本 '+ ctx.variantVersion + '」',
    what: '状态变化后面板下一次轮询把更新可用横幅渲染出来（UI 与日志同一事实）',
    expected: '面板文本含「有新版本」与 ' + ctx.variantVersion,
    actual: 'panelText 片段=' + JSON.stringify(finalPanel.panelText.slice(0, 400)),
    verdict: finalPanel.panelText.indexOf('有新版本') >= 0 && finalPanel.panelText.indexOf(ctx.variantVersion) >= 0 ? 'pass' : 'fail',
  })

  // ---- 5b. 截图：状态变化后的真 UI 面板（有新版本横幅 + 日志健康读数）----
  await takeShot(ctx, page1.page, 'panel-update-available', {
    what: '点「检查更新」后的真 UI 更新面板：有新版本横幅 + 日志健康读数（同一页）',
    steps: '真 UI 点「检查更新」→ 等状态落 update-available → 再等 ≥20 次轮询不重复 → 截 page1 面板',
    expected: '面板文本含「有新版本」与 ' + ctx.variantVersion + '；日志健康读数仍在',
    actual: JSON.stringify({ counts: finalPanel.counts, panelText: finalPanel.panelText.slice(0, 400), logTexts: finalPanel.logTexts }),
    verdict: finalPanel.panelText.indexOf('有新版本') >= 0 && finalPanel.panelText.indexOf(ctx.variantVersion) >= 0 ? 'pass' : 'fail',
    note: '边沿触发后的视觉证据：横幅是状态变化的 UI 呈现，日志侧恰 1 行 status.changed。',
  })

  // ---- 6. 行预算：每命名空间 ≤ 预算 ----
  const finalInv = await readLogInventory(ctx.homeDir)
  const nsCounts = countBy(finalInv.rows, (row) => row.ns)
  const overBudget = Object.entries(nsCounts).filter(([, count]) => count > MAX_ROWS_PER_NAMESPACE)
  await run.raw('noise-budget-final', { nsCounts, totalRows: finalInv.rows.length, parseFailures: finalInv.parseFailures.length, overBudget })
  await run.record({
    step: '全程日志行预算：每命名空间 ≤' + String(MAX_ROWS_PER_NAMESPACE) + ' 行，无解析失败行',
    what: '日志是可长期常驻的产物，行预算与可解析性都属于噪声预算的一部分',
    expected: 'overBudget=[]；parseFailures=0',
    actual: 'nsCounts=' + JSON.stringify(nsCounts) + '；totalRows=' + String(finalInv.rows.length) + '；parseFailures=' + String(finalInv.parseFailures.length),
    verdict: overBudget.length === 0 && finalInv.parseFailures.length === 0 ? 'pass' : 'fail',
  })

  await closeAllPanels(ctx)
  await closeCurrentHost(ctx, 'main')
}

// ---------------------------------------------------------------------------
// J3：命名空间 / 落点 / 客户端白名单（真 UI 日志健康读数 ↔ 磁盘对账）
// ---------------------------------------------------------------------------

interface HealthReading {
  readonly text: string
  readonly sink: string | null
  readonly dirHash: string | null
  readonly switchText: string | null
  readonly dropped: number | null
  readonly lastEventText: string | null
  readonly contract: string | null
}

function parseHealthLine(text: string): HealthReading {
  const sink = /落点=([a-z]+)/.exec(text)
  const dirHash = /目录指纹=([0-9a-f]{8})/.exec(text)
  const switchText = /按需信息开关=(开|关)/.exec(text)
  const dropped = /启动以来丢弃 (\d+) 行/.exec(text)
  const lastEvent = /最近事件=([^；]+)/.exec(text)
  const contract = /事件契约=([^；]+)/.exec(text)
  return {
    text,
    sink: sink ? sink[1] : null,
    dirHash: dirHash ? dirHash[1] : null,
    switchText: switchText ? switchText[1] : null,
    dropped: dropped ? Number(dropped[1]) : null,
    lastEventText: lastEvent ? lastEvent[1].trim() : null,
    contract: contract ? contract[1].trim() : null,
  }
}

function parseMonthDayMinute(text: string, year: number): number | null {
  const matched = /(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/.exec(text)
  if (!matched) return null
  const value = new Date(year, Number(matched[1]) - 1, Number(matched[2]), Number(matched[3]), Number(matched[4]), 0, 0).getTime()
  return Number.isFinite(value) ? value : null
}

async function runNamespaceWhitelist(ctx: JContext): Promise<void> {
  const run = ctx.run

  // ---- 1. 起宿主 + 真 UI 面板 ----
  await startHost(ctx, 'main')
  const panel = await openPanel(ctx, 'namespace')

  // ---- 2. 真 UI 点「检查更新」（让面板动作/日志行真的发生一次）----
  const click = await clickPanelButtonByText(panel.page, ['检查更新', '查询更新'])
  await run.raw('panel-click-check', click)
  const changed = await waitForLogCondition(ctx.homeDir, (rows) => statusChangedRows(rows, ctx.variantVersion).length >= 1, 90000, 2000)
  await sleep(2500)
  const inv = await readLogInventory(ctx.homeDir)
  const checkDone = rowsOfEvent(inv.rows, 'update.check.done').filter((row) => row.ns === 'fxa-a')
  const actionRows = rowsOfEvent(inv.rows, 'update.panel.action').filter((row) => row.ns === 'fxa-a')
  await run.raw('panel-action-rows', {
    clicked: click,
    matched: changed.matched,
    checkDone: checkDone.map((row) => ({ ts: row.ts, fields: row.fields })),
    actionRows: actionRows.map((row) => ({ ts: row.ts, fields: row.fields })),
  })
  await run.record({
    step: '真 UI 动作与检查事件都落到属主命名空间（面板动作/检查结果各 ≥1 行）',
    what: '点「检查更新」= 面板动作（客户端白名单事件）+ 宿主检查完成（常驻事件），两者都只落 fxa-a',
    expected: 'update.check.done ≥1（ns=fxa-a）；update.panel.action ≥1（ns=fxa-a）；check done ok=true',
    actual: 'checkDone=' + String(checkDone.length) + '；actionRows=' + String(actionRows.length) + '；ok=' + String(checkDone.length > 0 ? checkDone[checkDone.length - 1].fields['ok'] : null),
    verdict: checkDone.length >= 1 && actionRows.length >= 1 ? 'pass' : 'fail',
  })

  // ---- 3. 面板日志健康读数（第二行 .dsh-upd-log）原文 ----
  const snapshot = await panelSnapshot(panel.page)
  const healthText = snapshot.logTexts.find((text) => text.indexOf('事件契约=') >= 0) ?? null
  const health = healthText === null ? null : parseHealthLine(healthText)
  await run.raw('panel-log-health', {
    logTexts: snapshot.logTexts,
    healthText,
    parsed: health,
    counts: snapshot.counts,
  })
  await run.record({
    step: '面板渲染出日志健康读数（落点/目录指纹/按需开关/丢弃数/最近事件/契约）',
    what: '这是 web GUI 上面板能给出的「日志到底有没有、落点是谁」的唯一读数（src/panel/render.ts:1035-1067）',
    expected: '面板文本含「事件契约=」行；六项读数都能解析',
    actual: healthText === null ? '未找到健康读数行；logTexts=' + JSON.stringify(snapshot.logTexts) : '健康读数=' + JSON.stringify(health),
    verdict: health !== null && health.sink !== null && health.dirHash !== null && health.contract !== null ? 'pass' : 'fail',
  })

  // ---- 4. UI 读数 ↔ 磁盘对账：落点=self、目录指纹=wire.ready.logDirHash ----
  const wireRows = rowsOfEvent(inv.rows, 'update.wire.ready').filter((row) => row.ns === 'fxa-a')
  const wire = wireRows.length > 0 ? wireRows[wireRows.length - 1] : null
  const logDirHash = strOf(wire?.fields['logDirHash'] ?? null)
  const logSink = strOf(wire?.fields['logSink'] ?? null)
  await run.raw('wire-ready-vs-health', {
    wire: wire === null ? null : { ts: wire.ts, ns: wire.ns, fields: wire.fields },
    logDirHash,
    logSink,
    health,
  })
  await run.record({
    step: '面板读数与磁盘日志同源：落点=self、目录指纹=update.wire.ready 的 logDirHash',
    what: 'UI 说的落点与指纹必须等于日志自己记的接线事实，不许各说各话',
    expected: 'health.sink=self；health.dirHash=' + String(logDirHash) + '；wire.logSink=self',
    actual: 'sink=' + String(health?.sink ?? null) + '；dirHash=' + String(health?.dirHash ?? null) + '；wire.logDirHash=' + String(logDirHash) + '；wire.logSink=' + String(logSink),
    verdict: health?.sink === 'self' && logSink === 'self' && health?.dirHash !== null && health?.dirHash === logDirHash ? 'pass' : 'fail',
  })

  // ---- 5. 丢弃 0 / 契约正常：与磁盘无降级行互证 ----
  const degraded = rowsOfEvent(inv.rows, 'update.log.degraded')
  const renderFail = rowsOfEvent(inv.rows, 'update.panel.render.fail')
  await run.raw('health-degraded-rows', {
    degraded: degraded.map((row) => ({ ts: row.ts, ns: row.ns, fields: row.fields })),
    renderFail: renderFail.map((row) => ({ ts: row.ts, ns: row.ns, fields: row.fields })),
    health,
  })
  await run.record({
    step: '按需开关=关、启动以来丢弃=0、事件契约=正常（与磁盘无降级行互证）',
    what: '面板读数是最坏情况的措辞源；磁盘侧对应不得出现 update.log.degraded / panel.render.fail',
    expected: 'switch=关；dropped=0；contract=正常；degraded 行=0；render.fail 行=0',
    actual: 'switch=' + String(health?.switchText ?? null) + '；dropped=' + String(health?.dropped ?? null) + '；contract=' + String(health?.contract ?? null) + '；degraded=' + String(degraded.length) + '；renderFail=' + String(renderFail.length),
    verdict: health?.switchText === '关' && health?.dropped === 0 && health?.contract === '正常' && degraded.length === 0 && renderFail.length === 0 ? 'pass' : 'fail',
  })

  // ---- 6. 最近事件读数与磁盘最新一行同窗 ----
  const fxaRows = inv.rows.filter((row) => row.ns === 'fxa-a')
  const newestTs = fxaRows.reduce<number | null>((best, row) => (row.ts !== null && (best === null || row.ts > best) ? row.ts : best), null)
  const parsedLast = health?.lastEventText ? parseMonthDayMinute(health.lastEventText, newestTs === null ? new Date().getFullYear() : new Date(newestTs).getFullYear()) : null
  const deltaMs = parsedLast !== null && newestTs !== null ? newestTs - parsedLast : null
  await run.raw('health-last-event', { lastEventText: health?.lastEventText ?? null, parsedLast, newestTs, deltaMs, newestRow: newestTs === null ? null : fxaRows.filter((row) => row.ts === newestTs).slice(0, 1) })
  await run.record({
    step: '最近事件读数与磁盘最新日志行对得上（同一事实，不是缓存字样）',
    what: '面板读数是「最近一次把行交给落点的时间」；它应落在磁盘最新一行的同一分钟内',
    expected: 'deltaMs 可算出且 ≤120000（分钟精度）',
    actual: 'lastEvent=' + String(health?.lastEventText ?? null) + '；parsedLast=' + String(parsedLast) + '；newestTs=' + String(newestTs) + '；deltaMs=' + String(deltaMs),
    verdict: deltaMs !== null && Math.abs(deltaMs) <= 120000 ? 'pass' : 'fail',
  })

  // ---- 7. 客户端事件白名单：只在属主、只许客户端事件名 ----
  const clientRows = inv.rows.filter((row) => (CLIENT_LOG_EVENTS as readonly string[]).indexOf(row.event) >= 0)
  const clientOutsideOwner = clientRows.filter((row) => row.ns !== 'fxa-a')
  const clientEventNames = Array.from(new Set(clientRows.map((row) => row.event)))
  const allClientNamesLegal = clientEventNames.every((event) => (CLIENT_LOG_EVENTS as readonly string[]).indexOf(event) >= 0)
  await run.raw('client-event-whitelist', { clientEventNames, clientRows: clientRows.map((row) => ({ ts: row.ts, event: row.event, ns: row.ns })), clientOutsideOwner })
  await run.record({
    step: '客户端事件只出现在属主命名空间、事件名全在白名单内',
    what: '客户端日志走 logAppend 上浮，白名单限定 6 个客户端事件（src/log/client-queue.ts:105）；宿主事实不许由客户端冒充',
    expected: 'clientOutsideOwner=[]；clientEventNames ⊆ ' + JSON.stringify(CLIENT_LOG_EVENTS) + '；至少含 panel.mount 与 panel.action',
    actual: 'names=' + JSON.stringify(clientEventNames) + '；outside=' + JSON.stringify(clientOutsideOwner.map((row) => ({ event: row.event, ns: row.ns }))),
    verdict:
      clientOutsideOwner.length === 0 &&
      allClientNamesLegal &&
      clientEventNames.indexOf('update.panel.mount') >= 0 &&
      clientEventNames.indexOf('update.panel.action') >= 0
        ? 'pass'
        : 'fail',
  })

  // ---- 8. 白名单负向真机：用 logAppend 伪造宿主事实事件 → 必须拒收且不落盘 ----
  const execBefore = rowsOfEvent(inv.rows, 'update.install.exec').length
  const forgedTs = Date.now()
  const forged = await callPhone(ctx, ctx.phonePrefix + '.logAppend', {
    rows: [
      {
        level: 'info',
        event: 'update.install.exec',
        fields: { route: 'forged', ok: true, exitCode: 0, durationMs: 1, pluginId: 'forged' },
        ts: forgedTs,
      },
    ],
  })
  const accepted = numOf(forged.inner?.['accepted'] ?? null)
  const dropped = numOf(forged.inner?.['dropped'] ?? null)
  await sleep(2000)
  const afterInv = await readLogInventory(ctx.homeDir)
  const forgedRows = afterInv.rows.filter((row) => row.event === 'update.install.exec' && row.fields['route'] === 'forged')
  const execAfter = rowsOfEvent(afterInv.rows, 'update.install.exec').length
  await run.raw('log-append-forgery', { forgedTs, response: { status: forged.status, body: forged.body }, accepted, dropped, execBefore, execAfter, forgedRows: forgedRows.map((row) => ({ ts: row.ts, ns: row.ns, fields: row.fields })) })
  await run.record({
    step: '客户端白名单负向真机：伪造 update.install.exec 被拒收、不落盘',
    what: '直接向属主 logAppend 电话送一条「宿主事实」事件；客户端通道必须按协议拒收（只回 accepted/dropped，不抛）',
    expected: 'accepted=0；dropped=1；磁盘伪造行=0；exec 行数不变（' + String(execBefore) + '）',
    actual: 'accepted=' + String(accepted) + '；dropped=' + String(dropped) + '；伪造行=' + String(forgedRows.length) + '；execBefore=' + String(execBefore) + '；execAfter=' + String(execAfter),
    verdict: accepted === 0 && dropped === 1 && forgedRows.length === 0 && execAfter === execBefore ? 'pass' : 'fail',
  })

  // ---- 9. 截图：真 UI 面板日志健康区（六字段 sidecar）----
  const healthShot = await takeShot(ctx, panel.page, 'panel-log-health', {
    what: 'web GUI 更新面板第 4 章的日志路牌 + 日志健康读数（落点=self / 目录指纹 / 丢弃数 / 最近事件 / 事件契约）',
    steps: '装好 SUT + 夹具 A → 起通道 B 宿主 → Playwright 打开页面 → 点「检查更新」→ 截面板日志区',
    expected: '面板出现日志健康行，读数与磁盘日志逐项一致',
    actual: (healthText ?? '未找到健康读数行').slice(0, 500),
    verdict: health !== null ? 'pass' : 'fail',
    note: 'J 组口径：web GUI 没有独立插件日志查看器；此处取证的是面板内日志路牌与健康读数，磁盘事件面另有断言。',
  })
  await run.raw('panel-log-health-shot', healthShot)

  await closeAllPanels(ctx)
  await closeCurrentHost(ctx, 'main')
}

// ---------------------------------------------------------------------------
// can-red：删掉本 run 私有副本里的事件契约，真 exec 行必须被判成未知事件
// ---------------------------------------------------------------------------

async function runCanRed(ctx: JContext): Promise<void> {
  const run = ctx.run
  const fixtureEnv = run.fixtureEnv
  if (fixtureEnv === null) throw new Error('[can-red] fixtureEnv 未初始化')

  await startHost(ctx, 'can-red')
  const check = await callPhone(ctx, ctx.phonePrefix + '.updateCheck', { trigger: 'user' })
  const checkId = strOf(check.inner?.receipt?.checkId) ?? ''
  const install = await callPhone(ctx, ctx.phonePrefix + '.updateInstall', { checkId, requestId: 'can-red-' + String(Date.now()), from: 'panel' })
  await run.raw('can-red-install-request', { check: { status: check.status, body: check.body }, install: { status: install.status, body: install.body } })
  const execWait = await waitForExecCount(ctx.homeDir, [ctx.phonePrefix], 1, 180000)
  const inv = await readLogInventory(ctx.homeDir)
  const execRows = execFacts(inv.rows).filter((item) => item.pluginId === ctx.phonePrefix)
  await run.raw('can-red-exec-rows', { matched: execWait.matched, elapsedMs: execWait.elapsedMs, exec: execRows })
  await run.record({
    step: 'can-red 前置：真安装确实产生 exec 行（否则后面的红点不可归因）',
    what: 'can-red 要证明的是「删掉契约后真 exec 行被判未知」，前提是真机真发过这一行',
    expected: 'exec 行 ≥1（pluginId=' + ctx.phonePrefix + '）',
    actual: 'exec 行数=' + String(execRows.length) + '；matched=' + String(execWait.matched),
    verdict: execRows.length >= 1 ? 'pass' : 'fail',
  })

  // 健康路径：真实契约下先证明这批日志干净（否则 can-red 的红不可归因）
  const { path: manifestPath, manifest } = await loadEventList(ctx.options.worktree)
  const clean = validateAgainstManifest(manifest, inv.rows)
  await run.raw('can-red-manifest-clean', { manifestPath, clean })
  await run.record({
    step: 'can-red 前置：真实事件契约下这批日志四关全过（红点后来才可归因到注入）',
    what: '同一批磁盘日志先对仓库里的 event-list.update.json 校验一遍，证明日志本身不脏',
    expected: 'unknownEvents=0；level/field/enum 违规=0；checkedRows>0',
    actual: JSON.stringify(clean),
    verdict: clean.checkedRows > 0 && clean.unknownEvents.length === 0 && clean.levelMismatches.length === 0 && clean.fieldViolations.length === 0 && clean.enumViolations.length === 0 ? 'pass' : 'fail',
  })

  // 注入：把契约复制到 run 私有目录，删掉 update.install.exec（真机上确实发了它）
  const injected = JSON.parse(JSON.stringify(manifest)) as any
  const hadEvent = injected.events && typeof injected.events === 'object' && Object.prototype.hasOwnProperty.call(injected.events, 'update.install.exec')
  const hadEnums = injected.fieldEnums && typeof injected.fieldEnums === 'object' && Object.prototype.hasOwnProperty.call(injected.fieldEnums, 'update.install.exec')
  if (injected.events) delete injected.events['update.install.exec']
  if (injected.fieldEnums) delete injected.fieldEnums['update.install.exec']
  const injectedPath = join(run.layout.root, 'can-red-event-list.json')
  await writeFile(injectedPath, JSON.stringify(injected, null, 2))
  const injectedDiff = {
    injectedPath,
    removedEvent: hadEvent,
    removedFieldEnums: hadEnums,
    eventsBefore: Object.keys(manifest.events as Record<string, unknown>).length,
    eventsAfter: Object.keys(injected.events as Record<string, unknown>).length,
  }
  await run.raw('can-red-injection', injectedDiff)
  const injectedReport = validateAgainstManifest(injected, inv.rows)
  await run.raw('can-red-contract-report', { injectedDiff, injectedReport })
  const unknownExec = injectedReport.unknownEvents.filter((item) => item.event === 'update.install.exec')
  await run.record({
    step: 'can-red：删掉本 run 私有契约里的 update.install.exec → 真 exec 行必须被判成未知事件（本 run 必须红）',
    what: '注入点 = run 私有副本 ' + injectedPath + '（产品文件未动）；被破坏的检查 = 事件名覆盖关',
    expected: 'injectedReport.unknownEvents 含 update.install.exec；本 run verdict=fail / exitCode=1',
    actual: 'removedEvent=' + String(hadEvent) + '；unknownEvents=' + JSON.stringify(injectedReport.unknownEvents.map((item) => item.event)) + '；exec 未知行数=' + String(unknownExec.length),
    verdict: hadEvent && unknownExec.length >= 1 ? 'fail' : 'pass',
    note: 'can-red 是故意造的失败：红点来自「真机上产品确实发了 update.install.exec，而契约副本被删掉」这一因果；不注入时同一批日志四关全过（上一条断言）。',
  })

  await closeCurrentHost(ctx, 'can-red')
}

// ---------------------------------------------------------------------------
// 场景入口
// ---------------------------------------------------------------------------

export async function runJLogPanel(options: JLogPanelOptions): Promise<RunManifest> {
  const scenarioId = scenarioIdOf(options.mode)
  const profileName =
    options.mode === 'noise-budget' ? 't9j2' : options.mode === 'namespace-whitelist' ? 't9j3' : options.mode === 'can-red' ? 't9j1c' : 't9j1'
  const ctx = await setupScenario(options, scenarioId, profileName)
  try {
    if (options.mode === 'contract-coverage') await runContractCoverage(ctx)
    else if (options.mode === 'noise-budget') await runNoiseBudget(ctx)
    else if (options.mode === 'namespace-whitelist') await runNamespaceWhitelist(ctx)
    else await runCanRed(ctx)
    ctx.run.addNote(
      'J 组判读口径：web GUI 没有独立的插件日志查看器；面板面 = 更新面板第 4 章的日志路牌 + 日志健康读数（.dsh-upd-log），' +
        '事件契约/噪声预算/命名空间都从 <home>/logs 磁盘原始行独立统计；UI 只作「面板看得见、读数与磁盘一致」的证据。',
    )
  } catch (error) {
    await ctx.run.raw('scenario-error', { message: messageOf(error), stack: error instanceof Error ? error.stack ?? null : null })
    ctx.run.record({
      step: '场景执行异常（未观测到可判定事实）',
      what: '场景代码抛错：按证据四态记 unknown，不当通过',
      expected: '完整跑完本格流程',
      actual: messageOf(error) + (error instanceof Error && error.stack ? '；' + error.stack.split('\n').slice(0, 6).join(' | ') : ''),
      verdict: 'unknown',
    })
    ctx.run.addNote('场景异常，见 raw/scenario-error。')
  } finally {
    await closeAllPanels(ctx)
    await closeCurrentHost(ctx, 'cleanup')
    const hosts = ctx.hosts.map((entry) => ({
      label: entry.label,
      pid: entry.pid,
      port: entry.port,
      closed: entry.closed,
      pidAlive: entry.pid === null ? null : isProcessAlive(entry.pid),
    }))
    ctx.run.record({
      step: '收尾：真 UI 页面与 CLI 宿主全部退出，无残留进程/端口',
      what: '登记每个宿主的 pid/port 并核对退出；端口释放由 run.close 的 cleanup 复核',
      expected: '每个宿主 closed=true；pidAlive=false',
      actual: JSON.stringify(hosts),
      verdict: hosts.every((host) => host.closed && host.pidAlive === false) ? 'pass' : 'fail',
    })
  }
  const manifest = await ctx.run.close()
  if (options.syncEvidence !== false) {
    await copyRunEvidence(ctx.run.layout, options.worktree).catch((error: unknown) => {
      console.error('[j-log-panel] 证据复制失败：' + messageOf(error))
    })
  }
  return manifest
}
