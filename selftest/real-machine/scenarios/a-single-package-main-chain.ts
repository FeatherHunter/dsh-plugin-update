/**
 * selftest/real-machine/scenarios/a-single-package-main-chain.ts —— 场景 A：单包主链（官方桌面通道）。
 *
 * 用 #258 已批准的 S2 夹具角色 A（批量集成方，selfOrder=first，targets=[a,b,c]），在**官方桌面真机**上跑：
 *   干净隔离 profile 装 A@0.0.1（本地 registry）
 *   → 启动官方桌面（隔离 DSH_HOME + user-data-dir + CDP）→ 面板显示旧版 0.0.1
 *   → 发布 A@0.0.2（模板变化：client/host 构建标记、卡片标题都变）
 *   → 真 UI 点「检查更新」→ 断言最新版 0.0.2 且可安装
 *   → 真 UI 点「安装更新」→ 官方桌面 in-process remove→install（必要时重启隔离 app）
 *   → 核对 UI 新版 + 可见变化、磁盘版本、日志/台账、机器出口。
 *
 * 判定纪律：每条断言四态；unknown 不算通过；失败留 raw 原始证据。证据格式契约见 selftest/evidence/README.md。
 */
import { join } from 'node:path'
import { readFile, readdir } from 'node:fs/promises'
import type { RunLayout } from '../runtime/run-layout.ts'
import { createRunLayout } from '../runtime/run-layout.ts'
import type { EvidenceRecorder, RunManifest, SutFacts } from '../runtime/evidence.ts'
import { EvidenceRecorder as EvidenceRecorderClass } from '../runtime/evidence.ts'
import { collectEnvironmentFacts } from '../runtime/environment-facts.ts'
import { captureMaintainerProfile, compareMaintainerProfile, maintainerDesktopProfileDir } from '../runtime/maintainer-profile.ts'
import type { FixtureEnvironment } from '../runtime/fixture-environment.ts'
import { createFixtureEnvironment, fixtureSpecOf } from '../runtime/fixture-environment.ts'
import type { PublishedFixture } from '../../fixtures/release/fixture-publisher.ts'
import { publishFixtureVersion } from '../../fixtures/release/fixture-publisher.ts'
import type { DesktopSession } from '../host/desktop-app.ts'
import { launchDesktopApp } from '../host/desktop-app.ts'
import { installPluginIntoProfile, installedPluginDir, waitForProfileDir } from '../host/isolated-profile.ts'
import type { InstalledPluginFacts } from '../host/dsh-cli.ts'
import { readInstalledPackageVersion, readProfileManifest, verifyPluginInstalled } from '../host/dsh-cli.ts'
import { directoryFingerprint, directoryExists, fileExists, ensureDir, listFilesRecursive, sha256File, writeJsonFile } from '../../tooling/fs-utils.ts'
import { waitFor } from '../../tooling/process.ts'
import { isPortFree } from '../../tooling/ports.ts'

/** 场景入参。 */
export interface SinglePackageMainChainOptions {
  readonly worktree: string
  /** D:/dsh-plugin/_wt263/runtime/t1-265（run 根） */
  readonly runBaseDir: string
  readonly verdaccioInstallDir: string
  readonly esbuildPath: string
  /** 指定 runId 时间戳（复跑/回归用）；缺省当前时间。 */
  readonly stamp?: string
  /** 维护者 DSH_HOME（只读指纹；不传则不记）。 */
  readonly maintainerHome?: string
  /** can-red 故障注入：'stale-variant' = 发布 0.0.2 但内容是 0.0.1（验证「可见变化/新版 UI」断言真会红）。 */
  readonly fault?: 'stale-variant'
}

/** 面板状态（一次 DOM 快照；actual 必须来自这里，不许编）。 */
export interface PanelState {
  readonly present: boolean
  readonly seal: string | null
  readonly mode: string | null
  readonly versions: readonly string[]
  readonly check: { text: string; disabled: boolean } | null
  readonly install: { text: string; disabled: boolean } | null
  readonly updater: string | null
  readonly banner: string | null
  readonly error: string | null
  readonly progressText: string | null
  readonly logText: string | null
  readonly card: { clientTag: string | null; title: string | null; hostTag: string | null } | null
  readonly pageText: string | null
}

/** 夹具卡片状态（重启后可见变化断言用）。 */
export interface CardState {
  readonly present: boolean
  readonly clientTag: string | null
  readonly title: string | null
  readonly hostTag: string | null
}

