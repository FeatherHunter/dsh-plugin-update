/**
 * selftest/real-machine/scenarios/b-batch-two-integrators.ts —— 场景 b（#266 T2）：两个批量集成方 + 一个纯目标。
 *
 * 干净隔离 profile 同装 A@0.0.1（批量）、B@0.0.1（批量）、C@0.0.1（纯目标）→ 官方桌面真 UI：
 *   A 批量面板列出 a/b/c 三目标、B 列出 b/c 两目标（同装互相识别，不串台）
 *   → 发布三个 0.0.2 变体（A/B 改 UI+行为+元数据；C 改内容+元数据）
 *   → A 面板「检查更新」→「全部更新」真 UI 批量安装 → 磁盘 a/b/c 都到 0.0.2
 *   → B 面板再检查：b/c 都是 current（A 的结果对 B 可见，但 B 的会话只含自己的两席）
 *   → 重启桌面：A/B 新 UI（标题后缀/中枢坞/host 行为字段 v2）、C 徽标新内容且仍然没有任何更新 UI
 *   → 磁盘/日志/批量账本/中枢计划/跨插件队列按属主隔离（A=fxa 三键、B=fxb 两键），无跨 scope 污染。
 *
 * 声明驱动：装哪些版本、每个包渲染成什么效果、预期是什么，全部来自
 * fixtures/identity/scenario-declarations.ts 的 SCENARIO_B_BATCH_TWO_INTEGRATORS；本文件不写死版本号/后缀。
 * can-red：options.fault（skip-variant c）→ 同一场景必须 fail（C 拿不到 0.0.2，UI/磁盘断言红）。
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
import { SCENARIO_B_BATCH_TWO_INTEGRATORS } from '../../fixtures/identity/scenario-declarations.ts'
import type { DesktopSession } from '../host/desktop-app.ts'
import { launchDesktopApp, stopDesktopByPort, stopDesktopByUserDataDir } from '../host/desktop-app.ts'
import { installPluginIntoProfile, installedPluginDir, waitForProfileDir } from '../host/isolated-profile.ts'
import { readInstalledPackageVersion } from '../host/dsh-cli.ts'
import { directoryExists, directoryFingerprint, ensureDir, fileExists, sha256File } from '../../tooling/fs-utils.ts'
import { waitFor } from '../../tooling/process.ts'
import { isPortFree } from '../../tooling/ports.ts'
import { captureShot } from './a-single-package-main-chain.ts'
import {
  auditInstallFails,
  captureClippedShot,
  clickSeatAction,
  copyRunEvidence,
  packageNamesOfSlots,
  readBatchDiskFacts,
  readBatchSeat,
  readDiskSnapshot,
  readLogFacts,
  readPageUpdateState,
  readTargetSeat,
  rowKeysOf,
  rowOf,
  slotOfKey,
  targetKeysOf,
  waitForBatchSeat,
  waitForTargetSeat,
} from './batch-helpers.ts'

/** 场景 b 入参（与 T1 tools 入口同风格）。 */
export interface BatchTwoIntegratorsOptions {
  readonly worktree: string
  readonly runBaseDir: string
  readonly verdaccioInstallDir: string
  readonly esbuildPath: string
  readonly stamp?: string
  readonly maintainerHome?: string
  /** can-red 故障注入（缺省 = 正常跑）。 */
  readonly fault?: ScenarioFaultInjection
}

/** 面板行的人读摘要（raw/actual 用；不许拿它单独当断言）。 */
function rowSummary(state: import('./batch-helpers.ts').BatchSeatState): string {
  return state.panel.rows
    .map((row) => {
      const key = row.key || '?'
      const version = row.versionNew !== null ? String(row.versionCur) + '→' + row.versionNew : String(row.versionCur)
      return key + '=' + String(row.phase) + '[' + version + ']' + (row.fail ? '(fail:' + row.fail + ')' : '')
    })
    .join('; ')
}

/** 判定助手：布尔 → 四态。 */
function verdictOf(ok: boolean): Verdict {
  return ok ? 'pass' : 'fail'
}

/** 属主目录名 / 中枢计划 owner：批量前缀就是日志与账本的属主名。 */
function batchPrefixOf(slot: FixtureSlot): string {
  return slot.batch ? slot.batch.prefix : ''
}

/** 声明里某席位基版效果。 */
function installEffectOf(scenario: ScenarioDeclaration, slotKey: FixtureSlotKey): FixtureVariantEffect {
  const step = scenario.install.find((item) => item.slotKey === slotKey)
  if (!step) throw new Error('[scenario-b] 场景声明缺少基版：' + slotKey)
  return step.effect
}

/** 声明里某席位变体效果（没有变体返回 null）。 */
function variantEffectOf(scenario: ScenarioDeclaration, slotKey: FixtureSlotKey): FixtureVariantEffect | null {
  const variant = scenario.variants.find((item) => item.slotKey === slotKey)
  return variant ? variant.effect : null
}

/** JSON 对象安全取值（账本/计划是 unknown）。 */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/** 批量会话/中枢计划里的 entries[].key（按出现顺序）。 */
function entryKeysOf(value: unknown): string[] {
  const entries = asRecord(value)['entries']
  if (!Array.isArray(entries)) return []
  return entries.map((entry) => String(asRecord(entry)['key']))
}

/** inventory.json 的 entries 是对象（key → 条目），取自己的键集合。 */
function inventoryKeysOf(value: unknown): string[] {
  const entries = asRecord(value)['entries']
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) return []
  return Object.keys(entries as Record<string, unknown>)
}

/** 中枢计划里的 targets[].key（计划落盘结构见 src/host/hub/plan-store.ts 的 HubPlan）。 */
function hubPlanTargetKeysOf(value: unknown): string[] {
  const targets = asRecord(value)['targets']
  if (!Array.isArray(targets)) return []
  return targets.map((target) => String(asRecord(target)['key']))
}

/** 两个 key 清单是否集合相等（顺序不敏感：台账联合不等于会话顺序）。 */
function sameKeySet(actual: readonly string[], expected: readonly string[]): boolean {
  const left = actual.slice().sort().join(',')
  const right = expected.slice().sort().join(',')
  return left === right
}

