/**
 * selftest/real-machine/scenarios/i-enrollment-restart.ts —— 票 #272 的 I1/I2 组：重启后在册真话 / 未登记诚实。
 *
 * 为什么必须官方桌面：`dsh.profile.bundles`（使用范围清单）只有桌面宿主会写；
 * 面板「重启宿主后生效 / 未登记在使用范围清单，重启宿主也不会加载」两条横幅都是桌面内 process 的
 * in-process pluginManager 读在册事实后说的话。普通 DSH web 宿主（cli-process）拿不到这些事实。
 *
 * I1（restart-truth）：装基版 → 面板 check → install → 断言 desktop-manager 是 in-process 热换（未手动重启时
 *   同一宿主进程已加载 0.0.2：面板「已是最新」、卡片 client/host v0.0.2，且安装窗内无 host.start）；
 *   再真重启（关宿主起新实例）断言不回退（client/host/磁盘/在册清单一致）——证明「已生效」不是写盘假绿。
 * I2（unregistered-honesty，A-prime）：官方桌面独占 desktop profile，通道 B（普通 DSH web 宿主）只能用非 desktop
 *   profile 真安装——安装瞬间 verify 行报 restart-required/pendingRestart=true；未重启时磁盘 0.0.2 而宿主 buildTag
 *   仍基版（通道 B 不热换）。随后把夹具从 profile 清单的在册名单摘掉、真重启同一 CLI 宿主：夹具电话不可达（确实
 *   不加载）而宿主页面正常；写回清单后再重启：buildTag=host v0.0.2 且 updateCheck canInstall=false。
 * can-red（复用 I1 场景 id）：stale-variant 注入（发布 0.0.2 但内容仍是 0.0.1）——重启后运行版本若仍 0.0.1，
 *   「重启后真的跑到 0.0.2」这条断言必须真红（fail / exit 1），证明断言有牙齿，不是假绿。
 *
 * 安装窗口内只轮询磁盘 / 台账（不依赖 UI）：桌面安装会重建页面，CDP 上下文随时可能失效；面板读取一律包 try/catch，
 * 失败原文进 raw（panel-read-failures），不允许把读不到编成 actual。
 */
import { cp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunManifest } from '../runtime/evidence.ts'
import { capturePluginManagerOperations } from '../runtime/evidence.ts'
import type { DesktopSession } from '../host/desktop-app.ts'
import { launchDesktopApp, stopDesktopByPort, stopDesktopByUserDataDir } from '../host/desktop-app.ts'
import { createWebProfileInHome, waitForProfileDir } from '../host/isolated-profile.ts'
import type { CliHostSession } from '../host/cli-host.ts'
import { startCliHost } from '../host/cli-host.ts'
import { readProfileManifest } from '../host/dsh-cli.ts'
import type { CdpClient as CdpClientType } from '../cdp/cdp-client.ts'
import { CdpClient, waitForPageTarget } from '../cdp/cdp-client.ts'
import type { LogEventRecord } from '../runtime/log-evidence.ts'
import { captureLogFiles, eventsOf } from '../runtime/log-evidence.ts'
import type { ScenarioFaultInjection } from '../runtime/scenario-runner.ts'
import { publishScenarioVariants, variantVersionOf } from '../runtime/scenario-runner.ts'
import type { PublishedFixture } from '../../fixtures/release/fixture-publisher.ts'
import { fixtureSpecOf } from '../runtime/fixture-environment.ts'
import { ensureDir, listFilesRecursive } from '../../tooling/fs-utils.ts'
import { isProcessAlive, sleep, waitFor } from '../../tooling/process.ts'
import type { PanelState } from './a-single-package-main-chain.ts'
import { captureShot, clickPanelAction, readPanelState, waitForFixtureLoaded } from './a-single-package-main-chain.ts'
import type { T3Run } from './t3-common.ts'
import { installedFixtureVersion, openT3Run, verifySutInstalled } from './t3-common.ts'
import { copyRunEvidence } from './batch-helpers.ts'
import { FIXTURE_REGISTRY_ENV, fixtureBridgeRouteOf, fixtureBuildTagPhoneOf, fixtureSlotOf } from '../../fixtures/identity/fixture-slots.ts'
import type { FixtureSlotKey } from '../../fixtures/identity/fixture-slots.ts'

/** 场景模式。 */
export type EnrollmentRestartMode = 'restart-truth' | 'unregistered-honesty' | 'can-red'

/** 场景入参（工具层透传）。 */
export interface EnrollmentRestartOptions {
  readonly worktree: string
  readonly runBaseDir: string
  readonly verdaccioInstallDir: string
  readonly esbuildPath: string
  readonly stamp?: string
  readonly maintainerHome?: string
  readonly mode: EnrollmentRestartMode
  /** false = 试错 run，不把证据复制进仓库（默认 true）。 */
  readonly syncEvidence?: boolean
}

const PROFILE_NAME = 'desktop'
const SLOT: FixtureSlotKey = 'a'
const PANEL_BANNER_WINDOW_MS = 60000
const DISK_WAIT_TIMEOUT_MS = 180000
const LEDGER_WAIT_TIMEOUT_MS = 90000
const RESTART_LOAD_TIMEOUT_MS = 180000
const TERMINAL_STATES = ['completed', 'restart-required', 'failed', 'interrupted']