const PANEL_STATE_EXPRESSION = [
  '(() => {',
  '  const panel = document.querySelector(".dsh-upd");',
  '  const versions = Array.from(document.querySelectorAll(".dsh-upd .dsh-upd-strip-v")).map((el) => (el.textContent || "").trim());',
  '  const action = (name) => { const el = Array.from(document.querySelectorAll(".dsh-upd [data-action]")).find((node) => node.getAttribute("data-action") === name); return el ? { text: (el.textContent || "").trim(), disabled: el.hasAttribute("disabled") } : null };',
  '  const card = document.querySelector(".dsh-fixture-card");',
  '  return {',
  '    present: !!panel,',
  '    seal: panel ? panel.getAttribute("data-seal") : null,',
  '    mode: panel ? panel.getAttribute("data-mode") : null,',
  '    versions: versions,',
  '    check: action("check"),',
  '    install: action("install"),',
  '    updater: (document.querySelector(".dsh-upd-updater-id") || {}).textContent || null,',
  '    banner: (document.querySelector(".dsh-upd .dsh-upd-banner") || {}).textContent || null,',
  '    error: (document.querySelector(".dsh-upd .dsh-upd-err") || {}).textContent || null,',
  '    progressText: (document.querySelector(".dsh-upd .dsh-upd-progtxt") || {}).textContent || null,',
  '    logText: (document.querySelector(".dsh-upd .dsh-upd-log") || {}).textContent || null,',
  '    card: card ? { clientTag: card.getAttribute("data-build-tag"), title: (card.querySelector("[data-fixture-section=title]") || {}).textContent || null, hostTag: (card.querySelector("[data-fixture-host-tag]") || {}).textContent || null } : null,',
  '    pageText: document.body ? document.body.innerText : null,',
  '  };',
  '})()',
].join('\n')

/** 读一次面板状态。 */
export async function readPanelState(session: DesktopSession): Promise<PanelState> {
  return session.cdp.evaluate<PanelState>(PANEL_STATE_EXPRESSION)
}

/** 点一个面板动作（DOM click；坐标点击在桌面/headless 都不可靠）。 */
export async function clickPanelAction(session: DesktopSession, action: string): Promise<void> {
  const selector = '.dsh-upd [data-action="' + action + '"]'
  await session.cdp.waitForSelector(selector, { timeoutMs: 30000 })
  await session.cdp.scrollIntoView(selector)
  await session.cdp.clickSelector(selector)
}

/** 等面板就绪（夹具卡片 + 面板都在，且状态已从占位「…」变成真实版本）。 */
async function waitForFixtureLoaded(session: DesktopSession, timeoutMs: number): Promise<PanelState> {
  await session.cdp.waitForExpression('!!document.querySelector(".dsh-fixture-card") && !!document.querySelector(".dsh-upd")', {
    timeoutMs,
    label: '夹具卡片与更新面板加载完成',
  })
  return waitFor(
    '面板状态从占位渲染成真实版本',
    async () => {
      const state = await readPanelState(session).catch(() => null)
      if (!state) return null
      const versionsReady = state.versions.length >= 3 && !!state.versions[0] && state.versions[0] !== '…'
      const hostReady = !!state.card && !!state.card.hostTag && state.card.hostTag.indexOf('host v') === 0
      return versionsReady && hostReady ? state : null
    },
    { timeoutMs, intervalMs: 500 },
  )
}

/** 读卡片状态（client 构建标记 / 标题 / host 标记）。 */
export async function readCardState(session: DesktopSession): Promise<CardState> {
  return session.cdp.evaluate<CardState>([
    '(() => {',
    '  const card = document.querySelector(".dsh-fixture-card");',
    '  if (!card) return { present: false, clientTag: null, title: null, hostTag: null };',
    '  return {',
    '    present: true,',
    '    clientTag: card.getAttribute("data-build-tag"),',
    '    title: (card.querySelector("[data-fixture-section=title]") || {}).textContent || null,',
    '    hostTag: (card.querySelector("[data-fixture-host-tag]") || {}).textContent || null,',
    '  };',
    '})()',
  ].join('\n'))
}

/** 整窗截图并登记（编号 + sidecar 四段）。 */
export async function captureShot(
  recorder: EvidenceRecorder,
  session: DesktopSession,
  meta: { step: string; what: string; expected: string; actual: string; verdict: 'pass' | 'fail' | 'known-red' | 'unknown'; note?: string },
): Promise<void> {
  const png = await session.cdp.screenshot({ timeoutMs: 60000 })
  await recorder.shot('shot', png, meta)
}

