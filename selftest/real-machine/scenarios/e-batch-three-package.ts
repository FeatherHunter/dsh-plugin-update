/**
 * selftest/real-machine/scenarios/e-batch-three-package.ts —— T5（#269）组 E：三包批量更新、部分失败隔离、重试/续跑。
 *
 * 四个 mode 对应三条声明（can-red 复用 upgrade 声明）：
 *   - three-package-upgrade  e-batch-three-package-upgrade：A 面板真 UI「检查更新」→ 宏「全部更新」，
 *                            A/B/C 三包都被推到 0.0.2；面板三行 / 三个台账 / 磁盘 / 重启后三卡片四处一致。
 *   - partial-failure        e-batch-partial-failure：发布三包 0.0.2 后只把 B@0.0.2 的 tarball 字节改坏
 *                            （元数据/dist.integrity 一字不动 ⇒ check 能过、install 必因 integrity 校验失败），
 *                            A/C 照常完成、B 落定 failed；无全批假成功，重启后按磁盘真相投影。
 *   - resume-retry           e-batch-resume-retry：部分失败落定 → 恢复 B tarball（sha 复原、元数据不变）
 *                            → 真 UI 点 B 行「重试」→ B 成功；A/C 不重复安装、B 恰一次成功、总账三条成功。
 *   - can-red                upgrade 的 can-red：stale-variant C（版本号新、内容旧），
 *                            「C 卡片 buildTag 真是 v0.0.2」断言应真红（run verdict=fail / exitCode=1）。
 *
 * 真机纪律（T3/T4 已踩过的坑）：
 *   - desktop-manager 装/卸夹具会 relaunch 官方桌面，旧 CDP 句柄失效 ⇒ 安装窗只轮询磁盘/台账；
 *   - 停宿主之后再 captureLogFiles（dsh-log info 行有 1000ms 防抖，进程被杀会丢尾行）；
 *   - 每 run 私有 pnpm store（pnpm_config_store_dir 指向 run 目录）：既隔离跨 run 缓存，
 *     也让「改坏 B tarball」的失败不会被全局 store 里的旧 integrity 缓存命中；
 *   - 官方桌面一次只起一个实例；每个 run 独立 DSH_HOME / --user-data-dir / 端口 + 仓库外 verdaccio。
 *
 * 证据：实际值只来自真机观测（DOM / 磁盘 / 台账 state.json / 递归日志 / registry 回包），不编。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunManifest } from '../runtime/evidence.ts'
import type { DesktopSession } from '../host/desktop-app.ts'
import { launchDesktopApp, stopDesktopByPort, stopDesktopByUserDataDir } from '../host/desktop-app.ts'
import { waitForProfileDir } from '../host/isolated-profile.ts'
import type { LogEventRecord } from '../runtime/log-evidence.ts'
import { captureLogFiles } from '../runtime/log-evidence.ts'
import type { FixtureSlotKey } from '../../fixtures/identity/fixture-slots.ts'
import { FIXTURE_BASE_VERSION, FIXTURE_VARIANT_VERSION, fixtureBuildTagsOf, fixtureSlotOf } from '../../fixtures/identity/fixture-slots.ts'
import type { ScenarioFaultInjection } from '../runtime/scenario-runner.ts'
import { publishScenarioVariants } from '../runtime/scenario-runner.ts'
import type { TarballCorruptionFault } from '../runtime/registry-faults.ts'
import { corruptPublishedTarball, restoreCorruptedTarball, tarballStoragePath } from '../runtime/registry-faults.ts'
import { directoryExists, listFilesRecursive, sha256File } from '../../tooling/fs-utils.ts'
import { sleep } from '../../tooling/process.ts'
import { captureShot } from './a-single-package-main-chain.ts'
import type { BatchDiskFacts, BatchRowState, BatchSeatState, DiskSnapshot } from './batch-helpers.ts'
import { auditInstallFails, clickSeatAction, copyRunEvidence, readBatchDiskFacts, readBatchSeat, readDiskSnapshot, readTargetSeat, rowOf, waitForBatchSeat } from './batch-helpers.ts'
import type { T3Run } from './t3-common.ts'
import { openT3Run, verifySutInstalled } from './t3-common.ts'

/** 组 E 的运行模式。 */
export type EBatchMode = 'three-package-upgrade' | 'partial-failure' | 'resume-retry' | 'can-red'

/** 组 E 场景入参（与 T3 出口场景同形，mode 决定走哪一格）。 */
export interface EBatchScenarioOptions {
  /** 试错 run 传 false：不把 run.json/index.md/raw/shots 复制进仓库证据目录（定稿 run 才入库）。默认 true。 */
  syncEvidence?: boolean
  readonly worktree: string
  readonly runBaseDir: string
  readonly verdaccioInstallDir: string
  readonly esbuildPath: string
  readonly stamp?: string
  readonly maintainerHome?: string
  readonly mode: EBatchMode
}

/** mode → 场景声明 id（can-red 复用 upgrade 声明，用 run note/raw 标记 stale 注入）。 */
const MODE_SCENARIO: Record<EBatchMode, string> = {
  'three-package-upgrade': 'e-batch-three-package-upgrade',
  'partial-failure': 'e-batch-partial-failure',
  'resume-retry': 'e-batch-resume-retry',
  'can-red': 'e-batch-three-package-upgrade',
}

const PROFILE_NAME = 'desktop'
const BASE_VERSION = FIXTURE_BASE_VERSION
const TARGET_VERSION = FIXTURE_VARIANT_VERSION
const SUCCESS_STATES: readonly string[] = ['completed', 'restart-required']
const FAILED_STATES: readonly string[] = ['failed']
/** 安装成功/失败会触发宿主自重启：安装窗超时给足 5 分钟（三包串行 + 每次重启）。 */
const BATCH_SETTLE_TIMEOUT_MS = 300000
/** 停宿主前的静置：给 dsh-log 防抖行与台账收尾落盘。 */
const SETTLE_IDLE_MS = 3000

/** 一条台账 state.json 的原始事实。 */
interface LedgerEntry {
  readonly file: string
  readonly state: Record<string, unknown>
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

function jsonText(value: unknown, limit = 1800): string {
  let text = ''
  try {
    text = JSON.stringify(value)
  } catch {
    text = String(value)
  }
  return text.length > limit ? text.slice(0, limit) + '…' : text
}

/** 递归读 <home>/updates 下全部 state.json（失败记 corrupt；与 T3 d 场景同口径）。 */
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

function ledgerMessageOf(entries: readonly LedgerEntry[]): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = textOf(entries[index]!.state['message'])
    if (message) return message
  }
  return ''
}

/** 按命名空间（= 目标插件标识）过滤日志事件。 */
function namespaceEvents(events: readonly LogEventRecord[], pluginId: string, name: string): LogEventRecord[] {
  return events.filter((row) => row.event === name && row.source.startsWith(pluginId + '/'))
}

