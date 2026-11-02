/**
 * selftest/real-machine/scenarios/i-topology-compensation.ts —— 票 #272（spec #263 T8 / I3：拓扑补偿）的真机场景。
 *
 * 目的：在官方桌面通道上，让「移除已装包」这一步超时（宿主安装预算压到 4s + 用文件独占锁拖住包目录），
 * 验证产品的失败文案与磁盘事实一致：说「已恢复在册」就必须真的在册；说「未恢复/无法确认」就不许把
 * 已不在册的插件说成恢复了。这是「H 在册沉降」的失败面补偿。
 *
 * 失败档预期：UNVERIFIED（探针 probe-i3c 实测）——remove 超时后宿主是否把插件移出在册名单无法确认，
 * 产品如实给出「无法确认…也未能恢复在册；若插件页显示关闭，请重新启用」，而不是谎报恢复。
 * 三档文案（src/core/executor.ts:74-80）与 manifest 事实的一致性在本场景逐条断言。
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunManifest } from '../runtime/evidence.ts'
import { capturePluginManagerOperations } from '../runtime/evidence.ts'
import type { DesktopSession } from '../host/desktop-app.ts'
import { launchDesktopApp, stopDesktopByPort, stopDesktopByUserDataDir } from '../host/desktop-app.ts'
import { waitForProfileDir } from '../host/isolated-profile.ts'
import { runDshCli } from '../host/dsh-cli.ts'
import { CdpClient, waitForPageTarget } from '../cdp/cdp-client.ts'
import type { CdpClient as CdpClientType } from '../cdp/cdp-client.ts'
import { captureLogFiles } from '../runtime/log-evidence.ts'
import type { PublishedFixture } from '../../fixtures/release/fixture-publisher.ts'
import { publishScenarioVariants, variantVersionOf } from '../runtime/scenario-runner.ts'
import { fixtureSpecOf } from '../runtime/fixture-environment.ts'
import { ensureDir, listFilesRecursive } from '../../tooling/fs-utils.ts'
import { isProcessAlive, runCommand, sleep, waitFor } from '../../tooling/process.ts'
import type { PanelState } from './a-single-package-main-chain.ts'
import { captureShot, clickPanelAction, readPanelState, waitForFixtureLoaded } from './a-single-package-main-chain.ts'
import type { T3Run } from './t3-common.ts'
import { installedFixtureVersion, openT3Run, verifySutInstalled } from './t3-common.ts'
import { copyRunEvidence } from './batch-helpers.ts'
import type { FixtureSlotKey } from '../../fixtures/identity/fixture-slots.ts'
import { fixtureSlotOf } from '../../fixtures/identity/fixture-slots.ts'

/** 场景模式（I3 只有一种注入）。 */
export type TopologyCompensationMode = 'lock-remove-timeout'

/** 场景入参（工具层透传）。 */
export interface TopologyCompensationOptions {
  readonly worktree: string
  readonly runBaseDir: string
  readonly verdaccioInstallDir: string
  readonly esbuildPath: string
  readonly stamp?: string
  readonly maintainerHome?: string
  readonly mode: TopologyCompensationMode
  /** false = 试错 run，不把证据复制进仓库（默认 true）。 */
  readonly syncEvidence?: boolean
}

const PROFILE_NAME = 'desktop'
const SLOT: FixtureSlotKey = 'a'
const INSTALL_TIMEOUT_MS = 4000
const LOCK_HOLD_SECONDS = 240
const LEDGER_FAIL_TIMEOUT_MS = 120000
const RECOVERY_WAIT_TIMEOUT_MS = 180000
const RESTART_LOAD_TIMEOUT_MS = 180000

function scenarioIdOf(mode: TopologyCompensationMode): string {
  void mode
  return 'i3-topology-compensation'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 给可能无限挂起的 CDP 调用套一层超时（断连 socket 上 evaluate 不会自己返回）。 */
async function withTimeout<T>(what: string, promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const guard = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('[i3] ' + what + ' 超时 ' + String(timeoutMs) + 'ms')), timeoutMs)
  })
  try {
    return await Promise.race([promise, guard])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** 一次台账条目（pluginId 从路径 .../updates/<pluginId>/<hash>/state.json 还回来）。 */
interface LedgerEntry {
  readonly file: string
  readonly pluginId: string
  readonly state: Record<string, unknown> | null
  readonly corrupt: boolean
}

/** 读 <home>/updates 下各级 state.json（递归）。 */
async function readLedgerStates(homeDir: string): Promise<LedgerEntry[]> {
  const root = join(homeDir, 'updates')
  let files: string[] = []
  try {
    files = await listFilesRecursive(root)
  } catch {
    return []
  }
  const entries: LedgerEntry[] = []
  for (const relative of files) {
    const segments = relative.split(/[\\/]/)
    if (segments[segments.length - 1] !== 'state.json') continue
    const file = join(root, segments.join('\\'))
    const pluginId = segments.length >= 3 ? segments[segments.length - 3] : ''
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
      entries.push({ file, pluginId, state: parsed, corrupt: false })
    } catch {
      entries.push({ file, pluginId, state: null, corrupt: true })
    }
  }
  return entries
}