/** 场景主流程。 */
export async function runSinglePackageMainChain(options: SinglePackageMainChainOptions): Promise<RunManifest> {
  const layout: RunLayout = await createRunLayout({ baseDir: options.runBaseDir, ticket: '265', stamp: options.stamp })
  const recorder = new EvidenceRecorderClass({
    layout,
    scenarioId: 'a-single-package-main-chain',
    environment: collectEnvironmentFacts(options.worktree, 'desktop-official'),
  })
  const assertions: { id: string }[] = []
  const record = (meta: Parameters<EvidenceRecorder['recordAssertion']>[0]): void => {
    assertions.push(recorder.recordAssertion(meta))
  }
  const raw = async (name: string, payload: unknown): Promise<string> => recorder.raw(name, payload)

  const maintainerHome = options.maintainerHome || join(process.env['USERPROFILE'] || 'C:/Users/default', '.dsh')
  const maintainerBefore = await captureMaintainerProfile(maintainerHome).catch(() => ({}) as Record<string, string>)

  let fixtureEnv: FixtureEnvironment | null = null
  let session: DesktopSession | null = null
  const cleanupProcesses: { label: string; pid: number | null; aliveAfterStop: boolean }[] = []
  const cleanupPorts: { label: string; port: number; released: boolean }[] = []
  const notes: string[] = []
  const profileName = 'desktop'

  try {
    // ---- 0. 环境：本地 registry + SUT 钉版 ----
    fixtureEnv = await createFixtureEnvironment({
      layout,
      verdaccioInstallDir: options.verdaccioInstallDir,
      sutRoot: options.worktree,
      esbuildPath: options.esbuildPath,
    })
    const registry = fixtureEnv.registry
    notes.push('本地 registry：' + registry.baseUrl + '（仓库外 verdaccio，run 内独立 storage）')
    await raw('registry-launch', {
      baseUrl: registry.baseUrl,
      port: registry.port,
      stdout: registry.stdout(),
      stderr: registry.stderr(),
      npmrcPath: registry.npmrcPath,
    })
    const sut = fixtureEnv.sut
    const sutFacts: SutFacts = {
      name: sut.name,
      version: sut.version,
      tarball: sut.tarball,
      tarballSha256: sut.tarballSha256,
      distDigest: sut.distDigest,
      distFiles: sut.distFiles,
      registryUrl: registry.baseUrl,
    }
    recorder.setSut(sutFacts)
    await raw('sut-pin', { sut: sutFacts, pack: { exitCode: sut.pack.exitCode, stdout: sut.pack.stdout, stderr: sut.pack.stderr } })
    record({
      step: 'SUT 钉版',
      what: '被测更新系统 = 当前工作树 npm pack 出来的 dsh-plugin-update，发到本地 registry 的版本号等于工作树版本',
      expected: '本地 registry 可见 ' + sut.name + '@' + sut.version + '，且 tarball sha256 落盘',
      actual: sut.name + '@' + sut.version + '，tarball sha256 ' + sut.tarballSha256.slice(0, 16) + '…，dist ' + sut.distFiles + ' 文件',
      verdict: 'pass',
    })

    // ---- 1. 发布 A@0.0.1 + 干净 profile 安装 ----
    const publishedOld: PublishedFixture = await fixtureEnv.publish('a', '0.0.1')
    await raw('fixture-published-old', {
      spec: fixtureSpecOf(publishedOld),
      plan: { packageName: publishedOld.plan.packageName, version: publishedOld.plan.version, dirName: publishedOld.plan.dirName },
      artifacts: publishedOld.built.artifacts,
      publish: { exitCode: publishedOld.publish.exitCode, stdout: publishedOld.publish.stdout, stderr: publishedOld.publish.stderr },
      buildTags011: publishedOld.plan.sourceFiles.find((file) => file.path === 'src/client.ts')?.content.length,
    })
    notes.push('夹具 ' + fixtureSpecOf(publishedOld) + '（A 案：批量集成方，selfOrder=first，targets=[a,b,c]）')

    // 官方桌面首次启动会自己建 <home>/profiles/desktop；先起一次让它落地，再 CLI 装夹具（避免「立即启用不生效」）。
    session = await launchDesktopApp({ homeDir: layout.homeDir, userDataDir: layout.userDataDir, extraEnv: { DSH_SELFTEST_REGISTRY: registry.baseUrl } })
    const firstLaunchPid = session.process.pid() ?? null
    await waitForProfileDir({ homeDir: layout.homeDir, profileName, timeoutMs: 120000 })
    await session.cdp.waitForExpression('document.body && document.body.innerText.length > 100', { timeoutMs: 120000, label: '桌面首启界面出现' })
    const firstLaunchText = await session.cdp.pageText()
    await raw('desktop-first-launch', { text: firstLaunchText.slice(0, 4000), stdout: session.stdout(), stderr: session.stderr() })
    await session.close()
    session = null
    cleanupProcesses.push({ label: 'desktop-app-bootstrap', pid: firstLaunchPid, aliveAfterStop: false })
    const profileDir = join(layout.homeDir, 'profiles', profileName)
    await ensureDir(profileDir)

    const installResult = await installPluginIntoProfile({
      homeDir: layout.homeDir,
      profileName,
      packageName: publishedOld.plan.packageName,
      version: publishedOld.plan.version,
      registryUrl: registry.baseUrl,
    })
    await raw('install-old', { install: installResult.install, facts: installResult.facts })
    record({
      step: '干净 profile 装 A 旧版',
      what: '隔离 DSH_HOME 的新 desktop profile 里，dsh plugin add 装上 A@0.0.1，磁盘清单三处（dependencies/bundles/包内 package.json）一致',
      expected: 'dependencies=0.0.1；bundles 含 ' + publishedOld.plan.packageName + '；node_modules 包版本=0.0.1',
      actual: 'dependencies=' + String(installResult.facts.dependencyVersion) + '；bundles=[' + installResult.facts.bundles.join(', ') + ']；磁盘版本=' + String(installResult.facts.installedPackageJsonVersion),
      verdict: installResult.facts.installedPackageJsonVersion === '0.0.1' ? 'pass' : 'fail',
    })

    // SUT 钉住：profile 里装上的 dsh-plugin-update/dist 必须与工作树构建一致。
    // 位置取决于包管理器提升策略（hoisted 时在 profile/node_modules 顶层，非提升时嵌在夹具下面），两处都查。
    const profileDirAbs = join(layout.homeDir, 'profiles', profileName)
    const sutDistCandidates = [
      join(profileDirAbs, 'node_modules', sut.name, 'dist'),
      join(installedPluginDir({ homeDir: layout.homeDir, profileName, packageName: publishedOld.plan.packageName }), 'node_modules', sut.name, 'dist'),
    ]
    let installedSutDist: string | null = null
    for (const candidate of sutDistCandidates) {
      if (await directoryExists(candidate)) {
        installedSutDist = candidate
        break
      }
    }
    if (!installedSutDist) throw new Error('[scenario] 在 profile 里找不到已安装的 ' + sut.name + '/dist，候选：' + sutDistCandidates.join(' | '))
    const installedDist = await directoryFingerprint(installedSutDist)
    const installedMatch = installedDist.digest === sut.distDigest
    recorder.setSut({ ...sutFacts, installedDistDigest: installedDist.digest, installedDistMatch: installedMatch })
    await raw('sut-installed-dist', { installedSutDist, installedDist: { digest: installedDist.digest, files: installedDist.files }, workspaceDist: { digest: sut.distDigest, files: sut.distFiles }, match: installedMatch })
    record({
      step: 'SUT 钉住核对',
      what: '夹具装进 profile 后，profile/node_modules/dsh-plugin-update/dist 的聚合指纹等于工作树 dist（真机跑的是当前构建，不是 npm 上游旧版）',
      expected: sut.distDigest,
      actual: installedDist.digest + '（文件数 ' + installedDist.files + ' / 工作树 ' + sut.distFiles + '）',
      verdict: installedMatch ? 'pass' : 'fail',
    })

    // ---- 2. 启动桌面、断言旧版 UI ----
    // 注意：CLI 装完不重启桌面不生效（T0 实测「立即启用」不即时）——这里重起同一隔离实例。
    session = await launchDesktopApp({ homeDir: layout.homeDir, userDataDir: layout.userDataDir, extraEnv: { DSH_SELFTEST_REGISTRY: registry.baseUrl } })
    const mainPid = session.process.pid() ?? null
    const stateOld = await waitForFixtureLoaded(session, 180000)
    await raw('panel-old', stateOld)
    const updaterOk = !!stateOld.updater && stateOld.updater.indexOf(sut.name + '@' + sut.version) >= 0
    const oldUiOk = !!stateOld.card && stateOld.card.clientTag === 'client v0.0.1' && stateOld.versions.length >= 3 && stateOld.versions[0] === '0.0.1' && stateOld.versions[1] === '0.0.1'
    record({
      step: '旧版面板（重启后）',
      what: '官方桌面里 A 的更新面板显示：运行版 0.0.1、已安装 0.0.1、夹具卡片 client v0.0.1；更新器身份是当前 SUT',
      expected: '运行版=已安装=0.0.1；client 构建标记=client v0.0.1；updater 含 ' + sut.name + '@' + sut.version,
      actual: 'versions=[' + stateOld.versions.join(', ') + ']；clientTag=' + String(stateOld.card && stateOld.card.clientTag) + '；updater=' + String(stateOld.updater),
      verdict: oldUiOk && updaterOk ? 'pass' : 'fail',
    })
    await captureShot(recorder, session, {
      step: '旧版面板',
      what: '官方桌面窗口里的 A 面板：版本条带三个 0.0.1/未知，夹具卡片显示 client v0.0.1，更新器显示 dsh-plugin-update@0.18.39 (profile)',
      expected: '运行版=已安装=0.0.1，最新版=未知（未检查），卡片 client v0.0.1',
      actual: 'versions=[' + stateOld.versions.join(', ') + ']；seal=' + String(stateOld.seal) + '；clientTag=' + String(stateOld.card && stateOld.card.clientTag),
      verdict: oldUiOk ? 'pass' : 'fail',
    })

    // ---- 3. 发布 A@0.0.2（可见变化） ----
    const publishedNew: PublishedFixture = options.fault === 'stale-variant'
      ? await fixtureEnv.publish('a', '0.0.2', { staleContentVersion: '0.0.1' })
      : await fixtureEnv.publish('a', '0.0.2')
    if (options.fault) {
      notes.push('can-red 故障注入：' + options.fault + '（发布 0.0.2 但构建内容是 0.0.1；本 run 预期整体 fail，用来证明断言可红）')
      await raw('can-red-fault', { fault: options.fault, expected: '重启后新版 UI 断言失败（clientTag 仍是 client v0.0.1）', publishedNew: fixtureSpecOf(publishedNew) })
    }
    const oldClientHash = await sha256File(join(publishedOld.built.dir, 'lib', 'client.js'))
    const newClientHash = await sha256File(join(publishedNew.built.dir, 'lib', 'client.js'))
    const oldHostHash = await sha256File(join(publishedOld.built.dir, 'lib', 'index.js'))
    const newHostHash = await sha256File(join(publishedNew.built.dir, 'lib', 'index.js'))
    await raw('fixture-published-new', {
      spec: fixtureSpecOf(publishedNew),
      publish: { exitCode: publishedNew.publish.exitCode, stdout: publishedNew.publish.stdout, stderr: publishedNew.publish.stderr },
      artifacts: publishedNew.built.artifacts,
      hashes: { oldClientHash, newClientHash, oldHostHash, newHostHash },
    })
    record({
      step: '发布 A 新版（可见变化）',
      what: '同一包名发布 0.0.2；新版 client bundle 与 host half 的内容哈希都和 0.0.1 不同（构建标记/卡片标题变化）',
      expected: 'client 与 host 的 sha256 都变；registry 可见 0.0.2',
      actual: 'client ' + oldClientHash.slice(0, 12) + '→' + newClientHash.slice(0, 12) + '；host ' + oldHostHash.slice(0, 12) + '→' + newHostHash.slice(0, 12),
      verdict: oldClientHash !== newClientHash && oldHostHash !== newHostHash ? 'pass' : 'fail',
    })
    const metaNew = await (async () => {
      const response = await fetch(registry.baseUrl + '/' + publishedNew.plan.packageName)
      return (await response.json()) as { versions?: Record<string, unknown>; 'dist-tags'?: Record<string, string> }
    })().catch(() => null)
    await raw('registry-metadata-new', metaNew)
    const registryVersions = metaNew && metaNew.versions ? Object.keys(metaNew.versions).sort() : []
    record({
      step: '新版在 registry 可见',
      what: '本地 registry 的 A 元数据包含 0.0.1 与 0.0.2（更新系统查到的 latest 就是它）',
      expected: 'versions 含 0.0.1、0.0.2',
      actual: 'versions=[' + registryVersions.join(', ') + ']；dist-tags=' + JSON.stringify((metaNew && metaNew['dist-tags']) || {}),
      verdict: registryVersions.indexOf('0.0.1') >= 0 && registryVersions.indexOf('0.0.2') >= 0 ? 'pass' : 'fail',
    })

    // ---- 4. 真 UI：检查更新 ----
    await clickPanelAction(session, 'check')
    await waitFor(
      '面板出现可安装的新版 0.0.2',
      async () => {
        const state = await readPanelState(session as DesktopSession).catch(() => null)
        if (!state) return null
        return state.versions[2] === '0.0.2' && !!state.install && state.install.disabled === false ? state : null
      },
      { timeoutMs: 180000, intervalMs: 1000 },
    )
    const stateChecked = await readPanelState(session)
    await raw('panel-after-check', stateChecked)
    record({
      step: '真 UI 检查更新',
      what: '点面板「检查更新」后，最新版变成 0.0.2，安装按钮可用（数据来自面板 DOM 快照）',
      expected: '最新版=0.0.2；安装更新按钮 enabled',
      actual: 'versions=[' + stateChecked.versions.join(', ') + ']；install=' + JSON.stringify(stateChecked.install) + '；seal=' + String(stateChecked.seal),
      verdict: stateChecked.versions[2] === '0.0.2' && !!stateChecked.install && stateChecked.install.disabled === false ? 'pass' : 'fail',
    })
    await captureShot(recorder, session, {
      step: '检查更新后',
      what: '点击「检查更新」后的面板：最新版显示 0.0.2，出现「安装更新」可用按钮',
      expected: '版本条带第三项=0.0.2，安装按钮可用',
      actual: 'versions=[' + stateChecked.versions.join(', ') + ']；install.disabled=' + String(stateChecked.install && stateChecked.install.disabled),
      verdict: stateChecked.versions[2] === '0.0.2' ? 'pass' : 'fail',
    })

    // ---- 5. 真 UI：安装更新（官方桌面 in-process remove→install） ----
    await clickPanelAction(session, 'install')
    const installDeadline = Date.now() + 240000
    let diskVersion: string | null = null
    let lastState: PanelState | null = null
    while (Date.now() < installDeadline) {
      diskVersion = await readInstalledPackageVersion({ homeDir: layout.homeDir, profileName, packageName: publishedNew.plan.packageName })
      lastState = await readPanelState(session).catch(() => null)
      if (diskVersion === '0.0.2') break
      await new Promise((resolve) => setTimeout(() => resolve(undefined), 1500))
    }
    await raw('panel-after-install', { state: lastState, diskVersion })
    const installSettled = diskVersion === '0.0.2'
    record({
      step: '真 UI 安装更新（in-process）',
      what: '点「安装更新」后，官方桌面通过 in-process remove→install（或 restart-required）把 profile 磁盘版本换成 0.0.2',
      expected: '磁盘 node_modules/<pkg>/package.json version=0.0.2',
      actual: '磁盘版本=' + String(diskVersion) + '；面板 seal=' + String(lastState && lastState.seal) + '；进度=' + String(lastState && lastState.progressText),
      verdict: installSettled ? 'pass' : 'fail',
    })
    await captureShot(recorder, session, {
      step: '安装更新后（重启前）',
      what: '安装动作结束后的面板：出现安装结果/待重启状态（面板可能在安装后重挂载，故 clientTag 允许为空）；磁盘已是 0.0.2',
      expected: '安装动作结束（seal/进度有终态或面板重挂载）；磁盘已是 0.0.2',
      actual: 'seal=' + String(lastState && lastState.seal) + '；clientTag=' + String(lastState && lastState.card && lastState.card.clientTag) + '；磁盘=' + String(diskVersion),
      verdict: installSettled ? 'pass' : 'fail',
    })

    // ---- 6. 重启隔离桌面：新版 UI + 可见变化 ----
    const runningPid = session.process.pid() ?? null
    await session.close()
    session = null
    cleanupProcesses.push({ label: 'desktop-app-main', pid: runningPid, aliveAfterStop: false })
    // 重启前再核对一次磁盘清单（桌面退出时不改坏 profile）。
    const manifestAfterUpdate = await readProfileManifest(join(layout.homeDir, 'profiles', profileName))
    await raw('profile-manifest-after-update', manifestAfterUpdate)
    session = await launchDesktopApp({ homeDir: layout.homeDir, userDataDir: layout.userDataDir, extraEnv: { DSH_SELFTEST_REGISTRY: registry.baseUrl } })
    const restartPid = session.process.pid() ?? null
    const stateNew = await waitForFixtureLoaded(session, 180000)
    await raw('panel-new', stateNew)
    const oldTitle = (stateOld.card && stateOld.card.title) || ''
    const newClientOk = !!stateNew.card && stateNew.card.clientTag === 'client v0.0.2'
    const newHostOk = !!stateNew.card && stateNew.card.hostTag === 'host v0.0.2'
    const newTitleOk = !!stateNew.card && !!stateNew.card.title && stateNew.card.title !== oldTitle && stateNew.card.title.indexOf('新版') >= 0
    record({
      step: '重启后新版 UI + 可见变化',
      what: '重启隔离桌面后重新加载的是 0.0.2 的 client/host：卡片标题相对旧版发生变化（旧标题→新标题）、client 构建标记、host 桥标记都变成新版',
      expected: 'client v0.0.2；host v0.0.2；标题从「' + oldTitle + '」变为另一个值且含「新版」；运行版/已安装=0.0.2',
      actual: 'clientTag=' + String(stateNew.card && stateNew.card.clientTag) + '；hostTag=' + String(stateNew.card && stateNew.card.hostTag) + '；title=' + String(stateNew.card && stateNew.card.title) + '（旧：' + oldTitle + '）；versions=[' + stateNew.versions.join(', ') + ']',
      verdict: newClientOk && newHostOk && newTitleOk ? 'pass' : 'fail',
    })
    await captureShot(recorder, session, {
      step: '重启后新版面板',
      what: '重启后的官方桌面窗口：卡片标题变为新版变体，client/host 构建标记都是 v0.0.2，面板运行版/已安装=0.0.2',
      expected: 'client v0.0.2 / host v0.0.2 / 标题含「新版」/ 版本条带 0.0.2',
      actual: 'clientTag=' + String(stateNew.card && stateNew.card.clientTag) + '；hostTag=' + String(stateNew.card && stateNew.card.hostTag) + '；title=' + String(stateNew.card && stateNew.card.title) + '；versions=[' + stateNew.versions.join(', ') + ']',
      verdict: newClientOk && newHostOk && newTitleOk ? 'pass' : 'fail',
    })

    // 磁盘版本与 UI 一致（无虚假成功）。
    diskVersion = await readInstalledPackageVersion({ homeDir: layout.homeDir, profileName, packageName: publishedNew.plan.packageName })
    const manifestFinal = await readProfileManifest(join(layout.homeDir, 'profiles', profileName))
    await raw('final-disk-facts', { diskVersion, manifestFinal })
    record({
      step: 'UI/磁盘一致（无虚假成功）',
      what: '重启后 UI 显示已安装 0.0.2，且磁盘 profile 的 dependencies 与 node_modules 包版本都是 0.0.2',
      expected: 'diskVersion=0.0.2；dependencies[' + publishedNew.plan.packageName + ']=0.0.2',
      actual: 'diskVersion=' + String(diskVersion) + '；dependencies=' + JSON.stringify((manifestFinal.dependencies || {})[publishedNew.plan.packageName] || null),
      verdict: diskVersion === '0.0.2' && (manifestFinal.dependencies || {})[publishedNew.plan.packageName] === '0.0.2' ? 'pass' : 'fail',
    })

    // ---- 7. 日志与台账 ----
    const logFacts = await collectLogEvidence({ layout, homeDir: layout.homeDir })
    await raw('logs-and-ledger', logFacts)
    record({
      step: '日志摘录（结构化事件）',
      what: '临时 DSH_HOME 下找到更新日志，按 JSON 事件核对：检查更新看到 0.0.1→0.0.2、安装电话成功、重启后运行版=0.0.2，且无安装失败事件',
      expected: '日志文件存在；含 update.install.request（current=0.0.1, latest=0.0.2）；含 host.call(update-install, ok=true)；含重启后 status.changed(runningVersion=0.0.2)；含 wire.ready(hostKind=desktop-manager，证明走官方桌面 in-process 出口而非 CLI 兜底)；无安装失败事件',
      actual: logFacts.logSummary,
      verdict: logFacts.logVerdict,
    })
    record({
      step: '宿主通道与安装出口（in-process）',
      what: '日志 update.wire.ready 的 hostKind 声明本次更新走的是官方桌面内建插件管理器（desktop-manager，removeBundle→installBundle），不是 CLI 兜底',
      expected: 'hostKind=desktop-manager',
      actual: 'hostKind=' + String(logFacts.logConditions.desktopManagerHost ? 'desktop-manager' : '缺失'),
      verdict: logFacts.logConditions.desktopManagerHost ? 'pass' : 'fail',
    })
    record({
      step: '台账（作业/队列）',
      what: '找到更新器落盘的作业状态与跨插件队列台账，核对本次更新记录（0.0.1→0.0.2、completed）与 UI、磁盘一致',
      expected: '存在 updates/<目标>/<范围>/state.json 且状态 completed、targetVersion=0.0.2、previousVersion=0.0.1；存在 update-queue/<范围>/queue.json 且 owner=null、waiting=[]',
      actual: logFacts.ledgerSummary,
      verdict: logFacts.ledgerVerdict,
    })

    // ---- 8. 收尾 ----
    await session.close()
    session = null
    cleanupProcesses.push({ label: 'desktop-app-restart', pid: restartPid, aliveAfterStop: false })
    cleanupPorts.push({ label: 'cdp', port: 0, released: true })
    await fixtureEnv.stop()
    cleanupPorts.push({ label: 'registry', port: registry.port, released: await isPortFree(registry.port) })
    fixtureEnv = null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await raw('scenario-error', { message, stack: error instanceof Error ? error.stack : null }).catch(() => '')
    record({
      step: '场景异常',
      what: '主链在异常处中断（保留原始错误与当时的证据）',
      expected: '主链无异常',
      actual: message.slice(0, 1000),
      verdict: 'unknown',
    })
    notes.push('场景异常：' + message.slice(0, 500))
  } finally {
    if (session) {
      try {
        const pid = session.process.pid() ?? null
        await session.close()
        cleanupProcesses.push({ label: 'desktop-app', pid, aliveAfterStop: false })
      } catch (error) {
        notes.push('收尾关桌面失败：' + (error instanceof Error ? error.message : String(error)))
      }
    }
    if (fixtureEnv) {
      const port = fixtureEnv.registry.port
      try {
        await fixtureEnv.stop()
        cleanupPorts.push({ label: 'registry', port, released: await isPortFree(port) })
      } catch (error) {
        notes.push('收尾停 registry 失败：' + (error instanceof Error ? error.message : String(error)))
      }
    }
    const maintainerAfter = await captureMaintainerProfile(maintainerHome).catch(() => ({}) as Record<string, string>)
    recorder.setMaintainerProfile(compareMaintainerProfile(maintainerHome, maintainerBefore, maintainerAfter))
    recorder.setCleanup({ processes: cleanupProcesses, ports: cleanupPorts, notes })
    for (const note of notes) recorder.addNote(note)
    const manifest = await recorder.finish()
    return manifest
  }
}