/** 等台账达到期望状态（只读磁盘；返回观测到的状态序列）。 */
async function waitForLedgerState(options: {
  readonly homeDir: string
  readonly pluginId: string
  readonly wanted: readonly string[]
  readonly timeoutMs: number
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

/** 读一行失败态（行不存在返回 null，不抛）。 */
function rowOrNull(seat: BatchSeatState | null, key: string): BatchRowState | null {
  return seat ? rowOf(seat, key) : null
}

/** 页面文本里有没有「正在安装」这类在飞宣称（重启后不许出现）。 */
function claimsInstallRunning(text: string): boolean {
  return text.indexOf('正在安装') >= 0
}

/**
 * 重启后批量行的诚实口径（#152 既有产品语义，tests/issue-152-check-reconcile.test.mjs:38-66）：
 * 面板打开时的自动检查把「昨日失败」按磁盘真相重算成可装行（包被管理器移除后即「未安装/可装 0.0.2」）。
 * 这里不要求行仍写 failed，只要求它不谎称在飞/成功/已是最新，也不宣称目标版已装；
 * 失败事实的权威在台账 state.json。
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return recordOf(value)
}

/** batch.json 的 entries[].key（A 的批量会话行键）。 */
function entryKeysOf(value: unknown): string[] {
  const record = asRecord(value)
  const entries = record ? record['entries'] : null
  if (!Array.isArray(entries)) return []
  return entries.map((entry) => textOf(asRecord(entry) ? (asRecord(entry) as Record<string, unknown>)['key'] : null) ?? '').filter((key) => key !== '')
}

/** inventory.json 的 entries 对象键。 */
function inventoryKeysOf(value: unknown): string[] {
  const record = asRecord(value)
  const entries = asRecord(record ? record['entries'] : null)
  return entries ? Object.keys(entries).sort() : []
}

function sameKeySet(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false
  const left = actual.slice().sort()
  const right = expected.slice().sort()
  return left.every((value, index) => value === right[index])
}

/** 读一个已发布 tarball 的 sha256（registry storage 直读；读不到返回 null）。 */
async function publishedTarballSha(registry: Parameters<typeof tarballStoragePath>[0], packageName: string, version: string): Promise<string | null> {
  try {
    return await sha256File(tarballStoragePath(registry, packageName, version))
  } catch {
    return null
  }
}

/** 递归日志事件 → batch-helpers 的事件事实（namespace = 日志 source 的第一段）。 */
function logEventFacts(events: readonly LogEventRecord[]): { namespace: string; event: string; level: string; fields: Record<string, unknown> }[] {
  return events.map((row) => ({ namespace: row.source.split('/')[0] ?? '', event: row.event, level: row.level ?? '', fields: row.fields }))
}

/** 日志里的安装计数（按插件命名空间分组；供「A/C 不重复安装」「B 恰一次成功」对比用）。 */
interface InstallLogCounts {
  readonly requests: number
  readonly execs: number
  readonly execFails: number
  readonly execOks: number
}

function installLogCounts(events: readonly LogEventRecord[], pluginId: string): InstallLogCounts {
  const requests = namespaceEvents(events, pluginId, 'update.install.request')
  const execs = namespaceEvents(events, pluginId, 'update.install.exec')
  const execFails = execs.filter((row) => row.fields['ok'] === false)
  const execOks = execs.filter((row) => row.fields['ok'] === true)
  return { requests: requests.length, execs: execs.length, execFails: execFails.length, execOks: execOks.length }
}

/** 跑一格组 E 场景，返回 run manifest（run.json 已落盘并复制进仓库内 runs/<runId>）。 */
export async function runEBatchScenario(options: EBatchScenarioOptions): Promise<RunManifest> {
  const canRed = options.mode === 'can-red'
  const partialMode = options.mode === 'partial-failure' || options.mode === 'resume-retry'
  const scenarioId = MODE_SCENARIO[options.mode]
  const run = await openT3Run({
    worktree: options.worktree,
    runBaseDir: options.runBaseDir,
    verdaccioInstallDir: options.verdaccioInstallDir,
    esbuildPath: options.esbuildPath,
    scenarioId,
    hostChannel: 'desktop-official',
    stamp: options.stamp,
    maintainerHome: options.maintainerHome,
    ticket: '269',
  })
  const fixtureEnv = run.fixtureEnv
  if (!fixtureEnv) {
    await run.raw('scenario-error', { message: '组 E 场景必须带夹具环境' })
    run.record({ step: '场景前提', what: '夹具环境可用', expected: 'openT3Run 返回 fixtureEnv', actual: 'null', verdict: 'unknown' })
    return await run.close()
  }

  // 每 run 私有 pnpm store：跨 run 隔离 + 让「改坏 B tarball」不会被全局 store 里同 integrity 的缓存命中。
  // 必须从 bootstrap/CLI 基版安装起生效（profile 的 node_modules 与后续管理器安装必须同一个 store，
  // 否则 ERR_PNPM_UNEXPECTED_STORE；T4 can-red 已实测）。
  const originalPnpmStoreDir = process.env['pnpm_config_store_dir']
  process.env['pnpm_config_store_dir'] = join(run.layout.root, 'pnpm-store')
  await run.raw('pnpm-store-isolation', {
    storeDir: process.env['pnpm_config_store_dir'],
    inheritedFromBeforeBootstrap: false,
    reason: '组 E 每 run 私有 pnpm store：跨 run 隔离，且改坏 tarball 的 integrity 失败不会被全局 store 缓存命中',
  })
  run.addNote('每 run 私有 pnpm store：' + String(process.env['pnpm_config_store_dir']) + '（从 bootstrap/CLI 基版安装起生效）')

  const homeDir = run.layout.homeDir
  const userDataDir = run.layout.userDataDir
  const registryUrl = fixtureEnv.registry.baseUrl
  const slotA = fixtureSlotOf('a')
  const slotB = fixtureSlotOf('b')
  const slotC = fixtureSlotOf('c')
  const packageA = slotA.packageName
  const packageB = slotB.packageName
  const packageC = slotC.packageName
  const packageNames = [packageA, packageB, packageC]
  const scenario = run.scenario
  // 台账/队列里的 pluginId 是「更新方宿主里的目标电话前缀」（A 的批量目标 fxa-a/fxa-b/fxa-c），不是包名。
  const targetPrefixOf = (key: FixtureSlotKey): string => {
    const target = slotA.batch ? slotA.batch.targets.find((candidate) => candidate.key === key) : null
    if (!target) throw new Error('A 的批量目标里没有 ' + key)
    return target.prefix
  }
  const pluginA = targetPrefixOf('a')
  const pluginB = targetPrefixOf('b')
  const pluginC = targetPrefixOf('c')
  const expectedKeys = ['a', 'b', 'c']
  const fullTags = (key: FixtureSlotKey): { clientTag: string; hostTag: string } => {
    const variant = scenario.variants.find((candidate) => candidate.slotKey === key)
    const effect = variant ? variant.effect : null
    const tags = fixtureBuildTagsOf(fixtureSlotOf(key), TARGET_VERSION, effect ?? undefined)
    return { clientTag: tags.clientTag, hostTag: tags.hostTag }
  }
  const tagsA = fullTags('a')
  const tagsB = fullTags('b')
  const tagsC = fullTags('c')
  const baselineTags = (key: FixtureSlotKey): { clientTag: string; hostTag: string } => {
    const step = scenario.install.find((candidate) => candidate.slotKey === key)
    const tags = fixtureBuildTagsOf(fixtureSlotOf(key), BASE_VERSION, step ? step.effect : undefined)
    return { clientTag: tags.clientTag, hostTag: tags.hostTag }
  }

  let session: DesktopSession | null = null
  let corruption: TarballCorruptionFault | null = null
  const notes: string[] = []
  const note = (text: string): void => {
    notes.push(text)
    run.addNote(text)
  }
  const requireSession = (): DesktopSession => {
    if (!session) throw new Error('桌面会话不存在（此步需要真 UI 观测）')
    return session
  }

  /**
   * 停止当前桌面：先关 CDP 会话，再按端口清自重启实例、按 user-data-dir 兜底。
   * 宿主重载后的新实例可能「旧进程已退、新进程还没起来/还没监听端口」，单次扫描会漏杀，
   * 于是下一次 launch 会和它抢同一 user-data-dir（单实例锁）——这里改成短窗轮询：
   * 连续两轮扫不到实例才算停干净（最多约 12 秒）。
   */
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
    let emptyRounds = 0
    for (let round = 1; round <= 8; round += 1) {
      let roundKilled: number[] = []
      try {
        roundKilled = roundKilled.concat(await stopDesktopByPort(port))
      } catch (error) {
        note('按端口清理桌面实例失败（' + tag + '）：' + messageOf(error))
      }
      try {
        roundKilled = roundKilled.concat(await stopDesktopByUserDataDir(userDataDir))
      } catch (error) {
        note('按 user-data-dir 清理桌面实例失败（' + tag + '）：' + messageOf(error))
      }
      for (const pid of roundKilled) killed.push(pid)
      if (roundKilled.length === 0) {
        emptyRounds += 1
        if (emptyRounds >= 2) break
      } else {
        emptyRounds = 0
      }
      await sleep(1500)
    }
    for (const pid of killed) run.registerProcess('desktop-relaunched-' + tag, pid)
    await run.raw('desktop-stop-' + tag, { port, killedPids: killed, userDataDir })
    await sleep(500)
    return killed
  }

  /**
   * 起一个托管官方桌面实例（自重启清场 + 最多 3 次重试；每次终止过程登记 pid）。
   * 每次成功 launch 后先等页面真能读（document.body 有内容）：宿主重载留下的旧实例可能还占着
   * user-data-dir，新进程会连上 CDP 却随即被单实例锁顶掉——不等页面可读就返回，后面的断言会全记 null。
   * 失败重试前先按 user-data-dir 清场，避免新实例一直和残留实例抢锁。
   */
  const launchDesktop = async (tag: string): Promise<DesktopSession> => {
    let lastError: unknown = null
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        if (attempt > 1) {
          try {
            const stale = await stopDesktopByUserDataDir(userDataDir)
            for (const pid of stale) run.registerProcess('desktop-stale-' + tag, pid)
          } catch (error) {
            note('重试前清理残留桌面实例失败（' + tag + '）：' + messageOf(error))
          }
          await sleep(1000)
        }
        const opened = await launchDesktopApp({ homeDir, userDataDir, extraEnv: { DSH_SELFTEST_REGISTRY: registryUrl } })
        session = opened
        const pid = opened.process.pid()
        if (typeof pid === 'number') run.registerProcess('desktop-' + tag + (attempt > 1 ? '-attempt' + String(attempt) : ''), pid)
        await opened.cdp.waitForExpression('document.body && document.body.innerText.length > 100', { timeoutMs: 90000, label: '桌面页面可读（' + tag + '）' })
        return opened
      } catch (error) {
        lastError = error
        try {
          if (session) await session.close()
        } catch {
          // 清理失败不覆盖真实原因
        }
        session = null
        await sleep(2000)
      }
    }
    throw lastError instanceof Error ? lastError : new Error('起桌面失败：' + messageOf(lastError))
  }

  /** 截图（失败只记 note，不覆盖真实断言）。 */
  const pause = async (meta: { step: string; what: string; expected: string; actual: string; verdict: 'pass' | 'fail' | 'known-red' | 'unknown'; note?: string }): Promise<void> => {
    if (!session) return
    try {
      await captureShot(run.recorder, session, meta)
    } catch (error) {
      note('截图失败（' + meta.step + '）：' + messageOf(error))
    }
  }

  /** 日志 raw 截断要在 run.json 留下「原始多大、截断到多少」。 */
  const noteLogTruncations = (tag: string, capture: { truncations: readonly { source: string; bytes: number; characters: number; keptCharacters: number; tailFile: string }[] }): void => {
    for (const truncated of capture.truncations) {
      note(tag + ' raw 日志截断：' + truncated.source + ' 原始 ' + String(truncated.bytes) + ' 字节 / ' + String(truncated.characters) + ' 字符，保留前 ' + String(truncated.keptCharacters) + ' 字符；尾段见 ' + truncated.tailFile)
    }
  }

  const readDisk = async (): Promise<DiskSnapshot> => readDiskSnapshot({ homeDir, profileName: PROFILE_NAME, packageNames })

  /**
   * 基版安装对隔离 registry 的上游瞬态做有界重试（harness 侧网络抖动，不是被测行为）。
   * 2026-11-02 两次 unknown（269-20261102T212948 / 269-20261102T215839）都是 verdaccio
   * uplink 拉 dsh-log 先 503、pnpm 自己重试约 60s 后落 404；命令本身幂等，同一个
   * pnpm add 重跑会重新解析并补齐缺失依赖。最多 3 次、间隔 5s/15s，每次失败留 raw，
   * 让证据里看得见抖动来源，而不是静默吞掉。
   */
  const installBaselineResilient = async (): Promise<void> => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await run.installBaseline({ homeDir, profileName: PROFILE_NAME, registryUrl })
        if (attempt > 1) note('基版安装第 ' + String(attempt) + ' 次成功（前 ' + String(attempt - 1) + ' 次为 registry 上游瞬态）')
        return
      } catch (error) {
        const text = messageOf(error)
        const transient = /ERR_PNPM_FETCH_(404|50\d)|dsh-log|ECONNRESET|ETIMEDOUT/i.test(text)
        if (attempt >= 3 || !transient) throw error
        const delayMs = attempt === 1 ? 5000 : 15000
        note('基版安装第 ' + String(attempt) + ' 次遇到 registry 上游瞬态，' + String(delayMs / 1000) + 's 后重试：' + text.slice(0, 300))
        await run.raw('baseline-install-retry-' + String(attempt), { attempt, transient: true, delayMs, message: text.slice(0, 4000) })
        await sleep(delayMs)
      }
    }
  }

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

  /** 点击宏按钮前等它可点（inFlight disabled 时 DOM click 会被吞）。 */
  const waitMacroEnabled = async (act: 'check' | 'install', tag: string): Promise<void> => {
    await waitForBatchSeat(
      requireSession(),
      'a',
      (state) => (act === 'check' ? state.panel.check !== null && state.panel.check.disabled === false : state.panel.install !== null && state.panel.install.disabled === false),
      { label: 'A 面板宏按钮可点（' + act + '，' + tag + '）', timeoutMs: 120000, intervalMs: 500 },
    )
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

  /** 等台账走到成功终态（成功后 background verify 收尾；不等就停宿主会被 healJob 判 interrupted）。 */
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

  /** 三包全成窗：只轮询磁盘到三个包都是目标版（安装窗内 CDP 会失效）。 */
  const settleAllInstalled = async (): Promise<{ reached: boolean; disk: DiskSnapshot | null; observed: string[] }> => {
    const observed: string[] = []
    const deadline = Date.now() + BATCH_SETTLE_TIMEOUT_MS
    let last: DiskSnapshot | null = null
    while (Date.now() < deadline) {
      last = await readDisk()
      const snapshot = packageNames.map((name) => name.replace('dsh-plugin-update-fixture-', '') + '=' + String(last!.versions[name])).join(',')
      if (observed[observed.length - 1] !== snapshot) observed.push(snapshot)
      if (packageNames.every((name) => last!.versions[name] === TARGET_VERSION)) return { reached: true, disk: last, observed }
      await sleep(1500)
    }
    return { reached: false, disk: last, observed }
  }

  /**
   * 部分失败窗：只轮询磁盘+台账，等到「A/C 到目标版」且「B 失败落定」。
   * 返回观测序列；失败行必须来自台账（state.json），不能只看 UI（面板可能已随宿主重启换掉）。
   */
  const settlePartialFailure = async (): Promise<{ disk: DiskSnapshot | null; ledgerB: LedgerEntry[]; observed: string[]; aOk: boolean; cOk: boolean; bFailed: boolean }> => {
    const observed: string[] = []
    const deadline = Date.now() + BATCH_SETTLE_TIMEOUT_MS
    let last: DiskSnapshot | null = null
    let ledgerB: LedgerEntry[] = []
    while (Date.now() < deadline) {
      last = await readDisk()
      ledgerB = ledgerOf(await readLedgerStates(homeDir), pluginB)
      const bFailed = ledgerB.length === 1 && FAILED_STATES.indexOf(ledgerStateOf(ledgerB[0]!)) >= 0
      const aOk = last.versions[packageA] === TARGET_VERSION
      const cOk = last.versions[packageC] === TARGET_VERSION
      const snapshot = 'a=' + String(last.versions[packageA]) + ',b=' + String(last.versions[packageB]) + ',c=' + String(last.versions[packageC]) + ',bLedger=' + String(ledgerB.length > 0 ? ledgerStateOf(ledgerB[0]!) : 'missing')
      if (observed[observed.length - 1] !== snapshot) observed.push(snapshot)
      if (aOk && cOk && bFailed) return { disk: last, ledgerB, observed, aOk, cOk, bFailed }
      await sleep(1500)
    }
    return {
      disk: last,
      ledgerB,
      observed,
      aOk: last ? last.versions[packageA] === TARGET_VERSION : false,
      cOk: last ? last.versions[packageC] === TARGET_VERSION : false,
      bFailed: ledgerB.length === 1 && FAILED_STATES.indexOf(ledgerStateOf(ledgerB[0]!)) >= 0,
    }
  }

  try {
    // ---- 0. 地基：首启建 profile → CLI 装三包基版 → SUT 钉住核对 → 起托管实例看基版 UI ----
    session = await launchDesktop('bootstrap')
    await waitForProfileDir({ homeDir, profileName: PROFILE_NAME, timeoutMs: 120000 })
    await requireSession().cdp.waitForExpression('document.body && document.body.innerText.length > 100', {
      timeoutMs: 120000,
      label: '官方桌面首启界面出现',
    })
    await run.raw('desktop-first-launch', { port: requireSession().port, pageText: (await requireSession().cdp.pageText()).slice(0, 3000) })
    await stopDesktop('bootstrap')

    await installBaselineResilient()
    await verifySutInstalled(run, { homeDir, profileName: PROFILE_NAME, packageName: packageA })

    session = await launchDesktop('main')
    const initialSeat = await waitPanel('initial')
    const initialDisk = await readDisk()
    const initialC = await readTargetSeat(requireSession(), 'c').catch(() => null)
    const initialTagA = baselineTags('a')
    const initialTagB = baselineTags('b')
    run.record({
      step: '基版 UI（三包 0.0.1）',
      what: 'A 批量面板列出 a/b/c 三行；A/B 卡片与 C 徽标都是 0.0.1（干净 profile 的起点）',
      expected: 'rows=a,b,c；A/B clientTag=' + initialTagA.clientTag + '/' + initialTagB.clientTag + '；C 徽标 client v' + BASE_VERSION,
      actual: jsonText({ rows: initialSeat.panel.rows.map((row) => row.key).join(','), cardA: initialSeat.card.clientTag, cardB: (await readBatchSeat(requireSession(), 'b').catch(() => null))?.card.clientTag ?? null, cardC: initialC ? initialC.clientTag : null, disk: initialDisk.versions }),
      verdict:
        initialSeat.panel.rows.length === 3 && initialSeat.panel.rows.map((row) => row.key).join(',') === 'a,b,c' && initialSeat.card.clientTag === initialTagA.clientTag && (initialC === null || initialC.clientTag === 'client v' + BASE_VERSION)
          ? 'pass'
          : 'fail',
    })
    await pause({
      step: '基版 UI（三包 0.0.1）',
      what: '三包批量场景的初始形态：A 面板三行、A/B 卡片、C 纯目标卡片',
      expected: '三行 + 三卡片都在页面上，版本 0.0.1',
      actual: 'rows=' + initialSeat.panel.rows.map((row) => row.key).join(',') + '；A=' + String(initialSeat.card.clientTag) + '；C=' + String(initialC ? initialC.clientTag : null),
      verdict: initialSeat.panel.rows.length === 3 ? 'pass' : 'fail',
    })

    // ---- 1. 发布三包 0.0.2 变体（can-red 用 stale-variant C；partial/resume 发布后改坏 B tarball 字节） ----
    const baseline = await run.publishBaseline()
    const faultInjection: ScenarioFaultInjection | undefined = canRed
      ? { kind: 'stale-variant', slotKey: 'c', description: 'can-red：C@0.0.2 用 0.0.1 内容构建（版本号新、内容旧），成功诚实性断言应真红' }
      : undefined
    const publication = await publishScenarioVariants(scenario, fixtureEnv, faultInjection, baseline)
    const variantShas: Record<string, string | null> = {}
    const baselineShas: Record<string, string | null> = {}
    for (const key of ['a', 'b', 'c'] as FixtureSlotKey[]) {
      const slot = fixtureSlotOf(key)
      variantShas[key] = await publishedTarballSha(fixtureEnv.registry, slot.packageName, TARGET_VERSION)
      baselineShas[key] = await publishedTarballSha(fixtureEnv.registry, slot.packageName, BASE_VERSION)
    }
    await run.raw('fixture-published-variants', {
      scenario: scenario.id,
      injected: publication.injected,
      variants: Object.keys(publication.variants).map((key) => ({ slotKey: key, spec: (publication.variants as Record<string, { plan: { packageName: string; version: string } }>)[key]?.plan })),
      variantShas,
      baselineShas,
    })
    run.record({
      step: '三包 0.0.2 变体发布',
      what: 'A/B/C 三个夹具的 0.0.2 变体都发到 run 私有 registry，tarball 字节与 0.0.1 基版不同（内容真变，不是只改版本号）' + (canRed ? '；can-red 注入 stale-variant C（版本号新、内容旧）' : ''),
      expected: 'A/B/C 三个 0.0.2 tarball 都可读且 sha256 与各自 0.0.1 不同；无注入时 variants 三席齐全' + (canRed ? '（can-red 注入：C 内容旧）' : ''),
      actual: jsonText({ variantShas, baselineShas, injected: publication.injected }),
      verdict:
        Object.keys(publication.variants).length === 3 && (['a', 'b', 'c'] as FixtureSlotKey[]).every((key) => variantShas[key] !== null && variantShas[key] !== baselineShas[key]) ? 'pass' : 'fail',
    })

    if (partialMode) {
      corruption = await corruptPublishedTarball({
        registry: fixtureEnv.registry,
        backupDir: join(run.layout.root, 'registry-tarball-backup'),
        packageName: packageB,
        version: TARGET_VERSION,
      })
      await run.raw('registry-tarball-corrupted', corruption)
      run.record({
        step: '故障注入：改坏 B@0.0.2 tarball 字节',
        what: '元数据/versionDoc/dist.integrity 一字不动，只把已发布 tarball 的中点 64 字节翻位 ⇒ 候选门能过（check 照常显示 0.0.2）、pnpm 下载时 integrity 校验必失败（200 + 字节坏，不是 404）',
        expected: 'servedBeforeStatus=200；servedAfterStatus=200；tarball 大小不变；sha256 变了；versionDocUnchanged=true；dist.integrity 仍在元数据原文里',
        actual: jsonText({ servedBefore: corruption.servedBeforeStatus, servedAfterStatus: corruption.servedAfterStatus, sizeBytes: corruption.sizeBytes, sha256Before: corruption.sha256Before, sha256After: corruption.sha256After, corruptedOffset: corruption.corruptedOffset, corruptedLength: corruption.corruptedLength, versionDocUnchanged: corruption.versionDocUnchanged }),
        verdict:
          corruption.servedBeforeStatus === 200 && corruption.servedAfterStatus === 200 && corruption.sha256Before !== corruption.sha256After && corruption.versionDocUnchanged ? 'pass' : 'fail',
      })
      note('部分失败注入：B@0.0.2 tarball 字节改坏（sha256 ' + corruption.sha256Before.slice(0, 16) + '… → ' + corruption.sha256After.slice(0, 16) + '…，元数据/版本文档不变）')
    }

    // ---- 2. 真 UI：A 面板「检查更新」→ 三行都列出 0.0.2 ----
    await waitMacroEnabled('check', 'before-check')
    await clickSeatAction(requireSession(), 'a', 'check')
    const checkedSeat = await waitForBatchSeat(
      requireSession(),
      'a',
      (state) => state.panel.rows.length >= 3 && state.panel.rows.every((row) => row.versionNew === TARGET_VERSION),
      { label: 'A 面板检查更新列出三行 0.0.2', timeoutMs: 180000, intervalMs: 1000 },
    )
    await run.raw('a-check-complete', checkedSeat)
    run.record({
      step: '真 UI 检查更新（三行都可更新 0.0.2）',
      what: 'A 面板点「检查更新」后，a/b/c 三行的当前版本=0.0.1、新版本=0.0.2' + (partialMode ? '；B 的 tarball 虽被改坏，检查只读元数据，所以仍然列出 0.0.2（候选门能过）' : ''),
      expected: 'rows=a,b,c 且每行 versionCur=0.0.1、versionNew=0.0.2',
      actual: jsonText(checkedSeat.panel.rows.map((row) => ({ key: row.key, cur: row.versionCur, next: row.versionNew, phase: row.phase }))),
      verdict: checkedSeat.panel.rows.length === 3 && checkedSeat.panel.rows.every((row) => row.versionCur === BASE_VERSION && row.versionNew === TARGET_VERSION) ? 'pass' : 'fail',
    })
    await pause({
      step: '真 UI 检查更新（三行都可更新 0.0.2）',
      what: 'A 批量面板三行：当前 0.0.1、可更新 0.0.2',
      expected: '三行都显示 0.0.1 → 0.0.2',
      actual: checkedSeat.panel.rows.map((row) => row.key + ':' + String(row.versionCur) + '->' + String(row.versionNew)).join(' | '),
      verdict: checkedSeat.panel.rows.length === 3 ? 'pass' : 'fail',
    })

    // ---- 3. 真 UI 宏「全部更新」：安装窗内只轮询磁盘/台账（宿主会自重启，CDP 会失效） ----
    await waitMacroEnabled('install', 'before-install')
    await clickSeatAction(requireSession(), 'a', 'install')
    note('真 UI 点 A 面板宏「全部更新」；安装窗只轮询磁盘/台账（三包串行安装，每次成功会触发宿主自重启，旧 CDP 失效）')
    const settledAll = partialMode ? null : await settleAllInstalled()
    const settledPartial = partialMode ? await settlePartialFailure() : null
    await run.raw('batch-settled', {
      mode: options.mode,
      all: settledAll,
      partial: settledPartial,
      corruptionSha: corruption ? corruption.sha256After : null,
    })
    const settledDisk = settledAll ? settledAll.disk : settledPartial ? settledPartial.disk : null
    if (!settledDisk) {
      await run.raw('batch-settled-disk-missing', { message: '轮询窗口结束时没有拿到磁盘快照' })
      run.record({ step: '批量安装落盘', what: '三包宏批量安装后磁盘可读', expected: 'readDiskSnapshot 返回三包版本', actual: 'null', verdict: 'unknown' })
    }

    if (!partialMode) {
      // ---- 3a. 三包全成：磁盘三处到 0.0.2 ----
      const disk = settledDisk as DiskSnapshot
      run.record({
        step: '宏批量更新落盘（三包都到 0.0.2）',
        what: '真 UI 宏「全部更新」后，磁盘上 A/B/C 的已装版本都变成 0.0.2（不是只改台账）',
        expected: 'versions[a]=versions[b]=versions[c]=0.0.2；dependencies 三包=0.0.2',
        actual: jsonText({ versions: disk.versions, dependencies: disk.dependencies, observed: settledAll ? settledAll.observed.slice(-6) : [] }),
        verdict:
          disk.versions[packageA] === TARGET_VERSION && disk.versions[packageB] === TARGET_VERSION && disk.versions[packageC] === TARGET_VERSION &&
          String(disk.dependencies[packageA] || '') === TARGET_VERSION && String(disk.dependencies[packageB] || '') === TARGET_VERSION && String(disk.dependencies[packageC] || '') === TARGET_VERSION
            ? 'pass'
            : 'fail',
      })
      // 台账要等每行走到终态再读：最后一个包装完后 background verify 才把 restart-required 收成 completed，
      // 早读会把「正在收尾」误判成丢行（partial 试错 run 210134 的 #29 就是这么红的）。超时仍返回最后观测，断言照实判。
      const ledgerA = await waitLedgerTerminal(pluginA, 90000)
      const ledgerB = await waitLedgerTerminal(pluginB, 90000)
      const ledgerC = await waitLedgerTerminal(pluginC, 90000)
      await run.raw('ledger-after-batch', { ledgerA, ledgerB, ledgerC })
      const successOf = (entries: readonly LedgerEntry[]): LedgerEntry[] => entries.filter((entry) => SUCCESS_STATES.indexOf(ledgerStateOf(entry)) >= 0)
      const ledgerOk =
        ledgerA.length === 1 && ledgerB.length === 1 && ledgerC.length === 1 &&
        successOf(ledgerA).length === 1 && successOf(ledgerB).length === 1 && successOf(ledgerC).length === 1 &&
        [ledgerA, ledgerB, ledgerC].every((entries) => textOf(entries[0]!.state['targetVersion']) === TARGET_VERSION) &&
        [ledgerA, ledgerB, ledgerC].every((entries) => textOf(entries[0]!.state['previousVersion']) === BASE_VERSION)
      run.record({
        step: '台账逐行真相（三包各一条成功终态）',
        what: '三个插件（fxa-a/fxa-b/fxa-c）各恰一条 state.json，state∈{completed,restart-required}、targetVersion=0.0.2、previousVersion=0.0.1；总成功条数=3（无丢行/无重复）',
        expected: '每插件 1 条；成功终态各 1；target=0.0.2；previous=0.0.1',
        actual: jsonText({ ledgerA: ledgerA.map((entry) => ({ state: ledgerStateOf(entry), target: entry.state['targetVersion'], previous: entry.state['previousVersion'] })), ledgerB: ledgerB.map((entry) => ({ state: ledgerStateOf(entry), target: entry.state['targetVersion'], previous: entry.state['previousVersion'] })), ledgerC: ledgerC.map((entry) => ({ state: ledgerStateOf(entry), target: entry.state['targetVersion'], previous: entry.state['previousVersion'] })) }),
        verdict: ledgerOk ? 'pass' : 'fail',
      })
    } else {
      // ---- 3b. 部分失败隔离：A/C 完成、B 失败且不拖垮好行 ----
      const partial = settledPartial as { disk: DiskSnapshot; ledgerB: LedgerEntry[]; observed: string[]; aOk: boolean; cOk: boolean; bFailed: boolean }
      run.record({
        step: '部分失败隔离：坏行失败、好行完成',
        what: 'B@0.0.2 tarball 被改坏后，宏批量没有「全批失败」也没有「全批假成功」：A/C 照常到 0.0.2，B 未到 0.0.2 且台账落定 failed',
        expected: 'versions[a]=0.0.2；versions[c]=0.0.2；versions[b]≠0.0.2；B 台账 state=failed',
        actual: jsonText({ versions: partial.disk.versions, dependencies: partial.disk.dependencies, ledgerB: partial.ledgerB.map((entry) => ({ state: ledgerStateOf(entry), target: entry.state['targetVersion'], message: ledgerMessageOf([entry]).slice(0, 300) })), observed: partial.observed.slice(-8) }),
        verdict: partial.aOk && partial.cOk && !partial.bFailed === false && partial.bFailed && partial.disk.versions[packageB] !== TARGET_VERSION ? 'pass' : 'fail',
      })
      const failureCode = (() => {
        const message = ledgerMessageOf(partial.ledgerB).trim()
        const matched = /^([a-z][a-z0-9-]*)/.exec(message)
        return matched ? matched[1]! : null
      })()
      run.record({
        step: '坏行台账真相：B 恰一条失败、失败码 install-failed',
        what: 'B 的台账恰一条 state.json，state=failed、targetVersion=0.0.2，message 以 install-failed 开头（bad tarball 是执行失败，不是检查失败）',
        expected: 'fxa-b 台账条数=1；state=failed；target=0.0.2；失败码=install-failed',
        actual: jsonText({ count: partial.ledgerB.length, states: partial.ledgerB.map(ledgerStateOf), target: partial.ledgerB.length > 0 ? partial.ledgerB[0]!.state['targetVersion'] : null, failureCode, message: ledgerMessageOf(partial.ledgerB).slice(0, 400) }),
        verdict: partial.ledgerB.length === 1 && ledgerStateOf(partial.ledgerB[0]!) === 'failed' && textOf(partial.ledgerB[0]!.state['targetVersion']) === TARGET_VERSION && failureCode === 'install-failed' ? 'pass' : 'fail',
      })
      // 好行的收尾同样要等终态（见 ledger-after-batch 注释），否则会误读成 installing。
      const ledgerA = await waitLedgerTerminal(pluginA, 90000)
      const ledgerC = await waitLedgerTerminal(pluginC, 90000)
      await run.raw('ledger-partial-failure', { ledgerA, ledgerB: partial.ledgerB, ledgerC })
      run.record({
        step: '好行台账不受坏行影响（A/C 各一条成功）',
        what: '同一个批量会话里，A/C 的台账各恰一条成功终态（target=0.0.2），没有因为 B 失败而丢行或被标失败',
        expected: 'fxa-a/fxa-c 各 1 条成功终态；target=0.0.2',
        actual: jsonText({ ledgerA: ledgerA.map(ledgerStateOf), ledgerC: ledgerC.map(ledgerStateOf), targetA: ledgerA.length > 0 ? ledgerA[0]!.state['targetVersion'] : null, targetC: ledgerC.length > 0 ? ledgerC[0]!.state['targetVersion'] : null }),
        verdict:
          ledgerA.length === 1 && ledgerC.length === 1 && SUCCESS_STATES.indexOf(ledgerStateOf(ledgerA[0]!)) >= 0 && SUCCESS_STATES.indexOf(ledgerStateOf(ledgerC[0]!)) >= 0 &&
          textOf(ledgerA[0]!.state['targetVersion']) === TARGET_VERSION && textOf(ledgerC[0]!.state['targetVersion']) === TARGET_VERSION
            ? 'pass'
            : 'fail',
      })
      // 静置：给 dsh-log 防抖行落盘，同时让「B 没有第二次自动尝试」由日志计数证明。
      await sleep(SETTLE_IDLE_MS)
      await stopDesktop('after-batch-failure')
      const failureLogs = await captureLogFiles(run.recorder, homeDir)
      noteLogTruncations('部分失败后日志', failureLogs)
      const failureEvents = failureLogs.snapshot.events
      const countsB = installLogCounts(failureEvents, pluginB)
      const countsA = installLogCounts(failureEvents, pluginA)
      const countsC = installLogCounts(failureEvents, pluginC)
      const bExecFails = namespaceEvents(failureEvents, pluginB, 'update.install.exec').filter((row) => row.fields['ok'] === false)
      const bFails = namespaceEvents(failureEvents, pluginB, 'update.install.fail')
      const bExecStageFails = bFails.filter((row) => row.fields['stage'] === 'exec')
      const installAudit = auditInstallFails(logEventFacts(failureEvents))
      await run.raw('failure-log-counts', { countsA, countsB, countsC, bExecFails, bFails, installAudit })
      run.record({
        step: '失败日志：B 恰一次执行失败、无自动重试、A/C 无执行失败',
        what: '递归日志里 B 只有一次 update.install.exec（ok=false，非零退出）、一条 stage=exec 的 install.fail；静置后 exec/fail 计数不增（已失败不自动重试）；A/C 没有任何 exec 失败',
        expected: 'B exec 次数=1 且 ok=false 恰 1、stage=exec 的 fail=1；A/C exec 失败=0；非 check-expired 的 fail 恰 1（就是这个坏 tarball 的真实执行失败）且它没有被自动重试（unretried=1）；其余设计内 check-expired 拒绝都当场 retry',
        actual: jsonText({ countsA, countsB, countsC, bExecFail: bExecFails.map((row) => ({ ok: row.fields['ok'], exitCode: row.fields['exitCode'], durationMs: row.fields['durationMs'] })), bExecStageFails: bExecStageFails.map((row) => ({ reason: row.fields['reason'], code: row.fields['code'] })), installAudit }),
        verdict:
          countsB.execs === 1 && countsB.execFails === 1 && bExecStageFails.length === 1 && countsA.execFails === 0 && countsC.execFails === 0 && installAudit.nonCheckExpired === 1 && installAudit.unretried === 1
            ? 'pass'
            : 'fail',
      })
      // 重启后看诚实 UI（失败事实以台账为权威；行按 #152 磁盘真相投影）
      session = await launchDesktop('after-failure')
      await waitPanel('after-failure')
      const afterFailureSeat = await readBatchSeat(requireSession(), 'a')
      const afterFailureText = await requireSession().cdp.pageText()
      const rowB = rowOrNull(afterFailureSeat, 'b')
      const cardB = await readBatchSeat(requireSession(), 'b').catch(() => null)
      const seatC = await readTargetSeat(requireSession(), 'c').catch(() => null)
      const restartDisk = await readDisk()
      const restartLedgerB = ledgerOf(await readLedgerStates(homeDir), pluginB)
      await run.raw('panel-after-failure-restart', { seatA: afterFailureSeat, rowB, cardB, seatC, restartDisk, restartLedgerB, pageTextTail: afterFailureText.slice(-3000) })
      const rowHonest = rowHonestAfterRestart(rowB, TARGET_VERSION)
      run.record({
        step: '重启后如实展示（坏行不谎称成功、不谎称在飞）',
        what: '重启后 B 行不显示 done/current/installing，不宣称目标版已装/已是最新/安装完成；页面无「正在安装」；B 台账仍 failed；A/C 磁盘保持 0.0.2，C 徽标新版',
        expected: 'B 行诚实（failed 的 fail 含 install-failed，或按磁盘投影为未安装可装）；页面无「正在安装」；B 台账仍 failed；A/C 磁盘 0.0.2；C clientTag=v' + TARGET_VERSION,
        actual: jsonText({ rowB, cardB: cardB ? cardB.card : null, seatC: seatC ? { clientTag: seatC.clientTag, badge: seatC.badgeText } : null, restartDisk: restartDisk.versions, restartLedgerB: restartLedgerB.map(ledgerStateOf), pageClaimsInstalling: claimsInstallRunning(afterFailureText), rowHonest }),
        verdict: rowHonest && !claimsInstallRunning(afterFailureText) && restartLedgerB.length === 1 && ledgerStateOf(restartLedgerB[0]!) === 'failed' && restartDisk.versions[packageA] === TARGET_VERSION && restartDisk.versions[packageC] === TARGET_VERSION && restartDisk.versions[packageB] !== TARGET_VERSION ? 'pass' : 'fail',
      })
      await pause({
        step: '重启后如实展示（部分失败）',
        what: '部分失败后重启：A/C 已新版、B 未完成且 UI 不谎称成功/在飞',
        expected: 'B 行不显示完成/安装中；页面无「正在安装」',
        actual: jsonText({ rowB, cardB: cardB ? cardB.card : null }),
        verdict: rowHonest ? 'pass' : 'fail',
      })
      // 部分失败格到此为止：停宿主后再读批量账本/队列（避免活进程的瞬时租约/缓存）。
      // resume-retry 会在这里之后重新起桌面做重试。
      await stopDesktop('final-partial')
    }

    // ---- 4a. 全成格 / can-red：停宿主读日志 → 重启看三包新版一致 ----
    if (!partialMode) {
      await stopDesktop('after-batch')
      const logs = await captureLogFiles(run.recorder, homeDir)
      noteLogTruncations('批量全成日志', logs)
      const events = logs.snapshot.events
      const requests = events.filter((event) => event.event === 'update.install.request')
      const requestNs = Array.from(new Set(requests.map((event) => event.source.split('/')[0] ?? '')))
      const installAudit = auditInstallFails(logEventFacts(events))
      const hostCallOk = events.some((event) => event.event === 'host.call' && event.fields['kind'] === 'update-install' && event.fields['ok'] === true)
      const wireDesktop = events.some((event) => event.event === 'update.wire.ready' && event.fields['hostKind'] === 'desktop-manager')
      const batchSummary = events.filter((event) => event.event === 'update.batch.summary').length
      const execFails = events.filter((event) => event.event === 'update.install.exec' && event.fields['ok'] === false)
      const checkFail = events.filter((event) => event.event === 'update.check.fail' || (event.event === 'host.call.fail' && String(event.fields['method'] || '').endsWith('.updateCheck')))
      const errorLevel = events.filter((event) => event.level === 'error')
      await run.raw('log-counts', { requests: requests.length, requestNs, installAudit, hostCallOk, wireDesktop, batchSummary, execFails, checkFail, errorLevel })
      run.record({
        step: '日志链：批量入口 → 三包真装 → in-process 宿主',
        what: '日志里有三包（fxa-a/fxa-b/fxa-c）的 install.request、host.call(update-install, ok=true)、update.wire.ready(desktop-manager)、批量 summary；无 error 级；exec 失败=0；install.fail 只允许设计内 check-expired（每条紧跟 retry）；无 check.fail / host.call.fail{method:*.updateCheck}',
        expected: '三目标命名空间各有 install.request；host.call ok；wire=desktop-manager；summary≥1；exec 失败=0；非 check-expired 的 fail=0 且未 retry 的拒绝=0；无 error/check.fail',
        actual: jsonText({ requests: requests.length, requestNs, installAudit, hostCallOk, wireDesktop, batchSummary, execFailCount: execFails.length, checkFailCount: checkFail.length, errorCount: errorLevel.length }),
        verdict: ['a', 'b', 'c'].every((key) => requestNs.indexOf(targetPrefixOf(key as FixtureSlotKey)) >= 0) && hostCallOk && wireDesktop && batchSummary >= 1 && execFails.length === 0 && installAudit.nonCheckExpired === 0 && installAudit.unretried === 0 && checkFail.length === 0 && errorLevel.length === 0 ? 'pass' : 'fail',
      })

      session = await launchDesktop('after-batch-restart')
      const finalSeat = await waitForBatchSeat(
        requireSession(),
        'a',
        (state) => {
          if (state.panel.rows.length < 3) return false
          return state.panel.rows.every((row) => (row.phase === 'current' || row.phase === 'done') && row.versionCur === TARGET_VERSION)
        },
        { label: '重启后 A 面板三行都已是最新（current/done 0.0.2）', timeoutMs: 180000, intervalMs: 1000 },
      )
      await run.raw('panel-after-batch-restart', finalSeat)
      const cardA = await readBatchSeat(requireSession(), 'a')
      let cardB = await readBatchSeat(requireSession(), 'b').catch(() => null)
      const cardDeadline = Date.now() + 120000
      while (Date.now() < cardDeadline && (cardB === null || !cardB.card.present)) {
        await sleep(1500)
        cardB = await readBatchSeat(requireSession(), 'b').catch(() => null)
      }
      const seatC = await readTargetSeat(requireSession(), 'c').catch(() => null)
      const finalDisk = await readDisk()
      const ledgerA = await waitLedgerTerminal(pluginA, 90000)
      const ledgerB = await waitLedgerTerminal(pluginB, 90000)
      const ledgerC = await waitLedgerTerminal(pluginC, 90000)
      await run.raw('final-state', { seatA: finalSeat, cardA, cardB, seatC, finalDisk, ledgerA, ledgerB, ledgerC })
      const cardsOk =
        cardA.card.clientTag === tagsA.clientTag && cardA.card.hostTag === tagsA.hostTag &&
        cardB !== null && cardB.card.present && cardB.card.clientTag === tagsB.clientTag && cardB.card.hostTag === tagsB.hostTag &&
        seatC !== null && seatC.clientTag === tagsC.clientTag
      run.record({
        step: canRed ? 'can-red 三包成功诚实性（预期红：C 内容仍旧版）' : '重启后 UI 一致：三卡片新版 + 三行 current',
        what: canRed
          ? 'can-red：台账/磁盘都说 C=0.0.2，但 C 卡片 buildTag 必须真是 v0.0.2（stale 注入让内容仍旧版 ⇒ 此断言应真红，证明它能抓住「版本号说成功、内容还是旧的」）'
          : '重启后 A/B 卡片 clientTag/hostTag 都是 v0.0.2，C 徽标 v0.0.2；A 面板三行都是 current 0.0.2（UI 与磁盘/台账一致）',
        expected: 'A=' + tagsA.clientTag + '/' + tagsA.hostTag + '；B=' + tagsB.clientTag + '/' + tagsB.hostTag + '；C=' + tagsC.clientTag + '；三行 current 0.0.2',
        actual: jsonText({ cardA: cardA.card, cardB: cardB ? cardB.card : null, seatC: seatC ? { clientTag: seatC.clientTag, badge: seatC.badgeText } : null, rows: finalSeat.panel.rows.map((row) => ({ key: row.key, phase: row.phase, cur: row.versionCur })) }),
        verdict: cardsOk ? 'pass' : 'fail',
        note: canRed ? 'can-red 注入：C@0.0.2 用 0.0.1 内容构建（staleContentVersion=0.0.1）。本条记录真实失败（run verdict=fail、exitCode=1），失败点即「台账/磁盘说 0.0.2 成功、运行内容仍是旧版」。' : undefined,
      })
      await pause({
        step: canRed ? 'can-red 三包成功诚实性（预期红）' : '重启后 UI 一致（三包新版）',
        what: canRed ? 'can-red 现场：C 卡片 buildTag 应是旧版（本条预期 fail）' : '三包更新成功后重启：A/B 卡片新版标记、C 徽标新版、A 面板三行 current',
        expected: canRed ? tagsC.clientTag : 'A=' + tagsA.clientTag + '；B=' + tagsB.clientTag + '；C=' + tagsC.clientTag,
        actual: jsonText({ cardA: cardA.card.clientTag, cardB: cardB ? cardB.card.clientTag : null, seatC: seatC ? seatC.clientTag : null }),
        verdict: cardsOk ? 'pass' : 'fail',
      })
      const finalLedgerOk =
        ledgerA.length === 1 && ledgerB.length === 1 && ledgerC.length === 1 &&
        [ledgerA, ledgerB, ledgerC].every((entries) => SUCCESS_STATES.indexOf(ledgerStateOf(entries[0]!)) >= 0 && textOf(entries[0]!.state['targetVersion']) === TARGET_VERSION)
      run.record({
        step: '重启后台账/磁盘与 UI 三处一致',
        what: '重启不产生新台账/不回退：三个插件仍各一条成功终态（target=0.0.2），磁盘三包=0.0.2，与 UI 三行 current 一致',
        expected: '三插件各 1 条成功终态；磁盘 versions/dependencies 三包=0.0.2',
        actual: jsonText({ ledgerA: ledgerA.map(ledgerStateOf), ledgerB: ledgerB.map(ledgerStateOf), ledgerC: ledgerC.map(ledgerStateOf), disk: finalDisk.versions, dependencies: finalDisk.dependencies }),
        verdict: finalLedgerOk && packageNames.every((name) => finalDisk.versions[name] === TARGET_VERSION) ? 'pass' : 'fail',
      })
      await stopDesktop('after-final')
    }

    // ---- 4b. 续跑格：恢复 tarball → 真 UI 重试 → A/C 不重复、B 恰一次成功、总账三条 ----
    if (options.mode === 'resume-retry' && corruption) {
      const beforeRetryLogs = await captureLogFiles(run.recorder, homeDir)
      noteLogTruncations('重试前日志', beforeRetryLogs)
      const beforeCounts = { a: installLogCounts(beforeRetryLogs.snapshot.events, pluginA), b: installLogCounts(beforeRetryLogs.snapshot.events, pluginB), c: installLogCounts(beforeRetryLogs.snapshot.events, pluginC) }
      await run.raw('log-counts-before-retry', beforeCounts)

      // 先把好 tarball 放回 registry，再起桌面：开面板时产品可能自动续跑未完成批次（batch.json 里 B 还非终态），
      // 也可能只把 B 按磁盘真相投影成「可装」行。两条都是产品路径，都接受，但都必须装成且不碰 A/C。
      const restored = await restoreCorruptedTarball({ registry: fixtureEnv.registry, fault: corruption })
      await run.raw('registry-tarball-restored', restored)
      run.record({
        step: '恢复 B@0.0.2 tarball（sha 复原、元数据不变）',
        what: '把改坏前的 B tarball 备份拷回 registry storage：GET 200、字节 sha256 复原为改坏前、版本文档不变（后续重试用的是好源）',
        expected: 'restoredStatus=200；shaMatches=true；versionDocUnchanged=true',
        actual: jsonText(restored),
        verdict: restored.restoredStatus === 200 && restored.shaMatches && restored.versionDocUnchanged ? 'pass' : 'fail',
      })
      session = await launchDesktop('before-retry')
      await waitPanel('before-retry')
      const resumedAtOpen = await readBatchSeat(requireSession(), 'a').catch(() => null)
      await run.raw('panel-before-retry-open', resumedAtOpen)
      note('恢复后再起桌面：开面板瞬间的行态记在 raw/panel-before-retry-open（自动续跑时 B 行=正在安装）；安装窗只轮询磁盘/台账')
      let retryPath = 'none'
      let retriedVersion = await waitDiskVersion(packageB, TARGET_VERSION, 240000)
      if (retriedVersion === TARGET_VERSION) {
        retryPath = 'auto-resume'
      } else {
        // 产品没自动续跑：按真 UI 行按钮重试（行按钮在检查收尾后出现）。
        const retrySeat = await waitForBatchSeat(
          requireSession(),
          'a',
          (state) => {
            const row = rowOrNull(state, 'b')
            if (row === null) return false
            if (row.phase === 'checking' || row.phase === 'installing' || row.phase === 'queued') return false
            return row.actions.indexOf('row-install') >= 0
          },
          { label: 'B 行出现可用的「重试/安装」按钮', timeoutMs: 120000, intervalMs: 1000 },
        )
        await run.raw('panel-before-retry', retrySeat)
        await clickSeatAction(requireSession(), 'a', 'row-install', 'b')
        retryPath = 'row-install'
        retriedVersion = await waitDiskVersion(packageB, TARGET_VERSION, 240000)
      }
      const diskAfterRetry = await readDisk()
      await run.raw('disk-after-retry', { retryPath, retriedVersion, disk: diskAfterRetry })
      run.record({
        step: '恢复后重试/续跑成功落盘（B=0.0.2）',
        what: '恢复 tarball 后再起桌面：产品自动续跑未完成批次（开面板行态见 raw 50），或由真 UI 行按钮触发重装；B 最终装成 0.0.2，A/C 磁盘保持 0.0.2（产品路径，不是手工 CLI）',
        expected: 'versions[b]=0.0.2；versions[a]/[c] 仍 0.0.2',
        actual: 'versions=' + jsonText(diskAfterRetry.versions) + '；retryPath=' + retryPath + '；openedRowB=' + (resumedAtOpen ? jsonText(rowOrNull(resumedAtOpen, 'b')) : 'null'),
        verdict: retriedVersion === TARGET_VERSION && diskAfterRetry.versions[packageA] === TARGET_VERSION && diskAfterRetry.versions[packageC] === TARGET_VERSION ? 'pass' : 'fail',
      })
      const retriedLedger = await waitLedgerTerminal(pluginB, 90000)
      await run.raw('ledger-after-retry', { ledgerB: retriedLedger })
      await sleep(SETTLE_IDLE_MS)
      await stopDesktop('after-retry')
      const afterRetryLogs = await captureLogFiles(run.recorder, homeDir)
      noteLogTruncations('重试后日志', afterRetryLogs)
      const afterCounts = { a: installLogCounts(afterRetryLogs.snapshot.events, pluginA), b: installLogCounts(afterRetryLogs.snapshot.events, pluginB), c: installLogCounts(afterRetryLogs.snapshot.events, pluginC) }
      await run.raw('log-counts-after-retry', afterCounts)
      const retryAudit = auditInstallFails(logEventFacts(afterRetryLogs.snapshot.events))
      run.record({
        step: '续跑语义：A/C 不重复安装、B 恰一次成功',
        what: '重试前后递归日志计数对比：A/C 的安装请求/执行次数完全不变（没有因为 B 重试而重复安装）；B 的请求/执行各恰增 1（失败一次 + 重试成功一次），exec 失败仍是 1（重试没有再失败），exec 成功恰 1（不重复安装）',
        expected: 'A/C 的 requests/execs 前后相等；B requests 后=前+1、execs 后=前+1、execFails 后=1（不增）、execOks 后=1；非 check-expired 的 fail 仍恰 1（首次坏 tarball，不因重试增加），且重试后它已被后续 retry 覆盖、不再有未 retry 的拒绝（unretried=0）',
        actual: jsonText({ before: beforeCounts, after: afterCounts, retryAudit }),
        verdict:
          beforeCounts.a.requests === afterCounts.a.requests && beforeCounts.a.execs === afterCounts.a.execs &&
          beforeCounts.c.requests === afterCounts.c.requests && beforeCounts.c.execs === afterCounts.c.execs &&
          afterCounts.b.requests === beforeCounts.b.requests + 1 && afterCounts.b.execs === beforeCounts.b.execs + 1 &&
          afterCounts.b.execFails === 1 && beforeCounts.b.execFails === 1 && afterCounts.b.execOks === 1 && beforeCounts.b.execOks === 0 &&
          retryAudit.nonCheckExpired === 1 && retryAudit.unretried === 0
            ? 'pass'
            : 'fail',
      })

      session = await launchDesktop('final-retry')
      const finalSeat = await waitForBatchSeat(
        requireSession(),
        'a',
        (state) => state.panel.rows.length >= 3 && state.panel.rows.every((row) => (row.phase === 'current' || row.phase === 'done') && row.versionCur === TARGET_VERSION),
        { label: '重试成功后重启三行 current 0.0.2', timeoutMs: 180000, intervalMs: 1000 },
      )
      await run.raw('panel-after-retry-restart', finalSeat)
      const cardA = await readBatchSeat(requireSession(), 'a')
      let cardB = await readBatchSeat(requireSession(), 'b').catch(() => null)
      const cardDeadline = Date.now() + 120000
      while (Date.now() < cardDeadline && (cardB === null || !cardB.card.present)) {
        await sleep(1500)
        cardB = await readBatchSeat(requireSession(), 'b').catch(() => null)
      }
      const seatC = await readTargetSeat(requireSession(), 'c').catch(() => null)
      const finalDisk = await readDisk()
      const ledgerA = await waitLedgerTerminal(pluginA, 90000)
      const ledgerB = await waitLedgerTerminal(pluginB, 90000)
      const ledgerC = await waitLedgerTerminal(pluginC, 90000)
      await run.raw('final-state-retry', { seatA: finalSeat, cardA, cardB, seatC, finalDisk, ledgerA, ledgerB, ledgerC })
      const cardsOk =
        cardA.card.clientTag === tagsA.clientTag && cardA.card.hostTag === tagsA.hostTag &&
        cardB !== null && cardB.card.present && cardB.card.clientTag === tagsB.clientTag && cardB.card.hostTag === tagsB.hostTag &&
        seatC !== null && seatC.clientTag === tagsC.clientTag
      run.record({
        step: '重启后 UI 一致（重试成功：三卡片新版 + 三行 current）',
        what: '重试成功后重启：A/B 卡片 clientTag/hostTag=v0.0.2、C 徽标 v0.0.2，A 面板三行都 current 0.0.2',
        expected: 'A=' + tagsA.clientTag + '/' + tagsA.hostTag + '；B=' + tagsB.clientTag + '/' + tagsB.hostTag + '；C=' + tagsC.clientTag + '；三行 current',
        actual: jsonText({ cardA: cardA.card, cardB: cardB ? cardB.card : null, seatC: seatC ? { clientTag: seatC.clientTag, badge: seatC.badgeText } : null, rows: finalSeat.panel.rows.map((row) => ({ key: row.key, phase: row.phase, cur: row.versionCur })) }),
        verdict: cardsOk ? 'pass' : 'fail',
      })
      await pause({
        step: '重启后 UI 一致（重试成功）',
        what: '重试成功并重启：三包都是新版，A 面板三行 current',
        expected: '三卡片 v0.0.2；三行 current 0.0.2',
        actual: jsonText({ cardA: cardA.card.clientTag, cardB: cardB ? cardB.card.clientTag : null, seatC: seatC ? seatC.clientTag : null }),
        verdict: cardsOk ? 'pass' : 'fail',
      })
      const successEntries = [ledgerA, ledgerB, ledgerC].map((entries) => entries.filter((entry) => SUCCESS_STATES.indexOf(ledgerStateOf(entry)) >= 0))
      const totalEntries = ledgerA.length + ledgerB.length + ledgerC.length
      const finalLedgerOk =
        ledgerA.length === 1 && ledgerB.length === 1 && ledgerC.length === 1 && totalEntries === 3 &&
        successEntries.every((entries) => entries.length === 1) &&
        [ledgerA, ledgerB, ledgerC].every((entries) => textOf(entries[0]!.state['targetVersion']) === TARGET_VERSION)
      run.record({
        step: '总账：3 条成功、无重复无丢行（重试后）',
        what: '重试成功后的总账 = 三个插件各恰一条成功终态（target=0.0.2，共 3 条成功），没有第二条成功记录、没有丢行、没有残留失败冒充成功；磁盘三包=0.0.2',
        expected: 'A/B/C 三插件各 1 条成功终态；总条数=3；target 都是 0.0.2；磁盘三包=0.0.2',
        actual: jsonText({ ledgerA: ledgerA.map((entry) => ({ state: ledgerStateOf(entry), target: entry.state['targetVersion'] })), ledgerB: ledgerB.map((entry) => ({ state: ledgerStateOf(entry), target: entry.state['targetVersion'] })), ledgerC: ledgerC.map((entry) => ({ state: ledgerStateOf(entry), target: entry.state['targetVersion'] })), disk: finalDisk.versions }),
        verdict: finalLedgerOk && packageNames.every((name) => finalDisk.versions[name] === TARGET_VERSION) ? 'pass' : 'fail',
      })
      await stopDesktop('final-retry-end')
    }

    // ---- 5. 批量账本/中枢/队列（停宿主后读，避免瞬时租约） ----
    const diskFacts: BatchDiskFacts = await readBatchDiskFacts(homeDir)
    await run.raw('batch-disk-facts', diskFacts)
    const ownerA = asRecord(diskFacts.owners['fxa'])
    const batchA = ownerA ? ownerA['batch'] : null
    const inventoryA = ownerA ? ownerA['inventory'] : null
    const queue = asRecord(diskFacts.queue)
    const waiting = queue && Array.isArray(queue['waiting']) ? (queue['waiting'] as unknown[]) : null
    const hubPlanA = asRecord(diskFacts.hubPlans['fxa'])
    const hubTargets = (() => {
      const plan = hubPlanA
      if (!plan) return []
      const targets = plan['targets']
      if (!Array.isArray(targets)) return []
      return targets.map((target) => textOf(asRecord(target) ? (asRecord(target) as Record<string, unknown>)['key'] : null) ?? '').filter((key) => key !== '')
    })()
    run.record({
      step: '批量账本/中枢/队列：属主 fxa 三键、无跨 scope、无残留等待项',
      what: '磁盘上 A 的批量会话（属主 fxa）batch.json/inventory.json 都恰含 a/b/c 三键；中枢 plans/fxa 的 selfKey=a、targets=a/b/c；根队列 waiting=[]；没有 fxc 属主/计划（C 纯目标不接更新系统）',
      expected: 'fxa batch/inventory keys=[a,b,c]；hub plan fxa selfKey=a targets=[a,b,c]；queue.waiting=[]；无 fxc',
      actual: jsonText({ owners: Object.keys(diskFacts.owners), fxaBatchKeys: entryKeysOf(batchA), fxaInventoryKeys: inventoryKeysOf(inventoryA), hubPlanOwners: Object.keys(diskFacts.hubPlans), fxaHubSelfKey: hubPlanA ? hubPlanA['selfKey'] : null, fxaHubTargets: hubTargets, waiting, lease: diskFacts.hubLease }),
      verdict:
        sameKeySet(entryKeysOf(batchA), expectedKeys) && sameKeySet(inventoryKeysOf(inventoryA), expectedKeys) &&
        hubTargets.length === 3 && sameKeySet(hubTargets, expectedKeys) && String(hubPlanA ? hubPlanA['selfKey'] : '') === 'a' &&
        waiting !== null && waiting.length === 0 && Object.keys(diskFacts.owners).indexOf('fxc') < 0 && Object.keys(diskFacts.hubPlans).indexOf('fxc') < 0
          ? 'pass'
          : 'fail',
    })

    // ---- 6. 收尾：桌面实例全部退出（端口与维护者 home 由 run.close 记录） ----
    const alive = run.cleanupProcesses.filter((entry) => {
      if (typeof entry.pid !== 'number') return false
      try {
        process.kill(entry.pid, 0)
        return true
      } catch {
        return false
      }
    })
    run.record({
      step: '桌面实例退出（收尾无人残留）',
      what: '场景结束时登记过的桌面进程（含宿主自重启产生的实例）全部已退出，没有残留窗口占用单实例名额',
      expected: '登记进程的 kill(pid,0) 全部失败（已退出）',
      actual: '登记 ' + String(run.cleanupProcesses.length) + ' 个进程；仍活着=' + jsonText(alive),
      verdict: alive.length === 0 ? 'pass' : 'fail',
    })

    return await finish(run, options)
  } catch (error) {
    try {
      await stopDesktop('error')
    } catch {
      // 清理失败不覆盖真实断言
    }
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
  }
}

/** 收尾：写 run.json/index.md，复制证据到仓库内 runs 目录。 */
async function finish(run: T3Run, options: EBatchScenarioOptions): Promise<RunManifest> {
  const manifest = await run.close()
  if (options.syncEvidence === false) return manifest
  try {
    await copyRunEvidence(run.layout, options.worktree)
  } catch (error) {
    console.error('[e-batch] 复制证据失败（run 仍在仓库外）：' + messageOf(error))
  }
  return manifest
}
