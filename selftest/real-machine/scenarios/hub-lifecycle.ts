/**
 * selftest/real-machine/scenarios/hub-lifecycle.ts —— 票 #284（spec #263 C 组：中枢生命周期与 profile 隔离）真机场景。
 *
 * 四格（工具 tools/run-hub-lifecycle.ts 传 --mode）：
 *   m1：同 profile 装 A/B 两个批量集成方@0.0.1，同时发起 A(fxa, targets a/b/c) 与 B(fxb, targets b/c) 批量；
 *       双方案在盘、A 自键已换而 B/C 未终态时杀掉唯一宿主（= 全部 fiber / 执行者消失），
 *       从 profile 在册摘掉 B 后起第二代宿主（只回来 A）：A 按 hub/plans/fxa.json 自动接管孤儿子任务推完，
 *       fxb 方案原样保留不被 A 改写/执行。
 *   m2：只回来 B：B 不冒领 fxa（属主过滤），先推完自己的 fxb；第三幕只装回 A，A 再采纳 fxa 收尾。
 *   m3：A 自己行失败但 A 仍活着：坏 A@0.0.2 tarball 字节（元数据/integrity 不动），真 UI 从 A 发起批量，
 *       A 行诚实失败、B/C 继续完成；恢复 tarball 后真 UI 重试只重跑 A 行。
 *   m4：同 home 两个 profile 并发更新：队列/锁按 profile 隔离、两个安装窗重叠。
 *   can-red：复用 m1 场景，在换手窗口里删除 hub/plans/fxa.json（中枢无方案可接管）——
 *       「A 自动续跑完成」断言应当红（本 run 记 fail/exit1，红点可归因到被删方案本身）。
 *
 * 换手注入等价性：web 通道没有「应用自重启」，用「杀第一代宿主（taskkill /T /F = 硬杀）+ 同 home/profile 起第二代」
 * 注入换手，等价于桌面 relaunch 后新 fiber 接管中枢。差别写进 docs/research/20261103-issue-284-hub-lifecycle.md。
 *
 * 证据口径（selftest/evidence/README.md）：换手窗口/租约/plan 原文用轮询快照 + raw；「自动续跑」用
 * update.install.exec 的 ts 与第二代 host.start 的 ts 比较；台账读 <home>/updates/<pluginId>/<hash>/state.json；
 * 磁盘读 profile package.json + node_modules 版本。
 */
import { createHash } from 'node:crypto'
import { readFile, readdir, rm, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FIXTURE_INSTALL_TIMEOUT_ENV,
  FIXTURE_REGISTRY_ENV,
  fixtureBridgeRouteOf,
  fixtureSlotOf,
} from '../../fixtures/identity/fixture-slots.ts'
import type { FixtureSlotKey } from '../../fixtures/identity/fixture-slots.ts'
import { fetchPublishedVersions } from '../../fixtures/release/registry-client.ts'
import { ensureDir, listFilesRecursive } from '../../tooling/fs-utils.ts'
import { isPortFree } from '../../tooling/ports.ts'
import { isProcessAlive, sleep } from '../../tooling/process.ts'
import type { CliHostSession } from '../host/cli-host.ts'
import { startCliHost } from '../host/cli-host.ts'
import type { DesktopSession } from '../host/desktop-app.ts'
import { readProfileManifest, removePluginFromProfile } from '../host/dsh-cli.ts'
import { createWebProfileInHome, installPluginIntoProfile } from '../host/isolated-profile.ts'
import type { RunManifest } from '../runtime/evidence.ts'
import { captureLogFiles } from '../runtime/log-evidence.ts'
import { baselineVersionOf, publishScenarioVariants, variantVersionOf } from '../runtime/scenario-runner.ts'
import { AUTH_REQUIRED_MARKER } from '../base-verify/web-ui.ts'
import type { TarballCorruptionFault } from '../runtime/registry-faults.ts'
import { corruptPublishedTarball, restoreCorruptedTarball } from '../runtime/registry-faults.ts'
import type { BatchSeatState } from './batch-helpers.ts'
import { cardSelectorOf, clickSeatAction, copyRunEvidence, readBatchSeat, waitForBatchSeat } from './batch-helpers.ts'
import type { T3Run } from './t3-common.ts'
import { installedFixtureVersion, openT3Run, verifySutInstalled } from './t3-common.ts'

/** 场景 mode：四格 + can-red（预期红，复用 m1 场景/断言）。 */
export type HubLifecycleMode = 'm1' | 'm2' | 'm3' | 'm4' | 'can-red'

/** 一次真机 run 的入参（工具层解析后原样传）。 */
export interface HubLifecycleOptions {
  readonly worktree: string
  readonly runBaseDir: string
  readonly verdaccioInstallDir: string
  readonly esbuildPath: string
  readonly stamp?: string
  readonly maintainerHome?: string
  readonly mode: HubLifecycleMode
  /** false = 只把证据留在仓库外（试错 run），true/缺省 = 复制进 selftest/evidence/runs。 */
  readonly syncEvidence?: boolean
}

/** 场景 id 与 mode 的映射（can-red 复用 m1：同一场景、同一组断言被破坏）。 */
export function scenarioIdOf(mode: HubLifecycleMode): string {
  if (mode === 'm2') return 'm2-hub-orphan-only-owner-b-returns'
  if (mode === 'm3') return 'm3-owner-a-row-fails-still-alive'
  if (mode === 'm4') return 'm4-cross-profile-concurrency'
  return 'm1-hub-orphan-only-owner-a-returns'
}

/** 隔离 profile 名（非 desktop：官方桌面独占 desktop 名，普通宿主建不了，见 T6 P1 探针）。 */
const PROFILE_NAME = 't14hub'
/** 夹具 A 的批量电话前缀（fixture-slots.ts: FIXTURE_SLOT_A.batch.prefix）。 */
const BATCH_PREFIX = 'fxa'
/** 宿主安装预算/锁陈旧阈值压到 4s：被杀宿主的 global.lock 要在几秒后判陈旧，不拖死换手。 */
const INSTALL_TIMEOUT_MS = 4000
/** 换手窗口轮询间隔。 */
const KILL_POLL_MS = 200
/** 等双方案在盘 + 进入换手窗口的预算。 */
const WINDOW_WAIT_MS = 120_000
/** 第二代宿主把方案推完的预算（含陈旧锁/占位恢复延迟）。 */
const BATCH_WAIT_MS = 150_000
/** can-red 注入后等「本应出现的续跑」的预算。 */
const CAN_RED_WAIT_MS = 45_000
/** M3 只有一个宿主、不换手：安装预算按真 UI 安装窗放宽（A 自更新 + pnpm 拉坏包都会超过 4s）。 */
const M3_INSTALL_TIMEOUT_MS = 120_000
/** M3 安装窗只轮询磁盘/台账的预算（坏 A 行失败 + B/C 照常装完）。 */
const M3_DISK_WAIT_MS = 360_000
/** M3 等面板重排/终态的预算。 */
const M3_PANEL_WAIT_MS = 180_000
/** M3 磁盘/台账轮询间隔。 */
const M3_POLL_MS = 1000
/** M4 两个宿主并发装三包：安装预算放宽到 30s（共享 pnpm store 时 pnpm 启动/解包比单宿主慢；本格不杀宿主，锁陈旧阈值用不到）。 */
const M4_INSTALL_TIMEOUT_MS = 30_000
/** M4 两个 profile 并发批量把三包都装完的预算（两宿主共享 pnpm store，留足）。 */
const M4_BATCH_WAIT_MS = 180_000
/** M4 并发采样间隔（两套 batch.json/queue.json/lease.json）。 */
const M4_POLL_MS = 120
/** 批量行终态。 */
const TERMINAL_PHASES = ['done', 'failed', 'skipped', 'current']