/** 读日志原始行（保留 ts）。 */
async function readRawLogRows(homeDir: string): Promise<{ event: string; ts: number | null; fields: Record<string, unknown>; source: string; line: number }[]> {
  const root = join(homeDir, 'logs')
  let files: string[] = []
  try {
    files = await listFilesRecursive(root)
  } catch {
    return []
  }
  const rows: { event: string; ts: number | null; fields: Record<string, unknown>; source: string; line: number }[] = []
  for (const relative of files) {
    if (!relative.endsWith('.log')) continue
    let content = ''
    try {
      content = await readFile(join(root, relative), 'utf8')
    } catch {
      continue
    }
    const lines = content.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (!line || line.trim().length === 0) continue
      let parsed: Record<string, unknown> = {}
      try {
        parsed = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      const event = typeof parsed['event'] === 'string' ? (parsed['event'] as string) : ''
      if (!event) continue
      rows.push({
        event,
        ts: typeof parsed['ts'] === 'number' ? (parsed['ts'] as number) : null,
        fields: parsed['fields'] && typeof parsed['fields'] === 'object' ? (parsed['fields'] as Record<string, unknown>) : {},
        source: relative,
        line: index + 1,
      })
    }
  }
  rows.sort((left, right) => (left.ts ?? 0) - (right.ts ?? 0))
  return rows
}

/** profile 清单事实。 */
interface ManifestFacts {
  readonly path: string
  readonly text: string
  readonly dependencies: Record<string, string> | null
  readonly bundles: string[] | null
}

async function readManifestFacts(homeDir: string, profileName: string): Promise<ManifestFacts> {
  const path = join(homeDir, 'profiles', profileName, 'package.json')
  const text = await readFile(path, 'utf8')
  let json: { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } } = {}
  try {
    json = JSON.parse(text) as typeof json
  } catch {
    json = {}
  }
  const bundles = json.dsh && json.dsh.profile && Array.isArray(json.dsh.profile.bundles) ? json.dsh.profile.bundles : null
  return { path, text, dependencies: json.dependencies || null, bundles }
}

/** 桌面自重启后用同一调试端口重连；evaluate 正常就原样返回。 */
async function reconnectDesktop(session: DesktopSession): Promise<DesktopSession> {
  try {
    await withTimeout('evaluate 探活', session.cdp.evaluate('1'), 5000)
    return session
  } catch {
    // 端口上的旧 socket 已断（或 evaluate 挂住），继续走重连。
  }
  const target = await withTimeout('等待页面 target', waitForPageTarget(session.port, { timeoutMs: 20000, urlIncludes: 'dsh-app' }), 25000)
  const cdp: CdpClientType = await CdpClient.connect(target.webSocketDebuggerUrl as string)
  return { port: session.port, process: session.process, cdp, targets: [target] } as unknown as DesktopSession
}

/** 停桌面（close + 按端口/ user-data-dir 双清，最多 8 轮）。 */
async function stopDesktopAll(run: T3Run, session: DesktopSession | null, tag: string): Promise<{ killed: number[]; port: number | null }> {
  const port = session ? session.port : null
  if (session) {
    const pid = session.process.pid() ?? null
    try {
      await withTimeout('关闭桌面会话', session.close(), 20000)
    } catch (error) {
      run.addNote('停桌面 close 失败（' + tag + '）：' + messageOf(error))
    }
    if (pid !== null) run.registerProcess('desktop-' + tag, pid)
  }
  const killed: number[] = []
  let emptyRounds = 0
  for (let round = 0; round < 8; round += 1) {
    let roundKilled: number[] = []
    if (port !== null) {
      try {
        roundKilled = roundKilled.concat(await stopDesktopByPort(port))
      } catch (error) {
        run.addNote('按端口清桌面失败（' + tag + '）：' + messageOf(error))
      }
    }
    try {
      roundKilled = roundKilled.concat(await stopDesktopByUserDataDir(run.layout.userDataDir))
    } catch (error) {
      run.addNote('按 user-data-dir 清桌面失败（' + tag + '）：' + messageOf(error))
    }
    for (const pid of roundKilled) {
      if (killed.indexOf(pid) < 0) killed.push(pid)
    }
    emptyRounds = roundKilled.length === 0 ? emptyRounds + 1 : 0
    if (emptyRounds >= 2) break
    await sleep(1500)
  }
  for (const pid of killed) run.registerProcess('desktop-' + tag + '-relaunched-' + String(pid), pid)
  await run.raw('desktop-stop-' + tag, { port, killedPids: killed, userDataDir: run.layout.userDataDir })
  await sleep(500)
  return { killed, port }
}

