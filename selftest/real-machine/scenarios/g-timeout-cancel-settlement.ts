/**
 * selftest/real-machine/scenarios/g-timeout-cancel-settlement.ts —— T4（#268）组 D：超时、取消与已了结的失败。
 *
 * 六个 mode 对应五条声明（g1..g5，retry-can-red 复用 g4 声明）：
 *   - timeout              g1 官方桌面出口二慢安装超时（延迟代理 + installTimeoutMs 12s）
 *   - queued-cancel        g2 批量面板「取消排队」（前一个慢安装占住执行锁，第二个进 waiting，真 UI 撤销）
 *   - failed-no-retry      g3 移除步成功/重装步失败的已失败落定（删 tarball 保元数据）＋静置≥15s 无自动重试
 *   - retry-single-success g4 失败后恢复 registry，真 UI 重点「重试」成功，台账只留一条成功终态
 *   - retry-can-red        g4 的 can-red：变体版本号新、内容旧，重启后 buildTag 仍旧版 ⇒ 成功诚实性断言真红
 *   - no-cancel-probe      g5 官方宿主 cancelInstall 能力原始探测 + 库内无能力诚实文案测试（真机不可造部分 known-red）
 *
 * 纪律：
 *   - actual 只来自真机观测（DOM / state.json / 日志 / registry 回包 / 二进制度量），不编；
 *   - desktop-manager 装/卸插件会 relaunch 宿主、旧 CDP 句柄失效 ⇒ 安装窗口只轮询磁盘，停完宿主再读日志；
 *   - 观察者恒为 A（批量集成方，本组不被更新），被更新的目标是 B（失败/超时）或 C（排队取消）；
 *   - 重启后如实展示 = 停掉自重启实例、起托管实例、等 A 面板恢复后读 DOM + 台账。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunManifest } from '../runtime/evidence.ts'
import { capturePluginManagerOperations } from '../runtime/evidence.ts'
import type { DesktopSession } from '../host/desktop-app.ts'
import { launchDesktopApp, stopDesktopByPort, stopDesktopByUserDataDir } from '../host/desktop-app.ts'
import { waitForProfileDir } from '../host/isolated-profile.ts'
import type { LogEventRecord } from '../runtime/log-evidence.ts'
import { captureLogFiles, eventsOf } from '../runtime/log-evidence.ts'
import type { FixtureSlotKey, FixtureVariantEffect } from '../../fixtures/identity/fixture-slots.ts'
import { FIXTURE_BASE_VERSION, FIXTURE_VARIANT_VERSION, fixtureBridgeRouteOf, fixtureSlotOf } from '../../fixtures/identity/fixture-slots.ts'
import { batchEffectOf, targetEffectOf } from '../../fixtures/identity/scenario-declarations.ts'
import type { DelayingRegistryProxy } from '../../fixtures/release/delaying-registry-proxy.ts'
import { startDelayingRegistryProxy } from '../../fixtures/release/delaying-registry-proxy.ts'
import type { PublishedFixture } from '../../fixtures/release/fixture-publisher.ts'
import type { TarballFault } from '../runtime/registry-faults.ts'
import { removePublishedTarball, restorePublishedTarball, warmRegistryTarball } from '../runtime/registry-faults.ts'
import { directoryExists, listFilesRecursive, sha256File } from '../../tooling/fs-utils.ts'
import { runCommand, sleep } from '../../tooling/process.ts'
import { captureShot } from './a-single-package-main-chain.ts'
import type { BatchSeatState, BatchRowState, DiskSnapshot } from './batch-helpers.ts'
import { cardSelectorOf, clickSeatAction, copyRunEvidence, readBatchDiskFacts, readBatchSeat, readDiskSnapshot, readTargetSeat, rowOf, waitForBatchSeat } from './batch-helpers.ts'
import type { T3Run } from './t3-common.ts'
import { openT3Run, verifySutInstalled } from './t3-common.ts'

/** 组 D 的运行模式。 */
export type SettlementMode = 'timeout' | 'queued-cancel' | 'failed-no-retry' | 'retry-single-success' | 'retry-can-red' | 'no-cancel-probe'

/** 组 D 场景入参（与 T3 出口场景同形，mode 决定走哪一格）。 */
export interface SettlementScenarioOptions {
  readonly worktree: string
  readonly runBaseDir: string
  readonly verdaccioInstallDir: string
  readonly esbuildPath: string
  readonly stamp?: string
  readonly maintainerHome?: string
  readonly mode: SettlementMode
}

/** mode → 场景声明 id（retry-can-red 复用 g4 声明，用 run note 标记注入）。 */
const MODE_SCENARIO: Record<SettlementMode, string> = {
  timeout: 'g1-desktop-manager-install-timeout',
  'queued-cancel': 'g2-batch-queued-cancel',
  'failed-no-retry': 'g3-desktop-manager-failed-no-retry',
  'retry-single-success': 'g4-desktop-manager-retry-single-success',
  'retry-can-red': 'g4-desktop-manager-retry-single-success',
  'no-cancel-probe': 'g5-desktop-manager-no-cancel-probe',
}

const PROFILE_NAME = 'desktop'
/** 产品安装预算（经夹具 config 透传到 recipe.timeoutMs；T3 e3 已真机验证同链路）。 */
const INSTALL_TIMEOUT_MS = 12000
/**
 * 取消格占锁方的安装预算（40s）：排队窗要横跨「占锁 → A 面板宏安装 → 行渲染排队 → 行取消 → 丢弃本批
 * → 丢弃后 4s 队列多采样」多步真机交互；12s 太紧（实测 D2 首版在 12s 窗内排不上队），25s 也贴着
 * 占锁方收局边缘（收局会释放 owner 让采样断言失真）。延迟代理仍挂 60s，必然超时。
 */
const QUEUE_OCCUPIER_TIMEOUT_MS = 40000
/** 延迟代理只拦 pnpm 请求、挂 60s，保证慢安装一定超过 12s 预算。 */
const PROXY_DELAY_MS = 60000
/** 失败落定后静置多久再断言「没有自动重试」。 */
const FAILURE_IDLE_MS = 15000
const TARGET_VERSION = FIXTURE_VARIANT_VERSION
const BASE_VERSION = FIXTURE_BASE_VERSION
const SUCCESS_STATES: readonly string[] = ['completed', 'restart-required']

/** 一条台账 state.json 的原始事实。 */
interface LedgerEntry {
  readonly file: string
  readonly state: Record<string, unknown>
}

/** 组队列文件的形状摘要。 */
interface QueueFacts {
  readonly present: boolean
  readonly owner: Record<string, unknown> | null
  readonly waiting: readonly Record<string, unknown>[]
  readonly raw: unknown
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function jsonText(value: unknown, limit = 1800): string {
  let text = ''
  try {
    text = JSON.stringify(value)
  } catch {
    text = String(value)
  }
  return text.length > limit ? text.slice(0, limit) + '…' : text
}

/** 夹具桥打单插件电话的回包（桥 = 集成方 host half 的 POST 前缀路由）。 */
interface BridgePhoneOutcome {
  readonly route: string
  readonly ok: boolean
  readonly error: string | null
  /** 电话处理函数的返回值（成功时形如 {ok:true,snapshot,receipt,...}）。 */
  readonly reply: Record<string, unknown>
}

/**
 * 从页面同源打夹具 host half 登记的单插件电话（与夹具 client half 的 call() 同一路由/同一信封）。
 * 用途：在真机里直接启动「另一目标」的单插件安装（不经过批量面板/产品中枢），
 * 从而让全局执行锁被占住、给批量面板造出真实的排队窗——这是产品支持的唯一排队来源
 * （src/host/factory.ts:520-546 公平门；面板对面板的批量安装被中枢按 profile scope 串行，见 ADR-0008）。
 * 回包信封 {ok:true, reply}；失败回包 {ok:false, error}。
 */
async function callBridgePhone(
  session: DesktopSession,
  slotKey: FixtureSlotKey,
  phone: string,
  args: Record<string, unknown> = {},
): Promise<BridgePhoneOutcome> {
  const route = fixtureBridgeRouteOf(fixtureSlotOf(slotKey))
  const body = JSON.stringify({ phone, args })
  const expression =
    'fetch(' + JSON.stringify(route) + ',{method:"POST",headers:{"content-type":"application/json"},body:' + JSON.stringify(body) + '})' +
    '.then(async (r)=>({status:r.status,body:await r.json().catch(()=>null)}))'
  const raw = await session.cdp.evaluate<{ status: number; body: unknown }>(expression)
  const envelope = recordOf(raw.body)
  const ok = envelope !== null && envelope['ok'] === true
  const reply = ok && recordOf(envelope['reply']) !== null ? (recordOf(envelope['reply']) as Record<string, unknown>) : {}
  return {
    route,
    ok,
    error: ok ? null : textOf(envelope ? envelope['error'] : null) ?? 'bridge-http-' + String(raw.status),
    reply,
  }
}

/** 从人话格里抠出唯一那条可执行命令（与 T3 d 失败格同一口径）。 */
function executableCommandOf(text: string): string | null {
  const matched = /\((dsh plugin [^)]+)\)/.exec(text)
  return matched ? matched[1] ?? null : null
}

/** 递归读 <home>/updates 下全部 state.json（与 T3 d 场景同口径，失败记 corrupt）。 */
async function readLedgerStates(homeDir: string): Promise<LedgerEntry[]> {
  const root = join(homeDir, 'updates')
  if (!(await directoryExists(root))) return []
  const entries: LedgerEntry[] = []
  for (const relative of await listFilesRecursive(root)) {
    const segments = relative.split('/')
    if (segments[segments.length - 1] !== 'state.json') continue
    const file = join(root, relative.split('/').join('\\'))
    const content = await readFile(file, 'utf8').catch(() => '')
    let state: Record<string, unknown> = { corrupt: true, raw: content.slice(0, 400) }
    try {
      const parsed = JSON.parse(content) as unknown
      const asRecord = recordOf(parsed)
      if (asRecord) state = asRecord
    } catch {
      // 保持 corrupt 事实
    }
    entries.push({ file, state })
  }
  entries.sort((left, right) => left.file.localeCompare(right.file))
  return entries
}

/** 按插件标识过滤台账（路径段精确匹配，避免 fxa-b 命中 fxa-bb）。 */
function ledgerOf(entries: readonly LedgerEntry[], pluginId: string): LedgerEntry[] {
  const marker = '\\' + pluginId + '\\'
  return entries.filter((entry) => entry.file.indexOf(marker) >= 0)
}

function ledgerStateOf(entry: LedgerEntry): string {
  return textOf(entry.state['state']) ?? 'missing'
}

/** 从批量行的失败说明里取产品失败码（形如「失败 install-failed：…」「失败 recovery-required：…」）。 */
function ledgerCodeOf(text: string): string | null {
  const match = /失败\s+([a-z][a-z0-9-]*)/.exec(text)
  return match !== null ? match[1]! : null
}

function ledgerMessageOf(entries: readonly LedgerEntry[]): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = textOf(entries[index]!.state['message'])
    if (message) return message
  }
  return ''
}

/** 按命名空间（= 目标插件标识）过滤日志事件。 */
function namespaceEvents(events: readonly LogEventRecord[], pluginId: string, name: string): LogEventRecord[] {
  return eventsOf(events, name).filter((row) => row.source.startsWith(pluginId + '/'))
}

function fieldText(row: LogEventRecord | null, key: string): string | null {
  if (!row) return null
  return textOf(row.fields[key])
}

function fieldNumber(row: LogEventRecord | null, key: string): number | null {
  if (!row) return null
  return numberOrNull(row.fields[key])
}

function fieldBool(row: LogEventRecord | null, key: string): boolean | null {
  if (!row) return null
  const value = row.fields[key]
  return typeof value === 'boolean' ? value : null
}

/** 队列快照（owner / waiting 全部给原文）。 */
function queueFactsOf(queue: unknown): QueueFacts {
  const record = recordOf(queue)
  if (!record) return { present: false, owner: null, waiting: [], raw: queue }
  const owner = recordOf(record['owner'])
  const waiting = Array.isArray(record['waiting']) ? record['waiting'].map((item) => recordOf(item)).filter((item): item is Record<string, unknown> => item !== null) : []
  return { present: true, owner, waiting, raw: queue }
}

/** 等台账达到期望状态（只读磁盘；返回观测到的状态序列）。 */
async function waitForLedgerState(options: {
  readonly homeDir: string
  readonly pluginId: string
  readonly wanted: readonly string[]
  readonly timeoutMs: number
  readonly label: string
  readonly intervalMs?: number
}): Promise<{ entry: LedgerEntry | null; observed: string[]; lastEntries: LedgerEntry[] }> {
  const observed: string[] = []
  const deadline = Date.now() + options.timeoutMs
  let lastEntries: LedgerEntry[] = []
  while (Date.now() < deadline) {
    lastEntries = ledgerOf(await readLedgerStates(options.homeDir), options.pluginId)
    const current = lastEntries.length > 0 ? lastEntries[lastEntries.length - 1]! : null
    const state = current ? ledgerStateOf(current) : 'missing'
    if (observed[observed.length - 1] !== state) observed.push(state)
    if (current && options.wanted.indexOf(state) >= 0) return { entry: current, observed, lastEntries }
    await sleep(options.intervalMs ?? 1000)
  }
  return { entry: null, observed, lastEntries }
}

/** 页面文本里有没有「正在安装」这类在飞宣称（重启后不许出现）。 */
function claimsInstallRunning(text: string): boolean {
  return text.indexOf('正在安装') >= 0
}

/** 读一行失败态（行不存在返回 null，不抛）。 */
function rowOrNull(seat: BatchSeatState | null, key: string): BatchRowState | null {
  return seat ? rowOf(seat, key) : null
}

/**
 * 重启后批量行的诚实口径（#152 既有产品语义，tests/issue-152-check-reconcile.test.mjs:38-66）：
 * 面板打开时的自动检查会把「昨日失败」按磁盘真相重算成可装行（包被管理器移除后即「未安装/可装 0.0.2」）。
 * 所以本格不要求行仍写 failed，只要求它不谎称在飞/成功/已是最新，也不宣称目标版已装；
 * 失败事实的权威在台账 state.json，由调用方一并断言。
 */
