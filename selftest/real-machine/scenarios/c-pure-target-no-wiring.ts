/**
 * selftest/real-machine/scenarios/c-pure-target-no-wiring.ts —— 场景 c（#266 T2）：纯目标被批量更新但自己不接更新线。
 *
 * 干净隔离 profile 只装 A@0.0.1（批量集成方）+ C@0.0.1（纯目标；B 声明在 A 的 targets 里但不装）。
 *   → A 批量面板检查更新，C 行显示 0.0.1→0.0.2
 *   → 在 A 的批量面板里点宏按钮「全部更新」（空闲态唯一真入口；产品只在 phase=ready 才给行内 row-install）→ 磁盘 C 到 0.0.2
 *   → 重启桌面：C 徽标内容变成新版（B 码面行为变化可见），但 C 卡片仍然没有面板/入口/中枢坞
 *   → C 的包 manifest 不依赖 dsh-plugin-update（无更新接线的最硬证据），日志里 C 只作为目标出现、没有 C 自己的批量命名空间。
 *
 * 声明驱动：SCENARIO_C_PURE_TARGET（scenario-declarations.ts）；本文件不写死版本/后缀。
 * can-red：options.fault（stale-variant c）→ C 版本号到 0.0.2 但内容仍旧版，UI 断言必须红。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunLayout } from '../runtime/run-layout.ts'
import { createRunLayout } from '../runtime/run-layout.ts'
import type { EvidenceRecorder, RunManifest, SutFacts, Verdict } from '../runtime/evidence.ts'
import { EvidenceRecorder as EvidenceRecorderClass } from '../runtime/evidence.ts'
import { collectEnvironmentFacts } from '../runtime/environment-facts.ts'
import { captureMaintainerProfile, compareMaintainerProfile } from '../runtime/maintainer-profile.ts'
import type { FixtureEnvironment } from '../runtime/fixture-environment.ts'
import { createFixtureEnvironment, fixtureSpecOf } from '../runtime/fixture-environment.ts'
import type { ScenarioFaultInjection } from '../runtime/scenario-runner.ts'
import { baselineVersionOf, installScenarioBaseline, publishScenarioBaseline, publishScenarioVariants, variantVersionOf } from '../runtime/scenario-runner.ts'
import type { FixtureSlot, FixtureSlotKey, FixtureVariantEffect } from '../../fixtures/identity/fixture-slots.ts'
import { fixtureBuildTagsOf, fixtureSlotOf } from '../../fixtures/identity/fixture-slots.ts'
import type { ScenarioDeclaration } from '../../fixtures/identity/scenario-declarations.ts'
import { SCENARIO_C_PURE_TARGET } from '../../fixtures/identity/scenario-declarations.ts'
import type { DesktopSession } from '../host/desktop-app.ts'
import { launchDesktopApp, stopDesktopByPort } from '../host/desktop-app.ts'
import { installPluginIntoProfile, installedPluginDir, waitForProfileDir } from '../host/isolated-profile.ts'
import { readInstalledPackageVersion } from '../host/dsh-cli.ts'
import { directoryExists, directoryFingerprint, ensureDir, sha256File } from '../../tooling/fs-utils.ts'
import { waitFor } from '../../tooling/process.ts'
import { isPortFree } from '../../tooling/ports.ts'
import { captureShot } from './a-single-package-main-chain.ts'
import {
  auditInstallFails,
  clickSeatAction,
  copyRunEvidence,
  packageNamesOfSlots,
  readBatchSeat,
  readDiskSnapshot,
  readLogFacts,
  readPageUpdateState,
  readTargetSeat,
  rowOf,
  slotOfKey,
  targetKeysOf,
  waitForBatchSeat,
  waitForTargetSeat,
} from './batch-helpers.ts'

/** 场景 c 入参。 */
export interface PureTargetOptions {
  readonly worktree: string
  readonly runBaseDir: string
  readonly verdaccioInstallDir: string
  readonly esbuildPath: string
  readonly stamp?: string
  readonly maintainerHome?: string
  readonly fault?: ScenarioFaultInjection
}

function verdictOf(ok: boolean): Verdict {
  return ok ? 'pass' : 'fail'
}

function installEffectOf(scenario: ScenarioDeclaration, slotKey: FixtureSlotKey): FixtureVariantEffect {
  const step = scenario.install.find((item) => item.slotKey === slotKey)
  if (!step) throw new Error('[scenario-c] 场景声明缺少基版：' + slotKey)
  return step.effect
}

function variantEffectOf(scenario: ScenarioDeclaration, slotKey: FixtureSlotKey): FixtureVariantEffect | null {
  const variant = scenario.variants.find((item) => item.slotKey === slotKey)
  return variant ? variant.effect : null
}