/** 复用的场景 id（can-red 复用 I1）。 */
function scenarioIdOf(mode: EnrollmentRestartMode): string {
  if (mode === 'unregistered-honesty') return 'i2-unregistered-honesty'
  return 'i1-restart-enrollment-truth'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function strOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
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

/** profile 清单事实（dependencies / dsh.profile.bundles = 使用范围清单）。 */
interface ManifestFacts {
  readonly path: string
  readonly text: string
  readonly dependencies: Record<string, string> | null
  readonly bundles: string[] | null
}

async function readManifestFacts(homeDir: string, profileName: string): Promise<ManifestFacts> {
  const path = join(homeDir, 'profiles', profileName, 'package.json')
  const text = await readFile(path, 'utf8')
  let json: {
    dependencies?: Record<string, string>
    dsh?: { profile?: { bundles?: string[] } }
  } = {}
  try {
    json = JSON.parse(text) as typeof json
  } catch {
    json = {}
  }
  const bundles = json.dsh && json.dsh.profile && Array.isArray(json.dsh.profile.bundles) ? json.dsh.profile.bundles : null
  return { path, text, dependencies: json.dependencies || null, bundles }
}

/** 读面板状态；失败返回 error 原文（不允许编 actual）。 */
async function readPanelSafely(session: DesktopSession): Promise<{ ok: boolean; state: PanelState | null; error: string | null }> {
  try {
    const state = await readPanelState(session)
    return { ok: true, state, error: null }
  } catch (error) {
    return { ok: false, state: null, error: messageOf(error) }
  }
}

/**
 * 桌面自重启（安装后 relaunch）会换掉进程但复用同一调试端口；旧 CDP socket 失效时按端口重连，
 * 返回一个可继续 evaluate / screenshot 的会话视图（process 句柄仍是旧的，只用于端口与 pid 事实）。
 */
async function reconnectDesktop(session: DesktopSession): Promise<DesktopSession> {
  try {
    await session.cdp.evaluate('1')
    return session
  } catch {
    // 端口上的旧 socket 已断，继续走重连。
  }
  const target = await waitForPageTarget(session.port, { timeoutMs: 60000, urlIncludes: 'dsh-app' })
  const cdp: CdpClientType = await CdpClient.connect(target.webSocketDebuggerUrl as string)
  return {
    port: session.port,
    process: session.process,
    cdp,
    targets: [target],
  } as unknown as DesktopSession
}

/** 一次面板横幅采样。 */
interface BannerSample {
  readonly at: number
  readonly ok: boolean
  readonly present: boolean
  readonly banner: string | null
  readonly versions: readonly string[]
  readonly clientTag: string | null
  readonly hostTag: string | null
  readonly error: string | null
}

/**
 * 在窗口内反复读面板，收集横幅时间线；命中任一 acceptText 子串即提前返回。
 * 每次都先尝试重连（桌面自重启会断 CDP），单次失败只进样本不中断。
 */
async function collectBannerWindow(
  session: DesktopSession,
  windowMs: number,
  acceptTexts: readonly string[],
): Promise<{ samples: BannerSample[]; hit: string | null; state: PanelState | null; session: DesktopSession }> {
  const samples: BannerSample[] = []
  let hit: string | null = null
  let last: PanelState | null = null
  let current = session
  const deadline = Date.now() + windowMs
  while (Date.now() < deadline) {
    try {
      current = await reconnectDesktop(current)
      const state = await readPanelState(current)
      last = state
      const sample: BannerSample = {
        at: Date.now(),
        ok: true,
        present: state.present,
        banner: state.banner,
        versions: state.versions,
        clientTag: state.card ? state.card.clientTag : null,
        hostTag: state.card ? state.card.hostTag : null,
        error: null,
      }
      samples.push(sample)
      if (state.banner) {
        const found = acceptTexts.find((text) => (state.banner as string).indexOf(text) >= 0)
        if (found) {
          hit = found
          break
        }
      }
    } catch (error) {
      samples.push({
        at: Date.now(),
        ok: false,
        present: false,
        banner: null,
        versions: [],
        clientTag: null,
        hostTag: null,
        error: messageOf(error),
      })
    }
    await sleep(500)
  }
  return { samples, hit, state: last, session: current }
}

/** 轮询磁盘上夹具版本，直到目标版本或超时。 */
async function waitDiskVersion(options: {
  homeDir: string
  profileName: string
  packageName: string
  targetVersion: string
  timeoutMs: number
}): Promise<{ version: string | null; elapsedMs: number; samples: { at: number; version: string | null }[] }> {
  const startedAt = Date.now()
  const samples: { at: number; version: string | null }[] = []
  let version: string | null = null
  await waitFor(
    'profile 磁盘上的夹具版本到 ' + options.targetVersion,
    async () => {
      version = await installedFixtureVersion({
        homeDir: options.homeDir,
        profileName: options.profileName,
        packageName: options.packageName,
      }).catch(() => null)
      samples.push({ at: Date.now(), version })
      return version === options.targetVersion ? version : null
    },
    { timeoutMs: options.timeoutMs, intervalMs: 500 },
  )
  return { version, elapsedMs: Date.now() - startedAt, samples }
}

/** 等台账出现目标版本的终态成功条目；超时返回当前条目（断言层自己判）。 */
async function waitLedgerSuccess(options: {
  homeDir: string
  targetVersion: string
  timeoutMs: number
}): Promise<{ entries: LedgerEntry[]; elapsedMs: number }> {
  const startedAt = Date.now()
  let entries: LedgerEntry[] = []
  try {
    await waitFor(
      '台账出现目标版本终态',
      async () => {
        entries = await readLedgerStates(options.homeDir)
        const hit = entries.some(
          (entry) =>
            entry.state !== null &&
            entry.state['targetVersion'] === options.targetVersion &&
            typeof entry.state['state'] === 'string' &&
            TERMINAL_STATES.indexOf(entry.state['state'] as string) >= 0,
        )
        return hit ? true : null
      },
      { timeoutMs: options.timeoutMs, intervalMs: 1000 },
    )
  } catch {
    entries = await readLedgerStates(options.homeDir)
  }
  return { entries, elapsedMs: Date.now() - startedAt }
}

/** 停掉当前被托管实例 + 它自重启出来的所有实例（按端口 + --user-data-dir 双清）。 */
async function stopDesktopAll(run: T3Run, session: DesktopSession | null, tag: string): Promise<{ killed: number[]; port: number | null }> {
  const port = session ? session.port : null
  if (session) {
    const pid = session.process.pid() ?? null
    try {
      await session.close()
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
        run.addNote('按端口清桌面失败（' + tag + ' 第 ' + String(round + 1) + ' 轮）：' + messageOf(error))
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

/** 起一个被本 run 托管的隔离桌面实例（带首次失败清场重试）。 */
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
        // 清场失败也继续试——next launch 自己会报错。
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
  throw lastError || new Error('[i] 桌面实例启动失败')
}

/** I1 主流程（restart-truth / can-red 共用；can-red 只是 stale-variant 注入）。 */
async function runRestartTruth(run: T3Run, options: EnrollmentRestartOptions): Promise<void> {
  const slot = fixtureSlotOf(SLOT)
  const packageName = slot.packageName
  const fixtureEnv = run.fixtureEnv
  if (fixtureEnv === null) throw new Error('[i1] fixtureEnv 未初始化')
  const registryUrl = fixtureEnv.registry.baseUrl
  const homeDir = run.layout.homeDir
  const userDataDir = run.layout.userDataDir
  const canRed = options.mode === 'can-red'
  const variantVersion = variantVersionOf(run.scenario, SLOT)
  const baselineVersion = run.scenario.install.find((step) => step.slotKey === SLOT)?.version || ''
  if (!variantVersion) throw new Error('[i1] 场景声明缺少席位 a 的变体版本')

  await run.raw('isolation-facts', {
    hostChannel: 'desktop-official',
    homeDir,
    userDataDir,
    profileName: PROFILE_NAME,
    profileDir: join(homeDir, 'profiles', PROFILE_NAME),
    packageName,
    registryUrl,
    mode: options.mode,
  })
  await run.record({
    step: '隔离口径',
    what: '官方桌面实例使用仓库外隔离 home + 独立 --user-data-dir；registry 为本 run 本地 verdaccio',
    expected: 'homeDir=' + homeDir + '；userDataDir=' + userDataDir + '；profile=' + PROFILE_NAME,
    actual: 'homeDir=' + homeDir + '；userDataDir=' + userDataDir + '；profile=' + PROFILE_NAME,
    verdict: 'pass',
  })
  run.addNote('本场景走官方桌面通道（in-process pluginManager）；面板/在册事实只有桌面宿主有。')

  // ---- 1. 首启建 profile ----
  let session: DesktopSession | null = await launchDesktopManaged(run, { registryUrl, homeDir, userDataDir, tag: 'bootstrap' })
  await waitForProfileDir({ homeDir, profileName: PROFILE_NAME, timeoutMs: 120000 })
  await run.raw('desktop-first-launch', {
    port: session.port,
    pid: session.process.pid() ?? null,
    stdoutHead: session.stdout().slice(0, 2000),
    stderrHead: session.stderr().slice(0, 2000),
  })
  await run.record({
    step: '首启桌面建隔离 profile',
    what: 'launchDesktopApp 起来后等 profiles/desktop 目录出现',
    expected: 'profiles/desktop 出现；实例 pid 可记',
    actual: 'profileDir=' + join(homeDir, 'profiles', PROFILE_NAME) + '；pid=' + String(session.process.pid() ?? null),
    verdict: 'pass',
  })
  session = null
  await stopDesktopAll(run, session, 'bootstrap')

  // ---- 2. 装基版 + 钉 SUT ----
  await run.installBaseline({ homeDir, profileName: PROFILE_NAME, registryUrl })
  await verifySutInstalled(run, { homeDir, profileName: PROFILE_NAME, packageName })
  const baseDiskVersion = await installedFixtureVersion({ homeDir, profileName: PROFILE_NAME, packageName })
  const manifestBefore = await readManifestFacts(homeDir, PROFILE_NAME)
  await run.raw('manifest-before', {
    path: manifestBefore.path,
    text: manifestBefore.text,
    dependencies: manifestBefore.dependencies,
    bundles: manifestBefore.bundles,
  })
  await run.record({
    step: '更新前基版在盘且在册',
    what: 'CLI 装 ' + packageName + '@' + baselineVersion + ' 后读磁盘版本与 profile 清单（dependencies + dsh.profile.bundles）',
    expected: '磁盘=' + baselineVersion + '；dependencies 有该包=' + baselineVersion + '；bundles 含该包',
    actual:
      '磁盘=' + String(baseDiskVersion) +
      '；dependencies=' + JSON.stringify(manifestBefore.dependencies) +
      '；bundles=' + JSON.stringify(manifestBefore.bundles),
    verdict:
      baseDiskVersion === baselineVersion &&
      manifestBefore.dependencies !== null &&
      manifestBefore.dependencies[packageName] === baselineVersion &&
      manifestBefore.bundles !== null &&
      manifestBefore.bundles.indexOf(packageName) >= 0
        ? 'pass'
        : 'fail',
  })

  // ---- 3. 发布变体（can-red：stale-variant）----
  const baselinePublication = await run.publishBaseline()
  const publishedOld: PublishedFixture | undefined = baselinePublication[SLOT]
  const fault: ScenarioFaultInjection | undefined = canRed
    ? {
        kind: 'stale-variant',
        slotKey: SLOT,
        description: '发布 ' + packageName + '@' + variantVersion + ' 但内容固化在 ' + baselineVersion + '（验证「重启后运行=新版本」断言真会红）',
      }
    : undefined
  const publication = await publishScenarioVariants(run.scenario, fixtureEnv, fault, baselinePublication)
  const publishedVariant = publication.variants[SLOT]
  await run.raw('fixture-published-variant', {
    baselineSpec: publishedOld ? fixtureSpecOf(publishedOld) : null,
    variantSpec: publishedVariant ? fixtureSpecOf(publishedVariant) : null,
    injected: publication.injected,
    fault: fault || null,
  })
  await run.record({
    step: '变体版本已发布',
    what: '本地 verdaccio 发布 ' + packageName + '@' + variantVersion + (canRed ? '（can-red：内容固化为基版）' : ''),
    expected: fixtureSpecOf(publishedVariant),
    actual: fixtureSpecOf(publishedVariant) + '；injected=' + JSON.stringify(publication.injected),
    verdict: 'pass',
  })

  // ---- 4. 主实例：面板真 UI 检查 + 安装 ----
  session = await launchDesktopManaged(run, { registryUrl, homeDir, userDataDir, tag: 'main' })
  const mainPort = session.port
  const mainPid: number | null = session.process.pid() ?? null
  await run.raw('desktop-main-launch', { port: mainPort, pid: mainPid, url: 'dsh-app://app/' })
  let panelOld: PanelState | null = null
  panelOld = await waitForFixtureLoaded(session, RESTART_LOAD_TIMEOUT_MS)
  await run.raw('panel-old', panelOld)
  await run.record({
    step: '主实例面板加载基版',
    what: '等夹具卡片 + 更新面板从占位渲染成真实版本',
    expected: 'panel.present=true；card.clientTag=client v' + baselineVersion + '；card.hostTag=host v' + baselineVersion,
    actual: 'present=' + String(panelOld.present) + '；clientTag=' + String(panelOld.card ? panelOld.card.clientTag : null) + '；hostTag=' + String(panelOld.card ? panelOld.card.hostTag : null),
    verdict:
      panelOld.present &&
      panelOld.card !== null &&
      panelOld.card.clientTag === 'client v' + baselineVersion &&
      panelOld.card.hostTag === 'host v' + baselineVersion
        ? 'pass'
        : 'fail',
  })
  await captureShot(run.recorder, session, {
    step: 'panel-old',
    what: '安装前官方桌面夹具卡片与更新面板（基版 ' + baselineVersion + '）',
    expected: '卡片显示 client v' + baselineVersion + ' / host v' + baselineVersion,
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
  const panelChecked = await readPanelState(session)
  await run.raw('panel-after-check', panelChecked)
  await run.record({
    step: '真 UI 检查更新',
    what: '点面板「检查更新」后等版本条到 ' + variantVersion + ' 且安装按钮可点',
    expected: 'versions[2]=' + variantVersion + '；install.disabled=false',
    actual: 'versions=' + JSON.stringify(panelChecked.versions) + '；install=' + JSON.stringify(panelChecked.install),
    verdict:
      panelChecked.versions[2] === variantVersion && panelChecked.install !== null && panelChecked.install.disabled === false ? 'pass' : 'fail',
  })
  await captureShot(run.recorder, session, {
    step: 'panel-checked',
    what: '检查更新后的官方桌面面板（可安装 ' + variantVersion + '）',
    expected: '版本条显示 ' + variantVersion + ' 且安装按钮可点',
    actual: 'visible',
    verdict: 'pass',
  })

  const installClickAt = Date.now()
  await clickPanelAction(session, 'install')
  const disk = await waitDiskVersion({
    homeDir,
    profileName: PROFILE_NAME,
    packageName,
    targetVersion: variantVersion,
    timeoutMs: DISK_WAIT_TIMEOUT_MS,
  })
  await run.raw('disk-after-install', {
    packageName,
    targetVersion: variantVersion,
    version: disk.version,
    elapsedMs: disk.elapsedMs,
    samples: disk.samples,
  })
  await run.record({
    step: '安装完成（磁盘版本）',
    what: '点真 UI「安装」后只轮询磁盘 node_modules 版本（安装窗内不依赖 UI）',
    expected: '磁盘版本=' + variantVersion,
    actual: '磁盘=' + String(disk.version) + '；耗时≈' + String(disk.elapsedMs) + 'ms',
    verdict: disk.version === variantVersion ? 'pass' : 'fail',
  })

  const ledgerTerminal = await waitLedgerSuccess({ homeDir, targetVersion: variantVersion, timeoutMs: LEDGER_WAIT_TIMEOUT_MS })
  await run.raw('ledger-terminal', { elapsedMs: ledgerTerminal.elapsedMs, entries: ledgerTerminal.entries })

  // ---- 5. 安装完成后面板如实反映「已生效」（desktop-manager 是 in-process hot swap，不是写盘等重启）----
  // 实测（272-20261103T024651）：桌面管理器装完即在同一宿主进程里换掉插件两半，面板立刻
  // client/host = 0.0.2、台账 completed、没有 restart-required。所以这里断言的不是「说重启」，
  // 而是「说已是最新时，运行标记真的已经是新版本」——防止拿假绿糊弄。
  const acceptTexts = ['已是最新']
  const bannerWindow = await collectBannerWindow(session, 30000, acceptTexts)
  session = bannerWindow.session
  const bannerHit = bannerWindow.hit
  const bannerState = bannerWindow.state
  await run.raw('panel-banner-timeline', {
    windowMs: 30000,
    acceptTexts,
    hit: bannerHit,
    samples: bannerWindow.samples,
    lastState: bannerState,
  })
  const lastSample = bannerWindow.samples.length > 0 ? bannerWindow.samples[bannerWindow.samples.length - 1] : null
  const lastBanner = bannerState ? bannerState.banner : null
  const lastVersions = bannerState ? bannerState.versions : []
  const lastClientTag = bannerState && bannerState.card ? bannerState.card.clientTag : null
  const lastHostTag = bannerState && bannerState.card ? bannerState.card.hostTag : null
  await run.record({
    step: '安装完成后面板如实反映「已生效」（不是写盘假绿）',
    what: '桌面管理器装完但用户没有手动重启：面板说「已是最新」时，页面运行标记必须真的是 ' + variantVersion + '（client+host 两半都换）',
    expected: 'banner 含「已是最新」；card.clientTag=client v' + variantVersion + '；card.hostTag=host v' + variantVersion + '；versions[0]=' + variantVersion,
    actual:
      'hit=' + String(bannerHit) + '；banner=' + String(lastBanner) +
      '；clientTag=' + String(lastClientTag) + '；hostTag=' + String(lastHostTag) + '；versions=' + JSON.stringify(lastVersions),
    verdict:
      bannerHit !== null &&
      lastClientTag === 'client v' + variantVersion &&
      lastHostTag === 'host v' + variantVersion &&
      lastVersions[0] === variantVersion
        ? 'pass'
        : 'fail',
  })
  if (bannerHit !== null) {
    await captureShot(run.recorder, session, {
      step: 'panel-after-install',
      what: '安装完成（未手动重启）时的官方桌面面板：' + String(lastBanner),
      expected: '已是最新，且卡片运行标记 client/host = ' + variantVersion,
      actual: 'visible',
      verdict: 'pass',
    })
  }



  // ---- 6. 安装后清单 + 横幅文案（不许出现假的「重启后生效」）----
  const manifestAfterInstall = await readManifestFacts(homeDir, PROFILE_NAME)
  await run.raw('manifest-after-install', {
    path: manifestAfterInstall.path,
    text: manifestAfterInstall.text,
    dependencies: manifestAfterInstall.dependencies,
    bundles: manifestAfterInstall.bundles,
  })
  const installWindow = { from: installClickAt - 1000, to: installClickAt + disk.elapsedMs + 5000 }
  await run.record({
    step: '安装完成后面板没有假的「等重启」文案',
    what: '桌面管理器是 in-process 热换：装完后同一进程内已生效，横幅不应再说「重启宿主后生效」',
    expected: 'banner 不含「重启宿主后生效」',
    actual: 'banner=' + String(lastBanner),
    verdict: lastBanner !== null && lastBanner.indexOf('重启宿主后生效') >= 0 ? 'fail' : 'pass',
  })

  // ---- 7. 停宿主（装完才停，保证安装窗内没有外部干预）→ 日志/操作时序证据 ----
  const mainStop = await stopDesktopAll(run, session, 'main')
  session = null
  activeSession = null
  const execWindow = { from: installClickAt, to: Date.now() }
  const operations = await capturePluginManagerOperations({
    recorder: run.recorder,
    homeDir,
    profileName: PROFILE_NAME,
    window: { fromMs: execWindow.from, toMs: execWindow.to + 3000 },
  })
  await run.raw('plugin-manager-operations', operations)
  const logsBeforeRestart = await captureLogFiles(run.recorder, homeDir)
  const rawRows = await readRawLogRows(homeDir)
  const execRows = rawRows.filter((row) => row.event === 'update.install.exec')
  const hostStarts = rawRows.filter((row) => row.event === 'host.start')
  const hostStartsInInstallWindow = hostStarts.filter((row) => typeof row.ts === 'number' && row.ts >= installWindow.from && row.ts <= installWindow.to)
  const installRequestRows = rawRows.filter((row) => row.event === 'update.install.request')
  const wireRows = rawRows.filter((row) => row.event === 'update.wire.ready')
  await run.raw('no-restart-proof', {
    installWindow,
    hostStarts: hostStarts.map((row) => ({ ts: row.ts, pid: row.fields['pid'] ?? null, fields: row.fields })),
    hostStartsInInstallWindowCount: hostStartsInInstallWindow.length,
    execRows: execRows.map((row) => ({ ts: row.ts, fields: row.fields })),
    installRequestRows: installRequestRows.map((row) => ({ ts: row.ts, fields: row.fields })),
    wireRowsCount: wireRows.length,
    rawRows: rawRows.length,
  })
  const execFacts = execRows.map((row) => ({
    route: row.fields['route'] ?? null,
    ok: row.fields['ok'] ?? null,
    exitCode: row.fields['exitCode'] ?? null,
    durationMs: row.fields['durationMs'] ?? null,
    pluginId: row.fields['pluginId'] ?? null,
    ts: row.ts,
  }))
  await run.record({
    step: '安装执行恰一次（desktop-manager / 成功 / exit0）',
    what: '安装窗内 update.install.exec 行数、route、退出码、目标插件',
    expected: 'exec 行数=1；route=desktop-manager；ok=true；exitCode=0；pluginId=fxa-a',
    actual: 'exec=' + JSON.stringify(execFacts),
    verdict:
      execFacts.length === 1 &&
      execFacts[0].route === 'desktop-manager' &&
      execFacts[0].ok === true &&
      execFacts[0].exitCode === 0 &&
      execFacts[0].pluginId === 'fxa-a'
        ? 'pass'
        : 'fail',
  })
  await run.record({
    step: '安装窗内没有进程级重启（无 host.start）',
    what: '用法：若宿主在安装时自重启，安装窗内会出现新的 host.start 行；没有就是同一进程热换',
    expected: 'host.start 落在安装窗内的行数=0',
    actual: 'count=' + String(hostStartsInInstallWindow.length) + '；全部 host.start ts=' + JSON.stringify(hostStarts.map((row) => row.ts)),
    verdict: hostStartsInInstallWindow.length === 0 ? 'pass' : 'fail',
  })

  // ---- 8. 台账：恰一条成功终态 ----
  const ledgerTarget = ledgerTerminal.entries.filter((entry) => entry.state !== null && entry.state['targetVersion'] === variantVersion)
  const ledgerSuccess = ledgerTarget.filter(
    (entry) => entry.state !== null && typeof entry.state['state'] === 'string' && TERMINAL_STATES.indexOf(entry.state['state'] as string) >= 0 && entry.state['state'] !== 'failed' && entry.state['state'] !== 'interrupted',
  )
  await run.raw('ledger-facts', {
    entries: ledgerTerminal.entries.map((entry) => ({ file: entry.file, pluginId: entry.pluginId, state: entry.state, corrupt: entry.corrupt })),
    targetVersion: variantVersion,
    targetEntries: ledgerTarget.length,
    successEntries: ledgerSuccess.length,
  })
  await run.record({
    step: '台账恰一条成功终态（无重复/丢单）',
    what: '读 <home>/updates 下各级 state.json，按目标版本筛终态成功条目',
    expected: 'targetVersion=' + variantVersion + ' 的成功终态条目恰 1 条；previousVersion=' + baselineVersion,
    actual: '条目数=' + String(ledgerSuccess.length) + '；' + JSON.stringify(ledgerTarget.map((entry) => entry.state)),
    verdict:
      ledgerSuccess.length === 1 &&
      ledgerSuccess[0].state !== null &&
      ledgerSuccess[0].state['previousVersion'] === baselineVersion
        ? 'pass'
        : 'fail',
  })
  if (canRed) {
    run.addNote('can-red 档到此为止：唯一红点是「安装后运行标记仍为基版内容却宣称已是最新」（step 5），不继续重启断言以免掩盖红点。')
  } else {
    // ---- 9. 真重启（新进程 / 新 CDP 端口）→ 仍须是变体，不许回退 ----
    const restartStartedAt = Date.now()
    session = await launchDesktopManaged(run, { registryUrl, homeDir, userDataDir, tag: 'restart' })
    activeSession = session
    const restartPort = session.port
    const restartPid = session.process.pid() ?? null
    await run.raw('desktop-restart-launch', { port: restartPort, pid: restartPid, previousPort: mainPort, previousPid: mainPid, elapsedMs: Date.now() - restartStartedAt })
    const panelRestarted = await waitForFixtureLoaded(session, RESTART_LOAD_TIMEOUT_MS)
    await run.raw('panel-after-restart', panelRestarted)
    await run.record({
      step: '真重启后仍是新版本（不是装成说生效、重启回退）',
      what: '停掉主实例、起全新宿主实例后读面板运行标记',
      expected: 'card.clientTag=client v' + variantVersion + '；card.hostTag=host v' + variantVersion + '；versions[0]=' + variantVersion,
      actual:
        'clientTag=' + String(panelRestarted.card ? panelRestarted.card.clientTag : null) +
        '；hostTag=' + String(panelRestarted.card ? panelRestarted.card.hostTag : null) +
        '；versions=' + JSON.stringify(panelRestarted.versions),
      verdict:
        panelRestarted.card !== null &&
        panelRestarted.card.clientTag === 'client v' + variantVersion &&
        panelRestarted.card.hostTag === 'host v' + variantVersion &&
        panelRestarted.versions[0] === variantVersion
          ? 'pass'
          : 'fail',
    })
    await captureShot(run.recorder, session, {
      step: 'panel-after-restart',
      what: '真重启后的官方桌面面板（' + variantVersion + ' 仍生效）',
      expected: '卡片 client/host = ' + variantVersion,
      actual: 'visible',
      verdict: 'pass',
    })

    // ---- 10. 三面一致：清单（依赖 + 在册） / 磁盘 / 运行 ----
    const manifestAfterRestart = await readManifestFacts(homeDir, PROFILE_NAME)
    const diskAfterRestart = await installedFixtureVersion({ homeDir, profileName: PROFILE_NAME, packageName })
    const threeFace = {
      manifestPath: manifestAfterRestart.path,
      dependencies: manifestAfterRestart.dependencies,
      bundles: manifestAfterRestart.bundles,
      diskVersion: diskAfterRestart,
      runningClientTag: panelRestarted.card ? panelRestarted.card.clientTag : null,
      runningHostTag: panelRestarted.card ? panelRestarted.card.hostTag : null,
      runningVersion: panelRestarted.versions[0] ?? null,
    }
    await run.raw('three-face-after-restart', threeFace)
    await run.record({
      step: '三面一致（清单 / 磁盘 / 运行）',
      what: '重启后 profile 清单 dependencies+在册名单、磁盘包版本、页面运行标记三处同版本',
      expected:
        'dependencies[' + packageName + ']=' + variantVersion + '；bundles 含该包；磁盘=' + variantVersion + '；运行=' + variantVersion,
      actual: JSON.stringify(threeFace),
      verdict:
        manifestAfterRestart.dependencies !== null &&
        manifestAfterRestart.dependencies[packageName] === variantVersion &&
        manifestAfterRestart.bundles !== null &&
        manifestAfterRestart.bundles.indexOf(packageName) >= 0 &&
        diskAfterRestart === variantVersion &&
        threeFace.runningVersion === variantVersion
          ? 'pass'
          : 'fail',
    })
    const restartStop = await stopDesktopAll(run, session, 'restart')
    session = null
    activeSession = null
    void restartStop
    void mainStop
    void restartPort
    void restartPid
  }

  // ---- 11. 收尾：端口/进程无残留 ----
  if (session !== null) {
    await stopDesktopAll(run, session, 'cleanup')
    session = null
    activeSession = null
  }
  await run.registerPort('desktop-main-port', mainPort)
  const leftoverPids: { label: string; pid: number | null; alive: boolean }[] = []
  for (const item of run.cleanupProcesses) {
    if (item.pid === null) continue
    const alive = isProcessAlive(item.pid)
    leftoverPids.push({ label: item.label, pid: item.pid, alive })
  }
  await run.raw('cleanup-verify', { ports: run.cleanupPorts, leftoverPids })
  await run.record({
    step: '收尾清理（进程/端口无残留）',
    what: '停掉本 run 起过的桌面实例后按 pid 复核存活、按端口复核已释放',
    expected: '存活 pid 数=0；主实例端口已释放',
    actual: 'alive=' + JSON.stringify(leftoverPids.filter((item) => item.alive)) + '；ports=' + JSON.stringify(run.cleanupPorts),
    verdict: leftoverPids.filter((item) => item.alive).length === 0 && run.cleanupPorts.every((item) => item.released) ? 'pass' : 'fail',
  })
  run.addNote('i1 结论口径：desktop-manager 单插件安装是 in-process 热换（安装完成即同一宿主进程内 client+host 两半换到新版本，无 restart-required）；因此本格证明的是「面板说已是最新时运行标记真的是新版，且真重启后不回退」，不是「写盘等重启」。')
}

/** 读日志原始行（保留 ts，用于时间窗；readLogEvents 会丢掉 ts）。 */
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

/** 把 profile 清单 dependencies 里某个包钉到指定版本（I2 等价注入用）。 */
async function writeManifestDependency(options: { homeDir: string; profileName: string; packageName: string; version: string }): Promise<{ path: string; before: string; after: string; dependencies: Record<string, string> }> {
  const facts = await readManifestFacts(options.homeDir, options.profileName)
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(facts.text) as Record<string, unknown>
  } catch {
    json = {}
  }
  const dependencies = (json['dependencies'] && typeof json['dependencies'] === 'object' ? json['dependencies'] : {}) as Record<string, string>
  dependencies[options.packageName] = options.version
  json['dependencies'] = dependencies
  const after = JSON.stringify(json, null, 2) + '\n'
  await writeFile(facts.path, after)
  return { path: facts.path, before: facts.text, after, dependencies }
}

// ============================================================================================
// I2（A-prime，通道 B）：真安装 → 未重启真话 → 摘登记后真不加载 → 恢复登记后真加载
//
// P1 探针（runtime/t6-270/probes/p1-raw.json）实测：dsh web --profile desktop 被拒
// 「profile "desktop" is managed exclusively by the Electron application」，通道 B 只能吃非 desktop
// profile；官方桌面只吃 desktop profile。二者不能共享同一 profile，所以本格只用通道 B（普通 DSH web 宿主）。
// 等价边界：锁/队列/安装/台账/运行标记都是真机真值；桌面面板「pending-restart + 未登记」文案分支
// 在通道 B 不渲染，那一条走 known-red（见 docs/research/20261101-issue-272-enrollment-topology.md）。
// ============================================================================================

const I2_PROFILE_NAME = 't8i2'
const I2_STATUS_POLL_MS = 300
const I2_TERMINAL_TIMEOUT_MS = 180000
const I2_EXEC_WAIT_TIMEOUT_MS = 120000

interface I2RawRow {
  event: string
  ts: number | null
  fields: Record<string, unknown>
  source: string
  line: number
}

interface I2HostEntry {
  label: string
  host: CliHostSession
  pid: number | null
  port: number
  closed: boolean
}

interface I2JobFacts {
  id: string | null
  state: string | null
  targetVersion: string | null
  message: string | null
  requestId: string | null
}

interface I2Snapshot {
  runningVersion: string | null
  installed: boolean | null
  installedVersion: string | null
  latestVersion: string | null
  canInstall: boolean | null
  blockedReason: string | null
  registered: boolean | null
  job: I2JobFacts | null
}

interface I2PhoneOutcome {
  status: number
  durationMs: number
  body: Record<string, unknown>
  ok: boolean
  error: string | null
  errorKind: string | null
  fields: Record<string, unknown>
  replyValue: unknown
  snapshot: I2Snapshot | null
}

interface I2ExecWindow {
  start: number
  end: number
  ts: number
  durationMs: number
  route: string | null
  ok: boolean | null
  exitCode: number | null
  pluginId: string | null
  source: string
  line: number
}

interface I2StatusSample {
  t: number
  elapsedMs: number
  http: number
  ok: boolean
  error: string | null
  jobState: string | null
  targetVersion: string | null
  installedVersion: string | null
  runningVersion: string | null
  latestVersion: string | null
  blockedReason: string | null
  canInstall: boolean | null
  registered: boolean | null
}

function i2NumOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function i2BoolOf(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

/** 从电话回包的 reply 字段里解出更新快照（口径同 h-queue-lock/e-cli）。 */
function i2SnapshotOf(fields: Record<string, unknown>): I2Snapshot | null {
  const rawSnapshot = fields.snapshot
  if (rawSnapshot === null || rawSnapshot === undefined || typeof rawSnapshot !== 'object') return null
  const snapshot = rawSnapshot as Record<string, unknown>
  const rawJob = snapshot.job
  const job = rawJob !== null && rawJob !== undefined && typeof rawJob === 'object' ? (rawJob as Record<string, unknown>) : null
  return {
    runningVersion: strOf(snapshot.runningVersion),
    installed: i2BoolOf(snapshot.installed),
    installedVersion: strOf(snapshot.installedVersion),
    latestVersion: strOf(snapshot.latestVersion),
    canInstall: i2BoolOf(snapshot.canInstall),
    blockedReason: strOf(snapshot.blockedReason),
    registered: i2BoolOf(snapshot.registered),
    job:
      job === null
        ? null
        : {
            id: strOf(job.id),
            state: strOf(job.state),
            targetVersion: strOf(job.targetVersion),
            message: strOf(job.message),
            requestId: strOf(job.requestId),
          },
  }
}

/** 发一次电话并解析出回包；传输层失败也返回结构化结果（不让轮询因一次断连整段炸掉）。 */
async function i2CallPhone(host: CliHostSession, route: string, phone: string, args: Record<string, unknown> = {}): Promise<I2PhoneOutcome> {
  let reply: { status: number; body: unknown; durationMs: number }
  try {
    reply = await host.postPhone(route, phone, args)
  } catch (error) {
    return {
      status: 0,
      durationMs: 0,
      body: { transportError: messageOf(error) },
      ok: false,
      error: messageOf(error),
      errorKind: 'transport',
      fields: {},
      replyValue: null,
      snapshot: null,
    }
  }
  const body: Record<string, unknown> = reply.body !== null && reply.body !== undefined && typeof reply.body === 'object' ? (reply.body as Record<string, unknown>) : { rawText: String(reply.body) }
  const rawReply = body.reply
  const inner = rawReply !== null && rawReply !== undefined && typeof rawReply === 'object' ? (rawReply as Record<string, unknown>) : null
  const fields = inner ?? {}
  return {
    status: reply.status,
    durationMs: reply.durationMs,
    body,
    ok: inner !== null && typeof inner.ok === 'boolean' ? inner.ok === true : body.ok === true,
    error: strOf(inner !== null ? inner.error : body.error),
    errorKind: strOf(inner !== null ? inner.errorKind : body.errorKind),
    fields,
    replyValue: body.reply,
    snapshot: i2SnapshotOf(fields),
  }
}

function i2TerminalJobState(state: string | null | undefined): boolean {
  return state === 'completed' || state === 'restart-required' || state === 'failed' || state === 'interrupted'
}

/** 夹具 buildTag 电话没有 ok 字段：优先取 reply.buildTag，退回落成字符串的 reply 本身。 */
function i2BuildTagValueOf(outcome: I2PhoneOutcome): string | null {
  const fromFields = strOf(outcome.fields.buildTag)
  if (fromFields !== null) return fromFields
  const direct = strOf(outcome.replyValue)
  if (direct !== null) return direct
  const innerReply = outcome.fields.reply
  if (innerReply !== null && innerReply !== undefined && typeof innerReply === 'object') return strOf((innerReply as Record<string, unknown>).buildTag)
  return null
}

function i2DescribeOutcome(label: string, outcome: I2PhoneOutcome): string {
  return (
    label +
    '：ok=' + String(outcome.ok) +
    '；status=' + String(outcome.status) +
    '；error=' + String(outcome.error) +
    '；job=' + JSON.stringify(outcome.snapshot?.job ?? null) +
    '；installed=' + String(outcome.snapshot?.installedVersion) +
    '；running=' + String(outcome.snapshot?.runningVersion)
  )
}

/** 把 update.install.exec 行还原成安装窗口 [ts-durationMs, ts]。 */
function i2ExecWindowsOf(rows: I2RawRow[]): I2ExecWindow[] {
  const windows: I2ExecWindow[] = []
  for (const row of rows) {
    if (row.event !== 'update.install.exec') continue
    const durationMs = i2NumOf(row.fields.durationMs)
    const ts = row.ts
    if (durationMs === null || ts === null) continue
    windows.push({
      start: ts - durationMs,
      end: ts,
      ts,
      durationMs,
      route: strOf(row.fields.route),
      ok: i2BoolOf(row.fields.ok),
      exitCode: i2NumOf(row.fields.exitCode),
      pluginId: strOf(row.fields.pluginId),
      source: row.source,
      line: row.line,
    })
  }
  return windows
}

async function i2WaitForExecRows(homeDir: string, minCount: number, timeoutMs: number): Promise<I2RawRow[]> {
  const deadline = Date.now() + timeoutMs
  let rows = await readRawLogRows(homeDir)
  while (Date.now() < deadline && i2ExecWindowsOf(rows).length < minCount) {
    await sleep(250)
    rows = await readRawLogRows(homeDir)
  }
  return rows
}

/** 轮询 updateStatus 直到作业终态；每次采样只留判定要用的字段（时间线进 raw）。 */
async function i2PollStatusUntilTerminal(
  host: CliHostSession,
  route: string,
  statusPhone: string,
  timeoutMs: number,
  intervalMs: number,
): Promise<{ samples: I2StatusSample[]; terminal: I2PhoneOutcome | null; last: I2PhoneOutcome | null; timedOut: boolean }> {
  const startedAt = Date.now()
  const samples: I2StatusSample[] = []
  let last: I2PhoneOutcome | null = null
  while (Date.now() - startedAt < timeoutMs) {
    const outcome = await i2CallPhone(host, route, statusPhone, {})
    last = outcome
    samples.push({
      t: Date.now(),
      elapsedMs: Date.now() - startedAt,
      http: outcome.status,
      ok: outcome.ok,
      error: outcome.error,
      jobState: outcome.snapshot?.job?.state ?? null,
      targetVersion: outcome.snapshot?.job?.targetVersion ?? null,
      installedVersion: outcome.snapshot?.installedVersion ?? null,
      runningVersion: outcome.snapshot?.runningVersion ?? null,
      latestVersion: outcome.snapshot?.latestVersion ?? null,
      blockedReason: outcome.snapshot?.blockedReason ?? null,
      canInstall: outcome.snapshot?.canInstall ?? null,
      registered: outcome.snapshot?.registered ?? null,
    })
    if (i2TerminalJobState(outcome.snapshot?.job?.state ?? null)) {
      return { samples, terminal: outcome, last, timedOut: false }
    }
    await sleep(intervalMs)
  }
  return { samples, terminal: null, last, timedOut: true }
}

/** 等宿主能回答 updateStatus（宿主 boot + 夹具/更新面板加载完成）。 */
async function i2WaitStatusReady(host: CliHostSession, route: string, statusPhone: string, timeoutMs: number): Promise<I2PhoneOutcome | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const outcome = await i2CallPhone(host, route, statusPhone, {})
    if (outcome.ok && outcome.snapshot !== null) return outcome
    await sleep(500)
  }
  return null
}

/**
 * 摘掉/写回 profile 清单里的「在册」事实（等价注入）。
 *
 * 与产品 src/core/reader.ts:355-361 同口径：清单有 dsh.profile.bundles 层就以它为准，否则退回 dependencies。
 * 原始清单 before/after 全部回传（进 raw），不在断言里编 actual。
 */
async function rewriteEnrollment(options: {
  homeDir: string
  profileName: string
  packageName: string
  present: boolean
  version?: string
}): Promise<{
  path: string
  mode: 'bundles' | 'dependencies'
  before: string
  after: string
  bundlesBefore: string[] | null
  bundlesAfter: string[] | null
  dependenciesBefore: Record<string, string> | null
  dependenciesAfter: Record<string, string> | null
  changed: boolean
}> {
  const facts = await readManifestFacts(options.homeDir, options.profileName)
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(facts.text) as Record<string, unknown>
  } catch {
    json = {}
  }
  const rawDependencies = json['dependencies']
  const dependencies = (rawDependencies !== null && rawDependencies !== undefined && typeof rawDependencies === 'object' ? rawDependencies : {}) as Record<string, string>
  const dependenciesBefore = facts.dependencies !== null ? { ...facts.dependencies } : null
  let mode: 'bundles' | 'dependencies' = 'dependencies'
  let bundlesAfter: string[] | null = null
  if (facts.bundles !== null) {
    mode = 'bundles'
    const rawDsh = json['dsh']
    const dsh = (rawDsh !== null && rawDsh !== undefined && typeof rawDsh === 'object' ? rawDsh : {}) as Record<string, unknown>
    const rawProfile = dsh['profile']
    const profile = (rawProfile !== null && rawProfile !== undefined && typeof rawProfile === 'object' ? rawProfile : {}) as Record<string, unknown>
    const current = Array.isArray(profile['bundles']) ? (profile['bundles'] as string[]).slice() : []
    const filtered = current.filter((name) => name !== options.packageName)
    bundlesAfter = options.present && filtered.indexOf(options.packageName) < 0 ? filtered.concat([options.packageName]) : filtered
    profile['bundles'] = bundlesAfter
    dsh['profile'] = profile
    json['dsh'] = dsh
  } else if (options.present) {
    dependencies[options.packageName] = options.version || dependencies[options.packageName] || ''
  } else {
    delete dependencies[options.packageName]
  }
  json['dependencies'] = dependencies
  const after = JSON.stringify(json, null, 2) + '\n'
  await writeFile(facts.path, after)
  return {
    path: facts.path,
    mode,
    before: facts.text,
    after,
    bundlesBefore: facts.bundles !== null ? facts.bundles.slice() : null,
    bundlesAfter,
    dependenciesBefore,
    dependenciesAfter: { ...dependencies },
    changed: after !== facts.text,
  }
}

/** 取页面 HTTP 事实（未加载场景的辅助证据；不驱动 UI）。 */
async function i2FetchPage(url: string): Promise<{ ok: boolean; status: number; length: number; head: string; error: string | null }> {
  try {
    const response = await fetch(url, { redirect: 'manual' })
    const text = await response.text()
    return { ok: true, status: response.status, length: text.length, head: text.slice(0, 3000), error: null }
  } catch (error) {
    return { ok: false, status: 0, length: 0, head: '', error: messageOf(error) }
  }
}

/** I2 主流程（A-prime，通道 B）。 */
async function runUnregisteredHonesty(run: T3Run, options: EnrollmentRestartOptions): Promise<void> {
  const slot = fixtureSlotOf(SLOT)
  const packageName = slot.packageName
  const fixtureEnv = run.fixtureEnv
  if (fixtureEnv === null) throw new Error('[i2] fixtureEnv 未初始化')
  const registryUrl = fixtureEnv.registry.baseUrl
  const phonePrefix = slot.selfTargetPrefix
  if (!phonePrefix) throw new Error('[i2] 夹具席位缺单插件电话前缀')
  const route = fixtureBridgeRouteOf(slot)
  const checkPhone = phonePrefix + '.updateCheck'
  const installPhone = phonePrefix + '.updateInstall'
  const statusPhone = phonePrefix + '.updateStatus'
  const buildTagPhone = fixtureBuildTagPhoneOf(slot)
  const variantVersion = variantVersionOf(run.scenario, SLOT)
  const baselineStep = run.scenario.install.find((step) => step.slotKey === SLOT)
  if (!variantVersion) throw new Error('[i2] 场景声明缺少席位 ' + SLOT + ' 的变体版本')
  if (!baselineStep) throw new Error('[i2] 场景声明缺少席位 ' + SLOT + ' 的基版')

  const osHomeDir = join(run.layout.root, 'os-home')
  const homeDir = join(osHomeDir, '.dsh')
  await ensureDir(osHomeDir)
  await ensureDir(homeDir)
  const started: I2HostEntry[] = []
  let current: I2HostEntry | null = null

  async function startHost(label: string): Promise<CliHostSession> {
    const host = await startCliHost({ homeDir, osHomeDir, profileName: I2_PROFILE_NAME, extraEnv: { [FIXTURE_REGISTRY_ENV]: registryUrl } })
    const entry: I2HostEntry = { label, host, pid: host.pid() ?? null, port: host.port, closed: false }
    started.push(entry)
    current = entry
    await run.raw('cli-host-launch-' + label, {
      url: host.url,
      port: host.port,
      bootMs: host.bootMs,
      profileName: host.profileName,
      homeDir,
      pid: entry.pid,
      stdoutTail: host.stdout().slice(-3000),
      stderrTail: host.stderr().slice(-3000),
    })
    return host
  }

  async function closeCurrent(tag: string): Promise<void> {
    if (current === null) return
    const entry = current
    current = null
    entry.closed = true
    await entry.host.close().catch(() => undefined)
    run.registerProcess('cli-host-' + entry.label, entry.pid)
    await run.registerPort('cli-host-' + entry.label + '-port', entry.port)
    await run.raw('cli-host-close-' + tag, {
      label: entry.label,
      pid: entry.pid,
      port: entry.port,
      pidAlive: entry.pid === null ? null : isProcessAlive(entry.pid),
    })
  }

  // ---- 1. 隔离口径（通道 B）----
  await run.raw('isolation-facts', {
    hostChannel: 'dsh-web',
    osHomeDir,
    homeDir,
    profileName: I2_PROFILE_NAME,
    profileDir: join(homeDir, 'profiles', I2_PROFILE_NAME),
    route,
    phones: { checkPhone, installPhone, statusPhone, buildTagPhone },
    why:
      '通道 B 宿主是普通 DSH web 进程：它 spawn 的 CLI 子进程会剥掉 DSH_* 并按 USERPROFILE 解析 homedir()/.dsh，' +
      '所以 homeDir 必须正好是 USERPROFILE/.dsh；profile 名不能用 desktop（P1 探针实测 CLI 拒绝）。',
  })
  await run.record({
    step: '隔离口径（通道 B：普通 DSH web 宿主 + 非 desktop profile）',
    what: '本格只用普通 DSH web 宿主；官方桌面不参与（P1：dsh web --profile desktop 被拒「managed exclusively by the Electron application」）',
    expected: 'homeDir=' + homeDir + '；profile=' + I2_PROFILE_NAME + '；homeDir=osHomeDir/.dsh',
    actual: 'osHomeDir=' + osHomeDir + '；homeDir=' + homeDir + '；profile=' + I2_PROFILE_NAME,
    verdict: homeDir === join(osHomeDir, '.dsh') ? 'pass' : 'fail',
  })
  run.addNote(
    'i2 口径（A-prime）：官方桌面只吃 desktop profile、通道 B 只吃非 desktop profile（P1 探针），二者不能共享同一 profile；' +
      '本格因此用通道 B 把「真安装 → 未重启真话 → 摘登记后真不加载 → 恢复登记后真加载」整条链跑在真机上。',
  )

  // ---- 2. 建普通 profile ----
  const profile = await createWebProfileInHome({ homeDir, profileName: I2_PROFILE_NAME })
  const profileDir = profile.profileDir
  await run.raw('profile-create', {
    exitCode: profile.create.exitCode,
    stdout: profile.create.stdout,
    stderr: profile.create.stderr,
    profileDir,
  })
  await run.record({
    step: '建普通 profile（通道 B 宿主的使用范围）',
    what: '用官方发行 CLI 在隔离 home 建普通 DSH 使用范围 ' + I2_PROFILE_NAME,
    expected: 'exit=0；profileDir=' + join(homeDir, 'profiles', I2_PROFILE_NAME),
    actual: 'exit=' + String(profile.create.exitCode) + '；profileDir=' + profileDir,
    verdict: profile.create.exitCode === 0 ? 'pass' : 'fail',
  })

  // ---- 3. 装基版 + SUT 钉住 ----
  await run.installBaseline({ homeDir, profileName: I2_PROFILE_NAME, registryUrl })
  await verifySutInstalled(run, { homeDir, profileName: I2_PROFILE_NAME, packageName })
  const baseDisk = await installedFixtureVersion({ homeDir, profileName: I2_PROFILE_NAME, packageName })
  const baseManifest = await readManifestFacts(homeDir, I2_PROFILE_NAME)
  const baseEnrolled = baseManifest.bundles !== null ? baseManifest.bundles.indexOf(packageName) >= 0 : baseManifest.dependencies !== null && baseManifest.dependencies[packageName] === baselineStep.version
  await run.raw('manifest-baseline', {
    path: baseManifest.path,
    text: baseManifest.text,
    dependencies: baseManifest.dependencies,
    bundles: baseManifest.bundles,
    enrollmentMode: baseManifest.bundles !== null ? 'bundles' : 'dependencies',
    packageName,
  })
  await run.record({
    step: '更新前基版在盘且在册',
    what: '隔离 profile 里装着场景声明的基版 ' + baselineStep.version + '；profile 清单按产品口径（bundles 层优先、否则 dependencies）确认在册',
    expected: '磁盘=' + baselineStep.version + '；在册=true；清单依赖含该包',
    actual: '磁盘=' + String(baseDisk) + '；在册=' + String(baseEnrolled) + '；dependencies=' + JSON.stringify(baseManifest.dependencies) + '；bundles=' + JSON.stringify(baseManifest.bundles),
    verdict: baseDisk === baselineStep.version && baseEnrolled ? 'pass' : 'fail',
  })

  // ---- 4. 发布变体（更新目标）----
  const baselinePublication = await run.publishBaseline()
  const publication = await publishScenarioVariants(run.scenario, fixtureEnv, undefined, baselinePublication)
  const publishedVariant = publication.variants[SLOT]
  if (!publishedVariant) throw new Error('[i2] 变体发布失败：' + SLOT)
  await run.raw('fixture-published-variant', {
    baseline: baselineStep.version,
    variant: variantVersion,
    variantSpec: fixtureSpecOf(publishedVariant),
    injected: publication.injected,
  })
  await run.record({
    step: '变体版本已发布（更新目标）',
    what: '本地 verdaccio 发布 ' + packageName + '@' + variantVersion,
    expected: fixtureSpecOf(publishedVariant),
    actual: fixtureSpecOf(publishedVariant) + '；injected=' + JSON.stringify(publication.injected),
    verdict: 'pass',
  })

  // ---- 5. 起通道 B 宿主（主实例）→ 基线快照 ----
  const hostMain = await startHost('main')
  const statusBaseline = await i2WaitStatusReady(hostMain, route, statusPhone, 90000)
  await run.raw('phone-status-baseline', {
    status: statusBaseline?.status ?? null,
    durationMs: statusBaseline?.durationMs ?? null,
    body: statusBaseline?.body ?? null,
  })
  await run.record({
    step: '通道 B 宿主能加载夹具并回答 updateStatus（基线快照）',
    what: '宿主 boot 后向夹具 bridge 发 updateStatus：运行版/已装版都应是基版 ' + baselineStep.version,
    expected: 'ok=true；runningVersion=' + baselineStep.version + '；installedVersion=' + baselineStep.version,
    actual: statusBaseline === null ? '没有可用快照' : 'runningVersion=' + String(statusBaseline.snapshot?.runningVersion) + '；installedVersion=' + String(statusBaseline.snapshot?.installedVersion),
    verdict: statusBaseline !== null && statusBaseline.snapshot?.runningVersion === baselineStep.version && statusBaseline.snapshot?.installedVersion === baselineStep.version ? 'pass' : 'fail',
  })
  const buildTagBaselineOutcome = await i2CallPhone(hostMain, route, buildTagPhone, {})
  const buildTagBaseline = i2BuildTagValueOf(buildTagBaselineOutcome)
  await run.raw('fixture-build-tag-baseline', { status: buildTagBaselineOutcome.status, body: buildTagBaselineOutcome.body, value: buildTagBaseline })
  await run.record({
    step: '宿主进程里跑的是基版构建（buildTag 自证）',
    what: '夹具 host half 的 buildTag 电话返回编译期烧入的标记；更新前应是基版',
    expected: 'buildTag=host v' + baselineStep.version,
    actual: 'buildTag=' + String(buildTagBaseline),
    verdict: buildTagBaseline === 'host v' + baselineStep.version ? 'pass' : 'fail',
  })

  // ---- 6. 真机 updateCheck：发现变体 ----
  const check = await i2CallPhone(hostMain, route, checkPhone, { trigger: 'user' })
  const checkReceipt = check.fields.receipt !== null && check.fields.receipt !== undefined && typeof check.fields.receipt === 'object' ? (check.fields.receipt as Record<string, unknown>) : null
  const checkId = checkReceipt !== null ? strOf(checkReceipt.checkId) ?? '' : ''
  await run.raw('phone-update-check', { status: check.status, durationMs: check.durationMs, body: check.body })
  await run.record({
    step: '宿主电话入口 updateCheck：发现 ' + variantVersion + ' 可装',
    what: '夹具 bridge 的真实电话 updateCheck 返回快照与候选凭证 checkId',
    expected: 'ok=true；runningVersion=' + baselineStep.version + '；latestVersion=' + variantVersion + '；canInstall=true；checkId 非空',
    actual: 'ok=' + String(check.ok) + '；runningVersion=' + String(check.snapshot?.runningVersion) + '；latestVersion=' + String(check.snapshot?.latestVersion) + '；canInstall=' + String(check.snapshot?.canInstall) + '；checkId=' + JSON.stringify(checkId),
    verdict:
      check.ok &&
      check.snapshot?.runningVersion === baselineStep.version &&
      check.snapshot?.latestVersion === variantVersion &&
      check.snapshot?.canInstall === true &&
      checkId !== ''
        ? 'pass'
        : 'fail',
  })

  // ---- 7. 真机 updateInstall：受理（不是终态）----
  const requestId = 'i2-install-' + Date.now()
  const installReply = await i2CallPhone(hostMain, route, installPhone, { checkId, requestId, from: 'panel' })
  const replyJobState = installReply.snapshot?.job?.state ?? null
  await run.raw('phone-update-install', { checkId, requestId, status: installReply.status, durationMs: installReply.durationMs, body: installReply.body })
  await run.record({
    step: '安装电话被受理（快照仍是「安装中」，不是终态）',
    what: '产品 install() 先 saveJob(installing) 再立即返回快照（src/core/service.ts:1027-1120），所以回包只证明「受理」，终态要轮询 updateStatus/读 verify 行',
    expected: 'ok=true；job.state ∈ {installing, verifying}；runningVersion 仍 ' + baselineStep.version,
    actual: i2DescribeOutcome('install', installReply),
    verdict: installReply.ok && (replyJobState === 'installing' || replyJobState === 'verifying') && installReply.snapshot?.runningVersion === baselineStep.version ? 'pass' : 'fail',
    note: 'Lead 原口径「安装回包 blockedReason=pending-restart」与产品实现不符：安装回包此刻 job=installing、blockedReason=null；安装瞬间真话由下一步 update.install.verify 行耐久证明。',
  })

  // ---- 8. 等到终态（时间线进 raw）----
  const timeline = await i2PollStatusUntilTerminal(hostMain, route, statusPhone, I2_TERMINAL_TIMEOUT_MS, I2_STATUS_POLL_MS)
  await run.raw('install-status-timeline', {
    samples: timeline.samples,
    terminalBody: timeline.terminal?.body ?? null,
    timedOut: timeline.timedOut,
    pollMs: I2_STATUS_POLL_MS,
  })
  await run.record({
    step: '安装作业走到终态',
    what: '轮询同一宿主的 updateStatus，直到 job.state ∈ 终态集合',
    expected: 'timedOut=false；job.state ∈ 终态',
    actual: 'job.state=' + String(timeline.terminal?.snapshot?.job?.state ?? null) + '；samples=' + String(timeline.samples.length) + '；timedOut=' + String(timeline.timedOut),
    verdict: timeline.timedOut === false && i2TerminalJobState(timeline.terminal?.snapshot?.job?.state ?? null) ? 'pass' : 'fail',
  })

  // ---- 9. exec 行：真安装恰一次、走 cli-process ----
  const rowsAfterInstall = await i2WaitForExecRows(homeDir, 1, I2_EXEC_WAIT_TIMEOUT_MS)
  const execWindows = i2ExecWindowsOf(rowsAfterInstall)
  const exec = execWindows[0] ?? null
  await run.raw('update-install-exec-rows', { count: execWindows.length, windows: execWindows })
  await run.record({
    step: '恰一次真实安装（route=cli-process / ok=true / exit=0）',
    what: '日志 update.install.exec 行还原安装窗口 [ts-durationMs, ts]；通道 B 的安装出口是 cli-process',
    expected: 'exec 行数=1；route=cli-process；ok=true；exitCode=0；durationMs>0；pluginId=' + phonePrefix,
    actual: 'exec=' + JSON.stringify(execWindows),
    verdict:
      execWindows.length === 1 &&
      exec !== null &&
      exec.route === 'cli-process' &&
      exec.ok === true &&
      exec.exitCode === 0 &&
      exec.durationMs > 0 &&
      exec.pluginId === phonePrefix
        ? 'pass'
        : 'fail',
  })

  // ---- 10. verify 行：安装瞬间的真话（restart-required / pendingRestart=true）----
  const verifyRows = rowsAfterInstall.filter((row) => row.event === 'update.install.verify')
  const verifyFacts = verifyRows.map((row) => ({
    ts: row.ts,
    result: strOf(row.fields.result),
    pendingRestart: i2BoolOf(row.fields.pendingRestart),
    installedVersion: strOf(row.fields.installedVersion),
    targetVersion: strOf(row.fields.targetVersion),
    previousVersion: strOf(row.fields.previousVersion),
    source: row.source,
    line: row.line,
  }))
  const pendingTruth = verifyFacts.some((item) => item.result === 'restart-required' && item.pendingRestart === true)
  await run.raw('update-install-verify-rows', verifyFacts)
  await run.record({
    step: '安装瞬间的真话：verify 行 = restart-required / pendingRestart=true',
    what: '产品 service.ts:862-866 在安装验证后落 update.install.verify；进程未重启时应报 restart-required 且 pendingRestart=true（不假称已生效）',
    expected: '存在 verify 行：result=restart-required；pendingRestart=true',
    actual: 'verify 行=' + JSON.stringify(verifyFacts),
    verdict: pendingTruth ? 'pass' : 'fail',
  })

  // ---- 11. 未重启：磁盘已是新版，宿主进程仍跑基版（buildTag 自证）----
  const diskAfterInstall = await installedFixtureVersion({ homeDir, profileName: I2_PROFILE_NAME, packageName })
  const buildTagBeforeRestartOutcome = await i2CallPhone(hostMain, route, buildTagPhone, {})
  const buildTagBeforeRestart = i2BuildTagValueOf(buildTagBeforeRestartOutcome)
  await run.raw('build-tag-after-install-before-restart', {
    status: buildTagBeforeRestartOutcome.status,
    body: buildTagBeforeRestartOutcome.body,
    value: buildTagBeforeRestart,
    diskVersion: diskAfterInstall,
  })
  await run.record({
    step: '未重启：磁盘已是 ' + variantVersion + '，但宿主进程仍跑基版（不热换）',
    what: '安装完成后不重启，直接读磁盘版本与宿主内 host half 的 buildTag：磁盘应更新，运行标记应仍是基版',
    expected: '磁盘=' + variantVersion + '；buildTag=host v' + baselineStep.version,
    actual: '磁盘=' + String(diskAfterInstall) + '；buildTag=' + String(buildTagBeforeRestart),
    verdict: diskAfterInstall === variantVersion && buildTagBeforeRestart === 'host v' + baselineStep.version ? 'pass' : 'fail',
  })

  // ---- 12. 未重启时 updateStatus 的终态声明（产品真相边界）----
  const terminalState = timeline.terminal?.snapshot?.job?.state ?? null
  await sleep(1000)
  const settledStatus = await i2CallPhone(hostMain, route, statusPhone, {})
  const settledClaim = settledStatus.snapshot?.job?.state ?? null
  const claimedEffective = settledClaim === 'completed' && settledStatus.snapshot?.runningVersion === variantVersion
  await run.raw('pre-restart-terminal-claim', {
    terminalState,
    settledJobState: settledClaim,
    settledRunningVersion: settledStatus.snapshot?.runningVersion ?? null,
    settledInstalledVersion: settledStatus.snapshot?.installedVersion ?? null,
    settledBlockedReason: settledStatus.snapshot?.blockedReason ?? null,
    settledCanInstall: settledStatus.snapshot?.canInstall ?? null,
    buildTag: buildTagBeforeRestart,
    note: claimedEffective
      ? 'CLI-process 宿主没有权威 runningVersion：getSharedReader 按磁盘包解析（src/host/capabilities.ts:142-168），装完/未重启时 updateStatus 把作业 heal 成 completed 并宣称 running 新版本，而 buildTag 自证进程仍在基版。'
      : '未重启时 updateStatus 没有宣称已生效。',
  })
  await run.record({
    step: '未重启时 updateStatus 的运行版真话（产品真相边界）',
    what: '同宿主同进程装完后看 updateStatus：未重启不得宣称运行版已生效；restart-required + blockedReason=pending-restart 才是产品应有真话。completed 且 runningVersion=新版表示产品按磁盘解析了运行版（进程未重启）',
    expected: '未重启不得宣称 runningVersion=0.0.2：job.state=restart-required 且 blockedReason=pending-restart（产品应有真话）',
    actual: 'job.state=' + String(settledClaim) + '；blockedReason=' + String(settledStatus.snapshot?.blockedReason ?? null) + '；runningVersion=' + String(settledStatus.snapshot?.runningVersion ?? null) + '；buildTag=' + String(buildTagBeforeRestart),
    verdict: claimedEffective ? 'known-red' : 'pass',
    note: claimedEffective
      ? 'known-red（已裁决）：集成方未注入 ReaderOverrides.runningVersion 时，CLI 通道安装后 updateStatus 把运行版按磁盘解析并宣称 completed（reader.ts:434 / capabilities.ts:142-168）；规避=update.install.verify 行 pendingRestart=true 才是安装瞬间真话。buildTag 与磁盘证据证明进程仍跑基版。' 
      : '终态未宣称已生效。',
  })

  // ---- 13. 摘掉在册登记（原始清单前后入 raw）----
  await closeCurrent('before-unregister')
  const unregister = await rewriteEnrollment({ homeDir, profileName: I2_PROFILE_NAME, packageName, present: false })
  const noLongerEnrolled = unregister.bundlesAfter !== null ? unregister.bundlesAfter.indexOf(packageName) < 0 : unregister.dependenciesAfter !== null && !Object.prototype.hasOwnProperty.call(unregister.dependenciesAfter, packageName)
  const diskStillThere = await installedFixtureVersion({ homeDir, profileName: I2_PROFILE_NAME, packageName })
  await run.raw('manifest-unregister', {
    mode: unregister.mode,
    path: unregister.path,
    before: unregister.before,
    after: unregister.after,
    bundlesBefore: unregister.bundlesBefore,
    bundlesAfter: unregister.bundlesAfter,
    dependenciesBefore: unregister.dependenciesBefore,
    dependenciesAfter: unregister.dependenciesAfter,
    changed: unregister.changed,
    diskVersion: diskStillThere,
  })
  await run.record({
    step: '摘掉在册登记（等价注入；原始清单前后入 raw）',
    what: '把 ' + packageName + ' 移出 profile 使用范围清单（' + unregister.mode + ' 口径），模拟用户/宿主把插件移出使用范围；node_modules 磁盘包不动',
    expected: '清单在册口径不含该包；磁盘包仍在=' + variantVersion,
    actual: 'mode=' + unregister.mode + '；changed=' + String(unregister.changed) + '；磁盘=' + String(diskStillThere),
    verdict: noLongerEnrolled && diskStillThere === variantVersion ? 'pass' : 'fail',
  })

  // ---- 14. 真重启：夹具确实不加载 ----
  const unregisterRestartAt = Date.now()
  const hostUnregistered = await startHost('unregistered')
  const pageUnregistered = await i2FetchPage(hostUnregistered.url)
  await run.raw('page-after-unregister-restart', {
    status: pageUnregistered.status,
    ok: pageUnregistered.ok,
    length: pageUnregistered.length,
    head: pageUnregistered.head,
    hostStdoutTail: hostUnregistered.stdout().slice(-3000),
    hostStderrTail: hostUnregistered.stderr().slice(-3000),
  })
  const fixturePhoneAfterUnregister = await i2CallPhone(hostUnregistered, route, buildTagPhone, {})
  const buildTagAfterUnregister = i2BuildTagValueOf(fixturePhoneAfterUnregister)
  const fixtureLoaded = fixturePhoneAfterUnregister.ok && buildTagAfterUnregister !== null
  await run.raw('fixture-phone-after-unregister', {
    status: fixturePhoneAfterUnregister.status,
    durationMs: fixturePhoneAfterUnregister.durationMs,
    body: fixturePhoneAfterUnregister.body,
    buildTag: buildTagAfterUnregister,
  })
  await run.record({
    step: '摘登记后真重启：夹具确实没加载（「重启也不会加载」不是空话）',
    what: '停宿主 → 摘登记 → 同 home/profile 起全新通道 B 宿主 → 向夹具 bridge 发 buildTag 电话；没加载时路由不存在（回包失败/无 buildTag）',
    expected: '夹具电话不可达（ok=false 或 buildTag=null）；宿主页面仍能起来（正常 boot）',
    actual: 'ok=' + String(fixturePhoneAfterUnregister.ok) + '；buildTag=' + String(buildTagAfterUnregister) + '；http=' + String(fixturePhoneAfterUnregister.status) + '；pageOk=' + String(pageUnregistered.ok) + '；pageStatus=' + String(pageUnregistered.status),
    verdict: !fixtureLoaded && pageUnregistered.ok ? 'pass' : 'fail',
  })

  // 未加载的日志留证（辅助，不单独判红）
  await captureLogFiles(run.recorder, homeDir)
  const rowsAfterUnregister = await readRawLogRows(homeDir)
  const rowsSinceUnregister = rowsAfterUnregister.filter((row) => row.ts !== null && row.ts >= unregisterRestartAt)
  const loadMarkers = rowsSinceUnregister.filter((row) => row.event === 'host.start' || row.event === 'update.wire.ready')
  await run.raw('logs-after-unregister-restart', {
    since: unregisterRestartAt,
    rows: rowsSinceUnregister.length,
    loadMarkers: loadMarkers.map((row) => ({ ts: row.ts, event: row.event, source: row.source, line: row.line, fields: row.fields })).slice(0, 40),
  })
  await run.record({
    step: '未加载的原始页面/日志已留档（辅助证据）',
    what: '摘登记重启后的宿主页面 HTTP 事实与日志行都进 raw；原始材料在，不用编 actual',
    expected: '原始页面/日志已取证',
    actual: '页面HTTP=' + String(pageUnregistered.status) + '；重启后日志行=' + String(rowsSinceUnregister.length) + '；加载标记行=' + String(loadMarkers.length),
    verdict: 'pass',
  })

  // ---- 15. 恢复登记（UI 优先的兜底：写回清单并记录理由）----
  await closeCurrent('before-restore')
  const restore = await rewriteEnrollment({ homeDir, profileName: I2_PROFILE_NAME, packageName, present: true, version: variantVersion })
  const enrolledAfterRestore = restore.bundlesAfter !== null ? restore.bundlesAfter.indexOf(packageName) >= 0 : restore.dependenciesAfter !== null && Object.prototype.hasOwnProperty.call(restore.dependenciesAfter, packageName)
  await run.raw('manifest-restore', {
    mode: restore.mode,
    path: restore.path,
    before: restore.before,
    after: restore.after,
    bundlesAfter: restore.bundlesAfter,
    dependenciesAfter: restore.dependenciesAfter,
    why: '通道 B 没有可驱动的 web UI（harness 无 web-ui 驱动，本票不新增驱动）；按 Lead 口径「UI 优先，兜底写回并记录」等价写回使用范围清单',
  })
  await run.record({
    step: '恢复在册登记（等价写回；理由入 raw）',
    what: '把 ' + packageName + ' 写回使用范围清单（' + restore.mode + ' 口径），依赖版本钉到 ' + variantVersion,
    expected: '清单在册口径含该包',
    actual: 'mode=' + restore.mode + '；bundles=' + JSON.stringify(restore.bundlesAfter) + '；dependencies=' + JSON.stringify(restore.dependenciesAfter),
    verdict: enrolledAfterRestore ? 'pass' : 'fail',
  })

  // ---- 16. 恢复登记 + 真重启：真正加载新版本（电话/磁盘/清单三面一致）----
  const hostRegistered = await startHost('registered')
  const statusRegistered = await i2WaitStatusReady(hostRegistered, route, statusPhone, 90000)
  const buildTagRegisteredOutcome = await i2CallPhone(hostRegistered, route, buildTagPhone, {})
  const buildTagRegistered = i2BuildTagValueOf(buildTagRegisteredOutcome)
  const manifestFinal = await readManifestFacts(homeDir, I2_PROFILE_NAME)
  const diskFinal = await installedFixtureVersion({ homeDir, profileName: I2_PROFILE_NAME, packageName })
  await run.raw('phone-after-restore-restart', {
    status: statusRegistered?.body ?? null,
    buildTagStatus: buildTagRegisteredOutcome.status,
    buildTagBody: buildTagRegisteredOutcome.body,
    buildTag: buildTagRegistered,
    diskVersion: diskFinal,
    dependencies: manifestFinal.dependencies,
    bundles: manifestFinal.bundles,
  })
  await run.record({
    step: '恢复登记 + 真重启后真正加载 ' + variantVersion + '（电话/磁盘/清单三面一致）',
    what: '写回在册后真重启通道 B 宿主：夹具 buildTag 电话必须回新版，运行版/磁盘/清单三面必须一致',
    expected: 'buildTag=host v' + variantVersion + '；磁盘=' + variantVersion + '；runningVersion=' + variantVersion,
    actual: 'buildTag=' + String(buildTagRegistered) + '；磁盘=' + String(diskFinal) + '；runningVersion=' + String(statusRegistered?.snapshot?.runningVersion ?? null),
    verdict:
      buildTagRegistered === 'host v' + variantVersion &&
      diskFinal === variantVersion &&
      statusRegistered !== null &&
      statusRegistered.snapshot?.runningVersion === variantVersion
        ? 'pass'
        : 'fail',
  })

  // 恢复后的 fresh check：已是最新、不可再装
  const freshCheck = await i2CallPhone(hostRegistered, route, checkPhone, { trigger: 'user' })
  await run.raw('phone-check-after-restore-restart', { status: freshCheck.status, durationMs: freshCheck.durationMs, body: freshCheck.body })
  await run.record({
    step: '恢复后 fresh check：已是最新（canInstall=false）',
    what: '重启后的 fresh updateCheck 应报已装=最新=' + variantVersion + '、canInstall=false',
    expected: 'ok=true；canInstall=false；installedVersion=' + variantVersion + '；latestVersion=' + variantVersion,
    actual: 'ok=' + String(freshCheck.ok) + '；canInstall=' + String(freshCheck.snapshot?.canInstall) + '；installedVersion=' + String(freshCheck.snapshot?.installedVersion) + '；latestVersion=' + String(freshCheck.snapshot?.latestVersion),
    verdict:
      freshCheck.ok &&
      freshCheck.snapshot?.canInstall === false &&
      freshCheck.snapshot?.installedVersion === variantVersion &&
      freshCheck.snapshot?.latestVersion === variantVersion
        ? 'pass'
        : 'fail',
  })

  // ---- 17. 台账：真安装恰一条成功终态 ----
  const ledgerEntries = await readLedgerStates(homeDir)
  const ledgerTarget = ledgerEntries.filter((entry) => entry.state !== null && entry.state['targetVersion'] === variantVersion)
  const ledgerSuccess = ledgerTarget.filter(
    (entry) =>
      entry.state !== null &&
      typeof entry.state['state'] === 'string' &&
      TERMINAL_STATES.indexOf(entry.state['state'] as string) >= 0 &&
      entry.state['state'] !== 'failed' &&
      entry.state['state'] !== 'interrupted',
  )
  await run.raw('ledger-facts', {
    entries: ledgerEntries.map((entry) => ({ file: entry.file, pluginId: entry.pluginId, state: entry.state, corrupt: entry.corrupt })),
    targetVersion: variantVersion,
    targetEntries: ledgerTarget.length,
    successEntries: ledgerSuccess.length,
  })
  await run.record({
    step: '台账恰一条成功终态（无重复/丢单）',
    what: '读 <home>/updates 下各级 state.json，按目标版本筛成功终态条目',
    expected: 'targetVersion=' + variantVersion + ' 的成功终态条目恰 1 条；previousVersion=' + baselineStep.version,
    actual: '条目数=' + String(ledgerSuccess.length) + '；' + JSON.stringify(ledgerTarget.map((entry) => entry.state)),
    verdict: ledgerSuccess.length === 1 && ledgerSuccess[0].state !== null && ledgerSuccess[0].state['previousVersion'] === baselineStep.version ? 'pass' : 'fail',
  })

  // ---- 18. 收尾：关宿主、按 pid/端口复核无残留 ----
  await closeCurrent('cleanup')
  const leftoverPids = started.map((entry) => ({ label: entry.label, pid: entry.pid, alive: entry.pid === null ? false : isProcessAlive(entry.pid) }))
  await run.raw('cleanup-verify', { hosts: started.map((entry) => ({ label: entry.label, pid: entry.pid, port: entry.port, closed: entry.closed })), ports: run.cleanupPorts, leftoverPids })
  await run.record({
    step: '收尾清理（进程/端口无残留）',
    what: '关掉本 run 起过的全部通道 B 宿主后按 pid 复核存活、按端口复核已释放',
    expected: '存活 pid 数=0；使用过的端口全部释放',
    actual: 'alive=' + JSON.stringify(leftoverPids.filter((item) => item.alive)) + '；ports=' + JSON.stringify(run.cleanupPorts),
    verdict: leftoverPids.filter((item) => item.alive).length === 0 && run.cleanupPorts.every((item) => item.released) ? 'pass' : 'fail',
  })
  run.addNote(
    'i2 结论口径：通道 B 真机把「装完但没重启时运行标记仍是基版 → 摘出使用范围后真重启确实不加载 → 写回后真重启确实加载 ' + variantVersion + '」整条链跑通；' +
      '面板「pending-restart + 未登记」两句文案分支不在通道 B 渲染，走 known-red（需集成方注入 ReaderOverrides.runningVersion）。',
  )
}


/** 当前活动桌面会话（顶层异常兜底清理用）。 */
let activeSession: DesktopSession | null = null

/** 场景入口：按 mode 选 I1 / I2 流程，统一收尾（close + 证据同步）。 */
export async function runEnrollmentRestart(options: EnrollmentRestartOptions): Promise<RunManifest> {
  const scenarioId = scenarioIdOf(options.mode)
  const run = await openT3Run({
    worktree: options.worktree,
    runBaseDir: options.runBaseDir,
    verdaccioInstallDir: options.verdaccioInstallDir,
    esbuildPath: options.esbuildPath,
    scenarioId,
    hostChannel: options.mode === 'unregistered-honesty' ? 'dsh-web' : 'desktop-official',
    stamp: options.stamp,
    maintainerHome: options.maintainerHome,
    ticket: '272',
  })
  try {
    if (options.mode === 'unregistered-honesty') {
      await runUnregisteredHonesty(run, options)
    } else {
      await runRestartTruth(run, options)
    }
  } catch (error) {
    await run.raw('scenario-error', { message: messageOf(error), stack: error instanceof Error ? error.stack ?? null : null })
    await run.record({
      step: '场景异常',
      what: '顶层 catch：真机流程中抛错',
      expected: '无异常',
      actual: messageOf(error),
      verdict: 'unknown',
    })
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
      console.error('[i] 复制证据失败（run 仍在仓库外）：' + messageOf(error))
    }
  }
  return manifest
}