function rowHonestAfterRestart(row: BatchRowState | null, target: string): boolean {
  if (row === null) return false
  if (row.phase === 'installing' || row.phase === 'queued' || row.phase === 'done' || row.phase === 'current') return false
  const text = ((row.status || '') + ' ' + (row.fail || '')).trim()
  for (const lie of ['正在安装', '正在更新', '安装中', '更新中', '已是最新', '安装完成', '更新成功', '已完成']) {
    if (text.indexOf(lie) >= 0) return false
  }
  if (row.versionCur === target) return false
  if (row.phase === 'failed') return (row.fail || '').indexOf('install-failed') >= 0
  if (row.phase === 'ready') return row.versionNew === null || row.versionNew === target
  return row.phase === 'pending'
}

/** 字符串 → 单字节序列（asar 探测只找 ASCII 符号；不用 Buffer 类型以免门禁 tsconfig 无 node 类型）。 */
function bytesOf(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let index = 0; index < text.length; index += 1) out[index] = text.charCodeAt(index) & 0xff
  return out
}

/** 二进制片段 → 可读 ASCII（非可打印字节替换成「.」），用于 raw 里留二进制证据。 */
function asciiOf(bytes: Uint8Array): string {
  let text = ''
  for (const byte of bytes) text += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.'
  return text
}

/** 在字节序列里找子序列（Uint8Array.indexOf 只接受单字节，故自己扫）。 */
function indexOfBytes(buffer: Uint8Array, needle: Uint8Array, from = 0): number {
  if (needle.length === 0) return from
  const last = buffer.length - needle.length
  for (let index = Math.max(0, from); index <= last; index += 1) {
    let matched = true
    for (let inner = 0; inner < needle.length; inner += 1) {
      if (buffer[index + inner] !== needle[inner]) {
        matched = false
        break
      }
    }
    if (matched) return index
  }
  return -1
}

/** 宿主 asar 能力探测（普通 node 把 .asar 当普通二进制读；Electron 的 asar 补丁不在此进程）。 */
function countOccurrences(buffer: Uint8Array, token: Uint8Array): number {
  let count = 0
  let offset = indexOfBytes(buffer, token)
  while (offset >= 0) {
    count += 1
    offset = indexOfBytes(buffer, token, offset + token.length)
  }
  return count
}