/** 主流程。 */
export async function runPureTargetNoWiring(options: PureTargetOptions): Promise<RunManifest> {
  const scenario = SCENARIO_C_PURE_TARGET
  const layout: RunLayout = await createRunLayout({ baseDir: options.runBaseDir, ticket: scenario.ticket, stamp: options.stamp })
  const recorder = new EvidenceRecorderClass({
    layout,
    scenarioId: scenario.id,
    environment: collectEnvironmentFacts(options.worktree, scenario.hostChannel),
  })
  const record = (meta: Parameters<EvidenceRecorder['recordAssertion']>[0]): void => {
    recorder.recordAssertion(meta)
  }
  const raw = async (name: string, payload: unknown): Promise<string> => recorder.raw(name, payload)
  const notes: string[] = []

  const slotA = slotOfKey('a')
  const slotC = slotOfKey('c')
  const installSlots: FixtureSlot[] = [slotA, slotC]
  const packageNames = packageNamesOfSlots(installSlots)
  const installedKeys = installSlots.map((slot) => slot.key)
  const variantC = variantVersionOf(scenario, 'c')
  if (!variantC) throw new Error('[scenario-c] 场景声明缺 C 变体版本')
  const baseA = baselineVersionOf(scenario, 'a')
  const baseC = baselineVersionOf(scenario, 'c')
  const effectC = variantEffectOf(scenario, 'c')
  const titleCNew = fixtureBuildTagsOf(slotC, variantC as '0.0.2', effectC === null ? undefined : effectC).cardTitle
  const badgeNew = 'client v' + variantC + (effectC === null ? '' : effectC.titleSuffix)
  const aTargetKeys = targetKeysOf(slotA)

  const maintainerHome = options.maintainerHome || join(process.env['USERPROFILE'] || 'C:/Users/default', '.dsh')
  const maintainerBefore = await captureMaintainerProfile(maintainerHome).catch(() => null)
  const profileName = 'desktop'
  let fixtureEnv: FixtureEnvironment | null = null
  let session: DesktopSession | null = null
  let interrupted: string | null = null
  let registryPort = 0
  const cleanupProcesses: { label: string; pid: number | null; aliveAfterStop: boolean }[] = []
  const cleanupPorts: { label: string; port: number; released: boolean }[] = []

  try {
    // ---- 0. 环境：本地 registry + SUT 钉版 ----
    fixtureEnv = await createFixtureEnvironment({
      layout,
      verdaccioInstallDir: options.verdaccioInstallDir,
      sutRoot: options.worktree,
      esbuildPath: options.esbuildPath,
    })
    const registry = fixtureEnv.registry
    registryPort = registry.port
    await raw('registry-launch', { baseUrl: registry.baseUrl, port: registry.port, npmrcPath: registry.npmrcPath, stdout: registry.stdout(), stderr: registry.stderr() })
    notes.push('本地 registry：' + registry.baseUrl)
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
      what: '被测更新系统 = 当前工作树 npm pack 的 dsh-plugin-update，发本地 registry；C 的更新由它驱动',
      expected: '本地 registry 可见 ' + sut.name + '@' + sut.version,
      actual: sut.name + '@' + sut.version + '，sha256 ' + sut.tarballSha256.slice(0, 16) + '…',
      verdict: 'pass',
    })

    // ---- 1. 发布场景 c 基版（声明驱动） ----
    const baseline = await publishScenarioBaseline(scenario, fixtureEnv)
    await raw('fixture-published-baseline', {
      scenarioId: scenario.id,
      specs: Object.keys(baseline).map((key) => fixtureSpecOf(baseline[key as FixtureSlotKey])),
      effects: Object.keys(baseline).map((key) => ({ slotKey: key, effect: baseline[key as FixtureSlotKey].plan.effect })),
    })
    notes.push('场景声明基版：' + Object.keys(baseline).map((key) => fixtureSpecOf(baseline[key as FixtureSlotKey])).join('、'))
    const baselineOk = installedKeys.every((key) => baseline[key] !== undefined)
    record({
      step: '发布场景基版（声明驱动）',
      what: '场景声明的 A/C 基版发布到本地 registry（本场景只装这两包；B 只是 A targets 里的一个未安装目标）',
      expected: 'A@' + baseA + '、C@' + baseC + ' 都发布',
      actual: Object.keys(baseline).map((key) => fixtureSpecOf(baseline[key as FixtureSlotKey])).join('、'),
      verdict: verdictOf(baselineOk),
    })

    // 首启让 profile 落地，再 CLI 预装（T0/T1 实测）。
    session = await launchDesktopApp({ homeDir: layout.homeDir, userDataDir: layout.userDataDir, extraEnv: { DSH_SELFTEST_REGISTRY: registry.baseUrl } })
    const bootstrapPid = session.process.pid() ?? null
    await waitForProfileDir({ homeDir: layout.homeDir, profileName, timeoutMs: 120000 })
    await session.cdp.waitForExpression('document.body && document.body.innerText.length > 100', { timeoutMs: 120000, label: '桌面首启界面出现' })
    await raw('desktop-first-launch', { text: (await session.cdp.pageText()).slice(0, 3000), stdout: session.stdout(), stderr: session.stderr() })
    await session.close()
    session = null
    cleanupProcesses.push({ label: 'desktop-app-bootstrap', pid: bootstrapPid, aliveAfterStop: false })
    await ensureDir(join(layout.homeDir, 'profiles', profileName))

    // ---- 2. 干净 profile 装 A + C ----
    const installs = await installScenarioBaseline(scenario, baseline, { homeDir: layout.homeDir, profileName, registryUrl: registry.baseUrl })
    await raw('install-baseline', installs)
    const installedOk = installs.every((item) => {
      const want = baselineVersionOf(scenario, item.slotKey)
      return item.facts.dependencyVersion === want && item.facts.installedPackageJsonVersion === want && item.facts.bundles.indexOf(item.packageName) >= 0
    })
    record({
      step: '干净 profile 装 A（批量）+ C（纯目标）',
      what: '隔离 profile 装入两个夹具包：A 进入批量席位，C 作为纯目标被安装（C 在自己的 dependencies 里不依赖更新内核）',
      expected: 'A@' + baseA + '、C@' + baseC + ' 依赖与磁盘一致且都在 bundles',
      actual: installs.map((item) => item.slotKey + '=' + String(item.facts.installedPackageJsonVersion) + '/dep=' + String(item.facts.dependencyVersion) + '/bundles=' + String(item.facts.bundles.indexOf(item.packageName) >= 0)).join('; '),
      verdict: verdictOf(installedOk),
    })
    const cManifest = JSON.parse(await readFile(join(installedPluginDir({ homeDir: layout.homeDir, profileName, packageName: slotC.packageName }), 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
    await raw('c-manifest', cManifest)
    const cDepsOk = cManifest.dependencies === undefined || Object.keys(cManifest.dependencies).indexOf('dsh-plugin-update') < 0
    record({
      step: 'C 的包 manifest 不依赖更新内核',
      what: 'C 作为纯目标，package.json dependencies 里没有 dsh-plugin-update（无接线的最硬证据，不是只在 UI 上藏起来）',
      expected: 'C dependencies 不含 dsh-plugin-update',
      actual: 'dependencies=' + JSON.stringify(cManifest.dependencies || {}),
      verdict: verdictOf(cDepsOk),
    })
    const profileDir = join(layout.homeDir, 'profiles', profileName)
    const sutDistCandidates = [
      join(profileDir, 'node_modules', sut.name, 'dist'),
      join(installedPluginDir({ homeDir: layout.homeDir, profileName, packageName: slotA.packageName }), 'node_modules', sut.name, 'dist'),
    ]
    let installedSutDist: string | null = null
    for (const candidate of sutDistCandidates) {
      if (await directoryExists(candidate)) {
        installedSutDist = candidate
        break
      }
    }
    if (!installedSutDist) throw new Error('[scenario-c] 找不到 profile 内 ' + sut.name + '/dist')
    const installedDist = await directoryFingerprint(installedSutDist)
    const installedMatch = installedDist.digest === sut.distDigest
    recorder.setSut({ ...sutFacts, installedDistDigest: installedDist.digest, installedDistMatch: installedMatch })
    await raw('sut-installed-dist', { installedSutDist, installedDist: { digest: installedDist.digest, files: installedDist.files }, workspaceDist: { digest: sut.distDigest, files: sut.distFiles }, match: installedMatch })
    record({
      step: 'SUT 钉住核对',
      what: 'profile 内 dsh-plugin-update/dist 聚合指纹等于工作树 dist（更新内核是当前构建）',
      expected: sut.distDigest,
      actual: installedDist.digest + '（一致=' + String(installedMatch) + '）',
      verdict: verdictOf(installedMatch),
    })

    // ---- 3. 启动桌面：初始视图（A 批量三行；C 无任何更新 UI） ----
    session = await launchDesktopApp({ homeDir: layout.homeDir, userDataDir: layout.userDataDir, extraEnv: { DSH_SELFTEST_REGISTRY: registry.baseUrl } })
    const initialA = await waitForBatchSeat(session, 'a', (state) =>
      state.card.present && state.panel.present && state.panel.rows.length === aTargetKeys.length &&
      state.panel.rows.every((row) => row.phase !== null) && (state.card.hostTag || '').indexOf('host v') === 0,
      { label: 'A 批量卡片与三行面板加载完成', timeoutMs: 180000 })
    const initialC = await waitForTargetSeat(session, 'c', (state) => state.present && state.clientTag === 'client v' + baseC, { label: 'C 纯目标徽标加载完成（基版）', timeoutMs: 180000 })
    const initialPage = await readPageUpdateState(session)
    await raw('initial-ui', { a: initialA, c: initialC, page: initialPage })
    const aRowsOk = initialA.panel.rows.map((row) => row.key).join(',') === aTargetKeys.join(',') && initialA.panel.rows.every((row) => row.phase === 'pending')
    record({
      step: '初始：A 批量面板三行（含未安装的 B 目标）',
      what: 'A 是批量集成方，targets 来自声明 a/b/c；b 本场景不装，但 A 的批量视图仍按 targets 列出三行（scope 由声明决定，不因目标未装缩水）',
      expected: 'rows=[' + aTargetKeys.join(',') + ']；phase 全 pending',
      actual: 'rows=[' + initialA.panel.rows.map((row) => row.key).join(',') + ']；' + initialA.panel.rows.map((row) => String(row.key) + '=' + String(row.phase)).join('; '),
      verdict: verdictOf(aRowsOk),
    })
    const cWiringOk = initialC.wiring === 'none' && initialC.ui === 'none' && initialC.dshUpdCount === 0 && initialC.dockCount === 0 && initialC.entryCount === 0 && initialC.clientTag === 'client v' + baseC
    record({
      step: '初始：C 是纯目标（无更新接线）',
      what: 'C 卡片 data-update-wiring=none，卡内没有 .dsh-upd 面板/批量入口/中枢坞；C 不是集成方',
      expected: 'wiring=none；卡内 dshUpd=0/dock=0/entry=0；client v' + baseC,
      actual: 'wiring=' + String(initialC.wiring) + '；dshUpd=' + initialC.dshUpdCount + '；dock=' + initialC.dockCount + '；entry=' + initialC.entryCount + '；clientTag=' + String(initialC.clientTag),
      verdict: verdictOf(cWiringOk),
    })
    const pageInitOk = initialPage.totalBatchPanels === 1 && initialPage.totalDshUpd === 1 && initialPage.totalDocks === 0 && initialPage.fixtureKeys.length === 2
    record({
      step: '初始：整页更新 UI 只有 A 一席',
      what: '只装了一个集成方 A：页面只有 1 份批量面板、1 个 .dsh-upd；C 贡献 0；两个夹具包都真加载',
      expected: 'batchPanels=1、dshUpd=1、fixtures=2',
      actual: 'fixtures=[' + initialPage.fixtureKeys.join(',') + ']；batchPanels=' + initialPage.totalBatchPanels + '；dshUpd=' + initialPage.totalDshUpd + '；docks=' + initialPage.totalDocks,
      verdict: verdictOf(pageInitOk),
    })
    await captureShot(recorder, session, {
      step: '初始：A 批量面板 + C 纯目标（无更新 UI）',
      what: '官方桌面窗口：A 批量面板三行（b 目标未安装行也在）、C 徽标右下/左下且没有任何更新 UI',
      expected: 'A rows=' + aTargetKeys.join('/') + '；C 无 .dsh-upd；batchPanels=1',
      actual: 'A rows=[' + initialA.panel.rows.map((row) => row.key).join(',') + ']；batchPanels=' + initialPage.totalBatchPanels + '；fixtures=[' + initialPage.fixtureKeys.join(',') + ']',
      verdict: verdictOf(aRowsOk && cWiringOk && pageInitOk),
    })

    // 场景声明自证：版本/效果/预期来自单一声明源。
    const declared = {
      id: scenario.id,
      ticket: scenario.ticket,
      install: scenario.install.map((step) => step.slotKey + '@' + step.version),
      variants: scenario.variants.map((variant) => variant.slotKey + '@' + variant.version + '[' + variant.changeClasses.join('+') + ']'),
      expected: scenario.expected,
    }
    await raw('scenario-declaration', declared)
    const declarationOk =
      scenario.id === 'c-pure-target-no-wiring' &&
      scenario.ticket === '266' &&
      scenario.install.length === 2 &&
      scenario.variants.length === 1 &&
      scenario.variants[0]?.slotKey === 'c' &&
      scenario.expected.length === 4 &&
      scenario.hostChannel === 'desktop-official'
    record({
      step: '场景声明驱动（单一真源）',
      what: '本 run 的安装版本/变体/预期全部取自 scenario-declarations.ts 的 c 声明；文件内不写死版本',
      expected: 'id=c-pure-target-no-wiring、install 2 步、variants 1 条（c）、expected 4 条',
      actual: 'id=' + scenario.id + '；install=' + declared.install.join(',') + '；variants=' + declared.variants.join(',') + '；expected=' + scenario.expected.length + ' 条',
      verdict: verdictOf(declarationOk),
    })

    // ---- 4. 发布 C 的 0.0.2 变体（声明驱动） ----
    const publication = await publishScenarioVariants(scenario, fixtureEnv, options.fault, baseline)
    const injected = publication.injected
    const injectedKeys = injected.map((item) => item.slotKey)
    if (injectedKeys.length > 0) {
      recorder.addNote('can-red 故障注入：' + JSON.stringify(injected))
      // 证据契约（selftest/evidence/README.md §7）：can-red run 的 notes + raw 段写明注入点与预期失败点。
      await raw('can-red-fault', {
        fault: options.fault ? { kind: options.fault.kind, slotKey: options.fault.slotKey } : null,
        expected: 'C 版本号到 0.0.2 但内容是 0.0.1：内容哈希/新标记、重启后徽标仍是 v0.0.1 两条应红；其余断言仍 pass（断言编号见 run.json 失败清单）',
        injected,
        publishedSpecs: Object.keys(publication.variants).map((key) => fixtureSpecOf(publication.variants[key as FixtureSlotKey])),
      })
    }
    const variantPlan = publication.variants['c']
    const baselinePlan = baseline['c']
    if (!variantPlan || !baselinePlan) throw new Error('[scenario-c] 变体/基版缺 C 包')
    const oldClientHash = await sha256File(join(baselinePlan.built.dir, 'lib', 'client.js'))
    const newClientBytes = await readFile(join(variantPlan.built.dir, 'lib', 'client.js'), 'utf8')
    const newClientHash = await sha256File(join(variantPlan.built.dir, 'lib', 'client.js'))
    const variantChanged = oldClientHash !== newClientHash && newClientBytes.indexOf('client v' + variantC) >= 0
    await raw('fixture-published-variant-c', {
      fault: options.fault ? { kind: options.fault.kind, slotKey: options.fault.slotKey } : null,
      injected,
      spec: fixtureSpecOf(variantPlan),
      effect: variantPlan.plan.effect,
      oldClientHash,
      newClientHash,
      hasNewTag: newClientBytes.indexOf('client v' + variantC) >= 0,
    })
    record({
      step: '发布 C 的 0.0.2 变体（码面真的变了）',
      what: 'C 的变体包 client.js 哈希与基版不同、bundle 内含 client v0.0.2 标记：内容是新的（不是只改版本号）',
      expected: 'client.js sha256 变化且含 client v' + variantC,
      actual: 'old=' + oldClientHash.slice(0, 16) + '…，new=' + newClientHash.slice(0, 16) + '…；hasNewTag=' + String(newClientBytes.indexOf('client v' + variantC) >= 0),
      verdict: verdictOf(variantChanged),
    })
    record({
      step: 'A 在本场景不被更新（只更新 C）',
      what: '声明里 c 场景的变体只有 C；A 仍停在基版，用来证明「纯目标自己的更新不会顺带改集成方」',
      expected: 'variants=' + declared.variants.join(',') + '（不含 a）',
      actual: 'variants=' + Object.keys(publication.variants).join(','),
      verdict: verdictOf(Object.keys(publication.variants).join(',') === 'c'),
    })

    // ---- 5. A 批量面板检查更新（知识列 0.0.1→0.0.2）→ 宏按钮「全部更新」真装 C ----
    // 产品语义（src/host/batch/fan-out.ts buildRows）：没有批量会话时所有行 phase 恒为 pending，
    // 行相位只来自账本会话；check 只把结论写进 inventory 知识，行版本条读知识渲染；
    // 行内 [data-act=row-install] 只在 phase=ready 时出现——空闲态的真实用户入口是宏按钮 [data-act=install]
    // （全部更新）：无 keys 时新建会话覆盖全部 targets，两段式预查把 c 查成 ready、a 查成 current、
    // b（未安装目标）查成 failed，单家 failed 不抛，随后串行只装 c。本场景据此走真实 UI 路径。
    await clickSeatAction(session, 'a', 'check')
    const checkedA = await waitForBatchSeat(session, 'a', (state) => {
      const rowC = rowOf(state, 'c')
      return rowC !== null && rowC.versionCur === baseC && rowC.versionNew === variantC
    }, { label: 'A 面板检查更新：C 行版本条 0.0.1→0.0.2', timeoutMs: 180000 })
    await raw('a-check-complete', checkedA)
    const cRow = rowOf(checkedA, 'c')
    const checkOk = cRow !== null && cRow.versionCur === baseC && cRow.versionNew === variantC
    record({
      step: 'A 批量面板检查更新（真 UI 点 [data-act=check]）',
      what: 'A 的批量检查把结论写进批量知识：C 行版本条显示当前 0.0.1 → 最新 0.0.2（版本来自 registry，不是写死）',
      expected: 'C 行版本条 ' + baseC + '→' + variantC,
      actual: 'C 行 phase=' + String(cRow?.phase) + ' ' + String(cRow?.versionCur) + '→' + String(cRow?.versionNew) + '；b 行=' + String(rowOf(checkedA, 'b')?.phase) + '/' + String(rowOf(checkedA, 'b')?.versionCur) + '→' + String(rowOf(checkedA, 'b')?.versionNew),
      verdict: verdictOf(checkOk),
    })
    await captureShot(recorder, session, {
      step: 'A 面板检查后：C 行 0.0.1→0.0.2 待装',
      what: 'A 批量面板三行；C 行版本条显示当前 0.0.1 → 最新 0.0.2；b 行（未安装目标）显示未能查询，a 行已是最新',
      expected: 'C 行版本条 0.0.1→0.0.2；行集合=a/b/c',
      actual: 'C 行=' + String(cRow?.phase) + ' ' + String(cRow?.versionCur) + '→' + String(cRow?.versionNew) + '；rows=[' + checkedA.panel.rows.map((row) => row.key).join(',') + ']',
      verdict: verdictOf(checkOk),
    })
    // 真 UI 点宏按钮「全部更新」：这是空闲面板上唯一能发起安装的入口（行级按钮要会话就绪后才出现）。
    // 安装期间只用磁盘轮询、不碰 CDP：批量装「有宿主接线」的夹具时 desktop-manager 可能 relaunch 桌面，
    // 旧 CDP 句柄会失效。纯目标 C 通常不触发重启，这里仍按调试端口收尾兜底（复用 b 场景同口径）。
    await clickSeatAction(session, 'a', 'install')
    const installDeadline = Date.now() + 300000
    let installedC = false
    let lastDisk: { versions: Record<string, string | null> } = { versions: {} }
    while (Date.now() < installDeadline) {
      lastDisk = await readDiskSnapshot({ homeDir: layout.homeDir, profileName, packageNames: [slotC.packageName] })
      if (lastDisk.versions[slotC.packageName] === variantC) {
        installedC = true
        break
      }
      await new Promise<void>((resolve) => setTimeout(() => resolve(), 2000))
    }
    await raw('a-install-c-poll', { installedC, versions: lastDisk.versions })
    record({
      step: 'A 批量面板「全部更新」把 C 推到 0.0.2（真 UI）',
      what: '在 A 的批量面板点 [data-act=install]（全部更新）后，批量会话两段式预查（a current / b failed / c ready）并串行真装 C（磁盘为证；in-process host.call）',
      expected: slotC.packageName + '=' + variantC + '（5 分钟内）',
      actual: JSON.stringify(lastDisk.versions),
      verdict: verdictOf(installedC),
    })
    // 安装结束后收掉桌面（若 desktop-manager 已 relaunch，旧 ManagedProcess 句柄对应的进程已退出），
    // 再起一个被托管的新实例：后面的「重启后」断言直接建在新实例上，批量账本跨重启读回本身就是持久化证据。
    const appPort = session.port
    const mainPid = session.process.pid() ?? null
    const relaunchedPids = await stopDesktopByPort(appPort)
    try {
      await session.close()
    } catch (error) {
      await raw('close-after-install-error', { message: error instanceof Error ? error.message : String(error) })
    }
    session = null
    cleanupProcesses.push({ label: 'desktop-app-main', pid: mainPid, aliveAfterStop: false })
    relaunchedPids.forEach((pid, index) => cleanupProcesses.push({ label: 'desktop-app-auto-relaunch#' + index, pid, aliveAfterStop: false }))
    await raw('post-install-relaunch', { port: appPort, relaunchedPids })
    session = await launchDesktopApp({ homeDir: layout.homeDir, userDataDir: layout.userDataDir, extraEnv: { DSH_SELFTEST_REGISTRY: registry.baseUrl } })
    const afterInstallA = await waitForBatchSeat(session, 'a', (state) => {
      const rowC = rowOf(state, 'c')
      const rowA = rowOf(state, 'a')
      return rowC !== null && rowC.phase === 'done' && rowC.versionCur === variantC &&
        rowA !== null && (rowA.phase === 'current' || rowA.phase === 'done') && rowA.versionCur === baseA
    }, { label: 'A 面板 C 行到 done 0.0.2、a 行 current 0.0.1', timeoutMs: 120000 })
    await raw('a-install-complete', afterInstallA)
    const aStateOk = afterInstallA.panel.rows.map((row) => row.key).join(',') === aTargetKeys.join(',')
    record({
      step: '安装后 A 面板状态与磁盘一致',
      what: 'A 台账里 C 行变 done 且显示 0.0.2；a 行 current（预查判定已是最新，没有被顺带安装）；三行行集合不漂移',
      expected: 'C 行 done/0.0.2；a 行 current/' + baseA + '；rows=[' + aTargetKeys.join(',') + ']',
      actual: 'C 行=' + String(rowOf(afterInstallA, 'c')?.phase) + '/' + String(rowOf(afterInstallA, 'c')?.versionCur) + '；a 行=' + String(rowOf(afterInstallA, 'a')?.phase) + '/' + String(rowOf(afterInstallA, 'a')?.versionCur) + '；rows=[' + afterInstallA.panel.rows.map((row) => row.key).join(',') + ']',
      verdict: verdictOf(aStateOk && rowOf(afterInstallA, 'c')?.phase === 'done' && rowOf(afterInstallA, 'a')?.versionCur === baseA),
    })

    // ---- 6. 重启后的桌面：C 内容变新但仍无更新 UI；A 仍是旧版集成方 ----
    const newA = await waitForBatchSeat(session, 'a', (state) =>
      state.card.clientTag === 'client v' + baseA && state.panel.rows.length === aTargetKeys.length && state.card.hostTag === 'host v' + baseA,
      { label: '重启后 A 仍为基版集成方（0.0.1）', timeoutMs: 180000 })
    const newC = await waitForTargetSeat(session, 'c', (state) => state.present && state.clientTag !== null, { label: '重启后 C 卡片可见', timeoutMs: 180000 })
    const newPage = await readPageUpdateState(session)
    await raw('restart-ui', { a: newA, c: newC, page: newPage })
    const cNewOk = newC.wiring === 'none' && newC.clientTag === 'client v' + variantC && (newC.badgeText || '').indexOf(badgeNew) >= 0
    record({
      step: '重启后 C 内容变新（更新前 vs 更新后对比）',
      what: 'C 被 A 的批量面板推到 0.0.2 后，徽标文本出现 0.0.2 新版内容（行为/元数据变化可见）',
      expected: 'badgeText 含 ' + badgeNew,
      actual: 'badgeText=' + String(newC.badgeText) + '；clientTag=' + String(newC.clientTag),
      verdict: verdictOf(cNewOk),
    })
    record({
      step: '重启后 C 仍没有任何更新 UI（纯目标不建 hub）',
      what: 'C 更新到新版后，卡内仍无 .dsh-upd 面板、无批量入口、无中枢坞；data-update-wiring 仍 none（C 自己不接更新系统）',
      expected: 'wiring=none；卡内 dshUpd=0/dock=0/entry=0',
      actual: 'wiring=' + String(newC.wiring) + '；dshUpd=' + newC.dshUpdCount + '；dock=' + newC.dockCount + '；entry=' + newC.entryCount + '；clientTag=' + String(newC.clientTag),
      verdict: verdictOf(newC.wiring === 'none' && newC.dshUpdCount === 0 && newC.dockCount === 0 && newC.entryCount === 0),
    })
    const aStillOldOk = newA.card.clientTag === 'client v' + baseA && newA.dock === null && newA.card.title === fixtureBuildTagsOf(slotA, baseA as '0.0.1', installEffectOf(scenario, 'a')).cardTitle
    record({
      step: 'A 未被这次 C 更新顺带升级',
      what: '更新只作用于目标 C：A 仍是 0.0.1（标题无新版后缀、没有坞），证明批量行级更新只动选中目标',
      expected: 'A client v' + baseA + '；dock 不存在；标题=基版标题',
      actual: 'A client=' + String(newA.card.clientTag) + '；dock=' + String(newA.dock !== null) + '；title=' + String(newA.card.title),
      verdict: verdictOf(aStillOldOk),
    })
    const pageOk = newPage.totalBatchPanels === 1 && newPage.totalDshUpd === 1 && newPage.totalEntries === 1 && newPage.totalDocks === 0 && newPage.fixtureKeys.length === 2
    record({
      step: '页面级计数：仍只有 A 一个更新入口',
      what: 'C 升级后整页仍只有 A 一席批量 UI（面板 1、入口 1、.dsh-upd 1、坞 0）；C 贡献 0',
      expected: 'batchPanels=1、entries=1、docks=0、dshUpd=1、fixtures=2',
      actual: 'batchPanels=' + newPage.totalBatchPanels + '；entries=' + newPage.totalEntries + '；docks=' + newPage.totalDocks + '；dshUpd=' + newPage.totalDshUpd + '；fixtures=[' + newPage.fixtureKeys.join(',') + ']',
      verdict: verdictOf(pageOk),
    })
    await captureShot(recorder, session, {
      step: '重启后整窗：C 新版内容、无更新 UI；A 仍旧版',
      what: '官方桌面：C 徽标显示 ' + badgeNew + '，卡片无任何更新面板/入口；A 仍是 0.0.1 的旧集成方（无坞）；整页只有 A 一份批量面板',
      expected: 'C badge=' + badgeNew + ' 且 C .dsh-upd=0；A 旧版；batchPanels=1',
      actual: 'C badge=' + String(newC.badgeText) + '；C dshUpd=' + newC.dshUpdCount + '；A client=' + String(newA.card.clientTag) + '；batchPanels=' + newPage.totalBatchPanels,
      verdict: verdictOf(cNewOk && pageOk && aStillOldOk),
    })
    await captureShot(recorder, session, {
      step: '重启后 C 特写（新版内容 + data-update-wiring=none）',
      what: 'C 徽标文本是新版内容，卡片上 data-update-wiring=none、无 .dsh-upd：被更新了但自己不接更新系统',
      expected: 'badgeText 含 ' + badgeNew + '；C wiring=none、dshUpd=0',
      actual: 'badgeText=' + String(newC.badgeText) + '；wiring=' + String(newC.wiring) + '；dshUpd=' + newC.dshUpdCount,
      verdict: verdictOf(cNewOk),
    })

    // ---- 7. 磁盘/依赖/日志一致 ----
    const finalDisk = await readDiskSnapshot({ homeDir: layout.homeDir, profileName, packageNames })
    await raw('final-disk', finalDisk)
    const finalDiskOk = finalDisk.versions[slotC.packageName] === variantC && finalDisk.versions[slotA.packageName] === baseA
    record({
      step: '最终磁盘：C 0.0.2、A 仍 0.0.1',
      what: '已装版本直读：C 到变体版、A 停在基版（只更新目标，不连带更新集成方）',
      expected: 'C=' + variantC + '、A=' + baseA,
      actual: JSON.stringify(finalDisk.versions),
      verdict: verdictOf(finalDiskOk),
    })
    const dependencies = finalDisk.dependencies || {}
    const depsOk = String(dependencies[slotC.packageName] || '').indexOf(variantC) >= 0 && String(dependencies[slotA.packageName] || '').indexOf(baseA) >= 0
    record({
      step: 'profile 依赖声明与磁盘一致',
      what: 'desktop profile 的 C 依赖被更新成 0.0.2，A 依赖仍是 0.0.1',
      expected: 'dependencies: C=' + variantC + '、A=' + baseA,
      actual: JSON.stringify(dependencies),
      verdict: verdictOf(depsOk),
    })
    const logs = await readLogFacts(layout.homeDir)
    await raw('logs', { files: logs.files, events: logs.events })
    const installRequests = logs.events.filter((event) => event.event === 'update.install.request')
    const installAudit = auditInstallFails(logs.events)
    const logConds = {
      installC: installRequests.some((event) => event.namespace === 'fxa-c'),
      hostCallOk: logs.events.some((event) => event.event === 'host.call' && event.fields['kind'] === 'update-install' && event.fields['ok'] === true),
      wireDesktop: logs.events.some((event) => event.event === 'update.wire.ready' && event.fields['hostKind'] === 'desktop-manager'),
      noErrorLevel: !logs.events.some((event) => event.level === 'error'),
      // 设计内首提拒绝（#70 / ADR-0004 §3 A 案）：只允许 check-expired，且每条后面必须有一次同目标 retry（当场重查重提）。
      installFailDesignOnly: installAudit.nonCheckExpired === 0 && installAudit.unretried === 0,
      cHasNoOwnNamespace: logs.files.every((file) => file.split('/')[0] !== 'fxc') && logs.events.every((event) => event.namespace.indexOf('fxc') !== 0),
    }
    const logOk = Object.values(logConds).every((value) => value === true)
    record({
      step: '日志：C 的安装由 A 的批量会话驱动、C 自己没有更新命名空间',
      what: '日志里有 C 目标命名空间(fxa-c)的 install.request、host.call(ok)、wire.ready(desktop-manager)；install.fail 只允许设计内的 check-expired 首提拒绝且每条都紧跟同命名空间 retry；无 error 级；没有任何 fxc* 命名空间（C 不是集成方）',
      expected: 'install.request 命中 fxa-c；host.call ok；wire=desktop-manager；非 check-expired 的 install.fail=0 且未 retry 的拒绝=0；无 error；无 fxc* 日志',
      actual: JSON.stringify(logConds) + '；installAudit=' + JSON.stringify(installAudit) + '；installRequests=' + installRequests.length + '；logFiles=' + logs.files.join(',') ,
      verdict: verdictOf(logOk),
    })
    // B 是 A 的 targets 之一，但本场景没发布/没安装 B：A 的批量检查对 B 行必须是「诚实失败」——
    // 只在该命名空间报 check 失败 + entry 失败(stage=check)，绝不尝试安装 B、且不挡整批把 C 装成。
    const checkFails = logs.events.filter((event) => event.event === 'update.check.fail')
    const entryFails = logs.events.filter((event) => event.event === 'update.batch.entry.fail')
    const bHonest = {
      bCheckFail: checkFails.some((event) => event.namespace === 'fxa-b'),
      bEntryFailAtCheck: entryFails.some((event) => event.namespace === 'fxa-b' && String(event.fields['stage'] || '') === 'check'),
      bNeverInstallAttempted: !installRequests.some((event) => event.namespace === 'fxa-b'),
      bFailNotErrorLevel: checkFails.every((event) => event.namespace !== 'fxa-b' || event.level !== 'error'),
      cInstalledBySameBatch: finalDiskOk,
    }
    const bHonestOk = Object.values(bHonest).every((value) => value === true)
    record({
      step: '未发布/未安装目标（B）的诚实失败：只报 check 失败、不尝试安装、不挡整批',
      what: 'A 的 targets 声明含 b，但本场景没发布也没安装 B（registry 里没有它的版本）：批量检查对 b 行报 check 失败（fxa-b 命名空间）+ entry.fail{stage:check}，warn 级；没有任何 fxa-b 的 install.request；同一批仍把 C 装到变体版',
      expected: 'fxa-b check.fail 存在；fxa-b entry.fail stage=check 存在；fxa-b 无 install.request；b 失败非 error 级；同批 C 装成',
      actual: JSON.stringify(bHonest) + '；checkFails=' + JSON.stringify(checkFails.map((event) => event.namespace + ':' + String(event.fields['code'] || event.fields['reason'] || ''))) + '；entryFails=' + JSON.stringify(entryFails.map((event) => event.namespace + ':' + String(event.fields['stage'] || ''))),
      verdict: verdictOf(bHonestOk),
    })
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error)
    interrupted = message
    record({
      step: '场景 c 全流程执行',
      what: '场景从头到尾无基础设施异常地跑完（异常=blocked 级问题，不是断言失败）',
      expected: '全流程无异常',
      actual: '中断：' + message.split('\n')[0],
      verdict: 'fail',
    })
  } finally {
    if (session !== null) {
      const pid = session.process.pid() ?? null
      try { await session.close() } catch { /* 已退出 */ }
      cleanupProcesses.push({ label: 'desktop-app-final', pid, aliveAfterStop: false })
      session = null
    }
    if (fixtureEnv !== null) {
      try { await fixtureEnv.stop() } catch { /* 已停 */ }
      fixtureEnv = null
    }
  }

  // ---- 8. 收尾证据 ----
  for (const proc of cleanupProcesses) {
    if (proc.pid === null) continue
    try {
      process.kill(proc.pid, 0)
      proc.aliveAfterStop = true
    } catch {
      proc.aliveAfterStop = false
    }
  }
  let registryReleased = false
  if (registryPort > 0) {
    registryReleased = await waitFor('verdaccio 端口释放：' + String(registryPort), async () => ((await isPortFree(registryPort)) ? true : null), { timeoutMs: 20000, intervalMs: 250 })
      .then(() => true)
      .catch(() => false)
    cleanupPorts.push({ label: 'verdaccio', port: registryPort, released: registryReleased })
  }
  for (const proc of cleanupProcesses) {
    if (proc.pid === null || proc.aliveAfterStop === false) continue
    try {
      process.kill(proc.pid, 0)
    } catch {
      proc.aliveAfterStop = false
    }
  }
  const stoppedFinal = cleanupProcesses.every((proc) => proc.aliveAfterStop === false)
  record({
    step: '进程与端口收尾（只清理自己起的）',
    what: '自己启动的桌面进程全部退出、verdaccio 端口释放',
    expected: '所有记录进程 aliveAfterStop=false；verdaccio 端口 released=true',
    actual: 'processes=' + JSON.stringify(cleanupProcesses) + '；ports=' + JSON.stringify(cleanupPorts),
    verdict: verdictOf(stoppedFinal && registryReleased),
  })
  recorder.setCleanup({ processes: cleanupProcesses, ports: cleanupPorts, notes })

  const maintainerAfter = await captureMaintainerProfile(maintainerHome).catch(() => null)
  if (maintainerBefore !== null && maintainerAfter !== null) {
    const maintainerCompare = compareMaintainerProfile(maintainerHome, maintainerBefore, maintainerAfter)
    recorder.setMaintainerProfile(maintainerCompare)
    record({
      step: '维护者 profile 只读核对',
      what: '整个真机跑期间维护者自己的 ~/.dsh 指纹不变（隔离 DSH_HOME + 隔离 user-data-dir）',
      expected: 'maintainer home 指纹 before=after',
      actual: 'homeDir=' + maintainerCompare.homeDir + '；unchanged=' + String(maintainerCompare.unchanged),
      verdict: verdictOf(maintainerCompare.unchanged),
    })
  } else {
    record({
      step: '维护者 profile 只读核对',
      what: '维护者 ~/.dsh 指纹前后对比',
      expected: '能采集到维护者 profile 指纹',
      actual: '维护者 profile 目录不可读（maintainerHome=' + maintainerHome + '）',
      verdict: 'unknown',
    })
  }

  void titleCNew
  if (interrupted !== null) recorder.addNote('场景执行中断（基础设施/界面异常）：' + interrupted.split('\n')[0])
  for (const note of notes) recorder.addNote(note)
  const manifest = await recorder.finish()
  await copyRunEvidence(layout, options.worktree)
  return manifest
}