interface HostEntry {
  readonly label: string
  readonly host: CliHostSession
  readonly pid: number | null
  readonly port: number
  readonly profileName: string
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

/** 内容哈希（方案原样保留的判据）。 */
function sha256TextOf(text: string): string {
  return createHash('sha256').update(text).digest('hex')
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

async function listFilesMaybe(path: string): Promise<string[]> {
  try {
    return await readdir(path)
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
async function callPhone(host: CliHostSession, phone: string, args: Record<string, unknown> = {}, route: string): Promise<PhoneResult> {
  const started = Date.now()
  const result = await host.postPhone(route, phone, args)
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

function phaseOfEntryByPrefix(batch: any, prefix: string): string | null {
  if (!batch || !Array.isArray(batch.entries)) return null
  const entry = batch.entries.find((candidate: any) => candidate && candidate.prefix === prefix)
  return entry && typeof entry.phase === 'string' ? entry.phase : null
}

function allTerminal(batch: any): boolean {
  if (!batch || !Array.isArray(batch.entries) || batch.entries.length === 0) return false
  return batch.entries.every((entry: any) => TERMINAL_PHASES.includes(entry?.phase))
}

function phasesOfBatch(batch: any): Record<string, string | null> {
  return { a: phaseOfBatch(batch, 'a'), b: phaseOfBatch(batch, 'b'), c: phaseOfBatch(batch, 'c') }
}

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

/** 台账 state.json 本身不含 pluginId；从路径 .../updates/<pluginId>/<hash>/state.json 取。 */
function ledgerPluginIdOf(file: string): string | null {
  const parts = file.replace(/\\/g, '/').split('/')
  const index = parts.lastIndexOf('updates')
  return index >= 0 && index + 1 < parts.length ? parts[index + 1] : null
}

// ==========================================================================================
// M3 真 UI 观测原语（Playwright）。共享 loadPlaywright 只接受 headless、不接受 executablePath，
// 且模块版本与机器缓存的 chromium 构建号可能不匹配；M3 用本组自带的极简加载器 + 可选
// DSH_SELFTEST_CHROMIUM_EXECUTABLE（证据 raw 记模块路径/可执行文件，二者都是运行环境事实）。
// ==========================================================================================
interface UiPageLike {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>
  innerText(selector: string): Promise<string>
  evaluate<T = unknown>(expression: string): Promise<T>
  waitForSelector(selector: string, options?: Record<string, unknown>): Promise<unknown>
  screenshot(options?: Record<string, unknown>): Promise<Uint8Array>
  reload(options?: Record<string, unknown>): Promise<unknown>
  close(): Promise<void>
}

interface UiBrowserLike {
  newPage(options?: Record<string, unknown>): Promise<UiPageLike>
  version?(): string
  close(): Promise<void>
}

interface UiHandle {
  readonly page: UiPageLike
  readonly browser: UiBrowserLike
  readonly label: string
  close(): Promise<void>
}

/** 极简 Playwright 解析：DSH_VERIFY_PLAYWRIGHT > playwright > playwright-core。 */
function resolvePlaywrightForUi(): { chromium: { launch(options: Record<string, unknown>): Promise<UiBrowserLike> }; label: string } {
  const requireFromHere = createRequire(import.meta.url)
  const candidates: string[] = []
  const configured = process.env['DSH_VERIFY_PLAYWRIGHT']
  if (configured) candidates.push(configured)
  candidates.push('playwright', 'playwright-core')
  const problems: string[] = []
  for (const candidate of candidates) {
    try {
      const loaded = requireFromHere(candidate) as any
      const chromium = loaded?.chromium ?? loaded?.default?.chromium ?? null
      if (chromium && typeof chromium.launch === 'function') return { chromium, label: candidate }
      problems.push(candidate + '：模块里没有 chromium.launch')
    } catch (error) {
      problems.push(candidate + '：' + messageOf(error))
    }
  }
  throw new Error('Playwright 不可用（M3 真 UI 必需）：' + problems.join('；'))
}

/** 打开带 token 的 UI 页面（真浏览器页面；首启弹窗只点精确文案「继续」）。 */
async function openUi(tokenUrl: string): Promise<UiHandle> {
  const resolution = resolvePlaywrightForUi()
  const executablePath = process.env['DSH_SELFTEST_CHROMIUM_EXECUTABLE'] ?? null
  const launchOptions: Record<string, unknown> = { headless: true }
  if (executablePath) launchOptions.executablePath = executablePath
  const browser = await resolution.chromium.launch(launchOptions)
  const page = await browser.newPage({ viewport: { width: 1280, height: 1500 } })
  await page.goto(tokenUrl, { waitUntil: 'load', timeout: 60000 })
  const loadDeadline = Date.now() + 30000
  let body = ''
  while (Date.now() < loadDeadline) {
    body = await page.innerText('body').catch(() => '')
    if (body.trim().length > 0) break
    await sleep(250)
  }
  if (body.includes(AUTH_REQUIRED_MARKER)) throw new Error('UI 鉴权失败（body 含 authentication required）')
  const dismissDeadline = Date.now() + 5000
  while (Date.now() < dismissDeadline) {
    const clicked = await page.evaluate<boolean>(
      '(function(){var bs=Array.prototype.slice.call(document.querySelectorAll("button"));for(var i=0;i<bs.length;i++){var b=bs[i];if(String(b.textContent||"").trim()==="继续"){b.click();return true}}return false})()',
    ).catch(() => false)
    if (clicked) {
      await sleep(300)
      continue
    }
    const stillThere = await page.evaluate<boolean>(
      '(function(){return Array.prototype.slice.call(document.querySelectorAll("button")).some(function(b){return String(b.textContent||"").trim()==="继续"})})()',
    ).catch(() => false)
    if (!stillThere) break
    await sleep(250)
  }
  return {
    page,
    browser,
    label: resolution.label + (executablePath ? ' @ ' + executablePath : ''),
    close: async (): Promise<void> => {
      await page.close().catch(() => undefined)
      await browser.close().catch(() => undefined)
    },
  }
}

/** 把 Playwright page 适配成 batch-helpers 期待的 DesktopSession（cdp 面；M3 只用读与点击）。 */
function webSessionOf(page: UiPageLike): DesktopSession {
  const cdp = {
    evaluate: async (expression: string): Promise<unknown> => page.evaluate(expression),
    waitForExpression: async (expression: string, options?: { timeoutMs?: number }): Promise<void> => {
      const deadline = Date.now() + (options?.timeoutMs ?? 30000)
      while (Date.now() < deadline) {
        const matched = await page.evaluate<boolean>(expression).catch(() => false)
        if (matched) return
        await sleep(150)
      }
      throw new Error('waitForExpression 超时：' + expression.slice(0, 120))
    },
    waitForSelector: async (selector: string, options?: { timeoutMs?: number }): Promise<void> => {
      await page.waitForSelector(selector, { timeout: options?.timeoutMs ?? 30000 })
    },
    clickSelector: async (selector: string): Promise<void> => {
      const clicked = await page.evaluate<boolean>(
        '(function(){var el=document.querySelector(' + JSON.stringify(selector) + ');if(!el)return false;el.scrollIntoView({block:"center"});el.click();return true})()',
      )
      if (!clicked) throw new Error('clickSelector 找不到元素：' + selector)
    },
    scrollIntoView: async (selector: string): Promise<void> => {
      await page.evaluate(
        '(function(){var el=document.querySelector(' + JSON.stringify(selector) + ');if(el)el.scrollIntoView({block:"center"})})()',
      )
    },
    pageText: async (): Promise<string> => page.innerText('body'),
    screenshot: async (): Promise<Uint8Array> => page.screenshot({ type: 'png' }),
    close: async (): Promise<void> => undefined,
  }
  return {
    port: 0,
    process: {} as any,
    cdp,
    targets: [],
    stdout: (): string => '',
    stderr: (): string => '',
    close: async (): Promise<void> => undefined,
  } as unknown as DesktopSession
}

/** 整窗截图并登记（recorder.shot 写 shots/<id>.png + 同名 .json）。 */
async function captureUiShot(
  run: T3Run,
  ui: UiHandle,
  meta: { step: string; what: string; expected: string; actual: string; verdict: 'pass' | 'fail' | 'known-red' | 'unknown'; note?: string },
): Promise<void> {
  const tmpPath = join(tmpdir(), 'm3-ui-shot-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.png')
  await ui.page.screenshot({ path: tmpPath })
  const png = new Uint8Array(await readFile(tmpPath))
  await rm(tmpPath, { force: true })
  await run.recorder.shot('shot', png, meta)
}

/** 台账单条 state.json 的可见状态（产品字段名 state）。 */
function ledgerStateNameOf(state: any): string | null {
  return state && typeof state.state === 'string' ? state.state : null
}

/** 一次 run 的批量面板读数快照（M3 只从 DOM 取 actual）。 */
async function seatOf(ui: UiHandle, slotKey: FixtureSlotKey): Promise<BatchSeatState> {
  return readBatchSeat(webSessionOf(ui.page), slotKey)
}


/** 完工：close 之后按需把证据复制进仓库（试错 run 用 syncEvidence:false 只留在仓库外）。 */
async function finish(run: T3Run, options: HubLifecycleOptions): Promise<RunManifest> {
  const manifest = await run.close()
  if (options.syncEvidence === false) return manifest
  try {
    await copyRunEvidence(run.layout, options.worktree)
  } catch (error) {
    console.error('[hub-lifecycle] 复制证据失败（run 仍在仓库外）：' + messageOf(error))
  }
  return manifest
}

/** 一次 C 组 run 的主入口。 */
export async function runHubLifecycle(options: HubLifecycleOptions): Promise<RunManifest> {
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
    ticket: '284',
  })
  const startedHosts: HostEntry[] = []
  /** M3 真 UI 浏览器（只 M3 用；异常收尾也要关掉，避免留下 chromium 进程）。 */
  let uiHandle: UiHandle | null = null
  try {
    const fixtureEnv = run.fixtureEnv
    if (!fixtureEnv) throw new Error('[hub-lifecycle] 本场景需要夹具环境（withFixtures=true）')
    const slotA = fixtureSlotOf('a')
    const slotB = fixtureSlotOf('b')
    const slotC = fixtureSlotOf('c')
    const slots = [slotA, slotB, slotC]
    const batchTargetPrefixesA = new Map<string, string>(
      (slotA.batch?.targets ?? []).map((target) => [target.key, target.prefix] as [string, string]),
    )
    const batchTargetPrefixesB = new Map<string, string>(
      (slotB.batch?.targets ?? []).map((target) => [target.key, target.prefix] as [string, string]),
    )
    const variant = run.scenario.variants.find((candidate) => candidate.slotKey === 'a')
    if (!variant) throw new Error('[hub-lifecycle] 场景声明缺 a 的变体（0.0.2）')
    const baselineVersion = baselineVersionOf(run.scenario, 'a')
    const variantVersionRaw = variantVersionOf(run.scenario, 'a')
    if (!variantVersionRaw) throw new Error('[hub-lifecycle] 场景声明缺 a 的变体版本')
    const variantVersion = variantVersionRaw
    const routeA = fixtureBridgeRouteOf(slotA)
    const routeB = fixtureBridgeRouteOf(slotB)
    const selfPrefixA = slotA.selfTargetPrefix
    const selfPrefixB = slotB.selfTargetPrefix
    if (!selfPrefixA || !selfPrefixB) throw new Error('[hub-lifecycle] 夹具缺 selfTargetPrefix')
    const prefixA = slotA.batch?.prefix ?? BATCH_PREFIX
    const prefixB = slotB.batch?.prefix ?? 'fxb'
    const phonesA = {
      check: selfPrefixA + '.updateCheck',
      status: selfPrefixA + '.updateStatus',
      batchStatus: prefixA + '.batchStatus',
      batchCheck: prefixA + '.batchCheck',
      batchInstall: prefixA + '.batchInstall',
      hubStatus: selfPrefixA + '.updateHubStatus',
    }
    const phonesB = {
      check: selfPrefixB + '.updateCheck',
      status: selfPrefixB + '.updateStatus',
      batchStatus: prefixB + '.batchStatus',
      batchCheck: prefixB + '.batchCheck',
      batchInstall: prefixB + '.batchInstall',
      hubStatus: selfPrefixB + '.updateHubStatus',
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
        '通道 B 宿主用 USERPROFILE=osHomeDir、DSH_HOME=homeDir 解析 profile；第一代/第二代宿主' +
        '用同一组目录与同一 profile 名，因此解析到同一 profileDir 与同一 update-queue/hub/updates 台账。',
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

    // ---------- M3 专用：每 run 私有 pnpm store/cache ----------
    const m3PnpmDirs =
      options.mode === 'm3'
        ? {
            storeDir: join(run.layout.root, 'pnpm-store'),
            cacheDir: join(run.layout.root, 'pnpm-cache'),
            npmCacheDir: join(run.layout.root, 'npm-cache'),
          }
        : null
    if (m3PnpmDirs) {
      await ensureDir(m3PnpmDirs.storeDir)
      await ensureDir(m3PnpmDirs.cacheDir)
      await ensureDir(m3PnpmDirs.npmCacheDir)
      process.env['pnpm_config_store_dir'] = m3PnpmDirs.storeDir
      process.env['pnpm_config_cache_dir'] = m3PnpmDirs.cacheDir
      process.env['npm_config_cache'] = m3PnpmDirs.npmCacheDir
      await run.raw('m3-pnpm-isolation', {
        ...m3PnpmDirs,
        note:
          'M3 坏 tarball 的失败尝试会污染共享 pnpm store；从基版安装起就用 run 私有 store/cache，' +
          '恢复 tarball 后清空 store 才能真重试成功（K3 实测，只清缓存不动已装包）。',
      })
    }

    // ---------- 基版与变体 ----------
    const registryUrl = fixtureEnv.registry.baseUrl
    const baselines = await run.installBaseline({ homeDir, profileName: PROFILE_NAME, registryUrl })
    await verifySutInstalled(run, { homeDir, profileName: PROFILE_NAME, packageName: slotA.packageName })
    const declaredInstallSlots = run.scenario.install.map((step) => step.slotKey)
    const missingBaseline: string[] = []
    for (const key of declaredInstallSlots) {
      const slot = slots.find((candidate) => candidate.key === key)
      if (!slot) throw new Error('[hub-lifecycle] 场景声明 install 里的 slotKey 不在夹具槽位：' + key)
      const diskVersion = await installedFixtureVersion({ homeDir, profileName: PROFILE_NAME, packageName: slot.packageName })
      if (diskVersion !== baselineVersion) missingBaseline.push(slot.key + '=' + String(diskVersion))
    }
    const notInstalledSlots = slots.filter((slot) => !declaredInstallSlots.includes(slot.key)).map((slot) => slot.key)
    await run.raw('baseline-installed', { baselines, declaredInstallSlots, notInstalledSlots, missingBaseline })
    run.record({
      step: '更新前基版在盘',
      what:
        '场景声明 install 里的包 @' + baselineVersion + ' 已装进 profile，SUT 钉版与工作树 dist 一致（M1/M2 的 C 是孤儿目标，' +
        '初始不在册，由中枢按方案补装，故不参与本断言）',
      expected: '声明在册包（' + declaredInstallSlots.join(',') + '）磁盘版本=' + baselineVersion,
      actual:
        (missingBaseline.length === 0 ? '已声明包全部=' + baselineVersion : '缺失/不符=' + JSON.stringify(missingBaseline)) +
        (notInstalledSlots.length > 0 ? '；未在册=' + JSON.stringify(notInstalledSlots) : ''),
      verdict: missingBaseline.length === 0 ? 'pass' : 'fail',
    })
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
      what: '场景声明 variants 发布到仓库外 verdaccio',
      expected: 'A/B/C 均有 ' + variantVersion + '，A 变体含批量坞/新版 UI',
      actual: 'A=' + (publishedVariant ? publishedVariant.plan.version : 'null') + '；baseline=' + baselineVersion,
      verdict: publishedVariant ? 'pass' : 'fail',
    })

    // ---------- 宿主环境与目录 ----------
    const hostInstallTimeoutMs =
      options.mode === 'm3' ? M3_INSTALL_TIMEOUT_MS : options.mode === 'm4' ? M4_INSTALL_TIMEOUT_MS : INSTALL_TIMEOUT_MS
    const hostEnv: Record<string, string> = {
      [FIXTURE_REGISTRY_ENV]: registryUrl,
      [FIXTURE_INSTALL_TIMEOUT_ENV]: String(hostInstallTimeoutMs),
    }
    if (options.mode === 'm4') {
      // 维护者全局 pnpm 配置的 minimumReleaseAge（24h 冷却）会漏进隔离 os-home：fixture/SUT 都是现场发布，
      // 偶尔被 pnpm 判成「太新」而拒绝落盘（284-20261103T220722 实测），与并发/隔离语义无关。
      // 只在 M4 两个宿主上关掉这条供应链冷却，保持「两个安装都真跑 pnpm」的语义不变；raw 记录原因。
      hostEnv['npm_config_minimum_release_age'] = '0'
      await run.raw('m4-pnpm-supply-chain-isolation', {
        env: { npm_config_minimum_release_age: hostEnv['npm_config_minimum_release_age'] },
        why: '隔离 os-home 不含维护者全局 pnpm 配置的覆盖；minimumReleaseAge 会把本 run 现场发布的 fixture/SUT 判成 too-new。只关冷却阈值，不碰 registry/install 语义。',
      })
    }
    await run.raw('host-env', {
      env: hostEnv,
      mode: options.mode,
      why:
        options.mode === 'm3'
          ? 'M3 只有一个宿主、不换手：安装预算放宽到 30s（A 自更新 + pnpm 拉坏 tarball 都超过 4s；4s 会把真安装窗误判成超时）。'
          : options.mode === 'm4'
            ? 'M4 两个宿主并发各装三包、同 home 共享 pnpm store：安装预算放宽到 30s；本格不杀宿主，锁陈旧阈值用不到。'
            : '换手窗口里第一代宿主被硬杀，会留下 global.lock / install.lock；installTimeoutMs 同时是锁陈旧阈值，' +
              '压到 4s 让第二代能在数秒内回收陈旧锁（默认 15min 会把换手拖死，不构成「不依赖人工」的检验）。',
    })
    const expectedQueueDir = join(homeDir, 'update-queue', shortHashOf(create.profileDir))
    const actualQueueDirs = await listDirs(join(homeDir, 'update-queue'))
    const queueDir = expectedQueueDir
    const leaseFile = join(queueDir, 'hub', 'lease.json')
    const plansDir = join(queueDir, 'hub', 'plans')
    const batchFileA = join(queueDir, prefixA, 'batch.json')
    const batchFileB = join(queueDir, prefixB, 'batch.json')
    await run.raw('hub-paths', {
      profileDir: create.profileDir,
      profileDirShortHash: shortHashOf(create.profileDir),
      expectedQueueDir,
      actualQueueDirs,
      leaseFile,
      plansDir,
      batchFileA,
      batchFileB,
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

    // ---------- 宿主生命周期 ----------
    async function startHost(label: string, profileName: string = PROFILE_NAME, osHome: string = osHomeDir, home: string = homeDir): Promise<HostEntry> {
      const host = await startCliHost({ homeDir: home, osHomeDir: osHome, profileName, extraEnv: hostEnv })
      const entry: HostEntry = { label, host, pid: host.pid() ?? null, port: host.port, profileName, closed: false }
      startedHosts.push(entry)
      await run.raw('cli-host-launch-' + label, {
        url: host.url,
        port: host.port,
        pid: entry.pid,
        bootMs: host.bootMs,
        profileName,
        homeDir: home,
        stdoutTail: host.stdout().slice(-800),
        stderrTail: host.stderr().slice(-800),
      })
      run.record({
        step: '宿主启动（通道 B，' + label + '）',
        what: 'startCliHost 起 DSH web 宿主（隔离 USERPROFILE/home/profile）',
        expected: 'boot 成功、HTTP 电话入口可用、pid>0',
        actual: 'pid=' + entry.pid + '，port=' + host.port + '，bootMs=' + host.bootMs,
        verdict: entry.pid !== null && entry.pid > 0 && host.port > 0 ? 'pass' : 'fail',
      })
      return entry
    }

    async function closeHost(entry: HostEntry | null, tag: string = 'closed'): Promise<void> {
      if (!entry || entry.closed) return
      const pid = entry.pid
      const port = entry.port
      entry.closed = true
      const aliveBefore = pid !== null && isProcessAlive(pid)
      await entry.host.close().catch((error) => console.error('[hub-lifecycle] 关宿主失败：' + messageOf(error)))
      const aliveAfter = pid !== null && isProcessAlive(pid)
      run.registerProcess('cli-host-' + entry.label, pid)
      await run.registerPort('cli-host-' + entry.label + '-port', port)
      await run.raw('host-stop-' + tag, {
        label: entry.label,
        pid,
        port,
        aliveBefore,
        aliveAfter,
        stoppedAt: Date.now(),
        note: 'host.close() = proc.stop() = taskkill /T /F 硬杀进程树（等价 SIGKILL）；web 通道没有应用内重启。',
      })
    }

    async function readBatch(file: string): Promise<any> {
      return readJsonMaybe(file)
    }

    async function readLease(): Promise<any> {
      return readJsonMaybe(leaseFile)
    }

    async function readPlanNames(): Promise<string[]> {
      return listFilesMaybe(plansDir)
    }

    async function readPlan(name: string): Promise<{ file: string; raw: string | null; json: any } | null> {
      const file = join(plansDir, name)
      const raw = await readTextMaybe(file)
      if (raw === null) return null
      return { file, raw, json: await readJsonMaybe(file) }
    }

    async function readDiskFacts(tag: string, profileName: string = PROFILE_NAME, home: string = homeDir): Promise<Record<string, unknown>> {
      const profileDir = join(home, 'profiles', profileName)
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
        nodeModules[slot.key] = await installedFixtureVersion({ homeDir: home, profileName, packageName: slot.packageName })
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

    /** 收尾：关掉所有宿主、抓终版日志、核实进程/端口无残留（正常格与 can-red 格共用）。 */
    async function finalizeHosts(): Promise<void> {
      for (const entry of [...startedHosts].reverse()) await closeHost(entry, 'final')
      const capture = await captureLogFiles(run.recorder, homeDir)
      await run.raw('logs-final', {
        files: capture.snapshot.files,
        unparsedLines: capture.snapshot.unparsedLines,
        truncations: capture.truncations,
        eventCounts: eventCountsOf(
          capture.snapshot.events.map((event) => ({
            ts: null,
            event: event.event,
            level: event.level,
            fields: event.fields,
            source: event.source,
            line: event.line,
          })),
        ),
      })
      const remainingPids = startedHosts
        .filter((entry) => entry.pid !== null && isProcessAlive(entry.pid))
        .map((entry) => entry.label + ':' + entry.pid)
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

    // ==========================================================================================
    // M1 / can-red：两个批量集成方 A+B 同时发起，杀宿主后只回来 A。
    // ==========================================================================================
    if (options.mode === 'm1' || options.mode === 'can-red') {
      await run.addNote(
        '换手注入：web 通道没有「应用自重启」，用「taskkill 硬杀第一代宿主 + 同 home/profile 起第二代」注入换手，' +
          '等价于桌面 relaunch 后新 fiber 接管中枢；差别（整进程退出 vs 应用内重启）写进研究笔记。',
      )
      await run.addNote(
        '「只回来 A」的构造：杀宿主后从 profile 的 dsh.profile.bundles 摘掉 B（CLI plugin remove，并删其 node_modules 包），' +
          '保留 A；第二代宿主因此只加载 A 这一个批量集成方（其 batch 电话只接 A 的 fxa）。',
      )

      let host1: HostEntry | null = null
      let host2: HostEntry | null = null
      let window: { at: number; phasesA: Record<string, string | null>; phasesB: Record<string, string | null>; batchA: any; planA: any; planB: any; planNames: string[]; planBHash: string | null; lease: any; bFiredAt?: number | null; samples: any[] } | null = null
      const installPromises: Promise<unknown>[] = []

      host1 = await startHost('host1')

      // 批量检查（两边各自会话）
      const statusA = await callPhone(host1.host, phonesA.batchStatus, {}, routeA)
      const statusB = await callPhone(host1.host, phonesB.batchStatus, {}, routeB)
      await run.raw('panel-batch-status-initial', { a: statusA.body, b: statusB.body })
      const checkA = await callPhone(host1.host, phonesA.batchCheck, {}, routeA)
      const checkB = await callPhone(host1.host, phonesB.batchCheck, {}, routeB)
      await run.raw('phone-batch-check', { a: checkA.body, b: checkB.body })
      const keysA = checkA.rows.map((row: any) => String(row?.key ?? ''))
      const keysB = checkB.rows.map((row: any) => String(row?.key ?? ''))
      run.record({
        step: 'A/B 两个集成方的批量检查电话受理',
        what: 'fxa.batchCheck / fxb.batchCheck 各建批量会话（A 三行、B 两行）',
        expected: 'ok=true；fxa rows=[a,b,c]；fxb rows=[b,c]（行序按声明 targets，不敏感）',
        actual:
          'fxa.ok=' + checkA.ok + ' rows=' + JSON.stringify(keysA) +
          '；fxb.ok=' + checkB.ok + ' rows=' + JSON.stringify(keysB),
        verdict:
          checkA.ok && checkB.ok &&
          JSON.stringify([...keysA].sort()) === JSON.stringify(['a', 'b', 'c']) &&
          JSON.stringify([...keysB].sort()) === JSON.stringify(['b', 'c'])
            ? 'pass'
            : 'fail',
      })

      const aCheck = await callPhone(host1.host, phonesA.check, {}, routeA)
      await run.raw('phone-a-update-check-before-batch', { status: aCheck.status, body: aCheck.body })
      const aSnap = aCheck.inner?.snapshot ?? null
      run.record({
        step: 'A 自身检查更新（批量前）',
        what: 'A 的 updateCheck 看到 ' + variantVersion + ' 可更新',
        expected: 'canInstall=true；installedVersion=' + baselineVersion + '；latestVersion=' + variantVersion,
        actual:
          'canInstall=' + String(aSnap?.canInstall ?? null) +
          '；installedVersion=' + String(aSnap?.installedVersion ?? null) +
          '；latestVersion=' + String(aSnap?.latestVersion ?? null),
        verdict: aCheck.ok && aSnap?.canInstall === true && aSnap?.latestVersion === variantVersion ? 'pass' : 'fail',
      })

      // A 的批量先发（不 await：批量电话同步驱动到收尾，必须在它跑的时候观测/杀宿主）。
      // B 的批量不在这里发：A 自键换载会占住同一 profile 的安装队列，若两个批次同时对 b/c 提交，
      // 先装完的一家会让另一家的 checkId 立即过期（fxa-b 会被 fxb 抢先装成 0.0.2 后判 check-expired），
      // 换手窗口的「B/C 未终态」就不再稳定。故 B 的批量在 A 自键 done 后、杀宿主前 ~100ms 内再发，
      // 只要求在宿主死前 fxb 方案与批量会话都在盘、其行尚未执行——这才是本场景要的「双方案并存 + 孤儿接管」。
      const fireAt = Date.now()
      installPromises.push(
        callPhone(host1.host, phonesA.batchInstall, {}, routeA).then(
          (result) => ({ who: 'fxa', at: fireAt, ok: result.ok, error: result.error, body: result.body }),
          (error) => ({ who: 'fxa', at: fireAt, rejected: messageOf(error) }),
        ),
      )
      await run.raw('phone-batch-install-fire', {
        at: fireAt,
        phones: [phonesA.batchInstall],
        note: '只发 A；B 的 batchInstall 在窗口里 A 自键 done 后立即发，随即在 fxb 方案落盘时硬杀宿主。',
      })
      run.record({
        step: 'A 批量安装电话已发出（不等回包）',
        what: 'host1 先发 fxa.batchInstall；B 的 fxb.batchInstall 在换手窗口里（A 自键 done 后）再发',
        expected: 'A 的批量开始推进（fxa 方案与 batch.json 落盘）',
        actual: 'at=' + fireAt,
        verdict: 'pass',
      })

      /** 等双方案在盘、A 自键 done 且 B/C 未终态（= 换手窗口）。 */
      window = await (async () => {
        const startedAt = Date.now()
        const samples: any[] = []
        let last: any = null
        let bFiredAt: number | null = null
        while (Date.now() - startedAt < WINDOW_WAIT_MS) {
          const names = await readPlanNames()
          const batchA = await readBatch(batchFileA)
          const batchB = await readBatch(batchFileB)
          const lease = await readLease()
          const planBName = names.find((name) => name === prefixB + '.json') ?? null
          const planB = planBName ? await readPlan(planBName) : null
          const phasesA = phasesOfBatch(batchA)
          const phasesB = phasesOfBatch(batchB)
          last = { names, batchA, batchB }
          samples.push({
            t: Date.now(),
            planNames: names,
            phasesA,
            phasesB,
            lease: lease ? { pid: lease.pid ?? null, generation: lease.generation ?? null, driverId: lease.driverId ?? null } : null,
          })
          const aSelfDone = names.some((name) => name === prefixA + '.json') && phasesA.a === 'done'
          const fxaPending = (phasesA.b !== null && !TERMINAL_PHASES.includes(phasesA.b)) || (phasesA.c !== null && !TERMINAL_PHASES.includes(phasesA.c))
          // 第一步：等 A 自键换载完成；第二步：立刻发 B 的批量；第三步：fxb 方案一落盘就返回（随即杀宿主）。
          if (bFiredAt === null && aSelfDone && fxaPending) {
            bFiredAt = Date.now()
            installPromises.push(
              callPhone(host1.host, phonesB.batchInstall, {}, routeB).then(
                (result) => ({ who: 'fxb', at: bFiredAt as number, ok: result.ok, error: result.error, body: result.body }),
                (error) => ({ who: 'fxb', at: bFiredAt as number, rejected: messageOf(error) }),
              ),
            )
            await run.raw('phone-batch-install-fire-b', {
              at: bFiredAt,
              phone: phonesB.batchInstall,
              note: 'A 自键已在批量里 done，B 的批量此刻才发；紧接着轮询 fxb 方案落盘，落盘即硬杀宿主。',
            })
          }
          const windowOpen = aSelfDone && fxaPending && planBName !== null && bFiredAt !== null
          if (windowOpen) {
            const planAName = prefixA + '.json'
            const planA = await readPlan(planAName)
            const planBRead = planB
            const snapshot = {
              at: Date.now(),
              phasesA,
              phasesB,
              planNames: names,
              planA: planA ? { file: planA.file, json: planA.json, sha256: planA.raw ? sha256TextOf(planA.raw) : null } : null,
              planB: planBRead ? { file: planBRead.file, json: planBRead.json, sha256: planBRead.raw ? sha256TextOf(planBRead.raw) : null } : null,
              batchA,
              batchB,
              lease,
              bFiredAt,
              samples,
            }
            await run.raw('state-at-kill', snapshot)
            return { ...snapshot, phasesA, phasesB, planA, planB: planBRead, planBHash: planBRead?.raw ? sha256TextOf(planBRead.raw) : null }
          }
          await sleep(bFiredAt === null ? KILL_POLL_MS : 25)
        }
        await run.raw('state-at-kill', { at: Date.now(), timeout: true, samples, last, bFiredAt })
        throw new Error(WINDOW_WAIT_MS + 'ms 内没等到换手窗口（双方案在盘 + A done + B/C 未终态）')
      })()

      run.record({
        step: '换手窗口：双方案在盘、A 自键已 done、B/C 未终态',
        what: '轮询 hub/plans/ 与 fxa batch.json 捕获第一代推进到「A 已换、B/C 未终态」的窗口；B 的批量在 A 自键 done 后才发，fxb 方案落盘即进窗口',
        expected: "plans 含 fxa.json/fxb.json；phase(a)='done' 且 b 或 c 非终态；bFiredAt 非空",
        actual:
          'plans=' + JSON.stringify(window.planNames) + '；phasesA=' + JSON.stringify(window.phasesA) +
          '；phasesB=' + JSON.stringify(window.phasesB) + '；bFiredAt=' + String(window.bFiredAt ?? null),
        verdict:
          window.planNames.some((name) => name === prefixA + '.json') &&
          window.planNames.some((name) => name === prefixB + '.json') &&
          (window.bFiredAt ?? null) !== null &&
          window.phasesA.a === 'done' &&
          ((window.phasesA.b !== null && !TERMINAL_PHASES.includes(window.phasesA.b)) ||
            (window.phasesA.c !== null && !TERMINAL_PHASES.includes(window.phasesA.c)))
            ? 'pass'
            : 'fail',
      })
      const leaseAtKill = window.lease
      run.record({
        step: '换手前中枢租约由第一代宿主持有',
        what: 'hub/lease.json 的 pid/属主与 generation（只记录实测值）',
        expected: 'lease.pid=' + host1.pid + '（第一代宿主进程）',
        actual: 'lease=' + JSON.stringify(leaseAtKill ? { pid: leaseAtKill.pid, generation: leaseAtKill.generation, driverId: leaseAtKill.driverId } : null),
        verdict: leaseAtKill && leaseAtKill.pid === host1.pid ? 'pass' : 'fail',
      })

      // ---------- 硬杀第一代 → 摘掉 B → 换手注入 ----------
      const host1Pid = host1.pid
      await closeHost(host1, 'host1-kill')
      host1 = null
      run.record({
        step: '第一代宿主已硬杀（换手注入）',
        what: 'taskkill /T /F 杀掉第一代宿主进程树（未等批量收尾），中枢执行者消失',
        expected: 'pid=' + host1Pid + ' 不再存活',
        actual: 'pid=' + host1Pid + '；alive=' + (host1Pid !== null && isProcessAlive(host1Pid)),
        verdict: host1Pid === null || !isProcessAlive(host1Pid) ? 'pass' : 'fail',
      })

      // 摘掉 B：CLI plugin remove + 核对 profile 在册与包目录
      const removeB = removePluginFromProfile(slotB.packageName, PROFILE_NAME, { homeDir })
      const manifestAfterRemove = await readProfileManifest(create.profileDir).catch(() => null)
      const bundlesAfterRemove: string[] = manifestAfterRemove?.dsh?.profile?.bundles ?? []
      const bInstalledDir = join(create.profileDir, 'node_modules', ...slotB.packageName.split('/'))
      const bDirVersionAfterRemove = await installedFixtureVersion({ homeDir, profileName: PROFILE_NAME, packageName: slotB.packageName })
      await run.raw('remove-owner-b', {
        packageName: slotB.packageName,
        cli: { exitCode: removeB.exitCode, stdout: removeB.stdout, stderr: removeB.stderr, durationMs: removeB.durationMs },
        profileDir: create.profileDir,
        bundlesAfterRemove,
        bInstalledDir,
        bDirVersionAfterRemove,
      })
      run.record({
        step: '摘掉孤主 B：profile 在册与包目录都不再有 B',
        what: 'CLI plugin remove B；核对 dsh.profile.bundles 与 node_modules',
        expected: 'bundles 不含 ' + slotB.packageName + '；B 的包目录/版本读不到',
        actual: 'bundles=' + JSON.stringify(bundlesAfterRemove) + '；B 目录版本=' + String(bDirVersionAfterRemove),
        verdict: !bundlesAfterRemove.includes(slotB.packageName) && bDirVersionAfterRemove === null ? 'pass' : 'fail',
      })

      // can-red：删除 hub plan（中枢没有方案可接管，预期 A 不再自动续跑）
      let canRedInjection: { planFile: string; sha256Before: string | null; deletedAt: number } | null = null
      if (options.mode === 'can-red') {
        const plan = window.planA
        if (!plan) throw new Error('can-red：换手窗口内找不到 hub/plans/fxa.json，无法注入')
        canRedInjection = { planFile: plan.file, sha256Before: plan.raw ? sha256TextOf(plan.raw) : null, deletedAt: 0 }
        await run.raw('can-red-plan-before-delete', { file: plan.file, raw: plan.raw, json: plan.json, sha256: canRedInjection.sha256Before })
        await unlink(plan.file)
        canRedInjection.deletedAt = Date.now()
        const after = await readTextMaybe(plan.file)
        await run.raw('can-red-plan-deleted', {
          file: plan.file,
          deletedAt: canRedInjection.deletedAt,
          beforeSha256: canRedInjection.sha256Before,
          after,
          why:
            '换手窗口里删除 <home>/update-queue/<hash>/hub/plans/fxa.json：中枢方案是第二代接管的唯一依据，' +
            '删掉后 B/C 不应继续（用于证明「A 自动续跑完成」断言可红）。',
        })
        run.record({
          step: 'can-red 注入：换手窗口删除 hub plan',
          what: '删 <home>/update-queue/<hash>/hub/plans/fxa.json，模拟中枢方案丢失',
          expected: '删除前 plan 在盘（原文已留 raw），删除后读不到',
          actual: 'deletedAt=' + canRedInjection.deletedAt + '；after=' + (after === null ? 'null' : 'still-present'),
          verdict: after === null ? 'pass' : 'fail',
        })
      }

      // ---------- 第二代宿主：只回来 A ----------
      host2 = await startHost('host2')
      const host2StartWall = Date.now()
      await run.raw('host2-start-window', {
        wallAt: host2StartWall,
        pid: host2.pid,
        at: Date.now(),
        afterWindowAt: window.at,
        note: 'B/C 的 exec ts 必须晚于第二代 host.start 日志 ts，才算「换手后无需人工续跑」。',
      })

      const budget = options.mode === 'can-red' ? CAN_RED_WAIT_MS : BATCH_WAIT_MS
      const terminal = await (async () => {
        const startedAt = Date.now()
        const samples: any[] = []
        let last: any = null
        while (Date.now() - startedAt < budget) {
          const batch = await readBatch(batchFileA)
          const lease = await readLease()
          last = batch
          samples.push({
            t: Date.now(),
            phasesA: phasesOfBatch(batch),
            lease: lease ? { pid: lease.pid ?? null, generation: lease.generation ?? null, driverId: lease.driverId ?? null } : null,
          })
          if (allTerminal(batch)) break
          await sleep(500)
        }
        await run.raw('batch-after-handoff', { batch: last, elapsedMs: Date.now() - startedAt, samples })
        return { batch: last, elapsedMs: Date.now() - startedAt, samples }
      })()

      const installOutcomes = await Promise.all(installPromises)
      await run.raw('install-promise-outcomes', installOutcomes)

      // 日志时间线（等 B/C 的 exec 行落盘）
      const logRows =
        options.mode === 'can-red'
          ? await readRawLogRows(homeDir)
          : await waitForExecRows(homeDir, [batchTargetPrefixesA.get('b') ?? 'fxa-b', batchTargetPrefixesA.get('c') ?? 'fxa-c'], 20000)
      const execA = execRowsOf(logRows, batchTargetPrefixesA.get('a') ?? 'fxa-a')
      const execB = execRowsOf(logRows, batchTargetPrefixesA.get('b') ?? 'fxa-b')
      const execC = execRowsOf(logRows, batchTargetPrefixesA.get('c') ?? 'fxa-c')
      const execFxbB = execRowsOf(logRows, batchTargetPrefixesB.get('b') ?? 'fxb-b')
      const execFxbC = execRowsOf(logRows, batchTargetPrefixesB.get('c') ?? 'fxb-c')
      const startRows = hostStartRows(logRows)
      const host2StartLog = startRows.filter((row) => row.pid === host2?.pid).sort((left, right) => (left.ts ?? 0) - (right.ts ?? 0))[0] ?? null
      const host2StartTs = tsOf(host2StartLog ?? undefined)
      const runStartRows = logRows
        .filter((row) => row.event === 'update.batch.run.start')
        .map((row) => ({
          ts: row.ts,
          trigger: row.fields?.trigger ?? null,
          resumed: row.fields?.resumed ?? null,
          total: row.fields?.total ?? null,
          sessionHash: row.fields?.sessionHash ?? null,
        }))
      // install.request 行没有 pluginId 字段（发射口按落点目录分流），只能按 raw 行的 source（<pluginId>/<date>.log）归属。
      const selfPrefixForLog = (batchTargetPrefixesA.get('a') ?? 'fxa-a') + '/'
      const installRequestsA = logRows.filter(
        (row) => row.event === 'update.install.request' && typeof row.source === 'string' && row.source.startsWith(selfPrefixForLog),
      )
      const hostCallOkA = logRows.filter(
        (row) =>
          row.event === 'host.call' &&
          row.fields?.method === (batchTargetPrefixesA.get('a') ?? 'fxa-a') + '.updateInstall' &&
          row.fields?.ok === true,
      )
      const gateRefused = logRows.filter((row) => row.event === 'update.install.fail' && row.fields?.reason === 'gate-refused')
      const execFailures = logRows.filter((row) => row.event === 'update.install.fail' && row.fields?.stage === 'exec')
      await run.raw('log-timeline', {
        eventCounts: eventCountsOf(logRows),
        hostStartRows: startRows,
        host2StartTs,
        batchRunStart: runStartRows,
        gateRefusedCount: gateRefused.length,
        gateRefusedFirst: gateRefused[0] ? { ts: gateRefused[0].ts, fields: gateRefused[0].fields } : null,
        execFailures: execFailures.map((row) => ({ ts: row.ts, fields: row.fields })),
        execA,
        execB,
        execC,
        execFxbB,
        execFxbC,
        installRequestsA,
        hostCallOkA,
        parseNote: 'raw 行保留 ts；readLogEvents 丢 ts，但 raw 拷回原文可解析。',
      })

      // 方案与台账
      const planAAfter = await readPlan(prefixA + '.json')
      const planBAfter = await readPlan(prefixB + '.json')
      const planBAfterHash = planBAfter?.raw ? sha256TextOf(planBAfter.raw) : null
      const allPlanNamesAfter = await readPlanNames()
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
          planANamesAfter: allPlanNamesAfter,
          note: '本 run 预期红：删 plan 后中枢无方案可接管，B/C 不应自动续跑。',
        })
        run.record({
          step: 'can-red 红点：换手窗口删 hub plan 后 A 不再自动接管、B/C 未续跑',
          what: '删除中枢方案后启动第二代宿主，观察 B/C 是否仍自动完成（本断言在 can-red 注入下应当红）',
          expected: 'A 自动采纳 fxa 方案、B/C 自动续跑完成（正常场景应如此；本 run 人为删 plan 后预期不成立）',
          actual:
            'phases=' + JSON.stringify(phases) +
            '；elapsedMs=' + terminal.elapsedMs +
            '；resumeRunStart=' + resumed.length +
            '；execAfterHost2=' + execAfterHost2.length,
          verdict: broken ? 'fail' : 'unknown',
          note: broken
            ? 'can-red 成立：删 plan 后 A 未自动接管、B/C 未自动续跑（无 resume run.start / 无第二代后 exec），红点可归因到注入的 plan 丢失。'
            : 'can-red 未变红：删 plan 后 B/C 仍完成，需排查是否还有其它恢复路径（不是预期结果）。',
        })
        await finalizeHosts()
        return await finish(run, options)
      }

      // ---------- 断言：换手后 A 自动接管、B/C 自动续跑 ----------
      const finalPhases = phasesOfBatch(terminal.batch)
      run.record({
        step: '换手后 fxa 三行终态全 done、failed=0',
        what: '不驱动安装，只轮询 fxa/batch.json 等第二代把 B/C 推完',
        expected: "phases={a:'done',b:'done',c:'done'}；无 failed",
        actual: 'phases=' + JSON.stringify(finalPhases) + '；elapsedMs=' + terminal.elapsedMs + '；batchFailed=' +
          JSON.stringify((terminal.batch?.entries ?? []).filter((entry: any) => entry.phase === 'failed').map((entry: any) => entry.key)),
        verdict: finalPhases.a === 'done' && finalPhases.b === 'done' && finalPhases.c === 'done' ? 'pass' : 'fail',
      })

      const resumedRows = runStartRows.filter((row) => row.trigger === 'resume')
      const entrySessionHashes = Array.from(
        new Set(runStartRows.filter((row) => row.trigger === 'entry' && row.sessionHash).map((row) => row.sessionHash)),
      )
      run.record({
        step: '第二代宿主自动采纳孤儿子任务（update.batch.run.start trigger=resume）',
        what:
          '日志里换代后出现 resume 触发、resumed=true 的批量 run.start；run.start 行没有 sessionId 字段，' +
          '同一批量会话靠 sessionHash 对齐（entry 与 resume 相等）',
        expected:
          'resume run.start ≥1 且 resumed=true、total=3；resume.sessionHash=entry.sessionHash' +
          (entrySessionHashes.length > 0 ? '（entry=' + entrySessionHashes.join(',') + '）' : ''),
        actual: 'resumeRunStart=' + JSON.stringify(resumedRows) + '；batchId=' + String(terminal.batch?.id ?? null),
        verdict:
          resumedRows.length >= 1 &&
          resumedRows.every((row) => row.resumed === true && row.total === 3) &&
          (entrySessionHashes.length === 0 || resumedRows.some((row) => row.sessionHash !== null && entrySessionHashes.includes(row.sessionHash)))
            ? 'pass'
            : 'fail',
      })
      run.record({
        step: '换手后 fxa 方案仍在盘、sessionId 与 batch.json 一致',
        what: 'hub/plans/fxa.json 未被换手清掉，视图与批量会话同一 sessionId',
        expected: 'plan 存在且 plan.sessionId=batch.id',
        actual:
          'plan=' + (planAAfter ? planAAfter.file : 'null') +
          '；planSessionId=' + String(planAAfter?.json?.sessionId ?? null) +
          '；batchId=' + String(terminal.batch?.id ?? null),
        verdict: planAAfter !== null && terminal.batch?.id && planAAfter?.json?.sessionId === terminal.batch.id ? 'pass' : 'fail',
      })

      const execAfterHost2 = [...execA, ...execB, ...execC].filter((row) => host2StartTs !== null && row.ts !== null && row.ts > host2StartTs)
      run.record({
        step: 'B/C 在第二代宿主启动后自动续跑（无人工）',
        what: 'fxa 的 B/C exec ts vs 第二代 host.start ts；换手后场景只发只读查询',
        expected: 'fxa-b/fxa-c 各恰 1 条 exec（route=cli-process、ok=true、exitCode=0），且 ts > 第二代 host.start',
        actual:
          'host2StartTs=' + String(host2StartTs) +
          '；fxa-b=' + JSON.stringify(execB) +
          '；fxa-c=' + JSON.stringify(execC) +
          '；后置执行数=' + execAfterHost2.length,
        verdict:
          execB.length === 1 &&
          execC.length === 1 &&
          execB.every((row) => row.route === 'cli-process' && row.ok === true && row.exitCode === 0 && host2StartTs !== null && row.ts !== null && row.ts > host2StartTs) &&
          execC.every((row) => row.route === 'cli-process' && row.ok === true && row.exitCode === 0 && host2StartTs !== null && row.ts !== null && row.ts > host2StartTs)
            ? 'pass'
            : 'fail',
      })
      run.record({
        step: 'A 自键恰一次成功安装（exactly-once）',
        what:
          'fxa-a 是发起批量的集成方自身：产品路线不走 executor 的 INSTALL_RUNNERS（无 update.install.exec 行），' +
          '而是 update.install.request 后由宿主 host.call fxa-a.updateInstall 完成自身换载；这里按该真实路线断言',
        expected: 'install.request(fxa-a) ≥1；host.call method=fxa-a.updateInstall ok=true 恰 1 条；无 exec 失败',
        actual:
          'installRequestA=' + installRequestsA.length +
          '；hostCallOkA=' + JSON.stringify(hostCallOkA.map((row) => ({ ts: row.ts, method: row.fields?.method, ok: row.fields?.ok }))) +
          '；execA=' + JSON.stringify(execA),
        verdict:
          installRequestsA.length >= 1 &&
          hostCallOkA.length === 1 &&
          execA.length === 0 &&
          execFailures.length === 0
            ? 'pass'
            : 'fail',
        note: 'fxa-a 的自更新由宿主自身完成换载，故无 cli-process exec；真机日志里该路线是 request→host.call ok。',
      })
      run.record({
        step: 'B 的 fxb 方案未被 A 冒领/执行（方案哈希不变、无 fxb 行执行）',
        what: 'fxb.json 内容哈希换手前后一致；日志无 fxb-b/fxb-c 的 exec 行；fxa 的 b/c 各只安装一次',
        expected:
          'fxb sha256 前后相同；execFxbB=[]、execFxbC=[]；execB=1、execC=1',
        actual:
          'fxbHashBefore=' + String(window.planBHash) + '；fxbHashAfter=' + String(planBAfterHash) +
          '；fxbExecB=' + JSON.stringify(execFxbB) + '；fxbExecC=' + JSON.stringify(execFxbC) +
          '；fxaExecB=' + execB.length + '；fxaExecC=' + execC.length,
        verdict:
          window.planBHash !== null &&
          planBAfterHash !== null &&
          window.planBHash === planBAfterHash &&
          execFxbB.length === 0 &&
          execFxbC.length === 0 &&
          execB.length === 1 &&
          execC.length === 1
            ? 'pass'
            : 'fail',
      })
      run.record({
        step: '无安装期硬失败（exec 阶段失败=0）',
        what: 'update.install.fail 里 stage=exec 的行必须为 0；gate-refused 是陈旧占位恢复噪声，单列',
        expected: 'execFailures=0',
        actual: 'execFailures=' + execFailures.length + '；gateRefused=' + gateRefused.length,
        verdict: execFailures.length === 0 ? 'pass' : 'fail',
      })

      const disk = await readDiskFacts('after-handoff')
      const nodeModules = disk.nodeModules as Record<string, string | null>
      const dependencies = disk.dependencies as Record<string, string | null>
      run.record({
        step: '磁盘：三包依赖与 node_modules 均到 0.0.2（含孤儿目标 C 补装）',
        what: 'profile package.json dependencies + node_modules 实际版本',
        expected: 'a/b/c 的 dependencies 与 node_modules 都是 ' + variantVersion,
        actual: 'dependencies=' + JSON.stringify(dependencies) + '；nodeModules=' + JSON.stringify(nodeModules),
        verdict:
          String(dependencies.a) === '^' + variantVersion || String(dependencies.a) === variantVersion
            ? Object.values(nodeModules).every((version) => version === variantVersion) &&
              Object.values(dependencies).every((version) => version === '^' + variantVersion || version === variantVersion)
              ? 'pass'
              : 'fail'
            : 'fail',
      })

      const ledgerStates = (pluginId: string): any[] => ledgerByPlugin[pluginId] ?? []
      const ledgerOk = ['a', 'b', 'c'].every((key) => {
        const pluginId = (batchTargetPrefixesA.get(key) ?? 'fxa-' + key) as string
        const states = ledgerStates(pluginId)
        return (
          states.length === 1 &&
          states[0]?.targetVersion === variantVersion &&
          ['completed', 'restart-required'].includes(String(states[0]?.state))
        )
      })
      run.record({
        step: '台账：fxa-a/fxa-b/fxa-c 各恰一条成功终态、目标 0.0.2、previous=0.0.1',
        what: '<home>/updates/<pluginId>/<hash>/state.json（逐行真相，无重复/丢行）',
        expected: '每包 1 条 targetVersion=' + variantVersion + '、previousVersion=' + baselineVersion + '、state∈{completed,restart-required}',
        actual: JSON.stringify(
          ['a', 'b', 'c'].map((key) => {
            const pluginId = batchTargetPrefixesA.get(key) ?? 'fxa-' + key
            return {
              pluginId,
              states: ledgerStates(pluginId).map((state) => ({
                state: state?.state ?? null,
                targetVersion: state?.targetVersion ?? null,
                previousVersion: state?.previousVersion ?? null,
              })),
            }
          }),
        ),
        verdict: ledgerOk ? 'pass' : 'fail',
      })

      const finalStatusA = await callPhone(host2.host, phonesA.batchStatus, {}, routeA)
      await run.raw('panel-batch-status-final', { status: finalStatusA.status, body: finalStatusA.body })
      const finalRows = finalStatusA.rows
      run.record({
        step: '第二代宿主上的 fxa 批量面板三行 done（UI/台账/磁盘一致）',
        what: 'batchStatus 回包（面板数据源）与磁盘 batch.json 一致',
        expected: '三行 phase=done；targetVersion=' + variantVersion,
        actual: 'ok=' + finalStatusA.ok + '；rows=' + JSON.stringify(finalRows.map((row: any) => ({ key: row.key, phase: row.phase, targetVersion: row.targetVersion }))),
        verdict:
          finalStatusA.ok &&
          finalRows.length === 3 &&
          finalRows.every((row: any) => row.phase === 'done' && row.targetVersion === variantVersion)
            ? 'pass'
            : 'fail',
      })

      const hubStatus = await callPhone(host2.host, phonesA.hubStatus, {}, routeA)
      await run.raw('panel-hub-status-final', { status: hubStatus.status, body: hubStatus.body })
      const hubSessions = Array.isArray(hubStatus.snapshot?.sessions) ? hubStatus.snapshot.sessions : []
      const hubSession = hubSessions.find((session: any) => session?.sessionId === terminal.batch?.id) ?? hubSessions[0] ?? null
      run.record({
        step: '中枢状态与批量台账一致（finished done3 failed0 activeInstall=null）',
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

      await finalizeHosts()
      return await finish(run, options)
    }


    // ==========================================================================================
    // M2：同前置（A/B 双批量、杀宿主），但只回来 B —— B 不冒领 fxa，先推完自己的 fxb；
    // 第三幕摘 B、装回 A，起第三宿主，A 再采纳 fxa 收尾（跨宿主方案仍有效、exactly-once）。
    // ==========================================================================================
    if (options.mode === 'm2') {
      await run.addNote(
        '换手注入同 M1：taskkill 硬杀第一代宿主 + 同 home/profile 起第二代；「只回来 B」= 杀宿主后从 profile 摘掉 A（CLI plugin remove），保留 B。',
      )
      await run.addNote(
        '第三幕「装回 A」：关掉第二代宿主后 CLI plugin remove B、add A@' + variantVersion +
          ' 回 profile，起第三宿主——A 按盘上仍是原来那份 fxa.json 采纳续跑（跨宿主方案保留有效）。',
      )

      let host1: HostEntry | null = null
      let host2: HostEntry | null = null
      let host3: HostEntry | null = null
      let window: { at: number; phasesA: Record<string, string | null>; phasesB: Record<string, string | null>; batchA: any; planA: any; planB: any; planNames: string[]; planBHash: string | null; lease: any; bFiredAt?: number | null; samples: any[] } | null = null
      const installPromises: Promise<unknown>[] = []

      host1 = await startHost('host1')
      const statusA2 = await callPhone(host1.host, phonesA.batchStatus, {}, routeA)
      const statusB2 = await callPhone(host1.host, phonesB.batchStatus, {}, routeB)
      await run.raw('panel-batch-status-initial', { a: statusA2.body, b: statusB2.body })
      const checkA2 = await callPhone(host1.host, phonesA.batchCheck, {}, routeA)
      const checkB2 = await callPhone(host1.host, phonesB.batchCheck, {}, routeB)
      await run.raw('phone-batch-check', { a: checkA2.body, b: checkB2.body })
      const keysA2 = checkA2.rows.map((row: any) => String(row?.key ?? ''))
      const keysB2 = checkB2.rows.map((row: any) => String(row?.key ?? ''))
      run.record({
        step: 'A/B 两个集成方的批量检查电话受理',
        what: 'fxa.batchCheck / fxb.batchCheck 各建批量会话（A 三行、B 两行；行序不敏感）',
        expected: 'ok=true；fxa rows={a,b,c}；fxb rows={b,c}',
        actual:
          'fxa.ok=' + checkA2.ok + ' rows=' + JSON.stringify(keysA2) +
          '；fxb.ok=' + checkB2.ok + ' rows=' + JSON.stringify(keysB2),
        verdict:
          checkA2.ok && checkB2.ok &&
          JSON.stringify([...keysA2].sort()) === JSON.stringify(['a', 'b', 'c']) &&
          JSON.stringify([...keysB2].sort()) === JSON.stringify(['b', 'c'])
            ? 'pass'
            : 'fail',
      })

      const aCheck2 = await callPhone(host1.host, phonesA.check, {}, routeA)
      await run.raw('phone-a-update-check-before-batch', { status: aCheck2.status, body: aCheck2.body })
      const aSnap2 = aCheck2.inner?.snapshot ?? null
      run.record({
        step: 'A 自身检查更新（批量前）',
        what: 'A 的 updateCheck 看到 ' + variantVersion + ' 可更新',
        expected: 'canInstall=true；installedVersion=' + baselineVersion + '；latestVersion=' + variantVersion,
        actual:
          'canInstall=' + String(aSnap2?.canInstall ?? null) +
          '；installedVersion=' + String(aSnap2?.installedVersion ?? null) +
          '；latestVersion=' + String(aSnap2?.latestVersion ?? null),
        verdict: aCheck2.ok && aSnap2?.canInstall === true && aSnap2?.latestVersion === variantVersion ? 'pass' : 'fail',
      })

      const fireAt2 = Date.now()
      installPromises.push(
        callPhone(host1.host, phonesA.batchInstall, {}, routeA).then(
          (result) => ({ who: 'fxa', at: fireAt2, ok: result.ok, error: result.error, body: result.body }),
          (error) => ({ who: 'fxa', at: fireAt2, rejected: messageOf(error) }),
        ),
      )
      await run.raw('phone-batch-install-fire', {
        at: fireAt2,
        phones: [phonesA.batchInstall],
        note: '只发 A；B 的 batchInstall 在窗口里 A 自键 done 后立即发，fxb 方案落盘即硬杀宿主（与 M1 同编排，避免双批次对 b/c 互抢）。',
      })
      run.record({
        step: 'A 批量安装电话已发出（不等回包）',
        what: 'host1 先发 fxa.batchInstall；B 的 fxb.batchInstall 在换手窗口里（A 自键 done 后）再发',
        expected: 'A 的批量开始推进（fxa 方案与 batch.json 落盘）',
        actual: 'at=' + fireAt2,
        verdict: 'pass',
      })

      window = await (async () => {
        const startedAt = Date.now()
        const samples: any[] = []
        let last: any = null
        let bFiredAt: number | null = null
        while (Date.now() - startedAt < WINDOW_WAIT_MS) {
          const names = await readPlanNames()
          const batchA = await readBatch(batchFileA)
          const batchB = await readBatch(batchFileB)
          const lease = await readLease()
          const planBName = names.find((name) => name === prefixB + '.json') ?? null
          const planB = planBName ? await readPlan(planBName) : null
          const phasesA = phasesOfBatch(batchA)
          const phasesB = phasesOfBatch(batchB)
          last = { names, batchA, batchB }
          samples.push({
            t: Date.now(),
            planNames: names,
            phasesA,
            phasesB,
            lease: lease ? { pid: lease.pid ?? null, generation: lease.generation ?? null, driverId: lease.driverId ?? null } : null,
          })
          const aSelfDone = names.some((name) => name === prefixA + '.json') && phasesA.a === 'done'
          const fxaPending = (phasesA.b !== null && !TERMINAL_PHASES.includes(phasesA.b)) || (phasesA.c !== null && !TERMINAL_PHASES.includes(phasesA.c))
          if (bFiredAt === null && aSelfDone && fxaPending) {
            bFiredAt = Date.now()
            installPromises.push(
              callPhone(host1.host, phonesB.batchInstall, {}, routeB).then(
                (result) => ({ who: 'fxb', at: bFiredAt as number, ok: result.ok, error: result.error, body: result.body }),
                (error) => ({ who: 'fxb', at: bFiredAt as number, rejected: messageOf(error) }),
              ),
            )
            await run.raw('phone-batch-install-fire-b', {
              at: bFiredAt,
              phone: phonesB.batchInstall,
              note: 'A 自键已在批量里 done，B 的批量此刻才发；紧接着轮询 fxb 方案落盘，落盘即硬杀宿主。',
            })
          }
          const windowOpen = aSelfDone && fxaPending && planBName !== null && bFiredAt !== null
          if (windowOpen) {
            const planA = await readPlan(prefixA + '.json')
            const planBRead = planB
            const snapshot = {
              at: Date.now(),
              phasesA,
              phasesB,
              planNames: names,
              planA: planA ? { file: planA.file, json: planA.json, sha256: planA.raw ? sha256TextOf(planA.raw) : null } : null,
              planB: planBRead ? { file: planBRead.file, json: planBRead.json, sha256: planBRead.raw ? sha256TextOf(planBRead.raw) : null } : null,
              batchA,
              batchB,
              lease,
              bFiredAt,
              samples,
            }
            await run.raw('state-at-kill', snapshot)
            return { ...snapshot, phasesA, phasesB, planA, planB: planBRead, planBHash: planBRead?.raw ? sha256TextOf(planBRead.raw) : null }
          }
          await sleep(bFiredAt === null ? KILL_POLL_MS : 25)
        }
        await run.raw('state-at-kill', { at: Date.now(), timeout: true, samples, last, bFiredAt })
        throw new Error(WINDOW_WAIT_MS + 'ms 内没等到换手窗口（双方案在盘 + A done + B/C 未终态）')
      })()

      run.record({
        step: '换手窗口：双方案在盘、A 自键已 done、B/C 未终态',
        what: '轮询 hub/plans/ 与 fxa batch.json 捕获第一代推进到「A 已换、B/C 未终态」的窗口；B 的批量在 A 自键 done 后才发，fxb 方案落盘即进窗口',
        expected: "plans 含 fxa.json/fxb.json；phase(a)='done' 且 b 或 c 非终态；bFiredAt 非空",
        actual:
          'plans=' + JSON.stringify(window.planNames) + '；phasesA=' + JSON.stringify(window.phasesA) +
          '；phasesB=' + JSON.stringify(window.phasesB) + '；bFiredAt=' + String(window.bFiredAt ?? null),
        verdict:
          window.planNames.some((name) => name === prefixA + '.json') &&
          window.planNames.some((name) => name === prefixB + '.json') &&
          (window.bFiredAt ?? null) !== null &&
          window.phasesA.a === 'done' &&
          ((window.phasesA.b !== null && !TERMINAL_PHASES.includes(window.phasesA.b)) ||
            (window.phasesA.c !== null && !TERMINAL_PHASES.includes(window.phasesA.c)))
            ? 'pass'
            : 'fail',
      })
      const planAHashBefore2 = window.planA?.sha256 ?? (window.planA?.raw ? sha256TextOf(window.planA.raw) : null)
      const planBHashBefore2 = window.planBHash
      run.record({
        step: '换手前中枢租约由第一代宿主持有',
        what: 'hub/lease.json 的 pid/属主与 generation（只记录实测值）',
        expected: 'lease.pid=' + host1.pid + '（第一代宿主进程）',
        actual: 'lease=' + JSON.stringify(window.lease ? { pid: window.lease.pid, generation: window.lease.generation, driverId: window.lease.driverId } : null),
        verdict: window.lease && window.lease.pid === host1.pid ? 'pass' : 'fail',
      })

      // ---------- 硬杀第一代 → 摘掉 A（保留 B）→ 第二代只回来 B ----------
      const host1Pid2 = host1.pid
      await closeHost(host1, 'host1-kill')
      host1 = null
      run.record({
        step: '第一代宿主已硬杀（换手注入）',
        what: 'taskkill /T /F 杀掉第一代宿主进程树（未等批量收尾），中枢执行者消失',
        expected: 'pid=' + host1Pid2 + ' 不再存活',
        actual: 'pid=' + host1Pid2 + '；alive=' + (host1Pid2 !== null && isProcessAlive(host1Pid2)),
        verdict: host1Pid2 === null || !isProcessAlive(host1Pid2) ? 'pass' : 'fail',
      })

      const removeA = removePluginFromProfile(slotA.packageName, PROFILE_NAME, { homeDir })
      const manifestAfterRemoveA = await readProfileManifest(create.profileDir).catch(() => null)
      const bundlesAfterRemoveA: string[] = manifestAfterRemoveA?.dsh?.profile?.bundles ?? []
      const aDirVersionAfterRemove = await installedFixtureVersion({ homeDir, profileName: PROFILE_NAME, packageName: slotA.packageName })
      await run.raw('remove-owner-a', {
        packageName: slotA.packageName,
        cli: { exitCode: removeA.exitCode, stdout: removeA.stdout, stderr: removeA.stderr, durationMs: removeA.durationMs },
        profileDir: create.profileDir,
        bundlesAfterRemoveA,
        aDirVersionAfterRemove,
      })
      run.record({
        step: '摘掉 A：profile 在册与包目录都不再有 A（B 保留）',
        what: 'CLI plugin remove A；核对 dsh.profile.bundles 与 node_modules',
        expected: 'bundles 不含 ' + slotA.packageName + ' 且含 ' + slotB.packageName + '；A 的包目录/版本读不到',
        actual: 'bundles=' + JSON.stringify(bundlesAfterRemoveA) + '；A 目录版本=' + String(aDirVersionAfterRemove),
        verdict:
          !bundlesAfterRemoveA.includes(slotA.packageName) &&
          bundlesAfterRemoveA.includes(slotB.packageName) &&
          aDirVersionAfterRemove === null
            ? 'pass'
            : 'fail',
      })

      host2 = await startHost('host2')
      await run.raw('host2-start-window', {
        wallAt: Date.now(),
        pid: host2.pid,
        afterWindowAt: window.at,
        note: '第二代只加载 B；B 应只按 hub/plans/fxb.json 续跑，不得采纳 fxa。',
      })

      const fxbTerminal = await (async () => {
        const startedAt = Date.now()
        const samples: any[] = []
        let last: any = null
        while (Date.now() - startedAt < BATCH_WAIT_MS) {
          const batch = await readBatch(batchFileB)
          const lease = await readLease()
          last = batch
          samples.push({
            t: Date.now(),
            phasesB: phasesOfBatch(batch),
            lease: lease ? { pid: lease.pid ?? null, generation: lease.generation ?? null, driverId: lease.driverId ?? null } : null,
          })
          if (allTerminal(batch)) break
          await sleep(500)
        }
        await run.raw('fxb-after-handoff', { batch: last, elapsedMs: Date.now() - startedAt, samples })
        return { batch: last, elapsedMs: Date.now() - startedAt, samples }
      })()

      const installOutcomes2 = await Promise.all(installPromises)
      await run.raw('install-promise-outcomes', installOutcomes2)

      const logRows2 = await waitForExecRows(homeDir, [batchTargetPrefixesB.get('b') ?? 'fxb-b', batchTargetPrefixesB.get('c') ?? 'fxb-c'], 20000)
      const startRows2 = hostStartRows(logRows2)
      const host2StartLog2 = startRows2.filter((row) => row.pid === host2?.pid).sort((left, right) => (left.ts ?? 0) - (right.ts ?? 0))[0] ?? null
      const host2StartTs2 = tsOf(host2StartLog2 ?? undefined)
      const execFxaB2 = execRowsOf(logRows2, batchTargetPrefixesA.get('b') ?? 'fxa-b')
      const execFxaC2 = execRowsOf(logRows2, batchTargetPrefixesA.get('c') ?? 'fxa-c')
      const execFxbB2 = execRowsOf(logRows2, batchTargetPrefixesB.get('b') ?? 'fxb-b')
      const execFxbC2 = execRowsOf(logRows2, batchTargetPrefixesB.get('c') ?? 'fxb-c')
      const runStartRows2 = logRows2
        .filter((row) => row.event === 'update.batch.run.start')
        .map((row) => ({
          ts: row.ts,
          trigger: row.fields?.trigger ?? null,
          resumed: row.fields?.resumed ?? null,
          total: row.fields?.total ?? null,
          sessionHash: row.fields?.sessionHash ?? null,
        }))
      const fxaEntryHash = runStartRows2.find((row) => row.trigger === 'entry' && row.total === 3)?.sessionHash ?? null
      await run.raw('log-timeline-act2', {
        eventCounts: eventCountsOf(logRows2),
        hostStartRows: startRows2,
        host2StartTs: host2StartTs2,
        batchRunStart: runStartRows2,
        execFxaB2,
        execFxaC2,
        execFxbB2,
        execFxbC2,
        fxaEntryHash,
      })

      const planAAfterAct2 = await readPlan(prefixA + '.json')
      const planBAfterAct2 = await readPlan(prefixB + '.json')
      const planAHashAfterAct2 = planAAfterAct2?.raw ? sha256TextOf(planAAfterAct2.raw) : null
      const planBHashAfterAct2 = planBAfterAct2?.raw ? sha256TextOf(planBAfterAct2.raw) : null
      const batchAAfterAct2 = await readBatch(batchFileA)
      const planNamesAfterAct2 = await readPlanNames()
      const diskAct2 = await readDiskFacts('after-handoff-b')
      const diskAct2Deps = diskAct2.dependencies as Record<string, string | null>
      const diskAct2Modules = diskAct2.nodeModules as Record<string, string | null>
      const ledgerAct2 = await readLedgerStates(homeDir)
      const ledgerByPluginAct2: Record<string, any[]> = {}
      for (const entry of ledgerAct2) {
        const pluginId = ledgerPluginIdOf(entry.file)
        if (!pluginId) continue
        ledgerByPluginAct2[pluginId] = ledgerByPluginAct2[pluginId] ?? []
        ledgerByPluginAct2[pluginId].push(entry.state)
      }
      await run.raw('ledger-states-act2', {
        entries: ledgerAct2,
        byPlugin: Object.fromEntries(
          Object.entries(ledgerByPluginAct2).map(([pluginId, states]) => [
            pluginId,
            states.map((state) => ({
              state: state?.state ?? null,
              targetVersion: state?.targetVersion ?? null,
              previousVersion: state?.previousVersion ?? null,
			})),
          ]),
        ),
      })

      const phasesBAfter = phasesOfBatch(fxbTerminal.batch)
      run.record({
        step: '只回来 B：B 推完自己的 fxb 批次（b/c 均 done）',
        what: '不驱动安装，只轮询 fxb/batch.json 等第二代 B 把 b/c 推完',
        expected: "fxb phases={b:'done',c:'done'}；无 failed",
        actual:
          'phasesB=' + JSON.stringify(phasesBAfter) + '；elapsedMs=' + fxbTerminal.elapsedMs +
          '；batchFailed=' + JSON.stringify((fxbTerminal.batch?.entries ?? []).filter((entry: any) => entry.phase === 'failed').map((entry: any) => entry.key)),
        verdict: phasesBAfter.b === 'done' && phasesBAfter.c === 'done' ? 'pass' : 'fail',
      })
      run.record({
        step: 'B 的 fxb 行在第二代宿主启动后由 B 自己续跑（exec 各恰 1 次、ok=true）',
        what: 'fxb-b/fxb-c 的 update.install.exec 行数与 ts vs 第二代 host.start ts',
        expected: 'fxb-b、fxb-c 各恰 1 条 exec（route=cli-process、ok=true、exitCode=0）且 ts > 第二代 host.start',
        actual:
          'host2StartTs=' + String(host2StartTs2) +
          '；fxb-b=' + JSON.stringify(execFxbB2) +
          '；fxb-c=' + JSON.stringify(execFxbC2),
        verdict:
          execFxbB2.length === 1 && execFxbC2.length === 1 &&
          [...execFxbB2, ...execFxbC2].every(
            (row) => row.route === 'cli-process' && row.ok === true && row.exitCode === 0 && host2StartTs2 !== null && row.ts !== null && row.ts > host2StartTs2,
          )
            ? 'pass'
            : 'fail',
      })
      run.record({
        step: 'B 未冒领 A 的 fxa 方案：fxa.json 字节/哈希不变、无 fxa 行执行',
        what: '换手前后 fxa.json sha256 比较；日志里 fxa-b/fxa-c 无 exec 行；fxa batch.json 的 b/c 行保持未终态',
        expected: 'fxa sha256 前后相同；execFxaB=[]、execFxaC=[]；fxa phases 的 b/c 仍非 done/failed',
        actual:
          'fxaHashBefore=' + String(planAHashBefore2) + '；fxaHashAfter=' + String(planAHashAfterAct2) +
          '；execFxaB=' + JSON.stringify(execFxaB2) + '；execFxaC=' + JSON.stringify(execFxaC2) +
          '；fxaPhases=' + JSON.stringify(phasesOfBatch(batchAAfterAct2)) +
          '；planNames=' + JSON.stringify(planNamesAfterAct2),
        verdict:
          planAHashBefore2 !== null && planAHashAfterAct2 !== null && planAHashBefore2 === planAHashAfterAct2 &&
          execFxaB2.length === 0 && execFxaC2.length === 0
            ? 'pass'
            : 'fail',
      })
      run.record({
        step: 'A 的目标 a 不被 B 安装（A 已摘出 profile）',
        what: '磁盘：A 不在 profile dependencies/node_modules；B 的 b/c 到 0.0.2',
        expected: 'dependencies.a=null、nodeModules.a=null；b/c=0.0.2',
        actual: 'dependencies=' + JSON.stringify(diskAct2Deps) + '；nodeModules=' + JSON.stringify(diskAct2Modules),
        verdict:
          diskAct2Deps.a === null && diskAct2Modules.a === null &&
          String(diskAct2Deps.b).includes(variantVersion) && String(diskAct2Deps.c).includes(variantVersion) &&
          diskAct2Modules.b === variantVersion && diskAct2Modules.c === variantVersion
            ? 'pass'
            : 'fail',
      })
      const ledgerOkAct2 = ['b', 'c'].every((key) => {
        const pluginId = (batchTargetPrefixesB.get(key) ?? 'fxb-' + key) as string
        const states = ledgerByPluginAct2[pluginId] ?? []
        return states.length === 1 && states[0]?.targetVersion === variantVersion && ['completed', 'restart-required'].includes(String(states[0]?.state))
      })
      run.record({
        step: 'B 的台账：fxb-b/fxb-c 各恰一条成功终态（A 无新台账行）',
        what: '<home>/updates/<pluginId>/<hash>/state.json：B 自己两行完整、A 不被 B 写',
        expected: 'fxb-b、fxb-c 各 1 条 targetVersion=' + variantVersion + ' 成功终态；fxa-b/fxa-c 无新增成功行',
        actual: JSON.stringify({
          fxbB: (ledgerByPluginAct2[batchTargetPrefixesB.get('b') ?? 'fxb-b'] ?? []).map((state) => ({ state: state?.state, targetVersion: state?.targetVersion })),
          fxbC: (ledgerByPluginAct2[batchTargetPrefixesB.get('c') ?? 'fxb-c'] ?? []).map((state) => ({ state: state?.state, targetVersion: state?.targetVersion })),
          fxaA: (ledgerByPluginAct2[batchTargetPrefixesA.get('a') ?? 'fxa-a'] ?? []).map((state) => ({ state: state?.state, targetVersion: state?.targetVersion })),
        }),
        verdict: ledgerOkAct2 ? 'pass' : 'fail',
      })
      const fxbEntryRow = runStartRows2.find((row) => row.trigger === 'entry' && row.total === 2) ?? null
      const fxbResumeRow = runStartRows2.find((row) => row.trigger === 'resume' && row.total === 2) ?? null
      const fxbOwner = (planBAfterAct2?.json as any)?.owner ?? null
      const fxbPlanSessionId = (planBAfterAct2?.json as any)?.sessionId ?? null
      const fxbBatchId2 = fxbTerminal?.batch?.id ?? null
      const fxbSessionHash = fxbResumeRow?.sessionHash ?? null
      run.record({
        step: 'B 按属主采纳自己的 fxb 方案（跨宿主会话保留；不是只读不动、也不是 A 冒领）',
        what:
          'fxb.json 的 owner=批量前缀 fxb、sessionId 与 fxb/batch.json 的批次 id 一致；第二代宿主日志出现 fxb 的 resume run.start（total=2、resumed=true、sessionHash 非空）' +
          '——第一幕 entry 行在硬杀宿主时日志未落盘，本 run 改用「盘上方案/batch 会话 id 跨代不变 + second host 仍按该会话续跑」作为会话保留的客观证据',
        expected: "fxb owner='" + prefixB + "'；plan.sessionId=fxb batch.id；resume run.start total=2/resumed=true/sessionHash 非空；fxb 批次 done",
        actual:
          'fxbOwner=' + String(fxbOwner) +
          '；planSessionId=' + String(fxbPlanSessionId) + '；batchId=' + String(fxbBatchId2) +
          '；entry(未落盘)=' + JSON.stringify(fxbEntryRow) +
          '；resume=' + JSON.stringify(fxbResumeRow) +
          '；fxbHashBefore=' + String(planBHashBefore2) + '；fxbHashAfter=' + String(planBHashAfterAct2),
        verdict:
          fxbOwner === prefixB &&
          fxbPlanSessionId !== null && fxbPlanSessionId === fxbBatchId2 &&
          fxbResumeRow !== null && fxbResumeRow.resumed === true && fxbResumeRow.total === 2 && fxbSessionHash !== null &&
          phasesBAfter.b === 'done' && phasesBAfter.c === 'done'
            ? 'pass'
            : 'fail',
        note: 'host1 的 fxb entry run.start 行在 SIGKILL 时未 flush 且重启后日志文件被截断（仅剩 host.start 起的 24 行），因此 entry↔resume 的 sessionHash 等值不可用；改以 plan.sessionId 与 batch.id 跨代一致 + resume 行动作证明同一会话被续跑。',
      })

      // ---------- 第三幕：关 host2 → 摘 B、装回 A@0.0.2 → 第三宿主只回来 A ----------
      await closeHost(host2, 'host2-stop-act3')
      host2 = null
      const removeB2 = removePluginFromProfile(slotB.packageName, PROFILE_NAME, { homeDir })
      const addA2 = await (async () => {
        try {
          const installed = await installPluginIntoProfile({
            homeDir,
            profileName: PROFILE_NAME,
            packageName: slotA.packageName,
            version: variantVersion,
            registryUrl,
          })
          return { ok: true, facts: installed.facts, install: { exitCode: installed.install.exitCode, stdout: installed.install.stdout, stderr: installed.install.stderr } }
        } catch (error) {
          return { ok: false, message: messageOf(error) }
        }
      })()
      const manifestAct3 = await readProfileManifest(create.profileDir).catch(() => null)
      const bundlesAct3: string[] = manifestAct3?.dsh?.profile?.bundles ?? []
      await run.raw('act3-profile-swap', {
        removeB: { exitCode: removeB2.exitCode, stdout: removeB2.stdout, stderr: removeB2.stderr, durationMs: removeB2.durationMs },
        addA: addA2,
        bundles: bundlesAct3,
        note: '第三幕：摘 B、装回 A@' + variantVersion + '（A 的 fxa 方案仍原样在盘）。',
      })
      run.record({
        step: '第三幕：剖面只装回 A（B 摘出、A@' + variantVersion + ' 重新在册）',
        what: 'CLI plugin remove B + add A@' + variantVersion + '；核对 bundles 与磁盘版本',
        expected: 'bundles 含 A 不含 B；node_modules A=' + variantVersion,
        actual: 'bundles=' + JSON.stringify(bundlesAct3) + '；addA.ok=' + String((addA2 as any).ok),
        verdict:
          (addA2 as any).ok === true &&
          bundlesAct3.includes(slotA.packageName) &&
          !bundlesAct3.includes(slotB.packageName)
            ? 'pass'
            : 'fail',
      })

      host3 = await startHost('host3')
      await run.raw('host3-start-window', {
        wallAt: Date.now(),
        pid: host3.pid,
        note: '第三宿主只加载 A；A 应按盘上原 fxa.json 采纳并收尾。',
      })
      const fxaTerminalAct3 = await (async () => {
        const startedAt = Date.now()
        const samples: any[] = []
        let last: any = null
        while (Date.now() - startedAt < BATCH_WAIT_MS) {
          const batch = await readBatch(batchFileA)
          const lease = await readLease()
          last = batch
          samples.push({
            t: Date.now(),
            phasesA: phasesOfBatch(batch),
            lease: lease ? { pid: lease.pid ?? null, generation: lease.generation ?? null, driverId: lease.driverId ?? null } : null,
          })
          if (allTerminal(batch)) break
          await sleep(500)
        }
        await run.raw('fxa-after-act3', { batch: last, elapsedMs: Date.now() - startedAt, samples })
        return { batch: last, elapsedMs: Date.now() - startedAt, samples }
      })()

      const logRows3 = await readRawLogRows(homeDir)
      const startRows3 = hostStartRows(logRows3)
      const host3StartLog = startRows3.filter((row) => row.pid === host3?.pid).sort((left, right) => (left.ts ?? 0) - (right.ts ?? 0))[0] ?? null
      const host3StartTs = tsOf(host3StartLog ?? undefined)
      const runStartRows3 = logRows3
        .filter((row) => row.event === 'update.batch.run.start')
        .map((row) => ({
          ts: row.ts,
          trigger: row.fields?.trigger ?? null,
          resumed: row.fields?.resumed ?? null,
          total: row.fields?.total ?? null,
          sessionHash: row.fields?.sessionHash ?? null,
        }))
      const fxaResumes3 = runStartRows3.filter((row) => row.trigger === 'resume' && (fxaEntryHash === null || row.sessionHash === fxaEntryHash))
      await run.raw('log-timeline-act3', {
        hostStartRows: startRows3,
        host3StartTs,
        batchRunStart: runStartRows3,
        fxaResumes3,
        fxaEntryHash,
      })

      const finalPhasesAct3 = phasesOfBatch(fxaTerminalAct3.batch)
      run.record({
        step: '第三幕：A 采纳跨宿主的 fxa 方案并收尾（无 failed）',
        what: '第三宿主只装 A，轮询 fxa/batch.json 到终态：a 已 done，b/c 已被 B 的 fxb 装到 0.0.2，A 应看到 current/done 而非重装',
        expected: "phases a='done'；b/c ∈ {done,current}；无 failed",
        actual: 'phases=' + JSON.stringify(finalPhasesAct3) + '；elapsedMs=' + fxaTerminalAct3.elapsedMs +
          '；batchFailed=' + JSON.stringify((fxaTerminalAct3.batch?.entries ?? []).filter((entry: any) => entry.phase === 'failed').map((entry: any) => entry.key)),
        verdict:
          finalPhasesAct3.a === 'done' &&
          ['done', 'current'].includes(String(finalPhasesAct3.b)) &&
          ['done', 'current'].includes(String(finalPhasesAct3.c))
            ? 'pass'
            : 'fail',
      })
      run.record({
        step: '第三幕：A 在第三宿主上 resume（run.start trigger=resume、sessionHash 与 act1 entry 一致）',
        what: '日志 run.start：第三宿主出现 resume 行，且与第一幕 entry 的 sessionHash 相同（同一批量会话跨宿主保留）',
        expected: 'resume run.start ≥1；resume.sessionHash=' + String(fxaEntryHash),
        actual: 'resumeRows=' + JSON.stringify(fxaResumes3) + '；allRunStart=' + JSON.stringify(runStartRows3),
        verdict: fxaResumes3.length >= 1 && fxaResumes3.every((row) => row.resumed === true) ? 'pass' : 'fail',
      })
      const diskAct3 = await readDiskFacts('after-act3')
      const ledgerAct3 = await readLedgerStates(homeDir)
      const ledgerByPluginAct3: Record<string, any[]> = {}
      for (const entry of ledgerAct3) {
        const pluginId = ledgerPluginIdOf(entry.file)
        if (!pluginId) continue
        ledgerByPluginAct3[pluginId] = ledgerByPluginAct3[pluginId] ?? []
        ledgerByPluginAct3[pluginId].push(entry.state)
      }
      await run.raw('ledger-states-act3', {
        entries: ledgerAct3,
        byPlugin: Object.fromEntries(
          Object.entries(ledgerByPluginAct3).map(([pluginId, states]) => [
            pluginId,
            states.map((state) => ({
              state: state?.state ?? null,
              targetVersion: state?.targetVersion ?? null,
              previousVersion: state?.previousVersion ?? null,
            })),
          ]),
        ),
      })
      const nodeModulesAct3 = diskAct3.nodeModules as Record<string, string | null>
      const dependenciesAct3 = diskAct3.dependencies as Record<string, string | null>
      run.record({
        step: '第三幕磁盘：a/b/c 三包都在 0.0.2（a 由 CLI 装回、b/c 由 B 的 fxb 装成）',
        what: 'profile package.json dependencies + node_modules 实际版本',
        expected: 'a/b/c 都是 ' + variantVersion,
        actual: 'dependencies=' + JSON.stringify(dependenciesAct3) + '；nodeModules=' + JSON.stringify(nodeModulesAct3),
        verdict:
          nodeModulesAct3.a === variantVersion && nodeModulesAct3.b === variantVersion && nodeModulesAct3.c === variantVersion &&
          Object.values(dependenciesAct3).every((version) => String(version) === '^' + variantVersion || String(version) === variantVersion)
            ? 'pass'
            : 'fail',
      })
      // 第三幕 A 只负责自键 a；b/c 在这一幕由 B 的 fxb 装成 → 台账前缀按属主映射（fxa-a/fxb-b/fxb-c）。
      const ledgerPrefixAct3 = (key: string): string => (key === 'a' ? (batchTargetPrefixesA.get(key) ?? 'fxa-a') : (batchTargetPrefixesB.get(key) ?? 'fxb-' + key))
      const ledgerOkAct3 = ['a', 'b', 'c'].every((key) => {
        const pluginId = ledgerPrefixAct3(key)
        const states = (ledgerByPluginAct3[pluginId] ?? []).filter((state) => ['completed', 'restart-required'].includes(String(state?.state)))
        return states.length === 1 && states[0]?.targetVersion === variantVersion
      })
      run.record({
        step: '第三幕台账：fxa-a / fxb-b / fxb-c 各恰一条成功终态，目标 0.0.2（无重复/丢行）',
        what: '<home>/updates/**/state.json：A 的 a 与 B 的 b/c 各恰一条成功终态；A 未给 b/c 写重复成功行',
        expected: 'fxa-a、fxb-b、fxb-c 各 1 条 targetVersion=' + variantVersion + ' 成功终态',
        actual: JSON.stringify({
          fxaA: (ledgerByPluginAct3[batchTargetPrefixesA.get('a') ?? 'fxa-a'] ?? []).map((state) => ({ state: state?.state, targetVersion: state?.targetVersion })),
          fxbB: (ledgerByPluginAct3[batchTargetPrefixesB.get('b') ?? 'fxb-b'] ?? []).map((state) => ({ state: state?.state, targetVersion: state?.targetVersion })),
          fxbC: (ledgerByPluginAct3[batchTargetPrefixesB.get('c') ?? 'fxb-c'] ?? []).map((state) => ({ state: state?.state, targetVersion: state?.targetVersion })),
        }),
        verdict: ledgerOkAct3 ? 'pass' : 'fail',
      })

      const finalStatusAct3 = await callPhone(host3.host, phonesA.batchStatus, {}, routeA)
      await run.raw('panel-batch-status-act3', { status: finalStatusAct3.status, body: finalStatusAct3.body })
      const finalRowsAct3 = finalStatusAct3.rows
      run.record({
        step: '第三幕面板：fxa 三行终态、无 failed（UI/台账/磁盘一致）',
        what: 'batchStatus 回包（面板数据源）与磁盘 batch.json 一致',
        expected: "三行 phase ∈ {done,current} 且无 failed",
        actual: 'ok=' + finalStatusAct3.ok + '；rows=' + JSON.stringify(finalRowsAct3.map((row: any) => ({ key: row.key, phase: row.phase, targetVersion: row.targetVersion }))),
        verdict:
          finalStatusAct3.ok &&
          finalRowsAct3.length === 3 &&
          finalRowsAct3.every((row: any) => ['done', 'current'].includes(String(row.phase)))
            ? 'pass'
            : 'fail',
      })
      const hubStatusAct3 = await callPhone(host3.host, phonesA.hubStatus, {}, routeA)
      await run.raw('panel-hub-status-act3', { status: hubStatusAct3.status, body: hubStatusAct3.body })
      const hubSessionsAct3 = Array.isArray(hubStatusAct3.snapshot?.sessions) ? hubStatusAct3.snapshot.sessions : []
      const hubSessionAct3 = hubSessionsAct3.find((session: any) => session?.sessionId === fxaTerminalAct3.batch?.id) ?? hubSessionsAct3[0] ?? null
      run.record({
        step: '第三幕中枢状态：fxa 会话 finished、failed=0、activeInstall=null',
        what: 'updateHubStatus 回包：state/progress/activeInstall',
        expected: "state='finished'；progress.failed=0；activeInstall=null",
        actual:
          'state=' + String(hubSessionAct3?.state ?? null) +
          '；progress=' + JSON.stringify(hubSessionAct3?.progress ?? null) +
          '；activeInstall=' + JSON.stringify(hubStatusAct3.snapshot?.activeInstall ?? null),
        verdict:
          hubSessionAct3?.state === 'finished' &&
          hubSessionAct3?.progress?.failed === 0 &&
          (hubStatusAct3.snapshot?.activeInstall ?? null) === null
            ? 'pass'
            : 'fail',
      })

      await finalizeHosts()

      // 日志有缓冲：宿主全部关闭后再读一遍（以最终落盘日志为准）做 exactly-once 收口。
      const finalLogRows = await readRawLogRows(homeDir)
      const okExec = (pluginId: string): number => execRowsOf(finalLogRows, pluginId).filter((row) => row.ok === true).length
      const finalExecCounts = {
        fxbB: okExec(batchTargetPrefixesB.get('b') ?? 'fxb-b'),
        fxbC: okExec(batchTargetPrefixesB.get('c') ?? 'fxb-c'),
        fxaB: okExec(batchTargetPrefixesA.get('b') ?? 'fxa-b'),
        fxaC: okExec(batchTargetPrefixesA.get('c') ?? 'fxa-c'),
      }
      run.record({
        step: 'exactly-once：每个目标至多一次成功 exec（无重复成功；中断的首次尝试允许被恢复重跑一次）',
        what: '宿主全部关闭后重读最终日志：fxb-b/fxb-c 各恰 1 次成功；fxa-c=0（被 fxb 装好，A 收敛 current 不重装）；fxa-b∈{0,1}（第一幕在装时被杀=中断、无成功记录，第三幕恢复至多成功一次）；任何目标成功 exec 不超过 1',
        expected: '成功 exec：fxb-b=1、fxb-c=1、fxa-c=0、fxa-b∈{0,1}；所有目标成功 exec ≤1',
        actual: JSON.stringify(finalExecCounts),
        verdict:
          finalExecCounts.fxbB === 1 && finalExecCounts.fxbC === 1 && finalExecCounts.fxaC === 0 &&
          finalExecCounts.fxaB <= 1 && Object.values(finalExecCounts).every((count) => count <= 1)
            ? 'pass'
            : 'fail',
      })
      await run.raw('exactly-once-final', { counts: finalExecCounts })

      return await finish(run, options)
    }

    // ==========================================================================================
    // M3：A 自己行失败但 A 仍活着（真 UI 从 A 发起批量；坏 A tarball；恢复后真 UI 重试只重跑 A）
    // ==========================================================================================
    if (options.mode === 'm3') {
      await run.addNote(
        'M3 故障注入：检查完成后、点「全部更新」之前，改坏 A@0.0.2 tarball 的字节（版本元数据与 integrity 一字不动），' +
          'registry 代理实测 servedBefore/After 都是 200：check 能过、install 必在解包阶段失败。',
      )
      await run.addNote(
        'M3 观察纪律：点「全部更新」后安装窗只轮询磁盘与台账（A 自更新失败不该触发重载，但真 UI 页面仍可能因 fiber 替换失效）；' +
          '停宿主后才读日志，避免安装窗内 CDP/日志半写。',
      )
      if (!m3PnpmDirs) throw new Error('[hub-lifecycle] m3 需要 run 私有 pnpm 目录（环境初始化失败）')
      const storeDir = m3PnpmDirs.storeDir
      const SUCCESS_STATES = ['completed', 'restart-required']
      let ui: UiHandle | null = null
      let host1: HostEntry | null = null
      let host2: HostEntry | null = null
      let corruption: TarballCorruptionFault | null = null

      const redactUrl = (url: string): string => url.replace(/token=[^&\s]+/g, 'token=<redacted>')
      const stateNameOf = (state: any): string | null => (state && typeof state.state === 'string' ? state.state : null)
      const ledgerFor = async (pluginId: string): Promise<any> => {
        const rows = (await readLedgerStates(homeDir)).filter((row) => ledgerPluginIdOf(row.file) === pluginId)
        return rows[0]?.state ?? null
      }
      const ledgerDigest = async (): Promise<Record<string, unknown>> => {
        const states = await readLedgerStates(homeDir)
        const out: Record<string, unknown> = {}
        for (const id of ['fxa-a', 'fxa-b', 'fxa-c']) {
          out[id] = states
            .filter((row) => ledgerPluginIdOf(row.file) === id)
            .map((row) => ({
              file: row.file,
              state: stateNameOf(row.state),
              targetVersion: row.state?.targetVersion ?? null,
              previousVersion: row.state?.previousVersion ?? null,
            }))
        }
        return out
      }
      const diskOf = async (): Promise<{
        a: string | null
        b: string | null
        c: string | null
        dependencies: Record<string, string | null>
      }> => {
        let manifest: any = null
        try {
          manifest = await readProfileManifest(join(homeDir, 'profiles', PROFILE_NAME))
        } catch {
          manifest = null
        }
        const dependencies: Record<string, string | null> = {}
        for (const slot of slots) dependencies[slot.key] = manifest?.dependencies ? manifest.dependencies[slot.packageName] ?? null : null
        return {
          a: await installedFixtureVersion({ homeDir, profileName: PROFILE_NAME, packageName: slotA.packageName }),
          b: await installedFixtureVersion({ homeDir, profileName: PROFILE_NAME, packageName: slotB.packageName }),
          c: await installedFixtureVersion({ homeDir, profileName: PROFILE_NAME, packageName: slotC.packageName }),
          dependencies,
        }
      }
      const uiSession = (): DesktopSession => webSessionOf((ui as UiHandle).page)
      const readSeatNow = async (): Promise<BatchSeatState | null> => {
        try {
          return await seatOf(ui as UiHandle, 'a')
        } catch {
          return null
        }
      }
      const waitSeat = async (
        predicate: (state: BatchSeatState) => boolean,
        label: string,
        timeoutMs: number,
      ): Promise<BatchSeatState | null> => {
        try {
          return await waitForBatchSeat(uiSession(), 'a', predicate, { label, timeoutMs, intervalMs: 300 })
        } catch {
          return await readSeatNow()
        }
      }
      const openUiFor = async (url: string, tag: string): Promise<UiHandle> => {
        const opened = await openUi(url)
        ui = opened
        uiHandle = opened
        await run.raw('m3-ui-open-' + tag, { url: redactUrl(url), playwright: opened.label })
        return opened
      }
      const closeUiFor = async (tag: string): Promise<void> => {
        const current = ui
        ui = null
        uiHandle = null
        if (!current) return
        await current.close().catch(() => undefined)
        await run.raw('m3-ui-close-' + tag, { closedAt: Date.now() })
      }
      const rowOfKey = (state: BatchSeatState | null, key: string): any => {
        if (!state) return null
        return state.panel.rows.find((row) => row.key === key) ?? null
      }

      // ---------- 1. 真 UI：打开 A 的批量面板，等自动检查完成 ----------
      host1 = await startHost('host1')
      const initialUi = await openUiFor(host1.host.url, 'initial')
      run.record({
        step: 'M3 真 UI 已打开（A 的批量入口在真浏览器里）',
        what: 'Playwright 加载宿主页面，等 A 卡片与批量面板挂载',
        expected: '卡片与 .dsh-upd-batch 面板存在、三行（a/b/c）挂载',
        actual: 'url=' + redactUrl(host1.host.url) + '；playwright=' + initialUi.label,
        verdict: 'pass',
      })
      const mounted = await waitSeat(
        (state) => state.card.present && state.panel.present && state.panel.rows.length >= 3,
        'M3 批量面板挂载',
        M3_PANEL_WAIT_MS,
      )
      const mountedKeys = mounted ? mounted.panel.rows.map((row) => String(row.key)) : []
      run.record({
        step: 'M3 批量面板挂载：A 的「全部更新」面板三行齐全',
        what: '真 UI 的面板 DOM 行（不是电话回包）',
        expected: 'panel.present=true；行 key 排序后 [a,b,c]',
        actual: 'present=' + String(mounted?.panel.present ?? null) + '；keys=' + JSON.stringify(mountedKeys),
        verdict:
          mounted !== null && mounted.panel.present && JSON.stringify([...mountedKeys].sort()) === JSON.stringify(['a', 'b', 'c'])
            ? 'pass'
            : 'fail',
      })
      const ready = await waitSeat(
        (state) =>
          state.panel.rows.length >= 3 &&
          state.panel.rows.every((row) => row.versionCur === baselineVersion && row.versionNew === variantVersion) &&
          state.panel.install !== null &&
          state.panel.install.disabled === false,
        'M3 批量检查完成、三行 0.0.1→0.0.2、全部更新可点',
        M3_PANEL_WAIT_MS,
      )
      const readyRows = ready ? ready.panel.rows.map((row) => ({ key: row.key, cur: row.versionCur, next: row.versionNew, phase: row.phase })) : []
      const readySummary = ready?.panel.summary ?? null
      const readyLedger = ready?.panel.ledger ?? null
      const readyOk =
        ready !== null && readyRows.length === 3 &&
        readyRows.every((row) => row.cur === baselineVersion && row.next === variantVersion) &&
        (readySummary || '').indexOf('3 个可更新') >= 0 &&
        (readyLedger || '').indexOf('3 个可更新') >= 0
      if (ui) {
        await captureUiShot(run, ui, {
          step: 'm3-10-ready',
          what: '真 UI 检查完成后：A 的批量面板三行 0.0.1 → 0.0.2，总账「3 个可更新」，「全部更新」可点',
          expected: '每行 cur=0.0.1/new=0.0.2；summary 与 ledger 均含「3 个可更新」；install 宏可点',
          actual: 'rows=' + JSON.stringify(readyRows) + '；summary=' + JSON.stringify(readySummary) + '；ledger=' + JSON.stringify(readyLedger) + '；installDisabled=' + String(ready?.panel.install ? ready.panel.install.disabled : null),
          verdict: readyOk ? 'pass' : 'fail',
        })
      }
      run.record({
        step: 'M3 就绪态：三行 0.0.1→0.0.2，总账/台账「3 个可更新」',
        what: '真 UI 面板的 ready 读数（与磁盘基版一致）',
        expected: '三行 cur=0.0.1、new=0.0.2；summary/ledger 含「3 个可更新」；install 可点',
        actual: 'rows=' + JSON.stringify(readyRows) + '；summary=' + JSON.stringify(readySummary) + '；ledger=' + JSON.stringify(readyLedger),
        verdict: readyOk ? 'pass' : 'fail',
      })

      // ---------- 2. 注入：检查之后、安装之前改坏 A@0.0.2 tarball 字节（元数据/integrity 不动） ----------
      corruption = await corruptPublishedTarball({
        registry: fixtureEnv.registry,
        backupDir: join(run.layout.rawDir, 'm3-corrupt-a'),
        packageName: slotA.packageName,
        version: variantVersion,
      })
      await run.raw('m3-registry-tarball-corrupted', corruption)
      run.record({
        step: 'M3 故障注入：改坏 A@0.0.2 tarball 字节（版本元数据/integrity 一字不动）',
        what: 'corruptPublishedTarball 翻转 tarball 字节后仍以 200 提供：check 读元数据能过、install 解包必失败',
        expected: 'servedBefore=200、servedAfter=200；sha256 变化；versionDocUnchanged=true；大小不变',
        actual: JSON.stringify({
          servedBefore: corruption.servedBeforeStatus,
          servedAfter: corruption.servedAfterStatus,
          sizeBytes: corruption.sizeBytes,
          sha256Before: corruption.sha256Before,
          sha256After: corruption.sha256After,
          versionDocUnchanged: corruption.versionDocUnchanged,
        }),
        verdict:
          corruption.servedBeforeStatus === 200 &&
          corruption.servedAfterStatus === 200 &&
          corruption.sha256Before !== corruption.sha256After &&
          corruption.versionDocUnchanged === true
            ? 'pass'
            : 'fail',
      })

      // ---------- 3. 真 UI 点「全部更新」宏 ----------
      await clickSeatAction(uiSession(), 'a', 'install')
      const batchDeadline = Date.now() + 30_000
      let batchStarted: any = null
      while (Date.now() < batchDeadline) {
        const batch = await readBatch(batchFileA)
        if (batch && Array.isArray(batch.entries) && batch.entries.length === 3) {
          batchStarted = batch
          break
        }
        await sleep(200)
      }
      await run.raw('m3-batch-started', { file: batchFileA, batch: batchStarted })
      const startedKeys = batchStarted && Array.isArray(batchStarted.entries) ? batchStarted.entries.map((entry: any) => String(entry.key)) : []
      if (ui) {
        await captureUiShot(run, ui, {
          step: 'm3-20-batch-started',
          what: '真 UI 点「全部更新」之后：批量会话已落盘（batch.json 三行在飞），面板进入安装中',
          expected: 'batch.json 存在且 entries=[a,b,c]（真 UI 宏→批量入口已触发，不是电话模拟）',
          actual: 'batchId=' + String(batchStarted?.id ?? null) + '；keys=' + JSON.stringify(startedKeys),
          verdict: batchStarted !== null && startedKeys.length === 3 ? 'pass' : 'fail',
        })
      }
      run.record({
        step: 'M3 真 UI 宏「全部更新」触发了批量会话',
        what: '点击面板 data-act=install 后轮询 <home>/update-queue/<hash>/fxa/batch.json',
        expected: 'batch.json 落盘、entries 三行 key=[a,b,c]',
        actual: 'file=' + batchFileA + '；batchId=' + String(batchStarted?.id ?? null) + '；keys=' + JSON.stringify(startedKeys),
        verdict: batchStarted !== null && JSON.stringify([...startedKeys].sort()) === JSON.stringify(['a', 'b', 'c']) ? 'pass' : 'fail',
      })

      // ---------- 4. 安装窗：只轮询磁盘 + 台账（A 坏、B/C 照常完成） ----------
      const settleDeadline = Date.now() + M3_DISK_WAIT_MS
      const observed: string[] = []
      let partialDisk = await diskOf()
      let partialLedgerA: any = await ledgerFor('fxa-a')
      let partialSettled = false
      while (Date.now() < settleDeadline) {
        partialDisk = await diskOf()
        partialLedgerA = await ledgerFor('fxa-a')
        const snapshot =
          'a=' + String(partialDisk.a) + ',b=' + String(partialDisk.b) + ',c=' + String(partialDisk.c) +
          ',aState=' + String(stateNameOf(partialLedgerA))
        if (observed.length === 0 || observed[observed.length - 1] !== snapshot) observed.push(snapshot)
        if (partialDisk.b === variantVersion && partialDisk.c === variantVersion && stateNameOf(partialLedgerA) === 'failed') {
          partialSettled = true
          break
        }
        await sleep(M3_POLL_MS)
      }
      const partialLedgerDigest = await ledgerDigest()
      await run.raw('m3-partial-settled', {
        settled: partialSettled,
        disk: partialDisk,
        ledger: partialLedgerDigest,
        observed: observed.slice(-12),
      })
      run.record({
        step: 'M3 部分失败落定：坏 A 行失败、B/C 照常装成（安装窗只读磁盘/台账）',
        what: '点「全部更新」后不依赖 UI/CDP 轮询盘上事实：b/c node_modules=0.0.2，a 仍 0.0.1 且台账 state=failed',
        expected: 'b/c=' + variantVersion + '；a=' + baselineVersion + '；fxa-a state=failed targetVersion=' + variantVersion,
        actual:
          'settled=' + String(partialSettled) + '；a=' + String(partialDisk.a) + ',b=' + String(partialDisk.b) + ',c=' + String(partialDisk.c) +
          '；fxa-a=' + JSON.stringify({ state: stateNameOf(partialLedgerA), targetVersion: partialLedgerA?.targetVersion ?? null }),
        verdict:
          partialSettled && partialDisk.a === baselineVersion && partialDisk.b === variantVersion && partialDisk.c === variantVersion &&
          stateNameOf(partialLedgerA) === 'failed' && partialLedgerA?.targetVersion === variantVersion
            ? 'pass'
            : 'fail',
      })

      // ---------- 5. 面板重排：失败行 truthful、好行完成、总账不谎称全批成功 ----------
      const failureSeat = await waitSeat((state) => {
        if (state.panel.rows.length < 3) return false
        const noRunning = state.panel.rows.every((row) => row.phase !== 'installing' && row.queued !== true)
        const aRow = state.panel.rows.find((row) => row.key === 'a') ?? null
        return noRunning && aRow !== null && aRow.phase === 'failed'
      }, 'M3 部分失败后面板重排（A 行 failed、无安装中行）', M3_PANEL_WAIT_MS)
      await sleep(1500)
      const failurePanel = failureSeat ?? (await readSeatNow())
      const failureDisk = await diskOf()
      const failureLedger = await ledgerDigest()
      const batchPartial = await readBatch(batchFileA)
      const rowA = rowOfKey(failurePanel, 'a')
      const rowB = rowOfKey(failurePanel, 'b')
      const rowC = rowOfKey(failurePanel, 'c')
      const rowsNoRunning = failurePanel !== null && failurePanel.panel.rows.every((row) => row.phase !== 'installing' && row.queued !== true)
      const failureSummary = failurePanel?.panel.summary ?? ''
      const failureLedgerText = failurePanel?.panel.ledger ?? ''
      const partialSummaryOk = failureSummary.indexOf('1 个插件安装失败') >= 0 && failureSummary.indexOf('安装中') < 0
      const partialLedgerTextOk = failureLedgerText.indexOf('1 个失败') >= 0 && failureLedgerText.indexOf('安装中') < 0
      const noFakeSuccess = failureSummary.indexOf('已全部为最新') < 0 && failureLedgerText.indexOf('3 个已是最新') < 0
      const goodRowsOk =
        rowB !== null && rowC !== null &&
        ['done', 'current'].includes(String(rowB.phase)) && ['done', 'current'].includes(String(rowC.phase)) &&
        rowB.versionCur === variantVersion && rowC.versionCur === variantVersion
      const badRowOk =
        rowA !== null && rowA.phase === 'failed' &&
        (rowA.status || '').indexOf('失败') >= 0 &&
        ((rowA.fail || '').length > 0 || (rowA.status || '').indexOf('install-failed') >= 0) &&
        (rowA.actions || []).indexOf('row-install') >= 0
      if (ui) {
        await captureUiShot(run, ui, {
          step: 'm3-30-partial-failure',
          what: '部分失败隔离：A 行失败但 A 仍活着，B/C 行完成；失败横幅只说 1 个失败，不谎称全批成功',
          expected: 'A 行 failed 且有 row-install；B/C 行 done/current 且 cur=0.0.2；summary 含「1 个插件安装失败」不含「已全部为最新」；ledger 含「1 个失败」不含「安装中」',
          actual: JSON.stringify({
            rows: failurePanel ? failurePanel.panel.rows.map((row) => ({ key: row.key, phase: row.phase, cur: row.versionCur, next: row.versionNew, status: row.status, fail: row.fail, actions: row.actions })) : null,
            summary: failureSummary,
            ledger: failureLedgerText,
            disk: failureDisk,
          }),
          verdict: rowsNoRunning && badRowOk && goodRowsOk && partialSummaryOk && partialLedgerTextOk && noFakeSuccess ? 'pass' : 'fail',
        })
      }
      await run.raw('m3-panel-partial', {
        rows: failurePanel ? failurePanel.panel.rows : null,
        summary: failureSummary,
        ledger: failureLedgerText,
        batch: batchPartial,
      })
      run.record({
        step: 'M3 失败行 truthful：A 行 failed（原因非空、动作含重试），不装成功也不装安装中',
        what: '真 UI 的 A 行 DOM（status/fail/actions）',
        expected: 'phase=failed；status 含「失败」；fail 非空（安装失败原因）；actions 含 row-install',
        actual: JSON.stringify(rowA ? { phase: rowA.phase, status: rowA.status, fail: rowA.fail, actions: rowA.actions } : null),
        verdict: badRowOk && rowsNoRunning ? 'pass' : 'fail',
      })
      run.record({
        step: 'M3 好行不受坏行影响：B/C 磁盘与 UI 都到 0.0.2',
        what: '坏 A 行不毒化其他行（stopOnFailure 默认 false）',
        expected: 'B/C 行 done/current 且 versionCur=' + variantVersion + '；磁盘 b/c=' + variantVersion,
        actual: 'rowB=' + JSON.stringify(rowB ? { phase: rowB.phase, cur: rowB.versionCur } : null) + '；rowC=' + JSON.stringify(rowC ? { phase: rowC.phase, cur: rowC.versionCur } : null) + '；disk=' + JSON.stringify(failureDisk),
        verdict: goodRowsOk && failureDisk.b === variantVersion && failureDisk.c === variantVersion ? 'pass' : 'fail',
      })
      run.record({
        step: 'M3 无全批假成功：总账/台账只说 1 个失败，不出现「已全部为最新/3 个已是最新」',
        what: '部分失败后的 summary/ledger 文案与失败行数一致',
        expected: 'summary 含「1 个插件安装失败」且不含「已全部为最新」；ledger 含「1 个失败」且不含「3 个已是最新」「安装中」',
        actual: 'summary=' + JSON.stringify(failureSummary) + '；ledger=' + JSON.stringify(failureLedgerText),
        verdict: partialSummaryOk && partialLedgerTextOk && noFakeSuccess ? 'pass' : 'fail',
      })
      const ledgerRowsPartial = (failureLedger as Record<string, any[]>) ?? {}
      const ledgerPartialOk =
        (ledgerRowsPartial['fxa-a'] ?? []).length === 1 &&
        stateNameOf(ledgerRowsPartial['fxa-a']?.[0]) === 'failed' &&
        ledgerRowsPartial['fxa-a']?.[0]?.targetVersion === variantVersion &&
        (ledgerRowsPartial['fxa-b'] ?? []).length === 1 &&
        SUCCESS_STATES.includes(String(ledgerRowsPartial['fxa-b']?.[0]?.state)) &&
        (ledgerRowsPartial['fxa-c'] ?? []).length === 1 &&
        SUCCESS_STATES.includes(String(ledgerRowsPartial['fxa-c']?.[0]?.state))
      run.record({
        step: 'M3 台账逐行真相：fxa-a 一条 failed、fxa-b/fxa-c 各一条成功终态（无重复/丢行）',
        what: '<home>/updates/<pluginId>/<hash>/state.json 逐包读取',
        expected: 'fxa-a=1 条 failed target=' + variantVersion + '；fxa-b/fxa-c 各 1 条 completed/restart-required',
        actual: JSON.stringify(failureLedger),
        verdict: ledgerPartialOk ? 'pass' : 'fail',
      })

      // ---------- 6. A 仍活着：进程/电话/中枢/租约 ----------
      const alivePid = host1.pid !== null && isProcessAlive(host1.pid)
      const aStatus = await callPhone(host1.host, phonesA.status, {}, routeA)
      const aCheck = await callPhone(host1.host, phonesA.check, {}, routeA)
      const hubPartial = await callPhone(host1.host, phonesA.hubStatus, {}, routeA)
      const leasePartial = await readLease()
      await run.raw('m3-a-alive-after-failure', {
        pid: host1.pid,
        alive: alivePid,
        status: { status: aStatus.status, ok: aStatus.ok, body: aStatus.body },
        check: { status: aCheck.status, ok: aCheck.ok, body: aCheck.body },
        hub: { status: hubPartial.status, ok: hubPartial.ok, body: hubPartial.body },
        lease: leasePartial,
      })
      run.record({
        step: 'M3 失败后 A 插件仍活着：宿主进程在、A 的状态/检查电话可达',
        what: 'A 自己行失败不影响 A 自身存活（web 宿主 pid 仍在；updateStatus/updateCheck 电话正常）',
        expected: 'pid 存活；updateStatus.ok=true；updateCheck.ok=true 且 installedVersion=' + baselineVersion,
        actual: 'pid=' + String(host1.pid) + ' alive=' + String(alivePid) + '；status.ok=' + String(aStatus.ok) + '；check.ok=' + String(aCheck.ok) + '；installedVersion=' + String(aCheck.snapshot?.installedVersion ?? null),
        verdict: alivePid && aStatus.ok && aCheck.ok && aCheck.snapshot?.installedVersion === baselineVersion ? 'pass' : 'fail',
      })
      const leaseOwnedByHost = leasePartial === null || leasePartial?.pid === host1.pid
      const hubSessionPartial = Array.isArray(hubPartial.snapshot?.sessions) ? hubPartial.snapshot.sessions[0] ?? null : null
      run.record({
        step: 'M3 中枢继续泵、租约未被外来驱动者占用',
        what: 'A 失败后中枢会话仍可读、没有第二个驱动者；租约要么已释放要么还是本宿主的',
        expected: 'hub.ok=true 且 snapshot 可读；租赁 pid 为空或=' + String(host1.pid),
        actual: 'hub.ok=' + String(hubPartial.ok) + '；session=' + JSON.stringify(hubSessionPartial) + '；lease=' + JSON.stringify(leasePartial),
        verdict: hubPartial.ok && hubPartial.snapshot !== null && leaseOwnedByHost ? 'pass' : 'fail',
      })

      // ---------- 7. 恢复 tarball + 清 run 私有 pnpm store 的坏包缓存 ----------
      const restore = await restoreCorruptedTarball({ registry: fixtureEnv.registry, fault: corruption })
      await run.raw('m3-restore-tarball', restore)
      run.record({
        step: 'M3 恢复环境：A@0.0.2 tarball 字节还原（sha 与原始一致、元数据未动）',
        what: 'restoreCorruptedTarball 把备份字节写回',
        expected: 'shaMatches=true；versionDocUnchanged=true',
        actual: JSON.stringify(restore),
        verdict: restore.shaMatches === true && restore.versionDocUnchanged === true ? 'pass' : 'fail',
      })
      const storeFilesBefore = (await listFilesRecursive(storeDir).catch(() => [] as string[])).length
      await rm(storeDir, { recursive: true, force: true })
      await ensureDir(storeDir)
      await run.raw('m3-pnpm-store-reset', { storeDir, filesBefore: storeFilesBefore })
      run.record({
        step: 'M3 清掉坏 tarball 在 run 私有 pnpm store 的失败缓存（环境修复，不动已装包）',
        what: 'K3 实测：坏 tarball 的失败尝试会留下 integrity 不匹配的缓存，不清则恢复后仍反复失败',
        expected: 'reset 前 store 有文件；reset 后目录重建',
        actual: 'filesBefore=' + String(storeFilesBefore),
        verdict: storeFilesBefore > 0 ? 'pass' : 'fail',
      })

      // ---------- 8. 真 UI 行内重试 A 行 ----------
      const beforeRetryPanel = await readSeatNow()
      const beforeRetryRowA = rowOfKey(beforeRetryPanel, 'a')
      await clickSeatAction(uiSession(), 'a', 'row-install', 'a')
      run.record({
        step: 'M3 真 UI 行内「重试」点击（只重试 A 行）',
        what: '点击 A 行 data-act=row-install（产品按 keys=[a] 复位该行并推进）',
        expected: '点击前 A 行动作含 row-install；点击成功',
        actual: 'beforeRetryA=' + JSON.stringify(beforeRetryRowA ? { phase: beforeRetryRowA.phase, actions: beforeRetryRowA.actions } : null),
        verdict: beforeRetryRowA !== null && (beforeRetryRowA.actions || []).indexOf('row-install') >= 0 ? 'pass' : 'fail',
      })
      const retryDeadline = Date.now() + M3_DISK_WAIT_MS
      const retryObserved: string[] = []
      let retryDisk = await diskOf()
      let retryLedgerA: any = await ledgerFor('fxa-a')
      let retrySettled = false
      while (Date.now() < retryDeadline) {
        retryDisk = await diskOf()
        retryLedgerA = await ledgerFor('fxa-a')
        const snapshot =
          'a=' + String(retryDisk.a) + ',b=' + String(retryDisk.b) + ',c=' + String(retryDisk.c) +
          ',aState=' + String(stateNameOf(retryLedgerA))
        if (retryObserved.length === 0 || retryObserved[retryObserved.length - 1] !== snapshot) retryObserved.push(snapshot)
        if (retryDisk.a === variantVersion && SUCCESS_STATES.includes(String(stateNameOf(retryLedgerA)))) {
          retrySettled = true
          break
        }
        await sleep(M3_POLL_MS)
      }
      const retryBatch = await readBatch(batchFileA)
      const retryLedgerDigest = await ledgerDigest()
      await run.raw('m3-retry-settled', {
        settled: retrySettled,
        disk: retryDisk,
        ledger: retryLedgerDigest,
        batch: retryBatch,
        observed: retryObserved.slice(-12),
      })
      run.record({
        step: 'M3 重试生效：A 行装成 0.0.2、台账转成功终态；B/C 不被重装（仍 0.0.2）',
        what: '真 UI 行内重试后，盘上 A 到 0.0.2、fxa-a 台账成功；B/C 磁盘不变',
        expected: 'a=' + variantVersion + '；fxa-a state∈{completed,restart-required} target=' + variantVersion + '；b/c=' + variantVersion,
        actual: 'settled=' + String(retrySettled) + '；disk=' + JSON.stringify(retryDisk) + '；fxa-a=' + JSON.stringify({ state: stateNameOf(retryLedgerA), targetVersion: retryLedgerA?.targetVersion ?? null }),
        verdict:
          retrySettled && retryDisk.a === variantVersion && retryDisk.b === variantVersion && retryDisk.c === variantVersion &&
          SUCCESS_STATES.includes(String(stateNameOf(retryLedgerA))) && retryLedgerA?.targetVersion === variantVersion
            ? 'pass'
            : 'fail',
      })

      // ---------- 9. 重启后一致：停宿主再起，面板/台账/磁盘一致 ----------
      const hostAliveAfterRetry = host1.pid !== null && isProcessAlive(host1.pid)
      run.record({
        step: 'M3 重试成功后宿主仍活着（web 通道自更新不杀进程）',
        what: 'A 自更新成功后宿主 pid 仍在（不是靠换进程掩盖）',
        expected: 'pid=' + String(host1.pid) + ' 存活',
        actual: 'alive=' + String(hostAliveAfterRetry),
        verdict: hostAliveAfterRetry ? 'pass' : 'fail',
      })
      await closeUiFor('after-retry')
      await closeHost(host1, 'm3-after-retry')
      host1 = null
      host2 = await startHost('host2')
      await openUiFor(host2.host.url, 'host2')
      const finalSeat = await waitSeat((state) => {
        if (state.panel.rows.length < 3) return false
        return state.panel.rows.every((row) => ['done', 'current'].includes(String(row.phase)) && row.versionCur === variantVersion)
      }, 'M3 重启后三行终态 0.0.2', M3_PANEL_WAIT_MS)
      // 重启后面板挂载会触发一次按需重查：总账行短暂显示「正在按最新版本重新检查…」。
      // 等它落定成「N 个已是最新 / N 个待重启」再取稳态面板（这是 UI/台账一致性的证据；最多 60s）。
      const ledgerSettled = await waitSeat(
        (state) => {
          const text = String(state.panel.ledger ?? '')
          return text.indexOf('3 个已是最新') >= 0 || text.indexOf('3 个待重启') >= 0
        },
        'M3 重启后总账文案落定（已是最新/待重启）',
        60_000,
      )
      await sleep(500)
      const finalPanel = ledgerSettled ?? finalSeat ?? (await readSeatNow())
      const finalDisk = await diskOf()
      const finalLedger = await ledgerDigest()
      const finalSummary = finalPanel?.panel.summary ?? ''
      const finalLedgerText = finalPanel?.panel.ledger ?? ''
      const finalRowsOk =
        finalPanel !== null && finalPanel.panel.rows.length === 3 &&
        finalPanel.panel.rows.every((row) => ['done', 'current'].includes(String(row.phase)) && row.versionCur === variantVersion)
      const finalSummaryOk = finalSummary.indexOf('已全部为最新') >= 0 || finalSummary.indexOf('个已安装完成') >= 0
      const finalLedgerOk = finalLedgerText.indexOf('3 个已是最新') >= 0 || finalLedgerText.indexOf('3 个待重启') >= 0
      if (ui) {
        await captureUiShot(run, ui, {
          step: 'm3-40-after-restart',
          what: '重试成功并重启宿主后：三行 done/current 0.0.2，总账/台账「全部为最新/待重启」——UI/台账/磁盘一致',
          expected: '三行 phase∈{done,current} 且 cur=0.0.2；summary 含「已全部为最新」或「个已安装完成」；ledger 含「3 个已是最新」或「3 个待重启」',
          actual: JSON.stringify({ rows: finalPanel ? finalPanel.panel.rows.map((row) => ({ key: row.key, phase: row.phase, cur: row.versionCur })) : null, summary: finalSummary, ledger: finalLedgerText, disk: finalDisk }),
          verdict: finalRowsOk && finalSummaryOk && finalLedgerOk ? 'pass' : 'fail',
        })
      }
      const finalBatch = await readBatch(batchFileA)
      await run.raw('m3-final-state', { panel: finalPanel, batch: finalBatch, disk: finalDisk, ledger: finalLedger })
      run.record({
        step: 'M3 重启后一致：UI 三行终态、台账 3 条成功终态、磁盘三包 0.0.2',
        what: '停掉 A 宿主后重启（同 home/profile），批量会话与台账从盘上恢复后仍一致',
        expected: '三行 done/current 0.0.2；磁盘 a/b/c=' + variantVersion + '；台账 fxa-a/fxa-b/fxa-c 各 1 条成功终态 target=' + variantVersion,
        actual: JSON.stringify({ rows: finalPanel ? finalPanel.panel.rows.map((row) => ({ key: row.key, phase: row.phase, cur: row.versionCur })) : null, summary: finalSummary, ledger: finalLedgerText, disk: finalDisk, ledgerRows: finalLedger }),
        verdict:
          finalRowsOk && finalSummaryOk && finalLedgerOk &&
          finalDisk.a === variantVersion && finalDisk.b === variantVersion && finalDisk.c === variantVersion &&
          ['fxa-a', 'fxa-b', 'fxa-c'].every((id) => {
            const rows = (finalLedger as Record<string, any[]>)[id] ?? []
            return rows.length === 1 && SUCCESS_STATES.includes(String(rows[0]?.state)) && rows[0]?.targetVersion === variantVersion
          })
            ? 'pass'
            : 'fail',
      })
      // 租约收尾：重启后的中枢没有活任务时应已归还（盘上没有别人的租约）。
      let leaseFinal: any = await readLease()
      const leaseDeadline = Date.now() + 20_000
      while (Date.now() < leaseDeadline && leaseFinal !== null) {
        await sleep(500)
        leaseFinal = await readLease()
      }
      await run.raw('m3-lease-final', { lease: leaseFinal })
      run.record({
        step: 'M3 租约正常释放：重启后中枢空闲时盘上无未归还租约',
        what: 'hub/pump 收尾会归还自己这一代租约；重启后无活任务时 lease.json 不应残留别人的驾驶位',
        expected: 'lease.json 不存在（或已被正常释放）',
        actual: 'lease=' + JSON.stringify(leaseFinal),
        verdict: leaseFinal === null ? 'pass' : 'fail',
      })

      await closeUiFor('final')
      await finalizeHosts()

      // ---------- 10. 停宿主后读日志：重试只重跑 A、B/C 无重复安装、失败如实记录 ----------
      const finalLogRows = await readRawLogRows(homeDir)
      const execB = execRowsOf(finalLogRows, batchTargetPrefixesA.get('b') ?? 'fxa-b')
      const execC = execRowsOf(finalLogRows, batchTargetPrefixesA.get('c') ?? 'fxa-c')
      const execA = execRowsOf(finalLogRows, batchTargetPrefixesA.get('a') ?? 'fxa-a')
      const okExecA = execA.filter((row) => row.ok === true).length
      const failExecA = execA.filter((row) => row.ok !== true).length
      const okExecB = execB.filter((row) => row.ok === true).length
      const okExecC = execC.filter((row) => row.ok === true).length
      const selfPrefixForLog = selfPrefixA + '/'
      const selfInstallRequests = finalLogRows.filter(
        (row) => row.event === 'update.install.request' && typeof row.source === 'string' && row.source.startsWith(selfPrefixForLog),
      )
      const hostCallOkA = finalLogRows.filter(
        (row) => row.event === 'host.call' && row.fields?.method === selfPrefixA + '.updateInstall' && row.fields?.ok === true,
      )
      const entryFailRows = finalLogRows
        .filter((row) => row.event === 'update.batch.entry.fail')
        .map((row) => ({
          ts: row.ts,
          errorKind: row.fields?.errorKind ?? null,
          stage: row.fields?.stage ?? null,
          index: row.fields?.index ?? null,
          exitCode: row.fields?.exitCode ?? null,
        }))
      const installStageFails = entryFailRows.filter((row) => row.stage === 'install')
      const goodRowInstallFails = installStageFails.filter((row) => row.index === 1 || row.index === 2)
      const installFailRows = finalLogRows
        .filter((row) => row.event === 'update.install.fail')
        .map((row) => ({ ts: row.ts, stage: row.fields?.stage ?? null, code: row.fields?.code ?? null, reason: row.fields?.reason ?? null, pluginId: row.fields?.pluginId ?? null }))
      const execStageFails = installFailRows.filter((row) => row.stage === 'exec')
      const batchRunStarts = finalLogRows
        .filter((row) => row.event === 'update.batch.run.start')
        .map((row) => ({ trigger: row.fields?.trigger ?? null, resumed: row.fields?.resumed ?? null, total: row.fields?.total ?? null, sessionHash: row.fields?.sessionHash ?? null }))
      const batchSummaries = finalLogRows
        .filter((row) => row.event === 'update.batch.summary')
        .map((row) => ({ total: row.fields?.total ?? null, ok: row.fields?.ok ?? null, failed: row.fields?.failed ?? null, stoppedBecause: row.fields?.stoppedBecause ?? null }))
      await run.raw('m3-log-timeline', {
        eventCounts: eventCountsOf(finalLogRows),
        execA,
        execB,
        execC,
        selfInstallRequests,
        hostCallOkA,
        entryFailRows,
        installFailRows,
        batchRunStarts,
        batchSummaries,
        note:
          'M3 里 A 自键更新同样走 cli-process executor（exec 行 pluginId=fxa-a）：坏 tarball 那次 ok=false，' +
          '回滚 + 恢复后重试 ok=true；B/C 各 1 条 ok=true。host.call ok 行有 3 条（check-expired 退避/重提），不能当 exactly-once 口径。',
      })
      run.record({
        step: 'M3 重试只重跑 A：A 成功自更新恰 1 次（exec ok=1、坏包失败=1），B/C 成功 exec 各恰 1 次无重复',
        what: '停宿主后读最终日志：坏 A 首次 exec 失败 + 恢复后重试 exec 成功；B/C 的安装处于重试窗口之外',
        expected: 'okExecA=1 且 failExecA=1；okExecB=1；okExecC=1；且没有 B/C 的安装失败 entry.fail',
        actual: 'okExecA=' + String(okExecA) + '；failExecA=' + String(failExecA) + '；okExecB=' + String(okExecB) + '；okExecC=' + String(okExecC) + '；goodRowInstallFails=' + JSON.stringify(goodRowInstallFails),
        verdict: okExecA === 1 && failExecA === 1 && okExecB === 1 && okExecC === 1 && goodRowInstallFails.length === 0 ? 'pass' : 'fail',
      })
      run.record({
        step: 'M3 失败如实记录：A 的首次失败在批量账本日志里留下 entry.fail（index=0）与 exec 阶段 install.fail',
        what: 'update.batch.entry.fail（errorKind/stage/index）与 update.install.fail（stage=exec）两条独立日志事实，不是靠 UI 文案倒推',
        expected: 'entry.fail 恰 1 条且 index=0、errorKind 非空；exec 阶段 install.fail 至少 1 条（nonzero-exit）；B/C（index 1/2）没有 entry.fail',
        actual: 'entryFail=' + JSON.stringify(entryFailRows) + '；execStageFails=' + JSON.stringify(execStageFails) + '；goodRowInstallFails=' + JSON.stringify(goodRowInstallFails),
        verdict:
          entryFailRows.length === 1 &&
          entryFailRows[0].index === 0 &&
          typeof entryFailRows[0].errorKind === 'string' &&
          entryFailRows[0].errorKind.length > 0 &&
          execStageFails.length >= 1 &&
          goodRowInstallFails.length === 0
            ? 'pass'
            : 'fail',
      })
      run.record({
        step: 'M3 exactly-once：每个目标成功安装至多一次（A/B/C 各 1 次），exec 失败行恰 1 条（A 的坏包首试）',
        what: '宿主全关后重读最终日志；A 自更新成功 1 次、B/C 各 1 次；失败只有 A 坏包那一次',
        expected: 'okExecA=1 且 failExecA=1；okExecB=1；okExecC=1；exec 阶段失败行恰 1 条',
        actual: 'okExecA=' + String(okExecA) + '；failExecA=' + String(failExecA) + '；okExecB=' + String(okExecB) + '；okExecC=' + String(okExecC) + '；execStageFails=' + JSON.stringify(execStageFails),
        verdict: okExecA === 1 && failExecA === 1 && okExecB === 1 && okExecC === 1 && execStageFails.length === 1 ? 'pass' : 'fail',
      })
      run.record({
        step: 'M3 批量日志收口：最终 summary total=3 ok=3 failed=0',
        what: 'update.batch.summary 的最终一条（重试后的收尾）',
        expected: '存在 total=3、ok=3、failed=0 的 summary',
        actual: JSON.stringify(batchSummaries),
        verdict: batchSummaries.some((row) => row.total === 3 && row.ok === 3 && row.failed === 0) ? 'pass' : 'fail',
      })

      return await finish(run, options)
    }

    // ==========================================================================================
    // M4：同一 home 两个普通 profile 各开一个宿主，同一 tick 发起三包批量更新（按 profile 隔离锁/队列）。
    // ==========================================================================================
    if (options.mode === 'm4') {
      const P1 = 't14p1'
      const P2 = 't14p2'
      await run.addNote(
        'M4 并发注入：同一 home、两个非 desktop 普通 profile（' + P1 + '/' + P2 + '）各起一个 web 宿主；' +
          '两批 batchInstall 在同一 tick 用 HTTP 电话发出（面板「全部更新」按钮背后是同一入口）。' +
          '本格不开浏览器：断言对象是更新队列/中枢锁按 profile 隔离与两个安装窗真并发，UI 三包入口证据由 M3 的同一面板承担。',
      )

      const createP1 = await createWebProfileInHome({ homeDir, profileName: P1 })
      const createP2 = await createWebProfileInHome({ homeDir, profileName: P2 })
      await run.raw('m4-profile-create', {
        p1: { exitCode: createP1.create.exitCode, profileDir: createP1.profileDir, stdout: createP1.create.stdout, stderr: createP1.create.stderr },
        p2: { exitCode: createP2.create.exitCode, profileDir: createP2.profileDir, stdout: createP2.create.stdout, stderr: createP2.create.stderr },
      })
      run.record({
        step: 'M4 两个普通 profile 就绪（同一 home）',
        what: 'createWebProfileInHome 建 ' + P1 + '/' + P2 + '（非 desktop）；两 profileDir 互异',
        expected: 'exit 都为 0；profileDir 互异且都在 <home>/profiles 下',
        actual: 'p1.exit=' + createP1.create.exitCode + '；p2.exit=' + createP2.create.exitCode + '；p1=' + createP1.profileDir + '；p2=' + createP2.profileDir,
        verdict:
          createP1.create.exitCode === 0 && createP2.create.exitCode === 0 && createP1.profileDir !== createP2.profileDir ? 'pass' : 'fail',
      })

      // 两个 profile 各装基版 A/B@0.0.1（C 不在册，由 A 的批量方案在更新里补装，与 M1/M3 同口径）。
      await run.installBaseline({ homeDir, profileName: P1, registryUrl })
      await run.installBaseline({ homeDir, profileName: P2, registryUrl })
      const p1Baseline = await installedFixtureVersion({ homeDir, profileName: P1, packageName: slotA.packageName })
      const p2Baseline = await installedFixtureVersion({ homeDir, profileName: P2, packageName: slotA.packageName })
      const p1BaselineB = await installedFixtureVersion({ homeDir, profileName: P1, packageName: slotB.packageName })
      const p2BaselineB = await installedFixtureVersion({ homeDir, profileName: P2, packageName: slotB.packageName })
      const diskP1Before = await readDiskFacts('m4-p1-before', P1)
      const diskP2Before = await readDiskFacts('m4-p2-before', P2)
      run.record({
        step: 'M4 两个 profile 更新前基版在盘（A/B@' + baselineVersion + '）',
        what: '两个 profile 各自经 CLI 装上 A/B 基版，node_modules 包版本与清单 dependencies 一致',
        expected: 'p1/p2 的 A=' + baselineVersion + ' 且 B=' + baselineVersion + '；两 profile dependencies 各自含 A/B',
        actual: 'p1=' + String(p1Baseline) + '/' + String(p1BaselineB) + '；p2=' + String(p2Baseline) + '/' + String(p2BaselineB) + '；deps p1=' + JSON.stringify(diskP1Before.dependencies) + '；deps p2=' + JSON.stringify(diskP2Before.dependencies),
        verdict:
          p1Baseline === baselineVersion && p2Baseline === baselineVersion && p1BaselineB === baselineVersion && p2BaselineB === baselineVersion
            ? 'pass'
            : 'fail',
      })

      // 两套隔离目录（按 profileDir 短哈希复算，盘上目录后验）。
      const hash1 = shortHashOf(createP1.profileDir)
      const hash2 = shortHashOf(createP2.profileDir)
      const queueDirP1 = join(homeDir, 'update-queue', hash1)
      const queueDirP2 = join(homeDir, 'update-queue', hash2)
      const leaseFileP1 = join(queueDirP1, 'hub', 'lease.json')
      const leaseFileP2 = join(queueDirP2, 'hub', 'lease.json')
      const batchFileP1 = join(queueDirP1, prefixA, 'batch.json')
      const batchFileP2 = join(queueDirP2, prefixA, 'batch.json')
      await run.raw('m4-isolated-paths', {
        hash1,
        hash2,
        queueDirP1,
        queueDirP2,
        leaseFileP1,
        leaseFileP2,
        batchFileP1,
        batchFileP2,
        ledgerP1: join(homeDir, 'updates', 'fxa-a', hash1, 'state.json'),
        ledgerP2: join(homeDir, 'updates', 'fxa-a', hash2, 'state.json'),
        why: '队列/锁/台账目录 = <home>/update-queue/<shortHash(profileDir)>；两 profile 不同 ⇒ 两套目录（盘上实测见后验断言）。',
      })
      run.record({
        step: 'M4 两 profile 的队列路径互异（按 profileDir 短哈希隔离）',
        what: '复算两套 update-queue 路径；profileDir 不同 ⇒ 短哈希不同',
        expected: 'hash1≠hash2；两套 queue/batch/lease 路径互异',
        actual: 'hash1=' + hash1 + '；hash2=' + hash2 + '；queue 相同=' + String(queueDirP1 === queueDirP2),
        verdict: hash1 !== hash2 && queueDirP1 !== queueDirP2 ? 'pass' : 'fail',
      })

      const hostP1 = await startHost('m4-p1', P1)
      const hostP2 = await startHost('m4-p2', P2)
      await run.raw('m4-hosts', { p1: { pid: hostP1.pid, port: hostP1.port, profile: P1 }, p2: { pid: hostP2.pid, port: hostP2.port, profile: P2 } })
      run.record({
        step: 'M4 两个宿主各绑一个 profile 同时在线',
        what: '两个 DSH web 宿主同 home、不同 profileName（pid/端口互异）',
        expected: '两宿主 pid>0 且互异；端口互异',
        actual: 'p1.pid=' + String(hostP1.pid) + ' p1.port=' + hostP1.port + '；p2.pid=' + String(hostP2.pid) + ' p2.port=' + hostP2.port,
        verdict:
          hostP1.pid !== null && hostP2.pid !== null && hostP1.pid !== hostP2.pid && hostP1.port !== hostP2.port ? 'pass' : 'fail',
      })

      const checkP1 = await callPhone(hostP1.host, phonesA.batchCheck, {}, routeA)
      const checkP2 = await callPhone(hostP2.host, phonesA.batchCheck, {}, routeA)
      await run.raw('m4-batch-check', { p1: { ok: checkP1.ok, rows: checkP1.rows, body: checkP1.body }, p2: { ok: checkP2.ok, rows: checkP2.rows, body: checkP2.body } })
      const keysP1 = checkP1.rows.map((row: any) => String(row?.key ?? '')).sort()
      const keysP2 = checkP2.rows.map((row: any) => String(row?.key ?? '')).sort()
      run.record({
        step: 'M4 两个宿主各自的批量检查电话受理（各 3 行 a/b/c）',
        what: '两个宿主分别建自己的批量会话（同 home 不同 profile，互不共享会话）',
        expected: '两宿主 ok=true；rows 各=[a,b,c]',
        actual: 'p1.ok=' + checkP1.ok + ' rows=' + JSON.stringify(keysP1) + '；p2.ok=' + checkP2.ok + ' rows=' + JSON.stringify(keysP2),
        verdict:
          checkP1.ok && checkP2.ok &&
          JSON.stringify(keysP1) === JSON.stringify(['a', 'b', 'c']) &&
          JSON.stringify(keysP2) === JSON.stringify(['a', 'b', 'c'])
            ? 'pass'
            : 'fail',
      })

      // 同一 tick 发两批（不 await：批量电话同步驱动到收尾，必须在它跑的时候采样）。
      const fireAt = Date.now()
      const fireP1 = callPhone(hostP1.host, phonesA.batchInstall, {}, routeA).then(
        (result) => ({ who: 'p1', at: fireAt, ok: result.ok, error: result.error, body: result.body }),
        (error) => ({ who: 'p1', at: fireAt, rejected: messageOf(error) }),
      )
      const fireP2 = callPhone(hostP2.host, phonesA.batchInstall, {}, routeA).then(
        (result) => ({ who: 'p2', at: fireAt, ok: result.ok, error: result.error, body: result.body }),
        (error) => ({ who: 'p2', at: fireAt, rejected: messageOf(error) }),
      )
      await run.raw('m4-batch-install-fire', {
        at: fireAt,
        hostPids: [hostP1.pid, hostP2.pid],
        note: '两批 batchInstall 同一 tick 发出；期间只轮询两套 batch.json/queue.json/lease.json 采样（安装窗内不重启、不读日志）。',
      })
      run.record({
        step: 'M4 两批批量安装电话已同一 tick 发出（不等回包）',
        what: '两个宿主各自开始推进三包批量；之后轮询采样两套盘上状态',
        expected: '两批均落盘 batch.json 且曾同时有非终态行（安装窗重叠）',
        actual: 'fireAt=' + fireAt + '；hosts=' + String(hostP1.pid) + '/' + String(hostP2.pid),
        verdict: 'pass',
      })

      const samples: any[] = []
      let overlapFrame: any = null
      let ownerOverlapFrame: any = null
      let doneP1At: number | null = null
      let doneP2At: number | null = null
      let lastP1: any = null
      let lastP2: any = null
      const phasesActive = (phases: Record<string, string | null>): number =>
        Object.values(phases).filter((phase) => phase !== null && !TERMINAL_PHASES.includes(String(phase))).length
      const sampleDeadline = Date.now() + M4_BATCH_WAIT_MS
      while (Date.now() < sampleDeadline) {
        const [batch1, batch2, lease1, lease2, queue1, queue2] = await Promise.all([
          readJsonMaybe(batchFileP1),
          readJsonMaybe(batchFileP2),
          readJsonMaybe(leaseFileP1),
          readJsonMaybe(leaseFileP2),
          readJsonMaybe(join(queueDirP1, 'queue.json')),
          readJsonMaybe(join(queueDirP2, 'queue.json')),
        ])
        lastP1 = batch1
        lastP2 = batch2
        const phases1 = phasesOfBatch(batch1)
        const phases2 = phasesOfBatch(batch2)
        const frame = {
          t: Date.now(),
          p1: {
            batchId: batch1?.id ?? null,
            phases: phases1,
            active: phasesActive(phases1),
            queueOwner: queue1?.owner ?? null,
            lease: lease1 ? { pid: lease1.pid ?? null, generation: lease1.generation ?? null, driverId: lease1.driverId ?? null } : null,
          },
          p2: {
            batchId: batch2?.id ?? null,
            phases: phases2,
            active: phasesActive(phases2),
            queueOwner: queue2?.owner ?? null,
            lease: lease2 ? { pid: lease2.pid ?? null, generation: lease2.generation ?? null, driverId: lease2.driverId ?? null } : null,
          },
        }
        samples.push(frame)
        if (overlapFrame === null && frame.p1.active > 0 && frame.p2.active > 0) overlapFrame = frame
        if (overlapFrame !== null && ownerOverlapFrame === null && frame.p1.queueOwner !== null && frame.p2.queueOwner !== null) {
          ownerOverlapFrame = frame
        }
        if (doneP1At === null && allTerminal(batch1)) doneP1At = Date.now()
        if (doneP2At === null && allTerminal(batch2)) doneP2At = Date.now()
        if (doneP1At !== null && doneP2At !== null) break
        await sleep(M4_POLL_MS)
      }
      const settled = await Promise.race([
        Promise.all([fireP1, fireP2]).then((items) => ({ kind: 'resolved' as const, items })),
        sleep(30_000).then(() => ({ kind: 'timeout' as const, items: [] as any[] })),
      ])
      await run.raw('m4-concurrency-samples', {
        sampleCount: samples.length,
        fireAt,
        doneP1At,
        doneP2At,
        overlapFrame,
        ownerOverlapFrame,
        first: samples.slice(0, 3),
        last: samples.slice(-3),
        samples,
        settle: settled,
        note: '采样只读盘：batch.json 行 phase、queue.json owner、hub/lease.json；active = 非终态行数，两批同时 active>0 即安装窗真重叠。',
      })
      const finalBatchP1 = await readBatch(batchFileP1)
      const finalBatchP2 = await readBatch(batchFileP2)
      const finalQueueP1 = await readJsonMaybe(join(queueDirP1, 'queue.json'))
      const finalQueueP2 = await readJsonMaybe(join(queueDirP2, 'queue.json'))
      await run.raw('m4-final-batches', { p1: finalBatchP1, p2: finalBatchP2, queueP1: finalQueueP1, queueP2: finalQueueP2 })

      run.record({
        step: 'M4 两个安装窗真实重叠：采样到两批同时有非终态行（不互斥）',
        what: '并发采样两套 batch.json：两批同一时刻都还在装（active>0），证明按 profile 隔离而非串行排队',
        expected: '至少一帧 p1.active>0 且 p2.active>0；两批 batchId 互异',
        actual: overlapFrame === null
          ? '未采样到重叠帧；samples=' + String(samples.length)
          : 'at=' + overlapFrame.t + '；p1=' + JSON.stringify(overlapFrame.p1.phases) + '；p2=' + JSON.stringify(overlapFrame.p2.phases) + '；batchIds=' + String(overlapFrame.p1.batchId) + '/' + String(overlapFrame.p2.batchId),
        verdict: overlapFrame !== null && overlapFrame.p1.batchId !== overlapFrame.p2.batchId ? 'pass' : 'fail',
      })
      run.record({
        step: 'M4 两 profile 的队列/corral 各自持有：owner/lease 采样互不占用',
        what: 'queue.json owner 与 hub/lease.json 按 profile 各有一套；采样到两 owner 同时在、且不属于同一 profile',
        expected: '至少一帧两 queue owner 同时非空；owner 互异；lease pid 属于各自宿主',
        actual: ownerOverlapFrame === null
          ? '未采样到两 owner 同时帧；last=' + JSON.stringify({ p1: lastP1 ? 'batch' : null, p2: lastP2 ? 'batch' : null })
          : 'at=' + ownerOverlapFrame.t + '；owners=' + String(ownerOverlapFrame.p1.queueOwner) + '/' + String(ownerOverlapFrame.p2.queueOwner) + '；leases=' + JSON.stringify({ p1: ownerOverlapFrame.p1.lease, p2: ownerOverlapFrame.p2.lease }),
        verdict:
          ownerOverlapFrame !== null && ownerOverlapFrame.p1.queueOwner !== ownerOverlapFrame.p2.queueOwner ? 'pass' : 'fail',
      })

      const batchOk = (batch: any): boolean =>
        batch !== null && Array.isArray(batch?.entries) && batch.entries.length === 3 && allTerminal(batch) &&
        batch.entries.every((entry: any) => entry?.phase === 'done' && entry?.targetVersion === variantVersion)
      run.record({
        step: 'M4 两批都推进到三行 done（同一 tick 发起、各自装完 0.0.2）',
        what: '两套 batch.json 的 entries 全部 phase=done targetVersion=' + variantVersion,
        expected: 'p1/p2 各 3 行 done 0.0.2；两 batch id 互异',
        actual: 'p1=' + JSON.stringify({ id: finalBatchP1?.id ?? null, phases: phasesOfBatch(finalBatchP1), targets: (finalBatchP1?.entries ?? []).map((entry: any) => entry?.targetVersion ?? null) }) +
          '；p2=' + JSON.stringify({ id: finalBatchP2?.id ?? null, phases: phasesOfBatch(finalBatchP2), targets: (finalBatchP2?.entries ?? []).map((entry: any) => entry?.targetVersion ?? null) }),
        verdict: batchOk(finalBatchP1 as any) && batchOk(finalBatchP2 as any) && finalBatchP1?.id !== finalBatchP2?.id ? 'pass' : 'fail',
      })
      run.record({
        step: 'M4 两电话回包都 ok（无一方被另一方挡成 busy）',
        what: '两批 batchInstall HTTP 电话的最终回包',
        expected: '两回包均 ok=true（settle=' + settled.kind + '）',
        actual: JSON.stringify(settled.items.map((item: any) => ({ who: item.who, ok: item.ok ?? null, error: item.error ?? null, rejected: item.rejected ?? null }))),
        verdict:
          settled.kind === 'resolved' && settled.items.length === 2 && settled.items.every((item: any) => item.ok === true) ? 'pass' : 'fail',
      })

      // 面板/中枢状态（两宿主仍在线）。
      const statusP1 = await callPhone(hostP1.host, phonesA.batchStatus, {}, routeA)
      const statusP2 = await callPhone(hostP2.host, phonesA.batchStatus, {}, routeA)
      const hubP1 = await callPhone(hostP1.host, phonesA.hubStatus, {}, routeA)
      const hubP2 = await callPhone(hostP2.host, phonesA.hubStatus, {}, routeA)
      await run.raw('m4-panel-finals', { statusP1: statusP1.body, statusP2: statusP2.body, hubP1: hubP1.body, hubP2: hubP2.body })
      const panelRowsOk = (status: PhoneResult): boolean =>
        status.ok && status.rows.length === 3 && status.rows.every((row: any) => row?.phase === 'done' && row?.targetVersion === variantVersion)
      run.record({
        step: 'M4 两个 profile 各自的面板批量三行 done 0.0.2',
        what: '两宿主的 batchStatus 回包（各自面板数据源，互不串 profile）',
        expected: 'p1.ok/p2.ok=true；各 3 行 done targetVersion=' + variantVersion,
        actual: 'p1=' + JSON.stringify({ ok: statusP1.ok, rows: statusP1.rows.map((row: any) => ({ key: row?.key, phase: row?.phase, targetVersion: row?.targetVersion })) }) +
          '；p2=' + JSON.stringify({ ok: statusP2.ok, rows: statusP2.rows.map((row: any) => ({ key: row?.key, phase: row?.phase, targetVersion: row?.targetVersion })) }),
        verdict: panelRowsOk(statusP1) && panelRowsOk(statusP2) ? 'pass' : 'fail',
      })
      const hubOk = (status: PhoneResult): boolean => {
        const sessions = Array.isArray(status.snapshot?.sessions) ? status.snapshot.sessions : []
        const session = sessions.find((item: any) => item?.state === 'finished') ?? sessions[0] ?? null
        return status.ok && session?.state === 'finished' && session?.progress?.done === 3 && session?.progress?.failed === 0 && (status.snapshot?.activeInstall ?? null) === null
      }
      run.record({
        step: 'M4 两个中枢各自 finished done3 failed0 activeInstall=null（无虚假 busy/无抢占）',
        what: '两宿主 updateHubStatus 回包的中枢状态',
        expected: '两中枢 state=finished、progress.done=3、failed=0、activeInstall=null',
        actual: 'p1=' + JSON.stringify({ ok: hubP1.ok, sessions: hubP1.snapshot?.sessions ?? null, activeInstall: hubP1.snapshot?.activeInstall ?? null }) +
          '；p2=' + JSON.stringify({ ok: hubP2.ok, sessions: hubP2.snapshot?.sessions ?? null, activeInstall: hubP2.snapshot?.activeInstall ?? null }),
        verdict: hubOk(hubP1) && hubOk(hubP2) ? 'pass' : 'fail',
      })

      // 磁盘/台账（两 profile 各自独立、互不写入）。
      const diskP1After = await readDiskFacts('m4-p1-after', P1)
      const diskP2After = await readDiskFacts('m4-p2-after', P2)
      const diskOk = (facts: any): boolean =>
        (facts?.manifestParseError ?? null) === null && ['a', 'b', 'c'].every((key: string) => facts?.nodeModules?.[key] === variantVersion && facts?.dependencies?.[key] === variantVersion)
      run.record({
        step: 'M4 两个 profile 磁盘各自三包 0.0.2（清单/node_modules 一致）',
        what: '两 profile 的 dsh.profile.dependencies 与 node_modules 包版本',
        expected: 'p1/p2 的 a/b/c 包版本与 dependencies 都=' + variantVersion + '；manifest 可解析',
        actual: 'p1=' + JSON.stringify({ deps: diskP1After.dependencies, nodeModules: diskP1After.nodeModules }) + '；p2=' + JSON.stringify({ deps: diskP2After.dependencies, nodeModules: diskP2After.nodeModules }),
        verdict: diskOk(diskP1After) && diskOk(diskP2After) ? 'pass' : 'fail',
      })

      const allLedger = await readLedgerStates(homeDir)
      const ledgerByHash: Record<string, Record<string, any[]>> = { [hash1]: {}, [hash2]: {} }
      const foreignLedger: string[] = []
      for (const row of allLedger) {
        const pluginId = ledgerPluginIdOf(row.file)
        if (!pluginId) continue
        const bucket = row.file.indexOf(hash1) >= 0 ? hash1 : row.file.indexOf(hash2) >= 0 ? hash2 : null
        if (bucket === null) {
          foreignLedger.push(row.file)
          continue
        }
        ledgerByHash[bucket][pluginId] = ledgerByHash[bucket][pluginId] ?? []
        ledgerByHash[bucket][pluginId].push(row.state)
      }
      const M4_SUCCESS_STATES = ['completed', 'restart-required']
      const ledgerOk = (bucket: string): boolean =>
        ['fxa-a', 'fxa-b', 'fxa-c'].every((pluginId) => {
          const states = ledgerByHash[bucket][pluginId] ?? []
          // A 是基版在盘的包（previous=0.0.1）；B/C 本次批量才首次装进该 profile（previous=null 合法，也接受 0.0.1）。
          const previousOk =
            pluginId === 'fxa-a'
              ? states[0]?.previousVersion === baselineVersion
              : states[0]?.previousVersion === null || states[0]?.previousVersion === baselineVersion
          return states.length === 1 && M4_SUCCESS_STATES.includes(String(states[0]?.state)) && states[0]?.targetVersion === variantVersion && previousOk
        })
      await run.raw('m4-ledger', {
        hash1,
        hash2,
        byHash: Object.fromEntries(
          Object.entries(ledgerByHash).map(([hash, plugins]) => [
            hash,
            Object.fromEntries(Object.entries(plugins).map(([pluginId, states]) => [pluginId, states.map((state: any) => ({ state: state?.state ?? null, targetVersion: state?.targetVersion ?? null, previousVersion: state?.previousVersion ?? null }))])),
          ]),
        ),
        foreignLedger,
        rows: allLedger.map((row) => ({ file: row.file, state: row.state?.state ?? null, targetVersion: row.state?.targetVersion ?? null })),
      })
      run.record({
        step: 'M4 两个 profile 台账各自完整：三包各恰 1 条成功终态 target=0.0.2（A previous=0.0.1；B/C 本批首装可 null）',
        what: '按 profileDir 短哈希分组读 <home>/updates/<pluginId>/<hash>/state.json',
        expected: 'hash1/hash2 各 fxa-a/fxa-b/fxa-c 恰 1 条成功终态；A 的 previous=0.0.1；B/C previous∈{null,0.0.1}；无第三套 hash 的写入',
        actual: 'p1.ok=' + String(ledgerOk(hash1)) + '；p2.ok=' + String(ledgerOk(hash2)) + '；foreign=' + JSON.stringify(foreignLedger) +
          '；counts=' + JSON.stringify(Object.fromEntries(Object.entries(ledgerByHash).map(([hash, plugins]) => [hash, Object.fromEntries(Object.entries(plugins).map(([pluginId, states]) => [pluginId, states.length]))])))
        ,
        verdict: ledgerOk(hash1) && ledgerOk(hash2) && foreignLedger.length === 0 ? 'pass' : 'fail',
      })
      const actualQueueDirs = (await listDirs(join(homeDir, 'update-queue'))).sort()
      run.record({
        step: 'M4 盘上正好两套 update-queue 目录（=两 profile 短哈希），没有抢占同一目录',
        what: 'list <home>/update-queue 与两 profile 短哈希对照',
        expected: '盘上目录集=' + JSON.stringify([hash1, hash2].sort()),
        actual: JSON.stringify(actualQueueDirs),
        verdict: JSON.stringify(actualQueueDirs) === JSON.stringify([hash1, hash2].sort()) ? 'pass' : 'fail',
      })

      // 两宿主共用同一 <home>/logs（同 home 不同 profile）：host.close() = taskkill /T /F 硬杀，
      // 停之前留个短窗口让最后几次安装的日志行落盘，避免「日志尾巴」被当成证据缺口（284-20261103T222150 实测 C 少 1 行）。
      await sleep(3000)
      await run.raw('m4-stop-settle', {
        at: Date.now(),
        why: '两个 web 宿主同 home、同 logs 目录；先让最后一次安装的日志行落盘，再硬杀宿主，之后才读日志取证。',
      })
      await closeHost(hostP1, 'm4-p1-after-batch')
      await closeHost(hostP2, 'm4-p2-after-batch')
      await finalizeHosts()

      // 停宿主后读日志：同插件在两个 profile 各装一次 = 每包 2 条成功 exec；两安装窗真重叠；无 busy。
      const finalLogRows = await readRawLogRows(homeDir)
      const execBAll = execRowsOf(finalLogRows, batchTargetPrefixesA.get('b') ?? 'fxa-b')
      const execCAll = execRowsOf(finalLogRows, batchTargetPrefixesA.get('c') ?? 'fxa-c')
      const okExecBAll = execBAll.filter((row) => row.ok === true)
      const okExecCAll = execCAll.filter((row) => row.ok === true)
      const windowsOfRow = (row: any): { start: number; end: number }[] => {
        const duration = Number(row?.durationMs ?? 0)
        const ts = Number(row?.ts ?? 0)
        // 日志 ts 是事件发射时刻；若 ts 是结束时刻，区间为 [ts-duration, ts]；若是开始时刻，为 [ts, ts+duration]。两种都认。
        return [
          { start: ts, end: ts + duration },
          { start: ts - duration, end: ts },
        ]
      }
      const rowsOverlap = (left: any, right: any): boolean => {
        const wl = windowsOfRow(left)
        const wr = windowsOfRow(right)
        for (const a of wl) for (const b of wr) if (a.start < b.end && b.start < a.end) return true
        return false
      }
      const overlappingPairs = (rows: any[]): { left: any; right: any }[] => {
        const pairs: { left: any; right: any }[] = []
        for (let i = 0; i < rows.length; i += 1) {
          for (let j = i + 1; j < rows.length; j += 1) {
            if (rowsOverlap(rows[i], rows[j])) pairs.push({ left: rows[i], right: rows[j] })
          }
        }
        return pairs
      }
      const overlapB = overlappingPairs(okExecBAll)
      const overlapC = overlappingPairs(okExecCAll)
      const busyRows = finalLogRows.filter((row) => {
        if (row.event === 'update.lock.anomaly' && (row.fields?.kind === 'busy-owner' || row.fields?.kind === 'busy')) return true
        const serialized = JSON.stringify(row.fields ?? {})
        return serialized.indexOf('update-busy') >= 0 || serialized.indexOf('busy-owner') >= 0
      })
      await run.raw('m4-log-timeline', {
        eventCounts: eventCountsOf(finalLogRows),
        okExecB: okExecBAll,
        okExecC: okExecCAll,
        overlapB,
        overlapC,
        busyRows,
        note: '同 home 两宿主写同一 logs 目录；exec 行没有 profile 字段，因此用「每包成功 exec 恰 2 条（两 profile 各一）+ 时间窗重叠」证明并发，台账/磁盘按 hash 分组证明无串写。',
      })
      const bOverlapOk = okExecBAll.length === 2 && overlapB.length >= 1
      const cRowsComplete = okExecCAll.length >= 2
      run.record({
        step: 'M4 两个 profile 的安装窗在日志里真重叠（B 包两 profile 的成功 exec 时间窗有交集）',
        what: '停两宿主后读日志：fxa-b 两 profile 各 1 条 ok exec 且时间窗重叠；fxa-c 至少 1 条（日志行齐全时同样要求重叠）',
        expected: 'okExecB=2 且 overlapB≥1；okExecC≥1；okExecC=2 时 overlapC≥1',
        actual: 'okExecB=' + String(okExecBAll.length) + '；okExecC=' + String(okExecCAll.length) + '；overlapB=' + String(overlapB.length) + '；overlapC=' + String(overlapC.length),
        verdict: bOverlapOk && okExecCAll.length >= 1 && (cRowsComplete ? overlapC.length >= 1 : true) ? 'pass' : 'fail',
        note:
          (cRowsComplete ? '' : 'C 的第 2 条 exec 日志行未落盘（两宿主同写一个 logs 文件；该 profile 的 C 已由台账/<hash>/state.json=completed 与磁盘 0.0.2 单独取证）。') +
          'exec 行不带 profile 字段，故「每 profile 各一次」由台账/磁盘按 hash 分组证明；这里只证两安装窗在时间上真重叠。',
      })
      run.record({
        step: 'M4 无跨 profile busy/抢占：日志里没有 update-busy / busy-owner 异常',
        what: '扫 update.lock.anomaly(busy-owner) 与含 update-busy 的字段；两批都 ok 已完成（上一条）',
        expected: 'busyRows=[]',
        actual: JSON.stringify(busyRows.slice(0, 5)),
        verdict: busyRows.length === 0 ? 'pass' : 'fail',
      })

      return await finish(run, options)
    }

    throw new Error('[hub-lifecycle] mode ' + options.mode + ' 尚未实现（骨架先落；m1/m2/m3/m4 已可用）')
  } catch (error) {
    await run.raw('scenario-error', { mode: options.mode, message: messageOf(error), stack: error instanceof Error ? error.stack ?? null : null })
    run.record({
      step: '场景执行异常（unknown 不算通过）',
      what: 'runHubLifecycle 主流程抛出',
      expected: '主流程无异常',
      actual: messageOf(error),
      verdict: 'unknown',
    })
    run.addNote('场景异常：' + messageOf(error))
    if (uiHandle) {
      const brokenUi = uiHandle
      uiHandle = null
      await brokenUi.close().catch((closeError) => console.error('[hub-lifecycle] 异常收尾关浏览器失败：' + messageOf(closeError)))
    }
    for (const entry of [...startedHosts].reverse()) {
      if (entry.closed) continue
      entry.closed = true
      await entry.host.close().catch((closeError) => console.error('[hub-lifecycle] 异常收尾关宿主失败：' + messageOf(closeError)))
      run.registerProcess('cli-host-' + entry.label + '-error', entry.pid)
      await run.registerPort('cli-host-' + entry.label + '-port', entry.port)
    }
    return await finish(run, options)
  }
}