/** 更新日志里的一条结构化事件（只留核对要用的字段）。 */
interface LogEventRecord {
  readonly event: string
  readonly level: string
  readonly fields: Record<string, unknown>
}

/** 日志与台账收集结果。 */
interface LogEvidenceFacts {
  readonly logSummary: string
  readonly logVerdict: 'pass' | 'fail' | 'unknown'
  readonly ledgerSummary: string
  readonly ledgerVerdict: 'pass' | 'fail' | 'unknown'
  readonly logFiles: readonly string[]
  readonly ledgerFiles: readonly string[]
  readonly logConditions: Record<string, boolean>
  readonly ledgerFacts: Record<string, unknown>
}

/** 找 DSH_HOME 下的更新日志与作业台账（只读；原始副本进 raw，断言用结构化字段）。 */
async function collectLogEvidence(options: { layout: RunLayout; homeDir: string }): Promise<LogEvidenceFacts> {
  // 日志：<home>/logs/<prefix>/<YYYY-MM-DD>.log，行 JSON（v3 日志契约）。
  const logsRoot = join(options.homeDir, 'logs')
  const logFiles: string[] = []
  if (await directoryExists(logsRoot)) {
    for (const rel of await listFilesRecursive(logsRoot)) logFiles.push(rel)
  }
  const events: LogEventRecord[] = []
  for (const rel of logFiles) {
    const absolute = join(logsRoot, rel.split('/').join('\\'))
    const content = await readFile(absolute, 'utf8').catch(() => '')
    const target = join(options.layout.rawDir, 'log-' + rel.split('/').join('-'))
    await writeJsonFile(target, { source: absolute, content: content.slice(0, 50000) }).catch(() => '')
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as { event?: unknown; level?: unknown; fields?: unknown }
        events.push({ event: String(parsed.event || ''), level: String(parsed.level || ''), fields: (parsed.fields || {}) as Record<string, unknown> })
      } catch {
        // 行 JSON 契约外的坏行不参与结构化断言（原始文件已整份进 raw）。
      }
    }
  }
  const installRequest = events.some((item) => item.event === 'update.install.request' && String(item.fields.current) === '0.0.1' && String(item.fields.latest) === '0.0.2')
  const installCall = events.some((item) => item.event === 'host.call' && item.fields.kind === 'update-install' && item.fields.ok === true)
  const restartNewVersion = events.some((item) => item.event === 'update.status.changed' && String(item.fields.runningVersion) === '0.0.2')
  const desktopManagerHost = events.some((item) => item.event === 'update.wire.ready' && item.fields.hostKind === 'desktop-manager')
  const failure = events.some((item) => item.event.indexOf('update.install.fail') >= 0 || item.level === 'error' || (item.event === 'host.call' && item.fields.kind === 'update-install' && item.fields.ok === false))
  const logConditions: Record<string, boolean> = {
    logFilesPresent: logFiles.length > 0,
    installRequest,
    installCall,
    restartNewVersion,
    desktopManagerHost,
    noInstallFailure: !failure,
  }
  const logPass = Object.keys(logConditions).every((key) => logConditions[key])
  const logVerdict: LogEvidenceFacts['logVerdict'] = logFiles.length === 0 ? 'unknown' : logPass ? 'pass' : 'fail'
  const logSummary = '日志文件 ' + logFiles.length + ' 个/事件 ' + events.length + ' 条；条件=' + JSON.stringify(logConditions)

  // 台账：作业状态 <home>/updates/<目标>/<范围短指纹>/state.json；跨插件队列 <home>/update-queue/<范围短指纹>/queue.json。
  const ledgerFiles: string[] = []
  const stateRecords: Record<string, unknown>[] = []
  const queueRecords: Record<string, unknown>[] = []
  const updatesRoot = join(options.homeDir, 'updates')
  if (await directoryExists(updatesRoot)) {
    for (const rel of await listFilesRecursive(updatesRoot)) {
      if (rel.split('/').pop() !== 'state.json') continue
      const absolute = join(updatesRoot, rel.split('/').join('\\'))
      const content = await readFile(absolute, 'utf8').catch(() => '')
      const target = join(options.layout.rawDir, 'ledger-' + rel.split('/').join('-'))
      await writeJsonFile(target, { source: absolute, content: content.slice(0, 50000) }).catch(() => '')
      ledgerFiles.push(target)
      try {
        stateRecords.push(JSON.parse(content) as Record<string, unknown>)
      } catch {
        // 坏台账不参与断言（原文已进 raw）。
      }
    }
  }
  const queueRoot = join(options.homeDir, 'update-queue')
  if (await directoryExists(queueRoot)) {
    for (const rel of await listFilesRecursive(queueRoot)) {
      if (rel.split('/').pop() !== 'queue.json') continue
      const absolute = join(queueRoot, rel.split('/').join('\\'))
      const content = await readFile(absolute, 'utf8').catch(() => '')
      const target = join(options.layout.rawDir, 'ledger-queue-' + rel.split('/').join('-'))
      await writeJsonFile(target, { source: absolute, content: content.slice(0, 50000) }).catch(() => '')
      ledgerFiles.push(target)
      try {
        queueRecords.push(JSON.parse(content) as Record<string, unknown>)
      } catch {
        // 同上。
      }
    }
  }
  const completedState = stateRecords.some((record) => record.state === 'completed' && String(record.targetVersion) === '0.0.2' && String(record.previousVersion) === '0.0.1')
  const queueDrained = queueRecords.some((record) => record.owner === null && Array.isArray(record.waiting) && (record.waiting as unknown[]).length === 0)
  const ledgerFacts = {
    stateFiles: stateRecords,
    queueFiles: queueRecords,
    completedState,
    queueDrained,
  }
  const ledgerPass = completedState && queueDrained
  const ledgerVerdict: LogEvidenceFacts['ledgerVerdict'] = stateRecords.length === 0 && queueRecords.length === 0 ? 'unknown' : ledgerPass ? 'pass' : 'fail'
  const ledgerSummary = '作业状态文件 ' + stateRecords.length + ' 个；队列文件 ' + queueRecords.length + ' 个；completedState=' + String(completedState) + '；queueDrained=' + String(queueDrained) + '；记录=' + JSON.stringify({ stateFiles: stateRecords, queueFiles: queueRecords }).slice(0, 1200)
  return { logSummary, logVerdict, ledgerSummary, ledgerVerdict, logFiles, ledgerFiles, logConditions, ledgerFacts }
}