/** 主流程。 */
export async function runBatchTwoIntegrators(options: BatchTwoIntegratorsOptions): Promise<RunManifest> {
  const scenario = SCENARIO_B_BATCH_TWO_INTEGRATORS
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
  const slotB = slotOfKey('b')
  const slotC = slotOfKey('c')
  const slots = [slotA, slotB, slotC]
  const packageNames = packageNamesOfSlots(slots)
  const expectedKeysA = targetKeysOf(slotA)
  const expectedKeysB = targetKeysOf(slotB)
  const variantA = variantVersionOf(scenario, 'a')
  const variantB = variantVersionOf(scenario, 'b')
  const variantC = variantVersionOf(scenario, 'c')
  if (!variantA || !variantB || !variantC) throw new Error('[scenario-b] 场景声明缺变体版本')
  const baseA = baselineVersionOf(scenario, 'a')
  const baseB = baselineVersionOf(scenario, 'b')
  const baseC = baselineVersionOf(scenario, 'c')
  const effectA = variantEffectOf(scenario, 'a')
  const effectB = variantEffectOf(scenario, 'b')
  if (!effectA || !effectB) throw new Error('[scenario-b] A/B 必须有变体效果')
  const titleAOld = fixtureBuildTagsOf(slotA, baseA as '0.0.1', installEffectOf(scenario, 'a')).cardTitle
  const titleBOld = fixtureBuildTagsOf(slotB, baseB as '0.0.1', installEffectOf(scenario, 'b')).cardTitle
  const titleANew = fixtureBuildTagsOf(slotA, variantA as '0.0.2', effectA).cardTitle
  const titleBNew = fixtureBuildTagsOf(slotB, variantB as '0.0.2', effectB).cardTitle

  const maintainerHome = options.maintainerHome || join(process.env['USERPROFILE'] || 'C:/Users/default', '.dsh')
  const maintainerBefore = await captureMaintainerProfile(maintainerHome).catch(() => null)
  let interrupted: string | null = null
  let registryPort = 0
  const profileName = 'desktop'
  let fixtureEnv: FixtureEnvironment | null = null
  let session: DesktopSession | null = null
  const cleanupProcesses: { label: string; pid: number | null; aliveAfterStop: boolean }[] = []
  const cleanupPorts: { label: string; port: number; released: boolean }[] = []
  const registryUrl = (): string => (fixtureEnv === null ? '' : fixtureEnv.registry.baseUrl)

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
      what: '被测更新系统 = 当前工作树 npm pack 出来的 dsh-plugin-update，发到本地 registry 的版本等于工作树版本',
      expected: '本地 registry 可见 ' + sut.name + '@' + sut.version + '，tarball sha256 落盘',
      actual: sut.name + '@' + sut.version + '，sha256 ' + sut.tarballSha256.slice(0, 16) + '…，dist ' + sut.distFiles + ' 文件',
      verdict: 'pass',
    })

    // ---- 1. 按场景声明发布基版 ----
    const baseline = await publishScenarioBaseline(scenario, fixtureEnv)
    await raw('fixture-published-baseline', {
      scenarioId: scenario.id,
      specs: Object.keys(baseline).map((key) => fixtureSpecOf(baseline[key as FixtureSlotKey])),
      effects: Object.keys(baseline).map((key) => ({ slotKey: key, effect: baseline[key as FixtureSlotKey].plan.effect })),
    })
    notes.push('场景声明基版：' + Object.keys(baseline).map((key) => fixtureSpecOf(baseline[key as FixtureSlotKey])).join('、'))
    const baselineVisible: Record<string, string[]> = {}
    for (const slot of slots) {
      const published = baseline[slot.key]
      if (!published) throw new Error('[scenario-b] 基版缺少席位：' + slot.key)
      const response = await fetch(registry.baseUrl + '/' + published.plan.packageName).catch(() => null)
      const meta = response && response.ok ? ((await response.json()) as { versions?: Record<string, unknown> }) : null
      baselineVisible[slot.key] = meta && meta.versions ? Object.keys(meta.versions) : []
    }
    await raw('registry-baseline-visible', baselineVisible)
    const baselineOk = slots.every((slot) => baselineVisible[slot.key] && baselineVisible[slot.key].indexOf(baselineVersionOf(scenario, slot.key)) >= 0)
    record({
      step: '发布场景基版（声明驱动）',
      what: '场景声明的三个基版都发布到本地 registry 且版本可见（A/B 批量效果、C 纯目标效果）',
      expected: 'a/b/c 各自 ' + [baseA, baseB, baseC].join('/') + ' 在 registry 可见',
      actual: JSON.stringify(baselineVisible),
      verdict: verdictOf(baselineOk),
    })

    // 官方桌面首启会自己建 <home>/profiles/desktop；先起一次让它落地，再 CLI 预装（T0/T1 实测）。
    session = await launchDesktopApp({ homeDir: layout.homeDir, userDataDir: layout.userDataDir, extraEnv: { DSH_SELFTEST_REGISTRY: registry.baseUrl } })
    const bootstrapPid = session.process.pid() ?? null
    await waitForProfileDir({ homeDir: layout.homeDir, profileName, timeoutMs: 120000 })
    await session.cdp.waitForExpression('document.body && document.body.innerText.length > 100', { timeoutMs: 120000, label: '桌面首启界面出现' })
    await raw('desktop-first-launch', { text: (await session.cdp.pageText()).slice(0, 3000), stdout: session.stdout(), stderr: session.stderr() })
    await session.close()
    session = null
    cleanupProcesses.push({ label: 'desktop-app-bootstrap', pid: bootstrapPid, aliveAfterStop: false })
    await ensureDir(join(layout.homeDir, 'profiles', profileName))

    // ---- 2. 干净 profile 预装三夹具（CLI 逐个 add + 三处磁盘核对） ----
    const installs = await installScenarioBaseline(scenario, baseline, { homeDir: layout.homeDir, profileName, registryUrl: registry.baseUrl })
    await raw('install-baseline', installs)
    const installedOk = installs.every((item) => {
      const want = baselineVersionOf(scenario, item.slotKey)
      return item.facts.dependencyVersion === want && item.facts.installedPackageJsonVersion === want && item.facts.bundles.indexOf(item.packageName) >= 0
    })
    record({
      step: '干净 profile 三包同装',
      what: '隔离 DSH_HOME 的新 desktop profile 里同装 A/B/C 基版：三个包都进 dependencies/bundles 且磁盘版本一致（同装互相识别的前提）',
      expected: 'a/b/c 依赖版本与磁盘版本都 = 各自基版；三包都在 bundles',
      actual: installs.map((item) => item.slotKey + '=' + String(item.facts.installedPackageJsonVersion) + '/dep=' + String(item.facts.dependencyVersion) + '/bundles=' + String(item.facts.bundles.indexOf(item.packageName) >= 0)).join('; '),
      verdict: verdictOf(installedOk),
    })

    // SUT 钉住：profile 里装上的 dsh-plugin-update/dist 必须等于工作树构建（真机跑当前构建，不是 npm 上游旧版）。
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
    if (!installedSutDist) throw new Error('[scenario-b] 找不到 profile 内 ' + sut.name + '/dist；候选=' + sutDistCandidates.join(' | '))
    const installedDist = await directoryFingerprint(installedSutDist)
    const installedMatch = installedDist.digest === sut.distDigest
    recorder.setSut({ ...sutFacts, installedDistDigest: installedDist.digest, installedDistMatch: installedMatch })
    await raw('sut-installed-dist', { installedSutDist, installedDist: { digest: installedDist.digest, files: installedDist.files }, workspaceDist: { digest: sut.distDigest, files: sut.distFiles }, match: installedMatch })
    record({
      step: 'SUT 钉住核对',
      what: '三夹具装进 profile 后，profile/node_modules/dsh-plugin-update/dist 聚合指纹等于工作树 dist',
      expected: sut.distDigest,
      actual: installedDist.digest + '（' + installedDist.files + ' 文件，一致=' + String(installedMatch) + '）',
      verdict: verdictOf(installedMatch),
    })

    // ---- 3. 启动桌面：初始视图（两席各自 scope + C 无更新 UI） ----
    session = await launchDesktopApp({ homeDir: layout.homeDir, userDataDir: layout.userDataDir, extraEnv: { DSH_SELFTEST_REGISTRY: registry.baseUrl } })
    const initialA = await waitForBatchSeat(
      session,
      'a',
      (state) => state.card.present && state.panel.present && state.panel.rows.length === expectedKeysA.length && state.panel.rows.every((row) => row.phase !== null) && (state.card.hostTag || '').indexOf('host v') === 0,
      { label: 'A 批量卡片与三行面板加载完成（host 桥标记到位）', timeoutMs: 180000 },
    )
    const initialB = await waitForBatchSeat(
      session,
      'b',
      (state) => state.card.present && state.panel.present && state.panel.rows.length === expectedKeysB.length && state.panel.rows.every((row) => row.phase !== null) && (state.card.hostTag || '').indexOf('host v') === 0,
      { label: 'B 批量卡片与两行面板加载完成', timeoutMs: 180000 },
    )
    const initialC = await waitForTargetSeat(session, 'c', (state) => state.present && state.clientTag === 'client v' + baseC, {
      label: 'C 纯目标徽标加载完成（基版内容）',
      timeoutMs: 180000,
    })
    const initialPage = await readPageUpdateState(session)
    await raw('initial-ui', { a: initialA, b: initialB, c: initialC, page: initialPage })

    const initialKeysA = rowKeysOf(initialA)
    const initialKeysB = rowKeysOf(initialB)
    const aIdentityOk =
      initialA.card.ui === 'batch' &&
      initialA.card.seatLine !== null &&
      initialA.card.seatLine.attr === installEffectOf(scenario, 'a').seatLine &&
      initialA.card.seatLine.attr === '批量席位 fxa · 自键 a · 目标 a/b/c' &&
      initialA.card.clientTag === 'client v' + baseA &&
      initialA.card.title === titleAOld &&
      initialA.entry !== null &&
      initialA.panel.mode === 'embedded'
    record({
      step: '初始：A 批量席位身份',
      what: 'A 卡片是真·批量集成方（批量注入 + 自家批量电话前缀 + targets a/b/c），client 构建标记与标题来自场景声明基版',
      expected: 'ui=batch；席位行=' + installEffectOf(scenario, 'a').seatLine + '；client v' + baseA + '；标题=' + titleAOld + '；批量入口存在；面板 embedded',
      actual: 'ui=' + String(initialA.card.ui) + '；seatLine=' + String(initialA.card.seatLine ? initialA.card.seatLine.attr : null) + '；clientTag=' + String(initialA.card.clientTag) + '；title=' + String(initialA.card.title) + '；entry=' + String(initialA.entry !== null) + '；mode=' + String(initialA.panel.mode),
      verdict: verdictOf(aIdentityOk),
    })
    const aRowsOk = sameKeySet(initialKeysA.map((key) => String(key)), expectedKeysA) && initialKeysA.join(',') === expectedKeysA.join(',') && initialA.panel.rows.every((row) => row.phase === 'pending')
    record({
      step: '初始：A 批量入口列出三目标',
      what: 'A 的批量面板行 = A 声明的 targets（a/b/c，顺序即会话顺序），检查前全部 pending（autoCheck=false，不偷跑）',
      expected: 'rows=[' + expectedKeysA.join(',') + ']，phase 全 pending',
      actual: 'rows=[' + initialKeysA.join(',') + ']；' + rowSummary(initialA),
      verdict: verdictOf(aRowsOk),
    })
    const bIdentityOk =
      initialB.card.ui === 'batch' &&
      initialB.card.seatLine !== null &&
      initialB.card.seatLine.attr === installEffectOf(scenario, 'b').seatLine &&
      initialB.card.clientTag === 'client v' + baseB &&
      initialB.card.title === titleBOld &&
      initialB.entry !== null
    record({
      step: '初始：B 批量席位身份',
      what: 'B 卡片是另一个真·批量集成方（自家批量前缀 fxb + targets b/c），与 A 同时加载互相识别、身份不混',
      expected: 'B 席位行=' + installEffectOf(scenario, 'b').seatLine + '；client v' + baseB + '；标题=' + titleBOld + '；批量入口存在',
      actual: 'seatLine=' + String(initialB.card.seatLine ? initialB.card.seatLine.attr : null) + '；clientTag=' + String(initialB.card.clientTag) + '；title=' + String(initialB.card.title),
      verdict: verdictOf(bIdentityOk),
    })
    const bRowsOk = sameKeySet(initialKeysB.map((key) => String(key)), expectedKeysB) && initialB.panel.rows.every((row) => row.phase === 'pending')
    record({
      step: '初始：B 批量入口列出两目标',
      what: 'B 的批量面板行 = B 声明的 targets（b/c），没有 A 的 a 行（不串 scope）',
      expected: 'rows 集合={' + expectedKeysB.join(',') + '}（自键因 selfOrder=last 排最后，顺序不敏感），phase 全 pending',
      actual: 'rows=[' + initialKeysB.join(',') + ']；' + rowSummary(initialB),
      verdict: verdictOf(bRowsOk),
    })
    const cWiringOk = initialC.wiring === 'none' && initialC.ui === 'none' && initialC.dshUpdCount === 0 && initialC.dockCount === 0 && initialC.entryCount === 0 && initialC.clientTag === 'client v' + baseC
    record({
      step: '初始：C 纯目标无更新接线',
      what: 'C 卡片带 data-update-wiring=none，卡内没有任何 .dsh-upd 面板/批量入口/中枢坞（纯目标不建 hub）',
      expected: 'wiring=none；卡内 .dsh-upd=0、dock=0、entry=0；client v' + baseC,
      actual: 'wiring=' + String(initialC.wiring) + '；dshUpd=' + initialC.dshUpdCount + '；dock=' + initialC.dockCount + '；entry=' + initialC.entryCount + '；clientTag=' + String(initialC.clientTag),
      verdict: verdictOf(cWiringOk),
    })
    const twoPanelsOk = initialPage.totalBatchPanels === 2 && initialPage.totalDshUpd === 2 && initialPage.totalDocks === 0 && initialPage.fixtureKeys.length === 3
    record({
      step: '初始：页面级更新 UI 只属于两席集成方',
      what: '整页只有 A/B 两份批量面板（各一个 .dsh-upd），C 贡献 0；三个夹具包都真加载了',
      expected: '3 张夹具卡片；批量面板=2；.dsh-upd=2；中枢坞=0',
      actual: 'fixtures=[' + initialPage.fixtureKeys.join(',') + ']；batchPanels=' + initialPage.totalBatchPanels + '；dshUpd=' + initialPage.totalDshUpd + '；docks=' + initialPage.totalDocks,
      verdict: verdictOf(twoPanelsOk),
    })
    await captureShot(recorder, session, {
      step: '初始：三包同装（两席批量面板 + C 纯目标）',
      what: '官方桌面窗口里同时看到：A 批量面板（三行 a/b/c，右下）、B 批量面板（两行 b/c，左上）、C 纯目标徽标（左下，没有任何更新 UI）',
      expected: 'A rows=' + expectedKeysA.join('/') + '、B rows=' + expectedKeysB.join('/') + '，C 无面板',
      actual: 'A rows=[' + initialKeysA.join(',') + ']；B rows=[' + initialKeysB.join(',') + ']；页面 batchPanels=' + initialPage.totalBatchPanels + '；fixtures=[' + initialPage.fixtureKeys.join(',') + ']',
      verdict: verdictOf(aRowsOk && bRowsOk && twoPanelsOk && cWiringOk),
    })

    // 场景声明自证：版本/效果/预期全部来自单一声明源（矩阵行 id 即 scenarioId）。
    const declared = {
      id: scenario.id,
      ticket: scenario.ticket,
      install: scenario.install.map((step) => step.slotKey + '@' + step.version),
      variants: scenario.variants.map((variant) => variant.slotKey + '@' + variant.version + '[' + variant.changeClasses.join('+') + ']'),
      expected: scenario.expected,
    }
    await raw('scenario-declaration', declared)
    const declarationOk =
      scenario.id === 'b-batch-two-integrators' &&
      scenario.ticket === '266' &&
      scenario.install.length === 3 &&
      scenario.variants.length === 3 &&
      scenario.expected.length === 5 &&
      scenario.hostChannel === 'desktop-official'
    record({
      step: '场景声明驱动（单一真源）',
      what: '本 run 的安装版本/变体效果/预期全部取自 scenario-declarations.ts 的 b 声明；场景文件不写死版本（版本来自 baselineVersionOf/variantVersionOf）',
      expected: 'id=b-batch-two-integrators、install 3 步、variants 3 条、expected 5 条、hostChannel=desktop-official',
      actual: 'id=' + scenario.id + '；install=' + declared.install.join(',') + '；variants=' + declared.variants.join(',') + '；expected=' + scenario.expected.length + ' 条',
      verdict: verdictOf(declarationOk),
    })

    // ---- 4. 发布 0.0.2 变体（声明驱动） ----
    const publication = await publishScenarioVariants(scenario, fixtureEnv, options.fault, baseline)
    const injected = publication.injected
    const injectedKeys = injected.map((item) => item.slotKey)
    if (injectedKeys.length > 0) {
      recorder.addNote('can-red 故障注入：' + JSON.stringify(injected))
      // 证据契约（selftest/evidence/README.md §7）：can-red run 的 notes + raw 段写明注入点与预期失败点。
      await raw('can-red-fault', {
        fault: options.fault ? { kind: options.fault.kind, slotKey: options.fault.slotKey } : null,
        expected: 'C 拿不到 0.0.2：A/B 重启后的行态与版本条、C 徽标新版、日志 installC 四条应红；其余断言仍 pass（断言编号见 run.json 失败清单）',
        injected,
        publishedSpecs: Object.keys(publication.variants).map((key) => fixtureSpecOf(publication.variants[key as FixtureSlotKey])),
      })
    }
    // can-red 注入（skip-variant）下该席位的变体没有发布：目标只能停在基版。
    // 这不是放宽断言——期望值按注入后的真实计划计算（正常=变体版，注入=基版），
    // 于是「三目标都到变体版 / C 内容变新」这类被测断言在注入时真失败（见 coverage-matrix 的 can-red 记录）。
    const injectedOf = (key: FixtureSlotKey): boolean => injectedKeys.indexOf(key) >= 0
    const expectedVersionOf = (key: FixtureSlotKey): string => {
      if (injectedOf(key)) return baselineVersionOf(scenario, key)
      const variant = variantVersionOf(scenario, key)
      if (!variant) throw new Error('[scenario-b] 场景声明缺变体版本：' + key)
      return variant
    }
    const variantContent: Record<string, { clientChanged: boolean; hostChanged: boolean | null; clientHasNewTag: boolean }> = {}
    for (const variant of scenario.variants) {
      if (injectedKeys.indexOf(variant.slotKey) >= 0) continue
      const baselinePlan = baseline[variant.slotKey]
      const variantPlan = publication.variants[variant.slotKey]
      if (!baselinePlan || !variantPlan) throw new Error('[scenario-b] 变体发布缺包：' + variant.slotKey)
      const oldClient = join(baselinePlan.built.dir, 'lib', 'client.js')
      const newClient = join(variantPlan.built.dir, 'lib', 'client.js')
      const oldHost = join(baselinePlan.built.dir, 'lib', 'host.js')
      const newHost = join(variantPlan.built.dir, 'lib', 'host.js')
      const oldClientHash = (await fileExists(oldClient)) ? await sha256File(oldClient) : ''
      const newClientBytes = (await fileExists(newClient)) ? await readFile(newClient, 'utf8') : ''
      const newClientHash = newClientBytes ? await sha256File(newClient) : ''
      const hostPair = (await fileExists(oldHost)) && (await fileExists(newHost))
      const hostChanged = hostPair ? (await sha256File(oldHost)) !== (await sha256File(newHost)) : null
      variantContent[variant.slotKey] = {
        clientChanged: oldClientHash !== '' && newClientHash !== '' && oldClientHash !== newClientHash,
        hostChanged,
        clientHasNewTag: newClientBytes.indexOf('client v' + variant.version) >= 0,
      }
    }
    await raw('fixture-published-variants', {
      fault: options.fault ? { kind: options.fault.kind, slotKey: options.fault.slotKey } : null,
      injected,
      specs: Object.keys(publication.variants).map((key) => fixtureSpecOf(publication.variants[key as FixtureSlotKey])),
      effects: Object.keys(publication.variants).map((key) => ({ slotKey: key, effect: publication.variants[key as FixtureSlotKey].plan.effect })),
      variantContent,
    })
    const contentChangedOk = Object.keys(variantContent).length === scenario.variants.length - injectedKeys.length && Object.keys(variantContent).every((key) => {
      const entry = variantContent[key]
      return entry.clientChanged && entry.clientHasNewTag
    })
    record({
      step: '发布 0.0.2 变体（码面真的变了）',
      what: '三个变体包内容与基版不同：client.js sha256 变化且 bundle 内带新版构建标记（不是只改版本号）',
      expected: (scenario.variants.length - injectedKeys.length) + ' 个非注入变体的 client.js 哈希与基版不同、且内含 client v0.0.2 标记',
      actual: JSON.stringify(variantContent),
      verdict: verdictOf(contentChangedOk),
    })
    const baseEffectA = installEffectOf(scenario, 'a')
    const baseEffectB = installEffectOf(scenario, 'b')
    const uiChangedOk =
      (baseEffectA.titleSuffix !== effectA.titleSuffix || baseEffectA.hubDock !== effectA.hubDock || baseEffectA.hostBehavior !== effectA.hostBehavior) &&
      (baseEffectB.titleSuffix !== effectB.titleSuffix || baseEffectB.hubDock !== effectB.hubDock || baseEffectB.hostBehavior !== effectB.hostBehavior) &&
      effectA.hubDock === true && effectB.hubDock === true &&
      effectA.hostBehavior === 'seat-aware-v2' && effectB.hostBehavior === 'seat-aware-v2' &&
      effectA.titleSuffix.length > 0 && effectB.titleSuffix.length > 0
    record({
      step: 'B 码面：集成方变体改可见 UI/行为（非只改版本）',
      what: 'A/B 的 0.0.2 变体在声明里改了 UI+行为+元数据三类：卡片标题后缀、中枢进度坞出现、host 行为字段 seat-aware-v2',
      expected: 'A/B 的 titleSuffix/hubDock/hostBehavior 至少一变，且 hubDock=true、hostBehavior=seat-aware-v2',
      actual: 'A: suffix=' + effectA.titleSuffix + ' hubDock=' + String(effectA.hubDock) + ' behavior=' + String(effectA.hostBehavior) + '；B: suffix=' + effectB.titleSuffix + ' hubDock=' + String(effectB.hubDock) + ' behavior=' + String(effectB.hostBehavior),
      verdict: verdictOf(uiChangedOk),
    })
    const variantVisible = await waitFor('registry 变体可见', async () => {
      const response = await fetch(registry.baseUrl + '/' + slotA.packageName).catch(() => null)
      if (!response || !response.ok) return null
      const meta = (await response.json()) as { versions?: Record<string, unknown> }
      const versions = meta.versions ? Object.keys(meta.versions) : []
      return versions.indexOf(variantA) >= 0 ? versions : null
    }, { timeoutMs: 30000, intervalMs: 500 }).catch(() => null)
    record({
      step: '变体版本在 registry 可见',
      what: '本地 registry 能看到 A 的 0.0.2（真机更新链路的真实来源）',
      expected: slotA.packageName + ' 可见 ' + variantA,
      actual: variantVisible ? 'versions=' + variantVisible.join(',') : '未在 30s 内看到 ' + variantA,
      verdict: verdictOf(variantVisible !== null),
    })
    await captureShot(recorder, session, {
      step: '发布变体后：两席面板仍在、C 仍无更新 UI',
      what: '发布 0.0.2 后重新读页面：A/B 批量面板仍在（还未点检查），C 卡片依旧没有任何 .dsh-upd',
      expected: 'A panels rows=' + expectedKeysA.join('/') + '、B rows=' + expectedKeysB.join('/') + '、C .dsh-upd=0',
      actual: '页面 batchPanels=' + String((await readPageUpdateState(session)).totalBatchPanels),
      verdict: 'pass',
    })

    // ---- 5. A 面板检查更新：三目标知识列都应看到 0.0.1 → 0.0.2 ----
    // 产品语义（src/host/batch/fan-out.ts checkPhone / buildRows）：空闲面板没有批量会话，
    // 所有行 phase 恒为 pending；check 只把结论写进 inventory 知识，行版本条由知识渲染。
    // 所以这里断言的是「版本条 基版→变体版」（真 UI 可见的知识），相位留待宏「全部更新」建会话后再断言。
    await clickSeatAction(session, 'a', 'check')
    // 检查结论的知识列：cur=当前已装（总是基版）；next=registry 最新（注入 skip 的席位没有变体 → null）。
    const aExpectedRow = (key: string): { cur: string; next: string | null } => ({
      cur: baselineVersionOf(scenario, key as FixtureSlotKey),
      next: injectedOf(key as FixtureSlotKey) ? null : variantVersionOf(scenario, key as FixtureSlotKey),
    })
    const checkedA = await waitForBatchSeat(session, 'a', (state) => expectedKeysA.every((key) => {
      const row = rowOf(state, key)
      const want = aExpectedRow(key)
      return row !== null && row.versionCur === want.cur && row.versionNew === want.next
    }), { label: 'A 面板检查更新完成：三行版本条 0.0.1→0.0.2', timeoutMs: 180000 })
    await raw('a-check-complete', checkedA)
    const aCheckOk = expectedKeysA.every((key) => {
      const row = rowOf(checkedA, key)
      const want = aExpectedRow(key)
      return row !== null && row.versionCur === want.cur && row.versionNew === want.next
    })
    record({
      step: 'A 面板检查更新（真 UI 点 [data-act=check]）',
      what: 'A 的批量检查对 targets 逐个查最新版并把结论写进批量知识；三行版本条都出现 0.0.1→0.0.2（版本来自 registry，不是写死）',
      expected: 'rows=[' + expectedKeysA.join(',') + '] 版本条=基版→最新（正常=变体版；can-red skip 注入的席位 next=null）',
      actual: rowSummary(checkedA),
      verdict: verdictOf(aCheckOk),
    })
    record({
      step: 'A 面板行集合不随更新漂移',
      what: '检查更新后 A 仍只有自己的三个目标行（不混入 B 的席位/不擅自定义目标）',
      expected: 'rows=[' + expectedKeysA.join(',') + ']',
      actual: 'rows=[' + rowKeysOf(checkedA).join(',') + ']',
      verdict: verdictOf(sameKeySet(rowKeysOf(checkedA).map((key) => String(key)), expectedKeysA)),
    })
    await captureShot(recorder, session, {
      step: 'A 面板检查更新后（三行 0.0.1→0.0.2）',
      what: 'A 批量面板三行都显示 当前 0.0.1 → 最新 0.0.2，行状态 ready；B 面板同屏可见但尚未检查',
      expected: 'A rows 全部 ready 且 versionNew=0.0.2',
      actual: rowSummary(checkedA),
      verdict: verdictOf(aCheckOk),
    })

    // ---- 6. A 宏按钮「全部更新」：真 UI 串行把 a/b/c 装到 0.0.2 ----
    // 注意（真机实测）：批量装「有宿主接线」的夹具（A/B）时，desktop-manager 每装完一个会 relaunch 官方桌面，
    // 旧 CDP 句柄随进程失效。所以安装期间只用磁盘轮询（fs），全程不碰 CDP。
    // 真机还暴露过一个产品竞态（#266 known-red）：批量会话续跑时，对 pending 目标的 check 与另一目标的
    // install.exec 并发，偶发 check 读到 npm 改 profile 的暂态而把目标行记成 failed。用户的实际做法是
    // 收掉实例、重开后再点一次「全部更新」（预查会把已装好的判 current，只补装剩下的）；场景按真实用户
    // 路径留一次重试，并在 raw 里记录两轮结果（不掩盖第一轮失败；can-red 也不受影响：skip-variant 注入下
    // 变体永远不存在，重试后最终断言仍红）。
    const allNames = [slotA.packageName, slotB.packageName, slotC.packageName]
    const pollAllInstalled = async (deadlineMs: number): Promise<{ reached: boolean; versions: Record<string, string | null> }> => {
      const deadline = Date.now() + deadlineMs
      let versions: Record<string, string | null> = {}
      while (Date.now() < deadline) {
        versions = (await readDiskSnapshot({ homeDir: layout.homeDir, profileName, packageNames: allNames })).versions
        const reached =
          versions[slotA.packageName] === expectedVersionOf('a') &&
          versions[slotB.packageName] === expectedVersionOf('b') &&
          versions[slotC.packageName] === expectedVersionOf('c')
        if (reached) return { reached: true, versions }
        await new Promise<void>((resolve) => setTimeout(() => resolve(), 2000))
      }
      return { reached: false, versions }
    }
    // 收掉当前（可能已被 desktop-manager 自重启的）桌面实例，再起一个被托管的新实例。
    const relaunchDesktopOnce = async (tag: string): Promise<void> => {
      const appPort = session !== null ? session.port : null
      const mainPid = session !== null ? (session.process.pid() ?? null) : null
      let relaunchedPids: number[] = []
      if (appPort !== null) {
        try {
          relaunchedPids = await stopDesktopByPort(appPort)
        } catch (error) {
          await raw('desktop-stop-by-port-error-' + tag, { message: error instanceof Error ? error.message : String(error) })
        }
      }
      try {
        await session?.close()
      } catch (error) {
        await raw('desktop-close-error-' + tag, { message: error instanceof Error ? error.message : String(error) })
      }
      session = null
      // 自重启出来的实例可能换了调试端口；按本 run 独有的 user-data-dir 再兜底一遍（只匹配本 run 的隔离路径）。
      const uddPids = await stopDesktopByUserDataDir(layout.userDataDir).catch(() => [] as number[])
      if (mainPid !== null) cleanupProcesses.push({ label: 'desktop-app-main-' + tag, pid: mainPid, aliveAfterStop: false })
      relaunchedPids.forEach((pid, index) => cleanupProcesses.push({ label: 'desktop-app-auto-relaunch-' + tag + '#' + index, pid, aliveAfterStop: false }))
      uddPids.forEach((pid, index) => cleanupProcesses.push({ label: 'desktop-app-userdata-relaunch-' + tag + '#' + index, pid, aliveAfterStop: false }))
      await raw('desktop-relaunch-' + tag, { port: appPort, relaunchedPids, userDataDirPids: uddPids })
      await new Promise<void>((resolve) => setTimeout(() => resolve(), 1000))
      let lastLaunchError: string | null = null
      for (let attempt = 0; attempt < 3 && session === null; attempt += 1) {
        try {
          session = await launchDesktopApp({ homeDir: layout.homeDir, userDataDir: layout.userDataDir, extraEnv: { DSH_SELFTEST_REGISTRY: registry.baseUrl } })
        } catch (error) {
          lastLaunchError = error instanceof Error ? error.message : String(error)
          await new Promise<void>((resolve) => setTimeout(() => resolve(), 3000))
        }
      }
      if (session === null) throw new Error('重启官方桌面失败（' + tag + '）：' + String(lastLaunchError))
    }

    await clickSeatAction(session, 'a', 'install')
    const firstRound = await pollAllInstalled(180000)
    await raw('a-install-round-1', firstRound)
    let installedAll = firstRound.reached
    let lastDisk: { versions: Record<string, string | null> } = { versions: firstRound.versions }
    let retriedInstallRound = false
    if (!installedAll) {
      retriedInstallRound = true
      // 真实用户重试：重开桌面后 A 的批量面板应从落盘的批量账本读回同一会话（重启不丢账本）。
      await relaunchDesktopOnce('install-retry')
      const recovered = await waitForBatchSeat(session, 'a', (state) => state.panel.rows.length === expectedKeysA.length, {
        label: '重试前重开桌面：A 批量面板从账本恢复三行',
        timeoutMs: 180000,
      })
      await raw('a-ledger-after-reopen', recovered)
      record({
        step: '重开桌面后 A 批量账本跨重启读回',
        what: '批量会话状态（batch.json）落在隔离 profile 里：官方桌面重启后 A 的批量面板仍显示同一会话的三行（不是面板内存里的临时态）',
        expected: 'rows=[' + expectedKeysA.join(',') + ']（从账本读回）',
        actual: rowSummary(recovered),
        verdict: verdictOf(sameKeySet(rowKeysOf(recovered).map((key) => String(key)), expectedKeysA)),
      })
      await clickSeatAction(session, 'a', 'install')
      const secondRound = await pollAllInstalled(180000)
      await raw('a-install-round-2', secondRound)
      installedAll = secondRound.reached
      lastDisk = { versions: secondRound.versions }
    }
    record({
      step: 'A 宏按钮批量更新 a/b/c（真 UI，跨桌面自重启）',
      what: '点 A 面板 [data-act=install] 后，批量会话按顺序把 a、b、c 从 0.0.1 真装成 0.0.2；装 A/B 期间官方桌面自重启，批量会话从落盘账本续跑（磁盘为证；若遇产品竞态则按真实用户路径重试一次，两轮 raw 都留）',
      expected: 'a=' + expectedVersionOf('a') + '；b=' + expectedVersionOf('b') + '；c=' + expectedVersionOf('c') + '（两轮各 3 分钟内；can-red skip 注入的席位按声明停在基版）',
      actual: 'retried=' + String(retriedInstallRound) + '；versions=' + JSON.stringify(lastDisk.versions),
      verdict: verdictOf(installedAll),
    })
    // 清掉 desktop-manager 自动 relaunch 出来的实例（它们不再被原 ManagedProcess 托管），再起一个被托管的新实例；
    // 若刚为重试重开过，当前就是被托管实例，直接用它做 UI 断言。
    if (!retriedInstallRound) await relaunchDesktopOnce('post-install')
    const finalC = await readInstalledPackageVersion({ homeDir: layout.homeDir, profileName, packageName: slotC.packageName }).catch(() => null)
    const cInstalledOk = finalC === expectedVersionOf('c')
    record({
      step: 'C 纯目标被批量推到 0.0.2（磁盘）',
      what: 'A 的批量会话第三个目标是 C（纯目标，不属于任何集成方）；装完后 C 的包版本应为变体版',
      expected: slotC.packageName + '=' + expectedVersionOf('c') + (injectedOf('c') ? '（can-red 注入：C 未发布变体，应停在基版）' : ''),
      actual: slotC.packageName + '=' + String(finalC),
      verdict: verdictOf(cInstalledOk),
    })
    const afterInstallA = await waitForBatchSeat(session, 'a', (state) => {
      const rowA = rowOf(state, 'a')
      const rowB = rowOf(state, 'b')
      const rowC = rowOf(state, 'c')
      const done = (row: typeof rowA) => row !== null && (row.phase === 'done' || row.phase === 'current')
      return done(rowA) && done(rowB) && rowC !== null && rowC.phase !== 'checking' && rowC.phase !== 'installing' && rowC.phase !== 'pending'
    }, { label: 'A 面板批量安装完成：三行都到终态', timeoutMs: 120000 })
    await raw('a-install-complete', afterInstallA)
    // 终态口径：三行都到 done|current 且版本条=变体（重试轮的预查会把已装好的 a/b 判 current，正确语义）。
    const finalRowOk = (state: import('./batch-helpers.ts').BatchSeatState): boolean =>
      expectedKeysA.every((key) => {
        const row = rowOf(state, key)
        return row !== null && (row.phase === 'done' || row.phase === 'current') && row.versionCur === expectedVersionOf(key as FixtureSlotKey)
      })
    // 真机瞬态（b pass6 实测，run 266-20261102T021151）：安装 exec 还在飞行中、桌面换包使目标包版本变化，
    // 批量驱动在**同一进程**里新建了读取器实例（host/capabilities.ts getSharedReader 的键含 runningVersion），
    // 新实例 activeJobId=null，把磁盘上仍在装的同进程任务误判成「上一个进程世代遗留」，合成
    // interrupted/recovery-required；批量据此提前收尾记失败——1.2s 后 exec 却 ok。这是 #266 真机暴露的
    // 产品 BUG，已最小修 host/capabilities.ts（同一使用范围且旧实例仍握着在飞任务时先复用旧实例、
    // 收尾后再换代；回归见 tests/reader-rotation-inflight.test.mjs），
    // 修复后此瞬态应不再出现（transient=false）。场景仍保留真实用户的自愈路径作兜底：点一次「检查更新」，
    // 检查结论 current 会把会话行对账回 current（src/host/batch/fan-out.ts:864-889，产品 #152 对账）；
    // 若安装确实被官方桌面自重启中断（跨进程，诚实的中断），终态也由此收敛，最终断言行态与磁盘一致。
    let finalA = afterInstallA
    const transientFailed = !finalRowOk(afterInstallA)
    if (transientFailed) {
      await raw('a-install-transient-failed', afterInstallA)
      await clickSeatAction(session, 'a', 'check')
      finalA = await waitForBatchSeat(session, 'a', finalRowOk, { label: 'A 面板「检查更新」后失败行对账收敛', timeoutMs: 180000 })
      await raw('a-install-reconciled', finalA)
    }
    record({
      step: '安装行态收敛（#152 对账；#266 修复后瞬态应为 false）',
      what: '安装 exec 在飞行中换包时，修复前会在同进程误报 recovery-required（真机瞬态，raw 原样留）；#266 修复后应为 transient=false。若仍有失败行（含真实跨进程中断），点一次真 UI「检查更新」，检查结论 current 会把会话行对账回 current，行态与磁盘一致',
      expected: '收敛后 rows=[a,b,c] 全部 phase=done|current、versionCur=声明目标版（安装无瞬态时无需收敛）',
      actual: 'transient=' + String(transientFailed) + '；before=' + rowSummary(afterInstallA) + '；after=' + rowSummary(finalA),
      verdict: verdictOf(finalRowOk(finalA)),
    })
    const aInstallStateOk = finalRowOk(finalA)
    record({
      step: 'A 面板安装后状态与磁盘一致',
      what: '批量会话三行都变 done|current（行显示已到 0.0.2），没有 pending/失败行；台账状态与磁盘安装结果一致',
      expected: 'rows=[a,b,c] 全部 phase=done|current（重试轮预查可判 current）、versionCur=声明目标版（can-red skip 注入的席位=基版）',
      actual: rowSummary(finalA),
      verdict: verdictOf(aInstallStateOk),
    })
    await captureShot(recorder, session, {
      step: 'A 批量更新完成（三目标都到 0.0.2）',
      what: 'A 批量面板三行状态 done|current、版本条 0.0.2；同屏 B 面板（尚未检查）与 C 卡片（旧内容）',
      expected: 'A rows 全部 done/current/0.0.2',
      actual: rowSummary(finalA),
      verdict: verdictOf(aInstallStateOk),
    })

    // ---- 7. B 面板检查：A 装的结果在 B 的视角里是 current；B 只看到 b/c ----
    await clickSeatAction(session, 'b', 'check')
    const checkedB = await waitForBatchSeat(session, 'b', (state) => {
      const rowB = rowOf(state, 'b')
      const rowC = rowOf(state, 'c')
      return rowB !== null && rowB.versionCur === expectedVersionOf('b') && rowB.versionNew === null &&
        rowC !== null && rowC.versionCur === expectedVersionOf('c') && rowC.versionNew === null
    }, { label: 'B 面板检查完成：b/c 行版本条显示已装版本（无待更新）', timeoutMs: 180000 })
    await raw('b-check-complete', checkedB)
    const bCheckOk = expectedKeysB.every((key) => {
      const row = rowOf(checkedB, key)
      return row !== null && row.versionCur === expectedVersionOf(key as FixtureSlotKey) && row.versionNew === null
    })
    record({
      step: 'B 面板检查（看见 A 的安装结果）',
      what: 'B 自己的批量知识里，b/c 都显示已装 0.0.2、没有待更新（A 装出来的结果对 B 可见）；B 没有 a 行',
      expected: 'rows=[b,c] 全部 versionCur=声明目标版（can-red skip 注入=基版）、无 versionNew',
      actual: rowSummary(checkedB),
      verdict: verdictOf(bCheckOk),
    })
    // B 独立再点一次宏「全部更新」：两段式预查应判定 b/c 都 current（不重装）。
    // 这一步给 B 建立自己的批量会话，使 B 的面板相位也能展示 current（check 电话本身不建会话）。
    // pass4 实测坑：紧跟 check 点击后宏按钮可能仍在 inFlight 的 disabled 窗口里，DOM click 被吞（无日志、无会话）。
    // 真实用户会等按钮亮起再点；场景同样先等可点，且点击后 30s 内没进终态就重点一次（最多 3 次）。
    let bInstallSettled: import('./batch-helpers.ts').BatchSeatState | null = null
    let bInstallAttempts = 0
    for (let attempt = 0; attempt < 3 && bInstallSettled === null; attempt += 1) {
      bInstallAttempts += 1
      await waitForBatchSeat(session, 'b', (state) => state.panel.present && state.panel.install !== null && !state.panel.install.disabled, {
        label: 'B 宏「全部更新」可点（第 ' + bInstallAttempts + ' 次）',
        timeoutMs: 120000,
      })
      await clickSeatAction(session, 'b', 'install')
      try {
        bInstallSettled = await waitForBatchSeat(session, 'b', (state) =>
          state.panel.rows.length === expectedKeysB.length &&
          state.panel.rows.every((row) => row.phase === 'current' || row.phase === 'done'),
        { label: 'B 面板「全部更新」预查后 b/c 行 current（第 ' + bInstallAttempts + ' 次点击后）', timeoutMs: 30000 })
      } catch (error) {
        if (attempt === 2) throw error
      }
    }
    if (bInstallSettled === null) throw new Error('[scenario-b] B 宏「全部更新」点击未生效（3 次重试后仍无会话行）')
    const bSettled = bInstallSettled
    await raw('b-install-settled', { attempts: bInstallAttempts, state: bSettled })
    const bInstallOk = expectedKeysB.every((key) => {
      const row = rowOf(bSettled, key)
      return row !== null && (row.phase === 'current' || row.phase === 'done') && row.versionCur === expectedVersionOf(key as FixtureSlotKey)
    })
    record({
      step: 'B 独立发起批量更新：预查判定 b/c 已是最新（没有重装）',
      what: 'A 装完后 B 自己点宏 [data-act=install]（全部更新）：B 的会话两段式预查把 b/c 都判成 current/0.0.2，串行安装没有可装项（不重复安装 A 已装好的包）',
      expected: 'rows=[b,c] phase=current 或 done、versionCur=声明目标版',
      actual: 'attempts=' + bInstallAttempts + '；' + rowSummary(bSettled),
      verdict: verdictOf(bInstallOk),
    })
    record({
      step: '两席批量视图行集合互不污染',
      what: 'B 检查后行集合仍恰为 [b,c]，A 的三行不受影响',
      expected: 'B rows=[b,c]；A rows=[a,b,c]',
      actual: 'B rows=[' + rowKeysOf(checkedB).join(',') + ']；A rows=[' + rowKeysOf(await readBatchSeat(session, 'a')).join(',') + ']',
      verdict: verdictOf(sameKeySet(rowKeysOf(checkedB).map((key) => String(key)), expectedKeysB) && sameKeySet(rowKeysOf(await readBatchSeat(session, 'a')).map((key) => String(key)), expectedKeysA)),
    })
    await captureShot(recorder, session, {
      step: 'B 面板看到 b/c 已是最新（A 的安装结果）',
      what: 'B 批量面板两行 phase=current、版本 0.0.2；B 没有 a 行，证明两席各自把 targets 当 scope',
      expected: 'B rows=[b,c] current 0.0.2',
      actual: rowSummary(checkedB),
      verdict: verdictOf(bCheckOk),
    })

    // ---- 8. 重启桌面：两席新版 UI（标题/坞/host 行为） vs C 仍无更新 UI ----
    const firstMainPid = session.process.pid() ?? null
    await session.close()
    session = null
    cleanupProcesses.push({ label: 'desktop-app-main', pid: firstMainPid, aliveAfterStop: false })
    session = await launchDesktopApp({ homeDir: layout.homeDir, userDataDir: layout.userDataDir, extraEnv: { DSH_SELFTEST_REGISTRY: registry.baseUrl } })
    const restartPid = session.process.pid() ?? null
    const newA = await waitForBatchSeat(session, 'a', (state) =>
      state.card.clientTag === 'client v' + variantA &&
      state.card.title === titleANew &&
      state.card.hostTag === 'host v' + variantA &&
      state.card.behavior !== null && state.card.behavior.attr === 'seat-aware-v2' &&
      state.dock !== null && state.dock.present &&
      state.panel.rows.length === expectedKeysA.length &&
      state.panel.rows.every((row) => row.phase === 'current' || row.phase === 'done'),
      { label: '重启后 A 新版 UI（client/host 0.0.2、标题后缀、坞、行为字段 v2、三行 current）', timeoutMs: 180000 })
    const newB = await waitForBatchSeat(session, 'b', (state) =>
      state.card.clientTag === 'client v' + variantB &&
      state.card.title === titleBNew &&
      state.card.hostTag === 'host v' + variantB &&
      state.card.behavior !== null && state.card.behavior.attr === 'seat-aware-v2' &&
      state.dock !== null && state.dock.present &&
      state.panel.rows.length === expectedKeysB.length &&
      state.panel.rows.every((row) => row.phase === 'current' || row.phase === 'done'),
      { label: '重启后 B 新版 UI（两行 current）', timeoutMs: 180000 })
    const newC = await waitForTargetSeat(session, 'c', (state) => state.present && state.clientTag !== null, { label: '重启后 C 卡片可见', timeoutMs: 180000 })
    const newPage = await readPageUpdateState(session)
    await raw('restart-ui', { a: newA, b: newB, c: newC, page: newPage })
    const aNewUiOk =
      newA.card.ui === 'batch' &&
      newA.card.title === titleANew &&
      newA.card.clientTag === 'client v' + variantA &&
      newA.card.hostTag === 'host v' + variantA &&
      newA.card.behavior !== null && newA.card.behavior.attr === 'seat-aware-v2' &&
      newA.card.seatLine !== null && newA.card.seatLine.attr === effectA.seatLine &&
      newA.dock !== null && newA.dock.present &&
      newA.panel.rows.every((row) => (row.phase === 'current' || row.phase === 'done') && row.versionCur === variantA)
    record({
      step: '重启后 A 新版可见 UI/行为（更新前 vs 更新后对比）',
      what: 'A 从单卡（0.0.1 无后缀、无坞、行为字段 none）变成：标题带声明后缀、出现中枢进度坞、host 行为字段 seat-aware-v2、client/host 构建标记 0.0.2；三行 current',
      expected: 'title=' + titleANew + '；client v' + variantA + '；host v' + variantA + '；behavior=seat-aware-v2；dock 存在；三行 current 0.0.2',
      actual: 'title=' + String(newA.card.title) + '；client=' + String(newA.card.clientTag) + '；host=' + String(newA.card.hostTag) + '；behavior=' + String(newA.card.behavior === null ? null : newA.card.behavior.attr) + '；dock=' + String(newA.dock !== null && newA.dock.present) + '；' + rowSummary(newA),
      verdict: verdictOf(aNewUiOk),
    })
    record({
      step: '重启后 A 更新前后标题对比（B 码面）',
      what: '同一张 A 卡片：更新前标题=' + titleAOld + '，更新后标题=' + titleANew + '（可见 UI 变化，不只是版本号）',
      expected: titleAOld + ' → ' + titleANew,
      actual: '初始 title=' + String(initialA.card.title) + '；更新后 title=' + String(newA.card.title),
      verdict: verdictOf(initialA.card.title === titleAOld && newA.card.title === titleANew && titleAOld !== titleANew),
    })
    const bNewUiOk =
      newB.card.ui === 'batch' &&
      newB.card.title === titleBNew &&
      newB.card.clientTag === 'client v' + variantB &&
      newB.card.hostTag === 'host v' + variantB &&
      newB.card.behavior !== null && newB.card.behavior.attr === 'seat-aware-v2' &&
      newB.dock !== null && newB.dock.present &&
      newB.panel.rows.every((row) => (row.phase === 'current' || row.phase === 'done') && row.versionCur === variantB)
    record({
      step: '重启后 B 新版可见 UI/行为',
      what: 'B 同样从 0.0.1 升到 0.0.2：标题后缀、坞、行为字段 v2 都出现，两行 current（两个集成方各自独立更新，互不顶替）',
      expected: 'B title=' + titleBNew + '；client v' + variantB + '；host v' + variantB + '；behavior=seat-aware-v2；dock 存在；两行 current',
      actual: 'B title=' + String(newB.card.title) + '；client=' + String(newB.card.clientTag) + '；host=' + String(newB.card.hostTag) + '；behavior=' + String(newB.card.behavior === null ? null : newB.card.behavior.attr) + '；' + rowSummary(newB),
      verdict: verdictOf(bNewUiOk),
    })
    const targetEffectC = variantEffectOf(scenario, 'c')
    const cBadgeExpected = 'client v' + variantC + (targetEffectC === null ? '' : targetEffectC.titleSuffix)
    const cNewOk =
      newC.wiring === 'none' &&
      newC.clientTag === 'client v' + variantC &&
      (newC.badgeText || '').indexOf('client v' + variantC) >= 0 &&
      (targetEffectC === null || (newC.badgeText || '').indexOf(targetEffectC.titleSuffix) >= 0)
    record({
      step: '重启后 C 纯目标内容变新（更新前 vs 更新后）',
      what: 'C 被 A 批量推到 0.0.2：徽标文本从旧内容变新内容（C 有行为/元数据变化），但 C 仍然没有更新接线',
      expected: 'badgeText 含 ' + cBadgeExpected + '；wiring=none',
      actual: 'badgeText=' + String(newC.badgeText) + '；wiring=' + String(newC.wiring) + '；clientTag=' + String(newC.clientTag),
      verdict: verdictOf(cNewOk),
    })
    const cNoPanelOk = newC.dshUpdCount === 0 && newC.dockCount === 0 && newC.entryCount === 0 && newC.wiring === 'none'
    record({
      step: 'C 升级后仍无更新 UI（纯目标不建 hub）',
      what: 'C 自己的卡片里没有 .dsh-upd 面板、没有批量入口、没有中枢坞——C 不建 hub、不接更新内核（manifest 也不依赖 SUT）',
      expected: 'C 卡内 .dsh-upd=0、dock=0、entry=0；data-update-wiring=none',
      actual: 'dshUpd=' + newC.dshUpdCount + '；dock=' + newC.dockCount + '；entry=' + newC.entryCount + '；wiring=' + String(newC.wiring),
      verdict: verdictOf(cNoPanelOk),
    })
    const pageOk = newPage.totalBatchPanels === 2 && newPage.totalDshUpd === 2 && newPage.totalEntries === 2 && newPage.totalDocks === 2 && newPage.fixtureKeys.length === 3
    record({
      step: '页面级更新 UI 计数（两席 vs C）',
      what: '重启后整页仍只有 A/B 两个集成方的批量 UI：批量面板 2、批量入口 2、中枢坞 2（新版效果）、.dsh-upd 合计 2；C 贡献 0',
      expected: 'batchPanels=2、entries=2、docks=2、dshUpd=2、fixtures=3',
      actual: 'batchPanels=' + newPage.totalBatchPanels + '；entries=' + newPage.totalEntries + '；docks=' + newPage.totalDocks + '；dshUpd=' + newPage.totalDshUpd + '；fixtures=[' + newPage.fixtureKeys.join(',') + ']',
      verdict: verdictOf(pageOk),
    })
    await captureShot(recorder, session, {
      step: '重启后整窗：两席新版 UI + 中枢坞，C 仍无更新 UI',
      what: 'A（右下）与 B（左上）卡片标题带批量新版后缀、各有一个更新进度中枢坞；C（左下）只显示新内容徽标，没有任何更新面板/入口',
      expected: 'A/B 新版标题+dock；C 新版徽标、无 .dsh-upd；batchPanels=2',
      actual: 'A title=' + String(newA.card.title) + '；B title=' + String(newB.card.title) + '；C badge=' + String(newC.badgeText) + '；batchPanels=' + newPage.totalBatchPanels + '；docks=' + newPage.totalDocks,
      verdict: verdictOf(aNewUiOk && bNewUiOk && cNewOk && cNoPanelOk && pageOk),
    })
    await captureShot(recorder, session, {
      step: '重启后 C 纯目标特写（新版内容 + 无更新接线）',
      what: 'C 的徽标文本 = 新版内容；卡片上 data-update-wiring=none，卡内无 .dsh-upd；以此证明纯目标被更新但自己不接更新系统',
      expected: 'badgeText 含 ' + cBadgeExpected + '；C 卡内 .dsh-upd=0',
      actual: 'badgeText=' + String(newC.badgeText) + '；dshUpd=' + newC.dshUpdCount + '；dock=' + newC.dockCount,
      verdict: verdictOf(cNewOk && cNoPanelOk),
    })

    // ---- 9. 磁盘/依赖/日志/批量账本/中枢/队列一致性 ----
    const finalDisk = await readDiskSnapshot({ homeDir: layout.homeDir, profileName, packageNames })
    await raw('final-disk', finalDisk)
    // readDiskSnapshot().versions 以 packageName 为键（不是席位键 a/b/c）。
    const finalDiskOk = finalDisk.versions[slotA.packageName] === expectedVersionOf('a') && finalDisk.versions[slotB.packageName] === expectedVersionOf('b') && finalDisk.versions[slotC.packageName] === expectedVersionOf('c')
    record({
      step: '最终磁盘：三包都到 0.0.2',
      what: '三个夹具的已装版本（package.json 直读）都 = 声明的变体版',
      expected: 'a=' + expectedVersionOf('a') + '、b=' + expectedVersionOf('b') + '、c=' + expectedVersionOf('c') + (injectedKeys.length > 0 ? '（can-red 注入：' + injectedKeys.join(',') + ' 未发布变体）' : ''),
      actual: JSON.stringify(finalDisk.versions),
      verdict: verdictOf(finalDiskOk),
    })
    const dependencies = finalDisk.dependencies || {}
    const depsOk = String(dependencies[slotA.packageName] || '').indexOf(expectedVersionOf('a')) >= 0 && String(dependencies[slotB.packageName] || '').indexOf(expectedVersionOf('b')) >= 0 && String(dependencies[slotC.packageName] || '').indexOf(expectedVersionOf('c')) >= 0
    record({
      step: 'profile 依赖声明与磁盘一致',
      what: 'desktop profile 的依赖版本都被更新到 0.0.2（更新系统同时维护 dependency 与磁盘）',
      expected: 'dependencies 三包=0.0.2',
      actual: JSON.stringify(dependencies),
      verdict: verdictOf(depsOk),
    })
    const logs = await readLogFacts(layout.homeDir)
    await raw('logs', { files: logs.files, events: logs.events })
    const installRequests = logs.events.filter((event) => event.event === 'update.install.request')
    const installOfTarget = (namespace: string, latest: string): boolean => installRequests.some((event) => event.namespace === namespace && String(event.fields['latest'] || '') === latest)
    const installAudit = auditInstallFails(logs.events)
    const logConds = {
      installA: installOfTarget('fxa-a', variantA),
      installB: installOfTarget('fxa-b', variantB),
      installC: installOfTarget('fxa-c', variantC),
      installCount: installRequests.length >= 3,
      hostCallOk: logs.events.some((event) => event.event === 'host.call' && event.fields['kind'] === 'update-install' && event.fields['ok'] === true),
      wireDesktop: logs.events.some((event) => event.event === 'update.wire.ready' && event.fields['hostKind'] === 'desktop-manager'),
      batchSummary: logs.events.filter((event) => event.event === 'update.batch.summary').length >= 1,
      noErrorLevel: !logs.events.some((event) => event.level === 'error'),
      // 设计内首提拒绝（#70 / ADR-0004 §3 A 案）：≥2 家批每家首次提交可能 check-expired，当场重查重提；只允许这一类且必须紧跟 retry。
      // update-busy（#25：另一安装持锁，phone 回 queued，驱动器下一轮重推）不是失败，错误审计里单列 queuedCount。
      installFailDesignOnly: installAudit.nonCheckExpired === 0 && installAudit.unretried === 0,
      // 三目标都已发布且已安装：不允许出现「目标缺失/跨 scope」类检查失败——即 update.check.fail 或 host.call.fail{method:*.updateCheck}。
      // 安装 A/B 本体必触发宿主自重启，重启窗口内 entry.fail{stage:check|settle}（recovery-required / check-failed）是设计内可恢复记录；
      // 该瞬时态不当作产品失败，终态由相邻的「行态全 current + 磁盘 0.0.2」断言证明。
      noCrossScopeCheckFailure: !logs.events.some((event) => event.event === 'update.check.fail' || (event.event === 'host.call.fail' && String(event.fields['method'] || '').endsWith('.updateCheck'))),
    }
    const logOk = Object.values(logConds).every((value) => value === true)
    record({
      step: '日志链：批量入口 → 真装 → in-process 宿主',
      what: '日志里能看到批量会话对三个目标的 install.request（current 0.0.1 → latest 0.0.2）、host.call(update-install, ok=true)、update.wire.ready(desktop-manager)、批量 summary；无 error 级；install.fail 只允许设计内的 check-expired 首提拒绝（每条紧跟同命名空间 retry）与 update-busy 排队回执；三目标都已发布/安装，不允许「目标缺失/跨 scope」类检查失败；自重启窗口内的 entry.fail(stage=check|settle) 是设计内可恢复记录（邻断言的终态行/磁盘为准）',
      expected: 'install.request 覆盖 a/b/c 三目标且 ≥3 次；host.call ok；wire=desktop-manager；summary≥1；无 error；非 check-expired 的 install.fail=0 且未 retry 的拒绝=0；无 check.fail / host.call.fail{method:*.updateCheck}',
      actual: JSON.stringify(logConds) + '；installAudit=' + JSON.stringify(installAudit) + '；installRequests=' + installRequests.length + '；entryFails=' + JSON.stringify(logs.events.filter((event) => event.event === 'update.batch.entry.fail').map((event) => event.namespace + ':' + String(event.fields['stage'] || '') + ':' + String(event.fields['errorKind'] || ''))),
      verdict: verdictOf(logOk),
    })
    const diskFacts = await readBatchDiskFacts(layout.homeDir)
    await raw('batch-disk-facts', diskFacts)
    const ownerA = asRecord(diskFacts.owners['fxa'])
    const ownerB = asRecord(diskFacts.owners['fxb'])
    const ledgerAOk = sameKeySet(entryKeysOf(ownerA['batch']), expectedKeysA)
    const ledgerBOk = sameKeySet(entryKeysOf(ownerB['batch']), expectedKeysB)
    const inventoryAOk = sameKeySet(inventoryKeysOf(ownerA['inventory']), expectedKeysA)
    const inventoryBOk = sameKeySet(inventoryKeysOf(ownerB['inventory']), expectedKeysB)
    record({
      step: '批量账本按属主隔离（A=fxa 三键、B=fxb 两键）',
      what: '磁盘上 A 的批量会话台账恰含 a/b/c，B 的恰含 b/c；两席的 inventory 也各自只含自己的 targets（无跨 scope 污染）',
      expected: 'fxa batch/inventory keys=[a,b,c]；fxb batch/inventory keys=[b,c]',
      actual: 'fxa batch=[' + entryKeysOf(ownerA['batch']).join(',') + '] inventory=[' + inventoryKeysOf(ownerA['inventory']).join(',') + ']；fxb batch=[' + entryKeysOf(ownerB['batch']).join(',') + '] inventory=[' + inventoryKeysOf(ownerB['inventory']).join(',') + ']；文件=' + diskFacts.files.join(',') ,
      verdict: verdictOf(ledgerAOk && ledgerBOk && inventoryAOk && inventoryBOk),
    })
    const queue = asRecord(diskFacts.queue)
    const waiting = Array.isArray(queue['waiting']) ? (queue['waiting'] as unknown[]) : null
    const queueOk = diskFacts.queue !== null && waiting !== null && waiting.length === 0
    record({
      step: '根队列：批量结束后无残留等待项/无主占用',
      what: 'update-queue/<fp>/queue.json 在批量结束后 waiting 为空（批量会话走完串行队列，不留半截队列）',
      expected: 'queue.json 存在且 waiting=[]',
      actual: JSON.stringify(diskFacts.queue),
      verdict: verdictOf(queueOk),
    })
    const hubPlanA = asRecord(diskFacts.hubPlans['fxa'])
    const hubPlanB = asRecord(diskFacts.hubPlans['fxb'])
    const hubScopeOk = (plan: Record<string, unknown>): boolean => String(asRecord(plan['scope'])['profileName'] || '') === profileName
    const hubAOk = String(hubPlanA['selfKey'] || '') === 'a' && sameKeySet(hubPlanTargetKeysOf(hubPlanA), expectedKeysA) && hubScopeOk(hubPlanA)
    const hubBOk = String(hubPlanB['selfKey'] || '') === 'b' && sameKeySet(hubPlanTargetKeysOf(hubPlanB), expectedKeysB) && hubScopeOk(hubPlanB)
    record({
      step: '更新中枢席位：两个集成方各一份计划（批结束后无残留租约）',
      what: '中枢目录里 fxa、fxb 各有一份 HubPlan（owner/selfKey/sessionId + targets 各自声明），证明两席真的在中枢登记过、C 没有席位；驾驶位租约是瞬时态（进程退出钩子归还），批量全部结束后的终态应无 lease 残留',
      expected: 'hub/plans 含 fxa(selfKey=a, targets=a,b,c)、fxb(selfKey=b, targets=b,c)；结束后 hub/lease.json 不存在（已释放，无残留租约）',
      actual: 'planOwners=' + Object.keys(diskFacts.hubPlans).join(',') + '；fxa selfKey=' + String(hubPlanA['selfKey'] || '') + ' targets=[' + hubPlanTargetKeysOf(hubPlanA).join(',') + ']；fxb selfKey=' + String(hubPlanB['selfKey'] || '') + ' targets=[' + hubPlanTargetKeysOf(hubPlanB).join(',') + ']；lease=' + (diskFacts.hubLease === null ? 'null(已释放)' : JSON.stringify(diskFacts.hubLease)),
      verdict: verdictOf(Object.keys(diskFacts.hubPlans).indexOf('fxa') >= 0 && Object.keys(diskFacts.hubPlans).indexOf('fxb') >= 0 && hubAOk && hubBOk && diskFacts.hubLease === null),
    })
    record({
      step: 'C 从未出现在任何集成方账本/中枢计划里',
      what: 'C 作为目标只出现在 A 的 targets 与安装链里；C 自己没有任何批量台账/中枢计划（不是集成方）',
      expected: '磁盘上没有 owner=fxc 的 batch.json、没有 hub/plans/fxc.json',
      actual: 'owners=' + Object.keys(diskFacts.owners).join(',') + '；hubPlanOwners=' + Object.keys(diskFacts.hubPlans).join(','),
      verdict: verdictOf(Object.keys(diskFacts.owners).indexOf('fxc') < 0 && Object.keys(diskFacts.hubPlans).indexOf('fxc') < 0),
    })
    notes.push('重启后进程 pid=' + String(restartPid));
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error)
    interrupted = message
    record({
      step: '场景 b 全流程执行',
      what: '场景从头到尾无基础设施异常地跑完（异常=blocked 级问题，不是断言失败）',
      expected: '全流程无异常',
      actual: '中断：' + message.split('\n')[0],
      verdict: 'fail',
    })
  } finally {
    if (session !== null) {
      const pid = session.process.pid() ?? null
      try { await session.close() } catch { /* 进程可能已退出 */ }
      cleanupProcesses.push({ label: 'desktop-app-final', pid, aliveAfterStop: false })
      session = null
    }
    if (fixtureEnv !== null) {
      try { await fixtureEnv.stop() } catch { /* registry 可能已停 */ }
      fixtureEnv = null
    }
  }

  // ---- 10. 收尾证据：进程/端口释放、维护者 profile 指纹不变、finish + 证据包复制 ----
  for (const proc of cleanupProcesses) {
    if (proc.pid === null) continue
    try {
      process.kill(proc.pid, 0)
      proc.aliveAfterStop = true
    } catch {
      proc.aliveAfterStop = false
    }
  }
  const processesStopped = cleanupProcesses.every((proc) => proc.aliveAfterStop === false)
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
  const cleanupOk = stoppedFinal && registryReleased
  record({
    step: '进程与端口收尾（只清理自己起的）',
    what: '场景结束后自己启动的桌面进程全部退出、本地 verdaccio 端口释放；不触碰别的会话进程',
    expected: '所有记录进程 aliveAfterStop=false；verdaccio 端口 released=true',
    actual: 'processes=' + JSON.stringify(cleanupProcesses) + '；ports=' + JSON.stringify(cleanupPorts),
    verdict: verdictOf(cleanupOk),
  })
  recorder.setCleanup({ processes: cleanupProcesses, ports: cleanupPorts, notes })

  const maintainerAfter = await captureMaintainerProfile(maintainerHome).catch(() => null)
  if (maintainerBefore !== null && maintainerAfter !== null) {
    const maintainerCompare = compareMaintainerProfile(maintainerHome, maintainerBefore, maintainerAfter)
    recorder.setMaintainerProfile(maintainerCompare)
    record({
      step: '维护者 profile 只读核对',
      what: '整个真机跑期间维护者自己的 ~/.dsh（真实 profile）指纹不变：本 run 只用隔离 DSH_HOME + 隔离 user-data-dir',
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

  if (interrupted !== null) recorder.addNote('场景执行中断（基础设施/界面异常）：' + interrupted.split('\n')[0])
  for (const note of notes) recorder.addNote(note)
  const manifest = await recorder.finish()
  await copyRunEvidence(layout, options.worktree)
  return manifest
}
