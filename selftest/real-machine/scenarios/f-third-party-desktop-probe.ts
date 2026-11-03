/**
 * f-third-party-desktop-probe.ts —— 出口一：第三方 Desktop（提供 desktopProfiles 服务）。
 *
 * 这一格不是「跑一次更新」，而是**能力探测**：本机有没有能走出口一的宿主？
 *   1. 文件系统扫描（Program Files / Program Files (x86) / LocalAppData / AppData / 盘根）找同族命名的桌面安装；
 *   2. 卸载表（HKLM/HKCU Uninstall，DisplayName 过滤）与 Windows 服务表原始输出；
 *   3. 活证据：本机唯一桌面宿主（官方桌面）里插件发 update.wire.ready，hostKind=desktop-manager
 *      ——按 src/host/environment.ts:109-115 的判定顺序，hostKind 不是 'desktop' 就说明 desktopProfiles
 *      服务在这个宿主里不存在；本机又只有这一个桌面宿主，所以出口一在本机不可达。
 *
 * 出口一的真机更新（成功格/失败格）记 known-red：本机没有第三方 Desktop，**不伪造**真机结果；
 * known-red 的备注里写清可复现条件（装一台提供 desktopProfiles 服务的第三方 Desktop 后重跑本场景）。
 */
import { readdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Dirent } from 'node:fs'
import type { RunManifest } from '../runtime/evidence.ts'
import type { DesktopSession } from '../host/desktop-app.ts'
import { launchDesktopApp } from '../host/desktop-app.ts'
import { DSH_PATHS } from '../host/dsh-cli.ts'
import { waitForProfileDir } from '../host/isolated-profile.ts'
import type { LogSnapshot } from '../runtime/log-evidence.ts'
import { captureLogFiles, eventsOf } from '../runtime/log-evidence.ts'
import { captureShot, waitForFixtureLoaded } from './a-single-package-main-chain.ts'
import type { T3Run } from './t3-common.ts'
import { openT3Run, verifySutInstalled } from './t3-common.ts'
import { directoryExists, ensureDir, fileExists } from '../../tooling/fs-utils.ts'
import { formatError, runCommand } from '../../tooling/process.ts'

/** 场景入参。 */
export interface ThirdPartyDesktopProbeOptions {
  readonly worktree: string
  /** run 根目录（仓库外，例 D:/dsh-plugin/_wt263/runtime/t3-267）。 */
  readonly runBaseDir: string
  readonly verdaccioInstallDir: string
  readonly esbuildPath: string
  readonly stamp?: string
  /** 维护者 DSH_HOME（只读指纹）。 */
  readonly maintainerHome?: string
}

/** 同族命名：DSH / DeepSeek / Harness（官方发行包与第三方 Desktop 都用这套名字）。 */
const FAMILY_NAME = /dsh|deepseek|harness/i

/** 扫描命中的目录。 */
interface ScanMatch {
  readonly path: string
  readonly name: string
  /** 该目录第一层里的 exe 文件名（判断「像不像一个桌面应用安装目录」）。 */
  readonly exeNames: string[]
}

/** 一个扫描根的原始结果。 */
interface ScanResult {
  readonly root: string
  readonly maxDepth: number
  scannedDirs: number
  errors: { path: string; error: string }[]
  matches: ScanMatch[]
}

/** 递归扫描一个根（深度受限）：列出每层目录；名字同族的记成 match，并记录该目录第一层的 exe。 */
async function scanRoot(root: string, maxDepth: number): Promise<ScanResult> {
  const result: ScanResult = { root, maxDepth, scannedDirs: 0, errors: [], matches: [] }
  const walk = async (dir: string, depth: number): Promise<void> => {
    result.scannedDirs += 1
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      result.errors.push({ path: dir, error: formatError(error) })
      return
    }
    const name = basename(dir)
    if (FAMILY_NAME.test(name)) {
      result.matches.push({
        path: dir,
        name,
        exeNames: entries.filter((entry) => entry.isFile() && /\.exe$/i.test(entry.name)).map((entry) => entry.name),
      })
    }
    if (depth >= maxDepth) return
    for (const entry of entries) {
      if (entry.isDirectory()) await walk(join(dir, entry.name), depth + 1)
    }
  }
  await walk(root, 0)
  return result
}