export async function runSettlementScenario(options: SettlementScenarioOptions): Promise<RunManifest> {
  const scenarioId = MODE_SCENARIO[options.mode]
  const canRed = options.mode === 'retry-can-red'
  const run = await openT3Run({
    worktree: options.worktree,
    runBaseDir: options.runBaseDir,
    verdaccioInstallDir: options.verdaccioInstallDir,
    esbuildPath: options.esbuildPath,
    scenarioId,
    hostChannel: 'desktop-official',
    stamp: options.stamp,
    maintainerHome: options.maintainerHome,
    ticket: '268',
  })

  const fixtureEnv = run.fixtureEnv
  if (!fixtureEnv) {
    await run.raw('scenario-error', { message: '组 D 场景必须带夹具环境' })
    run.record({ step: '场景前提', what: '夹具环境可用', expected: 'openT3Run 返回 fixtureEnv', actual: 'null', verdict: 'unknown' })
    return await run.close()
  }

  // can-red 的 stale 内容（版本号 0.0.2、内容用 0.0.1 构建）跨 run 字节完全相同；不隔离 store 时，
  // 上一次 can-red 成功重试会把这份 tarball 写进全局 store，下一次「删 tarball」注入就会命中缓存、D3 装成功，
  // 红点落不到 D4 的诚实性断言上（268-20261102T144222 实测漏红）。
  // 隔离必须从最开始的 bootstrap/CLI 基版安装就生效：profile 的 node_modules 若由全局 store 链接，
  // 管理器再用私有 store 装包会 ERR_PNPM_UNEXPECTED_STORE（268-20261102T145812 实测）。
  const originalPnpmStoreDir = process.env['pnpm_config_store_dir']
  if (canRed) process.env['pnpm_config_store_dir'] = join(run.layout.root, 'pnpm-store')

  const homeDir = run.layout.homeDir
  const userDataDir = run.layout.userDataDir
  const registryUrl = fixtureEnv.registry.baseUrl
  const slotA = fixtureSlotOf('a')
  const slotB = fixtureSlotOf('b')
  const slotC = fixtureSlotOf('c')
  const packageA = slotA.packageName
  const packageB = slotB.packageName
  const packageC = slotC.packageName
  // 台账/队列里的 pluginId 是「更新方宿主里的目标电话前缀」（A 的批量目标 fxa-b/fxa-c），不是被更新包的包名。
  const targetPrefixOf = (key: FixtureSlotKey): string => {
    const target = slotA.batch ? slotA.batch.targets.find((candidate) => candidate.key === key) : null
    if (!target) throw new Error('A 的批量目标里没有 ' + key)
    return target.prefix
  }
  const pluginB = targetPrefixOf('b')
  const pluginC = targetPrefixOf('c')
  const packageNames = [packageA, packageB, packageC]
  const fullTags = { clientB: 'client v' + TARGET_VERSION, hostB: 'host v' + TARGET_VERSION }

  let session: DesktopSession | null = null
  let proxy: DelayingRegistryProxy | null = null
  const notes: string[] = []
  const note = (text: string): void => {
    notes.push(text)
    run.addNote(text)
  }
  const requireSession = (): DesktopSession => {
    if (!session) throw new Error('桌面会话不存在（此步需要真 UI 观测）')
    return session
  }

  /** 停止当前桌面：先关 CDP 会话，再按端口清自重启实例、按 user-data-dir 兜底。 */
  const stopDesktop = async (tag: string): Promise<number[]> => {
    const current = session
    session = null
    const killed: number[] = []
    if (!current) return killed
    const port = current.port
    try {
      await current.close()
    } catch (error) {
      note('关闭桌面会话失败（' + tag + '）：' + messageOf(error))
    }
    try {
      const relaunched = await stopDesktopByPort(port)
      for (const pid of relaunched) killed.push(pid)
    } catch (error) {
      note('按端口清理桌面实例失败（' + tag + '）：' + messageOf(error))
    }
    try {
      const byUserData = await stopDesktopByUserDataDir(userDataDir)
      for (const pid of byUserData) killed.push(pid)
    } catch (error) {
      note('按 user-data-dir 清理桌面实例失败（' + tag + '）：' + messageOf(error))
    }
    for (const pid of killed) run.registerProcess('desktop-relaunched-' + tag, pid)
    await run.raw('desktop-stop-' + tag, { port, killedPids: killed, userDataDir })
    return killed
  }

  /** 慢安装预算：超时格 12s；取消格 25s（要给「占锁 → 宏安装 → 排队渲染 → 真 UI 取消」留出真实交互窗）。 */
  const slowInstallTimeoutMs = options.mode === 'queued-cancel' ? QUEUE_OCCUPIER_TIMEOUT_MS : INSTALL_TIMEOUT_MS
  const launchExtraEnv: Record<string, string> = {}
  if (options.mode === 'timeout' || options.mode === 'queued-cancel') {
    proxy = await startDelayingRegistryProxy({ upstreamBaseUrl: registryUrl, delayMs: PROXY_DELAY_MS })
    launchExtraEnv['DSH_SELFTEST_REGISTRY'] = proxy.baseUrl
    launchExtraEnv['DSH_SELFTEST_INSTALL_TIMEOUT_MS'] = String(slowInstallTimeoutMs)
    await run.raw('delaying-proxy', {
      upstreamBaseUrl: registryUrl,
      baseUrl: proxy.baseUrl,
      port: proxy.port,
      delayMs: PROXY_DELAY_MS,
      installTimeoutMs: slowInstallTimeoutMs,
    })
    run.record({
      step: '慢安装地基',
      what: '延迟代理把 pnpm 请求挂 60s，产品安装预算 ' + String(slowInstallTimeoutMs / 1000) + 's（经夹具 config.installTimeoutMs 透传）',
      expected: '代理监听并只延迟 pnpm 请求（产品自己的 check 不延迟）',
      actual: 'proxy ' + proxy.baseUrl + '，delayMs=' + String(PROXY_DELAY_MS) + '，installTimeoutMs=' + String(slowInstallTimeoutMs),
      verdict: 'pass',
    })
  } else {
    launchExtraEnv['DSH_SELFTEST_REGISTRY'] = registryUrl
  }
  if (canRed) {
    const storeDir = process.env['pnpm_config_store_dir']
    await run.raw('pnpm-store-isolation', {
      storeDir: storeDir,
      inheritedFromBeforeBootstrap: storeDir === join(run.layout.root, 'pnpm-store'),
      reason: 'can-red stale 内容跨 run 同字节；私有 store 防缓存命中让删 tarball 注入失效（须覆盖 CLI 基版安装，防 ERR_PNPM_UNEXPECTED_STORE）',
    })
    note('can-red：pnpm_config_store_dir 隔离到 run 私有目录 ' + String(storeDir) + '（从 bootstrap/CLI 基版安装起生效，防全局 store 缓存让删 tarball 注入失效）')
  }

  /** 停延迟代理并在 run.close 之前登记端口（registerPort 必须在 close 之前调用）。 */
  const stopProxy = async (): Promise<void> => {
    const current = proxy
    if (!current) return
    proxy = null
    try {
      await current.stop()
      await run.registerPort('delaying-registry-proxy', current.port)
    } catch (error) {
      note('停延迟代理失败：' + messageOf(error))
    }
  }

  /** 起一个托管官方桌面实例（自重启清场 + 最多 3 次重试；每次终止过程登记 pid）。 */
  const launchDesktop = async (tag: string): Promise<DesktopSession> => {
    let lastError: unknown = null
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const opened = await launchDesktopApp({ homeDir, userDataDir, extraEnv: launchExtraEnv })
        session = opened
        const pid = opened.process.pid()
        if (typeof pid === 'number') run.registerProcess('desktop-' + tag + (attempt > 1 ? '-attempt' + String(attempt) : ''), pid)
        return opened
      } catch (error) {
        lastError = error
        await sleep(2000)
      }
    }
    throw lastError instanceof Error ? lastError : new Error('起桌面失败：' + messageOf(lastError))
  }

  const pause = async (tag: string, meta: { step: string; what: string; expected: string; actual: string; verdict: 'pass' | 'fail' | 'known-red' | 'unknown'; note?: string }): Promise<void> => {
    if (!session) return
    try {
      await captureShot(run.recorder, session, meta)
    } catch (error) {
      note('截图失败（' + tag + '）：' + messageOf(error))
    }
  }

  /** 日志 raw 截断要在 run.json 留下「原始多大、截断到多少」，评审可回原始文件核对。 */
  const noteLogTruncations = (tag: string, capture: { truncations: readonly { source: string; bytes: number; characters: number; keptCharacters: number; tailFile: string }[] }): void => {
    for (const truncated of capture.truncations) {
      note(tag + ' raw 日志截断：' + truncated.source + ' 原始 ' + String(truncated.bytes) + ' 字节 / ' + String(truncated.characters) + ' 字符，保留前 ' + String(truncated.keptCharacters) + ' 字符；尾段见 ' + truncated.tailFile)
    }
  }

  const readDisk = async (): Promise<DiskSnapshot> => readDiskSnapshot({ homeDir, profileName: PROFILE_NAME, packageNames })

  /** 等 A 面板恢复（三行 + 卡片在位）；自重启实例会换 CDP 端口，故每次停/起后重等。 */
  const waitPanel = async (tag: string, timeoutMs = 180000): Promise<BatchSeatState> => {
    const live = requireSession()
    const seat = await waitForBatchSeat(live, 'a', (state) => state.card.present && state.panel.present && state.panel.rows.length >= 3, {
      label: 'A 批量面板恢复（' + tag + '）',
      timeoutMs,
      intervalMs: 1000,
    })
    await run.raw('batch-panel-' + tag, seat)
    return seat
  }

  /** 安装窗口里只允许读磁盘；页面可能被宿主 relaunch 换掉。 */
  const waitDiskVersion = async (packageName: string, wanted: string, timeoutMs: number): Promise<string | null> => {
    const deadline = Date.now() + timeoutMs
    let last: string | null = null
    while (Date.now() < deadline) {
      const disk = await readDisk()
      last = disk.versions[packageName] ?? null
      if (last === wanted) return last
      await sleep(1500)
    }
    return last
  }

  /** 安装成功落盘后，等台账自己走到终态（background verify 完成）。
   * 不等就停宿主：state 还在 installing、activeJobId 未清，重启 healJob 会把它愈合为
   * interrupted/recovery-required（268-20261102T150837 实测），D4 的「恰一条成功终态」会假红。 */
  const waitLedgerTerminal = async (pluginId: string, timeoutMs: number): Promise<LedgerEntry[]> => {
    const deadline = Date.now() + timeoutMs
    let last: LedgerEntry[] = []
    while (Date.now() < deadline) {
      last = ledgerOf(await readLedgerStates(homeDir), pluginId)
      if (last.length === 1 && SUCCESS_STATES.indexOf(ledgerStateOf(last[0]!)) >= 0) return last
      await sleep(1000)
    }
    return last
  }

  try {
    // ---- 地基：首启建 profile → 装基版 → 起托管实例 → A 批量面板 ----
    session = await launchDesktop('bootstrap')
    await waitForProfileDir({ homeDir, profileName: PROFILE_NAME, timeoutMs: 120000 })
    await requireSession().cdp.waitForExpression('document.body && document.body.innerText.length > 100', {
      timeoutMs: 120000,
      label: '官方桌面首启界面出现',
    })
    await run.raw('desktop-first-launch', {
      port: requireSession().port,
      pageText: (await requireSession().cdp.pageText()).slice(0, 3000),
    })
    await stopDesktop('bootstrap')

    await run.installBaseline({ homeDir, profileName: PROFILE_NAME, registryUrl })
    await verifySutInstalled(run, { homeDir, profileName: PROFILE_NAME, packageName: packageA })

    session = await launchDesktop('main')
    const initialSeat = await waitPanel('initial')
    const initialDisk = await readDisk()
    const initialC = await readTargetSeat(requireSession(), 'c').catch(() => null)
    const initialRows = initialSeat.panel.rows.map((row) => row.key).join(',')
    run.record({
      step: '基版 UI',
      what: 'A 批量面板列出 a/b/c 三行，B/C 卡片是 0.0.1',
      expected: 'rows=a,b,c；B clientTag=client v0.0.1；C 徽标 0.0.1',
      actual: jsonText({
        rows: initialRows,
        cardB: initialSeat.card.clientTag,
        cardC: initialC ? { present: initialC.present, clientTag: initialC.clientTag, badge: initialC.badgeText } : null,
        disk: { versions: initialDisk.versions, dependencies: initialDisk.dependencies },
      }),
      verdict: initialSeat.panel.rows.length >= 3 && initialSeat.card.clientTag === 'client v' + BASE_VERSION && (initialC === null || initialC.clientTag === 'client v' + BASE_VERSION) ? 'pass' : 'fail',
    })
    await pause('initial', {
      step: '基版 UI',
      what: 'A 批量面板与 B/C 卡片的初始形态',
      expected: '三行；B/C 0.0.1；面板可见',
      actual: 'rows=' + initialRows + '；B=' + String(initialSeat.card.clientTag) + '；C=' + String(initialC ? initialC.clientTag : null),
      verdict: initialSeat.panel.rows.length >= 3 ? 'pass' : 'fail',
    })

    if (options.mode === 'no-cancel-probe') {
      // ---- D5：官方宿主 cancelInstall 能力原始探测 + 库内诚实文案测试 ----
      const pageText = await requireSession().cdp.pageText()
      await run.raw('probe-page-text', { pageText: pageText.slice(0, 5000), port: requireSession().port })
      run.record({
        step: 'D5 真机宿主',
        what: '官方桌面真实启动并加载夹具页面（证明探测发生在真宿主上下文）',
        expected: '页面文本非空且含夹具卡片',
        actual: 'pageText 长度 ' + String(pageText.length) + '；含 fixture 卡片=' + String(pageText.indexOf('夹具') >= 0),
        verdict: pageText.length > 100 ? 'pass' : 'fail',
      })
      await pause('probe-host', {
        step: 'D5 真机宿主',
        what: '官方桌面真实启动（能力探测的宿主上下文）',
        expected: '窗口里有夹具卡片',
        actual: 'pageText 长度 ' + String(pageText.length),
        verdict: pageText.length > 100 ? 'pass' : 'fail',
      })
      await stopDesktop('probe')

      const asarPath = process.env['DSH_SELFTEST_DESKTOP_ASAR'] || 'D:/DeepseekHarness/resources/app.asar'
      let asarBytes = 0
      const counts: Record<string, number> = {}
      let fragments: Record<string, string> = {}
      try {
        const buffer = await readFile(asarPath)
        asarBytes = buffer.length
        const tokens = ['pluginManager', 'installBundle', 'cancelInstall', 'setBundleEnabled']
        const positions: Record<string, number> = {}
        for (const token of tokens) {
          const needle = bytesOf(token)
          counts[token] = countOccurrences(buffer, needle)
          positions[token] = indexOfBytes(buffer, needle)
        }
        const decorator = (position: number): string => (position >= 0 ? asciiOf(buffer.subarray(Math.max(0, position - 120), Math.min(buffer.length, position + 180))) : '')
        fragments = {
          cancelInstall: decorator(positions['cancelInstall'] ?? -1),
          pluginManager: decorator(positions['pluginManager'] ?? -1),
        }
        const versionPos = indexOfBytes(buffer, bytesOf('@deepseek-ai/dsh-plugin-manager'))
        if (versionPos >= 0) fragments['pluginManagerVersion'] = asciiOf(buffer.subarray(versionPos, Math.min(buffer.length, versionPos + 120)))
      } catch (error) {
        note('读宿主 asar 失败：' + messageOf(error))
      }
      await run.raw('host-asar-probe', { asarPath, asarBytes, counts, fragments })
      run.record({
        step: 'D5 能力探测',
        what: '官方宿主 asar 里有插件管理器符号（i.e. 探测对象是真实宿主二进制，不是推断）',
        expected: 'pluginManager>0 且 installBundle>0',
        actual: jsonText({ asarPath, asarBytes, counts }),
        verdict: asarBytes > 0 && (counts['pluginManager'] ?? 0) > 0 && (counts['installBundle'] ?? 0) > 0 ? 'pass' : 'fail',
      })
      run.record({
        step: 'D5 能力探测',
        what: '官方宿主是否提供 cancelInstall（决定超时人话格该走「已请求宿主取消」还是「宿主未提供取消能力」）',
        expected: '命中数>0 ⇒ 宿主有取消能力',
        actual: 'cancelInstall 命中 ' + String(counts['cancelInstall'] ?? 0) + ' 处；片段=' + jsonText(fragments['cancelInstall'] ?? ''),
        verdict: (counts['cancelInstall'] ?? 0) > 0 ? 'pass' : 'fail',
      })
      const l0 = runCommand(process.execPath, ['--test', 'tests/issue-184-timeout-honesty.test.mjs'], { cwd: options.worktree, timeoutMs: 180000 })
      await run.raw('l0-no-cancel-honesty', {
        command: l0.command,
        args: l0.args,
        exitCode: l0.exitCode,
        durationMs: l0.durationMs,
        stdout: l0.stdout.slice(-6000),
        stderr: l0.stderr.slice(-4000),
      })
      run.record({
        step: 'D5 库内诚实文案',
        what: '产品在宿主无 cancelInstall 时的超时文案（L0 定向测试：detail 含「未提供取消能力/可能仍在后台继续」且不含「已请求宿主取消」）',
        expected: 'node --test tests/issue-184-timeout-honesty.test.mjs 退出码 0',
        actual: 'exitCode=' + String(l0.exitCode) + '；stdout 尾部=' + l0.stdout.slice(-800),
        verdict: l0.exitCode === 0 && l0.stdout.indexOf('未提供取消能力') >= 0 ? 'pass' : 'fail',
      })
      run.record({
        step: 'D5 真机无能力宿主',
        what: '真机造出一个「宿主没有 cancelInstall」的官方桌面实例来跑无能力超时格（票面要求的真机形态）',
        expected: '官方桌面宿主没有 cancelInstall 能力',
        actual: '官方宿主 ' + asarPath + ' 命中 cancelInstall ' + String(counts['cancelInstall'] ?? 0) + ' 处（@deepseek-ai/dsh-plugin-manager 0.2.1-rc.5）、installBundle ' + String(counts['installBundle'] ?? 0) + ' 处 ⇒ 本机无法造出无能力宿主',
        verdict: 'known-red',
        note: '复现条件：换一个没有 cancelInstall 的官方宿主版本（旧版 plugin-manager）或第三方 Desktop 宿主；本机官方 0.2.1-rc.5 有该能力，真机无能力格不可达。库内 L0 测试（tests/issue-184-timeout-honesty.test.mjs）已钉住无能力时的诚实措辞，能力探测原始二进制度量在 raw/host-asar-probe。',
      })
      note('D5 结论：官方桌面 0.2.1-rc.5 有 cancelInstall；无能力真机格 known-red（条件已写清），库内诚实文案测试绿。')
      return await finish(run, options)
    }

    // ---- 发布变体版（都带本 run 独有标记，保证 pnpm store 必 miss） ----
    // 超时/失败/重试三格只发布 B（A 面板宏按钮「全部更新」只装 B），C 保持 0.0.1 作「没被牵连」的对照；
    // 取消格只发布 C：同一批量会话内部串行、两套批量面板又被产品中枢按 profile scope 串行（ADR-0008），
    // 宏按钮本身造不出 waiting。真机做法是用 B 的夹具桥打单插件电话 fxb-c.updateInstall 起 C 的慢安装占住
    // 全局执行锁（owner=fxb-c），再在 A 面板点宏安装，轮到 C 时被公平门挡下（stage=gate/code=update-busy），
    // A 会话记 queued —— 那才是可取消的排队占位。
    const baseline = await run.publishBaseline()
    const publishesC = options.mode === 'queued-cancel'
    const bVariant = run.scenario.variants.find((variant) => variant.slotKey === 'b')
    const cVariant = run.scenario.variants.find((variant) => variant.slotKey === 'c')
    if (!publishesC && !bVariant) throw new Error('场景声明缺少 B 变体')
    if (publishesC && !cVariant) throw new Error('场景声明缺少 C 变体（取消格需要 C 变体）')
    const stamp = run.layout.stamp
    const injectedB: FixtureVariantEffect = {
      ...batchEffectOf(slotB, true),
      seatLine: 'T4 组 D 注入 ' + stamp,
      hostBehavior: 't4-settlement:' + stamp,
    }
    const publishB: PublishedFixture | null =
      !publishesC && bVariant !== undefined
        ? canRed
          ? await fixtureEnv.publish('b', bVariant.version, { effect: injectedB, staleContentVersion: BASE_VERSION })
          : await fixtureEnv.publish('b', bVariant.version, { effect: injectedB })
        : null
    // 取消格的 C 变体必须带 run 独有内容：否则跨 run 同字节会被 pnpm store 缓存命中、占锁安装秒完，
    // 排队窗根本不存在（can-red 四轮的实测教训，见 docs/research/20261101-issue-268-*.md）。
    const injectedC: FixtureVariantEffect =
      cVariant !== undefined ? { ...targetEffectOf(cVariant.version), titleSuffix: '（新版 · T4-' + stamp + '）' } : targetEffectOf(FIXTURE_VARIANT_VERSION)
    const publishC: PublishedFixture | null =
      publishesC && cVariant !== undefined
        ? await fixtureEnv.publish('c', cVariant.version, { effect: injectedC })
        : null
    const oldBuilt = baseline['b'].built
    const oldHashB = { client: await sha256File(join(oldBuilt.dir, 'lib', 'client.js')), host: await sha256File(join(oldBuilt.dir, 'lib', 'index.js')) }
    const newHashB = publishB !== null
      ? { client: await sha256File(join(publishB.built.dir, 'lib', 'client.js')), host: await sha256File(join(publishB.built.dir, 'lib', 'index.js')) }
      : null
    const oldC = publishC !== null ? baseline['c'].built : null
    const oldHashC = oldC !== null ? { client: await sha256File(join(oldC.dir, 'lib', 'client.js')), host: await sha256File(join(oldC.dir, 'lib', 'index.js')) } : null
    const newHashC = publishC !== null ? { client: await sha256File(join(publishC.built.dir, 'lib', 'client.js')), host: await sha256File(join(publishC.built.dir, 'lib', 'index.js')) } : null
    await run.raw('fixture-publications', {
      canRed,
      publishesC,
      variants: [
        { slotKey: 'b', version: bVariant !== undefined ? bVariant.version : null, published: publishB !== null, plan: publishB !== null ? publishB.plan : null, staleContentVersion: canRed ? BASE_VERSION : null, builtDir: publishB !== null ? publishB.built.dir : null, publish: publishB !== null ? { exitCode: publishB.publish.exitCode } : null },
        { slotKey: 'c', version: cVariant !== undefined ? cVariant.version : null, published: publishC !== null, plan: publishC !== null ? publishC.plan : null, builtDir: publishC !== null ? publishC.built.dir : null, publish: publishC !== null ? { exitCode: publishC.publish.exitCode } : null },
      ],
      hashes: { oldB: oldHashB, newB: newHashB, oldC: oldHashC, newC: newHashC },
    })
    // can-red 的「旧内容」由 host bundle 判定：fixture-publisher.ts:50 用旧版本重建内容计划时不带变体 effect，
    // client bundle 会退回默认单面板效果（与基线批量效果字节不同），运行期 buildTag 仍是 v0.0.1——
    // 这一条只做「注入确实让内容停在旧版」的前置判定，真正的红点在后面 68-assert（重启后 buildTag 必须 v0.0.2）。
    const bHashOk = canRed
      ? newHashB !== null && newHashB.host === oldHashB.host
      : publishesC
        ? true
        : newHashB !== null && newHashB.client !== oldHashB.client && newHashB.host !== oldHashB.host
    const cHashOk = publishC === null || oldHashC === null || newHashC === null ? true : newHashC.client !== oldHashC.client
    run.record({
      step: '变体发布',
      what: publishesC
        ? 'C 变体版内容确实换了（client bundle sha256 与基版不同；该格只发 C）'
        : canRed
          ? 'B 变体（can-red 判旧内容）内容停在本应换的那一版'
          : 'B 变体版内容确实换了（client/host bundle sha256 与基版不同）',
      expected: canRed ? 'can-red：版本号 0.0.2 但 host bundle 与基版相同（内容用 0.0.1 构建；运行期 buildTag 仍是 v0.0.1）' : publishesC ? 'C 的 client sha256 与基版不同；B 未发布 0.0.2' : 'B 的 client/host bundle sha256 均与 0.0.1 不同',
      actual: jsonText({ canRed, publishesC, oldHashB, newHashB, oldHashC, newHashC, canRedStaleHost: canRed && newHashB !== null ? newHashB.host === oldHashB.host : null }),
      verdict: bHashOk && cHashOk ? 'pass' : 'fail',
    })
    const metaB = await (await fetch(registryUrl + '/' + packageB)).json() as { versions?: Record<string, unknown> }
    const metaC = await (await fetch(registryUrl + '/' + packageC)).json() as { versions?: Record<string, unknown> }
    const metaBVersions = Object.keys(metaB.versions || {})
    const metaCVersions = Object.keys(metaC.versions || {})
    await run.raw('registry-metadata-variants', { b: metaBVersions, c: metaCVersions })
    run.record({
      step: '变体可见',
      what: publishesC ? 'C 的 0.0.2 已在 registry 可见，B 仍只有 0.0.1（A 面板宏安装只会轮到 C）' : 'B 的 0.0.2 已在 registry 可见，C 仍只有 0.0.1（A 面板宏安装只装 B）',
      expected: publishesC ? 'C 元数据含 0.0.1 与 0.0.2；B 元数据只有 0.0.1' : 'B 元数据含 0.0.1 与 0.0.2；C 元数据只有 0.0.1',
      actual: jsonText({ b: metaBVersions, c: metaCVersions }),
      verdict: publishesC
        ? metaCVersions.indexOf(BASE_VERSION) >= 0 && metaCVersions.indexOf(TARGET_VERSION) >= 0 && metaBVersions.indexOf(TARGET_VERSION) < 0
          ? 'pass'
          : 'fail'
        : metaBVersions.indexOf(BASE_VERSION) >= 0 && metaBVersions.indexOf(TARGET_VERSION) >= 0 && metaCVersions.indexOf(TARGET_VERSION) < 0
          ? 'pass'
          : 'fail',
    })

    // ---- 真 UI 检查更新：A 面板出现 0.0.2（取消格等 C；其余格等 B） ----
    await clickSeatAction(requireSession(), 'a', 'check')
    const checkKeys: FixtureSlotKey[] = publishesC ? ['c'] : ['b']
    const checked = await waitForBatchSeat(
      requireSession(),
      'a',
      (state) => checkKeys.every((key) => {
        const row = rowOf(state, key)
        return row !== null && row.versionNew === TARGET_VERSION
      }),
      { label: 'A 面板 ' + checkKeys.join('/') + ' 行知识版本到 0.0.2', timeoutMs: 180000, intervalMs: 1000 },
    )
    await run.raw('panel-after-check', checked)
    const checkedB = rowOf(checked, 'b')
    const checkedC = rowOf(checked, 'c')
    const checkOk = publishesC
      ? checkedC !== null && checkedC.versionNew === TARGET_VERSION && (checkedB === null || checkedB.versionNew !== TARGET_VERSION)
      : checkedB !== null && checkedB.versionNew === TARGET_VERSION && (checkedC === null || checkedC.versionNew !== TARGET_VERSION)
    run.record({
      step: '真 UI 检查更新',
      what: publishesC ? 'A 批量面板 C 行读到 0.0.2，B 仍是基版（宏按钮只会轮到 C 被排队门挡下）' : 'A 批量面板 B 行读到 0.0.2，C 仍是基版（宏按钮只会装 B）',
      expected: publishesC ? 'C 行 versionNew=0.0.2；B 行无 0.0.2' : 'B 行 versionNew=0.0.2；C 行无 0.0.2',
      actual: jsonText({ b: checkedB, c: checkedC }),
      verdict: checkOk ? 'pass' : 'fail',
    })
    await pause('after-check', {
      step: '真 UI 检查更新',
      what: publishesC ? 'A 批量面板 C 行已显示可更新到 0.0.2（B 仍基版）' : 'A 批量面板 B 行已显示可更新到 0.0.2（C 仍基版）',
      expected: publishesC ? 'C 行 0.0.2' : 'B 行 0.0.2；C 不显示 0.0.2',
      actual: 'versionNew B=' + String(checkedB ? checkedB.versionNew : null) + ' C=' + String(checkedC ? checkedC.versionNew : null),
      verdict: checkOk ? 'pass' : 'fail',
    })

    // ---------------- 逐格 ----------------

    if (options.mode === 'timeout') {
      // D1：官方桌面出口二「慢安装超时」
      const installAt = Date.now()
      await clickSeatAction(requireSession(), 'a', 'install')
      note('D1 超时格：真 UI 点 A 面板宏按钮「全部更新」（此时知识里只有 B 可更新）；安装窗口只轮询磁盘台账（不碰 CDP，宿主移除/重装可能换页面）')
      const waited = await waitForLedgerState({ homeDir, pluginId: pluginB, wanted: ['failed'], timeoutMs: 150000, label: 'B 台账到 failed' })
      const failedAt = Date.now()
      await run.raw('ledger-observation-timeout', { observed: waited.observed, failed: waited.entry, all: waited.lastEntries })
      const failedEntry = waited.entry
      const failedOk = failedEntry !== null && ledgerStateOf(failedEntry) === 'failed' && textOf(failedEntry.state['targetVersion']) === TARGET_VERSION && textOf(failedEntry.state['previousVersion']) === BASE_VERSION
      run.record({
        step: 'D1 超时终态',
        what: '慢安装到点后台账落一个 failed 终态（target 0.0.2 / previous 0.0.1）',
        expected: 'fxa-b 的 state.json：state=failed，targetVersion=0.0.2，previousVersion=0.0.1',
        actual: jsonText({ observed: waited.observed, failed: failedEntry }),
        verdict: failedOk ? 'pass' : 'fail',
      })

      let panelAfterTimeout: BatchSeatState | null = null
      try {
        panelAfterTimeout = await waitForBatchSeat(
          requireSession(),
          'a',
          (state) => {
            const rowB = rowOf(state, 'b')
            return rowB !== null && rowB.phase === 'failed'
          },
          { label: 'A 面板 B 行进入 failed（超时后）', timeoutMs: 60000, intervalMs: 1000 },
        )
      } catch (error) {
        note('超时后 A 面板未能读到 failed 行（宿主可能已换页面）：' + messageOf(error))
      }
      await run.raw('panel-after-timeout', panelAfterTimeout)
      const timeoutRow = rowOrNull(panelAfterTimeout, 'b')
      await pause('panel-after-timeout', {
        step: 'D1 超时 UI',
        what: 'A 面板 B 行在超时后显示失败（失败码不是「正在安装」）',
        expected: 'phase=failed；红字含 install-failed；页面无「正在安装」',
        actual: timeoutRow ? jsonText({ phase: timeoutRow.phase, fail: timeoutRow.fail, status: timeoutRow.status, busy: timeoutRow.busy }) : '面板不可读（宿主已换页面，重启后另证）',
        verdict: timeoutRow ? (timeoutRow.phase === 'failed' && (timeoutRow.fail || '').indexOf('install-failed') >= 0 ? 'pass' : 'fail') : 'unknown',
      })

      // 停宿主后读日志（缓冲未冲刷会读不到）——只认 fxa-b 命名空间。
      await stopDesktop('after-timeout')
      const logFacts = await captureLogFiles(run.recorder, homeDir)
      const execRows = namespaceEvents(logFacts.snapshot.events, pluginB, 'update.install.exec')
      const failRows = namespaceEvents(logFacts.snapshot.events, pluginB, 'update.install.fail')
      const execRow = execRows.length > 0 ? execRows[execRows.length - 1]! : null
      const failRow = failRows.length > 0 ? failRows[failRows.length - 1]! : null
      const durationMs = fieldNumber(execRow, 'durationMs')
      run.record({
        step: 'D1 exec 日志',
        what: 'update.install.exec 记一次 desktop-manager 失败，耗时不短于 12s 安装预算',
        expected: 'route=desktop-manager，ok=false，durationMs≥' + String(INSTALL_TIMEOUT_MS),
        actual: jsonText({ count: execRows.length, fields: execRow ? execRow.fields : null }),
        verdict: execRows.length === 1 && fieldText(execRow, 'route') === 'desktop-manager' && fieldBool(execRow, 'ok') === false && (durationMs ?? 0) >= INSTALL_TIMEOUT_MS - 500 && (durationMs ?? 0) <= 120000 ? 'pass' : 'fail',
      })
      const execFailRows = failRows.filter((row) => fieldText(row, 'stage') === 'exec')
      const gateFailRows = failRows.filter((row) => fieldText(row, 'stage') === 'gate')
      const gateRetryOk = gateFailRows.every((row) => fieldText(row, 'code') === 'check-expired')
      const failReason = fieldText(failRow, 'reason')
      run.record({
        step: 'D1 fail 日志',
        what: 'update.install.fail 与实际收场一致：exec 收场恰 1 条；前面若出现 gate check-expired，是 #70/ADR-0004 §3 的当场重查重提（≥2 家的批每家首次都会走，src/host/batch/phones.ts:388-410），属同一次安装尝试，不掩盖真实收场',
        expected: 'exec 收场恰 1 条：stage=exec、code=install-failed、reason∈{timeout,host-rejected}；其余 fail 只允许 stage=gate、code=check-expired；最后一条是 exec 收场',
        actual: jsonText({ count: failRows.length, execFailCount: execFailRows.length, gateFailCount: gateFailRows.length, last: failRow ? failRow.fields : null, gateFails: gateFailRows.map((row) => row.fields) }),
        verdict: execFailRows.length === 1 && gateRetryOk && failRows.length === execFailRows.length + gateFailRows.length && fieldText(failRow, 'stage') === 'exec' && fieldText(failRow, 'code') === 'install-failed' && (failReason === 'timeout' || failReason === 'host-rejected') ? 'pass' : 'fail',
      })

      const timeoutMessage = ledgerMessageOf(waited.lastEntries)
      const claimsNoCancel = timeoutMessage.indexOf('未提供取消能力') >= 0
      const claimsTerminated = timeoutMessage.indexOf('已终止') >= 0
      // 日志出于隐私只落 hostCodeHash（脚本字段），不落宿主原话 hostCode；用「有哈希 + 人话含取消原话」
      // 证明收场是宿主真取消，而不是拿字段名猜。
      const hostCodeHash = fieldText(failRow, 'hostCodeHash')
      const hostCancelled = failReason === 'host-rejected' && hostCodeHash !== null && hostCodeHash !== ''
      const messageOk =
        timeoutMessage.indexOf('install-failed') === 0 &&
        !claimsNoCancel &&
        !claimsTerminated &&
        (failReason === 'timeout'
          ? timeoutMessage.indexOf('已请求宿主取消') >= 0
          : hostCancelled
            ? timeoutMessage.indexOf('安装已被取消') >= 0
            : false)
      run.record({
        step: 'D1 人话格诚实',
        what: '超时人话格与宿主取消能力一致：有 cancelInstall 时要么「已请求宿主取消」、要么宿主真取消后「安装已被取消」；不许说未提供能力或已终止',
        expected: 'message 以 install-failed 开头；不含「未提供取消能力」「已终止」；reason=host-rejected 时日志有 hostCodeHash 且人话含「安装已被取消」',
        actual: jsonText({ message: timeoutMessage, failReason, hostCodeHash, claimsNoCancel, claimsTerminated }),
        verdict: messageOk ? 'pass' : 'fail',
      })

      const operations = await capturePluginManagerOperations({
        recorder: run.recorder,
        homeDir,
        profileName: PROFILE_NAME,
        window: { fromMs: installAt - 1000, toMs: failedAt + 8000 },
      })
      await run.raw('plugin-manager-operations-timeout', operations)
      run.record({
        step: 'D1 管理器操作',
        what: 'plugin-manager 真的走过移除→安装（超时格在安装步挂住）',
        expected: '操作记录 ≥1 个非空目录，且出现移除 0.0.1 的记录',
        actual: jsonText({ count: operations.count, nonEmptyCount: operations.nonEmptyCount, order: operations.order, operations: operations.operations }),
        verdict: operations.count >= 1 && operations.nonEmptyCount >= 1 ? 'pass' : 'fail',
      })

      const diskAfterTimeout = await readDisk()
      const noFakeSuccess = (diskAfterTimeout.versions[packageB] ?? null) !== TARGET_VERSION && (diskAfterTimeout.dependencies[packageB] ?? null) !== TARGET_VERSION
      run.record({
        step: 'D1 磁盘无虚假成功',
        what: '超时收场后磁盘上 B 仍是 0.0.1（没有出现台账失败但盘上新版的假成功）',
        expected: 'versions[B]≠0.0.2 且 dependencies[B]≠0.0.2',
        actual: jsonText(diskAfterTimeout),
        verdict: noFakeSuccess ? 'pass' : 'fail',
      })

      // 重启后如实展示：台账 failed + A 面板 B 行 failed + 页面无「正在安装」。
      session = await launchDesktop('restart-after-timeout')
      const restartedSeat = await waitPanel('after-restart-timeout')
      const restartedB = rowOrNull(restartedSeat, 'b')
      const restartedText = await requireSession().cdp.pageText()
      const restartedLedger = ledgerOf(await readLedgerStates(homeDir), pluginB)
      const restartedEntry = restartedLedger.length > 0 ? restartedLedger[restartedLedger.length - 1]! : null
      const restartedRowHonest = rowHonestAfterRestart(restartedB, TARGET_VERSION)
      await run.raw('panel-after-restart-timeout', { seat: restartedSeat, ledger: restartedLedger, rowHonest: restartedRowHonest, pageTextTail: restartedText.slice(-3000) })
      run.record({
        step: 'D1 重启后如实展示',
        what: '重启后台账仍 failed；A 面板 B 行不谎称在飞/成功（管理器移除 B 后，自动检查按磁盘真相把行重算为「未安装/可装 0.0.2」——#152 既有语义）',
        expected: 'ledger.state=failed 且 target=0.0.2；rowB 非 done/current/installing/queued、无「已是最新/安装完成/更新成功」、不宣称 0.0.2 已装；页面无「正在安装」',
        actual: jsonText({ rowB: restartedB, ledger: restartedEntry, rowHonest: restartedRowHonest, claimsRunning: claimsInstallRunning(restartedText) }),
        verdict:
          restartedEntry !== null &&
          ledgerStateOf(restartedEntry) === 'failed' &&
          textOf(restartedEntry.state['targetVersion']) === TARGET_VERSION &&
          restartedRowHonest &&
          !claimsInstallRunning(restartedText)
            ? 'pass'
            : 'fail',
        note: '失败事实的权威是 <home>/updates/fxa-b/*/state.json（重启不改写）；批量行按 #152「检查后置条件」投影磁盘现状（src/host/batch/fan-out.ts:858-893，测试 tests/issue-152-check-reconcile.test.mjs:38-66 钉住）。',
      })
      const restartedC = await readTargetSeat(requireSession(), 'c').catch(() => null)
      run.record({
        step: 'D1 重启后其它席别',
        what: '超时失败没有牵连 C（仍 0.0.1），页面无在飞宣称',
        expected: 'C 徽标 0.0.1；无「正在安装」',
        actual: jsonText({ cardC: restartedC, claimsRunning: claimsInstallRunning(restartedText) }),
        verdict: (restartedC === null || restartedC.badgeText === BASE_VERSION || (restartedC.clientTag || '') === 'client v' + BASE_VERSION) && !claimsInstallRunning(restartedText) ? 'pass' : 'fail',
      })
      await pause('after-restart-timeout', {
        step: 'D1 重启后如实展示',
        what: '重启后台账仍 failed、A 面板 B 行不谎称更新中/已完成（包被管理器移除时行按磁盘投影为未安装可装）',
        expected: 'B 行非 done/current/installing、不显示「已是最新/安装完成」；页面无「正在安装」',
        actual: jsonText({ rowB: restartedB, rowHonest: restartedRowHonest }),
        verdict: restartedRowHonest ? 'pass' : 'fail',
      })
      await stopDesktop('final-timeout')
    }

    if (options.mode === 'queued-cancel') {
      // D2：批量面板的取消（真实语义：丢弃未完成项，不是终止在飞安装）。
      // 产品只有一个终态取消入口：「丢弃本批未完成的更新」两步确认（confirmCancel），语义=清会话+撤本批 waiting；
      // 行内「取消排队」只撤单次 waiting 占位、不碰批次，中枢 1s 退避还会重推（src/host/hub/registry.ts:222-249），
      // 所以行取消只验证「文案诚实」，随后用「丢弃本批」收口。产品没有终止在飞安装的入口（渲染层明说
      // 「正在安装的项无法停止」），本格不谎称终止，只验证「批次可丢弃、丢弃后不装、无虚假终态、重启后如实」。
      // 真机可达性（实测修正）：同一批量会话内部串行（src/core/batch/run.ts:267 等一家收局才推下一家），
      // 两套批量面板的安装又被产品中枢按 profile scope 串行（src/host/batch/fan-out.ts:1111-1118，ADR-0008），
      // 所以「面板对面板」不会自然出现 waiting；waiting 只在「别家安装已占执行锁、本电话再提交」时出现
      // （src/host/factory.ts:520-522 占位 + :525-546 公平门；src/core/batch/run.ts:270-275 queued 语义）。
      // 做法：B 的夹具桥打单插件电话 fxb-c.updateCheck/updateInstall 起 C 的慢安装占住执行锁（不走中枢），
      // A 面板宏「全部更新」轮到 C 时被挡下 → fxa-c 进 waiting → 真 UI 行取消（文案）→ 真 UI「丢弃本批」。
      const prefixFor = (observer: FixtureSlotKey, key: FixtureSlotKey): string => {
        const binding = fixtureSlotOf(observer).batch
        const target = binding ? binding.targets.find((candidate) => candidate.key === key) : undefined
        if (!target) throw new Error('观察者 ' + observer + ' 的批量目标里没有 ' + key)
        return target.prefix
      }
      const aC = prefixFor('a', 'c')
      const bC = prefixFor('b', 'c')

      // 1) 占锁方：B 的夹具桥先确认 C 可更新，再发单插件安装电话起慢安装（电话先回、exec 后完）。
      const occupierCheck = await callBridgePhone(requireSession(), 'b', bC + '.updateCheck', { includeEnv: true, includeQueue: true })
      const checkReceipt = recordOf(occupierCheck.reply['receipt'])
      const occupierCheckId = textOf(checkReceipt ? checkReceipt['checkId'] : null)
      const occupierRequestId = 'g2-occupier-' + run.layout.stamp
      const occupierStartedAt = Date.now()
      const occupierInstall = await callBridgePhone(requireSession(), 'b', bC + '.updateInstall', {
        checkId: occupierCheckId,
        requestId: occupierRequestId,
        from: 'panel',
      })
      const occupierSnapshot = recordOf(occupierInstall.reply['snapshot'])
      const occupierAccepted =
        occupierCheck.ok && occupierCheck.reply['ok'] === true && occupierCheckId !== null && occupierInstall.ok && occupierInstall.reply['ok'] === true
      await run.raw('occupier-phone-replies', {
        check: { route: occupierCheck.route, envelopeOk: occupierCheck.ok, replyOk: occupierCheck.reply['ok'] ?? null, receipt: checkReceipt, error: occupierCheck.error },
        install: {
          route: occupierInstall.route,
          envelopeOk: occupierInstall.ok,
          replyOk: occupierInstall.reply['ok'] ?? null,
          error: occupierInstall.error,
          job: occupierSnapshot ? occupierSnapshot['job'] ?? null : null,
          queue: recordOf(occupierInstall.reply['queue']),
        },
      })
      run.record({
        step: 'D2 占锁方受理',
        what: 'B 的夹具桥打单插件电话 fxb-c.updateCheck/updateInstall：拿到 checkId、安装电话受理（电话先回，慢安装 exec 在后台跑）',
        expected: 'check 回包 reply.ok=true 且有 receipt.checkId；install 回包 reply.ok=true',
        actual: jsonText({
          checkEnvelopeOk: occupierCheck.ok,
          checkReplyOk: occupierCheck.reply['ok'] ?? null,
          checkId: occupierCheckId,
          installEnvelopeOk: occupierInstall.ok,
          installReplyOk: occupierInstall.reply['ok'] ?? null,
          installError: occupierInstall.error,
          installJob: occupierSnapshot ? occupierSnapshot['job'] ?? null : null,
        }),
        verdict: occupierAccepted ? 'pass' : 'fail',
      })

      // 2) 等全局执行锁真被占住（queue.json 的 owner 是 B 运行时里的 C 目标 fxb-c）。
      let queueBefore: QueueFacts = queueFactsOf(null)
      const ownerDeadline = Date.now() + 30000
      while (Date.now() < ownerDeadline) {
        queueBefore = queueFactsOf((await readBatchDiskFacts(homeDir)).queue)
        if (queueBefore.owner && textOf(queueBefore.owner['pluginId']) === bC) break
        await sleep(500)
      }
      await run.raw('queue-owner-before', { queueBefore })
      run.record({
        step: 'D2 队列占用',
        what: '单插件安装电话先起的 C 慢安装已占住全局执行锁（queue.json 的 owner 是 B 运行时里的 C 目标 fxb-c）',
        expected: 'owner.pluginId=' + bC,
        actual: jsonText(queueBefore),
        verdict: queueBefore.owner !== null && textOf(queueBefore.owner['pluginId']) === bC ? 'pass' : 'fail',
      })

      // 3) A 面板宏安装：A 会话轮到 C 时核心 acquire 立即 update-busy（行画成 queued，会话停在 stoppedBecause=queued）。
      await clickSeatAction(requireSession(), 'a', 'install')
      let queuedSeat: BatchSeatState
      try {
        queuedSeat = await waitForBatchSeat(
          requireSession(),
          'a',
          (state) => {
            const rowC = rowOf(state, 'c')
            return rowC !== null && rowC.queued && rowC.actions.indexOf('row-cancel-queue') >= 0
          },
          { label: 'A 面板 C 行进入排队（显示取消排队按钮）', timeoutMs: 60000, intervalMs: 500 },
        )
      } catch (error) {
        throw new Error('D2 前置失败：A 面板 C 行没有进入排队态：' + messageOf(error))
      }
      const queuedRow = rowOrNull(queuedSeat, 'c')
      await run.raw('panel-after-queue', queuedSeat)
      run.record({
        step: 'D2 真 UI 排队',
        what: '第二个安装进队列：A 面板 C 行 data-queued=1 且出现「取消排队」按钮',
        expected: 'rowC.queued=true；actions 含 row-cancel-queue',
        actual: jsonText(queuedRow),
        verdict: queuedRow !== null && queuedRow.queued && queuedRow.actions.indexOf('row-cancel-queue') >= 0 ? 'pass' : 'fail',
      })
      await pause('after-queue', {
        step: 'D2 真 UI 排队',
        what: 'A 面板 C 行排队中（有取消排队按钮）',
        expected: 'C 行 queued + row-cancel-queue',
        actual: jsonText(queuedRow),
        verdict: queuedRow !== null && queuedRow.queued ? 'pass' : 'fail',
      })
      // 排队占位落盘与面板同源：等 waiting 里真出现 A 会话的 C 占位再拿快照（面板 queued 是会话态，队列文件才是锁事实）。
      let queueBeforeCancel = queueFactsOf((await readBatchDiskFacts(homeDir)).queue)
      const waitingDeadline = Date.now() + 20000
      while (Date.now() < waitingDeadline) {
        const waitingIds = queueBeforeCancel.waiting.map((entry) => textOf(entry['pluginId']))
        if (waitingIds.indexOf(aC) >= 0) break
        await sleep(250)
        queueBeforeCancel = queueFactsOf((await readBatchDiskFacts(homeDir)).queue)
      }
      await run.raw('queue-before-cancel', queueBeforeCancel)
      const waitingPluginIds = queueBeforeCancel.waiting.map((entry) => textOf(entry['pluginId']))
      run.record({
        step: 'D2 队列落盘',
        what: 'queue.json 的 waiting 里有 A 会话 C 的占位（requestId 是出发安装时排上的）',
        expected: 'waiting 含 pluginId=' + aC,
        actual: jsonText(queueBeforeCancel),
        verdict: waitingPluginIds.indexOf(aC) >= 0 ? 'pass' : 'fail',
      })
      // 回归 sharedReader 修复（fix commit 1）：排队窗内别的目标的电话（A 批量三家 check/status）会把模块级
      // 单例槽换掉；占锁方 fxb-c 的在飞任务绝不能被 healJob 误判成 interrupted/recovery-required，
      // 也不能提前释放 owner（否则 A 的 C 根本排不上队，run 268-20261102T153751 实测）。
      const windowOwnerLedger = ledgerOf(await readLedgerStates(homeDir), bC)
      await run.raw('queue-window-owner-ledger', windowOwnerLedger)
      run.record({
        step: 'D2 排队窗内占锁方未被误判中断',
        what: '排队窗内 A 侧电话持续换 sharedReader 槽：占锁方 fxb-c 台账仍是 installing（不是 interrupted/recovery-required），执行锁仍被它持有（上一条 owner 断言）',
        expected: 'fxb-c 台账恰 1 条且 state=installing；无 interrupted',
        actual: jsonText({ aC, bC, ownerLedger: windowOwnerLedger }),
        verdict:
          windowOwnerLedger.length === 1 &&
          ledgerStateOf(windowOwnerLedger[0]!) === 'installing' &&
          windowOwnerLedger.every((entry) => ledgerStateOf(entry) !== 'interrupted')
            ? 'pass'
            : 'fail',
      })

      // 4) 行内「取消排队」：产品真实 UI 动作，只撤本次 waiting 占位、不碰批量会话；中枢对未收尾会话按 1s 退避
      //    继续重推（src/host/hub/registry.ts:222-249 + src/core/hub/drive-policy.ts:64-65），所以它不是终态取消。
      //    这一步只验证「文案诚实」，并记录 re-enqueue 时间线作边界证据（不断言点完长期为空）。
      await clickSeatAction(requireSession(), 'a', 'row-cancel-queue', 'c')
      let afterRowCancelSeat: BatchSeatState
      try {
        afterRowCancelSeat = await waitForBatchSeat(
          requireSession(),
          'a',
          (state) => (state.panel.notice || '').indexOf('已取消排队') >= 0,
          { label: '行取消排队后出现诚实回执', timeoutMs: 20000, intervalMs: 250 },
        )
      } catch (error) {
        throw new Error('D2 行取消排队后没有出现回执：' + messageOf(error))
      }
      await run.raw('panel-after-row-cancel', afterRowCancelSeat)
      const rowCancelNotice = afterRowCancelSeat.panel.notice || ''
      const rowCancelRow = rowOrNull(afterRowCancelSeat, 'c')
      const rowCancelLies =
        rowCancelNotice.indexOf('不再等待') >= 0 || rowCancelNotice.indexOf('已终止') >= 0 || rowCancelNotice.indexOf('已请求终止') >= 0
      const rowCancelHonest = rowCancelNotice.indexOf('已取消排队') >= 0 && rowCancelNotice.indexOf('继续') >= 0 && !rowCancelLies
      run.record({
        step: 'D2 行取消排队文案诚实',
        what: '点 C 行「取消排队」：回执如实说明只撤本次等待占位、本批仍会继续尝试安装、不会终止在飞安装（不谎称「不再等待」）',
        expected: 'notice 含「已取消排队」与「继续」；不含「不再等待/已终止/已请求终止」',
        actual: jsonText({ notice: rowCancelNotice, rowC: rowCancelRow }),
        verdict: rowCancelHonest ? 'pass' : 'fail',
      })
      await pause('after-row-cancel', {
        step: 'D2 行取消排队文案诚实',
        what: '行取消排队回执（钉住 #268 文案修复后的诚实措辞）',
        expected: '已取消排队 + 本批仍会继续尝试 + 不终止在飞安装',
        actual: jsonText({ notice: rowCancelNotice, rowC: rowCancelRow }),
        verdict: rowCancelHonest ? 'pass' : 'fail',
      })
      // hub 重推是有意行为：撤销后下一轮 1s 退避会把同插件占位重新排上。只记录时间线（边界证据），
      // 随后立刻用「丢弃本批」把会话清掉，避免 C 真开装；语义缺口见研究笔记「行取消不能停批次」。
      const reenqueueStart = Date.now()
      const reenqueueSamples: { atMs: number; waitingIds: string[] }[] = []
      let firstReenqueueMs: number | null = null
      while (Date.now() - reenqueueStart < 3000) {
        const facts = queueFactsOf((await readBatchDiskFacts(homeDir)).queue)
        const ids = facts.waiting.map((entry) => textOf(entry['pluginId'])).filter((id): id is string => id !== null)
        reenqueueSamples.push({ atMs: Date.now() - reenqueueStart, waitingIds: ids })
        if (ids.indexOf(aC) >= 0) {
          firstReenqueueMs = Date.now() - reenqueueStart
          break
        }
        await sleep(150)
      }
      await run.raw('row-cancel-reenqueue-timeline', { firstReenqueueMs, samples: reenqueueSamples, note: 'hub 1s 退避重推是有意行为；行取消不是终态取消' })
      note(
        'D2 行取消只撤占位：实测 ' +
          (firstReenqueueMs === null ? '3s 内未观测到重新入队（本轮窗口较窄）' : '撤销后 ' + String(firstReenqueueMs) + 'ms 同一插件占位又被中枢重推') +
          '；因此改用「丢弃本批」作终态取消。',
      )

      // 5) 真 UI「丢弃本批未完成的更新」两步确认：产品对未完成批次的真实取消入口；语义=丢弃未完成项，
      //    不终止正在跑的安装（渲染层文案「正在安装的项无法停止」）。宿主在 hub 推进中会回 update-busy，
      //    所以失败就重试点击（真实用户也是再点一次），不伪造成功。
      const confirmSelector = cardSelectorOf('a') + ' button[data-act="cancel"][data-confirm="1"]'
      let afterDiscardSeat: BatchSeatState | null = null
      let discardAttempts = 0
      while (afterDiscardSeat === null && discardAttempts < 6) {
        discardAttempts += 1
        await clickSeatAction(requireSession(), 'a', 'cancel')
        try {
          await requireSession().cdp.waitForSelector(confirmSelector, { timeoutMs: 5000 })
        } catch {
          continue
        }
        const armedPage = await requireSession().cdp.pageText()
        await run.raw('discard-armed-' + String(discardAttempts), { confirmSelector, pageTextTail: armedPage.slice(-1500) })
        await clickSeatAction(requireSession(), 'a', 'cancel')
        const discardDeadline = Date.now() + 2500
        while (Date.now() < discardDeadline) {
          const state = await readBatchSeat(requireSession(), 'a').catch(() => null)
          if (state !== null && (state.panel.notice || '').indexOf('已丢弃') >= 0) {
            afterDiscardSeat = state
            break
          }
          await sleep(200)
        }
      }
      if (afterDiscardSeat === null) {
        throw new Error('D2 丢弃本批在 ' + String(discardAttempts) + ' 次点击后仍没有回执（hub 推进中持续 update-busy？）')
      }
      await run.raw('panel-after-discard', afterDiscardSeat)
      const discardNotice = afterDiscardSeat.panel.notice || ''
      const discardRowC = rowOrNull(afterDiscardSeat, 'c')
      const discardText = await requireSession().cdp.pageText()
      const discardLies =
        discardText.indexOf('已终止') >= 0 || discardText.indexOf('已请求终止') >= 0 || discardNotice.indexOf('不再等待') >= 0
      const discardHonest =
        discardNotice.indexOf('已丢弃') >= 0 &&
        !discardLies &&
        discardRowC !== null &&
        !discardRowC.queued &&
        discardRowC.phase !== 'installing'
      run.record({
        step: 'D2 真 UI 丢弃本批（两步确认）',
        what: '两步确认真 UI 点「丢弃本批未完成的更新」：回执如实说已丢弃未完成项（已完成的将保留），C 行不再排队/不在安装，页面不谎称已终止在飞安装',
        expected: '第一次点击进入 data-confirm=1 上膛；第二次点击后 notice 含「已丢弃」；rowC 不 queued/installing；无终止假话',
        actual: jsonText({ notice: discardNotice, rowC: discardRowC, attempts: discardAttempts }),
        verdict: discardHonest ? 'pass' : 'fail',
      })
      await pause('after-discard', {
        step: 'D2 真 UI 丢弃本批（两步确认）',
        what: '丢弃本批后的面板（回执 + C 行状态）',
        expected: '已丢弃本批未完成的更新；C 行不再排队/安装',
        actual: jsonText({ notice: discardNotice, rowC: discardRowC }),
        verdict: discardHonest ? 'pass' : 'fail',
      })

      // 5) 丢弃后批量账本：A 的会话被清空（产品 cancelPhone: noteBatchStopped(user-cancel)→clearSession），
      //    但没有生成任何成功/失败终态；C 行若残留在别的会话里也只允许 ready（排队未装）。
      let aBatchSession: Record<string, unknown> | null = null
      let aSessionCPhase: string | null = null
      const batchDeadline = Date.now() + 15000
      while (Date.now() < batchDeadline) {
        const facts = await readBatchDiskFacts(homeDir)
        let found = false
        for (const owner of Object.values(facts.owners)) {
          const session = recordOf(owner.batch)
          if (session === null) continue
          const entriesRaw = session['entries']
          if (!Array.isArray(entriesRaw)) continue
          const entries: Record<string, unknown>[] = []
          for (const item of entriesRaw) {
            const entry = recordOf(item)
            if (entry !== null) entries.push(entry)
          }
          const cEntry = entries.find((entry) => entry['key'] === 'c') ?? null
          if (entries.some((entry) => entry['key'] === 'a')) {
            aBatchSession = session
            aSessionCPhase = cEntry !== null ? textOf(cEntry['phase']) : null
            found = true
          }
          const terminal = cEntry !== null && (cEntry['phase'] === 'done' || cEntry['phase'] === 'failed')
          if (terminal) throw new Error('D2 丢弃后批量账本出现 C 的终态：' + JSON.stringify(cEntry))
        }
        if (!found) break
        await sleep(500)
      }
      await run.raw('batch-ledger-after-discard', { session: aBatchSession, cPhase: aSessionCPhase, owners: (await readBatchDiskFacts(homeDir)).owners })
      run.record({
        step: 'D2 丢弃后批量会话清空',
        what: '「丢弃本批」把 A 会话从磁盘清掉（不产生成功/失败终态）；C 行在任何残留会话里都不是 done/failed',
        expected: '磁盘上不存在含 A entry 的批量会话；C 行 phase 不为 done/failed',
        actual: jsonText({ aSession: aBatchSession, cPhase: aSessionCPhase }),
        verdict: aBatchSession === null || (aSessionCPhase !== 'done' && aSessionCPhase !== 'failed') ? 'pass' : 'fail',
      })

      // 5b) 丢弃后队列多采样（≥3s，≥2 次）：C 的 waiting 占位不再回来，owner 始终是占锁方
      //     （中枢 1s 重推被清会话后不再重放；若会话泄漏，这里会看到 fxa-c 反复排队）。
      const queueSamples: { atMs: number; ownerId: string | null; waitingIds: string[] }[] = []
      const queueSampleStart = Date.now()
      while (Date.now() - queueSampleStart < 4000) {
        const facts = queueFactsOf((await readBatchDiskFacts(homeDir)).queue)
        queueSamples.push({
          atMs: Date.now() - queueSampleStart,
          ownerId: facts.owner !== null ? textOf(facts.owner['pluginId']) : null,
          waitingIds: facts.waiting.map((entry) => textOf(entry['pluginId'])).filter((id): id is string => id !== null),
        })
        await sleep(500)
      }
      await run.raw('queue-after-discard', queueSamples)
      const noRequeue = queueSamples.length >= 2 && queueSamples.every((sample) => sample.waitingIds.indexOf(aC) < 0)
      // 丢弃「本批未完成」会清 A 的队列范围，queue.json 的 owner 变成 null 是清场后的正常态（不是提前释放占锁方）；
      // 占锁方是否仍在跑由它自己的证据断言（55-assert 的 exec 时长≈预算、56-assert 占位者收局）。
      const ownerReleasedOrOccupier = queueSamples.every((sample) => sample.ownerId === null || sample.ownerId === bC)
      run.record({
        step: 'D2 丢弃后不再排队',
        what: '丢弃后 ' + String(queueSamples.length) + ' 次队列采样（约 4s）：A 会话 C 的 waiting 占位没有再出现；owner 只允许 null（丢弃清场后的正常态）或仍为占锁方',
        expected: '全部采样 waiting 不含 ' + aC + '；owner ∈ {null, ' + bC + '}',
        actual: jsonText({ noRequeue, ownerReleasedOrOccupier, samples: queueSamples }),
        verdict: noRequeue && ownerReleasedOrOccupier ? 'pass' : 'fail',
      })

      // 6) 占锁方（B 运行时里的 C 慢安装）最终以自身超时失败收局：本格噪声，证明取消排队没有终止在飞安装。
      const ownerOutcome = await waitForLedgerState({ homeDir, pluginId: bC, wanted: ['failed'], timeoutMs: 120000, label: '占位慢安装 fxb-c 到 failed' })
      const ownerFinishedAt = Date.now()
      await run.raw('owner-failed-noise', { observed: ownerOutcome.observed, entry: ownerOutcome.entry, startedAt: occupierStartedAt, finishedAt: ownerFinishedAt, elapsedMs: ownerFinishedAt - occupierStartedAt })
      run.record({
        step: 'D2 占位者收局（噪声）',
        what: '占锁方的 C 慢安装真的以它自己的安装预算超时失败落定（证明取消期间执行锁确被占用；本格判据只看 A 的 C 不装）',
        expected: 'fxb-c 台账 state=failed；从占锁开始到失败 ≥ 产品安装预算 ' + String(slowInstallTimeoutMs) + 'ms（远大于本格取消排队发生的时刻）',
        actual: jsonText({ observed: ownerOutcome.observed, entry: ownerOutcome.entry, elapsedMs: ownerFinishedAt - occupierStartedAt }),
        verdict:
          ownerOutcome.entry !== null &&
          ledgerStateOf(ownerOutcome.entry) === 'failed' &&
          ownerFinishedAt - occupierStartedAt >= slowInstallTimeoutMs &&
          ownerOutcome.observed.indexOf('interrupted') < 0
            ? 'pass'
            : 'fail',
      })

      // 6) 队列收干净：owner 释放、waiting 无残留。
      let queueSettled: QueueFacts = queueFactsOf(null)
      const settledDeadline = Date.now() + 60000
      while (Date.now() < settledDeadline) {
        queueSettled = queueFactsOf((await readBatchDiskFacts(homeDir)).queue)
        if (queueSettled.owner === null && queueSettled.waiting.length === 0) break
        await sleep(500)
      }
      await run.raw('queue-settled', queueSettled)
      run.record({
        step: 'D2 队列清空',
        what: '占位者收局后 queue.json 没有残留占位：owner 释放、waiting 为空（撤销与收尾都留下了账）',
        expected: 'owner=null 且 waiting 为空',
        actual: jsonText(queueSettled),
        verdict: queueSettled.owner === null && queueSettled.waiting.length === 0 ? 'pass' : 'fail',
      })

      await stopDesktop('after-cancel')
      const logFacts = await captureLogFiles(run.recorder, homeDir)
      noteLogTruncations('D2 取消格日志', logFacts)
      const aExec = namespaceEvents(logFacts.snapshot.events, aC, 'update.install.exec')
      const aFail = namespaceEvents(logFacts.snapshot.events, aC, 'update.install.fail')
      const bExec = namespaceEvents(logFacts.snapshot.events, bC, 'update.install.exec')
      const aLedger = ledgerOf(await readLedgerStates(homeDir), aC)
      const diskAfterCancel = await readDisk()
      await run.raw('cancel-outcome', { aC, bC, aExec, aFail, bExec, aLedger, diskAfterCancel })
      run.record({
        step: 'D2 丢弃后不安装',
        what: 'A 会话的 C 从未开始安装：没有 update.install.exec（丢弃的是未完成批次，不是终止在飞安装）',
        expected: aC + ' 的 update.install.exec 条数=0',
        actual: jsonText({ aExecCount: aExec.length, events: aExec }),
        verdict: aExec.length === 0 ? 'pass' : 'fail',
      })
      // 首提被候选门挡下时产品会当场重查重提（#70，src/host/batch/phones.ts:388-410），留一行 stage=gate/code=check-expired；
      // 之后每次重推被公平门挡下记 stage=gate/code=update-busy。两者都是设计内的排队门事件，不是安装失败。
      const gateOnly = aFail.every(
        (row) => fieldText(row, 'stage') === 'gate' && (fieldText(row, 'code') === 'update-busy' || fieldText(row, 'code') === 'check-expired'),
      )
      run.record({
        step: 'D2 排队/丢弃不算失败',
        what: 'A 的 C 的 update.install.fail 只允许排队门拒绝（stage=gate；code∈{check-expired,update-busy}；首提当场重查重提与公平门都是设计内事件；核心 acquire 立即忙时工厂公平门不会发这行，所以空列表也算诚实），不允许 install-failed',
        expected: 'A 的 C 的 fail 事件为空或全部 stage=gate code∈{check-expired,update-busy}',
        actual: jsonText({ count: aFail.length, fields: aFail.map((row) => row.fields) }),
        verdict: gateOnly ? 'pass' : 'fail',
      })
      run.record({
        step: 'D2 无虚假终态',
        what: 'A 的 C 没有台账记录（排队撤销后没有启动安装，不存在成功/失败终态）',
        expected: aC + ' 的 state.json 条数=0',
        actual: jsonText({ aLedger }),
        verdict: aLedger.length === 0 ? 'pass' : 'fail',
      })
      run.record({
        step: 'D2 丢弃不产生 0.0.2 安装',
        what: '丢弃没有造成任何 0.0.2 安装副作用（占锁方慢安装超时后已被宿主移除并重装失败，磁盘 C 不是 0.0.2）',
        expected: 'versions[C]≠0.0.2；dependencies[C]≠0.0.2',
        actual: jsonText({ versions: diskAfterCancel.versions[packageC], dependencies: diskAfterCancel.dependencies[packageC], disk: diskAfterCancel.versions }),
        verdict: diskAfterCancel.versions[packageC] !== TARGET_VERSION && diskAfterCancel.dependencies[packageC] !== TARGET_VERSION ? 'pass' : 'fail',
      })
      // 占锁方是「它自己跑到超时收尾」而不是被我们的取消排队终止：exec 时长必须走满安装预算。
      // （A 的取消发生在占锁开始后数秒；若产品把取消误当终止，这个 exec 不可能跑满 25s。）
      const bExecRow = bExec.length > 0 ? bExec[bExec.length - 1]! : null
      const bExecDurationMs = fieldNumber(bExecRow, 'durationMs')
      await run.raw('occupier-exec-duration', { bExecCount: bExec.length, bExec, bExecDurationMs, slowInstallTimeoutMs })
      run.record({
        step: 'D2 取消未终止在飞安装',
        what: '占锁方的 update.install.exec 跑满自己的安装预算才收尾（取消排队只撤 waiting 占位，没有终止正在跑的安装）',
        expected: 'bExec 恰 1 条且 durationMs ≥ ' + String(slowInstallTimeoutMs) + 'ms（ok=false）',
        actual: jsonText({ count: bExec.length, durationMs: bExecDurationMs, ok: fieldBool(bExecRow, 'ok'), route: fieldText(bExecRow, 'route') }),
        verdict: bExec.length === 1 && bExecDurationMs !== null && bExecDurationMs >= slowInstallTimeoutMs && fieldBool(bExecRow, 'ok') === false ? 'pass' : 'fail',
      })

      session = await launchDesktop('restart-after-cancel')
      const restartedSeat = await waitPanel('after-restart-cancel')
      const restartedC = rowOrNull(restartedSeat, 'c')
      const restartedText = await requireSession().cdp.pageText()
      const cTargetCard = await readTargetSeat(requireSession(), 'c').catch(() => null)
      const restartDisk = await readDisk()
      await run.raw('panel-after-restart-cancel', { seat: restartedSeat, pageTextTail: restartedText.slice(-3000), disk: restartDisk })
      run.record({
        step: 'D2 重启后如实展示',
        what: '重启后 A 面板 C 行不再排队/不在安装、页面无「正在安装」，C 目标卡不谎称 0.0.2（磁盘如实：占锁方的超时失败移除了 C）',
        expected: 'rowC.queued=false 且 phase≠installing；无「正在安装」；C 卡不显示 client v0.0.2',
        actual: jsonText({ rowC: restartedC, claimsRunning: claimsInstallRunning(restartedText), cardC: cTargetCard, diskC: restartDisk.versions[packageC] }),
        verdict:
          restartedC !== null &&
          !restartedC.queued &&
          restartedC.phase !== 'installing' &&
          !claimsInstallRunning(restartedText) &&
          (cTargetCard === null || !cTargetCard.present || cTargetCard.clientTag !== 'client v' + TARGET_VERSION)
            ? 'pass'
            : 'fail',
      })
      await pause('after-restart-cancel', {
        step: 'D2 重启后如实展示',
        what: '重启后 A 面板 C 行未在排队/安装，C 目标卡不谎称已到 0.0.2',
        expected: 'C 行不排队、不安装；C 卡不显示 v0.0.2',
        actual: jsonText({ rowC: restartedC, cardC: cTargetCard }),
        verdict: restartedC !== null && !restartedC.queued ? 'pass' : 'fail',
      })
      await stopDesktop('final-cancel')
    }

    if (options.mode === 'failed-no-retry' || options.mode === 'retry-single-success' || options.mode === 'retry-can-red') {
      // D3 / D4 共用失败格：删 B 的 0.0.2 tarball（元数据不动），真 UI 安装 →移除步成功、重装步 404。
      await warmRegistryTarball({ registry: fixtureEnv.registry, packageName: 'dsh-log', version: '0.3.4' })
      const fault: TarballFault = await removePublishedTarball({
        registry: fixtureEnv.registry,
        backupDir: join(run.layout.root, 'registry-tarball-backup'),
        packageName: packageB,
        version: TARGET_VERSION,
      })
      await run.raw('registry-tarball-fault', fault)
      run.record({
        step: '失败注入',
        what: '删掉 B@0.0.2 的 tarball、保留版本文档（让候选门能过、pnpm 下载 404）',
        expected: '删前 200 非空；删后 404；版本文档一字不差',
        actual: jsonText({ servedBeforeStatus: fault.servedBeforeStatus, servedBeforeBytes: fault.servedBeforeBytes, servedAfterStatus: fault.servedAfterStatus, versionDocUnchanged: fault.versionDocUnchanged }),
        verdict: fault.servedBeforeStatus === 200 && fault.servedBeforeBytes > 0 && fault.servedAfterStatus === 404 && fault.versionDocUnchanged ? 'pass' : 'fail',
      })

      const installAt = Date.now()
      await clickSeatAction(requireSession(), 'a', 'install')
      note('D3 失败格：真 UI 点 A 面板宏按钮「全部更新」（此时知识里只有 B 可更新）；安装窗口只轮询磁盘台账')
      const waited = await waitForLedgerState({ homeDir, pluginId: pluginB, wanted: ['failed'], timeoutMs: 180000, label: 'B 台账到 failed' })
      const failedAt = Date.now()
      await run.raw('ledger-observation-failure', { observed: waited.observed, failed: waited.entry, all: waited.lastEntries })
      const failedEntry = waited.entry
      const failedOk = failedEntry !== null && ledgerStateOf(failedEntry) === 'failed' && textOf(failedEntry.state['targetVersion']) === TARGET_VERSION
      run.record({
        step: 'D3 已失败落定',
        what: '失败安装落一个 failed 终态（不是 interrupted/成功）',
        expected: 'fxa-b state.json：state=failed，targetVersion=0.0.2',
        actual: jsonText({ observed: waited.observed, failed: failedEntry }),
        verdict: failedOk ? 'pass' : 'fail',
      })

      let panelAfterFailure: BatchSeatState | null = null
      try {
        panelAfterFailure = await waitForBatchSeat(
          requireSession(),
          'a',
          (state) => {
            const rowB = rowOf(state, 'b')
            return rowB !== null && rowB.phase === 'failed'
          },
          { label: 'A 面板 B 行进入 failed（失败后）', timeoutMs: 60000, intervalMs: 1000 },
        )
      } catch (error) {
        note('失败后 A 面板未能读到 failed 行：' + messageOf(error))
      }
      await run.raw('panel-after-failure', panelAfterFailure)
      const failedRow = rowOrNull(panelAfterFailure, 'b')
      const failedRowCode = failedRow !== null ? ledgerCodeOf(failedRow.fail || '') : null
      // 失败码只认两种诚实值：exec 收场的 install-failed，或 desktop-manager 换包时宿主换代、
      // 批量 settle 读到瞬间 interrupted 而记下的 recovery-required（#266 型跨进程竞态，详见
      // docs/research/20261101-issue-268-timeout-cancel-settlement.md「失败行码竞态」；台账仍为
      // install-failed，见本条之前的 D3 已失败落定）。两种都表示失败，绝不接受成功/更新中的说法。
      const failedRowHonest = failedRow !== null && failedRow.phase === 'failed' && (failedRowCode === 'install-failed' || failedRowCode === 'recovery-required')
      run.record({
        step: 'D3 UI 显示失败',
        what: 'A 面板 B 行显示诚实失败码（install-failed，或宿主换代瞬间的 recovery-required；不是「正在安装」/成功）',
        expected: 'phase=failed；红字含 install-failed 或 recovery-required；页面无「正在安装」/成功说法',
        actual: jsonText({ rowB: failedRow, rowCode: failedRowCode, pageTextTail: panelAfterFailure ? null : '面板不可读' }),
        verdict: failedRow === null ? 'unknown' : failedRowHonest ? 'pass' : 'fail',
        note: failedRowCode === 'recovery-required' ? '本 run 命中 #266 型跨进程竞态：批量 settle 读到宿主换代瞬间的 interrupted，行码 recovery-required；权威台账仍是 failed/install-failed（上一条断言、raw/failure-human-message）。' : undefined,
      })

      // 失败格的手工命令来源（T3 e2 先例）：产品在失败面上不给载体命令，可执行命令在回包/台账人话里；
      // 这里把它提前取出来，供「UI 手工命令/诊断入口」与「台账人话格」两条断言共用。
      const failureMessage = ledgerMessageOf(waited.lastEntries)
      const manualCommand = executableCommandOf(failureMessage)
      // 行详情：失败码 + 手工命令是否真能从 UI 取得（按实际观测记录，不预设）。
      let detail: { text: string | null; actions: string[]; hasManualCommand: boolean } | null = null
      if (panelAfterFailure) {
        try {
          await clickSeatAction(requireSession(), 'a', 'toggle-details', 'b')
          await requireSession().cdp.waitForSelector('.dsh-upd-bdetail-dialog', { timeoutMs: 15000 })
          detail = await requireSession().cdp.evaluate<{ text: string | null; actions: string[]; hasManualCommand: boolean }>(
            '(() => { const dialog = document.querySelector(".dsh-upd-bdetail-dialog"); if (!dialog) return { text: null, actions: [], hasManualCommand: false }; const text = (dialog.innerText || "").slice(0, 5000); const actions = Array.from(dialog.querySelectorAll("button[data-act]")).map((el) => el.getAttribute("data-act")); return { text, actions, hasManualCommand: text.indexOf("dsh plugin --profile desktop add --save-exact") >= 0 }; })()',
          )
          await run.raw('row-detail-after-failure', detail)
          await pause('failure-detail', {
            step: 'D3 行详情',
            what: '失败行详情弹窗里的失败码、诊断入口与手工命令（按产品真实能力：读不到运行版时 05 段会明说「当前没有可用的手工命令」并指引重启/复制诊断）',
            expected: '详情含可复制手工命令（或按钮 row-copy-manual）；否则至少有 row-copy-diag 且台账 message 带可执行命令',
            actual: jsonText({ hasManualCommand: detail.hasManualCommand, actions: detail.actions, textTail: (detail.text || '').slice(-1200) }),
            verdict: detail.hasManualCommand || detail.actions.indexOf('row-copy-manual') >= 0 || (detail.actions.indexOf('row-copy-diag') >= 0 && manualCommand !== null) ? 'pass' : 'fail',
          })
          await requireSession().cdp.clickSelector('.dsh-upd-bdetail-dialog button[data-act="detail-close"]', { timeoutMs: 15000 }).catch(() => undefined)
        } catch (error) {
          note('打开失败行详情失败：' + messageOf(error))
        }
      }
      const detailText = detail && detail.text ? detail.text : ''
      const uiOffersManual = detail !== null && (detail.hasManualCommand || detail.actions.indexOf('row-copy-manual') >= 0)
      const uiOffersDiag = detail !== null && detail.actions.indexOf('row-copy-diag') >= 0
      run.record({
        step: 'D3 UI 失败面 + 手工命令可得',
        what: '失败行详情能取到手工命令；或按产品既有语义（T3 e2 先例、#177 手工命令可信来源）失败面不画载体命令、退化为「复制诊断」，此时可执行命令必须仍在台账人话里供复制 —— 两种形态都要求失败面如实可取证，不伪造 DOM',
        expected: '详情含 dsh plugin --profile desktop add --save-exact 或按钮 row-copy-manual；否则：详情必有 row-copy-diag，且台账 message 里能取出可执行手工命令',
        actual: jsonText({ detailLoaded: detail !== null, hasManualCommand: detail ? detail.hasManualCommand : null, actions: detail ? detail.actions : null, uiOffersManual, uiOffersDiag, ledgerManualCommand: manualCommand, detailTail: detailText.slice(-800) }),
        verdict: detail !== null ? (uiOffersManual || (uiOffersDiag && manualCommand !== null) ? 'pass' : 'fail') : 'unknown',
        note: '本 run 观测：失败面不给「复制手工命令」按钮（目标包已被宿主移除，批量行读不到可信 manual，#177/#168），但详情有「复制诊断」；详情 05 段明说「当前没有可用的手工命令…重启宿主后再查一次」，属诚实降级；同一事实的可执行命令在 state.json message 里（raw/failure-human-message）。',
      })
      await run.raw('failure-human-message', { message: failureMessage, manualCommand })
      run.record({
        step: 'D3 台账人话格',
        what: '失败台账 message 以 install-failed 开头、带 pnpm 原话与可执行重装命令（UI 复制按钮的源）',
        expected: '前缀 install-failed；含手工命令 dsh plugin --profile desktop add --save-exact ' + packageB + '@' + TARGET_VERSION,
        actual: jsonText({ message: failureMessage, manualCommand }),
        verdict: failureMessage.indexOf('install-failed') === 0 && manualCommand !== null && manualCommand.indexOf(packageB + '@' + TARGET_VERSION) >= 0 ? 'pass' : 'fail',
      })

      // 静置 ≥15s：无自动重试（日志计数不增）。
      note('D3 静置 ' + String(FAILURE_IDLE_MS) + 'ms，验证已失败不被自动重试')
      await sleep(FAILURE_IDLE_MS)
      await stopDesktop('after-failure')
      const logFacts = await captureLogFiles(run.recorder, homeDir)
      noteLogTruncations('D3 失败日志', logFacts)
      const execRows = namespaceEvents(logFacts.snapshot.events, pluginB, 'update.install.exec')
      const failRows = namespaceEvents(logFacts.snapshot.events, pluginB, 'update.install.fail')
      const okRows = execRows.filter((row) => fieldBool(row, 'ok') === true)
      const failRow = failRows.length > 0 ? failRows[failRows.length - 1]! : null
      const execRow = execRows.length > 0 ? execRows[execRows.length - 1]! : null
      const execFailRows = failRows.filter((row) => fieldText(row, 'stage') === 'exec')
      const gateFailRows = failRows.filter((row) => fieldText(row, 'stage') === 'gate')
      const gateRetryOk = gateFailRows.every((row) => fieldText(row, 'code') === 'check-expired')
      await run.raw('failure-log-counts', { execRows, failRows, okCount: okRows.length })
      run.record({
        step: 'D3 无自动重试',
        what: '失败落定后静置 15s，只发生一次真实安装尝试：1 条 exec、exec 收场 1 条 fail；前面的 gate check-expired 是 #70 当场重查重提（同一次尝试，src/host/batch/phones.ts:388-410），不是第二次安装；静置期间没有新增 exec',
        expected: 'update.install.exec 条数=1；exec 收场 fail 恰 1 条；ok=true 条数=0；其余 fail 只允许 gate/check-expired',
        actual: jsonText({ execCount: execRows.length, failCount: failRows.length, execFailCount: execFailRows.length, gateFailCount: gateFailRows.length, okCount: okRows.length, durations: execRows.map((row) => fieldNumber(row, 'durationMs')) }),
        verdict: execRows.length === 1 && execFailRows.length === 1 && gateRetryOk && okRows.length === 0 && failRows.length === execFailRows.length + gateFailRows.length ? 'pass' : 'fail',
      })
      run.record({
        step: 'D3 失败八格',
        what: 'exec/fail 日志字段自洽（出口二失败：route=desktop-manager、stage=exec、退出码非 0）',
        expected: 'exec.route=desktop-manager；exec.ok=false；exec.exitCode 为整数；fail.stage=exec；fail.reason=nonzero-exit；fail.code=install-failed',
        actual: jsonText({ exec: execRow ? execRow.fields : null, fail: failRow ? failRow.fields : null }),
        verdict:
          fieldText(execRow, 'route') === 'desktop-manager' &&
          fieldBool(execRow, 'ok') === false &&
          typeof fieldNumber(execRow, 'exitCode') === 'number' &&
          fieldText(failRow, 'stage') === 'exec' &&
          fieldText(failRow, 'reason') === 'nonzero-exit' &&
          fieldText(failRow, 'code') === 'install-failed'
            ? 'pass'
            : 'fail',
      })
      const diskAfterFailure = await readDisk()
      run.record({
        step: 'D3 磁盘无虚假成功',
        what: '失败后磁盘 B 不是 0.0.2（没有出现台账失败但盘上新版的假成功）',
        expected: 'versions[B]≠0.0.2；dependencies[B]≠0.0.2',
        actual: jsonText(diskAfterFailure),
        verdict: (diskAfterFailure.versions[packageB] ?? null) !== TARGET_VERSION && (diskAfterFailure.dependencies[packageB] ?? null) !== TARGET_VERSION ? 'pass' : 'fail',
      })

      // 重启后如实展示。
      session = await launchDesktop('restart-after-failure')
      const restartedSeat = await waitPanel('after-restart-failure')
      const restartedB = rowOrNull(restartedSeat, 'b')
      const restartedText = await requireSession().cdp.pageText()
      const restartedLedger = ledgerOf(await readLedgerStates(homeDir), pluginB)
      const restartedEntry = restartedLedger.length > 0 ? restartedLedger[restartedLedger.length - 1]! : null
      const restartedC = await readTargetSeat(requireSession(), 'c').catch(() => null)
      const restartedRowHonest = rowHonestAfterRestart(restartedB, TARGET_VERSION)
      await run.raw('panel-after-restart-failure', { seat: restartedSeat, ledger: restartedLedger, rowHonest: restartedRowHonest, pageTextTail: restartedText.slice(-3000), cardC: restartedC })
      run.record({
        step: 'D3 重启后如实展示',
        what: '重启后台账仍 failed；B 行不谎称更新中/已完成（失败不自动重试，重启也不改写台账；#152 检查把行按磁盘真相重算），C 仍 0.0.1',
        expected: 'ledger.state=failed 且 target=0.0.2；rowB 非 done/current/installing/queued、无「已是最新/安装完成/更新成功」、不宣称 0.0.2 已装；页面无「正在安装」；C 0.0.1',
        actual: jsonText({ rowB: restartedB, ledger: restartedEntry, rowHonest: restartedRowHonest, claimsRunning: claimsInstallRunning(restartedText), cardC: restartedC }),
        verdict:
          restartedEntry !== null &&
          ledgerStateOf(restartedEntry) === 'failed' &&
          textOf(restartedEntry.state['targetVersion']) === TARGET_VERSION &&
          restartedRowHonest &&
          !claimsInstallRunning(restartedText) &&
          (restartedC === null || restartedC.clientTag === 'client v' + BASE_VERSION)
            ? 'pass'
            : 'fail',
        note: '失败事实的权威是 <home>/updates/fxa-b/*/state.json；批量行按 #152 检查后置条件投影磁盘现状（src/host/batch/fan-out.ts:858-893）。',
      })
      await pause('after-restart-failure', {
        step: 'D3 重启后如实展示',
        what: '重启后台账仍 failed、B 行不谎称更新中/已完成（包被移除时按磁盘投影为未安装可装）',
        expected: 'B 行非 done/current/installing、不显示「已是最新/安装完成」；页面无「正在安装」',
        actual: jsonText({ rowB: restartedB, rowHonest: restartedRowHonest }),
        verdict: restartedRowHonest ? 'pass' : 'fail',
      })

      if (options.mode === 'failed-no-retry') {
        await stopDesktop('final-failure')
      } else {
        // D4：恢复 registry，真 UI 点「重试」，成功后台账只留一条成功终态。
        const restored = await restorePublishedTarball({ registry: fixtureEnv.registry, fault })
        await run.raw('registry-tarball-restored', restored)
        run.record({
          step: 'D4 恢复 registry',
          what: '把 B@0.0.2 tarball 放回 registry（恢复后 GET 200，元数据不变）',
          expected: 'restoredStatus=200；versionDocUnchanged=true',
          actual: jsonText(restored),
          verdict: restored.restoredStatus === 200 && restored.versionDocUnchanged ? 'pass' : 'fail',
        })
        await clickSeatAction(requireSession(), 'a', 'row-install', 'b')
        note('D4 重试格：真 UI 点 A 面板 B 行「重试」；安装窗口只轮询磁盘版本（成功会触发宿主自重启）')
        const retriedVersion = await waitDiskVersion(packageB, TARGET_VERSION, 240000)
        await run.raw('disk-after-retry', { retriedVersion, disk: await readDisk() })
        run.record({
          step: 'D4 重试成功落盘',
          what: '重试安装成功：磁盘上 B 变成 0.0.2（产品路径，不是手工 CLI）',
          expected: 'versions[B]=0.0.2',
          actual: 'versions[B]=' + String(retriedVersion),
          verdict: retriedVersion === TARGET_VERSION ? 'pass' : 'fail',
        })

        const retriedLedger = await waitLedgerTerminal(pluginB, 90000)
        await run.raw('ledger-after-retry', { ledgerB: retriedLedger })

        // 停掉自重启实例，起托管实例读成功后的 UI 与台账。
        await stopDesktop('after-retry')
        session = await launchDesktop('restart-after-retry')
        const successSeat = await waitPanel('after-retry')
        const successB = rowOrNull(successSeat, 'b')
        const successText = await requireSession().cdp.pageText()
        const seatB = await readBatchSeat(requireSession(), 'b').catch(() => null)
        const successC = await readTargetSeat(requireSession(), 'c').catch(() => null)
        const successDisk = await readDisk()
        const allLedger = await readLedgerStates(homeDir)
        const ledgerB = ledgerOf(allLedger, pluginB)
        const successLedger = ledgerB.filter((entry) => SUCCESS_STATES.indexOf(ledgerStateOf(entry)) >= 0)
        await run.raw('panel-after-retry', { seat: successSeat, cardB: seatB, cardC: successC, ledgerB, successLedger, disk: successDisk, pageTextTail: successText.slice(-3000) })
        const successPrevious = successLedger.length > 0 ? textOf(successLedger[0]!.state['previousVersion']) : null
        run.record({
          step: 'D4 恰一条成功终态',
          what: '补一次成功后台账只留一条成功终态（state.json 唯一一份且 state∈{completed,restart-required}、target 0.0.2、previous 是 0.0.1 或 null）',
          expected: 'fxa-b 的 state.json 条数=1；state∈{completed,restart-required}；targetVersion=0.0.2；previousVersion=0.0.1 或 null（失败后目标包被宿主移除时无从得知前版，null 是诚实值）；成功终态恰 1 条',
          actual: jsonText({ ledgerB, successLedger, previous: successPrevious }),
          verdict:
            ledgerB.length === 1 &&
            successLedger.length === 1 &&
            textOf(successLedger[0]!.state['targetVersion']) === TARGET_VERSION &&
            (successPrevious === BASE_VERSION || successPrevious === null)
              ? 'pass'
              : 'fail',
        })

        // 日志：先失败一次、后成功一次。可证伪的「没有第二次成功/失败」用下条的 request/exec/fail/完成态事件证明。
        // 票面 AC #3 只要求「补一次成功后台账只留一条成功终态」，不把「成功那次 exec 行完整」当验收点：
        // 成功安装会触发管理器替换进程，而 dsh-log 的 info 行有 1000ms 防抖
        // （node_modules/dsh-log/dist/engine/pipeline.js:341-358），旧进程被 relaunch 终止时该行可能还没冲盘
        // （T4 实测 state.json 已 completed、成功 exec 行缺失）。证实「宿主未冲盘」需要 pid 级取证，
        // 且即便证实也不是本包可修行为；半证据 known-red 不登记，不拿别的行冒充成功 exec。
        // 决策与理由见 docs/research/20261101-issue-268-timeout-cancel-settlement.md「为什么不把成功 exec 行当验收点」。
        await stopDesktop('before-success-logs')
        const successLogs = await captureLogFiles(run.recorder, homeDir)
        noteLogTruncations('D4 成功日志', successLogs)
        const successExec = namespaceEvents(successLogs.snapshot.events, pluginB, 'update.install.exec')
        const successFail = namespaceEvents(successLogs.snapshot.events, pluginB, 'update.install.fail')
        const successRequests = namespaceEvents(successLogs.snapshot.events, pluginB, 'update.install.request')
        const successRequestHashes = Array.from(new Set(successRequests.map((row) => fieldText(row, 'intentHash')).filter((hash): hash is string => hash !== null && hash !== 'none')))
        const successOk = successExec.filter((row) => fieldBool(row, 'ok') === true)
        const successExecFail = successExec.filter((row) => fieldBool(row, 'ok') === false)
        const successExecFailLogs = successFail.filter((row) => fieldText(row, 'stage') === 'exec')
        const successGateFail = successFail.filter((row) => fieldText(row, 'stage') === 'gate')
        const successGateOk = successGateFail.every((row) => fieldText(row, 'code') === 'check-expired')
        const completedStates = successLogs.snapshot.events.filter((row) => row.event === 'update.check.done' && fieldText(row, 'jobState') === 'completed')
        const installedAfterRows = successLogs.snapshot.events.filter((row) => row.event === 'update.status.changed' && fieldText(row, 'installedVersion') === TARGET_VERSION && row.fields['registered'] === true)
        await run.raw('success-log-counts', { successExec, successFail, successRequests, okCount: successOk.length, completedStates, installedAfterRows })
        run.record({
          step: 'D4 日志无重复成功/无第二次失败',
          what: '日志证明只发起两次安装请求（先失败后成功）：两条 update.install.request 的 intentHash 不同；exec 收场失败恰 1 条；ok=true 至多 1 条；其余 fail 只允许 gate/check-expired（#70 当场重查重提，同一次尝试）；新进程日志出现 jobState=completed 或 installedVersion=0.0.2 的成功落定事件',
          expected: 'install.request=2 且 intentHash 去重后=2；exec 收场 fail=1；ok=true≤1；gate fail 只允许 check-expired；存在 jobState=completed 的 check.done 或 installedVersion=0.0.2/registered=true 的 status.changed',
          actual: jsonText({ requestCount: successRequests.length, requestHashes: successRequestHashes, execCount: successExec.length, okCount: successOk.length, failCount: successFail.length, execFailCount: successExecFailLogs.length, gateFailCount: successGateFail.length, completedStates: completedStates.length, installedAfterCount: installedAfterRows.length }),
          verdict: successRequests.length === 2 && successRequestHashes.length === 2 && successExecFailLogs.length === 1 && successExecFail.length === 1 && successOk.length <= 1 && successGateOk && successFail.length === successExecFailLogs.length + successGateFail.length && (completedStates.length > 0 || installedAfterRows.length > 0) ? 'pass' : 'fail',
        })

        // 重启后再起一次（读日志把宿主停了），验证 UI 与磁盘。
        session = await launchDesktop('final-retry')
        await waitPanel('final-retry')
        // 开面板会自动 check；check 未收尾时 B 行是「正在查询版本信息」、B 卡片尚未加载，
        // 抢在这时截图会把「检查中」误判成不诚实（268-20261102T150837 实测）。先等 A 面板 B 行落定。
        const finalSeat = await waitForBatchSeat(requireSession(), 'a', (state) => {
          const row = rowOrNull(state, 'b')
          return row !== null && row.versionCur === TARGET_VERSION && (row.status === null || row.status.indexOf('正在') < 0)
        }, { label: '重启后 A 面板检查收尾（B 行 0.0.2）', timeoutMs: 120000, intervalMs: 1000 })
        await run.raw('panel-after-retry-settled', finalSeat)
        const finalB = rowOrNull(finalSeat, 'b')
        const finalText = await requireSession().cdp.pageText()
        let finalCardB = await readBatchSeat(requireSession(), 'b').catch(() => null)
        const finalCardDeadline = Date.now() + 120000
        while (Date.now() < finalCardDeadline && (finalCardB === null || !finalCardB.card.present)) {
          await sleep(1500)
          finalCardB = await readBatchSeat(requireSession(), 'b').catch(() => null)
        }
        const finalC = await readTargetSeat(requireSession(), 'c').catch(() => null)
        const finalDisk = await readDisk()
        await run.raw('final-success-state', { rowB: finalB, cardB: finalCardB, cardC: finalC, disk: finalDisk, pageTextTail: finalText.slice(-3000) })
        const uiHonest = finalCardB !== null && finalCardB.card.clientTag === fullTags.clientB && finalCardB.card.hostTag === fullTags.hostB
        run.record({
          step: canRed ? 'D4 can-red 成功诚实性（预期红）' : 'D4 成功后 UI',
          what: canRed
            ? 'can-red：台账与包版本都说 0.0.2，但重启后 B 卡片 buildTag 必须真是 v0.0.2（注入让包内容仍旧版 ⇒ 此断言应真红，证明它能抓住「版本号说成功、内容还是旧的」）'
            : '重启后 B 卡片显示 buildTag client/host v0.0.2，A 面板 B 行 done/current',
          expected:
            'clientTag=' + fullTags.clientB + '，hostTag=' + fullTags.hostB + (canRed ? '（注入：staleContentVersion=0.0.1，实际会是 v0.0.1 ⇒ 预期红）' : '；rowB.phase∈{done,current}'),
          actual: jsonText({ cardB: finalCardB ? finalCardB.card : null, rowB: finalB }),
          verdict: uiHonest && (canRed || (finalB !== null && (finalB.phase === 'done' || finalB.phase === 'current'))) ? 'pass' : 'fail',
          note: canRed
            ? 'can-red 注入：B@0.0.2 用 0.0.1 内容构建（staleContentVersion=0.0.1）；本条记录真实失败（run verdict=fail、exitCode=1），失败点即「台账说 0.0.2 成功、磁盘代码仍是旧版」。'
            : undefined,
        })
        run.record({
          step: 'D4 磁盘与观察者',
          what: '成功后 B 磁盘与 dependencies 都是 0.0.2，C（观察者同侪）仍 0.0.1',
          expected: 'versions[B]=0.0.2，dependencies[B]=0.0.2，C=0.0.1',
          actual: jsonText(finalDisk),
          verdict: finalDisk.versions[packageB] === TARGET_VERSION && finalDisk.dependencies[packageB] === TARGET_VERSION && finalDisk.versions[packageC] === BASE_VERSION ? 'pass' : 'fail',
        })
        await pause('final-success', {
          step: canRed ? 'D4 can-red 成功诚实性（预期红）' : 'D4 成功后 UI',
          what: canRed ? 'can-red 现场：台账说 0.0.2，B 卡片 buildTag 应为旧版（本条预期 fail）' : '重试成功后重启的 UI（B 卡片新版标记 + A 面板行）',
          expected: fullTags.clientB,
          actual: jsonText({ cardB: finalCardB ? finalCardB.card : null, rowB: finalB }),
          verdict: uiHonest ? 'pass' : 'fail',
        })
        await stopDesktop('final-retry-end')
      }
    }

    await stopProxy()
    return await finish(run, options)
  } catch (error) {
    try {
      await stopDesktop('error')
    } catch {
      // 清理失败不覆盖真实断言
    }
    await stopProxy()
    await run.raw('scenario-error', { message: messageOf(error), stack: error instanceof Error ? error.stack : null })
    run.record({
      step: '场景执行',
      what: '场景不应中途抛错（抛错时该步及后续断言记 unknown）',
      expected: '无异常',
      actual: messageOf(error),
      verdict: 'unknown',
    })
    note('场景异常：' + messageOf(error))
    return await finish(run, options)
  } finally {
    if (originalPnpmStoreDir === undefined) delete process.env['pnpm_config_store_dir']
    else process.env['pnpm_config_store_dir'] = originalPnpmStoreDir
    if (session) {
      try {
        await session.close()
      } catch {
        // 收尾失败不覆盖真实断言
      }
      session = null
    }
    if (proxy) {
      try {
        await proxy.stop()
      } catch {
        // 代理停不掉不覆盖真实断言
      }
      proxy = null
    }
  }
}

/** 收尾：写 run.json/index.md，复制证据到仓库内 runs 目录。 */
async function finish(run: T3Run, options: SettlementScenarioOptions): Promise<RunManifest> {
  const manifest = await run.close()
  try {
    await copyRunEvidence(run.layout, options.worktree)
  } catch (error) {
    console.error('[g-settlement] 复制证据失败（run 仍在仓库外）：' + messageOf(error))
  }
  return manifest
}