/** 起桌面实例（最多 3 次，失败先清场）。 */
async function launchDesktopManaged(
  run: T3Run,
  options: { registryUrl: string; homeDir: string; userDataDir: string; tag: string; extraEnv?: Record<string, string | undefined> },
): Promise<DesktopSession> {
  const extraEnv: Record<string, string | undefined> = { DSH_SELFTEST_REGISTRY: options.registryUrl, ...(options.extraEnv || {}) }
  let lastError: Error | null = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (attempt > 1) {
      try {
        await stopDesktopByUserDataDir(options.userDataDir)
      } catch {
        // 清场失败也继续试。
      }
      await sleep(1000)
    }
    try {
      const session = await launchDesktopApp({ homeDir: options.homeDir, userDataDir: options.userDataDir, extraEnv })
      run.registerProcess('desktop-' + options.tag + (attempt > 1 ? '-attempt' + String(attempt) : ''), session.process.pid() ?? null)
      await session.cdp.waitForExpression('document.body && document.body.innerText.length > 100', { timeoutMs: 90000 })
      return session
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      await sleep(1000)
    }
  }
  throw lastError || new Error('[i3] 桌面实例启动失败')
}
/** 等磁盘版本到目标版本（超时返回当前值，不抛）。 */
async function waitDiskVersion(options: { homeDir: string; profileName: string; packageName: string; targetVersion: string; timeoutMs: number }): Promise<{ version: string | null; elapsedMs: number }> {
  const startedAt = Date.now()
  let version: string | null = null
  try {
    await waitFor(
      'profile 磁盘版本到 ' + options.targetVersion,
      async () => {
        version = await installedFixtureVersion({ homeDir: options.homeDir, profileName: options.profileName, packageName: options.packageName }).catch(() => null)
        return version === options.targetVersion ? version : null
      },
      { timeoutMs: options.timeoutMs, intervalMs: 500 },
    )
  } catch {
    version = await installedFixtureVersion({ homeDir: options.homeDir, profileName: options.profileName, packageName: options.packageName }).catch(() => null)
  }
  return { version, elapsedMs: Date.now() - startedAt }
}

/** 等台账出现目标状态（failed 等）；超时返回当前条目。 */
async function waitLedgerState(options: { homeDir: string; targetVersion: string; states: readonly string[]; timeoutMs: number }): Promise<{ entries: LedgerEntry[]; elapsedMs: number; hit: boolean }> {
  const startedAt = Date.now()
  let entries: LedgerEntry[] = []
  let hit = false
  try {
    await waitFor(
      '台账出现目标状态',
      async () => {
        entries = await readLedgerStates(options.homeDir)
        hit = entries.some(
          (entry) =>
            entry.state !== null &&
            entry.state['targetVersion'] === options.targetVersion &&
            typeof entry.state['state'] === 'string' &&
            options.states.indexOf(entry.state['state'] as string) >= 0,
        )
        return hit ? true : null
      },
      { timeoutMs: options.timeoutMs, intervalMs: 1000 },
    )
  } catch {
    entries = await readLedgerStates(options.homeDir)
    hit = false
  }
  return { entries, elapsedMs: Date.now() - startedAt, hit }
}

/** 持锁进程句柄（场景结束时必须杀）。 */
interface FileLock {
  readonly proc: ChildProcess | null
  readonly pid: number | null
  readonly scriptPath: string
  readonly markerPath: string
  readonly targetPath: string
}