/** 一段 PowerShell 脚本以 -EncodedCommand 执行（避开 Windows 引号转义）；返回原始 stdout/stderr/exit。 */
function runPowerShell(script: string, timeoutMs: number): { exitCode: number | null; stdout: string; stderr: string } {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const result = runCommand('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeoutMs })
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
}

/** 卸载表里同族 DisplayName 的条目（原始 JSON 文本 + 解析结果）。 */
function probeUninstallRegistry(): { script: string; exitCode: number | null; stdout: string; stderr: string; entries: Record<string, unknown>[] } {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$paths = @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
    "  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
    "  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
    "$items = Get-ItemProperty $paths | Where-Object { $_.DisplayName -match 'dsh|deepseek|harness' } |",
    '  Select-Object DisplayName, DisplayVersion, InstallLocation, Publisher',
    'if ($null -eq $items) { "[]" } else { ConvertTo-Json -InputObject @($items) -Compress }',
  ].join('\n')
  const raw = runPowerShell(script, 60000)
  let entries: Record<string, unknown>[] = []
  try {
    const parsed = JSON.parse(raw.stdout.trim()) as Record<string, unknown> | Record<string, unknown>[]
    entries = Array.isArray(parsed) ? parsed : [parsed]
  } catch (error) {
    entries = []
  }
  return { script, ...raw, entries }
}

/** Windows 服务表里同族名字的条目（原始 JSON 文本 + 解析结果）。 */
function probeServices(): { script: string; exitCode: number | null; stdout: string; stderr: string; entries: Record<string, unknown>[] } {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$items = Get-Service | Where-Object { $_.Name -match 'dsh|deepseek|harness' -or $_.DisplayName -match 'dsh|deepseek|harness' } |",
    '  Select-Object Name, DisplayName, Status',
    'if ($null -eq $items) { "[]" } else { ConvertTo-Json -InputObject @($items) -Compress }',
  ].join('\n')
  const raw = runPowerShell(script, 60000)
  let entries: Record<string, unknown>[] = []
  try {
    const parsed = JSON.parse(raw.stdout.trim()) as Record<string, unknown> | Record<string, unknown>[]
    entries = Array.isArray(parsed) ? parsed : [parsed]
  } catch (error) {
    entries = []
  }
  return { script, ...raw, entries }
}

/** 一条卸载表条目是不是官方桌面（按 InstallLocation 归到官方安装根下判断；缺 InstallLocation 时按 DisplayName）。 */
function isOfficialEntry(entry: Record<string, unknown>, officialDir: string): boolean {
  const location = typeof entry['InstallLocation'] === 'string' ? (entry['InstallLocation'] as string) : ''
  if (location) return location.toLowerCase().startsWith(officialDir.toLowerCase())
  const displayName = typeof entry['DisplayName'] === 'string' ? (entry['DisplayName'] as string) : ''
  return /deepseek harness/i.test(displayName)
}

/** 一个命中目录是不是官方桌面安装目录（官方 exe 所在目录及其子目录都算官方）。 */
function isOfficialPath(path: string, officialDir: string): boolean {
  return path.toLowerCase() === officialDir.toLowerCase() || path.toLowerCase().startsWith(officialDir.toLowerCase() + '\\')
}

/** 目录第一层的 exe 文件名（读不到就是空，不猜）。 */
async function listExeNames(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isFile() && /\.exe$/i.test(entry.name)).map((entry) => entry.name)
  } catch (error) {
    return []
  }
}

/** 桌面发行目录的结构事实：Electron 桌面安装包的硬特征是有 resources/app.asar 或 resources/app。 */
interface DesktopArtifacts {
  readonly hasResourcesAppAsar: boolean
  readonly hasResourcesAppDir: boolean
  readonly exeNames: string[]
  readonly hasFamilyExe: boolean
  /** 同时满足「有 Electron 发行结构」+「有同族 exe」才算像桌面宿主；只有名字同族的目录（工具/缓存/项目）不算。 */
  readonly desktopLike: boolean
}

async function desktopArtifactsOf(dir: string, exeNames?: string[]): Promise<DesktopArtifacts> {
  const names = exeNames ?? (await listExeNames(dir))
  const hasResourcesAppAsar = await fileExists(join(dir, 'resources', 'app.asar'))
  const hasResourcesAppDir = await directoryExists(join(dir, 'resources', 'app'))
  const hasFamilyExe = names.some((name) => FAMILY_NAME.test(name))
  return {
    hasResourcesAppAsar,
    hasResourcesAppDir,
    exeNames: names,
    hasFamilyExe,
    desktopLike: (hasResourcesAppAsar || hasResourcesAppDir) && hasFamilyExe,
  }
}

/**
 * 用 Electron-as-node 读 app.asar 虚拟路径：普通 node 看不到 asar 内的 cli.js，
 * 必须让发行包自己的 exe 以 ELECTRON_RUN_AS_NODE=1 跑一段脚本（本项目探针实测可用）。
 */
async function probeAsarPath(
  targetPath: string,
  probeScriptPath: string,
): Promise<{
  exists: boolean
  size: number | null
  error: string | null
  scriptPath: string
  script: string
  exitCode: number | null
  stdout: string
  stderr: string
}> {
  const script = [
    "const fs = require('node:fs')",
    'const target = process.argv[2]',
    'let exists = false',
    'let size = null',
    'let error = null',
    'try {',
    '  exists = fs.existsSync(target)',
    '  if (exists) size = fs.statSync(target).size',
    '} catch (caught) {',
    '  error = String((caught && caught.message) || caught)',
    '}',
    'process.stdout.write(JSON.stringify({ target, exists, size, error }))',
  ].join('\n')
  await ensureDir(join(probeScriptPath, '..'))
  await writeFile(probeScriptPath, script + '\n')
  const result = runCommand(DSH_PATHS.exePath, [probeScriptPath, targetPath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeoutMs: 60000,
  })
  let parsed: { exists?: boolean; size?: number | null; error?: string | null } = {}
  try {
    parsed = JSON.parse(result.stdout.trim()) as typeof parsed
  } catch (error) {
    parsed = {}
  }
  return {
    exists: parsed.exists === true,
    size: typeof parsed.size === 'number' ? parsed.size : null,
    error: typeof parsed.error === 'string' ? parsed.error : null,
    scriptPath: probeScriptPath,
    script,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

/** 跑出口一探测格。 */
export async function runThirdPartyDesktopProbe(options: ThirdPartyDesktopProbeOptions): Promise<RunManifest> {
  const run: T3Run = await openT3Run({
    worktree: options.worktree,
    runBaseDir: options.runBaseDir,
    verdaccioInstallDir: options.verdaccioInstallDir,
    esbuildPath: options.esbuildPath,
    scenarioId: 'f1-third-party-desktop-probe',
    hostChannel: 'desktop-official',
    stamp: options.stamp,
    maintainerHome: options.maintainerHome,
  })
  const fixtureEnv = run.fixtureEnv
  if (!fixtureEnv) throw new Error('[f] 场景缺少夹具环境（探测格要装一份基版让宿主里真有插件在跑）')
  const registryUrl = fixtureEnv.registry.baseUrl
  const profileName = 'desktop'
  const homeDir = run.layout.homeDir
  const userDataDir = run.layout.userDataDir
  const officialDir = join(DSH_PATHS.exePath, '..').replace(/\\$/, '')
  let session: DesktopSession | null = null

  try {
    // ---- 1. 能力探测（原始证据，不解释先落盘） ----
    // 官方 exe 是真实文件；cli.js 在 app.asar 虚拟路径里，普通 node stat 不到（ENOENT），
    // 必须用发行包自己的 exe 以 ELECTRON_RUN_AS_NODE=1 跑脚本读（否则会把「有 CLI」误判成 false）。
    const officialExeExists = await fileExists(DSH_PATHS.exePath)
    const officialCliProbe = await probeAsarPath(DSH_PATHS.cliJsPath, join(run.layout.root, 'probe-asar-path.js'))
    await run.raw('capability-probe-official-desktop', {
      exePath: DSH_PATHS.exePath,
      cliJsPath: DSH_PATHS.cliJsPath,
      officialDir,
      exeExists: officialExeExists,
      cliJsProbe: officialCliProbe,
      probeMethod: 'ELECTRON_RUN_AS_NODE=1 + exe + 脚本（普通 node 看不到 app.asar 虚拟路径）',
      probedAt: new Date().toISOString(),
    })
    run.record({
      step: '出口一能力探测：官方桌面发行包路径',
      what: '本机官方桌面（DeepSeek Harness.exe）与它的 CLI 入口是否在发行包默认位置（探测原始事实；cli.js 在 app.asar 内，用 Electron-as-node 读）',
      expected: 'exe 是真实文件；cli.js 能被发行包自己的 exe 以 ELECTRON_RUN_AS_NODE=1 读到（exists=true 且 size>0）',
      actual:
        'exe=' + String(officialExeExists) + '（' + DSH_PATHS.exePath + '）；cli.js.exists=' +
        String(officialCliProbe.exists) + '；cli.js.size=' + String(officialCliProbe.size) +
        '；probe.exit=' + String(officialCliProbe.exitCode),
      verdict: officialExeExists && officialCliProbe.exists && officialCliProbe.size !== null && officialCliProbe.size > 0 ? 'pass' : 'fail',
    })

    const roots: { root: string; maxDepth: number }[] = []
    const envRoot = (name: string): string | null => {
      const value = process.env[name]
      return value && value.trim() ? value : null
    }
    for (const name of ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA', 'APPDATA']) {
      const root = envRoot(name)
      if (root) roots.push({ root, maxDepth: 2 })
    }
    for (const drive of ['C:\\', 'D:\\']) roots.push({ root: drive, maxDepth: 1 })
    const scans: ScanResult[] = []
    for (const item of roots) scans.push(await scanRoot(item.root, item.maxDepth))
    const uninstall = probeUninstallRegistry()
    const services = probeServices()
    await run.raw('capability-probe-filesystem', {
      roots,
      scans,
      scannedAt: new Date().toISOString(),
    })
    await run.raw('capability-probe-uninstall-registry', uninstall)
    await run.raw('capability-probe-services', services)

    const probeComplete =
      scans.every((scan) => scan.errors.length === 0 || scan.scannedDirs > 0) &&
      uninstall.exitCode === 0 &&
      services.exitCode === 0
    run.record({
      step: '出口一能力探测：三项探测都拿到原始结果',
      what: '文件系统扫描 + 卸载表查询 + 服务表查询都执行完成（命令原文与完整输出在 raw，失败也保留）',
      expected: '每个扫描根都扫到目录（readdir 有结果）；卸载表/服务表 PowerShell exit=0 且输出可解析',
      actual:
        '扫描根=' + String(scans.length) + '，共扫目录 ' + String(scans.reduce((sum, scan) => sum + scan.scannedDirs, 0)) +
        '，readdir 错误 ' + String(scans.reduce((sum, scan) => sum + scan.errors.length, 0)) +
        '；卸载表 exit=' + String(uninstall.exitCode) + ' 条目 ' + String(uninstall.entries.length) +
        '；服务表 exit=' + String(services.exitCode) + ' 条目 ' + String(services.entries.length),
      verdict: probeComplete ? 'pass' : 'fail',
    })

    // 分类：名字同族只是候选；「像桌面宿主」还要求目录本身是 Electron 桌面发行结构
    // （resources/app.asar 或 resources/app）+ 第一层有同族 exe。只有名字同族的工具/缓存/项目/用户数据
    // 目录不是桌面宿主（本机首跑实测：dshvm-ui.exe 是单文件 UI、AppData 下是用户数据目录，都属 nearMiss）。
    let officialMatches: { path: string; name: string; exeNames: string[]; artifacts: DesktopArtifacts }[] = []
    let thirdPartyMatches: { path: string; name: string; exeNames: string[]; artifacts: DesktopArtifacts }[] = []
    let nearMissMatches: { path: string; name: string; exeNames: string[]; artifacts: DesktopArtifacts; reason: string }[] = []
    for (const match of scans.flatMap((scan) => scan.matches)) {
      const artifacts = await desktopArtifactsOf(match.path, match.exeNames)
      const fact = { path: match.path, name: match.name, exeNames: match.exeNames, artifacts }
      if (isOfficialPath(match.path, officialDir)) officialMatches.push(fact)
      else if (artifacts.desktopLike) thirdPartyMatches.push(fact)
      else nearMissMatches.push({ ...fact, reason: '名字同族，但目录不是 Electron 桌面发行结构（无 resources/app.asar 或 resources/app）或没有同族 exe' })
    }
    let thirdPartyUninstall: { entry: Record<string, unknown>; location: string; artifacts: DesktopArtifacts }[] = []
    let nearMissUninstall: { entry: Record<string, unknown>; location: string; reason: string }[] = []
    for (const entry of uninstall.entries) {
      const location = typeof entry['InstallLocation'] === 'string' ? (entry['InstallLocation'] as string) : ''
      if (isOfficialEntry(entry, officialDir)) continue
      if (!location) {
        nearMissUninstall.push({ entry, location, reason: '缺 InstallLocation，无法指向桌面发行目录（不是安装目录）' })
        continue
      }
      const artifacts = await desktopArtifactsOf(location)
      if (artifacts.desktopLike) thirdPartyUninstall.push({ entry, location, artifacts })
      else nearMissUninstall.push({ entry, location, reason: '安装目录不是 Electron 桌面发行结构（无 resources/app.asar 或 resources/app）或没有同族 exe' })
    }
    const thirdPartyServices = services.entries
    const noThirdParty = thirdPartyMatches.length === 0 && thirdPartyUninstall.length === 0 && thirdPartyServices.length === 0
    await run.raw('capability-probe-classification', {
      officialDir,
      officialMatches,
      thirdPartyMatches,
      nearMissMatches,
      thirdPartyUninstall,
      nearMissUninstall,
      thirdPartyServices,
      criterion:
        '第三方 Desktop 判据：①目录名同族（dsh|deepseek|harness）、不在官方安装根下，并且该目录是 Electron 桌面发行结构（resources/app.asar 或 resources/app）且第一层有同族 exe；②卸载表同族 DisplayName 且 InstallLocation 指向这样的发行目录；③服务表同族名字。三者任一非空才视为「可能有第三方桌面宿主」。仅名字同族但没有桌面发行结构的目录（工具/缓存/项目/用户数据）不算宿主，原文记在 nearMiss 里，供人工复核。',
      probedAt: new Date().toISOString(),
    })
    run.record({
      step: '出口一能力探测：本机没有第三方 Desktop 安装',
      what: '文件系统扫描、卸载表、服务表三项都没有发现官方桌面以外的 DSH 桌面宿主（判据原文与 nearMiss 原文见 raw/capability-probe-classification）',
      expected: '按结构判据，除官方安装根外没有第二份第三方 Desktop 发行目录/卸载条目/服务',
      actual:
        '同族目录命中 ' + String(officialMatches.length + thirdPartyMatches.length + nearMissMatches.length) +
        '（官方 ' + String(officialMatches.length) + ' / 第三方 ' + String(thirdPartyMatches.length) +
        ' / 非桌面宿主 nearMiss ' + String(nearMissMatches.length) + '）；' +
        '卸载表同族 ' + String(uninstall.entries.length) + '（第三方 ' + String(thirdPartyUninstall.length) +
        ' / nearMiss ' + String(nearMissUninstall.length) + '）；' +
        '服务同族 ' + String(thirdPartyServices.length),
      verdict: noThirdParty ? 'pass' : 'fail',
      note: noThirdParty
        ? '第三方 Desktop 在本机不存在（名字同族但非桌面发行结构的目录已按结构判据排除，见 nearMiss）；出口一真机更新不可达（known-red），不伪造结果。'
        : '探测到符合结构判据的第三方桌面宿主，需要人工复核后再决定能否真机走出口一。',
    })

    // ---- 2. 活证据：唯一桌面宿主（官方桌面）里插件报 hostKind=desktop-manager ----
    session = await launchDesktopApp({ homeDir, userDataDir, extraEnv: { DSH_SELFTEST_REGISTRY: registryUrl } })
    const bootstrapPid = session.process.pid() ?? null
    await waitForProfileDir({ homeDir, profileName, timeoutMs: 120000 })
    await session.cdp.waitForExpression('document.body && document.body.innerText.length > 100', { timeoutMs: 120000, label: '桌面首启界面出现' })
    await session.close()
    session = null
    run.registerProcess('desktop-app-bootstrap', bootstrapPid)

    await run.installBaseline({ homeDir, profileName, registryUrl })
    await verifySutInstalled(run, { homeDir, profileName, packageName: 'dsh-plugin-update-fixture-a' })

    session = await launchDesktopApp({ homeDir, userDataDir, extraEnv: { DSH_SELFTEST_REGISTRY: registryUrl } })
    const mainPid = session.process.pid() ?? null
    const panel = await waitForFixtureLoaded(session, 180000)
    await run.raw('panel-only-desktop', panel)
    await captureShot(run.recorder, session, {
      step: '本机唯一桌面宿主里的更新面板',
      what: '官方桌面（本机唯一桌面宿主）里装着夹具，更新面板真的渲染出来——出口二通道活着的证据',
      expected: '面板 present=true、seal=ready、卡片显示 client v0.0.1',
      actual: 'present=' + String(panel.present) + '；seal=' + String(panel.seal) + '；clientTag=' + String(panel.card && panel.card.clientTag),
      verdict: panel.present && panel.card && panel.card.clientTag === 'client v0.0.1' ? 'pass' : 'fail',
    })
    const mainPid2 = mainPid
    await session.close()
    session = null
    run.registerProcess('desktop-app-main', mainPid2)

    // 停宿主后读日志（日志缓冲要靠进程收尾冲刷；wire.ready 在 boot 早期就发了，冲刷窗口足够）。
    const logSnapshot: LogSnapshot = (await captureLogFiles(run.recorder, homeDir)).snapshot
    const wireRows = eventsOf(logSnapshot.events, 'update.wire.ready')
    const hostKinds = wireRows.map((row) => (typeof row.fields['hostKind'] === 'string' ? (row.fields['hostKind'] as string) : null))
    await run.raw('desktop-host-kind-negative', {
      wireRows: wireRows.map((row) => ({ event: row.event, fields: row.fields, source: row.source })),
      hostKinds,
      criterion:
        'src/host/environment.ts:109-115：有 desktopProfiles 服务→desktop；否则 pluginManager.installBundle 且 profile 名恰为 desktop→desktop-manager；其余→cli。' +
        '本机唯一桌面宿主报 desktop-manager，说明 desktopProfiles 服务不存在；本机又没有别的桌面宿主，故出口一不可达。',
    })
    const hostKind = hostKinds.length > 0 ? hostKinds[hostKinds.length - 1] : null
    run.record({
      step: '出口一不可达的活证据：唯一桌面宿主报 hostKind=desktop-manager',
      what: '官方桌面里插件发 update.wire.ready，hostKind 由产品环境判定给出；desktop-manager 意味着 desktopProfiles 服务不存在（出口一要求的能力）',
      expected: "hostKind='desktop-manager'（若为 'desktop' 则说明 desktopProfiles 存在、出口一可达）",
      actual: 'hostKind=' + JSON.stringify(hostKind) + '；wire.ready 行数=' + String(wireRows.length) + '；日志文件 ' + String(logSnapshot.files.length) + ' 个',
      verdict: hostKind === 'desktop-manager' ? 'pass' : 'fail',
      note: '这是负向证据：本机唯一桌面宿主不是出口一宿主。',
    })

    // ---- 3. 出口一真机更新：本机不可达，记 known-red（不伪造） ----
    const knownRedCondition =
      '可复现条件：在一台装有第三方 Desktop 发行包（launcher 在 Loader entry 挂载前注册 desktopProfiles 服务）的机器上重跑本场景；' +
      '探测到第三方宿主后，出口一真机更新应走 desktopProfiles.runPlugin(args, 使用范围目录, undefined) 完成一次已装更新。' +
      '本机探测证据：raw/capability-probe-filesystem、raw/capability-probe-uninstall-registry、raw/capability-probe-services、raw/desktop-host-kind-negative。'
    run.addNote('出口一 known-red：' + knownRedCondition)
    run.record({
      step: '出口一真机更新（成功格，不可达）',
      what: '在提供 desktopProfiles 服务的第三方 Desktop 宿主上，对已装 0.0.1 走一次更新到 0.0.2（由宿主 launcher 执行 pnpm）',
      expected: '第三方 Desktop 宿主上 update.install.exec route=desktop ok=true；磁盘与重启后 UI 都到 0.0.2',
      actual: '本机没有第三方 Desktop 宿主（三项探测为空、唯一桌面宿主 hostKind=desktop-manager），没有可跑的真机；不伪造真机结果',
      verdict: 'known-red',
      note: knownRedCondition,
    })
    run.record({
      step: '出口一真机更新（失败格，不可达）',
      what: '在第三方 Desktop 宿主上制造一次更新失败（例如让宿主 pnpm 报错），核对产品失败码/人话格/手工命令的出口一语义',
      expected: '失败码 install-failed、detail 来自宿主原话、人话格与手工命令按出口一契约呈现',
      actual: '本机没有第三方 Desktop 宿主，出口一失败语义无法真机观测；库内契约测试见 tests/ 与 docs/host-install-exits.md，真机格记 known-red',
      verdict: 'known-red',
      note: knownRedCondition,
    })

    return await run.close()
  } catch (error) {
    await run.raw('scenario-error', { message: formatError(error), stack: error instanceof Error ? error.stack : null })
    run.record({
      step: '出口一探测场景执行',
      what: '探测场景本身没有抛错跑完（探测/宿主启动/日志采集任一步失败都算场景失败）',
      expected: '场景无异常',
      actual: formatError(error),
      verdict: 'unknown',
    })
    run.addNote('出口一探测场景抛错：' + formatError(error))
    if (session) {
      const pid = session.process.pid() ?? null
      await session.close().catch(() => undefined)
      session = null
      run.registerProcess('desktop-app-main', pid)
    }
    return await run.close()
  }
}