/** 用 PowerShell 对目标文件持有 FileShare.Read 独占锁（允许读、拒绝写/删），写 marker 表示已上锁。 */
async function acquireFileLock(options: { run: T3Run; workDir: string; targetPath: string; tag: string }): Promise<FileLock> {
  const scriptPath = join(options.workDir, 'lock-' + options.tag + '.ps1')
  const markerPath = join(options.workDir, 'lock-' + options.tag + '.marker')
  const escapedTarget = options.targetPath.replace(/'/g, "''")
  const escapedMarker = markerPath.replace(/'/g, "''")
  const script = [
    '$ErrorActionPreference = \'Stop\'',
    '$path = \'' + escapedTarget + '\'',
    '$marker = \'' + escapedMarker + '\'',
    '$fs = [System.IO.File]::Open($path, \'Open\', \'Read\', \'Read\')',
    'Set-Content -Path $marker -Value (\'locked pid=\' + $PID) -NoNewline',
    'Start-Sleep -Seconds ' + String(LOCK_HOLD_SECONDS),
    '$fs.Dispose()',
  ].join('\n')
  await writeFile(scriptPath, script)
  const proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { windowsHide: true, stdio: 'ignore' })
  const pid = proc.pid ?? null
  if (pid !== null) options.run.registerProcess('file-lock-' + options.tag, pid)
  await waitFor(
    '文件锁 marker 出现',
    async () => {
      try {
        const text = await readFile(markerPath, 'utf8')
        return text.length > 0 ? text : null
      } catch {
        return null
      }
    },
    { timeoutMs: 20000, intervalMs: 200 },
  )
  return { proc, pid, scriptPath, markerPath, targetPath: options.targetPath }
}

/** 第二个进程尝试独占打开：打不开（exit 3）= 锁生效。 */
function probeExclusiveOpen(targetPath: string): { exitCode: number | null; stdout: string; stderr: string } {
  const script = [
    '$ErrorActionPreference = \'Stop\'',
    'try {',
    '  $fs = [System.IO.File]::Open(\'' + targetPath.replace(/'/g, "''") + '\', \'Open\', \'ReadWrite\', \'None\')',
    '  $fs.Dispose()',
    '  exit 0',
    '} catch {',
    '  exit 3',
    '}',
  ].join('\n')
  const result = runCommand('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script])
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
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
  if (lock.pid !== null) {
    runCommand('taskkill.exe', ['/PID', String(lock.pid), '/T', '/F'])
  }
  await sleep(1000)
  const aliveAfter = lock.pid !== null ? isProcessAlive(lock.pid) : false
  await run.raw('file-lock-release', { pid: lock.pid, killed, aliveAfter, targetPath: lock.targetPath })
  return { killed, aliveAfter }
}

/** 从失败 message 里拆出 dsh plugin add 的 argv（去掉开头的 dsh）。 */
function argvOfCarrier(text: string): string[] | null {
  const match = /(dsh plugin [^()\n]+)/.exec(text)
  if (match === null) return null
  const tokens = match[1].trim().split(/\s+/)
  if (tokens.length < 3 || tokens[0] !== 'dsh' || tokens[1] !== 'plugin') return null
  return tokens.slice(1)
}
/** 当前活动桌面会话（顶层异常兜底清理用）。 */
let activeSession: DesktopSession | null = null

/** I3 主流程。 */
async function runTopologyCompensationFlow(run: T3Run, options: TopologyCompensationOptions): Promise<void> {
  const slot = fixtureSlotOf(SLOT)
  const packageName = slot.packageName
  const fixtureEnv = run.fixtureEnv
  if (fixtureEnv === null) throw new Error('[i3] fixtureEnv 未初始化')
  const registryUrl = fixtureEnv.registry.baseUrl
  const homeDir = run.layout.homeDir
  const userDataDir = run.layout.userDataDir
  const workDir = join(run.layout.root, 'i3-work')
  await ensureDir(workDir)
  const variantVersion = variantVersionOf(run.scenario, SLOT)
  if (variantVersion === null) throw new Error('[i3] 场景声明缺少席位 a 的变体版本')
  const baselineVersion = run.scenario.install.find((step) => step.slotKey === SLOT)?.version || ''

  await run.raw('isolation-facts', {
    hostChannel: 'desktop-official',
    homeDir,
    userDataDir,
    profileName: PROFILE_NAME,
    profileDir: join(homeDir, 'profiles', PROFILE_NAME),
    packageName,
    registryUrl,
    mode: options.mode,
    installTimeoutMs: INSTALL_TIMEOUT_MS,
  })
  await run.record({
    step: '隔离口径',
    what: '官方桌面实例使用仓库外隔离 home + 独立 --user-data-dir；安装预算压到 ' + String(INSTALL_TIMEOUT_MS) + 'ms，便于在真机合格时间内制造 remove 超时',
    expected: 'homeDir=' + homeDir + '；userDataDir=' + userDataDir + '；profile=' + PROFILE_NAME,
    actual: 'homeDir=' + homeDir + '；userDataDir=' + userDataDir + '；profile=' + PROFILE_NAME,
    verdict: 'pass',
  })
  run.addNote('i3 口径：remove 步用文件独占锁（PowerShell FileShare.Read 持锁）拖住包内 lib/index.js，产品安装预算 DSH_SELFTEST_INSTALL_TIMEOUT_MS=4000 让 remove 超时；断言重点不是「必须恢复成功」，而是产品文案与磁盘/在册事实一致（说恢复就必须真在册）。')

  // ---- 1. 首启建 profile ----
  let session: DesktopSession | null = await launchDesktopManaged(run, { registryUrl, homeDir, userDataDir, tag: 'bootstrap' })
  activeSession = session
  await waitForProfileDir({ homeDir, profileName: PROFILE_NAME, timeoutMs: 120000 })
  await run.raw('desktop-first-launch', { port: session.port, pid: session.process.pid() ?? null })
  await stopDesktopAll(run, session, 'bootstrap')
  session = null
  activeSession = null

  // ---- 2. 装基版 + 钉 SUT ----
  await run.installBaseline({ homeDir, profileName: PROFILE_NAME, registryUrl })
  await verifySutInstalled(run, { homeDir, profileName: PROFILE_NAME, packageName })
  const baseDiskVersion = await installedFixtureVersion({ homeDir, profileName: PROFILE_NAME, packageName })
  const manifestBefore = await readManifestFacts(homeDir, PROFILE_NAME)
  await run.raw('manifest-before', { path: manifestBefore.path, text: manifestBefore.text, dependencies: manifestBefore.dependencies, bundles: manifestBefore.bundles })
  await run.record({
    step: '更新前基版在盘且在册',
    what: 'CLI 装 ' + packageName + '@' + baselineVersion + ' 后读磁盘版本与 profile 清单',
    expected: '磁盘=' + baselineVersion + '；dependencies 有该包=' + baselineVersion + '；bundles 含该包',
    actual: '磁盘=' + String(baseDiskVersion) + '；dependencies=' + JSON.stringify(manifestBefore.dependencies) + '；bundles=' + JSON.stringify(manifestBefore.bundles),
    verdict:
      baseDiskVersion === baselineVersion && manifestBefore.dependencies !== null && manifestBefore.dependencies[packageName] === baselineVersion && manifestBefore.bundles !== null && manifestBefore.bundles.indexOf(packageName) >= 0
        ? 'pass'
        : 'fail',
  })

  // ---- 3. 发布变体 ----
  const baselinePublication = await run.publishBaseline()
  const publication = await publishScenarioVariants(run.scenario, fixtureEnv, undefined, baselinePublication)
  const publishedVariant: PublishedFixture = publication.variants[SLOT]
  await run.raw('fixture-published-variant', { variantSpec: fixtureSpecOf(publishedVariant), builtDir: publishedVariant.built.dir })
  await run.record({
    step: '变体版本已发布',
    what: '本地 verdaccio 发布 ' + packageName + '@' + variantVersion,
    expected: fixtureSpecOf(publishedVariant),
    actual: fixtureSpecOf(publishedVariant),
    verdict: 'pass',
  })

  // ---- 4. 主实例（带 4s 安装预算）：面板检查 → 可安装 ----
  session = await launchDesktopManaged(run, {
    registryUrl,
    homeDir,
    userDataDir,
    tag: 'main',
    extraEnv: { DSH_SELFTEST_INSTALL_TIMEOUT_MS: String(INSTALL_TIMEOUT_MS) },
  })
  activeSession = session
  const mainPort = session.port
  await run.raw('desktop-main-launch', { port: mainPort, pid: session.process.pid() ?? null, installTimeoutMs: INSTALL_TIMEOUT_MS })
  const panelOld = await waitForFixtureLoaded(session, RESTART_LOAD_TIMEOUT_MS)
  await run.raw('panel-old', panelOld)
  await run.record({
    step: '主实例面板加载基版',
    what: '等夹具卡片 + 更新面板渲染',
    expected: 'present=true；clientTag=client v' + baselineVersion + '；hostTag=host v' + baselineVersion,
    actual: 'present=' + String(panelOld.present) + '；clientTag=' + String(panelOld.card ? panelOld.card.clientTag : null) + '；hostTag=' + String(panelOld.card ? panelOld.card.hostTag : null),
    verdict: panelOld.present && panelOld.card !== null && panelOld.card.clientTag === 'client v' + baselineVersion && panelOld.card.hostTag === 'host v' + baselineVersion ? 'pass' : 'fail',
  })
  await captureShot(run.recorder, session, {
    step: 'panel-old',
    what: '安装前官方桌面夹具卡片与更新面板（基版 ' + baselineVersion + '）',
    expected: '卡片 client/host = ' + baselineVersion,
    actual: 'visible',
    verdict: 'pass',
  })
  await clickPanelAction(session, 'check')
  await waitFor(
    '面板可安装态（versions[2]=' + variantVersion + ' 且 install 可点）',
    async () => {
      const state = await readPanelState(session as DesktopSession).catch(() => null)
      if (!state) return null
      const ready = state.versions.length >= 3 && state.versions[2] === variantVersion && state.install !== null && state.install.disabled === false
      return ready ? state : null
    },
    { timeoutMs: 180000, intervalMs: 1000 },
  )
  await run.record({
    step: '真 UI 检查更新后安装可点',
    what: '点面板「检查更新」并等版本条到 ' + variantVersion + '、安装按钮可点',
    expected: 'versions[2]=' + variantVersion + '；install.disabled=false',
    actual: '可安装',
    verdict: 'pass',
  })

  // ---- 5. 锁住已装包内文件 → 点安装 → remove 超时 ----
  const lockTarget = join(homeDir, 'profiles', PROFILE_NAME, 'node_modules', packageName, 'lib', 'index.js')
  const lock = await acquireFileLock({ run, workDir, targetPath: lockTarget, tag: 'i3' })
  const exclusiveProbe = probeExclusiveOpen(lockTarget)
  await run.raw('file-lock-acquired', {
    targetPath: lockTarget,
    lockPid: lock.pid,
    scriptPath: lock.scriptPath,
    markerPath: lock.markerPath,
    markerText: await readFile(lock.markerPath, 'utf8').catch(() => null),
    exclusiveOpenExitCode: exclusiveProbe.exitCode,
    exclusiveOpenStdout: exclusiveProbe.stdout,
    exclusiveOpenStderr: exclusiveProbe.stderr,
    why: 'FileShare.Read：允许读、拒绝写/删；第二个 PowerShell 以 FileShare.None 打开应失败（exit 3）= 锁生效',
  })
  await run.record({
    step: '注入：包内文件被独占锁住（remove 删不掉）',
    what: 'PowerShell 对 ' + lockTarget + ' 持有 FileShare.Read 锁，并用第二个进程 Probe 锁是否真的生效',
    expected: 'marker 写入；独占打开探针 exitCode=3（打不开）',
    actual: 'lockPid=' + String(lock.pid) + '；exclusiveOpenExitCode=' + String(exclusiveProbe.exitCode),
    verdict: lock.pid !== null && exclusiveProbe.exitCode === 3 ? 'pass' : 'fail',
  })

  const installClickAt = Date.now()
  await clickPanelAction(session, 'install')
  const ledgerFail = await waitLedgerState({ homeDir, targetVersion: variantVersion, states: ['failed', 'completed', 'restart-required'], timeoutMs: LEDGER_FAIL_TIMEOUT_MS })
  await run.raw('ledger-after-timeout', { hit: ledgerFail.hit, elapsedMs: ledgerFail.elapsedMs, entries: ledgerFail.entries })
  const release = await releaseFileLock(run, lock)
  await run.raw('file-lock-released', release)
  // ---- 6. 失败后页面/面板事实 → 停宿主拿日志/操作/磁盘 ----
  let panelAfter: PanelState | null = null
  let panelAfterError: string | null = null
  if (session !== null) {
    try {
      session = await reconnectDesktop(session)
      panelAfter = await withTimeout('读取失败后面板', readPanelState(session), 20000)
    } catch (error) {
      panelAfterError = messageOf(error)
    }
    if (session !== null) {
      try {
        await withTimeout(
          '失败画面截图',
          captureShot(run.recorder, session, {
            step: 'panel-after-remove-timeout',
            what: 'remove 超时、宿主安装失败后的官方桌面画面（若面板随插件消失则如实记录）',
            expected: '面板/页面反映失败或随提供者消失',
            actual: panelAfter !== null ? 'visible' : 'panel-unavailable：' + String(panelAfterError),
            verdict: 'pass',
          }),
          30000,
        )
      } catch (error) {
        run.addNote('失败画面截图不可用（桌面可能已退出）：' + messageOf(error))
      }
    }
  }
  await run.raw('panel-after-remove-timeout', { panel: panelAfter, error: panelAfterError })
  await stopDesktopAll(run, session, 'main')
  session = null
  activeSession = null
  await capturePluginManagerOperations({
    recorder: run.recorder,
    homeDir,
    profileName: PROFILE_NAME,
    window: { fromMs: installClickAt - 1000, toMs: Date.now() + 3000 },
  })
  await captureLogFiles(run.recorder, homeDir)
  const rawRows = await readRawLogRows(homeDir)
  const execRows = rawRows.filter((row) => row.event === 'update.install.exec')
  const failRows = rawRows.filter((row) => row.event === 'update.install.fail')
  const execFacts = execRows.map((row) => ({
    route: row.fields['route'] ?? null,
    ok: row.fields['ok'] ?? null,
    exitCode: row.fields['exitCode'] ?? null,
    durationMs: row.fields['durationMs'] ?? null,
    pluginId: row.fields['pluginId'] ?? null,
    ts: row.ts,
  }))
  const failFacts = failRows.map((row) => ({ stage: row.fields['stage'] ?? null, reason: row.fields['reason'] ?? null, code: row.fields['code'] ?? null, ts: row.ts }))
  const timeoutFails = failRows.filter((row) => row.fields['stage'] === 'exec' && row.fields['reason'] === 'timeout')
  await run.raw('install-outcome-rows', { execFacts, failFacts, timeoutFails: timeoutFails.map((row) => row.fields) })
  const manifestAfter = await readManifestFacts(homeDir, PROFILE_NAME)
  const diskAfter = await installedFixtureVersion({ homeDir, profileName: PROFILE_NAME, packageName })
  const packageDir = join(homeDir, 'profiles', PROFILE_NAME, 'node_modules', packageName)
  let packageDirExists = true
  try {
    await readFile(join(packageDir, 'package.json'), 'utf8')
  } catch {
    packageDirExists = false
  }
  await run.raw('disk-after-remove-timeout', {
    manifestPath: manifestAfter.path,
    manifestText: manifestAfter.text,
    dependencies: manifestAfter.dependencies,
    bundles: manifestAfter.bundles,
    diskVersion: diskAfter,
    packageDir,
    packageDirExists,
  })
  const ledgerFinal = await readLedgerStates(homeDir)
  const ledgerTarget = ledgerFinal.filter((entry) => entry.state !== null && entry.state['targetVersion'] === variantVersion)
  const ledgerState = ledgerTarget.length > 0 ? ledgerTarget[0].state : null
  const ledgerStateName = ledgerState !== null && typeof ledgerState['state'] === 'string' ? (ledgerState['state'] as string) : null
  const ledgerMessage = ledgerState !== null && typeof ledgerState['message'] === 'string' ? (ledgerState['message'] as string) : null
  await run.raw('ledger-facts', { entries: ledgerFinal.map((entry) => ({ file: entry.file, pluginId: entry.pluginId, state: entry.state })) })

  // ---- 7. 执行面：确实是 remove 超时失败 ----
  await run.record({
    step: 'remove 超时：exec 行 route=desktop-manager / ok=false',
    what: '安装窗内 update.install.exec 行的执行出口与结果',
    expected: 'exec 行数>=1；route=desktop-manager；ok=false；exitCode 非 0',
    actual: 'exec=' + JSON.stringify(execFacts),
    verdict: execFacts.length >= 1 && execFacts[0].route === 'desktop-manager' && execFacts[0].ok === false && execFacts[0].exitCode !== 0 ? 'pass' : 'fail',
  })
  await run.record({
    step: 'remove 超时：失败行 stage=exec / reason=timeout / code=install-failed',
    what: 'update.install.fail 行里与超时对应的失败点',
    expected: '存在 stage=exec、reason=timeout、code=install-failed 的行',
    actual: 'fail=' + JSON.stringify(failFacts),
    verdict: timeoutFails.length >= 1 && timeoutFails.some((row) => row.fields['code'] === 'install-failed') ? 'pass' : 'fail',
  })
  await run.record({
    step: 'remove 超时：台账进入 failed 且 message 带 remove 超时原文',
    what: '读 updates/<pluginId>/<hash>/state.json 的 state 与 message',
    expected: 'state=failed；message 含「移除已装包超时」',
    actual: 'state=' + String(ledgerStateName) + '；message=' + String(ledgerMessage),
    verdict: ledgerStateName === 'failed' && ledgerMessage !== null && ledgerMessage.indexOf('移除已装包超时') >= 0 ? 'pass' : 'fail',
  })

  // ---- 8. 补偿文案三档：逐字匹配 + 与 manifest/磁盘事实一致（不许谎报恢复）----
  const RESTORED = '本次已恢复在册'
  const RESTORE_FAILED = '恢复在册未成功'
  const UNVERIFIED = '无法确认宿主是否把该插件移出了在册名单'
  const messageText = ledgerMessage || ''
  let tier = 'none'
  if (messageText.indexOf(RESTORED) >= 0) tier = 'restored'
  else if (messageText.indexOf(RESTORE_FAILED) >= 0) tier = 'restore-failed'
  else if (messageText.indexOf(UNVERIFIED) >= 0) tier = 'unverified'
  const registeredAfter = manifestAfter.bundles !== null && manifestAfter.bundles.indexOf(packageName) >= 0
  await run.raw('compensation-tier', { tier, registeredAfter, bundles: manifestAfter.bundles, dependencies: manifestAfter.dependencies, diskVersion: diskAfter, message: messageText })
  await run.record({
    step: '失败人话落在一个已知的补偿档位（三档之一）',
    what: '在失败 message 里找三档补偿文案（executor.ts:74-80）',
    expected: '命中 restored / restore-failed / unverified 之一',
    actual: 'tier=' + tier + '；message=' + JSON.stringify(messageText),
    verdict: tier === 'none' ? 'fail' : 'pass',
  })
  await run.record({
    step: '文案与在册事实一致：说「已恢复」就必须真在册',
    what: '把补偿档位与 profile 清单 dsh.profile.bundles 对照：restored 档必须包含该包',
    expected: 'tier=restored 时 bundles 含 ' + packageName + '；tier 非 restored 时不得宣称「本次已恢复在册」',
    actual: 'tier=' + tier + '；registeredAfter=' + String(registeredAfter) + '；bundles=' + JSON.stringify(manifestAfter.bundles),
    verdict: tier === 'restored' ? (registeredAfter ? 'pass' : 'fail') : tier === 'none' ? 'fail' : 'pass',
  })
  await run.record({
    step: '文案与磁盘事实一致：没装成就不许说已更新',
    what: '失败后磁盘包版本、包目录存在性、清单依赖共同判断是否能被读成「更新成功」',
    expected: '磁盘版本 ≠ ' + variantVersion + ' 或包目录已不存在；且 dependencies 不被写成变体版本作为「已完成」',
    actual: 'diskAfter=' + String(diskAfter) + '；dependencies=' + JSON.stringify(manifestAfter.dependencies) + '；packageDirExists=' + String(packageDirExists),
    verdict: diskAfter !== variantVersion ? 'pass' : packageDirExists ? 'fail' : 'pass',
  })
  await run.record({
    step: '失败后面板不复述假成功（或面板随插件消失，如实记录）',
    what: '若面板仍可达，读横幅/错误文案；若随被移除插件消失则记录不可达',
    expected: '面板不可达；或可见文案里没有「已是最新」类假成功',
    actual: panelAfter !== null ? 'present=' + String(panelAfter.present) + '；banner=' + String(panelAfter.banner) + '；error=' + String(panelAfter.error) : 'panel-unavailable：' + String(panelAfterError),
    verdict: panelAfter === null ? 'pass' : panelAfter.banner !== null && panelAfter.banner.indexOf('已是最新') >= 0 ? 'fail' : 'pass',
  })

  // ---- 9. 恢复：按人话里的载体命令真跑一次（证明文案可操作，也把 profile 还原）----
  const carrierArgv = ledgerMessage !== null ? argvOfCarrier(ledgerMessage) : null
  await run.raw('carrier-command', { message: ledgerMessage, argv: carrierArgv })
  if (carrierArgv !== null) {
    const result = runDshCli(carrierArgv, { homeDir, cwd: homeDir, timeoutMs: 180000 })
    await run.raw('carrier-command-run', { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr })
    const recoveredDisk = await waitDiskVersion({ homeDir, profileName: PROFILE_NAME, packageName, targetVersion: variantVersion, timeoutMs: RECOVERY_WAIT_TIMEOUT_MS })
    const manifestRecovered = await readManifestFacts(homeDir, PROFILE_NAME)
    await run.raw('recovery-facts', { recoveredDisk, dependencies: manifestRecovered.dependencies, bundles: manifestRecovered.bundles })
    await run.record({
      step: '按人话里的载体命令可重装（文案可操作）',
      what: '跑 message 里的 dsh plugin add 命令，等磁盘回到 ' + variantVersion + '，再读清单',
      expected: '命令 exit=0；磁盘=' + variantVersion + '；dependencies 含 ' + variantVersion + '；bundles 含该包',
      actual: 'exit=' + String(result.exitCode) + '；磁盘=' + String(recoveredDisk.version) + '；dependencies=' + JSON.stringify(manifestRecovered.dependencies) + '；bundles=' + JSON.stringify(manifestRecovered.bundles),
      verdict:
        result.exitCode === 0 && recoveredDisk.version === variantVersion && manifestRecovered.dependencies !== null && manifestRecovered.dependencies[packageName] === variantVersion && manifestRecovered.bundles !== null && manifestRecovered.bundles.indexOf(packageName) >= 0
          ? 'pass'
          : 'fail',
    })
  } else {
    await run.record({
      step: '按人话里的载体命令可重装（文案可操作）',
      what: '从失败 message 里解析载体命令',
      expected: 'message 里带 dsh plugin add 载体命令',
      actual: 'message=' + JSON.stringify(ledgerMessage),
      verdict: 'fail',
    })
  }

  // ---- 10. 收尾 ----
  await run.registerPort('desktop-main-port', mainPort)
  const leftoverPids: { label: string; pid: number | null; alive: boolean }[] = []
  for (const item of run.cleanupProcesses) {
    if (item.pid === null) continue
    leftoverPids.push({ label: item.label, pid: item.pid, alive: isProcessAlive(item.pid) })
  }
  await run.raw('cleanup-verify', { ports: run.cleanupPorts, leftoverPids })
  await run.record({
    step: '收尾清理（进程/端口无残留）',
    what: '停掉本 run 起过的桌面/持锁进程后按 pid 复核存活、按端口复核已释放',
    expected: '存活 pid 数=0；主实例端口已释放',
    actual: 'alive=' + JSON.stringify(leftoverPids.filter((item) => item.alive)) + '；ports=' + JSON.stringify(run.cleanupPorts),
    verdict: leftoverPids.filter((item) => item.alive).length === 0 && run.cleanupPorts.every((item) => item.released) ? 'pass' : 'fail',
  })
  run.addNote('i3 失败档：探针 probe-i3c 实测落在 unverified 档（remove 超时后无法确认宿主是否把插件移出在册名单，也未能恢复）；本格逐条断言文案↔manifest↔磁盘一致，不是只截一张失败图。')
}

/** 场景入口：I3 拓扑补偿，统一收尾（close + 证据同步）。 */
export async function runTopologyCompensation(options: TopologyCompensationOptions): Promise<RunManifest> {
  const scenarioId = scenarioIdOf(options.mode)
  const run = await openT3Run({
    worktree: options.worktree,
    runBaseDir: options.runBaseDir,
    verdaccioInstallDir: options.verdaccioInstallDir,
    esbuildPath: options.esbuildPath,
    scenarioId,
    hostChannel: 'desktop-official',
    stamp: options.stamp,
    maintainerHome: options.maintainerHome,
    ticket: '272',
  })
  try {
    await runTopologyCompensationFlow(run, options)
  } catch (error) {
    await run.raw('scenario-error', { message: messageOf(error), stack: error instanceof Error ? error.stack ?? null : null })
    await run.record({ step: '场景异常', what: '顶层 catch：真机流程中抛错', expected: '无异常', actual: messageOf(error), verdict: 'unknown' })
    run.addNote('场景异常：' + messageOf(error))
    if (activeSession !== null) {
      await stopDesktopAll(run, activeSession, 'scenario-error').catch(() => undefined)
      activeSession = null
    }
    try {
      await stopDesktopByUserDataDir(run.layout.userDataDir)
    } catch {
      // 兜底清场失败不掩盖原始异常。
    }
  }
  const manifest = await run.close()
  if (options.syncEvidence !== false) {
    try {
      await copyRunEvidence(run.layout, options.worktree)
    } catch (error) {
      console.error('[i3] 复制证据失败（run 仍在仓库外）：' + messageOf(error))
    }
  }
  return manifest
}
